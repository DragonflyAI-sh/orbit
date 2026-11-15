// Server-side check and normalization of an uploaded photo (docs/photos.md). Pure TypeScript, no native or npm dependency.
//
// The browser converts every photo to a baseline JPEG before upload (src/web/photos.js). This module does not trust that: it reads the
// bytes themselves (never the filename, MIME type or any client metadata) and accepts only a baseline (or extended sequential) Huffman
// JPEG with 8-bit samples, one or three components, bounded dimensions and size, whose every entropy-coded block decodes without error.
// The stored copy is rebuilt from the decoded structure: quantization tables, frame header, Huffman tables, restart interval and the
// scans, under a fixed metadata-free JFIF header. Every APPn segment (EXIF, GPS, XMP, ICC, maker notes), every comment and anything
// after the end-of-image marker are dropped, so even a client that bypasses the page cannot store metadata or an unprocessed original.
// Progressive, arithmetic-coded, lossless, hierarchical and 12-bit JPEGs, and every other format, are rejected rather than converted.

// The hard limits. The browser aims far below them (1600 px longest edge, about 500 KB).
export const JPEG_MAX_BYTES = 1_048_576;
export const JPEG_MAX_EDGE = 1600;
export const JPEG_MAX_PIXELS = JPEG_MAX_EDGE * JPEG_MAX_EDGE;

export type JpegResult = { ok: true; bytes: Buffer; width: number; height: number; components: number } | { ok: false; error: string; kind: "format" | "size" | "dimensions" | "corrupt" };

// A fixed JFIF APP0: version 1.01, no density units, 1:1 aspect, no thumbnail. It carries nothing about the photo or the device.
const JFIF = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

// What a payload that is not a JPEG looks like, for an error that says what to do. Only the leading bytes are looked at.
export function sniff(b: Uint8Array): string | undefined {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (ascii(0, "GIF8")) return "gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "heic";
    if (/^avi[fs]$/.test(brand)) return "avif";
    return "iso-media";
  }
  if (ascii(0, "%PDF")) return "pdf";
  if (ascii(0, "BM")) return "bmp";
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return "tiff";
  // SVG, HTML or any other markup: active content, never stored.
  const head = Buffer.from(b.subarray(0, 256)).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<")) return head.includes("<svg") || head.startsWith("<?xml") ? "svg" : "markup";
  return undefined;
}

const fail = (kind: Extract<JpegResult, { ok: false }>["kind"], error: string): JpegResult => ({ ok: false, kind, error });

class Corrupt extends Error {}

type Huffman = { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array };

// Canonical Huffman table (ITU T.81 Annex C). Refuses a table whose codes overflow their length.
function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1]!;
    if (n) {
      valptr[len] = k;
      mincode[len] = code;
      code += n;
      k += n;
      if (code > 1 << len) throw new Corrupt("a Huffman table is malformed");
      maxcode[len] = code - 1;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

type Component = { id: number; h: number; v: number; tq: number };

// Entropy-decodes one scan starting at `pos` and returns where its data ends (the next marker that is not a restart marker).
// Every block is decoded: DC and AC Huffman codes, coefficient magnitudes, run lengths, restart markers in order. Coefficient
// values are not kept and no pixels are produced; a scan that decodes completely is a scan a decoder can render.
function decodeScan(buf: Buffer, pos: number, comps: { c: Component; dc: Huffman; ac: Huffman; blocksW: number; blocksH: number }[], frame: { width: number; height: number; hmax: number; vmax: number }, restart: number): number {
  let i = pos;
  let bits = 0;
  let nbits = 0;
  let hitMarker = false;
  const bit = (): number => {
    if (nbits === 0) {
      if (hitMarker || i >= buf.length) throw new Corrupt("the image data ends early (truncated)");
      const byte = buf[i]!;
      if (byte === 0xff) {
        const next = buf[i + 1];
        if (next === 0x00) {
          i += 2;
        } else {
          hitMarker = true;
          throw new Corrupt("the image data ends early (truncated)");
        }
      } else i++;
      bits = byte;
      nbits = 8;
    }
    nbits--;
    return (bits >> nbits) & 1;
  };
  const receive = (n: number) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = (v << 1) | bit();
    return v;
  };
  const decode = (t: Huffman): number => {
    let code = bit();
    for (let len = 1; len <= 16; len++) {
      if (code <= t.maxcode[len]! && t.maxcode[len]! >= 0) {
        const idx = t.valptr[len]! + code - t.mincode[len]!;
        if (idx < 0 || idx >= t.values.length) throw new Corrupt("a Huffman code points outside its table");
        return t.values[idx]!;
      }
      code = (code << 1) | bit();
    }
    throw new Corrupt("the image data has an invalid Huffman code");
  };
  const block = (dc: Huffman, ac: Huffman) => {
    const t = decode(dc);
    if (t > 11) throw new Corrupt("a DC coefficient is out of range");
    receive(t);
    for (let k = 1; k < 64; ) {
      const rs = decode(ac);
      const r = rs >> 4;
      const s = rs & 15;
      if (s === 0) {
        if (r !== 15) break;
        k += 16;
        if (k > 64) throw new Corrupt("an AC run goes past the end of a block");
        continue;
      }
      if (s > 10) throw new Corrupt("an AC coefficient is out of range");
      k += r;
      if (k > 63) throw new Corrupt("an AC run goes past the end of a block");
      receive(s);
      k++;
    }
  };

  const single = comps.length === 1;
  const mcusX = single ? comps[0]!.blocksW : Math.ceil(frame.width / (8 * frame.hmax));
  const mcusY = single ? comps[0]!.blocksH : Math.ceil(frame.height / (8 * frame.vmax));
  const total = mcusX * mcusY;
  let rst = 0;
  for (let m = 0; m < total; m++) {
    if (restart && m > 0 && m % restart === 0) {
      // Byte-align and expect the next restart marker, in sequence.
      nbits = 0;
      if (buf[i] !== 0xff || buf[i + 1] !== 0xd0 + rst) throw new Corrupt("a restart marker is missing or out of order");
      i += 2;
      rst = (rst + 1) & 7;
    }
    for (const s of comps) {
      const n = single ? 1 : s.c.h * s.c.v;
      for (let b = 0; b < n; b++) block(s.dc, s.ac);
    }
  }
  // After the last block only padding bits (all ones) may remain in the current byte; then the next marker must follow.
  if (nbits && (bits & ((1 << nbits) - 1)) !== (1 << nbits) - 1) throw new Corrupt("the image data has stray bits after the last block");
  while (i < buf.length && buf[i] === 0xff && buf[i + 1] === 0xff) i++;
  if (buf[i] !== 0xff || buf[i + 1] === undefined || buf[i + 1] === 0x00 || (buf[i + 1]! >= 0xd0 && buf[i + 1]! <= 0xd7)) throw new Corrupt("extra data follows the last block of a scan");
  return i;
}

export function normalizeJpeg(input: Uint8Array, limits: { maxBytes?: number; maxEdge?: number; maxPixels?: number } = {}): JpegResult {
  const maxBytes = limits.maxBytes ?? JPEG_MAX_BYTES;
  const maxEdge = limits.maxEdge ?? JPEG_MAX_EDGE;
  const maxPixels = limits.maxPixels ?? JPEG_MAX_PIXELS;
  if (input.length === 0) return fail("format", "The upload is empty.");
  if (input.length > maxBytes) return fail("size", `The photo is ${input.length} bytes; the limit is ${maxBytes} bytes after processing.`);
  const kind = sniff(input);
  if (kind !== "jpeg") {
    const what = kind === "heic" ? "a HEIC/HEIF photo" : kind === "svg" || kind === "markup" ? "SVG or other markup (active content)" : kind ? `a ${kind.toUpperCase()} file` : "not a recognised image";
    return fail("format", `Only processed JPEG photos are stored; this upload is ${what}. ORBIT's page converts photos in the browser before uploading; nothing was stored.`);
  }
  const buf = Buffer.from(input.buffer, input.byteOffset, input.length);
  const out: Buffer[] = [Buffer.from([0xff, 0xd8]), JFIF];
  const dc = new Map<number, Huffman>();
  const ac = new Map<number, Huffman>();
  const quant = new Set<number>();
  let frame: { width: number; height: number; comps: Component[]; hmax: number; vmax: number } | undefined;
  let restart = 0;
  const scanned = new Set<number>();
  let pos = 2;
  try {
    for (;;) {
      if (buf[pos] !== 0xff) throw new Corrupt("unexpected data between segments");
      while (buf[pos] === 0xff) pos++;
      const marker = buf[pos++];
      if (marker === undefined) throw new Corrupt("the file ends before the end-of-image marker");
      if (marker === 0xd9) {
        if (!frame || scanned.size === 0) throw new Corrupt("the file has no image data");
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) throw new Corrupt("a marker appears where it is not allowed");
      if (pos + 2 > buf.length) throw new Corrupt("a segment is cut off");
      const len = buf.readUInt16BE(pos);
      if (len < 2 || pos + len > buf.length) throw new Corrupt("a segment is cut off");
      const seg = buf.subarray(pos + 2, pos + len);
      const whole = buf.subarray(pos - 2, pos + len);
      pos += len;
      if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) continue; // APPn and comments: metadata, dropped
      if (marker === 0xdb) {
        for (let p = 0; p < seg.length; ) {
          const pq = seg[p]! >> 4;
          const tq = seg[p]! & 15;
          if (pq !== 0 || tq > 3) throw new Corrupt("only 8-bit quantization tables are accepted");
          if (p + 65 > seg.length) throw new Corrupt("a quantization table is cut off");
          quant.add(tq);
          p += 65;
        }
        out.push(whole);
        continue;
      }
      if (marker === 0xc4) {
        for (let p = 0; p < seg.length; ) {
          const tc = seg[p]! >> 4;
          const th = seg[p]! & 15;
          if (tc > 1 || th > 3 || p + 17 > seg.length) throw new Corrupt("a Huffman table is malformed");
          const counts = seg.subarray(p + 1, p + 17);
          const n = counts.reduce((a, c) => a + c, 0);
          if (n === 0 || n > 256 || p + 17 + n > seg.length) throw new Corrupt("a Huffman table is malformed");
          (tc === 0 ? dc : ac).set(th, buildHuffman(counts, seg.subarray(p + 17, p + 17 + n)));
          p += 17 + n;
        }
        out.push(whole);
        continue;
      }
      if (marker === 0xc0 || marker === 0xc1) {
        if (frame) throw new Corrupt("the file has more than one frame");
        if (seg.length < 6) throw new Corrupt("the frame header is cut off");
        if (seg[0] !== 8) throw new Corrupt("only 8-bit JPEG photos are accepted");
        const height = seg.readUInt16BE(1);
        const width = seg.readUInt16BE(3);
        const nf = seg[5]!;
        if (!width || !height) throw new Corrupt("the frame has no size");
        if (width > maxEdge || height > maxEdge || width * height > maxPixels) return fail("dimensions", `The photo is ${width}×${height} pixels; the limit is ${maxEdge} pixels on the longest edge (${maxPixels} pixels in all). Nothing was stored.`);
        if (nf !== 1 && nf !== 3) throw new Corrupt("only grayscale or colour (YCbCr) JPEG photos are accepted");
        if (seg.length !== 6 + 3 * nf) throw new Corrupt("the frame header is malformed");
        const comps: Component[] = [];
        for (let k = 0; k < nf; k++) {
          const id = seg[6 + 3 * k]!;
          const h = seg[7 + 3 * k]! >> 4;
          const v = seg[7 + 3 * k]! & 15;
          const tq = seg[8 + 3 * k]!;
          if (h < 1 || h > 2 || v < 1 || v > 2 || tq > 3 || comps.some((c) => c.id === id)) throw new Corrupt("the frame's components are malformed");
          comps.push({ id, h, v, tq });
        }
        frame = { width, height, comps, hmax: Math.max(...comps.map((c) => c.h)), vmax: Math.max(...comps.map((c) => c.v)) };
        if (comps.some((c) => !quant.has(c.tq))) throw new Corrupt("a quantization table is missing");
        out.push(whole);
        continue;
      }
      if (marker === 0xdd) {
        if (seg.length !== 2) throw new Corrupt("the restart interval is malformed");
        restart = seg.readUInt16BE(0);
        out.push(whole);
        continue;
      }
      if (marker === 0xda) {
        if (!frame) throw new Corrupt("image data comes before the frame header");
        const ns = seg[0]!;
        if (!ns || ns > 4 || seg.length !== 4 + 2 * ns) throw new Corrupt("a scan header is malformed");
        const f = frame;
        const comps = [];
        for (let k = 0; k < ns; k++) {
          const c = f.comps.find((x) => x.id === seg[1 + 2 * k]);
          const td = seg[2 + 2 * k]! >> 4;
          const ta = seg[2 + 2 * k]! & 15;
          if (!c || scanned.has(c.id)) throw new Corrupt("a scan names an unknown or repeated component");
          const d = dc.get(td);
          const a = ac.get(ta);
          if (!d || !a) throw new Corrupt("a scan uses a Huffman table that is not defined");
          const cw = Math.ceil((f.width * c.h) / f.hmax);
          const ch = Math.ceil((f.height * c.v) / f.vmax);
          comps.push({ c, dc: d, ac: a, blocksW: Math.ceil(cw / 8), blocksH: Math.ceil(ch / 8) });
        }
        if (seg[1 + 2 * ns] !== 0 || seg[2 + 2 * ns] !== 63 || seg[3 + 2 * ns] !== 0) throw new Corrupt("only baseline (sequential) scans are accepted");
        if (ns > 1 && comps.reduce((n, s) => n + s.c.h * s.c.v, 0) > 10) throw new Corrupt("a scan has too many blocks per unit");
        const end = decodeScan(buf, pos, comps, f, restart);
        out.push(whole, buf.subarray(pos, end));
        for (const s of comps) scanned.add(s.c.id);
        pos = end;
        continue;
      }
      if (marker >= 0xc2 && marker <= 0xcf) {
        return fail("format", "Only baseline JPEG photos are accepted (this one is progressive, arithmetic-coded or lossless). ORBIT's page re-encodes photos before upload; nothing was stored.");
      }
      throw new Corrupt(`an unsupported JPEG segment (0xFF${marker.toString(16).toUpperCase()}) was found`);
    }
  } catch (err) {
    if (err instanceof Corrupt) return fail("corrupt", `The photo could not be decoded: ${err.message}. Nothing was stored.`);
    if (err instanceof RangeError) return fail("corrupt", "The photo could not be decoded: a segment is cut off. Nothing was stored.");
    throw err;
  }
  if (!frame || frame.comps.some((c) => !scanned.has(c.id))) return fail("corrupt", "The photo could not be decoded: some colour channels have no image data. Nothing was stored.");
  out.push(Buffer.from([0xff, 0xd9]));
  const bytes = Buffer.concat(out);
  if (bytes.length > maxBytes) return fail("size", `The photo is ${bytes.length} bytes; the limit is ${maxBytes} bytes after processing.`);
  return { ok: true, bytes, width: frame.width, height: frame.height, components: frame.comps.length };
}

// Whether a buffer holds any segment that carries metadata (APPn other than the fixed JFIF header, or a comment). For tests and checks.
export function metadataSegments(buf: Uint8Array): string[] {
  const found: string[] = [];
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xff) {
    const m = buf[p + 1]!;
    if (m === 0xda || m === 0xd9) break;
    const len = (buf[p + 2]! << 8) | buf[p + 3]!;
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      const seg = Buffer.from(buf.subarray(p, p + 2 + len));
      if (!(m === 0xe0 && seg.equals(JFIF))) found.push(`0xFF${m.toString(16).toUpperCase()}`);
    }
    p += 2 + len;
  }
  return found;
}
