import { readFileSync } from "node:fs";
import { tailscaleIdentify } from "./identity.ts";
import { selectMemory } from "./memory.ts";
import { chatgptModel, tokenFile } from "./chatgpt.ts";
import { selectModel } from "./model.ts";
import { notifier, selectDiscord } from "./notify.ts";
import { MOCK_PORT_NAMES, mockPort } from "./ports.ts";
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
const runs = runner(jsonStore(stateDir, "runs", []), [memoryReport(memory), modelTask(model), toolCall(tools)], notify);
runs.recover();
const schedule = scheduler(jsonStore(stateDir, "jobs", []), notify, () => new Date(), (worker, input) => runs.submit(worker, input));
const tick = () =>
  schedule
    .tick()
    .then(() => runs.pump())
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
  commit,
  owner: process.env.ORBIT_OWNER || undefined,
  identify: tailscaleIdentify(),
  deploy: readDeploy,
}).listen(port, host, () => {
  console.log(`orbit ${commit} listening on ${host}:${port}`);
});
