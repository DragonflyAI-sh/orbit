// A real ORBIT server process for the photo restart test (test/photos-restart.test.ts): the real buildServer, thread store, Assistant
// store and attachment store over the state directory given as argv[2], a scripted model that takes photos, and fakes for every
// side-effect boundary. It prints its port and serves until it is killed. Nothing here reaches a provider or a real service.
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { proposals as newProposals } from "../../src/agent.ts";
import { attachmentStore } from "../../src/attachments.ts";
import { vaultMemory } from "../../src/memory.ts";
import type { ModelPort } from "../../src/model.ts";
import { nodes as devicePresence } from "../../src/nodes.ts";
import { notifier } from "../../src/notify.ts";
import { MOCK_PORT_NAMES, mockPort } from "../../src/ports.ts";
import { memoryReport, runner } from "../../src/runs.ts";
import { scheduler } from "../../src/schedule.ts";
import { buildServer } from "../../src/server.ts";
import { jsonStore } from "../../src/store.ts";
import { threadStore } from "../../src/threads.ts";
import { toolbox } from "../../src/tools.ts";

const dir = process.argv[2]!;
const OWNER = "rai@example.com";
const vault = join(dir, "vault");
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, "now.md"), "Synthetic test vault.\n");
const memory = vaultMemory(vault);
const notify = notifier(jsonStore(undefined, "n", []));
const model: ModelPort = {
  status: () => ({ port: "model", state: "live", impl: "fake/photos", detail: "test", verifiedAt: new Date().toISOString() }),
  images: () => ({ ok: true, detail: "test model takes photos" }),
  reply: async (messages) => {
    const last = messages.at(-1)!;
    return { value: `saw ${last.images?.filter((i) => i.data).length ?? 0} photo(s)`, provenance: "live", source: "model/fake" };
  },
};
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
  model,
  memory,
  notify,
  schedule: scheduler(jsonStore(undefined, "s", []), notify),
  runs: runner(jsonStore(undefined, "r", []), [memoryReport(memory)], notify),
  tools: toolbox([]),
  nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), OWNER),
  commit: "0000000000000000000000000000000000000000",
  owner: OWNER,
  identify: async () => OWNER,
  proposals: newProposals(),
  threads: threadStore(join(dir, "threads")),
  assistantDir: join(dir, "assistant"),
  attachments: attachmentStore(join(dir, "attachments")),
});
server.listen(0, "127.0.0.1", () => console.log(`PORT ${(server.address() as AddressInfo).port}`));
