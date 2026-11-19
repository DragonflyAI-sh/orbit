import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Limits, SandboxConfig, Workspace } from "./config.ts";

// The exec sandbox (docs/workspace-tools.md, "Exec isolation"). Commands run under bubblewrap in fresh user, mount, PID, network,
// IPC, UTS and cgroup namespaces, as an unprivileged user, with no capabilities, no_new_privs, nested user namespaces disabled, a
// clean environment, the operator's read-only runtime (/usr and friends), the workspace as the ONLY writable host directory, a
// size-bounded private /tmp, a private /proc and a minimal /dev. There is no network namespace sharing: the sandbox has its own
// loopback only, so host loopback services are unreachable. Aggregate memory, process and CPU limits are a per-run cgroup v2 child
// of the operator's delegated cgroup; per-process limits are rlimits set by prlimit before bubblewrap starts. The whole process tree
// is killed through the PID namespace (bubblewrap --die-with-parent: its init dies, the kernel kills every member) and cgroup.kill.
//
// The launcher interface is fixed: ORBIT builds the argument vector here from operator configuration and the approved operation,
// never from model text other than the approved argv/script, which only ever appear after "--" as the command to run inside.
// There is no unsandboxed fallback: if any capability is missing, exec is reported unsupported and refused.

export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;
export const SANDBOX_HOME = "/workspace";
export const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";
export const SCRIPT_PATH = "/run/orbit/script";
// The complete environment a command sees. Nothing is inherited from ORBIT.
export const CLEAN_ENV: Record<string, string> = { PATH: SANDBOX_PATH, HOME: SANDBOX_HOME, LANG: "C.UTF-8", TMPDIR: "/tmp", USER: "sandbox", LOGNAME: "sandbox" };
export const REQUIRED_FLAGS = ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--disable-userns", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "--remount-ro", "--size", "--perms", "--uid", "--gid", "--ro-bind", "--symlink", "--tmpfs", "--proc", "--dev", "--chdir", "--hostname"];
export const CGROUP_CONTROLLERS = ["memory", "pids", "cpu"];

export type RunSpec = { runId: string; workspace: Workspace; cwd: string[]; argv: string[]; script?: string; limits: Limits };
export type RunExit = {
  code: number | null;
  signal: string | null;
  killedBy?: "timeout" | "cancel";
  stdout: Buffer;
  stderr: Buffer;
  truncated: { stdout: boolean; stderr: boolean };
  // Evidence the whole tree is gone: the run's cgroup had no processes left after the kill (undefined: no cgroup evidence).
  treeGone?: boolean;
  startError?: string;
};
export type RunHandle = { pid: number | undefined; done: Promise<RunExit>; kill(reason: "timeout" | "cancel"): void };
export type ProbeState = { state: "unknown" | "supported" | "unsupported"; checkedAt?: string; reasons: string[]; bwrapVersion?: string };

export interface Sandbox {
  probe(): Promise<ProbeState>;
  status(): ProbeState;
  // Identifies the sandbox implementation and its policy (bound into every exec approval).
  policyId(): string;
  start(spec: RunSpec): RunHandle;
  // Restart recovery: kill and remove whatever is left of runs that were active when ORBIT stopped. Returns per-run evidence.
  reap(runIds: string[]): Record<string, { leftover: number; killed: boolean; error?: string }>;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The bubblewrap arguments for one run (everything before "--" is ORBIT's, fixed).
export function bwrapArgs(cfg: SandboxConfig, spec: RunSpec, runDir: string, lstat: (p: string) => { link?: string } | undefined): string[] {
  const a: string[] = [
    "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    "--disable-userns",
    "--uid", String(SANDBOX_UID), "--gid", String(SANDBOX_GID),
    "--hostname", "orbit-sandbox",
    "--die-with-parent", "--new-session",
    "--cap-drop", "ALL",
    "--clearenv",
  ];
  for (const [k, v] of Object.entries(CLEAN_ENV)) a.push("--setenv", k, v);
  for (const p of cfg.runtime) {
    const st = lstat(p);
    if (!st) continue;
    if (st.link) a.push("--symlink", st.link, p);
    else a.push("--ro-bind", p, p);
  }
  a.push("--ro-bind", join(runDir, "passwd"), "/etc/passwd", "--ro-bind", join(runDir, "group"), "/etc/group");
  if (spec.script !== undefined) a.push("--ro-bind", join(runDir, "script"), SCRIPT_PATH);
  a.push("--proc", "/proc", "--dev", "/dev");
  a.push("--perms", "1777", "--size", String(spec.limits.tmpBytes), "--tmpfs", "/tmp");
  a.push("--bind", spec.workspace.root, SANDBOX_HOME);
  a.push("--remount-ro", "/");
  a.push("--chdir", spec.cwd.length ? `${SANDBOX_HOME}/${spec.cwd.join("/")}` : SANDBOX_HOME);
  a.push("--", ...spec.argv);
  return a;
}

// RLIMIT_NPROC is only a backstop: at the outer (host) level the kernel counts every task of ORBIT's user, ORBIT's own threads included,
// so it gets a margin. The exact per-run process bound is the run cgroup's pids.max.
export const NPROC_MARGIN = 512;
export function prlimitArgs(l: Limits): string[] {
  const both = (n: number) => `${n}:${n}`;
  return [`--cpu=${both(l.cpuSec)}`, `--as=${both(l.memoryBytes)}`, `--fsize=${both(l.fileSizeBytes)}`, `--nofile=${both(l.openFiles)}`, `--nproc=${both(l.processes + NPROC_MARGIN)}`, "--core=0:0", "--"];
}

// The shell wrapper moves ITSELF into the run's cgroup before it execs prlimit (which execs bubblewrap), so nothing the run starts
// can be outside the cgroup. Its arguments are positional, never interpolated.
export const CGROUP_WRAPPER = 'echo $$ > "$1/cgroup.procs" || exit 125; shift; exec "$@"';

export function cgroupFiles(l: Limits): Record<string, string> {
  return { "memory.max": String(l.memoryBytes), "memory.swap.max": "0", "pids.max": String(l.processes), "cpu.max": "100000 100000" };
}

const PROBE_SCRIPT = (canaries: string[]) =>
  [
    'echo "uid=$(id -u)"',
    'printf "ifaces="; tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " " | tr "\\n" ","; echo',
    'echo "procs=$(ls /proc | grep -c "^[0-9]")"',
    ...canaries.map((c) => `test -e ${q(c)} && echo "visible=${c.replace(/[^A-Za-z0-9/._-]/g, "_")}"`),
    'echo "env=$(env | cut -d= -f1 | sort | tr "\\n" ",")"',
    "touch /usr/.orbit-probe 2>/dev/null && echo runtime_writable",
    "touch /etc/.orbit-probe 2>/dev/null && echo etc_writable",
    "echo ok > /workspace/.orbit-probe && echo workspace_writable",
    "true",
  ].join("\n");

export function judgeProbe(out: string, canaries: string[]): string[] {
  const lines = out.split("\n");
  const val = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
  const problems: string[] = [];
  if (val("uid") !== String(SANDBOX_UID)) problems.push(`the command did not run as the unprivileged sandbox user (uid ${val("uid") ?? "unknown"})`);
  if (val("ifaces") !== "lo,") problems.push(`network interfaces other than the private loopback are visible (${val("ifaces") ?? "unknown"})`);
  const procs = Number(val("procs"));
  if (!(procs >= 1 && procs <= 4)) problems.push(`the PID namespace is not private (${val("procs") ?? "unknown"} processes visible)`);
  const visible = lines.filter((l) => l.startsWith("visible="));
  if (visible.length) problems.push(`${visible.length} host path(s) that must be hidden are visible`);
  const env = (val("env") ?? "").split(",").filter(Boolean);
  const allowed = new Set([...Object.keys(CLEAN_ENV), "PWD", "SHLVL", "_", "OLDPWD"]);
  const extra = env.filter((k) => !allowed.has(k));
  if (extra.length) problems.push(`unexpected environment variables are inherited (${extra.length})`);
  if (lines.includes("runtime_writable") || lines.includes("etc_writable")) problems.push("the read-only runtime is writable");
  if (!lines.includes("workspace_writable")) problems.push("the workspace is not writable inside the sandbox");
  void canaries;
  return problems;
}

export function bwrapSandbox(d: { config: SandboxConfig; stateDir: string; uid?: () => number; now?: () => Date; canaries?: string[] }): Sandbox {
  const cfg = d.config;
  const now = d.now ?? (() => new Date());
  const uid = d.uid ?? (() => process.getuid?.() ?? 0);
  const runsDir = join(d.stateDir, "runs");
  let state: ProbeState = { state: "unknown", reasons: ["not probed yet"] };
  const lstat = (p: string) => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) return undefined;
    return st.isSymbolicLink() ? { link: readlinkSync(p) } : {};
  };
  const cgroupDir = (runId: string) => join(cfg.cgroupParent, `orbit-run-${runId}`);

  function prepareRunDir(spec: RunSpec): string {
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const dir = join(runsDir, spec.runId);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "passwd"), `sandbox:x:${SANDBOX_UID}:${SANDBOX_GID}:sandbox:${SANDBOX_HOME}:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`, { mode: 0o444 });
    writeFileSync(join(dir, "group"), `sandbox:x:${SANDBOX_GID}:\nnogroup:x:65534:\n`, { mode: 0o444 });
    if (spec.script !== undefined) {
      writeFileSync(join(dir, "script"), spec.script, { mode: 0o444 });
      chmodSync(join(dir, "script"), 0o444);
    }
    return dir;
  }

  function makeCgroup(runId: string, limits: Limits): string {
    const dir = cgroupDir(runId);
    mkdirSync(dir);
    for (const [f, v] of Object.entries(cgroupFiles(limits))) {
      try {
        writeFileSync(join(dir, f), v);
      } catch (e) {
        // memory.swap.max is absent when swap accounting is off: there is no swap to bound then. Everything else is required.
        if (f === "memory.swap.max" && (e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`cgroup limit ${f} could not be set (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
    }
    return dir;
  }

  const procsIn = (dir: string): number[] => {
    try {
      return readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  function killCgroup(dir: string): { leftover: number; killed: boolean } {
    const before = procsIn(dir);
    if (!before.length) return { leftover: 0, killed: false };
    try {
      writeFileSync(join(dir, "cgroup.kill"), "1");
    } catch {
      for (const pid of before) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    return { leftover: before.length, killed: true };
  }
  function removeCgroup(dir: string) {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 50 && procsIn(dir).length; i++) Atomics.wait(pause, 0, 0, 20);
    try {
      rmdirSync(dir);
    } catch {
      /* reported by the next reap */
    }
  }

  // The public entry point: refuses unless the probe has COMPLETED with a "supported" verdict.
  function start(spec: RunSpec): RunHandle {
    return launch(spec, false);
  }

  // `probing`: the self-test's own run, the only launch allowed before a verdict exists. It never reads or changes `state`, so the
  // sandbox is never reported supported (and no other run can start) while its self-test is still running.
  function launch(spec: RunSpec, probing: boolean): RunHandle {
    if (!probing && state.state !== "supported") {
      return { pid: undefined, kill: () => {}, done: Promise.resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: { stdout: false, stderr: false }, startError: `The sandbox is not available: ${state.reasons.join("; ")}` }) };
    }
    if (uid() === 0) {
      return { pid: undefined, kill: () => {}, done: Promise.resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: { stdout: false, stderr: false }, startError: "ORBIT is running as root; the sandbox never runs as root." }) };
    }
    let runDir: string;
    let cg: string;
    try {
      runDir = prepareRunDir(spec);
      cg = makeCgroup(spec.runId, spec.limits);
    } catch (e) {
      return { pid: undefined, kill: () => {}, done: Promise.resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: { stdout: false, stderr: false }, startError: `The run could not be prepared: ${e instanceof Error ? e.message : String(e)}` }) };
    }
    const args = ["-c", CGROUP_WRAPPER, "orbit-exec", cg, cfg.prlimit, ...prlimitArgs(spec.limits), cfg.bwrap, ...bwrapArgs(cfg, spec, runDir, lstat)];
    const child = spawn(cfg.shell, args, { env: {}, stdio: ["ignore", "pipe", "pipe"], detached: false });
    const cap = spec.limits.outputBytes;
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const size = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    const take = (k: "stdout" | "stderr") => (b: Buffer) => {
      const room = cap - size[k];
      if (room <= 0) return void (truncated[k] = true);
      const part = b.length > room ? b.subarray(0, room) : b;
      if (part.length < b.length) truncated[k] = true;
      out[k].push(part);
      size[k] += part.length;
    };
    child.stdout!.on("data", take("stdout"));
    child.stderr!.on("data", take("stderr"));
    let killedBy: "timeout" | "cancel" | undefined;
    const kill = (reason: "timeout" | "cancel") => {
      if (!killedBy) killedBy = reason;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      killCgroup(cg);
    };
    const timer = setTimeout(() => kill("timeout"), spec.limits.timeoutSec * 1000);
    const done = new Promise<RunExit>((resolve) => {
      let startError: string | undefined;
      child.on("error", (e) => (startError = e.message));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const left = killCgroup(cg);
        removeCgroup(cg);
        const treeGone = procsIn(cg).length === 0;
        try {
          rmSync(runDir, { recursive: true, force: true });
        } catch {
          /* removed by the next reap */
        }
        resolve({ code, signal, ...(killedBy ? { killedBy } : {}), stdout: Buffer.concat(out.stdout), stderr: Buffer.concat(out.stderr), truncated, treeGone: treeGone && (left.leftover === 0 || left.killed), ...(startError ? { startError } : code === 125 ? { startError: "the run could not enter its cgroup" } : {}) });
      });
    });
    return { pid: child.pid, done, kill };
  }

  return {
    status: () => state,
    policyId: () => `bwrap:${state.bwrapVersion ?? "unknown"}:${REQUIRED_FLAGS.length}`,
    async probe() {
      // Until this probe's verdict is in, the sandbox is not supported: nothing but the self-test itself can launch.
      state = { state: "unknown", reasons: ["the sandbox self-test is running"] };
      const reasons: string[] = [];
      let version: string | undefined;
      if (uid() === 0) reasons.push("ORBIT is running as root; the sandbox never runs as root");
      const v = spawnSync(cfg.bwrap, ["--version"], { encoding: "utf8", env: {}, timeout: 5000 });
      if (v.status !== 0) reasons.push(`bubblewrap could not be run (${v.error?.message ?? `exit ${v.status}`})`);
      else version = v.stdout.trim().split(/\s+/).at(-1);
      const h = spawnSync(cfg.bwrap, ["--help"], { encoding: "utf8", env: {}, timeout: 5000 });
      const help = `${h.stdout ?? ""}${h.stderr ?? ""}`;
      const missing = REQUIRED_FLAGS.filter((f) => !new RegExp(`(^|\\s)${f.replace(/-/g, "\\-")}(\\s|=|$)`, "m").test(help));
      if (missing.length) reasons.push(`bubblewrap lacks required options: ${missing.join(", ")}`);
      const p = spawnSync(cfg.prlimit, ["--version"], { encoding: "utf8", env: {}, timeout: 5000 });
      if (p.status !== 0) reasons.push("prlimit could not be run");
      try {
        const ctl = readFileSync(join(cfg.cgroupParent, "cgroup.controllers"), "utf8").split(/\s+/);
        const sub = readFileSync(join(cfg.cgroupParent, "cgroup.subtree_control"), "utf8").split(/\s+/);
        const lack = CGROUP_CONTROLLERS.filter((c) => !ctl.includes(c) || !sub.includes(c));
        if (lack.length) reasons.push(`the delegated cgroup does not enable ${lack.join(", ")} for its children`);
        else {
          const t = join(cfg.cgroupParent, `orbit-probe-${process.pid}`);
          mkdirSync(t);
          rmdirSync(t);
        }
      } catch (e) {
        reasons.push(`the delegated cgroup is not usable (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      if (!reasons.length) {
        // A live self-test: the probe really runs a command in the sandbox and checks what it can see.
        const probeWs = join(d.stateDir, "probe-workspace");
        rmSync(probeWs, { recursive: true, force: true });
        mkdirSync(probeWs, { recursive: true, mode: 0o700 });
        const canaries = [d.stateDir, ...(d.canaries ?? []), "/etc/shadow", "/home", "/root", "/var", "/run/systemd", "/opt"];
        const limits = { timeoutSec: 20, cpuSec: 10, memoryBytes: 512 * 1024 * 1024, processes: 32, fileSizeBytes: 1024 * 1024, openFiles: 64, outputBytes: 64 * 1024, tmpBytes: 4 * 1024 * 1024, workspaceBytes: 0 };
        const h2 = launch({ runId: `probe-${Date.now().toString(36)}`, workspace: { id: "probe", root: probeWs, exec: true, dev: 0, ino: 0, identity: "probe" }, cwd: [], argv: [cfg.shell, SCRIPT_PATH], script: PROBE_SCRIPT(canaries), limits }, true);
        const r = await h2.done;
        if (r.startError || r.code !== 0) reasons.push(`the sandbox self-test did not run (${r.startError ?? `exit ${r.code}`}: ${r.stderr.toString("utf8").slice(0, 200)})`);
        else reasons.push(...judgeProbe(r.stdout.toString("utf8"), canaries));
        rmSync(probeWs, { recursive: true, force: true });
      }
      state = { state: reasons.length ? "unsupported" : "supported", checkedAt: now().toISOString(), reasons, ...(version ? { bwrapVersion: version } : {}) };
      return state;
    },
    start,
    reap(runIds) {
      const out: Record<string, { leftover: number; killed: boolean; error?: string }> = {};
      for (const id of runIds) {
        const dir = cgroupDir(id);
        try {
          const r = existsSync(dir) ? killCgroup(dir) : { leftover: 0, killed: false };
          if (existsSync(dir)) removeCgroup(dir);
          out[id] = r;
        } catch (e) {
          out[id] = { leftover: -1, killed: false, error: e instanceof Error ? e.message : String(e) };
        }
        try {
          rmSync(join(runsDir, id), { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      return out;
    },
  };
}
