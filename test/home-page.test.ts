import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { planOverview } from "../src/plan.ts";
import { sidebarView } from "../src/sidebar.ts";
import { SIDEBAR_NOTES, PLAN_NOW } from "./helpers/shell-fixture.ts";
import { isPagePath } from "./helpers/sessions-ui.ts";
import { serveWebAsset } from "./helpers/web-assets.ts";

// Home (docs/home.md): the landing view, a simplified presentation of the Assistant's one persistent conversation. The pure
// helpers (routing, which message Home shows, the Conversation state region) are loaded from the page and always run; the page
// itself runs in Playwright's Chromium against a scripted fake of ORBIT's routes, and is skipped, saying so, without Playwright.
// Synthetic data only. What this does not cover (real iPhone Safari, a real model streaming) is listed in docs/home.md.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))![1]!;

// ---- pure helpers -----------------------------------------------------------------------------------------------------

const { pageFor, canonicalAddress } = new Function(`${block("routing")}; return { pageFor, canonicalAddress };`)() as {
  pageFor: (path: string, hash: string, jobs: boolean, assistant: boolean) => string;
  canonicalAddress: (path: string, search: string, hash: string) => string | null;
};
const { homeLatest } = new Function(`${block("home-latest")}; return { homeLatest };`)() as { homeLatest: (chunks: unknown[], busy: boolean) => { kind: string; id?: string } };
const { conversationState } = new Function(`${block("conversation-state")}; return { conversationState };`)() as { conversationState: (mk: unknown, items: unknown) => Node };

test("routing: the root and unknown fragments open Home; #home is Home; #assistant and every other page keep their address", () => {
  assert.equal(pageFor("/", "", true, true), "home");
  assert.equal(pageFor("/", "#home", true, true), "home");
  assert.equal(pageFor("/", "#nothing-here", true, true), "home");
  assert.equal(pageFor("/", "#assistant", true, true), "assistant");
  assert.equal(pageFor("/", "#jobs", true, true), "jobs");
  assert.equal(pageFor("/", "#jobs/orbit-1", true, true), "jobs");
  assert.equal(pageFor("/", "#plan", true, true), "plan");
  assert.equal(pageFor("/", "#gallery", true, true), "gallery");
  assert.equal(pageFor("/sessions", "", true, true), "chat");
  assert.equal(pageFor("/sessions/x", "", true, true), "chat");
  assert.equal(pageFor("/", "#chat", true, true), "chat");
  assert.equal(pageFor("/sessions/x", "#home", true, true), "home", "a fragment link to Home wins over the path");
  assert.equal(pageFor("/", "#jobs", false, true), "home", "Jobs not known yet: the default page, now Home");
  // Not the owner: Home shows the Assistant's conversation, so it falls back to Sessions like the Assistant does.
  assert.equal(pageFor("/", "", true, false), "chat");
  assert.equal(pageFor("/", "#home", true, false), "chat");
  assert.equal(pageFor("/", "#assistant", false, false), "chat");
  // #home under /sessions moves to /, where the page lives; the root itself is already canonical.
  assert.equal(canonicalAddress("/sessions", "", "#home"), "/#home");
  assert.equal(canonicalAddress("/sessions/x", "?q=1", "#home"), "/?q=1#home");
  assert.equal(canonicalAddress("/", "", ""), null);
  assert.equal(canonicalAddress("/", "", "#home"), null);
  assert.equal(canonicalAddress("/sessions", "", "#assistant"), "/#assistant");
});

test("markup: Home is first in the page links, right before Assistant, and is the page marked current before any script runs", () => {
  const nav = html.match(/<nav id="tabs"[^>]*>([\s\S]*?)<\/nav>/)![1]!;
  const links = [...nav.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1]!, label: m[2]!.replace(/<[^>]+>/g, "").trim().split(/\s/)[0] }));
  assert.deepEqual(links.map((l) => l.label), ["Home", "Assistant", "Jobs", "Sessions"]);
  assert.match(links[0]!.attrs, /href="\/"/);
  assert.match(links[0]!.attrs, /data-tab="home"/);
  assert.match(links[0]!.attrs, /aria-current="page"/);
  assert.doesNotMatch(links[1]!.attrs, /aria-current/);
  assert.match(links[1]!.attrs, /href="\/#assistant"/, "the Assistant keeps its explicit address");
  // One composer for both views: no second form, input or send button was added for Home.
  assert.equal((html.match(/<form id="aform">/g) || []).length, 1);
  assert.equal((html.match(/<textarea id="ainput"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="hlog"|id="hform"|id="hinput"/);
});

test("homeLatest: the newest stored message when it is the Assistant's; otherwise why Home has no reply to show", () => {
  const c = (seq: number, ...messages: unknown[]) => ({ seq, messages });
  const u = (id: string) => ({ id, role: "user", text: "q" });
  const a = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "assistant", text: "r", status: "done", ...extra });
  assert.deepEqual(homeLatest([], false), { kind: "empty" });
  assert.deepEqual(homeLatest([c(1)], false), { kind: "empty" });
  assert.deepEqual(homeLatest([c(1, u("u1"), a("a1"))], false), { kind: "reply", id: "a1" });
  assert.deepEqual(homeLatest([c(1, u("u1"), a("a1")), c(2, u("u2"), a("a2"))], false), { kind: "reply", id: "a2" }, "the newest chunk wins");
  assert.deepEqual(homeLatest([c(1, u("u1"), a("a1")), c(2, u("u2"), a("p2", { status: "pending", text: "" }))], true), { kind: "reply", id: "p2" }, "a reply being written is the newest reply");
  assert.deepEqual(homeLatest([c(1, u("u1"), a("e1", { status: "error", error: "x" }))], false), { kind: "reply", id: "e1" }, "a failed reply is shown, not hidden");
  // A user message after the last reply: the older reply is never shown as if it answered it.
  assert.deepEqual(homeLatest([c(1, u("u1"), a("a1"), u("u2"))], true), { kind: "waiting" });
  assert.deepEqual(homeLatest([c(1, u("u1"), a("a1"), u("u2"))], false), { kind: "unanswered" });
});

// A minimal element stand-in, enough for conversationState: the tag, the properties it was made with, and its children.
type Fake = { tag: string; props: Record<string, unknown>; kids: (Fake | string)[]; classList: { add: (c: string) => void }; append: (...k: (Fake | string)[]) => void };
const mk = (tag: string, props: Record<string, unknown> = {}, ...kids: (Fake | string)[]): Fake => {
  const n: Fake = { tag, props: { ...props }, kids: [...kids], classList: { add: (c) => { n.props.className = `${n.props.className ?? ""} ${c}`.trim(); } }, append: (...k) => { n.kids.push(...k); } };
  return n;
};
const texts = (n: Fake | string): string[] => (typeof n === "string" ? [n] : [...(typeof n.props.textContent === "string" ? [n.props.textContent] : []), ...n.kids.flatMap(texts)]);
const find = (n: Fake | string, tag: string): Fake[] => (typeof n === "string" ? [] : [...(n.tag === tag ? [n] : []), ...n.kids.flatMap((k) => find(k, tag))]);

test("conversationState: an unobtrusive empty state with nothing to show; no sample data; items are text, links stay on this page", () => {
  for (const items of [undefined, null, [], "x", [null, { kind: "image" }, { kind: "image", label: "  " }, { kind: "made-up", label: "x" }]]) {
    const box = conversationState(mk, items) as unknown as Fake;
    assert.equal(box.tag, "section");
    assert.equal(box.props.ariaLabel, "Conversation state");
    assert.deepEqual(texts(box), ["Conversation state", "Nothing to show yet."], JSON.stringify(items));
    assert.equal(find(box, "ul").length, 0);
  }
  const box = conversationState(mk, [
    { kind: "image", label: "Garden photo", href: "/#gallery" },
    { kind: "file", label: "Plan note", href: "#plan/alpha" },
    { kind: "next", label: "Order the seeds" },
    { kind: "link", label: "Elsewhere", href: "https://example.com/x" },
    { kind: "link", label: "Protocol-relative", href: "//example.com/x" },
    { kind: "link", label: "Script", href: "javascript:alert(1)" },
    { kind: "timeline", label: "<b>not markup</b>" },
  ]) as unknown as Fake;
  const li = find(box, "li");
  assert.equal(li.length, 7);
  assert.deepEqual(li.map((l) => l.props.className), ["cstate-image", "cstate-file", "cstate-next", "cstate-link", "cstate-link", "cstate-link", "cstate-timeline"]);
  assert.deepEqual(find(box, "a").map((a) => [a.props.href, a.props.textContent]), [["/#gallery", "Garden photo"], ["#plan/alpha", "Plan note"]], "only same-page links are links");
  assert.ok(texts(box).includes("Elsewhere") && texts(box).includes("Script"), "an unsafe link keeps its label as plain text");
  assert.ok(texts(box).includes("<b>not markup</b>"), "labels are text, never parsed");
  assert.ok(!texts(box).includes("Nothing to show yet."));
});

// ---- the page in a real browser ---------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level Home checks skipped";

const avatar = readFileSync(new URL("../src/web/avatar.png", import.meta.url));
const REF = "ph_" + "e".repeat(32);
const AT = "2026-11-20T10:00:00Z";
type Msg = Record<string, any>;

// The fake ORBIT: one Assistant conversation held in memory, as the server holds it. A send stores the prompt and a pending
// reply at once (as src/assistant-store.ts does), answers when `gate` lets it, and every answer carries a growing rev.
let owner = true;
let messages: Msg[] = [];
let cards: Msg[] = [];
let busy = false;
let rev = 1;
let archived = 0;
let posts: { text: string; requestId: string }[] = [];
let confirms = 0;
let gate: Promise<void> | null = null;
let release: () => void = () => {};
let failNext: { code: number; error: string } | null = null;
let replyExtra: (n: number) => Msg = () => ({});
let projectReads: string[] = [];

const view = () => ({
  session: { schema: 1, id: "assistant", createdAt: AT }, title: "Assistant", persisted: true, problems: [], busy, rev, archivedChunks: archived,
  chunks: messages.length ? [{ seq: 1, id: "c1", createdAt: AT, state: "open", cards, messages }] : [],
  next: { included: messages.length ? [{ seq: 1, form: "full", chars: 10 }] : [], omitted: [], historyChars: 10 },
  budgets: { unit: "characters", activeChars: 32000, chunkMaxChars: 12000, contextChars: 52000, notesMaxChars: 12000 },
});
function hold() { gate = new Promise<void>((r) => { release = () => { gate = null; r(); }; }); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const p = url.pathname;
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const read = () => new Promise<any>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
  if (isPagePath(p)) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (serveWebAsset(p, res)) return;
  for (const f of ["gallery.js", "photos.js", "files.js"]) if (p === `/${f}`) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(readFileSync(new URL(`../src/web/${f}`, import.meta.url))); }
  if (p === "/avatar.png" || p === `/assistant/photos/${REF}`) { res.writeHead(200, { "content-type": "image/png" }); return res.end(avatar); }
  if (p === "/status") return json(200, { ports: [{ port: "model", state: "live" }] });
  if (p === "/notifications") return json(200, { inbox: [] });
  if (p === "/model/login") return json(403, { error: "no" });
  if (p === "/sidebar") {
    const project = url.searchParams.get("project") || undefined;
    projectReads.push(project ?? "");
    return json(200, { ...sidebarView(SIDEBAR_NOTES, [], project), overview: planOverview(SIDEBAR_NOTES, PLAN_NOW), vault: { ok: true, source: "memory/vault@fixture" } });
  }
  if (!owner && (p.startsWith("/assistant") || p.startsWith("/chat/proposals") || p === "/jobs" || p === "/threads" || p === "/tasks/attention")) return json(403, { error: "owner only" });
  if (p === "/chat/proposals" && req.method === "GET") return json(200, { proposals: [] });
  if (p === "/jobs") return json(200, { jobs: [] });
  if (p === "/threads") return json(200, { threads: [], notice: null });
  if (p === "/tasks/attention") return json(404, { error: "none" });
  if (p === "/assistant") return json(200, { assistant: view() });
  if (p === "/assistant/messages" && req.method === "POST") {
    const body = await read();
    posts.push({ text: body.text, requestId: body.requestId });
    if (failNext) { const f = failNext; failNext = null; return json(f.code, { error: f.error, assistant: view() }); }
    const n = posts.length;
    messages.push({ id: `u${n}`, role: "user", at: AT, text: body.text });
    if (gate) {
      // The reply is being written: stored as pending, the conversation busy, until the test lets it finish.
      messages.push({ id: `a${n}`, role: "assistant", at: AT, text: "", status: "pending", calls: [] });
      busy = true; rev++;
      await gate;
      messages.pop();
    }
    messages.push({ id: `a${n}`, role: "assistant", at: AT, text: `Reply number ${n} to: ${body.text}`, status: "done", provenance: "live", source: "model/fake", ...replyExtra(n) });
    busy = false; rev++;
    return json(200, { assistant: view() });
  }
  const c = p.match(/^\/chat\/proposals\/([\w-]+)\/confirm$/);
  if (c && req.method === "POST") { confirms++; cards = cards.map((k) => (k.id === c[1] ? { ...k, state: "confirmed", job: "orbit-job-9" } : k)); rev++; return json(202, { id: "orbit-job-9" }); }
  json(404, { error: "not found" });
});

let browser: any, page: any, base = "", problems: string[] = [];
before(async () => {
  if (skip) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); server.close(); });

function reset() {
  owner = true; messages = []; cards = []; busy = false; rev = 1; archived = 0; posts = []; confirms = 0; gate = null; failNext = null; replyExtra = () => ({}); projectReads = [];
}
async function open(path = "/", viewport = { width: 1100, height: 760 }) {
  await page?.close();
  problems = [];
  page = await browser.newPage({ viewport });
  page.on("pageerror", (e: Error) => problems.push(e.message));
  await page.goto(`${base}${path}`);
  await page.waitForFunction(() => document.readyState === "complete");
}
// What is visible: the page, the address, the conversation's visible text, the messages a reader can see, and the status line.
const seen = () => page.evaluate(() => {
  const alog = document.getElementById("alog")!;
  const vis = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).display !== "none" && (e as HTMLElement).getClientRects().length > 0;
  const msgs = [...alog.querySelectorAll(":scope > .msg")].filter(vis);
  return {
    tab: document.body.dataset.tab,
    path: location.pathname + location.search + location.hash,
    current: document.querySelector("#tabs a[aria-current=page]")?.getAttribute("data-tab") ?? null,
    text: alog.hidden ? null : alog.innerText,
    visible: msgs.map((m) => `${m.classList.contains("user") ? "user" : "orbit"}: ${(m.querySelector(".body, .md") as HTMLElement | null)?.innerText.trim() ?? m.textContent!.trim()}`),
    latest: alog.querySelectorAll(":scope > [data-latest]").length,
    status: document.getElementById("astatus")!.textContent,
    sendDisabled: (document.getElementById("asend") as HTMLButtonElement).disabled,
  };
});
const send = async (text: string) => { await page.fill("#ainput", text); await page.click("#asend"); };
const until = (fn: string, arg?: unknown) => page.waitForFunction(fn, arg, { timeout: 5000 });

test("browser: ORBIT opens on Home (menu: Home, Assistant, Jobs, Sessions) and the Assistant keeps its own address", { skip }, async () => {
  reset();
  messages = [{ id: "u0", role: "user", at: AT, text: "Earlier question" }, { id: "a0", role: "assistant", at: AT, text: "Earlier answer", status: "done" }];
  await open("/");
  await until(`document.querySelector("#alog [data-latest]")`);
  const s = await seen();
  assert.equal(s.tab, "home");
  assert.equal(s.current, "home");
  assert.equal(s.path, "/", "the root stays the root");
  assert.deepEqual(await page.$$eval("#tabs a:not([hidden])", (as: HTMLAnchorElement[]) => as.map((a) => a.textContent!.trim().split(/\s/)[0])), ["Home", "Assistant", "Jobs", "Sessions"]);
  assert.deepEqual(s.visible, ["orbit: Earlier answer"], "Home shows only the newest reply, no user bubble");
  assert.match(s.text!, /Conversation state\s+Nothing to show yet\./);
  assert.equal(await page.getAttribute("#alog", "aria-label"), "Latest Assistant reply");
  assert.equal(await page.isVisible("#aform"), true);
  assert.equal(await page.isVisible("#sesswrap"), false);
  // An explicit #home is Home too.
  await open("/#home");
  await until(`document.querySelector("#alog [data-latest]")`);
  assert.equal((await seen()).tab, "home");
  assert.deepEqual(problems, []);
});

test("browser: deep links, reload and Back/Forward between Home, Assistant, Jobs and Sessions", { skip }, async () => {
  reset();
  messages = [{ id: "u0", role: "user", at: AT, text: "Earlier question" }, { id: "a0", role: "assistant", at: AT, text: "Earlier answer", status: "done" }];
  for (const [path, tab] of [["/#assistant", "assistant"], ["/#jobs", "jobs"], ["/sessions", "chat"], ["/#chat", "chat"], ["/sessions#home", "home"], ["/#gallery", "gallery"], ["/#plan", "plan"]] as const) {
    await open(path);
    await until(`document.body.dataset.tab === ${JSON.stringify(tab)}`);
    if (tab === "assistant") {
      await until(`document.querySelectorAll("#alog > .msg").length === 2`);
      assert.deepEqual((await seen()).visible, ["user: Earlier question", "orbit: Earlier answer"], "a deep link to the Assistant shows the whole transcript");
      assert.equal((await seen()).current, "assistant");
    }
    if (path === "/#chat") assert.equal((await seen()).path, "/sessions", "the legacy address is still replaced");
    if (path === "/sessions#home") assert.equal((await seen()).path, "/#home", "#home under /sessions moves to /");
    await page.reload();
    await until(`document.body.dataset.tab === ${JSON.stringify(tab)}`);
  }
  // In-page navigation with Back and Forward.
  await open("/");
  await until(`document.querySelector("#alog [data-latest]")`);
  await page.click("#assistanttab");
  await until(`document.body.dataset.tab === "assistant"`);
  assert.equal((await seen()).path, "/#assistant");
  await page.click("#jobstab");
  await until(`document.body.dataset.tab === "jobs"`);
  await page.click("#hometab");
  await until(`document.body.dataset.tab === "home"`);
  assert.equal((await seen()).path, "/");
  await page.goBack();
  await until(`document.body.dataset.tab === "jobs"`);
  await page.goBack();
  await until(`document.body.dataset.tab === "assistant"`);
  assert.equal((await seen()).visible.length, 2);
  await page.goBack();
  await until(`document.body.dataset.tab === "home"`);
  assert.deepEqual((await seen()).visible, ["orbit: Earlier answer"]);
  await page.goForward();
  await until(`document.body.dataset.tab === "assistant"`);
  // The logo still reloads the page the reader is on.
  await Promise.all([page.waitForNavigation(), page.click("#brandbtn")]);
  await until(`document.body.dataset.tab === "assistant"`);
  assert.equal((await seen()).path, "/#assistant");
  assert.deepEqual(problems, []);
});

test("browser: Home and the Assistant are one conversation: consecutive sends from Home show only the newest reply; the Assistant keeps every turn, also after a reload", { skip }, async () => {
  reset();
  await open("/");
  await until(`document.querySelector("#alog .homeidle")`);
  assert.match((await seen()).text!, /No reply yet\. Send a message to start\./);
  await send("first question");
  await until(`document.querySelector("#alog [data-latest]")?.innerText.includes("Reply number 1")`);
  assert.deepEqual((await seen()).visible, ["orbit: Reply number 1 to: first question"]);
  await send("second question");
  await until(`document.querySelector("#alog [data-latest]")?.innerText.includes("Reply number 2")`);
  let s = await seen();
  assert.deepEqual(s.visible, ["orbit: Reply number 2 to: second question"], "only the newest reply; no earlier reply, no user bubble");
  assert.equal(s.latest, 1);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0]!.requestId, posts[1]!.requestId);
  // The same conversation in the Assistant: both prompts sent from Home and both replies, in order.
  await page.click("#assistanttab");
  await until(`document.body.dataset.tab === "assistant"`);
  assert.deepEqual((await seen()).visible, ["user: first question", "orbit: Reply number 1 to: first question", "user: second question", "orbit: Reply number 2 to: second question"]);
  // A reload of either view reads the same stored conversation.
  await open("/");
  await until(`document.querySelector("#alog [data-latest]")`);
  assert.deepEqual((await seen()).visible, ["orbit: Reply number 2 to: second question"]);
  await open("/#assistant");
  await until(`document.querySelectorAll("#alog > .msg").length === 4`);
  // A send from the Assistant is Home's newest reply too.
  await send("third, from the Assistant");
  await until(`document.querySelectorAll("#alog > .msg").length === 6`);
  await page.click("#hometab");
  await until(`document.body.dataset.tab === "home"`);
  assert.deepEqual((await seen()).visible, ["orbit: Reply number 3 to: third, from the Assistant"]);
  assert.equal(posts.length, 3);
  assert.deepEqual(problems, []);
});

test("browser: a turn in flight survives switching between Home and the Assistant: one send, no duplicate, its result shown in both", { skip }, async () => {
  reset();
  messages = [{ id: "u0", role: "user", at: AT, text: "Earlier question" }, { id: "a0", role: "assistant", at: AT, text: "Earlier answer", status: "done" }];
  await open("/");
  await until(`document.querySelector("#alog [data-latest]")`);
  hold();
  await send("slow question");
  await until(`document.querySelector("#alog [data-latest]")?.innerText.includes("Working…")`);
  let s = await seen();
  assert.deepEqual(s.visible, ["orbit: Working…"], "Home shows the reply being written, not the previous one");
  assert.equal(s.status, "Waiting for the reply…");
  assert.equal(s.sendDisabled, true);
  // To the Assistant and back while the reply is written: the same bubbles, no request repeated.
  await page.click("#assistanttab");
  await until(`document.body.dataset.tab === "assistant"`);
  s = await seen();
  assert.deepEqual(s.visible, ["user: Earlier question", "orbit: Earlier answer", "user: slow question", "orbit: Working…"]);
  await page.click("#hometab");
  await until(`document.body.dataset.tab === "home"`);
  assert.deepEqual((await seen()).visible, ["orbit: Working…"]);
  // A second attempt while it waits (Enter, the button) sends nothing.
  await page.fill("#ainput", "again");
  await page.press("#ainput", "Enter");
  await page.evaluate(() => (document.getElementById("aform") as HTMLFormElement).requestSubmit());
  await page.waitForTimeout(200);
  assert.equal(posts.length, 1);
  await page.click("#assistanttab");
  release();
  await until(`[...document.querySelectorAll("#alog > .msg")].some((m) => m.innerText.includes("Reply number 1 to: slow question"))`);
  s = await seen();
  assert.deepEqual(s.visible, ["user: Earlier question", "orbit: Earlier answer", "user: slow question", "orbit: Reply number 1 to: slow question"], "exactly one copy of the turn");
  await page.click("#hometab");
  await until(`document.body.dataset.tab === "home"`);
  s = await seen();
  assert.deepEqual(s.visible, ["orbit: Reply number 1 to: slow question"]);
  assert.equal(s.status, "");
  assert.equal(posts.length, 1);
  assert.equal(await page.inputValue("#ainput"), "again", "the draft typed while waiting is kept");
  assert.deepEqual(problems, []);
});

test("browser: a reply in progress from another device, and errors, show plainly on Home without a duplicate send", { skip }, async () => {
  reset();
  messages = [{ id: "u0", role: "user", at: AT, text: "Earlier question" }, { id: "a0", role: "assistant", at: AT, text: "Earlier answer", status: "done" },
    { id: "u1", role: "user", at: AT, text: "From the phone" }, { id: "a1", role: "assistant", at: AT, text: "", status: "pending", calls: [] }];
  busy = true;
  await open("/");
  await until(`document.querySelector("#alog [data-latest]")`);
  let s = await seen();
  assert.deepEqual(s.visible, ["orbit: Working…"], "the pending reply from the other device is the newest reply");
  assert.match(s.status, /A reply is in progress on another tab or device/);
  assert.equal(s.sendDisabled, true);
  // A prompt stored with no reply yet: a note, never the older reply.
  messages.pop(); rev++;
  await open("/");
  await until(`document.querySelector("#alog .homeidle")`);
  s = await seen();
  assert.deepEqual(s.visible, []);
  assert.match(s.text!, /A reply is in progress\. It shows here as soon as ORBIT has it\./);
  // An error answer: said in the status line (an alert), the text goes back in the box for a refused send, nothing repeated.
  messages = [{ id: "u0", role: "user", at: AT, text: "Earlier question" }, { id: "a0", role: "assistant", at: AT, text: "Earlier answer", status: "done" }];
  busy = false; rev++;
  await open("/");
  await until(`document.querySelector("#alog [data-latest]")`);
  failNext = { code: 409, error: "The Assistant is busy with another reply." };
  await send("refused one");
  await until(`document.getElementById("astatus").classList.contains("bad")`);
  s = await seen();
  assert.equal(s.status, "The Assistant is busy with another reply.");
  assert.equal(await page.getAttribute("#astatus", "role"), "alert");
  assert.deepEqual(s.visible, ["orbit: Earlier answer"], "the failed send's bubbles are gone; the stored newest reply shows");
  assert.equal(await page.inputValue("#ainput"), "refused one");
  assert.equal(posts.length, 1);
  assert.deepEqual(problems, []);
});

test("browser: the newest reply's confirmation card and photo gallery work on Home, once, and are the same ones the Assistant shows", { skip }, async () => {
  reset();
  replyExtra = (n) => ({ cards: [`k${n}`], galleries: [{ items: [{ ref: REF, status: "ok", position: 1, caption: "Synthetic garden photo", link: "#assistant" }] }] });
  await open("/");
  await until(`document.querySelector("#alog .homeidle")`);
  // The card the reply proposes is stored with the chunk, as ORBIT stores it.
  cards = [{ id: "k1", kind: "job_launch", routine: "orbit", brief: "Synthetic brief for the Home test.", state: "open", digest: "d".repeat(64), duplicates: [] }];
  await send("show me the garden and propose a job");
  await until(`document.querySelector("#alog [data-latest] .proposal button")`);
  const counts = () => page.evaluate(() => ({
    confirm: [...document.querySelectorAll("#alog button")].filter((b) => b.textContent === "Confirm" && (b as HTMLElement).getClientRects().length).length,
    inDom: document.querySelectorAll("#alog .proposal").length,
    galleries: [...document.querySelectorAll("#alog .gallery")].filter((g) => (g as HTMLElement).getClientRects().length).length,
    imgs: [...document.querySelectorAll("#alog .gallery img")].filter((g) => (g as HTMLElement).getClientRects().length).length,
  }));
  assert.deepEqual(await counts(), { confirm: 1, inDom: 1, galleries: 1, imgs: 1 });
  await page.click("#assistanttab");
  await until(`document.body.dataset.tab === "assistant"`);
  assert.deepEqual(await counts(), { confirm: 1, inDom: 1, galleries: 1, imgs: 1 }, "the Assistant shows the same card and gallery, not a copy");
  await page.click("#hometab");
  await until(`document.body.dataset.tab === "home"`);
  await page.click("#alog [data-latest] .proposal button:text-is('Confirm')");
  await until(`!document.querySelector("#alog .proposal button:not(:disabled)")`);
  await page.waitForTimeout(200);
  assert.equal(confirms, 1, "one click, one confirmation");
  assert.equal(posts.length, 1);
  assert.deepEqual(problems, []);
});

test("browser: the sidebar and project selection are the same on Home and the Assistant, at desktop and phone widths", { skip }, async () => {
  reset();
  messages = [{ id: "u0", role: "user", at: AT, text: "Earlier question" }, { id: "a0", role: "assistant", at: AT, text: "Earlier answer", status: "done" }];
  await open("/");
  await until(`document.querySelectorAll("#navproject option").length > 1`);
  const value = await page.$eval("#navproject option:nth-child(2)", (o: HTMLOptionElement) => o.value);
  await page.selectOption("#navproject", value);
  await until(`document.getElementById("navproject").value === ${JSON.stringify(value)}`);
  const side = () => page.evaluate(() => ({ project: (document.getElementById("navproject") as HTMLSelectElement).value, nav: document.getElementById("nav")!.getClientRects().length > 0, files: document.getElementById("navfiles")!.innerText }));
  const onHome = await side();
  await page.click("#assistanttab");
  await until(`document.body.dataset.tab === "assistant"`);
  assert.deepEqual(await side(), onHome, "same project, same sidebar, same content");
  await page.click("#hometab");
  await until(`document.body.dataset.tab === "home"`);
  assert.deepEqual(await side(), onHome);
  // Narrow screen: the sidebar is a dialog behind the menu button on both views; Home fits the width and keeps the composer.
  for (const path of ["/", "/#assistant"]) {
    await open(path, { width: 320, height: 568 });
    await until(`document.querySelector("#alog > .msg")`);
    const narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, composer: (document.getElementById("aform") as HTMLElement).getBoundingClientRect().bottom <= innerHeight + 1, nav: document.getElementById("nav")!.getAttribute("role") }));
    assert.equal(narrow.overflow, 0, `${path}: nothing scrolls sideways`);
    assert.equal(narrow.composer, true, `${path}: the composer is on screen`);
    await page.click("#navbtn");
    await until(`document.getElementById("nav").getAttribute("role") === "dialog"`);
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(problems, []);
});

test("browser: the Assistant's scroll position is kept across a visit to Home", { skip }, async () => {
  reset();
  for (let i = 0; i < 30; i++) messages.push({ id: `u${i}`, role: "user", at: AT, text: `Question ${i}` }, { id: `a${i}`, role: "assistant", at: AT, text: `Answer ${i}. ${"Long text. ".repeat(20)}`, status: "done" });
  await open("/#assistant", { width: 900, height: 600 });
  await until(`document.querySelectorAll("#alog > .msg").length === 60`);
  await page.evaluate(() => { document.getElementById("alog")!.scrollTop = 200; });
  await page.waitForTimeout(100);
  await page.click("#hometab");
  await until(`document.body.dataset.tab === "home"`);
  assert.deepEqual((await seen()).visible, [`orbit: Answer 29. ${"Long text. ".repeat(20).trim()}`]);
  await page.click("#assistanttab");
  await until(`document.body.dataset.tab === "assistant"`);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.getElementById("alog")!.scrollTop), 200);
  assert.deepEqual(problems, []);
});

test("browser: a viewer who is not the owner gets no Home or Assistant link and lands on Sessions", { skip }, async () => {
  reset();
  owner = false;
  await open("/");
  await until(`document.body.dataset.tab === "chat" && document.getElementById("hometab").hidden`);
  assert.equal(await page.isVisible("#hometab"), false);
  assert.equal(await page.isVisible("#assistanttab"), false);
  assert.equal(await page.isVisible("#alog"), false);
  assert.equal(posts.length, 0);
});
