import { readFileSync } from "node:fs";
import { mockPort, PORT_NAMES } from "./ports.ts";
import { buildServer } from "./server.ts";

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

buildServer(PORT_NAMES.map((name) => mockPort(name)), commit, readDeploy).listen(port, host, () => {
  console.log(`orbit ${commit} listening on ${host}:${port}`);
});
