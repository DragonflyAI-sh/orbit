// orbit-ops: the root helper behind /run/orbit-ops.sock. systemd accepts each connection (orbit-ops.socket, Accept=yes) and runs
// one short-lived instance with the connection as stdin/stdout. The kernel decides who may connect (socket mode 0660,
// group orbit-ops); this process then answers one request and exits.
//
// Tier 1 only: fixed, named, read-only actions. There is no generic file reader, no shell, no caller-chosen path or command.
// The only caller input that reaches an argument is `lines`, a validated integer. Everything returned is structured and
// minimal, and passed through redact() first. The sole write is the audit line on stderr (the journal).
import { execFile } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, statfsSync } from "node:fs";
import { request } from "node:http";
import { freemem, loadavg, totalmem, uptime } from "node:os";
import { fileURLToPath } from "node:url";
import {
  LOG_LINES_DEFAULT,
  LOG_LINE_CHARS,
  LOG_TOTAL_CHARS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  OpsReject,
  parseRequest,
  redact,
  redactDeep,
  type Action,
  type OpsResponse,
} from "./protocol.ts";

export type Config = {
  root: string; // /opt/orbit
  credentialDirs: string[]; // trusted, fixed locations; only entry metadata is ever read
  tailscaleSockets: { host: string; jobs: string };
  updatesFile: string; // existing update-notifier cache; never refreshed here
  rebootFile: string;
  units: { service: string; deployTimer: string };
  maxCredentialEntries: number;
};

export const CONFIG: Config = {
  root: "/opt/orbit",
  credentialDirs: ["/etc/credstore"],
  tailscaleSockets: { host: "/run/tailscale/tailscaled.sock", jobs: "/run/orbit-tailscale-jobs/tailscaled.sock" },
  updatesFile: "/var/lib/update-notifier/updates-available",
  rebootFile: "/run/reboot-required",
  units: { service: "orbit.service", deployTimer: "orbit-deploy.timer" },
  maxCredentialEntries: 50,
};

type Exec = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
type Stat = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number; uid: number; mode: number };

// Everything the actions touch. Credential metadata gets lstat/readdir only: there is no read function for it to call.
export type Env = {
  exec(file: string, args: string[]): Promise<Exec>;
  localApi(socket: string, path: string): Promise<unknown>;
  readSmall(path: string, maxBytes: number): string | undefined; // fixed state files only, never credentials
  lstat(path: string): Stat | undefined;
  readdir(path: string): string[] | undefined;
  readlink(path: string): string | undefined;
  statfs(path: string): { bsize: number; blocks: number; bavail: number } | undefined;
  host(): { totalMem: number; freeMem: number; load: number[]; uptimeSeconds: number };
  now(): Date;
};

const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 256 * 1024;
const SYSTEMCTL = "/usr/bin/systemctl";
const JOURNALCTL = "/usr/bin/journalctl";

export const systemEnv: Env = {
  exec: (file, args) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : null) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: Boolean(e?.killed),
        });
      });
    }),
  localApi: (socket, path) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, path, headers: { host: "local-tailscaled.sock" }, timeout: 3000 }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (body.length > 256 * 1024) res.destroy(new Error("response too large"));
        });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error(`tailscaled answered HTTP ${res.statusCode}`);
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("tailscaled did not answer")));
      req.end();
    }),
  readSmall: (path, maxBytes) => {
    try {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        return buf.subarray(0, readSync(fd, buf, 0, maxBytes, 0)).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  },
  lstat: (p) => {
    try {
      return lstatSync(p);
    } catch {
      return undefined;
    }
  },
  readdir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return undefined;
    }
  },
  readlink: (p) => {
    try {
      return readlinkSync(p);
    } catch {
      return undefined;
    }
  },
  statfs: (p) => {
    try {
      return statfsSync(p);
    } catch {
      return undefined;
    }
  },
  host: () => ({ totalMem: totalmem(), freeMem: freemem(), load: loadavg(), uptimeSeconds: uptime() }),
  now: () => new Date(),
};

// ---- small helpers ----

type Unavailable = { available: false; reason: string };
const unavailable = (reason: string): Unavailable => ({ available: false, reason });
const iso = (ms: number) => new Date(ms).toISOString();
const SHA = /^[0-9a-f]{40}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// `systemctl show -p A,B`: key=value lines. Only the requested keys and short, plain values come back.
async function unitProps(env: Env, unit: string, props: string[]): Promise<Record<string, string> | Unavailable> {
  const r = await env.exec(SYSTEMCTL, ["show", unit, "--no-pager", `--property=${props.join(",")}`]);
  if (r.timedOut) return unavailable("systemctl timed out");
  if (r.code !== 0) return unavailable("systemctl could not report this unit");
  const out: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i);
    if (!props.includes(key)) continue;
    const value = line.slice(i + 1);
    out[key] = /^[\w .:+,/()-]{0,80}$/.test(value) ? value : "[unrecognised]";
  }
  return out;
}

function readState(env: Env, path: string): Record<string, unknown> | undefined {
  const text = env.readSmall(path, 4096);
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// {commit, at} where both are validated shapes; anything else is dropped rather than passed through.
function commitAt(v: unknown): { commit: string; at: string } | undefined {
  const o = v as { commit?: unknown; at?: unknown } | undefined;
  return o && typeof o.commit === "string" && SHA.test(o.commit) && typeof o.at === "string" && ISO_TS.test(o.at) ? { commit: o.commit, at: o.at } : undefined;
}

// ---- actions ----

async function orbitStatus(env: Env, c: Config) {
  const props = await unitProps(env, c.units.service, ["ActiveState", "SubState", "Result", "NRestarts", "ActiveEnterTimestamp"]);
  const current = env.readSmall(`${c.root}/current/COMMIT`, 64)?.trim();
  return { unit: c.units.service, systemd: props, servingCommit: current && SHA.test(current) ? current : null };
}

async function orbitLogs(env: Env, c: Config, lines: number) {
  const r = await env.exec(JOURNALCTL, ["--unit", c.units.service, "--lines", String(lines), "--no-pager", "--output", "short-iso", "--no-hostname", "--quiet"]);
  if (r.timedOut) return unavailable("journalctl timed out");
  if (r.code !== 0) return unavailable("journalctl could not read the log");
  let out = r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .slice(-lines)
    .map((l) => redact(l.length > LOG_LINE_CHARS ? `${l.slice(0, LOG_LINE_CHARS)}…` : l));
  let total = 0;
  const kept: string[] = [];
  for (let i = out.length - 1; i >= 0; i--) {
    total += out[i]!.length + 1;
    if (total > LOG_TOTAL_CHARS) break;
    kept.unshift(out[i]!);
  }
  const truncated = kept.length < out.length;
  out = kept;
  return { requested: lines, returned: out.length, truncated, lines: out };
}

async function deployState(env: Env, c: Config) {
  const state = readState(env, `${c.root}/state/deploy.json`);
  const releasesDir = `${c.root}/releases`;
  const names = env.readdir(releasesDir);
  const releases = (names ?? [])
    .filter((n) => SHA.test(n))
    .map((n) => ({ commit: n, modified: env.lstat(`${releasesDir}/${n}`)?.mtimeMs }))
    .filter((r): r is { commit: string; modified: number } => r.modified !== undefined)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 10)
    .map((r) => ({ commit: r.commit, modified: iso(r.modified) }));
  const target = env.readlink(`${c.root}/current`);
  const currentName = target?.split("/").filter(Boolean).at(-1);
  const rollbackFailures = (env.readdir(`${c.root}/state`) ?? []).filter((n) => /^rollback-failed-[\w-]+\.json$/.test(n)).length;
  const timer = await unitProps(env, c.units.deployTimer, ["ActiveState", "SubState", "NextElapseUSecRealtime", "LastTriggerUSec"]);
  return {
    deployedCommit: currentName && SHA.test(currentName) ? currentName : null,
    lastDeployed: commitAt(state?.lastDeployed) ?? null,
    lastFailure: commitAt(state?.lastFailed) ?? null,
    stateFile: state ? "readable" : "missing or unreadable",
    releases: names ? releases : unavailable("releases directory unreadable"),
    unresolvedRollbackFailures: rollbackFailures,
    deployTimer: timer,
  };
}

function hostHealth(env: Env, c: Config) {
  const disk = (path: string) => {
    const s = env.statfs(path);
    return s ? { path, totalBytes: s.bsize * s.blocks, availableBytes: s.bsize * s.bavail, usedPercent: s.blocks ? Math.round((1 - s.bavail / s.blocks) * 100) : 0 } : unavailable("statfs failed");
  };
  const h = env.host();
  const updates = env.readSmall(c.updatesFile, 2048);
  // update-notifier writes "N updates can be applied immediately." and "M of these updates are security updates."
  const n = updates?.match(/^(\d+) (?:updates?|packages?) can be (?:applied|updated)/m);
  const sec = updates?.match(/^(\d+) of these updates are standard security updates/m);
  const reboot = env.lstat(c.rebootFile) !== undefined;
  return {
    disk: [disk("/"), disk(c.root)],
    memory: { totalBytes: h.totalMem, freeBytes: h.freeMem },
    loadAverage: { "1m": h.load[0], "5m": h.load[1], "15m": h.load[2] },
    uptimeSeconds: Math.round(h.uptimeSeconds),
    pendingUpdates: n
      ? { count: Number(n[1]), security: sec ? Number(sec[1]) : null, source: "existing update-notifier cache (not refreshed)", cacheModified: iso(env.lstat(c.updatesFile)?.mtimeMs ?? 0) }
      : unavailable("no update-notifier cache on this host; nothing was refreshed or installed"),
    restartRequired: reboot,
  };
}

type ServeConfig = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
type TsStatus = { BackendState?: string; Version?: string; Self?: { HostName?: string; DNSName?: string; Online?: boolean } };

async function oneNode(env: Env, socket: string) {
  try {
    const status = (await env.localApi(socket, "/localapi/v0/status")) as TsStatus;
    const self = status.Self;
    const out: Record<string, unknown> = {
      reachable: true,
      backendState: typeof status.BackendState === "string" ? status.BackendState : "unknown",
      hostName: self?.HostName ?? null,
      dnsName: typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : null,
      online: self?.Online ?? null,
    };
    try {
      const serve = (await env.localApi(socket, "/localapi/v0/serve-config")) as ServeConfig;
      const funnel = Object.entries(serve.AllowFunnel ?? {}).filter(([, on]) => on === true).map(([hostPort]) => hostPort);
      const proxies = Object.values(serve.Web ?? {}).flatMap((w) => Object.values(w.Handlers ?? {}).map((h) => h.Proxy).filter((p): p is string => typeof p === "string"));
      out.funnel = { enabledLocally: funnel.length > 0, hostPorts: funnel.slice(0, 5), proxyTargets: proxies.slice(0, 5) };
    } catch {
      out.funnel = unavailable("serve configuration could not be read from the local tailscaled");
    }
    return out;
  } catch (err) {
    return { reachable: false, reason: `local tailscaled did not answer: ${err instanceof Error ? err.message : "error"}` };
  }
}

async function tailscaleStatus(env: Env, c: Config) {
  return {
    host: await oneNode(env, c.tailscaleSockets.host),
    orbitJobs: await oneNode(env, c.tailscaleSockets.jobs),
    remoteFunnelReachability: {
      checked: false,
      note: "Only the local tailscaled's own configuration was read. Whether orbit-jobs is reachable from the public internet through Funnel was NOT tested, and 'enabledLocally' does not prove it.",
    },
  };
}

function vaultSync(env: Env, c: Config) {
  const v = commitAt(readState(env, `${c.root}/state/vault.json`));
  if (!v) return unavailable("no valid vault sync record (state/vault.json)");
  const ageSeconds = Math.max(0, Math.round((env.now().getTime() - Date.parse(v.at)) / 1000));
  return { commit: v.commit, syncedAt: v.at, ageSeconds };
}

// Filenames, sizes and dates only, from fixed trusted directories. Never opens, reads or redacts file contents. Symlinks are
// reported as symlinks and not followed (so a link cannot point this at another path); odd names are counted, not listed.
function credentials(env: Env, c: Config) {
  return c.credentialDirs.map((dir) => {
    const st = env.lstat(dir);
    if (!st) return { directory: dir, ...unavailable("directory not present or not readable") };
    if (st.isSymbolicLink() || !st.isDirectory()) return { directory: dir, ...unavailable("refused: not a plain directory (symlinks are not followed)") };
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) return { directory: dir, ...unavailable("refused: directory is not root-owned or is group/world writable") };
    const names = env.readdir(dir);
    if (!names) return { directory: dir, ...unavailable("directory could not be listed") };
    const safe = names.filter((n) => /^[A-Za-z0-9._-]{1,64}$/.test(n) && n !== "." && n !== "..");
    const entries = safe.slice(0, c.maxCredentialEntries).sort().map((name) => {
      const e = env.lstat(`${dir}/${name}`);
      if (!e) return { name, type: "missing" };
      if (e.isSymbolicLink()) return { name, type: "symlink", note: "not followed" };
      if (!e.isFile()) return { name, type: "other" };
      return { name, type: "file", sizeBytes: e.size, modified: iso(e.mtimeMs) };
    });
    return { directory: dir, available: true, entries, omittedNames: names.length - entries.length, contentsRead: false };
  });
}

export async function runAction(action: Action, lines: number | undefined, env: Env, c: Config = CONFIG): Promise<unknown> {
  switch (action) {
    case "orbit_status":
      return orbitStatus(env, c);
    case "orbit_logs":
      return orbitLogs(env, c, lines ?? LOG_LINES_DEFAULT);
    case "deploy_state":
      return deployState(env, c);
    case "host_health":
      return hostHealth(env, c);
    case "tailscale_status":
      return tailscaleStatus(env, c);
    case "vault_sync":
      return vaultSync(env, c);
    case "credentials":
      return credentials(env, c);
  }
}

// ---- request handling and audit ----

export type AuditRecord = { at: string; action: string; lines?: number; outcome: "ok" | "rejected" | "error"; code?: string; message?: string; bytes: number; ms: number };

// Answers one request line. Never throws. The audit record holds the action name, the validated integer, the outcome and a
// redacted short message: never the raw request text and never the response data.
export async function handle(raw: string, env: Env, audit: (r: AuditRecord) => void, c: Config = CONFIG): Promise<string> {
  const started = Date.now();
  let action: string | undefined;
  let lines: number | undefined;
  const finish = (res: OpsResponse, outcome: AuditRecord["outcome"], code?: string): string => {
    let body = JSON.stringify(res);
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      body = JSON.stringify({ ok: false, action, error: { code: "response_too_large", message: "The result exceeded the response limit and was dropped." } });
      outcome = "error";
      code = "response_too_large";
    }
    audit({ at: env.now().toISOString(), action: action ?? "(none)", ...(lines !== undefined ? { lines } : {}), outcome, ...(code ? { code } : {}), ...(res.ok ? {} : { message: redact(res.error.message).slice(0, 120) }), bytes: Buffer.byteLength(body), ms: Date.now() - started });
    return body;
  };
  try {
    const req = parseRequest(raw);
    action = req.action;
    lines = req.lines;
    const data = redactDeep(await runAction(req.action, req.lines, env, c));
    return finish({ ok: true, action: req.action, data }, "ok");
  } catch (err) {
    if (err instanceof OpsReject) return finish({ ok: false, action, error: { code: err.code, message: err.message } }, "rejected", err.code);
    return finish({ ok: false, action, error: { code: "internal_error", message: "The action failed." } }, "error", "internal_error");
  }
}

// One line in, one line out. The request is capped before it is parsed.
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => process.exit(1), 5000);
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES + 1 || Buffer.concat(chunks).includes(10)) break;
  }
  const line = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
  const tooBig = size > MAX_REQUEST_BYTES + 1;
  const out = await handle(tooBig ? "x".repeat(MAX_REQUEST_BYTES + 1) : line, systemEnv, (r) => process.stderr.write(`orbit-ops ${JSON.stringify(r)}\n`));
  clearTimeout(timer);
  process.stdout.write(`${out}\n`, () => process.exit(0));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) void main();
