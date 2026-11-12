import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The corpus-validation tool prints aggregates only. This runs it over a synthetic vault whose notes hold a fabricated secret, a
// distinctive path and distinctive prose, and checks that none of them reaches the output (docs/content-filter.md, "Corpus validation").
const TOOL = new URL("../tools/vault-filter-corpus/corpus.ts", import.meta.url).pathname;

test("the corpus tool reports counts and rule ids and never a value, a path or a line of text", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-corpus-"));
  mkdirSync(join(dir, "Projects"));
  const secret = "gh" + "p_" + "Zk3".repeat(12);
  writeFileSync(join(dir, "Projects", "distinctive-private-project-name-xyzzy.md"), `# Heading\n\nthe unique sentence about plumbago\n${secret}\nsee [[orbit-next-secret-detector-false-positives]]\n`);
  writeFileSync(join(dir, "plain.md"), "# Plain\n\nnothing here\n");
  const r = spawnSync(process.execPath, [TOOL, dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /2 notes/);
  assert.match(out, /secret\.provider-token: 1 texts, 1 findings/);
  assert.match(out, /fabricated blocked cases, current: .*secret\.provider-token \d+\/\d+/);
  for (const leak of [secret.slice(4, 20), "xyzzy", "plumbago", "distinctive-private", "orbit-next-secret-detector"]) assert.ok(!out.includes(leak), `the output must not contain ${leak}`);
  const json = spawnSync(process.execPath, [TOOL, dir, "--json"], { encoding: "utf8" });
  assert.ok(!json.stdout.includes(secret.slice(4, 20)) && !json.stdout.includes("xyzzy"));
  assert.equal(JSON.parse(json.stdout).current.byRule["secret.provider-token"].findings, 1);
});

test("the corpus tool fails safely: no directory argument is a usage error, and it never writes into the vault", () => {
  const r = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
