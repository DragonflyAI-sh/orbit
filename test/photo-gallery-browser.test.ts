import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { galleryRig, galleryScene } from "./helpers/gallery-fixture.ts";

// The photo gallery page (src/web/gallery.js, docs/photo-gallery.md) in a real browser: Playwright's Chromium at a desktop and a
// phone size, against the REAL server and page, with photos, observations (photos_observe) and a correction (photos_correct) made
// through the real tools by a scripted model. Synthetic images and text only. This is Chromium on Linux, not Safari on an iPhone.
// Skipped, saying so, where Playwright cannot be loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; photo gallery browser checks skipped";

let browser: any;
before(async () => { if (skip) return; browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

const HOSTILE = "Receipt <img src=x onerror=\"window.__pwned=1\">";
const sizes = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

async function openPage(base: string, size: (typeof sizes)[number], route = "/#assistant") {
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 1, isMobile: size.isMobile, hasTouch: size.hasTouch });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(base + route);
  return { ctx, page, errors };
}
const sideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const text = (page: any, sel: string) => page.$eval(sel, (e: HTMLElement) => e.innerText.replace(/\s+/g, " ").trim());

for (const size of sizes) {
  test(`gallery (${size.name}): the sidebar opens a photo in the centre-pane gallery with its metadata, observations and correction; arrows browse; Escape closes`, { skip }, async () => {
    const { g, refs } = await galleryScene();
    const { ctx, page, errors } = await openPage(g.base, size);
    if (size.name === "phone") await page.click("#navbtn");
    // The sidebar: rows with the date and an AI badge on the observed photos, a search box and the gallery link.
    await page.waitForSelector("#navimages .navimgrows li");
    assert.equal(await page.$$eval("#navimages .navimgrows li", (ls: Element[]) => ls.length), 5);
    assert.equal(await page.$$eval("#navimages .navthumb .gbadge.ai", (bs: Element[]) => bs.length), 2);
    assert.match(await text(page, "#navimages"), /My desk this morning \d{4}-\d{2}-\d{2} · 1 AI observation/);
    assert.equal(await page.isVisible("#navimgsearch"), true);
    assert.equal(await page.getAttribute("#navgallery", "href"), "/#gallery");
    // Clicking the desk photo opens the gallery page with that photo enlarged.
    await page.click(`#navimages .navthumb[title^="My desk this morning"]`);
    await page.waitForSelector(".glight .globs");
    assert.equal(new URL(page.url()).hash, "#gallery");
    assert.equal(await page.isVisible("#gallery"), true);
    assert.equal(await page.isVisible("#alog"), false);
    assert.equal(await page.evaluate(() => document.title), "Photos · ORBIT");
    assert.equal(await page.getAttribute(".glight", "role"), "dialog");
    assert.match(await page.getAttribute(".glight", "aria-label"), /^Photo 3 of 5: My desk this morning/);
    assert.equal(new URL(await page.getAttribute(".glight .glimg", "src"), g.base).pathname, `/assistant/photos/${refs.desk}`);
    await page.waitForFunction(() => (document.querySelector(".glight .glimg") as HTMLImageElement).naturalWidth > 0);
    const meta = await text(page, ".glmeta");
    assert.match(meta, /FILE Photo JPEG · ref ph_[0-9a-f]{32} Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+ Taken Not known/i);
    assert.match(meta, /Size \d+×\d+ px · \d+ KB/);
    assert.match(meta, /SOURCE Conversation Assistant Message photo 1 of 1 Open the Assistant/i);
    assert.match(meta, /CAPTION My desk this morning/i);
    assert.match(meta, /Inspecting for: what is on the desk/);
    assert.match(meta, /Superseded: Rai corrected this/);
    assert.match(meta, /Rai corrected: The mug is green, not white/);
    assert.match(meta, /Rai's correction, relayed from Rai's message; not a visual inspection/);
    // The superseded observation is struck through, in the observation list and as the correction's original.
    assert.deepEqual(await page.$$eval(".glmeta .globs s", (ss: Element[]) => ss.map((s) => s.textContent)), ["A white mug beside a laptop", "Bookshelves behind the desk"]);
    assert.match(await text(page, ".glmeta .glorig"), /Original observation: A white mug beside a laptop; Bookshelves behind the desk/);
    // The panel's link opens the source conversation.
    assert.equal(await page.getAttribute(".glmeta .glsec:nth-of-type(2) a", "href"), "/#assistant");
    // Arrow keys browse: next is the older garden photo with its observation and limitations.
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => /^Photo 4 of 5/.test(document.querySelector(".glight")!.getAttribute("aria-label")!));
    await page.waitForFunction(() => /The far corner is out of focus/.test((document.querySelector(".glmeta") as HTMLElement).innerText));
    const garden = await text(page, ".glmeta");
    assert.match(garden, /Two wooden raised beds with young lettuce/);
    assert.match(garden, /Limitations noted: The far corner is out of focus/);
    assert.match(garden, /Inspecting for: what is growing in the beds/);
    assert.match(garden, /Context: “Garden plans”/);
    assert.match(garden, /Conversation Garden plans Message photo 1 of 2/);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => /^Photo 5 of 5/.test(document.querySelector(".glight")!.getAttribute("aria-label")!));
    assert.equal(await page.isDisabled(".glnext"), true, "the last photo");
    await page.waitForFunction(() => /No saved AI observation/.test((document.querySelector(".glmeta") as HTMLElement).innerText));
    await page.click(".glprev");
    await page.waitForFunction(() => /^Photo 4 of 5/.test(document.querySelector(".glight")!.getAttribute("aria-label")!));
    // Everything behind the dialog is inert while it is open.
    assert.equal(await page.evaluate(() => document.querySelector("header")!.hasAttribute("inert")), true);
    assert.equal(await sideways(page), false, "no sideways scroll with the photo open");
    const box = await page.evaluate(() => { const s = document.querySelector(".glstage")!.getBoundingClientRect(), m = document.querySelector(".glmeta")!.getBoundingClientRect(); return { s: { l: s.left, r: s.right, b: s.bottom }, m: { l: m.left, t: m.top } }; });
    if (size.name === "phone") assert.ok(box.m.t >= box.s.b - 1, "the metadata panel is under the photo on a phone");
    else assert.ok(box.m.l >= box.s.r - 1, "the metadata panel is beside the photo on a desktop");
    await page.keyboard.press("Escape");
    assert.equal(await page.$(".glight"), null);
    assert.equal(await page.evaluate(() => document.querySelector("header")!.hasAttribute("inert")), false);
    assert.equal(await page.evaluate((r: string) => document.activeElement === document.querySelector(`.gcell[data-ref="${r}"] .gcard`), refs.garden[0]), true, "focus back on the photo that was shown");
    // The grid: grouped by day with headers, AI badges on observed photos; by month on request.
    assert.equal(await page.$$eval("#gallery .ggroup", (gs: Element[]) => gs.length), 4);
    assert.equal(await page.$$eval("#gallery .gcard .gbadge.ai", (bs: Element[]) => bs.length), 2);
    assert.match(await text(page, "#gallery .gday"), /2026/);
    const cols = await page.$$eval("#gallery .ggroup:last-child .gcell", (cs: Element[]) => new Set(cs.map((c) => Math.round(c.getBoundingClientRect().top))).size);
    assert.equal(cols, 1, "the two garden photos sit side by side in one row");
    await page.selectOption("#ggroup", "month");
    assert.equal(await page.$$eval("#gallery .ggroup", (gs: Element[]) => gs.length), 1);
    assert.equal(await sideways(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`gallery (${size.name}): search in the gallery and in the sidebar filters the grid and says what matched and how`, { skip }, async () => {
    const { g, refs } = await galleryScene();
    // A hostile caption is shown as text and never run.
    await g.send({ thread: "Receipts again", caption: HOSTILE });
    const { ctx, page, errors } = await openPage(g.base, size, "/#gallery");
    await page.waitForSelector("#gallery .gcard img");
    assert.match(await text(page, "#gallery .gstatus"), /^6 photos\.$/);
    await page.fill("#gsearchq", "watering");
    await page.press("#gsearchq", "Enter");
    await page.waitForFunction(() => /1 photo match/.test(document.querySelector("#gallery .gstatus")!.textContent!));
    assert.deepEqual(await page.$$eval("#gallery .gcell", (cs: HTMLElement[]) => cs.map((c) => c.dataset.ref)), [refs.garden[0]]);
    assert.equal(await text(page, "#gallery .gmatch"), "matched AI observation: 'watering'");
    assert.match(await text(page, "#gallery .gsearchinfo"), /Every word must appear in a photo's stored text/);
    assert.match(await text(page, "#gallery .gsearchinfo"), /not that the photo shows them/);
    // The enlarged photo says how it was found.
    await page.click("#gallery .gcard");
    await page.waitForSelector(".glight .glhits");
    assert.match(await text(page, ".glmeta"), /SEARCH MATCH Search: “watering” matched AI observation: 'watering' .*blue watering can/i);
    await page.keyboard.press("Escape");
    // Several stored texts: a correction and a caption.
    await page.fill("#gsearchq", "green");
    await page.press("#gsearchq", "Enter");
    await page.waitForFunction((r: string) => document.querySelectorAll("#gallery .gcell").length === 1 && (document.querySelector("#gallery .gcell") as HTMLElement).dataset.ref === r, refs.desk);
    assert.match(await text(page, "#gallery .gmatch"), /matched Rai's correction: 'green'/);
    await page.fill("#gsearchq", "zebra");
    await page.press("#gsearchq", "Enter");
    await page.waitForFunction(() => /No stored text matched “zebra”/.test(document.querySelector("#gallery .gstatus")!.textContent!));
    assert.equal(await page.$$eval("#gallery .gcell", (cs: Element[]) => cs.length), 0);
    // Clear goes back to every photo.
    await page.click("#gallery .gclear");
    await page.waitForFunction(() => document.querySelectorAll("#gallery .gcell").length === 6);
    // The sidebar's search opens the same results in the gallery.
    if (size.name === "phone") await page.click("#navbtn");
    await page.fill("#navimgq", "receipt");
    await page.press("#navimgq", "Enter");
    await page.waitForFunction(() => /2 photos match “receipt”/.test(document.querySelector("#gallery .gstatus")!.textContent!));
    assert.equal(await page.inputValue("#gsearchq"), "receipt");
    const notes = await page.$$eval("#gallery .gmatch", (ms: HTMLElement[]) => ms.map((m) => m.innerText));
    assert.ok(notes.every((n: string) => /matched (caption|conversation title): 'receipt'/.test(n)), JSON.stringify(notes));
    if (size.name === "phone") assert.equal(await page.isVisible("#navscrim"), false, "the drawer closed");
    assert.ok((await page.$$eval("#gallery .gcap", (cs: HTMLElement[]) => cs.map((c) => c.innerText))).some((t: string) => t.includes(HOSTILE)), "the hostile caption is text");
    assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
    assert.equal(await sideways(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test("gallery (desktop): the sidebar pages its photos, and the gallery loads more as you browse past the first page", { skip }, async () => {
  const g = await galleryRig();
  for (const n of [10, 10, 5]) {
    await g.send({ caption: `Batch of ${n}`, count: n });
    g.advance(1);
  }
  const { ctx, page, errors } = await openPage(g.base, sizes[0]!);
  await page.waitForSelector("#navimages .navpager");
  assert.match(await text(page, "#navimages .navpager"), /Page 1 of 3 · 25 photos/);
  assert.equal(await page.isDisabled("#navimages .navpager button:first-child"), true);
  await page.click("#navimages .navpager button:last-child");
  await page.waitForFunction(() => /Page 2 of 3/.test(document.querySelector("#navimages .navpager")!.textContent!));
  assert.equal(await page.$$eval("#navimages .navimgrows li", (ls: Element[]) => ls.length), 10);
  assert.equal(await page.evaluate(() => document.activeElement!.textContent), "Next ›", "focus stays on the pager");
  await page.click("#navimages .navpager button:last-child");
  await page.waitForFunction(() => /Page 3 of 3/.test(document.querySelector("#navimages .navpager")!.textContent!));
  assert.equal(await page.$$eval("#navimages .navimgrows li", (ls: Element[]) => ls.length), 5);
  // The gallery shows the first 24 and loads the rest on request, or when browsing past the last one loaded.
  await page.click("#navgallery");
  await page.waitForSelector("#gallery .gcard img");
  assert.equal(await page.$$eval("#gallery .gcell", (cs: Element[]) => cs.length), 24);
  assert.equal(await page.isVisible("#gallery .gmore"), true);
  assert.match(await text(page, "#gallery .gstatus"), /25 photos, 24 shown/);
  await page.click("#gallery .gcell:nth-child(1) .gcard");
  await page.waitForSelector(".glight");
  await page.evaluate(() => { const cells = document.querySelectorAll("#gallery .gcard"); (cells[cells.length - 1] as HTMLElement).click(); });
  await page.waitForFunction(() => /^Photo 24 of 24/.test(document.querySelector(".glight")!.getAttribute("aria-label")!));
  assert.match(await text(page, ".glcount"), /24 of 24\+/);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => /^Photo 25 of 25/.test(document.querySelector(".glight")!.getAttribute("aria-label")!));
  await page.keyboard.press("Escape");
  assert.equal(await page.$$eval("#gallery .gcell", (cs: Element[]) => cs.length), 25);
  assert.equal(await page.isVisible("#gallery .gmore"), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});
