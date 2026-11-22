import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { seededJobs } from "./jobs-page-fixture.ts";

// The header brand (the ORBIT logo and its name) is one button that reloads the current page: clicking the logo, clicking the
// name, tapping it, Enter and Space each reload the same address (path, query and hash), as the browser's own reload does,
// with nothing sent on the way. The markup checks always run; the rest runs in Chromium against the real server, at phone,
// tablet and desktop widths in Light and Dark, and is skipped, saying so, where Playwright is not installed.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

test("markup: one button wraps both the logo and the name, with an accessible name that says it refreshes", () => {
  const brand = html.match(/<h1 class="brand">([\s\S]*?)<\/h1>/)![1]!;
  assert.equal(brand, '<button type="button" id="brandbtn" aria-label="ORBIT: Refresh page" title="Refresh page"><img src="/avatar.png" alt=""><span class="wordmark">ORBIT</span></button>');
  assert.equal(html.match(/id="brandbtn"/g)?.length, 1, "one brand button");
  assert.equal(html.match(/<h1\b/g)?.length, 1, "still the page's one heading");
});

test("markup: the brand reloads the page as it is: location.reload(), no new address, no cache-busting, nothing else", () => {
  const fn = html.match(/function brandRefresh\(\) \{([\s\S]*?)\n {2}\}/)![1]!.replace(/\/\/[^\n]*/g, "");
  assert.match(fn, /addEventListener\("click", \(\) => location\.reload\(\)\)/);
  assert.doesNotMatch(fn, /location\.(href|assign|replace)|Date\.now|\?t=|fetch|send|draft|storage|setInterval|setTimeout/i);
  // Wired before the rest of the page's set-up, so a failure later in the script cannot leave the brand dead.
  const script = html.slice(html.indexOf("<script>", html.indexOf("/photos.js")));
  assert.ok(script.indexOf("brandRefresh();") < script.indexOf("const history = [];"), "wired first");
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; brand refresh browser tests skipped";

let browser: any;
let srv: Awaited<ReturnType<typeof seededJobs>> | null = null;
let base = "", session = "";
before(async () => {
  if (skip) return;
  browser = await playwright.chromium.launch();
  srv = await seededJobs({ filler: 2, events: 3 });
  session = (await srv.r.create("Trip planning")).id as string;
  base = `http://127.0.0.1:${(srv.r.server.address() as AddressInfo).port}`;
});
after(async () => { await browser?.close(); srv?.r.close(); });

type Watch = { problems: string[]; writes: string[] };
function watch(page: any): Watch {
  const w: Watch = { problems: [], writes: [] };
  page.on("pageerror", (e: Error) => w.problems.push(e.message));
  page.on("dialog", async (d: any) => { w.problems.push(`dialog: ${d.message()}`); await d.dismiss(); });
  page.on("request", (r: any) => { if (r.method() !== "GET" && r.method() !== "HEAD") w.writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return w;
}
const SOON = { timeout: 5000 };
const ready = (page: any) => page.waitForFunction(() => !!document.body.dataset.tab && !!document.getElementById("brandbtn"), null, SOON);
const address = (page: any) => page.evaluate(() => location.pathname + location.search + location.hash);

// Marks the running document, does `act`, waits for the next load and returns what that load was.
async function reloadBy(page: any, w: Watch, act: () => Promise<unknown>) {
  await page.evaluate(() => { (window as any).__beforeBrand = true; });
  w.writes.length = 0;
  await Promise.all([page.waitForEvent("load", SOON), act()]);
  await ready(page);
  return page.evaluate(() => ({
    fresh: !(window as any).__beforeBrand,
    type: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? null,
    at: location.pathname + location.search + location.hash,
  }));
}

const ways: [string, (page: any) => Promise<unknown>][] = [
  ["clicking the logo", (page) => page.click("#brandbtn img")],
  ["clicking the name", (page) => page.click("#brandbtn .wordmark")],
  ["Enter on the focused button", async (page) => { await page.focus("#brandbtn"); await page.keyboard.press("Enter"); }],
  ["Space on the focused button", async (page) => { await page.focus("#brandbtn"); await page.keyboard.press("Space"); }],
];
const addresses = () => ["/?probe=1#assistant", "/#jobs", `/#jobs/${srv!.id}`, `/sessions/${session}`];

test("browser: the logo, the name, Enter and Space each reload the current page at the same address, sending nothing", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const w = watch(page);
  for (const path of addresses()) {
    await page.goto(base + path);
    await ready(page);
    for (const [how, act] of ways) {
      const before = await address(page);
      const got = await reloadBy(page, w, () => act(page));
      assert.equal(got.fresh, true, `${how} at ${path}: a new document was loaded`);
      assert.equal(got.type, "reload", `${how} at ${path}: it was a reload, not a navigation`);
      assert.equal(got.at, before, `${how} at ${path}: the same path, query and hash`);
      assert.deepEqual(w.writes, [], `${how} at ${path}: nothing was sent`);
    }
  }
  assert.deepEqual(w.problems, []);
  await page.close();
});

test("browser: the brand leaves a composer draft to the page's existing behaviour: no send, no confirm, nothing cleared first", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const w = watch(page);
  await page.goto(`${base}/#assistant`);
  await ready(page);
  await page.fill("#ainput", "a draft that must not be sent");
  // What the textarea held as the old page went away, kept for the test in this tab's sessionStorage (it survives a reload).
  await page.evaluate(() => window.addEventListener("pagehide", () => sessionStorage.setItem("test.draftAtUnload", (document.getElementById("ainput") as HTMLTextAreaElement).value)));
  const got = await reloadBy(page, w, () => page.click("#brandbtn .wordmark"));
  assert.equal(got.fresh, true);
  const valueAtUnload = await page.evaluate(() => sessionStorage.getItem("test.draftAtUnload"));
  assert.equal(valueAtUnload, "a draft that must not be sent", "the brand itself does not clear the draft");
  assert.deepEqual(w.writes, [], "the draft was not sent");
  assert.deepEqual(w.problems, [], "no dialog and no errors");
  await page.close();
});

test("browser: a phone tap on the logo reloads the page too", { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const w = watch(page);
  await page.goto(`${base}/sessions/${session}`);
  await ready(page);
  const got = await reloadBy(page, w, () => page.tap("#brandbtn img"));
  assert.deepEqual([got.fresh, got.type, got.at], [true, "reload", `/sessions/${session}`]);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.problems, []);
  await ctx.close();
});

const geometry = (page: any) => page.evaluate(() => {
  const r = (e: Element) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const btn = document.getElementById("brandbtn")!, img = btn.querySelector("img")!, word = btn.querySelector(".wordmark")!;
  const cs = getComputedStyle(btn), ws = getComputedStyle(word), after = getComputedStyle(btn, "::after");
  return {
    btn: r(btn), img: r(img), word: r(word), wordShown: r(word).width > 1,
    health: r(document.getElementById("health")!), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
    bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow, wordColor: ws.color, wordBg: ws.backgroundImage,
    coarse: matchMedia("(pointer: coarse)").matches, hit: after.content !== "none" ? { top: parseFloat(after.top), bottom: parseFloat(after.bottom) } : null,
  };
});

for (const [name, opts] of [
  ["phone (360px)", { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true }],
  ["phone (390px)", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ["tablet (768px)", { viewport: { width: 768, height: 1024 } }],
  ["desktop (1280px)", { viewport: { width: 1280, height: 800 } }],
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`browser: ${name}, ${theme}: the brand looks as before (logo and gradient name, no button chrome) and fits the header`, { skip }, async () => {
      const ctx = await browser.newContext({ ...opts, colorScheme: theme });
      const page = await ctx.newPage();
      const w = watch(page);
      for (const path of ["/#assistant", `/sessions/${session}`]) {
        await page.goto(base + path);
        await ready(page);
        const g = await geometry(page);
        const where = `${path} at ${name}, ${theme}`;
        assert.ok(g.sw <= g.vw, `${where}: no sideways scroll`);
        assert.ok(g.img.left >= g.btn.left && g.img.right <= g.btn.right && g.img.top >= g.btn.top - 0.5 && g.img.bottom <= g.btn.bottom + 0.5, `${where}: the logo is inside the button`);
        if (g.wordShown) assert.ok(g.word.left >= g.img.right && g.word.right <= g.btn.right, `${where}: the name is inside the button, after the logo`);
        else assert.ok(path.startsWith("/sessions") && g.vw <= 400, `${where}: the name is only hidden on narrow Sessions, as before`);
        assert.ok(Math.abs((g.btn.top + g.btn.bottom) / 2 - (g.health.top + g.health.bottom) / 2) <= 4, `${where}: the brand sits on the toggles' row`);
        assert.equal(g.bg, "rgba(0, 0, 0, 0)", `${where}: no button background at rest`);
        assert.equal(g.border, "0px", `${where}: no button border`);
        assert.equal(g.shadow, "none", `${where}: no ring at rest`);
        assert.equal(g.wordColor, "rgba(0, 0, 0, 0)", `${where}: the name keeps its gradient text`);
        assert.match(g.wordBg, /linear-gradient/, `${where}: the name keeps its gradient text`);
        if (g.coarse) {
          assert.ok(g.btn.width >= 44 && g.btn.height >= 36, `${where}: touch size ${g.btn.width}x${g.btn.height}`);
          assert.ok(g.hit && g.btn.height - g.hit.top - g.hit.bottom >= 44 - 0.5, `${where}: a 44px tall tap area`);
        }
      }
      assert.deepEqual(w.problems, []);
      await ctx.close();
    });
  }
}

test("browser: hover shows a ring, keyboard focus shows a focus ring, and pressing shows the pressed look", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#assistant`);
  await ready(page);
  const style = () => page.evaluate(() => { const s = getComputedStyle(document.getElementById("brandbtn")!); return { shadow: s.boxShadow, outline: s.outlineStyle, transform: s.transform, bg: s.backgroundColor }; });
  await page.hover("#brandbtn");
  await page.waitForTimeout(250); // the shared transition
  const hover = await style();
  assert.notEqual(hover.shadow, "none", "hover ring");
  assert.notEqual(hover.bg, "rgba(0, 0, 0, 0)", "hover tint");
  await page.mouse.move(0, 700);
  // Keyboard focus: Tab from the top of the page reaches the brand first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "brandbtn", "the brand is the first stop");
  assert.equal((await style()).outline, "solid", "a visible focus ring");
  // Pressed: hold the mouse down on it without releasing (releasing would reload).
  const box = await page.locator("#brandbtn").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  assert.notEqual((await style()).transform, "none", "pressed look");
  await page.close();
});
