import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentStore } from "../src/attachments.ts";
import type { Attachments } from "../src/attachments.ts";
import { metadataSegments, normalizeJpeg, sniff } from "../src/jpeg.ts";
import type { Item, Message } from "../src/model.ts";
import { layoutOf, relayout, smallJpeg, withMetadata, withoutSegments } from "./jpeg-fixture.ts";
import { rig, say, scripted } from "./threads-fixture.ts";

// Regression for "Failed: The photo could not be decoded: a quantization table is missing" (docs/photos.md, "JPEG layouts").
// The server's JPEG check required every quantization table (DQT) to come before the frame header (SOF). ITU T.81 only requires a
// table to be in place before the first scan that uses it (B.2.2, Tqi), and encoders do write DQT after SOF; libjpeg and browsers
// decode such files. The check now looks for the tables at each scan and stores them ahead of the frame header. Progressive
// Huffman JPEGs are now decoded and accepted too. Every image here is synthetic: either test/jpeg-fixture.ts output or the small
// real-encoder files in test/fixtures/photos (README there says how they were made).

/* eslint-disable @typescript-eslint/no-explicit-any */
const FIX = new URL("./fixtures/photos/", import.meta.url);
const real = (name: string) => readFileSync(new URL(name, FIX));
const REAL = ["im-baseline-420.jpg", "im-progressive-420.jpg", "im-progressive-444.jpg", "im-progressive-gray.jpg", "ffmpeg-baseline-420.jpg"];

const ok = (r: ReturnType<typeof normalizeJpeg>) => {
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r as Extract<typeof r, { ok: true }>;
};
const refused = (r: ReturnType<typeof normalizeJpeg>, kind: string, why: RegExp) => {
  assert.equal(r.ok, false, "refused");
  if (!r.ok) {
    assert.equal(r.kind, kind);
    assert.match(r.error, why);
    assert.match(r.error, /nothing was stored/i);
  }
};
const DQT = 0xdb;
const DHT = 0xc4;
const SOF0 = 0xc0;

test("real encoder JPEGs (libjpeg baseline and progressive, FFmpeg) are accepted, stay metadata-free and are a fixed point", () => {
  for (const name of REAL) {
    const input = real(name);
    assert.equal(sniff(input), "jpeg", name);
    const r = ok(normalizeJpeg(input));
    assert.deepEqual([r.width, r.height], [160, 120], name);
    assert.equal(r.components, name.includes("gray") ? 1 : 3, name);
    assert.deepEqual(metadataSegments(r.bytes), [], name);
    assert.deepEqual(ok(normalizeJpeg(r.bytes)).bytes, r.bytes, `${name}: normalizing again changes nothing`);
    // Every scan byte is kept: the stored copy differs from the input only in its header segments.
    assert.ok(r.bytes.includes(input.subarray(input.indexOf(Buffer.from([0xff, 0xda])))), `${name}: scans kept byte for byte`);
  }
});

test("DQT after the frame header (allowed by T.81) is accepted and stored with the tables ahead of the frame header", () => {
  for (const input of [...REAL.map(real), smallJpeg(1, 57, 41, { subsample: true }), smallJpeg(2, 40, 24, { gray: true }), smallJpeg(3, 64, 48, { restart: 2 })]) {
    const moved = relayout(input, { dqtAfterSof: true });
    const sofAt = layoutOf(moved).findIndex((m) => m >= 0xc0 && m <= 0xc2);
    assert.ok(layoutOf(moved).slice(sofAt + 1).includes(DQT), "the fixture really has DQT after SOF");
    const r = ok(normalizeJpeg(moved));
    // Stored layout: tables first, as libjpeg writes them; the result equals normalizing the conventional layout.
    const stored = layoutOf(r.bytes);
    assert.ok(stored.lastIndexOf(DQT) < stored.findIndex((m) => m >= 0xc0 && m <= 0xc2), `DQT hoisted: ${stored.map((m) => m.toString(16))}`);
    assert.deepEqual(ok(normalizeJpeg(r.bytes)).bytes, r.bytes);
    // Same tables, same scans, same image as the original layout.
    const conventional = ok(normalizeJpeg(input));
    assert.equal(r.bytes.length, conventional.bytes.length);
    assert.deepEqual([r.width, r.height, r.components], [conventional.width, conventional.height, conventional.components]);
  }
});

test("several tables per DQT/DHT segment, and DHT before SOF, are accepted (including with DQT after SOF)", () => {
  for (const name of REAL) {
    for (const o of [{ merge: true }, { merge: true, dqtAfterSof: true }]) {
      const v = relayout(real(name), o);
      assert.equal(layoutOf(v).filter((m) => m === DQT).length, 1, `${name}: one DQT segment`);
      ok(normalizeJpeg(v));
    }
  }
});

test("quantization or Huffman tables that are truly missing or corrupt are still refused, with the reason", () => {
  for (const input of [real("im-baseline-420.jpg"), real("im-progressive-420.jpg"), smallJpeg(4, 64, 64, { subsample: true })]) {
    refused(normalizeJpeg(withoutSegments(input, DQT)), "corrupt", /a quantization table is missing/);
    refused(normalizeJpeg(withoutSegments(input, DHT)), "corrupt", /Huffman table that is not defined/);
    // A table defined only for luma (the chroma table id is never defined).
    const lumaOnly = Buffer.from(relayout(input, { merge: true }));
    const at = lumaOnly.indexOf(Buffer.from([0xff, DQT]));
    const len = lumaOnly.readUInt16BE(at + 2);
    if (len > 2 + 65) {
      const cut = Buffer.concat([lumaOnly.subarray(0, at), Buffer.from([0xff, DQT, 0, 67]), lumaOnly.subarray(at + 4, at + 4 + 65), lumaOnly.subarray(at + 2 + len)]);
      refused(normalizeJpeg(cut), "corrupt", /a quantization table is missing/);
    }
    // A DQT segment whose table is cut short, and a 16-bit table.
    const short = Buffer.from(input);
    const q = short.indexOf(Buffer.from([0xff, DQT]));
    short.writeUInt16BE(40, q + 2);
    assert.equal(normalizeJpeg(short).ok, false);
    const wide = Buffer.from(input);
    wide[wide.indexOf(Buffer.from([0xff, DQT])) + 4] |= 0x10;
    refused(normalizeJpeg(wide), "corrupt", /8-bit quantization/);
  }
  // A table defined only after the scan that needed it does not count.
  const late = smallJpeg(5, 32, 32);
  const { segs } = (() => {
    const s: Buffer[] = [];
    let p = 2;
    while (late[p] === 0xff && late[p + 1] !== 0xda) { const l = late.readUInt16BE(p + 2); s.push(late.subarray(p, p + 2 + l)); p += 2 + l; }
    return { segs: s };
  })();
  const sosAt = late.indexOf(Buffer.from([0xff, 0xda]));
  const eoi = late.length - 2;
  const after = Buffer.concat([late.subarray(0, 2), ...segs.filter((s) => s[1] !== DQT), late.subarray(sosAt, eoi), ...segs.filter((s) => s[1] === DQT), late.subarray(eoi)]);
  refused(normalizeJpeg(after), "corrupt", /a quantization table is missing/);
});

test("progressive JPEGs: corrupted or truncated scans and malformed scan parameters are refused; other encodings still refused", () => {
  const prog = real("im-progressive-420.jpg");
  // Truncated in the middle of the scans.
  refused(normalizeJpeg(prog.subarray(0, Math.floor(prog.length * 0.6))), "corrupt", /could not be decoded/);
  // Every scan header names its band in the last three bytes (Ss, Se, Ah/Al). Breaking them is refused.
  const firstAc = (() => { let p = 0; for (;;) { p = prog.indexOf(Buffer.from([0xff, 0xda]), p + 1); const ns = prog[p + 4]!; if (prog[p + 5 + 2 * ns]! > 0) return { p, ns }; } })();
  const bandAt = firstAc.p + 5 + 2 * firstAc.ns;
  const variants: [string, (b: Buffer) => void][] = [
    ["band past 63", (b) => { b[bandAt + 1] = 64; }],
    ["band backwards", (b) => { b[bandAt] = 9; b[bandAt + 1] = 3; }],
    ["refinement jumps two bits", (b) => { b[bandAt + 2] = 0x30; }],
  ];
  for (const [what, mutate] of variants) {
    const b = Buffer.from(prog);
    mutate(b);
    assert.equal(normalizeJpeg(b).ok, false, what);
  }
  // An AC scan before any DC scan: drop the first (DC) scan entirely.
  const firstSos = prog.indexOf(Buffer.from([0xff, 0xda]));
  const secondScanHeader = (() => { let p = firstSos + 2; while (!(prog[p] === 0xff && prog[p + 1] !== 0 && !(prog[p + 1]! >= 0xd0 && prog[p + 1]! <= 0xd7))) p++; return p; })();
  refused(normalizeJpeg(Buffer.concat([prog.subarray(0, firstSos), prog.subarray(secondScanHeader)])), "corrupt", /AC scan comes before|repeats or skips/);
  // A baseline frame whose scan carries progressive parameters is refused (no mixing).
  const relabelled = Buffer.from(smallJpeg(4, 64, 64));
  relabelled[relabelled.indexOf(Buffer.from([0xff, SOF0])) + 1] = 0xc2;
  refused(normalizeJpeg(relabelled), "corrupt", /progressive scan's band/);
  // Arithmetic-coded (SOF9), lossless (SOF3) and hierarchical (SOF5) frames are still refused as formats.
  for (const m of [0xc9, 0xc3, 0xc5]) {
    const b = Buffer.from(smallJpeg(4, 16, 16));
    b[b.indexOf(Buffer.from([0xff, SOF0])) + 1] = m;
    refused(normalizeJpeg(b), "format", /arithmetic-coded, lossless or hierarchical/);
  }
  // Random corruption never throws and never takes long: each result is a clean accept or a reasoned refusal.
  let seed = 9;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let n = 0; n < 300; n++) {
    const b = Buffer.from(prog);
    for (let k = 0; k < 3; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const t = performance.now();
    const r = normalizeJpeg(b);
    assert.ok(performance.now() - t < 200);
    if (!r.ok) assert.match(r.error, /nothing was stored/i);
  }
});

test("metadata (EXIF orientation and GPS, XMP, comments, trailing bytes) is stripped from progressive and reordered layouts too", () => {
  for (const base of [real("im-progressive-420.jpg"), relayout(real("im-baseline-420.jpg"), { dqtAfterSof: true, merge: true })]) {
    const input = withMetadata(base, { exif: true, xmp: true, comment: "COMMENT-SECRET", trailing: "TRAILING-SECRET" });
    const r = ok(normalizeJpeg(input));
    for (const m of ["Exif", "GPS-SECRET-PLACE", "FAKEPHONE", "XMP-SECRET", "COMMENT-SECRET", "TRAILING-SECRET"]) assert.equal(r.bytes.includes(m), false, m);
    assert.deepEqual(metadataSegments(r.bytes), []);
  }
});

test("format is judged by signature, not by Content-Type: HEIC/HEIF brands, PNG and a JPEG declared as something else", () => {
  const ftyp = (major: string, compat = "mif1heic") => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${major}\0\0\0\0${compat}`), Buffer.alloc(32)]);
  for (const brand of ["heic", "heix", "mif1", "msf1", "hevc"]) {
    assert.equal(sniff(ftyp(brand)), "heic", brand);
    refused(normalizeJpeg(ftyp(brand)), "format", /HEIC\/HEIF/);
  }
  assert.equal(sniff(ftyp("avif", "avifmif1")), "avif");
  assert.equal(sniff(ftyp("isom", "isomiso2")), "iso-media");
});

// ---- through the real server ------------------------------------------------------------------------------------------------

function photoRig() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-decode-"));
  let store: Attachments | undefined;
  const model = Object.assign(scripted([say("seen"), say("seen"), say("seen")]), { images: () => ({ ok: true, detail: "test" }) });
  const r = rig({ dir, model, extra: () => ({ assistantDir: join(dir, "assistant"), attachments: (store = attachmentStore(join(dir, "attachments"))) }) });
  const base = async () => {
    await r.api("/status");
    return `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
  };
  const upload = async (bytes: Buffer, type = "image/jpeg") => {
    const res = await fetch(`${await base()}/assistant/attachments`, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes) });
    return { status: res.status, data: (await res.json()) as any };
  };
  return { ...r, dir, model, upload, store: () => store! };
}

test("server: reordered, merged-table and progressive uploads are stored as valid processed JPEGs and reach the model as stored", async () => {
  const r = photoRig();
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const inputs = [
      relayout(real("im-baseline-420.jpg"), { dqtAfterSof: true }),
      relayout(real("ffmpeg-baseline-420.jpg"), { dqtAfterSof: true, merge: true }),
      withMetadata(real("im-progressive-420.jpg"), { exif: true, comment: "COMMENT-SECRET" }),
      real("im-progressive-gray.jpg"),
    ];
    const ids: string[] = [];
    for (const [k, input] of inputs.entries()) {
      // The Content-Type is ignored: a mislabelled JPEG is still judged by its bytes.
      const up = await r.upload(input, k === 3 ? "image/heic" : "image/jpeg");
      assert.equal(up.status, 201, JSON.stringify(up.data));
      ids.push(up.data.attachment.id);
      const stored = r.store().read(up.data.attachment.id, "assistant")!;
      // Stored bytes are exactly the server's normalization of the uploaded bytes: no transport change, nothing else kept.
      assert.deepEqual(stored, ok(normalizeJpeg(input)).bytes);
      assert.deepEqual(metadataSegments(stored), []);
      assert.equal(stored.includes("GPS-SECRET-PLACE"), false);
      assert.equal(stored.equals(input), false, "the original is not what is kept");
    }
    // Nothing but .jpg and .json records on disk, and no original among them.
    for (const f of readdirSync(join(r.dir, "attachments"))) {
      assert.match(f, /^a[0-9a-f]{32}\.(jpg|json)$/);
      if (f.endsWith(".jpg")) for (const input of inputs) assert.equal(readFileSync(join(r.dir, "attachments", f)).equals(input), false);
    }
    const sent = await r.api("/assistant/messages", "POST", { text: "What shapes are there?", attachments: ids });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const seen = [...((r.model as any).seen.at(-1).input as Item[])].reverse().find((i): i is Message => "role" in i && i.role === "user")!;
    assert.deepEqual(seen.images!.map((i) => i.id), ids);
    for (const img of seen.images!) assert.deepEqual(Buffer.from(img.data!, "base64"), r.store().read(img.id, "assistant"));
    // A file whose tables are really missing is refused with 422, stage-specific JSON and a bounded log reason.
    const broken = await r.upload(withoutSegments(real("im-baseline-420.jpg"), DQT));
    assert.equal(broken.status, 422);
    assert.equal(broken.data.kind, "corrupt");
    assert.match(broken.data.error, /a quantization table is missing/);
    const heic = await r.upload(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic\0\0\0\0mif1heic"), Buffer.alloc(64)]), "image/jpeg");
    assert.equal(heic.status, 415);
    assert.equal(heic.data.kind, "format");
  } finally {
    console.log = log;
  }
  const refusedLogs = logs.filter((l) => l.includes("attachment_refused")).map((l) => JSON.parse(l));
  assert.deepEqual(refusedLogs.map((l) => [l.kind, l.reason]), [["corrupt", "a quantization table is missing"], ["format", "signature:heic"]]);
  for (const l of logs) assert.equal(/GPS-SECRET|COMMENT-SECRET|base64|\.jpg"/.test(l), false, "logs carry no content");
});
