import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChat } from "../src/agent.ts";
import { chatTools } from "../src/chat-tools.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { opsClient } from "../src/ops-client.ts";
import { CONFIG, handle, runAction, systemEnv } from "../src/ops/helper.ts";
import type { AuditRecord, Config, Env } from "../src/ops/helper.ts";
import { ACTIONS, LOG_LINES_MAX, LOG_TOTAL_CHARS, MAX_RESPONSE_BYTES, parseRequest, redact } from "../src/ops/protocol.ts";
import { decide } from "../src/policy.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NOW = new Date("2026-11-09T12:00:00Z");
// Synthetic secrets, shaped like real ones. None of them is a credential.
// They are assembled at runtime from short parts so that no credential-shaped
// literal appears in the source, which keeps the repository secret scan clean.
const part = (...p: string[]): string => p.join("");
const SECRETS = [
  part("sk", "-proj-", "A".repeat(24)),
  part("gh", "p_", "abcdefghijklmnopqrstuvwxyz", "0123456789"),
  part("ts", "key-auth-", "kABCDEF1234", "-", "abcdefghijklmnop"),
  part("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "abc123", "signature"),
  part("hunter", "2", "hunter", "2"),
  part("s3cr3t", "-pass-", "word"),
];
const KEY_BODY = part("MII", "EvQIBADANBgkqhkiG9w0BAQEFAASC");
const PEM = part("-----", "BEGIN PRIVATE", " KEY-----", "\n", KEY_BODY, "\n", "-----", "END PRIVATE", " KEY-----");

const st = (o: Partial<{ file: boolean; dir: boolean; link: boolean; size: number; mtimeMs: number; uid: number; mode: number }> = {}) => ({
  isFile: () => o.file ?? false,
  isDirectory: () => o.dir ?? false,
  isSymbolicLink: () => o.link ?? false,
  size: o.size ?? 0,
  mtimeMs: o.mtimeMs ?? Date.parse("2026-11-01T00:00:00Z"),
  uid: o.uid ?? 0,
  mode: o.mode ?? 0o755,
});

type Calls = { exec: [string, string[]][]; read: string[]; lstat: string[] };
function fakeEnv(over: Partial<Env> = {}): { env: Env; calls: Calls } {
  const calls: Calls = { exec: [], read: [], lstat: [] };
  const files: Record<string, string> = {
    "/opt/orbit/current/COMMIT": `${SHA_A}\n`,
    "/opt/orbit/state/deploy.json": JSON.stringify({
      lastDeployed: { commit: SHA_A, at: "2026-11-08T10:00:00Z", token: SECRETS[0] },
      lastFailed: { commit: SHA_B, at: "2026-11-07T10:00:00Z" },
    }),
    "/opt/orbit/state/vault.json": JSON.stringify({ commit: SHA_B, at: "2026-11-09T11:58:00Z" }),
    "/var/lib/update-notifier/updates-available": "12 updates can be applied immediately.\n3 of these updates are standard security updates.\n",
  };
  const env: Env = {
    exec: async (file, args) => {
      calls.exec.push([file, args]);
      if (file.endsWith("journalctl")) return { code: 0, stdout: "2026-11-09T11:00:00+0000 orbit[1]: started\n", stderr: "", timedOut: false };
      return { code: 0, stdout: "ActiveState=active\nSubState=running\nResult=success\nNRestarts=0\nEvil=x\n", stderr: "", timedOut: false };
    },
    localApi: async (socket, path) => {
      if (path.endsWith("status")) return { BackendState: "Running", Self: { HostName: socket.includes("jobs") ? "orbit-jobs" : "orbit", DNSName: "orbit-jobs.example.ts.net.", Online: true } };
      return { Web: { "orbit-jobs.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8791" } } } }, AllowFunnel: { "orbit-jobs.example.ts.net:443": true } };
    },
    readSmall: (path) => {
      calls.read.push(path);
      return files[path];
    },
    lstat: (p) => {
      calls.lstat.push(p);
      if (p === "/var/lib/update-notifier/updates-available") return st({ file: true });
      if (p === "/run/reboot-required") return st({ file: true });
      if (p.startsWith("/opt/orbit/releases/")) return st({ dir: true, mtimeMs: p.endsWith(SHA_A) ? 2000 : 1000 });
      if (p === "/etc/credstore") return st({ dir: true, mode: 0o700 });
      if (p.startsWith("/etc/credstore/")) return st({ file: true, size: 42 });
      return undefined;
    },
    readdir: (p) => (p === "/opt/orbit/releases" ? [SHA_B, SHA_A, "junk", "../x"] : p === "/opt/orbit/state" ? ["deploy.json", "rollback-failed-20261107T000000Z-1.json"] : p === "/etc/credstore" ? ["orbit.openai", "orbit.discord-webhook"] : undefined),
    readlink: (p) => (p === "/opt/orbit/current" ? `/opt/orbit/releases/${SHA_A}` : undefined),
    statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
    host: () => ({ totalMem: 1000, freeMem: 400, load: [0.1, 0.2, 0.3], uptimeSeconds: 3600.4 }),
    now: () => NOW,
    ...over,
  };
  return { env, calls };
}

const ask = async (raw: object | string, env: Env, c: Config = CONFIG) => {
  const audit: AuditRecord[] = [];
  const out = await handle(typeof raw === "string" ? raw : JSON.stringify(raw), env, (r) => audit.push(r), c);
  return { res: JSON.parse(out) as { ok: boolean; action?: string; data?: any; error?: { code: string; message: string } }, raw: out, audit };
};

// ---- every action ----

test("each of the seven actions answers with structured, minimal data", async () => {
  const { env } = fakeEnv();
  const data = async (action: string) => (await ask({ action }, env)).res.data;

  const status = await data("orbit_status");
  assert.equal(status.servingCommit, SHA_A);
  assert.deepEqual(status.systemd, { ActiveState: "active", SubState: "running", Result: "success", NRestarts: "0" }); // Evil=x is dropped

  const logs = await data("orbit_logs");
  assert.deepEqual([logs.requested, logs.returned], [50, 1]);

  const deploy = await data("deploy_state");
  assert.equal(deploy.deployedCommit, SHA_A);
  assert.deepEqual(deploy.lastDeployed, { commit: SHA_A, at: "2026-11-08T10:00:00Z" }); // the stray field is not passed through
  assert.deepEqual(deploy.lastFailure, { commit: SHA_B, at: "2026-11-07T10:00:00Z" });
  assert.deepEqual(deploy.releases.map((r: { commit: string }) => r.commit), [SHA_A, SHA_B]); // newest first, junk names ignored
  assert.equal(deploy.unresolvedRollbackFailures, 1);
  assert.equal(deploy.deployTimer.ActiveState, "active");

  const host = await data("host_health");
  assert.deepEqual(host.disk[0], { path: "/", totalBytes: 4096000, availableBytes: 1024000, usedPercent: 75 });
  assert.deepEqual(host.memory, { totalBytes: 1000, freeBytes: 400 });
  assert.equal(host.uptimeSeconds, 3600);
  assert.equal(host.pendingUpdates.count, 12);
  assert.equal(host.pendingUpdates.security, 3);
  assert.match(host.pendingUpdates.source, /not refreshed/);
  assert.equal(host.restartRequired, true);

  const ts = await data("tailscale_status");
  assert.equal(ts.host.reachable, true);
  assert.equal(ts.orbitJobs.funnel.enabledLocally, true);
  assert.deepEqual(ts.orbitJobs.funnel.proxyTargets, ["http://127.0.0.1:8791"]);

  const vault = await data("vault_sync");
  assert.deepEqual(vault, { commit: SHA_B, syncedAt: "2026-11-09T11:58:00Z", ageSeconds: 120 });

  const creds = await data("credentials");
  assert.deepEqual(creds[0].entries.map((e: { name: string }) => e.name), ["orbit.discord-webhook", "orbit.openai"]);
  assert.equal(creds[0].contentsRead, false);
});

test("host health says so when the update cache is absent, and never refreshes anything", async () => {
  const { env, calls } = fakeEnv({ readSmall: () => undefined, lstat: () => undefined });
  const { res } = await ask({ action: "host_health" }, env);
  assert.equal(res.data.pendingUpdates.available, false);
  assert.equal(res.data.restartRequired, false);
  assert.deepEqual(calls.exec, []); // no apt, no subprocess at all
});

test("unavailable pieces are reported as unavailable, not guessed", async () => {
  const { env } = fakeEnv({ readSmall: () => undefined, exec: async () => ({ code: 1, stdout: "", stderr: "x", timedOut: false }) });
  assert.equal((await ask({ action: "vault_sync" }, env)).res.data.available, false);
  assert.equal((await ask({ action: "orbit_logs" }, env)).res.data.available, false);
  assert.equal((await ask({ action: "orbit_status" }, env)).res.data.systemd.available, false);
  assert.equal((await ask({ action: "orbit_status" }, env)).res.data.servingCommit, null);
});

test("tailscale: an unreachable daemon is unavailable, and remote Funnel reachability is never claimed", async () => {
  const { env } = fakeEnv({ localApi: async () => { throw new Error("connect ENOENT /run/orbit-tailscale-jobs/tailscaled.sock"); } });
  const { res } = await ask({ action: "tailscale_status" }, env);
  assert.equal(res.data.orbitJobs.reachable, false);
  assert.equal(res.data.host.reachable, false);
  assert.equal(res.data.remoteFunnelReachability.checked, false);
  assert.match(res.data.remoteFunnelReachability.note, /NOT tested/);

  // Even when the local config says Funnel is on, the answer still says remote reachability was not checked.
  const ok = (await ask({ action: "tailscale_status" }, fakeEnv().env)).res.data;
  assert.equal(ok.orbitJobs.funnel.enabledLocally, true);
  assert.equal(ok.remoteFunnelReachability.checked, false);
});

// ---- unknown actions and malformed arguments ----

test("unknown actions, extra arguments and malformed requests are refused before anything runs", async () => {
  const { env, calls } = fakeEnv();
  const bad: [object | string, string][] = [
    [{ action: "shell" }, "unknown_action"],
    [{ action: "orbit_logs; rm -rf /" }, "unknown_action"],
    [{ action: "../../etc/passwd" }, "unknown_action"],
    [{ action: "read_file", path: "/etc/shadow" }, "unknown_action"],
    [{ action: "orbit_status", lines: 5 }, "bad_arguments"],
    [{ action: "credentials", path: "/etc/shadow" }, "bad_arguments"],
    [{ action: "orbit_logs", lines: 5, unit: "ssh.service" }, "bad_arguments"],
    [{ action: "orbit_logs", lines: "5; reboot" }, "bad_arguments"],
    [{ action: "orbit_logs", lines: "5" }, "bad_arguments"],
    [{ action: "orbit_logs", lines: 0 }, "bad_arguments"],
    [{ action: "orbit_logs", lines: -1 }, "bad_arguments"],
    [{ action: "orbit_logs", lines: 1.5 }, "bad_arguments"],
    [{ action: "orbit_logs", lines: LOG_LINES_MAX + 1 }, "bad_arguments"],
    [{ action: "orbit_logs", lines: null }, "bad_arguments"],
    [{ action: "orbit_logs", lines: [1] }, "bad_arguments"],
    [{ action: "orbit_logs", lines: 1e9 }, "bad_arguments"],
    [{ action: ["orbit_status"] }, "bad_request"],
    [{ action: 7 }, "bad_request"],
    [{}, "bad_request"],
    ["[]", "bad_request"],
    ["null", "bad_request"],
    ["not json", "bad_request"],
    ["", "bad_request"],
    [JSON.stringify({ action: "orbit_status", pad: "x".repeat(400) }), "request_too_large"],
  ];
  for (const [req, code] of bad) {
    const { res } = await ask(req, env);
    assert.equal(res.ok, false, JSON.stringify(req).slice(0, 80));
    assert.equal(res.error!.code, code, JSON.stringify(req).slice(0, 80));
  }
  assert.deepEqual(calls.exec, [], "no subprocess ran for any refused request");
  assert.deepEqual(calls.read, []);
  // `__proto__` and constructor tricks are plain unknown keys too.
  assert.equal((await ask('{"action":"orbit_status","__proto__":{"x":1}}', env)).res.error!.code, "bad_arguments");
});

test("the only caller input that reaches a command is a validated integer, and commands are fixed absolute paths without a shell", async () => {
  const { env, calls } = fakeEnv();
  for (const a of ACTIONS) await ask(a === "orbit_logs" ? { action: a, lines: 7 } : { action: a }, env);
  assert.ok(calls.exec.length >= 3);
  for (const [file] of calls.exec) assert.ok(["/usr/bin/systemctl", "/usr/bin/journalctl"].includes(file), file);
  const journal = calls.exec.find(([f]) => f.endsWith("journalctl"))![1];
  assert.deepEqual(journal, ["--unit", "orbit.service", "--lines", "7", "--no-pager", "--output", "short-iso", "--no-hostname", "--quiet"]);
  const src = readFileSync(new URL("../src/ops/helper.ts", import.meta.url), "utf8");
  assert.ok(!/shell:\s*true|child_process["'];?\s*$.*\bexec\(/m.test(src));
  assert.ok(src.includes("shell: false"));
  assert.ok(!/\bexecSync\b|\bspawnSync\b|\beval\(|new Function/.test(src));
});

// ---- bounds ----

test("log requests are bounded: line count, line length, total size, oversized journal output", async () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `2026-11-09T11:00:00+0000 orbit[1]: line ${i} ${"x ".repeat(3000)}`).join("\n");
  const { env } = fakeEnv({ exec: async () => ({ code: 0, stdout: huge, stderr: "", timedOut: false }) });
  const { res, raw } = await ask({ action: "orbit_logs", lines: LOG_LINES_MAX }, env);
  assert.equal(res.ok, true);
  assert.ok(res.data.returned <= LOG_LINES_MAX);
  assert.equal(res.data.truncated, true);
  assert.ok(res.data.lines.every((l: string) => l.length <= 201));
  assert.ok(res.data.lines.join("\n").length <= LOG_TOTAL_CHARS + res.data.lines.length);
  assert.ok(Buffer.byteLength(raw) <= MAX_RESPONSE_BYTES);
  assert.match(res.data.lines.at(-1), /line 4999/); // the newest lines are the ones kept
});

test("an oversized answer is dropped, not sent", async () => {
  const { env } = fakeEnv({ localApi: async () => ({ BackendState: "Running", Self: { DNSName: "a. ".repeat(60000) } }) });
  const { res, audit } = await ask({ action: "tailscale_status" }, env);
  assert.equal(res.ok, false);
  assert.equal(res.error!.code, "response_too_large");
  assert.equal(audit[0]!.outcome, "error");
  assert.ok(audit[0]!.bytes <= 1024);
});

test("a subprocess that times out is reported as unavailable", async () => {
  const { env } = fakeEnv({ exec: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
  assert.match((await ask({ action: "orbit_logs" }, env)).res.data.reason, /timed out/);
});

// ---- redaction ----

test("secrets are redacted from logs, errors and audit records", async () => {
  const lines = [
    `2026-11-09 orbit: calling with Authorization: Bearer ${SECRETS[0]}`,
    `2026-11-09 orbit: token=${SECRETS[1]} password=${SECRETS[4]}`,
    `2026-11-09 orbit: tailscale ${SECRETS[2]} jwt ${SECRETS[3]}`,
    `2026-11-09 orbit: fetch https://user:${SECRETS[5]}@example.com/x`,
    `2026-11-09 orbit: "apiKey":"${SECRETS[4]}" secret: ${SECRETS[5]}`,
    PEM,
    `2026-11-09 orbit: opaque ${"Zq9".repeat(20)} commit ${SHA_A}`,
  ];
  const { env } = fakeEnv({
    exec: async (file) => ({ code: 0, stdout: file.endsWith("journalctl") ? lines.join("\n") : "", stderr: "", timedOut: false }),
    localApi: async () => { throw new Error(`denied for ${SECRETS[1]} password=${SECRETS[4]}`); },
  });
  const logs = await ask({ action: "orbit_logs", lines: 100 }, env);
  const ts = await ask({ action: "tailscale_status" }, env);
  const bad = await ask(`{"action":"${SECRETS[0]}"}`, env);
  const everything = JSON.stringify([logs.raw, ts.raw, bad.raw, logs.audit, ts.audit, bad.audit]);
  for (const s of [...SECRETS, KEY_BODY, "Zq9".repeat(20)]) assert.ok(!everything.includes(s), `leaked ${s.slice(0, 12)}…`);
  assert.ok(logs.raw.includes(SHA_A), "a plain commit hash is not a secret");
  assert.match(logs.raw, /redacted/);
  assert.equal(bad.audit[0]!.action, "(none)");
});

test("audit records hold sanitized metadata only and cover every outcome", async () => {
  const { env } = fakeEnv();
  const a = await ask({ action: "orbit_logs", lines: 5 }, env);
  const b = await ask({ action: "nope", secret: SECRETS[0] }, env);
  assert.deepEqual(Object.keys(a.audit[0]!).sort(), ["action", "at", "bytes", "lines", "ms", "outcome"]);
  assert.equal(a.audit[0]!.outcome, "ok");
  assert.equal(b.audit[0]!.outcome, "rejected");
  assert.equal(b.audit[0]!.code, "unknown_action");
  assert.ok(!JSON.stringify(b.audit).includes(SECRETS[0]!));
  const boom = await ask({ action: "orbit_status" }, fakeEnv({ exec: async () => { throw new Error(`boom ${SECRETS[1]}`); } }).env);
  assert.equal(boom.audit[0]!.outcome, "error");
  assert.ok(!boom.raw.includes(SECRETS[1]!) && !JSON.stringify(boom.audit).includes(SECRETS[1]!));
});

test("redact leaves ordinary log text alone", () => {
  const t = "2026-11-09T11:00:00+0000 orbit[123]: listening on 100.64.0.1:8790 commit " + SHA_A;
  assert.equal(redact(t), t);
});

// ---- credentials: metadata only ----

test("credentials never read contents: no read is attempted on any credential path", async () => {
  const { env, calls } = fakeEnv();
  const out = (await ask({ action: "credentials" }, env)).raw;
  assert.ok(!calls.read.some((p) => p.startsWith("/etc/credstore")));
  assert.ok(calls.lstat.includes("/etc/credstore/orbit.openai"));
  assert.match(out, /"sizeBytes":42/);
  // The type of Env gives credential code no way to read: it only receives lstat/readdir.
  const src = readFileSync(new URL("../src/ops/helper.ts", import.meta.url), "utf8");
  const credFn = src.slice(src.indexOf("function credentials("), src.indexOf("export async function runAction"));
  assert.ok(!/readSmall|readFileSync|openSync|createReadStream|readFile/.test(credFn));
});

test("credentials on a real filesystem: names, sizes, dates only; symlinks and odd names are not followed or listed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-cred-"));
  chmodSync(dir, 0o755);
  const secret = part("SECRET", "-CONTENT-must-not-appear-", "12345");
  writeFileSync(join(dir, "orbit.openai"), secret);
  writeFileSync(join(dir, "has space"), secret);
  writeFileSync(join(dir, "has;semi"), secret);
  const target = join(mkdtempSync(join(tmpdir(), "ops-elsewhere-")), "other-secret");
  writeFileSync(target, secret);
  symlinkSync(target, join(dir, "orbit.link"));
  symlinkSync("/etc/shadow", join(dir, "orbit.shadow"));
  const reads: string[] = [];
  const env: Env = {
    ...systemEnv,
    readSmall: (p) => { reads.push(p); return undefined; },
    lstat: (p) => { const s = systemEnv.lstat(p); return s && ({ ...s, isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, uid: 0 }); },
  };
  const cfg = { ...CONFIG, credentialDirs: [dir] };
  const [d] = (await runAction("credentials", undefined, env, cfg)) as { entries: { name: string; type: string; sizeBytes?: number }[]; omittedNames: number }[];
  const names = d!.entries.map((e) => e.name);
  assert.deepEqual(names, ["orbit.link", "orbit.openai", "orbit.shadow"]);
  assert.equal(d!.entries.find((e) => e.name === "orbit.link")!.type, "symlink");
  assert.equal(d!.entries.find((e) => e.name === "orbit.link")!.sizeBytes, undefined);
  assert.equal(d!.entries.find((e) => e.name === "orbit.openai")!.sizeBytes, secret.length);
  assert.equal(d!.omittedNames, 2);
  assert.deepEqual(reads, []);
  const out = (await ask({ action: "credentials" }, env, cfg)).raw;
  assert.ok(!out.includes(secret) && !out.includes("other-secret") && !out.includes("/etc/shadow"));
});

test("a credential directory reached through a symlink, a writable directory or a non-root owner is refused", async () => {
  const base = mkdtempSync(join(tmpdir(), "ops-dir-"));
  const real = join(base, "real");
  mkdirSync(real);
  chmodSync(real, 0o755);
  writeFileSync(join(real, "orbit.key"), "x");
  const link = join(base, "link");
  symlinkSync(real, link);
  const root = (p: string) => { const s = systemEnv.lstat(p); return s && { ...s, isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, uid: 0 }; };
  const run = async (dirs: string[], lstat: Env["lstat"]) => (await runAction("credentials", undefined, { ...systemEnv, lstat }, { ...CONFIG, credentialDirs: dirs })) as { available: boolean; reason?: string }[];
  assert.match((await run([link], root))[0]!.reason!, /not a plain directory/);
  assert.match((await run([join(base, "../ops-no-such")], root))[0]!.reason!, /not present/);
  chmodSync(real, 0o775);
  assert.match((await run([real], root))[0]!.reason!, /writable/);
  chmodSync(real, 0o755);
  assert.match((await run([real], (p) => { const s = root(p); return s && { ...s, uid: 1000 }; }))[0]!.reason!, /not root-owned/);
  assert.equal((await run([real], root))[0]!.available, true);
  assert.ok(statSync(real).isDirectory());
});

test("no action accepts a path, so a caller cannot select what is inspected", () => {
  for (const key of ["path", "file", "dir", "unit", "command", "cmd", "args"]) {
    for (const a of ACTIONS) assert.throws(() => parseRequest(JSON.stringify({ action: a, [key]: "/etc/shadow" })), /Unexpected argument/);
  }
});

// ---- socket: client <-> helper over a real unix socket (the kernel enforces who may connect; see unit tests) ----

async function serve(fn: (line: string, write: (s: string) => void, end: () => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ops-sock-"));
  const path = join(dir, "ops.sock");
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) fn(buf.split("\n")[0]!, (s) => c.write(s), () => c.end());
    });
    c.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  chmodSync(path, 0o660);
  return { path, close: () => server.close() };
}

test("client and helper talk over a unix socket; the answer carries live provenance and the ops source", async () => {
  const { env } = fakeEnv();
  const s = await serve(async (line, write, end) => { write(`${await handle(line, env, () => {})}\n`); end(); });
  try {
    assert.equal(statSync(s.path).mode & 0o777, 0o660);
    const r = await opsClient(s.path).call("vault_sync");
    assert.equal(r.provenance, "live");
    assert.equal(r.source, "ops/vault_sync");
    assert.equal((r.value as { ageSeconds: number }).ageSeconds, 120);
    assert.equal(((await opsClient(s.path).call("orbit_logs", { lines: 3 })).value as { requested: number }).requested, 3);
  } finally { s.close(); }
});

test("client refuses bad calls before connecting, and explains an absent helper or a permission failure", async () => {
  const c = opsClient("/nonexistent/orbit-ops.sock");
  await assert.rejects(c.call("orbit_logs", { lines: 9999 }), /lines must be/);
  await assert.rejects(c.call("orbit_status", { path: "/etc/shadow" }), /Unexpected argument/);
  await assert.rejects(c.call("shell" as never), /Unknown action/);
  await assert.rejects(c.call("orbit_status"), /not available: the helper socket is not there/);
  const dir = mkdtempSync(join(tmpdir(), "ops-notsock-"));
  writeFileSync(join(dir, "plain"), "");
  await assert.rejects(opsClient(join(dir, "plain")).call("orbit_status"), /not available|could not be reached|refused access/);
});

test("client rejects oversized, mismatched, garbled and slow helper answers", async () => {
  const big = await serve((_l, write, end) => { write("x".repeat(MAX_RESPONSE_BYTES * 2)); end(); });
  const other = await serve((_l, write, end) => { write(`${JSON.stringify({ ok: true, action: "host_health", data: {} })}\n`); end(); });
  const junk = await serve((_l, write, end) => { write("not json\n"); end(); });
  const refused = await serve((_l, write, end) => { write(`${JSON.stringify({ ok: false, error: { code: "unknown_action", message: `no ${SECRETS[1]}` } })}\n`); end(); });
  const slow = await serve(() => {});
  try {
    await assert.rejects(opsClient(big.path).call("orbit_status"), /more than the response limit/);
    await assert.rejects(opsClient(other.path).call("orbit_status"), /could not understand/);
    await assert.rejects(opsClient(junk.path).call("orbit_status"), /could not understand/);
    await assert.rejects(opsClient(refused.path).call("orbit_status"), (e: Error) => /refused/.test(e.message) && !e.message.includes(SECRETS[1]!));
    await assert.rejects(opsClient(slow.path, 200).call("orbit_status"), /did not answer in time/);
  } finally { for (const s of [big, other, junk, refused, slow]) s.close(); }
});

// ---- chat tools, policy, provenance ----

const NAMES = ["ops_orbit_status", "ops_orbit_logs", "ops_deploy_state", "ops_host_health", "ops_tailscale_status", "ops_vault_sync", "ops_credentials"];
const fakeOps = () => {
  const seen: [string, unknown][] = [];
  return { seen, ops: { call: async (a: string, args?: Record<string, unknown>) => (seen.push([a, args]), { value: { ok: a }, provenance: "live" as const, source: `ops/${a}` }) } as never };
};
const tools = (ops?: never) => chatTools({ memory: {} as never, toolbox: {} as never, notify: {} as never, proposals: new Proxy({}, { get: () => { throw new Error("no proposal may be created for a read"); } }) as never, launchable: () => ({ routines: [] }), ops });

test("one chat tool per action, none without the helper, each strictly typed", () => {
  assert.ok(!tools().some((t) => t.name.startsWith("ops_")));
  const t = tools(fakeOps().ops).filter((x) => x.name.startsWith("ops_"));
  assert.deepEqual(t.map((x) => x.name), NAMES);
  for (const x of t) {
    const p = x.parameters as { additionalProperties: boolean; properties: Record<string, { type: string; maximum?: number }> };
    assert.equal(p.additionalProperties, false);
    assert.deepEqual(Object.keys(p.properties), x.name === "ops_orbit_logs" ? ["lines"] : []);
  }
  assert.equal((t[1]!.parameters as { properties: { lines: { maximum: number } } }).properties.lines.maximum, LOG_LINES_MAX);
});

test("owner-only through the existing policy, with no confirmation step", () => {
  for (const n of NAMES) {
    assert.equal(decide("agent", n, true).allow, true);
    assert.equal(decide("agent", n, false).allow, false);
  }
});

test("a chat call runs directly: provenance and source reach the reply record; extra arguments never reach the helper", async () => {
  const { ops, seen } = fakeOps();
  const list = tools(ops);
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "", verifiedAt: NOW.toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
    step: (() => {
      let i = 0;
      const script: Step[] = [
        { text: "", calls: [{ call_id: "1", name: "ops_orbit_logs", arguments: JSON.stringify({ lines: 5 }) }, { call_id: "2", name: "ops_orbit_logs", arguments: JSON.stringify({ lines: 5, path: "/etc/shadow" }) }, { call_id: "3", name: "ops_credentials", arguments: JSON.stringify({ path: "/etc" }) }, { call_id: "4", name: "ops_host_health", arguments: "{}" }] },
        { text: "done", calls: [] },
      ];
      return async (_i: Item[]) => script[i++]!;
    })(),
  };
  const out = await runChat({ model, messages: [{ role: "user", content: "go" }], limits: [], tools: list, allow: (t) => { const d = decide("agent", t, true); return d.allow ? undefined : d.reason; } });
  assert.deepEqual(out.calls.map((c) => c.ok), [true, false, false, true]);
  assert.deepEqual([out.calls[0]!.provenance, out.calls[0]!.source], ["live", "ops/orbit_logs"]);
  assert.equal(out.calls[3]!.source, "ops/host_health");
  assert.deepEqual(seen, [["orbit_logs", { lines: 5 }], ["host_health", undefined]]);
});

test("a non-owner is refused by the same hook and nothing reaches the helper", async () => {
  const { ops, seen } = fakeOps();
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "", verifiedAt: NOW.toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
    step: (() => { let i = 0; const s: Step[] = [{ text: "", calls: [{ call_id: "1", name: "ops_credentials", arguments: "{}" }] }, { text: "no", calls: [] }]; return async () => s[i++]!; })(),
  };
  const out = await runChat({ model, messages: [{ role: "user", content: "go" }], limits: [], tools: tools(ops), allow: (t) => { const d = decide("agent", t, false); return d.allow ? undefined : d.reason; } });
  assert.equal(out.calls[0]!.ok, false);
  assert.deepEqual(seen, []);
});

// ---- units, installer, socket access assumptions ----

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the socket is reachable only by root and group orbit-ops, and the ORBIT service joins that group", () => {
  const socket = read("deploy/systemd/orbit-ops.socket");
  assert.match(socket, /^ListenStream=\/run\/orbit-ops\.sock$/m);
  assert.match(socket, /^SocketUser=root$/m);
  assert.match(socket, /^SocketGroup=orbit-ops$/m);
  assert.match(socket, /^SocketMode=0660$/m); // no "other" bits
  assert.match(socket, /^Accept=yes$/m);
  assert.match(socket, /^MaxConnections=\d$/m);
  assert.match(read("deploy/systemd/orbit.service"), /^SupplementaryGroups=.*\borbit-ops\b/m);
  assert.ok(!/orbit-ops/.test(read("deploy/systemd/orbit-deploy.service")));
  assert.equal(opsClientDefault(), "/run/orbit-ops.sock");
});
const opsClientDefault = () => /ListenStream=(\S+)/.exec(read("deploy/systemd/orbit-ops.socket"))![1];

test("the helper unit is sandboxed, bounded, read-only and runs fixed code", () => {
  const u = read("deploy/systemd/orbit-ops@.service");
  for (const re of [/^ProtectSystem=strict$/m, /^NoNewPrivileges=yes$/m, /^PrivateNetwork=yes$/m, /^PrivateTmp=yes$/m, /^ProtectHome=yes$/m, /^RestrictAddressFamilies=AF_UNIX$/m, /^CapabilityBoundingSet=CAP_DAC_READ_SEARCH$/m, /^SystemCallFilter=@system-service$/m, /^MemoryMax=\d+M$/m, /^TasksMax=\d+$/m, /^RuntimeMaxSec=\d+$/m, /^StandardInput=socket$/m]) {
    assert.match(u, re);
  }
  assert.ok(!/^ReadWritePaths=/m.test(u), "nothing is writable");
  assert.match(u, /^ExecStart=\/usr\/local\/bin\/node .*\/usr\/local\/lib\/orbit\/ops\/helper\.ts$/m); // not from a deployable release dir
  assert.ok(!/\/opt\/orbit/.test(u.split("\n").filter((l) => l.startsWith("ExecStart")).join()));
  assert.ok(!/^(Environment|EnvironmentFile|ImportCredential|LoadCredential)=/m.test(u), "no credentials or environment");
});

test("the installer creates the group, installs the helper root-owned, and enables the socket; normal deploy does not", () => {
  const i = read("deploy/install.sh");
  assert.match(i, /groupadd --system orbit-ops/);
  assert.ok(i.indexOf("groupadd --system orbit-ops") < i.indexOf("systemctl restart orbit.service"));
  assert.match(i, /install -d -m 755 -o root -g root \/usr\/local\/lib\/orbit\/ops/);
  assert.match(i, /-o root -g root .*src\/ops\/helper\.ts.*src\/ops\/protocol\.ts \/usr\/local\/lib\/orbit\/ops\//);
  assert.match(i, /orbit-ops\.socket.*orbit-ops@\.service/);
  assert.match(i, /systemctl enable orbit-ops\.socket/);
  const deploy = read("deploy/pull-deploy.sh");
  assert.ok(!/orbit-ops/.test(deploy), "the app deploy never touches the root helper");
});
