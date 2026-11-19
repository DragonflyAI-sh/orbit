// orbit-ops-ws (src/ops/ws-*.ts, src/ops-ws-client.ts, deploy/*ws*). Everything runs against FAKES: a fake exec that records every
// command and simulates systemd, getent, useradd, apt-get, fallocate, mkfs.ext4, chown, chmod and rmdir on REAL temporary directories
// (the host's paths live under a test root prefix), an ownership overlay instead of chown, a fake /status and a fake clock. No test
// runs apt, systemctl, useradd, mkfs or mount on the host, and the installer is only run on its refusal paths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, writeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { redact } from "../src/ops/protocol.ts";
import {
  BIN,
  DROPIN_PATH,
  DROPIN_REVOKED_TEXT,
  DROPIN_TEXT,
  WORKSPACES_FILE,
  WS_CONFIG,
  computePlan,
  hostFs,
  imagePath,
  loadRecord,
  mountPoint,
  mountUnitName,
  mountUnitPath,
  mountUnitText,
  systemdEscapePath,
  workspacesFileText,
  type Exec,
  type ExecOpts,
  type WsConfig,
  type WsEnv,
} from "../src/ops/ws-core.ts";
import { handle, type WsAudit } from "../src/ops/ws-helper.ts";
import { WS_ACTIONS, WS_MAX_REQUEST_BYTES, WS_MAX_RESPONSE_BYTES, opIdFor, parseWsRequest, planKeyOf, type PlanStep, type WsRecord } from "../src/ops/ws-protocol.ts";
import { runOperation } from "../src/ops/ws-run.ts";
import { wsHostClient } from "../src/ops-ws-client.ts";

const SHA_A = "a".repeat(40);
const OP = "1".repeat(40);
const OP2 = "2".repeat(40);
const OP3 = "3".repeat(40);
const CG = "/system.slice/orbit.service";
const DYN_UID = 61234;
const part = (...p: string[]) => p.join("");

// ---------------------------------------------------------------- the fake host

type Host = {
  user?: { uid: number; gid: number; shell: string };
  group?: { gid: number };
  active: string;
  pid: number;
  procUid: number;
  activeEnterSec: number;
  controlGroup: string;
  loadedDropIn?: string; // drop-in text systemd loaded at the last daemon-reload
  loadedUnits: Set<string>;
  enabled: Set<string>;
  mounts: Map<string, { fstype: string; opts: string }>;
  everMounted: Set<string>;
  systemdVersion: number;
  cgroup2: boolean;
  controllers: string;
  apt: "ok" | "lock" | "fail";
  healthy: boolean;
  servedCommit: string;
  runnerActive: boolean;
  fail?: (file: string, args: string[]) => Exec | undefined;
  noopChmod?: boolean;
};
type Call = { file: string; args: string[]; opts?: ExecOpts };
type World = {
  base: string; prefix: string; cfg: WsConfig; host: Host; calls: Call[]; audit: object[]; fronts: WsAudit[]; owners: Map<string, { uid: number; gid: number }>;
  env: WsEnv; advance(ms: number): void; p(path: string): string; put(path: string, content: string, mode?: number, uid?: number, gid?: number): void; mkdir(path: string, mode?: number, uid?: number): void;
};

function writeSuperblock(file: string, label: string): void {
  const sb = Buffer.alloc(136);
  sb.writeUInt16LE(0xef53, 56);
  sb.write(label, 120, "latin1");
  const fd = openSync(file, "r+");
  writeSync(fd, sb, 0, sb.length, 1024);
  closeSync(fd);
}

const ok = (stdout = ""): Exec => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (code: number, stderr = ""): Exec => ({ code, stdout: "", stderr, timedOut: false });

function world(opts: { bwrap?: "absent" | "ok" | "setuid"; prlimit?: boolean; sysctl?: Record<string, string> } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ops-ws-")));
  const prefix = join(base, "root");
  const stateDir = join(base, "state");
  mkdirSync(stateDir);
  const owners = new Map<string, { uid: number; gid: number }>();
  let t = Date.parse("2026-11-19T12:00:00Z");
  const host: Host = {
    active: "active", pid: 4242, procUid: DYN_UID, activeEnterSec: Math.floor(Date.now() / 1000) - 3600, controlGroup: CG,
    loadedUnits: new Set(), enabled: new Set(), mounts: new Map(), everMounted: new Set(),
    systemdVersion: 255, cgroup2: true, controllers: "cpuset cpu io memory hugetlb pids rdma misc", apt: "ok", healthy: true, servedCommit: SHA_A, runnerActive: true,
  };
  const calls: Call[] = [];
  const audit: object[] = [];
  const p = (path: string) => `${prefix}${path}`;
  const w = { base, prefix, host, calls, audit, fronts: [] as WsAudit[], owners, p } as unknown as World;
  w.put = (path, content, mode = 0o644, uid = 0, gid = 0) => {
    mkdirSync(join(p(path), ".."), { recursive: true });
    writeFileSync(p(path), content);
    chmodSync(p(path), mode);
    owners.set(path, { uid, gid });
  };
  w.mkdir = (path, mode = 0o755, uid = 0) => {
    mkdirSync(p(path), { recursive: true });
    chmodSync(p(path), mode);
    owners.set(path, { uid, gid: uid });
  };
  w.advance = (ms) => void (t += ms);
  w.cfg = { ...WS_CONFIG, stateDir, orbitRoot: "/opt/orbit", healthWindowMs: 10_000, healthIntervalMs: 1000 };

  // the host as it starts
  for (const d of ["/etc/systemd/system", "/srv", "/var/lib", "/usr/bin", "/bin", "/opt/orbit/state", "/proc/self", "/proc/sys/kernel", "/proc/sys/user", "/sys/fs/cgroup"]) w.mkdir(d);
  if (opts.prlimit !== false) w.put("/usr/bin/prlimit", "#fake", 0o755);
  if (opts.bwrap === "ok") w.put("/usr/bin/bwrap", "#fake", 0o755);
  if (opts.bwrap === "setuid") w.put("/usr/bin/bwrap", "#fake", 0o4755);
  w.put("/bin/sh", "#fake", 0o755);
  w.put("/opt/orbit/current/COMMIT", `${SHA_A}\n`);
  w.put("/opt/orbit/orbit.env", "HOST=127.0.0.1\nPORT=8790\n", 0o640);
  for (const [k, v] of Object.entries({ "/proc/sys/user/max_user_namespaces": "63000", ...(opts.sysctl ?? {}) })) w.put(k, `${v}\n`);
  w.mkdir(`/proc/${host.pid}`, 0o555, host.procUid);
  const writeMountinfo = () => {
    const lines = [`25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw`];
    if (host.cgroup2) lines.push(`30 25 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:9 - cgroup2 cgroup2 rw,nsdelegate`);
    else lines.push(`30 25 0:26 / /sys/fs/cgroup ro,nosuid,nodev,noexec shared:9 - tmpfs tmpfs ro,mode=755`);
    let n = 0;
    for (const [point, m] of host.mounts) lines.push(`${200 + n} 25 7:${n++} / ${point.replace(/ /g, "\\040")} ${m.opts} shared:50 - ${m.fstype} /dev/loop${n} rw`);
    writeFileSync(p("/proc/self/mountinfo"), `${lines.join("\n")}\n`);
    writeFileSync(p("/sys/fs/cgroup/cgroup.controllers"), `${host.controllers}\n`);
  };
  writeMountinfo();
  (w as World & { remount: () => void }).remount = writeMountinfo;

  const fs = hostFs(prefix, owners);
  const restartOrbit = () => {
    host.pid += 1;
    host.procUid = host.user ? host.user.uid : DYN_UID;
    w.mkdir(`/proc/${host.pid}`, 0o555, host.procUid);
    host.active = "active";
    host.activeEnterSec = Math.floor(Date.now() / 1000) + 1;
  };
  const sh = async (file: string, args: string[], o?: ExecOpts): Promise<Exec> => {
    const a = args.join(" ");
    const f = host.fail?.(file, args);
    if (f) return f;
    if (file === BIN.systemctl) {
      if (a.startsWith("show orbit.service")) {
        const needReload = (fs.readText(DROPIN_PATH) ?? undefined) !== host.loadedDropIn ? "yes" : "no";
        return ok(`ActiveState=${host.active}\nMainPID=${host.active === "active" ? host.pid : 0}\nNeedDaemonReload=${needReload}\nDropInPaths=${host.loadedDropIn !== undefined ? DROPIN_PATH : ""}\nControlGroup=${host.active === "active" ? host.controlGroup : ""}\nActiveEnterTimestamp=@${host.activeEnterSec}\n`);
      }
      if (a === "--version") return ok(`systemd ${host.systemdVersion} (${host.systemdVersion}.4-1ubuntu3)\n+PAM +AUDIT +SELINUX\n`);
      if (args[0] === "is-enabled") return host.enabled.has(args[1]!) ? ok("enabled\n") : { code: 1, stdout: fs.lstat(`/etc/systemd/system/${args[1]}`) ? "disabled\n" : "not-found\n", stderr: "", timedOut: false };
      if (a === "daemon-reload") {
        host.loadedDropIn = fs.readText(DROPIN_PATH) ?? undefined;
        for (const ws of ["scratch", "orbit-validation"]) if (fs.lstat(mountUnitPath(ws))) host.loadedUnits.add(mountUnitName(ws));
        return ok();
      }
      if (args[0] === "enable" && args[1] === "--now") {
        const unit = args[2]!;
        if (!host.loadedUnits.has(unit)) return fail(1, `Failed to enable unit: Unit file ${unit} does not exist.`);
        const text = fs.readText(`/etc/systemd/system/${unit}`)!;
        const what = /^What=(.*)$/m.exec(text)![1]!;
        const where = /^Where=(.*)$/m.exec(text)![1]!;
        const sb = fs.readBytes(what, 1024, 136);
        host.enabled.add(unit);
        if (!sb || sb.length < 136 || sb.readUInt16LE(56) !== 0xef53) return fail(1, "Job for mount failed: wrong fs type");
        if (!host.mounts.has(where)) {
          if (!fs.lstat(where)) w.mkdir(where, 0o755);
          if (!host.everMounted.has(what)) {
            w.mkdir(`${where}/lost+found`, 0o700);
            host.everMounted.add(what);
          }
          host.mounts.set(where, { fstype: "ext4", opts: "rw,nosuid,nodev,noatime" });
          writeMountinfo();
        }
        return ok();
      }
      if (a === "restart orbit.service") {
        restartOrbit();
        return ok();
      }
      if (/^start --no-block orbit-ops-ws-run@[0-9a-f]{40}\.service$/.test(a)) return ok();
      if (/^is-active orbit-ops-ws-run@[0-9a-f]{40}\.service$/.test(a)) return host.runnerActive ? ok("active\n") : { code: 3, stdout: "inactive\n", stderr: "", timedOut: false };
      const pkg = /^start orbit-ops-ws-pkg@([0-9a-f]{40})\.service$/.exec(a);
      if (pkg) {
        const { runPackage } = await import("../src/ops/ws-run.ts");
        const code = await runPackage(pkg[1]!, w.env, w.cfg, (l) => audit.push(l));
        return code === 0 ? ok() : fail(1, "Job failed");
      }
      return fail(1, `fake systemctl: unexpected ${a}`);
    }
    if (file === BIN.getent) {
      assert.equal(o?.env?.SYSTEMD_NSS_DYNAMIC_BYPASS, "1", "getent always bypasses dynamic users");
      if (a === "passwd orbit") return host.user ? ok(`orbit:x:${host.user.uid}:${host.user.gid}::/nonexistent:${host.user.shell}\n`) : fail(2);
      if (a === "group orbit") return host.group ? ok(`orbit:x:${host.group.gid}:\n`) : fail(2);
    }
    if (file === BIN.useradd) {
      assert.equal(o?.env?.SYSTEMD_NSS_DYNAMIC_BYPASS, "1");
      if (host.user) return fail(9, "useradd: user 'orbit' already exists");
      if (args.includes("--user-group")) {
        if (host.group) return fail(9, "useradd: group orbit exists");
        host.group = { gid: 987 };
      }
      host.user = { uid: 987, gid: host.group!.gid, shell: args[args.indexOf("--shell") + 1]! };
      return ok();
    }
    if (file === BIN.aptGet) {
      if (host.apt === "lock") return fail(100, "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234 (unattended-upgr)");
      if (host.apt === "fail") return fail(100, "E: Unable to locate package bubblewrap");
      w.put("/usr/bin/bwrap", "#fake bwrap", 0o755);
      return ok("Setting up bubblewrap (0.9.0-1) ...\n");
    }
    if (file === BIN.fallocate) {
      truncateSync(p(args[2]!), Number(args[1]));
      return ok();
    }
    if (file === BIN.mkfs) {
      const img = args.at(-1)!;
      const label = args[args.indexOf("-L") + 1]!;
      writeSuperblock(p(img), label);
      return ok();
    }
    if (file === BIN.chown) {
      const path = args.at(-1)!;
      const [u, g] = args.at(-2)!.split(":");
      if (u === "orbit" && !host.user) return fail(1, "chown: invalid user: 'orbit:orbit'");
      if (g === "orbit" && !host.group) return fail(1, "chown: invalid group");
      owners.set(path, { uid: u === "root" ? 0 : host.user!.uid, gid: host.group!.gid });
      return ok();
    }
    if (file === BIN.chmod) {
      if (!host.noopChmod) chmodSync(p(args[1]!), parseInt(args[0]!, 8));
      return ok();
    }
    if (file === BIN.rmdir) {
      try {
        rmdirSync(p(args[0]!));
        return ok();
      } catch {
        return fail(1, `rmdir: failed to remove '${args[0]}': Directory not empty`);
      }
    }
    return fail(127, `fake: unexpected command ${file}`);
  };
  w.env = {
    exec: async (file, args, _timeout, o) => {
      calls.push({ file, args, ...(o ? { opts: o } : {}) });
      return sh(file, args, o);
    },
    probe: async () => (host.healthy ? { reachable: true, httpStatus: 200, commit: host.servedCommit } : { reachable: false }),
    sleep: async (ms) => void (t += ms),
    now: () => new Date(t),
    fs,
  };
  return w;
}

const remount = (w: World) => (w as World & { remount: () => void }).remount();
const line = (c: Call) => `${c.file} ${c.args.join(" ")}`;
const QUERY = /^\/usr\/bin\/(getent |systemctl (--version|show |is-enabled |is-active ))/;
const mutating = (w: World) => w.calls.map(line).filter((l) => !QUERY.test(l));
type Out = { ok: boolean; action?: string; data?: any; error?: { code: string; message: string } };
const send = async (w: World, req: object | string): Promise<Out> => JSON.parse(await handle(typeof req === "string" ? req : JSON.stringify(req), w.env, (a) => w.fronts.push(a), w.cfg));
const status = async (w: World) => {
  const out = await send(w, { action: "ws_status" });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.data as { facts: any; plan: { steps: PlanStep[]; planKey: string; todo: number; blocked: number }; blockers: { id: string; detail: string }[]; open: unknown };
};
const stepOf = (steps: PlanStep[], id: string) => steps.find((s) => s.id === id)!;
async function accept(w: World, opId = OP): Promise<Out> {
  const s = await status(w);
  const out = await send(w, { action: "ws_setup", opId, planKey: s.plan.planKey });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}
const run = async (w: World, opId = OP) => (await runOperation(opId, w.env, w.cfg, (l) => w.audit.push(l)))!;
async function setupAll(w: World, opId = OP): Promise<WsRecord> {
  await accept(w, opId);
  w.calls.length = 0;
  return run(w, opId);
}
const tree = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

// ---------------------------------------------------------------- fixed constants

test("the fixed plan: systemd-escaped mount units, exact drop-in, exact workspaces file", () => {
  assert.equal(systemdEscapePath("/srv/orbit-workspaces/scratch"), "srv-orbit\\x2dworkspaces-scratch");
  assert.equal(mountUnitName("scratch"), "srv-orbit\\x2dworkspaces-scratch.mount");
  assert.equal(mountUnitName("orbit-validation"), "srv-orbit\\x2dworkspaces-orbit\\x2dvalidation.mount");
  assert.equal(systemdEscapePath("/a b/.c/"), "a\\x20b-.c");
  assert.equal(systemdEscapePath("/.x"), "\\x2ex");
  const unit = mountUnitText("scratch");
  for (const l of ["What=/var/lib/orbit-workspaces/scratch.img", "Where=/srv/orbit-workspaces/scratch", "Type=ext4", "Options=loop,nosuid,nodev,noatime", "Before=orbit.service", "WantedBy=multi-user.target"]) assert.ok(unit.split("\n").includes(l), l);
  assert.equal(
    DROPIN_TEXT,
    "# Managed by orbit-ops-ws (docs/orbit-ops-ws.md). Workspace tools stay OFF until the owner enables them in ORBIT.\n[Service]\nDelegate=memory pids cpu\nDelegateSubgroup=main\nReadWritePaths=-/srv/orbit-workspaces/scratch -/srv/orbit-workspaces/orbit-validation\nEnvironment=ORBIT_WORKSPACE_TOOLS=enabled ORBIT_WORKSPACES_FILE=/etc/orbit/workspaces.json\n",
  );
  assert.equal(DROPIN_REVOKED_TEXT, DROPIN_TEXT.replace(/^Environment=.*\n/m, ""));
  assert.equal(
    workspacesFileText(CG),
    '{"preActivationChecklist":"workspace-tools-host-setup-v2","workspaces":[{"id":"scratch","root":"/srv/orbit-workspaces/scratch","exec":true},{"id":"orbit-validation","root":"/srv/orbit-workspaces/orbit-validation","exec":true}],"sandbox":{"bwrap":"/usr/bin/bwrap","prlimit":"/usr/bin/prlimit","shell":"/bin/sh","cgroupParent":"/sys/fs/cgroup/system.slice/orbit.service/workspace-exec","maxConcurrentRuns":1}}\n',
  );
  assert.equal(imagePath("orbit-validation"), "/var/lib/orbit-workspaces/orbit-validation.img");
  assert.equal(mountPoint("scratch"), "/srv/orbit-workspaces/scratch");
});

// ---------------------------------------------------------------- strict request parsing

test("requests are strict: fixed actions and keys, 40-hex opId, 24-hex planKey for ws_setup only, size cap", () => {
  assert.deepEqual([...WS_ACTIONS], ["ws_status", "ws_setup", "ws_revoke", "op_status"]);
  const bad = (r: unknown, code: string) => assert.throws(() => parseWsRequest(typeof r === "string" ? r : JSON.stringify(r)), (e: { code?: string }) => e.code === code, JSON.stringify(r).slice(0, 90));
  const KEY = "c".repeat(24);
  assert.deepEqual(parseWsRequest(JSON.stringify({ action: "ws_status" })), { action: "ws_status" });
  assert.deepEqual(parseWsRequest(JSON.stringify({ action: "ws_setup", opId: OP, planKey: KEY })), { action: "ws_setup", opId: OP, planKey: KEY });
  assert.deepEqual(parseWsRequest(JSON.stringify({ action: "ws_revoke", opId: OP })), { action: "ws_revoke", opId: OP });
  assert.deepEqual(parseWsRequest(JSON.stringify({ action: "op_status", opId: OP })), { action: "op_status", opId: OP });
  bad("nope", "bad_request");
  bad("[]", "bad_request");
  bad("null", "bad_request");
  bad({ opId: OP }, "bad_request");
  for (const action of ["shell", "exec", "apt", "useradd", "mkfs", "mount", "setup", "revoke", "WS_SETUP", ""]) bad({ action, opId: OP }, "unknown_action");
  bad({ action: "ws_status", opId: OP }, "bad_arguments");
  bad({ action: "ws_setup", opId: OP }, "bad_arguments");
  bad({ action: "ws_setup", opId: OP, planKey: KEY, size: 10 }, "bad_arguments");
  bad({ action: "ws_setup", opId: OP, planKey: KEY, path: "/etc/shadow" }, "bad_arguments");
  bad({ action: "ws_setup", opId: OP, planKey: KEY.toUpperCase() }, "bad_arguments");
  bad({ action: "ws_setup", opId: OP, planKey: "c".repeat(64) }, "bad_arguments");
  bad({ action: "ws_setup", opId: OP, planKey: "c".repeat(23) }, "bad_arguments");
  bad({ action: "ws_setup", opId: OP, planKey: 7 }, "bad_arguments");
  bad({ action: "ws_revoke", opId: OP, planKey: KEY }, "bad_arguments");
  bad({ action: "ws_revoke", opId: "short" }, "bad_arguments");
  bad({ action: "op_status", opId: "A".repeat(40) }, "bad_arguments");
  bad({ action: "op_status", opId: `${OP}0` }, "bad_arguments");
  bad({ action: "op_status" }, "bad_arguments");
  bad({ action: "op_status", opId: OP, pad: "x".repeat(WS_MAX_REQUEST_BYTES) }, "request_too_large");
  assert.match(opIdFor("prop-1"), /^[0-9a-f]{40}$/);
  assert.equal(opIdFor("prop-1"), opIdFor("prop-1"));
  assert.notEqual(opIdFor("prop-1"), opIdFor("prop-2"));
});

test("a refused request at the front records nothing and runs nothing; the audit line never carries the raw request", async () => {
  const w = world();
  const secretish = part("pass", "word=", "Zz9".repeat(6));
  const out = await send(w, { action: "ws_setup", opId: OP, planKey: "c".repeat(24), note: secretish });
  assert.equal(out.ok, false);
  assert.equal(out.error!.code, "bad_arguments");
  assert.equal(w.calls.length, 0);
  assert.ok(!existsSync(join(w.cfg.stateDir, "ops")) || readdirSync(join(w.cfg.stateDir, "ops")).length === 0);
  assert.ok(!JSON.stringify(w.fronts).includes("Zz9Zz9"));
  assert.equal(w.fronts.at(-1)!.outcome, "rejected");
});

// ---------------------------------------------------------------- the plan

test("fresh host: every step is todo, with the exact commands on the card; ws_status changes nothing", async () => {
  const w = world();
  const before = tree(w.prefix);
  const s = await status(w);
  assert.deepEqual(tree(w.prefix), before, "ws_status wrote nothing on the host");
  assert.deepEqual(mutating(w), [], "ws_status ran only queries");
  assert.deepEqual(s.plan.steps.map((x) => [x.id, x.state]), [
    ["package_bubblewrap", "todo"],
    ["identity", "todo"],
    ["storage_scratch", "todo"],
    ["storage_orbit-validation", "todo"],
    ["workspaces_file", "todo"],
    ["service_dropin", "todo"],
    ["apply", "todo"],
  ]);
  assert.deepEqual(s.blockers, []);
  assert.equal(s.open, null);
  assert.equal(s.plan.planKey, planKeyOf(s.plan.steps));
  assert.match(s.plan.planKey, /^[0-9a-f]{24}$/);
  const a = (id: string) => stepOf(s.plan.steps, id).action;
  assert.match(a("package_bubblewrap"), /^DEBIAN_FRONTEND=noninteractive \/usr\/bin\/apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends bubblewrap /);
  assert.equal(a("identity"), "/usr/sbin/useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin orbit");
  assert.match(stepOf(s.plan.steps, "identity").detail, /re-owns ORBIT's state directory recursively/);
  assert.match(stepOf(s.plan.steps, "identity").title, /uid changes at its next restart/);
  const st = a("storage_scratch");
  for (const l of [
    "create directory /var/lib/orbit-workspaces if absent (root:root), mode 0700",
    "create the empty file /var/lib/orbit-workspaces/scratch.img (root:root, mode 0600; refused if anything already exists there)",
    "/usr/bin/fallocate -l 1073741824 /var/lib/orbit-workspaces/scratch.img",
    "/usr/sbin/mkfs.ext4 -q -F -L orbit-ws-scratch /var/lib/orbit-workspaces/scratch.img",
    "/usr/bin/systemctl daemon-reload",
    "/usr/bin/systemctl enable --now 'srv-orbit\\x2dworkspaces-scratch.mount'",
    "if /srv/orbit-workspaces/scratch/lost+found exists: /usr/bin/rmdir /srv/orbit-workspaces/scratch/lost+found (rmdir only removes an empty directory)",
    "/usr/bin/chown -h orbit:orbit /srv/orbit-workspaces/scratch",
    "/usr/bin/chmod 0700 /srv/orbit-workspaces/scratch",
  ]) assert.ok(st.split("\n").includes(l), l);
  assert.ok(st.includes(mountUnitText("scratch")), "the mount unit content is shown verbatim");
  assert.match(a("storage_orbit-validation"), /fallocate -l 67108864 /);
  assert.ok(a("workspaces_file").endsWith(workspacesFileText(CG)));
  assert.match(a("workspaces_file"), /create \/etc\/orbit\/workspaces\.json \(root:orbit, mode 0640; refused if it already exists\)/);
  assert.ok(a("service_dropin").endsWith(DROPIN_TEXT));
  assert.match(a("apply"), /daemon-reload; \/usr\/bin\/systemctl restart orbit\.service \(ORBIT is offline for a few seconds\)/);
  // The card text is shown to the owner verbatim: redaction must not change a single character of it.
  for (const step of s.plan.steps) assert.equal(redact(step.action), step.action, step.id);
  const out = await send(w, { action: "ws_status" });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < WS_MAX_RESPONSE_BYTES);
});

test("fresh host: ws_setup runs every step in order, verifies by observation, and the host is then fully set up", async () => {
  const w = world();
  const rec = await setupAll(w);
  assert.equal(rec.state, "verified", JSON.stringify(rec, null, 1));
  assert.equal(rec.verification!.checked, true);
  assert.equal(rec.verification!.healthy, true);
  assert.equal(rec.verification!.planComplete, true);
  assert.equal(rec.verification!.expectedCommit, SHA_A);
  // order of the mutating commands
  const m = mutating(w);
  const idx = (re: RegExp) => m.findIndex((l) => re.test(l));
  assert.ok(idx(/start orbit-ops-ws-pkg@/) < idx(/useradd/));
  assert.ok(idx(/useradd/) < idx(/fallocate .*scratch\.img/));
  assert.ok(idx(/mkfs\.ext4 .*orbit-validation\.img/) < idx(/restart orbit\.service/));
  assert.equal(m.filter((l) => /restart orbit\.service/.test(l)).length, 1);
  assert.equal(m.filter((l) => /mkfs\.ext4/.test(l)).length, 2);
  // apt ran in the package unit, with the fixed arguments, the noninteractive environment and never killed
  const apt = w.calls.filter((c) => c.file === BIN.aptGet);
  assert.equal(apt.length, 1);
  assert.deepEqual(apt[0]!.args, ["-o", "DPkg::Lock::Timeout=120", "install", "-y", "--no-install-recommends", "bubblewrap"]);
  assert.equal(apt[0]!.opts?.env?.DEBIAN_FRONTEND, "noninteractive");
  assert.equal(apt[0]!.opts?.noKill, true);
  // the host as observed afterwards
  assert.equal(readFileSync(w.p(DROPIN_PATH), "utf8"), DROPIN_TEXT);
  assert.equal(readFileSync(w.p(WORKSPACES_FILE), "utf8"), workspacesFileText(CG));
  assert.equal(statSync(w.p(WORKSPACES_FILE)).mode & 0o777, 0o640);
  assert.deepEqual(w.owners.get(WORKSPACES_FILE), { uid: 0, gid: 987 });
  assert.equal(statSync(w.p("/var/lib/orbit-workspaces")).mode & 0o777, 0o700);
  for (const id of ["scratch", "orbit-validation"]) {
    assert.equal(statSync(w.p(mountPoint(id))).mode & 0o777, 0o700);
    assert.equal(w.owners.get(mountPoint(id))!.uid, 987);
    assert.ok(!existsSync(w.p(`${mountPoint(id)}/lost+found`)));
    assert.equal(statSync(w.p(imagePath(id))).mode & 0o777, 0o600);
    assert.equal(readFileSync(w.p(mountUnitPath(id)), "utf8"), mountUnitText(id));
  }
  assert.equal(w.host.procUid, 987, "ORBIT now runs as the static orbit uid");
  // and a second ws_setup is no_change: answered by the front, no runner, nothing run
  const s = await status(w);
  assert.ok(s.plan.steps.every((x) => x.state === "done"), JSON.stringify(s.plan.steps.filter((x) => x.state !== "done")));
  assert.equal(s.facts.dropIn, "enabled");
  assert.equal(s.facts.orbitService.runsAsStaticUser, true);
  w.calls.length = 0;
  const again = await send(w, { action: "ws_setup", opId: OP2, planKey: s.plan.planKey });
  assert.equal(again.ok, true);
  assert.equal(again.data.operation.state, "no_change");
  assert.deepEqual(mutating(w), []);
  assert.equal(loadRecord(w.cfg, OP2)!.state, "no_change");
});

test("partial host: bwrap, the user and ext4 images exist; existing images are never formatted and their data is kept", async () => {
  const w = world({ bwrap: "ok" });
  w.host.user = { uid: 990, gid: 990, shell: "/usr/sbin/nologin" };
  w.host.group = { gid: 990 };
  w.mkdir("/var/lib/orbit-workspaces", 0o700);
  for (const id of ["scratch", "orbit-validation"]) {
    w.put(imagePath(id), "", 0o600);
    truncateSync(w.p(imagePath(id)), 4 * 1024 * 1024);
    writeSuperblock(w.p(imagePath(id)), `orbit-ws-${id}`);
    const fd = openSync(w.p(imagePath(id)), "r+");
    writeSync(fd, Buffer.from("precious workspace data"), 0, 23, 2 * 1024 * 1024);
    closeSync(fd);
  }
  const before = readFileSync(w.p(imagePath("scratch")));
  const s = await status(w);
  assert.equal(stepOf(s.plan.steps, "package_bubblewrap").state, "done");
  assert.equal(stepOf(s.plan.steps, "identity").state, "done");
  const st = stepOf(s.plan.steps, "storage_scratch");
  assert.equal(st.state, "todo");
  assert.ok(!/fallocate|mkfs|create the empty file/.test(st.action), st.action);
  assert.match(st.detail, /existing image is kept \(never formatted\)/);
  assert.match(st.detail, /4194304 bytes \(kept as is\)/);
  const rec = await setupAll(w);
  assert.equal(rec.state, "verified", rec.summary);
  assert.ok(!w.calls.some((c) => c.file === BIN.mkfs || c.file === BIN.fallocate || c.file === BIN.aptGet || c.file === BIN.useradd));
  assert.ok(readFileSync(w.p(imagePath("scratch"))).equals(before), "image bytes unchanged");
});

test("an existing image without ext4 is blocked: ws_setup is refused before anything is recorded or run", async () => {
  const w = world({ bwrap: "ok" });
  w.mkdir("/var/lib/orbit-workspaces", 0o700);
  w.put(imagePath("scratch"), "not a filesystem", 0o600);
  const s = await status(w);
  const st = stepOf(s.plan.steps, "storage_scratch");
  assert.equal(st.state, "blocked");
  assert.match(st.detail, /never formatted/);
  assert.equal(st.action, "(nothing)");
  assert.equal(s.plan.blocked, 1);
  w.calls.length = 0;
  const out = await send(w, { action: "ws_setup", opId: OP, planKey: s.plan.planKey });
  assert.equal(out.ok, false);
  assert.equal(out.error!.code, "plan_blocked");
  assert.match(out.error!.message, /storage_scratch/);
  assert.equal(loadRecord(w.cfg, OP), undefined);
  assert.deepEqual(mutating(w), []);
  assert.ok(!existsSync(join(w.cfg.stateDir, "active")), "the slot is released");
  assert.equal(readFileSync(w.p(imagePath("scratch")), "utf8"), "not a filesystem");
});

test("blocked steps: setuid bwrap, missing prlimit, a non-system or login orbit user, an operator's mount unit or drop-in", async () => {
  const cases: [string, (w: World) => void, string, RegExp][] = [
    ["setuid bwrap", () => undefined, "package_bubblewrap", /setuid or setgid/],
    ["no prlimit", () => undefined, "package_bubblewrap", /util-linux/],
    ["login user", (w) => { w.host.user = { uid: 1001, gid: 1001, shell: "/bin/bash" }; w.host.group = { gid: 1001 }; }, "identity", /never changes an existing account/],
    ["user without group", (w) => { w.host.user = { uid: 991, gid: 991, shell: "/usr/sbin/nologin" }; }, "identity", /group orbit does not/],
    ["non-system group", (w) => { w.host.group = { gid: 1500 }; }, "identity", /not a system group/],
    ["operator mount unit", (w) => w.put(mountUnitPath("scratch"), "[Mount]\nWhat=/dev/sdb1\n"), "storage_scratch", /did not write/],
    ["foreign mount", (w) => { w.host.mounts.set(mountPoint("scratch"), { fstype: "tmpfs", opts: "rw,relatime" }); remount(w); w.mkdir(mountPoint("scratch")); }, "storage_scratch", /never unmounted/],
    ["operator drop-in", (w) => w.put(DROPIN_PATH, "[Service]\nEnvironment=FOO=1\n"), "service_dropin", /did not write/],
  ];
  for (const [name, prep, id, re] of cases) {
    const w = world({ bwrap: name === "setuid bwrap" ? "setuid" : "ok", prlimit: name !== "no prlimit" });
    prep(w);
    const s = await status(w);
    const st = stepOf(s.plan.steps, id);
    assert.equal(st.state, "blocked", name);
    assert.match(st.detail, re, name);
    const out = await send(w, { action: "ws_setup", opId: OP, planKey: s.plan.planKey });
    assert.equal(out.error?.code, "plan_blocked", name);
  }
  // Without the dynamic-user bypass a running ORBIT would show up as "orbit" with a dynamic uid: that is not a static user.
  const w = world({ bwrap: "ok" });
  w.host.user = { uid: DYN_UID, gid: DYN_UID, shell: "/usr/sbin/nologin" };
  w.host.group = { gid: DYN_UID };
  assert.equal(stepOf((await status(w)).plan.steps, "identity").state, "blocked");
});

test("host blockers are reported and never changed; setup still proceeds and says exec stays unavailable", async () => {
  const w = world({ sysctl: { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1", "/proc/sys/user/max_user_namespaces": "0", "/proc/sys/kernel/unprivileged_userns_clone": "0" } });
  w.host.systemdVersion = 252;
  w.host.controllers = "cpuset io memory pids";
  remount(w);
  const s = await status(w);
  assert.deepEqual(s.blockers.map((b) => b.id), ["cgroup_controllers", "systemd_version", "apparmor_userns", "user_namespaces", "unprivileged_userns_clone"]);
  assert.match(s.blockers.find((b) => b.id === "cgroup_controllers")!.detail, /lacks cpu/);
  assert.match(s.blockers.find((b) => b.id === "apparmor_userns")!.detail, /AppArmor profile/);
  assert.equal(s.plan.blocked, 0, "blockers are not blocked steps");
  const rec = await setupAll(w);
  assert.equal(rec.state, "verified", rec.summary);
  assert.match(rec.summary!, /Host blockers remain \(cgroup_controllers, systemd_version, apparmor_userns, user_namespaces, unprivileged_userns_clone\): sandboxed exec stays unavailable/);
  assert.deepEqual(rec.blockers, ["cgroup_controllers", "systemd_version", "apparmor_userns", "user_namespaces", "unprivileged_userns_clone"]);
  assert.equal(readFileSync(w.p("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"), "utf8"), "1\n", "never changed");
  const v1 = world();
  v1.host.cgroup2 = false;
  remount(v1);
  assert.deepEqual((await status(v1)).blockers.map((b) => b.id), ["cgroup_v2"]);
});

test("a differing workspaces file is operator-managed: shown as done and never overwritten", async () => {
  const w = world({ bwrap: "ok" });
  const theirs = '{"preActivationChecklist":"x","workspaces":[]}\n';
  w.put(WORKSPACES_FILE, theirs, 0o600);
  const s = await status(w);
  const st = stepOf(s.plan.steps, "workspaces_file");
  assert.equal(st.state, "done");
  assert.equal(st.detail, "exists and differs; kept unchanged (operator-managed).");
  assert.equal(s.facts.workspacesFile, "operator-managed");
  const rec = await setupAll(w);
  assert.equal(rec.state, "verified", rec.summary);
  assert.equal(readFileSync(w.p(WORKSPACES_FILE), "utf8"), theirs);
  assert.equal(statSync(w.p(WORKSPACES_FILE)).mode & 0o777, 0o600);
});

test("the workspaces file needs ORBIT's control group: unreadable while ORBIT is stopped, so that step is blocked", async () => {
  const w = world({ bwrap: "ok" });
  w.host.active = "inactive";
  const st = stepOf((await status(w)).plan.steps, "workspaces_file");
  assert.equal(st.state, "blocked");
  assert.match(st.detail, /control group/);
});

// ---------------------------------------------------------------- the plan key binds the request

test("plan_changed at the front: a key that does not match the current plan is refused with nothing recorded", async () => {
  const w = world();
  const s = await status(w);
  w.put("/usr/bin/bwrap", "#fake", 0o755); // the host changed after the card was shown
  w.calls.length = 0;
  const out = await send(w, { action: "ws_setup", opId: OP, planKey: s.plan.planKey });
  assert.equal(out.ok, false);
  assert.equal(out.error!.code, "plan_changed");
  assert.equal(loadRecord(w.cfg, OP), undefined);
  assert.deepEqual(mutating(w), [], "no runner was started");
  assert.ok(!existsSync(join(w.cfg.stateDir, "active")));
  const wrong = await send(w, { action: "ws_setup", opId: OP, planKey: "0".repeat(24) });
  assert.equal(wrong.error!.code, "plan_changed");
});

test("plan_changed at the runner: the host changed between acceptance and execution, so nothing is changed", async () => {
  const w = world();
  await accept(w);
  w.host.user = { uid: 990, gid: 990, shell: "/usr/sbin/nologin" };
  w.host.group = { gid: 990 };
  const before = tree(w.prefix);
  w.calls.length = 0;
  const rec = await run(w);
  assert.equal(rec.state, "failed");
  assert.equal(rec.code, "plan_changed");
  assert.equal(rec.failedStep, "plan");
  assert.match(rec.summary!, /^Nothing was changed/);
  assert.deepEqual(mutating(w), []);
  assert.deepEqual(tree(w.prefix), before);
  assert.ok(!existsSync(join(w.cfg.stateDir, "active")), "slot released");
});

// ---------------------------------------------------------------- replay and one-at-a-time

test("replay: a repeated opId returns the existing record and never runs again", async () => {
  const w = world();
  const first = await setupAll(w);
  assert.equal(first.state, "verified");
  w.calls.length = 0;
  const s = await status(w);
  const again = await send(w, { action: "ws_setup", opId: OP, planKey: s.plan.planKey });
  assert.equal(again.ok, true);
  assert.equal(again.data.replayed, true);
  assert.equal(again.data.operation.state, "verified");
  const rerun = await run(w);
  assert.equal(rerun.state, "verified");
  assert.deepEqual(mutating(w), [], "no command ran for the replay");
  assert.equal(w.fronts.at(-1)!.outcome, "replayed");
  const revokeReplay = await send(w, { action: "ws_revoke", opId: OP });
  assert.equal(revokeReplay.data.replayed, true, "an id is never reused for another action either");
});

test("one operation at a time: a second request is busy while the first runs; a dead runner is settled as interrupted", async () => {
  const w = world();
  await accept(w, OP);
  const s = await status(w);
  assert.deepEqual(s.open, { opId: OP, action: "ws_setup", state: "accepted" });
  const busy = await send(w, { action: "ws_revoke", opId: OP2 });
  assert.equal(busy.ok, false);
  assert.equal(busy.error!.code, "busy");
  assert.equal(loadRecord(w.cfg, OP2), undefined);
  // the runner vanished: after the stale window the record is interrupted (never success) and the slot can be taken
  w.host.runnerActive = false;
  w.advance(w.cfg.staleAfterMs + 1000);
  const st = await send(w, { action: "op_status", opId: OP });
  assert.equal(st.data.operation.state, "interrupted");
  assert.match(st.data.operation.summary, /outcome is unknown/);
  assert.equal(st.data.operation.verification.checked, false);
  assert.ok(!existsSync(join(w.cfg.stateDir, "active")));
  const next = await send(w, { action: "ws_revoke", opId: OP2 });
  assert.equal(next.ok, true);
  assert.equal(next.data.operation.state, "accepted");
  // an interrupted record is never run later
  const late = await run(w, OP);
  assert.equal(late.state, "interrupted");
  // a busy front never settles a live runner
  const w2 = world();
  await accept(w2, OP);
  w2.advance(w2.cfg.staleAfterMs + 1000);
  assert.equal((await send(w2, { action: "op_status", opId: OP })).data.operation.state, "accepted");
  assert.equal((await send(w2, { action: "ws_revoke", opId: OP3 })).error!.code, "busy");
});

test("a runner that cannot be started leaves a failed record that says nothing was done", async () => {
  const w = world();
  w.host.fail = (f, a) => (f === BIN.systemctl && a[0] === "start" && a[1] === "--no-block" ? fail(1, "Unit not found") : undefined);
  const s = await status(w);
  const out = await send(w, { action: "ws_setup", opId: OP, planKey: s.plan.planKey });
  assert.equal(out.data.operation.state, "failed");
  assert.match(out.data.operation.summary, /nothing was done/);
  assert.ok(!existsSync(join(w.cfg.stateDir, "active")));
});

// ---------------------------------------------------------------- failures stop the run; nothing is undone or deleted

test("the runner stops at the first failing step, reports it, runs nothing after it and deletes nothing", async () => {
  const w = world();
  w.host.fail = (f) => (f === BIN.useradd ? fail(9, "useradd: cannot lock /etc/passwd; try again later.") : undefined);
  const rec = await setupAll(w);
  assert.equal(rec.state, "failed");
  assert.equal(rec.failedStep, "identity");
  assert.equal(rec.code, "step_failed");
  assert.match(rec.summary!, /^Stopped at identity: .*cannot lock \/etc\/passwd.*Completed before it: package_bubblewrap\. Nothing was rolled back or deleted and later steps were not run\./);
  assert.ok(existsSync(w.p("/usr/bin/bwrap")), "the package step's result is kept");
  assert.ok(!w.calls.some((c) => [BIN.fallocate, BIN.mkfs, BIN.chown, BIN.chmod].includes(c.file as never)), "no later step ran");
  assert.ok(!w.calls.some((c) => c.args.join(" ") === "restart orbit.service"), "ORBIT was not restarted");
  assert.equal(rec.verification!.healthy, false);
  assert.notEqual(rec.state, "verified");
});

test("a failed mkfs leaves the new image in place (never deleted) and the next plan blocks on it", async () => {
  const w = world({ bwrap: "ok" });
  w.host.fail = (f, a) => (f === BIN.mkfs && a.at(-1) === imagePath("orbit-validation") ? fail(1, "mkfs.ext4: No space left on device") : undefined);
  const rec = await setupAll(w);
  assert.equal(rec.state, "failed");
  assert.equal(rec.failedStep, "storage_orbit-validation");
  assert.match(rec.summary!, /were left in place/);
  assert.ok(existsSync(w.p(imagePath("orbit-validation"))));
  assert.ok(existsSync(w.p(imagePath("scratch"))), "the earlier workspace is kept and mounted");
  assert.ok(w.host.mounts.has(mountPoint("scratch")));
  w.host.fail = undefined;
  const s = await status(w);
  assert.equal(stepOf(s.plan.steps, "storage_orbit-validation").state, "blocked");
  assert.equal(stepOf(s.plan.steps, "storage_scratch").state, "done");
});

test("mkfs is never run on an image the operation did not create, even if the image appears after the plan check", async () => {
  const w = world({ bwrap: "ok" });
  await accept(w);
  // Race: the image appears after the runner recomputed the plan but before it creates the file. The exclusive create refuses.
  const realExec = w.env.exec;
  let planned = false;
  w.env.exec = async (file, args, t, o) => {
    if (file === BIN.useradd && !planned) {
      planned = true;
      w.put(imagePath("scratch"), "someone else's data", 0o600);
    }
    return realExec(file, args, t, o);
  };
  w.calls.length = 0;
  const rec = await run(w);
  assert.equal(rec.state, "failed");
  assert.equal(rec.failedStep, "storage_scratch");
  assert.match(rec.summary!, /could not be created exclusively/);
  assert.ok(!w.calls.some((c) => c.file === BIN.mkfs || c.file === BIN.fallocate));
  assert.equal(readFileSync(w.p(imagePath("scratch")), "utf8"), "someone else's data");
});

test("apt lock contention: the package step fails with nothing changed, nothing killed or unlocked, and no later step runs", async () => {
  const w = world();
  w.host.apt = "lock";
  const rec = await setupAll(w);
  assert.equal(rec.state, "failed");
  assert.equal(rec.failedStep, "package_bubblewrap");
  assert.equal(rec.pkgResult, "busy");
  assert.match(rec.summary!, /package manager was busy.*nothing was changed, killed or unlocked/);
  assert.equal(mutating(w).filter((l) => !/orbit-ops-ws-pkg@/.test(l) && !l.startsWith(BIN.aptGet)).length, 0, "nothing else ran");
  assert.ok(!w.calls.some((c) => ["kill", "pkill", "rm", "fuser", "lsof"].includes(c.file.split("/").pop()!)));
  assert.equal(rec.pkgRequested, undefined, "the one-shot package authorization is consumed");
});

test("the package unit runs apt-get only for a running ws_setup that asked for it, and only once", async () => {
  const { runPackage } = await import("../src/ops/ws-run.ts");
  const w = world();
  assert.equal(await runPackage(OP, w.env, w.cfg, () => undefined), 1, "no record: refused");
  await accept(w);
  assert.equal(await runPackage(OP, w.env, w.cfg, () => undefined), 1, "accepted but not running: refused");
  assert.ok(!w.calls.some((c) => c.file === BIN.aptGet));
});

// ---------------------------------------------------------------- verification only from observation

test("verification is observation only: /status unhealthy or serving another commit after the restart is failed, never verified", async () => {
  for (const variant of ["down", "other-commit", "plan-incomplete"] as const) {
    const w = world({ bwrap: "ok" });
    await accept(w);
    if (variant === "down") w.host.fail = (f, a) => (f === BIN.systemctl && a.join(" ") === "restart orbit.service" ? ((w.host.healthy = false), undefined) : undefined);
    if (variant === "other-commit") w.host.servedCommit = "b".repeat(40);
    if (variant === "plan-incomplete") w.host.noopChmod = true;
    const rec = await run(w);
    assert.equal(rec.state, "failed", variant);
    assert.notEqual(rec.verification?.healthy === true && rec.verification?.planComplete === true, true, variant);
    if (variant === "plan-incomplete") {
      assert.equal(rec.failedStep, "verify");
      assert.match(rec.summary!, /still not done: storage_scratch/);
    } else {
      assert.equal(rec.failedStep, "apply", variant);
      assert.match(rec.summary!, variant === "down" ? /never answered/ : /expected aaaaaaaaaaaa/);
    }
  }
});

// ---------------------------------------------------------------- ws_revoke

test("ws_revoke removes only the Environment= line, restarts ORBIT and verifies; everything else is kept", async () => {
  const w = world();
  assert.equal((await setupAll(w)).state, "verified");
  const keep = [WORKSPACES_FILE, mountUnitPath("scratch"), mountUnitPath("orbit-validation"), "/usr/bin/bwrap"].map((p) => [p, readFileSync(w.p(p), "utf8")] as const);
  const imagesBefore = tree(w.p("/var/lib/orbit-workspaces"));
  const out = await send(w, { action: "ws_revoke", opId: OP2 });
  assert.equal(out.ok, true);
  w.calls.length = 0;
  const rec = await run(w, OP2);
  assert.equal(rec.state, "verified", rec.summary);
  assert.equal(readFileSync(w.p(DROPIN_PATH), "utf8"), DROPIN_REVOKED_TEXT);
  assert.ok(!readFileSync(w.p(DROPIN_PATH), "utf8").includes("Environment="));
  assert.match(readFileSync(w.p(DROPIN_PATH), "utf8"), /^Delegate=memory pids cpu$/m);
  for (const [p, text] of keep) assert.equal(readFileSync(w.p(p), "utf8"), text, p);
  assert.deepEqual(tree(w.p("/var/lib/orbit-workspaces")), imagesBefore);
  assert.equal(w.host.mounts.size, 2, "mounts kept");
  assert.ok(w.host.user, "user kept");
  assert.deepEqual(mutating(w), [`${BIN.systemctl} daemon-reload`, `${BIN.systemctl} restart orbit.service`]);
  // again: already revoked
  await send(w, { action: "ws_revoke", opId: OP3 });
  assert.equal((await run(w, OP3)).state, "no_change");
  // and setup afterwards only writes the drop-in back and applies it
  const s = await status(w);
  assert.equal(s.facts.dropIn, "revoked");
  assert.deepEqual(s.plan.steps.filter((x) => x.state !== "done").map((x) => x.id), ["service_dropin", "apply"]);
});

test("ws_revoke without a drop-in is no_change; with an operator's drop-in it refuses and changes nothing", async () => {
  const w = world();
  await send(w, { action: "ws_revoke", opId: OP });
  w.calls.length = 0;
  assert.equal((await run(w, OP)).state, "no_change");
  assert.deepEqual(mutating(w), []);
  const theirs = "[Service]\nEnvironment=ORBIT_WORKSPACE_TOOLS=enabled\n";
  w.put(DROPIN_PATH, theirs);
  await send(w, { action: "ws_revoke", opId: OP2 });
  w.calls.length = 0;
  const rec = await run(w, OP2);
  assert.equal(rec.state, "failed");
  assert.equal(rec.code, "operator_managed");
  assert.equal(readFileSync(w.p(DROPIN_PATH), "utf8"), theirs);
  assert.deepEqual(mutating(w), []);
});

// ---------------------------------------------------------------- commands, redaction, records

const ALLOWED = new Set<string>([
  `${BIN.systemctl} show orbit.service --timestamp=unix -p ActiveState -p MainPID -p NeedDaemonReload -p DropInPaths -p ControlGroup -p ActiveEnterTimestamp`,
  `${BIN.systemctl} --version`,
  `${BIN.systemctl} daemon-reload`,
  `${BIN.systemctl} restart orbit.service`,
  `${BIN.getent} passwd orbit`,
  `${BIN.getent} group orbit`,
  `${BIN.useradd} --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin orbit`,
  `${BIN.useradd} --system --gid orbit --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin orbit`,
  `${BIN.aptGet} -o DPkg::Lock::Timeout=120 install -y --no-install-recommends bubblewrap`,
  `${BIN.chown} root:orbit /etc/orbit/workspaces.json`,
  `${BIN.chmod} 0640 /etc/orbit/workspaces.json`,
  ...["scratch", "orbit-validation"].flatMap((id) => [
    `${BIN.systemctl} is-enabled ${mountUnitName(id)}`,
    `${BIN.systemctl} enable --now ${mountUnitName(id)}`,
    `${BIN.fallocate} -l ${id === "scratch" ? 1073741824 : 67108864} ${imagePath(id)}`,
    `${BIN.mkfs} -q -F -L orbit-ws-${id} ${imagePath(id)}`,
    `${BIN.chown} -h orbit:orbit ${mountPoint(id)}`,
    `${BIN.chmod} 0700 ${mountPoint(id)}`,
    `${BIN.rmdir} ${mountPoint(id)}/lost+found`,
  ]),
]);
const ALLOWED_RE = [/^\/usr\/bin\/systemctl (start --no-block orbit-ops-ws-run@|is-active orbit-ops-ws-run@|start orbit-ops-ws-pkg@)[0-9a-f]{40}\.service$/];

test("every command the front, the runner and the package unit issue is on a fixed allowlist", async () => {
  const all: Call[] = [];
  const scenarios: ((w: World) => Promise<unknown>)[] = [
    async (w) => setupAll(w),
    async (w) => {
      await setupAll(w);
      await send(w, { action: "ws_revoke", opId: OP2 });
      await run(w, OP2);
      await status(w);
    },
    async (w) => {
      w.host.group = { gid: 900 };
      await setupAll(w);
    },
    async (w) => {
      w.host.apt = "lock";
      await setupAll(w);
    },
    async (w) => {
      await accept(w);
      w.host.runnerActive = false;
      w.advance(60_000);
      await send(w, { action: "op_status", opId: OP });
    },
  ];
  for (const sc of scenarios) {
    const w = world();
    await sc(w);
    all.push(...w.calls);
  }
  for (const c of all) {
    const l = line(c);
    assert.ok(ALLOWED.has(l) || ALLOWED_RE.some((re) => re.test(l)), `not allowlisted: ${l}`);
    assert.ok(c.file.startsWith("/"), "absolute path");
  }
  assert.ok(all.some((c) => c.file === BIN.useradd && c.args.includes("--gid")), "the existing-group variant was exercised");
});

test("outputs are redacted: a token in a command's error output reaches no record, answer or audit line", async () => {
  const w = world();
  const token = part("gh", "p_", "Q".repeat(36));
  const pw = part("pass", "word=", "hunter", "2hunter2");
  w.host.fail = (f) => (f === BIN.useradd ? fail(1, `useradd: failure near ${token} and ${pw}`) : undefined);
  const rec = await setupAll(w);
  assert.equal(rec.state, "failed");
  const raw = readFileSync(join(w.cfg.stateDir, "ops", `${OP}.json`), "utf8");
  const answer = JSON.stringify(await send(w, { action: "op_status", opId: OP }));
  for (const blob of [raw, answer, JSON.stringify(w.audit), JSON.stringify(w.fronts)]) {
    assert.ok(!blob.includes(token), "token redacted");
    assert.ok(!blob.includes("hunter2hunter2"), "password redacted");
  }
  assert.match(raw, /\[redacted/);
  assert.equal(statSync(join(w.cfg.stateDir, "ops", `${OP}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(join(w.cfg.stateDir, "ops")).mode & 0o777, 0o700);
  assert.equal(statSync(w.cfg.stateDir).mode & 0o777, 0o700);
});

test("records: steps are capped, op_status of an unknown id is not_found, and the public record hides the package flag", async () => {
  const w = world();
  assert.equal((await send(w, { action: "op_status", opId: OP3 })).error!.code, "not_found");
  const rec = await setupAll(w);
  assert.ok(rec.steps.length <= 64);
  const pub = (await send(w, { action: "op_status", opId: OP })).data.operation;
  assert.ok(pub.steps.length <= 16);
  assert.equal("pkgRequested" in pub, false);
  assert.equal(pub.state, "verified");
  assert.deepEqual(pub.todo, ["package_bubblewrap", "identity", "storage_scratch", "storage_orbit-validation", "workspaces_file", "service_dropin", "apply"]);
});

test("computePlan is deterministic: the same host gives the same key, and the key covers exactly the todo steps' id and action", async () => {
  const w = world();
  const a = await computePlan(w.env);
  const b = await computePlan(w.env);
  assert.equal(a.planKey, b.planKey);
  const changed = a.steps.map((s) => (s.id === "apply" ? { ...s, detail: "different words" } : s));
  assert.equal(planKeyOf(changed), a.planKey, "details are not part of the key");
  const otherAction = a.steps.map((s) => (s.id === "identity" ? { ...s, action: `${s.action} --uid 0` } : s));
  assert.notEqual(planKeyOf(otherAction), a.planKey);
});

// ---------------------------------------------------------------- ORBIT's client

test("client: strict validation before sending, replies redacted, honest errors when the helper is missing", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ops-ws-sock-")));
  const path = join(dir, "ws.sock");
  const seen: string[] = [];
  const token = part("sk", "-", "A".repeat(30));
  const srv = createServer((s) => {
    s.on("data", (d) => {
      const req = String(d).trim();
      seen.push(req);
      const a = JSON.parse(req).action;
      s.end(`${JSON.stringify(a === "op_status" ? { ok: false, error: { code: "not_found", message: `No operation ${token}` } } : { ok: true, action: a, data: { echo: a, note: token } })}\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(path, r));
  const client = wsHostClient(path, 2000);
  const st = await client.status();
  assert.equal(st.ok, true);
  assert.ok(st.ok && st.data.echo === "ws_status" && !JSON.stringify(st.data).includes(token));
  const setup = await client.call("ws_setup", OP, "d".repeat(24));
  assert.equal(setup.ok, true);
  const os = await client.call("op_status", OP);
  assert.ok(!os.ok && os.code === "not_found" && !os.message.includes(token));
  await assert.rejects(() => client.call("ws_setup", OP), /planKey/);
  await assert.rejects(() => client.call("ws_revoke", OP, "d".repeat(24)), /Unexpected argument/);
  await assert.rejects(() => client.call("op_status", "nope"), /opId/);
  await assert.rejects(() => client.call("shell" as never, OP), /Unknown action/);
  assert.equal(seen.length, 3, "bad calls never leave ORBIT");
  assert.deepEqual(JSON.parse(seen[1]!), { action: "ws_setup", opId: OP, planKey: "d".repeat(24) });
  srv.close();
  await assert.rejects(() => wsHostClient(join(dir, "missing.sock")).status(), /orbit-ops-ws is not available: .*\(not installed\)/);
});

// ---------------------------------------------------------------- units, installers, docs

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("units: socket root:orbit-ops 0660; front read-only with no network; runner limited to localhost/tailnet; only the package unit has network", () => {
  const sock = read("deploy/systemd/orbit-ops-ws.socket");
  for (const re of [/^ListenStream=\/run\/orbit-ops-ws\.sock$/m, /^SocketUser=root$/m, /^SocketGroup=orbit-ops$/m, /^SocketMode=0660$/m, /^Accept=yes$/m, /^MaxConnections=4$/m]) assert.match(sock, re);
  const front = read("deploy/systemd/orbit-ops-ws@.service");
  for (const re of [/^ProtectSystem=strict$/m, /^PrivateNetwork=yes$/m, /^NoNewPrivileges=yes$/m, /^CapabilityBoundingSet=CAP_DAC_READ_SEARCH$/m, /^RestrictAddressFamilies=AF_UNIX$/m, /^StateDirectory=orbit-ops-ws$/m, /ws-helper\.ts$/m]) assert.match(front, re);
  assert.ok(!/^ReadWritePaths=/m.test(front));
  const runner = read("deploy/systemd/orbit-ops-ws-run@.service");
  for (const re of [/^IPAddressDeny=any$/m, /^IPAddressAllow=localhost 100\.64\.0\.0\/10 fd7a:115c:a1e0::\/48$/m, /^ProtectSystem=yes$/m, /^NoNewPrivileges=yes$/m, /ws-run\.ts %i run$/m, /^ReadOnlyPaths=\/opt\/orbit$/m]) assert.match(runner, re);
  assert.ok(!/CAP_SYS_ADMIN|CAP_SETUID|CAP_NET_ADMIN/.test(runner.replace(/#.*$/gm, "")));
  const pkg = read("deploy/systemd/orbit-ops-ws-pkg@.service");
  assert.match(pkg, /ws-run\.ts %i pkg$/m);
  assert.match(pkg, /^SendSIGKILL=no$/m);
  assert.ok(!/IPAddressDeny/.test(pkg));
  // every directive is commented
  for (const f of ["orbit-ops-ws.socket", "orbit-ops-ws@.service", "orbit-ops-ws-run@.service", "orbit-ops-ws-pkg@.service"]) {
    const lines = read(`deploy/systemd/${f}`).split("\n");
    lines.forEach((l, i) => {
      if (!/^[A-Za-z]+=/.test(l) || /^(Description|ExecStart|ListenStream|WantedBy)=/.test(l)) return;
      let j = i - 1;
      while (j >= 0 && /^[A-Za-z]+=/.test(lines[j]!)) j--;
      assert.ok(j >= 0 && lines[j]!.startsWith("#"), `${f}: ${l} is not under a comment`);
    });
  }
});

test("the installer refuses without --approved-by-owner (and with extra arguments) before touching anything", () => {
  for (const args of [[], ["--yes"], ["--approved-by-owner", "--extra"]]) {
    const r = spawnSync("bash", [new URL("../deploy/install-ws.sh", import.meta.url).pathname, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /install-ws: refusing/);
  }
  const i = read("deploy/install-ws.sh");
  const lines = i.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.match(lines[0]!, /^set -euo pipefail$/);
  assert.match(lines[2]!, /--approved-by-owner/, "the refusal is the first real check");
  const code = i.replace(/#.*$/gm, "").split("\n").filter((l) => !/^for f in /.test(l)).join("\n");
  assert.match(code, /ws-protocol\.ts.*ws-core\.ts.*ws-helper\.ts.*ws-run\.ts/s);
  assert.match(code, /systemctl enable orbit-ops-ws\.socket/);
  assert.ok(!/restart orbit\.service|orbit\.env|credstore|useradd|mkfs|fallocate|apt-get (update|upgrade|install)|systemctl start orbit-ops-ws-(run|pkg)|mount /.test(code), "the installer runs no setup");
  for (const f of ["deploy/install.sh", "deploy/install-admin.sh", "deploy/install-sys.sh", "deploy/pull-deploy.sh"]) assert.ok(!/orbit-ops-ws|install-ws|ws-helper/.test(read(f)), f);
  const u = read("deploy/uninstall-ws.sh").split("cat <<'EOF'")[0]!.replace(/#.*$/gm, "");
  assert.ok(!/rm[^\n]*(\.img|orbit-workspaces|60-orbit-workspace|workspaces\.json|\.mount)|userdel|apt-get|\/protocol\.ts|admin-|sys-/.test(u), "uninstall removes only the helper");
  assert.match(read("deploy/uninstall-ws.sh"), /LEFT IN PLACE/);
});

test("docs state the authorization chain honestly and that nothing was run on a live host", () => {
  const d = read("docs/orbit-ops-ws.md");
  assert.match(d, /trust boundary/);
  assert.match(d, /cannot know (that )?the owner clicked/);
  assert.match(d, /Nothing was run on a live host/i);
  assert.match(d, /--approved-by-owner/);
  assert.match(d, /bwrap-userns-restrict/);
  for (const id of ["package_bubblewrap", "identity", "storage_scratch", "storage_orbit-validation", "workspaces_file", "service_dropin", "apply"]) assert.ok(d.includes(id), id);
});

test("no secret-shaped literals in the orbit-ops-ws sources, units, scripts or docs", () => {
  const files = ["src/ops/ws-protocol.ts", "src/ops/ws-core.ts", "src/ops/ws-helper.ts", "src/ops/ws-run.ts", "src/ops-ws-client.ts", "test/ops-ws.test.ts", "deploy/install-ws.sh", "deploy/uninstall-ws.sh", "deploy/systemd/orbit-ops-ws.socket", "deploy/systemd/orbit-ops-ws@.service", "deploy/systemd/orbit-ops-ws-run@.service", "deploy/systemd/orbit-ops-ws-pkg@.service", "docs/orbit-ops-ws.md"];
  const shapes = [
    new RegExp(`${part("s", "k")}-[A-Za-z0-9_-]{12,}`),
    new RegExp(`${part("gh", "[pousr]")}_[A-Za-z0-9]{12,}`),
    new RegExp(`${part("github", "_pat")}_[A-Za-z0-9_]{12,}`),
    new RegExp(`${part("ey", "J")}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`),
    new RegExp(`${part("-----BEGIN", " ")}[A-Z ]*PRIVATE KEY`),
    new RegExp(`${part("AK", "IA")}[0-9A-Z]{12,}`),
    new RegExp(`${part("tsk", "ey")}-[A-Za-z0-9-]{8,}`),
    new RegExp(`(?:${part("pass", "word")}|${part("sec", "ret")}|api[_-]?key)\\s*[=:]\\s*["']?[A-Za-z0-9]{6,}`, "i"),
    /[A-Za-z0-9+/]{40,}={0,2}/,
  ];
  for (const f of files) {
    const text = read(f);
    for (const re of shapes) assert.ok(!re.test(text), `${f} matches ${re.source.slice(0, 30)}`);
  }
});
