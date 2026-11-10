// Tier 3 privileged side (src/ops/sys-*.ts). Everything runs against FAKES: a fake exec that records every command and answers from a
// script, real temp directories for state, and a fake clock. No test executes apt, systemctl, tailscale or anything else on the host.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Exec, Probe } from "../src/ops/admin-core.ts";
import { SYS_CONFIG, activePath, loadRecord, type SysConfig, type SysEnv } from "../src/ops/sys-core.ts";
import { cancelReboot } from "../src/ops/sys-helper.ts";
import { handle, settleIfDead, type SysAudit } from "../src/ops/sys-helper.ts";
import {
  SYS_ACTIONS,
  SYS_MAX_TTL_MS,
  SYS_MUTATING_ACTIONS,
  planDigestOf,
  parsePlan,
  flagPlan,
  type PlanEntry,
  bootKey,
  parseSysRequest,
  sysDigestOf,
  sysOpIdFor,
  type FunnelTarget,
  type SysMutatingAction,
  type SysRecord,
  type SysTarget,
} from "../src/ops/sys-protocol.ts";
import { awaitSchedule, recoverAfterBoot, runOperation, viewFunnel, type RunKind } from "../src/ops/sys-run.ts";

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
const PLAN_ENTRIES: PlanEntry[] = [["bar", "2.0", "2.1"], ["libfoo1", "1.0", "1.1"]];
const PLAN_DIGEST = planDigestOf(PLAN_ENTRIES);
function req(w: World, action: SysMutatingAction, over: Record<string, unknown> = {}) {
  const target = targetFor(action);
  const bind = action === "install_os_updates" ? { planDigest: (over.planDigest as string | undefined) ?? PLAN_DIGEST } : action === "reboot_host" && over.rebootAt ? { rebootAt: over.rebootAt as string } : {};
  return { action, opId: OP, target, digest: sysDigestOf(action, target, bind), expiresAt: new Date(w.clock() + 10 * 60_000).toISOString(), ...(action === "install_os_updates" ? { planDigest: PLAN_DIGEST } : {}), ...over };
}
const send = async (w: World, r: object) => JSON.parse(await handle(JSON.stringify(r), w.env, (a) => w.fronts.push(a), w.cfg, (l) => w.audit.push(l))) as { ok: boolean; data?: any; error?: { code: string; message: string } };
// The front accepts and dispatches; the runner is then driven directly (as the systemd unit would).
async function accept(w: World, action: SysMutatingAction, over: Record<string, unknown> = {}) {
  const out = await send(w, req(w, action, over));
  assert.equal(out.ok, true, JSON.stringify(out));
  w.execs.length = 0;
  return out;
}
const kindOf = (a: SysMutatingAction | "plan_os_updates"): RunKind => (a === "install_os_updates" ? "update" : a === "plan_os_updates" ? "plan" : a === "reboot_host" ? "reboot" : "funnel");
const run = async (w: World, action: SysMutatingAction | "plan_os_updates", opId = OP) => (await runOperation(opId, kindOf(action), w.env, w.cfg, (l) => w.audit.push(l)))!;
const rec = (w: World, opId = OP) => loadRecord(w.cfg, opId)!;

// ---------------------------------------------------------------- validation: strict, fixed, no room for injection

test("requests are strict: fixed actions only, no extra keys, bad ids/targets/digests/expiries refused", async () => {
  const w = world();
  assert.deepEqual([...SYS_MUTATING_ACTIONS], ["install_os_updates", "reboot_host", "funnel_enable", "funnel_disable"]);
  assert.deepEqual([...SYS_ACTIONS], ["install_os_updates", "reboot_host", "funnel_enable", "funnel_disable", "plan_os_updates", "cancel_reboot", "sys_status", "op_status"]);
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
    const r = await send(w, { action, opId: OP, target, digest: sysDigestOf(action, target, action === "install_os_updates" ? { planDigest: PLAN_DIGEST } : {}), expiresAt: new Date(w.clock() + 60_000).toISOString(), ...(action === "install_os_updates" ? { planDigest: PLAN_DIGEST } : {}) });
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
    const second = await send(w, req(w, action, { opId: OP2 }));
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

test("sys_status reports presence facts only (never a Funnel or reachability claim) and any open operation", async () => {
  const w = world();
  const s = await send(w, { action: "sys_status" });
  assert.equal(s.ok, true);
  assert.deepEqual(Object.keys(s.data).sort(), ["bootKey", "hostname", "installed", "openOperation", "orbitJobsSocketPresent", "rebootCooldownUntil", "rebootRequired", "tier"]);
  assert.equal(s.data.hostname, HOST);
  assert.equal(s.data.orbitJobsSocketPresent, true);
  assert.equal(s.data.bootKey, bootKey(BOOT1));
  assert.equal(s.data.openOperation, null);
  await send(w, req(w, "reboot_host"));
  assert.equal((await send(w, { action: "sys_status" })).data.openOperation.action, "reboot_host");
  const none = world({ jobsSocket: false });
  assert.equal((await send(none, { action: "sys_status" })).data.orbitJobsSocketPresent, false);
});

// ---------------------------------------------------------------- OS updates: plan, then execute exactly that plan

const SUMMARY = (up: number, add = 0, rem = 0) => `${up} upgraded, ${add} newly installed, ${rem} to remove and 0 not upgraded.\n`;
const PLAN2 = `Reading package lists...\nInst libfoo1 [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])\nInst bar [2.0] (2.1 Ubuntu:24.04/noble-security [amd64])\nConf libfoo1 (1.1 Ubuntu:24.04/noble-updates [amd64])\n${SUMMARY(2)}`;
const EMPTY = SUMMARY(0);
const PKGS_BEFORE = "ii libfoo1 1.0\nii bar:amd64 2.0\nii baz 1\nrc old 0\n";
const PKGS_AFTER = "ii libfoo1 1.1\nii bar:amd64 2.1\nii baz 1\n";
type Upd = { audit?: Exec[]; update?: Exec; sim?: Exec[]; upgrade?: Exec; before?: string; after?: string };
function aptScript(w: World, u: Upd = {}) {
  let audits = 0;
  let sims = 0;
  let queries = 0;
  const simList = u.sim ?? [ok(PLAN2), ok(EMPTY)];
  w.script.exec = (file, args) => {
    const name = file.split("/").pop();
    if (name === "dpkg") return (u.audit ?? [ok()])[Math.min(audits++, (u.audit ?? [ok()]).length - 1)];
    if (name === "dpkg-query") return ok(queries++ === 0 ? (u.before ?? PKGS_BEFORE) : (u.after ?? PKGS_AFTER));
    if (name === "apt-get") {
      if (args.includes("update")) return u.update ?? ok();
      if (args.includes("-s")) return simList[Math.min(sims++, simList.length - 1)];
      return u.upgrade ?? ok("done");
    }
    return undefined;
  };
}
const ALLOWED_UPDATE_BINARIES = new Set(["apt-get", "dpkg", "dpkg-query"]);
const PLAN_ID = "3".repeat(40);
const planReq = (opId = PLAN_ID) => ({ action: "plan_os_updates", opId });

test("plan_os_updates: apt-get update (metadata refresh) then apt-get -s upgrade; installs and upgrades NOTHING; the plan is canonical and flagged", async () => {
  const w = world();
  aptScript(w, { sim: [ok(`${PLAN2.replace("Conf", "Conf")}`)] });
  const out = await send(w, planReq());
  assert.equal(out.ok, true);
  assert.deepEqual(calls(w), [`systemctl start --no-block orbit-ops-sys-plan@${PLAN_ID}.service`]);
  w.execs.length = 0;
  const r = await run(w, "plan_os_updates", PLAN_ID);
  assert.equal(r.state, "verified");
  assert.deepEqual(calls(w), ["dpkg --audit", "apt-get -o DPkg::Lock::Timeout=120 update", "apt-get -o DPkg::Lock::Timeout=120 -s upgrade"]);
  assert.ok(!w.execs.some((e) => e.args.includes("upgrade") && !e.args.includes("-s")), "no upgrade, only the simulation");
  assert.deepEqual(r.plan!.upgrades, PLAN_ENTRIES);
  assert.equal(r.plan!.digest, PLAN_DIGEST);
  assert.match(r.summary!, /Only apt metadata was refreshed; no package was installed or upgraded/);
  assert.ok(r.steps.some((s) => /refreshes apt package-list metadata/.test(s.detail)));
  // the plan travels back through op_status (bounded, redacted) with its digest
  const st = await send(w, { action: "op_status", opId: PLAN_ID });
  assert.equal(st.data.operation.plan.digestKey, PLAN_DIGEST.slice(0, 24));
  assert.deepEqual(st.data.operation.plan.upgrades, PLAN_ENTRIES);
  assert.equal(existsSync(activePath(w.cfg)), false, "the slot is free again");
});

test("plan flags: kernel, libc, systemd, openssh and tailscale packages are identified", () => {
  const names = ["linux-image-6.8.0-50-generic", "linux-modules-6.8.0-50-generic", "linux-generic", "libc6", "libc-bin", "libc6:i386", "systemd", "libsystemd0", "libudev1", "udev", "openssh-server", "openssh-client", "tailscale", "curl", "tailscale-archive-keyring", "libcurl4", "linux-firmware"];
  const f = flagPlan(names.map((n) => [n, "1", "2"] as PlanEntry));
  assert.deepEqual(f.kernel, ["linux-image-6.8.0-50-generic", "linux-modules-6.8.0-50-generic", "linux-generic"]);
  assert.deepEqual(f.libc, ["libc6", "libc-bin", "libc6:i386"]);
  assert.deepEqual(f.systemd, ["systemd", "libsystemd0", "libudev1", "udev"]);
  assert.deepEqual(f.openssh, ["openssh-server", "openssh-client"]);
  assert.deepEqual(f.tailscale, ["tailscale"]);
});

test("plan parsing is strict: removals, new packages, malformed lines, missing or disagreeing summaries invalidate the plan", () => {
  const ok2 = parsePlan(PLAN2);
  assert.ok(ok2.ok && ok2.upgrades.length === 2 && ok2.upgrades[0]![0] === "bar", "sorted by package name");
  const p = (s: string) => parsePlan(s);
  assert.equal(p(`Remv oldlib [1]\n${SUMMARY(0, 0, 1)}`).ok, false);
  const rem = p(`Inst a [1] (2 x [amd64])\nRemv oldlib [1]\n${SUMMARY(1, 0, 1)}`);
  assert.equal(rem.ok, false);
  assert.deepEqual(!rem.ok && rem.removals, ["oldlib"]);
  const add = p(`Inst a [1] (2 x [amd64])\nInst brand-new (1 x [amd64])\n${SUMMARY(1, 1)}`);
  assert.equal(add.ok, false);
  assert.deepEqual(!add.ok && add.newInstalls, ["brand-new"]);
  assert.equal(p(`Inst a [1] (2 x [amd64])\n`).ok, false, "no summary line");
  assert.equal(p(`Inst a [1] (2 x [amd64])\n${SUMMARY(2)}`).ok, false, "summary disagrees with the lines");
  assert.equal(p(`Inst weird line without version\n${SUMMARY(1)}`).ok, false, "unparseable Inst line");
  assert.equal(p(`Inst a [1;rm -rf /] (2 x [amd64])\n${SUMMARY(1)}`).ok, false, "a version that is not a version");
  assert.equal(p(`Inst A_B [1] (2 x [amd64])\n${SUMMARY(1)}`).ok, false, "a package name that is not a package name");
  assert.equal(p(`Inst a [1] (2 x [amd64])\nInst a [1] (2 x [amd64])\n${SUMMARY(2)}`).ok, false, "duplicate package");
  assert.equal(p(SUMMARY(0)).ok, true);
  // the digest binds the full canonical plan: any package or version change is a different digest, order is irrelevant
  const base: PlanEntry[] = [["a", "1", "2"], ["b", "1", "2"]];
  assert.equal(planDigestOf(base), planDigestOf([base[1]!, base[0]!]));
  assert.notEqual(planDigestOf(base), planDigestOf([["a", "1", "2"], ["b", "1", "3"]]), "a new target version");
  assert.notEqual(planDigestOf(base), planDigestOf([["a", "1", "2"]]), "a missing package");
  assert.notEqual(planDigestOf(base), planDigestOf([...base, ["c", "1", "2"]]), "an extra package");
  assert.notEqual(planDigestOf(base), planDigestOf([["a", "0", "2"], ["b", "1", "2"]]), "another installed version");
});

test("plan_os_updates failures: busy package manager, failed refresh, malformed or policy-violating simulation: failed, never a plan, nothing killed", async () => {
  const lock = "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (unattended-upgr)";
  const cases: [string, Upd, RegExp][] = [
    ["busy at the refresh", { update: fail(100, lock) }, /holds the package lock.*not interrupted and no lock was removed/],
    ["refresh failed", { update: fail(100, "E: Failed to fetch") }, /refreshing the package lists failed/],
    ["busy at the simulation", { sim: [fail(100, lock)] }, /package manager is busy/],
    ["simulation failed", { sim: [fail(1, "E: boom")] }, /simulation failed \(exit 1\)/],
    ["malformed output", { sim: [ok("Inst x [1] (2 y)\n")] }, /could not be trusted/],
    ["removal", { sim: [ok(`Inst a [1] (2 x [amd64])\nRemv gone [1]\n${SUMMARY(1, 0, 1)}`)] }, /policy refuses.*remove gone/],
    ["new package", { sim: [ok(`Inst fresh (1 x [amd64])\n${SUMMARY(0, 1)}`)] }, /policy refuses.*newly install fresh/],
    ["dirty dpkg", { audit: [ok("half configured: foo")] }, /not in a clean state/],
  ];
  for (const [name, upd, re] of cases) {
    const w = world();
    aptScript(w, upd);
    await send(w, planReq());
    const r = await run(w, "plan_os_updates", PLAN_ID);
    assert.equal(r.state, "failed", name);
    assert.match(r.summary!, re, name);
    assert.equal(r.plan, undefined, name);
    assert.ok(!w.execs.some((e) => e.args.includes("upgrade") && !e.args.includes("-s")), name);
    assert.ok(!/kill|fuser|rm |lsof|pkill/.test(calls(w).join("\n")), name);
    for (const e of w.execs) assert.ok(ALLOWED_UPDATE_BINARIES.has(e.file.split("/").pop()!) || e.file.endsWith("systemctl"), name);
  }
  // a timeout at the refresh
  const w = world();
  aptScript(w);
  const base = w.script.exec;
  w.script.exec = (f, a, ww) => (f.endsWith("apt-get") && a.includes("update") ? { code: null, stdout: "", stderr: "", timedOut: true } : base(f, a, ww));
  await send(w, planReq());
  assert.equal((await run(w, "plan_os_updates", PLAN_ID)).state, "failed");
  // nothing pending: no_change, and only a refresh
  const n = world();
  aptScript(n, { sim: [ok(EMPTY)] });
  await send(n, planReq());
  const nr = await run(n, "plan_os_updates", PLAN_ID);
  assert.equal(nr.state, "no_change");
  assert.match(nr.summary!, /no package was installed or upgraded/);
  // too many packages: refused, never truncated
  const big = world();
  const lines = Array.from({ length: 151 }, (_, i) => `Inst pkg${i} [1] (2 x [amd64])\n`).join("");
  aptScript(big, { sim: [ok(`${lines}${SUMMARY(151)}`)] });
  await send(big, planReq());
  const br = await run(big, "plan_os_updates", PLAN_ID);
  assert.equal(br.state, "failed");
  assert.match(br.summary!, /151 packages.*more than the 150/);
});

test("plan_os_updates shares the one-operation slot: while another operation is open it is busy, and a plan takes no digest or confirmation", async () => {
  const w = world();
  await send(w, req(w, "reboot_host"));
  w.execs.length = 0;
  assert.equal((await send(w, planReq())).error?.code, "busy");
  assert.deepEqual(w.execs, []);
  assert.equal((await send(world(), { ...planReq(), digest: "a".repeat(64) })).error?.code, "bad_arguments");
});

test("OS updates: the confirmed plan only; apt-get upgrade only, verified from dpkg, plan versions and ORBIT health; no apt-get update, no reboot", async () => {
  const w = world();
  aptScript(w);
  writeFileSync(w.cfg.rebootRequiredFile, "*** System restart required ***\n");
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "verified");
  assert.equal(r.verification?.checked, true);
  assert.equal(r.verification?.healthy, true);
  assert.deepEqual(r.verification?.evidence, { planned: 2, aptExit: 0, dpkgAuditClean: true, packagesMissingAfter: 0, versionsNotAsPlanned: 0, upgradablesLeft: 0, rebootRequired: true, rebootPerformed: false, orbitHealthy: true });
  assert.match(r.summary!, /No reboot was performed; the host says a reboot is required \(propose it separately\)/);
  assert.match(r.summary!, /OpenClaw.*not inspected/);
  assert.match(r.summary!, /maintainer scripts may have restarted daemons/);
  assert.ok(!/never restart|no service restart/i.test(JSON.stringify(r)), "no claim that services are never restarted");
  for (const e of w.execs) assert.ok(ALLOWED_UPDATE_BINARIES.has(e.file.split("/").pop()!), e.file);
  const all = calls(w).join("\n");
  assert.ok(!/systemctl|reboot|shutdown|poweroff|needrestart|dist-upgrade|full-upgrade|autoremove|remove|purge|kill|fuser|rm /.test(all), all);
  assert.ok(!w.execs.some((e) => e.args.includes("update")), "the refresh belongs to the plan step; execution never refreshes");
  // the plan is recomputed BEFORE anything is upgraded
  const cs = calls(w);
  assert.ok(cs.findIndex((c) => c.includes(" -s upgrade")) < cs.findIndex((c) => c.includes(" upgrade") && !c.includes(" -s ")));
  const upgrade = w.execs.find((e) => e.args.includes("upgrade") && !e.args.includes("-s"))!;
  assert.deepEqual(upgrade.args, ["-y", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef", "-o", "DPkg::Lock::Timeout=120", "upgrade"]);
  for (const e of w.execs.filter((x) => x.file.endsWith("apt-get"))) assert.equal((e.opts as { noKill?: boolean }).noKill, true);
  assert.equal((upgrade.opts as { env: Record<string, string> }).env.NEEDRESTART_SUSPEND, "1");
  assert.equal((upgrade.opts as { env: Record<string, string> }).env.DEBIAN_FRONTEND, "noninteractive");
  assert.equal(existsSync(activePath(w.cfg)), false);
});

test("OS updates plan drift: a different package or version at execution is refused BEFORE installing, and a new proposal is required", async () => {
  const drifts: [string, string][] = [
    ["a new version", PLAN2.replace("(2.1 ", "(2.2 ")],
    ["an extra package", `Inst extra [1] (2 x [amd64])\n${PLAN2.replace(SUMMARY(2), "")}${SUMMARY(3)}`],
    ["a package gone", `Inst bar [2.0] (2.1 Ubuntu:24.04/noble-security [amd64])\n${SUMMARY(1)}`],
    ["nothing pending any more", EMPTY],
  ];
  for (const [name, sim] of drifts) {
    const w = world();
    aptScript(w, { sim: [ok(sim)] });
    await accept(w, "install_os_updates");
    const r = await run(w, "install_os_updates");
    assert.equal(r.state, "failed", name);
    assert.match(r.summary!, /no longer the plan you confirmed.*Ask for a new plan/, name);
    assert.equal(r.verification?.checked, true, name);
    assert.ok(!w.execs.some((e) => e.args.includes("upgrade") && !e.args.includes("-s")), `${name}: nothing was upgraded`);
    assert.ok(!w.execs.some((e) => e.file.endsWith("dpkg-query")), name);
  }
  // an install request whose plan digest is not the plan on the host is refused the same way, and a request with no plan is refused at the front
  const w = world();
  aptScript(w);
  await accept(w, "install_os_updates", { planDigest: "f".repeat(64) });
  assert.equal((await run(w, "install_os_updates")).state, "failed");
  const bare = req(w, "install_os_updates");
  delete (bare as Record<string, unknown>).planDigest;
  assert.equal((await send(w, { ...bare, opId: OP2 })).error?.code, "bad_arguments");
});

test("OS updates: a policy-violating or malformed simulation at execution is refused before any change", async () => {
  for (const [sim, re] of [
    [`Inst a [1] (2 x [amd64])\nRemv oldlib [1]\n${SUMMARY(1, 0, 1)}`, /remove oldlib/],
    [`Inst a [1] (2 x [amd64])\nInst brand-new (1 x [amd64])\n${SUMMARY(1, 1)}`, /newly install brand-new/],
    ["garbage", /could not be trusted/],
  ] as const) {
    const w = world();
    aptScript(w, { sim: [ok(sim)] });
    await accept(w, "install_os_updates");
    const r = await run(w, "install_os_updates");
    assert.equal(r.state, "failed");
    assert.match(r.summary!, re);
    assert.ok(!w.execs.some((e) => e.args.includes("upgrade") && !e.args.includes("-s")), "no real upgrade ran");
  }
});

test("OS updates: package-manager contention at execution fails safely, kills nothing and removes no lock", async () => {
  const lock = "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (unattended-upgr)";
  const w = world();
  aptScript(w, { sim: [fail(100, lock)] });
  await accept(w, "install_os_updates");
  const r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /package manager is busy.*not interrupted and no lock was removed/);
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
  assert.ok(w2.execs.find((e) => e.args.includes("-s"))!.args.includes("DPkg::Lock::Timeout=120"), "the lock wait is bounded by apt itself, not by killing it");
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
  let w = world();
  aptScript(w, { upgrade: fail(100, "E: Sub-process /usr/bin/dpkg returned an error code (1)") });
  await accept(w, "install_os_updates");
  let r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /apt-get upgrade failed \(exit 100\); packages may be partly upgraded/);
  w = world();
  aptScript(w, { audit: [ok(), ok("half configured: bar")] });
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /dpkg --audit reports problems/);
  w = world();
  aptScript(w, { after: "ii libfoo1 1.1\nii bar 2.1\n" });
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /no longer installed \(baz\)/);
  assert.equal(r.verification?.healthy, false);
  // exit 0 and clean, but a package is not at the planned version (lists changed under the upgrade): unverified, never verified
  w = world();
  aptScript(w, { after: "ii libfoo1 1.1\nii bar 2.9\nii baz 1\n" });
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "unverified");
  assert.match(r.summary!, /not at the version in the confirmed plan \(bar\)/);
  w = world();
  aptScript(w);
  w.script.served = undefined;
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /ORBIT is not healthy afterwards.*Nothing was restarted or rolled back by this tool/);
  w = world();
  aptScript(w);
  rmSync(join(w.cfg.root, "current"));
  await accept(w, "install_os_updates");
  r = await run(w, "install_os_updates");
  assert.equal(r.state, "unverified");
});

test("OS updates: a timeout at the simulation fails the operation and never claims success", async () => {
  const w = world();
  aptScript(w);
  const base = w.script.exec;
  w.script.exec = (f, a, ww) => (f.endsWith("apt-get") && a.includes("-s") ? { code: null, stdout: "", stderr: "", timedOut: true } : base(f, a, ww));
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
  const again = await run(w, "install_os_updates");
  assert.equal(again.state, "failed");
  assert.deepEqual(w.execs, []);
  assert.ok(w.audit.some((a) => /not run again/.test(JSON.stringify(a))));
  const w2 = world();
  aptScript(w2);
  await accept(w2, "install_os_updates");
  w2.advance(11 * 60_000);
  const r2 = await run(w2, "install_os_updates");
  assert.equal(r2.state, "failed");
  assert.match(r2.summary!, /expired/);
  assert.deepEqual(w2.execs, []);
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

// ================================================================= stale-slot takeover: atomic, deterministic races

import { retireSlot, tryAcquireSlot, readSlot, releaseSlot, saveRecord, rebootStampPath, decide } from "../src/ops/sys-core.ts";
import { utimesSync } from "node:fs";
import { REBOOT_MAX_AHEAD_MS } from "../src/ops/sys-protocol.ts";

const OP3 = "3".repeat(40);
const OP4 = "4".repeat(40);
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const starts = (w: World) => calls(w).filter((c) => c.startsWith("systemctl start"));
const settle = () => new Promise<void>((r) => setImmediate(r));
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await settle();
  assert.ok(cond(), "condition never became true");
};
// A stale holder: a record that is running, quiet for longer than staleAfterMs, whose runner is gone (is-active fails).
async function staleHolder(w: World) {
  await accept(w, "funnel_enable");
  const r = rec(w);
  r.state = "running";
  saveRecord(w.cfg, r, w.env);
  w.advance(60_000);
  w.script.exec = (f, a) => (a[0] === "is-active" ? fail(3) : undefined);
}
// Pause the first `n` is-active calls (the stale-holder check) at a gate.
function gateIsActive(w: World, n: number) {
  const gate = defer();
  let arrived = 0;
  const inner = w.env.exec;
  w.env.exec = async (f, a, t, o) => {
    if (a[0] === "is-active") {
      arrived++;
      if (arrived <= n) await gate.promise;
    }
    return inner(f, a, t, o);
  };
  return { gate, arrived: () => arrived };
}

test("stale slot: two simultaneous requests that both saw the stale holder cannot both take over: at most one dispatch", async () => {
  const w = world();
  await staleHolder(w);
  const g = gateIsActive(w, 2);
  w.execs.length = 0;
  const a = send(w, req(w, "funnel_enable", { opId: OP2 }));
  const b = send(w, req(w, "funnel_enable", { opId: OP3 }));
  await waitFor(() => g.arrived() === 2); // both have read the stale holder and are inside the settle check
  g.gate.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal([ra, rb].filter((r) => r.ok).length, 1, JSON.stringify([ra, rb]));
  assert.equal([ra, rb].filter((r) => r.error?.code === "busy").length, 1);
  assert.equal(starts(w).length, 1, "exactly one runner was started");
  const winner = ra.ok ? OP2 : OP3;
  assert.equal(readSlot(w.cfg), winner, "the slot belongs to the one that was dispatched");
  assert.equal(loadRecord(w.cfg, winner === OP2 ? OP3 : OP2), undefined, "the loser recorded nothing");
});

test("stale slot: a request that saw the stale holder must not delete the replacement holder's slot when it resumes late", async () => {
  const w = world();
  await staleHolder(w);
  const g = gateIsActive(w, 1); // only the first contender is paused
  w.execs.length = 0;
  const slow = send(w, req(w, "funnel_enable", { opId: OP2 }));
  await waitFor(() => g.arrived() === 1);
  const fast = await send(w, req(w, "funnel_enable", { opId: OP3 })); // takes over completely while `slow` is paused
  assert.equal(fast.ok, true);
  assert.equal(readSlot(w.cfg), OP3);
  g.gate.resolve();
  const late = await slow;
  assert.equal(late.error?.code, "busy");
  assert.equal(readSlot(w.cfg), OP3, "the replacement holder's slot is intact");
  assert.equal(starts(w).length, 1);
  assert.equal(loadRecord(w.cfg, OP2), undefined);
  // and the stale holder's own late release (its runner finishing after being replaced) cannot remove it either
  releaseSlot(w.cfg, OP);
  assert.equal(readSlot(w.cfg), OP3);
});

test("slot primitives: acquisition is all-or-nothing, retirement belongs to exactly one party, and nothing removes a slot it does not hold", async () => {
  const w = world();
  mkdirSync(w.cfg.stateDir, { recursive: true });
  assert.equal(tryAcquireSlot(w.cfg, OP), true);
  assert.equal(readFileSync(activePath(w.cfg), "utf8"), OP, "complete content as soon as it exists");
  assert.equal(tryAcquireSlot(w.cfg, OP2), false);
  assert.equal(readSlot(w.cfg), OP);
  assert.equal(retireSlot(w.cfg, OP2), false, "not the holder: nothing happens");
  assert.equal(readSlot(w.cfg), OP);
  assert.equal(retireSlot(w.cfg, OP), true);
  assert.equal(retireSlot(w.cfg, OP), false, "a holder is retired once");
  assert.equal(readSlot(w.cfg), undefined);
  assert.equal(tryAcquireSlot(w.cfg, OP2), true);
  assert.equal(retireSlot(w.cfg, OP), false, "a second retirement of the OLD holder cannot touch the new slot");
  assert.equal(readSlot(w.cfg), OP2);
  assert.deepEqual(readdirSync(w.cfg.stateDir).filter((n) => n.endsWith(".tmp")), [], "no temp files are left behind");
});

test("slot with no record: a young one is busy (a request mid-accept), an old one is retired, an unreadable one fails closed", async () => {
  const w = world();
  mkdirSync(w.cfg.stateDir, { recursive: true });
  writeFileSync(activePath(w.cfg), OP, { mode: 0o600 });
  assert.equal((await send(w, req(w, "funnel_enable", { opId: OP2 }))).error?.code, "busy");
  assert.equal(readSlot(w.cfg), OP, "the young slot was not removed");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(activePath(w.cfg), old, old);
  const taken = await send(w, req(w, "funnel_enable", { opId: OP2 }));
  assert.equal(taken.ok, true);
  assert.equal(readSlot(w.cfg), OP2);
  const w2 = world();
  mkdirSync(w2.cfg.stateDir, { recursive: true });
  writeFileSync(activePath(w2.cfg), "not an op id", { mode: 0o600 });
  const e = await send(w2, req(w2, "funnel_enable"));
  assert.equal(e.error?.code, "busy");
  assert.match(e.error!.message, /did not write/);
  assert.equal(readFileSync(activePath(w2.cfg), "utf8"), "not an op id");
});

// ================================================================= reboot cool-down

test("cool-down counts reboots actually ISSUED: a request that never issued one (dispatch failed, wrong host, expired) starts none", async () => {
  // runner could not be started
  let w = world();
  w.script.exec = () => fail(1, "Failed to start");
  assert.equal((await send(w, req(w, "reboot_host"))).data.operation.state, "failed");
  w.script.exec = () => undefined;
  const again = await send(w, req(w, "reboot_host", { opId: OP2 }));
  assert.equal(again.ok, true, "a retry right after a dispatch that did nothing is accepted");
  // runner refused (wrong host)
  w = world();
  await accept(w, "reboot_host");
  w.host.name = "imposter";
  assert.equal((await run(w, "reboot_host")).state, "failed");
  w.host.name = HOST;
  assert.equal((await send(w, req(w, "reboot_host", { opId: OP2 }))).ok, true);
  // reboot command itself refused by systemd: nothing was issued, so no cool-down
  w = world();
  await accept(w, "reboot_host");
  w.script.exec = (f, a) => (f.endsWith("systemctl") && a[0] === "reboot" ? fail(1, "Access denied") : undefined);
  const refused = await run(w, "reboot_host");
  assert.equal(refused.state, "failed");
  assert.equal(refused.reboot, undefined);
  assert.equal(existsSync(rebootStampPath(w.cfg)), false);
  assert.equal((await send(w, req(w, "reboot_host", { opId: OP2 }))).ok, true);
});

test("cool-down starts when the reboot is issued (not accepted), survives record pruning, and is checked while holding the slot", async () => {
  const w = world();
  await accept(w, "reboot_host");
  w.advance(5 * 60_000); // e.g. a long wait for the deploy lock between acceptance and the command
  await run(w, "reboot_host");
  const issued = rec(w).reboot!.issuedAt;
  assert.equal(readFileSync(rebootStampPath(w.cfg), "utf8"), issued);
  // finish the reboot as the recovery would, so the slot is free
  const r = rec(w);
  r.state = "verified";
  saveRecord(w.cfg, r, w.env);
  rmSync(activePath(w.cfg), { force: true });
  rmSync(join(w.cfg.stateDir, "retired"), { recursive: true, force: true });
  w.advance(25 * 60_000); // 25 min after ISSUE (30 min after acceptance + ... still inside the issue-anchored window)
  const soon = await send(w, req(w, "reboot_host", { opId: OP2 }));
  assert.equal(soon.error?.code, "cooldown");
  assert.equal(existsSync(activePath(w.cfg)), false, "a refused request gives the slot straight back");
  assert.equal(loadRecord(w.cfg, OP2), undefined);
  assert.equal((await send(w, { action: "sys_status" })).data.rebootCooldownUntil, new Date(Date.parse(issued) + w.cfg.rebootCooldownMs).toISOString());
  // records may be pruned: the stamp still enforces it
  rmSync(join(w.cfg.stateDir, "ops", `${OP}.json`));
  assert.equal((await send(w, req(w, "reboot_host", { opId: OP2 }))).error?.code, "cooldown");
  w.advance(6 * 60_000);
  assert.equal((await send(w, req(w, "reboot_host", { opId: OP2 }))).ok, true);
  assert.equal((await send(w, { action: "sys_status" })).data.rebootCooldownUntil, new Date(Date.parse(issued) + w.cfg.rebootCooldownMs).toISOString() > new Date(w.clock()).toISOString() ? (await send(w, { action: "sys_status" })).data.rebootCooldownUntil : null);
});

// ================================================================= scheduling and cancellation

const inMin = (w: World, m: number) => new Date(w.clock() + m * 60_000).toISOString();
const sched = (w: World, m: number, over: Record<string, unknown> = {}): ReturnType<typeof req> & { rebootAt: string } => {
  const rebootAt = inMin(w, m);
  return { ...req(w, "reboot_host", { rebootAt, ...over }), rebootAt };
};
const alive = (w: World) => void (w.script.exec = (f, a) => (a[0] === "is-active" ? ok("active\n") : undefined));
const nonProbe = (w: World) => calls(w).filter((c) => !c.includes("is-active"));
const cancel = (w: World, opId = OP) => send(w, { action: "cancel_reboot", opId });

test("scheduled reboot: time validation is strict (canonical UTC, at least 60 s and at most 24 h ahead), enforced by the helper, nothing recorded when refused", async () => {
  const w = world();
  const bad = async (rebootAt: unknown, code = "bad_arguments") => {
    const r = await send(w, { ...req(w, "reboot_host"), rebootAt });
    assert.equal(r.error?.code, code, String(rebootAt));
    assert.equal(loadRecord(w.cfg, OP), undefined);
  };
  await bad("2026-11-09T14:00:00Z"); // not canonical (no millis)
  await bad("2026-11-09 14:00:00.000Z");
  await bad("tomorrow");
  await bad(12345);
  await bad("2026-11-09T14:00:00.000+01:00");
  // digest must bind the time: the "now" digest with a time attached, or a time with a different time's digest, is refused
  const at = inMin(w, 120);
  assert.equal((await send(w, { ...req(w, "reboot_host"), rebootAt: at })).error?.code, "digest_mismatch");
  const other = inMin(w, 121);
  assert.equal((await send(w, { ...req(w, "reboot_host", { rebootAt: at }), rebootAt: other })).error?.code, "digest_mismatch");
  // too close, in the past, too far (helper-side rules, with a digest that matches)
  const dig = (rebootAt: string) => ({ ...req(w, "reboot_host", { rebootAt }) });
  for (const rebootAt of [new Date(w.clock() + 59_999).toISOString(), new Date(w.clock() - 1000).toISOString(), new Date(w.clock() + REBOOT_MAX_AHEAD_MS + 1).toISOString()]) {
    const r = await send(w, dig(rebootAt));
    assert.equal(r.error?.code, "bad_arguments", rebootAt);
    assert.match(r.error!.message, /at least 60 seconds|no more than 24 hours/);
  }
  assert.deepEqual(w.execs, [], "nothing was started for any refused time");
  // the edges are accepted
  assert.equal((await send(w, dig(new Date(w.clock() + 60_000).toISOString()))).ok, true);
  const w2 = world();
  assert.equal((await send(w2, req(w2, "reboot_host", { rebootAt: new Date(w2.clock() + REBOOT_MAX_AHEAD_MS).toISOString() }))).ok, true);
  // only a reboot may carry a time
  assert.equal((await send(w, { ...req(w, "funnel_enable", { opId: OP2 }), rebootAt: inMin(w, 5) })).error?.code, "bad_arguments");
});

test("scheduled reboot: accepted as 'scheduled' (nothing done), runner started at once, state persisted for any later reader, duplicates busy or replayed", async () => {
  const w = world();
  const r = sched(w, 120);
  const out = await send(w, r);
  assert.equal(out.ok, true);
  assert.equal(out.data.operation.state, "scheduled");
  assert.equal(out.data.operation.schedule.at, r.rebootAt);
  assert.match(out.data.note, /Nothing is verified yet/);
  assert.deepEqual(calls(w), [`systemctl start --no-block orbit-ops-sys-reboot@${OP}.service`], "no reboot, only the runner that will wait");
  assert.equal(readFileSync(activePath(w.cfg), "utf8"), OP, "the slot is held while it is scheduled");
  // another process/reader sees it
  const st = await send(w, { action: "sys_status" });
  assert.deepEqual(st.data.openOperation, { opId: OP, action: "reboot_host", state: "scheduled", scheduledFor: r.rebootAt });
  assert.equal((await send(w, { action: "op_status", opId: OP })).data.operation.state, "scheduled");
  // a second reboot (or anything else) while one is scheduled is busy; the same operation id is a replay
  w.execs.length = 0;
  assert.equal((await send(w, sched(w, 180, { opId: OP2 }))).error?.code, "busy");
  assert.equal((await send(w, req(w, "install_os_updates", { opId: OP3 }))).error?.code, "busy");
  w.script.exec = (f, a) => (a[0] === "is-active" ? ok("active\n") : undefined);
  const again = await send(w, r);
  assert.equal(again.data.replayed, true);
  assert.ok(!calls(w).some((c) => c.startsWith("systemctl start")), "never dispatched twice");
  // an unfired scheduled record whose runner is alive is left alone for hours
  w.advance(90 * 60_000);
  assert.equal((await send(w, { action: "op_status", opId: OP })).data.operation.state, "scheduled");
});

test("scheduled reboot: waits without doing anything, fires only at its time, then issues exactly one reboot; the confirmation's expiry does not apply after acceptance", async () => {
  const w = world();
  const r = sched(w, 180);
  await accept(w, "reboot_host", r);
  const at = Date.parse(r.rebootAt as string);
  assert.equal(await awaitSchedule(w.env, w.cfg, OP, (l) => w.audit.push(l)), "due");
  assert.deepEqual(w.execs, [], "the wait runs no command (and in production holds no lock)");
  assert.ok(w.clock() >= at && w.clock() < at + 20_000, "it did not fire early or late");
  assert.equal(rec(w).state, "accepted");
  assert.ok(rec(w).steps.some((s) => s.step === "due"));
  const done = await run(w, "reboot_host");
  assert.equal(done.state, "rebooting", "never success");
  assert.deepEqual(calls(w).filter((c) => c.startsWith("systemctl reboot")), ["systemctl reboot"]);
  assert.ok(Date.parse(done.reboot!.issuedAt) >= at, "issued at or after the scheduled time");
  assert.equal(done.reboot!.preBootKey, bootKey(BOOT1));
  // a second look at the same record never issues again
  w.execs.length = 0;
  assert.equal(await awaitSchedule(w.env, w.cfg, OP, () => {}), "not_scheduled");
  await run(w, "reboot_host");
  assert.deepEqual(w.execs, []);
});

test("scheduled reboot: the confirmation must still be valid when it is accepted", async () => {
  const w = world();
  const r = sched(w, 180, { expiresAt: new Date(w.clock() - 1000).toISOString() });
  assert.equal((await send(w, r)).error?.code, "expired");
  assert.equal(loadRecord(w.cfg, OP), undefined);
});

test("cancel before it fires: recorded, audited, slot freed, no reboot ever issued, repeated cancels are idempotent", async () => {
  const w = world();
  await accept(w, "reboot_host", sched(w, 120));
  const out = await cancel(w);
  assert.equal(out.ok, true);
  assert.equal(out.data.cancelled, true);
  assert.equal(out.data.operation.state, "cancelled");
  assert.match(out.data.note, /no reboot was issued/);
  const r = rec(w);
  assert.equal(r.state, "cancelled");
  assert.ok(r.finishedAt);
  assert.ok(r.steps.some((s) => s.step === "cancelled"), "recorded in the operation's own history");
  assert.ok(w.audit.some((a) => (a as { step?: string }).step === "cancelled" && (a as { opId?: string }).opId === OP.slice(0, 12)), "audited in the journal");
  assert.ok(w.fronts.some((f) => f.action === "cancel_reboot" && f.outcome === "accepted"), "audited as a request");
  assert.equal(existsSync(activePath(w.cfg)), false);
  // the runner that wakes up later does nothing, and does not overwrite the cancelled record
  assert.equal(await awaitSchedule(w.env, w.cfg, OP, () => {}), "not_scheduled");
  assert.equal((await run(w, "reboot_host")).state, "cancelled");
  assert.deepEqual(w.execs, []);
  // duplicate cancel: still cancelled, nothing new
  const stepsBefore = rec(w).steps.length;
  const dup = await cancel(w);
  assert.equal(dup.ok, true);
  assert.equal(dup.data.alreadyCancelled, true);
  assert.equal(rec(w).steps.length, stepsBefore);
  // a new reboot can then be accepted: cancelling issued nothing, so no cool-down
  assert.equal((await send(w, req(w, "reboot_host", { opId: OP2 }))).ok, true);
});

test("cancel while the runner is waiting: the wait ends as cancelled and never reboots", async () => {
  const w = world();
  const r = sched(w, 120);
  await accept(w, "reboot_host", r);
  alive(w);
  let sleeps = 0;
  const innerSleep = w.env.sleep;
  w.env.sleep = async (ms) => {
    await innerSleep(ms);
    if (++sleeps === 3) assert.equal((await cancel(w)).ok, true);
  };
  assert.equal(await awaitSchedule(w.env, w.cfg, OP, () => {}), "cancelled");
  assert.ok(w.clock() < Date.parse(r.rebootAt as string), "it stopped before the scheduled time");
  assert.equal(rec(w).state, "cancelled");
  assert.deepEqual(nonProbe(w), []);
});

test("cancel after it fired is REFUSED, not reported as success: the reboot is dispatched and stays so", async () => {
  const w = world();
  await accept(w, "reboot_host", sched(w, 60));
  assert.equal(await awaitSchedule(w.env, w.cfg, OP, () => {}), "due");
  const late = await cancel(w);
  assert.equal(late.ok, false);
  assert.equal(late.error?.code, "too_late");
  assert.match(late.error!.message, /already been dispatched.*NOT cancelled/);
  assert.notEqual(rec(w).state, "cancelled");
  assert.equal((await run(w, "reboot_host")).state, "rebooting");
  // and once it is running, rebooting, or finished, the answer is the same or "nothing to cancel"
  const rebooting = await cancel(w);
  assert.equal(rebooting.error?.code, "too_late");
  const r = rec(w);
  r.state = "verified";
  saveRecord(w.cfg, r, w.env);
  assert.equal((await cancel(w)).error?.code, "not_cancellable");
  assert.equal((await send(w, { action: "cancel_reboot", opId: OP4 })).error?.code, "not_found");
});

test("cancel versus fire race: exactly one of them wins, whichever arrives first, and the outcome is consistent", async () => {
  // fire first: the cancel is paused (settle check) while the runner claims; the cancel then loses
  let w = world();
  await accept(w, "reboot_host", sched(w, 60));
  w.advance(5 * 60_000); // the record is quiet: cancel will consult the runner unit before deciding
  w.script.exec = (f, a) => (a[0] === "is-active" ? ok("active\n") : undefined);
  const g = gateIsActive(w, 1);
  const cancelling = cancel(w);
  await waitFor(() => g.arrived() === 1);
  assert.equal(await awaitSchedule(w.env, w.cfg, OP, () => {}), "due", "the runner is past its time and claims first");
  g.gate.resolve();
  const lost = await cancelling;
  assert.equal(lost.error?.code, "too_late");
  assert.equal((await run(w, "reboot_host")).state, "rebooting");
  // cancel first: the runner is paused right before it claims; the cancel wins; the runner stops
  w = world();
  const r = sched(w, 60);
  await accept(w, "reboot_host", r);
  alive(w);
  const gate = defer();
  let paused = false;
  const innerSleep = w.env.sleep;
  w.env.sleep = async (ms) => {
    await innerSleep(ms);
    if (!paused && w.clock() >= Date.parse(r.rebootAt as string)) {
      paused = true;
      await gate.promise; // due, but has not claimed yet
    }
  };
  const waiting = awaitSchedule(w.env, w.cfg, OP, () => {});
  await waitFor(() => paused);
  assert.equal((await cancel(w)).ok, true);
  gate.resolve();
  assert.equal(await waiting, "cancelled");
  assert.equal(rec(w).state, "cancelled");
  assert.deepEqual(nonProbe(w), [], "no reboot after a successful cancel");
  assert.deepEqual(decide(w.cfg, OP, "fire"), { won: false, decision: "cancel" });
  // the arbiter itself: a decision is made once
  assert.deepEqual(decide(world().cfg, OP, "cancel").won, true);
});

test("an immediate reboot can be cancelled until its runner claims it; a cancelled record is never overwritten by that runner", async () => {
  const w = world();
  await accept(w, "reboot_host");
  assert.equal((await cancel(w)).ok, true);
  const r = await run(w, "reboot_host");
  assert.equal(r.state, "cancelled");
  assert.equal(rec(w).state, "cancelled");
  assert.ok(rec(w).steps.some((s) => s.step === "cancelled"));
  assert.deepEqual(w.execs, []);
  assert.ok(w.audit.some((a) => /already cancelled/.test(JSON.stringify(a))));
});

test("only a reboot can be cancelled; a dead scheduled runner is settled truthfully (no reboot was issued) and is no longer cancellable", async () => {
  const w = world();
  await accept(w, "funnel_enable");
  assert.equal((await cancel(w)).error?.code, "not_cancellable");
  assert.equal(rec(w).state, "accepted");
  const w2 = world();
  await accept(w2, "reboot_host", sched(w2, 120));
  w2.advance(60_000); // the runner is gone (host restarted for another reason)
  w2.script.exec = (f, a) => (a[0] === "is-active" ? fail(3) : undefined);
  const st = await send(w2, { action: "op_status", opId: OP });
  assert.equal(st.data.operation.state, "interrupted");
  assert.match(st.data.operation.summary, /scheduled reboot's runner stopped.*NO reboot was issued.*will not fire later/);
  assert.equal((await cancel(w2)).error?.code, "not_cancellable");
  assert.equal(existsSync(activePath(w2.cfg)), false);
});

test("cool-down and schedules: a time inside the cool-down is refused at acceptance, a later one is accepted, and the cool-down is rechecked when it fires", async () => {
  const w = world();
  const last = new Date(w.clock() - 10 * 60_000).toISOString();
  mkdirSync(w.cfg.stateDir, { recursive: true });
  writeFileSync(rebootStampPath(w.cfg), last);
  const early = await send(w, sched(w, 5)); // fires 15 min after the last one: too soon
  assert.equal(early.error?.code, "cooldown");
  assert.equal(loadRecord(w.cfg, OP), undefined);
  assert.equal(existsSync(activePath(w.cfg)), false);
  const okLater = await send(w, sched(w, 60)); // fires 70 min after: fine
  assert.equal(okLater.ok, true);
  // another reboot is issued (by hand, or by tier 3 before this was accepted elsewhere) before it fires
  assert.equal(await awaitSchedule(w.env, w.cfg, OP, () => {}), "due");
  writeFileSync(rebootStampPath(w.cfg), new Date(w.clock() - 60_000).toISOString());
  w.execs.length = 0;
  const r = await run(w, "reboot_host");
  assert.equal(r.state, "failed");
  assert.match(r.summary!, /cool-down.*Nothing was issued/);
  assert.ok(!calls(w).some((c) => c.includes("reboot")), "no reboot command");
});
