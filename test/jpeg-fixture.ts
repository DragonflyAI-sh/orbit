// A small baseline JPEG encoder for tests: synthetic, non-private images made from a pixel function, with the standard tables of
// ITU T.81 Annex K. It can add the kinds of metadata a phone photo carries (EXIF with orientation and GPS, XMP, a comment) and
// trailing bytes, so tests can check exactly what the server strips. Nothing here reads a real photo.

const STD_DC_LUM = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const STD_DC_CHR = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const STD_AC_LUM = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  values: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const STD_AC_CHR = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  values: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const Q_LUM = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const Q_CHR = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

type Table = { counts: number[]; values: number[] };
function codes(t: Table): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let n = 0; n < t.counts[len - 1]!; n++) out.set(t.values[k++]!, [code++, len]);
    code <<= 1;
  }
  return out;
}

class Bits {
  bytes: number[] = [];
  acc = 0;
  n = 0;
  put(v: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >> i) & 1);
      if (++this.n === 8) this.flushByte();
    }
  }
  flushByte() {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0);
    this.acc = 0;
    this.n = 0;
  }
  pad() {
    while (this.n) this.put(1, 1);
  }
}

const seg = (marker: number, body: number[] | Buffer) => Buffer.from([0xff, marker, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body]);
const tableSeg = (cls: number, id: number, t: Table) => seg(0xc4, [(cls << 4) | id, ...t.counts, ...t.values]);

function fdct(block: number[]): number[] {
  const out = new Array(64).fill(0);
  for (let u = 0; u < 8; u++)
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) s += block[y * 8 + x]! * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      out[v * 8 + u] = 0.25 * cu * cv * s;
    }
  return out;
}

export type EncodeOpts = { gray?: boolean; subsample?: boolean; restart?: number; quality?: number };

// Encodes width×height pixels given by `px(x, y) -> [r, g, b]` as a baseline JPEG.
export function encodeJpeg(width: number, height: number, px: (x: number, y: number) => [number, number, number], o: EncodeOpts = {}): Buffer {
  const scale = o.quality ? (o.quality < 50 ? 5000 / o.quality : 200 - 2 * o.quality) / 100 : 1;
  const q = (t: number[]) => t.map((v) => Math.min(255, Math.max(1, Math.round(v * scale))));
  const ql = q(Q_LUM);
  const qc = q(Q_CHR);
  const comps = o.gray ? [{ id: 1, h: 1, v: 1, tq: 0, td: 0 }] : [{ id: 1, h: o.subsample ? 2 : 1, v: o.subsample ? 2 : 1, tq: 0, td: 0 }, { id: 2, h: 1, v: 1, tq: 1, td: 1 }, { id: 3, h: 1, v: 1, tq: 1, td: 1 }];
  const hmax = Math.max(...comps.map((c) => c.h));
  const vmax = Math.max(...comps.map((c) => c.v));
  const sample = (ci: number, x: number, y: number) => {
    const [r, g, b] = px(Math.min(width - 1, x), Math.min(height - 1, y));
    if (ci === 0) return 0.299 * r + 0.587 * g + 0.114 * b;
    if (ci === 1) return -0.1687 * r - 0.3313 * g + 0.5 * b + 128;
    return 0.5 * r - 0.4187 * g - 0.0813 * b + 128;
  };
  const dcTabs = [codes(STD_DC_LUM), codes(STD_DC_CHR)];
  const acTabs = [codes(STD_AC_LUM), codes(STD_AC_CHR)];
  const pred = comps.map(() => 0);
  const bits = new Bits();
  const sizeOf = (v: number) => (v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v))) + 1);
  const emitVal = (v: number, s: number) => bits.put(v < 0 ? v + (1 << s) - 1 : v, s);
  const encodeBlock = (ci: number, bx: number, by: number) => {
    const c = comps[ci]!;
    const blk: number[] = [];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        // Chroma blocks average the pixels they cover when subsampled.
        const sx = hmax / c.h;
        const sy = vmax / c.v;
        let s = 0;
        for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) s += sample(ci, (bx * 8 + x) * sx + dx, (by * 8 + y) * sy + dy);
        blk.push(s / (sx * sy) - 128);
      }
    const d = fdct(blk);
    const qt = c.tq === 0 ? ql : qc;
    const z = ZIGZAG.map((i) => Math.round(d[i]! / qt[i]!));
    const diff = z[0]! - pred[ci]!;
    pred[ci] = z[0]!;
    const s = sizeOf(diff);
    const [dcode, dlen] = dcTabs[c.td]!.get(s)!;
    bits.put(dcode, dlen);
    emitVal(diff, s);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      if (z[k] === 0) {
        run++;
        continue;
      }
      while (run > 15) {
        const [c15, l15] = acTabs[c.td]!.get(0xf0)!;
        bits.put(c15, l15);
        run -= 16;
      }
      const sz = sizeOf(z[k]!);
      const [ac, al] = acTabs[c.td]!.get((run << 4) | sz)!;
      bits.put(ac, al);
      emitVal(z[k]!, sz);
      run = 0;
    }
    if (run) {
      const [eob, el] = acTabs[c.td]!.get(0)!;
      bits.put(eob, el);
    }
  };
  const mcusX = Math.ceil(width / (8 * hmax));
  const mcusY = Math.ceil(height / (8 * vmax));
  let mcu = 0;
  let rst = 0;
  for (let my = 0; my < mcusY; my++)
    for (let mx = 0; mx < mcusX; mx++) {
      if (o.restart && mcu > 0 && mcu % o.restart === 0) {
        bits.pad();
        bits.bytes.push(0xff, 0xd0 + rst);
        rst = (rst + 1) & 7;
        pred.fill(0);
      }
      comps.forEach((c, ci) => {
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) encodeBlock(ci, mx * c.h + h, my * c.v + v);
      });
      mcu++;
    }
  bits.pad();
  const scan = Buffer.from(bits.bytes);
  const parts = [
    Buffer.from([0xff, 0xd8]),
    seg(0xdb, [0x00, ...ZIGZAG.map((i) => ql[i]!), ...(o.gray ? [] : [0x01, ...ZIGZAG.map((i) => qc[i]!)])]),
    seg(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, comps.length, ...comps.flatMap((c) => [c.id, (c.h << 4) | c.v, c.tq])]),
    tableSeg(0, 0, STD_DC_LUM),
    tableSeg(1, 0, STD_AC_LUM),
    ...(o.gray ? [] : [tableSeg(0, 1, STD_DC_CHR), tableSeg(1, 1, STD_AC_CHR)]),
    ...(o.restart ? [seg(0xdd, [o.restart >> 8, o.restart & 255])] : []),
    seg(0xda, [comps.length, ...comps.flatMap((c) => [c.id, (c.td << 4) | c.td]), 0, 63, 0]),
    scan,
    Buffer.from([0xff, 0xd9]),
  ];
  return Buffer.concat(parts);
}

// A small EXIF APP1 with an orientation tag and a GPS IFD holding a made-up position, as a phone camera would write.
export function exifSegment(orientation = 6): Buffer {
  const tiff: number[] = [];
  const u16 = (v: number) => tiff.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => tiff.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  // Big-endian TIFF header, IFD0 at offset 8.
  tiff.push(0x4d, 0x4d);
  u16(42);
  u32(8);
  // IFD0: Orientation, Make, GPSInfo pointer.
  u16(3);
  u16(0x0112), u16(3), u32(1), u16(orientation), u16(0);
  u16(0x010f), u16(2), u32(12), u32(8 + 2 + 3 * 12 + 4);
  u16(0x8825), u16(4), u32(1), u32(8 + 2 + 3 * 12 + 4 + 12);
  u32(0);
  tiff.push(...Buffer.from("FAKEPHONE-X\0"));
  // GPS IFD: latitude ref N and a marker string tests look for.
  u16(2);
  u16(0x0001), u16(2), u32(2), tiff.push(0x4e, 0, 0, 0);
  u16(0x001b), u16(7), u32(16), u32(8 + 2 + 3 * 12 + 4 + 12 + 2 + 2 * 12 + 4);
  u32(0);
  tiff.push(...Buffer.from("GPS-SECRET-PLACE"));
  return seg(0xe1, [...Buffer.from("Exif\0\0"), ...tiff]);
}

// Inserts segments (EXIF, XMP, a comment) right after SOI and appends trailing bytes after EOI.
export function withMetadata(jpeg: Buffer, opts: { exif?: boolean; xmp?: boolean; comment?: string; trailing?: string; orientation?: number } = {}): Buffer {
  const extra: Buffer[] = [];
  if (opts.exif !== false) extra.push(exifSegment(opts.orientation ?? 6));
  if (opts.xmp) extra.push(seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>XMP-SECRET</x:xmpmeta>")));
  if (opts.comment) extra.push(seg(0xfe, Buffer.from(opts.comment)));
  return Buffer.concat([jpeg.subarray(0, 2), ...extra, jpeg.subarray(2), ...(opts.trailing ? [Buffer.from(opts.trailing)] : [])]);
}

// A deterministic, non-private test pattern: gradients and a few bars, different for each `seed`.
export const pattern = (seed = 0) => (x: number, y: number): [number, number, number] => [(x * 3 + seed * 40) & 255, (y * 2 + seed * 17) & 255, ((x + y) * (seed + 1)) & 255];

export const smallJpeg = (seed = 0, w = 48, h = 32, o: EncodeOpts = {}) => encodeJpeg(w, h, pattern(seed), o);

// ---- marker-layout helpers (for real encoder output too) ----------------------------------------------------------------------

// The marker segments before the first scan, and the rest of the file from that scan's SOS on.
export function headerSegments(jpeg: Buffer): { segs: Buffer[]; rest: Buffer } {
  const segs: Buffer[] = [];
  let p = 2;
  while (jpeg[p] === 0xff && jpeg[p + 1] !== 0xda) {
    const len = jpeg.readUInt16BE(p + 2);
    segs.push(jpeg.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  return { segs, rest: jpeg.subarray(p) };
}

// Rewrites the header of a JPEG into other layouts that ITU T.81 allows and real encoders use:
// - dqtAfterSof: every quantization table segment moves to just after the frame header (allowed: a table only has to be in place
//   before the first scan that uses it, T.81 B.2.2);
// - merge: all quantization tables into one DQT segment and all Huffman tables into one DHT segment.
// Only the order and grouping of segments change; every table and every scan byte stays the same.
export function relayout(jpeg: Buffer, o: { dqtAfterSof?: boolean; merge?: boolean }): Buffer {
  const { segs, rest } = headerSegments(jpeg);
  let dqt = segs.filter((s) => s[1] === 0xdb);
  let dht = segs.filter((s) => s[1] === 0xc4);
  const isSof = (s: Buffer) => s[1]! >= 0xc0 && s[1]! <= 0xc2;
  if (o.merge) {
    const join = (m: number, list: Buffer[]) => (list.length ? [seg(m, Buffer.concat(list.map((s) => s.subarray(4))))] : []);
    dqt = join(0xdb, dqt);
    dht = join(0xc4, dht);
  }
  const other = segs.filter((s) => s[1] !== 0xdb && s[1] !== 0xc4 && !isSof(s));
  const sof = segs.find(isSof)!;
  const order = o.dqtAfterSof ? [...other, ...dht, sof, ...dqt] : [...other, ...dqt, sof, ...dht];
  return Buffer.concat([jpeg.subarray(0, 2), ...order, rest]);
}

// Removes every header segment with the given marker (for example all quantization tables).
export function withoutSegments(jpeg: Buffer, marker: number): Buffer {
  const { segs, rest } = headerSegments(jpeg);
  return Buffer.concat([jpeg.subarray(0, 2), ...segs.filter((s) => s[1] !== marker), rest]);
}

// The marker bytes (second byte of each FFxx) before the first scan, for asserting layouts.
export const layoutOf = (jpeg: Uint8Array) => headerSegments(Buffer.from(jpeg)).segs.map((s) => s[1]!);
