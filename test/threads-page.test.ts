import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const grab = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";

// A tiny DOM: text can only arrive as a string child or textContent, and any attempt to parse HTML throws.
class Fake {
  tag: string;
  kids: (Fake | string)[] = [];
  props: Record<string, unknown> = {};
  constructor(tag: string, props: Record<string, unknown> = {}) {
    this.tag = tag;
    for (const [k, v] of Object.entries(props)) {
      if (/^(innerHTML|outerHTML)$/.test(k)) throw new Error(`${k} must never be set`);
      if (k === "textContent") this.kids.push(String(v));
      else this.props[k] = v;
    }
  }
  append(...k: (Fake | string)[]) {
    this.kids.push(...k);
  }
  text(): string {
    return this.kids.map((k) => (typeof k === "string" ? k : k.text())).join("");
  }
  all(): Fake[] {
    return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.all()))];
  }
}
const mk = (tag: string, props?: Record<string, unknown>, ...kids: (Fake | string)[]) => {
  const f = new Fake(tag, props);
  f.append(...kids);
  return f;
};

type Mk = (tag: string, props?: Record<string, unknown>, ...kids: (Fake | string)[]) => Fake;
const lib = new Function(`${grab("notes")}; ${grab("markdown")}; ${grab("threads")}; return { linkify, threadOption, cardTitle, cardStateNodes, compactionNode, renderStoredMessage };`)() as {
  linkify: (t: string, m: Mk) => (Fake | string)[];
  threadOption: (t: unknown) => string;
  cardTitle: (c: unknown) => string[];
  cardStateNodes: (c: unknown, m: Mk) => Fake[];
  compactionNode: (v: unknown, m: Mk) => Fake;
  renderStoredMessage: (m: unknown, mk: Mk, card?: (id: string) => Fake | null) => Fake;
};

test("stored text is rendered as text: markup stays literal, only https links become anchors", () => {
  const hostile = `<img src=x onerror=alert(1)> <script>boom()</script> see https://claude.ai/code/x and javascript:alert(1) and http://plain.example`;
  const node = lib.renderStoredMessage({ id: "1", role: "assistant", at: "t", text: hostile, status: "done", provenance: "live", source: "model/x", memory: ["<b>note</b>.md"] }, mk);
  assert.equal(node.text().includes("<img src=x onerror=alert(1)>"), true, "markup is shown literally");
  assert.equal(node.all().filter((n) => ["img", "script", "b"].includes(n.tag)).length, 0, "no element is ever created from stored text");
  const anchors = node.all().filter((n) => n.tag === "a");
  assert.deepEqual(anchors.map((a) => a.props.href), ["https://claude.ai/code/x"]);
  assert.equal(anchors[0]!.props.rel, "noopener noreferrer");
  assert.ok(node.text().includes("<b>note</b>.md"));
});

test("tool calls, errors and pending replies render through text only", () => {
  const calls = [{ name: "jobs_list", arguments: "{\"q\":\"<i>\"}", ok: true, provenance: "live", source: "jobs", summary: "<u>total</u> 3" }];
  const done = lib.renderStoredMessage({ id: "1", role: "assistant", at: "t", text: "ok", status: "done", provenance: "live", source: "s", calls }, mk);
  assert.match(done.text(), /✓ jobs_list\(\{"q":"<i>"\}\) \[live · jobs\] <u>total<\/u> 3/);
  assert.equal(done.all().filter((n) => ["i", "u"].includes(n.tag)).length, 0);
  assert.match(lib.renderStoredMessage({ id: "2", role: "assistant", at: "t", text: "", status: "pending" }, mk).text(), /Working/);
  const failed = lib.renderStoredMessage({ id: "3", role: "assistant", at: "t", text: "", status: "error", error: "The model call failed: HTTP 500" }, mk);
  assert.match(failed.text(), /error: The model call failed: HTTP 500/);
  const user = lib.renderStoredMessage({ id: "4", role: "user", at: "t", text: "hi" }, mk);
  assert.match(String(user.props.className), /user/);
});

test("a confirmed card shows the job id and the record's state, never a bare success; a confirmed card with no id says so", () => {
  const card = { id: "c", kind: "job_launch", state: "confirmed", outcome: { jobId: "orbit-2026-abcd" }, live: { source: "jobs", found: true, state: "running", health: "ok" } };
  const text = lib.cardStateNodes(card, mk).map((n) => n.text()).join("\n");
  assert.match(text, /Job orbit-2026-abcd/);
  assert.match(text, /Record now \(jobs\): running · ok/);
  assert.doesNotMatch(text, /\bdone\b|succeeded|completed/i);
  const lost = lib.cardStateNodes({ id: "c", kind: "job_launch", state: "confirmed" }, mk).map((n) => n.text()).join("\n");
  assert.match(lost, /no job or operation id was recorded/);
  assert.match(lost, /do not assume it ran/);
  const missing = lib.cardStateNodes({ id: "c", kind: "job_launch", state: "confirmed", outcome: { jobId: "x" }, live: { source: "jobs", found: false, detail: "ORBIT's jobs record has no job with this id." } }, mk).map((n) => n.text()).join("\n");
  assert.match(missing, /no job with this id/);
});

test("closed cards say how they ended and open cards are not shown as decided", () => {
  for (const [state, word] of [["cancelled", "Cancelled"], ["expired", "Expired"], ["refused", "Refused"]] as const) {
    assert.match(lib.cardTitle({ kind: "job_launch", routine: "orbit", state })[0]!, new RegExp(word));
    assert.match(lib.cardStateNodes({ id: "c", kind: "job_launch", state }, mk).map((n) => n.text()).join(" "), new RegExp(word));
  }
  assert.match(lib.cardTitle({ kind: "job_launch", routine: "orbit", state: "open" })[0]!, /Waiting for your click/);
  const dup = lib.cardStateNodes({ id: "c", kind: "job_launch", state: "cancelled", duplicates: [{ job: "j1", similarity: 0.91, state: "running/ok" }] }, mk).map((n) => n.text()).join(" ");
  assert.match(dup, /Possible duplicate: 91% similar to job j1/);
});

test("the page says where messages were compacted, that all are kept, and when the summary was degraded", () => {
  const node = lib.compactionNode({ summary: { covers: 12, method: "extractive", text: "- user: <b>x</b>", degraded: "The model could not summarize: HTTP 503" } }, mk);
  assert.match(node.text(), /12 earlier message\(s\) are summarized for the model \(mechanical digest\)\. All of them are kept/);
  assert.match(node.text(), /could not summarize: HTTP 503/);
  assert.equal(node.all().filter((n) => n.tag === "b").length, 0);
});

test("a stored empty summary is shown as a warning that it is not used, not as an empty 'Summary the model sees' block", () => {
  const node = lib.compactionNode({ summaryUnusable: true, summary: { covers: 40, method: "model", text: "" } }, mk);
  assert.match(node.text(), /summary of 40 earlier message\(s\) is empty, so it is NOT used and nothing was hidden: the model is sent the full thread/);
  assert.ok(!/Summary the model sees/.test(node.text()));
});

test("thread options show title, archived state, waiting cards and a reply in progress", () => {
  assert.equal(lib.threadOption({ title: "Plan", archived: false, openCards: 0, busy: false }), "Plan");
  assert.equal(lib.threadOption({ title: "Old", archived: true, openCards: 2, busy: true }), "Old (archived) · 2 waiting · replying…");
});

test("the thread code never parses HTML and keeps per-device state in a guarded localStorage", () => {
  const start = html.indexOf("// ---- Threads (owner)");
  const end = html.indexOf("// ChatGPT sign-in, owner only");
  const code = html.slice(start, end) + grab("threads");
  assert.ok(code.length > 3000, "found the thread code");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
  assert.match(code, /try \{ return localStorage\.getItem\(THREAD_KEY\)/);
  assert.match(code, /catch \{ return null; \}/);
  // The history is the server's: the thread submit path sends only the new text.
  assert.match(code, /\/messages`, "POST", \{ text: content \}/);
  const threaded = html.slice(start, html.indexOf('if (threadMode === "server") { await sendThreaded'));
  assert.doesNotMatch(threaded, /history\.(push|slice)|JSON\.stringify\(\{ messages/);
});

test("the page restores the selection and history after a refresh, from the server, and lists, opens, creates, renames and archives threads", () => {
  assert.match(html, /async function initThreads\(\)/);
  assert.match(html, /const wanted = readSel\(\);/);
  assert.match(html, /openThread\(first\.id\)/);
  for (const route of ['"/threads?archived=1"', "`/threads/${encodeURIComponent(id)}`", '"/threads", "POST"', "/rename", "/archive", "/messages", "/threads/notice/ack"]) assert.ok(html.includes(route), route);
  assert.match(html, /makePoller\(pollThreads, /, "shared threads refresh on a guarded poller");
});

test("the one-time migration notice is shown from the server's notice and acknowledged on the server", () => {
  assert.match(html, /pendingNotice = r\.data\.notice/);
  assert.match(html, /noticeBanner\(pendingNotice\)/);
  assert.match(html, /tapi\("\/threads\/notice\/ack", "POST"\)/);
  assert.match(html, /el\("div", \{ className: "banner", role: "note" \}, n\.text/, "the notice text goes in as a text node");
});

test("phone width and both colour schemes are handled by the new bar and banners", () => {
  assert.match(html, /#threadbar \{ display: flex; flex-wrap: wrap;/);
  assert.match(html, /#threadbar select \{ flex: 1 1 160px; min-width: 0;/);
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  for (const sel of [".banner", ".compact", ".cardstate", "#threadbar"]) {
    const rule = css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
    assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,6}\b/, `${sel} uses theme variables, not fixed colours`);
  }
  assert.match(css, /prefers-color-scheme: dark/);
});
