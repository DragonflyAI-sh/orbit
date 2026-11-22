import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer, SIDEBAR_REFS } from "./helpers/shell-fixture.ts";

// The left sidebar (docs/sidebar.md) and the desktop menu (docs/design-system.md, "Desktop menu"):
// - 1024px and wider: docked on the left under the header, open by default, with Projects (a selector), Plan, Files and
//   Images read from GET /sidebar (the real sidebarView over synthetic vault notes and photos, test/helpers/shell-fixture.ts),
//   then Notifications and status (two tabs, one view at a time) and the full indicators at the bottom. The conversation and
//   composer move right and are never covered. A handle on its right edge collapses it to the left edge and reopens it; a
//   separator resizes it by pointer or keyboard; each section collapses on its own; all of it is remembered;
// - narrower: a modal drawer, closed by default, opened by the menu button or the header's bell and status dot; Escape, the
//   close button or the scrim close it and focus goes back;
// - receipts are sent only for notes listed in a Notifications view that is on screen; the status view has loading, empty
//   and error states;
// - the session menu's rows have no nested outline on desktop and keep the keyboard focus ring; the page tabs lose their
//   inner borders on desktop; phones are unchanged.
// Chromium (Playwright) with synthetic content only. Skipped, saying so, without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; sidebar and desktop menu browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 12, card: true, notes: 14 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

async function open(width: number, height: number, route = "/#assistant", opts: { phone?: boolean; colorScheme?: string; notes?: number; sidebar?: "ok" | "vault-down" | 500; ctx?: any } = {}) {
  fixture.set({ notes: opts.notes ?? 14, sidebar: opts.sidebar ?? "ok" });
  const ctx = opts.ctx ?? await chromium.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light", ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const acks: string[] = [];
  page.on("request", (r: any) => { const m = new URL(r.url()).pathname.match(/^\/notifications\/([^/]+)\/ack$/); if (m && r.method() === "POST") acks.push(m[1]!); });
  await page.goto(url + route);
  const conv = route.includes("sessions") ? "log" : "alog";
  await page.waitForFunction((id: string) => document.getElementById(id)!.querySelectorAll(".msg").length > 0, conv);
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  await page.waitForFunction(() => document.getElementById("navprojnote")!.textContent !== "Reading the vault…");
  return { page, ctx, errors, acks };
}
const sideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const expanded = (page: any, sel: string) => page.getAttribute(sel, "aria-expanded");
const shown = (page: any, sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden"); }, sel);
const active = (page: any) => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || "");
// The words as written (textContent: section headers are drawn in capitals by CSS), and as laid out (innerText: one line each).
const words = (page: any, sel: string) => page.$$eval(sel, (es: HTMLElement[]) => es.map((e) => e.textContent!.trim()));
const texts = (page: any, sel: string) => page.$$eval(sel, (es: HTMLElement[]) => es.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
const geo = (page: any) => page.evaluate(() => {
  const r = (sel: string) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const msgs = [...document.querySelectorAll("#alog .msg, #log .msg")].filter((m) => (m as HTMLElement).offsetParent);
  const form = document.getElementById("aform")!.hidden ? "form" : "aform";
  return { nav: r("#nav"), header: r("header"), handle: r("#navhandle"), send: r(form === "form" ? "#send" : "#asend"), box: r(form === "form" ? "#input" : "#ainput"),
    msgRight: Math.max(...msgs.map((m) => m.getBoundingClientRect().right)), msgLeft: Math.min(...msgs.map((m) => m.getBoundingClientRect().left)),
    vw: document.documentElement.clientWidth, vh: window.innerHeight };
});

for (const [width, height] of [[1024, 700], [1280, 800], [1440, 900]] as const) {
  test(`browser ${width}px: the sidebar is docked open on the left with real sections, covers nothing, and the header shows icons only`, { skip }, async () => {
    const { page, ctx, errors } = await open(width, height);
    assert.equal(await shown(page, "#nav"), true, "open by default on a wide screen");
    assert.equal(await page.getAttribute("#nav", "aria-label"), "Sidebar");
    assert.equal(await page.getAttribute("#nav", "role"), null, "not a dialog when docked");
    assert.equal(await expanded(page, "#navhandle"), "true");
    assert.equal(await page.getAttribute("#navhandle", "aria-label"), "Collapse the sidebar");
    const g = await geo(page);
    assert.ok(Math.abs(g.nav.left) <= 1, "on the left edge");
    assert.ok(Math.abs(g.nav.top - g.header.bottom) <= 1, `under the header (${g.nav.top} vs ${g.header.bottom})`);
    assert.ok(Math.abs(g.nav.bottom - g.vh) <= 1, "down to the bottom of the screen");
    assert.ok(Math.abs(g.nav.width - 280) <= 1, `the default width (${g.nav.width})`);
    assert.ok(g.msgLeft >= g.nav.right + 8, `the conversation is not covered (${g.msgLeft} vs ${g.nav.right})`);
    assert.ok(g.box.left >= g.nav.right + 8, "the composer is not covered");
    assert.ok(g.handle.left < g.nav.right && g.handle.right > g.nav.right, "the collapse handle sits on the sidebar's right edge");
    // The sections, in order, each with a header button that controls its content.
    assert.deepEqual(await words(page, "#nav .navtoggle"), ["Projects", "Plan", "Files", "Images", "Notifications and status"]);
    for (const name of ["projects", "plan", "files", "images", "activity"]) assert.equal(await page.getAttribute(`#navh-${name}`, "aria-controls"), `navbody-${name}`);
    // Real data from the vault: active projects only (the done one is left out), the plan from now.md, the related files, the photos.
    assert.deepEqual(await texts(page, "#navproject option"), ["All projects", "Alpha Garden", "Beta Desk (paused)"]);
    assert.equal(await page.textContent("#navprojnote"), "2 active projects in the vault.");
    assert.deepEqual(await texts(page, "#navplan .navlist li"), ["Ship the synthetic release", "Review the fixture plan", "Buy seeds todo · due 2026-11-30", "Fix the drawer todo"]);
    assert.deepEqual(await texts(page, "#navfiles .navfile .path"), ["now.md", "Projects/alpha-garden.md", "Projects/beta-desk.md"]);
    assert.equal(await page.$$eval("#navimages img", (is: HTMLImageElement[]) => is.length), 3);
    // Notifications and status: collapsed until asked for; the full indicators at the bottom carry the words.
    assert.equal(await expanded(page, "#navh-activity"), "false");
    assert.equal(await page.textContent("#navnotes"), "Notifications14");
    assert.equal(await page.textContent("#navstatuslabel"), "Degraded: 1 not live");
    // The header keeps the bell with its count and the status dot, with no words beside them.
    assert.equal((await page.innerText("header .hctl")).trim(), "14");
    assert.match(await page.getAttribute("#health", "aria-label"), /^Overall status: degraded but working\. Degraded: 1 not live\./, "the words stay in the accessible name");
    assert.equal(await sideways(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test("browser 1280px: the handle collapses the sidebar to the left edge and reopens it; the main content takes the full width; it is remembered", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  const before = await geo(page);
  await page.click("#navhandle");
  assert.equal(await shown(page, "#nav"), false);
  assert.equal(await expanded(page, "#navhandle"), "false");
  assert.equal(await page.getAttribute("#navhandle", "aria-label"), "Show the sidebar");
  const g = await geo(page);
  assert.ok(Math.abs(g.handle.left) <= 1, "collapsed: the handle stays at the left edge to reopen it");
  assert.ok(g.handle.width >= 20 && g.handle.height >= 36, "a visible handle");
  assert.ok(Math.abs(g.msgLeft - (g.vw - 860) / 2) <= 1, `the 860px column recentres in the full width (${g.msgLeft})`);
  assert.ok(g.msgLeft < before.msgLeft, "the content moved left into the freed room");
  assert.equal(await active(page), "navhandle", "focus stays on the handle");
  // Remembered across a reload (this browser).
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length > 0);
  assert.equal(await shown(page, "#nav"), false, "still collapsed after a reload");
  await page.focus("#navhandle");
  await page.keyboard.press("Enter");
  assert.equal(await shown(page, "#nav"), true);
  assert.equal(await expanded(page, "#navhandle"), "true");
  // Collapsing while the keyboard is inside the sidebar puts focus on the handle, never on nothing.
  await page.focus("#navh-plan");
  await page.click("#navhandle");
  assert.equal(await active(page), "navhandle");
  await page.click("#navhandle");
  await ctx.close();
});

test("browser 1280px: the separator resizes the sidebar by keyboard and by dragging, within bounds, and the width is remembered", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  const w = () => page.evaluate(() => Math.round(document.getElementById("nav")!.getBoundingClientRect().width));
  assert.equal(await page.getAttribute("#navresize", "role"), "separator");
  assert.equal(await page.getAttribute("#navresize", "aria-orientation"), "vertical");
  assert.equal(await page.getAttribute("#navresize", "aria-valuenow"), "280");
  await page.focus("#navresize");
  await page.keyboard.press("ArrowRight");
  assert.equal(await w(), 296);
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal(await w(), 232);
  await page.keyboard.press("Home");
  assert.equal(await w(), 220, "the narrowest");
  await page.keyboard.press("End");
  assert.equal(await w(), 480, "the widest");
  assert.equal(await page.getAttribute("#navresize", "aria-valuenow"), "480");
  // Drag the separator 100px to the left.
  const r = await page.evaluate(() => { const b = document.getElementById("navresize")!.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 200 }; });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x - 50, r.y, { steps: 3 });
  await page.mouse.move(r.x - 100, r.y, { steps: 3 });
  await page.mouse.up();
  assert.ok(Math.abs((await w()) - 380) <= 2, `dragged to about 380px (${await w()})`);
  const g = await geo(page);
  assert.ok(g.msgLeft >= g.nav.right + 8, "the conversation moves with it and is not covered");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length > 0);
  assert.ok(Math.abs((await w()) - 380) <= 2, "remembered after a reload");
  await page.evaluate(() => localStorage.removeItem("orbit.sidebar"));
  await ctx.close();
});

test("browser 1280px: each section collapses on its own, keeps its header, works by keyboard, and is remembered", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  assert.equal(await expanded(page, "#navh-plan"), "true");
  await page.click("#navh-plan");
  assert.equal(await expanded(page, "#navh-plan"), "false");
  assert.equal(await shown(page, "#navbody-plan"), false);
  assert.equal(await shown(page, "#navh-plan"), true, "the header stays");
  assert.equal(await shown(page, "#navbody-files"), true, "the others are untouched");
  await page.focus("#navh-images");
  await page.keyboard.press("Space");
  assert.equal(await expanded(page, "#navh-images"), "false");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length > 0);
  assert.equal(await expanded(page, "#navh-plan"), "false", "remembered");
  assert.equal(await expanded(page, "#navh-images"), "false");
  assert.equal(await expanded(page, "#navh-files"), "true");
  await page.click("#navh-plan");
  await page.click("#navh-images");
  assert.equal(await shown(page, "#navbody-plan"), true);
  await ctx.close();
});

test("browser 1280px: choosing a project scopes the plan, files and images to it, previews a note, enlarges a photo, and is remembered", { skip }, async () => {
  fixture.sidebarReads.length = 0;
  const { page, ctx } = await open(1280, 800);
  await page.selectOption("#navproject", "alpha-garden");
  await page.waitForFunction(() => document.getElementById("navplan")!.textContent!.includes("Projects/alpha-garden.md"));
  assert.ok(fixture.sidebarReads.includes("?project=alpha-garden"), "the server is asked for that project");
  // Plan: the project note's open next actions (the checked one is done), its resume point, and its open task.
  assert.deepEqual(await words(page, "#navplan .navsub"), ["Next actions", "Resume here", "Open tasks for this project"]);
  assert.deepEqual(await texts(page, "#navplan .navlist li"), ["Order the synthetic seeds", "Draw the watering plan", "Pick up at the trellis sketch.", "Buy seeds todo · due 2026-11-30"]);
  // Files: the project note, its task, the note that links to it, and the locations it lists.
  assert.deepEqual(await texts(page, "#navfiles .navfile .path"), ["Projects/alpha-garden.md", "Tasks/buy-seeds.md", "Resources/soil-notes.md"]);
  assert.deepEqual(await texts(page, "#navfiles .navsub + .navlist li"), ["~/projects/alpha-garden"]);
  // Images: only the photo whose caption names the project.
  assert.deepEqual(await page.$$eval("#navimages img", (is: HTMLImageElement[]) => is.map((i) => new URL(i.src).pathname)), [`/assistant/photos/${SIDEBAR_REFS[0]}`]);
  assert.match(await page.textContent("#navimages"), /Photos whose caption or conversation names this project\./);
  // A file's preview: read on demand, as text, and toggled.
  const file = "#navfiles .navfile >> nth=2";
  await page.click(file);
  await page.waitForFunction(() => /loam, not clay/.test(document.querySelector("#navfiles .navpreview:not([hidden])")?.textContent ?? ""));
  assert.equal(await page.getAttribute(file, "aria-expanded"), "true");
  await page.click(file);
  assert.equal(await page.getAttribute(file, "aria-expanded"), "false");
  // A photo opens the photo viewer; Escape closes it and focus returns to the thumbnail.
  await page.click("#navimages button");
  assert.equal(await shown(page, ".gviewer"), true);
  assert.match(await page.getAttribute(".gviewer", "aria-label"), /The alpha garden beds after rain · Assistant · sent/);
  await page.keyboard.press("Escape");
  assert.equal(await shown(page, ".gviewer"), false);
  assert.equal(await page.evaluate(() => document.activeElement!.closest("#navimages") !== null), true);
  // Remembered: a reload asks for the same project.
  await page.reload();
  await page.waitForFunction(() => (document.getElementById("navproject") as HTMLSelectElement).value === "alpha-garden");
  // Back to all projects.
  await page.selectOption("#navproject", "");
  await page.waitForFunction(() => document.getElementById("navplan")!.textContent!.includes("From now.md"));
  await ctx.close();
});

test("browser 1280px: a remembered project that is no longer active falls back to everything and says so; vault and read failures are shown, never blank", { skip }, async () => {
  const ctx = await chromium.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem("orbit.sidebar", JSON.stringify({ open: true, width: 280, closed: [], project: "old-shed" })); } catch { /* */ } });
  let { page } = await open(1280, 800, "/#assistant", { ctx });
  assert.equal(await page.textContent("#navprojnote"), "“old-shed” is not an active project in the vault, so everything is shown.");
  assert.equal(await page.inputValue("#navproject"), "");
  await page.close();
  ({ page } = await open(1280, 800, "/#assistant", { ctx, sidebar: "vault-down" }));
  assert.equal(await page.textContent("#navprojnote"), "The vault could not be read: synthetic outage");
  assert.equal(await page.getAttribute("#navplan .navnote", "role"), "alert");
  assert.equal(await page.textContent("#navplan"), "The vault could not be read: synthetic outage");
  assert.equal(await page.$$eval("#navimages img", (is: unknown[]) => is.length), 3, "the photos are still listed");
  await page.close();
  ({ page } = await open(1280, 800, "/#assistant", { ctx, sidebar: 500 }));
  assert.equal(await page.textContent("#navprojnote"), "The sidebar could not be read (HTTP 500).");
  assert.equal(await page.textContent("#navplan"), "Not read yet.");
  await ctx.close();
  fixture.set({ sidebar: "ok" });
});

test("browser 1280px: the header toggles show their view in the sidebar without moving focus; the tabs and section header switch and collapse it; it survives a reload", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  await page.focus("#notesbtn");
  await page.keyboard.press("Enter");
  assert.equal(await active(page), "notesbtn", "non-modal: never moves focus");
  assert.equal(await expanded(page, "#notesbtn"), "true");
  assert.equal(await expanded(page, "#navnotes"), "true", "the sidebar's indicator says the same");
  assert.equal(await expanded(page, "#health"), "false");
  assert.equal(await expanded(page, "#navh-activity"), "true");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-selected"), "true");
  assert.equal(await page.getAttribute("#inbox", "role"), "tabpanel");
  assert.equal(await page.getAttribute("#inbox", "aria-labelledby"), "sidetab-notes");
  assert.equal(await shown(page, "#inbox"), true);
  assert.equal(await shown(page, "#statusline"), false, "one view at a time");
  const r = await page.evaluate(() => document.getElementById("inbox")!.getBoundingClientRect().top);
  assert.ok(r < 800, "scrolled into the sidebar's view");
  // The status dot switches the view; the toggle of the shown view collapses the section.
  await page.click("#health");
  assert.equal(await shown(page, "#statusline"), true);
  assert.equal(await shown(page, "#inbox"), false);
  assert.equal(await expanded(page, "#notesbtn"), "false");
  assert.equal(await page.textContent("#statuslabel"), await page.textContent("#navstatuslabel"), "the same words as the indicator");
  await page.click("#health");
  assert.equal(await expanded(page, "#navh-activity"), "false");
  assert.equal(await shown(page, "#statusline"), false);
  // The section header reopens the last view; the footer indicators work like the header toggles.
  await page.click("#navh-activity");
  assert.equal(await shown(page, "#statusline"), true);
  await page.click("#navnotes");
  assert.equal(await shown(page, "#inbox"), true);
  // Tabs: one tab stop; arrows, Home and End switch and show the view.
  await page.focus("#sidetab-notes");
  await page.keyboard.press("ArrowRight");
  assert.equal(await active(page), "sidetab-status");
  assert.equal(await shown(page, "#statusline"), true);
  await page.keyboard.press("Home");
  assert.equal(await active(page), "sidetab-notes");
  await page.keyboard.press("End");
  assert.equal(await active(page), "sidetab-status");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await shown(page, "#inbox"), true);
  assert.equal(await page.getAttribute("#sidetab-status", "tabindex"), "-1");
  // Kept for this tab's session.
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  assert.equal(await expanded(page, "#notesbtn"), "true");
  assert.equal(await shown(page, "#inbox"), true);
  // Collapsing the sidebar hides the view: the toggles say so, and the next click shows it again.
  await page.click("#navhandle");
  assert.equal(await expanded(page, "#notesbtn"), "false");
  await page.click("#notesbtn");
  assert.equal(await shown(page, "#nav"), true, "the toggle reopens the sidebar on its view");
  assert.equal(await shown(page, "#inbox"), true);
  await ctx.close();
});

test("browser 1280px: receipts are sent only for notes listed in a Notifications view on screen: not from Status, not while the sidebar is collapsed", { skip }, async () => {
  const { page, ctx, acks } = await open(1280, 800);
  await page.click("#health");
  await page.waitForTimeout(250);
  assert.equal(acks.length, 0, "the Status view lists no notes");
  await page.click("#notesbtn");
  for (let i = 0; acks.length < 10 && i < 100; i++) await page.waitForTimeout(20);
  assert.deepEqual([...acks].sort(), Array.from({ length: 10 }, (_, i) => `n${i + 4}`).sort(), "the ten listed (newest), not the four past the limit");
  // Collapsed sidebar: a new arrival is not on screen, so it gets no receipt until the sidebar opens again.
  await page.click("#navhandle");
  fixture.set({ notes: 15 });
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "15");
  await page.waitForTimeout(250);
  assert.equal(acks.includes("n14"), false, "nothing acked while collapsed");
  await page.click("#navhandle");
  for (let i = 0; !acks.includes("n14") && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(acks.includes("n14"), true, "acked once it is on screen");
  await ctx.close();
});

test("browser 1280px: the status view says when it is reading, when the read failed, and keeps the last answer", { skip }, async () => {
  const ctx = await chromium.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
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
  await page.click("#health");
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
  await page.click("#notesbtn");
  assert.equal(await page.textContent("#inbox"), "No notifications.");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-label"), "Notifications, none");
  await ctx.close();
});

test("browser (390 phone): the sidebar is a drawer, closed by default; the menu button opens it as a modal dialog; Escape, × and the scrim close it with focus back", { skip }, async () => {
  const { page, ctx, errors } = await open(390, 844, "/#assistant", { phone: true });
  assert.equal(await shown(page, "#nav"), false, "closed by default on a phone");
  assert.equal(await shown(page, "#navhandle"), false, "no edge handle on a phone: the menu button opens it");
  assert.equal(await expanded(page, "#navbtn"), "false");
  assert.equal(await page.getAttribute("#navbtn", "aria-label"), "Show the sidebar");
  assert.equal(await page.getAttribute("#navbtn", "aria-controls"), "nav");
  await page.click("#navbtn");
  assert.equal(await shown(page, "#nav"), true);
  assert.equal(await expanded(page, "#navbtn"), "true");
  assert.deepEqual([await page.getAttribute("#nav", "role"), await page.getAttribute("#nav", "aria-modal")], ["dialog", "true"]);
  assert.equal(await active(page), "navclose", "the modal drawer takes focus");
  const inert = await page.evaluate(() => ["header", "#alog", "#aform"].map((s) => document.querySelector(s)!.hasAttribute("inert")));
  assert.deepEqual(inert, [true, true, true], "the page behind is inert");
  const g = await geo(page);
  assert.ok(g.nav.left === 0 && g.nav.top === 0 && Math.abs(g.nav.bottom - g.vh) <= 1 && g.nav.width <= 360, `a full-height drawer from the left (${JSON.stringify(g.nav)})`);
  assert.deepEqual(await texts(page, "#navproject option"), ["All projects", "Alpha Garden", "Beta Desk (paused)"], "the same real sections");
  assert.equal(await sideways(page), false);
  await page.keyboard.press("Escape");
  assert.equal(await shown(page, "#nav"), false);
  assert.equal(await active(page), "navbtn", "Escape puts focus back on the menu button");
  assert.equal(await page.evaluate(() => document.querySelector("header")!.hasAttribute("inert")), false);
  await page.click("#navbtn");
  await page.click("#navclose");
  assert.equal(await shown(page, "#nav"), false);
  assert.equal(await active(page), "navbtn");
  await page.click("#navbtn");
  await page.mouse.click(380, 400); // the scrim, right of the 360px drawer
  assert.equal(await shown(page, "#nav"), false, "a tap outside closes it");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser (390 phone): the bell and the status dot open the drawer on their view with focus on its tab; receipts only while the notes are on screen", { skip }, async () => {
  const { page, ctx, acks } = await open(390, 844, "/#assistant", { phone: true });
  await page.waitForTimeout(200);
  assert.equal(acks.length, 0, "a closed drawer lists nothing");
  await page.click("#notesbtn");
  assert.equal(await shown(page, "#nav"), true);
  assert.equal(await active(page), "sidetab-notes");
  assert.equal(await shown(page, "#inbox"), true);
  for (let i = 0; acks.length < 10 && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(acks.length, 10, "the listed notes get their receipt");
  await page.keyboard.press("Escape");
  assert.equal(await active(page), "notesbtn");
  await page.click("#health");
  assert.equal(await active(page), "sidetab-status");
  assert.equal(await shown(page, "#statusline"), true);
  assert.equal(await shown(page, "#inbox"), false);
  await page.keyboard.press("Escape");
  await ctx.close();
});

test("browser: resizing across 1024px switches between docked and drawer: an open drawer is dropped, the docked choice is kept", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  assert.equal(await shown(page, "#nav"), true);
  // The media query's change event comes with the next frame: wait for the page to have switched.
  const settled = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.setViewportSize({ width: 800, height: 800 });
  await settled();
  assert.equal(await shown(page, "#nav"), false, "a drawer, closed");
  await page.click("#navbtn");
  assert.equal(await page.getAttribute("#nav", "role"), "dialog");
  await page.setViewportSize({ width: 1280, height: 800 });
  await settled();
  assert.equal(await shown(page, "#nav"), true, "docked and open again");
  assert.equal(await page.getAttribute("#nav", "role"), null);
  assert.equal(await page.evaluate(() => [...document.body.children].some((c) => c.hasAttribute("inert"))), false, "nothing left inert");
  await page.click("#navhandle");
  await page.setViewportSize({ width: 800, height: 800 });
  await settled();
  await page.setViewportSize({ width: 1280, height: 800 });
  await settled();
  assert.equal(await shown(page, "#nav"), false, "the docked choice (collapsed) is kept");
  assert.equal(await sideways(page), false);
  await page.click("#navhandle");
  await ctx.close();
});

const rowLook = (page: any, sel: string) => page.$eval(sel, (b: HTMLElement) => { const c = getComputedStyle(b); return { shadow: c.boxShadow, border: c.borderTopWidth, bg: c.backgroundColor, outline: c.outlineStyle, outlineW: parseFloat(c.outlineWidth), h: b.getBoundingClientRect().height, transform: c.transform }; });

test("browser 1280px: the session menu's rows are plain aligned rows: no hover ring, no border on the open session, focus ring kept", { skip }, async () => {
  const { page, ctx } = await open(1280, 800, "/sessions", { notes: 3 });
  await page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
  await page.click("#sessbtn");
  await page.waitForFunction(() => document.querySelectorAll("#sesslist .sitem").length === 2);
  const cur = '#sesslist .sitem[aria-current="true"]', other = '#sesslist .sitem:not([aria-current="true"])';
  const c = await rowLook(page, cur);
  assert.equal(c.border, "0px", "the open session has no border box");
  assert.match(c.shadow, /inset/, "it is marked by an inset accent bar instead");
  assert.ok(c.h >= 40);
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
  // The phone menu rows keep their look too: the open session still has its border.
  await p.ctx.close();
  const s = await open(390, 844, "/sessions", { phone: true });
  await s.page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
  await s.page.click("#sessbtn");
  await s.page.waitForFunction(() => document.querySelectorAll("#sesslist .sitem").length === 2);
  assert.equal((await rowLook(s.page, '#sesslist .sitem[aria-current="true"]')).border, "1px");
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
  ["var(--fg)", "color-mix(in srgb, var(--attention) 6%, var(--card))", 4.5], // a note in the sidebar
  ["var(--muted)", "var(--card)", 4.5], // section headers, notes and file paths in the sidebar
  ["var(--accent-2)", "var(--card)", 4.5], // a photo's "Open" link
  ["var(--fg)", "var(--bg)", 4.5], // the project selector
  ["var(--accent-2)", "color-mix(in srgb, var(--attention) 6%, var(--card))", 4.5], // its "more" link
  ["var(--muted)", "var(--surface-2)", 4.5], // unselected tab, status detail
  ["var(--fg)", "color-mix(in srgb, var(--info) 12%, var(--card))", 4.5], // hovered open session
  ["var(--accent-2)", "var(--info-soft)", 3], // the open session's accent bar
];

test("browser 1280px: the sidebar and menu rows in Light and Dark: themed surfaces and AA contrast", { skip }, async () => {
  const bgs: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    const ctx = await chromium.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme === "dark" ? "light" : "dark" });
    await ctx.addInitScript((t: string) => { try { localStorage.setItem("orbit.theme", t); } catch { /* */ } }, theme);
    const page = await ctx.newPage();
    await page.goto(url + "/#assistant");
    await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
    await page.click("#notesbtn");
    const look = await page.evaluate(() => { const s = getComputedStyle(document.getElementById("nav")!), card = getComputedStyle(document.documentElement).getPropertyValue("--card").trim(); const probe = document.createElement("i"); probe.style.color = card; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return { bg: s.backgroundColor, card: c, scheme: getComputedStyle(document.documentElement).colorScheme }; });
    assert.equal(look.bg, look.card, `${theme}: the sidebar is a card surface`);
    assert.equal(look.scheme, theme);
    bgs.push(look.bg);
    const rows: { pair: string; r: number; min: number }[] = await page.evaluate(`(${CONTRAST})(${JSON.stringify(PAIRS)})`);
    for (const { pair, r, min } of rows) assert.ok(r >= min, `${theme}: ${pair} is ${r.toFixed(2)}:1, below ${min}:1`);
    await ctx.close();
  }
  assert.notEqual(bgs[0], bgs[1], "the chosen theme wins over the device in both directions");
});
