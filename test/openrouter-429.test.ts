import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderError, RATE_PAUSE_MS } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { HoldEvent } from "../src/fallback.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { MAX_RETRY_WAIT_MS, NO_BALANCE, OpenRouterLimit, openrouterClient, openrouterConfig, openrouterReset, RATE_LIMITED, RETRY_DEFAULT_MS } from "../src/openrouter.ts";
import type { LimitEvent, OpenRouterConfig } from "../src/openrouter.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { MESSAGE_KEPT } from "../src/thread-service.ts";
import { provisioned } from "./helpers/ledger.ts";
import { rig } from "./threads-fixture.ts";

// OpenRouter's own HTTP 429 (rate limit) and 402 / "no balance" refusals: one bounded retry in the client, then a hold in the fallback
// so nothing more is sent until the reset, clear errors, logs, and Rai's message kept. Nothing here reaches OpenRouter: the provider is a
// fake fetch, time is a variable and the retry wait is recorded, not slept.

const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
const T0 = Date.parse("2026-11-22T05:30:00Z");
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048",
  CREDENTIALS_DIRECTORY: "/creds",
};
const ready = () => {
  const c = openrouterConfig(ENV, () => KEY);
  assert.equal(c.state, "ready", JSON.stringify(c));
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};
const dir = () => mkdtempSync(join(tmpdir(), "orbit-or429-"));

type R = { status?: number; body?: unknown; headers?: Record<string, string> };
const ok = (text = "from openrouter", cost = 0.0001): R => ({ body: { choices: [{ finish_reason: "stop", message: { content: text } }], usage: { cost } } });
const limited = (headers: Record<string, string> = {}, body: unknown = { error: { code: 429, message: "Rate limit exceeded" } }): R => ({ status: 429, body, headers });
const noCredits: R = { status: 402, body: { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } } };
const keyBody = (remaining: number | null) => ({ body: { data: { limit: remaining === null ? null : 10, limit_remaining: remaining, usage: 1 } } });

// The fake: completions answer from `replies` in order (the last one repeats); GET /key answers from `balances` in order.
function fake(replies: R[], balances: R[] = [keyBody(0)]) {
  const seen = { completions: 0, keys: 0 };
  const fetcher = (async (url: string) => {
    const r = url.endsWith("/key") ? balances[Math.min(seen.keys++, balances.length - 1)]! : replies[Math.min(seen.completions++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const clock = () => {
  let t = T0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};
const recorder = () => {
  const waits: number[] = [];
  const events: LimitEvent[] = [];
  const holds: HoldEvent[] = [];
  return { waits, events, holds, sleep: async (ms: number) => void waits.push(ms), log: (e: LimitEvent) => void events.push(e), logHold: (e: HoldEvent) => void holds.push(e) };
};
const userMsg = [{ role: "user" as const, content: "hi" }];

// ---- reset times ------------------------------------------------------------------------------------------------------------

test("openrouterReset: Retry-After, X-RateLimit-Reset header, then the body's upstream headers; invalid values give nothing", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.equal(openrouterReset(h({ "retry-after": "5" }), undefined, T0), iso(T0 + 5000));
  assert.equal(openrouterReset(h({ "retry-after": "Sun, 22 Nov 2026 06:00:00 GMT" }), undefined, T0), "2026-11-22T06:00:00.000Z");
  assert.equal(openrouterReset(h({ "x-ratelimit-reset": String(T0 + 30_000) }), undefined, T0), iso(T0 + 30_000), "epoch milliseconds");
  assert.equal(openrouterReset(h({ "x-ratelimit-reset": String((T0 + 60_000) / 1000) }), undefined, T0), iso(T0 + 60_000), "epoch seconds");
  assert.equal(openrouterReset(h({ "x-ratelimit-reset": "7" }), undefined, T0), iso(T0 + 7000), "seconds from now");
  const body = { error: { code: 429, metadata: { headers: { "X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(T0 + 90_000) } } } };
  assert.equal(openrouterReset(h({}), body, T0), iso(T0 + 90_000), "OpenRouter's metadata.headers");
  // Precedence: the first valid source wins; an invalid one is skipped.
  assert.equal(openrouterReset(h({ "retry-after": "3", "x-ratelimit-reset": String(T0 + 30_000) }), body, T0), iso(T0 + 3000));
  assert.equal(openrouterReset(h({ "retry-after": "soon", "x-ratelimit-reset": "-1" }), body, T0), iso(T0 + 90_000));
  for (const bad of ["0", "-5", "1.5", "tomorrow", String(T0 - 1000), String(T0 + 30 * 24 * 3600_000)]) {
    assert.equal(openrouterReset(h({ "retry-after": bad, "x-ratelimit-reset": bad }), undefined, T0), undefined, bad);
  }
  assert.equal(openrouterReset(undefined, "not an object", T0), undefined);
});

// ---- the client: one bounded retry ----------------------------------------------------------------------------------------

test("client: a 429 with no reset time is retried once after the default wait, and the answer comes back; the refusal is not charged", async () => {
  const c = clock();
  const r = recorder();
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(c.now()));
  const p = fake([limited(), ok("second try")]);
  const s = await openrouterClient(ready(), ledger, p.fetcher, { now: c.now, sleep: r.sleep, log: r.log }).step(userMsg, [], undefined, []);
  assert.equal(s.text, "second try");
  assert.equal(p.seen.completions, 2);
  assert.deepEqual(r.waits, [RETRY_DEFAULT_MS]);
  assert.deepEqual(r.events, [{ model: "vendor/cheap-model", status: 429, limit: "rate", resetsAt: null, attempt: 1, action: "retry", waitMs: RETRY_DEFAULT_MS }]);
  assert.equal(ledger.view().reservedUsd, 0);
  assert.ok(Math.abs(ledger.view().lifetimeUsd - 0.0001) < 1e-9, "only the answered call is charged");
});

test("client: Retry-After decides the wait; a second 429 is a typed rate-limit error naming the retry, logged, and both are released", async () => {
  const c = clock();
  const r = recorder();
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(c.now()));
  const p = fake([limited({ "retry-after": "3" }), limited({ "retry-after": "40" })]);
  await assert.rejects(openrouterClient(ready(), ledger, p.fetcher, { now: c.now, sleep: r.sleep, log: r.log }).step(userMsg, [], undefined, []), (e: unknown) => {
    assert.ok(e instanceof OpenRouterLimit && e instanceof ProviderError);
    assert.equal(e.kind, "rate_limit");
    assert.equal(e.code, RATE_LIMITED);
    assert.equal(e.retried, true);
    assert.equal(e.resetsAt, new Date(T0 + 40_000).toISOString());
    assert.match(e.message, /^OpenRouter: HTTP 429: Rate limit exceeded\. OpenRouter is rate limiting requests, also on ORBIT's one retry 3 s later; it gave 2026-11-22T05:30:40\.000Z as the reset time\.$/);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
  assert.equal(p.seen.completions, 2, "exactly one retry");
  assert.deepEqual(r.waits, [3000]);
  assert.deepEqual(r.events.map((e) => [e.attempt, e.action]), [[1, "retry"], [2, "gave_up"]]);
  assert.equal(ledger.view().reservedUsd, 0);
  assert.equal(ledger.view().lifetimeUsd, 0, "refusals are released, never charged");
});

test("client: a reset further away than ORBIT waits in a reply, a no-balance refusal, and a refusal the ledger could not release are not retried", async () => {
  const cases: [string, R, "rate" | "balance", boolean][] = [
    ["far reset", limited({ "retry-after": String(MAX_RETRY_WAIT_MS / 1000 + 50) }), "rate", true],
    ["HTTP 402", noCredits, "balance", true],
    ["429 that says no credits", limited({}, { error: { code: 429, message: "Key limit exceeded: insufficient credits on this key" } }), "balance", true],
    ["429 with an insufficient_quota code", limited({}, { error: { code: "insufficient_quota", message: "no" } }), "balance", true],
    ["429, release failed", limited(), "rate", false],
  ];
  for (const [name, reply, limit, sound] of cases) {
    const c = clock();
    const r = recorder();
    const base = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(c.now()));
    const ledger = sound ? base : { ...base, release: () => { throw new Error("disk full"); } };
    const p = fake([reply, ok()]);
    await assert.rejects(openrouterClient(ready(), ledger, p.fetcher, { now: c.now, sleep: r.sleep, log: r.log }).step(userMsg, [], undefined, []), (e: unknown) => {
      assert.ok(e instanceof OpenRouterLimit, name);
      assert.equal(e.limit, limit, name);
      assert.equal(e.code, limit === "rate" ? RATE_LIMITED : NO_BALANCE, name);
      assert.equal(e.kind, limit === "rate" ? "rate_limit" : "usage_limit", name);
      if (limit === "balance") assert.match(e.message, /does not have enough balance/, name);
      if (!sound) assert.match(e.message, /Spend accounting: the ledger could not record this call/, name);
      return true;
    });
    assert.equal(p.seen.completions, 1, `${name}: not retried`);
    assert.deepEqual(r.waits, [], name);
    assert.equal(r.events.length, 1, name);
    assert.equal(r.events[0]!.action, "no_retry", name);
    assert.ok(r.events[0]!.why, name);
  }
});

// ---- the fallback: hold, clear errors, status --------------------------------------------------------------------------

const usageLimit = () => new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", "2026-11-22T09:00:00.000Z");
function primary(): ModelPort & { calls: number } {
  const m = {
    calls: 0,
    status: () => ({ port: "model" as const, state: "live" as const, impl: "chatgpt-token-sharing/gpt-x", detail: "Answering.", verifiedAt: new Date(T0).toISOString() }),
    step: async (): Promise<Step> => {
      m.calls++;
      throw usageLimit();
    },
    reply: async () => {
      m.calls++;
      throw usageLimit();
    },
  };
  return m;
}
const world = (replies: R[], balances?: R[]) => {
  const c = clock();
  const r = recorder();
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(c.now()));
  const p = fake(replies, balances);
  const model = fallbackModel({ primary: primary(), config: ready(), ledger, fetcher: p.fetcher, now: c.now, sleep: r.sleep, log: r.log, logHold: r.logHold });
  return { ...c, ...r, p, model, ledger, ask: () => model.step!(userMsg, [], undefined, [], { fallback: true }) };
};

test("fallback: ChatGPT limited and OpenRouter rate limited after its retry: one clear error, a logged hold, nothing sent until the reset", async () => {
  const w = world([limited(), limited({ "retry-after": "45" }), ok("back")]);
  await assert.rejects(w.ask(), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    // The caller still sees ChatGPT's own limit (kind, reset), then what the fallback could not do.
    assert.equal(e.kind, "usage_limit");
    assert.equal(e.resetsAt, "2026-11-22T09:00:00.000Z");
    assert.match(e.message, /^ChatGPT usage limit reached for this plan\. The OpenRouter fallback did not answer: OpenRouter: HTTP 429/);
    assert.match(e.message, /also on ORBIT's one retry/);
    assert.match(e.message, /ORBIT sends nothing to OpenRouter until 2026-11-22T05:30:45\.000Z \(OpenRouter's reset time\)\. Neither model can answer now\.$/);
    return true;
  });
  assert.equal(w.p.seen.completions, 2);
  assert.deepEqual(w.holds, [{ event: "openrouter_fallback_hold", model: "vendor/cheap-model", kind: "rate", until: "2026-11-22T05:30:45.000Z", estimated: false, status: 429, why: "a rate limit again after ORBIT's one retry" }]);

  // Status: both unavailable, said plainly.
  const st = w.model.status();
  assert.equal(st.state, "down");
  assert.equal(st.availability?.available, false);
  assert.match(st.availability!.reason, /ChatGPT is limited and the OpenRouter fallback is paused because OpenRouter is rate limiting the fallback \(HTTP 429\), until 2026-11-22T05:30:45\.000Z: no reply can come from either model\./);
  assert.match(st.detail, /Paused: OpenRouter is rate limiting the fallback/);

  // Within the hold: refused at once, nothing sent, same explanation.
  w.advance(20_000);
  await assert.rejects(w.ask(), /The OpenRouter fallback did not answer: the fallback is unavailable too\. OpenRouter is rate limiting the fallback \(HTTP 429\), so ORBIT sends nothing to OpenRouter until 2026-11-22T05:30:45\.000Z/);
  assert.equal(w.p.seen.completions, 2, "no request during the hold");

  // After the reset the fallback is tried again and answers.
  w.advance(30_000);
  const s = await w.ask();
  assert.equal(s.text, "back");
  assert.equal(s.fallback?.provider, "openrouter");
  assert.equal(w.ledger.view().reservedUsd, 0);
});

test("fallback: a rate limit with no reset time is held for ORBIT's own estimate, said to be one", async () => {
  const w = world([limited(), limited(), ok()]);
  await assert.rejects(w.ask(), new RegExp(`until ${new Date(T0 + RATE_PAUSE_MS).toISOString().replace(/\./g, "\\.")} \\(ORBIT's own estimate: OpenRouter gave no reset time\\)`));
  assert.equal(w.holds[0]!.estimated, true);
  w.advance(RATE_PAUSE_MS + 1);
  assert.equal((await w.ask()).text, "from openrouter");
});

test("fallback: no balance holds until the next UTC day, is not retried, and ends early when a balance read shows a top-up", async () => {
  const w = world([noCredits, ok("topped up")], [keyBody(0), keyBody(0), keyBody(7.5)]);
  await assert.rejects(w.ask(), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /OpenRouter: HTTP 402: Insufficient credits/);
    assert.match(e.message, /OpenRouter says the fallback's account or key has no balance left \(HTTP 402\), so ORBIT sends nothing to OpenRouter until 2026-11-23T00:00:00\.000Z \(the next UTC day, when the daily cap resets: OpenRouter gave no reset time\) or until a balance check shows the key was topped up\. Neither model can answer now\./);
    return true;
  });
  assert.equal(w.p.seen.completions, 1);
  assert.deepEqual(w.waits, []);
  assert.equal(w.holds[0]!.kind, "balance");
  assert.match(w.model.status().availability!.reason, /no balance left/);

  // The first balance read after the hold began is its baseline (read at once, not ten minutes later); a read no higher keeps the hold.
  await w.model.maintain!();
  assert.equal(w.p.seen.keys, 1);
  w.advance(11 * 60_000);
  await w.model.maintain!();
  await assert.rejects(w.ask(), /the fallback is unavailable too/);
  assert.equal(w.p.seen.completions, 1);
  // A later read above the baseline is a top-up: the hold ends, logged, and the next reply goes to OpenRouter.
  w.advance(11 * 60_000);
  await w.model.maintain!();
  assert.equal(w.holds.at(-1)!.event, "openrouter_fallback_hold_ended");
  assert.equal((await w.ask()).text, "topped up");
});

test("fallback: a rate hold becomes a balance hold when a balance read shows the key has nothing left", async () => {
  const w = world([limited({ "retry-after": "120" }), limited({ "retry-after": "5" })], [keyBody(0)]);
  await assert.rejects(w.ask(), /OpenRouter is rate limiting the fallback/);
  assert.equal(w.p.seen.completions, 1, "a 2 min reset is not waited for in a reply");
  await w.model.maintain!();
  assert.equal(w.holds.at(-1)!.kind, "balance");
  assert.equal(w.holds.at(-1)!.until, "2026-11-23T00:00:00.000Z");
  w.advance(5 * 60_000);
  await assert.rejects(w.ask(), /no balance left/);
  assert.equal(w.p.seen.completions, 1);
});

test("fallback: a background caller still never reaches OpenRouter, so it can start no hold", async () => {
  const w = world([limited(), limited()]);
  await assert.rejects(w.model.step!(userMsg, [], undefined, [], { fallback: false }), (e: unknown) => e instanceof ProviderError && !/OpenRouter/.test(e.message));
  assert.equal(w.p.seen.completions, 0);
});

// ---- no message loss ------------------------------------------------------------------------------------------------------

test("thread: when ChatGPT and the fallback both refuse, Rai's message stays stored, the reply says why and that the message was kept", async () => {
  const c = clock();
  const r = recorder();
  const ledger = provisioned(dir(), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(c.now()));
  const p = fake([limited(), limited()]);
  const model = fallbackModel({ primary: primary(), config: ready(), ledger, fetcher: p.fetcher, now: c.now, sleep: r.sleep, log: r.log, logHold: r.logHold });
  const x = rig({ model });
  const t = await x.create();
  const res = await x.send(t.id, "please remember this");
  assert.equal(res.status, 502);
  assert.match(res.data.error, /^The model call failed: ChatGPT usage limit reached for this plan\. The OpenRouter fallback did not answer: OpenRouter: HTTP 429/);
  assert.ok(res.data.error.endsWith(` Neither model can answer now. ${MESSAGE_KEPT}`), res.data.error);
  const stored = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.equal(stored.messages[0].role, "user");
  assert.equal(stored.messages[0].text, "please remember this");
  assert.equal(stored.messages[1].status, "error");
  assert.ok(!JSON.stringify(stored).includes(KEY));
  x.close();
});
