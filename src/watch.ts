import { PERSONA } from "./persona.ts";
import { jobProgress } from "./job-progress.ts";
import type { CallbackAlert, Job } from "./jobs.ts";
import { dispatchEvidence } from "./launch-evidence.ts";
import type { DispatchState, EvidenceContext } from "./launch-evidence.ts";
import type { Notifier } from "./notify.ts";
import type { PortState, PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";

// ORBIT tells Rai when part of itself stays broken: one message when it goes wrong, one when it recovers.

export const ALERT_AFTER_MS = 5 * 60_000;

type Bad = { since: string; state: PortState; stateSince: string; detail: string };
// What was already reported. This is what survives a restart.
export type Alerted = { since: string; state: PortState };
// jobs: job id -> what we already reported: "quiet", or "not-started:<dispatch state>" (src/launch-evidence.ts); cleared when the job
// reports again or ends. A bare "not-started" is a record from before the dispatch state was kept: it is taken as already reported, and
// upgraded silently to the current state, so a deploy never re-sends every old alert.
export type JobsTold = Record<string, string>;
export type WatchState = { ports: Record<string, Alerted>; jobs?: JobsTold };
// setCallbackAlert: where the watch records the first-callback alert on the job itself (src/jobs.ts CallbackAlert), so every job view can
// show it and a restart with a lost watch store still does not repeat it. Optional: a source without it still gets the alerts.
export type JobSource = { all(): Job[]; health(job: Job): string; setCallbackAlert?(id: string, alert: CallbackAlert): void };
// Storing a first-callback notice is tried at most this many times (one per tick) when it throws, then given up and recorded as such.
export const MAX_ALERT_ATTEMPTS = 3;
// modelRecovery: whether a "model is live again" notice may be sent now (src/model-health.ts confirmsRecovery). After a deploy the model
// port's local login check reports `live` before any call, which is not evidence that the primary answers; while this is false the
// notice is held (the alert record is kept, so the real recovery is still reported once it is confirmed). Absent: no gate.
export type WatchOptions = { inFlight?: EvidenceContext["inFlight"]; modelRecovery?: () => boolean };

const isBad = (s: PortStatus) => s.state === "degraded" || s.state === "down";
// An epoch verifiedAt means "not used yet" (for example the model right after a restart), not "broken".
const neverUsed = (s: PortStatus) => new Date(s.verifiedAt).getTime() === 0;

export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 90 ? `${min} min` : `${Math.round(min / 6) / 10} h`;
}

export type Watch = ReturnType<typeof watcher>;

const NOT_STARTED = "not-started";
const toldDispatch = (told: string | undefined): DispatchState | "legacy" | undefined =>
  told === NOT_STARTED ? "legacy" : told?.startsWith(`${NOT_STARTED}:`) ? (told.slice(NOT_STARTED.length + 1) as DispatchState) : undefined;

export function watcher(store: Store<WatchState>, notify: Notifier, now: () => Date = () => new Date(), jobs?: JobSource, opts: WatchOptions = {}) {
  let source: () => PortStatus[] = () => [];
  const bad = new Map<string, Bad>();
  let lastTick: string | undefined;
  // A model recovery notice is being held (logged once per hold).
  let held = false;
  const read = (): WatchState => ({ ports: { ...store.read().ports }, jobs: { ...store.read().jobs } });

  function watchPorts(state: WatchState, statuses: PortStatus[]): WatchState {
    const t = now();
    const ports = { ...state.ports };
    for (const s of statuses) {
      if (s.port === "watch" || neverUsed(s)) {
        // Not used yet: neither a problem nor a recovery.
        if (s.port !== "watch") bad.delete(s.port);
        continue;
      }
      if (isBad(s)) {
        const prev = bad.get(s.port);
        const cur: Bad = prev ? { ...prev, detail: s.detail, ...(prev.state === s.state ? {} : { state: s.state, stateSince: t.toISOString() }) } : { since: t.toISOString(), state: s.state, stateSince: t.toISOString(), detail: s.detail };
        bad.set(s.port, cur);
        const told = ports[s.port];
        const long = (iso: string) => t.getTime() - new Date(iso).getTime() >= ALERT_AFTER_MS;
        // After a restart the alerted record, not this process's memory, says when the trouble began.
        const since = told?.since ?? cur.since;
        const first = !told && long(cur.since);
        const escalate = told?.state === "degraded" && cur.state === "down" && long(cur.stateSince);
        if (first || escalate) {
          notify.send(`${PERSONA.name} part "${s.port}" is ${cur.state} since ${since}: ${s.detail}${escalate ? " (it was degraded before)" : ""}`, cur.state === "down");
          ports[s.port] = { since, state: cur.state };
        }
      } else {
        bad.delete(s.port);
        const told = ports[s.port];
        if (told && s.state === "live" && s.port === "model" && opts.modelRecovery && !opts.modelRecovery()) {
          // Not confirmed: the primary has not answered in this process (or the latest evidence is a limit). Keep the alert record.
          if (!held) console.log(JSON.stringify({ at: t.toISOString(), watch: "model recovery notice held: the primary model has not answered in this process yet (src/model-health.ts)", alerted: told.state, since: told.since }));
          held = true;
        } else if (told && s.state === "live") {
          if (s.port === "model") held = false;
          notify.send(`${PERSONA.name} part "${s.port}" is live again after ${duration(t.getTime() - new Date(told.since).getTime())} (${told.state} since ${told.since}).`);
          delete ports[s.port];
        } else if (told) {
          // mock: no longer broken, but not proven live either; forget it without claiming recovery.
          delete ports[s.port];
        }
      }
    }
    return { ...state, ports };
  }

  // A job that never started or went quiet is reported once. A not-started job is reported again only when what ORBIT's record proves about
  // its dispatch changes (for example "in-flight" in this process, then "dispatch-unknown" after a restart cut the fire off): one message
  // per material change, never one per tick. Finished jobs never alert. The alert works from ORBIT's own stored times, so it needs nothing
  // from the runner: a runner that was stopped (or refused) before it could send any failure report is still noticed.
  // Deduplication has two records: the watch's own store (`told`) and the alert kept on the job (job.callbackAlert), so a restart, a lost
  // watch store or a page refresh never repeats an alert. A runner event after an alert supersedes it: the job record says so, and if the
  // job is still running Rai gets one short note that the earlier alert no longer applies (a finished job has its completion notice).
  function watchJobs(state: WatchState): WatchState {
    if (!jobs) return state;
    const told = { ...state.jobs };
    const all = jobs.all();
    const setAlert = (id: string, a: CallbackAlert): boolean => {
      try {
        jobs.setCallbackAlert?.(id, a);
        return Boolean(jobs.setCallbackAlert);
      } catch (err) {
        console.error(JSON.stringify({ at: now().toISOString(), watch: `could not record the callback alert on job ${id}: ${String(err)}` }));
        return false;
      }
    };
    for (const job of all) {
      const health = jobs.health(job);
      if (health !== "not-started" && health !== "quiet") {
        const was = told[job.id];
        delete told[job.id];
        const a = job.callbackAlert;
        // The superseded mark is what stops the note below from repeating, so the note goes out only once the mark is stored.
        let superseded = false;
        if (a && !a.resolvedAt && job.events.length) {
          const finished = health === "finished";
          const first = job.events.find((e) => e.at >= a.at) ?? job.events[0]!;
          superseded = setAlert(job.id, { ...a, resolvedAt: first.at, resolution: finished ? "finished" : "runner-callback" });
        }
        const alerted = (superseded && a!.notificationId) || (!a && toldDispatch(was) !== undefined);
        if (alerted && job.events.length && health !== "finished") {
          const first = job.events[0]!;
          const late = job.launch ? ` (${duration(new Date(first.at).getTime() - new Date(job.launch.at).getTime())} after launch)` : "";
          try {
            notify.send(`Job ${job.id} checked in at ${first.at}${late}, after ORBIT's not-started alert: that alert no longer applies. Runner-reported (${first.type} via ${first.via === "git" ? "git" : "the API"}).`);
          } catch (err) {
            console.error(JSON.stringify({ at: now().toISOString(), watch: `could not queue the late check-in note for job ${job.id}: ${String(err)}` }));
          }
        }
        continue;
      }
      const link = job.launch?.sessionUrl ?? "no session link";
      if (health === "quiet") {
        if (told[job.id] === "quiet") continue;
        const last = [...job.events].reverse().find((e) => e.type === "checkin" && e.text);
        const lastLine = last ? `last check-in ${last.at}: ${last.text}` : "no check-in yet";
        notify.send(`Job ${job.id} is quiet (no event for 15 minutes). Session: ${link}. ${lastLine}`);
        told[job.id] = "quiet";
        continue;
      }
      // A job with no runner event says what ORBIT's record shows about the dispatch, so "not started" is never read as "no session".
      const dispatch = dispatchEvidence(job, { inFlight: opts.inFlight });
      const key = `${NOT_STARTED}:${dispatch.state}`;
      const prev = job.callbackAlert && !job.callbackAlert.resolvedAt ? job.callbackAlert : undefined;
      let before = toldDispatch(told[job.id]);
      // The job's own record deduplicates too (it survives a lost or unpersisted watch store).
      if (before === undefined && prev && (prev.notificationId || prev.gaveUp)) before = prev.dispatch as DispatchState;
      if (before === dispatch.state) {
        told[job.id] = key;
        continue;
      }
      if (before === "legacy") {
        told[job.id] = key;
        continue;
      }
      const stage = jobProgress(job, health).lastVerified;
      const stageLine = `Last verified stage: ${stage.label}${stage.at ? ` at ${stage.at}` : ""}${stage.detail ? ` (${stage.detail})` : ""}.`;
      const caveat = dispatch.caveat ? ` ${dispatch.caveat}` : "";
      const text = before === undefined
        ? `Job ${job.id} is not started (no runner event 10 minutes after launch: not checked in, which is not proof that it failed or never launched, and not a cause). Session: ${link}. no check-in yet. ${stageLine} Dispatch: ${dispatch.state} (${dispatch.basis}).${caveat} Nothing was retried or relaunched.`
        : `Job ${job.id} is still not started; its dispatch evidence changed from ${before} to ${dispatch.state} (${dispatch.basis}). Session: ${link}. ${stageLine}${caveat}`;
      const at = now().toISOString();
      try {
        const n = notify.send(text);
        told[job.id] = key;
        setAlert(job.id, { firstAt: prev?.firstAt ?? n.createdAt, at: n.createdAt, count: (prev?.count ?? 0) + 1, dispatch: dispatch.state, stage: stage.key, notificationId: n.id });
      } catch (err) {
        const attempts = (prev?.queueError ? (prev.attempts ?? 0) : 0) + 1;
        const gaveUp = attempts >= MAX_ALERT_ATTEMPTS;
        if (gaveUp) told[job.id] = key;
        setAlert(job.id, { firstAt: prev?.firstAt ?? at, at, count: prev?.count ?? 0, dispatch: dispatch.state, stage: stage.key, queueError: String(err instanceof Error ? err.message : err).slice(0, 200), attempts, ...(gaveUp ? { gaveUp: true } : {}) });
        console.error(JSON.stringify({ at, watch: `could not queue the not-started alert for job ${job.id} (attempt ${attempts} of ${MAX_ALERT_ATTEMPTS}): ${String(err)}` }));
      }
    }
    const ids = new Set(all.map((j) => j.id));
    for (const id of Object.keys(told)) if (!ids.has(id)) delete told[id];
    return { ...state, jobs: told };
  }

  return {
    // The server hands over its status list; the watch line never counts itself.
    attach(fn: () => PortStatus[]): void {
      source = fn;
    },

    tick(): void {
      lastTick = now().toISOString();
      const before = read();
      const next = watchJobs(watchPorts(before, source()));
      if (JSON.stringify(next) !== JSON.stringify(before)) store.write(next);
    },

    status(): PortStatus {
      const alerting = Object.entries(read().ports).map(([p, a]) => `${p} ${a.state} since ${a.since}`);
      const waiting = [...bad].filter(([p]) => !read().ports[p]).map(([p, b]) => `${p} ${b.state} since ${b.since}`);
      const jobsAlerting = Object.entries(read().jobs ?? {}).map(([id, h]) => {
        const d = toldDispatch(h);
        return d && d !== "legacy" ? `${id} not-started (dispatch ${d})` : `${id} ${h}`;
      });
      const parts = [
        alerting.length ? `Alerting: ${alerting.join("; ")}.` : "Nothing alerting.",
        ...(jobsAlerting.length ? [`Jobs alerting: ${jobsAlerting.join("; ")}.`] : []),
        ...(waiting.length ? [`Not yet 5 minutes: ${waiting.join("; ")}.`] : []),
        ...(store.persisted ? [] : ["Not persisted: a restart may repeat an alert."]),
      ];
      return { port: "watch", state: store.persisted ? "live" : "degraded", impl: "port-watch", detail: parts.join(" "), verifiedAt: lastTick ?? now().toISOString() };
    },
  };
}
