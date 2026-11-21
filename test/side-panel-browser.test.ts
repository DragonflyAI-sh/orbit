import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The desktop menu and the side panel (docs/design-system.md, "Desktop menu" and "Side panel"):
// - laptops and desktops (1024px and wider): Notifications and Status open in one non-modal panel on the right, with a
//   heading, a close button and a tab per view; the conversation and composer move left and are never covered; each view
//   scrolls on its own; Escape and the close button put focus back on the toggle; the tabs work by keyboard; receipts are
//   sent only for notes actually listed; the status view has loading, empty and error states;
// - narrower screens keep the header panels exactly as before (independent, in the header);
// - the session menu's rows have no nested outline on desktop (no hover ring, no border on the open session) and keep the
//   keyboard focus ring; the page tabs lose their inner borders on desktop; phones are unchanged.
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

async function open(width: number, height: number, route = "/#assistant", opts: { phone?: boolean; colorScheme?: string; notes?: number } = {}) {
  fixture.set({ notes: opts.notes ?? 14 });
  const ctx = await chromium.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light", ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
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
const shown = (page: any, sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden"); }, sel);
const active = (page: any) => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || "");
const geo = (page: any) => page.evaluate(() => {
  const r = (sel: string) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const msgs = [...document.querySelectorAll("#alog .msg, #log .msg")].filter((m) => (m as HTMLElement).offsetParent);
  return { side: r("#side"), header: r("header"), send: r(document.getElementById("aform")!.hidden ? "#send" : "#asend"), box: r(document.getElementById("aform")!.hidden ? "#input" : "#ainput"),
    msgRight: Math.max(...msgs.map((m) => m.getBoundingClientRect().right)), msgLeft: Math.min(...msgs.map((m) => m.getBoundingClientRect().left)),
    vw: document.documentElement.clientWidth, vh: window.innerHeight,
    bar: (() => { const c = document.getElementById(document.getElementById("aform")!.hidden ? "log" : "alog")!; return c.offsetWidth - c.clientWidth; })() };
});

for (const [width, height] of [[1024, 700], [1280, 800], [1440, 900]] as const) {
  test(`browser ${width}px: Notifications opens a side panel on the right that covers nothing and leaves focus on the toggle`, { skip }, async () => {
    const { page, ctx, errors } = await open(width, height);
    assert.equal(await shown(page, "#side"), false, "closed by default");
    await page.focus("#notesbtn");
    await page.keyboard.press("Enter");
    assert.equal(await shown(page, "#side"), true);
    assert.equal(await active(page), "notesbtn", "non-modal: opening never moves focus");
    assert.equal(await expanded(page, "#notesbtn"), "true");
    assert.equal(await expanded(page, "#health"), "false");
    assert.equal(await page.getAttribute("#side", "role"), "region");
    assert.equal(await page.getAttribute("#side", "aria-labelledby"), "sidetitle");
    assert.equal(await page.textContent("#sidetitle"), "Notifications");
    assert.equal(await page.getAttribute("#sidetab-notes", "aria-selected"), "true");
    assert.equal(await page.getAttribute("#sidetab-status", "aria-selected"), "false");
    assert.equal(await page.getAttribute("#inbox", "role"), "tabpanel");
    assert.equal(await shown(page, "#inbox"), true);
    assert.equal(await shown(page, "#statusline"), false, "one view at a time");
    assert.equal(await page.getAttribute("#sideclose", "aria-label"), "Close the panel");
    const g = await geo(page);
    assert.ok(Math.abs(g.side.right - g.vw) <= 1, "on the right edge");
    assert.ok(Math.abs(g.side.top - g.header.bottom) <= 1, `under the header (${g.side.top} vs ${g.header.bottom})`);
    assert.ok(Math.abs(g.side.bottom - g.vh) <= 1, "down to the bottom of the screen");
    assert.ok(g.side.width >= 319 && g.side.width <= 401, `a sensible width (${g.side.width})`);
    assert.ok(g.msgRight <= g.side.left + 0.5, `the conversation is not covered (${g.msgRight} vs ${g.side.left})`);
    assert.ok(g.send.right <= g.side.left - 8, `Send stays clear of the panel (${g.send.right} vs ${g.side.left})`);
    assert.ok(g.box.width >= 300, `the message box stays usable (${g.box.width}px)`);
    assert.ok(g.side.left - g.msgLeft >= 500, "the conversation keeps a readable column");
    // The column is recentred in the room left of the panel: as wide as the measure allows, with the gutter each side.
    // (The conversation's own scrollbar sits inside its right padding.)
    const room = g.side.left, column = Math.min(860, room - 48), colW = g.msgRight - g.msgLeft;
    assert.ok(colW >= column - g.bar - 2, `the column uses the room left (${colW} of ${column}, scrollbar ${g.bar})`);
    assert.ok(Math.abs(g.msgLeft - (room - column) / 2) <= 2, `centred in it (left ${g.msgLeft})`);
    assert.equal(await sideways(page), false);
    // Clicking the conversation does not close a non-modal panel.
    await page.click("#ainput");
    assert.equal(await shown(page, "#side"), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test("browser 1280px: the toggles and tabs switch views, the toggle of the shown view closes it, and the state survives a reload", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  await page.click("#notesbtn");
  await page.click("#health");
  assert.equal(await shown(page, "#side"), true, "the status toggle switches the open panel, it does not close it");
  assert.equal(await page.textContent("#sidetitle"), "Status");
  assert.equal(await expanded(page, "#health"), "true");
  assert.equal(await expanded(page, "#notesbtn"), "false");
  assert.equal(await shown(page, "#statusline"), true);
  assert.equal(await shown(page, "#inbox"), false);
  assert.equal(await shown(page, "#statussum"), true, "the status view leads with the overall status");
  assert.equal(await page.textContent("#statuslabel"), await page.textContent("#health .label"), "the same words as the header indicator");
  assert.match(await page.textContent("#statusdetail"), /Not live: jobs: degraded/);
  assert.match(await page.getAttribute("#sidetab-status", "class"), /\bdegraded\b/);
  assert.equal(await page.getAttribute("#sidetab-notes", "aria-label"), "Notifications, 14");
  await page.click("#sidetab-notes");
  assert.equal(await page.textContent("#sidetitle"), "Notifications");
  assert.equal(await expanded(page, "#notesbtn"), "true");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  assert.equal(await shown(page, "#side"), true, "kept for this tab's session");
  assert.equal(await page.textContent("#sidetitle"), "Notifications");
  await page.click("#notesbtn");
  assert.equal(await shown(page, "#side"), false, "the toggle of the shown view closes the panel");
  assert.equal(await expanded(page, "#notesbtn"), "false");
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-side")), false);
  // Closed, the conversation takes its full centred column again.
  const g = await geo(page);
  assert.ok(Math.abs(g.msgLeft - (g.vw - 860) / 2) <= 1, `the column is centred again (${g.msgLeft})`);
  await ctx.close();
});

test("browser 1280px: tabs work by keyboard; Escape and the close button close the panel and put focus back on the toggle", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  await page.click("#notesbtn");
  // Tab from the toggles reaches the panel next (it follows them in the page order): close, then the selected tab only.
  await page.focus("#health");
  await page.keyboard.press("Tab");
  assert.equal(await active(page), "sideclose");
  await page.keyboard.press("Tab");
  assert.equal(await active(page), "sidetab-notes", "one tab stop for the tab list");
  await page.keyboard.press("ArrowRight");
  assert.equal(await active(page), "sidetab-status");
  assert.equal(await page.getAttribute("#sidetab-status", "aria-selected"), "true");
  assert.equal(await page.getAttribute("#sidetab-status", "tabindex"), "0");
  assert.equal(await page.getAttribute("#sidetab-notes", "tabindex"), "-1");
  assert.equal(await shown(page, "#statusline"), true);
  assert.notEqual(await page.$eval("#sidetab-status", (b: HTMLElement) => getComputedStyle(b).outlineStyle), "none", "a visible focus ring");
  await page.keyboard.press("ArrowRight");
  assert.equal(await active(page), "sidetab-notes", "wraps around");
  await page.keyboard.press("End");
  assert.equal(await active(page), "sidetab-status");
  await page.keyboard.press("Home");
  assert.equal(await active(page), "sidetab-notes");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await active(page), "sidetab-status");
  // Not a focus trap: Tab moves on into the view and then out of the panel to the rest of the page.
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.getElementById("side")!.contains(document.activeElement)), true, "into the view");
  for (let i = 0; i < 12 && (await page.evaluate(() => document.getElementById("side")!.contains(document.activeElement))); i++) await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.getElementById("side")!.contains(document.activeElement)), false, "Tab leaves the panel");
  // Escape inside the panel closes it and puts focus on the toggle of the view that was showing.
  await page.focus("#sidetab-status");
  await page.keyboard.press("Escape");
  assert.equal(await shown(page, "#side"), false);
  assert.equal(await active(page), "health");
  // The close button does the same for Notifications.
  await page.click("#notesbtn");
  await page.focus("#inbox .note .x");
  await page.keyboard.press("Escape");
  assert.equal(await shown(page, "#side"), false);
  assert.equal(await active(page), "notesbtn");
  await page.click("#notesbtn");
  await page.click("#sideclose");
  assert.equal(await shown(page, "#side"), false);
  assert.equal(await active(page), "notesbtn");
  assert.equal(await expanded(page, "#notesbtn"), "false");
  // Escape elsewhere (the message box) leaves the panel alone.
  await page.click("#notesbtn");
  await page.focus("#ainput");
  await page.keyboard.press("Escape");
  assert.equal(await shown(page, "#side"), true);
  await ctx.close();
});

test("browser 1280px: each view scrolls on its own; the head stays put and the conversation does not move", { skip }, async () => {
  const { page, ctx } = await open(1280, 700);
  await page.click("#notesbtn");
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
  assert.equal(afterScroll.head, before.head, "the heading and tabs stay");
  // The last note and its dismiss button are reachable (nothing clipped at the bottom).
  const last = await page.evaluate(() => { const b = document.getElementById("inbox")!; b.scrollTop = b.scrollHeight; const x = [...b.querySelectorAll(".note .x")].at(-1)!.getBoundingClientRect(); return { bottom: x.bottom, vh: window.innerHeight }; });
  assert.ok(last.bottom <= last.vh, "the last dismiss button is on screen when scrolled to the end");
  assert.equal(await sideways(page), false);
  await ctx.close();
});

test("browser 1280px: receipts are sent only for notes listed in the shown Notifications view, never from the Status view", { skip }, async () => {
  const { page, ctx, acks } = await open(1280, 800, "/#assistant", { notes: 12 });
  await page.click("#health");
  await page.waitForTimeout(300);
  assert.deepEqual(acks, [], "the Status view lists no notes, so it sends no receipt");
  await page.click("#sidetab-notes");
  const listed = Array.from({ length: 10 }, (_, i) => `n${i + 2}`).sort();
  for (let i = 0; acks.length < 10 && i < 100; i++) await page.waitForTimeout(20);
  await page.waitForTimeout(200);
  assert.deepEqual([...new Set(acks)].sort(), listed, "the ten listed (newest) notes only, not the two past the limit");
  const dismissed = await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes"));
  await page.click("#sideclose");
  assert.equal(await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes")), dismissed, "closing is not dismissing");
  assert.equal(await page.textContent("#notecount"), "12");
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

test("browser: below 1024px the panels stay in the header, independent, as before; resizing across switches cleanly", { skip }, async () => {
  for (const [w, h, phone] of [[390, 844, true], [900, 700, false]] as const) {
    const { page, ctx } = await open(w, h, "/#assistant", { phone });
    await page.click("#notesbtn");
    await page.click("#health");
    assert.equal(await shown(page, "#inbox"), true, `${w}: both open at once`);
    assert.equal(await shown(page, "#statusline"), true);
    assert.equal(await expanded(page, "#notesbtn"), "true");
    assert.equal(await expanded(page, "#health"), "true");
    assert.equal(await shown(page, "#side .sidehead"), false, `${w}: no side panel head`);
    assert.equal(await shown(page, "#statussum"), false, `${w}: the status line is as before`);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-side")), false);
    assert.equal(await page.getAttribute("#inbox", "role"), "region");
    assert.equal(await page.evaluate(() => document.querySelector("header")!.contains(document.getElementById("inbox"))), true);
    const inHeader = await page.evaluate(() => { const h = document.querySelector("header")!.getBoundingClientRect(), s = document.getElementById("statusline")!.getBoundingClientRect(); return s.top >= h.top && s.bottom <= h.bottom + 1; });
    assert.equal(inHeader, true, `${w}: the status line is inside the header`);
    assert.equal(await sideways(page), false);
    await ctx.close();
  }
  // A laptop window made narrow and wide again.
  const { page, ctx } = await open(1280, 800);
  await page.click("#notesbtn");
  await page.click("#health");
  assert.equal(await page.textContent("#sidetitle"), "Status");
  await page.setViewportSize({ width: 800, height: 800 });
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-side"));
  assert.equal(await shown(page, "#statusline"), true, "the open view stays open in the header");
  assert.equal(await shown(page, "#inbox"), false);
  assert.equal(await sideways(page), false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-side") === "open");
  assert.equal(await page.textContent("#sidetitle"), "Status");
  const g = await geo(page);
  assert.ok(Math.abs(g.side.top - g.header.bottom) <= 1, "placed under the header again");
  await ctx.close();
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
    await page.click("#notesbtn");
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
