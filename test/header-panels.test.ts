import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { isPagePath } from "./helpers/sessions-ui.ts";
import { serveWebAsset } from "./helpers/web-assets.ts";

// The page header and the side panel's views: page links and the theme toggle in the bar, and no notifications or status
// indicator there; those are the side panel's two tabs (docs/design-system.md, "Side panel"): the Notifications tab with the
// count and the Status tab with the level dot, each showing its view (the notifications; the status line with every pill and
// a new-tab link to /status). The pure <panels> helpers always run; the page's layout and controls run in a real browser
// (Playwright's Chromium) against a scripted fake of ORBIT's routes, and are skipped, saying so, where Playwright is not
// installed. Offline: no model, no real ORBIT. The side panel's own layout, resize and collapse checks are in
// test/side-panel-browser.test.ts.
// The fake keeps its notifications as ORBIT does (GET /notifications returns `current` on every read; a read consumes nothing).
// Receipts, reloads, restarts and run delivery against the REAL server are in test/notifications-real-server.test.ts.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))![1]!;
type Panels = { status: boolean; notes: boolean };
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
type Bounds = { min: number; max: number };
type WStore = Store & { removeItem(k: string): void };
const lib = new Function(`${block("panels")}; return { readPanels, writePanels, noteCountLabel, PANELS_KEY, SIDE_WIDTH_KEY, sideWidthBounds, clampSideWidth, readSideWidth, writeSideWidth, sideWidthForKey };`)() as {
  readPanels(s: Store | null): Panels;
  writePanels(s: Store | null, p: Panels): void;
  noteCountLabel(n: number): string;
  PANELS_KEY: string;
  SIDE_WIDTH_KEY: string;
  sideWidthBounds(vw: number, desk: boolean): Bounds;
  clampSideWidth(w: unknown, b: Bounds): number | null;
  readSideWidth(s: Store | null): number | null;
  writeSideWidth(s: WStore | null, w: number | null): void;
  sideWidthForKey(key: string, shift: boolean, w: number, b: Bounds): number | null;
};
const memStore = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

// ---- pure helpers -----------------------------------------------------------------------------------------------------

test("panels: both collapsed by default, and anything unreadable or odd is collapsed", () => {
  assert.deepEqual(lib.readPanels(null), { status: false, notes: false });
  assert.deepEqual(lib.readPanels(memStore()), { status: false, notes: false });
  for (const v of ["", "{", "null", "[]", '"x"', '{"status":"true","notes":1}', '{"status":null}']) {
    assert.deepEqual(lib.readPanels(memStore({ [lib.PANELS_KEY]: v })), { status: false, notes: false }, v);
  }
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(lib.readPanels(throwing), { status: false, notes: false });
  assert.doesNotThrow(() => lib.writePanels(throwing, { status: true, notes: true }));
  assert.doesNotThrow(() => lib.writePanels(null, { status: true, notes: true }));
});

test("panels: each panel's state is kept independently", () => {
  const s = memStore();
  lib.writePanels(s, { status: true, notes: false });
  assert.deepEqual(lib.readPanels(s), { status: true, notes: false });
  lib.writePanels(s, { status: false, notes: true });
  assert.deepEqual(lib.readPanels(s), { status: false, notes: true });
});

test("side panel width: bounds keep the conversation 480px on desktops and a strip of the page on phones, 280 to 720px", () => {
  assert.deepEqual(lib.sideWidthBounds(1280, true), { min: 280, max: 720 });
  assert.deepEqual(lib.sideWidthBounds(1024, true), { min: 280, max: 544 });
  assert.deepEqual(lib.sideWidthBounds(1600, true), { min: 280, max: 720 });
  assert.deepEqual(lib.sideWidthBounds(900, false), { min: 280, max: 720 });
  assert.deepEqual(lib.sideWidthBounds(390, false), { min: 280, max: 366 });
  assert.deepEqual(lib.sideWidthBounds(320, false), { min: 280, max: 296 });
  // A screen too narrow for 280px still gets a panel that fits it.
  const tiny = lib.sideWidthBounds(280, false);
  assert.ok(tiny.min <= 240 && tiny.max >= tiny.min, JSON.stringify(tiny));
  const b = { min: 280, max: 720 };
  assert.equal(lib.clampSideWidth(500.4, b), 500);
  assert.equal(lib.clampSideWidth(10, b), 280);
  assert.equal(lib.clampSideWidth(9000, b), 720);
  for (const bad of [null, undefined, NaN, Infinity, "400"]) assert.equal(lib.clampSideWidth(bad, b), null, String(bad));
});

test("side panel width: kept per device, and anything unreadable is the default", () => {
  const s = memStore();
  assert.equal(lib.readSideWidth(s), null);
  lib.writeSideWidth(s, 432.6);
  assert.equal(s.m.get(lib.SIDE_WIDTH_KEY), "433");
  assert.equal(lib.readSideWidth(s), 433);
  lib.writeSideWidth(s, null);
  assert.equal(s.m.has(lib.SIDE_WIDTH_KEY), false, "a reset forgets it");
  for (const v of ["", "wide", "-5", "50", "99999", "NaN"]) assert.equal(lib.readSideWidth(memStore({ [lib.SIDE_WIDTH_KEY]: v })), null, v);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(lib.readSideWidth(throwing), null);
  assert.equal(lib.readSideWidth(null), null);
  assert.doesNotThrow(() => lib.writeSideWidth(throwing, 400));
  assert.doesNotThrow(() => lib.writeSideWidth(null, 400));
});

test("side panel width: the resize handle's keys (Left widens, Right narrows, Shift for big steps, Home and End)", () => {
  const b = { min: 280, max: 720 };
  assert.equal(lib.sideWidthForKey("ArrowLeft", false, 400, b), 416);
  assert.equal(lib.sideWidthForKey("ArrowRight", false, 400, b), 384);
  assert.equal(lib.sideWidthForKey("ArrowLeft", true, 400, b), 464);
  assert.equal(lib.sideWidthForKey("ArrowRight", true, 400, b), 336);
  assert.equal(lib.sideWidthForKey("Home", false, 400, b), 280);
  assert.equal(lib.sideWidthForKey("End", false, 400, b), 720);
  assert.equal(lib.sideWidthForKey("ArrowLeft", false, 715, b), 720, "never past the bounds");
  assert.equal(lib.sideWidthForKey("ArrowRight", true, 300, b), 280);
  for (const k of ["Enter", "a", "Tab", "ArrowUp", "ArrowDown", "PageUp"]) assert.equal(lib.sideWidthForKey(k, false, 400, b), null, k);
});

test("the notification count label says how many, says none at zero, and never claims unread", () => {
  assert.equal(lib.noteCountLabel(0), "Notifications: none");
  assert.equal(lib.noteCountLabel(1), "Notifications: 1");
  assert.equal(lib.noteCountLabel(12), "Notifications: 12");
  assert.doesNotMatch(block("panels").replace(/\/\/[^\n]*/g, ""), /unread|seen/i);
});

test("the markup: page links in the header bar with no Status link and no indicators; the side panel's tabs hold them, collapsed", () => {
  const header = html.match(/<header>[\s\S]*?<\/header>/)![0];
  const bar = header.match(/<div class="bar">([\s\S]*?)<\/div><div id="sesspicker"/)![1]!;
  assert.match(bar, /<nav id="tabs" aria-label="ORBIT pages">/, "the page links are in the bar");
  assert.equal(html.match(/<nav\b/g)?.length, 1, "one navigation, no duplicate");
  const nav = header.match(/<nav id="tabs"[^>]*>([\s\S]*?)<\/nav>/)![1]!;
  assert.doesNotMatch(nav, /\/status|Status/, "no Status link in the page links");
  // The header has no notifications or status indicator, no panel and none of their words.
  assert.doesNotMatch(html, /id="notesbtn"|id="health"|id="sidetitle"|id="sideclose"/);
  assert.doesNotMatch(header, /id="(side|inbox|statusline|notecount)"|Notifications|All live|Status unknown/);
  // The side panel follows the header: a labelled complementary region whose head is the collapse button and the tab list.
  const side = html.match(/<aside id="side" class="pico" aria-label="Side panel">[\s\S]*?<\/aside>/)![0];
  assert.ok(html.indexOf(side) > html.indexOf("</header>"), "after the header");
  // class="pico": the panel is a component-library element (docs/ui-library.md).
  assert.match(side, /^<aside id="side" class="pico" aria-label="Side panel"><div class="sidehead"><button type="button" id="sidetoggle" aria-expanded="false" aria-controls="inbox statusline" aria-label="Side panel"[^>]*>/);
  assert.match(side, /<div class="sidetabs" role="tablist" aria-label="Side panel views" aria-orientation="vertical">/);
  for (const [tab, panel, label] of [["sidetab-notes", "inbox", "Notifications"], ["sidetab-status", "statusline", "Status"]]) {
    const b = side.match(new RegExp(`<button type="button" role="tab" id="${tab}"[^>]*>`))?.[0] ?? "";
    assert.match(b, new RegExp(`aria-controls="${panel}"`), tab);
    assert.match(b, /aria-label="[^"]+"/, tab);
    assert.match(side, new RegExp(`<div id="${panel}" role="tabpanel" aria-label="${label}" hidden>`), `${panel} starts hidden`);
  }
  assert.match(side, /<span id="notecount" class="count">\?<\/span>/, "the count starts unknown, never 0");
  assert.match(side, /<div id="sideresize" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="side" aria-label="Resize the side panel"/);
  // The status line holds the overall summary first, then a read-error line, the services (saying they are being read until
  // the first answer), then the running release (its label and the page link, then Deployed and Commit).
  assert.match(side, /<div id="statusline"[^>]*><div id="statussum">[\s\S]*?<div id="statuserr" role="alert" hidden><\/div><div class="sidelabel" id="serviceslabel">Services<\/div><div id="ports"><span class="empty">Reading status…<\/span><\/div><div class="sidelabel" id="releaselabel">Release<\/div><a id="statusopen" href="\/status" target="_blank" rel="noopener noreferrer"[^>]*>[\s\S]*?<\/a><dl id="deployinfo"[^>]*>[\s\S]*?<\/dl><\/div>/);
  // Before the first /status request the Status tab says the status has not been read yet, not that reading it failed.
  const status = side.match(/<button type="button" role="tab" id="sidetab-status"[^>]*>/)![0];
  assert.match(status, /class="sidetab unknown"/);
  assert.match(status, /title="Status unknown\. ORBIT's status has not been read yet\."/);
  assert.match(status, /aria-label="Status: Status unknown \(unknown\)"/);
  assert.doesNotMatch(status, /could not be read/);
  // Icons are decoration; the controls carry the words.
  for (const svg of (header + side).match(/<svg[^>]*>/g) ?? []) assert.match(svg, /aria-hidden="true"/);
});

// ---- the page in a real browser ---------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level header checks skipped";

let ports: unknown[] = [];
// The notes ORBIT is holding for the page. Not consumed by a read, as on the real server.
let current: { id: string; text: string }[] = [];
let acks: string[] = [];
let statusGets = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (isPagePath(url.pathname)) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (serveWebAsset(url.pathname, res)) return;
  if (url.pathname === "/status") { statusGets++; return json(200, { commit: "abc", ports }); }
  if (url.pathname === "/notifications") return json(200, { inbox: current.filter((n) => !acks.includes(n.id)), current });
  const ack = url.pathname.match(/^\/notifications\/([\w-]+)\/ack$/);
  if (ack && req.method === "POST") { acks.push(ack[1]!); return json(200, { id: ack[1], shown: { listed: true } }); }
  if (url.pathname === "/model/login") return json(403, { error: "no" });
  if (url.pathname === "/chat/proposals") return json(200, { proposals: [] });
  if (url.pathname === "/jobs") return json(200, { jobs: [] });
  if (url.pathname === "/threads") return json(200, { threads: [], notice: null });
  if (url.pathname === "/assistant") return json(200, { assistant: { session: { id: "assistant" }, title: "Assistant", persisted: true, problems: [], busy: false, rev: 1, archivedChunks: 0, chunks: [], next: { included: [], omitted: [], historyChars: 0 }, budgets: {} } });
  if (url.pathname === "/assistant/history") return json(200, { chunks: [], more: false });
  json(404, { error: "not found" });
});

let browser: any, context: any, page: any, base = "";
before(async () => {
  if (skip) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); server.close(); });

const live = (port: string, state = "live") => ({ port, state, detail: `${port} detail` });
async function open(opts: { hash?: string; width?: number; colorScheme?: string } = {}) {
  await context?.close();
  context = await browser.newContext({ viewport: { width: opts.width ?? 900, height: 700 }, colorScheme: opts.colorScheme ?? "light", reducedMotion: "reduce" });
  page = await context.newPage();
  await page.goto(`${base}${opts.hash ?? ""}`);
  await page.waitForFunction(() => document.readyState === "complete");
  await page.waitForFunction(() => document.querySelectorAll("#ports .pill").length > 0);
}
const reset = () => { ports = [live("model"), live("memory"), live("watch")]; current = []; acks = []; statusGets = 0; };
const notes = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `n${from + i}`, text: `Note ${from + i}\nmore text ${from + i}` }));
const visible = (sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.offsetParent !== null); }, sel);
const expanded = (sel: string) => page.getAttribute(sel, "aria-expanded");
const count = () => page.textContent("#notecount");

test("browser: page links sit in the header bar beside the theme toggle, with no Status link and no indicators, on desktop and phone widths", { skip }, async () => {
  reset();
  for (const width of [900, 360]) {
    await open({ width });
    assert.deepEqual(await page.$$eval("header .bar nav a:not([hidden])", (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute("href"))), ["/", "/#assistant", "/#jobs", "/sessions"]);
    assert.equal(await page.$$eval('header nav a[href="/status"]', (as: unknown[]) => as.length), 0);
    assert.equal(await page.getAttribute("#hometab", "aria-current"), "page", "the current page cue stays (the root is Home, docs/home.md)");
    const box = await page.evaluate(() => { const r = (id: string) => document.getElementById(id)!.getBoundingClientRect(); return { theme: r("themebtn"), side: r("side"), brand: document.querySelector(".brand")!.getBoundingClientRect(), width: document.documentElement.clientWidth, text: document.querySelector("header")!.textContent }; });
    assert.ok(box.theme.right <= box.width && box.theme.left > box.brand.right, `the theme toggle on the right at ${width}px`);
    assert.doesNotMatch(box.text!, /Notifications|All live|Status/, `no indicator words in the header at ${width}px`);
    assert.ok(Math.abs(box.side.right - box.width) <= 1, `the side panel's rail at the right edge at ${width}px`);
    // Open both views in turn with many notes and a long pill: still no sideways scroll.
    ports = [...ports, live("a-very-long-port-name-that-should-wrap-rather-than-overflow", "degraded")];
    current = notes(11);
    await page.evaluate("refreshStatus(); refreshInbox()");
    await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "11");
    await page.click("#sidetab-status");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no horizontal overflow at ${width}px (Status)`);
    await page.click("#sidetab-notes");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no horizontal overflow at ${width}px (Notifications)`);
    reset();
  }
});

test("browser: the Status tab shows the status line of every pill; its icon opens /status in a new tab", { skip }, async () => {
  reset();
  await open();
  assert.equal(await expanded("#sidetoggle"), "false");
  assert.equal(await visible("#statusline"), false, "collapsed by default");
  await page.click("#sidetab-status");
  assert.equal(await expanded("#sidetoggle"), "true");
  assert.equal(await page.getAttribute("#sidetab-status", "aria-selected"), "true");
  assert.equal(await visible("#statusline"), true);
  assert.deepEqual(await page.$$eval("#statusline .pill", (ps: HTMLElement[]) => ps.map((p) => p.textContent)), ["model: live", "memory: live", "watch: live"]);
  // The panel sits directly below the header.
  const gap = await page.evaluate(() => document.getElementById("side")!.getBoundingClientRect().top - document.querySelector("header")!.getBoundingClientRect().bottom);
  assert.ok(Math.abs(gap) <= 1, `the side panel right under the header (gap ${gap}px)`);
  const link = await page.$eval("#statusopen", (a: HTMLAnchorElement) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel, label: a.getAttribute("aria-label") }));
  assert.deepEqual(link, { href: "/status", target: "_blank", rel: "noopener noreferrer", label: "Open the status page (raw JSON) in a new tab" });
  const [tab] = await Promise.all([context.waitForEvent("page"), page.click("#statusopen")]);
  await tab.waitForLoadState();
  assert.equal(new URL(tab.url()).pathname, "/status");
  assert.equal(new URL(page.url()).pathname, "/", "the page itself stays put");
  await tab.close();
  // Keyboard: Escape on the tab collapses the panel and the tab keeps focus; Enter and Space on it open it again.
  await page.focus("#sidetab-status");
  await page.keyboard.press("Escape");
  assert.equal(await expanded("#sidetoggle"), "false");
  assert.equal(await visible("#statusline"), false);
  await page.keyboard.press("Space");
  assert.equal(await expanded("#sidetoggle"), "true");
  assert.equal(await visible("#statusline"), true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  assert.equal(await visible("#statusline"), true);
  assert.equal(await page.evaluate(() => document.activeElement!.id), "sidetab-status");
  // The keyboard focus ring shows.
  assert.notEqual(await page.$eval("#sidetab-status", (b: HTMLElement) => getComputedStyle(b).outlineStyle), "none");
});

test("browser: a hidden status line keeps updating, and the Status tab keeps its meaning", { skip }, async () => {
  reset();
  await open();
  assert.equal(await page.getAttribute("#sidetab-status", "class"), "sidetab ok");
  ports = [live("model"), live("memory", "degraded")];
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.getElementById("sidetab-status")!.className === "sidetab degraded");
  assert.equal(await visible("#statusline"), false, "a bad status does not open the panel by itself");
  assert.equal(await expanded("#sidetoggle"), "false");
  assert.deepEqual(await page.$$eval("#ports .pill", (ps: HTMLElement[]) => ps.map((p) => `${p.className}|${p.textContent}`)), ["pill live|model: live", "pill degraded|memory: degraded"], "pills current while hidden");
  assert.equal(await page.getAttribute("#sidetab-status", "aria-label"), "Status: Degraded: 1 not live (degraded but working)");
  assert.equal(await page.getAttribute("#sidetab-status", "title"), "Degraded: 1 not live. Working, with degradation. Not live: memory: degraded.");
  await page.click("#sidetab-status");
  assert.equal(await page.textContent("#ports"), "model: livememory: degraded");
});

test("browser: the notification count is every undismissed note, not just the few listed, and follows arrivals and dismissals", { skip }, async () => {
  reset();
  await open();
  assert.equal(await count(), "0");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-label"), "Notifications, none");
  assert.equal(await page.getAttribute("#sidetab-notes", "title"), "Notifications: none");
  await page.click("#sidetab-notes");
  assert.equal(await page.textContent("#inbox"), "No notifications.", "an empty state, not a blank box");
  await page.click("#sidetoggle");
  current = notes(12);
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "12");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-label"), "Notifications, 12");
  assert.equal(await visible("#inbox"), false, "new notifications only change the count; the panel stays collapsed");
  assert.equal(await visible("#notecount"), true, "the count shows in the rail");
  assert.equal(await expanded("#sidetoggle"), "false");
  // The hidden view was still rendered: ten listed, the rest behind "show all (12)".
  assert.equal(await page.$$eval("#inbox .note", (n: unknown[]) => n.length), 10);
  assert.equal(await page.textContent("#inbox .showall"), "show all (12)");
  await page.click("#sidetab-notes");
  await page.click("#inbox .showall");
  assert.equal(await page.$$eval("#inbox .note", (n: unknown[]) => n.length), 12);
  assert.equal(await count(), "12");
  await page.click("#inbox .note .x");
  assert.equal(await count(), "11");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-label"), "Notifications, 11");
  // A keyboard user who dismissed a note stays in the panel.
  await page.focus("#inbox .note .x");
  await page.keyboard.press("Enter");
  assert.equal(await count(), "10");
  assert.equal(await page.evaluate(() => document.getElementById("inbox")!.contains(document.activeElement)), true);
  // Two more arrive; ORBIT still holds all fourteen, two of them dismissed here.
  current = notes(12).concat(notes(2, 13));
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "12");
  // A repeated refresh with the same answer never doubles a note.
  await page.evaluate("refreshInbox()");
  await page.evaluate("refreshInbox()");
  assert.equal(await count(), "12");
  // Dismissed notes stay dismissed across a reload (this browser's dismissals), and the count agrees. The notes come back
  // because the server still holds them; this fake re-adds nothing after the reload.
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "12");
});

test("browser: the collapsed list shows the newest 10; show all appears only past 10, and a dismissal can cross that line", { skip }, async () => {
  reset();
  await open();
  await page.click("#sidetab-notes");
  const listed = () => page.$$eval("#inbox .note .first", (n: HTMLElement[]) => n.map((e) => e.textContent));
  const showall = () => page.$$eval("#inbox .showall", (b: HTMLElement[]) => b.map((e) => e.textContent));
  const newest = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => `Note ${from - i}`);
  const at = async (n: number) => {
    current = notes(n);
    await page.evaluate("refreshInbox()");
    await page.waitForFunction((v: string) => document.getElementById("notecount")!.textContent === v, String(n));
  };
  // 0: the empty state, no show all.
  assert.equal(await page.textContent("#inbox"), "No notifications.");
  assert.deepEqual(await showall(), []);
  // 3 and 10: every note listed, newest first, and no show all.
  await at(3);
  assert.deepEqual(await listed(), newest(3, 1));
  assert.deepEqual(await showall(), []);
  await at(10);
  assert.deepEqual(await listed(), newest(10, 1));
  assert.deepEqual(await showall(), [], "exactly 10: nothing is held back, so no show all");
  // 11: the newest 10, the oldest behind "show all (11)", which counts every undismissed note.
  await at(11);
  assert.deepEqual(await listed(), newest(11, 2));
  assert.deepEqual(await showall(), ["show all (11)"]);
  assert.equal(await count(), "11");
  // Expand and collapse.
  await page.click("#inbox .showall");
  assert.deepEqual(await listed(), newest(11, 1));
  assert.deepEqual(await showall(), ["show fewer"]);
  await page.click("#inbox .showall");
  assert.deepEqual(await listed(), newest(11, 2));
  assert.deepEqual(await showall(), ["show all (11)"]);
  // "more" on one note still opens just that note.
  await page.click("#inbox .note:nth-child(4) button:not(.x)");
  assert.deepEqual(await page.$$eval("#inbox .note .rest", (n: HTMLElement[]) => n.map((e) => e.textContent)), ["more text 8"]);
  // Dismissing one of 11 crosses the line: 10 left, all listed, show all gone; the open note stays open.
  await page.click("#inbox .note .x");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "10");
  assert.deepEqual(await listed(), newest(10, 1));
  assert.deepEqual(await showall(), []);
  assert.deepEqual(await page.$$eval("#inbox .note .rest", (n: HTMLElement[]) => n.map((e) => e.textContent)), ["more text 8"]);
  // One more arrives: back over the line, the newest 10 listed and the oldest behind show all again.
  current = notes(12);
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "11");
  assert.deepEqual(await listed(), ["Note 12", ...newest(10, 2)]);
  assert.deepEqual(await showall(), ["show all (11)"]);
});

test("browser: a collapsed panel sends no receipt; opening it sends one for each listed note only; collapsing never dismisses", { skip }, async () => {
  reset();
  await open();
  current = notes(11);
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "11");
  await page.waitForTimeout(300);
  assert.deepEqual(acks, [], "a count change is not display evidence: no receipt while collapsed");
  const dismissed = await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes"));
  await page.click("#sidetab-notes");
  const listedIds = Array.from({ length: 10 }, (_, i) => `n${i + 2}`).sort();
  for (let i = 0; acks.length < 10 && i < 100; i++) await page.waitForTimeout(20);
  assert.deepEqual([...acks].sort(), listedIds, "the ten listed (newest) notes, not the one past the limit");
  for (let i = 0; i < 4; i++) await page.click("#sidetoggle");
  await page.evaluate("refreshInbox()");
  await page.waitForTimeout(200);
  assert.deepEqual([...acks].sort(), listedIds, "collapsing and opening again sends nothing more and no duplicates");
  assert.equal(await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes")), dismissed, "collapsing is not dismissing");
  assert.equal(await count(), "11");
  // "more" still opens a note's rest, and says whether it is open (the panel is open again after the even number of toggles).
  assert.equal(await expanded("#sidetoggle"), "true");
  const more = '#inbox .note button:not(.x)';
  assert.equal(await page.getAttribute(more, "aria-expanded"), "false");
  await page.click(more);
  assert.equal(await page.getAttribute(more, "aria-expanded"), "true");
  assert.match(await page.textContent("#inbox .note .rest"), /more text 11/);
  assert.equal(await page.getAttribute("#inbox .note .x", "aria-label"), "Dismiss this notification");
});

test("browser: one view at a time; the open view survives refreshes, page switches and a reload in this tab", { skip }, async () => {
  reset();
  await open();
  await page.click("#sidetab-notes");
  assert.equal(await visible("#inbox"), true);
  assert.equal(await visible("#statusline"), false, "one view at a time");
  current = notes(2);
  await page.evaluate("refreshStatus(); refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "2");
  assert.equal(await expanded("#sidetoggle"), "true");
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-selected"), "true");
  await page.click("#sidetab-status");
  assert.equal(await visible("#inbox"), false, "switching views hides the other");
  await page.click('#tabs a[data-tab="chat"]');
  await page.waitForFunction(() => document.body.dataset.tab === "chat");
  assert.equal(await visible("#statusline"), true, "kept across page switches");
  await page.click("#sidetoggle");
  await page.click("#assistanttab");
  await page.waitForFunction(() => document.body.dataset.tab === "assistant");
  assert.equal(await visible("#inbox"), false);
  assert.equal(await visible("#statusline"), false, "collapsed stays collapsed");
  await page.click("#sidetoggle");
  assert.equal(await visible("#statusline"), true, "the button reopens the last view");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#ports .pill").length > 0);
  assert.equal(await expanded("#sidetoggle"), "true", "kept for this tab's session");
  assert.equal(await page.getAttribute("#sidetab-status", "aria-selected"), "true");
  assert.equal(await visible("#statusline"), true);
  assert.equal(await visible("#inbox"), false);
  // A new tab (a new session) starts collapsed again.
  const fresh = await context.newPage();
  await fresh.goto(base);
  await fresh.waitForFunction(() => document.readyState === "complete");
  assert.equal(await fresh.getAttribute("#sidetoggle", "aria-expanded"), "false");
  await fresh.close();
});

test("browser: an older page's state with both header panels open opens the side panel on Status (the first view)", { skip }, async () => {
  reset();
  await open();
  await page.evaluate(() => sessionStorage.setItem("orbit.header-panels", JSON.stringify({ status: true, notes: true })));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#ports .pill").length > 0);
  assert.equal(await visible("#statusline"), true);
  assert.equal(await visible("#inbox"), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("orbit.header-panels")), JSON.stringify({ status: true, notes: true }), "nothing is rewritten until Rai acts");
  await page.click("#sidetab-notes");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("orbit.header-panels")), JSON.stringify({ status: false, notes: true }));
});

test("browser: refreshes never take focus from the message box, and note text is shown as text", { skip }, async () => {
  reset();
  await open();
  await page.click("#sidetab-notes");
  await page.focus("#ainput");
  await page.keyboard.type("half-typed");
  current = [{ id: "evil", text: `<img src=x onerror="window.pwned=1"> https://github.com/o/r/pull/7 javascript:alert(1)` }];
  ports = [live("model", "down")];
  await page.evaluate("refreshStatus(); refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "1");
  await page.waitForFunction(() => document.getElementById("sidetab-status")!.className === "sidetab down");
  assert.equal(await page.evaluate(() => document.activeElement!.id), "ainput");
  assert.equal(await page.inputValue("#ainput"), "half-typed");
  assert.equal(await page.$$eval("#inbox img", (n: unknown[]) => n.length), 0);
  assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
  assert.match(await page.textContent("#inbox .note .first"), /<img src=x onerror="window\.pwned=1">/);
  assert.deepEqual(await page.$$eval("#inbox a", (as: HTMLAnchorElement[]) => as.map((a) => [a.getAttribute("href"), a.rel, a.target])), [["https://github.com/o/r/pull/7", "noopener noreferrer", "_blank"]]);
});

test("browser: dark and light themes both style the side panel and its indicators from the theme colours", { skip }, async () => {
  reset();
  const colours: Record<string, string> = {};
  for (const scheme of ["light", "dark"]) {
    await open({ colorScheme: scheme });
    current = notes(1);
    await page.evaluate("refreshInbox()");
    await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "1");
    const c = await page.evaluate(() => {
      const css = (sel: string, p: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(p);
      return { bg: css("#side", "background-color"), fg: css("#sidetab-status", "color"), badge: css("#notecount", "background-color") };
    });
    assert.notEqual(c.badge, "rgba(0, 0, 0, 0)", "a count above zero is highlighted");
    colours[scheme] = c.bg;
  }
  assert.notEqual(colours.light, colours.dark, "the rail follows the theme");
});
