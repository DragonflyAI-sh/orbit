import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { CHATGPT_BOUNDS, chatgptModel, ProviderError, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import { deadline, RequestCancelled, RequestTimeout } from "../src/model-deadline.ts";
import type { Bounds, Timers } from "../src/model-deadline.ts";
import { OPENAI_BOUNDS, openaiModel } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";
import { provisioned } from "./helpers/ledger.ts";

// Audit D1: every model request has a bounded lifetime. Nothing here reaches a provider: the "servers" are fake fetchers, and the bounds
// are tens of milliseconds, so a hung fake costs the test that long and no more. Timers are counted, so each test also proves that no
// timer is left behind on any exit.

const BOUNDS: Bounds = { headersMs: 40, idleMs: 40, totalMs: 150 };

function countedTimers() {
  const live = new Set<ReturnType<typeof setTimeout>>();
  const timers: Timers = {
    set(fn, ms) {
      const h = setTimeout(() => {
        live.delete(h);
        fn();
      }, ms);
      live.add(h);
      return h;
    },
    clear(h) {
      clearTimeout(h as ReturnType<typeof setTimeout>);
      live.delete(h as ReturnType<typeof setTimeout>);
    },
  };
  return { timers, live };
}

const enc = new TextEncoder();
const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const textStream = (text: string) => event({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } });
const toolStream = (name: string) =>
  event({ type: "response.completed", response: { output: [{ type: "function_call", call_id: "c1", name, arguments: "{}" }] } });
const partialToolEvent = (name: string) => event({ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name, arguments: "{}" } });

// What a fake server does with one inference request.
type Behaviour =
  | { kind: "answer"; body: string; status?: number }
  // Never sends headers.
  | { kind: "no-headers" }
  // Sends headers and `first`, then nothing more, ever.
  | { kind: "stall"; first: string; status?: number }
  // Sends `first`, then a heartbeat event every few milliseconds, forever.
  | { kind: "endless"; first: string };

function fakeServer(script: Behaviour[] | (() => Behaviour)) {
  const log = { requests: 0, aborted: 0, cancelled: 0, signals: [] as AbortSignal[] };
  const fetcher = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("/v1/responses")) return new Response("", { status: 404 });
    const n = log.requests++;
    const b = typeof script === "function" ? script() : script[Math.min(n, script.length - 1)]!;
    const signal = init.signal!;
    log.signals.push(signal);
    signal.addEventListener("abort", () => log.aborted++, { once: true });
    if (b.kind === "answer") return new Response(b.body, { status: b.status ?? 200 });
    if (b.kind === "no-headers") {
      // Like fetch: rejects only when its signal aborts. The keep-alive stands in for the socket a real request holds open.
      const keep = setTimeout(() => {}, 10_000);
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          clearTimeout(keep);
          reject(signal.reason);
        }),
      );
    }
    let beat: ReturnType<typeof setInterval> | undefined;
    let keep: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(b.first));
        if (b.kind === "endless") beat = setInterval(() => c.enqueue(enc.encode(event({ type: "response.in_progress" }))), 5);
        else keep = setTimeout(() => {}, 10_000);
      },
      cancel() {
        log.cancelled++;
        clearInterval(beat);
        clearTimeout(keep);
      },
    });
    return new Response(stream, { status: b.kind === "stall" ? (b.status ?? 200) : 200 });
  }) as unknown as typeof fetch;
  return { fetcher, log };
}

const START = Date.parse("2026-11-13T12:00:00Z");
function signedIn() {
  const file = tokenFile(undefined);
  const tokens: Tokens = {
    access: "access-0",
    refresh: "refresh-0",
    expires: START + 600 * 60_000,
    idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`,
    clientId: "oaiapp_x",
    subject: "user-1",
    scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  };
  file.write(tokens);
  return file;
}

function chatgpt(script: Behaviour[] | (() => Behaviour), bounds: Partial<Bounds> = BOUNDS) {
  const server = fakeServer(script);
  const { timers, live } = countedTimers();
  const model = chatgptModel("gpt-x", signedIn(), { fetcher: server.fetcher, now: () => START, sleep: async () => {}, bounds, timers });
  return { model, server, live };
}
const ask = (m: { reply: ReturnType<typeof chatgptModel>["reply"] }, signal?: AbortSignal) => m.reply([{ role: "user", content: "x" }], [], undefined, signal ? { signal } : undefined);

const isTimeout = (phase: "headers" | "idle" | "total") => (err: unknown) => {
  assert.ok(err instanceof ProviderError, String(err));
  assert.equal(err.kind, "timeout");
  assert.equal(err.code, `timeout_${phase}`);
  assert.ok(err.cause instanceof RequestTimeout && err.cause.phase === phase);
  assert.match(err.message, /ORBIT abandoned the request\. Nothing from it was used and no tool call from it was run\./);
  assert.doesNotMatch(err.message, /usage|rate limit|quota|cancel/i);
  return true;
};

// ---- defaults ----------------------------------------------------------------------------------------------------------

test("D1 defaults: every bound is finite and ordered (headers and idle within total)", () => {
  for (const b of [CHATGPT_BOUNDS, OPENAI_BOUNDS]) {
    for (const v of Object.values(b)) assert.ok(Number.isFinite(v) && v > 0);
    assert.ok(b.headersMs <= b.totalMs && b.idleMs <= b.totalMs);
  }
  assert.deepEqual(CHATGPT_BOUNDS, { headersMs: 120_000, idleMs: 300_000, totalMs: 600_000 });
  assert.deepEqual(OPENAI_BOUNDS, { headersMs: 600_000, idleMs: 300_000, totalMs: 600_000 });
});

// ---- ChatGPT: each way a request can hang ---------------------------------------------------------------------------------

test("D1 ChatGPT: no response headers ends in a timeout, aborts the request, leaves no timer, and the port reports it", async () => {
  const r = chatgpt([{ kind: "no-headers" }]);
  await assert.rejects(ask(r.model), isTimeout("headers"));
  assert.equal(r.server.log.aborted, 1, "the request's signal was aborted");
  assert.equal(r.live.size, 0, "no timer left");
  const s = r.model.status();
  assert.equal(s.state, "down");
  assert.match(s.detail, /Last call failed: ChatGPT sent no response within 0\.04 s/);
  assert.doesNotMatch(s.detail, /limit|pauses/i, "a timeout pauses nothing");
});

test("D1 ChatGPT: a body that stops arriving ends in an idle timeout and the stream is cancelled", async () => {
  const r = chatgpt([{ kind: "stall", first: event({ type: "response.created" }) }]);
  await assert.rejects(ask(r.model), isTimeout("idle"));
  assert.equal(r.server.log.aborted, 1);
  assert.equal(r.server.log.cancelled, 1, "body consumption stopped");
  assert.equal(r.live.size, 0);
});

test("D1 ChatGPT: a stream that keeps sending data forever is ended by the total deadline", async () => {
  const r = chatgpt([{ kind: "endless", first: event({ type: "response.created" }) }]);
  const t0 = Date.now();
  await assert.rejects(ask(r.model), isTimeout("total"));
  const took = Date.now() - t0;
  assert.ok(took >= 140 && took < 2000, `ended near the total bound (${took} ms)`);
  assert.equal(r.server.log.aborted, 1);
  assert.equal(r.server.log.cancelled, 1);
  assert.equal(r.live.size, 0);
});

test("D1 ChatGPT: an error response whose body stalls is still classified by its status (a real 429 stays a rate limit)", async () => {
  const r = chatgpt([{ kind: "stall", first: "", status: 429 }]);
  await assert.rejects(ask(r.model), (err: unknown) => err instanceof ProviderError && err.kind === "rate_limit");
  assert.equal(r.server.log.cancelled, 1);
  assert.equal(r.live.size, 0);
});

test("D1 ChatGPT: normal text and tool answers and HTTP errors pass through unchanged, with every timer cleared", async () => {
  const r = chatgpt([
    { kind: "answer", body: textStream("hello") },
    { kind: "answer", body: toolStream("jobs_list") },
    { kind: "answer", body: JSON.stringify({ error: { message: "boom" } }), status: 500 },
  ]);
  assert.equal((await ask(r.model)).value, "hello");
  const step = await r.model.step!([{ role: "user", content: "x" }], [], undefined, [{ name: "jobs_list", description: "d", parameters: {} }]);
  assert.deepEqual(step.calls, [{ call_id: "c1", name: "jobs_list", arguments: "{}" }]);
  await assert.rejects(ask(r.model), (err: unknown) => err instanceof ProviderError && err.kind === "failed" && /HTTP 500/.test(err.message));
  assert.equal(r.server.log.aborted, 0, "nothing was aborted");
  assert.equal(r.live.size, 0);
});

test("D1 ChatGPT: a timeout is followed by a normal call; the model is not paused", async () => {
  const r = chatgpt([{ kind: "stall", first: "" }, { kind: "answer", body: textStream("back") }]);
  await assert.rejects(ask(r.model), isTimeout("idle"));
  assert.equal((await ask(r.model)).value, "back");
  assert.equal(r.server.log.requests, 2);
  assert.equal(r.model.status().state, "live");
  assert.equal(r.live.size, 0);
});

// ---- caller cancellation ----------------------------------------------------------------------------------------------

test("D1 ChatGPT: the caller's cancellation aborts the request mid-stream and is reported as a cancellation, not a timeout or failure", async () => {
  const r = chatgpt([{ kind: "endless", first: event({ type: "response.created" }) }], { headersMs: 5_000, idleMs: 5_000, totalMs: 10_000 });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(ask(r.model, ctl.signal), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, "cancelled");
    assert.ok(err.cause instanceof RequestCancelled);
    assert.doesNotMatch(err.message, /within|timeout|limit/i);
    return true;
  });
  assert.equal(r.server.log.aborted, 1);
  assert.equal(r.server.log.cancelled, 1);
  assert.equal(r.live.size, 0, "the 10 s total timer is cleared, not left running");
  assert.doesNotMatch(r.model.status().detail, /Last call failed/, "a cancellation is not a model failure");
});

test("D1 ChatGPT: an already-cancelled signal sends nothing", async () => {
  const r = chatgpt([{ kind: "answer", body: textStream("never") }]);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(ask(r.model, ctl.signal), (err: unknown) => err instanceof ProviderError && err.kind === "cancelled");
  assert.equal(r.server.log.requests, 0);
  assert.equal(r.live.size, 0);
});

test("D1 deadline: end() removes the caller-signal listener and later aborts change nothing", async () => {
  const { timers, live } = countedTimers();
  const ctl = new AbortController();
  const d = deadline(BOUNDS, { timers, signal: ctl.signal });
  const res = await d.fetch((async () => new Response("ok")) as unknown as typeof fetch, "https://example.invalid/", {});
  assert.equal(await d.read(res), "ok");
  d.end();
  assert.equal(live.size, 0);
  ctl.abort();
  assert.equal(d.signal.aborted, false, "the caller's later abort no longer reaches the finished request");
});

// ---- no paid fallback on a timeout ----------------------------------------------------------------------------------

test("D1 fallback: a ChatGPT timeout never reaches the paid OpenRouter fallback, even for an opted-in interactive turn", async () => {
  const r = chatgpt([{ kind: "no-headers" }]);
  const paid = { requests: 0 };
  const orFetch = (async () => {
    paid.requests++;
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  const cfg = openrouterConfig(
    {
      ORBIT_OPENROUTER_ENABLED: "1",
      ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
      ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
      ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
      ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048",
      CREDENTIALS_DIRECTORY: "/creds",
    },
    () => ["fake", "key", "for", "tests", "only"].join("-"),
  );
  assert.equal(cfg.state, "ready");
  const ledger = provisioned(mkdtempSync(join(tmpdir(), "orbit-d1-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const model = fallbackModel({ primary: r.model, config: cfg, ledger, fetcher: orFetch });
  await assert.rejects(model.step!([{ role: "user", content: "hi" }], [], undefined, [], { fallback: true }), isTimeout("headers"));
  await assert.rejects(model.reply([{ role: "user", content: "hi" }], []), isTimeout("headers"));
  assert.equal(paid.requests, 0, "no paid request");
  assert.equal(model.fallbackState().usingFallback, false);
  assert.equal(model.fallbackState().limit, undefined, "a timeout records no limit");
  assert.equal(r.live.size, 0);
});

test("D1 fallback: the caller's signal reaches the primary through the fallback wrapper", async () => {
  const r = chatgpt([{ kind: "endless", first: "" }], { headersMs: 5_000, idleMs: 5_000, totalMs: 10_000 });
  const model = fallbackModel({ primary: r.model, config: { state: "disabled", reason: "off" } as never });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(model.step!([{ role: "user", content: "hi" }], [], undefined, [], { fallback: true, signal: ctl.signal }), (err: unknown) => err instanceof ProviderError && err.kind === "cancelled");
  assert.equal(r.live.size, 0);
});

// ---- thread turn lifecycle -------------------------------------------------------------------------------------------

test("D1 thread: a turn whose stream stalls after a partial tool call fails truthfully, runs no tool, frees the thread, and the next turn works", async () => {
  const r = chatgpt([
    { kind: "stall", first: event({ type: "response.created" }) + partialToolEvent("danger") },
    { kind: "answer", body: textStream("second answer") },
  ]);
  const runs = { danger: 0 };
  const danger: ChatTool = { name: "danger", description: "d", parameters: { type: "object", properties: {} }, run: async () => (runs.danger++, { value: "ran", provenance: "live", source: "t" }) };
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model: r.model, proposals: newProposals(), budget: 1_000_000 });
  const t = threads.create("D1");
  const prep = { memory: [], limits: [], tools: [danger], isOwner: true };

  const first = await svc.turn(t.id, "first question", prep);
  assert.match(first.error ?? "", /^The model call failed: ChatGPT stopped sending its response: no data for 0\.04 s, so ORBIT abandoned the request\. Nothing from it was used and no tool call from it was run\.$/);
  assert.equal(runs.danger, 0, "the partial tool call was not run");
  assert.equal(threads.isBusy(t.id), false, "the thread is free again");
  // (The view returned by turn() is taken inside the turn, before its `finally` frees the thread, on every outcome; read it again.)
  assert.equal(svc.view(t.id)!.busy, false);

  const second = await svc.turn(t.id, "second question", prep);
  assert.equal(second.error, undefined);
  const msgs = threads.get(t.id)!.messages;
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(msgs[0]!.text, "first question");
  assert.equal(msgs[1]!.status, "error");
  assert.match(msgs[1]!.error ?? "", /no data for 0\.04 s/);
  assert.equal(msgs[2]!.text, "second question");
  assert.equal(msgs[3]!.status, "done");
  assert.equal(msgs[3]!.text, "second answer");
  assert.equal(msgs.length, 4, "no duplicated message");
  assert.equal(msgs.filter((m) => m.role === "assistant" && m.calls?.length).length, 0, "no call was recorded");
  assert.equal(r.server.log.requests, 2);
  assert.equal(r.live.size, 0);
});

// ---- OpenAI API key path (openaiModel) ----------------------------------------------------------------------------------

function openai(script: Behaviour[]) {
  const server = fakeServer(script);
  const { timers, live } = countedTimers();
  const model = openaiModel("gpt-x", ["not", "a", "key"].join("-"), server.fetcher, { bounds: BOUNDS, timers });
  return { model, server, live };
}
const openaiAnswer = (text: string) => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });

test("D1 openaiModel: no headers, a stalled body and an endless body each end within their bound and are aborted", async () => {
  for (const [b, phase] of [
    [{ kind: "no-headers" }, "sent no response within"],
    [{ kind: "stall", first: "{" }, "stopped sending its response"],
    [{ kind: "endless", first: "" }, "did not finish its response within"],
  ] as const) {
    const r = openai([b]);
    await assert.rejects(ask(r.model), (err: unknown) => err instanceof Error && err.message.startsWith(`OpenAI ${phase}`) && /abandoned the request/.test(err.message));
    assert.equal(r.server.log.aborted, 1, phase);
    assert.equal(r.live.size, 0, phase);
    assert.match(r.model.status().detail, /Last call failed: OpenAI/);
  }
});

test("D1 openaiModel: normal answers and cancellation", async () => {
  const r = openai([{ kind: "answer", body: openaiAnswer("ok") }, { kind: "endless", first: "" }]);
  assert.equal((await ask(r.model)).value, "ok");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(ask(r.model, ctl.signal), (err: unknown) => err instanceof RequestCancelled);
  assert.equal(r.model.status().state, "live", "a cancellation is not recorded as a model failure");
  assert.equal(r.live.size, 0);
});
