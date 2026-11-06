import type { ChatTool, Proposals } from "./agent.ts";
import type { Jobs, Job } from "./jobs.ts";
import type { MemoryPort } from "./memory.ts";
import type { Notifier } from "./notify.ts";
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
  withHealth?: (job: Job) => unknown;
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
  const jobs = d.jobs;
  if (jobs) {
    const view = (j: Job) => (d.withHealth ? d.withHealth(j) : j);
    tools.push(
      {
        name: "jobs_list",
        description: "List ORBIT jobs (cloud runners) with state and health.",
        parameters: obj({}, []),
        run: async () => ({ value: jobs.list().map(view), provenance: "live", source: "jobs" }),
      },
      {
        name: "job_status",
        description: "State, health, events and steers of one job.",
        parameters: obj({ id: str("Job id") }, ["id"]),
        run: async (a) => {
          const job = jobs.get(need(a, "id"));
          if (!job) throw new Error("No job with that id.");
          return { value: view(job), provenance: "live", source: "jobs" };
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
          "Propose launching a new job on a cloud runner. This does NOT launch it: it creates a proposal that Rai must confirm with a button on the page. Write a complete brief: goal, where things are, constraints, what done means.",
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
