import { readFileSync } from "node:fs";
import { tailscaleIdentify } from "./identity.ts";
import { buildIngress } from "./ingress.ts";
import { jobSecret, jobs as jobRegistry } from "./jobs.ts";
import { gitReconciler, selectControl, selectRoutines } from "./launcher.ts";
import { selectMemory } from "./memory.ts";
import { chatgptModel, tokenFile } from "./chatgpt.ts";
import { selectModel } from "./model.ts";
import { nodes as devicePresence, tailscaleStatus } from "./nodes.ts";
import { notifier, selectDiscord } from "./notify.ts";
import { MOCK_PORT_NAMES, mockPort } from "./ports.ts";
import { parseRoutineRepos, pullRequestOpener, selectPulls } from "./pull-requests.ts";
import { memoryReport, modelTask, runner, toolCall } from "./runs.ts";
import { scheduler } from "./schedule.ts";
import { buildServer } from "./server.ts";
import { jsonStore } from "./store.ts";
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
const model = selectModel(process.env, (name) => chatgptModel(name, tokenFile(stateDir)));
const memory = selectMemory(process.env);
const notify = notifier(jsonStore(stateDir, "notifications", []), selectDiscord(process.env));
const tools = toolbox([githubRepoStatus()]);
const owner = process.env.ORBIT_OWNER || undefined;
const nodes = devicePresence(tailscaleStatus(), owner);
const jobs = jobRegistry(jsonStore(stateDir, "jobs-cloud", []), jobSecret(stateDir), notify);
const control = selectControl(process.env);
pullRequestOpener(jobs, parseRoutineRepos(process.env.ORBIT_ROUTINE_REPOS), selectPulls(process.env), notify);
const reconcile = control ? gitReconciler(jobs, control) : async () => {};

// The job listener binds to localhost only; Tailscale Funnel is what publishes it.
const ingressPort = process.env.ORBIT_INGRESS_PORT ? Number(process.env.ORBIT_INGRESS_PORT) : undefined;
if (ingressPort) {
  buildIngress(jobs).listen(ingressPort, "127.0.0.1", () => console.log(`orbit job listener on 127.0.0.1:${ingressPort}`));
}
const runs = runner(jsonStore(stateDir, "runs", []), [memoryReport(memory), modelTask(model), toolCall(tools)], notify);
runs.recover();
const schedule = scheduler(jsonStore(stateDir, "jobs", []), notify, () => new Date(), (worker, input) => runs.submit(worker, input));
const tick = () =>
  schedule
    .tick()
    .then(() => runs.pump())
    .then(() => nodes.refresh())
    .then(() => reconcile())
    .catch((err) => console.error(JSON.stringify({ at: new Date().toISOString(), tick: String(err) })));
tick();
setInterval(tick, 30_000);

buildServer({
  ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
  model,
  memory,
  notify,
  schedule,
  runs,
  tools,
  nodes,
  jobs,
  publicJobUrl: process.env.ORBIT_PUBLIC_JOB_URL || undefined,
  control,
  routines: selectRoutines(process.env),
  commit,
  owner,
  identify: tailscaleIdentify(),
  deploy: readDeploy,
}).listen(port, host, () => {
  console.log(`orbit ${commit} listening on ${host}:${port}`);
});
