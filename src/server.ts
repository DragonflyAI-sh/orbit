import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Identify } from "./identity.ts";
import { withAvailability } from "./model-availability.ts";
import { jobLauncher } from "./job-launch.ts";
import { dispatchEvidence } from "./launch-evidence.ts";
import { launchReconciliations, ReconcileError, reconFile, type LaunchReconciliations } from "./launch-reconciliation.ts";
import { researchStore } from "./research.ts";
import type { ResearchLane, ResearchStore, ResearchTool } from "./research.ts";
import { researchTools, watchResearchVault, withLaneGuard } from "./research-tools.ts";
import { hasLegacyContext, LEGACY_CONTEXT_ERROR, refuseLegacyContext } from "./job-context.ts";
import { alertDelivery, jobProgress } from "./job-progress.ts";
import { toolCommitStatus } from "./job-view.ts";
import { EVENTS_DEFAULT, eventsPage, jobDetail, listRows, parseRowQuery } from "./job-detail.ts";
import type { OpenSteerProposal } from "./job-detail.ts";
import type { Job, Jobs } from "./jobs.ts";
import type { ControlRepo, Routine } from "./launcher.ts";
import type { MemoryPort } from "./memory.ts";
import type { Login } from "./chatgpt.ts";
import { answeredBy, replySource } from "./model.ts";
import type { Message, ModelPort } from "./model.ts";
import { proposals as newProposals, runChat, screenReply } from "./agent.ts";
import type { ChatTool, Proposals } from "./agent.ts";
import { chatTools } from "./chat-tools.ts";
import { textReaderTools } from "./text-readers.ts";
import { taskMemory, taskScopedTools } from "./task-context.ts";
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
import { assistantSummaries } from "./assistant-summary.ts";
import { assistantAdapter, assistantSessionId, chatAdapter, chatSessionId, SESSION_TOOL_NAMES, sessionRegistry, sessionTools, workAdapter } from "./sessions.ts";
import { isOriginId, workFile, WorkError, workSessions as newWorkSessions } from "./work-sessions.ts";
import type { Origin, RunLink, WorkSessions } from "./work-sessions.ts";
import type { Proposal } from "./agent.ts";
import { sessionDigest } from "./session-digest.ts";
import type { Chunk } from "./assistant-store.ts";
import { resolutionSummary } from "./model-capability.ts";
import { AttachmentError, attachmentStore, isAttachmentId, MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.ts";
import { localTime, PHOTO_TOOL_NAMES, photoDisplay, photoTools, reachablePhotos } from "./photo-access.ts";
import { sidebarNote, sidebarView } from "./sidebar.ts";
import { dayIn, planOverview, projectDetail } from "./plan.ts";
import type { SidebarPhoto } from "./sidebar.ts";
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
import { WORKSPACE_TOOL_NAMES } from "./workspace/service.ts";
import type { WorkspaceService } from "./workspace/service.ts";
import { WORKSPACE_ADMIN_TOOL_NAMES } from "./workspace/admin.ts";
import type { WorkspaceAdmin } from "./workspace/admin.ts";
import { AUTO_GLOBAL_PER_DAY_DEFAULT, isTaskId, parseCreate, TaskError, taskFile, taskStore } from "./tasks.ts";
import type { Observers, Provenance, Tasks } from "./tasks.ts";
import { isTaskToolName, TASK_ASSISTANT_TOOL_NAMES, TASK_TURNS_MAX_CONCURRENT, taskSupervisor } from "./task-supervisor.ts";
import { taskScheduler } from "./task-scheduler.ts";
import { taskRouter } from "./task-routing.ts";
import type { TaskRouting } from "./task-routing.ts";
import { supervisorWake, WAKE_MAX_ROUNDS, wakeFile } from "./task-wake.ts";
import type { SupervisorWake, WakeBackend, WakeTurn } from "./task-wake.ts";
import type { TaskScheduler } from "./task-scheduler.ts";
import { taskVaultSync } from "./task-vault.ts";
import type { TaskVaultPort } from "./task-vault.ts";

export const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_NOTE_CHARS = 2000;
// The page shows message times in ORBIT's configured zone (src/time.ts), the one schedules, quiet hours and photo days use.
const ZONE_META = /<meta name="orbit-time-zone" content="[^"]*">/;
export const pageHtml = (html: string, zone: string): string => html.replace(ZONE_META, `<meta name="orbit-time-zone" content="${zone.replace(/[^A-Za-z0-9_+\-/]/g, "")}">`);
const page = pageHtml(readFileSync(new URL("./web/index.html", import.meta.url), "utf8"), ZONE);
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
  // The read-only host inventory tool (src/host-inventory.ts, docs/host-inventory.md). Offered to the owner only, and only when
  // ORBIT_HOST_INVENTORY=enabled; absent means it is not offered.
  hostInventory?: ChatTool[];
  // Workspace filesystem and sandboxed exec tools (src/workspace/service.ts, docs/workspace-tools.md). Owner only; off unless the
  // operator activated them. Absent (or not enabled) means no workspace tool is offered and every workspace confirmation is refused.
  workspace?: WorkspaceService;
  // The named workspace activation operations (src/workspace/admin.ts): preflight, setup/revoke via the root helper, validation, enable,
  // disable. Owner only (the `workspace` port); confirmed on `workspace_op` cards with ws_* actions.
  workspaceAdmin?: WorkspaceAdmin;
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
  // The Assistant's cumulative rolling summary (src/assistant-summary.ts, docs/rolling-summaries.md). On unless false (ORBIT_ROLLING_SUMMARIES=0
  // in main.ts): off, no summary is made or given, exactly as before; stored versions are kept. `timeoutMs` bounds one summarizer request.
  rollingSummaries?: boolean;
  rollingSummaryTimeoutMs?: number;
  // Work sessions and run links (src/work-sessions.ts, docs/adr/0002-work-sessions.md). Absent means memory only, which a restart empties.
  workSessions?: WorkSessions;
  // The owner's launch reconciliation log (src/launch-reconciliation.ts, <state>/launch-reconciliations.json). Absent means memory only.
  reconciliations?: LaunchReconciliations;
  // Private photo attachments (src/attachments.ts, docs/photos.md), kept in <state>/attachments. Absent means memory only.
  attachments?: Attachments;
  // Saved photo observations (src/photo-observations.ts, docs/photo-recall.md), kept in <state>/photo-observations. Absent means memory only.
  photoObservations?: ObservationStore;
  // Opt-in semantic photo search (src/photo-semantic.ts, docs/photo-semantic-search.md). Absent (the default) means photos_search is not
  // offered and nothing changes. `status` is its /status line.
  photoSemantic?: { embedder: Embedder | undefined; cacheDir: string | undefined; status(): PortStatus };
  // Startup smoke checks (docs/smoke-checks.md). Started once, when the server starts listening; /status only reads the records.
  smoke?: SmokeRunner;
  // Supervised tasks (src/tasks.ts, src/task-supervisor.ts, docs/adr/0003-supervised-tasks.md). Absent means memory only, which a restart
  // empties. `taskVault`: the vault write pipeline for task status lines (src/task-vault.ts); absent means task vault sync reports that
  // vault writes are not enabled. `taskModel`: the model port supervised task turns run on; absent means the same model as every other
  // turn (which model that is stays configuration; nothing here picks one). `taskTurnsMax`: supervised turns running at once.
  tasks?: Tasks;
  taskVault?: TaskVaultPort;
  taskModel?: ModelPort;
  // Repair 4: an explicit table from task-turn kind to configured model ports (src/task-routing.ts). Absent (main.ts sets none): every
  // task turn uses `taskModel` (or the model every turn uses), as before. A route to an unknown, paid or tool-less port refuses the turn.
  taskModels?: TaskRouting;
  taskTurnsMax?: number;
  // Automatic task follow-ups (src/task-scheduler.ts, docs/adr/0003-supervised-tasks.md "Automatic follow-up"). Absent or
  // enabled: false means the scheduler never starts a turn (the per-task opt-in is then shown as having no effect). `tickMs`: how often
  // it looks (0: never on a timer; tests tick it themselves through `onScheduler`). `globalPerDay`: automatic turns across tasks in any
  // 24 hours.
  taskFollowUps?: { enabled: boolean; tickMs?: number; globalPerDay?: number; onScheduler?: (s: TaskScheduler) => void };
  // The opt-in supervisor wake (src/task-wake.ts, docs/adr/0003-supervised-tasks.md "Repair 4"). Absent or enabled: false (the
  // default) means nothing ever starts an Assistant turn by itself. Enabled is the OPERATOR's switch only: Rai must still opt in from
  // the Assistant page. `backend`: where its record lives (<state>/supervisor-wake.json in main.ts; memory when absent). `tickMs`: how
  // often it looks (0: never on a timer; tests tick it through `onWake`).
  supervisorWake?: { enabled: boolean; backend?: WakeBackend; tickMs?: number; minIntervalMs?: number; onWake?: (w: SupervisorWake) => void };
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
  hostInventory,
  workspace,
  workspaceAdmin,
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
  rollingSummaries = true,
  rollingSummaryTimeoutMs,
  workSessions: workArg,
  reconciliations: reconArg,
  attachments = attachmentStore(undefined),
  photoObservations = observationStore(undefined),
  photoSemantic,
  smoke,
  recentContext: recentPort = stateRecentContext(jsonStore(undefined, "recent-context", null)),
  tasks = taskStore(taskFile(undefined)),
  taskVault,
  taskModel,
  taskModels,
  taskTurnsMax = TASK_TURNS_MAX_CONCURRENT,
  taskFollowUps,
  supervisorWake: supervisorWakeArg,
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
    ].map((s) => withAvailability(withCheck(s, smoke?.forPort(s.port, now))));
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
  // The owner's launch reconciliation log: append-only, beside the job store; it never changes a job record.
  const recon = reconArg ?? launchReconciliations(reconFile(undefined), now, { notify });
  const reconView = (job: Job) => {
    try {
      return recon.view(job);
    } catch (e) {
      return { state: "unavailable" as const, detail: e instanceof Error ? e.message.slice(0, 200) : "unreadable" };
    }
  };
  const withHealth = (job: Job) => {
    const health = jobs!.health(job);
    return { ...job, toolCommit: job.toolCommit ?? "unknown", toolCommitStatus: toolCommitStatus(job.toolCommit, commit), health, progress: jobProgress(job, health), dispatch: dispatchEvidence(job), reconciliation: reconView(job) };
  };
  // The live delivery outcome of a job's first-callback alert (src/job-progress.ts), from ORBIT's own notification store.
  const callbackAlertDelivery = (job: Job) => alertDelivery(job.callbackAlert, job.callbackAlert?.notificationId ? notify.get(job.callbackAlert.notificationId) : undefined, notify.status().impl.includes("discord"), (now ?? (() => new Date()))());
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
  const laneTools = () => (jobs ? researchTools({ jobs, proposals, lane: researchLane, build: launchable, routineRepos: research?.routineRepos ?? new Map(), store: research?.store ?? researchStore(undefined), vault: vaultEdits, now, alertDelivery: callbackAlertDelivery }) : []);

  // Threads: the store, the rolling recent-context note, and the service that runs a turn against a thread.
  const recent = recentContext({ port: recentPort, threads, model, now, cardLines: (t) => svc.cardLines(t) });
  // `origin`: a proposal made in a turn is bound to that turn's conversation (server context, never model text) before its card is stored.
  // Photos are loaded per conversation scope: a chat thread's turn can only read that thread's attachments, the Assistant's only its own.
  const chatScope = (threadId: string) => `chat:${threadId}`;
  const svc = threadService({ threads, model, proposals, jobs, admin: adminOps, sys: sysOps, workspace, workspaceAdmin, recent, now, toolDeadlineMs, abortGraceMs, origin: chatSessionId, photos: (tid, aid) => attachments.read(aid, chatScope(tid)), galleries: (tid, g) => display.galleries(chatSessionId(tid), g) });

  // The Assistant (docs/assistant.md): one server-owned rolling conversation in its own chunk store, run by the same turn code as
  // chat threads but with a bounded context and no compaction. It does not feed or read the chat threads' rolling note.
  const clock = now ?? (() => new Date());
  const assistant = assistantStore(assistantDir, { now, held: (card) => Boolean(proposals.peek(card.id)) && new Date(card.expiresAt) > clock() });
  // The rolling summary of the Assistant (docs/rolling-summaries.md): a new immutable version at each page roll (chunks archived), given
  // with every later model call of the conversation. It lives beside the chunks and never reads chat threads.
  const summaries = assistantSummaries(assistantDir ? join(assistantDir, "summaries") : undefined, { store: assistant, model, now, enabled: rollingSummaries, timeoutMs: rollingSummaryTimeoutMs });
  // The summary block of the turn in progress, built from the same plan the model input is built from, and recorded with it.
  let turnSummary: ReturnType<typeof summaries.block>;
  const planTurn = () => {
    const plan = assistant.plan(assistant.currentTurn());
    assistant.recordContext(plan, turnSummary?.use);
    return plan;
  };
  const asvc = threadService({
    threads: assistant,
    model,
    proposals,
    jobs,
    admin: adminOps,
    sys: sysOps,
    workspace,
    now,
    toolDeadlineMs,
    abortGraceMs,
    compact: false,
    beforeTurn: () => summaries.roll(),
    summaryNote: () => {
      turnSummary = summaries.block(assistant.plan(assistant.currentTurn()));
      return turnSummary?.text;
    },
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

  // ---- Supervised tasks (docs/adr/0003-supervised-tasks.md). A task's session is a chat thread; its turns run through their own thread
  // service over the same thread store (so the thread's single-turn lock serializes them with Rai's own messages), with the task model,
  // and without the rolling recent-context note, so no other conversation's context reaches a task turn.
  const taskSvcFor = (m: ModelPort) => threadService({ threads, model: m, proposals, jobs, admin: adminOps, sys: sysOps, workspace, workspaceAdmin, now, toolDeadlineMs, abortGraceMs, origin: chatSessionId, photos: (tid, aid) => attachments.read(aid, chatScope(tid)), galleries: (tid, g) => display.galleries(chatSessionId(tid), g) });
  const tsvc = taskSvcFor(taskModel ?? model);
  // Task-turn routing (Repair 4): one thread service per routed port, over the same thread store (same lock, same tools and cards).
  const taskRoutes = taskRouter(taskModel ?? model, taskModels);
  const routedSvc = new Map<string, ReturnType<typeof threadService>>();
  const svcForPort = (name?: string) => {
    if (!name || name === "default") return tsvc;
    let s = routedSvc.get(name);
    const p = taskRoutes.port(name);
    if (!s && p) routedSvc.set(name, (s = taskSvcFor(p)));
    if (!s) throw new TaskError(503, `No model port named ${name} is configured for task turns.`);
    return s;
  };
  // What a linked launch proposal became (the proposal store, then its card) and what the job store says of a job. Read only.
  const taskObservers: Observers = {
    proposal: (pid) => {
      if (proposals.peek(pid)) return { state: "awaiting-confirmation" };
      const card = assistant.card(pid) ?? threads.card(pid);
      if (!card) return { state: "unknown", detail: "no card records this proposal" };
      if (card.state === "confirmed") return { state: "confirmed", ...(card.outcome?.jobId ? { job: card.outcome.jobId } : {}), ...(card.outcome?.error ? { detail: card.outcome.error } : {}) };
      return { state: card.state === "open" ? "expired" : card.state, ...(card.outcome?.error ? { detail: card.outcome.error } : {}) };
    },
    job: (id) => {
      if (!jobs) return { found: false, why: "jobs are not enabled" };
      try {
        const j = jobs.get(id);
        return j ? { found: true, state: j.state, health: jobs.health(j), ...(j.work?.proposal ? { proposal: j.work.proposal } : {}) } : { found: false, why: "not in the job store (it keeps the newest 200)" };
      } catch {
        return { found: false, why: "the job store is unavailable" };
      }
    },
    links: (pid) => tasks.proposalLinks(pid).length,
  };
  const tasksVault = taskVaultSync({ tasks, port: taskVault, observers: taskObservers, now });
  const supervisor = taskSupervisor({
    tasks,
    createThread: (title) => threads.create(title, { taskSession: true }).id,
    threadBusy: (tid) => threads.isBusy(tid),
    threadExists: (tid) => Boolean(threads.get(tid)),
    turn: (tid, text, prep, opts) => svcForPort(opts.port).turn(tid, text, prep, { ...(opts.signal ? { signal: opts.signal } : {}) }),
    ...(taskModels
      ? {
          route: (kind: Parameters<typeof taskRoutes.resolve>[0]) => {
            const r = taskRoutes.resolve(kind);
            return r.ok ? { ok: true as const, name: r.name, impl: r.impl, routed: r.routed, canUseTools: Boolean(r.port.step) } : r;
          },
        }
      : {}),
    prepare: async (isOwner, query, tid) => {
      const p = await prepare(isOwner, query, "chat", chatSessionId(tid), { taskSession: true });
      return { notes: p.notes, used: p.used, current: p.current, offered: p.offered };
    },
    allowChat: (isOwner) => allowAgent(isOwner, "chat"),
    decide: (action, isOwner) => {
      const dec = decide("tasks", action, isOwner);
      audit("tasks", action, dec);
      return dec;
    },
    observers: taskObservers,
    // Only an open job_launch proposal bound to the Assistant (made by its own job_launch call) can answer a task's job request.
    linkable: (pid) => {
      const p = proposals.peek(pid);
      if (!p) return { ok: false, why: "no open proposal has that id (it was never made, already used, or expired)" };
      if (p.kind !== "job_launch") return { ok: false, why: "that proposal is not a job launch" };
      if (p.origin !== assistantSessionId()) return { ok: false, why: "that proposal was not made in the Assistant" };
      // The lane is the proposal store's own (research_launch sets "research"), never the request's or the model's say-so.
      return { ok: true, proposal: { id: p.id, kind: "job_launch", lane: p.lane === "research" ? "research" : "build", routine: p.routine, brief: p.brief, origin: p.origin, createdAt: p.createdAt } };
    },
    vault: tasksVault,
    // Rai cancelled a task: its OPEN launch cards are withdrawn exactly as the card's own Cancel does (proposal store take + card
    // open -> cancelled), so nothing launches for a cancelled task. A card that is no longer open is left as it is.
    withdrawProposal: (pid) => {
      const p = proposals.peek(pid);
      if (!p) return { withdrawn: false, why: "the proposal is no longer open (already confirmed, cancelled or expired)" };
      const taken = proposals.take(pid);
      if (!taken) return { withdrawn: false, why: "the proposal was taken meanwhile" };
      const ok = cardSvc(pid).claim(pid, "cancelled");
      return ok ? { withdrawn: true, why: "withdrawn" } : { withdrawn: false, why: "its card was no longer open" };
    },
    modelName: () => (taskModel ?? model).status().impl,
    canUseTools: () => Boolean((taskModel ?? model).step),
    now: clock,
    maxConcurrent: taskTurnsMax,
    followUps: { enabled: taskFollowUps?.enabled === true, globalPerDay: taskFollowUps?.globalPerDay ?? AUTO_GLOBAL_PER_DAY_DEFAULT },
  });
  // Restart recovery: a task turn recorded as running when ORBIT stopped is marked interrupted (never re-run), and so is an automatic
  // follow-up whose turn it was.
  try {
    for (const id of tasks.recover()) console.log(JSON.stringify({ at: clock().toISOString(), event: "task_turn_interrupted_by_restart", task: id }));
  } catch (e) {
    console.log(JSON.stringify({ at: clock().toISOString(), event: "task_recover_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "error" }));
  }
  // Repair 4: stored attention records are repaired once (acknowledged turn items resolved, stale request items resolved, history
  // pruned with a count). Idempotent; a failure changes nothing and every view applies the same rules read-only.
  try {
    const rep = tasks.repairAttention();
    if (rep.items) console.log(JSON.stringify({ at: clock().toISOString(), event: "task_attention_repaired", tasks: rep.tasks.length, items: rep.items }));
  } catch (e) {
    console.log(JSON.stringify({ at: clock().toISOString(), event: "task_attention_repair_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "error" }));
  }
  // The follow-up scheduler: created after recovery, so it never sees a turn the stop cut off as running. Off unless switched on.
  const followUps = taskScheduler({ tasks, supervisor, enabled: taskFollowUps?.enabled === true, globalPerDay: taskFollowUps?.globalPerDay ?? AUTO_GLOBAL_PER_DAY_DEFAULT, now: clock });
  taskFollowUps?.onScheduler?.(followUps);
  const taskOfThread = (tid: string) => {
    try {
      const t = tasks.byThread(tid);
      return t ? supervisor.view(t, "summary") : undefined;
    } catch {
      return undefined;
    }
  };

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
  // Runner events that arrived after an owner reconciliation (while ORBIT was down, too) are logged and reported once. main.ts repeats this
  // on its tick. Never changes a job.
  if (jobs) for (const l of recon.observe(jobs)) console.log(JSON.stringify({ at: clock().toISOString(), event: "launch_reconciliation_late_runner", job: l.job, after: l.after, contradicts: l.contradicts }));
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
      // The rolling summary: version, coverage, method, gaps and any deferral (docs/rolling-summaries.md, "Diagnostics"). Owner only.
      summary: summaries.view(),
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
  const baseMemory = memory;
  // `taskSession`: the turn runs in a task's session (supervised or interactive). Memory then goes through the task-scoped policy
  // (src/task-context.ts): the rolling recent-context note is never an automatic excerpt, a search hit or a readable note, and the vault
  // write tools refuse it as a target. Nothing else about the turn's tools or vault access changes.
  const prepare = async (isOwner: boolean, query: string, scope: "chat" | "assistant" = "chat", conversation?: string, o: { taskSession?: boolean } = {}) => {
    const memory = o.taskSession ? taskMemory(baseMemory) : baseMemory;
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
      ? [...refuseLegacyContext(withDuplicateWarning([...withLaneGuard(chatTools({ memory, toolbox: tools, ops, admin: adminOps, sys: sysOps, vault: vaultEdits, config: configView ? () => configView(statuses()) : undefined, jobs, notify, proposals, launchable }), () => researchLane().names, () => [...routines.keys()]), ...textReaderTools({ memory, jobs }), ...laneTools()], proposals, (brief) => (jobs ? findDuplicates(brief, jobs.all(), (j) => jobs.health(j)) : []))), ...(prInspect ?? []), ...(hostInventory ?? []), ...(workspace?.tools ?? []), ...(workspaceAdmin?.tools ?? []), ...(scope === "assistant" ? sessionTools(sessions, { caller: assistantSessionId(), isOwner }) : []), ...(conversation ? [...photoTools({ attachments, sources: photoSources, caller: conversation, isOwner, now: clock, zone: ZONE }), ...observationTools({ store: photoObservations, attachments, sources: observationSources, caller: conversation, isOwner, now: clock, zone: ZONE, onChange: semantic ? (ref) => semantic.invalidate(ref) : undefined }), ...(semantic ? [photoSearchTool({ semantic, attachments, caller: conversation, isOwner, zone: ZONE })] : [])] : [])]
      : [];
    if (o.taskSession) offered.splice(0, offered.length, ...taskScopedTools(offered));
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
    // Task attention put in front of this Assistant turn (Repair 4): marked delivered only when the turn completes (see the route).
    let taskDelivery: { task: string; ids: string[] }[] = [];
    if (scope === "assistant") {
      const d = decide("sessions", "digest", isOwner);
      if (d.allow) {
        audit("sessions", "digest", d);
        digest = sessionDigest(sessions, { isOwner });
      }
      // Supervised tasks: the supervisor's tools and the open tasks that need attention, Assistant scope and owner only (tasks port).
      const td = decide("tasks", "supervise", isOwner);
      if (td.allow) {
        audit("tasks", "supervise", td);
        if (offered.length) offered.push(...supervisor.assistantTools(isOwner));
        const act = supervisor.activity();
        taskDelivery = act.shown;
        if (act.block) digest = [digest, act.block].filter(Boolean).join("\n\n");
      }
    }
    return { notes, used, current, offered, digest, taskDelivery };
  };
  const allowAgent = (isOwner: boolean, scope: "chat" | "assistant" = "chat") => (tool: string) => {
    const decision = decide("agent", tool, isOwner);
    audit("agent", tool, decision);
    if (!decision.allow) return decision.reason;
    // Supervised tasks: the supervisor's tools are owner only (tasks port) and only inside the Assistant; a task's own tools are only
    // offered inside that task's turns, which use their own policy hook (src/task-supervisor.ts), so they are refused here.
    if (isTaskToolName(tool)) {
      if (!(TASK_ASSISTANT_TOOL_NAMES as readonly string[]).includes(tool)) return `${tool} is refused: it is only offered inside a task's own turn`;
      const second = decide("tasks", tool, isOwner);
      audit("tasks", tool, second);
      if (!second.allow) return second.reason;
      return scope === "assistant" ? undefined : `${tool} is refused: task supervision is only offered in the Assistant`;
    }
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
    const port = tool.startsWith("vault_") ? "vault" : tool === "orbit_config_view" ? "config" : (PR_INSPECT_TOOL_NAMES as readonly string[]).includes(tool) ? "pulls" : (WORKSPACE_TOOL_NAMES as readonly string[]).includes(tool) || (WORKSPACE_ADMIN_TOOL_NAMES as readonly string[]).includes(tool) ? "workspace" : undefined;
    if (port) {
      const second = decide(port, tool, isOwner);
      audit(port, tool, second);
      return second.allow ? undefined : second.reason;
    }
    return undefined;
  };

  // ---- The opt-in supervisor wake (src/task-wake.ts; Repair 4). Off unless the operator switched it on AND Rai opted in. One wake runs
  // one bounded Assistant turn as Rai's supervisor would: the same context (task-activity block, session digest), but only read-only
  // tools, the supervisor's answering tools and the launch PROPOSAL tools (a card still waits for Rai's Confirm), at most WAKE_MAX_ROUNDS
  // rounds, no paid fallback, its prompt stored and shown as "ORBIT supervisor wake", never as Rai. Attention it was shown is delivered
  // only if the turn completes.
  const WAKE_TOOL_NAMES: readonly string[] = ["task_respond", "task_attention_ack", "task_steer", "task_update", "job_launch", "research_launch"];
  const wakeTurn: WakeTurn = async (text) => {
    if (assistant.isBusy(ASSISTANT_ID)) return { notStarted: "the Assistant had a reply in progress" };
    const prep = await prepare(true, text, "assistant", assistantSessionId());
    if (assistant.isBusy(ASSISTANT_ID)) return { notStarted: "the Assistant had a reply in progress" };
    const tools = prep.offered.filter((t) => (t.readOnly === true && !(isTaskToolName(t.name) && !(TASK_ASSISTANT_TOOL_NAMES as readonly string[]).includes(t.name))) || WAKE_TOOL_NAMES.includes(t.name));
    const names = new Set(tools.map((t) => t.name));
    const withheld = prep.offered.filter((t) => !names.has(t.name)).map((t) => t.name);
    const base = allowAgent(true, "assistant");
    const allow = (tool: string) => (names.has(tool) ? base(tool) : `${tool} is refused: it is not offered in a supervisor wake turn`);
    const limits = [...prep.current, `supervisor wake turn (ORBIT started it, not Rai): at most ${WAKE_MAX_ROUNDS} tool rounds; no paid fallback; only read-only tools, the task answering tools and launch proposals are offered${withheld.length ? ` (withheld: ${withheld.slice(0, 30).join(", ")})` : ""}; you cannot approve, confirm or complete anything`];
    let out: Awaited<ReturnType<typeof asvc.turn>>;
    try {
      out = await asvc.turn(ASSISTANT_ID, text, { notes: [boundNotes(prep.notes), prep.digest].filter(Boolean).join("\n\n") || undefined, memory: prep.used, limits, tools, allow, isOwner: true, maxRounds: WAKE_MAX_ROUNDS, fallback: false, author: "orbit-wake" });
    } catch (e) {
      if (e instanceof ThreadError && e.code === 409) return { notStarted: "the Assistant had a reply in progress" };
      supervisor.undelivered(prep.taskDelivery, e instanceof Error ? e.message : "the wake turn failed");
      return { error: e instanceof Error ? e.message : "the wake turn failed" };
    }
    if (out.error) supervisor.undelivered(prep.taskDelivery, out.error);
    else supervisor.delivered(prep.taskDelivery);
    void summaries.roll().catch(() => undefined);
    const reply = [...(assistant.active().at(-1)?.messages ?? [])].reverse().find((m) => m.role === "assistant");
    return { ...(out.error ? { error: out.error } : {}), ...(reply?.text ? { reply: reply.text } : {}) };
  };
  const wake = supervisorWake({ tasks, backend: supervisorWakeArg?.backend ?? wakeFile(undefined), enabled: supervisorWakeArg?.enabled === true, assistantBusy: () => assistant.isBusy(ASSISTANT_ID), turn: wakeTurn, now: clock, ...(supervisorWakeArg?.minIntervalMs !== undefined ? { minIntervalMs: supervisorWakeArg.minIntervalMs } : {}) });
  try {
    for (const n of wake.recover()) console.log(JSON.stringify({ at: clock().toISOString(), event: "supervisor_wake_interrupted_by_restart", wake: n }));
  } catch (e) {
    console.log(JSON.stringify({ at: clock().toISOString(), event: "supervisor_wake_recover_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "error" }));
  }
  supervisorWakeArg?.onWake?.(wake);

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
        const protocolLog = (p: object) => console.log(JSON.stringify({ at: new Date().toISOString(), event: "model_protocol_text", route: "chat", ...p }));
        if (!offered.length) {
          const r = await model.reply(messages, current, notes);
          screenReply(r.value, r.fallback ? r.fallback.model : "primary", protocolLog);
          const reply = { ...r, answeredBy: answeredBy(model.status().impl, r.fallback) };
          return send(res, 200, { reply, memory: used, limits: current, calls: [], proposals: [] });
        }
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
          onProtocol: protocolLog,
        });
        const reply = { value: outcome.text || "(the model returned no text)", provenance: "live" as const, source: replySource(model.status().impl, outcome.fallback, outcome.mixed), ...(outcome.fallback ? { fallback: outcome.fallback } : {}), answeredBy: answeredBy(model.status().impl, outcome.fallback, outcome.mixed), ...(outcome.accounting?.length ? { accounting: outcome.accounting } : {}), ...(outcome.incomplete?.length ? { incomplete: outcome.incomplete } : {}) };
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
      // Repair 4: a task session carries its task's attention counts, so the Sessions list can badge it (owner only: this route is).
      let byThread: ReturnType<typeof supervisor.attentionByThread> | undefined;
      try {
        if (decide("tasks", "list", await isOwnerOf(req)).allow) byThread = supervisor.attentionByThread();
      } catch {
        byThread = undefined;
      }
      const list = threads.list(all).map((t) => {
        const a = byThread?.get(t.id);
        return a ? { ...t, task: a } : t;
      });
      return send(res, 200, { threads: list, notice: threads.notice() ?? null, persisted: threads.persisted, problems: threads.problems(), recentContext: recent.status() });
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
        if (!action) return send(res, 200, { thread: { ...svc.view(id), ...(taskOfThread(id) ? { task: taskOfThread(id) } : {}) } });
        const input = await body();
        if (!input) return;
        if (action === "rename") {
          threads.rename(id, input.title);
          return send(res, 200, { thread: svc.view(id) });
        }
        if (action === "archive") {
          const archived = input.archived !== false;
          threads.archive(id, archived);
          // Archiving a notable thread is a moment to refresh the rolling note. A task's session never feeds it: what a task did reaches
          // other conversations only through the supervisor's own tools (docs/adr/0003-supervised-tasks.md, "Isolation").
          if (archived && !taskOfThread(id)) recent.consider(id, { force: true, isOwner: callerIsOwner });
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
        // A task's session: Rai's message is admitted by the task record and answered with the task's context (src/task-supervisor.ts
        // humanTurn), with the task-scoped memory policy (src/task-context.ts). Any other thread: an ordinary chat turn, unchanged. A task
        // store that cannot be read makes a task's session fail closed rather than answer as an ordinary chat without the policy.
        let task: ReturnType<typeof tasks.byThread>;
        try {
          task = tasks.byThread(id);
        } catch (err) {
          const th = threads.get(id);
          const taskSession = th?.taskSession === true || /^Task: /.test(th?.title ?? "");
          if (!taskSession) task = undefined;
          else if (err instanceof TaskError) return send(res, err.code, { error: `This is a task's session and ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)} Nothing was sent.` });
          else throw err;
        }
        const prep = await prepare(callerIsOwner, text, "chat", chatSessionId(id), { taskSession: Boolean(task) });
        const photos = photosOf(input, chatScope(id));
        if (!photos) return;
        let out;
        try {
          const base = { notes: prep.notes, memory: prep.used, limits: prep.current, tools: prep.offered, allow: allowAgent(callerIsOwner), isOwner: callerIsOwner, ...(photos.refs.length ? { attachments: photos.refs } : {}) };
          out = task ? await supervisor.humanTurn(task.id, text, base) : await svc.turn(id, text, base);
        } catch (err) {
          photos.release(() => hasRefs(threads.get(id)?.messages ?? [], photos.refs));
          if (err instanceof TaskError) return send(res, err.code, { error: err.message });
          throw err;
        }
        const linked = taskOfThread(id);
        return send(res, out.error ? 502 : 200, { thread: { ...out.thread, ...(linked ? { task: linked } : {}) }, limits: prep.current, ...(out.error ? { error: out.error } : {}) });
      } catch (err) {
        return threadFail(err);
      }
    }

    // ---- Supervised tasks (owner only, every route; docs/adr/0003-supervised-tasks.md). Rai's own actions: list, inspect, create,
    // steer, pause, resume, cancel, run one turn, attest evidence, answer a request, sync to the vault, and mark done (evidence-gated).
    // Every mutation names the rev it was based on; a stale one is refused (409) and changes nothing.
    // Repair 4: the attention summary for the pages (badges, the Assistant page's list), and Rai's controls for the supervisor wake.
    if (url.pathname === "/tasks/attention" || url.pathname === "/tasks/wake" || url.pathname === "/tasks/wake/pause") {
      const action = url.pathname === "/tasks/attention" ? "attention-summary" : url.pathname === "/tasks/wake" ? (req.method === "POST" ? "wake-set" : "wake") : "wake-pause";
      const method = action === "attention-summary" || action === "wake" ? "GET" : "POST";
      if (req.method !== method) return send(res, 405, { error: `Use ${method} for this route.` });
      if (!(await owned("tasks", action))) return;
      try {
        if (action === "attention-summary") return send(res, 200, { ...supervisor.attentionSummary(), wake: wake.view() });
        if (action === "wake") return send(res, 200, { wake: wake.view() });
        const input = await body();
        if (!input) return;
        const human: Provenance = { actor: "human", via: "task-panel" };
        if (typeof input.enabled !== "boolean" && action === "wake-set") return send(res, 400, { error: "Send {enabled: true|false, perDay?}." });
        if (typeof input.paused !== "boolean" && action === "wake-pause") return send(res, 400, { error: "Send {paused: true|false, reason?}." });
        const r = action === "wake-set" ? wake.setOptIn(input.enabled as boolean, human, input.perDay) : wake.setPaused(input.paused as boolean, human, input.reason);
        return send(res, 200, { changed: r.changed, wake: r.view });
      } catch (err) {
        if (err instanceof TaskError) return send(res, err.code, { error: err.message });
        throw err;
      }
    }
    const taskMatch = url.pathname === "/tasks/projects" ? null : url.pathname.match(/^\/tasks\/([^/]{1,80})(?:\/(steer|pause|resume|cancel|turn|complete|evidence|respond|sync|follow-up|update|attention))?$/);
    if (url.pathname === "/tasks" || url.pathname === "/tasks/projects" || taskMatch) {
      const action = url.pathname === "/tasks/projects" ? "projects" : taskMatch ? (taskMatch[2] ?? "inspect") : req.method === "POST" ? "create" : "list";
      const method = action === "list" || action === "inspect" || action === "projects" ? "GET" : "POST";
      if (req.method !== method) return send(res, 405, { error: `Use ${method} for this route.` });
      if (!(await owned("tasks", action))) return;
      const human: Provenance = { actor: "human", via: "task-panel" };
      try {
        if (action === "list") return send(res, 200, { tasks: tasks.all().map((t) => supervisor.view(t, "summary")), status: tasks.status(), turnsRunning: supervisor.runningCount(), routing: taskRoutes.describe(), wake: wake.view() });
        // Read-only reconciliation by project (Repair 3): writes nothing, syncs nothing.
        if (action === "projects") return send(res, 200, supervisor.projectStatus({ project: url.searchParams.get("project") ?? undefined, includeClosed: url.searchParams.get("closed") === "1" }));
        if (action === "create") {
          const input = await body();
          if (!input) return;
          const parsed = parseCreate(input as never, clock());
          const r = tasks.create(parsed, { actor: "human", via: "api" }, () => threads.create(`Task: ${parsed.title}`, { taskSession: true }).id);
          return send(res, r.duplicate ? 200 : 201, { task: supervisor.view(r.task), duplicate: r.duplicate });
        }
        const id = taskMatch![1]!;
        if (!isTaskId(id) || !tasks.get(id)) return send(res, 404, { error: "No task with that id." });
        if (action === "inspect") return send(res, 200, { task: supervisor.view(tasks.get(id)!) });
        const input = await body();
        if (!input) return;
        // Acknowledging an attention item is bookkeeping about the item, not a change to the task, so it needs no rev (Repair 3).
        if (action === "attention") {
          const r = tasks.acknowledge(id, input.attention, human, input.note);
          return send(res, 200, { task: supervisor.view(r.task), attention: r.item.id, state: r.item.state, duplicate: r.duplicate });
        }
        const rev = tasks.requireRev(input.rev);
        const key = typeof input.requestId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(input.requestId) ? `owner:${input.requestId}` : undefined;
        if (action === "steer") {
          const r = tasks.steer(id, rev, input.text, human, key);
          return send(res, r.duplicate ? 200 : 201, { task: supervisor.view(r.task), instruction: r.instruction.v, duplicate: r.duplicate });
        }
        if (action === "pause" || action === "resume" || action === "cancel") {
          const r = supervisor.setLifecycle(id, rev, action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled", human, input.reason);
          return send(res, 200, { task: supervisor.view(r.task), stoppedRunningTurn: r.stoppedRunningTurn, ...("cancellation" in r ? { cancellation: r.cancellation } : {}) });
        }
        if (action === "turn") {
          const r = await supervisor.startTurn(id, { trigger: human, isOwner: true, expectRev: rev, key });
          return send(res, r.duplicate ? 200 : 202, { task: supervisor.view(tasks.get(id)!), turn: r.turn.n, duplicate: r.duplicate, note: "The turn runs in the task's session; its outcome is not known yet." });
        }
        if (action === "complete") return send(res, 200, { task: supervisor.view(tasks.complete(id, rev, human, taskObservers)) });
        // Rai's per-task opt-in to automatic follow-up (on or off). Only this owner route can turn it on.
        if (action === "follow-up") {
          if (typeof input.enabled !== "boolean") return send(res, 400, { error: "Send {rev, enabled: true|false, perDay?}." });
          const r = tasks.setAutoDetailed(id, rev, input.enabled, human, input.perDay);
          return send(res, 200, { task: supervisor.view(r.task), changed: r.changed, ...(r.ignored.length ? { ignored: r.ignored, note: "perDay is not used when turning automatic follow-up off; it was neither checked nor applied." } : {}) });
        }
        // Rai's own edit of the task's plan (Repair 3): next action, follow-up time, project, vault link, dependencies, automatic
        // follow-up off. One atomic change; turning off what is already off changes nothing.
        if (action === "update") {
          const pick = (k: string) => (input[k] === undefined ? undefined : input[k]);
          const r = tasks.updateDetailed(id, rev, { nextAction: pick("nextAction"), followUpAt: pick("followUpAt"), followUpNote: pick("followUpNote"), project: pick("project"), vaultNote: pick("vaultNote"), vaultHeading: pick("vaultHeading"), dependsOn: pick("dependsOn"), autoFollowUp: pick("autoFollowUp") }, human);
          return send(res, 200, { task: supervisor.view(r.task), changed: r.changed, ...(r.notes.length ? { notes: r.notes } : {}) });
        }
        if (action === "evidence") {
          const r = tasks.addEvidence(id, input as { criterion: unknown; kind: unknown; ref: unknown }, human, rev);
          return send(res, r.duplicate ? 200 : 201, { task: supervisor.view(r.task), evidence: r.evidence.id, duplicate: r.duplicate });
        }
        if (action === "respond") {
          const r = supervisor.respond(id, rev, input, human);
          return send(res, 200, { task: supervisor.view(r.task), request: r.request.id, duplicate: Boolean(r.duplicate) });
        }
        const r = await tasksVault.sync(id);
        return send(res, r.state === "failed" || r.state === "blocked" || r.state === "unknown" ? 502 : 200, { task: supervisor.view(tasks.get(id)!), sync: r });
      } catch (err) {
        if (err instanceof TaskError) return send(res, err.code, { error: err.message });
        throw err;
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
        // Set immediately before the turn, which takes the conversation at once; the only await before its first write (the rolling-summary
        // roll) runs while the turn holds it, so no other send can start a turn or take this id meanwhile.
        assistant.expectRequest(requestId);
        let out: Awaited<ReturnType<typeof asvc.turn>>;
        try {
          out = await asvc.turn(ASSISTANT_ID, text, { notes: [boundNotes(prep.notes), prep.digest].filter(Boolean).join("\n\n") || undefined, memory: prep.used, limits: prep.current, tools: prep.offered, allow: allowAgent(callerIsOwner, "assistant"), isOwner: callerIsOwner, ...(photos.refs.length ? { attachments: photos.refs } : {}) });
        } catch (e) {
          supervisor.undelivered(prep.taskDelivery, e instanceof Error ? e.message : "the Assistant turn failed");
          throw e;
        }
        // Repair 4: task attention counts as delivered only when the turn that carried it completed.
        if (out.error) supervisor.undelivered(prep.taskDelivery, out.error);
        else supervisor.delivered(prep.taskDelivery);
        // The turn's end may have rolled the page (archived chunks): summarize them now, in the background, so the next turn rarely waits.
        // The next turn's own roll waits for this one (rolls are serialized). Failures are reported in the summary block, never thrown.
        void summaries.roll().catch(() => undefined);
        return send(res, out.error ? 502 : 200, { assistant: assistantView(), limits: prep.current, ...(out.error ? { error: out.error } : {}) });
      } catch (err) {
        assistant.expectRequest(undefined);
        const bound = assistantPhotos;
        bound?.release(() => hasRefs(assistant.active().flatMap((c) => c.messages), bound.refs));
        if (err instanceof ThreadError) return send(res, err.code, { error: err.message, ...(err.code === 409 ? { assistant: assistantView() } : {}) });
        return send(res, 500, { error: "Could not save the Assistant conversation. Nothing more was changed." });
      }
    }

    // ---- The left sidebar (docs/sidebar.md): GET only, owner only. Projects, plan and files come from the vault snapshot memory
    // search reads (read-only, masked); the images are the photos the Assistant may show (every owner conversation that still
    // exists, archived ones aside), each fetched through /assistant/photos/<ref>, which re-authorizes it. A vault that cannot be
    // read is reported in `vault.error` with the photos still listed; nothing is made up in its place.
    if (url.pathname === "/sidebar" || url.pathname === "/sidebar/note" || url.pathname === "/sidebar/project") {
      if (req.method !== "GET") return send(res, 405, { error: "Use GET for this route." });
      if (!(await owned("memory", "read"))) return;
      await memory.refresh?.(60_000);
      let notes: ReadonlyMap<string, string> | undefined;
      let source: string | undefined;
      let vaultError: string | undefined;
      try {
        if (!memory.notes) throw new Error("this vault copy cannot list its notes");
        const r = memory.notes();
        notes = r.value;
        source = r.source;
      } catch (err) {
        vaultError = `The vault could not be read: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (url.pathname === "/sidebar/note") {
        if (!notes) return send(res, 503, { error: vaultError });
        const note = sidebarNote(notes, url.searchParams.get("path") ?? "");
        return note ? send(res, 200, { note, source }) : send(res, 404, { error: "No such note in the vault." });
      }
      // One project's Plan detail (docs/plan.md): read from its hub note and the tasks that name it.
      if (url.pathname === "/sidebar/project") {
        if (!notes) return send(res, 503, { error: vaultError });
        const project = projectDetail(notes, url.searchParams.get("id") ?? "");
        return project ? send(res, 200, { project, today: dayIn(new Date()), source }) : send(res, 404, { error: "No such project in the vault (Projects/)." });
      }
      let photos: SidebarPhoto[] = [];
      let photoError: string | undefined;
      const ownerCall = await isOwnerOf(req);
      // Listing photos across conversations is attachment reading and session reading (as for the photo tools); both are audited.
      const photoRead = decide("attachments", "read", ownerCall);
      audit("attachments", "read", photoRead);
      const sessionRead = photoRead.allow ? decide("sessions", "read", ownerCall) : undefined;
      if (sessionRead) audit("sessions", "read", sessionRead);
      if (photoRead.allow && sessionRead?.allow) {
        try {
          photos = reachablePhotos({ attachments, sources: photoSources }, assistantSessionId(), false).photos.map((l) => ({
            ref: l.ref,
            sentAt: l.sentAt,
            sentLocal: localTime(l.sentAt, ZONE),
            caption: l.message?.caption ?? "",
            conversation: { id: l.conversation.id, kind: l.conversation.kind, title: l.conversation.title },
            present: attachments.present(l.meta.id, l.meta.scope),
          }));
        } catch {
          photoError = "The photos could not be listed.";
        }
      }
      const project = url.searchParams.get("project") || undefined;
      return send(res, 200, { ...sidebarView(notes, photos, project), overview: planOverview(notes), vault: notes ? { ok: true, source } : { ok: false, error: vaultError }, ...(photoError ? { photoError } : {}) });
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
    const dismiss = url.pathname.match(/^\/notifications\/([0-9a-f-]+)\/dismiss$/);
    if (dismiss && req.method === "POST") {
      if (!(await owned("notify", "dismiss"))) return;
      // Kept in ORBIT's notification store, so `current` leaves the note out on every page, device and restart.
      // Repeating a dismissal is safe: the first one stands and the note is returned unchanged.
      const n = notify.dismiss(dismiss[1]);
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
      // The Jobs page list: every stored job, searched, filtered and paged with a cursor (src/job-detail.ts).
      if (url.searchParams.get("view") === "rows") return send(res, 200, listRows(jobs.all(), (j) => jobs.health(j), commit, parseRowQuery(url.searchParams)));
      return send(res, 200, { jobs: jobs.list().map((j) => withHealth({ ...j, ...(j.summary ? { summary: { ...j.summary, text: "" } } : {}), ...(j.launch?.dispatch ? { launch: { ...j.launch, dispatch: { ...j.launch.dispatch, brief: { ...j.launch.dispatch.brief, text: "" } } } } : {}) })) });
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
    if ((jobs || adminOps || sysOps || workspace?.enabled || workspaceAdmin) && url.pathname === "/chat/proposals" && req.method === "GET") {
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
    if ((jobs || adminOps || sysOps || vaultEdits || workspace?.enabled || workspaceAdmin) && proposalMatch && req.method === "POST") {
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
      if (open?.kind === "workspace_op" && confirming) {
        // A workspace write, patch or command (docs/workspace-tools.md, "Confirmation"). Owner only through its own policy port, bound to
        // the digest of the exact canonical operation shown on the card; a wrong or missing digest changes nothing and leaves it open.
        // The card must belong to the conversation the proposal was made in. Single use (take + card compare-and-set); the backend then
        // re-checks the workspace identity, preconditions, snapshot and sandbox policy before anything runs.
        if (!(await owned("workspace", "confirm"))) return;
        const input = await body();
        if (!input) return;
        if (input.digest !== open.digest) return send(res, 409, { error: "The confirmation does not match this proposal's digest. Nothing was done." });
        // ws_* are the named activation operations (setup, validate, enable, disable, revoke): they exist before the tools are on.
        const adminOp = Boolean(workspaceAdmin?.owns(open.action));
        if (adminOp ? !workspaceAdmin : !workspace?.enabled) return send(res, 503, { error: "Workspace tools are not enabled." });
        if ("conflict" in originOf(open)) return send(res, 409, { error: "This proposal's recorded conversation does not match the conversation that stores its card. Nothing was done." });
        const taken = proposals.take(open.id);
        if (!taken || taken.kind !== "workspace_op") return send(res, 404, gone);
        if (!claimed(taken.id, "confirmed")) return alreadyUsed();
        audit("workspace", `confirm:${taken.action}`, { allow: true, reason: `owner confirmed proposal ${taken.id} (digest ${taken.digest.slice(7, 19)})` });
        const result = adminOp ? await workspaceAdmin!.confirm(taken) : await workspace!.confirm(taken);
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
          plan = work.plan(input.attach, origin, jobsReader, (j) => recon.view(j));
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
        if (proposal.kind === "workspace_op") (workspaceAdmin?.owns(proposal.action) ? workspaceAdmin.cancelled(proposal.id) : workspace?.cancelled(proposal.id));
        return send(res, 200, { cancelled: proposal.id });
      }
      if (proposal.kind === "ops_admin" || proposal.kind === "ops_sys") return send(res, 409, { error: "Not confirmed: server operations need their digest." });
      if (proposal.kind === "vault_edit") return send(res, 409, { error: "Not confirmed: a vault edit needs its digest." });
      if (proposal.kind === "workspace_op") return send(res, 409, { error: "Not confirmed: a workspace operation needs its digest." });
      if (!jobs) return send(res, 503, { error: "Jobs are not enabled." });
      if (!claimed(proposal.id, "confirmed")) return alreadyUsed();
      if (proposal.kind === "job_steer") {
        const steer = jobs.steer(proposal.job, proposal.text, { source: "proposal", proposal: proposal.id });
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
    const jobMatch = url.pathname.match(/^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(\/steer|\/events)?$/);
    if (jobs && jobMatch && req.method === "GET" && !jobMatch[2]) {
      if (!(await owned("jobs", "get"))) return;
      const job = jobs.get(jobMatch[1]);
      if (!job) return send(res, 404, { error: "No job with that id." });
      // The Jobs page's detail: sections, links, inputs and the newest page of events (src/job-detail.ts). Without `view` the raw record.
      if (url.searchParams.get("view") === "detail") {
        const openSteers = proposals.list().filter((p): p is typeof p & OpenSteerProposal => p.kind === "job_steer" && p.job === job.id);
        return send(res, 200, { ...jobDetail(job, jobs.health(job), { all: jobs.all(), routineRepo: job.launch ? research?.routineRepos?.get(job.launch.routine) : undefined, running: commit, alertDelivery: callbackAlertDelivery }, openSteers), reconciliation: reconView(job) });
      }
      return send(res, 200, withHealth(job));
    }
    // Older events of a job, newest first, from before the `before` sequence number; `next` continues further back.
    if (jobs && jobMatch && req.method === "GET" && jobMatch[2] === "/events") {
      if (!(await owned("jobs", "get"))) return;
      const job = jobs.get(jobMatch[1]);
      if (!job) return send(res, 404, { error: "No job with that id." });
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? EVENTS_DEFAULT);
      if (before !== null && !/^\d{1,9}$/.test(before)) return send(res, 400, { error: "before is an event sequence number." });
      return send(res, 200, eventsPage(job, before === null ? undefined : Number(before), Number.isInteger(limit) ? limit : EVENTS_DEFAULT));
    }
    // Owner reconciliation of an unresolved launch (src/launch-reconciliation.ts, docs/reviews/launch-reconciliation.md section 9).
    // GET: the reading and the full history. POST without `confirm`: a preview (what the entry means and does not mean) and its digest;
    // nothing is written. POST with `confirm: <digest>`: the entry is appended. Never changes the job record; never launches, retries,
    // cancels or calls the provider. The model has no tool for this.
    const reconMatch = url.pathname.match(/^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/reconcile$/);
    if (jobs && reconMatch && (req.method === "GET" || req.method === "POST")) {
      if (!(await owned("jobs", req.method === "GET" ? "get" : "reconcile"))) return;
      const id = reconMatch[1];
      const job = jobs.get(id);
      try {
        if (req.method === "GET") {
          // A job that left the job store (it keeps the newest 200) still has its history here.
          if (!job) {
            const entries = recon.entries(id);
            return entries.length ? send(res, 200, { job: id, inJobStore: false, entries }) : send(res, 404, { error: "No job with that id." });
          }
          return send(res, 200, { job: id, inJobStore: true, dispatch: dispatchEvidence(job), reconciliation: recon.view(job) });
        }
        if (!job) return send(res, 404, { error: "No job with that id. Nothing was recorded." });
        const input = await body();
        if (!input) return;
        const { confirm, ...request } = input;
        if (confirm === undefined) return send(res, 200, { preview: recon.preview(job, request), confirmWith: "POST the same body again with confirm set to preview.digest" });
        const done = recon.confirm(job, request, confirm);
        audit("jobs", `reconcile:${done.entry.kind}`, { allow: true, reason: `owner ${done.repeated ? "repeated" : "confirmed"} reconciliation entry ${done.entry.seq} for ${id} (digest ${done.entry.digest.slice(0, 12)})` });
        return send(res, done.repeated ? 200 : 201, { entry: done.entry, repeated: done.repeated, reconciliation: recon.view(job) });
      } catch (e) {
        if (e instanceof ReconcileError) return send(res, e.code, { error: e.message });
        throw e;
      }
    }
    if (jobs && jobMatch && req.method === "POST" && jobMatch[2] === "/steer") {
      if (!(await owned("jobs", "steer"))) return;
      const input = await body();
      if (!input) return;
      if (typeof input.text !== "string" || !input.text.trim()) return send(res, 400, { error: "A steer needs text." });
      const steer = jobs.steer(jobMatch[1], input.text.trim(), { source: "owner" });
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
  // The follow-up scheduler ticks only while the server listens, and only when switched on.
  server.once("listening", () => {
    followUps.start(taskFollowUps?.tickMs);
    wake.start(supervisorWakeArg?.tickMs);
  });
  server.once("close", () => {
    followUps.stop();
    wake.stop();
  });
  return server;
}

// Photo capability for /status: what the running process would do with a photo now, and why. Model id, capability, source and
// freshness only: no evidence prose, no credentials. orbit_config_view has the full resolution for the owner.
export function photoStatus(model: ModelPort) {
  const s = model.images?.();
  if (!s) return { ok: false, capability: "unknown", blocking: "blocked locally: the connected model adapter does not take photos" };
  return { ok: s.ok, capability: s.capability ?? (s.ok ? "supported" : "unknown"), ...(s.resolution ? resolutionSummary(s.resolution) : {}), blocking: s.ok ? undefined : `blocked locally: ${s.detail.slice(0, 300)}` };
}
