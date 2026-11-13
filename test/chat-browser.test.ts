import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// The chat page in a real browser (Playwright's Chromium), against a scripted fake of ORBIT's thread routes. It checks
// what the fake-DOM tests cannot: that a text selection, keyboard focus and scroll positions really survive polls,
// appends, a reply in progress and card transitions, and that thread switches and late answers draw the right thread.
// Playwright is not a dependency of this repository: when it cannot be loaded (as in CI today) these tests are skipped
// and say so, and chat-reconcile.test.ts still runs.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level selection checks skipped";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

type Msg = Record<string, unknown> & { id: string };
type Thread = { id: string; title: string; rev: number; busy: boolean; archived: boolean; messages: Msg[]; cards: Record<string, unknown>[] };
const long = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of an older answer that the reader is studying carefully.`).join("\n\n");
const fresh = (): Record<string, Thread> => ({
  [T1]: {
    id: T1, title: "Alpha", rev: 1, busy: false, archived: false, cards: [],
    messages: [
      { id: "a1", role: "user", at: "t", text: "first question" },
      { id: "a2", role: "assistant", at: "t", text: `Here is the **older answer** with a SELECTME phrase.\n\n${long(30)}`, status: "done", provenance: "live", source: "model/x" },
      { id: "a3", role: "user", at: "t", text: "second question" },
      { id: "a4", role: "assistant", at: "t", text: long(20), status: "done", provenance: "live", source: "model/x" },
    ],
  },
  [T2]: { id: T2, title: "Beta", rev: 1, busy: false, archived: false, cards: [], messages: [{ id: "b1", role: "user", at: "t", text: "beta only message" }] },
});
let threads = fresh();
let delayFor: Record<string, number> = {};
let staleNext: Thread | null = null;
let confirms = 0;
let confirmAnswer: { status: number; body: unknown } = { status: 200, body: { id: "orbit-job-1" } };
// Per-thread load failures for GET /threads/:id: an HTTP status, or "network" to drop the connection.
let failFor: Record<string, number | "network"> = {};
// Where POST /threads/:id/messages actually went, in order.
let sentTo: string[] = [];
let createDelay = 0, archiveDelay = 0, created = 0;
// POST /threads/:id/rename: delay before answering, and an optional failure (HTTP status or "network").
let renameDelay = 0;
let renameFail: number | "network" | 0 = 0;
// POST /threads/:id/messages: an optional failure after the delay (the turn is not run).
let sendFail: number | "network" | 0 = 0, sendDelay = 0;
// Every request the page made, in order ("METHOD path"), to assert what went out.
let requests: string[] = [];
// Requests the fake has not finished answering. Chromium retries a POST once when a reused connection is dropped, so a
// "network" failure can take two delays; tests wait for the server to go quiet instead of guessing a time.
let inflight = 0;
async function quiet(ms = 50) {
  for (let i = 0; i < 300 && inflight > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(inflight, 0, "the fake server went quiet");
  await page.waitForFunction("!sending");
  await page.waitForTimeout(ms);
}

const meta = (t: Thread) => ({ id: t.id, title: t.title, archived: t.archived, rev: t.rev, busy: t.busy, openCards: t.cards.filter((c) => c.state === "open").length, messageCount: t.messages.length });
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname.startsWith("/threads")) requests.push(`${req.method} ${url.pathname}`);
  inflight++; res.on("close", () => inflight--);
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (url.pathname === "/status") return json(200, { ports: [] });
  if (url.pathname === "/notifications") return json(200, { inbox: [] });
  if (url.pathname === "/model/login" || url.pathname === "/chat/proposals") return json(403, { error: "no" });
  if (url.pathname === "/threads" && req.method === "POST") {
    const id = `33333333-3333-4333-8333-${String(++created).padStart(12, "0")}`;
    threads[id] = { id, title: `New ${created}`, rev: 1, busy: false, archived: false, cards: [], messages: [] };
    const snapshot = structuredClone(threads[id]);
    if (createDelay) await new Promise((r) => setTimeout(r, createDelay));
    return json(200, { thread: snapshot });
  }
  if (url.pathname === "/threads") return json(200, { threads: Object.values(threads).map(meta), notice: null });
  const m = url.pathname.match(/^\/threads\/([0-9a-f-]{36})$/);
  if (m) {
    const t = threads[m[1]!];
    if (!t) return json(404, { error: "No thread with that id." });
    const snapshot = structuredClone(staleNext && staleNext.id === t.id ? staleNext : t);
    staleNext = null;
    const wait = delayFor[t.id] ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const fail = failFor[t.id];
    if (fail === "network") return req.socket.destroy();
    if (fail) return json(fail, { error: "upstream broke" });
    return json(200, { thread: snapshot });
  }
  const a = url.pathname.match(/^\/threads\/([0-9a-f-]{36})\/archive$/);
  if (a && threads[a[1]!]) {
    const t = threads[a[1]!]!;
    const body = JSON.parse(await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }) || "{}");
    if (archiveDelay) await new Promise((r) => setTimeout(r, archiveDelay));
    t.archived = body.archived !== false; t.rev++;
    return json(200, { thread: structuredClone(t) });
  }
  const rn = url.pathname.match(/^\/threads\/([0-9a-f-]{36})\/rename$/);
  if (rn && threads[rn[1]!]) {
    const t = threads[rn[1]!]!;
    const body = JSON.parse(await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }) || "{}");
    const fail = renameFail;
    // The rename lands on the server at once (as the real store does); only the answer is late.
    if (!fail) { t.title = body.title; t.rev++; }
    const snapshot = structuredClone(t);
    if (renameDelay) await new Promise((r) => setTimeout(r, renameDelay));
    if (fail === "network") return req.socket.destroy();
    if (fail) return json(fail, { error: "rename broke" });
    return json(200, { thread: snapshot });
  }
  const s = url.pathname.match(/^\/threads\/([0-9a-f-]{36})\/messages$/);
  if (s && threads[s[1]!]) {
    const t = threads[s[1]!]!;
    const body = JSON.parse(await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }) || "{}");
    if (sendDelay) await new Promise((r) => setTimeout(r, sendDelay));
    if (sendFail === "network") { sentTo.push(t.id); return req.socket.destroy(); }
    if (sendFail) { sentTo.push(t.id); return json(sendFail, { error: "model broke" }); }
    sentTo.push(t.id);
    t.messages.push({ id: `u${t.messages.length}`, role: "user", at: "t", text: body.text }, { id: `r${t.messages.length}`, role: "assistant", at: "t", text: `reply to ${body.text}`, status: "done", provenance: "live", source: "model/x" });
    t.rev++;
    return json(200, { thread: structuredClone(t) });
  }
  const c = url.pathname.match(/^\/chat\/proposals\/([\w-]+)\/confirm$/);
  if (c) { confirms++; return json(confirmAnswer.status, confirmAnswer.body); }
  json(404, { error: "not found" });
});

let browser: any, page: any, base = "";
before(async () => {
  if (skip) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); server.close(); });

async function open() {
  threads = fresh(); delayFor = {}; staleNext = null; confirms = 0; failFor = {}; sentTo = []; createDelay = 0; archiveDelay = 0; created = 0;
  renameDelay = 0; renameFail = 0; sendFail = 0; sendDelay = 0; requests = [];
  confirmAnswer = { status: 200, body: { id: "orbit-job-1" } };
  page?.close();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.addInitScript(`localStorage.setItem("orbit.thread", ${JSON.stringify(T1)})`);
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll("#log .msg").length === 4);
  await page.evaluate(() => { (window as any).__notReloaded = true; });
}
const poll = () => page.evaluate("pollThreads()");
const bump = (id: string, change: (t: Thread) => void) => { const t = threads[id]!; change(t); t.rev++; };
// Selects the SELECTME word inside the older answer and tags the nodes involved, so identity can be checked later.
async function selectOlder() {
  await page.evaluate(() => {
    const p = [...document.querySelectorAll("#log .msg .md p")].find((x) => x.textContent!.includes("SELECTME"))!;
    const text = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent!.includes("SELECTME"))!;
    const start = text.textContent!.indexOf("SELECTME");
    const r = document.createRange();
    r.setStart(text, start); r.setEnd(text, start + 8);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
    Object.assign(window as any, { __text: text, __msg: p.closest(".msg"), __first: document.querySelector("#log .msg") });
  });
}
const selectionIntact = () => page.evaluate(() => {
  const w = window as any, s = getSelection()!;
  return { text: s.toString(), sameNode: s.rangeCount > 0 && s.getRangeAt(0).startContainer === w.__text, connected: w.__text.isConnected && w.__msg.isConnected, first: document.querySelector("#log .msg") === w.__first, notReloaded: w.__notReloaded === true };
});
const scroll = () => page.evaluate(() => { const l = document.getElementById("log")!; return { top: l.scrollTop, max: l.scrollHeight - l.clientHeight }; });

test("browser: a selection in an older message survives unchanged polls, an append and a reply in progress, and the reading position holds", { skip }, async () => {
  await open();
  await page.evaluate(() => { const l = document.getElementById("log")!; l.scrollTop = 200; });
  await selectOlder();
  const top = (await scroll()).top;
  // A confirmed card makes every poll fetch the thread again (its live state can change): that used to redraw everything.
  bump(T1, (t) => { t.cards.push({ id: "k1", kind: "job_launch", routine: "orbit", state: "confirmed", brief: "b", outcome: { jobId: "j1" }, live: { source: "jobs", found: true, state: "running" } }); (t.messages[3]!.cards = ["k1"]); });
  await poll();
  for (let i = 0; i < 3; i++) await poll();
  assert.deepEqual(await selectionIntact(), { text: "SELECTME", sameNode: true, connected: true, first: true, notReloaded: true });
  // Append a user message and a reply in progress, then grow it with a tool call and finish it.
  bump(T1, (t) => { t.busy = true; t.messages.push({ id: "a5", role: "user", at: "t", text: "third question" }, { id: "a6", role: "assistant", at: "t", text: "", status: "pending", calls: [] }); });
  await poll();
  const pendingNode = await page.evaluateHandle(() => [...document.querySelectorAll("#log .msg")].at(-1));
  assert.equal(await pendingNode.evaluate((n: Element) => n.textContent), "Working…");
  bump(T1, (t) => { (t.messages[5]!.calls as unknown[]).push({ name: "jobs_list", arguments: "{}", ok: true, provenance: "live", source: "jobs", summary: "1 job" }); });
  await poll();
  bump(T1, (t) => { t.busy = false; Object.assign(t.messages[5]!, { status: "done", text: "Done **now**.", provenance: "live", source: "model/x" }); });
  await poll();
  assert.equal(await pendingNode.evaluate((n: Element) => n.isConnected && n === [...document.querySelectorAll("#log .msg")].at(-1)), true, "the reply keeps its node from pending to persisted");
  assert.match(await pendingNode.evaluate((n: Element) => n.textContent), /Done now\.live · model\/x/);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#log .msg").length), 6, "no duplicate messages");
  assert.deepEqual(await selectionIntact(), { text: "SELECTME", sameNode: true, connected: true, first: true, notReloaded: true });
  assert.equal((await scroll()).top, top, "the reader, scrolled up, is not pulled to the bottom");
});

test("browser: near the bottom, new messages are followed; with text selected, they are not", { skip }, async () => {
  await open();
  await page.evaluate(() => { const l = document.getElementById("log")!; l.scrollTop = l.scrollHeight; });
  bump(T1, (t) => t.messages.push({ id: "n1", role: "user", at: "t", text: long(10) }));
  await poll();
  let s = await scroll();
  assert.ok(s.max - s.top < 2, `followed to the bottom (${s.top} of ${s.max})`);
  await page.evaluate(() => {
    const last = [...document.querySelectorAll("#log .msg")].at(-1)!;
    const r = document.createRange(); r.selectNodeContents(last.querySelector(".body")!); getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
  });
  const before = (await scroll()).top;
  bump(T1, (t) => t.messages.push({ id: "n2", role: "user", at: "t", text: long(10) }));
  await poll();
  s = await scroll();
  assert.equal(s.top, before, "a reader selecting text at the bottom is not scrolled away from it");
  assert.ok(s.max > s.top);
});

test("browser: an open card keeps its inner scroll and keyboard focus across polls; confirm, error and expiry show without stale buttons", { skip }, async () => {
  await open();
  bump(T1, (t) => {
    t.cards.push({ id: "p1", kind: "job_launch", routine: "orbit", state: "open", brief: long(40), createdAt: "t", expiresAt: "t" }, { id: "p2", kind: "job_launch", routine: "orbit", state: "open", brief: "short", createdAt: "t", expiresAt: "t" });
    t.messages.push({ id: "c1", role: "assistant", at: "t", text: "Two proposals.", status: "done", provenance: "live", source: "s", cards: ["p1", "p2"] });
  });
  await poll();
  await page.evaluate(() => { const pre = document.querySelector("#log .proposal pre") as HTMLElement; pre.scrollTop = 150; (document.querySelectorAll("#log .proposal button")[0] as HTMLElement).focus(); });
  bump(T1, (t) => t.messages.push({ id: "c2", role: "user", at: "t", text: "unrelated" }));
  for (let i = 0; i < 3; i++) await poll();
  assert.deepEqual(await page.evaluate(() => ({ scroll: (document.querySelector("#log .proposal pre") as HTMLElement).scrollTop, focus: document.activeElement?.textContent, inCard: Boolean(document.activeElement?.closest(".proposal")) })), { scroll: 150, focus: "Confirm", inCard: true });
  // Confirm by keyboard: one request, the answer replaces the buttons and takes focus; the reload shows the confirmed card.
  bump(T1, (t) => { Object.assign(t.cards[0]!, { state: "confirmed", outcome: { jobId: "orbit-job-1" }, live: { source: "jobs", found: true, state: "launched" } }); });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /Record now \(jobs\): launched/.test(document.getElementById("log")!.textContent!));
  assert.equal(confirms, 1, "one click, one request: no duplicate handlers");
  const state = await page.evaluate(() => ({ confirmButtons: [...document.querySelectorAll("#log button")].filter((b) => b.textContent === "Confirm").length, cards: document.querySelectorAll("#log .cardwrap").length, focusInLog: document.getElementById("log")!.contains(document.activeElement) }));
  assert.deepEqual(state, { confirmButtons: 1, cards: 2, focusInLog: true }, "only the still-open card has a Confirm button; focus stays in the thread");
  // A failed confirmation says so; then the other device expires the card and the button goes away.
  confirmAnswer = { status: 409, body: { error: "routine refused" } };
  await page.evaluate(() => ([...document.querySelectorAll("#log button")].find((b) => b.textContent === "Confirm") as HTMLElement).click());
  await page.waitForFunction(() => /Launch failed: routine refused/.test(document.getElementById("log")!.textContent!));
  bump(T1, (t) => { t.cards[1]!.state = "expired"; });
  await poll();
  assert.deepEqual(await page.evaluate(() => ({ confirm: [...document.querySelectorAll("#log button")].filter((b) => b.textContent === "Confirm").length, expired: /Expired: nothing was done/.test(document.getElementById("log")!.textContent!) })), { confirm: 0, expired: true });
  // The live state of the confirmed card changes with no new revision: shown, in that card only.
  const firstMsg = await page.evaluateHandle(() => document.querySelector("#log .msg"));
  threads[T1]!.cards[0]!.live = { source: "jobs", found: true, state: "done/ok" };
  await poll();
  assert.match(await page.evaluate(() => document.getElementById("log")!.textContent), /Record now \(jobs\): done\/ok/);
  assert.equal(await firstMsg.evaluate((n: Element) => n.isConnected), true);
});

test("browser: thread switches, late answers and old revisions never mix threads; reloading restores the history", { skip }, async () => {
  await open();
  const texts = () => page.evaluate(() => [...document.querySelectorAll("#log .msg")].map((n) => n.textContent!.slice(0, 20)));
  // A slow poll answer for Alpha arrives after the reader switched to Beta: it is dropped.
  delayFor[T1] = 400;
  bump(T1, (t) => t.messages.push({ id: "late", role: "user", at: "t", text: "late alpha message" }));
  const slow = poll();
  await page.waitForTimeout(50);
  await page.selectOption("#threadsel", T2);
  await page.waitForFunction(() => /beta only/.test(document.getElementById("log")!.textContent!));
  await slow;
  await page.waitForTimeout(450);
  assert.deepEqual(await texts(), ["beta only message"]);
  // Back to Alpha: drawn fresh, with the message that arrived meanwhile.
  delayFor = {};
  await page.selectOption("#threadsel", T1);
  await page.waitForFunction(() => /late alpha message/.test(document.getElementById("log")!.textContent!));
  assert.equal((await texts()).length, 5);
  // An answer carrying an older revision (a delayed duplicate) does not roll the view back.
  staleNext = { ...structuredClone(threads[T1]!), rev: 1, messages: threads[T1]!.messages.slice(0, 2) };
  bump(T1, () => {});
  await poll();
  assert.equal((await texts()).length, 5);
  // A real reload restores the selected thread and its history from the server.
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#log .msg").length === 5);
  assert.equal(await page.evaluate(() => (document.getElementById("threadsel") as HTMLSelectElement).value), T1);
});

// ---- Explicit navigation wins over background polls (review of #74). The menu, the log, the stored selection and the
// thread a message is actually sent to must agree once a navigation settles, and nothing is sent while one is pending.
const bar = () => page.evaluate(() => ({
  menu: (document.getElementById("threadsel") as HTMLSelectElement).value,
  log: [...document.querySelectorAll("#log .msg")].map((n) => n.textContent!.slice(0, 20)),
  stored: localStorage.getItem("orbit.thread"),
  status: document.getElementById("tstatus")?.textContent ?? "",
}));
const settle = (ms = 0) => page.waitForFunction(() => !(window as any).navPending?.(), null, { timeout: 3000 }).then(() => page.waitForTimeout(ms));
const ALPHA = ["first question", "Here is the older an", "second question", "Line 1 of an older a"];
async function sendNow(text: string) {
  await page.fill("#input", text);
  await page.press("#input", "Enter");
}

test("browser: switching to a slow thread, then an old-thread poll starting after the switch: the switch still wins", { skip }, async () => {
  await open();
  delayFor[T2] = 400;
  bump(T1, (t) => t.messages.push({ id: "late", role: "user", at: "t", text: "late alpha message" }));
  await page.selectOption("#threadsel", T2);
  await page.waitForTimeout(30);
  await poll();
  await settle(450);
  assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
  await sendNow("to beta");
  await page.waitForFunction(() => /reply to to beta/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [T2]);
});

test("browser: reverse ordering, an old-thread poll in flight when the switch starts, is dropped", { skip }, async () => {
  await open();
  delayFor[T1] = 300; delayFor[T2] = 100;
  bump(T1, (t) => t.messages.push({ id: "late", role: "user", at: "t", text: "late alpha message" }));
  const slow = poll();
  await page.waitForTimeout(30);
  await page.selectOption("#threadsel", T2);
  await slow;
  await settle(350);
  assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
});

test("browser: rapid A-B-A ends on A even when B answers last; A-B-C-B ends on B", { skip }, async () => {
  await open();
  delayFor[T2] = 300;
  await page.selectOption("#threadsel", T2);
  await page.waitForTimeout(30);
  await page.selectOption("#threadsel", T1);
  await settle(350);
  assert.deepEqual(await bar(), { menu: T1, log: ALPHA, stored: T1, status: "" });
  await sendNow("to alpha");
  await page.waitForFunction(() => /reply to to alpha/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [T1]);
  // A third thread, slow for the first visit only.
  const T3 = "44444444-4444-4444-8444-444444444444";
  threads[T3] = { id: T3, title: "Gamma", rev: 1, busy: false, archived: false, cards: [], messages: [{ id: "g1", role: "user", at: "t", text: "gamma only message" }] };
  await poll();
  delayFor = { [T2]: 300, [T3]: 50 };
  await page.selectOption("#threadsel", T2);
  await page.waitForTimeout(20);
  await page.selectOption("#threadsel", T3);
  await page.waitForTimeout(20);
  delayFor[T2] = 10;
  await page.selectOption("#threadsel", T2);
  await settle(350);
  assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
});

for (const fail of [502, "network"] as const) {
  test(`browser: a failed switch (${fail}) puts the menu back on the thread still shown and says so`, { skip }, async () => {
    await open();
    failFor[T2] = fail;
    await page.selectOption("#threadsel", T2);
    await settle();
    const s = await bar();
    assert.deepEqual({ ...s, status: "" }, { menu: T1, log: ALPHA, stored: T1, status: "" });
    assert.match(s.status, /Could not open Beta/);
    await sendNow("still alpha");
    await page.waitForFunction(() => /reply to still alpha/.test(document.getElementById("log")!.textContent!));
    assert.deepEqual(sentTo, [T1]);
    // The next poll does not undo it, and a retry that works clears the message.
    await poll();
    assert.equal((await bar()).menu, T1);
    delete failFor[T2];
    await page.selectOption("#threadsel", T2);
    await settle();
    assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
  });
}

test("browser: a failure from an older navigation is ignored once a newer one is under way or done", { skip }, async () => {
  await open();
  failFor[T2] = 503; delayFor[T2] = 300;
  await page.selectOption("#threadsel", T2);
  await page.waitForTimeout(30);
  await page.selectOption("#threadsel", T1);
  await settle(350);
  assert.deepEqual(await bar(), { menu: T1, log: ALPHA, stored: T1, status: "" });
});

test("browser: submitting while a switch is pending sends nothing and keeps the text; it goes to the new thread after", { skip }, async () => {
  await open();
  delayFor[T2] = 400;
  await page.selectOption("#threadsel", T2);
  await page.waitForTimeout(30);
  await sendNow("typed during switch");
  await page.evaluate(() => (document.getElementById("send") as HTMLButtonElement).click());
  await page.waitForTimeout(50);
  assert.deepEqual(sentTo, [], "nothing sent to the old thread");
  assert.equal(await page.inputValue("#input"), "typed during switch", "the text is kept");
  assert.equal(await page.evaluate(() => (document.getElementById("send") as HTMLButtonElement).disabled), true);
  await settle();
  assert.equal(await page.evaluate(() => (document.getElementById("send") as HTMLButtonElement).disabled), false);
  await page.press("#input", "Enter");
  await page.waitForFunction(() => /reply to typed during switch/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [T2]);
  assert.deepEqual({ ...(await bar()), log: [] }, { menu: T2, log: [], stored: T2, status: "" });
});

test("browser: New and Archive navigate like a switch: a later choice wins, and the result is consistent", { skip }, async () => {
  await open();
  // New, then the reader picks Beta before the create answers: Beta stays.
  createDelay = 300;
  await page.click("#tnew");
  await page.waitForTimeout(30);
  await page.selectOption("#threadsel", T2);
  await settle(350);
  assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
  // New on its own opens the new thread, and a message goes there.
  createDelay = 0;
  await page.click("#tnew");
  await settle();
  const made = await bar();
  assert.equal(made.stored, made.menu);
  assert.match(made.menu, /^33333333-/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "input");
  await sendNow("hello new");
  await page.waitForFunction(() => /reply to hello new/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [made.menu]);
  // Archive Beta while a poll for Beta is in flight: the page moves to the next open thread; the old poll is dropped.
  await page.selectOption("#threadsel", T2);
  await settle();
  delayFor[T2] = 200; archiveDelay = 50;
  bump(T2, (t) => t.messages.push({ id: "b2", role: "user", at: "t", text: "late beta" }));
  const slow = poll();
  await page.waitForTimeout(20);
  await page.click("#tarchive");
  await slow;
  await settle(250);
  const after = await bar();
  assert.notEqual(after.menu, T2);
  assert.equal(after.stored, after.menu);
  assert.ok(!after.log.some((t: string) => /beta/.test(t)), `no Beta messages: ${after.log}`);
  sentTo = [];
  await sendNow("after archive");
  await page.waitForFunction(() => /reply to after archive/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [after.menu]);
});

// ---- Mutations (rename, archive, send) that answer after a newer navigation must not steal the selection (review of #75).
// Rename asks for the title with window.prompt; the test answers it.
async function rename(title: string) {
  page.once("dialog", (d: any) => d.accept(title));
  await page.click("#trename");
}
const menuTitle = (id: string) => page.evaluate((i: string) => [...(document.getElementById("threadsel") as HTMLSelectElement).options].find((o) => o.value === i)?.textContent ?? "", id);
const ctl = () => page.evaluate(() => ({
  archive: document.getElementById("tarchive")!.textContent,
  input: (document.getElementById("input") as HTMLInputElement).disabled,
  send: (document.getElementById("send") as HTMLButtonElement).disabled,
}));

test("browser: a slow rename of Alpha answering after the reader switched to Beta keeps Beta, and Enter sends to Beta", { skip }, async () => {
  await open();
  renameDelay = 300; delayFor[T2] = 30;
  await rename("Alpha renamed");
  await page.waitForTimeout(30);
  await page.selectOption("#threadsel", T2);
  await settle(400);
  assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
  assert.match(await menuTitle(T1), /Alpha renamed/, "the list still learns the new title");
  await sendNow("to beta after rename");
  await page.waitForFunction(() => /reply to to beta after rename/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [T2]);
  assert.ok(requests.includes(`POST /threads/${T2}/messages`) && !requests.includes(`POST /threads/${T1}/messages`), requests.join(", "));
});

test("browser: a rename answering while a switch is still pending neither ends the switch nor draws the old thread", { skip }, async () => {
  await open();
  renameDelay = 100; delayFor[T2] = 400;
  await rename("Alpha renamed");
  await page.waitForTimeout(20);
  await page.selectOption("#threadsel", T2);
  await page.waitForTimeout(200);
  // The rename has answered; the switch has not.
  const mid = await bar();
  assert.equal(mid.menu, T2);
  assert.match(mid.status, /Opening Beta/);
  assert.equal(mid.stored, T1, "the stored selection changes only when Beta is drawn");
  assert.equal(await page.evaluate(() => (document.getElementById("send") as HTMLButtonElement).disabled), true);
  await settle(50);
  assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
  await sendNow("to beta");
  await page.waitForFunction(() => /reply to to beta/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [T2]);
});

test("browser: rename then rapid A-B-A ends on A with the new title; a rename with no navigation is drawn at once", { skip }, async () => {
  await open();
  renameDelay = 300; delayFor[T2] = 300;
  await rename("Alpha renamed");
  await page.waitForTimeout(20);
  await page.selectOption("#threadsel", T2);
  await page.waitForTimeout(20);
  await page.selectOption("#threadsel", T1);
  await settle(400);
  assert.deepEqual(await bar(), { menu: T1, log: ALPHA, stored: T1, status: "" });
  assert.match(await menuTitle(T1), /Alpha renamed/);
  await sendNow("to alpha");
  await page.waitForFunction(() => /reply to to alpha/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [T1]);
  // Plain rename, nothing else happening.
  renameDelay = 0;
  await rename("Alpha again");
  await page.waitForFunction(() => /Alpha again/.test((document.getElementById("threadsel") as HTMLSelectElement).selectedOptions[0]?.textContent ?? ""));
  assert.equal((await bar()).menu, T1);
});

for (const fail of [500, "network"] as const) {
  test(`browser: a delayed rename failure (${fail}) after a switch does not touch Beta; on the same thread it says so`, { skip }, async () => {
    await open();
    renameFail = fail; renameDelay = 300;
    await rename("never");
    await page.waitForTimeout(20);
    await page.selectOption("#threadsel", T2);
    await settle();
    await quiet();
    assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
    assert.deepEqual(await ctl(), { archive: "Archive", input: false, send: false });
    // Same thread, no navigation: the failure is reported and the page stays usable.
    renameDelay = 0;
    await rename("never again");
    await quiet();
    assert.match((await bar()).status, /Could not rename/);
    assert.deepEqual({ ...(await bar()), status: "" }, { menu: T2, log: ["beta only message"], stored: T2, status: "" });
    assert.match(await menuTitle(T2), /Beta/);
  });
}

for (const fail of [502, "network"] as const) {
  test(`browser: Archive succeeds but opening the next thread fails (${fail}): the archived state, Restore and the send block hold`, { skip }, async () => {
    await open();
    await page.selectOption("#threadsel", T2);
    await settle();
    failFor[T1] = fail;
    await page.click("#tarchive");
    await settle();
    await quiet();
    const s = await bar();
    assert.deepEqual({ ...s, status: "" }, { menu: T2, log: ["beta only message"], stored: T2, status: "" });
    assert.match(s.status, /Could not open Alpha/);
    assert.deepEqual(await ctl(), { archive: "Restore", input: true, send: true });
    assert.equal(await page.evaluate(() => (document.getElementById("input") as HTMLInputElement).placeholder), "This thread is archived. Restore it to continue.");
    // Nothing goes out, even through a programmatic submit that bypasses the disabled controls.
    await page.evaluate(() => { const i = document.getElementById("input") as HTMLInputElement; i.disabled = false; i.value = "sneak"; (document.getElementById("form") as HTMLFormElement).requestSubmit(); });
    await page.waitForTimeout(50);
    assert.deepEqual(sentTo, []);
    // Restore works from here and the thread takes messages again.
    await page.evaluate(() => { (document.getElementById("input") as HTMLInputElement).value = ""; });
    await page.click("#tarchive");
    await settle(50);
    assert.deepEqual(await ctl(), { archive: "Archive", input: false, send: false });
    assert.equal(threads[T2]!.archived, false);
    await sendNow("back on beta");
    await page.waitForFunction(() => /reply to back on beta/.test(document.getElementById("log")!.textContent!));
    assert.deepEqual(sentTo, [T2]);
  });
}

test("browser: an archive answering after the reader picked another thread does not move them", { skip }, async () => {
  await open();
  const T3 = "44444444-4444-4444-8444-444444444444";
  threads[T3] = { id: T3, title: "Gamma", rev: 1, busy: false, archived: false, cards: [], messages: [{ id: "g1", role: "user", at: "t", text: "gamma only message" }] };
  await poll();
  archiveDelay = 300;
  await page.click("#tarchive");
  await page.waitForTimeout(30);
  await page.selectOption("#threadsel", T3);
  await settle(400);
  assert.deepEqual(await bar(), { menu: T3, log: ["gamma only message"], stored: T3, status: "" });
  assert.equal(threads[T1]!.archived, true);
});

for (const fail of [502, "network"] as const) {
  test(`browser: a send failing (${fail}) after the reader switched away draws no error into the new thread`, { skip }, async () => {
    await open();
    sendFail = fail; sendDelay = 300;
    await sendNow("to alpha");
    await page.waitForTimeout(30);
    await page.selectOption("#threadsel", T2);
    await settle();
    await quiet();
    assert.deepEqual(await bar(), { menu: T2, log: ["beta only message"], stored: T2, status: "" });
    assert.ok(sentTo.length >= 1 && sentTo.every((id) => id === T1), `sent only to Alpha: ${sentTo}`);
  });
}
