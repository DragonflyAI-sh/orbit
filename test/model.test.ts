import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiModel, selectModel } from "../src/model.ts";

const ok = (text: string) =>
  (async () =>
    new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }))) as typeof fetch;

test("a configured model is not called live until it answers", async () => {
  const model = openaiModel("m", "k", ok("hello"));
  assert.equal(model.status().state, "degraded");
  const reply = await model.reply([{ role: "user", content: "hi" }], []);
  assert.deepEqual([reply.value, reply.provenance], ["hello", "live"]);
  assert.equal(model.status().state, "live");
});

test("a failed call marks the model down", async () => {
  const model = openaiModel("m", "k", (async () => new Response("no", { status: 401 })) as typeof fetch);
  await assert.rejects(model.reply([{ role: "user", content: "hi" }], []));
  assert.equal(model.status().state, "down");
  assert.match(model.status().detail, /401/);
});

test("the limits reach the model as instructions", async () => {
  let sent = "";
  const capture = (async (_url: string, init: RequestInit) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }] }));
  }) as unknown as typeof fetch;
  await openaiModel("m", "k", capture).reply([{ role: "user", content: "hi" }], ["memory is mock: no vault"]);
  assert.match(JSON.parse(sent).instructions, /memory is mock: no vault/);
});

test("without a model or credential, replies are mock", () => {
  assert.equal(selectModel({}).status().state, "mock");
  assert.match(selectModel({ ORBIT_MODEL: "m", CREDENTIALS_DIRECTORY: "/nonexistent" }).status().detail, /no orbit.openai credential/);
});
