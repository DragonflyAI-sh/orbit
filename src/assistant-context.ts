import type { Item, Message } from "./model.ts";
import { buildItems, buildMessages, callState, messageChars } from "./thread-context.ts";
import type { Thread, ThreadMessage } from "./threads.ts";
import { MAX_MESSAGE_CHARS } from "./threads.ts";

// The Assistant's bounded model context (docs/assistant.md). Pure functions: the store (src/assistant-store.ts) decides which
// chunks are active; this module decides exactly what of them the model is sent, and guarantees a hard size bound.
//
// Unit: characters of conversation content, counted the way chat threads count them (messageChars: message text plus every tool
// call's arguments and output). About 4 characters per token, so the defaults below are roughly 8k, 3k and 13k tokens.

// Complete chunks kept active (not archived) when their bounded sizes, newest first, add up to at most this.
export const ASSISTANT_ACTIVE_BUDGET_CHARS = 32_000;
// No single chunk (one turn: the user message, the reply and its tool calls with results) is sent larger than this.
export const ASSISTANT_CHUNK_MAX_CHARS = 12_000;
// The conversation part of one model input: active history plus the new user message. The new message is at most
// MAX_MESSAGE_CHARS (20,000), so the whole active window (32,000) always fits beside it.
export const ASSISTANT_CONTEXT_BUDGET_CHARS = ASSISTANT_ACTIVE_BUDGET_CHARS + MAX_MESSAGE_CHARS;
// Reference material (vault excerpts, devices) given to an Assistant turn is cut to this many characters.
export const ASSISTANT_NOTES_MAX_CHARS = 12_000;
// At most this many proposal cards (newest) are described to the model as reference material.
export const ASSISTANT_CARD_LINES_MAX = 20;

// Inside a bounded chunk: a tool output or a message text is cut to these sizes before anything is dropped.
export const BOUNDED_OUTPUT_CHARS = 1_500;
export const BOUNDED_TEXT_CHARS = 4_000;

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

// The bounded representation of one chunk: at most `cap` characters, with every tool call still followed by its own result.
export function boundChunk(chunk: ChunkLike, cap: number = ASSISTANT_CHUNK_MAX_CHARS): BoundedChunk {
  const full = chunk.messages;
  const fullChars = total(full);
  if (fullChars <= cap) return { messages: full, chars: fullChars, form: "full" };

  const clipped = full.map((m) => ({
    ...m,
    text: cut(m.text, BOUNDED_TEXT_CHARS, "this message", chunk.seq),
    ...(m.calls ? { calls: m.calls.map((c) => ({ ...c, output: cut(c.output, BOUNDED_OUTPUT_CHARS, `the output of ${c.name}`, chunk.seq) })) } : {}),
  }));
  const clippedChars = total(clipped);
  if (clippedChars <= cap) return { messages: clipped, chars: clippedChars, form: "clipped" };

  // Tool calls are dropped as whole pairs (the call and its result together), so no call is ever sent without its output.
  const noCalls = clipped.map((m) => {
    if (!m.calls?.length) return m;
    const list = m.calls.map((c) => `${c.name} (${callState(c)})`).join(", ").slice(0, 400);
    const note = `[ORBIT: ${m.calls.length} tool call(s) of this turn are omitted from the model's context to stay within budget: ${list}. They are stored in full in assistant chunk ${chunk.seq}.]`;
    // An errored reply's own text is not sent (as in chat threads); the note is, so the model knows calls happened.
    const text = m.status === "error" || m.status === "interrupted" ? note : `${note}\n${m.text}`;
    return { ...m, calls: [], text, status: "done" as const };
  });
  const noCallsChars = total(noCalls);
  if (noCallsChars <= cap) return { messages: noCalls, chars: noCallsChars, form: "calls-omitted" };

  const placeholder: ThreadMessage[] = [
    { id: `${chunk.id}:placeholder`, role: "assistant", at: chunk.createdAt, status: "done", text: `[ORBIT: the turn stored as assistant chunk ${chunk.seq} (${chunk.createdAt}, ${fullChars} characters) is too large for the model's context and is omitted. It is stored in full.]`.slice(0, cap) },
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
  return {
    included: picked.map((p) => ({ seq: p.chunk.seq, form: p.b.form, chars: p.b.chars })),
    omitted,
    historyChars: total(history),
    currentChars,
    budgetChars: budget,
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
