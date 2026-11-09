// orbit-ops-sys: the privileged front behind /run/orbit-ops-sys.sock (tier 3). Structure as tier 2: systemd accepts each
// connection (Accept=yes) and runs one short-lived instance; the kernel decides who may connect (mode 0660, group orbit-ops).
// This process only VALIDATES, RECORDS and DISPATCHES. It never performs a change itself. It enforces, for every mutation:
//   - strict argument validation (fixed actions, fixed target shapes),
//   - the digest (the request must name the exact action and target that was confirmed),
//   - expiry (a confirmation is honoured for at most 15 minutes, whatever the request claims),
//   - the host name (a confirmation made for another host is refused),
//   - for Funnel, that the orbit-jobs tailscaled socket exists (otherwise it fails closed and says what to install),
//   - one operation at a time, durable across restarts and reboots (an exclusive slot file in the persistent state directory),
//   - replay protection (a repeated opId returns the existing record and never runs again),
//   - a cool-down between reboots (anchored on when one was actually issued, checked while holding the slot),
//   - a reboot may be scheduled up to 24 hours ahead and cancelled until it fires; cancel versus fire is decided by one exclusive
//     marker file (sys-core.ts), so a cancellation is never reported as done after the reboot was dispatched.
// Writable here: only /var/lib/orbit-ops-sys. No generic command, path or unit name comes from the caller.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SYS_ACTIONS,
  bootKey,
  SYS_MAX_REQUEST_BYTES,
  SYS_MAX_RESPONSE_BYTES,
  SYS_MAX_TTL_MS,
  rebootAtProblem,
  SYS_OP_ID,
  isFunnelAction,
  isSysTerminal,
  OpsReject,
  parseSysRequest,
  redact,
  type HostTarget,
  type SysRecord,
  type SysRecordAction,
  type SysResponse,
} from "./sys-protocol.ts";
import {
  SYS_CONFIG,
  abandonSlot,
  allRecords,
  cooldownRemainingMs,
  decide,
  ensureDirs,
  lastRebootIssuedMs,
  loadRecord,
  pruneRecords,
  publicRecord,
  readSlot,
  releaseSlot,
  retireSlot,
  saveRecord,
  slotAgeMs,
  systemSysEnv,
  tryAcquireSlot,
  type SysConfig,
  type SysEnv,
} from "./sys-core.ts";

const SYSTEMCTL = "/usr/bin/systemctl";
export const RECOVER_UNIT = "orbit-ops-sys-recover.service";

export type SysAudit = { at: string; action: string; opId?: string; outcome: "accepted" | "replayed" | "rejected" | "error" | "ok"; code?: string; message?: string; bytes: number; ms: number };

const runnerFor = (c: SysConfig, action: SysRecordAction) =>
  action === "install_os_updates" ? c.units.update : action === "plan_os_updates" ? c.units.plan : action === "reboot_host" ? c.units.reboot : c.units.funnel;

const readBootKey = (c: SysConfig): string => {
  try {
    const id = readFileSync(c.bootIdFile, "utf8").trim();
    return id ? bootKey(id) : "";
  } catch {
    return "";
  }
};

async function isActive(env: SysEnv, unit: string): Promise<boolean> {
  const r = await env.exec(SYSTEMCTL, ["is-active", unit], 4000);
  return r.code === 0 && /^(active|activating)\s*$/.test(r.stdout);
}

function end(c: SysConfig, env: SysEnv, rec: SysRecord, state: SysRecord["state"], summary: string, detail: string): SysRecord {
  rec.state = state;
  rec.finishedAt = env.now().toISOString();
  rec.summary = summary;
  rec.verification = { checked: false, detail };
  saveRecord(c, rec, env);
  releaseSlot(c, rec.opId);
  return rec;
}

// A record that is not finished but whose runner is gone (and which has been quiet for a while) did not finish. Say so; never
// leave it looking in flight, never guess its outcome, and never run it again. A reboot is the one case where the runner is
// EXPECTED to vanish: it is left alone until the boot-time recovery has verified it, and only after the grace period is it
// settled as unverified.
export async function settleIfDead(env: SysEnv, c: SysConfig, rec: SysRecord): Promise<SysRecord> {
  if (isSysTerminal(rec.state)) return rec;
  const age = env.now().getTime() - Date.parse(rec.updatedAt);
  if (age < c.staleAfterMs) return rec;
  if (await isActive(env, `${runnerFor(c, rec.action)}${rec.opId}.service`)) return rec;
  if (rec.state === "rebooting" && rec.reboot) {
    if (await isActive(env, RECOVER_UNIT)) return rec;
    const sinceIssue = env.now().getTime() - Date.parse(rec.reboot.issuedAt);
    if (sinceIssue < c.rebootGraceMs) return rec;
    const now = readBootKey(c);
    const changed = now !== "" && now !== rec.reboot.preBootKey;
    if (changed) rec.reboot.postBootKey = now;
    return end(
      c,
      env,
      rec,
      "unverified",
      changed
        ? "The reboot command was accepted and the boot id changed, but the post-boot verification never recorded a result (is orbit-ops-sys-recover.service installed?). Check ORBIT and the shared host's services yourself."
        : "The reboot command was accepted but no reboot was observed (the boot id is unchanged). It may have been blocked or may still be pending. Nothing is verified.",
      changed ? "Boot id changed; no post-boot verification." : "Boot id unchanged.",
    );
  }
  const what =
    rec.action === "plan_os_updates"
      ? "The planning runner stopped before it finished. No package was installed or changed (it only refreshes package lists). Ask for a new plan."
      : rec.action === "reboot_host" && rec.state === "scheduled"
        ? "The scheduled reboot's runner stopped before the scheduled time (for example the host restarted for another reason). NO reboot was issued by this operation and it will not fire later: schedule it again if it is still wanted."
        : rec.action === "install_os_updates"
      ? "The runner stopped before it finished. The package state is unknown: run `dpkg --audit` and `apt-get -s upgrade` on the host before assuming anything."
      : rec.action === "reboot_host"
        ? "The runner stopped before it issued the reboot or recorded its state. Nothing is verified; the reboot was not retried."
        : "The runner stopped before it finished. The Funnel configuration on orbit-jobs is unknown: check it (orbit-ops-sys.md) before assuming anything.";
  return end(c, env, rec, "interrupted", what, "No verification happened.");
}

type Mutation = Extract<ReturnType<typeof parseSysRequest>, { action: "install_os_updates" | "reboot_host" | "funnel_enable" | "funnel_disable" | "plan_os_updates" }>;

// Take the one-operation slot. A holder that is finished or dead is taken over atomically (see sys-core.ts: only the party that
// retires that holder may remove its slot, so two requests can never both take over, and a replacement's slot is never removed).
async function takeSlot(env: SysEnv, c: SysConfig, opId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (tryAcquireSlot(c, opId)) return;
    const holderId = readSlot(c);
    if (holderId === undefined) continue; // released between the two calls: try again
    if (!SYS_OP_ID.test(holderId)) throw new OpsReject("busy", "The tier 3 slot holds something this helper did not write. Nothing was done; an operator must inspect /var/lib/orbit-ops-sys/active (docs/orbit-ops-sys.md).");
    const holder = loadRecord(c, holderId);
    if (!holder) {
      // A slot with no record is either a request that is mid-way through being accepted (it records right after taking the slot)
      // or one that died there. Young: busy. Old: retire it like any other dead holder.
      const age = slotAgeMs(c);
      if (age === undefined || age < c.staleAfterMs) throw new OpsReject("busy", "Another tier 3 operation is being accepted. Wait for its result, then ask again.");
      retireSlot(c, holderId);
      continue;
    }
    const settled = await settleIfDead(env, c, holder);
    if (!isSysTerminal(settled.state)) throw new OpsReject("busy", "Another tier 3 operation is still running, scheduled or awaiting verification. Wait for its result (or cancel a scheduled reboot), then ask again.");
    retireSlot(c, holderId); // a no-op if settleIfDead (or someone else) already did
  }
  throw new OpsReject("busy", "Another tier 3 operation holds the slot.");
}

async function accept(env: SysEnv, c: SysConfig, req: Mutation) {
  ensureDirs(c);
  const existing = loadRecord(c, req.opId);
  if (existing) return { replayed: true, record: await settleIfDead(env, c, existing) };

  // ---- authorization at the privileged boundary: everything below is checked here, not only in chat ----
  // (The digest binds the request to what the card showed; it does not prove the owner clicked. Membership of orbit-ops is the
  // trust boundary, as in tier 2.)
  const nowMs = env.now().getTime();
  let rebootAt: string | undefined;
  if (req.action !== "plan_os_updates") {
    const exp = Date.parse(req.expiresAt);
    if (exp <= nowMs) throw new OpsReject("expired", "This confirmation has expired. Nothing was done; ask again.");
    if (exp - nowMs > SYS_MAX_TTL_MS) throw new OpsReject("bad_arguments", "expiresAt is further away than a confirmation may last.");
    if (!isFunnelAction(req.action)) {
      const host = (req.target as HostTarget).host;
      if (host !== env.hostname()) throw new OpsReject("wrong_target", `This confirmation names host "${host}", but this helper is on "${env.hostname()}". Nothing was done.`);
    } else if (!existsSync(c.jobsSocket)) {
      // Fail closed. Never substitute the host's own tailscaled.
      throw new OpsReject(
        "helper_missing",
        "The orbit-jobs tailscaled socket is not present on this host, so there is nothing here this action may change. It will not touch the host's own Tailscale instead. Install the orbit-jobs node here (deploy/install.sh does, given its auth key) or operate Funnel on whichever machine runs it, by hand: see docs/orbit-ops-sys.md.",
      );
    }
    if (req.action === "reboot_host" && req.rebootAt) {
      const problem = rebootAtProblem(req.rebootAt, nowMs);
      if (problem) throw new OpsReject("bad_arguments", `${problem} Nothing was done.`);
      rebootAt = req.rebootAt;
    }
  }

  await takeSlot(env, c, req.opId);
  // From here this request owns the slot. Anything refused below gives it back.
  if (req.action === "reboot_host") {
    // Checked while holding the slot (not before it), so two requests cannot both pass a check that neither has recorded yet.
    // For a scheduled reboot the cool-down is measured at the scheduled time, and checked again when it fires.
    const wait = cooldownRemainingMs(c, rebootAt ? Date.parse(rebootAt) : nowMs);
    if (wait > 0) {
      abandonSlot(c, req.opId);
      throw new OpsReject("cooldown", `A reboot was issued ${Math.round((nowMs - (lastRebootIssuedMs(c) ?? nowMs)) / 60000)} minutes ago; another will not be accepted for that time yet (cool-down ${Math.round(c.rebootCooldownMs / 60000)} minutes from the last ISSUED reboot). Check that operation's result first.`);
    }
  }

  const at = env.now().toISOString();
  const rec: SysRecord = {
    opId: req.opId,
    action: req.action,
    state: rebootAt ? "scheduled" : "accepted",
    acceptedAt: at,
    updatedAt: at,
    target: req.action === "plan_os_updates" ? { host: env.hostname() } : req.target,
    digest: req.action === "plan_os_updates" ? "" : req.digest,
    expiresAt: req.action === "plan_os_updates" ? at : req.expiresAt,
    ...(req.action === "install_os_updates" && req.planDigest ? { planDigest: req.planDigest } : {}),
    ...(rebootAt ? { schedule: { at: rebootAt } } : {}),
    steps: [{ at, step: rebootAt ? "scheduled" : "accepted", detail: rebootAt ? `Request validated and recorded. Nothing has been done yet; the reboot is scheduled for ${rebootAt} and can be cancelled until it fires.` : "Request validated and recorded. Nothing has been done yet." }],
  };
  saveRecord(c, rec, env);
  const started = await env.exec(SYSTEMCTL, ["start", "--no-block", `${runnerFor(c, req.action)}${req.opId}.service`], 8000);
  if (started.code !== 0 || started.timedOut) {
    end(c, env, rec, "failed", "The runner could not be started, so nothing was done.", "Nothing ran.");
    return { replayed: false, record: rec };
  }
  pruneRecords(c);
  return { replayed: false, record: rec };
}

// Cancel a reboot that has not fired. The exclusive decision marker (sys-core.ts) settles cancel versus fire: this reports success
// only when it won that decision, i.e. the runner can no longer issue the reboot.
export async function cancelReboot(env: SysEnv, c: SysConfig, opId: string, audit: (line: object) => void) {
  ensureDirs(c);
  const found = loadRecord(c, opId);
  if (!found) throw new OpsReject("not_found", "No operation with that id.");
  if (found.action !== "reboot_host") throw new OpsReject("not_cancellable", "Only a reboot can be cancelled; this operation is not one.");
  const rec = await settleIfDead(env, c, found);
  if (rec.state === "cancelled") return { record: rec, already: true };
  if (isSysTerminal(rec.state)) throw new OpsReject("not_cancellable", `That reboot already ended (${rec.state}); there is nothing to cancel.`);
  const tooLate = () => new OpsReject("too_late", `Too late: that reboot has already been dispatched (state ${loadRecord(c, opId)?.state ?? rec.state}). It was NOT cancelled; watch its result.`);
  if (rec.state !== "accepted" && rec.state !== "scheduled") throw tooLate();
  const d = decide(c, opId, "cancel");
  if (!d.won) {
    if (d.decision === "fire") throw tooLate();
    return { record: loadRecord(c, opId) ?? rec, already: true };
  }
  // This request won: the runner can no longer issue the reboot. Record it, audit it, free the slot.
  const fresh = loadRecord(c, opId) ?? rec;
  fresh.state = "cancelled";
  fresh.finishedAt = env.now().toISOString();
  fresh.summary = "Cancelled by the owner before it fired. No reboot was issued by this operation.";
  fresh.verification = { checked: false, detail: "Cancelled before dispatch; nothing ran." };
  const s = { at: fresh.finishedAt, step: "cancelled", detail: "Cancelled by the owner via chat before the reboot fired." };
  fresh.steps.push(s);
  saveRecord(c, fresh, env);
  releaseSlot(c, opId);
  audit({ at: s.at, opId: opId.slice(0, 12), action: "reboot_host", step: s.step, detail: s.detail });
  return { record: fresh, already: false };
}

export type Journal = (line: object) => void;
const stderrJournal: Journal = (l) => process.stderr.write(`orbit-ops-sys ${JSON.stringify(l)}\n`);

export async function runSysAction(raw: string, env: SysEnv, c: SysConfig, journal: Journal = stderrJournal) {
  const req = parseSysRequest(raw);
  if (req.action === "sys_status") {
    ensureDirs(c);
    const recs = allRecords(c).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
    const open = recs.find((r) => !isSysTerminal(r.state));
    return {
      req,
      replayed: false,
      data: {
        tier: 3,
        installed: true,
        hostname: env.hostname(),
        bootKey: readBootKey(c),
        rebootRequired: existsSync(c.rebootRequiredFile),
        // Present or absent only: this front has no tailscale access and says nothing about the node's state or reachability.
        orbitJobsSocketPresent: existsSync(c.jobsSocket),
        openOperation: open ? { opId: open.opId, action: open.action, state: open.state, ...(open.schedule ? { scheduledFor: open.schedule.at } : {}) } : null,
        // When a reboot could next be accepted (null: now), from the last reboot actually ISSUED.
        rebootCooldownUntil: (() => {
          const last = lastRebootIssuedMs(c);
          return last !== undefined && last + c.rebootCooldownMs > env.now().getTime() ? new Date(last + c.rebootCooldownMs).toISOString() : null;
        })(),
      },
    };
  }
  if (req.action === "op_status") {
    const rec = loadRecord(c, req.opId);
    if (!rec) throw new OpsReject("not_found", "No operation with that id.");
    return { req, replayed: false, data: { operation: publicRecord(await settleIfDead(env, c, rec)) } };
  }
  if (req.action === "cancel_reboot") {
    const { record, already } = await cancelReboot(env, c, req.opId, journal);
    return { req, replayed: already, data: { cancelled: true, alreadyCancelled: already, operation: publicRecord(record), note: already ? "It was already cancelled; nothing further was done." : "Cancelled before it fired: no reboot was issued by this operation." } };
  }
  const { replayed, record } = await accept(env, c, req);
  const dispatched = record.state === "accepted" || record.state === "scheduled" || record.state === "running";
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

export async function handle(raw: string, env: SysEnv, audit: (r: SysAudit) => void, c: SysConfig = SYS_CONFIG, journal: Journal = stderrJournal): Promise<string> {
  const started = Date.now();
  let action: string | undefined;
  let opId: string | undefined;
  const finish = (res: SysResponse, outcome: SysAudit["outcome"], code?: string): string => {
    let body = JSON.stringify(res);
    if (Buffer.byteLength(body) > SYS_MAX_RESPONSE_BYTES) {
      body = JSON.stringify({ ok: false, action, error: { code: "response_too_large", message: "The result exceeded the response limit and was dropped." } });
      outcome = "error";
      code = "response_too_large";
    }
    audit({ at: env.now().toISOString(), action: action ?? "(none)", ...(opId ? { opId: opId.slice(0, 12) } : {}), outcome, ...(code ? { code } : {}), ...(res.ok ? {} : { message: redact(res.error.message).slice(0, 120) }), bytes: Buffer.byteLength(body), ms: Date.now() - started });
    return body;
  };
  try {
    try {
      const v = JSON.parse(raw) as { action?: unknown; opId?: unknown };
      if (typeof v?.action === "string" && (SYS_ACTIONS as readonly string[]).includes(v.action)) action = v.action;
      if (typeof v?.opId === "string" && SYS_OP_ID.test(v.opId)) opId = v.opId;
    } catch {
      // parseSysRequest reports it
    }
    const out = await runSysAction(raw, env, c, journal);
    action = out.req.action;
    if ("opId" in out.req) opId = out.req.opId;
    const ok = out.req.action === "op_status" || out.req.action === "sys_status" ? "ok" : out.replayed ? "replayed" : "accepted";
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
    if (size > SYS_MAX_REQUEST_BYTES + 1 || Buffer.concat(chunks).includes(10)) break;
  }
  const line = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
  const tooBig = size > SYS_MAX_REQUEST_BYTES + 1;
  const out = await handle(tooBig ? "x".repeat(SYS_MAX_REQUEST_BYTES + 1) : line, systemSysEnv, (r) => process.stderr.write(`orbit-ops-sys ${JSON.stringify(r)}\n`));
  clearTimeout(timer);
  process.stdout.write(`${out}\n`, () => process.exit(0));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) void main();
