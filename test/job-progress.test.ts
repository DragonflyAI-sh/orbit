import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { jobDetail, listRows, parseRowQuery } from "../src/job-detail.ts";
import { alertDelivery, alertRecordView, jobProgress } from "../src/job-progress.ts";
import { compactList, detailJob, jobRow } from "../src/job-view.ts";
import { jobs as jobRegistry, NOT_STARTED_AFTER_MS } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { launchTracker } from "../src/launch-evidence.ts";
import { notifier } from "../src/notify.ts";
import type { Notification, Notifier } from "../src/notify.ts";
import { researchStore } from "../src/research.ts";
import type { ResearchLane } from "../src/research.ts";
import { researchTools } from "../src/research-tools.ts";
import { jsonStore } from "../src/store.ts";
import { MAX_ALERT_ATTEMPTS, watcher } from "../src/watch.ts";
import type { WatchState } from "../src/watch.ts";

// Honest status semantics for the research bootstrap (and every job): provider accepted, tool served, first authenticated callback,
// report received and validation are told apart; before the first callback a job is "awaiting first check-in" (execution unverified),
// never "ok"; the server notices a missing first callback on its own, alerts once with the session link and the last verified stage,
// records the alert on the job, deduplicates it across ticks and restarts, records a failure to queue it, and supersedes it when the
// runner checks in late. Every view (jobs_list, job_status, research_result, Jobs page rows and detail) reads the same thing.
// Everything here is synthetic: fake clocks, in-memory or temporary stores, no network, no real notification sink, no real secret.

const MIN = 60_000;
const T0 = new Date("2026-11-19T03:45:00.000Z");
const SECRET = Buffer.alloc(32, 9);
const SHA = "f".repeat(64);
const SESSION = "https://claude.ai/code/session_research_1";

function rig(opts: { dir?: string; notify?: Notifier } = {}) {
  let clock = new Date(T0);
  const now = () => clock;
  const notify = opts.notify ?? notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, now);
  const jobs = jobRegistry(jsonStore<Job[]>(opts.dir, "jobs", []), SECRET, notify, now);
  const research = (id: string) => {
    jobs.register(id, undefined, { research: { brief: "Research question: does it work?\n\nCheck one page." } });
    jobs.setLaunch(id, { routine: "research", at: clock.toISOString(), fireStartedAt: clock.toISOString(), firedAt: clock.toISOString(), sessionId: "session_research_1", sessionUrl: SESSION, toolCommitSent: "a".repeat(40) });
  };
  const lane: ResearchLane = { state: "configured", names: ["research"], routines: new Map() };
  const tools = researchTools({ jobs, proposals: newProposals(), lane: () => lane, build: () => ({ routines: ["orbit"] }), routineRepos: new Map(), store: researchStore(undefined), now });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { jobs, notify, now, research, tool, advance: (ms: number) => void (clock = new Date(clock.getTime() + ms)) };
}
type Rig = ReturnType<typeof rig>;
const alertsFor = (r: Rig, id: string) => r.notify.recent().filter((n) => n.text.includes(`Job ${id} `)).reverse();

// Every view of one job, read at the same moment.
async function views(r: Rig, id: string) {
  const job = r.jobs.get(id)!;
  const health = r.jobs.health(job);
  const list = compactList(r.jobs.all(), (j) => r.jobs.health(j)).jobs.find((j) => j.id === id)!;
  const status = detailJob(job, health);
  const row = jobRow(job, health);
  const pageRow = listRows(r.jobs.all(), (j) => r.jobs.health(j), undefined, parseRowQuery(new URLSearchParams())).jobs.find((j) => j.id === id)!;
  const detail = jobDetail(job, health, { all: r.jobs.all() });
  const result = job.kind === "research" ? ((await r.tool("research_result").run({ id })).value as { health: string; progress: { phase: string; executionVerified: boolean; lastVerified: { key: string } } }) : undefined;
  return { job, health, list, status, row, pageRow, detail, result };
}

// The views agree on health, phase, whether execution is verified, and the last verified milestone.
async function assertConsistent(r: Rig, id: string, expected: { health: string; phase: string; verified: boolean; last: string }) {
  const v = await views(r, id);
  assert.equal(v.health, expected.health, `${id}: registry health`);
  for (const [name, h] of [["jobs_list", v.list.health], ["job_status", v.status.health], ["row", v.row.health], ["page row", v.pageRow.health], ["detail", v.detail.overview.health], ["research_result", v.result?.health ?? expected.health]] as const) assert.equal(h, expected.health, `${id}: ${name} health`);
  const phases = [v.status.progress.phase, v.row.progress.phase, v.pageRow.progress.phase, v.detail.overview.progress.phase, ...(v.result ? [v.result.progress.phase] : [])];
  assert.deepEqual(new Set(phases), new Set([expected.phase]), `${id}: one phase everywhere`);
  const verified = [v.status.progress.executionVerified, v.row.progress.executionVerified, v.detail.overview.progress.executionVerified, ...(v.result ? [v.result.progress.executionVerified] : [])];
  assert.deepEqual(new Set(verified), new Set([expected.verified]), `${id}: executionVerified everywhere`);
  const last = [v.status.progress.lastVerified.key, v.row.progress.lastVerified, v.detail.overview.progress.lastVerified.key, ...(v.result ? [v.result.progress.lastVerified.key] : []), ...(v.job.events.length ? [] : [(v.list as { lastVerified?: string }).lastVerified])];
  assert.deepEqual(new Set(last), new Set([expected.last]), `${id}: last verified milestone everywhere`);
  return v;
}

test("accepted by the provider, no callback: awaiting first check-in (execution unverified), never ok, in every view", async () => {
  const r = rig();
  r.research("research-acc");
  r.advance(2 * MIN);
  const v = await assertConsistent(r, "research-acc", { health: "awaiting-first-checkin", phase: "awaiting-first-checkin", verified: false, last: "provider-accepted" });
  assert.match(v.status.progress.summary, /^Awaiting the runner's first check-in: execution unverified; first check-in due by 2026-11-19T03:55:00\.000Z/);
  assert.equal(v.status.progress.firstCallbackDueAt, new Date(T0.getTime() + NOT_STARTED_AFTER_MS).toISOString());
  // Dispatch time and runner activity are separate facts.
  assert.equal(v.detail.overview.progress.dispatchedAt, T0.toISOString());
  assert.equal(v.detail.overview.progress.lastRunnerActivityAt, null);
  assert.equal(v.detail.overview.runnerActivityAt, null);
  assert.equal(v.pageRow.activityBasis, "provider", "the legacy activityAt falls back to the provider's answer, and says so");
  assert.equal(v.pageRow.runnerActivityAt, null);
  const started = v.detail.inputs.stages.find((s) => s.key === "started")!;
  assert.equal(started.status, "pending");
  assert.match(started.evidence, /No runner check-in yet: execution unverified/);
});

test("tool served, no callback: the last verified stage is the tool download, which is never read as execution", async () => {
  const r = rig();
  r.research("research-tool");
  r.advance(MIN);
  r.jobs.toolServed("research-tool", SHA);
  const v = await assertConsistent(r, "research-tool", { health: "awaiting-first-checkin", phase: "awaiting-first-checkin", verified: false, last: "tool-served" });
  assert.match(v.status.progress.summary, /Last verified: runner tool sent by the job api at .*not that the runner received it intact or ran it/);
  const keys = v.detail.inputs.stages.map((s) => s.key);
  assert.ok(keys.indexOf("tool") < keys.indexOf("received"), "the tool download is listed before the brief fetch, the order they happen in");
  assert.match(v.detail.inputs.stages.find((s) => s.key === "started")!.evidence, /a tool download does not prove the tool ran/);
  assert.ok(v.detail.timeline.keyTimes.some((t) => /Runner tool sent by the job API \(not proof that it ran\)/.test(t.what)));
  // The brief request that `orbit-research start` makes is its own milestone, and still not a check-in.
  r.jobs.briefServed("research-tool", SHA);
  await assertConsistent(r, "research-tool", { health: "awaiting-first-checkin", phase: "awaiting-first-checkin", verified: false, last: "brief-served" });
});

test("overdue first callback: one alert with the session link and the last verified stage, recorded on the job, deduplicated across ticks and restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-progress-"));
  const r = rig({ dir });
  r.research("research-late");
  r.advance(MIN);
  r.jobs.toolServed("research-late", SHA);
  const store = jsonStore<WatchState>(dir, "watch", { ports: {} });
  const watch = watcher(store, r.notify, r.now, r.jobs, { inFlight: launchTracker() });
  r.advance(NOT_STARTED_AFTER_MS - 2 * MIN);
  watch.tick();
  assert.equal(alertsFor(r, "research-late").length, 0, "nothing before the deadline");
  r.advance(2 * MIN);
  watch.tick();
  watch.tick();
  const alerts = alertsFor(r, "research-late");
  assert.equal(alerts.length, 1);
  const text = alerts[0]!.text;
  assert.match(text, /^Job research-late is not started \(no runner event 10 minutes after launch: not checked in, which is not proof that it failed or never launched, and not a cause\)/);
  assert.ok(text.includes(`Session: ${SESSION}.`));
  assert.match(text, /Last verified stage: Runner tool sent by the job API at .*not that the runner received it intact or ran it/);
  assert.match(text, /Dispatch: provider-accepted/);
  assert.match(text, /Nothing was retried or relaunched/);
  assert.doesNotMatch(text, /failed because|caused by|refus/i, "no invented cause");
  const rec = r.jobs.get("research-late")!.callbackAlert!;
  assert.deepEqual([rec.count, rec.dispatch, rec.stage, rec.notificationId], [1, "provider-accepted", "tool-served", alerts[0]!.id]);
  const v = await assertConsistent(r, "research-late", { health: "not-started", phase: "first-checkin-overdue", verified: false, last: "tool-served" });
  assert.match(v.status.progress.summary, /^First check-in overdue \(due by .*\): the runner has not checked in, which is not proof that it failed or never launched, and says nothing about why/);
  assert.equal(v.status.firstCallbackAlert?.state, "queued");
  assert.match(v.status.firstCallbackAlert?.note ?? "", /no receipt proves Rai read it/);
  // A page refresh is a read: it never alerts. A restart with the same stores does not repeat it.
  await views(r, "research-late");
  watcher(jsonStore<WatchState>(dir, "watch", { ports: {} }), r.notify, r.now, jobRegistry(jsonStore<Job[]>(dir, "jobs", []), SECRET, r.notify, r.now), { inFlight: launchTracker() }).tick();
  // Even a restart that lost the watch's own store does not repeat it: the job record deduplicates.
  const lost = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), r.notify, r.now, r.jobs, { inFlight: launchTracker() });
  for (let i = 0; i < 5; i++) (r.advance(MIN), lost.tick());
  assert.equal(alertsFor(r, "research-late").length, 1, "one alert, whatever restarts and refreshes happen");
});

test("notification errors: a failure to queue the alert is recorded, retried at most a bounded number of times, and never claimed as sent", async () => {
  const real = notifier(jsonStore<Notification[]>(undefined, "n", []));
  let failing = true;
  let attempts = 0;
  const flaky: Notifier = { ...real, send: (text: string, urgent?: boolean) => { if (/is not started/.test(text)) attempts++; if (failing) throw new Error("disk full"); return real.send(text, urgent); } };
  const r = rig({ notify: flaky });
  r.research("research-noq");
  const watch = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), flaky, r.now, r.jobs, { inFlight: launchTracker() });
  r.advance(NOT_STARTED_AFTER_MS + MIN);
  watch.tick();
  let rec = r.jobs.get("research-noq")!.callbackAlert!;
  assert.deepEqual([rec.queueError, rec.attempts, rec.notificationId, rec.gaveUp], ["disk full", 1, undefined, undefined]);
  assert.equal(alertRecordView(rec)?.state, "not queued yet");
  assert.deepEqual(alertDelivery(rec, undefined, true, r.now())?.queued, { error: "disk full", attempts: 1, gaveUp: false });
  for (let i = 0; i < 10; i++) watch.tick();
  rec = r.jobs.get("research-noq")!.callbackAlert!;
  assert.equal(attempts, MAX_ALERT_ATTEMPTS, "bounded: no retry storm");
  assert.equal(rec.gaveUp, true);
  assert.equal(alertRecordView(rec)?.state, "not queued (gave up)");
  failing = false;
  watch.tick();
  assert.equal(real.recent().length, 0, "a given-up alert is not resent on later ticks");

  // A queued alert whose push failed, was held, or was shown: queued, displayed and pushed are told apart, and none is called read.
  const r2 = rig();
  r2.research("research-q");
  const w2 = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), r2.notify, r2.now, r2.jobs, { inFlight: launchTracker() });
  r2.advance(NOT_STARTED_AFTER_MS + MIN);
  w2.tick();
  const a = r2.jobs.get("research-q")!.callbackAlert!;
  const n = r2.notify.get(a.notificationId!)!;
  assert.match(alertDelivery(a, n, false, r2.now())!.discord, /^not connected/);
  assert.equal(alertDelivery(a, n, true, r2.now())!.receipt, "none");
  assert.match(alertDelivery(a, { ...n, holdUntil: new Date(r2.now().getTime() + 3600_000).toISOString() }, true, r2.now())!.discord, /^held for quiet hours until /);
  assert.match(alertDelivery(a, { ...n, discord: { at: r2.now().toISOString(), ok: false, detail: "Discord send failed: HTTP 500" } }, true, r2.now())!.discord, /^Discord send failed at .*HTTP 500/);
  const ok = alertDelivery(a, { ...n, discord: { at: r2.now().toISOString(), ok: true, messageId: "m1", detail: "Discord accepted the message" }, shown: { at: r2.now().toISOString(), detail: "x", listed: true } }, true, r2.now())!;
  assert.equal(ok.receipt, "displayed-and-pushed");
  assert.match(ok.note, /not proof that Rai read it/);
  assert.match(alertDelivery(a, undefined, true, r2.now())!.web, /no longer in ORBIT's recent notifications/);
});

test("late start and recovery: a callback after the alert supersedes it, one note says so, and no view keeps a stale warning", async () => {
  const r = rig();
  r.research("research-rec");
  const watch = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), r.notify, r.now, r.jobs, { inFlight: launchTracker() });
  r.advance(NOT_STARTED_AFTER_MS + MIN);
  watch.tick();
  r.advance(4 * MIN);
  r.jobs.record("research-rec", { type: "started", toolCommit: "a".repeat(40) });
  watch.tick();
  watch.tick();
  const texts = alertsFor(r, "research-rec").map((n) => n.text);
  assert.equal(texts.length, 2);
  assert.match(texts[1]!, /^Job research-rec checked in at .* \(15 min after launch\), after ORBIT's not-started alert: that alert no longer applies\. Runner-reported/);
  const rec = r.jobs.get("research-rec")!.callbackAlert!;
  assert.equal(rec.resolution, "runner-callback");
  const v = await assertConsistent(r, "research-rec", { health: "ok", phase: "running", verified: true, last: "first-callback" });
  assert.equal(v.status.progress.firstCallbackDueAt, undefined, "no deadline once the runner has checked in");
  assert.match(v.status.firstCallbackAlert?.state ?? "", /^superseded \(the runner checked in at /);
  assert.ok(v.detail.timeline.keyTimes.some((t) => t.what === "Not-started alert superseded: the runner checked in"));
  assert.equal(v.detail.overview.runnerActivityAt, v.job.lastEventAt);
  // A callback before any alert sends nothing extra.
  r.research("research-ontime");
  r.advance(3 * MIN);
  r.jobs.record("research-ontime", { type: "started" });
  watch.tick();
  assert.equal(alertsFor(r, "research-ontime").length, 0);
});

test("completion without stale warnings: a job that finishes after an alert is superseded as finished, with no extra note", async () => {
  const r = rig();
  r.research("research-fin");
  const watch = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), r.notify, r.now, r.jobs, { inFlight: launchTracker() });
  r.advance(NOT_STARTED_AFTER_MS + MIN);
  watch.tick();
  r.jobs.record("research-fin", { type: "bootstrap", bootstrap: { category: "auth-denied", attempts: 1, curlExit: 0, http: 401 }, text: "bootstrap failure (auth-denied)" });
  watch.tick();
  assert.equal(r.jobs.get("research-fin")!.callbackAlert?.resolution, "finished");
  assert.equal(alertsFor(r, "research-fin").filter((n) => /checked in at/.test(n.text)).length, 0);
  await assertConsistent(r, "research-fin", { health: "finished", phase: "finished", verified: true, last: "first-callback" });
});

test("report states: received and ORBIT's validation are separate milestones; a build job's summary has no validation", async () => {
  const r = rig();
  r.research("research-ok");
  r.jobs.toolServed("research-ok", SHA);
  r.jobs.briefServed("research-ok", SHA);
  r.jobs.record("research-ok", { type: "started" });
  r.advance(5 * MIN);
  r.jobs.record("research-ok", { type: "summary", status: "done", text: "Report text." });
  const job = r.jobs.get("research-ok")!;
  r.jobs.setResearch("research-ok", { ...job.research!, report: { status: "done", valid: true, problems: [], chars: 12, storedAt: r.now().toISOString(), sources: 1 } });
  const v = await assertConsistent(r, "research-ok", { health: "finished", phase: "finished", verified: true, last: "validated" });
  assert.deepEqual(v.status.progress.milestones.map(([k]) => k), ["registered", "dispatched", "provider-accepted", "tool-served", "brief-served", "first-callback", "report-received", "validated"]);
  assert.equal(v.detail.overview.progress.report?.validation, "passed");
  assert.equal(v.detail.inputs.stages.find((s) => s.key === "validated")?.status, "done");

  r.research("research-bad");
  r.jobs.record("research-bad", { type: "started" });
  r.jobs.record("research-bad", { type: "summary", status: "done", text: "No sources." });
  r.jobs.setResearch("research-bad", { ...r.jobs.get("research-bad")!.research!, report: { status: "done", valid: false, problems: ["no sources"], chars: 11 } });
  const bad = await assertConsistent(r, "research-bad", { health: "finished", phase: "finished", verified: true, last: "validated" });
  assert.equal(bad.detail.overview.progress.report?.validation, "failed");
  assert.match(bad.detail.inputs.stages.find((s) => s.key === "validated")!.evidence, /Did not pass ORBIT's checks: no sources/);

  // A build job: summary received, validation not applicable.
  r.jobs.register("orbit-build");
  r.jobs.setLaunch("orbit-build", { routine: "orbit", at: r.now().toISOString(), briefCommit: "b1", fireStartedAt: r.now().toISOString(), sessionId: "cse_b", sessionUrl: "https://claude.ai/code/cse_b" });
  r.jobs.record("orbit-build", { type: "started" });
  r.jobs.record("orbit-build", { type: "summary", status: "done", text: "## PR title\nA change\n\n## PR body\nWhat and why." });
  const build = await assertConsistent(r, "orbit-build", { health: "finished", phase: "finished", verified: true, last: "report-received" });
  assert.equal(build.status.progress.report?.validation, "n/a");
});

test("legacy records: a job with no launch record awaits its first check-in with no deadline and never alerts; older launches still read", async () => {
  const r = rig();
  r.jobs.register("bare");
  const watch = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), r.notify, r.now, r.jobs, { inFlight: launchTracker() });
  r.advance(3 * 3600_000);
  watch.tick();
  const p = jobProgress(r.jobs.get("bare")!, r.jobs.health(r.jobs.get("bare")!));
  assert.deepEqual([p.phase, p.lastVerified.key, p.firstCallbackDueAt], ["awaiting-first-checkin", "registered", undefined]);
  assert.match(p.summary, /no launch record, so no deadline/);
  assert.equal(r.notify.recent().length, 0);
  // An older launch without fire-start time: its launch time stands for dispatch only because the provider answered.
  r.jobs.register("old");
  r.jobs.setLaunch("old", { routine: "orbit", at: "2026-11-01T08:00:00.000Z", sessionId: "cse_old" });
  const old = jobProgress(r.jobs.get("old")!, "not-started");
  assert.equal(old.dispatchedAt, "2026-11-01T08:00:00.000Z");
  assert.match(old.milestones.find((m) => m.key === "dispatched")!.detail!, /older record/);
  // A legacy health filter link (?health=ok) still parses; it simply no longer matches a job that has not checked in.
  assert.equal(listRows(r.jobs.all(), (j) => r.jobs.health(j), undefined, parseRowQuery(new URLSearchParams("health=ok"))).matched, 0);
});

test("a malformed record without times still has a reading (registered), and never throws", () => {
  const job: Job = { id: "x", createdAt: "", expiresAt: "", state: "running", events: [], steers: [] };
  const p = jobProgress(job, "awaiting-first-checkin");
  assert.deepEqual([p.phase, p.lastVerified.key, p.executionVerified], ["awaiting-first-checkin", "registered", false]);
});
