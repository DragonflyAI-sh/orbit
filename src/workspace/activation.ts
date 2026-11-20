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
};
export type ActivationRecord = { schema: 1; mode: OwnerMode; changedAt?: string; proposalId?: string; validationId?: string; reason?: string };

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

export function ownerActivation(dir: string | undefined) {
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
      return { schema: 1, mode: "off", ...(v && typeof v.changedAt === "string" ? { changedAt: v.changedAt } : {}), ...(v && typeof v.reason === "string" ? { reason: v.reason } : {}) };
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
  // Restart: a validation that was running when ORBIT stopped never passed.
  const v0 = readValidation();
  if (v0?.state === "running") {
    const fixed: ValidationRecord = { ...v0, state: "interrupted", finishedAt: new Date().toISOString(), summary: "ORBIT stopped while the validation ran; it did not pass. Run it again." };
    if (vfile) writeAtomic(vfile, JSON.stringify(fixed));
    else memValidation = fixed;
  }

  return {
    mode: (): OwnerMode => read().mode,
    record: read,
    set(mode: OwnerMode, meta: { at: string; proposalId?: string; validationId?: string; reason?: string }) {
      const rec: ActivationRecord = { schema: 1, mode, changedAt: meta.at, ...(meta.proposalId ? { proposalId: meta.proposalId } : {}), ...(meta.validationId ? { validationId: meta.validationId } : {}), ...(meta.reason ? { reason: meta.reason } : {}) };
      if (file) writeAtomic(file, JSON.stringify(rec));
      else mem = rec;
    },
    validation: readValidation,
    saveValidation(v: ValidationRecord) {
      if (vfile) writeAtomic(vfile, JSON.stringify(v));
      else memValidation = v;
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
    if (v.policyHash !== o.policyHash) out.push("the latest validation was for a different sandbox policy (the configuration changed since)");
    if (v.sandboxPolicy !== o.sandboxPolicy) out.push("the latest validation was for a different sandbox implementation (bubblewrap changed since)");
    if (v.workspaceIdentity !== o.validationIdentity) out.push("the latest validation was for a different validation workspace");
    const at = Date.parse(v.finishedAt ?? v.startedAt);
    if (!(o.now.getTime() - at <= VALIDATION_MAX_AGE_MS)) out.push("the latest validation is older than 24 hours");
  }
  return out;
}
