import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jobs as jobRegistry, KEEP_EVENTS } from "../src/jobs.ts";
import type { Job, Launch } from "../src/jobs.ts";
import { launchTracker } from "../src/launch-evidence.ts";
import { launchReconciliations, ReconcileError, reconFile } from "../src/launch-reconciliation.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";
import { workFile, workSessions, WorkError } from "../src/work-sessions.ts";

// Follow-up to the review of PR #132 (docs/reviews/launch-reconciliation.md section 9, "Review follow-up"). Synthetic only: temp
// directories and in-memory stores, no provider, no network. No live record is read; the historical job is not resolved here.
//
//   F1  the provider-no-run window is checked against the dispatch (fireStartedAt to the fire's end), at preview, confirmation and
//       every reading, including entries an older build admitted; unknown or inconsistent timing fails closed.
//   F2  a malformed persisted entry makes the whole log unavailable (503) instead of being skipped.
//   F3  observe() names the first late event by position, and says "first retained" when the true first is not in the record.

const MIN = 60_000;
const T = (s: string) => `2026-11-18T${s}Z`;
// The review's reproduction: launch recorded at 01:00:00, the brief write took three minutes, the fire started at 01:03:00 and failed in
// transport at 01:03:05 (dispatch-unknown).
const DELAYED: Launch = {
  routine: "orbit",
  at: T("01:00:00.000"),
  branch: "orbit/x",
  briefCommit: "b1ef0000b1ef0000b1ef0000b1ef0000b1ef0000",
  fireStartedAt: T("01:03:00.000"),
  failedAt: T("01:03:05.000"),
  error: "routine not fired: fetch failed (outcome unknown: the request may have reached the provider)",
  fireFailure: "transport",
};
const reason = "Routine orbit run history shows no run for this job id in the window I checked.";
const noRun = (windowFrom: string, windowTo: string, checkedAt = T("05:00:00")) => ({ kind: "provider-no-run", source: "routine-run-history", checkedAt, windowFrom, windowTo, reason });
// The review's window: it ends two minutes before the fire was sent.
const EARLY = noRun(T("00:59:00"), T("01:01:01"));
// A window that covers the dispatch with the margins (5 minutes before fireStartedAt, 15 after failedAt).
const COVERING = noRun(T("00:55:00"), T("01:20:00"));
const ABANDON = { kind: "abandon-tracking", reason: "Run history is no longer available; I stop tracking this launch." };
const RUNNING = { kind: "provider-session-running", source: "session-page", checkedAt: T("05:00:00"), sessionId: "cse_found12", reason: "The session page still shows the session as active." };
const ENDED_NONE = { kind: "provider-session-ended", source: "session-page", checkedAt: T("05:00:00"), sessionId: "cse_found12", output: "none", reason: "The session page shows it stopped at the tool-commit check." };
const ID = "orbit-202611180100-test";
const DIGEST = () => "d".repeat(64);

function setup(opts: { dir?: string; launch?: Launch } = {}) {
  let clock = new Date(T("05:10:00"));
  const sent: Notification[] = [];
  const notes = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const notify = { ...notes, send: (text: string, urgent?: boolean) => (sent.push({ text, urgent } as unknown as Notification), notes.send(text, urgent)) } as typeof notes;
  const jobs = jobRegistry(jsonStore<Job[]>(opts.dir, "jobs-cloud", []), Buffer.alloc(32, 7), notes, () => clock);
  jobs.register(ID);
  jobs.setLaunch(ID, opts.launch ?? DELAYED);
  const inFlight = launchTracker();
  const open = () => launchReconciliations(reconFile(opts.dir), () => clock, { notify, inFlight });
  const recon = open();
  const record = (input: Record<string, unknown>) => recon.confirm(jobs.get(ID)!, input, recon.preview(jobs.get(ID)!, input).digest);
  return { jobs, recon, open, sent, record, job: () => jobs.get(ID)!, setClock: (iso: string) => (clock = new Date(iso)) };
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

// The work-session retry gate, as src/server.ts wires it: the reconciliation reading of the job, or 503 when the log cannot be used.
function retryGate(jobs: ReturnType<typeof setup>["jobs"], recon: ReturnType<typeof launchReconciliations>) {
  const work = workSessions(workFile(undefined));
  const origin = { session: "chat:00000000-0000-4000-8000-000000000001", basis: "server-turn" as const };
  const link = work.begin("p-first", origin, { attachment: "new" });
  work.settle("p-first", { code: 202, body: { id: ID } });
  const reader = { all: () => jobs.all(), health: (j: Job) => jobs.health(j) };
  try {
    return { ok: true as const, plan: work.plan({ workSession: link.workSession, as: "retry", retryOf: ID }, origin, reader, (j) => recon.view(j)) };
  } catch (e) {
    assert.ok(e instanceof WorkError);
    return { ok: false as const, code: e.code, message: e.message };
  }
}

// An entry as the PR #132 build wrote it: basedOn without dispatch timing. Used to stand for persisted, previously admitted entries.
const oldOwnerEntry = (seq: number, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const { kind, reason: r, source, checkedAt, windowFrom, windowTo, sessionId, output } = input as Record<string, string>;
  const evidence = kind === "abandon-tracking" ? undefined : kind === "provider-no-run" ? { source, checkedAt, window: { from: windowFrom, to: windowTo } } : { source, checkedAt, sessionId, ...(output ? { output } : {}) };
  return {
    seq,
    job: ID,
    at: T("05:05:00.000"),
    actor: "owner",
    kind,
    ...(evidence ? { evidence } : {}),
    reason: r,
    digest: DIGEST(),
    basedOn: { launchAt: DELAYED.at, routine: "orbit", briefCommit: DELAYED.briefCommit, dispatch: "dispatch-unknown", outcome: "unresolved", events: 0 },
    ...extra,
  };
};
const writeLog = (dir: string, entries: unknown[]) => writeFileSync(join(dir, "launch-reconciliations.json"), JSON.stringify({ v: 1, entries }, null, 2));

// ---- F1: the window is checked against the dispatch, not the launch record time ------------------------------------------------

test("F1 regression: a window that ends before the fire was sent is refused at preview and confirmation, and never allows a retry", () => {
  const s = setup();
  refuses(() => s.recon.preview(s.job(), EARLY), 400, /must cover the dispatch/);
  refuses(() => s.recon.confirm(s.job(), EARLY, DIGEST()), 400, /must cover the dispatch/);
  assert.equal(s.recon.entries(ID).length, 0);
  assert.equal(s.recon.view(s.job()).retry.allowed, false);
  const r = retryGate(s.jobs, s.recon);
  assert.equal(r.ok, false);
});

test("F1: a window covering fireStartedAt - 5 min to the fire's end + 15 min is accepted; one that misses either margin is refused", () => {
  const s = setup();
  // Starts after fireStartedAt - 5 min (01:03 - 5 = 00:58).
  refuses(() => s.recon.preview(s.job(), noRun(T("00:59:00"), T("01:30:00"))), 400, /must cover the dispatch/);
  // Ends before failedAt + 15 min (01:18:05).
  refuses(() => s.recon.preview(s.job(), noRun(T("00:55:00"), T("01:18:00"))), 400, /must cover the dispatch/);
  const p = s.recon.preview(s.job(), COVERING);
  assert.match(p.meaning, /dispatch/);
  assert.equal(p.basedOn.fire?.fireStartedAt, DELAYED.fireStartedAt);
  assert.equal(p.basedOn.fire?.failedAt, DELAYED.failedAt);
  assert.equal(p.basedOn.fire?.fireFailure, "transport");
  s.recon.confirm(s.job(), COVERING, p.digest);
  const v = s.recon.view(s.job());
  assert.equal(v.state, "provider-confirmed-no-run");
  assert.equal(v.retry.allowed, true);
  assert.equal(retryGate(s.jobs, s.recon).ok, true);
  // The run history only covers its window: the preview and reading say so, and never more.
  assert.ok(p.doesNotMean.some((d) => /only the window you checked/.test(d)));
});

test("F1: legacy, interrupted and inconsistent timing fail closed for provider-no-run, however wide the window", () => {
  const wide = noRun(T("00:00:00"), T("04:59:00"));
  const cases: [string, Launch, RegExp][] = [
    ["legacy record without fireStartedAt", { routine: "orbit", at: DELAYED.at, branch: "orbit/x", briefCommit: DELAYED.briefCommit }, /no fire-start time/],
    ["legacy record with a failure but no fireStartedAt", { routine: "orbit", at: DELAYED.at, briefCommit: DELAYED.briefCommit, failedAt: T("01:03:05"), error: "routine not fired: fetch failed" }, /no fire-start time/],
    ["interrupted: fire started, no end recorded", { ...DELAYED, failedAt: undefined, error: undefined, fireFailure: undefined }, /no time for the end of the fire/],
    ["fireStartedAt before the launch record", { ...DELAYED, fireStartedAt: T("00:58:00.000") }, /inconsistent/],
    ["failedAt before fireStartedAt", { ...DELAYED, failedAt: T("01:02:00.000") }, /inconsistent/],
    ["unparseable fireStartedAt", { ...DELAYED, fireStartedAt: "soon" }, /inconsistent/],
  ];
  for (const [name, launch, re] of cases) {
    const s = setup({ launch });
    refuses(() => s.recon.preview(s.job(), wide), 409, re);
    assert.equal(s.recon.entries(ID).length, 0, name);
    // Session evidence and abandonment are still recordable; abandonment still never allows a retry.
    s.record(ABANDON);
    assert.equal(s.recon.view(s.job()).retry.allowed, false, name);
  }
  // A provider-accepted record is still refused for provider-no-run, before any timing question.
  const accepted = setup({ launch: { ...DELAYED, failedAt: undefined, error: undefined, fireFailure: undefined, sessionId: "cse_accepted1", sessionUrl: "https://claude.ai/code/cse_accepted1", firedAt: T("01:03:04.000") } });
  refuses(() => accepted.recon.preview(accepted.job(), wide), 409, /accepted this fire/);
});

test("F1: a change to the dispatch timing between preview and confirmation makes the approval stale", () => {
  const s = setup();
  const p = s.recon.preview(s.job(), COVERING);
  // The record gains a later fire end (for example a corrected record): still covered, but the basis changed.
  s.jobs.setLaunch(ID, { ...DELAYED, failedAt: T("01:04:00.000") });
  refuses(() => s.recon.confirm(s.job(), COVERING, p.digest), 409, /does not match/);
  // And a change that leaves the window short is refused outright at confirmation.
  const s2 = setup();
  const p2 = s2.recon.preview(s2.job(), COVERING);
  s2.jobs.setLaunch(ID, { ...DELAYED, failedAt: T("01:10:00.000") });
  refuses(() => s2.recon.confirm(s2.job(), COVERING, p2.digest), 400, /must cover the dispatch/);
  assert.equal(s2.recon.entries(ID).length, 0);
});

test("F1: an entry admitted by the older build with a window that misses the dispatch is revalidated and never allows a retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-f1-"));
  const s = setup({ dir });
  writeLog(dir, [oldOwnerEntry(1, EARLY)]);
  const reopened = s.open();
  const v = reopened.view(s.job());
  assert.equal(v.state, "provider-evidence-insufficient");
  assert.equal(v.retry.allowed, false);
  assert.match(v.retry.basis, /must cover the dispatch/);
  assert.equal(v.latest?.kind, "provider-no-run", "the entry is kept as history");
  const r = retryGate(s.jobs, reopened);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /provider-evidence-insufficient/);
  // The file is not rewritten by reading it.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "launch-reconciliations.json"), "utf8")).entries, [oldOwnerEntry(1, EARLY)]);
  // An older entry whose window does cover the dispatch still reads as it did (compatibility with valid existing records).
  writeLog(dir, [oldOwnerEntry(1, COVERING)]);
  const ok = s.open();
  assert.equal(ok.view(s.job()).retry.allowed, true);
  assert.equal(retryGate(s.jobs, ok).ok, true);
});

test("F1: an older no-run entry on a legacy record, and any entry whose launch record has since changed, never allow a retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-f1b-"));
  const legacy: Launch = { routine: "orbit", at: DELAYED.at, branch: "orbit/x", briefCommit: DELAYED.briefCommit };
  const s = setup({ dir, launch: legacy });
  writeLog(dir, [oldOwnerEntry(1, noRun(T("00:59:00"), T("01:30:00")))]);
  const v = s.open().view(s.job());
  assert.equal(v.retry.allowed, false);
  assert.match(v.retry.basis, /no fire-start time/);

  // An ended-without-output entry is re-read against the record too: a session id that appears later and differs refuses the retry.
  const s2 = setup();
  s2.record(ENDED_NONE);
  assert.equal(s2.recon.view(s2.job()).retry.allowed, true);
  s2.jobs.setLaunch(ID, { ...DELAYED, sessionId: "cse_other99" });
  const v2 = s2.recon.view(s2.job());
  assert.equal(v2.retry.allowed, false);
  assert.match(v2.retry.basis, /changed since your entry/);

  // A no-run entry whose record later shows a session (the provider accepted the fire after all) refuses the retry.
  const s3 = setup();
  s3.record(COVERING);
  s3.jobs.setLaunch(ID, { ...DELAYED, sessionId: "cse_late1234" });
  assert.equal(s3.recon.view(s3.job()).retry.allowed, false);
});

// ---- F2: malformed persisted entries fail closed ---------------------------------------------------------------------------------

test("F2 regression: a no-run entry without basedOn.events never leaves a retry allowed; the log is unavailable and left as it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-f2-"));
  const s = setup({ dir });
  const bad = oldOwnerEntry(1, COVERING);
  delete (bad.basedOn as Record<string, unknown>).events;
  writeLog(dir, [bad]);
  const before = readFileSync(join(dir, "launch-reconciliations.json"), "utf8");
  const recon = s.open();
  refuses(() => recon.view(s.job()), 503, /integrity check.*basedOn\.events/);
  refuses(() => recon.preview(s.job(), ABANDON), 503, /integrity check/);
  assert.equal(recon.status().state, "unavailable");
  assert.deepEqual(recon.observe(s.jobs), []);
  const r = retryGate(s.jobs, recon);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 503);
  assert.equal(readFileSync(join(dir, "launch-reconciliations.json"), "utf8"), before, "left as it is");
});

test("F2 regression: a corrupt newer entry never exposes an older provider-no-run as the latest decision", () => {
  for (const newer of [ABANDON, RUNNING]) {
    const dir = mkdtempSync(join(tmpdir(), "orbit-recon-f2b-"));
    const s = setup({ dir });
    const corrupt = oldOwnerEntry(2, newer);
    (corrupt as Record<string, unknown>).basedOn = "unreadable";
    writeLog(dir, [oldOwnerEntry(1, COVERING), corrupt]);
    const recon = s.open();
    refuses(() => recon.view(s.job()), 503, /integrity check/);
    assert.equal(retryGate(s.jobs, recon).ok, false);
  }
});

test("F2: malformed values, truncated entries and broken ordering are each reported, bounded and without stored text", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-f2c-"));
  const s = setup({ dir });
  const good = oldOwnerEntry(1, COVERING);
  const mut = (f: (e: Record<string, any>) => void) => {
    const e = structuredClone(good) as Record<string, any>;
    f(e);
    return e;
  };
  const cases: [string, unknown[], RegExp][] = [
    ["events negative", [mut((e) => (e.basedOn.events = -1))], /basedOn\.events/],
    ["events fractional", [mut((e) => (e.basedOn.events = 1.5))], /basedOn\.events/],
    ["events a string", [mut((e) => (e.basedOn.events = "0"))], /basedOn\.events/],
    ["basedOn missing", [mut((e) => delete e.basedOn)], /basedOn/],
    ["basedOn launchAt not a time", [mut((e) => (e.basedOn.launchAt = "yesterday"))], /basedOn\.launchAt/],
    ["basedOn dispatch unknown value", [mut((e) => (e.basedOn.dispatch = "maybe"))], /basedOn\.dispatch/],
    ["basedOn outcome not unresolved", [mut((e) => (e.basedOn.outcome = "not-launched"))], /basedOn\.outcome/],
    ["basedOn unknown field", [mut((e) => (e.basedOn.extra = 1))], /basedOn/],
    ["evidence missing on no-run", [mut((e) => delete e.evidence)], /evidence/],
    ["window reversed", [mut((e) => (e.evidence.window = { from: T("02:00:00"), to: T("01:00:00") }))], /window/],
    ["window not a time", [mut((e) => (e.evidence.window.to = "later"))], /evidence/],
    ["evidence with a session id on no-run", [mut((e) => (e.evidence.sessionId = "cse_found12"))], /evidence/],
    ["abandon with evidence", [mut((e) => (e.kind = "abandon-tracking"))], /evidence/],
    ["unknown kind", [mut((e) => (e.kind = "cancelled"))], /kind/],
    ["digest not hex", [mut((e) => (e.digest = "zz"))], /digest/],
    ["reason too short", [mut((e) => (e.reason = "x"))], /reason/],
    ["at not a time", [mut((e) => (e.at = "now"))], /at/],
    ["job id invalid", [mut((e) => (e.job = "../etc"))], /job/],
    ["unknown top-level field", [mut((e) => (e.note = "x"))], /unknown field/],
    ["truncated entry", [{ seq: 1, job: ID, actor: "owner" }], /entry 1/],
    ["not an object", ["garbage"], /entry 1/],
    ["seq out of order", [oldOwnerEntry(2, ABANDON), oldOwnerEntry(1, COVERING)], /seq/],
    ["duplicate seq", [oldOwnerEntry(1, ABANDON), oldOwnerEntry(1, COVERING)], /seq/],
    ["late entry for no earlier owner entry", [{ seq: 1, job: ID, at: T("05:06:00.000"), actor: "orbit", kind: "late-runner-evidence", after: 7, events: 1, firstLateAt: T("05:06:00.000"), firstLateType: "started", contradicts: true }], /after/],
    ["late entry with no events", [good, { seq: 2, job: ID, at: T("05:06:00.000"), actor: "orbit", kind: "late-runner-evidence", after: 1, events: 0, firstLateAt: T("05:06:00.000"), firstLateType: "started", contradicts: true }], /events/],
  ];
  for (const [name, entries, re] of cases) {
    writeLog(dir, entries);
    const recon = s.open();
    try {
      recon.view(s.job());
      assert.fail(`${name}: expected a refusal`);
    } catch (e) {
      assert.ok(e instanceof ReconcileError, `${name}: ${e}`);
      assert.equal(e.code, 503, name);
      assert.match(e.message, re, name);
      assert.ok(e.message.length <= 700, `${name}: bounded (${e.message.length})`);
      assert.doesNotMatch(e.message, /Routine orbit run history/, `${name}: stored reason text is not echoed`);
    }
  }
  // Many problems are summarized, not listed without bound.
  writeLog(dir, Array.from({ length: 50 }, () => "garbage"));
  refuses(() => s.open().view(s.job()), 503, /50 problem\(s\)/);
});

test("F2: after a restart a repaired log is read again; valid records from the older build load unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-f2d-"));
  const s = setup({ dir });
  writeLog(dir, ["garbage"]);
  refuses(() => s.open().view(s.job()), 503, /integrity check/);
  // The owner repairs the file by hand (outside ORBIT); the next process reads it.
  const late = { seq: 3, job: ID, at: T("05:07:00.000"), actor: "orbit", kind: "late-runner-evidence", after: 2, events: 1, firstLateAt: T("05:06:00.000"), firstLateType: "started", contradicts: false };
  writeLog(dir, [oldOwnerEntry(1, ABANDON), oldOwnerEntry(2, RUNNING), late]);
  const recon = s.open();
  assert.deepEqual(recon.entries(ID).map((e) => e.seq), [1, 2, 3]);
  assert.equal(recon.status().state, "live");
  // An unreadable or newer file is still refused as before.
  writeFileSync(join(dir, "launch-reconciliations.json"), JSON.stringify({ v: 99, entries: ["garbage"] }));
  refuses(() => s.open().view(s.job()), 503, /newer than this build/);
});

// ---- F3: the first late event is found by position ---------------------------------------------------------------------------

test("F3: a late event timestamped before the entry (clock skew) is still named as the first late event", () => {
  const s = setup();
  s.record(ABANDON);
  // ORBIT's clock is set back: both events carry times before the entry, and the first is "started".
  s.setClock(T("04:00:00"));
  s.jobs.record(ID, { type: "started" });
  s.jobs.record(ID, { type: "checkin", text: "working" });
  const added = s.recon.observe(s.jobs);
  assert.equal(added.length, 1);
  assert.equal(added[0].firstLateType, "started");
  assert.equal(added[0].events, 2);
  assert.equal(added[0].firstLateExact, true);
  assert.match(s.sent.at(-1)!.text, /first started at/);
});

test("F3: when the event cap dropped the first late events, the notification says first retained, not first", () => {
  const s = setup();
  s.record(ABANDON);
  s.jobs.record(ID, { type: "started" });
  for (let i = 0; i < KEEP_EVENTS + 4; i++) s.jobs.record(ID, { type: "checkin", text: `step ${i}` });
  assert.equal(s.job().events.length, KEEP_EVENTS);
  assert.equal(s.job().eventsDropped, 5);
  const added = s.recon.observe(s.jobs);
  assert.equal(added[0].firstLateExact, false);
  assert.equal(added[0].events, KEEP_EVENTS + 5);
  assert.equal(added[0].firstLateType, "checkin");
  const note = s.sent.at(-1)!.text;
  assert.match(note, /first retained checkin/);
  assert.match(note, /earlier events were dropped/);
  assert.equal(s.recon.view(s.job()).lateEvents, KEEP_EVENTS + 5);
});

// ---- restart, route and late callbacks with the new entries ---------------------------------------------------------------------

test("entries written by this build (with fire times and positional late entries) pass the integrity check after a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-restart-"));
  const s = setup({ dir });
  const first = s.record(COVERING);
  // Idempotent: the same confirmation again records nothing.
  const again = s.recon.confirm(s.job(), COVERING, first.entry.digest);
  assert.equal(again.repeated, true);
  assert.deepEqual(first.entry.basedOn.fire, { fireStartedAt: DELAYED.fireStartedAt, failedAt: DELAYED.failedAt, fireFailure: "transport" });
  const reopened = s.open();
  assert.equal(reopened.status().state, "live");
  assert.equal(reopened.view(s.job()).retry.allowed, true);
  // A late runner callback outranks the entry; ORBIT's own entry is persisted and read back after another restart.
  s.jobs.record(ID, { type: "started", via: "git" });
  const added = reopened.observe(s.jobs);
  assert.equal(added.length, 1);
  assert.equal(added[0].contradicts, true);
  assert.equal(s.sent.at(-1)!.urgent, true);
  const third = s.open();
  assert.deepEqual(third.entries(ID).map((e) => e.actor), ["owner", "orbit"]);
  const v = third.view(s.job());
  assert.equal(v.state, "runner-evidence-after-reconciliation");
  assert.equal(v.retry.allowed, false);
  assert.equal(retryGate(s.jobs, third).ok, false);
});

test("route: owner-only two-step on a delayed dispatch; the early window is refused, a covering one recorded; a corrupt log answers 503", async () => {
  const { rig, OWNER } = await import("./threads-fixture.ts");
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-route2-"));
  const recon = launchReconciliations(reconFile(dir), () => new Date(T("05:10:00")));
  const x = rig({ dir, extra: () => ({ reconciliations: recon }) });
  try {
    x.jobs.register(ID);
    x.jobs.setLaunch(ID, DELAYED);
    const before = JSON.stringify(x.jobs.get(ID));
    const path = `/jobs/${ID}/reconcile`;
    x.caller.who = "someone-else";
    assert.equal((await x.api(path, "POST", COVERING)).status, 403);
    x.caller.who = OWNER;
    const early = await x.api(path, "POST", EARLY);
    assert.equal(early.status, 400);
    assert.match(early.data.error, /must cover the dispatch/);
    const preview = await x.api(path, "POST", COVERING);
    assert.equal(preview.status, 200);
    assert.equal(recon.entries(ID).length, 0, "a preview records nothing");
    const done = await x.api(path, "POST", { ...COVERING, confirm: preview.data.preview.digest });
    assert.equal(done.status, 201);
    assert.equal(done.data.reconciliation.state, "provider-confirmed-no-run");
    assert.equal(JSON.stringify(x.jobs.get(ID)), before, "the job record is unchanged");

    // The log is corrupted outside ORBIT: the route and the job reading fail closed, and the file is left as it is.
    const file = join(dir, "launch-reconciliations.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    delete stored.entries[0].basedOn.events;
    writeFileSync(file, JSON.stringify(stored));
    const corrupt = readFileSync(file, "utf8");
    const reopened = launchReconciliations(reconFile(dir), () => new Date(T("05:10:00")));
    const y = rig({ dir, extra: () => ({ reconciliations: reopened }) });
    try {
      y.jobs.register(ID);
      y.jobs.setLaunch(ID, DELAYED);
      y.caller.who = OWNER;
      const got = await y.api(path);
      assert.equal(got.status, 503);
      assert.match(got.data.error, /integrity check/);
      assert.equal((await y.api(path, "POST", ABANDON)).status, 503);
      const job = await y.api(`/jobs/${ID}`);
      assert.equal(job.data.reconciliation.state, "unavailable");
      assert.equal(readFileSync(file, "utf8"), corrupt, "left as it is");
    } finally {
      y.close();
    }
  } finally {
    x.close();
  }
});

test("ORBIT refuses to write an entry its own loader would refuse, so a bad launch record cannot lock the log", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recon-guard-"));
  const s = setup({ dir, launch: { ...DELAYED, at: "18 Nov 2026 01:00" } });
  const p = s.recon.preview(s.job(), ABANDON);
  refuses(() => s.recon.confirm(s.job(), ABANDON, p.digest), 409, /integrity check.*basedOn\.launchAt/);
  assert.equal(s.recon.entries(ID).length, 0);
  assert.equal(s.open().status().state, "live");
});
