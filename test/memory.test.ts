import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectMemory, vaultMemory } from "../src/memory.ts";

const root = mkdtempSync(join(tmpdir(), "orbit-vault-"));
mkdirSync(join(root, "Projects"));
mkdirSync(join(root, ".obsidian"));
writeFileSync(join(root, "Projects", "money-noodle.md"), "# Money Noodle\nPR 275 is a draft.\n");
writeFileSync(join(root, "Projects", "star-lake.md"), "Cabin trip.\n");
writeFileSync(join(root, ".obsidian", "hidden.md"), "money noodle settings\n");
const sync = join(root, "sync.json");

test("search ranks notes by the words in the query", () => {
  const hits = vaultMemory(root).search("what is happening with money noodle?").value;
  assert.equal(hits[0].path, join("Projects", "money-noodle.md"));
  assert.ok(hits.every((h) => !h.path.startsWith(".obsidian")));
});

test("read refuses paths outside the vault", () => {
  const memory = vaultMemory(root);
  assert.match(memory.read("Projects/star-lake.md").value, /Cabin/);
  assert.throws(() => memory.read("../etc/passwd.md"));
  assert.throws(() => memory.read("Projects/star-lake.txt"));
});

test("memory is live only while the vault copy was synced recently", () => {
  writeFileSync(sync, JSON.stringify({ commit: "abcdef123", at: new Date().toISOString() }));
  assert.equal(vaultMemory(root, sync).status().state, "live");
  writeFileSync(sync, JSON.stringify({ commit: "abcdef123", at: "2026-01-01T00:00:00Z" }));
  assert.equal(vaultMemory(root, sync).status().state, "degraded");
  assert.equal(vaultMemory(root).status().state, "degraded");
});

test("a missing vault is down, not mock", () => {
  assert.equal(selectMemory({}).status().state, "down");
  assert.equal(selectMemory({ ORBIT_VAULT: join(root, "nope") }).status().state, "down");
});
