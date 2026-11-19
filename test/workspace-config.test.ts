import assert from "node:assert/strict";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { loadActivation, mountOptions, parseConfig, PRE_ACTIVATION_CHECKLIST, WORKSPACE_FILE_ENV, WORKSPACE_FLAG } from "../src/workspace/config.ts";
import { bwrapArgs, CGROUP_WRAPPER, cgroupFiles, CLEAN_ENV, judgeProbe, NPROC_MARGIN, prlimitArgs, SANDBOX_UID } from "../src/workspace/sandbox.ts";
import { selectWorkspace } from "../src/workspace/select.ts";
import { DEFAULT_LIMITS } from "../src/workspace/config.ts";

// Operator configuration and the fixed launcher interface (docs/workspace-tools.md, "Operator setup" and "Exec isolation"). Synthetic
// temporary directories only; nothing here launches a sandbox.

const me = () => process.getuid?.() ?? 0;
const host = (extra: Partial<{ protectedPaths: string[] }> = {}) => ({ uid: me, protectedPaths: extra.protectedPaths ?? [] });
function root(mode = 0o700) {
  const base = mkdtempSync(join(tmpdir(), "orbit-wscfg-"));
  const r = join(base, "ws");
  mkdirSync(r, { mode });
  chmodSync(r, mode);
  return { base, r };
}
const cfg = (o: unknown) => JSON.stringify({ preActivationChecklist: PRE_ACTIVATION_CHECKLIST, ...(o as object) });

test("default off: no flag, no file, or no checklist acknowledgement means no workspace tools; root is refused", () => {
  const { r } = root();
  const file = cfg({ workspaces: [{ id: "scratch", root: r }] });
  assert.equal(loadActivation({}, host()).state, "off");
  assert.equal(loadActivation({ [WORKSPACE_FLAG]: "1" }, host()).state, "off", "only the exact word enables it");
  assert.equal(loadActivation({ [WORKSPACE_FLAG]: "enabled" }, host()).state, "invalid");
  const noAck = loadActivation({ [WORKSPACE_FLAG]: "enabled", [WORKSPACE_FILE_ENV]: "/x" }, host(), () => JSON.stringify({ workspaces: [{ id: "scratch", root: r }] }));
  assert.equal(noAck.state, "not_activated");
  assert.equal(loadActivation({ [WORKSPACE_FLAG]: "enabled", [WORKSPACE_FILE_ENV]: "/x" }, { uid: () => 0, protectedPaths: [] }, () => file).state, "invalid");
  const ok = loadActivation({ [WORKSPACE_FLAG]: "enabled", [WORKSPACE_FILE_ENV]: "/x" }, { uid: () => (me() === 0 ? 0 : me()), protectedPaths: [] }, () => file);
  if (me() !== 0) assert.equal(ok.state, "enabled");
});

test("selectWorkspace with a default environment offers nothing (the production wiring is off unless activated)", () => {
  const w = selectWorkspace({}, { proposals: newProposals(), protectedPaths: [] });
  assert.equal(w.service.enabled, false);
  assert.deepEqual(w.service.tools, []);
  assert.equal(w.sandbox, undefined);
  assert.equal(w.activation.state, "off");
});

test("workspace roots: must be an existing 0700 directory owned by the service user, no symlink, no overlap with protected paths", () => {
  const { base, r } = root();
  assert.equal(parseConfig(cfg({ workspaces: [{ id: "scratch", root: r }] }), host()).workspaces[0]!.id, "scratch");
  const loose = root(0o755);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: loose.r }] }), host()), /0700/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r }] }), { uid: () => me() + 1, protectedPaths: [] }), /owned by the ORBIT service user/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r }] }), host({ protectedPaths: [base] })), /protected/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: "/etc" }] }), host()), /cannot be a workspace root/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: `${r}/../ws` }] }), host()), /normalized absolute/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "Bad Id", root: r }] }), host()), /id must match/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r }, { id: "s", root: r }] }), host()), /used twice/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r, mounts: ["/"] }] }), host()), /unknown key/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r }], sandbox: { env: { A: "1" } } }), host()), /Unknown sandbox key/);
});

test("exec workspaces: need a dedicated bounded mount, trusted root-owned non-setuid binaries, an allowlisted runtime and a delegated cgroup", () => {
  const { base, r } = root();
  // A plain directory is not a dedicated mount: storage could not be bounded.
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r, exec: true }], sandbox: { bwrap: "/bin/sh", prlimit: "/bin/sh", cgroupParent: "/sys/fs/cgroup/x" } }), host()), /dedicated mount/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r, exec: true }], sandbox: { bwrap: "/bin/sh", prlimit: "/bin/sh" } }), host()), /cgroupParent/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r, exec: true }], sandbox: { bwrap: "/bin/sh", prlimit: "/bin/sh", runtime: ["/usr", "/etc"], cgroupParent: "/sys/fs/cgroup/x" } }), host()), /runtime may only name/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r, exec: true }], sandbox: { bwrap: "/bin/sh", prlimit: "/bin/sh", runtime: ["/bin"], cgroupParent: "/sys/fs/cgroup/x" } }), host()), /must include \/usr/);
  const writable = join(base, "bwrap");
  copyFileSync("/bin/sh", writable);
  chmodSync(writable, 0o777);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r, exec: true }], sandbox: { bwrap: writable, prlimit: "/bin/sh", cgroupParent: "/sys/fs/cgroup/x" } }), host()), me() === 0 ? /writable by group or others/ : /not owned by root/);
  if (me() === 0) {
    chmodSync(writable, 0o4755);
    assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r, exec: true }], sandbox: { bwrap: writable, prlimit: "/bin/sh", cgroupParent: "/sys/fs/cgroup/x" } }), host()), /setuid/);
  }
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r }], sandbox: { limits: { timeoutSec: 0 } } }), host()), /timeoutSec/);
  assert.throws(() => parseConfig(cfg({ workspaces: [{ id: "s", root: r }], sandbox: { limits: { network: 1 } } }), host()), /not a known limit/);
});

test("identity binds id, root, inode and the whole sandbox policy: changing any limit changes every workspace identity", () => {
  const { r } = root();
  const a = parseConfig(cfg({ workspaces: [{ id: "s", root: r }] }), host());
  const b = parseConfig(cfg({ workspaces: [{ id: "s", root: r }], sandbox: { limits: { timeoutSec: 30 } } }), host());
  assert.notEqual(a.workspaces[0]!.identity, b.workspaces[0]!.identity);
  assert.equal(a.workspaces[0]!.ino, statSync(r).ino);
});

test("the launcher interface is fixed: model argv only after '--', every isolation flag present, only the workspace is a writable host bind", () => {
  const spec = { runId: "r1", workspace: { id: "s", root: "/srv/ws/s", exec: true, dev: 1, ino: 2, identity: "x" }, cwd: ["sub"], argv: ["--bind", "/", "/host", "--share-net"], script: "echo hi", limits: DEFAULT_LIMITS };
  const sb = { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", shell: "/bin/sh", runtime: ["/usr", "/bin", "/lib64"], cgroupParent: "/sys/fs/cgroup/o", limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 };
  const a = bwrapArgs(sb, spec, "/state/runs/r1", (p) => (p === "/bin" ? { link: "usr/bin" } : p === "/lib64" ? undefined : {}));
  const sep = a.indexOf("--");
  assert.deepEqual(a.slice(sep + 1), spec.argv, "a hostile argv is only the command, after the separator");
  const head = a.slice(0, sep);
  for (const f of ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--die-with-parent", "--new-session", "--clearenv"]) assert.ok(head.includes(f), f);
  assert.ok(!head.includes("--share-net"));
  assert.deepEqual(head.slice(head.indexOf("--cap-drop"), head.indexOf("--cap-drop") + 2), ["--cap-drop", "ALL"]);
  assert.equal(head[head.indexOf("--uid") + 1], String(SANDBOX_UID));
  const binds = head.flatMap((x, i) => (x === "--bind" ? [`${head[i + 1]}->${head[i + 2]}`] : []));
  assert.deepEqual(binds, ["/srv/ws/s->/workspace"], "the workspace is the only writable host bind");
  const ro = head.flatMap((x, i) => (x === "--ro-bind" ? [head[i + 1]] : []));
  assert.deepEqual(ro, ["/usr", "/state/runs/r1/passwd", "/state/runs/r1/group", "/state/runs/r1/script"]);
  assert.ok(head.join(" ").includes("--symlink usr/bin /bin"));
  assert.ok(head.join(" ").includes(`--size ${DEFAULT_LIMITS.tmpBytes} --tmpfs /tmp`));
  assert.ok(head.join(" ").includes("--remount-ro /"));
  assert.equal(head[head.indexOf("--chdir") + 1], "/workspace/sub");
  const env = head.flatMap((x, i) => (x === "--setenv" ? [head[i + 1]] : []));
  assert.deepEqual(env.sort(), Object.keys(CLEAN_ENV).sort());
  assert.ok(prlimitArgs(DEFAULT_LIMITS).includes(`--nproc=${DEFAULT_LIMITS.processes + NPROC_MARGIN}:${DEFAULT_LIMITS.processes + NPROC_MARGIN}`));
  assert.equal(cgroupFiles(DEFAULT_LIMITS)["pids.max"], String(DEFAULT_LIMITS.processes));
  assert.ok(!CGROUP_WRAPPER.includes("${"), "the cgroup wrapper takes only positional arguments");
});

test("probe verdicts: anything short of full isolation is unsupported", () => {
  const good = "uid=1000\nifaces=lo,\nprocs=2\nenv=HOME,LANG,LOGNAME,PATH,PWD,SHLVL,TMPDIR,USER,\nworkspace_writable\n";
  assert.deepEqual(judgeProbe(good, []), []);
  assert.ok(judgeProbe(good.replace("uid=1000", "uid=0"), []).length);
  assert.ok(judgeProbe(good.replace("ifaces=lo,", "ifaces=lo,eth0,"), []).length);
  assert.ok(judgeProbe(good.replace("procs=2", "procs=180"), []).length);
  assert.ok(judgeProbe(`${good}visible=/var/lib/orbit\n`, []).length);
  assert.ok(judgeProbe(good.replace("USER,", "USER,CREDENTIALS_DIRECTORY,"), []).length);
  assert.ok(judgeProbe(`${good}runtime_writable\n`, []).length);
  assert.ok(judgeProbe(good.replace("workspace_writable\n", ""), []).length);
});

test("exec workspace mounts must be nosuid,nodev: the per-mount options are read from the mount table", () => {
  const { base } = root();
  const info = join(base, "mountinfo");
  writeFileSync(info, ["36 25 0:32 / /srv/ws/a rw,nosuid,nodev,relatime shared:1 - tmpfs tmpfs rw,size=1048576k", "37 25 0:33 / /srv/ws/b rw,relatime shared:2 - tmpfs tmpfs rw", "38 25 0:34 / /srv/ws/with\\040space rw,nosuid - tmpfs tmpfs rw"].join("\n"));
  assert.deepEqual(mountOptions("/srv/ws/a", info), ["rw", "nosuid", "nodev", "relatime"]);
  assert.ok(!mountOptions("/srv/ws/b", info)!.includes("nosuid"));
  assert.deepEqual(mountOptions("/srv/ws/with space", info), ["rw", "nosuid"]);
  assert.equal(mountOptions("/srv/ws/none", info), undefined);
});
