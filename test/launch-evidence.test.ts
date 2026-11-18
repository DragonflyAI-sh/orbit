import assert from "node:assert/strict";
import { test } from "node:test";
import { jobLauncher } from "../src/job-launch.ts";
import { compactJob, detailJob, jobRow } from "../src/job-view.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job, Launch } from "../src/jobs.ts";
import { dispatchEvidence, IN_FLIGHT_MS } from "../src/launch-evidence.ts";
import { fireFailureOf, gitReconciler, routineTrigger, RoutineFireError } from "../src/launcher.ts";
import type { ControlRepo, Fired, GitRecord, Routine } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";
import { watcher } from "../src/watch.ts";

// Launch reconciliation (docs/reviews/launch-reconciliation.md). These tests reproduce the windows in which a launch is registered and
// shows no runner events ("not-started"), and pin what ORBIT's own record can and cannot prove about each. Everything is synthetic: fake
// GitHub, fake Routine, in-memory stores. No network, no credential, no provider call. Nothing here retries, cancels or relaunches.

const COMMIT = "4297487b753847104433af7d43a0890f81d4fad9";
const MIN = 60_000;

function harness(opts: { pushBrief?: () => Promise<{ branch: string; commit: string }>; fire?: (text: string) => Promise<Fired>; commit?: string } = {}) {
  const calls: string[] = [];
  const sent: string[] = [];
  const control: ControlRepo = {
    pushBrief: async (job) => {
      calls.push("pushBrief");
      return opts.pushBrief ? opts.pushBrief() : { branch: `orbit/${job}`, commit: "b1ef0000b1ef0000b1ef0000b1ef0000b1ef0000" };
    },
  };
  const routine: Routine = {
    name: "orbit",
    fire: async (text) => {
      calls.push("fire");
      sent.push(text);
      return opts.fire ? opts.fire(text) : { sessionId: "cse_accepted", sessionUrl: "https://claude.ai/code/cse_accepted" };
    },
  };
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  let clock = new Date();
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 7), notes, () => clock);
  const launch = jobLauncher({ jobs, control, routines: new Map([["orbit", routine]]), notify: notes, publicJobUrl: "https://orbit.example", commit: opts.commit ?? COMMIT });
  return { calls, sent, jobs, launch, notes, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)), at: (ms: number) => new Date(Date.now() + ms) };
}

const flush = () => new Promise((r) => setImmediate(r));
const only = (jobs: ReturnType<typeof jobRegistry>) => jobs.all()[0];

test("a fire cut off mid-flight (ORBIT stopped before the provider answered) is dispatch-unknown, not never-dispatched", async () => {
  // The fire never returns: the state a restart or deploy leaves behind, since SIGTERM exits without waiting for launches.
  const h = harness({ fire: () => new Promise<Fired>(() => {}) });
  void h.launch("orbit", "Do the thing.");
  await flush();
  const job = only(h.jobs);
  assert.deepEqual(h.calls, ["pushBrief", "fire"]);
  assert.ok(job.launch?.briefCommit, "the brief commit is recorded before the fire");
  assert.ok(job.launch?.fireStartedAt, "the fire start is persisted before the request is sent");
  assert.equal(job.launch?.toolCommitSent, COMMIT);
  assert.equal(job.launch?.sessionId, undefined);
  assert.equal(job.launch?.failedAt, undefined);
  assert.equal(dispatchEvidence(job, h.at(MIN)).state, "in-flight");
  const later = dispatchEvidence(job, h.at(IN_FLIGHT_MS + MIN));
  assert.equal(later.state, "dispatch-unknown");
  assert.equal(later.record, "new");
  assert.match(later.basis, /no provider answer and no failure were ever recorded/);
  assert.match(later.caveat ?? "", /not evidence that no cloud session exists/);
  h.advance(11 * MIN);
  assert.equal(h.jobs.health(only(h.jobs)), "not-started", "health alone cannot tell this apart from an accepted, silent session");
});

test("ORBIT stopping during the brief write leaves a record that proves the routine was never fired", async () => {
  const h = harness({ pushBrief: () => new Promise(() => {}) });
  void h.launch("orbit", "Do the thing.");
  await flush();
  const job = only(h.jobs);
  assert.deepEqual(h.calls, ["pushBrief"]);
  assert.equal(job.launch?.briefCommit, undefined);
  assert.equal(dispatchEvidence(job, h.at(MIN)).state, "in-flight");
  assert.equal(dispatchEvidence(job, h.at(IN_FLIGHT_MS + MIN)).state, "never-dispatched");
});

test("a failed brief write is never-dispatched and nothing is fired", async () => {
  const h = harness({ pushBrief: async () => Promise.reject(new Error("GitHub PUT returned HTTP 500")) });
  const r = await h.launch("orbit", "Do the thing.");
  assert.equal(r.code, 502);
  assert.deepEqual(h.calls, ["pushBrief"]);
  assert.equal(dispatchEvidence(only(h.jobs)).state, "never-dispatched");
});

test("a provider-accepted fire with a silent runner is provider-accepted, and missing callbacks are never read as no session", async () => {
  const h = harness();
  assert.equal((await h.launch("orbit", "Do the thing.")).code, 202);
  const job = only(h.jobs);
  assert.ok(job.launch?.firedAt);
  const e = dispatchEvidence(job, h.at(2 * IN_FLIGHT_MS));
  assert.equal(e.state, "provider-accepted");
  assert.equal(e.sessionId, "cse_accepted");
  assert.match(e.caveat ?? "", /not evidence that no cloud session exists/);
  h.advance(11 * MIN);
  assert.equal(h.jobs.health(only(h.jobs)), "not-started");
});

test("the routine trigger classifies what a failed fire says about the provider", async () => {
  const answer = (res: () => Response | Promise<Response>) => routineTrigger("orbit", "trig_x", "t", (async () => res()) as unknown as typeof fetch);
  const kind = async (r: Routine) => r.fire("x").then(() => "ok", (e) => fireFailureOf(e));
  assert.equal(await kind(answer(() => new Response("", { status: 401 }))), "rejected");
  assert.equal(await kind(answer(() => new Response("", { status: 429 }))), "rejected");
  assert.equal(await kind(answer(() => new Response("", { status: 502 }))), "server-error");
  assert.equal(await kind(answer(() => Response.json({}))), "no-session");
  assert.equal(await kind(answer(() => new Response("not json", { status: 200 }))), "no-session");
  assert.equal(await kind(answer(() => Promise.reject(new TypeError("fetch failed")))), "transport");
  assert.equal(fireFailureOf(new Error("anything else")), "transport", "an unclassified error is never read as a provider refusal");
  const e = await answer(() => new Response("", { status: 403 })).fire("x").catch((err) => err);
  assert.ok(e instanceof RoutineFireError);
  assert.equal(e.status, 403);
  assert.match(e.message, /fire returned HTTP 403/, "the message older readers match is unchanged");
});

test("each failed-fire kind is recorded on the job and read as the right dispatch state; only a refusal is provider-rejected", async () => {
  const cases: [string, () => Promise<Fired>, string, RegExp][] = [
    ["rejected", async () => Promise.reject(new RoutineFireError("Routine orbit fire returned HTTP 401", "rejected", 401)), "provider-rejected", /^routine not fired: Routine orbit fire returned HTTP 401$/],
    ["server-error", async () => Promise.reject(new RoutineFireError("Routine orbit fire returned HTTP 503", "server-error", 503)), "dispatch-unknown", /outcome unknown/],
    ["no-session", async () => Promise.reject(new RoutineFireError("Routine orbit fire returned no session", "no-session", 200)), "provider-accepted", /provider accepted the request/],
    ["transport", async () => Promise.reject(new TypeError("fetch failed")), "dispatch-unknown", /^routine not fired: fetch failed \(outcome unknown/],
  ];
  for (const [kind, fire, state, error] of cases) {
    const h = harness({ fire });
    const r = await h.launch("orbit", "Do the thing.");
    assert.equal(r.code, 502, kind);
    const job = only(h.jobs);
    assert.equal(job.launch?.fireFailure, kind);
    assert.match(job.launch?.error ?? "", error, kind);
    assert.match(job.launch?.error ?? "", /^routine not fired/, "the prefix older readers match on is kept");
    assert.equal(dispatchEvidence(job).state, state, kind);
    assert.equal(h.jobs.health(job), "launch-failed", kind);
    const told = h.notes.recent().map((n) => n.text).join("\n");
    assert.equal(/Not retried/.test(told), kind !== "rejected", `${kind}: an unknown outcome says it was not retried`);
  }
});

test("a fire whose answer was lost, followed by the runner reporting in, is no longer shown as launch-failed", async () => {
  const h = harness({ fire: async () => Promise.reject(new TypeError("fetch failed")) });
  await h.launch("orbit", "Do the thing.");
  const id = only(h.jobs).id;
  assert.equal(h.jobs.health(only(h.jobs)), "launch-failed");
  assert.match(h.jobs.status().detail, /^0 active/);
  h.jobs.record(id, { type: "started", toolCommit: COMMIT });
  const job = h.jobs.get(id)!;
  assert.equal(h.jobs.health(job), "ok");
  assert.equal(dispatchEvidence(job).state, "runner-reported");
  assert.match(h.jobs.status().detail, /^1 active/);
  assert.ok(job.launch?.failedAt, "the recorded failure is kept as history, not erased");
});

test("the git reconciler still reads a failed launch whose outcome is unknown, and never one that provably reached no runner", async () => {
  const reads: string[] = [];
  const record: GitRecord = { head: "h1", started: true, toolCommit: COMMIT };
  const control: ControlRepo = { pushBrief: async () => ({ branch: "", commit: "" }), readJob: async (id) => (reads.push(id), record) };
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 7), notes);
  const at = new Date(Date.now() - 20 * MIN).toISOString();
  const add = (id: string, launch: Launch) => (jobs.register(id), jobs.setLaunch(id, launch));
  add("lost", { routine: "orbit", at, briefCommit: "b1", fireStartedAt: at, failedAt: at, error: "routine not fired: fetch failed", fireFailure: "transport" });
  add("refused", { routine: "orbit", at, briefCommit: "b2", fireStartedAt: at, failedAt: at, error: "routine not fired: Routine orbit fire returned HTTP 401", fireFailure: "rejected" });
  add("nobrief", { routine: "orbit", at, failedAt: at, error: "brief not written: GitHub returned HTTP 500" });
  await gitReconciler(jobs, control)();
  assert.deepEqual(reads, ["lost"]);
  assert.equal(jobs.get("lost")!.events[0].via, "git");
  assert.equal(jobs.get("lost")!.toolCommit, COMMIT);
  assert.equal(jobs.health(jobs.get("lost")!), "ok");
  assert.equal(jobs.get("refused")!.events.length, 0);
});

test("legacy records (no fire-start field) are read conservatively", () => {
  const at = "2026-11-18T01:18:14.000Z";
  const later = new Date("2026-11-18T02:38:00Z");
  const job = (launch: Launch): Job => ({ id: "legacy", createdAt: at, expiresAt: "2026-11-19T01:18:14.000Z", state: "registered", events: [], steers: [], launch });
  const base = { routine: "orbit", at, branch: "orbit/legacy", briefCommit: "9f36a472f088bfcf85da5d222676b0d82a97044d" };
  const unknown = dispatchEvidence(job(base), later);
  assert.equal(unknown.state, "dispatch-unknown");
  assert.equal(unknown.record, "legacy");
  assert.match(unknown.basis, /older record/);
  assert.equal(dispatchEvidence(job({ ...base, sessionId: "cse_old", sessionUrl: "u" }), later).state, "provider-accepted");
  assert.equal(dispatchEvidence(job({ ...base, failedAt: at, error: "routine not fired: Routine orbit fire returned HTTP 404" }), later).state, "provider-rejected");
  assert.equal(dispatchEvidence(job({ ...base, failedAt: at, error: "routine not fired: Routine orbit fire returned HTTP 500" }), later).state, "dispatch-unknown");
  assert.equal(dispatchEvidence(job({ ...base, failedAt: at, error: "routine not fired: fetch failed" }), later).state, "dispatch-unknown");
  assert.equal(dispatchEvidence(job({ ...base, failedAt: at, error: "routine not fired: Routine orbit fire returned no session" }), later).state, "provider-accepted");
  assert.equal(dispatchEvidence(job({ routine: "orbit", at, failedAt: at, error: "brief not written: x" }), later).state, "never-dispatched");
  assert.equal(dispatchEvidence({ ...job(base), launch: undefined }, later).state, "no-launch-record");
});

test("the reported state of orbit-202611180118-hcey (registered, brief commit, no events, no tool commit) fits more than one outcome", () => {
  // A synthetic record shaped from what the diagnostic brief reports about the real one. Whether the real record holds a session id is not
  // known to this repository; the two readings below are why the original launch stays unresolved until the owner reads that field.
  const at = "2026-11-18T01:18:14.000Z";
  const reported: Job = { id: "orbit-202611180118-hcey", createdAt: at, expiresAt: "2026-11-19T01:18:14.000Z", state: "registered", events: [], steers: [],
    launch: { routine: "orbit", at, branch: "orbit/orbit-202611180118-hcey", briefCommit: "9f36a472f088bfcf85da5d222676b0d82a97044d" } };
  const now = new Date("2026-11-18T02:38:00Z");
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const health = jobRegistry(jsonStore<Job[]>(undefined, "j", [reported]), Buffer.alloc(32, 7), notes, () => now).health(reported);
  assert.equal(health, "not-started");
  assert.equal(reported.toolCommit, undefined);
  assert.equal(dispatchEvidence(reported, now).state, "dispatch-unknown", "without a session id: ORBIT stopped before the fire returned");
  const withSession = { ...reported, launch: { ...reported.launch!, sessionId: "cse_placeholder", sessionUrl: "https://claude.ai/code/cse_placeholder" } };
  assert.equal(dispatchEvidence(withSession, now).state, "provider-accepted", "with one: the provider accepted it and the session never reported");
});

test("a tool commit the Routine prompt would refuse is recorded and called out; the token never is", async () => {
  const h = harness({ commit: "not-a-commit", fire: () => new Promise<Fired>(() => {}) });
  void h.launch("orbit", "Do the thing.");
  await flush();
  const job = only(h.jobs);
  assert.equal(job.launch?.toolCommitSent, "unknown");
  assert.match(h.sent[0], /^Tool commit: unknown$/m);
  const token = h.sent[0].match(/^Token: (.+)$/m)![1];
  assert.equal(JSON.stringify(job).includes(token), false, "the launch record never holds the token");
  assert.match(dispatchEvidence(job, h.at(IN_FLIGHT_MS + MIN)).caveat ?? "", /tool commit "unknown", which the Routine prompt refuses/);
});

test("the fire text is unchanged: ids only, in the same order", async () => {
  const h = harness();
  await h.launch("orbit", "Do the thing.");
  assert.deepEqual(h.sent[0].split("\n").map((l) => l.split(":")[0]), ["Job id", "API", "Token", "Tool commit"]);
});

test("job views and the not-started alert carry the dispatch evidence", async () => {
  const h = harness({ fire: () => new Promise<Fired>(() => {}) });
  void h.launch("orbit", "Do the thing.");
  await flush();
  const job = only(h.jobs);
  assert.equal("dispatch" in compactJob(job, "ok"), false, "jobs_list rows stay short (the tool result is clipped at 8000 characters)");
  assert.equal(jobRow(job, "ok").dispatch, "in-flight");
  assert.equal(detailJob(job, "ok").dispatch.state, "in-flight");
  assert.match(String((detailJob(job, "ok").dispatch as { basis?: string }).basis), /may still be running/, "a job with no runner event gets the basis");
  assert.deepEqual(detailJob({ ...job, events: [{ at: job.createdAt, type: "started", via: "api" }] }, "ok").dispatch, { state: "runner-reported" });

  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const old = new Date(Date.now() - IN_FLIGHT_MS - MIN).toISOString();
  const stale: Job = { ...job, launch: { ...job.launch!, at: old, fireStartedAt: old } };
  const registry = jobRegistry(jsonStore<Job[]>(undefined, "j", [stale]), Buffer.alloc(32, 7), notes);
  watcher(jsonStore(undefined, "w", { ports: {} }), notes, () => new Date(), registry).tick();
  const alert = notes.recent().find((n) => n.text.includes("not started"));
  assert.ok(alert, "the not-started alert is still sent");
  assert.match(alert.text, /Dispatch: dispatch-unknown \(/);
});

test("work-session evidence: the runner's own events outrank a recorded fire failure", async () => {
  const { workSessions, workFile } = await import("../src/work-sessions.ts");
  const work = workSessions(workFile(undefined));
  const at = new Date().toISOString();
  const link = { proposal: "p1", workSession: "ws1", origin: { session: null, basis: "unknown" as const, why: "test" }, attachment: "new" as const, confirmedAt: at, launch: { state: "failed" as const, job: "j1", at } };
  const failed: Job = { id: "j1", createdAt: at, expiresAt: at, state: "registered", events: [], steers: [], launch: { routine: "orbit", at, briefCommit: "b1", failedAt: at, error: "routine not fired: fetch failed (outcome unknown: the request may have reached the provider)", fireFailure: "transport" } };
  assert.equal(work.evidence(link as never, failed).state, "failed");
  const reported: Job = { ...failed, state: "running", events: [{ at, type: "started", via: "api" }] };
  assert.equal(work.evidence(link as never, reported).state, "launched");
});
