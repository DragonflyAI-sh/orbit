import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Identify } from "./identity.ts";
import type { MemoryPort } from "./memory.ts";
import type { Login } from "./chatgpt.ts";
import type { Message, ModelPort } from "./model.ts";
import type { Nodes } from "./nodes.ts";
import type { Notifier } from "./notify.ts";
import { decide } from "./policy.ts";
import type { Port, PortStatus } from "./ports.ts";
import type { Runner } from "./runs.ts";
import type { Toolbox } from "./tools.ts";
import type { JobInput, Scheduler } from "./schedule.ts";
import { parseJob } from "./schedule.ts";

export const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_NOTE_CHARS = 2000;
const page = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
const avatar = readFileSync(new URL("./web/avatar.png", import.meta.url));

export type Deps = {
  ports: Port[];
  model: ModelPort & { login?(): Login; startLogin?(): Promise<Login>; finishLogin?(callbackUrl: string): Promise<Login> };
  memory: MemoryPort;
  notify: Notifier;
  schedule: Scheduler;
  runs: Runner;
  tools: Toolbox;
  nodes: Nodes;
  commit: string;
  owner?: string;
  identify: Identify;
  deploy?: () => unknown;
};

export function withStaleness(status: PortStatus, now: Date): PortStatus {
  const age = now.getTime() - new Date(status.verifiedAt).getTime();
  if (status.state !== "live" || age <= STALE_AFTER_MS) return status;
  return { ...status, state: "degraded", detail: `Not verified since ${status.verifiedAt}. ${status.detail}` };
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function parseMessages(body: unknown): Message[] | undefined {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return undefined;
  const ok = messages.every(
    (m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string",
  );
  return ok && messages.at(-1).role === "user" ? (messages as Message[]) : undefined;
}

export function buildServer({
  ports,
  model,
  memory,
  notify,
  schedule,
  runs,
  tools,
  nodes,
  commit,
  owner,
  identify,
  deploy = () => ({ state: "unknown" }),
}: Deps): Server {
  const byName = new Map(ports.map((p) => [p.name, p]));
  const fixed = (port: string, impl: string, detail: string): PortStatus => ({
    port,
    state: "live",
    impl,
    detail,
    verifiedAt: new Date().toISOString(),
  });
  const statuses = (): PortStatus[] => {
    const now = new Date();
    return [
      fixed("policy", "fail-closed", "Allows reads and chat replies; memory, notify, schedule, runs, tools and devices for the owner only; refuses everything else."),
      fixed("channel", "web", "Web chat at /. Discord and CLI are not built."),
      ...[model.status(), memory.status(), notify.status(), schedule.status(), runs.status(), tools.status(), nodes.status(), ...ports.map((p) => p.status())].map((s) => withStaleness(s, now)),
    ];
  };
  const limits = (isOwner: boolean): string[] => [
    ...statuses()
      .filter((s) => s.state !== "live" && s.port !== "model")
      .map((s) => `${s.port} is ${s.state}: ${s.detail}`),
    ...(isOwner ? [] : ["memory is refused: this request is not from the owner, so you have no access to Rai's vault"]),
  ];
  const isOwnerOf = async (req: IncomingMessage) => Boolean(owner) && (await identify(req)) === owner;
  const audit = (port: string, action: string, decision: { allow: boolean; reason: string }) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), port, action, ...decision }));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://orbit");

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    if (req.method === "GET" && url.pathname === "/avatar.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(avatar);
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return send(res, 200, { commit, deploy: deploy(), ports: statuses() });
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      const decision = decide("channel", "chat", false);
      audit("channel", "chat", decision);
      if (!decision.allow) return send(res, 403, { error: decision.reason });
      let messages: Message[] | undefined;
      try {
        messages = parseMessages(await readJson(req));
      } catch {
        return send(res, 400, { error: "Body must be JSON under 64 KB." });
      }
      if (!messages) return send(res, 400, { error: `Send 1-${MAX_MESSAGES} messages ending with a user message.` });

      const isOwner = await isOwnerOf(req);
      let notes: string | undefined;
      let used: string[] = [];
      const memoryDecision = decide("memory", "search", isOwner);
      if (memoryDecision.allow) {
        audit("memory", "search", memoryDecision);
        try {
          const hits = memory.search(messages.at(-1)!.content).value;
          used = hits.map((h) => h.path);
          notes = hits.map((h) => `### ${h.path}\n${memory.read(h.path).value.slice(0, MAX_NOTE_CHARS)}`).join("\n\n") || undefined;
        } catch {
          // memory.status() reports the failure; the reply goes ahead without notes.
        }
      }
      if (isOwner) {
        const devices = `### Devices right now (from Tailscale)\n${nodes.summary()}`;
        notes = notes ? `${devices}\n\n${notes}` : devices;
      }
      const current = limits(isOwner);
      try {
        return send(res, 200, { reply: await model.reply(messages, current, notes), memory: used, limits: current });
      } catch {
        return send(res, 502, { error: `The model call failed: ${model.status().detail}`, limits: current });
      }
    }

    // Owner-only routes for notify and schedule. Each decision is audited.
    const owned = async (port: string, action: string): Promise<boolean> => {
      const decision = decide(port, action, await isOwnerOf(req));
      audit(port, action, decision);
      if (!decision.allow) send(res, 403, { error: decision.reason });
      return decision.allow;
    };
    const body = async (): Promise<Record<string, unknown> | undefined> => {
      try {
        return (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: "Body must be JSON under 64 KB." });
        return undefined;
      }
    };

    if (url.pathname === "/notifications" && req.method === "GET") {
      if (!(await owned("notify", "inbox"))) return;
      return send(res, 200, { inbox: notify.inbox(), recent: notify.recent() });
    }
    if (url.pathname === "/notifications" && req.method === "POST") {
      if (!(await owned("notify", "send"))) return;
      const input = await body();
      if (!input) return;
      if (typeof input.text !== "string" || !input.text.trim()) return send(res, 400, { error: "A notification needs text." });
      return send(res, 201, notify.send(input.text.trim().slice(0, 2000), input.urgent === true));
    }
    const ack = url.pathname.match(/^\/notifications\/([0-9a-f-]+)\/ack$/);
    if (ack && req.method === "POST") {
      if (!(await owned("notify", "ack"))) return;
      const n = notify.ack(ack[1]);
      return n ? send(res, 200, n) : send(res, 404, { error: "No unshown notification with that id." });
    }

    if (url.pathname === "/schedule" && req.method === "GET") {
      if (!(await owned("schedule", "list"))) return;
      return send(res, 200, { jobs: schedule.list() });
    }
    if (url.pathname === "/schedule" && req.method === "POST") {
      if (!(await owned("schedule", "create"))) return;
      const input = await body();
      if (!input) return;
      const job = parseJob(input as JobInput, new Date());
      return typeof job === "string" ? send(res, 400, { error: job }) : send(res, 201, schedule.add(job));
    }
    const job = url.pathname.match(/^\/schedule\/([0-9a-f-]+)$/);
    if (job && req.method === "DELETE") {
      if (!(await owned("schedule", "delete"))) return;
      return schedule.remove(job[1]) ? send(res, 200, { deleted: job[1] }) : send(res, 404, { error: "No job with that id." });
    }

    if (url.pathname === "/model/login" && (req.method === "GET" || req.method === "POST")) {
      if (!(await owned("model", req.method === "GET" ? "login-status" : "login"))) return;
      if (!model.login || !model.startLogin) return send(res, 404, { error: "This model does not use sign-in." });
      if (req.method === "GET") return send(res, 200, model.login());
      try {
        return send(res, 202, await model.startLogin());
      } catch (err) {
        return send(res, 502, { error: err instanceof Error ? err.message : "sign-in failed to start" });
      }
    }

    if (url.pathname === "/model/login/callback" && req.method === "POST") {
      if (!(await owned("model", "login"))) return;
      if (!model.finishLogin) return send(res, 404, { error: "This model does not use sign-in." });
      const input = await body();
      if (!input) return;
      if (typeof input.url !== "string") return send(res, 400, { error: "Send {url}: the address the browser landed on." });
      const login = await model.finishLogin(input.url);
      return send(res, login.state === "signed-in" ? 200 : 400, login);
    }

    if (url.pathname === "/nodes" && req.method === "GET") {
      if (!(await owned("nodes", "list"))) return;
      return send(res, 200, nodes.list());
    }

    if (url.pathname === "/tools" && req.method === "GET") {
      if (!(await owned("tools", "list"))) return;
      return send(res, 200, { tools: tools.list() });
    }
    const toolMatch = url.pathname.match(/^\/tools\/([a-z0-9-]+)$/);
    if (toolMatch && req.method === "POST") {
      if (!(await owned("tools", "call"))) return;
      const tool = tools.get(toolMatch[1]);
      if (!tool) return send(res, 404, { error: `No tool named ${toolMatch[1]}.` });
      if (!tool.readOnly) return send(res, 403, { error: `${tool.name} is not read-only, so it is refused until approvals exist.` });
      const input = await body();
      if (!input) return;
      const invalid = tool.validate(input);
      if (invalid) return send(res, 400, { error: invalid });
      try {
        return send(res, 200, await tools.call(tool.name, input));
      } catch (err) {
        return send(res, 502, { error: err instanceof Error ? err.message : "tool failed" });
      }
    }

    if (url.pathname === "/runs" && req.method === "GET") {
      if (!(await owned("runs", "list"))) return;
      return send(res, 200, { workers: runs.workers(), runs: runs.list() });
    }
    if (url.pathname === "/runs" && req.method === "POST") {
      if (!(await owned("runs", "submit"))) return;
      const input = await body();
      if (!input) return;
      const worker = typeof input.worker === "string" ? input.worker : "";
      const args = typeof input.input === "object" && input.input !== null ? (input.input as Record<string, unknown>) : {};
      const key = typeof input.key === "string" ? input.key : undefined;
      const result = runs.submit(worker, args, key);
      if (result.error) return send(res, 400, { error: result.error });
      runs.pump();
      return send(res, result.deduped ? 200 : 202, { ...runs.get(result.run!.id), deduped: result.deduped === true });
    }
    const runMatch = url.pathname.match(/^\/runs\/([0-9a-f-]+)(\/cancel)?$/);
    if (runMatch && req.method === "GET" && !runMatch[2]) {
      if (!(await owned("runs", "get"))) return;
      const run = runs.get(runMatch[1]);
      return run ? send(res, 200, run) : send(res, 404, { error: "No run with that id." });
    }
    if (runMatch && req.method === "POST" && runMatch[2]) {
      if (!(await owned("runs", "cancel"))) return;
      const run = runs.cancel(runMatch[1]);
      return run ? send(res, 200, run) : send(res, 409, { error: "That run cannot be cancelled now." });
    }

    const match = url.pathname.match(/^\/ports\/([a-z]+)\/([a-z]+)$/);
    if (req.method === "POST" && match) {
      const [, name, action] = match;
      const decision = decide(name, action, await isOwnerOf(req));
      audit(name, action, decision);
      if (!decision.allow) return send(res, 403, { error: decision.reason });
      let input: { query?: unknown; path?: unknown };
      try {
        input = (await readJson(req)) as typeof input;
      } catch {
        return send(res, 400, { error: "Body must be JSON under 64 KB." });
      }
      if (name === "memory") {
        try {
          if (action === "search" && typeof input.query === "string") return send(res, 200, memory.search(input.query));
          if (action === "read" && typeof input.path === "string") return send(res, 200, memory.read(input.path));
          if (action === "describe") return send(res, 200, { value: memory.status(), provenance: "live", source: "memory" });
        } catch (err) {
          return send(res, 404, { error: err instanceof Error ? err.message : "memory error" });
        }
        return send(res, 400, { error: "memory supports search {query}, read {path} and describe." });
      }
      const port = byName.get(name);
      if (!port) return send(res, 404, { error: `No port named ${name}` });
      return send(res, 200, port.call(action, input));
    }

    return send(res, 404, { error: "Not found" });
  });
}
