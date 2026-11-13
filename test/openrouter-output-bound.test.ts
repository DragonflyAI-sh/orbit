import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { HARD_MAX_OUTPUT_BOUND_TOKENS, MAX_REQUEST_BYTES, openrouterClient, openrouterConfig, reservationUsd } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { SpendError, spendLedger, toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";

// The reservation must bound what a call can be billed even when a provider does not count reasoning against max_tokens (OpenRouter:
// reasoning counts against max_tokens only "on most providers"). Fakes only: nothing here reaches OpenRouter or any paid service.

const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
// The recommended activation values from docs/openrouter-activation-runbook.md (deepseek/deepseek-v4-flash, 2026-11-13 metadata).
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.25",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.6",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "1048576",
  ORBIT_OPENROUTER_DAILY_CAP_USD: "5",
  ORBIT_OPENROUTER_TOTAL_CAP_USD: "150",
  CREDENTIALS_DIRECTORY: "/creds",
};
const readKey = () => KEY;
const cfgOf = (over: Record<string, string | undefined> = {}) => openrouterConfig({ ...ENV, ...over }, readKey);
const ready = (over: Record<string, string | undefined> = {}) => {
  const c = cfgOf(over);
  assert.equal(c.state, "ready", JSON.stringify(c));
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};
const dir = () => mkdtempSync(join(tmpdir(), "orbit-bound-"));

type Reply = { status?: number; body?: unknown; hang?: boolean };
function fake(replies: (n: number) => Reply, gate?: Promise<void>) {
  const requests: any[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (gate) await gate;
    const r = replies(requests.length - 1);
    if (r.hang) {
      const keep = setTimeout(() => {}, 10_000);
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => (clearTimeout(keep), reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))));
    }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}
// A reply whose provider ignored max_tokens for reasoning: 200,000 reasoning tokens at 0.60 USD/M is 0.12 USD, a hundred times what a
// max_tokens-only bound (2,048 x 0.60 / 1e6 = 0.0012 USD of output) would have reserved.
const reasoningHeavy = { body: { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { cost: 0.12, completion_tokens: 200_100, completion_tokens_details: { reasoning_tokens: 200_000 } } } };

test("config: the output bound is required, has no default, must be at least max_tokens and at most the hard limit", () => {
  const off = cfgOf({ ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: undefined });
  assert.equal(off.state, "unavailable");
  assert.match((off as { reason: string }).reason, /ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS is not set.*no default/);
  for (const bad of ["2047", "abc", "1.5", "0", String(HARD_MAX_OUTPUT_BOUND_TOKENS + 1)]) {
    const c = cfgOf({ ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: bad });
    assert.equal(c.state, "unavailable", bad);
  }
  assert.equal(ready({ ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048" }).outputBoundTokens, 2048);
  assert.equal(ready().outputBoundTokens, 1048576);
  // Disabled stays disabled whatever else is set: the default is off.
  assert.equal(openrouterConfig({ ...ENV, ORBIT_OPENROUTER_ENABLED: undefined }, readKey).state, "disabled");
});

test("config: a daily cap below the reservation for the largest request is refused at startup, not at the first call", () => {
  // 0.25/0.60 with a 1,048,576-token bound: the largest request reserves about 0.704 USD.
  const largest = reservationUsd(MAX_REQUEST_BYTES, 0.25, 0.6, 1048576);
  assert.ok(Math.abs(largest - 0.704162) < 1e-6, String(largest));
  const c = cfgOf({ ORBIT_OPENROUTER_DAILY_CAP_USD: "0.5", ORBIT_OPENROUTER_TOTAL_CAP_USD: "1" });
  assert.equal(c.state, "unavailable");
  assert.match((c as { reason: string }).reason, /daily cap \(0\.5 USD\) is below the reservation for the largest request \(0\.704162 USD/);
  assert.equal(ready({ ORBIT_OPENROUTER_DAILY_CAP_USD: "0.75", ORBIT_OPENROUTER_TOTAL_CAP_USD: "1" }).dailyCapUsd, 0.75);
});

test("request: reasoning off, require_parameters on, usage.include not sent; every other pinned lever unchanged", async () => {
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const or = fake(() => ({ body: { choices: [{ finish_reason: "stop", message: { content: "hi" } }], usage: { cost: 0.00001 } } }));
  await openrouterClient(ready(), ledger, or.fetcher).step([{ role: "user", content: "hello" }], [], undefined, []);
  const b = or.requests[0];
  assert.deepEqual(b.reasoning, { effort: "none" });
  assert.deepEqual(b.provider, { max_price: { prompt: 0.25, completion: 0.6 }, data_collection: "deny", allow_fallbacks: false, require_parameters: true });
  assert.equal(b.usage, undefined);
  assert.equal(b.max_tokens, 2048);
  assert.equal(b.stream, false);
  assert.equal(b.model, "deepseek/deepseek-v4-flash");
  for (const k of ["models", "plugins", "route", "web_search_options"]) assert.equal(b[k], undefined, k);
});

test("reservation: covers the output bound, not max_tokens, so a provider that lets reasoning ignore max_tokens stays inside it", async () => {
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const or = fake(() => reasoningHeavy, gate);
  const p = openrouterClient(ready(), ledger, or.fetcher).step([{ role: "user", content: "think hard" }], [], undefined, []);
  await new Promise((r) => setTimeout(r, 10));
  const bytes = Buffer.byteLength(JSON.stringify(or.requests[0]));
  const expected = toMicro(reservationUsd(bytes, 0.25, 0.6, 1048576));
  assert.equal(toMicro(ledger.view().reservedUsd), expected, "in flight: the whole output bound is reserved");
  assert.ok(expected > toMicro(0.12), "the reasoning-heavy cost fits inside the reservation");
  open();
  const s = await p;
  assert.equal(s.text, "ok");
  const v = ledger.view();
  // Settled at the provider's reported cost; not an overshoot ("provider cost exceeded the reserved bound" would make it uncertain).
  assert.equal(v.lifetimeUsd, 0.12);
  assert.equal(v.uncertainRequests, 0);
  assert.equal(v.reservedUsd, 0);
  assert.equal(s.accounting, undefined);
});

test("reservation: the same reasoning-heavy reply under the old max_tokens-only bound would have overshot (documents the defect fixed)", async () => {
  // With the output bound set to max_tokens, the reservation is the pre-change formula: the 0.12 USD cost exceeds it and is flagged.
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const or = fake(() => reasoningHeavy);
  await openrouterClient(ready({ ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048" }), ledger, or.fetcher).step([{ role: "user", content: "think hard" }], [], undefined, []);
  assert.equal(ledger.view().uncertainRequests, 1);
  assert.equal(ledger.view().lifetimeUsd, 0.12);
});

test("timeouts and unknown costs are charged at the full output-bound reservation, never at a max_tokens-sized guess", async () => {
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const hung = fake(() => ({ hang: true }));
  await assert.rejects(openrouterClient(ready({ ORBIT_OPENROUTER_TIMEOUT_MS: "1000" }), ledger, hung.fetcher).step([{ role: "user", content: "x" }], [], undefined, []), /no answer within 1 s/);
  const b1 = toMicro(reservationUsd(Buffer.byteLength(JSON.stringify(hung.requests[0])), 0.25, 0.6, 1048576));
  assert.equal(toMicro(ledger.view().lifetimeUsd), b1);
  const noCost = fake(() => ({ body: { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: {} } }));
  await openrouterClient(ready(), ledger, noCost.fetcher).step([{ role: "user", content: "x" }], [], undefined, []);
  const b2 = toMicro(reservationUsd(Buffer.byteLength(JSON.stringify(noCost.requests[0])), 0.25, 0.6, 1048576));
  assert.equal(toMicro(ledger.view().lifetimeUsd), b1 + b2);
  assert.equal(ledger.view().uncertainRequests, 2);
});

test("admission: when less than one full reservation is left today, the call is refused before anything is sent", async () => {
  // 5 USD daily with 4.5 already declared today: 0.5 left, below the ~0.63 USD a short request reserves. Nothing is sent or charged.
  const d = dir();
  const ledger = spendLedger(d, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(d, "openrouter-spend.provision"), JSON.stringify({ openingLifetimeUsd: 4.5, openingTodayUsd: 4.5, note: "test: declared opening spend" }));
  ledger.open();
  const or = fake(() => ({ body: { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { cost: 0.0001 } } }));
  await assert.rejects(openrouterClient(ready(), ledger, or.fetcher).step([{ role: "user", content: "x" }], [], undefined, []), (e: unknown) => e instanceof SpendError && e.code === "daily_cap");
  assert.equal(or.requests.length, 0);
  assert.equal(ledger.view().reservedUsd, 0);
  assert.equal(ledger.view().lifetimeUsd, 4.5);
});

test("end to end with the recommended values: ChatGPT stays primary, the limit falls back with provenance, the call is reserved at the bound and settled, then ChatGPT recovers", async () => {
  const T0 = Date.parse("2026-11-13T10:00:00Z");
  let t = T0;
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(t));
  const resets = new Date(T0 + 30 * 60_000).toISOString();
  let primaryCalls = 0;
  const primary: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-x", detail: "Answering.", verifiedAt: new Date(T0).toISOString() }),
    step: async (): Promise<Step> => {
      primaryCalls++;
      if (primaryCalls === 2) throw new ProviderError("usage_limit", "ChatGPT usage limit reached.", resets);
      return { text: "from chatgpt", calls: [] };
    },
    reply: async () => ({ value: "from chatgpt", provenance: "live", source: "model/chatgpt-token-sharing/gpt-x" }),
  };
  const or = fake(() => ({ body: { choices: [{ finish_reason: "stop", message: { content: "from fallback" } }], usage: { cost: 0.0004 } } }));
  const m = fallbackModel({ primary, config: ready(), ledger, fetcher: or.fetcher, now: () => t });
  const s1 = await m.step!([{ role: "user", content: "a" }], [], undefined, [], { fallback: true });
  assert.equal(s1.text, "from chatgpt");
  assert.equal(or.requests.length, 0, "ChatGPT answered: nothing paid");
  const s2 = await m.step!([{ role: "user", content: "b" }], [], undefined, [], { fallback: true });
  assert.equal(s2.text, "from fallback");
  assert.deepEqual(s2.fallback, { provider: "openrouter", model: "deepseek/deepseek-v4-flash", reason: "usage_limit", primaryLimit: { until: resets, estimated: false }, costUsd: 0.0004 });
  assert.equal(ledger.view().lifetimeUsd, 0.0004);
  // A background (non opted-in) call during the limit spends nothing.
  await assert.rejects(m.step!([{ role: "user", content: "bg" }], [], undefined, []), (e: unknown) => e instanceof ProviderError && e.kind === "usage_limit");
  assert.equal(or.requests.length, 1);
  assert.match(m.status().detail, /OpenRouter fallback armed: deepseek\/deepseek-v4-flash/);
  t = Date.parse(resets) + 1;
  const s3 = await m.step!([{ role: "user", content: "c" }], [], undefined, [], { fallback: true });
  assert.equal(s3.text, "from chatgpt");
  assert.equal(or.requests.length, 1);
  assert.ok(m.fallbackState().recoveredAt);
});
