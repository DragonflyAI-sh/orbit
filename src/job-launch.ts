import type { Job, Jobs } from "./jobs.ts";
import { processLaunches } from "./launch-evidence.ts";
import type { LaunchTracker } from "./launch-evidence.ts";
import { fireFailureOf } from "./launcher.ts";
import type { ControlRepo, Routine } from "./launcher.ts";
import { briefWords } from "./duplicates.ts";
import { dispatchSnapshot } from "./job-inputs.ts";
import type { Notifier } from "./notify.ts";
import type { JobWorkLink } from "./work-sessions.ts";
import { RESEARCH_LIMITS } from "./research.ts";
import type { Lane, ResearchTool } from "./research.ts";

// The one launch path: write the brief to orbit-work, register the job, fire the Routine. The /jobs/launch route,
// a confirmed chat proposal and ORBIT's own review launches all end here.

// The commit of the ORBIT runtime that generates the fire text: the ORBIT_COMMIT that deploy/pull-deploy.sh writes to the
// release's release.env, which is also what /status reports. Never main's tip and never the job branch. Anything that is
// not a hex commit id (unset, "unknown", a sentinel, multi-line junk) becomes "unknown", the existing unavailable
// convention, so a SHA is never invented and the fire text stays one line.
export const COMMIT_UNKNOWN = "unknown";
export function toolCommit(commit: string | undefined): string {
  const c = commit?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/i.test(c) ? c.toLowerCase() : COMMIT_UNKNOWN;
}

export type LaunchResult = { code: number; body: unknown };
// A launch never reads the vault and never writes anything but the brief to the control branch: launch-time vault context export was
// removed (src/job-context.ts). A runner that needs notes reads the ones its brief names from its own read-only vault checkout.
// `work`: the confirmed proposal's work-session link (src/work-sessions.ts), written on the job in the same write that registers it, so a
// restart can tell which confirmation produced which job. Absent for the /jobs/launch route and review launches.
// `lane`: the lane the confirmed proposal was made for. When given, a routine of the other lane is refused (a build proposal can never
// launch on a research routine, or the reverse, even if the configuration changed after it was proposed). Absent: the owner's direct
// /jobs/launch route and ORBIT's review launches, where the routine name alone decides.
export type JobLauncher = (routineName: string, briefText: string, review?: NonNullable<Job["review"]>, work?: JobWorkLink, lane?: Lane) => Promise<LaunchResult>;

// The research lane (src/research.ts): its own routines (never the build ones) and the runner tool the listener serves.
export type ResearchLaunch = { routines: Map<string, Routine>; tool?: ResearchTool; unavailable?: string };

export function jobLauncher(deps: { jobs?: Jobs; control?: ControlRepo; routines?: Map<string, Routine>; notify: Notifier; publicJobUrl?: string; commit?: string; research?: ResearchLaunch; inFlight?: LaunchTracker }): JobLauncher {
  const { jobs, control, notify, publicJobUrl } = deps;
  // Which launches this process is running (src/launch-evidence.ts): only these can be reported as in flight.
  const inFlight = deps.inFlight ?? processLaunches;
  const commit = toolCommit(deps.commit);
  const routines = deps.routines ?? new Map<string, Routine>();
  const researchRoutines = deps.research?.routines ?? new Map<string, Routine>();
  const withHealth = (job: Job) => ({ ...job, health: jobs!.health(job) });
  return async (routineName, briefText, review, work, lane) => {
    if (!jobs) return { code: 503, body: { error: "Jobs are not enabled." } };
    // A name in both lanes is refused outright (src/research.ts refuses that configuration too): never guess which lane was meant.
    if (routines.has(routineName) && researchRoutines.has(routineName)) return { code: 409, body: { error: `Routine ${routineName} is configured in both the build and the research lane; nothing was launched.` } };
    if (researchRoutines.has(routineName)) {
      if (lane === "build") return { code: 409, body: { error: `${routineName} is a research routine; a build launch cannot use it. Nothing was launched.` } };
      if (review) return { code: 409, body: { error: "A review cannot run on a research routine. Nothing was launched." } };
      return launchResearch(researchRoutines.get(routineName)!, briefText, work);
    }
    if (lane === "research") {
      const why = deps.research?.unavailable ?? `no research routine named ${routineName} is configured`;
      return { code: 409, body: { error: `Not launched: ${why}. A research job never falls back to a build routine.` } };
    }
    const routine = routines.get(routineName);
    if (!routine) return { code: 400, body: { error: `Unknown routine. Configured: ${[...routines.keys()].join(", ") || "none"}.` } };
    if (!control) return { code: 503, body: { error: "No orbit-work GitHub credential is installed, so the brief cannot be written." } };
    if (!briefText.trim()) return { code: 400, body: { error: "A launch needs a brief." } };
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const id = `${routine.name}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const registered = jobs.register(id, undefined, work ? { work } : {});
    if ("error" in registered) return { code: 400, body: { error: registered.error } };
    inFlight.begin(id);
    try {
      return await launchBuild(id, registered.token, routine, briefText, review, work);
    } finally {
      inFlight.end(id);
    }
  };

  async function launchBuild(id: string, token: string, routine: Routine, briefText: string, review?: NonNullable<Job["review"]>, work?: JobWorkLink): Promise<LaunchResult> {
    if (!jobs || !control) throw new Error("unreachable: checked by the caller");
    if (review) jobs.setReview(id, review);
    const launch: NonNullable<Job["launch"]> = { routine: routine.name, at: new Date().toISOString(), briefWords: briefWords(briefText) };
    // Recorded before the brief write, so ORBIT stopping during it leaves a launch record without a brief commit (provably never fired),
    // not a job with no launch record at all.
    jobs.setLaunch(id, launch);
    const fail = (error: string, fireFailure?: NonNullable<Job["launch"]>["fireFailure"]) => {
      jobs.setLaunch(id, { ...launch, failedAt: new Date().toISOString(), error, ...(fireFailure ? { fireFailure } : {}) });
      notify.send(`Job ${id} could not launch: ${error}${fireFailure && fireFailure !== "rejected" ? ". Not retried; check the job before launching again." : ""}`, false);
      return { code: 502, body: { error, job: withHealth(jobs.get(id)!) } };
    };
    try {
      const pushed = await control.pushBrief(id, briefText.trim());
      Object.assign(launch, { branch: pushed.branch, briefCommit: pushed.commit });
      jobs.setLaunch(id, launch);
    } catch (err) {
      return fail(`brief not written: ${err instanceof Error ? err.message : err}`);
    }
    // The token goes to the runner in the fire text, server to server; it is never returned or logged here.
    const text = [`Job id: ${id}`, ...(publicJobUrl ? [`API: ${publicJobUrl}`, `Token: ${token}`] : []), `Tool commit: ${commit}`].join("\n");
    // Persisted before the request is sent, so a fire cut off by a restart is recorded as started, never as not attempted. The dispatch
    // snapshot is made from this very text and brief, with the token replaced by its label (src/job-inputs.ts).
    const fireStartedAt = new Date().toISOString();
    const dispatch = dispatchSnapshot({ at: fireStartedAt, lane: "build", origin: review ? "orbit-review" : work ? "chat-proposal" : "owner-route", proposal: work?.proposal, fireText: text, token, brief: briefText.trim() });
    Object.assign(launch, { fireStartedAt, toolCommitSent: commit, dispatch });
    jobs.setLaunch(id, launch);
    try {
      const fired = await routine.fire(text);
      jobs.setLaunch(id, { ...launch, ...fired, firedAt: new Date().toISOString() });
    } catch (err) {
      return fail(fireError(err), fireFailureOf(err));
    }
    return { code: 202, body: withHealth(jobs.get(id)!) };
  }

  // "routine not fired" is kept as the prefix older readers match on; when the provider may have received the request, it says so.
  function fireError(err: unknown): string {
    const kind = fireFailureOf(err);
    const why = `routine not fired: ${err instanceof Error ? err.message : err}`;
    if (kind === "rejected") return why;
    if (kind === "no-session") return `${why} (the provider accepted the request; which session it started is unknown)`;
    return `${why} (outcome unknown: the request may have reached the provider)`;
  }

  // A research launch writes nothing to any repository: the brief is held on the job and served to the runner by the job listener
  // (src/ingress.ts), so the job API and the runner tool are required. The fire text says which lane it is and carries the tool digest.
  async function launchResearch(routine: Routine, briefText: string, work?: JobWorkLink): Promise<LaunchResult> {
    if (!publicJobUrl) return { code: 503, body: { error: "Research jobs need the job API (ORBIT_PUBLIC_JOB_URL), since they have no git record. Nothing was launched." } };
    if (!deps.research?.tool) return { code: 503, body: { error: "The research runner tool is missing from this release, so a research runner could not verify what it runs. Nothing was launched." } };
    const brief = briefText.trim();
    if (!brief) return { code: 400, body: { error: "A launch needs a brief." } };
    if (brief.length > RESEARCH_LIMITS.briefChars) return { code: 400, body: { error: `A research brief is at most ${RESEARCH_LIMITS.briefChars} characters.` } };
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const id = `${routine.name}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const registered = jobs!.register(id, RESEARCH_LIMITS.tokenTtlMs, { ...(work ? { work } : {}), research: { brief } });
    if ("error" in registered) return { code: 400, body: { error: registered.error } };
    inFlight.begin(id);
    try {
      return await fireResearch(id, registered.token, routine, brief, work);
    } finally {
      inFlight.end(id);
    }
  }

  async function fireResearch(id: string, token: string, routine: Routine, brief: string, work?: JobWorkLink): Promise<LaunchResult> {
    if (!deps.research?.tool) throw new Error("unreachable: checked by the caller");
    const launch: NonNullable<Job["launch"]> = { routine: routine.name, at: new Date().toISOString(), briefWords: briefWords(brief) };
    const text = ["Lane: research", `Job id: ${id}`, `API: ${publicJobUrl}`, `Token: ${token}`, `Tool commit: ${commit}`, `Tool sha256: ${deps.research.tool.sha256}`].join("\n");
    const fireStartedAt = new Date().toISOString();
    const dispatch = dispatchSnapshot({ at: fireStartedAt, lane: "research", origin: work ? "chat-proposal" : "owner-route", proposal: work?.proposal, fireText: text, token, brief });
    Object.assign(launch, { fireStartedAt, toolCommitSent: commit, dispatch });
    jobs!.setLaunch(id, launch);
    try {
      const fired = await routine.fire(text);
      jobs!.setLaunch(id, { ...launch, ...fired, firedAt: new Date().toISOString() });
    } catch (err) {
      const error = fireError(err);
      const fireFailure = fireFailureOf(err);
      jobs!.setLaunch(id, { ...launch, failedAt: new Date().toISOString(), error, fireFailure });
      notify.send(`Research job ${id} could not launch: ${error}${fireFailure !== "rejected" ? ". Not retried; check the job before launching again." : ""}`, false);
      return { code: 502, body: { error, job: withHealth(jobs!.get(id)!) } };
    }
    return { code: 202, body: withHealth(jobs!.get(id)!) };
  }
}
