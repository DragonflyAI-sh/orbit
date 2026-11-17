import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Identify } from "./identity.ts";
import { jobLauncher } from "./job-launch.ts";
import { researchStore } from "./research.ts";
import type { ResearchLane, ResearchStore, ResearchTool } from "./research.ts";
import { researchTools, watchResearchVault, withLaneGuard } from "./research-tools.ts";
import { hasLegacyContext, LEGACY_CONTEXT_ERROR, refuseLegacyContext } from "./job-context.ts";
import { jobRow, toolCommitStatus } from "./job-view.ts";
import type { Job, Jobs } from "./jobs.ts";
import type { ControlRepo, Routine } from "./launcher.ts";
import type { MemoryPort } from "./memory.ts";
import type { Login } from "./chatgpt.ts";
import { replySource } from "./model.ts";
import type { Message, ModelPort } from "./model.ts";
import { proposals as newProposals, runChat } from "./agent.ts";
import type { ChatTool, Proposals } from "./agent.ts";
import { chatTools } from "./chat-tools.ts";
import { PR_INSPECT_TOOL_NAMES } from "./pr-inspect.ts";
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
import { ASSISTANT_ACTIVE_BUDGET_CHARS, ASSISTANT_CARD_LINES_MAX, ASSISTANT_CHUNK_MAX_CHARS, ASSISTANT_CONTEXT_BUDGET_CHARS, ASSISTANT_NOTES_MAX_CHARS, boundNotes, planItems, planMessages } from "./assistant-context.ts";
import { ASSISTANT_ID, assistantStore } from "./assistant-store.ts";
import { assistantAdapter, assistantSessionId, chatAdapter, chatSessionId, SESSION_TOOL_NAMES, sessionRegistry, sessionTools, workAdapter } from "./sessions.ts";
import { isOriginId, workFile, WorkError, workSessions as newWorkSessions } from "./work-sessions.ts";
import type { Origin, RunLink, WorkSessions } from "./work-sessions.ts";
import type { Proposal } from "./agent.ts";
import { sessionDigest } from "./session-digest.ts";
import type { Chunk } from "./assistant-store.ts";
import { resolutionSummary } from "./model-capability.ts";
import { AttachmentError, attachmentStore, isAttachmentId, MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.ts";
import { PHOTO_TOOL_NAMES, photoDisplay, photoTools } from "./photo-access.ts";
import { isPhotoRef, safeGalleries } from "./photo-ref.ts";
import type { PhotoSources } from "./photo-access.ts";
import { observationStore, observationTools } from "./photo-observations.ts";
import type { ObservationSources, ObservationStore } from "./photo-observations.ts";
import { photoSearchTool, photoSemantic as semanticSearch } from "./photo-semantic.ts";
import type { SemanticSources } from "./photo-semantic.ts";
import type { Embedder } from "./embeddings.ts";
import { ZONE } from "./time.ts";
import type { AttachmentRef, Attachments } from "./attachments.ts";
import { JPEG_MAX_BYTES, normalizeJpeg } from "./jpeg.ts";
import type { CheckRecord, SmokeRunner } from "./smoke.ts";

export const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_NOTE_CHARS = 2000;
const page = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
const avatar = readFileSync(new URL("./web/avatar.png", import.meta.url));
const photosJs = readFileSync(new URL("./web/photos.js", import.meta.url), "utf8");

// The page's own addresses: / and the Sessions section, /sessions and /sessions/<one path segment>. Deeper paths are not
// page addresses (404 as before). A bad segment still gets the page, which says the address names no session.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isPageRoute(pathname: string): boolean {
  return pathname === "/" || pathname === "/sessions" || /^\/sessions\/[^/]{0,200}$/.test(pathname);
}
// Where a legacy Chat path goes: /chat and /chat/ to /sessions, /chat/<session id> (any case) to /sessions/<id>.
// Anything else under /chat (for example the /chat/proposals API) is not a page and is left alone (undefined).
export function legacyChatRedirect(pathname: string): string | undefined {
  if (pathname === "/chat" || pathname === "/chat/") return "/sessions";
  const m = pathname.match(/^\/chat\/([^/]+)$/);
  const id = m?.[1]?.toLowerCase();
  return id && SESSION_ID.test(id) ? `/sessions/${id}` : undefined;
}

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
  // Read-only pull-request inspection tools (src/pr-inspect.ts). Offered to the owner only. Absent means they are not offered.
  prInspect?: ChatTool[];
  nodes: Nodes;
  jobs?: Jobs;
  publicJobUrl?: string;
  control?: ControlRepo;
  routines?: Map<string, Routine>;
  // The research lane (src/research.ts, docs/research-lane.md): its routines, report store and runner tool. Absent means the lane is
  // unconfigured: research_launch refuses and nothing ever falls back to a build routine.
  research?: { lane: ResearchLane; store: ResearchStore; tool?: ResearchTool; routineRepos?: Map<string, string> };
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
  // Where the Assistant's rolling conversation is stored (<state>/assistant). Absent means memory only, which a restart empties.
  assistantDir?: string;
  // Work sessions and run links (src/work-sessions.ts, docs/adr/0002-work-sessions.md). Absent means memory only, which a restart empties.
  workSessions?: WorkSessions;
  // Private photo attachments (src/attachments.ts, docs/photos.md), kept in <state>/attachments. Absent means memory only.
  attachments?: Attachments;
  // Saved photo observations (src/photo-observations.ts, docs/photo-recall.md), kept in <state>/photo-observations. Absent means memory only.
  photoObservations?: ObservationStore;
  // Opt-in semantic photo search (src/photo-semantic.ts, docs/photo-semantic-search.md). Absent (the default) means photos_search is not
  // offered and nothing changes. `status` is its /status line.
  photoSemantic?: { embedder: Embedder | undefined; cacheDir: string | undefined; status(): PortStatus };
  // Startup smoke checks (docs/smoke-checks.md). Started once, when the server starts listening; /status only reads the records.
  smoke?: SmokeRunner;
  // The clock for thread cards and the recent-context note. Tests inject one; it must be the clock the proposals use.
  now?: () => Date;
  // Chat tool execution deadline and abort grace period (docs/tool-deadlines.md). Tests lower them; production uses the defaults.
  toolDeadlineMs?: number;
  abortGraceMs?: number;
};

export function withStaleness(status: PortStatus, now: Date): PortStatus {
  const age = now.getTime() - new Date(status.verifiedAt).getTime();
  if (status.state !== "live" || age <= STALE_AFTER_MS) return status;
  return { ...status, state: "degraded", detail: `Not verified since ${status.verifiedAt}. ${status.detail}` };
}

// Staleness as /status and the watch apply it. The model and photo-embeddings ports are exempt: they are used on demand, so an idle
// one is not unhealthy, and each reports its own degradation from real errors (failed calls, failed login checks or renewals, an
// expired token, a refused or failed embeddings request). photo-embeddings is not live until a request has succeeded in this process
// (src/embeddings.ts); its smoke record (`check`) says how old that evidence is. Every other port keeps the 5-minute rule.
export const ON_DEMAND_PORTS: ReadonlySet<string> = new Set(["model", "photo-embeddings"]);
export function withFreshness(status: PortStatus, now: Date): PortStatus {
  return ON_DEMAND_PORTS.has(status.port) ? status : withStaleness(status, now);
}

// Attaches this process's smoke record to a port status. Marked `superseded` when the port has real-operation evidence (a non-epoch
// verifiedAt) newer than the attempt's start and the attempt did not pass: the newer real result is what `state` shows.
export function withCheck(status: PortStatus, check: CheckRecord | undefined): PortStatus {
  if (!check) return status;
  const real = new Date(status.verifiedAt).getTime();
  const superseded = check.state !== "passed" && check.state !== "stale" && check.startedAt !== undefined && real > 0 && real > new Date(check.startedAt).getTime();
  return { ...status, check: superseded ? { ...check, superseded: true } : check };
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
  prInspect,
  nodes,
  jobs,
  publicJobUrl,
  control,
  routines = new Map(),
  research,
  commit,
  owner,
  identify,
  deploy = () => ({ state: "unknown" }),
  proposals = newProposals(),
  watch,
  threads = threadStore(undefined),
  assistantDir,
  workSessions: workArg,
  attachments = attachmentStore(undefined),
  photoObservations = observationStore(undefined),
  photoSemantic,
  smoke,
  recentContext: recentPort = stateRecentContext(jsonStore(undefined, "recent-context", null)),
  now,
  toolDeadlineMs,
  abortGraceMs,
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
      ...[model.status(), memory.status(), notify.status(), schedule.status(), runs.status(), tools.status(), nodes.status(), ...(jobs ? [launcherStatus(jobs.status())] : []), ...ports.map((p) => p.status()), ...(photoSemantic ? [photoSemantic.status()] : []), ...(watch ? [watch.status()] : [])].map((s) => withFreshness(s, now)),
    ].map((s) => withCheck(s, smoke?.forPort(s.port, now)));
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
      detail: `${st.detail} ${ready ? `Launches through Routines: ${names.join(", ")}.` : `Cannot launch yet: ${control ? "" : "no orbit-work GitHub credential. "}${names.length ? "" : "no Routine configured."}`} ${researchStatus()}`.trim(),
    };
  };
  const withHealth = (job: Job) => ({ ...job, toolCommit: job.toolCommit ?? "unknown", toolCommitStatus: toolCommitStatus(job.toolCommit, commit), health: jobs!.health(job) });
  const launchable = () => ({
    routines: [...routines.keys()],
    problem: !jobs ? "jobs are not enabled" : !control ? "no orbit-work GitHub credential is installed" : routines.size ? undefined : "no Routine is configured",
  });

  // The research lane: unconfigured unless main.ts selected it. Its status is part of the jobs port detail, and is never "live" on
  // configuration alone: only a valid report proves a research runner actually ran.
  const researchLane = (): ResearchLane => research?.lane ?? { state: "unconfigured", reason: "No research lane is configured on this ORBIT.", routines: new Map(), names: [] };
  const researchStatus = () => {
    const lane = researchLane();
    if (lane.state !== "configured") return `Research lane ${lane.state}.`;
    const reports = jobs ? jobs.all().filter((j) => j.kind === "research" && j.research?.report?.valid).length : 0;
    return `Research lane configured (${lane.names.join(", ")})${research?.tool ? "" : " but its runner tool is missing, so research launches are refused"}; ${reports ? `${reports} valid research report(s) received.` : "no research report received yet: not proven live."}`;
  };
  // The one launch path: the /jobs/launch route and a confirmed chat proposal both end here (ORBIT's own review launches use jobLauncher directly).
  const researchLaunch = { routines: researchLane().routines, tool: research?.tool, ...(researchLane().state === "configured" ? {} : { unavailable: `the research lane is ${researchLane().state}` }) };
  const launchJob = jobLauncher({ jobs, control, routines, notify, publicJobUrl, commit, research: researchLaunch });

  // The lane tools (src/research-tools.ts): discover both lanes, propose research, read and save results. Owner only, like job_launch.
  // A research report's vault save that needed a card: its outcome is written to the research job the moment the card settles.
  if (jobs && vaultEdits) watchResearchVault(jobs, vaultEdits);
  const laneTools = () => (jobs ? researchTools({ jobs, proposals, lane: researchLane, build: launchable, routineRepos: research?.routineRepos ?? new Map(), store: research?.store ?? researchStore(undefined), vault: vaultEdits, now }) : []);

  // Threads: the store, the rolling recent-context note, and the service that runs a turn against a thread.
  const recent = recentContext({ port: recentPort, threads, model, now, cardLines: (t) => svc.cardLines(t) });
  // `origin`: a proposal made in a turn is bound to that turn's conversation (server context, never model text) before its card is stored.
  // Photos are loaded per conversation scope: a chat thread's turn can only read that thread's attachments, the Assistant's only its own.
  const chatScope = (threadId: string) => `chat:${threadId}`;
  const svc = threadService({ threads, model, proposals, jobs, admin: adminOps, sys: sysOps, recent, now, toolDeadlineMs, abortGraceMs, origin: chatSessionId, photos: (tid, aid) => attachments.read(aid, chatScope(tid)), galleries: (tid, g) => display.galleries(chatSessionId(tid), g) });

  // The Assistant (docs/assistant.md): one server-owned rolling conversation in its own chunk store, run by the same turn code as
  // chat threads but with a bounded context and no compaction. It does not feed or read the chat threads' rolling note.
  const clock = now ?? (() => new Date());
  const assistant = assistantStore(assistantDir, { now, held: (card) => Boolean(proposals.peek(card.id)) && new Date(card.expiresAt) > clock() });
  const planTurn = () => {
    const plan = assistant.plan(assistant.currentTurn());
    assistant.recordContext(plan);
    return plan;
  };
  const asvc = threadService({
    threads: assistant,
    model,
    proposals,
    jobs,
    admin: adminOps,
    sys: sysOps,
    now,
    toolDeadlineMs,
    abortGraceMs,
    compact: false,
    maxCardLines: ASSISTANT_CARD_LINES_MAX,
    origin: () => assistantSessionId(),
    context: { items: () => planItems(planTurn()), messages: () => planMessages(planTurn()) },
    photos: (_tid, aid) => attachments.read(aid, "assistant"),
    galleries: (_tid, g) => display.galleries(assistantSessionId(), g),
  });
  // Unsent uploads past their time are removed at start (and before every new upload). Bound photos are never removed.
  try {
    attachments.cleanup();
  } catch {
    // reported by the next upload that fails
  }
  // The session registry (src/sessions.ts, docs/adr/0001-session-registry.md): a read-only view over the Assistant's chunk store,
  // the chat threads and the job store. Only the Assistant is offered its tools (prepare and allowAgent below).
  const jobsReader = jobs ? { all: () => jobs.all(), health: (j: Job) => jobs.health(j) } : undefined;
  const work = workArg ?? newWorkSessions(workFile(undefined), clock);
  const sessions = sessionRegistry({ adapters: [assistantAdapter(assistant), chatAdapter(threads), workAdapter(work, jobsReader)], jobs: jobsReader, work, now });
  // What photo discovery reads of the conversation stores (src/photo-access.ts): titles, archive state and user messages with photos.
  const photoSources: PhotoSources = { assistant: () => assistant.photoSource(), chat: (tid) => threads.photoSource(tid) };
  // Where saved photo observations came from (src/photo-observations.ts): the conversation must still exist and hold the message.
  const observationSources: ObservationSources = {
    ...photoSources,
    message: (conversation, messageId) => (conversation === "assistant:assistant" ? assistant.messageState(messageId) : /^chat:/.test(conversation) ? threads.messageState(conversation.slice(5), messageId) : "gone"),
  };
  // Opt-in semantic photo search (docs/photo-semantic-search.md): only when configured. Discussion context is Rai's own next message.
  const semanticSources: SemanticSources = {
    ...observationSources,
    discussion: (conversation, messageId) => (conversation === "assistant:assistant" ? assistant.photoDiscussion(messageId) : /^chat:/.test(conversation) ? threads.photoDiscussion(conversation.slice(5), messageId) : undefined),
  };
  const semantic = photoSemantic ? semanticSearch({ attachments, sources: semanticSources, store: photoObservations, embedder: photoSemantic.embedder, cacheDir: photoSemantic.cacheDir, zone: ZONE }) : undefined;
  // Galleries photos_show displayed (docs/photo-recall.md): resolved again at every view and every image fetch, under the policy of
  // the conversation that shows them.
  const display = photoDisplay({ attachments, sources: photoSources, zone: ZONE });
  // The service that owns a proposal's card: the Assistant's when its card is there, otherwise the chat threads'.
  const cardSvc = (proposalId: string) => (assistant.threadOfCard(proposalId) ? asvc : svc);

  // Where a launch proposal was made (docs/adr/0002-work-sessions.md, "Origin"). Two server-side records, both written from the turn's own
  // context: the conversation that stores the proposal's card, and the origin bound on the proposal when that card was stored. Nothing
  // from the request body or the model is used. When both exist they must agree; when neither does, the origin is unknown.
  const originOf = (p: Proposal): Origin | { conflict: true } => {
    const tid = threads.threadOfCard(p.id);
    const fromCard = assistant.threadOfCard(p.id) ? assistantSessionId() : tid ? chatSessionId(tid) : undefined;
    if (fromCard && p.origin !== undefined && p.origin !== fromCard) return { conflict: true };
    const session = fromCard ?? p.origin;
    return session && isOriginId(session) ? { session, basis: "server-turn" } : { session: null, basis: "unknown", why: "no conversation stored this proposal (for example the legacy /chat route stores no card)" };
  };
  const linkView = (l: RunLink | undefined) => (l ? { workSession: l.workSession, attachment: l.attachment, ...(l.retryOf ? { retryOf: l.retryOf } : {}), origin: l.origin.session, launch: l.launch } : undefined);
  const safeLink = (proposalId: string) => {
    try {
      return linkView(work.linkOf(proposalId));
    } catch {
      return undefined;
    }
  };
  // Metadata repair from a reconciled link onto its card, only where the card is confirmed and no result was ever recorded on it.
  const repairCard = (l: RunLink) => {
    const store = assistant.threadOfCard(l.proposal) ? assistant : threads.threadOfCard(l.proposal) ? threads : undefined;
    const card = store?.card(l.proposal);
    if (!card || card.state !== "confirmed" || card.outcome) return;
    const st = l.launch.state;
    if (st === "launching") return;
    const result = l.launch.job
      ? { code: st === "launched" ? 202 : st === "ambiguous" ? 504 : 502, body: { id: l.launch.job, ...(l.launch.detail ? { error: l.launch.detail } : {}) } }
      : { code: 503, body: { error: l.launch.detail ?? "Not launched." } };
    cardSvc(l.proposal).settle(l.proposal, result);
  };
  // Reconciliation at start (nothing is in flight yet): links left `launching` or `ambiguous` by a crash or a failed write are compared
  // with the job store and their metadata repaired. Never launches, retries or approves anything; never changes a job.
  try {
    for (const l of work.reconcile(jobsReader)) {
      repairCard(l);
      console.log(JSON.stringify({ at: clock().toISOString(), event: "work_link_reconciled", proposal: l.proposal, workSession: l.workSession, state: l.launch.state, job: l.launch.job ?? null }));
    }
  } catch (e) {
    console.log(JSON.stringify({ at: clock().toISOString(), event: "work_reconcile_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "error" }));
  }
  const chunkView = (c: Chunk) => ({
    seq: c.seq,
    id: c.id,
    createdAt: c.createdAt,
    state: c.state,
    ...(c.context ? { context: c.context } : {}),
    messages: c.messages.map(({ calls, gallery, ...m }) => {
      const galleries = gallery?.length ? display.galleries(assistantSessionId(), safeGalleries(gallery)) : undefined;
      return { ...m, ...(calls ? { calls: calls.map(({ output, ...x }) => ({ ...x, outputChars: output.length })) } : {}), ...(galleries?.length ? { galleries } : {}) };
    }),
    cards: c.cards.map((card) => ({ ...card, live: asvc.liveOf(card) })),
  });
  const assistantView = () => {
    asvc.reconcile(ASSISTANT_ID);
    const plan = assistant.plan();
    return {
      session: assistant.session(),
      title: "Assistant",
      persisted: assistant.persisted,
      problems: assistant.problems(),
      busy: assistant.isBusy(ASSISTANT_ID),
      // Never lower than any revision served before, by this process or an earlier one: the page uses it to ignore stale answers
      // (src/assistant-store.ts, "revisions that survive a restart"). `epoch` is the part that is raised at every start.
      rev: assistant.rev(),
      epoch: assistant.epoch(),
      archivedChunks: assistant.archivedCount(),
      chunks: assistant.active().map(chunkView),
      // What the model would be sent as history with the next message (the new message itself comes on top).
      next: { included: plan.included, omitted: plan.omitted, historyChars: plan.historyChars },
      budgets: { unit: "characters", activeChars: ASSISTANT_ACTIVE_BUDGET_CHARS, chunkMaxChars: ASSISTANT_CHUNK_MAX_CHARS, contextChars: ASSISTANT_CONTEXT_BUDGET_CHARS, notesMaxChars: ASSISTANT_NOTES_MAX_CHARS },
    };
  };

  const isOwnerOf = async (req: IncomingMessage) => Boolean(owner) && (await identify(req)) === owner;
  const audit = (port: string, action: string, decision: { allow: boolean; reason: string }) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), port, action, ...decision }));

  // What a reply is given besides the conversation: memory excerpts and the device summary (owner only), the limits to
  // disclose, and the tools offered. Shared by the legacy /chat route, the thread routes and the Assistant. `scope` says which:
  // session discovery is offered only in the Assistant (policy decision, docs/adr/0001-session-registry.md).
  // `conversation`: the session id of the conversation the turn runs in (chat:<uuid> or assistant:assistant), from the route, never
  // from model text. The photo tools are offered only with one, and only reach what src/photo-access.ts photoPolicy allows it.
  const prepare = async (isOwner: boolean, query: string, scope: "chat" | "assistant" = "chat", conversation?: string) => {
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
      ? [...refuseLegacyContext(withDuplicateWarning([...withLaneGuard(chatTools({ memory, toolbox: tools, ops, admin: adminOps, sys: sysOps, vault: vaultEdits, config: configView ? () => configView(statuses()) : undefined, jobs, notify, proposals, launchable }), () => researchLane().names, () => [...routines.keys()]), ...laneTools()], proposals, (brief) => (jobs ? findDuplicates(brief, jobs.all(), (j) => jobs.health(j)) : []))), ...(prInspect ?? []), ...(scope === "assistant" ? sessionTools(sessions, { caller: assistantSessionId(), isOwner }) : []), ...(conversation ? [...photoTools({ attachments, sources: photoSources, caller: conversation, isOwner, now: clock, zone: ZONE }), ...observationTools({ store: photoObservations, attachments, sources: observationSources, caller: conversation, isOwner, now: clock, zone: ZONE, onChange: semantic ? (ref) => semantic.invalidate(ref) : undefined }), ...(semantic ? [photoSearchTool({ semantic, attachments, caller: conversation, isOwner, zone: ZONE })] : [])] : [])]
      : [];
    if (!offered.length) {
      current.push(
        !isOwner
          ? "chat tools are refused: this request is not from the owner, so you cannot call any tools or take any action"
          : "chat tools are unavailable: the connected model cannot call tools, so you cannot take any action; do not claim to have launched, steered or sent anything",
      );
    }
    // The session activity digest (src/session-digest.ts, ADR 0001 "Activity digest"): Assistant scope and owner only, checked
    // through the sessions policy port before the registry is touched. Kept apart from `notes` so the notes cap never cuts it and
    // it is never stored: it is built again for every turn and is not part of any chunk, memory or transcript.
    let digest: string | undefined;
    if (scope === "assistant") {
      const d = decide("sessions", "digest", isOwner);
      if (d.allow) {
        audit("sessions", "digest", d);
        digest = sessionDigest(sessions, { isOwner });
      }
    }
    return { notes, used, current, offered, digest };
  };
  const allowAgent = (isOwner: boolean, scope: "chat" | "assistant" = "chat") => (tool: string) => {
    const decision = decide("agent", tool, isOwner);
    audit("agent", tool, decision);
    if (!decision.allow) return decision.reason;
    // Session discovery and reading (sessions_list, session_inspect, session_read): owner only (its own policy port) and only inside
    // the Assistant, even if a chat turn names the tool.
    if ((SESSION_TOOL_NAMES as readonly string[]).includes(tool)) {
      const second = decide("sessions", tool, isOwner);
      audit("sessions", tool, second);
      if (!second.allow) return second.reason;
      return scope === "assistant" ? undefined : `${tool} is refused: session discovery is only offered in the Assistant`;
    }
    // Photo discovery and inspection: owner only through the attachments port; reaching another conversation is session reading, so
    // the Assistant also needs the sessions port. A chat thread's tools reach only its own photos (src/photo-access.ts photoPolicy).
    if ((PHOTO_TOOL_NAMES as readonly string[]).includes(tool)) {
      const second = decide("attachments", tool, isOwner);
      audit("attachments", tool, second);
      if (!second.allow) return second.reason;
      if (scope === "assistant") {
        const third = decide("sessions", tool, isOwner);
        audit("sessions", tool, third);
        if (!third.allow) return third.reason;
      }
      return undefined;
    }
    // Vault writes, the config view and pull-request inspection have their own policy port entries, so the owner-only rule is stated for each.
    const port = tool.startsWith("vault_") ? "vault" : tool === "orbit_config_view" ? "config" : (PR_INSPECT_TOOL_NAMES as readonly string[]).includes(tool) ? "pulls" : undefined;
    if (port) {
      const second = decide(port, tool, isOwner);
      audit(port, tool, second);
      return second.allow ? undefined : second.reason;
    }
    return undefined;
  };

  const server = createServer(async (req, res) => {
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

    // The page is served at / (the Assistant, /#assistant, /#jobs) and at its Sessions addresses: /sessions and
    // /sessions/<session id> (docs/threads.md, "Addresses"). Which session an address names is the page's business (an
    // invalid one is reported there, never fetched); the server only serves the page, so a reload or a direct link works.
    if (req.method === "GET" && isPageRoute(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    // Before Sessions, the section was Chat, addressed in the page as /#chat and /#chat/<id> (a fragment the server never
    // sees; the page itself moves those to /sessions). A typed /chat or /chat/<id> is sent to the same session's address
    // with its query; the browser keeps any fragment. The target is built here from a fixed prefix and a validated id, so
    // it is always same-origin. POST /chat (the legacy chat API) and /chat/proposals are API routes and are untouched.
    if (req.method === "GET") {
      const legacy = legacyChatRedirect(url.pathname);
      if (legacy) {
        res.writeHead(302, { location: `${legacy}${url.search}`, "cache-control": "no-store" });
        return res.end();
      }
    }

    if (req.method === "GET" && url.pathname === "/photos.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      return res.end(photosJs);
    }

    if (req.method === "GET" && url.pathname === "/avatar.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(avatar);
    }

    if (req.method === "GET" && url.pathname === "/status") {
      // Read-only: it reports the smoke records and never starts or runs a check.
      return send(res, 200, { commit, deploy: deploy(), ports: statuses(), photos: photoStatus(model), ...(smoke ? { smoke: smoke.summary() } : {}) });
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
          // The owner's interactive chat is the one place a tool-using turn may use the paid fallback.
          fallback: true,
          toolDeadlineMs,
          abortGraceMs,
        });
        const reply = { value: outcome.text || "(the model returned no text)", provenance: "live" as const, source: replySource(model.status().impl, outcome.fallback, outcome.mixed), ...(outcome.fallback ? { fallback: outcome.fallback } : {}), ...(outcome.accounting?.length ? { accounting: outcome.accounting } : {}), ...(outcome.incomplete?.length ? { incomplete: outcome.incomplete } : {}) };
        const fresh = proposals.list().filter((p) => !before.has(p.id));
        return send(res, 200, { reply, memory: used, limits: current, calls: outcome.calls, proposals: fresh, capped: outcome.capped });
      } catch (err) {
        return send(res, 502, { error: `The model call failed: ${err instanceof Error ? err.message : String(err)}`, limits: current });
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

    // ---- Photo attachments (owner only, every route; docs/photos.md). Uploads are raw processed JPEG bodies into one conversation;
    // reads are served only within the conversation that owns the photo. Neither route trusts a filename, MIME type or client metadata.
    const photoRoute = url.pathname.match(/^\/(?:assistant|threads\/([0-9a-f-]{36}))\/attachments(?:\/([A-Za-z0-9]{1,64}))?$/);
    if (photoRoute) {
      const [, threadId, attId] = photoRoute;
      if (threadId !== undefined && !isThreadId(threadId)) return send(res, 404, { error: "No thread with that id." });
      const scope = threadId ? chatScope(threadId) : "assistant";
      if (attId === undefined) {
        if (req.method !== "POST") return send(res, 405, { error: "Use POST for this route." });
        if (!(await owned("attachments", "upload"))) return;
        if (threadId) {
          const t = threads.get(threadId);
          if (!t) return send(res, 404, { error: "No thread with that id." });
          if (t.archived) return send(res, 409, { error: "This thread is archived. Restore it to attach photos." });
        }
        // The log line names the kind of refusal and, for a file that failed the JPEG check, the parser's fixed reason (for example
        // "a quantization table is missing" or "signature:heic"). It never holds bytes, sizes of the content, filenames or captions.
        const refuse = (code: number, error: string, kind: string, reason?: string) => {
          console.log(JSON.stringify({ at: new Date().toISOString(), event: "attachment_refused", scope: threadId ? "chat" : "assistant", kind, ...(reason ? { reason } : {}) }));
          res.setHeader("connection", "close");
          return send(res, code, { error, kind });
        };
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > JPEG_MAX_BYTES) return refuse(413, `The photo is larger than ${JPEG_MAX_BYTES} bytes. ORBIT's page shrinks photos before upload; nothing was stored.`, "size");
        // Read into memory only, never to a temporary file, and stop at the limit.
        const parts: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > JPEG_MAX_BYTES) return refuse(413, `The photo is larger than ${JPEG_MAX_BYTES} bytes. ORBIT's page shrinks photos before upload; nothing was stored.`, "size");
            parts.push(chunk as Buffer);
          }
        } catch {
          return refuse(400, "The upload did not complete. Nothing was stored.", "aborted");
        }
        const checked = normalizeJpeg(Buffer.concat(parts));
        if (!checked.ok) return refuse(checked.kind === "size" ? 413 : checked.kind === "format" ? 415 : 422, checked.error, checked.kind, checked.reason);
        try {
          const { meta, reused } = attachments.put(scope, checked.bytes, { width: checked.width, height: checked.height });
          console.log(JSON.stringify({ at: new Date().toISOString(), event: "attachment_stored", scope: threadId ? "chat" : "assistant", id: meta.id, bytes: meta.bytes, width: meta.width, height: meta.height, reused }));
          return send(res, reused ? 200 : 201, { attachment: { id: meta.id, type: meta.type, bytes: meta.bytes, width: meta.width, height: meta.height, reused } });
        } catch (err) {
          if (err instanceof AttachmentError) return send(res, err.code, { error: err.message });
          return send(res, 500, { error: "Could not store the photo. Nothing was stored." });
        }
      }
      if (req.method !== "GET") return send(res, 405, { error: "Use GET for this route." });
      // Reads are GETs, so the cross-site refusal above does not cover them: a page on another site must not be able to embed or
      // fetch a photo through Rai's browser either.
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") {
        audit("policy", "cross-site", { allow: false, reason: `refused a photo read from ${site}` });
        return send(res, 403, { error: "Cross-site requests are refused." });
      }
      if (!(await owned("attachments", "read"))) return;
      const bytes = isAttachmentId(attId) ? attachments.read(attId, scope) : undefined;
      if (!bytes) return send(res, 404, { error: "No photo with that id in this conversation." });
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": String(bytes.length),
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
        "content-disposition": 'inline; filename="photo.jpg"',
      });
      return res.end(bytes);
    }
    // ---- Displayed photos (docs/photo-recall.md): GET only, owner only, same-site only. The viewing conversation is the route's, never
    // a parameter; every fetch re-authorizes the ref under that conversation's policy and re-checks the source and the stored file, so
    // showing a ref somewhere grants nothing. 404: not visible here (unknown, forged, other conversation, source gone); 410: visible
    // but its stored file is missing or damaged.
    const shownRoute = url.pathname.match(/^\/(?:assistant|threads\/([0-9a-f-]{36}))\/photos\/([A-Za-z0-9_]{1,64})$/);
    if (shownRoute) {
      const [, threadId, ref] = shownRoute;
      if (req.method !== "GET") return send(res, 405, { error: "Use GET for this route." });
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") {
        audit("policy", "cross-site", { allow: false, reason: `refused a photo read from ${site}` });
        return send(res, 403, { error: "Cross-site requests are refused." });
      }
      if (!(await owned("attachments", "read"))) return;
      // Showing another conversation's photo in the Assistant is session reading, as for the photo tools there.
      if (threadId === undefined && !(await owned("sessions", "read"))) return;
      if (threadId !== undefined && (!isThreadId(threadId) || !threads.get(threadId))) return send(res, 404, { error: "No thread with that id." });
      const caller = threadId ? chatSessionId(threadId) : assistantSessionId();
      const got = isPhotoRef(ref) ? display.fetch(caller, ref!) : ({ ok: false, status: 404 } as const);
      if (!got.ok) return send(res, got.status, { error: got.status === 410 ? "This photo's stored file is missing or damaged." : "No such photo is visible in this conversation." });
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": String(got.bytes.length),
        // Re-authorized on every request: a revoked source must not keep showing from a cache.
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
        "content-disposition": 'inline; filename="photo.jpg"',
      });
      return res.end(got.bytes);
    }

    // The photos a message names, bound to it before its turn (all or none). Refused before anything is stored when one is unknown,
    // from another conversation, already sent, or more than allowed. `release` undoes the bind when the message was never stored.
    const photosOf = (input: Record<string, unknown>, scope: string): { refs: AttachmentRef[]; release(stored: () => boolean): void } | undefined => {
      try {
        const refs = attachments.bind(input.attachments, scope);
        return { refs, release: (stored) => void (refs.length && !stored() && attachments.release(refs.map((r) => r.id), scope)) };
      } catch (err) {
        if (err instanceof AttachmentError) send(res, err.code, { error: err.message });
        else send(res, 500, { error: "Could not record the photos. Nothing was sent." });
        return undefined;
      }
    };
    const tooMany = (input: Record<string, unknown>) => Array.isArray(input.attachments) && input.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE;
    const hasRefs = (msgs: { attachments?: AttachmentRef[] }[], refs: AttachmentRef[]) => msgs.some((m) => m.attachments?.some((a) => a.id === refs[0]?.id));

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
        const withPhotos = Array.isArray(input.attachments) && input.attachments.length > 0;
        if (tooMany(input)) return send(res, 400, { error: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} photos per message. Nothing was sent.` });
        if ((!text && !withPhotos) || text.length > MAX_MESSAGE_CHARS) return send(res, 400, { error: `Send {text}: 1-${MAX_MESSAGE_CHARS} characters (or photos with optional text).` });
        const decision = decide("channel", "chat", false);
        audit("channel", "chat", decision);
        if (!decision.allow) return send(res, 403, { error: decision.reason });
        if (threads.isBusy(id)) return send(res, 409, { error: "A reply is already in progress in this thread." });
        if (threads.get(id)?.archived) return send(res, 409, { error: "This thread is archived. Restore it to continue." });
        const prep = await prepare(callerIsOwner, text, "chat", chatSessionId(id));
        const photos = photosOf(input, chatScope(id));
        if (!photos) return;
        let out;
        try {
          out = await svc.turn(id, text, { notes: prep.notes, memory: prep.used, limits: prep.current, tools: prep.offered, allow: allowAgent(callerIsOwner), isOwner: callerIsOwner, ...(photos.refs.length ? { attachments: photos.refs } : {}) });
        } catch (err) {
          photos.release(() => hasRefs(threads.get(id)?.messages ?? [], photos.refs));
          throw err;
        }
        return send(res, out.error ? 502 : 200, { thread: out.thread, limits: prep.current, ...(out.error ? { error: out.error } : {}) });
      } catch (err) {
        return threadFail(err);
      }
    }

    // ---- The Assistant (owner only, every route). There is exactly one conversation and the server names it: no route takes an id
    // or a path from the browser. docs/assistant.md describes the storage and the context bound.
    if (url.pathname === "/assistant" || url.pathname === "/assistant/history" || url.pathname === "/assistant/messages") {
      const route = url.pathname.slice("/assistant".length) || "/";
      const method = route === "/messages" ? "POST" : "GET";
      if (req.method !== method) return send(res, 405, { error: `Use ${method} for this route.` });
      if (!(await owned("assistant", route === "/" ? "open" : route.slice(1)))) return;
      const callerIsOwner = await isOwnerOf(req);
      let assistantPhotos: ReturnType<typeof photosOf>;
      try {
        if (route === "/") return send(res, 200, { assistant: assistantView() });
        if (route === "/history") {
          const before = Number(url.searchParams.get("before"));
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
          const page = assistant.archivePage(Number.isSafeInteger(before) && before > 0 ? before : undefined, limit);
          return send(res, 200, { chunks: page.chunks.map(chunkView), more: page.more });
        }
        const input = await body();
        if (!input) return;
        const text = typeof input.text === "string" ? input.text.trim() : "";
        const withPhotos = Array.isArray(input.attachments) && input.attachments.length > 0;
        if (tooMany(input)) return send(res, 400, { error: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} photos per message. Nothing was sent.` });
        if ((!text && !withPhotos) || text.length > MAX_MESSAGE_CHARS) return send(res, 400, { error: `Send {text}: 1-${MAX_MESSAGE_CHARS} characters (or photos with optional text).` });
        const decision = decide("channel", "chat", false);
        audit("channel", "chat", decision);
        if (!decision.allow) return send(res, 403, { error: decision.reason });
        // Refused before any vault search or model call when a reply is already running (another tab or device): nothing is queued.
        if (assistant.isBusy(ASSISTANT_ID)) return send(res, 409, { error: "A reply is already in progress in the Assistant (maybe from another tab or device). Nothing was sent; wait for it and send again.", assistant: assistantView() });
        // The page sends an id with each send. A browser can silently repeat a POST whose connection dropped; a repeat of a send
        // that already started a turn is refused, never run twice.
        const requestId = typeof input.requestId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(input.requestId) ? input.requestId : undefined;
        const duplicate = () => send(res, 409, { error: "This message was already received (the browser repeated the request). It was not run again.", duplicate: true, assistant: assistantView() });
        if (requestId && assistant.seenRequest(requestId)) return duplicate();
        const prep = await prepare(callerIsOwner, text, "assistant", assistantSessionId());
        if (requestId && assistant.seenRequest(requestId)) return duplicate();
        if (assistant.isBusy(ASSISTANT_ID)) return send(res, 409, { error: "A reply is already in progress in the Assistant (maybe from another tab or device). Nothing was sent; wait for it and send again.", assistant: assistantView() });
        const photos = photosOf(input, "assistant");
        if (!photos) return;
        assistantPhotos = photos;
        // Set immediately before the turn: nothing is awaited between here and the turn's first write, which takes it.
        assistant.expectRequest(requestId);
        const out = await asvc.turn(ASSISTANT_ID, text, { notes: [boundNotes(prep.notes), prep.digest].filter(Boolean).join("\n\n") || undefined, memory: prep.used, limits: prep.current, tools: prep.offered, allow: allowAgent(callerIsOwner, "assistant"), isOwner: callerIsOwner, ...(photos.refs.length ? { attachments: photos.refs } : {}) });
        return send(res, out.error ? 502 : 200, { assistant: assistantView(), limits: prep.current, ...(out.error ? { error: out.error } : {}) });
      } catch (err) {
        assistant.expectRequest(undefined);
        const bound = assistantPhotos;
        bound?.release(() => hasRefs(assistant.active().flatMap((c) => c.messages), bound.refs));
        if (err instanceof ThreadError) return send(res, err.code, { error: err.message, ...(err.code === 409 ? { assistant: assistantView() } : {}) });
        return send(res, 500, { error: "Could not save the Assistant conversation. Nothing more was changed." });
      }
    }

    if (url.pathname === "/notifications" && req.method === "GET") {
      if (!(await owned("notify", "inbox"))) return;
      return send(res, 200, { inbox: notify.inbox(), current: notify.current(), recent: notify.recent() });
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
      // An empty body is an older page's ack and keeps the original receipt; {listed: true} is the listing receipt.
      // Repeating an ack is safe: the first receipt stands and the note is returned unchanged.
      const input = await body();
      if (!input) return;
      const n = notify.ack(ack[1], { listed: input.listed === true });
      return n ? send(res, 200, n) : send(res, 404, { error: "No notification with that id." });
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
      return send(res, 200, { jobs: jobs.list().map((j) => withHealth({ ...j, ...(j.summary ? { summary: { ...j.summary, text: "" } } : {}) })) });
    }
    if (jobs && url.pathname === "/jobs/launch" && req.method === "POST") {
      if (!(await owned("jobs", "launch"))) return;
      const input = await body();
      if (!input) return;
      // Launch-time vault context export was removed (src/job-context.ts): a body that still names notes is refused, never launched without them.
      if (hasLegacyContext(input.context)) return send(res, 400, { error: LEGACY_CONTEXT_ERROR, context: { refused: true, reason: "unsupported" } });
      const result = await launchJob(String(input.routine ?? ""), typeof input.brief === "string" ? input.brief : "", undefined);
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
        const known = cardSvc(proposalMatch[1]).missing(proposalMatch[1]);
        // A repeated confirmation is answered from the records (and the work link, if one was recorded): nothing runs again.
        const run = known ? safeLink(proposalMatch[1]) : undefined;
        if (known) return send(res, known.code, run ? { ...(known.body as object), work: run } : known.body);
      }
      // Single use has two guards that must agree: the proposal store's take() and the thread card's open -> confirmed/cancelled
      // compare-and-set. Both are synchronous, so of any number of concurrent requests exactly one gets past them.
      const claimed = (id: string, to: "confirmed" | "cancelled"): boolean => cardSvc(id).claim(id, to);
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
        cardSvc(taken.id).settle(taken.id, result);
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
        cardSvc(taken.id).settle(taken.id, result);
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
        cardSvc(taken.id).settle(taken.id, result);
        return send(res, result.code, result.body);
      }
      if (open?.kind === "job_launch" && confirming) {
        // A launch confirmation (docs/adr/0002-work-sessions.md). Everything that can refuse it without spending the proposal runs first:
        // the origin check, the work-session store, and an optional attachment to an existing work session (owner's request body only;
        // never the model). Then take() and the card's compare-and-set make it single use, the link is written (`launching`) before any
        // external step, the job is registered carrying the link in the same write, and the launcher's result is recorded on both.
        if (!jobs) return send(res, 503, { error: "Jobs are not enabled." });
        const input = await body();
        if (!input) return;
        const origin = originOf(open);
        if ("conflict" in origin) return send(res, 409, { error: "This proposal's recorded conversation does not match the conversation that stores its card. Nothing was done." });
        let plan;
        try {
          work.check();
          plan = work.plan(input.attach, origin, jobsReader);
        } catch (e) {
          if (e instanceof WorkError) return send(res, e.code, { error: e.message });
          throw e;
        }
        const taken = proposals.take(open.id);
        if (!taken || taken.kind !== "job_launch") {
          const known = cardSvc(open.id).missing(open.id);
          return known ? send(res, known.code, { ...(known.body as object), ...(safeLink(open.id) ? { work: safeLink(open.id) } : {}) }) : send(res, 404, gone);
        }
        if (!claimed(taken.id, "confirmed")) return alreadyUsed();
        if (hasLegacyContext((taken as { context?: unknown }).context)) {
          const refused = { code: 409, body: { error: LEGACY_CONTEXT_ERROR, context: { refused: true, reason: "unsupported" } } };
          cardSvc(taken.id).settle(taken.id, refused);
          return send(res, refused.code, refused.body);
        }
        let link: RunLink;
        try {
          link = work.begin(taken.id, origin, plan);
        } catch (e) {
          const refused = { code: 503, body: { error: `Not launched: the work-session record could not be written (${e instanceof WorkError ? e.message : "write failed"}). Nothing was sent to a runner.` } };
          cardSvc(taken.id).settle(taken.id, refused);
          return send(res, refused.code, refused.body);
        }
        let result: { code: number; body: unknown };
        try {
          // The proposal's lane is enforced by the launcher: a build card never launches on a research routine, or the reverse.
          result = await launchJob(taken.routine, taken.brief, undefined, { proposal: taken.id, workSession: link.workSession, origin: origin.session }, taken.lane === "research" ? "research" : "build");
        } catch (e) {
          // The launcher threw: whether a job was registered or fired is not known here. The job store is read (never retried) and
          // the link says what it shows: no job means nothing was sent; a job without a fire result is ambiguous.
          let after: RunLink | undefined;
          try {
            work.reconcile(jobsReader, taken.id);
            after = work.linkOf(taken.id);
          } catch {
            after = undefined;
          }
          result = { code: 500, body: { error: `The launch did not complete normally (${e instanceof Error ? e.message.slice(0, 200) : "error"}). It was not retried.`, ...(after?.launch.job ? { job: { id: after.launch.job } } : {}), outcome: after?.launch.state ?? "unknown" } };
          cardSvc(taken.id).settle(taken.id, result);
          return send(res, result.code, { ...(result.body as object), work: linkView(after) ?? { workSession: link.workSession, launch: { state: "unknown" } } });
        }
        let recorded: RunLink | undefined;
        try {
          recorded = work.settle(taken.id, result);
        } catch {
          // The link stays `launching`; the job carries its link, so the next start reconciles it from the job store.
          recorded = undefined;
        }
        cardSvc(taken.id).settle(taken.id, result);
        return send(res, result.code, { ...(result.body as object), work: linkView(recorded) ?? { ...linkView(link), note: "The launch result could not be written to the work-session record; it is reconciled from the job store at the next start." } });
      }
      const proposal = proposals.take(proposalMatch[1]);
      if (!proposal) return send(res, 404, gone);
      if (proposalMatch[2] === "cancel") {
        if (!claimed(proposal.id, "cancelled")) return alreadyUsed();
        if (proposal.kind === "vault_edit") vaultEdits?.cancelled(proposal.id);
        return send(res, 200, { cancelled: proposal.id });
      }
      if (proposal.kind === "ops_admin" || proposal.kind === "ops_sys") return send(res, 409, { error: "Not confirmed: server operations need their digest." });
      if (proposal.kind === "vault_edit") return send(res, 409, { error: "Not confirmed: a vault edit needs its digest." });
      if (!jobs) return send(res, 503, { error: "Jobs are not enabled." });
      if (!claimed(proposal.id, "confirmed")) return alreadyUsed();
      if (proposal.kind === "job_steer") {
        const steer = jobs.steer(proposal.job, proposal.text);
        const result = steer ? { code: 201, body: { steered: proposal.job, steer } } : { code: 404, body: { error: "That job no longer exists." } };
        cardSvc(proposal.id).settle(proposal.id, result);
        return send(res, result.code, result.body);
      }
      // A proposal made by an older build may still carry a vault context list. It is refused (the card shows "refused"), never
      // launched without the notes that were shown when it was proposed.
      if (hasLegacyContext((proposal as { context?: unknown }).context)) {
        const refused = { code: 409, body: { error: LEGACY_CONTEXT_ERROR, context: { refused: true, reason: "unsupported" } } };
        cardSvc(proposal.id).settle(proposal.id, refused);
        return send(res, refused.code, refused.body);
      }
      // Launch confirmations are handled above (with their work link). A launch proposal that reaches here was not open when the route
      // looked, so it is refused rather than launched without its link.
      const refused = { code: 409, body: { error: "Not confirmed: this launch proposal was not open when the confirmation arrived. Nothing was launched." } };
      cardSvc(proposal.id).settle(proposal.id, refused);
      return send(res, refused.code, refused.body);
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
  // Post-deploy smoke checks start as soon as the service can accept requests, with no user activity. Not awaited: the suite has its
  // own deadlines and never holds up listening or any request. start() is single-flight, so a second "listening" runs nothing new.
  if (smoke) server.once("listening", () => void smoke.start());
  return server;
}

// Photo capability for /status: what the running process would do with a photo now, and why. Model id, capability, source and
// freshness only: no evidence prose, no credentials. orbit_config_view has the full resolution for the owner.
export function photoStatus(model: ModelPort) {
  const s = model.images?.();
  if (!s) return { ok: false, capability: "unknown", blocking: "blocked locally: the connected model adapter does not take photos" };
  return { ok: s.ok, capability: s.capability ?? (s.ok ? "supported" : "unknown"), ...(s.resolution ? resolutionSummary(s.resolution) : {}), blocking: s.ok ? undefined : `blocked locally: ${s.detail.slice(0, 300)}` };
}
