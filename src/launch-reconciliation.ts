import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./job-inputs.ts";
import { JOB_ID, KEEP_EVENTS, type Job, type JobEvent, type Launch } from "./jobs.ts";
import { type DispatchState, type EvidenceContext, type LaunchOutcome, launchOutcome, legacyFailure } from "./launch-evidence.ts";
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
//   - `provider-no-run` is only as good as the window it covers. It is checked against the dispatch ORBIT recorded (fireStartedAt to the
//     fire's recorded end), not the launch record time, at preview, at confirmation and again at every reading, so an entry an older
//     build admitted is held to the same rule. A record that cannot bound the dispatch (legacy, interrupted, inconsistent) fails closed.
//
// Persistence: one JSON file, `<state>/launch-reconciliations.json`, written atomically (write `.new`, rename) before memory changes. A
// file that exists but cannot be read, has a newer schema version, or holds any entry that fails the integrity check (integrityProblems)
// makes the whole log unavailable: it is never overwritten, repaired or partly used, and nothing in it authorizes a retry.

export const RECON_FILE_VERSION = 1;
// Bounds: the log only grows, so it refuses new owner entries rather than dropping old ones.
export const MAX_ENTRIES_PER_JOB = 20;
export const MAX_ENTRIES = 2000;
export const REASON_MIN = 10;
export const REASON_MAX = 500;
// How far a provider-no-run window must reach around the dispatch ORBIT recorded (dispatchBounds). Before fireStartedAt: the clocks of
// ORBIT's host and the provider may disagree (CLOCK_SKEW_MS is the tolerance used everywhere here), and run lists show times to the
// minute. After the fire's recorded end (failedAt): the same skew, plus time for the provider to create a session from a request whose
// answer was lost (a transport failure or 5xx can be recorded before the provider finishes handling the request). These are judgment
// margins, not provider guarantees; a window that does not reach them is refused, never widened.
export const WINDOW_BEFORE_DISPATCH_MS = 5 * 60_000;
export const WINDOW_AFTER_DISPATCH_MS = 15 * 60_000;
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
// What ORBIT's own record held when the entry was confirmed. Copied, never re-derived later. `fire` holds the launch record's dispatch
// times as they were (each only when the record had it); it is present on every entry written since it was added, and absent on entries
// from before, which is how a reading tells the two apart.
export type FireTimes = { fireStartedAt?: string; firedAt?: string; failedAt?: string; fireFailure?: NonNullable<Launch["fireFailure"]> };
export type BasedOn = { launchAt: string; routine: string; briefCommit?: string; sessionId?: string; dispatch: DispatchState; outcome: LaunchOutcome; events: number; fire?: FireTimes };

export type OwnerEntry = { seq: number; job: string; at: string; actor: "owner"; kind: OwnerKind; evidence?: ProviderEvidence; reason: string; digest: string; basedOn: BasedOn };
// ORBIT's own entry: the runner reported after an owner entry. One per owner entry at most. `events` counts late events (with any the job
// record dropped past its cap, when that count is known). `firstLate*` is the first late event by position in the job record;
// `firstLateExact` is false when the record no longer holds the true first one (dropped past the cap, or an uncounted legacy drop), so
// the event named is the first retained one. Entries written before the field was added lack it.
export type LateEntry = { seq: number; job: string; at: string; actor: "orbit"; kind: "late-runner-evidence"; after: number; events: number; firstLateAt: string; firstLateType: string; firstLateExact?: boolean; contradicts: boolean };
export type Entry = OwnerEntry | LateEntry;

export type ReconciledState =
  | "none"
  | "provider-confirmed-no-run"
  | "provider-confirmed-ended"
  | "provider-confirmed-running"
  | "tracking-abandoned"
  | "runner-evidence-after-reconciliation"
  // An owner entry that would allow a retry does not hold against ORBIT's current record: a provider-no-run window that does not cover
  // the recorded dispatch (or a record that cannot bound it), or a launch record that changed since the entry. Kept as history; no retry.
  | "provider-evidence-insufficient";

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

// ---- integrity of the persisted log ------------------------------------------------------------------------------------------------
//
// Every entry is checked in full when the file is loaded: its discriminated shape (owner kinds and their evidence, exactly as
// parseRequest would produce it; ORBIT's late entries), its times, its basedOn copy, and the order of the file (seq increases; a late
// entry names an earlier owner entry of the same job, at most once). One failing entry makes the whole log unavailable (503): skipping
// it could expose an older entry as the latest decision (a corrupt abandon-tracking hiding behind an earlier provider-no-run), and a
// missing count could read as "no late events". The file is never rewritten or repaired by ORBIT; the problem is reported, bounded,
// naming entries by position and seq only, never echoing stored text.
const EVENT_TYPES = new Set<string>(["started", "checkin", "reply", "summary"] satisfies JobEvent["type"][]);
// The only dispatch states an entry can be admitted in (admit): unresolved, not in flight, with a launch record.
const ADMITTED_DISPATCH = new Set<string>(["dispatch-unknown", "provider-accepted"] satisfies DispatchState[]);
const OWNER_KEYS = new Set(["seq", "job", "at", "actor", "kind", "evidence", "reason", "digest", "basedOn"]);
const LATE_KEYS = new Set(["seq", "job", "at", "actor", "kind", "after", "events", "firstLateAt", "firstLateType", "firstLateExact", "contradicts"]);
const BASED_KEYS = new Set(["launchAt", "routine", "briefCommit", "sessionId", "dispatch", "outcome", "events", "fire"]);
const FIRE_KEYS = new Set(["fireStartedAt", "firedAt", "failedAt", "fireFailure"]);
const MAX_PROBLEM_CHARS = 560;
const isTime = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
// Copied launch fields are bound as they were read, valid or not (a record with an unparseable time can still be abandoned), so their
// check is only that they are short strings.
const isCopied = (v: unknown) => v === undefined || (typeof v === "string" && v.length <= 128);
const canon = (v: unknown): string => (isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));

function ownerProblem(e: Record<string, unknown>): string | undefined {
  if (Object.keys(e).some((k) => !OWNER_KEYS.has(k))) return "has an unknown field";
  if (!OWNER_KINDS.includes(e.kind as OwnerKind)) return "kind is not a known owner kind";
  const kind = e.kind as OwnerKind;
  if (typeof e.digest !== "string" || !/^[0-9a-f]{64}$/.test(e.digest)) return "digest must be 64 lowercase hex characters";
  if (typeof e.reason !== "string" || e.reason.trim() !== e.reason || e.reason.length < REASON_MIN || e.reason.length > REASON_MAX || CONTROL.test(e.reason))
    return `reason must be ${REASON_MIN} to ${REASON_MAX} characters, trimmed, without control characters`;
  const ev = e.evidence;
  if (kind === "abandon-tracking") {
    if (ev !== undefined) return "evidence is not allowed on abandon-tracking";
  } else {
    if (!isObj(ev)) return `evidence is missing or not an object (${kind} needs it)`;
    const w = ev.window;
    if (w !== undefined && !isObj(w)) return "evidence.window is not an object";
    let parsed: OwnerRequest;
    try {
      parsed = parseRequest({ kind, reason: e.reason, source: ev.source, checkedAt: ev.checkedAt, windowFrom: w?.from, windowTo: w?.to, sessionId: ev.sessionId, output: ev.output });
    } catch {
      return `evidence does not have the shape a ${kind} entry needs`;
    }
    if (canon(parsed.evidence) !== canon(ev)) return `evidence does not have the shape a ${kind} entry needs`;
    if (parsed.evidence?.window) {
      const from = Date.parse(parsed.evidence.window.from), to = Date.parse(parsed.evidence.window.to);
      if (to < from || to - from > WINDOW_MAX_MS) return "evidence.window must run forward and span at most 24 hours";
    }
  }
  const b = e.basedOn;
  if (!isObj(b)) return "basedOn is missing or not an object";
  if (Object.keys(b).some((k) => !BASED_KEYS.has(k))) return "basedOn has an unknown field";
  if (!isTime(b.launchAt)) return "basedOn.launchAt must be a UTC ISO time";
  if (typeof b.routine !== "string" || !b.routine || b.routine.length > 128) return "basedOn.routine must be a short non-empty string";
  if (!isCopied(b.briefCommit) || !isCopied(b.sessionId)) return "basedOn.briefCommit and basedOn.sessionId must be short strings when present";
  if (!ADMITTED_DISPATCH.has(b.dispatch as string)) return "basedOn.dispatch must be dispatch-unknown or provider-accepted, the only states an entry is admitted in";
  if (b.outcome !== "unresolved") return "basedOn.outcome must be unresolved";
  if (!isCount(b.events)) return "basedOn.events must be a nonnegative integer";
  if (b.fire !== undefined) {
    if (!isObj(b.fire) || Object.keys(b.fire).some((k) => !FIRE_KEYS.has(k))) return "basedOn.fire must be an object of the launch record's fire times";
    if (![...FIRE_KEYS].every((k) => isCopied((b.fire as Record<string, unknown>)[k]))) return "basedOn.fire values must be short strings when present";
  }
  return undefined;
}

function lateProblem(e: Record<string, unknown>): string | undefined {
  if (Object.keys(e).some((k) => !LATE_KEYS.has(k))) return "has an unknown field";
  if (e.kind !== "late-runner-evidence") return "kind must be late-runner-evidence on an ORBIT entry";
  if (!Number.isInteger(e.after) || (e.after as number) < 1) return "after must be the seq of an owner entry";
  if (!Number.isInteger(e.events) || (e.events as number) < 1) return "events must be a positive integer";
  if (!isTime(e.firstLateAt)) return "firstLateAt must be a UTC ISO time";
  if (typeof e.firstLateType !== "string" || !EVENT_TYPES.has(e.firstLateType)) return "firstLateType must be a runner event type";
  if (e.firstLateExact !== undefined && typeof e.firstLateExact !== "boolean") return "firstLateExact must be true or false when present";
  if (typeof e.contradicts !== "boolean") return "contradicts must be true or false";
  return undefined;
}

function entryProblem(e: unknown): string | undefined {
  if (!isObj(e)) return "is not an object";
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) return "seq must be a positive integer";
  if (typeof e.job !== "string" || !JOB_ID.test(e.job)) return "job is not a valid job id";
  if (!isTime(e.at)) return "at must be a UTC ISO time";
  if (e.actor === "owner") return ownerProblem(e);
  if (e.actor === "orbit") return lateProblem(e);
  return "actor must be owner or orbit";
}

// Every problem in a log's entries, in file order. Empty when the whole log can be used.
export function integrityProblems(entries: unknown[]): string[] {
  const out: string[] = [];
  let lastSeq = 0;
  const owners = new Map<number, string>();
  const reported = new Set<number>();
  entries.forEach((e, i) => {
    const where = `entry ${i + 1}${isObj(e) && Number.isInteger(e.seq) ? ` (seq ${e.seq})` : ""}`;
    const problem = entryProblem(e);
    if (problem) return void out.push(`${where}: ${problem}`);
    const x = e as Entry;
    if (x.seq <= lastSeq) out.push(`${where}: seq must increase through the file (the log is append-only)`);
    lastSeq = Math.max(lastSeq, x.seq);
    if (x.actor === "owner") owners.set(x.seq, x.job);
    else if (owners.get(x.after) !== x.job) out.push(`${where}: after does not name an earlier owner entry of the same job`);
    else if (reported.has(x.after)) out.push(`${where}: a second late-runner-evidence entry for owner entry ${x.after}`);
    else reported.add(x.after);
  });
  return out;
}

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

// ---- the dispatch a provider-no-run window must cover --------------------------------------------------------------------------
//
// launch.at is written before the brief (src/job-launch.ts), so the fire can come minutes later (the brief write and the fire request
// have no timeout). The dispatch is bounded only by fireStartedAt, persisted immediately before the fire request, and the fire's recorded
// end (failedAt; a recorded firedAt comes with a session, which provider-no-run is refused for anyway). A record without both bounds, or
// with bounds that contradict each other, cannot show that any window covered the dispatch, so provider-no-run is refused: a wider
// window around launch.at is not proof of anything.
export type DispatchBounds = { ok: true; start: number; end: number } | { ok: false; why: string };
export function dispatchBounds(l: Pick<Launch, "at" | "fireStartedAt" | "firedAt" | "failedAt">): DispatchBounds {
  const inconsistent = (what: string) => ({ ok: false as const, why: `ORBIT's launch record has inconsistent dispatch times (${what})` });
  if (l.fireStartedAt === undefined)
    return { ok: false, why: "ORBIT's launch record is an older one with no fire-start time, so when the fire was sent is unknown (the launch time is written before the brief, not at the fire)" };
  if (!isTime(l.at) || !isTime(l.fireStartedAt)) return inconsistent("a launch or fire-start time is not a valid UTC time");
  const at = Date.parse(l.at), start = Date.parse(l.fireStartedAt);
  if (start < at) return inconsistent("the fire started before the launch was recorded");
  if (l.failedAt !== undefined && l.firedAt !== undefined) return inconsistent("both a fire answer and a fire failure are recorded");
  const endAt = l.failedAt ?? l.firedAt;
  if (endAt === undefined) return { ok: false, why: "ORBIT's launch record has no time for the end of the fire (ORBIT stopped before the fire returned), so the request may have reached the provider at any time until ORBIT stopped" };
  if (!isTime(endAt)) return inconsistent("the fire's end is not a valid UTC time");
  const end = Date.parse(endAt);
  if (end < start) return inconsistent("the fire ended before it started");
  return { ok: true, start, end };
}

// Whether a provider-no-run window can stand for this launch record as it is now: undefined when it can, otherwise why not. Checked at
// preview and confirmation (admit) and again at every reading (reconciliationOf), so entries an older build admitted are held to it too.
// It speaks only to the window: the run history shows only the runs it lists for the period checked.
export function noRunProblem(l: Launch | undefined, window: { from: string; to: string } | undefined): { code: number; why: string } | undefined {
  if (!l) return { code: 409, why: "the job has no launch record" };
  if (!window || !isTime(window.from) || !isTime(window.to)) return { code: 400, why: "the entry has no valid checked window" };
  if (l.sessionId || l.firedAt || (l.failedAt && (l.fireFailure ?? legacyFailure(l.error)) === "no-session"))
    return { code: 409, why: "ORBIT's record shows the provider accepted this fire, so \"no run\" contradicts it" };
  const b = dispatchBounds(l);
  if (!b.ok) return { code: 409, why: `${b.why}; no checked window can be shown to cover the dispatch, so provider-no-run cannot stand for it` };
  const needFrom = b.start - WINDOW_BEFORE_DISPATCH_MS, needTo = b.end + WINDOW_AFTER_DISPATCH_MS;
  if (Date.parse(window.from) > needFrom || Date.parse(window.to) < needTo)
    return {
      code: 400,
      why: `the window you checked must cover the dispatch ORBIT recorded: from at or before ${new Date(needFrom).toISOString()} (fire started ${l.fireStartedAt}, less ${WINDOW_BEFORE_DISPATCH_MS / 60_000} minutes) to at least ${new Date(needTo).toISOString()} (fire ended ${l.failedAt ?? l.firedAt}, plus ${WINDOW_AFTER_DISPATCH_MS / 60_000} minutes)`,
    };
  return undefined;
}

// Whether the launch record an entry was based on still holds the facts it copied: undefined when it does, otherwise what changed.
// The fire times are compared when the entry recorded them (`fire`); an older entry has none, and its no-run window is checked against
// the record as it is now (noRunProblem).
export function basisChange(b: BasedOn, l: Launch | undefined): string | undefined {
  if (!l) return "ORBIT's launch record changed since your entry (the job no longer has one)";
  const pairs: [string, unknown, unknown][] = [
    ["launch time", b.launchAt, l.at],
    ["routine", b.routine, l.routine],
    ["brief commit", b.briefCommit, l.briefCommit || undefined],
    ["session id", b.sessionId, l.sessionId || undefined],
  ];
  if (b.fire)
    pairs.push(["fire start time", b.fire.fireStartedAt, l.fireStartedAt], ["fire answer time", b.fire.firedAt, l.firedAt], ["fire failure time", b.fire.failedAt, l.failedAt], ["fire failure kind", b.fire.fireFailure, l.fireFailure]);
  const changed = pairs.filter(([, was, now]) => was !== now).map(([name]) => name);
  return changed.length ? `ORBIT's launch record changed since your entry (${changed.join(", ")})` : undefined;
}

// How many runner events arrived after an owner entry, and the first of them, by position in the job record (never by timestamp: an
// event's time can be skewed relative to the entry's). The record keeps the last KEEP_EVENTS events and counts those it dropped
// (eventsDropped; absent on legacy records, where drops past the cap are unknown). `count` is exact when drops are known, otherwise a
// lower bound. `firstExact` is false when the true first late event is no longer in the record: `first` is then the first retained one.
export function lateEventsOf(job: Pick<Job, "events" | "eventsDropped">, basedOnEvents: number): { count: number; exactCount: boolean; first?: JobEvent; firstExact: boolean } {
  const dropped = job.eventsDropped ?? (job.events.length < KEEP_EVENTS ? 0 : undefined);
  const count = Math.max(0, job.events.length + (dropped ?? 0) - basedOnEvents);
  if (!count) return { count, exactCount: dropped !== undefined, firstExact: false };
  const at = basedOnEvents - (dropped ?? 0);
  return { count, exactCount: dropped !== undefined, first: job.events[Math.max(0, at)], firstExact: dropped !== undefined && at >= 0 };
}

// The checks an entry must pass against ORBIT's own record, before a preview is even offered.
function admit(job: Job, req: OwnerRequest, now: Date, ctx: EvidenceContext): BasedOn {
  const l = job.launch;
  if (!l) throw new ReconcileError(409, "This job has no launch record, so there is no launch to reconcile. Nothing was recorded.");
  const { outcome, dispatch } = launchOutcome(job, ctx);
  if (dispatch.state === "in-flight") throw new ReconcileError(409, "This ORBIT process is still running this launch. Wait for its result. Nothing was recorded.");
  if (outcome !== "unresolved")
    throw new ReconcileError(409, `ORBIT's record already settles this launch (${outcome}: ${dispatch.basis}). Reconciliation is only for unresolved launches. Nothing was recorded.`);
  const fire: FireTimes = {
    ...(l.fireStartedAt !== undefined ? { fireStartedAt: l.fireStartedAt } : {}),
    ...(l.firedAt !== undefined ? { firedAt: l.firedAt } : {}),
    ...(l.failedAt !== undefined ? { failedAt: l.failedAt } : {}),
    ...(l.fireFailure !== undefined ? { fireFailure: l.fireFailure } : {}),
  };
  const based: BasedOn = { launchAt: l.at, routine: l.routine, ...(l.briefCommit ? { briefCommit: l.briefCommit } : {}), ...(l.sessionId ? { sessionId: l.sessionId } : {}), dispatch: dispatch.state, outcome, events: job.events.length, fire };
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
    if (dispatch.state !== "dispatch-unknown") throw new ReconcileError(409, `provider-no-run is only for a launch whose dispatch is unknown; this one reads ${dispatch.state}. Nothing was recorded.`);
    const gap = noRunProblem(l, e.window!);
    if (gap) throw new ReconcileError(gap.code, `${gap.why[0].toUpperCase()}${gap.why.slice(1)}. Nothing was recorded.`);
    const from = Date.parse(e.window!.from), to = Date.parse(e.window!.to);
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
        meaning: `You checked the Routine's run history from ${req.evidence!.window!.from} to ${req.evidence!.window!.to} (at ${req.evidence!.checkedAt}), a window that covers the dispatch ORBIT recorded, and found no run for this job: no session was created by this fire.`,
        doesNotMean: [
          unverified,
          kept,
          "It covers only the window you checked: a run outside it, or one the run history does not list, is not ruled out.",
          "Nothing is relaunched or retried by this entry.",
        ],
        effect: "The launch reads provider-confirmed-no-run while ORBIT's launch record still matches this entry. A retry of it through its work session becomes possible, with its own confirmation. If the runner ever reports, that outranks this entry and you are told; if the launch record changes, the retry is refused.",
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

// The confirmation digest binds: the job id; the normalized request (kind, evidence, reason); the whole basedOn copy of the launch record
// (launch time, routine, brief commit, session id, dispatch state, outcome, event count, and the fire times fireStartedAt, firedAt,
// failedAt and fireFailure); and the number of earlier entries for the job. Nothing else of the job record is bound. `v: 2` since the
// fire times were added.
export const digestOf = (job: string, req: OwnerRequest, based: BasedOn, prior: number) =>
  createHash("sha256").update(JSON.stringify({ v: 2, job, kind: req.kind, evidence: req.evidence ?? null, reason: req.reason, basedOn: based, prior })).digest("hex");

const ownerEntries = (entries: Entry[]) => entries.filter((e): e is OwnerEntry => e.actor === "owner");

// The reading of a job's reconciliation: the latest owner entry, unless the runner has reported since. Pure: reads the job and the entries.
// An entry that would allow a retry (provider-no-run, or provider-session-ended with output none) is re-read against the job's launch
// record every time: the record must still hold what the entry copied, and a no-run window must still cover the recorded dispatch.
// Otherwise the reading is provider-evidence-insufficient and the retry is refused.
export function reconciliationOf(job: Pick<Job, "events" | "eventsDropped" | "launch">, entries: Entry[]): ReconciliationView {
  const latest = ownerEntries(entries).at(-1);
  const refused = (basis: string) => ({ allowed: false, basis });
  if (!latest) return { state: "none", basis: "no owner reconciliation is recorded for this launch", retry: refused("no owner reconciliation is recorded; the launch reading alone decides"), entries, lateEvents: 0, contradicted: false };
  const lateEvents = lateEventsOf(job, latest.basedOn.events).count;
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
  const insufficient = (why: string): ReconciliationView => ({
    state: "provider-evidence-insufficient",
    basis: `your ${latest.kind} entry of ${latest.at} does not hold against ORBIT's launch record now: ${why}`,
    caveat: `${owner} The entry is kept as history and allows nothing.`,
    retry: refused(`${why}; a session may exist, so record provider evidence that holds for the record as it is, or leave the launch unresolved`),
    latest,
    entries,
    lateEvents,
    contradicted: false,
  });
  switch (latest.kind) {
    case "provider-no-run": {
      const why = basisChange(latest.basedOn, job.launch) ?? noRunProblem(job.launch, latest.evidence?.window)?.why;
      if (why) return insufficient(why);
      return { state: "provider-confirmed-no-run", basis: `you reported that the Routine run history (${latest.evidence?.window?.from} to ${latest.evidence?.window?.to}) holds no run for this job`, caveat: owner, retry: { allowed: true, basis: "provider evidence reported by the owner: the Routine run history for a window covering the recorded dispatch lists no run for this job" }, latest, entries, lateEvents, contradicted: false };
    }
    case "provider-session-ended": {
      const none = latest.evidence?.output === "none";
      const why = none ? basisChange(latest.basedOn, job.launch) : undefined;
      if (why) return insufficient(why);
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
    // Any entry that fails the integrity check makes the whole log unavailable, and it is not cached: every use re-reads the file, so a
    // copy the owner repaired by hand is picked up without a restart. Nothing is written while it fails, so nothing is lost or masked.
    const problems = integrityProblems(raw.entries);
    if (problems.length) {
      const shown = problems.slice(0, 3).join("; ") + (problems.length > 3 ? "; …" : "");
      problem = `the reconciliation log failed its integrity check (${problems.length} problem(s): ${shown.slice(0, MAX_PROBLEM_CHARS)}); it is left as it is, no entry in it is used and no retry is allowed from it until it is repaired by hand`;
      throw new ReconcileError(503, `Launch reconciliation is unavailable: ${problem}.`);
    }
    problem = undefined;
    file = raw;
    return file;
  };
  // Persist first, then change memory: a failed write leaves both as they were. ORBIT never writes an entry its own loader would refuse
  // (for example a launch record whose time is not a UTC ISO time, copied into basedOn): that would make the whole log unavailable.
  const append = (entry: Entry) => {
    const f = load();
    const next = { v: Math.max(f.v, RECON_FILE_VERSION), entries: [...f.entries, entry] };
    const problems = integrityProblems(next.entries);
    if (problems.length) throw new ReconcileError(409, `This entry would not pass the log's integrity check (${problems[0].slice(0, 200)}), so it was not written. Nothing was recorded.`);
    backend.save(next);
    file = next;
  };
  // Every entry passed the integrity check in load(), or load() threw: nothing is filtered out here.
  const all = () => load().entries as Entry[];
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

    // Step two: the same request plus the digest the preview returned. The digest (digestOf) binds the exact entry, the basedOn copy of
    // ORBIT's launch record as it was read (launch time, routine, brief commit, session id, dispatch state, outcome, event count and the
    // fire times) and the number of earlier entries, so a confirmation is single use and goes stale when any of those changes. admit()
    // runs again here, so the window is checked against the record as it is at confirmation. A repeat of the confirmation that was just recorded returns that entry and records nothing.
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
          if (!job) continue;
          // By position, not timestamp (lateEventsOf): the first late event is the one after the basedOn count, when the record still
          // holds it; otherwise the first retained one, and the entry and the message say so.
          const lateness = lateEventsOf(job, latest.basedOn.events);
          if (!lateness.count || !lateness.first) continue;
          const view = reconciliationOf(job, entries);
          const first = lateness.first;
          const late: LateEntry = { seq: nextSeq(), job: id, at: now().toISOString(), actor: "orbit", kind: "late-runner-evidence", after: latest.seq, events: lateness.count, firstLateAt: first.at, firstLateType: first.type, firstLateExact: lateness.firstExact, contradicts: view.contradicted };
          append(late);
          added.push(late);
          const count = `${lateness.exactCount ? "" : "at least "}${lateness.count} runner event(s)`;
          const firstText = lateness.firstExact ? `first ${first.type} at ${first.at}` : `first retained ${first.type} at ${first.at} (earlier events were dropped from the job record, so the true first is not known)`;
          opts.notify?.send(
            `Job ${id} reported after you reconciled its launch (${latest.kind}, ${latest.at}): ${count}, ${firstText}.${view.contradicted ? " This contradicts your entry: a session did run. Check its work before relaunching anything." : ""} Your entry is kept; the runner's events now decide.`,
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
