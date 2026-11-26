import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { cloneMemory } from "../src/memory.ts";
import { sidebarNote, sidebarSave, SIDEBAR_NOTE_MAX } from "../src/sidebar.ts";
import { sha } from "../src/vault/edit.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { OWNER, rig } from "./threads-fixture.ts";
import { git, makeFixture, SEED } from "./vault-fixture.ts";

// The file viewer (docs/file-viewer.md): src/web/files.js's pure parts (file types, the highlighter, the Markdown reader) run here
// in a plain VM context, and the server's side of it (GET /sidebar/note's editable/sha, POST /sidebar/note) runs on the real
// server over a real vault clone: a throwaway bare git repository with a synthetic token (test/vault-fixture.ts). Nothing here
// touches the real vault, the network or a real credential. The page itself is checked in test/file-viewer-browser.test.ts.

/* eslint-disable @typescript-eslint/no-explicit-any */
function loadFiles(): any {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../src/web/files.js", import.meta.url), "utf8"), ctx);
  return ctx.OrbitFiles;
}
const F = loadFiles();
const plainJson = (v: unknown) => JSON.parse(JSON.stringify(v));

// A secret-shaped value built at run time (never a literal in the repository).
const fakeKey = () => ["sk", "ab12".repeat(10)].join("-");

test("file types: Markdown edits and previews, PDFs and images are view-only, code is highlighted, text is plain", () => {
  const kind = (p: string) => { const k = F.fileKind(p); return `${k.kind}:${k.lang}:${k.editable}`; };
  assert.equal(kind("Projects/alpha.md"), "markdown::true");
  assert.equal(kind("notes/README.MARKDOWN"), "markdown::true");
  assert.equal(kind("Resources/paper.pdf"), "pdf::false");
  for (const p of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.svg"]) assert.equal(kind(p), "image::false", p);
  for (const [p, lang] of [["x.ts", "js"], ["x.tsx", "js"], ["x.js", "js"], ["x.jsx", "js"], ["x.py", "python"], ["x.rs", "rust"], ["x.go", "go"], ["x.c", "c"], ["x.h", "c"],
    ["x.css", "css"], ["x.html", "html"], ["x.sh", "shell"], ["x.yml", "yaml"], ["x.yaml", "yaml"], ["x.json", "json"]]) assert.equal(kind(p), `code:${lang}:true`, p);
  for (const p of ["a.txt", "b.log", "c.csv", "d.toml", ".env", "conf/prod.env"]) assert.equal(kind(p), "text::true", p);
  assert.equal(kind("Makefile"), "other::true");
  assert.equal(kind("archive.tar.zst"), "other::true");
});

test("highlighter: every language's tokens join back to the exact input, and the main token kinds are found", () => {
  const samples: Record<string, string> = {
    js: 'import { a } from "./b.ts";\nconst x = `t ${a}` + \'q\'; // note\n/* block */ export async function run(n: number) { return n > 0x1f ? new Error("x") : null; }\nclass Box<T> {}\nconst broken = "no end\n',
    python: 'import os\n@cache\ndef f(x=None):\n    """Doc\n    string"""\n    return f"{x}" if x else True  # c\n',
    rust: '#[derive(Debug)]\nfn main() { let mut v: Vec<u8> = Vec::new(); println!("{}", v.len()); } // c\n',
    go: 'package main\nimport "fmt"\nfunc main() { fmt.Println(`raw`, nil, 42) } /* c */\n',
    c: '#include <stdio.h>\nint main(void) { char *s = "x"; return 0; } // c\n',
    css: '/* c */\n@media (min-width: 900px) { .a:hover { color: #1a6f9e; margin: 4px 0; } }\n',
    html: '<!doctype html>\n<div class="a" data-x=\'y\'>It\'s &amp; fine <!-- c --></div>\n',
    shell: '#!/bin/sh\nset -eu\nif [ -n "$HOME" ]; then echo ${USER} $1; fi # c\n',
    json: '{ "name": "orbit", "n": -1.5e3, "ok": true, "none": null, "list": ["a", 2] }\n',
    yaml: '---\nname: orbit # c\nlist:\n  - key: "v"\n  - 3\nflag: true\n',
  };
  for (const [lang, code] of Object.entries(samples)) {
    const toks = plainJson(F.tokenize(code, lang)) as { type: string; text: string }[];
    assert.equal(toks.map((t) => t.text).join(""), code, `${lang}: lossless`);
    assert.ok(toks.every((t) => t.text.length > 0), `${lang}: no empty tokens`);
    if (lang !== "json") assert.ok(toks.some((t) => t.type === "comment"), `${lang}: a comment`);
  }
  const types = (code: string, lang: string) => (plainJson(F.tokenize(code, lang)) as { type: string; text: string }[]).filter((t) => t.type).map((t) => `${t.type}:${t.text}`);
  assert.deepEqual(types('const x = "hi"; // c', "js"), ["keyword:const", 'string:"hi"', "comment:// c"]);
  assert.deepEqual(types("def f(): return None", "python"), ["keyword:def", "fn:f", "keyword:return", "literal:None"]);
  assert.deepEqual(types('{"a": 1, "b": true}', "json"), ['property:"a"', "number:1", 'property:"b"', "literal:true"]);
  assert.deepEqual(types("key: value # c", "yaml"), ["property:key", "comment:# c"]);
  assert.deepEqual(types("echo $HOME", "shell"), ["keyword:echo", "var:$HOME"]);
  assert.deepEqual(types('<a href="x">', "html"), ["tag:<a", "property:href", 'string:"x"', "tag:>"]);
  // An unknown language is one plain token: the editor still works, without colours.
  assert.deepEqual(plainJson(F.tokenize("a < b", "cobol")), [{ type: "", text: "a < b" }]);
  // Large input stays linear enough for an editor (20,000 characters, the most a note can be saved with).
  const big = 'const s = "x"; // line\n'.repeat(900);
  const t0 = Date.now();
  assert.equal((plainJson(F.tokenize(big, "js")) as { text: string }[]).map((t) => t.text).join(""), big);
  assert.ok(Date.now() - t0 < 1000, "tokenizing 20,000 characters is quick");
});

test("Markdown: headings, emphasis, lists (nested and tasks), links, wiki links, code blocks, quotes, rules and front matter", () => {
  const md = [
    "---", "status: active", "---",
    "# Alpha **garden**", "",
    "A *quiet* line with `code`, a [link](https://example.com/a), [[Projects/beta|Beta]] and [[Tasks/seed-order]].", "and a second line.", "",
    "- one", "- [x] done", "  - nested", "- [ ] open", "",
    "3. three", "4. four", "",
    "> quoted", "> still", "",
    "```ts", "const a = 1;", "```", "",
    "***", "",
    "Bad links stay text: [x](javascript:alert(1)) and [y](data:text/html,hi).",
  ].join("\n");
  const blocks = plainJson(F.parseMarkdown(md));
  assert.deepEqual(blocks.map((b: any) => b.type), ["frontmatter", "heading", "para", "list", "list", "quote", "code", "hr", "para"]);
  assert.equal(blocks[0].text, "status: active");
  assert.deepEqual(blocks[1], { type: "heading", level: 1, inline: [{ t: "text", text: "Alpha " }, { t: "strong", kids: [{ t: "text", text: "garden" }] }] });
  const para = blocks[2].inline;
  assert.deepEqual(para.map((n: any) => n.t), ["text", "em", "text", "code", "text", "link", "text", "wiki", "text", "wiki", "text"]);
  assert.equal(para[5].href, "https://example.com/a");
  assert.deepEqual([para[7].text, para[7].target, para[9].text], ["Beta", "Projects/beta", "seed-order"]);
  assert.match(para.at(-1).text, /\. and a second line\.$/, "a soft line break reads as a space");
  const list = blocks[3];
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items.map((i: any) => i.task), [null, true, false]);
  assert.equal(list.items[1].blocks[1].type, "list", "the nested list belongs to its item");
  assert.deepEqual([blocks[4].ordered, blocks[4].start, blocks[4].items.length], [true, 3, 2]);
  assert.equal(blocks[5].blocks[0].inline[0].text, "quoted still");
  assert.deepEqual([blocks[6].lang, blocks[6].text], ["ts", "const a = 1;"]);
  // Only http(s) and mailto links are followed.
  assert.equal(F.safeHref("https://example.com"), "https://example.com");
  assert.equal(F.safeHref("mailto:rai@example.invalid"), "mailto:rai@example.invalid");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:x", "data:text/html,hi", "vbscript:x", "/sidebar", "Projects/a.md", "//evil.example"]) assert.equal(F.safeHref(bad), null, bad);
  // Unclosed fences and emphasis never swallow or lose text.
  const odd = plainJson(F.parseMarkdown("```\nno end\nstill code"));
  assert.deepEqual(odd, [{ type: "code", lang: "", text: "no end\nstill code" }]);
  assert.deepEqual(plainJson(F.parseInline("a * b ** c _ d")), [{ t: "text", text: "a * b ** c _ d" }]);
});

test("sidebarNote: editable only when the page shows the note byte for byte, with its hash", () => {
  const notes = new Map([
    ["Projects/a.md", "# A\n- one\n"],
    ["Projects/masked.md", `# M\nkey: ${fakeKey()}\n`],
    ["Projects/long.md", "x".repeat(SIDEBAR_NOTE_MAX + 5)],
    ["Projects/bidi.md", "# B ‮ reversed\n"],
    ["Projects/empty.md", ""],
  ]);
  assert.deepEqual(sidebarNote(notes, "Projects/a.md"), { path: "Projects/a.md", text: "# A\n- one\n", truncated: false, editable: true, sha: sha("# A\n- one\n") });
  const masked = sidebarNote(notes, "Projects/masked.md")!;
  assert.equal(masked.editable, false);
  assert.equal(masked.sha, undefined, "no hash of a note the page cannot show whole");
  assert.doesNotMatch(masked.text, /ab12ab12/);
  assert.deepEqual([sidebarNote(notes, "Projects/long.md")!.truncated, sidebarNote(notes, "Projects/long.md")!.editable], [true, false]);
  assert.equal(sidebarNote(notes, "Projects/bidi.md")!.editable, false);
  assert.equal(sidebarNote(notes, "Projects/empty.md")!.editable, false);
  assert.equal(sidebarNote(notes, "Projects/none.md"), undefined);
});

test("sidebarSave: checks the request against the snapshot before anything is written", () => {
  const text = "# A\n- one\n";
  const notes = new Map([["Projects/a.md", text], ["Projects/masked.md", `key: ${fakeKey()}\n`]]);
  const ok = sidebarSave(notes, { path: "Projects/a.md", sha: sha(text), text: "# A\n- two\n" });
  assert.deepEqual(ok, { ok: true, path: "Projects/a.md", expectSha: sha(text), text: "# A\n- two\n", unchanged: false });
  assert.equal((sidebarSave(notes, { path: "Projects/a.md", sha: sha(text), text }) as any).unchanged, true);
  const code = (input: Record<string, unknown>) => { const r = sidebarSave(notes, input); return r.ok ? 200 : r.code; };
  assert.equal(code({ path: "Projects/a.md", sha: sha("older"), text: "x" }), 409, "a note that changed since it was read");
  assert.equal(code({ path: "Projects/masked.md", sha: "0".repeat(64), text: "x" }), 422, "a masked note");
  assert.equal(code({ path: "Projects/none.md", sha: "0".repeat(64), text: "x" }), 404);
  assert.equal(code({ path: "../etc/passwd.md", sha: "0".repeat(64), text: "x" }), 404);
  assert.equal(code({ path: "Projects/a.md", sha: sha(text), text: "x".repeat(20_001) }), 413);
  assert.equal(code({ path: "Projects/a.md", sha: sha(text), text: 5 }), 400);
  assert.equal(code({ path: "Projects/a.md", sha: sha(text), text: "x", branch: "main" }), 400, "unknown fields are refused, not ignored");
});

// ---- the real server over a real vault clone -----------------------------------------------------------------------------------

async function served(seed: Record<string, string> = SEED, writes = true) {
  const fx = makeFixture(seed);
  const clone = fx.make();
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  const r = rig({ extra: ({ proposals }) => ({ memory, ...(writes ? { vaultEdits: vaultEdits({ clone, memory, proposals }) } : {}) }) });
  const remote = (path: string) => git(fx.root, "--git-dir", fx.remote, "show", `main:${path}`);
  return { r, fx, remote };
}

test("GET /sidebar/note gives the hash and whether the note can be saved; POST /sidebar/note commits it through the vault pipeline", async () => {
  const { r, fx, remote } = await served({ ...SEED, "Projects/masked.md": `# Masked\nkey: ${fakeKey()}\n` });
  const read = await r.api("/sidebar/note?path=Projects/alpha.md");
  assert.equal(read.status, 200);
  assert.equal(read.data.writable, true);
  assert.equal(read.data.note.editable, true);
  assert.equal(read.data.note.sha, sha(SEED["Projects/alpha.md"]!));
  const next = SEED["Projects/alpha.md"]!.replace("- step one", "- step one\n- step two from the editor");
  const saved = await r.api("/sidebar/note", "POST", { path: "Projects/alpha.md", sha: read.data.note.sha, text: next });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.status, "committed");
  assert.match(saved.data.commit, /^[0-9a-f]{40}$/);
  assert.equal(remote("Projects/alpha.md"), next, "the remote has exactly the editor's text");
  assert.match(git(fx.root, "--git-dir", fx.remote, "log", "-1", "--format=%an %s", "main"), /^ORBIT orbit: Save Projects\/alpha\.md from the file editor/);
  assert.match(git(fx.root, "--git-dir", fx.remote, "show", "--stat", "--format=", "main"), /Log\/\d{4}\/\d{4}-\d{2}-\d{2}-orbit\.md/, "with the Log line in the same commit");
  // Read back: the new text and its hash; the old hash no longer saves anything.
  const back = await r.api("/sidebar/note?path=Projects/alpha.md");
  assert.equal(back.data.note.text, next);
  assert.equal(back.data.note.sha, sha(next));
  const stale = await r.api("/sidebar/note", "POST", { path: "Projects/alpha.md", sha: read.data.note.sha, text: "# Overwrite\n" });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /changed in the vault since it was opened/);
  assert.equal(remote("Projects/alpha.md"), next);
  // The same text: nothing written.
  const same = await r.api("/sidebar/note", "POST", { path: "Projects/alpha.md", sha: sha(next), text: next });
  assert.deepEqual([same.status, same.data.status], [200, "unchanged"]);
  // A masked note is shown masked and cannot be saved, so the placeholder can never replace the real value.
  const masked = await r.api("/sidebar/note?path=Projects/masked.md");
  assert.deepEqual([masked.data.note.editable, masked.data.note.sha], [false, undefined]);
  const refused = await r.api("/sidebar/note", "POST", { path: "Projects/masked.md", sha: sha(`# Masked\nkey: ${fakeKey()}\n`), text: masked.data.note.text });
  assert.equal(refused.status, 422);
  assert.equal(remote("Projects/masked.md"), `# Masked\nkey: ${fakeKey()}\n`);
});

test("POST /sidebar/note: someone else's change since the snapshot is not overwritten", async () => {
  const { r, fx, remote } = await served();
  const read = await r.api("/sidebar/note?path=Tasks/todo.md");
  // Someone else changes the note on GitHub after the page read it (the snapshot still has the old text).
  git(fx.work, "pull", "-q", "origin", "main");
  const theirs = "# Todo\n- [ ] one\n- [ ] theirs\n";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(fx.work, "Tasks/todo.md"), theirs);
  git(fx.work, "commit", "-qam", "theirs");
  git(fx.work, "push", "-q", "origin", "main");
  const res = await r.api("/sidebar/note", "POST", { path: "Tasks/todo.md", sha: read.data.note.sha, text: "# Todo\n- [x] one\n" });
  assert.equal(res.status, 409, JSON.stringify(res.data));
  assert.match(res.data.error, /^NOT saved \(precondition_failed\)/);
  assert.equal(remote("Tasks/todo.md"), theirs, "their change stands");
});

test("POST /sidebar/note: a protected note becomes a proposal (nothing written); secret-shaped text is refused", async () => {
  const { r, remote } = await served();
  const read = await r.api("/sidebar/note?path=Projects/secret-rai.md");
  assert.equal(read.data.note.editable, true);
  const res = await r.api("/sidebar/note", "POST", { path: "Projects/secret-rai.md", sha: read.data.note.sha, text: "# Private\n#rai do not touch\nedited\n" });
  assert.equal(res.status, 202, JSON.stringify(res.data));
  assert.equal(res.data.status, "pending-confirmation");
  assert.equal(res.data.saved, false);
  assert.ok(res.data.reasons.some((x: string) => /#rai/.test(x)), JSON.stringify(res.data.reasons));
  assert.ok(r.proposals.peek(res.data.proposalId), "a confirmation card is open");
  assert.equal(remote("Projects/secret-rai.md"), SEED["Projects/secret-rai.md"]);
  const alpha = await r.api("/sidebar/note?path=Projects/alpha.md");
  const secret = await r.api("/sidebar/note", "POST", { path: "Projects/alpha.md", sha: alpha.data.note.sha, text: `${SEED["Projects/alpha.md"]}key: ${fakeKey()}\n` });
  assert.equal(secret.status, 422);
  assert.match(secret.data.error, /^NOT saved \(secret_refused\)/);
  assert.doesNotMatch(JSON.stringify(secret.data), /ab12ab12/, "the value is never echoed");
  assert.equal(remote("Projects/alpha.md"), SEED["Projects/alpha.md"]);
});

test("POST /sidebar/note: owner only, same-origin only, and refused when vault writes are off", async () => {
  const { r, remote } = await served();
  const read = await r.api("/sidebar/note?path=now.md");
  const body = { path: "now.md", sha: read.data.note.sha, text: "# Now\n- edited\n" };
  r.caller.who = "someone@example.com";
  const other = await r.api("/sidebar/note", "POST", body);
  assert.equal(other.status, 403);
  r.caller.who = OWNER;
  const cross = await r.api("/sidebar/note", "POST", body, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal(remote("now.md"), SEED["now.md"]);
  const off = await served(SEED, false);
  const ro = await off.r.api("/sidebar/note?path=now.md");
  assert.equal(ro.data.writable, false);
  const res = await off.r.api("/sidebar/note", "POST", { path: "now.md", sha: ro.data.note.sha, text: "# Now\n- edited\n" });
  assert.equal(res.status, 503);
  assert.equal(off.remote("now.md"), SEED["now.md"]);
  // /files.js is served as a script with nosniff.
  const js = await fetch(`http://127.0.0.1:${(r.server.address() as { port: number }).port}/files.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  assert.match(await js.text(), /OrbitFiles/);
});
