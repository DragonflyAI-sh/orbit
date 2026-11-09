// orbit-ops-admin-run: the runner for ONE accepted operation (orbit-ops-admin-run@<opId>.service and
// orbit-ops-admin-vault@<opId>.service). It is a separate systemd unit, so it keeps running while ORBIT restarts and after the
// request connection is gone. It loads the validated record the front wrote, does exactly that action with fixed commands, and
// verifies the outcome itself (it probes /status and reads the deployed commit) before it writes a terminal state.
// A command's exit status or "dispatched" is never recorded as verification.
//
// Credentials: nothing here reads /etc/credstore or any credential. orbit.env is treated as opaque text: only the five
// permitted settings (and HOST/PORT, read to find /status) are interpreted; every other line is copied byte for byte and never
// parsed, logged or returned.
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG_KEYS,
  OP_ID,
  cap,
  isTerminal,
  validateConfigChanges,
  type ConfigChanges,
  type ConfigKey,
  type OpRecord,
} from "./admin-protocol.ts";
import { ADMIN_CONFIG, activePath, addStep, loadRecord, saveRecord, systemAdminEnv, writeAtomic, type AdminConfig, type AdminEnv } from "./admin-core.ts";

const SYSTEMCTL = "/usr/bin/systemctl";
const SHA = /^[0-9a-f]{40}$/;
type Audit = (line: object) => void;
type Ctx = { env: AdminEnv; c: AdminConfig; rec: OpRecord; audit: Audit };

const step = (x: Ctx, name: string, detail: string) => addStep(x.c, x.rec, x.env, name, detail, x.audit);
const lastLines = (text: string, n = 3) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).map((l) => cap(l, 160)).join(" | ");

function currentCommit(c: AdminConfig): string | undefined {
  try {
    const v = readFileSync(`${c.root}/current/COMMIT`, "utf8").trim();
    return SHA.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// ---- orbit.env: opaque text; five settings are editable, everything else is preserved untouched ----

const TARGET = new Set<string>(CONFIG_KEYS);
export class EnvRefused extends Error {}

export type EnvEdit = { next: string; changed: ConfigKey[]; previous: Partial<Record<ConfigKey, string>> };

// Replaces or appends only the requested settings. Refuses (rather than guesses) when a target setting appears in any form other
// than a plain `KEY=value` line, twice, or on a continued line. Lines for other settings are never inspected beyond their name.
export function editEnv(text: string, changes: ConfigChanges): EnvEdit {
  if (text.includes("\u0000") || text.includes("\r")) throw new EnvRefused("orbit.env contains characters this action will not edit around (NUL or CR).");
  const lines = text.split("\n");
  const seen = new Map<ConfigKey, number>();
  const previous: Partial<Record<ConfigKey, string>> = {};
  const variant = new RegExp(`^\\s*(?:export\\s+)?(${CONFIG_KEYS.join("|")})\\s*=`);
  const exact = new RegExp(`^(${CONFIG_KEYS.join("|")})=(.*)$`);
  lines.forEach((line, i) => {
    const v = variant.exec(line);
    if (!v) return;
    const m = exact.exec(line);
    if (!m) throw new EnvRefused(`${v[1]} is written in a form this action will not edit (indented, exported or spaced). Fix it by hand first.`);
    const key = m[1] as ConfigKey;
    if (seen.has(key)) throw new EnvRefused(`${key} appears more than once in orbit.env; refusing to guess which one wins.`);
    if (line.endsWith("\\") || (i > 0 && lines[i - 1]!.endsWith("\\"))) throw new EnvRefused(`${key} is on a continued line; refusing to edit it.`);
    seen.set(key, i);
    previous[key] = m[2]!;
  });
  const changed: ConfigKey[] = [];
  const out = [...lines];
  const append: string[] = [];
  for (const key of CONFIG_KEYS) {
    const value = changes[key];
    if (value === undefined) continue;
    const at = seen.get(key);
    if (at === undefined) {
      append.push(`${key}=${value}`);
      changed.push(key);
    } else if (previous[key] !== value) {
      out[at] = `${key}=${value}`;
      changed.push(key);
    }
  }
  if (append.length) {
    if (out[out.length - 1] === "") out.pop();
    out.push(...append, "");
  }
  return { next: out.join("\n"), changed, previous };
}

// HOST and PORT, to reach /status. Nothing else is read out of the file.
function statusAddress(text: string): { host: string; port: number } | undefined {
  const get = (k: string) => new RegExp(`^${k}=([^\\s"'$\`\\\;]+)\\s*$`, "m").exec(text)?.[1];
  const h = get("HOST");
  const p = get("PORT");
  if (!h || !p || !/^[0-9]{1,5}$/.test(p) || !/^[A-Za-z0-9.:-]{1,253}$/.test(h)) return undefined;
  return { host: h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h, port: Number(p) };
}

function readOrbitEnv(c: AdminConfig): { text: string; mode: number } {
  const path = `${c.root}/orbit.env`;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new EnvRefused("orbit.env is not a plain file.");
  if (st.uid !== c.expectedUid || st.gid !== (process.getgid?.() ?? st.gid)) throw new EnvRefused("orbit.env is not owned by the expected user and group; replacing it could change who can read it.");
  if (st.size > 64 * 1024) throw new EnvRefused("orbit.env is larger than this action will handle.");
  return { text: readFileSync(path, "utf8"), mode: st.mode & 0o777 };
}

// ---- health ----

type Health = { healthy: boolean; served?: string; detail: string };

// Polls /status until it serves the expected commit, or the window ends. Healthy means exactly that: nothing else counts.
async function waitHealthy(x: Ctx, address: { host: string; port: number } | undefined, expected: string, ingressPort?: number): Promise<Health> {
  if (!address) return { healthy: false, detail: "HOST and PORT could not be read from orbit.env, so /status could not be checked." };
  const deadline = x.env.now().getTime() + x.c.healthWindowMs;
  let served: string | undefined;
  let reached = false;
  for (;;) {
    const p = await x.env.probe(address.host, address.port, "/status");
    reached = reached || p.reachable;
    served = p.commit ?? served;
    if (p.reachable && p.httpStatus === 200 && p.commit === expected) {
      if (ingressPort === undefined) return { healthy: true, served: p.commit, detail: `/status served ${p.commit.slice(0, 12)}.` };
      // The job listener answers 401 to a request without a job token; any other answer, or none, means it is not listening there.
      const q = await x.env.probe("127.0.0.1", ingressPort, "/v1/jobs/healthcheck/steers");
      if (q.reachable && q.httpStatus === 401) return { healthy: true, served: p.commit, detail: `/status served ${p.commit.slice(0, 12)} and the job listener answers on port ${ingressPort}.` };
      served = p.commit;
    }
    if (x.env.now().getTime() >= deadline) break;
    await x.env.sleep(x.c.healthIntervalMs);
  }
  const why = !reached ? "/status never answered" : served === expected ? `/status served the right commit but the job listener did not answer on port ${ingressPort}` : `/status served ${served ? served.slice(0, 12) : "no commit"}, expected ${expected.slice(0, 12)}`;
  return { healthy: false, ...(served ? { served } : {}), detail: `${why} within ${Math.round(x.c.healthWindowMs / 1000)}s.` };
}

function finish(x: Ctx, state: OpRecord["state"], summary: string, verification: NonNullable<OpRecord["verification"]>): void {
  x.rec.state = state;
  x.rec.summary = cap(summary, 400);
  x.rec.verification = { ...verification, detail: cap(verification.detail, 200) };
}

// ---- the five operations ----

async function restartOrbit(x: Ctx): Promise<void> {
  const expected = currentCommit(x.c);
  if (!expected) return finish(x, "failed", "Not restarted: the deployed commit could not be read, so a restart could not be verified.", { checked: false, detail: "No current/COMMIT." });
  const address = statusAddress(safeRead(`${x.c.root}/orbit.env`));
  step(x, "restart", `restarting ${x.c.units.service}; expecting /status to serve ${expected.slice(0, 12)}`);
  const r = await x.env.exec(SYSTEMCTL, ["restart", x.c.units.service], 120_000);
  step(x, "restart-command", r.timedOut ? "timed out" : `exit ${r.code}`);
  const h = await waitHealthy(x, address, expected);
  step(x, "verify", h.detail);
  if (h.healthy) return finish(x, "verified", `orbit.service restarted; /status is healthy and serves the same commit ${expected.slice(0, 12)}.`, { checked: true, healthy: true, expectedCommit: expected, servedCommit: h.served, detail: h.detail });
  finish(x, "failed", `orbit.service was restarted but ${h.detail} ORBIT may be down; nothing was rolled back.`, { checked: true, healthy: false, expectedCommit: expected, ...(h.served ? { servedCommit: h.served } : {}), detail: h.detail });
}

const safeRead = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

async function applyConfig(x: Ctx): Promise<void> {
  const { c } = x;
  const changes = validateConfigChanges(x.rec.changes); // the record is re-validated even though the front already did
  const expected = currentCommit(c);
  if (!expected) return finish(x, "failed", "No change made: the deployed commit could not be read, so the result could not be verified.", { checked: false, detail: "No current/COMMIT." });
  let original: { text: string; mode: number };
  let edit: EnvEdit;
  try {
    original = readOrbitEnv(c);
    edit = editEnv(original.text, changes);
  } catch (err) {
    if (err instanceof EnvRefused) return finish(x, "failed", `No change made: ${err.message}`, { checked: false, detail: "orbit.env was not modified." });
    throw err;
  }
  const address = statusAddress(edit.next);
  if (!address) return finish(x, "failed", "No change made: HOST and PORT could not be read from orbit.env, so /status could not be checked afterwards.", { checked: false, detail: "orbit.env was not modified." });
  if (changes.ORBIT_INGRESS_PORT !== undefined && Number(changes.ORBIT_INGRESS_PORT) === address.port) {
    return finish(x, "failed", "No change made: ORBIT_INGRESS_PORT must differ from PORT.", { checked: false, detail: "orbit.env was not modified." });
  }
  if (!edit.changed.length) return finish(x, "no_change", "orbit.env already has these values; nothing was changed and ORBIT was not restarted.", { checked: false, detail: "No restart; nothing to verify." });

  const backupName = `env-backup-${x.rec.opId.slice(0, 12)}.env`;
  const backup = `${c.root}/state/${backupName}`;
  writeAtomic(backup, original.text, 0o600);
  if (safeRead(backup) !== original.text) return finish(x, "failed", "No change made: the backup could not be verified.", { checked: false, detail: "orbit.env was not modified." });
  step(x, "backup", `old orbit.env saved as state/${backupName} (root-only)`);
  pruneBackups(c);

  writeAtomic(`${c.root}/orbit.env`, edit.next, original.mode);
  if (safeRead(`${c.root}/orbit.env`) !== edit.next) {
    writeAtomic(`${c.root}/orbit.env`, original.text, original.mode);
    return finish(x, "failed", "The new orbit.env did not read back as written; the old file was put back and ORBIT was not restarted.", { checked: false, detail: "Old file restored before any restart." });
  }
  step(x, "write", `changed: ${edit.changed.join(", ")}`);

  const ingress = changes.ORBIT_INGRESS_PORT !== undefined ? Number(changes.ORBIT_INGRESS_PORT) : undefined;
  const r = await x.env.exec(SYSTEMCTL, ["restart", c.units.service], 120_000);
  step(x, "restart-command", r.timedOut ? "timed out" : `exit ${r.code}`);
  const h = await waitHealthy(x, address, expected, ingress);
  step(x, "verify", h.detail);
  const changedList = edit.changed.join(", ");
  if (h.healthy) return finish(x, "verified", `Applied ${changedList}; restarted; ${h.detail}`, { checked: true, healthy: true, expectedCommit: expected, servedCommit: h.served, detail: h.detail });

  // Unhealthy: put the old file back, restart, and say honestly what that achieved.
  step(x, "restore", "new settings were not healthy; restoring the previous orbit.env");
  writeAtomic(`${c.root}/orbit.env`, original.text, original.mode);
  const restored = safeRead(`${c.root}/orbit.env`) === original.text;
  step(x, "restore-write", restored ? "previous orbit.env is back" : "previous orbit.env did not read back");
  const rr = await x.env.exec(SYSTEMCTL, ["restart", c.units.service], 120_000);
  step(x, "restart-command", rr.timedOut ? "timed out" : `exit ${rr.code}`);
  const oldIngress = edit.previous.ORBIT_INGRESS_PORT !== undefined && /^[0-9]{4,5}$/.test(edit.previous.ORBIT_INGRESS_PORT) ? Number(edit.previous.ORBIT_INGRESS_PORT) : undefined;
  const h2 = await waitHealthy(x, statusAddress(original.text), expected, oldIngress);
  step(x, "verify-restore", h2.detail);
  if (restored && h2.healthy) {
    return finish(x, "restored", `The new settings (${changedList}) were not healthy: ${h.detail} The previous orbit.env was restored, ORBIT restarted, and ${h2.detail}`, { checked: true, healthy: true, expectedCommit: expected, servedCommit: h2.served, detail: `Recovered: ${h2.detail}` });
  }
  finish(
    x,
    "restore_failed",
    `The new settings (${changedList}) were not healthy and recovery did NOT succeed: ${restored ? h2.detail : "the previous orbit.env could not be written back"} ORBIT may be down. The old file is saved as ${backup}; restore it by hand and restart orbit.service.`,
    { checked: true, healthy: false, expectedCommit: expected, ...(h2.served ? { servedCommit: h2.served } : {}), detail: h2.detail },
  );
}

function pruneBackups(c: AdminConfig): void {
  try {
    const dir = `${c.root}/state`;
    const files = readdirSync(dir)
      .filter((n) => /^env-backup-[0-9a-f]{12}\.env$/.test(n))
      .map((n) => ({ n, t: statSync(`${dir}/${n}`).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(c.keepBackups)) rmSync(`${dir}/${f.n}`, { force: true });
  } catch {
    // best effort
  }
}

async function deployNow(x: Ctx): Promise<void> {
  const before = currentCommit(x.c);
  step(x, "deploy", `starting ${x.c.units.deploy} (the same unit the timer starts); serving ${before ? before.slice(0, 12) : "unknown"}`);
  const r = await x.env.exec(SYSTEMCTL, ["start", x.c.units.deploy], 900_000);
  step(x, "deploy-command", r.timedOut ? "timed out" : `exit ${r.code}${r.stderr ? `: ${lastLines(r.stderr, 1)}` : ""}`);
  const after = currentCommit(x.c);
  const address = statusAddress(safeRead(`${x.c.root}/orbit.env`));
  if (r.timedOut) return finish(x, "failed", "The deploy unit did not finish in time. The outcome is unknown; check deploy_state.", { checked: false, detail: "Not verified." });
  if (!after) return finish(x, "failed", "The deployed commit could not be read after the deploy.", { checked: false, detail: "No current/COMMIT." });
  const h = await waitHealthy(x, address, after);
  step(x, "verify", h.detail);
  const ver = { checked: true, healthy: h.healthy, expectedCommit: after, ...(h.served ? { servedCommit: h.served } : {}), detail: h.detail };
  if (r.code !== 0) {
    return finish(x, "failed", `The deploy failed (exit ${r.code}). ${h.healthy ? `The previous release is being served: ${after.slice(0, 12)}.` : `And /status is not healthy: ${h.detail}`} See deploy_state.`, ver);
  }
  if (after === before) {
    return finish(x, "no_change", `No new release was deployed (already up to date, checks not green yet, or another deploy held the lock). ${h.healthy ? `/status serves ${after.slice(0, 12)}.` : `/status is not healthy: ${h.detail}`}`, ver);
  }
  if (!h.healthy) return finish(x, "failed", `Deployed ${after.slice(0, 12)} but /status is not healthy: ${h.detail}`, ver);
  finish(x, "verified", `Deployed ${after.slice(0, 12)} (was ${before ? before.slice(0, 12) : "unknown"}); /status serves it.`, ver);
}

async function rollbackRelease(x: Ctx): Promise<void> {
  const before = currentCommit(x.c);
  if (!before) return finish(x, "failed", "Not rolled back: the deployed commit could not be read.", { checked: false, detail: "No current/COMMIT." });
  step(x, "rollback", `running the deploy script's rollback from ${before.slice(0, 12)}`);
  const r = await x.env.exec(x.c.pullDeploy, ["--rollback"], 900_000);
  step(x, "rollback-command", `${r.timedOut ? "timed out" : `exit ${r.code}`}: ${lastLines(r.stdout)}`);
  const after = currentCommit(x.c);
  const address = statusAddress(safeRead(`${x.c.root}/orbit.env`));
  if (r.timedOut) return finish(x, "failed", "The rollback did not finish in time. The outcome is unknown; check deploy_state and orbit_status.", { checked: false, detail: "Not verified." });
  if (r.code === 0) {
    if (!after || after === before) return finish(x, "failed", "The script reported success but the deployed commit did not change, so nothing was verified.", { checked: false, detail: "current/COMMIT unchanged." });
    const h = await waitHealthy(x, address, after);
    step(x, "verify", h.detail);
    const ver = { checked: true, healthy: h.healthy, expectedCommit: after, ...(h.served ? { servedCommit: h.served } : {}), detail: h.detail };
    return h.healthy
      ? finish(x, "verified", `Rolled back from ${before.slice(0, 12)} to ${after.slice(0, 12)}; /status serves it.`, ver)
      : finish(x, "failed", `Switched to ${after.slice(0, 12)} but /status is not healthy: ${h.detail}`, ver);
  }
  // Any other exit: say exactly which, and check what is really being served now.
  const serving = after ?? before;
  const h = await waitHealthy(x, address, serving);
  step(x, "verify", h.detail);
  const ver = { checked: true, healthy: h.healthy, expectedCommit: serving, ...(h.served ? { servedCommit: h.served } : {}), detail: h.detail };
  const why =
    r.code === 64 ? `refused: ${lastLines(r.stdout, 1) || "no previous release can be used"}`
    : r.code === 75 ? "another deploy or rollback held the lock"
    : r.code === 1 ? "the previous release failed its health check; the release that was running was restored"
    : r.code === 2 ? "ROLLBACK FAILED and restoration could not be verified: an operator must recover by hand"
    : `the script failed (exit ${r.code})`;
  finish(x, "failed", `Not rolled back: ${why}. Now: ${h.healthy ? `/status is healthy on ${serving.slice(0, 12)}.` : `/status is NOT healthy: ${h.detail}`}`, ver);
}

async function refreshVault(x: Ctx): Promise<void> {
  const statePath = `${x.c.root}/state/vault.json`;
  const read = (): { commit?: string; at?: string } => {
    try {
      const v = JSON.parse(readFileSync(statePath, "utf8")) as { commit?: unknown; at?: unknown };
      return { ...(typeof v.commit === "string" && SHA.test(v.commit) ? { commit: v.commit } : {}), ...(typeof v.at === "string" ? { at: v.at } : {}) };
    } catch {
      return {};
    }
  };
  const before = read();
  const started = x.env.now().getTime();
  step(x, "vault", "running the deploy script's vault refresh (fast-forward pull of the read-only vault copy)");
  const r = await x.env.exec(x.c.pullDeploy, ["--refresh-vault"], 300_000);
  step(x, "vault-command", `${r.timedOut ? "timed out" : `exit ${r.code}`}: ${lastLines(r.stdout)}`);
  const after = read();
  const fresh = after.commit && after.at && Date.parse(after.at) >= started - 2000;
  if (r.code === 0 && fresh) {
    return finish(x, "verified", after.commit === before.commit ? `Vault copy refreshed; it was already at ${after.commit!.slice(0, 12)}.` : `Vault copy refreshed to ${after.commit!.slice(0, 12)} (was ${before.commit ? before.commit.slice(0, 12) : "unknown"}).`, { checked: true, healthy: true, servedCommit: after.commit, detail: `state/vault.json written at ${after.at}.` });
  }
  const why = r.timedOut ? "timed out" : r.code === 75 ? "another deploy or refresh held the lock" : r.code === 0 ? "the script reported success but state/vault.json was not updated" : `the script failed (exit ${r.code})`;
  finish(x, "failed", `Vault copy not refreshed: ${why}.`, { checked: true, healthy: false, detail: why });
}

// ---- driver ----

export async function runOperation(opId: string, group: "ops" | "vault", env: AdminEnv, c: AdminConfig, audit: Audit): Promise<OpRecord | undefined> {
  const rec = loadRecord(c, opId);
  if (!rec) return undefined;
  const x: Ctx = { env, c, rec, audit };
  if (rec.state !== "accepted") {
    audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), action: rec.action, step: "refused", detail: `already ${rec.state}; not run again` });
    return rec;
  }
  if ((rec.action === "refresh_vault") !== (group === "vault")) {
    rec.state = "failed";
    rec.summary = "This runner is not the right one for that action; nothing was done.";
    rec.finishedAt = env.now().toISOString();
    delete rec.changes;
    saveRecord(c, rec, env);
    return rec;
  }
  rec.state = "running";
  rec.startedAt = env.now().toISOString();
  step(x, "start", `running ${rec.action}`);
  try {
    switch (rec.action) {
      case "restart_orbit": await restartOrbit(x); break;
      case "apply_config": await applyConfig(x); break;
      case "deploy_now": await deployNow(x); break;
      case "rollback_release": await rollbackRelease(x); break;
      case "refresh_vault": await refreshVault(x); break;
    }
  } catch (err) {
    finish(x, "failed", `The runner hit an unexpected error (${cap(err instanceof Error ? err.message : "error", 80)}). The outcome is unknown; check the server.`, { checked: false, detail: "Not verified." });
  } finally {
    if (!isTerminal(rec.state)) finish(x, "failed", "The runner ended without a result.", { checked: false, detail: "Not verified." });
    rec.finishedAt = env.now().toISOString();
    delete rec.changes; // may have held trigger ids; the display form (masked) stays
    saveRecord(c, rec, env);
    try {
      if (readFileSync(activePath(c), "utf8").trim() === opId) rmSync(activePath(c), { force: true });
    } catch {
      // no slot
    }
    audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), action: rec.action, step: "result", detail: `${rec.state}: ${rec.summary ?? ""}`.slice(0, 300) });
  }
  return rec;
}

// restart_orbit and apply_config take the deploy lock for their whole run (so they cannot interleave with a timer deploy or a
// rollback), by re-running this program under flock. deploy_now and rollback must NOT hold it: the scripts take it themselves.
async function main(): Promise<void> {
  const [opId, group] = process.argv.slice(2);
  if (!opId || !OP_ID.test(opId) || (group !== "ops" && group !== "vault")) {
    process.stderr.write("orbit-ops-admin-run: usage: admin-run.ts <opId> ops|vault\n");
    process.exit(64);
  }
  const audit: Audit = (line) => process.stderr.write(`orbit-ops-admin-run ${JSON.stringify(line)}\n`);
  const rec = loadRecord(ADMIN_CONFIG, opId);
  const needsLock = rec?.state === "accepted" && (rec.action === "restart_orbit" || rec.action === "apply_config");
  if (needsLock && process.env.ORBIT_ADMIN_LOCKED !== "1") {
    const lock = `${ADMIN_CONFIG.root}/state/deploy.lock`;
    const code = await new Promise<number>((resolve) => {
      const child = execFile("/usr/bin/flock", ["-w", String(ADMIN_CONFIG.lockWaitSeconds), lock, process.execPath, "--max-old-space-size=64", fileURLToPath(import.meta.url), opId, group], { env: { ...process.env, ORBIT_ADMIN_LOCKED: "1" } }, (err) => {
        resolve(err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0);
      });
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    });
    const after = loadRecord(ADMIN_CONFIG, opId);
    if (code !== 0 && after && after.state === "accepted") {
      after.state = "failed";
      after.summary = "Not run: the deploy lock could not be taken in time (a deploy or rollback was running). Nothing was changed.";
      after.finishedAt = new Date().toISOString();
      after.verification = { checked: false, detail: "Nothing ran." };
      delete after.changes;
      saveRecord(ADMIN_CONFIG, after, systemAdminEnv);
      try {
        if (readFileSync(activePath(ADMIN_CONFIG), "utf8").trim() === opId) rmSync(activePath(ADMIN_CONFIG), { force: true });
      } catch {
        // no slot
      }
      audit({ at: new Date().toISOString(), opId: opId.slice(0, 12), action: after.action, step: "result", detail: `failed: ${after.summary}` });
    }
    process.exit(0);
  }
  const done = await runOperation(opId, group, systemAdminEnv, ADMIN_CONFIG, audit);
  process.exit(done ? 0 : 1);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) void main();

