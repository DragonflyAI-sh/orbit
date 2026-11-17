import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// The "↓ click to latest" control, in the Assistant (#alog) and in Sessions (#log): shown whenever the conversation is
// scrolled back from its newest message, even with nothing new; floating over the messages just above the composer and
// staying put while they scroll; scrolling to the newest message when clicked (or activated from the keyboard) and hiding
// at the bottom; never pulling a scrolled-back reader down when messages arrive; still following at the bottom, through
// composer, content and viewport size changes; hidden for a conversation that does not overflow and after a session switch.
// The markup checks always run; the rest runs in a real browser (Playwright's Chromium) against a scripted fake of ORBIT's
// routes and is skipped, saying so, where Playwright cannot be loaded. Phone sizes are emulated viewports in Chromium, not
// a real phone: an on-screen keyboard is not exercised.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const avatar = readFileSync(new URL("../src/web/avatar.png", import.meta.url));

// ---- markup ---------------------------------------------------------------------------------------------------------------

test("markup: each conversation has one real, initially hidden '↓ click to latest' button, between it and its composer", () => {
  for (const [main, id, next] of [["log", "tolatest", "<section id=\"jobs\""], ["alog", "atolatest", "<section id=\"jobs\""]] as const) {
    const at = html.indexOf(`<main id="${main}"`);
    const dock = html.indexOf(`<div class="latestdock"><button type="button" class="tolatest" id="${id}"`, at);
    assert.ok(at > 0 && dock > at && dock < html.indexOf(next), `${id} sits right after #${main}`);
    const b = html.slice(dock).match(/<button[^>]*>([\s\S]*?)<\/button>/)!;
    assert.match(b[0], /\shidden>/, `${id} starts hidden`);
    assert.equal(b[1]!.replace(/<[^>]+>/g, ""), "↓ click to latest", `${id} reads "↓ click to latest"`);
    assert.match(b[1]!, /<span aria-hidden="true">↓<\/span>/, "the arrow is decoration for screen readers");
  }
  assert.equal(html.match(/class="tolatest"/g)?.length, 2, "one per conversation, no duplicates");
  // The dock takes no room and lets clicks through; only the button takes them.
  assert.match(html, /\.latestdock \{[^}]*height: 0;[^}]*pointer-events: none;/);
  assert.match(html, /\.tolatest \{[^}]*pointer-events: auto;/);
  assert.match(html, /\.tolatest\[hidden\] \{ display: none; \}/);
  // Following and the button use the same small tolerance.
  assert.match(html, /const AT_LATEST_PX = 24;/);
  assert.match(html, /const nearBottom = \(\) => logLatest\.atLatest\(\);/);
  assert.match(html, /const aNearBottom = \(\) => alogLatest\.atLatest\(\);/);
  assert.doesNotMatch(html, /clientHeight < 80/, "no separate, looser follow threshold is left behind");
});

// ---- a fake ORBIT ---------------------------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser jump-to-latest checks skipped";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const para = (i: number) => `Message ${i}. ${"Some words that wrap across the line to give this message some height. ".repeat(4)}`;
const msgs = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({
  id: `${p}${i}`, role: i % 2 ? "assistant" : "user", at: "2026-11-17T08:00:00Z", text: para(i),
  ...(i % 2 ? { status: "done", provenance: "live", source: "model/x" } : {}),
}));

let threads: Record<string, any>;
let assistant: any;
const reset = (aCount = 30) => {
  threads = {
    [T1]: { id: T1, title: "Alpha", rev: 1, busy: false, archived: false, cards: [], messages: msgs("a", 30) },
    [T2]: { id: T2, title: "Beta", rev: 1, busy: false, archived: false, cards: [], messages: msgs("b", 30) },
    [T3]: { id: T3, title: "Short", rev: 1, busy: false, archived: false, cards: [], messages: msgs("c", 1) },
  };
  assistant = {
    session: { schema: 1, id: "assistant", createdAt: "2026-11-01T00:00:00Z" }, title: "Assistant", persisted: true, problems: [], busy: false, rev: 1, archivedChunks: 0,
    chunks: [{ seq: 1, id: "c1", createdAt: "2026-11-01T00:00:00Z", state: "open", cards: [], messages: msgs("m", aCount) }],
    next: { included: [{ seq: 1, form: "full", chars: 10 }], omitted: [], historyChars: 10 },
    budgets: { unit: "characters", activeChars: 32000, chunkMaxChars: 12000, contextChars: 52000, notesMaxChars: 12000 },
  };
};
reset();
const addAssistant = (n: number) => { const m = assistant.chunks[0].messages; m.push(...msgs(`x${m.length}-`, n)); assistant.rev++; };
const addThread = (id: string, n: number) => { const t = threads[id]; t.messages.push(...msgs(`y${t.messages.length}-`, n)); t.rev++; };

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/" || url.pathname === "/sessions" || url.pathname.startsWith("/sessions/")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (url.pathname === "/avatar.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(avatar); }
  if (url.pathname === "/status") return json(200, { ports: [{ port: "model", state: "live" }] });
  if (url.pathname === "/notifications") return json(200, { inbox: [] });
  if (url.pathname === "/model/login") return json(403, { error: "no" });
  if (url.pathname === "/chat/proposals") return json(200, { proposals: [] });
  if (url.pathname === "/jobs") return json(200, { jobs: [] });
  if (url.pathname === "/threads") return json(200, { threads: Object.values(threads).map((t) => ({ id: t.id, title: t.title, archived: false, rev: t.rev, busy: false, openCards: 0, messageCount: t.messages.length })), notice: null });
  const tm = url.pathname.match(/^\/threads\/([0-9a-f-]{36})$/);
  if (tm && threads[tm[1]!]) return json(200, { thread: threads[tm[1]!] });
  if (url.pathname === "/assistant") return json(200, { assistant });
  json(404, { error: "not found" });
});

let browser: any, context: any, page: any, base = "";
before(async () => {
  if (skip) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await playwright.chromium.launch();
});
after(async () => { await context?.close(); await browser?.close(); server.close(); });

type Opts = { viewport?: { width: number; height: number }; phone?: boolean; reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" };
async function open(path: string, sel: string, count: number, o: Opts = {}) {
  await context?.close();
  context = await browser.newContext({
    viewport: o.viewport ?? { width: 1000, height: 800 }, deviceScaleFactor: 1, reducedMotion: o.reducedMotion ?? "reduce", colorScheme: o.colorScheme ?? "light",
    ...(o.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  page = await context.newPage();
  await page.goto(`${base}${path}`);
  await page.waitForFunction(([s, n]: [string, number]) => document.querySelectorAll(`${s} .msg`).length === n, [sel, count]);
}
const A = { scroller: "#alog", button: "#atolatest", form: "#aform" } as const;
const S = { scroller: "#log", button: "#tolatest", form: "#form" } as const;
type V = typeof A | typeof S;
// Where the conversation is scrolled to, and the button's state and box.
const state = (v: V) => page.evaluate(([s, b]: [string, string]) => {
  const l = document.querySelector(s) as HTMLElement, btn = document.querySelector(b) as HTMLButtonElement;
  const r = btn.getBoundingClientRect();
  return { top: l.scrollTop, gap: l.scrollHeight - l.scrollTop - l.clientHeight, overflows: l.scrollHeight > l.clientHeight + 1, shown: !btn.hidden && r.height > 0, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height } };
}, [v.scroller, v.button]);
const scrollTo = (v: V, top: number) => page.evaluate(([s, t]: [string, number]) => { (document.querySelector(s) as HTMLElement).scrollTop = t; }, [v.scroller, top]);
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const waitShown = (v: V, shown: boolean) => page.waitForFunction(([b, want]: [string, boolean]) => (document.querySelector(b) as HTMLElement).hidden === !want, [v.button, shown]);

// ---- the Assistant --------------------------------------------------------------------------------------------------------

test("browser: at the bottom the button is hidden; scrolled back with nothing new it shows, floats above the composer and stays put", { skip }, async () => {
  reset();
  await open("/#assistant", "#alog", 30);
  let s = await state(A);
  assert.ok(s.overflows && s.gap <= 1, `opens at the newest message (${s.gap}px from the bottom)`);
  assert.equal(s.shown, false, "hidden at the bottom");
  // Within the tolerance: still counts as at the bottom.
  await scrollTo(A, s.top - 10); await settle();
  assert.equal((await state(A)).shown, false, "a few pixels back is still at the latest: no jitter");
  await scrollTo(A, s.top - 600); await waitShown(A, true);
  s = await state(A);
  assert.equal(s.shown, true);
  assert.equal((await page.textContent(A.button)).trim(), "↓ click to latest");
  // It overlays the bottom of the messages, just above the status line and composer, and is horizontally centered.
  const box = await page.evaluate(() => { const l = document.getElementById("alog")!.getBoundingClientRect(), f = document.getElementById("aform")!.getBoundingClientRect(); return { lTop: l.top, lBottom: l.bottom, lLeft: l.left, lRight: l.right, fTop: f.top }; });
  assert.ok(s.rect.top > box.lTop && s.rect.bottom <= box.lBottom, "inside the conversation's box");
  assert.ok(s.rect.bottom <= box.fTop - 4, `above the composer, not over it (${s.rect.bottom} vs ${box.fTop})`);
  assert.ok(box.fTop - s.rect.bottom < 40, "just above it");
  assert.ok(Math.abs((s.rect.left + s.rect.right) / 2 - (box.lLeft + box.lRight) / 2) <= 2, "centered");
  // Anchored: scrolling further back does not move it.
  await scrollTo(A, s.top - 400); await settle();
  assert.deepEqual((await state(A)).rect, s.rect, "stays put while the messages scroll");
  // Only the button takes clicks: beside it, the point belongs to the messages.
  const hits = await page.evaluate(([b]: [string]) => {
    const r = document.querySelector(b)!.getBoundingClientRect(), y = (r.top + r.bottom) / 2;
    const at = (x: number) => document.elementFromPoint(x, y);
    return { center: at((r.left + r.right) / 2)?.closest(".tolatest") !== null, beside: Boolean(at(r.left - 30)?.closest("#alog")), besideRight: Boolean(at(r.right + 30)?.closest("#alog")) };
  }, [A.button]);
  assert.deepEqual(hits, { center: true, beside: true, besideRight: true });
});

test("browser: new messages while scrolled back keep the reader's place and the button; at the bottom they are followed", { skip }, async () => {
  reset();
  await open("/#assistant", "#alog", 30);
  await scrollTo(A, 300); await waitShown(A, true);
  addAssistant(4);
  await page.evaluate("aload(true)");
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length === 34);
  await settle();
  let s = await state(A);
  assert.equal(s.top, 300, "not pulled down");
  assert.equal(s.shown, true, "still offered");
  // At the bottom: new messages are followed and the button stays hidden.
  await scrollTo(A, 1e6); await waitShown(A, false);
  addAssistant(2);
  await page.evaluate("aload(true)");
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length === 36);
  await settle();
  s = await state(A);
  assert.ok(s.gap <= 1, `followed to the newest (${s.gap})`);
  assert.equal(s.shown, false);
});

test("browser: clicking scrolls to the newest message and hides the button; Enter works and hands focus to the message box", { skip }, async () => {
  reset();
  await open("/#assistant", "#alog", 30);
  await scrollTo(A, 200); await waitShown(A, true);
  await page.click(A.button);
  await settle();
  let s = await state(A);
  assert.ok(s.gap <= 1, `at the newest message (${s.gap})`);
  assert.equal(s.shown, false);
  // Keyboard: the button is reached with Tab and shows a focus ring; Enter jumps.
  await scrollTo(A, 200); await waitShown(A, true);
  await page.focus("#ainput");
  // Backwards from the box: "+" (when enabled), then the button, which comes right before the composer in the tab order.
  for (let i = 0; i < 3 && (await page.evaluate(() => document.activeElement!.id)) !== "atolatest"; i++) await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement!.id), "atolatest");
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById("atolatest")!); return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }; });
  assert.equal(ring.style, "solid"); assert.ok(ring.width >= 2, "a visible focus ring");
  await page.keyboard.press("Enter");
  await settle();
  s = await state(A);
  assert.ok(s.gap <= 1 && !s.shown, "Enter jumps to the newest and hides it");
  assert.equal(await page.evaluate(() => document.activeElement!.id), "ainput", "focus goes to the message box, not the page");
});

test("browser: with motion allowed the jump is smooth and still ends at the bottom with the button hidden", { skip }, async () => {
  reset();
  await open("/#assistant", "#alog", 30, { reducedMotion: "no-preference" });
  await scrollTo(A, 0); await waitShown(A, true);
  await page.click(A.button);
  assert.equal((await state(A)).shown, false, "hidden at once, not flickering during the scroll");
  await page.waitForFunction(() => { const l = document.getElementById("alog")!; return l.scrollHeight - l.scrollTop - l.clientHeight <= 1; }, null, { timeout: 5000 });
  await settle();
  assert.equal((await state(A)).shown, false);
});

test("browser: a conversation that does not overflow never shows the button", { skip }, async () => {
  reset(2);
  await open("/#assistant", "#alog", 2);
  await scrollTo(A, 100); await settle();
  const s = await state(A);
  assert.equal(s.overflows, false);
  assert.equal(s.shown, false);
});

test("browser: composer growth and content resizing keep a reader at the bottom there; scrolled back, the button rides above the taller composer", { skip }, async () => {
  reset();
  await open("/#assistant", "#alog", 30);
  // At the bottom: the box grows to several lines; the conversation stays at its newest message.
  await page.fill("#ainput", "1\n2\n3\n4\n5");
  await settle();
  let s = await state(A);
  assert.ok(s.gap <= 1 && !s.shown, `still at the bottom after the composer grew (${s.gap})`);
  // A message's content grows after drawing (an image loading, a details opening): still at the bottom.
  await page.evaluate(() => { ([...document.querySelectorAll("#alog .msg")].at(-1) as HTMLElement).style.paddingBottom = "300px"; });
  await settle(); await settle();
  s = await state(A);
  assert.ok(s.gap <= 1 && !s.shown, `still at the bottom after content grew (${s.gap})`);
  // Scrolled back: the button shows, and when the composer grows it stays above it.
  await scrollTo(A, 200); await waitShown(A, true);
  await page.fill("#ainput", "1\n2\n3\n4\n5\n6\n7\n8");
  await settle();
  s = await state(A);
  const fTop = await page.evaluate(() => document.getElementById("aform")!.getBoundingClientRect().top);
  assert.equal(s.shown, true);
  assert.equal(s.top, 200, "the reader's place is kept");
  assert.ok(s.rect.bottom <= fTop - 4, "above the grown composer");
  // Scrolled back, content growing does not move the reader either.
  await page.evaluate(() => { ([...document.querySelectorAll("#alog .msg")].at(-1) as HTMLElement).style.paddingBottom = "600px"; });
  await settle(); await settle();
  assert.equal((await state(A)).top, 200);
});

// ---- Sessions -------------------------------------------------------------------------------------------------------------

test("browser (Sessions): the same control; a session switch goes to the newest message and hides it, a short session never shows it", { skip }, async () => {
  reset();
  await open(`/sessions/${T1}`, "#log", 30);
  let s = await state(S);
  assert.ok(s.gap <= 1 && !s.shown, "opens at the bottom, hidden");
  assert.equal((await state(A)).shown, false, "the hidden Assistant's button never shows on Sessions");
  await scrollTo(S, 100); await waitShown(S, true);
  assert.equal((await page.textContent(S.button)).trim(), "↓ click to latest");
  const fTop = await page.evaluate(() => document.getElementById("form")!.getBoundingClientRect().top);
  s = await state(S);
  assert.ok(s.rect.bottom <= fTop - 4 && fTop - s.rect.bottom < 40, "just above the Sessions composer");
  // New messages from another device: the reader stays, the button stays.
  addThread(T1, 2);
  await page.evaluate("pollThreads()");
  await page.waitForFunction(() => document.querySelectorAll("#log .msg").length === 32);
  await settle();
  s = await state(S);
  assert.ok(s.shown && s.top === 100, "not pulled down by a poll");
  // Switch to another long session: it opens at its newest message, button hidden.
  await page.evaluate(`openThread(${JSON.stringify(T2)})`);
  await page.waitForFunction((id: string) => document.querySelector("#log .msg")?.textContent?.includes("Message 0") && location.pathname.endsWith(id), T2);
  await settle();
  s = await state(S);
  assert.ok(s.gap <= 1 && !s.shown, `the switched-to session is at its bottom with no button (${s.gap})`);
  // Scroll back, then switch to a short session: nothing to jump to.
  await scrollTo(S, 0); await waitShown(S, true);
  await page.evaluate(`openThread(${JSON.stringify(T3)})`);
  await page.waitForFunction(() => document.querySelectorAll("#log .msg").length === 1);
  await settle();
  s = await state(S);
  assert.ok(!s.overflows && !s.shown, "a short session shows no button");
  // Back to a long one, scrolled back, click: newest message.
  await page.evaluate(`openThread(${JSON.stringify(T1)})`);
  await page.waitForFunction(() => document.querySelectorAll("#log .msg").length === 32);
  await scrollTo(S, 0); await waitShown(S, true);
  await page.click(S.button);
  await settle();
  s = await state(S);
  assert.ok(s.gap <= 1 && !s.shown);
});

test("browser: switching pages hides one conversation's button and restores it when that conversation shows again", { skip }, async () => {
  reset();
  await open("/#assistant", "#alog", 30);
  await scrollTo(A, 100); await waitShown(A, true);
  await page.click("#sessionstab");
  await page.waitForFunction(() => !document.getElementById("log")!.hidden);
  await waitShown(A, false);
  await page.click("#assistanttab");
  await page.waitForFunction(() => !document.getElementById("alog")!.hidden);
  await settle();
  const s = await state(A);
  assert.equal(s.shown, s.gap > 24, "shown again exactly when the Assistant is still scrolled back");
});

// ---- phone size, contrast -------------------------------------------------------------------------------------------------

test("browser (phone): a large enough tap target that works by tap, above the composer, with no sideways scrolling", { skip }, async () => {
  reset();
  await open("/#assistant", "#alog", 30, { viewport: { width: 390, height: 700 }, phone: true });
  await scrollTo(A, 100); await waitShown(A, true);
  const s = await state(A);
  assert.ok(s.rect.h >= 44, `at least 44px tall on a touch screen (${s.rect.h})`);
  assert.ok(s.rect.left >= 0 && s.rect.right <= 390, "fully on screen");
  const fTop = await page.evaluate(() => document.getElementById("aform")!.getBoundingClientRect().top);
  assert.ok(s.rect.bottom <= fTop - 4, "above the composer");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await page.tap(A.button);
  await settle();
  const after = await state(A);
  assert.ok(after.gap <= 1 && !after.shown);
  assert.notEqual(await page.evaluate(() => document.activeElement!.id), "ainput", "a tap does not open the on-screen keyboard");
});

test("browser: the label has readable contrast in light and dark", { skip }, async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    reset();
    await open("/#assistant", "#alog", 30, { colorScheme });
    await scrollTo(A, 100); await waitShown(A, true);
    const ratio = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById("atolatest")!);
      const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const lum = (c: string) => { const [r, g, b] = rgb(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
      const a = lum(cs.color), b = lum(cs.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(ratio >= 4.5, `${colorScheme}: contrast ${ratio.toFixed(2)} is at least 4.5:1`);
  }
});
