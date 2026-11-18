import { runChat } from "../src/agent.ts";
import type { ChatTool, ResultBudgetOutcome } from "../src/agent.ts";
import { ASSISTANT_ACTIVE_BUDGET_CHARS, ASSISTANT_CHUNK_MAX_CHARS, planContext } from "../src/assistant-context.ts";
import type { ChunkForm } from "../src/assistant-context.ts";
import { ASSISTANT_ID, assistantStore } from "../src/assistant-store.ts";
import type { Item, ModelPort, Step, ToolDef } from "../src/model.ts";
import { responsesInput } from "../src/model.ts";
import { MAX_MESSAGE_CHARS } from "../src/threads.ts";
import type { ThreadMessage } from "../src/threads.ts";
import { REPLY_TOOL_RESULT_BUDGET_BYTES } from "../src/tool-result-budget.ts";

// SYNTHETIC workloads for the Assistant history-sizing audit (docs/reviews/assistant-history-sizing-audit.md). Everything here is
// invented: no ORBIT state, no vault, no provider, no live chat is read or called. The sizes are chosen to be representative shapes,
// not measurements of Rai's use. The numbers come from ORBIT's own code paths: the Assistant store's real rotation
// (src/assistant-store.ts), its real context planner (planContext, boundChunk) and the real tool loop (runChat, clipOutput).
//
// Token figures are ESTIMATES. ORBIT has no tokenizer: the code documents "about 4 characters per token" (src/assistant-context.ts) and
// bounds tokens by request bytes for spend reservations (src/openrouter.ts reservationUsd). Both are reported: `estTokens` = ceil(chars
// / 4), `maxTokens` = UTF-8 bytes (an upper bound; the synthetic text is ASCII, so bytes = chars).

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const estTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);

// Deterministic filler text: plain words, nothing secret-shaped, so ORBIT's masking (maskContent) leaves it unchanged.
const WORDS = "the plan for the vault note keeps the job state and the open question about the deploy window and the review".split(" ");
export function filler(n: number, seed = 0): string {
  let s = "";
  for (let i = seed; s.length < n; i++) s += `${WORDS[i % WORDS.length]} `;
  return s.slice(0, n);
}
// A JSON tool output of exactly `n` characters (or a little more for tiny n), shaped like a real tool result.
export function toolOutput(n: number, seed = 0): string {
  const shell = JSON.stringify({ ok: true, provenance: "live", source: "synthetic", result: { text: "" } });
  return JSON.stringify({ ok: true, provenance: "live", source: "synthetic", result: { text: filler(Math.max(0, n - shell.length), seed) } });
}

// ---- synthetic turns -------------------------------------------------------------------------------------------------
// One Assistant turn: the user message, the reply text and the reply's tool calls (arguments + output sizes, in characters).
export type TurnShape = { user: number; reply: number; calls: { args: number; output: number }[] };
export const TURNS: Record<"small" | "typical" | "heavy", TurnShape> = {
  // A quick question and short answer, no tools.
  small: { user: 160, reply: 500, calls: [] },
  // A question answered with two reads (for example a job status and a vault note).
  typical: { user: 400, reply: 1_400, calls: [{ args: 120, output: 2_400 }, { args: 120, output: 1_200 }] },
  // A research-style turn: four reads, two of them at the 8,000-character tool output clip (MAX_OUTPUT_CHARS).
  heavy: { user: 1_200, reply: 3_000, calls: [{ args: 200, output: 8_000 }, { args: 200, output: 8_000 }, { args: 200, output: 4_000 }, { args: 200, output: 2_000 }] },
};
export const turnChars = (t: TurnShape) => t.user + t.reply + t.calls.reduce((n, c) => n + c.args + c.output, 0);

// Histories: the sequence of turn kinds, oldest first. 120 turns each, so every option reaches its steady state.
const cycle = (kinds: (keyof typeof TURNS)[], n: number) => Array.from({ length: n }, (_, i) => kinds[i % kinds.length]!);
export const HISTORIES: Record<"small" | "typical" | "heavy", (keyof typeof TURNS)[]> = {
  small: cycle(["small"], 120),
  // Mostly typical turns with some quick ones and an occasional heavy one.
  typical: cycle(["small", "typical", "typical", "small", "typical", "heavy"], 120),
  heavy: cycle(["heavy"], 120),
};

// ---- history options -------------------------------------------------------------------------------------------------
// `active`: ASSISTANT_ACTIVE_BUDGET_CHARS (rotation and history ceiling). The context budget is active + MAX_MESSAGE_CHARS, exactly as
// ASSISTANT_CONTEXT_BUDGET_CHARS is built, so the whole active window always fits beside the largest new message. The per-chunk
// cap stays ASSISTANT_CHUNK_MAX_CHARS (12,000) in every option. `floorTurns`: complete turns that always fit (active / chunk cap).
// "before" is the audited commit 32bfcc7 (run here through today's code with its ceiling); "after" is the code now. The audit's third,
// larger option was not approved and is no longer measured (its figures stay in the audit's section 9 as of 32bfcc7).
export type HistoryOption = { id: string; label: string; active: number };
export const OPTIONS: HistoryOption[] = [
  { id: "before", label: "Before (32bfcc7)", active: 32_000 },
  { id: "after", label: "After (current code)", active: ASSISTANT_ACTIVE_BUDGET_CHARS },
];
export const contextBudget = (o: HistoryOption) => o.active + MAX_MESSAGE_CHARS;
export const floorTurns = (o: HistoryOption) => Math.floor(o.active / ASSISTANT_CHUNK_MAX_CHARS);

export type Retention = {
  option: string;
  history: string;
  turnsStored: number;
  turnsActive: number;
  turnsSent: number;
  forms: Partial<Record<ChunkForm, number>>;
  historyChars: number;
  historyEstTokens: number;
  currentChars: number;
};

// Runs a history through the real Assistant store (in memory) with the option's active budget, then plans the next turn's context with
// the option's context budget. The store's own rotation decides what stays active; planContext decides what is sent.
export function retention(option: HistoryOption, history: keyof typeof HISTORIES, currentChars = 400): Retention {
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const store = assistantStore(undefined, { activeBudget: option.active, now: () => new Date((clock += 1000)) });
  HISTORIES[history].forEach((kind, i) => {
    const t = TURNS[kind];
    const token = store.tryBegin(ASSISTANT_ID)!;
    store.appendUser(ASSISTANT_ID, filler(t.user, i));
    const mid = store.beginAssistant(ASSISTANT_ID);
    t.calls.forEach((c, j) =>
      store.addCall(ASSISTANT_ID, mid, { callId: `c${i}_${j}`, name: "synthetic_read", arguments: JSON.stringify({ q: filler(Math.max(0, c.args - 9), j) }), output: toolOutput(c.output, i + j), ok: true, provenance: "live", source: "synthetic", summary: "synthetic", at: new Date(clock).toISOString() }),
    );
    store.patchMessage(ASSISTANT_ID, mid, { text: filler(t.reply, i + 3), status: "done" });
    store.end(ASSISTANT_ID, token);
  });
  const active = store.active();
  const current: ThreadMessage[] = [{ id: "now", role: "user", at: "", text: filler(currentChars, 7) }];
  const plan = planContext(active.filter((c) => c.state === "complete"), current, contextBudget(option));
  const forms: Partial<Record<ChunkForm, number>> = {};
  for (const p of plan.included) forms[p.form] = (forms[p.form] ?? 0) + 1;
  return {
    option: option.id,
    history,
    turnsStored: HISTORIES[history].length,
    turnsActive: active.length,
    turnsSent: plan.included.length,
    forms,
    historyChars: plan.historyChars,
    historyEstTokens: estTokens(plan.historyChars),
    currentChars: plan.currentChars,
  };
}

// ---- reference material (retrieved context) --------------------------------------------------------------------------
// The Assistant's reference material: vault excerpts + the device summary (cut to ASSISTANT_NOTES_MAX_CHARS, 12,000), the session
// activity digest (DIGEST_TOTAL_MAX_CHARS, 6,000) and at most 20 proposal card lines. The "max" row is the code's bound for notes and
// digest; card lines have no character bound, so 250 characters per line is an ESTIMATE. The other rows are SYNTHETIC.
export const RETRIEVED: Record<"light" | "typical" | "max", { notes: number; digest: number; cards: number }> = {
  light: { notes: 700, digest: 1_200, cards: 0 },
  typical: { notes: 6_000, digest: 2_500, cards: 1_000 },
  max: { notes: 12_000, digest: 6_000, cards: 20 * 250 },
};
export const retrievedChars = (r: { notes: number; digest: number; cards: number }) => r.notes + r.digest + r.cards;

// ---- current-turn tool rounds ----------------------------------------------------------------------------------------
// One round's tool calls: each call's argument and output size. Outputs go through the real clip (MAX_OUTPUT_CHARS, 8,000).
export const ROUND_LOADS: Record<"light" | "typical" | "heavy", { args: number; output: number }[]> = {
  light: [{ args: 80, output: 600 }],
  typical: [{ args: 120, output: 2_500 }, { args: 120, output: 1_500 }],
  // Three reads at (or over) the clip: what a page of session_read or a long vault note can produce.
  heavy: [{ args: 200, output: 12_000 }, { args: 200, output: 8_000 }, { args: 200, output: 8_000 }],
};

export type RoundsRun = {
  load: string;
  maxRounds: number;
  // The reply's tool-result budget the run used (bytes); NO_RESULT_BUDGET reproduces the code before it existed.
  budgetBytes: number;
  // Characters and UTF-8 bytes of the conversation part of each model request (responsesInput JSON), step 0 .. last.
  stepInputChars: number[];
  stepInputBytes: number[];
  steps: number;
  capped: boolean;
  resultBudget?: ResultBudgetOutcome;
};
// A budget no synthetic run reaches: the loop as it was before the tool-result budget (audited commit 32bfcc7).
export const NO_RESULT_BUDGET = Number.MAX_SAFE_INTEGER;

// Runs the real tool loop (runChat) with a scripted model that calls the load's tools in every step it may, and a synthetic read tool.
// Returns the size of the conversation input of every model request. Nothing outside this process is touched.
export async function rounds(load: keyof typeof ROUND_LOADS, maxRounds: number, history: Item[], budgetBytes: number = REPLY_TOOL_RESULT_BUDGET_BYTES): Promise<RoundsRun> {
  const calls = ROUND_LOADS[load];
  const stepInputChars: number[] = [];
  const stepInputBytes: number[] = [];
  let n = 0;
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/history-audit", detail: "synthetic", verifiedAt: "" }),
    reply: async () => ({ value: "unused", provenance: "live", source: "model/fake" }),
    step: async (input: Item[], _limits: string[], _notes: string | undefined, tools: ToolDef[]): Promise<Step> => {
      const body = JSON.stringify(responsesInput(input));
      stepInputChars.push(body.length);
      stepInputBytes.push(Buffer.byteLength(body, "utf8"));
      const i = n++;
      if (!tools.length) return { text: "final answer", calls: [] };
      return { text: "", calls: calls.map((c, j) => ({ call_id: `r${i}_${j}`, name: "synthetic_read", arguments: JSON.stringify({ q: filler(Math.max(0, c.args - 9), j), size: c.output }) })) };
    },
  };
  const tool: ChatTool = {
    name: "synthetic_read",
    description: "Synthetic read for the history-sizing audit.",
    parameters: { type: "object", properties: { q: { type: "string" }, size: { type: "number" } }, required: ["q", "size"] },
    readOnly: true,
    run: async (args) => ({ value: { text: filler(Number(args.size), 1) }, provenance: "live", source: "synthetic" }),
  };
  const out = await runChat({ model, messages: history, limits: [], tools: [tool], maxRounds, resultBudgetBytes: budgetBytes });
  return { load, maxRounds, budgetBytes, stepInputChars, stepInputBytes, steps: stepInputChars.length, capped: out.capped, ...(out.resultBudget ? { resultBudget: out.resultBudget } : {}) };
}

// A history as model input items, from a retention plan's size alone: one user/assistant pair per kept turn is not needed for the
// round growth, which only adds to whatever the history is. So the round runs start from one synthetic message of the history's size.
export const historyItems = (historyChars: number, currentChars = 400): Item[] => [
  ...(historyChars ? [{ role: "assistant" as const, content: filler(historyChars, 2) }] : []),
  { role: "user" as const, content: filler(currentChars, 7) },
];

// ---- one request, all parts ------------------------------------------------------------------------------------------
export type Occupancy = { fixed: number; retrieved: number; history: number; current: number; toolResults: number; total: number; estTokens: number };
// `fixedChars`: instructions (without reference material) + tool schemas, measured from a real Assistant turn (test/history-audit.test.ts).
export function occupancy(fixedChars: number, retrieved: number, historyChars: number, currentChars: number, stepInput: number, step0Input: number): Occupancy {
  const toolResults = Math.max(0, stepInput - step0Input);
  const total = fixedChars + retrieved + historyChars + currentChars + toolResults;
  return { fixed: fixedChars, retrieved, history: historyChars, current: currentChars, toolResults, total, estTokens: estTokens(total) };
}

// ---- the report ------------------------------------------------------------------------------------------------------
// Every table in the audit's "Synthetic measurements" section, built from the functions above and one offline capture of the fixed
// request part (test/history-audit-capture.ts). Deterministic for a given commit: `node tools/history-audit/report.ts` prints it.
export type Fixed = { instructionsChars: number; instructionsFinalChars: number; toolSchemaChars: number; tools: number };

const fmt = (n: number) => n.toLocaleString("en-US");
const row = (cells: (string | number)[]) => `| ${cells.map((c) => (typeof c === "number" ? fmt(c) : c)).join(" | ")} |`;
const formsText = (f: Partial<Record<ChunkForm, number>>) => Object.entries(f).map(([k, v]) => `${v} ${k}`).join(", ") || "none";

export type Scenario = { option: HistoryOption; history: keyof typeof HISTORIES; retrieved: keyof typeof RETRIEVED; load: keyof typeof ROUND_LOADS; maxRounds: number; currentChars: number; budgetBytes?: number };
export type ScenarioResult = {
  scenario: Scenario;
  retention: Retention;
  first: Occupancy;
  // The largest request of the reply (the forced final step carries no tool schemas, so it is not always the last one).
  peak: Occupancy & { step: number };
  final: Occupancy;
  steps: number;
  cumulativeChars: number;
  cumulativeEstTokens: number;
};

export async function scenario(fixed: Fixed, s: Scenario): Promise<ScenarioResult> {
  const ret = retention(s.option, s.history, s.currentChars);
  const run = await rounds(s.load, s.maxRounds, historyItems(ret.historyChars, s.currentChars), s.budgetBytes);
  const retrieved = retrievedChars(RETRIEVED[s.retrieved]);
  const at = (i: number) => {
    // The forced final step (round cap or tool-result budget) is sent without tool schemas.
    const last = i === run.steps - 1 && (run.capped || Boolean(run.resultBudget?.stopped));
    const fixedChars = last ? fixed.instructionsFinalChars : fixed.instructionsChars + fixed.toolSchemaChars;
    return occupancy(fixedChars, retrieved, ret.historyChars, ret.currentChars, run.stepInputChars[i]!, run.stepInputChars[0]!);
  };
  const all = run.stepInputChars.map((_, i) => ({ ...at(i), step: i }));
  const peak = all.reduce((a, b) => (b.total > a.total ? b : a));
  const cumulativeChars = all.reduce((n, o) => n + o.total, 0);
  return { scenario: s, retention: ret, first: all[0]!, peak, final: all.at(-1)!, steps: run.steps, cumulativeChars, cumulativeEstTokens: estTokens(cumulativeChars) };
}

export async function buildReport(fixed: Fixed): Promise<string> {
  const out: string[] = [];
  out.push("All figures below are SYNTHETIC measurements of ORBIT's own code on invented workloads; token figures are ESTIMATES (characters / 4).", "");
  out.push(`Fixed part measured offline (lower bound, ${fixed.tools} tools wired): instructions ${fmt(fixed.instructionsChars)} chars at a tool step, ${fmt(fixed.instructionsFinalChars)} at the forced final step; tool schemas ${fmt(fixed.toolSchemaChars)} chars (not sent at the forced final step).`, "");

  out.push("### Turn shapes", "", row(["turn", "user", "reply", "tool calls", "stored chars", "est. tokens"]), row(["---", "---:", "---:", "---", "---:", "---:"]));
  for (const [k, t] of Object.entries(TURNS)) out.push(row([k, t.user, t.reply, t.calls.length ? t.calls.map((c) => fmt(c.output)).join(" + ") : "none", turnChars(t), estTokens(turnChars(t))]));
  out.push("");

  out.push("### History retention by option (current message 400 chars)", "", row(["option", "active / context budget", "floor (turns)", "history", "turns sent (of 120)", "forms", "history chars", "est. tokens"]), row(["---", "---:", "---:", "---", "---:", "---", "---:", "---:"]));
  for (const o of OPTIONS)
    for (const h of Object.keys(HISTORIES) as (keyof typeof HISTORIES)[]) {
      const r = retention(o, h);
      out.push(row([o.label, `${fmt(o.active)} / ${fmt(contextBudget(o))}`, floorTurns(o), h, r.turnsSent, formsText(r.forms), r.historyChars, r.historyEstTokens]));
    }
  out.push("");

  // Before = the audited commit's history ceiling and no tool-result budget; after = the current code. Same scripted workloads.
  const STATES = [
    { id: "before", option: OPTIONS[0]!, budget: NO_RESULT_BUDGET, label: "before (32,000; no result budget)" },
    { id: "after", option: OPTIONS[1]!, budget: REPLY_TOOL_RESULT_BUDGET_BYTES, label: `after (${fmt(OPTIONS[1]!.active)}; result budget ${fmt(REPLY_TOOL_RESULT_BUDGET_BYTES)} bytes)` },
  ] as const;
  const stopText = (r: RoundsRun) => (r.resultBudget?.stopped && r.capped ? "round cap (result budget also spent)" : r.resultBudget?.stopped ? "result budget" : r.capped ? "round cap" : "answer");

  out.push("### Current-turn tool rounds (real runChat loop, typical history of the current code)", "", row(["load", "max rounds", "result budget", "model requests", "ended by", "calls not run / cut", "tool-result chars added by the last request", "bytes added (serialized)", "est. tokens added"]), row(["---", "---:", "---", "---:", "---", "---", "---:", "---:", "---:"]));
  const hist = retention(OPTIONS[1]!, "typical");
  for (const l of Object.keys(ROUND_LOADS) as (keyof typeof ROUND_LOADS)[])
    for (const m of [5, 20])
      for (const st of STATES) {
        const r = await rounds(l, m, historyItems(hist.historyChars), st.budget);
        const added = r.stepInputChars.at(-1)! - r.stepInputChars[0]!;
        const addedBytes = r.stepInputBytes.at(-1)! - r.stepInputBytes[0]!;
        out.push(row([`${l} (${ROUND_LOADS[l].map((c) => fmt(c.output)).join(" + ")} per round)`, m, st.budget === NO_RESULT_BUDGET ? "none (before)" : fmt(st.budget), r.steps, stopText(r), r.resultBudget ? `${r.resultBudget.notRun} / ${r.resultBudget.cut}` : "0 / 0", added, addedBytes, estTokens(added)]));
      }
  out.push("");

  out.push("### Whole request: before and after (typical history, typical reference material, current message 400 chars)", "");
  out.push(row(["state", "load", "max rounds", "requests", "history turns sent", "first request chars (est. tokens)", "peak request chars, step (est. tokens)", "tool results at peak", "cumulative input est. tokens", "change vs before"]));
  out.push(row(["---", "---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]));
  for (const l of ["typical", "heavy"] as const)
    for (const m of [5, 20]) {
      let beforeCum = 0;
      for (const st of STATES) {
        const r = await scenario(fixed, { option: st.option, history: "typical", retrieved: "typical", load: l, maxRounds: m, currentChars: 400, budgetBytes: st.budget });
        if (st.id === "before") beforeCum = r.cumulativeEstTokens;
        const delta = st.id === "before" ? "" : `${r.cumulativeEstTokens >= beforeCum ? "+" : ""}${Math.round(((r.cumulativeEstTokens - beforeCum) / beforeCum) * 100)}%`;
        out.push(row([st.label, l, m, r.steps, r.retention.turnsSent, `${fmt(r.first.total)} (${fmt(r.first.estTokens)})`, `${fmt(r.peak.total)}, ${r.peak.step} (${fmt(r.peak.estTokens)})`, r.peak.toolResults, r.cumulativeEstTokens, delta]));
      }
    }
  out.push("");

  out.push("### Retained turns by history (current message 400 chars)", "", row(["history", ...STATES.map((st) => st.label)]), row(["---", ...STATES.map(() => "---:")]));
  for (const h of Object.keys(HISTORIES) as (keyof typeof HISTORIES)[]) out.push(row([h, ...STATES.map((st) => retention(st.option, h).turnsSent)]));
  out.push("");

  out.push("### Bound case (heavy history, maximum reference material, 20,000-char message)", "", row(["state", "load", "max rounds", "first request chars", "first est. tokens", "peak request chars", "peak est. tokens", "over 300,000 (fallback request cap)?"]), row(["---", "---", "---:", "---:", "---:", "---:", "---:", "---"]));
  for (const st of STATES)
    for (const [l, m] of [["typical", 5], ["heavy", 5], ["heavy", 20]] as const) {
      const r = await scenario(fixed, { option: st.option, history: "heavy", retrieved: "max", load: l, maxRounds: m, currentChars: MAX_MESSAGE_CHARS, budgetBytes: st.budget });
      out.push(row([st.label, l, m, r.first.total, r.first.estTokens, r.peak.total, r.peak.estTokens, r.peak.total > 300_000 ? "yes (approx.)" : "no"]));
    }
  out.push("");
  return out.join("\n");
}
