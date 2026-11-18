import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { isPagePath } from "./helpers/sessions-ui.ts";

// The page header: page links in the bar, a notifications count button and the status indicator on the right, each toggling
// its own panel below the bar (the status line with every pill and a new-tab link to /status; the notifications). The pure
// <panels> helpers always run; the page's layout and toggles run in a real browser (Playwright's Chromium) against a scripted
// fake of ORBIT's routes, and are skipped, saying so, where Playwright is not installed. Offline: no model, no real ORBIT.
// The fake keeps its notifications as ORBIT does (GET /notifications returns `current` on every read; a read consumes nothing).
// Receipts, reloads, restarts and run delivery against the REAL server are in test/notifications-real-server.test.ts.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))![1]!;
type Panels = { status: boolean; notes: boolean };
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const lib = new Function(`${block("panels")}; return { readPanels, writePanels, noteCountLabel, PANELS_KEY };`)() as {
  readPanels(s: Store | null): Panels;
  writePanels(s: Store | null, p: Panels): void;
  noteCountLabel(n: number): string;
  PANELS_KEY: string;
};
const memStore = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
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

test("the notification count label says how many, says none at zero, and never claims unread", () => {
  assert.equal(lib.noteCountLabel(0), "Notifications: none");
  assert.equal(lib.noteCountLabel(1), "Notifications: 1");
  assert.equal(lib.noteCountLabel(12), "Notifications: 12");
  assert.doesNotMatch(block("panels").replace(/\/\/[^\n]*/g, ""), /unread|seen/i);
});

test("the markup: page links in the header bar with no Status link; two toggle buttons; collapsed panels below the bar", () => {
  const header = html.match(/<header>[\s\S]*?<\/header>/)![0];
  const bar = header.match(/<div class="bar">([\s\S]*?)<\/div><div id="statusline"/)![1]!;
  assert.match(bar, /<nav id="tabs" aria-label="ORBIT pages">/, "the page links are in the bar");
  assert.equal(html.match(/<nav\b/g)?.length, 1, "one navigation, no duplicate");
  const nav = header.match(/<nav id="tabs"[^>]*>([\s\S]*?)<\/nav>/)![1]!;
  assert.doesNotMatch(nav, /\/status|Status/, "no Status link in the page links");
  for (const [button, panel] of [["notesbtn", "inbox"], ["health", "statusline"]]) {
    const b = bar.match(new RegExp(`<button type="button" id="${button}"[^>]*>`))?.[0] ?? "";
    assert.match(b, /aria-expanded="false"/, button);
    assert.match(b, new RegExp(`aria-controls="${panel}"`), button);
    assert.match(b, /aria-label="[^"]+"/, button);
    assert.match(header, new RegExp(`<div id="${panel}" role="region" aria-label="[^"]+" hidden>`), `${panel} starts collapsed`);
  }
  // The status line holds the pills and the page link, and comes straight after the bar.
  assert.match(header, /<\/div><\/div><div id="statusline"[^>]*><div id="ports"><\/div><a id="statusopen" href="\/status" target="_blank" rel="noopener noreferrer"/);
  // Before the first /status request the indicator says the status has not been read yet, not that reading it failed.
  const health = bar.match(/<button type="button" id="health"[^>]*>/)![0];
  assert.match(health, /title="ORBIT's status has not been read yet, so it is not known to be all live\. Show or hide the status line\."/);
  assert.match(health, /aria-label="Overall status: unknown, not all live\. ORBIT's status has not been read yet, so it is not known to be all live\."/);
  assert.doesNotMatch(health, /could not be read/);
  // Icons are decoration; the controls carry the words.
  for (const svg of header.match(/<svg[^>]*>/g) ?? []) assert.match(svg, /aria-hidden="true"/);
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
  context = await browser.newContext({ viewport: { width: opts.width ?? 900, height: 700 }, colorScheme: opts.colorScheme ?? "light" });
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

test("browser: page links sit in the header bar beside the toggles, with no Status link, on desktop and phone widths", { skip }, async () => {
  reset();
  for (const width of [900, 360]) {
    await open({ width });
    assert.deepEqual(await page.$$eval("header .bar nav a:not([hidden])", (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute("href"))), ["/#assistant", "/#jobs", "/sessions"]);
    assert.equal(await page.$$eval('header nav a[href="/status"]', (as: unknown[]) => as.length), 0);
    assert.equal(await page.getAttribute("#assistanttab", "aria-current"), "page", "the current page cue stays");
    const box = await page.evaluate(() => { const r = (id: string) => document.getElementById(id)!.getBoundingClientRect(); return { health: r("health"), notes: r("notesbtn"), brand: document.querySelector(".brand")!.getBoundingClientRect(), width: document.documentElement.clientWidth }; });
    assert.ok(box.health.right <= box.width && box.health.left > box.brand.right, `status indicator on the right at ${width}px`);
    assert.ok(box.notes.right <= box.health.left, `notifications button beside it at ${width}px`);
    // Open both panels with many notes and a long pill: still no sideways scroll.
    ports = [...ports, live("a-very-long-port-name-that-should-wrap-rather-than-overflow", "degraded")];
    current = notes(5);
    await page.evaluate("refreshStatus(); refreshInbox()");
    await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "5");
    await page.click("#health");
    await page.click("#notesbtn");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no horizontal overflow at ${width}px`);
    reset();
  }
});

test("browser: the status indicator toggles the status line of every pill; its icon opens /status in a new tab", { skip }, async () => {
  reset();
  await open();
  assert.equal(await expanded("#health"), "false");
  assert.equal(await visible("#statusline"), false, "collapsed by default");
  await page.click("#health");
  assert.equal(await expanded("#health"), "true");
  assert.equal(await visible("#statusline"), true);
  assert.deepEqual(await page.$$eval("#statusline .pill", (ps: HTMLElement[]) => ps.map((p) => p.textContent)), ["model: live", "memory: live", "watch: live"]);
  // The panel sits directly below the header bar.
  const gap = await page.evaluate(() => document.getElementById("statusline")!.getBoundingClientRect().top - document.querySelector("header .bar")!.getBoundingClientRect().bottom);
  assert.ok(gap >= 0 && gap <= 12, `status line right under the bar (gap ${gap}px)`);
  const link = await page.$eval("#statusopen", (a: HTMLAnchorElement) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel, label: a.getAttribute("aria-label") }));
  assert.deepEqual(link, { href: "/status", target: "_blank", rel: "noopener noreferrer", label: "Open the status page (raw JSON) in a new tab" });
  const [tab] = await Promise.all([context.waitForEvent("page"), page.click("#statusopen")]);
  await tab.waitForLoadState();
  assert.equal(new URL(tab.url()).pathname, "/status");
  assert.equal(new URL(page.url()).pathname, "/", "the page itself stays put");
  await tab.close();
  // Keyboard: Enter and Space work the toggle, and it keeps focus.
  await page.focus("#health");
  await page.keyboard.press("Enter");
  assert.equal(await expanded("#health"), "false");
  assert.equal(await visible("#statusline"), false);
  await page.keyboard.press("Space");
  assert.equal(await expanded("#health"), "true");
  assert.equal(await page.evaluate(() => document.activeElement!.id), "health");
  // The keyboard focus ring shows.
  assert.notEqual(await page.$eval("#health", (b: HTMLElement) => getComputedStyle(b).outlineStyle), "none");
});

test("browser: a collapsed status line keeps updating, and the indicator keeps its meaning", { skip }, async () => {
  reset();
  await open();
  assert.equal(await page.getAttribute("#health", "class"), "ok");
  ports = [live("model"), live("memory", "degraded")];
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.getElementById("health")!.className === "bad");
  assert.equal(await visible("#statusline"), false, "a bad status does not open the line by itself");
  assert.equal(await expanded("#health"), "false");
  assert.deepEqual(await page.$$eval("#ports .pill", (ps: HTMLElement[]) => ps.map((p) => `${p.className}|${p.textContent}`)), ["pill live|model: live", "pill degraded|memory: degraded"], "pills current while hidden");
  assert.match(await page.getAttribute("#health", "aria-label"), /Overall status: 1 not live\. Not all live\. memory: degraded\./);
  await page.click("#health");
  assert.equal(await page.textContent("#ports"), "model: livememory: degraded");
});

test("browser: the notification count is every undismissed note, not just the few listed, and follows arrivals and dismissals", { skip }, async () => {
  reset();
  await open();
  assert.equal(await count(), "0");
  assert.equal(await page.getAttribute("#notesbtn", "aria-label"), "Notifications: none");
  await page.click("#notesbtn");
  assert.equal(await page.textContent("#inbox"), "No notifications.", "an empty state, not a blank box");
  await page.click("#notesbtn");
  current = notes(5);
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "5");
  assert.equal(await page.getAttribute("#notesbtn", "aria-label"), "Notifications: 5");
  assert.equal(await visible("#inbox"), false, "new notifications only change the count; the panel stays closed");
  assert.equal(await expanded("#notesbtn"), "false");
  // The hidden panel was still rendered: three listed, the rest behind "show all (5)".
  assert.equal(await page.$$eval("#inbox .note", (n: unknown[]) => n.length), 3);
  assert.equal(await page.textContent("#inbox .showall"), "show all (5)");
  await page.click("#notesbtn");
  await page.click("#inbox .showall");
  assert.equal(await page.$$eval("#inbox .note", (n: unknown[]) => n.length), 5);
  assert.equal(await count(), "5");
  await page.click("#inbox .note .x");
  assert.equal(await count(), "4");
  assert.equal(await page.getAttribute("#notesbtn", "aria-label"), "Notifications: 4");
  // A keyboard user who dismissed a note stays in the panel.
  await page.focus("#inbox .note .x");
  await page.keyboard.press("Enter");
  assert.equal(await count(), "3");
  assert.equal(await page.evaluate(() => document.getElementById("inbox")!.contains(document.activeElement)), true);
  // Two more arrive; ORBIT still holds all seven, two of them dismissed here.
  current = notes(5).concat(notes(2, 6));
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "5");
  // A repeated refresh with the same answer never doubles a note.
  await page.evaluate("refreshInbox()");
  await page.evaluate("refreshInbox()");
  assert.equal(await count(), "5");
  // Dismissed notes stay dismissed across a reload (this browser's dismissals), and the count agrees. The notes come back
  // because the server still holds them; this fake re-adds nothing after the reload.
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "5");
});

test("browser: a collapsed panel sends no receipt; opening it sends one for each listed note only; hiding never dismisses", { skip }, async () => {
  reset();
  await open();
  current = notes(4);
  await page.evaluate("refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "4");
  await page.waitForTimeout(300);
  assert.deepEqual(acks, [], "a count change is not display evidence: no receipt while collapsed");
  const dismissed = await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes"));
  await page.click("#notesbtn");
  for (let i = 0; acks.length < 3 && i < 100; i++) await page.waitForTimeout(20);
  assert.deepEqual([...acks].sort(), ["n2", "n3", "n4"], "the three listed (newest) notes, not the one past the limit");
  for (let i = 0; i < 4; i++) await page.click("#notesbtn");
  await page.evaluate("refreshInbox()");
  await page.waitForTimeout(200);
  assert.deepEqual([...acks].sort(), ["n2", "n3", "n4"], "toggling again sends nothing more and no duplicates");
  assert.equal(await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes")), dismissed, "hiding is not dismissing");
  assert.equal(await count(), "4");
  // "more" still opens a note's rest, and says whether it is open (the panel is open again after the even number of toggles).
  assert.equal(await expanded("#notesbtn"), "true");
  const more = '#inbox .note button:not(.x)';
  assert.equal(await page.getAttribute(more, "aria-expanded"), "false");
  await page.click(more);
  assert.equal(await page.getAttribute(more, "aria-expanded"), "true");
  assert.match(await page.textContent("#inbox .note .rest"), /more text 4/);
  assert.equal(await page.getAttribute("#inbox .note .x", "aria-label"), "Dismiss this notification");
});

test("browser: the two toggles are independent and survive refreshes, page switches and a reload in this tab", { skip }, async () => {
  reset();
  await open();
  await page.click("#notesbtn");
  assert.equal(await visible("#inbox"), true);
  assert.equal(await visible("#statusline"), false, "opening one leaves the other alone");
  current = notes(2);
  await page.evaluate("refreshStatus(); refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "2");
  assert.equal(await expanded("#notesbtn"), "true");
  assert.equal(await expanded("#health"), "false");
  await page.click("#health");
  await page.click('#tabs a[data-tab="chat"]');
  await page.waitForFunction(() => document.body.dataset.tab === "chat");
  assert.equal(await visible("#inbox"), true);
  assert.equal(await visible("#statusline"), true);
  await page.click("#notesbtn");
  await page.click("#assistanttab");
  await page.waitForFunction(() => document.body.dataset.tab === "assistant");
  assert.equal(await visible("#inbox"), false);
  assert.equal(await visible("#statusline"), true);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#ports .pill").length > 0);
  assert.equal(await expanded("#health"), "true", "kept for this tab's session");
  assert.equal(await expanded("#notesbtn"), "false");
  assert.equal(await visible("#statusline"), true);
  assert.equal(await visible("#inbox"), false);
  // A new tab (a new session) starts collapsed again.
  const fresh = await context.newPage();
  await fresh.goto(base);
  await fresh.waitForFunction(() => document.readyState === "complete");
  assert.equal(await fresh.getAttribute("#health", "aria-expanded"), "false");
  assert.equal(await fresh.getAttribute("#notesbtn", "aria-expanded"), "false");
  await fresh.close();
});

test("browser: refreshes never take focus from the message box, and note text is shown as text", { skip }, async () => {
  reset();
  await open();
  await page.click("#notesbtn");
  await page.click("#health");
  await page.focus("#ainput");
  await page.keyboard.type("half-typed");
  current = [{ id: "evil", text: `<img src=x onerror="window.pwned=1"> https://github.com/o/r/pull/7 javascript:alert(1)` }];
  ports = [live("model", "down")];
  await page.evaluate("refreshStatus(); refreshInbox()");
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "1");
  await page.waitForFunction(() => document.getElementById("health")!.className === "bad");
  assert.equal(await page.evaluate(() => document.activeElement!.id), "ainput");
  assert.equal(await page.inputValue("#ainput"), "half-typed");
  assert.equal(await page.$$eval("#inbox img", (n: unknown[]) => n.length), 0);
  assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
  assert.match(await page.textContent("#inbox .note .first"), /<img src=x onerror="window\.pwned=1">/);
  assert.deepEqual(await page.$$eval("#inbox a", (as: HTMLAnchorElement[]) => as.map((a) => [a.getAttribute("href"), a.rel, a.target])), [["https://github.com/o/r/pull/7", "noopener noreferrer", "_blank"]]);
});

test("browser: dark and light themes both style the header toggles from the theme colours", { skip }, async () => {
  reset();
  const colours: Record<string, string> = {};
  for (const scheme of ["light", "dark"]) {
    await open({ colorScheme: scheme });
    current = notes(1);
    await page.evaluate("refreshInbox()");
    await page.waitForFunction(() => document.getElementById("notecount")!.textContent === "1");
    const c = await page.evaluate(() => {
      const css = (sel: string, p: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(p);
      const root = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      return { bg: css("#notesbtn", "background-color"), card: root("--card"), fg: css("#health", "color"), badge: css("#notecount", "background-color") };
    });
    assert.notEqual(c.badge, "rgba(0, 0, 0, 0)", "a count above zero is highlighted");
    colours[scheme] = c.bg;
  }
  assert.notEqual(colours.light, colours.dark, "the toggles follow the theme");
});
