import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { DEFAULT_LIMITS, parseConfig } from "../src/workspace/config.ts";
import type { Limits, SandboxConfig } from "../src/workspace/config.ts";
import { openRoot, search } from "../src/workspace/fsops.ts";
import { bwrapSandbox, REQUIRED_FLAGS } from "../src/workspace/sandbox.ts";
import type { RunSpec, Sandbox } from "../src/workspace/sandbox.ts";
import { opLedger } from "../src/workspace/ledger.ts";
import { workspaceService } from "../src/workspace/service.ts";
import { maskVaultText } from "../src/vault/filter.ts";
import { proposals as newProposals } from "../src/agent.ts";
import { fakeSandbox, tick, wsRig } from "./workspace-fixture.ts";

// Independent security review of the workspace tools (docs/reviews/workspace-tools-security-review.md).
//
// Two kinds of tests live here:
//   * Regression tests for the sandbox startup race fixed before merge (the sandbox must never be "supported", and nothing but the
//     probe's own self-test may launch, until a self-test has passed). They drive the PRODUCTION launcher (bwrapSandbox) with stub
//     bubblewrap/prlimit binaries and a plain directory standing in for the cgroup, so they are deterministic on any Linux runner.
//     They test ORBIT's gating and supervision logic only. They are NOT evidence of OS isolation.
//   * Reproducers for findings of this review, marked `todo`. Each asserts the behaviour the review recommends, so it FAILS today
//     (reported as todo, not as a suite failure) and starts passing once the finding is fixed. Remove the todo marker then.
// Synthetic temporary directories only; nothing outside the test's own temp tree is read or written.

const GOOD_PROBE_OUTPUT = "uid=1000\nifaces=lo,\nprocs=2\nenv=HOME,LANG,LOGNAME,PATH,PWD,SHLVL,TMPDIR,USER,\nworkspace_writable\n";

type Rig = { base: string; sb: Sandbox; state: string; cg: string; setMode(mode: string): void; launches(): string[]; ws: string; spec(runId: string): RunSpec };

// A stub bubblewrap. `--version`/`--help` advertise every required option. Any other call is a launch: it reads the behaviour for this
// launch from the control file (the test writes it before each launch), logs "<mode> <runId>" and then:
//   pass-slow / pass-slower: sleeps, then prints a passing self-test transcript;  pass: the same at once;  fail: exits 1;  hang: execs a long sleep
//   (killed only by the launcher);  run: exits 0 (an ordinary command);  run-slow: sleeps, then exits 0.
function rig(): Rig {
  const base = mkdtempSync(join(tmpdir(), "orbit-wsreview-"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  const ctl = join(base, "mode");
  const log = join(base, "launches.log");
  writeFileSync(ctl, "fail\n");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "bwrap"),
    [
      "#!/bin/sh",
      `case "$1" in --version) echo "bubblewrap 0.11.0"; exit 0;; --help) echo "${REQUIRED_FLAGS.join(" ")}"; exit 0;; esac`,
      `mode=$(cat '${ctl}')`,
      // The run id is the directory holding the synthetic passwd file: <state>/runs/<runId>/passwd.
      'run=""; prev=""; for a in "$@"; do case "$a" in */runs/*/passwd) run=${a%/passwd}; run=${run##*/};; esac; done',
      `echo "$mode $run" >> '${log}'`,
      'case "$mode" in',
      `  pass-slow) sleep 0.4; printf '${GOOD_PROBE_OUTPUT.replace(/\n/g, "\\n")}'; exit 0;;`,
      `  pass) printf '${GOOD_PROBE_OUTPUT.replace(/\n/g, "\\n")}'; exit 0;;`,
      `  pass-slower) sleep 1.5; printf '${GOOD_PROBE_OUTPUT.replace(/\n/g, "\\n")}'; exit 0;;`,
      "  hang) exec sleep 30;;",
      "  run) exit 0;;",
      "  run-slow) sleep 0.4; exit 0;;",
      "  *) exit 1;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "prlimit"), `#!/bin/sh\n[ "$1" = --version ] && { echo prlimit; exit 0; }\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`, { mode: 0o755 });
  // A plain directory standing in for the delegated cgroup (no kernel enforcement: these tests are about gating, not isolation).
  const cg = join(base, "cg");
  mkdirSync(cg);
  writeFileSync(join(cg, "cgroup.controllers"), "cpu memory pids\n");
  writeFileSync(join(cg, "cgroup.subtree_control"), "cpu memory pids\n");
  const state = join(base, "state");
  mkdirSync(state, { mode: 0o700 });
  const ws = join(base, "ws");
  mkdirSync(ws, { mode: 0o700 });
  const config: SandboxConfig = { bwrap: join(bin, "bwrap"), prlimit: join(bin, "prlimit"), shell: "/bin/sh", runtime: ["/usr"], cgroupParent: cg, limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 };
  const sb = bwrapSandbox({ config, stateDir: state, uid: () => 1000 });
  const st = statSync(ws);
  return {
    base,
    sb,
    state,
    cg,
    ws,
    setMode: (m) => writeFileSync(ctl, `${m}\n`),
    launches: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    spec: (runId) => ({ runId, workspace: { id: "w", root: ws, exec: true, dev: st.dev, ino: st.ino, identity: "w" }, cwd: [], argv: ["true"], limits: { ...DEFAULT_LIMITS, timeoutSec: 30 } as Limits }),
  };
}

// Waits (without timers, so it also works under mocked timers) until `cond` holds, polling the event loop.
async function until(cond: () => boolean, what: string, maxMs = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > maxMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}
const nonProbe = (lines: string[]) => lines.filter((l) => !/ probe-/.test(l));

// ---- R: the startup race (regression tests) -------------------------------------------------------------------------------------

test("race R1: a sandbox that was never probed is 'unknown' and refuses to launch anything (no process is spawned)", async () => {
  const r = rig();
  r.setMode("run");
  assert.equal(r.sb.status().state, "unknown");
  const h = r.sb.start(r.spec("before-probe"));
  assert.equal(h.pid, undefined);
  assert.match(String((await h.done).startError), /not available/);
  assert.deepEqual(r.launches(), [], "nothing was launched");
});

test("race R2: during a slow PASSING self-test the public state stays 'unknown', only the probe launches, and runs start only after the verdict", async () => {
  const r = rig();
  r.setMode("pass-slow");
  const seen = new Set<string>();
  const pending = r.sb.probe();
  let settled = false;
  void pending.then(() => (settled = true));
  // Sample the public state and try ordinary launches for the whole probe window.
  const refused: (number | undefined)[] = [];
  while (!settled) {
    seen.add(r.sb.status().state);
    const h = r.sb.start(r.spec(`early-${refused.length}`));
    refused.push(h.pid);
    await new Promise((res) => setTimeout(res, 25));
  }
  const verdict = await pending;
  assert.equal(verdict.state, "supported", verdict.reasons.join("; "));
  assert.ok(refused.length >= 3, "the window was sampled several times");
  assert.ok(refused.every((p) => p === undefined), "no ordinary run started while the self-test ran");
  assert.deepEqual([...seen], ["unknown"], "the public state was only ever 'unknown' while the probe was pending");
  assert.equal(r.launches().length, 1, "exactly one launch (the probe's own self-test) happened during the window");
  assert.match(r.launches()[0]!, /^pass-slow probe-/);
  // After the verdict an ordinary run is allowed.
  r.setMode("run");
  const h = r.sb.start(r.spec("after"));
  assert.notEqual(h.pid, undefined);
  const exit = await h.done;
  assert.equal(exit.code, 0);
  assert.deepEqual(nonProbe(r.launches()), ["run after"]);
});

test("race R3: a self-test killed by the probe's timeout ends 'unsupported', never 'supported'", async () => {
  const r = rig();
  r.setMode("hang");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = r.sb.probe();
    await until(() => r.launches().length === 1, "the self-test to start");
    assert.equal(r.sb.status().state, "unknown");
    mock.timers.tick(20_000); // the probe's own wall-clock limit
    const verdict = await pending;
    assert.equal(verdict.state, "unsupported");
    assert.match(verdict.reasons.join(" "), /self-test did not run/);
  } finally {
    mock.timers.reset();
  }
  assert.equal(r.sb.start(r.spec("after-timeout")).pid, undefined);
});

test("race R4: a failed self-test and a self-test with a bad transcript both end 'unsupported'", async () => {
  for (const mode of ["fail", "run"]) {
    const r = rig();
    r.setMode(mode);
    const verdict = await r.sb.probe();
    assert.equal(verdict.state, "unsupported", mode);
    assert.equal(r.sb.start(r.spec("x")).pid, undefined, mode);
    assert.deepEqual(nonProbe(r.launches()), [], mode);
  }
});

test("race R5: a re-probe makes the state 'unknown' at once; an exec confirmed during it is refused and never launched", async () => {
  const r = rig();
  r.setMode("pass");
  assert.equal((await r.sb.probe()).state, "supported");
  const rr = wsRig({ sandbox: r.sb as unknown as ReturnType<typeof fakeSandbox> });
  const p = (await rr.call("exec_start", { workspace: "alpha", argv: ["true"] })).value;
  assert.equal(p.status, "pending-confirmation");
  r.setMode("pass-slow");
  const reprobe = r.sb.probe();
  assert.equal(r.sb.status().state, "unknown");
  const out = await rr.svc.confirm(rr.proposals.take(p.proposalId) as never);
  assert.equal(out.code, 409);
  assert.match(String(out.body.error), /sandbox is unavailable/);
  assert.equal(rr.svc.ledger.get(String(out.body.opId))!.state, "failed");
  assert.equal((await reprobe).state, "supported");
  assert.deepEqual(nonProbe(r.launches()), [], "the confirmed command was never launched");
});

test("race R6: a run queued before a re-probe and dequeued during it is refused at start (not_started), never launched", async () => {
  const r = rig();
  r.setMode("pass");
  assert.equal((await r.sb.probe()).state, "supported");
  const rr = wsRig({ sandbox: r.sb as unknown as ReturnType<typeof fakeSandbox>, maxConcurrentRuns: 1 });
  const p1 = (await rr.call("exec_start", { workspace: "alpha", argv: ["true"] })).value;
  const p2 = (await rr.call("exec_start", { workspace: "beta", argv: ["true"] })).value;
  r.setMode("run-slow");
  const c1 = await rr.svc.confirm(rr.proposals.take(p1.proposalId) as never);
  await until(() => r.launches().length === 2, "the first run to start");
  const c2 = await rr.svc.confirm(rr.proposals.take(p2.proposalId) as never);
  assert.equal(c2.body.state, "queued");
  r.setMode("pass-slower");
  const reprobe = r.sb.probe(); // the state is "unknown" until this verdict (it outlasts the first run)
  await rr.svc.idle();
  const e1 = rr.svc.ledger.get(String(c1.body.opId))!;
  const e2 = rr.svc.ledger.get(String(c2.body.opId))!;
  assert.equal(e1.state, "completed");
  assert.equal(e2.state, "failed");
  assert.match(String(e2.reason), /^not_started: The sandbox is not available/);
  await reprobe;
  assert.deepEqual(nonProbe(r.launches()).map((l) => l.split(" ")[1]), [String(c1.body.opId)], "only the first run was launched");
});

test("race R7: restart: a new launcher instance starts 'unknown' and refuses runs even while another instance (same state dir) is mid-probe", async () => {
  const r = rig();
  r.setMode("pass-slow");
  const pending = r.sb.probe();
  const restarted = bwrapSandbox({ config: { bwrap: join(r.base, "bin", "bwrap"), prlimit: join(r.base, "bin", "prlimit"), shell: "/bin/sh", runtime: ["/usr"], cgroupParent: r.cg, limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 }, stateDir: r.state, uid: () => 1000 });
  assert.equal(restarted.status().state, "unknown");
  assert.equal(restarted.start(r.spec("restart-run")).pid, undefined);
  assert.equal((await pending).state, "supported");
  assert.equal(restarted.status().state, "unknown", "another instance's verdict does not carry over");
  assert.deepEqual(nonProbe(r.launches()), []);
});

test("race R8: the probe refuses to self-test as root: no launch, verdict 'unsupported'", async () => {
  const r = rig();
  r.setMode("pass");
  const asRoot = bwrapSandbox({ config: { bwrap: join(r.base, "bin", "bwrap"), prlimit: join(r.base, "bin", "prlimit"), shell: "/bin/sh", runtime: ["/usr"], cgroupParent: r.cg, limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 }, stateDir: r.state, uid: () => 0 });
  const v = await asRoot.probe();
  assert.equal(v.state, "unsupported");
  assert.match(v.reasons.join(" "), /root/);
  assert.deepEqual(r.launches(), []);
});

test("race R9: service level: exec_start is refused while the sandbox is 'unknown' (startup) and no proposal is made", async () => {
  const r = rig();
  const rr = wsRig({ sandbox: r.sb as unknown as ReturnType<typeof fakeSandbox> });
  await assert.rejects(rr.call("exec_start", { workspace: "alpha", argv: ["true"] }), /sandbox_unsupported/);
  assert.equal(rr.proposals.list().length, 0);
});

// ---- Findings of this review (todo: they fail until fixed) ---------------------------------------------------------------------

test("finding WS-R1: overlapping probes: an older passing self-test must not overwrite a newer failing verdict", { todo: "WS-R1: probe() has no generation guard; last finisher wins" }, async () => {
  const r = rig();
  r.setMode("pass-slow");
  const first = r.sb.probe();
  await until(() => r.launches().length === 1, "the first self-test to start");
  await new Promise((res) => setTimeout(res, 5)); // distinct probe run id (it is derived from the clock)
  r.setMode("fail");
  const second = r.sb.probe();
  await Promise.all([first, second]);
  assert.equal(r.sb.status().state, "unsupported", "the most recent self-test failed, so the sandbox must not be supported");
});

test("finding WS-R1b: overlapping probes: the state must not be 'supported' while a newer self-test is still running", { todo: "WS-R1: probe() has no generation guard" }, async () => {
  const r = rig();
  r.setMode("pass-slow");
  const first = r.sb.probe();
  await until(() => r.launches().length === 1, "the first self-test to start");
  await new Promise((res) => setTimeout(res, 5));
  r.setMode("hang");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const second = r.sb.probe();
    await first;
    const during = r.sb.status().state;
    const h = r.sb.start(r.spec("during-second-probe"));
    if (h.pid !== undefined) h.kill("cancel");
    mock.timers.tick(20_000);
    await second;
    assert.notEqual(during, "supported", "a self-test was still running");
    assert.equal(h.pid, undefined, "no ordinary run may start while a self-test is running");
  } finally {
    mock.timers.reset();
  }
});

test("finding WS-R2: a probe that throws must not leave the stale reason 'the sandbox self-test is running'", { todo: "WS-R2: probe exceptions are swallowed (select.ts) and the reason stays stale" }, async () => {
  const r = rig();
  r.setMode("pass");
  const file = join(r.base, "not-a-dir");
  writeFileSync(file, "x");
  // The state directory is a regular file, so preparing the probe's workspace throws.
  const sb = bwrapSandbox({ config: { bwrap: join(r.base, "bin", "bwrap"), prlimit: join(r.base, "bin", "prlimit"), shell: "/bin/sh", runtime: ["/usr"], cgroupParent: r.cg, limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 }, stateDir: file, uid: () => 1000 });
  await sb.probe().catch(() => undefined);
  assert.notEqual(sb.status().state, "supported"); // fail closed holds today
  assert.equal(sb.status().state, "unsupported", "a probe that could not complete is a failed probe");
  assert.doesNotMatch(sb.status().reasons.join(" "), /self-test is running/);
});

test("finding WS-R3: fs_search must bound the number of entries it visits, not only regular files", { todo: "WS-R3: links, special files and directories do not count toward any limit" }, () => {
  const base = mkdtempSync(join(tmpdir(), "orbit-wsreview-search-"));
  const root = join(base, "ws");
  mkdirSync(root, { mode: 0o700 });
  const N = 2500; // more than SEARCH_LIMITS.files (2000)
  for (let i = 0; i < N; i++) symlinkSync("nowhere", join(root, `l${i}`));
  const st = statSync(root);
  const r = openRoot(root, { dev: st.dev, ino: st.ino });
  try {
    const out = search(r, [], "needle");
    const visited = Object.values(out.skipped as Record<string, number>).reduce((a, b) => a + b, 0) + out.filesSearched;
    assert.ok(visited <= 2000 && !out.complete, `visited ${visited} entries and reported complete=${out.complete}`);
  } finally {
    r.close();
  }
});

test("finding WS-R4: restart recovery must not act on ledger opIds outside its own namespace (path traversal in reap)", { todo: "WS-R4: ledger opIds are not validated before reap() joins them into paths" }, async () => {
  const r = rig();
  const victim = join(r.state, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep.txt"), "canary");
  // A tampered ledger: an in-flight exec whose opId climbs out of <state>/runs.
  const ledgerDir = join(r.base, "svc-state");
  mkdirSync(ledgerDir, { mode: 0o700 });
  const at = "2026-11-19T00:00:00.000Z";
  writeFileSync(join(ledgerDir, "ledger.json"), JSON.stringify({ schema: 1, entries: [{ opId: "../victim", proposalId: "p", kind: "exec", workspace: "w", digest: "sha256:x", state: "running", createdAt: at, updatedAt: at, events: [{ at, state: "starting" }], summary: "s" }] }));
  const svc = workspaceService({ activation: { state: "enabled", config: { workspaces: [], sandbox: { bwrap: "", prlimit: "", shell: "", runtime: [], cgroupParent: r.cg, limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 }, policyHash: "sha256:x" } }, sandbox: r.sb, ledger: opLedger(ledgerDir), proposals: newProposals() });
  svc.recover();
  assert.ok(existsSync(join(victim, "keep.txt")), "a directory outside <state>/runs was deleted by restart recovery");
});

test("finding WS-R5: an approval card must not render bidi/invisible control characters raw (they can disguise what runs)", { todo: "WS-R5: card fields are shown verbatim; Trojan-Source style text is accepted" }, async () => {
  const rr = wsRig();
  const script = `echo safe # ‮;rm -rf data⁦\n`;
  let proposed = false;
  try {
    const p = (await rr.call("exec_start", { workspace: "alpha", argv: ["sh", "/run/orbit/script"], script })).value;
    proposed = true;
    const shown = Object.values(rr.proposal(p.proposalId).display).join("\n");
    assert.ok(!/[‪-‮⁦-⁩​-‏]/.test(shown), "bidi/zero-width characters reach the card unescaped");
  } catch (e) {
    if (proposed) throw e; // refusing the proposal outright is an acceptable fix
  }
});

test("finding WS-R6: audit lines must not carry model-chosen path text unmasked (journal privacy)", { todo: "WS-R6: denial details include the error message, which echoes the path" }, async () => {
  const rr = wsRig();
  const secretShaped = "ghp_" + "Ab1".repeat(12); // built at runtime; credential-shaped only
  assert.notEqual(maskVaultText(secretShaped), secretShaped, "precondition: the vault filter masks this shape");
  await assert.rejects(rr.call("fs_patch", { workspace: "alpha", path: `${secretShaped}/x.txt`, expectedVersion: `sha256:${"0".repeat(64)}`, edits: [{ find: "a", replace: "b" }] }));
  const lines = rr.audits.map((a) => JSON.stringify(a));
  assert.ok(lines.length > 0, "a denial was audited");
  assert.ok(!lines.some((l) => l.includes(secretShaped)), "an audit line carries the credential-shaped path verbatim");
});

test("finding WS-R7: workspace roots under /proc (or /sys, /dev, /etc, /run, /boot) must be refused, not only those exact paths", { todo: "WS-R7: FORBIDDEN_ROOTS is an equality check" }, () => {
  const fdDir = `/proc/${process.pid}/fd`;
  const owner = statSync(fdDir).uid;
  assert.throws(() => parseConfig(JSON.stringify({ workspaces: [{ id: "procfd", root: fdDir, exec: false }] }), { uid: () => owner, protectedPaths: [] }), /cannot be a workspace root|not allowed|refused/);
});

test("review check: a held write proposal is refused when the file changed after it was proposed (version precondition at run time)", async () => {
  // Sanity check that the version precondition, not the card, protects writes confirmed after a run changed the file.
  const sb = fakeSandbox();
  const rr = wsRig({ sandbox: sb });
  const v = (await rr.call("fs_read", { workspace: "alpha", path: "notes.txt" })).value.version;
  const w = (await rr.call("fs_write", { workspace: "alpha", path: "notes.txt", content: "new\n", expectedVersion: v })).value;
  writeFileSync(join(rr.a.root, "notes.txt"), "changed by a command\n");
  await tick();
  const out = await rr.svc.confirm(rr.proposals.take(w.proposalId) as never);
  assert.equal(out.code, 409);
  assert.equal(readFileSync(join(rr.a.root, "notes.txt"), "utf8"), "changed by a command\n");
});
