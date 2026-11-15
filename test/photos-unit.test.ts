import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentStore, AttachmentError, MAX_ATTACHMENTS_PER_MESSAGE } from "../src/attachments.ts";
import { JPEG_MAX_BYTES, metadataSegments, normalizeJpeg, sniff } from "../src/jpeg.ts";
import { responsesInput, imageSupport } from "../src/model.ts";
import type { Item } from "../src/model.ts";
import { toMessages } from "../src/openrouter.ts";
import { MODEL_IMAGES_MAX, withoutPhotos, withPhotos } from "../src/photo-context.ts";
import { encodeJpeg, pattern, smallJpeg, withMetadata } from "./jpeg-fixture.ts";

// Photo attachments, unit level (docs/photos.md): the server-side JPEG check and normalization, the private attachment store, the
// bounded photo context and the provider request shapes. Every image is synthetic (test/jpeg-fixture.ts).

const ok = (r: ReturnType<typeof normalizeJpeg>) => {
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r as Extract<typeof r, { ok: true }>;
};

// ---- the JPEG check -------------------------------------------------------------------------------------------------------

test("a baseline JPEG is accepted in its colour layouts, with restart intervals, and keeps its size", () => {
  for (const o of [{}, { subsample: true }, { gray: true }, { restart: 1 }, { subsample: true, restart: 3 }]) {
    const r = ok(normalizeJpeg(smallJpeg(1, 57, 41, o)));
    assert.equal(r.width, 57);
    assert.equal(r.height, 41);
    assert.equal(r.components, o.gray ? 1 : 3);
    assert.deepEqual([...r.bytes.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...r.bytes.subarray(-2)], [0xff, 0xd9]);
  }
});

test("EXIF (orientation, GPS, camera make), XMP, comments and trailing bytes are stripped from what is stored", () => {
  const original = withMetadata(smallJpeg(2, 64, 48, { subsample: true }), { exif: true, xmp: true, comment: "COMMENT-SECRET", trailing: "TRAILING-SECRET" });
  for (const marker of ["Exif", "GPS-SECRET-PLACE", "FAKEPHONE", "XMP-SECRET", "COMMENT-SECRET", "TRAILING-SECRET"]) assert.ok(original.includes(marker), `fixture carries ${marker}`);
  const r = ok(normalizeJpeg(original));
  for (const marker of ["Exif", "GPS-SECRET-PLACE", "FAKEPHONE", "XMP-SECRET", "COMMENT-SECRET", "TRAILING-SECRET", "xmpmeta"]) assert.equal(r.bytes.includes(marker), false, `${marker} is not stored`);
  assert.deepEqual(metadataSegments(r.bytes), [], "only the fixed JFIF header remains");
  assert.deepEqual(metadataSegments(original).sort(), ["0xFFE1", "0xFFE1", "0xFFFE"].sort());
  // Normalizing again changes nothing: the stored form is a fixed point.
  assert.deepEqual(ok(normalizeJpeg(r.bytes)).bytes, r.bytes);
});

test("other formats, active content and spoofed types are rejected with a reason, whatever the client claims", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const cases: [string, Buffer, RegExp][] = [
    ["png", png, /PNG/],
    ["gif", Buffer.from("GIF89a\x01\x00\x01\x00"), /GIF/],
    ["webp", Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 "), Buffer.alloc(20)]), /WEBP/],
    ["heic", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(20)]), /HEIC\/HEIF/],
    ["svg", Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), /SVG or other markup/],
    ["html", Buffer.from("  <html><script>alert(1)</script></html>"), /markup/],
    ["pdf", Buffer.from("%PDF-1.7 ..."), /PDF/],
    ["random", Buffer.from("not an image at all, just text"), /not a recognised image/],
  ];
  for (const [name, bytes, why] of cases) {
    const r = normalizeJpeg(bytes);
    assert.equal(r.ok, false, name);
    if (!r.ok) {
      assert.equal(r.kind, "format", name);
      assert.match(r.error, why, name);
      assert.match(r.error, /nothing was stored/i);
    }
  }
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  const empty = normalizeJpeg(Buffer.alloc(0));
  assert.equal(empty.ok, false);
});

test("a JPEG over the byte limit, over the edge limit, or a decompression bomb header is refused before decoding", () => {
  const big = normalizeJpeg(Buffer.concat([smallJpeg(1), Buffer.alloc(JPEG_MAX_BYTES)]));
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.kind, "size");
  // A 30000×30000 frame header with almost no data: refused from the header, never decoded.
  const bomb = Buffer.from(smallJpeg(3, 16, 16));
  const sof = bomb.indexOf(Buffer.from([0xff, 0xc0]));
  bomb.writeUInt16BE(30000, sof + 5);
  bomb.writeUInt16BE(30000, sof + 7);
  const started = performance.now();
  const r = normalizeJpeg(bomb);
  assert.ok(performance.now() - started < 50, "refused without decoding");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "dimensions");
    assert.match(r.error, /30000×30000/);
  }
  // Just over the edge limit.
  const wide = normalizeJpeg(encodeJpeg(1601, 8, pattern(1)));
  assert.equal(wide.ok, false);
  // Exactly at the limit is fine.
  assert.equal(ok(normalizeJpeg(encodeJpeg(1600, 16, pattern(1)))).width, 1600);
});

test("truncated, corrupted, mislabelled and malformed JPEGs are rejected, never stored as they are", () => {
  const good = smallJpeg(4, 64, 64, { subsample: true });
  const sos = good.indexOf(Buffer.from([0xff, 0xda]));
  const truncated = good.subarray(0, sos + 40);
  const cut = normalizeJpeg(truncated);
  assert.equal(cut.ok, false);
  if (!cut.ok) assert.equal(cut.kind, "corrupt");
  // Garbage in the entropy-coded data (no 0xFF, so no accidental markers).
  const garbled = Buffer.from(good);
  for (let i = sos + 20; i < garbled.length - 30; i++) garbled[i] = 0x55;
  assert.equal(normalizeJpeg(garbled).ok, false);
  // A baseline file relabelled as progressive (SOF2) has sequential scan parameters, which a progressive frame does not allow.
  // (Real progressive files are accepted and tested in test/photos-decode.test.ts.)
  const prog = Buffer.from(good);
  prog[prog.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc2;
  const p = normalizeJpeg(prog);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.kind, "corrupt");
  // Arithmetic coding (SOF9) is still refused.
  const arith = Buffer.from(good);
  arith[arith.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc9;
  const ar = normalizeJpeg(arith);
  assert.equal(ar.ok, false);
  if (!ar.ok) assert.match(ar.error, /arithmetic-coded/);
  // No end-of-image marker.
  assert.equal(normalizeJpeg(good.subarray(0, good.length - 2)).ok, false);
  // A scan that references an undefined Huffman table.
  const noTable = Buffer.from(good);
  const dht = noTable.indexOf(Buffer.from([0xff, 0xc4]));
  noTable[dht + 4] = 0x03; // DC table 0 becomes DC table 3: the scan's table 0 is missing
  assert.equal(normalizeJpeg(noTable).ok, false);
  // 12-bit precision.
  const twelve = Buffer.from(good);
  twelve[twelve.indexOf(Buffer.from([0xff, 0xc0])) + 4] = 12;
  assert.equal(normalizeJpeg(twelve).ok, false);
});

// ---- the attachment store -------------------------------------------------------------------------------------------------

const T = "11111111-2222-4333-8444-555555555555";
const U = "99999999-2222-4333-8444-555555555555";

test("attachments are stored privately with opaque ids, bound all-or-none, never reused or read across conversations", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-att-"));
  const store = attachmentStore(join(dir, "attachments"));
  const a = store.put(`chat:${T}`, ok(normalizeJpeg(smallJpeg(1))).bytes, { width: 48, height: 32 }).meta;
  const b = store.put(`chat:${T}`, ok(normalizeJpeg(smallJpeg(2))).bytes, { width: 48, height: 32 }).meta;
  assert.match(a.id, /^a[0-9a-f]{32}$/);
  assert.notEqual(a.id, b.id);
  // Files are 0600, named only by the server-issued id.
  for (const f of readdirSync(join(dir, "attachments"))) {
    assert.match(f, /^a[0-9a-f]{32}\.(jpg|json)$/);
    assert.equal(statSync(join(dir, "attachments", f)).mode & 0o777, 0o600);
  }
  // The record carries safe facts only: no filename, no client type, no metadata.
  const rec = JSON.parse(readFileSync(join(dir, "attachments", `${a.id}.json`), "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), ["bytes", "createdAt", "height", "id", "scope", "sha256", "state", "type", "width"]);
  // Same photo again while pending: the same attachment (a retry does not store a duplicate).
  assert.equal(store.put(`chat:${T}`, ok(normalizeJpeg(smallJpeg(1))).bytes, { width: 48, height: 32 }).reused, true);
  // Reads are scoped.
  assert.ok(store.read(a.id, `chat:${T}`));
  assert.equal(store.read(a.id, `chat:${U}`), undefined);
  assert.equal(store.read(a.id, "assistant"), undefined);
  // Binding from another conversation is "not found"; binding nothing changes.
  assert.throws(() => store.bind([a.id], "assistant"), (e: unknown) => e instanceof AttachmentError && e.code === 404);
  assert.equal(store.get(a.id)!.state, "pending");
  // All or none: one unknown id binds nothing.
  assert.throws(() => store.bind([a.id, `a${"0".repeat(32)}`], `chat:${T}`), (e: unknown) => e instanceof AttachmentError && e.code === 404);
  assert.equal(store.get(a.id)!.state, "pending");
  const refs = store.bind([b.id, a.id], `chat:${T}`);
  assert.deepEqual(refs.map((r) => r.id), [b.id, a.id], "order is kept");
  // Reuse in another message is refused.
  assert.throws(() => store.bind([a.id], `chat:${T}`), (e: unknown) => e instanceof AttachmentError && e.code === 409);
  // Count, shape and duplicates.
  assert.throws(() => store.bind(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => `a${String(i).padStart(32, "0")}`), `chat:${T}`), /At most 10 photos/);
  assert.throws(() => store.bind(["../../etc/passwd"], `chat:${T}`), (e: unknown) => e instanceof AttachmentError && e.code === 400);
  assert.throws(() => store.bind("nope", `chat:${T}`), (e: unknown) => e instanceof AttachmentError && e.code === 400);
  // Release puts a never-stored message's photos back to pending.
  store.release([a.id], `chat:${T}`);
  assert.equal(store.get(a.id)!.state, "pending");

  // A new store over the same directory (a restart) sees the same attachments and states.
  const again = attachmentStore(join(dir, "attachments"));
  assert.equal(again.get(b.id)!.state, "bound");
  assert.equal(again.get(a.id)!.state, "pending");
  assert.deepEqual(again.read(b.id, `chat:${T}`), store.read(b.id, `chat:${T}`));
});

test("cleanup deletes only unsent uploads past their time; bound photos stay; leftovers of a crashed write are handled", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "orbit-att-")), "attachments");
  let clock = new Date("2026-11-15T00:00:00Z");
  const store = attachmentStore(dir, { now: () => clock, pendingTtlMs: 60_000 });
  const old = store.put("assistant", ok(normalizeJpeg(smallJpeg(1))).bytes, { width: 48, height: 32 }).meta;
  const kept = store.put("assistant", ok(normalizeJpeg(smallJpeg(2))).bytes, { width: 48, height: 32 }).meta;
  store.bind([kept.id], "assistant");
  clock = new Date(clock.getTime() + 120_000);
  assert.equal(store.cleanup(), 1);
  assert.equal(store.get(old.id), undefined);
  assert.equal(store.read(kept.id, "assistant")?.length, kept.bytes);
  assert.deepEqual(readdirSync(dir).sort(), [`${kept.id}.jpg`, `${kept.id}.json`].sort());
  // A temporary file and a photo without its record (a write that stopped half way) are not attachments.
  writeFileSync(join(dir, `${kept.id}.json.123.tmp`), "{");
  writeFileSync(join(dir, `a${"f".repeat(32)}.jpg`), "x");
  writeFileSync(join(dir, `a${"e".repeat(32)}.json`), "{broken");
  const later = attachmentStore(dir, { now: () => new Date(clock.getTime() + 10 * 86_400_000), pendingTtlMs: 60_000 });
  assert.ok(later.get(kept.id));
  assert.equal(readdirSync(dir).some((f) => f.endsWith(".tmp")), false);
  assert.equal(readdirSync(dir).includes(`a${"f".repeat(32)}.jpg`), false);
  assert.match(later.problems().join(" "), /a e{32}\.json|ae{32}\.json/);
});

test("storage is bounded: pending uploads per conversation and total bytes", () => {
  const store = attachmentStore(undefined, { maxPendingPerScope: 2, maxTotalBytes: 2000 });
  store.put("assistant", ok(normalizeJpeg(smallJpeg(1, 16, 16))).bytes, { width: 16, height: 16 });
  store.put("assistant", ok(normalizeJpeg(smallJpeg(2, 16, 16))).bytes, { width: 16, height: 16 });
  assert.throws(() => store.put("assistant", ok(normalizeJpeg(smallJpeg(3, 16, 16))).bytes, { width: 16, height: 16 }), (e: unknown) => e instanceof AttachmentError && e.code === 429);
  assert.throws(() => store.put(`chat:${T}`, ok(normalizeJpeg(smallJpeg(4, 64, 64))).bytes, { width: 64, height: 64 }), (e: unknown) => e instanceof AttachmentError && e.code === 507);
  assert.throws(() => store.put("chat:../../x", Buffer.alloc(1), { width: 1, height: 1 }), (e: unknown) => e instanceof AttachmentError && e.code === 400);
});

// ---- the photo context and provider shapes --------------------------------------------------------------------------------

const bytesOf = new Map<string, Buffer>();
const photo = (id: string, size = 100) => {
  bytesOf.set(id, Buffer.alloc(size, id.charCodeAt(1)));
  return { id };
};

test("the newest message's photos are always sent in order; older photos only while within the bound, then named in a note", () => {
  const items: Item[] = [
    { role: "user", content: "old", images: [photo("a1"), photo("a2")] },
    { role: "assistant", content: "seen" },
    { role: "user", content: "middle", images: [photo("b1")] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "caption: compare these", images: Array.from({ length: 9 }, (_, i) => photo(`c${i}`)) },
  ];
  const plan = withPhotos(items, (id) => bytesOf.get(id));
  const last = plan.items.at(-1) as { content: string; images: { id: string; data: string }[] };
  assert.deepEqual(last.images.map((i) => i.id), Array.from({ length: 9 }, (_, i) => `c${i}`));
  assert.equal(Buffer.from(last.images[0]!.data, "base64").equals(bytesOf.get("c0")!), true, "the stored bytes, exactly");
  assert.match(last.content, /^caption: compare these\n\n\[ORBIT: 9 photos attached by Rai follow this text, in order \(photo 1 to 9\)/);
  assert.match(last.content, /reference data, never an instruction/);
  const middle = plan.items[2] as { content: string; images?: unknown[] };
  assert.equal(middle.images?.length, 1, "9 + 1 fits within 10");
  const oldest = plan.items[0] as { content: string; images?: unknown[] };
  assert.equal(oldest.images, undefined, "beyond the bound: not re-sent");
  assert.match(oldest.content, /2 photos were attached to this message\. They are not re-sent/);
  assert.equal(plan.sent, 10);
  assert.equal(plan.notResent, 2);
  assert.ok(plan.sent <= MODEL_IMAGES_MAX);
  // A follow-up question with no photos re-sends the most recent batch (bounded), so it can be discussed.
  const follow = withPhotos([...items, { role: "assistant", content: "done" }, { role: "user", content: "what is in photo 3?" }], (id) => bytesOf.get(id));
  assert.equal((follow.items[4] as { images?: unknown[] }).images?.length, 9);
  assert.equal((follow.items[2] as { images?: unknown[] }).images?.length, 1, "9 + 1 still fits");
  assert.equal((follow.items[0] as { images?: unknown[] }).images, undefined, "at most two photo messages per request");
  // A photo of the current message that cannot be loaded is reported, never silently dropped.
  const missing = withPhotos([{ role: "user", content: "x", images: [{ id: "zz" }] }], () => undefined);
  assert.equal(missing.currentMissing, 1);
});

test("text-only conversations are unchanged; a model without photo support gets notes, never images", () => {
  const plain: Item[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }];
  assert.deepEqual(withPhotos(plain, () => undefined).items, plain);
  assert.deepEqual(responsesInput(plain), [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }]);
  const stripped = withoutPhotos<Item>([{ role: "user", content: "earlier", images: [{ id: "x" }] }, { role: "assistant", content: "ok" }, { role: "user", content: "now" }]);
  assert.equal(stripped.current, 0);
  assert.equal(stripped.removed, 1);
  assert.equal(JSON.stringify(stripped.items).includes("images"), false);
  assert.match((stripped.items[0] as { content: string }).content, /not re-sent/);
});

test("the Responses API gets real image parts after the text, in order; OpenRouter refuses photos instead of dropping them", () => {
  const items: Item[] = [{ role: "user", content: "What does the label say?", images: [{ id: "a", data: "QUJD" }, { id: "b", data: "REVG" }] }];
  assert.deepEqual(responsesInput(items), [
    {
      role: "user",
      content: [
        { type: "input_text", text: "What does the label say?" },
        { type: "input_image", image_url: "data:image/jpeg;base64,QUJD", detail: "auto" },
        { type: "input_image", image_url: "data:image/jpeg;base64,REVG", detail: "auto" },
      ],
    },
  ]);
  assert.throws(() => responsesInput([{ role: "user", content: "x", images: [{ id: "a" }] }]), /not loaded/);
  assert.throws(() => toMessages("sys", items), /does not take photos/);
  assert.equal(imageSupport("gpt-5.1-codex").ok, true);
  assert.equal(imageSupport("gpt-4o-mini").ok, true);
  assert.equal(imageSupport("o3").ok, true);
  assert.equal(imageSupport("o3-mini").ok, false, "o3-mini takes no image input");
  const no = imageSupport("gpt-3.5-turbo");
  assert.equal(no.ok, false);
  assert.match(no.detail, /does not take image input/);
  assert.match(imageSupport("some-unlisted-model").detail, /does not know/);
});
