import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statfsSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

// Workspace tools configuration (docs/workspace-tools.md, "Operator setup"). Everything here is chosen by the operator in a file the
// model never sees or names: which workspaces exist (by id), where they are, whether exec is allowed in each, which read-only runtime
// the sandbox gets, and every limit. The model only ever passes a workspace id; it cannot nominate a root, a mount, an environment
// variable, an identity or a sandbox policy.
//
// OFF BY DEFAULT, twice over: ORBIT_WORKSPACE_TOOLS must be exactly "enabled", AND the file named by ORBIT_WORKSPACES_FILE must carry
// `preActivationChecklist` equal to PRE_ACTIVATION_CHECKLIST, which an operator writes only after the independent security review and
// the live-host isolation checks in docs/workspace-tools.md have passed. Merging or deploying this code activates nothing.

export const WORKSPACE_FLAG = "ORBIT_WORKSPACE_TOOLS";
export const WORKSPACE_FILE_ENV = "ORBIT_WORKSPACES_FILE";
export const PRE_ACTIVATION_CHECKLIST = "workspace-tools-preactivation-v1";

export const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The only host trees the sandbox may see (read-only). Anything else (/etc, /home, /var, /run, /opt, ORBIT's state, credentials) is
// refused at load. A merged-/usr symlink (/bin -> usr/bin) is recreated inside the sandbox as the same symlink.
export const RUNTIME_ALLOWED = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"] as const;
// Roots that may never be a workspace. Trees no workspace may be inside (WS-R7: a prefix check, not only equality).
const FORBIDDEN_TREES = ["/proc", "/sys", "/dev", "/etc", "/run", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/root"];
const FORBIDDEN_ROOTS = ["/", "/etc", "/proc", "/sys", "/dev", "/run", "/boot", "/root", "/home", "/var", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/tmp", "/srv", "/mnt", "/media"];

export type Limits = {
  timeoutSec: number;
  cpuSec: number;
  memoryBytes: number;
  processes: number;
  fileSizeBytes: number;
  openFiles: number;
  outputBytes: number;
  tmpBytes: number;
  workspaceBytes: number;
};
export const DEFAULT_LIMITS: Limits = {
  timeoutSec: 300,
  cpuSec: 120,
  memoryBytes: 1024 * 1024 * 1024,
  processes: 64,
  fileSizeBytes: 64 * 1024 * 1024,
  openFiles: 256,
  outputBytes: 1024 * 1024,
  tmpBytes: 64 * 1024 * 1024,
  workspaceBytes: 1024 * 1024 * 1024,
};
const LIMIT_BOUNDS: Record<keyof Limits, [number, number]> = {
  timeoutSec: [1, 3600],
  cpuSec: [1, 3600],
  memoryBytes: [16 * 1024 * 1024, 16 * 1024 * 1024 * 1024],
  processes: [4, 1024],
  fileSizeBytes: [1024, 4 * 1024 * 1024 * 1024],
  openFiles: [16, 4096],
  outputBytes: [1024, 16 * 1024 * 1024],
  tmpBytes: [1024 * 1024, 4 * 1024 * 1024 * 1024],
  workspaceBytes: [1024 * 1024, 64 * 1024 * 1024 * 1024],
};

export type Workspace = { id: string; root: string; exec: boolean; dev: number; ino: number; identity: string };
export type SandboxConfig = {
  bwrap: string;
  prlimit: string;
  shell: string;
  runtime: string[];
  cgroupParent: string;
  limits: Limits;
  maxConcurrentRuns: number;
};
export type WorkspaceConfig = { workspaces: Workspace[]; sandbox: SandboxConfig; policyHash: string };
export type Activation =
  | { state: "off"; reason: string }
  | { state: "not_activated"; reason: string }
  | { state: "invalid"; reason: string }
  | { state: "enabled"; config: WorkspaceConfig };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

export class ConfigError extends Error {}
const bad = (m: string): never => {
  throw new ConfigError(m);
};

function absPath(v: unknown, what: string): string {
  if (typeof v !== "string" || !isAbsolute(v) || normalize(v) !== v || v.length > 512 || v.endsWith("/") && v !== "/") bad(`${what} must be a normalized absolute path.`);
  return v as string;
}

// The per-mount options of the mount whose mount point is exactly `root` (the last such entry wins, as the kernel stacks them).
export function mountOptions(root: string, mountinfo = "/proc/self/mountinfo"): string[] | undefined {
  let found: string[] | undefined;
  for (const line of readFileSync(mountinfo, "utf8").split("\n")) {
    const f = line.split(" ");
    const point = f[4]?.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (point === root) found = (f[5] ?? "").split(",");
  }
  return found;
}

export type HostChecks = {
  uid: () => number;
  // The protected paths a workspace may not be inside or contain (ORBIT's state directory, the vault copy, the credentials directory).
  protectedPaths: string[];
};

// A root-owned executable that its users cannot replace: the launcher interface is fixed, so the binaries behind it must be too.
function trustedBinary(path: string, what: string) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) bad(`${what} (${path}) does not exist.`);
  const real = realpathSync(path);
  const rs = statSync(real);
  if (!rs.isFile()) bad(`${what} (${path}) is not a regular file.`);
  if (rs.uid !== 0) bad(`${what} (${path}) is not owned by root.`);
  if (rs.mode & 0o022) bad(`${what} (${path}) is writable by group or others.`);
  if (rs.mode & 0o6000) bad(`${what} (${path}) is setuid or setgid; the sandbox runs without privileged setup.`);
  // WS-R9: the binary is later executed by path, so no directory on its (resolved) path may be replaceable by anyone but root.
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const ds = statSync(dir);
    if (ds.uid !== 0 || ds.mode & 0o022) bad(`${what} (${path}): the directory ${dir} on its path is not root-owned or is writable by group or others.`);
    if (dir === "/") break;
  }
  return path;
}

function checkRoot(id: string, root: string, exec: boolean, limits: Limits, host: HostChecks): { dev: number; ino: number } {
  for (const f of FORBIDDEN_ROOTS) if (root === f) bad(`Workspace ${id}: ${root} cannot be a workspace root.`);
  for (const t of FORBIDDEN_TREES) if (under(root, t)) bad(`Workspace ${id}: ${root} cannot be a workspace root (nothing under ${t} is allowed).`);
  for (const p of host.protectedPaths) if (under(p, root) || under(root, p)) bad(`Workspace ${id}: the root overlaps a protected ORBIT path.`);
  const st = lstatSync(root, { throwIfNoEntry: false });
  if (!st) bad(`Workspace ${id}: ${root} does not exist.`);
  if (st!.isSymbolicLink() || realpathSync(root) !== root) bad(`Workspace ${id}: the root must not be or pass through a symbolic link.`);
  if (!st!.isDirectory()) bad(`Workspace ${id}: the root is not a directory.`);
  if (st!.uid !== host.uid()) bad(`Workspace ${id}: the root must be owned by the ORBIT service user.`);
  if (st!.mode & 0o077) bad(`Workspace ${id}: the root must be mode 0700 (no group or other access).`);
  if (exec) {
    // Storage is bounded by the filesystem itself: an exec workspace must be its own mount (a dedicated tmpfs or loop filesystem)
    // no larger than workspaceBytes. A sandboxed command cannot fill anything else.
    const parent = statSync(dirname(root));
    if (parent.dev === st!.dev) bad(`Workspace ${id}: an exec workspace must be a dedicated mount (its own filesystem), so its storage is bounded.`);
    const fs = statfsSync(root);
    const total = fs.blocks * fs.bsize;
    if (total > limits.workspaceBytes) bad(`Workspace ${id}: its filesystem is ${total} bytes, more than limits.workspaceBytes (${limits.workspaceBytes}).`);
    // A command can set the setuid bit on files it creates and could create device nodes if it ever had the capability: the mount
    // must neutralize both.
    const opts = mountOptions(root);
    if (!opts) bad(`Workspace ${id}: its mount is not in this process's mount table.`);
    for (const need of ["nosuid", "nodev"]) if (!opts!.includes(need)) bad(`Workspace ${id}: the workspace mount must have the ${need} option.`);
  }
  return { dev: st!.dev, ino: st!.ino };
}

function parseLimits(v: unknown): Limits {
  if (v === undefined) return { ...DEFAULT_LIMITS };
  if (!isObj(v)) return bad("sandbox.limits must be an object.");
  const out: Limits = { ...DEFAULT_LIMITS };
  for (const [k, val] of Object.entries(v)) {
    if (!(k in LIMIT_BOUNDS)) bad(`sandbox.limits.${k} is not a known limit.`);
    const [lo, hi] = LIMIT_BOUNDS[k as keyof Limits];
    if (typeof val !== "number" || !Number.isInteger(val) || val < lo || val > hi) bad(`sandbox.limits.${k} must be an integer between ${lo} and ${hi}.`);
    out[k as keyof Limits] = val as number;
  }
  return out;
}

function parseRuntime(v: unknown): string[] {
  const list = v === undefined ? ["/usr", "/bin", "/sbin", "/lib", "/lib64"] : v;
  if (!Array.isArray(list) || !list.length) return bad("sandbox.runtime must be a non-empty list.");
  const out: string[] = [];
  for (const p of list) {
    if (typeof p !== "string" || !(RUNTIME_ALLOWED as readonly string[]).includes(p)) bad(`sandbox.runtime may only name ${RUNTIME_ALLOWED.join(", ")}.`);
    const st = lstatSync(p as string, { throwIfNoEntry: false });
    if (!st) continue; // absent on this distribution (e.g. /lib32): nothing to mount
    if (st.isSymbolicLink()) {
      const target = readlinkSync(p as string);
      if (!/^usr\/[a-z0-9]+$/.test(target)) bad(`sandbox.runtime: ${p} is a symbolic link to ${target}; only merged-/usr links (usr/...) are supported.`);
    } else {
      if (!st.isDirectory()) bad(`sandbox.runtime: ${p} is not a directory.`);
      if (st.uid !== 0 || st.mode & 0o022) bad(`sandbox.runtime: ${p} must be owned by root and not writable by group or others.`);
    }
    out.push(p as string);
  }
  if (!out.includes("/usr")) bad("sandbox.runtime must include /usr.");
  return out;
}

export function parseConfig(text: string, host: HostChecks): WorkspaceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("The workspaces file is not valid JSON.");
  }
  if (!isObj(raw)) return bad("The workspaces file must be a JSON object.");
  for (const k of Object.keys(raw)) if (!["preActivationChecklist", "workspaces", "sandbox"].includes(k)) bad(`Unknown top-level key ${k}.`);
  const sb = raw.sandbox === undefined ? {} : raw.sandbox;
  if (!isObj(sb)) return bad("sandbox must be an object.");
  for (const k of Object.keys(sb)) if (!["bwrap", "prlimit", "shell", "runtime", "cgroupParent", "limits", "maxConcurrentRuns"].includes(k)) bad(`Unknown sandbox key ${k}.`);
  const limits = parseLimits(sb.limits);
  const maxConcurrentRuns = sb.maxConcurrentRuns === undefined ? 1 : sb.maxConcurrentRuns;
  if (typeof maxConcurrentRuns !== "number" || !Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 4) bad("sandbox.maxConcurrentRuns must be an integer from 1 to 4.");
  const list = raw.workspaces;
  if (!Array.isArray(list) || !list.length || list.length > 16) return bad("workspaces must be a list of 1-16 workspaces.");
  const anyExec = list.some((w) => isObj(w) && w.exec === true);
  const sandbox: SandboxConfig = {
    bwrap: absPath(sb.bwrap ?? "/usr/bin/bwrap", "sandbox.bwrap"),
    prlimit: absPath(sb.prlimit ?? "/usr/bin/prlimit", "sandbox.prlimit"),
    shell: absPath(sb.shell ?? "/bin/sh", "sandbox.shell"),
    runtime: anyExec ? parseRuntime(sb.runtime) : [],
    cgroupParent: sb.cgroupParent === undefined ? "" : absPath(sb.cgroupParent, "sandbox.cgroupParent"),
    limits,
    maxConcurrentRuns: maxConcurrentRuns as number,
  };
  if (anyExec) {
    trustedBinary(sandbox.bwrap, "sandbox.bwrap");
    trustedBinary(sandbox.prlimit, "sandbox.prlimit");
    trustedBinary(sandbox.shell, "sandbox.shell");
    // Aggregate memory, process and CPU limits across a whole run need a cgroup v2 subtree ORBIT may manage. There is no exec without it.
    if (!sandbox.cgroupParent || !under(sandbox.cgroupParent, "/sys/fs/cgroup")) bad("sandbox.cgroupParent (a delegated cgroup v2 directory under /sys/fs/cgroup) is required for exec.");
  }
  const seen = new Set<string>();
  const workspaces: Workspace[] = list.map((w, i) => {
    if (!isObj(w)) return bad(`workspaces[${i}] must be an object.`);
    for (const k of Object.keys(w)) if (!["id", "root", "exec"].includes(k)) bad(`workspaces[${i}]: unknown key ${k}.`);
    if (typeof w.id !== "string" || !ID.test(w.id)) bad(`workspaces[${i}].id must match ${ID}.`);
    const id = w.id as string;
    if (seen.has(id)) bad(`Workspace id ${id} is used twice.`);
    seen.add(id);
    const root = absPath(w.root, `workspaces[${i}].root`);
    if (w.exec !== undefined && typeof w.exec !== "boolean") bad(`workspaces[${i}].exec must be true or false.`);
    const exec = w.exec === true;
    const { dev, ino } = checkRoot(id, root, exec, limits, host);
    return { id, root, exec, dev, ino, identity: "" };
  });
  for (const a of workspaces) for (const b of workspaces) if (a !== b && under(a.root, b.root)) bad(`Workspaces ${a.id} and ${b.id} overlap.`);
  const policyHash = sha(JSON.stringify(sandbox));
  for (const w of workspaces) w.identity = `sha256:${sha(JSON.stringify([w.id, w.root, w.dev, w.ino, w.exec, policyHash]))}`;
  return { workspaces, sandbox, policyHash: `sha256:${policyHash}` };
}

export function loadActivation(env: Record<string, string | undefined>, host: HostChecks, read: (p: string) => string = (p) => readFileSync(p, "utf8")): Activation {
  if (env[WORKSPACE_FLAG] !== "enabled") return { state: "off", reason: `${WORKSPACE_FLAG} is not "enabled" (default off).` };
  const file = env[WORKSPACE_FILE_ENV];
  if (!file) return { state: "invalid", reason: `${WORKSPACE_FILE_ENV} is not set.` };
  let text: string;
  try {
    text = read(file);
  } catch {
    return { state: "invalid", reason: "The workspaces file cannot be read." };
  }
  try {
    const raw = JSON.parse(text) as { preActivationChecklist?: unknown };
    if (raw?.preActivationChecklist !== PRE_ACTIVATION_CHECKLIST) {
      return { state: "not_activated", reason: `The pre-activation checklist has not been acknowledged (preActivationChecklist must be "${PRE_ACTIVATION_CHECKLIST}" after the security review and live-host isolation checks in docs/workspace-tools.md).` };
    }
  } catch {
    return { state: "invalid", reason: "The workspaces file is not valid JSON." };
  }
  if (host.uid() === 0) return { state: "invalid", reason: "ORBIT is running as root; workspace tools never run as root." };
  try {
    return { state: "enabled", config: parseConfig(text, host) };
  } catch (e) {
    return { state: "invalid", reason: e instanceof ConfigError ? e.message : "The workspaces file could not be checked." };
  }
}
