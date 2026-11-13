import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CONFIRM_FLAG, runSmoke, SMOKE_MAX_REQUESTS } from "../src/openrouter-smoke.ts";

// The paid smoke test is only prepared here. Every test uses a fake fetch (or refuses before any request): nothing reaches OpenRouter.

const KEY_DIR = "/nonexistent-creds";
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.25",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.6",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "1048576",
  ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS: "256",
  ORBIT_OPENROUTER_DAILY_CAP_USD: "1",
  ORBIT_OPENROUTER_TOTAL_CAP_USD: "1",
  CREDENTIALS_DIRECTORY: KEY_DIR,
};
const noNetwork = (async () => {
  throw new Error("network must not be used");
}) as unknown as typeof fetch;

test("smoke: refuses before any request without the confirmation flag, with incomplete config, or with caps or max_tokens above the smoke ceiling", async () => {
  const r0 = await runSmoke([], ENV, noNetwork);
  assert.match(r0.refused ?? "", /spends real money/);
  // No credential is readable here, so the config is incomplete.
  const r1 = await runSmoke([CONFIRM_FLAG], ENV, noNetwork);
  assert.match(r1.refused ?? "", /not complete: The orbit.openrouter credential is not installed/);
  for (const [k, v] of [["ORBIT_OPENROUTER_DAILY_CAP_USD", "1.5"], ["ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS", "1024"]] as const) {
    const env = { ...ENV, [k]: v, ...(k.includes("DAILY") ? { ORBIT_OPENROUTER_TOTAL_CAP_USD: "2" } : {}) };
    const r = await runSmoke([CONFIRM_FLAG], env, noNetwork, undefined, () => "k");
    assert.ok(r.refused, k);
  }
  for (const r of [r0, r1]) assert.equal(r.requests, 0);
});

type Body = { choices: unknown[]; usage: Record<string, unknown> };
const text = (t: string, usage: Record<string, unknown> = { cost: 0.00002, prompt_tokens: 300, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 } }): Body => ({ choices: [{ finish_reason: "stop", message: { content: t } }], usage });
const toolCall: Body = { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "jobs_list", arguments: "{}" } }] } }], usage: { cost: 0.00003, prompt_tokens: 400, completion_tokens: 20 } };
const fake = (bodies: Body[]) => {
  const sent: any[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(bodies[sent.length - 1]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
};

test("smoke: the full pass path makes exactly three requests through ORBIT's fallback, never runs the tool, and reconciles with an isolated ledger", async () => {
  const f = fake([text("ORBIT smoke OK"), toolCall, text("2 jobs")]);
  const r = await runSmoke([CONFIRM_FLAG], ENV, f.fetcher, undefined, () => "k");
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.requests, SMOKE_MAX_REQUESTS);
  assert.equal(r.calls.length, 3);
  assert.equal(r.ledger!.lifetimeUsd, 0.00007);
  assert.equal(r.ledger!.reservedUsd, 0);
  assert.equal(r.ledger!.uncertainRequests, 0);
  assert.ok(existsSync(r.ledger!.dir) && !r.ledger!.dir.includes("/var/lib"), "own temporary ledger");
  // The synthetic tool result, not a real one, went back to the model.
  assert.equal(f.sent[2].messages.at(-1).content, JSON.stringify({ jobs: [{ id: "smoke-1" }, { id: "smoke-2" }] }));
  for (const b of f.sent) {
    assert.deepEqual(b.reasoning, { effort: "none" });
    assert.equal(b.provider.require_parameters, true);
    assert.equal(b.max_tokens, 256);
  }
});

test("smoke: stops at the first failed check, so a failure cannot cause more spend; max_tokens overrun is a failed check", async () => {
  const noTool = fake([text("ORBIT smoke OK"), text("I will not call tools"), text("x")]);
  const r = await runSmoke([CONFIRM_FLAG], ENV, noTool.fetcher, undefined, () => "k");
  assert.equal(r.ok, false);
  assert.equal(r.requests, 2);
  const over = fake([text("ORBIT smoke OK", { cost: 0.0002, completion_tokens: 5000, completion_tokens_details: { reasoning_tokens: 4990 } })]);
  const o = await runSmoke([CONFIRM_FLAG], ENV, over.fetcher, undefined, () => "k");
  // The reply itself is served; the provider's own usage shows reasoning ran past max_tokens, which fails the run.
  assert.equal(o.ok, false);
  assert.ok(o.checks.some((c) => c.name === "request 1: completion tokens within max_tokens (reasoning included)" && !c.ok), JSON.stringify(o.checks));
});

test("smoke tool: exits 2 and sends nothing without the confirmation flag", () => {
  const TOOL = new URL("../tools/openrouter-smoke/smoke.ts", import.meta.url).pathname;
  const p = spawnSync(process.execPath, [TOOL], { encoding: "utf8", env: { ...process.env, ...ENV } });
  assert.equal(p.status, 2);
  assert.equal(JSON.parse(p.stdout).requests, 0);
});
