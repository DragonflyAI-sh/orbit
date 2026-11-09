// orbit-ops-admin: the privileged front behind /run/orbit-ops-admin.sock (tier 2). systemd accepts each connection
// (orbit-ops-admin.socket, Accept=yes) and runs one short-lived instance, as in tier 1. The kernel decides who may connect
// (mode 0660, group orbit-ops). This process only VALIDATES, RECORDS and DISPATCHES: it never performs a change itself.
// Each accepted mutation becomes a durable record plus a separate runner unit (admin-run.ts) that outlives this connection and
// the ORBIT restart, and does the work with the least privilege that action needs. A repeated opId returns the existing
// record and never runs again.
//
// Writable here: only /var/lib/orbit-ops-admin. No generic command, path or unit comes from the caller.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADMIN_MAX_REQUEST_BYTES,
  ADMIN_MAX_RESPONSE_BYTES,
  ADMIN_ACTIONS,
  OP_ID,
  OpsReject,
  displayConfig,
  isTerminal,
  parseAdminRequest,
  redact,
  type AdminResponse,
  type MutatingAction,
  type OpRecord,
} from "./admin-protocol.ts";
import { ADMIN_CONFIG, activePath, ensureDirs, loadRecord, pruneRecords, publicRecord, saveRecord, systemAdminEnv, type AdminConfig, type AdminEnv } from "./admin-core.ts";

const SYSTEMCTL = "/usr/bin/systemctl";

export type AdminAudit = { at: string; action: string; opId?: string; outcome: "accepted" | "replayed" | "rejected" | "error" | "ok"; code?: string; message?: string; bytes: number; ms: number };

// The runner template is fixed per action; only the validated opId completes the instance name.
const runnerFor = (c: AdminConfig, action: MutatingAction) => `${action === "refresh_vault" ? c.units.vaultRunner : c.units.runner}`;

async function runnerActive(env: AdminEnv, c: AdminConfig, rec: OpRecord): Promise<boolean> {
  const r = await env.exec(SYSTEMCTL, ["is-active", `${runnerFor(c, rec.action)}${rec.opId}.service`], 4000);
  return r.code === 0 && /^(active|activating)\s*$/.test(r.stdout);
}

// A record that says accepted/running but whose runner is gone (and which has been quiet for a while) did not finish.
// Say so; never leave it looking in flight, and never guess its outcome.
async function settleIfDead(env: AdminEnv, c: AdminConfig, rec: OpRecord): Promise<OpRecord> {
  if (isTerminal(rec.state)) return rec;
  if (env.now().getTime() - Date.parse(rec.updatedAt) < c.staleAfterMs) return rec;
  if (await runnerActive(env, c, rec)) return rec;
  const at = env.now().toISOString();
  rec.state = "interrupted";
  rec.finishedAt = at;
  rec.summary = "The runner stopped before it finished. The outcome is unknown: check the server (orbit_status, deploy_state) before assuming anything.";
  rec.verification = { checked: false, detail: "No verification happened." };
  delete rec.changes;
  saveRecord(c, rec, env);
  try {
    const active = readFileSync(activePath(c), "utf8").trim();
    if (active === rec.opId) rmSync(activePath(c), { force: true });
  } catch {
    // no slot
  }
  return rec;
}

async function accept(env: AdminEnv, c: AdminConfig, action: MutatingAction, opId: string, changes: OpRecord["changes"]) {
  ensureDirs(c);
  const existing = loadRecord(c, opId);
  if (existing) return { replayed: true, record: await settleIfDead(env, c, existing) };

  // One operation at a time. The slot is created exclusively, so two simultaneous requests cannot both get it.
  const slot = activePath(c);
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(slot, opId, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holderId = readFileSync(slot, "utf8").trim();
      const holder = loadRecord(c, holderId);
      const settled = holder ? await settleIfDead(env, c, holder) : undefined;
      if (holder && settled && !isTerminal(settled.state)) throw new OpsReject("busy", "Another administrative operation is still running. Wait for its result, then ask again.");
      if (attempt >= 1) throw new OpsReject("busy", "Another administrative operation holds the slot.");
      rmSync(slot, { force: true });
    }
  }

  const at = env.now().toISOString();
  const rec: OpRecord = {
    opId,
    action,
    state: "accepted",
    acceptedAt: at,
    updatedAt: at,
    ...(changes ? { changes, display: displayConfig(changes) } : {}),
    steps: [{ at, step: "accepted", detail: "Request validated and recorded. Nothing has been done yet." }],
  };
  saveRecord(c, rec, env);
  const started = await env.exec(SYSTEMCTL, ["start", "--no-block", `${runnerFor(c, action)}${opId}.service`], 8000);
  if (started.code !== 0 || started.timedOut) {
    rec.state = "failed";
    rec.finishedAt = env.now().toISOString();
    rec.summary = "The runner could not be started, so nothing was done.";
    rec.verification = { checked: false, detail: "Nothing ran." };
    delete rec.changes;
    saveRecord(c, rec, env);
    rmSync(slot, { force: true });
    return { replayed: false, record: rec };
  }
  pruneRecords(c);
  return { replayed: false, record: rec };
}

export async function runAdminAction(raw: string, env: AdminEnv, c: AdminConfig) {
  const req = parseAdminRequest(raw);
  if (req.action === "op_status") {
    const rec = loadRecord(c, req.opId);
    if (!rec) throw new OpsReject("not_found", "No operation with that id.");
    return { req, replayed: false, data: { operation: publicRecord(await settleIfDead(env, c, rec)) } };
  }
  const { replayed, record } = await accept(env, c, req.action, req.opId, req.changes);
  const dispatched = record.state === "accepted" || record.state === "running";
  return {
    req,
    replayed,
    data: {
      accepted: dispatched || replayed,
      replayed,
      operation: publicRecord(record),
      note: replayed
        ? "This operation id was already used; it was not run again. Its recorded state is shown."
        : dispatched
          ? "Dispatched to a separate runner. Nothing is verified yet: ask op_status for the result."
          : "The operation could not be started.",
    },
  };
}

export async function handle(raw: string, env: AdminEnv, audit: (r: AdminAudit) => void, c: AdminConfig = ADMIN_CONFIG): Promise<string> {
  const started = Date.now();
  let action: string | undefined;
  let opId: string | undefined;
  const finish = (res: AdminResponse, outcome: AdminAudit["outcome"], code?: string): string => {
    let body = JSON.stringify(res);
    if (Buffer.byteLength(body) > ADMIN_MAX_RESPONSE_BYTES) {
      body = JSON.stringify({ ok: false, action, error: { code: "response_too_large", message: "The result exceeded the response limit and was dropped." } });
      outcome = "error";
      code = "response_too_large";
    }
    audit({ at: env.now().toISOString(), action: action ?? "(none)", ...(opId ? { opId: opId.slice(0, 12) } : {}), outcome, ...(code ? { code } : {}), ...(res.ok ? {} : { message: redact(res.error.message).slice(0, 120) }), bytes: Buffer.byteLength(body), ms: Date.now() - started });
    return body;
  };
  try {
    // Names for the audit line even when the request is refused: only well-formed values are kept.
    try {
      const v = JSON.parse(raw) as { action?: unknown; opId?: unknown };
      if (typeof v?.action === "string" && (ADMIN_ACTIONS as readonly string[]).includes(v.action)) action = v.action;
      if (typeof v?.opId === "string" && OP_ID.test(v.opId)) opId = v.opId;
    } catch {
      // parseAdminRequest reports it
    }
    const out = await runAdminAction(raw, env, c);
    action = out.req.action;
    opId = out.req.opId;
    const ok = out.req.action === "op_status" ? "ok" : out.replayed ? "replayed" : "accepted";
    return finish({ ok: true, action: out.req.action, data: out.data }, ok);
  } catch (err) {
    if (err instanceof OpsReject) return finish({ ok: false, action, error: { code: err.code, message: err.message } }, "rejected", err.code);
    return finish({ ok: false, action, error: { code: "internal_error", message: "The action failed." } }, "error", "internal_error");
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => process.exit(1), 15000);
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > ADMIN_MAX_REQUEST_BYTES + 1 || Buffer.concat(chunks).includes(10)) break;
  }
  const line = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
  const tooBig = size > ADMIN_MAX_REQUEST_BYTES + 1;
  const out = await handle(tooBig ? "x".repeat(ADMIN_MAX_REQUEST_BYTES + 1) : line, systemAdminEnv, (r) => process.stderr.write(`orbit-ops-admin ${JSON.stringify(r)}\n`));
  clearTimeout(timer);
  process.stdout.write(`${out}\n`, () => process.exit(0));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) void main();
