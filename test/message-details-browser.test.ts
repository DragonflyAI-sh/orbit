import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// The per-message Details footer in a real browser (Playwright's Chromium), for the Assistant and for Chat, against a
// scripted fake of ORBIT's routes: closed by default, opened with the keyboard (with a visible focus ring), revealing every
// piece of metadata given; each message's footer independent; an open footer (and an open nested pane) staying open while
// polls update the conversation; no footer where there is no metadata; proposal buttons, warnings and errors visible
// outside it; and long model ids and note paths wrapping on a phone-sized screen. Skipped, saying so, when Playwright cannot
// be loaded; message-details.test.ts covers the same rules against a fake DOM.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level Details footer checks skipped";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const avatar = readFileSync(new URL("../src/web/avatar.png", import.meta.url));
const T1 = "11111111-1111-4111-8111-111111111111";
const LONG_MODEL = `openrouter/${"very-long-provider-model-identifier-".repeat(4)}2026-11-01`;
const LONG_NOTE = `Projects/${"deeply-nested-folder-name/".repeat(6)}a-note-with-a-long-name.md`;
const call = (name: string) => ({ callId: name, name, arguments: "{}", ok: true, provenance: "live", source: "jobs", summary: `${name} done`, at: "t", outputChars: 12 });

const messages = (p: string) => [
  { id: `${p}u1`, role: "user", at: "2026-11-18T05:00:00Z", text: "launch it" },
  { id: `${p}a1`, role: "assistant", at: "2026-11-18T05:00:05Z", text: "Proposed below.", status: "done", provenance: "live", source: LONG_MODEL, memory: [LONG_NOTE],
    accounting: ["ledger write failed"], cards: [`${p}k1`], calls: [call("jobs_list"), call("job_launch")] },
  { id: `${p}a2`, role: "assistant", at: "2026-11-18T05:01:00Z", text: "Plain answer.", status: "done", provenance: "mock", source: "model/y", calls: [] },
  { id: `${p}a3`, role: "assistant", at: "2026-11-18T05:02:00Z", text: "", status: "error", error: "The model did not answer." },
  { id: `${p}u2`, role: "user", at: "2026-11-18T05:03:00Z", text: "and now?" },
  { id: `${p}a4`, role: "assistant", at: "2026-11-18T05:03:05Z", text: "", status: "pending", calls: [] },
];
const card = (p: string) => ({ id: `${p}k1`, kind: "job_launch", routine: "orbit", brief: "Do the thing.", state: "open", createdAt: "t", expiresAt: "2999-01-01T00:00:00Z", digest: "d".repeat(64), duplicates: [] });

let thread: Record<string, any>;
let assistant: Record<string, any>;
const reset = () => {
  thread = { id: T1, title: "Alpha", rev: 1, busy: true, archived: false, cards: [card("c")], messages: messages("c") };
  assistant = {
    session: { schema: 1, id: "assistant", createdAt: "2026-11-01T00:00:00Z" }, title: "Assistant", persisted: true, problems: [], busy: true, rev: 1, archivedChunks: 0,
    chunks: [{ seq: 1, id: "c1", createdAt: "2026-11-01T00:00:00Z", state: "open", cards: [card("a")], messages: messages("a"),
      context: { budgetChars: 52000, historyChars: 100, currentChars: 9, included: [], omitted: [] } }],
    next: { included: [{ seq: 1, form: "full", chars: 10 }], omitted: [], historyChars: 10 },
    budgets: { unit: "characters", activeChars: 32000, chunkMaxChars: 12000, contextChars: 52000, notesMaxChars: 12000 },
  };
};
reset();
// Changes the stored conversation of `surface` the way ORBIT would between two polls.
function edit(surface: "assistant" | "chat", fn: (msgs: any[]) => void) {
  if (surface === "chat") { fn(thread.messages); thread.rev++; } else { fn(assistant.chunks[0].messages); assistant.rev++; }
}

const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/" || url.pathname === "/sessions" || url.pathname.startsWith("/sessions/")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
  if (url.pathname === "/avatar.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(avatar); }
  if (url.pathname === "/status") return json(200, { ports: [{ port: "model", state: "live" }] });
  if (url.pathname === "/notifications") return json(200, { inbox: [] });
  if (url.pathname === "/model/login") return json(403, { error: "no" });
  if (url.pathname === "/chat/proposals") return json(200, { proposals: [] });
  if (url.pathname === "/jobs") return json(200, { jobs: [] });
  if (url.pathname === "/threads") return json(200, { threads: [{ id: T1, title: "Alpha", archived: false, rev: thread.rev, busy: thread.busy, openCards: 1, messageCount: thread.messages.length }], notice: null });
  if (url.pathname === `/threads/${T1}`) return json(200, { thread });
  if (url.pathname === "/assistant") return json(200, { assistant });
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

async function open(hash: string, viewport = { width: 1000, height: 900 }) {
  await context?.close();
  context = await browser.newContext({ viewport, locale: "en-US" });
  page = await context.newPage();
  await page.goto(`${base}${hash}`);
  const sel = hash.startsWith("#chat") ? "#log" : "#alog";
  await page.waitForFunction((s: string) => document.querySelectorAll(`${s} .msg`).length === 6, sel);
  return sel;
}
// Every message row's footer state: null where there is none, else whether it is open.
const footers = (sel: string) => page.$$eval(`${sel} .msg`, (ns: Element[]) => ns.map((n) => {
  const f = n.querySelector(":scope > details.mfoot") as HTMLDetailsElement | null;
  return f ? f.open : null;
}));
const foot = (sel: string, i: number) => `${sel} .msg:nth-child(${i + 1} of .msg) > details.mfoot`;
async function poll(surface: "assistant" | "chat") {
  if (surface === "assistant") await page.evaluate("aload(true)");
  else await page.evaluate(`loadThread(${JSON.stringify(T1)}, true)`);
}

for (const surface of ["assistant", "chat"] as const) {
  const hash = surface === "chat" ? `#chat/${T1}` : "#assistant";
  // The Assistant has always shown Resource usage for every finished reply, a failed one included, so its error row has a
  // footer too (the error itself stays outside it); in Chat a failed reply has no metadata, so no footer.
  const err: boolean | null = surface === "assistant" ? false : null;

  test(`browser (${surface}): footers are closed by default, only where there is metadata; actions, warnings and errors stay visible`, { skip }, async () => {
    reset();
    const sel = await open(hash);
    assert.deepEqual(await footers(sel), [null, false, false, err, null, null], "the replies with metadata get a closed footer; users and the pending reply get none");
    assert.equal(await page.isVisible(`${foot(sel, 1)} .tag`), false, "the metadata is hidden until opened");
    assert.equal(await page.textContent(`${foot(sel, 1)} > summary`), "Details");
    assert.equal(await page.$eval(`${sel} .proposal button:not(.cancel)`, (b: HTMLElement) => b.closest("details") === null && b.offsetParent !== null), true, "the confirmation is visible, never in the footer");
    assert.equal(await page.$eval(`${sel} .msg .warn`, (w: HTMLElement) => w.closest("details") === null && w.offsetParent !== null), true, "the spend warning is visible");
    assert.equal(await page.$eval(`${sel} .msg .tag.down`, (e: HTMLElement) => e.closest("details") === null && e.offsetParent !== null && /The model did not answer/.test(e.textContent!)), true, "the error is visible");
  });

  test(`browser (${surface}): the keyboard opens a footer, with a visible focus ring, revealing all the metadata; others stay closed`, { skip }, async () => {
    reset();
    const sel = await open(hash);
    await page.focus(`${foot(sel, 1)} > summary`);
    await page.keyboard.press("Enter");
    assert.deepEqual(await footers(sel), [null, true, false, err, null, null], "only that message's footer opened");
    const ring = await page.$eval(`${foot(sel, 1)} > summary`, (s: Element) => { const c = getComputedStyle(s); return [s.matches(":focus-visible"), c.outlineStyle, c.outlineWidth]; });
    assert.deepEqual(ring, [true, "solid", "2px"], "a visible focus ring");
    const text = await page.textContent(foot(sel, 1));
    assert.ok(text.includes(`live · ${LONG_MODEL} · memory: ${LONG_NOTE}`), "provenance, the model id and the note path, in full");
    assert.equal(await page.isVisible(`${foot(sel, 1)} .tag.live`), true);
    if (surface === "assistant") {
      const panes = await page.$$eval(`${foot(sel, 1)} details`, (ds: HTMLDetailsElement[]) => ds.map((d) => [d.className, d.open, d.querySelector("summary")!.textContent]));
      assert.deepEqual(panes, [["toolpane", false, "Tool output (2 calls)"], ["usagepane", false, "Resource usage"]], "the nested panes, closed, with their counts");
      await page.focus(`${foot(sel, 1)} details.usagepane > summary`);
      await page.keyboard.press(" ");
      assert.match(await page.textContent(`${foot(sel, 1)} details.usagepane`), /Vault notes read: Projects\/deeply-nested/);
      assert.match(await page.textContent(`${foot(sel, 1)} details.usagepane`), /Context sent: 109 of 52000 characters/);
    } else {
      assert.match(text, /Tool calls \(2\):✓ jobs_list/);
    }
    await page.keyboard.press("Tab");
    await page.focus(`${foot(sel, 1)} > summary`);
    await page.keyboard.press("Enter");
    assert.deepEqual(await footers(sel), [null, false, false, err, null, null], "Enter closes it again");
  });

  test(`browser (${surface}): an open footer and an open nested pane stay open while polls update the conversation`, { skip }, async () => {
    reset();
    const sel = await open(hash);
    await page.click(`${foot(sel, 1)} > summary`);
    if (surface === "assistant") await page.click(`${foot(sel, 1)} details.toolpane > summary`);
    const node = await page.$(foot(sel, 1));
    // The pending reply makes a tool call: its footer appears, closed; the reader opens it.
    edit(surface, (ms) => { ms[5].calls = [call("vault_read")]; });
    await poll(surface);
    await page.waitForSelector(foot(sel, 5), { state: "attached" });
    assert.deepEqual(await footers(sel), [null, true, false, err, null, false]);
    await page.click(`${foot(sel, 5)} > summary`);
    // The earlier reply gains a call (a stored edit), the pending one finishes.
    edit(surface, (ms) => {
      ms[1].calls = [...ms[1].calls, call("jobs_show")];
      Object.assign(ms[5], { status: "done", text: "Done.", provenance: "live", source: "model/z", calls: [call("vault_read"), call("jobs_list")] });
    });
    await poll(surface);
    await page.waitForFunction((s: string) => /model\/z/.test(document.querySelector(s)!.textContent!), foot(sel, 5));
    assert.deepEqual(await footers(sel), [null, true, false, err, null, true], "both opened footers stay open; the other stays closed");
    assert.equal(await node.evaluate((n: Element) => n.isConnected), true, "the footer kept its node");
    if (surface === "assistant") {
      assert.equal(await page.$eval(`${foot(sel, 1)} details.toolpane`, (d: HTMLDetailsElement) => d.open), true, "the open pane stays open");
      assert.equal(await page.textContent(`${foot(sel, 1)} details.toolpane > summary`), "Tool output (3 calls)", "with the new count");
    } else {
      assert.match(await page.textContent(foot(sel, 1)), /Tool calls \(3\):/);
    }
    // A reload draws everything again: closed, nothing remembered.
    await page.reload();
    await page.waitForFunction((s: string) => document.querySelectorAll(`${s} .msg`).length === 6, sel);
    assert.deepEqual(await footers(sel), [null, false, false, err, null, false]);
  });

  test(`browser (${surface}): on a phone, long model ids and note paths wrap inside the footer; nothing scrolls sideways`, { skip }, async () => {
    reset();
    const sel = await open(hash, { width: 360, height: 780 });
    await page.click(`${foot(sel, 1)} > summary`);
    if (surface === "assistant") { await page.click(`${foot(sel, 1)} details.toolpane > summary`); await page.click(`${foot(sel, 1)} details.usagepane > summary`); }
    const geo = await page.$eval(foot(sel, 1), (f: HTMLElement) => {
      const msg = f.closest(".msg")!.getBoundingClientRect();
      const tooWide = [f, ...f.querySelectorAll("*")].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right > msg.right + 0.5 || n.scrollWidth > n.clientWidth + 1); }).map((n) => n.className || n.tagName);
      const tag = f.querySelector(".tag")!.getBoundingClientRect();
      return { tooWide, tagLines: Math.round(tag.height / parseFloat(getComputedStyle(f.querySelector(".tag")!).lineHeight || "14")) };
    });
    assert.deepEqual(geo.tooWide, [], "nothing in the footer is wider than the message");
    assert.ok(geo.tagLines > 1, "the long tag wraps onto several lines");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no sideways page scroll");
    assert.equal(await page.$eval(sel, (l: HTMLElement) => l.scrollWidth <= l.clientWidth), true, "no sideways scroll in the conversation");
  });
}
