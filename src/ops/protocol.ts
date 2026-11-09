// Shared by the root helper (helper.ts) and ORBIT's client (../ops-client.ts). No imports: the installer copies this
// file next to helper.ts, so it must stand alone. Only fixed, named actions exist; nothing here ever becomes a command.

export const SOCKET_PATH = "/run/orbit-ops.sock";
export const MAX_REQUEST_BYTES = 256;
export const MAX_RESPONSE_BYTES = 32 * 1024;
export const LOG_LINES_MAX = 100;
export const LOG_LINES_DEFAULT = 50;
export const LOG_LINE_CHARS = 200;
export const LOG_TOTAL_CHARS = 7000;

export const ACTIONS = ["orbit_status", "orbit_logs", "deploy_state", "host_health", "tailscale_status", "vault_sync", "credentials"] as const;
export type Action = (typeof ACTIONS)[number];

export type OpsRequest = { action: Action; lines?: number };
export type OpsError = { code: string; message: string };
export type OpsResponse = { ok: true; action: Action; data: unknown } | { ok: false; action?: string; error: OpsError };

export class OpsReject extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Strict: a JSON object with exactly the keys the action allows. Unknown actions, unknown keys, wrong types and
// out-of-range numbers are all rejected; nothing is coerced.
export function parseRequest(raw: string): OpsRequest {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw new OpsReject("request_too_large", `Request is larger than ${MAX_REQUEST_BYTES} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OpsReject("bad_request", "Request is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OpsReject("bad_request", "Request must be a JSON object.");
  const obj = value as Record<string, unknown>;
  if (!Object.hasOwn(obj, "action") || typeof obj.action !== "string") throw new OpsReject("bad_request", "Request needs {action: string}.");
  if (!(ACTIONS as readonly string[]).includes(obj.action)) throw new OpsReject("unknown_action", "Unknown action.");
  const action = obj.action as Action;
  const allowed = action === "orbit_logs" ? ["action", "lines"] : ["action"];
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new OpsReject("bad_arguments", `Unexpected argument for ${action}.`);
  if (action !== "orbit_logs") return { action };
  if (!Object.hasOwn(obj, "lines")) return { action, lines: LOG_LINES_DEFAULT };
  const n = obj.lines;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > LOG_LINES_MAX) {
    throw new OpsReject("bad_arguments", `lines must be an integer from 1 to ${LOG_LINES_MAX}.`);
  }
  return { action, lines: n };
}

// ---- redaction: applied to every string before it leaves the helper, before it is audited, and again in the client ----

const SHA1 = /^[0-9a-f]{40}$/;
const RULES: [RegExp, string | ((m: string) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted key]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|tskey-[A-Za-z0-9-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,})/g, "[redacted token]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, "[redacted jwt]"],
  [
    /([\w.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie|session[_-]?id)[\w.-]*)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi,
    "$1$2[redacted]",
  ],
  // Long opaque strings (keys, hashes, base64). A plain 40-hex git commit is not a secret and stays.
  [/[A-Za-z0-9_-]{32,}/g, (m) => (SHA1.test(m) ? m : "[redacted]")],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to as string);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}
