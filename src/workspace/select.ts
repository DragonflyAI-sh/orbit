import { join } from "node:path";
import type { Proposals } from "../agent.ts";
import { loadActivation } from "./config.ts";
import type { Activation } from "./config.ts";
import { checkPlatform } from "./fsops.ts";
import { bwrapSandbox } from "./sandbox.ts";
import type { Sandbox } from "./sandbox.ts";
import { LedgerError } from "./ledger.ts";
import { workspaceService } from "./service.ts";
import type { WorkspaceAudit } from "./service.ts";

// Production wiring for the workspace tools (docs/workspace-tools.md). OFF unless ORBIT_WORKSPACE_TOOLS=enabled AND the operator's
// workspaces file acknowledges the pre-activation checklist. When off, the service exists only to say why: it offers no tools and
// refuses every confirmation. Exec additionally needs the bubblewrap sandbox to pass its live self-test; there is no other launcher.
export function selectWorkspace(env: Record<string, string | undefined>, d: { stateDir?: string; proposals: Proposals; protectedPaths: string[]; audit?: (e: WorkspaceAudit) => void; uid?: () => number; log?: (line: string) => void }) {
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
    sandbox = bwrapSandbox({ config: activation.config.sandbox, stateDir: dir, uid, canaries: d.protectedPaths.filter(Boolean) });
  }
  let service: ReturnType<typeof workspaceService>;
  try {
    service = workspaceService({ activation, sandbox, stateDir: activation.state === "enabled" ? dir : undefined, proposals: d.proposals, audit: d.audit });
  } catch (e) {
    // The ledger could not be loaded: the tools stay off (and say why) rather than run without their records, and ORBIT still starts.
    if (!(e instanceof LedgerError)) throw e;
    activation = { state: "invalid", reason: e.message };
    sandbox = undefined;
    service = workspaceService({ activation, proposals: d.proposals, audit: d.audit });
  }
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
      if (!sandbox) return;
      const v = await sandbox.probe();
      log(`workspace-sandbox: ${v.state}${v.reasons.length ? ` (${v.reasons.join("; ").slice(0, 600)})` : ""}`);
    })();
  }
  return { service, activation, sandbox, ready };
}
