import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUDGET_NOTE, callKey, MAX_ROUNDS, NO_PROGRESS_NOTE, REPEAT_FAILURES_MAX, REPEAT_RECOVERIES_MAX, runChat, TurnInterrupted } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { chatgptModel, ProviderError, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import { openaiModel } from "../src/model.ts";
import type { Item, ModelPort, Step, ToolCall } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";
import { call, rig, say } from "./threads-fixture.ts";

// The per-reply tool-round ceiling (MAX_ROUNDS) and the no-progress guard, through a mocked tool loop. Every model here is scripted
// or a real adapter over a fake fetch; nothing reaches a provider. These tests pin what the loop does and what ORBIT tells the model;
// they cannot show how a real model uses a larger budget.

const user: Item[] = [{ role: "user", content: "go" }];

// A scripted model that records each step's tool list and round position; `script` gets the step index and the input so far.
function model(script: (n: number, input: Item[]) => Step) {
  const seen: { tools: string[]; rounds?: { round: number; max: number; offered: string[]; stalled?: boolean } }[] = [];
  const port: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/rounds", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (input, _l, _n, tools, o) => {
      seen.push({ tools: tools.map((t) => t.name), ...(o?.rounds ? { rounds: o.rounds } : {}) });
      return script(seen.length - 1, input);
    },
  };
  return { port, seen };
}
// A tool that counts runs and answers with its arguments; `fail` makes it throw (a failed call).
function counter(name = "read", fail?: (args: Record<string, unknown>, n: number) => string | undefined) {
  const runs: Record<string, unknown>[] = [];
  const tool: ChatTool = {
    name,
    readOnly: true,
    description: "d",
    parameters: { type: "object", properties: {} },
    run: async (args) => {
      runs.push(args);
      const err = fail?.(args, runs.length);
      if (err) throw new Error(err);
      return { value: { page: args.page ?? null, n: runs.length }, provenance: "live", source: `test/${name}` };
    },
  };
  return { tool, runs };
}
const outputs = (input: Item[]) => input.filter((i): i is Extract<Item, { type: "function_call_output" }> => "type" in i && i.type === "function_call_output").map((i) => JSON.parse(i.output));

// ---- the ceiling ------------------------------------------------------------------------------------------------------------

test("the ceiling is 20 tool rounds, defined once", () => {
  assert.equal(MAX_ROUNDS, 20);
});

test("a task that needs more than five tool rounds completes, uncapped, and stops as soon as it has its answer", async () => {
  const r = counter();
  const m = model((n) => (n < 8 ? { text: "", calls: [call("read", { page: n }, `p${n}`)] } : say("Read all 8 pages.")));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool] });
  assert.equal(out.text, "Read all 8 pages.");
  assert.equal(out.capped, false);
  assert.equal(out.stalled, undefined);
  assert.equal(out.rounds, 8);
  assert.equal(r.runs.length, 8);
  assert.equal(m.seen.length, 9, "8 tool rounds and one answering step, nothing padded");
  assert.ok(m.seen.every((s) => s.tools.includes("read")), "the tools were offered on every step, including the answering one");
  assert.equal(out.incomplete, undefined);
});

test("early completion: a reply that needs no tools makes one request, and one that needs one round makes two", async () => {
  const none = model(() => say("Hello."));
  const a = await runChat({ model: none.port, messages: user, limits: [], tools: [counter().tool] });
  assert.deepEqual([a.text, a.rounds, a.capped, none.seen.length], ["Hello.", 0, false, 1]);
  const one = model((n) => (n === 0 ? { text: "", calls: [call("read", {})] } : say("Done.")));
  const b = await runChat({ model: one.port, messages: user, limits: [], tools: [counter().tool] });
  assert.deepEqual([b.text, b.rounds, b.capped, one.seen.length], ["Done.", 1, false, 2]);
});

test("exactly 20 tool rounds run; the 21st step gets no tools, its calls never run, and its answer is the reply", async () => {
  const r = counter();
  // The model always asks for another page, even in the final step (where it was offered no tools).
  const m = model((n) => ({ text: n === MAX_ROUNDS ? "Read 20 pages; page 21 onwards is still pending." : "", calls: [call("read", { page: n }, `p${n}`)] }));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool] });
  assert.equal(r.runs.length, MAX_ROUNDS, "no 21st tool-executing round");
  assert.equal(out.calls.length, MAX_ROUNDS);
  assert.equal(m.seen.length, MAX_ROUNDS + 1);
  assert.ok(m.seen.slice(0, MAX_ROUNDS).every((s) => s.tools.length === 1));
  assert.deepEqual(m.seen.at(-1)!.tools, []);
  assert.deepEqual(m.seen.map((s) => s.rounds!.round), Array.from({ length: MAX_ROUNDS + 1 }, (_, i) => i));
  assert.ok(m.seen.every((s) => s.rounds!.max === MAX_ROUNDS));
  assert.equal(out.rounds, MAX_ROUNDS);
  assert.equal(out.capped, true);
  assert.equal(out.text, "Read 20 pages; page 21 onwards is still pending.");
  assert.deepEqual(out.incomplete, [BUDGET_NOTE(MAX_ROUNDS)]);
});

test("the 20th round may still call tools; answering in the 21st step is not capped only if no tool was wanted", async () => {
  // Calls in rounds 0..19, answer in step 20 without asking for tools: capped (the budget was used up), but the answer stands.
  const used = model((n) => (n < MAX_ROUNDS ? { text: "", calls: [call("read", { page: n }, `p${n}`)] } : say("All done in the last step.")));
  const a = await runChat({ model: used.port, messages: user, limits: [], tools: [counter().tool] });
  assert.equal(a.calls.length, MAX_ROUNDS);
  assert.equal(a.text, "All done in the last step.");
  assert.equal(a.capped, true);
  // Calls in rounds 0..18 and an answer in step 19 (tools still offered): not capped.
  const under = model((n) => (n < MAX_ROUNDS - 1 ? { text: "", calls: [call("read", { page: n }, `p${n}`)] } : say("Done with one round to spare.")));
  const b = await runChat({ model: under.port, messages: user, limits: [], tools: [counter().tool] });
  assert.equal(b.calls.length, MAX_ROUNDS - 1);
  assert.equal(b.capped, false);
  assert.equal(under.seen.length, MAX_ROUNDS);
});

test("a final answer is always possible: an empty final step still yields an honest text", async () => {
  const m = model(() => ({ text: "", calls: [call("read", {})] }));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [counter().tool] });
  assert.equal(out.capped, true);
  assert.match(out.text, new RegExp(`stopped after ${MAX_ROUNDS} rounds of tool calls`));
  assert.match(out.text, /anything not listed was not done/);
});

test("parallel calls in one step are one round: 3 calls per step for 20 steps run 60 calls, then the tools are withdrawn", async () => {
  const r = counter();
  const m = model((n) => ({ text: n === MAX_ROUNDS ? "summary" : "", calls: [0, 1, 2].map((k) => call("read", { page: n * 3 + k }, `p${n}-${k}`)) }));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool] });
  assert.equal(r.runs.length, MAX_ROUNDS * 3);
  assert.equal(out.rounds, MAX_ROUNDS);
  assert.equal(m.seen.length, MAX_ROUNDS + 1);
  assert.deepEqual(m.seen.at(-1)!.tools, []);
  assert.equal(out.capped, true);
});

// ---- gates and safeguards are unchanged beyond round 5 ----------------------------------------------------------------------

test("the policy check still refuses a call in a late round, and the refused tool never runs", async () => {
  const r = counter();
  const secret = counter("secret");
  const m = model((n) => (n < 12 ? { text: "", calls: [call(n === 11 ? "secret" : "read", { page: n }, `p${n}`)] } : say("The secret call was refused.")));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool, secret.tool], allow: (t) => (t === "secret" ? "Refused by policy." : undefined) });
  assert.equal(secret.runs.length, 0);
  assert.equal(out.calls.at(-1)!.ok, false);
  assert.equal(out.calls.at(-1)!.summary, "Refused by policy.");
  assert.equal(out.text, "The secret call was refused.");
});

test("cancellation in a late round ends the turn: no further tool call or model step", async () => {
  const ctl = new AbortController();
  const r = counter("read", (_a, n) => (n === 9 ? (ctl.abort(), undefined) : undefined));
  const m = model((n) => ({ text: "", calls: [call("read", { page: n }, `p${n}`), call("read", { page: `${n}b` }, `p${n}b`)] }));
  await assert.rejects(runChat({ model: m.port, messages: user, limits: [], tools: [r.tool], signal: ctl.signal }), (e: unknown) => e instanceof TurnInterrupted && e.kind === "cancelled");
  assert.equal(r.runs.length, 9, "the call that saw the cancellation completed; nothing started after it");
  assert.equal(m.seen.length, 5);
});

test("the tool deadline still ends a turn in a late round", async () => {
  const slow: ChatTool = { name: "slow", readOnly: true, description: "d", parameters: { type: "object", properties: {} }, run: () => new Promise(() => {}) };
  const r = counter();
  const m = model((n) => ({ text: "", calls: [call(n === 15 ? "slow" : "read", { page: n }, `p${n}`)] }));
  await assert.rejects(runChat({ model: m.port, messages: user, limits: [], tools: [r.tool, slow], toolDeadlineMs: 5, abortGraceMs: 1 }), (e: unknown) => e instanceof TurnInterrupted && e.kind === "timeout");
  assert.equal(r.runs.length, 15);
  assert.equal(m.seen.length, 16);
});

// ---- the no-progress guard --------------------------------------------------------------------------------------------------

test("no progress: an identical call that keeps failing the same way runs twice, then is not run, and the tools are withdrawn", async () => {
  const r = counter("read", () => "No such page.");
  const m = model((n) => (m.seen.at(-1)!.tools.length ? { text: "", calls: [call("read", { page: 7 }, `p${n}`)] } : say("Page 7 failed twice with 'No such page.'; nothing else was done.")));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool] });
  assert.equal(r.runs.length, REPEAT_FAILURES_MAX);
  assert.equal(out.calls.length, REPEAT_FAILURES_MAX + 1);
  const blocked = out.calls.at(-1)!;
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /did not run this read call/);
  assert.equal(out.stalled, true);
  assert.equal(out.capped, false);
  assert.equal(out.rounds, REPEAT_FAILURES_MAX + 1);
  assert.deepEqual(m.seen.at(-1)!.tools, []);
  assert.equal(m.seen.at(-1)!.rounds!.stalled, true);
  assert.equal(m.seen.length, REPEAT_FAILURES_MAX + 2, "stopped far below the 20-round ceiling");
  assert.deepEqual(out.incomplete, [NO_PROGRESS_NOTE(REPEAT_FAILURES_MAX + 1, MAX_ROUNDS)]);
  assert.equal(out.text, "Page 7 failed twice with 'No such page.'; nothing else was done.");
});

test("no progress: the blocked output says nothing ran, and the guard ignores argument order and whitespace", async () => {
  assert.equal(callKey("read", '{"a":1,"b":{"y":2,"x":1}}'), callKey("read", '{ "b": {"x":1, "y":2}, "a": 1 }'));
  assert.notEqual(callKey("read", '{"a":1}'), callKey("read", '{"a":2}'));
  assert.notEqual(callKey("read", '{"a":1}'), callKey("other", '{"a":1}'));
  const r = counter("read", () => "Bad cursor.");
  const args = ['{"cursor":"x","id":"s"}', '{"id":"s","cursor":"x"}', '{ "id": "s", "cursor": "x" }'];
  const m = model((n, input) => (n < 3 ? { text: "", calls: [{ call_id: `c${n}`, name: "read", arguments: args[n]! }] } : say(JSON.stringify(outputs(input).at(-1)))));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool] });
  assert.equal(r.runs.length, 2);
  const last = JSON.parse(out.text);
  assert.equal(last.ok, false);
  assert.equal(last.notRun, true);
  assert.match(last.error, /Nothing was run or changed by this call/);
});

test("no progress does not block pagination: the same tool with a changing cursor runs every time, even when pages fail", async () => {
  const r = counter("read", (a) => (Number(a.page) % 2 ? "Transient error." : undefined));
  const m = model((n) => (n < 14 ? { text: "", calls: [call("read", { page: n }, `p${n}`)] } : say("ok")));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool] });
  assert.equal(r.runs.length, 14);
  assert.equal(out.stalled, undefined);
});

test("no progress does not block polling: an identical call that succeeds runs on every round", async () => {
  const r = counter("status");
  const m = model((n) => (n < MAX_ROUNDS ? { text: "", calls: [call("status", { job: "j1" }, `s${n}`)] } : say("Still running after 20 checks.")));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool] });
  assert.equal(r.runs.length, MAX_ROUNDS);
  assert.equal(out.stalled, undefined);
  assert.equal(out.capped, true);
});

test("no progress does not block a retry that makes progress: a changing error, or a success in between, resets the count", async () => {
  const errors = ["Rate limited (1).", "Rate limited (2).", "Rate limited (3).", "Rate limited (4)."];
  const changing = counter("fetch", (_a, n) => errors[n - 1]);
  const a = model((n) => (n < 5 ? { text: "", calls: [call("fetch", { url: "u" }, `f${n}`)] } : say("Fetched on the fifth try.")));
  const out = await runChat({ model: a.port, messages: user, limits: [], tools: [changing.tool] });
  assert.equal(changing.runs.length, 5, "every retry ran: each failure was different");
  assert.equal(out.calls.at(-1)!.ok, true);
  // The same error, a success, the same error again, ...: never blocked (without the reset, the 5th call would be).
  const pattern = ["E", undefined, "E", undefined, "E", undefined];
  const flaky = counter("fetch", (_a, n) => pattern[n - 1]);
  const b = model((n) => (n < 6 ? { text: "", calls: [call("fetch", { url: "u" }, `f${n}`)] } : say("ok")));
  const out2 = await runChat({ model: b.port, messages: user, limits: [], tools: [flaky.tool] });
  assert.equal(flaky.runs.length, 6);
  assert.equal(out2.stalled, undefined);
});

test("no progress: a round with a blocked repeat and a new call carries on; only a round of nothing but repeats stops the tools", async () => {
  const bad = counter("bad", () => "Always fails.");
  const r = counter();
  const m = model((n) => (n < 6 ? { text: "", calls: [call("bad", {}, `b${n}`), call("read", { page: n }, `p${n}`)] } : say("ok")));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [bad.tool, r.tool] });
  // Each new page is progress, so the blocked call is retried, but only REPEAT_RECOVERIES_MAX times (test/progress-and-paging.test.ts).
  assert.equal(bad.runs.length, REPEAT_FAILURES_MAX + REPEAT_RECOVERIES_MAX);
  assert.equal(r.runs.length, 6);
  assert.equal(out.stalled, undefined);
  assert.equal(out.text, "ok");
});

test("no progress: a refused call repeated identically is stopped too, and the policy check is never bypassed", async () => {
  let asked = 0;
  const r = counter("launch");
  const m = model(() => ({ text: "", calls: [call("launch", { brief: "x" })] }));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [r.tool], allow: () => (asked++, "Not allowed.") });
  assert.equal(r.runs.length, 0);
  assert.equal(asked, REPEAT_FAILURES_MAX, "the blocked repeat never reached the policy check or the tool");
  assert.equal(out.stalled, true);
});

// ---- what the model is told (real adapters over fake fetches) ---------------------------------------------------------------

type Sent = { instructions: string; tools: string[] };
function openai(script: (s: Sent, n: number) => Step) {
  const sent: Sent[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    const s: Sent = { instructions: b.instructions, tools: (b.tools ?? []).map((t: any) => t.name) };
    sent.push(s);
    const step = script(s, sent.length - 1);
    const output = [...(step.text ? [{ type: "message", content: [{ type: "output_text", text: step.text }] }] : []), ...step.calls.map((c) => ({ type: "function_call", ...c }))];
    return new Response(JSON.stringify({ output }));
  }) as unknown as typeof fetch;
  return { model: openaiModel("gpt-test", "test-key", fetcher), sent };
}

test("instructions: every tool step says 20 steps and how many are left, that it is a ceiling, and the forced final step asks for an honest summary", async () => {
  const r = counter();
  const jobs = counter("jobs_list");
  const { model: m, sent } = openai((_s, n) => ({ text: n === MAX_ROUNDS ? "Read 20 pages; the rest is pending." : "", calls: [call("read", { page: n }, `p${n}`)] }));
  await runChat({ model: m, messages: user, limits: [], tools: [r.tool, jobs.tool] });
  assert.equal(sent.length, MAX_ROUNDS + 1);
  sent.slice(0, MAX_ROUNDS).forEach((s, i) => {
    assert.ok(s.instructions.includes(`Tool rounds: this is step ${i + 1}; at most ${MAX_ROUNDS} steps of this reply may call tools (${MAX_ROUNDS - i} left, this one included).`));
    assert.match(s.instructions, /This is a ceiling, not a target: answer as soon as you can/);
    assert.match(s.instructions, new RegExp(`after ${REPEAT_FAILURES_MAX} identical failures ORBIT stops running it`));
    assert.doesNotMatch(s.instructions, /BUDGET EXHAUSTED|LACK OF PROGRESS/);
  });
  const last = sent.at(-1)!;
  assert.deepEqual(last.tools, []);
  assert.match(last.instructions, new RegExp(`TOOL-ROUND BUDGET EXHAUSTED: this reply has used all ${MAX_ROUNDS} steps`));
  assert.match(last.instructions, /only withheld for this step: read, jobs_list/);
  assert.match(last.instructions, /summarize what was completed and what is still pending/);
  assert.match(last.instructions, /a failed or refused call did nothing unless its result says otherwise/);
  assert.match(last.instructions, /The record tools \(jobs_list\) are withheld in this final step because the tool-round budget ran out/);
  assert.doesNotMatch(last.instructions, /LACK OF PROGRESS/);
});

test("instructions: a guard stop is told apart from the round budget and from a missing tool", async () => {
  const bad = counter("read", () => "No such page.");
  const jobs = counter("jobs_list");
  const { model: m, sent } = openai((s) => (s.tools.length ? { text: "", calls: [call("read", { page: 1 })] } : say("Page 1 kept failing; nothing else was done.")));
  const out = await runChat({ model: m, messages: user, limits: [], tools: [bad.tool, jobs.tool] });
  assert.equal(out.stalled, true);
  const last = sent.at(-1)!;
  assert.deepEqual(last.tools, []);
  assert.match(last.instructions, /TOOL CALLS STOPPED FOR LACK OF PROGRESS/);
  assert.match(last.instructions, new RegExp(`This is not the tool-round budget \\(${REPEAT_FAILURES_MAX + 1} of ${MAX_ROUNDS} steps were used\\)`));
  assert.match(last.instructions, /only withheld for this step: read, jobs_list\. Do not say that any of them is unavailable/);
  assert.match(last.instructions, /summarize what was completed and what is still pending/);
  assert.match(last.instructions, /withheld in this final step because ORBIT stopped the tool calls for lack of progress/);
  assert.doesNotMatch(last.instructions, /BUDGET EXHAUSTED|budget ran out/);
});

// The ChatGPT adapter (the primary in production) over a fake inference server: it builds the same round lines from `rounds`.
function chatgpt(script: (instructions: string, tools: string[], n: number) => Step) {
  const file = tokenFile(undefined);
  const tokens: Tokens = { access: "access-0", refresh: "refresh-0", expires: Date.now() + 3_600_000, idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`, clientId: "oaiapp_x", subject: "user-1", scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access" };
  file.write(tokens);
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("/v1/responses")) return new Response("", { status: 404 });
    const b = JSON.parse(String(init.body));
    const s: Sent = { instructions: b.instructions, tools: (b.tools ?? []).map((t: any) => t.name) };
    sent.push(s);
    const step = script(s.instructions, s.tools, sent.length - 1);
    const output = [...(step.text ? [{ type: "message", content: [{ type: "output_text", text: step.text }] }] : []), ...step.calls.map((c: ToolCall) => ({ type: "function_call", ...c }))];
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`);
  }) as unknown as typeof fetch;
  return { model: chatgptModel("gpt-x", file, { fetcher }), sent };
}

test("ChatGPT adapter: a 7-round reply completes and each request carries the 20-step round line; the final step is tool-free", async () => {
  const r = counter();
  const { model: m, sent } = chatgpt((_i, tools, n) => (tools.length && n < 7 ? { text: "", calls: [call("read", { page: n }, `p${n}`)] } : say("Done after 7 rounds.")));
  const out = await runChat({ model: m, messages: user, limits: [], tools: [r.tool] });
  assert.equal(out.text, "Done after 7 rounds.");
  assert.equal(out.capped, false);
  assert.equal(r.runs.length, 7);
  assert.equal(sent.length, 8);
  assert.ok(sent[6]!.instructions.includes(`this is step 7; at most ${MAX_ROUNDS} steps of this reply may call tools (${MAX_ROUNDS - 6} left, this one included)`));
  const capped = chatgpt((_i, tools) => (tools.length ? { text: "", calls: [call("read", {}, "x")] } : say("Budget ran out.")));
  const out2 = await runChat({ model: capped.model, messages: user, limits: [], tools: [counter().tool] });
  assert.equal(out2.capped, true);
  assert.equal(capped.sent.length, MAX_ROUNDS + 1);
  assert.match(capped.sent.at(-1)!.instructions, /TOOL-ROUND BUDGET EXHAUSTED/);
});

test("OpenRouter fallback adapter: the round position and a guard stop reach its instructions; at the cap it is sent no tools", async () => {
  const or: any[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    or.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fallback answer" } }], usage: { cost: 0.0001 } }));
  }) as unknown as typeof fetch;
  const cfg = openrouterConfig({ ORBIT_OPENROUTER_ENABLED: "1", ORBIT_OPENROUTER_MODEL: "vendor/cheap-model", ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2", ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4", ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048", CREDENTIALS_DIRECTORY: "/creds" }, () => ["sk", "or", "v1", "0".repeat(32)].join("-"));
  assert.equal(cfg.state, "ready");
  const primary: ModelPort = { status: () => ({ port: "model", state: "live", impl: "chatgpt/x", detail: "", verifiedAt: "" }), reply: async () => ({ value: "", provenance: "live", source: "" }), step: async () => { throw new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan."); } };
  const fb = fallbackModel({ primary, config: cfg as Extract<OpenRouterConfig, { state: "ready" }>, ledger: provisioned(mkdtempSync(join(tmpdir(), "orbit-rounds-spend-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }), fetcher });
  const defs = [{ name: "vault_policy", description: "d", parameters: { type: "object", properties: {} } }];
  const offered = defs.map((d) => d.name);
  await fb.step!(user, [], undefined, defs, { fallback: true, rounds: { round: 12, max: MAX_ROUNDS, offered } });
  assert.ok((or[0].messages[0].content as string).includes(`this is step 13; at most ${MAX_ROUNDS} steps of this reply may call tools (8 left, this one included)`));
  await fb.step!(user, [], undefined, [], { fallback: true, rounds: { round: 3, max: MAX_ROUNDS, offered, stalled: true } });
  assert.match(or[1].messages[0].content, /TOOL CALLS STOPPED FOR LACK OF PROGRESS/);
  assert.equal(or[1].tools, undefined);
  await fb.step!(user, [], undefined, [], { fallback: true, rounds: { round: MAX_ROUNDS, max: MAX_ROUNDS, offered } });
  assert.match(or[2].messages[0].content, new RegExp(`TOOL-ROUND BUDGET EXHAUSTED: this reply has used all ${MAX_ROUNDS} steps`));
});

// ---- the server paths: /chat, a chat thread and the Assistant -----------------------------------------------------------------

test("/chat, chat threads and the Assistant: a 7-round reply completes uncapped; a proposal made in a late round still needs Confirm", async () => {
  // Six jobs_list rounds (no-ops here), then job_launch in round 7, then the answer.
  const script = (input: Item[]): Step => {
    const n = outputs(input.slice(input.findLastIndex((i) => "role" in i && i.role === "user"))).length;
    if (n < 6) return { text: "", calls: [call("jobs_list", { limit: n + 1 }, `j${n}`)] };
    if (n === 6) return { text: "", calls: [call("job_launch", { routine: "orbit", brief: `Fix X (${input.length}).` }, "launch")] };
    return say("Proposed; waiting for your confirmation.");
  };
  const steps: number[] = [];
  const m: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/rounds", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (input, _l, _n, tools) => (steps.push(tools.length), script(input)),
  };
  const r = rig({ model: m });

  const viaChat = await r.api("/chat", "POST", { messages: [{ role: "user", content: "launch a job to fix X" }] });
  assert.equal(viaChat.status, 200, JSON.stringify(viaChat.data));
  assert.equal(viaChat.data.capped, false);
  assert.equal(viaChat.data.calls.length, 7);
  assert.equal(viaChat.data.calls[6].name, "job_launch");
  assert.equal(viaChat.data.proposals.length, 1);
  assert.equal(viaChat.data.reply.value, "Proposed; waiting for your confirmation.");
  assert.equal(r.fired.length, 0, "nothing launched without a click");

  const t = await r.create("rounds");
  const viaThread = await r.send(t.id, "launch a job to fix X");
  assert.equal(viaThread.status, 200, JSON.stringify(viaThread.data));
  const reply = viaThread.data.thread.messages.at(-1);
  assert.equal(reply.text, "Proposed; waiting for your confirmation.");
  assert.equal(reply.capped, undefined);
  assert.equal(reply.calls.length, 7);

  const viaAssistant = await r.api("/assistant/messages", "POST", { text: "launch a job to fix X" });
  assert.equal(viaAssistant.status, 200, JSON.stringify(viaAssistant.data));
  const a = viaAssistant.data.assistant.chunks.at(-1).messages.at(-1);
  assert.equal(a.text, "Proposed; waiting for your confirmation.");
  assert.equal(a.calls.length, 7);
  assert.equal(r.fired.length, 0, "still nothing launched: every proposal waits for Confirm");

  const open = (await r.api("/chat/proposals")).data.proposals;
  assert.equal(open.length, 3);
  const confirm = await r.api(`/chat/proposals/${open[0].id}/confirm`, "POST", {});
  assert.equal(confirm.status, 202);
  assert.equal(r.fired.length, 1);
  assert.ok(steps.every((n) => n > 0), "tools were offered on every step: no reply reached the cap");
});
