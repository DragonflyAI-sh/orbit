import { randomUUID } from "node:crypto";
import { ProviderError } from "./chatgpt.ts";
import type { FallbackInfo, Item, ModelPort, ToolDef } from "./model.ts";
import type { MutatingAction } from "./ops/admin-protocol.ts";
import type { SysMutatingAction } from "./ops/sys-protocol.ts";
import type { Result } from "./ports.ts";

// Tool use inside a chat reply. The model may call ChatTools; every call is checked by `allow` (ORBIT's policy)
// before it runs, and the reply lists every call with where its result came from.

export const MAX_ROUNDS = 5;
export const MAX_OUTPUT_CHARS = 8000;

// What a tool is given besides its arguments. `signal` is aborted when ORBIT stops waiting for the call (its deadline passed or the
// turn was cancelled). A tool that passes it on stops its work where the operation supports it; a tool that ignores it keeps running.
export type ToolContext = { signal: AbortSignal };

export type ChatTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // runChat always passes `ctx`; it is optional so a tool can also be called directly.
  run(args: Record<string, unknown>, ctx?: ToolContext): Promise<Result<unknown>>;
  // True only for a tool that changes nothing outside ORBIT's own caches. Anything else is treated as possibly having an effect:
  // if it is cut off, its outcome is reported as unknown, never as failed, and it is never run again automatically.
  readOnly?: boolean;
  // This tool's own execution deadline, when it legitimately takes longer than TOOL_DEADLINE_MS (see docs/tool-deadlines.md).
  deadlineMs?: number;
};

// How long ORBIT waits for one chat tool call before it stops waiting, ends the turn and frees the thread (docs/tool-deadlines.md).
// 180 s is above every bound the tools apply themselves (the vault's git fetch and push at 120 s each, the ops helper at 8 s, memory
// refresh at 30 s), so a tool that is slow but working is not cut short, and well below the 600 s a single model request may take.
export const TOOL_DEADLINE_MS = 180_000;
// After the deadline the call is asked to stop; this is how long ORBIT then waits to see whether it did, before it ends the turn.
export const TOOL_ABORT_GRACE_MS = 2_000;

// Why a turn stopped waiting for a tool call.
export type Interruption = "timeout" | "cancelled";

// A turn ended because a tool call ran past its deadline, or the turn was cancelled. The interrupted call (if any) is already on
// record through onCall. Nothing after it ran: no further tool call and no further model step.
export class TurnInterrupted extends Error {
  readonly kind: Interruption;
  // The call that was cut off, when the interruption happened while a tool was running.
  readonly call: CallRecord | undefined;
  // Tool calls the model asked for in the same round that were never started.
  readonly notStarted: number;
  constructor(kind: Interruption, call: CallRecord | undefined, notStarted: number, message: string) {
    super(message);
    this.name = "TurnInterrupted";
    this.kind = kind;
    this.call = call;
    this.notStarted = notStarted;
  }
}

export type CallRecord = {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  provenance?: "live" | "mock";
  source?: string;
  // Short, human-readable outcome; the model saw the full result.
  summary: string;
  // Set when ORBIT stopped waiting for this call (docs/tool-deadlines.md). `abort`: "requested" means the call was asked to stop and
  // had not ended when the turn ended (it may still be running); "confirmed" means it ended with an error after it was asked to stop.
  // Absent with `interrupted` set means it completed during the grace period. `outcomeUnknown`: the call may have an effect and did not
  // complete, so whether that effect happened is not known. It is never failed-for-sure, and it is never retried.
  interrupted?: Interruption;
  abort?: "requested" | "confirmed";
  outcomeUnknown?: boolean;
};

// `fallback` is set when any round was answered by the OpenRouter fallback; `mixed` when other rounds of the same reply came from the primary.
// `accounting`: spend-accounting diagnostics from every round, for the owner. `incomplete`: notes that a reply was cut off or partly dropped.
// Neither is ever put into `input`, so no later model turn sees them as prose.
export type ChatOutcome = { text: string; calls: CallRecord[]; rounds: number; capped: boolean; fallback?: FallbackInfo; mixed?: boolean; accounting?: string[]; incomplete?: string[] };

const def = (t: ChatTool): ToolDef => ({ name: t.name, description: t.description, parameters: t.parameters });

const merge = (into: string[], more: readonly string[] | undefined) => {
  for (const m of more ?? []) if (!into.includes(m)) into.push(m);
};

// A later round failed: the error that reaches the caller also carries the diagnostics of the rounds before it. Built as a NEW error,
// never by editing the original's message: a ProviderError keeps its kind, reset time, code and (as `cause`) the original; its message is
// composed once from the bare text and the deduplicated list, so a diagnostic that appears in both rounds is named once.
export function withEarlierAccounting(err: unknown, earlier: readonly string[]): unknown {
  if (!earlier.length || !(err instanceof Error)) return err;
  if (err instanceof ProviderError) {
    const all: string[] = [...earlier];
    merge(all, err.accounting);
    if (all.length === (err.accounting?.length ?? 0) && all.every((a) => err.accounting?.includes(a))) return err;
    return new ProviderError(err.kind, err.base, err.resetsAt, err.code, all, err);
  }
  const wrapped = new Error(`${err.message} Spend accounting from earlier rounds: ${earlier.join("; ")}.`, { cause: err });
  wrapped.name = err.name;
  return wrapped;
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);

export async function runChat(options: {
  model: ModelPort;
  messages: Item[];
  limits: string[];
  notes?: string;
  tools: ChatTool[];
  // Policy hook: returns an error string when the call is refused.
  allow?: (tool: string) => string | undefined;
  maxRounds?: number;
  // Whether the paid fallback model may answer these rounds. Off unless the caller says so: only the interactive owner chat does.
  fallback?: boolean;
  // Called after each tool call has run, with exactly what the model is about to see. A thread stores it here, call by call,
  // so a later failure cannot lose the calls that already happened. A throw ends the turn.
  onCall?: (done: { call_id: string; name: string; arguments: string; output: string; record: CallRecord }) => void | Promise<void>;
  // Execution deadline for one tool call (a tool's own `deadlineMs` wins). Tests pass a few milliseconds.
  toolDeadlineMs?: number;
  // How long to wait, after asking an overdue call to stop, to see whether it did.
  abortGraceMs?: number;
  // Cancels the turn: the model request in flight is aborted, a running tool call is asked to stop, and nothing new starts.
  signal?: AbortSignal;
  // Told when a call that the turn stopped waiting for ends later. Only for logging: the turn is over and nothing is written for it.
  onLate?: (late: { name: string; ok: boolean; error?: string }) => void;
}): Promise<ChatOutcome> {
  const { model, limits, notes, tools, allow } = options;
  const maxRounds = options.maxRounds ?? MAX_ROUNDS;
  if (!model.step) throw new Error("This model cannot call tools.");
  const byName = new Map(tools.map((t) => [t.name, t]));
  const input: Item[] = [...options.messages];
  const calls: CallRecord[] = [];
  let fallback: FallbackInfo | undefined;
  let primaryRounds = 0;
  const accounting: string[] = [];
  const incomplete: string[] = [];
  const provenance = () => ({
    ...(fallback ? { fallback, ...(primaryRounds ? { mixed: true } : {}) } : {}),
    ...(accounting.length ? { accounting: [...accounting] } : {}),
    ...(incomplete.length ? { incomplete: [...incomplete] } : {}),
  });

  for (let round = 0; ; round++) {
    const capped = round >= maxRounds;
    // At the cap the model gets no tools, so it has to answer with what it has.
    let step;
    try {
      if (options.signal?.aborted) throw new TurnInterrupted("cancelled", undefined, 0, "The turn was cancelled before the next model request. Nothing further was run.");
      step = await model.step(input, limits, notes, capped ? [] : tools.map(def), { fallback: options.fallback === true, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (err) {
      // Diagnostics from earlier rounds are not lost because a later round failed.
      throw withEarlierAccounting(err, accounting);
    }
    merge(accounting, step.accounting);
    merge(incomplete, step.incomplete);
    if (step.fallback) fallback = step.fallback;
    else primaryRounds += 1;
    if (!step.calls.length || capped) {
      const text =
        step.text ||
        (capped ? `I stopped after ${maxRounds} rounds of tool calls without reaching an answer. Calls made are listed below.` : "");
      return { text, calls, rounds: round, capped: capped && step.calls.length > 0, ...provenance() };
    }
    const bound: Bound = {
      deadlineMs: options.toolDeadlineMs ?? TOOL_DEADLINE_MS,
      graceMs: options.abortGraceMs ?? TOOL_ABORT_GRACE_MS,
      signal: options.signal,
      onLate: options.onLate,
    };
    for (const [i, call] of step.calls.entries()) {
      const left = step.calls.length - i;
      // A cancelled turn starts no new tool call.
      if (options.signal?.aborted) throw new TurnInterrupted("cancelled", undefined, left, `The turn was cancelled. ${notStartedText(left)}`);
      input.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments });
      const { output, record } = await execute(call.name, call.arguments, byName, allow, bound);
      calls.push(record);
      input.push({ type: "function_call_output", call_id: call.call_id, output });
      await options.onCall?.({ call_id: call.call_id, name: call.name, arguments: call.arguments, output, record });
      // The call that was cut off is on record (above); the turn ends here, exactly once. No later call starts and the model is not
      // asked again, so a call that is still running cannot be followed by more effects in this turn.
      if (record.interrupted) throw new TurnInterrupted(record.interrupted, record, left - 1, interruptedText(record, bound, left - 1));
    }
  }
}

type Bound = { deadlineMs: number; graceMs: number; signal?: AbortSignal; onLate?: (late: { name: string; ok: boolean; error?: string }) => void };

const secs = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);
const notStartedText = (n: number) => (n ? `${n} tool call${n === 1 ? "" : "s"} the model asked for ${n === 1 ? "was" : "were"} not started.` : "");

// The text the thread shows for an interrupted turn. It says what is known and nothing more.
function interruptedText(r: CallRecord, b: Bound, notStarted: number): string {
  const why = r.interrupted === "timeout" ? `did not finish within ${secs(b.deadlineMs)}` : "was still running when the turn was cancelled";
  const status = r.outcomeUnknown
    ? `Its outcome is UNKNOWN: it may still complete, so it is not reported as failed. ORBIT did not retry it and will not repeat it on its own; check the record it would change before asking for it again.`
    : r.abort === "requested"
      ? "It only reads, and no result from it was used."
      : r.ok
        ? "It completed during the grace period; its result is recorded, but the turn was not continued."
        : "It stopped when asked; no result from it was used.";
  return `The tool call ${r.name} ${why}, so ORBIT stopped waiting${r.abort ? ` and asked it to stop (${r.abort === "requested" ? "it had not stopped when the turn ended" : "it stopped"})` : ""}. ${status} The turn ended here.${notStarted ? ` ${notStartedText(notStarted)}` : ""}`;
}

async function execute(
  name: string,
  rawArgs: string,
  byName: Map<string, ChatTool>,
  allow: ((tool: string) => string | undefined) | undefined,
  bound: Bound,
): Promise<{ output: string; record: CallRecord }> {
  let args: Record<string, unknown> = {};
  const fail = (error: string) => ({
    output: JSON.stringify({ ok: false, error }),
    record: { name, args, ok: false, summary: error } as CallRecord,
  });
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("Arguments must be a JSON object.");
    args = parsed;
  } catch {
    return fail("Arguments were not valid JSON.");
  }
  const tool = byName.get(name);
  if (!tool) return fail(`No tool named ${name}.`);
  const refused = allow?.(name);
  if (refused) return fail(refused);
  const success = (result: Result<unknown>, extra: Partial<CallRecord> = {}, note?: Record<string, unknown>) => {
    const body = JSON.stringify({ ok: true, provenance: result.provenance, source: result.source, ...note, result: result.value });
    return {
      output: clip(body, MAX_OUTPUT_CHARS),
      record: { name, args, ok: true, provenance: result.provenance, source: result.source, summary: clip(JSON.stringify(result.value) ?? "", 300), ...extra },
    };
  };
  const message = (err: unknown) => (err instanceof Error ? err.message : "tool failed");

  // The call runs under its own controller. Its promise is observed from the start, so a rejection that comes after ORBIT stopped
  // waiting is never unhandled, and a late result only reaches onLate (logging), never the conversation.
  const ctl = new AbortController();
  type Settled = { ok: true; value: Result<unknown> } | { ok: false; err: unknown };
  let settled: Settled | undefined;
  let waiting = true;
  const done: Promise<void> = Promise.resolve()
    .then(() => tool.run(args, { signal: ctl.signal }))
    .then(
      (value) => void (settled = { ok: true, value }),
      (err) => void (settled = { ok: false, err }),
    )
    .then(() => {
      if (waiting || !settled) return;
      try {
        bound.onLate?.({ name, ok: settled.ok, ...(settled.ok ? {} : { error: message(settled.err) }) });
      } catch {
        // Logging only; a failing logger must not become an unhandled rejection.
      }
    });

  // Wait for whichever comes first: the call ends, its deadline passes, or the turn is cancelled. Every timer and listener is removed.
  const deadline = tool.deadlineMs ?? bound.deadlineMs;
  let why: Interruption | undefined;
  await new Promise<void>((resolve) => {
    let open = true;
    const finish = (reason?: Interruption) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      bound.signal?.removeEventListener("abort", onAbort);
      if (reason && !settled) why = reason;
      resolve();
    };
    const onAbort = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), deadline);
    if (bound.signal?.aborted) finish("cancelled");
    else bound.signal?.addEventListener("abort", onAbort, { once: true });
    void done.then(() => finish());
  });

  if (!why) {
    waiting = false;
    const s = settled!;
    return s.ok ? success(s.value) : fail(message(s.err));
  }

  // Overdue or cancelled: ask the call to stop, then give it a short grace period to show whether it did.
  ctl.abort(new Error(why === "timeout" ? `ORBIT stopped waiting after ${secs(deadline)}.` : "The turn was cancelled."));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, bound.graceMs);
    void done.then(() => (clearTimeout(timer), resolve()));
  });
  waiting = false;
  const mayHaveEffect = tool.readOnly !== true;
  const s = settled as Settled | undefined;
  if (s?.ok) {
    // It finished after all (inside the grace period): the outcome is known, so it is recorded as it is.
    return success(s.value, { interrupted: why }, { interrupted: why, note: `Completed after ORBIT's ${secs(deadline)} deadline; the turn ended here.` });
  }
  const abort: "requested" | "confirmed" = s ? "confirmed" : "requested";
  const unknown = mayHaveEffect;
  const error = unknown
    ? `${name} ${why === "timeout" ? `did not finish within ${secs(deadline)}` : "was interrupted by a cancellation"}. Its outcome is UNKNOWN, not failed: it may have taken effect or may still complete. ORBIT did not retry it. Do not call it again until its effect has been checked (read the record it changes) and Rai has asked for it again.`
    : `${name} ${why === "timeout" ? `did not finish within ${secs(deadline)}` : "was interrupted by a cancellation"}; no result was used. It only reads, so nothing changed.`;
  return {
    output: JSON.stringify({ ok: false, outcome: unknown ? "unknown" : "no_result", interrupted: why, abort, retried: false, error }),
    record: { name, args, ok: false, summary: clip(error, 300), interrupted: why, abort, ...(unknown ? { outcomeUnknown: true } : {}) },
  };
}

// Actions with effects outside the conversation wait here for a click on Confirm: launching a job, and
// steering one (a steered runner has push access, and tool results can carry text written by others).
// ops_admin is a server operation (restart, deploy, rollback, orbit.env change, vault refresh). The proposal carries what Rai is
// shown (a summary, masked settings) and a digest of the exact validated action and arguments; the arguments themselves stay with
// ORBIT's admin ledger (src/ops-admin.ts), so a proposal listing never holds a setting value in full.
export type ProposalAction =
  // `duplicates`: recent jobs whose brief matches this one (src/duplicates.ts). A warning only.
  | { kind: "job_launch"; routine: string; brief: string; duplicates?: { job: string; similarity: number; state: string; launchedAt?: string }[] }
  | { kind: "job_steer"; job: string; text: string }
  | { kind: "ops_admin"; action: MutatingAction; summary: string; display: Record<string, string> | null; digest: string }
  // Tier 3 (OS updates, reboot, orbit-jobs Funnel): same shape, plus the impact and recovery warnings the owner must see.
  | { kind: "ops_sys"; action: SysMutatingAction; summary: string; display: Record<string, string>; warnings: string[]; digest: string }
  // A vault edit AGENTS.md section 4 protects. The exact validated edit stays with src/vault/tools.ts; the proposal carries what Rai
  // is shown, the reasons it needs him, and a digest of the exact edit and reasons.
  | { kind: "vault_edit"; action: string; summary: string; display: Record<string, string>; digest: string; reasons: string[] };
export type Proposal = ProposalAction & { id: string; createdAt: string; expiresAt: string };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 20;

export function proposals(now: () => Date = () => new Date()) {
  const open = new Map<string, Proposal>();
  const sweep = () => {
    for (const [id, p] of open) if (new Date(p.expiresAt) <= now()) open.delete(id);
  };
  return {
    propose(action: ProposalAction, ttlMs: number = PROPOSAL_TTL_MS): Proposal {
      sweep();
      while (open.size >= MAX_PROPOSALS) open.delete(open.keys().next().value!);
      const at = now();
      const p: Proposal = { ...action, id: randomUUID(), createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString() };
      open.set(p.id, p);
      return p;
    },
    // Looks without consuming (the confirm route checks the digest before it spends the proposal).
    peek(id: string): Proposal | undefined {
      sweep();
      return open.get(id);
    },
    // Removes the proposal: a confirm or a cancel can happen once.
    take(id: string): Proposal | undefined {
      sweep();
      const p = open.get(id);
      open.delete(id);
      return p;
    },
    list: () => (sweep(), [...open.values()]),
  };
}
export type Proposals = ReturnType<typeof proposals>;
