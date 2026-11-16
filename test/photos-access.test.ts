import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChat, TOOL_IMAGES_NOTE, toolImageMessage } from "../src/agent.ts";
import type { ChatTool, MediaGate } from "../src/agent.ts";
import { attachmentStore } from "../src/attachments.ts";
import { chatgptModel, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { instructions, openaiModel, responsesInput } from "../src/model.ts";
import type { ImageSupport, Item, ModelPort, Step } from "../src/model.ts";
import { toMessages } from "../src/openrouter.ts";
import { dayWindow, NOT_FOUND, PHOTO_LIST_OUTPUT_MAX, photoPolicy, photoRef, photoTools } from "../src/photo-access.ts";
import type { PhotoSources } from "../src/photo-access.ts";
import { MODEL_IMAGE_BYTES_MAX } from "../src/photo-context.ts";
import { smallJpeg } from "./jpeg-fixture.ts";
import { rig } from "./threads-fixture.ts";

// Earlier photos (docs/photos.md, "Earlier photos"): photos_list and photos_inspect, the policy behind them, and the tool-media transport
// that puts inspected photos into the next model request as real image input. Every image is synthetic, every provider answer is
// scripted at the adapter's HTTP boundary, and no model is called. These tests prove what ORBIT serializes, not what a model sees.

/* eslint-disable @typescript-eslint/no-explicit-any */

const MIN = 60_000;
const ZONE = "America/Los_Angeles";
const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const textStream = (text: string) => event({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } });
const callStream = (name: string, args: unknown, id: string) => event({ type: "response.completed", response: { output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] } });
const textJson = (text: string) => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
const callJson = (name: string, args: unknown, id: string) => JSON.stringify({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] });

// A scripted provider turn: what to answer for one request body (null: plain text).
type Script = (body: any) => { name: string; args: unknown } | { text: string } | { status: number; error: string };
const outputs = (body: any) => body.input.filter((i: any) => i.type === "function_call_output").map((i: any) => JSON.parse(i.output));
const lastOutput = (body: any) => outputs(body).at(-1);
const imageParts = (body: any) => body.input.flatMap((i: any) => (Array.isArray(i.content) ? i.content.filter((p: any) => p.type === "input_image") : []));
const dataOf = (part: any) => Buffer.from(String(part.image_url).replace(/^data:image\/jpeg;base64,/, ""), "base64");

function provider(kind: "chatgpt" | "openai", model: string, scripts: Script[]) {
  const bodies: any[] = [];
  const raws: string[] = [];
  let calls = 0;
  const reply = (body: any) => {
    const s = scripts.shift();
    const r = s ? s(body) : { text: "Done." };
    const id = `call_${++calls}`;
    if ("status" in r) return { status: r.status, body: JSON.stringify({ error: { code: "invalid_image", message: r.error } }) };
    if (kind === "chatgpt") return { status: 200, body: "text" in r ? textStream(r.text) : callStream(r.name, r.args, id) };
    return { status: 200, body: "text" in r ? textJson(r.text) : callJson(r.name, r.args, id) };
  };
  if (kind === "chatgpt") {
    const file = tokenFile(undefined);
    const tokens: Tokens = { access: "access-0", refresh: "refresh-0", expires: Date.now() + 600 * MIN, idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`, clientId: "oaiapp_x", subject: "user-1", scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access" };
    file.write(tokens);
    const fetcher = (async (url: string, init: RequestInit) => {
      if (!String(url).endsWith("/responses")) return new Response("", { status: 404 });
      const raw = String(init.body);
      raws.push(raw);
      const json = JSON.parse(raw);
      bodies.push(json);
      const a = reply(json);
      return new Response(a.body, { status: a.status, headers: a.status === 200 ? { "content-type": "text/event-stream" } : { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { model: chatgptModel(model, file, { fetcher }) as ModelPort, bodies, raws, scripts };
  }
  const fetcher = (async (_url: string, init: RequestInit) => {
    const raw = String(init.body);
    raws.push(raw);
    const json = JSON.parse(raw);
    bodies.push(json);
    const a = reply(json);
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { model: openaiModel(model, ["test", "key", "x".repeat(8)].join("-"), fetcher), bodies, raws, scripts };
}

// The real server with a controllable clock shared by the attachment store and the photo tools.
function photoRig(model: ModelPort, start: string) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-access-"));
  const clock = { t: Date.parse(start) };
  const now = () => new Date(clock.t);
  const attachments = attachmentStore(join(dir, "attachments"), { now });
  const r = rig({ dir, model, now, extra: () => ({ assistantDir: join(dir, "assistant"), attachments }) });
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
  return { ...r, dir, clock, attachments, upload, stored };
}

// Sends photos with a caption into a chat thread (the model answers that turn with plain text).
async function sendPhotos(r: ReturnType<typeof photoRig>, p: ReturnType<typeof provider>, threadId: string, caption: string, seeds: number[]) {
  const ids: string[] = [];
  for (const s of seeds) ids.push(await r.upload(`/threads/${threadId}/attachments`, smallJpeg(s, 40 + s, 30)));
  p.scripts.unshift(() => ({ text: "Got them." }));
  const res = await r.api(`/threads/${threadId}/messages`, "POST", { text: caption, attachments: ids });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const bytes = await Promise.all(ids.map((id) => r.stored(`/threads/${threadId}/attachments/${id}`)));
  return { ids, bytes, messageId: res.data.thread.messages.at(-2).id as string };
}

// Everything ORBIT wrote under its state directory, as one string (to check that no image data or base64 was persisted as text).
function stateText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!n.endsWith(".jpg")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
}

function captureLogs() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  return { lines, restore: () => void (console.log = orig) };
}

// ---- The full flow, through the real server and real adapters ----

for (const kind of ["chatgpt", "openai"] as const) {
  test(`full flow (${kind}): from the Assistant, list today's photos of chat thread A, inspect two, and they reach the next request as real image parts`, async () => {
    const p = provider(kind, "gpt-6-astra", []);
    // 2026-11-15 09:00 in Los Angeles (17:00 UTC).
    const r = photoRig(p.model, "2026-11-15T17:00:00Z");
    const a = await r.create("Market trip");
    const sent = await sendPhotos(r, p, a.id, "Photos from the market", [1, 2]);
    // An older photo from yesterday is not "today".
    r.clock.t = Date.parse("2026-11-16T01:00:00Z"); // 17:00 PT, still 2026-11-15
    const later = await sendPhotos(r, p, a.id, "One more", [3]);
    r.clock.t = Date.parse("2026-11-15T17:00:00Z") + 24 * 3600_000; // 2026-11-16 09:00 PT
    const logs = captureLogs();
    let listed: any;
    try {
      p.scripts.push(
        () => ({ name: "photos_list", args: { day: "yesterday" } }),
        (body) => {
          listed = lastOutput(body);
          const refs = listed.result.photos.map((x: any) => x.ref);
          // Select out of listing order: the second photo of the first message, then the later message's photo.
          return { name: "photos_inspect", args: { refs: [refs[2], refs[0]] } };
        },
        () => ({ text: "Yes: I can see two of them." }),
      );
      const res = await r.api("/assistant/messages", "POST", { text: "Can you see the images I uploaded yesterday?" });
      assert.equal(res.status, 200, JSON.stringify(res.data));
    } finally {
      logs.restore();
    }
    assert.equal(p.bodies.length, 2 + 3);
    const [first, second, third] = p.bodies.slice(2);
    // The first request of the turn carries no photo: nothing is loaded from history automatically.
    assert.equal(imageParts(first).length, 0);
    assert.ok(first.tools.some((t: any) => t.name === "photos_list") && first.tools.some((t: any) => t.name === "photos_inspect"));
    assert.match(first.instructions, /photos_list returns metadata only/);
    // The listing: newest first, all three photos of A, with source references, captions and the zone, and never bytes.
    assert.equal(imageParts(second).length, 0, "a listing supplies no image");
    const lr = listed.result;
    assert.equal(lr.timezone.zone, ZONE);
    assert.equal(lr.window.firstDay, "2026-11-15");
    assert.equal(lr.matches, 3);
    assert.deepEqual(lr.photos.map((x: any) => x.conversation.id), [`chat:${a.id}`, `chat:${a.id}`, `chat:${a.id}`]);
    assert.equal(lr.photos[0].caption.text, "One more");
    assert.equal(lr.photos[1].caption.text, "Photos from the market");
    assert.deepEqual(lr.photos.map((x: any) => x.message.photo), ["1 of 1", "1 of 2", "2 of 2"]);
    assert.equal(lr.photos[1].message.id, sent.messageId);
    assert.equal(lr.photos[0].ref, photoRef(later.ids[0]!));
    assert.match(lr.notice, /You have NOT seen these photos/);
    const listedText = JSON.stringify(listed);
    for (const id of [...sent.ids, ...later.ids]) assert.ok(!listedText.includes(id), "the listing never exposes attachment ids");
    assert.ok(!listedText.includes(r.dir), "no state path");
    // The inspection: the next request carries the two photos as image parts, in the order selected, each exactly the stored bytes.
    const parts = imageParts(third);
    assert.equal(parts.length, 2);
    assert.deepEqual(dataOf(parts[0]), sent.bytes[1]);
    assert.deepEqual(dataOf(parts[1]), later.bytes[0]);
    const carrier = third.input.at(-1);
    assert.equal(carrier.role, "user");
    assert.equal(carrier.content[0].type, "input_text");
    assert.equal(carrier.content[0].text, TOOL_IMAGES_NOTE(2));
    assert.match(carrier.content[1].text, new RegExp(`^\\[ORBIT photo 1 of 2: ref ${photoRef(sent.ids[1]!)}; from chat thread chat:${a.id}; message ${sent.messageId}, photo 2 of 2; sent 2026-11-15 09:00 PST`));
    assert.equal(carrier.content[2].type, "input_image");
    assert.match(carrier.content[3].text, /^\[ORBIT photo 2 of 2: ref /);
    // Roles are valid: function_call, its output, then the user message with the images.
    const kinds = third.input.slice(-3).map((i: any) => i.type ?? i.role);
    assert.deepEqual(kinds, ["function_call", "function_call_output", "user"]);
    const inspected = JSON.parse(third.input.at(-2).output).result;
    assert.deepEqual(inspected.supplied.map((x: any) => x.ref), [photoRef(sent.ids[1]!), photoRef(later.ids[0]!)]);
    // Nothing stored or logged carries image data or base64 of a photo; tool outputs are text.
    const state = stateText(r.dir);
    for (const b of [...sent.bytes, ...later.bytes]) {
      const b64 = b.toString("base64");
      assert.ok(!state.includes(b64.slice(0, 64)), "no base64 in stored state");
      assert.ok(!logs.lines.join("\n").includes(b64.slice(0, 64)), "no base64 in logs");
    }
    assert.ok(!logs.lines.join("\n").includes(r.dir), "no private path in logs");
    // The next turn starts with no image parts again (the photos were for that reply only).
    p.scripts.push(() => ({ text: "From what I saw then..." }));
    await r.api("/assistant/messages", "POST", { text: "Thanks" });
    assert.equal(imageParts(p.bodies.at(-1)).length, 0);
  });
}

test("chat entry point: a thread lists and inspects only its own earlier photos; another thread's photos are refused or not found", async () => {
  const p = provider("openai", "gpt-6-astra", []);
  const r = photoRig(p.model, "2026-11-15T20:00:00Z");
  const a = await r.create("A");
  const b = await r.create("B");
  const inA = await sendPhotos(r, p, a.id, "A's photo", [4]);
  const inB = await sendPhotos(r, p, b.id, "B's photo", [5]);
  let own: any;
  let refused: any;
  let forged: any;
  p.scripts.push(
    () => ({ name: "photos_list", args: {} }),
    (body) => ((own = lastOutput(body)), { name: "photos_list", args: { conversation: `chat:${a.id}` } }),
    (body) => ((refused = lastOutput(body)), { name: "photos_inspect", args: { refs: [photoRef(inA.ids[0]!), own.result.photos[0].ref] } }),
    (body) => ((forged = lastOutput(body)), { text: "ok" }),
  );
  const res = await r.api(`/threads/${b.id}/messages`, "POST", { text: "What did I send earlier?" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(own.result.matches, 1);
  assert.equal(own.result.photos[0].ref, photoRef(inB.ids[0]!));
  assert.match(own.result.policy, /only this thread's own photos/);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Refused: Chat thread: only this thread's own photos/);
  // A's ref answers exactly like a forged one; B's own photo is supplied.
  assert.equal(forged.result.notSupplied[0].status, "not-found");
  assert.equal(forged.result.notSupplied[0].reason, NOT_FOUND);
  assert.equal(forged.result.supplied.length, 1);
  // The tool-supplied image is B's own photo. (B's earlier photo message is also re-sent from B's own history by the existing
  // follow-up rule, src/photo-context.ts; A's photo is never in the request.)
  const carrier = p.bodies.at(-1).input.at(-1);
  const supplied = carrier.content.filter((x: any) => x.type === "input_image");
  assert.equal(supplied.length, 1);
  assert.deepEqual(dataOf(supplied[0]), inB.bytes[0]);
  assert.ok(imageParts(p.bodies.at(-1)).every((x: any) => !dataOf(x).equals(inA.bytes[0]!)));
  // The policy port: the tools are owner only; a non-owner gets no tools and cannot even reach the route.
  r.caller.who = "someone-else";
  const other = await r.api(`/threads/${b.id}/messages`, "POST", { text: "show photos" });
  assert.equal(other.status, 403);
});

test("follow-up without re-upload: a later reply re-inspects the same ref, re-authorized; a deleted file is then reported unavailable, never described", async () => {
  const p = provider("chatgpt", "gpt-6-astra", []);
  const r = photoRig(p.model, "2026-11-15T18:00:00Z");
  const a = await r.create("Receipts");
  const sent = await sendPhotos(r, p, a.id, "Receipt", [6, 7]);
  const ref0 = photoRef(sent.ids[0]!);
  const ref1 = photoRef(sent.ids[1]!);
  p.scripts.push(() => ({ name: "photos_inspect", args: { refs: [ref0] } }), () => ({ text: "first" }));
  await r.api("/assistant/messages", "POST", { text: "Look at the receipt" });
  assert.deepEqual(dataOf(imageParts(p.bodies.at(-1))[0]), sent.bytes[0]);
  // Follow-up: the stored transcript has the earlier tool output (text) but no image; the model reloads by ref.
  p.scripts.push(() => ({ name: "photos_inspect", args: { refs: [ref0, ref1] } }), () => ({ text: "second" }));
  await r.api("/assistant/messages", "POST", { text: "And compare it with the other one" });
  const followFirst = p.bodies.at(-2);
  assert.equal(imageParts(followFirst).length, 0, "nothing re-sent automatically");
  assert.deepEqual(imageParts(p.bodies.at(-1)).map(dataOf), [sent.bytes[0], sent.bytes[1]]);
  // The file disappears: a partial batch, with the missing one named and not sent.
  unlinkSync(join(r.dir, "attachments", `${sent.ids[0]}.jpg`));
  let out: any;
  p.scripts.push(() => ({ name: "photos_inspect", args: { refs: [ref0, ref1] } }), (body) => ((out = lastOutput(body)), { text: "third" }));
  await r.api("/assistant/messages", "POST", { text: "Again please" });
  assert.deepEqual(out.result.notSupplied.map((x: any) => [x.ref, x.status]), [[ref0, "unavailable"]]);
  assert.match(out.result.notSupplied[0].reason, /missing or unreadable.*Do not describe it/);
  assert.deepEqual(imageParts(p.bodies.at(-1)).map(dataOf), [sent.bytes[1]]);
});

test("unsupported or unknown model: photos_inspect is blocked locally and nothing is supplied; listing still works; provider errors are reported without image data", async () => {
  const p = provider("chatgpt", "gpt-6-nova", []);
  const r = photoRig(p.model, "2026-11-15T18:00:00Z");
  const a = await r.create("A");
  // The unknown model cannot take the photo turn itself, so the photo is sent while a supported model is configured: simulate by
  // storing it through a second rig sharing the state directory is not needed; bind it directly in the store instead.
  const { meta } = r.attachments.put(`chat:${a.id}`, smallJpeg(8, 40, 30), { width: 40, height: 30 });
  r.attachments.bind([meta.id], `chat:${a.id}`);
  r.threads.appendUser(a.id, "stored earlier", [{ id: meta.id, type: "image/jpeg", bytes: meta.bytes, width: 40, height: 30 }]);
  let listed: any;
  let blocked: any;
  p.scripts.push(
    () => ({ name: "photos_list", args: {} }),
    (body) => ((listed = lastOutput(body)), { name: "photos_inspect", args: { refs: [photoRef(meta.id)] } }),
    (body) => ((blocked = lastOutput(body)), { text: "I could not see it." }),
  );
  const res = await r.api("/assistant/messages", "POST", { text: "Can you see today's photo?" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(listed.result.matches, 1);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /^ORBIT blocked the photos locally, before any request: it does not know that the configured model gpt-6-nova takes image input/);
  assert.equal((blocked.error.match(/ORBIT blocked/g) ?? []).length, 1, "the local-block wording is never doubled");
  assert.equal(imageParts(p.bodies.at(-1)).length, 0);
  assert.ok(p.bodies.every((b) => !JSON.stringify(b).includes("input_image")));

  // A provider rejection after the images were supplied: the turn fails with the reason, no image data in the error.
  const q = provider("openai", "gpt-6-astra", []);
  const r2 = photoRig(q.model, "2026-11-15T18:00:00Z");
  const t2 = await r2.create("B");
  const s2 = await sendPhotos(r2, q, t2.id, "x", [9]);
  q.scripts.push(() => ({ name: "photos_inspect", args: { refs: [photoRef(s2.ids[0]!)] } }), () => ({ status: 400, error: "Invalid image data:image/jpeg;base64,QUJDRA==" }));
  const bad = await r2.api("/assistant/messages", "POST", { text: "look" });
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /HTTP 400: OpenAI returned an error: invalid_image: Invalid image \[image data\]/);
  assert.match(bad.data.error, /The request carried photos/);
  assert.ok(!bad.data.error.includes("base64"));
});

test("mixed new and retrieved photos share the ten-photo bound: 3 attached now + 8 requested gives 7 supplied, 1 over budget, in order", async () => {
  const p = provider("chatgpt", "gpt-6-astra", []);
  const r = photoRig(p.model, "2026-11-15T18:00:00Z");
  const a = await r.create("Album");
  const old = await sendPhotos(r, p, a.id, "album", [1, 2, 3, 4, 5, 6, 7, 8]);
  const now = [] as string[];
  for (const s of [11, 12, 13]) now.push(await r.upload("/assistant/attachments", smallJpeg(s, 30, 30)));
  let out: any;
  p.scripts.push(
    () => ({ name: "photos_inspect", args: { refs: old.ids.map(photoRef) } }),
    (body) => ((out = lastOutput(body)), { text: "done" }),
  );
  const res = await r.api("/assistant/messages", "POST", { text: "Compare these with the album", attachments: now });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(out.result.supplied.length, 7);
  assert.deepEqual(out.result.notSupplied.map((x: any) => [x.ref, x.status]), [[photoRef(old.ids[7]!), "over-budget"]]);
  const parts = imageParts(p.bodies.at(-1));
  assert.equal(parts.length, 10, "3 attached now + 7 retrieved");
  assert.deepEqual(parts.slice(3).map(dataOf), old.bytes.slice(0, 7));
});

// ---- Tool-level policy, time, paging and budgets (the tools called directly, with a scripted budget) ----

function fixture(start = "2026-11-15T18:00:00Z") {
  const clock = { t: Date.parse(start) };
  const now = () => new Date(clock.t);
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-tools-"));
  const att = attachmentStore(join(dir, "attachments"), { now });
  const chats = new Map<string, { title: string; archived: boolean; messages: { id: string; at: string; text: string; ids: string[] }[] }>();
  const assistantMsgs: { id: string; at: string; text: string; ids: string[] }[] = [];
  const sources: PhotoSources = { assistant: () => ({ messages: assistantMsgs, archivedChunks: 0 }), chat: (tid) => chats.get(tid) };
  let n = 0;
  const send = (scope: string, at: string, count = 1, text = "") => {
    clock.t = Date.parse(at);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const { meta } = att.put(scope, smallJpeg(++n, 32, 24), { width: 32, height: 24 });
      ids.push(meta.id);
    }
    att.bind(ids, scope);
    const msg = { id: `m${n}`, at, text, ids };
    if (scope === "assistant") assistantMsgs.push(msg);
    else {
      const tid = scope.slice(5);
      if (!chats.has(tid)) chats.set(tid, { title: `Thread ${tid.slice(0, 4)}`, archived: false, messages: [] });
      chats.get(tid)!.messages.push(msg);
    }
    return ids;
  };
  const gate = (o: { ok?: boolean; images?: number; bytes?: number; calls?: number } = {}) => {
    const supplied = new Set<string>();
    const g: MediaGate & { supplied: (r: string) => boolean; add: (r: string) => void } = {
      support: (): ImageSupport => (o.ok === false ? { ok: false, detail: "test: no photos" } : { ok: true, detail: "test" }),
      remaining: () => ({ images: o.images ?? 10, bytes: o.bytes ?? MODEL_IMAGE_BYTES_MAX, calls: o.calls ?? 3 }),
      supplied: (r) => supplied.has(r),
      add: (r) => void supplied.add(r),
    };
    return g;
  };
  const tools = (caller: string, opts: { isOwner?: boolean; zone?: string | null } = {}) => {
    const t = photoTools({ attachments: att, sources, caller, isOwner: opts.isOwner ?? true, now, zone: opts.zone === null ? undefined : (opts.zone ?? ZONE) });
    const by = (name: string) => t.find((x) => x.name === name)!;
    return {
      list: async (a: Record<string, unknown> = {}) => ((await by("photos_list").run(a)) as any).value,
      inspect: async (refs: unknown, g = gate()) => (await by("photos_inspect").run({ refs }, { signal: new AbortController().signal, media: g })) as any,
      raw: by,
    };
  };
  return { clock, att, chats, assistantMsgs, sources, send, gate, tools, dir };
}
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

test("time zone: today is the owner's configured day, midnight boundaries hold, and DST days are 25 and 23 hours", async () => {
  const f = fixture();
  // 2026-11-14 23:59 PT and 2026-11-15 00:01 PT (PST, UTC-8).
  const before = f.send(`chat:${T1}`, "2026-11-15T07:59:00Z");
  const after = f.send(`chat:${T1}`, "2026-11-15T08:01:00Z");
  f.clock.t = Date.parse("2026-11-15T09:00:00Z"); // 01:00 PT on the 15th, but 09:00 UTC
  const t = f.tools("assistant:assistant");
  const today = await t.list({ day: "today" });
  assert.deepEqual(today.photos.map((x: any) => x.ref), after.map(photoRef));
  assert.equal(today.window.startsAt, "2026-11-15T08:00:00.000Z");
  assert.equal(today.window.hours, 24);
  assert.equal(today.timezone.zone, ZONE);
  const yesterday = await t.list({ day: "yesterday" });
  assert.deepEqual(yesterday.photos.map((x: any) => x.ref), before.map(photoRef));
  // The server's UTC day would have been different: at 07:30 UTC on the 15th, it is still the 14th in Los Angeles.
  f.clock.t = Date.parse("2026-11-15T07:30:00Z");
  assert.equal((await t.list({})).window.firstDay, "2026-11-14");
  assert.match((await t.list({})).window.basis, /no day or range was given, so today was assumed/);
  // A zone Rai names wins, and is said.
  const utc = await t.list({ day: "2026-11-15", timezone: "UTC" });
  assert.equal(utc.timezone.source, "named in this call");
  assert.equal(utc.matches, 2, "in UTC both photos fall on 2026-11-15");
  // DST: 2026-11-01 (fall back) has 25 hours; 2026-03-08 (spring forward) has 23.
  assert.equal(dayWindow({ day: "2026-11-01" }, new Date(), ZONE).hours, 25);
  assert.equal(dayWindow({ day: "2026-03-08" }, new Date(), ZONE).hours, 23);
  assert.equal(dayWindow({ day: "2026-11-01" }, new Date(), ZONE).start, "2026-11-01T07:00:00.000Z");
  assert.equal(dayWindow({ day: "2026-11-01" }, new Date(), ZONE).end, "2026-11-02T08:00:00.000Z");
  const fall = f.send(`chat:${T1}`, "2026-11-02T07:30:00Z"); // 2026-11-01 23:30 PST, the 25th hour's day
  assert.deepEqual((await t.list({ day: "2026-11-01" })).photos.map((x: any) => x.ref), fall.map(photoRef));
  // No configured zone: ORBIT asks rather than using the server's clock zone.
  await assert.rejects(f.tools("assistant:assistant", { zone: null }).list({ day: "today" }), /will not guess what today means. Ask Rai/);
  await assert.rejects(t.list({ timezone: "Mars/Olympus" }), /IANA time zone/);
  await assert.rejects(t.list({ from: "2026-01-01", to: "2026-03-01" }), /at most 31/);
  await assert.rejects(t.list({ day: "2026-02-30" }), /day must be/);
});

test("paging: deterministic order, no duplicates or gaps, cursor bound to its query, output within the tool limit", async () => {
  const f = fixture();
  const all: string[] = [];
  for (let i = 0; i < 4; i++) all.push(...f.send(`chat:${T1}`, `2026-11-15T1${i}:00:00Z`, 3, `batch ${i}`));
  f.send("assistant", "2026-11-15T14:30:00Z", 1, "assistant batch");
  const t = f.tools("assistant:assistant");
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await t.list({ day: "2026-11-15", limit: 5, ...(cursor ? { cursor } : {}) });
    seen.push(...page.photos.map((x: any) => x.ref));
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(seen.length, 13);
  assert.equal(new Set(seen).size, 13);
  // Newest first; within a message, in sent order.
  const expectChat = [3, 2, 1, 0].flatMap((b) => all.slice(b * 3, b * 3 + 3)).map(photoRef);
  assert.deepEqual(seen.filter((r) => expectChat.includes(r)), expectChat);
  assert.equal(seen[0], seen.find((r) => !expectChat.includes(r)), "the 14:30 Assistant photo is the newest");
  const first = await t.list({ day: "2026-11-15", limit: 5 });
  await assert.rejects(t.list({ day: "2026-11-14", limit: 5, cursor: first.nextCursor }), /invalid-cursor/);
  await assert.rejects(t.list({ day: "2026-11-15", cursor: "garbage" }), /invalid-cursor/);
  // Only one conversation.
  assert.equal((await t.list({ day: "2026-11-15", conversation: "assistant:assistant" })).matches, 1);
  // Long captions: a full page still fits the tool-output limit (the page shrinks and its cursor continues).
  const g = fixture();
  for (let i = 0; i < 25; i++) g.send(`chat:${T2}`, `2026-11-15T10:${String(i).padStart(2, "0")}:00Z`, 1, "x".repeat(2000));
  const big = await g.tools("assistant:assistant").list({ day: "2026-11-15", limit: 25 });
  assert.ok(JSON.stringify(big).length <= PHOTO_LIST_OUTPUT_MAX);
  assert.ok(big.returned < 25 && big.returned > 5 && big.nextCursor);
  assert.equal(big.photos[0].caption.truncated, true);
});

test("inspect: 1 and 10 photos, 11 refused, duplicates dropped in order, already supplied, budgets by count and bytes, call limit", async () => {
  const f = fixture();
  const ids = f.send(`chat:${T1}`, "2026-11-15T18:00:00Z", 10, "ten");
  const refs = ids.map(photoRef);
  const t = f.tools("assistant:assistant");
  const one = await t.inspect([refs[4]]);
  assert.equal(one.media.images.length, 1);
  assert.deepEqual(one.media.images[0].bytes, f.att.read(ids[4]!, `chat:${T1}`));
  const ten = await t.inspect([...refs].reverse());
  assert.deepEqual(ten.media.images.map((i: any) => i.ref), [...refs].reverse());
  assert.equal(ten.value.supplied.length, 10);
  await assert.rejects(t.inspect([...refs, refs[0]]), /1 to 10/);
  const dup = await t.inspect([refs[1], refs[1], refs[0]]);
  assert.deepEqual(dup.media.images.map((i: any) => i.ref), [refs[1], refs[0]]);
  assert.equal(dup.value.duplicatesIgnored, 1);
  const g = f.gate();
  g.add(refs[0]!);
  const again = await t.inspect([refs[0], refs[2]], g);
  assert.deepEqual(again.value.notSupplied.map((x: any) => x.status), ["already-supplied"]);
  const byCount = await t.inspect(refs.slice(0, 4), f.gate({ images: 2 }));
  assert.deepEqual(byCount.value.notSupplied.map((x: any) => [x.ref, x.status]), [[refs[2], "over-budget"], [refs[3], "over-budget"]]);
  const size = f.att.get(ids[0]!)!.bytes + f.att.get(ids[1]!)!.bytes;
  const byBytes = await t.inspect(refs.slice(0, 3), f.gate({ bytes: size }));
  assert.equal(byBytes.value.supplied.length, 2);
  await assert.rejects(t.inspect([refs[0]], f.gate({ calls: 0 })), /limit of photos_inspect calls/);
  await assert.rejects(t.inspect([refs[0]], f.gate({ ok: false })), /^Error: ORBIT blocked the photos locally, before any request: test: no photos/);
  // No gate at all (a reply that cannot carry images): refused, nothing loaded.
  await assert.rejects(t.raw("photos_inspect").run({ refs: [refs[0]] }), /no image transport/);
  // Nothing in the text value is image data.
  assert.ok(!JSON.stringify(ten.value).includes(ten.media.images[0].bytes.toString("base64").slice(0, 40)));
});

test("authorization: forged, pending, cross-scope, revoked, deleted and corrupt photos; non-owner; the Assistant reaches every conversation, a thread only itself", async () => {
  const f = fixture();
  const a1 = f.send(`chat:${T1}`, "2026-11-15T18:00:00Z", 2, "t1");
  const a2 = f.send(`chat:${T2}`, "2026-11-15T18:01:00Z", 1, "t2");
  const as = f.send("assistant", "2026-11-15T18:02:00Z", 1, "assistant");
  const pending = f.att.put(`chat:${T1}`, smallJpeg(99, 20, 20), { width: 20, height: 20 }).meta.id;
  const assistantTools = f.tools("assistant:assistant");
  const t1Tools = f.tools(`chat:${T1}`);
  assert.equal((await assistantTools.list({})).matches, 4);
  assert.equal((await t1Tools.list({})).matches, 2);
  await assert.rejects(t1Tools.list({ conversation: `chat:${T2}` }), /Refused/);
  await assert.rejects(t1Tools.list({ conversation: "assistant:assistant" }), /Refused/);
  await assert.rejects(assistantTools.list({ conversation: "work:abc" }), /must be a session id/);
  await assert.rejects(assistantTools.list({ conversation: "chat:../../etc" }), /must be a session id/);
  // From thread 1, T2's and the Assistant's refs answer exactly like forged or pending ones.
  const r = await t1Tools.inspect([photoRef(a2[0]!), photoRef(as[0]!), "ph_" + "0".repeat(32), photoRef(pending), a1[0], "../../attachments/x.jpg", photoRef(a1[0]!)]);
  assert.deepEqual(r.value.notSupplied.map((x: any) => x.status), Array(6).fill("not-found"));
  assert.ok(r.value.notSupplied.every((x: any) => x.reason === NOT_FOUND && !("conversation" in x)));
  assert.equal(r.value.supplied.length, 1);
  // Revoked sources: the thread is gone, or its message no longer refers to the photo.
  f.chats.delete(T2);
  assert.equal((await assistantTools.inspect([photoRef(a2[0]!)])).value.notSupplied[0].status, "not-found");
  assert.equal((await assistantTools.list({})).matches, 3);
  f.chats.get(T1)!.messages[0]!.ids = [a1[1]!];
  assert.equal((await assistantTools.inspect([photoRef(a1[0]!)])).value.notSupplied[0].status, "not-found");
  // Archived threads are hidden unless asked for (and counted), still inspectable.
  f.chats.get(T1)!.archived = true;
  const hidden = await assistantTools.list({});
  assert.equal(hidden.archivedThreadPhotosHidden, 1);
  assert.equal((await assistantTools.list({ includeArchived: true })).photos.find((x: any) => x.conversation.id === `chat:${T1}`).conversation.archived, true);
  // Missing and corrupt files: authorized, so named as unavailable, never described.
  const file = join(f.dir, "attachments", `${a1[1]}.jpg`);
  const bytes = readFileSync(file);
  bytes[bytes.length - 3] ^= 0xff;
  writeFileSync(file, bytes);
  const corrupt = await assistantTools.inspect([photoRef(a1[1]!), photoRef(as[0]!)]);
  assert.equal(corrupt.value.notSupplied[0].status, "unavailable");
  assert.match(corrupt.value.notSupplied[0].reason, /integrity check/);
  assert.equal(corrupt.value.supplied.length, 1, "a partial batch still supplies the rest");
  unlinkSync(join(f.dir, "attachments", `${as[0]}.jpg`));
  const gone = await assistantTools.inspect([photoRef(as[0]!)]);
  assert.match(gone.value.notSupplied[0].reason, /missing or unreadable/);
  assert.equal(gone.media, undefined);
  assert.match(gone.value.delivery, /No photo was supplied/);
  // Non-owner and an unknown caller.
  await assert.rejects(f.tools("assistant:assistant", { isOwner: false }).list({}), /only the owner/);
  await assert.rejects(f.tools("assistant:assistant", { isOwner: false }).inspect([photoRef(as[0]!)]), /only the owner/);
  assert.equal(photoPolicy("work:x").may("assistant"), false);
  assert.equal(photoPolicy(`chat:${T1}`).may(`chat:${T2}`), false);
  assert.equal(photoPolicy("assistant:assistant").may(`chat:${T2}`), true);
});

// ---- The transport in runChat (scripted model, no adapter) ----

function scripted(steps: ((input: Item[]) => Step)[], support: ImageSupport = { ok: true, detail: "test" }) {
  const seen: Item[][] = [];
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "test", detail: "", verifiedAt: new Date().toISOString() }),
    images: () => support,
    reply: async () => ({ value: "", provenance: "live", source: "test" }),
    step: async (input) => {
      seen.push(structuredClone(input));
      const s = steps.shift();
      return s ? s(input) : { text: "end", calls: [] };
    },
  };
  return { model, seen };
}
const imgTool = (bytes: Buffer[], name = "img"): ChatTool => ({
  name,
  description: "test",
  parameters: { type: "object", properties: {} },
  readOnly: true,
  run: async () => ({ value: { n: bytes.length }, provenance: "live", source: "test", media: { images: bytes.map((b, i) => ({ ref: `ph_${String(i).padStart(32, "0")}`, label: `[label ${i}]`, bytes: b })) } }),
});
const plainTool: ChatTool = { name: "plain", description: "test", parameters: { type: "object", properties: {} }, readOnly: true, run: async () => ({ value: { fine: true }, provenance: "live", source: "test" }) };
const call = (name: string, id: string) => ({ text: "", calls: [{ call_id: id, name, arguments: "{}" }] });

test("runChat: tool images go into the next request after the round's outputs, stay for later rounds, and are never in outputs", async () => {
  const jpg = [smallJpeg(1), smallJpeg(2)];
  const s = scripted([() => ({ text: "", calls: [{ call_id: "a", name: "img", arguments: "{}" }, { call_id: "b", name: "plain", arguments: "{}" }] }), () => call("plain", "c"), () => ({ text: "answer", calls: [] })]);
  const stored: string[] = [];
  const out = await runChat({ model: s.model, messages: [{ role: "user", content: "q" }], limits: [], tools: [imgTool(jpg), plainTool], onCall: (c) => void stored.push(c.output), media: { support: () => s.model.images!(), images: 0, bytes: 0, maxImages: 10, maxBytes: MODEL_IMAGE_BYTES_MAX } });
  assert.equal(out.text, "answer");
  const second = s.seen[1]!;
  // Both outputs of the round, then one user message with the images.
  assert.deepEqual(second.slice(1).map((i: any) => i.type ?? i.role), ["function_call", "function_call_output", "function_call", "function_call_output", "user"]);
  const carrier = second.at(-1) as any;
  assert.equal(carrier.via, "tool");
  assert.deepEqual(carrier.images.map((i: any) => Buffer.from(i.data, "base64")), jpg);
  // The next tool call is preserved after the images, and the images are still there in the third request.
  assert.deepEqual(s.seen[2]!.slice(-3).map((i: any) => i.type ?? i.role), ["user", "function_call", "function_call_output"]);
  for (const o of stored) assert.ok(!o.includes(jpg[0]!.toString("base64").slice(0, 40)));
  // As the Responses API sees it: labels before each image.
  const wire = responsesInput([carrier]) as any[];
  assert.deepEqual(wire[0].content.map((p: any) => p.type), ["input_text", "input_text", "input_image", "input_text", "input_image"]);
  // The OpenRouter fallback never receives them silently.
  assert.throws(() => toMessages("sys", [carrier]), /does not take photos/);
});

test("runChat: images refused without a media budget, over the count or byte budget, when the model takes none, and for repeats", async () => {
  const jpg = smallJpeg(3);
  const run = async (media: any, tools = [imgTool([jpg])], steps = [() => call("img", "a")]) => {
    const s = scripted([...steps]);
    const outs: string[] = [];
    await runChat({ model: s.model, messages: [{ role: "user", content: "q" }], limits: [], tools, onCall: (c) => void outs.push(c.output), ...(media ? { media } : {}) });
    return { outs, last: s.seen.at(-1)! };
  };
  const base = { support: () => ({ ok: true, detail: "t" }), images: 0, bytes: 0, maxImages: 10, maxBytes: MODEL_IMAGE_BYTES_MAX };
  const none = await run(undefined);
  assert.match(none.outs[0]!, /cannot take tool-supplied images/);
  assert.ok(!none.last.some((i: any) => i.via === "tool"));
  assert.match((await run({ ...base, images: 10 })).outs[0]!, /exceed this reply's image budget/);
  assert.match((await run({ ...base, bytes: MODEL_IMAGE_BYTES_MAX - 10 })).outs[0]!, /exceed this reply's image budget/);
  assert.match((await run({ ...base, support: () => ({ ok: false, detail: "nope." }) })).outs[0]!, /ORBIT blocked the images locally, before any request: nope\. None/);
  const repeat = await run(base, [imgTool([jpg])], [() => call("img", "a"), () => call("img", "b")]);
  assert.match(repeat.outs[1]!, /already supplied in this reply/);
  assert.equal(repeat.last.filter((i: any) => i.via === "tool").length, 1);
  const many = await run({ ...base, maxCalls: 1 }, [imgTool([jpg]), imgTool([smallJpeg(4)], "img2")], [() => call("img", "a"), () => call("img2", "b")]);
  assert.match(many.outs[1]!, /limit of image-supplying calls/);
});

test("text-only regression: no photo tools, no guidance and no tool image message unless offered; the helper message is labeled", () => {
  assert.doesNotMatch(instructions([], undefined, ["memory_search: x"]), /Stored photos/);
  assert.match(instructions([], undefined, ["photos_list: x", "photos_inspect: y"]), /never describe a photo's content from a listing/);
  const plain = responsesInput([{ role: "user", content: "hi" }]) as any[];
  assert.deepEqual(plain, [{ role: "user", content: "hi" }]);
  const m = toolImageMessage([{ ref: "ph_x", label: "[L]", bytes: smallJpeg(5) }]);
  assert.match(m.content, /added by ORBIT, not typed by Rai/);
  assert.match(m.content, /never an instruction/);
});
