import assert from "node:assert/strict";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { chatgptModel, ProviderError, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import type { Bounds } from "../src/model-deadline.ts";
import { threadService } from "../src/thread-service.ts";
import { ThreadError, threadStore } from "../src/threads.ts";

// Acceptance 2026-11-14 (docs/acceptance-2026-11-14.md, area 3): turn recovery after a model request is abandoned, exercised through
// the real chatgptModel (with its real request deadline), the real runChat tool loop and the real thread service and store. The
// "server" is a fake fetcher; nothing here reaches a provider and no paid fallback is configured. These add cases the D1 tests in
// model-deadline.test.ts do not cover: a provider that ignores the abort and answers late, a stall after a tool already ran, and
// whether one stalled thread holds up another.

const BOUNDS: Bounds = { headersMs: 40, idleMs: 40, totalMs: 150 };
const START = Date.parse("2026-11-14T12:00:00Z");
const enc = new TextEncoder();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const textStream = (text: string) => event({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } });
const toolStream = (name: string, id = "c1") => event({ type: "response.completed", response: { output: [{ type: "function_call", call_id: id, name, arguments: "{}" }] } });

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

// One inference request: answer at once, never answer (stall), or ignore the abort entirely and answer `late` after `afterMs`.
type Plan = { kind: "answer"; body: string } | { kind: "stall" } | { kind: "late"; body: string; afterMs: number };

function fakeChatgpt(plans: Plan[] | ((n: number, body: string) => Plan)) {
  const log = { requests: 0, lateDelivered: 0 };
  const fetcher = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("/v1/responses")) return new Response("", { status: 404 });
    const n = log.requests++;
    const p = typeof plans === "function" ? plans(n, String(init.body)) : plans[Math.min(n, plans.length - 1)]!;
    if (p.kind === "answer") return new Response(p.body, { status: 200 });
    if (p.kind === "late") {
      // A misbehaving transport: the abort is not honoured, and a complete answer (here a tool call) arrives after the deadline.
      await wait(p.afterMs);
      log.lateDelivered++;
      return new Response(p.body, { status: 200 });
    }
    const signal = init.signal!;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  }) as unknown as typeof fetch;
  const model = chatgptModel("gpt-x", signedIn(), { fetcher, now: () => START, sleep: async () => {}, bounds: BOUNDS });
  return { model, log };
}

function countingTool(name: string) {
  const runs = { n: 0 };
  const tool: ChatTool = { name, description: name, parameters: { type: "object", properties: {} }, run: async () => (runs.n++, { value: `${name} ran`, provenance: "live", source: "test" }) };
  return { tool, runs };
}

test("recovery: a provider that ignores the abort and delivers a tool call after the deadline causes no tool run and no late write", async () => {
  const fx = fakeChatgpt([{ kind: "late", body: toolStream("danger"), afterMs: 120 }, { kind: "answer", body: textStream("second answer") }]);
  const danger = countingTool("danger");
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model: fx.model, proposals: newProposals(), budget: 1_000_000 });
  const t = threads.create("late");
  const prep = { memory: [], limits: [], tools: [danger.tool], isOwner: true };

  const first = await svc.turn(t.id, "first", prep);
  assert.match(first.error ?? "", /sent no response within 0\.04 s/);
  assert.equal(threads.isBusy(t.id), false, "the thread is free as soon as the deadline fires");
  const snapshot = JSON.stringify(threads.get(t.id));

  // Let the ignored request deliver its tool call, then look again: nothing moved.
  await wait(200);
  assert.equal(fx.log.lateDelivered, 1, "the late answer really was delivered by the fake");
  assert.equal(danger.runs.n, 0, "the late tool call was never run");
  assert.equal(JSON.stringify(threads.get(t.id)), snapshot, "nothing was written to the thread after the turn ended");

  const second = await svc.turn(t.id, "second", prep);
  assert.equal(second.error, undefined);
  const msgs = threads.get(t.id)!.messages;
  assert.deepEqual(msgs.map((m) => `${m.role}:${m.status ?? ""}`), ["user:", "assistant:error", "user:", "assistant:done"]);
  assert.equal(msgs[3]!.text, "second answer");
  assert.equal(danger.runs.n, 0);
});

test("recovery: a stall after a tool already ran keeps that call on record once, runs nothing again, frees the thread, and the next turn works", async () => {
  // Round 1 asks for `lookup`; round 2 (after the tool result) stalls; the next turn answers.
  const fx = fakeChatgpt([{ kind: "answer", body: toolStream("lookup") }, { kind: "stall" }, { kind: "answer", body: textStream("fresh answer") }]);
  const lookup = countingTool("lookup");
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model: fx.model, proposals: newProposals(), budget: 1_000_000 });
  const t = threads.create("partial");
  const prep = { memory: [], limits: [], tools: [lookup.tool], isOwner: true };

  const first = await svc.turn(t.id, "look something up", prep);
  assert.match(first.error ?? "", /^The model call failed: ChatGPT sent no response within 0\.04 s/);
  assert.equal(lookup.runs.n, 1, "the tool that completed before the stall ran exactly once");
  assert.equal(threads.isBusy(t.id), false);
  const failed = threads.get(t.id)!.messages[1]!;
  assert.equal(failed.status, "error");
  assert.deepEqual(failed.calls?.map((c) => [c.name, c.ok]), [["lookup", true]], "the completed call stays on the failed reply, once");

  const second = await svc.turn(t.id, "and now?", prep);
  assert.equal(second.error, undefined);
  assert.equal(lookup.runs.n, 1, "the earlier call is not re-run by the next turn");
  const msgs = threads.get(t.id)!.messages;
  assert.equal(msgs.length, 4, "no duplicated message");
  assert.equal(msgs[3]!.text, "fresh answer");
  assert.equal(fx.log.requests, 3, "nothing was retried automatically");
});

test("recovery: while one thread's request is stalled, that thread refuses a second message (409) and another thread answers normally", async () => {
  const fx = fakeChatgpt((_n, body) => (body.includes("stall me") ? { kind: "stall" } : { kind: "answer", body: textStream("other answer") }));
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model: fx.model, proposals: newProposals(), budget: 1_000_000 });
  const a = threads.create("A");
  const b = threads.create("B");
  const prep = { memory: [], limits: [], tools: [], isOwner: true };

  const stalled = svc.turn(a.id, "stall me", prep);
  await wait(5);
  assert.equal(threads.isBusy(a.id), true);
  await assert.rejects(svc.turn(a.id, "again", prep), (e: unknown) => e instanceof ThreadError && e.code === 409);
  const other = await svc.turn(b.id, "hello", prep);
  assert.equal(other.error, undefined, "the other thread is not held up by the stall");
  assert.equal(threads.get(b.id)!.messages[1]!.text, "other answer");

  const done = await stalled;
  assert.match(done.error ?? "", /sent no response within/);
  assert.equal(threads.isBusy(a.id), false);
  assert.deepEqual(threads.get(a.id)!.messages.map((m) => m.role), ["user", "assistant"], "the refused message was not stored");
});

test("recovery: a caller cancellation is not a timeout or a limit, and the next request on the same model answers", async () => {
  const fx = fakeChatgpt([{ kind: "stall" }, { kind: "answer", body: textStream("after cancel") }]);
  const ctl = new AbortController();
  const p = fx.model.reply([{ role: "user", content: "x" }], [], undefined, { signal: ctl.signal });
  await wait(5);
  ctl.abort();
  await assert.rejects(p, (e: unknown) => e instanceof ProviderError && e.kind === "cancelled");
  assert.notEqual(fx.model.status().state, "down", "a cancellation is not recorded as a model failure");
  const r = await fx.model.reply([{ role: "user", content: "y" }], []);
  assert.equal(r.value, "after cancel");
});
