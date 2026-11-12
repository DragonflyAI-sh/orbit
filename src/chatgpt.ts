import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instructions, parseOutput, responsesTools } from "./model.ts";
import type { Item, Message, ModelPort, Step, ToolDef } from "./model.ts";
import { redact } from "./ops/protocol.ts";
import type { PortStatus } from "./ports.ts";

// "Sign in with ChatGPT" token sharing, the method OpenClaw's OpenAI plugin uses: ChatGPT authorizes eligible
// Responses API calls on the subscription. ORBIT registers and keeps its own login, because every refresh
// replaces the token and a shared one would break whichever client refreshed second.
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const RESPONSES_URL = `${RESOURCE}/responses`;
const REDIRECT_URI = "http://localhost:8080/auth/callback";
const REGISTER_CLIENT = "dynamic_agent_client";
const SCOPE = "openid email profile resource.invoke chatgpt.tokens.use.direct offline_access";
const SHARING_SCOPES = ["chatgpt.tokens.use.direct", "chatpass.enable.request.direct"];
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// On-demand renewal (a call finds the token about to expire) happens inside this margin of expiry.
const REFRESH_EARLY_MS = 5 * 60 * 1000;
// Background renewal starts earlier, so it normally wins and a call never has to wait for it.
const REFRESH_AHEAD_MS = 10 * 60 * 1000;
// Either margin is capped at half of the last token lifetime seen, so a short-lived token is not renewed in a loop.
// After a successful renewal, no further background attempt for at least this long.
const MIN_RENEW_GAP_MS = 60 * 1000;
// Retry delays after a failed renewal: 1, 2, 4, 8 minutes, then every 15. A revoked login is not retried.
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 20 * 1000;

export type Tokens = {
  access: string;
  refresh: string;
  expires: number;
  idToken: string;
  clientId: string;
  subject: string;
  email?: string;
  scope?: string;
};

export type Login =
  | { state: "signed-out" }
  | { state: "pending"; authorizeUrl: string; expiresAt: string }
  | { state: "signed-in"; email?: string; since: string }
  | { state: "failed"; detail: string; at: string };

type Fetch = typeof fetch;

export type TokenFile = { read(): Tokens | undefined; write(t: Tokens): void; persisted: boolean };

// Owner-only file in the service's private state directory.
export function tokenFile(dir: string | undefined): TokenFile {
  if (!dir) {
    let value: Tokens | undefined;
    return { read: () => value, write: (t) => void (value = t), persisted: false };
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "chatgpt-auth.json");
  return {
    read: () => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Tokens;
      } catch {
        return undefined;
      }
    },
    write: (t) => {
      writeFileSync(`${file}.new`, JSON.stringify(t), { mode: 0o600 });
      renameSync(`${file}.new`, file);
    },
    persisted: true,
  };
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const decodePart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; token_type?: string; scope?: string; error?: unknown };

// A renewal that failed. `permanent` means retrying cannot help: the person must sign in again.
export class RenewalError extends Error {
  permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

async function tokenRequest(fetcher: Fetch, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    if (body.error === "invalid_grant") throw new RenewalError("ChatGPT connection expired or was revoked; sign in again", true);
    throw new RenewalError(`ChatGPT token ${form.grant_type} failed: HTTP ${res.status}`);
  }
  return body;
}

type Jwk = { kid?: string; kty: string; n?: string; e?: string };

// Verifies the ID token's RS256 signature against OpenAI's published keys, then its claims.
export async function verifyIdToken(fetcher: Fetch, idToken: string, clientId: string, nonce: string | undefined, now: number) {
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("ChatGPT returned a malformed identity token");
  const header = decodePart(h) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error("ChatGPT identity token uses an unexpected algorithm");
  const keys = ((await (await fetcher(JWKS_URL)).json()) as { keys?: Jwk[] }).keys ?? [];
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new Error("No OpenAI signing key matches the identity token");
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("ChatGPT identity token signature is invalid");
  const claims = decodePart(p) as { iss?: string; aud?: string | string[]; azp?: string; sub?: string; exp?: number; nonce?: string; email?: string };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audiences.includes(clientId) || (claims.azp && claims.azp !== clientId)) {
    throw new Error("ChatGPT identity token was not issued to ORBIT");
  }
  if (!claims.sub || !claims.exp || claims.exp * 1000 < now) throw new Error("ChatGPT identity token is expired or has no subject");
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error("ChatGPT identity token nonce does not match this sign-in");
  return claims;
}

type StreamItem = { type: string; content?: { type: string; text: string }[]; call_id?: string; name?: string; arguments?: string };
type ResponsesEvent = { type?: string; delta?: string; item?: StreamItem; response?: { output?: StreamItem[] } };

// Text and function calls from a streamed response. Calls come from the completed response, or from per-item
// events when the stream ends without one.
export function stepFromStream(raw: string): Step {
  let deltas = "";
  let completed: StreamItem[] | undefined;
  const items: StreamItem[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: ResponsesEvent;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && event.delta) deltas += event.delta;
    if (event.type === "response.output_item.done" && event.item) items.push(event.item);
    if (event.type === "response.completed") completed = event.response?.output;
  }
  const calls = parseOutput(completed?.length ? completed : items).calls;
  return { text: textFromStream(raw) || deltas, calls };
}


// The Responses API streams server-sent events; collect the text.
export function textFromStream(raw: string): string {
  let deltas = "";
  let final = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: ResponsesEvent;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && event.delta) deltas += event.delta;
    if (event.type === "response.completed") {
      final = (event.response?.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
    }
  }
  return final || deltas;
}

// ---- Provider errors ----
// The Responses stream reports failures as events (response.failed, response.incomplete, error), often with HTTP 200,
// and an HTTP error carries a JSON body. Both are turned into a ProviderError that says what happened and, for a usage
// limit, when it resets, instead of the bare "response had no text" that hid the reason before.

// How long ORBIT waits before trying again after a limit that came with no reset time.
export const USAGE_PAUSE_MS = 15 * 60_000;
export const RATE_PAUSE_MS = 60_000;
// A provider reset further away than this is not believed: ORBIT uses its own pause instead of blocking for days.
export const MAX_RESET_MS = 7 * 24 * 60 * 60_000;
// One automatic retry after an overload that arrived before any output, after this delay plus up to a second of jitter.
export const OVERLOAD_RETRY_MS = 2_000;
// The code on a refusal ORBIT makes itself during a pause (no request was sent).
export const PAUSED = "orbit_paused";

export type ProviderErrorKind = "usage_limit" | "rate_limit" | "overloaded" | "auth" | "incomplete" | "failed";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly resetsAt?: string;
  readonly code?: string;
  // Structured spend-accounting diagnostics (src/openrouter.ts): kept apart from `message`, so callers never edit the text to add or remove them.
  readonly accounting?: string[];
  constructor(kind: ProviderErrorKind, message: string, resetsAt?: string, code?: string, accounting?: string[]) {
    super(message);
    if (accounting?.length) this.accounting = accounting;
    this.name = "ProviderError";
    this.kind = kind;
    this.resetsAt = resetsAt;
    this.code = code;
  }
}

type ProviderErrorBody = {
  type?: string;
  code?: string | number;
  message?: string;
  resets_at?: number | string;
  resets_in_seconds?: number;
  reason?: string;
};

const USAGE_LIMIT = /usage_limit|usage_not_included|insufficient_quota|quota_exceeded|plan_limit/i;
const RATE_LIMIT = /rate_limit|too_many_requests/i;
const AUTH = /invalid_api_key|unauthori[sz]ed|invalid_token|token_expired|forbidden|permission/i;
const OVERLOADED = /overloaded|server_busy|temporarily_unavailable|capacity/i;
// Provider text as it may be shown: one line, ORBIT's full secret redaction (tokens, JWTs, keys, long opaque strings,
// bearer and basic credentials, URL userinfo), an HTML error page reduced to a note, and a length cap.
const clean = (s: unknown, max = 200) => {
  const text = String(s ?? "").trim();
  if (/^<(!doctype|html|head|body)\b/i.test(text)) return "(an HTML error page)";
  return redact(text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
};

// A reset time from the provider: epoch seconds or an ISO date in resets_at, or seconds from now in resets_in_seconds.
// Only a time in the future and within MAX_RESET_MS counts; anything else (past, zero, absurd, invalid) is treated as
// no reset time, so ORBIT's own short pause applies.
function resetFrom(body: ProviderErrorBody, now: number): string | undefined {
  const at = body.resets_at;
  const inS = body.resets_in_seconds;
  let ms: number | undefined;
  if (typeof at === "number" && Number.isFinite(at) && at > 0) ms = at < 1e12 ? at * 1000 : at;
  else if (typeof at === "string") ms = Date.parse(at);
  else if (typeof inS === "number" && Number.isFinite(inS) && inS > 0) ms = now + inS * 1000;
  if (ms === undefined || !Number.isFinite(ms) || ms <= now || ms - now > MAX_RESET_MS) return undefined;
  return new Date(ms).toISOString();
}

const inWords = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

function classify(body: ProviderErrorBody, status: number | undefined, now: number): ProviderError {
  const tag = `${body.type ?? ""} ${body.code ?? ""}`;
  const code = clean(body.code ?? body.type, 60) || undefined;
  // The provider's own sentence, without its closing punctuation: ours follows it.
  const said = clean(body.message).replace(/[.!\s]+$/, "");
  const resetsAt = resetFrom(body, now);
  const when = resetsAt ? ` It resets at ${resetsAt} (in ${inWords(Date.parse(resetsAt) - now)}).` : "";
  if (USAGE_LIMIT.test(tag) || (status === 429 && /usage|limit|plan/i.test(said))) {
    return new ProviderError("usage_limit", `ChatGPT usage limit reached for this plan${said ? `: ${said}` : ""}.${when}`, resetsAt, code);
  }
  if (RATE_LIMIT.test(tag) || status === 429) {
    return new ProviderError("rate_limit", `ChatGPT is rate limiting requests${said ? `: ${said}` : ""}.${when}`, resetsAt, code);
  }
  if (OVERLOADED.test(tag) || status === 503 || status === 529) {
    return new ProviderError("overloaded", `ChatGPT's servers are overloaded${said ? `: ${said}` : ""}.`, undefined, code);
  }
  if (AUTH.test(tag) || status === 401 || status === 403) {
    return new ProviderError("auth", `ChatGPT refused the login${said ? `: ${said}` : ""}. Sign in again from the web page if this persists.`, undefined, code);
  }
  const what = [code, said].filter(Boolean).join(": ");
  return new ProviderError("failed", `ChatGPT returned an error${what ? `: ${what}` : ""}.`, resetsAt, code);
}

// The error an HTTP failure describes. The body is JSON ({error:{...}} or {detail:{...}}) or text.
export function httpProblem(status: number, text: string, now = Date.now()): ProviderError {
  let body: ProviderErrorBody = {};
  try {
    const parsed = JSON.parse(text) as { error?: ProviderErrorBody | string; detail?: ProviderErrorBody | string; message?: string };
    const inner = parsed.error ?? parsed.detail;
    body = typeof inner === "object" && inner ? inner : { message: typeof inner === "string" ? inner : parsed.message };
  } catch {
    body = { message: text };
  }
  const e = classify(body, status, now);
  return new ProviderError(e.kind, `HTTP ${status}: ${e.message}`, e.resetsAt, e.code);
}

// The failure a stream reports, if any. Undefined when the stream holds no error, failed or incomplete event.
export function streamProblem(raw: string, now = Date.now()): ProviderError | undefined {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: { type?: string; error?: ProviderErrorBody; response?: { error?: ProviderErrorBody | null; incomplete_details?: { reason?: string } | null }; code?: string; message?: string };
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.failed") return classify(event.response?.error ?? {}, undefined, now);
    if (event.type === "error" || event.type === "response.error") return classify(event.error ?? { code: event.code, message: event.message }, undefined, now);
    if (event.type === "response.incomplete") {
      const reason = clean(event.response?.incomplete_details?.reason, 60) || "no reason given";
      return new ProviderError("incomplete", `ChatGPT stopped before answering (incomplete: ${reason}).`, undefined, reason);
    }
  }
  return undefined;
}

// What the stream contained when it had no text, no calls and no error event: the event types only, never content.
export function streamShape(raw: string): string {
  const types = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const t = (JSON.parse(line.slice(5).trim()) as { type?: unknown }).type;
      if (typeof t === "string") types.add(clean(t, 60));
    } catch {
      // not JSON
    }
  }
  return types.size ? [...types].slice(0, 12).join(", ") : "no events";
}

export type ChatGPTModel = ModelPort & {
  // Stops background renewal and waits for one already in flight, so shutdown cannot lose a rotated token.
  stop(): Promise<void>;
  login(): Login;
  startLogin(): Promise<Login>;
  finishLogin(callbackUrl: string): Promise<Login>;
};

export type ChatGPTOptions = { fetcher?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void> };

export function chatgptModel(model: string, file: TokenFile, options: ChatGPTOptions = {}): ChatGPTModel {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const saved = file.read();
  let login: Login = saved ? { state: "signed-in", email: saved.email, since: new Date(now()).toISOString() } : { state: "signed-out" };
  let pending: { state: string; nonce: string; verifier: string; deadline: number } | undefined;
  let lastOk: string | undefined;
  let lastError: { at: string; detail: string; renewal?: boolean } | undefined;
  let refreshing: Promise<Tokens> | undefined;
  let stopped = false;
  // Credential renewal, kept apart from inference (lastOk/lastError): renewing a login is not a model answer.
  let renewedAt: string | undefined;
  // When a background pass last found the saved login complete, sharing-enabled and unexpired with no failed renewal.
  // A real check of the credential on disk, not a sign that the timer is alive; it never stands in for lastOk.
  let checkedAt: string | undefined;
  let lifetimeMs: number | undefined;
  let nextAttempt = 0;
  let failure: { at: string; detail: string; attempts: number; permanent: boolean } | undefined;
  const impl = `chatgpt-token-sharing/${model}`;
  const at = () => new Date(now()).toISOString();

  const credential = async (body: TokenResponse, clientId: string, nonce: string | undefined, previous?: Tokens): Promise<Tokens> => {
    const idToken = body.id_token ?? previous?.idToken;
    const refresh = body.refresh_token ?? previous?.refresh;
    if (!body.access_token || !refresh || !idToken || body.token_type?.toLowerCase() !== "bearer") {
      throw new Error("ChatGPT did not return a complete renewable login");
    }
    const claims = body.id_token ? await verifyIdToken(fetcher, idToken, clientId, nonce, now()) : decodePart(idToken.split(".")[1]);
    if (previous && claims.sub !== previous.subject) throw new RenewalError("ChatGPT account changed during refresh; sign in again", true);
    const scope = body.scope ?? previous?.scope;
    const granted = new Set(scope?.split(/\s+/) ?? []);
    if (!granted.has("resource.invoke") || !SHARING_SCOPES.some((s) => granted.has(s))) {
      throw new RenewalError("ChatGPT sign-in worked but token sharing was not granted; sign in again and allow it", true);
    }
    lifetimeMs = (body.expires_in ?? 3600) * 1000;
    return {
      access: body.access_token,
      refresh,
      expires: now() + lifetimeMs,
      idToken,
      clientId,
      subject: claims.sub,
      email: claims.email ?? previous?.email,
      scope,
    };
  };

  const margin = (base: number) => Math.min(base, (lifetimeMs ?? Infinity) / 2);

  // One refresh at a time, shared by the background renewal and by calls: a second concurrent refresh would reuse a
  // token the first just replaced. The new token is saved before anyone sees it.
  const renew = (tokens: Tokens): Promise<Tokens> => {
    refreshing ??= tokenRequest(fetcher, { grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh, resource: RESOURCE })
      .then((body) => credential(body, tokens.clientId, undefined, tokens))
      .then((t) => {
        file.write(t);
        renewedAt = at();
        failure = undefined;
        nextAttempt = now() + MIN_RENEW_GAP_MS;
        // A call that failed only because the login could not be renewed no longer says anything.
        if (lastError?.renewal) lastError = undefined;
        return t;
      })
      .catch((err) => {
        const attempts = (failure?.attempts ?? 0) + 1;
        const permanent = err instanceof RenewalError && err.permanent;
        const detail = (err instanceof Error ? err.message : "unknown error").slice(0, 200);
        failure = { at: at(), detail, attempts, permanent };
        nextAttempt = permanent ? Infinity : now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
        throw new RenewalError(detail, permanent);
      })
      .finally(() => (refreshing = undefined));
    return refreshing;
  };

  // The token for a call. Renews inside the margin; if that fails but the token still works, uses it. While backing
  // off, a still-valid token is used as is; an expired one is always tried, because nothing else can work.
  const fresh = async (force = false): Promise<Tokens> => {
    const tokens = file.read();
    if (!tokens) throw new Error("not signed in to ChatGPT");
    if (!force) {
      if (tokens.expires - margin(REFRESH_EARLY_MS) > now()) return tokens;
      if (tokens.expires > now() && now() < nextAttempt && !refreshing) return tokens;
    }
    try {
      return await renew(tokens);
    } catch (err) {
      // A transient failure with a working token is no reason to fail the call; a revoked or changed login is.
      if (!force && tokens.expires > now() && !(err instanceof RenewalError && err.permanent)) return tokens;
      throw err;
    }
  };

  // A 401 means the token was refused. If something renewed it meanwhile, use that rather than rotating again.
  const afterRefusal = (used: Tokens) => {
    const current = file.read();
    return current && current.access !== used.access ? Promise.resolve(current) : fresh(true);
  };

  // Called from the periodic tick. Renews shortly before expiry with no model call, never more than one at a time,
  // and only when due: not inside the back-off, and not for a login that must be signed in again.
  const maintain = async (): Promise<void> => {
    const t = file.read();
    if (stopped) return;
    // Verify the saved login first. Skipped while a renewal is failing or in flight, and for a login that is
    // incomplete or expired: only a login that checks out counts as verified.
    if (t && !refreshing && !failure && !loginProblem(t) && t.expires > now()) checkedAt = at();
    if (!t || refreshing || now() < nextAttempt) return;
    if (t.expires - margin(REFRESH_AHEAD_MS) > now()) return;
    await renew(t).catch(() => {});
  };

  // A usage or rate limit: no call is made before `until` (it would only spend a request to be refused). `until` is the
  // provider's reset time, or, when the provider gave none, ORBIT's own pause (estimated: true), never shown as a reset.
  type Limit = { error: ProviderError; until: string; estimated: boolean };
  let limited: Limit | undefined;
  // The most recent limit, kept after it passes so the port can say "not confirmed" until a call answers.
  let lastLimit: Limit | undefined;

  // Records a failed call when it ends. Times are when calls finished, so the port reflects the latest outcome.
  const record = (err: unknown) => {
    // A refusal made by the pause itself is not a call: it changes neither the last failure nor the pause.
    if (err instanceof ProviderError && err.code === PAUSED) return;
    // A renewal failure is reported by the renewal state, not as an inference failure.
    lastError = { at: at(), detail: err instanceof Error ? err.message : String(err), renewal: err instanceof RenewalError };
    if (err instanceof ProviderError && (err.kind === "usage_limit" || err.kind === "rate_limit")) {
      const pause = err.kind === "usage_limit" ? USAGE_PAUSE_MS : RATE_PAUSE_MS;
      const next: Limit = { error: err, until: err.resetsAt ?? new Date(now() + pause).toISOString(), estimated: !err.resetsAt };
      const current = activeLimit();
      // A limit already in force is kept, so calls that were in flight when it began cannot push it later, except that
      // better information wins without ever shortening it: a provider reset replaces ORBIT's own estimate, and a usage
      // limit replaces a rate-limit pause.
      if (current) {
        const better = (current.estimated && !next.estimated) || (current.error.kind === "rate_limit" && next.error.kind === "usage_limit");
        if (!better || Date.parse(next.until) <= Date.parse(current.until)) return;
      }
      limited = next;
      lastLimit = limited;
    } else if (!activeLimit()) {
      lastLimit = undefined;
    }
  };

  // The limit still in force, if any. Once its time passes, calls are allowed again.
  const activeLimit = (): Limit | undefined => {
    if (limited && Date.parse(limited.until) > now()) return limited;
    limited = undefined;
    return undefined;
  };

  const limitWhat = (l: Limit) => (l.error.kind === "usage_limit" ? "ChatGPT usage limit reached for this plan" : "ChatGPT is rate limiting requests");
  const limitWhen = (l: Limit) =>
    l.estimated
      ? `The provider gave no reset time, so ORBIT pauses model calls until ${l.until} (in ${inWords(Date.parse(l.until) - now())}) and then tries again.`
      : `It resets at ${l.until} (in ${inWords(Date.parse(l.until) - now())}); ORBIT makes no model call until then.`;

  // An overload reported before the stream produced any output: nothing was answered, so asking again is safe.
  const retryable = new WeakSet<ProviderError>();
  const OUTPUT_EVENT = /"type"\s*:\s*"response\.(output_item|output_text|content_part|function_call)/;

  // One HTTP request: the stream text on success; a ProviderError for an HTTP error or an error event.
  const attempt = async (body: string): Promise<string> => {
    const used = await fresh();
    let res = await call(used, body);
    if (res.status === 401) res = await call(await afterRefusal(used), body);
    if (!res.ok) {
      const e = httpProblem(res.status, await res.text().catch(() => ""), now());
      if (e.kind === "overloaded") retryable.add(e);
      throw e;
    }
    const raw = await res.text();
    const problem = streamProblem(raw, now());
    if (problem) {
      if (problem.kind === "overloaded" && !OUTPUT_EVENT.test(raw)) retryable.add(problem);
      throw problem;
    }
    return raw;
  };

  // One model request. No call during a limit; one retry after an overload that came before any output.
  // A refusal made without calling, while a limit is in force.
  const refuseIfLimited = () => {
    const limit = activeLimit();
    if (limit) throw new ProviderError(limit.error.kind, `${limitWhat(limit)}. No call was made. ${limitWhen(limit)}`, limit.estimated ? undefined : limit.until, PAUSED);
  };

  const request = async (body: string): Promise<string> => {
    refuseIfLimited();
    try {
      return await attempt(body);
    } catch (err) {
      if (!(err instanceof ProviderError && retryable.has(err))) throw err;
      const wait = OVERLOAD_RETRY_MS + Math.floor(Math.random() * 1000);
      await sleep(wait);
      // Another call may have hit a limit during the wait: the retry obeys it.
      refuseIfLimited();
      try {
        return await attempt(body);
      } catch (again) {
        if (again instanceof ProviderError && again.kind === "overloaded") {
          throw new ProviderError("overloaded", `${again.message.replace(/\.$/, "")} (asked twice, ${Math.round(wait / 1000)} s apart).`, undefined, again.code);
        }
        throw again;
      }
    }
  };

  const call = (tokens: Tokens, body: string) =>
    fetcher(RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        // OpenClaw sends this on token-sharing requests.
        "x-openai-chatpass-test": "codex-direct",
      },
      body,
    });

  // What is wrong with the saved login on its face, if anything. Local only, no request to OpenAI.
  const loginProblem = (t: Tokens): "incomplete" | "no-sharing" | undefined => {
    if (typeof t.access !== "string" || !t.access || typeof t.refresh !== "string" || !t.refresh || !t.clientId || !t.idToken || !Number.isFinite(t.expires)) return "incomplete";
    const granted = new Set(t.scope?.split(/\s+/) ?? []);
    if (!granted.has("resource.invoke") || !SHARING_SCOPES.some((s) => granted.has(s))) return "no-sharing";
    return undefined;
  };

  // Before any call has been made: what can be checked on this machine alone, with no request to OpenAI. It says
  // the saved login looks complete and usable, never that the model answered. verifiedAt is when this local check
  // ran, not an inference time, so it never stands in for lastOk.
  const readiness = (): PortStatus => {
    const t = file.read();
    const checked = at();
    const down = (detail: string): PortStatus => ({ port: "model", state: "down", impl, detail, verifiedAt: checked });
    const problem = t ? loginProblem(t) : "incomplete";
    if (!t || problem === "incomplete") return down("Saved ChatGPT login is incomplete; sign in again from the web page.");
    if (problem === "no-sharing") return down("Saved ChatGPT login lacks token sharing; sign in again from the web page.");
    const renewed = renewedAt ? ` The login was last renewed at ${renewedAt}.` : "";
    if (t.expires <= now()) {
      return { port: "model", state: "degraded", impl, detail: `Signed in; the access token has expired and has not been renewed yet, so ChatGPT is unconfirmed.${renewed}`, verifiedAt: checked };
    }
    return { port: "model", state: "live", impl, detail: `Signed in: saved ChatGPT login is complete and unexpired (checked locally). No model call has been made yet, so ChatGPT has not been contacted.${renewed}`, verifiedAt: checked };
  };

  // Renewing the login failed. Degraded while the old token still works, down once it does not.
  const renewalFailed = (t: Tokens, f: NonNullable<typeof failure>): PortStatus => {
    const expired = t.expires <= now();
    const retry = f.permanent ? "Sign in again from the web page." : `Retrying (attempt ${f.attempts} failed).`;
    const token = expired ? `The access token expired at ${new Date(t.expires).toISOString()}, so ChatGPT calls will fail until the login is renewed.` : `The current access token still works until ${new Date(t.expires).toISOString()}.`;
    return { port: "model", state: expired ? "down" : "degraded", impl, detail: `Renewing the ChatGPT login failed: ${f.detail}. ${token} ${retry}`, verifiedAt: f.at };
  };

  return {
    maintain,
    async stop() {
      stopped = true;
      await refreshing?.catch(() => {});
    },
    login: () => login,

    // Starts a sign-in: a PKCE authorization link that also registers ORBIT as its own ChatGPT client.
    async startLogin(): Promise<Login> {
      if (login.state === "pending" && pending && pending.deadline > now()) return login;
      const verifier = b64url(randomBytes(32));
      pending = {
        verifier,
        state: b64url(randomBytes(24)),
        nonce: b64url(randomBytes(24)),
        deadline: now() + LOGIN_TIMEOUT_MS,
      };
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: REGISTER_CLIENT,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        state: pending.state,
        nonce: pending.nonce,
        agent_name_hint: "ORBIT",
      }).toString();
      login = { state: "pending", authorizeUrl: url.toString(), expiresAt: new Date(pending.deadline).toISOString() };
      return login;
    },

    // Takes the localhost:8080 address the browser landed on after approving.
    async finishLogin(callbackUrl: string): Promise<Login> {
      try {
        if (!pending || pending.deadline < now()) throw new Error("No sign-in is in progress, or it expired. Start again.");
        let url: URL;
        try {
          url = new URL(callbackUrl.trim());
        } catch {
          throw new Error("That is not a URL. Paste the full address from the browser's address bar.");
        }
        const q = url.searchParams;
        if (q.get("state") !== pending.state) throw new Error("That address is from a different sign-in. Start again.");
        if (q.get("error")) throw new Error(q.get("error") === "access_denied" ? "ChatGPT authorization was declined." : `ChatGPT authorization failed: ${q.get("error")}`);
        const code = q.get("code");
        const ids = q.getAll("client_id");
        if (!code) throw new Error("The address has no authorization code.");
        if (ids.length !== 1 || !/^oaiapp_[A-Za-z0-9_-]+$/.test(ids[0])) throw new Error("ChatGPT returned an invalid client registration.");
        const body = await tokenRequest(fetcher, {
          grant_type: "authorization_code",
          client_id: ids[0],
          code,
          code_verifier: pending.verifier,
          redirect_uri: REDIRECT_URI,
          resource: RESOURCE,
        });
        const tokens = await credential(body, ids[0], pending.nonce);
        file.write(tokens);
        failure = undefined;
        nextAttempt = 0;
        if (lastError?.renewal) lastError = undefined;
        pending = undefined;
        login = { state: "signed-in", email: tokens.email, since: at() };
      } catch (err) {
        login = { state: "failed", detail: err instanceof Error ? err.message : String(err), at: at() };
      }
      return login;
    },

    status(): PortStatus {
      if (login.state === "pending") {
        return { port: "model", state: "down", impl, detail: "Waiting for sign-in: approve on ChatGPT, then paste the localhost address into ORBIT.", verifiedAt: at() };
      }
      const current = file.read();
      if (!current) {
        const why = login.state === "failed" ? ` Last sign-in failed: ${login.detail}` : "";
        return { port: "model", state: "down", impl, detail: `Not signed in to ChatGPT. Sign in from the web page.${why}`, verifiedAt: at() };
      }
      // A limit in force decides the state even if a call that was already in flight answered after it began.
      const limit = activeLimit();
      if (limit && lastError) return { port: "model", state: "down", impl, detail: `${limitWhat(limit)}. ${limitWhen(limit)}`, verifiedAt: lastError.at };
      if (lastError && !lastError.renewal && (!lastOk || lastError.at > lastOk)) {
        if (lastLimit && Date.parse(lastLimit.until) <= now()) {
          const ended = lastLimit.estimated ? `ORBIT's pause after the limit ended at ${lastLimit.until}` : `The limit was due to reset at ${lastLimit.until}`;
          return { port: "model", state: "degraded", impl, detail: `${ended}. No model call since, so it is not confirmed that ChatGPT answers again.`, verifiedAt: lastError.at };
        }
        return { port: "model", state: "down", impl, detail: `Last call failed: ${lastError.detail}`, verifiedAt: lastError.at };
      }
      if (failure) return renewalFailed(current, failure);
      if (lastOk) {
        if (current.expires <= now()) {
          return { port: "model", state: "degraded", impl, detail: "Answered before, but the access token has expired and has not been renewed yet.", verifiedAt: lastOk };
        }
        // An idle but healthy model stays live: the login being renewed or re-checked in the background is verification
        // too. Only the answer time is shown when nothing newer exists. A failed call is handled above and is not
        // cleared by a login check, which says nothing about whether the model answers.
        const verified = [lastOk, renewedAt, checkedAt].filter((v): v is string => !!v).sort().at(-1)!;
        return { port: "model", state: "live", impl, detail: "Answering through your ChatGPT subscription.", verifiedAt: verified };
      }
      return readiness();
    },

    async step(input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[]): Promise<Step> {
      const body = JSON.stringify({
        model,
        instructions: instructions(limits, notes, tools.map((t) => `${t.name}: ${t.description}`)),
        input,
        ...(tools.length ? { tools: responsesTools(tools) } : {}),
        stream: true,
        store: false,
      });
      try {
        const raw = await request(body);
        const step = stepFromStream(raw);
        if (!step.text && !step.calls.length) throw new Error(`response had no text and no tool call (stream events: ${streamShape(raw)})`);
        lastOk = at();
        return step;
      } catch (err) {
        record(err);
        throw err;
      }
    },

    async reply(messages: Message[], limits: string[], notes?: string) {
      const body = JSON.stringify({
        model,
        instructions: instructions(limits, notes),
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        store: false,
      });
      try {
        const raw = await request(body);
        const text = textFromStream(raw);
        if (!text) throw new Error(`response had no text (stream events: ${streamShape(raw)})`);
        lastOk = at();
        return { value: text, provenance: "live" as const, source: `model/${impl}` };
      } catch (err) {
        record(err);
        throw err;
      }
    },
  };
}
