import type { CallbackAlert, Job } from "./jobs.ts";
import { NOT_STARTED_AFTER_MS } from "./jobs.ts";
import type { Notification } from "./notify.ts";

// One reading of how far a job got, from ORBIT's own record, shared by every view: jobs_list and job_status (src/job-view.ts), the
// research tools (src/research-tools.ts), the Jobs page rows and detail (src/job-detail.ts) and the first-callback alert (src/watch.ts).
// It reads only the stored job and the health computed from it (src/jobs.ts), so every view says the same thing at the same moment.
//
// The milestones are kept apart on purpose, because each proves something different:
//   dispatched          ORBIT fired the Routine (fireStartedAt; on older records the launch time). Dispatch time, not runner activity.
//   provider-accepted   the provider answered the fire with a session. A session was accepted; nothing more.
//   tool-served         (research) the job API answered the runner tool download. ORBIT sent it; it does not prove it arrived intact or ran.
//   brief-served        (research) the job API answered the brief request that `orbit-research start` makes. A request carrying the job's
//                       token reached ORBIT for the brief; still not a check-in.
//   first-callback      the first runner event (POST /v1/jobs/<id>/events, or the runner's start found in git): the first evidence that
//                       the runner executed its tool. Runner-reported, like every runner event.
//   report-received     the final summary (research: report) reached ORBIT.
//   validated           (research) ORBIT's shape and bounds check of the report passed or failed. Not a check of its claims.
// Before the first callback a job is "awaiting first check-in": execution is unverified, never "healthy". After the documented deadline
// it is "first check-in overdue": not checked in, which is not proof that it failed, never launched, or why.

export type ProgressPhase = "awaiting-first-checkin" | "first-checkin-overdue" | "launch-failed" | "running" | "quiet" | "finished";
export type MilestoneKey = "registered" | "dispatched" | "provider-accepted" | "tool-served" | "brief-served" | "first-callback" | "report-received" | "validated";
export type Milestone = { key: MilestoneKey; label: string; at?: string; detail?: string };
export type JobProgress = {
  phase: ProgressPhase;
  // One sentence for people and the model: what is verified, and what is not.
  summary: string;
  // True only once the runner reported (its first callback). A dispatch, a provider session or a tool download never sets it.
  executionVerified: boolean;
  lastVerified: Milestone;
  milestones: Milestone[];
  // When ORBIT fired the Routine (dispatch), and when the runner last did anything (a runner event). Never one standing in for the other.
  dispatchedAt: string | null;
  lastRunnerActivityAt: string | null;
  // For a launched job with no runner event: when the first callback is due (launch + NOT_STARTED_AFTER_MS), and whether that has passed.
  firstCallbackDueAt?: string;
  report?: { receivedAt: string; validation: "passed" | "failed" | "not-checked" | "n/a" };
};

const LABELS: Record<MilestoneKey, string> = {
  registered: "Registered by ORBIT",
  dispatched: "Routine fired by ORBIT (dispatch)",
  "provider-accepted": "Accepted by the provider (session created)",
  "tool-served": "Runner tool sent by the job API",
  "brief-served": "Brief served by the job API",
  "first-callback": "First runner check-in",
  "report-received": "Report received",
  validated: "Report checked by ORBIT",
};
const m = (key: MilestoneKey, at: string | undefined, detail?: string): Milestone => ({ key, label: LABELS[key], ...(at ? { at } : {}), ...(detail ? { detail } : {}) });

// The time ORBIT fired the Routine. Older records have no fire-start time; their launch time is used only when the provider answered.
export function dispatchedAt(job: Job): string | undefined {
  const l = job.launch;
  if (!l) return undefined;
  if (l.fireStartedAt) return l.fireStartedAt;
  return l.firedAt || l.sessionId ? l.at : undefined;
}

export function firstCallbackDueAt(job: Job): string | undefined {
  return job.launch ? new Date(new Date(job.launch.at).getTime() + NOT_STARTED_AFTER_MS).toISOString() : undefined;
}

// The milestones the record proves, in the order they happen. A milestone is listed only with evidence; none is inferred from a later one.
export function milestones(job: Job): Milestone[] {
  const out: Milestone[] = [m("registered", job.createdAt)];
  const l = job.launch;
  const d = dispatchedAt(job);
  if (d) out.push(m("dispatched", d, l?.fireStartedAt ? undefined : "older record: launch time, no fire-start time was kept"));
  if (l?.sessionId) out.push(m("provider-accepted", l.firedAt, `session ${l.sessionId}${l.firedAt ? "" : " (answer time not recorded)"}`));
  const t = job.kind === "research" ? job.research?.toolServed : undefined;
  if (t) out.push(m("tool-served", t.firstAt, `sent ${t.count} time(s); proves ORBIT answered the download, not that the runner received it intact or ran it`));
  const b = job.kind === "research" ? job.research?.briefServed : undefined;
  if (b) out.push(m("brief-served", b.firstAt, `served ${b.count} time(s); the runner tool asks for it at start, before it checks in`));
  const first = job.events[0];
  if (first) {
    const boot = first.type === "bootstrap";
    const dropped = job.eventsDropped === undefined ? (job.events.length >= 200 ? " (older events may have been dropped; first retained event)" : "") : job.eventsDropped > 0 ? " (first retained event; older ones were dropped)" : "";
    out.push(m("first-callback", first.at, `${boot ? "a bootstrap failure report (the runner says it stopped before its tool ran)" : `${first.type} via ${first.via === "git" ? "git" : "the API"}`}; runner-reported${dropped}`));
  }
  const report = reportOf(job);
  if (report) {
    out.push(m("report-received", report.receivedAt, job.kind === "research" ? "research report" : `final summary (${[...job.events].reverse().find((e) => e.type === "summary")?.status ?? "status not recorded"})`));
    if (report.validation === "passed" || report.validation === "failed") out.push(m("validated", job.research?.report?.storedAt ?? report.receivedAt, report.validation === "passed" ? "passed ORBIT's shape and bounds checks (not a check of its claims)" : "did not pass ORBIT's checks"));
  }
  // `registered` is always kept (even on a malformed record without a creation time), so there is always a last verified milestone.
  return out.filter((x) => x.at || x.key === "registered" || x.key === "provider-accepted");
}

function reportOf(job: Job): JobProgress["report"] {
  if (job.kind === "research") {
    const r = job.research?.report;
    const at = r?.storedAt ?? job.summary?.at;
    if (!r && !job.summary) return undefined;
    return { receivedAt: at ?? job.lastEventAt ?? job.createdAt, validation: r ? (r.valid ? "passed" : "failed") : "not-checked" };
  }
  return job.summary ? { receivedAt: job.summary.at, validation: "n/a" } : undefined;
}

// health is the value src/jobs.ts computes for the same job at the same moment (it owns the clock and the deadlines).
export function jobProgress(job: Job, health: string): JobProgress {
  const ms = milestones(job);
  const last = ms[ms.length - 1];
  const executionVerified = job.events.length > 0;
  const finished = job.state === "done" || job.state === "blocked" || job.state === "failed";
  const phase: ProgressPhase =
    health === "launch-failed" ? "launch-failed"
    : finished ? "finished"
    : !executionVerified ? (health === "not-started" ? "first-checkin-overdue" : "awaiting-first-checkin")
    : health === "quiet" ? "quiet"
    : "running";
  const due = !executionVerified && job.launch ? firstCallbackDueAt(job) : undefined;
  const report = reportOf(job);
  const lastLine = `Last verified: ${last.label.toLowerCase()}${last.at ? ` at ${last.at}` : ""}${last.detail ? ` (${last.detail})` : ""}.`;
  const summary =
    phase === "awaiting-first-checkin" ? `Awaiting the runner's first check-in: execution unverified${due ? `; first check-in due by ${due}` : " (no launch record, so no deadline)"}. ${lastLine}`
    : phase === "first-checkin-overdue" ? `First check-in overdue (due by ${due}): the runner has not checked in, which is not proof that it failed or never launched, and says nothing about why. ${lastLine}`
    : phase === "launch-failed" ? `The launch recorded a failure and the runner has not reported. ${lastLine}`
    : phase === "quiet" ? `The runner checked in, then went quiet (no event for 15 minutes). ${lastLine}`
    : phase === "finished" ? `Finished: ${job.state}${executionVerified ? "" : " (no runner check-in was recorded)"}. ${lastLine}`
    : `The runner has checked in (runner-reported). ${lastLine}`;
  return {
    phase,
    summary,
    executionVerified,
    lastVerified: last,
    milestones: ms,
    dispatchedAt: dispatchedAt(job) ?? null,
    lastRunnerActivityAt: job.lastEventAt ?? null,
    ...(due ? { firstCallbackDueAt: due } : {}),
    ...(report ? { report } : {}),
  };
}

// The form for job_status, whose whole answer must fit the 8000-character tool clip: milestones as key and time only (the labels and
// details are in the summary sentence and on the Jobs page).
export function progressForModel(p: JobProgress) {
  const { milestones: ms, lastVerified, ...rest } = p;
  return { ...rest, lastVerified: { key: lastVerified.key, at: lastVerified.at ?? null }, milestones: ms.map((x) => [x.key, x.at ?? null] as const) };
}

// The short form for one-row-per-job lists (jobs_list, the Jobs page rows), which must stay small.
export function progressBrief(p: JobProgress) {
  return { phase: p.phase, executionVerified: p.executionVerified, lastVerified: p.lastVerified.key, lastVerifiedAt: p.lastVerified.at ?? null, dispatchedAt: p.dispatchedAt, lastRunnerActivityAt: p.lastRunnerActivityAt };
}

// ---- the first-callback alert, as recorded on the job and as the notification store shows its delivery ----

// What the job record holds about its first-callback alert, for views that only see the job (job_status). Delivery receipts live on the
// notification; queued is not delivered, and delivered is not read.
export function alertRecordView(a: CallbackAlert | undefined) {
  if (!a) return undefined;
  return {
    state: a.resolvedAt ? `superseded (${a.resolution === "finished" ? "the job finished" : "the runner checked in"} at ${a.resolvedAt})` : a.notificationId ? "queued" : a.gaveUp ? "not queued (gave up)" : "not queued yet",
    firstAt: a.firstAt,
    at: a.at,
    count: a.count,
    dispatch: a.dispatch,
    lastVerified: a.stage,
    ...(a.notificationId ? { notificationId: a.notificationId } : {}),
    ...(a.queueError ? { queueError: a.queueError, attempts: a.attempts } : {}),
    note: "Queued means ORBIT stored the notice in its notifications. Delivery receipts (web page, Discord) are kept on the notification, and no receipt proves Rai read it.",
  };
}

export type AlertDelivery = {
  queued: { at: string; notificationId: string } | { error: string; attempts: number; gaveUp: boolean };
  web: string;
  discord: string;
  receipt: "none" | "displayed" | "pushed" | "displayed-and-pushed";
  note: string;
};

// The live delivery outcome of a recorded alert, from the notification store. `discordConnected` comes from the notifier's own status.
export function alertDelivery(a: CallbackAlert | undefined, n: Notification | undefined, discordConnected: boolean, now: Date): AlertDelivery | undefined {
  if (!a) return undefined;
  if (!a.notificationId) return { queued: { error: a.queueError ?? "not queued", attempts: a.attempts ?? 0, gaveUp: Boolean(a.gaveUp) }, web: "nothing to show: the notice was not stored", discord: "nothing to push: the notice was not stored", receipt: "none", note: "The alert could not be queued; ORBIT's log has the error." };
  const queued = { at: a.at, notificationId: a.notificationId };
  if (!n) return { queued, web: "unknown: the notification is no longer in ORBIT's recent notifications", discord: "unknown: the notification is no longer in ORBIT's recent notifications", receipt: "none", note: "Queued is not delivered." };
  const web = n.shown?.listed ? `listed in the open notifications panel at ${n.shown.at}` : n.shown ? `acknowledged by an older page at ${n.shown.at}` : "not yet shown in the ORBIT web page";
  const held = n.holdUntil && new Date(n.holdUntil) > now;
  const discord = !discordConnected && !n.discord ? "not connected (no Discord webhook credential): not pushed"
    : n.discord?.ok ? `Discord accepted it at ${n.discord.at}${n.discord.messageId ? ` (message ${n.discord.messageId})` : ""}`
    : n.discord ? `Discord send failed at ${n.discord.at}: ${n.discord.detail}`
    : held ? `held for quiet hours until ${n.holdUntil}`
    : "waiting for the next delivery attempt";
  const shown = Boolean(n.shown), pushed = Boolean(n.discord?.ok);
  return { queued, web, discord, receipt: shown && pushed ? "displayed-and-pushed" : shown ? "displayed" : pushed ? "pushed" : "none", note: "A display or Discord receipt is delivery evidence, not proof that Rai read it." };
}
