import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Notifier } from "./notify.ts";
import type { PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";

// Jobs run by Claude cloud runners. ORBIT registers a job, hands the runner a token that works for that job only,
// queues steers for it, and receives its events. The git record in orbit-work stays the source of truth.

export type JobEvent = { at: string; type: "started" | "checkin" | "reply" | "summary"; sha?: string; n?: number; status?: string; text?: string; via?: "api" | "git" };
export type Steer = { n: number; text: string; at: string; deliveredAt?: string };
export type Launch = { routine: string; at: string; branch?: string; briefCommit?: string; sessionId?: string; sessionUrl?: string; failedAt?: string; error?: string };
export type Job = {
  id: string;
  launch?: Launch;
  createdAt: string;
  expiresAt: string;
  state: "registered" | "running" | "done" | "blocked" | "failed";
  lastEventAt?: string;
  events: JobEvent[];
  steers: Steer[];
};

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 4000;
const KEEP_EVENTS = 200;
const KEEP_JOBS = 200;

export function jobSecret(dir: string | undefined): Buffer {
  if (!dir) return randomBytes(32);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "job-secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

export type Jobs = ReturnType<typeof jobs>;

export function jobs(store: Store<Job[]>, secret: Buffer, notify: Notifier, now: () => Date = () => new Date()) {
  const list = () => store.read();
  const save = (items: Job[]) => store.write(items.slice(-KEEP_JOBS));
  const sign = (id: string, expiresAt: string) => createHmac("sha256", secret).update(`${id}\n${expiresAt}`).digest("base64url");
  const find = (id: string) => list().find((j) => j.id === id);
  const update = (id: string, change: (j: Job) => Job) => save(list().map((j) => (j.id === id ? change(j) : j)));
  let lastEventAt: string | undefined;

  return {
    // Registers a job and returns its token. Registering an existing id again returns a fresh token for it.
    register(id: string, ttlMs = DEFAULT_TTL_MS): { job: Job; token: string } | { error: string } {
      if (!JOB_ID.test(id)) return { error: "Job ids are letters, digits, dot, underscore and dash, up to 64 characters." };
      const at = now();
      const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
      const existing = find(id);
      const job: Job = existing ? { ...existing, expiresAt } : { id, createdAt: at.toISOString(), expiresAt, state: "registered", events: [], steers: [] };
      save(existing ? list().map((j) => (j.id === id ? job : j)) : [...list(), job]);
      return { job, token: `${id}.${sign(id, expiresAt)}` };
    },

    // A token is valid only for its own job, until that job finishes or expires, whichever comes first.
    verify(id: string, token: string | undefined): boolean {
      const job = find(id);
      if (!job || !token || new Date(job.expiresAt) <= now()) return false;
      if (job.state === "done" || job.state === "blocked" || job.state === "failed") return false;
      const expected = Buffer.from(`${id}.${sign(id, job.expiresAt)}`);
      const given = Buffer.from(token);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    record(id: string, event: Omit<JobEvent, "at">): Job | undefined {
      const job = find(id);
      if (!job) return undefined;
      const at = now().toISOString();
      const clean: JobEvent = { ...event, at, via: event.via ?? "api", text: event.text?.slice(0, MAX_TEXT), status: event.status?.slice(0, 200) };
      const state: Job["state"] =
        event.type === "summary" && (event.status === "done" || event.status === "blocked" || event.status === "failed") ? event.status : "running";
      update(id, (j) => ({ ...j, state, lastEventAt: at, events: [...j.events, clean].slice(-KEEP_EVENTS) }));
      lastEventAt = at;
      if (event.type === "reply") notify.send(`Job ${id} replied to steer ${event.n}:\n\n${clean.text ?? "(see git)"}`, false);
      if (event.type === "summary") {
        const via = clean.via === "git" ? " (found in git; the API did not report it)" : "";
        notify.send(`Job ${id} finished: ${event.status}${via}.\n\n${clean.text ?? "(see git)"}`, event.status !== "done");
      }
      return find(id);
    },

    steer(id: string, text: string): Steer | undefined {
      const job = find(id);
      if (!job) return undefined;
      const steer: Steer = { n: job.steers.length + 1, text: text.slice(0, MAX_TEXT), at: now().toISOString() };
      update(id, (j) => ({ ...j, steers: [...j.steers, steer] }));
      return steer;
    },

    // Steers the runner has not acknowledged yet. Acknowledging marks them delivered.
    pending(id: string): Steer[] {
      return find(id)?.steers.filter((s) => !s.deliveredAt) ?? [];
    },

    acknowledge(id: string, numbers: number[]): void {
      const at = now().toISOString();
      update(id, (j) => ({ ...j, steers: j.steers.map((s) => (numbers.includes(s.n) && !s.deliveredAt ? { ...s, deliveredAt: at } : s)) }));
    },

    setLaunch(id: string, launch: Launch): void {
      update(id, (j) => ({ ...j, launch }));
    },

    // Flags a job that has not started within 10 minutes of launch, or has gone quiet for 15 minutes.
    health(job: Job): "ok" | "not-started" | "quiet" | "finished" | "launch-failed" {
      if (job.launch?.failedAt) return "launch-failed";
      if (job.state === "done" || job.state === "blocked" || job.state === "failed") return "finished";
      const t = now().getTime();
      if (!job.events.length) return job.launch && t - new Date(job.launch.at).getTime() > 10 * 60_000 ? "not-started" : "ok";
      return job.lastEventAt && t - new Date(job.lastEventAt).getTime() > 15 * 60_000 ? "quiet" : "ok";
    },

    get: find,
    list: (): Job[] => list().slice(-50).reverse(),

    status(): PortStatus {
      const active = list().filter((j) => (j.state === "registered" || j.state === "running") && !j.launch?.failedAt).length;
      return {
        port: "jobs",
        state: store.persisted ? "live" : "degraded",
        impl: "job-api",
        detail: `${active} active cloud jobs.${store.persisted ? "" : " Not persisted: jobs are lost on restart."}${lastEventAt ? ` Last runner event ${lastEventAt}.` : ""}`,
        verifiedAt: now().toISOString(),
      };
    },
  };
}
