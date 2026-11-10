import type { Proposal, Proposals } from "./agent.ts";
import type { Jobs } from "./jobs.ts";
import type { Notifier } from "./notify.ts";
import type { SysClient } from "./ops-sys-client.ts";
import { randomBytes } from "node:crypto";
import {
  FUNNEL_HTTPS_PORT,
  MAX_PLAN_PACKAGES,
  PLAN_WAIT_MS,
  REBOOT_PROPOSE_MIN_LEAD_MS,
  SYS_CONFIRM_TTL_MS,
  cap,
  flagPlan,
  isFunnelAction,
  isSysTerminal,
  planDigestOf,
  planFlagged,
  rebootAtProblem,
  sortPlan,
  sysDigestOf,
  sysOpIdFor,
  validateHostTarget,
  validPlanEntry,
  type DigestBind,
  type PlanEntry,
  type PlanFlags,
  type FunnelTarget,
  type SysEvidence,
  type SysMutatingAction,
  type SysState,
  type SysTarget,
} from "./ops/sys-protocol.ts";
import type { Store } from "./store.ts";

// ORBIT's side of tier 3: turns a model request into an owner-only proposal and a confirmed proposal into exactly one helper
// operation. A proposal exists only if every check passed (helper present, target known, no operation already open); otherwise the
// tool throws and nothing exists. The ledger is persisted (STATE_DIRECTORY), so a confirmation and its result survive an ORBIT
// restart or a host reboot; afterwards ORBIT asks the helper for the outcome and reports it once.

export const SYS_PROPOSAL_TTL_MS = SYS_CONFIRM_TTL_MS;
const LEDGER_MAX = 50;

export type LedgerState = "dispatching" | SysState | "not_dispatched";
export type SysLedgerEntry = {
  opId: string;
  proposalId: string;
  action: SysMutatingAction;
  summary: string;
  target: SysTarget;
  digest: string;
  confirmedAt: string;
  expiresAt: string;
  state: LedgerState;
  result?: string;
  verification?: { checked: boolean; healthy?: boolean; detail: string; evidence?: SysEvidence };
  finishedAt?: string;
  // A reboot for later: when. cancelledAt: when the owner's cancellation was accepted by the helper (before it fired).
  scheduledFor?: string;
  cancelledAt?: string;
  planDigest?: string;
  checkedAt?: string;
  reportedAt?: string;
  error?: string;
  // What ORBIT knew about jobs when the owner confirmed (for the record only; the helper cannot see jobs).
  jobsAtConfirm?: JobsSnapshot;
};

const ended = (s: LedgerState) => s === "not_dispatched" || isSysTerminal(s);

// ---- active-job state: ORBIT-side only. The privileged helper cannot see jobs, so ORBIT is the one that checks, twice. ----

export type JobsSnapshot = {
  // false when ORBIT cannot tell (no job registry, or one that is not persisted): treated as "jobs may be running".
  known: boolean;
  active: string[];
  // Registered/running but quiet or never started: possibly dead, possibly working silently. Counted as possibly affected.
  uncertain: string[];
  detail: string;
};
export type JobState = () => JobsSnapshot;

export function jobStateOf(jobs: Jobs | undefined, now: () => Date = () => new Date()): JobState {
  return () => {
    if (!jobs) return { known: false, active: [], uncertain: [], detail: "ORBIT has no job registry here, so which jobs are running is unknown." };
    if (jobs.status().state !== "live") return { known: false, active: [], uncertain: [], detail: "ORBIT's job state is not persisted, so it may have lost track of running jobs: which jobs are running is unknown." };
    const active: string[] = [];
    const uncertain: string[] = [];
    for (const j of jobs.all()) {
      if ((j.state !== "registered" && j.state !== "running") || j.launch?.failedAt) continue;
      if (new Date(j.expiresAt) <= now()) continue; // an expired registration cannot report any more
      (jobs.health(j) === "ok" ? active : uncertain).push(j.id);
    }
    const parts = [`${active.length} active`, `${uncertain.length} quiet or not started (possibly still working)`];
    return { known: true, active, uncertain, detail: parts.join(", ") };
  };
}

const list = (ids: string[]) => (ids.length ? ids.slice(0, 8).join(", ") + (ids.length > 8 ? ` and ${ids.length - 8} more` : "") : "none");

export function jobWarning(s: JobsSnapshot, what: string): string {
  if (!s.known) return `Which jobs are running is UNKNOWN (${s.detail}). Assume running jobs can be cut off by ${what}.`;
  if (!s.active.length && !s.uncertain.length) return `No active or quiet jobs are registered.`;
  return `Jobs that ${what} can affect: ${s.active.length} active (${list(s.active)})${s.uncertain.length ? `; ${s.uncertain.length} quiet or not started, possibly still working (${list(s.uncertain)})` : ""}.`;
}

// Disruptive actions refuse a confirmation when jobs appeared since the owner saw the card, or when ORBIT could tell then and cannot now.
export function jobsWorsened(held: JobsSnapshot, now: JobsSnapshot): string | undefined {
  if (held.known && !now.known) return "ORBIT can no longer tell which jobs are running.";
  const was = new Set([...held.active, ...held.uncertain]);
  const added = [...now.active, ...now.uncertain].filter((id) => !was.has(id));
  return added.length ? `New job(s) are running since the card was shown: ${list(added)}.` : undefined;
}

const DISRUPTIVE: readonly SysMutatingAction[] = ["reboot_host", "funnel_disable"];

export type JobsTarget = () => { host: string; port: number } | undefined;

export type SysOps = ReturnType<typeof sysOps>;
export type SysProposal = Proposal & { kind: "ops_sys" };

// ORBIT waits for a plan at least as long as the plan runner may run (PLAN_WAIT_MS = the runner's declared limits + lock waits + a
// margin, sys-protocol.ts), so it never gives up on a runner that is still within its own budget. See docs/orbit-ops-sys.md
// "Plan timeouts".
export const PLAN_POLL_MS = 3_000;
export const PLAN_MAX_POLLS = Math.ceil(PLAN_WAIT_MS / PLAN_POLL_MS);

export function sysOps(deps: { client?: SysClient; store: Store<SysLedgerEntry[]>; notify: Notifier; proposals: Proposals; jobState: JobState; jobsTarget: JobsTarget; now?: () => Date; sleep?: (ms: number) => Promise<void>; newId?: () => string }) {
  const { client, store, notify, proposals } = deps;
  const now = deps.now ?? (() => new Date());
  // Exact validated targets (and the job state the owner was shown) for open proposals, in memory only. A restart drops them
  // together with the proposals.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pending = new Map<string, { action: SysMutatingAction; target: SysTarget; jobs: JobsSnapshot; expiresAt: string; bind: DigestBind }>();
  let refreshing: Promise<void> | undefined;

  const save = (entries: SysLedgerEntry[]) => store.write(entries.slice(-LEDGER_MAX));
  const update = (opId: string, patch: Partial<SysLedgerEntry>) => {
    const all = store.read();
    const i = all.findIndex((e) => e.opId === opId);
    if (i >= 0) {
      all[i] = { ...all[i]!, ...patch };
      save(all);
    }
  };

  type Extra = { plan?: { upgrades: PlanEntry[]; flags: PlanFlags; digest: string }; rebootAt?: string };
  const flagLine = (f: PlanFlags) =>
    (Object.entries(f) as [string, string[]][]).filter(([, l]) => l.length).map(([k, l]) => `${k}: ${l.slice(0, 6).join(", ")}${l.length > 6 ? ` +${l.length - 6}` : ""}`).join("; ");
  const text = (action: SysMutatingAction, target: SysTarget, jobs: JobsSnapshot, extra: Extra = {}): { summary: string; warnings: string[]; display: Record<string, string> } => {
    const host = (target as { host: string }).host;
    switch (action) {
      case "install_os_updates": {
        const plan = extra.plan!;
        const flagged = planFlagged(plan.flags);
        return {
          summary: `Install ${plan.upgrades.length} pending OS package upgrade(s) on host "${host}" with apt-get upgrade only (exactly the package plan listed on this card; no distribution upgrade, no package removed or newly installed; refused if the plan has changed). It NEVER reboots.`,
          warnings: [
            ...(flagged ? [`FLAGGED PACKAGES - ${flagLine(plan.flags)}. These can restart daemons, drop SSH or Tailscale connections, or (kernel, libc) need a reboot to take full effect. Read the package list before confirming.`] : []),
            `This is a SHARED host: production OpenClaw runs on it as well as ORBIT. Upgraded libraries and daemons can briefly stall or break services there. ORBIT's own health is checked afterwards; OpenClaw is NOT checked by this tool.`,
            `Services may restart even though this tool restarts none: needrestart is suspended, but package maintainer scripts (openssh, tailscale, libc, systemd and others) can restart daemons themselves, and this tool cannot prevent that.`,
            `The plan was made by apt-get update (which refreshes apt metadata) and apt-get -s upgrade just now. It is recomputed before upgrading; if it differs the update is refused and you must ask again. A small window remains between that final check and apt's own run (apt-get resolves again).`,
            `Recovery limits: package upgrades cannot be rolled back by ORBIT. A failed or half-finished upgrade is left for an operator to repair (dpkg --configure -a). If the host then needs a reboot, that is a separate proposal.`,
            jobWarning(jobs, "service restarts or a stalled package upgrade"),
          ],
          display: {
            action: "install_os_updates",
            host,
            policy: "apt-get upgrade only; exactly this plan; no removals, no new packages, no reboot",
            packages: String(plan.upgrades.length),
            ...(flagged ? { FLAGGED: flagLine(plan.flags) } : {}),
            plan: plan.upgrades.map(([n, o, v]) => `${n} ${o} -> ${v}`).join("\n"),
            planDigest: plan.digest.slice(0, 16),
          },
        };
      }
      case "reboot_host": {
        const when = extra.rebootAt ? `at ${extra.rebootAt}` : "now";
        return {
          summary: extra.rebootAt ? `REBOOT the whole host "${host}" at ${extra.rebootAt} (UTC). It can be cancelled from chat until it fires.` : `REBOOT the whole host "${host}" now.`,
          warnings: [
            `This is a SHARED host: ORBIT, production OpenClaw and the public job listener all go down for the length of the reboot (typically minutes), ${when}.`,
            ...(extra.rebootAt ? [`Scheduled for later: job state is checked now and when you confirm, NOT at ${extra.rebootAt}; jobs that start in between can be cut off. Cancel with ops_sys_cancel_reboot before it fires; once it has fired it cannot be cancelled.`] : []),
            `Recovery limits: if the host does not come back, ORBIT cannot help (it is down too) and you need provider console access. After it returns, ORBIT verifies a changed boot id and its own health only; OpenClaw is NOT checked, and until then the result is "rebooting", never success.`,
            jobWarning(jobs, "the reboot"),
          ],
          display: { action: "reboot_host", host, when: extra.rebootAt ?? "now" },
        };
      }
      case "funnel_enable":
      case "funnel_disable": {
        const t = target as FunnelTarget;
        const on = action === "funnel_enable";
        return {
          summary: `${on ? "ENABLE" : "DISABLE"} the public Tailscale Funnel of the orbit-jobs node ${t.host} (https ${FUNNEL_HTTPS_PORT} → http://127.0.0.1:${t.port}), changing the orbit-jobs node only; this host's own Tailscale is never touched.`,
          warnings: on
            ? [
                `This publishes ORBIT's job listener (127.0.0.1:${t.port}) on the public internet at https://${t.host}. Job endpoints require a per-job token, but it is a public surface.`,
                `Verification reads the orbit-jobs node's own configuration. Public reachability from outside is NOT tested.`,
              ]
            : [
                `Cloud job runners reach ORBIT through this Funnel. Disabling it cuts running jobs off from check-ins and steers, and new jobs cannot report. ${jobWarning(jobs, "disabling the Funnel")}`,
                `Recovery limits: turning it back on needs another confirmation through this same path. If you are locked out, run on the host: tailscale --socket=/run/orbit-tailscale-jobs/tailscaled.sock funnel --bg --https=443 http://127.0.0.1:${t.port}`,
                `Verification reads the orbit-jobs node's own configuration. Public reachability from outside is NOT tested.`,
              ],
          display: { action, node: t.host, https: String(FUNNEL_HTTPS_PORT), proxy: `http://127.0.0.1:${t.port}` },
        };
      }
    }
  };

  // Asks the helper for the package plan (apt-get update then apt-get -s upgrade, run by the helper's own runner; nothing is
  // installed) and waits for it. Throws, creating nothing, unless a complete, self-consistent plan came back.
  const obtainPlan = async (): Promise<{ upgrades: PlanEntry[]; flags: PlanFlags; digest: string }> => {
    const planId = (deps.newId ?? (() => randomBytes(20).toString("hex")))();
    const none = "No proposal was created.";
    let r;
    try {
      r = await client!.call({ action: "plan_os_updates", opId: planId });
    } catch (err) {
      throw new Error(`${cap(err instanceof Error ? err.message : "error", 200)} ${none}`);
    }
    if (!r.ok) throw new Error(`The tier 3 helper refused to make an update plan: ${r.message} ${none}`);
    for (let i = 0; ; i++) {
      const op = r.ok ? ((r.data.operation ?? {}) as { state?: string; summary?: string; plan?: { upgrades?: unknown; digestKey?: unknown } }) : {};
      if (op.state && isSysTerminal(op.state)) {
        if (op.state === "no_change") throw new Error(`No OS package upgrades are pending (the helper refreshed apt metadata; nothing was installed). ${none}`);
        if (op.state !== "verified") throw new Error(`The update plan could not be made: ${cap(op.summary ?? op.state, 300)} ${none}`);
        const up = op.plan?.upgrades;
        if (!Array.isArray(up) || !up.length || up.length > MAX_PLAN_PACKAGES || !up.every(validPlanEntry)) throw new Error(`The helper's update plan was malformed. ${none}`);
        const upgrades = sortPlan(up as PlanEntry[]);
        const digest = planDigestOf(upgrades);
        if (typeof op.plan?.digestKey !== "string" || op.plan.digestKey !== digest.slice(0, 24)) throw new Error(`The helper's update plan does not match its own digest, so it cannot be bound to a confirmation. ${none}`);
        return { upgrades, flags: flagPlan(upgrades), digest };
      }
      if (i >= PLAN_MAX_POLLS) {
        // Giving up does NOT stop the plan: a plan cannot be cancelled (apt-get is never killed), so say what is true. The last status
        // read just now is the evidence; the plan keeps the helper's slot until its runner ends or is found dead.
        const st = typeof op.state === "string" ? op.state : "unknown";
        throw new Error(`The update plan (operation ${planId.slice(0, 12)}) is STILL ${st} on the helper: ORBIT stopped waiting after ${Math.round((PLAN_MAX_POLLS * PLAN_POLL_MS) / 60000)} minutes, and that did not stop it (a plan cannot be cancelled; the helper never kills apt). It may still be refreshing apt metadata and it holds the tier 3 slot until it ends, so other tier 3 operations are refused meanwhile. Nothing was installed. Its result is discarded; ask again once it has ended. ${none}`);
      }
      await sleep(PLAN_POLL_MS);
      try {
        r = await client!.call({ action: "op_status", opId: planId });
      } catch (err) {
        throw new Error(`${cap(err instanceof Error ? err.message : "error", 200)} ${none}`);
      }
      if (!r.ok) throw new Error(`The tier 3 helper could not report the plan: ${r.message} ${none}`);
    }
  };

  return {
    available: Boolean(client),

    // Validates and checks the helper, then makes an owner-only proposal. Nothing is changed. If any check fails this THROWS and no
    // proposal exists: the caller (and the model) must not say otherwise.
    async propose(action: SysMutatingAction, opts: { rebootAt?: string } = {}): Promise<SysProposal> {
      if (opts.rebootAt !== undefined && action !== "reboot_host") throw new Error("Only a reboot can be scheduled. No proposal was created.");
      if (!client) throw new Error("Tier 3 is not available: no helper client is configured. No proposal was created. See docs/orbit-ops-sys.md for installation.");
      let status;
      try {
        status = await client.call({ action: "sys_status" });
      } catch (err) {
        throw new Error(`${cap(err instanceof Error ? err.message : "error", 200)} No proposal was created. Manual installation steps are in docs/orbit-ops-sys.md.`);
      }
      if (!status.ok) throw new Error(`The tier 3 helper refused: ${status.message}. No proposal was created.`);
      const d = status.data as { hostname?: unknown; orbitJobsSocketPresent?: unknown; rebootCooldownUntil?: unknown; openOperation?: { action?: string; state?: string } | null; openOperations?: unknown };
      // The helper decides (the exclusivity matrix, docs/orbit-ops-sys.md); this refuses early, before any plan or card. A scheduled
      // reboot that is only waiting does not block a Funnel change; update, plan and reboot are exclusive with everything open.
      const open = (Array.isArray(d.openOperations) ? d.openOperations : d.openOperation ? [d.openOperation] : []) as { action?: string; state?: string }[];
      const waiting = (o: { action?: string; state?: string }) => o.action === "reboot_host" && o.state === "scheduled";
      const blocking = open.filter((o) => !(isFunnelAction(action) && waiting(o)) && !(opts.rebootAt !== undefined && (o.action === "funnel_enable" || o.action === "funnel_disable")));
      if (blocking[0]) {
        const o = blocking[0];
        const hint = waiting(o) ? "cancel the scheduled reboot first (ops_sys_cancel_reboot) or wait for it" : o.action === "plan_os_updates" ? "an earlier update plan is still running on the helper (ORBIT may have stopped waiting for it, which does not stop it); wait for it to end" : "wait for its result";
        throw new Error(`Another tier 3 operation (${String(o.action)}, ${String(o.state)}) is still open on the host. No proposal was created; ${hint}.`);
      }
      let rebootAt: string | undefined;
      if (opts.rebootAt !== undefined) {
        const problem = rebootAtProblem(opts.rebootAt, now().getTime(), REBOOT_PROPOSE_MIN_LEAD_MS);
        if (problem) throw new Error(`${problem} No proposal was created.`);
        rebootAt = opts.rebootAt;
      }
      if (action === "reboot_host" && typeof d.rebootCooldownUntil === "string" && Date.parse(d.rebootCooldownUntil) > (rebootAt ? Date.parse(rebootAt) : now().getTime())) {
        throw new Error(`A reboot was issued recently; the next one is not accepted before ${d.rebootCooldownUntil}${rebootAt ? " (and that is later than the time asked for)" : ""}. No proposal was created.`);
      }
      let target: SysTarget;
      if (isFunnelAction(action)) {
        const t = deps.jobsTarget();
        if (!t) throw new Error("ORBIT does not know its orbit-jobs target (ORBIT_PUBLIC_JOB_URL and ORBIT_INGRESS_PORT are not both set), so there is nothing here to change. No proposal was created.");
        if (d.orbitJobsSocketPresent !== true) {
          throw new Error(
            "The orbit-jobs Tailscale node is not on this host (its socket /run/orbit-tailscale-jobs/tailscaled.sock is absent), so there is no helper that can reach it. Nothing was proposed, and the host's own Tailscale will NOT be changed instead. Install the orbit-jobs node here (deploy/install.sh does, with its auth key) or change Funnel by hand on the machine that runs it: see docs/orbit-ops-sys.md.",
          );
        }
        target = { host: t.host, port: t.port };
      } else {
        if (typeof d.hostname !== "string" || !d.hostname) throw new Error("The helper did not report its host name. No proposal was created.");
        // Validated here, before any proposal or plan exists: a name the helper would itself refuse (an FQDN, an underscore, upper
        // case) can never be confirmed, so it must not reach the owner as a card.
        try {
          target = validateHostTarget({ host: d.hostname });
        } catch {
          throw new Error(`The helper reported a host name ORBIT cannot use (${cap(JSON.stringify(d.hostname), 80)}): tier 3 needs a plain name of lowercase letters, digits and dashes. No proposal was created.`);
        }
      }
      let plan: Awaited<ReturnType<typeof obtainPlan>> | undefined;
      if (action === "install_os_updates") plan = await obtainPlan();
      const bind: DigestBind = { ...(plan ? { planDigest: plan.digest } : {}), ...(rebootAt ? { rebootAt } : {}) };
      const jobs = deps.jobState();
      const { summary, warnings, display } = text(action, target, jobs, { ...(plan ? { plan } : {}), ...(rebootAt ? { rebootAt } : {}) });
      const digest = sysDigestOf(action, target, bind);
      const p = proposals.propose({ kind: "ops_sys", action, summary, display, warnings, digest }, SYS_PROPOSAL_TTL_MS) as SysProposal;
      for (const id of pending.keys()) if (!proposals.peek(id)) pending.delete(id);
      pending.set(p.id, { action, target, jobs, expiresAt: p.expiresAt, bind });
      return p;
    },

    // Called after the route checked the owner and the digest the owner confirmed, and spent the proposal. Re-checks both against
    // what was validated at proposal time, rechecks job state, then makes one dispatch.
    async confirm(p: SysProposal): Promise<{ code: number; body: unknown }> {
      const held = pending.get(p.id);
      pending.delete(p.id);
      if (!held || held.action !== p.action || sysDigestOf(held.action, held.target, held.bind) !== p.digest) {
        return { code: 409, body: { error: "This proposal no longer matches what was validated (or ORBIT restarted since). Nothing was done; ask again." } };
      }
      if (!client) return { code: 503, body: { error: "The tier 3 helper is not configured. Nothing was done." } };
      if (Date.parse(held.expiresAt) <= now().getTime()) return { code: 410, body: { error: "This proposal expired. Nothing was done; ask again." } };
      if (held.bind.rebootAt) {
        const problem = rebootAtProblem(held.bind.rebootAt, now().getTime());
        if (problem) return { code: 410, body: { error: `The scheduled time can no longer be honoured (${problem}) Nothing was done; ask again.` } };
      }
      if (DISRUPTIVE.includes(held.action)) {
        const worse = jobsWorsened(held.jobs, deps.jobState());
        if (worse) return { code: 409, body: { error: `Not done: the job situation changed since this card was shown. ${worse} Nothing was done; ask again to see the current state.` } };
      }
      const opId = sysOpIdFor(p.id);
      const all = store.read();
      if (all.some((e) => e.proposalId === p.id || e.opId === opId)) return { code: 409, body: { error: "This confirmation was already used. Nothing was done." } };
      save([...all, { opId, proposalId: p.id, action: p.action, summary: p.summary, target: held.target, digest: p.digest, confirmedAt: now().toISOString(), expiresAt: held.expiresAt, state: "dispatching", ...(held.bind.rebootAt ? { scheduledFor: held.bind.rebootAt } : {}), ...(held.bind.planDigest ? { planDigest: held.bind.planDigest } : {}), jobsAtConfirm: deps.jobState() }]);
      let reply;
      try {
        reply = await client.call({ action: p.action, opId, target: held.target, digest: p.digest, expiresAt: held.expiresAt, ...held.bind });
      } catch (err) {
        // The call may or may not have reached the helper: leave it dispatching; refresh() will ask the helper and settle it.
        update(opId, { error: cap(err instanceof Error ? err.message : "error", 200) });
        return { code: 502, body: { error: `The tier 3 helper did not confirm the dispatch (${cap(err instanceof Error ? err.message : "error", 160)}). Nothing is verified. ORBIT will check with the helper and report.`, opId } };
      }
      if (!reply.ok) {
        update(opId, { state: "not_dispatched", error: `${reply.code}: ${reply.message}`, finishedAt: now().toISOString(), reportedAt: now().toISOString() });
        return { code: reply.code === "busy" || reply.code === "cooldown" ? 409 : 502, body: { error: `The tier 3 helper refused: ${reply.message} Nothing was done.`, opId } };
      }
      const op = reply.data.operation as { state?: LedgerState } | undefined;
      update(opId, { state: op?.state && op.state !== ("dispatching" as string) ? op.state : "accepted" });
      return {
        code: 202,
        body: {
          status: "dispatched",
          dispatched: true,
          verified: false,
          opId,
          action: p.action,
          note: held.bind.rebootAt
            ? `Scheduled: the helper's runner waits until ${held.bind.rebootAt}. Nothing has been done and nothing is verified; cancel with ops_sys_cancel_reboot until it fires.`
            : "Dispatched to the privileged helper's separate runner. Nothing is verified yet: ORBIT will report the verified result, and ops_sys_operations shows it.",
        },
      };
    },

    list: (): SysLedgerEntry[] => store.read(),

    // Cancel a reboot that has not fired. Reports success ONLY when the helper confirms it won the cancel-versus-fire decision; any
    // other answer (too late, unreachable, unknown) throws, and the reboot must then be treated as still possible.
    async cancelReboot(opId?: string): Promise<{ cancelled: true; opId: string; alreadyCancelled: boolean; note: string }> {
      if (!client) throw new Error("Tier 3 is not available: no helper client is configured. Nothing was cancelled.");
      const open = store.read().filter((e) => e.action === "reboot_host" && !ended(e.state));
      const target = opId ? store.read().find((e) => e.opId === opId && e.action === "reboot_host") : open.length === 1 ? open[0] : undefined;
      if (!target) throw new Error(opId ? "That is not a reboot ORBIT has on record. Nothing was cancelled." : open.length ? "More than one reboot is open: name the operation id. Nothing was cancelled." : "There is no reboot waiting to fire (none scheduled or in flight). Nothing was cancelled.");
      let reply;
      try {
        reply = await client.call({ action: "cancel_reboot", opId: target.opId });
      } catch (err) {
        throw new Error(`NOT cancelled: the helper could not be reached (${cap(err instanceof Error ? err.message : "error", 160)}). The reboot may still fire at ${target.scheduledFor ?? "its time"}; try again.`);
      }
      if (!reply.ok) {
        if (reply.code === "too_late" || reply.code === "not_cancellable") await this.refresh();
        throw new Error(`NOT cancelled: ${reply.message}`);
      }
      const at = now().toISOString();
      const already = reply.data.alreadyCancelled === true;
      if (!already || target.state !== "cancelled") update(target.opId, { state: "cancelled", result: "Cancelled by the owner before it fired. No reboot was issued by this operation.", cancelledAt: at, finishedAt: at, checkedAt: at, reportedAt: at });
      return { cancelled: true, opId: target.opId, alreadyCancelled: already, note: already ? "It was already cancelled." : "Cancelled before it fired: the helper confirms no reboot was issued." };
    },

    // Asks the helper about every operation that has not ended and records what it observed. Reports each end once. An unreachable
    // helper changes nothing (for example while the host reboots): the last known state stays, marked with when it was checked.
    refresh(): Promise<void> {
      refreshing ??= (async () => {
        if (!client) return;
        for (const e of store.read().filter((x) => !ended(x.state))) {
          try {
            const r = await client.call({ action: "op_status", opId: e.opId });
            const at = now().toISOString();
            if (!r.ok) {
              if (r.code === "not_found") {
                update(e.opId, e.state === "dispatching" ? { state: "not_dispatched", result: "The helper has no record of this operation: it never started, nothing was done.", finishedAt: at, checkedAt: at } : { state: "interrupted", result: "The helper lost this operation's record; the outcome is unknown. Check the server.", finishedAt: at, checkedAt: at });
              }
              continue;
            }
            const op = (r.data.operation ?? {}) as Partial<SysLedgerEntry> & { summary?: string };
            update(e.opId, { state: op.state ?? e.state, ...(op.summary ? { result: cap(op.summary, 500) } : {}), ...(op.verification ? { verification: op.verification } : {}), ...(op.finishedAt ? { finishedAt: op.finishedAt } : {}), checkedAt: at });
          } catch {
            // helper unreachable (reboot, restart); try again on the next tick
          }
        }
        for (const e of store.read().filter((x) => ended(x.state) && !x.reportedAt)) {
          const label = e.state === "verified" ? "verified" : e.state.replace("_", " ");
          const text = `Server action "${e.action}" ${label}: ${e.result ?? e.error ?? "no detail"}`;
          update(e.opId, { reportedAt: now().toISOString() });
          // Urgent so it is not held for quiet hours: the owner confirmed this and is waiting for the outcome.
          notify.send(cap(text, 700), true);
        }
      })().finally(() => (refreshing = undefined));
      return refreshing;
    },
  };
}
