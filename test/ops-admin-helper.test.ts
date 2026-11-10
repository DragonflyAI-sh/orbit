import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ADMIN_CONFIG, loadRecord, type AdminConfig, type AdminEnv, type Exec, type Probe } from "../src/ops/admin-core.ts";
import { handle, type AdminAudit } from "../src/ops/admin-helper.ts";
import {
  ADMIN_ACTIONS,
  CONFIG_KEYS,
  digestOf,
  displayConfig,
  opIdFor,
  parseAdminRequest,
  validateConfigChanges,
  type OpRecord,
} from "../src/ops/admin-protocol.ts";
import { EnvRefused, editEnv, runOperation } from "../src/ops/admin-run.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const OP = "1".repeat(40);
const OP2 = "2".repeat(40);
// Synthetic secrets assembled at runtime so no credential-shaped literal sits in the source (keeps the repository scan clean).
const part = (...p: string[]) => p.join("");
const SECRET_LINE_VALUE = part("sk", "-proj-", "Q".repeat(26));
const SECRET_LINE = `ORBIT_SOMETHING_ELSE=${SECRET_LINE_VALUE}`;
const TRIG = part("trig", "_", "abcdef123456");

// ---- a host on disk (real temp directories, as the helpers see them) with a fake systemd, fake /status and a fake clock ----

type Script = {
  served: string | undefined; // commit /status serves right now
  ingress: number; // HTTP status of the job listener (401 when it is listening)
  exec: (file: string, args: string[], world: World) => Exec | Promise<Exec> | undefined;
  onProbe?: (host: string, port: number, path: string, world: World) => Probe | undefined;
};
type World = {
  base: string; root: string; cfg: AdminConfig; script: Script; execs: [string, string[]][]; probes: string[]; audit: object[];
  advance(ms: number): void; env: AdminEnv; envPath: string; envText(): string; point(sha: string): void;
};

function world(envText = `HOST=127.0.0.1\nPORT=8790\n${SECRET_LINE}\nORBIT_MODEL=old-model\n`): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ops-admin-")));
  const root = join(base, "opt-orbit");
  const stateDir = join(base, "var-lib");
  for (const d of [join(root, "state"), join(root, "releases", SHA_A), join(root, "releases", SHA_B), stateDir]) mkdirSync(d, { recursive: true });
  for (const sha of [SHA_A, SHA_B]) writeFileSync(join(root, "releases", sha, "COMMIT"), `${sha}\n`);
  symlinkSync(join(root, "releases", SHA_A), join(root, "current"));
  writeFileSync(join(root, "orbit.env"), envText);
  chmodSync(join(root, "orbit.env"), 0o640);
  let t = Date.parse("2026-11-09T12:00:00Z");
  const cfg: AdminConfig = { ...ADMIN_CONFIG, root, stateDir, expectedUid: process.getuid!(), healthWindowMs: 10_000, healthIntervalMs: 1000, staleAfterMs: 30_000 };
  const script: Script = { served: SHA_A, ingress: 401, exec: () => undefined };
  const execs: [string, string[]][] = [];
  const probes: string[] = [];
  const audit: object[] = [];
  const w: World = {
    base, root, cfg, script, execs, probes, audit, advance: (ms: number) => void (t += ms),
    env: {
      exec: async (file: string, args: string[]): Promise<Exec> => {
        execs.push([file, args]);
        return (await script.exec(file, args, w)) ?? { code: 0, stdout: "", stderr: "", timedOut: false };
      },
      probe: async (host: string, port: number, path: string): Promise<Probe> => {
        probes.push(`${host}:${port}${path}`);
        const custom = script.onProbe?.(host, port, path, w);
        if (custom) return custom;
        if (path === "/status") return script.served ? { reachable: true, httpStatus: 200, commit: script.served } : { reachable: false };
        return { reachable: true, httpStatus: script.ingress };
      },
      sleep: async (ms: number) => void (t += ms),
      now: () => new Date(t),
    },
    envPath: join(root, "orbit.env"),
    envText: () => readFileSync(join(root, "orbit.env"), "utf8"),
    point: (sha: string) => {
      symlinkSync(join(root, "releases", sha), join(root, "current.new"));
      execFileRename(join(root, "current.new"), join(root, "current"));
    },
  };
  return w;
}
import { renameSync } from "node:fs";
const execFileRename = (a: string, b: string) => renameSync(a, b);

// Writes the front's record as if a request had been accepted, so the runner can be driven directly.
async function accept(w: World, action: string, opId = OP, extra: object = {}) {
  const raw = JSON.stringify({ action, opId, ...extra });
  const out = JSON.parse(await handle(raw, w.env, () => {}, w.cfg));
  assert.equal(out.ok, true, JSON.stringify(out));
  w.execs.length = 0; // what the runner runs is judged separately from the front's dispatch
  return out;
}
const run = async (w: World, opId = OP, group: "ops" | "vault" = "ops") => (await runOperation(opId, group, w.env, w.cfg, (l) => w.audit.push(l)))!;
const systemctlCalls = (w: World) => w.execs.filter(([f]) => f.endsWith("systemctl")).map(([, a]) => a.join(" "));

// ---------------------------------------------------------------- validation

test("requests are strict: unknown actions, extra keys, bad ids and oversize bodies are refused", () => {
  assert.deepEqual([...ADMIN_ACTIONS], ["restart_orbit", "deploy_now", "rollback_release", "apply_config", "refresh_vault", "op_status"]);
  const bad = (raw: string, code: string) => assert.throws(() => parseAdminRequest(raw), (e: { code?: string }) => e.code === code, raw.slice(0, 60));
  bad("not json", "bad_request");
  bad("[]", "bad_request");
  bad(JSON.stringify({ action: "reboot", opId: OP }), "unknown_action");
  bad(JSON.stringify({ action: "restart_orbit" }), "bad_arguments");
  bad(JSON.stringify({ action: "restart_orbit", opId: "short" }), "bad_arguments");
  bad(JSON.stringify({ action: "restart_orbit", opId: OP.toUpperCase().replace(/1/g, "A") }), "bad_arguments");
  bad(JSON.stringify({ action: "restart_orbit", opId: OP, unit: "sshd.service" }), "bad_arguments");
  bad(JSON.stringify({ action: "deploy_now", opId: OP, changes: {} }), "bad_arguments");
  bad(JSON.stringify({ action: "apply_config", opId: OP }), "bad_arguments");
  bad(JSON.stringify({ action: "op_status", opId: OP, extra: 1 }), "bad_arguments");
  bad(JSON.stringify({ action: "apply_config", opId: OP, changes: { ORBIT_MODEL: "x".repeat(5000) } }), "request_too_large");
  assert.deepEqual(parseAdminRequest(JSON.stringify({ action: "refresh_vault", opId: OP })), { action: "refresh_vault", opId: OP });
});

test("config changes: only the five keys, validated against the real schemas, with no room for injection", () => {
  assert.deepEqual([...CONFIG_KEYS], ["ORBIT_MODEL", "ORBIT_ROUTINES", "ORBIT_ROUTINE_REPOS", "ORBIT_PUBLIC_JOB_URL", "ORBIT_INGRESS_PORT"]);
  const ok = validateConfigChanges({ ORBIT_MODEL: "gpt-5.5", ORBIT_ROUTINES: `orbit=${TRIG},money-noodle=${TRIG}`, ORBIT_ROUTINE_REPOS: "orbit=DragonflyAI-sh/orbit", ORBIT_PUBLIC_JOB_URL: "https://orbit-jobs.tail5bde08.ts.net", ORBIT_INGRESS_PORT: 8792 });
  assert.equal(ok.ORBIT_INGRESS_PORT, "8792");
  const refuse = (changes: unknown) => assert.throws(() => validateConfigChanges(changes), (e: { code?: string }) => e.code === "bad_arguments", JSON.stringify(changes).slice(0, 80));
  // unknown keys, including ones that would be dangerous to set
  for (const key of ["HOST", "PORT", "ORBIT_OWNER", "ORBIT_VAULT", "ORBIT_DEPLOY_STATE", "LD_PRELOAD", "PATH", "orbit_model", "__proto__", "constructor", "ORBIT_MODEL "]) {
    refuse(JSON.parse(`{"${key}": "x"}`));
    refuse(JSON.parse(`{"ORBIT_MODEL": "gpt-5", "${key}": "x"}`));
  }
  refuse({});
  refuse(null);
  refuse([]);
  refuse("ORBIT_MODEL=x");
  // injection and metacharacters, for every key
  for (const evil of ["x\nORBIT_OWNER=attacker", "x;id", "x$(id)", "x`id`", "x y", 'x"y', "x'y", "x\\y", "x#y", "x&y", "x|y", "x>y", "x\ty", "x\u0000y", "é", ""]) {
    refuse({ ORBIT_MODEL: evil });
    refuse({ ORBIT_ROUTINES: `orbit=${evil}` });
    refuse({ ORBIT_ROUTINE_REPOS: `orbit=${evil}` });
    refuse({ ORBIT_PUBLIC_JOB_URL: evil });
  }
  refuse({ ORBIT_MODEL: 5 });
  refuse({ ORBIT_MODEL: "-flag" });
  refuse({ ORBIT_MODEL: "a".repeat(65) });
  refuse({ ORBIT_ROUTINES: "orbit" });
  refuse({ ORBIT_ROUTINES: `orbit=${TRIG},orbit=${TRIG}` });
  refuse({ ORBIT_ROUTINES: `orbit=${TRIG.replace("trig_", "tok_")}` });
  refuse({ ORBIT_ROUTINES: Array.from({ length: 9 }, (_, i) => `r${i}=${TRIG}`).join(",") });
  refuse({ ORBIT_ROUTINE_REPOS: "orbit=../../etc" });
  refuse({ ORBIT_ROUTINE_REPOS: "orbit=a/b/c" });
  refuse({ ORBIT_ROUTINE_REPOS: "orbit=./.." });
  for (const url of ["http://x.ts.net", "https://x.ts.net/", "https://x.ts.net/path", "https://x.ts.net:8443", "https://u:p@x.ts.net", "https://x.ts.net?q=1", "https://x.ts.net#f", "https://evil.example.com", "https://ts.net", "ftp://x.ts.net", "x.ts.net", "https://-x.ts.net"]) refuse({ ORBIT_PUBLIC_JOB_URL: url });
  for (const port of [0, 80, 1023, 65536, -1, 1.5, "80a", "08080", "8080;", " 8080", null, true, "0x1f90"]) refuse({ ORBIT_INGRESS_PORT: port });
  assert.equal(validateConfigChanges({ ORBIT_INGRESS_PORT: "1024" }).ORBIT_INGRESS_PORT, "1024");
  assert.equal(validateConfigChanges({ ORBIT_INGRESS_PORT: 65535 }).ORBIT_INGRESS_PORT, "65535");
});

test("a card, ledger or result shows trigger ids only as names and the last four characters", () => {
  const shown = displayConfig(validateConfigChanges({ ORBIT_ROUTINES: `orbit=${TRIG}`, ORBIT_MODEL: "gpt-5" }));
  assert.equal(shown.ORBIT_MODEL, "gpt-5");
  assert.ok(!JSON.stringify(shown).includes(TRIG), JSON.stringify(shown));
  assert.match(shown.ORBIT_ROUTINES!, /^orbit=trig_….{4}$/);
});

test("the digest binds the action and exact arguments; the operation id is derived from the proposal id", () => {
  const a = digestOf("apply_config", { changes: { ORBIT_MODEL: "gpt-5" } });
  assert.equal(a, digestOf("apply_config", { changes: { ORBIT_MODEL: "gpt-5" } }));
  assert.notEqual(a, digestOf("apply_config", { changes: { ORBIT_MODEL: "gpt-6" } }));
  assert.notEqual(a, digestOf("apply_config", { changes: { ORBIT_MODEL: "gpt-5", ORBIT_INGRESS_PORT: "8792" } }));
  assert.notEqual(digestOf("restart_orbit", {}), digestOf("deploy_now", {}));
  assert.match(opIdFor("11111111-1111-1111-1111-111111111111"), /^[0-9a-f]{40}$/);
  assert.equal(opIdFor("p1"), opIdFor("p1"));
  assert.notEqual(opIdFor("p1"), opIdFor("p2"));
});

// ---------------------------------------------------------------- the front

test("the front only validates, records and dispatches: a runner is started with a fixed command and nothing is verified yet", async () => {
  const w = world();
  const audits: AdminAudit[] = [];
  const out = JSON.parse(await handle(JSON.stringify({ action: "restart_orbit", opId: OP }), w.env, (a) => audits.push(a), w.cfg));
  assert.equal(out.ok, true);
  assert.equal(out.data.operation.state, "accepted");
  assert.match(out.data.note, /Nothing is verified yet/);
  assert.equal(out.data.operation.verification, undefined);
  assert.deepEqual(systemctlCalls(w), [`start --no-block orbit-ops-admin-run@${OP}.service`]);
  assert.deepEqual(w.execs.map(([f]) => f), ["/usr/bin/systemctl"]);
  assert.equal(readFileSync(w.envPath, "utf8").includes("old-model"), true, "the front changed nothing");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.outcome, "accepted");
  assert.equal(audits[0]!.action, "restart_orbit");
});

test("each action starts its own fixed runner: the vault refresh has its own smaller unit", async () => {
  const w = world();
  const out = JSON.parse(await handle(JSON.stringify({ action: "refresh_vault", opId: OP }), w.env, () => {}, w.cfg));
  assert.equal(out.ok, true);
  assert.deepEqual(systemctlCalls(w), [`start --no-block orbit-ops-admin-vault@${OP}.service`]);
});

test("a repeated operation id returns the existing record and never starts a second runner", async () => {
  const w = world();
  await accept(w, "restart_orbit");
  w.execs.push(["/usr/bin/systemctl", ["start", "--no-block", "first"]]);
  const again = JSON.parse(await handle(JSON.stringify({ action: "restart_orbit", opId: OP }), w.env, () => {}, w.cfg));
  assert.equal(again.ok, true);
  assert.equal(again.data.replayed, true);
  assert.match(again.data.note, /not run again/);
  assert.equal(systemctlCalls(w).filter((c) => c.startsWith("start")).length, 1, "only the marker: no second runner");
  // a replay with different content under the same id also just returns the old record
  const other = JSON.parse(await handle(JSON.stringify({ action: "apply_config", opId: OP, changes: { ORBIT_MODEL: "gpt-5" } }), w.env, () => {}, w.cfg));
  assert.equal(other.data.replayed, true);
  assert.equal(other.data.operation.action, "restart_orbit");
  assert.equal(w.execs.filter(([, a]) => a[0] === "start").length, 1);
});

test("operations are serialised: a second one is refused while the first is in flight, and runs once it has ended", async () => {
  const w = world();
  w.script.exec = (_f, a) => (a[0] === "is-active" ? { code: 0, stdout: "active\n", stderr: "", timedOut: false } : undefined);
  await accept(w, "restart_orbit", OP);
  const busy = JSON.parse(await handle(JSON.stringify({ action: "deploy_now", opId: OP2 }), w.env, () => {}, w.cfg));
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, "busy");
  assert.equal(loadRecord(w.cfg, OP2), undefined);
  // the first ends (its runner writes a terminal state and frees the slot), then the next may start
  w.script.exec = () => undefined;
  const done = await run(w, OP);
  assert.notEqual(done.state, "accepted");
  const next = JSON.parse(await handle(JSON.stringify({ action: "deploy_now", opId: OP2 }), w.env, () => {}, w.cfg));
  assert.equal(next.ok, true);
});

test("an accepted operation whose runner has died is reported as interrupted, never left looking in flight", async () => {
  const w = world();
  w.script.exec = (_f, a) => (a[0] === "is-active" ? { code: 3, stdout: "inactive\n", stderr: "", timedOut: false } : undefined);
  await accept(w, "restart_orbit");
  const early = JSON.parse(await handle(JSON.stringify({ action: "op_status", opId: OP }), w.env, () => {}, w.cfg));
  assert.equal(early.data.operation.state, "accepted", "too early to call it dead");
  w.advance(60_000);
  const late = JSON.parse(await handle(JSON.stringify({ action: "op_status", opId: OP }), w.env, () => {}, w.cfg));
  assert.equal(late.data.operation.state, "interrupted");
  assert.match(late.data.operation.summary, /outcome is unknown/);
  assert.equal(late.data.operation.verification.checked, false);
  assert.equal(existsSync(join(w.cfg.stateDir, "active")), false, "the slot is freed");
});

test("if the runner cannot be started the operation is recorded as failed and nothing was done", async () => {
  const w = world();
  w.script.exec = (_f, a) => (a[0] === "start" ? { code: 1, stdout: "", stderr: "denied", timedOut: false } : undefined);
  const out = JSON.parse(await handle(JSON.stringify({ action: "apply_config", opId: OP, changes: { ORBIT_MODEL: "gpt-5" } }), w.env, () => {}, w.cfg));
  assert.equal(out.data.accepted, false);
  assert.equal(out.data.operation.state, "failed");
  assert.equal(loadRecord(w.cfg, OP)!.changes, undefined, "pending settings are dropped");
  assert.equal(existsSync(join(w.cfg.stateDir, "active")), false);
});

test("op_status for an unknown id says so; rejected requests are audited without echoing the request", async () => {
  const w = world();
  const audits: AdminAudit[] = [];
  const a = JSON.parse(await handle(JSON.stringify({ action: "op_status", opId: OP }), w.env, (x) => audits.push(x), w.cfg));
  assert.equal(a.error.code, "not_found");
  const evil = JSON.stringify({ action: "restart_orbit", opId: OP, token: SECRET_LINE_VALUE });
  const b = JSON.parse(await handle(evil, w.env, (x) => audits.push(x), w.cfg));
  assert.equal(b.ok, false);
  assert.equal(b.error.code, "bad_arguments");
  assert.equal(audits.length, 2);
  assert.ok(audits.every((x) => x.outcome === "rejected"));
  assert.ok(!JSON.stringify(audits).includes(SECRET_LINE_VALUE), "the request is never echoed into the audit");
  assert.ok(!b.error.message.includes(SECRET_LINE_VALUE));
});

test("the record directory is private and the pending settings never leave the helper", async () => {
  const w = world();
  const out = await accept(w, "apply_config", OP, { changes: { ORBIT_ROUTINES: `orbit=${TRIG}`, ORBIT_MODEL: "gpt-5" } });
  assert.ok(!JSON.stringify(out).includes(TRIG), "no trigger id in the response");
  assert.ok(JSON.stringify(out).includes("trig_…"), "masked form is shown");
  assert.equal(statSync(w.cfg.stateDir).mode & 0o077, 0);
  assert.equal(statSync(join(w.cfg.stateDir, "ops", `${OP}.json`)).mode & 0o077, 0);
  const status = JSON.parse(await handle(JSON.stringify({ action: "op_status", opId: OP }), w.env, () => {}, w.cfg));
  assert.ok(!JSON.stringify(status).includes(TRIG));
});

// ---------------------------------------------------------------- the runner: restart

test("restart: verified only when /status is healthy and serves the same commit after the restart", async () => {
  const w = world();
  await accept(w, "restart_orbit");
  const rec = await run(w);
  assert.equal(rec.state, "verified");
  assert.equal(rec.verification!.checked, true);
  assert.equal(rec.verification!.healthy, true);
  assert.equal(rec.verification!.servedCommit, SHA_A);
  assert.deepEqual(systemctlCalls(w).filter((c) => c.startsWith("restart")), ["restart orbit.service"]);
  assert.ok(w.probes.includes("127.0.0.1:8790/status"));
  assert.equal(existsSync(join(w.cfg.stateDir, "active")), false);
  assert.ok(w.audit.some((l) => (l as { step?: string }).step === "result"));
});

test("restart: /status that never comes back is a failure, not a success; a different commit is a failure", async () => {
  const w = world();
  await accept(w, "restart_orbit");
  w.script.served = undefined;
  const down = await run(w);
  assert.equal(down.state, "failed");
  assert.equal(down.verification!.healthy, false);
  assert.match(down.summary!, /never answered/);
  assert.match(down.summary!, /may be down/);

  const w2 = world();
  await accept(w2, "restart_orbit");
  w2.script.served = SHA_B;
  const other = await run(w2);
  assert.equal(other.state, "failed");
  assert.match(other.summary!, /expected aaaaaaaaaaaa/);
});

test("restart: a restart whose command fails is still judged by /status, and a slow recovery inside the window counts", async () => {
  const w = world();
  await accept(w, "restart_orbit");
  w.script.served = undefined;
  let probes = 0;
  w.script.onProbe = (_h, _p, path) => (path === "/status" && ++probes >= 4 ? { reachable: true, httpStatus: 200, commit: SHA_A } : undefined);
  w.script.exec = (_f, a) => (a[0] === "restart" ? { code: 1, stdout: "", stderr: "", timedOut: false } : undefined);
  const rec = await run(w);
  assert.equal(rec.state, "verified");
  assert.ok(rec.steps.some((s) => s.step === "restart-command" && /exit 1/.test(s.detail)), "the failed command is on the record");
});

test("restart: no readable deployed commit means no restart at all", async () => {
  const w = world();
  await accept(w, "restart_orbit");
  writeFileSync(join(w.root, "releases", SHA_A, "COMMIT"), "garbage\n");
  w.execs.length = 0;
  const rec = await run(w);
  assert.equal(rec.state, "failed");
  assert.deepEqual(systemctlCalls(w), []);
});

test("a runner runs an accepted operation once, and only in its own group", async () => {
  const w = world();
  await accept(w, "restart_orbit");
  assert.equal((await run(w)).state, "verified");
  w.execs.length = 0;
  const again = await run(w);
  assert.equal(again.state, "verified");
  assert.deepEqual(w.execs, [], "nothing ran the second time");

  const v = world();
  await accept(v, "restart_orbit");
  const wrong = await run(v, OP, "vault");
  assert.equal(wrong.state, "failed");
  assert.deepEqual(v.execs.filter(([, a]) => a[0] === "restart"), []);
});

// ---------------------------------------------------------------- the runner: orbit.env

test("editEnv replaces and appends only the requested settings and copies every other line byte for byte", () => {
  const text = `HOST=0.0.0.0\n# comment ORBIT_MODEL=ignored\n${SECRET_LINE}\nORBIT_MODEL=old\nPORT=8790\n`;
  const e = editEnv(text, { ORBIT_MODEL: "new", ORBIT_INGRESS_PORT: "8791" });
  assert.equal(e.next, `HOST=0.0.0.0\n# comment ORBIT_MODEL=ignored\n${SECRET_LINE}\nORBIT_MODEL=new\nPORT=8790\nORBIT_INGRESS_PORT=8791\n`);
  assert.deepEqual(e.changed, ["ORBIT_MODEL", "ORBIT_INGRESS_PORT"]);
  assert.equal(e.previous.ORBIT_MODEL, "old");
  assert.deepEqual(editEnv("A=1\nORBIT_MODEL=x\n", { ORBIT_MODEL: "x" }).changed, []);
  assert.equal(editEnv("", { ORBIT_MODEL: "x" }).next, "ORBIT_MODEL=x\n");
  assert.equal(editEnv("A=1", { ORBIT_MODEL: "x" }).next, "A=1\nORBIT_MODEL=x\n");
  assert.equal(editEnv("A=1", {}).next, "A=1", "an untouched file keeps its missing final newline");
});

test("editEnv refuses forms it cannot edit safely rather than guessing", () => {
  const refuse = (text: string) => assert.throws(() => editEnv(text, { ORBIT_MODEL: "x" }), EnvRefused, text);
  refuse("ORBIT_MODEL=a\nORBIT_MODEL=b\n");
  refuse("  ORBIT_MODEL=a\n");
  refuse("export ORBIT_MODEL=a\n");
  refuse("ORBIT_MODEL = a\n");
  refuse("ORBIT_MODEL=a\\\n  more\n");
  refuse("X=1\\\nORBIT_MODEL=a\n");
  refuse("A=1\r\nB=2\r\n");
  refuse("A=1\u0000\n");
});

test("apply_config: backs up the old file, writes only the requested setting, restarts, and verifies /status", async () => {
  const w = world();
  const before = w.envText();
  await accept(w, "apply_config", OP, { changes: { ORBIT_MODEL: "gpt-5.5" } });
  const rec = await run(w);
  assert.equal(rec.state, "verified", rec.summary);
  assert.equal(w.envText(), before.replace("ORBIT_MODEL=old-model", "ORBIT_MODEL=gpt-5.5"));
  const backup = join(w.root, "state", `env-backup-${OP.slice(0, 12)}.env`);
  assert.equal(readFileSync(backup, "utf8"), before);
  assert.equal(statSync(backup).mode & 0o077, 0, "the backup is root-only");
  assert.equal(statSync(w.envPath).mode & 0o777, 0o640, "the file keeps its mode");
  assert.deepEqual(systemctlCalls(w), ["restart orbit.service"]);
  assert.equal(rec.changes, undefined);
});

test("apply_config never puts credential-like content from orbit.env in the record, the audit, or any answer", async () => {
  const w = world();
  const out = await accept(w, "apply_config", OP, { changes: { ORBIT_MODEL: "gpt-5.5", ORBIT_ROUTINES: `orbit=${TRIG}` } });
  const rec = await run(w);
  const status = JSON.parse(await handle(JSON.stringify({ action: "op_status", opId: OP }), w.env, () => {}, w.cfg));
  const everything = JSON.stringify([out, rec, status, w.audit, readFileSync(join(w.cfg.stateDir, "ops", `${OP}.json`), "utf8")]);
  assert.ok(!everything.includes(SECRET_LINE_VALUE), "the unrelated secret line was copied, not exposed");
  assert.ok(!everything.includes(TRIG), "trigger ids are masked everywhere");
  assert.ok(w.envText().includes(SECRET_LINE), "the unrelated line is preserved exactly");
  assert.ok(w.envText().includes(`ORBIT_ROUTINES=orbit=${TRIG}`));
});

test("apply_config with a changed ingress port is verified only if the job listener answers on that port", async () => {
  const w = world(`HOST=127.0.0.1\nPORT=8790\nORBIT_INGRESS_PORT=8791\n`);
  await accept(w, "apply_config", OP, { changes: { ORBIT_INGRESS_PORT: 8792 } });
  const probesSeen: string[] = [];
  w.script.onProbe = (h, p, path) => {
    probesSeen.push(`${h}:${p}${path}`);
    return undefined;
  };
  const rec = await run(w);
  assert.equal(rec.state, "verified");
  assert.ok(probesSeen.some((p) => p.startsWith("127.0.0.1:8792/v1/jobs/")), probesSeen.join());
  assert.match(rec.verification!.detail, /job listener answers on port 8792/);
});

test("apply_config whose new ingress port is not listening is restored from the backup and restarted again", async () => {
  const original = `HOST=127.0.0.1\nPORT=8790\nORBIT_INGRESS_PORT=8791\n${SECRET_LINE}\n`;
  const w = world(original);
  await accept(w, "apply_config", OP, { changes: { ORBIT_INGRESS_PORT: 8792 } });
  w.script.onProbe = (_h, port, path) => (path !== "/status" && port === 8792 ? { reachable: false } : undefined);
  const rec = await run(w);
  assert.equal(rec.state, "restored");
  assert.equal(w.envText(), original, "the old file is back, byte for byte");
  assert.deepEqual(systemctlCalls(w), ["restart orbit.service", "restart orbit.service"]);
  assert.match(rec.summary!, /previous orbit\.env was restored/);
  assert.equal(rec.verification!.healthy, true);
  assert.ok(w.probes.some((p) => p === "127.0.0.1:8791/v1/jobs/healthcheck/steers"), "recovery checked the old listener port");
});

test("apply_config whose restart is unhealthy within the window restores the backup and says the recovery was verified", async () => {
  const w = world();
  const before = w.envText();
  await accept(w, "apply_config", OP, { changes: { ORBIT_MODEL: "broken-model" } });
  let restarts = 0;
  w.script.exec = (_f, a) => {
    if (a[0] === "restart") restarts++;
    w.script.served = restarts === 1 ? undefined : SHA_A; // down after the change, up after the restore
    return undefined;
  };
  const rec = await run(w);
  assert.equal(rec.state, "restored");
  assert.equal(w.envText(), before);
  assert.equal(restarts, 2);
  assert.match(rec.summary!, /never answered within 10s/);
});

test("apply_config where the recovery also fails is reported as restore_failed with where the backup is", async () => {
  const w = world();
  const before = w.envText();
  await accept(w, "apply_config", OP, { changes: { ORBIT_MODEL: "broken-model" } });
  w.script.served = undefined; // never healthy, before or after
  const rec = await run(w);
  assert.equal(rec.state, "restore_failed");
  assert.equal(rec.verification!.healthy, false);
  assert.match(rec.summary!, /recovery did NOT succeed/);
  assert.match(rec.summary!, new RegExp(`env-backup-${OP.slice(0, 12)}\\.env`));
  assert.equal(w.envText(), before, "the old file was still put back");
  assert.equal(readFileSync(join(w.root, "state", `env-backup-${OP.slice(0, 12)}.env`), "utf8"), before);
});

test("apply_config refuses without touching anything: ambiguous file, symlink, wrong port, no HOST/PORT", async () => {
  const cases: [string, object, RegExp][] = [
    [`HOST=127.0.0.1\nPORT=8790\nORBIT_MODEL=a\nORBIT_MODEL=b\n`, { ORBIT_MODEL: "c" }, /more than once/],
    [`HOST=127.0.0.1\nPORT=8790\n  ORBIT_MODEL=a\n`, { ORBIT_MODEL: "c" }, /form this action will not edit/],
    [`HOST=127.0.0.1\nPORT=8790\n`, { ORBIT_INGRESS_PORT: 8790 }, /must differ from PORT/],
    [`ORBIT_MODEL=a\n`, { ORBIT_MODEL: "c" }, /HOST and PORT could not be read/],
  ];
  for (const [text, changes, why] of cases) {
    const w = world(text);
    await accept(w, "apply_config", OP, { changes });
    const rec = await run(w);
    assert.equal(rec.state, "failed", text);
    assert.match(rec.summary!, why);
    assert.equal(w.envText(), text, "orbit.env untouched");
    assert.deepEqual(systemctlCalls(w), [], "no restart");
    assert.deepEqual(readdirSync(join(w.root, "state")), [], "no backup written for a refused change");
  }
  const w = world();
  const real = join(w.base, "real.env");
  writeFileSync(real, "HOST=127.0.0.1\nPORT=8790\n");
  execRm(w.envPath);
  symlinkSync(real, w.envPath);
  await accept(w, "apply_config", OP, { changes: { ORBIT_MODEL: "c" } });
  const rec = await run(w);
  assert.equal(rec.state, "failed");
  assert.match(rec.summary!, /not a plain file/);
});
import { rmSync } from "node:fs";
const execRm = (p: string) => rmSync(p, { force: true });

test("apply_config that changes nothing does not restart ORBIT", async () => {
  const w = world();
  await accept(w, "apply_config", OP, { changes: { ORBIT_MODEL: "old-model" } });
  const rec = await run(w);
  assert.equal(rec.state, "no_change");
  assert.deepEqual(systemctlCalls(w), []);
});

test("old config backups are pruned to the newest few", async () => {
  const w = world();
  w.cfg.keepBackups = 2;
  for (let i = 0; i < 4; i++) {
    const op = String(i + 3).repeat(40);
    await accept(w, "apply_config", op, { changes: { ORBIT_MODEL: `m${i}` } });
    await run(w, op);
  }
  assert.equal(readdirSync(join(w.root, "state")).filter((n) => n.startsWith("env-backup-")).length, 2);
});

// ---------------------------------------------------------------- deploy now, rollback, vault

test("deploy_now starts only the deploy unit and verifies the new commit is served", async () => {
  const w = world();
  await accept(w, "deploy_now");
  w.script.exec = (_f, a) => {
    if (a[0] === "start") {
      w.point(SHA_B); // the real unit switches the release
      w.script.served = SHA_B;
    }
    return undefined;
  };
  const rec = await run(w);
  assert.equal(rec.state, "verified");
  assert.deepEqual(systemctlCalls(w), ["start orbit-deploy.service"]);
  assert.match(rec.summary!, /Deployed bbbbbbbbbbbb \(was aaaaaaaaaaaa\)/);
  assert.equal(rec.verification!.expectedCommit, SHA_B);
});

test("deploy_now with nothing new is no_change, not success; a failed deploy is failed and reports what is served", async () => {
  const w = world();
  await accept(w, "deploy_now");
  const none = await run(w);
  assert.equal(none.state, "no_change");
  assert.match(none.summary!, /No new release was deployed/);

  const f = world();
  await accept(f, "deploy_now");
  f.script.exec = () => ({ code: 1, stdout: "", stderr: "", timedOut: false });
  const failed = await run(f);
  assert.equal(failed.state, "failed");
  assert.match(failed.summary!, /deploy failed \(exit 1\)/);
  assert.match(failed.summary!, /previous release is being served: aaaaaaaaaaaa/);

  const u = world();
  await accept(u, "deploy_now");
  u.script.exec = (_f, a) => {
    if (a[0] === "start") {
      u.point(SHA_B);
      u.script.served = SHA_A; // switched, but /status does not serve it
    }
    return undefined;
  };
  const unhealthy = await run(u);
  assert.equal(unhealthy.state, "failed");
  assert.match(unhealthy.summary!, /not healthy/);

  const t = world();
  await accept(t, "deploy_now");
  t.script.exec = () => ({ code: null, stdout: "", stderr: "", timedOut: true });
  const timed = await run(t);
  assert.equal(timed.state, "failed");
  assert.equal(timed.verification!.checked, false);
});

test("rollback_release runs only the installed script's --rollback and verifies the commit really changed and is served", async () => {
  const w = world();
  w.point(SHA_B);
  w.script.served = SHA_B;
  await accept(w, "rollback_release");
  w.script.exec = (f, a) => {
    if (f === w.cfg.pullDeploy) {
      w.point(SHA_A);
      w.script.served = SHA_A;
      return { code: 0, stdout: "rollback: rolled back\n", stderr: "", timedOut: false };
    }
    return undefined;
  };
  const rec = await run(w);
  assert.equal(rec.state, "verified");
  assert.deepEqual(w.execs.map(([f, a]) => [f, a]), [[ADMIN_CONFIG.pullDeploy, ["--rollback"]]]);
  assert.match(rec.summary!, /Rolled back from bbbbbbbbbbbb to aaaaaaaaaaaa/);
});

test("rollback_release failures are reported exactly: refused, success claimed but nothing changed, restored, unrestored", async () => {
  const mk = async (exit: number, stdout: string, after: (w: World) => void) => {
    const w = world();
    w.point(SHA_B);
    w.script.served = SHA_B;
    await accept(w, "rollback_release");
    w.script.exec = () => {
      after(w);
      return { code: exit, stdout, stderr: "", timedOut: false };
    };
    return run(w);
  };
  const refused = await mk(64, "rollback: refused: no earlier known-good release is available\n", () => {});
  assert.equal(refused.state, "failed");
  assert.match(refused.summary!, /refused: rollback: refused: no earlier known-good release/);
  assert.match(refused.summary!, /healthy on bbbbbbbbbbbb/);

  const lied = await mk(0, "ok\n", () => {});
  assert.equal(lied.state, "failed");
  assert.match(lied.summary!, /did not change/);
  assert.equal(lied.verification!.checked, false);

  const restored = await mk(1, "x\n", () => {});
  assert.equal(restored.state, "failed");
  assert.match(restored.summary!, /release that was running was restored/);

  const broken = await mk(2, "x\n", (w) => void (w.script.served = undefined));
  assert.equal(broken.state, "failed");
  assert.match(broken.summary!, /ROLLBACK FAILED/);
  assert.match(broken.summary!, /NOT healthy/);

  const switchedButDown = await mk(0, "ok\n", (w) => {
    w.point(SHA_A);
    w.script.served = undefined;
  });
  assert.equal(switchedButDown.state, "failed");
  assert.equal(switchedButDown.verification!.healthy, false);

  const busy = await mk(75, "", () => {});
  assert.match(busy.summary!, /lock/);
});

test("refresh_vault is verified only if the sync record was written during the run", async () => {
  const w = world();
  await accept(w, "refresh_vault");
  w.script.exec = (f) => {
    assert.equal(f, w.cfg.pullDeploy);
    writeFileSync(join(w.root, "state", "vault.json"), JSON.stringify({ commit: SHA_B, at: new Date(w.env.now().getTime() + 1000).toISOString() }));
    return undefined;
  };
  const rec = await run(w, OP, "vault");
  assert.equal(rec.state, "verified");
  assert.match(rec.summary!, /refreshed to bbbbbbbbbbbb/);
  assert.deepEqual(w.execs.map(([, a]) => a), [["--refresh-vault"]]);

  const stale = world();
  writeFileSync(join(stale.root, "state", "vault.json"), JSON.stringify({ commit: SHA_A, at: "2026-11-01T00:00:00Z" }));
  await accept(stale, "refresh_vault");
  const claimed = await run(stale, OP, "vault");
  assert.equal(claimed.state, "failed");
  assert.match(claimed.summary!, /state\/vault\.json was not updated/);

  const failed = world();
  await accept(failed, "refresh_vault");
  failed.script.exec = () => ({ code: 1, stdout: "deploy: vault refresh failed\n", stderr: "", timedOut: false });
  assert.equal((await run(failed, OP, "vault")).state, "failed");
});

// ---------------------------------------------------------------- bounds and audit

test("every step is audited, capped and redacted; the record keeps at most a bounded number of steps", async () => {
  const w = world();
  await accept(w, "rollback_release");
  w.point(SHA_B);
  w.script.served = SHA_B;
  w.script.exec = () => ({ code: 64, stdout: `${"x".repeat(5000)}\nrollback: refused: token=${SECRET_LINE_VALUE}\n`, stderr: "", timedOut: false });
  const rec = await run(w);
  const text = JSON.stringify([rec, w.audit]);
  assert.ok(!text.includes(SECRET_LINE_VALUE), "secrets in command output are redacted");
  assert.ok(rec.steps.every((s) => s.detail.length <= 201));
  assert.ok(rec.summary!.length <= 410);
  assert.ok(w.audit.length >= rec.steps.length);
  assert.ok(w.audit.every((l) => JSON.stringify(l).length < 700));
});

test("the front and the runner cannot be made to run anything but fixed commands", async () => {
  const w = world();
  for (const [action, extra] of [["restart_orbit", {}], ["deploy_now", {}], ["rollback_release", {}], ["refresh_vault", {}], ["apply_config", { changes: { ORBIT_MODEL: "gpt-5" } }]] as const) {
    const op = createHash("sha1").update(action).digest("hex");
    const x = world();
    await accept(x, action, op, extra);
    await run(x, op, action === "refresh_vault" ? "vault" : "ops");
    for (const [file, args] of x.execs) {
      assert.ok(["/usr/bin/systemctl", ADMIN_CONFIG.pullDeploy].includes(file), file);
      if (file === "/usr/bin/systemctl") {
        assert.ok(
          [`start --no-block orbit-ops-admin-run@${op}.service`, `start --no-block orbit-ops-admin-vault@${op}.service`, "restart orbit.service", "start orbit-deploy.service", `is-active orbit-ops-admin-run@${op}.service`].includes(args.join(" ")),
          args.join(" "),
        );
      } else assert.ok(["--rollback", "--refresh-vault"].includes(args[0]!));
    }
  }
  void w;
});

test("the record carries the type of every state and the action list is closed", () => {
  const rec: OpRecord = { opId: OP, action: "restart_orbit", state: "accepted", acceptedAt: "", updatedAt: "", steps: [] };
  assert.equal(rec.state, "accepted");
});

// ---------------------------------------------------------------- dead-runner detection: unit STATE, never the exit status
// A running Type=oneshot runner reports "activating" with exit 3. Only a clean inactive/failed settles a quiet record; any other,
// empty, timed-out or failed-to-run answer keeps it open and keeps its slot.
const isActiveIs = (w: World, e: Exec) => void (w.script.exec = (_f, a) => (a[0] === "is-active" ? e : undefined));
const opStatus = async (w: World) => JSON.parse(await handle(JSON.stringify({ action: "op_status", opId: OP }), w.env, () => {}, w.cfg)).data.operation;
const resp = (stdout: string, code: number | null = 3, timedOut = false): Exec => ({ code: code as never, stdout, stderr: "", timedOut });

for (const action of ["restart_orbit", "deploy_now", "rollback_release"]) {
  test(`dead runner: a long ${action} whose unit is activating (exit 3) stays open and keeps its slot`, async () => {
    const w = world();
    await accept(w, action);
    w.advance(10 * 60_000);
    isActiveIs(w, resp("activating\n"));
    assert.equal((await opStatus(w)).state, "accepted");
    assert.equal(existsSync(join(w.cfg.stateDir, "active")), true, "the slot is retained");
    const busy = JSON.parse(await handle(JSON.stringify({ action: "deploy_now", opId: OP2 }), w.env, () => {}, w.cfg));
    assert.equal(busy.error.code, "busy");
  });
}

test("dead runner: inactive or failed settles a quiet record; unknown, empty, garbled and errored answers never do", async () => {
  for (const s of ["inactive", "failed"]) {
    const w = world();
    await accept(w, "rollback_release");
    w.advance(60_000);
    isActiveIs(w, resp(`${s}\n`));
    assert.equal((await opStatus(w)).state, "interrupted", s);
    assert.equal(existsSync(join(w.cfg.stateDir, "active")), false, `${s}: slot freed`);
  }
  const live: [string, Exec][] = [
    ["active", resp("active\n", 0)], ["deactivating", resp("deactivating\n")], ["reloading", resp("reloading\n")], ["unknown", resp("maintenance\n")],
    ["empty", resp("")], ["garbled", resp("inactive-ish\n")], ["code null", resp("", null)], ["timed out", resp("", null, true)], ["timed out, inactive text", resp("inactive\n", 3, true)],
  ];
  for (const [label, e] of live) {
    const w = world();
    await accept(w, "restart_orbit");
    w.advance(10 * 60_000);
    isActiveIs(w, e);
    assert.equal((await opStatus(w)).state, "accepted", label);
    assert.equal(existsSync(join(w.cfg.stateDir, "active")), true, `${label}: slot kept`);
  }
});
