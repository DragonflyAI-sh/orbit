import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The chat log is reconciled, not rebuilt: unchanged messages keep their DOM nodes (and with them the reader's text
// selection, focus and scroll). These tests load the page's reconcile and threads blocks against a small fake DOM that
// records every mutation. The real-browser checks (selection, scroll, focus) are in chat-browser.test.ts.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const grab = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";

let mutations: string[] = [];
class Node {
  tag: string;
  className = "";
  childNodes: (Node | Text)[] = [];
  parentNode: Node | null = null;
  constructor(tag: string, props: Record<string, unknown> = {}) {
    this.tag = tag;
    for (const [k, v] of Object.entries(props)) {
      if (/^(innerHTML|outerHTML)$/.test(k)) throw new Error(`${k} must never be set`);
      if (k === "textContent") this.append(new Text(String(v)));
      else (this as Record<string, unknown>)[k] = v;
    }
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  append(...kids: (Node | Text | string)[]) {
    for (const k of kids) { const n = typeof k === "string" ? new Text(k) : k; n.parentNode = this; this.childNodes.push(n); }
  }
  removeChild(n: Node | Text) { mutations.push(`${this.tag}>remove ${label(n)}`); this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  insertBefore(n: Node | Text, ref: Node | Text | null) {
    mutations.push(`${this.tag}>insert ${label(n)}`);
    if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i, 0, n); n.parentNode = this; return n;
  }
  replaceChild(n: Node | Text, old: Node | Text) {
    mutations.push(`${this.tag}>replace ${label(old)}`);
    this.childNodes[this.childNodes.indexOf(old)] = n; n.parentNode = this; old.parentNode = null; return old;
  }
  get nextSibling(): Node | Text | null { return sib(this); }
  text(): string { return this.childNodes.map((k) => (k instanceof Text ? k.data : k.text())).join(""); }
  all(): Node[] { return [this, ...this.childNodes.flatMap((k) => (k instanceof Text ? [] : k.all()))]; }
}
class Text {
  data: string;
  parentNode: Node | null = null;
  constructor(d: string) { this.data = d; }
  get nextSibling(): Node | Text | null { return sib(this); }
}
const sib = (n: Node | Text) => { const p = n.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(n) + 1] ?? null; };
const label = (n: Node | Text) => (n instanceof Text ? `"${n.data}"` : `${n.tag}.${n.className}`);
const mk = (tag: string, props?: Record<string, unknown>, ...kids: (Node | Text | string)[]) => { const n = new Node(tag, props); n.append(...kids); return n; };

type Spec = { key: string; sig: string; build: () => Node; update?: (n: Node) => void };
type Part = { key: string; sig: string; build: () => Node };
const lib = new Function(`${grab("notes")}; ${grab("markdown")}; ${grab("threads")}; ${grab("reconcile")}; return { reconcileChildren, messageParts, messageClass };`)() as {
  reconcileChildren: (p: Node, s: Spec[], meta: WeakMap<object, { key: string; sig: string }>, on?: (o: Node, f: Node, swap: () => void) => void) => { built: number; replaced: number; updated: number };
  messageParts: (m: unknown, mk: unknown, card?: (id: string) => { sig: string; build: () => Node } | null) => Part[];
  messageClass: (m: unknown) => string;
};

// The same shape renderThread builds: one spec per message, updated in place by reconciling its parts.
function draw(log: Node, meta: WeakMap<object, { key: string; sig: string }>, messages: Record<string, unknown>[], cards: Record<string, unknown>[] = []) {
  const byId = new Map(cards.map((c) => [c.id as string, c]));
  const cardSpec = (id: string) => { const c = byId.get(id); return c ? { sig: JSON.stringify(c), build: () => mk("div", { className: `cardwrap ${c.state}` }, String(c.state)) } : null; };
  return lib.reconcileChildren(log, messages.map((m) => {
    const parts = lib.messageParts(m, mk, cardSpec);
    const update = (n: Node) => { n.className = lib.messageClass(m); lib.reconcileChildren(n, parts, meta); };
    return { key: `m:t1:${m.id}`, sig: JSON.stringify(parts.map((p) => [p.key, p.sig])), build: () => { const n = mk("div"); update(n); return n; }, update };
  }), meta);
}

const msgs = () => [
  { id: "a", role: "user", at: "t", text: "first question" },
  { id: "b", role: "assistant", at: "t", text: "An **older** answer with `code`.", status: "done", provenance: "live", source: "model/x" },
];

test("an unchanged poll touches nothing: same nodes, same text nodes, no DOM mutations", () => {
  const log = mk("main"), meta = new WeakMap();
  draw(log, meta, msgs());
  const before = log.all();
  const textNodes = before.flatMap((n) => n.childNodes.filter((k) => k instanceof Text));
  mutations = [];
  for (let i = 0; i < 3; i++) assert.deepEqual(draw(log, meta, msgs()), { built: 0, replaced: 0, updated: 0 });
  assert.deepEqual(mutations, [], "no insert, remove or replace on an unchanged poll");
  assert.deepEqual(log.all(), before, "every element is the same object");
  assert.deepEqual(log.all().flatMap((n) => n.childNodes.filter((k) => k instanceof Text)), textNodes, "every text node is the same object");
});

test("a new message is appended; earlier messages are not moved, rebuilt or re-inserted", () => {
  const log = mk("main"), meta = new WeakMap();
  draw(log, meta, msgs());
  const [a, b] = log.childNodes;
  mutations = [];
  draw(log, meta, [...msgs(), { id: "c", role: "user", at: "t", text: "next" }, { id: "d", role: "assistant", at: "t", text: "", status: "pending", calls: [] }]);
  assert.deepEqual(mutations.filter((x) => x.startsWith("main>")), ["main>insert div.msg user", "main>insert div.msg orbit"]);
  assert.equal(log.childNodes[0], a);
  assert.equal(log.childNodes[1], b);
  assert.equal((log.childNodes[3] as Node).text(), "Working…");
});

test("a reply in progress updates only its own changed parts; completed messages are untouched", () => {
  const log = mk("main"), meta = new WeakMap();
  const pending = { id: "d", role: "assistant", at: "t", text: "", status: "pending", calls: [] as unknown[] };
  draw(log, meta, [...msgs(), pending]);
  const done = log.all().filter((n) => n.parentNode && n.parentNode !== log && log.childNodes.indexOf(n.parentNode) < 2);
  const active = log.childNodes[2] as Node;
  const body = active.childNodes[0];
  mutations = [];
  const call = { name: "jobs_list", arguments: "{}", ok: true, provenance: "live", source: "jobs", summary: "3 jobs" };
  draw(log, meta, [...msgs(), { ...pending, calls: [call] }]);
  assert.deepEqual(mutations, ["div>insert span.calls"], "a new tool call adds one part; the Working… body stays");
  assert.equal(active.childNodes[0], body);
  mutations = [];
  draw(log, meta, [...msgs(), { ...pending, status: "done", text: "Finished.", provenance: "live", source: "model/x", calls: [call] }]);
  assert.deepEqual(mutations, ["div>replace span.body", "div>insert span.tag live"], "finishing swaps the body and adds the tag, nothing else");
  assert.equal(log.childNodes[2], active, "the message node itself keeps its identity from pending to persisted");
  assert.ok(done.every((n) => log.all().includes(n)), "completed messages keep every node");
});

test("cards reconcile by id and state: an unchanged card is kept, a changed one is replaced alone, no duplicates", () => {
  const log = mk("main"), meta = new WeakMap();
  const m = [...msgs(), { id: "p", role: "assistant", at: "t", text: "Proposal below.", status: "done", provenance: "live", source: "s", cards: ["c1", "c2"] }];
  const open = [{ id: "c1", state: "open" }, { id: "c2", state: "open" }];
  draw(log, meta, m, open);
  const [, , card1, card2] = (log.childNodes[2] as Node).childNodes as Node[];
  mutations = [];
  draw(log, meta, m, open);
  assert.deepEqual(mutations, []);
  draw(log, meta, m, [{ id: "c1", state: "confirmed", live: { state: "running" } }, { id: "c2", state: "open" }]);
  assert.deepEqual(mutations, ["div>replace div.cardwrap open"]);
  const kids = (log.childNodes[2] as Node).childNodes as Node[];
  assert.notEqual(kids[2], card1);
  assert.equal(kids[2]!.className, "cardwrap confirmed");
  assert.equal(kids[3], card2, "the other, unchanged card keeps its node (and its focus and handlers)");
  assert.equal(kids.filter((k) => /cardwrap/.test(k.className)).length, 2, "no duplicate card");
});

test("unknown children (optimistic bubbles, another thread's nodes) are removed and duplicate ids drawn once", () => {
  const log = mk("main"), meta = new WeakMap();
  draw(log, meta, msgs());
  log.append(mk("div", { className: "msg user", textContent: "optimistic" }), mk("div", { className: "msg orbit", textContent: "Working…" }));
  draw(log, meta, [...msgs(), { id: "c", role: "user", at: "t", text: "optimistic" }, { id: "c", role: "user", at: "t", text: "optimistic" }]);
  assert.equal(log.childNodes.length, 3);
  assert.deepEqual(log.childNodes.map((n) => (n as Node).text()), ["first question", "An older answer with code.live · model/x", "optimistic"]);
});

test("a real edit to an older message is reflected, in that message only", () => {
  const log = mk("main"), meta = new WeakMap();
  draw(log, meta, msgs());
  const first = log.childNodes[0];
  mutations = [];
  const edited = msgs();
  edited[1] = { ...edited[1]!, text: "Corrected answer." };
  draw(log, meta, edited);
  assert.deepEqual(mutations, ["div>replace div.md"]);
  assert.equal(log.childNodes[0], first);
  assert.match((log.childNodes[1] as Node).text(), /Corrected answer\./);
});

test("the page draws the thread through the reconciler, never by replacing the whole log on a poll", () => {
  const render = html.slice(html.indexOf("function renderThread("), html.indexOf("let pendingNotice"));
  assert.match(render, /reconcileChildren\(log, specs, shownMeta, carryOver\)/);
  assert.doesNotMatch(render.replace("if (switched) { log.replaceChildren(); shownThreadId = view.id; }", ""), /replaceChildren/, "the log is only cleared on a thread switch");
  assert.match(render, /key: `m:\$\{view\.id\}:\$\{m\.id\}`/, "message keys are scoped to the thread");
  assert.match(html, /if \(seq !== loadSeq\) return true;/, "a stale load is dropped");
  assert.match(html, /view\.rev < current\.rev\) return true;/, "an older revision never rolls the view back");
  assert.doesNotMatch(html, /location\.reload|location\.href\s*=|location\.assign/, "chat updates never reload the page");
});
