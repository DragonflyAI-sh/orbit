import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { ModelPort, Step } from "../src/model.ts";
import { openaiModel } from "../src/model.ts";
import { runScenario, SCENARIOS } from "./capability-fixture.ts";

// The evaluation harness (tools/capability-eval/eval.ts) checked without a live model: a scripted "ideal" model and a scripted "faulty"
// one (the incident's behaviour) run through the real tool loop and OpenAI adapter over a fake fetch. This shows the scenarios and the
// scoring work; it says nothing about how a real model behaves. No network, no key, nothing paid.

function scriptedOpenAI(answer: (body: any) => Step): ModelPort {
  const fetcher = (async (_u: unknown, init: RequestInit) => {
    const step = answer(JSON.parse(String(init.body)));
    const output = [...(step.text ? [{ type: "message", content: [{ type: "output_text", text: step.text }] }] : []), ...step.calls.map((c) => ({ type: "function_call", ...c }))];
    return new Response(JSON.stringify({ output }));
  }) as unknown as typeof fetch;
  return openaiModel("scripted", "test-key", fetcher);
}
const results = (body: any) => body.input.filter((i: any) => i.type === "function_call_output").map((i: any) => JSON.parse(i.output));
const offered = (body: any, n: string) => (body.tools ?? []).some((t: any) => t.name === n);

test("eval harness: an ideal scripted model passes every scenario", async () => {
  const ideal = scriptedOpenAI((body) => {
    const done = results(body);
    const write = done.find((r: any) => r.result?.status);
    if (write) return { text: write.result.status === "committed" ? "Saved to the vault (commit 0000000)." : "Proposed: waiting for your confirmation on the page; nothing is written yet.", calls: [] };
    if (/TOOL-ROUND BUDGET EXHAUSTED/.test(body.instructions)) return { text: "This reply's tool-round budget ran out after reading; the summary was not saved yet. Say continue and I will save it.", calls: [] };
    if (offered(body, "session_read") && /Read the last session/.test(JSON.stringify(body.input)) && !done.length) return { text: "", calls: [{ call_id: "r", name: "session_read", arguments: "{}" }] };
    if (offered(body, "vault_create_note")) return { text: "", calls: [{ call_id: "w", name: "vault_create_note", arguments: JSON.stringify({ path: "Projects/shell-access-plan.md", content: "# Plan" }) }] };
    return { text: "There is no vault write tool in this reply, so I have not saved it.", calls: [] };
  });
  for (const s of SCENARIOS) {
    const r = await runScenario(ideal, s);
    assert.ok(r.pass, `${s.id}: ${r.failures.join("; ")}`);
  }
});

test("eval harness: the incident's behaviour (an inability claim with the tool exposed) is scored as a failure", async () => {
  const faulty = scriptedOpenAI(() => ({ text: "I don't have the vault-write tool available in this reply. Here is an unsaved draft.", calls: [] }));
  const r = await runScenario(faulty, SCENARIOS.find((s) => s.id === "explicit-save-after-false-claim")!);
  assert.equal(r.pass, false);
  assert.ok(r.failures.includes("did not call vault_create_note"));
  assert.ok(r.failures.some((f) => f.startsWith("claimed")));
});

test("eval tool: refuses without the explicit live confirmation and sends nothing", () => {
  let out = "";
  try {
    execFileSync(process.execPath, ["tools/capability-eval/eval.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
    assert.equal((e as { status?: number }).status, 2);
  }
  assert.deepEqual(JSON.parse(out).sent, 0);
});
