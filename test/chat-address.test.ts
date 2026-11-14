import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// Chat thread addresses, /#chat/<thread id> (docs/threads.md, "Addresses"). The pure parser is loaded from the page and
// always runs. The rest drives the real page in Chromium against a scripted fake of ORBIT's thread routes: direct links,
// reloads, plain #chat, picking and creating threads, Back/Forward, bad and missing addresses, late answers after the
// address changed, and two tabs of one browser (shared localStorage) on different threads at once.
// Playwright is not a dependency of this repository: when it cannot be loaded these browser tests are skipped and say so.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level address checks skipped";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";
const { pageFor, chatTarget, chatHash } = new Function(`${block("routing")}; return { pageFor, chatTarget, chatHash };`)() as {
  pageFor: (hash: string, jobs: boolean, assistant: boolean) => string;
  chatTarget: (hash: string) => { kind: "none" } | { kind: "thread"; id: string } | { kind: "invalid"; raw: string };
  chatHash: (id: string | null) => string;
};

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const GONE = "99999999-9999-4999-8999-999999999999";

test("address parsing: #chat/<id> names a thread; plain #chat names none; anything else is invalid and never a thread", () => {
  assert.deepEqual(chatTarget(`#chat/${T1}`), { kind: "thread", id: T1 });
  assert.deepEqual(chatTarget("#chat"), { kind: "none" });
  assert.deepEqual(chatTarget("#chat/"), { kind: "none" });
  assert.deepEqual(chatTarget("#assistant"), { kind: "none" });
  assert.deepEqual(chatTarget(`#chatty/${T1}`), { kind: "none" });
  // An uppercase or percent-encoded copy of a real id is the same thread (and is canonicalized by the page).
  assert.deepEqual(chatTarget(`#chat/${T1.toUpperCase()}`), { kind: "thread", id: T1 });
  assert.deepEqual(chatTarget(`#chat/${encodeURIComponent(T1).replace(/-/g, "%2D")}`), { kind: "thread", id: T1 });
  for (const bad of ["#chat/not-a-thread", "#chat/%E0%A4%A", `#chat/${T1}/x`, `#chat/${T1}%2F..`, "#chat/<img src=x onerror=alert(1)>", `#chat/${T1} `, "#chat/../threads"]) {
    assert.equal(chatTarget(bad).kind, "invalid", bad);
  }
  assert.equal(chatHash(T1), `#chat/${T1}`);
  assert.equal(chatHash(null), "#chat");
  // Routing: any #chat address opens Chat; nothing else changed.
  assert.equal(pageFor(`#chat/${T1}`, true, true), "chat");
  assert.equal(pageFor("#chat/garbage", true, true), "chat");
  assert.equal(pageFor("#chat", true, true), "chat");
  assert.equal(pageFor("#chatty", true, true), "assistant");
  assert.equal(pageFor("", true, true), "assistant");
  assert.equal(pageFor("#jobs", true, true), "jobs");
});

// ---- the fake server -------------------------------------------------------------------------------------------------

type Msg = Record<string, unknown> & { id: string };
type Thread = { id: string; title: string; rev: number; busy: boolean; archived: boolean; messages: Msg[]; cards: Record<string, unknown>[] };
const fresh = (): Record<string, Thread> => ({
  [T1]: { id: T1, title: "Alpha", rev: 1, busy: false, archived: false, cards: [], messages: [{ id: "a1", role: "user", at: "t", text: "alpha only message" }] },
  [T2]: { id: T2, title: "Beta", rev: 1, busy: false, archived: false, cards: [], messages: [{ id: "b1", role: "user", at: "t", text: "beta only message" }] },
});
let threads = fresh();
let delayFor: Record<string, number> = {};
let failFor: Record<string, number | "network"> = {};
let sendDelayFor: Record<string, number> = {};
let sentTo: string[] = [];
let requests: string[] = [];
let created = 0;
let inflight = 0;

const meta = (t: Thread) => ({ id: t.id, title: t.title, archived: t.archived, rev: t.rev, busy: t.busy, openCards: 0, messageCount: t.messages.length });
const readBody = (req: any) => new Promise<any>((r) => { let d = ""; req.on("data", (c: string) => (d += c)); req.on("end", () => r(JSON.parse(d || "{}"))); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname.startsWith("/threads")) requests.push(`${req.method} ${url.pathname}`);
  inflight++; res.on("close", () => inflight--);
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (url.pathname === "/status") return json(200, { ports: [] });
  if (url.pathname === "/notifications") return json(200, { inbox: [] });
  if (url.pathname === "/model/login" || url.pathname === "/chat/proposals" || url.pathname.startsWith("/assistant")) return json(403, { error: "no" });
  if (url.pathname === "/threads" && req.method === "POST") {
    const id = `33333333-3333-4333-8333-${String(++created).padStart(12, "0")}`;
    threads[id] = { id, title: `New ${created}`, rev: 1, busy: false, archived: false, cards: [], messages: [] };
    return json(200, { thread: structuredClone(threads[id]) });
  }
  if (url.pathname === "/threads") return json(200, { threads: Object.values(threads).map(meta), notice: null });
  const m = url.pathname.match(/^\/threads\/([0-9a-f-]{36})$/);
  if (m) {
    const t = threads[m[1]!];
    const snapshot = t && structuredClone(t);
    if (delayFor[m[1]!]) await sleep(delayFor[m[1]!]!);
    const fail = failFor[m[1]!];
    if (fail === "network") return req.socket.destroy();
    if (fail) return json(fail, { error: "refused" });
    if (!t) return json(404, { error: "No thread with that id." });
    return json(200, { thread: snapshot });
  }
  const s = url.pathname.match(/^\/threads\/([0-9a-f-]{36})\/messages$/);
  if (s) {
    const t = threads[s[1]!];
    if (!t) return json(404, { error: "No thread with that id." });
    const body = await readBody(req);
    sentTo.push(t.id);
    t.busy = true;
    t.messages.push({ id: `u${t.messages.length}`, role: "user", at: "t", text: body.text }, { id: `r${t.messages.length}`, role: "assistant", at: "t", text: "", status: "pending" });
    t.rev++;
    if (sendDelayFor[t.id]) await sleep(sendDelayFor[t.id]!);
    Object.assign(t.messages.at(-1)!, { status: "done", text: `reply to ${body.text}`, provenance: "live", source: "model/x" });
    t.busy = false; t.rev++;
    return json(200, { thread: structuredClone(t) });
  }
  json(404, { error: "not found" });
});

let browser: any, ctx: any, page: any, base = "";
before(async () => {
  if (skip) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); server.close(); });

function reset() {
  threads = fresh(); delayFor = {}; failFor = {}; sendDelayFor = {}; sentTo = []; requests = []; created = 0;
}
// A fresh browser context (its own localStorage) with the stored selection set to `stored`, opened at `hash`.
async function open(hash: string, stored: string | null = T1) {
  reset();
  await ctx?.close();
  ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  if (stored) await ctx.addInitScript(`if (!localStorage.getItem("seeded")) { localStorage.setItem("seeded", "1"); localStorage.setItem("orbit.thread", ${JSON.stringify(stored)}); }`);
  page = await ctx.newPage();
  await page.goto(`${base}${hash}`);
  await settled(page);
  return page;
}
const settled = async (p: any, ms = 30) => {
  // threadMode and sending are the page's top-level `let`s: visible to a string expression, not as window properties.
  await p.waitForFunction('document.readyState === "complete" && threadMode !== null && !navPending() && !sending', null, { timeout: 5000 });
  for (let i = 0; i < 300 && inflight > 0; i++) await sleep(10);
  await p.waitForTimeout(ms);
};
// What the tab shows and where it would send: the address, the menu, the log, the status, and whether Send is usable.
const view = (p: any = page) => p.evaluate(() => ({
  hash: location.hash,
  menu: (document.getElementById("threadsel") as HTMLSelectElement).value,
  log: [...document.querySelectorAll("#log .msg")].map((n) => n.textContent!.slice(0, 24)),
  canSend: !(document.getElementById("input") as HTMLTextAreaElement).disabled && !(document.getElementById("send") as HTMLButtonElement).disabled,
}));
const status = (p: any = page) => p.evaluate(() => document.getElementById("tstatus")!.textContent);
const histLen = (p: any = page) => p.evaluate(() => history.length);
const A = ["alpha only message"], B = ["beta only message"];
async function send(p: any, text: string) {
  await p.fill("#input", text);
  await p.press("#input", "Enter");
}
// A submit that bypasses disabled controls, to prove the guard is in the page logic and not only in the buttons.
const forceSubmit = (p: any, text: string) => p.evaluate((t: string) => {
  const i = document.getElementById("input") as HTMLTextAreaElement; i.disabled = false; i.value = t;
  (document.getElementById("send") as HTMLButtonElement).disabled = false;
  (document.getElementById("form") as HTMLFormElement).requestSubmit();
}, text);

// ---- direct load, refresh, plain #chat ---------------------------------------------------------------------------------

test("browser: a direct link opens the thread it names, whatever the stored selection says, and a reload keeps it", { skip }, async () => {
  await open(`#chat/${T2}`, T1);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  assert.ok(!requests.includes(`GET /threads/${T1}`), "the stored thread is not even fetched");
  // Another tab moves the stored selection; this tab reloads and stays on its address.
  await page.evaluate((id: string) => localStorage.setItem("orbit.thread", id), T1);
  await page.reload();
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  await send(page, "to beta");
  await page.waitForFunction(() => /reply to to beta/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [T2]);
});

test("browser: plain #chat opens the stored thread (else the newest open one) and replaces the address with it", { skip }, async () => {
  await open("#chat", T2);
  const len = await histLen();
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  assert.equal(await histLen(), len, "replaced, not pushed: Back does not land on an unresolved #chat");
  await open("#chat", null);
  assert.equal((await view()).log.length, 1);
  assert.match((await view()).hash, /^#chat\/[12]{8}-/);
  // The Chat link (plain /#chat) while a thread is open keeps that thread and fills its address back in.
  await page.click('#tabs a[data-tab="chat"]');
  await settled(page);
  const v = await view();
  assert.equal(v.hash, `#chat/${v.menu}`);
});

test("browser: an uppercase or encoded address opens the thread and is canonicalized in place", { skip }, async () => {
  await open(`#chat/${T2.toUpperCase().replace(/-/g, "%2D")}`, T1);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
});

test("browser: plain #chat with no threads shows the empty state; the first send creates one thread and the address follows", { skip }, async () => {
  await open("#chat", null);
  threads = {};
  await page.goto(`${base}?again#chat`); // a real load (not just a hash change) at plain #chat
  await settled(page);
  assert.equal((await view()).hash, "#chat");
  await send(page, "first ever");
  await page.waitForFunction(() => /reply to first ever/.test(document.getElementById("log")!.textContent!));
  assert.equal(created, 1);
  assert.equal((await view()).hash, `#chat/${sentTo[0]}`);
});

// ---- selection, New, Back/Forward ------------------------------------------------------------------------------------

test("browser: picking a thread and New push addresses; Back and Forward move between them with no new thread and no loop", { skip }, async () => {
  await open(`#chat/${T1}`);
  await page.selectOption("#threadsel", T2);
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  await page.click("#tnew");
  await settled(page);
  const made = (await view()).menu;
  assert.match(made, /^33333333-/);
  assert.equal((await view()).hash, `#chat/${made}`);
  assert.equal(created, 1);
  requests = [];
  await page.goBack();
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  await page.goBack();
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${T1}`, menu: T1, log: A, canSend: true });
  await page.goForward();
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  await page.goForward();
  await settled(page, 300);
  assert.deepEqual(await view(), { hash: `#chat/${made}`, menu: made, log: [], canSend: true });
  assert.equal(created, 1, "Back/Forward never creates a thread");
  assert.ok(!requests.some((r) => r === "POST /threads"), requests.join(", "));
  // One open per step, no feedback loop between the address and the page.
  assert.equal(requests.filter((r) => r.startsWith("GET /threads/")).length, 4, requests.join(", "));
  await send(page, "to the new one");
  await page.waitForFunction(() => /reply to to the new one/.test(document.getElementById("log")!.textContent!));
  assert.deepEqual(sentTo, [made]);
});

test("browser: Back during a slow switch ends on the thread Back named; the slow answer is dropped", { skip }, async () => {
  await open(`#chat/${T1}`);
  await page.selectOption("#threadsel", T2);
  await settled(page);
  delayFor[GONE] = 0; delayFor[T1] = 300;
  await page.goBack(); // to T1, slow
  await page.waitForTimeout(30);
  delayFor[T2] = 0;
  await page.goForward(); // to T2 (drawn already, so nothing to fetch)
  await settled(page, 400);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
});

// ---- bad, missing, deleted and refused addresses ------------------------------------------------------------------------

for (const bad of ["#chat/not-a-thread", "#chat/%E0%A4%A", `#chat/${T1}/x`, "#chat/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"]) {
  test(`browser: an invalid address (${bad}) is reported as text, fetches nothing, and sends nothing`, { skip }, async () => {
    await open(bad, T1);
    const v = await view();
    assert.equal(v.hash, bad);
    assert.equal(v.canSend, false);
    assert.deepEqual(v.log, []);
    assert.match(await status(), /does not name a thread/);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#log img, #log script").length), 0, "no markup from the address");
    assert.ok(!requests.some((r) => r.startsWith("GET /threads/")), requests.join(", "));
    await forceSubmit(page, "sneak");
    await page.waitForTimeout(100);
    assert.deepEqual(sentTo, []);
    assert.equal(created, 0, "no thread is created in its place");
    // Picking a thread from the menu recovers and fixes the address.
    await page.selectOption("#threadsel", T2);
    await settled(page);
    assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  });
}

test("browser: an address naming a thread that does not exist says so and never sends or creates elsewhere", { skip }, async () => {
  await open(`#chat/${GONE}`, T1);
  assert.deepEqual(await view(), { hash: `#chat/${GONE}`, menu: "", log: [], canSend: false });
  assert.match(await status(), new RegExp(`No thread ${GONE}`));
  await forceSubmit(page, "sneak");
  await page.waitForTimeout(100);
  assert.deepEqual(sentTo, []);
  assert.equal(created, 0);
  assert.ok(!requests.includes(`GET /threads/${T1}`), "the stored thread is not substituted");
  // Moving from a good thread to a missing one by the address does not leave the good one usable.
  await page.evaluate((id: string) => { location.hash = `#chat/${id}`; }, T1);
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${T1}`, menu: T1, log: A, canSend: true });
  await page.evaluate((id: string) => { location.hash = `#chat/${id}`; }, GONE);
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${GONE}`, menu: "", log: [], canSend: false });
  await forceSubmit(page, "sneak again");
  await page.waitForTimeout(100);
  assert.deepEqual(sentTo, []);
});

test("browser: a thread deleted on the server while open is reported at the next poll; the next send goes nowhere", { skip }, async () => {
  await open(`#chat/${T1}`);
  delete threads[T1];
  await page.evaluate(() => (window as any).pollThreads());
  await settled(page);
  const v = await view();
  assert.equal(v.canSend, false);
  assert.match(await status(), /no longer exists/);
  await forceSubmit(page, "into the void");
  await page.waitForTimeout(100);
  assert.deepEqual(sentTo, []);
  assert.equal(created, 0, "no new thread is started in its place");
});

for (const fail of [403, 502, "network"] as const) {
  test(`browser: an address the server refuses or cannot answer (${fail}) is reported and sends nothing; Try again recovers`, { skip }, async () => {
    await open(`#chat/${T1}`);
    failFor[T2] = fail;
    await page.evaluate((id: string) => { location.hash = `#chat/${id}`; }, T2);
    await settled(page);
    assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: "", log: [], canSend: false });
    assert.match(await status(), fail === 403 ? /cannot open thread .*owner only/ : /Could not open thread/);
    await forceSubmit(page, "sneak");
    await page.waitForTimeout(100);
    assert.deepEqual(sentTo, []);
    delete failFor[T2];
    await page.click("#log .banner button");
    await settled(page);
    assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
  });
}

// ---- late answers after the address changed ---------------------------------------------------------------------------

test("browser: a slow history load for the old address is dropped after the address changes", { skip }, async () => {
  await open(`#chat/${T1}`);
  delayFor[T2] = 300;
  await page.evaluate((id: string) => { location.hash = `#chat/${id}`; }, T2);
  await page.waitForTimeout(30);
  await page.evaluate((id: string) => { location.hash = `#chat/${id}`; }, T1);
  await settled(page, 400);
  assert.deepEqual(await view(), { hash: `#chat/${T1}`, menu: T1, log: A, canSend: true });
});

test("browser: a slow poll of the old thread is dropped after the address changes", { skip }, async () => {
  await open(`#chat/${T1}`);
  delayFor[T1] = 300;
  threads[T1]!.messages.push({ id: "late", role: "user", at: "t", text: "late alpha message" }); threads[T1]!.rev++;
  const slow = page.evaluate(() => (window as any).pollThreads());
  await page.waitForTimeout(50);
  await page.evaluate((id: string) => { location.hash = `#chat/${id}`; }, T2);
  await slow;
  await settled(page, 350);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
});

test("browser: a send's late reply is not drawn after the address moved, and it is in its own thread when that thread is opened again", { skip }, async () => {
  await open(`#chat/${T1}`);
  sendDelayFor[T1] = 400;
  await send(page, "slow alpha");
  await page.waitForTimeout(50);
  await page.evaluate((id: string) => { location.hash = `#chat/${id}`; }, T2);
  await page.waitForFunction(() => /beta only/.test(document.getElementById("log")!.textContent!));
  // As before, a tab sends one message at a time: Beta's Send waits for Alpha's reply (which is not drawn here), and a
  // submit meanwhile sends nothing. Another tab is not held up (see the two-tab test).
  assert.equal((await view()).canSend, false);
  await page.waitForFunction("!sending");
  await page.waitForTimeout(50);
  assert.deepEqual((await view()).log, B, "Alpha's late reply is not drawn into Beta");
  assert.equal((await view()).canSend, true);
  await send(page, "quick beta");
  await page.waitForFunction(() => /reply to quick beta/.test(document.getElementById("log")!.textContent!));
  await settled(page, 100);
  const v = await view();
  assert.equal(v.hash, `#chat/${T2}`);
  assert.ok(!v.log.some((t: string) => /alpha/.test(t)), `nothing from Alpha: ${v.log}`);
  assert.deepEqual(sentTo, [T1, T2]);
  await page.goBack();
  await settled(page);
  assert.deepEqual((await view()).log, ["alpha only message", "slow alpha", "reply to slow alphalive "]);
});

// ---- two tabs of one browser ------------------------------------------------------------------------------------------

test("browser: two tabs sharing localStorage keep independent threads: concurrent sends land in their own threads, and neither tab moves", { skip }, async () => {
  await open(`#chat/${T1}`);
  const a = page;
  const b = await ctx.newPage();
  await b.goto(`${base}#chat/${T2}`);
  await settled(b);
  // B's open wrote the shared stored selection (and fired a storage event in A): A does not move.
  assert.equal(await a.evaluate(() => localStorage.getItem("orbit.thread")), T2);
  assert.deepEqual(await view(a), { hash: `#chat/${T1}`, menu: T1, log: A, canSend: true });
  sendDelayFor = { [T1]: 300, [T2]: 150 };
  await Promise.all([send(a, "from tab a"), send(b, "from tab b")]);
  // While both are waiting, B switches threads and back; neither reply crosses over.
  await Promise.all([
    a.waitForFunction(() => /reply to from tab a/.test(document.getElementById("log")!.textContent!)),
    b.waitForFunction(() => /reply to from tab b/.test(document.getElementById("log")!.textContent!)),
  ]);
  await settled(a); await settled(b);
  assert.deepEqual([...sentTo].sort(), [T1, T2].sort());
  assert.deepEqual(threads[T1]!.messages.map((m) => m.text), ["alpha only message", "from tab a", "reply to from tab a"]);
  assert.deepEqual(threads[T2]!.messages.map((m) => m.text), ["beta only message", "from tab b", "reply to from tab b"]);
  const va = await view(a), vb = await view(b);
  assert.equal(va.hash, `#chat/${T1}`); assert.ok(va.log.every((t: string) => !/beta|tab b/.test(t)), va.log.join(" | "));
  assert.equal(vb.hash, `#chat/${T2}`); assert.ok(vb.log.every((t: string) => !/alpha|tab a/.test(t)), vb.log.join(" | "));
  // B starts a new thread (writing the stored selection). A new tab on plain #chat takes that shared fallback (the thread
  // last opened in this browser) and gets its own address; A, reloaded, still shows Alpha.
  await b.click("#tnew");
  await settled(b);
  const made = (await view(b)).menu;
  assert.match(made, /^33333333-/);
  const c = await ctx.newPage();
  await c.goto(`${base}#chat`);
  await settled(c);
  assert.equal((await view(c)).hash, `#chat/${made}`);
  await a.reload();
  await settled(a);
  assert.deepEqual(await view(a), { hash: `#chat/${T1}`, menu: T1, log: [...A, "from tab a", "reply to from tab alive "], canSend: true });
  assert.equal((await view(b)).hash, `#chat/${made}`, "A's reload does not move B either");
  await b.close(); await c.close();
});

test("browser: the Assistant and Jobs addresses are untouched by Chat's address handling", { skip }, async () => {
  await open("#assistant", T2);
  // Threads load behind the Assistant (owner check), but the address stays the Assistant's.
  assert.equal(await page.evaluate(() => location.hash), "#assistant");
  await page.click('#tabs a[data-tab="chat"]');
  await settled(page);
  assert.deepEqual(await view(), { hash: `#chat/${T2}`, menu: T2, log: B, canSend: true });
});
