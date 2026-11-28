import { existsSync, readFileSync } from "node:fs";
import { tailscaleIdentify } from "./identity.ts";
import { PERSONA, personaModelText } from "./persona.ts";
import { discordBotSink, discordChannel, discordOffStatus, selectDiscordChannel } from "./discord.ts";
import type { DiscordChannel } from "./discord.ts";
import { buildIngress } from "./ingress.ts";
import { jobLauncher } from "./job-launch.ts";
import { jobSecret, jobs as jobRegistry } from "./jobs.ts";
import { gitReconciler, selectControl, selectRoutines } from "./launcher.ts";
import { selectMemory } from "./memory.ts";
import { chatgptModel, tokenFile } from "./chatgpt.ts";
import { proposals as newProposals } from "./agent.ts";
import { autoFixConfig, autoFixer, autoFixStartupLog, selectPrHealth } from "./auto-fix.ts";
import { fallbackModel } from "./fallback.ts";
import { modelHealthTracker, observeModel } from "./model-health.ts";
import type { ModelHealth } from "./model-health.ts";
import { selectModel } from "./model.ts";
import { openrouterConfig, openrouterStartupLog, spendCapsOf } from "./openrouter.ts";
import { SpendError, spendLedger } from "./spend-ledger.ts";
import { nodes as devicePresence, tailscaleStatus } from "./nodes.ts";
import { notifier, selectDiscord } from "./notify.ts";
import { adminOps } from "./ops-admin.ts";
import { adminClient } from "./ops-admin-client.ts";
import { jobStateOf, sysOps } from "./ops-sys.ts";
import { sysClient } from "./ops-sys-client.ts";
import { hostInventoryEnabled, hostInventoryTool } from "./host-inventory.ts";
import { opsClient } from "./ops-client.ts";
import { MOCK_PORT_NAMES, mockPort } from "./ports.ts";
import type { Port } from "./ports.ts";
import { selectPrInspect } from "./pr-inspect.ts";
import { parseRoutineRepos, pullRequestOpener, selectPulls } from "./pull-requests.ts";
import { reviewer, selectComments } from "./review.ts";
import { loadResearchTool, researchCompletion, researchStore, selectResearchLane } from "./research.ts";
import { memoryReport, modelTask, runner, toolCall } from "./runs.ts";
import { scheduler } from "./schedule.ts";
import { buildServer } from "./server.ts";
import { stateRecentContext, vaultRecentContext } from "./recent-context.ts";
import { credentialFile, DEFAULT_REMOTE, vaultClone } from "./vault/clone.ts";
import { vaultEdits as newVaultEdits } from "./vault/tools.ts";
import { configView } from "./config-view.ts";
import { decide } from "./policy.ts";
import { jsonStore } from "./store.ts";
import { threadStore } from "./threads.ts";
import { attachmentStore } from "./attachments.ts";
import { observationStore } from "./photo-observations.ts";
import { importLedger } from "./photo-import-ledger.ts";
import { embeddingBudget, embeddingsConfig, embeddingsStatus, openaiEmbedder } from "./embeddings.ts";
import { workFile, workSessions } from "./work-sessions.ts";
import { taskFile, taskStore } from "./tasks.ts";
import { cloneTaskVault } from "./task-vault.ts";
import { wakeFile } from "./task-wake.ts";
import { launchReconciliations, reconFile } from "./launch-reconciliation.ts";
import { join } from "node:path";
import { watcher } from "./watch.ts";
import { githubRepoStatus, toolbox } from "./tools.ts";
import { processIdentity, smokeRunner } from "./smoke.ts";
import { orbitSmokeChecks } from "./smoke-checks.ts";
import { selectWorkspace } from "./workspace/select.ts";
import { wsHostClient } from "./ops-ws-client.ts";
import { WS_SOCKET_PATH } from "./ops/ws-protocol.ts";

const port = Number(process.env.PORT ?? PERSONA.port);
const host = process.env.HOST ?? "127.0.0.1";
const commit = process.env.ORBIT_COMMIT ?? "unknown";
const deployState = process.env.ORBIT_DEPLOY_STATE;

function readDeploy(): unknown {
  if (!deployState) return { state: "unknown", detail: "No deploy state file is configured." };
  try {
    return JSON.parse(readFileSync(deployState, "utf8"));
  } catch {
    return { state: "unknown", detail: `Could not read ${deployState}.` };
  }
}

// systemd sets STATE_DIRECTORY from StateDirectory=orbit. Without it, state is in memory and /status says so.
const stateDir = process.env.STATE_DIRECTORY;
const chatgpt: { current?: ReturnType<typeof chatgptModel> } = {};
const primaryModel = selectModel(process.env, (name) => (chatgpt.current = chatgptModel(name, tokenFile(stateDir), { capabilities: { operatorFile: process.env.ORBIT_MODEL_CAPABILITIES || undefined } })));
// The OpenRouter fallback is off unless ORBIT_OPENROUTER_ENABLED=1 and its model, prices and orbit.openrouter credential are all set.
// Disabled, the primary model is used as it is, untouched.
const openrouter = openrouterConfig(process.env);
// A ledger that cannot be built (bad caps) must not stop ORBIT starting: the fallback is then reported as unavailable.
let openrouterLedger: ReturnType<typeof spendLedger> | undefined;
let openrouterEffective = openrouter;
if (openrouter.state === "ready" && stateDir) {
  try {
    openrouterLedger = spendLedger(stateDir, spendCapsOf(openrouter));
    // The one explicit, startup-time initialisation. It charges reservations left by a process that is proven gone and retires a used
    // provision request. It creates a missing ledger ONLY when the owner deliberately asked for it (docs/openrouter-ledger-integrity.md);
    // otherwise a missing ledger stays missing and /status says NOT armed. /status only observes (src/fallback.ts) and never does any of
    // this. A failure is not fatal and not hidden: /status reports the fallback as NOT armed while the ledger cannot be used.
    try {
      openrouterLedger.open();
    } catch (err) {
      const code = err instanceof SpendError ? err.code : "error";
      console.error(JSON.stringify({ at: new Date().toISOString(), openrouter: `the spend ledger could not be opened at startup (${code}); no paid call will be made until it is fixed or provisioned` }));
    }
  } catch (err) {
    openrouterEffective = { state: "unavailable", reason: `The spend ledger could not be set up: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}
// Checked once at startup: the journal says whether the fallback is off, armed, or unusable and why (never the key).
console.log(openrouterStartupLog(openrouterEffective));
const builtModel = openrouterEffective.state === "disabled" ? primaryModel : fallbackModel({ primary: primaryModel, config: openrouterEffective, ledger: openrouterLedger });
// Model health (docs/model-health.md): whether the PRIMARY model is answering or ORBIT is in fallback, from the post-deploy model smoke
// check and every real call. The watch reads it before sending a "model is live again" notice. <state>/model-health.json.
const modelHealth = modelHealthTracker(jsonStore<ModelHealth | null>(stateDir, "model-health", null));
const model = observeModel(builtModel, modelHealth);
// The writable vault clone needs a state directory and the orbit.github-vault credential (read when used, never cached). Without
// either, memory reads the read-only server copy and no vault write tool is offered; /status and the tool results say so.
const vaultRemote = process.env.ORBIT_VAULT_REMOTE || DEFAULT_REMOTE;
const vault = stateDir && vaultRemote
  ? vaultClone({ dir: join(stateDir, "vault-clone"), remote: vaultRemote, branch: process.env.ORBIT_VAULT_BRANCH || undefined, credential: credentialFile(process.env), onChange: () => memory.invalidate?.() })
  : undefined;
const memory = selectMemory(process.env, vault);
// Notifications go to Discord through the webhook when one is installed (ORBIT), otherwise through the instance's own bot in its
// channel (src/discord.ts discordBotSink), otherwise nowhere but the web page.
const discordSelection = selectDiscordChannel(process.env, PERSONA);
const notify = notifier(jsonStore(stateDir, "notifications", []), selectDiscord(process.env) ?? ("config" in discordSelection ? discordBotSink(discordSelection.config, { rewrite: (t) => personaModelText(t) }) : undefined));
const tools = toolbox([githubRepoStatus()]);
const ops = opsClient();
// Server operations (tier 2): proposals need the owner's confirmation; the ledger is persisted so results survive a restart.
const proposals = newProposals();
const admin = adminOps({ client: adminClient(), store: jsonStore(stateDir, "ops-admin", []), notify, proposals });
const owner = process.env.ORBIT_OWNER || undefined;
const vaultEdits = vault ? newVaultEdits({ clone: vault, memory, proposals }) : undefined;
// Workspace filesystem and sandboxed exec tools (docs/workspace-tools.md): off unless ORBIT_WORKSPACE_TOOLS=enabled and the operator's
// workspaces file acknowledges the pre-activation checklist. Every proposal, confirmation, denial, invocation, result and cancellation
// is an audit line (metadata only: ids, digests, states; never file contents or command output).
const workspace = selectWorkspace(process.env, {
  stateDir,
  proposals,
  protectedPaths: [stateDir ?? "", process.env.CREDENTIALS_DIRECTORY ?? "", process.env.ORBIT_VAULT ?? "/opt/orbit/vault", "/opt/orbit", "/etc/credstore"],
  audit: (e) => console.log(JSON.stringify(e)),
  // The named activation operations (docs/workspace-tools.md, "Activation"): host setup goes through the separately installed root
  // helper orbit-ops-ws (docs/orbit-ops-ws.md); its operations are persisted so their results survive the restart the setup causes.
  host: wsHostClient(),
  hostStore: jsonStore(stateDir, "workspace-host-ops", []),
  hostHelperPresent: () => existsSync(WS_SOCKET_PATH),
  notify: (text) => notify.send(text, true),
});
console.log(`workspace-tools: ${workspace.activation.state}${workspace.activation.state === "enabled" ? ` (host permits them; owner switch ${workspace.owner.mode()})` : ` (${workspace.activation.reason})`}`);
const config = configView({ env: process.env, ops, commit, vaultPolicy: vault ? () => vault.policyCheck() : undefined, photos: () => model.images?.() });
// Startup: sync the vault clone once now (the tick's refresh shares this run) so the vault AGENTS.md is hashed and compared with the
// baseline the coded rules were written against; drift or an unavailable AGENTS.md is logged here and shown in the config view.
if (vault && vault.credentialPresent()) {
  const report = () => console.log(JSON.stringify({ at: new Date().toISOString(), port: "vault", action: "policy-check", ...vault.policyCheck() }));
  void vault.sync().then(report, report);
}
const nodes = devicePresence(tailscaleStatus(), owner);
const jobs = jobRegistry(jsonStore(stateDir, "jobs-cloud", []), jobSecret(stateDir), notify);
// Tier 3 (OS updates, reboot, orbit-jobs Funnel): separate socket, separate ledger, a separate confirmation for every action.
const sys = sysOps({
  client: sysClient(),
  store: jsonStore(stateDir, "ops-sys", []),
  notify,
  proposals,
  jobState: jobStateOf(jobs),
  jobsTarget: () => {
    const url = process.env.ORBIT_PUBLIC_JOB_URL;
    const port = Number(process.env.ORBIT_INGRESS_PORT);
    try {
      return url && Number.isInteger(port) ? { host: new URL(url).hostname, port } : undefined;
    } catch {
      return undefined;
    }
  },
});
const watch = watcher(jsonStore(stateDir, "watch", { ports: {} }), notify, () => new Date(), jobs, { modelRecovery: modelHealth.confirmsRecovery });
const control = selectControl(process.env);
const routines = selectRoutines(process.env);
const publicJobUrl = process.env.ORBIT_PUBLIC_JOB_URL || undefined;
// The research lane (docs/research-lane.md): its own Routine(s) and credential(s), fails closed when absent or ambiguous. Reports are
// stored in <state>/research; completion never opens a PR, starts a review, writes orbit-work or launches anything.
const routineRepos = parseRoutineRepos(process.env.ORBIT_ROUTINE_REPOS);
const researchLane = selectResearchLane(process.env, { routineRepos });
const researchReports = researchStore(stateDir ? join(stateDir, "research") : undefined);
const researchTool = loadResearchTool();
if (researchLane.state === "misconfigured") console.error(JSON.stringify({ at: new Date().toISOString(), research: researchLane.reason }));
researchCompletion({ jobs, store: researchReports, notify, control });
// ORBIT starts reviews itself, from a PR it just opened: not a chat tool call, so no confirmation is needed.
const review = reviewer(jobs, jobLauncher({ jobs, control, routines, notify, publicJobUrl, commit }), selectComments(process.env), notify);
const prs = pullRequestOpener(jobs, parseRoutineRepos(process.env.ORBIT_ROUTINE_REPOS), selectPulls(process.env), notify, () => new Date(), (job, url, headSha) => void review.start(job, url, headSha), selectComments(process.env));
const reconcile = control ? gitReconciler(jobs, control) : async () => {};
// Auto-fix proposals (docs/auto-fix.md): after a PR's review settles, a failed check or a merge conflict becomes a fix-job PROPOSAL on the
// Jobs page; Rai confirms it like any launch. ORBIT_AUTO_FIX_ENABLED=false turns it off; ORBIT_AUTO_FIX_MAX_RETRIES caps each chain.
const autoFixSettings = autoFixConfig(process.env);
const prHealth = selectPrHealth(process.env);
console.log(autoFixStartupLog(autoFixSettings, Boolean(prHealth)));
const autoFix = autoFixer({ jobs, proposals, notify, port: prHealth, config: autoFixSettings });

// The job listener binds to localhost only; Tailscale Funnel is what publishes it.
const ingressPort = process.env.ORBIT_INGRESS_PORT ? Number(process.env.ORBIT_INGRESS_PORT) : undefined;
if (ingressPort) {
  buildIngress(jobs, Date.now, { researchTool }).listen(ingressPort, "127.0.0.1", () => console.log(`orbit job listener on 127.0.0.1:${ingressPort}`));
}
const runs = runner(jsonStore(stateDir, "runs", []), [memoryReport(memory), modelTask(model), toolCall(tools)], notify);
runs.recover();
const schedule = scheduler(jsonStore(stateDir, "jobs", []), notify, () => new Date(), (worker, input) => runs.submit(worker, input));
// The owner's launch reconciliation log: <state>/launch-reconciliations.json (src/launch-reconciliation.ts).
const reconciliations = launchReconciliations(reconFile(stateDir), () => new Date(), { notify });
const watchTick = () => {
  // Runner events that arrive after an owner reconciliation are logged once and reported. Never throws; never changes a job.
  reconciliations.observe(jobs);
  try {
    watch.tick();
  } catch (err) {
    console.error(JSON.stringify({ at: new Date().toISOString(), watch: String(err) }));
  }
};
const tick = () => {
  // Collect the outcome of any server operation still in flight (including one that restarted this process).
  void admin.refresh().catch(() => {});
  void sys.refresh().catch(() => {});
  void workspace.admin.refresh().catch(() => {});
  // Renew the ChatGPT login shortly before it expires. Not awaited: a slow token endpoint must not hold up the tick
  // or the watch. maintain() never throws and runs one renewal at a time.
  void model.maintain?.();
  // Fetch the writable vault clone (at most once a minute) so search sees other people's changes. Failures show in /status.
  void memory.refresh?.(60_000);
  return schedule
    .tick()
    .then(() => runs.pump())
    .then(() => nodes.refresh())
    .then(() => reconcile())
    .then(() => prs.retry())
    .then(() => review.retry())
    .then(() => autoFix.sweep())
    .catch((err) => console.error(JSON.stringify({ at: new Date().toISOString(), tick: String(err) })))
    .finally(watchTick);
};
tick();
const ticker = setInterval(tick, 30_000);

// On shutdown, stop ticking and let a renewal in flight finish, so a rotated token is saved before exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    clearInterval(ticker);
    void Promise.race([chatgpt.current?.stop(), new Promise((r) => setTimeout(r, 10_000))]).finally(() => process.exit(0));
  });
}

// Opt-in semantic photo search (docs/photo-semantic-search.md). Off unless ORBIT_PHOTO_SEMANTIC=on; then it needs the dedicated
// orbit.openai-embeddings credential (never orbit.openai, never the ChatGPT login). Off: nothing below runs and no tool or port changes.
const semanticConfig = embeddingsConfig(process.env);
const semanticBudget = semanticConfig.state === "ready" ? embeddingBudget(stateDir ? join(stateDir, "embeddings-budget.json") : undefined, semanticConfig.settings) : undefined;
const semanticEmbedder = semanticConfig.state === "ready" && semanticBudget ? openaiEmbedder({ key: semanticConfig.key, settings: semanticConfig.settings, budget: semanticBudget }) : undefined;
const photoSemantic =
  semanticConfig.state === "off"
    ? undefined
    : { embedder: semanticEmbedder, cacheDir: stateDir ? join(stateDir, "photo-vectors") : undefined, status: () => embeddingsStatus(semanticConfig, semanticEmbedder, semanticBudget) };

// Post-deploy smoke checks (docs/smoke-checks.md): run once by buildServer as soon as it is listening, so /status carries evidence from
// THIS process without a user touching anything. Bounded and non-fatal: a failed check is reported, never a reason to stop serving.
// The embeddings check uses the same adapter instance as photos_search, and only when semantic search is on and configured.
const identity = processIdentity(commit);
const loopback = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
const smoke = smokeRunner({
  identity,
  checks: orbitSmokeChecks({
    base: () => `http://${loopback.includes(":") ? `[${loopback}]` : loopback}:${port}`,
    processStart: new Date(identity.startedAt),
    memory,
    modelMock: () => model.status().state === "mock",
    schedule,
    runs,
    nodes,
    watch,
    embeddings: { config: semanticConfig, embedder: semanticEmbedder, budget: semanticBudget },
    // The one post-deploy model call. It goes to the port as built (not the observed one) and records its own evidence.
    model: { port: builtModel, health: modelHealth },
  }),
});

// Discord as a chat channel (src/discord.ts, docs/discord.md): on when the persona names a channel and owner and the
// <persona id>.discord-bot credential is installed. Partly configured is reported as a down port with the reason, never half-run.
const discordSel = selectDiscordChannel(process.env, PERSONA);
let discord: DiscordChannel | undefined;
const discordPort: Port[] =
  "off" in discordSel
    ? []
    : [{ name: "discord", status: () => (discord ? discord.status() : discordOffStatus("invalid" in discordSel ? discordSel.invalid : "Discord has not started.")), call: () => ({ value: null, provenance: "live", source: "discord" }) }];
const discordUrl = PERSONA.url ?? (process.env.HOST ? `http://${process.env.HOST}:${port}/` : undefined);

buildServer({
  ports: [...MOCK_PORT_NAMES.map((name) => mockPort(name)), ...discordPort],
  channels: {
    describe: "config" in discordSel ? `Web chat at /, and Discord channel ${discordSel.config.channelId} for the owner (turns in the Assistant conversation).` : "off" in discordSel ? undefined : `Web chat at /. ${discordSel.invalid}`,
    mirror: (turn) => discord?.mirror(turn),
    onTurn: (turn) => {
      if ("config" in discordSel) discord = discordChannel(discordSel.config, turn, { webUrl: discordUrl, name: PERSONA.name });
    },
  },
  model,
  memory,
  notify,
  schedule,
  runs,
  tools,
  ops,
  adminOps: admin,
  sysOps: sys,
  proposals,
  threads: threadStore(stateDir ? join(stateDir, "threads") : undefined),
  assistantDir: stateDir ? join(stateDir, "assistant") : undefined,
  // The Assistant's rolling summary (docs/rolling-summaries.md) is on by default; ORBIT_ROLLING_SUMMARIES=0 turns it off (rollback switch).
  rollingSummaries: process.env.ORBIT_ROLLING_SUMMARIES !== "0",
  // Private photo attachments: <state>/attachments (docs/photos.md). Without a state directory they are kept in memory only.
  attachments: attachmentStore(stateDir ? join(stateDir, "attachments") : undefined),
  // Saved photo observations: <state>/photo-observations (docs/photo-recall.md). Without a state directory they are kept in memory only.
  photoObservations: observationStore(stateDir ? join(stateDir, "photo-observations") : undefined),
  // Legacy photo import ledger: <state>/photo-imports (docs/photo-import-backfill.md). Read only; written by the host-local importer.
  photoImports: importLedger(stateDir ? join(stateDir, "photo-imports") : undefined),
  photoSemantic,
  smoke,
  // Work sessions and run links: <state>/work-sessions.json (docs/adr/0002-work-sessions.md).
  workSessions: workSessions(workFile(stateDir)),
  // Supervised tasks: <state>/tasks.json (docs/adr/0003-supervised-tasks.md). Turns run when the owner or the Assistant starts one,
  // and (automatic follow-up) only if the operator sets ORBIT_TASK_FOLLOWUPS=on AND Rai opts a task in: off by default, and not set by
  // any deploy file in this repository. Task turns use the same model as every other turn (no task-specific model is configured).
  // Task status lines reach the vault only through the existing write pipeline, and only when the vault clone exists.
  tasks: taskStore(taskFile(stateDir)),
  taskFollowUps: { enabled: process.env.ORBIT_TASK_FOLLOWUPS === "on" },
  // The opt-in supervisor wake (src/task-wake.ts): off unless the operator sets ORBIT_SUPERVISOR_WAKE=on (no deploy file sets it) AND Rai
  // turns it on from the Assistant page. Its record is <state>/supervisor-wake.json.
  supervisorWake: { enabled: process.env.ORBIT_SUPERVISOR_WAKE === "on", backend: wakeFile(stateDir) },
  taskVault: vault ? cloneTaskVault(vault) : undefined,
  reconciliations,
  vaultEdits,
  configView: config,
  // Read-only PR inspection (owner-only chat tools): the repositories are the ones ORBIT_ROUTINE_REPOS names, the token is orbit.github-orbit-prs.
  // Off unless ORBIT_HOST_INVENTORY=enabled; the helper also refuses until the host is activated (docs/host-inventory.md).
  hostInventory: hostInventoryEnabled(process.env) ? [hostInventoryTool({ ops })] : undefined,
  workspace: workspace.service,
  workspaceAdmin: workspace.admin,
  prInspect: selectPrInspect(process.env, parseRoutineRepos(process.env.ORBIT_ROUTINE_REPOS), () => jobs.all()),
  // The rolling note is the vault file Memory/recent-context.md when the clone exists (written through the vault tools, with the
  // same policy, secret refusal, log line and git pipeline); otherwise it stays in ORBIT's state directory.
  recentContext: vault
    ? vaultRecentContext({
        memory,
        clone: vault,
        legacy: jsonStore(stateDir, "recent-context", null),
        // Every policy decision for a rolling-note write is audited; the caller context comes from the request that caused it.
        audit: (d) => console.log(JSON.stringify({ at: new Date().toISOString(), port: "vault", action: "recent-context", ...d })),
      })
    : stateRecentContext(jsonStore(stateDir, "recent-context", null)),
  nodes,
  jobs,
  watch,
  publicJobUrl,
  control,
  routines,
  research: { lane: researchLane, store: researchReports, tool: researchTool, routineRepos },
  commit,
  owner,
  identify: tailscaleIdentify(),
  deploy: readDeploy,
}).listen(port, host, () => {
  console.log(`orbit ${commit} listening on ${host}:${port}`);
  discord?.start();
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => discord?.stop());
