import type { Job, Jobs } from "./jobs.ts";
import type { ControlRepo, Routine } from "./launcher.ts";
import { briefWords } from "./duplicates.ts";
import type { Notifier } from "./notify.ts";
import { MANIFEST_PATH, prepareContext } from "./job-context.ts";
import type { ContextReader } from "./job-context.ts";

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
// `context`: the exact vault-relative notes the brief relies on (src/job-context.ts). Absent or empty: nothing is exported and the launch is unchanged.
export type JobLauncher = (routineName: string, briefText: string, review?: NonNullable<Job["review"]>, context?: string[]) => Promise<LaunchResult>;

export function jobLauncher(deps: { jobs?: Jobs; control?: ControlRepo; routines?: Map<string, Routine>; notify: Notifier; publicJobUrl?: string; commit?: string; contextReader?: ContextReader; now?: () => Date }): JobLauncher {
  const { jobs, control, notify, publicJobUrl } = deps;
  const commit = toolCommit(deps.commit);
  const routines = deps.routines ?? new Map<string, Routine>();
  const withHealth = (job: Job) => ({ ...job, health: jobs!.health(job) });
  return async (routineName, briefText, review, contextPaths) => {
    if (!jobs) return { code: 503, body: { error: "Jobs are not enabled." } };
    const routine = routines.get(routineName);
    if (!routine) return { code: 400, body: { error: `Unknown routine. Configured: ${[...routines.keys()].join(", ") || "none"}.` } };
    if (!control) return { code: 503, body: { error: "No orbit-work GitHub credential is installed, so the brief cannot be written." } };
    if (!briefText.trim()) return { code: 400, body: { error: "A launch needs a brief." } };
    // Vault context is checked and read completely BEFORE a job is registered or anything is written: a refusal leaves no job, no
    // branch and no runner. Only then is the brief (with its context section) written, then the copies, then the Routine fired.
    const wantsContext = contextPaths !== undefined && contextPaths !== null && !(Array.isArray(contextPaths) && contextPaths.length === 0);
    let context: Awaited<ReturnType<typeof prepareContext>> | undefined;
    if (wantsContext) {
      context = await prepareContext(contextPaths, { reader: deps.contextReader, isPrivate: control.isPrivate && control.pushContext ? () => control.isPrivate!() : undefined, now: deps.now });
      if (!context.ok) return { code: context.code, body: { error: context.error, context: { refused: true, problems: context.problems } } };
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const id = `${routine.name}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const registered = jobs.register(id);
    if ("error" in registered) return { code: 400, body: { error: registered.error } };
    if (review) jobs.setReview(id, review);
    const launch: NonNullable<Job["launch"]> = { routine: routine.name, at: new Date().toISOString(), briefWords: briefWords(briefText) };
    const fail = (error: string) => {
      jobs.setLaunch(id, { ...launch, failedAt: new Date().toISOString(), error });
      notify.send(`Job ${id} could not launch: ${error}`, false);
      return { code: 502, body: { error, job: withHealth(jobs.get(id)!) } };
    };
    try {
      const pushed = await control.pushBrief(id, context?.ok ? `${briefText.trim()}\n\n${context.section}` : briefText.trim());
      Object.assign(launch, { branch: pushed.branch, briefCommit: pushed.commit });
      jobs.setLaunch(id, launch);
    } catch (err) {
      return fail(`brief not written: ${err instanceof Error ? err.message : err}`);
    }
    if (context?.ok) {
      try {
        const written = await control.pushContext!(id, [...context.files.map((f) => ({ path: `.orbit/context/${f.path}`, content: f.content })), { path: MANIFEST_PATH, content: `${JSON.stringify(context.manifest, null, 2)}\n` }]);
        Object.assign(launch, { context: { paths: context.paths, commit: written.commit, ...(context.manifest.source.head ? { vaultHead: context.manifest.source.head } : {}), fresh: context.manifest.source.fresh } });
        jobs.setLaunch(id, launch);
      } catch (err) {
        // The runner is not fired: it would start from a brief that promises copies that are not there.
        return fail(`vault context not written, so the runner was not started: ${err instanceof Error ? err.message.slice(0, 200) : "write failed"}`);
      }
    }
    // The token goes to the runner in the fire text, server to server; it is never returned or logged here.
    const text = [`Job id: ${id}`, ...(publicJobUrl ? [`API: ${publicJobUrl}`, `Token: ${registered.token}`] : []), `Tool commit: ${commit}`].join("\n");
    try {
      const fired = await routine.fire(text);
      jobs.setLaunch(id, { ...launch, ...fired });
    } catch (err) {
      return fail(`routine not fired: ${err instanceof Error ? err.message : err}`);
    }
    return { code: 202, body: withHealth(jobs.get(id)!) };
  };
}
