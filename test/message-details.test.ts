import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The per-message Details footer (detailsFooter in the page): diagnostic metadata (the provenance/model/memory tag, tool
// calls and, in the Assistant, the Tool output and Resource usage panes) sits in one closed <details> at the end of each
// message that has any; the body, photos, warnings, errors and proposal cards never go inside it. These tests load the
// page's blocks against a small fake DOM that supports what the reconciler uses; the real-browser checks (keyboard, focus
// ring, phone width, polls) are in message-details-browser.test.ts.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const grab = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";

class Text {
  data: string;
  parentNode: Node | null = null;
  constructor(d: string) { this.data = d; }
  get nextSibling(): Node | Text | null { return sib(this); }
  get textContent() { return this.data; }
}
class Node {
  tag: string;
  className = "";
  open = false;
  childNodes: (Node | Text)[] = [];
  parentNode: Node | null = null;
  [k: string]: unknown;
  constructor(tag: string, props: Record<string, unknown> = {}) {
    this.tag = tag;
    for (const [k, v] of Object.entries(props)) {
      if (/^(innerHTML|outerHTML|srcdoc)$/.test(k)) throw new Error(`${k} must never be set`);
      if (k === "textContent") this.textContent = String(v);
      else this[k] = v;
    }
  }
  get textContent(): string { return this.childNodes.map((k) => k.textContent).join(""); }
  set textContent(v: string) { this.childNodes = []; if (v) this.append(v); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling(): Node | Text | null { return sib(this); }
  append(...kids: (Node | Text | string)[]) {
    for (const k of kids) { const n = typeof k === "string" ? new Text(k) : k; n.parentNode = this; this.childNodes.push(n); }
  }
  removeChild(n: Node | Text) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  insertBefore(n: Node | Text, ref: Node | Text | null) {
    if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i, 0, n); n.parentNode = this; return n;
  }
  replaceChild(n: Node | Text, old: Node | Text) { this.childNodes[this.childNodes.indexOf(old)] = n; n.parentNode = this; old.parentNode = null; return old; }
  all(): Node[] { return [this, ...this.childNodes.flatMap((k) => (k instanceof Text ? [] : k.all()))]; }
  cls(c: string): Node[] { return this.all().filter((n) => n.className.split(" ").includes(c)); }
}
const sib = (n: Node | Text) => { const p = n.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(n) + 1] ?? null; };
const mk = (tag: string, props?: Record<string, unknown>, ...kids: (Node | Text | string)[]) => { const n = new Node(tag, props); n.append(...kids); return n; };

type Part = { key: string; sig: string; meta?: boolean; build: () => Node; update?: (n: Node) => void };
const fakeDocument = { querySelector: () => null };
const lib = new Function("document", `${grab("notes")}; ${grab("markdown")}; ${grab("threads")}; ${grab("reconcile")}; ${grab("assistant-parts")}; return { reconcileChildren, messageParts, messageClass, assistantParts, renderStoredMessage };`)(fakeDocument) as {
  reconcileChildren: (p: Node, s: Part[], meta: WeakMap<object, { key: string; sig: string }>) => unknown;
  messageParts: (m: unknown, mk: unknown, card?: ((id: string) => { sig: string; build: () => Node } | null) | null, photoUrl?: unknown, galleryBase?: unknown) => Part[];
  assistantParts: (m: unknown, mk: unknown, card: ((id: string) => { sig: string; build: () => Node } | null) | null, chunk: unknown, form?: string) => Part[];
  messageClass: (m: unknown) => string;
  renderStoredMessage: (m: unknown, mk: unknown, cardFor?: (id: string) => Node | null) => Node;
};

const LONG_MODEL = `openrouter/${"very-long-provider-model-identifier-".repeat(4)}2026-11-01`;
const LONG_NOTE = `Projects/${"deeply-nested-folder-name/".repeat(6)}a-note-with-a-long-name.md`;
const calls = [
  { name: "jobs_list", arguments: "{}", ok: true, provenance: "live", source: "jobs", summary: "3 jobs", outputChars: 40 },
  { name: "ops_restart", arguments: "{}", ok: false, outcomeUnknown: true, interrupted: "timeout", summary: "timed out", outputChars: 0 },
];
const rich = (over: Record<string, unknown> = {}) => ({
  id: "r1", role: "assistant", at: "t", text: "The **answer**.", status: "done", provenance: "live", source: LONG_MODEL,
  memory: [LONG_NOTE, "Resources/<img src=x onerror=alert(1)>.md"], calls, accounting: ["ledger write failed"], incomplete: ["round limit"], cards: ["k1"], ...over,
});
const cardSpec = (id: string) => ({ sig: id, build: () => mk("div", { className: "cardwrap", textContent: `card ${id}` }) });
const chunk = { seq: 1, context: { budgetChars: 52000, historyChars: 100, currentChars: 9, included: [], omitted: [] } };
const footOf = (n: Node) => n.cls("mfoot")[0];
const buildAll = (parts: Part[]) => { const node = mk("div"); for (const p of parts) node.append(p.build()); return node; };
// The same shape renderThread and drawAssistant build: one spec per message, updated in place by reconciling its parts.
function draw(log: Node, meta: WeakMap<object, { key: string; sig: string }>, list: Record<string, unknown>[], parts: (m: Record<string, unknown>) => Part[]) {
  return lib.reconcileChildren(log, list.map((m) => {
    const ps = parts(m);
    const update = (n: Node) => { n.className = lib.messageClass(m); lib.reconcileChildren(n, ps, meta); };
    return { key: `m:${m.id}`, sig: JSON.stringify(ps.map((p) => [p.key, p.sig])), build: () => { const n = mk("div"); update(n); return n; }, update };
  }), meta);
}
const SURFACES = {
  chat: (m: Record<string, unknown>) => lib.messageParts(m, mk, cardSpec),
  assistant: (m: Record<string, unknown>) => lib.assistantParts(m, mk, cardSpec, chunk, "full"),
};

for (const [surface, parts] of Object.entries(SURFACES)) {
  test(`${surface}: a message with metadata ends in one closed Details footer holding all of it; actions and warnings stay outside`, () => {
    const ps = parts(rich());
    assert.equal(ps.at(-1)!.key, "details", "the footer is the last part");
    assert.equal(ps.filter((p) => p.key === "details").length, 1);
    assert.deepEqual(ps.filter((p) => p.meta).map((p) => p.key), [], "no metadata part is left outside the footer");
    const node = buildAll(ps);
    const foot = footOf(node)!;
    assert.equal(foot.tag, "details");
    assert.equal(foot.open, false, "closed by default");
    const summary = foot.childNodes[0] as Node;
    assert.equal(summary.tag, "summary", "a native disclosure: keyboard operable without extra code");
    assert.equal(summary.textContent, "Details");
    const inside = foot.textContent;
    assert.ok(inside.includes(`live · ${LONG_MODEL}`), "provenance and the model id, in full");
    assert.ok(inside.includes(LONG_NOTE), "memory note paths, in full");
    assert.ok(inside.includes("<img src=x onerror=alert(1)>"), "stored text is shown as text");
    assert.equal(node.all().filter((n) => n.tag === "img" && n.className !== "mavatar").length, 0, "no element is ever made from stored text (the only image is the fixed icon)");
    assert.match(inside, /jobs_list/);
    assert.match(inside, /ops_restart/);
    if (surface === "assistant") {
      const panes = foot.all().filter((n) => n.tag === "details" && n !== foot);
      assert.deepEqual(panes.map((p) => [p.className, p.open]), [["toolpane", false], ["usagepane", false]], "the nested panes keep their own closed disclosures");
      assert.equal((panes[0]!.childNodes[0] as Node).textContent, "Tool output (2 calls, 1 with unknown outcome)", "counts unchanged");
      assert.equal((panes[1]!.childNodes[0] as Node).textContent, "Resource usage");
      assert.match(panes[1]!.textContent, /Context sent: 109 of 52000 characters/);
    } else {
      assert.match(inside, /Tool calls \(2\):/);
    }
    // Outside the footer: the body, both warnings and the card.
    const outside = node.childNodes.filter((k) => k !== foot) as Node[];
    assert.ok(outside.some((k) => k.className === "md" && /answer/.test(k.textContent)));
    assert.equal(outside.filter((k) => k.className === "warn").length, 2, "incomplete and spend warnings stay visible");
    assert.ok(outside.some((k) => k.className === "cardwrap"), "the proposal card stays visible");
    assert.ok(node.childNodes.indexOf(foot) > node.childNodes.findIndex((k) => (k as Node).className === "cardwrap"), "the footer comes after the card");
  });

  test(`${surface}: messages with no metadata get no footer; an error stays in view`, () => {
    for (const m of [
      { id: "u", role: "user", at: "t", text: "hello" },
      { id: "p", role: "assistant", at: "t", text: "", status: "pending", calls: [] },
    ]) assert.equal(parts(m).some((p) => p.key === "details"), false, `${m.id}: no empty footer`);
    const failed = parts({ id: "e", role: "assistant", at: "t", text: "", status: "error", error: "The model did not answer." });
    const node = buildAll(failed);
    const err = node.cls("down")[0]!;
    assert.match(err.textContent, /error: The model did not answer\./);
    assert.equal(footOf(node) ? footOf(node)!.all().includes(err) : false, false, "the error is never inside the footer");
  });

  test(`${surface}: the footer keeps its node and the reader's choice through a reply in progress, per message`, () => {
    const log = mk("main"), meta = new WeakMap();
    const done = rich({ id: "d1", cards: [] });
    const pending = { id: "p1", role: "assistant", at: "t", text: "", status: "pending", calls: [calls[0]] };
    draw(log, meta, [done, pending], parts);
    const [f1, f2] = [footOf(log.childNodes[0] as Node)!, footOf(log.childNodes[1] as Node)!];
    assert.ok(f1 && f2, "both have a footer (the pending one for its tool call)");
    f2.open = true;
    // A poll adds a tool call, then the reply finishes with its tag (and, in the Assistant, its usage).
    draw(log, meta, [done, { ...pending, calls }], parts);
    draw(log, meta, [done, { ...pending, calls, status: "done", text: "Finished.", provenance: "live", source: "model/x", memory: ["Tasks/a.md"] }], parts);
    assert.equal(footOf(log.childNodes[1] as Node), f2, "the same footer node");
    assert.equal(f2.open, true, "still open after the updates");
    assert.equal(footOf(log.childNodes[0] as Node), f1);
    assert.equal(f1.open, false, "the other message is independent");
    assert.match(f2.textContent, /live · model\/x · memory: Tasks\/a\.md/);
    assert.match(f2.textContent, /ops_restart/);
  });
}

test("assistant: an open nested pane stays open, with its new count, while rows change", () => {
  const log = mk("main"), meta = new WeakMap();
  const m = { id: "p1", role: "assistant", at: "t", text: "", status: "pending", calls: [calls[0]] };
  draw(log, meta, [m], SURFACES.assistant);
  const foot = footOf(log.childNodes[0] as Node)!;
  const pane = foot.cls("toolpane")[0]!;
  foot.open = true; pane.open = true;
  draw(log, meta, [{ ...m, calls }], SURFACES.assistant);
  assert.equal(foot.cls("toolpane")[0], pane, "the pane keeps its node");
  assert.equal(pane.open, true);
  assert.equal((pane.childNodes[0] as Node).textContent, "Tool output (2 calls, 1 with unknown outcome)");
  assert.match(pane.textContent, /ops_restart/);
});

test("chat and Assistant show the same metadata for the same message (parity)", () => {
  const m = rich({ cards: [] });
  const chat = footOf(buildAll(SURFACES.chat(m)))!;
  const asst = footOf(buildAll(SURFACES.assistant(m)))!;
  for (const f of [chat, asst]) {
    assert.equal(f.open, false);
    assert.equal((f.childNodes[0] as Node).textContent, "Details");
    assert.ok(f.textContent.includes(`live · ${LONG_MODEL} · memory: ${LONG_NOTE}`));
    assert.match(f.textContent, /jobs_list/);
  }
});

test("a paid fallback model is named on the closed footer's summary", () => {
  const ps = lib.messageParts(rich({ fallback: { model: "x/y", costUsd: 0.01 }, cards: [] }), mk);
  const foot = footOf(buildAll(ps))!;
  assert.equal((foot.childNodes[0] as Node).textContent, "Details⚠ Fallback model");
  assert.match(foot.textContent, /⚠ Fallback model, not ChatGPT · live/);
});

test("renderStoredMessage (one-off drawing) uses the same footer", () => {
  const node = lib.renderStoredMessage(rich({ cards: [] }), mk);
  assert.equal(footOf(node)!.open, false);
  assert.equal(node.childNodes.at(-1), footOf(node));
});

test("the footer CSS: wraps long text, no transition, a muted chevron, focus ring shared with every summary", () => {
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const rules = css.slice(css.indexOf(".msg details.mfoot"), css.indexOf("@media (pointer: coarse) { .mfoot"));
  assert.match(rules, /\.mfootbody \{[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(rules, /transition|animation/, "no motion");
  assert.match(css, /summary:focus-visible/, "the shared visible focus ring applies to the footer's summary");
  assert.match(rules, /var\(--muted\)/, "theme colors only");
});
