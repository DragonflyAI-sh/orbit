import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { seededJobs } from "./jobs-page-fixture.ts";

// The header brand (the ORBIT logo and its name) is one link to the current page that reloads it: clicking the logo, clicking
// the name, tapping it and Enter each reload the same address (path, query and hash), as the browser's own reload does, with
// nothing sent on the way. Its href is that same address, so the browser's own link actions (Ctrl or Command+click,
// middle-click, Shift+click, the context menu's "Open link in new tab") are left to the browser and open the same page.
// The markup checks always run; the rest runs in Chromium against the real server, at phone, tablet and desktop widths in
// Light and Dark, and is skipped, saying so, where Playwright is not installed. The context menu itself is browser chrome
// Playwright cannot drive, so "Open link in new tab" is checked by hand; here only that the menu is not blocked and the
// href it would open is the current address.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

test("markup: one link wraps both the logo and the name, with an accessible name that says it refreshes", () => {
  const brand = html.match(/<h1 class="brand">([\s\S]*?)<\/h1>/)![1]!;
  // href="/" is only the fallback before the script runs; brandRefresh sets it to the current address at once.
  assert.equal(brand, '<a id="brandbtn" href="/" aria-label="ORBIT: Refresh page" title="Refresh page"><img src="/avatar.png" alt=""><span class="wordmark">ORBIT</span></a>');
  assert.doesNotMatch(brand, /target=|tabindex|role=/, "a plain link: no forced new tab, focusable and named as a link");
  assert.equal(html.match(/id="brandbtn"/g)?.length, 1, "one brand link");
  assert.equal(html.match(/<h1\b/g)?.length, 1, "still the page's one heading");
});

test("markup: the brand reloads the page as it is: location.reload() on a plain click only, no new address, no new tab", () => {
  const fn = html.match(/function brandRefresh\(\) \{([\s\S]*?)\n {2}\}/)![1]!.replace(/\/\/[^\n]*/g, "");
  // Only a plain primary click is taken over; a modified or non-primary one, or one already handled, stays the browser's.
  const click = fn.match(/addEventListener\("click", \(e\) => \{([\s\S]*?)\}\);/)![1]!;
  assert.match(click, /^\s*if \(e\.defaultPrevented \|\| e\.button !== 0 \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey \|\| e\.altKey\) return;\s*e\.preventDefault\(\);\s*location\.reload\(\);\s*$/);
  assert.equal(fn.split("preventDefault").length, 2, "nothing else is prevented (no context menu, middle-click or drag blocking)");
  assert.match(fn, /brand\.href = location\.href/, "the href is the current address");
  assert.doesNotMatch(fn, /window\.open|_blank|location\.(assign|replace)|location\.href\s*=|Date\.now|\?t=|fetch|send|draft|storage|setInterval|setTimeout/i);
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
  ["Enter on the focused link", async (page) => { await page.focus("#brandbtn"); await page.keyboard.press("Enter"); }],
];
const addresses = () => ["/?probe=1#assistant", "/#jobs", `/#jobs/${srv!.id}`, `/sessions/${session}`];

test("browser: the logo, the name and Enter each reload the current page at the same address, in this tab, sending nothing", { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const opened: string[] = [];
  ctx.on("page", (p: any) => opened.push(p.url()));
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
  assert.deepEqual(opened, [], "no new tab or window");
  assert.deepEqual(w.problems, []);
  await ctx.close();
});

const brandHref = (page: any) => page.evaluate(() => (document.getElementById("brandbtn") as HTMLAnchorElement).getAttribute("href"));

test("browser: the brand is a link named \"ORBIT: Refresh page\" whose href is the current address, and follows the address", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const w = watch(page);
  for (const path of addresses()) {
    await page.goto(base + path);
    await ready(page);
    assert.equal(await page.getByRole("link", { name: "ORBIT: Refresh page", exact: true }).count(), 1, `${path}: one link with that name`);
    assert.equal(await page.getByRole("button", { name: "ORBIT: Refresh page" }).count(), 0, `${path}: no longer a button`);
    assert.equal(await brandHref(page), base + (await address(page)), `${path}: href is the current address`);
  }
  // The page's own address changes (pushState and replaceState fire no event): the href is current by the time it is used.
  await page.evaluate(() => window.history.pushState(null, "", "/?probe=2#jobs")); // window.: the page has its own `history`
  await page.hover("#brandbtn");
  assert.equal(await brandHref(page), `${base}/?probe=2#jobs`, "after pushState, on hover");
  await page.evaluate((s: string) => window.history.replaceState(null, "", `/sessions/${s}`), session);
  await page.focus("#brandbtn");
  assert.equal(await brandHref(page), `${base}/sessions/${session}`, "after replaceState, on focus");
  // Back and a hash change update it straight away.
  await page.evaluate(() => { location.hash = "#assistant"; });
  await page.waitForFunction(() => (document.getElementById("brandbtn") as HTMLAnchorElement).href === location.href, null, SOON);
  assert.deepEqual(w.problems, []);
  await page.close();
});

test("browser: Ctrl or Command+click, Shift+click and middle-click are left to the browser: the same page opens in a new tab, this one stays", { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const w = watch(page);
  const path = `/sessions/${session}?probe=3#x`;
  await page.goto(base + path);
  await ready(page);
  // The address moves after load without an event, as the page's own routing does; the new tab must get the moved one.
  await page.evaluate(() => window.history.replaceState(null, "", location.pathname + "?probe=4"));
  const want = await address(page);
  await page.evaluate(() => {
    (window as any).__beforeBrand = true;
    (window as any).__prevented = [];
    for (const ev of ["click", "auxclick", "contextmenu", "mousedown"]) window.addEventListener(ev, (e) => (window as any).__prevented.push(`${ev}:${e.defaultPrevented}`));
  });
  for (const [how, act] of [
    ["ControlOrMeta+click", () => page.click("#brandbtn .wordmark", { modifiers: ["ControlOrMeta"] })],
    ["Shift+click", () => page.click("#brandbtn img", { modifiers: ["Shift"] })],
    ["middle-click", () => page.click("#brandbtn .wordmark", { button: "middle" })],
  ] as const) {
    const [opened] = await Promise.all([ctx.waitForEvent("page", SOON), act()]);
    await opened.waitForLoadState("domcontentloaded");
    const u = new URL(opened.url());
    assert.equal(u.pathname + u.search + u.hash, want, `${how}: the new tab opens the current address`);
    await opened.close();
  }
  // Right-click: the browser's context menu is not blocked (its "Open link in new tab" is checked by hand), and its href is current.
  await page.click("#brandbtn .wordmark", { button: "right" });
  assert.equal(await brandHref(page), base + want, "the context menu would open the current address");
  const got = await page.evaluate(() => ({ same: !!(window as any).__beforeBrand, prevented: (window as any).__prevented as string[], at: location.pathname + location.search + location.hash }));
  assert.equal(got.same, true, "this tab was not reloaded or navigated");
  assert.equal(got.at, want, "and is still at the same address");
  assert.deepEqual(got.prevented.filter((p: string) => p.endsWith(":true")), [], `no default prevented: ${got.prevented.join(", ")}`);
  assert.ok(got.prevented.includes("contextmenu:false"), "the context menu event reached the page, not prevented");
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.problems, []);
  await ctx.close();
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
    theme: r(document.getElementById("themebtn")!), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
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
        assert.ok(Math.abs((g.btn.top + g.btn.bottom) / 2 - (g.theme.top + g.theme.bottom) / 2) <= 4, `${where}: the brand sits on the theme toggle's row`);
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
