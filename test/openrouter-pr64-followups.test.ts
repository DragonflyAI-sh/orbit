import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { openrouterClient, openrouterConfig, readBounded, ReadLimit } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { LEDGER_FILE, SpendError, toMicro } from "../src/spend-ledger.ts";
import type { SpendLedger } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";

// Follow-ups from the independent review of PR64 (job orbit-202611121719-ykan, five minor findings), each with a regression test.
// Fakes only: the provider is a fake fetch, the ledger a temporary directory, time a variable. Nothing here can spend anything.

// AbortSignal.timeout timers do not keep the event loop alive; a test that waits on one needs something that does.
const keepAlive = setInterval(() => {}, 100);
after(() => clearInterval(keepAlive));

const KEY = ["sk", "or", "v1", "abcdef0123456789abcdef0123456789"].join("-");
const MIN = 60_000;
const T0 = Date.parse("2026-11-12T10:00:00Z");
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  CREDENTIALS_DIRECTORY: "/creds",
  ORBIT_OPENROUTER_TIMEOUT_MS: "1000",
};
const ready = () => openrouterConfig(ENV, () => KEY) as Extract<OpenRouterConfig, { state: "ready" }>;
const caps = { dailyMicro: toMicro(5), totalMicro: toMicro(150) };
const dir = () => mkdtempSync(join(tmpdir(), "orbit-pr64-"));
const userMsg = [{ role: "user" as const, content: "hi" }];
const ok = (content = "paid") => ({ choices: [{ finish_reason: "stop", message: { content } }], usage: { cost: 0.0001 } });
const limited = () => new ProviderError("usage_limit", "ChatGPT usage limit reached.", new Date(T0 + 60 * MIN).toISOString());
const primary = (): ModelPort => ({
  status: () => ({ port: "model", state: "live", impl: "chatgpt-x", detail: "Answering.", verifiedAt: "" }),
  reply: async () => {
    throw limited();
  },
  step: async (): Promise<Step> => {
    throw limited();
  },
});
type Reply = { status?: number; json?: unknown; throws?: Error; hang?: boolean };
function provider(script: Reply[] | ((n: number) => Reply)) {
  const seen: unknown[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    const n = seen.length;
    seen.push(init.body ? JSON.parse(String(init.body)) : null);
    const r = typeof script === "function" ? script(n) : script[Math.min(n, script.length - 1)]!;
    if (r.throws) throw r.throws;
    if (r.hang) return new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
// A ledger whose settle/release can be made to fail, standing in for a full disk or a held lock error.
const flaky = (base: SpendLedger) => {
  const state = { failSettle: false, failRelease: false, failReserve: undefined as undefined | (() => never) };
  const ledger: SpendLedger = {
    ...base,
    reserve: (m) => (state.failReserve ? state.failReserve() : base.reserve(m)),
    settle: (id, micro, why) => {
      if (state.failSettle) throw new Error("EIO");
      base.settle(id, micro, why);
    },
    release: (id) => {
      if (state.failRelease) throw new Error("EIO");
      base.release(id);
    },
  };
  return { ledger, state };
};
const world = () => {
  const d = dir();
  const base = provisioned(d, caps, () => new Date(T0));
  const f = flaky(base);
  return { d, base, ...f };
};
const ask = (m: ModelPort) => m.step!(userMsg, [], undefined, [], { fallback: true });

// ---- findings 1 and 2: one consistent fail-closed fault state across success paths, error paths and admission ----------------------

test("findings 1+2: every way the outcome of a paid call goes unrecorded latches the fault; status, admission and a repaired disk all agree", async () => {
  const cases: [string, Reply, "success" | "error"][] = [
    ["billed answer", { json: ok() }, "success"],
    ["HTTP 500 (cost unknown)", { status: 500, json: { error: { message: "boom" } } }, "error"],
    ["HTTP 429 (a refusal that would be released)", { status: 429, json: { error: { message: "slow down" } } }, "error"],
    ["timeout after sending", { hang: true }, "error"],
    ["network error after sending", { throws: new Error(`connect failed to ${KEY}`) }, "error"],
  ];
  for (const [name, reply, kind] of cases) {
    const w = world();
    const p = provider([reply]);
    const model = fallbackModel({ primary: primary(), config: ready(), ledger: w.ledger, fetcher: p.fetcher, now: () => T0 });
    assert.match(model.status().detail, /fallback armed/, `${name}: starts armed`);
    w.state.failSettle = true;
    w.state.failRelease = true;
    if (kind === "success") assert.equal((await ask(model)).accounting?.length, 1, name);
    else await assert.rejects(ask(model), (e: unknown) => e instanceof ProviderError && (e.accounting?.length ?? 0) === 1, name);
    // Status now promises no paid call...
    assert.match(model.status().detail, /NOT armed, no paid call will be made: the ledger could not record/, name);
    // ...and admission agrees, even though the disk is fine again: nothing in this process clears the latch.
    w.state.failSettle = false;
    w.state.failRelease = false;
    const sent = p.seen.length;
    for (let i = 0; i < 3; i++) {
      model.status();
      await assert.rejects(ask(model), /latched as untrusted/, name);
    }
    assert.equal(p.seen.length, sent, `${name}: no paid request admitted while latched`);
    assert.match(model.status().detail, /NOT armed/);
    // Restart (a new process reads the ledger; the owner process of the unrecorded call is gone) is the recovery.
    assert.ok(Object.keys(JSON.parse(readFileSync(join(w.d, LEDGER_FILE), "utf8")).reservations).length >= 1, `${name}: the unrecorded call is still reserved, so it counts against the caps`);
  }
});

test("finding 1: a ledger that refused or failed at admission latches; a busy lock or a cap refusal does not", async () => {
  // Hard ledger failure on reserve (not a SpendError): becomes a ledger fault, no raw text.
  const w = world();
  const p = provider([{ json: ok() }]);
  const model = fallbackModel({ primary: primary(), config: ready(), ledger: w.ledger, fetcher: p.fetcher, now: () => T0 });
  w.state.failReserve = () => {
    throw new Error(`ENOSPC writing ${w.d}/x`);
  };
  await assert.rejects(ask(model), (e: unknown) => e instanceof ProviderError && !e.message.includes(w.d) && /could not record this call/.test(e.message));
  w.state.failReserve = undefined;
  assert.match(model.status().detail, /NOT armed/);
  await assert.rejects(ask(model), /latched as untrusted/);
  assert.equal(p.seen.length, 0, "nothing was ever sent");
  // Busy and caps: this one call is refused, nothing was reserved or charged, nothing is uncertain: no latch.
  for (const code of ["busy", "daily_cap"] as const) {
    const x = world();
    const q = provider([{ json: ok() }]);
    const m = fallbackModel({ primary: primary(), config: ready(), ledger: x.ledger, fetcher: q.fetcher, now: () => T0 });
    x.state.failReserve = () => {
      throw new SpendError(code, `refused: ${code}`);
    };
    await assert.rejects(ask(m), new RegExp(`refused: ${code}`));
    x.state.failReserve = undefined;
    assert.match(m.status().detail, /fallback armed/, `${code}: not latched`);
    assert.equal((await ask(m)).text, "paid", `${code}: the next call goes through`);
  }
});

test("finding 1: a corrupt ledger found at admission latches; repairing the file by hand does not clear it until ORBIT restarts", async () => {
  const d = dir();
  const base = provisioned(d, caps, () => new Date(T0));
  const good = readFileSync(join(d, LEDGER_FILE));
  const p = provider([{ json: ok() }]);
  const model = fallbackModel({ primary: primary(), config: ready(), ledger: base, fetcher: p.fetcher, now: () => T0 });
  writeFileSync(join(d, LEDGER_FILE), "{ broken");
  await assert.rejects(ask(model), /file is corrupt/);
  writeFileSync(join(d, LEDGER_FILE), good);
  assert.match(model.status().detail, /NOT armed/, "the file reads fine again, but the process that saw it fail stays closed");
  await assert.rejects(ask(model), /latched as untrusted/);
  assert.equal(p.seen.length, 0);
});

// ---- finding 4: a deadline that errors the body stream is reported as a timeout --------------------------------------------------

test("finding 4: a body stream that fails because the deadline passed is a timeout, not a generic read error; a failure with time left stays a read error", async () => {
  // The stream errors itself on abort, and registers first, so its rejection reaches the reader BEFORE readBounded's own abort handling.
  const erroring = (signal: AbortSignal) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
      },
      pull: () => new Promise(() => {}),
    });
  const signal = AbortSignal.timeout(50);
  const res = new Response(erroring(signal), { status: 200 });
  await assert.rejects(readBounded(res, 1000, signal), (e: unknown) => e instanceof ReadLimit && e.why === "time");
  // End to end through the client: the message says the deadline passed, and the request stays charged at its bound.
  const d = dir();
  const base = provisioned(d, caps, () => new Date(T0));
  const fetcher = (async (_u: string, init: RequestInit) => new Response(erroring(init.signal!), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(openrouterClient(ready(), base, fetcher).step(userMsg, [], undefined, []), /the response did not arrive within 1 s/);
  assert.equal(base.view().uncertainRequests, 1);
  // A stream that breaks on its own, with the deadline far away, is still a read error.
  const broken = new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("socket reset")) }), { status: 200 });
  await assert.rejects(readBounded(broken, 1000, AbortSignal.timeout(60_000)), (e: unknown) => e instanceof ReadLimit && e.why === "stream");
});

// ---- finding 5: balance failures before any header arrives are normalised ----------------------------------------------------------

test("finding 5: a balance fetch that fails before headers (network error, refused connection, deadline) is a fixed message with nothing from the error", async () => {
  const d = dir();
  const base = provisioned(d, caps, () => new Date(T0));
  const raw = Object.assign(new Error(`getaddrinfo ENOTFOUND openrouter.ai ${KEY} Bearer ${KEY} at ${d}/secret`), { code: "ENOTFOUND", cause: new Error("inner secret") });
  const net = openrouterClient(ready(), base, (async () => { throw raw; }) as unknown as typeof fetch);
  await assert.rejects(net.balance(), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /balance lookup failed before an answer arrived/);
    for (const leak of [KEY, "ENOTFOUND", "inner secret", d, "Bearer"]) assert.ok(!e.message.includes(leak), `leaked ${leak}`);
    return true;
  });
  const slow = openrouterClient(ready(), base, ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch);
  await assert.rejects(slow.balance(), /balance lookup did not answer within 1 s/);
  // Through the periodic maintenance the owner sees the same safe text, and it never touches the ledger or spends.
  const model = fallbackModel({ primary: primary(), config: ready(), ledger: base, fetcher: (async () => { throw raw; }) as unknown as typeof fetch, now: () => T0 });
  await model.maintain!();
  const detail = model.status().detail;
  assert.match(detail, /balance unavailable: .*failed before an answer arrived/);
  for (const leak of [KEY, "ENOTFOUND", d]) assert.ok(!detail.includes(leak), `status leaked ${leak}`);
});
