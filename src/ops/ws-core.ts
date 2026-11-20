// Shared by the orbit-ops-ws front (ws-helper.ts) and its runner (ws-run.ts): the FIXED setup plan, the thin host interface the tests
// replace, the read-only host inspection that turns into a plan, and the operation-record store (root-only directory, every write a
// temp file plus rename). Nothing here takes a value from a request: workspaces, sizes, paths, users, units and file contents are
// constants below (docs/orbit-ops-ws.md, "The plan").
import { execFile } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as FS,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { request } from "node:http";
import { dirname, basename } from "node:path";
import { cap, isWsTerminal, OP_ID, planKeyOf, STEP_LIMIT, DETAIL_CHARS, SUMMARY_CHARS, type Blocker, type Plan, type PlanStep, type WsRecord } from "./ws-protocol.ts";
import { redactDeep } from "./protocol.ts";

// ---------------------------------------------------------------- the fixed plan: constants only

export const WORKSPACES = [
  { id: "scratch", sizeBytes: 1024 * 1024 * 1024 },
  // Used only by ORBIT's synthetic smoke validation of the sandbox.
  { id: "orbit-validation", sizeBytes: 64 * 1024 * 1024 },
] as const;
export type WorkspaceId = (typeof WORKSPACES)[number]["id"];

export const MOUNT_BASE = "/srv/orbit-workspaces";
export const IMAGE_DIR = "/var/lib/orbit-workspaces";
export const mountPoint = (id: string) => `${MOUNT_BASE}/${id}`;
export const imagePath = (id: string) => `${IMAGE_DIR}/${id}.img`;
export const fsLabel = (id: string) => `orbit-ws-${id}`;
export const UNIT_DIR = "/etc/systemd/system";
export const DROPIN_DIR = "/etc/systemd/system/orbit.service.d";
export const DROPIN_PATH = `${DROPIN_DIR}/60-orbit-workspace.conf`;
export const CONF_DIR = "/etc/orbit";
export const WORKSPACES_FILE = "/etc/orbit/workspaces.json";
export const ORBIT_USER = "orbit";
export const ORBIT_UNIT = "orbit.service";
export const CHECKLIST = "workspace-tools-host-setup-v2";
export const MIN_SYSTEMD = 254;
export const NEED_CONTROLLERS = ["memory", "pids", "cpu"] as const;
export const SANDBOX = { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", shell: "/bin/sh" } as const;
export const HEALTH_WINDOW_MS = 60_000;
// systemd's dynamic-user range (DynamicUser=): a uid in it is not a static user.
const DYNAMIC_UID_MIN = 61184;
const DYNAMIC_UID_MAX = 65519;

export const BIN = {
  systemctl: "/usr/bin/systemctl",
  getent: "/usr/bin/getent",
  useradd: "/usr/sbin/useradd",
  fallocate: "/usr/bin/fallocate",
  mkfs: "/usr/sbin/mkfs.ext4",
  chown: "/usr/bin/chown",
  chmod: "/usr/bin/chmod",
  rmdir: "/usr/bin/rmdir",
  aptGet: "/usr/bin/apt-get",
} as const;

// nss-systemd answers for the DynamicUser= of a running orbit.service under the same name. This (documented in systemd's
// ENVIRONMENT.md) makes getent and useradd see only real, statically allocated users and groups.
export const NSS_ENV = { SYSTEMD_NSS_DYNAMIC_BYPASS: "1" } as const;
export const APT_ENV = { DEBIAN_FRONTEND: "noninteractive", APT_LISTCHANGES_FRONTEND: "none", NEEDRESTART_SUSPEND: "1", LC_ALL: "C" } as const;
export const APT_ARGS = ["-o", "DPkg::Lock::Timeout=120", "install", "-y", "--no-install-recommends", "bubblewrap"] as const;
export const APT_LOCK_TEXT = /Could not get lock|Unable to acquire the dpkg|Unable to lock|is held by process|dpkg frontend lock|Waiting for cache lock/i;
export const SHOW_ARGS = ["show", ORBIT_UNIT, "--timestamp=unix", "-p", "ActiveState", "-p", "MainPID", "-p", "NeedDaemonReload", "-p", "DropInPaths", "-p", "ControlGroup", "-p", "ActiveEnterTimestamp"] as const;

// systemd-escape --path, for the fixed mount points: strip the outer slashes, "/" becomes "-", and every byte outside [A-Za-z0-9:_.]
// (and a leading ".") becomes \xNN.
export function systemdEscapePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  if (!trimmed) return "-";
  return trimmed
    .split("/")
    .join("\u0000")
    .replace(/^\.|[^A-Za-z0-9:_.\u0000]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .split("\u0000")
    .join("-");
}
export const mountUnitName = (id: string) => `${systemdEscapePath(mountPoint(id))}.mount`;
export const mountUnitPath = (id: string) => `${UNIT_DIR}/${mountUnitName(id)}`;

export function mountUnitText(id: string): string {
  return [
    `# Managed by orbit-ops-ws (docs/orbit-ops-ws.md). Loop-mounted filesystem for ORBIT workspace "${id}".`,
    "[Unit]",
    `Description=ORBIT workspace ${id}`,
    "Before=orbit.service",
    "",
    "[Mount]",
    `What=${imagePath(id)}`,
    `Where=${mountPoint(id)}`,
    "Type=ext4",
    "Options=loop,nosuid,nodev,noatime",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

const DROPIN_HEAD = [
  "# Managed by orbit-ops-ws (docs/orbit-ops-ws.md). Workspace tools stay OFF until the owner enables them in ORBIT.",
  "[Service]",
  "Delegate=memory pids cpu",
  "DelegateSubgroup=main",
  `ReadWritePaths=${WORKSPACES.map((w) => `-${mountPoint(w.id)}`).join(" ")}`,
];
// ORBIT_WORKSPACE_TOOLS=enabled here means the HOST permits workspace tools. ORBIT keeps them off until the owner separately enables
// them in ORBIT; that gate is ORBIT's, not this helper's.
export const DROPIN_TEXT = [...DROPIN_HEAD, `Environment=ORBIT_WORKSPACE_TOOLS=enabled ORBIT_WORKSPACES_FILE=${WORKSPACES_FILE}`, ""].join("\n");
// ws_revoke writes this: the same file without the Environment= line (delegation and paths stay).
export const DROPIN_REVOKED_TEXT = [...DROPIN_HEAD, ""].join("\n");

export const CGROUP = /^\/[A-Za-z0-9_.:@\\/-]{1,200}\.service$/;
export function workspacesFileText(controlGroup: string): string {
  return `${JSON.stringify({
    preActivationChecklist: CHECKLIST,
    workspaces: WORKSPACES.map((w) => ({ id: w.id, root: mountPoint(w.id), exec: true })),
    sandbox: { bwrap: SANDBOX.bwrap, prlimit: SANDBOX.prlimit, shell: SANDBOX.shell, cgroupParent: `/sys/fs/cgroup${controlGroup}/workspace-exec`, maxConcurrentRuns: 1 },
  })}\n`;
}

// ---------------------------------------------------------------- host interface

export type Exec = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Probe = { reachable: boolean; httpStatus?: number; commit?: string };
// noKill: the timeout is not enforced by killing the child (package managers are never killed by this code).
export type ExecOpts = { env?: Record<string, string>; noKill?: boolean };
export type FileInfo = { kind: "file" | "dir" | "symlink" | "other"; uid: number; gid: number; mode: number; size: number; mtimeMs: number; dev?: number; ino?: number };

// Every file the helpers read or write on the host goes through this. Paths are the real absolute host paths; the implementation may
// put them under a prefix (tests use a temporary directory).
export type WsFs = {
  lstat(path: string): FileInfo | undefined;
  stat(path: string): FileInfo | undefined; // follows symbolic links
  readText(path: string, maxBytes?: number): string | undefined;
  readBytes(path: string, offset: number, length: number): Buffer | undefined;
  readdir(path: string): string[] | undefined;
  // Creates the directory (root:root) if it is absent, then sets its mode. Never removes or replaces anything.
  ensureDir(path: string, mode: number): void;
  // Creates an EMPTY file exclusively (fails if anything exists there), root:root.
  createExclusive(path: string, mode: number): void;
  // Writes a temp file next to `path`, sets owner and mode, then renames it over `path` (or, with noClobber, links it to `path`,
  // which fails if `path` exists, so an existing file is never replaced).
  writeFile(path: string, content: string, opts: { mode: number; uid: number; gid: number; noClobber: boolean }): void;
  // Removes one regular file, only if it is still exactly the expected inode (finding 5: a partial image this helper created).
  removeExact(path: string, expect: { dev: number; ino: number }): void;
};

export type WsEnv = {
  // Every command is a fixed absolute path with fixed arguments (see the allowlist test); no value from a request reaches it except
  // a validated 40-hex operation id inside a unit instance name.
  exec(file: string, args: string[], timeoutMs: number, opts?: ExecOpts): Promise<Exec>;
  // GET http://host:port/path. Reports the HTTP status and, for /status, the commit it names. Never throws.
  probe(host: string, port: number, path: string): Promise<Probe>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  fs: WsFs;
};

const info = (st: Stats): FileInfo => ({
  kind: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
  uid: st.uid,
  gid: st.gid,
  mode: st.mode & 0o7777,
  size: st.size,
  mtimeMs: st.mtimeMs,
  dev: st.dev,
  ino: st.ino,
});

// The real filesystem. `owners`, when given (tests only), records ownership changes instead of calling chown and reports them back
// from lstat/stat, so the tests can run without root.
export function hostFs(prefix = "", owners?: Map<string, { uid: number; gid: number }>): WsFs {
  const at = (p: string) => `${prefix}${p}`;
  const own = (p: string, fi: FileInfo | undefined): FileInfo | undefined => {
    const o = owners?.get(p);
    return fi && o ? { ...fi, uid: o.uid, gid: o.gid } : fi;
  };
  const chown = (p: string, uid: number, gid: number) => (owners ? void owners.set(p, { uid, gid }) : chownSync(at(p), uid, gid));
  const fs: WsFs = {
    lstat: (p) => {
      try {
        return own(p, info(lstatSync(at(p))));
      } catch {
        return undefined;
      }
    },
    stat: (p) => {
      try {
        return own(p, info(statSync(at(p))));
      } catch {
        return undefined;
      }
    },
    readText: (p, maxBytes = 256 * 1024) => {
      try {
        const st = statSync(at(p));
        if (!st.isFile() && !p.startsWith("/proc/") && !p.startsWith("/sys/")) return undefined;
        const text = readFileSync(at(p), "utf8");
        return Buffer.byteLength(text) > maxBytes ? undefined : text;
      } catch {
        return undefined;
      }
    },
    readBytes: (p, offset, length) => {
      let fd: number | undefined;
      try {
        fd = openSync(at(p), FS.O_RDONLY | FS.O_NOFOLLOW);
        const buf = Buffer.alloc(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n);
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    readdir: (p) => {
      try {
        return readdirSync(at(p));
      } catch {
        return undefined;
      }
    },
    ensureDir: (p, mode) => {
      const st = fs.lstat(p);
      if (st && st.kind !== "dir") throw new Error(`${p} exists and is not a directory`);
      if (!st) {
        mkdirSync(at(p), { mode });
        chown(p, 0, 0);
      }
      chmodSync(at(p), mode);
    },
    createExclusive: (p, mode) => {
      const fd = openSync(at(p), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, mode);
      closeSync(fd);
      chown(p, 0, 0);
      chmodSync(at(p), mode);
    },
    removeExact: (p, expect) => {
      const st = lstatSync(at(p));
      if (!st.isFile() || st.dev !== expect.dev || st.ino !== expect.ino) throw new Error(`${p} is not the expected file; it was not removed`);
      unlinkSync(at(p));
      owners?.delete(p);
    },
    writeFile: (p, content, o) => {
      const tmp = `${dirname(p)}/.${basename(p)}.orbit-ops-ws-${process.pid}.tmp`;
      rmSync(at(tmp), { force: true });
      const fd = openSync(at(tmp), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        chown(tmp, o.uid, o.gid);
        chmodSync(at(tmp), o.mode);
        if (o.noClobber) {
          linkSync(at(tmp), at(p));
          unlinkSync(at(tmp));
          if (owners) owners.set(p, owners.get(tmp)!);
        } else {
          renameSync(at(tmp), at(p));
          if (owners) owners.set(p, owners.get(tmp)!);
        }
      } finally {
        rmSync(at(tmp), { force: true });
        owners?.delete(tmp);
      }
    },
  };
  return fs;
}

const MAX_OUT = 256 * 1024;

export const systemWsEnv: WsEnv = {
  exec: (file, args, timeoutMs, opts) =>
    new Promise((resolve) => {
      execFile(
        file,
        args,
        { ...(opts?.noKill ? {} : { timeout: timeoutMs }), maxBuffer: MAX_OUT, shell: false, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", ...(opts?.env ?? {}) } },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(e?.killed) });
        },
      );
    }),
  probe: (host, port, path) =>
    new Promise((resolve) => {
      const req = request({ host, port, path, method: "GET", timeout: 4000 }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (body.length > 256 * 1024) res.destroy();
        });
        res.on("end", () => {
          let commit: string | undefined;
          try {
            const c = (JSON.parse(body) as { commit?: unknown }).commit;
            if (typeof c === "string") commit = c;
          } catch {
            // not JSON: no commit
          }
          resolve({ reachable: true, httpStatus: res.statusCode, ...(commit ? { commit } : {}) });
        });
        res.on("error", () => resolve({ reachable: false }));
      });
      req.on("error", () => resolve({ reachable: false }));
      req.on("timeout", () => req.destroy());
      req.end();
    }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  fs: hostFs(),
};

// Every timeout the runner can spend, in one place (finding 5 of the PR #147 review): the unit's TimeoutStartSec is derived from these
// and a test checks it (test/ops-ws.test.ts).
export const T = { short: 10_000, show: 15_000, user: 60_000, fallocate: 120_000, mkfs: 300_000, mount: 180_000, reload: 120_000, restart: 120_000, pkg: 1_900_000, probe: 4_000 };

// ---------------------------------------------------------------- time bounds (finding 5 of the PR #147 review)

// The longest one operation can take, from its timeout (or, for steps without a command, a generous second).
export function opWorstMs(op: Op, healthWindowMs = HEALTH_WINDOW_MS, healthIntervalMs = 2_000): number {
  switch (op.k) {
    case "exec":
      return op.timeoutMs;
    case "pkg":
      return T.pkg;
    case "write":
      return T.short + 1_000; // getent for the group, then the write
    case "tidy_lost_found":
      return T.short;
    case "restart_and_health":
      return T.reload + T.restart + healthWindowMs + T.probe + healthIntervalMs;
    default:
      return 1_000;
  }
}
// Reading the host once (gatherFacts): systemctl show, --version, two getent, one is-enabled per workspace.
export const FACTS_WORST_MS = T.show + T.short * (3 + WORKSPACES.length);
// A whole setup run after the deploy lock is held: plan, every step, the final /status wait and the re-plan.
export function setupWorstMs(steps: { ops: Op[] }[], healthWindowMs = HEALTH_WINDOW_MS, healthIntervalMs = 2_000): number {
  const ops = steps.flatMap((s) => s.ops).reduce((n, op) => n + opWorstMs(op, healthWindowMs, healthIntervalMs), 0);
  return FACTS_WORST_MS * 2 + ops + healthWindowMs + T.probe + healthIntervalMs;
}
// The runner's budget. It covers the worst case of the largest plan there is (a fresh host whose two images are both partial leftovers,
// checked by a test), and the runner unit's TimeoutStartSec covers the lock wait plus this budget plus node's start (also checked).
export const RUN_BUDGET_MS = 4_200_000;

// ---------------------------------------------------------------- configuration (fixed; tests replace paths and timings only)

export type WsConfig = {
  stateDir: string; // /var/lib/orbit-ops-ws (records, the replay register, the one-at-a-time slots, partial-image markers)
  orbitRoot: string; // /opt/orbit (orbit.env for HOST/PORT, current/COMMIT), read through env.fs
  units: { runner: string; pkg: string };
  healthWindowMs: number;
  healthIntervalMs: number;
  staleAfterMs: number;
  // A "reserved" record (a front still checking the request) older than this belongs to a front systemd has stopped (RuntimeMaxSec=40).
  reserveStaleMs: number;
  lockWaitSeconds: number;
  keepRecords: number;
  // The runner's own time budget after it holds the deploy lock (see RUN_BUDGET_MS); a step that could not finish within it is not started.
  runBudgetMs: number;
};

export const WS_CONFIG: WsConfig = {
  stateDir: "/var/lib/orbit-ops-ws",
  orbitRoot: "/opt/orbit",
  units: { runner: "orbit-ops-ws-run@", pkg: "orbit-ops-ws-pkg@" },
  healthWindowMs: HEALTH_WINDOW_MS,
  healthIntervalMs: 2_000,
  staleAfterMs: 30_000,
  reserveStaleMs: 60_000,
  lockWaitSeconds: 300,
  keepRecords: 50,
  runBudgetMs: RUN_BUDGET_MS,
};

// ---------------------------------------------------------------- what the runner may do (structured; the card text is derived)

export type Op =
  | { k: "exec"; file: string; args: string[]; env?: Record<string, string>; timeoutMs: number }
  | { k: "pkg" } // apt-get install bubblewrap, in the separate package unit (the only one with network access)
  | { k: "ensure_dir"; path: string; mode: number }
  | { k: "create_image"; path: string }
  | { k: "write"; path: string; content: string; mode: number; group: "root" | "orbit"; noClobber: boolean }
  | { k: "tidy_lost_found"; root: string } // rmdir <root>/lost+found if it exists (rmdir refuses a non-empty directory)
  // A partial image left by an interrupted earlier setup: created by this helper (its inode was recorded at creation), never formatted
  // to completion, not mounted. Removed only if it is still exactly that inode (finding 5 of the PR #147 review).
  | { k: "discard_partial_image"; path: string; dev: number; ino: number; workspace: string }
  | { k: "restart_and_health" };

export type PlannedStep = PlanStep & { ops: Op[] };
export type FullPlan = Plan & { planned: PlannedStep[]; facts: Facts };

const shq = (a: string) => (/^[A-Za-z0-9_./:=@,+%-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const oct = (m: number) => `0${m.toString(8)}`;
export function describeOp(op: Op): string {
  switch (op.k) {
    case "exec":
      return `${Object.entries(op.env ?? {}).filter(([k]) => k !== "SYSTEMD_NSS_DYNAMIC_BYPASS").map(([k, v]) => `${k}=${v} `).join("")}${op.file} ${op.args.map(shq).join(" ")}`;
    case "pkg":
      return `DEBIAN_FRONTEND=noninteractive ${BIN.aptGet} ${APT_ARGS.join(" ")} (run in the separate unit orbit-ops-ws-pkg@.service, the only one with network access; if the package lock is busy it fails with nothing changed and nothing is killed or unlocked)`;
    case "ensure_dir":
      return `create directory ${op.path} if absent (root:root), mode ${oct(op.mode)}`;
    case "create_image":
      return `create the empty file ${op.path} (root:root, mode 0600; refused if anything already exists there)`;
    case "write":
      return `${op.noClobber ? "create" : "write"} ${op.path} (root:${op.group}, mode ${oct(op.mode)}${op.noClobber ? "; refused if it already exists" : ""}) with exactly:\n${op.content}`;
    case "tidy_lost_found":
      return `if ${op.root}/lost+found exists: ${BIN.rmdir} ${op.root}/lost+found (rmdir only removes an empty directory)`;
    case "discard_partial_image":
      return `remove the partial image ${op.path} left by an interrupted earlier setup (this helper created it, inode ${op.ino}, and never finished formatting it; it was never mounted); refused unless it is still exactly that file and nothing is mounted at ${mountPoint(op.workspace)}`;
    case "restart_and_health":
      return `${BIN.systemctl} daemon-reload; ${BIN.systemctl} restart ${ORBIT_UNIT} (ORBIT is offline for a few seconds); then wait up to ${HEALTH_WINDOW_MS / 1000} s for ORBIT's /status to answer 200 and serve the commit /opt/orbit/current/COMMIT named before the restart`;
  }
}

export const actionText = (ops: Op[]) => ops.map(describeOp).join("\n");

const exec = (file: string, args: string[], timeoutMs: number, env?: Record<string, string>): Op => ({ k: "exec", file, args, timeoutMs, ...(env ? { env } : {}) });

// ---------------------------------------------------------------- read-only host inspection

export type UserEntry = { name: string; uid: number; gid: number; shell: string };
export type GroupEntry = { name: string; gid: number };
export type OrbitUnit = { activeState: string; mainPid: number; needReload: string; dropInPaths: string[]; controlGroup: string; activeEnterSec?: number; readable: boolean };
export type StorageFacts = {
  id: string;
  sizeBytes: number;
  image?: FileInfo;
  imageExt4: boolean;
  imageLabel: string;
  unitText?: string;
  unitInfo?: FileInfo;
  unitEnabled: string;
  mount?: { fstype: string; opts: string[] };
  root?: FileInfo;
  lostFound?: FileInfo;
  lostFoundEntries?: number;
  // This helper's own record that it created this image and has not yet seen it formatted (see imageMarkers).
  marker?: ImageMarker;
};
export type Facts = {
  bwrap?: FileInfo;
  prlimit?: FileInfo;
  user?: UserEntry;
  group?: GroupEntry;
  imageDir?: FileInfo;
  storage: StorageFacts[];
  confDir?: FileInfo;
  wsFile?: FileInfo;
  wsFileText?: string;
  dropInDir?: FileInfo;
  dropIn?: FileInfo;
  dropInText?: string;
  orbit: OrbitUnit;
  orbitProcUid?: number;
  systemdVersion?: number;
  cgroup2: boolean;
  controllers: string[];
  apparmorRestrictUserns?: string;
  maxUserNamespaces?: string;
  unprivilegedUsernsClone?: string;
};

export type MountEntry = { point: string; opts: string[]; fstype: string };
export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    const sep = f.indexOf("-", 6);
    if (f.length < 7 || sep < 0) continue;
    const point = f[4]!.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    out.push({ point, opts: (f[5] ?? "").split(","), fstype: f[sep + 1] ?? "" });
  }
  return out;
}
const lastMount = (entries: MountEntry[], point: string) => entries.filter((e) => e.point === point).at(-1);

function parsePasswd(text: string): UserEntry | undefined {
  const f = text.split("\n")[0]?.split(":") ?? [];
  if (f.length < 7 || f[0] !== ORBIT_USER || !/^[0-9]{1,10}$/.test(f[2]!) || !/^[0-9]{1,10}$/.test(f[3]!)) return undefined;
  return { name: f[0], uid: Number(f[2]), gid: Number(f[3]), shell: f[6]!.trim() };
}
function parseGroup(text: string): GroupEntry | undefined {
  const f = text.split("\n")[0]?.split(":") ?? [];
  if (f.length < 3 || f[0] !== ORBIT_USER || !/^[0-9]{1,10}$/.test(f[2]!)) return undefined;
  return { name: f[0], gid: Number(f[2]) };
}
export function parseShow(text: string, ok: boolean): OrbitUnit {
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const ts = /^@([0-9]{1,12})$/.exec(kv.get("ActiveEnterTimestamp") ?? "");
  const pid = kv.get("MainPID") ?? "";
  return {
    readable: ok && kv.has("ActiveState"),
    activeState: kv.get("ActiveState") ?? "",
    mainPid: /^[0-9]{1,10}$/.test(pid) ? Number(pid) : 0,
    needReload: kv.get("NeedDaemonReload") ?? "",
    dropInPaths: (kv.get("DropInPaths") ?? "").split(/\s+/).filter(Boolean),
    controlGroup: kv.get("ControlGroup") ?? "",
    ...(ts ? { activeEnterSec: Number(ts[1]) } : {}),
  };
}

const firstLine = (s: string | undefined) => (s ?? "").split("\n")[0]!.trim();

// Reads only. Every command it runs is a query (`systemctl show/--version/is-enabled`, `getent`).
export async function gatherFacts(env: WsEnv, c?: WsConfig): Promise<Facts> {
  const fs = env.fs;
  const show = await env.exec(BIN.systemctl, [...SHOW_ARGS], T.show);
  const orbit = parseShow(show.stdout, show.code === 0 && !show.timedOut);
  const ver = await env.exec(BIN.systemctl, ["--version"], T.short);
  const vm = /^systemd ([0-9]{2,4})\b/.exec(ver.stdout);
  const pw = await env.exec(BIN.getent, ["passwd", ORBIT_USER], T.short, { env: { ...NSS_ENV } });
  const gr = await env.exec(BIN.getent, ["group", ORBIT_USER], T.short, { env: { ...NSS_ENV } });
  const mounts = parseMountinfo(fs.readText("/proc/self/mountinfo", 4 * 1024 * 1024) ?? "");
  const storage: StorageFacts[] = [];
  for (const w of WORKSPACES) {
    const image = fs.lstat(imagePath(w.id));
    let imageExt4 = false;
    let imageLabel = "";
    if (image?.kind === "file") {
      const sb = fs.readBytes(imagePath(w.id), 1024, 136);
      if (sb && sb.length >= 136) {
        imageExt4 = sb.readUInt16LE(56) === 0xef53;
        imageLabel = sb.subarray(120, 136).toString("latin1").replace(/\u0000.*$/s, "");
      }
    }
    const en = await env.exec(BIN.systemctl, ["is-enabled", mountUnitName(w.id)], T.short);
    const m = lastMount(mounts, mountPoint(w.id));
    const root = fs.lstat(mountPoint(w.id));
    const lostFound = m ? fs.lstat(`${mountPoint(w.id)}/lost+found`) : undefined;
    const lostFoundEntries = lostFound?.kind === "dir" ? fs.readdir(`${mountPoint(w.id)}/lost+found`)?.length : undefined;
    storage.push({
      id: w.id,
      sizeBytes: w.sizeBytes,
      ...(image ? { image } : {}),
      imageExt4,
      imageLabel,
      ...(fs.lstat(mountUnitPath(w.id)) ? { unitInfo: fs.lstat(mountUnitPath(w.id))!, unitText: fs.readText(mountUnitPath(w.id), 64 * 1024) ?? "" } : {}),
      unitEnabled: firstLine(en.stdout),
      ...(m ? { mount: { fstype: m.fstype, opts: m.opts } } : {}),
      ...(root ? { root } : {}),
      ...(lostFound ? { lostFound } : {}),
      ...(lostFoundEntries !== undefined ? { lostFoundEntries } : {}),
      ...(c && readImageMarker(c, w.id) ? { marker: readImageMarker(c, w.id)! } : {}),
    });
  }
  const cg = lastMount(mounts, "/sys/fs/cgroup");
  const user = pw.code === 0 ? parsePasswd(pw.stdout) : undefined;
  const group = gr.code === 0 ? parseGroup(gr.stdout) : undefined;
  const proc = orbit.mainPid > 0 ? fs.lstat(`/proc/${orbit.mainPid}`) : undefined;
  const sysctl = (p: string) => {
    const v = fs.readText(p, 64);
    return v === undefined ? undefined : v.trim();
  };
  const opt = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));
  return {
    ...opt("bwrap", fs.stat(SANDBOX.bwrap)),
    ...opt("prlimit", fs.stat(SANDBOX.prlimit)),
    ...opt("user", user),
    ...opt("group", group),
    ...opt("imageDir", fs.lstat(IMAGE_DIR)),
    storage,
    ...opt("confDir", fs.lstat(CONF_DIR)),
    ...opt("wsFile", fs.lstat(WORKSPACES_FILE)),
    ...opt("wsFileText", fs.lstat(WORKSPACES_FILE) ? fs.readText(WORKSPACES_FILE, 64 * 1024) : undefined),
    ...opt("dropInDir", fs.lstat(DROPIN_DIR)),
    ...opt("dropIn", fs.lstat(DROPIN_PATH)),
    ...opt("dropInText", fs.lstat(DROPIN_PATH) ? fs.readText(DROPIN_PATH, 64 * 1024) : undefined),
    orbit,
    ...opt("orbitProcUid", proc?.uid),
    ...opt("systemdVersion", vm ? Number(vm[1]) : undefined),
    cgroup2: cg?.fstype === "cgroup2",
    controllers: (fs.readText("/sys/fs/cgroup/cgroup.controllers", 4096) ?? "").trim().split(/\s+/).filter(Boolean),
    ...opt("apparmorRestrictUserns", sysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")),
    ...opt("maxUserNamespaces", sysctl("/proc/sys/user/max_user_namespaces")),
    ...opt("unprivilegedUsernsClone", sysctl("/proc/sys/kernel/unprivileged_userns_clone")),
  };
}

// ---------------------------------------------------------------- facts -> plan (pure)

const NOLOGIN = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false"];
export const isStaticSystemUser = (u: UserEntry | undefined) => Boolean(u && u.uid > 0 && u.uid < 1000 && NOLOGIN.includes(u.shell));
const isDynamic = (id: number) => id >= DYNAMIC_UID_MIN && id <= DYNAMIC_UID_MAX;
const step = (id: string, title: string, state: PlanStep["state"], ops: Op[], detail: string): PlannedStep => ({
  id,
  title,
  state,
  action: state === "todo" ? actionText(ops) : "(nothing)",
  detail,
  ops: state === "todo" ? ops : [],
});

function packageStep(f: Facts): PlannedStep {
  const title = "Package bubblewrap (sandbox launcher), and util-linux's prlimit present";
  const p = f.prlimit;
  if (!p || p.kind !== "file" || p.uid !== 0 || p.mode & 0o022 || p.mode & 0o6000) {
    return step("package_bubblewrap", title, "blocked", [], `${SANDBOX.prlimit} is ${p ? "not a root-owned, non-writable, non-setuid file" : "missing"}. It comes with util-linux, which this helper does not install or change: an operator must decide.`);
  }
  const b = f.bwrap;
  if (!b) return step("package_bubblewrap", title, "todo", [{ k: "pkg" }], `${SANDBOX.bwrap} is not installed.`);
  if (b.kind !== "file" || b.uid !== 0) return step("package_bubblewrap", title, "blocked", [], `${SANDBOX.bwrap} exists but is not a root-owned regular file; an operator must decide.`);
  if (b.mode & 0o6000) return step("package_bubblewrap", title, "blocked", [], `${SANDBOX.bwrap} is setuid or setgid. ORBIT's sandbox never uses a privileged bwrap; an operator must decide what to do with this installation.`);
  if (b.mode & 0o022) return step("package_bubblewrap", title, "blocked", [], `${SANDBOX.bwrap} is writable by group or others; an operator must fix it.`);
  return step("package_bubblewrap", title, "done", [], `${SANDBOX.bwrap} and ${SANDBOX.prlimit} are root-owned, not writable by others and not setuid.`);
}

function identityStep(f: Facts): PlannedStep {
  const title = "Static system user and group orbit (ORBIT's uid changes at its next restart)";
  const impact =
    "Shared-service impact: orbit.service has DynamicUser=yes and no User=, so systemd names its user after the unit (orbit); once a static user and group of that name exist, systemd uses them instead of allocating a dynamic uid. From ORBIT's next restart it runs as this stable uid, and at that start systemd re-owns ORBIT's state directory recursively.";
  const u = f.user;
  const g = f.group;
  if (u && isDynamic(u.uid)) return step("identity", title, "blocked", [], `getent still reports orbit with a dynamic uid (${u.uid}) although dynamic users were bypassed; an operator must inspect the host's NSS setup.`);
  if (u) {
    if (!isStaticSystemUser(u)) return step("identity", title, "blocked", [], `A user named orbit already exists (uid ${u.uid}, shell ${u.shell}) that is not a system account with a non-login shell. This helper never changes an existing account; an operator must decide.`);
    if (!g || g.gid >= 1000 || g.gid === 0) return step("identity", title, "blocked", [], "The system user orbit exists but a matching system group orbit does not; an operator must decide.");
    return step("identity", title, "done", [], `orbit is a static system user (uid ${u.uid}) with group orbit (gid ${g.gid}).`);
  }
  if (g && (g.gid >= 1000 || g.gid === 0)) return step("identity", title, "blocked", [], `A group named orbit exists with gid ${g.gid}, which is not a system group; an operator must decide.`);
  const common = ["--system", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin"];
  const args = g ? ["--system", "--gid", ORBIT_USER, ...common.slice(1), ORBIT_USER] : ["--system", "--user-group", ...common.slice(1), ORBIT_USER];
  return step("identity", title, "todo", [exec(BIN.useradd, args, T.user, { ...NSS_ENV })], impact);
}

function storageStep(f: Facts, s: StorageFacts): PlannedStep {
  const id = `storage_${s.id}`;
  const root = mountPoint(s.id);
  const title = `Workspace filesystem ${s.id} (${s.sizeBytes / 1024 / 1024} MiB ext4 image, loop-mounted nosuid,nodev at ${root})`;
  const blocked = (why: string) => step(id, title, "blocked", [], why);
  const ops: Op[] = [];
  const notes: string[] = [];
  const d = f.imageDir;
  if (d && (d.kind !== "dir" || d.uid !== 0)) return blocked(`${IMAGE_DIR} exists but is not a root-owned directory; an operator must decide.`);
  if (!d || d.mode !== 0o700) ops.push({ k: "ensure_dir", path: IMAGE_DIR, mode: 0o700 });
  const img = imagePath(s.id);
  // A partial image this helper created in an earlier, interrupted setup (killed during fallocate or mkfs): recreated, never kept and
  // never left to block every later setup. Only exactly the recorded inode, only while nothing is mounted at the workspace root, and
  // never an image that looks formatted while a mount unit for it exists (it might have been mounted and hold data).
  const mk = s.marker;
  const partial = Boolean(
    mk && s.image && s.image.kind === "file" && s.image.uid === 0 && mk.path === img && mk.dev === s.image.dev && mk.ino === s.image.ino && !s.mount && !(s.imageExt4 && s.unitInfo),
  );
  if (partial) {
    ops.push(
      { k: "discard_partial_image", path: img, dev: mk!.dev, ino: mk!.ino, workspace: s.id },
      { k: "create_image", path: img },
      exec(BIN.fallocate, ["-l", String(s.sizeBytes), img], T.fallocate),
      exec(BIN.mkfs, ["-q", "-F", "-L", fsLabel(s.id), img], T.mkfs),
    );
    notes.push(`the partial image left by an interrupted earlier setup (operation ${mk!.opId.slice(0, 12)}) is replaced`);
  } else if (s.image) {
    if (mk && mk.path === img) return blocked(`${img} was created by this helper in an earlier setup that never finished formatting it, but it is not safe to replace automatically (it changed, is mounted, or looks formatted while a mount unit exists). An operator must inspect it.`);
    if (s.image.kind !== "file") return blocked(`${img} exists but is not a regular file; it is never touched.`);
    if (!s.imageExt4) return blocked(`${img} exists without a recognised ext4 filesystem. An existing image is never formatted; an operator must decide.`);
    if (s.imageLabel !== fsLabel(s.id)) notes.push(`existing image has label "${s.imageLabel}" (kept)`);
    if (s.image.size !== s.sizeBytes) notes.push(`existing image is ${s.image.size} bytes (kept as is)`);
  } else {
    ops.push(
      { k: "create_image", path: img },
      exec(BIN.fallocate, ["-l", String(s.sizeBytes), img], T.fallocate),
      exec(BIN.mkfs, ["-q", "-F", "-L", fsLabel(s.id), img], T.mkfs),
    );
  }
  const unit = mountUnitName(s.id);
  const want = mountUnitText(s.id);
  const m = s.mount;
  if (m && (m.fstype !== "ext4" || !m.opts.includes("nosuid") || !m.opts.includes("nodev"))) {
    return blocked(`Something is already mounted at ${root} (${m.fstype}, ${m.opts.join(",")}) that is not an ext4 nosuid,nodev mount; it is never unmounted by this helper.`);
  }
  if (s.unitInfo !== undefined && (s.unitInfo.kind !== "file" || s.unitText !== want)) {
    return blocked(`${mountUnitPath(s.id)} exists with content this helper did not write; it is never replaced. An operator must reconcile it.`);
  }
  if (s.root && s.root.kind !== "dir") return blocked(`${root} exists and is not a directory.`);
  if (!s.unitInfo && m) {
    notes.push(`${root} is already mounted (ext4, nosuid,nodev) by something other than this helper's unit; that mount is used as is`);
  } else {
    if (!s.unitInfo) ops.push({ k: "write", path: mountUnitPath(s.id), content: want, mode: 0o644, group: "root", noClobber: true }, exec(BIN.systemctl, ["daemon-reload"], T.reload));
    if (!s.unitInfo || s.unitEnabled !== "enabled" || !m) ops.push(exec(BIN.systemctl, ["enable", "--now", unit], T.mount));
  }
  if (m) {
    if (s.lostFound && (s.lostFound.kind !== "dir" || (s.lostFoundEntries ?? 1) > 0)) return blocked(`${root}/lost+found is not an empty directory; it is never removed. An operator must inspect it.`);
    if (s.lostFound) ops.push(exec(BIN.rmdir, [`${root}/lost+found`], T.short));
    const uid = f.user && isStaticSystemUser(f.user) ? f.user.uid : undefined;
    if (!s.root || uid === undefined || s.root.uid !== uid || s.root.gid !== f.group?.gid) ops.push(exec(BIN.chown, ["-h", `${ORBIT_USER}:${ORBIT_USER}`, root], T.short));
    if (!s.root || s.root.mode !== 0o700) ops.push(exec(BIN.chmod, ["0700", root], T.short));
  } else {
    ops.push({ k: "tidy_lost_found", root }, exec(BIN.chown, ["-h", `${ORBIT_USER}:${ORBIT_USER}`, root], T.short), exec(BIN.chmod, ["0700", root], T.short));
  }
  const note = notes.length ? ` Note: ${notes.join("; ")}.` : "";
  if (!ops.length) return step(id, title, "done", [], `Mounted ext4 with nosuid,nodev; root owned by orbit, mode 0700, no lost+found.${note}`);
  return step(id, title, "todo", ops, `${partial ? "The partial image of an interrupted earlier setup is removed and created again (only that exact file)." : s.image ? "The existing image is kept (never formatted)." : "A new image is created and formatted (only this new image is ever formatted)."} No workspace data is deleted.${note}`);
}

function workspacesFileStep(f: Facts): PlannedStep {
  const title = `Workspaces file ${WORKSPACES_FILE} (which workspaces exist and how the sandbox runs)`;
  const cgOk = CGROUP.test(f.orbit.controlGroup) && !f.orbit.controlGroup.split("/").includes("..");
  if (f.confDir && (f.confDir.kind !== "dir" || f.confDir.uid !== 0)) return step("workspaces_file", title, "blocked", [], `${CONF_DIR} exists but is not a root-owned directory; an operator must decide.`);
  if (f.wsFile) {
    if (f.wsFile.kind !== "file" || !cgOk || f.wsFileText !== workspacesFileText(f.orbit.controlGroup)) {
      return step("workspaces_file", title, "done", [], "exists and differs; kept unchanged (operator-managed).");
    }
    const ops: Op[] = [];
    if (f.wsFile.uid !== 0 || !f.group || f.wsFile.gid !== f.group.gid) ops.push(exec(BIN.chown, [`root:${ORBIT_USER}`, WORKSPACES_FILE], T.short));
    if (f.wsFile.mode !== 0o640) ops.push(exec(BIN.chmod, ["0640", WORKSPACES_FILE], T.short));
    return ops.length ? step("workspaces_file", title, "todo", ops, "The file has the expected content; only its owner or mode is corrected.") : step("workspaces_file", title, "done", [], "Present with the expected content, root:orbit, mode 0640.");
  }
  if (!cgOk) return step("workspaces_file", title, "blocked", [], `The control group of ${ORBIT_UNIT} could not be read (is it running?), so the sandbox's cgroupParent cannot be written. Ask again while ORBIT runs.`);
  const ops: Op[] = [];
  if (!f.confDir || f.confDir.mode !== 0o755) ops.push({ k: "ensure_dir", path: CONF_DIR, mode: 0o755 });
  ops.push({ k: "write", path: WORKSPACES_FILE, content: workspacesFileText(f.orbit.controlGroup), mode: 0o640, group: "orbit", noClobber: true });
  return step("workspaces_file", title, "todo", ops, "Created only if absent; an existing file is never overwritten.");
}

function dropInStep(f: Facts): PlannedStep {
  const title = `systemd drop-in for ${ORBIT_UNIT}: cgroup delegation, workspace paths, and the host permitting workspace tools`;
  const ownedDir = !f.dropInDir || (f.dropInDir.kind === "dir" && f.dropInDir.uid === 0);
  if (!ownedDir) return step("service_dropin", title, "blocked", [], `${DROPIN_DIR} is not a root-owned directory; an operator must decide.`);
  const write: Op = { k: "write", path: DROPIN_PATH, content: DROPIN_TEXT, mode: 0o644, group: "root", noClobber: !f.dropIn };
  const dirOps: Op[] = !f.dropInDir || f.dropInDir.mode !== 0o755 ? [{ k: "ensure_dir", path: DROPIN_DIR, mode: 0o755 }] : [];
  const meaning = "ORBIT_WORKSPACE_TOOLS=enabled means the HOST permits workspace tools; ORBIT keeps them off until the owner separately enables them in ORBIT.";
  if (!f.dropIn) return step("service_dropin", title, "todo", [...dirOps, write], meaning);
  if (f.dropIn.kind === "file" && f.dropInText === DROPIN_TEXT) return step("service_dropin", title, "done", [], "Present with the expected content.");
  if (f.dropIn.kind === "file" && f.dropInText === DROPIN_REVOKED_TEXT) return step("service_dropin", title, "todo", [...dirOps, write], `Currently revoked (no Environment= line); it is written back. ${meaning}`);
  return step("service_dropin", title, "blocked", [], `${DROPIN_PATH} exists with content this helper did not write; it is never replaced. An operator must reconcile it.`);
}

// Whether ORBIT is running with what the drop-in and the static user say: loaded, no reload pending, started after the drop-in was
// last written, and its main process owned by the static orbit uid. Each reason is something the apply step would fix.
export function orbitOutOfDate(f: Facts, requireUser: boolean): string[] {
  const why: string[] = [];
  const o = f.orbit;
  if (!o.readable) return [`the state of ${ORBIT_UNIT} could not be read`];
  if (o.needReload === "yes") why.push("systemd has unit changes that are not loaded yet");
  if (o.activeState !== "active") why.push(`${ORBIT_UNIT} is ${o.activeState || "not active"}`);
  if (f.dropIn) {
    if (!o.dropInPaths.includes(DROPIN_PATH)) why.push("the drop-in is not loaded");
    if (o.activeEnterSec === undefined || o.activeEnterSec < Math.floor(f.dropIn.mtimeMs / 1000)) why.push("ORBIT was started before the drop-in was last written");
  }
  if (requireUser && f.user && isStaticSystemUser(f.user) && o.activeState === "active" && f.orbitProcUid !== f.user.uid) why.push(`ORBIT's process does not run as the static orbit uid ${f.user.uid}`);
  return why;
}

function applyStep(f: Facts, before: PlannedStep[]): PlannedStep {
  const title = `Apply: reload systemd and restart ${ORBIT_UNIT} (ORBIT is offline for a few seconds)`;
  const changed = before.filter((s) => s.id !== "package_bubblewrap" && s.state === "todo").map((s) => s.id);
  const why = [...(changed.length ? [`${changed.join(", ")} change what ORBIT runs with`] : []), ...orbitOutOfDate(f, true)];
  if (!why.length) return step("apply", title, "done", [], `${ORBIT_UNIT} runs as the static orbit user with the drop-in loaded.`);
  return step("apply", title, "todo", [{ k: "restart_and_health" }], `Needed because ${why.join("; ")}. ORBIT is offline for a few seconds while it restarts.`);
}

export function blockersOf(f: Facts): Blocker[] {
  const out: Blocker[] = [];
  if (!f.cgroup2) out.push({ id: "cgroup_v2", detail: "/sys/fs/cgroup is not the cgroup v2 unified hierarchy. Changing that is a host-wide change with a reboot; this helper never does it." });
  const missing = NEED_CONTROLLERS.filter((c) => !f.controllers.includes(c));
  if (f.cgroup2 && missing.length) out.push({ id: "cgroup_controllers", detail: `/sys/fs/cgroup/cgroup.controllers lacks ${missing.join(", ")}. Enabling them is a host-wide change with a reboot; this helper never does it.` });
  if (f.systemdVersion === undefined || f.systemdVersion < MIN_SYSTEMD) out.push({ id: "systemd_version", detail: `systemd ${f.systemdVersion ?? "(unknown version)"} is older than ${MIN_SYSTEMD}, which ORBIT's sandbox needs for DelegateSubgroup=.` });
  if (f.apparmorRestrictUserns === "1") out.push({ id: "apparmor_userns", detail: "kernel.apparmor_restrict_unprivileged_userns is 1: bubblewrap cannot create its user namespace without an AppArmor profile that allows it. That is a host-wide security policy decision for an operator (docs/orbit-ops-ws.md); this helper never changes it." });
  if (f.maxUserNamespaces === "0") out.push({ id: "user_namespaces", detail: "user.max_user_namespaces is 0: user namespaces are disabled host-wide; this helper never changes it." });
  if (f.unprivilegedUsernsClone === "0") out.push({ id: "unprivileged_userns_clone", detail: "kernel.unprivileged_userns_clone is 0: unprivileged user namespaces are disabled host-wide; this helper never changes it." });
  return out;
}

export function planFromFacts(f: Facts): FullPlan {
  const steps: PlannedStep[] = [packageStep(f), identityStep(f), ...f.storage.map((s) => storageStep(f, s)), workspacesFileStep(f), dropInStep(f)];
  steps.push(applyStep(f, steps));
  const pub = steps.map(({ ops: _ops, ...s }) => s);
  return { steps: pub, planned: steps, blockers: blockersOf(f), planKey: planKeyOf(pub), facts: f };
}

export async function computePlan(env: WsEnv, c?: WsConfig): Promise<FullPlan> {
  return planFromFacts(await gatherFacts(env, c));
}

// What ws_status shows about the host: a bounded summary, never file contents beyond what the plan already states.
export function publicFacts(f: Facts) {
  return {
    bwrap: f.bwrap ? { present: true, rootOwned: f.bwrap.uid === 0, setuid: Boolean(f.bwrap.mode & 0o6000) } : { present: false },
    prlimit: Boolean(f.prlimit),
    orbitUser: f.user ? { uid: f.user.uid, static: isStaticSystemUser(f.user) } : null,
    orbitGroup: f.group ? { gid: f.group.gid } : null,
    orbitService: { activeState: f.orbit.activeState, controlGroup: f.orbit.controlGroup, runsAsStaticUser: Boolean(f.user && f.orbitProcUid === f.user.uid), dropInLoaded: f.orbit.dropInPaths.includes(DROPIN_PATH) },
    workspaces: f.storage.map((s) => ({ id: s.id, root: mountPoint(s.id), image: imagePath(s.id), sizeBytes: s.sizeBytes, imagePresent: Boolean(s.image), mounted: Boolean(s.mount) })),
    workspacesFile: f.wsFile ? (f.wsFileText === workspacesFileText(f.orbit.controlGroup) ? "managed" : "operator-managed") : "absent",
    dropIn: !f.dropIn ? "absent" : f.dropInText === DROPIN_TEXT ? "enabled" : f.dropInText === DROPIN_REVOKED_TEXT ? "revoked" : "operator-managed",
    systemdVersion: f.systemdVersion ?? null,
    cgroupV2: f.cgroup2,
    cgroupControllers: f.controllers.slice(0, 16),
    apparmorRestrictUnprivilegedUserns: f.apparmorRestrictUserns ?? null,
    maxUserNamespaces: f.maxUserNamespaces ?? null,
    unprivilegedUsernsClone: f.unprivilegedUsernsClone ?? null,
  };
}

// ---------------------------------------------------------------- ORBIT's address and deployed commit (read, never written)

const SHA = /^[0-9a-f]{40}$/;
export function currentCommit(env: WsEnv, c: WsConfig): string | undefined {
  const v = env.fs.readText(`${c.orbitRoot}/current/COMMIT`, 1024)?.trim();
  return v && SHA.test(v) ? v : undefined;
}
// HOST and PORT, to reach /status. Nothing else is read out of orbit.env, and nothing of it is logged or returned.
export function statusAddress(env: WsEnv, c: WsConfig): { host: string; port: number } | undefined {
  const text = env.fs.readText(`${c.orbitRoot}/orbit.env`, 64 * 1024) ?? "";
  const get = (k: string) => new RegExp(`^${k}=([^\\s"'$\`\\\\;]+)\\s*$`, "m").exec(text)?.[1];
  const h = get("HOST");
  const p = get("PORT");
  if (!h || !p || !/^[0-9]{1,5}$/.test(p) || !/^[A-Za-z0-9.:-]{1,253}$/.test(h)) return undefined;
  return { host: h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h, port: Number(p) };
}

// ---------------------------------------------------------------- operation records

export const opsDir = (c: WsConfig) => `${c.stateDir}/ops`;
export const recordPath = (c: WsConfig, opId: string) => `${opsDir(c)}/${opId}.json`;
export const slotsDir = (c: WsConfig) => `${c.stateDir}/slots`;
export const registerPath = (c: WsConfig) => `${c.stateDir}/used-opids`;
export const imagesDir = (c: WsConfig) => `${c.stateDir}/images`;

export function ensureDirs(c: WsConfig): void {
  for (const d of [opsDir(c), slotsDir(c), imagesDir(c)]) mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(c.stateDir, 0o700);
  for (const d of [opsDir(c), slotsDir(c), imagesDir(c)]) chmodSync(d, 0o700);
}

// ---- partial-image markers: written right after this helper creates an image, removed once mkfs.ext4 succeeded on it.
export type ImageMarker = { path: string; dev: number; ino: number; opId: string; at: string };
export const imageMarkerPath = (c: WsConfig, id: string) => `${imagesDir(c)}/${id}.json`;
export function readImageMarker(c: WsConfig, id: string): ImageMarker | undefined {
  try {
    const v = JSON.parse(readFileSync(imageMarkerPath(c, id), "utf8")) as ImageMarker;
    return v && typeof v.path === "string" && Number.isInteger(v.dev) && Number.isInteger(v.ino) && typeof v.opId === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}
export function writeImageMarker(c: WsConfig, id: string, m: ImageMarker): void {
  mkdirSync(imagesDir(c), { recursive: true, mode: 0o700 });
  writeAtomic(imageMarkerPath(c, id), JSON.stringify(m));
}
export function clearImageMarker(c: WsConfig, id: string): void {
  rmSync(imageMarkerPath(c, id), { force: true });
}
export const workspaceOfImage = (path: string) => WORKSPACES.find((w) => imagePath(w.id) === path)?.id;

export function writeAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function loadRecord(c: WsConfig, opId: string): WsRecord | undefined {
  if (!OP_ID.test(opId)) return undefined;
  try {
    const v = JSON.parse(readFileSync(recordPath(c, opId), "utf8")) as WsRecord;
    return v && typeof v === "object" && v.opId === opId ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveRecord(c: WsConfig, rec: WsRecord, env: Pick<WsEnv, "now">): void {
  rec.updatedAt = env.now().toISOString();
  writeAtomic(recordPath(c, rec.opId), JSON.stringify(rec, null, 2));
}

// Creates the record for a NEW operation id, exclusively: link() fails if a record with that id exists, so two requests with the same
// id can never both create it (finding 2 of the PR #147 review). False when it already exists.
export function createRecord(c: WsConfig, rec: WsRecord, env: Pick<WsEnv, "now">): boolean {
  rec.updatedAt = env.now().toISOString();
  const tmp = `${recordPath(c, rec.opId)}.${process.pid}.new`;
  writeAtomic(tmp, JSON.stringify(rec, null, 2));
  try {
    linkSync(tmp, recordPath(c, rec.opId));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ---- replay register (finding 3 of the PR #147 review): every operation id whose record was pruned, one per line, append-only and
// never pruned. A pruned id is still "already used": a later request with it is answered as a replay and never runs. The register is
// bounded: when it is full, records are simply no longer pruned (storage grows; replay protection never lapses).
export const REGISTER_MAX_BYTES = 4 * 1024 * 1024; // about 100,000 ids
export function registerHas(c: WsConfig, opId: string): boolean {
  if (!OP_ID.test(opId)) return false;
  let text = "";
  try {
    text = readFileSync(registerPath(c), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err; // unreadable: fail closed (the request is refused with an internal error)
  }
  return text.split("\n").includes(opId);
}
function registerAdd(c: WsConfig, opId: string): boolean {
  let size = 0;
  try {
    size = statSync(registerPath(c)).size;
  } catch {
    size = 0;
  }
  if (size + opId.length + 1 > REGISTER_MAX_BYTES) return false;
  const fd = openSync(registerPath(c), FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND | FS.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${opId}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

// Append a capped, redacted step. The journal gets the same line, so every step of every operation is audited.
export function addStep(c: WsConfig, rec: WsRecord, env: Pick<WsEnv, "now">, name: string, detail: string, audit: (line: object) => void): void {
  const s = { at: env.now().toISOString(), step: cap(name, 40), detail: cap(detail, DETAIL_CHARS) };
  if (rec.steps.length < STEP_LIMIT) rec.steps.push(s);
  else rec.steps[STEP_LIMIT - 1] = { ...s, detail: `${s.detail} (earlier steps dropped)`.slice(0, DETAIL_CHARS + 30) };
  saveRecord(c, rec, env);
  audit({ at: s.at, opId: rec.opId.slice(0, 12), action: rec.action, step: s.step, detail: s.detail });
}

// Remove old finished records; never an unfinished one. Each id goes into the replay register (durably) BEFORE its record is removed,
// so at every moment an id is either recorded or registered.
export function pruneRecords(c: WsConfig): void {
  try {
    const names = readdirSync(opsDir(c)).filter((n) => /^[0-9a-f]{40}\.json$/.test(n));
    if (names.length <= c.keepRecords) return;
    const recs = names
      .map((n) => loadRecord(c, n.slice(0, 40)))
      .filter((r): r is WsRecord => Boolean(r) && isWsTerminal(r!.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const r of recs.slice(0, Math.max(0, names.length - c.keepRecords))) {
      if (!registerAdd(c, r.opId)) return; // full: keep the records
      rmSync(recordPath(c, r.opId), { force: true });
    }
  } catch {
    // pruning is best effort; a record that is not pruned keeps its id used
  }
}

// ---- the one-at-a-time slot (finding 2 of the PR #147 review). Generations: slots/<12-digit n> holds the opId that took generation
// n, created exclusively with link(). The newest generation is the current holder. Taking the slot means creating generation n+1, which
// exactly one contender can do; a finished holder needs no release, and a dead one is never "broken" by deleting a file (the race the
// old single-file slot had). Old generations are tidied, never the newest ones.
const SLOT_NAME = /^[0-9]{12}$/;
export function currentSlot(c: WsConfig): { gen: number; opId?: string; takenAtMs?: number } {
  let names: string[] = [];
  try {
    names = readdirSync(slotsDir(c)).filter((n) => SLOT_NAME.test(n)).sort();
  } catch {
    return { gen: 0 };
  }
  const last = names.at(-1);
  if (!last) return { gen: 0 };
  try {
    const [opId = "", at = ""] = readFileSync(`${slotsDir(c)}/${last}`, "utf8").split("\n");
    const takenAtMs = Date.parse(at);
    return { gen: Number(last), opId: opId.trim(), ...(Number.isFinite(takenAtMs) ? { takenAtMs } : {}) };
  } catch {
    return { gen: Number(last), opId: "" };
  }
}
export function readSlot(c: WsConfig): string | undefined {
  return currentSlot(c).opId || undefined;
}
export function claimSlot(c: WsConfig, gen: number, opId: string, at: string): boolean {
  mkdirSync(slotsDir(c), { recursive: true, mode: 0o700 });
  const name = `${slotsDir(c)}/${String(gen).padStart(12, "0")}`;
  const tmp = `${slotsDir(c)}/.${opId}.${process.pid}.tmp`;
  writeAtomic(tmp, `${opId}\n${at}\n`);
  try {
    linkSync(tmp, name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    for (const n of readdirSync(slotsDir(c)).filter((x) => SLOT_NAME.test(x) && Number(x) < gen - 8)) rmSync(`${slotsDir(c)}/${n}`, { force: true });
  } catch {
    // tidying is best effort
  }
  return true;
}

// What leaves the helper about an operation: bounded and redacted.
export function publicRecord(rec: WsRecord): unknown {
  const { pkgRequested: _p, ...rest } = rec;
  return redactDeep({ ...rest, steps: rest.steps.slice(-16), ...(rest.summary ? { summary: cap(rest.summary, SUMMARY_CHARS) } : {}) });
}
