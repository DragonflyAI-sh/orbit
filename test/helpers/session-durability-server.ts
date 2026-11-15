// A real ORBIT server in its own OS process, for test/session-durability.test.ts: started against a temporary state directory,
// driven over HTTP, then stopped (the process exits), so a second process can be started against the same persisted data.
// Synthetic data only; a deterministic scripted model stands in for the provider (no network, no paid inference).
//
// Usage: node test/helpers/session-durability-server.ts <stateDir> <mode>
//   seed:    create the synthetic chat through /threads, then one Assistant turn that discovers it and reads one bounded page.
//   resume:  one Assistant turn that discovers the chat again and continues from the cursor in its own persisted history.
// Prints one JSON line with what the Assistant's tool calls returned, then exits.
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposals as newProposals } from "../../src/agent.ts";
import { jobs as jobRegistry } from "../../src/jobs.ts";
import type { ControlRepo, Routine } from "../../src/launcher.ts";
import { vaultMemory } from "../../src/memory.ts";
import type { Item, ModelPort, Step } from "../../src/model.ts";
import { nodes as devicePresence } from "../../src/nodes.ts";
import { notifier } from "../../src/notify.ts";
import { MOCK_PORT_NAMES, mockPort } from "../../src/ports.ts";
import { stateRecentContext } from "../../src/recent-context.ts";
import { memoryReport, runner } from "../../src/runs.ts";
import { scheduler } from "../../src/schedule.ts";
import { buildServer } from "../../src/server.ts";
import { jsonStore } from "../../src/store.ts";
import { threadStore } from "../../src/threads.ts";
import { toolbox } from "../../src/tools.ts";
import { durabilityConversation, findCursor, TITLE } from "./session-durability-fixture.ts";

const [dir, mode] = process.argv.slice(2);
if (!dir || (mode !== "seed" && mode !== "resume")) throw new Error("usage: <stateDir> seed|resume");
const OWNER = "owner@example.com";

const conversation = durabilityConversation();
const ASK = mode === "seed" ? "durability: find the Slate Heron chat and read its first page" : "durability: continue reading the Slate Heron chat";
let chatId = "";
// The largest page sizes: each page is then bounded by the tool-output limit, so the whole chat takes a few pages.
const PAGE = { maxChars: 12000, limit: 30 };
let n = 0;
// Every tool result this process's Assistant turn received, exactly as the model was given it.
const outputs: { name: string; raw: string }[] = [];
const step = async (input: Item[], _limits: string[], _notes: string | undefined, tools: { name: string }[]): Promise<Step> => {
  const last = input.at(-1) as any;
  const id = () => `${mode}_${n++}`;
  // Chat turns (seeding): a plain acknowledgement, no tools.
  if (!tools.some((t) => t.name === "session_read")) return { text: conversation.reply(last?.content ?? ""), calls: [] };
  if (last?.content === ASK) return { text: "", calls: [{ call_id: id(), name: "sessions_list", arguments: JSON.stringify({ kinds: ["chat"] }) }] };
  if (last?.type === "function_call_output") {
    const name = (input.find((i: any) => i.type === "function_call" && i.call_id === last.call_id) as any)?.name;
    outputs.push({ name, raw: last.output });
    const out = JSON.parse(last.output);
    if (name === "sessions_list") {
      const hit = out.result.sessions.find((s: any) => s.title === TITLE);
      if (!hit) return { text: "not found", calls: [] };
      if (mode === "seed") return { text: "", calls: [{ call_id: id(), name: "session_read", arguments: JSON.stringify({ id: hit.id, from: "start", ...PAGE }) }] };
      // Resume: continue from the newest nextCursor in this conversation's own history (persisted by the previous process).
      const cursor = findCursor(input.slice(0, -2));
      if (!cursor) return { text: "no cursor in history", calls: [] };
      return { text: "", calls: [{ call_id: id(), name: "session_read", arguments: JSON.stringify({ id: hit.id, cursor, ...PAGE }) }] };
    }
    // After a page: stop at the edge; in resume, follow nextCursor (seed stops after one page, like a reader asked for one page).
    if (mode === "resume" && out.ok && out.result.nextCursor) return { text: "", calls: [{ call_id: id(), name: "session_read", arguments: JSON.stringify({ id: out.result.session.id, cursor: out.result.nextCursor, ...PAGE }) }] };
    return { text: mode === "seed" ? "Read the first page." : "Read to the end.", calls: [] };
  }
  return { text: "ok", calls: [] };
};
const model: ModelPort = {
  status: () => ({ port: "model", state: "live", impl: "fake/scripted-process", detail: "test", verifiedAt: new Date().toISOString() }),
  reply: async () => ({ value: "plain reply", provenance: "live", source: "model/fake" }),
  step,
};

const vault = mkdtempSync(join(tmpdir(), "orbit-durability-vault-"));
writeFileSync(join(vault, "now.md"), "Synthetic test vault.\n");
const memory = vaultMemory(vault);
const notify = notifier(jsonStore(undefined, "n", []));
const proposals = newProposals();
const control: ControlRepo = { pushBrief: async (job) => ({ branch: `orbit/${job}`, commit: "c0ffee" }) };
const routine: Routine = { name: "orbit", fire: async () => ({ sessionId: "cse_1", sessionUrl: "https://claude.ai/code/cse_1" }) };
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
  model,
  memory,
  notify,
  schedule: scheduler(jsonStore(undefined, "s", []), notify),
  runs: runner(jsonStore(undefined, "r", []), [memoryReport(memory)], notify),
  tools: toolbox([]),
  nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), OWNER),
  jobs: jobRegistry(jsonStore(dir, "jobs", []), Buffer.alloc(32, 1), notify),
  publicJobUrl: "https://orbit.example",
  control,
  routines: new Map([["orbit", routine]]),
  commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
  owner: OWNER,
  identify: async () => OWNER,
  proposals,
  threads: threadStore(join(dir, "threads")),
  recentContext: stateRecentContext(jsonStore(dir, "recent-context", null)),
  assistantDir: join(dir, "assistant"),
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const api = async (path: string, method = "GET", body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json()) as any };
};

if (mode === "seed") {
  const t = (await api("/threads", "POST", { title: TITLE })).data.thread;
  chatId = t.id;
  for (const u of conversation.users) {
    const r = await api(`/threads/${t.id}/messages`, "POST", { text: u });
    if (r.status !== 200) throw new Error(`seed send failed: ${r.status}`);
  }
}
const turn = await api("/assistant/messages", "POST", { text: ASK });
process.stdout.write(`${JSON.stringify({ pid: process.pid, status: turn.status, chatId, persisted: turn.data.assistant?.persisted, outputs })}\n`);
server.close();
server.closeAllConnections();
process.exit(0);
