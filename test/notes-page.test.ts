import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ <notes>([\s\S]*?)\/\/ <\/notes>/)?.[1] ?? "";
const lib = new Function(`${block}; return { firstLine, linkify, pickNotes, NOTES_SHOWN };`)() as {
  NOTES_SHOWN: number;
  firstLine(t: string): { first: string; rest: string };
  linkify(t: string, mk: Mk): (string | Made)[];
  pickNotes(n: { id: string }[], d: Set<string>, all: boolean): { shown: { id: string }[]; total: number };
};
type Made = { tag: string; props: Record<string, string> };
type Mk = (tag: string, props: Record<string, string>) => Made;
const mk: Mk = (tag, props) => ({ tag, props });

test("the page never puts runner text through innerHTML in the notes or links code", () => {
  assert.ok(block.length > 100);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(block));
  const inbox = html.slice(html.indexOf("function renderInbox"), html.indexOf("// ChatGPT sign-in"));
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(inbox));
});

test("a note shows its first non-empty line; the rest waits behind 'more'", () => {
  assert.deepEqual(lib.firstLine("\n  Job j1 done\nline two\n\nline four"), { first: "Job j1 done", rest: "line two\n\nline four" });
  assert.deepEqual(lib.firstLine("one line"), { first: "one line", rest: "" });
  assert.deepEqual(lib.firstLine(""), { first: "", rest: "" });
});

test("only https URLs become real links, built from the text with rel=noopener", () => {
  const out = lib.linkify("PR ready: https://github.com/o/r/pull/7. Also http://evil.example/x and javascript:alert(1) and https://", mk);
  const links = out.filter((o): o is Made => typeof o !== "string");
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], { tag: "a", props: { href: "https://github.com/o/r/pull/7", target: "_blank", rel: "noopener noreferrer", textContent: "https://github.com/o/r/pull/7" } });
  assert.equal(out.map((o) => (typeof o === "string" ? o : o.props.textContent)).join(""), "PR ready: https://github.com/o/r/pull/7. Also http://evil.example/x and javascript:alert(1) and https://", "all the text survives");
  assert.equal(out[2], ". Also http://evil.example/x and javascript:alert(1) and https://");
});

test("markup in text stays text: it is never turned into elements", () => {
  const evil = `<img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a> https://ok.example/a"onmouseover="x`;
  const out = lib.linkify(evil, mk);
  const els = out.filter((o): o is Made => typeof o !== "string");
  assert.deepEqual(els.map((e) => e.props.href), ["https://ok.example/a"]);
  assert.ok(out.some((o) => typeof o === "string" && o.includes("<img src=x onerror=alert(1)>")));
  for (const e of els) assert.deepEqual(Object.keys(e.props).sort(), ["href", "rel", "target", "textContent"]);
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}` }));
const newest = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => `n${from - i}`);
const pick = (n: { id: string }[], d: string[] = [], all = false) => {
  const r = lib.pickNotes(n, new Set(d), all);
  return { shown: r.shown.map((x) => x.id), total: r.total };
};

test("the collapsed list shows the newest 10 undismissed notes", () => {
  assert.equal(lib.NOTES_SHOWN, 10);
  assert.deepEqual(pick([]), { shown: [], total: 0 });
  assert.deepEqual(pick(ids(3)), { shown: ["n3", "n2", "n1"], total: 3 }, "fewer than the limit: all of them, newest first");
  assert.deepEqual(pick(ids(10)), { shown: newest(10, 1), total: 10 }, "exactly the limit: all of them");
  assert.deepEqual(pick(ids(11)), { shown: newest(11, 2), total: 11 }, "one over: the oldest waits behind show all");
  // The page offers "show all (total)" only when total > NOTES_SHOWN: not at 0, 3 or 10, and at 11.
  for (const [n, offered] of [[0, false], [3, false], [10, false], [11, true]] as const) assert.equal(pick(ids(n)).total > lib.NOTES_SHOWN, offered, `${n} notes`);
});

test("show all lists every undismissed note, newest first", () => {
  assert.deepEqual(pick(ids(11), [], true), { shown: newest(11, 1), total: 11 });
  assert.deepEqual(pick(ids(25), [], true).shown, newest(25, 1));
  assert.deepEqual(pick(ids(3), [], true), pick(ids(3)), "under the limit, expanding changes nothing");
});

test("dismissed notes stay hidden and are not counted; a dismissal can cross the threshold either way", () => {
  // 11 → 10: one dismissal takes the list to the limit, so show all is no longer offered and nothing is held back.
  const down = pick(ids(11), ["n11"]);
  assert.deepEqual(down, { shown: newest(10, 1), total: 10 });
  assert.equal(down.total > lib.NOTES_SHOWN, false);
  // Dismissing inside the list moves the next older note in.
  assert.deepEqual(pick(ids(12), ["n12", "n7"]), { shown: ["n11", "n10", "n9", "n8", "n6", "n5", "n4", "n3", "n2", "n1"], total: 10 });
  // Dismissing a note past the limit leaves the collapsed list alone but lowers the count.
  assert.deepEqual(pick(ids(12), ["n1"]), { shown: newest(12, 3), total: 11 });
  // Expanded, a dismissal just drops that note.
  assert.deepEqual(pick(ids(11), ["n5"], true).shown, newest(11, 1).filter((id) => id !== "n5"));
  // Dismissals of unknown ids change nothing.
  assert.deepEqual(pick(ids(11), ["gone"]), pick(ids(11)));
});
