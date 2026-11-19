import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_LIMITS } from "../src/workspace/config.ts";
import type { Limits, SandboxConfig } from "../src/workspace/config.ts";
import { bwrapSandbox, CGROUP_CONTROLLERS, SCRIPT_PATH } from "../src/workspace/sandbox.ts";
import type { RunExit } from "../src/workspace/sandbox.ts";

// REAL sandbox integration tests (docs/workspace-tools.md, "Pre-activation checklist"). They launch the production bubblewrap launcher
// and check, from inside, what a command can actually see and do. Mocks prove nothing about OS isolation, so these are the evidence.
//
// They run only in an isolated Linux test environment that has everything the production sandbox needs, and are SKIPPED (with the
// reason) anywhere else:
//   * not root (the sandbox never runs as root; run the suite as an unprivileged user),
//   * bubblewrap at /usr/bin/bwrap (root-owned) with the required options, and prlimit,
//   * ORBIT_SANDBOX_TEST_CGROUP: a cgroup v2 directory this user may manage, with memory, pids and cpu enabled in cgroup.subtree_control.
// Never run them on the production host: they include adversarial commands (fork bomb, memory exhaustion).

const CG = process.env.ORBIT_SANDBOX_TEST_CGROUP ?? "";
function why(): string | false {
  if (process.platform !== "linux") return "not Linux";
  if ((process.getuid?.() ?? 0) === 0) return "running as root: the sandbox never runs as root; run these as an unprivileged user";
  if (!existsSync("/usr/bin/bwrap")) return "bubblewrap (/usr/bin/bwrap) is not installed in this runner";
  if (!existsSync("/usr/bin/prlimit")) return "prlimit is not installed in this runner";
  if (!CG) return "ORBIT_SANDBOX_TEST_CGROUP (a delegated cgroup v2 directory) is not set";
  try {
    const sub = readFileSync(join(CG, "cgroup.subtree_control"), "utf8");
    const lack = CGROUP_CONTROLLERS.filter((c) => !sub.split(/\s+/).includes(c));
    if (lack.length) return `the test cgroup does not enable ${lack.join(", ")} for children`;
  } catch {
    return "the test cgroup is not readable";
  }
  return false;
}
const skip = why();
if (skip) console.log(`# workspace sandbox integration tests SKIPPED: ${skip}. OS isolation is UNVERIFIED in this run.`);

const base = skip ? "" : mkdtempSync(join(tmpdir(), "orbit-sbx-"));
const outsideCanary = skip ? "" : join(base, "outside-canary.txt");
const runtime = ["/usr", "/bin", "/sbin", "/lib", "/lib64"].filter((p) => existsSync(p));
const config = (limits: Partial<Limits> = {}): SandboxConfig => ({ bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", shell: "/bin/sh", runtime, cgroupParent: CG, limits: { ...DEFAULT_LIMITS, timeoutSec: 30, ...limits }, maxConcurrentRuns: 1 });
let n = 0;
async function sandbox(limits: Partial<Limits> = {}) {
  const state = join(base, `state-${++n}`);
  mkdirSync(state, { mode: 0o700 });
  const sb = bwrapSandbox({ config: config(limits), stateDir: state, canaries: [outsideCanary] });
  const probe = await sb.probe();
  assert.equal(probe.state, "supported", probe.reasons.join("; "));
  const ws = join(base, `ws-${n}`);
  mkdirSync(ws, { mode: 0o700 });
  const st = statSync(ws);
  const run = (script: string, extra: Partial<Limits> = {}): { done: Promise<RunExit>; kill(r: "cancel"): void } => {
    const h = sb.start({ runId: `t${n}-${Math.random().toString(36).slice(2, 8)}`, workspace: { id: "t", root: ws, exec: true, dev: st.dev, ino: st.ino, identity: "t" }, cwd: [], argv: ["/bin/sh", SCRIPT_PATH], script, limits: { ...config(limits).limits, ...extra } });
    return { done: h.done, kill: (r) => h.kill(r) };
  };
  return { sb, ws, run, out: async (script: string, extra: Partial<Limits> = {}) => run(script, extra).done };
}
const text = (r: RunExit) => r.stdout.toString("utf8");
const sleepers = () =>
  readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return readFileSync(`/proc/${p}/cmdline`, "utf8").includes("orbit-sandbox-sleeper");
      } catch {
        return false;
      }
    }).length;

if (!skip) writeFileSync(outsideCanary, "outside");

test("probe: the live self-test passes (unprivileged, private network/PID namespaces, hidden host paths, clean env, read-only runtime)", { skip }, async () => {
  await sandbox();
});

test("identity: unprivileged uid, no capabilities, no_new_privs, nested user namespaces refused", { skip }, async () => {
  const s = await sandbox();
  const r = await s.out('id -u; grep -E "^(CapEff|CapBnd|NoNewPrivs):" /proc/self/status; (unshare -U true 2>/dev/null && echo nested_userns_ok) || echo nested_userns_refused');
  const o = text(r);
  assert.match(o, /^1000$/m);
  assert.match(o, /CapEff:\s+0+$/m);
  assert.match(o, /CapBnd:\s+0+$/m);
  assert.match(o, /NoNewPrivs:\s+1$/m);
  assert.match(o, /nested_userns_refused/);
});

test("network: only a private loopback; a host loopback service is unreachable", { skip }, async () => {
  const server = createServer((c) => c.end("host-service")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const s = await sandbox();
    const r = await s.out(`tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '; if command -v python3 >/dev/null; then python3 -c "import socket
try:
  socket.create_connection(('127.0.0.1', ${port}), 2); print('host_reachable')
except Exception: print('host_unreachable')"; else echo no_python; fi`);
    const o = text(r);
    assert.deepEqual(o.split("\n").filter((l) => l && !l.startsWith("host_") && l !== "no_python"), ["lo"]);
    assert.ok(!o.includes("host_reachable"));
  } finally {
    server.close();
  }
});

test("filesystem: host paths and the outside canary are invisible, the runtime is read-only, only the workspace and /tmp are writable", { skip }, async () => {
  const s = await sandbox();
  const r = await s.out(`test -e ${JSON.stringify(outsideCanary)} && echo canary_visible; test -e /etc/shadow && echo shadow_visible; test -e /home && echo home_visible; touch /usr/x 2>/dev/null && echo usr_writable; touch /x 2>/dev/null && echo root_writable; echo w > /workspace/w && echo ws_ok; echo t > /tmp/t && echo tmp_ok; ls /dev`);
  const o = text(r);
  for (const bad of ["canary_visible", "shadow_visible", "home_visible", "usr_writable", "root_writable"]) assert.ok(!o.includes(bad), bad);
  assert.match(o, /ws_ok/);
  assert.match(o, /tmp_ok/);
  assert.ok(!/\b(sda|nvme|kvm|mem|kmsg)\b/.test(o), "no host devices");
  assert.equal(readFileSync(join(s.ws, "w"), "utf8"), "w\n");
});

test("environment: nothing is inherited from ORBIT (a variable in ORBIT's environment is absent inside)", { skip }, async () => {
  process.env.ORBIT_TEST_INHERIT_PROBE = ["not", "for", "the", "sandbox"].join("-");
  const s = await sandbox();
  const o = text(await s.out("env"));
  assert.ok(!o.includes("ORBIT_TEST_INHERIT_PROBE"));
  assert.ok(!o.includes("CREDENTIALS_DIRECTORY"));
  delete process.env.ORBIT_TEST_INHERIT_PROBE;
});

test("process tree: background children are killed when the command exits; timeout and cancellation kill the whole tree", { skip }, async () => {
  const s = await sandbox();
  const bg = await s.out("(exec -a orbit-sandbox-sleeper sleep 300) & (exec -a orbit-sandbox-sleeper sleep 300) & echo started");
  assert.match(text(bg), /started/);
  assert.equal(bg.treeGone, true);
  assert.equal(sleepers(), 0, "no sleeper survived the run");
  const t0 = Date.now();
  const to = await s.out("(exec -a orbit-sandbox-sleeper sleep 300) & exec -a orbit-sandbox-sleeper sleep 300", { timeoutSec: 2 });
  assert.equal(to.killedBy, "timeout");
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal(sleepers(), 0);
  const h = s.run("(exec -a orbit-sandbox-sleeper sleep 300) & exec -a orbit-sandbox-sleeper sleep 300");
  await new Promise((r) => setTimeout(r, 500));
  h.kill("cancel");
  const c = await h.done;
  assert.equal(c.killedBy, "cancel");
  assert.equal(sleepers(), 0);
});

test("limits: process count, memory, output, /tmp size and file size are enforced", { skip }, async () => {
  const s = await sandbox();
  const fork = await s.out("i=0; while [ $i -lt 200 ]; do (exec -a orbit-sandbox-sleeper sleep 30) & i=$((i+1)); done 2>/dev/null; echo spawned", { processes: 16, timeoutSec: 10 });
  assert.equal(fork.treeGone, true);
  assert.equal(sleepers(), 0);
  const mem = await s.out('x=$(head -c 300000000 /dev/zero | tr "\\0" a); echo survived ${#x}', { memoryBytes: 64 * 1024 * 1024, timeoutSec: 20 });
  assert.ok(!text(mem).includes("survived 300000000"), "a 300 MB allocation does not succeed under a 64 MiB limit");
  const out = await s.out("yes | head -c 100000", { outputBytes: 4096 });
  assert.equal(out.stdout.length, 4096);
  assert.equal(out.truncated.stdout, true);
  const tmp = await s.out("head -c 5000000 /dev/zero > /tmp/big 2>/dev/null && echo tmp_unbounded || echo tmp_bounded", { tmpBytes: 1024 * 1024 });
  assert.match(text(tmp), /tmp_bounded/);
  const fsz = await s.out("(head -c 3000000 /dev/zero > /workspace/big) 2>/dev/null && echo fsize_unbounded || echo fsize_bounded", { fileSizeBytes: 1024 * 1024 });
  assert.match(text(fsz), /fsize_bounded/);
});
