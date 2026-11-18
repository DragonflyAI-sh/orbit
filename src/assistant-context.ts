import type { Item, Message } from "./model.ts";
import { buildItems, buildMessages, callFacts, callOutcome, messageChars } from "./thread-context.ts";
import type { Thread, ThreadMessage } from "./threads.ts";
import { prChunkFact, prChunkFactOf, prChunkStreams } from "./pr-continuation.ts";
import { MAX_MESSAGE_CHARS } from "./threads.ts";

// The Assistant's bounded model context (docs/assistant.md). Pure functions: the store (src/assistant-store.ts) decides which
// chunks are active; this module decides exactly what of them the model is sent, and guarantees a hard size bound.
//
// Unit: characters of conversation content, counted the way chat threads count them (messageChars: message text plus every tool
// call's arguments and output). About 4 characters per token, so the defaults below are roughly 12k, 3k and 17k tokens (estimates).
// Sizing: docs/reviews/assistant-history-sizing-audit.md (approved "modest" option: 48,000 / 68,000, floor 4, per-turn cap 12,000).

// Complete chunks kept active (not archived) when their bounded sizes, newest first, add up to at most this: the history ceiling.
export const ASSISTANT_ACTIVE_BUDGET_CHARS = 48_000;
// No single chunk (one turn: the user message, the reply and its tool calls with results) is sent larger than this.
export const ASSISTANT_CHUNK_MAX_CHARS = 12_000;
// The conversation part of one model input: active history plus the new user message. The new message is at most
// MAX_MESSAGE_CHARS (20,000), so the whole active window (48,000) always fits beside it: 68,000.
export const ASSISTANT_CONTEXT_BUDGET_CHARS = ASSISTANT_ACTIVE_BUDGET_CHARS + MAX_MESSAGE_CHARS;
// The floor: the newest this-many complete turns (when that many exist) are always kept active and always sent, each in its bounded
// form (at most ASSISTANT_CHUNK_MAX_CHARS). It is a consequence of the budgets, not an override of them: the hard budgets always win,
// and assertBudgetInvariants (run below, at module load) refuses any set of constants under which the floor would need more room
// than the budgets give. Precedence, highest first: (1) the newest user message, reserved before any history and cut only at
// MAX_MESSAGE_CHARS; (2) the hard context budget; (3) the floor; (4) further turns, newest first and contiguous, while they fit.
export const ASSISTANT_MIN_TURNS = 4;
// Reference material (vault excerpts, devices) given to an Assistant turn is cut to this many characters.
export const ASSISTANT_NOTES_MAX_CHARS = 12_000;
// At most this many proposal cards (newest) are described to the model as reference material.
export const ASSISTANT_CARD_LINES_MAX = 20;

// Inside a bounded chunk: a tool output or a message text is cut to these sizes before anything is dropped.
export const BOUNDED_OUTPUT_CHARS = 1_500;
export const BOUNDED_TEXT_CHARS = 4_000;

// The floor holds by construction when (a) the history ceiling holds ASSISTANT_MIN_TURNS bounded turns and (b) the context budget
// holds the whole history ceiling beside the largest new message. Returns what is wrong, or [] when the constants are consistent.
export function budgetProblems(b: { active: number; chunkMax: number; context: number; messageMax: number; minTurns: number }): string[] {
  const out: string[] = [];
  if (!(Number.isInteger(b.minTurns) && b.minTurns >= 1)) out.push(`the floor (${b.minTurns}) must be a whole number of turns, at least 1`);
  if (b.active < b.minTurns * b.chunkMax) out.push(`the history ceiling ${b.active} is below the floor of ${b.minTurns} turns of at most ${b.chunkMax} characters (${b.minTurns * b.chunkMax})`);
  if (b.context < b.active + b.messageMax) out.push(`the context budget ${b.context} cannot hold the history ceiling ${b.active} beside a ${b.messageMax}-character message`);
  return out;
}
export function assertBudgetInvariants(): void {
  const p = budgetProblems({ active: ASSISTANT_ACTIVE_BUDGET_CHARS, chunkMax: ASSISTANT_CHUNK_MAX_CHARS, context: ASSISTANT_CONTEXT_BUDGET_CHARS, messageMax: MAX_MESSAGE_CHARS, minTurns: ASSISTANT_MIN_TURNS });
  if (p.length) throw new Error(`Assistant context budgets are inconsistent: ${p.join("; ")}.`);
}
// A wrong edit of the constants fails at startup (and in every test), never as a silently smaller history.
assertBudgetInvariants();

export type ChunkLike = { seq: number; id: string; createdAt: string; messages: ThreadMessage[] };

// How a chunk is represented in the model input. "full": exactly as stored. "clipped": long tool outputs and texts are cut.
// "calls-omitted": its tool calls (each call with its result, never one without the other) are replaced by a one-line note.
// "placeholder": too large even then; one short note stands for the whole turn. The stored chunk is never changed.
export type ChunkForm = "full" | "clipped" | "calls-omitted" | "placeholder";
export type BoundedChunk = { messages: ThreadMessage[]; chars: number; form: ChunkForm };

const total = (ms: ThreadMessage[]) => ms.reduce((n, m) => n + messageChars(m), 0);
const marker = (what: string, from: number, to: number, seq: number) =>
  `[ORBIT: ${what} cut from ${from} to ${to} characters for the model's context; the full text is stored in assistant chunk ${seq}]`;
const cut = (s: string, keep: number, what: string, seq: number): string => {
  if (s.length <= keep) return s;
  const note = marker(what, s.length, keep, seq);
  return `${s.slice(0, Math.max(0, keep - note.length - 1))}\n${note}`;
};

// A page of a paged session tool carries its nextCursor after the page's items, so cutting the output would drop it, and with it
// the only way a later turn can continue where this one stopped (a turn is capped at MAX_ROUNDS pages). When such an output is cut,
// its cursor is kept whole at the end, inside the same BOUNDED_OUTPUT_CHARS.
export const PAGED_TOOLS = new Set(["session_read", "sessions_list"]);
export const pageCursor = (name: string, output: string): string | undefined => {
  if (!PAGED_TOOLS.has(name)) return undefined;
  try {
    const v = (JSON.parse(output) as { result?: { nextCursor?: unknown } } | null)?.result?.nextCursor;
    return typeof v === "string" && /^[A-Za-z0-9_-]{1,600}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
};
// What a paged tool's output says about continuing: a cursor to continue from, `done` when the page says explicitly that there is no
// next page (a successful result whose nextCursor is null), or undefined when it says nothing usable (a failed call, an output that is
// not JSON, or a cursor ORBIT would not repeat). Missing information is never read as completion, and completion never as missing.
export type PageState = { cursor: string } | { done: true };
export const pageState = (name: string, output: string): PageState | undefined => {
  if (!PAGED_TOOLS.has(name)) return undefined;
  const cursor = pageCursor(name, output);
  if (cursor) return { cursor };
  try {
    const v = JSON.parse(output) as { ok?: unknown; result?: Record<string, unknown> } | null;
    return v && v.ok !== false && v.result && typeof v.result === "object" && Object.hasOwn(v.result, "nextCursor") && v.result.nextCursor === null ? { done: true } : undefined;
  } catch {
    return undefined;
  }
};

// The paging streams of one turn's calls, oldest first, each with its newest state. A stream is one read: session_read of one session
// id in one direction, or sessions_list of one query (its arguments other than cursor and limit, which the cursor is bound to). A call
// that passes a cursor this turn returned continues that cursor's stream, so a continuation (whose direction is in its cursor) is never
// confused with another read of the same session. A newer page supersedes an older one; a page with nextCursor null marks its stream
// complete, so a completed read's older cursor is never offered again. A failed or unreadable page changes nothing.
export type PageStream = { tool: string; identity: string; state: PageState };
const MAX_STREAMS = 8;
const IDENTITY_MAX_CHARS = 300;
const canonicalArgs = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonicalArgs) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalArgs((v as Record<string, unknown>)[k])])) : v;
export function pageStreams(calls: readonly { name: string; arguments: string; output: string }[]): PageStream[] {
  const streams = new Map<string, PageStream>();
  // `${tool}\u0000${scope}\u0000${cursor}` -> the key of the stream whose newest page returned that cursor.
  const chain = new Map<string, string>();
  for (const c of calls) {
    const state = pageState(c.name, c.output);
    if (!state) continue;
    let args: Record<string, unknown>;
    try {
      const v = c.arguments.trim() ? JSON.parse(c.arguments) : {};
      args = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      continue;
    }
    const given = typeof args.cursor === "string" && args.cursor !== "" ? args.cursor : undefined;
    // `scope`: what a cursor is bound to (the session id, or the list query). `first`: the stream a first-page call starts; for
    // session_read the direction is part of it (a continuation leaves `from` out: its cursor carries the direction).
    let scope: string;
    let first: string;
    let identity: string;
    if (c.name === "session_read") {
      if (typeof args.id !== "string" || !args.id) continue;
      const from = args.from === "start" ? "start" : "end";
      scope = JSON.stringify(args.id);
      first = `${scope}\u0000${from}`;
      identity = `id ${scope.slice(1, -1)}${!given && from === "start" ? ", from start" : ""}`;
    } else {
      scope = JSON.stringify(canonicalArgs(Object.fromEntries(Object.entries(args).filter(([k, v]) => k !== "cursor" && k !== "limit" && v !== null && v !== undefined))));
      first = scope;
      identity = `query ${scope}`;
    }
    if (identity.length > IDENTITY_MAX_CHARS) continue;
    // A continuation of a cursor this turn returned joins that stream; one of a cursor from an earlier turn is its own stream.
    const key = given ? (chain.get(`${c.name}\u0000${scope}\u0000${given}`) ?? `${c.name}\u0000${scope}\u0000cursor\u0000${given}`) : `${c.name}\u0000first\u0000${first}`;
    const prior = streams.get(key);
    streams.delete(key);
    streams.set(key, { tool: c.name, identity: prior?.identity ?? identity, state });
    if ("cursor" in state) chain.set(`${c.name}\u0000${scope}\u0000${state.cursor}`, key);
  }
  return [...streams.values()].slice(-MAX_STREAMS);
}

// When a turn's calls are omitted (form "calls-omitted", or the whole turn as a placeholder), each paging stream's newest state is
// still named in the note with what it was reading, so a turn that read many pages (up to MAX_ROUNDS) can still be continued by the
// next one, and a read it finished is said to be finished. Cursors are copied exactly as the tool returned them.
// Chunked pull-request reads (pr_text, pr_diff, pr_check_log) are named the same way by their newest chunk: what they read, the head
// and digest they are pinned to, and the exact arguments of the next chunk, or that the last chunk was read (src/pr-continuation.ts).
// The chunks' own text is not in the note: a later turn that needs it reads those offsets again with the same pins.
const pagingNote = (calls: readonly { name: string; arguments: string; output: string }[]): string =>
  [
    ...pageStreams(calls).map((p) => ("cursor" in p.state ? `${p.tool} (${p.identity}) nextCursor: "${p.state.cursor}"` : `${p.tool} (${p.identity}) complete: nextCursor null, no further page`)),
    ...prChunkStreams(calls).map((s) => prChunkFact(s)),
  ].join("; ");
const PAGING_NOTE_INTRO = "Paging state at the end of this turn (newest page of each read; a cursor is kept whole so reading can continue from where it stopped, with the same id or query; a complete read has no cursor to continue from):";
// Likewise a write or proposal's outcome facts (status, proposal id, commit; thread-context callFacts) are kept whole at the end of a
// cut output, so a shortened history still says whether something was committed or only proposed, and under which id.
const cutOutput = (name: string, output: string, seq: number): string => {
  if (output.length <= BOUNDED_OUTPUT_CHARS) return output;
  const page = pageState(name, output);
  const chunk = page ? undefined : prChunkFactOf(name, output, true);
  const facts = page || chunk ? "" : callFacts({ output });
  if (!page && !chunk && !facts) return cut(output, BOUNDED_OUTPUT_CHARS, `the output of ${name}`, seq);
  const keep = page
    ? "cursor" in page
      ? `[ORBIT: this page's nextCursor, kept whole so reading can continue from where it stopped] nextCursor: "${page.cursor}"`
      : `[ORBIT: this page's nextCursor, kept from its full result] nextCursor: null (this was the last page: the read is complete)`
    : chunk
      ? `[ORBIT: this chunk's continuation, kept whole from its full result] ${chunk}`
      : `[ORBIT: this call's outcome, kept whole from its full result] ${facts}`;
  const tail = `\n${marker(`the output of ${name}`, output.length, BOUNDED_OUTPUT_CHARS, seq)}\n${keep}`;
  return `${output.slice(0, Math.max(0, BOUNDED_OUTPUT_CHARS - tail.length))}${tail}`;
};

// The bounded representation of one chunk: at most `cap` characters, with every tool call still followed by its own result.
export function boundChunk(chunk: ChunkLike, cap: number = ASSISTANT_CHUNK_MAX_CHARS): BoundedChunk {
  const full = chunk.messages;
  const fullChars = total(full);
  if (fullChars <= cap) return { messages: full, chars: fullChars, form: "full" };

  const clipped = full.map((m) => ({
    ...m,
    text: cut(m.text, BOUNDED_TEXT_CHARS, "this message", chunk.seq),
    ...(m.calls ? { calls: m.calls.map((c) => ({ ...c, output: cutOutput(c.name, c.output, chunk.seq) })) } : {}),
  }));
  const clippedChars = total(clipped);
  if (clippedChars <= cap) return { messages: clipped, chars: clippedChars, form: "clipped" };

  // Tool calls are dropped as whole pairs (the call and its result together), so no call is ever sent without its output.
  const noCalls = clipped.map((m, mi) => {
    if (!m.calls?.length) return m;
    // Each call's outcome facts (committed or only proposed, and the ids) come with it, so dropping the pair never drops the evidence.
    // Read from the stored (full) call: a clipped output is no longer JSON.
    const list = (full[mi]!.calls ?? m.calls).map((c) => `${c.name} (${callOutcome(c)})`).join(", ").slice(0, 1200);
    // A gallery shown in this turn stays addressable ("the second one") even when its photos_show call is omitted: its ordered refs.
    const shown = (m.gallery ?? []).map((g, i) => `gallery ${i + 1}: ${g.refs.map((r, j) => `${j + 1}=${r}`).join(", ")}`).join("; ");
    const paging = pagingNote(full[mi]!.calls ?? []);
    const note = `[ORBIT: ${m.calls.length} tool call(s) of this turn are omitted from the model's context to stay within budget: ${list}. They are stored in full in assistant chunk ${chunk.seq}.${paging ? ` ${PAGING_NOTE_INTRO} ${paging}.` : ""}${shown ? ` Photos displayed to Rai in this turn (display only, never seen by the model), by position: ${shown}.` : ""}]`;
    // An errored reply's own text is not sent (as in chat threads); the note is, so the model knows calls happened.
    const text = m.status === "error" || m.status === "interrupted" ? note : `${note}\n${m.text}`;
    return { ...m, calls: [], text, status: "done" as const };
  });
  const noCallsChars = total(noCalls);
  if (noCallsChars <= cap) return { messages: noCalls, chars: noCallsChars, form: "calls-omitted" };

  // Even a placeholder keeps the turn's paging state when it fits (whole, never cut), so a read it left open or finished is not lost.
  const paging = pagingNote(full.flatMap((m) => m.calls ?? []));
  const bare = `[ORBIT: the turn stored as assistant chunk ${chunk.seq} (${chunk.createdAt}, ${fullChars} characters) is too large for the model's context and is omitted. It is stored in full.]`;
  const withPaging = paging ? `${bare.slice(0, -1)} ${PAGING_NOTE_INTRO} ${paging}.]` : bare;
  const placeholder: ThreadMessage[] = [
    { id: `${chunk.id}:placeholder`, role: "assistant", at: chunk.createdAt, status: "done", text: withPaging.length <= cap ? withPaging : bare.slice(0, cap) },
  ];
  return { messages: placeholder, chars: total(placeholder), form: "placeholder" };
}

export type ContextPlan = {
  // Chunks sent, oldest first, in their bounded form.
  included: { seq: number; form: ChunkForm; chars: number }[];
  // Active, complete chunks that did not fit this time (oldest ones). They are not sent; the next rotation archives them.
  omitted: number[];
  historyChars: number;
  currentChars: number;
  budgetChars: number;
  // The floor for this plan: `available` = min(ASSISTANT_MIN_TURNS, complete turns that exist); `met` when at least that many newest
  // turns are sent. With the module's own budgets it is always met (budgetProblems); a caller passing a smaller budget can get `met:
  // false`, and then the hard budget has won: nothing is ever sent over the budget to reach the floor.
  floor: { turns: number; available: number; met: boolean };
  messages: ThreadMessage[];
};

// What the model is sent: the newest complete chunks that fit, oldest first, then the current turn's user message. Contiguous:
// once a chunk does not fit, no older chunk is sent, so the model never sees a gap in the middle of the conversation.
export function planContext(complete: ChunkLike[], current: ThreadMessage[] = [], budget = ASSISTANT_CONTEXT_BUDGET_CHARS): ContextPlan {
  // The current user message is already capped at MAX_MESSAGE_CHARS where it is stored; this cut keeps the bound for any caller.
  const now = current
    .filter((m) => m.status !== "pending")
    .map((m) => ({ ...m, text: m.text.length > MAX_MESSAGE_CHARS ? m.text.slice(0, MAX_MESSAGE_CHARS) : m.text, calls: [] }));
  const currentChars = total(now);
  let room = budget - currentChars;
  const picked: { chunk: ChunkLike; b: BoundedChunk }[] = [];
  const sorted = [...complete].sort((a, b) => b.seq - a.seq);
  let i = 0;
  for (; i < sorted.length; i++) {
    const b = boundChunk(sorted[i]!, Math.min(ASSISTANT_CHUNK_MAX_CHARS, budget));
    if (b.chars > room) break;
    room -= b.chars;
    picked.unshift({ chunk: sorted[i]!, b });
  }
  const omitted = sorted.slice(i).map((c) => c.seq).sort((a, b) => a - b);
  const history = picked.flatMap((p) => p.b.messages);
  const available = Math.min(ASSISTANT_MIN_TURNS, sorted.length);
  return {
    included: picked.map((p) => ({ seq: p.chunk.seq, form: p.b.form, chars: p.b.chars })),
    omitted,
    historyChars: total(history),
    currentChars,
    budgetChars: budget,
    floor: { turns: ASSISTANT_MIN_TURNS, available, met: picked.length >= available },
    messages: [...history, ...now],
  };
}

// The plan as model input, through the same builders chat threads use (call ids made unique across the input).
const asThread = (messages: ThreadMessage[]): Thread => ({ schema: 1, id: "assistant", title: "Assistant", titleSet: true, createdAt: "", updatedAt: "", archived: false, rev: 0, messages, cards: [] });
export const planItems = (plan: ContextPlan): Item[] => buildItems(asThread(plan.messages));
export const planMessages = (plan: ContextPlan): Message[] => buildMessages(asThread(plan.messages));

// Reference material cut to its cap, saying so. Cut at a line break where possible.
export function boundNotes(notes: string | undefined, cap = ASSISTANT_NOTES_MAX_CHARS): string | undefined {
  if (!notes || notes.length <= cap) return notes;
  const note = `\n[ORBIT: reference material cut from ${notes.length} to about ${cap} characters for the Assistant's context]`;
  let head = notes.slice(0, cap - note.length);
  const nl = head.lastIndexOf("\n");
  if (nl > head.length / 2) head = head.slice(0, nl);
  return `${head}${note}`;
}
