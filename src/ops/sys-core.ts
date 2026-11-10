// Shared by the tier 3 front (sys-helper.ts) and the runners (sys-run.ts): configuration, the thin host interface the tests
// replace, and the operation-record store. Records live in a root-only directory; every write is a temp file plus rename.
// Nothing here talks to the host's own tailscaled: only the orbit-jobs node's socket is ever named (jobsSocket).
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, rmSync, mkdirSync, chmodSync, writeFileSync, linkSync, unlinkSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { writeAtomic, systemAdminEnv, type AdminEnv, type Exec } from "./admin-core.ts";
import { redactDeep } from "./protocol.ts";
import { DETAIL_CHARS, STEP_LIMIT, SYS_OP_ID, cap, isSysTerminal, type SysRecord } from "./sys-protocol.ts";

export { writeAtomic };

export type SysConfig = {
  root: string; // /opt/orbit
  stateDir: string; // /var/lib/orbit-ops-sys (persistent: survives a reboot, which is the point)
  units: { update: string; reboot: string; funnel: string; plan: string }; // template prefixes; the validated opId completes the instance name
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
  orphanMarkerAfterMs: number; // a retired/<holder> marker older than this, whose holder's record is terminal, is an orphan (see recoverOrphanedRetirement)
  fireSlotWaitMs: number; // a reboot that is due waits at most this long for the running-operation slot, then does not fire
  keepRecords: number;
};

export const SYS_CONFIG: SysConfig = {
  root: "/opt/orbit",
  stateDir: "/var/lib/orbit-ops-sys",
  units: { update: "orbit-ops-sys-update@", reboot: "orbit-ops-sys-reboot@", funnel: "orbit-ops-sys-funnel@", plan: "orbit-ops-sys-plan@" },
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
  orphanMarkerAfterMs: 10 * 60_000,
  fireSlotWaitMs: 2 * 60_000,
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

// ---- the operation slots ----
// Two lanes, both files in the persistent state directory holding an operation id (docs/orbit-ops-sys.md "Exclusivity matrix"):
//   main       `active`            the operation that is RUNNING or being accepted: update, plan, reboot, funnel
//   scheduled  `active-scheduled`  a reboot that is WAITING for its time. It is not running anything, so it does not take `main`
//                                  (that is what lets a Funnel change and a cancellation proceed meanwhile); it takes `main` itself
//                                  when it fires (sys-run.ts awaitSchedule).
// Ownership of a lane is a file holding the owner's op id. Two rules make every change of owner atomic:
//  1. It is created by link(2) of a fully written temp file: it appears whole or not at all (never empty to a reader), and link
//     fails if it already exists, so two requests cannot both get a free lane.
//  2. It is removed only by whoever first creates the one-time marker retired/<holder> (also exclusive; for the scheduled lane
//     retired/<holder>.scheduled). Only that one party may unlink a slot that holds <holder>; the slot cannot hold <holder> again
//     (op ids are never reused in a lane) and cannot be taken by anyone else while it exists, so the unlink can never remove a
//     replacement holder's slot, however requests interleave.
//  3. The unlink itself (removeIfHolder) runs under an exclusive claim recovering/<holder>, re-reads the slot and removes it only if
//     it STILL holds <holder>: the original retirer and a recoverer are serialised, so neither can delete a replacement.
// A process that dies between creating the marker and the unlink leaves an ORPHANED marker and the slot held (fail closed). That
// is recovered automatically, once the marker is older than orphanMarkerAfterMs and the holder's record is terminal
// (recoverOrphanedRetirement). The protocol and the safe age are documented in docs/orbit-ops-sys.md "Slot ownership".
export type Lane = "main" | "scheduled";
export const LANES: readonly Lane[] = ["main", "scheduled"];
export const retiredDir = (c: SysConfig) => `${c.stateDir}/retired`;
export const recoveringDir = (c: SysConfig) => `${c.stateDir}/recovering`;
export const lanePath = (c: SysConfig, lane: Lane) => (lane === "main" ? activePath(c) : `${c.stateDir}/active-scheduled`);
const suffix = (lane: Lane) => (lane === "main" ? "" : `.${lane}`);
export const markerPath = (c: SysConfig, holderId: string, lane: Lane = "main") => `${retiredDir(c)}/${holderId}${suffix(lane)}`;
const claimPath = (c: SysConfig, holderId: string, lane: Lane) => `${recoveringDir(c)}/${holderId}${suffix(lane)}`;

// Test seam (fakes only; unset in production): lets a test run code at exact points of the protocol, deterministically, e.g. a
// retirement and a takeover between a contender's read and its removal, or an injected failure. Not used by any production path.
export const slotHooks: { afterRead?: (lane: Lane, value: string | undefined) => void; beforeRemove?: (what: "slot" | "marker", path: string) => void } = {};

export const readSlot = (c: SysConfig, lane: Lane = "main"): string | undefined => {
  let v: string | undefined;
  try {
    v = readFileSync(lanePath(c, lane), "utf8").trim();
  } catch {
    v = undefined;
  }
  slotHooks.afterRead?.(lane, v);
  return v;
};

export function tryAcquireSlot(c: SysConfig, opId: string, lane: Lane = "main"): boolean {
  const tmp = `${c.stateDir}/active.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, opId, { mode: 0o600 });
  try {
    linkSync(tmp, lanePath(c, lane));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

type Removal = "removed" | "not_holder" | "claimed";
// The ONLY place a slot file is removed. The caller must be entitled to (it created the retirement marker, or it is recovering an
// orphaned one). It first takes the exclusive removal claim recovering/<holder>: while a claim is held nobody else removes this
// holder's slot, so the read-check-remove below cannot interleave with another remover, and a replacement holder (who can only
// take the slot after it is gone) is never deleted. The claim is released as soon as the removal is done.
function removeIfHolder(c: SysConfig, holderId: string, lane: Lane): Removal {
  mkdirSync(recoveringDir(c), { recursive: true, mode: 0o700 });
  const claim = claimPath(c, holderId, lane);
  try {
    writeFileSync(claim, "", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "claimed";
    throw err;
  }
  try {
    slotHooks.beforeRemove?.("slot", lanePath(c, lane));
    if (readSlot(c, lane) !== holderId) return "not_holder";
    rmSync(lanePath(c, lane), { force: true });
    return "removed";
  } finally {
    try {
      rmSync(claim, { force: true });
    } catch {
      // a claim left behind makes later removals answer "claimed" (fail closed); docs/orbit-ops-sys.md
    }
  }
}

// Remove the slot if (and only if) it still holds `holderId` and this caller is the one entitled to retire that holder. If the
// removal itself fails, the marker is taken back so a failure never leaves an orphaned marker behind (the slot stays held, which
// fails closed, and the next caller may retire it normally).
export function retireSlot(c: SysConfig, holderId: string, lane: Lane = "main"): boolean {
  if (readSlot(c, lane) !== holderId) return false;
  mkdirSync(retiredDir(c), { recursive: true, mode: 0o700 });
  const marker = markerPath(c, holderId, lane);
  try {
    writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; // someone else retired (or is retiring) this holder
    throw err;
  }
  try {
    return removeIfHolder(c, holderId, lane) !== "claimed"; // "claimed": a recoverer is finishing it and clears the marker
  } catch (err) {
    try {
      rmSync(marker, { force: true });
    } catch {
      // cannot take the marker back either: recoverOrphanedRetirement handles it once it is old enough
    }
    throw err;
  }
}

export type OrphanOutcome = "recovered" | "no_marker" | "young" | "no_record" | "nonterminal" | "claimed" | "ambiguous";

// Finish a retirement whose retirer died between creating retired/<holder> and removing the slot. ALL of these must hold, else it
// does nothing (and says why): the marker exists, is a regular file and is older than orphanMarkerAfterMs; the holder's record
// exists and is terminal; and the exclusive removal claim is won (removeIfHolder), so no other remover acts at the same time. The
// slot is removed only if it STILL holds that holder, so a newer holder is never deleted; the marker is then cleared. Missing,
// unreadable or odd state is "ambiguous"/"no_record": fail safe, nothing is touched.
export function recoverOrphanedRetirement(c: SysConfig, holderId: string, nowMs: number, lane: Lane = "main"): OrphanOutcome {
  if (!SYS_OP_ID.test(holderId)) return "ambiguous";
  const marker = markerPath(c, holderId, lane);
  let st;
  try {
    st = statSync(marker);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "no_marker" : "ambiguous";
  }
  if (!st.isFile()) return "ambiguous";
  const age = nowMs - st.mtimeMs;
  if (!Number.isFinite(age) || age < 0) return "ambiguous"; // a marker from the future: the clock or the file is not to be trusted
  if (age < c.orphanMarkerAfterMs) return "young";
  const rec = loadRecord(c, holderId);
  if (!rec) return "no_record";
  if (!isSysTerminal(rec.state)) return "nonterminal";
  if (removeIfHolder(c, holderId, lane) === "claimed") return "claimed";
  rmSync(marker, { force: true });
  return "recovered";
}

// A holder's own release when its operation ends (or is settled). A no-op in a lane that was already taken over. An operation can
// hold both lanes for a moment (a scheduled reboot hands over), so it releases whichever it holds.
export function releaseSlot(c: SysConfig, opId: string): void {
  for (const lane of LANES) retireSlot(c, opId, lane);
}

// A request that took a slot but fails before it recorded anything (refused, or any throw) gives it straight back, through the
// same marker protocol as every other removal: it never removes a slot that holds someone else, and a failed removal leaves no
// orphaned marker (retireSlot).
export function abandonSlot(c: SysConfig, opId: string): void {
  for (const lane of LANES) retireSlot(c, opId, lane);
}

export const slotAgeMs = (c: SysConfig, lane: Lane = "main"): number | undefined => {
  try {
    return Date.now() - statSync(lanePath(c, lane)).mtimeMs;
  } catch {
    return undefined;
  }
};

// ---- cancel versus fire: one arbiter ----
// decided/<opId> is created exclusively with "cancel" or "fire". Whoever creates it first decides; the other reads the answer.
// A scheduled reboot is only ever issued after "fire" was written by its runner, and only ever cancelled after "cancel" was written
// by the front, so a cancellation can never be reported as done after the reboot was dispatched, and vice versa.
export const decidedDir = (c: SysConfig) => `${c.stateDir}/decided`;
export type Decision = "cancel" | "fire";
export function decide(c: SysConfig, opId: string, want: Decision): { won: boolean; decision: Decision } {
  mkdirSync(decidedDir(c), { recursive: true, mode: 0o700 });
  const path = `${decidedDir(c)}/${opId}`;
  try {
    writeFileSync(path, want, { flag: "wx", mode: 0o600 });
    return { won: true, decision: want };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const got = readFileSync(path, "utf8").trim();
    return { won: false, decision: got === "cancel" ? "cancel" : "fire" };
  }
}
export const decisionOf = (c: SysConfig, opId: string): Decision | undefined => {
  try {
    const v = readFileSync(`${decidedDir(c)}/${opId}`, "utf8").trim();
    return v === "cancel" ? "cancel" : v === "fire" ? "fire" : undefined;
  } catch {
    return undefined;
  }
};

// ---- reboot cool-down ----
// Anchored on when a reboot was actually ISSUED (reboot.issuedAt, persisted before the command, plus a stamp file that survives
// record pruning), not on when a request was accepted: a request that never issued anything starts no cool-down.
export const rebootStampPath = (c: SysConfig) => `${c.stateDir}/last-reboot-issued`;
export function lastRebootIssuedMs(c: SysConfig): number | undefined {
  const times: number[] = [];
  for (const r of allRecords(c)) if (r.action === "reboot_host" && r.reboot?.issuedAt) times.push(Date.parse(r.reboot.issuedAt));
  try {
    times.push(Date.parse(readFileSync(rebootStampPath(c), "utf8").trim()));
  } catch {
    // no stamp
  }
  const ok = times.filter((t) => !Number.isNaN(t));
  return ok.length ? Math.max(...ok) : undefined;
}
// Milliseconds until a reboot at `atMs` would be outside the cool-down (0 = fine).
export function cooldownRemainingMs(c: SysConfig, atMs: number): number {
  const last = lastRebootIssuedMs(c);
  return last === undefined ? 0 : Math.max(0, last + c.rebootCooldownMs - atMs);
}

// Remove old finished records; never an unfinished one.
export function pruneRecords(c: SysConfig): void {
  const recs = allRecords(c);
  if (recs.length <= c.keepRecords) return;
  const old = recs.filter((r) => isSysTerminal(r.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const r of old.slice(0, Math.max(0, recs.length - c.keepRecords))) {
    rmSync(recordPath(c, r.opId), { force: true });
    // markers of a pruned record go with it, so an id that is ever used again is not blocked by a stale marker
    for (const lane of LANES) rmSync(markerPath(c, r.opId, lane), { force: true });
    rmSync(`${decidedDir(c)}/${r.opId}`, { force: true });
  }
}

// What leaves the helper about an operation: bounded and redacted.
export function publicRecord(rec: SysRecord): unknown {
  // Digests are 64 hex characters, which redaction would blank (it takes them for secrets), so a plan travels with a 24-character
  // key of its digest, like bootKey; the receiver recomputes the full digest from the plan itself and compares the key.
  const { plan, planDigest, ...rest } = rec;
  return redactDeep({
    ...rest,
    steps: rec.steps.slice(-12),
    ...(rec.summary ? { summary: cap(rec.summary, 500) } : {}),
    ...(plan ? { plan: { upgrades: plan.upgrades, flags: plan.flags, digestKey: plan.digest.slice(0, 24) } } : {}),
    ...(planDigest ? { planKey: planDigest.slice(0, 24) } : {}),
  });
}
