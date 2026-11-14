import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ASSISTANT_CONTEXT_BUDGET_CHARS, ASSISTANT_NOTES_MAX_CHARS } from "../src/assistant-context.ts";
import type { Item } from "../src/model.ts";
import { call, OWNER, rig, say, scripted } from "./threads-fixture.ts";

// The Assistant's routes against a real server with a scripted model (test/threads-fixture.ts). Offline: no provider is called.

const withAssistant = (dir?: string) => {
  const d = dir ?? mkdtempSync(join(tmpdir(), "orbit-assistant-srv-"));
  return { dir: d, extra: () => ({ assistantDir: join(d, "assistant") }) };
};
const conversationChars = (items: Item[]) => items.reduce((n, it) => n + ("content" in it ? it.content.length : "output" in it ? it.output.length : it.arguments.length), 0);
const texts = (view: any) => view.chunks.flatMap((c: any) => c.messages.map((m: any) => m.text));

test("owner only: every Assistant route refuses anyone else before reading or changing anything", async () => {
  const a = withAssistant();
  const model = scripted([say("never")]);
  const x = rig({ dir: a.dir, extra: a.extra, model });
  x.caller.who = "someone@example.com";
  assert.equal((await x.api("/assistant")).status, 403);
  assert.equal((await x.api("/assistant/history")).status, 403);
  assert.equal((await x.api("/assistant/messages", "POST", { text: "hi" })).status, 403);
  x.caller.who = undefined;
  assert.equal((await x.api("/assistant")).status, 403);
  assert.equal(model.seen.length + model.replies.length, 0, "no model call");
  x.caller.who = OWNER;
  assert.equal((await x.api("/assistant", "POST", {})).status, 405);
  assert.equal((await x.api("/assistant/messages")).status, 405);
  // A cross-site POST is refused like every other state-changing route.
  assert.equal((await x.api("/assistant/messages", "POST", { text: "hi" }, { origin: "https://evil.example" })).status, 403);
});

test("one conversation, server-named, starting empty; a turn is stored and returned; the browser cannot pick a path", async () => {
  const a = withAssistant();
  const x = rig({ dir: a.dir, extra: a.extra, model: scripted([say("Hello Rai.")]) });
  const empty = (await x.api("/assistant")).data.assistant;
  assert.equal(empty.session.id, "assistant");
  assert.deepEqual(empty.chunks, []);
  assert.equal(empty.archivedChunks, 0);
  assert.equal(empty.persisted, true);
  assert.equal(empty.budgets.unit, "characters");
  const r = await x.api("/assistant/messages", "POST", { text: "hi there", id: "../../etc", path: "/tmp/x" });
  assert.equal(r.status, 200);
  assert.deepEqual(texts(r.data.assistant), ["hi there", "Hello Rai."]);
  assert.equal(r.data.assistant.chunks[0].seq, 1);
  assert.equal(r.data.assistant.chunks[0].context.included.length, 0, "the first turn had no history");
  assert.ok(existsSync(join(a.dir, "assistant", "active", "000000000001.json")));
  // There is no other conversation to address.
  assert.equal((await x.api("/assistant/11111111-1111-4111-8111-111111111111")).status, 404);
  assert.equal((await x.api("/assistant/messages", "POST", { text: "" })).status, 400);
  assert.equal((await x.api("/assistant/messages", "POST", { text: "x".repeat(20_001) })).status, 400);
});

test("isolated from Chat: chat threads are unchanged, never listed with it, never in its context, and it is never in theirs", async () => {
  const a = withAssistant();
  const model = scripted((seen) => say(`reply #${seen.input.length}`));
  const x = rig({ dir: a.dir, extra: a.extra, model });
  const t = await x.create("Chat one");
  await x.send(t.id, "CHAT-ONLY-SECRET-PLAN alpha");
  const beforeThread = readFileSync(join(a.dir, "threads", `${t.id}.json`), "utf8");
  await x.api("/assistant/messages", "POST", { text: "ASSISTANT-ONLY beta" });
  await x.api("/assistant/messages", "POST", { text: "ASSISTANT-ONLY gamma" });
  // The Assistant's model input holds only its own turns.
  const assistantInputs = model.seen.slice(1).map((s) => JSON.stringify(s.input));
  for (const i of assistantInputs) assert.doesNotMatch(i, /CHAT-ONLY/);
  assert.match(assistantInputs[1]!, /ASSISTANT-ONLY beta/);
  // Chat: same file, same list, and its next turn does not see the Assistant.
  assert.equal(readFileSync(join(a.dir, "threads", `${t.id}.json`), "utf8"), beforeThread, "the chat thread file is untouched");
  const list = (await x.api("/threads?archived=1")).data.threads;
  assert.deepEqual(list.map((l: any) => l.id), [t.id]);
  await x.send(t.id, "chat again");
  assert.doesNotMatch(JSON.stringify(model.seen.at(-1)!.input), /ASSISTANT-ONLY/);
  assert.match(JSON.stringify(model.seen.at(-1)!.input), /CHAT-ONLY-SECRET-PLAN/);
  assert.deepEqual(readdirSync(join(a.dir, "threads")).filter((f) => f.endsWith(".json")).sort(), [`${t.id}.json`].sort(), "the Assistant writes nothing in threads/");
  // The Assistant is not given the chat threads' rolling note.
  assert.doesNotMatch(model.seen[1]!.notes ?? "", /recent-work/);
});

test("refresh and restart: a second server on the same state directory serves the same conversation and continues it", async () => {
  const a = withAssistant();
  const x = rig({ dir: a.dir, extra: a.extra, model: scripted([say("first answer")]) });
  await x.api("/assistant/messages", "POST", { text: "remember: blue" });
  const before = (await x.api("/assistant")).data.assistant;
  x.close();
  const model = scripted([say("second answer")]);
  const y = rig({ dir: a.dir, extra: a.extra, model });
  const after = (await y.api("/assistant")).data.assistant;
  assert.equal(after.session.createdAt, before.session.createdAt);
  assert.deepEqual(texts(after), ["remember: blue", "first answer"]);
  await y.api("/assistant/messages", "POST", { text: "what colour?" });
  assert.match(JSON.stringify(model.seen[0]!.input), /remember: blue/, "the restarted server sends the stored history");
  assert.deepEqual(texts((await y.api("/assistant")).data.assistant), ["remember: blue", "first answer", "what colour?", "second answer"]);
});

test("concurrent sends from two tabs: exactly one runs, the other is refused with 409 and nothing is queued or replayed", async () => {
  const a = withAssistant();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const model = scripted(async () => (await gate, say("the only reply")));
  const x = rig({ dir: a.dir, extra: a.extra, model });
  const first = x.api("/assistant/messages", "POST", { text: "from tab one" });
  for (let i = 0; i < 50 && model.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const busyView = (await x.api("/assistant")).data.assistant;
  assert.equal(busyView.busy, true);
  const second = await x.api("/assistant/messages", "POST", { text: "from tab two" });
  assert.equal(second.status, 409);
  assert.match(second.data.error, /already in progress/);
  release();
  assert.equal((await first).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  const view = (await x.api("/assistant")).data.assistant;
  assert.deepEqual(texts(view), ["from tab one", "the only reply"]);
  assert.equal(model.seen.length, 1, "the refused message never reached the model");
  assert.equal(view.busy, false);
});

test("a model failure keeps the user message and marks the reply as failed; nothing is retried", async () => {
  const a = withAssistant();
  const model = scripted(() => {
    throw new Error("provider down");
  });
  const x = rig({ dir: a.dir, extra: a.extra, model });
  const r = await x.api("/assistant/messages", "POST", { text: "try once" });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /provider down/);
  const [c] = r.data.assistant.chunks;
  assert.equal(c.messages[0].text, "try once");
  assert.equal(c.messages[1].status, "error");
  assert.equal(model.seen.length, 1);
});

test("bounded prompt assembly end to end: huge tool output over many turns never pushes the model input past the budget", async () => {
  const a = withAssistant();
  const big = "Z".repeat(60_000);
  let n = 0;
  // Every turn: one tool call that returns a huge result (runChat clips it to 8000), then a long answer.
  const model = scripted((seen) => {
    const last = seen.input.at(-1) as { type?: string };
    if (last?.type === "function_call_output") return say(`answer ${n} ${"a".repeat(15_000)}`);
    n++;
    return { text: "", calls: [call("memory_search", { query: big.slice(0, 5000) }, `c${n}`)] };
  });
  const x = rig({ dir: a.dir, extra: a.extra, model, vault: { "big.md": `# big\n${big}` } });
  for (let i = 0; i < 8; i++) {
    const r = await x.api("/assistant/messages", "POST", { text: `turn ${i} ${"u".repeat(19_000)}` });
    assert.equal(r.status, 200, JSON.stringify(r.data.error));
  }
  // The first step of each turn is the assembled history plus the new message: always within the budget, always paired.
  const firstSteps = model.seen.filter((s) => (s.input.at(-1) as { role?: string }).role === "user");
  assert.equal(firstSteps.length, 8);
  for (const s of firstSteps) {
    assert.ok(conversationChars(s.input) <= ASSISTANT_CONTEXT_BUDGET_CHARS, `${conversationChars(s.input)} <= ${ASSISTANT_CONTEXT_BUDGET_CHARS}`);
    for (let i = 0; i < s.input.length; i++) if ((s.input[i] as any).type === "function_call") assert.equal((s.input[i + 1] as any).call_id, (s.input[i] as any).call_id);
    assert.ok((s.notes ?? "").length <= ASSISTANT_NOTES_MAX_CHARS + 6_000, "reference material stays bounded");
  }
  const view = (await x.api("/assistant")).data.assistant;
  assert.ok(view.archivedChunks > 0, "older turns rotated into the archive");
  assert.equal(view.archivedChunks + view.chunks.length, 8, "no turn lost or duplicated");
  const shortened = view.chunks.flatMap((c: any) => c.context?.included ?? []).filter((i: any) => i.form !== "full");
  assert.ok(shortened.length > 0, "a bounded representation is recorded and identified");
  // The full original stays stored: the context clip (4,000 characters of text) is never written back.
  const stored = JSON.parse(readFileSync(join(a.dir, "assistant", "archive", "000000000001.json"), "utf8"));
  assert.equal(stored.messages[0].text.length, "turn 0 ".length + 19_000);
  assert.ok(stored.messages[1].text.length > 15_000);
  assert.equal(stored.messages[1].calls.length, 1);
  // History pages back through the archive, newest first.
  const page = (await x.api("/assistant/history?limit=2")).data;
  assert.equal(page.chunks.length, 2);
  assert.equal(page.chunks.at(-1).seq, view.chunks[0].seq - 1);
  assert.equal(page.chunks[0].messages[1].calls[0].outputChars > 0, true, "tool output is summarised by size, not sent in full");
});

test("a proposal made in the Assistant is confirmed once through the existing route, and its card settles in the Assistant", async () => {
  const a = withAssistant();
  const model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: "Implement the widget exporter with tests and docs for the billing module please" })] }, say("Proposed; waiting for your confirmation.")]);
  const x = rig({ dir: a.dir, extra: a.extra, model });
  const r = await x.api("/assistant/messages", "POST", { text: "launch the exporter job" });
  const card = r.data.assistant.chunks[0].cards[0];
  assert.equal(card.kind, "job_launch");
  assert.equal(card.state, "open");
  const results = await Promise.all(Array.from({ length: 4 }, () => x.api(`/chat/proposals/${card.id}/confirm`, "POST")));
  assert.equal(results.filter((res) => res.status === 202).length, 1, "exactly one confirmation goes through");
  assert.equal(x.fired.length, 1);
  const shown = (await x.api("/assistant")).data.assistant.chunks[0].cards[0];
  assert.equal(shown.state, "confirmed");
  assert.ok(shown.outcome.jobId);
  assert.equal(shown.live.source, "jobs");
  // No chat thread was involved.
  assert.deepEqual((await x.api("/threads?archived=1")).data.threads, []);
});

test("cancelling an Assistant proposal settles its card; a card whose proposal is gone shows expired after a restart", async () => {
  const a = withAssistant();
  const brief = (k: string) => `Implement the ${k} exporter with tests and docs for the billing module please now`;
  const model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: brief("first") }, "a")] }, say("p1"), { text: "", calls: [call("job_launch", { routine: "orbit", brief: brief("second") }, "b")] }, say("p2")]);
  const x = rig({ dir: a.dir, extra: a.extra, model });
  const c1 = (await x.api("/assistant/messages", "POST", { text: "one" })).data.assistant.chunks[0].cards[0];
  assert.equal((await x.api(`/chat/proposals/${c1.id}/cancel`, "POST")).status, 200);
  const c2 = (await x.api("/assistant/messages", "POST", { text: "two" })).data.assistant.chunks[1].cards[0];
  assert.equal((await x.api("/assistant")).data.assistant.chunks[0].cards[0].state, "cancelled");
  x.close();
  const y = rig({ dir: a.dir, extra: a.extra });
  const view = (await y.api("/assistant")).data.assistant;
  assert.equal(view.chunks[1].cards[0].id, c2.id);
  assert.equal(view.chunks[1].cards[0].state, "expired", "the open proposal was lost in the restart: it is never shown as still confirmable");
  const late = await y.api(`/chat/proposals/${c2.id}/confirm`, "POST");
  assert.ok([404, 409].includes(late.status));
  assert.equal(y.fired.length, 0, "nothing ran");
});

test("a repeated send (same request id, e.g. a browser retry after a dropped connection) is refused, never run twice", async () => {
  const a = withAssistant();
  const model = scripted([say("ran once")]);
  const x = rig({ dir: a.dir, extra: a.extra, model });
  const id = "0123456789abcdef".repeat(2);
  assert.equal((await x.api("/assistant/messages", "POST", { text: "do it", requestId: id })).status, 200);
  const again = await x.api("/assistant/messages", "POST", { text: "do it", requestId: id });
  assert.equal(again.status, 409);
  assert.equal(again.data.duplicate, true);
  assert.equal(model.seen.length, 1, "the model ran once");
  assert.equal(again.data.assistant.chunks.length, 1);
  // Still known after a restart (the id is stored with the turn).
  x.close();
  const y = rig({ dir: a.dir, extra: a.extra, model: scripted([say("other")]) });
  assert.equal((await y.api("/assistant/messages", "POST", { text: "do it", requestId: id })).status, 409);
  // A different send is fine; a malformed id is ignored rather than trusted.
  assert.equal((await y.api("/assistant/messages", "POST", { text: "next", requestId: "fedcba9876543210" })).status, 200);
  assert.equal((await y.api("/assistant/messages", "POST", { text: "odd", requestId: "../x" })).status, 200);
});
