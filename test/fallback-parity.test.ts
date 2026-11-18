import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort, ToolDef } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { PHOTO_TOOL_NAMES } from "../src/photo-access.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";
import { call, OWNER, rig, say, scripted } from "./threads-fixture.ts";
import type { Script } from "./threads-fixture.ts";

// Fallback capability parity (docs/openrouter-fallback.md, "Tools"): while the paid fallback answers, ORBIT offers it exactly the tools
// it would offer the primary for the same request, and every model-independent safeguard (owner check, policy, confirmation cards)
// still applies. Also the model port's state while the fallback answers, when both are unavailable, and after recovery. Offline: the
// "provider" is a fake fetch and the primary a scripted model; nothing paid is reachable.

const MIN = 60_000;
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048",
  CREDENTIALS_DIRECTORY: "/creds",
};
const ready = () => {
  const c = openrouterConfig(ENV, () => ["sk", "or", "v1", "0".repeat(32)].join("-"));
  assert.equal(c.state, "ready");
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};

type OrReply = { content?: string; calls?: { name: string; args: unknown }[] };
function fakeOpenRouter(next: (n: number, body: any) => OrReply) {
  const requests: any[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const r = next(requests.length - 1, body);
    const message = r.calls?.length
      ? { content: null, tool_calls: r.calls.map((c, i) => ({ id: `tc_${requests.length}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : { content: r.content ?? "ok" };
    return new Response(JSON.stringify({ choices: [{ finish_reason: r.calls?.length ? "tool_calls" : "stop", message }], usage: { cost: 0.0001 } }));
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

// A primary that answers from `script` until `limited` is set, then throws ChatGPT's usage limit with a reset `resetIn` from now.
function switchable(script: Script, clock: { t: number }) {
  const inner = scripted(script);
  const sw = { limited: false };
  const limit = () => new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", new Date(clock.t + 30 * MIN).toISOString());
  const primary: ModelPort & { seen: typeof inner.seen } = {
    seen: inner.seen,
    // The configured primary takes photos, so any block below is the fallback's, not the model's.
    images: () => ({ ok: true, detail: "the configured model takes photos" }),
    status: () => ({ port: "model", state: sw.limited ? "down" : "live", impl: "chatgpt-token-sharing/gpt-x", detail: sw.limited ? "usage limit" : "Answering.", verifiedAt: new Date(clock.t).toISOString() }),
    reply: async (m, l, n, o) => {
      if (sw.limited) throw limit();
      return inner.reply(m, l, n, o);
    },
    step: async (i, l, n, t, o) => {
      if (sw.limited) throw limit();
      return inner.step!(i, l, n, t, o);
    },
  };
  return { primary, sw };
}

function world(primaryScript: Script, orNext: (n: number, body: any) => OrReply) {
  const clock = { t: Date.now() };
  const { primary, sw } = switchable(primaryScript, clock);
  const or = fakeOpenRouter(orNext);
  const ledger = provisioned(mkdtempSync(join(tmpdir(), "orbit-parity-spend-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(clock.t));
  const model = fallbackModel({ primary, config: ready(), ledger, fetcher: or.fetcher, now: () => clock.t });
  return { model, primary, sw, or, ledger, clock };
}

// ---- tool parity through the real server ------------------------------------------------------------------------------------------

test("parity: for the same owner request the fallback is offered exactly the primary's tools, including every proposal and write tool", async () => {
  const w = world(() => say("primary answer"), () => ({ content: "fallback answer" }));
  const x = rig({ model: w.model, admin: true });
  const t = await x.create();
  assert.equal((await x.send(t.id, "what can you do?")).status, 200);
  const primaryTools = w.primary.seen.at(-1)!.tools;
  assert.ok(primaryTools.length > 10, "the owner's chat offers a real tool set");
  for (const n of ["job_launch", "notify", "ops_propose_restart_orbit", "ops_propose_config_change"]) assert.ok(primaryTools.includes(n), n);

  w.sw.limited = true;
  const res = await x.send(t.id, "what can you do?");
  assert.equal(res.status, 200);
  const last = res.data.thread.messages.at(-1);
  assert.equal(last.fallback.model, "vendor/cheap-model", "honest attribution: the reply names the fallback model");
  const fallbackTools = w.or.requests.at(-1).tools.map((d: any) => d.function.name);
  assert.deepEqual(fallbackTools, primaryTools, "same tools, same order");
  // The prompt lists the same tools as the primary's and tells the fallback who it is.
  const system = w.or.requests.at(-1).messages[0].content as string;
  assert.match(system, /You can call exactly these tools in this step/);
  assert.match(system, /you are the OpenRouter fallback model \(vendor\/cheap-model\)/);
  assert.match(system, /same ORBIT tools as the primary model/);
  assert.doesNotMatch(system, /[Ww]ithheld while the fallback|refused by ORBIT/);
  x.close();
});

test("confirmation gates hold on the fallback as on the primary: a server-operation proposal opens a card and dispatches nothing", async () => {
  for (const viaFallback of [false, true]) {
    const w = world(
      (_s, n) => (n === 0 ? { text: "", calls: [call("ops_propose_restart_orbit", {})] } : say("Proposed; waiting for your confirmation.")),
      (n) => (n === 0 ? { calls: [{ name: "ops_propose_restart_orbit", args: {} }] } : { content: "Proposed; waiting for your confirmation." }),
    );
    w.sw.limited = viaFallback;
    const x = rig({ model: w.model, admin: true });
    const t = await x.create();
    const res = await x.send(t.id, "restart orbit");
    assert.equal(res.status, 200);
    const card = res.data.thread.cards[0];
    assert.equal(card.kind, "ops_admin", `card (${viaFallback ? "fallback" : "primary"})`);
    assert.equal(card.state, "open");
    assert.deepEqual(x.helper.calls, [], "nothing dispatched before Rai confirms");
    assert.equal(Boolean(res.data.thread.messages.at(-1).fallback), viaFallback);
    // The card still needs its digest; the confirmation itself is the same route whichever model proposed it.
    assert.equal((await x.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: "wrong" })).status, 409);
    assert.deepEqual(x.helper.calls, []);
    assert.equal((await x.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest })).status, 202);
    assert.deepEqual(x.helper.calls, ["restart_orbit"]);
    x.close();
  }
});

test("job proposals and policy refusals hold on the fallback: job_launch waits for confirmation; a tool that was not offered runs nothing", async () => {
  const w = world(() => say("x"), (n) => (n === 0 ? { calls: [{ name: "job_launch", args: { routine: "orbit", brief: "Build it" } }, { name: "made_up_admin_tool", args: {} }] } : { content: "Proposed." }));
  w.sw.limited = true;
  const x = rig({ model: w.model });
  const t = await x.create();
  const res = await x.send(t.id, "launch it");
  assert.equal(res.status, 200);
  assert.equal(res.data.thread.cards[0].state, "open");
  assert.equal(x.fired.length, 0, "nothing launched before confirmation");
  const calls = res.data.thread.messages.at(-1).calls;
  const made = calls.find((c: any) => c.name === "made_up_admin_tool");
  assert.equal(made.ok, false);
  assert.match(made.summary, /No tool named made_up_admin_tool/);
  x.close();
});

test("owner check holds on both: a non-owner /chat request is offered no tools by either model", async () => {
  for (const viaFallback of [false, true]) {
    const w = world(() => say("x"), () => ({ content: "fallback says hi" }));
    w.sw.limited = viaFallback;
    const x = rig({ model: w.model });
    x.caller.who = "someone-else@example.com";
    const res = await x.api("/chat", "POST", { messages: [{ role: "user", content: "hello" }] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.calls, []);
    assert.equal(w.primary.seen.length, 0, "no tool-using step for a non-owner");
    if (viaFallback) {
      assert.equal(w.or.requests.length, 1);
      assert.equal(w.or.requests[0].tools, undefined, "no tools sent to the fallback for a non-owner");
      assert.match(res.data.reply.source, /FALLBACK, paid/);
    } else assert.equal(w.or.requests.length, 0);
    x.close();
  }
});

// ---- modality: still honest -------------------------------------------------------------------------------------------------------

test("photo tools reach the fallback in the canonical form (no strict flag, schema unchanged), but photos themselves stay blocked", async () => {
  const w = world(() => say("x"), () => ({ content: "ok" }));
  w.sw.limited = true;
  const defs: ToolDef[] = PHOTO_TOOL_NAMES.map((name) => ({ name, description: "d", parameters: { type: "object", properties: { x: { type: "string" } }, required: [], additionalProperties: false }, strict: true }));
  await w.model.step!([{ role: "user", content: "hi" }], [], undefined, defs, { fallback: true });
  const sent = w.or.requests[0].tools;
  assert.deepEqual(sent.map((t: any) => t.function.name), [...PHOTO_TOOL_NAMES]);
  for (const [i, s] of sent.entries()) {
    assert.equal("strict" in s.function, false);
    assert.deepEqual(s.function.parameters, defs[i]!.parameters);
  }
  assert.match(w.or.requests[0].messages[0].content, /not given images in this build/);
  // While the fallback answers, images() refuses photos before any request, so a photo tool cannot supply one.
  const images = w.model.images!();
  assert.equal(images.ok, false);
  assert.match(images.detail, /not given photos in this build/);
});

// ---- the model port's state: the signals the page's status indicator reads ------------------------------------------------------------

test("model port: fallback answering is degraded with the route named; caps used up is down; recovery is live again", async () => {
  const w = world(() => say("primary"), () => ({ content: "fallback" }));
  assert.equal(w.model.status().state, "live");
  assert.equal(w.model.status().fallback, undefined);

  w.sw.limited = true;
  await w.model.reply([{ role: "user", content: "hi" }], []);
  let st = w.model.status();
  assert.equal(st.state, "degraded", "working on the fallback: degraded, not down");
  assert.deepEqual({ ...st.fallback, until: undefined }, { provider: "openrouter", model: "vendor/cheap-model", answering: true, reason: "usage_limit", until: undefined, estimated: false, lastCall: "succeeded" });
  assert.match(st.detail, /Replies come from OpenRouter vendor\/cheap-model \(fallback, paid; same tools and confirmations as ChatGPT; no photos\)/);

  // Both providers unavailable: ChatGPT limited and the fallback's daily cap used up.
  const left = w.ledger.view().remainingTodayUsd;
  w.ledger.settle(w.ledger.reserve(toMicro(left)).id, toMicro(left));
  st = w.model.status();
  assert.equal(st.state, "down");
  assert.equal(st.fallback?.answering, false);
  assert.match(st.detail, /daily spend cap is used up, so replies fail until then/);

  // The reset passes: not yet confirmed (degraded); the first successful primary call is recovery (live, no fallback route).
  w.sw.limited = false;
  w.clock.t += 31 * MIN;
  st = w.model.status();
  assert.equal(st.state, "degraded");
  assert.equal(st.fallback?.answering, false);
  await w.model.reply([{ role: "user", content: "hi" }], []);
  st = w.model.status();
  assert.equal(st.state, "live");
  assert.equal(st.fallback, undefined);
  assert.match(st.detail, /ChatGPT recovered at/);
});

test("model port: with no usable fallback configured, a limit is down (both unavailable), never degraded", async () => {
  const clock = { t: Date.now() };
  const { primary, sw } = switchable(() => say("x"), clock);
  const model = fallbackModel({ primary, config: { state: "unavailable", reason: "the OpenRouter credential is not installed" } as OpenRouterConfig, now: () => clock.t });
  sw.limited = true;
  await assert.rejects(model.reply([{ role: "user", content: "hi" }], []), /The OpenRouter fallback did not answer/);
  const st = model.status();
  assert.equal(st.state, "down");
  assert.equal(st.fallback, undefined, "no route is claimed when no client exists");
  void OWNER;
});
