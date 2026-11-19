// orbit-ops `host_inventory` (docs/host-inventory.md): a bounded, read-only inventory of how ORBIT is deployed on its host.
//
// This module runs as root inside the existing orbit-ops@.service sandbox, and ONLY when the host has been activated: helper.ts loads it
// after checking a root-owned marker, and install.sh does not copy it (activation is a separate, owner-run step). The action takes no
// arguments, so nothing here is chosen by the caller. What it does is fixed:
//  - ONE `systemctl show` call for the fixed unit list below, with a fixed property list (and one more, for orbit.service's main PID
//    only, to detect PID reuse around the mountinfo read);
//  - lstat on fixed paths, one path component at a time from "/". Symlinks are never followed: an ancestor that is a symlink makes the
//    path `denied` (fail closed), a final symlink is reported as a symlink, and its target only when it has an approved shape;
//  - bounded reads of /etc/group (only the fixed group names are used; member names are never returned) and of the mountinfo of PID 1
//    and of orbit.service's main process (only the entries that contain a fixed path are used; never device or source names).
// It never writes, never reads file contents other than those three, never lists a directory, and returns only allowlisted fields
// whose values pass a shape check. Missing or unreadable facts are reported as unavailable with a reason, never as a pass.
//
// Standalone apart from the type-only import (erased at runtime), so it can be installed next to helper.ts on its own.
import type { Env } from "./helper.ts";

export const INVENTORY_SCHEMA = "orbit-host-inventory/1";
// Kept well under the helper's MAX_RESPONSE_BYTES (32 KiB) so redaction and the envelope always fit.
export const INVENTORY_MAX_BYTES = 24 * 1024;
// No subprocess is started after this much time has passed (each has its own 5 s timeout in helper.ts), so the whole answer stays
// inside ORBIT's 8 s client timeout. Anything skipped is reported as unavailable, never guessed.
export const INVENTORY_EXEC_START_BUDGET_MS = 1500;
export const MOUNTINFO_MAX_BYTES = 256 * 1024;
export const GROUP_FILE_MAX_BYTES = 64 * 1024;

const SYSTEMCTL = "/usr/bin/systemctl";

// ---- the fixed, repository-declared scope. Nothing outside these lists is ever inspected. ----

export const SPEC = {
  // Every service unit in deploy/systemd/ (test/host-inventory.test.ts checks the list against the directory).
  services: [
    "orbit.service",
    "orbit-deploy.service",
    "orbit-tailscale-jobs.service",
    "orbit-ops@.service",
    "orbit-ops-admin@.service",
    "orbit-ops-admin-run@.service",
    "orbit-ops-admin-vault@.service",
    "orbit-ops-sys@.service",
    "orbit-ops-sys-plan@.service",
    "orbit-ops-sys-update@.service",
    "orbit-ops-sys-reboot@.service",
    "orbit-ops-sys-funnel@.service",
    "orbit-ops-sys-recover.service",
    "orbit-ops-ws@.service",
    "orbit-ops-ws-run@.service",
    "orbit-ops-ws-pkg@.service",
  ],
  sockets: [
    { unit: "orbit-ops.socket", path: "/run/orbit-ops.sock" },
    { unit: "orbit-ops-admin.socket", path: "/run/orbit-ops-admin.sock" },
    { unit: "orbit-ops-sys.socket", path: "/run/orbit-ops-sys.sock" },
    { unit: "orbit-ops-ws.socket", path: "/run/orbit-ops-ws.sock" },
  ],
  groups: ["orbit-ops", "orbit-vault"],
  orbitUnit: "orbit.service",
  paths: [
    "/opt/orbit",
    "/opt/orbit/current",
    "/opt/orbit/releases",
    "/opt/orbit/repo",
    "/opt/orbit/vault",
    "/opt/orbit/state",
    "/usr/local/lib/orbit",
    "/usr/local/lib/orbit/ops",
    "/var/lib/orbit",
    "/var/lib/private/orbit",
  ],
  // The root-run code. Metadata only (type, owner, group, mode); never opened.
  helperFiles: [
    "/usr/local/lib/orbit/pull-deploy.sh",
    "/usr/local/lib/orbit/ops/helper.ts",
    "/usr/local/lib/orbit/ops/protocol.ts",
    "/usr/local/lib/orbit/ops/inventory.ts",
    "/usr/local/lib/orbit/ops/admin-protocol.ts",
    "/usr/local/lib/orbit/ops/admin-core.ts",
    "/usr/local/lib/orbit/ops/admin-helper.ts",
    "/usr/local/lib/orbit/ops/admin-run.ts",
    "/usr/local/lib/orbit/ops/sys-protocol.ts",
    "/usr/local/lib/orbit/ops/sys-core.ts",
    "/usr/local/lib/orbit/ops/sys-helper.ts",
    "/usr/local/lib/orbit/ops/sys-run.ts",
    "/usr/local/lib/orbit/ops/ws-protocol.ts",
    "/usr/local/lib/orbit/ops/ws-core.ts",
    "/usr/local/lib/orbit/ops/ws-helper.ts",
    "/usr/local/lib/orbit/ops/ws-run.ts",
  ],
  // Where the ORBIT service must not be able to write (deployment separation).
  separation: ["/opt/orbit", "/opt/orbit/releases", "/opt/orbit/repo", "/usr/local/lib/orbit", "/usr/local/lib/orbit/ops"],
  // Approved symlink target shapes. Any other target is not reported.
  linkTargets: {
    "/opt/orbit/current": /^(?:\/opt\/orbit\/)?releases\/[0-9a-f]{40}\/?$/,
    "/var/lib/orbit": /^(?:\/var\/lib\/)?private\/orbit\/?$/,
  } as Record<string, RegExp>,
};
export type Spec = typeof SPEC;

export const IDENTITY_PROPS = ["LoadState", "ActiveState", "SubState", "User", "Group", "DynamicUser", "SupplementaryGroups", "UID", "GID"] as const;
export const SANDBOX_PROPS = [
  "ProtectSystem",
  "ProtectHome",
  "PrivateTmp",
  "PrivateDevices",
  "PrivateNetwork",
  "NoNewPrivileges",
  "RestrictSUIDSGID",
  "CapabilityBoundingSet",
  "AmbientCapabilities",
  "RestrictAddressFamilies",
  "ReadWritePaths",
  "ReadOnlyPaths",
  "StateDirectory",
] as const;
export const SOCKET_PROPS = ["SocketUser", "SocketGroup", "SocketMode", "Accept", "MaxConnections"] as const;
// MainPID is read for orbit.service only, used internally to find its mount namespace, and never returned.
export const ALL_PROPS = ["Id", ...IDENTITY_PROPS, ...SANDBOX_PROPS, ...SOCKET_PROPS, "MainPID"];

// ---- result shapes ----

export type Origin = "systemd-loaded" | "host-observed" | "derived";
export type Section = { origin: Origin; source: string; observedAt: string; complete: boolean; unavailable: string[]; warnings: string[]; items: unknown[] };

// ---- value shapes: anything else becomes "[unrecognised]" (and the section says so), so free text never passes through ----

const UNRECOGNISED = "[unrecognised]";
const NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const WORD = /^[A-Za-z0-9_+:.-]{0,40}$/;
const tokens = (v: string, re: RegExp, max: number): string[] | undefined => {
  const t = v.split(/\s+/).filter(Boolean);
  return t.length <= max && t.every((x) => re.test(x) && !x.includes("..")) ? t : undefined;
};
const num = (v: string): number | null => (/^\d{1,10}$/.test(v) && Number(v) < 4294967295 ? Number(v) : null);

function shape(prop: string, v: string): unknown {
  switch (prop) {
    case "User":
    case "Group":
    case "SocketUser":
    case "SocketGroup":
      return v === "" || NAME.test(v) ? v : UNRECOGNISED;
    case "SupplementaryGroups":
      return tokens(v, NAME, 16) ?? UNRECOGNISED;
    case "UID":
    case "GID":
    case "MaxConnections":
      return num(v);
    case "SocketMode":
      return /^0?[0-7]{3,4}$/.test(v) ? v : UNRECOGNISED;
    case "CapabilityBoundingSet":
    case "AmbientCapabilities": {
      const t = tokens(v, /^cap_[a-z_]{1,30}$/, 64);
      if (!t) return UNRECOGNISED;
      return t.length >= 30 ? `(broad: ${t.length} capabilities)` : t;
    }
    case "RestrictAddressFamilies":
      return tokens(v, /^~?AF_[A-Z0-9]{1,16}$/, 16) ?? UNRECOGNISED;
    case "ReadWritePaths":
    case "ReadOnlyPaths":
      return tokens(v, /^[-+]?\/[A-Za-z0-9._/@-]{0,120}$/, 16) ?? UNRECOGNISED;
    case "StateDirectory":
      return tokens(v, /^[A-Za-z0-9._-]{1,64}$/, 8) ?? UNRECOGNISED;
    default:
      return WORD.test(v) ? v : UNRECOGNISED;
  }
}

// `systemctl show u1 u2 --property=...` prints one block per unit, blank-line separated. Blocks are matched by their Id, and only the
// requested properties are kept.
export function parseShow(stdout: string, units: string[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const block of stdout.split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i < 1) continue;
      const key = line.slice(0, i);
      if (ALL_PROPS.includes(key) && !Object.hasOwn(props, key)) props[key] = line.slice(i + 1);
    }
    if (props.Id && units.includes(props.Id) && !out.has(props.Id)) out.set(props.Id, props);
  }
  return out;
}

// ---- filesystem metadata, lstat only, component by component ----

type Stat = NonNullable<ReturnType<Env["lstat"]>> & { gid?: number };
const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000;
const typeOf = (s: Stat) => (s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : (s.mode & S_IFMT) === S_IFSOCK ? "socket" : "other");
const modeOf = (s: Stat) => (s.mode & 0o7777).toString(8).padStart(4, "0");

export type PathFact = {
  path: string;
  state: "present" | "missing" | "denied" | "unreadable";
  reason?: string;
  type?: string;
  uid?: number;
  gid?: number | null;
  mode?: string;
  linkTarget?: string;
};

function inspectPath(env: Env, path: string, spec: Spec): PathFact {
  if (!path.startsWith("/") || path.includes("//") || path.split("/").some((c) => c === "." || c === "..")) return { path, state: "denied", reason: "not a canonical absolute path" };
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const ancestor = `/${parts.slice(0, i).join("/")}`;
    const a = env.lstat(ancestor) as Stat | undefined;
    if (!a) return { path, state: "missing", reason: `ancestor ${ancestor} is missing or not readable` };
    if (a.isSymbolicLink()) return { path, state: "denied", reason: `ancestor ${ancestor} is a symlink; not followed (fail closed)` };
    if (!a.isDirectory()) return { path, state: "denied", reason: `ancestor ${ancestor} is not a directory` };
  }
  const s = env.lstat(path) as Stat | undefined;
  if (!s) return { path, state: "missing", reason: "not present or not readable" };
  const fact: PathFact = { path, state: "present", type: typeOf(s), uid: s.uid, gid: typeof s.gid === "number" ? s.gid : null, mode: modeOf(s) };
  if (s.isSymbolicLink()) {
    const target = env.readlink(path);
    const approved = spec.linkTargets[path];
    fact.linkTarget = target !== undefined && approved?.test(target) ? target : "(not reported: not followed, and outside the approved target shape)";
  }
  return fact;
}

// ---- /etc/group: fixed names only; member names never leave this function ----

function readGroups(env: Env, spec: Spec): { section: Section; gids: Map<string, number> } {
  const at = env.now().toISOString();
  const gids = new Map<string, number>();
  const text = env.readSmall("/etc/group", GROUP_FILE_MAX_BYTES);
  const section: Section = { origin: "host-observed", source: "/etc/group (fixed group names only; member names are not returned)", observedAt: at, complete: true, unavailable: [], warnings: [], items: [] };
  if (text === undefined) {
    section.complete = false;
    section.unavailable.push("/etc/group could not be read");
    return { section, gids };
  }
  if (Buffer.byteLength(text) >= GROUP_FILE_MAX_BYTES) {
    section.complete = false;
    section.warnings.push(`only the first ${GROUP_FILE_MAX_BYTES} bytes were read; a group defined later is reported missing`);
  }
  for (const line of text.split("\n")) {
    const [name, , gid] = line.split(":");
    if (!name || !spec.groups.includes(name) || gids.has(name)) continue;
    const n = num(gid ?? "");
    if (n === null) continue;
    gids.set(name, n);
  }
  for (const name of spec.groups) {
    const line = text.split("\n").find((l) => l.split(":")[0] === name);
    const members = line?.split(":")[3] ?? "";
    section.items.push(gids.has(name) ? { group: name, gid: gids.get(name), explicitMembers: members.split(",").filter(Boolean).length } : { group: name, state: "missing" });
  }
  return { section, gids };
}

// ---- mountinfo: matched to the fixed paths only ----

type Mount = { mountPoint: string; readOnly: boolean; nosuid: boolean; nodev: boolean; noexec: boolean; fstype: string };
const FSTYPES = new Set(["ext4", "ext3", "xfs", "btrfs", "zfs", "tmpfs", "overlay", "squashfs", "vfat", "ramfs", "nfs", "nfs4", "fuse"]);
const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

export function parseMountinfo(text: string): Mount[] {
  const out: Mount[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    const sep = f.indexOf("-");
    if (sep < 6 || f.length < sep + 4) continue;
    const opts = (f[5] ?? "").split(",");
    const superOpts = (f[sep + 3] ?? "").split(",");
    const fstype = f[sep + 1] ?? "";
    out.push({
      mountPoint: unescape(f[4] ?? ""),
      readOnly: opts.includes("ro") || superOpts.includes("ro"),
      nosuid: opts.includes("nosuid"),
      nodev: opts.includes("nodev"),
      noexec: opts.includes("noexec"),
      fstype: FSTYPES.has(fstype) ? fstype : "other",
    });
  }
  return out;
}

// The mount that holds `path`: the longest mount point that is the path or a component-wise ancestor of it; the last one listed wins
// when mounts are stacked. Only that entry's mount point (an ancestor of an approved path) and flags are reported.
export function mountFor(mounts: Mount[], path: string): Mount | undefined {
  let best: Mount | undefined;
  for (const m of mounts) {
    const mp = m.mountPoint;
    const holds = mp === "/" || path === mp || path.startsWith(`${mp}/`);
    if (holds && (!best || mp.length >= best.mountPoint.length)) best = m;
  }
  return best;
}

// ---- the inventory ----

export type InventoryOptions = { spec?: Spec; maxBytes?: number; clock?: () => number };

export async function inventory(env: Env, opts: InventoryOptions = {}): Promise<unknown> {
  const spec = opts.spec ?? SPEC;
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const at = () => env.now().toISOString();
  const canStartExec = () => clock() - started < INVENTORY_EXEC_START_BUDGET_MS;
  const units = [...spec.services, ...spec.sockets.map((s) => s.unit)];

  // 1. One systemctl call: identity, sandbox and socket properties as systemd has loaded them.
  // A non-zero exit with some blocks printed (for example one unit name this systemd rejects) still reports the units it printed; the
  // sections then say systemctl reported an error and are incomplete. stderr is never passed on.
  let shown: Map<string, Record<string, string>> | undefined;
  let showProblem: string | undefined;
  let showWarning: string | undefined;
  const showAt = at();
  const r = await env.exec(SYSTEMCTL, ["show", ...units, "--no-pager", `--property=${ALL_PROPS.join(",")}`]);
  if (r.timedOut) showProblem = "systemctl timed out";
  else {
    const parsed = parseShow(r.stdout.slice(0, 512 * 1024), units);
    if (r.code === 0) shown = parsed;
    else if (parsed.size > 0) {
      shown = parsed;
      showWarning = "systemctl exited with an error; units missing from its answer are reported unavailable";
    } else showProblem = "systemctl could not report these units";
  }

  const unitSection = (source: string, origin: Origin): Section => ({ origin, source, observedAt: showAt, complete: !showProblem && !showWarning, unavailable: showProblem ? [showProblem] : [], warnings: showWarning ? [showWarning] : [], items: [] });
  const identities = unitSection("systemctl show (fixed unit list, fixed properties). UID/GID are the running unit's credentials as systemd reports them; null when the unit is not running.", "systemd-loaded");
  const sandbox = unitSection("systemctl show (fixed unit list, fixed properties): the configuration systemd has loaded, drop-ins included", "systemd-loaded");
  sandbox.warnings.push("Configured, not verified: these are the settings systemd will apply, not evidence that the kernel enforces them for a running process. The mounts section has the observed effect where it could be read.");
  const helperBoundaries: Section = { origin: "host-observed", source: "lstat of the fixed helper sockets and root-run code files, and their socket units' loaded settings", observedAt: showAt, complete: true, unavailable: [], warnings: [], items: [] };

  const pick = (props: Record<string, string>, keys: readonly string[]) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) if (Object.hasOwn(props, k)) o[k] = shape(k, props[k]!);
    return o;
  };
  const noteUnrecognised = (s: Section, unit: string, o: Record<string, unknown>) => {
    const bad = Object.entries(o).filter(([, v]) => v === UNRECOGNISED).map(([k]) => k);
    if (bad.length) s.warnings.push(`${unit}: ${bad.join(", ")} had a value outside the accepted shape and is not reported`);
  };
  let orbitPid: number | null = null;
  for (const unit of spec.services) {
    const p = shown?.get(unit);
    if (!p) {
      if (shown) {
        identities.items.push({ unit, state: "unavailable", reason: "not in systemctl's answer" });
        sandbox.items.push({ unit, state: "unavailable", reason: "not in systemctl's answer" });
        identities.complete = sandbox.complete = false;
      }
      continue;
    }
    const id = pick(p, IDENTITY_PROPS);
    const sb = pick(p, ["LoadState", ...SANDBOX_PROPS]);
    noteUnrecognised(identities, unit, id);
    noteUnrecognised(sandbox, unit, sb);
    if (id.LoadState !== "loaded") identities.warnings.push(`${unit}: LoadState is ${String(id.LoadState)}; its settings are not those of the repository unit`);
    identities.items.push({ unit, ...id });
    sandbox.items.push({ unit, ...sb });
    if (unit === spec.orbitUnit) orbitPid = num(p.MainPID ?? "");
  }
  for (const s of spec.sockets) {
    const p = shown?.get(s.unit);
    const file = inspectPath(env, s.path, spec);
    const loaded = p ? pick(p, ["LoadState", "ActiveState", ...SOCKET_PROPS]) : undefined;
    if (loaded) noteUnrecognised(helperBoundaries, s.unit, loaded);
    helperBoundaries.items.push({ kind: "socket", unit: s.unit, unitSettings: loaded ?? { state: "unavailable", reason: showProblem ?? "not in systemctl's answer" }, file });
    if (!loaded || file.state !== "present") helperBoundaries.complete = false;
  }
  for (const f of spec.helperFiles) helperBoundaries.items.push({ kind: "root-run code", file: inspectPath(env, f, spec) });

  // 2. Groups, paths.
  const groups = readGroups(env, spec);
  const pathsAt = at();
  const pathFacts = spec.paths.map((p) => inspectPath(env, p, spec));
  const paths: Section = {
    origin: "host-observed",
    source: "lstat, one component at a time; symlinks never followed; no listing, no contents",
    observedAt: pathsAt,
    complete: pathFacts.every((f) => f.state === "present" || f.state === "missing"),
    unavailable: pathFacts.filter((f) => f.state === "denied" || f.state === "unreadable").map((f) => `${f.path}: ${f.reason}`),
    warnings: ["Owner, group and mode only: ACLs, file capabilities and LSM labels are not read."],
    items: pathFacts,
  };

  // 3. Mounts, in the host's namespace and in the ORBIT service's.
  const mountsAt = at();
  const mounts: Section = { origin: "host-observed", source: "/proc/1/mountinfo and the ORBIT service's /proc/<MainPID>/mountinfo, matched to the fixed paths only", observedAt: mountsAt, complete: true, unavailable: [], warnings: [], items: [] };
  const readMounts = (file: string, label: string): Mount[] | undefined => {
    const text = env.readSmall(file, MOUNTINFO_MAX_BYTES);
    if (text === undefined) {
      mounts.complete = false;
      mounts.unavailable.push(`${label}: mount table could not be read`);
      return undefined;
    }
    if (Buffer.byteLength(text) >= MOUNTINFO_MAX_BYTES) {
      mounts.complete = false;
      mounts.warnings.push(`${label}: mount table larger than ${MOUNTINFO_MAX_BYTES} bytes; later entries were not read`);
    }
    return parseMountinfo(text);
  };
  const hostMounts = readMounts("/proc/1/mountinfo", "host (PID 1)");
  let orbitMounts: Mount[] | undefined;
  if (orbitPid === null || orbitPid < 2) {
    mounts.complete = false;
    mounts.unavailable.push(`${spec.orbitUnit}: not running (or its main PID is unknown), so its mount namespace could not be observed`);
  } else {
    orbitMounts = readMounts(`/proc/${orbitPid}/mountinfo`, spec.orbitUnit);
    // The PID could have been reused between systemctl and the read: confirm it is still the same main process, or drop the reading.
    if (orbitMounts) {
      if (!canStartExec()) {
        orbitMounts = undefined;
        mounts.complete = false;
        mounts.unavailable.push(`${spec.orbitUnit}: time budget used up before its main PID could be confirmed; its mount view is not reported`);
      } else {
        const again = await env.exec(SYSTEMCTL, ["show", spec.orbitUnit, "--no-pager", "--property=MainPID"]);
        const pid = again.code === 0 && !again.timedOut ? num(parseShowValue(again.stdout, "MainPID")) : null;
        if (pid !== orbitPid) {
          orbitMounts = undefined;
          mounts.complete = false;
          mounts.unavailable.push(`${spec.orbitUnit}: its main PID changed or could not be confirmed during the read; its mount view is not reported`);
        }
      }
    }
  }
  for (const path of spec.paths) {
    const view = (ms: Mount[] | undefined) => {
      if (!ms) return { state: "unavailable" };
      const m = mountFor(ms, path);
      return m ? { ...m } : { state: "no matching mount" };
    };
    mounts.items.push({ path, host: view(hostMounts), orbitService: view(orbitMounts) });
  }

  // 4. Deployment separation: derived from the observations above; every input is named, and a missing input is not a pass.
  const separation = deriveSeparation(spec, { identities, sandbox, groups: groups.gids, pathFacts, orbitMounts, at: at() });

  const sections: Record<string, Section> = {
    serviceIdentities: identities,
    groups: groups.section,
    sandbox,
    helperBoundaries,
    paths,
    mounts,
    deploymentSeparation: separation,
  };
  const result = {
    schema: INVENTORY_SCHEMA,
    observedAt: at(),
    scope: "Fixed lists in the installed inventory module only. No argument is accepted, and nothing outside these lists is inspected.",
    sections,
    notObserved: NOT_OBSERVED,
  };
  return fitToBound(result, opts.maxBytes ?? INVENTORY_MAX_BYTES);
}

function parseShowValue(stdout: string, key: string): string {
  const line = stdout.split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : "";
}

// Facts this action does not and cannot safely observe; they stay owner gates (docs/host-inventory.md).
export const NOT_OBSERVED = [
  "kernel enforcement of a unit's sandbox settings beyond the mount flags observed for the ORBIT service",
  "the sandbox, mounts and identity of units that are not running (templates run per connection)",
  "ACLs, file capabilities and LSM (AppArmor/SELinux) policy",
  "secrets, credentials and their metadata, environment values, process arguments, orbit.env, unit file text",
  "OpenClaw installation, workspace and session paths, and raiclaw checkouts (no approved list exists yet)",
  "Tailscale ACLs, and anything outside the fixed lists",
];

type SepInput = { identities: Section; sandbox: Section; groups: Map<string, number>; pathFacts: PathFact[]; orbitMounts: Mount[] | undefined; at: string };

function deriveSeparation(spec: Spec, i: SepInput): Section {
  const section: Section = {
    origin: "derived",
    source: "derived from the observed service identity, path owner/mode and the ORBIT service's mount view above; see each item's inputs",
    observedAt: i.at,
    complete: true,
    unavailable: [],
    warnings: ["A 'not-writable-by-mode' verdict does not consider ACLs, capabilities or other namespaces. Only 'read-only-mount-observed' is an observed effective restriction."],
    items: [],
  };
  const orbit = i.identities.items.find((x) => (x as { unit?: string }).unit === spec.orbitUnit) as Record<string, unknown> | undefined;
  const uid = typeof orbit?.UID === "number" ? orbit.UID : null;
  const gid = typeof orbit?.GID === "number" ? orbit.GID : null;
  const supp = Array.isArray(orbit?.SupplementaryGroups) ? (orbit.SupplementaryGroups as string[]) : undefined;
  const suppGids = supp?.map((n) => i.groups.get(n));
  const groupsKnown = gid !== null && suppGids !== undefined && suppGids.every((g) => g !== undefined);
  const orbitGids = groupsKnown ? new Set([gid!, ...(suppGids as number[])]) : undefined;
  if (uid === null) section.warnings.push(`${spec.orbitUnit}'s UID is not observed (not running?), so write access by mode cannot be derived`);
  if (uid !== null && !groupsKnown) section.warnings.push(`${spec.orbitUnit}'s groups could not all be resolved to GIDs, so write access by mode cannot be derived`);
  const declaredWriters = (path: string) =>
    i.sandbox.items
      .filter((x) => Array.isArray((x as { ReadWritePaths?: unknown }).ReadWritePaths))
      .filter((x) => ((x as { ReadWritePaths: string[] }).ReadWritePaths).some((p) => {
        const q = p.replace(/^[-+]/, "");
        return path === q || path.startsWith(`${q}/`);
      }))
      .map((x) => (x as { unit: string }).unit);
  for (const path of spec.separation) {
    const fact = i.pathFacts.find((f) => f.path === path) ?? { path, state: "missing" as const };
    const m = i.orbitMounts ? mountFor(i.orbitMounts, path) : undefined;
    const mountReadOnly = m ? m.readOnly : null;
    let byMode: boolean | null = null;
    if (fact.state === "present" && uid !== null && orbitGids && typeof fact.mode === "string" && typeof fact.uid === "number" && typeof fact.gid === "number") {
      const mode = parseInt(fact.mode, 8);
      byMode = fact.uid === uid ? (mode & 0o200) !== 0 : orbitGids.has(fact.gid) ? (mode & 0o020) !== 0 : (mode & 0o002) !== 0;
    }
    const verdict =
      mountReadOnly === true ? "read-only-mount-observed" : byMode === true ? "writable-by-mode" : byMode === false ? "not-writable-by-mode" : "not-established";
    if (verdict === "not-established") section.complete = false;
    section.items.push({
      path,
      orbitServiceWrite: verdict,
      inputs: {
        pathState: fact.state,
        orbitMountReadOnly: mountReadOnly,
        writableByMode: byMode,
        unitsDeclaringWriteAccess: declaredWriters(path),
      },
    });
  }
  return section;
}

// The whole answer stays under the bound. Sections are dropped from the least important end, each marked incomplete with the reason.
const DROP_ORDER = ["helperBoundaries", "mounts", "sandbox", "paths", "deploymentSeparation", "groups", "serviceIdentities"];
function fitToBound(result: { sections: Record<string, Section> } & Record<string, unknown>, maxBytes: number) {
  for (const name of DROP_ORDER) {
    if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) break;
    const s = result.sections[name];
    if (!s) continue;
    result.sections[name] = { ...s, complete: false, items: [], warnings: [], unavailable: [`dropped: the inventory exceeded its ${maxBytes}-byte output bound`] };
  }
  return result;
}
