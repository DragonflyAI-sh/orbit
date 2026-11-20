export type Decision = { allow: boolean; reason: string };

// Fails closed. Reads and chat replies pass; memory, vault writes, the config view, notify, schedule, runs, tools, model sign-in, nodes, jobs, pull-request inspection ("pulls"), server operations, chat threads, the Assistant conversation, session discovery and bounded reading ("sessions", offered only in the Assistant), photo attachments and photo discovery/inspection/display ("attachments"; photos_list, photos_inspect, photos_show and the observation tools photos_observe, photos_recall, photos_correct and photos_forget, and the Assistant's photo display route, in the Assistant also need "sessions"), chat tool calls ("agent"), the workspace tools and their confirmations ("workspace", docs/workspace-tools.md), and supervised tasks ("tasks", docs/adr/0003-supervised-tasks.md) need the owner; everything else waits for real approvals.
const OPEN_ACTIONS = new Set(["describe", "chat"]);
const OWNER_PORTS = new Set(["memory", "notify", "schedule", "runs", "tools", "model", "nodes", "jobs", "ops", "agent", "threads", "assistant", "vault", "config", "pulls", "sessions", "attachments", "workspace", "tasks"]);

export function decide(port: string, action: string, isOwner: boolean): Decision {
  if (OWNER_PORTS.has(port) && action !== "describe") {
    return isOwner
      ? { allow: true, reason: `${port}.${action} is allowed for the owner` }
      : { allow: false, reason: `${port}.${action} is refused: only the owner can use ${port}` };
  }
  return OPEN_ACTIONS.has(action) || OWNER_PORTS.has(port)
    ? { allow: true, reason: `${action} has no effect outside ORBIT` }
    : { allow: false, reason: `${port}.${action} is refused: approvals are not built yet` };
}
