// Shared by the tier 3 privileged helper (sys-helper.ts, sys-run.ts) and ORBIT's client (../ops-sys*.ts). Tier 3: three fixed,
// separately confirmed host operations. Nothing here ever becomes a command: the only caller-supplied values that reach the host
// are a validated host name, a validated orbit-jobs name, a port, a digest, an expiry and an operation id, and each of them is
// compared with what the privileged side itself finds before anything changes.
import { createHash } from "node:crypto";
import { OpsReject, redact } from "./protocol.ts";

export { OpsReject, redact };

export const SYS_SOCKET_PATH = "/run/orbit-ops-sys.sock";
export const SYS_MAX_REQUEST_BYTES = 2048;
export const SYS_MAX_RESPONSE_BYTES = 16 * 1024;
// A request is only honoured for this long after the owner confirmed it, and never for longer than the bound below, whatever
// the request says: the privileged side enforces expiry, not just chat.
export const SYS_CONFIRM_TTL_MS = 10 * 60 * 1000;
export const SYS_MAX_TTL_MS = 15 * 60 * 1000;

export const SYS_MUTATING_ACTIONS = ["install_os_updates", "reboot_host", "funnel_enable", "funnel_disable"] as const;
export const SYS_ACTIONS = [...SYS_MUTATING_ACTIONS, "sys_status", "op_status"] as const;
export type SysMutatingAction = (typeof SYS_MUTATING_ACTIONS)[number];
export type SysAction = (typeof SYS_ACTIONS)[number];
export const isFunnelAction = (a: string): a is "funnel_enable" | "funnel_disable" => a === "funnel_enable" || a === "funnel_disable";

// ---- targets: the exact thing the owner confirmed ----

// install_os_updates and reboot_host name the host (the helper's own host name); a funnel action names the orbit-jobs node and the
// local port its Funnel must point at. The helper refuses any difference from what it finds on the host.
export type HostTarget = { host: string };
export type FunnelTarget = { host: string; port: number };
export type SysTarget = HostTarget | FunnelTarget;

export const JOBS_NODE = "orbit-jobs";
export const FUNNEL_HTTPS_PORT = 443; // fixed: the existing Funnel is https=443; it is not an argument
export const FUNNEL_PORT_MIN = 1024;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TS_HOST = /^orbit-jobs\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;

const bad = (message: string): never => {
  throw new OpsReject("bad_arguments", message);
};

export function validateHostTarget(raw: unknown): HostTarget {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("target must be {host}.");
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "host") return bad("target must be exactly {host}.");
  const host = (raw as Record<string, unknown>).host;
  if (typeof host !== "string" || !HOST_LABEL.test(host)) return bad("target.host must be a plain host name (lowercase letters, digits, dashes).");
  return { host };
}

export function validateFunnelTarget(raw: unknown): FunnelTarget {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("target must be {host, port}.");
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== "host" || keys[1] !== "port") return bad("target must be exactly {host, port}.");
  const { host, port } = raw as Record<string, unknown>;
  if (typeof host !== "string" || host.length > 253 || !TS_HOST.test(host)) return bad(`target.host must be ${JOBS_NODE}.<tailnet>.ts.net: this action only ever acts on the ${JOBS_NODE} node.`);
  if (typeof port !== "number" || !Number.isInteger(port) || port < FUNNEL_PORT_MIN || port > 65535) return bad(`target.port must be a whole number from ${FUNNEL_PORT_MIN} to 65535.`);
  return { host, port };
}

export function validateTarget(action: SysMutatingAction, raw: unknown): SysTarget {
  return isFunnelAction(action) ? validateFunnelTarget(raw) : validateHostTarget(raw);
}

// SHA-256 over a canonical (fixed key order) form of the validated action and target. The owner's confirmation names this digest
// and the privileged side recomputes it, so what is recorded is exactly what was confirmed.
export function sysDigestOf(action: SysMutatingAction, target: SysTarget): string {
  const t = isFunnelAction(action) ? { host: (target as FunnelTarget).host, port: (target as FunnelTarget).port } : { host: (target as HostTarget).host };
  return createHash("sha256").update(JSON.stringify({ tier: 3, action, target: t })).digest("hex");
}

export const SYS_OP_ID = /^[0-9a-f]{40}$/;
// Derived from the proposal id: the same confirmation always maps to the same operation, which the helper never runs twice.
export function sysOpIdFor(proposalId: string): string {
  return createHash("sha256").update(`orbit-ops-sys:${proposalId}`).digest("hex").slice(0, 40);
}

export type SysRequest =
  | { action: "sys_status" }
  | { action: "op_status"; opId: string }
  | { action: SysMutatingAction; opId: string; target: SysTarget; digest: string; expiresAt: string };

const DIGEST = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function parseSysRequest(raw: string): SysRequest {
  if (Buffer.byteLength(raw) > SYS_MAX_REQUEST_BYTES) throw new OpsReject("request_too_large", `Request is larger than ${SYS_MAX_REQUEST_BYTES} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OpsReject("bad_request", "Request is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OpsReject("bad_request", "Request must be a JSON object.");
  const obj = value as Record<string, unknown>;
  if (typeof obj.action !== "string" || !Object.hasOwn(obj, "action")) throw new OpsReject("bad_request", "Request needs {action: string}.");
  if (!(SYS_ACTIONS as readonly string[]).includes(obj.action)) throw new OpsReject("unknown_action", "Unknown action.");
  const action = obj.action as SysAction;
  const allowed = action === "sys_status" ? ["action"] : action === "op_status" ? ["action", "opId"] : ["action", "opId", "target", "digest", "expiresAt"];
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new OpsReject("bad_arguments", `Unexpected argument for ${action}.`);
  if (action === "sys_status") return { action };
  if (typeof obj.opId !== "string" || !SYS_OP_ID.test(obj.opId)) throw new OpsReject("bad_arguments", "opId must be 40 lowercase hex characters.");
  if (action === "op_status") return { action, opId: obj.opId };
  for (const k of ["target", "digest", "expiresAt"]) if (!Object.hasOwn(obj, k)) throw new OpsReject("bad_arguments", `${action} needs {${k}}.`);
  if (typeof obj.digest !== "string" || !DIGEST.test(obj.digest)) throw new OpsReject("bad_arguments", "digest must be 64 lowercase hex characters.");
  if (typeof obj.expiresAt !== "string" || !ISO.test(obj.expiresAt) || Number.isNaN(Date.parse(obj.expiresAt))) throw new OpsReject("bad_arguments", "expiresAt must be an ISO-8601 UTC time.");
  const target = validateTarget(action, obj.target);
  if (sysDigestOf(action, target) !== obj.digest) throw new OpsReject("digest_mismatch", "The digest does not match the action and target: this is not what was confirmed.");
  return { action, opId: obj.opId, target, digest: obj.digest, expiresAt: obj.expiresAt };
}

// ---- operation records ----

// accepted: validated and recorded, nothing done. running: the runner is working. rebooting: the reboot command was issued and the
// outcome is not known yet (only a changed boot id plus a healthy ORBIT after the boot makes it verified).
// verified: the runner itself observed the intended result. no_change: already in the wanted state. failed: it did not work or
// was refused. unverified: the command ran but nothing could confirm the result. interrupted: the runner vanished mid-way.
export const SYS_STATES = ["accepted", "running", "rebooting", "verified", "no_change", "failed", "unverified", "interrupted"] as const;
export type SysState = (typeof SYS_STATES)[number];
export const SYS_TERMINAL: readonly SysState[] = ["verified", "no_change", "failed", "unverified", "interrupted"];
export const isSysTerminal = (s: string): boolean => (SYS_TERMINAL as readonly string[]).includes(s);

export type SysStep = { at: string; step: string; detail: string };
export type SysEvidence = Record<string, string | number | boolean | null>;
export type SysRecord = {
  opId: string;
  action: SysMutatingAction;
  state: SysState;
  acceptedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  target: SysTarget;
  digest: string;
  expiresAt: string;
  // Persisted BEFORE the reboot command is issued, so a recovery after the host comes back can compare.
  // Boot ids are kept as a short digest (bootKey), never raw: it is evidence for comparison, and a raw id looks like a secret to redaction.
  reboot?: { preBootKey: string; issuedAt: string; expectedCommit?: string; postBootKey?: string };
  steps: SysStep[];
  // Set only from what the runner itself observed. A command's exit status or "dispatched" is never verification.
  verification?: { checked: boolean; healthy?: boolean; detail: string; evidence?: SysEvidence };
  summary?: string;
};

export type SysResponse = { ok: true; action: SysAction; data: unknown } | { ok: false; action?: string; error: { code: string; message: string } };

export const STEP_LIMIT = 40;
export const DETAIL_CHARS = 200;
export const SUMMARY_CHARS = 500;
export const cap = (text: string, n: number): string => {
  const clean = redact(text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim());
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
};

// A boot id (a UUID) reduced to 24 hex characters: enough to tell two boots apart, short enough to survive redaction.
export const bootKey = (bootId: string): string => createHash("sha256").update(bootId).digest("hex").slice(0, 24);
