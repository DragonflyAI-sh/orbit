import { randomUUID } from "node:crypto";
import type { Notifier } from "./notify.ts";
import type { PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";
import { isDailyTime, nextDaily, ZONE } from "./time.ts";

export type Job = {
  id: string;
  text: string;
  urgent: boolean;
  at?: string;
  everyMinutes?: number;
  dailyAt?: string;
  nextRun?: string;
  runs: { at: string; notification: string }[];
};

export type JobInput = { text?: unknown; urgent?: unknown; at?: unknown; everyMinutes?: unknown; dailyAt?: unknown };

const MIN_EVERY = 5;
const KEEP_RUNS = 20;

function next(job: Job, after: Date): string | undefined {
  if (job.dailyAt) return nextDaily(job.dailyAt, after).toISOString();
  if (job.everyMinutes) return new Date(after.getTime() + job.everyMinutes * 60_000).toISOString();
  return undefined;
}

export function parseJob(input: JobInput, now: Date): Job | string {
  if (typeof input.text !== "string" || !input.text.trim()) return "A job needs text.";
  const kinds = ["at", "everyMinutes", "dailyAt"].filter((k) => input[k as keyof JobInput] !== undefined);
  if (kinds.length !== 1) return "Give exactly one of at (ISO time), everyMinutes, or dailyAt (HH:MM Pacific).";
  const job: Job = { id: randomUUID(), text: input.text.trim().slice(0, 2000), urgent: input.urgent === true, runs: [] };
  if (input.at !== undefined) {
    const at = new Date(String(input.at));
    if (Number.isNaN(at.getTime()) || at <= now) return "at must be a future ISO time.";
    job.at = job.nextRun = at.toISOString();
  } else if (input.everyMinutes !== undefined) {
    if (!Number.isInteger(input.everyMinutes) || (input.everyMinutes as number) < MIN_EVERY) {
      return `everyMinutes must be a whole number of at least ${MIN_EVERY}.`;
    }
    job.everyMinutes = input.everyMinutes as number;
    job.nextRun = next(job, now);
  } else {
    if (typeof input.dailyAt !== "string" || !isDailyTime(input.dailyAt)) return "dailyAt must be HH:MM, 24-hour, Pacific.";
    job.dailyAt = input.dailyAt;
    job.nextRun = next(job, now);
  }
  return job;
}

export type Scheduler = ReturnType<typeof scheduler>;

export function scheduler(store: Store<Job[]>, notify: Notifier, now: () => Date = () => new Date()) {
  let lastTick: string | undefined;

  return {
    list: (): Job[] => store.read(),

    add(job: Job): Job {
      store.write([...store.read(), job]);
      return job;
    },

    remove(id: string): boolean {
      const jobs = store.read();
      store.write(jobs.filter((j) => j.id !== id));
      return jobs.some((j) => j.id === id);
    },

    // Runs every due job once, then delivers notifications. Called every 30 seconds.
    async tick(): Promise<void> {
      const at = now();
      const jobs = store.read().map((job) => {
        if (!job.nextRun || new Date(job.nextRun) > at) return job;
        const n = notify.send(job.text, job.urgent);
        return { ...job, nextRun: next(job, at), runs: [...job.runs, { at: at.toISOString(), notification: n.id }].slice(-KEEP_RUNS) };
      });
      store.write(jobs.filter((j) => j.nextRun));
      lastTick = at.toISOString();
      await notify.pump();
    },

    status(): PortStatus {
      const jobs = store.read();
      const persisted = store.persisted ? "" : " Not persisted: jobs are lost on restart.";
      return {
        port: "schedule",
        state: !store.persisted ? "degraded" : lastTick ? "live" : "degraded",
        impl: "in-process-30s",
        detail: lastTick
          ? `${jobs.length} jobs; checks every 30 s; daily times are ${ZONE}.${persisted}`
          : `Not ticked yet.${persisted}`,
        verifiedAt: lastTick ?? new Date(0).toISOString(),
      };
    },
  };
}
