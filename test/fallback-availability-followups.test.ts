import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { withAvailability } from "../src/model-availability.ts";
import { openrouterConfig, reservationUsd } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import type { PortStatus } from "../src/ports.ts";
import { spendLedger, toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";

// Follow-ups to the review of PR #128 (findings 1 to 3): the real fallback wrapper and a real file-backed spend ledger, offline. The
// primary is a fake whose status follows ChatGPT's own rules (down after a failed call, degraded after a limit has passed with no call
// since, live after a success); OpenRouter is a fake fetch that can hold each request until the test settles it, so completion order
// is chosen by the test, not by timers. Nothing paid is reachable.

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
const SMALLEST = toMicro(reservationUsd(0, 0.2, 0.4, 2048));

// The page's own aggregation, loaded from the page as the page tests do.
type Overall = { level: "ok" | "degraded" | "down" | "unknown"; ok: boolean; label: string; detail: string };
const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ <status-dot>([\s\S]*?)\/\/ <\/status-dot>/)![1]!;
const { aggregateStatus } = new Function(`${block}; return { aggregateStatus };`)() as { aggregateStatus: (s: unknown, failure?: unknown) => Overall };
const live = (port: string): PortStatus => ({ port, state: "live", impl: "x", detail: `${port} detail`, verifiedAt: "t" });
const page = (model: PortStatus) =>
  aggregateStatus({ ports: JSON.parse(JSON.stringify([live("policy"), live("channel"), withAvailability(model), live("memory"), live("notify"), live("jobs")])) });

type Primary = "ok" | "limited" | "signed-out" | "mock";
type Pending = { resolve: (r: Response) => void; reject: (e: unknown) => void };
const answer = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fallback answer" } }], usage: { cost: 0.0001 } }));
const failure = () => new Response(JSON.stringify({ error: { message: "provider unavailable" } }), { status: 503 });

function world(opts: { lockWaitMs?: number } = {}) {
  const clock = { t: Date.parse("2026-11-18T06:00:00.000Z") };
  const p = { mode: "ok" as Primary, lastError: undefined as string | undefined, limitUntil: 0, ok: false, hold: false, held: [] as Array<() => void> };
  const at = () => new Date(clock.t).toISOString();
  const run = async (): Promise<Step> => {
    if (p.hold) await new Promise<void>((r) => p.held.push(r));
    if (p.mode === "limited") {
      p.limitUntil = clock.t + 30 * MIN;
      p.lastError = "usage limit";
      throw new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", new Date(p.limitUntil).toISOString());
    }
    if (p.mode === "signed-out") {
      p.lastError = "Not signed in to ChatGPT.";
      throw new ProviderError("auth", "Not signed in to ChatGPT. Sign in from the web page.");
    }
    p.lastError = undefined;
    p.ok = true;
    return { text: "primary answer", calls: [] };
  };
  // ChatGPT's status rules, in short (src/chatgpt.ts status()).
  const primaryStatus = (): PortStatus => {
    const s = (state: PortStatus["state"], detail: string): PortStatus => ({ port: "model", state, impl: "chatgpt/gpt-x", detail, verifiedAt: at() });
    if (p.mode === "mock") return s("mock", "Mock model.");
    if (p.mode === "signed-out" && p.lastError) return s("down", "Not signed in to ChatGPT. Sign in from the web page.");
    if (p.lastError && p.limitUntil > clock.t) return s("down", "ChatGPT usage limit.");
    if (p.lastError && p.limitUntil) return s("degraded", "The limit was due to reset. No model call since, so it is not confirmed that ChatGPT answers again.");
    if (p.lastError) return s("down", `Last call failed: ${p.lastError}`);
    return s("live", "Answering through your ChatGPT subscription.");
  };
  const primary: ModelPort = {
    status: primaryStatus,
    reply: async () => ({ value: (await run()).text, provenance: p.mode === "mock" ? "mock" : "live", source: "model/chatgpt/gpt-x" }),
    step: async () => run(),
  };

  // OpenRouter: answers at once ("ok"/"error"), or holds every request until the test settles it ("hold").
  const or = { mode: "ok" as "ok" | "error" | "hold", requests: 0, pending: [] as Pending[], bytes: [] as number[] };
  const fetcher = (async (_url: string, init: RequestInit) => {
    or.requests++;
    or.bytes.push(Buffer.byteLength(String(init.body)));
    if (or.mode === "error") return failure();
    if (or.mode === "hold") return new Promise<Response>((resolve, reject) => or.pending.push({ resolve, reject }));
    return answer();
  }) as unknown as typeof fetch;

  const dir = mkdtempSync(join(tmpdir(), "orbit-fallback-followups-"));
  const caps = { dailyMicro: toMicro(5), totalMicro: toMicro(150) };
  const ledger = provisioned(dir, caps, () => new Date(clock.t), opts.lockWaitMs ? { lockWaitMs: opts.lockWaitMs } : undefined);
  const model = fallbackModel({ primary, config: ready(), ledger, fetcher, now: () => clock.t });
  const ask = (text = "hi") => model.reply([{ role: "user", content: text }], []);
  const background = () => model.step!([{ role: "user", content: "compact" }], [], undefined, []);
  const leave = (micro: number) => {
    const left = toMicro(ledger.view().remainingTodayUsd);
    const r = ledger.reserve(left - micro);
    ledger.settle(r.id, left - micro);
    assert.equal(toMicro(ledger.view().remainingTodayUsd), micro);
  };
  // Another live process holding the ledger lock: a real lock record of this (live) process with a foreign token, written where the
  // ledger looks for it. The ledger never takes a live owner's lock, so every reserve waits `lockWaitMs` and is refused "busy".
  let lockRecord = "";
  const capture = spendLedger(dir, caps, () => new Date(clock.t), {
    fault: (point) => {
      if (point === "locked") lockRecord = readFileSync(join(dir, "openrouter-spend.lock"), "utf8");
    },
  });
  capture.view();
  const record = JSON.parse(lockRecord) as { tok: string };
  const lockFile = join(dir, "openrouter-spend.lock");
  const holdLock = () => writeFileSync(lockFile, JSON.stringify({ ...record, tok: randomUUID() }));
  const freeLock = () => rmSync(lockFile, { force: true });
  return { model, p, or, clock, ask, background, leave, holdLock, freeLock, ledger };
}
const view = (m: ModelPort) => withAvailability(m.status());
const tick = () => new Promise((r) => setImmediate(r));
// Waits until the fake OpenRouter holds `n` requests (the ledger reservation and the request are made after a few awaits).
async function holding(or: { pending: Pending[] }, n: number) {
  for (let i = 0; i < 200 && or.pending.length < n; i++) await tick();
  assert.equal(or.pending.length, n);
}

// ---- finding 1: after the limit time, a primary that is down is not reported available -------------------------------------------

test("limit passed, then a non-limit primary failure: down, available false and red, as the docs say; recovery returns to green", async () => {
  const w = world();
  w.p.mode = "limited";
  const r = await w.ask();
  assert.equal(r.fallback?.model, "vendor/cheap-model", "the fallback answered in the limit window");
  assert.equal(page(w.model.status()).level, "degraded");
  // The reset passes; ChatGPT is now signed out, and two calls fail with a non-limit error (never routed to the paid fallback).
  w.clock.t += 31 * MIN;
  w.p.mode = "signed-out";
  const before = w.or.requests;
  await assert.rejects(w.ask(), /Not signed in/);
  await assert.rejects(w.ask(), /Not signed in/);
  assert.equal(w.or.requests, before, "a non-limit failure does not spend the paid fallback");
  assert.equal(w.model.fallbackState().usingFallback, false, "the limit time has passed");
  const st = view(w.model);
  assert.equal(st.state, "down");
  assert.deepEqual([st.availability?.available, st.availability?.via], [false, "none"]);
  assert.equal(st.fallback?.answering, false);
  assert.match(st.detail, /has passed, so replies go to ChatGPT again, and ChatGPT is down: Not signed in/);
  assert.match(st.availability!.reason, /ChatGPT is down for another reason, which the OpenRouter fallback does not answer/);
  const pg = page(w.model.status());
  assert.deepEqual([pg.level, pg.ok, pg.label], ["down", false, "Down: model"]);
  // Signed in again: the first successful ChatGPT call is the recovery.
  w.p.mode = "ok";
  const ok = await w.ask();
  assert.equal(ok.fallback, undefined);
  assert.deepEqual([view(w.model).state, view(w.model).availability?.available, view(w.model).fallback], ["live", true, undefined]);
  assert.equal(page(w.model.status()).level, "ok");
});

test("limit passed: a primary that is only 'not confirmed' stays amber via the primary; a mock primary is never available", async () => {
  const w = world();
  w.p.mode = "limited";
  await w.ask();
  w.clock.t += 31 * MIN;
  w.p.mode = "ok";
  let st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.availability?.via], ["degraded", true, "primary"]);
  // The same window with a primary that reports a mock: its state is kept and it is not a real reply.
  w.p.mode = "mock";
  st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.availability?.via], ["mock", false, "none"]);
  assert.equal(page(w.model.status()).level, "down");
});

// ---- finding 2: admission refusals versus evidence that no model replies ----------------------------------------------------------

test("one busy ledger lock collision sends nothing and is not evidence: the working fallback stays amber; a second in a row is red", async () => {
  const w = world({ lockWaitMs: 20 });
  w.p.mode = "limited";
  await w.ask();
  assert.equal(view(w.model).fallback?.lastCall, "succeeded");
  const sent = w.or.requests;
  w.holdLock();
  await assert.rejects(w.ask(), /The OpenRouter fallback did not answer: The spend ledger is locked by another process/);
  assert.equal(w.or.requests, sent, "nothing was sent");
  let st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.answering, st.fallback?.lastCall], ["degraded", true, true, "succeeded"]);
  assert.match(st.detail, /Last fallback error: The spend ledger is locked by another process/, "the refusal is shown, not hidden");
  assert.equal(page(w.model.status()).level, "degraded");
  // Still locked on the next call: no longer a one-off collision; nothing is known to work.
  await assert.rejects(w.ask(), /locked by another process/);
  st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.lastCall], ["down", false, "failed"]);
  assert.equal(page(w.model.status()).level, "down");
  // The lock is released and a call succeeds: amber again.
  w.freeLock();
  await w.ask();
  assert.deepEqual([view(w.model).state, view(w.model).availability?.available], ["degraded", true]);
});

test("a busy refusal before any call succeeded fabricates nothing: the route stays not known (grey), never amber", async () => {
  const w = world({ lockWaitMs: 20 });
  w.p.mode = "limited";
  w.holdLock();
  await assert.rejects(w.ask(), /locked by another process/);
  const st = view(w.model);
  assert.deepEqual([st.availability?.available, st.fallback?.lastCall, st.fallback?.answering], [null, "none", false]);
  assert.equal(page(w.model.status()).level, "unknown");
  assert.equal(w.or.requests, 0);
});

test("a cap refusal of one request larger than one that succeeded, while that size still fits, is not evidence; smaller calls still answer", async () => {
  const w = world();
  w.p.mode = "limited";
  await w.ask("hi");
  // Room for the "hi" request again (with margin), not for a request with a 20 kB message.
  const small = toMicro(reservationUsd(w.or.bytes[0]!, 0.2, 0.4, 2048));
  w.leave(small + 200);
  const sent = w.or.requests;
  await assert.rejects(w.ask("x".repeat(20_000)), /The OpenRouter fallback did not answer: The OpenRouter daily cap/);
  assert.equal(w.or.requests, sent, "the caps refused it before anything was sent");
  const st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.answering, st.fallback?.lastCall], ["degraded", true, true, "succeeded"]);
  assert.match(st.detail, /Last fallback error: The OpenRouter daily cap/);
  assert.equal(page(w.model.status()).level, "degraded");
  // The claim holds: a request of the size that worked is admitted and answered.
  const r = await w.ask("hi");
  assert.equal(r.fallback?.model, "vendor/cheap-model");
  assert.equal(w.or.requests, sent + 1);
});

test("contrast: a cap refusal with too little left for the size that worked, a refusal with no success yet, and a provider failure are red", async () => {
  // Enough for the smallest possible body, not for the request size that already worked: nothing smaller is known to fit.
  const a = world();
  a.p.mode = "limited";
  await a.ask("hi");
  a.leave(SMALLEST + 50);
  await assert.rejects(a.ask("hi"), /daily cap/);
  assert.deepEqual([view(a.model).state, view(a.model).availability?.available, view(a.model).fallback?.lastCall], ["down", false, "failed"]);
  assert.equal(page(a.model.status()).level, "down");

  // Refused before any call in this window succeeded: no size is known to fit, so it is evidence (never a fabricated success).
  const b = world();
  b.p.mode = "limited";
  await assert.rejects(b.background(), /usage limit/);
  b.leave(SMALLEST + 50);
  await assert.rejects(b.ask("hi"), /daily cap/);
  assert.deepEqual([view(b.model).availability?.available, view(b.model).fallback?.lastCall], [false, "failed"]);

  // A used-up cap refuses every call whatever its size: red from the ledger itself.
  const c = world();
  c.p.mode = "limited";
  await c.ask("hi");
  c.leave(0);
  assert.deepEqual([view(c.model).state, view(c.model).availability?.available], ["down", false]);

  // A real provider failure on a request that was sent is evidence.
  const d = world();
  d.p.mode = "limited";
  await d.ask("hi");
  d.or.mode = "error";
  await assert.rejects(d.ask("hi"), /provider unavailable/);
  assert.deepEqual([view(d.model).state, view(d.model).availability?.available, view(d.model).fallback?.lastCall], ["down", false, "failed"]);
});

// ---- finding 3: evidence belongs to the window and start order of the call ---------------------------------------------------------

test("out of order in one window: an older call finishing after a newer one does not replace the newer one's outcome", async () => {
  // Older call fails late, after the newer one succeeded: still amber.
  const w = world();
  w.p.mode = "limited";
  w.or.mode = "hold";
  const older = w.ask("first");
  await holding(w.or, 1);
  const newer = w.ask("second");
  await holding(w.or, 2);
  w.or.pending[1]!.resolve(answer());
  await newer;
  assert.equal(view(w.model).availability?.available, true);
  w.or.pending[0]!.resolve(failure());
  await assert.rejects(older, /provider unavailable/);
  let st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.lastCall], ["degraded", true, "succeeded"]);
  assert.doesNotMatch(st.detail, /Last fallback error/, "the older call's error is not shown as the current state");

  // Older call succeeds late, after the newer one failed: still red.
  const v = world();
  v.p.mode = "limited";
  v.or.mode = "hold";
  const old2 = v.ask("first");
  await holding(v.or, 1);
  const new2 = v.ask("second");
  await holding(v.or, 2);
  v.or.pending[1]!.resolve(failure());
  await assert.rejects(new2, /provider unavailable/);
  v.or.pending[0]!.resolve(answer());
  await old2;
  st = view(v.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.lastCall], ["down", false, "failed"]);
});

test("a paid call that finishes after the primary recovered and a new limit window began writes nothing into the new window", async () => {
  for (const late of ["success", "failure"] as const) {
    const w = world();
    w.p.mode = "limited";
    w.or.mode = "hold";
    const stale = w.ask("slow fallback call");
    await holding(w.or, 1);
    // While it is in flight the reset passes and ChatGPT answers: recovered, green.
    w.clock.t += 31 * MIN;
    w.p.mode = "ok";
    await w.ask();
    assert.equal(view(w.model).state, "live", late);
    // The stale call finishing now does not touch the recovered state.
    if (late === "success") w.or.pending[0]!.resolve(answer());
    else w.or.pending[0]!.resolve(failure());
    if (late === "success") await stale;
    else await assert.rejects(stale);
    let st = view(w.model);
    assert.deepEqual([st.state, st.availability?.available, st.fallback], ["live", true, undefined], late);
    assert.equal(page(w.model.status()).level, "ok", late);
    // A new limit window, hit by a background caller: not known, whatever the stale call did.
    w.p.mode = "limited";
    await assert.rejects(w.background());
    st = view(w.model);
    assert.deepEqual([st.availability?.available, st.fallback?.lastCall], [null, "none"], late);
    assert.doesNotMatch(st.detail, /Last fallback error/, late);
  }
});

test("a paid call from an earlier limit window that finishes inside a later window is not that window's evidence", async () => {
  const w = world();
  w.p.mode = "limited";
  w.or.mode = "hold";
  const stale = w.ask("window one");
  await holding(w.or, 1);
  // Window one ends without a primary success; a new limit is reported after it (window two), by a background caller.
  w.clock.t += 31 * MIN;
  await assert.rejects(w.background(), /usage limit/);
  assert.deepEqual([view(w.model).availability?.available, view(w.model).fallback?.lastCall], [null, "none"]);
  // The window-one call answers now: window two still has no evidence.
  w.or.pending[0]!.resolve(answer());
  const r = await stale;
  assert.equal(r.fallback?.model, "vendor/cheap-model", "the caller still gets its reply");
  const st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.lastCall], ["degraded", null, "none"]);
  assert.equal(page(w.model.status()).level, "unknown");
});

test("a primary call that started before a limit was reported and answers after it does not end the new limit window", async () => {
  const w = world();
  // A primary call is in flight with no limit recorded.
  w.p.hold = true;
  const inflight = w.ask("long primary call");
  for (let i = 0; i < 50 && w.p.held.length < 1; i++) await tick();
  assert.equal(w.p.held.length, 1);
  // Another call hits the limit and the fallback answers it: window one, amber.
  w.p.hold = false;
  w.p.mode = "limited";
  await w.ask();
  assert.equal(view(w.model).availability?.via, "fallback");
  // The in-flight primary call answers now (it started before the limit).
  w.p.mode = "ok";
  w.p.held[0]!();
  const r = await inflight;
  assert.equal(r.fallback, undefined);
  const st = view(w.model);
  assert.equal(w.model.fallbackState().usingFallback, true, "the limit in force is kept");
  assert.equal(w.model.fallbackState().recoveredAt, undefined, "not reported recovered");
  assert.deepEqual([st.state, st.availability?.available, st.availability?.via, st.fallback?.lastCall], ["degraded", true, "fallback", "succeeded"]);
});
