import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { normalizeToolCommit } from "./jobs.ts";
import type { JobEvent, Jobs } from "./jobs.ts";
import { checkResearchSummary, researchBriefPayload } from "./research.ts";
import { parseBootstrapReport } from "./research-bootstrap.ts";
import type { ResearchTool } from "./research.ts";

// The only listener meant to face the internet. It knows the job registry and nothing else:
// no memory, tools, model or owner routes. Every request needs the token for that one job.

// Room for a full final summary (jobs.ts MAX_SUMMARY_CHARS is 200,000 characters; JSON escaping and multibyte text can double it).
// Anything larger is refused, not cut: the runner then falls back to git, which holds the whole file.
const MAX_BODY_BYTES = 640 * 1024;
const RATE_PER_MINUTE = 60;
const TYPES = new Set(["started", "checkin", "reply", "summary", "bootstrap"]);

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

// Research jobs (src/research.ts) use two more read-only routes with the same one-job token: `GET .../brief` (they have no orbit-work
// branch to read it from) and `GET .../tool` (the runner's tool, whose sha256 the fire text carries). Both answer 404 for any other
// kind of job. A research job's `done` summary must be a valid report, and every research summary must be whole, bounded and free of
// secret-shaped text: otherwise it is refused (422) and nothing is recorded, so the runner fixes it and sends it again. Nothing a
// runner sends can set a job's kind, routine, repository or PR: the event fields are an allowlist.
export function buildIngress(jobs: Jobs, now: () => number = Date.now, opts: { researchTool?: ResearchTool } = {}): Server {
  const hits = new Map<string, number[]>();
  const limited = (id: string) => {
    const recent = (hits.get(id) ?? []).filter((t) => now() - t < 60_000);
    recent.push(now());
    hits.set(id, recent);
    return recent.length > RATE_PER_MINUTE;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://ingress");
    const match = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(events|steers|brief|tool)$/);
    if (!match) return send(res, 404, { error: "Not found" });
    const [, id, what] = match;
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    // The same answer for an unknown job and a bad token, so the endpoint does not reveal which jobs exist.
    if (!jobs.verify(id, token)) return send(res, 401, { error: "Unauthorized" });
    if (limited(id)) return send(res, 429, { error: "Too many requests for this job" });

    if (what === "steers" && req.method === "GET") {
      return send(res, 200, { steers: jobs.pending(id) });
    }

    const research = jobs.get(id)?.kind === "research";
    if ((what === "brief" || what === "tool") && req.method === "GET") {
      if (!research) return send(res, 404, { error: "Not found" });
      if (what === "brief") {
        // Recorded as evidence that the runner received its brief (the Jobs page's input states); the payload has no secrets in it.
        const payload = researchBriefPayload(jobs.get(id)!);
        jobs.briefServed(id, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
        return send(res, 200, payload);
      }
      if (!opts.researchTool) return send(res, 503, { error: "The research tool is not available on this ORBIT." });
      // Evidence that the runner's request reached ORBIT and was answered with the tool (not that it arrived intact or ran).
      jobs.toolServed(id, opts.researchTool.sha256);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-orbit-sha256": opts.researchTool.sha256 });
      return res.end(opts.researchTool.text);
    }

    if (what === "events" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "Body must be JSON under 640 KB." });
      }
      if (typeof body.type !== "string" || !TYPES.has(body.type)) return send(res, 400, { error: "type must be started, checkin, reply, summary or bootstrap" });
      if (body.type === "bootstrap") {
        // A research runner whose bootstrap failed before its tool ran (src/research-bootstrap.ts). Fixed fields only; ORBIT writes the text.
        if (!research) return send(res, 404, { error: "Not found" });
        if (jobs.get(id)!.events.some((e) => e.type === "started")) return send(res, 409, { error: "This job's runner has already started; a bootstrap failure report no longer applies." });
        const parsed = parseBootstrapReport(body);
        if (!parsed.ok) return send(res, 400, { error: "Bootstrap report refused; nothing was recorded.", problems: [parsed.problem] });
        jobs.record(id, { type: "bootstrap", status: parsed.report.category, text: parsed.text, bootstrap: parsed.report });
        return send(res, 200, { ok: true, recorded: "bootstrap" });
      }
      if (research && body.type === "summary") {
        // A research report has no git copy to complete it from: it must arrive whole.
        if (body.textComplete === false || typeof body.text !== "string") return send(res, 422, { error: "A research summary must be sent whole, as text.", problems: ["send the whole report in one summary event"] });
        const check = checkResearchSummary(typeof body.status === "string" ? body.status : undefined, body.text, new Date(now()));
        if (!check.ok) return send(res, 422, { error: "Research summary refused; nothing was recorded. Fix these and send it again.", problems: check.problems });
      }
      if (research && (body.type === "checkin" || body.type === "reply") && typeof body.text === "string" && body.text.length > 20_000) {
        return send(res, 422, { error: "Research check-ins and replies are at most 20,000 characters.", problems: ["shorten the text"] });
      }
      const event: Omit<JobEvent, "at"> = {
        type: body.type as JobEvent["type"],
        ...(typeof body.sha === "string" ? { sha: body.sha.slice(0, 64) } : {}),
        ...(body.type === "started" && normalizeToolCommit(body.toolCommit) ? { toolCommit: normalizeToolCommit(body.toolCommit) } : {}),
        ...(Number.isInteger(body.n) ? { n: body.n as number } : {}),
        ...(typeof body.status === "string" ? { status: body.status } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(body.textComplete === false ? { textComplete: false } : {}),
      };
      jobs.record(id, event);
      // Acknowledged steers are the ones the runner has now written into git.
      if (Array.isArray(body.ack)) jobs.acknowledge(id, body.ack.filter((n): n is number => Number.isInteger(n)));
      return send(res, 200, { ok: true, steers: jobs.pending(id) });
    }

    return send(res, 405, { error: "Method not allowed" });
  });
}
