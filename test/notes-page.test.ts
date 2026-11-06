import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ <notes>([\s\S]*?)\/\/ <\/notes>/)?.[1] ?? "";
const lib = new Function(`${block}; return { firstLine, linkify, pickNotes };`)() as {
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

test("at most 3 newest undismissed notes show, with the rest behind show all; dismissed ones stay hidden", () => {
  const notes = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  assert.deepEqual(lib.pickNotes(notes, new Set(), false).shown.map((n) => n.id), ["e", "d", "c"]);
  assert.equal(lib.pickNotes(notes, new Set(), false).total, 5);
  assert.deepEqual(lib.pickNotes(notes, new Set(), true).shown.map((n) => n.id), ["e", "d", "c", "b", "a"]);
  const r = lib.pickNotes(notes, new Set(["e", "c"]), false);
  assert.deepEqual(r.shown.map((n) => n.id), ["d", "b", "a"]);
  assert.equal(r.total, 3);
  assert.deepEqual(lib.pickNotes([], new Set(), false), { shown: [], total: 0 });
});
