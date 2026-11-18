import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job, Launch } from "../src/jobs.ts";
import { dispatchEvidence, launchTracker } from "../src/launch-evidence.ts";
import { launchReconciliations, MAX_ENTRIES_PER_JOB, ReconcileError, reconFile, reconciliationOf } from "../src/launch-reconciliation.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";
import { workFile, workSessions, WorkError } from "../src/work-sessions.ts";
import { rig } from "./threads-fixture.ts";

// Owner reconciliation of an unresolved launch (src/launch-reconciliation.ts, docs/reviews/launch-reconciliation.md section 9).
// Synthetic only: in-memory or temp-directory stores, no provider, no network beyond a local test server. The legacy shape of the
// historical silent job (brief commit, no fire-start time, no session, no events) is rebuilt from a fixture; no live record is read.

const MIN = 60_000;
const T0 = new Date("2026-11-18T01:18:14Z");
const at = (ms = 0) => new Date(T0.getTime() + ms).toISOString();
const BRIEF = "b1ef0000b1ef0000b1ef0000b1ef0000b1ef0000";
// The historical shape: brief commit recorded, no fire start (older launcher), no answer, no failure.
const LEGACY: Launch = { routine: "orbit", at: at(), branch: "orbit/x", briefCommit: BRIEF };
const ACCEPTED: Launch = { ...LEGACY, fireStartedAt: at(), sessionId: "cse_accepted1", sessionUrl: "https://claude.ai/code/cse_accepted1", firedAt: at(1000) };
const REJECTED: Launch = { ...LEGACY, fireStartedAt: at(), failedAt: at(1000), error: "routine not fired: Routine orbit fire returned HTTP 401", fireFailure: "rejected" };
const TRANSPORT: Launch = { ...LEGACY, fireStartedAt: at(), failedAt: at(1000), error: "routine not fired: fetch failed (outcome unknown: the request may have reached the provider)", fireFailure: "transport" };

const NO_RUN = { kind: "provider-no-run", source: "routine-run-history", checkedAt: at(4 * 60 * MIN), windowFrom: at(-MIN), windowTo: at(2 * MIN), reason: "Routine orbit run history shows no run for this job id between 01:17 and 01:20 UTC." };
const ENDED = (output: string, sessionId = "cse_found12") => ({ kind: "provider-session-ended", source: "session-page", checkedAt: at(4 * 60 * MIN), sessionId, output, reason: "The session page shows it stopped at the tool-commit check." });
const RUNNING = { kind: "provider-session-running", source: "session-page", checkedAt: at(4 * 60 * MIN), sessionId: "cse_found12", reason: "The session page still shows the session as active." };
const ABANDON = { kind: "abandon-tracking", reason: "Run history is no longer available; I stop tracking this launch." };

function setup(opts: { dir?: string; launch?: Launch; id?: string } = {}) {
  let clock = new Date(T0.getTime() + 5 * 60 * MIN);
  const sent: Notification[] = [];
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const notify = { ...notes, send: (text: string, urgent?: boolean) => (sent.push({ text, urgent } as unknown as Notification), notes.send(text, urgent)) } as typeof notes;
  const jobs = jobRegistry(jsonStore<Job[]>(opts.dir, "jobs-cloud", []), Buffer.alloc(32, 7), notes, () => clock);
  const id = opts.id ?? "orbit-202611180118-test";
  jobs.register(id);
  jobs.setLaunch(id, opts.launch ?? LEGACY);
  const inFlight = launchTracker();
  const recon = launchReconciliations(reconFile(opts.dir), () => clock, { notify, inFlight });
  const record = (input: Record<string, unknown>) => {
    const job = jobs.get(id)!;
    const p = recon.preview(job, input);
    return recon.confirm(job, input, p.digest);
  };
  return { jobs, id, recon, sent, inFlight, record, job: () => jobs.get(id)!, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

const refuses = (fn: () => unknown, code: number, re?: RegExp) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ReconcileError, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return;
  }
  assert.fail("expected a refusal");
};

// ---- confirmation gate -------------------------------------------------------------------------------------------------------

test("a preview writes nothing; a confirmation must carry the preview's digest, is single use and goes stale when the record changes", () => {
  const s = setup();
  const p = s.recon.preview(s.job(), NO_RUN);
  assert.match(p.digest, /^[0-9a-f]{64}$/);
  assert.equal(p.basedOn.dispatch, "dispatch-unknown");
  assert.equal(p.basedOn.briefCommit, BRIEF);
  assert.match(p.meaning, /found no run for this job/);
  assert.ok(p.doesNotMean.some((d) => /does not verify/.test(d)));
  assert.equal(s.recon.entries(s.id).length, 0, "the preview recorded nothing");

  refuses(() => s.recon.confirm(s.job(), NO_RUN, "nope"), 400);
  refuses(() => s.recon.confirm(s.job(), NO_RUN, "0".repeat(64)), 409, /does not match/);
  // The same digest with a different request (another reason) does not match.
  refuses(() => s.recon.confirm(s.job(), { ...NO_RUN, reason: "A different reason for the same entry." }, p.digest), 409);
  assert.equal(s.recon.entries(s.id).length, 0);

  const first = s.recon.confirm(s.job(), NO_RUN, p.digest);
  assert.equal(first.repeated, false);
  assert.equal(first.entry.actor, "owner");
  // A repeat of the same confirmation is answered from the log and records nothing.
  const again = s.recon.confirm(s.job(), NO_RUN, p.digest);
  assert.equal(again.repeated, true);
  assert.equal(again.entry.seq, first.entry.seq);
  assert.equal(s.recon.entries(s.id).length, 1);

  // A used digest sent with a different request is not a repeat: it is refused and records nothing.
  refuses(() => s.recon.confirm(s.job(), { ...NO_RUN, reason: "Another reason sent with an already used digest." }, p.digest), 409, /does not match/);
  // A digest previewed before another entry was recorded is stale.
  const p2 = s.recon.preview(s.job(), ABANDON);
  s.record(RUNNING);
  refuses(() => s.recon.confirm(s.job(), ABANDON, p2.digest), 409, /does not match/);
  assert.equal(s.recon.entries(s.id).length, 2);
});

test("a digest goes stale when ORBIT's record of the launch changes between preview and confirmation", () => {
  const s = setup();
  const p = s.recon.preview(s.job(), ABANDON);
  // The launch gains a session id (for example a late fire answer read from another source): the basis changed.
  s.jobs.setLaunch(s.id, { ...LEGACY, sessionId: "cse_late1234" });
  refuses(() => s.recon.confirm(s.job(), ABANDON, p.digest), 409, /does not match/);
});

// ---- unknown vs definitive outcomes -------------------------------------------------------------------------------------------

test("only unresolved launches can be reconciled: definitive failures, runner reports and in-flight launches are refused", () => {
  refuses(() => setup({ launch: REJECTED }).recon.preview(setup({ launch: REJECTED }).job(), ABANDON), 409, /already settles this launch \(not-launched/);
  const active = setup();
  active.jobs.record(active.id, { type: "started" });
  refuses(() => active.recon.preview(active.job(), NO_RUN), 409, /runner-active/);
  const ended = setup();
  ended.jobs.record(ended.id, { type: "summary", status: "done", text: "done" });
  refuses(() => ended.recon.preview(ended.job(), ABANDON), 409, /runner-ended/);
  const fly = setup();
  fly.inFlight.begin(fly.id);
  refuses(() => fly.recon.preview(fly.job(), ABANDON), 409, /still running this launch/);
  const none = setup();
  none.jobs.setLaunch(none.id, undefined as unknown as Launch);
  refuses(() => none.recon.preview(none.job(), ABANDON), 409, /no launch record/);
  // An unknown-outcome failure is unresolved, so it can be reconciled.
  const transport = setup({ launch: TRANSPORT });
  assert.equal(transport.recon.preview(transport.job(), NO_RUN).basedOn.dispatch, "dispatch-unknown");
});

test("provider-no-run is refused when ORBIT's record shows the provider accepted the fire; a named session must match the recorded one", () => {
  const s = setup({ launch: ACCEPTED });
  assert.equal(dispatchEvidence(s.job()).state, "provider-accepted");
  refuses(() => s.recon.preview(s.job(), NO_RUN), 409, /contradicts it/);
  refuses(() => s.recon.preview(s.job(), ENDED("none", "cse_other99")), 409, /different/);
  const ok = s.recon.preview(s.job(), ENDED("none", "cse_accepted1"));
  assert.equal(ok.basedOn.sessionId, "cse_accepted1");
});

test("the reading separates provider-confirmed evidence from unresolved dispatch and from abandonment", () => {
  const cases: [Record<string, unknown>, string, boolean][] = [
    [NO_RUN, "provider-confirmed-no-run", true],
    [ENDED("none"), "provider-confirmed-ended", true],
    [ENDED("pushed"), "provider-confirmed-ended", false],
    [ENDED("unknown"), "provider-confirmed-ended", false],
    [RUNNING, "provider-confirmed-running", false],
    [ABANDON, "tracking-abandoned", false],
  ];
  for (const [input, state, retry] of cases) {
    const s = setup();
    assert.equal(s.recon.view(s.job()).state, "none");
    assert.equal(s.recon.view(s.job()).retry.allowed, false);
    s.record(input);
    const v = s.recon.view(s.job());
    assert.equal(v.state, state, String(input.kind));
    assert.equal(v.retry.allowed, retry, `${input.kind}/${input.output ?? ""}`);
    // The job's own dispatch reading is unchanged by any entry.
    assert.equal(dispatchEvidence(s.job()).state, "dispatch-unknown");
    if (state.startsWith("provider-")) assert.match(v.caveat ?? "", /ORBIT did not verify it/);
  }
});

// ---- abandonment never claims cancellation, non-launch or termination ---------------------------------------------------------

test("abandoning tracking takes no provider evidence, changes no job and never claims a cancellation, a non-launch or an ended session", () => {
  const s = setup();
  for (const extra of [{ sessionId: "cse_found12" }, { output: "none" }, { checkedAt: at(MIN) }, { source: "session-page" }, { windowFrom: at(), windowTo: at(MIN) }]) refuses(() => s.recon.preview(s.job(), { ...ABANDON, ...extra }), 400, /takes no/);
  const before = structuredClone(s.job());
  const p = s.recon.preview(s.job(), ABANDON);
  assert.ok(p.doesNotMean.some((d) => /not a cancellation/.test(d)));
  assert.ok(p.doesNotMean.some((d) => /not evidence that no session ran/.test(d)));
  assert.match(p.effect, /stays unresolved/);
  s.recon.confirm(s.job(), ABANDON, p.digest);
  assert.deepEqual(s.job(), before, "the job record is byte-for-byte unchanged");
  const v = s.recon.view(s.job());
  assert.equal(v.state, "tracking-abandoned");
  assert.match(v.caveat ?? "", /not a cancellation/);
  assert.match(v.retry.basis, /residual duplicate risk/);
  const note = s.sent.at(-1)!.text;
  assert.match(note, /not a cancellation/);
  assert.doesNotMatch(note, /\b(cancelled|terminated|did not run|never ran)\b/i);
});

// ---- late runner events --------------------------------------------------------------------------------------------------------

test("a runner event after reconciliation outranks it: the entry is kept, ORBIT logs one late entry and tells the owner once", () => {
  const s = setup();
  s.record(NO_RUN);
  s.advance(MIN);
  s.jobs.record(s.id, { type: "started", via: "git" });
  const v = s.recon.view(s.job());
  assert.equal(v.state, "runner-evidence-after-reconciliation");
  assert.equal(v.lateEvents, 1);
  assert.equal(v.contradicted, true);
  assert.equal(v.retry.allowed, false);
  assert.equal(v.latest?.kind, "provider-no-run", "the owner entry is kept");

  const sentBefore = s.sent.length;
  const added = s.recon.observe(s.jobs);
  assert.equal(added.length, 1);
  assert.equal(added[0].contradicts, true);
  assert.equal(added[0].firstLateType, "started");
  assert.equal(s.sent.length, sentBefore + 1);
  assert.match(s.sent.at(-1)!.text, /contradicts your entry/);
  assert.equal(s.sent.at(-1)!.urgent, true);
  // Once per owner entry, however many ticks or events follow.
  s.jobs.record(s.id, { type: "checkin", text: "working" });
  assert.equal(s.recon.observe(s.jobs).length, 0);
  assert.equal(s.sent.length, sentBefore + 1);
  assert.deepEqual(s.recon.entries(s.id).map((e) => e.actor), ["owner", "orbit"]);
  // Further owner entries are refused now: the runner's own events settle the launch.
  refuses(() => s.recon.preview(s.job(), ABANDON), 409, /runner-active/);
});

test("a late event after abandonment is shown and reported, but is not a contradiction", () => {
  const s = setup();
  s.record(ABANDON);
  s.jobs.record(s.id, { type: "started" });
  const v = s.recon.view(s.job());
  assert.equal(v.state, "runner-evidence-after-reconciliation");
  assert.equal(v.contradicted, false);
  assert.equal(s.recon.observe(s.jobs)[0].contradicts, false);
  assert.equal(s.sent.at(-1)!.urgent, false);
});

// ---- persistence, restart, fail closed -----------------------------------------------------------------------------------------

test("the log survives a restart, keeps every entry in order, and an unreadable or newer file is never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-"));
  const s = setup({ dir });
  s.record(ABANDON);
  s.record(NO_RUN);
  const reopened = launchReconciliations(reconFile(dir), () => new Date(T0.getTime() + 6 * 60 * MIN));
  assert.deepEqual(reopened.entries(s.id).map((e) => [e.seq, e.kind]), [[1, "abandon-tracking"], [2, "provider-no-run"]]);
  assert.equal(reopened.view(s.job()).state, "provider-confirmed-no-run");
  assert.equal(reopened.status().state, "live");

  const file = join(dir, "launch-reconciliations.json");
  writeFileSync(file, "{not json");
  const broken = launchReconciliations(reconFile(dir));
  refuses(() => broken.preview(s.job(), ABANDON), 503, /unavailable/);
  assert.equal(broken.status().state, "unavailable");
  assert.deepEqual(broken.observe(s.jobs), []);
  assert.equal(readFileSync(file, "utf8"), "{not json", "left as it is");

  writeFileSync(file, JSON.stringify({ v: 99, entries: [] }));
  refuses(() => launchReconciliations(reconFile(dir)).view(s.job()), 503, /newer than this build/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 99);
});

test("a failed write records nothing, and the log refuses rather than drops when a job's history is full", () => {
  const s = setup();
  const failing = launchReconciliations({ persisted: true, load: () => undefined, save: () => { throw new Error("disk full"); } });
  const p = failing.preview(s.job(), ABANDON);
  assert.throws(() => failing.confirm(s.job(), ABANDON, p.digest), /disk full/);
  assert.equal(failing.entries(s.id).length, 0);
  for (let i = 0; i < MAX_ENTRIES_PER_JOB; i++) s.record({ ...ABANDON, reason: `${ABANDON.reason} (${i})` });
  refuses(() => s.recon.preview(s.job(), ABANDON), 409, /full/);
  assert.equal(s.recon.entries(s.id).length, MAX_ENTRIES_PER_JOB);
});

// ---- bounded, secret-safe input -------------------------------------------------------------------------------------------------

test("input is a fixed set of bounded fields: unknown fields, secrets, bad times and windows that miss the launch are refused", () => {
  const s = setup();
  const p = (input: Record<string, unknown>) => () => s.recon.preview(s.job(), input);
  refuses(p({ ...ABANDON, logs: "raw provider log" }), 400, /Unknown field/);
  refuses(p({ ...ABANDON, kind: "cancel" }), 400, /kind must be/);
  refuses(p({ kind: "abandon-tracking" }), 400, /reason is required/);
  refuses(p({ ...ABANDON, reason: "short" }), 400, /10 to 500/);
  refuses(p({ ...ABANDON, reason: "x".repeat(501) }), 400, /10 to 500/);
  refuses(p({ ...ABANDON, reason: "Checked the run list \u001b[31m red" }), 400, /control characters/);
  // Built at runtime, never a literal: a token-shaped value in the reason is refused, not stored.
  const fake = "gh" + "p_" + "x".repeat(36);
  refuses(p({ ...ABANDON, reason: `Used ${fake} to look at the run history.` }), 400, /credential or token/);
  refuses(p({ ...ENDED("none"), sessionId: "../../etc/passwd" }), 400, /sessionId must be/);
  refuses(p({ ...NO_RUN, checkedAt: "yesterday" }), 400, /UTC ISO time/);
  refuses(p({ ...NO_RUN, source: "session-page" }), 400, /routine-run-history/);
  refuses(p({ ...NO_RUN, windowFrom: at(MIN) }), 400, /must cover the launch/);
  refuses(p({ ...NO_RUN, windowTo: at(30_000) }), 400, /must cover the launch/);
  refuses(p({ ...NO_RUN, windowFrom: at(-25 * 60 * MIN) }), 400, /longer than 24 hours/);
  refuses(p({ ...NO_RUN, checkedAt: at(-MIN) }), 400, /before the launch/);
  refuses(p({ ...NO_RUN, checkedAt: at(10 * 60 * MIN) }), 400, /future/);
  refuses(p({ ...NO_RUN, checkedAt: at(MIN), windowTo: at(20 * MIN) }), 400, /ends after checkedAt/);
  refuses(p({ ...ENDED("maybe") }), 400, /needs output/);
  refuses(p({ ...RUNNING, output: "none" }), 400, /only for provider-session-ended/);
  refuses(p({ ...ENDED("none"), sessionId: undefined }), 400, /needs sessionId/);
  assert.equal(s.recon.entries(s.id).length, 0);
});

// ---- duplicate prevention: the work-session retry gate --------------------------------------------------------------------------

function gate(s: ReturnType<typeof setup>) {
  const work = workSessions(workFile(undefined));
  const origin = { session: "chat:00000000-0000-4000-8000-000000000001", basis: "server-turn" as const };
  const link = work.begin("p-first", origin, { attachment: "new" });
  work.settle("p-first", { code: 202, body: { id: s.id } });
  const reader = { all: () => s.jobs.all(), health: (j: Job) => s.jobs.health(j) };
  return (recon: Parameters<typeof work.plan>[3]) => {
    try {
      return { ok: true as const, plan: work.plan({ workSession: link.workSession, as: "retry", retryOf: s.id }, origin, reader, recon) };
    } catch (e) {
      assert.ok(e instanceof WorkError);
      return { ok: false as const, code: e.code, message: e.message };
    }
  };
}

test("retry of an unresolved launch: refused without reconciliation, after abandonment and while a session may work; allowed only on provider evidence", () => {
  const plain = setup();
  const ask0 = gate(plain);
  for (const r of [ask0(undefined), ask0((j) => plain.recon.view(j))]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /unresolved/);
  }
  for (const [input, allowed] of [[ABANDON, false], [RUNNING, false], [ENDED("pushed"), false], [ENDED("unknown"), false], [NO_RUN, true], [ENDED("none"), true]] as const) {
    const s = setup();
    const ask = gate(s);
    s.record(input);
    const r = ask((j) => s.recon.view(j));
    assert.equal(r.ok, allowed, `${input.kind} ${"output" in input ? input.output : ""}`);
    if (!r.ok) {
      assert.equal(r.code, 409);
      assert.match(r.message, /Nothing was done/);
      if (input.kind === "abandon-tracking") assert.match(r.message, /residual duplicate risk/);
    }
  }
  // Evidence that allowed a retry is overruled by a late runner event: the runner's report makes the run active, never retryable.
  const late = setup();
  const ask = gate(late);
  late.record(NO_RUN);
  late.jobs.record(late.id, { type: "started" });
  const r = ask((j) => late.recon.view(j));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /runner has reported/);
  // An unreadable log fails closed.
  const broken = setup();
  const r2 = gate(broken)(() => {
    throw new ReconcileError(503, "unreadable");
  });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, 503);
});

test("the pure reading never derives a state from a job alone", () => {
  assert.equal(reconciliationOf({ events: [] }, []).state, "none");
  assert.equal(reconciliationOf({ events: [] }, []).retry.allowed, false);
});

// ---- the owner route ------------------------------------------------------------------------------------------------------------

test("route: owner only; preview then confirm; the job record is unchanged and the reading is served with the job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-route-"));
  const recon = launchReconciliations(reconFile(dir), () => new Date(T0.getTime() + 5 * 60 * MIN));
  const x = rig({ dir, extra: () => ({ reconciliations: recon }) });
  try {
    const id = "orbit-202611180118-route";
    x.jobs.register(id);
    x.jobs.setLaunch(id, LEGACY);
    const before = JSON.stringify(x.jobs.get(id));
    const path = `/jobs/${id}/reconcile`;

    x.caller.who = "someone-else";
    assert.equal((await x.api(path)).status, 403);
    assert.equal((await x.api(path, "POST", ABANDON)).status, 403);
    x.caller.who = undefined;
    assert.equal((await x.api(path, "POST", ABANDON)).status, 403);
    x.caller.who = (await import("./threads-fixture.ts")).OWNER;

    const empty = await x.api(path);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.reconciliation.state, "none");
    assert.equal(empty.data.dispatch.state, "dispatch-unknown");

    const bad = await x.api(path, "POST", { ...ABANDON, sessionId: "cse_found12" });
    assert.equal(bad.status, 400);
    const preview = await x.api(path, "POST", ABANDON);
    assert.equal(preview.status, 200);
    assert.match(preview.data.preview.digest, /^[0-9a-f]{64}$/);
    assert.equal(recon.entries(id).length, 0, "a preview records nothing");
    const wrong = await x.api(path, "POST", { ...ABANDON, confirm: "f".repeat(64) });
    assert.equal(wrong.status, 409);
    const done = await x.api(path, "POST", { ...ABANDON, confirm: preview.data.preview.digest });
    assert.equal(done.status, 201);
    assert.equal(done.data.reconciliation.state, "tracking-abandoned");
    const repeat = await x.api(path, "POST", { ...ABANDON, confirm: preview.data.preview.digest });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.repeated, true);

    assert.equal(JSON.stringify(x.jobs.get(id)), before, "the job record is unchanged");
    const job = await x.api(`/jobs/${id}`);
    assert.equal(job.data.reconciliation.state, "tracking-abandoned");
    assert.equal(job.data.dispatch.state, "dispatch-unknown", "the dispatch reading still says unresolved");
    const detail = await x.api(`/jobs/${id}?view=detail`);
    assert.equal(detail.data.reconciliation.state, "tracking-abandoned");
    assert.equal((await x.api("/jobs/no-such-job/reconcile")).status, 404);
    // Persisted beside the job store, not in it.
    assert.equal(JSON.parse(readFileSync(join(dir, "launch-reconciliations.json"), "utf8")).entries.length, 1);
  } finally {
    x.close();
  }
});
