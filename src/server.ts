import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Identify } from "./identity.ts";
import { jobLauncher } from "./job-launch.ts";
import { jobRow, toolCommitStatus } from "./job-view.ts";
import type { Job, Jobs } from "./jobs.ts";
import type { ControlRepo, Routine } from "./launcher.ts";
import type { MemoryPort } from "./memory.ts";
import type { Login } from "./chatgpt.ts";
import type { Message, ModelPort } from "./model.ts";
import { proposals as newProposals, runChat } from "./agent.ts";
import type { Proposals } from "./agent.ts";
import { chatTools } from "./chat-tools.ts";
import type { VaultEdits } from "./vault/tools.ts";
import type { Nodes } from "./nodes.ts";
import type { Notifier } from "./notify.ts";
import { decide } from "./policy.ts";
import type { Port, PortStatus, Result } from "./ports.ts";
import type { Runner } from "./runs.ts";
import type { AdminOps } from "./ops-admin.ts";
import type { SysOps } from "./ops-sys.ts";
import type { Ops } from "./ops-client.ts";
import type { Toolbox } from "./tools.ts";
import type { JobInput, Scheduler } from "./schedule.ts";
import { parseJob } from "./schedule.ts";
import type { Watch } from "./watch.ts";
import { findDuplicates, withDuplicateWarning } from "./duplicates.ts";
import { recentContext, stateRecentContext } from "./recent-context.ts";
import type { RecentContextPort } from "./recent-context.ts";
import { threadService } from "./thread-service.ts";
import { MAX_MESSAGE_CHARS, isThreadId, threadStore, ThreadError } from "./threads.ts";
import type { Threads } from "./threads.ts";
import { jsonStore } from "./store.ts";

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
  ops?: Ops;
  // Tier 2: owner-confirmed server operations (src/ops-admin.ts). Absent means no admin tools are offered.
  adminOps?: AdminOps;
  // Tier 3: owner-confirmed OS updates, reboot and orbit-jobs Funnel (src/ops-sys.ts). Absent means no tier 3 tools are offered.
  sysOps?: SysOps;
  // Vault write tools and their confirmation path (src/vault/tools.ts). Absent means no vault write tools are offered.
  vaultEdits?: VaultEdits;
  // The read-only config view (src/config-view.ts). Absent means the tool is not offered.
  configView?: (ports: PortStatus[]) => Promise<Result<unknown>>;
  nodes: Nodes;
  jobs?: Jobs;
  publicJobUrl?: string;
  control?: ControlRepo;
  routines?: Map<string, Routine>;
  commit: string;
  owner?: string;
  identify: Identify;
  deploy?: () => unknown;
  proposals?: Proposals;
  watch?: Watch;
  // Server-side chat threads (src/threads.ts). Absent means an in-memory store, which a restart empties.
  threads?: Threads;
  // Where the rolling recent-context note is kept. Absent means memory only. Never the live vault.
  recentContext?: RecentContextPort;
  // The clock for thread cards and the recent-context note. Tests inject one; it must be the clock the proposals use.
  now?: () => Date;
};

export function withStaleness(status: PortStatus, now: Date): PortStatus {
  const age = now.getTime() - new Date(status.verifiedAt).getTime();
  if (status.state !== "live" || age <= STALE_AFTER_MS) return status;
  return { ...status, state: "degraded", detail: `Not verified since ${status.verifiedAt}. ${status.detail}` };
}

// Staleness as /status and the watch apply it. The model port is exempt: an idle model is not unhealthy, and it
// reports its own degradation from real errors (failed calls, failed login checks or renewals, an expired token).
// Every other port keeps the 5-minute rule.
export function withFreshness(status: PortStatus, now: Date): PortStatus {
  return status.port === "model" ? status : withStaleness(status, now);
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
  ops,
  adminOps,
  sysOps,
  vaultEdits,
  configView,
  nodes,
  jobs,
  publicJobUrl,
  control,
  routines = new Map(),
  commit,
  owner,
  identify,
  deploy = () => ({ state: "unknown" }),
  proposals = newProposals(),
  watch,
  threads = threadStore(undefined),
  recentContext: recentPort = stateRecentContext(jsonStore(undefined, "recent-context", null)),
  now,
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
      fixed("policy", "fail-closed", "Allows reads and chat replies; memory, vault writes, the config view, notify, schedule, runs, tools, devices and jobs for the owner only; refuses everything else."),
      fixed("channel", "web", "Web chat at /. Discord and CLI are not built."),
      ...[model.status(), memory.status(), notify.status(), schedule.status(), runs.status(), tools.status(), nodes.status(), ...(jobs ? [launcherStatus(jobs.status())] : []), ...ports.map((p) => p.status()), ...(watch ? [watch.status()] : [])].map((s) => withFreshness(s, now)),
    ];
  };
  watch?.attach(() => statuses().filter((st) => st.port !== "watch"));
  const limits = (isOwner: boolean): string[] => [
    ...statuses()
      .filter((s) => s.state !== "live" && s.port !== "model")
      .map((s) => `${s.port} is ${s.state}: ${s.detail}`),
    ...(isOwner ? [] : ["memory is refused: this request is not from the owner, so you have no access to Rai's vault"]),
  ];
  const launcherStatus = (st: PortStatus): PortStatus => {
    const names = [...routines.keys()];
    const ready = control && names.length;
    return {
      ...st,
      detail: `${st.detail} ${ready ? `Launches through Routines: ${names.join(", ")}.` : `Cannot launch yet: ${control ? "" : "no orbit-work GitHub credential. "}${names.length ? "" : "no Routine configured."}`}`.trim(),
    };
  };
  const withHealth = (job: Job) => ({ ...job, toolCommit: job.toolCommit ?? "unknown", toolCommitStatus: toolCommitStatus(job.toolCommit, commit), health: jobs!.health(job) });
  const launchable = () => ({
    routines: [...routines.keys()],
    problem: !jobs ? "jobs are not enabled" : !control ? "no orbit-work GitHub credential is installed" : routines.size ? undefined : "no Routine is configured",
  });

  // The one launch path: the /jobs/launch route and a confirmed chat proposal both end here (ORBIT's own review launches use jobLauncher directly).
  const launchJob = jobLauncher({ jobs, control, routines, notify, publicJobUrl, commit });

  // Threads: the store, the rolling recent-context note, and the service that runs a turn against a thread.
  const recent = recentContext({ port: recentPort, threads, model, now, cardLines: (t) => svc.cardLines(t) });
  const svc = threadService({ threads, model, proposals, jobs, admin: adminOps, sys: sysOps, recent, now });

  const isOwnerOf = async (req: IncomingMessage) => Boolean(owner) && (await identify(req)) === owner;
  const audit = (port: string, action: string, decision: { allow: boolean; reason: string }) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), port, action, ...decision }));

  // What a reply is given besides the conversation: memory excerpts and the device summary (owner only), the limits to
  // disclose, and the tools offered. Shared by the legacy /chat route and the thread routes.
  const prepare = async (isOwner: boolean, query: string) => {
    let notes: string | undefined;
    let used: string[] = [];
    const memoryDecision = decide("memory", "search", isOwner);
    if (memoryDecision.allow) {
      audit("memory", "search", memoryDecision);
      try {
        const hits = memory.search(query).value;
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
    const offered = isOwner && model.step
      ? withDuplicateWarning(chatTools({ memory, toolbox: tools, ops, admin: adminOps, sys: sysOps, vault: vaultEdits, config: configView ? () => configView(statuses()) : undefined, jobs, notify, proposals, launchable }), proposals, (brief) => (jobs ? findDuplicates(brief, jobs.all(), (j) => jobs.health(j)) : []))
      : [];
    if (!offered.length) {
      current.push(
        !isOwner
          ? "chat tools are refused: this request is not from the owner, so you cannot call any tools or take any action"
          : "chat tools are unavailable: the connected model cannot call tools, so you cannot take any action; do not claim to have launched, steered or sent anything",
      );
    }
    return { notes, used, current, offered };
  };
  const allowAgent = (isOwner: boolean) => (tool: string) => {
    const decision = decide("agent", tool, isOwner);
    audit("agent", tool, decision);
    if (!decision.allow) return decision.reason;
    // Vault writes and the config view have their own policy port entries, so the owner-only rule is stated for each.
    const port = tool.startsWith("vault_") ? "vault" : tool === "orbit_config_view" ? "config" : undefined;
    if (port) {
      const second = decide(port, tool, isOwner);
      audit(port, tool, second);
      return second.allow ? undefined : second.reason;
    }
    return undefined;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://orbit");

    // Owner identity comes from the Tailscale device, so a page on another site that Rai visits could make his
    // browser send requests that look like his. Browsers mark those; refuse any state-changing one.
    if (req.method !== "GET" && req.method !== "HEAD") {
      const site = req.headers["sec-fetch-site"];
      const origin = req.headers.origin;
      let crossOrigin = false;
      if (origin) {
        try {
          crossOrigin = new URL(origin).host !== req.headers.host;
        } catch {
          crossOrigin = true;
        }
      }
      if ((site && site !== "same-origin" && site !== "none") || crossOrigin) {
        audit("policy", "cross-site", { allow: false, reason: `refused a ${req.method} from ${origin ?? site}` });
        return send(res, 403, { error: "Cross-site requests are refused." });
      }
    }

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
      const { notes, used, current, offered } = await prepare(isOwner, messages.at(-1)!.content);
      try {
        if (!offered.length) return send(res, 200, { reply: await model.reply(messages, current, notes), memory: used, limits: current, calls: [], proposals: [] });
        const before = new Set(proposals.list().map((p) => p.id));
        const outcome = await runChat({
          model,
          messages,
          limits: current,
          notes,
          tools: offered,
          allow: allowAgent(isOwner),
        });
        const reply = { value: outcome.text || "(the model returned no text)", provenance: "live" as const, source: `model/${model.status().impl}` };
        const fresh = proposals.list().filter((p) => !before.has(p.id));
        return send(res, 200, { reply, memory: used, limits: current, calls: outcome.calls, proposals: fresh, capped: outcome.capped });
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

    // ---- Threads (owner only, every route). A thread is stored on the server and shared by every device; the model's context is
    // built from the stored thread, never from text the browser sends. docs/threads.md describes each route.
    const threadFail = (err: unknown) =>
      err instanceof ThreadError ? send(res, err.code, { error: err.message }) : send(res, 500, { error: "Could not save the thread. Nothing was changed." });
    const threadMatch = url.pathname.match(/^\/threads\/([0-9a-f-]{36})(?:\/(rename|archive|messages))?$/);
    if (url.pathname === "/threads" && req.method === "GET") {
      if (!(await owned("threads", "list"))) return;
      const all = url.searchParams.get("archived") === "1";
      return send(res, 200, { threads: threads.list(all), notice: threads.notice() ?? null, persisted: threads.persisted, problems: threads.problems(), recentContext: recent.status() });
    }
    if (url.pathname === "/threads" && req.method === "POST") {
      if (!(await owned("threads", "create"))) return;
      const input = await body();
      if (!input) return;
      try {
        return send(res, 201, { thread: svc.view(threads.create(input.title as string | undefined).id) });
      } catch (err) {
        return threadFail(err);
      }
    }
    if (url.pathname === "/threads/notice/ack" && req.method === "POST") {
      if (!(await owned("threads", "notice"))) return;
      threads.ackNotice();
      return send(res, 200, { notice: null });
    }
    if (threadMatch) {
      const [, id, action] = threadMatch;
      const method = action === undefined ? "GET" : "POST";
      if (req.method !== method) return send(res, 405, { error: `Use ${method} for this route.` });
      if (!(await owned("threads", action ?? "open"))) return;
      // The same verified identity the route check used, passed on to anything this request triggers.
      const callerIsOwner = await isOwnerOf(req);
      if (!isThreadId(id) || !threads.get(id)) return send(res, 404, { error: "No thread with that id." });
      try {
        if (!action) return send(res, 200, { thread: svc.view(id) });
        const input = await body();
        if (!input) return;
        if (action === "rename") {
          threads.rename(id, input.title);
          return send(res, 200, { thread: svc.view(id) });
        }
        if (action === "archive") {
          const archived = input.archived !== false;
          threads.archive(id, archived);
          // Archiving a notable thread is a moment to refresh the rolling note.
          if (archived) recent.consider(id, { force: true, isOwner: callerIsOwner });
          return send(res, 200, { thread: svc.view(id) });
        }
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!text || text.length > MAX_MESSAGE_CHARS) return send(res, 400, { error: `Send {text}: 1-${MAX_MESSAGE_CHARS} characters.` });
        const decision = decide("channel", "chat", false);
        audit("channel", "chat", decision);
        if (!decision.allow) return send(res, 403, { error: decision.reason });
        const prep = await prepare(callerIsOwner, text);
        const out = await svc.turn(id, text, { notes: prep.notes, memory: prep.used, limits: prep.current, tools: prep.offered, allow: allowAgent(callerIsOwner), isOwner: callerIsOwner });
        return send(res, out.error ? 502 : 200, { thread: out.thread, limits: prep.current, ...(out.error ? { error: out.error } : {}) });
      } catch (err) {
        return threadFail(err);
      }
    }

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

    if (jobs && url.pathname === "/jobs" && req.method === "GET") {
      if (!(await owned("jobs", "list"))) return;
      if (url.searchParams.get("view") === "rows") return send(res, 200, { jobs: jobs.list().map((j) => jobRow(j, jobs.health(j), commit)) });
      return send(res, 200, { jobs: jobs.list().map(withHealth) });
    }
    if (jobs && url.pathname === "/jobs/launch" && req.method === "POST") {
      if (!(await owned("jobs", "launch"))) return;
      const input = await body();
      if (!input) return;
      const result = await launchJob(String(input.routine ?? ""), typeof input.brief === "string" ? input.brief : "");
      return send(res, result.code, result.body);
    }
    // Open proposals from chat, so they can be confirmed or cancelled after the reply has scrolled away.
    if ((jobs || adminOps || sysOps) && url.pathname === "/chat/proposals" && req.method === "GET") {
      if (!(await owned("jobs", "proposals"))) return;
      return send(res, 200, { proposals: proposals.list() });
    }
    // Server operations the owner has confirmed, with what the helper observed. Owner only; refreshes in-flight ones first.
    if (adminOps && url.pathname === "/ops/admin" && req.method === "GET") {
      if (!(await owned("ops", "list"))) return;
      await adminOps.refresh();
      return send(res, 200, { operations: adminOps.list().slice().reverse() });
    }
    if (sysOps && url.pathname === "/ops/sys" && req.method === "GET") {
      if (!(await owned("ops", "list"))) return;
      await sysOps.refresh();
      return send(res, 200, { operations: sysOps.list().slice().reverse() });
    }
    // A chat proposal does nothing until Rai confirms it here; each proposal can be confirmed or cancelled once.
    const proposalMatch = url.pathname.match(/^\/chat\/proposals\/([0-9a-f-]+)\/(confirm|cancel)$/);
    if ((jobs || adminOps || sysOps || vaultEdits) && proposalMatch && req.method === "POST") {
      const confirming = proposalMatch[2] === "confirm";
      if (!(await owned("jobs", confirming ? "confirm" : "cancel"))) return;
      const gone = { error: "No open proposal with that id. It was already confirmed, cancelled or expired." };
      const open = proposals.peek(proposalMatch[1]);
      if (!open) {
        // A proposal shown in a thread keeps its card: it says what became of it instead of a bare 404.
        const known = svc.missing(proposalMatch[1]);
        if (known) return send(res, known.code, known.body);
      }
      // Single use has two guards that must agree: the proposal store's take() and the thread card's open -> confirmed/cancelled
      // compare-and-set. Both are synchronous, so of any number of concurrent requests exactly one gets past them.
      const claimed = (id: string, to: "confirmed" | "cancelled"): boolean => svc.claim(id, to);
      const alreadyUsed = () => send(res, 409, { error: "This proposal was already used. Nothing was done again." });
      if (open?.kind === "ops_admin" && confirming) {
        // A server operation is confirmed against the digest of the exact action and settings shown on the card. A missing or
        // different digest changes nothing and leaves the proposal open.
        const input = await body();
        if (!input) return;
        if (input.digest !== open.digest) return send(res, 409, { error: "The confirmation does not match this proposal's digest. Nothing was done." });
        if (!adminOps) return send(res, 503, { error: "Server operations are not enabled." });
        const taken = proposals.take(open.id);
        if (!taken || taken.kind !== "ops_admin") return send(res, 404, gone);
        if (!claimed(taken.id, "confirmed")) return alreadyUsed();
        audit("ops", `confirm:${taken.action}`, { allow: true, reason: `owner confirmed proposal ${taken.id} (digest ${taken.digest.slice(0, 12)})` });
        const result = await adminOps.confirm(taken);
        svc.settle(taken.id, result);
        return send(res, result.code, result.body);
      }
      if (open?.kind === "ops_sys" && confirming) {
        // Tier 3 is confirmed the same way, against the digest of the exact action and target on the card, separately for every
        // action. The helper checks the digest again, and the expiry, at the privileged boundary.
        const input = await body();
        if (!input) return;
        if (input.digest !== open.digest) return send(res, 409, { error: "The confirmation does not match this proposal's digest. Nothing was done." });
        if (!sysOps) return send(res, 503, { error: "Tier 3 server operations are not enabled." });
        const taken = proposals.take(open.id);
        if (!taken || taken.kind !== "ops_sys") return send(res, 404, gone);
        if (!claimed(taken.id, "confirmed")) return alreadyUsed();
        audit("ops", `confirm:${taken.action}`, { allow: true, reason: `owner confirmed proposal ${taken.id} (digest ${taken.digest.slice(0, 12)})` });
        const result = await sysOps.confirm(taken);
        svc.settle(taken.id, result);
        return send(res, result.code, result.body);
      }
      if (open?.kind === "vault_edit" && confirming) {
        // A protected vault edit is confirmed against the digest of the exact edit and the reasons shown, then validated again
        // (path rules, secret check, preconditions, policy) by the same pipeline a direct write uses. Owner only, via the policy port.
        if (!(await owned("vault", "confirm"))) return;
        const input = await body();
        if (!input) return;
        if (input.digest !== open.digest) return send(res, 409, { error: "The confirmation does not match this proposal's digest. Nothing was done." });
        if (!vaultEdits) return send(res, 503, { error: "Vault writes are not enabled." });
        const taken = proposals.take(open.id);
        if (!taken || taken.kind !== "vault_edit") return send(res, 404, gone);
        if (!claimed(taken.id, "confirmed")) return alreadyUsed();
        audit("vault", `confirm:${taken.action}`, { allow: true, reason: `owner confirmed proposal ${taken.id} (digest ${taken.digest.slice(0, 12)})` });
        const result = await vaultEdits.confirm(taken);
        svc.settle(taken.id, result);
        return send(res, result.code, result.body);
      }
      const proposal = proposals.take(proposalMatch[1]);
      if (!proposal) return send(res, 404, gone);
      if (proposalMatch[2] === "cancel") {
        if (!claimed(proposal.id, "cancelled")) return alreadyUsed();
        return send(res, 200, { cancelled: proposal.id });
      }
      if (proposal.kind === "ops_admin" || proposal.kind === "ops_sys") return send(res, 409, { error: "Not confirmed: server operations need their digest." });
      if (proposal.kind === "vault_edit") return send(res, 409, { error: "Not confirmed: a vault edit needs its digest." });
      if (!jobs) return send(res, 503, { error: "Jobs are not enabled." });
      if (!claimed(proposal.id, "confirmed")) return alreadyUsed();
      if (proposal.kind === "job_steer") {
        const steer = jobs.steer(proposal.job, proposal.text);
        const result = steer ? { code: 201, body: { steered: proposal.job, steer } } : { code: 404, body: { error: "That job no longer exists." } };
        svc.settle(proposal.id, result);
        return send(res, result.code, result.body);
      }
      const result = await launchJob(proposal.routine, proposal.brief);
      svc.settle(proposal.id, result);
      return send(res, result.code, result.body);
    }
    if (jobs && url.pathname === "/jobs" && req.method === "POST") {
      if (!(await owned("jobs", "register"))) return;
      const input = await body();
      if (!input) return;
      const result = jobs.register(String(input.id ?? ""));
      if ("error" in result) return send(res, 400, { error: result.error });
      return send(res, 201, { ...result, api: publicJobUrl ?? null });
    }
    const jobMatch = url.pathname.match(/^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(\/steer)?$/);
    if (jobs && jobMatch && req.method === "GET" && !jobMatch[2]) {
      if (!(await owned("jobs", "get"))) return;
      const job = jobs.get(jobMatch[1]);
      return job ? send(res, 200, withHealth(job)) : send(res, 404, { error: "No job with that id." });
    }
    if (jobs && jobMatch && req.method === "POST" && jobMatch[2]) {
      if (!(await owned("jobs", "steer"))) return;
      const input = await body();
      if (!input) return;
      if (typeof input.text !== "string" || !input.text.trim()) return send(res, 400, { error: "A steer needs text." });
      const steer = jobs.steer(jobMatch[1], input.text.trim());
      return steer ? send(res, 201, steer) : send(res, 404, { error: "No job with that id." });
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
