import type { Job } from "./jobs.ts";

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
export function detailJob(job: Job, health: Health) {
  const events = job.events.slice(-DETAIL_EVENTS);
  const omitted = job.events.length - events.length;
  return { ...job, health, events, eventsOmitted: omitted, eventsNote: omitted ? `${omitted} earlier events left out; ${events.length} of ${job.events.length} shown.` : undefined };
}

// One row for the jobs page: no events or steers, and the latest check-in line with how it arrived.
export function jobRow(job: Job, health: Health) {
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
    pendingSteers: job.steers.filter((s) => !s.deliveredAt).length,
  };
}
