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
export function selectWorkspace(env: Record<string, string | undefined>, d: { stateDir?: string; proposals: Proposals; protectedPaths: string[]; audit?: (e: WorkspaceAudit) => void; uid?: () => number }) {
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
  if (service.enabled) {
    service.recover();
    // The self-test runs in the background; until it passes, exec_start refuses (sandbox state "unknown"/"unsupported").
    void sandbox?.probe().catch(() => undefined);
  }
  return { service, activation, sandbox };
}
