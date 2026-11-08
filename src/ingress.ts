import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { normalizeToolCommit } from "./jobs.ts";
import type { JobEvent, Jobs } from "./jobs.ts";

// The only listener meant to face the internet. It knows the job registry and nothing else:
// no memory, tools, model or owner routes. Every request needs the token for that one job.

const MAX_BODY_BYTES = 16 * 1024;
const RATE_PER_MINUTE = 60;
const TYPES = new Set(["started", "checkin", "reply", "summary"]);

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(`${JSON.stringify(body)}\n`);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function buildIngress(jobs: Jobs, now: () => number = Date.now): Server {
  const hits = new Map<string, number[]>();
  const limited = (id: string) => {
    const recent = (hits.get(id) ?? []).filter((t) => now() - t < 60_000);
    recent.push(now());
    hits.set(id, recent);
    return recent.length > RATE_PER_MINUTE;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://ingress");
    const match = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(events|steers)$/);
    if (!match) return send(res, 404, { error: "Not found" });
    const [, id, what] = match;
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    // The same answer for an unknown job and a bad token, so the endpoint does not reveal which jobs exist.
    if (!jobs.verify(id, token)) return send(res, 401, { error: "Unauthorized" });
    if (limited(id)) return send(res, 429, { error: "Too many requests for this job" });

    if (what === "steers" && req.method === "GET") {
      return send(res, 200, { steers: jobs.pending(id) });
    }

    if (what === "events" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "Body must be JSON under 16 KB." });
      }
      if (typeof body.type !== "string" || !TYPES.has(body.type)) return send(res, 400, { error: "type must be started, checkin, reply or summary" });
      const event: Omit<JobEvent, "at"> = {
        type: body.type as JobEvent["type"],
        ...(typeof body.sha === "string" ? { sha: body.sha.slice(0, 64) } : {}),
        ...(body.type === "started" && normalizeToolCommit(body.toolCommit) ? { toolCommit: normalizeToolCommit(body.toolCommit) } : {}),
        ...(Number.isInteger(body.n) ? { n: body.n as number } : {}),
        ...(typeof body.status === "string" ? { status: body.status } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
      };
      jobs.record(id, event);
      // Acknowledged steers are the ones the runner has now written into git.
      if (Array.isArray(body.ack)) jobs.acknowledge(id, body.ack.filter((n): n is number => Number.isInteger(n)));
      return send(res, 200, { ok: true, steers: jobs.pending(id) });
    }

    return send(res, 405, { error: "Method not allowed" });
  });
}
