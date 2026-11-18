import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./job-inputs.ts";
import { JOB_ID, type Job } from "./jobs.ts";
import { type DispatchState, type EvidenceContext, type LaunchOutcome, launchOutcome } from "./launch-evidence.ts";
import type { Notifier } from "./notify.ts";

// Owner reconciliation of a launch whose outcome ORBIT's own record cannot settle (docs/reviews/launch-reconciliation.md, section 9).
//
// src/launch-evidence.ts reads what ORBIT's job record proves. For an `unresolved` launch (dispatch-unknown or provider-accepted, no runner
// event) only the provider's own record can say whether a session ran, and the runner cannot read it. This module lets Rai record what
// they found there, or record a decision to stop tracking the launch, as an append-only audit log kept beside the job store:
//
//   - The job record is never changed. Its launch, events and dispatch reading stay exactly as they were (the immutable original evidence).
//     Each entry keeps a copy of what that record held when Rai confirmed it (`basedOn`).
//   - Only the owner, over an HTTP route, can add an entry, and only in two steps: a preview that states what the entry means and does
//     not mean and returns a digest, then a confirmation carrying that digest. The model has no tool for it.
//   - Provider evidence is Rai's report of what the provider showed. ORBIT does not verify it, and says so.
//   - Abandoning tracking is a separate kind. It never claims that a session was cancelled, never ran, or ended. It changes no gate:
//     the launch stays unresolved, and a retry stays refused.
//   - A runner event that arrives after an entry outranks it. The entry is kept, the reading changes to
//     `runner-evidence-after-reconciliation`, and ORBIT appends its own entry and tells Rai once.
//   - Nothing here launches, retries, cancels, steers or calls the provider.
//
// Persistence: one JSON file, `<state>/launch-reconciliations.json`, written atomically (write `.new`, rename) before memory changes. A
// file that exists but cannot be read, or has a newer schema version, makes the log unavailable: it is never overwritten.

export const RECON_FILE_VERSION = 1;
// Bounds: the log only grows, so it refuses new owner entries rather than dropping old ones.
export const MAX_ENTRIES_PER_JOB = 20;
export const MAX_ENTRIES = 2000;
export const REASON_MIN = 10;
export const REASON_MAX = 500;
// How far the checked window must reach past the launch time: a fire's session is created within seconds of the request.
export const WINDOW_AFTER_LAUNCH_MS = 60_000;
export const WINDOW_MAX_MS = 24 * 60 * 60_000;
export const CLOCK_SKEW_MS = 5 * 60_000;

// What the owner reports.
//   provider-no-run           Rai checked the Routine's run history for the launch window and found no run for this job: no session was created.
//   provider-session-ended    Rai found the session and it has ended. `output` says whether it pushed or produced any work.
//   provider-session-running  Rai found the session and it is still running (or could not see that it ended).
//   abandon-tracking          Rai stops tracking this launch without provider evidence. This is not a cancellation and not evidence of anything.
export type OwnerKind = "provider-no-run" | "provider-session-ended" | "provider-session-running" | "abandon-tracking";
export const OWNER_KINDS: readonly OwnerKind[] = ["provider-no-run", "provider-session-ended", "provider-session-running", "abandon-tracking"];
export type EvidenceSource = "routine-run-history" | "session-page";
export type SessionOutput = "none" | "pushed" | "unknown";

export type ProviderEvidence = { source: EvidenceSource; checkedAt: string; window?: { from: string; to: string }; sessionId?: string; output?: SessionOutput };
// What ORBIT's own record held when the entry was confirmed. Copied, never re-derived later.
export type BasedOn = { launchAt: string; routine: string; briefCommit?: string; sessionId?: string; dispatch: DispatchState; outcome: LaunchOutcome; events: number };

export type OwnerEntry = { seq: number; job: string; at: string; actor: "owner"; kind: OwnerKind; evidence?: ProviderEvidence; reason: string; digest: string; basedOn: BasedOn };
// ORBIT's own entry: the runner reported after an owner entry. One per owner entry at most.
export type LateEntry = { seq: number; job: string; at: string; actor: "orbit"; kind: "late-runner-evidence"; after: number; events: number; firstLateAt: string; firstLateType: string; contradicts: boolean };
export type Entry = OwnerEntry | LateEntry;

export type ReconciledState =
  | "none"
  | "provider-confirmed-no-run"
  | "provider-confirmed-ended"
  | "provider-confirmed-running"
  | "tracking-abandoned"
  | "runner-evidence-after-reconciliation";

export type ReconciliationView = {
  state: ReconciledState;
  basis: string;
  caveat?: string;
  // Whether the work-session retry gate may treat this launch as settled. Only provider evidence that no session ran, or that the session
  // ended without output, allows it, and only while the runner has said nothing since.
  retry: { allowed: boolean; basis: string };
  latest?: OwnerEntry;
  entries: Entry[];
  // Runner events recorded after the latest owner entry (they are never discarded; the job record holds them).
  lateEvents: number;
  // True when a late runner event contradicts the latest owner entry (it said no session ran, or the session ended).
  contradicted: boolean;
};

export class ReconcileError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type ReconFile = { v: number; entries: unknown[] };
export type ReconBackend = { persisted: boolean; load(): ReconFile | undefined; save(file: ReconFile): void };

// The file backend. load(): undefined when the file does not exist; throws when it exists and is unreadable (never treated as empty).
export function reconFile(dir: string | undefined): ReconBackend {
  if (!dir) {
    let mem: ReconFile | undefined;
    return { persisted: false, load: () => (mem ? structuredClone(mem) : undefined), save: (f) => void (mem = structuredClone(f)) };
  }
  const file = join(dir, "launch-reconciliations.json");
  return {
    persisted: true,
    load: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReconFile) : undefined),
    save: (f) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.new`, JSON.stringify(f, null, 2));
      renameSync(`${file}.new`, file);
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validEntry = (e: unknown): e is Entry =>
  isObj(e) && Number.isInteger(e.seq) && typeof e.job === "string" && JOB_ID.test(e.job) && typeof e.at === "string" &&
  ((e.actor === "owner" && OWNER_KINDS.includes(e.kind as OwnerKind) && typeof e.reason === "string" && typeof e.digest === "string" && isObj(e.basedOn)) ||
    (e.actor === "orbit" && e.kind === "late-runner-evidence" && Number.isInteger(e.after)));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
const SESSION_ID = /^[A-Za-z0-9_-]{6,128}$/;
// Control characters other than newline and tab are refused (terminal escapes, NULs).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const INPUT_KEYS = new Set(["kind", "source", "checkedAt", "windowFrom", "windowTo", "sessionId", "output", "reason", "confirm"]);

// What a request asks to record, normalized. Throws ReconcileError(400) on anything malformed. No field is free-form except `reason`.
export type OwnerRequest = { kind: OwnerKind; evidence?: ProviderEvidence; reason: string };
export function parseRequest(input: unknown): OwnerRequest {
  if (!isObj(input)) throw new ReconcileError(400, "The body must be a JSON object.");
  const extra = Object.keys(input).filter((k) => !INPUT_KEYS.has(k));
  if (extra.length) throw new ReconcileError(400, `Unknown field(s): ${extra.slice(0, 5).join(", ")}. Accepted: ${[...INPUT_KEYS].join(", ")}.`);
  const kind = input.kind as OwnerKind;
  if (typeof kind !== "string" || !OWNER_KINDS.includes(kind as OwnerKind)) throw new ReconcileError(400, `kind must be one of ${OWNER_KINDS.join(", ")}.`);
  if (typeof input.reason !== "string") throw new ReconcileError(400, "reason is required: say in a sentence what you checked or why you decide this.");
  const reason = input.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) throw new ReconcileError(400, `reason must be ${REASON_MIN} to ${REASON_MAX} characters.`);
  if (CONTROL.test(reason)) throw new ReconcileError(400, "reason must not contain control characters.");
  if (redactText(reason).count) throw new ReconcileError(400, "reason looks like it contains a credential or token. Nothing was recorded; describe the evidence without secrets.");
  const str = (k: string) => (input[k] === undefined ? undefined : typeof input[k] === "string" ? (input[k] as string).trim() : (() => { throw new ReconcileError(400, `${k} must be a string.`); })());
  const iso = (k: string) => {
    const v = str(k);
    if (v !== undefined && (!ISO.test(v) || Number.isNaN(Date.parse(v)))) throw new ReconcileError(400, `${k} must be a UTC ISO time such as 2026-11-18T01:19:00Z.`);
    return v;
  };
  const source = str("source"), checkedAt = iso("checkedAt"), from = iso("windowFrom"), to = iso("windowTo"), sessionId = str("sessionId"), output = str("output");

  if (kind === "abandon-tracking") {
    const given = ["source", "checkedAt", "windowFrom", "windowTo", "sessionId", "output"].filter((k) => input[k] !== undefined);
    if (given.length) throw new ReconcileError(400, `abandon-tracking records a decision, not provider evidence, so it takes no ${given.join(", ")}. To record what the provider showed, use a provider-* kind.`);
    return { kind, reason };
  }
  if (!checkedAt) throw new ReconcileError(400, "checkedAt is required: when you looked at the provider's record.");
  if (sessionId !== undefined && (!SESSION_ID.test(sessionId) || redactText(sessionId).count)) throw new ReconcileError(400, "sessionId must be the session's id as the provider shows it: 6 to 128 letters, digits, underscore or dash.");
  if (kind === "provider-no-run") {
    if (source !== "routine-run-history") throw new ReconcileError(400, "provider-no-run needs source routine-run-history: only the Routine's run history can show that no run was created.");
    if (!from || !to) throw new ReconcileError(400, "provider-no-run needs windowFrom and windowTo: the period of run history you checked.");
    if (sessionId !== undefined || output !== undefined) throw new ReconcileError(400, "provider-no-run takes no sessionId or output.");
    return { kind, reason, evidence: { source, checkedAt, window: { from, to } } };
  }
  if (source !== "routine-run-history" && source !== "session-page") throw new ReconcileError(400, "source must be routine-run-history or session-page.");
  if (!sessionId) throw new ReconcileError(400, `${kind} needs sessionId: the id of the session you found.`);
  if (from !== undefined || to !== undefined) throw new ReconcileError(400, "windowFrom and windowTo are only for provider-no-run.");
  if (kind === "provider-session-ended") {
    if (output !== "none" && output !== "pushed" && output !== "unknown") throw new ReconcileError(400, "provider-session-ended needs output: none (it did no work), pushed (it pushed or produced work) or unknown.");
    return { kind, reason, evidence: { source, checkedAt, sessionId, output } };
  }
  if (output !== undefined) throw new ReconcileError(400, "output is only for provider-session-ended.");
  return { kind, reason, evidence: { source, checkedAt, sessionId } };
}

// The checks an entry must pass against ORBIT's own record, before a preview is even offered.
function admit(job: Job, req: OwnerRequest, now: Date, ctx: EvidenceContext): BasedOn {
  const l = job.launch;
  if (!l) throw new ReconcileError(409, "This job has no launch record, so there is no launch to reconcile. Nothing was recorded.");
  const { outcome, dispatch } = launchOutcome(job, ctx);
  if (dispatch.state === "in-flight") throw new ReconcileError(409, "This ORBIT process is still running this launch. Wait for its result. Nothing was recorded.");
  if (outcome !== "unresolved")
    throw new ReconcileError(409, `ORBIT's record already settles this launch (${outcome}: ${dispatch.basis}). Reconciliation is only for unresolved launches. Nothing was recorded.`);
  const based: BasedOn = { launchAt: l.at, routine: l.routine, ...(l.briefCommit ? { briefCommit: l.briefCommit } : {}), ...(l.sessionId ? { sessionId: l.sessionId } : {}), dispatch: dispatch.state, outcome, events: job.events.length };
  const e = req.evidence;
  if (!e) return based;
  const launched = Date.parse(l.at);
  const checked = Date.parse(e.checkedAt);
  if (checked > now.getTime() + CLOCK_SKEW_MS) throw new ReconcileError(400, "checkedAt is in the future. Nothing was recorded.");
  if (checked < launched) throw new ReconcileError(400, `checkedAt is before the launch (${l.at}); evidence from before the launch says nothing about it. Nothing was recorded.`);
  if (req.kind === "provider-no-run") {
    // ORBIT's record already shows the provider accepted the fire: "no run" contradicts it.
    if (dispatch.state === "provider-accepted" || l.sessionId)
      throw new ReconcileError(409, `ORBIT's record shows the provider accepted this fire (${dispatch.basis}), so "no run" contradicts it. Record provider-session-ended or provider-session-running for that session instead. Nothing was recorded.`);
    const from = Date.parse(e.window!.from), to = Date.parse(e.window!.to);
    if (from > launched || to < launched + WINDOW_AFTER_LAUNCH_MS)
      throw new ReconcileError(400, `The window you checked must cover the launch: from at or before ${l.at} to at least ${new Date(launched + WINDOW_AFTER_LAUNCH_MS).toISOString()}. Nothing was recorded.`);
    if (to - from > WINDOW_MAX_MS) throw new ReconcileError(400, "The window is longer than 24 hours; give the period you actually checked. Nothing was recorded.");
    if (to > checked + CLOCK_SKEW_MS) throw new ReconcileError(400, "The window ends after checkedAt: you cannot have checked a period that had not happened yet. Nothing was recorded.");
  } else if (l.sessionId && e.sessionId !== l.sessionId) {
    throw new ReconcileError(409, `ORBIT's record holds session ${l.sessionId} for this launch, and the session you name is different. Check that you are looking at this job's session. Nothing was recorded.`);
  }
  return based;
}

// What the entry means and what it does not, shown in the preview and stored nowhere else: the code below is the one statement of it.
export function meaningOf(req: OwnerRequest): { meaning: string; doesNotMean: string[]; effect: string } {
  const unverified = "ORBIT does not verify provider evidence; it records your report of it, with your reason.";
  const kept = "The job record is not changed: its launch, events and dispatch reading stay as they are.";
  switch (req.kind) {
    case "provider-no-run":
      return {
        meaning: `You checked the Routine's run history from ${req.evidence!.window!.from} to ${req.evidence!.window!.to} (at ${req.evidence!.checkedAt}) and found no run for this job: no session was created.`,
        doesNotMean: [unverified, kept, "Nothing is relaunched or retried by this entry."],
        effect: "The launch reads provider-confirmed-no-run. A retry of it through its work session becomes possible, with its own confirmation. If the runner ever reports, that outranks this entry and you are told.",
      };
    case "provider-session-ended":
      return {
        meaning: `You found session ${req.evidence!.sessionId} (${req.evidence!.source}, checked ${req.evidence!.checkedAt}) and it has ended; its output: ${req.evidence!.output}.`,
        doesNotMean: [unverified, kept, "ORBIT did not end or cancel the session; you report that it had ended.", "Nothing is relaunched or retried by this entry."],
        effect:
          req.evidence!.output === "none"
            ? "The launch reads provider-confirmed-ended with no output. A retry through its work session becomes possible, with its own confirmation."
            : "The launch reads provider-confirmed-ended. A retry stays refused: recover or reconcile the session's output first (output pushed or unknown).",
      };
    case "provider-session-running":
      return {
        meaning: `You found session ${req.evidence!.sessionId} (${req.evidence!.source}, checked ${req.evidence!.checkedAt}) and it is still running, or you could not see that it ended.`,
        doesNotMean: [unverified, kept],
        effect: "The launch reads provider-confirmed-running. A retry stays refused: the session may still do the work.",
      };
    case "abandon-tracking":
      return {
        meaning: "You stop tracking this launch without provider evidence.",
        doesNotMean: [
          "It is not a cancellation: ORBIT did not stop, cancel or message any session.",
          "It is not evidence that no session ran, or that a session ended. A session may exist and may still be working.",
          kept,
        ],
        effect: "The launch stays unresolved and reads tracking-abandoned. A retry stays refused. Any runner event that arrives is still recorded and shown, and you are told.",
      };
  }
}

export const digestOf = (job: string, req: OwnerRequest, based: BasedOn, prior: number) =>
  createHash("sha256").update(JSON.stringify({ v: 1, job, kind: req.kind, evidence: req.evidence ?? null, reason: req.reason, basedOn: based, prior })).digest("hex");

const ownerEntries = (entries: Entry[]) => entries.filter((e): e is OwnerEntry => e.actor === "owner");

// The reading of a job's reconciliation: the latest owner entry, unless the runner has reported since. Pure: reads the job and the entries.
export function reconciliationOf(job: Pick<Job, "events">, entries: Entry[]): ReconciliationView {
  const latest = ownerEntries(entries).at(-1);
  const refused = (basis: string) => ({ allowed: false, basis });
  if (!latest) return { state: "none", basis: "no owner reconciliation is recorded for this launch", retry: refused("no owner reconciliation is recorded; the launch reading alone decides"), entries, lateEvents: 0, contradicted: false };
  const lateEvents = Math.max(0, job.events.length - latest.basedOn.events);
  const claimedOver = latest.kind === "provider-no-run" || latest.kind === "provider-session-ended";
  if (lateEvents)
    return {
      state: "runner-evidence-after-reconciliation",
      basis: `the runner reported ${lateEvents} event(s) after your ${latest.kind} entry of ${latest.at}; the runner's own events outrank it, and the entry is kept as history`,
      caveat: claimedOver ? `The runner's events contradict your ${latest.kind} entry: a session did run. Check its work before doing anything else.` : undefined,
      retry: refused("the runner reported after the reconciliation; its own events decide"),
      latest,
      entries,
      lateEvents,
      contradicted: claimedOver,
    };
  const owner = `Owner-reported (${latest.at}): ORBIT did not verify it. The job record is unchanged and still reads ${latest.basedOn.dispatch}.`;
  switch (latest.kind) {
    case "provider-no-run":
      return { state: "provider-confirmed-no-run", basis: `you reported that the Routine run history (${latest.evidence?.window?.from} to ${latest.evidence?.window?.to}) holds no run for this job`, caveat: owner, retry: { allowed: true, basis: "provider evidence reported by the owner: no session was created" }, latest, entries, lateEvents, contradicted: false };
    case "provider-session-ended": {
      const none = latest.evidence?.output === "none";
      return {
        state: "provider-confirmed-ended",
        basis: `you reported that session ${latest.evidence?.sessionId} has ended (output: ${latest.evidence?.output})`,
        caveat: owner,
        retry: none ? { allowed: true, basis: "provider evidence reported by the owner: the session ended without output" } : refused(`the session's output is ${latest.evidence?.output}: recover or reconcile it before running the work again`),
        latest,
        entries,
        lateEvents,
        contradicted: false,
      };
    }
    case "provider-session-running":
      return { state: "provider-confirmed-running", basis: `you reported that session ${latest.evidence?.sessionId} is running or not known to have ended`, caveat: owner, retry: refused("a session for this launch may still be working"), latest, entries, lateEvents, contradicted: false };
    case "abandon-tracking":
      return {
        state: "tracking-abandoned",
        basis: `you stopped tracking this launch at ${latest.at}`,
        caveat: "Abandoning tracking is not a cancellation and not evidence that no session ran or that one ended: a session may exist. ORBIT still records and shows any runner event.",
        retry: refused("tracking was abandoned without provider evidence, so a session may exist; a replacement with that residual duplicate risk needs its own explicit owner confirmation of the risk, which ORBIT does not offer yet"),
        latest,
        entries,
        lateEvents,
        contradicted: false,
      };
  }
}

export type Preview = { job: string; kind: OwnerKind; evidence?: ProviderEvidence; reason: string; basedOn: BasedOn; meaning: string; doesNotMean: string[]; effect: string; digest: string };
export type JobsSource = { get(id: string): Job | undefined; all(): Job[] };
export type LaunchReconciliations = ReturnType<typeof launchReconciliations>;

export function launchReconciliations(backend: ReconBackend, now: () => Date = () => new Date(), opts: { notify?: Notifier; inFlight?: EvidenceContext["inFlight"] } = {}) {
  let file: ReconFile | undefined;
  let problem: string | undefined;
  const ctx: EvidenceContext = opts.inFlight ? { inFlight: opts.inFlight } : {};

  const load = (): ReconFile => {
    if (file) return file;
    let raw: ReconFile | undefined;
    try {
      raw = backend.load();
    } catch (e) {
      problem = `the reconciliation log could not be read (${e instanceof Error ? e.name : "error"}); it is left as it is`;
      throw new ReconcileError(503, `Launch reconciliation is unavailable: ${problem}.`);
    }
    if (raw === undefined) raw = { v: RECON_FILE_VERSION, entries: [] };
    if (!isObj(raw) || typeof raw.v !== "number" || !Array.isArray(raw.entries)) {
      problem = "the reconciliation log has an unknown shape; it is left as it is";
      throw new ReconcileError(503, `Launch reconciliation is unavailable: ${problem}.`);
    }
    if (raw.v > RECON_FILE_VERSION) {
      problem = `the reconciliation log has schema version ${raw.v}, newer than this build understands (${RECON_FILE_VERSION}); it is left as it is`;
      throw new ReconcileError(503, `Launch reconciliation is unavailable: ${problem}.`);
    }
    problem = undefined;
    file = raw;
    return file;
  };
  // Persist first, then change memory: a failed write leaves both as they were.
  const append = (entry: Entry) => {
    const f = load();
    const next = { v: Math.max(f.v, RECON_FILE_VERSION), entries: [...f.entries, entry] };
    backend.save(next);
    file = next;
  };
  const all = () => load().entries.filter(validEntry);
  const of = (job: string) => all().filter((e) => e.job === job);
  const nextSeq = () => all().reduce((m, e) => Math.max(m, e.seq), 0) + 1;

  const prepare = (job: Job, input: unknown) => {
    const req = parseRequest(input);
    const based = admit(job, req, now(), ctx);
    const prior = of(job.id);
    if (ownerEntries(prior).length >= MAX_ENTRIES_PER_JOB || all().length >= MAX_ENTRIES) throw new ReconcileError(409, "The reconciliation log for this job is full; it keeps every entry and never drops one. Nothing was recorded.");
    return { req, based, prior, digest: digestOf(job.id, req, based, prior.length) };
  };

  return {
    get persisted() {
      return backend.persisted;
    },
    problem: () => problem,
    entries: of,
    view: (job: Job): ReconciliationView => reconciliationOf(job, of(job.id)),

    // Step one: validate and describe. Writes nothing.
    preview(job: Job, input: unknown): Preview {
      const { req, based, digest } = prepare(job, input);
      return { job: job.id, kind: req.kind, ...(req.evidence ? { evidence: req.evidence } : {}), reason: req.reason, basedOn: based, ...meaningOf(req), digest };
    },

    // Step two: the same request plus the digest the preview returned. The digest binds the exact entry, ORBIT's record as it was read
    // (dispatch state, outcome, event count, session id) and the number of earlier entries, so a confirmation is single use and goes stale
    // when anything it was based on changes. A repeat of the confirmation that was just recorded returns that entry and records nothing.
    confirm(job: Job, input: unknown, digest: unknown): { entry: OwnerEntry; repeated: boolean } {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) throw new ReconcileError(400, "confirm must be the digest the preview returned.");
      // A repeat is the same request with the digest already recorded; anything else with that digest is stale and refused below.
      const asked = parseRequest(input);
      const same = (e: OwnerEntry) => e.digest === digest && e.kind === asked.kind && e.reason === asked.reason && JSON.stringify(e.evidence ?? null) === JSON.stringify(asked.evidence ?? null);
      const done = ownerEntries(of(job.id)).find(same);
      if (done) return { entry: done, repeated: true };
      const { req, based, digest: expected } = prepare(job, input);
      if (digest !== expected) throw new ReconcileError(409, "The confirmation does not match this request as ORBIT reads it now (the request, the job record or the log changed since the preview). Preview again. Nothing was recorded.");
      const entry: OwnerEntry = { seq: nextSeq(), job: job.id, at: now().toISOString(), actor: "owner", kind: req.kind, ...(req.evidence ? { evidence: req.evidence } : {}), reason: req.reason, digest, basedOn: based };
      append(entry);
      opts.notify?.send(`Launch of job ${job.id}: you recorded ${req.kind}. ${meaningOf(req).doesNotMean[0]} The job record is unchanged.`, false);
      return { entry, repeated: false };
    },

    // Runner events that arrived after an owner entry: appended once per owner entry as ORBIT's own entry, and Rai is told. Reads the job
    // store; writes only this log; changes no job. Returns the entries it added. Never throws (an unreadable log is reported by status()).
    observe(jobs: JobsSource): LateEntry[] {
      const added: LateEntry[] = [];
      try {
        const byJob = new Map<string, Entry[]>();
        for (const e of all()) byJob.set(e.job, [...(byJob.get(e.job) ?? []), e]);
        for (const [id, entries] of byJob) {
          const latest = ownerEntries(entries).at(-1);
          if (!latest || entries.some((e) => e.actor === "orbit" && e.after === latest.seq)) continue;
          const job = jobs.get(id);
          if (!job || job.events.length <= latest.basedOn.events) continue;
          const view = reconciliationOf(job, entries);
          const first = job.events.find((e) => e.at >= latest.at) ?? job.events.at(-1)!;
          const late: LateEntry = { seq: nextSeq(), job: id, at: now().toISOString(), actor: "orbit", kind: "late-runner-evidence", after: latest.seq, events: view.lateEvents, firstLateAt: first.at, firstLateType: first.type, contradicts: view.contradicted };
          append(late);
          added.push(late);
          opts.notify?.send(
            `Job ${id} reported after you reconciled its launch (${latest.kind}, ${latest.at}): ${view.lateEvents} runner event(s), first ${first.type} at ${first.at}.${view.contradicted ? " This contradicts your entry: a session did run. Check its work before relaunching anything." : ""} Your entry is kept; the runner's events now decide.`,
            view.contradicted,
          );
        }
      } catch {
        // reported by status()
      }
      return added;
    },

    status() {
      try {
        return { state: "live" as const, persisted: backend.persisted, entries: all().length };
      } catch {
        return { state: "unavailable" as const, persisted: backend.persisted, detail: problem ?? "unreadable" };
      }
    },
  };
}
