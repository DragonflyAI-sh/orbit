import { readFileSync } from "node:fs";
import { tailscaleIdentify } from "./identity.ts";
import { buildIngress } from "./ingress.ts";
import { jobLauncher } from "./job-launch.ts";
import { cloneContextReader } from "./job-context.ts";
import { jobSecret, jobs as jobRegistry } from "./jobs.ts";
import { gitReconciler, selectControl, selectRoutines } from "./launcher.ts";
import { selectMemory } from "./memory.ts";
import { chatgptModel, tokenFile } from "./chatgpt.ts";
import { proposals as newProposals } from "./agent.ts";
import { fallbackModel } from "./fallback.ts";
import { selectModel } from "./model.ts";
import { openrouterConfig } from "./openrouter.ts";
import { SpendError, spendLedger, toMicro } from "./spend-ledger.ts";
import { nodes as devicePresence, tailscaleStatus } from "./nodes.ts";
import { notifier, selectDiscord } from "./notify.ts";
import { adminOps } from "./ops-admin.ts";
import { adminClient } from "./ops-admin-client.ts";
import { jobStateOf, sysOps } from "./ops-sys.ts";
import { sysClient } from "./ops-sys-client.ts";
import { opsClient } from "./ops-client.ts";
import { MOCK_PORT_NAMES, mockPort } from "./ports.ts";
import { selectPrInspect } from "./pr-inspect.ts";
import { parseRoutineRepos, pullRequestOpener, selectPulls } from "./pull-requests.ts";
import { reviewer, selectComments } from "./review.ts";
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
import { join } from "node:path";
import { watcher } from "./watch.ts";
import { githubRepoStatus, toolbox } from "./tools.ts";

const port = Number(process.env.PORT ?? 8790);
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
const primaryModel = selectModel(process.env, (name) => (chatgpt.current = chatgptModel(name, tokenFile(stateDir))));
// The OpenRouter fallback is off unless ORBIT_OPENROUTER_ENABLED=1 and its model, prices and orbit.openrouter credential are all set.
// Disabled, the primary model is used as it is, untouched.
const openrouter = openrouterConfig(process.env);
// A ledger that cannot be built (bad caps) must not stop ORBIT starting: the fallback is then reported as unavailable.
let openrouterLedger: ReturnType<typeof spendLedger> | undefined;
let openrouterEffective = openrouter;
if (openrouter.state === "ready" && stateDir) {
  try {
    openrouterLedger = spendLedger(stateDir, { dailyMicro: toMicro(openrouter.dailyCapUsd), totalMicro: toMicro(openrouter.totalCapUsd) });
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
const model = openrouterEffective.state === "disabled" ? primaryModel : fallbackModel({ primary: primaryModel, config: openrouterEffective, ledger: openrouterLedger });
// The writable vault clone needs a state directory and the orbit.github-vault credential (read when used, never cached). Without
// either, memory reads the read-only server copy and no vault write tool is offered; /status and the tool results say so.
const vault = stateDir
  ? vaultClone({ dir: join(stateDir, "vault-clone"), remote: process.env.ORBIT_VAULT_REMOTE || DEFAULT_REMOTE, branch: process.env.ORBIT_VAULT_BRANCH || undefined, credential: credentialFile(process.env), onChange: () => memory.invalidate?.() })
  : undefined;
const memory = selectMemory(process.env, vault);
const notify = notifier(jsonStore(stateDir, "notifications", []), selectDiscord(process.env));
const tools = toolbox([githubRepoStatus()]);
const ops = opsClient();
// Server operations (tier 2): proposals need the owner's confirmation; the ledger is persisted so results survive a restart.
const proposals = newProposals();
const admin = adminOps({ client: adminClient(), store: jsonStore(stateDir, "ops-admin", []), notify, proposals });
const owner = process.env.ORBIT_OWNER || undefined;
const vaultEdits = vault ? newVaultEdits({ clone: vault, memory, proposals }) : undefined;
const config = configView({ env: process.env, ops, commit, vaultPolicy: vault ? () => vault.policyCheck() : undefined });
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
const watch = watcher(jsonStore(stateDir, "watch", { ports: {} }), notify, () => new Date(), jobs);
const control = selectControl(process.env);
const routines = selectRoutines(process.env);
const publicJobUrl = process.env.ORBIT_PUBLIC_JOB_URL || undefined;
// ORBIT starts reviews itself, from a PR it just opened: not a chat tool call, so no confirmation is needed.
const contextReader = vault ? cloneContextReader(vault) : undefined;
const review = reviewer(jobs, jobLauncher({ jobs, control, routines, notify, publicJobUrl, commit, contextReader }), selectComments(process.env), notify);
const prs = pullRequestOpener(jobs, parseRoutineRepos(process.env.ORBIT_ROUTINE_REPOS), selectPulls(process.env), notify, () => new Date(), (job, url, headSha) => void review.start(job, url, headSha), selectComments(process.env));
const reconcile = control ? gitReconciler(jobs, control) : async () => {};

// The job listener binds to localhost only; Tailscale Funnel is what publishes it.
const ingressPort = process.env.ORBIT_INGRESS_PORT ? Number(process.env.ORBIT_INGRESS_PORT) : undefined;
if (ingressPort) {
  buildIngress(jobs).listen(ingressPort, "127.0.0.1", () => console.log(`orbit job listener on 127.0.0.1:${ingressPort}`));
}
const runs = runner(jsonStore(stateDir, "runs", []), [memoryReport(memory), modelTask(model), toolCall(tools)], notify);
runs.recover();
const schedule = scheduler(jsonStore(stateDir, "jobs", []), notify, () => new Date(), (worker, input) => runs.submit(worker, input));
const watchTick = () => {
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

buildServer({
  ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
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
  vaultEdits,
  configView: config,
  // Read-only PR inspection (owner-only chat tools): the repositories are the ones ORBIT_ROUTINE_REPOS names, the token is orbit.github-orbit-prs.
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
  contextReader,
  routines,
  commit,
  owner,
  identify: tailscaleIdentify(),
  deploy: readDeploy,
}).listen(port, host, () => {
  console.log(`orbit ${commit} listening on ${host}:${port}`);
});
