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

// Version 2 (this repair): owner idempotency records are namespaced by operation and carry their payload digest (`idem`); proposal links
// carry an immutable binding to the request's brief; turn records may count photos. A version 1 file is read and migrated in memory
// (its `seen` keys are kept as legacy keys that are refused, never guessed); the file is written as version 2 at the next change, so an
// older build then refuses it (newer schema) instead of misreading it.
export const TASK_FILE_VERSION = 2;
const TASK_FILE_VERSIONS_READ = [1, 2];
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
  // The launch proposal linked to a job request (verified by the server to be an open job_launch proposal made in the Assistant, and
  // bound to this request: `binding`). Earlier links whose proposals expired, were cancelled or refused are kept in `previous`; their ids
  // stay reserved, so no other request can ever take them. A link without `binding` was made by an earlier build (legacy): it is shown,
  // but ORBIT never treats a job from it as verified, since what the proposal launched was not compared with this request.
  proposal?: { id: string; linkedAt: string; by: Provenance; binding?: ProposalBinding };
  previous?: { id: string; linkedAt: string; endedAs: string; binding?: ProposalBinding }[];
};
// What ORBIT checked when it linked a proposal to a request, copied from the proposal store at that moment and never changed after.
// - match "exact": the proposal's routine and brief are the request's (whitespace-normalized brief text, same routine when the request
//   named one).
// - match "accepted-by-rai": the briefs differ and Rai himself linked it, naming the proposal brief's digest he compared.
export type ProposalBinding = { kind: "job_launch"; routine: string; briefSha256: string; requestBriefSha256: string; origin: string; proposedAt: string; requestKey: string; match: "exact" | "accepted-by-rai" };
// The proposal as the proposal store has it, for linking (src/server.ts reads it; the task store never sees the proposal store itself).
export type LinkableProposal = { id: string; kind: "job_launch"; routine: string; brief: string; origin: string; createdAt: string };
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
  // Photos Rai sent with the message that started an interactive turn (a photo-only message records a turn but no instruction).
  photos?: number;
};
// "unknown": the vault pipeline could not confirm whether the line reached the remote (a push that may or may not have landed). Never
// reported as saved; the next sync finds the line by its key if it did land.
export type VaultSyncState = "never" | "synced" | "failed" | "blocked" | "unknown";
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
  // The highest instruction version ever given out (Repair 2). Instruction versions are never reused, even when an admission that
  // could not be stored is undone, so a turn's `instructionsSeen` and an idempotency record never point at a different text later.
  // Absent in older records: the newest version on record is used.
  instructionSeq?: number;
  vault?: VaultLink;
  // Owner request ids already handled (steer, run-turn), per operation, with the payload they came with and what they produced, so a
  // repeated POST returns the same result and changes nothing, and a reused id with another payload is refused.
  idem?: IdemRecord[];
  // Version 1 kept request ids without saying which operation they were for. Kept (never extended): such an id is refused if reused.
  seen?: string[];
  completedAt?: string;
};

export type IdemOp = "steer" | "turn";
export type IdemRecord = { op: IdemOp; key: string; digest: string; at: string; instruction?: number; turn?: number };

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
// `proposal`: the proposal the job store says this job was launched from (its work link, written at registration from the confirmed
// card); absent for a job launched any other way, or registered before work links existed.
export type JobObservation = { found: true; state: string; health?: string; proposal?: string } | { found: false; why: string };
// `links`: how many requests (across all tasks, current or earlier links) name a proposal id; more than one is an ambiguous legacy record.
export type Observers = { proposal(id: string): ProposalObservation; job(id: string): JobObservation; links?(proposalId: string): number };

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

// Evidence has two separate questions, answered separately:
// - Acceptance (`status`): does this evidence count toward a criterion? Only Rai's own attestation does (`attested`). Everything a
//   model added is `claimed`: shown, never enough. A job that ran is NOT proof that an arbitrary criterion passed, so no job result,
//   however well verified, satisfies a criterion by itself; Rai attests it (he may cite the job).
// - Execution (`execution`, job evidence only): did ORBIT's own records show that this task's request launched this job, and how did
//   it end? `verified` only when a request of this task holds a bound link (the brief was compared at link time) to a proposal that no
//   other request ever claimed, the job store's work link names that same proposal, and the job is `done`. Anything less is said
//   exactly: `not-done`, `unlinked` (no request of this task produced it), `legacy-unbound` (linked by an earlier build without a
//   binding), `ambiguous` (the proposal is linked to more than one request), `unknown` (the job's state cannot be read).
export type EvidenceStatus = "attested" | "claimed";
export type ExecutionState = "verified" | "not-done" | "unlinked" | "legacy-unbound" | "ambiguous" | "unknown";
export type ExecutionCheck = { state: ExecutionState; request?: string; jobState?: string; detail: string };
export function executionOf(task: Task, jobId: string, obs: Observers): ExecutionCheck {
  const j = obs.job(jobId);
  const viaJob = j.found ? j.proposal : undefined;
  const r = task.requests.find((x) => x.kind === "job" && x.proposal && (x.proposal.id === viaJob || (!viaJob && obs.proposal(x.proposal.id).job === jobId)));
  if (!r || !r.proposal) return { state: "unlinked", detail: "no request of this task produced this job (ORBIT's job record does not name one of this task's linked proposals)" };
  if (!r.proposal.binding) return { state: "legacy-unbound", request: r.id, detail: "this request's proposal was linked by an earlier build that did not compare the proposal with the request, so ORBIT does not treat the job as this request's" };
  if ((obs.links?.(r.proposal.id) ?? 1) > 1) return { state: "ambiguous", request: r.id, detail: "the proposal is linked to more than one request, so the job cannot be attributed to this one" };
  if (!j.found) return { state: "unknown", request: r.id, detail: `the job's record cannot be read (${j.why})` };
  if (j.proposal !== r.proposal.id) return { state: "unknown", request: r.id, detail: "the job store does not record which proposal launched this job, so the link from this request to it is not ORBIT's own record" };
  if (j.state !== "done") return { state: "not-done", request: r.id, jobState: j.state, detail: `ORBIT's records link this job to ${r.id}; the job store shows it ${j.state}` };
  return { state: "verified", request: r.id, jobState: j.state, detail: `ORBIT's records show ${r.id} launched this job (bound proposal, confirmed by Rai) and the job store shows it done. This says the job ran, not that any criterion is met.` };
}
export function evidenceStatus(task: Task, e: Evidence, obs: Observers): { status: EvidenceStatus; detail: string; execution?: ExecutionCheck } {
  const execution = e.kind === "job" ? executionOf(task, e.ref, obs) : undefined;
  const ex = execution ? { execution } : {};
  if (e.by.actor === "human") return { status: "attested", detail: "attested by Rai", ...ex };
  return { status: "claimed", detail: `added by ${e.by.actor === "assistant" ? "the Assistant" : e.by.actor === "task" ? "the task's model" : "ORBIT"}; only Rai's attestation counts toward a criterion`, ...ex };
}

export type Readiness = { ready: boolean; criteria: { id: string; text: string; satisfiedBy: string[]; evidence: { id: string; status: EvidenceStatus; execution?: ExecutionState }[] }[]; missing: string[] };
export function readiness(task: Task, obs: Observers): Readiness {
  const criteria = task.acceptance.map((c) => {
    const evidence = task.evidence.filter((e) => e.criterion === c.id).map((e) => {
      const s = evidenceStatus(task, e, obs);
      return { id: e.id, status: s.status, ...(s.execution ? { execution: s.execution.state } : {}) };
    });
    return { id: c.id, text: c.text, evidence, satisfiedBy: evidence.filter((e) => e.status === "attested").map((e) => e.id) };
  });
  const missing = criteria.filter((c) => !c.satisfiedBy.length).map((c) => c.id);
  return { ready: missing.length === 0, criteria, missing };
}

// The binding of a proposal to a job request (see ProposalBinding). Refuses a proposal for another routine or another brief, unless Rai
// himself names the digest of the different brief he compared.
const briefDigest = (b: string) => createHash("sha256").update(oneLine(b)).digest("hex");
function bind(r: TaskRequest, p: LinkableProposal, by: Provenance, accept: unknown): ProposalBinding {
  if (p.kind !== "job_launch") throw new TaskError(409, "Not linked: that proposal is not a job launch. Nothing was changed.");
  if (r.job!.routine && r.job!.routine !== p.routine) throw new TaskError(409, `Not linked: the request asked for routine ${r.job!.routine}; the proposal launches ${p.routine}. Nothing was changed.`);
  const requestBriefSha256 = briefDigest(r.job!.brief);
  const briefSha256 = briefDigest(cleanText(p.brief, Number.MAX_SAFE_INTEGER));
  const base = { kind: "job_launch" as const, routine: p.routine, briefSha256, requestBriefSha256, origin: p.origin, proposedAt: p.createdAt, requestKey: r.key };
  if (briefSha256 === requestBriefSha256) return { ...base, match: "exact" };
  if (by.actor === "human" && accept === briefSha256) return { ...base, match: "accepted-by-rai" };
  throw new TaskError(
    409,
    `Not linked: the proposal's brief is not this request's brief (request ${requestBriefSha256.slice(0, 12)}, proposal ${briefSha256.slice(0, 12)}). Propose the launch with the request's exact brief, or decline the request and say why.${by.actor === "human" ? ` To link it anyway after comparing the two, send acceptBriefSha256: "${briefSha256}".` : " Only Rai can link a proposal whose brief differs."} Nothing was changed.`,
  );
}

export const currentInstructionVersion = (t: Task) => t.instructions.at(-1)?.v ?? 0;
// The version a new instruction gets: one above any version ever given out on this task (never reused; see `instructionSeq`).
const nextInstructionVersion = (t: Task) => Math.max(t.instructionSeq ?? 0, currentInstructionVersion(t)) + 1;
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
    // Three different refusals (Repair 2), each leaving the file as it is: a version that is not a positive whole number is malformed
    // (not "newer"); a higher one is a newer schema; a lower one this build does not read is unsupported.
    if (!Number.isSafeInteger(raw.v) || raw.v < 1) {
      problem = `the task file's schema version (${JSON.stringify(raw.v).slice(0, 20)}) is not a valid version number, so the file is malformed or damaged; it is left as it is`;
      throw new TaskError(503, `Tasks are unavailable: ${problem}.`);
    }
    if (raw.v > TASK_FILE_VERSION) {
      problem = `the task file has schema version ${raw.v}, newer than this build understands (${TASK_FILE_VERSION}); it is left as it is`;
      throw new TaskError(503, `Tasks are unavailable: ${problem}.`);
    }
    if (!TASK_FILE_VERSIONS_READ.includes(raw.v)) {
      problem = `the task file has schema version ${raw.v}, which this build does not read (it reads ${TASK_FILE_VERSIONS_READ.join(", ")}); it is left as it is`;
      throw new TaskError(503, `Tasks are unavailable: ${problem}.`);
    }
    problem = undefined;
    file = raw;
    return file;
  };
  // Persist first, then change memory. Always written at the current version (a version 1 file is migrated by its first change).
  const commit = (next: TaskFile) => {
    const out = { ...next, v: TASK_FILE_VERSION };
    backend.save(out);
    file = out;
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
  // Owner request ids (idempotency), namespaced by operation. `prior` answers a repeat: the record when this id was used for this
  // operation with the same payload; 409 when it was used with another payload, or by version 1 (which did not record the operation).
  const digestOf = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 32);
  function prior(t: Task, op: IdemOp, key: string | undefined, digest: string): IdemRecord | undefined {
    if (!key) return undefined;
    const r = t.idem?.find((x) => x.op === op && x.key === key);
    if (r) {
      if (r.digest !== digest) throw new TaskError(409, `This requestId was already used for a different ${op} on this task. Nothing was changed; use a new requestId for a new request.`);
      return r;
    }
    if (t.seen?.includes(key)) throw new TaskError(409, "This requestId was used on this task by an earlier ORBIT build, which did not record what it was for, so a repeat cannot be answered safely. Nothing was changed; use a new requestId.");
    return undefined;
  }
  const remember = (t: Task, op: IdemOp, key: string | undefined, digest: string, result: { instruction?: number; turn?: number }) => {
    if (!key) return;
    t.idem = [...(t.idem ?? []), { op, key, digest, at: now().toISOString(), ...result }].slice(-TASK_IDEMPOTENCY_KEPT);
  };
  // The turn an earlier identical owner request started, or undefined when this request is new. 409 for a reused id with another rev.
  // Repair 2: when that turn's record is no longer kept (only the newest TASK_TURNS_KEPT are), its outcome is not known here, so the
  // repeat is refused (409, `expired`) with the turn number; nothing is started and no state is made up for it.
  function priorTurn(id: string, expectRev: number | undefined, key?: string): { task: Task; turn: TurnRecord } | undefined {
    const existing = get(id);
    if (!existing) return undefined;
    const again = prior(existing, "turn", key, digestOf({ rev: expectRev ?? null }));
    if (!again || again.turn === undefined) return undefined;
    const turn = existing.turns.find((x) => x.n === again.turn);
    if (!turn) throw new TaskError(409, `This requestId already started turn ${again.turn} of this task (at ${again.at}), whose record is no longer kept (only the newest ${TASK_TURNS_KEPT} are), so its outcome is unknown here (expired). Nothing was started; use a new requestId to start another turn.`);
    return { task: structuredClone(existing), turn: structuredClone(turn) };
  }
  // Every link (current or previous) to a proposal id across all tasks: a proposal answers at most one request, ever.
  function linksOf(pid: string): { task: string; request: string; current: boolean }[] {
    const out: { task: string; request: string; current: boolean }[] = [];
    for (const t of all())
      for (const r of t.requests) {
        if (r.proposal?.id === pid) out.push({ task: t.id, request: r.id, current: true });
        for (const p of r.previous ?? []) if (p.id === pid) out.push({ task: t.id, request: r.id, current: false });
      }
    return out;
  }

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
    priorTurn,
    // Every request (current or previous link) a proposal id was ever linked to, across all tasks.
    proposalLinks: (pid: string) => linksOf(pid),
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
    // A repeat of the same owner request (same `key`, same text and rev) returns the instruction it recorded, before any rev or
    // lifecycle check, and changes nothing.
    steer(id: string, expectRev: number | undefined, text: unknown, by: Provenance, key?: string): { task: Task; instruction: Instruction; duplicate: boolean } {
      const clean = cleanText(text, TASK_INSTRUCTION_MAX);
      if (!clean) throw new TaskError(400, "A steer needs text.");
      const digest = digestOf({ rev: expectRev ?? null, text: clean });
      const existing = get(id);
      const again = existing ? prior(existing, "steer", key, digest) : undefined;
      if (existing && again) {
        const inst = existing.instructions.find((i) => i.v === again.instruction);
        if (!inst) throw new TaskError(409, "This requestId was already used for a steer, but its instruction is no longer on record. Nothing was changed.");
        return { task: structuredClone(existing), instruction: structuredClone(inst), duplicate: true };
      }
      const { task, result } = change(id, { expectRev }, (t) => {
        if (t.instructions.length >= TASK_INSTRUCTIONS_MAX) throw new TaskError(409, `This task already has ${TASK_INSTRUCTIONS_MAX} instruction versions.`);
        const inst: Instruction = { v: nextInstructionVersion(t), at: now().toISOString(), text: clean, by };
        t.instructions.push(inst);
        t.instructionSeq = inst.v;
        remember(t, "steer", key, digest, { instruction: inst.v });
        return inst;
      });
      return { task, instruction: result, duplicate: false };
    },

    // Rai writing in the task's session (src/task-supervisor.ts humanTurn), admitted in ONE store change while the thread's reply lock is
    // held, so it is all or nothing:
    // - active: refused (409, nothing recorded) while a turn of this task runs; otherwise the text becomes instruction v(n+1) from Rai
    //   and a turn record starts that has seen it. A photo-only message starts the turn and records no instruction.
    // - paused: the text is recorded as instruction v(n+1) for when the task resumes; no turn starts. A photo-only message records nothing.
    // `expect` is the lifecycle the reply was prepared for; if the task changed meanwhile, nothing is recorded (409; send again).
    admitHuman(id: string, input: { text: string; photos: number }, by: Provenance, model: string, expect: "active" | "paused"): { task: Task; instruction?: Instruction; turn?: TurnRecord } {
      const clean = cleanText(input.text, TASK_INSTRUCTION_MAX);
      const cur = get(id);
      if (!cur) throw new TaskError(404, "No task with that id.");
      if (cur.lifecycle !== expect) throw new TaskError(409, `This task became ${cur.lifecycle} while your message was being prepared. Nothing was sent or recorded; send it again.`);
      if (expect === "paused" && !clean) return { task: structuredClone(cur) };
      const { task, result } = change(id, {}, (t) => {
        if (expect === "active") {
          const busy = runningTurn(t);
          if (busy) throw new TaskError(409, `Turn ${busy.n} of this task (started by ${busy.trigger.actor === "human" ? "Rai" : busy.trigger.actor === "assistant" ? "the Assistant" : "ORBIT"}) is running. Your message was not sent or recorded; send it again when the turn ends.`);
        }
        let instruction: Instruction | undefined;
        if (clean) {
          if (t.instructions.length >= TASK_INSTRUCTIONS_MAX) throw new TaskError(409, `This task already has ${TASK_INSTRUCTIONS_MAX} instruction versions. Nothing was sent or recorded.`);
          instruction = { v: nextInstructionVersion(t), at: now().toISOString(), text: clean, by };
          t.instructions.push(instruction);
          t.instructionSeq = instruction.v;
        }
        let turn: TurnRecord | undefined;
        if (expect === "active") {
          t.turnSeq = (t.turnSeq ?? t.turns.length) + 1;
          turn = { n: t.turnSeq, startedAt: now().toISOString(), state: "running", trigger: by, instructionsSeen: currentInstructionVersion(t), model, ...(input.photos ? { photos: input.photos } : {}) };
          t.turns = [...t.turns, turn].slice(-TASK_TURNS_KEPT);
        }
        return { instruction, turn };
      });
      return { task, ...(result.instruction ? { instruction: structuredClone(result.instruction) } : {}), ...(result.turn ? { turn: structuredClone(result.turn) } : {}) };
    },
    // Undoes an admission whose message could not be stored in the thread: the instruction it added is removed (it was never sent) and
    // its turn record ends as an error. Only the admission's own records are touched (Repair 2):
    // - the instruction is found by its identity (version, time and author, as admitHuman returned them), wherever it is: a steer the
    //   Assistant or the task panel recorded after it (while the turn code was still preparing) stays, with its own version;
    // - versions are never reused (`instructionSeq` keeps the removed one), so the next instruction does not take the removed number;
    // - the turn never ran, so it is recorded as having seen only what the turn before it saw (nothing is marked seen that was not sent).
    revertAdmission(id: string, a: { instruction?: number; instructionAt?: string; turn?: number }, reason: string): Task {
      return change(id, { allowTerminal: true }, (t) => {
        if (a.instruction !== undefined) {
          const i = t.instructions.findIndex((x) => x.v === a.instruction && x.by.actor === "human" && x.by.via === "sessions-ui" && (a.instructionAt === undefined || x.at === a.instructionAt));
          if (i >= 0) {
            t.instructionSeq = Math.max(t.instructionSeq ?? 0, currentInstructionVersion(t), a.instruction);
            t.instructions.splice(i, 1);
          }
        }
        const k = a.turn === undefined ? -1 : t.turns.findIndex((x) => x.n === a.turn);
        const turn = k >= 0 ? t.turns[k] : undefined;
        if (turn && turn.state === "running") Object.assign(turn, { state: "error", endedAt: now().toISOString(), error: `Not run: ${reason}`.slice(0, 500), instructionsSeen: k > 0 ? t.turns[k - 1]!.instructionsSeen : 0 });
      }).task;
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

    // Rai marks the task done. Refused unless every acceptance criterion has Rai's attested evidence (readiness), and only for a
    // human: no model, tool, job result or turn can complete a task.
    complete(id: string, expectRev: number, by: Provenance, obs: Observers): Task {
      if (by.actor !== "human") throw new TaskError(403, "Only Rai can mark a task done.");
      return change(id, { expectRev }, (t) => {
        if (runningTurn(t)) throw new TaskError(409, "A task turn is running. Wait for it to end (or pause the task) before marking it done.");
        const r = readiness(t, obs);
        if (!r.ready) throw new TaskError(409, `Not done: acceptance criteria without Rai's attestation: ${r.missing.join(", ")}. A model saying it is done, or a job ending (even one ORBIT verified ran), is not evidence that a criterion is met.`);
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
    // A repeat of the same owner request (same `key` and rev) returns the turn it started (by number), and starts nothing.
    beginTurn(id: string, expectRev: number | undefined, trigger: Provenance, model: string, key?: string): { task: Task; turn: TurnRecord; duplicate: boolean } {
      const again = priorTurn(id, expectRev, key);
      if (again) return { ...again, duplicate: true };
      const digest = digestOf({ rev: expectRev ?? null });
      const { task, result } = change(id, { expectRev }, (t) => {
        if (t.lifecycle !== "active") throw new TaskError(409, `This task is ${t.lifecycle}: no turn is started.`);
        if (runningTurn(t)) throw new TaskError(409, "A turn of this task is already running. Turns of one task run one at a time.");
        t.turnSeq = (t.turnSeq ?? t.turns.length) + 1;
        const turn: TurnRecord = { n: t.turnSeq, startedAt: now().toISOString(), state: "running", trigger, instructionsSeen: currentInstructionVersion(t), model };
        t.turns = [...t.turns, turn].slice(-TASK_TURNS_KEPT);
        remember(t, "turn", key, digest, { turn: turn.n });
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

    // The supervisor's (or Rai's) answer to a request. `link`: the launch proposal for a job request, as the proposal store has it; the
    // caller (src/task-supervisor.ts) has already checked it is an open job_launch proposal made in the Assistant. Here, in one store
    // change: the proposal must not be linked to any other request of any task (current or previous link: ids are never reused), and
    // its routine and brief must be the request's (or Rai, and only Rai, accepts a different brief by naming its digest). A repeat of the
    // same link is answered as a duplicate before the rev check, so a retried call changes nothing.
    respond(id: string, expectRev: number, requestId: unknown, action: "answer" | "decline" | "withdraw" | "link", by: Provenance, data: { text?: unknown; proposal?: LinkableProposal; acceptBriefSha256?: unknown; observe?: (pid: string) => ProposalObservation }): { task: Task; request: TaskRequest; duplicate?: boolean } {
      if (action === "link") {
        const p = data.proposal;
        if (!p || typeof p.id !== "string" || !p.id) throw new TaskError(400, "A proposal id is required.");
        const cur = get(id);
        const same = cur?.requests.find((x) => x.id === requestId);
        if (cur && same?.proposal?.id === p.id) return { task: structuredClone(cur), request: structuredClone(same), duplicate: true };
        const elsewhere = linksOf(p.id);
        if (elsewhere.length) {
          const w = elsewhere[0]!;
          throw new TaskError(409, `Not linked: that proposal is already linked to ${w.task === id ? "" : `task ${w.task} `}request ${w.request}${w.current ? "" : " (as an earlier link)"}. A proposal answers one request only. Nothing was changed.`);
        }
      }
      const { task, result } = change(id, { expectRev }, (t) => {
        const r = t.requests.find((x) => x.id === requestId);
        if (!r) throw new TaskError(404, "No request with that id on this task.");
        const at = now().toISOString();
        const text = cleanText(data.text, TASK_REQUEST_TEXT_MAX) || undefined;
        if (action === "link") {
          const p = data.proposal!;
          if (r.kind !== "job" || !r.job) throw new TaskError(400, "Only a job request can be linked to a launch proposal.");
          if (linksOf(p.id).length) throw new TaskError(409, "Not linked: that proposal is already linked to a request. Nothing was changed.");
          const binding = bind(r, p, by, data.acceptBriefSha256);
          if (r.state === "proposed" && r.proposal) {
            const before = data.observe?.(r.proposal.id);
            if (!before || before.state === "awaiting-confirmation" || before.state === "confirmed" || before.state === "unknown") throw new TaskError(409, `This request already has a launch proposal that is ${before?.state ?? "unknown"}. Nothing was changed.`);
            r.previous = [...(r.previous ?? []), { id: r.proposal.id, linkedAt: r.proposal.linkedAt, endedAs: before.state, ...(r.proposal.binding ? { binding: r.proposal.binding } : {}) }];
          } else if (r.state !== "pending") throw new TaskError(409, `This request is ${r.state}. Nothing was changed.`);
          r.state = "proposed";
          r.proposal = { id: p.id, linkedAt: at, by, binding };
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
