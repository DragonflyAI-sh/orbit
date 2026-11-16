import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMBED_ATTEMPTS_MAX, EMBED_BATCH_MAX, EMBEDDINGS_CREDENTIAL, EMBEDDINGS_URL, embeddingBudget, embeddingsConfig, embeddingsStatus, EmbeddingUnavailable, openaiEmbedder, parseEmbeddings, scrub } from "../src/embeddings.ts";
import type { EmbeddingsSettings } from "../src/embeddings.ts";

// The OpenAI embeddings adapter (src/embeddings.ts) against a MOCKED HTTP boundary. Nothing here contacts a provider: these tests show
// the request contract, validation, budgets and failure handling, never that a real key works or what a real model returns.

// A fake key built at runtime (no secret-shaped literal in the repository).
const KEY = ["test", "embeddings", "key", "x".repeat(24)].join("-");
const tmp = () => mkdtempSync(join(tmpdir(), "orbit-emb-"));
const settings = (over: Partial<EmbeddingsSettings> = {}): EmbeddingsSettings => ({ model: "text-embedding-3-small", dims: 4, sendDimensions: false, dailyRequests: 50, dailyTokens: 100_000, ...over });
const vec = (i: number, dims = 4) => Array.from({ length: dims }, (_, j) => (j === i % dims ? 1 : 0.1));
const okBody = (n: number, dims = 4, order?: number[]) => JSON.stringify({ object: "list", model: "text-embedding-3-small", data: (order ?? [...Array(n).keys()]).map((i) => ({ object: "embedding", index: i, embedding: vec(i, dims) })), usage: { prompt_tokens: n * 3, total_tokens: n * 3 } });
type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
function mockFetch(responses: (Response | Error | ((c: Call) => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init!, body: JSON.parse(String(init!.body)) as Record<string, unknown> };
    calls.push(c);
    const r = responses.shift();
    if (!r) throw new Error("unexpected extra request");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(c) : r;
  }) as typeof fetch;
  return { fetcher, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};
const make = (responses: Parameters<typeof mockFetch>[0], over: { settings?: Partial<EmbeddingsSettings>; budgetFile?: string; now?: () => Date; timeoutMs?: number } = {}) => {
  const m = mockFetch(responses);
  const s = settings(over.settings);
  const budget = embeddingBudget(over.budgetFile, s, over.now);
  const e = openaiEmbedder({ key: KEY, settings: s, budget, fetcher: m.fetcher, sleep: noSleep, now: over.now, timeoutMs: over.timeoutMs });
  return { e, budget, ...m };
};
const rejectsKind = async (p: Promise<unknown>, kind: string) => {
  await assert.rejects(p, (err: unknown) => err instanceof EmbeddingUnavailable && err.kind === kind && !String(err.message).includes(KEY));
};

test("config: off by default, misconfigured fails closed, separate credential, model and dimensions", () => {
  assert.equal(embeddingsConfig({}, () => KEY).state, "off");
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "off" }, () => KEY).state, "off");
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "yes" }, () => KEY).state, "misconfigured");
  const missing = embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on" }, () => undefined);
  assert.equal(missing.state, "misconfigured");
  assert.match((missing as { detail: string }).detail, new RegExp(EMBEDDINGS_CREDENTIAL));
  const ok = embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on" }, () => `${KEY}\n`);
  assert.equal(ok.state, "ready");
  if (ok.state !== "ready") return;
  assert.equal(ok.key, KEY);
  assert.deepEqual({ model: ok.settings.model, dims: ok.settings.dims, send: ok.settings.sendDimensions }, { model: "text-embedding-3-small", dims: 1536, send: false });
  const small = embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on", ORBIT_EMBEDDINGS_MODEL: "text-embedding-3-large", ORBIT_EMBEDDINGS_DIMENSIONS: "256" }, () => KEY);
  assert.ok(small.state === "ready" && small.settings.dims === 256 && small.settings.sendDimensions);
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on", ORBIT_EMBEDDINGS_MODEL: "text-embedding-ada-002", ORBIT_EMBEDDINGS_DIMENSIONS: "256" }, () => KEY).state, "misconfigured");
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on", ORBIT_EMBEDDINGS_MODEL: "some-other-model" }, () => KEY).state, "misconfigured");
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on", ORBIT_EMBEDDINGS_MODEL: "Bad Model!" }, () => KEY).state, "misconfigured");
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on", ORBIT_EMBEDDINGS_DAILY_REQUESTS: "0" }, () => KEY).state, "misconfigured");
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on" }, () => "two words").state, "misconfigured");
  // The production reader takes the dedicated credential file, never orbit.openai (the inference key).
  const dir = tmp();
  writeFileSync(join(dir, "orbit.openai"), KEY);
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on", CREDENTIALS_DIRECTORY: dir }).state, "misconfigured");
  writeFileSync(join(dir, EMBEDDINGS_CREDENTIAL), KEY);
  assert.equal(embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on", CREDENTIALS_DIRECTORY: dir }).state, "ready");
});

test("request contract: POST to the embeddings endpoint, bearer key, model, float encoding, no user field; vectors in input order", async () => {
  const { e, calls } = make([json(200, okBody(3, 4, [2, 0, 1]))]);
  const out = await e.embed(["a", "b", "c"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, EMBEDDINGS_URL);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0]!.body, { model: "text-embedding-3-small", input: ["a", "b", "c"], encoding_format: "float" });
  assert.deepEqual(out, [vec(0), vec(1), vec(2)], "re-ordered by index");
  const d = make([json(200, okBody(1).replace("text-embedding-3-small", "text-embedding-3-large"))], { settings: { model: "text-embedding-3-large", sendDimensions: true } });
  await d.e.embed(["x"]);
  assert.equal(d.calls[0]!.body.dimensions, 4);
});

test("malformed responses are refused and not retried: count, indices, size, non-finite, zero vector, model, not JSON, oversize", async () => {
  const cases: [string, Response][] = [
    ["count", json(200, okBody(1))],
    ["indices", json(200, JSON.stringify({ data: [{ index: 0, embedding: vec(0) }, { index: 0, embedding: vec(1) }] }))],
    ["size", json(200, JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: vec(1) }] }))],
    ["non-finite", json(200, `{"data":[{"index":0,"embedding":[1,2,3,"x"]},{"index":1,"embedding":[1,1,1,1]}]}`)],
    ["zero", json(200, JSON.stringify({ data: [{ index: 0, embedding: [0, 0, 0, 0] }, { index: 1, embedding: vec(1) }] }))],
    ["model", json(200, JSON.stringify({ model: "other-model", data: [{ index: 0, embedding: vec(0) }, { index: 1, embedding: vec(1) }] }))],
    ["json", json(200, "<html>")],
    ["oversize", new Response("x".repeat(200_000), { status: 200, headers: { "content-length": "200000" } })],
  ];
  for (const [name, res] of cases) {
    const { e, calls } = make([res]);
    await rejectsKind(e.embed(["a", "b"]), "malformed");
    assert.equal(calls.length, 1, `${name}: no retry`);
  }
  assert.throws(() => parseEmbeddings(JSON.stringify({ data: [{ index: 0, embedding: [1, Infinity, 0, 0] }] }), 1, 4, "m"));
});

test("auth (401/403), quota (429 insufficient_quota) and invalid request (400/404) are never retried and halt further calls", async () => {
  for (const [status, body, kind] of [
    [401, { error: { code: "invalid_api_key" } }, "auth"],
    [403, { error: { type: "permission" } }, "auth"],
    [429, { error: { code: "insufficient_quota", type: "insufficient_quota" } }, "quota"],
    [400, { error: { code: "invalid_value" } }, "config"],
    [404, { error: { code: "model_not_found" } }, "config"],
  ] as const) {
    const { e, calls } = make([json(status, body)]);
    await rejectsKind(e.embed(["a"]), kind);
    assert.equal(calls.length, 1, `${status} is not retried`);
    await rejectsKind(e.embed(["a"]), kind);
    assert.equal(calls.length, 1, `${status}: halted, no new request`);
    assert.equal(embeddingsStatus({ state: "ready", key: KEY, settings: settings() }, e, embeddingBudget(undefined, settings())).state, "degraded");
  }
});

test("transient failures retry with a bound: 429 rate limit (Retry-After), 5xx, network error, timeout", async () => {
  const waits: number[] = [];
  const m = mockFetch([json(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "2" }), json(503, "busy"), json(200, okBody(1))]);
  const budget = embeddingBudget(undefined, settings());
  const e = openaiEmbedder({ key: KEY, settings: settings(), budget, fetcher: m.fetcher, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(await e.embed(["a"]), [vec(0)]);
  assert.equal(m.calls.length, 3);
  assert.deepEqual(waits, [2000, 1000]);
  assert.equal(budget.used().requests, 3, "every attempt counts");
  // Gives up after EMBED_ATTEMPTS_MAX attempts.
  const net = make(Array.from({ length: EMBED_ATTEMPTS_MAX }, () => new TypeError("socket hang up")));
  await rejectsKind(net.e.embed(["a"]), "network");
  assert.equal(net.calls.length, EMBED_ATTEMPTS_MAX);
  // Timeout: a request that never answers is aborted by the adapter's own timer.
  const hang = (c: Call) => new Promise<Response>((_, reject) => c.init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  const slow = make([hang, hang, hang], { timeoutMs: 20 });
  await rejectsKind(slow.e.embed(["a"]), "timeout");
  assert.equal(slow.calls.length, EMBED_ATTEMPTS_MAX);
  // A caller's abort stops at once, without retry.
  const ctl = new AbortController();
  const cancelled = make([hang]);
  const p = cancelled.e.embed(["a"], ctl.signal);
  ctl.abort();
  await rejectsKind(p, "aborted");
  assert.equal(cancelled.calls.length, 1);
});

test("hard budgets: requests and input tokens reserved before sending, persisted, per UTC day; unreadable ledger fails closed", async () => {
  const dir = tmp();
  const file = join(dir, "budget.json");
  let now = new Date("2026-11-16T10:00:00Z");
  const { e, calls } = make([json(200, okBody(1)), json(200, okBody(1))], { settings: { dailyRequests: 2, dailyTokens: 1000 }, budgetFile: file, now: () => now });
  await e.embed(["abc"]);
  await e.embed(["abc"]);
  await rejectsKind(e.embed(["abc"]), "budget");
  assert.equal(calls.length, 2, "nothing sent over budget");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual({ day: saved.day, requests: saved.requests, tokens: saved.tokens }, { day: "2026-11-16", requests: 2, tokens: 6 }, "settled to usage.prompt_tokens");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // A restart keeps the count.
  const again = make([], { settings: { dailyRequests: 2, dailyTokens: 1000 }, budgetFile: file, now: () => now });
  await rejectsKind(again.e.embed(["abc"]), "budget");
  // A new UTC day resets it.
  now = new Date("2026-11-17T00:00:01Z");
  const next = make([json(200, okBody(1))], { settings: { dailyRequests: 2, dailyTokens: 1000 }, budgetFile: file, now: () => now });
  await next.e.embed(["abc"]);
  // Token budget: the UTF-8 byte count is reserved up front.
  const tok = make([], { settings: { dailyTokens: 10 } });
  await rejectsKind(tok.e.embed(["x".repeat(11)]), "budget");
  assert.equal(tok.calls.length, 0);
  // An unreadable ledger sends nothing.
  writeFileSync(file, "{broken");
  const broken = make([], { budgetFile: file });
  await rejectsKind(broken.e.embed(["a"]), "budget");
  assert.equal(broken.calls.length, 0);
});

test("inputs are bounded: batch size, empty and over-long texts are refused before any request", async () => {
  const { e, calls } = make([]);
  await rejectsKind(e.embed([]), "input");
  await rejectsKind(e.embed(Array.from({ length: EMBED_BATCH_MAX + 1 }, () => "a")), "input");
  await rejectsKind(e.embed(["  "]), "input");
  await rejectsKind(e.embed(["x".repeat(2001)]), "input");
  assert.equal(calls.length, 0);
});

test("concurrency is bounded to two requests in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return json(200, okBody(1));
  };
  const { e } = make([slow, slow, slow, slow, slow]);
  await Promise.all(Array.from({ length: 5 }, () => e.embed(["a"])));
  assert.equal(peak, 2);
});

test("errors and status never carry the key", async () => {
  assert.equal(scrub(`bad key ${KEY} and sk-${"a".repeat(20)} Bearer ${"b".repeat(20)}`, KEY).includes(KEY), false);
  assert.doesNotMatch(scrub(`sk-${"a".repeat(20)}`, ""), /sk-a/);
  const { e } = make([new TypeError(`connect failed ${KEY}`), new TypeError("x"), new TypeError("x")]);
  await rejectsKind(e.embed(["a"]), "network");
  const st = embeddingsStatus({ state: "ready", key: KEY, settings: settings() }, e, embeddingBudget(undefined, settings()));
  assert.equal(JSON.stringify(st).includes(KEY), false);
  assert.equal(embeddingsStatus({ state: "off", detail: "off" }, undefined, undefined).verifiedAt, new Date(0).toISOString());
});
