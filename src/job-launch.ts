import type { Job, Jobs } from "./jobs.ts";
import type { ControlRepo, Routine } from "./launcher.ts";
import type { Notifier } from "./notify.ts";

// The one launch path: write the brief to orbit-work, register the job, fire the Routine. The /jobs/launch route,
// a confirmed chat proposal and ORBIT's own review launches all end here.

export type LaunchResult = { code: number; body: unknown };
export type JobLauncher = (routineName: string, briefText: string, review?: NonNullable<Job["review"]>) => Promise<LaunchResult>;

export function jobLauncher(deps: { jobs?: Jobs; control?: ControlRepo; routines?: Map<string, Routine>; notify: Notifier; publicJobUrl?: string }): JobLauncher {
  const { jobs, control, notify, publicJobUrl } = deps;
  const routines = deps.routines ?? new Map<string, Routine>();
  const withHealth = (job: Job) => ({ ...job, health: jobs!.health(job) });
  return async (routineName, briefText, review) => {
    if (!jobs) return { code: 503, body: { error: "Jobs are not enabled." } };
    const routine = routines.get(routineName);
    if (!routine) return { code: 400, body: { error: `Unknown routine. Configured: ${[...routines.keys()].join(", ") || "none"}.` } };
    if (!control) return { code: 503, body: { error: "No orbit-work GitHub credential is installed, so the brief cannot be written." } };
    if (!briefText.trim()) return { code: 400, body: { error: "A launch needs a brief." } };
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const id = `${routine.name}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const registered = jobs.register(id);
    if ("error" in registered) return { code: 400, body: { error: registered.error } };
    if (review) jobs.setReview(id, review);
    const launch: NonNullable<Job["launch"]> = { routine: routine.name, at: new Date().toISOString() };
    const fail = (error: string) => {
      jobs.setLaunch(id, { ...launch, failedAt: new Date().toISOString(), error });
      notify.send(`Job ${id} could not launch: ${error}`, false);
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
    const text = [`Job id: ${id}`, ...(publicJobUrl ? [`API: ${publicJobUrl}`, `Token: ${registered.token}`] : [])].join("\n");
    try {
      const fired = await routine.fire(text);
      jobs.setLaunch(id, { ...launch, ...fired });
    } catch (err) {
      return fail(`routine not fired: ${err instanceof Error ? err.message : err}`);
    }
    return { code: 202, body: withHealth(jobs.get(id)!) };
  };
}
