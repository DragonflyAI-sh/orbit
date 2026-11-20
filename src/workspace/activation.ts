import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

// The OWNER's activation of the workspace tools (docs/workspace-tools.md, "Activation"). Three separate layers must all agree before
// a model sees a single workspace tool:
//   1. the host permits it (operator or the orbit-ops-ws setup: ORBIT_WORKSPACE_TOOLS=enabled, the workspaces file with its
//      acknowledgement; src/workspace/config.ts),
//   2. a bounded synthetic validation passed under the production sandbox for the CURRENT policy (src/workspace/smoke.ts),
//   3. Rai confirmed "enable" on a card (src/workspace/admin.ts), which writes mode "enabled" here.
// Deploying or merging changes none of these. A missing, unreadable or malformed file is mode "off" (fail closed), and so is any file
// that does not say exactly "enabled".

export type OwnerMode = "off" | "enabled";
export type CheckResult = "pass" | "fail" | "not_checked";
export type ValidationCheck = { id: string; title: string; result: CheckResult; required: boolean; detail: string };
export type ValidationRecord = {
  id: string;
  state: "running" | "passed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  proposalId: string;
  // What it was validated against: enable requires all of these to equal the running configuration.
  policyHash: string;
  sandboxPolicy: string;
  workspaceIdentity: string;
  checks: ValidationCheck[];
  summary?: string;
  // Set when the host changed under it (setup or revoke confirmed, or the host permission found absent at a start). An invalidated
  // validation is never evidence for enable, and an enabled switch bound to it is off.
  invalidatedAt?: string;
  invalidatedReason?: string;
};
export type ActivationRecord = { schema: 1; mode: OwnerMode; changedAt?: string; proposalId?: string; validationId?: string; reason?: string; binding?: ActivationBinding };
// What an "enabled" switch is bound to (finding 1 of the PR #147 review): the validation it relied on and the exact policy, sandbox
// implementation and validation workspace that validation proved. An "enabled" record without a complete binding is off.
export type ActivationBinding = { validationId: string; validatedAt: string; policyHash: string; sandboxPolicy: string; validationIdentity: string };
// What ORBIT is running with NOW (undefined: the host does not permit the tools). sandboxState "unknown" means the startup self-test has
// not finished, so the sandbox implementation cannot be compared yet: the switch reads as off until it has, without being reset.
export type CurrentEvidence = { policyHash: string; sandboxPolicy: string; sandboxState: string; validationIdentity?: string };
export type OwnerState = { mode: OwnerMode; record: ActivationRecord; stale: string[]; pending: string[] };

// Expiry semantics. A validation is usable as evidence for ENABLE for 24 hours after it finished: both the enable card and its
// confirmation refuse an older one (enableBlockers). Once enabled, the switch does not expire by age; it stays on exactly as long as
// everything it was bound to is unchanged (the same validation record, still passed and not invalidated; the same policy hash, sandbox
// implementation and validation workspace as the running ones; the host still permitting the tools). Any change turns it off
// durably, and turning it on again needs a validation of the new state (at most 24 hours old) and a new enable confirmation.
export const VALIDATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function ownerActivation(dir: string | undefined, current?: () => CurrentEvidence | undefined) {
  const file = dir ? join(dir, "activation.json") : undefined;
  const vfile = dir ? join(dir, "validation.json") : undefined;
  let mem: ActivationRecord = { schema: 1, mode: "off" };
  let memValidation: ValidationRecord | undefined;
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const read = (): ActivationRecord => {
    if (!file) return mem;
    if (!existsSync(file)) return { schema: 1, mode: "off" };
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as Partial<ActivationRecord>;
      if (v && v.schema === 1 && v.mode === "enabled") return v as ActivationRecord;
      return { schema: 1, mode: "off", ...(v && typeof v.changedAt === "string" ? { changedAt: v.changedAt } : {}), ...(v && typeof v.reason === "string" ? { reason: v.reason } : {}), ...(v && typeof v.proposalId === "string" ? { proposalId: v.proposalId } : {}) };
    } catch {
      return { schema: 1, mode: "off", reason: "activation.json could not be read; treated as off" };
    }
  };
  const readValidation = (): ValidationRecord | undefined => {
    if (!vfile) return memValidation;
    try {
      const v = JSON.parse(readFileSync(vfile, "utf8")) as ValidationRecord;
      return v && typeof v.id === "string" && Array.isArray(v.checks) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (rec: ActivationRecord) => {
    if (file) writeAtomic(file, JSON.stringify(rec));
    else mem = rec;
  };
  const saveValidation = (v: ValidationRecord) => {
    if (vfile) writeAtomic(vfile, JSON.stringify(v));
    else memValidation = v;
  };
  // Restart: a validation that was running when ORBIT stopped never passed.
  const v0 = readValidation();
  if (v0?.state === "running") saveValidation({ ...v0, state: "interrupted", finishedAt: new Date().toISOString(), summary: "ORBIT stopped while the validation ran; it did not pass. Run it again." });

  // Is the switch on, given what ORBIT runs with now? `stale` reasons are definite (the switch is reset to off, durably, so reverting the
  // change later does not bring it back); `pending` ones only mean "not known yet" (off for now, nothing written).
  const evaluate = (): OwnerState => {
    const rec = read();
    if (rec.mode !== "enabled") return { mode: "off", record: rec, stale: [], pending: [] };
    const stale: string[] = [];
    const pending: string[] = [];
    const b = rec.binding;
    const complete = b && [b.validationId, b.validatedAt, b.policyHash, b.sandboxPolicy, b.validationIdentity].every((x) => typeof x === "string" && x.length > 0);
    if (!b || !complete) stale.push("the activation record is not bound to a validation (it predates binding or was written by hand)");
    else {
      const v = readValidation();
      if (!v || v.id !== b.validationId) stale.push("the validation the switch relied on is gone or was replaced by another one");
      else {
        if (v.state !== "passed") stale.push(`the validation the switch relied on is ${v.state}, not passed`);
        if (v.invalidatedAt) stale.push(`the validation the switch relied on was invalidated (${v.invalidatedReason ?? "host changed"})`);
        if (v.policyHash !== b.policyHash || v.sandboxPolicy !== b.sandboxPolicy || v.workspaceIdentity !== b.validationIdentity) stale.push("the validation record does not match what the switch was bound to");
      }
      if (!current) pending.push("no running configuration to compare with");
      else {
        const cur = current();
        if (!cur) stale.push("the host no longer permits workspace tools");
        else {
          if (cur.policyHash !== b.policyHash) stale.push("the sandbox policy changed since the validation (the workspaces file was edited)");
          if (cur.validationIdentity !== b.validationIdentity) stale.push("the validation workspace changed since the validation");
          if (cur.sandboxState === "unknown") pending.push("the sandbox self-test has not finished since ORBIT started");
          else if (cur.sandboxPolicy !== b.sandboxPolicy) stale.push("the sandbox implementation changed since the validation (bubblewrap changed)");
        }
      }
    }
    if (stale.length) {
      const off: ActivationRecord = { schema: 1, mode: "off", changedAt: new Date().toISOString(), reason: `switched off automatically: ${stale.join("; ")}. Validate again, then enable again.`.slice(0, 600) };
      write(off);
      return { mode: "off", record: off, stale, pending };
    }
    return { mode: pending.length ? "off" : "enabled", record: rec, stale, pending };
  };

  return {
    mode: (): OwnerMode => evaluate().mode,
    state: evaluate,
    record: read,
    set(mode: OwnerMode, meta: { at: string; proposalId?: string; binding?: ActivationBinding; reason?: string }) {
      if (mode === "enabled" && !meta.binding) throw new Error("enable needs the validation binding");
      const rec: ActivationRecord = { schema: 1, mode, changedAt: meta.at, ...(meta.proposalId ? { proposalId: meta.proposalId } : {}), ...(mode === "enabled" && meta.binding ? { validationId: meta.binding.validationId, binding: meta.binding } : {}), ...(meta.reason ? { reason: meta.reason } : {}) };
      write(rec);
    },
    validation: readValidation,
    saveValidation,
    // The host changed under the latest validation: it is never evidence for enable again.
    invalidateValidation(at: string, reason: string) {
      const v = readValidation();
      if (v && !v.invalidatedAt) saveValidation({ ...v, invalidatedAt: at, invalidatedReason: reason });
    },
  };
}
export type OwnerActivation = ReturnType<typeof ownerActivation>;

// Why enable must be refused now, or [] if every precondition holds. Pure: the caller passes what it observed.
export function enableBlockers(o: {
  configured: boolean;
  hostReason?: string;
  sandboxState?: string;
  sandboxReasons?: string[];
  sandboxPolicy?: string;
  policyHash?: string;
  validationIdentity?: string;
  quarantined: string[];
  validation?: ValidationRecord;
  now: Date;
}): string[] {
  const out: string[] = [];
  if (!o.configured) return [`the host does not permit workspace tools (${o.hostReason ?? "not configured"}); run the host setup first`];
  if (o.sandboxState !== "supported") out.push(`the sandbox self-test has not passed (state ${o.sandboxState ?? "none"}${o.sandboxReasons?.length ? `: ${o.sandboxReasons.join("; ").slice(0, 300)}` : ""})`);
  if (o.quarantined.length) out.push(`an earlier run's process tree is not confirmed gone (${o.quarantined.join(", ")})`);
  const v = o.validation;
  if (!v) out.push("no synthetic validation has been run");
  else {
    if (v.state !== "passed") out.push(`the latest validation did not pass (${v.state})`);
    if (v.invalidatedAt) out.push(`the latest validation was invalidated (${v.invalidatedReason ?? "the host changed"}); validate again`);
    if (v.policyHash !== o.policyHash) out.push("the latest validation was for a different sandbox policy (the configuration changed since)");
    if (v.sandboxPolicy !== o.sandboxPolicy) out.push("the latest validation was for a different sandbox implementation (bubblewrap changed since)");
    if (v.workspaceIdentity !== o.validationIdentity) out.push("the latest validation was for a different validation workspace");
    const at = Date.parse(v.finishedAt ?? v.startedAt);
    if (!(o.now.getTime() - at <= VALIDATION_MAX_AGE_MS)) out.push("the latest validation is older than 24 hours");
  }
  return out;
}
