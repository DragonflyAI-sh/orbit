import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { attachmentStore } from "../src/attachments.ts";
import type { Message } from "../src/model.ts";
import { photoRef } from "../src/photo-access.ts";
import { smallJpeg } from "./jpeg-fixture.ts";
import { call, rig, say, scripted } from "./threads-fixture.ts";

// Displayed photo galleries (docs/photo-recall.md) in a real browser: Playwright's Chromium at a phone and a desktop size, against the
// REAL server and page, with a scripted model that calls photos_show. Every image is synthetic. This is Chromium on Linux: it shows
// the page logic and the server together, not Safari on an iPhone. Skipped, and says so, where Playwright cannot be loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser gallery tests skipped";

let browser: any;
before(async () => {
  if (skip) return;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); });

const HOSTILE_TITLE = "Garden <img src=x onerror=\"window.__pwned=1\"> plans";

// A server with one chat thread holding three photos, and an Assistant reply that showed them (in the order 3, 1, 2).
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-recall-browser-"));
  let show: string[] = [];
  const model = Object.assign(
    scripted(async (seen) => {
      const last = seen.input.at(-1) as any;
      if (last?.type === "function_call_output") return say("Here they are. (Displayed only; I have not looked at them.)");
      if ((last as Message)?.role === "user" && /show/i.test(String(last.content))) return { text: "", calls: [call("photos_show", { refs: show }, `show_${seen.input.length}`)] };
      return say("Got them.");
    }),
    { images: () => ({ ok: true, detail: "test" }) },
  );
  const r = rig({ dir, model, extra: () => ({ assistantDir: join(dir, "assistant"), attachments: attachmentStore(join(dir, "attachments")) }) });
  await r.api("/status");
  const base = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
  const t = await r.create(HOSTILE_TITLE);
  const ids: string[] = [];
  for (const s of [11, 12, 13]) {
    const res = await fetch(`${base}/threads/${t.id}/attachments`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(smallJpeg(s, 64 + s, 48)) });
    ids.push(((await res.json()) as any).attachment.id);
  }
  assert.equal((await r.api(`/threads/${t.id}/messages`, "POST", { text: "tomato bed <b>caption</b>", attachments: ids })).status, 200);
  const refs = ids.map(photoRef);
  show = [refs[2]!, refs[0]!, refs[1]!];
  assert.equal((await r.api("/assistant/messages", "POST", { text: "Show me the garden photos" })).status, 200);
  return { r, dir, base, thread: t, ids, refs, show, setShow: (x: string[]) => void (show = x) };
}

const sizes = [
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
];

for (const size of sizes) {
  test(`gallery (${size.name}): stored photos load in order, enlarge on tap, link to their source, survive a reload, and degrade to placeholders`, { skip }, async () => {
    const s = await setup();
    const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 1, isMobile: size.isMobile, hasTouch: size.hasTouch });
    const page = await ctx.newPage();
    const imageRequests: string[] = [];
    page.on("request", (req: any) => { if (req.resourceType() === "image") imageRequests.push(new URL(req.url()).pathname); });
    await page.goto(`${s.base}/#assistant`);
    const loaded = async () => {
      await page.waitForSelector("#alog .gallery figure.gitem");
      await page.waitForFunction(() => [...document.querySelectorAll("#alog .gallery figure[data-status=ok] img")].every((i: any) => i.complete && i.naturalWidth > 0));
    };
    await loaded();
    const order = await page.$$eval("#alog .gallery figure.gitem", (fs: any[]) => fs.map((f) => [f.dataset.ref, f.dataset.status]));
    assert.deepEqual(order, s.show.map((r) => [r, "ok"]));
    // The images came from the Assistant's display route only: no attachment ids, data URLs or other hosts.
    const galleryImgs = imageRequests.filter((p) => p.startsWith("/assistant/photos/"));
    assert.deepEqual([...new Set(galleryImgs)].sort(), [...s.show].map((r) => `/assistant/photos/${r}`).sort());
    const srcs = await page.$$eval("#alog .gallery img", (is: any[]) => is.map((i) => i.getAttribute("src")));
    for (const src of srcs) assert.match(src, /^\/assistant\/photos\/ph_[0-9a-f]{32}$/);
    // Labels: position, source title as text (never markup), the caption as text, and a link to the source thread.
    const caption = await page.$eval("#alog .gallery figure.gitem figcaption", (c: any) => c.textContent);
    assert.match(caption, /^1 of 3 · “Garden <img src=x onerror="window.__pwned=1"> plans” · sent /);
    assert.match(caption, /Caption: tomato bed <b>caption<\/b>/);
    assert.equal(await page.$$eval("#alog .gallery figcaption img, .gallery figcaption b", (x: any[]) => x.length), 0, "no markup from titles or captions");
    assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
    assert.equal(await page.$eval("#alog .gallery figure.gitem figcaption a", (a: any) => a.getAttribute("href")), `#chat/${s.thread.id}`);
    assert.match(await page.$eval("#alog .gallery .gnote", (n: any) => n.textContent), /does not mean the model looked at it/);
    // No horizontal scroll at this width.
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll");
    // Tap to enlarge: a full view of the same stored photo, closed with Escape (or the close button).
    await page.click("#alog .gallery figure.gitem:nth-of-type(2) .gthumb");
    await page.waitForFunction(() => { const i: any = document.querySelector(".gviewer img"); return i && i.complete && i.naturalWidth > 0; });
    assert.equal(await page.$eval(".gviewer img", (i: any) => i.getAttribute("src")), `/assistant/photos/${s.show[1]}`);
    assert.match(await page.$eval(".gviewer .glabel", (l: any) => l.textContent), /^2 of 3/);
    const box = await page.$eval(".gviewer img", (i: any) => { const r = i.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert.ok(box.w <= size.viewport.width && box.h <= size.viewport.height, "the enlarged photo fits the screen");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".gviewer"));
    await page.click("#alog .gallery figure.gitem:nth-of-type(1) .gthumb");
    await page.click(".gviewer button");
    await page.waitForFunction(() => !document.querySelector(".gviewer"));
    // Reload: the gallery is read back from the server, same order.
    await page.reload();
    await loaded();
    assert.deepEqual(await page.$$eval("#alog .gallery figure.gitem", (fs: any[]) => fs.map((f) => f.dataset.ref)), s.show);
    // A file removed on the server: the view says unavailable, and the page shows a placeholder at its position, not a broken image.
    unlinkSync(join(s.dir, "attachments", `${s.ids[0]}.jpg`));
    // And a fetch that fails after the view (simulated revocation between the view and the image request): a placeholder too.
    await page.route(`**/assistant/photos/${s.show[2]}`, (route: any) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.reload();
    await page.waitForSelector("#alog .gallery figure[data-status=unavailable]");
    await page.waitForSelector("#alog .gallery figure[data-status=failed]");
    const states = await page.$$eval("#alog .gallery figure.gitem", (fs: any[]) => fs.map((f) => [f.dataset.ref, f.dataset.status]));
    assert.deepEqual(states, [[s.show[0], "ok"], [s.show[1], "unavailable"], [s.show[2], "failed"]]);
    assert.match(await page.$eval("#alog .gallery figure[data-status=unavailable] .gmissing", (m: any) => m.textContent), /missing or damaged/);
    assert.match(await page.$eval("#alog .gallery figure[data-status=failed] .gmissing", (m: any) => m.textContent), /could not be loaded/);
    assert.equal(await page.$$eval("#alog .gallery figure[data-status=failed] img", (x: any[]) => x.length), 0);
    // "Show the second one again" in a later turn: a new one-photo gallery of that ref; the earlier gallery is unchanged.
    s.setShow([s.show[1]!]);
    await page.unroute(`**/assistant/photos/${s.show[2]}`);
    assert.equal((await s.r.api("/assistant/messages", "POST", { text: "Show the second one again" })).status, 200);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#alog .gallery").length === 2);
    const last = await page.$$eval("#alog .gallery", (gs: any[]) => [...gs.at(-1).querySelectorAll("figure.gitem")].map((f: any) => [f.dataset.ref, f.dataset.status]));
    assert.deepEqual(last, [[s.show[1], "unavailable"]]);
    // The source link opens the chat thread, where its own photos still show.
    await page.click("#alog .gallery figure[data-status=ok] figcaption a");
    await page.waitForFunction((id: string) => location.hash === `#chat/${id}`, s.thread.id);
    await ctx.close();
  });
}

test("gallery in a chat thread uses the thread's own route, and the thread cannot show another thread's photo", { skip }, async () => {
  const s = await setup();
  const other = await s.r.create("Other");
  const res = await fetch(`${s.base}/threads/${other.id}/attachments`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(smallJpeg(21, 50, 40)) });
  const otherId = ((await res.json()) as any).attachment.id;
  await s.r.api(`/threads/${other.id}/messages`, "POST", { text: "elsewhere", attachments: [otherId] });
  s.setShow([s.refs[0]!, photoRef(otherId)]);
  assert.equal((await s.r.api(`/threads/${s.thread.id}/messages`, "POST", { text: "show them" })).status, 200);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${s.base}/#chat/${s.thread.id}`);
  await page.waitForSelector("#log .gallery figure.gitem");
  await page.waitForFunction(() => [...document.querySelectorAll("#log .gallery figure[data-status=ok] img")].every((i: any) => i.complete && i.naturalWidth > 0));
  const items = await page.$$eval("#log .gallery figure.gitem", (fs: any[]) => fs.map((f) => [f.dataset.ref, f.dataset.status, f.querySelector("img")?.getAttribute("src") ?? null]));
  assert.deepEqual(items, [[s.refs[0], "ok", `/threads/${s.thread.id}/photos/${s.refs[0]}`]]);
  await ctx.close();
});
