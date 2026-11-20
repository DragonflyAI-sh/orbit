import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ChatTool, Proposal, Proposals } from "../agent.ts";
import { maskVaultText } from "../vault/filter.ts";
import { enableBlockers } from "./activation.ts";
import type { OwnerActivation, ValidationRecord } from "./activation.ts";
import type { Activation } from "./config.ts";
import { WORKSPACE_FILE_ENV, WORKSPACE_FLAG } from "./config.ts";
import { checkPlatform } from "./fsops.ts";
import { ownCgroup } from "./cgroup.ts";
import { REQUIRED_FLAGS } from "./sandbox.ts";
import type { Sandbox } from "./sandbox.ts";
import { canonical, showBlock, showText } from "./service.ts";
import type { WorkspaceAudit, WorkspaceService } from "./service.ts";
import { runSmoke, SMOKE_STEPS, VALIDATION_WORKSPACE } from "./smoke.ts";

// Named, owner-confirmed operations that set the workspace tools up, prove them on this host, and switch them on and off
// (docs/workspace-tools.md, "Activation"). They reuse the existing confirmation architecture: an owner-only tool makes a
// `workspace_op` proposal whose card shows the complete operation; the server's confirm route checks the owner (`workspace` port), the
// digest, the conversation and single use; this module then re-checks every precondition before it acts.
//
//   setup     host changes through the separately installed root helper orbit-ops-ws (src/ops/ws-*.ts): the card shows the helper's
//             exact plan, bound by its plan key; the helper re-plans and refuses if anything differs. Never done by ORBIT itself.
//   validate  the bounded synthetic smoke suite under the production sandbox (src/workspace/smoke.ts). ORBIT only; no root.
//   enable    the owner switch on, only if the sandbox self-test passed and a validation passed for the CURRENT policy.
//   disable   the owner switch off at once (no new tool, no confirmation), then queued runs withdrawn and running ones killed; each
//             exit is reported only when observed.
//   revoke    the host permission removed through the helper (the data, mounts and packages stay).
// There is no generic configuration editing, no arbitrary command, and no path or command chosen by the model: the model only picks
// one of these five names.

export const WORKSPACE_ADMIN_TOOL_NAMES = ["workspace_preflight", "workspace_admin_propose", "workspace_admin_status"] as const;
export const ADMIN_ACTIONS = ["setup", "validate", "enable", "disable", "revoke"] as const;
export type AdminActionName = (typeof ADMIN_ACTIONS)[number];
export type WsAdminAction = `ws_${AdminActionName}`;
export const isAdminAction = (a: string): a is WsAdminAction => (ADMIN_ACTIONS as readonly string[]).map((x) => `ws_${x}`).includes(a);
export const ADMIN_PROPOSAL_TTL_MS = 10 * 60 * 1000;
export const DISABLE_WAIT_MS = 15_000;

// The root helper as ORBIT sees it (src/ops-ws-client.ts). Its answers are data, redacted by the client.
export type WsReply = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };
export type WsHostClient = { status(): Promise<WsReply>; call(action: "ws_setup" | "ws_revoke" | "op_status", opId: string, planKey?: string): Promise<WsReply> };
export type PlanStep = { id: string; title: string; state: string; action?: string; detail?: string };
export type HostPlan = { steps: PlanStep[]; blockers: { id?: string; title?: string; detail?: string }[]; planKey: string };

export type HostOpEntry = {
  opId: string;
  proposalId: string;
  action: "ws_setup" | "ws_revoke";
  planKey?: string;
  confirmedAt: string;
  state: string; // dispatching, accepted, running, verified, no_change, failed, interrupted, not_dispatched
  result?: string;
  finishedAt?: string;
  checkedAt?: string;
  reportedAt?: string;
  error?: string;
};
const HOST_ENDED = ["verified", "no_change", "failed", "interrupted", "rejected", "not_dispatched"];
// How long after a confirmation the helper's "no such operation" may still mean "not recorded YET" (finding 4 of the PR #147 review):
// the dispatch call can still be in flight, queued behind other connections, or held by a front that is still checking the plan. The
// front is stopped by systemd after 40 s (RuntimeMaxSec), and the client gives up before that, so after this grace "not found" is final.
export const DISPATCH_GRACE_MS = 120_000;
// Host-operation entries kept: every entry that has not ended or not been reported, plus the most recent ended ones.
const HOST_OPS_KEEP = 50;
const keepHostOps = (all: HostOpEntry[]) => {
  const done = all.filter((e) => HOST_ENDED.includes(e.state) && e.reportedAt);
  const drop = new Set(done.slice(0, Math.max(0, done.length - HOST_OPS_KEEP)));
  return all.filter((e) => !drop.has(e));
};
export type HostOpStore = { read(): HostOpEntry[]; write(v: HostOpEntry[]): void };
export const hostOpIdFor = (proposalId: string) => createHash("sha256").update(`orbit-ops-ws:${proposalId}`).digest("hex").slice(0, 40);

type Held = { action: WsAdminAction; binding: Record<string, string> };
const digestOf = (h: Held) => `sha256:${createHash("sha256").update(canonical(h)).digest("hex")}`;
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const readText = (p: string) => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
};

// Reads the plan out of a ws_status answer. Anything malformed is refused (no proposal from a plan ORBIT cannot show in full).
export function parsePlan(data: Record<string, unknown>): HostPlan {
  const raw = (data.plan ?? data) as { steps?: unknown; blockers?: unknown; planKey?: unknown };
  if (!Array.isArray(raw.steps) || typeof raw.planKey !== "string" || !/^[0-9a-f]{24}$/.test(raw.planKey)) throw new Error("The host helper's plan is malformed; no proposal was made.");
  const steps = raw.steps.map((s) => {
    const x = s as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.state !== "string") throw new Error("The host helper's plan has a malformed step; no proposal was made.");
    return { id: x.id, title: String(x.title ?? x.id), state: x.state, ...(typeof x.action === "string" ? { action: x.action } : {}), ...(typeof x.detail === "string" ? { detail: x.detail } : {}) };
  });
  // orbit-ops-ws answers {plan: {steps, planKey}, blockers: [...]} (blockers beside the plan); a plan carrying its own is accepted too.
  const rawBlockers = Array.isArray(data.blockers) ? data.blockers : raw.blockers;
  const blockers = Array.isArray(rawBlockers) ? rawBlockers.map((b) => (typeof b === "string" ? { detail: b } : (b as { id?: string; title?: string; detail?: string }))) : [];
  return { steps, blockers, planKey: raw.planKey };
}

export function workspaceAdmin(d: {
  env: Record<string, string | undefined>;
  activation: Activation;
  service: WorkspaceService;
  sandbox?: Sandbox;
  owner: OwnerActivation;
  stateDir?: string;
  proposals: Proposals;
  host?: WsHostClient;
  hostStore?: HostOpStore;
  notify?: (text: string) => void;
  audit?: (e: WorkspaceAudit | Record<string, unknown>) => void;
  now?: () => Date;
  uid?: () => number;
  // Injectable for tests: the smoke suite, and how long disable waits for exits to be observed.
  smoke?: typeof runSmoke;
  disableWaitMs?: number;
  // Whether the admin tools are offered at all (they are when the host permits workspace tools or the helper socket exists).
  offered?: () => boolean;
}) {
  const now = d.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const config = d.activation.state === "enabled" ? d.activation.config : undefined;
  const pending = new Map<string, Held>();
  let mem: HostOpEntry[] = [];
  const store: HostOpStore = d.hostStore ?? { read: () => mem, write: (v) => (mem = v) };
  let validating: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  // Host operations whose dispatch call this process is still awaiting: refresh never judges them (their confirm reports them).
  const dispatching = new Set<string>();
  const audit = (e: Record<string, unknown>) => {
    try {
      d.audit?.({ at: iso(), port: "workspace", ...e });
    } catch {
      /* the sink reports its own failures */
    }
  };
  const valWs = config?.workspaces.find((w) => w.id === VALIDATION_WORKSPACE);
  const blockers = () =>
    enableBlockers({
      configured: Boolean(config),
      hostReason: d.activation.state === "enabled" ? undefined : d.activation.reason,
      sandboxState: d.sandbox?.status().state ?? (config?.workspaces.some((w) => w.exec) ? "none" : "supported"),
      sandboxReasons: d.sandbox?.status().reasons,
      sandboxPolicy: d.sandbox?.policyId(),
      policyHash: config?.policyHash,
      validationIdentity: valWs?.identity,
      quarantined: d.service.quarantined(),
      validation: d.owner.validation(),
      now: now(),
    });

  // A host change confirmed while a validation runs invalidates it; the validation's own later writes must not undo that.
  const keepInvalidation = (v: ValidationRecord): ValidationRecord => {
    const cur = d.owner.validation();
    return cur?.id === v.id && cur.invalidatedAt ? { ...v, invalidatedAt: cur.invalidatedAt, invalidatedReason: cur.invalidatedReason } : v;
  };
  // Setup and revoke change the host: the switch goes off first (and stays off afterwards), every queued or running command is
  // stopped, and the latest validation stops being evidence for enable.
  const hostChanging = (proposalId: string, why: string) => {
    const wasOn = d.owner.record().mode === "enabled";
    d.owner.set("off", { at: iso(), proposalId, reason: why });
    d.owner.invalidateValidation(iso(), why);
    const drained = d.service.drain(why);
    if (wasOn || drained.withdrawn.length || drained.killRequested.length) audit({ event: "result", kind: "ws_disable", workspace: "-", proposalId, detail: `off before host change; withdrawn ${drained.withdrawn.length}; killed ${drained.killRequested.length}` });
  };

  // ---- preflight (read-only) --------------------------------------------------------------------------------------------
  type Check = { id: string; status: "ok" | "missing" | "blocked" | "unavailable" | "off" | "info"; detail: string };
  async function preflight() {
    const checks: Check[] = [];
    const add = (id: string, status: Check["status"], detail: string) => checks.push({ id, status, detail: cap(detail, 400) });
    const uid = (d.uid ?? (() => process.getuid?.() ?? 0))();
    const plat = checkPlatform();
    add("platform", plat ? "missing" : "ok", plat ?? "Linux with /proc/self/fd");
    add("not_root", uid === 0 ? "blocked" : "ok", uid === 0 ? "ORBIT runs as root; workspace tools never run as root" : `ORBIT runs as uid ${uid}`);
    const bwrap = config?.sandbox.bwrap ?? "/usr/bin/bwrap";
    if (!existsSync(bwrap)) add("bubblewrap", "missing", `${bwrap} is not installed (the host setup installs the distribution package)`);
    else {
      const v = spawnSync(bwrap, ["--version"], { encoding: "utf8", env: {}, timeout: 5000 });
      const h = spawnSync(bwrap, ["--help"], { encoding: "utf8", env: {}, timeout: 5000 });
      const help = `${h.stdout ?? ""}${h.stderr ?? ""}`;
      const missing = REQUIRED_FLAGS.filter((f) => !new RegExp(`(^|\\s)${f.replace(/-/g, "\\-")}(\\s|=|$)`, "m").test(help));
      const st = statSync(bwrap);
      const setid = (st.mode & 0o6000) !== 0;
      add("bubblewrap", missing.length || setid || v.status !== 0 ? "blocked" : "ok", `${(v.stdout ?? "").trim() || "version unknown"}${missing.length ? `; lacks ${missing.join(", ")}` : ""}${setid ? "; it is setuid/setgid (not supported)" : ""}`);
    }
    const prl = config?.sandbox.prlimit ?? "/usr/bin/prlimit";
    add("prlimit", existsSync(prl) ? "ok" : "missing", existsSync(prl) ? prl : `${prl} is missing (util-linux)`);
    const maxNs = readText("/proc/sys/user/max_user_namespaces");
    const clone = readText("/proc/sys/kernel/unprivileged_userns_clone");
    const aa = readText("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
    add("user_namespaces", maxNs === "0" || clone === "0" ? "blocked" : aa === "1" ? "info" : "ok", `max_user_namespaces=${maxNs ?? "unknown"}${clone !== undefined ? `, unprivileged_userns_clone=${clone}` : ""}${aa !== undefined ? `, apparmor_restrict_unprivileged_userns=${aa}` : ""}${aa === "1" ? " (bubblewrap needs an AppArmor profile that allows user namespaces: a host security-policy decision for the operator; the self-test shows whether it works)" : ""}${maxNs === "0" || clone === "0" ? " (unprivileged user namespaces are off: an operator decision, not changed by ORBIT)" : ""}`);
    const unified = existsSync("/sys/fs/cgroup/cgroup.controllers");
    add("cgroup_v2", unified ? "ok" : "blocked", unified ? `unified hierarchy; host controllers: ${readText("/sys/fs/cgroup/cgroup.controllers") ?? "unknown"}` : "not the unified cgroup v2 hierarchy (changing that is a host-wide change and a reboot: operator decision)");
    const self = ownCgroup();
    if (self) {
      const unit = `/sys/fs/cgroup${self.replace(/\/[^/]+$/, "")}`;
      const ctl = readText(`${unit}/cgroup.controllers`) ?? "";
      const deleg = ["memory", "pids", "cpu"].every((c) => ctl.split(/\s+/).includes(c));
      add("cgroup_delegation", deleg ? "ok" : "missing", `ORBIT's cgroup ${self}; unit controllers: ${ctl || "none"}${deleg ? "" : " (needs Delegate=memory pids cpu and DelegateSubgroup=main: the host setup's drop-in)"}`);
    } else add("cgroup_delegation", "unavailable", "ORBIT's own cgroup could not be read");
    const hostReason = d.activation.state === "enabled" ? "" : d.activation.reason;
    add("host_permission", config ? "ok" : d.activation.state === "off" ? "off" : "missing", config ? `${WORKSPACE_FLAG}=enabled and ${WORKSPACE_FILE_ENV} acknowledged` : `${d.activation.state}: ${hostReason}`);
    if (config) {
      add("workspaces", "ok", config.workspaces.map((w) => `${w.id}${w.exec ? " (exec)" : " (read-only)"}`).join(", "));
      add("validation_workspace", valWs?.exec ? "ok" : "missing", valWs?.exec ? `${VALIDATION_WORKSPACE} (exec)` : `no exec workspace "${VALIDATION_WORKSPACE}" is configured (the host setup creates it)`);
    }
    const sb = d.sandbox?.status();
    add("sandbox_self_test", sb ? (sb.state === "supported" ? "ok" : sb.state === "unknown" ? "info" : "blocked") : "unavailable", sb ? `${sb.state}${sb.reasons.length ? `: ${sb.reasons.join("; ")}` : ""}${sb.checkedAt ? ` (checked ${sb.checkedAt})` : ""}` : "no sandbox (the host does not permit workspace tools, or no exec workspace)");
    const q = d.service.quarantined();
    add("cleanup", q.length ? "blocked" : "ok", q.length ? `unverified process trees: ${q.join(", ")} (exec is paused until a reap confirms them gone)` : "no unverified run cleanup");
    const v = d.owner.validation();
    add("validation", v?.state === "passed" ? "ok" : v ? "blocked" : "missing", v ? `${v.state} at ${v.finishedAt ?? v.startedAt} (${v.checks.filter((c) => c.result === "pass").length}/${v.checks.length} checks passed)` : "never run");
    add("owner_switch", d.owner.mode() === "enabled" ? "ok" : "off", d.owner.mode());
    let helper: Record<string, unknown> = { available: false, detail: "no host helper client" };
    let plan: HostPlan | undefined;
    if (d.host) {
      try {
        const r = await d.host.status();
        if (r.ok) {
          try {
            plan = parsePlan(r.data);
            helper = { available: true, plan: { steps: plan.steps, blockers: plan.blockers, planKey: plan.planKey } };
          } catch (e) {
            helper = { available: true, detail: e instanceof Error ? e.message : "malformed plan" };
          }
        } else helper = { available: false, detail: `${r.code}: ${r.message}` };
      } catch (e) {
        helper = { available: false, detail: e instanceof Error ? e.message : "unreachable" };
      }
    }
    const todo = plan?.steps.filter((s) => s.state === "todo") ?? [];
    const enableNow = blockers();
    const next = !config && !d.host
      ? "Install the orbit-ops-ws helper on the host (an operator step: docs/orbit-ops-ws.md), or prepare the host by hand (docs/workspace-tools.md), then run this preflight again."
      : !config && helper.available !== true
        ? `The host helper is not reachable (${String(helper.detail ?? "unknown")}). Install or start it (docs/orbit-ops-ws.md).`
        : plan?.blockers.length
          ? `Operator approval is needed first (not done by any tool): ${plan.blockers.map((b) => b.title ?? b.detail ?? b.id).join("; ")}.`
          : todo.length
            ? `Propose the host setup (workspace_admin_propose action "setup"): ${todo.length} step(s) to do.`
            : !config
              ? "The host setup is done but ORBIT has not loaded it: it needs a restart of orbit.service (the setup's last step does this)."
              : d.sandbox?.status().state !== "supported"
                ? `The sandbox self-test has not passed: ${d.sandbox?.status().reasons.join("; ") || "no sandbox"}.`
                : d.owner.mode() === "enabled"
                  ? "Workspace tools are enabled. Each write, patch and command still needs its own confirmation."
                  : enableNow.some((b) => /validation/.test(b))
                    ? 'Propose the on-host validation (workspace_admin_propose action "validate").'
                    : enableNow.length
                      ? `Enable is blocked: ${enableNow.join("; ")}.`
                      : 'Propose enable (workspace_admin_propose action "enable").';
    return { checks, helper, owner: d.owner.record(), nextStep: next, note: "Read-only: nothing was changed. Results describe what ORBIT can see now; the sandbox self-test and the validation are the evidence for isolation, not this list." };
  }

  // ---- proposals --------------------------------------------------------------------------------------------------------
  const proposalOf = (action: WsAdminAction, summary: string, display: Record<string, string>, warnings: string[], binding: Record<string, string>) => {
    const held: Held = { action, binding };
    const digest = digestOf(held);
    const p = d.proposals.propose({ kind: "workspace_op", action, summary, display, warnings, digest }, ADMIN_PROPOSAL_TTL_MS) as Proposal & { kind: "workspace_op" };
    for (const id of pending.keys()) if (!d.proposals.peek(id)) pending.delete(id);
    pending.set(p.id, held);
    audit({ event: "proposal", kind: action, workspace: "-", proposalId: p.id, digest: digest.slice(0, 19) });
    return { status: "pending-confirmation", executed: false, proposalId: p.id, action, summary, warnings, digest, expiresAt: p.expiresAt, note: "Nothing has been done. Rai must click Confirm on the card; every precondition is checked again then." };
  };

  async function propose(name: AdminActionName) {
    if (name === "setup" || name === "revoke") {
      if (!d.host) throw new Error("The host helper (orbit-ops-ws) is not available here, so no host change can be proposed. Installing it is an operator step (docs/orbit-ops-ws.md).");
      const r = await d.host.status();
      if (!r.ok) throw new Error(`The host helper refused or is unavailable (${r.code}: ${r.message}). No proposal was made.`);
      if (r.data.open) throw new Error("The host helper already has an operation in progress. No proposal was made.");
      if (name === "revoke") {
        return proposalOf("ws_revoke", "Revoke the host permission for workspace tools (the orbit.service drop-in loses its Environment= line), then restart ORBIT and check /status.", { "host change": "rewrite /etc/systemd/system/orbit.service.d/60-orbit-workspace.conf without its Environment= line; systemctl daemon-reload; systemctl restart orbit.service", kept: "the workspace images, mounts and their data, the orbit user, the workspaces file and every package stay (nothing is deleted)", impact: "ORBIT is offline for a few seconds while it restarts; running workspace commands die with it and are recorded as uncertain at the next start" }, ["After this, ORBIT offers no workspace tool and refuses every workspace confirmation until the host setup is run again."], { kind: "revoke" });
      }
      const plan = parsePlan(r.data);
      const todo = plan.steps.filter((s) => s.state === "todo");
      if (!todo.length) throw new Error(`Nothing to set up: every step of the host plan is already done${plan.blockers.length ? `; still needing operator approval: ${plan.blockers.map((b) => b.title ?? b.detail ?? b.id).join("; ")}` : ""}. No proposal was made.`);
      const display: Record<string, string> = {};
      // The helper's plan text is shown exactly, with invisible characters made visible and multi-line actions fenced.
      todo.forEach((s, i) => (display[`step ${i + 1}: ${showText(s.title)}`] = showBlock(s.action ?? s.detail ?? s.id)));
      const done = plan.steps.filter((s) => s.state === "done");
      if (done.length) display["already done (unchanged)"] = showText(done.map((s) => s.title).join("; "));
      const blocked = plan.steps.filter((s) => s.state === "blocked");
      if (blocked.length || plan.blockers.length) display["NOT done by this (needs separate operator approval)"] = showBlock([...blocked.map((s) => `${s.title}: ${s.detail ?? ""}`), ...plan.blockers.map((b) => `${b.title ?? b.id ?? "blocker"}: ${b.detail ?? ""}`)].join("\n"));
      display["plan key"] = plan.planKey;
      return proposalOf("ws_setup", `Set the host up for workspace tools: ${todo.length} step(s) by the root helper orbit-ops-ws, exactly as listed. Workspace tools stay OFF afterwards.`, display, [
        "These are changes to the shared host, made as root by the helper's runner: package install (if listed), a system user, dedicated loop-mounted workspace filesystems, a workspaces file, and an orbit.service drop-in (cgroup delegation, the two workspace paths, the host permission).",
        "orbit.service restarts at the end: ORBIT is offline for a few seconds. If a static user 'orbit' is created, ORBIT runs as it from that restart on and systemd re-owns ORBIT's state directory.",
        "The helper re-plans when it runs and refuses if the plan differs from this card. No other service is restarted; nothing is removed; the host's cgroup hierarchy and kernel settings are not changed.",
        "This does not enable the tools: that needs the on-host validation and a separate confirmation.",
      ], { kind: "setup", planKey: plan.planKey });
    }
    if (name === "validate") {
      if (!config) throw new Error(`The host does not permit workspace tools yet (${d.activation.state === "enabled" ? "" : d.activation.reason}). Run the host setup first. No proposal was made.`);
      if (d.owner.mode() === "enabled") throw new Error("Validation runs only while the tools are switched off (disable them first). No proposal was made.");
      if (!valWs?.exec) throw new Error(`No exec workspace "${VALIDATION_WORKSPACE}" is configured; the host setup creates it. No proposal was made.`);
      const sb = d.sandbox?.status();
      if (sb?.state !== "supported") throw new Error(`The sandbox self-test has not passed (${sb?.state ?? "no sandbox"}${sb?.reasons.length ? `: ${sb.reasons.join("; ")}` : ""}), so a validation cannot pass. No proposal was made.`);
      if (validating) throw new Error("A validation is already running. No proposal was made.");
      const q = d.service.quarantined();
      if (q.length) throw new Error(`An earlier run's process tree is not confirmed gone (${q.join(", ")}); a validation cannot pass until a reap verifies it (restart ORBIT to re-check). No proposal was made.`);
      const display: Record<string, string> = {
        workspace: `${valWs.id} (${valWs.identity}) only`,
        sandbox: `${d.sandbox!.policyId()}, policy ${config.policyHash}`,
        checks: SMOKE_STEPS.map((s, i) => `${i + 1}. ${s.title}${s.required ? "" : " (informational)"}`).join("\n"),
        commands: "fixed by ORBIT, not by the model: /bin/sh -c 'echo smoke-exec > <file>; id -u'; a read-only transcript script (id, /proc/net/dev, /proc/net/route, /proc/self/status, test -e on hidden paths, touch on read-only paths, env, one python3 TCP attempt to 192.0.2.1 if python3 exists); sleep 30 (killed at 3 s); sleep 60 (cancelled); /bin/sh -c 'sleep 60 & echo started'; rm -f smoke-<tag>-*",
        bounds: "every wait is bounded (at most about a minute per step); no fork bombs, no memory exhaustion, no stress or destructive probes; files are synthetic and stay in the validation workspace; the canary is a fresh random file in ORBIT's own state directory",
      };
      return proposalOf("ws_validate", `Run the bounded on-host validation of the workspace sandbox in workspace ${valWs.id} (synthetic files and fixed commands only).`, display, [
        "This runs real commands in the production sandbox on this host. It proves the basic isolation where ORBIT runs; it is not a full adversarial suite.",
        "Its result is recorded and is required, for this exact policy, before the tools can be enabled.",
      ], { kind: "validate", policyHash: config.policyHash, sandboxPolicy: d.sandbox!.policyId(), workspace: valWs.identity });
    }
    if (name === "enable") {
      if (d.owner.mode() === "enabled") throw new Error("Workspace tools are already enabled. No proposal was made.");
      const b = blockers();
      if (b.length) throw new Error(`Enable is refused: ${b.join("; ")}. No proposal was made.`);
      const v = d.owner.validation()!;
      return proposalOf("ws_enable", "Switch the workspace tools ON for the owner's replies (each write, patch and command still needs its own confirmation).", {
        workspaces: config!.workspaces.map((w) => `${w.id} (${w.exec ? "files and commands" : "files, read-only"})`).join(", "),
        sandbox: `${d.sandbox?.policyId() ?? "none"}, policy ${config!.policyHash}`,
        limits: JSON.stringify(config!.sandbox.limits),
        evidence: `validation ${v.id} passed at ${v.finishedAt} (${v.checks.filter((c) => c.result === "pass").length}/${v.checks.length} checks); sandbox self-test: supported`,
      }, [
        "The model can then PROPOSE file writes, patches and sandboxed commands in these workspaces. Nothing runs without a separate confirmation of each operation.",
        "Disable at any time with workspace_admin_propose action \"disable\"; it takes effect at once.",
      ], { kind: "enable", validationId: v.id, policyHash: config!.policyHash, sandboxPolicy: d.sandbox?.policyId() ?? "none" });
    }
    // disable
    if (d.owner.mode() !== "enabled") throw new Error("Workspace tools are already switched off. No proposal was made.");
    const desc = d.service.describe() as { running?: number; queued?: number };
    return proposalOf("ws_disable", "Switch the workspace tools OFF now: no new tool or confirmation; queued commands withdrawn; running commands killed.", {
      effect: "the owner switch is turned off first, so nothing new can be proposed or confirmed; then every queued command is withdrawn and every running one is killed",
      "in flight now": `${desc.running ?? 0} running, ${desc.queued ?? 0} queued`,
      reporting: `ORBIT waits up to ${Math.round((d.disableWaitMs ?? DISABLE_WAIT_MS) / 1000)} s and reports each command as cancelled only when its exit was observed, with whether its process tree was confirmed gone`,
    }, ["The host permission and the workspace data stay; enabling again needs a passing validation for the then-current policy."], { kind: "disable" });
  }

  // ---- confirmation (from the server's owner-checked, digest-checked route) -----------------------------------------------
  async function confirm(p: Proposal & { kind: "workspace_op" }): Promise<{ code: number; body: Record<string, unknown> }> {
    const held = pending.get(p.id);
    pending.delete(p.id);
    const deny = (code: number, why: string) => {
      audit({ event: "denial", kind: p.action, workspace: "-", proposalId: p.id, digest: p.digest.slice(0, 19), detail: why.slice(0, 120) });
      return { code, body: { error: `Nothing was done: ${why}`, message: `Nothing was done: ${why}` } };
    };
    if (!held) return deny(410, "this proposal is no longer held (ORBIT restarted or it expired). Ask again.");
    if (held.action !== p.action || digestOf(held) !== p.digest) return deny(409, "the proposal does not match what was validated.");
    audit({ event: "confirmation", kind: p.action, workspace: "-", proposalId: p.id, digest: p.digest.slice(0, 19) });

    if (held.action === "ws_disable") {
      if (d.owner.mode() !== "enabled") return deny(409, "workspace tools are already off.");
      d.owner.set("off", { at: iso(), proposalId: p.id, reason: "disabled by the owner" });
      const drained = d.service.drain("workspace tools disabled by the owner");
      const waitMs = d.disableWaitMs ?? DISABLE_WAIT_MS;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([d.service.idle(), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
      clearTimeout(timer);
      const report = drained.killRequested.map((id) => {
        const e = d.service.ledger.get(id);
        return { opId: id, state: e?.state ?? "unknown", processTreeGone: e?.treeGone ?? null, note: e?.state === "running" ? "kill sent; its exit has NOT been observed yet (exec_status shows it when it is)" : e?.treeGone === true ? "exit observed; process tree confirmed gone" : "exit observed; process tree NOT confirmed gone (exec stays paused until verified)" };
      });
      const still = report.filter((r) => r.state === "running").length;
      audit({ event: "result", kind: "ws_disable", workspace: "-", proposalId: p.id, detail: `off; withdrawn ${drained.withdrawn.length}; killed ${drained.killRequested.length}; unobserved ${still}` });
      const message = `Workspace tools are OFF (verified: the switch is off, no tool is offered and confirmations are refused). Withdrawn: ${drained.withdrawn.length}. Kill sent: ${drained.killRequested.length}${still ? `; ${still} exit(s) not observed yet` : ""}.`;
      return { code: 200, body: { state: "off", verified: true, withdrawn: drained.withdrawn, killed: report, message } };
    }

    if (held.action === "ws_enable") {
      const b = blockers();
      const v = d.owner.validation();
      if (b.length) return deny(409, `enable is refused now: ${b.join("; ")}.`);
      if (!v || !config || !valWs || v.id !== held.binding.validationId || config.policyHash !== held.binding.policyHash || (d.sandbox?.policyId() ?? "none") !== held.binding.sandboxPolicy) return deny(409, "the validation or the policy changed since the card was shown. Ask again.");
      // Bound to exactly what the validation proved; the switch reads as off as soon as any of it differs (activation.ts).
      d.owner.set("enabled", { at: iso(), proposalId: p.id, binding: { validationId: v.id, validatedAt: v.finishedAt ?? v.startedAt, policyHash: v.policyHash, sandboxPolicy: v.sandboxPolicy, validationIdentity: v.workspaceIdentity } });
      const on = d.owner.mode() === "enabled" && d.service.active && d.service.tools.length > 0;
      audit({ event: "result", kind: "ws_enable", workspace: "-", proposalId: p.id, detail: on ? "enabled" : "enable_unverified" });
      if (!on) {
        d.owner.set("off", { at: iso(), reason: "enable could not be verified" });
        return deny(500, "the switch was set but the tools did not become available; it was turned off again.");
      }
      return { code: 200, body: { state: "enabled", verified: true, tools: d.service.tools.map((t) => t.name), message: `Workspace tools are ON (verified: ${d.service.tools.length} tools are offered from the next reply). Every write, patch and command still needs its own confirmation.` } };
    }

    if (held.action === "ws_validate") {
      if (!config || !d.sandbox || !valWs) return deny(409, "the host no longer permits workspace tools or has no validation workspace.");
      if (d.owner.mode() === "enabled") return deny(409, "the tools were enabled meanwhile; validation runs only while they are off.");
      if (validating) return deny(409, "a validation is already running.");
      if (d.service.quarantined().length) return deny(409, "an earlier run's process tree is not confirmed gone; exec is paused.");
      if (config.policyHash !== held.binding.policyHash || d.sandbox.policyId() !== held.binding.sandboxPolicy || valWs.identity !== held.binding.workspace) return deny(409, "the sandbox policy changed since the card was shown. Ask again.");
      const id = `val-${randomBytes(8).toString("hex")}`;
      const rec: ValidationRecord = { id, state: "running", startedAt: iso(), proposalId: p.id, policyHash: config.policyHash, sandboxPolicy: d.sandbox.policyId(), workspaceIdentity: valWs.identity, checks: [] };
      d.owner.saveValidation(rec);
      const sandbox = d.sandbox;
      validating = (async () => {
        let final: ValidationRecord;
        try {
          const out = await (d.smoke ?? runSmoke)({ config, sandbox, stateDir: d.stateDir ?? "", outsideQuarantine: () => d.service.quarantined(), audit: (e) => audit({ ...e, validation: id }), onCheck: (c) => d.owner.saveValidation(keepInvalidation({ ...rec, checks: [...(d.owner.validation()?.checks ?? []), c] })) });
          const failed = out.checks.filter((c) => c.required && c.result !== "pass");
          final = { ...rec, state: out.passed ? "passed" : "failed", finishedAt: iso(), checks: out.checks, summary: out.passed ? `All ${out.checks.filter((c) => c.required).length} required checks passed.` : `${failed.length} required check(s) failed: ${failed.map((c) => c.id).join(", ")}.` };
        } catch (e) {
          final = { ...rec, state: "failed", finishedAt: iso(), checks: d.owner.validation()?.checks ?? [], summary: `The validation stopped with an error: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` };
        }
        final = keepInvalidation(final);
        d.owner.saveValidation(final);
        audit({ event: "result", kind: "ws_validate", workspace: VALIDATION_WORKSPACE, proposalId: p.id, detail: final.state });
        d.notify?.(cap(`Workspace validation ${final.state}: ${final.summary}`, 600));
      })().finally(() => (validating = undefined));
      return { code: 202, body: { state: "running", validationId: id, verified: false, message: `Validation ${id} started. Nothing is verified yet: workspace_admin_status shows each check as it completes, and ORBIT reports the result.` } };
    }

    // setup / revoke through the root helper
    if (!d.host) return deny(503, "the host helper is not configured.");
    const opId = hostOpIdFor(p.id);
    const all = store.read();
    if (all.some((e) => e.proposalId === p.id || e.opId === opId)) return deny(409, "this confirmation was already used.");
    const action = held.action as "ws_setup" | "ws_revoke";
    hostChanging(p.id, action === "ws_setup" ? "the host setup was confirmed (the host changes; validate again after it)" : "the host permission is being revoked");
    store.write([...keepHostOps(all), { opId, proposalId: p.id, action, ...(held.binding.planKey ? { planKey: held.binding.planKey } : {}), confirmedAt: iso(), state: "dispatching" }]);
    const update = (patch: Partial<HostOpEntry>) => store.write(store.read().map((e) => (e.opId === opId ? { ...e, ...patch } : e)));
    let reply: WsReply;
    dispatching.add(opId);
    try {
      reply = await d.host.call(action, opId, held.binding.planKey);
    } catch (e) {
      update({ error: cap(e instanceof Error ? e.message : "error", 200) });
      dispatching.delete(opId);
      return { code: 502, body: { opId, error: `The host helper did not confirm the dispatch (${cap(e instanceof Error ? e.message : "error", 160)}). Nothing is verified; ORBIT will ask the helper and report.`, message: "Not confirmed by the helper; ORBIT will check and report." } };
    }
    dispatching.delete(opId);
    if (!reply.ok) {
      update({ state: "not_dispatched", error: `${reply.code}: ${reply.message}`, finishedAt: iso(), reportedAt: iso() });
      return deny(reply.code === "busy" ? 409 : 502, `the host helper refused (${reply.code}: ${reply.message}).`);
    }
    const op = (reply.data.operation ?? {}) as { state?: string; summary?: string; finishedAt?: string };
    // The helper's answer is the state (it may already have ended, e.g. no_change). It is reported once, by refresh, like any other.
    update({ state: typeof op.state === "string" ? op.state : "accepted", ...(op.summary ? { result: cap(String(op.summary), 400) } : {}), ...(op.finishedAt ? { finishedAt: op.finishedAt } : {}) });
    audit({ event: "invocation", kind: action, workspace: "-", proposalId: p.id, opId: opId.slice(0, 12) });
    return { code: 202, body: { status: "dispatched", opId, verified: false, message: "Dispatched to the root helper's runner. Nothing is verified yet: ORBIT reports the verified result (ORBIT restarts during setup; the result is reported after the restart)." } };
  }

  // Asks the helper about host operations that have not ended, records what it observed and reports each end once.
  function refresh(): Promise<void> {
    refreshing ??= (async () => {
      if (!d.host) return;
      for (const e of store.read().filter((x) => !HOST_ENDED.includes(x.state) && !dispatching.has(x.opId))) {
        try {
          const r = await d.host.call("op_status", e.opId);
          const at = iso();
          // Still within the dispatch grace (possibly from before a restart): "not found" may mean "not recorded yet". Wait.
          const young = now().getTime() - Date.parse(e.confirmedAt) < DISPATCH_GRACE_MS;
          if (dispatching.has(e.opId)) continue;
          const patch: Partial<HostOpEntry> = !r.ok
            ? r.code === "not_found"
              ? e.state === "dispatching"
                ? young
                  ? { checkedAt: at }
                  : { state: "not_dispatched", result: "The helper has no record of this operation (asked again after the dispatch window closed): it never started, nothing was done.", finishedAt: at }
                : { state: "interrupted", result: "The helper lost this operation's record; the outcome is unknown.", finishedAt: at }
              : { checkedAt: at }
            : (() => {
                const op = (r.data.operation ?? {}) as { state?: string; summary?: string; finishedAt?: string };
                return { state: op.state ?? e.state, ...(op.summary ? { result: cap(String(op.summary), 400) } : {}), ...(op.finishedAt ? { finishedAt: op.finishedAt } : {}), checkedAt: at };
              })();
          store.write(store.read().map((x) => (x.opId === e.opId ? { ...x, ...patch } : x)));
        } catch {
          // unreachable now (for example during the restart the setup itself causes); try again on the next tick
        }
      }
      for (const e of store.read().filter((x) => HOST_ENDED.includes(x.state) && !x.reportedAt)) {
        store.write(store.read().map((x) => (x.opId === e.opId ? { ...x, reportedAt: iso() } : x)));
        d.notify?.(cap(`Workspace host ${e.action === "ws_setup" ? "setup" : "revoke"} ${e.state.replace("_", " ")}: ${e.result ?? e.error ?? "no detail"}`, 600));
      }
    })().finally(() => (refreshing = undefined));
    return refreshing;
  }

  function status() {
    const v = d.owner.validation();
    return {
      owner: d.owner.record(),
      host: { state: d.activation.state, ...(d.activation.state === "enabled" ? {} : { reason: d.activation.reason }) },
      sandbox: d.sandbox?.status() ?? null,
      cleanupUnverified: d.service.quarantined(),
      validation: v ? { ...v, checks: v.checks.map((c) => ({ ...c, detail: maskVaultText(c.detail) })) } : null,
      hostOperations: store.read().slice(-10).reverse(),
      enableBlockers: d.owner.mode() === "enabled" ? [] : blockers(),
    };
  }

  const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
  const tools: ChatTool[] = [
    {
      name: "workspace_preflight",
      readOnly: true,
      maxOutputChars: 20_000,
      description: "Read-only check of everything the workspace tools need on this host (platform, bubblewrap, user namespaces, cgroup v2 and delegation, host permission, workspaces, sandbox self-test, cleanup, validation, owner switch, and the host helper's setup plan), with the exact next step. Changes nothing.",
      parameters: obj({}, []),
      run: async (a) => {
        if (Object.keys(a).some((k) => a[k] !== undefined && a[k] !== null)) throw new Error("workspace_preflight takes no arguments.");
        return { value: await preflight(), provenance: "live" as const, source: "workspace/preflight" };
      },
    },
    {
      name: "workspace_admin_propose",
      description: 'Propose ONE named workspace activation operation for Rai to confirm on a card: "setup" (host changes by the root helper, exactly its plan), "validate" (bounded on-host smoke validation under the production sandbox), "enable" (switch the tools on; needs a passing validation for the current policy), "disable" (switch off at once; stops queued and running commands), "revoke" (remove the host permission). Nothing happens until Rai confirms; preconditions are checked again then. Never say it happened until workspace_admin_status shows the result.',
      parameters: obj({ action: { type: "string", enum: [...ADMIN_ACTIONS], description: "Which operation" } }, ["action"]),
      run: async (a) => {
        const extra = Object.keys(a).filter((k) => k !== "action" && a[k] !== undefined && a[k] !== null);
        if (extra.length) throw new Error(`Unknown argument(s): ${extra.join(", ")}.`);
        if (typeof a.action !== "string" || !(ADMIN_ACTIONS as readonly string[]).includes(a.action)) throw new Error(`action must be one of ${ADMIN_ACTIONS.join(", ")}.`);
        try {
          return { value: await propose(a.action as AdminActionName), provenance: "live" as const, source: "chat/proposals" };
        } catch (e) {
          audit({ event: "denial", kind: `ws_${a.action}`, workspace: "-", detail: "precondition" });
          throw e;
        }
      },
    },
    {
      name: "workspace_admin_status",
      readOnly: true,
      maxOutputChars: 20_000,
      description: "The workspace tools' activation state: the owner switch, the host permission, the sandbox self-test, unverified cleanups, the latest validation with every check, the host setup operations (with what the helper observed), and why enable is blocked if it is.",
      parameters: obj({}, []),
      run: async () => {
        await refresh().catch(() => undefined);
        return { value: status(), provenance: "live" as const, source: "workspace/admin" };
      },
    },
  ];

  return {
    get tools() {
      return (d.offered ? d.offered() : true) ? tools : [];
    },
    names: tools.map((t) => t.name),
    preflight,
    propose,
    confirm,
    cancelled: (proposalId: string) => void pending.delete(proposalId),
    refresh,
    status,
    validating: () => validating,
    // What became of a confirmed activation card (thread card live state).
    cardState(proposalId: string): { state: string; detail?: string } | undefined {
      const h = store.read().find((e) => e.proposalId === proposalId);
      if (h) return { state: h.state, detail: h.result ?? h.error };
      const v = d.owner.validation();
      if (v?.proposalId === proposalId) return { state: v.state, detail: v.summary };
      const o = d.owner.record();
      if (o.proposalId === proposalId) return { state: o.mode === "enabled" ? "enabled" : "off", detail: o.reason };
      return undefined;
    },
    owns: (action: string) => isAdminAction(action),
  };
}
export type WorkspaceAdmin = ReturnType<typeof workspaceAdmin>;
