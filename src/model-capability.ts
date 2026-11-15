import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { redact } from "./ops/protocol.ts";

// Photo-input capability of the configured model, resolved per backend (docs/photos.md, "Model capability"). One resolver per model
// adapter answers images() for both the Assistant and Chat (src/thread-service.ts is the only guard), /status and orbit_config_view.
//
// Sources, strongest first (the precedence is the same for every backend):
//   1. provider: the backend's own model metadata, when the backend has a documented metadata contract AND the answer carries an explicit
//      capability field. A listed model with no capability field is existence only, never image support.
//   2. operator: a declaration in the trusted operator file (ORBIT_MODEL_CAPABILITIES, an absolute path written by hand on the host). It may
//      restrict anything, and may fill a gap the provider leaves, but never overrides an explicit provider "unsupported".
//   3. bundled: ORBIT's registry below, exact ids only, each with its evidence. No name patterns.
//   4. none: unknown. Photos are refused locally rather than sent to a model that might ignore them.
// Conflicts are always reported in the resolution. An explicit "unsupported" from the provider or the operator always wins over a
// "supported" from anywhere else. Nothing in a message, a photo or a tool result can change any of this.

export type Backend = "chatgpt-token-sharing" | "openai-api";
export const BACKENDS: readonly Backend[] = ["chatgpt-token-sharing", "openai-api"];
export type ImageCapability = "supported" | "unsupported" | "unknown";
export type CapabilitySource = "provider" | "operator" | "bundled" | "none";

const BACKEND_NAME: Record<Backend, string> = { "chatgpt-token-sharing": "ChatGPT token sharing", "openai-api": "the OpenAI API" };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// ---- Bundled registry ----
// Keyed by backend and exact model id. Every entry names its evidence; none was verified by ORBIT with a live call on ORBIT's own route.
const CODEX_CATALOG =
  "OpenAI's Codex CLI bundled model catalog (github.com/openai/codex, codex-rs/models-manager/models.json at a394ff9, 2026-11-15) lists input_modalities [text, image] for this exact slug. That catalog describes the Codex backend; ORBIT's request route is api.openai.com/v1/responses, so this is documentary evidence, not a live check";
const LEGACY_DOCS =
  "carried over from ORBIT's earlier table (#92, #94), which cited OpenAI's model documentation for image input; the exact id is listed here, no prefix match; not re-checked live by ORBIT";
const LEGACY_TEXT_ONLY = "carried over from ORBIT's earlier table (#94), which cited OpenAI's documentation of the model as text-only; not re-checked live by ORBIT";

type Bundled = { capability: "supported" | "unsupported"; evidence: string };
const both = (capability: Bundled["capability"], evidence: string, ids: string[]) =>
  ids.flatMap((id) => BACKENDS.map((b) => [`${b}|${id}`, { capability, evidence }] as const));
export const BUNDLED: ReadonlyMap<string, Bundled> = new Map([
  ...both("supported", CODEX_CATALOG, ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]),
  ...both("supported", LEGACY_DOCS, ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.5-preview", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-codex", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.2", "o3", "o4-mini", "codex-mini-latest"]),
  ...both("unsupported", LEGACY_TEXT_ONLY, ["gpt-3.5-turbo", "o1-mini", "o3-mini"]),
]);

export function bundledCapability(backend: Backend, model: string): Bundled | undefined {
  return BUNDLED.get(`${backend}|${model}`);
}

// ---- Trusted operator declarations ----
// A small JSON file the operator writes by hand on the host (never through chat: it is not a config key ops_propose_config_change can set).
// Strictly validated; any problem rejects the whole file, so a typo can never half-apply. See docs/photos.md for the format.
export type Declaration = { backend: Backend; model: string; image: "supported" | "unsupported"; evidence: string; declaredAt: string };
export type Alias = { backend: Backend; alias: string; model: string; evidence: string };
export type OperatorState = { state: "none" | "ok" | "invalid"; detail: string; declarations: Declaration[]; aliases: Alias[] };
export const OPERATOR_FILE_MAX_BYTES = 16 * 1024;
const EVIDENCE_MAX = 300;

export function parseOperatorFile(text: string): { ok: true; declarations: Declaration[]; aliases: Alias[] } | { ok: false; reason: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: "it is not valid JSON" };
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const only = (o: Record<string, unknown>, keys: string[], where: string) => {
    const extra = Object.keys(o).filter((k) => !keys.includes(k));
    return extra.length ? `${where} has unknown field(s) ${extra.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 32))).join(", ")}` : undefined;
  };
  if (!isObj(doc)) return { ok: false, reason: "the top level must be an object" };
  const top = only(doc, ["version", "declarations", "aliases"], "the top level");
  if (top) return { ok: false, reason: top };
  if (doc.version !== 1) return { ok: false, reason: "version must be 1" };
  const decls = doc.declarations ?? [];
  const aliases = doc.aliases ?? [];
  if (!Array.isArray(decls) || decls.length > 32) return { ok: false, reason: "declarations must be a list of at most 32 entries" };
  if (!Array.isArray(aliases) || aliases.length > 32) return { ok: false, reason: "aliases must be a list of at most 32 entries" };
  const evidenceOk = (v: unknown) => typeof v === "string" && v.trim().length >= 8 && v.length <= EVIDENCE_MAX && !/[\u0000-\u001f]/.test(v);
  const out: Declaration[] = [];
  const seen = new Set<string>();
  for (const [i, d] of decls.entries()) {
    const where = `declarations[${i}]`;
    if (!isObj(d)) return { ok: false, reason: `${where} must be an object` };
    const extra = only(d, ["backend", "model", "image", "evidence", "declaredAt"], where);
    if (extra) return { ok: false, reason: extra };
    if (!BACKENDS.includes(d.backend as Backend)) return { ok: false, reason: `${where}.backend must be one of ${BACKENDS.join(", ")}` };
    if (typeof d.model !== "string" || !MODEL_ID.test(d.model)) return { ok: false, reason: `${where}.model must be an exact model id` };
    // "unknown" is the absence of a declaration, so it cannot be declared.
    if (d.image !== "supported" && d.image !== "unsupported") return { ok: false, reason: `${where}.image must be "supported" or "unsupported"` };
    if (!evidenceOk(d.evidence)) return { ok: false, reason: `${where}.evidence must say, in 8-${EVIDENCE_MAX} characters on one line, what the declaration rests on` };
    if (typeof d.declaredAt !== "string" || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(d.declaredAt) || !Number.isFinite(Date.parse(d.declaredAt))) return { ok: false, reason: `${where}.declaredAt must be a date (YYYY-MM-DD)` };
    const key = `${d.backend}|${d.model}`;
    if (seen.has(key)) return { ok: false, reason: `${where} declares ${d.backend} ${d.model} a second time` };
    seen.add(key);
    out.push({ backend: d.backend as Backend, model: d.model, image: d.image, evidence: String(d.evidence).trim(), declaredAt: d.declaredAt });
  }
  const al: Alias[] = [];
  const aliasKeys = new Set<string>();
  for (const [i, a] of aliases.entries()) {
    const where = `aliases[${i}]`;
    if (!isObj(a)) return { ok: false, reason: `${where} must be an object` };
    const extra = only(a, ["backend", "alias", "model", "evidence"], where);
    if (extra) return { ok: false, reason: extra };
    if (!BACKENDS.includes(a.backend as Backend)) return { ok: false, reason: `${where}.backend must be one of ${BACKENDS.join(", ")}` };
    if (typeof a.alias !== "string" || !MODEL_ID.test(a.alias) || typeof a.model !== "string" || !MODEL_ID.test(a.model)) return { ok: false, reason: `${where}.alias and .model must be exact model ids` };
    if (a.alias === a.model) return { ok: false, reason: `${where} maps a model to itself` };
    if (!evidenceOk(a.evidence)) return { ok: false, reason: `${where}.evidence must say, in 8-${EVIDENCE_MAX} characters on one line, why the alias is the same model` };
    const key = `${a.backend}|${a.alias}`;
    if (aliasKeys.has(key)) return { ok: false, reason: `${where} maps ${a.backend} ${a.alias} a second time` };
    aliasKeys.add(key);
    al.push({ backend: a.backend as Backend, alias: a.alias, model: a.model, evidence: String(a.evidence).trim() });
  }
  // One step only: an alias target may not itself be an alias, and an alias may not also carry its own declaration (ambiguous).
  for (const a of al) {
    if (aliasKeys.has(`${a.backend}|${a.model}`)) return { ok: false, reason: `alias ${a.alias} points at ${a.model}, which is itself an alias (chains are not allowed)` };
    if (seen.has(`${a.backend}|${a.alias}`)) return { ok: false, reason: `${a.alias} is both an alias and a declared model for ${a.backend}` };
  }
  return { ok: true, declarations: out, aliases: al };
}

// Reads the operator file, re-reading only when it changed (size, mtime, inode). Never throws.
export function operatorSource(path: string | undefined): () => OperatorState {
  if (!path) return () => ({ state: "none", detail: "no operator declaration file is configured (ORBIT_MODEL_CAPABILITIES unset)", declarations: [], aliases: [] });
  let sig = "";
  let cached: OperatorState = { state: "none", detail: "", declarations: [], aliases: [] };
  return () => {
    if (!isAbsolute(path)) return { state: "invalid", detail: "ORBIT_MODEL_CAPABILITIES must be an absolute path; the file was not read", declarations: [], aliases: [] };
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      sig = "";
      return (cached = { state: "none", detail: `the operator declaration file ${path} does not exist, so there are no operator declarations`, declarations: [], aliases: [] });
    }
    const next = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
    if (next === sig) return cached;
    sig = next;
    const bad = (reason: string): OperatorState => (cached = { state: "invalid", detail: `the operator declaration file ${path} was rejected and none of it is used: ${reason}`, declarations: [], aliases: [] });
    if (!st.isFile()) return bad("it is not a regular file");
    if (st.size > OPERATOR_FILE_MAX_BYTES) return bad(`it is larger than ${OPERATOR_FILE_MAX_BYTES} bytes`);
    // Writable by anyone means anyone on the host could widen what ORBIT sends photos to: not a trusted declaration.
    if (Number(st.mode) & 0o002) return bad("it is writable by every user on the host");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return bad("it could not be read");
    }
    const parsed = parseOperatorFile(text);
    if (!parsed.ok) return bad(parsed.reason);
    return (cached = { state: "ok", detail: `${parsed.declarations.length} declaration(s) and ${parsed.aliases.length} alias(es) from ${path}`, declarations: parsed.declarations, aliases: parsed.aliases });
  };
}

// ---- Provider metadata ----
// What one discovery said. `listed`: the provider knows the model for these credentials. `capability`: only when the answer carried an
// explicit capability field; absent means the provider said nothing about images.
export type Discovered = { listed: boolean; capability?: "supported" | "unsupported"; detail: string };
export type Discover = (model: string, signal: AbortSignal) => Promise<Discovered>;
export class MetadataError extends Error {
  readonly kind: "unavailable" | "malformed";
  constructor(kind: "unavailable" | "malformed", message: string) {
    super(message);
    this.kind = kind;
  }
}

export type ProviderState =
  | { state: "not-available"; detail: string }
  | { state: "pending"; detail: string }
  | { state: "ok" | "stale"; detail: string; listed: boolean; capability?: "supported" | "unsupported"; checkedAt: string; expiresAt: string }
  | { state: "unavailable" | "malformed"; detail: string; checkedAt: string; retryAt: string };

// The OpenAI API's documented "Retrieve model" (GET /v1/models/{model}) returns {id, object, created, owned_by}: existence, with no
// modality field. ORBIT reads `input_modalities` (the field name of the Codex model catalog contract) only if a response actually carries
// it as a list of strings; otherwise the answer is existence only and never image support.
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
export const METADATA_BODY_MAX = 64 * 1024;

export function readModalities(v: unknown): "supported" | "unsupported" | undefined {
  if (!Array.isArray(v) || !v.length || !v.every((m) => typeof m === "string")) return undefined;
  return v.includes("image") ? "supported" : "unsupported";
}

export function openaiDiscovery(key: string, fetcher: typeof fetch = fetch): Discover {
  return async (model, signal) => {
    let res: Response;
    try {
      res = await fetcher(`${OPENAI_MODELS_URL}/${encodeURIComponent(model)}`, { method: "GET", headers: { authorization: `Bearer ${key}` }, signal });
    } catch (err) {
      throw new MetadataError("unavailable", signal.aborted ? "the metadata request timed out" : `the metadata request failed (${redact(err instanceof Error ? err.name : "error")})`);
    }
    const text = await readBounded(res, METADATA_BODY_MAX, signal);
    if (res.status === 404) return { listed: false, detail: "the OpenAI API answered 404 for this model id with this key (not listed; this says nothing about images)" };
    if (res.status === 401 || res.status === 403) throw new MetadataError("unavailable", `the OpenAI API refused the metadata request (HTTP ${res.status})`);
    if (!res.ok) throw new MetadataError("unavailable", `the OpenAI API answered HTTP ${res.status} to the metadata request`);
    if (text === undefined) throw new MetadataError("malformed", `the metadata answer was larger than ${METADATA_BODY_MAX} bytes`);
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MetadataError("malformed", "the metadata answer was not JSON");
    }
    if (typeof doc !== "object" || doc === null || doc.id !== model) throw new MetadataError("malformed", "the metadata answer did not describe the requested model id");
    const capability = readModalities(doc.input_modalities);
    if (doc.input_modalities !== undefined && !capability) throw new MetadataError("malformed", "the metadata answer had an input_modalities field that is not a list of names");
    return capability
      ? { listed: true, capability, detail: `the OpenAI API lists the model with input_modalities ${capability === "supported" ? "including" : "without"} image` }
      : { listed: true, detail: "the OpenAI API lists the model, with no capability field (its documented model object has none), so this says nothing about images" };
  };
}

async function readBounded(res: Response, max: number, signal: AbortSignal): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new MetadataError("unavailable", "the metadata request timed out");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof MetadataError) throw err;
    throw new MetadataError("unavailable", signal.aborted ? "the metadata request timed out" : "the metadata answer could not be read");
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- Resolution ----
export type Resolution = {
  // Marks answers from this resolver, so a refusal can be told apart from text written by an older ORBIT.
  check: "capability-resolver/1";
  backend: Backend;
  configuredModel: string;
  model: string;
  alias?: { from: string; to: string; evidence: string };
  capability: ImageCapability;
  source: CapabilitySource;
  evidence: string;
  freshness: string;
  provider: ProviderState;
  operator: { state: OperatorState["state"]; detail: string };
  bundled?: Bundled;
  conflicts: string[];
  // Set when photos are refused locally: why, in the owner's words.
  blocking?: string;
};

export type ResolverOptions = {
  backend: Backend;
  model: string;
  discover?: Discover;
  // Why this backend has no discovery, said in diagnostics.
  noDiscovery?: string;
  operator?: () => OperatorState;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  // A stale explicit "unsupported" keeps blocking until this long after it expired; then it is dropped.
  maxStaleMs?: number;
  log?: (line: Record<string, unknown>) => void;
};

export const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;
export const CAPABILITY_RETRY_MS = 10 * 60 * 1000;
export const CAPABILITY_TIMEOUT_MS = 5000;
export const CAPABILITY_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export type CapabilityResolver = {
  resolve(): Resolution;
  // Bounded, single-flight, and only when the cached answer is due. Never throws; never sends a photo.
  refresh(): Promise<void>;
  invalidate(): void;
};

// `until`: when the next refresh is due. Whether an answer is fresh is its own expiresAt, not this.
type Entry = { state: ProviderState; at: number; until: number };

export function capabilityResolver(o: ResolverOptions): CapabilityResolver {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? CAPABILITY_TTL_MS;
  const retry = o.retryMs ?? CAPABILITY_RETRY_MS;
  const timeout = o.timeoutMs ?? CAPABILITY_TIMEOUT_MS;
  const maxStale = o.maxStaleMs ?? CAPABILITY_MAX_STALE_MS;
  const operator = o.operator ?? operatorSource(undefined);
  const log = o.log ?? ((line) => console.log(JSON.stringify(line)));
  const iso = (ms: number) => new Date(ms).toISOString();
  // Keyed by backend and canonical model: an answer is only ever used for the exact key it was asked for.
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<void>>();
  let generation = 0;

  const canonical = (op: OperatorState) => {
    const a = op.aliases.find((x) => x.backend === o.backend && x.alias === o.model);
    return { model: a ? a.model : o.model, alias: a ? { from: a.alias, to: a.model, evidence: a.evidence } : undefined };
  };
  const keyOf = (model: string) => `${o.backend}|${model}`;

  const providerState = (model: string): ProviderState => {
    if (!o.discover) return { state: "not-available", detail: o.noDiscovery ?? `${BACKEND_NAME[o.backend]} has no documented model metadata contract ORBIT can use` };
    const e = cache.get(keyOf(model));
    if (!e) return { state: "pending", detail: "provider metadata has not been fetched yet (it is fetched in the background, never during a reply)" };
    if ((e.state.state === "ok" || e.state.state === "stale") && now() >= Date.parse(e.state.expiresAt)) return { ...e.state, state: "stale" };
    return e.state;
  };

  const resolve = (): Resolution => {
    const op = operator();
    const { model, alias } = canonical(op);
    const provider = providerState(model);
    const declared = op.declarations.find((d) => d.backend === o.backend && d.model === model);
    const bundled = bundledCapability(o.backend, model);
    const conflicts: string[] = [];
    const provCap = provider.state === "ok" ? provider.capability : undefined;
    const staleUnsupported = provider.state === "stale" && provider.capability === "unsupported" && now() - Date.parse(provider.expiresAt) < maxStale;

    let capability: ImageCapability = "unknown";
    let source: CapabilitySource = "none";
    let evidence = "no provider capability metadata, no operator declaration and no entry in ORBIT's bundled registry for this backend and model";
    let freshness = "not applicable";
    if (provCap) {
      capability = provCap;
      source = "provider";
      evidence = provider.detail;
      freshness = `checked ${(provider as { checkedAt: string }).checkedAt}, fresh until ${(provider as { expiresAt: string }).expiresAt}`;
      if (declared && declared.image !== provCap) conflicts.push(`the operator declares ${declared.image}, the provider says ${provCap}`);
      if (bundled && bundled.capability !== provCap) conflicts.push(`ORBIT's bundled registry says ${bundled.capability}, the provider says ${provCap}`);
      // The operator may restrict what the provider allows; it never widens what the provider refuses.
      if (provCap === "supported" && declared?.image === "unsupported") {
        capability = "unsupported";
        source = "operator";
        evidence = declared.evidence;
        freshness = `declared ${declared.declaredAt}`;
      }
    } else if (staleUnsupported) {
      capability = "unsupported";
      source = "provider";
      evidence = provider.detail;
      freshness = `STALE: checked ${(provider as { checkedAt: string }).checkedAt}, expired ${(provider as { expiresAt: string }).expiresAt}; an explicit "unsupported" keeps blocking until a fresh answer`;
      if (declared?.image === "supported") conflicts.push("the operator declares supported, but the provider's last answer (stale) said unsupported");
    } else if (declared) {
      capability = declared.image;
      source = "operator";
      evidence = declared.evidence;
      freshness = `declared ${declared.declaredAt}`;
      if (bundled && bundled.capability !== declared.image) conflicts.push(`ORBIT's bundled registry says ${bundled.capability}, the operator declares ${declared.image}`);
    } else if (bundled) {
      capability = bundled.capability;
      source = "bundled";
      evidence = bundled.evidence;
      freshness = "fixed in this ORBIT release";
    }
    if (provider.state === "ok" && !provider.listed) conflicts.push(`provider note: ${provider.detail}`);

    const name = `${o.model}${alias ? ` (alias of ${model})` : ""}`;
    const where = BACKEND_NAME[o.backend];
    let blocking: string | undefined;
    if (capability === "unsupported") {
      blocking = `ORBIT blocked the photos locally, before any request: the configured model ${name} on ${where} does not take image input (source: ${source}; ${evidence})`;
    } else if (capability === "unknown") {
      const prov =
        provider.state === "not-available"
          ? "this route has no provider capability metadata"
          : provider.state === "pending"
            ? "provider metadata not fetched yet"
            : provider.state === "ok" || provider.state === "stale"
              ? "the provider's metadata has no capability field"
              : `provider metadata ${provider.state}`;
      blocking = `ORBIT blocked the photos locally, before any request: it does not know that the configured model ${name} takes image input on ${where} (${prov}, no operator declaration, not in ORBIT's bundled registry)`;
    }
    return {
      check: "capability-resolver/1",
      backend: o.backend,
      configuredModel: o.model,
      model,
      ...(alias ? { alias } : {}),
      capability,
      source,
      evidence,
      freshness,
      provider,
      operator: { state: op.state, detail: op.detail },
      ...(bundled ? { bundled } : {}),
      conflicts,
      ...(blocking ? { blocking } : {}),
    };
  };

  const refresh = async (): Promise<void> => {
    if (!o.discover) return;
    const { model } = canonical(operator());
    const key = keyOf(model);
    const e = cache.get(key);
    if (e && now() < e.until) return;
    const running = inflight.get(key);
    if (running) return running;
    const gen = generation;
    const p = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      const t = now();
      let state: ProviderState;
      let until: number;
      try {
        const d = await Promise.race([
          o.discover!(model, ctl.signal),
          new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new MetadataError("unavailable", "the metadata request timed out")), { once: true })),
        ]);
        until = t + ttl;
        state = { state: "ok", listed: d.listed, ...(d.capability ? { capability: d.capability } : {}), detail: d.detail.slice(0, 300), checkedAt: iso(t), expiresAt: iso(until) };
      } catch (err) {
        until = t + retry;
        const kind = err instanceof MetadataError ? err.kind : "unavailable";
        const detail = err instanceof MetadataError ? err.message : "the metadata lookup failed";
        // A failed refresh does not erase a last explicit answer: keep it (it ages to stale) and retry later.
        const last = cache.get(key);
        state = last && (last.state.state === "ok" || last.state.state === "stale") ? last.state : { state: kind, detail, checkedAt: iso(t), retryAt: iso(until) };
      } finally {
        clearTimeout(timer);
      }
      // An invalidation while this was running (configuration changed) discards the answer.
      if (gen !== generation) return;
      cache.set(key, { state, at: t, until });
      log({ at: iso(now()), event: "model_capability_metadata", backend: o.backend, model, state: state.state, ...("capability" in state && state.capability ? { capability: state.capability } : {}) });
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  return {
    resolve,
    refresh: () => refresh().catch(() => {}),
    invalidate: () => {
      generation++;
      cache.clear();
      inflight.clear();
    },
  };
}

// The status-safe summary (no evidence text, which may be operator prose): for /status.
export function resolutionSummary(r: Resolution) {
  return { check: r.check, backend: r.backend, configuredModel: r.configuredModel, model: r.model, capability: r.capability, source: r.source, freshness: r.freshness, provider: r.provider.state, operator: r.operator.state, conflicts: r.conflicts.length, blocking: r.blocking ? "blocked locally" : undefined };
}
