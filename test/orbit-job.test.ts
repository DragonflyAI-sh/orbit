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

// ---- summary --status done: PR title and body are required when the job pushed a code branch ----

const GOOD = "Implemented it.\n\n## PR title\nAdd the widget to the dashboard\n\n## PR body\nAdds a widget to the dashboard so Rai can see jobs at a glance. Typecheck and tests pass.\n";

// A project repo with its own origin, checked out under the runner's HOME, with orbit/<job> pushed or not.
function withProject(s: ReturnType<typeof setup>, opts: { push?: boolean } = {}) {
  const remote = join(s.root, "project.git");
  git(s.root, "init", "-q", "--bare", "-b", "main", remote);
  const checkout = join(s.root, "project");
  git(s.root, "clone", "-q", remote, checkout);
  writeFileSync(join(checkout, "a.txt"), "a\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "init");
  git(checkout, "push", "-q", "origin", "HEAD:main");
  git(checkout, "switch", "-q", "-c", `orbit/${s.job}`);
  writeFileSync(join(checkout, "b.txt"), "b\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "work");
  if (opts.push !== false) git(checkout, "push", "-q", "origin", `orbit/${s.job}`);
  return { remote, checkout };
}
// Only look inside the sandbox root, never at the real /home/user.
const summarize = (s: ReturnType<typeof setup>, text: string, ...args: string[]) => {
  const f = join(s.root, "summary-in.md");
  writeFileSync(f, text);
  return spawnSync("bash", [TOOL, "summary", "--status", "done", ...args, f], {
    cwd: s.runner,
    env: { ...process.env, ...identity, HOME: s.root, ORBIT_JOB_STATE: join(s.root, "state"), ORBIT_JOB_SEARCH: s.root },
    encoding: "utf8",
  });
};
const hasSummary = (s: ReturnType<typeof setup>) => spawnSync("git", ["--git-dir", join(s.root, "orbit-work.git"), "cat-file", "-e", `orbit/${s.job}:.orbit/summary.md`]).status === 0;

test("done with a pushed code branch and both sections is recorded", () => {
  const s = setup();
  s.run("start", "--job", "j1");
  withProject(s);
  const out = summarize(s, GOOD);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ok git=pushed/);
  assert.match(s.remoteFile(".orbit/summary.md"), /^---\nstatus: done/);
});

test("done with a pushed code branch is refused, and writes and sends nothing, when a section is missing or empty", () => {
  const s = setup();
  s.run("start", "--job", "j1");
  withProject(s);
  const cases: [string, RegExp[]][] = [
    ["All done, no sections.\n", [/missing a '## PR title'/, /missing a '## PR body'/]],
    ["## PR title\nAdd the widget to the dashboard\n", [/missing a '## PR body'/]],
    ["## PR body\nAdds a widget to the dashboard so Rai can see jobs at a glance.\n", [/missing a '## PR title'/]],
    ["## PR title\n\n## PR body\nAdds a widget to the dashboard so Rai can see jobs at a glance.\n", [/'## PR title' needs a real one-line title/]],
    ["## PR title\nTBD\n\n## PR body\nAdds a widget to the dashboard so Rai can see jobs at a glance.\n", [/'## PR title' needs a real one-line title/]],
    ["## PR title\nAdd the widget to the dashboard\n\n## PR body\n\n   \n", [/'## PR body' needs substantive content/]],
    ["## PR title\nAdd the widget to the dashboard\n\n## PR body\nTODO\n", [/'## PR body' needs substantive content/]],
    ["## PR body\nAdds a widget to the dashboard so Rai can see jobs at a glance.\n\n## PR title\n\n", [/'## PR title' needs a real one-line title/]],
  ];
  for (const [text, errors] of cases) {
    const out = summarize(s, text);
    assert.equal(out.status, 2, text);
    assert.match(out.stderr, /summary NOT recorded: this job pushed a code branch/);
    assert.match(out.stderr, /run the same command again/);
    for (const e of errors) assert.match(out.stderr, e, text);
    assert.equal(out.stdout.includes("ok git"), false);
  }
  assert.equal(hasSummary(s), false, "nothing was committed or pushed");
  assert.equal(spawnSync("git", ["-C", s.runner, "status", "--porcelain"], { encoding: "utf8" }).stdout.includes("summary.md"), false, "nothing was left in the checkout");
  // The correction is accepted on retry.
  assert.equal(summarize(s, GOOD).status, 0);
  assert.equal(hasSummary(s), true);
});

test("a refused done summary sends no API event", () => {
  const s = setup();
  s.run("start", "--job", "j1");
  withProject(s);
  // An unreachable https API: if the tool tried to send, it would write to api.err and say api=failed.
  const state = join(s.root, "state");
  writeFileSync(join(state, "current"), readFileSync(join(state, "current"), "utf8").replace(/^API=.*$/m, "API=https://127.0.0.1:9").replace(/^TOKEN=.*$/m, "TOKEN=t"));
  const out = summarize(s, "no sections\n");
  assert.equal(out.status, 2);
  assert.equal(out.stdout.includes("api="), false);
  assert.equal(out.stderr.includes("api=failed"), false);
});

test("done without a pushed code branch is unchanged: no sections needed", () => {
  const noRepo = setup();
  noRepo.run("start", "--job", "j1");
  assert.equal(summarize(noRepo, "Researched it, nothing to push.\n").status, 0);

  // A project checkout whose orbit/<job> was never pushed, and another job's pushed branch, are not evidence.
  const local = setup();
  local.run("start", "--job", "j1");
  withProject(local, { push: false });
  assert.equal(summarize(local, "Looked around, pushed nothing.\n").status, 0);

  const other = setup();
  other.run("start", "--job", "j1");
  const p = withProject(other);
  git(p.checkout, "push", "-q", "origin", "--delete", "orbit/j1");
  git(p.checkout, "push", "-q", "origin", "orbit/j1:refs/heads/orbit/other-job");
  assert.equal(summarize(other, "No branch for this job.\n").status, 0);
});

test("the orbit-work control branch is never counted as a pushed code branch", () => {
  const s = setup();
  s.run("start", "--job", "j1"); // orbit/j1 now exists on orbit-work's origin, and the runner and ORBIT checkouts sit under HOME
  assert.equal(summarize(s, "Nothing to push.\n").status, 0);
});

test("blocked and failed summaries never need the sections, even with a pushed code branch", () => {
  for (const status of ["blocked", "failed"]) {
    const s = setup();
    s.run("start", "--job", "j1");
    withProject(s);
    const f = join(s.root, "s.md");
    writeFileSync(f, "Stopped early.\n");
    const out = spawnSync("bash", [TOOL, "summary", "--status", status, f], {
      cwd: s.runner,
      env: { ...process.env, ...identity, HOME: s.root, ORBIT_JOB_STATE: join(s.root, "state"), ORBIT_JOB_SEARCH: s.root },
      encoding: "utf8",
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(s.remoteFile(".orbit/summary.md"), new RegExp(`status: ${status}`));
  }
});

test("--repo points at a checkout outside the search path; --code-branch forces the check", () => {
  const s = setup();
  s.run("start", "--job", "j1");
  const p = withProject(s);
  const away = join(tmpdir(), `orbit-away-${process.pid}`);
  execFileSync("mv", [p.checkout, away]);
  assert.equal(summarize(s, "no sections\n").status, 0, "not found by search, so not detected (documented limitation)");
  const viaRepo = summarize(s, "no sections\n", "--repo", away);
  assert.equal(viaRepo.status, 2);
  assert.match(viaRepo.stderr, /orbit\/j1 is on origin/);
  const forced = summarize(s, "no sections\n", "--code-branch");
  assert.equal(forced.status, 2);
  assert.match(forced.stderr, /--code-branch given/);
  assert.equal(summarize(s, GOOD, "--code-branch").status, 0);
});

test("a pushed branch is still detected from the remote-tracking ref when origin cannot be reached", () => {
  const s = setup();
  s.run("start", "--job", "j1");
  const p = withProject(s);
  git(p.checkout, "remote", "set-url", "origin", join(s.root, "gone.git"));
  const out = summarize(s, "no sections\n");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /remote-tracking ref/);
});

test("the heading match is as forgiving as ORBIT's: case and surrounding spaces, but a heading on its own line", () => {
  const s = setup();
  s.run("start", "--job", "j1");
  withProject(s);
  assert.equal(summarize(s, "  ## pr TITLE  \nAdd the widget to the dashboard\n\n## Pr Body\nAdds a widget to the dashboard so Rai can see jobs at a glance.\n").status, 0);
  assert.equal(summarize(s, "text ## PR title\nAdd the widget\n\n## PR body\nAdds a widget to the dashboard so Rai can see jobs.\n").status, 2);
});
