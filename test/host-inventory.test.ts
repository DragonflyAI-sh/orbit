// The read-only host inventory (docs/host-inventory.md): helper gate and dispatch, the inventory module against synthetic fixtures
// (generic fictional identities; no live host is probed), the ORBIT chat tool, owner authorization and default-off activation.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { MAX_OUTPUT_CHARS, runChat } from "../src/agent.ts";
import { chatTools } from "../src/chat-tools.ts";
import {
  COMPARED_PROPS,
  HOST_INVENTORY_TOOL,
  MAX_PARTS,
  PART_BUDGET_CHARS,
  SECTIONS,
  classify,
  compareDeclared,
  hostInventoryEnabled,
  hostInventoryTool,
  parseUnitFile,
  partsOf,
  readDeclared,
} from "../src/host-inventory.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import { vaultMemory } from "../src/memory.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { notifier } from "../src/notify.ts";
import { opsClient } from "../src/ops-client.ts";
import { CONFIG_KEYS } from "../src/ops/admin-protocol.ts";
import { INVENTORY_MODULE_PATH, handle, hostInventory, systemEnv } from "../src/ops/helper.ts";
import type { AuditRecord, Env } from "../src/ops/helper.ts";
import { ALL_PROPS, INVENTORY_EXEC_START_BUDGET_MS, INVENTORY_MAX_BYTES, INVENTORY_SCHEMA, MOUNTINFO_MAX_BYTES, SPEC, inventory, mountFor, parseMountinfo, parseShow } from "../src/ops/inventory.ts";
import type { Spec } from "../src/ops/inventory.ts";
import { ACTIONS, INVENTORY_DISABLED_MESSAGE, INVENTORY_MARKER, INVENTORY_UNSUPPORTED_MESSAGE, MAX_RESPONSE_BYTES, parseRequest } from "../src/ops/protocol.ts";
import { decide } from "../src/policy.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";
import { nodes as devicePresence } from "../src/nodes.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Synthetic secrets, assembled at runtime so no credential-shaped literal is in the source (repository secret scan).
const part = (...p: string[]) => p.join("");
const SECRETS = [part("sk", "-", "x".repeat(32)), part("gh", "p_", "y".repeat(36)), part("hunter", "2", "-pass-", "word"), part("ey", "J", "a".repeat(20), ".", "b".repeat(20), ".", "c".repeat(10))];

// ---- a synthetic host: fictional identities (UID 61000, GIDs 990/991, user "alice-example"), fixed repository paths ----

const ORBIT_UID = 61000;
const GID_OPS = 990;
const GID_VAULT = 991;
const ORBIT_PID = 4242;
const SHA = "c".repeat(40);

type FakeStat = { file?: boolean; dir?: boolean; link?: boolean; uid?: number; gid?: number; mode?: number };
const st = (o: FakeStat) => ({
  isFile: () => o.file ?? false,
  isDirectory: () => o.dir ?? false,
  isSymbolicLink: () => o.link ?? false,
  size: 0,
  mtimeMs: 0,
  uid: o.uid ?? 0,
  gid: o.gid ?? 0,
  mode: o.mode ?? 0o755,
});
const dir = (o: FakeStat = {}) => st({ dir: true, ...o });
const file = (o: FakeStat = {}) => st({ file: true, mode: 0o644, ...o });

function baseFs(): Record<string, ReturnType<typeof st>> {
  const fs: Record<string, ReturnType<typeof st>> = {};
  for (const d of ["/opt", "/opt/orbit", "/opt/orbit/releases", "/opt/orbit/repo", "/opt/orbit/state", "/usr", "/usr/local", "/usr/local/lib", "/usr/local/lib/orbit", "/usr/local/lib/orbit/ops", "/run", "/var", "/var/lib", "/etc", "/etc/orbit-ops"]) fs[d] = dir();
  fs["/opt/orbit/vault"] = dir({ gid: GID_VAULT, mode: 0o750 });
  fs["/opt/orbit/current"] = st({ link: true, mode: 0o777 });
  fs["/var/lib/orbit"] = st({ link: true, mode: 0o777 });
  fs["/var/lib/private"] = dir({ mode: 0o700 });
  fs["/var/lib/private/orbit"] = dir({ uid: ORBIT_UID, gid: ORBIT_UID, mode: 0o700 });
  for (const f of SPEC.helperFiles) fs[f] = file({ mode: f.endsWith(".sh") ? 0o755 : 0o644 });
  for (const s of SPEC.sockets) fs[s.path] = st({ gid: GID_OPS, mode: 0o140660 });
  fs[INVENTORY_MARKER] = file({ mode: 0o600 });
  fs[INVENTORY_MODULE_PATH] = file();
  fs[dirname(INVENTORY_MODULE_PATH)] = dir();
  return fs;
}

const block = (unit: string, props: Record<string, string>) => [`Id=${unit}`, ...Object.entries(props).map(([k, v]) => `${k}=${v}`)].join("\n");
function showOutput(over: Record<string, Record<string, string>> = {}): string {
  const blocks: string[] = [];
  for (const unit of SPEC.services) {
    const running = unit === "orbit.service";
    const base: Record<string, string> = {
      LoadState: "loaded",
      ActiveState: running ? "active" : "inactive",
      SubState: running ? "running" : "dead",
      User: "",
      Group: "",
      DynamicUser: running ? "yes" : "no",
      SupplementaryGroups: running ? "orbit-vault orbit-ops" : "",
      UID: running ? String(ORBIT_UID) : "[not set]",
      GID: running ? String(ORBIT_UID) : "[not set]",
      MainPID: running ? String(ORBIT_PID) : "0",
      ProtectSystem: "strict",
      ProtectHome: "yes",
      PrivateTmp: "yes",
      PrivateDevices: "no",
      PrivateNetwork: "no",
      NoNewPrivileges: "yes",
      RestrictSUIDSGID: "no",
      CapabilityBoundingSet: unit === "orbit-ops@.service" ? "cap_dac_read_search" : "cap_chown cap_dac_override",
      AmbientCapabilities: "",
      RestrictAddressFamilies: "",
      ReadWritePaths: running ? "/run/tailscale" : "",
      ReadOnlyPaths: "",
      StateDirectory: running ? "orbit" : "",
      // Never requested; a hostile or confused systemctl that prints them anyway must not get them through.
      Environment: `TOKEN=${SECRETS[0]}`,
      ExecStart: `{ path=/usr/local/bin/node ; argv[]=/usr/local/bin/node --key ${SECRETS[1]} }`,
    };
    blocks.push(block(unit, { ...base, ...over[unit] }));
  }
  for (const s of SPEC.sockets) blocks.push(block(s.unit, { LoadState: "loaded", ActiveState: "active", SocketUser: "root", SocketGroup: "orbit-ops", SocketMode: "0660", Accept: "yes", MaxConnections: "8", ...over[s.unit] }));
  return `${blocks.join("\n\n")}\n`;
}

const HOST_MOUNTS = [
  "22 1 252:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw,errors=remount-ro",
  "40 22 0:44 / /opt/orbit/vault rw,nosuid,nodev,relatime shared:9 - nfs4 fileserver.example:/export/private rw",
].join("\n");
const ORBIT_MOUNTS = [
  "300 299 252:1 / / ro,nosuid,nodev,relatime - ext4 /dev/vda1 rw",
  "301 300 252:1 /var/lib/private/orbit /var/lib/private/orbit rw,nosuid,nodev,relatime - ext4 /dev/vda1 rw",
  "302 300 0:44 / /opt/orbit/vault ro,nosuid,nodev,relatime - nfs4 fileserver.example:/export/private rw",
].join("\n");
const GROUPS = ["root:x:0:", `orbit-ops:x:${GID_OPS}:`, `orbit-vault:x:${GID_VAULT}:alice-example,bob-example`, `unrelated:x:5000:${SECRETS[2]}`].join("\n");

type Calls = { exec: [string, string[]][]; read: string[]; lstat: string[]; readlink: string[]; other: string[] };
function fakeEnv(o: { fs?: Record<string, ReturnType<typeof st> | undefined>; show?: string; exec?: Env["exec"]; files?: Record<string, string | undefined>; links?: Record<string, string> } = {}) {
  const calls: Calls = { exec: [], read: [], lstat: [], readlink: [], other: [] };
  const fs = { ...baseFs(), ...o.fs };
  const files: Record<string, string | undefined> = { "/etc/group": GROUPS, "/proc/1/mountinfo": HOST_MOUNTS, [`/proc/${ORBIT_PID}/mountinfo`]: ORBIT_MOUNTS, ...o.files };
  const links: Record<string, string> = { "/opt/orbit/current": `/opt/orbit/releases/${SHA}`, "/var/lib/orbit": "private/orbit", ...o.links };
  const env: Env = {
    exec: async (f, args) => {
      calls.exec.push([f, args]);
      if (o.exec) return o.exec(f, args);
      if (args.includes("--property=MainPID")) return { code: 0, stdout: `MainPID=${ORBIT_PID}\n`, stderr: "", timedOut: false };
      return { code: 0, stdout: o.show ?? showOutput(), stderr: "", timedOut: false };
    },
    localApi: async () => (calls.other.push("localApi"), {}),
    readSmall: (p, max) => (calls.read.push(p), files[p]?.slice(0, max)),
    lstat: (p) => (calls.lstat.push(p), fs[p]),
    readdir: (p) => (calls.other.push(`readdir ${p}`), undefined),
    readlink: (p) => (calls.readlink.push(p), links[p]),
    statfs: () => (calls.other.push("statfs"), undefined),
    host: () => (calls.other.push("host"), { totalMem: 0, freeMem: 0, load: [0, 0, 0], uptimeSeconds: 0 }),
    now: () => NOW,
  };
  return { env, calls };
}

const ask = async (raw: object | string, env: Env) => {
  const audit: AuditRecord[] = [];
  const out = await handle(typeof raw === "string" ? raw : JSON.stringify(raw), env, (r) => audit.push(r));
  return { res: JSON.parse(out) as { ok: boolean; action?: string; data?: any; error?: { code: string; message: string } }, raw: out, audit };
};
const inv = async (env: Env, opts = {}) => (await inventory(env, opts)) as { schema: string; observedAt: string; sections: Record<string, any>; notObserved: string[] };

// ================================================================ protocol: one fixed action, no arguments

test("host_inventory is one more fixed action; it takes no argument of any kind, and injection in the action name is an unknown action", async () => {
  assert.ok((ACTIONS as readonly string[]).includes("host_inventory"));
  assert.deepEqual(parseRequest('{"action":"host_inventory"}'), { action: "host_inventory" });
  const { env, calls } = fakeEnv();
  for (const key of ["path", "paths", "unit", "units", "command", "cmd", "args", "argv", "env", "environment", "shell", "section", "part", "lines", "root", "glob", "__proto__"]) {
    for (const value of ["/etc/shadow", "../../etc", "$(id)", "`id`", "; rm -rf /", ["/etc"], { a: 1 }, 1]) {
      const { res, audit } = await ask(JSON.stringify({ action: "host_inventory", [key]: value }), env);
      assert.equal(res.ok, false, `${key}`);
      assert.equal(res.error!.code, "bad_arguments", `${key}`);
      assert.equal(audit[0]!.outcome, "rejected");
    }
  }
  for (const action of ["host_inventory; id", "host_inventory && cat /etc/shadow", "host_inventory\n", "HOST_INVENTORY", "host-inventory", "host_inventory "]) {
    assert.equal((await ask({ action }, env)).res.error!.code, "unknown_action", JSON.stringify(action));
  }
  assert.deepEqual(calls.exec, [], "no refused request ran anything");
  assert.deepEqual(calls.read, []);
});

// ================================================================ activation: off by default, root-controlled, no fallback

test("default off: without the activation marker the helper answers `disabled` and nothing is inspected", async () => {
  const { env, calls } = fakeEnv({ fs: { [INVENTORY_MARKER]: undefined } });
  const { res, audit } = await ask({ action: "host_inventory" }, env);
  assert.deepEqual([res.ok, res.error!.code, res.error!.message], [false, "disabled", INVENTORY_DISABLED_MESSAGE]);
  assert.deepEqual([audit[0]!.action, audit[0]!.outcome, audit[0]!.code], ["host_inventory", "rejected", "disabled"]);
  assert.deepEqual(calls.exec, []);
  assert.deepEqual(calls.read, []);
  assert.deepEqual(calls.lstat, ["/etc/orbit-ops", INVENTORY_MARKER], "only the marker and its directory were looked at");
});

test("an unsafe marker is no marker: symlink, wrong owner, group/world writable, not a file, or an unsafe directory", async () => {
  const cases: Record<string, ReturnType<typeof st> | undefined>[] = [
    { [INVENTORY_MARKER]: st({ link: true }) },
    { [INVENTORY_MARKER]: file({ uid: 1000 }) },
    { [INVENTORY_MARKER]: file({ mode: 0o620 }) },
    { [INVENTORY_MARKER]: file({ mode: 0o602 }) },
    { [INVENTORY_MARKER]: dir() },
    { "/etc/orbit-ops": st({ link: true }) },
    { "/etc/orbit-ops": dir({ uid: 1000 }) },
    { "/etc/orbit-ops": dir({ mode: 0o777 }) },
    { "/etc/orbit-ops": undefined },
  ];
  for (const fs of cases) {
    const { env, calls } = fakeEnv({ fs });
    const { res } = await ask({ action: "host_inventory" }, env);
    assert.equal(res.error?.code, "disabled", JSON.stringify(Object.keys(fs)));
    assert.deepEqual(calls.exec, []);
  }
});

test("a missing, unsafe or broken inventory module is `unsupported`; nothing else is tried", async () => {
  const unsafe: Record<string, ReturnType<typeof st> | undefined>[] = [
    { [INVENTORY_MODULE_PATH]: undefined },
    { [INVENTORY_MODULE_PATH]: file({ uid: 1000 }) },
    { [INVENTORY_MODULE_PATH]: file({ mode: 0o666 }) },
    { [INVENTORY_MODULE_PATH]: st({ link: true }) },
    { [dirname(INVENTORY_MODULE_PATH)]: dir({ mode: 0o777 }) },
  ];
  for (const fs of unsafe) {
    const { env, calls } = fakeEnv({ fs });
    const { res } = await ask({ action: "host_inventory" }, env);
    assert.deepEqual([res.error?.code, res.error?.message], ["unsupported", INVENTORY_UNSUPPORTED_MESSAGE]);
    assert.deepEqual(calls.exec, []);
  }
  const { env, calls } = fakeEnv();
  await assert.rejects(hostInventory(env, async () => { throw new Error("Cannot find module"); }), (e: Error & { code?: string }) => e.code === "unsupported");
  await assert.rejects(hostInventory(env, async () => ({}) as never), (e: Error & { code?: string }) => e.code === "unsupported");
  assert.deepEqual(calls.exec, []);
});

test("activated (marker and module present and root-owned), the helper dispatches to the module and answers within the response bound", async () => {
  const { env, calls } = fakeEnv();
  const { res, raw, audit } = await ask({ action: "host_inventory" }, env);
  assert.equal(res.ok, true, raw.slice(0, 300));
  assert.equal(res.data.schema, INVENTORY_SCHEMA);
  assert.ok(Buffer.byteLength(raw) <= MAX_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(res.data)) <= INVENTORY_MAX_BYTES);
  assert.deepEqual([audit[0]!.action, audit[0]!.outcome], ["host_inventory", "ok"]);
  assert.ok(!JSON.stringify(audit).includes("orbit-ops@"), "the audit line carries no response data");
  assert.ok(calls.exec.every(([f]) => f === "/usr/bin/systemctl"));
});

test("nothing in the repository's deploy path installs the module or creates the marker; ORBIT's flag is off unless exactly 'enabled'", () => {
  const deployFiles = readdirSync(new URL("../deploy/", import.meta.url), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
  for (const f of deployFiles) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("inventory.ts"), `${f} installs the inventory module`);
    assert.ok(!text.includes("host-inventory.enabled") && !text.includes("/etc/orbit-ops"), `${f} touches the activation marker`);
    assert.ok(!text.includes("ORBIT_HOST_INVENTORY"), `${f} sets the ORBIT flag`);
  }
  assert.match(read("deploy/install.sh"), /install -m 644 -o root -g root "\$src"\/\.\.\/src\/ops\/helper\.ts "\$src"\/\.\.\/src\/ops\/protocol\.ts \/usr\/local\/lib\/orbit\/ops\//);
  assert.ok(!(CONFIG_KEYS as readonly string[]).includes("ORBIT_HOST_INVENTORY"), "the tier 2 config proposal cannot switch it on");
  for (const v of [undefined, "", "1", "true", "yes", "on", "Enabled", "enabled "]) assert.equal(hostInventoryEnabled({ ORBIT_HOST_INVENTORY: v }), false, String(v));
  assert.equal(hostInventoryEnabled({ ORBIT_HOST_INVENTORY: "enabled" }), true);
  assert.match(read("src/main.ts"), /hostInventory: hostInventoryEnabled\(process\.env\) \? \[hostInventoryTool\(\{ ops \}\)\] : undefined/);
});

// ================================================================ the inventory: fixed queries, structured evidence

test("every section carries origin, source, observation time, completeness, reasons and warnings", async () => {
  const { env } = fakeEnv();
  const r = await inv(env);
  assert.deepEqual(Object.keys(r.sections), ["serviceIdentities", "groups", "sandbox", "helperBoundaries", "paths", "mounts", "deploymentSeparation"]);
  for (const [name, s] of Object.entries(r.sections)) {
    assert.ok(["systemd-loaded", "host-observed", "derived"].includes(s.origin), name);
    assert.equal(typeof s.source, "string");
    assert.equal(s.observedAt, NOW.toISOString());
    assert.equal(typeof s.complete, "boolean");
    assert.ok(Array.isArray(s.unavailable) && Array.isArray(s.warnings) && Array.isArray(s.items), name);
  }
  assert.match(r.sections.sandbox.warnings.join(" "), /Configured, not verified/);
  assert.ok(r.notObserved.some((n) => /OpenClaw/.test(n)));
  assert.ok(r.notObserved.some((n) => /ACLs/.test(n)));
});

test("fixed queries only: one systemctl show with the fixed units and properties (plus a MainPID recheck), and only fixed paths", async () => {
  const { env, calls } = fakeEnv();
  await inv(env);
  assert.deepEqual(calls.exec, [
    ["/usr/bin/systemctl", ["show", ...SPEC.services, ...SPEC.sockets.map((s) => s.unit), "--no-pager", `--property=${ALL_PROPS.join(",")}`]],
    ["/usr/bin/systemctl", ["show", "orbit.service", "--no-pager", "--property=MainPID"]],
  ]);
  assert.ok(!ALL_PROPS.some((p) => /Environment|Exec|Credential|LoadCredential|SetCredential|PassEnvironment|ControlGroup|Fragment/.test(p)));
  assert.deepEqual(calls.read.sort(), ["/etc/group", "/proc/1/mountinfo", `/proc/${ORBIT_PID}/mountinfo`].sort());
  const allowed = new Set<string>();
  for (const p of [...SPEC.paths, ...SPEC.helperFiles, ...SPEC.sockets.map((s) => s.path)]) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) allowed.add(`/${parts.slice(0, i).join("/")}`);
  }
  for (const p of calls.lstat) assert.ok(allowed.has(p), `lstat outside the fixed list: ${p}`);
  assert.deepEqual(calls.readlink.sort(), ["/opt/orbit/current", "/var/lib/orbit"], "readlink only on final fixed symlinks, never to follow them");
  assert.deepEqual(calls.other, [], "no listing, statfs, tailscaled or host query");
});

test("identities, groups, sandbox, sockets and paths come out as allowlisted, shape-checked fields", async () => {
  const { env } = fakeEnv();
  const r = await inv(env);
  const orbit = r.sections.serviceIdentities.items.find((x: any) => x.unit === "orbit.service");
  assert.deepEqual(orbit, { unit: "orbit.service", LoadState: "loaded", ActiveState: "active", SubState: "running", User: "", Group: "", DynamicUser: "yes", SupplementaryGroups: ["orbit-vault", "orbit-ops"], UID: ORBIT_UID, GID: ORBIT_UID });
  const tmpl = r.sections.serviceIdentities.items.find((x: any) => x.unit === "orbit-ops@.service");
  assert.deepEqual([tmpl.UID, tmpl.GID], [null, null], "a unit that is not running has no observed UID/GID");
  assert.deepEqual(r.sections.groups.items, [{ group: "orbit-ops", gid: GID_OPS, explicitMembers: 0 }, { group: "orbit-vault", gid: GID_VAULT, explicitMembers: 2 }]);
  const sb = r.sections.sandbox.items.find((x: any) => x.unit === "orbit-ops@.service");
  assert.deepEqual(sb.CapabilityBoundingSet, ["cap_dac_read_search"]);
  assert.equal(sb.ProtectSystem, "strict");
  const sock = r.sections.helperBoundaries.items.find((x: any) => x.unit === "orbit-ops.socket");
  assert.deepEqual(sock.unitSettings, { LoadState: "loaded", ActiveState: "active", SocketUser: "root", SocketGroup: "orbit-ops", SocketMode: "0660", Accept: "yes", MaxConnections: 8 });
  assert.deepEqual(sock.file, { path: "/run/orbit-ops.sock", state: "present", type: "socket", uid: 0, gid: GID_OPS, mode: "0660" });
  const vault = r.sections.paths.items.find((x: any) => x.path === "/opt/orbit/vault");
  assert.deepEqual(vault, { path: "/opt/orbit/vault", state: "present", type: "directory", uid: 0, gid: GID_VAULT, mode: "0750" });
  assert.equal(r.sections.paths.items.find((x: any) => x.path === "/opt/orbit/current").linkTarget, `/opt/orbit/releases/${SHA}`);
  assert.equal(r.sections.paths.complete, true);
});

test("secrets, environment, process arguments, group members, device and source names never reach the answer", async () => {
  const show = showOutput({ "orbit.service": { User: SECRETS[0]!, SupplementaryGroups: `orbit-ops ${SECRETS[1]}`, ReadWritePaths: `/run/tailscale /x/${SECRETS[3]}`, ProtectSystem: `strict ${SECRETS[2]}` } });
  const { env } = fakeEnv({ show });
  const { res, raw, audit } = await ask({ action: "host_inventory" }, env);
  assert.equal(res.ok, true);
  for (const s of SECRETS) assert.ok(!raw.includes(s) && !JSON.stringify(audit).includes(s), "a synthetic secret leaked");
  for (const s of ["TOKEN=", "argv", "--key", "alice-example", "bob-example", "/dev/vda1", "fileserver.example", "/export/private", "unrelated"]) assert.ok(!raw.includes(s), `leaked: ${s}`);
  const orbit = res.data.sections.serviceIdentities.items.find((x: any) => x.unit === "orbit.service");
  assert.equal(orbit.User, "[unrecognised]");
  assert.equal(orbit.SupplementaryGroups, "[unrecognised]");
  assert.match(res.data.sections.serviceIdentities.warnings.join(" "), /orbit\.service: User, SupplementaryGroups had a value outside the accepted shape/);
});

test("symlinks are never followed: a symlinked ancestor denies the path (fail closed); an unapproved final target is not reported", async () => {
  const { env, calls } = fakeEnv({ fs: { "/opt/orbit": st({ link: true }) }, links: { "/opt/orbit/current": "/etc/shadow", "/var/lib/orbit": "../../root/.ssh" } });
  const r = await inv(env);
  for (const p of ["/opt/orbit/releases", "/opt/orbit/repo", "/opt/orbit/vault", "/opt/orbit/state", "/opt/orbit/current"]) {
    const f = r.sections.paths.items.find((x: any) => x.path === p);
    assert.equal(f.state, "denied", p);
    assert.match(f.reason, /ancestor \/opt\/orbit is a symlink; not followed/);
  }
  assert.equal(r.sections.paths.complete, false);
  assert.ok(r.sections.paths.unavailable.some((u: string) => u.startsWith("/opt/orbit/releases:")));
  assert.equal(r.sections.paths.items.find((x: any) => x.path === "/opt/orbit").type, "symlink");
  assert.match(r.sections.paths.items.find((x: any) => x.path === "/var/lib/orbit").linkTarget, /not reported/);
  assert.ok(!JSON.stringify(r).includes(".ssh"));
  assert.equal(calls.readlink.filter((p) => p === "/opt/orbit").length, 1, "resolved once as its own entry (not reported), never as an ancestor of the others");
  const sep = r.sections.deploymentSeparation.items.find((x: any) => x.path === "/opt/orbit/releases");
  assert.notEqual(sep.orbitServiceWrite, "not-writable-by-mode", "a denied path is never a pass by mode");
});

test("symlink escapes on a real filesystem: lstat-only resolution denies the escape and reads nothing behind it", async () => {
  const base = mkdtempSync(join(tmpdir(), "inv-real-"));
  try {
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), SECRETS[0]!);
    mkdirSync(join(base, "root"));
    symlinkSync(outside, join(base, "root", "escape"));
    symlinkSync(join(outside, "secret.txt"), join(base, "root", "leaf"));
    mkdirSync(join(base, "root", "plain"));
    const spec: Spec = { ...SPEC, services: [], sockets: [], helperFiles: [], separation: [], paths: [join(base, "root", "escape", "secret.txt"), join(base, "root", "leaf"), join(base, "root", "plain"), `${join(base, "root")}/../outside`], linkTargets: {} };
    const env: Env = { ...systemEnv, exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), readSmall: () => undefined, now: () => NOW };
    const r = await inv(env, { spec });
    const [escape, leaf, plain, dotdot] = r.sections.paths.items;
    assert.equal(escape.state, "denied");
    assert.match(escape.reason, /is a symlink; not followed/);
    assert.deepEqual([leaf.state, leaf.type], ["present", "symlink"]);
    assert.match(leaf.linkTarget, /not reported/);
    assert.deepEqual([plain.state, plain.type], ["present", "directory"]);
    assert.deepEqual([dotdot.state, dotdot.reason], ["denied", "not a canonical absolute path"]);
    assert.ok(!JSON.stringify(r).includes(SECRETS[0]!));
    assert.ok(!JSON.stringify(r).includes("secret.txt\",\"state\":\"present"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mounts: only entries holding a fixed path, in the host's and the ORBIT service's namespaces, flags and an allowlisted fstype only", async () => {
  const { env } = fakeEnv();
  const r = await inv(env);
  const rel = r.sections.mounts.items.find((x: any) => x.path === "/opt/orbit/releases");
  assert.deepEqual(rel.host, { mountPoint: "/", readOnly: false, nosuid: false, nodev: false, noexec: false, fstype: "ext4" });
  assert.deepEqual(rel.orbitService, { mountPoint: "/", readOnly: true, nosuid: true, nodev: true, noexec: false, fstype: "ext4" });
  const vault = r.sections.mounts.items.find((x: any) => x.path === "/opt/orbit/vault");
  assert.equal(vault.host.mountPoint, "/opt/orbit/vault");
  assert.equal(vault.host.fstype, "nfs4");
  const st8 = r.sections.mounts.items.find((x: any) => x.path === "/var/lib/private/orbit");
  assert.equal(st8.orbitService.readOnly, false);
  assert.equal(r.sections.mounts.complete, true);
  // Parser edges: escaped spaces, stacked mounts (last wins), prefix that is not a component ancestor.
  const ms = parseMountinfo(["1 0 0:1 / / rw - ext4 a rw", "2 1 0:2 / /opt/or rw - tmpfs b rw", "3 1 0:3 / /opt/my\\040dir ro - weirdfs c rw", "4 1 0:4 / /opt/my\\040dir rw - tmpfs d rw", "garbage"].join("\n"));
  assert.equal(mountFor(ms, "/opt/orbit")!.mountPoint, "/", "/opt/or is not an ancestor of /opt/orbit");
  assert.deepEqual([mountFor(ms, "/opt/my dir/x")!.mountPoint, mountFor(ms, "/opt/my dir/x")!.readOnly], ["/opt/my dir", false]);
  assert.equal(ms[2]!.fstype, "other");
});

test("deployment separation is derived, names its inputs, and missing evidence is never a pass", async () => {
  const { env } = fakeEnv();
  const r = await inv(env);
  const v = Object.fromEntries(r.sections.deploymentSeparation.items.map((x: any) => [x.path, x.orbitServiceWrite]));
  assert.equal(v["/opt/orbit/releases"], "read-only-mount-observed");
  assert.equal(r.sections.deploymentSeparation.origin, "derived");
  const one = r.sections.deploymentSeparation.items[1];
  assert.deepEqual(Object.keys(one.inputs), ["pathState", "orbitMountReadOnly", "writableByMode", "unitsDeclaringWriteAccess"]);

  // A writable mount in ORBIT's namespace: the verdict falls back to owner/mode, and says which.
  const rw = fakeEnv({ files: { [`/proc/${ORBIT_PID}/mountinfo`]: "300 299 252:1 / / rw - ext4 /dev/vda1 rw" } });
  const r2 = await inv(rw.env);
  assert.equal(r2.sections.deploymentSeparation.items.find((x: any) => x.path === "/opt/orbit/releases").orbitServiceWrite, "not-writable-by-mode");
  const ww = fakeEnv({ files: { [`/proc/${ORBIT_PID}/mountinfo`]: "300 299 252:1 / / rw - ext4 /dev/vda1 rw" }, fs: { "/opt/orbit/repo": dir({ mode: 0o777 }), "/opt/orbit/releases": dir({ gid: GID_OPS, mode: 0o775 }) } });
  const r3 = await inv(ww.env);
  const v3 = Object.fromEntries(r3.sections.deploymentSeparation.items.map((x: any) => [x.path, x.orbitServiceWrite]));
  assert.equal(v3["/opt/orbit/repo"], "writable-by-mode");
  assert.equal(v3["/opt/orbit/releases"], "writable-by-mode", "group write through a supplementary group counts");

  // ORBIT not running: no UID, no mount view, so nothing can be established; the section is incomplete, not passed.
  const down = fakeEnv({ show: showOutput({ "orbit.service": { ActiveState: "inactive", SubState: "dead", UID: "[not set]", GID: "[not set]", MainPID: "0" } }) });
  const r4 = await inv(down.env);
  assert.ok(r4.sections.deploymentSeparation.items.every((x: any) => x.orbitServiceWrite === "not-established"));
  assert.equal(r4.sections.deploymentSeparation.complete, false);
  assert.equal(r4.sections.mounts.complete, false);
  assert.match(r4.sections.mounts.unavailable.join(" "), /not running/);
  assert.ok(r4.sections.mounts.items.every((x: any) => x.orbitService.state === "unavailable"));
});

// ================================================================ missing services, permissions, sections; bounds and timeouts

test("systemctl failing or timing out, missing units, unreadable /etc/group and mount tables are each reported, never guessed", async () => {
  const failed = await inv(fakeEnv({ exec: async () => ({ code: 1, stdout: "", stderr: "Access denied", timedOut: false }) }).env);
  for (const n of ["serviceIdentities", "sandbox"]) {
    assert.equal(failed.sections[n].complete, false);
    assert.deepEqual(failed.sections[n].unavailable, ["systemctl could not report these units"]);
    assert.deepEqual(failed.sections[n].items, []);
  }
  assert.equal(failed.sections.helperBoundaries.complete, false);
  assert.ok(!JSON.stringify(failed).includes("Access denied"), "stderr is never passed through");

  const partialErr = showOutput().split("\n\n").filter((b) => !b.startsWith("Id=orbit-ops-sys-recover.service")).join("\n\n");
  const errButSome = await inv(fakeEnv({ exec: async (_f, args) => ({ code: 1, stdout: args.includes("--property=MainPID") ? `MainPID=${ORBIT_PID}\n` : partialErr, stderr: "Unit name is not valid", timedOut: false }) }).env);
  assert.equal(errButSome.sections.serviceIdentities.complete, false);
  assert.match(errButSome.sections.serviceIdentities.warnings.join(" "), /systemctl exited with an error/);
  assert.equal(errButSome.sections.serviceIdentities.items.find((x: any) => x.unit === "orbit.service").UID, ORBIT_UID);
  assert.equal(errButSome.sections.serviceIdentities.items.find((x: any) => x.unit === "orbit-ops-sys-recover.service").state, "unavailable");
  assert.ok(!JSON.stringify(errButSome).includes("not valid"));

  const timedOut = await inv(fakeEnv({ exec: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) }).env);
  assert.deepEqual(timedOut.sections.serviceIdentities.unavailable, ["systemctl timed out"]);

  const partial = showOutput().split("\n\n").filter((b) => !b.startsWith("Id=orbit-deploy.service")).join("\n\n");
  const missing = await inv(fakeEnv({ show: partial }).env);
  assert.deepEqual(missing.sections.serviceIdentities.items.find((x: any) => x.unit === "orbit-deploy.service"), { unit: "orbit-deploy.service", state: "unavailable", reason: "not in systemctl's answer" });
  assert.equal(missing.sections.serviceIdentities.complete, false);

  const notFound = await inv(fakeEnv({ show: showOutput({ "orbit-deploy.service": { LoadState: "not-found" } }) }).env);
  assert.match(notFound.sections.serviceIdentities.warnings.join(" "), /orbit-deploy\.service: LoadState is not-found/);

  const unread = await inv(fakeEnv({ files: { "/etc/group": undefined, "/proc/1/mountinfo": undefined, [`/proc/${ORBIT_PID}/mountinfo`]: undefined } }).env);
  assert.deepEqual([unread.sections.groups.complete, unread.sections.groups.unavailable], [false, ["/etc/group could not be read"]]);
  assert.equal(unread.sections.mounts.complete, false);
  assert.equal(unread.sections.mounts.unavailable.length, 2);
  assert.ok(unread.sections.deploymentSeparation.items.every((x: any) => x.orbitServiceWrite !== "read-only-mount-observed"));

  const noSock = await inv(fakeEnv({ fs: { "/run/orbit-ops-sys.sock": undefined } }).env);
  assert.equal(noSock.sections.helperBoundaries.complete, false);
  assert.equal(noSock.sections.helperBoundaries.items.find((x: any) => x.unit === "orbit-ops-sys.socket").file.state, "missing");
});

test("a reused PID is caught: if orbit.service's main PID changes during the read, its mount view is dropped", async () => {
  let n = 0;
  const { env } = fakeEnv({ exec: async (_f, args) => ({ code: 0, stdout: args.includes("--property=MainPID") ? `MainPID=${ORBIT_PID + 1}\n` : showOutput(), stderr: "", timedOut: false }) });
  const r = await inv(env);
  n = r.sections.mounts.items.filter((x: any) => x.orbitService.state === "unavailable").length;
  assert.equal(n, SPEC.paths.length);
  assert.match(r.sections.mounts.unavailable.join(" "), /main PID changed/);
});

test("bounded: no subprocess starts after the time budget, oversized inputs are capped, and the answer is cut by whole sections", async () => {
  let t = 0;
  const slow = fakeEnv({ exec: async (_f, args) => ((t += INVENTORY_EXEC_START_BUDGET_MS + 1), { code: 0, stdout: args.includes("--property=MainPID") ? `MainPID=${ORBIT_PID}\n` : showOutput(), stderr: "", timedOut: false }) });
  const r = await inv(slow.env, { clock: () => t });
  assert.equal(slow.calls.exec.length, 1, "the recheck was not started after the budget");
  assert.match(r.sections.mounts.unavailable.join(" "), /time budget/);

  const bigMounts = `${ORBIT_MOUNTS}\n${"9 9 0:9 / /x rw - tmpfs t rw\n".repeat(MOUNTINFO_MAX_BYTES / 20)}`;
  const big = await inv(fakeEnv({ files: { "/proc/1/mountinfo": bigMounts } }).env);
  assert.equal(big.sections.mounts.complete, false);
  assert.match(big.sections.mounts.warnings.join(" "), /larger than/);

  const huge = `${showOutput()}\n\n${"Id=junk.service\nUser=x\n\n".repeat(80_000)}`;
  const capped = await inv(fakeEnv({ show: huge }).env);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= INVENTORY_MAX_BYTES);

  const small = await inv(fakeEnv().env, { maxBytes: 6000 });
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 6000);
  assert.equal(small.sections.helperBoundaries.complete, false);
  assert.match(small.sections.helperBoundaries.unavailable[0], /output bound/);
  assert.deepEqual(small.sections.helperBoundaries.items, []);
});

test("parseShow keeps only requested properties of requested units, first value wins", () => {
  const m = parseShow("Id=orbit.service\nUser=a\nUser=b\nEnvironment=X=1\n\nId=other.service\nUser=c\n", ["orbit.service"]);
  assert.deepEqual([...m.keys()], ["orbit.service"]);
  assert.deepEqual(m.get("orbit.service"), { Id: "orbit.service", User: "a" });
});

// ================================================================ no write or mutation path, no generic access

test("the inventory module has no write, exec or open path of its own; the helper still never uses a shell", () => {
  const src = read("src/ops/inventory.ts");
  assert.ok(!/from "node:(fs|child_process|net|http|https|dgram|worker_threads|vm)"/.test(src), "imports no I/O module: everything goes through the helper's Env");
  assert.ok(!/\b(writeFile|appendFile|mkdir|rmdir|unlink|rename|chmod|chown|truncate|symlink|copyFile|spawn|execFile|fork|eval|Function|open|openSync)\s*\(/.test(src));
  assert.ok(!/env\.(localApi|readdir|statfs|host)\b/.test(src), "no directory listing, tailscaled or host query");
  assert.deepEqual([...src.matchAll(/env\.exec\(([^,]+),/g)].map((m) => m[1]), ["SYSTEMCTL", "SYSTEMCTL"]);
  assert.match(src, /const SYSTEMCTL = "\/usr\/bin\/systemctl";/);
  const helper = read("src/ops/helper.ts");
  assert.ok(helper.includes("shell: false"));
  assert.ok(!/\bexecSync\b|\bspawnSync\b|\beval\(|new Function/.test(helper));
  assert.match(helper, /import\("\.\/inventory\.ts"\)/, "the module path is a fixed literal");
  const tool = read("src/host-inventory.ts");
  assert.ok(!/\b(writeFile|appendFile|mkdir|unlink|rename|chmod|chown|spawn|execFile|exec\()/.test(tool));
  assert.match(tool, /d\.ops\.call\("host_inventory"\)/, "the tool sends no arguments to the helper");
});

// ================================================================ the ORBIT chat tool

const fakeOps = (value: unknown | ((n: number) => unknown), fail?: Error) => {
  const seen: [string, unknown][] = [];
  let n = 0;
  return {
    seen,
    ops: {
      call: async (a: string, args?: Record<string, unknown>) => {
        seen.push([a, args]);
        if (fail) throw fail;
        return { value: typeof value === "function" ? (value as (n: number) => unknown)(n++) : value, provenance: "live" as const, source: `ops/${a}` };
      },
    } as never,
  };
};
const realInventory = async () => (await ask({ action: "host_inventory" }, fakeEnv().env)).res.data;

test("tool schema: two optional selectors only, both closed sets; anything else is refused before the helper is asked", async () => {
  const { ops, seen } = fakeOps(await realInventory());
  const t = hostInventoryTool({ ops });
  assert.equal(t.name, HOST_INVENTORY_TOOL);
  assert.equal(t.readOnly, true);
  const p = t.parameters as { properties: Record<string, any>; additionalProperties: boolean; required: string[] };
  assert.deepEqual(Object.keys(p.properties), ["section", "part"]);
  assert.deepEqual(p.properties.section.enum, [...SECTIONS]);
  assert.deepEqual([p.properties.part.type, p.properties.part.minimum, p.properties.part.maximum], ["integer", 1, MAX_PARTS]);
  assert.equal(p.additionalProperties, false);
  assert.deepEqual(p.required, []);
  for (const bad of [{ path: "/etc" }, { unit: "ssh.service" }, { command: "id" }, { section: "../../etc" }, { section: "credentials" }, { section: "paths", part: 0 }, { section: "paths", part: 1.5 }, { section: "paths", part: "1" }, { part: 1 }, { section: "paths", extra: true }]) {
    await assert.rejects(t.run(bad), Error, JSON.stringify(bad));
  }
  assert.deepEqual(seen, []);
  await t.run({ section: null, part: null });
  assert.deepEqual(seen, [["host_inventory", undefined]], "nulls are treated as left out; the helper gets no arguments");
});

test("overview: per-section status, drift findings, separation verdicts, declared helper actions, and how to read missing evidence", async () => {
  const { ops } = fakeOps(await realInventory());
  const out = await hostInventoryTool({ ops }).run({});
  const v = out.value as any;
  assert.deepEqual([out.provenance, out.source], ["live", "ops/host_inventory"]);
  assert.equal(v.status, "ok");
  assert.deepEqual(Object.keys(v.sections), [...SECTIONS]);
  for (const s of Object.values(v.sections) as any[]) assert.ok("complete" in s && "origin" in s && "observedAt" in s);
  assert.match(v.howToRead, /Missing or unavailable evidence is NOT a passed check/);
  assert.deepEqual(v.helperActionsDeclaredInRepository["orbit-ops"], [...ACTIONS]);
  assert.ok(v.deploymentSeparation.length > 0);
  assert.ok(JSON.stringify(v).length < MAX_OUTPUT_CHARS);
});

test("sections are paged so every part reaches the model whole", async () => {
  const { ops } = fakeOps(await realInventory());
  const t = hostInventoryTool({ ops });
  for (const section of SECTIONS) {
    const first = (await t.run({ section })).value as any;
    assert.equal(first.status, "ok");
    for (let p = 1; p <= first.parts; p++) {
      const page = (await t.run({ section, part: p })).value as any;
      assert.ok(JSON.stringify(page).length < MAX_OUTPUT_CHARS, `${section} part ${p}`);
      assert.equal(page.part, p);
      assert.ok("complete" in page && "unavailable" in page && "warnings" in page && "observedAt" in page);
    }
    await assert.rejects(t.run({ section, part: first.parts + 1 }), /does not exist/);
  }
  const parts = partsOf(Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(100) })));
  assert.ok(parts.length > 1 && parts.every((p) => JSON.stringify(p).length <= PART_BUDGET_CHARS + 2));
  assert.deepEqual(partsOf([{ big: "x".repeat(PART_BUDGET_CHARS * 2) }]), [[{ state: "omitted", reason: "this item exceeded the per-part output bound" }]]);
});

test("declared vs loaded: repository unit files parse, matching settings match, and drift is a finding", async () => {
  const declared = readDeclared();
  assert.deepEqual(declared.unreadable, []);
  assert.deepEqual(declared.declared.get("orbit-ops@.service")!.CapabilityBoundingSet, "CAP_DAC_READ_SEARCH");
  assert.equal(declared.declared.get("orbit.service")!.SupplementaryGroups, "orbit-vault orbit-ops");
  assert.deepEqual(parseUnitFile("[Service]\nReadWritePaths=/a\nReadWritePaths=/b\n# ProtectHome=no\nExecStart=/bin/x --secret\nReadOnlyPaths=/c\nReadOnlyPaths=\n"), { ReadWritePaths: "/a /b", ReadOnlyPaths: "" });
  assert.ok(!COMPARED_PROPS.includes("ExecStart") && !COMPARED_PROPS.includes("Environment"));

  const data = await realInventory();
  const cmp = compareDeclared(data, declared);
  const ops1 = cmp.items.find((x: any) => x.unit === "orbit-ops@.service") as any;
  assert.ok(ops1.match > 0);
  assert.ok(!ops1.drift.some((d: any) => d.prop === "CapabilityBoundingSet"), "cap_dac_read_search matches CAP_DAC_READ_SEARCH");
  assert.ok(ops1.drift.some((d: any) => d.prop === "PrivateNetwork"), "the fixture's PrivateNetwork=no differs from the declared yes");
  const sock = cmp.items.find((x: any) => x.unit === "orbit-ops.socket") as any;
  assert.deepEqual(sock.drift, []);
  assert.match(cmp.warnings.join(" "), /Drift is reported, never fixed/);
  const unread = compareDeclared(data, { declared: new Map(), unreadable: ["orbit.service"] });
  assert.equal(unread.complete, false);
});

test("the fixed unit list covers exactly the service units the repository ships", () => {
  const shipped = readdirSync(new URL("../deploy/systemd/", import.meta.url)).filter((f) => f.endsWith(".service")).sort();
  assert.deepEqual([...SPEC.services].sort(), shipped);
  const sockets = readdirSync(new URL("../deploy/systemd/", import.meta.url)).filter((f) => f.endsWith(".socket")).sort();
  assert.deepEqual(SPEC.sockets.map((s) => s.unit).sort(), sockets);
});

test("disabled, old helper, missing module, missing helper and permission problems are explicit statuses, never a fallback", async () => {
  const cases: [string, string][] = [
    [`orbit-ops refused: ${INVENTORY_DISABLED_MESSAGE}`, "disabled"],
    [`orbit-ops refused: ${INVENTORY_UNSUPPORTED_MESSAGE}`, "unsupported"],
    ["orbit-ops refused: Unknown action.", "unsupported"],
    ["orbit-ops is not available: the helper socket is not there (the root helper is not installed or not running).", "unavailable"],
    ["orbit-ops refused access: the ORBIT service is not in the orbit-ops group", "unavailable"],
    ["orbit-ops did not answer in time.", "unavailable"],
    ["something else", "unavailable"],
  ];
  for (const [message, status] of cases) {
    assert.equal(classify(new Error(message)).status, status, message);
    const { ops, seen } = fakeOps(null, new Error(message));
    const v = (await hostInventoryTool({ ops }).run({})).value as any;
    assert.equal(v.status, status);
    assert.equal(v.observedAt, null);
    assert.match(v.note, /No host facts were obtained/);
    assert.equal(seen.length, 1, "exactly one request; nothing else is tried");
  }
  const odd = (await hostInventoryTool({ ops: fakeOps({ schema: "something-else" }).ops }).run({})).value as any;
  assert.equal(odd.status, "unavailable");
});

test("over a real socket: an old helper (unknown action) and an unactivated helper reach the tool as explicit statuses", async () => {
  const dirPath = mkdtempSync(join(tmpdir(), "inv-sock-"));
  const path = join(dirPath, "ops.sock");
  let answer = "";
  const srv = netServer((c) => c.once("data", () => c.end(`${answer}\n`)));
  await new Promise<void>((r) => srv.listen(path, r));
  try {
    const t = hostInventoryTool({ ops: opsClient(path, 2000) });
    answer = JSON.stringify({ ok: false, error: { code: "unknown_action", message: "Unknown action." } });
    assert.equal(((await t.run({})).value as any).status, "unsupported");
    answer = JSON.stringify({ ok: false, action: "host_inventory", error: { code: "disabled", message: INVENTORY_DISABLED_MESSAGE } });
    assert.equal(((await t.run({})).value as any).status, "disabled");
    answer = JSON.stringify({ ok: true, action: "host_inventory", data: await realInventory() });
    assert.equal(((await t.run({})).value as any).status, "ok");
    const gone = hostInventoryTool({ ops: opsClient(join(dirPath, "missing.sock"), 2000) });
    assert.equal(((await gone.run({})).value as any).status, "unavailable");
  } finally {
    srv.close();
    rmSync(dirPath, { recursive: true, force: true });
  }
});

// ================================================================ owner authorization and chat integration

test("owner only: the policy refuses the tool to anyone else, and a refused call never reaches the helper", async () => {
  assert.equal(decide("agent", HOST_INVENTORY_TOOL, true).allow, true);
  assert.equal(decide("agent", HOST_INVENTORY_TOOL, false).allow, false);
  const { ops, seen } = fakeOps(await realInventory());
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "", verifiedAt: NOW.toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
    step: (() => { let i = 0; const s: Step[] = [{ text: "", calls: [{ call_id: "1", name: HOST_INVENTORY_TOOL, arguments: "{}" }] }, { text: "no", calls: [] }]; return async () => s[i++]!; })(),
  };
  const out = await runChat({ model, messages: [{ role: "user", content: "go" }], limits: [], tools: [hostInventoryTool({ ops })], allow: (t) => { const d = decide("agent", t, false); return d.allow ? undefined : d.reason; } });
  assert.equal(out.calls[0]!.ok, false);
  assert.deepEqual(seen, []);
});

test("chat-tools.ts does not offer it: the tool exists only where the server is given it (activation)", () => {
  const list = chatTools({ memory: {} as never, toolbox: {} as never, notify: {} as never, proposals: {} as never, launchable: () => ({ routines: [] }), ops: fakeOps(null).ops });
  assert.ok(!list.some((t) => t.name === HOST_INVENTORY_TOOL));
});

// Through the real server: the owner is offered and can call the tool when it is configured; anyone else gets no tools, and an
// unconfigured server never offers it.
const sc = (steps: Step[]): ModelPort => {
  let i = 0;
  return { status: () => ({ port: "model", state: "live", impl: "fake", detail: "t", verifiedAt: NOW.toISOString() }), reply: async () => ({ value: "plain", provenance: "live", source: "t" }), step: async () => steps[Math.min(i++, steps.length - 1)]! };
};
let caller: string | undefined = "owner@example.com";
let model: ModelPort = sc([]);
const served = fakeOps(null);
const build = (hostInventory?: ReturnType<typeof hostInventoryTool>[]) => {
  const notify = notifier(jsonStore(undefined, "n", []));
  const memoryPort = vaultMemory(mkdtempSync(join(tmpdir(), "orbit-inv-")));
  return buildServer({
    ports: MOCK_PORT_NAMES.map((n) => mockPort(n)),
    model: { status: () => model.status(), reply: (...a) => model.reply(...a), step: (...a) => model.step!(...a) },
    memory: memoryPort,
    notify,
    schedule: scheduler(jsonStore(undefined, "s", []), notify),
    runs: runner(jsonStore(undefined, "r", []), [memoryReport(memoryPort)], notify),
    tools: toolbox([]),
    nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), "owner@example.com"),
    jobs: jobRegistry(jsonStore(undefined, "j", []), Buffer.alloc(32, 1), notify),
    commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
    owner: "owner@example.com",
    identify: async () => caller,
    hostInventory,
  });
};
let inventoryData: unknown;
const withTool = build([hostInventoryTool({ ops: { call: async (a: string, args?: Record<string, unknown>) => (served.seen.push([a, args]), { value: inventoryData, provenance: "live", source: `ops/${a}` }) } as never })]);
const withoutTool = build(undefined);
let baseWith = "";
let baseWithout = "";
before(async () => {
  inventoryData = await realInventory();
  await new Promise<void>((r) => withTool.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => withoutTool.listen(0, "127.0.0.1", r));
  baseWith = `http://127.0.0.1:${(withTool.address() as AddressInfo).port}`;
  baseWithout = `http://127.0.0.1:${(withoutTool.address() as AddressInfo).port}`;
});
after(() => {
  withTool.close();
  withoutTool.close();
});
const chat = (base: string) => fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "inventory" }] }) });
const recording = (steps: Step[], offered: string[][]) => {
  const m = sc(steps);
  const inner = m.step!;
  m.step = async (i, l, n, t) => (offered.push(t.map((x) => x.name)), inner(i, l, n, t));
  return m;
};

test("through the server: the owner is offered the tool and it runs; a non-owner gets no tools and nothing reaches the helper", async () => {
  caller = "owner@example.com";
  const offered: string[][] = [];
  model = recording([{ text: "", calls: [{ call_id: "a", name: HOST_INVENTORY_TOOL, arguments: "{}" }] }, { text: "done", calls: [] }], offered);
  const body = await (await chat(baseWith)).json();
  assert.ok(offered[0]!.includes(HOST_INVENTORY_TOOL));
  assert.deepEqual([body.calls[0].name, body.calls[0].ok], [HOST_INVENTORY_TOOL, true]);
  assert.deepEqual(served.seen, [["host_inventory", undefined]]);

  caller = "someone@example.com";
  const other: string[][] = [];
  model = recording([{ text: "", calls: [{ call_id: "b", name: HOST_INVENTORY_TOOL, arguments: "{}" }] }, { text: "hi", calls: [] }], other);
  const res = await (await chat(baseWith)).json();
  assert.deepEqual(res.calls, []);
  assert.ok(res.limits.some((l: string) => l.startsWith("chat tools are refused")));
  assert.equal(served.seen.length, 1, "a non-owner caused no helper request");
  caller = "owner@example.com";
});

test("through the server, not activated: the owner is not offered the tool at all", async () => {
  caller = "owner@example.com";
  const offered: string[][] = [];
  model = recording([{ text: "nothing", calls: [] }], offered);
  await (await chat(baseWithout)).json();
  assert.ok(offered.length > 0);
  assert.ok(!offered[0]!.includes(HOST_INVENTORY_TOOL));
});
