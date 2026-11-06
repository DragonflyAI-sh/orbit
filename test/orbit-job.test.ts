import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const TOOL = new URL("../tools/orbit-job/orbit-job", import.meta.url).pathname;
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();

// A bare "orbit-work" remote, ORBIT's checkout that writes briefs and steers, and the runner's checkout.
function setup(job = "j1") {
  const root = mkdtempSync(join(tmpdir(), "orbit-job-"));
  const remote = join(root, "orbit-work.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const orbit = join(root, "orbit-side");
  git(root, "clone", "-q", remote, orbit);
  writeFileSync(join(orbit, "README.md"), "work\n");
  git(orbit, "add", ".");
  git(orbit, "commit", "-q", "-m", "init");
  git(orbit, "push", "-q", "origin", "HEAD:main");
  git(orbit, "switch", "-q", "-c", `orbit/${job}`);
  mkdirSync(join(orbit, ".orbit"));
  writeFileSync(join(orbit, ".orbit", "brief.md"), "Do the thing.\n");
  git(orbit, "add", ".");
  git(orbit, "commit", "-q", "-m", "brief");
  git(orbit, "push", "-q", "origin", `orbit/${job}`);
  const runner = join(root, "orbit-work");
  git(root, "clone", "-q", remote, runner);
  const state = join(root, "state");
  const run = (...args: string[]) =>
    spawnSync("bash", [TOOL, ...args], { cwd: runner, env: { ...process.env, ...identity, HOME: root, ORBIT_JOB_STATE: state }, encoding: "utf8" });
  const remoteFile = (path: string) => git(root, "--git-dir", remote, "show", `orbit/${job}:${path}`);
  return { root, orbit, runner, run, remoteFile, job };
}

test("start checks out the job branch, finds the checkout itself, and records the start", () => {
  const { run, remoteFile } = setup();
  const out = run("start", "--job", "j1");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ok git=pushed [0-9a-f]+ api=not-configured/);
  assert.match(out.stdout, /brief: .*\.orbit\/brief\.md/);
  assert.equal(JSON.parse(remoteFile(".orbit/started.json")).job, "j1");
});

test("start refuses a bad id, a missing branch, and a branch without a brief", () => {
  const { run, orbit } = setup();
  assert.equal(run("start", "--job", "../x").status, 2);
  assert.match(run("start", "--job", "nope").stderr, /not on origin/);
  git(orbit, "switch", "-q", "-c", "orbit/empty", "main");
  git(orbit, "push", "-q", "origin", "orbit/empty");
  assert.match(run("start", "--job", "empty").stderr, /no \.orbit\/brief\.md/);
});

test("checkin appends progress and shows steers ORBIT pushed meanwhile; reply answers them", () => {
  const { run, orbit, runner, remoteFile } = setup();
  run("start", "--job", "j1");
  // ORBIT pushes a steer while the runner works.
  git(orbit, "pull", "-q", "--rebase", "origin", "orbit/j1");
  mkdirSync(join(orbit, ".orbit", "steer"));
  writeFileSync(join(orbit, ".orbit", "steer", "1.md"), "Use the REST API instead.\n");
  git(orbit, "add", ".");
  git(orbit, "commit", "-q", "-m", "steer 1");
  git(orbit, "push", "-q", "origin", "orbit/j1");

  const checkin = run("checkin", 'running tests "unit"');
  assert.equal(checkin.status, 0, checkin.stderr);
  assert.match(checkin.stdout, /--- steer 1/);
  assert.match(checkin.stdout, /Use the REST API instead/);
  assert.equal(JSON.parse(remoteFile(".orbit/checkins.jsonl").split("\n")[0]).status, 'running tests "unit"');

  writeFileSync(join(runner, "answer.md"), "Switched to REST.\n");
  assert.equal(run("reply", "1", join(runner, "answer.md")).status, 0);
  assert.equal(remoteFile(".orbit/replies/1.md"), "Switched to REST.");
  assert.match(run("steers").stdout, /no unanswered steers/);
  assert.match(run("reply", "9", join(runner, "answer.md")).stderr, /no steer 9/);
});

test("a push that races with ORBIT is rebased and still lands", () => {
  const { run, orbit, remoteFile } = setup();
  run("start", "--job", "j1");
  git(orbit, "pull", "-q", "--rebase", "origin", "orbit/j1");
  mkdirSync(join(orbit, ".orbit", "steer"));
  writeFileSync(join(orbit, ".orbit", "steer", "1.md"), "x\n");
  git(orbit, "add", ".");
  git(orbit, "commit", "-q", "-m", "steer 1");
  git(orbit, "push", "-q", "origin", "orbit/j1");
  // The runner has not pulled; its next record must rebase onto ORBIT's commit.
  const out = run("checkin", "still working");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(remoteFile(".orbit/steer/1.md"), "x");
  assert.match(remoteFile(".orbit/checkins.jsonl"), /still working/);
});

test("summary records a status and refuses an unknown one", () => {
  const { run, runner, remoteFile } = setup();
  run("start", "--job", "j1");
  writeFileSync(join(runner, "s.md"), "Need a decision on the schema.\n");
  assert.equal(run("summary", "--status", "maybe", join(runner, "s.md")).status, 2);
  assert.equal(run("summary", "--status", "blocked", join(runner, "s.md")).status, 0);
  const summary = remoteFile(".orbit/summary.md");
  assert.match(summary, /^---\nstatus: blocked\nat: \d{4}-/);
  assert.match(summary, /Need a decision on the schema/);
});

test("commands before start explain what to do", () => {
  const { run } = setup();
  assert.match(run("checkin", "x").stderr, /run: orbit-job start --job <id>/);
});

test("a failed push is reported as FAILED, never as recorded", () => {
  const { run, root } = setup();
  run("start", "--job", "j1");
  // Point the runner at a remote that does not exist.
  git(join(root, "orbit-work"), "remote", "set-url", "origin", join(root, "missing.git"));
  const out = run("checkin", "x");
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /FAILED git=push-failed/);
  assert.doesNotMatch(readFileSync(join(root, "orbit-work", ".orbit", "checkins.jsonl"), "utf8"), /^$/);
});
