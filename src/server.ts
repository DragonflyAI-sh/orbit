import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Message, ModelPort } from "./model.ts";
import { decide } from "./policy.ts";
import type { Port, PortStatus } from "./ports.ts";

export const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const page = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");

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
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseMessages(body: unknown): Message[] | undefined {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return undefined;
  const ok = messages.every(
    (m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string",
  );
  return ok && messages.at(-1).role === "user" ? (messages as Message[]) : undefined;
}

export function buildServer(
  ports: Port[],
  model: ModelPort,
  commit: string,
  deploy: () => unknown = () => ({ state: "unknown" }),
): Server {
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
      fixed("policy", "fail-closed", "Allows reads and chat replies; refuses everything else."),
      fixed("channel", "web", "Web chat at /. Discord and CLI are not built."),
      ...[model.status(), ...ports.map((p) => p.status())].map((s) => withStaleness(s, now)),
    ];
  };
  const limits = (): string[] =>
    statuses()
      .filter((s) => s.state !== "live" && s.port !== "model")
      .map((s) => `${s.port} is ${s.state}: ${s.detail}`);

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
      const decision = decide("channel", "chat");
      console.log(JSON.stringify({ at: new Date().toISOString(), port: "channel", action: "chat", ...decision }));
      if (!decision.allow) return send(res, 403, { error: decision.reason });
      let messages: Message[] | undefined;
      try {
        messages = parseMessages(await readJson(req));
      } catch {
        return send(res, 400, { error: "Body must be JSON under 64 KB." });
      }
      if (!messages) return send(res, 400, { error: `Send 1-${MAX_MESSAGES} messages ending with a user message.` });
      const current = limits();
      try {
        return send(res, 200, { reply: await model.reply(messages, current), limits: current });
      } catch {
        return send(res, 502, { error: "The model call failed. /status has the detail.", limits: current });
      }
    }

    const match = url.pathname.match(/^\/ports\/([a-z]+)\/([a-z]+)$/);
    if (req.method === "POST" && match) {
      const [, name, action] = match;
      const port = byName.get(name);
      if (!port) return send(res, 404, { error: `No port named ${name}` });
      const decision = decide(name, action);
      console.log(JSON.stringify({ at: new Date().toISOString(), port: name, action, ...decision }));
      if (!decision.allow) return send(res, 403, { error: decision.reason });
      return send(res, 200, port.call(action, null));
    }

    return send(res, 404, { error: "Not found" });
  });
}
