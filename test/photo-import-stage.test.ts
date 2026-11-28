import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { normalizeJpeg } from "../src/jpeg.ts";
import { EXPORT_FORMAT, ImportError } from "../src/photo-import.ts";
import { exifOrientation, findConverter, stageExport } from "../src/photo-import-stage.ts";
import { encodeJpeg, pattern, smallJpeg, withMetadata } from "./jpeg-fixture.ts";

// The staging helper (src/photo-import-stage.ts, tools/photo-import/stage.ts, docs/photo-import-backfill.md "Staging") end to end on
// SYNTHETIC data built here: generated JPEGs and PNGs, invented ids and captions. It runs the host's real ImageMagick (the documented
// converter dependency; it is never installed by the tool or the tests), then the real importer's dry run on the staged bundle. The
// tests that need the converter are skipped, saying so, where ImageMagick is not installed.

/* eslint-disable @typescript-eslint/no-explicit-any */
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
let converter: ReturnType<typeof findConverter> | undefined;
try {
  converter = findConverter();
} catch {
  converter = undefined;
}
const needs = converter ? {} : { skip: "ImageMagick (magick or convert) is not installed on this machine" };

// A minimal PNG encoder (RGBA, 8-bit, filter 0) for synthetic originals.
function png(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(px(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, pre: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${pre}${n}/`);
      else out[`${pre}${n}`] = sha(readFileSync(p));
    }
  };
  walk(dir, "");
  return out;
}
function bundle(items: unknown[], files: Record<string, Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "orbit-stage-src-"));
  for (const [rel, b] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), b);
  }
  writeFileSync(join(root, "orbit-photo-export.json"), JSON.stringify({ format: EXPORT_FORMAT, source: "openclaw", exportedAt: "2026-11-01T00:00:00Z", items }));
  return root;
}
const item = (id: string, file: string, extra: Record<string, unknown> = {}) => ({ id, file, sentAt: "2026-03-04T18:22:10Z", sender: "owner", caption: `Synthetic staging caption ${id}`, session: `sess-${id}`, message: `msg-${id}`, ...extra });
const stage = (...a: string[]) => spawnSync(process.execPath, ["tools/photo-import/stage.ts", ...a], { encoding: "utf8" });
const importer = (...a: string[]) => spawnSync(process.execPath, ["tools/photo-import/import.ts", ...a], { encoding: "utf8" });

test("staging: JPEG and PNG originals become compliant JPEG copies, provenance is unchanged, and the importer's dry run accepts them", needs, () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "orbit-projects-"));
  writeFileSync(join(projectsDir, "Garden.md"), "# Garden\n");
  const compliant = withMetadata(smallJpeg(201), { exif: true, orientation: 1, comment: "Synthetic camera comment" });
  // Within the bounds but marked as rotated (EXIF orientation 6): converted upright (48x32 becomes 32x48), not copied.
  const rotated = withMetadata(smallJpeg(202), { exif: true, orientation: 6 });
  // 2400x1200 with EXIF orientation 6 (rotate 90°): the copy must be upright, 800x1600.
  const wide = withMetadata(encodeJpeg(2400, 1200, pattern(3)), { exif: true, orientation: 6 });
  const tall = encodeJpeg(900, 1700, pattern(4));
  const alpha = png(1800, 1800, (x, y) => [(x * 7) & 255, (y * 5) & 255, ((x ^ y) * 3) & 255, x < 900 ? 255 : 0]);
  const small = png(64, 40, (x, y) => [x * 4, y * 6, 128, 255]);
  const items = [
    item("ok-jpeg", "media/ok.jpg", { projects: [{ project: "Projects/Garden.md", evidence: "explicit", basis: "the message was tagged #garden" }] }),
    item("wide-jpeg", "media/wide.jpeg", { projectCandidates: ["Projects/Garden.md"] }),
    item("tall-jpeg", "media/tall.JPG"),
    item("rotated-jpeg", "media/rotated.jpg"),
    item("alpha-png", "media/alpha.png", { caption: "Synthetic caption for a transparent PNG" }),
    item("small-png", "media/small.png"),
    item("heic", "media/fake.png"),
    item("gone", "media/gone.jpg"),
    item("escape", "../outside.jpg"),
    item("not-owner", "media/ok.jpg", { sender: "someone-else" }),
    { id: "bad id with spaces", file: "media/ok.jpg" },
  ];
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(40)]);
  const root = bundle(items, { "media/ok.jpg": compliant, "media/wide.jpeg": wide, "media/tall.JPG": tall, "media/rotated.jpg": rotated, "media/alpha.png": alpha, "media/small.png": small, "media/fake.png": heic });
  const original = tree(root);
  const out = join(mkdtempSync(join(tmpdir(), "orbit-stage-out-")), "staged");
  const run = stage("--export", root, "--out", out);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout);
  const by = Object.fromEntries(report.items.map((i: any) => [i.item, i]));
  assert.deepEqual(report.counts, { items: 11, copied: 2, converted: 5, failed: 4 });
  assert.equal(by["ok-jpeg"].status, "copied");
  assert.equal(by["not-owner"].status, "copied", "staging never judges provenance; the importer rejects it");
  for (const id of ["wide-jpeg", "tall-jpeg", "rotated-jpeg", "alpha-png", "small-png"]) assert.equal(by[id].status, "converted", id);
  assert.deepEqual([by["rotated-jpeg"].width, by["rotated-jpeg"].height], [32, 48], "a rotated camera JPEG is stored upright");
  assert.deepEqual([by["wide-jpeg"].width, by["wide-jpeg"].height], [800, 1600], "orientation applied, longest edge 1600");
  assert.deepEqual([by["tall-jpeg"].width, by["tall-jpeg"].height], [847, 1600]);
  assert.deepEqual([by["alpha-png"].width, by["alpha-png"].height], [1600, 1600]);
  assert.deepEqual([by["small-png"].width, by["small-png"].height], [64, 40], "never enlarged");
  assert.match(by.heic.reason, /HEIC file; only JPEG and PNG are staged/);
  assert.match(by.gone.reason, /not there/);
  assert.match(by.escape.reason, /plain relative path/);
  assert.match(by["#11"].reason, /^id:/);
  assert.deepEqual(report.omitted.sort(), ["#11", "escape", "gone", "heic"]);
  // No private text or path in the report, on stdout or on disk.
  const saved = readFileSync(join(out, "staging-report.json"), "utf8");
  for (const text of [run.stdout, saved]) for (const secret of ["Synthetic staging caption", "sess-", "msg-", "media/", root, out]) assert.ok(!text.includes(secret), `the report leaks ${secret}`);
  // The original bundle is unchanged, byte for byte.
  assert.deepEqual(tree(root), original);
  // Every staged file is within the bounds and passes ORBIT's own upload check; the compliant JPEG is an exact copy.
  const manifest = JSON.parse(readFileSync(join(out, "orbit-photo-export.json"), "utf8"));
  assert.equal(sha(readFileSync(join(out, "orbit-photo-export.json"))), report.stagedManifestSha256);
  assert.equal((statSync(join(out, "orbit-photo-export.json")).mode & 0o777).toString(8), "600");
  for (const it of manifest.items) {
    const b = readFileSync(join(out, it.file));
    assert.ok(b.length <= 1_048_576, `${it.id}: ${b.length} bytes`);
    const n = normalizeJpeg(b);
    assert.ok(n.ok, it.id);
    assert.ok(Math.max(n.width, n.height) <= 1600 && n.width * n.height <= 2_560_000, it.id);
    assert.equal(sha(b), by[it.id].sha256);
  }
  assert.deepEqual(readFileSync(join(out, manifest.items[0].file)), compliant, "a compliant JPEG is copied unchanged");
  assert.ok(!readdirSync(out).some((n) => n.startsWith(".work-")), "no working files left");
  // Provenance and project evidence are carried over exactly; only `file` changed, and failed items are left out.
  const kept = items.filter((i: any) => ["copied", "converted"].includes(by[i.id]?.status));
  assert.deepEqual(manifest.items.map((i: any) => ({ ...i, file: undefined })), kept.map((i: any) => ({ ...i, file: undefined })));
  assert.deepEqual(manifest.items.map((i: any) => Object.keys(i)), kept.map((i: any) => Object.keys(i)), "the same fields, in the same order");
  assert.ok(manifest.items.every((i: any) => /^photos\/\d{5}\.jpg$/.test(i.file)));
  assert.deepEqual([manifest.format, manifest.source, manifest.exportedAt], [EXPORT_FORMAT, "openclaw", "2026-11-01T00:00:00Z"]);
  // The importer's real dry run on the staged bundle: every staged photo is importable with the hash staging predicted; the
  // non-owner item is rejected by the importer; the explicit link is made and the candidate is never linked.
  const state = mkdtempSync(join(tmpdir(), "orbit-state-"));
  const dry = importer("--export", out, "--state", state, "--projects-dir", projectsDir);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  const plan = JSON.parse(dry.stdout).plan;
  const planned = Object.fromEntries(plan.items.map((i: any) => [i.item, i]));
  for (const id of ["ok-jpeg", "wide-jpeg", "tall-jpeg", "rotated-jpeg", "alpha-png", "small-png"]) {
    assert.equal(planned[id].status, "importable", id);
    assert.equal(planned[id].sha256, by[id].importSha256, `${id}: the importer stores what staging checked`);
  }
  assert.equal(planned["not-owner"].status, "rejected");
  assert.deepEqual([planned["ok-jpeg"].link.status, planned["ok-jpeg"].link.project], ["linked", "Projects/Garden.md"]);
  assert.equal(planned["wide-jpeg"].link.status, "ambiguous", "a candidate is never promoted to a link");
  assert.match(plan.planSha256, /^[0-9a-f]{64}$/);
  // The same photo staged from the original gives the same stored hash as importing the original directly (identity kept).
  const direct = JSON.parse(importer("--export", root, "--state", state).stdout).plan.items.find((i: any) => i.item === "ok-jpeg");
  assert.equal(direct.sha256, planned["ok-jpeg"].sha256);
  assert.deepEqual(readdirSync(state), [], "the dry run wrote nothing");
});

test("staging: the size bound is enforced (lower quality first, then a reported failure), never exceeded", needs, () => {
  const noisy = (seed: number) => (x: number, y: number): [number, number, number] => {
    const h = Math.imul(x * 374761393 + y * 668265263 + seed, 1274126177) >>> 0;
    return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255];
  };
  const root = bundle([item("noisy", "n.png"), item("fits", "f.png")], { "n.png": png(600, 600, (x, y) => [...noisy(1)(x, y), 255]), "f.png": png(300, 300, (x, y) => [...noisy(2)(x, y), 255]) });
  const out = join(mkdtempSync(join(tmpdir(), "orbit-stage-out-")), "staged");
  // Tighter limits (the helper only allows tightening) make the size ladder observable on small synthetic files.
  const report = stageExport({ exportDir: root, out, converter: converter!, limits: { maxBytes: 120_000, maxEdge: 1600, maxPixels: 2_560_000 } });
  const by = Object.fromEntries(report.items.map((i) => [i.item, i]));
  assert.equal(by.noisy!.status, "failed");
  assert.match(by.noisy!.reason!, /still over 120000 bytes at the lowest quality \(48\)/);
  assert.equal(by.fits!.status, "converted");
  assert.ok(by.fits!.bytes! <= 120_000);
  assert.ok(by.fits!.quality! <= 85);
  assert.deepEqual(report.omitted, ["noisy"]);
  assert.throws(() => stageExport({ exportDir: root, out: join(out, "..", "other"), converter: converter!, limits: { maxBytes: 2_000_000, maxEdge: 1600, maxPixels: 2_560_000 } }), /only be tighter/);
});

test("staging: the EXIF orientation is read from big- and little-endian EXIF, and is 1 without one", () => {
  assert.equal(exifOrientation(smallJpeg(1)), 1);
  for (const o of [1, 3, 6, 8]) assert.equal(exifOrientation(withMetadata(smallJpeg(1), { exif: true, orientation: o })), o);
  // The same tag written little-endian.
  const le = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), le]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const j = smallJpeg(1);
  assert.equal(exifOrientation(Buffer.concat([j.subarray(0, 2), app1, j.subarray(2)])), 8);
  assert.equal(exifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1])), 1, "a malformed segment is not an orientation");
});

test("staging refuses, writing nothing: no converter, an output inside the original or not empty, a bad manifest", () => {
  const root = bundle([item("a", "a.jpg")], { "a.jpg": smallJpeg(211) });
  const original = tree(root);
  const parent = mkdtempSync(join(tmpdir(), "orbit-stage-out-"));
  const noMagick = stage("--export", root, "--out", join(parent, "x"), "--magick", join(parent, "no-such-binary"));
  assert.equal(noMagick.status, 2);
  assert.match(JSON.parse(noMagick.stdout).why, /does not name a working ImageMagick/);
  // Only an absolute PATH is searched, and nothing is installed when ImageMagick is missing.
  assert.throws(() => findConverter(undefined, parent), (e: unknown) => e instanceof ImportError && /never installs packages/.test((e as Error).message));
  assert.ok(!existsSync(join(parent, "x")));
  assert.equal(stage("--export", root).status, 2);
  assert.equal(stage("--export", root, "--out", join(parent, "y"), "--bogus").status, 2);
  if (converter) {
    const inside = stage("--export", root, "--out", join(root, "staged"));
    assert.equal(inside.status, 2);
    assert.match(JSON.parse(inside.stdout).why, /outside the original export bundle/);
    const full = join(parent, "full");
    mkdirSync(full);
    writeFileSync(join(full, "something"), "x");
    const nonEmpty = stage("--export", root, "--out", full);
    assert.equal(nonEmpty.status, 2);
    assert.match(JSON.parse(nonEmpty.stdout).why, /new or empty directory/);
    writeFileSync(join(root, "orbit-photo-export.json"), "{not json");
    const bad = stage("--export", root, "--out", join(parent, "z"));
    assert.equal(bad.status, 2);
    assert.match(JSON.parse(bad.stdout).why, /not valid JSON/);
    assert.ok(!existsSync(join(parent, "z")));
    writeFileSync(join(root, "orbit-photo-export.json"), JSON.stringify({ format: EXPORT_FORMAT, source: "openclaw", exportedAt: "2026-11-01T00:00:00Z", items: [item("a", "a.jpg")] }));
  }
  assert.deepEqual(tree(root), original, "the original bundle is never written to");
});
