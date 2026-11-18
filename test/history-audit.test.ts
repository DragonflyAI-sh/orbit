import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_OUTPUT_CHARS, MAX_ROUNDS } from "../src/agent.ts";
import { ASSISTANT_ACTIVE_BUDGET_CHARS, ASSISTANT_CHUNK_MAX_CHARS, ASSISTANT_CONTEXT_BUDGET_CHARS, ASSISTANT_MIN_TURNS, ASSISTANT_NOTES_MAX_CHARS } from "../src/assistant-context.ts";
import { MAX_MESSAGE_CHARS } from "../src/threads.ts";
import { REPLY_TOOL_RESULT_BUDGET_BYTES } from "../src/tool-result-budget.ts";
import { captureAssistantRequest } from "./history-audit-capture.ts";
import { buildReport, contextBudget, floorTurns, HISTORIES, historyItems, NO_RESULT_BUDGET, OPTIONS, retention, rounds, ROUND_LOADS } from "./history-audit-fixture.ts";

// The SYNTHETIC measurement harness of docs/reviews/assistant-history-sizing-audit.md. It checks the harness and the properties the
// audit and its implementation rely on. It pins the code's budget constants (so a change to them is a deliberate change here and in
// the audit's tables), not the report's numbers (they change whenever a tool description changes; `node tools/history-audit/report.ts`
// regenerates them). It does not pin the tool-round cap: it reads MAX_ROUNDS, so a change of the round cap (a separate, approval-gated
// change) does not fail it. Offline: no provider, no real vault, no network.

test("the 'after' option is the current code (48,000 / 68,000, floor 4); 'before' is the audited 32bfcc7 (32,000 / 52,000, floor 2)", () => {
  const before = OPTIONS.find((o) => o.id === "before")!;
  const after = OPTIONS.find((o) => o.id === "after")!;
  assert.equal(before.active, 32_000);
  assert.equal(floorTurns(before), 2);
  assert.equal(after.active, ASSISTANT_ACTIVE_BUDGET_CHARS);
  assert.equal(ASSISTANT_ACTIVE_BUDGET_CHARS, 48_000);
  assert.equal(contextBudget(after), ASSISTANT_CONTEXT_BUDGET_CHARS);
  assert.equal(ASSISTANT_CONTEXT_BUDGET_CHARS, 68_000);
  assert.equal(ASSISTANT_CONTEXT_BUDGET_CHARS, ASSISTANT_ACTIVE_BUDGET_CHARS + MAX_MESSAGE_CHARS);
  assert.equal(floorTurns(after), ASSISTANT_MIN_TURNS);
  assert.equal(ASSISTANT_MIN_TURNS, 4);
  assert.equal(ASSISTANT_CHUNK_MAX_CHARS, 12_000);
  assert.equal(ASSISTANT_NOTES_MAX_CHARS, 12_000);
  assert.equal(MAX_OUTPUT_CHARS, 8_000);
  assert.equal(REPLY_TOOL_RESULT_BUDGET_BYTES, 96_000);
  assert.ok(!OPTIONS.some((o) => o.active > ASSISTANT_ACTIVE_BUDGET_CHARS), "no larger history option is measured or offered");
});

test("floor: every option always sends at least its floor of newest turns, whatever the history and the message size", () => {
  for (const o of OPTIONS) {
    for (const h of Object.keys(HISTORIES) as (keyof typeof HISTORIES)[]) {
      for (const current of [400, MAX_MESSAGE_CHARS]) {
        const r = retention(o, h, current);
        assert.ok(r.turnsSent >= floorTurns(o), `${o.id}/${h}/${current}: ${r.turnsSent} turns >= floor ${floorTurns(o)}`);
        assert.ok(r.historyChars <= o.active, `${o.id}/${h}: history ${r.historyChars} within the active budget ${o.active}`);
        assert.ok(r.historyChars + r.currentChars <= contextBudget(o), `${o.id}/${h}: conversation within ${contextBudget(o)}`);
        // Rotation already keeps the active window within the history budget, so planContext omits nothing (no held cards here).
        assert.equal(r.turnsSent, r.turnsActive);
      }
    }
  }
});

test("after keeps more turns than before in every history; heavy history goes from 2 to 4 turns", () => {
  for (const h of Object.keys(HISTORIES) as (keyof typeof HISTORIES)[]) {
    const [b, a] = OPTIONS.map((o) => retention(o, h).turnsSent);
    assert.ok(a! > b!, `${h}: ${b} -> ${a}`);
  }
  assert.equal(retention(OPTIONS[0]!, "heavy").turnsSent, 2);
  assert.equal(retention(OPTIONS[1]!, "heavy").turnsSent, 4);
});

test("tool rounds without a result budget (before): max + 1 requests, the last without tools, and the input grows every step", async () => {
  for (const m of [MAX_ROUNDS, 20]) {
    for (const l of Object.keys(ROUND_LOADS) as (keyof typeof ROUND_LOADS)[]) {
      const r = await rounds(l, m, historyItems(1_000), NO_RESULT_BUDGET);
      assert.equal(r.steps, m + 1, `${l}/${m}`);
      assert.equal(r.capped, true);
      assert.equal(r.resultBudget, undefined);
      for (let i = 1; i < r.stepInputChars.length; i++) assert.ok(r.stepInputChars[i]! > r.stepInputChars[i - 1]!);
    }
  }
  // Each output is clipped to MAX_OUTPUT_CHARS (plus the clip note): a heavy round adds at most 3 clipped outputs and their arguments.
  const one = await rounds("heavy", 1, historyItems(0), NO_RESULT_BUDGET);
  assert.ok(one.stepInputChars[1]! - one.stepInputChars[0]! < 3 * (MAX_OUTPUT_CHARS + 600));
});

test("tool rounds with the result budget (after): synthetic 5- and 20-round heavy workloads stay bounded, and growth stops at the budget", async () => {
  const peaks: number[] = [];
  for (const m of [5, 20]) {
    const r = await rounds("heavy", m, historyItems(1_000));
    const grown = r.stepInputBytes.at(-1)! - r.stepInputBytes[0]!;
    // The serialized conversation of the last request grew by at most the budget (responsesInput items carry the same fields the
    // budget counts; the array separators add one byte per item).
    assert.ok(grown <= REPLY_TOOL_RESULT_BUDGET_BYTES + 64, `${m} rounds grew ${grown}`);
    assert.ok(r.resultBudget && r.resultBudget.stopped && r.resultBudget.usedBytes <= r.resultBudget.maxBytes);
    assert.ok(r.steps < m + 1 || m === 5, "the budget, not the round cap, ended the 20-round run");
    peaks.push(Math.max(...r.stepInputBytes));
  }
  // The 20-round ceiling buys no more accumulation than 5 rounds: the bound is the budget, not the round count.
  assert.equal(peaks[0], peaks[1]);
  // Light and typical 5-round replies are unchanged by the budget (same requests, same sizes).
  for (const l of ["light", "typical"] as const) {
    const [b, a] = [await rounds(l, 5, historyItems(1_000), NO_RESULT_BUDGET), await rounds(l, 5, historyItems(1_000))];
    assert.deepEqual(a.stepInputBytes, b.stepInputBytes, l);
    assert.equal(a.resultBudget, undefined);
  }
});

test("the fixed request part is captured offline from a real Assistant turn, and the report builds", async () => {
  const log = console.log;
  console.log = () => {};
  let c;
  try {
    c = await captureAssistantRequest();
  } finally {
    console.log = log;
  }
  assert.ok(c.toolNames.includes("session_read") && c.toolNames.includes("vault_create_note") && c.toolNames.includes("job_launch"));
  assert.ok(c.toolSchemaChars > c.instructionsChars, "tool schemas are the larger fixed part");
  assert.ok(c.instructionsFinalChars < c.instructionsChars, "the forced final step lists no tools");
  const report = await buildReport({ instructionsChars: c.instructionsChars, instructionsFinalChars: c.instructionsFinalChars, toolSchemaChars: c.toolSchemaChars, tools: c.toolNames.length });
  assert.match(report, /SYNTHETIC/);
  assert.match(report, /ESTIMATES/);
  for (const o of OPTIONS) assert.ok(report.includes(o.label));
  assert.match(report, /result budget/);
});
