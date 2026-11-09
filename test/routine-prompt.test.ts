import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const doc = readFileSync(new URL("../deploy/routines/orbit-jobs.md", import.meta.url), "utf8");
const prompt = /```text\n([\s\S]*?)\n```/.exec(doc)![1];
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();

// The numbered steps as the shell commands the prompt shows (indented lines that are code, not prose).
function stepCommands(n: number): string[] {
  const m = new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |\\n\\n[A-Z]|$(?![\\s\\S]))`, "m").exec(prompt)![0];
  return m.split("\n").filter((l) => /^ {3}\S/.test(l)).map((l) => l.trim())
    .filter((l) => /^(C=|rm |echo |git |mkdir |chmod |~\/)/.test(l));
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "orbit-rp-"));
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const checkout = join(root, "checkout");
  git(root, "clone", "-q", remote, checkout);
  mkdirSync(join(checkout, "tools/orbit-job"), { recursive: true });
  writeFileSync(join(checkout, "tools/orbit-job/orbit-job"), '#!/usr/bin/env bash\nprintf "ARGS:%s\\n" "$*"\n');
  writeFileSync(join(checkout, "tools/orbit-job/SKILL.md"), "skill\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "tool");
  git(checkout, "push", "-q", "origin", "main");
  const good = git(checkout, "rev-parse", "HEAD");
  // A commit that exists on the remote but is not on main.
  git(checkout, "switch", "-q", "-c", "side");
  writeFileSync(join(checkout, "x"), "x");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "side");
  git(checkout, "push", "-q", "origin", "side");
  const offMain = git(checkout, "rev-parse", "HEAD");
  git(checkout, "switch", "-q", "--detach", good);
  const home = join(root, "home");
  mkdirSync(home);
  // Every step gets its own shell with a minimal environment: nothing survives between steps.
  const step = (n: number, subst: Record<string, string> = {}) => {
    let script = stepCommands(n).join("\n");
    script = script.replaceAll("/home/user/orbit", checkout);
    for (const [k, v] of Object.entries(subst)) script = script.replaceAll(k, v);
    return spawnSync("bash", ["-c", "set -e\n" + script], {
      env: { HOME: home, PATH: "/usr/bin:/bin", ...identity },
      encoding: "utf8",
    });
  };
  return { home, good, offMain, step, checkout };
}

test("the documented prompt has the four steps and the fail-closed wording", () => {
  for (const n of [1, 2, 3, 4]) assert.ok(new RegExp(`^${n}\\. `, "m").test(prompt), `step ${n}`);
  assert.match(prompt, /Do not fall back to another commit/);
  assert.match(prompt, /never work around a refused step/);
  assert.doesNotMatch(prompt, /export PATH/);
  assert.doesNotMatch(prompt, /^ {3}orbit-job /m);
});

test("every step works in its own fresh shell with no surviving variables or PATH", () => {
  const w = world();
  const s1 = w.step(1, { "<the tool commit>": w.good });
  assert.equal(s1.status, 0, s1.stderr);
  assert.equal(readFileSync(join(w.home, ".orbit-tool-commit"), "utf8").trim(), w.good);
  const s2 = w.step(2);
  assert.equal(s2.status, 0, s2.stderr);
  assert.equal(readFileSync(join(w.home, ".claude/skills/orbit-job/SKILL.md"), "utf8"), "skill\n");
  const s4 = w.step(4, { "<id>": "job-1", "<url>": "http://x", "<token>": "tok" });
  assert.equal(s4.status, 0, s4.stderr);
  assert.match(s4.stdout, new RegExp(`ARGS:start --job job-1 --api http://x --token tok --tool-commit ${w.good}$`, "m"));
});

test("the tool is copied from, and reported as, the same verified commit", () => {
  const w = world();
  w.step(1, { "<the tool commit>": w.good });
  // A later commit must not leak in: the tool file is exactly the verified commit's blob.
  writeFileSync(join(w.checkout, "tools/orbit-job/orbit-job"), "#!/usr/bin/env bash\necho changed\n");
  w.step(2);
  const copied = readFileSync(join(w.home, ".local/bin/orbit-job"), "utf8");
  assert.equal(copied, git(w.checkout, "show", `${w.good}:tools/orbit-job/orbit-job`) + "\n");
  assert.ok((statSyncMode(join(w.home, ".local/bin/orbit-job")) & 0o111) !== 0);
});
function statSyncMode(p: string): number { return execFileSync("stat", ["-c", "%a", p], { encoding: "utf8" }).trim().split("").reduce((a, c) => a * 8 + Number(c), 0); }

test("step 1 fails closed on missing, malformed, off-main or unknown commits and saves nothing", () => {
  const w = world();
  for (const bad of ["", "ABCDEF" + "0".repeat(34), "a".repeat(39), w.good.slice(0, 12), "f".repeat(40), w.offMain]) {
    const r = w.step(1, { "<the tool commit>": bad });
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(bad)}`);
    assert.equal(existsSync(join(w.home, ".orbit-tool-commit")), false, `saved ${JSON.stringify(bad)}`);
  }
});

test("a stale saved commit is cleared when a new check fails, and step 2 refuses a missing or bad saved commit", () => {
  const w = world();
  assert.equal(w.step(1, { "<the tool commit>": w.good }).status, 0);
  assert.notEqual(w.step(1, { "<the tool commit>": "f".repeat(40) }).status, 0);
  assert.equal(existsSync(join(w.home, ".orbit-tool-commit")), false);
  const noFile = w.step(2);
  assert.notEqual(noFile.status, 0);
  assert.equal(existsSync(join(w.home, ".local/bin/orbit-job")), false);
  writeFileSync(join(w.home, ".orbit-tool-commit"), "main\n");
  assert.notEqual(w.step(2).status, 0);
  assert.equal(existsSync(join(w.home, ".local/bin/orbit-job")), false);
});
