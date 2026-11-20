import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Proposals } from "../agent.ts";
import { loadActivation } from "./config.ts";
import type { Activation } from "./config.ts";
import { checkPlatform } from "./fsops.ts";
import { bwrapSandbox } from "./sandbox.ts";
import type { Sandbox } from "./sandbox.ts";
import { LedgerError, ledgerQuarantine } from "./ledger.ts";
import { proposals as newProposals } from "../agent.ts";
import { workspaceService } from "./service.ts";
import { ownerActivation } from "./activation.ts";
import type { CurrentEvidence } from "./activation.ts";
import { VALIDATION_WORKSPACE } from "./smoke.ts";
import { workspaceAdmin } from "./admin.ts";
import type { HostOpStore, WsHostClient } from "./admin.ts";
import { ensureRunParent } from "./cgroup.ts";
import type { WorkspaceAudit } from "./service.ts";

// Production wiring for the workspace tools (docs/workspace-tools.md). OFF unless ORBIT_WORKSPACE_TOOLS=enabled AND the operator's
// workspaces file acknowledges the pre-activation checklist. When off, the service exists only to say why: it offers no tools and
// refuses every confirmation. Exec additionally needs the bubblewrap sandbox to pass its live self-test; there is no other launcher.
export function selectWorkspace(
  env: Record<string, string | undefined>,
  d: { stateDir?: string; proposals: Proposals; protectedPaths: string[]; audit?: (e: WorkspaceAudit) => void; uid?: () => number; log?: (line: string) => void; host?: WsHostClient; hostStore?: HostOpStore; notify?: (text: string) => void; hostHelperPresent?: () => boolean },
) {
  const log = d.log ?? ((line: string) => console.log(line));
  const uid = d.uid ?? (() => process.getuid?.() ?? 0);
  let activation: Activation = loadActivation(env, { uid, protectedPaths: d.protectedPaths.filter(Boolean) });
  if (activation.state === "enabled") {
    const platform = checkPlatform();
    if (platform) activation = { state: "invalid", reason: platform };
    else if (!d.stateDir) activation = { state: "invalid", reason: "ORBIT has no state directory, so operations cannot be recorded durably." };
  }
  const dir = d.stateDir ? join(d.stateDir, "workspace") : undefined;
  let sandbox: Sandbox | undefined;
  if (activation.state === "enabled" && dir && activation.config.workspaces.some((w) => w.exec)) {
    // ORBIT's own run-parent cgroup inside its delegated unit cgroup (never anything outside it); the self-test reports what is missing.
    if (uid() !== 0) {
      const cg = ensureRunParent(activation.config.sandbox.cgroupParent);
      log(`workspace-cgroup: ${cg.ok ? "ready" : "not prepared"} (${cg.detail})`);
    }
    sandbox = bwrapSandbox({ config: activation.config.sandbox, stateDir: dir, uid, canaries: d.protectedPaths.filter(Boolean) });
  }
  // The owner's switch (default off; a missing or unreadable record is off). Without a state directory there is nothing to switch. It
  // is ON only while it is bound to a passed validation of exactly the running policy, sandbox implementation and validation workspace
  // (src/workspace/activation.ts); `current` is what ORBIT runs with now.
  const current = (): CurrentEvidence | undefined => {
    if (activation.state !== "enabled") return undefined;
    const sb = sandbox?.status();
    return { policyHash: activation.config.policyHash, sandboxPolicy: sandbox?.policyId() ?? "none", sandboxState: sb?.state ?? "none", validationIdentity: activation.config.workspaces.find((w) => w.id === VALIDATION_WORKSPACE && w.exec)?.identity };
  };
  // Host permission absent (revoked, never set up, or not valid) at start: a switch left "enabled" from before is reset to off and the
  // latest validation stops being evidence, so a later setup can never bring the tools back without a new validation and enable.
  const resetIfPermissionLost = (why: string) => {
    if (!dir || !existsSync(dir)) return;
    const o = ownerActivation(dir);
    const at = new Date().toISOString();
    if (o.record().mode === "enabled") {
      o.set("off", { at, reason: `switched off automatically: the host does not permit workspace tools at this start (${why.slice(0, 200)}). Set the host up, validate and enable again.` });
      log("workspace-owner: reset to off (the host no longer permits workspace tools)");
    }
    o.invalidateValidation(at, "the host did not permit workspace tools at an ORBIT start");
  };
  if (activation.state !== "enabled") resetIfPermissionLost(activation.reason);
  const owner = ownerActivation(activation.state === "enabled" ? dir : undefined, current);
  let service: ReturnType<typeof workspaceService>;
  try {
    // The validation runs keep their own ledger; an unverified cleanup there pauses exec and blocks enable here too (finding 7). A
    // validation interrupted by a restart left its runs "in flight": they count until the startup recovery below verifies them.
    const vdir = activation.state === "enabled" && dir ? join(dir, "validation-runs") : undefined;
    service = workspaceService({ activation, sandbox, stateDir: activation.state === "enabled" ? dir : undefined, proposals: d.proposals, audit: d.audit, active: () => owner.mode() === "enabled", ...(vdir ? { foreignQuarantine: () => ledgerQuarantine(vdir, { inFlight: owner.validation()?.state !== "running" }) } : {}) });
  } catch (e) {
    // The ledger could not be loaded: the tools stay off (and say why) rather than run without their records, and ORBIT still starts.
    if (!(e instanceof LedgerError)) throw e;
    activation = { state: "invalid", reason: e.message };
    sandbox = undefined;
    resetIfPermissionLost(e.message);
    service = workspaceService({ activation, proposals: d.proposals, audit: d.audit });
  }
  const admin = workspaceAdmin({
    env,
    activation,
    service,
    sandbox,
    owner,
    stateDir: activation.state === "enabled" ? dir : undefined,
    proposals: d.proposals,
    host: d.host,
    hostStore: d.hostStore,
    notify: d.notify,
    audit: d.audit as (e: unknown) => void,
    uid,
    // Offered to the owner once there is something to administer: the host permits the tools, or the host helper is installed.
    offered: () => activation.state === "enabled" || (d.hostHelperPresent?.() ?? false),
  });
  let ready: Promise<void> = Promise.resolve();
  if (service.enabled) {
    // Recovery first (it reaps leftovers of runs that were in flight and re-checks unverified cleanups), then the self-test. Both run in
    // the background; until the self-test passes, exec_start refuses (sandbox state "unknown"/"unsupported"). The verdict is logged
    // (WS-R2): an operator can always see why exec is unavailable.
    const svc = service;
    ready = (async () => {
      try {
        await svc.recover();
      } catch (e) {
        log(`workspace-recovery: failed (${e instanceof Error ? e.message.slice(0, 200) : "error"})`);
      }
      // The validation runs' ledger gets the same recovery (reap leftovers, verify cleanups) before anything can start; no validation
      // can be running yet (it needs the self-test below). Its instance is used only here and then dropped.
      if (activation.state === "enabled" && dir && existsSync(join(dir, "validation-runs", "ledger.json"))) {
        try {
          const vcfg = activation.config;
          await workspaceService({ activation: { state: "enabled", config: vcfg }, sandbox, stateDir: join(dir, "validation-runs"), proposals: newProposals(), audit: d.audit, active: () => false }).recover();
        } catch (e) {
          log(`workspace-recovery: validation runs not recovered (${e instanceof Error ? e.message.slice(0, 200) : "error"}); exec stays paused`);
        }
      }
      if (sandbox) {
        const v = await sandbox.probe();
        log(`workspace-sandbox: ${v.state}${v.reasons.length ? ` (${v.reasons.join("; ").slice(0, 600)})` : ""}`);
      }
      // Now that the sandbox implementation is known, the switch's binding is checked (and reset durably if anything changed).
      const st = owner.state();
      log(`workspace-owner: ${st.mode}${st.stale.length ? ` (switched off: ${st.stale.join("; ").slice(0, 400)})` : st.pending.length ? ` (${st.pending.join("; ").slice(0, 200)})` : ""}`);
    })();
  }
  return { service, activation, sandbox, ready, admin, owner };
}
