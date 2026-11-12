import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort, Step, ToolDef } from "../src/model.ts";
import { MAX_REPLY_CHARS, MAX_RESPONSE_BYTES, openrouterClient, openrouterConfig } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { PROVISION_FILE, spendLedger, toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";
import type { SpendLedger } from "../src/spend-ledger.ts";
import { rig, say } from "./threads-fixture.ts";

// Regression tests for the response/status hardening (PR63 review cleanup, checklist B11, B12, B14).
// Nothing reaches OpenRouter or any paid service: the provider is a fake fetch, time is a variable, the ledger is a temp directory.
// Names and helpers repeat openrouter-fallback.test.ts on purpose: this file must also load against the previous src.

const FIRST = JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0, note: "test" });
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
const ready = () => {
  const c = openrouterConfig(ENV, () => KEY);
  assert.equal(c.state, "ready");
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};
const dir = () => mkdtempSync(join(tmpdir(), "orbit-harden-"));
const ledgerIn = (d: string, now: () => Date = () => new Date(T0)) => provisioned(d, { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, now);
// A process identity that is provably gone (the pid is above any kernel's pid_max): reservations it made are orphans.
const DEAD = { pid: 2_147_483_000, start: "1" };
const caps5 = { dailyMicro: toMicro(5), totalMicro: toMicro(150) };
const userMsg = [{ role: "user" as const, content: "hi" }];
const tool = (name: string): ToolDef => ({ name, description: name, parameters: { type: "object", properties: {} } });
const completion = (message: Record<string, unknown>, finish = "stop", cost: number | null = 0.0001) => ({ choices: [{ finish_reason: finish, message }], usage: cost === null ? {} : { cost } });

// ---- a fake provider that can stream, lie about its length and stall ------------------------------------------------------

type Spec = { status?: number; json?: unknown; text?: string; chunks?: number; chunkBytes?: number; headers?: Record<string, string>; stallAfter?: number };
function provider(spec: Spec | ((n: number) => Spec)) {
  const log = { requests: 0, pulled: 0, cancelled: 0 };
  const fetcher = (async () => {
    const n = log.requests++;
    const sp = typeof spec === "function" ? spec(n) : spec;
    const headers = sp.headers ?? {};
    if (sp.chunks !== undefined || sp.stallAfter !== undefined) {
      let sent = 0;
      const chunkBytes = sp.chunkBytes ?? 100_000;
      const keep = setTimeout(() => {}, 5_000);
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sp.stallAfter !== undefined && sent >= sp.stallAfter) return new Promise(() => {});
          if (sent >= (sp.chunks ?? Infinity)) return c.close();
          sent++;
          log.pulled++;
          c.enqueue(new Uint8Array(chunkBytes).fill(97));
        },
        cancel() {
          clearTimeout(keep);
          log.cancelled++;
        },
      });
      return new Response(body, { status: sp.status ?? 200, headers });
    }
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        log.pulled++;
        c.enqueue(new TextEncoder().encode(sp.text ?? JSON.stringify(sp.json)));
        c.close();
      },
      cancel() {
        log.cancelled++;
      },
    });
    return new Response(body, { status: sp.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fetcher, log };
}

// ============================================================================================================================
// B11: bounded provider response reads
// ============================================================================================================================

test("B11: an oversized streamed body with no Content-Length is cut off at the limit, cancelled, and charged at its bound", async () => {
  const d = dir();
  const ledger = ledgerIn(d);
  const p = provider({ chunks: 1000, chunkBytes: 100_000 }); // would be 100 MB
  const client = openrouterClient(ready(), ledger, p.fetcher);
  await assert.rejects(client.step(userMsg, [], undefined, []), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /too large and was discarded/);
    assert.ok(!e.message.includes("aaaa"), "no raw provider body in the error");
    return true;
  });
  assert.ok(p.log.pulled <= MAX_RESPONSE_BYTES / 100_000 + 2, `only about the limit was pulled, got ${p.log.pulled} chunks`);
  assert.equal(p.log.cancelled, 1, "the stream was cancelled");
  assert.equal(p.log.requests, 1, "no automatic paid retry");
  const v = ledger.view();
  assert.ok(v.lifetimeUsd > 0, "the request may have been billed: its upper bound stays charged");
  assert.equal(v.uncertainRequests, 1);
  assert.equal(v.reservedUsd, 0);
});

test("B11: a Content-Length that lies low does not let an oversized body through; a huge declared length is refused without reading", async () => {
  const lie = provider({ chunks: 50, chunkBytes: 100_000, headers: { "content-length": "10" } });
  await assert.rejects(openrouterClient(ready(), ledgerIn(dir()), lie.fetcher).step(userMsg, [], undefined, []), /too large and was discarded/);
  assert.equal(lie.log.cancelled, 1);
  const huge = provider({ text: "{}", headers: { "content-length": String(50 * MAX_RESPONSE_BYTES) } });
  await assert.rejects(openrouterClient(ready(), ledgerIn(dir()), huge.fetcher).step(userMsg, [], undefined, []), /too large and was discarded/);
  assert.ok(huge.log.pulled <= 1 && huge.log.cancelled === 1, "refused on the header alone: cancelled, nothing buffered (one pull is the stream priming itself)");
});

test("B11: normal text and tool-only responses stream in under the limit, with and without a length header", async () => {
  const text = JSON.stringify(completion({ content: "hello" }));
  const a = await openrouterClient(ready(), ledgerIn(dir()), provider({ text }).fetcher).step(userMsg, [], undefined, []);
  assert.equal(a.text, "hello");
  const withLen = await openrouterClient(ready(), ledgerIn(dir()), provider({ text, headers: { "content-length": String(Buffer.byteLength(text)) } }).fetcher).step(userMsg, [], undefined, []);
  assert.equal(withLen.text, "hello");
  const toolOnly = completion({ content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "jobs_list", arguments: '{"a":1}' } }] }, "tool_calls");
  const t = await openrouterClient(ready(), ledgerIn(dir()), provider({ json: toolOnly }).fetcher).step(userMsg, [], undefined, [tool("jobs_list")]);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.arguments, '{"a":1}');
});

test("B11: an oversized ERROR body is bounded, never echoed, and still classified by status (refusals released, server errors charged)", async () => {
  for (const [status, charged] of [[500, true], [429, false]] as const) {
    const ledger = ledgerIn(dir());
    const p = provider({ status, chunks: 1000, chunkBytes: 10_000 }); // 10 MB of error body
    await assert.rejects(openrouterClient(ready(), ledger, p.fetcher).step(userMsg, [], undefined, []), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.match(e.message, new RegExp(`HTTP ${status}`));
      assert.ok(!e.message.includes("aaaa") && !e.message.includes(KEY));
      return true;
    });
    assert.ok(p.log.pulled <= 10, `error body read stopped early, got ${p.log.pulled} chunks`);
    assert.equal(p.log.cancelled, 1);
    assert.equal(p.log.requests, 1);
    assert.equal(ledger.view().lifetimeUsd > 0, charged);
    assert.equal(ledger.view().reservedUsd, 0);
  }
});

test("B11: a body that stalls mid-stream is abandoned at the deadline, cancelled, charged at its bound and not retried", async () => {
  const ledger = ledgerIn(dir());
  const p = provider({ stallAfter: 1, chunkBytes: 10 });
  const started = Date.now();
  await assert.rejects(openrouterClient(ready(), ledger, p.fetcher).step(userMsg, [], undefined, []), (e: unknown) => e instanceof ProviderError && /did not arrive within 1 s/.test(e.message));
  assert.ok(Date.now() - started < 4000);
  assert.equal(p.log.cancelled, 1);
  assert.equal(p.log.requests, 1);
  assert.ok(ledger.view().lifetimeUsd > 0);
  assert.equal(ledger.view().reservedUsd, 0);
});

test("B11: the balance lookup is bounded too: oversized and stalled bodies are refused, a non-2xx body is not read", async () => {
  const mk = (sp: Spec) => {
    const p = provider(sp);
    return { p, client: openrouterClient(ready(), ledgerIn(dir()), p.fetcher) };
  };
  const big = mk({ chunks: 1000, chunkBytes: 10_000 });
  await assert.rejects(big.client.balance(), (e: unknown) => e instanceof ProviderError && /too large/.test(e.message));
  assert.ok(big.p.log.pulled <= 5 && big.p.log.cancelled === 1);
  const stalled = mk({ stallAfter: 0 });
  await assert.rejects(stalled.client.balance(), (e: unknown) => e instanceof ProviderError && /did not arrive/.test(e.message));
  const refused = mk({ status: 500, chunks: 1000, chunkBytes: 10_000 });
  await assert.rejects(refused.client.balance(), (e: unknown) => e instanceof ProviderError && /HTTP 500/.test(e.message));
  assert.ok(refused.p.log.pulled <= 1 && refused.p.log.cancelled === 1, "the error body is cancelled, not read");
  const ok = mk({ json: { data: { limit: 20, limit_remaining: 12.5, usage: 7.5 } } });
  assert.deepEqual(await ok.client.balance(), { limitUsd: 20, remainingUsd: 12.5, usedUsd: 7.5 });
  const nul = mk({ text: "null" });
  assert.deepEqual(await nul.client.balance(), { limitUsd: null, remainingUsd: null, usedUsd: null });
});

// ============================================================================================================================
// PR63 cleanup: structural accounting
// ============================================================================================================================

const SAME = "the ledger could not record this call; it stays reserved until ORBIT restarts, then is charged at its upper bound";
const tools: ChatTool[] = [{ name: "jobs_list", description: "j", parameters: {}, run: async () => ({ value: [], provenance: "live", source: "jobs" }) }];
const callJobs = { call_id: "c1", name: "jobs_list", arguments: "{}" };
// A model whose first round answers with a tool call plus diagnostics and whose second round throws `err`.
const failsLater = (err: Error, first: Partial<Step> = { accounting: [SAME] }): ModelPort => {
  let n = 0;
  return {
    status: () => ({ port: "model", state: "live", impl: "x", detail: "x", verifiedAt: new Date(T0).toISOString() }),
    reply: async () => ({ value: "", provenance: "live", source: "x" }),
    step: async () => {
      if (n++ === 0) return { text: "", calls: [callJobs], ...first };
      throw err;
    },
  };
};
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("accounting: the same diagnostic in an earlier and the failing round is named once, as merged structured data", async () => {
  const original = new ProviderError("usage_limit", "OpenRouter: HTTP 500: down", "2026-11-12T11:00:00.000Z", "code_x", [SAME]);
  const before = original.message;
  const model = failsLater(original);
  const err = await runChat({ model, messages: userMsg, limits: [], tools }).then(
    () => assert.fail("must reject"),
    (e: unknown) => e as ProviderError,
  );
  assert.ok(err instanceof ProviderError);
  assert.equal(count(err.message, "the ledger could not record this call"), 1, `one warning, got: ${err.message}`);
  assert.deepEqual(err.accounting, [SAME]);
  assert.equal(original.message, before, "the original error is not edited in place");
  assert.ok(!/earlier rounds/.test(err.message), "no second, concatenated warning");
});

test("accounting: a later-round ProviderError keeps kind, reset time, code and cause, and gains the earlier diagnostics as data", async () => {
  const original = new ProviderError("rate_limit", "OpenRouter: HTTP 429", "2026-11-12T11:00:00.000Z", "slow_down");
  const err = (await runChat({ model: failsLater(original), messages: userMsg, limits: [], tools }).catch((e: unknown) => e)) as ProviderError;
  assert.ok(err instanceof ProviderError);
  assert.equal(err.kind, "rate_limit");
  assert.equal(err.resetsAt, "2026-11-12T11:00:00.000Z");
  assert.equal(err.code, "slow_down");
  assert.equal(err.cause, original);
  assert.deepEqual(err.accounting, [SAME]);
  assert.match(err.message, /HTTP 429/);
  assert.equal(original.message, "OpenRouter: HTTP 429");
  assert.equal(original.accounting, undefined);
  // Different diagnostics in the two rounds are merged, each once.
  const other = new ProviderError("failed", "OpenRouter: x", undefined, undefined, ["B"]);
  const merged = (await runChat({ model: failsLater(other), messages: userMsg, limits: [], tools }).catch((e: unknown) => e)) as ProviderError;
  assert.deepEqual(merged.accounting, [SAME, "B"]);
  assert.equal(count(merged.message, "the ledger could not record this call"), 1);
  assert.equal(count(merged.message, "; B."), 1);
});

test("accounting: a plain (non-provider) later-round error is wrapped, not mutated, and keeps its name and cause", async () => {
  const original = new TypeError("response had no text");
  const err = (await runChat({ model: failsLater(original), messages: userMsg, limits: [], tools }).catch((e: unknown) => e)) as Error;
  assert.equal(original.message, "response had no text");
  assert.notEqual(err, original);
  assert.equal(err.name, "TypeError");
  assert.equal(err.cause, original);
  assert.match(err.message, /response had no text/);
  assert.match(err.message, /ledger could not record/);
  // No earlier diagnostics: the very same error comes back.
  const same = await runChat({ model: failsLater(original, {}), messages: userMsg, limits: [], tools }).catch((e: unknown) => e);
  assert.equal(same, original);
});

test("accounting: the fallback's SpendError branch passes its accounting explicitly (none) and never inherits the primary error's", async () => {
  let t = T0;
  const ledger = provisioned(dir(), { dailyMicro: toMicro(0.0001), totalMicro: toMicro(150) }, () => new Date(t));
  const limited = new ProviderError("usage_limit", "ChatGPT usage limit reached.", new Date(T0 + 60 * MIN).toISOString());
  // A primary error that (wrongly) carries a diagnostic of its own: the old code inherited it into the augmented error.
  Object.defineProperty(limited, "accounting", { value: ["inherited from the primary"] });
  const primary: ModelPort = { status: () => ({ port: "model", state: "live", impl: "x", detail: "x", verifiedAt: "" }), reply: async () => assert.fail(), step: async () => { throw limited; } };
  const model = fallbackModel({ primary, config: ready(), ledger, fetcher: provider({ json: completion({ content: "x" }) }).fetcher, now: () => t });
  const err = (await model.step!(userMsg, [], undefined, [], { fallback: true }).catch((e: unknown) => e)) as ProviderError;
  assert.ok(err instanceof ProviderError);
  assert.equal(err.kind, "usage_limit");
  assert.match(err.message, /daily cap/);
  assert.equal(err.accounting, undefined);
  assert.ok(!err.message.includes("inherited from the primary"));
});

test("accounting: a failed paid round with a ledger error names the diagnostic once on /chat and on the stored thread, and no model request carries it", async () => {
  const d = dir();
  const base = ledgerIn(d, () => new Date());
  const boom = () => {
    throw new Error(`EISDIR ${d}/openrouter-spend.json.new`);
  };
  const ledger: SpendLedger = { ...base, settle: boom, release: boom };
  const reset = new Date(Date.now() + 60 * MIN).toISOString();
  const seen: unknown[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(seen.length === 1 ? completion({ content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "jobs_list", arguments: "{}" } }] }, "tool_calls") : { error: { message: "down" } }), { status: seen.length === 1 ? 200 : 500 });
  }) as unknown as typeof fetch;
  const primary: ModelPort = { status: () => ({ port: "model", state: "live", impl: "x", detail: "x", verifiedAt: "" }), reply: async () => assert.fail(), step: async () => { throw new ProviderError("usage_limit", "ChatGPT usage limit reached.", reset); } };
  const model = fallbackModel({ primary, config: ready(), ledger, fetcher });
  const r = rig({ model });
  const t = await r.create("x");
  const res = await r.send(t.id, "what jobs?");
  const last = res.data.thread.messages.at(-1);
  assert.equal(last.status, "error");
  assert.equal(count(last.error, "the ledger could not record this call"), 1, last.error);
  // Round 1 was billed and could not be recorded: the ledger is latched, so round 2 was REFUSED (no second paid request).
  assert.match(last.error, /latched as untrusted/);
  assert.equal(seen.length, 1, "the latched ledger admitted no further paid call");
  assert.ok(!last.error.includes(d));
  const chat = await r.api("/chat", "POST", { messages: [{ role: "user", content: "what jobs?" }] });
  assert.equal(chat.status, 502);
  assert.match(chat.data.error, /latched as untrusted/);
  assert.equal(seen.length, 1, "still no paid call admitted");
  // The next turn is built from stored thread text only: the failed message and its diagnostics never reach a model.
  const mark = seen.length;
  await r.send(t.id, "and again?");
  for (const q of seen.slice(mark)) assert.ok(!/spend accounting|ledger could not/i.test(JSON.stringify((q as { messages: unknown }).messages)));
  r.close();
});

// ============================================================================================================================
// B12: read-only, truthful status
// ============================================================================================================================

const primaryOf = (script: () => Step | Error): ModelPort => ({
  status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-x", detail: "Answering.", verifiedAt: new Date(T0).toISOString() }),
  reply: async () => {
    const s = script();
    if (s instanceof Error) throw s;
    return { value: s.text, provenance: "live", source: "model/x" };
  },
  step: async () => {
    const s = script();
    if (s instanceof Error) throw s;
    return s;
  },
});
const statusWorld = (spec: Spec | ((n: number) => Spec) = { json: completion({ content: "paid" }) }, script: () => Step | Error = () => say("fine")) => {
  let t = T0;
  const d = dir();
  // Unprovisioned until a test calls init(): that is what the owner's provision request plus the startup step does.
  const ledger = spendLedger(d, caps5, () => new Date(t));
  const p = provider(spec);
  const model = fallbackModel({ primary: primaryOf(script), config: ready(), ledger, fetcher: p.fetcher, now: () => t });
  const init = () => {
    writeFileSync(join(d, PROVISION_FILE), FIRST);
    ledger.open();
  };
  return { model, ledger, d, p, init, file: join(d, "openrouter-spend.json"), advance: (ms: number) => void (t += ms) };
};

test("B12: polling status never creates, adopts into, or rewrites the ledger and sends no provider request (fresh install)", () => {
  const w = statusWorld();
  for (let i = 0; i < 25; i++) w.model.status();
  assert.deepEqual(readdirSync(w.d), [], "no ledger file was created by status");
  assert.equal(w.p.log.requests, 0);
  const detail = w.model.status().detail;
  assert.doesNotMatch(detail, /armed:/, "an unprovisioned ledger is not 'armed'");
  assert.match(detail, /NOT armed, no paid call will be made: the spend ledger has not been provisioned/);
  // A waiting provision request is reported, but a poll never applies it.
  writeFileSync(join(w.d, PROVISION_FILE), FIRST);
  for (let i = 0; i < 5; i++) assert.match(w.model.status().detail, /a provision request is waiting and is applied when ORBIT next starts/);
  assert.deepEqual(readdirSync(w.d), [PROVISION_FILE], "status neither created a ledger nor consumed the request");
  assert.equal(w.p.log.requests, 0);
  // Applied by the explicit startup step: now it is created, and a status that has the balance unread says so.
  w.ledger.open();
  assert.match(w.model.status().detail, /OpenRouter fallback armed/);
  assert.match(w.model.status().detail, /have not been verified with OpenRouter/);
  assert.match(w.model.status().detail, /balance has not been read yet/);
});

test("B12: polling status leaves an existing ledger byte for byte unchanged, orphaned reservations included", () => {
  const d = dir();
  const file = join(d, "openrouter-spend.json");
  const seed = { schema: 1, createdAt: "2026-11-01T00:00:00.000Z", lifetimeMicro: 1_500_000, days: { "2026-11-12": 500_000 }, reservations: { "r-1": { at: "2026-11-12T09:00:00.000Z", day: "2026-11-12", micro: 2_000 } }, uncertain: [] };
  writeFileSync(file, JSON.stringify(seed));
  const before = readFileSync(file);
  const mtime = statSync(file).mtimeMs;
  const ledger = spendLedger(d, caps5, () => new Date(T0));
  const model = fallbackModel({ primary: primaryOf(() => say("x")), config: ready(), ledger, fetcher: provider({ json: {} }).fetcher, now: () => T0 });
  for (let i = 0; i < 10; i++) model.status();
  assert.ok(readFileSync(file).equals(before), "bytes unchanged: the orphaned reservation was NOT adopted by polling");
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.equal(readdirSync(d).length, 1, "no temp file left behind");
  assert.match(model.status().detail, /OpenRouter fallback armed: vendor\/cheap-model/);
  assert.match(model.status().detail, /\$1\.5000 of \$150 lifetime/);
  assert.match(model.status().detail, /not a hard spending ceiling/);
  // An explicit authorized path (a ledger operation, as a paid call makes) is what adopts it.
  assert.equal(ledger.view().uncertainRequests, 1);
  assert.ok(!readFileSync(file).equals(before));
});

test("B12: ledger failure transitions: armed -> corrupt -> restored, and armed -> deleted, are each reported truthfully without writes", async () => {
  const w = statusWorld({ json: completion({ content: "paid" }) }, () => new ProviderError("usage_limit", "ChatGPT usage limit reached.", new Date(T0 + 60 * MIN).toISOString()));
  w.init();
  const good = readFileSync(w.file);
  // The primary's limit is in force, so status shows the limited path.
  await w.model.step!(userMsg, [], undefined, [], { fallback: false }).catch(() => {});
  assert.match(w.model.status().detail, /fallback armed/);
  assert.equal(w.model.status().state, "degraded", "limited with a working fallback");
  writeFileSync(w.file, "{ not json");
  const broken = w.model.status();
  assert.doesNotMatch(broken.detail, /fallback armed/);
  assert.match(broken.detail, /NOT armed, no paid call will be made: the spend ledger file is corrupt/);
  assert.equal(broken.state, "down", "limited and the paid fallback cannot answer: replies fail");
  assert.match(broken.detail, /No fallback is available/);
  assert.ok(!broken.detail.includes(w.d), "no path in the status");
  assert.equal(readFileSync(w.file, "utf8"), "{ not json", "status did not repair or reset it");
  writeFileSync(w.file, good);
  assert.match(w.model.status().detail, /fallback armed/);
  rmSync(w.file);
  const gone = w.model.status();
  assert.match(gone.detail, /NOT armed.*(missing although a history marker shows one existed|both disappeared since this process last read it)/);
  assert.equal(gone.state, "down");
  assert.ok(!existsSync(w.file), "status did not recreate a deleted ledger");
  assert.equal(w.p.log.requests, 0);
  // Schema-invalid is also a failure.
  writeFileSync(w.file, JSON.stringify({ schema: 3 }));
  assert.match(w.model.status().detail, /NOT armed.*unknown schema/);
});

test("B12: a billed call whose ledger write failed latches the ledger: status says NOT armed and no later paid call is admitted until a restart", async () => {
  const d = dir();
  // The process that makes the call is "gone" by the time the replacement starts, as after a real restart.
  const base = provisioned(d, caps5, () => new Date(T0), { identity: DEAD });
  let failing = true;
  const ledger: SpendLedger = {
    ...base,
    settle: (id, micro, why) => {
      if (failing) throw new Error("EIO");
      base.settle(id, micro, why);
    },
  };
  const p = provider({ json: completion({ content: "paid" }) });
  const limited = () => new ProviderError("usage_limit", "ChatGPT usage limit reached.", new Date(T0 + 60 * MIN).toISOString());
  const model = fallbackModel({ primary: primaryOf(limited), config: ready(), ledger, fetcher: p.fetcher, now: () => T0 });
  assert.match(model.status().detail, /fallback armed/);
  const s = await model.step!(userMsg, [], undefined, [], { fallback: true });
  assert.equal(s.text, "paid", "the billed answer is still returned");
  assert.equal(s.accounting?.length, 1);
  assert.doesNotMatch(model.status().detail, /fallback armed/);
  assert.match(model.status().detail, /NOT armed, no paid call will be made: the ledger could not record a paid call/);
  // The cause went away, but nothing clears the latch: not polling status, not a later call (which is refused, not sent).
  failing = false;
  for (let i = 0; i < 5; i++) assert.match(model.status().detail, /NOT armed/);
  const requests = p.log.requests;
  await assert.rejects(model.step!(userMsg, [], undefined, [], { fallback: true }), /latched as untrusted/);
  assert.equal(p.log.requests, requests, "no paid request was admitted while latched");
  assert.match(model.status().detail, /NOT armed/);
  // Restart: a new instance reads the ledger; the call that was never recorded is charged at its upper bound, not dropped.
  const after = spendLedger(d, caps5, () => new Date(T0));
  const restarted = fallbackModel({ primary: primaryOf(limited), config: ready(), ledger: after, fetcher: p.fetcher, now: () => T0 });
  const v = after.open();
  assert.equal(v.uncertainRequests, 1);
  assert.ok(v.lifetimeUsd > 0, "the unrecorded call is charged at its bound");
  assert.match(restarted.status().detail, /fallback armed/);
});

test("B12: balance shown by status carries its read time and is flagged STALE once it is old; status itself never fetches it", async () => {
  const w = statusWorld((n) => (n === 0 ? { json: { data: { limit: 20, limit_remaining: 12.5, usage: 7.5 } } } : { json: completion({ content: "x" }) }));
  w.init();
  await w.model.maintain!();
  assert.equal(w.p.log.requests, 1);
  assert.match(w.model.status().detail, /read 2026-11-12T10:00:00\.000Z/);
  assert.doesNotMatch(w.model.status().detail, /STALE/);
  w.advance(25 * MIN);
  for (let i = 0; i < 5; i++) w.model.status();
  assert.match(w.model.status().detail, /STALE \(last read 2026-11-12T10:00:00\.000Z\)/);
  assert.equal(w.p.log.requests, 1, "status polling made no balance request");
});

test("B12: repeated status() with the ChatGPT limit in force and an armed fallback issues zero provider requests and zero ledger writes", async () => {
  const w = statusWorld({ json: completion({ content: "x" }) }, () => new ProviderError("usage_limit", "ChatGPT usage limit reached.", new Date(T0 + 60 * MIN).toISOString()));
  await w.model.step!(userMsg, [], undefined, [], { fallback: false }).catch(() => {});
  w.init();
  const before = readFileSync(w.file);
  for (let i = 0; i < 20; i++) {
    w.model.status();
    w.model.fallbackState();
  }
  assert.equal(w.p.log.requests, 0);
  assert.ok(readFileSync(w.file).equals(before));
  assert.match(w.model.status().detail, /Replies come from OpenRouter vendor\/cheap-model/);
});

// ============================================================================================================================
// B14: truncated and partly dropped replies
// ============================================================================================================================

const stepWith = async (message: Record<string, unknown>, finish: string | undefined, ledger = ledgerIn(dir())) => {
  const body = { choices: [{ ...(finish === undefined ? {} : { finish_reason: finish }), message }], usage: { cost: 0.0001 } };
  return openrouterClient(ready(), ledger, provider({ json: body }).fetcher).step(userMsg, [], undefined, [tool("jobs_list")]);
};
const toolCall = (args: string, extra: Record<string, unknown> = {}) => ({ id: "t1", type: "function", function: { name: "jobs_list", arguments: args }, ...extra });

test("B14: a text reply that hit the output limit is marked incomplete in a separate field; the text is untouched", async () => {
  const s = await stepWith({ content: "The answer begins and then" }, "length");
  assert.equal(s.text, "The answer begins and then");
  assert.equal(s.incomplete?.length, 1);
  assert.match(s.incomplete![0]!, /cut off at the output limit/);
  assert.equal(s.accounting, undefined, "not a billing warning");
});

test("B14: complete replies are never marked: stop and tool_calls", async () => {
  assert.equal((await stepWith({ content: "done" }, "stop")).incomplete, undefined);
  const t = await stepWith({ content: null, tool_calls: [toolCall('{"a":1}')] }, "tool_calls");
  assert.equal(t.incomplete, undefined);
  assert.equal(t.calls[0]!.arguments, '{"a":1}', "tool argument JSON is byte for byte what the model sent");
});

test("PR64 finding 3: a missing, null or non-string finish reason is not a clean stop: text is marked, tool calls are never returned for running", async () => {
  const bodyOf = (choice: Record<string, unknown>) => ({ choices: [choice], usage: { cost: 0.0001 } });
  const run = (choice: Record<string, unknown>, ledger = ledgerIn(dir())) => openrouterClient(ready(), ledger, provider({ json: bodyOf(choice) }).fetcher).step(userMsg, [], undefined, [tool("jobs_list")]);
  const calls = { content: null, tool_calls: [toolCall('{"a": "trunc')] };
  for (const finish of [{}, { finish_reason: null }, { finish_reason: 7 }, { finish_reason: "" }]) {
    const text = await run({ ...finish, message: { content: "maybe whole" } });
    assert.equal(text.text, "maybe whole");
    assert.match(text.incomplete![0]!, /no finish reason|unrecognised finish reason/, JSON.stringify(finish));
  }
  const d = dir();
  const base = ledgerIn(d);
  const ledger: SpendLedger = { ...base, settle: () => { throw new Error("EIO"); } };
  for (const finish of [{}, { finish_reason: null }, { finish_reason: "mystery" }]) {
    await assert.rejects(run({ ...finish, message: calls }, ledger), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.match(e.message, /carried a tool call but (no finish reason|an unrecognised finish reason).*no tool was run/, JSON.stringify(finish));
      assert.equal(e.accounting?.length, 1, "the billing diagnostic is still reported with it");
      return true;
    });
  }
  // The same through the chat loop: nothing runs, whatever the arguments look like.
  let ran = 0;
  const counting: ChatTool[] = [{ name: "jobs_list", description: "j", parameters: {}, run: async () => (ran++, { value: [], provenance: "live", source: "jobs" }) }];
  const client = openrouterClient(ready(), ledgerIn(dir()), provider({ json: bodyOf({ message: { content: null, tool_calls: [toolCall("{}")] } }) }).fetcher);
  const model: ModelPort = { status: () => ({ port: "model", state: "live", impl: "x", detail: "", verifiedAt: "" }), reply: async () => assert.fail(), step: (i, l, n, t) => client.step(i, l, n, t) };
  await assert.rejects(runChat({ model, messages: [{ role: "user", content: "hi" }], limits: [], tools: counting }), /no finish reason/);
  assert.equal(ran, 0);
  // A well-formed finish reason still runs the call (guard).
  const ok = await run({ finish_reason: "tool_calls", message: { content: null, tool_calls: [toolCall("{}")] } });
  assert.equal(ok.calls.length, 1);
});

test("B14: other finish reasons: content_filter and error are early ends, an unknown one is reported as unrecognised, never as a clean stop", async () => {
  assert.match((await stepWith({ content: "partial" }, "content_filter")).incomplete![0]!, /ended the reply early \(finish: content_filter\)/);
  assert.match((await stepWith({ content: "partial" }, "error")).incomplete![0]!, /ended the reply early \(finish: error\)/);
  const odd = await stepWith({ content: "partial" }, `weird ${KEY}`);
  assert.match(odd.incomplete![0]!, /unrecognised finish reason/);
  assert.ok(!JSON.stringify(odd).includes(KEY));
});

test("B14: an incomplete tool call is never returned for running, whatever its finish reason, and still reports billing independently", async () => {
  const d = dir();
  const base = ledgerIn(d);
  const ledger: SpendLedger = { ...base, settle: () => { throw new Error("EIO"); } };
  for (const finish of ["length", "content_filter", "error"]) {
    await assert.rejects(stepWith({ content: "", tool_calls: [toolCall('{"a": "trunc')] }, finish, ledger), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.match(e.message, /in the middle of a tool call, so no tool was run/);
      assert.equal(e.accounting?.length, 1, "the billing diagnostic is still reported");
      return true;
    });
  }
  // The same through runChat: the tool never runs.
  let ran = 0;
  const counting: ChatTool[] = [{ name: "jobs_list", description: "j", parameters: {}, run: async () => (ran++, { value: [], provenance: "live", source: "jobs" }) }];
  const client = openrouterClient(ready(), ledgerIn(dir()), provider({ json: completion({ content: null, tool_calls: [toolCall('{"a": "trunc')] }, "length") }).fetcher);
  const model: ModelPort = { status: () => ({ port: "model", state: "live", impl: "x", detail: "x", verifiedAt: "" }), reply: async () => assert.fail(), step: (i, l, n, t) => client.step(i, l, n, t) };
  await assert.rejects(runChat({ model, messages: userMsg, limits: [], tools: counting }), /no tool was run/);
  assert.equal(ran, 0);
});

test("B14: tool calls without an id or name are reported as dropped, not silently ignored; the rest are kept", async () => {
  const s = await stepWith({ content: "text", tool_calls: [toolCall("{}"), { type: "function", function: { name: "jobs_list", arguments: "{}" } }, { id: "t3", type: "function", function: { arguments: "{}" } }] }, "tool_calls");
  assert.equal(s.calls.length, 1);
  assert.match(s.incomplete![0]!, /2 tool call\(s\) from the model had no id or name and were dropped/);
});

test("B14: a reply shortened by ORBIT's own character limit is reported", async () => {
  const s = await stepWith({ content: "x".repeat(MAX_REPLY_CHARS + 50) }, "stop");
  assert.equal(s.text.length, MAX_REPLY_CHARS);
  assert.match(s.incomplete![0]!, new RegExp(`shortened the reply to ${MAX_REPLY_CHARS} characters`));
});

test("B14: runChat, /chat and the stored thread carry the note beside the reply and apart from billing warnings; no later model request sees it", async () => {
  const d = dir();
  const base = ledgerIn(d, () => new Date());
  const ledger: SpendLedger = { ...base, settle: () => { throw new Error("EIO"); } };
  const reqs: any[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    reqs.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(completion({ content: "Half an answ" }, "length")), { status: 200 });
  }) as unknown as typeof fetch;
  const limited = () => new ProviderError("usage_limit", "ChatGPT usage limit reached.", new Date(Date.now() + 60 * MIN).toISOString());
  const model = fallbackModel({ primary: primaryOf(limited), config: ready(), ledger, fetcher });
  const out = await runChat({ model, messages: userMsg, limits: [], tools, fallback: true });
  assert.equal(out.text, "Half an answ");
  assert.match(out.incomplete![0]!, /cut off/);
  assert.equal(out.accounting?.length, 1);
  assert.notDeepEqual(out.incomplete, out.accounting);
  // The thread with a ledger that cannot record: both lists arrive, apart (the latch then refuses a second paid call, by design).
  const r = rig({ model: fallbackModel({ primary: primaryOf(limited), config: ready(), ledger: { ...ledgerIn(dir(), () => new Date()), settle: () => { throw new Error("EIO"); } }, fetcher }) });
  const t = await r.create("x");
  const res = await r.send(t.id, "tell me");
  const last = res.data.thread.messages.at(-1);
  assert.equal(last.text, "Half an answ", "no marker in the stored text");
  assert.match(last.incomplete[0], /cut off/);
  assert.equal(last.accounting.length, 1);
  r.close();
  // A healthy ledger: the note is stored, returned by /chat, and never reaches a later model request.
  const r2 = rig({ model: fallbackModel({ primary: primaryOf(limited), config: ready(), ledger: ledgerIn(dir(), () => new Date()), fetcher }) });
  const t2 = await r2.create("x");
  const res2 = await r2.send(t2.id, "tell me");
  const last2 = res2.data.thread.messages.at(-1);
  assert.equal(last2.text, "Half an answ");
  assert.match(last2.incomplete[0], /cut off/);
  assert.equal(last2.accounting, undefined);
  const stored = (await r2.api(`/threads/${t2.id}`)).data.thread.messages.at(-1);
  assert.deepEqual(stored.incomplete, last2.incomplete);
  const chat = await r2.api("/chat", "POST", { messages: [{ role: "user", content: "tell me" }] });
  assert.equal(chat.status, 200);
  assert.equal(chat.data.reply.value, "Half an answ");
  assert.match(chat.data.reply.incomplete[0], /cut off/);
  const mark = reqs.length;
  await r2.send(t2.id, "continue");
  assert.ok(reqs.length > mark, "a healthy ledger admitted the next paid call");
  for (const q of reqs.slice(mark)) assert.ok(!/cut off|incomplete/i.test(JSON.stringify(q.messages.slice(1))), "the note never reaches a model request");
  assert.match(readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8"), /Incomplete reply: \$\{m\.incomplete/);
  r2.close();
});
