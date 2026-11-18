import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGET_NOTE, proposals as newProposals, runChat, TurnInterrupted } from "../src/agent.ts";
import type { CallRecord, ChatTool } from "../src/agent.ts";
import {
  ASSISTANT_ACTIVE_BUDGET_CHARS,
  ASSISTANT_CHUNK_MAX_CHARS,
  ASSISTANT_CONTEXT_BUDGET_CHARS,
  ASSISTANT_MIN_TURNS,
  boundChunk,
  budgetProblems,
  planContext,
  planItems,
} from "../src/assistant-context.ts";
import type { ChunkLike } from "../src/assistant-context.ts";
import { ASSISTANT_ID, assistantStore } from "../src/assistant-store.ts";
import { instructions, recordCheckInstruction, roundGuidance } from "../src/model.ts";
import type { Item, ModelPort, Step, ToolDef, ToolRounds } from "../src/model.ts";
import { CONTEXT_BUDGET_CHARS, KEEP_RECENT_CHARS, KEEP_RECENT_MESSAGES, messageChars, SUMMARY_MAX_CHARS } from "../src/thread-context.ts";
import { threadService } from "../src/thread-service.ts";
import { MAX_MESSAGE_CHARS, threadStore } from "../src/threads.ts";
import type { StoredCall, ThreadMessage } from "../src/threads.ts";
import {
  callItemBytes,
  fitOutput,
  keptFacts,
  outputItemBytes,
  REPLY_TOOL_RESULT_BUDGET_BYTES,
  RESULT_BUDGET_NOTE,
  TOOL_RESULT_MIN_BYTES,
  utf8Bytes,
} from "../src/tool-result-budget.ts";

// The Assistant's rolling-history budgets (48,000 / 68,000, floor 4, per-turn cap 12,000) and the per-reply tool-result budget
// (src/tool-result-budget.ts, runChat). Offline: scripted models, synthetic tools, in-memory stores.

// ---- helpers ---------------------------------------------------------------------------------------------------------------------

const chunkOf = (seq: number, messages: ThreadMessage[]): ChunkLike => ({ seq, id: `id-${seq}`, createdAt: "2026-11-18T00:00:00Z", messages });
const userMsg = (text: string, id = `u${Math.random()}`): ThreadMessage => ({ id, role: "user", at: "t", text });
const replyMsg = (text: string, calls: StoredCall[] = []): ThreadMessage => ({ id: `a${Math.random()}`, role: "assistant", at: "t", text, status: "done", calls });
const callOf = (name: string, output: string, i = 0, args = "{}"): StoredCall => ({ callId: `call_${name}_${i}`, name, arguments: args, output, ok: true, provenance: "live", source: "test", summary: "ok", at: "t" });
// A chunk of exactly `n` characters (user text + reply text).
const exactChunk = (seq: number, n: number) => chunkOf(seq, [userMsg("u".repeat(100)), replyMsg("r".repeat(n - 100))]);

function assertPaired(items: Item[]) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as { type?: string; call_id?: string };
    if (it.type === "function_call") {
      const next = items[i + 1] as { type?: string; call_id?: string } | undefined;
      assert.equal(next?.type, "function_call_output", "a call is followed by its output");
      assert.equal(next?.call_id, it.call_id, "with the same call id");
    }
    if (it.type === "function_call_output") assert.equal((items[i - 1] as { call_id?: string }).call_id, it.call_id, "no orphan output");
  }
}

// The bytes the reply's tool exchanges add to `input`, recomputed independently from the input items.
const exchangeBytes = (input: Item[]) =>
  input.reduce((n, it) => {
    const x = it as { type?: string; call_id?: string; name?: string; arguments?: string; output?: string };
    if (x.type === "function_call") return n + callItemBytes({ call_id: x.call_id!, name: x.name!, arguments: x.arguments! });
    if (x.type === "function_call_output") return n + outputItemBytes(x.call_id!, x.output!);
    return n;
  }, 0);

type Seen = { input: Item[]; tools: string[]; rounds?: ToolRounds };
// A model that asks for `calls(round)` in every step it may call tools, and answers `final` in a step without tools.
function looping(calls: (round: number) => { name: string; args: unknown }[], final = "final answer"): ModelPort & { seen: Seen[] } {
  const seen: Seen[] = [];
  let n = 0;
  return {
    seen,
    status: () => ({ port: "model", state: "live", impl: "fake/budget", detail: "test", verifiedAt: "" }),
    reply: async () => ({ value: "unused", provenance: "live", source: "model/fake" }),
    step: async (input: Item[], _l: string[], _n: string | undefined, tools: ToolDef[], o?: { rounds?: ToolRounds }): Promise<Step> => {
      seen.push({ input: [...input], tools: tools.map((t) => t.name), ...(o?.rounds ? { rounds: o.rounds } : {}) });
      const round = n++;
      const want = calls(round);
      if (!tools.length || !want.length) return { text: final, calls: [] };
      return { text: "", calls: want.map((c, j) => ({ call_id: `r${round}_${j}`, name: c.name, arguments: JSON.stringify(c.args) })) };
    },
  };
}
// A read tool that returns `size` characters of `unit` (default ASCII).
const reader: ChatTool = {
  name: "read",
  description: "synthetic read",
  parameters: { type: "object", properties: {} },
  readOnly: true,
  maxOutputChars: 1_000_000,
  run: async (a) => ({ value: { text: String(a.unit ?? "x").repeat(Number(a.size ?? 10)) }, provenance: "live", source: "test/read" }),
};
const user: Item[] = [{ role: "user", content: "go" }];

// ---- history: ceiling, floor, edges ---------------------------------------------------------------------------------------------

test("constants: ceiling 48,000, context 68,000 (ceiling + 20,000 message cap), per-turn cap 12,000, floor 4; the invariant holds", () => {
  assert.equal(ASSISTANT_ACTIVE_BUDGET_CHARS, 48_000);
  assert.equal(ASSISTANT_CONTEXT_BUDGET_CHARS, 68_000);
  assert.equal(ASSISTANT_CONTEXT_BUDGET_CHARS, ASSISTANT_ACTIVE_BUDGET_CHARS + MAX_MESSAGE_CHARS);
  assert.equal(ASSISTANT_CHUNK_MAX_CHARS, 12_000);
  assert.equal(ASSISTANT_MIN_TURNS, 4);
  assert.ok(ASSISTANT_ACTIVE_BUDGET_CHARS >= ASSISTANT_MIN_TURNS * ASSISTANT_CHUNK_MAX_CHARS);
  assert.deepEqual(budgetProblems({ active: 48_000, chunkMax: 12_000, context: 68_000, messageMax: 20_000, minTurns: 4 }), []);
  // Edges: one character short of either bound is refused, so a wrong edit fails at startup instead of shrinking the floor.
  assert.match(budgetProblems({ active: 47_999, chunkMax: 12_000, context: 67_999, messageMax: 20_000, minTurns: 4 }).join(" "), /below the floor of 4 turns/);
  assert.match(budgetProblems({ active: 48_000, chunkMax: 12_000, context: 67_999, messageMax: 20_000, minTurns: 4 }).join(" "), /cannot hold the history ceiling/);
  assert.match(budgetProblems({ active: 48_000, chunkMax: 12_001, context: 68_000, messageMax: 20_000, minTurns: 4 }).join(" "), /below the floor/);
  assert.equal(budgetProblems({ active: 48_000, chunkMax: 12_000, context: 68_000, messageMax: 20_000, minTurns: 0 }).length, 1);
});

test("exact edges: four turns of exactly 12,000 and a 20,000-char message fill 68,000 exactly and are all sent; a fifth is not", () => {
  const four = [1, 2, 3, 4].map((s) => exactChunk(s, ASSISTANT_CHUNK_MAX_CHARS));
  for (const c of four) assert.equal(boundChunk(c).form, "full");
  const current = [userMsg("m".repeat(MAX_MESSAGE_CHARS))];
  const plan = planContext(four, current);
  assert.deepEqual(plan.included.map((i) => i.seq), [1, 2, 3, 4]);
  assert.equal(plan.historyChars + plan.currentChars, ASSISTANT_CONTEXT_BUDGET_CHARS);
  assert.deepEqual(plan.floor, { turns: 4, available: 4, met: true });
  const five = [exactChunk(0, ASSISTANT_CHUNK_MAX_CHARS), ...four];
  const p5 = planContext(five, current);
  assert.deepEqual(p5.included.map((i) => i.seq), [1, 2, 3, 4], "contiguous newest run; the oldest does not fit");
  assert.deepEqual(p5.omitted, [0]);
  // A 12,001-char turn is bounded (never sent over the cap), and four such turns still fit.
  const over = [1, 2, 3, 4].map((s) => exactChunk(s, ASSISTANT_CHUNK_MAX_CHARS + 1));
  const po = planContext(over, current);
  assert.equal(po.included.length, 4);
  for (const i of po.included) assert.ok(i.chars <= ASSISTANT_CHUNK_MAX_CHARS && i.form !== "full");
  assert.ok(po.historyChars + po.currentChars <= ASSISTANT_CONTEXT_BUDGET_CHARS);
});

test("fewer than four turns: all of them are sent and the floor reports what was available", () => {
  for (const n of [0, 1, 2, 3]) {
    const chunks = Array.from({ length: n }, (_, i) => exactChunk(i + 1, 11_000));
    const plan = planContext(chunks, [userMsg("now")]);
    assert.equal(plan.included.length, n);
    assert.deepEqual(plan.floor, { turns: 4, available: n, met: true });
    assert.deepEqual(plan.omitted, []);
  }
});

test("the newest user message wins: an over-long message is cut to 20,000 and reserved first; the floor still holds beside it", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => exactChunk(i + 1, 11_900));
  const plan = planContext(chunks, [userMsg("N".repeat(35_000), "now")]);
  const last = plan.messages.at(-1)!;
  assert.equal(last.id, "now", "the current message is last");
  assert.equal(last.text.length, MAX_MESSAGE_CHARS);
  assert.equal(plan.currentChars, MAX_MESSAGE_CHARS);
  assert.ok(plan.included.length >= ASSISTANT_MIN_TURNS);
  assert.deepEqual(plan.included.map((i) => i.seq), [7, 8, 9, 10]);
  assert.ok(plan.historyChars + plan.currentChars <= ASSISTANT_CONTEXT_BUDGET_CHARS);
});

test("precedence: a caller's smaller hard budget wins over the floor, which is then reported as not met (never exceeded)", () => {
  const chunks = Array.from({ length: 6 }, (_, i) => exactChunk(i + 1, 10_000));
  const plan = planContext(chunks, [userMsg("x".repeat(1_000))], 25_000);
  assert.equal(plan.included.length, 2);
  assert.deepEqual(plan.floor, { turns: 4, available: 4, met: false });
  assert.ok(plan.historyChars + plan.currentChars <= 25_000);
});

test("randomized: with the module's budgets the four newest complete turns are always sent, beside a 20,000-char message", () => {
  let rnd = 7;
  const r = (n: number) => (rnd = (rnd * 1103515245 + 12345) % 2 ** 31) % n;
  for (let trial = 0; trial < 60; trial++) {
    const chunks: ChunkLike[] = [];
    for (let seq = 1; seq <= 4 + r(20); seq++) {
      const calls = Array.from({ length: r(5) }, (_, i) => callOf(`t${i}`, "o".repeat(r(3) === 0 ? 60_000 : r(4_000)), i, r(6) === 0 ? JSON.stringify({ a: "b".repeat(r(20_000)) }) : "{}"));
      chunks.push(chunkOf(seq, [userMsg("u".repeat(r(2) ? MAX_MESSAGE_CHARS : r(500))), replyMsg("a".repeat(r(30_000)), calls)]));
    }
    const plan = planContext(chunks, [userMsg("c".repeat(MAX_MESSAGE_CHARS))]);
    assert.ok(plan.included.length >= ASSISTANT_MIN_TURNS, `trial ${trial}: ${plan.included.length}`);
    assert.ok(plan.floor.met);
    assert.ok(plan.historyChars + plan.currentChars <= ASSISTANT_CONTEXT_BUDGET_CHARS);
    assertPaired(planItems(plan));
  }
});

test("rotation keeps at least the four newest complete turns active, archives (never deletes) the rest, and planning changes no stored chunk", () => {
  const s = assistantStore(undefined);
  const big = (i: number) => [callOf("read", JSON.stringify({ ok: true, result: { text: "z".repeat(9_000) } }), i), callOf("read", JSON.stringify({ ok: true, result: { text: "y".repeat(9_000) } }), i + 100)];
  for (let i = 0; i < 12; i++) {
    const token = s.tryBegin(ASSISTANT_ID)!;
    s.appendUser(ASSISTANT_ID, `question ${i} ${"q".repeat(2_000)}`);
    const mid = s.beginAssistant(ASSISTANT_ID);
    for (const c of big(i)) s.addCall(ASSISTANT_ID, mid, c);
    s.patchMessage(ASSISTANT_ID, mid, { text: `answer ${i} ${"a".repeat(3_000)}`, status: "done" });
    s.end(ASSISTANT_ID, token);
  }
  const active = s.active();
  assert.ok(active.length >= ASSISTANT_MIN_TURNS);
  assert.equal(active.length + s.archivedCount(), 12, "no turn is lost: every one is active or archived");
  const before = JSON.stringify(s.active());
  const plan = s.plan([userMsg("next")]);
  assert.equal(JSON.stringify(s.active()), before, "planning (bounding, clipping) never changes a stored chunk");
  assert.ok(plan.included.length >= ASSISTANT_MIN_TURNS);
  // The stored outputs are whole; only the model-facing form is clipped.
  assert.ok(active.at(-1)!.messages[1]!.calls!.every((c) => c.output.length > 9_000));
});

test("pagination across clipped history: a session_read page cut in an over-cap turn keeps its nextCursor whole", () => {
  const cursor = "c".repeat(40) + "_page-2";
  const page = JSON.stringify({ ok: true, provenance: "live", source: "sessions", result: { messages: [{ text: "m".repeat(7_000) }], nextCursor: cursor } });
  const chunk = chunkOf(9, [userMsg("read"), replyMsg("x".repeat(3_000), [callOf("session_read", page, 1), callOf("session_read", page, 2)])]);
  const b = boundChunk(chunk);
  assert.equal(b.form, "clipped");
  for (const c of b.messages[1]!.calls!) assert.ok(c.output.includes(`nextCursor: "${cursor}"`));
});

test("chat-thread compaction is not changed by the Assistant history change", () => {
  assert.equal(CONTEXT_BUDGET_CHARS, 48_000);
  assert.equal(KEEP_RECENT_CHARS, 16_000);
  assert.equal(KEEP_RECENT_MESSAGES, 4);
  assert.equal(SUMMARY_MAX_CHARS, 6_000);
});

// ---- the per-reply tool-result budget -------------------------------------------------------------------------------------------

test("budget constant and its relation to the code's other bounds (bytes; the fallback's 300,000-byte request cap)", () => {
  assert.equal(REPLY_TOOL_RESULT_BUDGET_BYTES, 96_000);
  assert.ok(REPLY_TOOL_RESULT_BUDGET_BYTES > 42_000 + TOOL_RESULT_MIN_BYTES, "vault_policy's whole output fits with room to spare");
  // The audit's bound case (first request 135,806 chars, ASCII) plus the whole budget stays under the fallback's cap with ~68k spare.
  assert.ok(135_806 + REPLY_TOOL_RESULT_BUDGET_BYTES <= 300_000 - 60_000);
});

test("early answer: a reply that needs few results is unchanged (no budget note, no outcome field)", async () => {
  const model = looping((r) => (r === 0 ? [{ name: "read", args: { size: 500 } }] : []), "done");
  const out = await runChat({ model, messages: user, limits: [], tools: [reader] });
  assert.equal(out.text, "done");
  assert.equal(out.resultBudget, undefined);
  assert.equal(out.incomplete, undefined);
  assert.equal(out.capped, false);
});

test("many parallel calls in one round: the budget admits what fits, does not run the rest, keeps pairs valid and stops with no tools", async () => {
  const stored: { name: string; output: string; sent?: string; record: CallRecord }[] = [];
  const model = looping(() => Array.from({ length: 40 }, () => ({ name: "read", args: { size: 7_000 } })), "here is what I read");
  const out = await runChat({ model, messages: user, limits: [], tools: [reader], maxRounds: 20, onCall: (d) => void stored.push({ name: d.name, output: d.output, ...(d.sent ? { sent: d.sent } : {}), record: d.record }) });
  const rb = out.resultBudget!;
  assert.ok(rb.stopped);
  assert.ok(rb.usedBytes <= rb.maxBytes);
  assert.equal(model.seen.length, 2, "one tool step, then the final step");
  const last = model.seen.at(-1)!;
  assert.deepEqual(last.tools, [], "the final step offers no tools");
  assert.equal(last.rounds?.stop?.reason, "tool-results");
  assert.equal(last.rounds?.stop?.notRun.length, rb.notRun);
  assertPaired(last.input);
  assert.equal(exchangeBytes(last.input), rb.usedBytes, "the ledger matches the bytes actually added");
  // Every requested call is accounted for: run (whole or cut) or explicitly not run, in order, and the conversation got all 40.
  assert.equal(out.calls.length, 40);
  assert.equal(stored.length, 40);
  const notRun = out.calls.filter((c) => c.notRun);
  assert.equal(notRun.length, rb.notRun);
  assert.ok(notRun.length > 20);
  for (const c of notRun) {
    assert.equal(c.ok, false, "a call that did not run is never reported as successful");
    assert.match(c.summary, /did not run this call/);
  }
  for (const s of stored.filter((x) => x.record.notRun)) assert.deepEqual(JSON.parse(s.output).outcome, "not_run");
  // Not-run calls never reach the model input (neither call nor stub).
  const ids = new Set(last.input.flatMap((it) => ("call_id" in it ? [it.call_id] : [])));
  assert.equal(ids.size, 40 - rb.notRun);
  assert.equal(out.text, "here is what I read");
  assert.ok(out.incomplete?.includes(RESULT_BUDGET_NOTE(REPLY_TOOL_RESULT_BUDGET_BYTES, rb.notRun, rb.cut)));
  assert.equal(out.capped, false, "the round cap did not end it");
});

test("huge output: what the model sees is cut to fit with an explicit marker and kept facts; the full output is what is stored", async () => {
  const stored: { output: string; sent?: string; record: CallRecord }[] = [];
  const model = looping((r) => (r === 0 ? [{ name: "read", args: { size: 300_000 } }] : []), "partial");
  const out = await runChat({ model, messages: user, limits: [], tools: [reader], onCall: (d) => void stored.push({ output: d.output, ...(d.sent ? { sent: d.sent } : {}), record: d.record }) });
  assert.equal(stored.length, 1);
  const s = stored[0]!;
  assert.ok(s.output.length > 300_000, "the stored output is the full output");
  assert.ok(s.sent && utf8Bytes(s.sent) < REPLY_TOOL_RESULT_BUDGET_BYTES);
  assert.match(s.sent!, /cut from \d+ bytes to fit this reply's tool-result budget/);
  assert.match(s.sent!, /INCOMPLETE/);
  assert.match(s.sent!, /kept whole from the full result\] ok true, provenance live, source test\/read/);
  assert.ok(s.record.ok, "a cut output of a successful call is still that call's result");
  assert.deepEqual(s.record.budgetCut, { fromBytes: utf8Bytes(s.output), toBytes: utf8Bytes(s.sent!) });
  assert.equal(out.resultBudget!.cut, 1);
  assert.ok(out.resultBudget!.usedBytes <= REPLY_TOOL_RESULT_BUDGET_BYTES);
  assert.deepEqual(model.seen.at(-1)!.tools, []);
});

test("Unicode and escaping: multi-byte, astral and control characters are counted in bytes and never split a surrogate pair", async () => {
  for (const unit of ["€", "語", "😀", "\u0001", "\""]) {
    const model = looping(() => [{ name: "read", args: { size: 40_000, unit } }]);
    const out = await runChat({ model, messages: user, limits: [], tools: [reader], maxRounds: 20 });
    const last = model.seen.at(-1)!;
    assert.ok(out.resultBudget!.usedBytes <= REPLY_TOOL_RESULT_BUDGET_BYTES, unit);
    assert.equal(exchangeBytes(last.input), out.resultBudget!.usedBytes, unit);
    assert.ok(utf8Bytes(JSON.stringify(last.input)) - utf8Bytes(JSON.stringify(user)) <= REPLY_TOOL_RESULT_BUDGET_BYTES + 64, unit);
    for (const it of last.input) if ("output" in it) assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(it.output), `no lone high surrogate (${unit})`);
  }
  // fitOutput on its own, at small bounds.
  const big = JSON.stringify({ ok: true, provenance: "live", source: "s", result: { text: "😀".repeat(10_000) } });
  for (const max of [TOOL_RESULT_MIN_BYTES, 3_000, 10_001, 50_000]) {
    const f = fitOutput("read", "id1", big, max);
    assert.ok(outputItemBytes("id1", f) <= max, `${max}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(f));
  }
});

test("kept facts: outcome, proposal ids and paging cursors survive a cut; an error stays an error", () => {
  const proposal = JSON.stringify({ ok: true, provenance: "live", source: "jobs", result: { status: "pending_confirmation", proposalId: "prop-123", text: "p".repeat(50_000) } });
  const f = fitOutput("job_launch", "c1", proposal, 4_000);
  assert.match(f, /status pending_confirmation, proposalId prop-123/);
  assert.equal(keptFacts("job_launch", proposal), "ok true, provenance live, source jobs, status pending_confirmation, proposalId prop-123");
  const page = JSON.stringify({ ok: true, provenance: "live", source: "sessions", result: { messages: [{ text: "m".repeat(30_000) }], nextCursor: "abc_DEF-123" } });
  assert.match(fitOutput("session_read", "c2", page, 4_000), /nextCursor "abc_DEF-123"/);
  const err = JSON.stringify({ ok: false, error: `the vault refused it: ${"e".repeat(20_000)}` });
  const fe = fitOutput("vault_write", "c3", err, 3_000);
  assert.ok(fe.startsWith('{"ok":false'));
  assert.match(fe, /kept whole from the full result\] ok false, error "the vault refused it/);
  const unknown = JSON.stringify({ ok: false, outcome: "unknown", interrupted: "timeout", error: "x".repeat(10_000) });
  assert.match(fitOutput("vault_write", "c4", unknown, 3_000), /ok false, outcome unknown/);
});

// Continuing in a new reply after a budget stop, with every message reassembled, is checked in test/session-cursor-contract.test.ts.
test("pagination across current-turn results: every page the model saw, whole or cut, still carries the cursor to continue from", async () => {
  let page = 0;
  const pager: ChatTool = {
    name: "session_read",
    description: "pages",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    run: async () => ({ value: { messages: [{ text: "w".repeat(7_500) }], nextCursor: `cur_${++page}` }, provenance: "live", source: "sessions" }),
  };
  const model = looping(() => [{ name: "session_read", args: { id: "chat:x" } }]);
  const out = await runChat({ model, messages: user, limits: [], tools: [pager], maxRounds: 40 });
  assert.ok(out.resultBudget!.stopped);
  assert.ok(out.rounds < 40, "the budget, not the round cap, ended the read");
  const outputs = model.seen.at(-1)!.input.flatMap((it) => ("output" in it ? [it.output] : []));
  // Every page the model saw still names the cursor to continue from (whole or kept).
  for (const [i, o] of outputs.entries()) assert.match(o, new RegExp(`cur_${i + 1}`));
});

test("synthetic 20-round heavy workload: accumulation is bounded by the budget, the round count does not matter", async () => {
  const heavy = () => [{ name: "read", args: { size: 12_000 } }, { name: "read", args: { size: 8_000 } }, { name: "read", args: { size: 8_000 } }];
  const sizes: number[] = [];
  for (const maxRounds of [5, 20]) {
    const model = looping(heavy);
    const out = await runChat({ model, messages: user, limits: [], tools: [{ ...reader, maxOutputChars: 8_000 }], maxRounds });
    assert.ok(out.resultBudget!.usedBytes <= REPLY_TOOL_RESULT_BUDGET_BYTES);
    for (const s of model.seen) assertPaired(s.input);
    sizes.push(utf8Bytes(JSON.stringify(model.seen.at(-1)!.input)));
  }
  assert.equal(sizes[0], sizes[1]);
  // Without the budget (as before), the same 20-round workload grows far beyond it.
  const model = looping(heavy);
  await runChat({ model, messages: user, limits: [], tools: [{ ...reader, maxOutputChars: 8_000 }], maxRounds: 20, resultBudgetBytes: Number.MAX_SAFE_INTEGER });
  assert.ok(utf8Bytes(JSON.stringify(model.seen.at(-1)!.input)) > 4 * REPLY_TOOL_RESULT_BUDGET_BYTES);
});

test("repeated identical failing calls: no loop past the round cap, failures stay failures, and the ledger still bounds their growth", async () => {
  // There is no repeat-error guard on main (it is part of the separate, unmerged 20-round change); this checks that the budget alone
  // bounds such a loop and never reports a repeated failure as success.
  const thrower: ChatTool = { name: "flaky", description: "fails", parameters: { type: "object", properties: {} }, run: async () => { throw new Error(`refused: ${"E".repeat(9_000)}`); } };
  for (const maxRounds of [5, 20]) {
    const model = looping(() => [{ name: "flaky", args: { same: true } }]);
    const out = await runChat({ model, messages: user, limits: [], tools: [thrower], maxRounds });
    assert.ok(out.calls.length > 0);
    assert.ok(out.calls.every((c) => c.ok === false), "an error (or a call not run) is never shown as success");
    assert.ok(model.seen.length <= maxRounds + 1);
    assert.ok(exchangeBytes(model.seen.at(-1)!.input) <= REPLY_TOOL_RESULT_BUDGET_BYTES);
    if (maxRounds === 20) assert.ok(out.resultBudget?.stopped, "at 20 rounds the budget ends a loop of large repeated errors");
  }
});

test("round cap and result budget together: both owner notes, and the final step says which calls were not run", async () => {
  // Round 0 fills the budget and leaves one call not run; maxRounds 1 makes the next step the round-capped one too.
  const model = looping(() => [{ name: "read", args: { size: 94_500 } }, { name: "read", args: { size: 10 } }]);
  const out = await runChat({ model, messages: user, limits: [], tools: [reader], maxRounds: 1 });
  assert.equal(out.capped, true);
  assert.ok(out.resultBudget!.stopped);
  assert.ok(out.incomplete!.includes(BUDGET_NOTE(1)));
  assert.ok(out.incomplete!.some((n) => /per-reply budget/.test(n)));
  const g = roundGuidance(model.seen.at(-1)!.rounds, false).join("\n");
  assert.match(g, /TOOL-ROUND BUDGET EXHAUSTED/);
  assert.match(g, /did NOT run 1 tool call/);
});

test("final-step instructions for the result budget: no tools, not the round budget, tools not missing, not-run calls named", () => {
  const rounds: ToolRounds = { round: 2, max: 5, offered: ["read", "jobs_list"], stop: { reason: "tool-results", budgetBytes: 96_000, usedBytes: 95_100, notRun: ["read", "read"] } };
  const text = instructions([], undefined, [], rounds);
  assert.match(text, /TOOL-RESULT BUDGET REACHED/);
  assert.doesNotMatch(text, /TOOL-ROUND BUDGET EXHAUSTED/);
  assert.match(text, /not the tool-round budget and not a missing tool/);
  assert.match(text, /did NOT run 2 tool calls you asked for \(read, read\)/);
  assert.match(text, /do not present a partial result as complete/);
  assert.match(recordCheckInstruction([], rounds), /withheld in this final step because this reply's tool-result budget is spent/);
  // A normal tool step is unchanged.
  assert.match(roundGuidance({ round: 0, max: 5, offered: ["read"] }, true).join("\n"), /Tool rounds: this is step 1/);
});

test("cancellation: a cancelled turn ends as before; the budget never turns it into a not-run or a success", async () => {
  const ctl = new AbortController();
  const slow: ChatTool = { ...reader, name: "slow", readOnly: true, run: (_a, ctx) => new Promise((_res, rej) => ctx!.signal.addEventListener("abort", () => rej(new Error("stopped")))) };
  const model = looping(() => [{ name: "slow", args: {} }, { name: "read", args: { size: 10 } }]);
  const p = runChat({ model, messages: user, limits: [], tools: [slow, reader], signal: ctl.signal, abortGraceMs: 5 });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(p, (e: unknown) => e instanceof TurnInterrupted && e.kind === "cancelled" && e.notStarted === 1);
});

test("empty final text after a budget stop: ORBIT's own text says the budget, not the round cap, ended it", async () => {
  const model = looping(() => [{ name: "read", args: { size: 200_000 } }], "");
  const out = await runChat({ model, messages: user, limits: [], tools: [reader] });
  assert.match(out.text, /reached ORBIT's per-reply budget \(96000 bytes\)/);
  assert.doesNotMatch(out.text, /tool-round budget ran out/);
});

test("shared path: a chat thread stores the full output and the not-run calls, and its compaction inputs are the stored calls", async () => {
  const threads = threadStore(undefined);
  const model = looping(() => [{ name: "read", args: { size: 100_000 } }, { name: "read", args: { size: 10 } }], "summary of a partial read");
  const svc = threadService({ threads, model, proposals: newProposals(), budget: 1_000_000 });
  const t = threads.create("budget");
  const r = await svc.turn(t.id, "read everything", { memory: [], limits: [], tools: [reader], isOwner: true });
  assert.equal(r.error, undefined);
  const m = threads.get(t.id)!.messages.at(-1)!;
  assert.equal(m.status, "done");
  assert.equal(m.calls!.length, 2);
  const [cut, notRun] = m.calls!;
  assert.ok(cut!.ok && cut!.budgetCut && cut!.output.length > 100_000, "stored whole, marked as cut for the model");
  assert.equal(notRun!.ok, false);
  assert.equal(notRun!.notRun, "tool-result-budget");
  assert.ok(m.incomplete?.some((n) => /per-reply budget/.test(n)));
  assert.ok(!m.capped);
  assert.ok(messageChars(m) > 100_000, "chat history counts what is stored, exactly as before");
});

test("adversarial ids and names: a long call id or unknown tool name cannot push the ledger over the budget", async () => {
  let n = 0;
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/ids", detail: "test", verifiedAt: "" }),
    reply: async () => ({ value: "unused", provenance: "live", source: "model/fake" }),
    step: async (_input: Item[], _l: string[], _n: string | undefined, tools: ToolDef[]): Promise<Step> => {
      if (!tools.length) return { text: "ok", calls: [] };
      const r = n++;
      return {
        text: "",
        calls: [
          { call_id: `id${r}_${"i".repeat(3_000)}`, name: "read", arguments: JSON.stringify({ size: 30_000 }) },
          { call_id: `u${r}`, name: `no_such_tool_${"n".repeat(5_000)}`, arguments: "{}" },
        ],
      };
    },
  };
  const seen: Item[][] = [];
  const out = await runChat({ model: { ...model, step: async (input, l, no, t, o) => (seen.push([...input]), model.step!(input, l, no, t, o)) }, messages: user, limits: [], tools: [reader], maxRounds: 20 });
  assert.ok(out.resultBudget!.usedBytes <= REPLY_TOOL_RESULT_BUDGET_BYTES);
  assert.equal(exchangeBytes(seen.at(-1)!), out.resultBudget!.usedBytes);
  assertPaired(seen.at(-1)!);
  for (const max of [64, 300, TOOL_RESULT_MIN_BYTES]) {
    const f = fitOutput("x".repeat(10_000), "c", JSON.stringify({ ok: true, result: "y".repeat(20_000) }), outputItemBytes("c", "") + max);
    assert.ok(outputItemBytes("c", f) <= outputItemBytes("c", "") + Math.max(max, 100), `${max}`);
  }
});
