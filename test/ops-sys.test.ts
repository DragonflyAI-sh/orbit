// Tier 3, ORBIT's side: proposals, owner confirmation, job-state checks, the ledger, the chat tools, the HTTP routes and the client.
// The helper is a FAKE client that records every call: nothing here reaches a host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { chatTools } from "../src/chat-tools.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import { vaultMemory } from "../src/memory.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { notifier } from "../src/notify.ts";
import { PLAN_MAX_POLLS, jobStateOf, sysOps, type JobsSnapshot, type SysLedgerEntry } from "../src/ops-sys.ts";
import { sysClient, type SysClient, type SysReply } from "../src/ops-sys-client.ts";
import { decide } from "../src/policy.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";
import { flagPlan, planDigestOf, sysDigestOf, sysOpIdFor, type PlanEntry } from "../src/ops/sys-protocol.ts";

const HOST = "orbit-dedicated-8";
const JOBS_HOST = "orbit-jobs.tail5bde08.ts.net";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(new URL(`../${p}`, import.meta.url))).digest("hex");

const PLAN: PlanEntry[] = [["bar", "2.0", "2.1"], ["libfoo1", "1.0", "1.1"], ["openssh-server", "1:9.6", "1:9.6p1-3ubuntu13.5"], ["linux-image-6.8.0-50-generic", "6.8.0-49", "6.8.0-50"]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)) as PlanEntry[];
const PLAN_D = planDigestOf(PLAN);
const planOp = (upgrades: PlanEntry[] = PLAN, state = "verified") => ({ state, plan: { upgrades, flags: flagPlan(upgrades), digestKey: planDigestOf(upgrades).slice(0, 24) } });
type Call = Record<string, unknown> & { action: string };
function fakeClient(opts: { status?: Record<string, unknown> | SysReply; answer?: (c: Call) => SysReply | Promise<SysReply> } = {}) {
  const calls: Call[] = [];
  const status: SysReply = opts.status && "ok" in opts.status ? (opts.status as SysReply) : { ok: true, data: { hostname: HOST, orbitJobsSocketPresent: true, openOperation: null, ...(opts.status ?? {}) } };
  const client: SysClient = {
    call: async (req) => {
      const c = req as Call;
      calls.push(c);
      if (c.action === "sys_status") return status;
      if (c.action === "plan_os_updates" && !opts.answer) return { ok: true, data: { operation: planOp() } };
      return (opts.answer ?? ((x) => ({ ok: true, data: { operation: { state: x.action === "op_status" ? "running" : "accepted" } } })))(c);
    },
  };
  return { client, calls, mutations: () => calls.filter((c) => c.action !== "sys_status" && c.action !== "op_status" && c.action !== "plan_os_updates"), plans: () => calls.filter((c) => c.action === "plan_os_updates") };
}

const quiet: JobsSnapshot = { known: true, active: [], uncertain: [], detail: "none" };
function ledger(o: { client?: SysClient; jobState?: () => JobsSnapshot; jobsTarget?: () => { host: string; port: number } | undefined; now?: () => Date; store?: ReturnType<typeof jsonStore<SysLedgerEntry[]>>; proposals?: ReturnType<typeof newProposals> } = {}) {
  const store = o.store ?? jsonStore<SysLedgerEntry[]>(undefined, "ops-sys", []);
  const notify = notifier(jsonStore(undefined, "n", []));
  const proposals = o.proposals ?? newProposals(o.now);
  const sys = sysOps({ client: o.client, store, notify, proposals, jobState: o.jobState ?? (() => quiet), jobsTarget: o.jobsTarget ?? (() => ({ host: JOBS_HOST, port: 8791 })), now: o.now });
  return { sys, store, notify, proposals };
}
const confirm = (h: ReturnType<typeof ledger>, p: { id: string }) => h.sys.confirm(h.proposals.take(p.id) as never);

// ---------------------------------------------------------------- proposals

test("a proposal reads helper status only: no mutation reaches the helper until the owner confirms", async () => {
  const f = fakeClient();
  const h = ledger({ client: f.client });
  for (const a of ["install_os_updates", "reboot_host", "funnel_enable", "funnel_disable"] as const) {
    const p = await h.sys.propose(a);
    assert.equal(p.kind, "ops_sys");
    assert.match(p.digest, /^[0-9a-f]{64}$/);
    assert.ok(p.warnings.length >= 2, a);
  }
  assert.equal(h.proposals.list().length, 4);
  assert.deepEqual(f.calls.map((c) => c.action), ["sys_status", "plan_os_updates", "sys_status", "sys_status", "sys_status"], "the only non-status call is the plan (apt metadata refresh and a simulation, nothing installed)");
  assert.deepEqual(h.sys.list(), []);
});

test("proposals show the exact target, the action, the impact and the recovery limits, and state the shared-host risk", async () => {
  const h = ledger({ client: fakeClient().client, jobState: () => ({ known: true, active: ["job-a"], uncertain: ["job-q"], detail: "" }) });
  const upd = await h.sys.propose("install_os_updates");
  assert.match(upd.summary, new RegExp(`host "${HOST}"`));
  assert.match(upd.summary, /NEVER reboots/);
  assert.match(upd.warnings.join("\n"), /SHARED host: production OpenClaw/);
  assert.match(upd.warnings.join("\n"), /cannot be rolled back/);
  assert.match(upd.warnings.join("\n"), /separate proposal/);
  const reb = await h.sys.propose("reboot_host");
  assert.match(reb.summary, new RegExp(`"${HOST}"`));
  assert.match(reb.warnings.join("\n"), /SHARED host: ORBIT, production OpenClaw and the public job listener/);
  assert.match(reb.warnings.join("\n"), /provider console/);
  assert.match(reb.warnings.join("\n"), /job-a/);
  assert.match(reb.warnings.join("\n"), /never success/);
  const dis = await h.sys.propose("funnel_disable");
  assert.match(dis.summary, new RegExp(`${JOBS_HOST}`));
  assert.match(dis.summary, /this host's own Tailscale is never touched/);
  assert.match(dis.warnings.join("\n"), /job-a/);
  assert.match(dis.warnings.join("\n"), /job-q/);
  assert.match(dis.warnings.join("\n"), /NOT tested/);
  assert.match(dis.warnings.join("\n"), /funnel --bg --https=443 http:\/\/127\.0\.0\.1:8791/);
  const en = await h.sys.propose("funnel_enable");
  assert.match(en.warnings.join("\n"), /public internet/);
  assert.equal(en.display.node, JOBS_HOST);
  assert.equal(en.display.proxy, "http://127.0.0.1:8791");
});

test("a proposal that cannot be made throws and creates nothing: no helper, unreachable helper, refusal, open operation, unknown target", async () => {
  const none = ledger();
  await assert.rejects(() => none.sys.propose("reboot_host"), /not available.*No proposal was created/s);
  const down = ledger({ client: { call: async () => { throw new Error("orbit-ops-sys is not available: the tier 3 helper socket is not there (tier 3 is not installed or not running)."); } } });
  await assert.rejects(() => down.sys.propose("install_os_updates"), /not installed or not running.*No proposal was created.*docs\/orbit-ops-sys\.md/s);
  const refuse = ledger({ client: fakeClient({ status: { ok: false, code: "x", message: "nope" } }).client });
  await assert.rejects(() => refuse.sys.propose("reboot_host"), /No proposal was created/);
  const busy = ledger({ client: fakeClient({ status: { openOperation: { action: "reboot_host", state: "rebooting" } } }).client });
  await assert.rejects(() => busy.sys.propose("install_os_updates"), /still open.*No proposal was created/s);
  const noTarget = ledger({ client: fakeClient().client, jobsTarget: () => undefined });
  await assert.rejects(() => noTarget.sys.propose("funnel_disable"), /does not know its orbit-jobs target/);
  const nameless = ledger({ client: fakeClient({ status: { hostname: "" } }).client });
  await assert.rejects(() => nameless.sys.propose("reboot_host"), /host name/);
  for (const h of [none, down, refuse, busy, noTarget, nameless]) assert.deepEqual(h.proposals.list(), []);
});

test("funnel with no orbit-jobs node on this host fails closed with manual instructions and never proposes a local substitute", async () => {
  const f = fakeClient({ status: { orbitJobsSocketPresent: false } });
  const h = ledger({ client: f.client });
  for (const a of ["funnel_enable", "funnel_disable"] as const) {
    await assert.rejects(() => h.sys.propose(a), (e: Error) => {
      assert.match(e.message, /orbit-jobs Tailscale node is not on this host/);
      assert.match(e.message, /host's own Tailscale will NOT be changed instead/);
      assert.match(e.message, /Install the orbit-jobs node here/);
      assert.match(e.message, /docs\/orbit-ops-sys\.md/);
      return true;
    });
  }
  assert.deepEqual(h.proposals.list(), []);
  assert.deepEqual(f.mutations(), []);
  // host-level actions are unaffected
  assert.equal((await h.sys.propose("reboot_host")).kind, "ops_sys");
});

// ---------------------------------------------------------------- confirmation: binding, expiry, replay, one shot

test("confirming dispatches exactly once, bound to the exact action, target, digest and expiry, with a proposal-derived op id", async () => {
  const f = fakeClient();
  const h = ledger({ client: f.client });
  const p = await h.sys.propose("funnel_disable");
  const res = await confirm(h, p);
  assert.equal(res.code, 202);
  assert.deepEqual([(res.body as { dispatched: boolean }).dispatched, (res.body as { verified: boolean }).verified], [true, false]);
  assert.equal(f.mutations().length, 1);
  assert.deepEqual(f.mutations()[0], { action: "funnel_disable", opId: sysOpIdFor(p.id), target: { host: JOBS_HOST, port: 8791 }, digest: sysDigestOf("funnel_disable", { host: JOBS_HOST, port: 8791 }), expiresAt: p.expiresAt });
  assert.equal(h.sys.list()[0]!.state, "accepted");
  // the same proposal cannot be confirmed again (spent), nor re-used by a forged second confirm
  const again = await h.sys.confirm(p);
  assert.equal(again.code, 409);
  assert.equal(f.mutations().length, 1);
});

test("separate confirmations: confirming one proposal never runs another, and three actions need three proposals", async () => {
  const f = fakeClient();
  const h = ledger({ client: f.client });
  const a = await h.sys.propose("install_os_updates");
  const b = await h.sys.propose("reboot_host");
  await confirm(h, a);
  assert.deepEqual(f.mutations().map((m) => m.action), ["install_os_updates"]);
  assert.ok(h.proposals.peek(b.id), "the reboot proposal is still open and unrun");
});

test("a proposal whose stored digest no longer matches, or that this ORBIT did not make (restart), is refused without a dispatch", async () => {
  const f = fakeClient();
  const h = ledger({ client: f.client });
  const p = await h.sys.propose("reboot_host");
  const tampered = { ...h.proposals.take(p.id)!, digest: "0".repeat(64) } as never;
  assert.equal((await h.sys.confirm(tampered)).code, 409);
  const other = { ...p, action: "install_os_updates" } as never;
  assert.equal((await h.sys.confirm(other)).code, 409);
  // after a restart the in-memory arguments are gone, so a surviving proposal object cannot be confirmed
  const h2 = ledger({ client: f.client, proposals: h.proposals });
  assert.equal((await h2.sys.confirm(p)).code, 409);
  assert.deepEqual(f.mutations(), []);
});

test("expiry: a proposal confirmed after it expired dispatches nothing, and the dispatched request carries that same expiry", async () => {
  let t = Date.parse("2026-11-09T12:00:00Z");
  const now = () => new Date(t);
  const f = fakeClient();
  const h = ledger({ client: f.client, now });
  const p = await h.sys.propose("install_os_updates");
  assert.equal(Date.parse(p.expiresAt) - t, 10 * 60_000);
  t += 10 * 60_000 + 1;
  const taken = { ...p } as never; // as if the route had spent it just before the sweep
  assert.equal((await h.sys.confirm(taken)).code, 410);
  assert.deepEqual(f.mutations(), []);
  assert.equal(h.proposals.peek(p.id), undefined, "and the proposal itself expired");
});

test("a confirmation already in the ledger (same proposal or operation id) is refused", async () => {
  const f = fakeClient();
  const store = jsonStore<SysLedgerEntry[]>(undefined, "x", []);
  const h = ledger({ client: f.client, store });
  const p = await h.sys.propose("install_os_updates");
  const taken = h.proposals.take(p.id)!;
  store.write([{ opId: sysOpIdFor(p.id), proposalId: p.id, action: "install_os_updates", summary: "", target: { host: HOST }, digest: p.digest, confirmedAt: "x", expiresAt: p.expiresAt, state: "accepted" }]);
  const res = await h.sys.confirm(taken as never);
  assert.equal(res.code, 409);
  assert.match((res.body as { error: string }).error, /already used/);
  assert.deepEqual(f.mutations(), []);
});

// ---------------------------------------------------------------- active-job state

function registry() {
  let t = Date.parse("2026-11-09T12:00:00Z");
  const now = () => new Date(t);
  const store = jsonStore<ReturnType<ReturnType<typeof jobRegistry>["all"]>>(undefined, "jobs", []);
  const jobs = jobRegistry(store, Buffer.alloc(32, 1), notifier(jsonStore(undefined, "n", [])), now);
  return { jobs, advance: (ms: number) => void (t += ms), now };
}

test("job state: active, quiet/stale and unknown are distinguished (and an unpersisted registry counts as unknown)", () => {
  const r = registry();
  r.jobs.register("fresh");
  r.jobs.register("old");
  r.jobs.setLaunch("old", { routine: "orbit", at: new Date(r.now().getTime() - 3600_000).toISOString() });
  r.jobs.register("failed-launch");
  r.jobs.setLaunch("failed-launch", { routine: "orbit", at: r.now().toISOString(), failedAt: r.now().toISOString(), error: "x" });
  const s = jobStateOf(r.jobs, r.now)();
  // store is in-memory here, so ORBIT cannot vouch for it
  assert.equal(s.known, false);
  assert.match(s.detail, /not persisted/);
  assert.equal(jobStateOf(undefined)().known, false);
  const dir = mkdtempSync(join(tmpdir(), "sys-jobs-"));
  const jobs = jobRegistry(jsonStore(dir, "jobs", []), Buffer.alloc(32, 2), notifier(jsonStore(undefined, "n", [])), r.now);
  jobs.register("fresh");
  jobs.register("old");
  jobs.setLaunch("old", { routine: "orbit", at: new Date(r.now().getTime() - 3600_000).toISOString() });
  jobs.register("failed-launch");
  jobs.setLaunch("failed-launch", { routine: "orbit", at: r.now().toISOString(), failedAt: r.now().toISOString(), error: "x" });
  const ok = jobStateOf(jobs, r.now)();
  assert.equal(ok.known, true);
  assert.deepEqual(ok.active, ["fresh"]);
  assert.deepEqual(ok.uncertain, ["old"], "launched an hour ago and never started: possibly dead, possibly working");
  assert.ok(!ok.active.includes("failed-launch") && !ok.uncertain.includes("failed-launch"));
  r.advance(48 * 3600_000);
  const later = jobStateOf(jobs, r.now)();
  assert.deepEqual([later.active, later.uncertain], [[], []], "expired registrations cannot report any more");
});

test("the reboot and Funnel-disable cards warn about affected jobs; enable and updates do not claim a job impact that is not there", async () => {
  const jobState = (): JobsSnapshot => ({ known: true, active: ["job-1", "job-2"], uncertain: [], detail: "" });
  const h = ledger({ client: fakeClient().client, jobState });
  const reboot = await h.sys.propose("reboot_host");
  const disable = await h.sys.propose("funnel_disable");
  for (const p of [reboot, disable]) assert.match(p.warnings.join("\n"), /2 active \(job-1, job-2\)/);
  const unknown = ledger({ client: fakeClient().client, jobState: () => ({ known: false, active: [], uncertain: [], detail: "no registry" }) });
  const r2 = await unknown.sys.propose("reboot_host");
  assert.match(r2.warnings.join("\n"), /UNKNOWN \(no registry\)/);
  assert.match(r2.warnings.join("\n"), /can be cut off/);
});

test("job state is rechecked at confirmation: a job that appeared since the card (or state lost) blocks the disruptive action", async () => {
  for (const action of ["reboot_host", "funnel_disable"] as const) {
    let snap: JobsSnapshot = { known: true, active: ["job-1"], uncertain: [], detail: "" };
    const f = fakeClient();
    const h = ledger({ client: f.client, jobState: () => snap });
    // new job appears
    let p = await h.sys.propose(action);
    snap = { known: true, active: ["job-1", "job-new"], uncertain: [], detail: "" };
    let res = await confirm(h, p);
    assert.equal(res.code, 409, action);
    assert.match((res.body as { error: string }).error, /job situation changed.*job-new.*Nothing was done/);
    // state became unknown
    snap = { known: true, active: [], uncertain: [], detail: "" };
    p = await h.sys.propose(action);
    snap = { known: false, active: [], uncertain: [], detail: "gone" };
    res = await confirm(h, p);
    assert.equal(res.code, 409);
    assert.match((res.body as { error: string }).error, /no longer tell/);
    assert.deepEqual(f.mutations(), []);
    // the same or fewer jobs: proceeds (the owner saw and accepted them)
    snap = { known: true, active: ["job-1"], uncertain: [], detail: "" };
    p = await h.sys.propose(action);
    snap = { known: true, active: [], uncertain: [], detail: "" };
    assert.equal((await confirm(h, p)).code, 202);
    // unknown when proposed and still unknown: the owner was warned, so it proceeds
    snap = { known: false, active: [], uncertain: [], detail: "gone" };
    p = await h.sys.propose(action);
    // (operation open now; make a fresh helper for the next)
    const f2 = fakeClient();
    const h2 = ledger({ client: f2.client, jobState: () => snap });
    p = await h2.sys.propose(action);
    assert.equal((await confirm(h2, p)).code, 202);
  }
  // updates and Funnel enable are not job-disrupting by themselves and are not blocked by new jobs
  for (const action of ["install_os_updates", "funnel_enable"] as const) {
    let snap: JobsSnapshot = quiet;
    const f = fakeClient();
    const h = ledger({ client: f.client, jobState: () => snap });
    const p = await h.sys.propose(action);
    snap = { known: true, active: ["late"], uncertain: [], detail: "" };
    assert.equal((await confirm(h, p)).code, 202, action);
  }
});

// ---------------------------------------------------------------- dispatch outcomes and the ledger

test("the helper refusing (busy, expired, wrong target, helper_missing) is not_dispatched with the reason and nothing is claimed", async () => {
  for (const [code, http] of [["busy", 409], ["cooldown", 409], ["expired", 502], ["wrong_target", 502], ["helper_missing", 502]] as const) {
    const f = fakeClient({ answer: () => ({ ok: false, code, message: `refused because ${code}.` }) });
    const h = ledger({ client: f.client });
    const p = await h.sys.propose("reboot_host");
    const res = await confirm(h, p);
    assert.equal(res.code, http, code);
    assert.match((res.body as { error: string }).error, /Nothing was done/);
    const e = h.sys.list()[0]!;
    assert.equal(e.state, "not_dispatched");
    assert.match(e.error!, new RegExp(code));
  }
});

test("a dispatch whose answer is lost stays 'dispatching' until the helper says what happened, then settles honestly", async () => {
  let known = false;
  const f = fakeClient({
    answer: (c) => {
      if (c.action === "plan_os_updates") return { ok: true, data: { operation: planOp() } };
      if (c.action !== "op_status") throw new Error("socket closed");
      return known ? { ok: true, data: { operation: { state: "verified", summary: "Upgraded 2 packages; dpkg clean; ORBIT healthy.", finishedAt: "2026-11-09T12:30:00Z", verification: { checked: true, healthy: true, detail: "ok" } } } } : { ok: false, code: "not_found", message: "No operation with that id." };
    },
  });
  const h = ledger({ client: f.client });
  const p = await h.sys.propose("install_os_updates");
  const res = await confirm(h, p);
  assert.equal(res.code, 502);
  assert.match((res.body as { error: string }).error, /Nothing is verified/);
  assert.equal(h.sys.list()[0]!.state, "dispatching");
  known = true;
  await h.sys.refresh();
  assert.equal(h.sys.list()[0]!.state, "verified");
  assert.equal(h.sys.list()[0]!.verification?.checked, true);
  // never reached the helper at all: not_dispatched
  known = false;
  const h2 = ledger({ client: fakeClient({ answer: (c) => { if (c.action === "plan_os_updates") return { ok: true, data: { operation: planOp() } }; if (c.action !== "op_status") throw new Error("down"); return { ok: false, code: "not_found", message: "none" }; } }).client });
  const p2 = await h2.sys.propose("install_os_updates");
  await confirm(h2, p2);
  await h2.sys.refresh();
  assert.equal(h2.sys.list()[0]!.state, "not_dispatched");
  assert.match(h2.sys.list()[0]!.result!, /nothing was done/);
});

test("accepted / running / rebooting are never reported as done; each end is reported once, urgently", async () => {
  let state = "running";
  const f = fakeClient({ answer: (c) => (c.action === "op_status" ? { ok: true, data: { operation: { state, summary: state === "rebooting" ? "waiting" : "The host rebooted (boot id changed) and ORBIT is healthy.", ...(state === "verified" ? { finishedAt: "2026-11-09T12:40:00Z" } : {}) } } } : { ok: true, data: { operation: { state: "accepted" } } }) });
  const h = ledger({ client: f.client });
  const sent = [] as { text: string; urgent: boolean }[];
  const orig = h.notify.send.bind(h.notify);
  h.notify.send = ((text: string, urgent?: boolean) => (sent.push({ text, urgent: Boolean(urgent) }), orig(text, urgent))) as typeof h.notify.send;
  const p = await h.sys.propose("reboot_host");
  await confirm(h, p);
  for (const s of ["running", "rebooting"]) {
    state = s;
    await h.sys.refresh();
    assert.equal(h.sys.list()[0]!.state, s);
  }
  assert.equal(sent.length, 0, "no notification while in flight");
  state = "verified";
  await h.sys.refresh();
  await h.sys.refresh();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.urgent, true);
  assert.match(sent[0]!.text, /reboot_host" verified/);
  // an unverified result is reported as such, never as verified
  state = "unverified";
  const f2 = fakeClient({ answer: (c) => (c.action === "op_status" ? { ok: true, data: { operation: { state: "unverified", summary: "no reboot was observed" } } } : { ok: true, data: { operation: { state: "accepted" } } }) });
  const h2 = ledger({ client: f2.client });
  const sent2: string[] = [];
  const orig2 = h2.notify.send.bind(h2.notify);
  h2.notify.send = ((text: string, urgent?: boolean) => (sent2.push(text), orig2(text, urgent))) as typeof h2.notify.send;
  await confirm(h2, await h2.sys.propose("reboot_host"));
  await h2.sys.refresh();
  assert.match(sent2[0]!, /unverified: no reboot was observed/);
  assert.ok(!/verified:/.test(sent2[0]!.replace("unverified", "")));
});

test("restart/reboot recovery: the ledger is persisted, so after ORBIT restarts it asks the helper and reports the outcome once; an unreachable helper changes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sys-ledger-"));
  const f = fakeClient();
  const before = ledger({ client: f.client, store: jsonStore(dir, "ops-sys", []) });
  await confirm(before, await before.sys.propose("reboot_host"));
  assert.equal(before.sys.list()[0]!.state, "accepted");
  // ORBIT restarts together with the host: new objects, same directory; the helper is not up yet
  const down = ledger({ client: { call: async () => { throw new Error("socket not there"); } }, store: jsonStore(dir, "ops-sys", []) });
  assert.equal(down.sys.list().length, 1, "the confirmation survived the restart");
  await down.sys.refresh();
  assert.equal(down.sys.list()[0]!.state, "accepted", "an unreachable helper changes nothing");
  assert.equal(down.sys.list()[0]!.reportedAt, undefined);
  // the helper is back and has verified the reboot
  const back = ledger({ client: fakeClient({ answer: (c) => ({ ok: true, data: { operation: { state: c.action === "op_status" ? "verified" : "accepted", summary: "The host rebooted (boot id changed) and ORBIT is healthy." } } }) }).client, store: jsonStore(dir, "ops-sys", []) });
  await back.sys.refresh();
  assert.equal(back.sys.list()[0]!.state, "verified");
  assert.ok(back.sys.list()[0]!.reportedAt);
  // nothing is dispatched again by recovery: only op_status was ever asked
  assert.ok(f.mutations().length === 1);
});

// ---------------------------------------------------------------- the model's tools

const never = (): ModelPort => ({
  status: () => ({ port: "model", state: "live", impl: "fake", detail: "", verifiedAt: "2026-11-09T12:00:00Z" }),
  reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
});
function toolsFor(sys?: ReturnType<typeof sysOps>) {
  return chatTools({ memory: vaultMemory(mkdtempSync(join(tmpdir(), "v-"))), toolbox: toolbox([]), sys, notify: notifier(jsonStore(undefined, "n", [])), proposals: newProposals(), launchable: () => ({ routines: [] }) });
}

test("the tier 3 tools exist only when configured, are owner-only, take no arguments, and only propose", async () => {
  assert.ok(!toolsFor().some((t) => /ops_propose_(os|reboot|funnel)|ops_sys/.test(t.name)));
  const f = fakeClient();
  const h = ledger({ client: f.client });
  const tools = toolsFor(h.sys);
  const names = ["ops_propose_os_updates", "ops_propose_reboot_host", "ops_propose_funnel_enable", "ops_propose_funnel_disable", "ops_sys_operations", "ops_sys_cancel_reboot"];
  for (const n of names) {
    assert.ok(tools.some((t) => t.name === n), n);
    assert.equal(decide("agent", n, true).allow, true);
    assert.equal(decide("agent", n, false).allow, false);
  }
  for (const t of tools.filter((x) => x.name.startsWith("ops_propose_") && names.includes(x.name))) {
    // the only argument anywhere is the reboot's optional UTC time: nothing can carry a package, service, path or destination
    assert.deepEqual(Object.keys((t.parameters as { properties: object }).properties), t.name === "ops_propose_reboot_host" ? ["at"] : []);
    assert.equal((t.parameters as { additionalProperties: boolean }).additionalProperties, false);
    assert.match(t.description, /no proposal exists/);
    assert.match(t.description, /never claim a proposal or an operation exists unless this tool returned a proposalId/);
    for (const bad of [{ packages: ["x"] }, { unit: "sshd.service" }, { path: "/etc" }, { destination: "http://evil" }, { host: "x" }]) await assert.rejects(() => t.run(bad), /no arguments|only an optional/);
  }
  assert.deepEqual(f.calls, [], "rejected calls never reach the helper");
  const cancelTool = tools.find((x) => x.name === "ops_sys_cancel_reboot")!;
  assert.deepEqual(Object.keys((cancelTool.parameters as { properties: object }).properties), ["opId"]);
  await assert.rejects(() => cancelTool.run({ unit: "sshd.service" }), /only an optional opId/);
  assert.deepEqual(f.calls, []);
  const res = await tools.find((t) => t.name === "ops_propose_reboot_host")!.run({});
  const v = res.value as { status: string; executed: boolean; proposalId: string; warnings: string[] };
  assert.equal(v.status, "pending-confirmation");
  assert.equal(v.executed, false);
  assert.ok(v.proposalId);
  assert.ok(v.warnings.length >= 2);
  assert.equal(f.mutations().length, 0);
});

test("when a proposal cannot be made the tool fails: the model gets an error and no proposalId to claim", async () => {
  const h = ledger({ client: fakeClient({ status: { orbitJobsSocketPresent: false } }).client });
  const tool = toolsFor(h.sys).find((t) => t.name === "ops_propose_funnel_disable")!;
  await assert.rejects(() => tool.run({}), /not on this host/);
  assert.deepEqual(h.proposals.list(), []);
  const none = toolsFor(ledger().sys).find((t) => t.name === "ops_propose_os_updates")!;
  await assert.rejects(() => none.run({}), /No proposal was created/);
});

test("ops_sys_operations lists what the helper observed, newest first, without internals", async () => {
  const h = ledger({ client: fakeClient().client });
  await confirm(h, await h.sys.propose("install_os_updates"));
  const tool = toolsFor(h.sys).find((t) => t.name === "ops_sys_operations")!;
  assert.match(tool.description, /'accepted', 'scheduled', 'running' and 'rebooting' mean NOT verified yet/);
  const res = await tool.run({});
  assert.deepEqual([res.provenance, res.source], ["live", "ops-sys/ledger"]);
  const rows = res.value as { state: string; proposalId?: string; digest?: string }[];
  assert.equal(rows[0]!.state, "running");
  assert.equal(rows[0]!.proposalId, undefined);
  assert.equal(rows[0]!.digest, undefined);
});

// ---------------------------------------------------------------- over HTTP: owner only, digest-bound, one shot

let caller: string | undefined = "rai@example.com";
const f = fakeClient();
const hold = ledger({ client: f.client });
let script: Step[] = [];
let scriptAt = 0;
const model: ModelPort = { ...never(), step: async (_i: Item[]) => script[Math.min(scriptAt++, script.length - 1)]! };
const notify = notifier(jsonStore(undefined, "n", []));
const vault = mkdtempSync(join(tmpdir(), "orbit-vault-"));
writeFileSync(join(vault, "now.md"), "x\n");
const memory = vaultMemory(vault);
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((n) => mockPort(n)),
  model,
  memory,
  notify,
  schedule: scheduler(jsonStore(undefined, "j", []), notify),
  runs: runner(jsonStore(undefined, "r", []), [memoryReport(memory)], notify),
  tools: toolbox([]),
  sysOps: hold.sys,
  proposals: hold.proposals,
  nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), "rai@example.com"),
  commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
  owner: "rai@example.com",
  identify: async () => caller,
});
let base = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
const ask = async (tool = "ops_propose_os_updates") => {
  scriptAt = 0;
  script = [{ text: "", calls: [{ call_id: "1", name: tool, arguments: "{}" }] }, { text: "Waiting for your confirmation.", calls: [] }];
  const res = await post("/chat", { messages: [{ role: "user", content: "update the server" }] });
  return (await res.json()) as { proposals: { id: string; kind: string; digest: string; action: string; warnings: string[] }[]; calls: { name: string; ok: boolean }[] };
};

test("end to end: the model only proposes; the owner's confirmation with the matching digest dispatches once", async () => {
  caller = "rai@example.com";
  f.calls.length = 0;
  const chat = await ask();
  assert.equal(chat.calls[0]!.ok, true);
  const p = chat.proposals[0]!;
  assert.equal(p.kind, "ops_sys");
  assert.ok(p.warnings.length >= 2, "the card carries the warnings");
  assert.equal(f.mutations().length, 0, "nothing ran from the model's request");
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`)).status, 409, "no digest");
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: "0".repeat(64) })).status, 409, "wrong digest");
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: 5 })).status, 409);
  assert.equal(f.mutations().length, 0);
  const ok = await post(`/chat/proposals/${p.id}/confirm`, { digest: p.digest });
  assert.equal(ok.status, 202);
  const body = (await ok.json()) as { verified: boolean; dispatched: boolean };
  assert.deepEqual([body.dispatched, body.verified], [true, false]);
  assert.equal(f.mutations().length, 1);
  assert.equal(f.mutations()[0]!.action, "install_os_updates");
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: p.digest })).status, 404, "a second confirmation finds nothing");
  assert.equal(f.mutations().length, 1);
});

test("a non-owner can neither propose nor confirm nor cancel, and cannot read the ledger; the generic route cannot confirm a tier 3 proposal", async () => {
  caller = "rai@example.com";
  const p = (await ask("ops_propose_funnel_disable")).proposals.find((x) => x.action === "funnel_disable")!;
  const before = f.mutations().length;
  caller = "someone@example.com";
  const theirs = await ask();
  assert.deepEqual(theirs.proposals ?? [], []);
  for (const verb of ["confirm", "cancel"]) assert.equal((await post(`/chat/proposals/${p.id}/${verb}`, { digest: p.digest })).status, 403);
  assert.equal((await fetch(`${base}/ops/sys`)).status, 403);
  caller = undefined;
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: p.digest })).status, 403);
  caller = "rai@example.com";
  // the generic confirm path (no body) never runs a server operation
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`)).status, 409);
  assert.equal(f.mutations().length, before);
  assert.equal((await post(`/chat/proposals/${p.id}/cancel`)).status, 200);
});

test("the owner can read the tier 3 ledger over HTTP", async () => {
  caller = "rai@example.com";
  const res = await fetch(`${base}/ops/sys`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { operations: { action: string }[] };
  assert.ok(body.operations.length >= 1);
});

// ---------------------------------------------------------------- the socket client

test("the client validates before sending (a bad target or digest never leaves ORBIT) and says plainly when the helper is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sys-sock-"));
  const path = join(dir, "s.sock");
  const seen: string[] = [];
  const srv = createServer((s) => {
    s.on("data", (d) => {
      seen.push(String(d));
      s.end(`${JSON.stringify({ ok: true, action: "sys_status", data: { hostname: HOST } })}\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(path, r));
  const client = sysClient(path, 2000);
  assert.equal((await client.call({ action: "sys_status" })).ok, true);
  const target = { host: HOST };
  const good = { action: "reboot_host", opId: "3".repeat(40), target, digest: sysDigestOf("reboot_host", target), expiresAt: "2026-11-09T12:10:00.000Z" };
  assert.equal((await client.call(good)).ok, true);
  await assert.rejects(() => client.call({ ...good, digest: "0".repeat(64) }), /does not match/);
  await assert.rejects(() => client.call({ ...good, target: { host: "x; reboot" } }), /target/);
  await assert.rejects(() => client.call({ ...good, unit: "sshd" }), /Unexpected argument/);
  await assert.rejects(() => client.call({ action: "apt" }), /Unknown action/);
  assert.equal(seen.length, 2, "bad calls never leave ORBIT");
  srv.close();
  await assert.rejects(() => sysClient(join(dir, "missing.sock")).call({ action: "sys_status" }), /tier 3 is not installed or not running/);
});

// ---------------------------------------------------------------- units, installers and docs match the design

test("tier 3 is never installed or started by a normal deploy or by the tier 1/2 installers", () => {
  for (const f of ["deploy/install.sh", "deploy/install-admin.sh", "deploy/pull-deploy.sh"]) assert.ok(!/install-sys|orbit-ops-sys|lib\/orbit\/ops\/sys-/.test(read(f)), f);
  const i = read("deploy/install-sys.sh");
  assert.match(i, /--approved-by-owner/);
  assert.match(i, /sys-protocol\.ts.*sys-core\.ts.*sys-helper\.ts.*sys-run\.ts/s);
  assert.match(i, /systemctl enable orbit-ops-sys\.socket orbit-ops-sys-recover\.service/);
  const code = i.replace(/#.*$/gm, "");
  assert.ok(!/restart orbit\.service|orbit\.env|credstore|openclaw|tailscale (up|funnel|serve|down)|apt-get (update|upgrade|install)|systemctl (reboot|poweroff)|shutdown/i.test(code), "the installer runs no operation and touches no ORBIT config, credential, OpenClaw or Tailscale");
  assert.ok(!/systemctl (start|restart) orbit-ops-sys-(update|reboot|funnel|recover)/.test(code), "the installer starts no runner");
  const u = read("deploy/uninstall-sys.sh");
  assert.match(u, /--purge-state/);
  assert.ok(!/rm .*admin-(protocol|core|helper|run)\.ts|orbit-ops-admin|orbit-ops@|orbit-ops\.socket/.test(u.replace(/#.*$/gm, "")), "uninstall removes only tier 3");
});

test("the tier 3 units: front is sandboxed with no network or capabilities; runners have only what their action needs", () => {
  const sock = read("deploy/systemd/orbit-ops-sys.socket");
  for (const re of [/^ListenStream=\/run\/orbit-ops-sys\.sock$/m, /^SocketUser=root$/m, /^SocketGroup=orbit-ops$/m, /^SocketMode=0660$/m, /^Accept=yes$/m]) assert.match(sock, re);
  const front = read("deploy/systemd/orbit-ops-sys@.service");
  for (const re of [/^ProtectSystem=strict$/m, /^PrivateNetwork=yes$/m, /^NoNewPrivileges=yes$/m, /^CapabilityBoundingSet=$/m, /^RestrictAddressFamilies=AF_UNIX$/m, /^StateDirectory=orbit-ops-sys$/m, /sys-helper\.ts$/m]) assert.match(front, re);
  assert.ok(!/^ReadWritePaths=/m.test(front));
  const funnel = read("deploy/systemd/orbit-ops-sys-funnel@.service");
  assert.match(funnel, /^ReadWritePaths=\/run\/orbit-tailscale-jobs$/m);
  assert.match(funnel, /^InaccessiblePaths=\/run\/tailscale$/m, "the host's own tailscaled is out of reach of the Funnel runner");
  assert.match(funnel, /^PrivateNetwork=yes$/m);
  assert.match(funnel, /^CapabilityBoundingSet=$/m);
  const reboot = read("deploy/systemd/orbit-ops-sys-reboot@.service");
  assert.match(reboot, /^PrivateNetwork=yes$/m);
  assert.match(reboot, /^ReadWritePaths=\/opt\/orbit\/state$/m);
  const upd = read("deploy/systemd/orbit-ops-sys-update@.service");
  assert.match(upd, /^SendSIGKILL=no$/m, "a package manager is never SIGKILLed by systemd");
  assert.match(upd, /sys-run\.ts %i update$/m);
  const rec = read("deploy/systemd/orbit-ops-sys-recover.service");
  assert.match(rec, /^WantedBy=multi-user\.target$/m);
  assert.match(rec, /sys-run\.ts recover$/m);
  assert.match(rec, /^IPAddressDeny=any$/m);
  for (const f of ["orbit-ops-sys@", "orbit-ops-sys-update@", "orbit-ops-sys-reboot@", "orbit-ops-sys-funnel@", "orbit-ops-sys-recover"]) {
    const t = read(`deploy/systemd/${f}.service`);
    assert.ok(!/credstore|ImportCredential|LoadCredential|EnvironmentFile/.test(t), `${f}: no credentials`);
  }
});

test("the docs exist and keep the honest separations: merged vs installed vs verified, no live claims", () => {
  const d = read("docs/orbit-ops-sys.md");
  for (const h of ["## Threat model", "## Allowed update policy", "## Funnel topology", "## Rollback and removal", "## Staged live acceptance", "## Evidence gaps", "## What has and has not happened"]) assert.ok(d.includes(h), h);
  assert.match(d, /never been run on a live host/i);
  assert.match(d, /Rai's separate approval/);
});

// ---------------------------------------------------------------- follow-up: host name, OS update plan, scheduled reboot, cancellation

const T0 = Date.parse("2026-11-09T12:00:00Z");
const clock = (o: { t: number }) => () => new Date(o.t);
const at = (m: number, base = T0) => new Date(base + m * 60_000).toISOString();
const noSleep = async () => {};

test("the helper's host name is validated at proposal time: an unusable one makes no card, no plan and no helper call beyond status", async () => {
  for (const bad of ["box.example.com", "Box", "a_b", "-x", "x-", "a".repeat(64), "x y", "host\nname"]) {
    for (const action of ["install_os_updates", "reboot_host"] as const) {
      const f = fakeClient({ status: { hostname: bad } });
      const h = ledger({ client: f.client });
      await assert.rejects(() => h.sys.propose(action), /host name ORBIT cannot use.*No proposal was created/, `${bad} ${action}`);
      assert.deepEqual(h.proposals.list(), []);
      assert.deepEqual(f.calls.map((c) => c.action), ["sys_status"], "no plan (apt refresh) is started for a host that could not be confirmed anyway");
    }
  }
  for (const good of ["orbit-dedicated-8", "a", "a1-b2", "0abc", "a".repeat(63)]) {
    const h = ledger({ client: fakeClient({ status: { hostname: good } }).client });
    assert.equal((await h.sys.propose("reboot_host")).kind, "ops_sys", good);
  }
  // Funnel names no host of this machine, so an FQDN host name does not matter to it
  const f = ledger({ client: fakeClient({ status: { hostname: "box.example.com" } }).client });
  assert.equal((await f.sys.propose("funnel_enable")).kind, "ops_sys");
});

test("OS update proposal: the helper makes the plan first; the card lists every package and version and flags kernel, libc, systemd, openssh, tailscale", async () => {
  const big: PlanEntry[] = [["libc6", "2.39-0ubuntu8.3", "2.39-0ubuntu8.4"], ["systemd", "255.4-1", "255.4-2"], ["tailscale", "1.76.0", "1.78.1"], ...PLAN].sort((a, b) => (a[0] < b[0] ? -1 : 1)) as PlanEntry[];
  const f = fakeClient({ answer: (c) => (c.action === "plan_os_updates" ? { ok: true, data: { operation: planOp(big) } } : { ok: true, data: { operation: { state: "accepted" } } }) });
  const h = ledger({ client: f.client });
  const p = await h.sys.propose("install_os_updates");
  assert.deepEqual(f.calls.map((c) => c.action), ["sys_status", "plan_os_updates"], "nothing is installed by proposing");
  assert.match(String(f.calls[1]!.opId), /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(f.calls[1]!).sort(), ["action", "opId"], "a plan carries no digest, package or command");
  for (const [n, o, v] of big) assert.ok(p.display.plan!.includes(`${n} ${o} -> ${v}`), n);
  assert.equal(p.display.packages, String(big.length));
  const flagged = p.warnings[0]!;
  assert.match(flagged, /^FLAGGED PACKAGES/);
  for (const w of ["kernel: linux-image-6.8.0-50-generic", "libc: libc6", "systemd: systemd", "openssh: openssh-server", "tailscale: tailscale"]) assert.ok(flagged.includes(w), w);
  assert.equal(p.display.FLAGGED, flagged.replace(/^FLAGGED PACKAGES - /, "").split(". These")[0]);
  assert.match(p.summary, /exactly the package plan listed on this card/);
  // honest about restarts and about the plan's timing
  const all = `${p.summary}\n${p.warnings.join("\n")}`;
  assert.match(all, /maintainer scripts \(openssh, tailscale, libc, systemd and others\) can restart daemons themselves/);
  assert.match(all, /apt-get update \(which refreshes apt metadata\)/);
  assert.match(all, /recomputed before upgrading; if it differs the update is refused/);
  assert.match(all, /small window remains/);
  assert.ok(!/never restarts? (any )?services|restarts? no services/i.test(all), "no claim that services are never restarted");
  // an unflagged plan has no flag banner
  const quiet = await ledger({ client: fakeClient({ answer: (c) => (c.action === "plan_os_updates" ? { ok: true, data: { operation: planOp([["bar", "2.0", "2.1"]]) } } : { ok: true, data: { operation: {} } }) }).client }).sys.propose("install_os_updates");
  assert.ok(!quiet.warnings.some((w) => /^FLAGGED/.test(w)));
  assert.equal(quiet.display.FLAGGED, undefined);
});

test("OS update confirmation binds the FULL plan: the digest covers it, the dispatch carries the plan digest, and another plan is another digest", async () => {
  const f = fakeClient();
  const h = ledger({ client: f.client });
  const p = await h.sys.propose("install_os_updates");
  assert.equal(p.digest, sysDigestOf("install_os_updates", { host: HOST }, { planDigest: PLAN_D }));
  assert.notEqual(p.digest, sysDigestOf("install_os_updates", { host: HOST }), "the old plan-less digest no longer matches");
  const other = planDigestOf([...PLAN, ["extra", "1", "2"]]);
  assert.notEqual(p.digest, sysDigestOf("install_os_updates", { host: HOST }, { planDigest: other }));
  await confirm(h, p);
  const m = f.mutations()[0]!;
  assert.equal(m.action, "install_os_updates");
  assert.equal(m.planDigest, PLAN_D);
  assert.equal(m.digest, p.digest);
  assert.equal(h.sys.list()[0]!.planDigest, PLAN_D);
  // two proposals made from two different plans carry different digests
  const f2 = fakeClient({ answer: (c) => (c.action === "plan_os_updates" ? { ok: true, data: { operation: planOp([["bar", "2.0", "2.2"]]) } } : { ok: true, data: { operation: {} } }) });
  const p2 = await ledger({ client: f2.client }).sys.propose("install_os_updates");
  assert.notEqual(p2.digest, p.digest);
});

test("OS update proposals that cannot get a trustworthy plan create nothing: nothing pending, failed, malformed, inconsistent, too slow, refused, unreachable", async () => {
  const cases: [string, (c: Call) => SysReply | Promise<SysReply>, RegExp][] = [
    ["nothing pending", () => ({ ok: true, data: { operation: { state: "no_change" } } }), /No OS package upgrades are pending.*nothing was installed/],
    ["failed", () => ({ ok: true, data: { operation: { state: "failed", summary: "policy refuses this update. It would remove oldlib" } } }), /could not be made: policy refuses.*No proposal/],
    ["interrupted", () => ({ ok: true, data: { operation: { state: "interrupted", summary: "runner stopped" } } }), /could not be made/],
    ["no plan in a verified result", () => ({ ok: true, data: { operation: { state: "verified" } } }), /malformed/],
    ["a bad entry", () => ({ ok: true, data: { operation: { state: "verified", plan: { upgrades: [["bad name", "1", "2"]], digestKey: "x" } } } }), /malformed/],
    ["an empty plan", () => ({ ok: true, data: { operation: planOp([]) } }), /malformed/],
    ["too many packages", () => ({ ok: true, data: { operation: planOp(Array.from({ length: 151 }, (_, i) => [`p${i}`, "1", "2"] as PlanEntry)) } }), /malformed/],
    ["a digest key that does not match the plan", () => ({ ok: true, data: { operation: { ...planOp(), plan: { ...planOp().plan, digestKey: "0".repeat(24) } } } }), /does not match its own digest/],
    ["the helper refuses (busy)", () => ({ ok: false, code: "busy", message: "Another tier 3 operation is still running." }), /refused to make an update plan: Another tier 3 operation/],
    ["the helper cannot be reached", () => { throw new Error("orbit-ops-sys is not available."); }, /not available.*No proposal was created/],
  ];
  for (const [name, answer, re] of cases) {
    const h = ledger({ client: fakeClient({ answer }).client });
    await assert.rejects(() => h.sys.propose("install_os_updates"), re, name);
    assert.deepEqual(h.proposals.list(), [], name);
  }
  // a plan that is slow: polled through op_status until ready, then proposed
  let polls = 0;
  const slow = fakeClient({ answer: (c) => (c.action === "plan_os_updates" ? { ok: true, data: { operation: { state: "accepted" } } } : { ok: true, data: { operation: ++polls < 3 ? { state: "running" } : planOp() } }) });
  const h = ledger({ client: slow.client });
  const sys = sysOps({ client: slow.client, store: h.store, notify: h.notify, proposals: h.proposals, jobState: () => quiet, jobsTarget: () => undefined, sleep: noSleep });
  assert.equal((await sys.propose("install_os_updates")).kind, "ops_sys");
  assert.equal(polls, 3);
  // one that never finishes gives up (about five minutes of polling) and proposes nothing
  const stuck = fakeClient({ answer: (c) => (c.action === "plan_os_updates" ? { ok: true, data: { operation: { state: "accepted" } } } : { ok: true, data: { operation: { state: "running" } } }) });
  const h2 = ledger({ client: stuck.client });
  const sys2 = sysOps({ client: stuck.client, store: h2.store, notify: h2.notify, proposals: h2.proposals, jobState: () => quiet, jobsTarget: () => undefined, sleep: noSleep });
  await assert.rejects(() => sys2.propose("install_os_updates"), /STILL running on the helper.*did not stop it.*Nothing was installed.*No proposal was created/);
  assert.equal(h2.proposals.list().length, 0);
  assert.equal(stuck.calls.filter((c) => c.action === "op_status").length, PLAN_MAX_POLLS);
});

test("a plan-time refusal by an open operation or an unreachable status never starts a plan", async () => {
  const f = fakeClient({ status: { openOperation: { action: "reboot_host", state: "scheduled" } } });
  const h = ledger({ client: f.client });
  await assert.rejects(() => h.sys.propose("install_os_updates"), /Another tier 3 operation.*cancel the scheduled reboot first/);
  assert.deepEqual(f.calls.map((c) => c.action), ["sys_status"]);
});

test("scheduled reboot proposal: time validated before any card exists; the card says when, how to cancel and what is not checked; the digest binds the time", async () => {
  const now = { t: T0 };
  const f = fakeClient();
  const h = ledger({ client: f.client, now: clock(now) });
  const none = async (rebootAt: string, re: RegExp) => {
    await assert.rejects(() => h.sys.propose("reboot_host", { rebootAt }), re, rebootAt);
    assert.deepEqual(h.proposals.list(), [], rebootAt);
  };
  await none(at(-5), /at least 120 seconds in the future/);
  await none(at(1), /at least 120 seconds/);
  await none(new Date(T0 + 24 * 3600_000 + 1).toISOString(), /no more than 24 hours ahead/);
  await none("2026-11-09T14:00:00Z", /must be UTC in the form/);
  await none("2026-11-09T14:00:00.000+01:00", /must be UTC in the form/);
  await none("soon", /must be UTC in the form/);
  await assert.rejects(() => h.sys.propose("funnel_enable", { rebootAt: at(60) }), /Only a reboot can be scheduled/);
  await assert.rejects(() => h.sys.propose("install_os_updates", { rebootAt: at(60) }), /Only a reboot can be scheduled/);
  assert.deepEqual(f.mutations(), []);
  const when = at(180);
  const p = await h.sys.propose("reboot_host", { rebootAt: when });
  assert.equal(p.digest, sysDigestOf("reboot_host", { host: HOST }, { rebootAt: when }));
  assert.notEqual(p.digest, sysDigestOf("reboot_host", { host: HOST }), "'now' is another digest");
  assert.notEqual(p.digest, sysDigestOf("reboot_host", { host: HOST }, { rebootAt: at(181) }));
  assert.match(p.summary, new RegExp(`at ${when}.*cancelled from chat until it fires`));
  assert.equal(p.display.when, when);
  const text = p.warnings.join("\n");
  assert.match(text, /NOT at .*jobs that start in between can be cut off/);
  assert.match(text, /ops_sys_cancel_reboot/);
  assert.match(text, /SHARED host/);
  assert.equal((await h.sys.propose("reboot_host")).display.when, "now");
  // the edges are proposable
  assert.equal((await h.sys.propose("reboot_host", { rebootAt: at(2) })).kind, "ops_sys");
  assert.equal((await h.sys.propose("reboot_host", { rebootAt: at(24 * 60) })).kind, "ops_sys");
});

test("scheduled reboot confirmation: dispatched with the time, shown as 'scheduled' (never as done), and refused with no dispatch when the time can no longer be honoured", async () => {
  const now = { t: T0 };
  const f = fakeClient({ answer: (c) => ({ ok: true, data: { operation: { state: c.action === "reboot_host" && c.rebootAt ? "scheduled" : "accepted" } } }) });
  const h = ledger({ client: f.client, now: clock(now) });
  const when = at(180);
  const res = await confirm(h, await h.sys.propose("reboot_host", { rebootAt: when }));
  assert.equal(res.code, 202);
  const body = res.body as { verified: boolean; note: string };
  assert.equal(body.verified, false);
  assert.match(body.note, /Scheduled.*Nothing has been done and nothing is verified.*cancel with ops_sys_cancel_reboot until it fires/);
  const m = f.mutations()[0]!;
  assert.equal(m.rebootAt, when);
  assert.equal(m.digest, sysDigestOf("reboot_host", { host: HOST }, { rebootAt: when }));
  assert.equal(h.sys.list()[0]!.state, "scheduled");
  assert.equal(h.sys.list()[0]!.scheduledFor, when);
  // a later "now" reboot carries no time at all
  const f2 = fakeClient();
  const h2 = ledger({ client: f2.client, now: clock(now) });
  await confirm(h2, await h2.sys.propose("reboot_host"));
  assert.equal("rebootAt" in f2.mutations()[0]!, false);
  // the owner takes too long: the time is now less than a minute away, so nothing is dispatched
  const f3 = fakeClient();
  const h3 = ledger({ client: f3.client, now: clock(now) });
  const p3 = await h3.sys.propose("reboot_host", { rebootAt: at(3) });
  now.t = T0 + 2.5 * 60_000;
  const late = await confirm(h3, p3);
  assert.equal(late.code, 410);
  assert.match((late.body as { error: string }).error, /scheduled time can no longer be honoured.*Nothing was done/);
  assert.deepEqual(f3.mutations(), []);
});

test("reboot proposals respect the helper's cool-down at the time asked for, and say nothing was proposed", async () => {
  const now = { t: T0 };
  const f = fakeClient({ status: { rebootCooldownUntil: at(20) } });
  const h = ledger({ client: f.client, now: clock(now) });
  await assert.rejects(() => h.sys.propose("reboot_host"), /next one is not accepted before .*No proposal was created/);
  await assert.rejects(() => h.sys.propose("reboot_host", { rebootAt: at(10) }), /later than the time asked for/);
  assert.equal((await h.sys.propose("reboot_host", { rebootAt: at(60) })).kind, "ops_sys", "an hour away is outside the cool-down");
  assert.equal((await h.sys.propose("install_os_updates")).kind, "ops_sys", "updates have no cool-down");
});

test("cancelling: reported as cancelled only when the helper confirms; recorded in the ledger with when; idempotent; nothing to cancel is an error", async () => {
  const now = { t: T0 };
  const f = fakeClient({
    answer: (c) => (c.action === "cancel_reboot" ? { ok: true, data: { cancelled: true, alreadyCancelled: false, operation: { state: "cancelled" } } } : { ok: true, data: { operation: { state: c.action === "reboot_host" ? "scheduled" : "accepted" } } }),
  });
  const h = ledger({ client: f.client, now: clock(now) });
  await assert.rejects(() => h.sys.cancelReboot(), /no reboot waiting to fire.*Nothing was cancelled/);
  await confirm(h, await h.sys.propose("reboot_host", { rebootAt: at(180) }));
  const opId = h.sys.list()[0]!.opId;
  now.t = T0 + 60_000;
  const r = await h.sys.cancelReboot();
  assert.deepEqual([r.cancelled, r.opId, r.alreadyCancelled], [true, opId, false]);
  assert.match(r.note, /no reboot was issued/);
  assert.deepEqual(f.calls.filter((c) => c.action === "cancel_reboot"), [{ action: "cancel_reboot", opId }]);
  const e = h.sys.list()[0]!;
  assert.equal(e.state, "cancelled");
  assert.equal(e.cancelledAt, new Date(now.t).toISOString());
  assert.match(e.result!, /Cancelled by the owner before it fired/);
  // nothing is left to cancel; a second ask is an error rather than a second "success"
  await assert.rejects(() => h.sys.cancelReboot(), /no reboot waiting to fire/);
  // naming an id that is already ended asks the helper, which says it is already cancelled; the ledger is not changed again
  const again = fakeClient({ answer: () => ({ ok: true, data: { cancelled: true, alreadyCancelled: true, operation: { state: "cancelled" } } }) });
  const h2 = ledger({ client: again.client, now: clock(now), store: h.store });
  assert.equal((await h2.sys.cancelReboot(opId)).alreadyCancelled, true);
  // the owner asked for it directly, so ORBIT does not also notify (reportedAt is set); it is never reported as success
  await h.sys.refresh();
  assert.equal(h.notify.recent().filter((n) => /cancelled/.test(n.text)).length === 0, true);
  await assert.rejects(() => h.sys.cancelReboot("f".repeat(40)), /not a reboot ORBIT has on record/);
});

test("cancelling too late is an error, never success: the ledger is NOT marked cancelled and ORBIT re-reads what the helper says", async () => {
  const now = { t: T0 };
  let state = "scheduled";
  const f = fakeClient({
    answer: (c) => {
      if (c.action === "cancel_reboot") return { ok: false, code: "too_late", message: "Too late: that reboot has already been dispatched (state accepted). It was NOT cancelled; watch its result." };
      if (c.action === "op_status") return { ok: true, data: { operation: { state } } };
      return { ok: true, data: { operation: { state: c.action === "reboot_host" ? "scheduled" : "accepted" } } };
    },
  });
  const h = ledger({ client: f.client, now: clock(now) });
  await confirm(h, await h.sys.propose("reboot_host", { rebootAt: at(60) }));
  state = "rebooting";
  await assert.rejects(() => h.sys.cancelReboot(), /NOT cancelled: Too late.*NOT cancelled/);
  const e = h.sys.list()[0]!;
  assert.notEqual(e.state, "cancelled");
  assert.equal(e.cancelledAt, undefined);
  assert.equal(e.state, "rebooting", "the refreshed, truthful state");
  // the helper cannot be reached: the cancellation is NOT confirmed and the ledger says nothing new
  const f2 = fakeClient({ answer: (c) => { if (c.action === "cancel_reboot") throw new Error("orbit-ops-sys could not be reached."); return { ok: true, data: { operation: { state: "scheduled" } } }; } });
  const h2 = ledger({ client: f2.client, now: clock(now) });
  await confirm(h2, await h2.sys.propose("reboot_host", { rebootAt: at(60) }));
  await assert.rejects(() => h2.sys.cancelReboot(), /NOT cancelled: the helper could not be reached.*may still fire/);
  assert.equal(h2.sys.list()[0]!.state, "scheduled");
  assert.equal(h2.sys.list()[0]!.cancelledAt, undefined);
  // no client at all
  await assert.rejects(() => ledger().sys.cancelReboot(), /not available.*Nothing was cancelled/);
});

test("chat: the reboot tool takes only an optional UTC time; the cancel tool only an optional id; both fail loudly, and cancelling is never claimed on failure", async () => {
  const now = { t: T0 };
  const f = fakeClient({ answer: (c) => (c.action === "cancel_reboot" ? { ok: false, code: "too_late", message: "Too late." } : { ok: true, data: { operation: { state: "scheduled" } } }) });
  const h = ledger({ client: f.client, now: clock(now) });
  const tools = toolsFor(h.sys);
  const reboot = tools.find((t) => t.name === "ops_propose_reboot_host")!;
  await assert.rejects(() => reboot.run({ at: 5 }), /must be a UTC time string/);
  await assert.rejects(() => reboot.run({ at: at(5), host: "x" }), /only an optional 'at' time/);
  await assert.rejects(() => reboot.run({ at: "tomorrow" }), /must be UTC/);
  const res = await reboot.run({ at: at(90) });
  assert.equal((res.value as { details: Record<string, string> }).details.when, at(90));
  assert.equal(f.mutations().length, 0, "proposing never dispatches");
  await confirm(h, await h.sys.propose("reboot_host", { rebootAt: at(90) }));
  const cancel = tools.find((t) => t.name === "ops_sys_cancel_reboot")!;
  await assert.rejects(() => cancel.run({}), /NOT cancelled: Too late/);
  assert.match(cancel.description, /ONLY if the helper confirms/);
});

test("scheduled reboots survive an ORBIT restart: the persisted ledger still knows it and can cancel it", async () => {
  const now = { t: T0 };
  const store = jsonStore<SysLedgerEntry[]>(undefined, "ops-sys", []);
  const f = fakeClient({ answer: (c) => (c.action === "cancel_reboot" ? { ok: true, data: { cancelled: true, alreadyCancelled: false, operation: { state: "cancelled" } } } : { ok: true, data: { operation: { state: c.action === "reboot_host" ? "scheduled" : "scheduled" } } }) });
  const before = ledger({ client: f.client, now: clock(now), store });
  await confirm(before, await before.sys.propose("reboot_host", { rebootAt: at(120) }));
  // "restart": a new ledger over the same store; the helper still says scheduled
  const after = ledger({ client: f.client, now: clock(now), store });
  await after.sys.refresh();
  assert.equal(after.sys.list()[0]!.state, "scheduled");
  assert.equal(after.sys.list()[0]!.scheduledFor, at(120));
  assert.equal((await after.sys.cancelReboot()).cancelled, true);
  assert.equal(after.sys.list()[0]!.state, "cancelled");
});

// ---------------------------------------------------------------- follow-up: units, installer and docs say what is true

test("the plan unit is the update runner's sandbox with a plan-only command; the reboot unit may wait up to a day; the installer and uninstaller know the plan unit", () => {
  const plan = read("deploy/systemd/orbit-ops-sys-plan@.service");
  assert.match(plan, /sys-run\.ts %i plan$/m);
  assert.match(plan, /^SendSIGKILL=no$/m);
  assert.match(plan, /REFRESHES apt metadata.*not literally read-only/s);
  assert.ok(!/credstore|ImportCredential|LoadCredential|EnvironmentFile/.test(plan));
  const reboot = read("deploy/systemd/orbit-ops-sys-reboot@.service");
  assert.match(reboot, /^TimeoutStartSec=26h$/m, "a 24 h wait plus lock wait fits");
  assert.match(reboot, /WITHOUT the deploy lock/);
  assert.match(read("deploy/install-sys.sh"), /orbit-ops-sys-plan@\.service/);
  assert.match(read("deploy/uninstall-sys.sh"), /orbit-ops-sys-plan@\.service/);
  assert.match(read("deploy/uninstall-sys.sh"), /SCHEDULED REBOOT WILL STILL FIRE/);
  // the scheduled wait must not hold the deploy lock: the flock wrapper in sys-run.ts is only entered once the record is `accepted`
  const run = read("src/ops/sys-run.ts");
  assert.ok(run.indexOf("awaitSchedule(systemSysEnv") < run.indexOf('const needsLock'), "the wait happens before the lock is taken");
});

test("no tier 3 code or unit claims services are never restarted; the honest statement is there instead", () => {
  for (const f of ["src/ops/sys-run.ts", "src/ops/sys-helper.ts", "src/ops-sys.ts", "src/chat-tools.ts", "deploy/systemd/orbit-ops-sys-update@.service", "deploy/systemd/orbit-ops-sys-plan@.service"]) {
    assert.ok(!/never restart|no service restart|without restarting (any )?services/i.test(read(f)), `${f} claims services are never restarted`);
  }
  assert.match(read("src/ops/sys-run.ts"), /maintainer scripts \(openssh, tailscale, libc,\s*\/\/\s*systemd and others\) may restart daemons/);
  assert.match(read("deploy/systemd/orbit-ops-sys-update@.service"), /maintainer scripts \(openssh,\s*# tailscale, libc, systemd and others\) may restart daemons/);
  assert.match(read("docs/orbit-ops-sys.md"), /maintainer scripts \(openssh, tailscale, libc, systemd and others\) can restart daemons on their own/);
});

test("the docs state what the digest is and is not, that apt-get update is not read-only, the cool-down defect, the slot, scheduling, cancellation and the live-acceptance split", () => {
  const d = read("docs/orbit-ops-sys.md");
  for (const h of ["### OS update plan", "## Reboot: scheduling, cancellation, cool-down", "## Slot ownership", "## Fake-test evidence", "## Installation prerequisites", "## Future live acceptance of the follow-up"]) assert.ok(d.includes(h), h);
  assert.match(d, /does \*\*not\*\* prove the owner clicked/);
  assert.match(d, /Membership in the `orbit-ops` group is the trust boundary, exactly as in Tier 2/);
  assert.match(d, /no cryptographic, independent owner approval/);
  assert.match(d, /not literally read-only/);
  assert.match(d, /Reboot cool-down counts fail/);
  assert.match(d, /derived from `src\/ops\/sys-helper\.ts` as merged, not from the missing text/);
  assert.match(d, /Never run on a real host|has not been run on a live host|Nothing here has been done/);
});

// ================================================================= follow-up 2: plan timeouts, and the exclusivity matrix at the proposal

import { PLAN_APT_LOCK_WAIT_MS, PLAN_AUDIT_LIMIT_MS, PLAN_REFRESH_LIMIT_MS, PLAN_RUNNER_MAX_MS, PLAN_SIMULATE_LIMIT_MS, PLAN_WAIT_MS } from "../src/ops/sys-protocol.ts";
import { PLAN_POLL_MS } from "../src/ops-sys.ts";

test("plan timeouts: ORBIT waits at least as long as the plan runner may run, and the runner's limits come from the same constants", () => {
  assert.equal(PLAN_RUNNER_MAX_MS, PLAN_AUDIT_LIMIT_MS + PLAN_REFRESH_LIMIT_MS + PLAN_SIMULATE_LIMIT_MS + 2 * PLAN_APT_LOCK_WAIT_MS);
  assert.ok(PLAN_WAIT_MS > PLAN_RUNNER_MAX_MS, "a margin on top of the runner's own budget");
  assert.ok(PLAN_MAX_POLLS * PLAN_POLL_MS >= PLAN_RUNNER_MAX_MS, "the polling budget covers the runner's budget (it used to be 300 s against a 600 s apt-get update)");
  assert.ok(PLAN_MAX_POLLS * PLAN_POLL_MS >= PLAN_WAIT_MS);
  const run = read("src/ops/sys-run.ts");
  assert.match(run, /"update"\], PLAN_REFRESH_LIMIT_MS, noKillOpts\)/);
  assert.match(run, /"-s", "upgrade"\], PLAN_SIMULATE_LIMIT_MS, noKillOpts\)/);
  assert.match(run, /\["--audit"\], PLAN_AUDIT_LIMIT_MS\)/);
  assert.doesNotMatch(run.slice(run.indexOf("async function simulatePlan"), run.indexOf("async function installOsUpdates")), /\b(600_000|120_000|60_000)\b/, "no literal limit is left in the plan path");
  assert.match(read("src/ops/sys-run.ts"), /DPkg::Lock::Timeout=120/);
  assert.equal(PLAN_APT_LOCK_WAIT_MS, 120_000, "matches the -o DPkg::Lock::Timeout=120 the runner passes");
});

// A plan that becomes ready after `readyAfterMs` of (virtual) waiting. sleep advances the virtual clock.
function planReadyAfter(readyAfterMs: number) {
  const v = { t: 0 };
  const f = fakeClient({ answer: (c) => (c.action === "plan_os_updates" ? { ok: true, data: { operation: { state: "accepted" } } } : { ok: true, data: { operation: v.t >= readyAfterMs ? planOp() : { state: "running" } } }) });
  const h = ledger({ client: f.client });
  const sys = sysOps({ client: f.client, store: h.store, notify: h.notify, proposals: h.proposals, jobState: () => quiet, jobsTarget: () => undefined, sleep: async (ms) => void (v.t += ms) });
  return { sys, f, h, v };
}

test("plan timeouts: boundaries. Ready exactly when the runner's budget ends, or at the very last poll: proposed. One poll later: refused, naming the plan as still running", async () => {
  for (const [name, readyAt] of [
    ["at the runner's maximum", PLAN_RUNNER_MAX_MS],
    ["at the last poll ORBIT makes", PLAN_MAX_POLLS * PLAN_POLL_MS],
  ] as const) {
    const t = planReadyAfter(readyAt);
    assert.equal((await t.sys.propose("install_os_updates")).kind, "ops_sys", name);
  }
  const late = planReadyAfter((PLAN_MAX_POLLS + 1) * PLAN_POLL_MS);
  await assert.rejects(() => late.sys.propose("install_os_updates"), /STILL running on the helper/);
  assert.equal(late.h.proposals.list().length, 0);
  assert.equal(late.f.calls.filter((c) => c.action === "op_status").length, PLAN_MAX_POLLS, "polled for the whole budget, no more");
  assert.ok(late.v.t >= PLAN_WAIT_MS, "and waited at least as long as the runner may run");
});

test("plan timeouts: when ORBIT gives up it says the plan is still running and that giving up did not stop it; it never claims a cancellation, and sends no cancel", async () => {
  const t = planReadyAfter(Number.MAX_SAFE_INTEGER);
  let msg = "";
  await t.sys.propose("install_os_updates").catch((e: Error) => void (msg = e.message));
  assert.match(msg, /operation [0-9a-f]{12}\) is STILL running on the helper/);
  assert.match(msg, /did not stop it/);
  assert.match(msg, /cannot be cancelled/);
  assert.match(msg, /holds the tier 3 slot until it ends/);
  assert.match(msg, /Nothing was installed.*No proposal was created/);
  assert.doesNotMatch(msg, /was cancelled|has been cancelled|stopped the plan|plan was stopped|timed out and stopped/i);
  assert.deepEqual(t.f.calls.filter((c) => c.action !== "sys_status" && c.action !== "op_status" && c.action !== "plan_os_updates"), [], "no cancel or any other mutation was sent");
  assert.equal(t.f.plans().length, 1);
});

test("plan timeouts: outstanding plan, then slot cleanup. While the helper still reports the plan, new proposals are refused with the true reason; once it has ended (slot released) the next works", async () => {
  const state = { phase: "clean" as "clean" | "plan-running" | "ended" };
  const open = { opId: "9".repeat(40), action: "plan_os_updates", state: "running" };
  const calls: Call[] = [];
  const client: SysClient = {
    call: async (req) => {
      const c = req as Call;
      calls.push(c);
      if (c.action === "sys_status") return { ok: true, data: { hostname: HOST, orbitJobsSocketPresent: true, openOperation: state.phase === "plan-running" ? open : null, openOperations: state.phase === "plan-running" ? [open] : [] } };
      if (c.action === "plan_os_updates") return { ok: true, data: { operation: state.phase === "ended" ? planOp() : { state: "accepted" } } };
      return { ok: true, data: { operation: state.phase === "ended" ? planOp() : { state: "running" } } };
    },
  };
  const h = ledger({ client });
  const sys = sysOps({ client, store: h.store, notify: h.notify, proposals: h.proposals, jobState: () => quiet, jobsTarget: () => ({ host: JOBS_HOST, port: 8791 }), sleep: async () => {} });
  await assert.rejects(() => sys.propose("install_os_updates"), /STILL running/);
  state.phase = "plan-running"; // the helper's runner has not ended: it still holds the slot
  const before = calls.length;
  await assert.rejects(() => sys.propose("install_os_updates"), /Another tier 3 operation \(plan_os_updates, running\).*an earlier update plan is still running on the helper.*which does not stop it/s);
  await assert.rejects(() => sys.propose("reboot_host"), /plan_os_updates, running/);
  await assert.rejects(() => sys.propose("funnel_disable"), /plan_os_updates, running/);
  assert.deepEqual(calls.slice(before).map((c) => c.action), ["sys_status", "sys_status", "sys_status"], "refused at the status check: no second plan was started");
  state.phase = "ended"; // the runner ended and released the slot
  assert.equal((await sys.propose("install_os_updates")).kind, "ops_sys");
  assert.equal((await sys.propose("funnel_disable")).kind, "ops_sys");
});

test("exclusivity at the proposal: a waiting scheduled reboot does not block a Funnel proposal; everything else is exclusive with it, and cancelling never consults the status", async () => {
  const waiting = { opId: "8".repeat(40), action: "reboot_host", state: "scheduled" };
  const f = fakeClient({ status: { openOperation: waiting, openOperations: [waiting] } });
  const h = ledger({ client: f.client });
  for (const a of ["funnel_enable", "funnel_disable"] as const) assert.equal((await h.sys.propose(a)).kind, "ops_sys", a);
  for (const a of ["install_os_updates", "reboot_host"] as const) await assert.rejects(() => h.sys.propose(a), /cancel the scheduled reboot first/, a);
  await assert.rejects(() => h.sys.propose("reboot_host", { rebootAt: at(180) }), /cancel the scheduled reboot first/);
  assert.equal(f.plans().length, 0, "no plan was started while the reboot waits");
  // the other way round: a Funnel change in flight allows a scheduled reboot, but not update, plan or reboot now
  const fun = { opId: "7".repeat(40), action: "funnel_enable", state: "running" };
  const g = fakeClient({ status: { openOperation: fun, openOperations: [fun] } });
  const gh = ledger({ client: g.client, now: clock({ t: T0 }) });
  assert.equal((await gh.sys.propose("reboot_host", { rebootAt: at(180) })).kind, "ops_sys");
  for (const a of ["install_os_updates", "reboot_host", "funnel_enable", "funnel_disable"] as const) await assert.rejects(() => gh.sys.propose(a), /Another tier 3 operation \(funnel_enable, running\)/, a);
  // an old helper that only reports openOperation still behaves (and is stricter, never looser)
  const old = fakeClient({ status: { openOperation: waiting } });
  const oh = ledger({ client: old.client });
  assert.equal((await oh.sys.propose("funnel_disable")).kind, "ops_sys");
  await assert.rejects(() => oh.sys.propose("install_os_updates"), /cancel the scheduled reboot first/);
});

test("cancelling a scheduled reboot is not gated on the helper's open operations: it works while a Funnel change is in flight and asks no status", async () => {
  const now = { t: T0 };
  const fun = { opId: "7".repeat(40), action: "funnel_enable", state: "running" };
  const f = fakeClient({
    status: { openOperation: fun, openOperations: [fun] },
    answer: (c) => (c.action === "cancel_reboot" ? { ok: true, data: { cancelled: true, alreadyCancelled: false, operation: { state: "cancelled" } } } : { ok: true, data: { operation: { state: c.action === "reboot_host" ? "scheduled" : "accepted" } } }),
  });
  const h = ledger({ client: f.client, now: clock(now) });
  const gate = fakeClient();
  const h0 = ledger({ client: gate.client, now: clock(now), store: h.store });
  await confirm(h0, await h0.sys.propose("reboot_host", { rebootAt: at(180) })); // scheduled while the helper was idle
  f.calls.length = 0;
  const r = await h.sys.cancelReboot();
  assert.equal(r.cancelled, true);
  assert.deepEqual(f.calls.map((c) => c.action), ["cancel_reboot"]);
});
