import assert from "node:assert/strict";
import { test } from "node:test";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job, Launch } from "../src/jobs.ts";
import { dispatchEvidence, launchOutcome, launchTracker } from "../src/launch-evidence.ts";
import { launchReconciliations, ReconcileError, reconFile } from "../src/launch-reconciliation.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";
import { workFile, workSessions, WorkError } from "../src/work-sessions.ts";

// Characterization of what the owner-confirmed reconciliation workflow can and cannot do for a launch recorded by the launcher that
// predates fireStartedAt: brief commit stored, no fire-start time, no session id, no failure, no events. That is the shape reported for
// orbit-202611180118-hcey (docs/reviews/host-inventory-recovery-handoff.md, section 3). Synthetic only: in-memory stores, no provider, no
// network, and no live record is read or changed. Nothing here is a production change; it pins current behavior so the handoff's claims
// are checked by the suite.

const MIN = 60_000;
const T0 = new Date("2026-11-18T01:18:14Z");
const at = (ms = 0) => new Date(T0.getTime() + ms).toISOString();
const ID = "orbit-202611180118-lgcy";
// A placeholder commit id, not the historical one: the shape matters here, not the value.
const LEGACY: Launch = { routine: "orbit", at: at(), branch: `orbit/${ID}`, briefCommit: "b1ef0000b1ef0000b1ef0000b1ef0000b1ef0000" };
const CHECKED = at(5 * 60 * MIN);
// Wider than any margin the code asks for: the refusal must come from the record, not from the window.
const NO_RUN = { kind: "provider-no-run", source: "routine-run-history", checkedAt: CHECKED, windowFrom: at(-60 * MIN), windowTo: at(3 * 60 * MIN), reason: "Run history for the whole evening shows no run for this job id." };
const ENDED = (output: string) => ({ kind: "provider-session-ended", source: "routine-run-history", checkedAt: CHECKED, sessionId: "cse_placeholder1", output, reason: "Run history lists one run for this job id and it has ended." });
const RUNNING = { kind: "provider-session-running", source: "session-page", checkedAt: CHECKED, sessionId: "cse_placeholder1", reason: "The session page does not show that the run ended." };
// What an owner report such as "no jobs are active" can be recorded as: a decision, with no provider evidence fields.
const ABANDON = { kind: "abandon-tracking", reason: "Owner reports no jobs are active; provider run history was not checked." };

function setup() {
  const clock = new Date(T0.getTime() + 5 * 60 * MIN);
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, "jobs-cloud", []), Buffer.alloc(32, 7), notes, () => clock);
  jobs.register(ID);
  jobs.setLaunch(ID, LEGACY);
  const recon = launchReconciliations(reconFile(undefined), () => clock, { notify: notes, inFlight: launchTracker() });
  const record = (input: Record<string, unknown>) => {
    const p = recon.preview(jobs.get(ID)!, input);
    return recon.confirm(jobs.get(ID)!, input, p.digest);
  };
  // The work session the original confirmation created, with the launch linked to it.
  const work = workSessions(workFile(undefined));
  const origin = { session: "chat:00000000-0000-4000-8000-000000000001", basis: "server-turn" as const };
  const link = work.begin("p-original", origin, { attachment: "new" });
  work.settle("p-original", { code: 202, body: { id: ID } });
  const reader = { all: () => jobs.all(), health: (j: Job) => jobs.health(j) };
  const retry = () => {
    try {
      return { ok: true as const, plan: work.plan({ workSession: link.workSession, as: "retry", retryOf: ID }, origin, reader, (j) => recon.view(j)) };
    } catch (e) {
      assert.ok(e instanceof WorkError, String(e));
      return { ok: false as const, code: e.code, message: e.message };
    }
  };
  return { jobs, recon, record, work, origin, retry, job: () => jobs.get(ID)! };
}

test("legacy shape: dispatch-unknown and unresolved, and a work-session retry is refused while nothing is recorded", () => {
  const s = setup();
  assert.equal(dispatchEvidence(s.job()).state, "dispatch-unknown");
  assert.equal(dispatchEvidence(s.job()).record, "legacy");
  assert.equal(launchOutcome(s.job()).outcome, "unresolved");
  const r = s.retry();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 409);
    assert.match(r.message, /unresolved \(dispatch-unknown\)/);
  }
});

test("legacy shape: provider-no-run is refused however wide the window, and nothing is written", () => {
  const s = setup();
  assert.throws(
    () => s.recon.preview(s.job(), NO_RUN),
    (e: unknown) => e instanceof ReconcileError && e.code === 409 && /no fire-start time/.test(e.message),
  );
  assert.equal(s.recon.entries(ID).length, 0);
});

test("legacy shape: an owner report without provider evidence can only abandon tracking, which changes no record and allows no retry", () => {
  const s = setup();
  const before = JSON.stringify(s.job());
  s.record(ABANDON);
  const view = s.recon.view(s.job());
  assert.equal(view.state, "tracking-abandoned");
  assert.equal(view.retry.allowed, false);
  assert.equal(JSON.stringify(s.job()), before, "the job record is unchanged");
  assert.equal(launchOutcome(s.job()).outcome, "unresolved");
  const r = s.retry();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 409);
    assert.match(r.message, /residual duplicate risk/);
  }
  // Provider evidence fields are refused on an abandonment: it cannot be dressed up as evidence.
  assert.throws(() => s.recon.preview(s.job(), { ...ABANDON, checkedAt: CHECKED }), (e: unknown) => e instanceof ReconcileError && e.code === 400);
});

test("legacy shape: only session evidence opens the retry gate, and only for a session that ended with no output", () => {
  for (const [input, allowed] of [[ENDED("none"), true], [ENDED("pushed"), false], [ENDED("unknown"), false], [RUNNING, false]] as const) {
    const s = setup();
    s.record(input);
    assert.equal(s.recon.view(s.job()).retry.allowed, allowed, `${input.kind} ${"output" in input ? input.output : ""}`);
    assert.equal(s.retry().ok, allowed);
  }
});

test("a new, unattached launch is not checked against any reconciliation (the duplicate-risk gate for a replacement is the owner's)", () => {
  // Pins current behavior that the handoff reports as an outstanding gap: plan() consults the reconciliation log only for
  // attach.as = "retry". A fresh launch of the same work is planned as "new" without reading the job store or the log.
  const s = setup();
  s.record(ABANDON);
  let consulted = 0;
  const plan = s.work.plan(undefined, s.origin, { all: () => (consulted++, s.jobs.all()), health: (j: Job) => s.jobs.health(j) }, (j) => (consulted++, s.recon.view(j)));
  assert.deepEqual(plan, { attachment: "new" });
  assert.equal(consulted, 0);
});
