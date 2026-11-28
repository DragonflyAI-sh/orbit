import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { vaultClone } from "../src/vault/clone.ts";
import { TOKEN, git } from "./vault-fixture.ts";

// A new instance's vault repository can still be empty when the instance first starts (Nova's was). git leaves such a clone
// without origin/HEAD and never sets it later, so the clone must ask the remote again once the branch exists.
test("a clone of a vault repository that was still empty recovers once the branch is pushed", async () => {
  const root = mkdtempSync(join(tmpdir(), "vault-empty-"));
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "-q", "-b", "main", remote);
  let t = new Date("2026-11-28T06:40:00Z");
  const clone = vaultClone({ dir: join(root, "state", "vault-clone"), remote, credential: () => TOKEN, allowProtocols: "file", now: () => t });
  await assert.rejects(clone.sync(), /which branch/);
  const work = join(root, "work");
  git(root, "clone", "-q", remote, work);
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "now.md"), "# Now\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "first");
  git(work, "push", "-q", "origin", "main");
  t = new Date(t.getTime() + 11 * 60_000); // past the fetch backoff
  await clone.sync();
  assert.equal(clone.state().head, execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim());
});
