import type { Job } from "./jobs.ts";

// How a job's reported tool commit compares with the commit ORBIT is running (the ORBIT_COMMIT /status reports).
// "unknown" covers a job that never reported one and an ORBIT that does not know its own commit: neither is a mismatch.
export type ToolCommitStatus = "match" | "mismatch" | "unknown";
export function toolCommitStatus(reported: string | undefined, running: string | undefined): ToolCommitStatus {
  if (!reported || !running || !/^[0-9a-f]{7,64}$/i.test(running)) return "unknown";
  const a = reported.toLowerCase(), b = running.toLowerCase();
  return a.startsWith(b) || b.startsWith(a) ? "match" : "mismatch";
}
const toolCommitFields = (job: Job, running: string | undefined) => ({ toolCommit: job.toolCommit ?? "unknown", toolCommitStatus: toolCommitStatus(job.toolCommit, running) });

// Shapes of a job for the model. The tool loop clips each result at 8000 characters, so a list of full records
// silently loses jobs; the list is one short row per job and carries the true total.

export const DETAIL_EVENTS = 20;
type Health = string;

export function compactJob(job: Job, health: Health) {
  const last = job.events.at(-1);
  return {
    id: job.id,
    state: job.state,
    health,
    routine: job.launch?.routine,
    launchedAt: job.launch?.at,
    lastEvent: last ? { at: last.at, type: last.type, status: last.status ?? null } : null,
    sessionUrl: job.launch?.sessionUrl,
  };
}

// `all` is oldest first, as the registry stores it; the answer is newest first.
export function compactList(all: Job[], health: (j: Job) => Health) {
  const newest = [...all].sort((a, b) => (b.launch?.at ?? b.createdAt).localeCompare(a.launch?.at ?? a.createdAt));
  return { total: all.length, jobs: newest.map((j) => compactJob(j, health(j))) };
}

// Full record, but only the last DETAIL_EVENTS events, with a count of the ones left out.
export function detailJob(job: Job, health: Health, running?: string) {
  const events = job.events.slice(-DETAIL_EVENTS);
  const omitted = job.events.length - events.length;
  const { briefWords: _words, ...launch } = job.launch ?? ({} as NonNullable<Job["launch"]>);
  return { ...job, ...(job.launch ? { launch } : {}), ...toolCommitFields(job, running), health, events, eventsOmitted: omitted, eventsNote: omitted ? `${omitted} earlier events left out; ${events.length} of ${job.events.length} shown.` : undefined };
}

// One row for the jobs page: no events or steers, and the latest check-in line with how it arrived.
export function jobRow(job: Job, health: Health, running?: string) {
  const last = [...job.events].reverse().find((e) => e.text) ?? job.events.at(-1);
  return {
    id: job.id,
    state: job.state,
    health,
    routine: job.launch?.routine,
    launchedAt: job.launch?.at,
    launchError: job.launch?.error,
    sessionUrl: job.launch?.sessionUrl,
    latest: last ? { at: last.at, type: last.type, status: last.status, text: last.text?.slice(0, 300), via: last.via ?? "api" } : null,
    lastEventAt: job.lastEventAt,
    prUrl: job.pr?.url,
    prError: job.pr?.error,
    prOpening: Boolean(job.pr && !job.pr.url && !job.pr.error),
    ...toolCommitFields(job, running),
    kind: job.kind ?? "work",
    reviewOf: job.review?.of,
    reviewVerdict: job.review?.verdict ?? job.reviewJob?.verdict,
    reviewCommentUrl: job.review?.comment?.url ?? job.reviewJob?.commentUrl,
    reviewError: job.review?.comment?.error ?? job.reviewJob?.error,
    reviewJobId: job.reviewJob?.id,
    reviewPending: Boolean(job.reviewJob && !job.reviewJob.verdict && !job.reviewJob.error),
    pendingSteers: job.steers.filter((s) => !s.deliveredAt).length,
  };
}
