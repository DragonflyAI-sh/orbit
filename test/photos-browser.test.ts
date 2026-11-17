import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { attachmentStore } from "../src/attachments.ts";
import type { Attachments } from "../src/attachments.ts";
import { metadataSegments } from "../src/jpeg.ts";
import type { Message } from "../src/model.ts";
import { encodeJpeg, pattern, withMetadata } from "./jpeg-fixture.ts";
import { rig, say, scripted } from "./threads-fixture.ts";
import { pickSession } from "./helpers/sessions-ui.ts";

// Photo attachments in a real browser (Playwright's Chromium, emulating a phone-sized touch screen) against the REAL ORBIT server and
// the real page (src/web/index.html, src/web/photos.js). Only the model is scripted. Every image is synthetic. This is Chromium on
// Linux, not Safari on an iPhone: it shows the page logic, the canvas pipeline and the server together, not iOS behaviour (see
// docs/photos.md for the manual iPhone checklist). Skipped, and says so, where Playwright cannot be loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser photo tests skipped";

let browser: any;
before(async () => {
  if (skip) return;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); });

// A minimal PNG encoder (RGB, no filter) for synthetic test files.
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-browser-"));
  let store: Attachments | undefined;
  const model = Object.assign(scripted(async (seen) => say(`saw ${(seen.input.at(-1) as Message).images?.length ?? 0} photo(s)`)), { images: () => ({ ok: true, detail: "test" }) });
  const r = rig({ dir, model, extra: () => ({ assistantDir: join(dir, "assistant"), attachments: (store = attachmentStore(join(dir, "attachments"))) }) });
  return { r, model, store: () => store!, dir };
}
async function base(r: ReturnType<typeof rig>) {
  await r.api("/status");
  return `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
}
async function phonePage(url: string) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const uploads: Buffer[] = [];
  page.on("request", (req: any) => {
    if (req.method() === "POST" && /\/attachments$/.test(new URL(req.url()).pathname)) uploads.push(req.postDataBuffer());
  });
  await page.goto(url);
  return { page, ctx, uploads };
}
const file = (name: string, mimeType: string, buffer: Buffer) => ({ name, mimeType, buffer });

test("processing in the browser: no upscaling, bounded size and edge, orientation applied, metadata gone, bad formats refused", { skip }, async () => {
  const { r } = setup();
  const { page, ctx } = await phonePage(`${await base(r)}/#assistant`);
  await page.waitForFunction(() => Boolean((window as any).OrbitPhotos));
  // A large noisy PNG made in the page (12 MP): shrunk to 1600 px on the longest edge, JPEG, within the 500 KB target.
  const big = await page.evaluate(async () => {
    const c = new OffscreenCanvas(4000, 3000);
    const x = c.getContext("2d")!;
    const img = x.createImageData(4000, 3000);
    let s = 7;
    for (let i = 0; i < img.data.length; i += 4) { s = (s * 1103515245 + 12345) >>> 0; img.data[i] = s & 255; img.data[i + 1] = (s >> 8) & 255; img.data[i + 2] = ((i >> 2) % 4000) & 255; img.data[i + 3] = 255; }
    x.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    const out = await (window as any).OrbitPhotos.processFile(new File([blob], "big.png", { type: "image/png" }));
    return { inBytes: blob.size, w: out.width, h: out.height, bytes: out.blob.size, type: out.blob.type, attempts: out.attempts, quality: out.quality };
  });
  assert.equal(big.w, 1600);
  assert.equal(big.h, 1200);
  assert.equal(big.type, "image/jpeg");
  assert.ok(big.bytes <= 500 * 1024, `within target: ${big.bytes}`);
  assert.ok(big.attempts >= 1 && big.attempts <= 12, `bounded attempts: ${big.attempts}`);
  // A small image is never upscaled.
  const small = await page.evaluate(async () => {
    const c = new OffscreenCanvas(300, 200);
    c.getContext("2d")!.fillRect(0, 0, 10, 10);
    const out = await (window as any).OrbitPhotos.processFile(new File([await c.convertToBlob({ type: "image/png" })], "s.png"));
    return [out.width, out.height, out.quality];
  });
  assert.deepEqual(small, [300, 200, 0.8]);
  // A JPEG with EXIF orientation 6 (rotate 90°) and GPS: the output is upright (dimensions swapped) and carries no metadata.
  const rotated = withMetadata(encodeJpeg(64, 32, (x) => (x < 8 ? [255, 0, 0] : [0, 0, 255])), { orientation: 6, comment: "COMMENT-SECRET" });
  const rot = await page.evaluate(async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const out = await (window as any).OrbitPhotos.processFile(new File([bytes], "IMG_0001.JPG", { type: "image/jpeg" }));
    const buf = new Uint8Array(await out.blob.arrayBuffer());
    const bmp = await createImageBitmap(out.blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext("2d")!;
    x.drawImage(bmp, 0, 0);
    // After a 90° clockwise turn the red left edge is along the top.
    const top = [...x.getImageData(16, 2, 1, 1).data].slice(0, 3);
    const bottom = [...x.getImageData(16, 60, 1, 1).data].slice(0, 3);
    return { w: out.width, h: out.height, b64: btoa(String.fromCharCode(...buf)), top, bottom };
  }, rotated.toString("base64"));
  assert.deepEqual([rot.w, rot.h], [32, 64]);
  assert.ok(rot.top[0]! > 200 && rot.top[2]! < 60, `red on top: ${rot.top}`);
  assert.ok(rot.bottom[2]! > 200 && rot.bottom[0]! < 60, `blue below: ${rot.bottom}`);
  const out = Buffer.from(rot.b64, "base64");
  for (const m of ["Exif", "GPS-SECRET-PLACE", "FAKEPHONE", "COMMENT-SECRET"]) assert.equal(out.includes(m), false, m);
  // Formats this browser cannot decode, and files that are not photos, give an actionable error and produce nothing to upload.
  const errors = await page.evaluate(async () => {
    const P = (window as any).OrbitPhotos;
    const tryIt = async (bytes: Uint8Array<ArrayBuffer>, name: string) => { try { await P.processFile(new File([bytes], name)); return "no error"; } catch (e: any) { return `${e instanceof P.PhotoError}:${e.message}`; } };
    const heic = new Uint8Array(64); heic.set([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheicmif1")]);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const ihdr = new Uint8Array(64); ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x9c, 0x40, 0, 0, 0x9c, 0x40]);
    return { heic: await tryIt(heic, "IMG_0002.HEIC"), svg: await tryIt(svg, "x.svg"), bomb: await tryIt(ihdr, "bomb.png"), text: await tryIt(new TextEncoder().encode("hello"), "a.jpg") };
  });
  assert.match(errors.heic, /^true:This photo is HEIC\/HEIF and this browser cannot convert it\..*Most Compatible.*Nothing was uploaded/);
  assert.match(errors.svg, /^true:SVG and other markup files are not accepted/);
  assert.match(errors.bomb, /^true:The image is 40000×40000 pixels/);
  assert.match(errors.text, /^true:This file is not an image this page can read/);
  await ctx.close();
});

test("phone flow in the Assistant: pick, preview, remove, retry a failed upload, send ten with a caption, reload and see them", { skip }, async () => {
  const { r, model, store } = setup();
  const { page, ctx, uploads } = await phonePage(`${await base(r)}/#assistant`);
  await page.waitForFunction(() => !(document.getElementById("apickbtn") as HTMLButtonElement).disabled);
  // One image input behind the "+" button: multiple, no capture (does not force the camera; a phone offers library and
  // camera itself). There is no separate camera input or button.
  assert.equal(await page.getAttribute("#apick", "multiple"), "");
  assert.equal(await page.getAttribute("#apick", "capture"), null);
  assert.equal(await page.locator("#acam, #acambtn, #aform input[capture]").count(), 0);
  // The first upload fails (server error), the rest go through.
  let failNext = true;
  await page.route("**/assistant/attachments", async (route: any) => {
    if (failNext && route.request().method() === "POST") { failNext = false; return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disk hiccup" }) }); }
    return route.continue();
  });
  const originals = Array.from({ length: 11 }, (_, i) => (i % 2 ? file(`IMG_${i}.png`, "image/png", png(120 + i, 90, pattern(i))) : file(`IMG_${i}.jpg`, "image/jpeg", withMetadata(encodeJpeg(160, 120 + i, pattern(i)), { comment: "COMMENT-SECRET" }))));
  await page.setInputFiles("#apick", originals);
  // Eleven picked: ten kept, the eleventh refused with a note.
  await page.waitForSelector("#atray .phnote");
  assert.match(await page.textContent("#atray .phnote"), /At most 10 photos per message: 1 not added/);
  assert.equal(await page.locator("#atray .ph").count(), 10);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"], #atray .ph[data-status="failed"]').length === 10);
  // One failed: Send stays disabled and says why; Retry brings it to ready.
  assert.equal(await page.locator('#atray .ph[data-status="failed"]').count(), 1);
  assert.match(await page.textContent('#atray .ph[data-status="failed"] .phstatus'), /Failed \(upload\): disk hiccup/);
  assert.equal(await page.isDisabled("#asend"), true);
  assert.match(await page.textContent("#astatus"), /1 photo\(s\) failed\. Retry or remove them to send/);
  await page.click('#atray .ph[data-status="failed"] .phretry');
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"]').length === 10);
  // Remove photo 3: nine stay, in order.
  await page.click('#atray .ph:nth-child(3) .phx');
  assert.equal(await page.locator("#atray .ph").count(), 9);
  await page.setInputFiles("#apick", [file("extra.png", "image/png", png(50, 50, pattern(42)))]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"]').length === 10);
  assert.equal(await page.isDisabled("#asend"), false);
  const trayIds = await page.evaluate(() => (window as any).atray.ids());
  await page.fill("#ainput", "Which of these is in focus?");
  await page.click("#asend");
  await page.waitForFunction(() => document.querySelectorAll("#alog .photos img").length === 10);
  assert.equal(await page.locator("#atray .ph").count(), 0, "the tray is empty after sending");
  // The model got the caption and ten images, in the tray's order; every image is the processed bytes the server stored.
  const seen = model.seen.at(-1)!.input.at(-1) as Message;
  assert.match(seen.content, /^Which of these is in focus\?/);
  assert.deepEqual(seen.images!.map((i) => i.id), trayIds);
  for (const img of seen.images!) {
    const stored = store().read(img.id, "assistant")!;
    assert.ok(Buffer.from(img.data!, "base64").equals(stored));
  }
  // What went over the network: processed JPEGs only, never an original, no metadata, within the limits.
  assert.ok(uploads.length >= 11);
  for (const u of uploads) {
    assert.deepEqual([...u.subarray(0, 2)], [0xff, 0xd8]);
    assert.ok(u.length <= 500 * 1024);
    assert.equal(u.includes("COMMENT-SECRET"), false);
    assert.equal(originals.some((o) => o.buffer.equals(u)), false);
  }
  // After a reload (and a fresh page) the photos are drawn from the server and actually load.
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#alog .photos img").length === 10);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("#alog .photos img")].every((i) => i.complete && i.naturalWidth > 0));
  // Every stored photo is metadata-free.
  for (const id of trayIds) assert.deepEqual(metadataSegments(store().read(id, "assistant")!), []);
  // The page fits a phone: no horizontal scroll.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await ctx.close();
});

test("phone flow in Chat: photos go to the open thread only; switching threads drops unsent ones; text-only still works", { skip }, async () => {
  const { r, model } = setup();
  const a = await r.create("Alpha");
  const b = await r.create("Beta");
  const { page, ctx } = await phonePage(`${await base(r)}/#chat/${a.id}`);
  await page.waitForFunction((id: string) => document.getElementById("sessbtn")?.dataset.session === id && !(document.getElementById("pickbtn") as HTMLButtonElement).disabled, a.id);
  await page.fill("#input", "text only first");
  await page.press("#input", "Enter");
  await page.waitForFunction(() => document.body.textContent!.includes("saw 0 photo(s)"));
  assert.equal("images" in (model.seen.at(-1)!.input.at(-1) as object), false);
  await page.setInputFiles("#pick", [file("a.jpg", "image/jpeg", encodeJpeg(80, 60, pattern(1))), file("b.png", "image/png", png(70, 50, pattern(2)))]);
  await page.waitForFunction(() => document.querySelectorAll('#tray .ph[data-status="ready"]').length === 2);
  // Photos without a caption are fine.
  await page.click("#send");
  await page.waitForFunction(() => document.querySelectorAll("#log .photos img").length === 2);
  await page.waitForFunction(() => document.body.textContent!.includes("saw 2 photo(s)"));
  const imgs = await page.$$eval("#log .photos img", (els: HTMLImageElement[]) => els.map((e) => e.getAttribute("src")));
  for (const src of imgs) assert.match(src!, new RegExp(`^/threads/${a.id}/attachments/a[0-9a-f]{32}$`));
  // A photo picked in Alpha is dropped when Beta is opened, so it can never be sent there.
  await page.setInputFiles("#pick", [file("c.jpg", "image/jpeg", encodeJpeg(40, 40, pattern(3)))]);
  await page.waitForFunction(() => document.querySelectorAll('#tray .ph[data-status="ready"]').length === 1);
  await pickSession(page, b.id);
  await page.waitForFunction((id: string) => location.pathname === `/sessions/${id}`, b.id);
  await page.waitForFunction(() => document.querySelectorAll("#tray .ph").length === 0);
  assert.equal(await page.isHidden("#tray"), true);
  await ctx.close();
});
