// Shared by the privileged admin helper (admin-helper.ts, admin-run.ts) and ORBIT's client (../ops-admin*.ts). Tier 2: fixed,
// named, owner-confirmed mutations. The installer copies this file next to the helpers. Nothing here ever becomes a command:
// the only caller-supplied values that reach the host are the five validated orbit.env settings below.
import { createHash } from "node:crypto";
import { OpsReject, redact } from "./protocol.ts";

export { OpsReject, redact };

export const ADMIN_SOCKET_PATH = "/run/orbit-ops-admin.sock";
export const ADMIN_MAX_REQUEST_BYTES = 4096;
export const ADMIN_MAX_RESPONSE_BYTES = 16 * 1024;

export const MUTATING_ACTIONS = ["restart_orbit", "deploy_now", "rollback_release", "apply_config", "refresh_vault"] as const;
export const ADMIN_ACTIONS = [...MUTATING_ACTIONS, "op_status"] as const;
export type MutatingAction = (typeof MUTATING_ACTIONS)[number];
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

// ---- orbit.env settings the helper may change: exactly these five, nothing else ----

export const CONFIG_KEYS = ["ORBIT_MODEL", "ORBIT_ROUTINES", "ORBIT_ROUTINE_REPOS", "ORBIT_PUBLIC_JOB_URL", "ORBIT_INGRESS_PORT"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigChanges = Partial<Record<ConfigKey, string>>;

// ORBIT_ROUTINES holds Routine trigger ids. They are not the Routine tokens (those are systemd credentials and never go through
// here), but they are treated as sensitive: masked in every card, ledger, audit line and result.
export const SENSITIVE_KEYS: readonly ConfigKey[] = ["ORBIT_ROUTINES"];

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const TRIGGER = /^trig_[A-Za-z0-9]{6,64}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_PAIRS = 8;
export const INGRESS_PORT_MIN = 1024;

const bad = (message: string): never => {
  throw new OpsReject("bad_arguments", message);
};

function pairs(key: string, value: string, right: (v: string) => boolean, rightLabel: string): string {
  const entries = value.split(",");
  if (entries.length > MAX_PAIRS) bad(`${key} can hold at most ${MAX_PAIRS} entries.`);
  const seen = new Set<string>();
  for (const entry of entries) {
    const i = entry.indexOf("=");
    const name = i < 0 ? "" : entry.slice(0, i);
    const rhs = i < 0 ? "" : entry.slice(i + 1);
    if (!NAME.test(name) || !right(rhs)) bad(`${key} entries must look like name=${rightLabel}.`);
    if (seen.has(name)) bad(`${key} names a routine twice.`);
    seen.add(name);
  }
  return value;
}

// Returns the exact text that would be written after `KEY=`. Throws OpsReject("bad_arguments") for anything else. Characters that
// matter to a shell or to systemd's EnvironmentFile (quotes, $, `, ;, spaces, newlines, backslashes, #) can never pass these patterns.
export function validateConfigValue(key: string, value: unknown): string {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) return bad(`${key} is not a setting this action may change.`);
  if (key === "ORBIT_INGRESS_PORT") {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^[1-9][0-9]{0,4}$/.test(text)) return bad("ORBIT_INGRESS_PORT must be a whole number.");
    const n = Number(text);
    if (n < INGRESS_PORT_MIN || n > 65535) return bad(`ORBIT_INGRESS_PORT must be from ${INGRESS_PORT_MIN} to 65535.`);
    return text;
  }
  if (typeof value !== "string" || !value || value.length > 900 || /[^\x21-\x7e]/.test(value)) return bad(`${key} must be a non-empty plain ASCII string without spaces.`);
  switch (key as ConfigKey) {
    case "ORBIT_MODEL":
      return MODEL.test(value) ? value : bad("ORBIT_MODEL must be a model name like gpt-5 (letters, digits, . _ : -).");
    case "ORBIT_ROUTINES":
      return pairs(key, value, (v) => TRIGGER.test(v), "trig_<id>");
    case "ORBIT_ROUTINE_REPOS":
      return pairs(key, value, (v) => REPO.test(v) && !v.split("/").some((s) => s === "." || s === ".."), "owner/repo");
    case "ORBIT_PUBLIC_JOB_URL": {
      let u: URL;
      try {
        u = new URL(value);
      } catch {
        return bad("ORBIT_PUBLIC_JOB_URL must be a URL.");
      }
      const ok =
        u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash && u.pathname === "/" && value === `https://${u.hostname}` &&
        HOSTNAME.test(u.hostname) && u.hostname.length <= 253 && u.hostname.endsWith(".ts.net");
      return ok ? value : bad("ORBIT_PUBLIC_JOB_URL must be https://<name>.ts.net with no port, path, query or credentials.");
    }
  }
  return bad("Unknown setting.");
}

// {KEY: value}: at least one key, only the five, each value validated. Anything else is refused; nothing is coerced
// (except an integer port, which is written as its decimal text).
export function validateConfigChanges(raw: unknown): ConfigChanges {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("changes must be an object of orbit.env settings.");
  const keys = Object.keys(raw);
  if (!keys.length) return bad("changes is empty.");
  if (keys.length > CONFIG_KEYS.length) return bad("Too many settings.");
  const out: ConfigChanges = {};
  for (const key of CONFIG_KEYS) {
    if (Object.hasOwn(raw, key)) out[key] = validateConfigValue(key, (raw as Record<string, unknown>)[key]);
  }
  for (const key of keys) if (!Object.hasOwn(out, key)) bad(`${redact(key).slice(0, 40)} is not a setting this action may change.`);
  return out;
}

// What a card, the ledger, an audit line or a result may show: sensitive values are reduced to names and counts.
export function displayConfig(changes: ConfigChanges): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const v = changes[key];
    if (v === undefined) continue;
    out[key] = key === "ORBIT_ROUTINES" ? v.split(",").map((e) => `${e.split("=")[0]}=trig_…${e.slice(-4)}`).join(",") : v;
  }
  return out;
}

export type AdminArgs = { changes?: ConfigChanges };

// SHA-256 over a canonical (key-sorted) form of the validated action and arguments. A confirmation names this digest, so what
// the owner confirmed is exactly what runs; any difference is refused.
export function digestOf(action: MutatingAction, args: AdminArgs): string {
  const changes = args.changes ? Object.fromEntries(CONFIG_KEYS.filter((k) => args.changes![k] !== undefined).map((k) => [k, args.changes![k]])) : undefined;
  return createHash("sha256").update(JSON.stringify({ action, changes: changes ?? null })).digest("hex");
}

// 40 hex characters, so it passes redaction like a commit id. Derived from the proposal id: the same confirmation always
// maps to the same operation, which the helper never runs twice.
export const OP_ID = /^[0-9a-f]{40}$/;
export function opIdFor(proposalId: string): string {
  return createHash("sha256").update(`orbit-ops-admin:${proposalId}`).digest("hex").slice(0, 40);
}

export type AdminRequest = { action: AdminAction; opId: string; changes?: ConfigChanges };

export function parseAdminRequest(raw: string): AdminRequest {
  if (Buffer.byteLength(raw) > ADMIN_MAX_REQUEST_BYTES) throw new OpsReject("request_too_large", `Request is larger than ${ADMIN_MAX_REQUEST_BYTES} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OpsReject("bad_request", "Request is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OpsReject("bad_request", "Request must be a JSON object.");
  const obj = value as Record<string, unknown>;
  if (typeof obj.action !== "string" || !Object.hasOwn(obj, "action")) throw new OpsReject("bad_request", "Request needs {action: string}.");
  if (!(ADMIN_ACTIONS as readonly string[]).includes(obj.action)) throw new OpsReject("unknown_action", "Unknown action.");
  const action = obj.action as AdminAction;
  const allowed = action === "apply_config" ? ["action", "opId", "changes"] : ["action", "opId"];
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new OpsReject("bad_arguments", `Unexpected argument for ${action}.`);
  if (typeof obj.opId !== "string" || !OP_ID.test(obj.opId)) throw new OpsReject("bad_arguments", "opId must be 40 lowercase hex characters.");
  if (action !== "apply_config") return { action, opId: obj.opId };
  if (!Object.hasOwn(obj, "changes")) throw new OpsReject("bad_arguments", "apply_config needs {changes}.");
  return { action, opId: obj.opId, changes: validateConfigChanges(obj.changes) };
}

// ---- operation records: one JSON file per operation under the helper's state directory ----

export const OP_STATES = ["accepted", "running", "verified", "no_change", "failed", "restored", "restore_failed", "interrupted"] as const;
export type OpState = (typeof OP_STATES)[number];
export const TERMINAL_STATES: readonly OpState[] = ["verified", "no_change", "failed", "restored", "restore_failed", "interrupted"];
export const isTerminal = (s: string): boolean => (TERMINAL_STATES as readonly string[]).includes(s);

export type OpStep = { at: string; step: string; detail: string };
export type OpRecord = {
  opId: string;
  action: MutatingAction;
  state: OpState;
  acceptedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  // The validated settings still to be applied. Removed when the operation ends (config values may include trigger ids).
  changes?: ConfigChanges;
  display?: Record<string, string>;
  steps: OpStep[];
  // Set only from what the runner itself observed after the change: never from dispatch or from a command's exit status alone.
  verification?: { checked: boolean; healthy?: boolean; expectedCommit?: string; servedCommit?: string; detail: string };
  summary?: string;
};

export type AdminResponse = { ok: true; action: AdminAction; data: unknown } | { ok: false; action?: string; error: { code: string; message: string } };

export const STEP_LIMIT = 40;
export const DETAIL_CHARS = 200;
export const SUMMARY_CHARS = 400;
export const cap = (text: string, n: number): string => {
  const clean = redact(text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim());
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
};
