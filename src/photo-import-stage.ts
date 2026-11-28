import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { JPEG_MAX_BYTES, JPEG_MAX_EDGE, JPEG_MAX_PIXELS, normalizeJpeg, sniff } from "./jpeg.ts";
import { confinedFile, exportRoot, ImportError, MANIFEST_NAME, readBounded, readManifest } from "./photo-import.ts";
import { ITEM_ID } from "./photo-import-ledger.ts";

// The host-local staging helper for the legacy photo import (docs/photo-import-backfill.md, "Staging"). ORBIT has no image decoder, so
// the importer rejects PNGs and JPEGs over the upload bounds. This helper makes a NEW export bundle beside the original: every photo the
// importer could already take is copied byte for byte (so its identity, and duplicate detection against photos already in ORBIT, is
// unchanged), unless EXIF marks it as rotated; every other JPEG or PNG is converted by the host's ImageMagick into a JPEG within the bounds (longest edge 1600 px, at
// most 2.56 MP, at most 1 MiB, orientation applied, metadata stripped), and the result is checked with the same function uploads use
// (src/jpeg.ts normalizeJpeg). The staged manifest is the original with only each staged item's `file` changed: ids, send times,
// sender, captions, session and message pointers, `projects` and `projectCandidates` are carried over exactly, so provenance and
// project evidence are never changed or guessed. Items that cannot be staged are left out of the staged manifest and reported.
//
// It never writes to the original bundle, never installs anything (ImageMagick is the operator's documented dependency), never reads
// ORBIT's state, and never fetches anything. Its report holds item ids, statuses, reasons, sizes and hashes: never captions,
// pointers, file names or paths.

export const STAGE_REPORT_NAME = "staging-report.json";
export const STAGE_DIR = "photos";
// Originals larger than this are refused before they are read (a phone PNG is typically well under it).
export const STAGE_SOURCE_BYTES_MAX = 64 * 1024 * 1024;
// Decoded images wider or taller than this are refused by the converter itself (a decompression bomb never fills memory).
export const STAGE_SOURCE_EDGE_MAX = 20_000;
export const STAGE_QUALITIES = [85, 80, 72, 64, 56, 48] as const;
export const STAGE_TIMEOUT_MS = 120_000;
const SOURCE_EXT = /\.(jpe?g|png)$/i;

export type StageLimits = { maxBytes: number; maxEdge: number; maxPixels: number };
export const UPLOAD_LIMITS: StageLimits = { maxBytes: JPEG_MAX_BYTES, maxEdge: JPEG_MAX_EDGE, maxPixels: JPEG_MAX_PIXELS };

export type Converter = { bin: string; version: string };
export type StagedItem = {
  item: string;
  status: "copied" | "converted" | "failed";
  reason?: string;
  from?: "jpeg" | "png";
  width?: number;
  height?: number;
  bytes?: number;
  // Of the staged file, and of what the importer will store from it (the dry run's sha256).
  sha256?: string;
  importSha256?: string;
  quality?: number;
};
export type StageReport = {
  staged: true;
  format: "orbit-legacy-photo-staging/1";
  converter: string;
  limits: StageLimits;
  sourceManifestSha256: string;
  stagedManifestSha256: string;
  counts: { items: number; copied: number; converted: number; failed: number };
  omitted: string[];
  items: StagedItem[];
};

// ---- the converter ------------------------------------------------------------------------------------------------------------------
// ImageMagick: `magick` (version 7) or `convert` (version 6), from --magick or the PATH. It must say it is ImageMagick. Nothing is
// installed: when it is missing the run refuses and says how the operator can install it.
export function findConverter(explicit?: string, path = process.env.PATH ?? ""): Converter {
  const candidates = explicit ? [explicit] : path.split(delimiter).filter((d) => d && isAbsolute(d)).flatMap((d) => [join(d, "magick"), join(d, "convert")]);
  for (const bin of candidates) {
    try {
      if (!statSync(bin).isFile()) continue;
    } catch {
      continue;
    }
    const r = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 10_000 });
    const first = (r.stdout ?? "").split("\n")[0] ?? "";
    const m = first.match(/ImageMagick (\d+\.\d+\.\d+(?:-\d+)?)/);
    if (r.status === 0 && m) return { bin, version: `ImageMagick ${m[1]}` };
  }
  throw new ImportError(
    explicit
      ? "--magick does not name a working ImageMagick binary (magick or convert). Nothing was written."
      : "ImageMagick is not installed (no magick or convert on the PATH). Install it yourself (Debian/Ubuntu: apt-get install imagemagick), or pass --magick <path>; this tool never installs packages. Nothing was written.",
  );
}

function convert(c: Converter, input: string, kind: "jpeg" | "png", output: string, quality: number, limits: StageLimits): { ok: true } | { ok: false; reason: string } {
  // The coder is named explicitly (never guessed from the content or a name), only the first frame is read, and resources are bounded.
  const args = [
    ...["-limit", "memory", "256MiB", "-limit", "map", "512MiB", "-limit", "disk", "1GiB", "-limit", "width", String(STAGE_SOURCE_EDGE_MAX), "-limit", "height", String(STAGE_SOURCE_EDGE_MAX), "-limit", "time", "100"],
    `${kind}:${input}[0]`,
    "-auto-orient",
    ...["-colorspace", "sRGB", "-background", "white", "-alpha", "remove", "-alpha", "off"],
    ...["-resize", `${limits.maxEdge}x${limits.maxEdge}>`, "-resize", `${limits.maxPixels}@>`],
    "-strip",
    ...["-depth", "8", "-sampling-factor", "4:2:0", "-interlace", "none", "-quality", String(quality)],
    `jpeg:${output}`,
  ];
  const r = spawnSync(c.bin, args, { encoding: "utf8", timeout: STAGE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? "", LANG: "C" } });
  if (r.error) return { ok: false, reason: `the converter did not finish (${(r.error as NodeJS.ErrnoException).code ?? "error"})` };
  // Its message may name paths, so only the exit status is reported; run the converter by hand on that file to see why.
  if (r.status !== 0) return { ok: false, reason: `the converter failed (exit ${r.status ?? r.signal}); run ImageMagick on this item's original by hand to see why` };
  return { ok: true };
}

// The EXIF orientation (1-8) of a JPEG, or 1 when it has none. ORBIT's normalization drops EXIF, so a camera JPEG within the bounds
// but marked as rotated would be shown sideways; staging converts those (the converter applies the rotation) instead of copying.
export function exifOrientation(b: Uint8Array): number {
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1]!;
    if (m === 0xda || m === 0xd9) break;
    const len = (b[p + 2]! << 8) | b[p + 3]!;
    if (len < 2) break;
    if (m === 0xe1 && len >= 16 && Buffer.from(b.subarray(p + 4, p + 10)).equals(Buffer.from("Exif\0\0", "latin1"))) {
      const t = Buffer.from(b.subarray(p + 10, p + 2 + len));
      const le = t[0] === 0x49 && t[1] === 0x49;
      if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return 1;
      const u16 = (o: number) => (o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : -1);
      const u32 = (o: number) => (o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : -1);
      const ifd = u32(4);
      const n = ifd >= 8 ? u16(ifd) : -1;
      for (let i = 0; i < n && i < 512; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}

// ---- writing ----------------------------------------------------------------------------------------------------------------------
function writeFileAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

// The output directory: new (or an existing empty directory), and neither inside the original bundle nor containing it.
export function stageOut(out: string, root: string): string {
  const abs = resolve(out);
  let real: string;
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) throw new ImportError("--out exists and is not a directory. Nothing was written.");
    if (readdirSync(abs).length) throw new ImportError("--out must be a new or empty directory; the staging helper never overwrites a bundle. Nothing was written.");
    real = realpathSync(abs);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    let parent: string;
    try {
      parent = realpathSync(dirname(abs));
    } catch {
      throw new ImportError("The parent directory of --out does not exist. Nothing was written.");
    }
    real = join(parent, abs.slice(dirname(abs).length + 1));
  }
  if (real === root || real.startsWith(root + sep) || root.startsWith(real + sep)) throw new ImportError("--out must be outside the original export bundle (the original is never written to). Nothing was written.");
  return real;
}

// ---- staging ----------------------------------------------------------------------------------------------------------------------
export function stageExport(o: { exportDir: string; out: string; converter: Converter; limits?: StageLimits }): StageReport {
  const limits = o.limits ?? UPLOAD_LIMITS;
  if (limits.maxBytes > JPEG_MAX_BYTES || limits.maxEdge > JPEG_MAX_EDGE || limits.maxPixels > JPEG_MAX_PIXELS) throw new ImportError("The staging limits can only be tighter than the upload bounds.");
  const root = exportRoot(o.exportDir);
  const { text, sha256: sourceManifestSha256 } = readManifest(root);
  const top = JSON.parse(text) as Record<string, unknown> & { items: unknown[] };
  const out = stageOut(o.out, root);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  // mkdir's mode does not apply to a directory that already existed (an empty --out): make the bundle's top level private too.
  chmodSync(out, 0o700);
  mkdirSync(join(out, STAGE_DIR), { mode: 0o700 });
  const work = join(out, `.work-${randomUUID()}`);
  mkdirSync(work, { mode: 0o700 });
  const items: StagedItem[] = [];
  const kept: unknown[] = [];
  const seen = new Set<string>();
  try {
    top.items.forEach((raw, i) => {
      const r = raw as Record<string, unknown>;
      const id = r && typeof r === "object" && !Array.isArray(r) && typeof r.id === "string" && ITEM_ID.test(r.id) ? r.id : "";
      const fail = (reason: string, extra: Partial<StagedItem> = {}) => void items.push({ item: id || `#${i + 1}`, status: "failed", reason, ...extra });
      if (!id) return fail("id: 1-64 characters of letters, digits and _ . : - are required");
      if (seen.has(id)) return fail("id: the same item id appears twice in the export");
      seen.add(id);
      const c = confinedFile(root, r.file, { ext: SOURCE_EXT, extReason: "file: only .jpg, .jpeg or .png originals are staged; convert other formats by hand", maxBytes: STAGE_SOURCE_BYTES_MAX });
      if (!c.ok) return fail(c.reason);
      let src: Buffer;
      try {
        src = readBounded(c.path, STAGE_SOURCE_BYTES_MAX);
      } catch {
        return fail("the original could not be read");
      }
      const kind = sniff(src);
      if (kind !== "jpeg" && kind !== "png") return fail(`type: the original is ${kind ? `a ${kind.toUpperCase()} file` : "not a recognised image"}; only JPEG and PNG are staged`);
      const rel = `${STAGE_DIR}/${String(i + 1).padStart(5, "0")}.jpg`;
      const dest = join(out, rel);
      // Already within the bounds: copied unchanged, so the importer stores exactly what it would have stored from the original.
      if (kind === "jpeg" && exifOrientation(src) === 1) {
        const n = normalizeJpeg(src, limits);
        if (n.ok) {
          writeFileAtomic(dest, src);
          kept.push({ ...r, file: rel });
          return void items.push({ item: id, status: "copied", from: "jpeg", width: n.width, height: n.height, bytes: src.length, sha256: createHash("sha256").update(src).digest("hex"), importSha256: createHash("sha256").update(n.bytes).digest("hex") });
        }
      }
      // Converted from the bytes just read (a private copy in the work directory), so what is converted is what was checked.
      const input = join(work, `in-${i}`);
      writeFileAtomic(input, src);
      let last = "";
      for (const q of STAGE_QUALITIES) {
        const tmp = join(work, `out-${i}-${q}.jpg`);
        const conv = convert(o.converter, input, kind, tmp, q, limits);
        if (!conv.ok) {
          last = conv.reason;
          break;
        }
        let made: Buffer;
        try {
          made = readFileSync(tmp);
        } catch {
          last = "the converter wrote no output";
          break;
        }
        // The output must pass exactly the check uploads get, under the (possibly tighter) limits.
        const n = normalizeJpeg(made, limits);
        if (n.ok && n.width <= limits.maxEdge && n.height <= limits.maxEdge && n.width * n.height <= limits.maxPixels && made.length <= limits.maxBytes) {
          writeFileAtomic(dest, made);
          kept.push({ ...r, file: rel });
          return void items.push({ item: id, status: "converted", from: kind, quality: q, width: n.width, height: n.height, bytes: made.length, sha256: createHash("sha256").update(made).digest("hex"), importSha256: createHash("sha256").update(n.bytes).digest("hex") });
        }
        last = n.ok ? "the converted JPEG is outside the bounds" : n.kind === "size" ? `still over ${limits.maxBytes} bytes at the lowest quality (${STAGE_QUALITIES.at(-1)}); reduce it by hand` : `the converted JPEG does not pass ORBIT's check (${n.kind})`;
        if (!n.ok && n.kind !== "size") break;
      }
      return fail(last, { from: kind });
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // The manifest last: a bundle without its manifest is never mistaken for a finished one.
  const stagedText = `${JSON.stringify({ ...top, items: kept }, null, 2)}\n`;
  const counts = { items: items.length, copied: items.filter((x) => x.status === "copied").length, converted: items.filter((x) => x.status === "converted").length, failed: items.filter((x) => x.status === "failed").length };
  const report: StageReport = {
    staged: true,
    format: "orbit-legacy-photo-staging/1",
    converter: o.converter.version,
    limits,
    sourceManifestSha256,
    stagedManifestSha256: createHash("sha256").update(stagedText).digest("hex"),
    counts,
    omitted: items.filter((x) => x.status === "failed").map((x) => x.item),
    items,
  };
  writeFileAtomic(join(out, STAGE_REPORT_NAME), `${JSON.stringify(report, null, 2)}\n`);
  writeFileAtomic(join(out, MANIFEST_NAME), stagedText);
  return report;
}
