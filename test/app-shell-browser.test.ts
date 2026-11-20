import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The app shell (docs/web-shell.md): a header, a conversation that scrolls by itself, and a composer, filling exactly the
// visible area at every width, with no page scrolling, no sideways overflow, Send never covered, the newest message readable
// above the composer, a bounded session picker, touch-sized header controls and AA contrast in both themes. Synthetic
// content from a scripted fake of ORBIT's routes (test/helpers/shell-fixture.ts).
//
// What this is and is not: Playwright's Chromium on Linux (and WebKit only where its browser is installed here), with
// phone-sized viewports and touch emulation. It is NOT iOS Safari: there is no real on-screen keyboard and no Safari
// toolbar. The keyboard and toolbar cases are covered by driving the page's own visual-viewport logic with a stand-in
// visualViewport object (clearly a simulation), and by Android-style layout resizes. Real-iPhone checks are a manual
// checklist in docs/web-shell.md.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

test("markup: the viewport keeps zoom, draws under the safe areas and lets Android resize for the keyboard", () => {
  const meta = html.match(/<meta name="viewport" content="([^"]+)">/)![1]!;
  assert.match(meta, /width=device-width/);
  assert.match(meta, /initial-scale=1/);
  assert.match(meta, /viewport-fit=cover/);
  assert.match(meta, /interactive-widget=resizes-content/);
  assert.doesNotMatch(meta, /maximum-scale|user-scalable|minimum-scale/, "pinch zoom is never limited");
});

test("markup: design tokens exist and the shell, composer and header use them", () => {
  for (const t of ["--space-1", "--space-2", "--space-3", "--space-4", "--text-sm", "--text-md", "--radius-md", "--radius-lg", "--elev-1", "--elev-2", "--z-popover", "--z-modal", "--ctl-sm", "--tap", "--safe-b"]) {
    assert.match(html, new RegExp(`${t}:`), `${t} is defined`);
  }
  assert.match(html, /:root\[data-kb="open"\] \{ --safe-b: 0px; \}/, "the home-indicator inset is dropped while the keyboard is open");
  assert.doesNotMatch(html, /maximum-scale|user-scalable=no/);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser app-shell checks skipped";

let chromium: any;
let webkit: any = null;
let webkitWhy = "";
const fixture = shellServer();
let url = "";
before(async () => {
  if (skip) return;
  url = await fixture.start();
  chromium = await playwright.chromium.launch();
  try { webkit = await playwright.webkit.launch(); } catch (e) { webkitWhy = String((e as Error).message).split("\n")[0]!; }
});
after(async () => { await chromium?.close(); await webkit?.close(); fixture.close(); });

type Size = { width: number; height: number; phone?: boolean; name: string };
const SIZES: Size[] = [
  { name: "320 portrait", width: 320, height: 568, phone: true },
  { name: "375 portrait", width: 375, height: 667, phone: true },
  { name: "390 portrait", width: 390, height: 844, phone: true },
  { name: "430 portrait", width: 430, height: 932, phone: true },
  { name: "568 landscape", width: 568, height: 320, phone: true },
  { name: "844 landscape", width: 844, height: 390, phone: true },
  { name: "tablet portrait", width: 820, height: 1180, phone: true },
  { name: "tablet landscape", width: 1180, height: 820, phone: true },
  { name: "desktop", width: 1280, height: 800 },
];

async function open(b: any, size: Size, route: string, opts: { colorScheme?: string; init?: string } = {}) {
  const ctx = await b.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light",
    ...(size.phone && b === chromium ? { isMobile: true, hasTouch: true } : size.phone ? { hasTouch: true } : {}) });
  const page = await ctx.newPage();
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(url + route);
  const conv = route.includes("sessions") ? "log" : "alog";
  await page.waitForFunction((id: string) => document.getElementById(id)!.querySelectorAll(".msg").length > 0, conv);
  await page.waitForTimeout(150);
  return { page, ctx, p: route.includes("sessions") ? "" : "a" };
}

// The shell's geometry: header, conversation and composer, and whether anything overflows or covers Send.
function shell(page: any, p: string) {
  return page.evaluate((p: string) => {
    const r = (e: Element) => e.getBoundingClientRect();
    const d = document.documentElement;
    const conv = document.getElementById(p ? "alog" : "log")!, form = document.getElementById(p ? "aform" : "form")!;
    const send = document.getElementById(p ? "asend" : "send")!, ta = document.getElementById(p ? "ainput" : "input")!;
    const hdr = document.querySelector("header")!;
    const s = r(send), c = r(conv), f = r(form), h = r(hdr), t = r(ta);
    const atSend = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    window.scrollTo(0, 400);
    const scrolled = window.scrollY || d.scrollTop || document.body.scrollTop;
    const msgs = conv.querySelectorAll(".msg");
    const last = msgs[msgs.length - 1]!;
    // Any element wider than the screen outside a scroll region of its own.
    const wide = [...document.body.querySelectorAll("*")].filter((e) => {
      if (!e.getClientRects().length || e.closest(".scrollx, pre, table, #sesspicker[hidden]")) return false;
      const b = r(e);
      return b.right > window.innerWidth + 1 || b.left < -1;
    }).map((e) => `${e.tagName}#${e.id}.${e.className}`).slice(0, 5);
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      docOverflowX: d.scrollWidth > d.clientWidth, docOverflowY: d.scrollHeight > d.clientHeight, scrolled,
      convOverflowX: conv.scrollWidth > conv.clientWidth + 1,
      header: { top: h.top, bottom: h.bottom }, conv: { top: c.top, bottom: c.bottom, height: c.height }, form: { top: f.top, bottom: f.bottom },
      send: { top: s.top, bottom: s.bottom, left: s.left, right: s.right }, ta: { right: t.right, bottom: t.bottom },
      sendCovered: !(atSend && (atSend === send || send.contains(atSend))),
      fromLatest: conv.scrollHeight - conv.scrollTop - conv.clientHeight,
      lastBottom: r(last).bottom, wide,
    };
  }, p);
}

function checkShell(g: any, what: string) {
  assert.equal(g.docOverflowX, false, `${what}: no sideways page overflow`);
  assert.equal(g.docOverflowY, false, `${what}: the page itself is not taller than the screen`);
  assert.equal(g.scrolled, 0, `${what}: the page cannot be scrolled`);
  assert.deepEqual(g.wide, [], `${what}: nothing sticks out sideways`);
  assert.equal(g.convOverflowX, false, `${what}: the conversation never scrolls sideways`);
  assert.ok(Math.abs(g.header.top) <= 1, `${what}: header at the top (${g.header.top})`);
  assert.ok(Math.abs(g.form.bottom - g.vh) <= 1, `${what}: composer on the bottom edge (${g.form.bottom} vs ${g.vh})`);
  assert.ok(g.conv.top >= g.header.bottom - 1, `${what}: the conversation starts under the header`);
  assert.ok(g.conv.bottom <= g.form.top + 1, `${what}: the conversation ends above the composer`);
  assert.ok(g.conv.height >= 40, `${what}: the conversation keeps some room (${g.conv.height}px)`);
  assert.ok(g.send.top >= 0 && g.send.bottom <= g.vh && g.send.left >= 0 && g.send.right <= g.vw, `${what}: Send fully on screen`);
  assert.equal(g.sendCovered, false, `${what}: nothing covers Send`);
  assert.ok(g.send.left - g.ta.right >= 7.5, `${what}: explicit space between the box (and its scrollbar) and Send (${g.send.left - g.ta.right}px)`);
}

for (const size of SIZES) {
  test(`browser (${size.name}): Assistant and Sessions, short and long chats: an app shell with nothing overflowing, Send clear, newest message readable`, { skip }, async () => {
    for (const exchanges of [1, 24]) {
      fixture.set({ exchanges, pending: false, card: exchanges > 1, notes: 3 });
      for (const route of ["/#assistant", "/sessions"]) {
        const { page, ctx, p } = await open(chromium, size, route);
        const g = await shell(page, p);
        const what = `${size.name} ${route} ${exchanges} exchange(s)`;
        checkShell(g, what);
        assert.ok(g.fromLatest <= 24, `${what}: opens at the newest message (${g.fromLatest}px short)`);
        assert.ok(g.lastBottom <= g.conv.bottom + 1, `${what}: the newest message ends above the composer`);
        await ctx.close();
      }
    }
  });
}

test("browser: zoom and text enlargement (200% and 400% equivalent widths): still one column, nothing sideways, Send reachable", { skip }, async () => {
  fixture.set({ exchanges: 6, card: true });
  for (const size of [{ name: "375 at 200%", width: 188, height: 334, phone: true }, { name: "1280 at 400%", width: 320, height: 200 }]) {
    const { page, ctx, p } = await open(chromium, size, "/#assistant");
    const g = await shell(page, p);
    assert.equal(g.docOverflowX, false, `${size.name}: no sideways page overflow`);
    assert.equal(g.scrolled, 0, `${size.name}: the page cannot be scrolled`);
    assert.ok(g.send.bottom <= g.vh + 1 && g.send.right <= g.vw + 1, `${size.name}: Send on screen`);
    assert.equal(g.sendCovered, false, `${size.name}: nothing covers Send`);
    await ctx.close();
  }
  // Pinch zoom is not blocked: a phone context reports a zoomable viewport (no maximum-scale), checked through the meta.
  const { page, ctx } = await open(chromium, SIZES[1]!, "/#assistant");
  assert.doesNotMatch(await page.getAttribute('meta[name="viewport"]', "content"), /maximum-scale|user-scalable/);
  await ctx.close();
});

test("browser (375): the composer grows to eight lines, then scrolls inside; Send stays level, visible and clear of the box's scrollbar", { skip }, async () => {
  fixture.set({ exchanges: 24, card: false });
  const { page, ctx, p } = await open(chromium, SIZES[1]!, "/#assistant");
  await page.waitForFunction(() => !(document.getElementById("asend") as HTMLButtonElement).disabled);
  const before = await shell(page, p);
  await page.fill("#ainput", Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n"));
  const g = await shell(page, p);
  checkShell(g, "14-line draft");
  assert.ok(g.fromLatest <= 24, "a reader at the bottom stays at the bottom while the composer grows");
  const box = await page.evaluate(() => { const t = document.getElementById("ainput") as HTMLTextAreaElement; const r = t.getBoundingClientRect(); return { scrolls: t.scrollHeight > t.clientHeight + 1, overflow: getComputedStyle(t).overflowY, right: r.right, top: r.top, bottom: r.bottom }; });
  assert.equal(box.scrolls, true, "past eight lines the box scrolls");
  assert.equal(box.overflow, "auto");
  assert.ok(Math.abs(g.send.bottom - g.ta.bottom) <= 1, "Send level with the box's last line");
  // A touch on the box's right edge (where its scrollbar is) lands on the box, never on Send's enlarged hit area.
  const hit = await page.evaluate(({ x, y }: { x: number; y: number }) => document.elementFromPoint(x, y)!.id, { x: box.right - 2, y: (box.top + box.bottom) / 2 });
  assert.equal(hit, "ainput", "the box's scrollbar area belongs to the box");
  const sendHitLeft = await page.evaluate(({ x, y }: { x: number; y: number }) => document.elementFromPoint(x, y)!.closest("button")?.id ?? "", { x: g.send.left - 1, y: (g.send.top + g.send.bottom) / 2 });
  assert.notEqual(sendHitLeft, "asend", "Send's hit area does not reach left into the gap");
  // Reading history: a scrolled-back reader is not moved by the composer growing or shrinking.
  await page.fill("#ainput", "");
  await page.evaluate(() => { document.getElementById("alog")!.scrollTop = 200; });
  await page.waitForTimeout(50);
  await page.fill("#ainput", "a\nb\nc\nd");
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => document.getElementById("alog")!.scrollTop), 200, "history position kept");
  assert.ok(before.form.top > g.form.top, "the composer grew upward");
  // The draft survives a trip to another page and back.
  await page.click("#sessionstab");
  await page.waitForFunction(() => document.body.dataset.tab === "chat");
  await page.click("#assistanttab");
  await page.waitForFunction(() => document.body.dataset.tab === "assistant");
  assert.equal(await page.inputValue("#ainput"), "a\nb\nc\nd", "the draft is kept");
  await ctx.close();
});

test("browser (320 and 375): the session picker is bounded on screen, layered above the page, keyboard-driven, and closes with Escape or a tap outside, returning focus", { skip }, async () => {
  fixture.set({ exchanges: 24 });
  for (const size of [SIZES[0]!, SIZES[1]!, SIZES[4]!]) {
    const { page, ctx } = await open(chromium, size, "/sessions");
    await page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
    await page.click("#sessbtn");
    await page.waitForFunction(() => !document.getElementById("sesspicker")!.hidden);
    const m = await page.evaluate(() => {
      const pk = document.getElementById("sesspicker")!, r = pk.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 30));
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight, onTop: Boolean(top && pk.contains(top)), focus: document.activeElement!.className, expanded: document.getElementById("sessbtn")!.getAttribute("aria-expanded") };
    });
    assert.ok(m.left >= 0 && m.right <= m.vw, `${size.name}: picker inside the width`);
    assert.ok(m.bottom <= m.vh - 4, `${size.name}: picker ends above the bottom (${m.bottom} vs ${m.vh})`);
    assert.equal(m.onTop, true, `${size.name}: picker paints above the conversation`);
    assert.equal(m.expanded, "true");
    assert.match(m.focus, /sitem/, `${size.name}: focus moves into the list`);
    await page.keyboard.press("ArrowDown");
    assert.match(await page.evaluate(() => document.activeElement!.className), /sitem/);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.getElementById("sesspicker")!.hidden), true, "Escape closes");
    assert.equal(await page.evaluate(() => document.activeElement!.id), "sessbtn", "focus returns to the button");
    await page.click("#sessbtn");
    await page.mouse.click(m.vw / 2, m.vh - 80 > m.bottom ? m.vh - 80 : m.vh - 10);
    assert.equal(await page.evaluate(() => document.getElementById("sesspicker")!.hidden), true, "a tap outside closes");
    await ctx.close();
  }
});

test("browser (touch, 320 and 390): header controls and page tabs are at least 44px hit areas, keep a visible focus ring, and every page stays reachable", { skip }, async () => {
  for (const size of [SIZES[0]!, SIZES[2]!]) {
    const { page, ctx } = await open(chromium, size, "/sessions");
    await page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
    const ids = ["assistanttab", "sessionstab", "notesbtn", "health", "sessbtn"];
    for (const id of ids) {
      const m = await page.evaluate((id: string) => {
        const e = document.getElementById(id)!, r = e.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const hits = (x: number, y: number) => { const t = document.elementFromPoint(x, y); return Boolean(t && (t === e || e.contains(t))); };
        return { w: r.width, h: r.height, up: hits(cx, cy - 21), down: hits(cx, cy + 21), visible: r.width > 0 && r.right <= window.innerWidth };
      }, id);
      assert.equal(m.visible, true, `${size.name} ${id}: visible`);
      assert.ok(m.h >= 35.5, `${size.name} ${id}: at least 36px tall (${m.h})`);
      assert.ok(m.up && m.down, `${size.name} ${id}: a touch 21px above or below the center still hits it (44px hit area)`);
      if (id === "notesbtn" || id === "health") assert.ok(m.w >= 43.5, `${size.name} ${id}: at least 44px wide (${m.w})`);
    }
    await page.focus("#notesbtn");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement!); return { id: document.activeElement!.id, style: cs.outlineStyle, w: parseFloat(cs.outlineWidth) }; });
    assert.equal(ring.style, "solid", `${size.name}: keyboard focus ring on ${ring.id}`);
    assert.ok(ring.w >= 2);
    await ctx.close();
  }
});

test("browser (390): notifications and status panels stay bounded, so the conversation and Send keep their room", { skip }, async () => {
  fixture.set({ exchanges: 8, notes: 12 });
  const { page, ctx, p } = await open(chromium, SIZES[4]!, "/#assistant"); // 568x320 landscape: the tightest height
  await page.click("#notesbtn");
  await page.click("#health");
  await page.waitForTimeout(100);
  const g = await shell(page, p);
  assert.equal(g.docOverflowY, false, "the page does not grow");
  assert.equal(g.scrolled, 0);
  assert.equal(g.sendCovered, false, "Send stays clear");
  assert.ok(g.send.bottom <= g.vh + 1, "Send on screen");
  const inbox = await page.evaluate(() => { const b = document.getElementById("inbox")!; return { h: b.getBoundingClientRect().height, scrolls: b.scrollHeight > b.clientHeight }; });
  assert.ok(inbox.h <= 320 * 0.3 + 1, `the notifications panel is at most 30% of the height (${inbox.h})`);
  await page.click("#notesbtn");
  await page.click("#health");
  await ctx.close();
  fixture.set({ notes: 3 });
});

// A stand-in visualViewport (installed before the page's script runs), so the page's keyboard/toolbar logic can be driven
// here. This simulates what iOS Safari reports; it is not iOS Safari.
const FAKE_VV = `(() => {
  const vv = new EventTarget();
  let h = null, top = 0, scale = 1;
  Object.defineProperties(vv, { height: { get: () => h ?? window.innerHeight }, width: { get: () => window.innerWidth }, offsetTop: { get: () => top }, offsetLeft: { get: () => 0 }, scale: { get: () => scale }, pageTop: { get: () => top }, pageLeft: { get: () => 0 } });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  window.__vv = (nh, nt, ns) => { h = nh; top = nt; scale = ns ?? 1; vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll")); };
})();`;

test("browser (390, simulated iOS keyboard): the shell follows the visual viewport, the composer sits on the keyboard, the bottom inset is not counted twice, and zoom lets go", { skip }, async () => {
  fixture.set({ exchanges: 24 });
  const { page, ctx, p } = await open(chromium, SIZES[2]!, "/#assistant", { init: FAKE_VV });
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await frame();
  const at = () => page.evaluate((p: string) => {
    const b = document.body.getBoundingClientRect(), f = document.getElementById(p ? "aform" : "form")!.getBoundingClientRect(), h = document.querySelector("header")!.getBoundingClientRect();
    const c = document.getElementById(p ? "alog" : "log")!;
    return { bodyTop: b.top, bodyH: b.height, formBottom: f.bottom, headerTop: h.top, kb: document.documentElement.getAttribute("data-kb"), vv: document.documentElement.hasAttribute("data-vv"), fromLatest: c.scrollHeight - c.scrollTop - c.clientHeight };
  }, p);
  let m = await at();
  assert.equal(m.vv, true, "the page measures the visual viewport");
  assert.equal(m.kb, null);
  assert.ok(Math.abs(m.bodyH - 844) <= 1);
  // Keyboard open: Safari shows 844 - 336 = 508px, panned down by 200px.
  await page.evaluate(() => (window as any).__vv(508, 200));
  await frame();
  m = await at();
  assert.equal(m.kb, "open", "keyboard detected");
  assert.ok(Math.abs(m.bodyTop - 200) <= 1 && Math.abs(m.bodyH - 508) <= 1, `the shell is the visible area (${m.bodyTop}, ${m.bodyH})`);
  assert.ok(Math.abs(m.headerTop - 200) <= 1, "the header is at the top of what is visible");
  assert.ok(Math.abs(m.formBottom - 708) <= 1, `the composer sits on the keyboard (${m.formBottom})`);
  assert.ok(m.fromLatest <= 24, "a reader at the bottom stays at the bottom");
  const pad = await page.evaluate((p: string) => parseFloat(getComputedStyle(document.getElementById(p ? "aform" : "form")!).paddingBottom), p);
  assert.ok(pad <= 6.5, `no home-indicator inset under the keyboard (${pad})`);
  // Keyboard closed again: back to the full height.
  await page.evaluate(() => (window as any).__vv(844, 0));
  await frame();
  m = await at();
  assert.equal(m.kb, null);
  assert.ok(Math.abs(m.bodyTop) <= 1 && Math.abs(m.bodyH - 844) <= 1, "full height again");
  assert.ok(m.fromLatest <= 24, "still at the newest message");
  // Toolbar collapse (a small height change, no keyboard): followed, not treated as a keyboard.
  await page.evaluate(() => (window as any).__vv(800, 0));
  await frame();
  m = await at();
  assert.equal(m.kb, null, "a toolbar change is not a keyboard");
  assert.ok(Math.abs(m.bodyH - 800) <= 1);
  // Pinch zoom: the page stops overriding the height.
  await page.evaluate(() => (window as any).__vv(422, 100, 2));
  await frame();
  m = await at();
  assert.equal(m.vv, false, "zoomed in: the page lets go");
  assert.ok(Math.abs(m.bodyH - 844) <= 1, "zoomed in: the shell is the layout height");
  // Listeners are removed on pagehide and back on pageshow.
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); (window as any).__vv(500, 0); });
  await frame();
  assert.equal((await at()).vv, false, "no updates while hidden");
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await frame();
  m = await at();
  assert.equal(m.vv, true);
  assert.ok(Math.abs(m.bodyH - 500) <= 1, "measured again when shown");
  await ctx.close();
});

test("browser (Android-style resize, 390x844 to 390x480 and back, then rotation): a reader at the bottom stays there, a reader in history stays put", { skip }, async () => {
  fixture.set({ exchanges: 24 });
  const { page, ctx, p } = await open(chromium, SIZES[2]!, "/#assistant");
  await page.setViewportSize({ width: 390, height: 480 });
  await page.waitForTimeout(100);
  let g = await shell(page, p);
  checkShell(g, "keyboard-sized");
  assert.ok(g.fromLatest <= 24, "kept at the newest message");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(100);
  g = await shell(page, p);
  checkShell(g, "rotated");
  assert.ok(g.fromLatest <= 24, "kept at the newest message after rotation");
  await page.evaluate(() => { document.getElementById("alog")!.scrollTop = 300; });
  await page.waitForTimeout(50);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(() => { const a = document.getElementById("alog")!; return a.scrollHeight - a.scrollTop - a.clientHeight > 24; }), "a reader in history is not pulled to the bottom");
  await ctx.close();
});

test("browser (320): a streaming reply and a confirmation card fit the column; Confirm and Cancel are on screen and touch-sized", { skip }, async () => {
  fixture.set({ exchanges: 3, card: true, pending: true });
  const { page, ctx, p } = await open(chromium, SIZES[0]!, "/sessions");
  const g = await shell(page, p);
  checkShell(g, "card + pending");
  const btns = await page.evaluate(() => [...document.querySelectorAll("#log .proposal button")].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, h: r.height, right: r.right }; }));
  assert.ok(btns.length >= 2, "Confirm and Cancel drawn");
  for (const b of btns) { assert.ok(b.right <= 320, `${b.t} inside the width`); assert.ok(b.h >= 35.5, `${b.t} touch-sized (${b.h})`); }
  await ctx.close();
  fixture.set({ pending: false, card: false });
});

test("browser: text and controls meet WCAG AA contrast in the light and dark themes", { skip }, async () => {
  for (const colorScheme of ["light", "dark"]) {
    const { page, ctx } = await open(chromium, SIZES[8]!, "/#assistant", { colorScheme });
    const pairs = await page.evaluate(() => {
      const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const lum = (hex: string) => {
        const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
      };
      const ratio = (a: string, b: string) => { const x = lum(v(a)), y = lum(v(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      return [["--fg", "--bg"], ["--fg", "--card"], ["--muted", "--bg"], ["--muted", "--card"], ["--accent-2", "--bg"], ["--accent-2", "--card"], ["--on-accent", "--accent"], ["--on-accent", "--accent-2"],
        ["--live", "--card"], ["--mock", "--card"], ["--mock", "--bg"], ["--down", "--card"], ["--down", "--bg"]].map(([a, b]) => ({ pair: `${a} on ${b}`, r: ratio(a!, b!) }));
    });
    for (const { pair, r } of pairs) assert.ok(r >= 4.5, `${colorScheme}: ${pair} is ${r.toFixed(2)}:1, below 4.5:1`);
    await ctx.close();
  }
});

test("browser: reduced motion turns off button and chevron transitions", { skip }, async () => {
  const ctx = await chromium.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(url + "/sessions");
  const d = await page.evaluate(() => [getComputedStyle(document.getElementById("asend")!).transitionDuration, getComputedStyle(document.querySelector("#sessbtn .chev")!).transitionDuration]);
  for (const x of d) assert.match(x, /^0s/);
  await ctx.close();
});

test("browser (WebKit engine, where installed): the shell holds at 375 and 390 (desktop WebKit, not iOS Safari)", { skip: skip || (!playwright ? true : false) }, async (t) => {
  if (!webkit) { t.skip(`WebKit is not available here (${webkitWhy || "not installed"})`); return; }
  fixture.set({ exchanges: 24, card: true, pending: false });
  for (const size of [SIZES[1]!, SIZES[2]!]) {
    for (const route of ["/#assistant", "/sessions"]) {
      const { page, ctx, p } = await open(webkit, size, route);
      checkShell(await shell(page, p), `WebKit ${size.name} ${route}`);
      await ctx.close();
    }
  }
});
