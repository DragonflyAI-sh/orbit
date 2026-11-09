// Shared by the admin front (admin-helper.ts) and the runner (admin-run.ts): configuration, the thin host interface the tests
// replace, and the operation-record store. Records live in a root-only directory; every write is a temp file plus rename.
import { execFile } from "node:child_process";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { request } from "node:http";
import { cap, isTerminal, OP_ID, STEP_LIMIT, DETAIL_CHARS, type OpRecord } from "./admin-protocol.ts";
import { redactDeep } from "./protocol.ts";

export type AdminConfig = {
  root: string; // /opt/orbit
  stateDir: string; // /var/lib/orbit-ops-admin
  expectedUid: number; // the owner orbit.env must have (root)
  units: { service: string; deploy: string; runner: string; vaultRunner: string };
  pullDeploy: string; // the installed deploy script (root-owned, installed by the installer, not by deploys)
  healthWindowMs: number;
  healthIntervalMs: number;
  lockWaitSeconds: number;
  staleAfterMs: number;
  keepRecords: number;
  keepBackups: number;
};

export const ADMIN_CONFIG: AdminConfig = {
  root: "/opt/orbit",
  stateDir: "/var/lib/orbit-ops-admin",
  expectedUid: 0,
  units: { service: "orbit.service", deploy: "orbit-deploy.service", runner: "orbit-ops-admin-run@", vaultRunner: "orbit-ops-admin-vault@" },
  pullDeploy: "/usr/local/lib/orbit/pull-deploy.sh",
  healthWindowMs: 60_000,
  healthIntervalMs: 2_000,
  lockWaitSeconds: 300,
  staleAfterMs: 30_000,
  keepRecords: 50,
  keepBackups: 5,
};

export type Exec = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Probe = { reachable: boolean; httpStatus?: number; commit?: string };

// The only ways the helpers touch the host besides files. Every command is a fixed absolute path with fixed arguments;
// the single caller-influenced token is a validated 40-hex operation id that becomes a unit instance name.
export type AdminEnv = {
  exec(file: string, args: string[], timeoutMs: number): Promise<Exec>;
  // GET http://host:port/path. Reports the HTTP status and, for /status, the commit it names. Never throws.
  probe(host: string, port: number, path: string): Promise<Probe>;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

const MAX_OUT = 64 * 1024;

export const systemAdminEnv: AdminEnv = {
  exec: (file, args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_OUT, shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(e?.killed) });
      });
    }),
  probe: (host, port, path) =>
    new Promise((resolve) => {
      const req = request({ host, port, path, method: "GET", timeout: 4000 }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (body.length > 256 * 1024) res.destroy();
        });
        const done = () => {
          let commit: string | undefined;
          try {
            const c = (JSON.parse(body) as { commit?: unknown }).commit;
            if (typeof c === "string") commit = c;
          } catch {
            // not JSON: no commit
          }
          resolve({ reachable: true, httpStatus: res.statusCode, ...(commit ? { commit } : {}) });
        };
        res.on("end", done);
        res.on("error", () => resolve({ reachable: false }));
      });
      req.on("error", () => resolve({ reachable: false }));
      req.on("timeout", () => req.destroy());
      req.end();
    }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
};

// ---- operation records ----

export const opsDir = (c: AdminConfig) => `${c.stateDir}/ops`;
export const recordPath = (c: AdminConfig, opId: string) => `${opsDir(c)}/${opId}.json`;
export const activePath = (c: AdminConfig) => `${c.stateDir}/active`;

export function ensureDirs(c: AdminConfig): void {
  mkdirSync(opsDir(c), { recursive: true, mode: 0o700 });
  chmodSync(c.stateDir, 0o700);
}

export function writeAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function loadRecord(c: AdminConfig, opId: string): OpRecord | undefined {
  if (!OP_ID.test(opId)) return undefined;
  try {
    const v = JSON.parse(readFileSync(recordPath(c, opId), "utf8")) as OpRecord;
    return v && typeof v === "object" && v.opId === opId ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveRecord(c: AdminConfig, rec: OpRecord, env: AdminEnv): void {
  rec.updatedAt = env.now().toISOString();
  writeAtomic(recordPath(c, rec.opId), JSON.stringify(rec, null, 2));
}

// Append a capped, redacted step. The journal gets the same line, so every step of every request is audited.
export function addStep(c: AdminConfig, rec: OpRecord, env: AdminEnv, step: string, detail: string, audit: (line: object) => void): void {
  const s = { at: env.now().toISOString(), step: cap(step, 40), detail: cap(detail, DETAIL_CHARS) };
  if (rec.steps.length < STEP_LIMIT) rec.steps.push(s);
  else rec.steps[STEP_LIMIT - 1] = { ...s, detail: `${s.detail} (earlier steps dropped)`.slice(0, DETAIL_CHARS) };
  saveRecord(c, rec, env);
  audit({ at: s.at, opId: rec.opId.slice(0, 12), action: rec.action, step: s.step, detail: s.detail });
}

// Remove old finished records; never an unfinished one.
export function pruneRecords(c: AdminConfig): void {
  try {
    const names = readdirSync(opsDir(c)).filter((n) => /^[0-9a-f]{40}\.json$/.test(n));
    if (names.length <= c.keepRecords) return;
    const recs = names
      .map((n) => {
        try {
          return JSON.parse(readFileSync(`${opsDir(c)}/${n}`, "utf8")) as OpRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is OpRecord => Boolean(r) && isTerminal(r!.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const r of recs.slice(0, Math.max(0, names.length - c.keepRecords))) rmSync(recordPath(c, r.opId), { force: true });
  } catch {
    // pruning is best effort
  }
}

// What leaves the helper about an operation: bounded, redacted, and never the pending config values.
export function publicRecord(rec: OpRecord): unknown {
  const { changes: _changes, ...rest } = rec;
  return redactDeep({ ...rest, steps: rest.steps.slice(-12), ...(rest.summary ? { summary: cap(rest.summary, 400) } : {}) });
}
