import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// The message list in a real browser (Playwright's Chromium), for the Assistant and for Chat, against a scripted fake of
// ORBIT's routes: one left-aligned list with no bubbles, every row with its sender's icon, name and stored time; the time
// labels in the configured zone (not the browser's) and current across midnight; the full date, time and zone on hover,
// keyboard focus and tap; the page's own unsaved rows never showing a time; Markdown, code, tables, photos and proposal cards
// kept; and no sideways scrolling on a phone-sized screen. The browser's own time zone is set to Tokyo on purpose, so a
// label computed in the browser's zone would fail. Skipped, saying so, when Playwright cannot be loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level message layout checks skipped";

const fileHtml = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const avatar = readFileSync(new URL("../src/web/avatar.png", import.meta.url));
let html = fileHtml;
const T1 = "11111111-1111-4111-8111-111111111111";
const PHOTO = `a${"0".repeat(31)}1`;
// The page's clock: Tuesday, November 17, 2026, 11:58:30 PM in Los Angeles (PST), already the 18th in Tokyo.
const NOW = "2026-11-18T07:58:30Z";
const AFTER_MIDNIGHT = "2026-11-18T08:01:00Z";
const REPLY = "Here is the plan.\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";

const messages = (p: string) => [
  { id: `${p}u1`, role: "user", at: "2026-11-18T05:00:00Z", text: "today question" },
  { id: `${p}a1`, role: "assistant", at: "2026-11-18T05:00:05Z", text: REPLY, status: "done", provenance: "live", source: "model/x" },
  { id: `${p}u2`, role: "user", at: "2026-11-17T06:30:00Z", text: "yesterday photo", attachments: [{ id: PHOTO, width: 800, height: 600, bytes: 40000 }] },
  { id: `${p}a2`, role: "assistant", at: "2026-11-03T20:15:00Z", text: "A proposal below.", status: "done", provenance: "live", source: "model/x", cards: [`${p}k1`] },
  { id: `${p}u3`, role: "user", at: "2025-12-31T23:00:00Z", text: "last year" },
  { id: `${p}a3`, role: "assistant", at: "", text: "", status: "error", error: "Archived chunk 3 could not be read." },
  { id: `${p}a4`, role: "assistant", at: "2026-11-18T07:58:00Z", text: "", status: "pending", calls: [] },
];
const LABELS = ["9:00 PM", "9:00 PM", "Yesterday at 10:30 PM", "Nov 3 at 12:15 PM", "Dec 31, 2025 at 3:00 PM", "Time unknown", "11:58 PM"];
const LABELS_AFTER = ["Yesterday at 9:00 PM", "Yesterday at 9:00 PM", "Nov 16 at 10:30 PM", "Nov 3 at 12:15 PM", "Dec 31, 2025 at 3:00 PM", "Time unknown", "Yesterday at 11:58 PM"];
const NAMES = ["Rai", "ORBIT", "Rai", "ORBIT", "Rai", "ORBIT", "ORBIT"];
const card = (p: string) => ({ id: `${p}k1`, kind: "job_launch", routine: "orbit", brief: "Do the thing.", state: "open", digest: "d".repeat(64), duplicates: [] });

let thread: Record<string, any>;
let assistant: Record<string, any>;
let holdSend: Promise<void> | null = null;
let chatSendAnswer: () => { code: number; body: unknown } = () => ({ code: 200, body: { thread } });
const reset = () => {
  html = fileHtml;
  thread = { id: T1, title: "Alpha", rev: 1, busy: true, archived: false, cards: [card("c")], messages: messages("c") };
  assistant = {
    session: { schema: 1, id: "assistant", createdAt: "2026-11-01T00:00:00Z" }, title: "Assistant", persisted: true, problems: [], busy: true, rev: 1, archivedChunks: 0,
    chunks: [{ seq: 1, id: "c1", createdAt: "2026-11-01T00:00:00Z", state: "open", cards: [card("a")], messages: messages("a") }],
    next: { included: [{ seq: 1, form: "full", chars: 10 }], omitted: [], historyChars: 10 },
    budgets: { unit: "characters", activeChars: 32000, chunkMaxChars: 12000, contextChars: 52000, notesMaxChars: 12000 },
  };
  holdSend = null;
  chatSendAnswer = () => ({ code: 200, body: { thread } });
};
reset();

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const read = () => new Promise<any>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
  // The page itself, also at session addresses (/sessions/<id>), so a reload draws it whichever address form the page uses.
  if (url.pathname === "/" || url.pathname === "/sessions" || url.pathname.startsWith("/sessions/")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (url.pathname === "/avatar.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(avatar); }
  if (url.pathname === "/status") return json(200, { ports: [{ port: "model", state: "live" }] });
  if (url.pathname === "/notifications") return json(200, { inbox: [] });
  if (url.pathname === "/model/login") return json(403, { error: "no" });
  if (url.pathname === "/chat/proposals") return json(200, { proposals: [] });
  if (url.pathname === "/jobs") return json(200, { jobs: [] });
  if (url.pathname === "/threads") return json(200, { threads: [{ id: T1, title: "Alpha", archived: false, rev: thread.rev, busy: thread.busy, openCards: 1, messageCount: thread.messages.length }], notice: null });
  if (url.pathname === `/threads/${T1}`) return json(200, { thread });
  if (url.pathname === `/threads/${T1}/messages` && req.method === "POST") {
    await read();
    if (holdSend) await holdSend;
    const a = chatSendAnswer();
    return json(a.code, a.body);
  }
  if (url.pathname === "/assistant") return json(200, { assistant });
  if (url.pathname === "/assistant/messages" && req.method === "POST") {
    await read();
    if (holdSend) await holdSend;
    return json(200, { assistant });
  }
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

async function open(hash: string, viewport = { width: 1000, height: 900 }, at = NOW, count = 7) {
  await context?.close();
  context = await browser.newContext({ viewport, timezoneId: "Asia/Tokyo", locale: "en-US" });
  page = await context.newPage();
  await page.clock.setFixedTime(new Date(at));
  await page.goto(`${base}${hash}`);
  const sel = hash.startsWith("#chat") ? "#log" : "#alog";
  await page.waitForFunction(([s, n]: [string, number]) => document.querySelectorAll(`${s} .msg`).length === n, [sel, count]);
  return sel;
}
const rows = (sel: string) => page.$$eval(`${sel} .msg`, (ns: Element[]) => ns.map((n) => {
  const t = n.querySelector(".mhead time");
  const b = n.querySelector(".mhead .mtime") as HTMLButtonElement;
  return {
    first: (n.firstElementChild as HTMLElement).className,
    name: n.querySelector(".mhead .mname")!.textContent,
    label: (b.firstElementChild as HTMLElement).textContent,
    datetime: t ? t.getAttribute("datetime") : null,
    aria: b.getAttribute("aria-label"),
  };
}));
// Moves the time from the frozen "now" to another instant and lets the page see it (the 30-second tick, or a return to the tab).
async function setNow(iso: string) {
  await page.clock.setFixedTime(new Date(iso));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

for (const surface of ["assistant", "chat"] as const) {
  const hash = surface === "chat" ? `#chat/${T1}` : "#assistant";

  test(`browser (${surface}): every row has the sender's icon, name and stored time, in the configured zone, and the labels roll over at midnight`, { skip }, async () => {
    reset();
    const sel = await open(hash);
    const r = await rows(sel);
    assert.deepEqual(r.map((x: any) => x.first), Array(7).fill("mavatar"), "the icon comes first in every row");
    assert.deepEqual(r.map((x: any) => x.name), NAMES);
    assert.deepEqual(r.map((x: any) => x.label), LABELS, "Los Angeles calendar days, although the browser is in Tokyo");
    assert.deepEqual(r.map((x: any) => x.datetime), ["2026-11-18T05:00:00.000Z", "2026-11-18T05:00:05.000Z", "2026-11-17T06:30:00.000Z", "2026-11-03T20:15:00.000Z", "2025-12-31T23:00:00.000Z", null, "2026-11-18T07:58:00.000Z"]);
    assert.equal(r[0].aria, "9:00 PM. Sent Tuesday, November 17, 2026 at 9:00:00 PM PST (America/Los_Angeles)");
    assert.equal(r[1].aria, "9:00 PM. Reply started Tuesday, November 17, 2026 at 9:00:05 PM PST (America/Los_Angeles)");
    assert.equal(r[5].aria, "Time unknown. No valid time was recorded for this message.");
    assert.equal(await page.getByRole("button", { name: /Sent Wednesday, December 31, 2025 at 3:00:00 PM PST/ }).count(), 1, "the full time is in the accessible name");
    // Midnight in Los Angeles: today's times become yesterday's, yesterday's become dates. The stored instants do not change.
    await setNow(AFTER_MIDNIGHT);
    const after = await rows(sel);
    assert.deepEqual(after.map((x: any) => x.label), LABELS_AFTER);
    assert.deepEqual(after.map((x: any) => x.datetime), r.map((x: any) => x.datetime));
    // A reload draws the same stored times again (nothing comes from the moment of drawing).
    await page.reload();
    await page.waitForFunction((s: string) => document.querySelectorAll(`${s} .msg`).length === 7, sel);
    assert.deepEqual((await rows(sel)).map((x: any) => x.label), LABELS_AFTER);
  });

  test(`browser (${surface}): one left-aligned list, no bubbles, one content column; Markdown, code, tables, photos, cards and the pending reply are kept`, { skip }, async () => {
    reset();
    const sel = await open(hash);
    await page.mouse.move(0, 0);
    const geo = await page.$$eval(`${sel} .msg`, (ns: Element[]) => ns.map((n) => {
      const cs = getComputedStyle(n);
      const head = n.querySelector(".mhead")!.getBoundingClientRect();
      const last = (n.lastElementChild as HTMLElement).getBoundingClientRect();
      return { left: Math.round(n.getBoundingClientRect().left), content: Math.round(head.left), lastLeft: Math.round(last.left), bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, name: getComputedStyle(n.querySelector(".mname")!).color, cls: n.className };
    }));
    assert.equal(new Set(geo.map((g: any) => g.left)).size, 1, "Rai's and ORBIT's rows start at the same left edge");
    assert.equal(new Set(geo.map((g: any) => g.content)).size, 1, "every row's content column starts at the same place");
    assert.ok(geo.every((g: any) => g.lastLeft === g.content), "every content part sits in that column");
    assert.ok(geo.every((g: any) => g.bg === "rgba(0, 0, 0, 0)" && g.radius === "0px" && g.border === "0px"), "no bubble background, border or rounding");
    const userColor = geo.find((g: any) => /user/.test(g.cls)).name, orbitColor = geo.find((g: any) => /orbit/.test(g.cls)).name;
    assert.notEqual(userColor, orbitColor, "the senders' names keep their colors");
    assert.equal(await page.$eval(`${sel} .msg.user .mavatar`, (e: Element) => e.tagName + e.textContent), "SPANR", "Rai: an initial");
    assert.equal(await page.$eval(`${sel} .msg.orbit .mavatar`, (e: Element) => e.tagName + (e as HTMLImageElement).getAttribute("src")), "IMG/avatar.png", "ORBIT: its own local avatar");
    // The content features are all still there.
    assert.equal(await page.$eval(`${sel} .msg.orbit .md pre code`, (e: Element) => e.textContent), "const x = 1;");
    assert.equal(await page.$$eval(`${sel} .msg.orbit .md table td`, (es: Element[]) => es.map((e) => e.textContent).join(",")), "1,2");
    assert.equal(await page.$$eval(`${sel} .msg.user .photos img`, (es: Element[]) => es.length), 1);
    assert.deepEqual(await page.$$eval(`${sel} .proposal button`, (es: Element[]) => es.map((e) => e.textContent)), ["Confirm", "Cancel"]);
    const pending = await page.$eval(`${sel} .msg:last-child`, (n: Element) => [...n.children].filter((c) => !c.matches(".mavatar, .mhead")).map((c) => c.textContent).join(""));
    assert.equal(pending, "Working…");
  });

  test(`browser (${surface}): the full time shows on hover, on keyboard focus and on a tap, and closes again`, { skip }, async () => {
    reset();
    const sel = await open(hash);
    const time = page.locator(`${sel} .msg .mtime`).first();
    const tip = page.locator(`${sel} .msg .mtip`).first();
    assert.equal(await tip.isVisible(), false, "closed at first");
    await time.focus();
    assert.equal(await time.evaluate((b: Element) => b.matches(":focus-visible")), true);
    assert.equal(await tip.isVisible(), true, "keyboard focus shows it");
    assert.equal(await tip.textContent(), "Sent Tuesday, November 17, 2026 at 9:00:00 PM PST (America/Los_Angeles)");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    assert.equal(await tip.isVisible(), false);
    await time.hover();
    assert.equal(await tip.isVisible(), true, "hover shows it");
    await page.mouse.move(0, 0);
    assert.equal(await tip.isVisible(), false);
    await time.click();
    assert.equal(await time.getAttribute("aria-expanded"), "true", "a tap opens it");
    await page.mouse.move(0, 0);
    assert.equal(await tip.isVisible(), true, "and it stays open without hover");
    await page.click(sel === "#alog" ? "#ainput" : "#input");
    assert.equal(await time.getAttribute("aria-expanded"), "false", "a tap elsewhere closes it");
    await time.click();
    await page.keyboard.press("Escape");
    assert.equal(await time.getAttribute("aria-expanded"), "false", "Escape closes it");
  });

  test(`browser (${surface}): on a wide screen every row uses the log's full width, and the header's shadow shades the content scrolling under it`, { skip }, async () => {
    reset();
    const sel = await open(hash, { width: 1600, height: 700 });
    const w = await page.$eval(sel, (log: HTMLElement) => {
      const cs = getComputedStyle(log);
      return {
        inner: log.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), pad: parseFloat(cs.paddingLeft),
        page: document.documentElement.clientWidth, rows: [...log.querySelectorAll(".msg")].map((m) => m.getBoundingClientRect().width),
        cards: [...log.querySelectorAll(".proposal")].map((c) => c.getBoundingClientRect().width),
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.equal(w.pad, 16, "the log keeps its edge padding");
    assert.ok(w.inner >= w.page - 2 * 16 - 20, `the log spans the page (${w.inner} of ${w.page})`);
    assert.ok(w.rows.every((x: number) => Math.abs(x - w.inner) <= 1), `every row is as wide as the log (${w.inner}): ${w.rows}`);
    assert.ok(w.cards.length > 0 && w.cards.every((x: number) => x > w.inner * 0.9), `proposal cards fill their row too: ${w.cards}`);
    assert.equal(w.sideways, false, "nothing scrolls sideways");
    // An opaque, positioned block at the very top of the log, positioned the way message rows are (relative, z-index auto),
    // so it is painted after the header unless the header stacks above it. The header's shadow must still shade it.
    await page.$eval(sel, (log: HTMLElement) => {
      const b = document.createElement("div");
      b.style.cssText = `position: relative; flex: none; height: 80px; margin-top: -${getComputedStyle(log).paddingTop}; background: #ffffff;`;
      log.prepend(b);
      log.scrollTop = 0;
    });
    const hb = await page.$eval("header", (h: Element) => h.getBoundingClientRect().bottom);
    const png: Buffer = await page.screenshot({ clip: { x: 800, y: Math.ceil(hb), width: 1, height: 40 } });
    const probe = await context.newPage();
    const px: number[] = await probe.evaluate(async (b64: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return Array.from({ length: img.naturalHeight }, (_, y) => { const d = g.getImageData(0, y, 1, 1).data; return 765 - (d[0]! + d[1]! + d[2]!); });
    }, png.toString("base64"));
    await probe.close();
    // px[y]: how much darker than white, y pixels below the header's bottom edge.
    assert.equal(px[px.length - 1], 0, `well below the header the block is plain white (${px})`);
    assert.ok(px[1]! >= 40, `just under the header the shadow visibly darkens the content (${px})`);
    assert.ok(px[6]! > 0, `and it reaches several pixels down (${px})`);
  });

  test(`browser (${surface}): on a phone-sized screen nothing scrolls sideways, even with the full time open`, { skip }, async () => {
    reset();
    const sel = await open(hash, { width: 360, height: 740 });
    const time = page.locator(`${sel} .msg .mtime`).nth(4);
    await time.click();
    const m = await page.evaluate((s: string) => {
      const log = document.querySelector(s)!;
      const rights = [...document.querySelectorAll(`${s} .msg, ${s} .mtip`)].filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getBoundingClientRect().right);
      return { page: document.documentElement.scrollWidth, view: window.innerWidth, log: log.scrollWidth, logView: log.clientWidth, right: Math.max(...rights) };
    }, sel);
    assert.ok(m.page <= m.view, `the page does not scroll sideways (${m.page} > ${m.view})`);
    assert.ok(m.log <= m.logView, `the list does not scroll sideways (${m.log} > ${m.logView})`);
    assert.ok(m.right <= m.view, `no row or open time runs past the screen (${m.right} > ${m.view})`);
    assert.equal(await page.locator(`${sel} .msg .mtip`).nth(4).isVisible(), true);
  });
}

test("browser (assistant): a send shows Sending… and Waiting… rows with no time until ORBIT stores them, then their stored times", { skip }, async () => {
  reset();
  assistant.busy = false;
  assistant.chunks[0].messages = assistant.chunks[0].messages.slice(0, 5);
  let release!: () => void;
  holdSend = new Promise<void>((r) => (release = r));
  await open("#assistant", undefined, NOW, 5);
  await page.fill("#ainput", "new question");
  await page.press("#ainput", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length === 7);
  const local = await rows("#alog");
  assert.deepEqual(local.slice(5).map((x: any) => [x.name, x.label, x.datetime]), [["Rai", "Sending…", null], ["ORBIT", "Waiting…", null]], "no time before ORBIT has stored the message");
  // ORBIT stores both; the reply finished 40 seconds later, but keeps the time it started at.
  assistant.rev = 2;
  assistant.chunks.push({ seq: 2, id: "c2", createdAt: "2026-11-18T07:58:31Z", state: "complete", cards: [], messages: [
    { id: "n1", role: "user", at: "2026-11-18T07:58:31Z", text: "new question" },
    { id: "n2", role: "assistant", at: "2026-11-18T07:58:32Z", text: "An answer.", status: "done", provenance: "live", source: "model/x" },
  ] });
  assistant.next.included.push({ seq: 2, form: "full", chars: 10 });
  await page.clock.setFixedTime(new Date("2026-11-18T07:59:12Z"));
  release();
  await page.waitForFunction(() => /An answer\./.test(document.getElementById("alog")!.textContent!));
  const stored = await rows("#alog");
  assert.equal(stored.length, 7, "the optimistic rows are replaced, not duplicated");
  assert.deepEqual(stored.slice(5).map((x: any) => [x.name, x.label, x.datetime]), [["Rai", "11:58 PM", "2026-11-18T07:58:31.000Z"], ["ORBIT", "11:58 PM", "2026-11-18T07:58:32.000Z"]]);
});

test("browser (chat): an error ORBIT did not store is marked Not saved, never given a time", { skip }, async () => {
  reset();
  thread.busy = false;
  thread.messages = thread.messages.slice(0, 5);
  chatSendAnswer = () => ({ code: 502, body: { error: "The model did not answer.", thread } });
  await open(`#chat/${T1}`, undefined, NOW, 5);
  await page.fill("#input", "hello");
  await page.press("#input", "Enter");
  await page.waitForFunction(() => /The model did not answer\./.test(document.getElementById("log")!.textContent!));
  const last = (await rows("#log")).at(-1);
  assert.deepEqual([last.name, last.label, last.datetime], ["ORBIT", "Not saved", null]);
  assert.match(last.aria, /not stored on ORBIT's server, so it has no recorded time/);
});

test("browser: without a usable configured zone the page uses the browser's own and names it; it never pretends", { skip }, async () => {
  reset();
  html = fileHtml.replace(/<meta name="orbit-time-zone" content="[^"]*">/, '<meta name="orbit-time-zone" content="Not/AZone">');
  const sel = await open("#assistant");
  const r = await rows(sel);
  // In Tokyo, NOW is Wednesday, November 18, 4:58 PM: 05:00 UTC on the 18th is 2:00 PM today there.
  assert.equal(r[0].label, "2:00 PM");
  assert.equal(r[0].aria, "2:00 PM. Sent Wednesday, November 18, 2026 at 2:00:00 PM GMT+9 (Asia/Tokyo)");
});

test("the page keeps message times current on a 30-second tick and when it becomes visible again", () => {
  assert.match(fileHtml, /setInterval\(tickTimes, 30000\)/);
  assert.match(fileHtml, /addEventListener\("visibilitychange", \(\) => \{ if \(document\.visibilityState === "visible"\) tickTimes\(\); \}\)/);
});
