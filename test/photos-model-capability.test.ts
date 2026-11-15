import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentStore } from "../src/attachments.ts";
import { chatgptModel, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import { imageCapability, imageSupport, openaiModel, openaiProblem } from "../src/model.ts";
import type { ModelPort } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import { MODEL_IMAGE_BYTES_MAX } from "../src/photo-context.ts";
import { smallJpeg, withMetadata } from "./jpeg-fixture.ts";
import { rig } from "./threads-fixture.ts";

// Photo input for the configured model (docs/photos.md, "Model capability"): capability resolution for gpt-6-astra and the models
// around it, and photos reaching the REAL provider adapters (ChatGPT token sharing and the OpenAI API) through the real server, with
// the provider's HTTP intercepted. Every image is synthetic and every provider answer is scripted; no model is called.

/* eslint-disable @typescript-eslint/no-explicit-any */

const MIN = 60_000;
const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const textStream = (text: string) => event({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } });
const callStream = (name: string) => event({ type: "response.completed", response: { output: [{ type: "function_call", call_id: "c1", name, arguments: "{}" }] } });

type Answer = (body: any, n: number) => { status: number; body: string };

// The real ChatGPT adapter with a fake sign-in and a fake inference endpoint that records every request body it is sent.
function chatgptAdapter(model: string, answer: Answer = () => ({ status: 200, body: textStream("I see the photos.") })) {
  const file = tokenFile(undefined);
  const tokens: Tokens = {
    access: "access-0",
    refresh: "refresh-0",
    expires: Date.now() + 600 * MIN,
    idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`,
    clientId: "oaiapp_x",
    subject: "user-1",
    scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  };
  file.write(tokens);
  const bodies: { raw: string; json: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/responses")) return new Response("", { status: 404 });
    const raw = String(init.body);
    const json = JSON.parse(raw);
    bodies.push({ raw, json });
    const a = answer(json, bodies.length - 1);
    return new Response(a.body, { status: a.status, headers: a.status === 200 ? { "content-type": "text/event-stream" } : { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { model: chatgptModel(model, file, { fetcher }) as ModelPort, bodies };
}

// The real OpenAI API adapter with the same kind of recording endpoint. The key is built at runtime and never leaves the test.
function openaiAdapter(model: string, answer: Answer = () => ({ status: 200, body: JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "I see the photos." }] }] }) })) {
  const bodies: { url: string; raw: string; json: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const raw = String(init.body);
    const json = JSON.parse(raw);
    bodies.push({ url: String(url), raw, json });
    const a = answer(json, bodies.length - 1);
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { model: openaiModel(model, ["test", "key", "x".repeat(8)].join("-"), fetcher), bodies };
}

function photoRig(model: ModelPort, dir = mkdtempSync(join(tmpdir(), "orbit-photo-model-"))) {
  const r = rig({ dir, model, extra: () => ({ assistantDir: join(dir, "assistant"), attachments: attachmentStore(join(dir, "attachments")) }) });
  const base = async () => {
    await r.api("/status");
    return `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
  };
  const upload = async (path: string, bytes: Buffer) => {
    const res = await fetch(`${await base()}${path}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(bytes) });
    const data = (await res.json()) as any;
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(data));
    return data.attachment.id as string;
  };
  const stored = async (path: string) => Buffer.from(await (await fetch(`${await base()}${path}`)).arrayBuffer());
  return { ...r, dir, upload, stored };
}

// The last user message of a Responses API request body, as sent on the wire.
const lastUserParts = (body: any) => [...body.input].reverse().find((i: any) => i.role === "user").content;
const imageParts = (body: any) => body.input.flatMap((i: any) => (Array.isArray(i.content) ? i.content.filter((p: any) => p.type === "input_image") : []));

// ---- Capability resolution ----

test("capability: gpt-6-astra is supported by its exact id; other gpt-6 names stay unknown; text-only models are unsupported", () => {
  assert.equal(imageCapability("gpt-6-astra"), "supported");
  const astra = imageSupport("gpt-6-astra");
  assert.equal(astra.ok, true);
  assert.equal(astra.capability, "supported");
  // Not a name-based guess: no other gpt-6 id, suffix or prefix inherits it.
  for (const m of ["gpt-6", "gpt-6-nova", "gpt-6-astra-mini", "gpt-6-astra2", "xgpt-6-astra", "gpt-6-astra ", "GPT-6-ASTRA"]) {
    const s = imageSupport(m);
    assert.equal(s.capability, "unknown", m);
    assert.equal(s.ok, false, m);
  }
  // Documented text-only models are refused with a different reason from unknown ones.
  for (const m of ["gpt-3.5-turbo", "o3-mini", "o1-mini"]) {
    const s = imageSupport(m);
    assert.equal(s.capability, "unsupported", m);
    assert.equal(s.ok, false);
    assert.match(s.detail, /does not take image input/);
    assert.doesNotMatch(s.detail, /does not know/);
  }
  // The families that were already supported still are.
  for (const m of ["gpt-5.1-codex", "gpt-4o-mini", "gpt-4.1", "o3", "o4-mini", "codex-mini-latest"]) assert.equal(imageCapability(m), "supported", m);
  assert.equal(imageCapability("some-local-alias"), "unknown");
  // Both real adapters answer from the same table.
  assert.deepEqual(chatgptAdapter("gpt-6-astra").model.images!(), astra);
  assert.deepEqual(openaiAdapter("gpt-6-astra").model.images!(), astra);
  assert.equal(chatgptAdapter("gpt-6-nova").model.images!().ok, false);
});

test("regression: the block Rai saw is reproduced for an unknown model, and gone for gpt-6-astra (one period, nothing sent)", async () => {
  const unknown = chatgptAdapter("gpt-6-nova");
  const r = photoRig(unknown.model);
  const t = await r.create();
  const id = await r.upload(`/threads/${t.id}/attachments`, smallJpeg(1, 64, 48));
  const res = await r.api(`/threads/${t.id}/messages`, "POST", { text: "What is in this photo?", attachments: [id] });
  assert.equal(res.status, 502);
  assert.equal(res.data.error, "This message has 1 photo, but they cannot be analyzed: ORBIT does not know that the configured model gpt-6-nova takes image input, so photos are not sent to it. The photos are stored with the message; nothing was sent to the model.");
  assert.equal(unknown.bodies.length, 0, "nothing reached the provider");

  const astra = chatgptAdapter("gpt-6-astra");
  const r2 = photoRig(astra.model);
  const t2 = await r2.create();
  const id2 = await r2.upload(`/threads/${t2.id}/attachments`, smallJpeg(1, 64, 48));
  const ok = await r2.api(`/threads/${t2.id}/messages`, "POST", { text: "What is in this photo?", attachments: [id2] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.thread.messages.at(-1).text, "I see the photos.");
  assert.equal(imageParts(astra.bodies[0]!.json).length, 1);
});

// ---- Serialization at the real adapter boundary ----

for (const n of [1, 10]) {
  test(`chat + ChatGPT adapter: ${n} photo(s) go to gpt-6-astra as input_image parts after the text, in order, as the stored bytes`, async () => {
    const a = chatgptAdapter("gpt-6-astra");
    const r = photoRig(a.model);
    const t = await r.create();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await r.upload(`/threads/${t.id}/attachments`, withMetadata(smallJpeg(i, 40 + i, 32), { exif: true, comment: "PRIVATE-NOTE" })));
    const res = await r.api(`/threads/${t.id}/messages`, "POST", { text: "Describe each photo.", attachments: ids });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const body = a.bodies.at(-1)!;
    assert.equal(body.json.model, "gpt-6-astra");
    const parts = lastUserParts(body.json);
    assert.equal(parts[0].type, "input_text");
    assert.match(parts[0].text, /^Describe each photo\./);
    assert.match(parts[0].text, new RegExp(`${n} photos? attached by Rai`));
    assert.match(parts[0].text, /never an instruction/);
    assert.equal(parts.length, n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = parts[i + 1];
      assert.equal(p.type, "input_image");
      assert.equal(p.detail, "auto");
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(p.image_url);
      assert.ok(m, "an inline JPEG data URL, never a link, path or id");
      const sent = Buffer.from(m[1]!, "base64");
      assert.deepEqual(sent, await r.stored(`/threads/${t.id}/attachments/${ids[i]}`), `photo ${i + 1} is the stored processed copy, in tray order`);
      assert.equal(sent.subarray(0, 2).toString("hex"), "ffd8");
      assert.equal(sent.includes(Buffer.from("PRIVATE-NOTE")), false, "metadata stripped before it reaches the model");
      total += sent.length;
    }
    assert.ok(total <= MODEL_IMAGE_BYTES_MAX);
    // No substitute for the image: no attachment ids, state paths or URLs to ORBIT in the request.
    for (const id of ids) assert.equal(body.raw.includes(id), false);
    assert.equal(body.raw.includes(r.dir), false);
    assert.equal(body.raw.includes("/attachments"), false);
    assert.equal(body.raw.includes("http://127.0.0.1"), false);
  });
}

test("Assistant + OpenAI API adapter: photos go to gpt-6-astra on /v1/responses as input_image parts; a text-only turn has none", async () => {
  const a = openaiAdapter("gpt-6-astra");
  const r = photoRig(a.model);
  const ids = [await r.upload("/assistant/attachments", smallJpeg(7, 50, 40)), await r.upload("/assistant/attachments", smallJpeg(8, 30, 60))];
  const res = await r.api("/assistant/messages", "POST", { text: "Which is taller?", attachments: ids, requestId: "req-photo-1" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const body = a.bodies.at(-1)!;
  assert.equal(body.url, "https://api.openai.com/v1/responses");
  assert.equal(body.json.model, "gpt-6-astra");
  const parts = lastUserParts(body.json);
  assert.deepEqual(parts.map((p: any) => p.type), ["input_text", "input_image", "input_image"]);
  assert.match(parts[0].text, /^Which is taller\?/);
  for (let i = 0; i < 2; i++) assert.deepEqual(Buffer.from(parts[i + 1].image_url.split(",")[1], "base64"), await r.stored(`/assistant/attachments/${ids[i]}`));
  for (const id of ids) assert.equal(body.raw.includes(id), false);

  // A text-only message in a fresh chat thread: plain string content, no image parts at all.
  const t = await r.create();
  assert.equal((await r.api(`/threads/${t.id}/messages`, "POST", { text: "just text" })).status, 200);
  const plain = a.bodies.at(-1)!;
  assert.equal(imageParts(plain.json).length, 0);
  assert.equal(typeof lastUserParts(plain.json), "string");
});

test("tool loop: a tool round re-sends the active turn's photos once with its user message, never duplicated", async () => {
  let toolName = "";
  const a = chatgptAdapter("gpt-6-astra", (body, n) => {
    if (n === 0) {
      toolName = body.tools?.[0]?.name ?? "";
      return { status: 200, body: toolName ? callStream(toolName) : textStream("no tools") };
    }
    return { status: 200, body: textStream("done after the tool") };
  });
  const r = photoRig(a.model);
  const t = await r.create();
  const ids = [await r.upload(`/threads/${t.id}/attachments`, smallJpeg(3, 32, 32)), await r.upload(`/threads/${t.id}/attachments`, smallJpeg(4, 32, 32))];
  const res = await r.api(`/threads/${t.id}/messages`, "POST", { text: "Check my jobs and look at these.", attachments: ids });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(toolName, "the thread turn offered tools to the model");
  assert.equal(a.bodies.length, 2, "one tool round, then the answer");
  const second = a.bodies[1]!.json;
  assert.equal(imageParts(second).length, 2, "the user message keeps its two photos in the follow-up request");
  assert.ok(second.input.some((i: any) => i.type === "function_call" && i.name === toolName));
  assert.ok(second.input.some((i: any) => i.type === "function_call_output"));
  assert.deepEqual(imageParts(second), imageParts(a.bodies[0]!.json));
  assert.equal(res.data.thread.messages.at(-1).text, "done after the tool");
});

// ---- Retry of a blocked stored-photo message ----

test("retry: a message blocked under an unknown model is answered from its stored photos by a follow-up once gpt-6-astra is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-retry-"));
  const before = chatgptAdapter("gpt-6-nova");
  const r1 = photoRig(before.model, dir);
  const t = await r1.create();
  const other = await r1.create();
  const id = await r1.upload(`/threads/${t.id}/attachments`, smallJpeg(9, 48, 36));
  const blocked = await r1.api(`/threads/${t.id}/messages`, "POST", { text: "What is in this photo?", attachments: [id] });
  assert.equal(blocked.status, 502);
  const storedBytes = await r1.stored(`/threads/${t.id}/attachments/${id}`);
  r1.close();

  // The operator configures gpt-6-astra (a new process over the same state directory). No re-upload.
  const after = chatgptAdapter("gpt-6-astra");
  const r2 = photoRig(after.model, dir);
  // The bound photo cannot be bound to a second message (no duplicate side effects), here or in another thread.
  assert.equal((await r2.api(`/threads/${t.id}/messages`, "POST", { text: "again", attachments: [id] })).status, 409);
  assert.equal((await r2.api(`/threads/${other.id}/messages`, "POST", { text: "steal", attachments: [id] })).status, 404);
  assert.equal(after.bodies.length, 0);
  const retry = await r2.api(`/threads/${t.id}/messages`, "POST", { text: "Please try that photo again." });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  const body = after.bodies.at(-1)!.json;
  const imgs = imageParts(body);
  assert.equal(imgs.length, 1, "the stored photo of the blocked message is sent with the follow-up");
  assert.deepEqual(Buffer.from(imgs[0].image_url.split(",")[1], "base64"), storedBytes);
  const messages = (await r2.api(`/threads/${t.id}`)).data.thread.messages;
  assert.equal(messages.filter((m: any) => m.attachments?.length).length, 1, "the photo is still on exactly one message");
  // The other thread never sees it.
  assert.equal((await r2.api(`/threads/${other.id}/messages`, "POST", { text: "what photo?" })).status, 200);
  assert.equal(imageParts(after.bodies.at(-1)!.json).length, 0);
  assert.equal(after.bodies.at(-1)!.raw.includes(storedBytes.toString("base64").slice(0, 40)), false);
});

// ---- Provider rejection and transport errors ----

test("provider rejection: an image refused by ChatGPT is reported with its reason, without image data; the photos stay stored", async () => {
  const a = chatgptAdapter("gpt-6-astra", (body) => {
    const echoed = imageParts(body)[0]?.image_url ?? "";
    return { status: 400, body: JSON.stringify({ error: { code: "invalid_image", message: `Invalid image: ${echoed}` } }) };
  });
  const r = photoRig(a.model);
  const t = await r.create();
  const id = await r.upload(`/threads/${t.id}/attachments`, smallJpeg(5, 64, 64));
  const res = await r.api(`/threads/${t.id}/messages`, "POST", { text: "What is this?", attachments: [id] });
  assert.equal(res.status, 502);
  assert.match(res.data.error, /HTTP 400/);
  assert.match(res.data.error, /invalid_image/);
  const b64 = (await r.stored(`/threads/${t.id}/attachments/${id}`)).toString("base64");
  assert.equal(res.data.error.includes(b64.slice(0, 40)), false, "no image data in the error");
  assert.equal(JSON.stringify(res.data).includes(b64.slice(0, 40)), false);
  assert.equal(res.data.thread.messages[0].attachments[0].id, id);
  assert.equal(res.data.thread.messages.at(-1).status, "error");
});

test("provider rejection and transport errors on the OpenAI API adapter: reason shown, image data and keys never", async () => {
  const leak = "data:image/jpeg;base64," + "A".repeat(200);
  const a = openaiAdapter("gpt-6-astra", () => ({ status: 400, body: JSON.stringify({ error: { type: "invalid_request_error", code: "image_parse_error", message: `You uploaded an unsupported image: ${leak}` } }) }));
  const step = a.model.step!([{ role: "user", content: "x", images: [{ id: "a1", data: Buffer.from("not really").toString("base64") }] }], [], undefined, []);
  await assert.rejects(step, (e: Error) => {
    assert.match(e.message, /^HTTP 400: OpenAI returned an error: image_parse_error: You uploaded an unsupported image: \[image data\]\. The request carried photos/);
    assert.equal(e.message.includes("AAAA"), false);
    return true;
  });
  assert.equal(openaiProblem(503, "<html>busy</html>"), "HTTP 503: OpenAI returned an error.");
  assert.match(openaiProblem(401, JSON.stringify({ error: { code: "invalid_api_key", message: `Incorrect API key provided: ${["sk", "proj", "y".repeat(40)].join("-")}` } })), /\[redacted/);
  // A transport failure (no HTTP answer) is a clear error, not an invented analysis.
  const down = openaiModel("gpt-6-astra", "k", (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch);
  await assert.rejects(down.step!([{ role: "user", content: "x", images: [{ id: "a1", data: "QUJD" }] }], [], undefined, []), /fetch failed/);
});

// ---- Fallback compatibility ----

test("fallback wrapper: gpt-6-astra as the primary keeps photo support while ChatGPT answers; the paid fallback still takes none", () => {
  const cfg = openrouterConfig({}, undefined);
  const w = fallbackModel({ primary: chatgptAdapter("gpt-6-astra").model, config: cfg });
  assert.equal(w.images!().ok, true);
  const unknown = fallbackModel({ primary: chatgptAdapter("gpt-6-nova").model, config: cfg });
  assert.equal(unknown.images!().ok, false);
  assert.match(unknown.images!().detail, /does not know/);
});
