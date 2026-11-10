import type { ChatTool, Proposals } from "./agent.ts";
import { compactList, detailJob } from "./job-view.ts";
import type { Jobs } from "./jobs.ts";
import type { MemoryPort } from "./memory.ts";
import type { Notifier } from "./notify.ts";
import type { AdminOps } from "./ops-admin.ts";
import type { SysOps } from "./ops-sys.ts";
import type { Ops } from "./ops-client.ts";
import { CONFIG_KEYS, type MutatingAction } from "./ops/admin-protocol.ts";
import type { SysMutatingAction } from "./ops/sys-protocol.ts";
import { LOG_LINES_DEFAULT, LOG_LINES_MAX } from "./ops/protocol.ts";
import type { Toolbox } from "./tools.ts";

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const need = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Needs {${key}: string}.`);
  return v.trim();
};

export type ChatToolDeps = {
  memory: MemoryPort;
  toolbox: Toolbox;
  jobs?: Jobs;
  // The root helper (read-only server operations). Absent means the tools are not offered.
  ops?: Ops;
  // Tier 2 (owner-confirmed server operations). Absent means the proposal tools are not offered.
  admin?: AdminOps;
  // Tier 3 (owner-confirmed OS updates, reboot, orbit-jobs Funnel). Absent means those proposal tools are not offered.
  sys?: SysOps;
  notify: Notifier;
  proposals: Proposals;
  // Routine names that can be launched, and whether the brief can be written. Empty when launching is not possible.
  launchable: () => { routines: string[]; problem?: string };
};

// Owner-only tools offered to the model during a chat reply. Reads and notify run directly;
// job_launch and job_steer only create proposals, and nothing happens until Rai confirms on the page.
export function chatTools(d: ChatToolDeps): ChatTool[] {
  const tools: ChatTool[] = [
    {
      name: "memory_search",
      description: "Keyword search over Rai's vault. Returns matching note paths.",
      parameters: obj({ query: str("Keywords to search for") }, ["query"]),
      run: async (a) => d.memory.search(need(a, "query")),
    },
    {
      name: "memory_read",
      description: "Read one vault note by the path memory_search returned.",
      parameters: obj({ path: str("Note path") }, ["path"]),
      run: async (a) => d.memory.read(need(a, "path")),
    },
    {
      name: "github_repo_status",
      description: "Open pull requests and the latest main CI run for a public GitHub repo, read-only.",
      parameters: obj({ repo: str("owner/name") }, ["repo"]),
      run: (a) => d.toolbox.call("github-repo-status", { repo: need(a, "repo") }),
    },
    {
      name: "notify",
      description: "Send Rai a notification (it shows in the page and goes to Discord if connected). Use only when he asks.",
      parameters: obj({ text: str("Message text") }, ["text"]),
      run: async (a) => ({ value: d.notify.send(need(a, "text").slice(0, 2000), false), provenance: "live", source: "notify" }),
    },
  ];
  const ops = d.ops;
  if (ops) {
    const op = (name: string, action: Parameters<Ops["call"]>[0], description: string): ChatTool => ({
      name,
      description: `${description} Read-only, from the orbit-ops root helper; nothing is changed or refreshed.`,
      parameters: obj({}, []),
      run: (a) => {
        if (Object.keys(a).length) throw new Error("This tool takes no arguments.");
        return ops.call(action);
      },
    });
    tools.push(
      op("ops_orbit_status", "orbit_status", "Status of the ORBIT service on the server: systemd state, restarts, and the commit it is serving."),
      {
        name: "ops_orbit_logs",
        description: `The last N lines of the ORBIT service log (default ${LOG_LINES_DEFAULT}, at most ${LOG_LINES_MAX}; long lines are cut and secrets are redacted). Read-only.`,
        parameters: obj({ lines: { type: "integer", minimum: 1, maximum: LOG_LINES_MAX, description: "How many recent lines" } }, []),
        run: (a) => {
          const extra = Object.keys(a).filter((k) => k !== "lines");
          if (extra.length) throw new Error("Only {lines: integer} is accepted.");
          return ops.call("orbit_logs", "lines" in a ? { lines: a.lines } : {});
        },
      },
      op("ops_deploy_state", "deploy_state", "Deploy state: deployed commit, last failure, recent releases and the deploy timer."),
      op("ops_host_health", "host_health", "Host health: disk, memory, load, uptime, pending OS updates (existing cache) and whether a restart is required."),
      op("ops_tailscale_status", "tailscale_status", "Tailscale state of this host and of the orbit-jobs node, with the LOCAL Funnel configuration. It does not test remote Funnel reachability."),
      op("ops_vault_sync", "vault_sync", "Which vault commit the server copy is at and how old that sync is."),
      op("ops_credentials", "credentials", "Which credential files are present on the server: names, sizes and dates only. Contents are never read."),
    );
  }
  const admin = d.admin;
  if (admin) {
    // Every one of these only PROPOSES. The operation runs after Rai clicks Confirm on the page, and ORBIT reports what the
    // helper observed afterwards; "dispatched" is never "done".
    const propose = (name: string, action: MutatingAction, description: string, parameters: Record<string, unknown> = obj({}, []), pick?: (a: Record<string, unknown>) => { changes?: unknown }): ChatTool => ({
      name,
      description: `${description} This does NOT do it: it creates a proposal that Rai must confirm with a button on the page, and the action is then carried out by a separate privileged helper. Never say it happened until ops_admin_operations shows a verified result.`,
      parameters,
      run: async (a) => {
        const input = pick ? pick(a) : {};
        if (!pick && Object.keys(a).length) throw new Error("This tool takes no arguments.");
        const p = admin.propose(action, input);
        return {
          value: { status: "pending-confirmation", executed: false, proposalId: p.id, action, summary: p.summary, settings: p.display, digest: p.digest, expiresAt: p.expiresAt, note: "Nothing has been done. Rai must click Confirm on the page." },
          provenance: "live",
          source: "chat/proposals",
        };
      },
    });
    tools.push(
      propose("ops_propose_restart_orbit", "restart_orbit", "Propose restarting the ORBIT service."),
      propose("ops_propose_deploy_now", "deploy_now", "Propose running the deploy now (the same service the deploy timer starts)."),
      propose("ops_propose_rollback", "rollback_release", "Propose rolling back to the previous known-good release."),
      propose("ops_propose_refresh_vault", "refresh_vault", "Propose refreshing the server's vault copy now."),
      propose(
        "ops_propose_config_change",
        "apply_config",
        "Propose changing orbit.env settings. Only these five can be changed, and unknown keys or invalid values are refused: ORBIT_MODEL (model name), ORBIT_ROUTINES (name=trig_<id>,...), ORBIT_ROUTINE_REPOS (name=owner/repo,...), ORBIT_PUBLIC_JOB_URL (https://<name>.ts.net), ORBIT_INGRESS_PORT (integer 1024-65535). ORBIT restarts to apply them, and the old file is restored if /status is not healthy within 60 seconds.",
        {
          type: "object",
          properties: { changes: { type: "object", additionalProperties: false, properties: Object.fromEntries(CONFIG_KEYS.map((k) => [k, k === "ORBIT_INGRESS_PORT" ? { type: "integer", minimum: 1024, maximum: 65535 } : { type: "string" }])) } },
          required: ["changes"],
          additionalProperties: false,
        },
        (a) => {
          if (Object.keys(a).some((k) => k !== "changes")) throw new Error("Only {changes: {...}} is accepted.");
          return { changes: a.changes };
        },
      ),
      {
        name: "ops_admin_operations",
        description: "Server operations Rai has confirmed (restart, deploy, rollback, config change, vault refresh), newest first, with what the helper actually observed: state, whether /status was verified healthy on which commit, and the outcome. Refreshes in-flight ones from the helper first. 'accepted' or 'running' means NOT verified yet.",
        parameters: obj({}, []),
        run: async (a) => {
          if (Object.keys(a).length) throw new Error("This tool takes no arguments.");
          await admin.refresh();
          return { value: admin.list().slice(-10).reverse().map(({ proposalId: _p, digest: _d, ...e }) => e), provenance: "live", source: "ops-admin/ledger" };
        },
      },
    );
  }
  const sys = d.sys;
  if (sys) {
    // Each of these only PROPOSES, and only if every check passed: when one fails the tool throws and NO proposal exists. Three
    // separate actions, three separate confirmations: nothing is bundled.
    const proposeSys = (name: string, action: SysMutatingAction, description: string, schedulable = false): ChatTool => ({
      name,
      description: `${description} This does NOT do it: it creates a proposal that Rai must confirm with a button on the page (a separate confirmation for each action), and a privileged helper then carries it out. If this tool returns an error, no proposal exists: say so, and never claim a proposal or an operation exists unless this tool returned a proposalId. Never say it happened until ops_sys_operations shows 'verified'; 'accepted', 'scheduled', 'running' and 'rebooting' are not success.`,
      parameters: schedulable ? obj({ at: str("Optional. Reboot at this UTC time, YYYY-MM-DDTHH:MM:SS.sssZ, between 2 minutes and 24 hours ahead. Omit to reboot now (after confirmation).") }, []) : obj({}, []),
      run: async (a) => {
        if (Object.keys(a).some((k) => !(schedulable && k === "at"))) throw new Error(schedulable ? "This tool takes only an optional 'at' time." : "This tool takes no arguments.");
        if (schedulable && a.at !== undefined && typeof a.at !== "string") throw new Error("'at' must be a UTC time string.");
        const p = await sys.propose(action, schedulable && typeof a.at === "string" ? { rebootAt: a.at } : {});
        return {
          value: { status: "pending-confirmation", executed: false, proposalId: p.id, action, summary: p.summary, warnings: p.warnings, details: p.display, digest: p.digest, expiresAt: p.expiresAt, note: "Nothing has been done. Rai must click Confirm on the page, after reading the warnings." },
          provenance: "live",
          source: "chat/proposals",
        };
      },
    });
    tools.push(
      proposeSys("ops_propose_os_updates", "install_os_updates", "Propose installing pending OS package upgrades on this shared host (apt-get upgrade only; never a distribution upgrade, removal or reboot). First the helper refreshes apt metadata (apt-get update) and simulates the upgrade to get an exact package/version plan; the card lists it and flags kernel, libc, systemd, openssh and tailscale. Nothing is installed by proposing. Affects production OpenClaw as well as ORBIT."),
      proposeSys("ops_propose_reboot_host", "reboot_host", "Propose rebooting this whole shared host (ORBIT, production OpenClaw and the job listener all go down), now or at an optional UTC time up to 24 hours ahead. A scheduled reboot can be cancelled with ops_sys_cancel_reboot until it fires. Separate from OS updates.", true),
      proposeSys("ops_propose_funnel_enable", "funnel_enable", "Propose enabling the existing public Tailscale Funnel of the orbit-jobs node. Never touches this host's own Tailscale; fails closed if the orbit-jobs node is not on this host."),
      proposeSys("ops_propose_funnel_disable", "funnel_disable", "Propose disabling the existing public Tailscale Funnel of the orbit-jobs node (cuts running jobs off from ORBIT; active jobs are listed in the warning). Never touches this host's own Tailscale."),
      {
        name: "ops_sys_cancel_reboot",
        description: "Cancel a confirmed reboot that has not fired yet (a scheduled one, or one still waiting to start). Succeeds ONLY if the helper confirms nothing was issued; if it says too late, the reboot was dispatched and was NOT cancelled: say exactly that. The cancellation is recorded and audited. Takes an optional opId when more than one is open.",
        parameters: obj({ opId: str("Optional operation id of the reboot (from ops_sys_operations).") }, []),
        run: async (a) => {
          if (Object.keys(a).some((k) => k !== "opId")) throw new Error("This tool takes only an optional opId.");
          const r = await sys.cancelReboot(typeof a.opId === "string" ? a.opId : undefined);
          return { value: r, provenance: "live", source: "ops-sys/ledger" };
        },
      },
      {
        name: "ops_sys_operations",
        description: "Tier 3 operations Rai has confirmed (OS updates, reboot, Funnel), newest first, with what the helper actually observed: state, verification and evidence. Refreshes in-flight ones from the helper first. 'accepted', 'scheduled', 'running' and 'rebooting' mean NOT verified yet ('scheduled' = not yet fired, still cancellable); 'cancelled' means withdrawn before it fired; 'unverified' means a command ran but nothing could confirm the result.",
        parameters: obj({}, []),
        run: async (a) => {
          if (Object.keys(a).length) throw new Error("This tool takes no arguments.");
          await sys.refresh();
          return { value: sys.list().slice(-10).reverse().map(({ proposalId: _p, digest: _d, ...e }) => e), provenance: "live", source: "ops-sys/ledger" };
        },
      },
    );
  }
  const jobs = d.jobs;
  if (jobs) {
    tools.push(
      {
        name: "jobs_list",
        description: "List all ORBIT jobs (cloud runners), newest first: total, then one short row per job. Use job_status for detail.",
        parameters: obj({}, []),
        run: async () => ({ value: compactList(jobs.all(), (j) => jobs.health(j)), provenance: "live", source: "jobs" }),
      },
      {
        name: "job_status",
        description: "State, health, steers and the last 20 events of one job (it says how many earlier events were left out).",
        parameters: obj({ id: str("Job id") }, ["id"]),
        run: async (a) => {
          const job = jobs.get(need(a, "id"));
          if (!job) throw new Error("No job with that id.");
          return { value: detailJob(job, jobs.health(job)), provenance: "live", source: "jobs" };
        },
      },
      {
        name: "job_steer",
        description:
          "Propose a steering message for a running job. This does NOT send it: Rai must confirm it with a button on the page, because a steered job can change code. The runner picks it up at its next check-in after confirmation.",
        parameters: obj({ id: str("Job id"), text: str("What to tell the job") }, ["id", "text"]),
        run: async (a) => {
          const id = need(a, "id");
          const text = need(a, "text");
          if (!jobs.get(id)) throw new Error("No job with that id.");
          const p = d.proposals.propose({ kind: "job_steer", job: id, text: text.slice(0, 4000) });
          return {
            value: { status: "pending-confirmation", sent: false, proposalId: p.id, job: id, expiresAt: p.expiresAt, note: "Nothing has been sent. Rai must click Confirm on the page." },
            provenance: "live",
            source: "chat/proposals",
          };
        },
      },
      {
        name: "job_launch",
        description:
          "Propose launching a new job on a cloud runner. This does NOT launch it: it creates a proposal that Rai must confirm with a button on the page. Write a complete brief: goal, where things are, constraints, what done means. Every brief must also say: push only to the branch orbit/<job-id>; never open, edit or comment on a pull request (ORBIT opens it); end the job summary with `## PR title` and `## PR body` sections; run the typecheck and the tests before finishing; and put no secrets in code, commits or the summary.",
        parameters: obj({ routine: str("Routine name"), brief: str("The full brief for the runner") }, ["routine", "brief"]),
        run: async (a) => {
          const { routines, problem } = d.launchable();
          const routine = need(a, "routine");
          const brief = need(a, "brief");
          if (problem) throw new Error(`Launching is not available: ${problem}`);
          if (!routines.includes(routine)) throw new Error(`Unknown routine. Configured: ${routines.join(", ") || "none"}.`);
          const p = d.proposals.propose({ kind: "job_launch", routine, brief: brief.slice(0, 20000) });
          return {
            value: { status: "pending-confirmation", launched: false, proposalId: p.id, routine, expiresAt: p.expiresAt, note: "Nothing has launched. Rai must click Confirm on the page." },
            provenance: "live",
            source: "chat/proposals",
          };
        },
      },
    );
  }
  return tools;
}
