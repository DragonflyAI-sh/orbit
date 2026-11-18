import type { Job, Launch } from "./jobs.ts";

// What ORBIT's own job record can prove about a launch's dispatch (docs/reviews/launch-reconciliation.md).
//
// `health` answers "has the runner said anything?". This answers a different question: "how far did the launch get on ORBIT's side, and
// what does the record NOT know?". It reads only the stored job; it never calls GitHub or the provider, and it never retries, cancels or
// launches anything. Missing runner callbacks are never read as "no cloud session": a session can exist and stop before it reports
// (for example when it refuses the tool commit in the fire text, or fails before `orbit-job start`).
//
//   no-launch-record   the job has no launch record (registered by another path); nothing is known about a dispatch.
//   in-flight          THIS process is running the launch right now (it is in the launch tracker below) and has no result yet. Never
//                      inferred from the launch's age: a launch begun before a restart is not in this process's tracker, so it can never
//                      be in flight here, however recent it is.
//   never-dispatched   the record proves the Routine was never fired: the brief write failed, or no brief commit was recorded and this
//                      process is not running the launch. A fire is only ever sent after the brief commit is stored (src/job-launch.ts),
//                      so neither can have reached the provider.
//   dispatch-unknown   a fire was (or may have been) sent and no provider answer was recorded: ORBIT stopped mid-fire (restart, deploy,
//                      crash), the connection failed after sending, or the provider answered 5xx. A session may or may not exist.
//   provider-rejected  the provider answered the fire with a 4xx: it refused the request.
//   provider-accepted  the provider answered 2xx (with a session id, or without a usable one) and no runner event has arrived. A session
//                      was accepted; whether it ran, refused or failed before reporting is not in ORBIT's record.
//   runner-reported    the runner reported (over the API, or ORBIT found its start or summary in git). For a research job this includes
//                      a bootstrap failure report (src/research-bootstrap.ts): the runner's own, unverified word that it stopped before
//                      its tool ran.
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

// The job ids of the launches this process is running right now. In memory only, on purpose: a restart empties it, which
// is exactly what makes a pre-restart launch with no result read as interrupted rather than in flight. src/job-launch.ts adds a job before
// writing its launch record and removes it when the launcher returns or throws.
export type LaunchTracker = { begin(id: string): void; end(id: string): void; has(id: string): boolean };
export function launchTracker(): LaunchTracker {
  const ids = new Set<string>();
  return { begin: (id) => void ids.add(id), end: (id) => void ids.delete(id), has: (id) => ids.has(id) };
}
// The one tracker of this ORBIT process. Tests pass their own (an empty one stands for "after a restart").
export const processLaunches: LaunchTracker = launchTracker();
export type EvidenceContext = { inFlight?: Pick<LaunchTracker, "has"> };
const NO_CALLBACK = "No runner callback is not evidence that no cloud session exists: a session can stop before it reports.";

// Older records carry only the error text. These are the messages src/job-launch.ts and src/launcher.ts have always written.
export function legacyFailure(error: string | undefined): "brief" | "rejected" | "server-error" | "no-session" | "unknown" {
  const e = error ?? "";
  if (/^brief not written/.test(e)) return "brief";
  const http = e.match(/fire returned HTTP (\d{3})/);
  if (http) return Number(http[1]) >= 500 ? "server-error" : "rejected";
  if (/fire returned no session/.test(e)) return "no-session";
  return "unknown";
}

// A recorded launch failure that proves no session can exist: the brief was never written, or the provider answered the fire with a
// refusal. Every other failure (transport, 5xx, 2xx without a session, an unclassified error) leaves the outcome unresolved.
export function failureIsDefinitive(l: Pick<Launch, "fireFailure" | "error">): boolean {
  const kind = l.fireFailure ?? legacyFailure(l.error);
  return kind === "brief" || kind === "rejected";
}

export function dispatchEvidence(job: Job, ctx: EvidenceContext = {}): DispatchEvidence {
  const inFlight = ctx.inFlight ?? processLaunches;
  const l = job.launch;
  if (!l) return { state: "no-launch-record", basis: "the job has no launch record, so ORBIT holds no evidence of a dispatch", record: "none", ...(job.events.length ? {} : { caveat: NO_CALLBACK }) };
  const record: DispatchEvidence["record"] = l.fireStartedAt ? "new" : "legacy";
  const facts = { record, ...(l.sessionId ? { sessionId: l.sessionId } : {}), ...(l.fireStartedAt ? { fireStartedAt: l.fireStartedAt } : {}), ...(l.toolCommitSent ? { toolCommitSent: l.toolCommitSent } : {}) };
  const toolCaveat = l.toolCommitSent !== undefined && !/^[0-9a-f]{40}$/.test(l.toolCommitSent) ? ` The fire text carried tool commit "${l.toolCommitSent.slice(0, 64)}", which the Routine prompt refuses (it requires 40 lowercase hex characters on main), so a session would stop before reporting.` : "";

  if (job.events.length) {
    const boot = job.events.find((e) => e.type === "bootstrap");
    if (boot && !job.events.some((e) => e.type === "started")) return { state: "runner-reported", basis: `the runner reported a bootstrap failure (${boot.bootstrap?.category ?? boot.status ?? "unknown"}) at ${boot.at}, before its tool started: a session ran and stopped (runner-reported, unverified)`, ...facts };
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
  if (inFlight.has(job.id)) {
    const stage = !research && !l.briefCommit ? "writing the brief" : l.fireStartedAt ? `firing the routine, started ${l.fireStartedAt}` : "about to fire the routine";
    return { state: "in-flight", basis: `this ORBIT process is still running the launch (${stage}) and has no result yet`, ...facts };
  }
  // No result, no failure, no runner event, and this process is not running the launch: ORBIT stopped (restart, deploy, crash) mid-launch.
  if (!research && !l.briefCommit) return { state: "never-dispatched", basis: "no brief commit was recorded and this ORBIT process is not running the launch; a fire is only sent after the brief commit is stored, so ORBIT stopped before firing", ...facts };
  return {
    state: "dispatch-unknown",
    basis: `${research ? "the launch was recorded" : `the brief commit ${l.briefCommit} was recorded`}${l.fireStartedAt ? ` and the fire was started at ${l.fireStartedAt}` : " (an older record: it has no fire-start time, but the fire follows the brief record immediately)"}, but no provider answer and no failure were ever recorded, and this ORBIT process is not running the launch: ORBIT stopped (restart, deploy or crash) before the fire returned`,
    ...facts,
    caveat: NO_CALLBACK + toolCaveat,
  };
}

// One reading of a job's launch for every consumer that has to decide something from it: the not-started alert, the host-operation job
// warnings (src/ops-sys.ts), the retry gate and the work-session link state (src/work-sessions.ts). The runner's own events always outrank a
// recorded fire failure; a failure counts as "no session" only when it is definitive; anything else is unresolved, never "ended".
//
//   runner-active   the runner reported and has not sent a terminal summary: work may be running (whatever the fire result said).
//   runner-ended    the runner sent a terminal summary (done, blocked or failed).
//   not-launched    no runner event, and the record proves no session can exist: never-dispatched or provider-rejected.
//   unresolved      no runner event, and a session may exist or the launch is still running here: in-flight, dispatch-unknown,
//                   provider-accepted, or no launch record. Never retried or relaunched automatically.
export type LaunchOutcome = "runner-active" | "runner-ended" | "not-launched" | "unresolved";
export function launchOutcome(job: Job, ctx: EvidenceContext = {}): { outcome: LaunchOutcome; dispatch: DispatchEvidence } {
  const dispatch = dispatchEvidence(job, ctx);
  if (job.state === "done" || job.state === "blocked" || job.state === "failed") return { outcome: "runner-ended", dispatch };
  if (dispatch.state === "runner-reported") return { outcome: "runner-active", dispatch };
  if (dispatch.state === "never-dispatched" || dispatch.state === "provider-rejected") return { outcome: "not-launched", dispatch };
  return { outcome: "unresolved", dispatch };
}
