import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// The Assistant page (docs/assistant.md). The pure helpers (status aggregation, routing) are loaded from the page and always run;
// the page itself runs in a real browser (Playwright's Chromium) against a scripted fake of ORBIT's routes, and is skipped, saying
// so, where Playwright is not installed (as in CI). Offline: no model, no real ORBIT.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))![1]!;

// ---- pure helpers -----------------------------------------------------------------------------------------------------

const { aggregateStatus } = new Function(`${block("status-dot")}; return { aggregateStatus };`)() as { aggregateStatus: (s: unknown) => { ok: boolean; label: string; detail: string } };
const { pageFor } = new Function(`${block("routing")}; return { pageFor };`)() as { pageFor: (hash: string, jobs: boolean, assistant: boolean) => string };

test("status dot: green only when every entry is exactly live; anything else, or no usable answer, is red", () => {
  const live = (port: string) => ({ port, state: "live", detail: "", verifiedAt: "t" });
  assert.equal(aggregateStatus({ ports: [live("model"), live("memory")] }).ok, true);
  assert.equal(aggregateStatus({ ports: [live("model"), live("memory")] }).label, "All live");
  for (const state of ["degraded", "down", "mock", "LIVE", "live ", "", undefined, null]) {
    const r = aggregateStatus({ ports: [live("model"), { port: "memory", state }] });
    assert.equal(r.ok, false, `state ${JSON.stringify(state)} is not live`);
    assert.equal(r.label, "1 not live");
    assert.match(r.detail, /memory/);
  }
  // Missing, unavailable, error or not yet known: red, never green.
  for (const s of [null, undefined, {}, { ports: [] }, { ports: "live" }, { error: "x" }, { ports: [null] }]) assert.equal(aggregateStatus(s).ok, false, JSON.stringify(s));
  assert.equal(aggregateStatus(null).label, "Status unknown");
});

test("routing: the root and unknown hashes open the Assistant; explicit #chat and #jobs are kept; owner-only pages fall back", () => {
  assert.equal(pageFor("", true, true), "assistant");
  assert.equal(pageFor("#assistant", true, true), "assistant");
  assert.equal(pageFor("#nothing-here", true, true), "assistant");
  assert.equal(pageFor("#chat", true, true), "chat");
  assert.equal(pageFor("#jobs", true, true), "jobs");
  assert.equal(pageFor("#jobs", false, true), "assistant", "Jobs not available (yet): the default page");
  assert.equal(pageFor("", false, false), "chat", "not the owner: Chat, as before");
  assert.equal(pageFor("#assistant", false, false), "chat");
  assert.equal(pageFor("#chat", false, false), "chat");
});

test("the page markup: Assistant first in the nav, then Chat, Jobs, Status; the logo header stays; the dot links to Status", () => {
  const nav = html.match(/<nav id="tabs"[^>]*>([\s\S]*?)<\/nav>/)![1]!;
  const labels = [...nav.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  assert.deepEqual(labels.map((l) => l.split(" ")[0]), ["Assistant", "Chat", "Jobs", "Status"]);
  assert.match(html, /<div class="brand"><img src="\/avatar.png" alt=""><h1>ORBIT<\/h1>/);
  const dot = html.match(/<a id="health"[^>]*>/)![0];
  assert.match(dot, /href="\/status"/);
  assert.match(dot, /aria-label="Overall status: unknown, not all live/);
  assert.doesNotMatch(dot, /class="ok"/, "it starts red, never green before an answer");
  // No session picker, New, Rename, Archive or delete control on the Assistant: the only controls are the input and Send.
  const aform = html.match(/<form id="aform">[\s\S]*?<\/form>/)![0];
  assert.doesNotMatch(aform, /<select|New|Rename|Archive|Delete/);
});

// ---- the page in a real browser ---------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level Assistant checks skipped";

const T1 = "11111111-1111-4111-8111-111111111111";
type View = Record<string, any>;
const msg = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({ id, role, at: "2026-11-14T00:00:00Z", text, ...extra });
const chunk = (seq: number, messages: unknown[], extra: Record<string, unknown> = {}) => ({ seq, id: `c${seq}`, createdAt: "2026-11-14T00:00:00Z", state: "complete", cards: [], messages, ...extra });
const baseView = (chunks: unknown[], extra: Record<string, unknown> = {}): View => ({
  session: { schema: 1, id: "assistant", createdAt: "2026-11-01T00:00:00Z" }, title: "Assistant", persisted: true, problems: [], busy: false, rev: 1, archivedChunks: 0, chunks,
  next: { included: (chunks as { seq: number }[]).map((c) => ({ seq: c.seq, form: "full", chars: 10 })), omitted: [], historyChars: 10 },
  budgets: { unit: "characters", activeChars: 32000, chunkMaxChars: 12000, contextChars: 52000, notesMaxChars: 12000 },
  ...extra,
});

let owner = true;
let status: { code: number; body: unknown } = { code: 200, body: { ports: [{ port: "model", state: "live" }, { port: "memory", state: "live" }] } };
let view: View = baseView([]);
let sendAnswer: (text: string) => { code: number; body: unknown } | "network" = () => ({ code: 200, body: { assistant: view } });
let history: { chunks: unknown[]; more: boolean } = { chunks: [], more: false };
let requests: string[] = [];
let requestIds: string[] = [];
let confirms = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  requests.push(`${req.method} ${url.pathname}${url.search}`);
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const read = () => new Promise<any>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (url.pathname === "/avatar.png") { res.writeHead(404); return res.end(); }
  if (url.pathname === "/status") return status.code === 0 ? req.socket.destroy() : json(status.code, status.body);
  if (url.pathname === "/notifications") return json(200, { inbox: [] });
  if (url.pathname === "/model/login") return json(403, { error: "no" });
  if (url.pathname === "/chat/proposals" && req.method === "GET") return owner ? json(200, { proposals: [] }) : json(403, { error: "owner only" });
  if (url.pathname === "/jobs") return owner ? json(200, { jobs: [] }) : json(403, { error: "owner only" });
  if (url.pathname === "/threads") return owner ? json(200, { threads: [{ id: T1, title: "Alpha", archived: false, rev: 1, busy: false, openCards: 0, messageCount: 1 }], notice: null }) : json(403, { error: "owner only" });
  if (url.pathname === `/threads/${T1}`) return json(200, { thread: { id: T1, title: "Alpha", rev: 1, busy: false, archived: false, cards: [], messages: [msg("t1", "user", "chat thread message")] } });
  if (!owner && url.pathname.startsWith("/assistant")) return json(403, { error: "assistant.open is refused: only the owner can use assistant" });
  if (url.pathname === "/assistant") return json(200, { assistant: view });
  if (url.pathname === "/assistant/history") return json(200, history);
  if (url.pathname === "/assistant/messages" && req.method === "POST") {
    const body = await read();
    requestIds.push(body.requestId);
    const a = sendAnswer(body.text);
    if (a === "network") return req.socket.destroy();
    return json(a.code, a.body);
  }
  const c = url.pathname.match(/^\/chat\/proposals\/([\w-]+)\/confirm$/);
  if (c) { confirms++; return json(202, { id: "orbit-job-9" }); }
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

async function open(hash = "") {
  requests = []; confirms = 0;
  await page?.close();
  page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  await page.goto(`${base}${hash}`);
  await page.waitForFunction(() => (window as any).document.readyState === "complete");
  await page.waitForTimeout(150);
}
const reset = () => {
  owner = true;
  status = { code: 200, body: { ports: [{ port: "model", state: "live" }, { port: "memory", state: "live" }] } };
  view = baseView([]);
  sendAnswer = () => ({ code: 200, body: { assistant: view } });
  history = { chunks: [], more: false };
};
const shown = (sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && !e.hidden && e.offsetParent !== null); }, sel);

test("browser: the root opens the Assistant first, with Assistant first in the nav, and no Chat thread bar", { skip }, async () => {
  reset();
  await open();
  assert.deepEqual(await page.$$eval("#tabs a:not([hidden])", (as: HTMLAnchorElement[]) => as.map((a) => a.textContent!.trim().split(/\s/)[0])), ["Assistant", "Chat", "Jobs", "Status"]);
  assert.equal(await page.getAttribute("#assistanttab", "aria-current"), "page");
  assert.equal(await shown("#alog"), true);
  assert.equal(await shown("#aform"), true);
  assert.equal(await shown("#log"), false);
  assert.equal(await shown("#form"), false);
  assert.equal(await shown("#threadbar"), false, "the Chat thread picker is not on the Assistant");
  assert.equal(await shown(".brand img"), true, "the ORBIT logo header stays");
  assert.match(await page.textContent("#alog"), /The Assistant conversation is empty/);
  assert.ok(requests.includes("GET /assistant"));
});

test("browser: explicit #chat keeps Chat exactly as before (thread bar, threads loaded); #jobs opens Jobs; links switch pages", { skip }, async () => {
  reset();
  await open("#chat");
  await page.waitForFunction(() => document.querySelectorAll("#log .msg").length === 1);
  assert.equal(await page.getAttribute('#tabs a[data-tab="chat"]', "aria-current"), "page");
  assert.equal(await shown("#log"), true);
  assert.equal(await shown("#threadbar"), true);
  assert.equal(await shown("#alog"), false);
  assert.match(await page.textContent("#log"), /chat thread message/);
  await page.click("#assistanttab");
  await page.waitForFunction(() => location.hash === "#assistant");
  assert.equal(await shown("#alog"), true);
  assert.equal(await shown("#threadbar"), false);
  await open("#jobs");
  await page.waitForFunction(() => !(document.getElementById("jobs") as HTMLElement).hidden);
  assert.equal(await shown("#alog"), false);
});

test("browser: a viewer who is not the owner gets no Assistant link and lands on Chat, as before", { skip }, async () => {
  reset();
  owner = false;
  await open();
  await page.waitForFunction(() => (document.getElementById("assistanttab") as HTMLElement).hidden);
  await page.waitForFunction(() => !(document.getElementById("log") as HTMLElement).hidden);
  assert.equal(await shown("#alog"), false);
  assert.equal(await shown("#form"), true);
});

test("browser: the status dot is green only when all entries are live, red for a non-live entry, an error or no answer", { skip }, async () => {
  reset();
  status = { code: 200, body: { ports: [{ port: "model", state: "live" }, { port: "memory", state: "live" }] } };
  await open();
  await page.waitForFunction(() => document.getElementById("health")!.className === "ok");
  assert.match(await page.getAttribute("#health", "aria-label"), /all live/);
  assert.equal(await page.getAttribute("#health", "href"), "/status");
  status = { code: 200, body: { ports: [{ port: "model", state: "live" }, { port: "watch", state: "degraded" }] } };
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.getElementById("health")!.className === "bad");
  assert.match(await page.getAttribute("#health", "title"), /watch: degraded/);
  assert.equal(await page.textContent("#health .label"), "1 not live");
  status = { code: 500, body: { error: "boom" } };
  await page.evaluate("refreshStatus()");
  assert.equal(await page.getAttribute("#health", "class"), "bad");
  assert.equal(await page.textContent("#health .label"), "Status unknown");
  status = { code: 200, body: { ports: [{ port: "model", state: "live" }] } };
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.getElementById("health")!.className === "ok");
  status = { code: 0, body: null };
  await page.evaluate("refreshStatus()");
  assert.equal(await page.getAttribute("#health", "class"), "bad", "no answer at all is red");
  // The dot's colours differ (green vs red), and the state is also in text, not colour alone.
  assert.match(await page.getAttribute("#health", "aria-label"), /Overall status: Status unknown/);
});

test("browser: tool output and resource usage are collapsed panes; warnings and the confirmation stay visible and work", { skip }, async () => {
  reset();
  const card = { id: "p-1", kind: "job_launch", state: "open", createdAt: "t", expiresAt: "2999-01-01T00:00:00Z", routine: "orbit", brief: "Build the exporter" };
  view = baseView([
    chunk(1, [
      msg("u1", "user", "launch it"),
      msg("a1", "assistant", "Proposed. **Waiting** for you.", { status: "done", provenance: "live", source: "model/test", memory: ["Projects/x.md"], accounting: ["ledger write failed"], cards: ["p-1"],
        calls: [{ callId: "c1", name: "job_launch", arguments: '{"routine":"orbit"}', ok: true, provenance: "live", source: "jobs", summary: "proposed", at: "t", outputChars: 321 }, { callId: "c2", name: "ops_restart", arguments: "{}", ok: false, outcomeUnknown: true, interrupted: "timeout", summary: "timed out", at: "t", outputChars: 0 }] }),
    ], { cards: [card], context: { budgetChars: 52000, historyChars: 1200, currentChars: 9, included: [{ seq: 0, form: "clipped", chars: 1200 }], omitted: [] } }),
  ]);
  view.next = { included: [{ seq: 1, form: "clipped", chars: 900 }], omitted: [], historyChars: 900 };
  await open();
  await page.waitForSelector("#alog details.toolpane");
  const panes = await page.$$eval("#alog details", (ds: HTMLDetailsElement[]) => ds.map((d) => ({ cls: d.className, open: d.open, summary: d.querySelector("summary")!.textContent })));
  assert.deepEqual(panes.map((p: any) => [p.cls, p.open]), [["toolpane", false], ["usagepane", false]], "both panes closed by default");
  assert.match(panes[0].summary, /Tool output \(2 calls, 1 with unknown outcome\)/);
  // Keyboard: a pane is a native disclosure, opened with Enter on its summary.
  await page.focus("#alog details.toolpane summary");
  await page.keyboard.press("Enter");
  assert.equal(await page.$eval("#alog details.toolpane", (d: HTMLDetailsElement) => d.open), true);
  assert.match(await page.textContent("#alog details.toolpane"), /✓ job_launch.*321 characters of output/);
  assert.match(await page.textContent("#alog details.toolpane"), /\? ops_restart.*outcome unknown, not retried/);
  await page.click("#alog details.usagepane summary");
  const usage = await page.textContent("#alog details.usagepane");
  assert.match(usage, /Answered by: live · model\/test/);
  assert.match(usage, /Context sent: 1209 of 52000 characters/);
  assert.match(usage, /Vault notes read: Projects\/x\.md/);
  // Outside the panes: the reply (Markdown), the spend warning, the bounded-context note and the proposal with its buttons.
  assert.equal(await page.textContent("#alog .msg.orbit .md strong"), "Waiting");
  assert.equal(await page.$eval("#alog .msg.orbit > .warn", (e: Element) => e.closest("details") === null), true);
  assert.match(await page.textContent("#alog .msg.orbit .bounded"), /shortened/);
  assert.equal(await page.$eval("#alog .proposal button", (b: Element) => b.closest("details") === null && (b as HTMLElement).offsetParent !== null), true, "the confirmation is never inside a collapsed pane");
  view = { ...view, rev: 2, chunks: [{ ...view.chunks[0], cards: [{ ...card, state: "confirmed", outcome: { jobId: "orbit-job-9" } }] }] };
  await page.click("#alog .proposal button:not(.cancel)");
  await page.waitForFunction(() => /Job orbit-job-9/.test(document.getElementById("alog")!.textContent!));
  assert.equal(confirms, 1);
});

test("browser: Send posts once, draws the stored reply, and a refused or unanswered send keeps the text and never resends", { skip }, async () => {
  reset();
  await open();
  sendAnswer = (text) => {
    view = baseView([chunk(1, [msg("u1", "user", text), msg("a1", "assistant", "Got it.", { status: "done", provenance: "live", source: "model/test", calls: [] })])], { rev: 2 });
    return { code: 200, body: { assistant: view } };
  };
  await page.fill("#ainput", "hello assistant");
  await page.press("#ainput", "Enter");
  await page.waitForFunction(() => /Got it\./.test(document.getElementById("alog")!.textContent!));
  assert.equal(requests.filter((r) => r === "POST /assistant/messages").length, 1);
  assert.equal(await page.inputValue("#ainput"), "");
  assert.equal(await page.$$eval("#alog .msg", (n: Element[]) => n.length), 2, "the optimistic bubbles are replaced, not duplicated");
  // Busy on another device: 409, nothing stored, the text goes back in the box with a visible error.
  sendAnswer = () => ({ code: 409, body: { error: "A reply is already in progress in the Assistant (maybe from another tab or device). Nothing was sent; wait for it and send again.", assistant: { ...view, rev: 3 } } });
  await page.fill("#ainput", "second try");
  await page.click("#asend");
  await page.waitForFunction(() => /already in progress/.test(document.getElementById("astatus")!.textContent!));
  assert.equal(await page.inputValue("#ainput"), "second try");
  assert.equal(await page.getAttribute("#astatus", "role"), "alert");
  // No answer at all: said plainly, reloaded from the server, never sent again.
  requests = [];
  sendAnswer = () => "network";
  await page.click("#asend");
  await page.waitForFunction(() => /did not answer/.test(document.getElementById("astatus")!.textContent!));
  await page.waitForTimeout(300);
  // Chromium itself may repeat a POST whose connection dropped before any answer. Every repeat carries the same request id, which
  // the server uses to refuse a repeat of a send that already started (test/assistant-server.test.ts).
  const posted = requests.filter((r) => r === "POST /assistant/messages").length;
  assert.ok(posted >= 1);
  assert.equal(new Set(requestIds.slice(-posted)).size, 1, "every repeat is the same send, with one request id");
  assert.ok(requests.includes("GET /assistant"), "the conversation is reloaded from the server");
});

test("browser: a reply in progress elsewhere pauses Send; earlier archived turns load on request and are marked as not sent", { skip }, async () => {
  reset();
  view = baseView([chunk(5, [msg("u5", "user", "recent question"), msg("a5", "assistant", "", { status: "pending", calls: [] })], { state: "open" })], { busy: true, archivedChunks: 4, next: { included: [], omitted: [], historyChars: 0 } });
  history = { chunks: [chunk(3, [msg("u3", "user", "OLD archived question"), msg("a3", "assistant", "old answer", { status: "done", provenance: "live", source: "model/test" })]), chunk(4, [msg("u4", "user", "older two"), msg("a4", "assistant", "fine", { status: "done" })])], more: true };
  await open();
  await page.waitForSelector("#alog .older");
  assert.equal(await page.$eval("#asend", (b: HTMLButtonElement) => b.disabled), true, "Send waits for the reply in progress");
  assert.match(await page.textContent("#astatus"), /in progress on another tab or device/);
  assert.match(await page.textContent("#alog"), /Working…/);
  await page.click("#alog .older");
  await page.waitForFunction(() => /OLD archived question/.test(document.getElementById("alog")!.textContent!));
  assert.ok(requests.some((r) => r.startsWith("GET /assistant/history?before=5&limit=10")));
  assert.equal(await page.$$eval("#alog .msg.outctx", (n: Element[]) => n.length), 4, "archived turns are marked as outside the model's context");
  assert.match(await page.textContent("#alog .ctxline"), /not sent to the model/);
});
