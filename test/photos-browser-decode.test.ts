import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { attachmentStore } from "../src/attachments.ts";
import type { Attachments } from "../src/attachments.ts";
import { metadataSegments, normalizeJpeg } from "../src/jpeg.ts";
import type { Message } from "../src/model.ts";
import { encodeJpeg, layoutOf, pattern, relayout, withMetadata } from "./jpeg-fixture.ts";
import { rig, say, scripted } from "./threads-fixture.ts";

// The photo pipeline in a real browser (Playwright's Chromium) against the real ORBIT server, for the decode regression
// ("a quantization table is missing", docs/photos.md "JPEG layouts"). Chromium's canvas encoder (libjpeg-turbo) writes DQT before
// SOF, so the layouts other encoders write are SIMULATED here by rewriting what Chromium's canvas returned (only segment order and
// grouping change). Safari/WebKit and iPhone are NOT exercised: Playwright's WebKit is not installed here and it would not be iOS
// either. HEIC "decode supported" is SIMULATED by stubbing createImageBitmap. Skipped, and says so, where Playwright is missing.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser photo tests skipped";
let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

const FIX = new URL("./fixtures/photos/", import.meta.url);
const real = (name: string) => readFileSync(new URL(name, FIX));
const file = (name: string, mimeType: string, buffer: Buffer) => ({ name, mimeType, buffer });
const heicHeader = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic\0\0\0\0mif1heic"), Buffer.alloc(200)]);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-bdecode-"));
  let store: Attachments | undefined;
  const model = Object.assign(scripted(async (seen) => say(`saw ${(seen.input.at(-1) as Message).images?.length ?? 0} photo(s)`)), { images: () => ({ ok: true, detail: "test" }) });
  const r = rig({ dir, model, extra: () => ({ assistantDir: join(dir, "assistant"), attachments: (store = attachmentStore(join(dir, "attachments"))) }) });
  return { r, model, store: () => store! };
}
async function open(r: ReturnType<typeof rig>) {
  await r.api("/status");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  // Captured through request interception: Chromium only exposes a Blob request body to Playwright when the request is routed.
  const uploads: Buffer[] = [];
  await page.route("**/attachments", async (route: any) => {
    if (route.request().method() === "POST") uploads.push(route.request().postDataBuffer());
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:${(r.server.address() as AddressInfo).port}/#assistant`);
  await page.waitForFunction(() => Boolean((window as any).OrbitPhotos) && !(document.getElementById("apickbtn") as HTMLButtonElement).disabled);
  return { page, ctx, uploads };
}

// In-page: make every canvas JPEG encode go through `mode` (a rewrite of what the browser's encoder produced). Installed as an
// init-free override so the page's own code path (processFile -> encode -> finish) is what runs.
async function rewriteEncoder(page: any, mode: string, payloadB64 = "") {
  await page.evaluate(({ mode, payloadB64 }: { mode: string; payloadB64: string }) => {
    const w = window as any;
    const segs = (b: Uint8Array) => {
      const out: Uint8Array[] = [];
      let p = 2;
      while (b[p] === 0xff && b[p + 1] !== 0xda) { const l = (b[p + 2]! << 8) | b[p + 3]!; out.push(b.subarray(p, p + 2 + l)); p += 2 + l; }
      return { out, rest: b.subarray(p) };
    };
    const rewrite = (b: Uint8Array): Uint8Array => {
      if (mode === "dqt-after-sof") {
        const { out, rest } = segs(b);
        const isSof = (s: Uint8Array) => s[1]! >= 0xc0 && s[1]! <= 0xc2;
        const order = [...out.filter((s) => s[1] !== 0xdb && !isSof(s)), out.find(isSof)!, ...out.filter((s) => s[1] === 0xdb)];
        const parts = [b.subarray(0, 2), ...order, rest];
        const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
        let o = 0;
        for (const x of parts) { all.set(x, o); o += x.length; }
        return all;
      }
      if (mode === "no-dqt") {
        const { out, rest } = segs(b);
        const parts = [b.subarray(0, 2), ...out.filter((s) => s[1] !== 0xdb), rest];
        const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
        let o = 0;
        for (const x of parts) { all.set(x, o); o += x.length; }
        return all;
      }
      if (mode === "payload") return Uint8Array.from(atob(payloadB64), (c) => c.charCodeAt(0));
      return b;
    };
    if (!w.__origConvert) { w.__origConvert = OffscreenCanvas.prototype.convertToBlob; w.__origToBlob = HTMLCanvasElement.prototype.toBlob; }
    if (mode === "off") {
      OffscreenCanvas.prototype.convertToBlob = w.__origConvert;
      HTMLCanvasElement.prototype.toBlob = w.__origToBlob;
      return;
    }
    OffscreenCanvas.prototype.convertToBlob = async function (this: OffscreenCanvas, opts?: ImageEncodeOptions) {
      const blob: Blob = await w.__origConvert.call(this, opts);
      if (opts?.type !== "image/jpeg") return blob;
      return new Blob([rewrite(new Uint8Array(await blob.arrayBuffer())) as BlobPart], { type: "image/jpeg" });
    };
  }, { mode, payloadB64 });
}

test("real Chromium canvas output passes the page's own check and the server unchanged in content; upload bytes are intact", { skip }, async () => {
  const { r, store } = setup();
  const { page, ctx, uploads } = await open(r);
  const input = withMetadata(encodeJpeg(320, 240, pattern(3), { subsample: true }), { exif: true, comment: "COMMENT-SECRET" });
  await page.setInputFiles("#apick", [file("IMG_0101.JPG", "image/jpeg", input)]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"]').length === 1);
  const diag = await page.evaluate(() => (window as any).atray.diagnostics());
  assert.deepEqual(diag, [{ status: "ready", stage: null, input: "jpeg", encoding: "baseline" }]);
  assert.equal(uploads.length, 1);
  const posted = uploads[0]!;
  // The posted bytes are a valid baseline JPEG from Chromium's encoder; the server stored exactly their normalization.
  assert.deepEqual(layoutOf(posted).filter((m) => m === 0xdb || m === 0xc0 || m === 0xc4).slice(0, 3), [0xdb, 0xdb, 0xc0]);
  const id = (await page.evaluate(() => (window as any).atray.ids()))[0];
  const stored = store().read(id, "assistant")!;
  const n = normalizeJpeg(posted);
  assert.ok(n.ok);
  if (n.ok) assert.deepEqual(stored, n.bytes);
  assert.deepEqual(metadataSegments(stored), []);
  for (const m of ["Exif", "GPS-SECRET-PLACE", "COMMENT-SECRET"]) assert.equal(posted.includes(m) || stored.includes(m), false, m);
  // The page's inspectJpeg agrees on the bytes that were sent.
  const inspected = await page.evaluate((b64: string) => (window as any).OrbitPhotos.inspectJpeg(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))), posted.toString("base64"));
  assert.equal(inspected.ok, true);
  await ctx.close();
});

test("Chromium decodes a JPEG with DQT after SOF; such encoder output now uploads and is stored (the regression)", { skip }, async () => {
  const { r, store } = setup();
  const { page, ctx, uploads } = await open(r);
  // The browser itself decodes that layout (as libjpeg does): same size, same pixels as the conventional layout.
  const moved = relayout(real("im-baseline-420.jpg"), { dqtAfterSof: true });
  const same = await page.evaluate(async ([a, b]: string[]) => {
    const px = async (b64: string) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext("2d")!;
      x.drawImage(bmp, 0, 0);
      return [bmp.width, bmp.height, ...x.getImageData(0, 0, bmp.width, bmp.height).data];
    };
    const [p, q] = [await px(a!), await px(b!)];
    return p.length === q.length && p.every((v, i) => v === q[i]) ? p.slice(0, 2) : null;
  }, [real("im-baseline-420.jpg").toString("base64"), moved.toString("base64")]);
  assert.deepEqual(same, [160, 120]);
  // Simulate a browser encoder that writes that layout: the page's check accepts it and the server stores it.
  await rewriteEncoder(page, "dqt-after-sof");
  await page.setInputFiles("#apick", [file("IMG_0102.JPG", "image/jpeg", encodeJpeg(200, 150, pattern(5)))]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"], #atray .ph[data-status="failed"]').length === 1);
  assert.equal(await page.locator('#atray .ph[data-status="ready"]').count(), 1, await page.textContent("#atray"));
  const posted = uploads[0]!;
  const sof = layoutOf(posted).indexOf(0xc0);
  assert.ok(layoutOf(posted).slice(sof).includes(0xdb), "what was sent had DQT after SOF");
  const id = (await page.evaluate(() => (window as any).atray.ids()))[0];
  const stored = store().read(id, "assistant")!;
  assert.ok(layoutOf(stored).lastIndexOf(0xdb) < layoutOf(stored).indexOf(0xc0), "stored with tables first");
  // The stored copy decodes in the browser after a send and reload.
  await page.fill("#ainput", "what is this?");
  await page.click("#asend");
  await page.waitForFunction(() => document.querySelectorAll("#alog .photos img").length === 1);
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("#alog .photos img")].length === 1 && [...document.querySelectorAll<HTMLImageElement>("#alog .photos img")].every((i) => i.complete && i.naturalWidth === 200));
  await ctx.close();
});

test("a progressive JPEG from the encoder is checked and stored; a JPEG without tables, or a non-JPEG, is stopped before upload", { skip }, async () => {
  const { r } = setup();
  const { page, ctx, uploads } = await open(r);
  // Encoder returns a real progressive JPEG of the canvas size (160×120): accepted by the page and the server.
  await rewriteEncoder(page, "payload", real("im-progressive-420.jpg").toString("base64"));
  await page.setInputFiles("#apick", [file("a.png", "image/png", real("im-baseline-420.jpg"))]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"]').length === 1);
  assert.deepEqual((await page.evaluate(() => (window as any).atray.diagnostics()))[0], { status: "ready", stage: null, input: "jpeg", encoding: "progressive" });
  assert.equal(uploads.length, 1);
  // Encoder output with its quantization tables missing: refused at the "check" stage, nothing uploaded.
  await rewriteEncoder(page, "no-dqt");
  await page.setInputFiles("#apick", [file("b.jpg", "image/jpeg", encodeJpeg(90, 60, pattern(6)))]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="failed"]').length === 1);
  const failed = '#atray .ph[data-status="failed"]';
  assert.equal(await page.getAttribute(failed, "data-stage"), "check");
  assert.match(await page.textContent(`${failed} .phstatus`), /^Failed \(checking the JPEG\): This browser produced a JPEG that ORBIT cannot store \(a quantization table is missing\)\..*Nothing was uploaded\./);
  assert.equal(uploads.length, 1, "nothing uploaded for the failed photo");
  assert.equal(await page.isDisabled("#asend"), true);
  // Retry once the encoder is back to normal: ready, uploaded (failure recovery).
  await rewriteEncoder(page, "off");
  await page.click(`${failed} .phretry`);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"]').length === 2);
  assert.equal(uploads.length, 2);
  // An "encoder" that hands back PNG bytes labelled image/jpeg: refused at "encode", the PNG is never uploaded as a JPEG.
  await rewriteEncoder(page, "payload", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64"));
  await page.setInputFiles("#apick", [file("c.jpg", "image/jpeg", encodeJpeg(90, 60, pattern(7)))]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="failed"]').length === 1);
  assert.equal(await page.getAttribute(failed, "data-stage"), "encode");
  assert.match(await page.textContent(`${failed} .phstatus`), /^Failed \(converting to JPEG\): This browser produced PNG instead of a JPEG/);
  assert.equal(uploads.length, 2);
  await ctx.close();
});

test("mixed batch: PNG, camera JPEG with GPS, progressive JPEG, HEIC and mislabelled files keep their order; only processed JPEGs go up", { skip }, async () => {
  const { r, model, store } = setup();
  const { page, ctx, uploads } = await open(r);
  const camera = withMetadata(encodeJpeg(400, 300, pattern(8), { subsample: true }), { exif: true, orientation: 6, comment: "COMMENT-SECRET" });
  const files = [
    file("IMG_0201.PNG", "image/png", real("im-baseline-420.jpg")),            // a JPEG named and typed as PNG: judged by its bytes
    file("IMG_0202.JPG", "image/jpeg", camera),             // EXIF orientation 6 + GPS
    file("IMG_0203.JPG", "image/jpeg", real("im-progressive-444.jpg")),
    file("IMG_0204.JPG", "image/jpeg", heicHeader()),       // HEIC bytes typed as JPEG: refused before upload (Chromium cannot decode HEIC)
    file("IMG_0205.HEIC", "image/heic", real("ffmpeg-baseline-420.jpg")), // a JPEG named and typed HEIC: processed as the JPEG it is
  ];
  await page.setInputFiles("#apick", files);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"], #atray .ph[data-status="failed"]').length === 5);
  const diag = await page.evaluate(() => (window as any).atray.diagnostics());
  assert.deepEqual(diag.map((d: any) => [d.status, d.stage, d.input]), [["ready", null, "jpeg"], ["ready", null, "jpeg"], ["ready", null, "jpeg"], ["failed", "decode", null], ["ready", null, "jpeg"]]);
  assert.match(await page.textContent('#atray .ph:nth-child(4) .phstatus'), /^Failed \(opening the photo\): This photo is HEIC\/HEIF and this browser cannot convert it/);
  // Diagnostics are bounded and carry no names, paths or bytes.
  assert.equal(/IMG_|\.JPG|\.HEIC|base64|blob:/.test(JSON.stringify(diag)), false);
  assert.equal(uploads.length, 4, "the HEIC file was never uploaded");
  for (const u of uploads) {
    assert.deepEqual([...u.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    for (const m of ["Exif", "GPS-SECRET-PLACE", "COMMENT-SECRET", "ftyp"]) assert.equal(u.includes(m), false, m);
    assert.equal(files.some((f) => f.buffer.equals(u)), false, "never an original");
  }
  // Remove the failed one; the rest keep their order and are sent in it.
  await page.click("#atray .ph:nth-child(4) .phx");
  const ids = await page.evaluate(() => (window as any).atray.ids());
  assert.equal(ids.length, 4);
  await page.fill("#ainput", "describe them");
  await page.click("#asend");
  await page.waitForFunction(() => document.body.textContent!.includes("saw 4 photo(s)"));
  const seen = model.seen.at(-1)!.input.at(-1) as Message;
  assert.deepEqual(seen.images!.map((i) => i.id), ids);
  for (const img of seen.images!) {
    const bytes = Buffer.from(img.data!, "base64");
    assert.deepEqual(bytes, store().read(img.id, "assistant"));
    assert.deepEqual(metadataSegments(bytes), []);
    assert.ok(normalizeJpeg(bytes).ok, "model-bound bytes are a valid processed JPEG");
  }
  // The camera photo was turned upright (orientation 6): 300×400 after processing.
  const upright = normalizeJpeg(Buffer.from(seen.images![1]!.data!, "base64"));
  assert.ok(upright.ok && upright.width === 300 && upright.height === 400);
  await ctx.close();
});

test("SIMULATED: where the browser can decode HEIC (as Safari can), the photo is converted to JPEG; HEIC bytes are never sent", { skip }, async () => {
  const { r, store } = setup();
  const { page, ctx, uploads } = await open(r);
  // Stand-in for Safari's HEIC decoder: createImageBitmap returns a drawn 640×480 bitmap for a file whose bytes say HEIC.
  await page.evaluate(() => {
    const orig = window.createImageBitmap.bind(window);
    (window as any).createImageBitmap = async (src: any, ...rest: any[]) => {
      if (src instanceof Blob) {
        const head = new Uint8Array(await src.slice(4, 12).arrayBuffer());
        if (String.fromCharCode(...head) === "ftypheic") {
          const c = new OffscreenCanvas(640, 480);
          const x = c.getContext("2d")!;
          x.fillStyle = "#3a6";
          x.fillRect(0, 0, 640, 480);
          return orig(c);
        }
      }
      return orig(src, ...rest);
    };
  });
  await page.setInputFiles("#apick", [file("IMG_0301.HEIC", "image/heic", heicHeader())]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"]').length === 1);
  assert.deepEqual((await page.evaluate(() => (window as any).atray.diagnostics()))[0], { status: "ready", stage: null, input: "heic", encoding: "baseline" });
  assert.equal(uploads.length, 1);
  assert.deepEqual([...uploads[0]!.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal(uploads[0]!.includes("ftyp"), false);
  const id = (await page.evaluate(() => (window as any).atray.ids()))[0];
  const stored = store().read(id, "assistant")!;
  const n = normalizeJpeg(stored);
  assert.ok(n.ok && n.width === 640 && n.height === 480);
  await ctx.close();
});
