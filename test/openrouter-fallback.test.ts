import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { ProviderError } from "../src/chatgpt.ts";
import { FALLBACK_TOOLS, fallbackModel } from "../src/fallback.ts";
import { replySource } from "../src/model.ts";
import type { Item, ModelPort, Step, ToolDef } from "../src/model.ts";
import { openrouterClient, openrouterConfig, sanitize, toMessages } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { spendLedger, SpendError, toMicro } from "../src/spend-ledger.ts";
import { call, OWNER, rig, say } from "./threads-fixture.ts";

// Nothing here reaches OpenRouter or any paid service: the "provider" is a fake fetch, time is a variable.

const KEY = ["sk", "or", "v1", "abcdef0123456789abcdef0123456789"].join("-");
const MIN = 60_000;
const T0 = Date.parse("2026-11-12T10:00:00Z");
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  CREDENTIALS_DIRECTORY: "/creds",
};
const readKey = () => KEY;
const ready = (over: Record<string, string> = {}) => {
  const c = openrouterConfig({ ...ENV, ...over }, readKey);
  assert.equal(c.state, "ready", JSON.stringify(c));
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};
const dir = () => mkdtempSync(join(tmpdir(), "orbit-spend-"));

type Reply = { status?: number; body?: unknown; hang?: boolean; text?: string };
function fakeOpenRouter(replies: Reply[] | ((n: number, body: any) => Reply)) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, headers: init.headers as Record<string, string>, body });
    const r = typeof replies === "function" ? replies(requests.length - 1, body) : replies[Math.min(requests.length - 1, replies.length - 1)]!;
    if (r.hang) {
      // AbortSignal.timeout does not keep the event loop alive, so the fake does.
      const keep = setTimeout(() => {}, 10_000);
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => (clearTimeout(keep), reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))));
    }
    return new Response(r.text ?? JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}
const answer = (text: string, cost: number | null = 0.0001) => ({ body: { choices: [{ finish_reason: "stop", message: { content: text } }], usage: cost === null ? {} : { cost } } });
const toolAnswer = (name: string, args: unknown, cost = 0.0001) => ({
  body: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "tc_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { cost } },
});

// A scripted ChatGPT: each entry is a Step to return or an error to throw. Counts calls.
function primaryModel(script: (Step | Error)[] | ((n: number) => Step | Error)) {
  const state = { calls: 0 };
  const next = () => {
    const n = state.calls++;
    const r = typeof script === "function" ? script(n) : script[Math.min(n, script.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  };
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-x", detail: "Answering.", verifiedAt: new Date(T0).toISOString() }),
    step: async () => next(),
    reply: async () => {
      const s = next();
      return { value: s.text, provenance: "live", source: "model/chatgpt-token-sharing/gpt-x" };
    },
  };
  return Object.assign(model, { state });
}
const usageLimit = (resetsAt?: string, code?: string) => new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", resetsAt, code);
const world = (opts: { script: (Step | Error)[] | ((n: number) => Step | Error); replies?: Reply[] | ((n: number, b: any) => Reply); cfg?: OpenRouterConfig; caps?: { d: number; t: number }; d?: string }) => {
  let t = T0;
  const now = () => t;
  const cfg = opts.cfg ?? ready();
  const d = opts.d ?? dir();
  const ledger = spendLedger(d, { dailyMicro: toMicro(opts.caps?.d ?? 5), totalMicro: toMicro(opts.caps?.t ?? 150) }, () => new Date(t));
  const or = fakeOpenRouter(opts.replies ?? [answer("from openrouter")]);
  const primary = primaryModel(opts.script);
  const model = fallbackModel({ primary, config: cfg, ledger, fetcher: or.fetcher, now });
  return { model, primary, or, ledger, d, advance: (ms: number) => void (t += ms), now };
};
const ask = (m: ModelPort, tools: ToolDef[] = []) => m.step!([{ role: "user", content: "hi" }], [], undefined, tools);
const tool = (name: string): ToolDef => ({ name, description: name, parameters: { type: "object", properties: {} } });

// ---- configuration ----------------------------------------------------------------------------------------------------

test("config: disabled by default; every missing or bad setting makes the fallback unavailable with a reason", () => {
  assert.equal(openrouterConfig({}, readKey).state, "disabled");
  const bad = (over: Record<string, string | undefined>, re: RegExp) => {
    const c = openrouterConfig({ ...ENV, ...over }, readKey);
    assert.equal(c.state, "unavailable");
    assert.match((c as { reason: string }).reason, re);
  };
  bad({ ORBIT_OPENROUTER_MODEL: undefined }, /no default model/);
  bad({ ORBIT_OPENROUTER_MODEL: "not a model" }, /plain OpenRouter model id/);
  bad({ ORBIT_OPENROUTER_MODEL: "vendor/m:online" }, /suffix/);
  bad({ ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: undefined }, /price is not set/);
  bad({ ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "abc" }, /positive number/);
  bad({ ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS: "999999" }, /MAX_OUTPUT_TOKENS/);
  bad({ ORBIT_OPENROUTER_TIMEOUT_MS: "5" }, /TIMEOUT/);
  bad({ ORBIT_OPENROUTER_DAILY_CAP_USD: "200" }, /daily cap cannot exceed/);
  bad({ CREDENTIALS_DIRECTORY: undefined }, /credential directory/);
  assert.match((openrouterConfig(ENV, () => { throw new Error("ENOENT"); }) as { reason: string }).reason, /not installed/);
  assert.match((openrouterConfig(ENV, () => "  \n") as { reason: string }).reason, /not installed/);
  const c = ready();
  assert.deepEqual([c.dailyCapUsd, c.totalCapUsd, c.maxOutputTokens], [5, 150, 2048]);
});

// ---- the client -------------------------------------------------------------------------------------------------------

test("client: tool-call round trip with every billable option pinned and the cost reconciled", async () => {
  const d = dir();
  const ledger = spendLedger(d, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const or = fakeOpenRouter([toolAnswer("jobs_list", {}, 0.0002), answer("done", 0.0003)]);
  const client = openrouterClient(ready(), ledger, or.fetcher);
  const first = await client.step([{ role: "user", content: "list" }], ["x"], undefined, [tool("jobs_list")]);
  assert.deepEqual(first.calls, [{ call_id: "tc_1", name: "jobs_list", arguments: "{}" }]);
  const items: Item[] = [{ role: "user", content: "list" }, { type: "function_call", call_id: "tc_1", name: "jobs_list", arguments: "{}" }, { type: "function_call_output", call_id: "tc_1", output: "{\"ok\":true}" }];
  const second = await client.step(items, [], undefined, [tool("jobs_list")]);
  assert.equal(second.text, "done");
  const [r1, r2] = or.requests;
  assert.equal(r1.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(r1.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r1.body.model, "vendor/cheap-model");
  assert.equal(r1.body.max_tokens, 2048);
  assert.equal(r1.body.stream, false);
  assert.deepEqual(r1.body.usage, { include: true });
  assert.deepEqual(r1.body.provider, { max_price: { prompt: 0.2, completion: 0.4 }, data_collection: "deny", allow_fallbacks: false });
  assert.equal(r1.body.models, undefined);
  assert.equal(r1.body.plugins, undefined);
  assert.equal(r1.body.tools[0].function.name, "jobs_list");
  assert.deepEqual(r2.body.messages.slice(-2).map((m: any) => m.role), ["assistant", "tool"]);
  assert.equal(r2.body.messages.at(-1).tool_call_id, "tc_1");
  const v = ledger.view();
  assert.equal(v.lifetimeUsd, 0.0005);
  assert.equal(v.reservedUsd, 0);
});

test("client: consecutive function calls become one assistant message", () => {
  const m = toMessages("sys", [
    { role: "user", content: "u" },
    { type: "function_call", call_id: "a", name: "x", arguments: "{}" },
    { type: "function_call", call_id: "b", name: "y", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "1" },
    { type: "function_call_output", call_id: "b", output: "2" },
  ]);
  assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "tool", "tool"]);
  assert.equal((m[2] as { tool_calls: unknown[] }).tool_calls.length, 2);
});

test("client: a provider error is sanitized and never carries the key", async () => {
  const ledger = spendLedger(undefined, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const or = fakeOpenRouter([{ status: 401, body: { error: { message: `bad key ${KEY} Bearer abcdefghijklmnop123456 ${"x".repeat(500)}` } } }]);
  const client = openrouterClient(ready(), ledger, or.fetcher);
  await assert.rejects(client.step([{ role: "user", content: "hi" }], [], undefined, []), (e: Error) => {
    assert.doesNotMatch(e.message, new RegExp(KEY));
    assert.doesNotMatch(e.message, /abcdefghijklmnop123456/);
    assert.ok(e.message.length < 300);
    assert.match(e.message, /HTTP 401/);
    return true;
  });
  // A 401 was refused before any work: the reservation is released, nothing is charged.
  assert.equal(ledger.view().lifetimeUsd, 0);
  assert.equal(sanitize(`k=${KEY}`, KEY), "k=[key]");
});

test("client: a reply cut off inside a tool call, an oversized request and a call storm are refused", async () => {
  const ledger = spendLedger(undefined, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const cut = { body: { choices: [{ finish_reason: "length", message: { content: null, tool_calls: [{ id: "t", function: { name: "jobs_list", arguments: "{\"a" } }] } }], usage: { cost: 0.0001 } } };
  const c1 = openrouterClient(ready(), ledger, fakeOpenRouter([cut]).fetcher);
  await assert.rejects(c1.step([{ role: "user", content: "hi" }], [], undefined, [tool("jobs_list")]), /no tool was run/);
  const big = fakeOpenRouter([answer("x")]);
  const c2 = openrouterClient(ready(), ledger, big.fetcher);
  await assert.rejects(c2.step([{ role: "user", content: "x".repeat(400_000) }], [], undefined, []), /too long/);
  assert.equal(big.requests.length, 0);
});

// ---- when the fallback is used ----------------------------------------------------------------------------------------

test("a primary success never touches OpenRouter", async () => {
  const w = world({ script: [say("from chatgpt")] });
  const s = await ask(w.model);
  assert.equal(s.text, "from chatgpt");
  assert.equal(s.fallback, undefined);
  assert.equal(w.or.requests.length, 0);
});

test("only usage and rate limits fall back; auth, overload, incomplete and arbitrary errors do not", async () => {
  for (const err of [new ProviderError("auth", "refused"), new ProviderError("overloaded", "busy"), new ProviderError("incomplete", "stopped"), new ProviderError("failed", "boom"), new Error("plain")]) {
    const w = world({ script: [err] });
    await assert.rejects(ask(w.model), (e: Error) => e === err);
    assert.equal(w.or.requests.length, 0, String(err));
  }
  for (const kind of ["usage_limit", "rate_limit"] as const) {
    const w = world({ script: [new ProviderError(kind, "limited")] });
    const s = await ask(w.model);
    assert.equal(s.fallback?.reason, kind);
    assert.equal(w.or.requests.length, 1);
  }
});

test("fallback answers carry explicit provenance: provider, model, reason, the primary's reset, the cost", async () => {
  const reset = new Date(T0 + 90 * MIN).toISOString();
  const w = world({ script: [usageLimit(reset)] });
  const s = await ask(w.model);
  assert.deepEqual(s.fallback, { provider: "openrouter", model: "vendor/cheap-model", reason: "usage_limit", primaryLimit: { until: reset, estimated: false }, costUsd: 0.0001 });
  assert.match(replySource("chatgpt-x", s.fallback), /^model\/openrouter\/vendor\/cheap-model \(FALLBACK, paid: ChatGPT usage limit, resets 2026-11-12T11:30:00.000Z\)$/);
  assert.match(replySource("chatgpt-x", { ...s.fallback!, primaryLimit: { until: reset, estimated: true } }, true), /estimated pause until .*earlier rounds of this reply came from chatgpt-x/);
  const st = w.model.status();
  assert.equal(st.state, "degraded");
  assert.match(st.detail, /resets at 2026-11-12T11:30:00.000Z/);
  assert.match(st.detail, /OpenRouter vendor\/cheap-model \(fallback, paid, restricted tools\)/);
  assert.match(st.detail, /Local OpenRouter allowance/);
});

test("a real reset: ChatGPT is not called before it; after it, a successful primary call is what recovers", async () => {
  const reset = new Date(T0 + 60 * MIN).toISOString();
  const w = world({ script: (n) => (n === 0 ? usageLimit(reset) : say("chatgpt is back")) });
  await ask(w.model);
  assert.equal(w.primary.state.calls, 1);
  w.advance(30 * MIN);
  const during = await ask(w.model);
  assert.ok(during.fallback);
  assert.equal(w.primary.state.calls, 1, "the primary must not be called before the reset");
  w.advance(31 * MIN);
  assert.match(w.model.status().detail, /has passed.*not confirmed recovered until one succeeds/);
  assert.equal(w.model.fallbackState().recoveredAt, undefined);
  const after = await ask(w.model);
  assert.equal(after.text, "chatgpt is back");
  assert.equal(after.fallback, undefined);
  assert.equal(w.model.fallbackState().usingFallback, false);
  assert.ok(w.model.fallbackState().recoveredAt);
  assert.match(w.model.status().detail, /recovered at .*a primary call succeeded/);
});

test("no reset time given: ORBIT's own estimated pause applies, is never shown as a reset, and recovery is confirmed by a call", async () => {
  const w = world({ script: (n) => (n === 0 ? usageLimit(undefined, "orbit_paused") : say("back")) });
  const first = await ask(w.model);
  assert.equal(first.fallback?.primaryLimit.estimated, true);
  assert.match(w.model.status().detail, /no reset time given, ORBIT's own pause \(an estimate\)/);
  w.advance(10 * MIN);
  assert.ok((await ask(w.model)).fallback);
  assert.equal(w.primary.state.calls, 1);
  w.advance(6 * MIN);
  assert.equal((await ask(w.model)).text, "back");
  assert.equal(w.primary.state.calls, 2);
});

test("if the primary is limited again after the pause, the fallback keeps answering", async () => {
  const w = world({ script: (n) => usageLimit(new Date(T0 + (n + 1) * 60 * MIN).toISOString()) });
  await ask(w.model);
  w.advance(61 * MIN);
  const s = await ask(w.model);
  assert.ok(s.fallback);
  assert.equal(w.primary.state.calls, 2);
  assert.equal(w.or.requests.length, 2);
});

test("missing key, disabled or bad config: the primary's behavior is kept and the refusal says the fallback is unavailable", async () => {
  const off = world({ script: [usageLimit()], cfg: { state: "disabled", reason: "The OpenRouter fallback is disabled." } });
  await assert.rejects(ask(off.model), (e: unknown) => e instanceof ProviderError && e.kind === "usage_limit" && /usage limit reached/.test(e.message) && /did not answer: The OpenRouter fallback is disabled/.test(e.message));
  const noKey = world({ script: [usageLimit()], cfg: openrouterConfig({ ...ENV }, () => "") });
  await assert.rejects(ask(noKey.model), /fallback did not answer: The orbit.openrouter credential is not installed/);
  assert.equal(noKey.or.requests.length, 0);
  assert.equal(noKey.model.status().state, "down");
  assert.match(noKey.model.status().detail, /No fallback is available/);
  const bad = world({ script: [usageLimit()], cfg: openrouterConfig({ ...ENV, ORBIT_OPENROUTER_MODEL: "nonsense" }, readKey) });
  await assert.rejects(ask(bad.model), /plain OpenRouter model id/);
  // Disabled and healthy: the status is the primary's, byte for byte.
  const quiet = world({ script: [say("x")], cfg: { state: "disabled", reason: "off" } });
  assert.deepEqual(quiet.model.status(), quiet.primary.status());
});

test("a fallback provider failure is reported together with the original limit, and nothing was run", async () => {
  const w = world({ script: [usageLimit()], replies: [{ status: 500, body: { error: { message: `upstream ${KEY}` } } }] });
  await assert.rejects(ask(w.model), (e: Error) => /usage limit reached/.test(e.message) && /OpenRouter: HTTP 500/.test(e.message) && !e.message.includes(KEY));
});

// ---- permissions ------------------------------------------------------------------------------------------------------

test("restricted tools are enforced in code: unlisted tools are not offered, and a call to one is refused", async () => {
  for (const banned of ["notify", "job_steer", "vault_write", "ops_propose_restart_orbit", "ops_propose_config_change", "ops_sys_cancel_reboot", "ops_propose_reboot_host"]) {
    assert.equal(FALLBACK_TOOLS.has(banned), false, banned);
  }
  assert.ok(FALLBACK_TOOLS.has("job_launch") && FALLBACK_TOOLS.has("memory_read") && FALLBACK_TOOLS.has("pr_diff"));
  const w = world({ script: [usageLimit()], replies: (n) => (n === 0 ? toolAnswer("notify", { text: "hi" }) : answer("x")) });
  await assert.rejects(ask(w.model, [tool("notify"), tool("jobs_list")]), /does not allow\. Nothing was run/);
  assert.deepEqual(w.or.requests[0].body.tools.map((t: any) => t.function.name), ["jobs_list"]);
});

test("through the chat loop: a refused fallback tool never runs, and an allowed read-only tool runs once", async () => {
  let notified = 0;
  let listed = 0;
  const tools: ChatTool[] = [
    { name: "notify", description: "n", parameters: {}, run: async () => (notified++, { value: "sent", provenance: "live", source: "n" }) },
    { name: "jobs_list", description: "j", parameters: {}, run: async () => (listed++, { value: [], provenance: "live", source: "jobs" }) },
  ];
  const w = world({ script: [usageLimit()], replies: (n) => (n === 0 ? toolAnswer("jobs_list", {}) : answer("no jobs")) });
  const out = await runChat({ model: w.model, messages: [{ role: "user", content: "jobs?" }], limits: [], tools });
  assert.equal(out.text, "no jobs");
  assert.equal(listed, 1);
  assert.equal(notified, 0);
  assert.equal(out.fallback?.model, "vendor/cheap-model");
  const w2 = world({ script: [usageLimit()], replies: [toolAnswer("notify", { text: "x" })] });
  await assert.rejects(runChat({ model: w2.model, messages: [{ role: "user", content: "x" }], limits: [], tools }), /Nothing was run/);
  assert.equal(notified, 0);
});

test("no tool side effect is replayed: a mid-reply limit continues from the recorded tool result and marks the mix", async () => {
  let ran = 0;
  const tools: ChatTool[] = [{ name: "jobs_list", description: "j", parameters: {}, run: async () => (ran++, { value: ["job-1"], provenance: "live", source: "jobs" }) }];
  const w = world({
    script: (n) => (n === 0 ? { text: "", calls: [call("jobs_list", {})] } : usageLimit(new Date(T0 + 60 * MIN).toISOString())),
    replies: [answer("one job: job-1")],
  });
  const out = await runChat({ model: w.model, messages: [{ role: "user", content: "jobs?" }], limits: [], tools });
  assert.equal(ran, 1);
  assert.equal(out.text, "one job: job-1");
  assert.equal(out.mixed, true);
  const sent = w.or.requests[0].body.messages;
  assert.equal(sent.filter((m: any) => m.role === "tool").length, 1);
  assert.match(sent.at(-1).content, /job-1/);
  assert.match(replySource("chatgpt-x", out.fallback, out.mixed), /earlier rounds of this reply came from chatgpt-x/);
});

test("persisted replies and the page: provenance is stored on the thread message, and job proposals still wait for confirmation", async () => {
  const reset = new Date(Date.now() + 60 * MIN).toISOString();
  const primary = primaryModel([usageLimit(reset)]);
  const or = fakeOpenRouter((n) => (n === 0 ? toolAnswer("job_launch", { routine: "orbit", brief: "do a thing" }) : answer("Proposed; waiting for Rai to confirm.")));
  const model = fallbackModel({ primary, config: ready(), ledger: spendLedger(undefined, { dailyMicro: toMicro(5), totalMicro: toMicro(150) }), fetcher: or.fetcher });
  const r = rig({ model });
  const t = await r.create("x");
  const res = await r.send(t.id, "launch it");
  assert.equal(res.status, 200);
  const last = res.data.thread.messages.at(-1);
  assert.equal(last.fallback.provider, "openrouter");
  assert.match(last.source, /^model\/openrouter\/vendor\/cheap-model \(FALLBACK, paid: ChatGPT usage limit, resets /);
  assert.equal(last.calls[0].name, "job_launch");
  // Unchanged confirmation gate: a card is open, nothing was launched.
  assert.equal(res.data.thread.cards[0].state, "open");
  assert.equal(r.fired.length, 0);
  const again = (await r.api(`/threads/${t.id}`)).data.thread.messages.at(-1);
  assert.equal(again.fallback.model, "vendor/cheap-model");
  assert.match(readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8"), /Fallback model, not ChatGPT/);
  r.close();
  void OWNER;
});

// ---- spend accounting -------------------------------------------------------------------------------------------------

test("daily cap: calls stop when the next bound would exceed it, with a fallback refusal that says why", async () => {
  const w = world({ script: [usageLimit(new Date(T0 + 600 * MIN).toISOString())], caps: { d: 0.003, t: 150 }, replies: [answer("ok", 0.001)] });
  let answered = 0;
  for (let i = 0; i < 10; i++) {
    try {
      await ask(w.model);
      answered++;
    } catch (e) {
      assert.match((e as Error).message, /daily cap of \$0\.00 .* would be exceeded|daily cap/);
      break;
    }
  }
  assert.ok(answered >= 1 && answered < 10, String(answered));
  assert.equal(w.or.requests.length, answered);
  assert.ok(w.ledger.view().spentTodayUsd <= 0.003);
});

test("total cap: lifetime is its own counter and day rollover does not reset it, a new UTC day resets only the daily one", () => {
  let t = Date.parse("2026-11-12T23:59:00Z");
  const l = spendLedger(dir(), { dailyMicro: 1000, totalMicro: 1500 }, () => new Date(t));
  const a = l.reserve(900);
  l.settle(a.id, 900);
  assert.throws(() => l.reserve(200), (e: unknown) => e instanceof SpendError && e.code === "daily_cap");
  t = Date.parse("2026-11-13T00:00:00Z");
  assert.equal(l.view().spentTodayUsd, 0);
  assert.equal(l.view().lifetimeUsd, 0.0009);
  const b = l.reserve(500);
  l.settle(b.id, 500);
  t = Date.parse("2026-11-14T00:00:01Z");
  assert.throws(() => l.reserve(200), (e: unknown) => e instanceof SpendError && e.code === "total_cap");
  assert.equal(l.view().remainingTotalUsd, 0.0001);
});

test("restart durability: spend and reservations survive a new process; a reservation left behind is charged at its bound", () => {
  const d = dir();
  const caps = { dailyMicro: 10_000, totalMicro: 100_000 };
  const now = () => new Date("2026-11-12T10:00:00Z");
  const one = spendLedger(d, caps, now);
  const a = one.reserve(1000);
  one.settle(a.id, 400);
  one.reserve(2000); // the process "dies" with this request unsettled
  const two = spendLedger(d, caps, now);
  const v = two.view();
  assert.equal(v.lifetimeUsd, 0.0024);
  assert.equal(v.spentTodayUsd, 0.0024);
  assert.equal(v.reservedUsd, 0);
  assert.equal(v.uncertainRequests, 1);
  assert.equal(spendLedger(d, caps, now).view().lifetimeUsd, 0.0024);
  assert.deepEqual(readdirSync(d), ["openrouter-spend.json"]);
});

test("concurrency: simultaneous calls cannot together exceed the allowance", async () => {
  const cfg = ready();
  const ledger = spendLedger(undefined, { dailyMicro: 3000, totalMicro: 100_000 });
  const or = fakeOpenRouter((_n) => ({ ...answer("ok", 0.0005), hang: false }));
  // Hold every response until all are in flight, so the reservations overlap.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = (async (url: string, init: RequestInit) => {
    await gate;
    return or.fetcher(url, init);
  }) as unknown as typeof fetch;
  const client = openrouterClient(cfg, ledger, slow);
  const results = Array.from({ length: 20 }, () => client.step([{ role: "user", content: "x".repeat(100) }], [], undefined, []).then(() => "ok", (e: Error) => (e instanceof SpendError ? "cap" : "other")));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const done = await Promise.all(results);
  const ok = done.filter((x) => x === "ok").length;
  const bytes = Buffer.byteLength(JSON.stringify(or.requests[0].body));
  const bound = toMicro((bytes + 64) * cfg.priceIn / 1e6 + cfg.maxOutputTokens * cfg.priceOut / 1e6);
  assert.equal(ok, Math.floor(3000 / bound), `bound ${bound}`);
  assert.ok(ok >= 1 && ok < 20);
  assert.equal(done.filter((x) => x === "cap").length, 20 - ok);
  assert.equal(or.requests.length, ok);
  assert.equal(ledger.view().reservedUsd, 0);
});

test("ambiguous or missing costs fail closed: the whole bound stays charged, never refunded", async () => {
  const ledger = spendLedger(undefined, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const none = openrouterClient(ready(), ledger, fakeOpenRouter([answer("ok", null)]).fetcher);
  await none.step([{ role: "user", content: "hi" }], [], undefined, []);
  const v = ledger.view();
  assert.equal(v.uncertainRequests, 1);
  assert.ok(v.lifetimeUsd > 0.0005, "charged at the bound, not at zero");
  const neg = openrouterClient(ready(), ledger, fakeOpenRouter([answer("ok", -1)]).fetcher);
  await neg.step([{ role: "user", content: "hi" }], [], undefined, []);
  assert.equal(ledger.view().uncertainRequests, 2);
  // A server error of unknown cost is also charged.
  const err = openrouterClient(ready(), ledger, fakeOpenRouter([{ status: 502, body: {} }]).fetcher);
  await assert.rejects(err.step([{ role: "user", content: "hi" }], [], undefined, []), /HTTP 502/);
  assert.equal(ledger.view().uncertainRequests, 3);
  assert.equal(ledger.view().reservedUsd, 0);
});

test("a provider cost above the reserved bound is recorded in full and flagged", () => {
  const l = spendLedger(undefined, { dailyMicro: 10_000, totalMicro: 100_000 });
  const r = l.reserve(100);
  l.settle(r.id, 500);
  assert.equal(l.view().lifetimeUsd, 0.0005);
  assert.equal(l.view().uncertainRequests, 1);
});

test("a corrupt, unknown or vanished ledger stops all paid calls instead of starting from zero", async () => {
  const d = dir();
  const file = join(d, "openrouter-spend.json");
  const caps = { dailyMicro: 10_000, totalMicro: 100_000 };
  const first = spendLedger(d, caps);
  first.settle(first.reserve(100).id, 100);
  for (const bad of ["{not json", "[]", JSON.stringify({ schema: 2 }), JSON.stringify({ schema: 1, lifetimeMicro: -5, days: {}, reservations: {}, uncertain: [] }), ""]) {
    writeFileSync(file, bad);
    assert.throws(() => spendLedger(d, caps).reserve(10), (e: unknown) => e instanceof SpendError && e.code === "ledger", bad);
  }
  writeFileSync(file, "{not json");
  const w = world({ script: [usageLimit()], d });
  await assert.rejects(ask(w.model), /spend ledger is corrupt/);
  assert.equal(w.or.requests.length, 0);
  assert.equal(readFileSync(file, "utf8"), "{not json", "the bad file is left alone for a person to look at");
  // The file disappearing under a running process is not a fresh start either.
  const live = spendLedger(d, caps);
  writeFileSync(file, JSON.stringify({ schema: 1, createdAt: "x", lifetimeMicro: 0, days: {}, reservations: {}, uncertain: [] }));
  live.view();
  writeFileSync(file, "garbage");
  assert.throws(() => live.view(), SpendError);
  assert.throws(() => spendLedger(undefined, { dailyMicro: 0, totalMicro: 1 }), SpendError);
  assert.throws(() => spendLedger(d, caps).reserve(0), /not a positive amount/);
});

test("timeouts are bounded, the answer is an error, and the possibly-billed request keeps its bound charged", async () => {
  const cfg = ready({ ORBIT_OPENROUTER_TIMEOUT_MS: "1000" });
  const ledger = spendLedger(undefined, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const or = fakeOpenRouter([{ hang: true }]);
  const client = openrouterClient(cfg, ledger, or.fetcher);
  const started = Date.now();
  await assert.rejects(client.step([{ role: "user", content: "hi" }], [], undefined, []), /no answer within 1 s/);
  assert.ok(Date.now() - started < 5000);
  assert.equal(ledger.view().uncertainRequests, 1);
  assert.ok(ledger.view().lifetimeUsd > 0);
});

test("the fallback's own spend never leaks a secret into status or errors", async () => {
  const w = world({ script: [usageLimit()], replies: [{ status: 500, body: { error: { message: KEY } } }] });
  await assert.rejects(ask(w.model));
  const text = JSON.stringify(w.model.status());
  assert.doesNotMatch(text, new RegExp(KEY));
  assert.equal(readFileSync(join(w.d, "openrouter-spend.json"), "utf8").includes(KEY), false);
});

test("balance: the OpenRouter key view is labeled as the account side, separate from the local allowance", async () => {
  const w = world({ script: [say("x")], replies: (n, b) => (b === undefined ? { body: { data: { limit: 20, limit_remaining: 12.5, usage: 7.5 } } } : answer("x")) });
  await w.model.maintain!();
  assert.match(w.model.status().detail, /OpenRouter key \(account side, not the local allowance\): limit \$20\.00, remaining \$12\.50, used \$7\.50/);
  assert.match(w.model.status().detail, /Local OpenRouter allowance/);
  const w2 = world({ script: [say("x")], replies: [{ status: 403, body: {} }] });
  await w2.model.maintain!();
  assert.match(w2.model.status().detail, /balance unavailable/);
});

test("a call during a limit made after a restart: the new process learns the pause from the primary's own refusal", async () => {
  const w = world({ script: [usageLimit(undefined, "orbit_paused")] });
  const s = await ask(w.model);
  assert.equal(s.fallback?.primaryLimit.estimated, true);
  assert.equal(w.model.fallbackState().limit?.kind, "usage_limit");
});

// ---- regression: defects confirmed on main after #56 -------------------------------------------------------------------

test("reply: a mock primary's own result passes through, never relabelled live", async () => {
  const mock: ModelPort = {
    status: () => ({ port: "model", state: "mock", impl: "mock-echo", detail: "mock", verifiedAt: new Date(T0).toISOString() }),
    reply: async () => ({ value: "echo", provenance: "mock", source: "model/mock-echo" }),
  };
  const m = fallbackModel({ primary: mock, config: ready(), ledger: spendLedger(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }), fetcher: fakeOpenRouter([answer("x")]).fetcher });
  const r = await m.reply([{ role: "user", content: "hi" }], []);
  assert.equal(r.provenance, "mock");
  assert.equal(r.source, "model/mock-echo");
  assert.equal(r.fallback, undefined);
});

test("reply: the fallback path carries the labelled FALLBACK, paid source", async () => {
  const w = world({ script: [usageLimit(new Date(T0 + 60 * MIN).toISOString())] });
  const r = await w.model.reply([{ role: "user", content: "hi" }], []);
  assert.equal(r.value, "from openrouter");
  assert.match(r.source, /model\/openrouter\/vendor\/cheap-model \(FALLBACK, paid: ChatGPT usage limit/);
  assert.ok(r.fallback);
});

test("reply: background callers (fallback: false) never spend OpenRouter while the primary is limited", async () => {
  const w = world({ script: [usageLimit(new Date(T0 + 60 * MIN).toISOString())] });
  await assert.rejects(w.model.reply([{ role: "user", content: "summarise" }], [], undefined, { fallback: false }), (e: unknown) => e instanceof ProviderError && e.kind === "usage_limit");
  // Limit now in force: a second background call is refused without reaching the primary or OpenRouter.
  await assert.rejects(w.model.reply([{ role: "user", content: "again" }], [], undefined, { fallback: false }), ProviderError);
  assert.equal(w.or.requests.length, 0);
  assert.equal(w.ledger.view().lifetimeUsd, 0);
  // An interactive reply still gets the fallback.
  assert.equal((await w.model.reply([{ role: "user", content: "hi" }], [])).fallback?.provider, "openrouter");
  assert.equal(w.or.requests.length, 1);
});

test("config: oversized caps are unavailable with a reason, and the ledger error says too large", () => {
  for (const cap of ["1e10", "1e11", "9.1e9", "10001"]) {
    const c = openrouterConfig({ ...ENV, ORBIT_OPENROUTER_DAILY_CAP_USD: "1", ORBIT_OPENROUTER_TOTAL_CAP_USD: cap }, readKey);
    assert.equal(c.state, "unavailable", cap);
    assert.match((c as { reason: string }).reason, /at most 10000/);
  }
  assert.equal(ready({ ORBIT_OPENROUTER_TOTAL_CAP_USD: "10000" }).totalCapUsd, 10000);
  assert.throws(() => spendLedger(dir(), { dailyMicro: toMicro(1), totalMicro: toMicro(1e10) }), (e: unknown) => e instanceof SpendError && /no larger/.test(e.message));
});

test("client: a failing ledger write on an error path does not hide the provider error or leak a path", async () => {
  const d = dir();
  const ledger = spendLedger(d, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const real = ledger.settle.bind(ledger);
  let boom = false;
  const guarded = { ...ledger, settle: (...a: Parameters<typeof real>) => (boom ? (() => { throw new Error(`EISDIR ${d}/openrouter-spend.json.new`); })() : real(...a)) };
  const client = openrouterClient(ready({ ORBIT_OPENROUTER_TIMEOUT_MS: "1000" }), guarded, fakeOpenRouter([{ hang: true }]).fetcher);
  boom = true;
  await assert.rejects(client.step([{ role: "user", content: "hi" }], [], undefined, []), (e: unknown) => e instanceof ProviderError && /no answer within/.test(e.message) && /spend accounting also failed/.test(e.message) && !e.message.includes(d));
});

test("client: a billed answer survives a failing settle and says so", async () => {
  const d = dir();
  const ledger = spendLedger(d, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const guarded = { ...ledger, settle: () => { throw new Error(`EISDIR ${d}`); } };
  const client = openrouterClient(ready(), guarded, fakeOpenRouter([answer("paid answer")]).fetcher);
  const s = await client.step([{ role: "user", content: "hi" }], [], undefined, []);
  assert.match(s.text, /^paid answer/);
  assert.match(s.text, /Spend accounting note/);
  assert.ok(!s.text.includes(d));
});

test("client: a non-JSON balance body is reported without echoing it", async () => {
  const ledger = spendLedger(undefined, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const client = openrouterClient(ready(), ledger, fakeOpenRouter([{ text: "<html>secret-ish-body" }]).fetcher);
  await assert.rejects(client.balance(), (e: unknown) => e instanceof ProviderError && /unreadable body/.test(e.message) && !/secret-ish/.test(e.message));
});
