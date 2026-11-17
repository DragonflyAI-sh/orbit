import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { credential } from "./launcher.ts";
import type { PortStatus } from "./ports.ts";
import { writeAtomic } from "./threads.ts";

// A dedicated OpenAI embeddings adapter for opt-in photo retrieval (docs/photo-semantic-search.md).
//
// - Standard API-key embeddings: POST https://api.openai.com/v1/embeddings with a bearer key read from the systemd credential
//   `orbit.openai-embeddings`. It is a SEPARATE credential from `orbit.openai` (which switches chat inference to an API key, see
//   src/model.ts selectModel), so installing it never changes how replies are generated. ChatGPT token sharing is never used here.
// - Off unless ORBIT_PHOTO_SEMANTIC=on. Missing or bad settings fail closed (the port says why; chat and keyword search are unaffected).
// - Hard budgets: every HTTP attempt is counted against a persisted daily request budget and a daily input-token budget BEFORE it is
//   sent (a crash over-counts, never under-counts). These are ORBIT's own counts, not a provider-enforced ceiling, and nothing here
//   proves which billing path pays for a request or that it is covered by a grant. See the provisioning notes in the docs.
// - Bounded retries on transient failures only (timeouts, network errors, 5xx, rate-limit 429). An auth error (401/403), an exhausted
//   quota (429 insufficient_quota) or a configuration error (400/404) is never retried: the adapter halts for a cooldown and every call
//   fails fast with the reason, so there is no retry loop on errors that will not go away by themselves.
// - Every response is validated: HTTP status, JSON shape, one vector per input, indices a permutation of the inputs (re-ordered by
//   index), the configured dimensions, finite numbers. Anything else is refused and nothing from it is used or cached.
// - The key never appears in an error, a status line, a log or a result: error text is cut and scrubbed.

export const EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBEDDINGS_CREDENTIAL = "orbit.openai-embeddings";
export const EMBEDDINGS_DEFAULT_MODEL = "text-embedding-3-small";
// Native output sizes of the documented OpenAI embedding models. Any other model needs ORBIT_EMBEDDINGS_DIMENSIONS.
export const NATIVE_DIMENSIONS: Record<string, number> = { "text-embedding-3-small": 1536, "text-embedding-3-large": 3072, "text-embedding-ada-002": 1536 };
export const EMBEDDINGS_DIMENSIONS_MAX = 4096;
export const EMBED_BATCH_MAX = 16;
export const EMBED_INPUT_CHARS_MAX = 2000;
export const EMBED_TIMEOUT_MS = 15_000;
export const EMBED_ATTEMPTS_MAX = 3;
export const EMBED_CONCURRENCY = 2;
export const EMBED_BACKOFF_MS = 500;
export const EMBED_RETRY_AFTER_MAX_MS = 10_000;
// A halted adapter (auth, quota, configuration) refuses every call for this long, then tries once more.
export const EMBED_HALT_MS = 60 * 60_000;
export const DEFAULT_DAILY_REQUESTS = 200;
export const DEFAULT_DAILY_TOKENS = 100_000;
const DAILY_REQUESTS_MAX = 10_000;
const DAILY_TOKENS_MAX = 10_000_000;
// One vector is at most dims numbers of at most ~25 JSON characters; the rest of the body is small.
const responseBytesMax = (dims: number, n: number) => n * dims * 26 + 64 * 1024;

export type EmbedderId = { model: string; dims: number; format: string };
// `attempts` can only lower the adapter's own retry bound (the startup smoke check uses 1: no retries).
export type EmbedOptions = { attempts?: number };
export type Embedder = { id: EmbedderId; embed(texts: string[], signal?: AbortSignal, opts?: EmbedOptions): Promise<number[][]> };
export type EmbeddingFailure = "disabled" | "budget" | "auth" | "quota" | "config" | "rate-limit" | "timeout" | "network" | "server" | "malformed" | "input" | "aborted";
// Every way an embedding can fail. `kind` lets callers (and tests) tell budget, auth and quota apart without parsing text.
export class EmbeddingUnavailable extends Error {
  readonly kind: EmbeddingFailure;
  constructor(kind: EmbeddingFailure, message: string) {
    super(message);
    this.name = "EmbeddingUnavailable";
    this.kind = kind;
  }
}

// ---- configuration ---------------------------------------------------------------------------------------------------------------
export type EmbeddingsSettings = {
  model: string;
  dims: number;
  // Send `dimensions` in the request (only for text-embedding-3 models, and only when a size other than the native one is configured).
  sendDimensions: boolean;
  dailyRequests: number;
  dailyTokens: number;
};
export type EmbeddingsConfig =
  | { state: "off"; detail: string }
  | { state: "misconfigured"; detail: string }
  | { state: "ready"; key: string; settings: EmbeddingsSettings };

const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const posInt = (name: string, raw: string | undefined, dflt: number, max: number): number | { error: string } => {
  if (raw === undefined || raw.trim() === "") return dflt;
  if (!/^\d+$/.test(raw.trim())) return { error: `${name} must be a whole number from 1 to ${max}.` };
  const n = Number(raw.trim());
  return n >= 1 && n <= max ? n : { error: `${name} must be a whole number from 1 to ${max}.` };
};

// Reads the opt-in settings. `readKey` is for tests; production reads the systemd credential. The key is checked for shape only:
// whether it works, which project or billing path it belongs to and whether a grant covers it are NOT known from here.
export function embeddingsConfig(env: NodeJS.ProcessEnv, readKey: () => string | undefined = () => credential(env, EMBEDDINGS_CREDENTIAL)): EmbeddingsConfig {
  const flag = (env.ORBIT_PHOTO_SEMANTIC ?? "").trim();
  if (flag === "" || flag === "off") return { state: "off", detail: "Semantic photo search is off (ORBIT_PHOTO_SEMANTIC is not on). Keyword photo search is unchanged." };
  if (flag !== "on") return { state: "misconfigured", detail: "ORBIT_PHOTO_SEMANTIC must be on or off. Semantic photo search stays off." };
  const model = (env.ORBIT_EMBEDDINGS_MODEL ?? "").trim() || EMBEDDINGS_DEFAULT_MODEL;
  if (!MODEL.test(model)) return { state: "misconfigured", detail: "ORBIT_EMBEDDINGS_MODEL is not a valid model name. Semantic photo search stays off." };
  const native = NATIVE_DIMENSIONS[model];
  const dimsRaw = env.ORBIT_EMBEDDINGS_DIMENSIONS?.trim();
  let dims: number;
  if (dimsRaw) {
    const d = posInt("ORBIT_EMBEDDINGS_DIMENSIONS", dimsRaw, 0, native ?? EMBEDDINGS_DIMENSIONS_MAX);
    if (typeof d !== "number") return { state: "misconfigured", detail: `${d.error} Semantic photo search stays off.` };
    if (native !== undefined && d !== native && !model.startsWith("text-embedding-3-")) return { state: "misconfigured", detail: `${model} has a fixed size of ${native}; ORBIT_EMBEDDINGS_DIMENSIONS cannot change it. Semantic photo search stays off.` };
    dims = d;
  } else if (native !== undefined) dims = native;
  else return { state: "misconfigured", detail: `ORBIT_EMBEDDINGS_DIMENSIONS is required for ${model} (ORBIT knows the size of ${Object.keys(NATIVE_DIMENSIONS).join(", ")} only). Semantic photo search stays off.` };
  const dailyRequests = posInt("ORBIT_EMBEDDINGS_DAILY_REQUESTS", env.ORBIT_EMBEDDINGS_DAILY_REQUESTS, DEFAULT_DAILY_REQUESTS, DAILY_REQUESTS_MAX);
  if (typeof dailyRequests !== "number") return { state: "misconfigured", detail: `${dailyRequests.error} Semantic photo search stays off.` };
  const dailyTokens = posInt("ORBIT_EMBEDDINGS_DAILY_TOKENS", env.ORBIT_EMBEDDINGS_DAILY_TOKENS, DEFAULT_DAILY_TOKENS, DAILY_TOKENS_MAX);
  if (typeof dailyTokens !== "number") return { state: "misconfigured", detail: `${dailyTokens.error} Semantic photo search stays off.` };
  let key: string | undefined;
  try {
    key = readKey()?.trim();
  } catch {
    key = undefined;
  }
  if (!key) return { state: "misconfigured", detail: `ORBIT_PHOTO_SEMANTIC is on but the ${EMBEDDINGS_CREDENTIAL} credential is not installed. Semantic photo search stays off; keyword search is unchanged.` };
  if (key.length > 512 || /\s/.test(key)) return { state: "misconfigured", detail: `The ${EMBEDDINGS_CREDENTIAL} credential is not a single-line key. Semantic photo search stays off.` };
  return { state: "ready", key, settings: { model, dims, sendDimensions: native !== undefined && dims !== native, dailyRequests, dailyTokens } };
}

// ---- budget -------------------------------------------------------------------------------------------------------------------------
// A persisted daily ledger (UTC days): every HTTP attempt reserves one request and an upper bound of its input tokens before it is
// sent. The bound is the UTF-8 byte count of the inputs: no tokenizer emits more than one token per byte. After a response with a
// valid usage count, the reservation is settled to that count; a failed or unanswered attempt keeps its whole reservation.
export type BudgetState = { v: 1; day: string; requests: number; tokens: number };
export function embeddingBudget(file: string | undefined, limits: { dailyRequests: number; dailyTokens: number }, now: () => Date = () => new Date()) {
  const today = () => now().toISOString().slice(0, 10);
  let state: BudgetState = { v: 1, day: today(), requests: 0, tokens: 0 };
  let unreadable = false;
  if (file) {
    try {
      const x = JSON.parse(readFileSync(file, "utf8")) as Partial<BudgetState>;
      if (x.v === 1 && typeof x.day === "string" && Number.isInteger(x.requests) && Number.isInteger(x.tokens) && x.requests! >= 0 && x.tokens! >= 0) state = x as BudgetState;
      else unreadable = true;
    } catch (err) {
      // A missing ledger is a fresh one; an unreadable one fails closed (no requests) until a person looks at it.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
    }
  }
  const roll = () => {
    if (state.day !== today()) state = { v: 1, day: today(), requests: 0, tokens: 0 };
  };
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeAtomic(file, JSON.stringify(state));
  };
  return {
    limits,
    // Reserves one attempt. Throws (and reserves nothing) when it would exceed a daily limit.
    reserve(tokens: number): void {
      if (unreadable) throw new EmbeddingUnavailable("budget", "the embeddings budget ledger is unreadable, so no request is sent until it is checked");
      roll();
      if (state.requests + 1 > limits.dailyRequests) throw new EmbeddingUnavailable("budget", `daily embeddings request budget of ${limits.dailyRequests} reached`);
      if (state.tokens + tokens > limits.dailyTokens) throw new EmbeddingUnavailable("budget", `daily embeddings token budget of ${limits.dailyTokens} would be exceeded`);
      state = { ...state, requests: state.requests + 1, tokens: state.tokens + tokens };
      save();
    },
    // Replaces a reservation with the provider's reported count (never below zero, never for another day).
    settle(reserved: number, actual: number, day: string): void {
      roll();
      if (state.day !== day || !Number.isInteger(actual) || actual < 0 || actual >= reserved) return;
      state = { ...state, tokens: Math.max(0, state.tokens - (reserved - actual)) };
      save();
    },
    day: today,
    used(): BudgetState {
      roll();
      return { ...state };
    },
    unreadable: () => unreadable,
  };
}
export type EmbeddingBudget = ReturnType<typeof embeddingBudget>;

// ---- the adapter ------------------------------------------------------------------------------------------------------------------
type Fetch = typeof fetch;
const sleepMs = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new EmbeddingUnavailable("aborted", "embedding request cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new EmbeddingUnavailable("aborted", "embedding request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Cuts provider text and removes the key and anything shaped like an API key or bearer token.
export function scrub(text: string, key: string, max = 160): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (key) out = out.split(key).join("[key]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[key]").replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [token]");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    void res.body?.cancel().catch(() => {});
    throw new EmbeddingUnavailable("malformed", "embeddings response is larger than ORBIT accepts");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new EmbeddingUnavailable("malformed", "embeddings response is larger than ORBIT accepts");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Validates a 200 body against the request: one finite vector of `dims` numbers per input, indices a permutation of 0..n-1.
export function parseEmbeddings(body: string, n: number, dims: number, model: string): { vectors: number[][]; promptTokens?: number } {
  let x: { object?: unknown; data?: unknown; model?: unknown; usage?: { prompt_tokens?: unknown } };
  try {
    x = JSON.parse(body);
  } catch {
    throw new EmbeddingUnavailable("malformed", "embeddings response is not JSON");
  }
  if (!x || typeof x !== "object" || !Array.isArray(x.data)) throw new EmbeddingUnavailable("malformed", "embeddings response has no data list");
  if (x.data.length !== n) throw new EmbeddingUnavailable("malformed", `embeddings response has ${x.data.length} vectors for ${n} inputs`);
  if (typeof x.model === "string" && !x.model.startsWith(model)) throw new EmbeddingUnavailable("malformed", "embeddings response names a different model");
  const out: (number[] | undefined)[] = new Array(n).fill(undefined);
  for (const item of x.data as { index?: unknown; embedding?: unknown }[]) {
    const i = item?.index;
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= n || out[i as number]) throw new EmbeddingUnavailable("malformed", "embeddings response indices do not match the inputs");
    const v = item.embedding;
    if (!Array.isArray(v) || v.length !== dims) throw new EmbeddingUnavailable("malformed", `embeddings response vector is not ${dims} numbers`);
    if (!v.every((z) => typeof z === "number" && Number.isFinite(z))) throw new EmbeddingUnavailable("malformed", "embeddings response vector has a non-finite number");
    if (!v.some((z) => z !== 0)) throw new EmbeddingUnavailable("malformed", "embeddings response vector is all zeros");
    out[i as number] = v as number[];
  }
  const pt = x.usage?.prompt_tokens;
  return { vectors: out as number[][], ...(Number.isInteger(pt) && (pt as number) >= 0 ? { promptTokens: pt as number } : {}) };
}

// `latest` is the outcome of the most recently STARTED call that reached a result (success or a non-cancellation failure). Calls are
// ordered by when they started, so a slow call (for example a startup smoke check) that finishes late cannot overwrite the outcome of
// a call that started after it. A cancelled call ("aborted") is not evidence about the provider and never changes it.
export type EmbedderStats = { requests: number; attempts: number; retries: number; texts: number; failures: Record<string, number>; lastOkAt?: string; lastError?: string; haltedUntil?: string; haltReason?: string; latest?: { ok: boolean; startedAt: string; at: string } };

export function openaiEmbedder(o: {
  key: string;
  settings: EmbeddingsSettings;
  budget: EmbeddingBudget;
  fetcher?: Fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  attempts?: number;
  url?: string;
}) {
  const fetcher = o.fetcher ?? fetch;
  const sleep = o.sleep ?? sleepMs;
  const now = o.now ?? (() => new Date());
  const timeoutMs = o.timeoutMs ?? EMBED_TIMEOUT_MS;
  const attemptsMax = Math.min(o.attempts ?? EMBED_ATTEMPTS_MAX, EMBED_ATTEMPTS_MAX);
  const s = o.settings;
  const id: EmbedderId = { model: s.model, dims: s.dims, format: `openai-embeddings/1${s.sendDimensions ? `;dimensions=${s.dims}` : ""}` };
  const stats: EmbedderStats = { requests: 0, attempts: 0, retries: 0, texts: 0, failures: {} };
  let halted: { until: number; kind: EmbeddingFailure; reason: string } | undefined;
  // A small semaphore: at most EMBED_CONCURRENCY requests in flight from this process.
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  const acquire = async () => {
    while (inFlight >= EMBED_CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
    inFlight++;
  };
  const release = () => {
    inFlight--;
    waiters.shift()?.();
  };
  const record = (ok: boolean, startedAt: Date | undefined) => {
    if (!startedAt) return;
    if (stats.latest && new Date(stats.latest.startedAt).getTime() > startedAt.getTime()) return;
    stats.latest = { ok, startedAt: startedAt.toISOString(), at: now().toISOString() };
  };
  const fail = (e: EmbeddingUnavailable, startedAt?: Date): never => {
    stats.failures[e.kind] = (stats.failures[e.kind] ?? 0) + 1;
    stats.lastError = `${now().toISOString()} ${e.kind}: ${e.message}`;
    if (e.kind !== "aborted") record(false, startedAt);
    throw e;
  };
  const halt = (kind: EmbeddingFailure, reason: string, startedAt: Date): never => {
    halted = { until: now().getTime() + EMBED_HALT_MS, kind, reason };
    stats.haltedUntil = new Date(halted.until).toISOString();
    stats.haltReason = reason;
    return fail(new EmbeddingUnavailable(kind, reason), startedAt);
  };

  const once = async (texts: string[], signal: AbortSignal | undefined, reserved: number) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const body = JSON.stringify({ model: s.model, input: texts, encoding_format: "float", ...(s.sendDimensions ? { dimensions: s.dims } : {}) });
      const res = await fetcher(o.url ?? EMBEDDINGS_URL, { method: "POST", headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" }, body, signal: ctl.signal });
      const text = await readCapped(res, responseBytesMax(s.dims, texts.length));
      return { status: res.status, text, retryAfter: res.headers.get("retry-after"), reserved };
    } catch (err) {
      if (err instanceof EmbeddingUnavailable) throw err;
      if (signal?.aborted) throw new EmbeddingUnavailable("aborted", "embedding request cancelled");
      if (ctl.signal.aborted) throw new EmbeddingUnavailable("timeout", `embeddings request timed out after ${timeoutMs} ms`);
      throw new EmbeddingUnavailable("network", `embeddings request failed: ${scrub(err instanceof Error ? err.message : String(err), o.key, 80)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const embedder: Embedder & { stats: EmbedderStats; halted(): typeof halted } = {
    id,
    stats,
    halted: () => (halted && halted.until > now().getTime() ? halted : undefined),
    async embed(texts: string[], signal?: AbortSignal, opts?: EmbedOptions): Promise<number[][]> {
      // Input refusals are about the caller, not the provider, so they are not recorded as an outcome (no start time).
      const started = now();
      const failAt = (e: EmbeddingUnavailable) => fail(e, started);
      const maxAttempts = Math.max(1, Math.min(opts?.attempts ?? attemptsMax, attemptsMax));
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > EMBED_BATCH_MAX) return fail(new EmbeddingUnavailable("input", `embed takes 1 to ${EMBED_BATCH_MAX} texts`));
      if (!texts.every((t) => typeof t === "string" && t.trim().length > 0 && t.length <= EMBED_INPUT_CHARS_MAX)) return fail(new EmbeddingUnavailable("input", `every text must be non-empty and at most ${EMBED_INPUT_CHARS_MAX} characters`));
      if (halted && halted.until > now().getTime()) return failAt(new EmbeddingUnavailable(halted.kind, `embeddings are paused until ${new Date(halted.until).toISOString()}: ${halted.reason}`));
      halted = undefined;
      const estimate = texts.reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0);
      await acquire();
      try {
        stats.requests++;
        for (let attempt = 1; ; attempt++) {
          try {
            o.budget.reserve(estimate);
          } catch (err) {
            return failAt(err as EmbeddingUnavailable);
          }
          const day = o.budget.day();
          stats.attempts++;
          let r: Awaited<ReturnType<typeof once>>;
          let transient: EmbeddingUnavailable | undefined;
          let wait = EMBED_BACKOFF_MS * 2 ** (attempt - 1);
          try {
            r = await once(texts, signal, estimate);
          } catch (err) {
            const e = err as EmbeddingUnavailable;
            if (e.kind === "aborted" || e.kind === "malformed") return failAt(e);
            transient = e;
            r = undefined as never;
          }
          if (!transient) {
            if (r.status === 200) {
              let parsed: ReturnType<typeof parseEmbeddings>;
              try {
                parsed = parseEmbeddings(r.text, texts.length, s.dims, s.model);
              } catch (err) {
                return failAt(err as EmbeddingUnavailable);
              }
              if (parsed.promptTokens !== undefined) o.budget.settle(estimate, parsed.promptTokens, day);
              stats.texts += texts.length;
              stats.lastOkAt = now().toISOString();
              record(true, started);
              return parsed.vectors;
            }
            let code = "";
            try {
              const e = (JSON.parse(r.text) as { error?: { code?: unknown; type?: unknown } }).error;
              code = `${typeof e?.code === "string" ? e.code : ""} ${typeof e?.type === "string" ? e.type : ""}`;
            } catch {
              // not JSON: the status decides
            }
            if (r.status === 401 || r.status === 403) return halt("auth", `the embeddings key was refused (HTTP ${r.status}); no retry. Check the ${EMBEDDINGS_CREDENTIAL} credential and its project permissions.`, started);
            if (r.status === 429 && /insufficient_quota|billing/.test(code)) return halt("quota", "the embeddings project has no quota left (HTTP 429 insufficient_quota); no retry. Check the project's billing and limits.", started);
            if (r.status === 400 || r.status === 404 || r.status === 422) return halt("config", `the embeddings request was refused as invalid (HTTP ${r.status}${code.trim() ? ` ${scrub(code, o.key, 60)}` : ""}); no retry. Check ORBIT_EMBEDDINGS_MODEL and ORBIT_EMBEDDINGS_DIMENSIONS.`, started);
            if (r.status === 429) {
              transient = new EmbeddingUnavailable("rate-limit", "embeddings rate limit (HTTP 429)");
              const ra = Number(r.retryAfter);
              if (Number.isFinite(ra) && ra >= 0) wait = Math.min(ra * 1000, EMBED_RETRY_AFTER_MAX_MS);
            } else if (r.status >= 500) transient = new EmbeddingUnavailable("server", `embeddings server error (HTTP ${r.status})`);
            else return halt("config", `unexpected embeddings response (HTTP ${r.status}); no retry`, started);
          }
          if (attempt >= maxAttempts) return failAt(new EmbeddingUnavailable(transient.kind, `${transient.message}; gave up after ${attempt} attempt(s)`));
          stats.retries++;
          try {
            await sleep(wait, signal);
          } catch (err) {
            return failAt(err as EmbeddingUnavailable);
          }
        }
      } finally {
        release();
      }
    },
  };
  return embedder;
}
export type OpenAIEmbedder = ReturnType<typeof openaiEmbedder>;

// The /status line for semantic photo search. verifiedAt is the epoch ("not exercised yet", which the watch ignores) until a request
// succeeds in this process, and then the time of the last real success. The port is on-demand, so /status does not age it into
// "degraded" (src/server.ts withFreshness); the latest outcome decides its state, and the smoke record says how old the evidence is.
export function embeddingsStatus(cfg: EmbeddingsConfig, e: OpenAIEmbedder | undefined, budget: EmbeddingBudget | undefined, now: () => Date = () => new Date()): PortStatus {
  const port = "photo-embeddings";
  if (cfg.state === "off") return { port, state: "down", impl: "off", detail: cfg.detail, verifiedAt: new Date(0).toISOString() };
  if (cfg.state === "misconfigured" || !e || !budget) return { port, state: "down", impl: "misconfigured", detail: cfg.state === "misconfigured" ? cfg.detail : "not configured", verifiedAt: now().toISOString() };
  const u = budget.used();
  const usage = `Today (UTC ${u.day}): ${u.requests}/${budget.limits.dailyRequests} requests, ${u.tokens}/${budget.limits.dailyTokens} input tokens counted by ORBIT (not a provider-enforced ceiling; billing coverage is not verified by ORBIT).`;
  const impl = `openai-embeddings/${cfg.settings.model}/${cfg.settings.dims}`;
  if (budget.unreadable()) return { port, state: "down", impl, detail: `The budget ledger is unreadable, so no request is sent. ${usage}`, verifiedAt: now().toISOString() };
  const h = e.halted();
  if (h) return { port, state: "degraded", impl, detail: `Paused until ${new Date(h.until).toISOString()}: ${h.reason} Photo search falls back to keyword ranking. ${usage}`, verifiedAt: now().toISOString() };
  // No outcome yet in this process: NOT verified, and not live from configuration alone. The startup smoke check (src/smoke-checks.ts)
  // normally supplies the first outcome within seconds of the server listening. verifiedAt stays the epoch ("not exercised yet").
  const latest = e.stats.latest;
  if (!latest) return { port, state: "degraded", impl, detail: `Configured; not verified yet in this process: no embeddings request has completed since it started.${e.stats.lastError ? ` Last error: ${e.stats.lastError}.` : ""} ${usage}`, verifiedAt: new Date(0).toISOString() };
  const last = `${e.stats.lastOkAt ? `Last success ${e.stats.lastOkAt}.` : "No success yet in this process."}${e.stats.lastError ? ` Last error: ${e.stats.lastError}.` : ""}`;
  // The most recently started call decides: a late failure of an older call does not hide a newer success, and vice versa.
  if (!latest.ok) return { port, state: "degraded", impl, detail: `The latest embeddings request (started ${latest.startedAt}) failed. Photo search falls back to keyword ranking. ${last} ${usage}`, verifiedAt: e.stats.lastOkAt ?? new Date(0).toISOString() };
  return { port, state: "live", impl, detail: `${last} ${usage}`, verifiedAt: e.stats.lastOkAt ?? latest.at };
}
