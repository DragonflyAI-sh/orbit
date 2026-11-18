import { pageCursor } from "./assistant-context.ts";
import { callFacts } from "./thread-context.ts";
import { prChunkFactOf } from "./pr-continuation.ts";

// The per-reply budget for current-turn tool exchanges (docs/assistant.md, "Tool-result budget"). Shared by every runChat caller:
// chat threads, the Assistant and the legacy /chat route.
//
// Why it exists: every model request of a reply re-sends every earlier tool call and result of that reply, and nothing else bounds
// their sum (each output is clipped on its own, but there is no limit on calls per round or on the reply total). The sizing audit
// (docs/reviews/assistant-history-sizing-audit.md, sections 6 and 9) measured ~103k characters of results by the last tool step of a
// heavy 5-round reply and ~490k at 20 rounds.
//
// Unit: UTF-8 bytes of ORBIT's own serialization of each input item as it is added to `input` (the ledger is exact for that, tested;
// the request on the wire adds array separators, and the fallback route re-encodes items in its own format, so it is a close bound
// for the wire, not an exact count of it):
// JSON.stringify({ type: "function_call", call_id, name, arguments }) and JSON.stringify({ type: "function_call_output", call_id,
// output }). Bytes, not characters, so non-ASCII text (up to 3 bytes per UTF-16 unit) and JSON escaping (up to 6 bytes for a control
// character) are counted as they travel. The paid fallback's hard request cap is in bytes too (MAX_REQUEST_BYTES, src/openrouter.ts).
//
// What it is NOT: a whole-request admission controller. It does not count the instructions, the tool schemas, the reference material,
// the history, the user's message, tool-supplied images (bounded separately by the media gate) or the model's output. ORBIT does not
// know the model's context window on its primary route, so no window figure is assumed here.

// The cap. Justification (docs/assistant.md, "Tool-result budget"; all figures from the audit's reproducible SYNTHETIC fixtures):
// - the audit's bound case (heavy history, maximum reference material, a 20,000-character message, 48,000/68,000 history budgets)
//   has a first request of 135,806 characters (ASCII, so bytes). 300,000 (the only hard request-size limit in the code) minus that
//   leaves ~164k; 96,000 keeps ~68k of it for what this budget does not count (tool schemas the audit could not wire, item framing of
//   other items, non-ASCII history) instead of spending it all;
// - it is below the ~103k a heavy reply already reaches in 5 rounds (the ceiling before #120), so it binds heavy replies well before
//   the current 20 rounds;
// - it is above the ~19k a typical 5-round reply adds, so typical replies are not changed;
// - it holds the largest single tool output whole (vault_policy, 42,000 characters, ASCII) with room left for other calls.
export const REPLY_TOOL_RESULT_BUDGET_BYTES = 96_000;
// The least room a call may start with: its own call item plus this much for its result. Enough for the head of a result, ORBIT's cut
// note and the facts kept whole (ok, provenance, source, outcome facts, a paging cursor of at most 600 characters). When less is left,
// the call is not run.
export const TOOL_RESULT_MIN_BYTES = 2_048;

export const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");
export const callItemBytes = (c: { call_id: string; name: string; arguments: string }): number =>
  utf8Bytes(JSON.stringify({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.arguments }));
export const outputItemBytes = (call_id: string, output: string): number => utf8Bytes(JSON.stringify({ type: "function_call_output", call_id, output }));

export const CUT_CURSOR_NOTE =
  "this cursor is after the whole page, including the part cut away above; to see the rest of this page, read it again with the cursor this call used, not this one";

// The facts of a result that must survive any cut: whether it succeeded, where it came from, its outcome ids, and a paging cursor.
// Read from the full (uncut) output; anything unreadable is left out rather than guessed.
export function keptFacts(name: string, output: string): string {
  let top: Record<string, unknown> = {};
  try {
    const v = JSON.parse(output) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) top = v as Record<string, unknown>;
  } catch {
    // Not JSON (for example already cut by the tool's own bound): only the cursor and facts below can be read, and they need JSON too.
  }
  const parts: string[] = [];
  if (typeof top.ok === "boolean") parts.push(`ok ${top.ok}`);
  if (typeof top.outcome === "string") parts.push(`outcome ${top.outcome.slice(0, 40)}`);
  if (typeof top.provenance === "string") parts.push(`provenance ${top.provenance.slice(0, 20)}`);
  if (typeof top.source === "string") parts.push(`source ${top.source.slice(0, 120)}`);
  const facts = callFacts({ output });
  if (facts) parts.push(facts);
  if (typeof top.error === "string") parts.push(`error ${JSON.stringify(top.error.slice(0, 300))}`);
  // The cursor is kept whole, but it points past the WHOLE page, including the part cut away for the model: continuing from it would
  // skip rows the model never saw. So it says so, and says how to get the rest of this page (review of PR #123, finding 1).
  const cursor = pageCursor(name, output);
  if (cursor) parts.push(`nextCursor "${cursor}" (${CUT_CURSOR_NOTE})`);
  // A chunked pull-request read keeps its continuation (pins and the exact next arguments) whole, and says how to see the cut chunk.
  const chunk = prChunkFactOf(name, output, true);
  if (chunk) parts.push(chunk);
  return parts.join(", ");
}

// A tool name in ORBIT's own notes, bounded: the name comes from the model and an unknown one is not checked against the tool list.
const shortName = (name: string) => (name.length > 80 ? `${name.slice(0, 80)}…` : name);
const BUDGET_MARK = (name: string, from: number, budget: number) =>
  `[ORBIT: the output of ${shortName(name)} was cut from ${from} bytes to fit this reply's tool-result budget (${budget} bytes for all tool calls and results of one reply). It is INCOMPLETE: the rest did not reach you, so do not treat anything missing as absent or the result as complete. The full output is stored with the conversation.]`;
const KEPT = (facts: string) => `[ORBIT: kept whole from the full result] ${facts}`;

// `output` cut so that its function_call_output item is at most `maxItemBytes` bytes: the head of the output, then ORBIT's note, then
// the kept facts. Never splits a UTF-16 surrogate pair. When even the note does not fit, a minimal JSON note with the kept facts is
// returned, and if even that does not fit, a fixed one of under 100 bytes plus the call id (runChat admits a call only when its output
// item framing, call id included, plus TOOL_RESULT_MIN_BYTES fits, so the result always stays within the bound).
export function fitOutput(name: string, call_id: string, output: string, maxItemBytes: number, budget: number = REPLY_TOOL_RESULT_BUDGET_BYTES): string {
  if (outputItemBytes(call_id, output) <= maxItemBytes) return output;
  const facts = keptFacts(name, output);
  const tail = `\n${BUDGET_MARK(name, utf8Bytes(output), budget)}${facts ? `\n${KEPT(facts)}` : ""}`;
  const fits = (n: number) => outputItemBytes(call_id, output.slice(0, n) + tail) <= maxItemBytes;
  if (fits(0)) {
    let lo = 0;
    let hi = output.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    // Do not end the head on a lone high surrogate.
    let n = lo;
    if (n > 0 && /[\uD800-\uDBFF]/.test(output[n - 1]!)) n -= 1;
    return output.slice(0, n) + tail;
  }
  const minimal = (f: string) => JSON.stringify({ ok: false, outcome: "cut", error: `ORBIT cut the output of ${shortName(name)} (${utf8Bytes(output)} bytes) to fit this reply's tool-result budget; it is incomplete and nothing in it was used.`, kept: f });
  let f = facts;
  while (f && outputItemBytes(call_id, minimal(f)) > maxItemBytes) f = f.slice(0, Math.floor(f.length / 2));
  if (outputItemBytes(call_id, minimal(f)) <= maxItemBytes) return minimal(f);
  return JSON.stringify({ ok: false, outcome: "cut", error: "cut to fit the tool-result budget; incomplete" });
}

// What a call that was not started returns to the conversation record (never to the model in this reply: see runChat). Explicitly
// not a success and not a failure of the tool: nothing ran.
export const NOT_RUN_ERROR = (budget: number) =>
  `ORBIT did not run this call: this reply's tool-result budget (${budget} bytes for all tool calls and results of one reply) had no room left for it. Nothing was done; ask again in a new reply.`;
export const notRunOutput = (budget: number) => JSON.stringify({ ok: false, outcome: "not_run", notRun: true, error: NOT_RUN_ERROR(budget) });

// The owner-visible note on a reply whose tool-result budget stopped further tool calls. Never part of the reply text.
export const RESULT_BUDGET_NOTE = (budget: number, notRun: number, cut: number) =>
  `This reply's tool results reached ORBIT's per-reply budget (${budget} bytes), so its last step was answered without tools.${cut ? ` ${cut} tool output${cut === 1 ? " was" : "s were"} cut to fit (the full output${cut === 1 ? " is" : "s are"} stored).` : ""}${notRun ? ` ${notRun} requested tool call${notRun === 1 ? " was" : "s were"} not run.` : ""} Anything not shown as a completed tool call was not done; ask again (for example "continue") for a fresh budget.`;
