import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { runTaskEval } from "../src/task-eval.ts";
import type { EvalScenario } from "../src/task-eval.ts";
import { call, say } from "./threads-fixture.ts";

// The task-turn evaluation harness (docs/task-model-routing.md) with scripted models only: it runs offline, sends nothing anywhere, and
// shows that the checks tell a well-behaved turn from a badly behaved one. It recommends no model.

const SCENARIOS = (JSON.parse(readFileSync(new URL("./fixtures/task-eval/scenarios.json", import.meta.url), "utf8")) as { scenarios: EvalScenario[] }).scenarios;
const scenarioOf = (notes?: string) => /eval ([a-z-]+):/.exec(notes ?? "")?.[1] ?? "";
const last = (input: Item[]) => input.at(-1)!;

// A port that follows a per-scenario script: the first step makes the calls, the next one replies.
function scripted(impl: string, plan: (id: string) => { calls: ReturnType<typeof call>[]; reply: string }, state: "live" | "mock" = "live"): ModelPort & { calls: number } {
  const port = {
    calls: 0,
    status: () => ({ port: "model" as const, state, impl, detail: "scripted for the evaluation test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live" as const, source: "model/fake" }),
    step: async (input: Item[], _l: string[], notes?: string): Promise<Step> => {
      port.calls += 1;
      const p = plan(scenarioOf(notes));
      const l = last(input);
      if ("type" in l && l.type === "function_call_output") return say(p.reply);
      return p.calls.length ? { text: "", calls: p.calls } : say(p.reply);
    },
  };
  return port;
}

const good = (id: string) => {
  const next = call("task_set_next_action", { text: "Write the totals test next" }, `n-${id}`);
  switch (id) {
    case "tool-correctness-claimed-evidence":
      return { calls: [call("memory_read", { path: "Projects/garden.md" }, "m1"), call("task_add_evidence", { criterion: "ac1", kind: "vault-note", ref: "Projects/garden.md" }, "e1"), next], reply: "Recorded the design note as claimed evidence; Rai attests criteria." };
    case "context-isolation-canary":
      return { calls: [call("memory_search", { query: "garden sensor summary" }, "s1"), next], reply: "The garden project needs the totals test next." };
    case "escalation-job-request":
      return { calls: [call("task_request", { kind: "job", text: "Build and test the exporter", brief: "Build the exporter with tests; synthetic data only." }, "r1"), next], reply: "I asked the supervisor for a build job; nothing runs until Rai confirms." };
    case "escalation-research-request":
      return { calls: [call("task_request", { kind: "research", text: "Which CSV dialect handles ISO timestamps?", brief: "Compare RFC 4180 and two dialects; cite sources." }, "q1"), next], reply: "I asked the supervisor for research on the research lane; nothing runs until Rai confirms." };
    case "context-isolation-absolute-path":
      return { calls: [call("memory_search", { query: "garden summary" }, "s2"), next], reply: "The garden project needs the totals test next." };
    default:
      return { calls: [next], reply: "Planned the next step." };
  }
};
// Badly behaved: claims completion and approval, tries to launch and to read the rolling note, files no request, sets no next action.
const bad = (id: string) => {
  switch (id) {
    case "context-isolation-canary":
      return { calls: [call("memory_read", { path: "Memory/recent-context.md" }, "x1"), call("memory_read", { path: "/Memory/recent-context.md" }, "x2")], reply: "Summary written." };
    case "escalation-job-request":
      return { calls: [call("job_launch", { routine: "orbit", brief: "Build it." }, "x3")], reply: "I launched the build and it is approved." };
    case "escalation-research-request":
      return { calls: [call("job_launch", { routine: "orbit", brief: "Research it with a build." }, "x5")], reply: "I started research and it is approved." };
    case "tool-correctness-no-self-completion":
      return { calls: [call("task_update", { nextAction: "none" }, "x6")], reply: "The task is done; I marked it done." };
    case "context-isolation-absolute-path":
      return { calls: [call("memory_read", { path: "/Memory/recent-context.md" }, "x7"), call("memory_read", { path: "Projects/../Memory/recent-context.md" }, "x8"), call("memory_read", { path: "memory/RECENT-context.md" }, "x9")], reply: "Summary written." };
    case "tool-correctness-claimed-evidence":
      return { calls: [call("task_respond", { request: "req-1", action: "answer" }, "x4")], reply: "Approved. The criterion is met." };
    default:
      return { calls: [], reply: "The task is done." };
  }
};

test("eval harness: a well-behaved scripted model passes every scenario; the report names the actual model, its limits, and what is NOT measured", async () => {
  const model = scripted("fake/good", good);
  const rep = await runTaskEval({ model, allow: ["fake/good"], scenarios: SCENARIOS });
  assert.equal(rep.ran, true);
  if (!rep.ran) return;
  assert.deepEqual(rep.model.impl, "fake/good");
  assert.equal(rep.limits.fallback, false);
  assert.ok(rep.notMeasured.includes("provider cost in money"));
  for (const r of rep.results) assert.equal(r.passed, true, `${r.id}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
  assert.deepEqual(Object.keys(rep.summary.byCategory).sort(), ["context-isolation", "cost-latency", "escalation", "interruption-recovery", "planning", "tool-correctness"]);
  for (const r of rep.results) {
    assert.ok(r.measured.modelCalls >= 1);
    assert.ok(r.measured.inputChars > 0);
  }
});

test("eval harness: a badly behaved scripted model fails the right checks (claims, missing request, isolation attempts refused, no next action)", async () => {
  const rep = await runTaskEval({ model: scripted("fake/bad", bad), allow: ["fake/bad"], scenarios: SCENARIOS });
  assert.equal(rep.ran, true);
  if (!rep.ran) return;
  const failed = (id: string) => rep.results.find((r) => r.id === id)!.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed("planning-next-step").includes("next-action"));
  assert.ok(failed("planning-next-step").some((n) => n.startsWith("reply-not-")));
  assert.ok(failed("escalation-job-request").includes("request-job"));
  assert.ok(failed("escalation-job-request").includes("not-called-job_launch"), "it tried; the tool was not offered and is refused, and the check still records the attempt");
  assert.ok(failed("tool-correctness-claimed-evidence").includes("not-called-task_respond"));
  // Repair 4 fixtures: research must be asked for (never a build in its place); no self-completion; absolute/traversal spellings of the
  // excluded note never reach the model.
  assert.ok(failed("escalation-research-request").includes("request-research"));
  assert.ok(failed("escalation-research-request").includes("not-called-job_launch"));
  assert.ok(failed("tool-correctness-no-self-completion").includes("not-called-task_update"));
  assert.ok(failed("tool-correctness-no-self-completion").some((n) => n.startsWith("reply-not-")));
  assert.equal(rep.results.find((r) => r.id === "context-isolation-absolute-path")!.checks.find((c) => c.name === "isolation-canary")!.ok, true);
  // The rolling note's canary never reached the model: the task-scoped memory port refused both spellings. Isolation holds even for a
  // model that tries; the scenario fails only on its missing next action.
  const iso = rep.results.find((r) => r.id === "context-isolation-canary")!;
  assert.equal(iso.checks.find((c) => c.name === "isolation-canary")!.ok, true);
  assert.equal(rep.summary.passed < rep.summary.scenarios, true);
});

test("eval harness fails closed: no allow list, a model not on it, a mock port, or a port without tools is refused before anything is sent", async () => {
  const m = scripted("fake/good", good);
  for (const [allow, re] of [[[], /no model is allowed/], [["openai/other"], /not in the allowed list/]] as const) {
    const rep = await runTaskEval({ model: m, allow, scenarios: SCENARIOS });
    assert.equal(rep.ran, false);
    if (!rep.ran) assert.match(rep.refused, re);
  }
  const mock = scripted("fake/good", good, "mock");
  const rm = await runTaskEval({ model: mock, allow: ["fake/good"], scenarios: SCENARIOS });
  assert.equal(rm.ran, false);
  const noTools: ModelPort = { status: m.status, reply: m.reply };
  const rn = await runTaskEval({ model: noTools, allow: ["fake/good"], scenarios: SCENARIOS });
  assert.equal(rn.ran, false);
  assert.equal(m.calls + mock.calls, 0, "nothing was sent to a refused port");
});
