import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ <tool-commit-badge>([\s\S]*?)\/\/ <\/tool-commit-badge>/)?.[1] ?? "";
type Node = { className?: string; textContent?: string; title?: string; attrs: Record<string, string>; setAttribute(k: string, v: string): void };
const el = (_tag: string, props: { className?: string; textContent?: string }): Node => {
  const n: Node = { ...props, attrs: {}, setAttribute(k, v) { n.attrs[k] = v; } };
  return n;
};
const badge = new Function("el", `${block}; return toolCommitBadge;`)(el) as (r: { toolCommit?: string; toolCommitStatus?: string }) => Node;
const FULL = "e4c35fa52cbfc4ae1b7f5b27b149c38423e2d181";

test("a known tool commit shows 7 characters, with the full commit as title and accessible name", () => {
  const n = badge({ toolCommit: FULL, toolCommitStatus: "match" });
  assert.equal(n.textContent, "tool commit: e4c35fa (matches ORBIT)");
  assert.equal(n.title, FULL);
  assert.equal(n.attrs["aria-label"], `tool commit ${FULL}`);
  assert.equal(n.attrs.role, "note");
});

test("a missing or unknown tool commit says unknown and carries no title or label", () => {
  for (const r of [{}, { toolCommit: "unknown", toolCommitStatus: "unknown" }, { toolCommit: "" }]) {
    const n = badge(r);
    assert.equal(n.textContent, "tool commit: unknown");
    assert.equal(n.title, undefined);
    assert.deepEqual(n.attrs, {});
  }
});

test("a mismatch is flagged and still exposes the full commit", () => {
  const n = badge({ toolCommit: FULL, toolCommitStatus: "mismatch" });
  assert.equal(n.className, "health-launch-failed");
  assert.match(n.textContent!, /≠ running ORBIT/);
  assert.equal(n.title, FULL);
});

test("markup in a commit value stays text: it is never interpreted as HTML", () => {
  const n = badge({ toolCommit: "<img src=x onerror=alert(1)>", toolCommitStatus: "unknown" });
  assert.ok(!("innerHTML" in n));
  assert.equal(typeof n.textContent, "string");
});
