import { readFileSync } from "node:fs";
import { tailscaleIdentify } from "./identity.ts";
import { buildIngress } from "./ingress.ts";
import { jobLauncher } from "./job-launch.ts";
import { jobSecret, jobs as jobRegistry } from "./jobs.ts";
import { gitReconciler, selectControl, selectRoutines } from "./launcher.ts";
import { selectMemory } from "./memory.ts";
import { chatgptModel, tokenFile } from "./chatgpt.ts";
import { proposals as newProposals } from "./agent.ts";
import { selectModel } from "./model.ts";
import { nodes as devicePresence, tailscaleStatus } from "./nodes.ts";
import { notifier, selectDiscord } from "./notify.ts";
import { adminOps } from "./ops-admin.ts";
import { adminClient } from "./ops-admin-client.ts";
import { jobStateOf, sysOps } from "./ops-sys.ts";
import { sysClient } from "./ops-sys-client.ts";
import { opsClient } from "./ops-client.ts";
import { MOCK_PORT_NAMES, mockPort } from "./ports.ts";
import { parseRoutineRepos, pullRequestOpener, selectPulls } from "./pull-requests.ts";
import { reviewer, selectComments } from "./review.ts";
import { memoryReport, modelTask, runner, toolCall } from "./runs.ts";
import { scheduler } from "./schedule.ts";
import { buildServer } from "./server.ts";
import { stateRecentContext } from "./recent-context.ts";
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
const model = selectModel(process.env, (name) => (chatgpt.current = chatgptModel(name, tokenFile(stateDir))));
const memory = selectMemory(process.env);
const notify = notifier(jsonStore(stateDir, "notifications", []), selectDiscord(process.env));
const tools = toolbox([githubRepoStatus()]);
const ops = opsClient();
// Server operations (tier 2): proposals need the owner's confirmation; the ledger is persisted so results survive a restart.
const proposals = newProposals();
const admin = adminOps({ client: adminClient(), store: jsonStore(stateDir, "ops-admin", []), notify, proposals });
const owner = process.env.ORBIT_OWNER || undefined;
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
const review = reviewer(jobs, jobLauncher({ jobs, control, routines, notify, publicJobUrl, commit }), selectComments(process.env), notify);
pullRequestOpener(jobs, parseRoutineRepos(process.env.ORBIT_ROUTINE_REPOS), selectPulls(process.env), notify, () => new Date(), (job, url) => void review.start(job, url));
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
  return schedule
    .tick()
    .then(() => runs.pump())
    .then(() => nodes.refresh())
    .then(() => reconcile())
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
  // The rolling note stays in ORBIT's state for now; Memory/recent-context.md in the vault is a later RecentContextPort.
  recentContext: stateRecentContext(jsonStore(stateDir, "recent-context", null)),
  nodes,
  jobs,
  watch,
  publicJobUrl,
  control,
  routines,
  commit,
  owner,
  identify: tailscaleIdentify(),
  deploy: readDeploy,
}).listen(port, host, () => {
  console.log(`orbit ${commit} listening on ${host}:${port}`);
});
