import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_OUTPUT_CHARS, MAX_ROUNDS } from "../src/agent.ts";
import { ASSISTANT_ACTIVE_BUDGET_CHARS, ASSISTANT_CHUNK_MAX_CHARS, ASSISTANT_CONTEXT_BUDGET_CHARS, ASSISTANT_NOTES_MAX_CHARS } from "../src/assistant-context.ts";
import { MAX_MESSAGE_CHARS } from "../src/threads.ts";
import { captureAssistantRequest } from "./history-audit-capture.ts";
import { buildReport, contextBudget, floorTurns, HISTORIES, historyItems, OPTIONS, retention, rounds, ROUND_LOADS } from "./history-audit-fixture.ts";

// The SYNTHETIC measurement harness of docs/reviews/assistant-history-sizing-audit.md. It checks the harness and the properties the
// audit relies on; it does not pin the report's numbers (they change whenever a budget or a tool description changes, and
// `node tools/history-audit/report.ts` regenerates them). Offline: no provider, no real vault, no network.

test("the baseline option is the current code: budgets, round cap and output clip the audit cites", () => {
  const base = OPTIONS.find((o) => o.id === "baseline")!;
  assert.equal(base.active, ASSISTANT_ACTIVE_BUDGET_CHARS);
  assert.equal(contextBudget(base), ASSISTANT_CONTEXT_BUDGET_CHARS);
  assert.equal(ASSISTANT_CONTEXT_BUDGET_CHARS, ASSISTANT_ACTIVE_BUDGET_CHARS + MAX_MESSAGE_CHARS);
  assert.equal(floorTurns(base), 2, "two bounded chunks of at most 12,000 always fit in 32,000");
  assert.equal(ASSISTANT_CHUNK_MAX_CHARS, 12_000);
  assert.equal(ASSISTANT_NOTES_MAX_CHARS, 12_000);
  assert.equal(MAX_ROUNDS, 5);
  assert.equal(MAX_OUTPUT_CHARS, 8_000);
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

test("a larger option never keeps fewer turns than a smaller one", () => {
  for (const h of Object.keys(HISTORIES) as (keyof typeof HISTORIES)[]) {
    const sent = OPTIONS.map((o) => retention(o, h).turnsSent);
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i]! >= sent[i - 1]!, `${h}: ${sent.join(" <= ")}`);
  }
});

test("tool rounds: the real loop makes max + 1 requests, the last without tools, and the input only grows", async () => {
  for (const m of [MAX_ROUNDS, 20]) {
    for (const l of Object.keys(ROUND_LOADS) as (keyof typeof ROUND_LOADS)[]) {
      const r = await rounds(l, m, historyItems(1_000));
      assert.equal(r.steps, m + 1, `${l}/${m}`);
      assert.equal(r.capped, true);
      for (let i = 1; i < r.stepInputChars.length; i++) assert.ok(r.stepInputChars[i]! > r.stepInputChars[i - 1]!);
    }
  }
  // Each output is clipped to MAX_OUTPUT_CHARS (plus the clip note): a heavy round adds at most 3 clipped outputs and their arguments.
  const one = await rounds("heavy", 1, historyItems(0));
  assert.ok(one.stepInputChars[1]! - one.stepInputChars[0]! < 3 * (MAX_OUTPUT_CHARS + 600));
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
});
