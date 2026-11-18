import assert from "node:assert/strict";
import { test } from "node:test";
import { jobLauncher } from "../src/job-launch.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job, Launch } from "../src/jobs.ts";
import { dispatchEvidence, launchOutcome, launchTracker } from "../src/launch-evidence.ts";
import { RoutineFireError } from "../src/launcher.ts";
import type { ControlRepo, Fired, Routine } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jobStateOf } from "../src/ops-sys.ts";
import { jsonStore } from "../src/store.ts";
import { watcher } from "../src/watch.ts";
import type { WatchState } from "../src/watch.ts";
import { workFile, workSessions, WorkError } from "../src/work-sessions.ts";

// The one reading of a launch that the not-started alert, the host-operation job warnings, the retry gate and the work-session link state
// share (src/launch-evidence.ts launchOutcome). Follow-up to the review of PR #122. Everything is synthetic: in-memory stores, fake GitHub,
// fake Routine. Nothing here calls a provider, retries a real job or touches live job state; the pattern of the historical silent job
// (registered, brief commit, no events) is rebuilt from fixtures only.

const MIN = 60_000;
const COMMIT = "4297487b753847104433af7d43a0890f81d4fad9";
const T0 = new Date("2026-11-18T03:00:00Z");

function registry(persisted = false) {
  let clock = T0;
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const store = jsonStore<Job[]>(undefined, "j", []);
  // jobStateOf only vouches for a persisted job store; the in-memory one is marked persisted for those tests.
  if (persisted) Object.defineProperty(store, "persisted", { value: true });
  const jobs = jobRegistry(store, Buffer.alloc(32, 9), notes, () => clock);
  return { jobs, notes, now: () => clock, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

const at = (ms = 0) => new Date(T0.getTime() + ms).toISOString();
const base = (over: Partial<Launch> = {}): Launch => ({ routine: "orbit", at: at(), branch: "orbit/x", briefCommit: "b1ef0000b1ef0000b1ef0000b1ef0000b1ef0000", fireStartedAt: at(), toolCommitSent: COMMIT, ...over });
const failed = (fireFailure: Launch["fireFailure"], error: string): Launch => base({ failedAt: at(), error, fireFailure });
const TRANSPORT = failed("transport", "routine not fired: fetch failed (outcome unknown: the request may have reached the provider)");
const SERVER = failed("server-error", "routine not fired: Routine orbit fire returned HTTP 503 (outcome unknown: the request may have reached the provider)");
const NO_SESSION = failed("no-session", "routine not fired: Routine orbit fire returned no session (the provider accepted the request; which session it started is unknown)");
const REJECTED = failed("rejected", "routine not fired: Routine orbit fire returned HTTP 401");
const NO_BRIEF: Launch = { routine: "orbit", at: at(), failedAt: at(), error: "brief not written: GitHub PUT returned HTTP 500" };

function add(r: ReturnType<typeof registry>, id: string, launch?: Launch): Job {
  r.jobs.register(id);
  if (launch) r.jobs.setLaunch(id, launch);
  return r.jobs.get(id)!;
}

// A work session with one recorded run of `job`, so the retry gate can be asked about it.
function retryGate(jobs: ReturnType<typeof registry>["jobs"], job: string, recorded: { code: number; body: unknown } = { code: 202, body: { id: job } }) {
  const work = workSessions(workFile(undefined));
  const origin = { session: "chat:00000000-0000-4000-8000-000000000001", basis: "server-turn" as const };
  const link = work.begin("p-first", origin, { attachment: "new" });
  work.settle("p-first", recorded);
  return {
    work,
    link: () => work.linkOf("p-first")!,
    ask: () => {
      try {
        return { ok: true as const, plan: work.plan({ workSession: link.workSession, as: "retry", retryOf: job }, origin, jobs) };
      } catch (err) {
        assert.ok(err instanceof WorkError);
        return { ok: false as const, code: err.code, message: err.message };
      }
    },
  };
}

// ---- dispatch in this process vs. a launch begun before a restart ------------------------------------------------------------

test("restart interruption: a launch begun one minute ago that this process is not running is dispatch-unknown, never in-flight", () => {
  const r = registry();
  r.advance(MIN);
  const job = add(r, "orbit-restart", base());
  // The exact case of the review: recent, brief commit and fire start recorded, no result. The old reading called it in-flight for 30 min.
  const e = dispatchEvidence(job, { inFlight: launchTracker() });
  assert.equal(e.state, "dispatch-unknown");
  assert.match(e.basis, /this ORBIT process is not running the launch/);
  assert.match(e.caveat ?? "", /not evidence that no cloud session exists/);
  assert.equal(launchOutcome(job, { inFlight: launchTracker() }).outcome, "unresolved");
  // Stopped during the brief write: no brief commit and not running here, so provably never fired, however recent.
  const early = add(r, "orbit-early", { routine: "orbit", at: at(MIN) });
  assert.equal(dispatchEvidence(early, { inFlight: launchTracker() }).state, "never-dispatched");
  assert.equal(launchOutcome(early, { inFlight: launchTracker() }).outcome, "not-launched");
});

test("in-process dispatch: only a launch this process is running is in-flight, and it leaves the tracker when the launcher returns or throws", async () => {
  const r = registry();
  const inFlight = launchTracker();
  let releaseBrief!: () => void;
  let answer!: (f: Fired) => void;
  let refuse!: (e: unknown) => void;
  const control: ControlRepo = { pushBrief: (job) => new Promise((ok) => (releaseBrief = () => ok({ branch: `orbit/${job}`, commit: "b2ef0000b2ef0000b2ef0000b2ef0000b2ef0000" }))) };
  const routine: Routine = { name: "orbit", fire: () => new Promise<Fired>((ok, no) => ((answer = ok), (refuse = no))) };
  const launch = jobLauncher({ jobs: r.jobs, control, routines: new Map([["orbit", routine]]), notify: r.notes, commit: COMMIT, inFlight });
  const tick = () => new Promise((res) => setImmediate(res));

  const first = launch("orbit", "Do the thing.");
  await tick();
  const id = r.jobs.all()[0].id;
  assert.equal(inFlight.has(id), true);
  assert.equal(dispatchEvidence(r.jobs.get(id)!, { inFlight }).state, "in-flight");
  assert.match(dispatchEvidence(r.jobs.get(id)!, { inFlight }).basis, /writing the brief/);
  releaseBrief();
  await tick();
  assert.match(dispatchEvidence(r.jobs.get(id)!, { inFlight }).basis, /firing the routine, started /);
  assert.equal(launchOutcome(r.jobs.get(id)!, { inFlight }).outcome, "unresolved", "in flight is never ended");
  answer({ sessionId: "cse_ok", sessionUrl: "https://claude.ai/code/cse_ok" });
  assert.equal((await first).code, 202);
  assert.equal(inFlight.has(id), false);
  assert.equal(dispatchEvidence(r.jobs.get(id)!, { inFlight }).state, "provider-accepted");

  const second = launch("orbit", "Do another thing.");
  await tick();
  releaseBrief();
  await tick();
  const id2 = r.jobs.all()[1].id;
  assert.equal(inFlight.has(id2), true);
  refuse(new TypeError("fetch failed"));
  assert.equal((await second).code, 502);
  assert.equal(inFlight.has(id2), false, "a failed fire leaves the tracker too");
  assert.equal(dispatchEvidence(r.jobs.get(id2)!, { inFlight }).state, "dispatch-unknown");
});

// ---- one outcome for every consumer --------------------------------------------------------------------------------------------

test("unknown outcomes (transport, 5xx, 2xx without a session, interrupted fire) are unresolved everywhere: counted for host ops, never retried", () => {
  for (const [name, launch] of [["transport", TRANSPORT], ["server-error", SERVER], ["no-session", NO_SESSION], ["interrupted", base()], ["legacy-unclassified", base({ failedAt: at(), error: "x" })]] as const) {
    const r = registry(true);
    const job = add(r, `orbit-${name}`, launch);
    assert.equal(launchOutcome(job).outcome, "unresolved", name);
    r.advance(11 * MIN); // past the ten-minute not-started mark (a fresh launch with no result yet still counts as active)
    const s = jobStateOf(r.jobs, r.now)();
    assert.equal(s.known, true);
    assert.deepEqual([s.active, s.uncertain], [[], [job.id]], `${name}: a session may exist, so a reboot or update is warned about it`);
    const gate = retryGate(r.jobs, job.id);
    const asked = gate.ask();
    assert.equal(asked.ok, false, `${name}: not retried`);
    if (!asked.ok) {
      assert.equal(asked.code, 409);
      assert.match(asked.message, /launch outcome is unresolved/);
      assert.match(asked.message, /Nothing was done/);
    }
  }
});

test("explicit rejection and a failed brief write are definitive: left out of host-op warnings, recorded as failed, and retryable", () => {
  for (const [name, launch] of [["rejected", REJECTED], ["brief", NO_BRIEF]] as const) {
    const r = registry(true);
    const job = add(r, `orbit-${name}`, launch);
    assert.equal(launchOutcome(job).outcome, "not-launched", name);
    const s = jobStateOf(r.jobs, r.now)();
    assert.deepEqual([s.active, s.uncertain], [[], []], name);
    const gate = retryGate(r.jobs, job.id, { code: 502, body: { error: launch.error, job } });
    assert.equal(gate.link().launch.state, "failed", name);
    assert.equal(gate.work.evidence(gate.link(), job).state, "failed", name);
    const asked = gate.ask();
    assert.equal(asked.ok, true, name);
  }
});

test("a fire failure whose outcome is unknown is recorded on the link as ambiguous, not failed, and the link says it is not retried", () => {
  const r = registry(true);
  const job = add(r, "orbit-lost", TRANSPORT);
  const gate = retryGate(r.jobs, job.id, { code: 502, body: { error: TRANSPORT.error, job } });
  assert.equal(gate.link().launch.state, "ambiguous");
  assert.match(gate.link().launch.detail ?? "", /not retried automatically/);
  assert.match(gate.link().launch.detail ?? "", /outcome unknown/);
  assert.equal(gate.work.evidence(gate.link(), job).state, "ambiguous");
  // The job later leaves the job store: the link's own record still refuses the retry.
  const gone = retryGate({ all: () => [], health: () => "ok" } as never, job.id, { code: 502, body: { error: TRANSPORT.error, job } });
  assert.equal(gone.ask().ok, false);
});

test("a legacy failed link whose job left the job store is retryable only when its recorded error is definitive", () => {
  const empty = { all: () => [], health: () => "ok" } as never;
  // Links recorded before this change say "failed" for every fire failure; their detail is the launcher's error text.
  const legacy = (error: string) => {
    const gate = retryGate(empty, "orbit-legacy", { code: 202, body: { id: "orbit-legacy" } });
    gate.work.settle("p-first", { code: 502, body: { error, job: { id: "orbit-legacy" } } });
    assert.equal(gate.link().launch.state, "failed");
    return gate.ask().ok;
  };
  assert.equal(legacy("routine not fired: Routine orbit fire returned HTTP 403"), true);
  assert.equal(legacy("brief not written: GitHub PUT returned HTTP 500"), true);
  assert.equal(legacy("routine not fired: fetch failed"), false);
  assert.equal(legacy("routine not fired: Routine orbit fire returned HTTP 502"), false);
});

test("failedAt plus active runner events: the runner's evidence wins for host-op warnings and blocks a retry", () => {
  for (const launch of [TRANSPORT, REJECTED, NO_BRIEF]) {
    const r = registry(true);
    const job = add(r, "orbit-alive", launch);
    r.jobs.record(job.id, { type: "started", toolCommit: COMMIT });
    const live = r.jobs.get(job.id)!;
    assert.ok(live.launch?.failedAt, "the recorded failure is kept as history");
    assert.equal(launchOutcome(live).outcome, "runner-active", launch.fireFailure ?? "brief");
    const s = jobStateOf(r.jobs, r.now)();
    assert.deepEqual(s.active, [job.id], "a running runner is never hidden by a recorded fire failure");
    const asked = retryGate(r.jobs, job.id).ask();
    assert.equal(asked.ok, false);
    if (!asked.ok) assert.match(asked.message, /runner has reported and the run has not ended/);
    // Quiet for 15 minutes: still counted, as possibly working.
    r.advance(20 * MIN);
    assert.deepEqual(jobStateOf(r.jobs, r.now)().uncertain, [job.id]);
  }
});

test("late runner events: a refused retry of an unresolved launch becomes runner-active when the runner reports, and retryable only once it ends failed", () => {
  const r = registry(true);
  const job = add(r, "orbit-late", TRANSPORT);
  const gate = retryGate(r.jobs, job.id, { code: 502, body: { error: TRANSPORT.error, job } });
  assert.equal(gate.ask().ok, false);
  r.advance(40 * MIN);
  r.jobs.record(job.id, { type: "started", toolCommit: COMMIT, via: "git" });
  assert.equal(launchOutcome(r.jobs.get(job.id)!).outcome, "runner-active");
  assert.equal(gate.ask().ok, false);
  assert.deepEqual(jobStateOf(r.jobs, r.now)().active, [job.id]);
  assert.equal(gate.work.evidence(gate.link(), r.jobs.get(job.id)!).state, "launched");
  r.jobs.record(job.id, { type: "summary", status: "failed", text: "could not finish" });
  assert.equal(launchOutcome(r.jobs.get(job.id)!).outcome, "runner-ended");
  assert.equal(gate.ask().ok, true, "terminal runner evidence ends the run");
  assert.deepEqual(jobStateOf(r.jobs, r.now)().active, []);
});

test("terminal runner evidence: failed and blocked runs are retryable, a done run is not, and none is counted for host ops", () => {
  for (const [status, retryable] of [["failed", true], ["blocked", true], ["done", false]] as const) {
    const r = registry(true);
    const job = add(r, `orbit-${status}`, base({ sessionId: "cse_t", sessionUrl: "https://claude.ai/code/cse_t", firedAt: at() }));
    r.jobs.record(job.id, { type: "started", toolCommit: COMMIT });
    r.jobs.record(job.id, { type: "summary", status, text: "end" });
    assert.equal(launchOutcome(r.jobs.get(job.id)!).outcome, "runner-ended");
    assert.equal(retryGate(r.jobs, job.id).ask().ok, retryable, status);
    const s = jobStateOf(r.jobs, r.now)();
    assert.deepEqual([s.active, s.uncertain], [[], []], status);
  }
});

test("the historical silent pattern (registered, brief commit, no events, no session id) is unresolved: warned about, never retried", () => {
  // A fixture shaped like the reported record; the real job is not read, resolved, retried or launched.
  const r = registry(true);
  const job = add(r, "orbit-silent", { routine: "orbit", at: at(), branch: "orbit/orbit-silent", briefCommit: "9f36a472f088bfcf85da5d222676b0d82a97044d" });
  r.advance(80 * MIN);
  assert.equal(r.jobs.health(job), "not-started");
  assert.equal(dispatchEvidence(job).state, "dispatch-unknown");
  assert.equal(launchOutcome(job).outcome, "unresolved");
  assert.deepEqual(jobStateOf(r.jobs, r.now)().uncertain, [job.id]);
  assert.equal(retryGate(r.jobs, job.id).ask().ok, false);
});

// ---- the not-started alert: transitions, once each ------------------------------------------------------------------------------

test("alert transitions: in-flight at ten minutes, one update when a restart makes it dispatch-unknown, and no repeats", () => {
  const r = registry();
  const job = add(r, "orbit-alert", base());
  const store = jsonStore<WatchState>(undefined, "w", { ports: {} });
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  // recent() is newest first; these read oldest first.
  const alerts = () => notes.recent().map((n) => n.text).filter((t) => t.startsWith("Job orbit-alert")).reverse();
  const running = launchTracker();
  running.begin(job.id);
  const before = watcher(store, notes, r.now, r.jobs, { inFlight: running });
  r.advance(11 * MIN);
  before.tick();
  before.tick();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /is not started .*Dispatch: in-flight \(this ORBIT process is still running the launch/);
  assert.match(before.status().detail, /Jobs alerting: orbit-alert not-started \(dispatch in-flight\)/);

  // ORBIT restarts: a new watcher on the same persisted state, with an empty tracker.
  const after = watcher(store, notes, r.now, r.jobs, { inFlight: launchTracker() });
  after.tick();
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1], /still not started; its dispatch evidence changed from in-flight to dispatch-unknown \(/);
  assert.match(alerts()[1], /not evidence that no cloud session exists/);
  for (let i = 0; i < 5; i++) (r.advance(MIN), after.tick());
  assert.equal(alerts().length, 2, "deduplicated: one message per material change");
  // A second restart with the same evidence says nothing.
  watcher(store, notes, r.now, r.jobs, { inFlight: launchTracker() }).tick();
  assert.equal(alerts().length, 2);
  // The runner reports late: the not-started record is cleared, and a later quiet spell is its own alert.
  r.jobs.record(job.id, { type: "started", toolCommit: COMMIT });
  after.tick();
  assert.equal(store.read().jobs?.[job.id], undefined);
  assert.equal(alerts().length, 2);
});

test("alert after a restart: the first not-started alert says dispatch-unknown, never in-flight", () => {
  const r = registry();
  add(r, "orbit-cut", base());
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const w = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), notes, r.now, r.jobs, { inFlight: launchTracker() });
  r.advance(10 * MIN + 1);
  w.tick();
  const texts = notes.recent().map((n) => n.text);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Dispatch: dispatch-unknown \(/);
  assert.doesNotMatch(texts[0], /in-flight/);
});

test("alert transitions: in-flight then provider-accepted is reported once; a failed fire ends the not-started alert", () => {
  const r = registry();
  const running = launchTracker();
  const job = add(r, "orbit-accept", base());
  running.begin(job.id);
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const store = jsonStore<WatchState>(undefined, "w", { ports: {} });
  const w = watcher(store, notes, r.now, r.jobs, { inFlight: running });
  r.advance(11 * MIN);
  w.tick();
  r.jobs.setLaunch(job.id, { ...job.launch!, sessionId: "cse_late", sessionUrl: "https://claude.ai/code/cse_late", firedAt: at(11 * MIN) });
  running.end(job.id);
  w.tick();
  w.tick();
  const texts = notes.recent().map((n) => n.text).reverse();
  assert.equal(texts.length, 2);
  assert.match(texts[1], /changed from in-flight to provider-accepted .*Session: https:\/\/claude\.ai\/code\/cse_late/);

  const other = add(r, "orbit-fails", base());
  running.begin(other.id);
  r.advance(11 * MIN);
  w.tick();
  r.jobs.setLaunch(other.id, { ...other.launch!, failedAt: at(22 * MIN), error: "routine not fired: Routine orbit fire returned HTTP 401", fireFailure: "rejected" });
  running.end(other.id);
  w.tick();
  assert.equal(store.read().jobs?.[other.id], undefined, "launch-failed is reported by the launcher, not the not-started watch");
  assert.equal(notes.recent().filter((n) => n.text.startsWith("Job orbit-fails")).length, 1);
});

test("alert records from before this change are taken as reported: a deploy never re-sends old not-started alerts", () => {
  const r = registry();
  const job = add(r, "orbit-old-alert", base());
  r.advance(60 * MIN);
  const store = jsonStore<WatchState>(undefined, "w", { ports: {}, jobs: { [job.id]: "not-started" } });
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const w = watcher(store, notes, r.now, r.jobs, { inFlight: launchTracker() });
  w.tick();
  w.tick();
  assert.equal(notes.recent().length, 0);
  assert.equal(store.read().jobs?.[job.id], "not-started:dispatch-unknown", "upgraded silently to the current evidence");
});
