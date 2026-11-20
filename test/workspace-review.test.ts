import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { DEFAULT_LIMITS, parseConfig } from "../src/workspace/config.ts";
import type { Limits, SandboxConfig } from "../src/workspace/config.ts";
import { listDir, LIST_SCAN_MAX, openRoot, search, snapshot, SNAPSHOT_LIMITS, WorkspaceFsError } from "../src/workspace/fsops.ts";
import { bwrapSandbox, childPath, REQUIRED_FLAGS } from "../src/workspace/sandbox.ts";
import type { RunSpec, Sandbox } from "../src/workspace/sandbox.ts";
import { LedgerError, opLedger } from "../src/workspace/ledger.ts";
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
//   * Reproducers for findings of this review. They were `todo` (failing by design) until the findings were fixed; they are now
//     ordinary regression tests (docs/reviews/workspace-tools-security-review.md, section 9).
// Synthetic temporary directories only; nothing outside the test's own temp tree is read or written.

const GOOD_PROBE_OUTPUT = "uid=1000\nifaces=lo,\nprocs=2\ncapeff=0000000000000000\ncapbnd=0000000000000000\nnnp=1\ncgroup=0::/\nenv=HOME,LANG,LOGNAME,PATH,PWD,SHLVL,TMPDIR,USER,\nworkspace_writable\n";

type Rig = { base: string; sb: Sandbox; state: string; cg: string; setMode(mode: string): void; launches(): string[]; ws: string; spec(runId: string): RunSpec };
// Run ids must be ORBIT's own shape (WS-R4): readable names map to a fixed 16-hex suffix.
const rid = (name: string) => `ws-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;

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
    spec: (name) => ({ runId: rid(name), workspace: { id: "w", root: ws, exec: true, dev: st.dev, ino: st.ino, identity: "w" }, cwd: [], argv: ["true"], limits: { ...DEFAULT_LIMITS, timeoutSec: 30 } as Limits }),
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
  assert.deepEqual(nonProbe(r.launches()), [`run ${rid("after")}`]);
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
  // Since WS-R11's fix the sandbox state and policy are compared again at dequeue, so the run is refused before any start attempt.
  assert.match(String(e2.reason), /^sandbox_changed: /);
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

// ---- Findings of this review (fixed; regression tests) --------------------------------------------------------------------------

// The findings below were `todo` reproducers in the review; they are fixed (docs/reviews/workspace-tools-security-review.md, section 9)
// and are now ordinary regression tests.

test("finding WS-R1 (fixed): overlapping probes: an older passing self-test does not overwrite a newer failing verdict", async () => {
  const r = rig();
  r.setMode("pass-slow");
  const first = r.sb.probe();
  await until(() => r.launches().length === 1, "the first self-test to start");
  const second = r.sb.probe(); // queued behind the first (probes are serialized)
  // The control file is read when a self-test launches; switch it once the first one is running so the second one fails.
  r.setMode("fail");
  const [v1, v2] = await Promise.all([first, second]);
  assert.equal(v1.state, "supported", "the first self-test itself passed");
  assert.equal(v2.state, "unsupported");
  assert.equal(r.sb.status().state, "unsupported", "the most recent self-test failed, so the sandbox must not be supported");
  const probes = r.launches().filter((l) => / probe-/.test(l)).map((l) => l.split(" ")[1]);
  assert.equal(new Set(probes).size, 2, "each self-test has its own run id");
});

test("finding WS-R1b (fixed): overlapping probes: the state is never 'supported' while a newer self-test is still running", async () => {
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
    await until(() => r.launches().length === 2, "the second self-test to start");
    mock.timers.tick(20_000);
    await second;
    assert.notEqual(during, "supported", "a self-test was still running");
    assert.equal(h.pid, undefined, "no ordinary run may start while a self-test is running");
  } finally {
    mock.timers.reset();
  }
});

test("finding WS-R2 (fixed): a probe that throws ends 'unsupported' with the error, not the stale reason 'the sandbox self-test is running'", async () => {
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
  assert.match(sb.status().reasons.join(" "), /failed with an error/);
});

test("finding WS-R3 (fixed): fs_search bounds the number of entries it visits, not only regular files", () => {
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
    assert.match(String(out.stoppedBecause), /entries/);
  } finally {
    r.close();
  }
});

test("finding WS-R3 (fixed): fs_list reads a bounded number of names and says the total is a lower bound", () => {
  const base = mkdtempSync(join(tmpdir(), "orbit-wsreview-list-"));
  const root = join(base, "ws");
  mkdirSync(root, { mode: 0o700 });
  for (let i = 0; i < LIST_SCAN_MAX + 5; i++) writeFileSync(join(root, `f${i}`), "");
  const st = statSync(root);
  const r = openRoot(root, { dev: st.dev, ino: st.ino });
  try {
    const out = listDir(r, [], { limit: 10 });
    assert.equal(out.total, LIST_SCAN_MAX);
    assert.equal(out.totalIsLowerBound, true);
    assert.equal(out.entries.length, 10);
  } finally {
    r.close();
  }
});

test("finding WS-R3 (fixed): walks stop at their time budget and say so (snapshot refuses; search reports incomplete)", () => {
  const base = mkdtempSync(join(tmpdir(), "orbit-wsreview-time-"));
  const root = join(base, "ws");
  mkdirSync(root, { mode: 0o700 });
  for (let i = 0; i < 50; i++) writeFileSync(join(root, `f${i}`), "x");
  const st = statSync(root);
  const r = openRoot(root, { dev: st.dev, ino: st.ino });
  try {
    assert.throws(() => snapshot(r, { ...SNAPSHOT_LIMITS, ms: -1 }), (e: unknown) => e instanceof WorkspaceFsError && e.code === "snapshot_too_large" && /time/.test(e.message));
    const out = search(r, [], "needle", { ms: -1 });
    assert.equal(out.complete, false);
    assert.match(String(out.stoppedBecause), /time/);
  } finally {
    r.close();
  }
});

test("finding WS-R4 (fixed): a ledger with an opId ORBIT did not issue is refused at load, and reap() never turns a foreign id into a path", async () => {
  const r = rig();
  const victim = join(r.state, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep.txt"), "canary");
  // A tampered ledger: an in-flight exec whose opId climbs out of <state>/runs.
  const ledgerDir = join(r.base, "svc-state");
  mkdirSync(ledgerDir, { mode: 0o700 });
  const at = "2026-11-19T00:00:00.000Z";
  writeFileSync(join(ledgerDir, "ledger.json"), JSON.stringify({ schema: 1, entries: [{ opId: "../victim", proposalId: "p", kind: "exec", workspace: "w", digest: "sha256:x", state: "running", createdAt: at, updatedAt: at, events: [{ at, state: "starting" }], summary: "s" }] }));
  // Fail closed: the whole ledger is untrusted (the tools turn off with the reason; src/workspace/select.ts), nothing is cleaned up.
  assert.throws(() => opLedger(ledgerDir), LedgerError);
  assert.ok(existsSync(join(victim, "keep.txt")));
  // Defense in depth: even called directly, reap() refuses ids that are not ORBIT's, touching neither <state> nor the cgroup tree.
  mkdirSync(join(r.cg, "sibling"));
  writeFileSync(join(r.cg, "sibling", "cgroup.procs"), `${process.pid}\n`);
  const out = await r.sb.reap(["../victim", "../../x", "ws-../../sibling", "orbit-run-x/../../sibling"]);
  assert.ok(Object.values(out).every((x) => x.error && !x.gone && !x.killed), JSON.stringify(out));
  assert.ok(existsSync(join(victim, "keep.txt")), "a directory outside <state>/runs was deleted by restart recovery");
  assert.ok(existsSync(join(r.cg, "sibling")), "a sibling cgroup was touched");
  assert.throws(() => childPath("/sys/fs/cgroup/x", "../y"));
  assert.throws(() => childPath("/sys/fs/cgroup/x", "a/b"));
  assert.equal(childPath("/sys/fs/cgroup/x", "orbit-run-ws-0123456789abcdef"), "/sys/fs/cgroup/x/orbit-run-ws-0123456789abcdef");
});

test("finding WS-R5 (fixed): an approval card never renders bidi/invisible control characters raw (they can disguise what runs)", async () => {
  const rr = wsRig();
  const script = `echo safe # ‮;rm -rf data⁦\n`;
  let proposed = false;
  try {
    const p = (await rr.call("exec_start", { workspace: "alpha", argv: ["sh", "/run/orbit/script"], script })).value;
    proposed = true;
    const card = rr.proposal(p.proposalId);
    const shown = [card.summary, ...Object.values(card.display), ...card.warnings].join("\n");
    assert.ok(!/[‪-‮⁦-⁩​-‏]/.test(shown), "bidi/zero-width characters reach the card unescaped");
    assert.match(shown, /⟨U\+202E⟩/, "the hidden character is shown as a visible marker");
    assert.match(shown, /┌ begin \(2 lines/, "a multi-line script is fenced");
  } catch (e) {
    if (proposed) throw e; // refusing the proposal outright is an acceptable fix
  }
});

test("finding WS-R6 (fixed): audit lines carry no model-chosen path text (journal privacy)", async () => {
  const rr = wsRig();
  const secretShaped = "ghp_" + "Ab1".repeat(12); // built at runtime; credential-shaped only
  assert.notEqual(maskVaultText(secretShaped), secretShaped, "precondition: the vault filter masks this shape");
  await assert.rejects(rr.call("fs_patch", { workspace: "alpha", path: `${secretShaped}/x.txt`, expectedVersion: `sha256:${"0".repeat(64)}`, edits: [{ find: "a", replace: "b" }] }));
  const lines = rr.audits.map((a) => JSON.stringify(a));
  assert.ok(lines.length > 0, "a denial was audited");
  assert.ok(!lines.some((l) => l.includes(secretShaped)), "an audit line carries the credential-shaped path verbatim");
});

test("finding WS-R7 (fixed): workspace roots under /proc (or /sys, /dev, /etc, /run, /boot) are refused, not only those exact paths", () => {
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

// ---- Hardening regressions for the remaining findings (WS-R8 to WS-R14) --------------------------------------------------------

test("finding WS-R8 (fixed): a run whose process tree was not confirmed gone pauses exec until a reap finds its cgroup gone or empty", async () => {
  const sb = fakeSandbox();
  const rr = wsRig({ sandbox: sb });
  const p = (await rr.call("exec_start", { workspace: "alpha", argv: ["true"] })).value;
  const c = await rr.svc.confirm(rr.proposals.take(p.proposalId) as never);
  await tick();
  sb.reapGone = false;
  sb.runs[0]!.finish(0, "", "", { treeGone: false });
  await rr.svc.idle();
  const opId = String(c.body.opId);
  assert.equal(rr.svc.ledger.get(opId)!.treeGone, false);
  assert.deepEqual(rr.svc.quarantined(), [opId]);
  await assert.rejects(rr.call("exec_start", { workspace: "beta", argv: ["true"] }), /cleanup_unverified/);
  // A re-check that still finds processes keeps the pause; one that finds the cgroup gone lifts it, and says so in the record.
  await rr.svc.verifyCleanup([opId]);
  assert.deepEqual(rr.svc.quarantined(), [opId]);
  sb.reapGone = true;
  await rr.svc.verifyCleanup([opId]);
  assert.deepEqual(rr.svc.quarantined(), []);
  assert.ok(rr.svc.ledger.get(opId)!.cleanupVerifiedAt);
  assert.match(JSON.stringify(rr.svc.ledger.get(opId)!.events), /cleanup verified later/);
  assert.equal((await rr.call("exec_start", { workspace: "beta", argv: ["true"] })).value.status, "pending-confirmation");
});

test("finding WS-R8 (fixed): a launched run with NO cleanup evidence counts as unverified; a run queued behind it does not start", async () => {
  const sb = fakeSandbox();
  const rr = wsRig({ sandbox: sb, maxConcurrentRuns: 1 });
  const p1 = (await rr.call("exec_start", { workspace: "alpha", argv: ["true"] })).value;
  const p2 = (await rr.call("exec_start", { workspace: "beta", argv: ["true"] })).value;
  const c1 = await rr.svc.confirm(rr.proposals.take(p1.proposalId) as never);
  const c2 = await rr.svc.confirm(rr.proposals.take(p2.proposalId) as never);
  assert.equal(c2.body.state, "queued");
  sb.reapGone = false;
  sb.runs[0]!.finish(0, "", "", { treeGone: undefined });
  await rr.svc.idle();
  assert.equal(rr.svc.ledger.get(String(c1.body.opId))!.treeGone, false, "no evidence is recorded as not confirmed");
  assert.equal(rr.svc.ledger.get(String(c2.body.opId))!.state, "failed");
  assert.match(String(rr.svc.ledger.get(String(c2.body.opId))!.reason), /^cleanup_unverified/);
  assert.equal(sb.runs.length, 1, "the queued run never started");
});

test("finding WS-R8 (fixed): restart recovery clears the pause only on evidence, and an in-flight run's tree is 'gone' only if the reap found it so", async () => {
  const sb = fakeSandbox();
  const rr = wsRig({ sandbox: sb });
  const p = (await rr.call("exec_start", { workspace: "alpha", argv: ["sleep", "100"] })).value;
  const c = await rr.svc.confirm(rr.proposals.take(p.proposalId) as never);
  await tick();
  sb.reapGone = false;
  const after = rr.make();
  await after.recover();
  const opId = String(c.body.opId);
  assert.equal(after.ledger.get(opId)!.state, "uncertain");
  assert.equal(after.ledger.get(opId)!.treeGone, false);
  assert.match(String(after.ledger.get(opId)!.reason), /cleanup NOT verified/);
  assert.deepEqual(after.quarantined(), [opId]);
  sb.reapGone = true;
  const again = rr.make();
  await again.recover();
  assert.deepEqual(again.quarantined(), [], "a later start whose reap finds the cgroup gone lifts the pause");
});

test("finding WS-R9 (fixed): the launcher re-checks the workspace root (device and inode) immediately before spawning", async () => {
  const r = rig();
  r.setMode("pass");
  assert.equal((await r.sb.probe()).state, "supported");
  r.setMode("run");
  const spec = r.spec("moved-root");
  const h = r.sb.start({ ...spec, workspace: { ...spec.workspace, ino: spec.workspace.ino + 1 } });
  assert.equal(h.pid, undefined);
  assert.match(String((await h.done).startError), /no longer the configured directory/);
  assert.deepEqual(nonProbe(r.launches()), []);
});

test("finding WS-R9 (fixed): a sandbox binary in a directory others can write is refused, even if the binary itself is root-owned", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-wsreview-bin-")); // under /tmp (mode 1777)
  const bin = join(dir, "bwrap");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  const isRoot = (process.getuid?.() ?? 0) === 0;
  assert.throws(
    () => parseConfig(JSON.stringify({ workspaces: [{ id: "s", root: dir, exec: true }], sandbox: { bwrap: bin, prlimit: "/bin/sh", cgroupParent: "/sys/fs/cgroup/x" } }), { uid: () => statSync(dir).uid, protectedPaths: [] }),
    isRoot ? /directory .* not root-owned or is writable by group or others/ : /not owned by root/,
  );
});

test("finding WS-R11 (fixed): the card shows the full identity and policy hash, and the snapshot covers the root's own mode", async () => {
  const rr = wsRig();
  const p = (await rr.call("exec_start", { workspace: "alpha", argv: ["true"] })).value;
  const card = rr.proposal(p.proposalId);
  assert.ok(card.display.workspace.includes(rr.a.identity), "full identity");
  assert.ok(card.display.sandbox.includes(rr.config.policyHash), "full policy hash");
  assert.doesNotMatch(card.display.workspace + card.display.sandbox, /…/);
  const st = statSync(rr.a.root);
  const r = openRoot(rr.a.root, { dev: st.dev, ino: st.ino });
  try {
    const before = snapshot(r).digest;
    chmodSync(rr.a.root, 0o500);
    assert.notEqual(snapshot(r).digest, before);
  } finally {
    chmodSync(rr.a.root, 0o700);
    r.close();
  }
});

test("finding WS-R12 (fixed): a run whose cgroup cannot be prepared leaves no run directory (no copy of the script)", async () => {
  const r = rig();
  r.setMode("pass");
  assert.equal((await r.sb.probe()).state, "supported");
  const spec = { ...r.spec("cg-fails"), script: "echo secret-free script\n" };
  mkdirSync(join(r.cg, `orbit-run-${spec.runId}`)); // the run's cgroup already exists, so creating it fails
  const h = r.sb.start(spec);
  assert.equal(h.pid, undefined);
  assert.match(String((await h.done).startError), /could not be prepared/);
  assert.equal(existsSync(join(r.state, "runs", spec.runId)), false);
});

test("finding WS-R13 (fixed): bubblewrap must create a cgroup namespace (--unshare-cgroup), not 'try'", () => {
  assert.ok(REQUIRED_FLAGS.includes("--unshare-cgroup"));
  assert.ok(!REQUIRED_FLAGS.includes("--unshare-cgroup-try"));
});

test("finding WS-R14 (fixed): waiting for a run cgroup to empty does not block the event loop; a cgroup that keeps a live process is not 'gone'", async () => {
  const r = rig();
  const sleeper = spawn("sleep", ["5"], { stdio: "ignore" });
  try {
    const id = rid("busy-cgroup");
    const dir = join(r.cg, `orbit-run-${id}`);
    mkdirSync(dir);
    // A plain directory standing in for a cgroup: writing cgroup.kill is a no-op here, so the sleeper stays alive and listed.
    writeFileSync(join(dir, "cgroup.procs"), `${sleeper.pid}\n`);
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const out = await r.sb.reap([id]);
    clearInterval(iv);
    assert.equal(out[id]!.gone, false);
    assert.equal(out[id]!.leftover, 1);
    assert.ok(ticks >= 20, `the event loop ran ${ticks} times while waiting (it must not be blocked)`);
  } finally {
    sleeper.kill("SIGKILL");
  }
});
