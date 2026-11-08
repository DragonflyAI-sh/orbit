import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const doc = readFileSync(new URL("../deploy/routines/orbit-jobs.md", import.meta.url), "utf8");
const prompt = doc.split("## Prompt")[1].split("```text\n")[1].split("\n```")[0];
const COMMAND = /^ {3}(set |C=|rm |echo |git |mkdir |chmod |~\/\.local\/bin\/orbit-job )/;

// The command lines of step n, exactly as the prompt gives them.
function step(n: number): string[] {
  const body = prompt.split(new RegExp(`^${n}\\. `, "m"))[1].split(/^\d\. |^If no job id/m)[0];
  return body.split("\n").filter((l) => COMMAND.test(l)).map((l) => l.trim());
}

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();

function world() {
  const root = mkdtempSync(join(tmpdir(), "orbit-rp-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(root, "orbit");
  git(root, "clone", "-q", origin, repo);
  mkdirSync(join(repo, "tools/orbit-job"), { recursive: true });
  writeFileSync(join(repo, "tools/orbit-job/orbit-job"), '#!/bin/bash\necho "tool-ran $*"\n');
  writeFileSync(join(repo, "tools/orbit-job/SKILL.md"), "skill\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "tool");
  git(repo, "push", "-q", "origin", "main");
  const good = git(repo, "rev-parse", "HEAD");
  // An unmerged commit that exists on origin only on a side branch.
  git(repo, "switch", "-q", "-c", "side");
  writeFileSync(join(repo, "x"), "x");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "side");
  git(repo, "push", "-q", "origin", "side");
  const side = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "main");
  const home = join(root, "home");
  mkdirSync(home);
  // Each step runs in its own fresh shell, as the Routine's separate commands do.
  const run = (n: number, vars: Record<string, string> = {}) => {
    let script = step(n).join("\n").replaceAll("/home/user/orbit", repo);
    for (const [k, v] of Object.entries(vars)) script = script.replaceAll(k, v);
    return spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, HOME: home }, encoding: "utf8" });
  };
  return { root, home, good, side, run };
}

test("the prompt has command-bearing steps with the expected shape", () => {
  assert.ok(step(1).length >= 5 && step(2).length >= 6 && step(4).length === 1);
  assert.ok(step(1)[0] === "set -eu" && step(2)[0] === "set -eu");
});

test("separate shells hand the verified commit from step 1 through step 2 to step 4", () => {
  const w = world();
  assert.equal(w.run(1, { "<the tool commit>": w.good }).status, 0);
  assert.equal(readFileSync(join(w.home, ".orbit-tool-commit"), "utf8").trim(), w.good);
  assert.equal(w.run(2).status, 0);
  assert.ok(existsSync(join(w.home, ".local/bin/orbit-job")));
  assert.equal(readFileSync(join(w.home, ".claude/skills/orbit-job/SKILL.md"), "utf8"), "skill\n");
  const four = w.run(4, { "<id>": "j1", "<url>": "http://x", "<token>": "t" });
  assert.equal(four.status, 0);
  assert.match(four.stdout, new RegExp(`tool-ran start --job j1 .*--tool-commit ${w.good}$`, "m"));
});

test("step 1 rejects a malformed, missing or off-main commit and leaves no record", () => {
  const w = world();
  for (const bad of ["abc", "A".repeat(40), "", w.side, "f".repeat(40)]) {
    const r = w.run(1, { "<the tool commit>": bad });
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(bad)}`);
    assert.equal(existsSync(join(w.home, ".orbit-tool-commit")), false);
  }
});

test("step 1 clears a stale record and stale installed tool when the new commit is bad", () => {
  const w = world();
  assert.equal(w.run(1, { "<the tool commit>": w.good }).status, 0);
  assert.equal(w.run(2).status, 0);
  assert.notEqual(w.run(1, { "<the tool commit>": "bad" }).status, 0);
  assert.equal(existsSync(join(w.home, ".orbit-tool-commit")), false);
  assert.equal(existsSync(join(w.home, ".local/bin/orbit-job")), false);
});

test("step 2 fails closed with no record, a corrupt record or an off-main commit", () => {
  const w = world();
  assert.notEqual(w.run(2).status, 0);
  assert.equal(existsSync(join(w.home, ".local/bin/orbit-job")), false);
  for (const bad of ["not-a-commit", w.side]) {
    writeFileSync(join(w.home, ".orbit-tool-commit"), bad + "\n");
    assert.notEqual(w.run(2).status, 0, `accepted ${bad}`);
    assert.equal(existsSync(join(w.home, ".local/bin/orbit-job")), false);
  }
});
