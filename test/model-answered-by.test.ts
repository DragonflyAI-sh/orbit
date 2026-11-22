import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { answeredBy, modelLabel, primaryModelName } from "../src/model.ts";
import type { FallbackInfo, ModelPort, Step } from "../src/model.ts";
import { threadService } from "../src/thread-service.ts";
import { safePatch, threadStore, transcriptMessage } from "../src/threads.ts";
import type { ThreadMessage } from "../src/threads.ts";

// Which model wrote each reply (AnsweredBy, src/model.ts): recorded on every finished assistant reply, bounded by safePatch, given to
// session_read as a label, and shown on the page beside the reply's time. No model, provider or paid service is reached here.

const FB: FallbackInfo = { provider: "openrouter", model: "vendor/cheap-model", reason: "usage_limit", primaryLimit: { until: "2026-11-22T12:00:00.000Z", estimated: false }, costUsd: 0.0001 };

test("answeredBy names the primary model without its transport prefix, and the fallback model when it answered", () => {
  assert.equal(primaryModelName("chatgpt-token-sharing/gpt-6.2-sol"), "gpt-6.2-sol");
  assert.equal(primaryModelName("openai/gpt-6.2-sol"), "gpt-6.2-sol");
  assert.equal(primaryModelName("mock-echo"), "mock-echo");
  // A bare prefix is never turned into an empty name.
  assert.equal(primaryModelName("openai/"), "openai/");
  assert.deepEqual(answeredBy("chatgpt-token-sharing/gpt-6.2-sol"), { model: "gpt-6.2-sol" });
  assert.deepEqual(answeredBy("chatgpt-token-sharing/gpt-6.2-sol", FB), { model: "vendor/cheap-model", fallback: true });
  assert.deepEqual(answeredBy("chatgpt-token-sharing/gpt-6.2-sol", FB, true), { model: "vendor/cheap-model", fallback: true, mixed: true });
  // `mixed` without a fallback means nothing: the primary answered every round.
  assert.deepEqual(answeredBy("openai/gpt-6.2-sol", undefined, true), { model: "gpt-6.2-sol" });
  assert.equal(modelLabel({ model: "gpt-6.2-sol" }), "gpt-6.2-sol");
  assert.equal(modelLabel({ model: "vendor/cheap-model", fallback: true }), "fallback: vendor/cheap-model");
  // Only the model is ever recorded: no reason, limit or cost of the fallback.
  assert.deepEqual(Object.keys(answeredBy("x", FB, true)).sort(), ["fallback", "mixed", "model"]);
});

test("safePatch keeps only a well-formed answeredBy, bounded and masked", () => {
  assert.deepEqual(safePatch({ answeredBy: { model: "gpt-6.2-sol" } }).answeredBy, { model: "gpt-6.2-sol" });
  assert.deepEqual(safePatch({ answeredBy: { model: "m", fallback: true, mixed: true, extra: "dropped" } as never }).answeredBy, { model: "m", fallback: true, mixed: true });
  assert.equal("answeredBy" in safePatch({ answeredBy: { model: "" } }), false);
  assert.equal("answeredBy" in safePatch({ answeredBy: { model: 7 } as never }), false);
  assert.equal("answeredBy" in safePatch({ answeredBy: null as never }), false);
  assert.equal("answeredBy" in safePatch({ answeredBy: { model: "   " } }), false);
  // Flags are kept only when exactly true.
  assert.deepEqual(safePatch({ answeredBy: { model: "m", fallback: "yes" } as never }).answeredBy, { model: "m" });
  assert.equal(safePatch({ answeredBy: { model: "vendor/model ".repeat(40) } }).answeredBy!.model.length, 200);
  // A secret-shaped value is never stored as a model name (built at runtime, never a literal).
  const fake = ["sk", "proj", "a".repeat(40)].join("-");
  assert.doesNotMatch(safePatch({ answeredBy: { model: fake } }).answeredBy?.model ?? "", new RegExp(fake));
});

test("session_read's transcript carries the model label of an assistant reply, and nothing else about the fallback", () => {
  const base: ThreadMessage = { id: "a", role: "assistant", at: "2026-11-22T10:00:00.000Z", text: "hi", status: "done" };
  assert.equal(transcriptMessage({ ...base, answeredBy: { model: "gpt-6.2-sol" } }).model, "gpt-6.2-sol");
  const fb = transcriptMessage({ ...base, fallback: FB, answeredBy: { model: FB.model, fallback: true } });
  assert.equal(fb.model, "fallback: vendor/cheap-model");
  assert.doesNotMatch(JSON.stringify(fb), /usage_limit|costUsd|primaryLimit|2026-11-22T12/);
  // Older replies (no record) and user messages get no label.
  assert.equal("model" in transcriptMessage(base), false);
  assert.equal("model" in transcriptMessage({ ...base, role: "user", answeredBy: { model: "x" } }), false);
});

// A model port whose impl and fallback record are fixed: the reply text claims another model, which must never be what is stored.
function port(impl: string, fallback?: FallbackInfo, mixedRounds = false) {
  let n = 0;
  const step = async (): Promise<Step> => {
    const i = n++;
    if (mixedRounds && i === 0) return { text: "", calls: [{ call_id: "c1", name: "ping", arguments: "{}" }] };
    return { text: "I am definitely claude-imaginary-9.", calls: [], ...(fallback ? { fallback } : {}) };
  };
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl, detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "I am definitely claude-imaginary-9.", provenance: "live", source: `model/${impl}`, ...(fallback ? { fallback } : {}) }),
    step,
  };
  return model;
}
const ping: ChatTool = { name: "ping", description: "ping", parameters: { type: "object", properties: {} }, readOnly: true, run: async () => ({ value: "pong", provenance: "live", source: "test" }) };

async function lastReply(model: ModelPort, tools: ChatTool[]) {
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model, proposals: newProposals(), budget: 1_000_000 });
  const t = threads.create();
  const out = await svc.turn(t.id, "which model are you?", { memory: [], limits: [], tools, isOwner: true });
  assert.equal(out.error, undefined);
  const m = threads.get(t.id)!.messages.at(-1)!;
  assert.equal(m.role, "assistant");
  assert.equal(m.status, "done");
  return m;
}

test("every finished reply stores the model that answered: plain and tool-using turns, primary and fallback", async () => {
  assert.deepEqual((await lastReply(port("chatgpt-token-sharing/gpt-6.2-sol"), [])).answeredBy, { model: "gpt-6.2-sol" });
  assert.deepEqual((await lastReply(port("chatgpt-token-sharing/gpt-6.2-sol"), [ping])).answeredBy, { model: "gpt-6.2-sol" });
  assert.deepEqual((await lastReply(port("chatgpt-token-sharing/gpt-6.2-sol", FB), [])).answeredBy, { model: "vendor/cheap-model", fallback: true });
  const tooled = await lastReply(port("chatgpt-token-sharing/gpt-6.2-sol", FB), [ping]);
  assert.deepEqual(tooled.answeredBy, { model: "vendor/cheap-model", fallback: true });
  assert.deepEqual(tooled.fallback, FB, "the full fallback record is still kept beside it");
  // The primary ran the first (tool) round and the fallback wrote the answer: attributed to the fallback, marked mixed.
  assert.deepEqual((await lastReply(port("chatgpt-token-sharing/gpt-6.2-sol", FB, true), [ping])).answeredBy, { model: "vendor/cheap-model", fallback: true, mixed: true });
  // A mock port is labelled as what it is.
  assert.deepEqual((await lastReply(port("mock-echo"), [])).answeredBy, { model: "mock-echo" });
});

test("a failed turn records no model", async () => {
  const threads = threadStore(undefined);
  const model: ModelPort = { status: () => ({ port: "model", state: "down", impl: "openai/gpt-6.2-sol", detail: "down", verifiedAt: new Date().toISOString() }), reply: async () => { throw new Error("provider unreachable"); } };
  const svc = threadService({ threads, model, proposals: newProposals(), budget: 1_000_000 });
  const t = threads.create();
  await svc.turn(t.id, "hello", { memory: [], limits: [], tools: [], isOwner: true });
  const m = threads.get(t.id)!.messages.at(-1)!;
  assert.equal(m.status, "error");
  assert.equal(m.answeredBy, undefined);
});

// ---- the page ----

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const grab = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";
type El = { tag: string; className: string; textContent: string; title?: string; ariaLabel?: string; childNodes: El[]; append: (...k: (El | string)[]) => void; removeChild: (k: El) => El };
const mk = (tag: string, props: Record<string, unknown> = {}, ...kids: (El | string)[]): El => {
  const n: El = {
    tag, className: "", childNodes: [],
    get textContent() { return this.childNodes.map((k) => k.textContent).join(""); },
    set textContent(v: string) { this.childNodes = v ? [text(v)] : []; },
    append(...k) { for (const c of k) this.childNodes.push(typeof c === "string" ? text(c) : c); },
    removeChild(k) { this.childNodes.splice(this.childNodes.indexOf(k), 1); return k; },
  } as El;
  for (const [k, v] of Object.entries(props)) if (k === "textContent") n.textContent = String(v); else (n as unknown as Record<string, unknown>)[k] = v;
  n.append(...kids);
  return n;
};
const text = (v: string): El => ({ tag: "#text", className: "", childNodes: [], textContent: v, append() {}, removeChild: (k: El) => k }) as El;
const all = (n: El): El[] => [n, ...n.childNodes.flatMap(all)];
const lib = new Function("document", `${grab("notes")}; ${grab("markdown")}; ${grab("threads")}; return { modelLabelOf, headParts };`)({ querySelector: () => null }) as {
  modelLabelOf: (m: unknown) => { label: string; full: string; fallback: boolean } | null;
  headParts: (m: unknown, mk: unknown) => { key: string; sig: string; build: () => El; update?: (n: El) => void }[];
};
const reply = (over: Record<string, unknown> = {}) => ({ id: "r", role: "assistant", at: "2026-11-22T10:00:00.000Z", text: "ok", status: "done", provenance: "live", source: "model/chatgpt-token-sharing/gpt-6.2-sol", ...over });

test("the page labels each reply with its model, and a fallback answer as fallback", () => {
  assert.equal(lib.modelLabelOf(reply({ answeredBy: { model: "gpt-6.2-sol" } }))?.label, "gpt-6.2-sol");
  const fb = lib.modelLabelOf(reply({ fallback: FB, answeredBy: { model: FB.model, fallback: true, mixed: true } }))!;
  assert.equal(fb.label, "fallback: vendor/cheap-model");
  assert.equal(fb.fallback, true);
  assert.match(fb.full, /paid fallback model vendor\/cheap-model, not the primary.*earlier rounds/);
  // Replies stored before ORBIT recorded it are read from their own fallback and source fields.
  assert.equal(lib.modelLabelOf(reply())?.label, "gpt-6.2-sol");
  assert.equal(lib.modelLabelOf(reply({ source: "model/openai/gpt-6.2-sol" }))?.label, "gpt-6.2-sol");
  assert.equal(lib.modelLabelOf(reply({ fallback: FB, source: "model/openrouter/vendor/cheap-model (FALLBACK, paid: ...)" }))?.label, "fallback: vendor/cheap-model");
  // Nothing to go on, a user message, a reply still being written or a failed one: no label, never a guess.
  assert.equal(lib.modelLabelOf(reply({ source: undefined })), null);
  assert.equal(lib.modelLabelOf(reply({ source: "something else" })), null);
  assert.equal(lib.modelLabelOf({ ...reply({ answeredBy: { model: "x" } }), role: "user" }), null);
  assert.equal(lib.modelLabelOf(reply({ status: "pending", answeredBy: { model: "x" } })), null);
  assert.equal(lib.modelLabelOf(reply({ status: "error", answeredBy: { model: "x" } })), null);
});

test("the label sits in the name line, after the time, and appears in place when a reply finishes", () => {
  const head = (m: unknown) => lib.headParts(m, mk).find((p) => p.key === "head")!;
  const done = head(reply({ answeredBy: { model: "gpt-6.2-sol" } })).build();
  assert.equal(done.className, "mhead");
  const tag = all(done).find((n) => n.className.split(" ")[0] === "mmodel")!;
  assert.equal(tag.textContent, "gpt-6.2-sol");
  assert.equal(tag.className, "mmodel");
  assert.equal(done.childNodes.at(-1), tag, "after the name and the time");
  const fbTag = all(head(reply({ fallback: FB, answeredBy: { model: FB.model, fallback: true } })).build()).find((n) => n.className.startsWith("mmodel"))!;
  assert.equal(fbTag.className, "mmodel fallback");
  assert.equal(fbTag.textContent, "fallback: vendor/cheap-model");
  // Pending: no label. Finishing updates the same node: the time button is kept, the label is added once.
  const node = head(reply({ status: "pending", text: "", source: undefined, provenance: undefined })).build();
  assert.equal(all(node).some((n) => n.className.startsWith("mmodel")), false);
  const time = node.childNodes[1];
  const fin = head(reply({ answeredBy: { model: "gpt-6.2-sol" } }));
  fin.update!(node);
  fin.update!(node);
  assert.equal(node.childNodes[1], time);
  assert.deepEqual(all(node).filter((n) => n.className.startsWith("mmodel")).map((n) => n.textContent), ["gpt-6.2-sol"]);
  // The model label is in the part's signature, so a change is seen by the reconciler.
  assert.notEqual(head(reply({ answeredBy: { model: "a" } })).sig, head(reply({ answeredBy: { model: "b" } })).sig);
});

test("session_read names the model on each assistant message it returns, and only the label", async () => {
  const { chatAdapter, sessionRegistry } = await import("../src/sessions.ts");
  const threads = threadStore(undefined);
  const registry = sessionRegistry({ adapters: [chatAdapter(threads)] });
  const t = threads.create("models");
  threads.appendUser(t.id, "first");
  const a = threads.beginAssistant(t.id);
  threads.patchMessage(t.id, a, { text: "primary answer", status: "done", answeredBy: { model: "gpt-6.2-sol" } });
  threads.appendUser(t.id, "second");
  const b = threads.beginAssistant(t.id);
  threads.patchMessage(t.id, b, { text: "fallback answer", status: "done", fallback: FB, answeredBy: { model: FB.model, fallback: true } });
  threads.appendUser(t.id, "third");
  const c = threads.beginAssistant(t.id);
  threads.patchMessage(t.id, c, { text: "older reply with no record", status: "done" });
  const page: any = registry.read({ isOwner: true }, `chat:${t.id}`, { from: "start" });
  assert.deepEqual(page.messages.map((m: { role: string; model?: string }) => [m.role, m.model ?? null]), [
    ["user", null], ["assistant", "gpt-6.2-sol"], ["user", null], ["assistant", "fallback: vendor/cheap-model"], ["user", null], ["assistant", null],
  ]);
  assert.doesNotMatch(JSON.stringify(page.messages), /usage_limit|costUsd|primaryLimit/);
});
