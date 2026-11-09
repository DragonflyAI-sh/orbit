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
import { jobStateOf, sysOps, type JobsSnapshot, type SysLedgerEntry } from "../src/ops-sys.ts";
import { sysClient, type SysClient, type SysReply } from "../src/ops-sys-client.ts";
import { decide } from "../src/policy.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";
import { sysDigestOf, sysOpIdFor } from "../src/ops/sys-protocol.ts";

const HOST = "orbit-dedicated-8";
const JOBS_HOST = "orbit-jobs.tail5bde08.ts.net";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(new URL(`../${p}`, import.meta.url))).digest("hex");

type Call = Record<string, unknown> & { action: string };
function fakeClient(opts: { status?: Record<string, unknown> | SysReply; answer?: (c: Call) => SysReply | Promise<SysReply> } = {}) {
  const calls: Call[] = [];
  const status: SysReply = opts.status && "ok" in opts.status ? (opts.status as SysReply) : { ok: true, data: { hostname: HOST, orbitJobsSocketPresent: true, openOperation: null, ...(opts.status ?? {}) } };
  const client: SysClient = {
    call: async (req) => {
      const c = req as Call;
      calls.push(c);
      if (c.action === "sys_status") return status;
      return (opts.answer ?? ((x) => ({ ok: true, data: { operation: { state: x.action === "op_status" ? "running" : "accepted" } } })))(c);
    },
  };
  return { client, calls, mutations: () => calls.filter((c) => c.action !== "sys_status" && c.action !== "op_status") };
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
  assert.deepEqual(f.calls.map((c) => c.action), ["sys_status", "sys_status", "sys_status", "sys_status"]);
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
  const h2 = ledger({ client: fakeClient({ answer: (c) => { if (c.action !== "op_status") throw new Error("down"); return { ok: false, code: "not_found", message: "none" }; } }).client });
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
  const names = ["ops_propose_os_updates", "ops_propose_reboot_host", "ops_propose_funnel_enable", "ops_propose_funnel_disable", "ops_sys_operations"];
  for (const n of names) {
    assert.ok(tools.some((t) => t.name === n), n);
    assert.equal(decide("agent", n, true).allow, true);
    assert.equal(decide("agent", n, false).allow, false);
  }
  for (const t of tools.filter((x) => x.name.startsWith("ops_propose_") && names.includes(x.name))) {
    assert.deepEqual((t.parameters as { properties: object }).properties, {}, "no argument can carry a package, service, path or destination");
    assert.equal((t.parameters as { additionalProperties: boolean }).additionalProperties, false);
    assert.match(t.description, /no proposal exists/);
    assert.match(t.description, /never claim a proposal or an operation exists unless this tool returned a proposalId/);
    for (const bad of [{ packages: ["x"] }, { unit: "sshd.service" }, { path: "/etc" }, { destination: "http://evil" }, { host: "x" }]) await assert.rejects(() => t.run(bad), /no arguments/);
  }
  assert.deepEqual(f.calls, [], "rejected calls never reach the helper");
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
  assert.match(tool.description, /'accepted', 'running' and 'rebooting' mean NOT verified yet/);
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

test("tier 1 and tier 2 are untouched by tier 3: their units, helpers and installer are byte-identical to the shipped ones", () => {
  assert.equal(sha("deploy/systemd/orbit-ops@.service"), "088be396050509047680bb157b625b19e11a6e25f0042e1753a4045765a86c63");
  assert.equal(sha("deploy/systemd/orbit-ops.socket"), "9f2516a3337a99551b220d198c63b8b5dc100a0d0465fc6947d62add4d31c27e");
  assert.equal(sha("deploy/systemd/orbit.service"), "1516761d0bda57cd699cf76e77108f079ac82185c267ea1920f3ab9b1b40d48e");
  assert.equal(sha("src/ops/helper.ts"), "47e6384d82720177166f876ce9dd5bc7d56a9efa3ba01b208c6b96a8078fad5a");
  assert.equal(sha("src/ops/protocol.ts"), "3a1dea9c7c865639387531b173c5f6e93d3ba346f789a1b482db2d7cb338b1f1");
  const admin = read("src/ops/admin-protocol.ts");
  assert.match(admin, /MUTATING_ACTIONS = \["restart_orbit", "deploy_now", "rollback_release", "apply_config", "refresh_vault"\]/);
  assert.ok(!/reboot|funnel|apt/i.test(admin.replace(/#.*$/gm, "").replace(/\/\/.*$/gm, "")), "tier 2's action list gained nothing");
});

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
