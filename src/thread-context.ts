import type { Item, Message, ModelPort } from "./model.ts";
import { detectProtocolText, REPLAY_PLACEHOLDER } from "./tool-protocol.ts";
import { hasContent, maskContent, maskText, ThreadError } from "./threads.ts";
import { carryGaps, mechanicalDigest, renderPage, renderSections, requestSummary, rollPrompt, sourceDigest, summaryBlock } from "./rolling-summary.ts";
import type { Gap, PageEntry } from "./rolling-summary.ts";
import type { StoredCall, Summary, Thread, ThreadMessage, Threads } from "./threads.ts";

// What the model is sent for a thread, and per-thread compaction. Everything comes from the stored thread, never from
// what the browser sends. docs/threads.md documents the budgets.

// Compaction starts when the messages after the summary hold more than CONTEXT_BUDGET_CHARS characters (text plus tool
// arguments and results; about 12k tokens). It then summarizes the oldest messages and keeps at least KEEP_RECENT_CHARS
// characters and KEEP_RECENT_MESSAGES messages, starting at a user message, verbatim.
export const CONTEXT_BUDGET_CHARS = 48_000;
export const KEEP_RECENT_CHARS = 16_000;
export const KEEP_RECENT_MESSAGES = 4;
export const SUMMARY_MAX_CHARS = 6_000;

// The stored summary, only if it has content. A stored summary with no usable text (written by an older version, or damaged)
// is ignored: it covers nothing, so every message after the start of the thread is still sent, and the next compaction
// replaces it. Nothing is ever hidden behind an empty summary.
export const usableSummary = (t: Thread): Summary | undefined => (t.summary && hasContent(t.summary.text) ? t.summary : undefined);
export const coveredCount = (t: Thread): number => usableSummary(t)?.covers ?? 0;
export const summaryUnusable = (t: Thread): boolean => Boolean(t.summary) && !usableSummary(t);

export const messageChars = (m: ThreadMessage): number =>
  m.text.length + (m.calls ?? []).reduce((n, c) => n + c.arguments.length + c.output.length, 0);

export const liveChars = (t: Thread): number => t.messages.slice(coveredCount(t)).reduce((n, m) => n + messageChars(m), 0);

// Stored text is data. Whatever delimiter a summary or tool result tries to close is neutralized before it is placed in a block.
export const neutralize = (s: string): string => s.replace(/<\s*\/?\s*orbit-data/gi, "‹orbit-data");
export const dataBlock = (name: string, body: string): string => `<orbit-data name="${name}">\n${neutralize(body)}\n</orbit-data>`;

// The model input for the next turn: messages after the summary, with every tool call followed by its result. A call and its
// result are stored together and never separated, and call ids are made unique across the whole input.

// How a stored call ended, in words: a call cut off by a deadline or a cancellation is never called "failed" (docs/tool-deadlines.md).
export const callState = (c: Pick<StoredCall, "ok" | "interrupted" | "outcomeUnknown" | "notRun">): string =>
  c.notRun ? "not run (the reply's tool-result budget was spent; nothing was done)" : c.outcomeUnknown ? "outcome unknown (not retried)" : c.interrupted && !c.ok ? (c.interrupted === "timeout" ? "timed out, no result" : "cancelled, no result") : c.ok ? "ok" : "failed";
// The outcome facts of a stored call that must survive any shortening of history (docs/assistant.md, "Tool rounds and capability
// claims"): whether a write was committed or only proposed, and the ids that point at the authoritative record (proposal, commit,
// job, operation). Read from the call's own JSON output; only short id-shaped values, so no untrusted prose is lifted out of it.
const FACT_KEYS = ["status", "saved", "launched", "executed", "proposalId", "commit", "jobId", "opId"] as const;
export function callFacts(c: Pick<StoredCall, "output">): string {
  let r: unknown;
  try {
    r = (JSON.parse(c.output) as { result?: unknown } | null)?.result;
  } catch {
    return "";
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return "";
  const out: string[] = [];
  for (const k of FACT_KEYS) {
    const v = (r as Record<string, unknown>)[k];
    if (typeof v === "boolean") out.push(`${k} ${v}`);
    else if (typeof v === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(v)) out.push(`${k} ${v}`);
  }
  return out.join(", ");
}
// callState plus those facts, for every place a call is shown in shortened form.
export const callOutcome = (c: Pick<StoredCall, "ok" | "interrupted" | "outcomeUnknown" | "notRun" | "output">): string => {
  const f = c.ok ? callFacts(c) : "";
  return f ? `${callState(c)}: ${f}` : callState(c);
};

// What a stored assistant reply contributes to a later model request. A reply that is tool-call markup written as text (stored before
// ORBIT rejected such responses, src/tool-protocol.ts) is replaced by a short placeholder, so it can neither teach the model to write
// calls as text nor be mistaken for a call. Only assistant text is checked: a user's message is always sent exactly as typed, even when
// it quotes such markup. The stored message is never changed.
export const replayText = (m: Pick<ThreadMessage, "role" | "text">): string => (m.role === "assistant" && detectProtocolText(m.text) ? REPLAY_PLACEHOLDER : m.text);

export function buildItems(t: Thread): Item[] {
  const items: Item[] = [];
  const used = new Set<string>();
  const unique = (id: string) => {
    let out = id || "call";
    for (let n = 2; used.has(out); n++) out = `${id}~${n}`;
    used.add(out);
    return out;
  };
  for (const m of t.messages.slice(coveredCount(t))) {
    if (m.status === "pending") continue;
    if (m.role === "user") {
      // Photo references only; src/photo-context.ts loads the bounded set that is sent.
      items.push({ role: "user", content: m.text, ...(m.attachments?.length ? { images: m.attachments.map((a) => ({ id: a.id })) } : {}) });
      continue;
    }
    for (const c of m.calls ?? []) {
      const id = unique(c.callId);
      items.push({ type: "function_call", call_id: id, name: c.name, arguments: c.arguments });
      items.push({ type: "function_call_output", call_id: id, output: c.output });
    }
    if (m.text.trim() && m.status !== "error") items.push({ role: "assistant", content: replayText(m) });
  }
  return items;
}

// For a model that cannot call tools: text turns only.
export function buildMessages(t: Thread): Message[] {
  return t.messages
    .slice(coveredCount(t))
    .filter((m) => m.status !== "pending" && (m.text.trim() || m.attachments?.length) && m.status !== "error")
    .map((m) => ({ role: m.role, content: replayText(m), ...(m.role === "user" && m.attachments?.length ? { images: m.attachments.map((a) => ({ id: a.id })) } : {}) }));
}

// The summary as a data block for the model's reference material (empty when the thread has none). A rolling summary (one with a
// `version`, docs/rolling-summaries.md) is given in its structured, bounded form with its coverage and gaps; a summary stored before
// rolling summaries is given as its free text, as before.
export function summaryNote(t: Thread): string | undefined {
  const s = usableSummary(t);
  if (!s) return undefined;
  if (s.version) {
    return summaryBlock({
      name: "thread-summary",
      conversation: `chat:${t.id}`,
      version: s.version,
      method: s.method === "model" ? "model" : "mechanical",
      at: s.at,
      covers: `messages 1 to ${s.covers} of this thread`,
      sections: s.sections,
      mechanical: s.mechanical,
      mechanicalDropped: s.mechanicalDropped,
      carried: s.carried,
      gaps: s.gaps ?? [],
      olderGaps: s.olderGaps,
      degraded: s.degraded,
      window: [t.messages.length > s.covers ? `IN YOUR CONTEXT BELOW: messages ${s.covers + 1} to ${t.messages.length}, verbatim.` : "IN YOUR CONTEXT BELOW: only the new message."],
      recoveryHint: "Every message is still stored in this thread (Rai can scroll up to it; the Assistant can read it with session_read).",
    });
  }
  return dataBlock(
    "thread-summary",
    `Summary of the first ${s.covers} messages of this thread (${s.method === "model" ? "model-written" : "mechanical digest"}${s.degraded ? "; DEGRADED, see the note below" : ""}; all messages are still stored; it may be incomplete or wrong, and an outcome in it is not verified):\n${s.text}${s.degraded ? `\n\nNote: ${s.degraded}` : ""}`,
  );
}

// ---- compaction ------------------------------------------------------------------------------------------------------

// A deterministic digest used when no real model is connected or the model's summary fails. It keeps the shape of the thread
// (who said what, which tools ran and whether they worked), not the detail. It is bounded by SUMMARY_MAX_CHARS, and whatever
// that bound drops is named in the text itself and returned as `lossy`, so a digest never passes for a complete one.
export function extractiveDigest(prior: string | undefined, older: ThreadMessage[]): { text: string; lossy?: string } {
  const lines = older.map((m) => {
    const tools = (m.calls ?? []).map((c) => `${c.name}:${callOutcome(c)}`).join(", ");
    return `- ${m.role}: ${m.text.replace(/\s+/g, " ").slice(0, 200)}${m.attachments?.length ? ` [${m.attachments.length} photo(s)]` : ""}${tools ? ` [tools: ${tools}]` : ""}`;
  });
  const notes: string[] = [];
  let head = "";
  if (prior) {
    if (prior.length > 2500) notes.push(`the earlier summary was cut from ${prior.length} to its first 2500 characters`);
    head = `${prior.slice(0, 2500)}\n`;
  }
  let room = SUMMARY_MAX_CHARS - head.length - 200;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.length + 1 > room) break;
    room -= lines[i]!.length + 1;
    kept.unshift(lines[i]!);
  }
  const dropped = lines.length - kept.length;
  if (dropped) notes.push(`the digest has no room for the ${dropped} oldest of ${lines.length} newly summarized messages`);
  const lossy = notes.length ? `This digest is incomplete: ${notes.join("; ")}. All messages are still stored.` : undefined;
  const text = `${head}${lossy ? `[${lossy}]\n` : ""}${kept.join("\n")}`;
  return { text, ...(lossy ? { lossy } : {}) };
}

export const extractiveSummary = (prior: string | undefined, older: ThreadMessage[]): string => extractiveDigest(prior, older).text;

// Where the summarized part ends: the index of the first message that stays verbatim. Undefined when nothing can be summarized.
export function compactionCut(t: Thread, keepChars = KEEP_RECENT_CHARS): number | undefined {
  const covers = coveredCount(t);
  const pending = t.messages.findIndex((m) => m.status === "pending");
  const limit = pending < 0 ? t.messages.length : pending;
  let cut = limit;
  let chars = 0;
  let count = 0;
  while (cut > covers && !(chars >= keepChars && count >= KEEP_RECENT_MESSAGES)) {
    chars += messageChars(t.messages[cut - 1]!);
    count++;
    cut--;
  }
  // Start the kept part at a user message so a turn is never split.
  while (cut > covers && t.messages[cut]?.role !== "user") cut--;
  return cut > covers ? cut : undefined;
}

export type CompactResult = { compacted: boolean; covers?: number; degraded?: string; stale?: true };

// The stored text of a rolling summary: what older code shows and what hasContent checks. The block sent to the model is summaryNote's.
function storedText(s: Pick<Summary, "sections" | "mechanical" | "mechanicalDropped" | "carried">): string {
  return [s.sections ? renderSections(s.sections) : "", s.carried ? `EARLIER SUMMARY (free text, from before structured summaries):\n${s.carried}` : "", s.mechanical?.length ? `MECHANICAL DIGEST (lossy${s.mechanicalDropped ? `; ${s.mechanicalDropped} older line(s) dropped` : ""}):\n${s.mechanical.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
// The previous summary as the summarizer is given it: the structured sections, anything carried mechanically, and the named gaps.
function priorForModel(s: Summary | undefined): string | undefined {
  if (!s) return undefined;
  if (!s.version) return s.text;
  const gaps = (s.gaps ?? []).map((g) => `- ${g.from === g.to ? g.from : `${g.from} to ${g.to}`}: ${g.reason}`);
  return [storedText(s), gaps.length ? `NOT COVERED (keep naming these):\n${gaps.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

// The chat thread's page roll (docs/rolling-summaries.md): when the live part is over budget, the oldest live messages (the outgoing page)
// and the previous summary go to one tool-free summarizer request; a valid structured answer becomes the next summary version, stored with
// its boundary in the same atomic write of the thread file, compare-and-swap on the version and boundary it was made from and on the exact
// source it read. Messages are never changed or removed. A failed, timed-out, malformed or oversize answer is not stored: the previous
// sections are carried forward unchanged with a lossy mechanical digest of the page, flagged degraded and named as a gap (chat threads have
// no hard per-request window, so they cannot wait for a retry without growing the request). If even that cannot be stored, the thread is
// left exactly as it was and the error is recorded.
export async function compactThread(deps: { threads: Threads; model: ModelPort; id: string; now?: () => Date; budget?: number; timeoutMs?: number }): Promise<CompactResult> {
  const { threads, model, id } = deps;
  const t = threads.get(id);
  const budget = deps.budget ?? CONTEXT_BUDGET_CHARS;
  if (!t || liveChars(t) <= budget) return { compacted: false };
  // The verbatim tail is a third of the budget (KEEP_RECENT_CHARS at the default budget).
  const cut = compactionCut(t, Math.min(KEEP_RECENT_CHARS, Math.floor(budget / 3)));
  if (cut === undefined) return { compacted: false };
  const from = coveredCount(t);
  const older = t.messages.slice(from, cut);
  const prior = usableSummary(t);
  const entries: PageEntry[] = older.map((m, i) => ({ ref: `message ${from + i + 1}`, m }));
  const page = renderPage(entries);
  const covers = `messages ${from + 1} to ${cut}`;
  const attempt = await requestSummary(model, rollPrompt({ conversation: `chat:${id}`, prior: priorForModel(prior), page: page.text, covers }), prior?.sections, deps.timeoutMs);
  const unseen: Gap[] = page.unseen.length ? [{ from: page.unseen[0]!.ref, to: page.unseen.at(-1)!.ref, reason: "did not fit the summarizer's page bound; not seen by it" }] : [];
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const version = (prior?.version ?? 0) + 1;
  const digest = sourceDigest(entries);
  // A free-text summary from before rolling summaries: given to the summarizer as the previous summary, and carried (bounded) if it fails.
  const legacy = prior && !prior.version ? prior.text.slice(0, 2_500) : undefined;
  let next: Summary;
  let degraded: string | undefined;
  if (attempt.ok) {
    const g = carryGaps(prior?.gaps, unseen);
    next = { text: "", covers: cut, at, method: "model", version, sections: attempt.sections, gaps: g.gaps, olderGaps: (prior?.olderGaps ?? 0) + g.olderGaps, source: { from, digest } };
  } else {
    if (attempt.reason !== "mock") degraded = `The model could not summarize: ${attempt.detail}`.slice(0, 300);
    const mech = mechanicalDigest(entries, prior?.mechanical);
    const lossy = mech.dropped ? `This digest is incomplete: it has no room for the ${mech.dropped} oldest of ${mech.dropped + mech.lines.length} digest lines. All messages are still stored.` : undefined;
    if (lossy) degraded = degraded ? `${degraded} ${lossy}` : lossy;
    const g = carryGaps(prior?.gaps, [{ from: `message ${from + 1}`, to: `message ${cut}`, reason: attempt.reason === "mock" ? "no model is connected: mechanical digest only" : `summarized mechanically only (${attempt.detail.slice(0, 160)})` }, ...unseen]);
    next = {
      text: "",
      covers: cut,
      at,
      method: "extractive",
      version,
      ...(prior?.sections ? { sections: prior.sections } : {}),
      ...(legacy ? { carried: legacy } : prior?.carried ? { carried: prior.carried } : {}),
      mechanical: mech.lines,
      mechanicalDropped: (prior?.mechanicalDropped ?? 0) + mech.dropped,
      gaps: g.gaps,
      olderGaps: (prior?.olderGaps ?? 0) + g.olderGaps,
      source: { from, digest },
      ...(degraded ? { degraded: maskText(degraded) } : {}),
    };
  }
  next.text = storedText(next);
  try {
    if (!hasContent(maskContent(next.text))) throw new Error("the summary was empty");
    // Compare-and-swap: stored only if the thread still has the summary this was made from and the page still holds exactly what was read.
    threads.setSummary(id, next, degraded, { version: prior?.version ?? 0, covers: from, check: (x) => sourceDigest(x.messages.slice(from, cut).map((m, i) => ({ ref: `message ${from + i + 1}`, m }))) === digest });
    return { compacted: true, covers: cut, ...(degraded ? { degraded } : {}) };
  } catch (err) {
    if (err instanceof ThreadError && err.code === 409) return { compacted: false, stale: true };
    // Nothing was stored and the cutoff did not move: every original message is still sent to the model.
    threads.setCompactionError(id, `Could not summarize, so nothing was compacted and the full thread is sent: ${err instanceof Error ? err.message : String(err)}${degraded ? ` (${degraded})` : ""}`);
    return { compacted: false };
  }
}
