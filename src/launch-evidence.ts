import type { Job } from "./jobs.ts";

// What ORBIT's own job record can prove about a launch's dispatch (docs/reviews/launch-reconciliation.md).
//
// `health` answers "has the runner said anything?". This answers a different question: "how far did the launch get on ORBIT's side, and
// what does the record NOT know?". It reads only the stored job; it never calls GitHub or the provider, and it never retries, cancels or
// launches anything. Missing runner callbacks are never read as "no cloud session": a session can exist and stop before it reports
// (for example when it refuses the tool commit in the fire text, or fails before `orbit-job start`).
//
//   no-launch-record   the job has no launch record (registered by another path); nothing is known about a dispatch.
//   in-flight          the launch began less than IN_FLIGHT_MS ago and has no result yet: it may still be running in this process.
//   never-dispatched   the record proves the Routine was never fired: the brief write failed, or no brief commit was recorded. A fire is
//                      only ever sent after the brief commit is stored (src/job-launch.ts), so neither can have reached the provider.
//   dispatch-unknown   a fire was (or may have been) sent and no provider answer was recorded: ORBIT stopped mid-fire (restart, deploy,
//                      crash), the connection failed after sending, or the provider answered 5xx. A session may or may not exist.
//   provider-rejected  the provider answered the fire with a 4xx: it refused the request.
//   provider-accepted  the provider answered 2xx (with a session id, or without a usable one) and no runner event has arrived. A session
//                      was accepted; whether it ran, refused or failed before reporting is not in ORBIT's record.
//   runner-reported    the runner reported (over the API, or ORBIT found its start or summary in git).
export type DispatchState = "no-launch-record" | "in-flight" | "never-dispatched" | "dispatch-unknown" | "provider-rejected" | "provider-accepted" | "runner-reported";
export type DispatchEvidence = {
  state: DispatchState;
  basis: string;
  // "new": written by a launcher that records fireStartedAt; "legacy": an older record, read conservatively (never as never-dispatched
  // from a missing field it could not have had).
  record: "new" | "legacy" | "none";
  sessionId?: string;
  fireStartedAt?: string;
  toolCommitSent?: string;
  // A caveat that applies to this state, for the owner reading it.
  caveat?: string;
};

// Longer than any one launch can stay pending in a live process: the GitHub and Routine requests use fetch's default timeouts (minutes, not
// hours), so a launch older than this with no result was cut off by ORBIT stopping, not still running.
export const IN_FLIGHT_MS = 30 * 60_000;
const NO_CALLBACK = "No runner callback is not evidence that no cloud session exists: a session can stop before it reports.";

// Older records carry only the error text. These are the messages src/job-launch.ts and src/launcher.ts have always written.
function legacyFailure(error: string | undefined): "brief" | "rejected" | "server-error" | "no-session" | "unknown" {
  const e = error ?? "";
  if (/^brief not written/.test(e)) return "brief";
  const http = e.match(/fire returned HTTP (\d{3})/);
  if (http) return Number(http[1]) >= 500 ? "server-error" : "rejected";
  if (/fire returned no session/.test(e)) return "no-session";
  return "unknown";
}

export function dispatchEvidence(job: Job, now: Date = new Date()): DispatchEvidence {
  const l = job.launch;
  if (!l) return { state: "no-launch-record", basis: "the job has no launch record, so ORBIT holds no evidence of a dispatch", record: "none", ...(job.events.length ? {} : { caveat: NO_CALLBACK }) };
  const record: DispatchEvidence["record"] = l.fireStartedAt ? "new" : "legacy";
  const facts = { record, ...(l.sessionId ? { sessionId: l.sessionId } : {}), ...(l.fireStartedAt ? { fireStartedAt: l.fireStartedAt } : {}), ...(l.toolCommitSent ? { toolCommitSent: l.toolCommitSent } : {}) };
  const toolCaveat = l.toolCommitSent !== undefined && !/^[0-9a-f]{40}$/.test(l.toolCommitSent) ? ` The fire text carried tool commit "${l.toolCommitSent.slice(0, 64)}", which the Routine prompt refuses (it requires 40 lowercase hex characters on main), so a session would stop before reporting.` : "";

  if (job.events.length) {
    const via = job.events.some((e) => e.via !== "git") ? "the API" : "git";
    return { state: "runner-reported", basis: `the runner reported ${job.events.length} event(s) (first via ${job.events[0].via === "git" ? "git" : "the API"}; seen via ${via})`, ...facts };
  }
  const research = job.kind === "research";
  if (l.failedAt) {
    const kind = l.fireFailure ?? legacyFailure(l.error);
    if (kind === "brief") return { state: "never-dispatched", basis: "the brief write failed, and a fire is only sent after the brief commit is stored", ...facts };
    if (kind === "rejected") return { state: "provider-rejected", basis: "the provider answered the fire with a 4xx", ...facts };
    if (kind === "no-session") return { state: "provider-accepted", basis: "the provider answered the fire 2xx without a usable session id; which session it started is unknown", ...facts, caveat: NO_CALLBACK + toolCaveat };
    if (kind === "server-error") return { state: "dispatch-unknown", basis: "the provider answered the fire with a 5xx: it may or may not have created a session", ...facts, caveat: NO_CALLBACK + toolCaveat };
    return { state: "dispatch-unknown", basis: `the fire failed without a provider answer (${(l.error ?? "no error recorded").slice(0, 160)}): the request may have reached the provider`, ...facts, caveat: NO_CALLBACK + toolCaveat };
  }
  if (l.sessionId) return { state: "provider-accepted", basis: `the provider accepted the fire and returned session ${l.sessionId}${l.firedAt ? ` at ${l.firedAt}` : ""}; no runner event has arrived`, ...facts, caveat: NO_CALLBACK + toolCaveat };
  const age = now.getTime() - new Date(l.at).getTime();
  if (age < IN_FLIGHT_MS) return { state: "in-flight", basis: "the launch began recently and has no result yet; it may still be running", ...facts };
  // No result, no failure, no runner event, and old enough that no fire can still be awaited in a live process: ORBIT stopped mid-launch.
  if (!research && !l.briefCommit) return { state: "never-dispatched", basis: "no brief commit was recorded, and a fire is only sent after the brief commit is stored: ORBIT stopped before firing", ...facts };
  return {
    state: "dispatch-unknown",
    basis: `${research ? "the launch was recorded" : `the brief commit ${l.briefCommit} was recorded`}${l.fireStartedAt ? ` and the fire was started at ${l.fireStartedAt}` : " (an older record: it has no fire-start time, but the fire follows the brief record immediately)"}, but no provider answer and no failure were ever recorded: ORBIT stopped (restart, deploy or crash) before the fire returned`,
    ...facts,
    caveat: NO_CALLBACK + toolCaveat,
  };
}
