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
// plan_os_updates refreshes apt metadata and simulates the upgrade (no package is installed or changed); cancel_reboot withdraws a
// reboot that has not fired. Neither carries a digest: the first is a read of the package plan, the second can only prevent a change.
export const SYS_OTHER_ACTIONS = ["plan_os_updates", "cancel_reboot"] as const;
export const SYS_ACTIONS = [...SYS_MUTATING_ACTIONS, ...SYS_OTHER_ACTIONS, "sys_status", "op_status"] as const;
export type SysRecordAction = SysMutatingAction | "plan_os_updates";
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
// An OS update also binds the digest of the full package plan the owner saw; a reboot scheduled for later binds that time. A reboot
// "now" keeps the original form. The digest binds the request to what the card showed. It does NOT prove that the owner clicked:
// it is a hash of public values, and membership of the orbit-ops group is the trust boundary (same as tier 2; docs/orbit-ops-sys.md).
export type DigestBind = { planDigest?: string; rebootAt?: string };
export function sysDigestOf(action: SysMutatingAction, target: SysTarget, bind: DigestBind = {}): string {
  const t = isFunnelAction(action) ? { host: (target as FunnelTarget).host, port: (target as FunnelTarget).port } : { host: (target as HostTarget).host };
  const extra = action === "install_os_updates" ? { planDigest: bind.planDigest ?? null } : action === "reboot_host" && bind.rebootAt ? { rebootAt: bind.rebootAt } : {};
  return createHash("sha256").update(JSON.stringify({ tier: 3, action, target: t, ...extra })).digest("hex");
}

// ---- reboot scheduling ----
export const REBOOT_MIN_LEAD_MS = 60_000; // the helper refuses a time closer than this at acceptance (omit the time for "now")
export const REBOOT_PROPOSE_MIN_LEAD_MS = 120_000; // ORBIT asks for more, so the owner has time to read and confirm
export const REBOOT_MAX_AHEAD_MS = 24 * 3600_000;
export const CANON_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Canonical UTC form only (so one time has one digest). Returns the problem, or undefined when acceptable.
export function rebootAtProblem(at: string, nowMs: number, minLeadMs = REBOOT_MIN_LEAD_MS): string | undefined {
  if (!CANON_ISO.test(at) || Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) return "The reboot time must be UTC in the form YYYY-MM-DDTHH:MM:SS.sssZ.";
  const ahead = Date.parse(at) - nowMs;
  if (ahead < minLeadMs) return `The reboot time must be at least ${Math.round(minLeadMs / 1000)} seconds in the future (omit it to reboot now).`;
  if (ahead > REBOOT_MAX_AHEAD_MS) return "The reboot time must be no more than 24 hours ahead.";
  return undefined;
}

// ---- OS update plan ----
// One upgrade: [package, installed version, version it would become]. The whole list, sorted by package name, is what the owner
// confirms (as planDigest) and what the runner recomputes before it upgrades anything.
export type PlanEntry = [string, string, string];
// Plan timing, in ONE place so the runner and ORBIT cannot drift apart (finding 5). These are the per-step limits the plan runner
// passes to its commands; apt-get is never killed (noKill), so they are nominal: they say how long the runner is EXPECTED to take,
// not a guarantee that it stops. ORBIT therefore waits at least PLAN_RUNNER_MAX_MS (plus a margin) and, if it still gives up, says
// the plan is still running instead of implying that giving up stopped it. See docs/orbit-ops-sys.md "Plan timeouts".
export const PLAN_AUDIT_LIMIT_MS = 60_000; // dpkg --audit
export const PLAN_REFRESH_LIMIT_MS = 600_000; // apt-get update
export const PLAN_SIMULATE_LIMIT_MS = 120_000; // apt-get -s upgrade
export const PLAN_APT_LOCK_WAIT_MS = 120_000; // -o DPkg::Lock::Timeout=120, applied to each of the two apt-get commands
export const PLAN_RUNNER_MAX_MS = PLAN_AUDIT_LIMIT_MS + PLAN_REFRESH_LIMIT_MS + PLAN_SIMULATE_LIMIT_MS + 2 * PLAN_APT_LOCK_WAIT_MS;
export const PLAN_WAIT_MARGIN_MS = 60_000;
export const PLAN_WAIT_MS = PLAN_RUNNER_MAX_MS + PLAN_WAIT_MARGIN_MS; // how long ORBIT waits for a plan: never less than the runner may run
export const MAX_PLAN_PACKAGES = 150; // keeps a plan inside the helper's response limit; a bigger backlog is refused, not truncated
const PKG = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9-]+)?$/;
const VER = /^[A-Za-z0-9][A-Za-z0-9.+~:_-]*$/;
export const validPlanEntry = (e: unknown): e is PlanEntry =>
  Array.isArray(e) && e.length === 3 && e.every((x) => typeof x === "string") && PKG.test(e[0]) && VER.test(e[1]) && VER.test(e[2]) && e[0].length < 100 && e[1].length < 100 && e[2].length < 100;
export const sortPlan = (p: PlanEntry[]): PlanEntry[] => [...p].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
export const planDigestOf = (p: PlanEntry[]): string => createHash("sha256").update(JSON.stringify({ v: 1, upgrades: sortPlan(p) })).digest("hex");
export const PLAN_FLAGS = [
  ["kernel", /^linux-(image|modules|modules-extra|headers|generic|virtual|lowlatency|aws|azure|gcp|oracle|kvm|tools|cloud-tools)(-|$)/],
  ["libc", /^(libc6|libc-bin|libc-dev-bin|libc6-dev)(:|$)/],
  ["systemd", /^(systemd|libsystemd[0-9]*|udev|libudev[0-9]*)(-|:|$)/],
  ["openssh", /^openssh-(server|client|sftp-server)$/],
  ["tailscale", /^tailscale(d)?$/],
] as const;
export type PlanFlags = Record<(typeof PLAN_FLAGS)[number][0], string[]>;
export function flagPlan(p: PlanEntry[]): PlanFlags {
  const out = { kernel: [], libc: [], systemd: [], openssh: [], tailscale: [] } as PlanFlags;
  for (const [name] of p) for (const [k, re] of PLAN_FLAGS) if (re.test(name)) out[k].push(name);
  return out;
}
export const planFlagged = (f: PlanFlags): boolean => Object.values(f).some((l) => l.length > 0);

// `apt-get -s upgrade` (LC_ALL=C). Any line that looks like a package action but does not parse, a missing or inconsistent summary
// line, or an unsupported action makes the whole plan INVALID: nothing is guessed or skipped.
export type ParsedPlan = { ok: true; upgrades: PlanEntry[] } | { ok: false; problem: string; removals: string[]; newInstalls: string[] };
export function parsePlan(out: string): ParsedPlan {
  const upgrades: PlanEntry[] = [];
  const removals: string[] = [];
  const newInstalls: string[] = [];
  let summary: { up: number; add: number; rem: number } | undefined;
  for (const line of out.split("\n")) {
    if (/^Remv /.test(line)) {
      removals.push(line.split(" ")[1] ?? "?");
      continue;
    }
    if (/^(Purg|Inst|Conf) /.test(line)) {
      const inst = /^Inst (\S+) \[([^\]\s]+)\] \(([^\s)]+)[ )]/.exec(line);
      const fresh = /^Inst (\S+) \(([^\s)]+)[ )]/.exec(line);
      if (/^Inst /.test(line) && inst) {
        const e: PlanEntry = [inst[1]!, inst[2]!, inst[3]!];
        if (!validPlanEntry(e)) return { ok: false, problem: "a package name or version in the simulation is not in a recognised form", removals, newInstalls };
        upgrades.push(e);
      } else if (/^Inst /.test(line) && fresh) newInstalls.push(fresh[1]!);
      else if (/^Inst /.test(line) || /^Purg /.test(line)) return { ok: false, problem: "a line of the simulation could not be understood", removals, newInstalls };
      continue; // Conf lines repeat Inst lines
    }
    const m = /^(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded\.$/.exec(line.trim());
    if (m) summary = { up: Number(m[1]), add: Number(m[2]), rem: Number(m[3]) };
  }
  if (!summary) return { ok: false, problem: "the simulation had no summary line (output cut off or in an unexpected form)", removals, newInstalls };
  if (summary.up !== upgrades.length || summary.add !== newInstalls.length || summary.rem !== removals.length) {
    return { ok: false, problem: `the simulation's summary (${summary.up} upgraded, ${summary.add} new, ${summary.rem} removed) disagrees with its own package lines`, removals, newInstalls };
  }
  if (removals.length || newInstalls.length) return { ok: false, problem: "the simulation would remove or newly install packages", removals, newInstalls };
  if (new Set(upgrades.map((e) => e[0])).size !== upgrades.length) return { ok: false, problem: "the simulation lists a package twice", removals, newInstalls };
  return { ok: true, upgrades: sortPlan(upgrades) };
}

export const SYS_OP_ID = /^[0-9a-f]{40}$/;
// Derived from the proposal id: the same confirmation always maps to the same operation, which the helper never runs twice.
export function sysOpIdFor(proposalId: string): string {
  return createHash("sha256").update(`orbit-ops-sys:${proposalId}`).digest("hex").slice(0, 40);
}

export type SysRequest =
  | { action: "sys_status" }
  | { action: "op_status"; opId: string }
  | { action: "plan_os_updates"; opId: string }
  | { action: "cancel_reboot"; opId: string }
  | { action: SysMutatingAction; opId: string; target: SysTarget; digest: string; expiresAt: string; planDigest?: string; rebootAt?: string };

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
  const base = ["action", "opId", "target", "digest", "expiresAt"];
  const allowed = action === "sys_status" ? ["action"] : action === "op_status" || action === "plan_os_updates" || action === "cancel_reboot" ? ["action", "opId"] : action === "install_os_updates" ? [...base, "planDigest"] : action === "reboot_host" ? [...base, "rebootAt"] : base;
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new OpsReject("bad_arguments", `Unexpected argument for ${action}.`);
  if (action === "sys_status") return { action };
  if (typeof obj.opId !== "string" || !SYS_OP_ID.test(obj.opId)) throw new OpsReject("bad_arguments", "opId must be 40 lowercase hex characters.");
  if (action === "op_status" || action === "plan_os_updates" || action === "cancel_reboot") return { action, opId: obj.opId };
  for (const k of ["target", "digest", "expiresAt"]) if (!Object.hasOwn(obj, k)) throw new OpsReject("bad_arguments", `${action} needs {${k}}.`);
  if (typeof obj.digest !== "string" || !DIGEST.test(obj.digest)) throw new OpsReject("bad_arguments", "digest must be 64 lowercase hex characters.");
  if (typeof obj.expiresAt !== "string" || !ISO.test(obj.expiresAt) || Number.isNaN(Date.parse(obj.expiresAt))) throw new OpsReject("bad_arguments", "expiresAt must be an ISO-8601 UTC time.");
  const target = validateTarget(action, obj.target);
  let planDigest: string | undefined;
  let rebootAt: string | undefined;
  if (action === "install_os_updates") {
    if (typeof obj.planDigest !== "string" || !DIGEST.test(obj.planDigest)) throw new OpsReject("bad_arguments", "install_os_updates needs {planDigest}: the digest of the package plan that was confirmed (ask for a plan first).");
    planDigest = obj.planDigest;
  }
  if (action === "reboot_host" && Object.hasOwn(obj, "rebootAt")) {
    if (typeof obj.rebootAt !== "string" || !CANON_ISO.test(obj.rebootAt) || new Date(obj.rebootAt).toISOString() !== obj.rebootAt) throw new OpsReject("bad_arguments", "rebootAt must be a canonical UTC time (YYYY-MM-DDTHH:MM:SS.sssZ).");
    rebootAt = obj.rebootAt;
  }
  if (sysDigestOf(action, target, { ...(planDigest ? { planDigest } : {}), ...(rebootAt ? { rebootAt } : {}) }) !== obj.digest) throw new OpsReject("digest_mismatch", "The digest does not match the action and target: this is not what was confirmed.");
  return { action, opId: obj.opId, target, digest: obj.digest, expiresAt: obj.expiresAt, ...(planDigest ? { planDigest } : {}), ...(rebootAt ? { rebootAt } : {}) };
}

// ---- operation records ----

// accepted: validated and recorded, nothing done. running: the runner is working. rebooting: the reboot command was issued and the
// outcome is not known yet (only a changed boot id plus a healthy ORBIT after the boot makes it verified).
// verified: the runner itself observed the intended result. no_change: already in the wanted state. failed: it did not work or
// was refused. unverified: the command ran but nothing could confirm the result. interrupted: the runner vanished mid-way.
// scheduled: a reboot accepted for a later time, nothing issued yet (cancellable). cancelled: withdrawn before it fired; nothing was issued.
export const SYS_STATES = ["accepted", "scheduled", "running", "rebooting", "verified", "no_change", "failed", "unverified", "interrupted", "cancelled"] as const;
export type SysState = (typeof SYS_STATES)[number];
export const SYS_TERMINAL: readonly SysState[] = ["verified", "no_change", "failed", "unverified", "interrupted", "cancelled"];
export const isSysTerminal = (s: string): boolean => (SYS_TERMINAL as readonly string[]).includes(s);

export type SysStep = { at: string; step: string; detail: string };
export type SysEvidence = Record<string, string | number | boolean | null>;
export type SysRecord = {
  opId: string;
  action: SysRecordAction;
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
  // A reboot for later: the confirmed time. An OS update: the digest of the confirmed plan; a plan operation: the plan it obtained.
  schedule?: { at: string; bootKey?: string };
  planDigest?: string;
  plan?: { upgrades: PlanEntry[]; digest: string; flags: PlanFlags };
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
