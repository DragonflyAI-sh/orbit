import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOB_ID, type Job } from "./jobs.ts";

// Work sessions and run links (docs/adr/0002-work-sessions.md). Session awareness slice 4.
//
// Three identities stay distinct:
// - the *origin*: the conversation a launch was proposed in (`chat:<uuid>` or `assistant:assistant`), taken from server request context
//   (the thread the turn ran in, which is where the proposal's card is stored), never from model or request-body text;
// - the *work session*: `work:<uuid>`, a durable activity context ORBIT creates when a launch proposal is confirmed. It is not a chat,
//   not a runner's cloud session (`Job.launch.sessionId`) and not a job id;
// - the *run*: one execution, an ORBIT job (`job:<id>`). The job store (src/jobs.ts) stays the only source of execution state.
//
// This store holds only references and minimal metadata: ids, times, the attachment kind and what is known about the launch. No brief,
// no transcript, no tool payload. A link is keyed by the confirmed proposal id, so a confirmation can be recorded once only.
//
// Persistence: one JSON file, `<state>/work-sessions.json`, loaded lazily on first use, written atomically (write `.new`, rename) before
// the in-memory copy changes. Records this build does not understand are kept in the file untouched. A file that exists but cannot be
// read (or has a newer schema version) makes the store unavailable: it is never overwritten, and launches that need it are refused.

export const WORK_FILE_VERSION = 1;
export const WORK_SESSION_PREFIX = "work";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGIN = /^(?:assistant:assistant|chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const workSessionId = (uuid: string) => `${WORK_SESSION_PREFIX}:${uuid}`;
export const isWorkUuid = (s: string) => UUID.test(s);
export const isWorkSessionId = (s: unknown): s is string => typeof s === "string" && s.length <= 64 && s.startsWith(`${WORK_SESSION_PREFIX}:`) && UUID.test(s.slice(WORK_SESSION_PREFIX.length + 1));
export const isOriginId = (s: unknown): s is string => typeof s === "string" && ORIGIN.test(s);

// Where a launch was requested. `server-turn`: the conversation whose turn created the proposal (the card's thread). `unknown`: no
// trustworthy record (the legacy /chat route stores no card); never inferred from titles, text or timing.
export type Origin = { session: string; basis: "server-turn" } | { session: null; basis: "unknown"; why: string };

export type WorkSession = {
  id: string;
  createdAt: string;
  // The origin of the confirmation that created this work session. Fixed for its life.
  origin: Origin;
  // The proposal whose confirmation created it.
  createdBy: string;
  // `open` only: nothing closes a work session yet. A finished or failed run does not close it (its goal is not tracked).
  lifecycle: "open";
};

export type Attachment = "new" | "follow-up" | "retry";
// What is known about the launch a confirmation started. `launching`: recorded before the launch began and not settled (in progress, or
// ORBIT stopped before it could record the result). `not-launched`: refused before any external step (no job, or the job was never
// fired). `failed`: the launcher recorded a failure. `launched`: the routine was fired (or the runner reported in). `ambiguous`: a job was
// registered and its brief written, but whether the routine was fired is unknown; it is never retried automatically.
export type LaunchState = "launching" | "launched" | "failed" | "not-launched" | "ambiguous";
export type RunLink = {
  proposal: string;
  workSession: string;
  origin: Origin;
  attachment: Attachment;
  // A retry names the earlier job it repeats. The earlier job is not changed.
  retryOf?: string;
  confirmedAt: string;
  launch: { state: LaunchState; job?: string; at?: string; detail?: string; repairedAt?: string; repairBasis?: string };
};

type WorkFile = { v: number; sessions: unknown[]; links: unknown[] };

export type WorkBackend = { persisted: boolean; load(): WorkFile | undefined; save(file: WorkFile): void };

// The file backend. load(): undefined when the file does not exist; throws when it exists and is unreadable (never treated as empty).
export function workFile(dir: string | undefined): WorkBackend {
  if (!dir) {
    let mem: WorkFile | undefined;
    return { persisted: false, load: () => (mem ? structuredClone(mem) : undefined), save: (f) => void (mem = structuredClone(f)) };
  }
  const file = join(dir, "work-sessions.json");
  return {
    persisted: true,
    load: () => {
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, "utf8")) as WorkFile;
    },
    save: (f) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.new`, JSON.stringify(f, null, 2));
      renameSync(`${file}.new`, file);
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validOrigin = (o: unknown): o is Origin => isObj(o) && ((o.basis === "server-turn" && isOriginId(o.session)) || (o.basis === "unknown" && o.session === null && typeof o.why === "string"));
const validSession = (s: unknown): s is WorkSession => isObj(s) && isWorkSessionId(s.id) && typeof s.createdAt === "string" && validOrigin(s.origin) && typeof s.createdBy === "string" && s.lifecycle === "open";
const LAUNCH_STATES: readonly string[] = ["launching", "launched", "failed", "not-launched", "ambiguous"];
const validLink = (l: unknown): l is RunLink =>
  isObj(l) && typeof l.proposal === "string" && isWorkSessionId(l.workSession) && validOrigin(l.origin) && ["new", "follow-up", "retry"].includes(l.attachment as string) && typeof l.confirmedAt === "string" && isObj(l.launch) && LAUNCH_STATES.includes(l.launch.state as string) && (l.launch.job === undefined || (typeof l.launch.job === "string" && JOB_ID.test(l.launch.job)));

export class WorkError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// What the confirm route may ask for besides a new work session: attach this launch to an existing one, as a follow-up or as a retry of
// one of its runs. Only the owner's confirmation request carries it; the model cannot set it.
export type AttachRequest = { workSession: string; as: "follow-up" | "retry"; retryOf?: string };
export type AttachPlan = { attachment: "new" } | { attachment: "follow-up" | "retry"; workSession: string; retryOf?: string };

// The job back-reference written on the job record at registration, in the same write: what lets a restart find the job a confirmation
// produced. Minimal: ids only.
export type JobWorkLink = { proposal: string; workSession: string; origin: string | null };

export type JobsReader = { all(): Job[]; health(job: Job): string };

export type WorkSessions = ReturnType<typeof workSessions>;

export function workSessions(backend: WorkBackend, now: () => Date = () => new Date()) {
  let file: WorkFile | undefined;
  let problem: string | undefined;

  // Lazy load. A missing file is an empty store; an unreadable or newer one is reported and never overwritten.
  const load = (): WorkFile => {
    if (file) return file;
    let raw: WorkFile | undefined;
    try {
      raw = backend.load();
    } catch (e) {
      problem = `the work-session file could not be read (${e instanceof Error ? e.name : "error"}); it is left as it is`;
      throw new WorkError(503, `Work sessions are unavailable: ${problem}.`);
    }
    if (raw === undefined) raw = { v: WORK_FILE_VERSION, sessions: [], links: [] };
    if (!isObj(raw) || typeof raw.v !== "number" || !Array.isArray(raw.sessions) || !Array.isArray(raw.links)) {
      problem = "the work-session file has an unknown shape; it is left as it is";
      throw new WorkError(503, `Work sessions are unavailable: ${problem}.`);
    }
    if (raw.v > WORK_FILE_VERSION) {
      problem = `the work-session file has schema version ${raw.v}, newer than this build understands (${WORK_FILE_VERSION}); it is left as it is`;
      throw new WorkError(503, `Work sessions are unavailable: ${problem}.`);
    }
    problem = undefined;
    file = raw;
    return file;
  };
  // Persist first, then change memory: a failed write leaves both as they were.
  const commit = (next: WorkFile) => {
    backend.save(next);
    file = next;
  };
  const sessions = () => load().sessions.filter(validSession);
  const links = () => load().links.filter(validLink);
  const session = (id: string) => sessions().find((s) => s.id === id);
  const linkOf = (proposal: string) => links().find((l) => l.proposal === proposal);

  const patchLink = (proposal: string, change: (l: RunLink) => RunLink) => {
    const f = load();
    commit({ ...f, links: f.links.map((l) => (validLink(l) && l.proposal === proposal ? change(l) : l)) });
  };

  // The state a link's launch is in, derived from the job record without writing anything.
  // `settled`: nothing can be in flight (reconcile runs at start, or after the launcher returned). Otherwise a `launching` link whose job
  // shows no result yet is still `launching`: it may be in progress.
  const evidence = (l: RunLink, job: Job | undefined, settled = false): { state: LaunchState; basis: string } => {
    if (!job) {
      if (l.launch.job) return { state: l.launch.state, basis: "the job is not in the job store (it keeps the newest 200); the recorded state is shown" };
      return { state: l.launch.state, basis: l.launch.state === "launching" ? "recorded before the launch began; no job is recorded yet (in progress, or ORBIT stopped before it registered one)" : "recorded state" };
    }
    // The runner's own events outrank a recorded fire failure: a fire whose answer was lost can still start a runner (src/launch-evidence.ts).
    if (job.events.length) return { state: "launched", basis: "the runner reported to the job record" };
    if (job.launch?.failedAt) return { state: "failed", basis: "the job record has a launch failure" };
    if (job.launch?.sessionId || job.events.length) return { state: "launched", basis: job.events.length ? "the runner reported to the job record" : "the routine accepted the fire (the job record has its cloud session)" };
    if (!settled && l.launch.state === "launching") return { state: "launching", basis: "the job is registered and has no launch result yet (in progress, or ORBIT stopped before recording it; a restart reconciles it)" };
    if (job.launch?.briefCommit) return { state: "ambiguous", basis: "the brief was written but the job record holds no fire result: whether the routine was fired is unknown" };
    return { state: "not-launched", basis: "the job was registered but its brief was never recorded, so the routine was never fired" };
  };

  return {
    get persisted() {
      return backend.persisted;
    },
    problem: () => problem,
    // Throws WorkError 503 when the store cannot be read.
    check(): void {
      load();
    },
    sessions,
    links,
    session,
    linkOf,
    linksOf: (workSession: string) => links().filter((l) => l.workSession === workSession),
    linksFrom: (origin: string) => links().filter((l) => l.origin.session === origin),
    linkOfJob: (job: string) => links().find((l) => l.launch.job === job),
    evidence,

    // Validates an attachment against this store (and, for a retry, the job store) before anything is spent. Throws WorkError.
    // Rules: the work session exists and is open; the confirmation's origin is known and is the work session's own origin (no link is
    // ever made across conversations); a retry names a job that is a run of that work session and has ended (failed or blocked).
    plan(attach: unknown, origin: Origin, jobs?: JobsReader): AttachPlan {
      if (attach === undefined || attach === null) return { attachment: "new" };
      if (!isObj(attach)) throw new WorkError(400, "attach must be an object {workSession, as, retryOf?}.");
      const extra = Object.keys(attach).filter((k) => !["workSession", "as", "retryOf"].includes(k));
      if (extra.length) throw new WorkError(400, "attach accepts only workSession, as and retryOf.");
      if (!isWorkSessionId(attach.workSession)) throw new WorkError(400, "attach.workSession must be a work session id (work:<uuid>).");
      if (attach.as !== "follow-up" && attach.as !== "retry") throw new WorkError(400, "attach.as must be follow-up or retry.");
      if (attach.as === "follow-up" && attach.retryOf !== undefined) throw new WorkError(400, "retryOf is only for attach.as retry.");
      if (attach.as === "retry" && (typeof attach.retryOf !== "string" || !JOB_ID.test(attach.retryOf))) throw new WorkError(400, "A retry needs retryOf: the job id of the run it repeats.");
      // Cross-session links are refused before the job store is read.
      const ws = session(attach.workSession);
      const refused = "That work session cannot take this launch: it does not exist, or it was not started from the conversation this proposal was made in. Nothing was done; the proposal is still open.";
      if (!ws || ws.lifecycle !== "open") throw new WorkError(409, refused);
      if (origin.session === null || ws.origin.session !== origin.session) throw new WorkError(409, refused);
      if (attach.as === "retry") {
        const prior = links().find((l) => l.workSession === ws.id && l.launch.job === attach.retryOf);
        if (!prior) throw new WorkError(409, "retryOf is not a run of that work session. Nothing was done; the proposal is still open.");
        let job: Job | undefined;
        try {
          job = jobs?.all().find((j) => j.id === attach.retryOf);
        } catch {
          throw new WorkError(503, "The job store could not be read, so whether that run has ended is unknown. Nothing was done; the proposal is still open.");
        }
        const ended = job ? job.state === "failed" || job.state === "blocked" || Boolean(job.launch?.failedAt) : prior.launch.state === "failed" || prior.launch.state === "not-launched";
        if (!ended) throw new WorkError(409, "Only a run that failed or is blocked can be retried; that run has not ended that way (or its state is unknown). Nothing was done; the proposal is still open.");
        return { attachment: "retry", workSession: ws.id, retryOf: attach.retryOf as string };
      }
      return { attachment: "follow-up", workSession: ws.id };
    },

    // Records a confirmation before its launch begins: a new work session (or the planned existing one) and a `launching` link, in one
    // write. Throws (nothing recorded) if the proposal already has a link or the write fails.
    begin(proposal: string, origin: Origin, plan: AttachPlan): RunLink {
      const f = load();
      if (linkOf(proposal)) throw new WorkError(409, "This proposal was already recorded. Nothing was done again.");
      const at = now().toISOString();
      let ws: WorkSession | undefined;
      if (plan.attachment === "new") ws = { id: workSessionId(randomUUID()), createdAt: at, origin, createdBy: proposal, lifecycle: "open" };
      else {
        const existing = session(plan.workSession);
        if (!existing || origin.session === null || existing.origin.session !== origin.session) throw new WorkError(409, "That work session cannot take this launch.");
      }
      const link: RunLink = { proposal, workSession: ws?.id ?? (plan as { workSession: string }).workSession, origin, attachment: plan.attachment, ...(plan.attachment === "retry" && plan.retryOf ? { retryOf: plan.retryOf } : {}), confirmedAt: at, launch: { state: "launching", at } };
      commit({ v: Math.max(f.v, WORK_FILE_VERSION), sessions: ws ? [...f.sessions, ws] : f.sessions, links: [...f.links, link] });
      return link;
    },

    // Records what the launcher returned. A thrown launcher (the outcome is not known) is recorded by the caller as `ambiguous` only after
    // reconcile() has looked at the job store.
    settle(proposal: string, result: { code: number; body: unknown }): RunLink | undefined {
      const b = (result.body ?? {}) as { id?: unknown; job?: { id?: unknown }; error?: unknown };
      const job = typeof b.id === "string" ? b.id : typeof b.job?.id === "string" ? b.job.id : undefined;
      const error = typeof b.error === "string" ? b.error.slice(0, 300) : undefined;
      const state: LaunchState = result.code < 300 && job ? "launched" : job ? "failed" : "not-launched";
      patchLink(proposal, (l) => ({ ...l, launch: { state, ...(job && JOB_ID.test(job) ? { job } : {}), at: now().toISOString(), ...(error ? { detail: error } : {}) } }));
      return linkOf(proposal);
    },

    // Repairs link metadata from the job store's own records: links still `launching` (ORBIT stopped, or the result could not be written)
    // or `ambiguous`. Reads native records; writes only this store's links; never launches, retries, approves or changes a job. Returns
    // what it changed. Without a readable job store nothing is changed.
    reconcile(jobs: JobsReader | undefined, only?: string): RunLink[] {
      if (!jobs) return [];
      let all: Job[];
      try {
        all = jobs.all();
      } catch {
        return [];
      }
      const changed: RunLink[] = [];
      for (const l of links()) {
        if (only !== undefined && l.proposal !== only) continue;
        if (l.launch.state !== "launching" && l.launch.state !== "ambiguous") continue;
        const job = all.find((j) => j.work?.proposal === l.proposal) ?? (l.launch.job ? all.find((j) => j.id === l.launch.job) : undefined);
        let next: RunLink["launch"];
        if (!job) {
          if (l.launch.state === "ambiguous") continue;
          // The job is registered (one atomic write that carries this link) before any external step, so no job means nothing was sent.
          next = { state: "not-launched", at: now().toISOString(), detail: "No job was registered for this confirmation before ORBIT stopped or the launch failed, so nothing was sent to a runner.", repairedAt: now().toISOString(), repairBasis: "job store has no job for this proposal" };
        } else {
          const e = evidence(l, job, true);
          if (e.state === l.launch.state && l.launch.job === job.id) continue;
          next = { state: e.state, job: job.id, at: l.launch.at, ...(e.state === "ambiguous" ? { detail: "The brief was written but whether the routine was fired is unknown. It is not retried automatically: check the job (it reports in if it started) and retry explicitly if it did not." } : job.launch?.error ? { detail: job.launch.error.slice(0, 300) } : {}), repairedAt: now().toISOString(), repairBasis: e.basis };
        }
        patchLink(l.proposal, (x) => ({ ...x, launch: next }));
        changed.push(linkOf(l.proposal)!);
      }
      return changed;
    },

    status() {
      try {
        load();
        return { state: "live" as const, persisted: backend.persisted, sessions: sessions().length, links: links().length };
      } catch {
        return { state: "unavailable" as const, persisted: backend.persisted, detail: problem ?? "unreadable" };
      }
    },
  };
}

// ---- derived views (read only) ----------------------------------------------------------------------------------------------

export type RunNative = { status: "found"; state: Job["state"]; health: string; createdAt: string; lastEventAt: string | null; routine: string | null } | { status: "not-in-job-store" | "unavailable" | "no-job"; detail: string };

export type RunView = {
  id: string | null;
  proposal: string;
  attachment: Attachment;
  retryOf?: string;
  confirmedAt: string;
  launch: { recorded: LaunchState; observed: LaunchState; basis: string; detail?: string; repairedAt?: string };
  native: RunNative;
};

export type WorkActivity = { state: "pending" | "active" | "no-active-run" | "unknown"; basis: string; counts: { runs: number; pending: number; active: number; ended: number; notLaunched: number; unknown: number } };

export const GOAL_NOTE = "ORBIT does not track whether this work's goal is finished: a run that ended (done, failed or blocked) does not close the work session.";

// One run reference built from a link and the job store read (`byId` absent: the job store could not be read).
export function runView(work: Pick<WorkSessions, "evidence">, l: RunLink, byId: Map<string, Job> | undefined, problem: string | undefined, health: (j: Job) => string): RunView {
  const job = l.launch.job ? byId?.get(l.launch.job) : undefined;
  const native: RunNative = !l.launch.job
    ? { status: "no-job", detail: l.launch.state === "launching" ? "No job is recorded for this confirmation yet." : "This confirmation produced no job." }
    : job
      ? { status: "found", state: job.state, health: health(job), createdAt: job.createdAt, lastEventAt: job.lastEventAt ?? null, routine: job.launch?.routine ?? null }
      : byId
        ? { status: "not-in-job-store", detail: "The job store does not hold this job (it keeps the newest 200); its state is unknown." }
        : { status: "unavailable", detail: problem ?? "the job store could not be read" };
  const e = byId ? work.evidence(l, job) : { state: l.launch.state, basis: "the job store could not be read; the recorded state is shown" };
  return {
    id: l.launch.job ? `job:${l.launch.job}` : null,
    proposal: l.proposal,
    attachment: l.attachment,
    ...(l.retryOf ? { retryOf: `job:${l.retryOf}` } : {}),
    confirmedAt: l.confirmedAt,
    launch: { recorded: l.launch.state, observed: e.state, basis: e.basis, ...(l.launch.detail ? { detail: l.launch.detail } : {}), ...(l.launch.repairedAt ? { repairedAt: l.launch.repairedAt } : {}) },
    native,
  };
}

// The work session's activity, derived from its runs' native states. Unknown evidence is never read as "no activity", and ended runs
// are never read as success.
export function workActivity(runs: RunView[]): WorkActivity {
  const counts = { runs: runs.length, pending: 0, active: 0, ended: 0, notLaunched: 0, unknown: 0 };
  for (const r of runs) {
    if (r.native.status === "found") {
      if (r.launch.observed === "failed" || r.native.health === "launch-failed") counts.ended++;
      else if (r.launch.observed === "launching") counts.pending++;
      else if (r.launch.observed === "not-launched") counts.notLaunched++;
      else if (r.native.state === "registered" || r.native.state === "running") {
        if (r.launch.observed === "ambiguous") counts.unknown++;
        else counts.active++;
      } else counts.ended++;
    } else if (r.native.status === "no-job") {
      if (r.launch.observed === "launching") counts.pending++;
      else counts.notLaunched++;
    } else counts.unknown++;
  }
  const state: WorkActivity["state"] = counts.active ? "active" : counts.pending ? "pending" : counts.unknown ? "unknown" : "no-active-run";
  const basis =
    state === "active"
      ? "at least one run is registered or running in the job store"
      : state === "pending"
        ? "a confirmation is being launched (or ORBIT stopped before recording its result); no run is known to be active"
        : state === "unknown"
          ? "no run is known to be active, but the state of at least one run is unknown (not in the job store, job store unavailable, or launch outcome ambiguous)"
          : "no run is active; every run ended or never launched. This is not a claim that the work is finished.";
  return { state, basis, counts };
}
