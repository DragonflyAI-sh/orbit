import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentStore } from "../src/attachments.ts";
import type { Attachments } from "../src/attachments.ts";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import { metadataSegments } from "../src/jpeg.ts";
import type { Item, Message, ModelPort, Step } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";
import { smallJpeg, withMetadata } from "./jpeg-fixture.ts";
import { OWNER, rig, say, scripted } from "./threads-fixture.ts";
import type { Script } from "./threads-fixture.ts";

// Photo attachments through the real server (buildServer, the real thread and Assistant stores, the real turn code), with a scripted
// model and a temporary state directory (docs/photos.md). Every image is synthetic; no provider is called.

/* eslint-disable @typescript-eslint/no-explicit-any */
const vision = (script: Script | Step[] = [say("seen")]) => Object.assign(scripted(script), { images: () => ({ ok: true, detail: "test model takes photos" }) });

function photoRig(opts: { model?: ModelPort; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "orbit-photos-"));
  let store: Attachments | undefined;
  const r = rig({ dir, model: opts.model ?? vision(), extra: () => ({ assistantDir: join(dir, "assistant"), attachments: (store = attachmentStore(join(dir, "attachments"))) }) });
  const base = async () => {
    await r.api("/status");
    return `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
  };
  const upload = async (path: string, bytes: Buffer, headers: Record<string, string> = {}) => {
    const res = await fetch(`${await base()}${path}`, { method: "POST", headers: { "content-type": "image/jpeg", ...headers }, body: new Uint8Array(bytes) });
    return { status: res.status, data: (await res.json()) as any };
  };
  const read = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${await base()}${path}`, { headers });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };
  return { ...r, dir, upload, read, store: () => store! };
}

const lastUser = (input: Item[]) => [...input].reverse().find((i): i is Message => "role" in i && i.role === "user")!;

test("chat: photos with a caption reach the model as processed bytes in order; the thread keeps references only", async () => {
  const r = photoRig();
  const t = await r.create("Photos");
  const originals = [0, 1, 2].map((i) => withMetadata(smallJpeg(i, 64 + i, 48), { exif: true, comment: "COMMENT-SECRET", trailing: "TRAIL" }));
  const ids: string[] = [];
  for (const o of originals) {
    const up = await r.upload(`/threads/${t.id}/attachments`, o);
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.match(up.data.attachment.id, /^a[0-9a-f]{32}$/);
    ids.push(up.data.attachment.id);
  }
  const sent = await r.api(`/threads/${t.id}/messages`, "POST", { text: "Which one is sharpest?", attachments: ids });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const user = sent.data.thread.messages[0];
  assert.deepEqual(user.attachments.map((a: any) => a.id), ids);
  assert.deepEqual(Object.keys(user.attachments[0]).sort(), ["bytes", "height", "id", "type", "width"]);
  // The model got the caption, the untrusted-data note and real image data: the stored, processed bytes, in order.
  const seen = lastUser((r.model as any).seen[0].input);
  assert.match(seen.content, /^Which one is sharpest\?/);
  assert.match(seen.content, /3 photos attached by Rai follow this text, in order/);
  assert.deepEqual(seen.images!.map((i) => i.id), ids);
  for (const [k, img] of seen.images!.entries()) {
    const stored = await r.read(`/threads/${t.id}/attachments/${ids[k]}`);
    assert.equal(stored.status, 200);
    assert.equal(stored.headers.get("content-type"), "image/jpeg");
    assert.equal(stored.headers.get("x-content-type-options"), "nosniff");
    assert.match(stored.headers.get("cache-control")!, /private/);
    assert.ok(Buffer.from(img.data!, "base64").equals(stored.bytes), "the model got exactly the stored bytes");
    assert.equal(stored.bytes.equals(originals[k]!), false, "never the original upload");
    for (const marker of ["Exif", "GPS-SECRET-PLACE", "COMMENT-SECRET", "TRAIL"]) assert.equal(stored.bytes.includes(marker), false);
    assert.deepEqual(metadataSegments(stored.bytes), []);
  }
  // Disk: the thread file holds no image data, and nothing outside <state>/attachments holds a photo.
  const threadFile = readFileSync(join(r.dir, "threads", `${t.id}.json`), "utf8");
  assert.equal(threadFile.includes(seen.images![0]!.data!.slice(0, 40)), false);
  assert.ok(threadFile.length < 20_000);
  assert.deepEqual(readdirSync(join(r.dir, "attachments")).filter((f) => f.endsWith(".jpg")).length, 3);
});

test("batches of 1 and 10 are accepted; 11 is refused by the server and nothing is stored", async () => {
  const r = photoRig();
  const t = await r.create();
  const up = async (seed: number) => (await r.upload(`/threads/${t.id}/attachments`, smallJpeg(seed, 24, 24))).data.attachment.id as string;
  const one = await r.api(`/threads/${t.id}/messages`, "POST", { attachments: [await up(100)] });
  assert.equal(one.status, 200, "photos without text are fine");
  assert.equal((r.model as any).seen.at(-1).input.at(-1).images.length, 1);
  const ten: string[] = [];
  for (let i = 0; i < 10; i++) ten.push(await up(i));
  const ok = await r.api(`/threads/${t.id}/messages`, "POST", { text: "ten", attachments: ten });
  assert.equal(ok.status, 200);
  assert.deepEqual(lastUser((r.model as any).seen.at(-1).input).images!.map((i) => i.id), ten);
  const eleven: string[] = [];
  for (let i = 20; i < 31; i++) eleven.push(await up(i));
  const before = (await r.api(`/threads/${t.id}`)).data.thread.messages.length;
  const refused = await r.api(`/threads/${t.id}/messages`, "POST", { text: "eleven", attachments: eleven });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /At most 10 photos/);
  assert.equal((await r.api(`/threads/${t.id}`)).data.thread.messages.length, before);
  // The eleven stay unsent (pending), so ten of them can still be sent.
  assert.equal((await r.api(`/threads/${t.id}/messages`, "POST", { text: "ten of them", attachments: eleven.slice(0, 10) })).status, 200);
});

test("only the owner can upload or read; cross-site uploads and cross-site reads are refused", async () => {
  const r = photoRig();
  const t = await r.create();
  const id = (await r.upload("/assistant/attachments", smallJpeg(1))).data.attachment.id;
  assert.equal((await r.upload("/assistant/attachments", smallJpeg(2), { origin: "https://evil.example" })).status, 403);
  assert.equal((await r.upload("/assistant/attachments", smallJpeg(2), { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await r.read(`/assistant/attachments/${id}`, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await r.read(`/assistant/attachments/${id}`, { "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await r.read(`/assistant/attachments/${id}`, { "sec-fetch-site": "same-origin" })).status, 200);
  r.caller.who = "someone@example.com";
  assert.equal((await r.upload("/assistant/attachments", smallJpeg(3))).status, 403);
  assert.equal((await r.upload(`/threads/${t.id}/attachments`, smallJpeg(3))).status, 403);
  assert.equal((await r.read(`/assistant/attachments/${id}`)).status, 403);
  r.caller.who = undefined;
  assert.equal((await r.read(`/assistant/attachments/${id}`)).status, 403);
  r.caller.who = OWNER;
  assert.equal(r.store().stats().count, 1);
});

test("photo ids cannot be reused or carried into another conversation, for sending or reading", async () => {
  const r = photoRig();
  const a = await r.create("A");
  const b = await r.create("B");
  const inA = (await r.upload(`/threads/${a.id}/attachments`, smallJpeg(1))).data.attachment.id;
  const inAssistant = (await r.upload("/assistant/attachments", smallJpeg(2))).data.attachment.id;
  // Another thread, or the Assistant, cannot send or read thread A's photo; the Assistant's photo is not readable from a thread.
  assert.equal((await r.api(`/threads/${b.id}/messages`, "POST", { text: "steal", attachments: [inA] })).status, 404);
  assert.equal((await r.api("/assistant/messages", "POST", { text: "steal", attachments: [inA] })).status, 404);
  assert.equal((await r.api(`/threads/${a.id}/messages`, "POST", { text: "steal", attachments: [inAssistant] })).status, 404);
  assert.equal((await r.read(`/threads/${b.id}/attachments/${inA}`)).status, 404);
  assert.equal((await r.read(`/assistant/attachments/${inA}`)).status, 404);
  assert.equal((await r.read(`/threads/${a.id}/attachments/${inAssistant}`)).status, 404);
  assert.equal((await r.read(`/threads/${a.id}/attachments/..%2F..%2Fthreads`)).status, 404);
  // Nothing was stored by the refused sends.
  assert.equal((await r.api(`/threads/${b.id}`)).data.thread.messages.length, 0);
  // Sent once in A; sending the same id again is refused.
  assert.equal((await r.api(`/threads/${a.id}/messages`, "POST", { text: "first", attachments: [inA] })).status, 200);
  const again = await r.api(`/threads/${a.id}/messages`, "POST", { text: "again", attachments: [inA] });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already sent/);
  assert.equal((await r.api("/assistant/messages", "POST", { text: "bad", attachments: ["../../etc/passwd"] })).status, 400);
});

test("spoofed types, active content, oversized, malformed and bomb uploads are refused and nothing is stored", async () => {
  const r = photoRig();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64)]);
  for (const [bytes, code] of [[png, 415], [svg, 415], [heic, 415]] as const) {
    const res = await r.upload("/assistant/attachments", bytes, { "content-type": "image/jpeg" });
    assert.equal(res.status, code);
  }
  const good = smallJpeg(3, 64, 64);
  const truncated = good.subarray(0, good.length - 60);
  assert.equal((await r.upload("/assistant/attachments", truncated)).status, 422);
  const bomb = Buffer.from(good);
  const sof = bomb.indexOf(Buffer.from([0xff, 0xc0]));
  bomb.writeUInt16BE(40000, sof + 5);
  bomb.writeUInt16BE(40000, sof + 7);
  assert.equal((await r.upload("/assistant/attachments", bomb)).status, 422);
  const huge = Buffer.concat([good, Buffer.alloc(1_100_000)]);
  const big = await r.upload("/assistant/attachments", huge);
  assert.equal(big.status, 413);
  assert.equal((await r.upload("/assistant/attachments", Buffer.alloc(0))).status, 415);
  assert.equal(r.store().stats().count, 0);
  // A real JPEG labelled as PNG is judged by its bytes.
  assert.equal((await r.upload("/assistant/attachments", good, { "content-type": "image/png" })).status, 201);
});

test("a model that takes no photos refuses the turn explicitly; the photos stay stored and nothing reaches the model", async () => {
  const model = scripted([say("should not be called")]);
  const r = photoRig({ model });
  const t = await r.create();
  const id = (await r.upload(`/threads/${t.id}/attachments`, smallJpeg(1))).data.attachment.id;
  const res = await r.api(`/threads/${t.id}/messages`, "POST", { text: "what is this?", attachments: [id] });
  assert.equal(res.status, 502);
  assert.match(res.data.error, /1 photo, but they cannot be analyzed: the connected model does not take photos/);
  assert.equal(model.seen.length, 0);
  const [user, reply] = res.data.thread.messages;
  assert.equal(user.attachments[0].id, id);
  assert.equal(reply.status, "error");
  // A later text-only message still works; the earlier photo is named in a note, not sent.
  const next = await r.api(`/threads/${t.id}/messages`, "POST", { text: "ok, just text then" });
  assert.equal(next.status, 200);
  const input = model.seen[0]!.input;
  assert.equal(JSON.stringify(input).includes('"images"'), false);
  assert.match(JSON.stringify(input), /not re-sent/);
  assert.match(next.data.thread.messages.at(-1).incomplete.join(" "), /without seeing 1 earlier photo/);
});

test("text-only messages are unchanged in chat threads and the Assistant", async () => {
  const r = photoRig();
  const t = await r.create();
  assert.equal((await r.api(`/threads/${t.id}/messages`, "POST", { text: "plain" })).status, 200);
  assert.equal((await r.api("/assistant/messages", "POST", { text: "plain assistant" })).status, 200);
  for (const s of (r.model as any).seen) {
    for (const it of s.input) assert.equal("images" in it, false);
    assert.deepEqual(lastUser(s.input), { role: "user", content: s === (r.model as any).seen[0] ? "plain" : "plain assistant" });
  }
  assert.equal((await r.api(`/threads/${t.id}/messages`, "POST", { text: "" })).status, 400);
  assert.equal((await r.api("/assistant/messages", "POST", { text: "  " })).status, 400);
});

test("the Assistant takes photos too, and its photos never reach a chat thread's model input (or the reverse)", async () => {
  const r = photoRig();
  const t = await r.create();
  const aid = (await r.upload("/assistant/attachments", smallJpeg(7))).data.attachment.id;
  const sent = await r.api("/assistant/messages", "POST", { text: "assistant photo", attachments: [aid], requestId: "req-photo-0001" });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const chunk = sent.data.assistant.chunks.at(-1);
  assert.equal(chunk.messages[0].attachments[0].id, aid);
  assert.deepEqual(lastUser((r.model as any).seen.at(-1).input).images!.map((i) => i.id), [aid]);
  const cid = (await r.upload(`/threads/${t.id}/attachments`, smallJpeg(8))).data.attachment.id;
  await r.api(`/threads/${t.id}/messages`, "POST", { text: "chat photo", attachments: [cid] });
  const chatInput = JSON.stringify((r.model as any).seen.at(-1).input);
  assert.equal(chatInput.includes(aid), false, "the chat turn never carries the Assistant's photo");
  await r.api("/assistant/messages", "POST", { text: "follow-up", requestId: "req-photo-0002" });
  const asstInput = JSON.stringify((r.model as any).seen.at(-1).input);
  assert.equal(asstInput.includes(cid), false, "the Assistant turn never carries the chat photo");
  assert.ok(asstInput.includes(aid), "the Assistant's own earlier photo is re-sent for a follow-up (bounded)");
  // session_read and the digest see a photo count at most, never ids or bytes (src/threads.ts transcriptMessage).
  const { transcriptMessage } = await import("../src/threads.ts");
  const tm = transcriptMessage(chunk.messages[0]);
  assert.equal(tm.photos, 1);
  assert.equal(JSON.stringify(tm).includes(aid), false);
});

test("a refused send (busy) releases its photos so they can be sent again", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((res) => (release = res));
  const model = vision(async (seen) => {
    if (lastUser(seen.input).content.includes("HOLD")) await held;
    return say("done");
  });
  const r = photoRig({ model });
  const t = await r.create();
  const id = (await r.upload(`/threads/${t.id}/attachments`, smallJpeg(1))).data.attachment.id;
  const first = r.api(`/threads/${t.id}/messages`, "POST", { text: "HOLD" });
  await new Promise((res) => setTimeout(res, 50));
  const busy = await r.api(`/threads/${t.id}/messages`, "POST", { text: "with photo", attachments: [id] });
  assert.equal(busy.status, 409);
  assert.equal(r.store().get(id)!.state, "pending");
  release();
  await first;
  assert.equal((await r.api(`/threads/${t.id}/messages`, "POST", { text: "with photo", attachments: [id] })).status, 200);
});

// ---- the paid fallback --------------------------------------------------------------------------------------------------

const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
const fallbackWorld = () => {
  const cfg = openrouterConfig({ ORBIT_OPENROUTER_ENABLED: "1", ORBIT_OPENROUTER_MODEL: "vendor/cheap-model", ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2", ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4", ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048", CREDENTIALS_DIRECTORY: "/creds" }, () => KEY) as Extract<OpenRouterConfig, { state: "ready" }>;
  assert.equal(cfg.state, "ready");
  const requests: any[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fallback text" } }], usage: { cost: 0.0001 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const ledger = provisioned(mkdtempSync(join(tmpdir(), "orbit-spend-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const primary: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-5", detail: "x", verifiedAt: new Date().toISOString() }),
    images: () => ({ ok: true, detail: "primary takes photos" }),
    step: async () => {
      throw new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.");
    },
    reply: async () => ({ value: "x", provenance: "live", source: "model/x" }),
  };
  return { model: fallbackModel({ primary, config: cfg, ledger, fetcher }), requests };
};

test("fallback: photos on the new message are refused (not dropped); earlier photos are named, and the owner is told", async () => {
  const w = fallbackWorld();
  const photo = { id: "a1", data: Buffer.from("jpeg").toString("base64") };
  await assert.rejects(w.model.step!([{ role: "user", content: "what is this", images: [photo] }], [], undefined, [], { fallback: true }), (e: unknown) => e instanceof ProviderError && /not given photos/.test(e.message));
  assert.equal(w.requests.length, 0, "nothing was sent to OpenRouter");
  // The limit is now known: images() says photos cannot be analyzed until it ends.
  assert.equal(w.model.images!().ok, false);
  assert.match(w.model.images!().detail, /OpenRouter fallback, which is not given photos/);
  const step = await w.model.step!([{ role: "user", content: "earlier", images: [photo] }, { role: "assistant", content: "ok" }, { role: "user", content: "text only now" }], [], undefined, [], { fallback: true });
  assert.equal(step.text, "fallback text");
  assert.match(step.incomplete!.join(" "), /without seeing 1 earlier photo/);
  const sent = JSON.stringify(w.requests[0]);
  assert.equal(sent.includes(photo.data), false, "no image data went to the fallback");
  assert.match(sent, /not re-sent/);
});

test("fallback through the server: a photo turn while ChatGPT is limited fails with the reason; the photos stay stored", async () => {
  const w = fallbackWorld();
  // Prime the limit so the server sees images() refuse before any call.
  await w.model.step!([{ role: "user", content: "hi" }], [], undefined, [], { fallback: true });
  const r = photoRig({ model: w.model });
  const t = await r.create();
  const id = (await r.upload(`/threads/${t.id}/attachments`, smallJpeg(1))).data.attachment.id;
  const res = await r.api(`/threads/${t.id}/messages`, "POST", { text: "look", attachments: [id] });
  assert.equal(res.status, 502);
  assert.match(res.data.error, /cannot be analyzed: ChatGPT usage limit/);
  assert.equal(res.data.thread.messages[0].attachments[0].id, id);
  assert.equal(w.requests.length, 1, "only the priming text call reached OpenRouter");
});
