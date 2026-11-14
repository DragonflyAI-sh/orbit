import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatgptModel, httpProblem, MAX_RESET_MS, PAUSED, ProviderError, RATE_PAUSE_MS, streamProblem, tokenFile, USAGE_PAUSE_MS } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";

// Readiness audit D2: a temporary 429 rate limit must not be mistaken for an exhausted usage quota because its message says
// "limit", "usage" or "plan". Offline only: every provider is a fake fetch and time is a variable. No paid or live call is made.

const MIN = 60_000;
const START = new Date("2026-11-11T02:22:00Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const textStream = (text: string) => event({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } });
const failedStream = (error: Record<string, unknown>) => event({ type: "response.created" }) + event({ type: "response.failed", response: { error } });
const http429 = (error: Record<string, unknown>) => JSON.stringify({ error });

// Generic 429 messages: they name a limit, usage or a plan but carry no structured quota code.
const GENERIC = [
  "Rate limit reached for requests",
  "Too many requests. Please slow down; usage is high on your plan",
  "You are sending requests too quickly for your plan's limit",
  "Usage spike detected, try again shortly",
  "limit",
];

test("generic 429s that mention limit, usage or plan are rate limits, with the short default pause", () => {
  for (const message of GENERIC) {
    for (const text of [http429({ message }), JSON.stringify({ detail: message }), message]) {
      const e = httpProblem(429, text, START);
      assert.equal(e.kind, "rate_limit", text);
      assert.equal(e.resetsAt, undefined, text);
      assert.match(e.message, /^HTTP 429: ChatGPT is rate limiting requests/, text);
    }
  }
  // A 429 with an empty or unreadable body is a rate limit too.
  assert.equal(httpProblem(429, "", START).kind, "rate_limit");
  assert.equal(httpProblem(429, "<!DOCTYPE html><html></html>", START).kind, "rate_limit");
});

test("explicit structured quota signals are usage limits, over HTTP and in the stream, in code or type", () => {
  for (const tag of ["usage_limit_reached", "usage_not_included", "insufficient_quota", "quota_exceeded", "plan_limit"]) {
    for (const field of ["code", "type"]) {
      const body = { [field]: tag, message: "Slow down" };
      assert.equal(httpProblem(429, http429(body), START).kind, "usage_limit", `${field}=${tag} (HTTP)`);
      assert.equal(streamProblem(failedStream(body), START)?.kind, "usage_limit", `${field}=${tag} (stream)`);
    }
  }
});

test("structured codes take precedence over prose, and a quota tag wins over a rate-limit tag", () => {
  // Rate-limit code, prose that sounds like a quota: still a rate limit.
  const rate = httpProblem(429, http429({ code: "rate_limit_exceeded", message: "You have reached the usage limit of your plan" }), START);
  assert.equal(rate.kind, "rate_limit");
  assert.equal(streamProblem(event({ type: "error", error: { code: "rate_limit_exceeded", message: "usage limit for this plan" } }), START)?.kind, "rate_limit");
  // Quota code, prose that sounds like throttling: a usage limit.
  assert.equal(httpProblem(429, http429({ code: "insufficient_quota", message: "Rate limit, too many requests" }), START).kind, "usage_limit");
  // Both tags at once: the exhausted quota is the more specific, longer-lived condition.
  assert.equal(httpProblem(429, http429({ type: "rate_limit_error", code: "usage_limit_reached" }), START).kind, "usage_limit");
  // A rate-limit tag on a non-429 status is still a rate limit; prose on a non-429 status never makes a limit.
  assert.equal(httpProblem(400, http429({ code: "too_many_requests" }), START).kind, "rate_limit");
  assert.equal(httpProblem(400, http429({ message: "usage limit of your plan" }), START).kind, "failed");
});

test("valid provider timing is honored with explicit precedence: resets_at, then resets_in_seconds, then Retry-After", () => {
  const generic = http429({ message: "Rate limit reached" });
  // Retry-After as seconds and as an IMF-fixdate.
  assert.equal(httpProblem(429, generic, START, "90").resetsAt, iso(START + 90_000));
  assert.equal(httpProblem(429, generic, START, " 120 ").resetsAt, iso(START + 120_000));
  const date = new Date(START + 2 * 60 * MIN).toUTCString();
  assert.match(date, /^Wed, 11 Nov 2026 04:22:00 GMT$/);
  assert.equal(httpProblem(429, generic, START, date).resetsAt, iso(START + 2 * 60 * MIN));
  // Body timing beats the header; resets_at beats resets_in_seconds; conflicting values are never averaged or mixed.
  const at = Math.floor(START / 1000) + 600;
  assert.equal(httpProblem(429, http429({ message: "x", resets_in_seconds: 300 }), START, "30").resetsAt, iso(START + 300_000));
  assert.equal(httpProblem(429, http429({ message: "x", resets_at: at, resets_in_seconds: 30 }), START, "5").resetsAt, iso(at * 1000));
  // The same timing for a structured usage limit: the long default is not used when a valid time exists.
  assert.equal(httpProblem(429, http429({ code: "usage_limit_reached" }), START, "3600").resetsAt, iso(START + 3600_000));
});

test("missing, malformed, negative, past, zero or extreme timing falls through to the next source, then to ORBIT's own pause", () => {
  const generic = http429({ message: "Rate limit reached" });
  for (const header of [undefined, null, "", "0", "-5", "1.5", "soon", "1e3", "9999999999", "Wed, 11 Nov 2026 01:00:00 GMT", "2026-11-11T05:00:00Z", "Wednesday, 11-Nov-26 05:00:00 GMT", String(Math.ceil(MAX_RESET_MS / 1000) + 1)]) {
    const e = httpProblem(429, generic, START, header);
    assert.equal(e.kind, "rate_limit", String(header));
    assert.equal(e.resetsAt, undefined, String(header));
    assert.doesNotMatch(e.message, /resets at/, String(header));
  }
  // A malformed body value is skipped, not fatal: the next valid source applies.
  assert.equal(httpProblem(429, http429({ message: "x", resets_at: "not a date", resets_in_seconds: 120 }), START).resetsAt, iso(START + 120_000));
  assert.equal(httpProblem(429, http429({ message: "x", resets_at: -1, resets_in_seconds: -1 }), START, "45").resetsAt, iso(START + 45_000));
  assert.equal(httpProblem(429, http429({ message: "x", resets_at: Math.floor(START / 1000) - 60 }), START, "45").resetsAt, iso(START + 45_000), "a past body reset falls through to the header");
  assert.equal(httpProblem(429, http429({ message: "x", resets_in_seconds: 1e15 }), START, "bogus").resetsAt, undefined);
});

// A real chatgptModel over a fake inference server whose answers the test sets.
function rig() {
  let t = START;
  const file = tokenFile(undefined);
  const tokens: Tokens = {
    access: "access-0",
    refresh: "refresh-0",
    expires: START + 600 * MIN,
    idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`,
    clientId: "oaiapp_x",
    subject: "user-1",
    scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  };
  file.write(tokens);
  const next: { status: number; body: string; headers: Record<string, string> } = { status: 200, body: textStream("hi"), headers: {} };
  const log = { inference: 0 };
  const fetcher = (async (url: string) => {
    if (url.endsWith("/v1/responses")) {
      log.inference += 1;
      return new Response(next.body, { status: next.status, headers: next.headers });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const model = chatgptModel("gpt-x", file, { fetcher, now: () => t });
  return { model, next, log, advance: (ms: number) => void (t += ms), now: () => t };
}
const chat = (m: ModelPort) => m.reply([{ role: "user", content: "x" }], []);

test("a generic 429 pauses ChatGPT for 1 minute, not 15; the primary is eligible again exactly at the boundary", async () => {
  const r = rig();
  r.next.status = 429;
  r.next.body = http429({ message: "Rate limit reached for requests on your plan" });
  await assert.rejects(chat(r.model), (err: unknown) => err instanceof ProviderError && err.kind === "rate_limit");
  assert.equal(r.log.inference, 1);
  assert.match(r.model.status().detail, /rate limiting requests.*pauses model calls until .* \(in 1 min\)/);
  r.next.status = 200;
  r.next.body = textStream("back");
  r.advance(RATE_PAUSE_MS - 1);
  await assert.rejects(chat(r.model), (err: unknown) => err instanceof ProviderError && err.code === PAUSED && err.kind === "rate_limit");
  assert.equal(r.log.inference, 1, "no request is sent one millisecond before the boundary");
  r.advance(1);
  assert.equal((await chat(r.model)).value, "back");
  assert.equal(r.log.inference, 2, "exactly one request at the boundary, no extra retries");
  assert.equal(r.model.status().state, "live");
});

test("a generic 429 with Retry-After waits exactly that long; a structured usage limit with no timing keeps 15 minutes", async () => {
  const r = rig();
  r.next.status = 429;
  r.next.body = http429({ message: "Rate limit reached" });
  r.next.headers = { "retry-after": "300" };
  await assert.rejects(chat(r.model), (err: unknown) => err instanceof ProviderError && err.kind === "rate_limit" && err.resetsAt === iso(START + 5 * MIN));
  r.next.status = 200;
  r.next.body = textStream("ok");
  r.advance(5 * MIN - 1);
  await assert.rejects(chat(r.model), /No call was made/);
  r.advance(1);
  assert.equal((await chat(r.model)).value, "ok");
  assert.equal(r.log.inference, 2);

  const u = rig();
  u.next.status = 429;
  u.next.body = http429({ type: "usage_limit_reached", message: "The usage limit has been reached" });
  await assert.rejects(chat(u.model), (err: unknown) => err instanceof ProviderError && err.kind === "usage_limit" && err.resetsAt === undefined);
  u.next.status = 200;
  u.next.body = textStream("ok");
  u.advance(USAGE_PAUSE_MS - 1);
  await assert.rejects(chat(u.model), /No call was made/);
  u.advance(1);
  assert.equal((await chat(u.model)).value, "ok");
  assert.equal(u.log.inference, 2);
});

// ---- through the paid fallback ----------------------------------------------------------------------------------------

const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048",
  CREDENTIALS_DIRECTORY: "/creds",
};
const KEY = ["sk", "or", "v1", "0".repeat(32)].join("-");

// The real ChatGPT model (fake inference server) behind the real fallback (fake OpenRouter), sharing one fake clock.
function chain() {
  const r = rig();
  const config = openrouterConfig(ENV, () => KEY);
  assert.equal(config.state, "ready");
  const ledger = provisioned(mkdtempSync(join(tmpdir(), "orbit-d2-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(r.now()));
  const paid = { calls: 0 };
  const fetcher = (async () => {
    paid.calls += 1;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "from openrouter" } }], usage: { cost: 0.0001 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const model = fallbackModel({ primary: r.model, config: config as OpenRouterConfig, ledger, fetcher, now: r.now });
  const ask = (): Promise<Step> => model.step!([{ role: "user", content: "hi" }], [], undefined, [], { fallback: true });
  return { ...r, model, paid, ask };
}

test("fallback: a generic 429 is a rate limit, the paid fallback covers only its 1-minute pause, then ChatGPT is used again", async () => {
  const c = chain();
  c.next.status = 429;
  c.next.body = http429({ message: "Usage limit for your plan: too many requests" });
  const first = await c.ask();
  assert.equal(first.fallback?.reason, "rate_limit");
  assert.deepEqual(first.fallback?.primaryLimit, { until: iso(START + RATE_PAUSE_MS), estimated: true });
  assert.equal(c.paid.calls, 1);
  c.next.status = 200;
  c.next.body = textStream("chatgpt is back");
  c.advance(RATE_PAUSE_MS - 1);
  assert.ok((await c.ask()).fallback, "still paused one millisecond before the boundary");
  assert.equal(c.log.inference, 1, "ChatGPT is not called during the pause");
  c.advance(1);
  const back = await c.ask();
  assert.equal(back.text, "chatgpt is back");
  assert.equal(back.fallback, undefined);
  assert.equal(c.paid.calls, 2, "no paid call once the primary is eligible again");
  assert.equal(c.log.inference, 2);
  assert.ok(c.model.fallbackState().recoveredAt);
});

test("fallback: an explicit quota signal keeps the established usage-limit behavior (provider reset honored, else 15 minutes)", async () => {
  const c = chain();
  c.next.status = 429;
  c.next.body = http429({ code: "usage_limit_reached", message: "Rate limit", resets_in_seconds: 2 * 3600 });
  const s = await c.ask();
  assert.equal(s.fallback?.reason, "usage_limit");
  assert.deepEqual(s.fallback?.primaryLimit, { until: iso(START + 2 * 60 * MIN), estimated: false });

  const d = chain();
  d.next.status = 429;
  d.next.body = http429({ code: "usage_limit_reached" });
  const t = await d.ask();
  assert.deepEqual(t.fallback?.primaryLimit, { until: iso(START + USAGE_PAUSE_MS), estimated: true });
});

test("fallback: timeouts, cancellation, auth, 5xx, overload and other failures never reach the paid fallback", async () => {
  const cases: { status: number; body: string; headers?: Record<string, string>; kind: string }[] = [
    // (A 401 first renews the login; that path is covered by test/chatgpt-renewal.test.ts.)
    { status: 403, body: http429({ message: "plan limit" }), kind: "auth" },
    { status: 500, body: "internal error: usage limit plan", kind: "failed" },
    { status: 502, body: "<!DOCTYPE html><html></html>", headers: { "retry-after": "60" }, kind: "failed" },
    { status: 503, body: http429({ message: "limit" }), headers: { "retry-after": "60" }, kind: "overloaded" },
    { status: 400, body: http429({ code: "bad_request", message: "context length limit" }), kind: "failed" },
  ];
  for (const k of cases) {
    const c = chain();
    c.next.status = k.status;
    c.next.body = k.body;
    c.next.headers = k.headers ?? {};
    await assert.rejects(c.ask(), (err: unknown) => err instanceof ProviderError && err.kind === k.kind, `${k.status} ${k.body}`);
    assert.equal(c.paid.calls, 0, `${k.status}: no paid call`);
    assert.equal(c.model.fallbackState().limit, undefined, `${k.status}: no pause recorded`);
  }
  // Timeout and cancellation (the D1 kinds) from the primary are passed through untouched.
  for (const kind of ["timeout", "cancelled"] as const) {
    const err = new ProviderError(kind, kind);
    const primary: ModelPort = {
      status: () => ({ port: "model", state: "live", impl: "x", detail: "", verifiedAt: iso(START) }),
      step: async () => {
        throw err;
      },
      reply: async () => {
        throw err;
      },
    };
    const config = openrouterConfig(ENV, () => KEY);
    const ledger = provisioned(mkdtempSync(join(tmpdir(), "orbit-d2-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(START));
    let paid = 0;
    const fetcher = (async () => {
      paid += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const m = fallbackModel({ primary, config, ledger, fetcher, now: () => START });
    await assert.rejects(m.step!([{ role: "user", content: "hi" }], [], undefined, [], { fallback: true }), (e: unknown) => e === err);
    assert.equal(paid, 0, kind);
  }
});
