// orbit-ops-sys-run: the runner for ONE accepted tier 3 operation (orbit-ops-sys-update@<opId>.service, -reboot@, -funnel@) and the
// boot-time recovery (orbit-ops-sys-recover.service). Separate systemd units, so they keep running while ORBIT restarts. A runner
// loads the validated record the front wrote, re-checks it against the host, does exactly that action with fixed commands, and
// verifies the outcome itself before it writes a terminal state. A command's exit status or "dispatched" is never verification.
//
// Hard rules, each pinned by a test:
//   - no command here is built from request text: files and arguments are fixed; the only variable tokens are a port and the
//     orbit-jobs name, both validated and both cross-checked against orbit.env and the live node;
//   - OS updates run `apt-get upgrade` only (never dist-upgrade/full-upgrade/autoremove/remove). They run only the exact package
//     plan the owner confirmed (recomputed here with `apt-get -s upgrade` and compared by digest; a different plan is refused),
//     refuse when the simulation would remove or newly install anything, never reboot, and never kill or unlock a package manager.
//     This tool itself restarts no service and needrestart is suspended, BUT package maintainer scripts (openssh, tailscale, libc,
//     systemd and others) may restart daemons on their own, and this code cannot prevent that;
//   - a plan (plan_os_updates) runs `apt-get update` (which REFRESHES apt metadata: it is not literally read-only) and then
//     `apt-get -s upgrade`; neither step installs or upgrades a package;
//   - a reboot is the only code that calls `systemctl reboot`, once, after the pre-reboot state is persisted and only after it won
//     the "fire" decision against any cancellation (sys-core.ts decide); a scheduled one waits first WITHOUT holding the deploy lock;
//   - Funnel is only ever changed through the orbit-jobs socket. The host's own tailscaled is never named.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import {
  MAX_PLAN_PACKAGES,
  flagPlan,
  parsePlan,
  planDigestOf,
  planFlagged,
  type PlanEntry,
} from "./sys-protocol.ts";
import { fileURLToPath } from "node:url";
import { validateConfigValue } from "./admin-protocol.ts";
import {
  FUNNEL_HTTPS_PORT,
  JOBS_NODE,
  SYS_OP_ID,
  bootKey,
  cap,
  isSysTerminal,
  type FunnelTarget,
  type HostTarget,
  type SysEvidence,
  type SysRecord,
} from "./sys-protocol.ts";
import { SYS_CONFIG, addStep, cooldownRemainingMs, decide, decisionOf, loadRecord, allRecords, rebootStampPath, releaseSlot, saveRecord, systemSysEnv, writeAtomic, type SysConfig, type SysEnv } from "./sys-core.ts";

const SYSTEMCTL = "/usr/bin/systemctl";
const APT_GET = "/usr/bin/apt-get";
const DPKG = "/usr/bin/dpkg";
const DPKG_QUERY = "/usr/bin/dpkg-query";
const TAILSCALE = "/usr/bin/tailscale";
const SHA = /^[0-9a-f]{40}$/;
type Audit = (line: object) => void;
type Ctx = { env: SysEnv; c: SysConfig; rec: SysRecord; audit: Audit };

const step = (x: Ctx, name: string, detail: string) => addStep(x.c, x.rec, x.env, name, detail, x.audit);
const lastLines = (text: string, n = 3) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).map((l) => cap(l, 160)).join(" | ");
const safeRead = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

function finish(x: Ctx, state: SysRecord["state"], summary: string, v: NonNullable<SysRecord["verification"]>): void {
  x.rec.state = state;
  x.rec.summary = cap(summary, 500);
  x.rec.verification = { ...v, detail: cap(v.detail, 200) };
}

const readBootKey = (c: SysConfig): string => {
  const id = safeRead(c.bootIdFile).trim();
  return id ? bootKey(id) : "";
};

function currentCommit(c: SysConfig): string | undefined {
  const v = safeRead(`${c.root}/current/COMMIT`).trim();
  return SHA.test(v) ? v : undefined;
}

// HOST and PORT, to reach /status. Nothing else is interpreted for this purpose.
function statusAddress(text: string): { host: string; port: number } | undefined {
  const get = (k: string) => new RegExp(`^${k}=([^\\s"'$\`\\\;]+)\\s*$`, "m").exec(text)?.[1];
  const h = get("HOST");
  const p = get("PORT");
  if (!h || !p || !/^[0-9]{1,5}$/.test(p) || !/^[A-Za-z0-9.:-]{1,253}$/.test(h)) return undefined;
  return { host: h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h, port: Number(p) };
}

function readOrbitEnv(c: SysConfig): string | undefined {
  const path = `${c.root}/orbit.env`;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

type Health = { healthy: boolean; served?: string; detail: string };
async function waitHealthy(env: SysEnv, c: SysConfig, windowMs: number, expected: string): Promise<Health> {
  const text = readOrbitEnv(c);
  const address = text ? statusAddress(text) : undefined;
  if (!address) return { healthy: false, detail: "HOST and PORT could not be read from orbit.env, so /status could not be checked." };
  const deadline = env.now().getTime() + windowMs;
  let served: string | undefined;
  let reached = false;
  for (;;) {
    const p = await env.probe(address.host, address.port, "/status");
    reached = reached || p.reachable;
    served = p.commit ?? served;
    if (p.reachable && p.httpStatus === 200 && p.commit === expected) return { healthy: true, served: p.commit, detail: `/status served ${p.commit.slice(0, 12)}.` };
    if (env.now().getTime() >= deadline) break;
    await env.sleep(c.healthIntervalMs);
  }
  const why = !reached ? "/status never answered" : `/status served ${served ? served.slice(0, 12) : "no commit"}, expected ${expected.slice(0, 12)}`;
  return { healthy: false, ...(served ? { servedCommit: served } : {}), detail: `${why} within ${Math.round(windowMs / 1000)}s.` } as Health;
}

// ================================================================= OS updates

// The whole update policy, in one place. `apt-get upgrade` upgrades installed packages to newer versions and, by its own
// definition, never removes a package or installs a new one. We do not rely on that alone: the simulation must agree first, and
// the package list is compared afterwards.
export const UPDATE_POLICY = {
  command: "apt-get upgrade",
  neverRuns: ["dist-upgrade", "full-upgrade", "autoremove", "remove", "purge", "reboot", "needrestart", "do-release-upgrade"],
} as const;

const APT_ENV = { DEBIAN_FRONTEND: "noninteractive", APT_LISTCHANGES_FRONTEND: "none", NEEDRESTART_SUSPEND: "1", NEEDRESTART_MODE: "l", LC_ALL: "C" };
const LOCK_TEXT = /Could not get lock|Unable to acquire the dpkg|Unable to lock|is held by process|dpkg frontend lock|Waiting for cache lock/i;
const APT_BASE = ["-o", "DPkg::Lock::Timeout=120"];

const DPKG_FORMAT = "-f=${db:Status-Abbrev} ${binary:Package} ${Version}\\n";
const bare = (n: string) => n.replace(/:[a-z0-9-]+$/, "");
// package (without :arch) -> versions installed, from `dpkg-query` lines "ii name[:arch] version".
const installedVersions = (out: string): Map<string, Set<string>> => {
  const m = new Map<string, Set<string>>();
  for (const l of out.split("\n")) {
    const f = /^ii (\S+) (\S+)\s*$/.exec(l);
    if (f) m.set(bare(f[1]!), (m.get(bare(f[1]!)) ?? new Set()).add(f[2]!));
  }
  return m;
};
const names = (l: string[]) => `${l.slice(0, 12).join(", ")}${l.length > 12 ? ` and ${l.length - 12} more` : ""}`;
const noKillOpts = { env: APT_ENV, noKill: true, maxBuffer: 2 * 1024 * 1024 };

type Planned = { ok: true; plan: PlanEntry[] } | { ok: false; end: () => void };
// `apt-get -s upgrade` -> a validated plan, or the operation's refusal. Used by the plan runner and again by the update runner.
async function simulatePlan(x: Ctx): Promise<Planned> {
  const { env } = x;
  const sim = await env.exec(APT_GET, [...APT_BASE, "-s", "upgrade"], 120_000, noKillOpts);
  if (sim.code !== 0) {
    const busy = LOCK_TEXT.test(sim.stderr + sim.stdout);
    return { ok: false, end: () => finish(x, "failed", busy ? "Nothing changed: the package manager is busy (another apt, dpkg or unattended-upgrades holds the lock). It was not interrupted and no lock was removed. Ask again later." : `Nothing changed: the upgrade simulation failed (exit ${sim.code}).`, { checked: false, detail: busy ? "Package manager busy." : "Simulation failed." }) };
  }
  const parsed = parsePlan(sim.stdout);
  if (!parsed.ok) {
    if (parsed.removals.length || parsed.newInstalls.length) {
      return { ok: false, end: () => finish(x, "failed", `Nothing changed: policy refuses this update. It would ${parsed.removals.length ? `remove ${names(parsed.removals)}` : ""}${parsed.removals.length && parsed.newInstalls.length ? " and " : ""}${parsed.newInstalls.length ? `newly install ${names(parsed.newInstalls)}` : ""}. Only upgrades of installed packages are allowed; do this one by hand.`, { checked: true, healthy: false, detail: "Policy refused the plan.", evidence: { removals: parsed.removals.length, newInstalls: parsed.newInstalls.length } }) };
    }
    return { ok: false, end: () => finish(x, "failed", `Nothing changed: the simulation output could not be trusted (${parsed.problem}). No plan was made.`, { checked: true, healthy: false, detail: "Malformed simulation output." }) };
  }
  return { ok: true, plan: parsed.upgrades };
}

async function auditClean(x: Ctx): Promise<boolean> {
  const a = await x.env.exec(DPKG, ["--audit"], 60_000);
  if (a.code === 0 && !a.stdout.trim()) return true;
  finish(x, "failed", `Nothing changed: the package system is not in a clean state (dpkg --audit reports problems). An operator must fix it first (usually dpkg --configure -a). ${lastLines(a.stdout, 2)}`, { checked: true, healthy: false, detail: "dpkg --audit not clean before starting." });
  return false;
}

// plan_os_updates: the package/version plan the owner is shown. `apt-get update` REFRESHES apt metadata (it is not literally
// read-only; it needs the network and the apt lock) and `apt-get -s upgrade` only simulates. Neither installs or upgrades anything.
async function planOsUpdates(x: Ctx): Promise<void> {
  const { env } = x;
  if (!(await auditClean(x))) return;
  step(x, "refresh", "apt-get update (refreshes apt package-list metadata; no package is installed or upgraded)");
  const upd = await env.exec(APT_GET, [...APT_BASE, "update"], 600_000, noKillOpts);
  step(x, "refresh-result", `exit ${upd.code}${upd.stderr ? `: ${lastLines(upd.stderr, 1)}` : ""}`);
  if (upd.code !== 0) {
    const busy = LOCK_TEXT.test(upd.stderr + upd.stdout);
    return finish(x, "failed", busy ? "No plan: another package manager (apt, dpkg or unattended-upgrades) holds the package lock. It was not interrupted and no lock was removed. Ask again when it has finished." : `No plan: refreshing the package lists failed (exit ${upd.code}). ${lastLines(upd.stderr, 2)}`, { checked: false, detail: busy ? "Package manager busy." : "apt-get update failed." });
  }
  const p = await simulatePlan(x);
  if (!p.ok) return p.end();
  step(x, "plan", `${p.plan.length} upgrade(s) planned`);
  if (!p.plan.length) return finish(x, "no_change", "No package upgrades are pending. Only apt metadata was refreshed; no package was installed or upgraded.", { checked: true, healthy: true, detail: "Simulation shows nothing to upgrade.", evidence: { upgrades: 0 } });
  if (p.plan.length > MAX_PLAN_PACKAGES) return finish(x, "failed", `No plan: ${p.plan.length} packages are pending, more than the ${MAX_PLAN_PACKAGES} this tool will show and bind. Nothing is truncated. Upgrade by hand or in smaller steps.`, { checked: true, healthy: false, detail: "Plan too large.", evidence: { upgrades: p.plan.length } });
  const digest = planDigestOf(p.plan);
  x.rec.plan = { upgrades: p.plan, digest, flags: flagPlan(p.plan) };
  finish(x, "verified", `Plan obtained: ${p.plan.length} package upgrade(s). Only apt metadata was refreshed; no package was installed or upgraded.`, { checked: true, healthy: true, detail: `Plan digest ${digest.slice(0, 12)}.`, evidence: { upgrades: p.plan.length, flagged: planFlagged(x.rec.plan.flags) } });
}

async function installOsUpdates(x: Ctx): Promise<void> {
  const { env, c } = x;
  const target = x.rec.target as HostTarget;
  if (target.host !== env.hostname()) return finish(x, "failed", `Nothing changed: this confirmation names host "${target.host}" but this is "${env.hostname()}".`, { checked: false, detail: "Wrong host." });
  if (!x.rec.planDigest) return finish(x, "failed", "Nothing changed: this confirmation carries no package plan.", { checked: false, detail: "No plan digest." });
  const expected = currentCommit(c);

  if (!(await auditClean(x))) return;

  // The plan the owner confirmed must be exactly what this host would upgrade now. `apt-get update` is NOT run here: the owner
  // approved a plan against specific package lists, and a list refresh in between (apt-daily, a person) shows up as a different plan.
  const p = await simulatePlan(x);
  if (!p.ok) return p.end();
  const now = planDigestOf(p.plan);
  step(x, "plan-check", `${p.plan.length} upgrade(s) now; digest ${now.slice(0, 12)}, confirmed ${x.rec.planDigest.slice(0, 12)}`);
  if (now !== x.rec.planDigest) {
    return finish(x, "failed", `Nothing changed: the pending upgrades are no longer the plan you confirmed (${p.plan.length} package(s) now). Packages or versions changed since the card was shown. Ask for a new plan and confirm that.`, { checked: true, healthy: false, detail: "Plan drifted; refused before installing.", evidence: { planNow: p.plan.length } });
  }
  const plan = p.plan;
  if (!plan.length) return finish(x, "no_change", "No package upgrades are pending; nothing was installed.", { checked: true, healthy: true, detail: "Simulation shows nothing to upgrade.", evidence: { upgraded: 0, rebootRequired: existsSync(c.rebootRequiredFile) } });

  const before = installedVersions((await env.exec(DPKG_QUERY, ["-W", DPKG_FORMAT], 60_000, noKillOpts)).stdout);
  step(x, "upgrade", `apt-get upgrade of ${plan.length} package(s): ${names(plan.map((e) => e[0]))}. No reboot. This tool restarts no service, but package maintainer scripts may.`);
  const up = await env.exec(APT_GET, ["-y", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef", ...APT_BASE, "upgrade"], 2 * 3600_000, noKillOpts);
  step(x, "upgrade-result", `exit ${up.code}${up.stderr ? `: ${lastLines(up.stderr, 1)}` : ""}`);

  const audit1 = await env.exec(DPKG, ["--audit"], 60_000);
  const clean = audit1.code === 0 && !audit1.stdout.trim();
  const after = installedVersions((await env.exec(DPKG_QUERY, ["-W", DPKG_FORMAT], 60_000, noKillOpts)).stdout);
  const missing = [...before.keys()].filter((n) => !after.has(n));
  const wrongVersion = plan.filter((e) => !after.get(bare(e[0]))?.has(e[2])).map((e) => e[0]);
  const rebootRequired = existsSync(c.rebootRequiredFile);
  const leftSim = parsePlan((await env.exec(APT_GET, [...APT_BASE, "-s", "upgrade"], 120_000, noKillOpts)).stdout);
  const left = leftSim.ok ? leftSim.upgrades.length : -1;
  const evidence: SysEvidence = { planned: plan.length, aptExit: up.code, dpkgAuditClean: clean, packagesMissingAfter: missing.length, versionsNotAsPlanned: wrongVersion.length, upgradablesLeft: left < 0 ? null : left, rebootRequired, rebootPerformed: false };
  step(x, "check", `dpkg audit ${clean ? "clean" : "NOT clean"}; ${missing.length} package(s) gone; ${wrongVersion.length} not at the planned version; ${left < 0 ? "unknown" : left} still upgradable; reboot required: ${rebootRequired}`);
  const tail = ` No reboot was performed${rebootRequired ? "; the host says a reboot is required (propose it separately)" : ""}. Package maintainer scripts may have restarted daemons (for example openssh or tailscale), and OpenClaw and other services on this shared host were not inspected by this tool: check them.`;

  if (up.code !== 0) {
    const busy = LOCK_TEXT.test(up.stderr + up.stdout) && clean && !missing.length;
    return finish(x, "failed", busy ? `The upgrade did not start: another package manager held the lock (nothing was interrupted or unlocked). Ask again later.` : `apt-get upgrade failed (exit ${up.code}); packages may be partly upgraded${clean ? "" : " and dpkg reports problems (try dpkg --configure -a by hand)"}. ${lastLines(up.stderr, 2)}${tail}`, { checked: true, healthy: false, detail: "apt-get upgrade failed.", evidence });
  }
  if (missing.length || !clean) {
    return finish(x, "failed", `apt-get upgrade exited 0 but verification failed: ${missing.length ? `${missing.length} package(s) are no longer installed (${names(missing)})` : "dpkg --audit reports problems"}. An operator must inspect the host.${tail}`, { checked: true, healthy: false, detail: "Post-upgrade check failed.", evidence });
  }
  if (wrongVersion.length) {
    return finish(x, "unverified", `apt-get upgrade exited 0 and dpkg is clean, but ${wrongVersion.length} package(s) are not at the version in the confirmed plan (${names(wrongVersion)}). Package lists may have changed between the final check and the upgrade, so more or different versions may have been installed. Check the host.${tail}`, { checked: true, healthy: false, detail: "Installed versions differ from the confirmed plan.", evidence });
  }
  if (!expected) {
    return finish(x, "unverified", `Upgraded ${plan.length} package(s) and dpkg is clean, but ORBIT's health could not be checked (no deployed commit readable).${tail}`, { checked: true, healthy: false, detail: "ORBIT health not checkable.", evidence });
  }
  const h = await waitHealthy(env, c, c.healthWindowMs, expected);
  step(x, "health", h.detail);
  const ev: SysEvidence = { ...evidence, orbitHealthy: h.healthy };
  if (!h.healthy) {
    return finish(x, "failed", `Upgraded ${plan.length} package(s) but ORBIT is not healthy afterwards: ${h.detail} Nothing was restarted or rolled back by this tool.${tail}`, { checked: true, healthy: false, detail: h.detail, evidence: ev });
  }
  finish(x, "verified", `Upgraded ${plan.length} package(s) (${names(plan.map((e) => e[0]))}) to the confirmed versions; dpkg audit is clean, no package was removed, ${left < 0 ? "an unknown number" : left} still upgradable (held back); ORBIT is healthy.${tail}`, { checked: true, healthy: true, detail: `dpkg clean; ${h.detail}`, evidence: ev });
}

// ================================================================= reboot

// A scheduled reboot waits here (in the unit, WITHOUT the deploy lock, so a long wait never blocks a deploy), until its time or
// until it is cancelled. At the time it claims "fire" against any cancellation; from then on it can no longer be cancelled.
export async function awaitSchedule(env: SysEnv, c: SysConfig, opId: string, audit: Audit): Promise<"due" | "cancelled" | "not_scheduled"> {
  const first = loadRecord(c, opId);
  if (!first || first.action !== "reboot_host" || first.state !== "scheduled" || !first.schedule) return "not_scheduled";
  const at = Date.parse(first.schedule.at);
  for (;;) {
    if (decisionOf(c, opId) === "cancel") return "cancelled";
    const left = at - env.now().getTime();
    if (left <= 0) break;
    await env.sleep(Math.min(left, 15_000));
  }
  const d = decide(c, opId, "fire");
  if (!d.won && d.decision === "cancel") return "cancelled";
  const rec = loadRecord(c, opId);
  if (!rec || rec.state !== "scheduled") return "cancelled"; // cannot happen once "fire" is claimed; fail safe: never reboot on a surprise
  rec.state = "accepted";
  addStep(c, rec, env, "due", "The scheduled time arrived and the reboot was claimed: it can no longer be cancelled.", audit);
  return "due";
}

async function rebootHost(x: Ctx): Promise<void> {
  const { env, c, rec } = x;
  const target = rec.target as HostTarget;
  if (target.host !== env.hostname()) return finish(x, "failed", `Not rebooted: this confirmation names host "${target.host}" but this is "${env.hostname()}".`, { checked: false, detail: "Wrong host." });
  // Checked again now (not only when it was accepted): a reboot may have been issued since, and the cool-down is about reboots issued.
  const wait = cooldownRemainingMs(c, env.now().getTime());
  if (wait > 0) return finish(x, "failed", `Not rebooted: another reboot was issued less than ${Math.round(c.rebootCooldownMs / 60000)} minutes ago (cool-down). Nothing was issued by this operation.`, { checked: false, detail: "Cool-down." });
  const pre = readBootKey(c);
  if (!pre) return finish(x, "failed", "Not rebooted: the current boot id could not be read, so the reboot could not be verified afterwards.", { checked: false, detail: "No boot id." });
  // Persisted BEFORE the command, so whatever happens next (crash, power loss, a reboot that works) leaves the evidence. The stamp
  // survives record pruning: the cool-down counts from the moment a reboot is really issued (command accepted or ambiguous, not refused).
  const issuedAt = env.now().toISOString();
  rec.reboot = { preBootKey: pre, issuedAt, ...(currentCommit(c) ? { expectedCommit: currentCommit(c)! } : {}) };
  rec.state = "rebooting";
  step(x, "reboot-issue", "pre-reboot state saved; issuing `systemctl reboot` (once, never retried)");
  const r = await env.exec(SYSTEMCTL, ["reboot"], 30_000);
  if (r.code !== 0 && !r.timedOut) {
    delete rec.reboot; // refused: nothing was issued, so no cool-down starts
    return finish(x, "failed", `The reboot was refused (exit ${r.code}): ${lastLines(r.stderr, 2) || "no detail"}. No reboot is expected.`, { checked: true, healthy: false, detail: "systemctl reboot failed.", evidence: { preBootKey: pre } });
  }
  writeAtomic(rebootStampPath(c), issuedAt); // the command was accepted (or its outcome is ambiguous): the cool-down starts now
  step(x, "reboot-accepted", r.timedOut ? "command timed out; outcome ambiguous, not retried" : "command accepted. This is NOT verification");
  // Wait for the host to go down. If it does, this process is killed and the boot-time recovery verifies. If it does not, the
  // record stays `rebooting`: the front settles it as unverified after the grace period; the command is never re-issued.
  const deadline = env.now().getTime() + c.rebootWaitMs;
  while (env.now().getTime() < deadline) {
    await env.sleep(5_000);
    const k = readBootKey(c);
    if (k && k !== pre) break; // (only in tests: a real boot ends this process)
  }
  step(x, "still-up", "the host is still running this unit after the wait; the reboot is not confirmed");
}

// Runs after every boot (orbit-ops-sys-recover.service). For a record in `rebooting` whose boot id has changed: verify the host
// and ORBIT, persist the evidence, and finish. It never starts a runner and never issues a reboot or any other mutation.
export async function recoverAfterBoot(env: SysEnv, c: SysConfig, audit: Audit): Promise<SysRecord[]> {
  const out: SysRecord[] = [];
  const now = readBootKey(c);
  for (const rec of allRecords(c)) {
    if (rec.action !== "reboot_host" || rec.state !== "rebooting" || !rec.reboot) continue;
    const x: Ctx = { env, c, rec, audit };
    if (!now || now === rec.reboot.preBootKey) {
      step(x, "recover-skip", "boot id unchanged since the reboot was issued: no reboot observed; left as is");
      continue;
    }
    rec.reboot.postBootKey = now;
    step(x, "boot-observed", "boot id changed since the reboot command was issued");
    const ev: SysEvidence = { preBootKey: rec.reboot.preBootKey, postBootKey: now, bootChanged: true, rebootIssuedAt: rec.reboot.issuedAt };
    const expected = rec.reboot.expectedCommit;
    if (!expected) {
      finish(x, "unverified", "The host rebooted (boot id changed) but ORBIT's health could not be verified: no deployed commit was recorded before the reboot.", { checked: true, detail: "Boot changed; ORBIT health not checkable.", evidence: ev });
    } else {
      const h = await waitHealthy(env, c, c.recoverWindowMs, expected);
      step(x, "verify", h.detail);
      ev.orbitHealthy = h.healthy;
      if (h.healthy) finish(x, "verified", `The host rebooted (boot id changed) and ORBIT is healthy, serving ${expected.slice(0, 12)}. Other services on this shared host (including OpenClaw) were not inspected: check them.`, { checked: true, healthy: true, detail: `Boot id changed; ${h.detail}`, evidence: ev });
      else finish(x, "failed", `The host rebooted (boot id changed) but ORBIT is not healthy afterwards: ${h.detail} Check orbit.service and the shared host's other services by hand.`, { checked: true, healthy: false, detail: h.detail, evidence: ev });
    }
    rec.finishedAt = env.now().toISOString();
    saveRecord(c, rec, env);
    releaseSlot(c, rec.opId);
    audit({ at: env.now().toISOString(), opId: rec.opId.slice(0, 12), action: rec.action, step: "result", detail: `${rec.state}: ${rec.summary ?? ""}`.slice(0, 300) });
    out.push(rec);
  }
  return out;
}

// ================================================================= Funnel (orbit-jobs node only)

type ServeJson = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>; TCP?: Record<string, unknown>; AllowFunnel?: Record<string, boolean> };
export type FunnelView = { funnelOn: boolean; proxy?: string; onlyApproved: boolean; empty: boolean };

// What the serve configuration of the orbit-jobs node says about <host>:443. `onlyApproved` is true when the node's whole serve
// configuration is the one handler this tool is allowed to manage (https 443, one "/" proxy handler) and nothing else.
export function viewFunnel(serve: ServeJson, hostPort: string): FunnelView {
  const web = serve.Web ?? {};
  const webKeys = Object.keys(web);
  const tcp = Object.keys(serve.TCP ?? {});
  const allow = Object.keys(serve.AllowFunnel ?? {});
  const entry = web[hostPort];
  const handlers = Object.entries(entry?.Handlers ?? {});
  const proxy = handlers.length === 1 && handlers[0]![0] === "/" ? handlers[0]![1].Proxy : undefined;
  const empty = !webKeys.length && !tcp.length && !allow.length;
  const onlyApproved = webKeys.length === 1 && webKeys[0] === hostPort && handlers.length === 1 && typeof proxy === "string" && tcp.every((p) => p === String(FUNNEL_HTTPS_PORT)) && allow.every((k) => k === hostPort);
  return { funnelOn: serve.AllowFunnel?.[hostPort] === true, ...(proxy ? { proxy } : {}), onlyApproved, empty };
}

async function funnelOp(x: Ctx): Promise<void> {
  const { env, c, rec } = x;
  const enable = rec.action === "funnel_enable";
  const t = rec.target as FunnelTarget;
  const hostPort = `${t.host}:${FUNNEL_HTTPS_PORT}`;
  const want = `http://127.0.0.1:${t.port}`;
  const ts = (...a: string[]) => env.exec(TAILSCALE, [`--socket=${c.jobsSocket}`, ...a], 60_000);
  const refuse = (why: string, detail: string) => finish(x, "failed", `Nothing changed: ${why}`, { checked: false, detail });

  // 1. The privileged side's own view of what orbit-jobs is: orbit.env, never the request.
  const text = readOrbitEnv(c);
  let envHost = "";
  let envPort = 0;
  try {
    const url = /^ORBIT_PUBLIC_JOB_URL=(\S+)\s*$/m.exec(text ?? "")?.[1];
    const port = /^ORBIT_INGRESS_PORT=(\S+)\s*$/m.exec(text ?? "")?.[1];
    if (!url || !port) return refuse("orbit.env does not set ORBIT_PUBLIC_JOB_URL and ORBIT_INGRESS_PORT, so the approved Funnel target is unknown.", "Approved target unknown.");
    envHost = new URL(validateConfigValue("ORBIT_PUBLIC_JOB_URL", url)).hostname;
    envPort = Number(validateConfigValue("ORBIT_INGRESS_PORT", port));
  } catch {
    return refuse("orbit.env holds an invalid ORBIT_PUBLIC_JOB_URL or ORBIT_INGRESS_PORT.", "Approved target invalid.");
  }
  if (envHost !== t.host || envPort !== t.port) return refuse(`the confirmed target (${t.host} → 127.0.0.1:${t.port}) is not the configured orbit-jobs target (${envHost} → 127.0.0.1:${envPort}). Confirm again.`, "Target differs from orbit.env.");

  // 2. The socket must be the orbit-jobs node. Never anything else, and never the host's own tailscaled.
  if (!existsSync(c.jobsSocket)) return refuse("the orbit-jobs tailscaled socket is missing. Install the orbit-jobs node on this host or operate Funnel by hand where it runs (docs/orbit-ops-sys.md).", "No jobs socket.");
  const st = await ts("status", "--json");
  let self: { HostName?: string; DNSName?: string } | undefined;
  let backend = "";
  try {
    const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { HostName?: string; DNSName?: string } };
    self = j.Self;
    backend = j.BackendState ?? "";
  } catch {
    // handled below
  }
  const dns = (self?.DNSName ?? "").replace(/\.$/, "");
  if (st.code !== 0 || !self) return refuse("the orbit-jobs node did not answer on its socket.", "Node status unavailable.");
  if (self.HostName !== JOBS_NODE || dns !== t.host) return refuse(`the node behind that socket is "${dns || "unknown"}", not ${t.host}. This tool only ever changes the ${JOBS_NODE} node.`, "Wrong node.");
  if (backend !== "Running") return refuse(`the orbit-jobs node is not running (state ${backend || "unknown"}).`, "Node not running.");
  step(x, "node", `socket belongs to ${t.host}, running`);

  // 3. Current configuration.
  const read = async (): Promise<ServeJson | undefined> => {
    const r = await ts("serve", "status", "--json");
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout.trim() || "{}") as ServeJson;
    } catch {
      return undefined;
    }
  };
  const cur = await read();
  if (!cur) return refuse("the Funnel configuration of orbit-jobs could not be read.", "Serve config unreadable.");
  const v = viewFunnel(cur, hostPort);
  step(x, "current", `funnel ${v.funnelOn ? "on" : "off"}, proxy ${v.proxy ?? "none"}, only-approved ${v.onlyApproved}`);
  const approved = v.onlyApproved && v.proxy === want;
  const ev = (after: FunnelView): SysEvidence => ({ node: t.host, funnelOn: after.funnelOn, proxy: after.proxy ?? null, configChecked: true, externalReachability: "not tested" });

  if (enable) {
    if (approved && v.funnelOn) return finish(x, "no_change", `Funnel is already on for ${t.host} → ${want}; nothing was changed.`, { checked: true, healthy: true, detail: "Configuration already as requested. External reachability was not tested.", evidence: ev(v) });
    if (!v.empty && !approved) return refuse(`orbit-jobs already has a serve configuration this tool will not overwrite (proxy ${v.proxy ?? "other"}). Fix it by hand.`, "Unrecognised existing config.");
    step(x, "enable", `tailscale funnel --bg --https=443 ${want} (orbit-jobs socket)`);
    const r = await ts("funnel", "--bg", `--https=${FUNNEL_HTTPS_PORT}`, want);
    step(x, "enable-command", `exit ${r.code}${r.stderr ? `: ${lastLines(r.stderr, 1)}` : ""}`);
  } else {
    if (v.empty || (!v.funnelOn && approved) || (!v.funnelOn && !v.proxy)) return finish(x, "no_change", `Funnel is already off for ${t.host}; nothing was changed.`, { checked: true, healthy: true, detail: "Configuration already as requested.", evidence: ev(v) });
    if (!approved) return refuse(`orbit-jobs has a serve configuration this tool will not modify (proxy ${v.proxy ?? "other"}). Fix it by hand.`, "Unrecognised existing config.");
    step(x, "disable", `tailscale funnel --https=443 off (orbit-jobs socket)`);
    const r = await ts("funnel", `--https=${FUNNEL_HTTPS_PORT}`, "off");
    step(x, "disable-command", `exit ${r.code}${r.stderr ? `: ${lastLines(r.stderr, 1)}` : ""}`);
  }

  // 4. Verify from the resulting configuration on orbit-jobs. Public reachability is a separate question and is NOT tested here.
  const after = await read();
  if (!after) return finish(x, "unverified", "The command ran but the resulting configuration of orbit-jobs could not be read back. Nothing is verified.", { checked: false, detail: "Read-back failed." });
  const w = viewFunnel(after, hostPort);
  step(x, "verify", `funnel ${w.funnelOn ? "on" : "off"}, proxy ${w.proxy ?? "none"}`);
  const ok = enable ? w.funnelOn && w.onlyApproved && w.proxy === want : !w.funnelOn;
  if (ok) {
    return finish(x, "verified", `${enable ? `Funnel is on for ${t.host} → ${want}` : `Funnel is off for ${t.host}`} according to the node's own configuration. Public reachability was NOT tested from outside.`, { checked: true, healthy: true, detail: "Resulting orbit-jobs configuration matches.", evidence: ev(w) });
  }
  finish(x, "failed", `The command ran but the resulting configuration of orbit-jobs does not match (${w.funnelOn ? "funnel on" : "funnel off"}, proxy ${w.proxy ?? "none"}).`, { checked: true, healthy: false, detail: "Resulting configuration differs.", evidence: ev(w) });
}

// ================================================================= driver

export type RunKind = "update" | "reboot" | "funnel" | "plan";
const kindOf = (a: SysRecord["action"]): RunKind => (a === "install_os_updates" ? "update" : a === "plan_os_updates" ? "plan" : a === "reboot_host" ? "reboot" : "funnel");

export async function runOperation(opId: string, kind: RunKind, env: SysEnv, c: SysConfig, audit: Audit): Promise<SysRecord | undefined> {
  const rec = loadRecord(c, opId);
  if (!rec) return undefined;
  const x: Ctx = { env, c, rec, audit };
  // A record that is not `accepted` is never run: a restart, a retry or a replay of the unit cannot do it twice.
  if (rec.state !== "accepted") {
    audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), action: rec.action, step: "refused", detail: rec.state === "scheduled" ? "still scheduled: it waits for its time first (awaitSchedule); not run" : `already ${rec.state}; not run again` });
    return rec;
  }
  if (kindOf(rec.action) !== kind) {
    finish(x, "failed", "This runner is not the right one for that action; nothing was done.", { checked: false, detail: "Nothing ran." });
    rec.finishedAt = env.now().toISOString();
    saveRecord(c, rec, env);
    releaseSlot(c, opId);
    return rec;
  }
  // A scheduled reboot was accepted while its confirmation was valid and has waited since; its time, not the confirmation's expiry,
  // governs it from then on.
  if (!rec.schedule && rec.action !== "plan_os_updates" && Date.parse(rec.expiresAt) <= env.now().getTime()) {
    finish(x, "failed", "Not run: the confirmation expired before the runner started. Nothing was changed.", { checked: false, detail: "Expired." });
    rec.finishedAt = env.now().toISOString();
    saveRecord(c, rec, env);
    releaseSlot(c, opId);
    return rec;
  }
  if (rec.action === "reboot_host") {
    // Decide against a cancellation BEFORE writing anything: a cancelled record must never be overwritten by this runner's copy.
    const d = decide(c, opId, "fire");
    if (!d.won && d.decision === "cancel") {
      audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), action: rec.action, step: "cancelled", detail: "cancelled before it fired; nothing was issued" });
      return loadRecord(c, opId) ?? rec;
    }
  }
  rec.state = "running";
  rec.startedAt = env.now().toISOString();
  step(x, "start", `running ${rec.action}`);
  try {
    switch (rec.action) {
      case "install_os_updates": await installOsUpdates(x); break;
      case "plan_os_updates": await planOsUpdates(x); break;
      case "reboot_host": await rebootHost(x); break;
      case "funnel_enable":
      case "funnel_disable": await funnelOp(x); break;
    }
  } catch (err) {
    finish(x, "failed", `The runner hit an unexpected error (${cap(err instanceof Error ? err.message : "error", 80)}). The outcome is unknown; check the host.`, { checked: false, detail: "Not verified." });
  } finally {
    const waiting = (rec.state as SysRecord["state"]) === "rebooting"; // a reboot is finished by the recovery after the boot, not by this runner
    if (!waiting) {
      if (!isSysTerminal(rec.state)) finish(x, "failed", "The runner ended without a result.", { checked: false, detail: "Not verified." });
      rec.finishedAt = env.now().toISOString();
    }
    saveRecord(c, rec, env);
    if (!waiting) releaseSlot(c, opId);
    audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), action: rec.action, step: waiting ? "waiting" : "result", detail: `${rec.state}: ${rec.summary ?? ""}`.slice(0, 300) });
  }
  return rec;
}

// update and reboot take the deploy lock for their whole run (so they cannot interleave with a deploy, rollback, restart or
// config change from tier 2), by re-running this program under flock. The lock file is on /opt/orbit/state.
async function main(): Promise<void> {
  const [a, b] = process.argv.slice(2);
  const audit: Audit = (line) => process.stderr.write(`orbit-ops-sys-run ${JSON.stringify(line)}\n`);
  if (a === "recover") {
    await recoverAfterBoot(systemSysEnv, SYS_CONFIG, audit);
    process.exit(0);
  }
  const opId = a;
  const kind = b as RunKind;
  if (!opId || !SYS_OP_ID.test(opId) || !["update", "reboot", "funnel", "plan"].includes(kind)) {
    process.stderr.write("orbit-ops-sys-run: usage: sys-run.ts <opId> update|reboot|funnel|plan | recover\n");
    process.exit(64);
  }
  if (kind === "reboot" && loadRecord(SYS_CONFIG, opId)?.state === "scheduled") {
    const w = await awaitSchedule(systemSysEnv, SYS_CONFIG, opId, audit);
    if (w !== "due") process.exit(0);
  }
  const rec = loadRecord(SYS_CONFIG, opId);
  const needsLock = rec?.state === "accepted" && (kind === "update" || kind === "reboot");
  if (needsLock && process.env.ORBIT_SYS_LOCKED !== "1") {
    const lock = `${SYS_CONFIG.root}/state/deploy.lock`;
    const code = await new Promise<number>((resolve) => {
      const child = execFile("/usr/bin/flock", ["-w", String(SYS_CONFIG.lockWaitSeconds), lock, process.execPath, "--max-old-space-size=64", fileURLToPath(import.meta.url), opId, kind], { env: { ...process.env, ORBIT_SYS_LOCKED: "1" } }, (err) => {
        resolve(err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0);
      });
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    });
    const after = loadRecord(SYS_CONFIG, opId);
    if (code !== 0 && after && after.state === "accepted") {
      after.state = "failed";
      after.summary = "Not run: the deploy lock could not be taken in time (a deploy, rollback or config change was running). Nothing was changed.";
      after.finishedAt = new Date().toISOString();
      after.verification = { checked: false, detail: "Nothing ran." };
      saveRecord(SYS_CONFIG, after, systemSysEnv);
      releaseSlot(SYS_CONFIG, opId);
      audit({ at: new Date().toISOString(), opId: opId.slice(0, 12), action: after.action, step: "result", detail: `failed: ${after.summary}` });
    }
    process.exit(0);
  }
  const done = await runOperation(opId, kind, systemSysEnv, SYS_CONFIG, audit);
  process.exit(done ? 0 : 1);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) void main();
