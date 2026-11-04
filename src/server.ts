import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Identify } from "./identity.ts";
import type { MemoryPort } from "./memory.ts";
import type { Message, ModelPort } from "./model.ts";
import { decide } from "./policy.ts";
import type { Port, PortStatus } from "./ports.ts";

export const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_NOTE_CHARS = 2000;
const page = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");

export type Deps = {
  ports: Port[];
  model: ModelPort;
  memory: MemoryPort;
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

export function buildServer({ ports, model, memory, commit, owner, identify, deploy = () => ({ state: "unknown" }) }: Deps): Server {
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
      fixed("policy", "fail-closed", "Allows reads and chat replies; memory for the owner only; refuses everything else."),
      fixed("channel", "web", "Web chat at /. Discord and CLI are not built."),
      ...[model.status(), memory.status(), ...ports.map((p) => p.status())].map((s) => withStaleness(s, now)),
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
      const current = limits(isOwner);
      try {
        return send(res, 200, { reply: await model.reply(messages, current, notes), memory: used, limits: current });
      } catch {
        return send(res, 502, { error: "The model call failed. /status has the detail.", limits: current });
      }
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
