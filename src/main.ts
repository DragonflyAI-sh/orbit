import { mockPort, PORT_NAMES } from "./ports.ts";
import { buildServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? "127.0.0.1";
const commit = process.env.ORBIT_COMMIT ?? "unknown";

buildServer(PORT_NAMES.map((name) => mockPort(name)), commit).listen(port, host, () => {
  console.log(`orbit ${commit} listening on ${host}:${port}`);
});
