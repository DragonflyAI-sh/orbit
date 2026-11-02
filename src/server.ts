import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { decide } from "./policy.ts";
import type { Port, PortStatus } from "./ports.ts";

export const STALE_AFTER_MS = 5 * 60 * 1000;

export function withStaleness(status: PortStatus, now: Date): PortStatus {
  const age = now.getTime() - new Date(status.verifiedAt).getTime();
  if (status.state !== "live" || age <= STALE_AFTER_MS) return status;
  return { ...status, state: "degraded", detail: `Not verified since ${status.verifiedAt}. ${status.detail}` };
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

export function buildServer(ports: Port[], commit: string): Server {
  const byName = new Map(ports.map((p) => [p.name, p]));
  const policyStatus = (): PortStatus => ({
    port: "policy",
    state: "live",
    impl: "fail-closed",
    detail: "Refuses everything except read-only describe.",
    verifiedAt: new Date().toISOString(),
  });

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://orbit");
    if (req.method === "GET" && url.pathname === "/status") {
      const now = new Date();
      const statuses = ports.map((p) => withStaleness(p.status(), now));
      return send(res, 200, { commit, ports: [policyStatus(), ...statuses] });
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
