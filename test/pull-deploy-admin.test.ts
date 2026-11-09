import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Tier 2 modes of deploy/pull-deploy.sh: --rollback and --refresh-vault, run for real against a temp root with mocked
// systemctl and curl (the same approach as pull-deploy.test.ts). The successful-deploy history is covered here too.
const SCRIPT = new URL("../deploy/pull-deploy.sh", import.meta.url).pathname;
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();
const SYSTEMCTL = `#!/usr/bin/env bash
n="$(cat "$MOCK/restarts" 2>/dev/null || echo 0)"
case "$1" in
  restart)
    n=$((n + 1)); echo "$n" > "$MOCK/restarts"
    dir="$(readlink -f "$ORBIT_DEPLOY_ROOT/current")"
    if grep -qx "$n" "$MOCK/restart-fail" 2>/dev/null; then rm -f "$MOCK/served"; exit 1; fi
    echo "$dir" > "$MOCK/served" ;;
esac
`;
const CURL = `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  https://api.github.com/*) cat "$MOCK/checks.json" ;;
  http://*/status)
    n="$(cat "$MOCK/restarts" 2>/dev/null || echo 0)"
    if grep -qx "$n" "$MOCK/status-bad" 2>/dev/null; then exit 22; fi
    [ -f "$MOCK/served" ] || exit 7
    dir="$(cat "$MOCK/served")"
    printf '{"commit":"%s"}' "$(sed 's/^ORBIT_COMMIT=//' "$dir/release.env")" ;;
  *) echo "unexpected url $url" >&2; exit 99 ;;
esac
`;

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pull-deploy-admin-")));
  const root = join(base, "opt-orbit");
  const mock = join(base, "mock");
  const bin = join(base, "bin");
  const origin = join(base, "origin.git");
  const work = join(base, "work");
  for (const d of [root, mock, bin, join(root, "state"), join(root, "releases")]) mkdirSync(d, { recursive: true });
  for (const [name, body] of [["systemctl", SYSTEMCTL], ["curl", CURL]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
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
  const release = (sha: string) => {
    const dir = join(root, "releases", sha);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "COMMIT"), `${sha}\n`);
    writeFileSync(join(dir, "release.env"), `ORBIT_COMMIT=${sha}\n`);
    return dir;
  };
  const live = (dir: string) => {
    rmSync(join(root, "current"), { force: true });
    symlinkSync(dir, join(root, "current"));
    writeFileSync(join(mock, "served"), `${dir}\n`);
  };
  const env = () => ({ ...process.env, ...identity, PATH: `${bin}:${process.env.PATH}`, ORBIT_DEPLOY_ROOT: root, MOCK: mock, ORBIT_HEALTH_ATTEMPTS: "3", ORBIT_HEALTH_SLEEP: "0", ORBIT_LOCK_WAIT: "1" });
  const run = (...args: string[]) => {
    const r = spawnSync("bash", [SCRIPT, ...args], { env: env(), encoding: "utf8", timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const history = (...shas: string[]) => writeFileSync(join(root, "state", "history.jsonl"), shas.map((c) => JSON.stringify({ commit: c, at: "2026-11-01T00:00:00Z" })).join("\n") + "\n");
  const restarts = () => Number(existsSync(join(mock, "restarts")) ? readFileSync(join(mock, "restarts"), "utf8").trim() : 0);
  const current = () => realpathSync(join(root, "current"));
  const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);
  return { base, root, mock, commit, release, live, run, history, restarts, current, lines, env, state: (n: string) => join(root, "state", n) };
}

const fakeShas = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(40, "a").replace(/[^0-9a-f]/g, "a"));

function twoReleases() {
  const h = setup();
  const [a, b] = fakeShas(2) as [string, string];
  const aDir = h.release(a);
  const bDir = h.release(b);
  h.live(bDir);
  h.history(a, b);
  return { ...h, a, b, aDir, bDir };
}

test("--rollback switches to the previous release, verifies it, and marks the rolled-back commit so the timer does not redeploy it", () => {
  const h = twoReleases();
  const r = h.run("--rollback");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`rolled back from ${h.b} to ${h.a} \\(verified serving\\)`));
  assert.equal(h.current(), h.aDir);
  assert.equal(h.restarts(), 1);
  assert.deepEqual(h.lines(h.state("rejected")), [h.b]);
  assert.equal(readFileSync(h.state("failed"), "utf8").trim(), h.b);
  const deploy = JSON.parse(readFileSync(h.state("deploy.json"), "utf8"));
  assert.equal(deploy.lastDeployed.commit, h.a);
  assert.equal(deploy.lastRolledBack.commit, h.b);
});

test("a second rollback does not flip back to the release that was rolled back from", () => {
  const h = twoReleases();
  assert.equal(h.run("--rollback").code, 0);
  const again = h.run("--rollback");
  assert.equal(again.code, 64, again.out);
  assert.match(again.out, /no earlier known-good release/);
  assert.equal(h.current(), h.aDir);
  assert.equal(h.restarts(), 1);
});

test("--rollback is refused, with nothing changed, when there is no history, no usable earlier release, or a recorded rollback failure", () => {
  const h = twoReleases();
  rmSync(h.state("history.jsonl"));
  let r = h.run("--rollback");
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /no deploy history/);
  // history names a release whose directory is gone, or whose COMMIT disagrees
  h.history(h.a, h.b);
  rmSync(h.aDir, { recursive: true });
  r = h.run("--rollback");
  assert.equal(r.code, 64, r.out);
  const dir = h.release(h.a);
  writeFileSync(join(dir, "COMMIT"), `${"c".repeat(40)}\n`);
  assert.equal(h.run("--rollback").code, 64);
  writeFileSync(join(dir, "COMMIT"), `${h.a}\n`);
  writeFileSync(h.state("rollback-failed-x.json"), "{}");
  r = h.run("--rollback");
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /unresolved rollback failure/);
  assert.equal(h.restarts(), 0);
  assert.equal(h.current(), h.bDir);
});

test("--rollback whose target fails its health check restores the running release and says so", () => {
  const h = twoReleases();
  writeFileSync(join(h.mock, "status-bad"), "1\n");
  const r = h.run("--rollback");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /failed its health check/);
  assert.equal(h.current(), h.bDir);
  assert.equal(h.restarts(), 2);
  assert.equal(existsSync(h.state("rejected")), false);
});

test("--rollback where the restore also fails exits 2 and records the failure", () => {
  const h = twoReleases();
  writeFileSync(join(h.mock, "restart-fail"), "1\n2\n");
  const r = h.run("--rollback");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ROLLBACK FAILED/);
  assert.ok(readdirSync(join(h.root, "state")).some((f) => f.startsWith("rollback-failed-")), "the failure is recorded for an operator");
});

test("after a rollback the timer path does not redeploy the commit that was rolled back from", () => {
  const h = setup();
  const a = h.commit();
  const b = h.commit();
  h.release(a);
  const bDir = h.release(b);
  h.live(bDir);
  h.history(a, b);
  assert.equal(h.run("--rollback").code, 0);
  const restartsAfterRollback = h.restarts();
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(h.restarts(), restartsAfterRollback, "no redeploy of the rejected commit");
  assert.equal(h.current(), join(h.root, "releases", a));
});

test("a successful deploy appends to the history, seeding it with the release that was running", () => {
  const h = setup();
  const known = h.commit();
  h.live(h.release(known));
  const sha = h.commit();
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(h.lines(h.state("history.jsonl")).map((l) => JSON.parse(l).commit), [known, sha]);
});

function withVault() {
  const h = setup();
  const vaultOrigin = join(h.base, "vault-origin");
  mkdirSync(vaultOrigin);
  git(vaultOrigin, "init", "-q", "-b", "main");
  writeFileSync(join(vaultOrigin, "a.md"), "one\n");
  git(vaultOrigin, "add", ".");
  git(vaultOrigin, "commit", "-q", "-m", "v1");
  git(h.base, "clone", "-q", vaultOrigin, join(h.root, "vault"));
  const advance = () => {
    writeFileSync(join(vaultOrigin, "a.md"), `${Math.random()}\n`);
    git(vaultOrigin, "commit", "-qam", "v2");
    return git(vaultOrigin, "rev-parse", "HEAD");
  };
  return { ...h, advance };
}

test("--refresh-vault fast-forwards the vault copy and records the commit; it touches nothing else", () => {
  const h = withVault();
  const head = h.advance();
  const r = h.run("--refresh-vault");
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(readFileSync(h.state("vault.json"), "utf8"));
  assert.equal(rec.commit, head);
  assert.match(rec.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(h.restarts(), 0);
  assert.equal(existsSync(h.state("history.jsonl")), false);
});

test("--refresh-vault reports failure (1) and a missing vault (64) without writing a record", () => {
  const h = withVault();
  git(join(h.root, "vault"), "remote", "set-url", "origin", join(h.base, "does-not-exist"));
  assert.equal(h.run("--refresh-vault").code, 1);
  assert.equal(existsSync(h.state("vault.json")), false);
  rmSync(join(h.root, "vault"), { recursive: true });
  assert.equal(h.run("--refresh-vault").code, 64);
});

test("--rollback and --refresh-vault wait for the shared deploy lock, then refuse with 75", async () => {
  const h = twoReleases();
  const holder = spawn("flock", ["-x", join(h.root, "state", "deploy.lock"), "sleep", "6"]);
  await new Promise((r) => setTimeout(r, 400));
  const rb = h.run("--rollback");
  const rv = h.run("--refresh-vault");
  holder.kill();
  assert.equal(rb.code, 75, rb.out);
  assert.equal(rv.code, 75, rv.out);
  assert.equal(h.restarts(), 0);
});

test("unknown modes are still refused", () => {
  const h = setup();
  assert.equal(h.run("--bogus").code, 64);
});
