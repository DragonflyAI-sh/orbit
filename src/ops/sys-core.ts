// Shared by the tier 3 front (sys-helper.ts) and the runners (sys-run.ts): configuration, the thin host interface the tests
// replace, and the operation-record store. Records live in a root-only directory; every write is a temp file plus rename.
// Nothing here talks to the host's own tailscaled: only the orbit-jobs node's socket is ever named (jobsSocket).
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { writeAtomic, systemAdminEnv, type AdminEnv, type Exec } from "./admin-core.ts";
import { redactDeep } from "./protocol.ts";
import { DETAIL_CHARS, STEP_LIMIT, SYS_OP_ID, cap, isSysTerminal, type SysRecord } from "./sys-protocol.ts";

export { writeAtomic };

export type SysConfig = {
  root: string; // /opt/orbit
  stateDir: string; // /var/lib/orbit-ops-sys (persistent: survives a reboot, which is the point)
  units: { update: string; reboot: string; funnel: string }; // template prefixes; the validated opId completes the instance name
  bootIdFile: string; // /proc/sys/kernel/random/boot_id
  rebootRequiredFile: string; // /run/reboot-required
  jobsSocket: string; // the orbit-jobs tailscaled ONLY. The host's own tailscaled socket is never referenced by tier 3.
  healthWindowMs: number;
  healthIntervalMs: number;
  recoverWindowMs: number; // how long after a boot the recovery unit waits for ORBIT to be healthy
  rebootWaitMs: number; // how long the runner waits for the host to go down after the reboot command was accepted
  rebootGraceMs: number; // after this long without an observed reboot + verification, the front settles the record as unverified
  rebootCooldownMs: number; // no second reboot this soon after one was accepted
  lockWaitSeconds: number;
  staleAfterMs: number;
  keepRecords: number;
};

export const SYS_CONFIG: SysConfig = {
  root: "/opt/orbit",
  stateDir: "/var/lib/orbit-ops-sys",
  units: { update: "orbit-ops-sys-update@", reboot: "orbit-ops-sys-reboot@", funnel: "orbit-ops-sys-funnel@" },
  bootIdFile: "/proc/sys/kernel/random/boot_id",
  rebootRequiredFile: "/run/reboot-required",
  jobsSocket: "/run/orbit-tailscale-jobs/tailscaled.sock",
  healthWindowMs: 60_000,
  healthIntervalMs: 2_000,
  recoverWindowMs: 300_000,
  rebootWaitMs: 180_000,
  rebootGraceMs: 15 * 60_000,
  rebootCooldownMs: 30 * 60_000,
  lockWaitSeconds: 300,
  staleAfterMs: 30_000,
  keepRecords: 50,
};

export type ExecOpts = { env?: Record<string, string>; noKill?: boolean; maxBuffer?: number };

// Everything tier 3 does to the host besides reading and writing files goes through this. Every command is a fixed absolute path
// with fixed arguments (see sys-run.ts); the only variable tokens are a validated port and a validated orbit-jobs name.
export type SysEnv = Omit<AdminEnv, "exec"> & {
  // noKill: the timeout is not enforced by killing the child. Package managers are never killed by this code.
  exec(file: string, args: string[], timeoutMs: number, opts?: ExecOpts): Promise<Exec>;
  hostname(): string;
};

const MAX_OUT = 64 * 1024;

export const systemSysEnv: SysEnv = {
  ...systemAdminEnv,
  hostname: () => hostname().toLowerCase(),
  exec: (file, args, timeoutMs, opts) =>
    new Promise((resolve) => {
      execFile(
        file,
        args,
        { ...(opts?.noKill ? {} : { timeout: timeoutMs }), maxBuffer: opts?.maxBuffer ?? MAX_OUT, shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...(opts?.env ?? {}) } },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(e?.killed) });
        },
      );
    }),
};

// ---- operation records ----

export const opsDir = (c: SysConfig) => `${c.stateDir}/ops`;
export const recordPath = (c: SysConfig, opId: string) => `${opsDir(c)}/${opId}.json`;
export const activePath = (c: SysConfig) => `${c.stateDir}/active`;

export function ensureDirs(c: SysConfig): void {
  mkdirSync(opsDir(c), { recursive: true, mode: 0o700 });
  chmodSync(c.stateDir, 0o700);
}

export function loadRecord(c: SysConfig, opId: string): SysRecord | undefined {
  if (!SYS_OP_ID.test(opId)) return undefined;
  try {
    const v = JSON.parse(readFileSync(recordPath(c, opId), "utf8")) as SysRecord;
    return v && typeof v === "object" && v.opId === opId ? v : undefined;
  } catch {
    return undefined;
  }
}

export function allRecords(c: SysConfig): SysRecord[] {
  try {
    return readdirSync(opsDir(c))
      .filter((n) => /^[0-9a-f]{40}\.json$/.test(n))
      .map((n) => loadRecord(c, n.slice(0, 40)))
      .filter((r): r is SysRecord => Boolean(r));
  } catch {
    return [];
  }
}

export function saveRecord(c: SysConfig, rec: SysRecord, env: Pick<SysEnv, "now">): void {
  rec.updatedAt = env.now().toISOString();
  writeAtomic(recordPath(c, rec.opId), JSON.stringify(rec, null, 2));
}

// Append a capped, redacted step. The journal gets the same line, so every step of every request is audited.
export function addStep(c: SysConfig, rec: SysRecord, env: Pick<SysEnv, "now">, step: string, detail: string, audit: (line: object) => void): void {
  const s = { at: env.now().toISOString(), step: cap(step, 40), detail: cap(detail, DETAIL_CHARS) };
  if (rec.steps.length < STEP_LIMIT) rec.steps.push(s);
  else rec.steps[STEP_LIMIT - 1] = { ...s, detail: `${s.detail} (earlier steps dropped)`.slice(0, DETAIL_CHARS) };
  saveRecord(c, rec, env);
  audit({ at: s.at, opId: rec.opId.slice(0, 12), action: rec.action, step: s.step, detail: s.detail });
}

export function releaseSlot(c: SysConfig, opId: string): void {
  try {
    if (readFileSync(activePath(c), "utf8").trim() === opId) rmSync(activePath(c), { force: true });
  } catch {
    // no slot
  }
}

// Remove old finished records; never an unfinished one.
export function pruneRecords(c: SysConfig): void {
  const recs = allRecords(c);
  if (recs.length <= c.keepRecords) return;
  const old = recs.filter((r) => isSysTerminal(r.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const r of old.slice(0, Math.max(0, recs.length - c.keepRecords))) rmSync(recordPath(c, r.opId), { force: true });
}

// What leaves the helper about an operation: bounded and redacted.
export function publicRecord(rec: SysRecord): unknown {
  return redactDeep({ ...rec, steps: rec.steps.slice(-12), ...(rec.summary ? { summary: cap(rec.summary, 500) } : {}) });
}
