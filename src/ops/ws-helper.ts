// orbit-ops-ws: the privileged front behind /run/orbit-ops-ws.sock (docs/orbit-ops-ws.md). systemd accepts each connection
// (orbit-ops-ws.socket, Accept=yes) and runs one short-lived instance, as in tiers 1-3; the kernel decides who may connect (mode
// 0660, group orbit-ops). This process only INSPECTS, VALIDATES, RECORDS and DISPATCHES: it never changes the host itself.
//   - ws_status inspects the host read-only and answers with facts, the fixed plan, its 24-hex plan key, host-wide blockers and
//     whether an operation is open.
//   - ws_setup must name the plan key the owner was shown. The plan is recomputed here; a different key is refused (plan_changed) and
//     so is a plan with a blocked step (plan_blocked). Nothing is recorded or run in either case.
//   - ws_setup and ws_revoke become a durable record plus a separate runner unit (ws-run.ts) that outlives this connection and the
//     ORBIT restart. A repeated opId returns the existing record and never runs again. One operation at a time.
// Writable here: only /var/lib/orbit-ops-ws. No command, path, unit or file content comes from the caller.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OP_ID,
  OpsReject,
  WS_ACTIONS,
  WS_MAX_REQUEST_BYTES,
  WS_MAX_RESPONSE_BYTES,
  isWsTerminal,
  parseWsRequest,
  redact,
  type WsMutatingAction,
  type WsRecord,
  type WsResponse,
} from "./ws-protocol.ts";
import {
  BIN,
  WS_CONFIG,
  activePath,
  computePlan,
  ensureDirs,
  loadRecord,
  pruneRecords,
  publicFacts,
  publicRecord,
  readSlot,
  releaseSlot,
  saveRecord,
  systemWsEnv,
  type WsConfig,
  type WsEnv,
} from "./ws-core.ts";

export type WsAudit = { at: string; action: string; opId?: string; outcome: "accepted" | "replayed" | "rejected" | "error" | "ok"; code?: string; message?: string; bytes: number; ms: number };

const runnerUnit = (c: WsConfig, opId: string) => `${c.units.runner}${opId}.service`;

async function runnerActive(env: WsEnv, c: WsConfig, rec: WsRecord): Promise<boolean> {
  const r = await env.exec(BIN.systemctl, ["is-active", runnerUnit(c, rec.opId)], 4000);
  // Liveness is the unit STATE on stdout, not the exit status: a running oneshot unit is "activating" with exit 3. Only a clean
  // "inactive" or "failed" is dead; any other, empty or unparseable state, a timeout or a missing binary counts as alive.
  if (r.timedOut || r.code === null) return true;
  return !/^(inactive|failed)\s*$/.test(r.stdout);
}

// A record that says accepted/running but whose runner is gone (and which has been quiet for a while) did not finish. Say so; never
// leave it looking in flight, never guess its outcome, never run it again.
export async function settleIfDead(env: WsEnv, c: WsConfig, rec: WsRecord): Promise<WsRecord> {
  if (isWsTerminal(rec.state)) return rec;
  if (env.now().getTime() - Date.parse(rec.updatedAt) < c.staleAfterMs) return rec;
  if (await runnerActive(env, c, rec)) return rec;
  rec.state = "interrupted";
  rec.finishedAt = env.now().toISOString();
  rec.summary =
    rec.action === "ws_setup"
      ? "The runner stopped before it finished. Some setup steps may have been applied and ORBIT may not have been restarted; the outcome is unknown. Ask for ws_status to see the host as it is now."
      : "The runner stopped before it finished. The drop-in may or may not have been rewritten and ORBIT may not have been restarted; the outcome is unknown. Ask for ws_status.";
  rec.verification = { checked: false, detail: "No verification happened." };
  delete rec.pkgRequested;
  saveRecord(c, rec, env);
  releaseSlot(c, rec.opId);
  return rec;
}

// The operation that holds the slot, if it is still open.
export async function openOperation(env: WsEnv, c: WsConfig): Promise<WsRecord | undefined> {
  const id = readSlot(c);
  if (!id || !OP_ID.test(id)) return undefined;
  const rec = loadRecord(c, id);
  if (!rec) return undefined;
  const settled = await settleIfDead(env, c, rec);
  return isWsTerminal(settled.state) ? undefined : settled;
}

// One operation at a time. The slot is created exclusively, so two simultaneous requests cannot both get it (tier 2's approach).
async function takeSlot(env: WsEnv, c: WsConfig, opId: string): Promise<void> {
  const slot = activePath(c);
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(slot, opId, { flag: "wx", mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holderId = "";
      try {
        holderId = readFileSync(slot, "utf8").trim();
      } catch {
        // released in between
      }
      const holder = OP_ID.test(holderId) ? loadRecord(c, holderId) : undefined;
      const settled = holder ? await settleIfDead(env, c, holder) : undefined;
      if (holder && settled && !isWsTerminal(settled.state)) throw new OpsReject("busy", "Another workspace host operation is still running. Wait for its result, then ask again.");
      if (attempt >= 1) throw new OpsReject("busy", "Another workspace host operation holds the slot.");
      rmSync(slot, { force: true });
    }
  }
}

function newRecord(env: WsEnv, opId: string, action: WsMutatingAction): WsRecord {
  const at = env.now().toISOString();
  return { opId, action, state: "accepted", acceptedAt: at, updatedAt: at, steps: [{ at, step: "accepted", detail: "Request validated and recorded. Nothing has been done yet." }] };
}

async function accept(env: WsEnv, c: WsConfig, action: WsMutatingAction, opId: string, planKey?: string) {
  ensureDirs(c);
  const existing = loadRecord(c, opId);
  if (existing) return { replayed: true, record: await settleIfDead(env, c, existing) };
  await takeSlot(env, c, opId);
  let rec: WsRecord;
  try {
    rec = newRecord(env, opId, action);
    if (action === "ws_setup") {
      const plan = await computePlan(env);
      const blocked = plan.steps.filter((s) => s.state === "blocked").map((s) => s.id);
      if (blocked.length) throw new OpsReject("plan_blocked", `Nothing was done: ${blocked.join(", ")} ${blocked.length > 1 ? "are" : "is"} blocked and needs an operator first (see ws_status).`);
      if (plan.planKey !== planKey) throw new OpsReject("plan_changed", "Nothing was done: the host no longer matches the plan that was confirmed. Ask for the current plan (ws_status) and confirm that one.");
      rec.planKey = plan.planKey;
      rec.todo = plan.steps.filter((s) => s.state === "todo").map((s) => s.id);
      rec.blockers = plan.blockers.map((b) => b.id);
      if (!rec.todo.length) {
        // Nothing to do: recorded as such, no runner is started.
        rec.state = "no_change";
        rec.finishedAt = env.now().toISOString();
        rec.summary = `The host is already set up; nothing was changed and ORBIT was not restarted.${rec.blockers.length ? ` Host blockers remain (${rec.blockers.join(", ")}): sandboxed exec stays unavailable until an operator resolves them.` : ""}`;
        rec.verification = { checked: false, detail: "Nothing ran; the plan showed every step done." };
        saveRecord(c, rec, env);
        releaseSlot(c, opId);
        return { replayed: false, record: rec };
      }
    }
  } catch (err) {
    releaseSlot(c, opId);
    throw err;
  }
  saveRecord(c, rec, env);
  const started = await env.exec(BIN.systemctl, ["start", "--no-block", runnerUnit(c, opId)], 8000);
  if (started.code !== 0 || started.timedOut) {
    rec.state = "failed";
    rec.finishedAt = env.now().toISOString();
    rec.summary = "The runner could not be started, so nothing was done.";
    rec.verification = { checked: false, detail: "Nothing ran." };
    saveRecord(c, rec, env);
    releaseSlot(c, opId);
    return { replayed: false, record: rec };
  }
  pruneRecords(c);
  return { replayed: false, record: rec };
}

export async function runWsAction(raw: string, env: WsEnv, c: WsConfig) {
  const req = parseWsRequest(raw);
  if (req.action === "ws_status") {
    const plan = await computePlan(env);
    const open = await openOperation(env, c);
    return {
      req,
      replayed: false,
      data: {
        facts: publicFacts(plan.facts),
        plan: { steps: plan.steps, planKey: plan.planKey, todo: plan.steps.filter((s) => s.state === "todo").length, blocked: plan.steps.filter((s) => s.state === "blocked").length },
        blockers: plan.blockers,
        open: open ? { opId: open.opId, action: open.action, state: open.state } : null,
        note: "Read-only: nothing was changed. ws_setup must name this planKey; host blockers are never changed by this helper.",
      },
    };
  }
  if (req.action === "op_status") {
    const rec = loadRecord(c, req.opId);
    if (!rec) throw new OpsReject("not_found", "No operation with that id.");
    return { req, replayed: false, data: { operation: publicRecord(await settleIfDead(env, c, rec)) } };
  }
  const { replayed, record } = await accept(env, c, req.action, req.opId, req.action === "ws_setup" ? req.planKey : undefined);
  const dispatched = record.state === "accepted" || record.state === "running";
  return {
    req,
    replayed,
    data: {
      accepted: dispatched || replayed || record.state === "no_change",
      replayed,
      operation: publicRecord(record),
      note: replayed
        ? "This operation id was already used; it was not run again. Its recorded state is shown."
        : dispatched
          ? "Dispatched to a separate runner. Nothing is verified yet: ask op_status for the result."
          : record.state === "no_change"
            ? "Nothing to do; nothing was changed."
            : "The operation could not be started.",
    },
  };
}

export async function handle(raw: string, env: WsEnv, audit: (r: WsAudit) => void, c: WsConfig = WS_CONFIG): Promise<string> {
  const started = Date.now();
  let action: string | undefined;
  let opId: string | undefined;
  const finish = (res: WsResponse, outcome: WsAudit["outcome"], code?: string): string => {
    let body = JSON.stringify(res);
    if (Buffer.byteLength(body) > WS_MAX_RESPONSE_BYTES) {
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
      if (typeof v?.action === "string" && (WS_ACTIONS as readonly string[]).includes(v.action)) action = v.action;
      if (typeof v?.opId === "string" && OP_ID.test(v.opId)) opId = v.opId;
    } catch {
      // parseWsRequest reports it
    }
    const out = await runWsAction(raw, env, c);
    action = out.req.action;
    const outcome = out.req.action === "op_status" || out.req.action === "ws_status" ? "ok" : out.replayed ? "replayed" : "accepted";
    return finish({ ok: true, action: out.req.action, data: out.data }, outcome);
  } catch (err) {
    if (err instanceof OpsReject) return finish({ ok: false, action, error: { code: err.code, message: err.message } }, "rejected", err.code);
    return finish({ ok: false, action, error: { code: "internal_error", message: "The action failed." } }, "error", "internal_error");
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => process.exit(1), 25000);
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > WS_MAX_REQUEST_BYTES + 1 || Buffer.concat(chunks).includes(10)) break;
  }
  const line = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
  const tooBig = size > WS_MAX_REQUEST_BYTES + 1;
  const out = await handle(tooBig ? "x".repeat(WS_MAX_REQUEST_BYTES + 1) : line, systemWsEnv, (r) => process.stderr.write(`orbit-ops-ws ${JSON.stringify(r)}\n`));
  clearTimeout(timer);
  process.stdout.write(`${out}\n`, () => process.exit(0));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) void main();
