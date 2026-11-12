import assert from "node:assert/strict";
import { test } from "node:test";
import { appendToSection, applyEdit, areaOf, classify, isTaggedRai, parseEdit, secretFindings, sensitiveCategories, setFrontmatter, splitFrontmatter, validatePath, VaultError } from "../src/vault/edit.ts";

const reader = (files: Record<string, string>) => (p: string) => files[p];

test("paths: normalised, relative, no traversal, no hidden or .git segments, no odd characters", () => {
  assert.equal(validatePath("Projects/Alpha (2026).md"), "Projects/Alpha (2026).md");
  assert.equal(validatePath("Projects/café.md"), "Projects/café.md");
  for (const bad of ["", "..", "../a.md", "a/../b.md", "a/./b.md", "/a.md", "a/", "a//b.md", "a\\b.md", ".git/config", "a/.GIT/x", "a/.github/x", "a/.hidden", "a/-rf.md", "a/ b.md", "a/b.", "a/b*.md", "a/b?.md", "a/b#.md", "a/b[1].md", "a/$HOME.md", "a/b|c.md", "a/b;c.md", "a/b\nc.md", "x".repeat(241), `${"a/".repeat(9)}b.md`]) {
    assert.throws(() => validatePath(bad), (e: unknown) => e instanceof VaultError && e.code === "invalid_path", JSON.stringify(bad));
  }
  assert.throws(() => validatePath(undefined));
  assert.throws(() => validatePath(5));
});

test("areas follow AGENTS.md sections 3 and 4, protected names without regard to case", () => {
  for (const p of ["Projects/a.md", "Tasks/a.md", "Areas/x/a.md", "Resources/a.md", "Memory/a.md", "Inbox/a.md", "now.md", "Machines/orbit.md", "Log/2026/2026-11-10-orbit.md"]) assert.equal(areaOf(p).area, "direct", p);
  for (const p of ["AGENTS.md", "agents.md", "System/x.md", "SYSTEM/x.md", ".obsidian/app.json", "scripts/x.sh", "Scripts/x.sh"]) assert.equal(areaOf(p).area, "protected", p);
  for (const p of ["Journal/a.md", "journal/a.md"]) assert.equal(areaOf(p).area, "journal", p);
  for (const p of ["Machines/other.md", "Log/2026/2026-11-10-laptop.md", "Log/2026/x.md", "Projects.md", "projects/a.md", "other.md", "Attachments/a.md"]) assert.equal(areaOf(p).area, "outside", p);
  assert.equal(areaOf("Archive/a.md").area, "archive");
});

test("front matter: set, replace (including block lists) and create; values are quoted when YAML would misread them", () => {
  const doc = "---\nstatus: active\ntags:\n  - a\n  - b\nowner: me\n---\nBody\n";
  assert.equal(setFrontmatter(doc, "tags", ["x", "z"]), "---\nstatus: active\ntags: [x, z]\nowner: me\n---\nBody\n");
  assert.equal(setFrontmatter(doc, "due", "2026-12-01"), "---\nstatus: active\ntags:\n  - a\n  - b\nowner: me\ndue: \"2026-12-01\"\n---\nBody\n");
  assert.equal(setFrontmatter("Body\n", "status", "done"), "---\nstatus: done\n---\nBody\n");
  assert.equal(setFrontmatter(doc, "done", true).includes("done: true"), true);
  assert.match(setFrontmatter(doc, "title", "yes"), /title: "yes"/);
  assert.match(setFrontmatter(doc, "title", "a: b"), /title: "a: b"/);
  assert.match(setFrontmatter(doc, "n", 5), /n: 5/);
  assert.throws(() => setFrontmatter(doc, "bad key", "x"));
  assert.throws(() => setFrontmatter(doc, "k", "two\nlines"));
  assert.throws(() => setFrontmatter("a\r\nb", "k", "v"));
  assert.deepEqual(splitFrontmatter(doc).fm, ["status: active", "tags:", "  - a", "  - b", "owner: me"]);
  assert.equal(splitFrontmatter("no front matter\n").fm, undefined);
});

test("sections: append at the end of the named section, once-only headings, fenced code ignored", () => {
  const doc = "# T\n\n## A\nline\n\n## B\n- x\n\n```\n## A\n```\n## C\nend";
  assert.equal(appendToSection(doc, "## A", "added").text, "# T\n\n## A\nline\n\nadded\n\n## B\n- x\n\n```\n## A\n```\n## C\nend");
  // The fenced "## A" is code, not a second heading; the fence belongs to section B, so the append goes after it.
  assert.match(appendToSection(doc, "## B", "- y").text, /## B\n- x\n\n```\n## A\n```\n\n- y\n## C/);
  assert.match(appendToSection(doc, "## C", "tail").text, /## C\nend\n\ntail$/);
  assert.throws(() => appendToSection(doc, "## Z", "x"), /No heading/);
  assert.throws(() => appendToSection("## A\na\n## A\nb\n", "## A", "x"), /2 times/);
  assert.throws(() => appendToSection(doc, "A", "x"), /full heading line/);
  assert.match(appendToSection("## Empty\n## Next\n", "## Empty", "hello").text, /^## Empty\n\nhello\n## Next/);
});

test("#rai detection covers body tags and front matter tags, nested tags, and not look-alikes", () => {
  assert.equal(isTaggedRai("text #rai here"), true);
  assert.equal(isTaggedRai("#RAI\n"), true);
  assert.equal(isTaggedRai("see #rai/private"), true);
  assert.equal(isTaggedRai("---\ntags: [a, rai]\n---\nx"), true);
  assert.equal(isTaggedRai("---\ntags:\n  - a\n  - \"#rai\"\n---\nx"), true);
  assert.equal(isTaggedRai("---\ntags:\n  - rai\n---\nx"), true);
  assert.equal(isTaggedRai("a #rain and #raid and rai and email#rai"), false);
  assert.equal(isTaggedRai("---\nowner: rai\n---\nx"), false);
});

test("sensitive categories are flagged only when new to the note", () => {
  assert.deepEqual(sensitiveCategories("started therapy last week", "# plain"), ["health"]);
  assert.deepEqual(sensitiveCategories("therapy again", "earlier: therapy notes"), []);
  assert.deepEqual(sensitiveCategories("my passport number", ""), ["identity documents"]);
  assert.deepEqual(sensitiveCategories("ship the release", ""), []);
});

test("secrets: known credential shapes are findings; weak or unknown values pass (permissive policy, docs/content-filter.md)", () => {
  for (const t of ["gh" + "p_" + "abcdefghijklmnopqrstuv", "Bear" + "er " + "Ab3dEfGh1jKlMn0p", "https://user:" + "Pw9xKq2mZ4" + "@example.com/", "api_" + "key=" + "Ab3dEfGh1jKlMn0pQr5s", "ey" + "JhbGciOi." + "ey" + "JzdWIi.sig", "tri" + "g_" + "ABCDEFGHIJKLMNOP"]) assert.equal(secretFindings([t]), true, t);
  for (const t of ["plain text with a commit 0123456789abcdef0123456789abcdef01234567", "# Heading\n- [ ] item\n", "Projects/some-note.md", "Bear" + "er abcdefghijkl", "https://user:" + "pw" + "@example.com/", "api_" + "key=" + "abc12345", "Zq".repeat(20)]) assert.equal(secretFindings([t]), false, t);
});

test("parseEdit is strict: unknown arguments, wrong types and oversize text are refused", () => {
  assert.throws(() => parseEdit("create_note", { path: "Inbox/a.md", content: "x", extra: 1 }), /Unexpected argument/);
  assert.throws(() => parseEdit("create_note", { path: "Inbox/a.md", content: 5 }), /string/);
  assert.throws(() => parseEdit("create_note", { path: "Inbox/a.md", content: "" }), /empty/);
  assert.throws(() => parseEdit("create_note", { path: "Inbox/a.md", content: "x".repeat(20_001) }), /limited/);
  assert.throws(() => parseEdit("rewrite_body", { path: "Memory/a.md", text: "x" }), /not available as a tool|Unknown/);
  assert.throws(() => parseEdit("delete_note", { path: "Inbox/a.md" }), /Unknown/);
  assert.throws(() => parseEdit("set_frontmatter", { path: "Inbox/a.md", key: "k", value: { a: 1 } }), /value must be/);
  assert.deepEqual(parseEdit("set_frontmatter", { path: "Inbox/a.md", key: "k", value: ["a"] }), { op: "set_frontmatter", path: "Inbox/a.md", key: "k", value: ["a"] });
});

test("classify: the Journal rule, protected reasons and refusals", () => {
  const files = { "Journal/j.md": "# J\n\n## Plan\n- a\n", "Projects/p.md": "# P\n## Notes\n", "now.md": "now\n" };
  const v = (edit: Parameters<typeof applyEdit>[0]) => classify(applyEdit(edit, reader(files)));
  assert.deepEqual(v({ op: "append_section", path: "Journal/j.md", heading: "## Plan", text: "- b" }), { kind: "direct" });
  assert.equal(v({ op: "replace_text", path: "Journal/j.md", find: "- a", replace: "- c" }).kind, "protected");
  assert.equal(v({ op: "append_section", path: "Projects/p.md", heading: "## Notes", text: "x" }).kind, "direct");
  assert.equal(v({ op: "append_section", path: "Projects/p.md", heading: "## Notes", text: "she was diagnosed with something last week" }).kind, "protected");
  assert.equal(v({ op: "append_section", path: "Projects/p.md", heading: "## Notes", text: "diagnosed the failing build; symptoms: timeouts" }).kind, "direct");
  assert.equal(v({ op: "replace_text", path: "now.md", find: "now", replace: "later" }).kind, "direct");
  const r = classify(applyEdit({ op: "create_note", path: "Machines/laptop.md", content: "x" }, reader(files)));
  assert.equal(r.kind, "refused");
});
