import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The side panel and the desktop menu (docs/design-system.md, "Side panel" and "Desktop menu"):
// - Notifications and Status live in the side panel only, on every width: the page header has no notifications or status
//   indicator and no "Notifications" or "All live" text;
// - the panel has no heading and no close button: its head is the tab list (Status with the level dot first, then
//   Notifications with the count) with a collapse button; collapsed (the default) it is a rail at the right edge with the same button and tabs
//   as icons; it slides away to the right and back;
// - laptops and desktops (1024px and wider): the open panel covers nothing (the conversation and composer move left); below
//   1024px it lies over the page and the page keeps only the rail's room;
// - a resize handle on the panel's inner edge drags or keys it wider or narrower, within bounds, and the width is kept;
// - keyboard and screen readers: one tab stop for the tabs, arrows/Home/End, Escape collapses and focus is never lost, the
//   handle is a window splitter with its value; receipts only for notes actually listed; status loading/empty/error states;
// - the session menu's rows have no nested outline on desktop and keep the keyboard focus ring; the page tabs lose their
//   inner borders on desktop; phones are unchanged.
// - with the left sidebar (docs/sidebar.md) docked open too, both panels stay open when the conversation keeps 480px between
//   them; when it would not, opening one closes the other, and narrowing the window closes the one opened earlier.
// Chromium (Playwright) with synthetic content only (test/helpers/shell-fixture.ts). Skipped, saying so, without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; side panel and desktop menu browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 12, card: true, notes: 14 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

type OpenOpts = { phone?: boolean; colorScheme?: string; notes?: number; motion?: boolean; nav?: boolean };
async function open(width: number, height: number, route = "/#assistant", opts: OpenOpts = {}) {
  fixture.set({ notes: opts.notes ?? 14 });
  // Reduced motion unless a test looks at the slide: the panel then changes state at once.
  const ctx = await chromium.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light", reducedMotion: opts.motion ? "no-preference" : "reduce", ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
  // The left sidebar (docs/sidebar.md) is collapsed unless a test looks at both panels together, so these checks see the side
  // panel's own room.
  if (!opts.nav) await ctx.addInitScript(() => { try { localStorage.setItem("orbit.sidebar", JSON.stringify({ open: false })); } catch { /* none */ } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const acks: string[] = [];
  page.on("request", (r: any) => { const m = new URL(r.url()).pathname.match(/^\/notifications\/([^/]+)\/ack$/); if (m && r.method() === "POST") acks.push(m[1]!); });
  await page.goto(url + route);
  const conv = route.includes("sessions") ? "log" : "alog";
  await page.waitForFunction((id: string) => document.getElementById(id)!.querySelectorAll(".msg").length > 0, conv);
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  return { page, ctx, errors, acks };
}
const sideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const expanded = (page: any, sel: string) => page.getAttribute(sel, "aria-expanded");
const isOpen = (page: any) => page.evaluate(() => document.documentElement.getAttribute("data-side") === "open");
const shown = (page: any, sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden"); }, sel);
const active = (page: any) => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || "");
const inSide = (page: any) => page.evaluate(() => document.getElementById("side")!.contains(document.activeElement));
const geo = (page: any) => page.evaluate(() => {
  const r = (sel: string) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const msgs = [...document.querySelectorAll("#alog .msg, #log .msg")].filter((m) => (m as HTMLElement).offsetParent);
  return { side: r("#side"), header: r("header"), send: r(document.getElementById("aform")!.hidden ? "#send" : "#asend"), box: r(document.getElementById("aform")!.hidden ? "#input" : "#ainput"),
    msgRight: Math.max(...msgs.map((m) => m.getBoundingClientRect().right)), msgLeft: Math.min(...msgs.map((m) => m.getBoundingClientRect().left)),
    vw: document.documentElement.clientWidth, vh: window.innerHeight,
    bar: (() => { const c = document.getElementById(document.getElementById("aform")!.hidden ? "log" : "alog")!; return c.offsetWidth - c.clientWidth; })() };
});
// The page header shows no notifications or status indicator, and none of their words.
async function headerHasNoIndicators(page: any, where: string) {
  const h = await page.evaluate(() => { const head = document.querySelector("header")!; return { text: head.textContent || "", notes: !!document.getElementById("notesbtn"), health: !!document.getElementById("health"), side: head.contains(document.getElementById("side")), count: head.contains(document.getElementById("notecount")) }; });
  assert.equal(h.notes, false, `${where}: no notifications button in the header`);
  assert.equal(h.health, false, `${where}: no status indicator in the header`);
  assert.equal(h.side || h.count, false, `${where}: the side panel and its count are not in the header`);
  assert.doesNotMatch(h.text, /Notifications|All live|Status unknown/, `${where}: no indicator text in the header`);
}

for (const [width, height] of [[1024, 700], [1280, 800], [1440, 900]] as const) {
  test(`browser ${width}px: collapsed to a rail by default; a tab opens the panel on the right, covering nothing, with focus kept`, { skip }, async () => {
    const { page, ctx, errors } = await open(width, height);
    await headerHasNoIndicators(page, `${width}`);
    // Collapsed: a narrow rail at the right edge holding the expand button and the two indicators.
    assert.equal(await isOpen(page), false, "collapsed by default");
    let g = await geo(page);
    assert.ok(Math.abs(g.side.right - g.vw) <= 1, "the rail is on the right edge");
    assert.ok(g.side.width >= 40 && g.side.width <= 48, `the rail is narrow (${g.side.width})`);
    assert.ok(Math.abs(g.side.top - g.header.bottom) <= 1, "under the header");
    assert.ok(g.msgRight <= g.side.left + 0.5, "the rail covers no message");
    assert.ok(g.send.right <= g.side.left - 8, "nor Send");
    for (const sel of ["#sidetoggle", "#sidetab-notes", "#sidetab-status", "#notecount", "#sidetab-status .dot"]) assert.equal(await shown(page, sel), true, `${sel} in the rail`);
    assert.equal(await shown(page, "#inbox"), false);
    assert.equal(await shown(page, "#statusline"), false);
    assert.equal(await shown(page, "#sideresize"), false, "no resize handle while collapsed");
    assert.equal(await expanded(page, "#sidetoggle"), "false");
    assert.equal(await page.textContent("#notecount"), "14");
    // Opened from its tab: no heading, no close button; the tabs are the head.
    await page.focus("#sidetab-notes");
    await page.keyboard.press("Enter");
    assert.equal(await isOpen(page), true);
    assert.equal(await active(page), "sidetab-notes", "non-modal: opening never moves focus");
    assert.equal(await expanded(page, "#sidetoggle"), "true");
    assert.equal(await page.evaluate(() => document.getElementById("side")!.tagName), "ASIDE");
    assert.equal(await page.getAttribute("#side", "aria-label"), "Side panel");
    assert.equal(await page.$$eval("#side :is(h1, h2, h3, h4, [role=heading])", (n: unknown[]) => n.length), 0, "no heading");
    assert.equal(await page.$("#sideclose"), null, "no close button");
    assert.equal(await page.$("#sidetitle"), null, "no title");
    assert.equal(await page.getAttribute("#sidetab-notes", "aria-selected"), "true");
    assert.equal(await page.getAttribute("#sidetab-status", "aria-selected"), "false");
    assert.equal(await page.getAttribute("#side .sidetabs", "aria-orientation"), "horizontal");
    assert.equal(await page.getAttribute("#inbox", "role"), "tabpanel");
    assert.equal(await shown(page, "#inbox"), true);
    assert.equal(await shown(page, "#statusline"), false, "one view at a time");
    assert.equal(await shown(page, "#sideresize"), true);
    const head = await page.evaluate(() => { const h = document.querySelector("#side .sidehead")!.getBoundingClientRect(), t = document.querySelector("#side .sidetabs")!.getBoundingClientRect(); return { h: h.height, top: t.top - h.top }; });
    assert.ok(head.h <= 60, `the head is just the tab row (${head.h}px)`);
    g = await geo(page);
    assert.ok(Math.abs(g.side.right - g.vw) <= 1, "on the right edge");
    assert.ok(Math.abs(g.side.top - g.header.bottom) <= 1, `under the header (${g.side.top} vs ${g.header.bottom})`);
    assert.ok(Math.abs(g.side.bottom - g.vh) <= 1, "down to the bottom of the screen");
    assert.ok(g.side.width >= 319 && g.side.width <= 401, `a sensible width (${g.side.width})`);
    assert.ok(g.msgRight <= g.side.left + 0.5, `the conversation is not covered (${g.msgRight} vs ${g.side.left})`);
    assert.ok(g.send.right <= g.side.left - 8, `Send stays clear of the panel (${g.send.right} vs ${g.side.left})`);
    assert.ok(g.box.width >= 300, `the message box stays usable (${g.box.width}px)`);
    assert.ok(g.side.left - g.msgLeft >= 500, "the conversation keeps a readable column");
    // The column is recentred in the room left of the panel: as wide as the measure allows, with the gutter each side.
    const room = g.side.left, column = Math.min(860, room - 48), colW = g.msgRight - g.msgLeft;
    assert.ok(colW >= column - g.bar - 2, `the column uses the room left (${colW} of ${column}, scrollbar ${g.bar})`);
    assert.ok(Math.abs(g.msgLeft - (room - column) / 2) <= 2, `centred in it (left ${g.msgLeft})`);
    assert.equal(await sideways(page), false);
    // Clicking the conversation does not close a non-modal panel.
    await page.click("#ainput");
    assert.equal(await isOpen(page), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test("browser 1280px: the tabs switch views; the collapse button collapses and reopens; the state survives a reload", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  await page.click("#sidetab-notes");
  await page.click("#sidetab-status");
  assert.equal(await isOpen(page), true, "the other tab switches the open panel");
  assert.equal(await page.getAttribute("#sidetab-status", "aria-selected"), "true");
  assert.equal(await shown(page, "#statusline"), true);
  assert.equal(await shown(page, "#inbox"), false);
  assert.equal(await shown(page, "#statussum"), true, "the status view shows the overall status");
  // Order (docs/ui-library.md, "Side panel"): the overall status first, then the services, then the running release (Deployed,
  // then Commit); the /status link sits at the right of the release's label.
  const order = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const dts = [...document.querySelectorAll("#deployinfo dt")].map((d) => d.textContent);
    return { dts, release: r("#deployinfo").top >= r("#ports").bottom, status: r("#statussum").bottom <= r("#ports").top,
      link: r("#statusopen").top < r("#releaselabel").bottom && r("#statusopen").bottom > r("#releaselabel").top && r("#statusopen").left >= r("#releaselabel").right };
  });
  assert.deepEqual(order, { dts: ["Deployed", "Commit"], release: true, status: true, link: true });
  assert.match(await page.textContent("#statusdetail"), /Not live: jobs: degraded/);
  assert.match(await page.getAttribute("#sidetab-status", "class"), /\bdegraded\b/);
  assert.equal(await page.getAttribute("#sidetab-status", "aria-label"), `Status: ${await page.textContent("#statuslabel")} (degraded but working)`, "the tab's name carries the overall status");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-label"), "Notifications, 14");
  // Clicking the selected tab again keeps the view (tabs select; the button collapses).
  await page.click("#sidetab-status");
  assert.equal(await isOpen(page), true);
  await page.click("#sidetab-notes");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  assert.equal(await isOpen(page), true, "kept for this tab's session");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-selected"), "true");
  await page.click("#sidetoggle");
  assert.equal(await isOpen(page), false, "the collapse button collapses the panel");
  assert.equal(await expanded(page, "#sidetoggle"), "false");
  assert.equal(await active(page), "sidetoggle", "focus stays on the button, which stays in the rail");
  assert.equal(await page.getAttribute("#side .sidetabs", "aria-orientation"), "vertical");
  // Collapsed, the conversation takes its centred column in the room left of the rail again.
  const g = await geo(page);
  assert.ok(Math.abs(g.msgLeft - (g.side.left - 860) / 2) <= 1, `the column is centred again (${g.msgLeft})`);
  // The button opens it again on the view last shown.
  await page.click("#sidetab-status");
  await page.click("#sidetoggle");
  await page.click("#sidetoggle");
  assert.equal(await isOpen(page), true);
  assert.equal(await shown(page, "#statusline"), true, "reopened on the last view");
  await ctx.close();
});

test("browser 1280px: collapsing slides the panel away to the right edge and opening slides it back", { skip }, async () => {
  const { page, ctx } = await open(1280, 800, "/#assistant", { motion: true });
  await page.click("#sidetab-notes");
  await page.waitForTimeout(300);
  const left0 = (await geo(page)).side.left;
  // Sample the panel's left edge during the slide: it moves right, then the rail is left at the edge.
  const samples: number[] = await page.evaluate(async () => {
    const side = document.getElementById("side")!, out: number[] = [];
    document.getElementById("sidetoggle")!.click();
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 25)); out.push(side.getBoundingClientRect().left); }
    return out;
  });
  assert.ok(samples.some((x) => x > left0 + 20 && x < 1280 - 50), `it slid (from ${left0}: ${samples.map(Math.round).join(", ")})`);
  await page.waitForFunction(() => document.documentElement.getAttribute("data-side") !== "open");
  await page.waitForTimeout(100);
  const g = await geo(page);
  assert.ok(g.side.width <= 48 && Math.abs(g.side.right - g.vw) <= 1, "the rail is left at the right edge");
  const opening: number[] = await page.evaluate(async () => {
    const side = document.getElementById("side")!, out: number[] = [];
    document.getElementById("sidetab-notes")!.click();
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 30)); out.push(side.getBoundingClientRect().left); }
    return out;
  });
  await page.waitForTimeout(250);
  const end = (await geo(page)).side.left;
  assert.ok(opening[0]! > end + 20, `it slides in from the right (${opening.map(Math.round).join(", ")} → ${end})`);
  await ctx.close();
});

test("browser 1280px: the tabs work by keyboard; Escape collapses without losing focus; Tab passes through the panel", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  // Collapsed: Tab from the header reaches the rail: the button, then the selected tab only.
  await page.focus("#themebtn");
  await page.keyboard.press("Tab");
  assert.equal(await active(page), "sidetoggle");
  await page.keyboard.press("Tab");
  assert.equal(await active(page), "sidetab-status", "one tab stop for the tab list, on Status (the first tab)");
  // In the rail the arrows only select; Enter opens on the selected tab.
  await page.keyboard.press("ArrowDown");
  assert.equal(await active(page), "sidetab-notes");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-selected"), "true");
  assert.equal(await isOpen(page), false, "arrows in the rail do not open the panel");
  await page.keyboard.press("Enter");
  assert.equal(await isOpen(page), true);
  assert.equal(await shown(page, "#inbox"), true);
  assert.equal(await active(page), "sidetab-notes");
  // Open: arrows, Home and End switch and show the view.
  await page.keyboard.press("ArrowRight");
  assert.equal(await active(page), "sidetab-status", "wraps around");
  assert.equal(await shown(page, "#statusline"), true);
  assert.equal(await page.getAttribute("#sidetab-status", "tabindex"), "0");
  assert.equal(await page.getAttribute("#sidetab-notes", "tabindex"), "-1");
  assert.notEqual(await page.$eval("#sidetab-status", (b: HTMLElement) => getComputedStyle(b).outlineStyle), "none", "a visible focus ring");
  await page.keyboard.press("End");
  assert.equal(await active(page), "sidetab-notes");
  await page.keyboard.press("Home");
  assert.equal(await active(page), "sidetab-status");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await active(page), "sidetab-notes");
  await page.keyboard.press("Home");
  // Not a focus trap: Tab moves on into the view, to the resize handle, and then out of the panel.
  await page.keyboard.press("Tab");
  assert.equal(await inSide(page), true, "into the view");
  const stops: string[] = [];
  for (let i = 0; i < 14 && (await inSide(page)); i++) { stops.push(await active(page)); await page.keyboard.press("Tab"); }
  assert.ok(stops.includes("sideresize"), `the resize handle is a tab stop (${stops.join(", ")})`);
  assert.equal(await inSide(page), false, "Tab leaves the panel");
  // Escape on a tab collapses the panel; focus stays on the tab, now in the rail.
  await page.focus("#sidetab-status");
  await page.keyboard.press("Escape");
  assert.equal(await isOpen(page), false);
  assert.equal(await active(page), "sidetab-status");
  // Escape from inside a view collapses it and puts focus on the view's tab (the view is gone).
  await page.click("#sidetab-notes");
  await page.focus("#inbox .note .x");
  await page.keyboard.press("Escape");
  assert.equal(await isOpen(page), false);
  assert.equal(await active(page), "sidetab-notes");
  // Escape elsewhere (the message box) leaves the panel alone.
  await page.click("#sidetab-notes");
  await page.focus("#ainput");
  await page.keyboard.press("Escape");
  assert.equal(await isOpen(page), true);
  await ctx.close();
});

test("browser 1280px: the resize handle drags the panel wider and narrower, within bounds, and the width is kept", { skip }, async () => {
  const { page, ctx, errors } = await open(1280, 800);
  await page.click("#sidetab-notes");
  const h = await page.evaluate(() => { const e = document.getElementById("sideresize")!, b = e.getBoundingClientRect(), s = document.getElementById("side")!.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, sideLeft: s.left, cursor: getComputedStyle(e).cursor, h: b.height, sh: s.height }; });
  assert.ok(Math.abs(h.x - h.sideLeft) <= 2, "on the panel's inner (left) edge");
  assert.equal(h.cursor, "col-resize", "the same cursor as the left sidebar's separator");
  assert.ok(h.h >= h.sh - 1, "the whole height of the panel");
  // ARIA: a focusable window splitter with its value.
  const aria = await page.evaluate(() => { const e = document.getElementById("sideresize")!; return { role: e.getAttribute("role"), o: e.getAttribute("aria-orientation"), label: e.getAttribute("aria-label"), now: Number(e.getAttribute("aria-valuenow")), min: Number(e.getAttribute("aria-valuemin")), max: Number(e.getAttribute("aria-valuemax")), tab: e.tabIndex }; });
  const w0 = (await geo(page)).side.width;
  assert.deepEqual({ role: aria.role, o: aria.o, label: aria.label, tab: aria.tab }, { role: "separator", o: "vertical", label: "Resize the side panel", tab: 0 });
  assert.equal(aria.now, Math.round(w0));
  assert.deepEqual([aria.min, aria.max], [280, 720]);
  // Drag 150px to the left: 150px wider; the conversation moves with it and stays uncovered.
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x - 75, h.y, { steps: 3 });
  await page.mouse.move(h.x - 150, h.y, { steps: 3 });
  await page.mouse.up();
  let g = await geo(page);
  assert.ok(Math.abs(g.side.width - (w0 + 150)) <= 2, `dragged wider (${w0} → ${g.side.width})`);
  assert.ok(g.msgRight <= g.side.left + 0.5, "the conversation is still not covered");
  assert.ok(g.send.right <= g.side.left - 8, "nor Send");
  assert.equal(await page.evaluate(() => localStorage.getItem("orbit.side-width")), String(Math.round(g.side.width)), "kept on this device");
  assert.equal(Number(await page.getAttribute("#sideresize", "aria-valuenow")), Math.round(g.side.width));
  // Far past the bounds: the conversation keeps 480px; and the narrowest is 280px.
  await page.mouse.move(g.side.left, h.y); await page.mouse.down(); await page.mouse.move(50, h.y, { steps: 4 }); await page.mouse.up();
  g = await geo(page);
  assert.equal(Math.round(g.side.width), 720, "at most 720px");
  await page.mouse.move(g.side.left, h.y); await page.mouse.down(); await page.mouse.move(1270, h.y, { steps: 4 }); await page.mouse.up();
  assert.equal(Math.round((await geo(page)).side.width), 280, "at least 280px");
  // The keyboard: Left widens, Right narrows, Shift for bigger steps, Home and End for the bounds.
  await page.focus("#sideresize");
  await page.keyboard.press("ArrowLeft");
  assert.equal(Math.round((await geo(page)).side.width), 296);
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal(Math.round((await geo(page)).side.width), 360);
  await page.keyboard.press("ArrowRight");
  assert.equal(Math.round((await geo(page)).side.width), 344);
  await page.keyboard.press("End");
  assert.equal(Math.round((await geo(page)).side.width), 720);
  await page.keyboard.press("Home");
  assert.equal(Math.round((await geo(page)).side.width), 280);
  assert.equal(await page.getAttribute("#sideresize", "aria-valuetext"), "280 pixels wide");
  await page.keyboard.press("Shift+ArrowLeft");
  assert.notEqual(await page.$eval("#sideresize", (e: HTMLElement) => getComputedStyle(e).outlineStyle), "none", "a visible focus ring");
  // Kept across a reload; a double-click goes back to the default.
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  assert.equal(Math.round((await geo(page)).side.width), 344, "the width survives a reload");
  await page.dblclick("#sideresize");
  assert.ok(Math.abs((await geo(page)).side.width - w0) <= 1, "double-click resets the width");
  assert.equal(await page.evaluate(() => localStorage.getItem("orbit.side-width")), null);
  // Enter on the handle collapses the panel (window splitter); focus goes to the selected tab, not lost.
  await page.focus("#sideresize");
  await page.keyboard.press("Enter");
  assert.equal(await isOpen(page), false);
  assert.equal(await active(page), "sidetab-notes");
  assert.equal(await sideways(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser: a kept width is clamped to a smaller screen without being forgotten", { skip }, async () => {
  const { page, ctx } = await open(1100, 800);
  await page.evaluate(() => localStorage.setItem("orbit.side-width", "600"));
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  await page.click("#sidetab-notes");
  assert.equal(Math.round((await geo(page)).side.width), 600, "the kept width");
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(100);
  assert.equal(Math.round((await geo(page)).side.width), 544, "the conversation keeps 480px");
  assert.equal(await page.evaluate(() => localStorage.getItem("orbit.side-width")), "600", "the kept choice is unchanged");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(100);
  assert.equal(Math.round((await geo(page)).side.width), 600);
  // Garbage in storage is the default.
  await page.evaluate(() => localStorage.setItem("orbit.side-width", "wide"));
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  assert.equal(Math.round((await geo(page)).side.width), 384, "clamp(320px, 30vw, 400px) at 1280");
  await ctx.close();
});

test("browser 1280px: each view scrolls on its own; the tab row stays put and the conversation does not move", { skip }, async () => {
  const { page, ctx } = await open(1280, 700);
  await page.click("#sidetab-notes");
  await page.click("#inbox .showall");
  await page.click("#inbox .note button:not(.x)"); // one long note open
  const before = await page.evaluate(() => ({ log: document.getElementById("alog")!.scrollTop, head: document.querySelector("#side .sidehead")!.getBoundingClientRect().top }));
  const sc = await page.evaluate(() => { const b = document.getElementById("inbox")!; return { sh: b.scrollHeight, ch: b.clientHeight, oy: getComputedStyle(b).overflowY }; });
  assert.ok(sc.sh > sc.ch, "14 notes overflow the view");
  assert.equal(sc.oy, "auto");
  await page.hover("#inbox .note:nth-child(3)");
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(200);
  const afterScroll = await page.evaluate(() => ({ inbox: document.getElementById("inbox")!.scrollTop, log: document.getElementById("alog")!.scrollTop, head: document.querySelector("#side .sidehead")!.getBoundingClientRect().top }));
  assert.ok(afterScroll.inbox > 0, "the view scrolled");
  assert.equal(afterScroll.log, before.log, "the conversation did not");
  assert.equal(afterScroll.head, before.head, "the tabs stay");
  // The last note and its dismiss button are reachable (nothing clipped at the bottom).
  const last = await page.evaluate(() => { const b = document.getElementById("inbox")!; b.scrollTop = b.scrollHeight; const x = [...b.querySelectorAll(".note .x")].at(-1)!.getBoundingClientRect(); return { bottom: x.bottom, vh: window.innerHeight }; });
  assert.ok(last.bottom <= last.vh, "the last dismiss button is on screen when scrolled to the end");
  assert.equal(await sideways(page), false);
  await ctx.close();
});

test("browser 1280px: receipts are sent only for notes listed in the shown Notifications view, never from Status or the rail", { skip }, async () => {
  const { page, ctx, acks } = await open(1280, 800, "/#assistant", { notes: 12 });
  await page.waitForTimeout(300);
  assert.deepEqual(acks, [], "the collapsed rail lists no notes, so it sends no receipt");
  await page.click("#sidetab-status");
  await page.waitForTimeout(300);
  assert.deepEqual(acks, [], "the Status view lists no notes, so it sends no receipt");
  await page.click("#sidetab-notes");
  const listed = Array.from({ length: 10 }, (_, i) => `n${i + 2}`).sort();
  for (let i = 0; acks.length < 10 && i < 100; i++) await page.waitForTimeout(20);
  await page.waitForTimeout(200);
  assert.deepEqual([...new Set(acks)].sort(), listed, "the ten listed (newest) notes only, not the two past the limit");
  const dismissed = await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes"));
  await page.click("#sidetoggle");
  assert.equal(await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes")), dismissed, "collapsing is not dismissing");
  assert.equal(await page.textContent("#notecount"), "12");
  await ctx.close();
});

test("browser 1280px: the status view says when it is reading, when the read failed, and keeps the last answer", { skip }, async () => {
  const ctx = await chromium.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  let mode: "hold" | "fail" | "ok" | "empty" | "down" = "hold";
  let release: () => void = () => {};
  await page.route("**/status", async (route: any) => {
    if (mode === "hold") { await new Promise<void>((r) => { release = r; }); return route.fulfill({ status: 500, body: "{}" }); }
    if (mode === "fail") return route.fulfill({ status: 500, body: "{}" });
    if (mode === "down") return route.abort();
    const ports = mode === "empty" ? [] : [{ port: "model", state: "live" }, { port: "vault", state: "live" }];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ports }) });
  });
  await page.goto(url + "/#assistant");
  await page.click("#sidetab-status");
  assert.equal(await page.textContent("#ports"), "Reading status…", "loading, before any answer");
  assert.equal(await shown(page, "#statuserr"), false);
  release();
  await page.waitForFunction(() => !document.getElementById("statuserr")!.hidden);
  assert.equal(await page.textContent("#statuserr"), "ORBIT's status could not be read (HTTP 500).");
  assert.equal(await page.getAttribute("#statuserr", "role"), "alert");
  assert.equal(await page.textContent("#ports"), "", "no stale “Reading status…” after a failure");
  mode = "ok";
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.querySelectorAll("#ports .pill").length === 2);
  assert.equal(await shown(page, "#statuserr"), false, "a good answer clears the error");
  mode = "down";
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => !document.getElementById("statuserr")!.hidden);
  assert.equal(await page.textContent("#statuserr"), "ORBIT could not be reached for its status. Showing the last answer.");
  assert.equal(await page.$$eval("#ports .pill", (p: unknown[]) => p.length), 2, "the last answer stays");
  assert.equal(await page.textContent("#statuslabel"), "Disconnected", "the summary says the status is not known now");
  mode = "empty";
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.getElementById("ports")!.textContent === "ORBIT reported no status entries.");
  assert.equal(await shown(page, "#statuserr"), false);
  await ctx.close();
});

test("browser 1280px: the Notifications view has an empty state", { skip }, async () => {
  const { page, ctx } = await open(1280, 800, "/#assistant", { notes: 0 });
  await page.click("#sidetab-notes");
  assert.equal(await page.textContent("#inbox"), "No notifications.");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-label"), "Notifications, none");
  await ctx.close();
});

test("browser: below 1024px the rail stays at the edge and the open panel lies over the page; tabs, collapse and resize work", { skip }, async () => {
  for (const [w, h, phone] of [[390, 844, true], [320, 640, true], [900, 700, false]] as const) {
    const { page, ctx, errors } = await open(w, h, "/#assistant", { phone });
    await headerHasNoIndicators(page, `${w}`);
    let g = await geo(page);
    assert.ok(Math.abs(g.side.right - g.vw) <= 1 && g.side.width <= 48, `${w}: the rail at the right edge (${g.side.width})`);
    assert.ok(g.msgRight <= g.side.left + 0.5, `${w}: the rail covers no message`);
    if (w < 900) {
      assert.ok(g.side.bottom <= g.box.top, `${w}: the rail ends above the composer (${g.side.bottom} vs ${g.box.top})`);
      assert.ok(g.send.right >= g.vw - 24, `${w}: which keeps its full width (Send at ${g.send.right})`);
    } else assert.ok(g.send.right <= g.side.left, `${w}: Send clear of the rail`);
    const tap = await page.evaluate(() => ["sidetoggle", "sidetab-notes", "sidetab-status"].map((id) => document.getElementById(id)!.getBoundingClientRect().height));
    if (phone) assert.ok(tap.every((x: number) => x >= 43.5), `${w}: rail controls are 44px tall on touch (${tap.join(", ")})`);
    const colBefore = { left: g.msgLeft, right: g.msgRight };
    await (phone ? page.tap("#sidetab-notes") : page.click("#sidetab-notes"));
    assert.equal(await isOpen(page), true);
    assert.equal(await shown(page, "#inbox"), true);
    g = await geo(page);
    assert.ok(Math.abs(g.side.right - g.vw) <= 1, `${w}: open on the right edge`);
    assert.ok(g.side.width <= g.vw - 24 && g.side.width >= Math.min(280, g.vw - 40), `${w}: a usable overlay width (${g.side.width})`);
    assert.ok(Math.abs(g.msgLeft - colBefore.left) <= 1 && Math.abs(g.msgRight - colBefore.right) <= 1, `${w}: the page under it does not reflow`);
    // Tabs and the tab-row layout fit: no label is cut off on a phone.
    const cut = await page.$$eval("#side .sidetab .tlabel", (ls: HTMLElement[]) => ls.filter((l) => l.scrollWidth > l.clientWidth + 1).map((l) => l.textContent));
    if (w >= 390) assert.deepEqual(cut, [], `${w}: tab labels fit`);
    await (phone ? page.tap("#sidetab-status") : page.click("#sidetab-status"));
    assert.equal(await shown(page, "#statusline"), true);
    assert.equal(await shown(page, "#inbox"), false);
    // Resize by keyboard within the narrow bounds.
    await page.focus("#sideresize");
    await page.keyboard.press("End");
    assert.equal(Math.round((await geo(page)).side.width), Math.min(720, w - 24), `${w}: widest leaves a strip of the page`);
    await page.keyboard.press("Home");
    assert.equal(Math.round((await geo(page)).side.width), Math.min(280, w - 40), `${w}: narrowest`);
    assert.equal(await sideways(page), false);
    await (phone ? page.tap("#sidetoggle") : page.click("#sidetoggle"));
    assert.equal(await isOpen(page), false, `${w}: collapses`);
    assert.equal(await sideways(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // A phone drags the handle with a finger.
  const { page, ctx } = await open(390, 844, "/#assistant", { phone: true });
  await page.tap("#sidetab-notes");
  const before = (await geo(page)).side.width;
  const box = await page.evaluate(() => { const b = document.getElementById("sideresize")!.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type: string, x: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: box.y }] });
  await touch("touchStart", box.x);
  for (const dx of [10, 25, 40]) await touch("touchMove", box.x + dx);
  await touch("touchEnd", box.x + 40);
  const after = (await geo(page)).side.width;
  assert.ok(Math.abs(after - (before - 40)) <= 3, `dragged narrower by touch (${before} → ${after})`);
  await ctx.close();
  // A laptop window made narrow and wide again keeps the open view.
  const lap = await open(1280, 800);
  await lap.page.click("#sidetab-status");
  await lap.page.setViewportSize({ width: 800, height: 800 });
  await lap.page.waitForTimeout(100);
  assert.equal(await isOpen(lap.page), true);
  assert.equal(await shown(lap.page, "#statusline"), true, "the open view stays open over the page");
  assert.equal(await sideways(lap.page), false);
  await lap.page.setViewportSize({ width: 1280, height: 800 });
  await lap.page.waitForTimeout(100);
  assert.equal(await shown(lap.page, "#statusline"), true);
  const g = await geo(lap.page);
  assert.ok(Math.abs(g.side.top - g.header.bottom) <= 1, "placed under the header again");
  assert.ok(g.msgRight <= g.side.left + 0.5, "and the conversation makes room again");
  await lap.ctx.close();
});

// ---- the desktop menu -------------------------------------------------------------------------------------------------

const rowLook = (page: any, sel: string) => page.$eval(sel, (b: HTMLElement) => { const c = getComputedStyle(b); return { shadow: c.boxShadow, border: c.borderTopWidth, bg: c.backgroundColor, outline: c.outlineStyle, outlineW: parseFloat(c.outlineWidth), h: b.getBoundingClientRect().height, transform: c.transform }; });

test("browser 1280px: the session menu's rows are plain aligned rows: no hover ring, no border on the open session, focus ring kept", { skip }, async () => {
  const { page, ctx } = await open(1280, 800, "/sessions", { notes: 3 });
  await page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
  await page.click("#sessbtn");
  await page.waitForFunction(() => document.querySelectorAll("#sesslist .sitem").length === 2);
  const cur = '#sesslist .sitem[aria-current="true"]', other = '#sesslist .sitem:not([aria-current="true"])';
  const c = await rowLook(page, cur);
  assert.equal(c.border, "0px", "the open session has no border box");
  // The shared menu rows (docs/ui-library.md, "Menus"): the open session is marked by a check in the accent colour and bold
  // text, not by a bar or a box.
  assert.equal(c.shadow, "none", "no bar or ring on the open session");
  const mark = await page.$eval(cur, (b: HTMLElement) => { const m = getComputedStyle(b, "::before"); return { content: m.content, mask: m.maskImage || (m as any).webkitMaskImage, w: m.width, weight: getComputedStyle(b).fontWeight }; });
  assert.equal(mark.content, '""');
  assert.match(mark.mask, /^url\("data:image\/svg\+xml/, "a check drawn from an inline icon (no request)");
  assert.equal(mark.w, "14px");
  assert.equal(mark.weight, "600", "bold");
  assert.equal(await page.$eval(other, (b: HTMLElement) => getComputedStyle(b, "::before").content), "none", "other rows have no check");
  assert.ok(c.h >= 36);
  const rest = await rowLook(page, other);
  await page.hover(other);
  await page.waitForTimeout(200);
  const hov = await rowLook(page, other);
  assert.equal(hov.shadow, "none", "no ring around a hovered row");
  assert.equal(hov.border, "0px");
  assert.notEqual(hov.bg, rest.bg, "hover is a quiet tint");
  // Rows line up: same left edge and padding.
  const lefts = await page.$$eval("#sesslist .sitem", (bs: HTMLElement[]) => bs.map((b) => [b.getBoundingClientRect().left, getComputedStyle(b).paddingLeft].join("|")));
  assert.equal(new Set(lefts).size, 1, `aligned rows (${lefts.join(", ")})`);
  // Keyboard focus still shows a 2px ring, inside the row so the list does not clip it.
  await page.keyboard.press("ArrowDown");
  const focused = await page.evaluate(() => document.activeElement!.classList.contains("sitem"));
  assert.equal(focused, true);
  const f = await page.evaluate(() => { const c = getComputedStyle(document.activeElement!); return { s: c.outlineStyle, w: parseFloat(c.outlineWidth), off: c.outlineOffset }; });
  assert.equal(f.s, "solid");
  assert.ok(f.w >= 2);
  assert.equal(f.off, "-2px");
  await ctx.close();
});

test("browser: the page tabs have no inner borders on desktop; phones keep their look", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  const d = await page.evaluate(() => { const n = getComputedStyle(document.getElementById("tabs")!), a = getComputedStyle(document.getElementById("assistanttab")!); return { track: n.borderTopColor, cur: a.borderTopColor, curBg: a.backgroundColor, trackBg: n.backgroundColor }; });
  assert.equal(d.track, "rgba(0, 0, 0, 0)", "no outline around the tabs");
  assert.equal(d.cur, "rgba(0, 0, 0, 0)", "no box around the current tab");
  assert.notEqual(d.curBg, d.trackBg, "the current tab is still raised");
  await ctx.close();
  const p = await open(390, 844, "/#assistant", { phone: true });
  const m = await p.page.evaluate(() => { const a = getComputedStyle(document.getElementById("assistanttab")!), line = getComputedStyle(document.documentElement).getPropertyValue("--line").trim(); const probe = document.createElement("i"); probe.style.color = line; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return { cur: a.borderTopColor, line: c }; });
  assert.equal(m.cur, m.line, "the phone's current tab keeps its edge");
  // Phones use the same menu rows: the open session is marked by its check, with no border box.
  await p.ctx.close();
  const s = await open(390, 844, "/sessions", { phone: true });
  await s.page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
  await s.page.click("#sessbtn");
  await s.page.waitForFunction(() => document.querySelectorAll("#sesslist .sitem").length === 2);
  assert.equal((await rowLook(s.page, '#sesslist .sitem[aria-current="true"]')).border, "0px");
  assert.equal(await s.page.$eval('#sesslist .sitem[aria-current="true"]', (b: HTMLElement) => getComputedStyle(b, "::before").content), '""');
  await s.ctx.close();
});

// ---- themes -----------------------------------------------------------------------------------------------------------

const CONTRAST = `(pairs) => {
  const probe = document.createElement("div"); document.body.append(probe);
  const rgb = (expr) => {
    probe.style.color = ""; probe.style.color = expr; const c = getComputedStyle(probe).color;
    let m = c.match(/^rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/); if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
    m = c.match(/^color\\(srgb ([\\d.e-]+) ([\\d.e-]+) ([\\d.e-]+)/); if (m) return [+m[1], +m[2], +m[3]];
    throw new Error("unreadable colour " + expr + " -> " + c);
  };
  const lum = (c) => { const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const out = pairs.map(([fg, bg, min]) => { const a = lum(rgb(fg)), b = lum(rgb(bg)); return { pair: fg + " on " + bg, r: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), min }; });
  probe.remove(); return out;
}`;
const PAIRS: [string, string, number][] = [
  ["var(--fg)", "color-mix(in srgb, var(--attention) 6%, var(--card))", 4.5], // a note in the side panel
  ["var(--accent-2)", "color-mix(in srgb, var(--attention) 6%, var(--card))", 4.5], // its "more" link
  ["var(--muted)", "var(--surface-2)", 4.5], // unselected tab, status detail
  ["var(--fg)", "color-mix(in srgb, var(--info) 12%, var(--card))", 4.5], // hovered open session
  ["var(--accent-2)", "var(--info-soft)", 3], // the open session's accent bar
];

test("browser 1280px: the side panel and menu rows in Light and Dark: themed surfaces and AA contrast", { skip }, async () => {
  const bgs: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    const ctx = await chromium.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme === "dark" ? "light" : "dark" });
    await ctx.addInitScript((t: string) => { try { localStorage.setItem("orbit.theme", t); } catch { /* */ } }, theme);
    const page = await ctx.newPage();
    await page.goto(url + "/#assistant");
    await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
    await page.click("#sidetab-notes");
    const look = await page.evaluate(() => { const s = getComputedStyle(document.getElementById("side")!), card = getComputedStyle(document.documentElement).getPropertyValue("--card").trim(); const probe = document.createElement("i"); probe.style.color = card; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return { bg: s.backgroundColor, card: c, scheme: getComputedStyle(document.documentElement).colorScheme }; });
    assert.equal(look.bg, look.card, `${theme}: the panel is a card surface`);
    assert.equal(look.scheme, theme);
    bgs.push(look.bg);
    const rows: { pair: string; r: number; min: number }[] = await page.evaluate(`(${CONTRAST})(${JSON.stringify(PAIRS)})`);
    for (const { pair, r, min } of rows) assert.ok(r >= min, `${theme}: ${pair} is ${r.toFixed(2)}:1, below ${min}:1`);
    await ctx.close();
  }
  assert.notEqual(bgs[0], bgs[1], "the chosen theme wins over the device in both directions");
});

// ---- Status first, and the two panels together ------------------------------------------------------------------------

const navOpen = (page: any) => page.evaluate(() => document.documentElement.getAttribute("data-nav") === "open");
const room = (page: any) => page.evaluate(() => {
  const nav = document.getElementById("nav")!.getBoundingClientRect(), side = document.getElementById("side")!.getBoundingClientRect();
  const navRight = document.documentElement.getAttribute("data-nav") === "open" ? nav.right : 0;
  const msgs = [...document.querySelectorAll("#alog .msg")].map((m) => m.getBoundingClientRect());
  return { between: side.left - navRight, msgLeft: Math.min(...msgs.map((m) => m.left)), msgRight: Math.max(...msgs.map((m) => m.right)), navRight, sideLeft: side.left };
});

test("browser 1280px: Status comes first, in the rail and open, and is the view a first open shows", { skip }, async () => {
  const { page, ctx, errors } = await open(1280, 800);
  const order = await page.$$eval("#side .sidetab", (t: Element[]) => t.map((b) => b.id));
  assert.deepEqual(order, ["sidetab-status", "sidetab-notes"]);
  const rail = await page.evaluate(() => [...document.querySelectorAll("#side .sidetab")].map((b) => b.getBoundingClientRect().top));
  assert.ok(rail[0]! < rail[1]!, "collapsed, the status dot sits above the bell");
  await page.click("#sidetoggle");
  assert.equal(await isOpen(page), true);
  assert.equal(await shown(page, "#statusline"), true, "the first open shows Status");
  assert.equal(await shown(page, "#inbox"), false);
  const open2 = await page.evaluate(() => [...document.querySelectorAll("#side .sidetab")].map((b) => b.getBoundingClientRect().left));
  assert.ok(open2[0]! < open2[1]!, "open, Status is the left tab");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1440px: with room for both, the sidebar and the side panel stay open together and cover nothing", { skip }, async () => {
  const { page, ctx, errors } = await open(1440, 900, "/#assistant", { nav: true });
  assert.equal(await navOpen(page), true, "the sidebar is docked open by default");
  await page.click("#sidetab-notes");
  assert.equal(await isOpen(page), true);
  assert.equal(await navOpen(page), true, "opening the side panel kept the sidebar open");
  const r = await room(page);
  assert.ok(r.between >= 480, `the conversation keeps its room (${r.between})`);
  assert.ok(r.msgLeft >= r.navRight - 1 && r.msgRight <= r.sideLeft + 1, `nothing is covered (${JSON.stringify(r)})`);
  assert.equal(await sideways(page), false);
  // Reopening the collapsed sidebar with the panel open keeps both too.
  await page.click("#navhandle");
  assert.equal(await navOpen(page), false);
  await page.click("#navhandle");
  assert.equal(await navOpen(page), true);
  assert.equal(await isOpen(page), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1024px: without room for both, opening one closes the other, either way round", { skip }, async () => {
  const { page, ctx, errors } = await open(1024, 700, "/#assistant", { nav: true });
  assert.equal(await navOpen(page), true);
  await page.click("#sidetab-status");
  assert.equal(await isOpen(page), true);
  assert.equal(await navOpen(page), false, "opening the side panel collapsed the sidebar");
  await page.click("#navhandle");
  assert.equal(await navOpen(page), true);
  assert.equal(await isOpen(page), false, "opening the sidebar collapsed the side panel to its rail");
  assert.equal(await sideways(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser: narrowing the window with both open closes the one opened earlier", { skip }, async () => {
  const { page, ctx, errors } = await open(1440, 900, "/#assistant", { nav: true });
  await page.click("#sidetab-status");
  assert.equal((await navOpen(page)) && (await isOpen(page)), true);
  await page.setViewportSize({ width: 1040, height: 900 });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-nav") !== "open");
  assert.equal(await isOpen(page), true, "the side panel, opened last, stays");
  // The other way round: the sidebar opened last stays.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click("#navhandle");
  assert.equal((await navOpen(page)) && (await isOpen(page)), true);
  await page.setViewportSize({ width: 1040, height: 900 });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-side") !== "open");
  assert.equal(await navOpen(page), true, "the sidebar, opened last, stays");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1280px: the right panel's edge matches the left sidebar's: the same resize strip and the same pill collapse handle", { skip }, async () => {
  const { page, ctx, errors } = await open(1280, 800, "/#assistant", { nav: true });
  const edge = () => page.evaluate(() => {
    const st = (id: string) => { const e = document.getElementById(id)!, c = getComputedStyle(e), b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), left: b.left, right: b.right, cursor: c.cursor, radius: c.borderTopLeftRadius, bg: c.backgroundColor }; };
    return { side: document.getElementById("side")!.getBoundingClientRect().left, nav: document.getElementById("nav")!.getBoundingClientRect().right, navhandle: st("navhandle"), sidetoggle: st("sidetoggle"), navresize: st("navresize"), sideresize: st("sideresize") };
  });
  // Collapsed: the pill straddles the rail's edge, at the same height as the left one.
  let g = await edge();
  assert.equal(g.sidetoggle.w, g.navhandle.w);
  assert.equal(g.sidetoggle.h, g.navhandle.h);
  assert.equal(g.sidetoggle.top, g.navhandle.top);
  assert.ok(g.sidetoggle.left < g.side && g.sidetoggle.right > g.side, "collapsed: on the rail's edge");
  await page.click("#sidetoggle");
  assert.equal(await isOpen(page), true);
  g = await edge();
  assert.ok(Math.abs((g.sidetoggle.left + g.sidetoggle.right) / 2 - g.side) <= 1, "open: centred on the panel's edge, as the left one is on its edge");
  assert.equal(g.sidetoggle.radius, g.navhandle.radius, "the same pill");
  assert.equal(g.sidetoggle.bg, g.navhandle.bg);
  assert.equal(g.sideresize.w, g.navresize.w, "the same strip width");
  assert.equal(g.sideresize.cursor, g.navresize.cursor);
  assert.ok(Math.abs(g.sideresize.left + g.sideresize.w / 2 - g.side) <= 1.5, "the strip sits on the panel's edge");
  // The strip shows the same accent tint on hover.
  await page.hover("#sideresize", { position: { x: 3, y: 300 } });
  await page.hover("#navresize", { position: { x: 3, y: 300 } });
  const tint = await page.evaluate(() => [getComputedStyle(document.getElementById("navresize")!).backgroundColor]);
  await page.hover("#sideresize", { position: { x: 3, y: 300 } });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("sideresize")!).backgroundColor), tint[0]);
  await page.click("#sidetoggle");
  assert.equal(await isOpen(page), false, "the pill collapses the panel");
  assert.deepEqual(errors, []);
  await ctx.close();
});
