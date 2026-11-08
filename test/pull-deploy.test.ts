import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("../deploy/pull-deploy.sh", import.meta.url).pathname;
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();

// Mocked systemctl: "restart" points a fake service at whatever current resolves to. Mocked curl: GitHub checks and /status,
// where /status serves the commit in the running release's release.env (as the real app does) unless a knob says otherwise.
// Knobs live in $MOCK: restart-fail (restart numbers that fail), status-bad (restart numbers after which /status is 503),
// hang (status never answers), serve-commit-file (serve COMMIT instead of release.env), checks.json.
const SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >> "$MOCK/systemctl.log"
n="$(cat "$MOCK/restarts" 2>/dev/null || echo 0)"
case "$1" in
  restart)
    n=$((n + 1)); echo "$n" > "$MOCK/restarts"
    dir="$(readlink -f "$ORBIT_DEPLOY_ROOT/current")"
    echo "$dir" >> "$MOCK/served.log"
    if grep -qx "$n" "$MOCK/restart-fail" 2>/dev/null; then rm -f "$MOCK/served"; exit 1; fi
    echo "$dir" > "$MOCK/served" ;;
  stop) rm -f "$MOCK/served" ;;
esac
`;
const CURL = `#!/usr/bin/env bash
echo "$*" >> "$MOCK/curl.log"
url="\${@: -1}"
max=""; prev=""
for a in "$@"; do [ "$prev" = --max-time ] && max="$a"; prev="$a"; done
case "$url" in
  https://api.github.com/*) cat "$MOCK/checks.json" ;;
  http://*/status)
    echo "status" >> "$MOCK/status.log"
    if [ -f "$MOCK/hang" ]; then sleep "\${max:-30}"; exit 28; fi
    n="$(cat "$MOCK/restarts" 2>/dev/null || echo 0)"
    if grep -qx "$n" "$MOCK/status-bad" 2>/dev/null; then exit 22; fi
    [ -f "$MOCK/served" ] || exit 7
    dir="$(cat "$MOCK/served")"
    if [ -f "$MOCK/serve-commit-file" ]; then c="$(cat "$dir/COMMIT")"; else c="$(sed 's/^ORBIT_COMMIT=//' "$dir/release.env")"; fi
    printf '{"commit":"%s"}' "$c" ;;
  *) echo "unexpected url $url" >&2; exit 99 ;;
esac
`;

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pull-deploy-")));
  const root = join(base, "opt-orbit");
  const mock = join(base, "mock");
  const bin = join(base, "bin");
  const origin = join(base, "origin.git");
  const work = join(base, "work");
  for (const d of [root, mock, bin, join(root, "state"), join(root, "releases")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "systemctl"), SYSTEMCTL);
  writeFileSync(join(bin, "curl"), CURL);
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(root, "orbit.env"), "HOST=127.0.0.1\nPORT=8790\n");
  writeFileSync(join(mock, "checks.json"), JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }));
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, work);
  git(base, "clone", "-q", origin, join(root, "repo"));
  let n = 0;
  const commit = () => {
    writeFileSync(join(work, "app.txt"), `v${++n}\n`);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", `c${n}`);
    git(work, "push", "-q", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  const release = (sha: string, ageSeconds = 0) => {
    const dir = join(root, "releases", sha);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "COMMIT"), `${sha}\n`);
    writeFileSync(join(dir, "release.env"), `ORBIT_COMMIT=${sha}\n`);
    writeFileSync(join(dir, "app.txt"), "known-good\n");
    const t = new Date(Date.now() - ageSeconds * 1000);
    utimesSync(dir, t, t);
    return dir;
  };
  const live = (dir: string) => {
    symlinkSync(dir, join(root, "current"));
    writeFileSync(join(mock, "served"), `${dir}\n`);
  };
  const knob = (name: string, value = "") => writeFileSync(join(mock, name), value);
  const read = (...p: string[]) => readFileSync(join(...p), "utf8");
  const lines = (path: string) => (existsSync(path) ? read(path).split("\n").filter(Boolean) : []);
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env, ...identity, PATH: `${bin}:${process.env.PATH}`, ORBIT_DEPLOY_ROOT: root, MOCK: mock,
    ORBIT_HEALTH_ATTEMPTS: "3", ORBIT_HEALTH_SLEEP: "0", ...extra,
  });
  const run = (args: string[] = [], extra: Record<string, string> = {}) => {
    const r = spawnSync("bash", [SCRIPT, ...args], { env: env(extra), encoding: "utf8", timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const state = (name: string) => join(root, "state", name);
  const restarts = () => Number(lines(join(mock, "restarts"))[0] ?? 0);
  const current = () => realpathSync(join(root, "current"));
  const failureArtifacts = () => readdirSync(join(root, "state")).filter((f) => f.startsWith("rollback-failed-") && f.endsWith(".json"));
  const snap = (dir: string) => execFileSync("find", [dir, "-printf", "%p %s %T@\n"], { encoding: "utf8" }).split("\n").sort().join("\n");
  return { base, root, mock, origin, commit, release, live, knob, read, lines, run, env, state, restarts, current, failureArtifacts, snap };
}

// A healthy host: known-good release running, then a newer green commit on main.
function host() {
  const h = setup();
  const known = h.commit();
  const knownDir = h.release(known, 3600);
  h.live(knownDir);
  return { ...h, known, knownDir };
}

test("normal deployment switches to the new release and records it", () => {
  const h = host();
  const sha = h.commit();
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`deploy: ${sha} is live`));
  assert.equal(h.current(), join(h.root, "releases", sha));
  assert.equal(h.read(h.root, "releases", sha, "COMMIT").trim(), sha);
  assert.equal(h.read(h.root, "releases", sha, "release.env").trim(), `ORBIT_COMMIT=${sha}`);
  assert.equal(JSON.parse(h.read(h.state("deploy.json"))).lastDeployed.commit, sha);
  assert.equal(existsSync(h.state("failed")), false);
  assert.equal(h.restarts(), 1);
});

test("a main commit equal to the running one is a no-op that does not touch the release directory", () => {
  const h = host();
  const before = h.snap(h.knownDir);
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(h.restarts(), 0);
  assert.equal(h.snap(h.knownDir), before);
  assert.equal(h.current(), h.knownDir);
});

test("the running release directory is never rebuilt, even if its COMMIT file disagrees", () => {
  const h = host();
  h.commit();
  const sha = h.commit();
  const dir = h.release(sha);
  writeFileSync(join(dir, "COMMIT"), "something-else\n");
  // current -> releases/<sha> but COMMIT differs, so the equal-SHA guard alone would not save it
  execFileSync("rm", ["-f", join(h.root, "current")]);
  h.live(dir);
  const before = h.snap(dir);
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /refusing to rebuild/);
  assert.equal(h.snap(dir), before);
  assert.equal(h.restarts(), 0);
});

test("a commit already recorded as failed is skipped without a new release or restart", () => {
  const h = host();
  const sha = h.commit();
  writeFileSync(h.state("failed"), `${sha}\n`);
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(join(h.root, "releases", sha)), false);
  assert.equal(h.restarts(), 0);
  assert.equal(h.current(), h.knownDir);
});

test("checks that are not green block the deploy", () => {
  const h = host();
  const sha = h.commit();
  h.knob("checks.json", JSON.stringify({ check_runs: [{ status: "completed", conclusion: "failure" }] }));
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /checks are failure; not deploying/);
  assert.equal(existsSync(join(h.root, "releases", sha)), false);
});

test("candidate smoke failure rolls back, verifies the restored commit and marks the SHA failed", () => {
  const h = host();
  const sha = h.commit();
  h.knob("status-bad", "1\n");
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /failed its smoke test/);
  assert.match(r.out, new RegExp(`rolled back to ${h.known} \\(verified serving\\)`));
  assert.equal(h.current(), h.knownDir);
  assert.equal(h.restarts(), 2);
  assert.equal(h.read(h.state("failed")).trim(), sha);
  const deploy = JSON.parse(h.read(h.state("deploy.json")));
  assert.equal(deploy.lastFailed.commit, sha);
  assert.equal(deploy.lastDeployed, undefined);
  assert.deepEqual(h.failureArtifacts(), []);
});

test("candidate restart failure rolls back instead of exiting early", () => {
  const h = host();
  const sha = h.commit();
  h.knob("restart-fail", "1\n");
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /failed to restart on candidate/);
  assert.match(r.out, new RegExp(`rolled back to ${h.known} \\(verified serving\\)`));
  assert.equal(h.current(), h.knownDir);
  assert.equal(h.read(h.state("failed")).trim(), sha);
  assert.equal(h.restarts(), 2);
});

test("a failed SHA is not retried on the next run", () => {
  const h = host();
  h.commit();
  h.knob("status-bad", "1\n");
  assert.equal(h.run().code, 1);
  const restarts = h.restarts();
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(h.restarts(), restarts);
});

test("rollback restart failure is reported loudly, keeps recovery details and never claims success", () => {
  const h = host();
  const sha = h.commit();
  h.knob("status-bad", "1\n");
  h.knob("restart-fail", "2\n");
  const r = h.run();
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ROLLBACK FAILED: orbit failed to restart on the known-good release/);
  assert.doesNotMatch(r.out, /is live|verified serving/);
  const [artifact] = h.failureArtifacts();
  assert.ok(artifact, "recovery artifact written");
  const info = JSON.parse(h.read(h.state(artifact)));
  assert.equal(info.knownGoodTarget, h.knownDir);
  assert.equal(info.knownGoodCommit, h.known);
  assert.equal(info.mode, "deploy");
  assert.equal(h.read(h.state("failed")).trim(), sha);
  assert.equal(JSON.parse(h.read(h.state("deploy.json"))).lastDeployed, undefined);
  assert.ok(existsSync(join(h.root, "releases", h.known, "COMMIT")), "known-good release preserved");
  assert.ok(existsSync(join(h.root, "releases", sha)), "failed candidate preserved for inspection");
});

test("rollback that restarts but does not serve the known-good commit is a rollback failure", () => {
  const h = host();
  h.commit();
  h.knob("status-bad", "1\n2\n");
  const r = h.run();
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, new RegExp(`ROLLBACK FAILED: known-good ${h.known} is not served`));
  assert.doesNotMatch(r.out, /verified serving/);
  assert.equal(h.failureArtifacts().length, 1);
});

test("an unresponsive endpoint is bounded by attempts and curl timeouts", () => {
  const h = host();
  h.commit();
  h.knob("hang");
  const started = Date.now();
  const r = h.run([], { ORBIT_HEALTH_ATTEMPTS: "2", ORBIT_CURL_MAX_TIME: "1", ORBIT_CURL_CONNECT_TIMEOUT: "1" });
  assert.ok(Date.now() - started < 30_000, "finished in bounded time");
  assert.equal(r.code, 2, r.out); // nothing ever answers, so rollback cannot be verified either
  assert.equal(h.lines(join(h.mock, "status.log")).length, 4); // 2 attempts for the candidate + 2 for the rollback
  const statusCalls = h.lines(join(h.mock, "curl.log")).filter((l) => l.includes("/status"));
  assert.equal(statusCalls.length, 4);
  for (const call of statusCalls) assert.match(call, /--connect-timeout 1 --max-time 1/);
  assert.match(r.out, /ROLLBACK FAILED/);
});

test("the GitHub check lookup has timeouts too", () => {
  const h = host();
  h.commit();
  h.run();
  const github = h.lines(join(h.mock, "curl.log")).filter((l) => l.includes("api.github.com"));
  assert.equal(github.length, 1);
  assert.match(github[0], /--connect-timeout \d+ --max-time \d+/);
});

test("overlapping runs: the timer path skips when the lock is held and changes nothing", async () => {
  const h = host();
  h.commit();
  const holder = spawn("flock", [h.state("deploy.lock"), "sleep", "20"]);
  await new Promise((r) => setTimeout(r, 500));
  try {
    const before = h.snap(join(h.root, "releases"));
    const r = h.run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /holds .*deploy\.lock; not running/);
    assert.equal(h.restarts(), 0);
    assert.equal(h.snap(join(h.root, "releases")), before);
  } finally {
    holder.kill();
  }
});

test("overlapping runs: a drill waits a bounded time, then refuses with 75 and touches nothing", async () => {
  const h = host();
  const holder = spawn("flock", [h.state("deploy.lock"), "sleep", "20"]);
  await new Promise((r) => setTimeout(r, 500));
  try {
    const started = Date.now();
    const r = h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known, ORBIT_LOCK_WAIT: "1" });
    assert.equal(r.code, 75, r.out);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(h.restarts(), 0);
    assert.equal(existsSync(join(h.root, "drill")), false);
  } finally {
    holder.kill();
  }
});

test("drill: opt-in is explicit and tied to the recorded known-good commit", () => {
  const h = host();
  for (const confirm of [undefined, "yes", "0".repeat(40)]) {
    const r = h.run(["--drill"], confirm === undefined ? {} : { ORBIT_DRILL_CONFIRM: confirm });
    assert.equal(r.code, 64, r.out);
    assert.match(r.out, /refused: set ORBIT_DRILL_CONFIRM/);
  }
  assert.equal(h.run(["--bogus"]).code, 64);
  assert.equal(h.restarts(), 0);
  assert.equal(h.current(), h.knownDir);
});

test("drill: refuses to start from an unhealthy service", () => {
  const h = host();
  h.knob("status-bad", "0\n");
  const r = h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known });
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /not currently served/);
  assert.equal(h.restarts(), 0);
});

test("drill: injects the failure into a separate candidate, rolls back through the shared flow and verifies recovery", () => {
  const h = host();
  const before = h.snap(h.knownDir);
  const r = h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /failure injection: candidate .* must fail its smoke test/);
  assert.match(r.out, /injected candidate failure observed; rollback verified, serving/);
  assert.match(r.out, /drill: PASSED/);
  // same rollback code and wording as a real deployment
  assert.match(r.out, new RegExp(`deploy: rolled back to ${h.known} \\(verified serving\\)`));
  // exactly one injected candidate, living outside releases/, then the known-good directory again
  const served = h.lines(join(h.mock, "served.log"));
  assert.equal(served.length, 2);
  assert.ok(served[0].startsWith(join(h.root, "drill") + "/"), served[0]);
  assert.equal(served[1], h.knownDir);
  assert.equal(h.current(), h.knownDir);
  assert.equal(h.snap(h.knownDir), before, "known-good release untouched");
  assert.deepEqual(readdirSync(join(h.root, "releases")), [h.known]);
  assert.deepEqual(readdirSync(join(h.root, "drill")), [], "candidate removed after a passed drill");
  assert.equal(JSON.parse(h.read(h.state("drill"), "last.json")).passed.commit, h.known);
  assert.equal(existsSync(h.state("drill/in-progress.json")), false);
});

test("drill: never touches normal deploy state, and normal deploys resume afterwards", () => {
  const h = host();
  assert.equal(h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known }).code, 0);
  assert.equal(existsSync(h.state("failed")), false);
  assert.equal(existsSync(h.state("deploy.json")), false);
  const sha = h.commit();
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`${sha} is live`));
  assert.equal(h.current(), join(h.root, "releases", sha));
});

test("drill: the failure is candidate-only and a drill never retries itself", () => {
  const h = host();
  for (let i = 1; i <= 2; i++) {
    const r = h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known });
    assert.equal(r.code, 0, r.out);
    assert.equal(h.restarts(), 2 * i, "one candidate restart and one rollback restart per drill");
  }
  // the timer path never starts a drill
  assert.equal(h.run().code, 0);
  assert.equal(h.restarts(), 4);
  assert.equal(h.read(h.knownDir, "COMMIT").trim(), h.known);
});

test("drill: rollback restart failure is reported, candidate and artifacts are kept, and drills are blocked until cleared", () => {
  const h = host();
  h.knob("restart-fail", "2\n");
  const r = h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ROLLBACK FAILED/);
  assert.match(r.out, /drill: FAILED: recovery not verified/);
  assert.doesNotMatch(r.out, /PASSED/);
  assert.equal(h.failureArtifacts().length, 1);
  assert.equal(JSON.parse(h.read(h.state("drill"), "last.json"))["rollback-failed"].commit, h.known);
  assert.equal(readdirSync(join(h.root, "drill")).filter((f) => f !== "in-progress.json").length, 1, "candidate kept");
  assert.ok(existsSync(join(h.knownDir, "COMMIT")));
  const again = h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known });
  assert.equal(again.code, 64, again.out);
  assert.match(again.out, /unresolved rollback failure/);
});

test("drill: if it was interrupted, the next normal run restores the known-good release first", () => {
  const h = host();
  h.knob("restart-fail", "2\n"); // the drill's own rollback fails, leaving current on the candidate
  assert.equal(h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known }).code, 2);
  h.knob("restart-fail", "");
  h.knob("status-bad", "");
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /earlier drill was interrupted; restoring/);
  assert.match(r.out, new RegExp(`rolled back to ${h.known} \\(verified serving\\)`));
  assert.equal(h.current(), h.knownDir);
  assert.equal(existsSync(h.state("drill/in-progress.json")), false);
});

test("drill: if the injection does not fail the candidate, known-good is still restored and it is reported", () => {
  const h = host();
  h.knob("serve-commit-file"); // the candidate serves its COMMIT (the sentinel), so its smoke test passes
  const r = h.run(["--drill"], { ORBIT_DRILL_CONFIRM: h.known });
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /INJECTION INEFFECTIVE/);
  assert.match(r.out, new RegExp(`rolled back to ${h.known} \\(verified serving\\)`));
  assert.doesNotMatch(r.out, /PASSED/);
  assert.equal(h.current(), h.knownDir);
  assert.ok(Object.hasOwn(JSON.parse(h.read(h.state("drill"), "last.json")), "injection-ineffective"));
  assert.equal(existsSync(h.state("failed")), false);
});

test("cleanup keeps five releases but never the running release or the rollback target", () => {
  const h = setup();
  const shas = Array.from({ length: 7 }, () => h.commit());
  shas.forEach((sha, i) => h.release(sha, (7 - i) * 1000)); // shas[0] is the oldest
  h.live(join(h.root, "releases", shas[0]));
  const sha = h.commit();
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  const left = readdirSync(join(h.root, "releases")).sort();
  assert.ok(left.includes(sha) && left.includes(shas[0]), "new release and oldest known-good rollback target kept");
  assert.equal(existsSync(join(h.root, "releases", shas[1])), false);
  assert.equal(existsSync(join(h.root, "releases", shas[2])), false);
  assert.equal(left.length, 6);
});

test("a failed deploy leaves old releases alone", () => {
  const h = host();
  const older = Array.from({ length: 6 }, () => h.commit());
  older.forEach((sha, i) => h.release(sha, (7 - i) * 100));
  h.commit();
  h.knob("status-bad", "1\n");
  assert.equal(h.run().code, 1);
  assert.equal(readdirSync(join(h.root, "releases")).length, 8);
});
