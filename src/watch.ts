import type { Job } from "./jobs.ts";
import type { Notifier } from "./notify.ts";
import type { PortState, PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";

// ORBIT tells Rai when part of itself stays broken: one message when it goes wrong, one when it recovers.

export const ALERT_AFTER_MS = 5 * 60_000;

type Bad = { since: string; state: PortState; stateSince: string; detail: string };
// What was already reported. This is what survives a restart.
export type Alerted = { since: string; state: PortState };
// jobs: job id -> the health we already reported ("not-started" or "quiet"); cleared when the job reports again or ends.
export type WatchState = { ports: Record<string, Alerted>; jobs?: Record<string, string> };
export type JobSource = { all(): Job[]; health(job: Job): string };

const isBad = (s: PortStatus) => s.state === "degraded" || s.state === "down";
// An epoch verifiedAt means "not used yet" (for example the model right after a restart), not "broken".
const neverUsed = (s: PortStatus) => new Date(s.verifiedAt).getTime() === 0;

export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 90 ? `${min} min` : `${Math.round(min / 6) / 10} h`;
}

export type Watch = ReturnType<typeof watcher>;

export function watcher(store: Store<WatchState>, notify: Notifier, now: () => Date = () => new Date(), jobs?: JobSource) {
  let source: () => PortStatus[] = () => [];
  const bad = new Map<string, Bad>();
  let lastTick: string | undefined;
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
          notify.send(`ORBIT part "${s.port}" is ${cur.state} since ${since}: ${s.detail}${escalate ? " (it was degraded before)" : ""}`, cur.state === "down");
          ports[s.port] = { since, state: cur.state };
        }
      } else {
        bad.delete(s.port);
        const told = ports[s.port];
        if (told && s.state === "live") {
          notify.send(`ORBIT part "${s.port}" is live again after ${duration(t.getTime() - new Date(told.since).getTime())} (${told.state} since ${told.since}).`);
          delete ports[s.port];
        } else if (told) {
          // mock: no longer broken, but not proven live either; forget it without claiming recovery.
          delete ports[s.port];
        }
      }
    }
    return { ...state, ports };
  }

  // A job that never started or went quiet is reported once. Finished jobs never alert.
  function watchJobs(state: WatchState): WatchState {
    if (!jobs) return state;
    const told = { ...state.jobs };
    const all = jobs.all();
    for (const job of all) {
      const health = jobs.health(job);
      if (health !== "not-started" && health !== "quiet") {
        delete told[job.id];
        continue;
      }
      if (told[job.id] === health) continue;
      const last = [...job.events].reverse().find((e) => e.type === "checkin" && e.text);
      const link = job.launch?.sessionUrl ?? "no session link";
      const lastLine = last ? `last check-in ${last.at}: ${last.text}` : "no check-in yet";
      notify.send(`Job ${job.id} is ${health === "quiet" ? "quiet (no event for 15 minutes)" : "not started (no event 10 minutes after launch)"}. Session: ${link}. ${lastLine}`);
      told[job.id] = health;
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
      const jobsAlerting = Object.entries(read().jobs ?? {}).map(([id, h]) => `${id} ${h}`);
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
