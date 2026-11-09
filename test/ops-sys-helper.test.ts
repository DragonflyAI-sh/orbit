// Tier 3 privileged side (src/ops/sys-*.ts). Everything runs against FAKES: a fake exec that records every command and answers from a
// script, real temp directories for state, and a fake clock. No test executes apt, systemctl, tailscale or anything else on the host.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Exec, Probe } from "../src/ops/admin-core.ts";
import { SYS_CONFIG, activePath, loadRecord, type SysConfig, type SysEnv } from "../src/ops/sys-core.ts";
import { handle, settleIfDead, type SysAudit } from "../src/ops/sys-helper.ts";
import {
  SYS_ACTIONS,
  SYS_MAX_TTL_MS,
  SYS_MUTATING_ACTIONS,
  bootKey,
  parseSysRequest,
  sysDigestOf,
  sysOpIdFor,
  type FunnelTarget,
  type SysMutatingAction,
  type SysRecord,
  type SysTarget,
} from "../src/ops/sys-protocol.ts";
import { parseSimulation, recoverAfterBoot, runOperation, viewFunnel, type RunKind } from "../src/ops/sys-run.ts";

const SHA_A = "a".repeat(40);
const HOST = "orbit-dedicated-8";
const JOBS_HOST = "orbit-jobs.tail5bde08.ts.net";
const PORT = 8791;
const OP = "1".repeat(40);
const OP2 = "2".repeat(40);
const BOOT1 = "11111111-aaaa-bbbb-cccc-000000000001";
const BOOT2 = "22222222-aaaa-bbbb-cccc-000000000002";

type World = {
  base: string; cfg: SysConfig; execs: { file: string; args: string[]; opts?: object }[]; probes: string[]; audit: object[]; fronts: SysAudit[];
  script: { exec: (file: string, args: string[], w: World) => Exec | undefined; served: string | undefined };
  env: SysEnv; setBoot(id: string): void; advance(ms: number): void; host: { name: string };
  clock: () => number;
};

function world(opts: { jobsSocket?: boolean; orbitEnv?: string } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ops-sys-")));
  const root = join(base, "opt-orbit");
  const stateDir = join(base, "var-lib");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "releases", SHA_A), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, "releases", SHA_A, "COMMIT"), `${SHA_A}\n`);
  symlinkSync(join(root, "releases", SHA_A), join(root, "current"));
  writeFileSync(join(root, "orbit.env"), opts.orbitEnv ?? `HOST=127.0.0.1\nPORT=8790\nORBIT_INGRESS_PORT=${PORT}\nORBIT_PUBLIC_JOB_URL=https://${JOBS_HOST}\n`);
  const jobsSocket = join(base, "jobs.sock");
  if (opts.jobsSocket !== false) writeFileSync(jobsSocket, ""); // presence only; no test ever opens a socket
  const bootIdFile = join(base, "boot_id");
  writeFileSync(bootIdFile, `${BOOT1}\n`);
  let t = Date.parse("2026-11-09T12:00:00Z");
  const cfg: SysConfig = { ...SYS_CONFIG, root, stateDir, jobsSocket, bootIdFile, rebootRequiredFile: join(base, "reboot-required"), healthWindowMs: 10_000, healthIntervalMs: 1000, recoverWindowMs: 10_000, rebootWaitMs: 20_000 };
  const execs: World["execs"] = [];
  const host = { name: HOST };
  const w: World = {
    base, cfg, execs, probes: [], audit: [], fronts: [], host,
    script: { exec: () => undefined, served: SHA_A },
    setBoot: (id) => writeFileSync(bootIdFile, `${id}\n`),
    advance: (ms) => void (t += ms),
    clock: () => t,
    env: {
      exec: async (file, args, _timeout, o) => {
        execs.push({ file, args, ...(o ? { opts: o } : {}) });
        return w.script.exec(file, args, w) ?? { code: 0, stdout: "", stderr: "", timedOut: false };
      },
      probe: async (h, p, path): Promise<Probe> => {
        w.probes.push(`${h}:${p}${path}`);
        return w.script.served ? { reachable: true, httpStatus: 200, commit: w.script.served } : { reachable: false };
      },
      sleep: async (ms) => void (t += ms),
      now: () => new Date(t),
      hostname: () => host.name,
    },
  };
  return w;
}

const ok = (stdout = "", code = 0): Exec => ({ code, stdout, stderr: "", timedOut: false });
const fail = (code: number, stderr = ""): Exec => ({ code, stdout: "", stderr, timedOut: false });
const calls = (w: World) => w.execs.map((e) => `${e.file.split("/").pop()} ${e.args.join(" ")}`);

const hostTarget = (): SysTarget => ({ host: HOST });
const funnelTarget = (): FunnelTarget => ({ host: JOBS_HOST, port: PORT });
const targetFor = (a: SysMutatingAction): SysTarget => (a === "funnel_enable" || a === "funnel_disable" ? funnelTarget() : hostTarget());
function req(w: World, action: SysMutatingAction, over: Record<string, unknown> = {}) {
  const target = targetFor(action);
  return { action, opId: OP, target, digest: sysDigestOf(action, target), expiresAt: new Date(w.clock() + 10 * 60_000).toISOString(), ...over };
}
const send = async (w: World, r: object) => JSON.parse(await handle(JSON.stringify(r), w.env, (a) => w.fronts.push(a), w.cfg)) as { ok: boolean; data?: any; error?: { code: string; message: string } };
// The front accepts and dispatches; the runner is then driven directly (as the systemd unit would).
async function accept(w: World, action: SysMutatingAction, over: Record<string, unknown> = {}) {
  const out = await send(w, req(w, action, over));
  assert.equal(out.ok, true, JSON.stringify(out));
  w.execs.length = 0;
  return out;
}
const kindOf = (a: SysMutatingAction): RunKind => (a === "install_os_updates" ? "update" : a === "reboot_host" ? "reboot" : "funnel");
const run = async (w: World, action: SysMutatingAction, opId = OP) => (await runOperation(opId, kindOf(action), w.env, w.cfg, (l) => w.audit.push(l)))!;
const rec = (w: World, opId = OP) => loadRecord(w.cfg, opId)!;

// ---------------------------------------------------------------- validation: strict, fixed, no room for injection

test("requests are strict: fixed actions only, no extra keys, bad ids/targets/digests/expiries refused", async () => {
  const w = world();
  assert.deepEqual([...SYS_MUTATING_ACTIONS], ["install_os_updates", "reboot_host", "funnel_enable", "funnel_disable"]);
  assert.deepEqual([...SYS_ACTIONS], ["install_os_updates", "reboot_host", "funnel_enable", "funnel_disable", "sys_status", "op_status"]);
  const bad = (r: unknown, code: string) => assert.throws(() => parseSysRequest(typeof r === "string" ? r : JSON.stringify(r)), (e: { code?: string }) => e.code === code, JSON.stringify(r).slice(0, 80));
  bad("nope", "bad_request");
  bad("[]", "bad_request");
  for (const action of ["shell", "exec", "apt", "dist_upgrade", "reboot", "poweroff", "tailscale", "funnel", "funnel_toggle", "restart_unit", "delete_file", ""]) bad({ action, opId: OP }, "unknown_action");
  const good = req(w, "reboot_host");
  bad({ ...good, opId: "short" }, "bad_arguments");
  bad({ ...good, cmd: "reboot -f" }, "bad_arguments");
  bad({ ...good, unit: "sshd.service" }, "bad_arguments");
  bad({ ...good, packages: ["openssh-server"] }, "bad_arguments");
  bad({ ...good, path: "/etc/shadow" }, "bad_arguments");
  bad({ action: "reboot_host", opId: OP }, "bad_arguments"); // target/digest/expiry are required
  bad({ ...good, digest: "abc" }, "bad_arguments");
  bad({ ...good, expiresAt: "tomorrow" }, "bad_arguments");
  bad({ ...good, target: { host: HOST, extra: 1 } }, "bad_arguments");
  bad({ ...good, target: { host: `${HOST}; reboot` } }, "bad_arguments");
  bad({ ...good, target: { host: "x\nORBIT_OWNER=y" } }, "bad_arguments");
  bad({ ...good, target: { host: "../etc" } }, "bad_arguments");
  bad({ ...good, target: { host: "UPPER" } }, "bad_arguments");
  bad({ action: "sys_status", opId: OP }, "bad_arguments");
  bad({ action: "op_status" }, "bad_arguments");
  // funnel targets: only the orbit-jobs node, only a sane port, nothing else
  const f = req(w, "funnel_disable");
  bad({ ...f, target: { host: "evil.example.com", port: PORT } }, "bad_arguments");
  bad({ ...f, target: { host: "orbit-dedicated-8.tail5bde08.ts.net", port: PORT } }, "bad_arguments");
  bad({ ...f, target: { host: JOBS_HOST, port: 80 } }, "bad_arguments");
  bad({ ...f, target: { host: JOBS_HOST, port: "8791" } }, "bad_arguments");
  bad({ ...f, target: { host: JOBS_HOST, port: 70000 } }, "bad_arguments");
  bad({ ...f, target: { host: JOBS_HOST, port: PORT, dest: "http://169.254.169.254" } }, "bad_arguments");
  bad({ ...f, target: { host: JOBS_HOST } }, "bad_arguments");
  bad({ ...f, target: HOST }, "bad_arguments");
  // a host-style target for a funnel action and the reverse are both refused
  bad({ ...f, target: { host: HOST } }, "bad_arguments");
  bad({ ...good, target: funnelTarget() }, "bad_arguments");
  const big = JSON.stringify({ ...good, pad: "x".repeat(3000) });
  bad(big, "request_too_large");
  assert.equal(parseSysRequest(JSON.stringify(good)).action, "reboot_host");
  assert.deepEqual(parseSysRequest(JSON.stringify({ action: "sys_status" })), { action: "sys_status" });
});

test("confirmation binding: the digest names the exact action and target, and the helper recomputes it", async () => {
  const w = world();
  const d = (a: SysMutatingAction, t: SysTarget) => sysDigestOf(a, t);
  assert.notEqual(d("reboot_host", hostTarget()), d("install_os_updates", hostTarget()), "another action is another digest");
  assert.notEqual(d("funnel_enable", funnelTarget()), d("funnel_disable", funnelTarget()));
  assert.notEqual(d("funnel_disable", funnelTarget()), d("funnel_disable", { host: JOBS_HOST, port: 8792 }), "another port is another digest");
  assert.notEqual(d("reboot_host", hostTarget()), d("reboot_host", { host: "other-host" }));
  // a digest confirmed for an update cannot be used to reboot, and the reverse
  const forUpdate = req(w, "install_os_updates");
  const swapped = await send(w, { ...req(w, "reboot_host"), digest: forUpdate.digest });
  assert.equal(swapped.error?.code, "digest_mismatch");
  const retargeted = await send(w, { ...req(w, "funnel_enable"), target: { host: JOBS_HOST, port: 8792 } });
  assert.equal(retargeted.error?.code, "digest_mismatch");
  assert.equal(existsSync(join(w.cfg.stateDir, "ops")), false, "nothing was recorded");
  assert.deepEqual(w.execs, []);
});

// ---------------------------------------------------------------- authorization at the privileged boundary

test("expiry is enforced by the helper: expired and over-long confirmations are refused, nothing recorded or started", async () => {
  const w = world();
  const expired = await send(w, req(w, "reboot_host", { expiresAt: new Date(w.clock() - 1000).toISOString() }));
  assert.equal(expired.error?.code, "expired");
  const eternal = await send(w, req(w, "reboot_host", { expiresAt: new Date(w.clock() + SYS_MAX_TTL_MS + 60_000).toISOString() }));
  assert.equal(eternal.error?.code, "bad_arguments");
  assert.deepEqual(w.execs, []);
  assert.equal(loadRecord(w.cfg, OP), undefined);
  // exactly at the limit is fine
  const edge = await send(w, req(w, "reboot_host", { expiresAt: new Date(w.clock() + SYS_MAX_TTL_MS).toISOString() }));
  assert.equal(edge.ok, true);
});

test("a confirmation for another host is refused (wrong target), for updates and reboot alike", async () => {
  const w = world();
  for (const action of ["install_os_updates", "reboot_host"] as const) {
    const target = { host: "some-other-host" };
    const r = await send(w, { action, opId: OP, target, digest: sysDigestOf(action, target), expiresAt: new Date(w.clock() + 60_000).toISOString() });
    assert.equal(r.error?.code, "wrong_target", action);
  }
  assert.deepEqual(w.execs, []);
});

test("dispatch starts exactly one fixed runner unit per action, and nothing else", async () => {
  const expected: Record<SysMutatingAction, string> = {
    install_os_updates: `start --no-block orbit-ops-sys-update@${OP}.service`,
    reboot_host: `start --no-block orbit-ops-sys-reboot@${OP}.service`,
    funnel_enable: `start --no-block orbit-ops-sys-funnel@${OP}.service`,
    funnel_disable: `start --no-block orbit-ops-sys-funnel@${OP}.service`,
  };
  for (const action of SYS_MUTATING_ACTIONS) {
    const w = world();
    const out = await send(w, req(w, action));
    assert.equal(out.ok, true);
    assert.equal(out.data.operation.state, "accepted");
    assert.match(out.data.note, /Nothing is verified yet/);
    assert.deepEqual(calls(w), [`systemctl ${expected[action]}`], action);
    assert.equal(rec(w).state, "accepted");
  }
});

test("replay protection: a repeated operation id returns the recorded state and never dispatches again", async () => {
  const w = world();
  await send(w, req(w, "install_os_updates"));
  w.execs.length = 0;
  const again = await send(w, req(w, "install_os_updates"));
  assert.equal(again.data.replayed, true);
  assert.match(again.data.note, /not run again/);
  assert.deepEqual(w.execs, []);
  // even after the confirmation expired, the id is not usable again and returns the same record
  w.advance(60 * 60_000);
  const late = await send(w, req(w, "install_os_updates", { expiresAt: new Date(w.clock() + 1000).toISOString() }));
  assert.equal(late.data.replayed, true);
  assert.ok(!calls(w).some((c) => /\bstart\b/.test(c)), "only a read-only is-active check may run, never a start");
  assert.equal(w.fronts.filter((a) => a.outcome === "replayed").length, 2);
});

test("concurrency: one operation at a time; the slot survives a restart; a second request is busy and starts nothing", async () => {
  const w = world();
  const first = await send(w, req(w, "install_os_updates"));
  assert.equal(first.ok, true);
  w.execs.length = 0;
  // a different operation (any action) while the first is open
  for (const action of SYS_MUTATING_ACTIONS) {
    const target = targetFor(action);
    const second = await send(w, { action, opId: OP2, target, digest: sysDigestOf(action, target), expiresAt: new Date(w.clock() + 60_000).toISOString() });
    assert.equal(second.error?.code, "busy", action);
  }
  assert.equal(readFileSync(activePath(w.cfg), "utf8"), OP);
  assert.equal(loadRecord(w.cfg, OP2), undefined);
  assert.ok(!calls(w).some((c) => c.includes("start")), "no second runner was started");
  // simultaneous requests: exactly one gets the slot
  const w2 = world();
  const both = await Promise.all([send(w2, req(w2, "reboot_host")), send(w2, req(w2, "install_os_updates", { opId: OP2 }))]);
  assert.equal(both.filter((r) => r.ok).length, 1);
  assert.equal(both.filter((r) => r.error?.code === "busy").length, 1);
});

test("an operation that died is settled as interrupted (never guessed, never re-run), freeing the slot", async () => {
  const w = world();
  await accept(w, "install_os_updates");
  const r = rec(w);
  r.state = "running";
  w.advance(60_000); // quiet for longer than staleAfterMs
  w.script.exec = (f, a) => (a[0] === "is-active" ? fail(3) : undefined);
  const settled = await settleIfDead(w.env, w.cfg, r);
  assert.equal(settled.state, "interrupted");
  assert.match(settled.summary!, /package state is unknown/);
  assert.equal(existsSync(activePath(w.cfg)), false);
  // still running (runner active) is left alone
  const w2 = world();
  await accept(w2, "install_os_updates");
  w2.advance(60_000);
  w2.script.exec = (f, a) => (a[0] === "is-active" ? ok("active\n") : undefined);
  assert.equal((await settleIfDead(w2.env, w2.cfg, rec(w2))).state, "accepted");
});

test("the front fails the operation honestly when the runner cannot be started", async () => {
  const w = world();
  w.script.exec = () => fail(1, "Failed to start");
  const out = await send(w, req(w, "reboot_host"));
  assert.equal(out.data.accepted, false);
  assert.equal(out.data.operation.state, "failed");
  assert.match(out.data.operation.summary, /nothing was done/);
  assert.equal(existsSync(activePath(w.cfg)), false, "the slot is free again");
});

test("reboots have a cool-down: a second reboot soon after one was accepted is refused", async () => {
  const w = world();
  await send(w, req(w, "reboot_host"));
  const r = rec(w);
  r.state = "failed"; // even a finished one: the cool-down is about reboot loops
  writeFileSync(join(w.cfg.stateDir, "ops", `${OP}.json`), JSON.stringify(r));
  rmSync(activePath(w.cfg), { force: true });
  const again = await send(w, req(w, "reboot_host", { opId: OP2 }));
  assert.equal(again.error?.code, "cooldown");
  w.advance(w.cfg.rebootCooldownMs + 1000);
  const later = await send(w, req(w, "reboot_host", { opId: OP2, expiresAt: new Date(w.clock() + 60_000).toISOString() }));
  assert.equal(later.ok, true);
});

test("sys_status reports presence facts only (never a Funnel or reachability claim) and any open operation", async () => {
  const w = world();
  const s = await send(w, { action: "sys_status" });
  assert.equal(s.ok, true);
  assert.deepEqual(Object.keys(s.data).sort(), ["bootKey", "hostname", "installed", "openOperation", "orbitJobsSocketPresent", "rebootRequired", "tier"]);
  assert.equal(s.data.hostname, HOST);
  assert.equal(s.data.orbitJobsSocketPresent, true);
  assert.equal(s.data.bootKey, bootKey(BOOT1));
  assert.equal(s.data.openOperation, null);
  await send(w, req(w, "reboot_host"));
  assert.equal((await send(w, { action: "sys_status" })).data.openOperation.action, "reboot_host");
  const none = world({ jobsSocket: false });
  assert.equal((await send(none, { action: "sys_status" })).data.orbitJobsSocketPresent, false);
});

// ---------------------------------------------------------------- OS updates

const PLAN2 = "Inst libfoo1 [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])\nInst bar [2.0] (2.1 Ubuntu:24.04/noble-security [amd64])\nConf libfoo1 (1.1)\n";
const PKGS_BEFORE = "ii libfoo1\nii bar\nii baz\nrc old\n";
type Upd = { audit?: Exec[]; update?: Exec; sim?: Exec[]; upgrade?: Exec; before?: string; after?: string };
function aptScript(w: World, u: Upd = {}) {
  let audits = 0;
  let sims = 0;
  let queries = 0;
  w.script.exec = (file, args) => {
    const name = file.split("/").pop();
    if (name === "dpkg") return (u.audit ?? [ok()])[Math.min(audits++, (u.audit ?? [ok()]).length - 1)];
    if (name === "dpkg-query") return ok(queries++ === 0 ? (u.before ?? PKGS_BEFORE) : (u.after ?? PKGS_BEFORE));
    if (name === "apt-get") {
      if (args.includes("update")) return u.update ?? ok();
      if (args.includes("-s")) return (u.sim ?? [ok(PLAN2), ok("")])[Math.min(sims++, (u.sim ?? [ok(PLAN2), ok("")]).length - 1)];
      return u.upgrade ?? ok("done");
    }
    return undefined;
  };
}
const ALLOWED_UPDATE_BINARIES = new Set(["apt-get", "dpkg", "dpkg-query"]);

test("OS updates: apt-get upgrade only, verified from dpkg and ORBIT health, reboot-required reported but never acted on", async () => {
  const w = world();
  aptScript(w);
  writeFileSync(w.cfg.rebootRequiredFile, "*** System restart required ***\n");
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "verified");
  assert.equal(r.verification?.checked, true);
  assert.equal(r.verification?.healthy, true);
  assert.deepEqual(r.verification?.evidence, { planned: 2, aptExit: 0, dpkgAuditClean: true, packagesMissingAfter: 0, upgradablesLeft: 0, rebootRequired: true, rebootPerformed: false, orbitHealthy: true });
  assert.match(r.summary!, /No reboot was performed; the host says a reboot is required \(propose it separately\)/);
  assert.match(r.summary!, /OpenClaw.*not inspected/);
  // the only binaries ever run, and the exact upgrade command
  for (const e of w.execs) assert.ok(ALLOWED_UPDATE_BINARIES.has(e.file.split("/").pop()!), e.file);
  const all = calls(w).join("\n");
  assert.ok(!/systemctl|reboot|shutdown|poweroff|needrestart|dist-upgrade|full-upgrade|autoremove|remove|purge|kill|fuser|rm /.test(all), all);
  const upgrade = w.execs.find((e) => e.args.includes("upgrade") && !e.args.includes("-s"))!;
  assert.deepEqual(upgrade.args, ["-y", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef", "-o", "DPkg::Lock::Timeout=120", "upgrade"]);
  // package managers are never killed (no timeout kill), and services are not restarted by the package tooling
  for (const e of w.execs.filter((x) => x.file.endsWith("apt-get"))) assert.equal((e.opts as { noKill?: boolean }).noKill, true);
  assert.equal((upgrade.opts as { env: Record<string, string> }).env.NEEDRESTART_SUSPEND, "1");
  assert.equal((upgrade.opts as { env: Record<string, string> }).env.DEBIAN_FRONTEND, "noninteractive");
  assert.equal(existsSync(activePath(w.cfg)), false);
});

test("OS updates: nothing pending is no_change, not success", async () => {
  const w = world();
  aptScript(w, { sim: [ok("")] });
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "no_change");
  assert.ok(!calls(w).some((c) => c.includes(" upgrade") && !c.includes(" -s ")), "the real upgrade was never run");
});

test("OS updates policy: a plan that removes or newly installs anything is refused before any change", async () => {
  for (const [plan, what] of [["Inst a [1] (2 x)\nRemv oldlib [1]\n", /remove oldlib/], ["Inst a [1] (2 x)\nInst brand-new (1 x)\n", /newly install brand-new/]] as const) {
    const w = world();
    aptScript(w, { sim: [ok(plan)] });
    await accept(w, "install_os_updates");
    const r = await run(w, "install_os_updates");
    assert.equal(r.state, "failed");
    assert.match(r.summary!, /policy refuses/);
    assert.match(r.summary!, what);
    assert.ok(!w.execs.some((e) => e.args.includes("upgrade") && !e.args.includes("-s")), "no real upgrade ran");
  }
  assert.deepEqual(parseSimulation(PLAN2), { upgrades: ["libfoo1", "bar"], removals: [], newInstalls: [] });
  assert.deepEqual(parseSimulation("Remv x [1]\nInst y (2 z)\n"), { upgrades: [], removals: ["x"], newInstalls: ["y"] });
});

test("OS updates: package-manager contention fails safely, kills nothing and removes no lock", async () => {
  const lock = "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (unattended-upgr)";
  // contention at the refresh
  const w = world();
  aptScript(w, { update: fail(100, lock) });
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /holds the package lock/);
  assert.match(r.summary!, /not interrupted and no lock was removed/);
  assert.equal(r.verification?.checked, false);
  // contention appearing only at the upgrade itself
  const w2 = world();
  aptScript(w2, { upgrade: fail(100, lock) });
  await accept(w2, "install_os_updates");
  const r2 = await run(w2, "install_os_updates");
  assert.equal(r2.state, "failed");
  assert.match(r2.summary!, /another package manager held the lock/);
  for (const ww of [w, w2]) {
    const all = calls(ww).join("\n");
    assert.ok(!/kill|fuser|rm |lock-frontend|lsof|pkill/.test(all.replace(/DPkg::Lock::Timeout/g, "")), "no kill and no lock removal");
    for (const e of ww.execs) assert.ok(ALLOWED_UPDATE_BINARIES.has(e.file.split("/").pop()!));
  }
  // the lock wait is bounded by apt itself, not by killing it
  assert.ok(w.execs[1]!.args.includes("DPkg::Lock::Timeout=120"));
});

test("OS updates: a dirty dpkg state before starting refuses to run apt at all", async () => {
  const w = world();
  aptScript(w, { audit: [ok("The following packages are only half configured:\n foo")] });
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /not in a clean state/);
  assert.deepEqual(w.execs.map((e) => e.file.split("/").pop()), ["dpkg"]);
});

test("OS updates: failures and unexpected side effects are reported, never as success", async () => {
  // apt exits non-zero
  let w = world();
  aptScript(w, { upgrade: fail(100, "E: Sub-process /usr/bin/dpkg returned an error code (1)") });
  await accept(w, "install_os_updates");
  let r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /apt-get upgrade failed \(exit 100\); packages may be partly upgraded/);
  // dpkg dirty afterwards
  w = world();
  aptScript(w, { audit: [ok(), ok("half configured: bar")] });
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /dpkg --audit reports problems/);
  // a package disappeared although apt exited 0
  w = world();
  aptScript(w, { after: "ii libfoo1\nii bar\n" });
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /no longer installed \(baz\)/);
  assert.equal(r.verification?.healthy, false);
  // ORBIT unhealthy afterwards: packages upgraded but not "verified"
  w = world();
  aptScript(w);
  w.script.served = undefined;
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /ORBIT is not healthy afterwards.*Nothing was restarted or rolled back/);
  // ORBIT's commit unknown: cannot verify health -> unverified
  w = world();
  aptScript(w);
  rmSync(join(w.cfg.root, "current"));
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "unverified");
});

test("OS updates: timeouts (a command that never answers) fail the operation and never claim success", async () => {
  const w = world();
  aptScript(w);
  const base = w.script.exec;
  w.script.exec = (f, a, ww) => (f.endsWith("apt-get") && a.includes("update") ? { code: null, stdout: "", stderr: "", timedOut: true } : base(f, a, ww));
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.equal(r.verification?.checked, false);
  assert.ok(!w.execs.some((e) => e.args.includes("upgrade") && !e.args.includes("-s")));
});

test("OS updates never reboot: not on success, not with reboot-required set, not when failing", async () => {
  for (const mode of ["ok", "fail"] as const) {
    const w = world();
    aptScript(w, mode === "fail" ? { upgrade: fail(100, "E: boom") } : {});
    writeFileSync(w.cfg.rebootRequiredFile, "x");
    await accept(w, "install_os_updates");
    await run(w, "install_os_updates");
    assert.ok(!w.execs.some((e) => e.file.endsWith("systemctl") || e.args.some((a) => /reboot|poweroff|halt|shutdown/.test(a))), mode);
    assert.equal(readFileSync(w.cfg.bootIdFile, "utf8").trim(), BOOT1);
  }
});

test("OS updates on the wrong host change nothing; a runner never runs the same record twice; an expired record is not run", async () => {
  const w = world();
  aptScript(w);
  await accept(w, "install_os_updates");
  w.host.name = "imposter";
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /Nothing changed: this confirmation names host/);
  assert.deepEqual(w.execs, []);
  // second run of the same record (a retry of the unit)
  const again = await run(w, "install_os_updates");
  assert.equal(again.state, "failed");
  assert.deepEqual(w.execs, []);
  assert.ok(w.audit.some((a) => /not run again/.test(JSON.stringify(a))));
  // expired between accept and run
  const w2 = world();
  aptScript(w2);
  await accept(w2, "install_os_updates");
  w2.advance(11 * 60_000);
  const r2 = await run(w2, "install_os_updates");
  assert.equal(r2.state, "failed");
  assert.match(r2.summary!, /expired/);
  assert.deepEqual(w2.execs, []);
  // wrong runner kind
  const w3 = world();
  await accept(w3, "reboot_host");
  const r3 = (await runOperation(OP, "update", w3.env, w3.cfg, () => {}))!;
  assert.equal(r3.state, "failed");
  assert.deepEqual(w3.execs, []);
});

// ---------------------------------------------------------------- reboot

test("reboot: pre-reboot state is persisted BEFORE the command; accepted/rebooting is never success; the command is issued once", async () => {
  const w = world();
  let seen: SysRecord | undefined;
  w.script.exec = (f, a, ww) => {
    if (f.endsWith("systemctl") && a[0] === "reboot") seen = loadRecord(ww.cfg, OP);
    return undefined;
  };
  await accept(w, "reboot_host");
  const r = await run(w, "reboot_host");
  assert.deepEqual(calls(w), ["systemctl reboot"]);
  assert.equal(seen?.state, "rebooting", "the record said rebooting before the command ran");
  assert.equal(seen?.reboot?.preBootKey, bootKey(BOOT1));
  assert.equal(seen?.reboot?.expectedCommit, SHA_A);
  assert.equal(r.state, "rebooting");
  assert.equal(r.verification, undefined);
  assert.equal(r.finishedAt, undefined);
  assert.equal(readFileSync(activePath(w.cfg), "utf8"), OP, "the slot stays held until the outcome is known");
  assert.ok(!JSON.stringify(r).includes(BOOT1), "the raw boot id is not stored");
  // a retry of the runner unit (or a restart) does nothing
  w.execs.length = 0;
  await run(w, "reboot_host");
  assert.deepEqual(w.execs, []);
});

test("reboot: a refused command is a failure and leaves no reboot expected", async () => {
  const w = world();
  w.script.exec = (f, a) => (a[0] === "reboot" ? fail(1, "Operation inhibited by shutdown lock") : undefined);
  await accept(w, "reboot_host");
  const r = await run(w, "reboot_host");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /refused/);
  assert.equal(existsSync(activePath(w.cfg)), false);
});

test("reboot recovery: a changed boot id plus healthy ORBIT is verified, with evidence; nothing is executed", async () => {
  const w = world();
  await accept(w, "reboot_host");
  await run(w, "reboot_host");
  w.execs.length = 0;
  w.setBoot(BOOT2); // the host came back
  const done = await recoverAfterBoot(w.env, w.cfg, (l) => w.audit.push(l));
  assert.equal(done.length, 1);
  const r = rec(w);
  assert.equal(r.state, "verified");
  assert.equal(r.verification?.checked, true);
  assert.deepEqual(r.verification?.evidence, { preBootKey: bootKey(BOOT1), postBootKey: bootKey(BOOT2), bootChanged: true, rebootIssuedAt: r.reboot!.issuedAt, orbitHealthy: true });
  assert.match(r.summary!, /OpenClaw.*not inspected/);
  assert.deepEqual(w.execs, [], "recovery never runs a command, so it can never relaunch a mutation");
  assert.equal(existsSync(activePath(w.cfg)), false);
  // running recovery again changes nothing
  assert.equal((await recoverAfterBoot(w.env, w.cfg, () => {})).length, 0);
});

test("reboot recovery: unchanged boot id is NOT verified (left rebooting); unhealthy ORBIT is failed, not verified", async () => {
  const w = world();
  await accept(w, "reboot_host");
  await run(w, "reboot_host");
  assert.equal((await recoverAfterBoot(w.env, w.cfg, () => {})).length, 0);
  assert.equal(rec(w).state, "rebooting");
  assert.equal(rec(w).verification, undefined);
  w.setBoot(BOOT2);
  w.script.served = undefined; // ORBIT never came up
  await recoverAfterBoot(w.env, w.cfg, () => {});
  const r = rec(w);
  assert.equal(r.state, "failed");
  assert.equal(r.verification?.evidence?.bootChanged, true);
  assert.equal(r.verification?.evidence?.orbitHealthy, false);
  assert.match(r.summary!, /ORBIT is not healthy afterwards/);
  // wrong commit served after boot
  const w2 = world();
  await accept(w2, "reboot_host");
  await run(w2, "reboot_host");
  w2.setBoot(BOOT2);
  w2.script.served = "f".repeat(40);
  await recoverAfterBoot(w2.env, w2.cfg, () => {});
  assert.equal(rec(w2).state, "failed");
});

test("reboot recovery: with no commit recorded, a boot change alone is unverified (observable recovery is missing)", async () => {
  const w = world();
  rmSync(join(w.cfg.root, "current"));
  await accept(w, "reboot_host");
  await run(w, "reboot_host");
  w.setBoot(BOOT2);
  await recoverAfterBoot(w.env, w.cfg, () => {});
  assert.equal(rec(w).state, "unverified");
  assert.match(rec(w).summary!, /could not be verified/);
});

test("reboot recovery never starts anything: an accepted record is not run after a boot, and an ambiguous one is not relaunched", async () => {
  const w = world();
  await accept(w, "install_os_updates");
  w.setBoot(BOOT2);
  assert.equal((await recoverAfterBoot(w.env, w.cfg, () => {})).length, 0);
  assert.deepEqual(w.execs, []);
  assert.equal(rec(w).state, "accepted");
  // settled as interrupted by the front (runner gone), never relaunched
  w.advance(60_000);
  w.script.exec = (f, a) => (a[0] === "is-active" ? fail(3) : undefined);
  assert.equal((await settleIfDead(w.env, w.cfg, rec(w))).state, "interrupted");
  assert.ok(!calls(w).some((c) => c.includes("start")));
});

test("reboot settling by the front: waits for the recovery, then reports unverified after the grace period, never success", async () => {
  const w = world();
  await accept(w, "reboot_host");
  await run(w, "reboot_host");
  w.script.exec = (f, a) => (a[0] === "is-active" ? fail(3) : undefined);
  // soon after: still waiting
  w.advance(5 * 60_000);
  assert.equal((await settleIfDead(w.env, w.cfg, rec(w))).state, "rebooting");
  // the recovery unit is running: left alone even after the grace period
  w.advance(20 * 60_000);
  w.script.exec = (f, a) => (a[0] === "is-active" ? ok("active\n") : undefined);
  assert.equal((await settleIfDead(w.env, w.cfg, rec(w))).state, "rebooting");
  // grace over, boot unchanged: no reboot observed
  w.script.exec = (f, a) => (a[0] === "is-active" ? fail(3) : undefined);
  const same = await settleIfDead(w.env, w.cfg, rec(w));
  assert.equal(same.state, "unverified");
  assert.match(same.summary!, /no reboot was observed/);
  assert.equal(existsSync(activePath(w.cfg)), false);
  // grace over, boot changed but recovery never wrote a result
  const w2 = world();
  await accept(w2, "reboot_host");
  await run(w2, "reboot_host");
  w2.setBoot(BOOT2);
  w2.advance(20 * 60_000);
  w2.script.exec = (f, a) => (a[0] === "is-active" ? fail(3) : undefined);
  const changed = await settleIfDead(w2.env, w2.cfg, rec(w2));
  assert.equal(changed.state, "unverified");
  assert.match(changed.summary!, /post-boot verification never recorded a result/);
});

test("the slot and the pending reboot survive a helper restart (state lives on disk)", async () => {
  const w = world();
  await accept(w, "reboot_host");
  await run(w, "reboot_host");
  // a "new" helper process reads the same directory
  const next = await send(w, req(w, "install_os_updates", { opId: OP2 }));
  assert.equal(next.error?.code, "busy");
  const status = await send(w, { action: "op_status", opId: OP });
  assert.equal(status.data.operation.state, "rebooting");
  assert.equal(status.data.operation.verification, undefined);
  assert.equal((await send(w, { action: "op_status", opId: OP2 })).error?.code, "not_found");
});

// ---------------------------------------------------------------- Funnel: orbit-jobs node only

const SERVE_ON = { TCP: { "443": { HTTPS: true } }, Web: { [`${JOBS_HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } } } }, AllowFunnel: { [`${JOBS_HOST}:443`]: true } };
type Fun = { self?: object; backend?: string; serve: object[]; command?: Exec };
function tsScript(w: World, f: Fun) {
  let reads = 0;
  w.script.exec = (file, args) => {
    if (!file.endsWith("tailscale")) return undefined;
    if (args[1] === "status") return ok(JSON.stringify({ BackendState: f.backend ?? "Running", Self: f.self ?? { HostName: "orbit-jobs", DNSName: `${JOBS_HOST}.` } }));
    if (args[1] === "serve") return ok(JSON.stringify(f.serve[Math.min(reads++, f.serve.length - 1)]));
    return f.command ?? ok();
  };
}
const tsCalls = (w: World) => w.execs.filter((e) => e.file.endsWith("tailscale"));

test("funnel enable: verified from the orbit-jobs node's own configuration; public reachability is explicitly NOT tested", async () => {
  const w = world();
  tsScript(w, { serve: [{}, SERVE_ON] });
  await accept(w, "funnel_enable");
  const r = await run(w, "funnel_enable");
  assert.equal(r.state, "verified");
  assert.deepEqual(r.verification?.evidence, { node: JOBS_HOST, funnelOn: true, proxy: `http://127.0.0.1:${PORT}`, configChecked: true, externalReachability: "not tested" });
  assert.match(r.summary!, /Public reachability was NOT tested/);
  const mutation = tsCalls(w).find((e) => e.args.includes("funnel"))!;
  assert.deepEqual(mutation.args, [`--socket=${w.cfg.jobsSocket}`, "funnel", "--bg", "--https=443", `http://127.0.0.1:${PORT}`]);
});

test("funnel disable: verified when the node's configuration no longer has Funnel on", async () => {
  const w = world();
  tsScript(w, { serve: [SERVE_ON, {}] });
  await accept(w, "funnel_disable");
  const r = await run(w, "funnel_disable");
  assert.equal(r.state, "verified");
  assert.match(r.summary!, /Funnel is off/);
  assert.deepEqual(tsCalls(w).find((e) => e.args.includes("funnel"))!.args, [`--socket=${w.cfg.jobsSocket}`, "funnel", "--https=443", "off"]);
  assert.equal(r.verification?.evidence?.externalReachability, "not tested");
});

test("funnel: every tailscale call goes to the orbit-jobs socket; the host's own tailscaled is never named or substituted", async () => {
  for (const action of ["funnel_enable", "funnel_disable"] as const) {
    const w = world();
    tsScript(w, { serve: action === "funnel_enable" ? [{}, SERVE_ON] : [SERVE_ON, {}] });
    await accept(w, action);
    await run(w, action);
    assert.ok(tsCalls(w).length >= 3);
    for (const e of tsCalls(w)) {
      assert.equal(e.args[0], `--socket=${w.cfg.jobsSocket}`);
      assert.ok(!e.args.some((a) => /\/run\/tailscale\/|tailscaled\.sock$/.test(a) && a !== `--socket=${w.cfg.jobsSocket}`));
    }
    assert.ok(!calls(w).some((c) => /systemctl|apt-get|reboot/.test(c)));
  }
  // and not in the source either: tier 3 code refers to no other socket path
  const src = ["sys-run.ts", "sys-helper.ts", "sys-core.ts", "sys-protocol.ts"].map((f) => readFileSync(new URL(`../src/ops/${f}`, import.meta.url), "utf8")).join("\n");
  assert.ok(!src.includes("/run/tailscale/"), "the host tailscaled socket is not referenced");
  assert.ok(!/tailscale\s+(up|down|logout|set|cert|ssh|serve\s+--)/.test(src), "no other tailscale subcommand");
});

test("funnel wrong-node / local substitution: a socket that belongs to another node is refused; nothing is changed", async () => {
  for (const self of [
    { HostName: "orbit-dedicated-8", DNSName: "orbit-dedicated-8.tail5bde08.ts.net." }, // the host's own node
    { HostName: "orbit-jobs", DNSName: "orbit-jobs.other-tailnet.ts.net." }, // a look-alike on another tailnet
    { HostName: "orbit-jobs-2", DNSName: JOBS_HOST + "." },
  ]) {
    const w = world();
    tsScript(w, { self, serve: [SERVE_ON] });
    await accept(w, "funnel_disable");
    const r = await run(w, "funnel_disable");
    assert.equal(r.state, "failed", JSON.stringify(self));
    assert.match(r.summary!, /Nothing changed: the node behind that socket is/);
    assert.ok(!tsCalls(w).some((e) => e.args.includes("funnel")), "no funnel command ran");
  }
  const w = world();
  tsScript(w, { backend: "NeedsLogin", serve: [SERVE_ON] });
  await accept(w, "funnel_enable");
  assert.match((await run(w, "funnel_enable")).summary!, /not running/);
});

test("funnel: missing orbit-jobs helper/socket fails closed with actionable instructions, at the front and at the runner", async () => {
  const w = world({ jobsSocket: false });
  const out = await send(w, req(w, "funnel_enable"));
  assert.equal(out.error?.code, "helper_missing");
  assert.match(out.error!.message, /orbit-jobs tailscaled socket is not present/);
  assert.match(out.error!.message, /will not touch the host's own Tailscale/);
  assert.match(out.error!.message, /docs\/orbit-ops-sys\.md/);
  assert.deepEqual(w.execs, []);
  assert.equal(loadRecord(w.cfg, OP), undefined);
  // the socket vanishing between accept and run is also refused
  const w2 = world();
  tsScript(w2, { serve: [{}] });
  await accept(w2, "funnel_enable");
  rmSync(w2.cfg.jobsSocket);
  const r = await run(w2, "funnel_enable");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /socket is missing/);
  assert.deepEqual(w2.execs, []);
  // a host-only action does not need it
  const w3 = world({ jobsSocket: false });
  assert.equal((await send(w3, req(w3, "reboot_host"))).ok, true);
});

test("funnel: the confirmed target must equal the configured orbit-jobs target in orbit.env", async () => {
  const w = world({ orbitEnv: `HOST=127.0.0.1\nPORT=8790\nORBIT_INGRESS_PORT=9999\nORBIT_PUBLIC_JOB_URL=https://${JOBS_HOST}\n` });
  tsScript(w, { serve: [{}] });
  await accept(w, "funnel_enable");
  const r = await run(w, "funnel_enable");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /not the configured orbit-jobs target/);
  assert.deepEqual(w.execs, []);
  const none = world({ orbitEnv: "HOST=127.0.0.1\nPORT=8790\n" });
  await accept(none, "funnel_enable");
  assert.match((await run(none, "funnel_enable")).summary!, /approved Funnel target is unknown/);
  const evil = world({ orbitEnv: `ORBIT_INGRESS_PORT=8791\nORBIT_PUBLIC_JOB_URL=https://evil.example.com\n` });
  await accept(evil, "funnel_enable");
  assert.match((await run(evil, "funnel_enable")).summary!, /invalid/);
});

test("funnel: an unrecognised existing serve configuration is never overwritten or removed", async () => {
  const other = { ...SERVE_ON, Web: { [`${JOBS_HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:1234" } } } } };
  const extra = { ...SERVE_ON, Web: { ...SERVE_ON.Web, [`${JOBS_HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9" } } } } };
  for (const [action, cfg] of [["funnel_enable", other], ["funnel_disable", other], ["funnel_enable", extra], ["funnel_disable", extra]] as const) {
    const w = world();
    tsScript(w, { serve: [cfg] });
    await accept(w, action);
    const r = await run(w, action);
    assert.equal(r.state, "failed", action);
    assert.match(r.summary!, /will not (overwrite|modify)/);
    assert.ok(!tsCalls(w).some((e) => e.args.includes("funnel")));
  }
});

test("funnel: already in the wanted state is no_change and runs no mutation", async () => {
  let w = world();
  tsScript(w, { serve: [SERVE_ON] });
  await accept(w, "funnel_enable");
  assert.equal((await run(w, "funnel_enable")).state, "no_change");
  assert.ok(!tsCalls(w).some((e) => e.args.includes("funnel")));
  w = world();
  tsScript(w, { serve: [{}] });
  await accept(w, "funnel_disable");
  assert.equal((await run(w, "funnel_disable")).state, "no_change");
  assert.ok(!tsCalls(w).some((e) => e.args.includes("funnel")));
});

test("funnel verification semantics: a command that exits 0 but leaves the wrong configuration is failed; an unreadable read-back is unverified", async () => {
  let w = world();
  tsScript(w, { serve: [{}, {}] }); // enable "succeeded" but nothing changed
  await accept(w, "funnel_enable");
  let r = await run(w, "funnel_enable");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /does not match/);
  w = world();
  tsScript(w, { serve: [SERVE_ON, SERVE_ON] }); // disable "succeeded" but funnel is still on
  await accept(w, "funnel_disable");
  assert.equal((await run(w, "funnel_disable")).state, "failed");
  // read-back unreadable
  w = world();
  let reads = 0;
  w.script.exec = (file, args) => {
    if (args[1] === "status") return ok(JSON.stringify({ BackendState: "Running", Self: { HostName: "orbit-jobs", DNSName: `${JOBS_HOST}.` } }));
    if (args[1] === "serve") return reads++ === 0 ? ok("{}") : fail(1, "denied");
    return ok();
  };
  await accept(w, "funnel_enable");
  r = await run(w, "funnel_enable");
  assert.equal(r.state, "unverified");
  assert.match(r.summary!, /Nothing is verified/);
  // the node not answering at all
  w = world();
  await accept(w, "funnel_disable");
  w.script.exec = () => fail(1, "dial unix: connection refused");
  r = await run(w, "funnel_disable");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /did not answer/);
  // a timeout on the funnel command is not success either
  w = world();
  tsScript(w, { serve: [{}, {}], command: { code: null, stdout: "", stderr: "", timedOut: true } });
  await accept(w, "funnel_enable");
  assert.notEqual((await run(w, "funnel_enable")).state, "verified");
});

test("viewFunnel reads the serve configuration conservatively", () => {
  const hp = `${JOBS_HOST}:443`;
  assert.deepEqual(viewFunnel({}, hp), { funnelOn: false, onlyApproved: false, empty: true });
  assert.equal(viewFunnel(SERVE_ON, hp).onlyApproved, true);
  assert.equal(viewFunnel(SERVE_ON, hp).funnelOn, true);
  assert.equal(viewFunnel({ ...SERVE_ON, AllowFunnel: { "other:443": true } }, hp).onlyApproved, false);
  assert.equal(viewFunnel({ ...SERVE_ON, TCP: { "443": {}, "22": {} } }, hp).onlyApproved, false);
  assert.equal(viewFunnel({ Web: { [hp]: { Handlers: { "/": { Proxy: "http://x" }, "/api": { Proxy: "http://y" } } } } }, hp).onlyApproved, false);
});

// ---------------------------------------------------------------- audit and redaction

test("audit lines and results are redacted and bounded; no request body is ever logged", async () => {
  const w = world();
  const secret = ["tskey", "-auth-", "k".repeat(30)].join("");
  aptScript(w, { upgrade: fail(100, `E: failed with ${secret} and password=hunter2hunter2`) });
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  const blob = JSON.stringify([r, w.audit, w.fronts]);
  assert.ok(!blob.includes(secret) && !blob.includes("hunter2hunter2"));
  const pub = JSON.parse(await handle(JSON.stringify({ action: "op_status", opId: OP }), w.env, () => {}, w.cfg));
  assert.ok(!JSON.stringify(pub).includes(secret));
  for (const a of w.fronts) assert.ok(!("target" in a) && !("digest" in a));
  assert.ok(w.fronts.every((a) => a.at && typeof a.bytes === "number"));
  assert.equal(opIdsLookLikeCommits(), true);
});
const opIdsLookLikeCommits = () => /^[0-9a-f]{40}$/.test(sysOpIdFor("proposal-1")) && sysOpIdFor("a") !== sysOpIdFor("b");
