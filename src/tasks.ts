import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskContent } from "./threads.ts";

// Supervised tasks (docs/adr/0003-supervised-tasks.md), first slice.
//
// A task is a durable record of a piece of work Rai wants done: a goal, its scope and acceptance criteria, a lifecycle, the next action,
// a follow-up intent, versioned instructions with their provenance, requests the task made to the Assistant, and evidence references.
// It is NOT a conversation, NOT a job run and NOT a claim of completion:
// - the task's conversation is an ordinary chat thread (its "task session", `chat:<uuid>`), linked by id and opened in Sessions;
// - a job the task needed is an ORBIT job (`job:<id>`) launched only through the existing owner-confirmed proposal flow;
// - completion is a lifecycle change Rai makes, refused until every acceptance criterion has acceptable evidence.
//
// Task ids are `task-<uuid>` (no colon): they are not session ids, so the session registry's reserved `task` kind is untouched.
//
// Persistence: one JSON file, `<state>/tasks.json`, loaded lazily, written atomically (write `.new`, rename) BEFORE the in-memory copy
// changes, so a failed write changes nothing. Records this build does not understand are kept untouched. A file that cannot be read, or
// has a newer schema version, makes the store unavailable and is never overwritten.
//
// Concurrency: ORBIT is one process and every mutation here is synchronous, so mutations never interleave. Every change bumps `rev`.
// Mutations made for a person or the Assistant carry the `rev` they were based on and are refused (409) when it is stale; the task's own
// turn writes (requests, evidence, next action) are not rev-checked but are refused when the task is no longer active.

export const TASK_FILE_VERSION = 1;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TASK_ID = new RegExp(`^task-${UUID}$`);
const THREAD_ID = new RegExp(`^${UUID}$`);
export const isTaskId = (s: unknown): s is string => typeof s === "string" && TASK_ID.test(s);

// Bounds. Text is masked for credential shapes (the conversation stores' filter) and cut to these lengths when stored.
export const TASK_TITLE_MAX = 100;
export const TASK_GOAL_MAX = 4000;
export const TASK_SCOPE_MAX = 2000;
export const TASK_CRITERIA_MAX = 10;
export const TASK_CRITERION_MAX = 500;
export const TASK_INSTRUCTION_MAX = 4000;
export const TASK_INSTRUCTIONS_MAX = 200;
export const TASK_REQUEST_TEXT_MAX = 2000;
export const TASK_BRIEF_MAX = 12000;
export const TASK_REQUESTS_MAX = 100;
// Requests waiting on the supervisor at once. A task that keeps asking is stopped here rather than flooding the Assistant.
export const TASK_OPEN_REQUESTS_MAX = 5;
export const TASK_EVIDENCE_MAX = 100;
export const TASK_REF_MAX = 300;
export const TASK_NOTE_MAX = 1000;
export const TASK_TURNS_KEPT = 50;
export const TASK_IDEMPOTENCY_KEPT = 50;
export const TASKS_MAX = 500;
// A second identical create (same title and goal) within this window returns the first task instead of making another.
export const TASK_CREATE_DEDUPE_MS = 10 * 60 * 1000;
export const PROJECT_REF_MAX = 200;
export const VAULT_PATH_MAX = 200;

// Who made a change. Never taken from model text: the server fills it from the route or turn that made the change.
// - human: Rai, through an owner-authenticated route (`via`: the page or section that sent it).
// - assistant: the Assistant model, in an owner turn of the Assistant; `userMessage` is the message of Rai's that turn answered.
//   Its text was written by the model (for example a steer relaying what Rai asked), so it is labeled as the Assistant's, not Rai's.
// - task: the task's own model turn `turn`.
// - orbit: ORBIT's own code (restart recovery, sync bookkeeping).
export type Provenance =
  | { actor: "human"; via: "task-panel" | "sessions-ui" | "api"; message?: string }
  | { actor: "assistant"; via: "assistant-tool"; userMessage?: string; replyMessage?: string }
  | { actor: "task"; via: "task-turn"; turn: number }
  | { actor: "orbit"; via: "system" };

export type Lifecycle = "active" | "paused" | "done" | "cancelled";
export const TERMINAL: readonly Lifecycle[] = ["done", "cancelled"];

export type Criterion = { id: string; text: string };
export type Instruction = { v: number; at: string; text: string; by: Provenance };
export type RequestKind = "clarification" | "blocker" | "job";
// What the supervisor did with a request. Job requests go further than this: once a launch proposal is linked, whether it was confirmed,
// is running or produced a result is DERIVED from the proposal card and the job store at observation time, never stored here.
export type RequestState = "pending" | "answered" | "proposed" | "declined" | "withdrawn";
export type TaskRequest = {
  id: string;
  kind: RequestKind;
  text: string;
  // Deduplication key: a hash of the kind, the normalized text and (job requests) the brief.
  key: string;
  createdAt: string;
  by: Provenance;
  job?: { routine?: string; brief: string };
  state: RequestState;
  // Identical requests filed again while this one existed: counted, never recorded twice.
  duplicates?: number;
  lastDuplicateAt?: string;
  response?: { at: string; by: Provenance; text?: string };
  // The launch proposal the Assistant made for a job request (verified by the server to be an open job_launch proposal made in the
  // Assistant). Earlier links whose proposals expired, were cancelled or refused are kept in `previous`.
  proposal?: { id: string; linkedAt: string; by: Provenance };
  previous?: { id: string; linkedAt: string; endedAs: string }[];
};
export type EvidenceKind = "job" | "commit" | "pull-request" | "url" | "vault-note" | "note";
export type Evidence = { id: string; criterion: string; kind: EvidenceKind; ref: string; note?: string; at: string; by: Provenance };
export type TurnState = "running" | "done" | "error" | "interrupted";
export type TurnRecord = {
  n: number;
  startedAt: string;
  endedAt?: string;
  state: TurnState;
  trigger: Provenance;
  // The newest instruction version the turn was given. Instructions added after it started are not seen by it.
  instructionsSeen: number;
  // The model port the turn ran on (its `impl` string at the time), recorded, never chosen here.
  model: string;
  // The thread messages of this turn (the supervisor's prompt and the task's reply), when it started a reply.
  message?: string;
  reply?: string;
  error?: string;
  toolCalls?: number;
};
export type VaultSyncState = "never" | "synced" | "failed" | "blocked";
export type VaultLink = {
  // A note Rai linked to this task (vault-relative, under Projects/ or Tasks/). ORBIT never creates it.
  note: string;
  // The heading in that note ORBIT appends status lines under. It must already exist exactly once; ORBIT never adds headings.
  heading: string;
  sync: {
    state: VaultSyncState;
    // The content key of the last status line written (or found already written), for idempotency.
    syncedKey?: string;
    commit?: string;
    attempts: number;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    // There is no automatic retry in this slice: a failed sync stays failed until someone asks again.
    retry: "manual";
  };
};

export type Task = {
  id: string;
  createdAt: string;
  updatedAt: string;
  rev: number;
  title: string;
  goal: string;
  scope?: string;
  acceptance: Criterion[];
  // A free reference to the project this task belongs to (a repository name or a vault project note path). Not resolved.
  project?: string;
  lifecycle: Lifecycle;
  lifecycleHistory: { at: string; from: Lifecycle; to: Lifecycle; by: Provenance; reason?: string }[];
  nextAction?: { text: string; at: string; by: Provenance };
  // Follow-up intent only. Nothing wakes a task up in this slice (`autonomous: "disabled"`); the due time is shown to the supervisor.
  followUp?: { at: string; note?: string; setAt: string; by: Provenance; autonomous: "disabled" };
  // The task session: a chat thread created for this task.
  session: { thread: string };
  createdBy: Provenance;
  instructions: Instruction[];
  requests: TaskRequest[];
  evidence: Evidence[];
  turns: TurnRecord[];
  // Turn numbers are never reused, even when old turn records are dropped.
  turnSeq: number;
  vault?: VaultLink;
  // Idempotency keys of recent owner requests (steer, run-turn), so a repeated POST changes nothing.
  seen?: string[];
  completedAt?: string;
};

type TaskFile = { v: number; tasks: unknown[] };
export type TaskBackend = { persisted: boolean; load(): TaskFile | undefined; save(file: TaskFile): void };

export function taskFile(dir: string | undefined): TaskBackend {
  if (!dir) {
    let mem: TaskFile | undefined;
    return { persisted: false, load: () => (mem ? structuredClone(mem) : undefined), save: (f) => void (mem = structuredClone(f)) };
  }
  const file = join(dir, "tasks.json");
  return {
    persisted: true,
    load: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as TaskFile) : undefined),
    save: (f) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.new`, JSON.stringify(f, null, 2));
      renameSync(`${file}.new`, file);
    },
  };
}

export class TaskError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LIFECYCLES: readonly string[] = ["active", "paused", "done", "cancelled"];
const validTask = (t: unknown): t is Task =>
  isObj(t) && isTaskId(t.id) && typeof t.rev === "number" && typeof t.title === "string" && typeof t.goal === "string" && Array.isArray(t.acceptance) && LIFECYCLES.includes(t.lifecycle as string) && isObj(t.session) && typeof t.session.thread === "string" && THREAD_ID.test(t.session.thread) && Array.isArray(t.instructions) && Array.isArray(t.requests) && Array.isArray(t.evidence) && Array.isArray(t.turns);

// Stored text: one credential-shape mask (the conversation stores' filter), control characters other than line breaks removed, trimmed, cut.
export const cleanText = (s: unknown, max: number): string =>
  typeof s === "string"
    ? maskContent(s)
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
        .trim()
        .slice(0, max)
    : "";
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const requestKey = (kind: string, text: string, brief?: string): string =>
  createHash("sha256").update(`${kind}\n${oneLine(text).toLowerCase()}\n${brief ? oneLine(brief).toLowerCase() : ""}`).digest("hex").slice(0, 16);

// A vault note a task may sync to: a Markdown note under Projects/ or Tasks/, a plain relative path. The vault pipeline checks the path
// again (src/vault/edit.ts validatePath) and classifies the write; this is only the first, narrower filter.
const VAULT_NOTE = /^(?:Projects|Tasks)\/(?:[A-Za-z0-9 ._()&,'+-]+\/){0,3}[A-Za-z0-9 ._()&,'+-]+\.md$/;
export const isTaskVaultNote = (p: unknown): p is string => typeof p === "string" && p.length <= VAULT_PATH_MAX && VAULT_NOTE.test(p) && !p.split("/").some((s) => s.startsWith(".") || s.startsWith("-") || s === "..");
const HEADING = /^#{2,4} [^\n#]{1,80}$/;
export const isTaskHeading = (h: unknown): h is string => typeof h === "string" && HEADING.test(h);

export type CreateInput = { title: unknown; goal: unknown; scope?: unknown; acceptance: unknown; project?: unknown; vaultNote?: unknown; vaultHeading?: unknown; followUpAt?: unknown; followUpNote?: unknown };
export type ParsedCreate = { title: string; goal: string; scope?: string; acceptance: Criterion[]; project?: string; vault?: { note: string; heading: string }; followUp?: { at: string; note?: string } };

export function parseCreate(input: CreateInput, now: Date): ParsedCreate {
  const title = cleanText(input.title, TASK_TITLE_MAX);
  const goal = cleanText(input.goal, TASK_GOAL_MAX);
  if (!title) throw new TaskError(400, "A task needs a title (1-100 characters).");
  if (!goal) throw new TaskError(400, "A task needs a goal: what should be true when it is done.");
  if (!Array.isArray(input.acceptance) || input.acceptance.length === 0 || input.acceptance.length > TASK_CRITERIA_MAX) throw new TaskError(400, `A task needs 1-${TASK_CRITERIA_MAX} acceptance criteria: checkable statements of done.`);
  const acceptance = input.acceptance.map((c, i) => ({ id: `ac${i + 1}`, text: cleanText(c, TASK_CRITERION_MAX) }));
  if (acceptance.some((c) => !c.text)) throw new TaskError(400, "Every acceptance criterion needs text.");
  const scope = input.scope === undefined || input.scope === null ? undefined : cleanText(input.scope, TASK_SCOPE_MAX) || undefined;
  const project = input.project === undefined || input.project === null ? undefined : cleanText(input.project, PROJECT_REF_MAX) || undefined;
  let vault: ParsedCreate["vault"];
  if (input.vaultNote !== undefined && input.vaultNote !== null) {
    if (!isTaskVaultNote(input.vaultNote)) throw new TaskError(400, "vaultNote must be an existing Markdown note under Projects/ or Tasks/ (for example Tasks/example.md).");
    if (!isTaskHeading(input.vaultHeading)) throw new TaskError(400, "vaultHeading must be a heading that already exists in that note, written exactly (for example \"## Status\"). ORBIT never adds headings.");
    vault = { note: input.vaultNote, heading: input.vaultHeading };
  }
  const followUp = parseFollowUp(input.followUpAt, input.followUpNote, now);
  return { title, goal, ...(scope ? { scope } : {}), acceptance, ...(project ? { project } : {}), ...(vault ? { vault } : {}), ...(followUp ? { followUp } : {}) };
}

// A follow-up time is intent only: ISO time, not in the past, within a year. null/undefined: none.
export function parseFollowUp(at: unknown, note: unknown, now: Date): { at: string; note?: string } | undefined {
  if (at === undefined || at === null || at === "") return undefined;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) throw new TaskError(400, "followUpAt must be an ISO 8601 time, for example 2026-11-21T09:00:00Z.");
  if (t < now.getTime() - 60_000 || t > now.getTime() + 366 * 86_400_000) throw new TaskError(400, "followUpAt must be in the next 366 days.");
  const n = cleanText(note, TASK_NOTE_MAX);
  return { at: new Date(t).toISOString(), ...(n ? { note: n } : {}) };
}

// ---- derived views ----------------------------------------------------------------------------------------------------

// What a linked launch proposal became, from the proposal store and its card (src/server.ts provides it). `confirmed` with a job id
// is then followed into the job store.
export type ProposalObservation = { state: "awaiting-confirmation" | "confirmed" | "expired" | "cancelled" | "refused" | "unknown"; job?: string; detail?: string };
export type JobObservation = { found: true; state: string; health?: string } | { found: false; why: string };
export type Observers = { proposal(id: string): ProposalObservation; job(id: string): JobObservation };

// The explicit status of a request, at observation time. For job requests:
//   pending (waiting for the Assistant) -> awaiting-confirmation (a launch card waits for Rai) -> confirmed (Rai confirmed; job registered)
//   -> running (the job store says registered/running) -> result (the job store says done/failed/blocked; NOT task completion)
//   or not-confirmed (the card expired, was cancelled or refused), declined (by the supervisor), withdrawn.
export type RequestStatus = "pending" | "answered" | "declined" | "withdrawn" | "awaiting-confirmation" | "confirmed" | "running" | "result" | "not-confirmed" | "unknown";
export function requestStatus(r: TaskRequest, obs: Observers): { status: RequestStatus; job?: string; jobState?: string; detail?: string } {
  if (r.kind !== "job" || r.state !== "proposed" || !r.proposal) return { status: r.state === "proposed" ? "unknown" : r.state };
  const p = obs.proposal(r.proposal.id);
  if (p.state === "awaiting-confirmation") return { status: "awaiting-confirmation" };
  if (p.state === "expired" || p.state === "cancelled" || p.state === "refused") return { status: "not-confirmed", detail: `the launch proposal was ${p.state}${p.detail ? `: ${p.detail}` : ""}` };
  if (p.state !== "confirmed") return { status: "unknown", detail: p.detail ?? "the launch proposal's record could not be found" };
  if (!p.job) return { status: "confirmed", detail: "confirmed; no job id is recorded on the card yet" };
  const j = obs.job(p.job);
  if (!j.found) return { status: "confirmed", job: p.job, detail: `job state unknown: ${j.why}` };
  if (j.state === "registered" || j.state === "running") return { status: "running", job: p.job, jobState: j.state };
  return { status: "result", job: p.job, jobState: j.state, detail: "the job ended; this is the run's result, not task completion" };
}

// Evidence status. Only two kinds count toward completion:
// - attested: added by Rai himself (human provenance);
// - verified: a job evidence whose job the job store shows `done` AND that this task's own request produced (its request's proposal
//   card names that job), so the chain from the task to the run is ORBIT's own record, not a model's claim.
// Everything else a model added is `claimed`: shown, never enough.
export type EvidenceStatus = "attested" | "verified" | "claimed" | "not-verified";
export function evidenceStatus(task: Task, e: Evidence, obs: Observers): { status: EvidenceStatus; detail: string } {
  if (e.by.actor === "human") return { status: "attested", detail: "added by Rai" };
  if (e.kind === "job") {
    const ours = task.requests.some((r) => r.kind === "job" && r.proposal && obs.proposal(r.proposal.id).job === e.ref);
    if (!ours) return { status: "claimed", detail: "this job was not produced by one of this task's own requests, so the link is a model's claim" };
    const j = obs.job(e.ref);
    if (!j.found) return { status: "not-verified", detail: `the job's state is unknown (${j.why})` };
    return j.state === "done" ? { status: "verified", detail: "the job store shows this task's job done" } : { status: "not-verified", detail: `the job store shows the job ${j.state}` };
  }
  return { status: "claimed", detail: `added by ${e.by.actor === "assistant" ? "the Assistant" : e.by.actor === "task" ? "the task's model" : "ORBIT"}; not verified by ORBIT` };
}

export type Readiness = { ready: boolean; criteria: { id: string; text: string; satisfiedBy: string[]; evidence: { id: string; status: EvidenceStatus }[] }[]; missing: string[] };
export function readiness(task: Task, obs: Observers): Readiness {
  const criteria = task.acceptance.map((c) => {
    const evidence = task.evidence.filter((e) => e.criterion === c.id).map((e) => ({ id: e.id, status: evidenceStatus(task, e, obs).status }));
    return { id: c.id, text: c.text, evidence, satisfiedBy: evidence.filter((e) => e.status === "attested" || e.status === "verified").map((e) => e.id) };
  });
  const missing = criteria.filter((c) => !c.satisfiedBy.length).map((c) => c.id);
  return { ready: missing.length === 0, criteria, missing };
}

export const currentInstructionVersion = (t: Task) => t.instructions.at(-1)?.v ?? 0;
// Instructions the task's model has not been given yet: newer than what its latest turn saw.
export function unseenInstructions(t: Task): Instruction[] {
  const seen = t.turns.at(-1)?.instructionsSeen ?? 0;
  return t.instructions.filter((i) => i.v > seen);
}
export const openRequests = (t: Task) => t.requests.filter((r) => r.state === "pending");
export const runningTurn = (t: Task) => t.turns.find((x) => x.state === "running");
export function blockerOf(t: Task): { request: string; text: string } | undefined {
  const b = [...t.requests].reverse().find((r) => r.kind === "blocker" && r.state === "pending");
  return b ? { request: b.id, text: b.text } : undefined;
}

// ---- the store --------------------------------------------------------------------------------------------------------

export type Tasks = ReturnType<typeof taskStore>;

export function taskStore(backend: TaskBackend, now: () => Date = () => new Date()) {
  let file: TaskFile | undefined;
  let problem: string | undefined;
  let recovered = false;

  const load = (): TaskFile => {
    if (file) return file;
    let raw: TaskFile | undefined;
    try {
      raw = backend.load();
    } catch (e) {
      problem = `the task file could not be read (${e instanceof Error ? e.name : "error"}); it is left as it is`;
      throw new TaskError(503, `Tasks are unavailable: ${problem}.`);
    }
    if (raw === undefined) raw = { v: TASK_FILE_VERSION, tasks: [] };
    if (!isObj(raw) || typeof raw.v !== "number" || !Array.isArray(raw.tasks)) {
      problem = "the task file has an unknown shape; it is left as it is";
      throw new TaskError(503, `Tasks are unavailable: ${problem}.`);
    }
    if (raw.v > TASK_FILE_VERSION) {
      problem = `the task file has schema version ${raw.v}, newer than this build understands (${TASK_FILE_VERSION}); it is left as it is`;
      throw new TaskError(503, `Tasks are unavailable: ${problem}.`);
    }
    problem = undefined;
    file = raw;
    return file;
  };
  // Persist first, then change memory.
  const commit = (next: TaskFile) => {
    backend.save(next);
    file = next;
  };
  const all = (): Task[] => load().tasks.filter(validTask);
  const get = (id: string): Task | undefined => (isTaskId(id) ? all().find((t) => t.id === id) : undefined);

  // One change to one task: copy, apply, bump rev, write the file, then swap the copy in. `expectRev`: the rev the caller's view was
  // based on; a different current rev is a stale mutation (409) and nothing changes. `bump: false` is for ORBIT's own bookkeeping that
  // is not task content (vault sync state), so it does not make a person's or the Assistant's view stale.
  function change<R>(id: string, o: { expectRev?: number; bump?: boolean; allowTerminal?: boolean }, fn: (t: Task) => R): { task: Task; result: R } {
    const f = load();
    const cur = get(id);
    if (!cur) throw new TaskError(404, "No task with that id.");
    if (o.expectRev !== undefined && o.expectRev !== cur.rev) throw new TaskError(409, `stale: this task changed since rev ${o.expectRev} (it is at rev ${cur.rev}). Nothing was changed; inspect it again and retry with the current rev.`);
    if (!o.allowTerminal && TERMINAL.includes(cur.lifecycle)) throw new TaskError(409, `This task is ${cur.lifecycle}. Nothing was changed.`);
    const t = structuredClone(cur);
    const result = fn(t);
    if (o.bump !== false) {
      t.rev = cur.rev + 1;
      t.updatedAt = now().toISOString();
    }
    commit({ ...f, tasks: f.tasks.map((x) => (validTask(x) && x.id === id ? t : x)) });
    return { task: structuredClone(t), result };
  }
  const requireRev = (rev: unknown): number => {
    if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1) throw new TaskError(400, "rev is required: the task's current rev from tasks_list or task_inspect, so a change based on an old view is refused.");
    return rev;
  };
  // An owner request id seen before on this task: the same POST again changes nothing.
  const seenBefore = (t: Task, key: string | undefined) => Boolean(key && t.seen?.includes(key));
  const remember = (t: Task, key: string | undefined) => {
    if (!key) return;
    t.seen = [...(t.seen ?? []), key].slice(-TASK_IDEMPOTENCY_KEPT);
  };

  // Restart recovery, once per load: a turn recorded as running was cut off by the stop. It is marked interrupted (never re-run).
  function recover(): string[] {
    if (recovered) return [];
    recovered = true;
    const f = load();
    const hit = all().filter((t) => t.turns.some((x) => x.state === "running"));
    if (!hit.length) return [];
    const at = now().toISOString();
    const ids = new Set(hit.map((t) => t.id));
    commit({
      ...f,
      tasks: f.tasks.map((x) => (validTask(x) && ids.has(x.id) ? { ...x, rev: x.rev + 1, updatedAt: at, turns: x.turns.map((r) => (r.state === "running" ? { ...r, state: "interrupted" as const, endedAt: at, error: "ORBIT stopped while this turn was running. It was not re-run." } : r)) } : x)),
    });
    return [...ids];
  }

  return {
    get persisted() {
      return backend.persisted;
    },
    status(): { state: "live" | "unavailable"; persisted: boolean; detail: string } {
      try {
        const n = all().length;
        return { state: "live", persisted: backend.persisted, detail: `${n} task(s)${backend.persisted ? "" : " (memory only: a restart empties it)"}` };
      } catch (e) {
        return { state: "unavailable", persisted: backend.persisted, detail: e instanceof Error ? e.message : "unavailable" };
      }
    },
    problem: () => problem,
    requireRev,
    recover,
    all: () => all().map((t) => structuredClone(t)),
    get: (id: string) => {
      const t = get(id);
      return t ? structuredClone(t) : undefined;
    },
    byThread: (threadId: string) => {
      const t = all().find((x) => x.session.thread === threadId);
      return t ? structuredClone(t) : undefined;
    },

    // A new task linked to a thread the caller already created for it. Idempotent for a repeated identical create (same title and goal)
    // within TASK_CREATE_DEDUPE_MS: the earlier task is returned and nothing new is made. `thread` is created only when needed.
    create(input: ParsedCreate, by: Provenance, thread: () => string): { task: Task; duplicate: boolean } {
      const f = load();
      const at = now();
      const same = all().find((t) => t.title === input.title && t.goal === input.goal && !TERMINAL.includes(t.lifecycle) && at.getTime() - Date.parse(t.createdAt) < TASK_CREATE_DEDUPE_MS);
      if (same) return { task: structuredClone(same), duplicate: true };
      if (all().filter((t) => !TERMINAL.includes(t.lifecycle)).length >= TASKS_MAX) throw new TaskError(409, `There are already ${TASKS_MAX} open tasks. Finish or cancel some first.`);
      const iso = at.toISOString();
      const task: Task = {
        id: `task-${randomUUID()}`,
        createdAt: iso,
        updatedAt: iso,
        rev: 1,
        title: input.title,
        goal: input.goal,
        ...(input.scope ? { scope: input.scope } : {}),
        acceptance: input.acceptance,
        ...(input.project ? { project: input.project } : {}),
        lifecycle: "active",
        lifecycleHistory: [],
        ...(input.followUp ? { followUp: { ...input.followUp, setAt: iso, by, autonomous: "disabled" as const } } : {}),
        session: { thread: thread() },
        createdBy: by,
        instructions: [],
        requests: [],
        evidence: [],
        turns: [],
        turnSeq: 0,
        ...(input.vault ? { vault: { ...input.vault, sync: { state: "never" as const, attempts: 0, retry: "manual" as const } } } : {}),
      };
      commit({ ...f, tasks: [...f.tasks, task] });
      return { task: structuredClone(task), duplicate: false };
    },

    // A new version of the task's instructions, appended (earlier versions are kept). `key`: an owner request id for idempotency.
    steer(id: string, expectRev: number | undefined, text: unknown, by: Provenance, key?: string): { task: Task; instruction: Instruction; duplicate: boolean } {
      const clean = cleanText(text, TASK_INSTRUCTION_MAX);
      if (!clean) throw new TaskError(400, "A steer needs text.");
      const existing = get(id);
      if (existing && seenBefore(existing, key)) {
        const inst = existing.instructions.find((i) => i.text === clean) ?? existing.instructions.at(-1)!;
        return { task: structuredClone(existing), instruction: inst, duplicate: true };
      }
      const { task, result } = change(id, { expectRev }, (t) => {
        if (t.instructions.length >= TASK_INSTRUCTIONS_MAX) throw new TaskError(409, `This task already has ${TASK_INSTRUCTIONS_MAX} instruction versions.`);
        const inst: Instruction = { v: currentInstructionVersion(t) + 1, at: now().toISOString(), text: clean, by };
        t.instructions.push(inst);
        remember(t, key);
        return inst;
      });
      return { task, instruction: result, duplicate: false };
    },

    setLifecycle(id: string, expectRev: number, to: "active" | "paused" | "cancelled", by: Provenance, reason?: unknown): Task {
      return change(id, { expectRev }, (t) => {
        const from = t.lifecycle;
        if (from === to) throw new TaskError(409, `This task is already ${to}.`);
        if (to === "cancelled" && by.actor !== "human") throw new TaskError(403, "Only Rai can cancel a task.");
        const r = cleanText(reason, TASK_NOTE_MAX);
        t.lifecycle = to;
        t.lifecycleHistory.push({ at: now().toISOString(), from, to, by, ...(r ? { reason: r } : {}) });
      }).task;
    },

    // Rai marks the task done. Refused unless every acceptance criterion has attested or verified evidence (readiness), and only for a
    // human: no model, tool, job result or turn can complete a task.
    complete(id: string, expectRev: number, by: Provenance, obs: Observers): Task {
      if (by.actor !== "human") throw new TaskError(403, "Only Rai can mark a task done.");
      return change(id, { expectRev }, (t) => {
        if (runningTurn(t)) throw new TaskError(409, "A task turn is running. Wait for it to end (or pause the task) before marking it done.");
        const r = readiness(t, obs);
        if (!r.ready) throw new TaskError(409, `Not done: acceptance criteria without attested or verified evidence: ${r.missing.join(", ")}. A model saying it is done, or a job ending, is not evidence of acceptance.`);
        const from = t.lifecycle;
        t.lifecycle = "done";
        t.completedAt = now().toISOString();
        t.lifecycleHistory.push({ at: t.completedAt, from, to: "done", by, reason: `acceptance evidence: ${r.criteria.map((c) => `${c.id}=${c.satisfiedBy.join("+")}`).join(", ")}` });
      }).task;
    },

    update(id: string, expectRev: number, patch: { nextAction?: unknown; followUpAt?: unknown; followUpNote?: unknown; project?: unknown; vaultNote?: unknown; vaultHeading?: unknown }, by: Provenance): Task {
      return change(id, { expectRev }, (t) => {
        const at = now().toISOString();
        if (patch.nextAction !== undefined) {
          const n = cleanText(patch.nextAction, TASK_NOTE_MAX);
          if (n) t.nextAction = { text: n, at, by };
          else delete t.nextAction;
        }
        if (patch.followUpAt !== undefined) {
          const f = parseFollowUp(patch.followUpAt, patch.followUpNote, now());
          if (f) t.followUp = { ...f, setAt: at, by, autonomous: "disabled" };
          else delete t.followUp;
        }
        if (patch.project !== undefined) {
          const p = cleanText(patch.project, PROJECT_REF_MAX);
          if (p) t.project = p;
          else delete t.project;
        }
        if (patch.vaultNote !== undefined) {
          if (patch.vaultNote === null || patch.vaultNote === "") delete t.vault;
          else {
            if (!isTaskVaultNote(patch.vaultNote)) throw new TaskError(400, "vaultNote must be an existing Markdown note under Projects/ or Tasks/.");
            if (!isTaskHeading(patch.vaultHeading)) throw new TaskError(400, "vaultHeading must be a heading that already exists in that note, written exactly (for example \"## Status\").");
            t.vault = { note: patch.vaultNote, heading: patch.vaultHeading, sync: { state: "never", attempts: 0, retry: "manual" } };
          }
        }
      }).task;
    },

    // ---- the task's own turn ----

    // Starts a turn record. Refused unless the task is active and no turn of it is running: a task's turns are serialized.
    beginTurn(id: string, expectRev: number | undefined, trigger: Provenance, model: string, key?: string): { task: Task; turn: TurnRecord; duplicate: boolean } {
      const existing = get(id);
      if (existing && seenBefore(existing, key)) return { task: structuredClone(existing), turn: existing.turns.at(-1)!, duplicate: true };
      const { task, result } = change(id, { expectRev }, (t) => {
        if (t.lifecycle !== "active") throw new TaskError(409, `This task is ${t.lifecycle}: no turn is started.`);
        if (runningTurn(t)) throw new TaskError(409, "A turn of this task is already running. Turns of one task run one at a time.");
        t.turnSeq = (t.turnSeq ?? t.turns.length) + 1;
        const turn: TurnRecord = { n: t.turnSeq, startedAt: now().toISOString(), state: "running", trigger, instructionsSeen: currentInstructionVersion(t), model };
        t.turns = [...t.turns, turn].slice(-TASK_TURNS_KEPT);
        remember(t, key);
        return turn;
      });
      return { task, turn: result, duplicate: false };
    },
    endTurn(id: string, n: number, outcome: { state: "done" | "error"; message?: string; reply?: string; error?: string; toolCalls?: number }): Task {
      return change(id, { allowTerminal: true }, (t) => {
        const turn = t.turns.find((x) => x.n === n);
        if (!turn || turn.state !== "running") return;
        Object.assign(turn, { state: outcome.state, endedAt: now().toISOString(), ...(outcome.message ? { message: outcome.message } : {}), ...(outcome.reply ? { reply: outcome.reply } : {}), ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}), ...(outcome.toolCalls !== undefined ? { toolCalls: outcome.toolCalls } : {}) });
      }).task;
    },

    // A request from the task to its supervisor. Deduplicated by key: an identical request that already exists (in any state but
    // withdrawn) is returned with `duplicate: true` and counted, never filed twice, so a task repeating itself cannot flood the Assistant.
    fileRequest(id: string, input: { kind: unknown; text: unknown; routine?: unknown; brief?: unknown }, by: Provenance): { task: Task; request: TaskRequest; duplicate: boolean } {
      const kind = input.kind;
      if (kind !== "clarification" && kind !== "blocker" && kind !== "job") throw new TaskError(400, "kind must be clarification, blocker or job.");
      const text = cleanText(input.text, TASK_REQUEST_TEXT_MAX);
      if (!text) throw new TaskError(400, "A request needs text saying what is needed and why.");
      let job: TaskRequest["job"];
      if (kind === "job") {
        const brief = cleanText(input.brief, TASK_BRIEF_MAX);
        if (!brief) throw new TaskError(400, "A job request needs a brief: what the job should do. The Assistant decides whether to propose it; Rai confirms any launch.");
        const routine = cleanText(input.routine, 64) || undefined;
        job = { brief, ...(routine ? { routine } : {}) };
      }
      const key = requestKey(kind, text, job?.brief);
      const { task, result } = change(id, {}, (t) => {
        if (t.lifecycle !== "active") throw new TaskError(409, `This task is ${t.lifecycle}: it cannot file requests.`);
        const same = t.requests.find((r) => r.key === key && r.state !== "withdrawn");
        if (same) {
          same.duplicates = (same.duplicates ?? 0) + 1;
          same.lastDuplicateAt = now().toISOString();
          return { request: structuredClone(same), duplicate: true };
        }
        if (openRequests(t).length >= TASK_OPEN_REQUESTS_MAX) throw new TaskError(429, `This task already has ${TASK_OPEN_REQUESTS_MAX} requests waiting for the Assistant. Wait for answers before asking more.`);
        if (t.requests.length >= TASK_REQUESTS_MAX) throw new TaskError(409, `This task has filed ${TASK_REQUESTS_MAX} requests; no more are accepted.`);
        const r: TaskRequest = { id: `req-${t.requests.length + 1}`, kind, text, key, createdAt: now().toISOString(), by, ...(job ? { job } : {}), state: "pending" };
        t.requests.push(r);
        return { request: structuredClone(r), duplicate: false };
      });
      return { task, ...result };
    },

    // The supervisor's (or Rai's) answer to a request. `link`: the launch proposal the Assistant made for a job request; the caller
    // (src/task-supervisor.ts) has already verified it is an open job_launch proposal made in the Assistant.
    respond(id: string, expectRev: number, requestId: unknown, action: "answer" | "decline" | "withdraw" | "link", by: Provenance, data: { text?: unknown; proposal?: string; observe?: (pid: string) => ProposalObservation }): { task: Task; request: TaskRequest } {
      const { task, result } = change(id, { expectRev }, (t) => {
        const r = t.requests.find((x) => x.id === requestId);
        if (!r) throw new TaskError(404, "No request with that id on this task.");
        const at = now().toISOString();
        const text = cleanText(data.text, TASK_REQUEST_TEXT_MAX) || undefined;
        if (action === "link") {
          if (r.kind !== "job") throw new TaskError(400, "Only a job request can be linked to a launch proposal.");
          if (!data.proposal) throw new TaskError(400, "A proposal id is required.");
          if (t.requests.some((x) => x.proposal?.id === data.proposal)) throw new TaskError(409, "That proposal is already linked to a request.");
          if (r.state === "proposed" && r.proposal) {
            const before = data.observe?.(r.proposal.id);
            if (!before || before.state === "awaiting-confirmation" || before.state === "confirmed" || before.state === "unknown") throw new TaskError(409, `This request already has a launch proposal that is ${before?.state ?? "unknown"}. Nothing was changed.`);
            r.previous = [...(r.previous ?? []), { id: r.proposal.id, linkedAt: r.proposal.linkedAt, endedAs: before.state }];
          } else if (r.state !== "pending") throw new TaskError(409, `This request is ${r.state}. Nothing was changed.`);
          r.state = "proposed";
          r.proposal = { id: data.proposal, linkedAt: at, by };
          r.response = { at, by, ...(text ? { text } : {}) };
          return structuredClone(r);
        }
        if (r.state !== "pending") throw new TaskError(409, `This request is ${r.state}. Nothing was changed.`);
        if (action === "answer") {
          if (r.kind === "job") throw new TaskError(400, "A job request is answered by linking a launch proposal (which Rai confirms) or declined.");
          if (!text) throw new TaskError(400, "An answer needs text.");
          r.state = "answered";
        } else if (action === "decline") r.state = "declined";
        else {
          if (by.actor !== "task" && by.actor !== "human") throw new TaskError(403, "Only the task itself or Rai can withdraw a request.");
          r.state = "withdrawn";
        }
        r.response = { at, by, ...(text ? { text } : {}) };
        return structuredClone(r);
      });
      return { task, request: result };
    },

    addEvidence(id: string, input: { criterion: unknown; kind: unknown; ref: unknown; note?: unknown }, by: Provenance, expectRev?: number): { task: Task; evidence: Evidence; duplicate: boolean } {
      const kinds: readonly string[] = ["job", "commit", "pull-request", "url", "vault-note", "note"];
      if (!kinds.includes(input.kind as string)) throw new TaskError(400, `kind must be one of ${kinds.join(", ")}.`);
      const ref = cleanText(input.ref, TASK_REF_MAX);
      if (!ref) throw new TaskError(400, "Evidence needs a reference (a job id, commit, URL, note path or a short description).");
      const note = cleanText(input.note, TASK_NOTE_MAX) || undefined;
      const { task, result } = change(id, { expectRev }, (t) => {
        if (by.actor === "task" && t.lifecycle !== "active") throw new TaskError(409, `This task is ${t.lifecycle}: it cannot record evidence.`);
        if (!t.acceptance.some((c) => c.id === input.criterion)) throw new TaskError(400, `criterion must be one of ${t.acceptance.map((c) => c.id).join(", ")}.`);
        const same = t.evidence.find((e) => e.criterion === input.criterion && e.kind === input.kind && e.ref === ref && e.by.actor === by.actor);
        if (same) return { evidence: structuredClone(same), duplicate: true };
        if (t.evidence.length >= TASK_EVIDENCE_MAX) throw new TaskError(409, `This task already has ${TASK_EVIDENCE_MAX} evidence references.`);
        const e: Evidence = { id: `ev-${t.evidence.length + 1}`, criterion: input.criterion as string, kind: input.kind as EvidenceKind, ref, ...(note ? { note } : {}), at: now().toISOString(), by };
        t.evidence.push(e);
        return { evidence: structuredClone(e), duplicate: false };
      });
      return { task, ...result };
    },

    // The next action, as the task's own turn states it (rev-free: it is the task's own record; refused when the task is not active).
    setNextAction(id: string, text: unknown, by: Provenance): Task {
      const n = cleanText(text, TASK_NOTE_MAX);
      if (!n) throw new TaskError(400, "A next action needs text.");
      return change(id, {}, (t) => {
        if (by.actor === "task" && t.lifecycle !== "active") throw new TaskError(409, `This task is ${t.lifecycle}.`);
        t.nextAction = { text: n, at: now().toISOString(), by };
      }).task;
    },

    // ORBIT's bookkeeping of the vault sync. Does not bump rev (it is not task content), so it never makes a view stale.
    recordSync(id: string, patch: Partial<VaultLink["sync"]>): Task {
      return change(id, { bump: false, allowTerminal: true }, (t) => {
        if (!t.vault) return;
        t.vault.sync = { ...t.vault.sync, ...patch };
      }).task;
    },
  };
}
