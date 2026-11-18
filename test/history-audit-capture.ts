import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposals as newProposals } from "../src/agent.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { ControlRepo, Routine } from "../src/launcher.ts";
import { cloneMemory } from "../src/memory.ts";
import type { ModelPort, Step, ToolDef, ToolRounds } from "../src/model.ts";
import { instructions, responsesTools } from "../src/model.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { notifier } from "../src/notify.ts";
import { adminOps } from "../src/ops-admin.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { prInspectTools } from "../src/pr-inspect.ts";
import { stateRecentContext } from "../src/recent-context.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { threadStore } from "../src/threads.ts";
import { toolbox } from "../src/tools.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { makeFixture } from "./vault-fixture.ts";

// Measures the FIXED part of one real Assistant model request (docs/reviews/assistant-history-sizing-audit.md): the instructions
// without reference material, and the tool schemas exactly as the Responses transport sends them (responsesTools). It runs ORBIT's
// real server routes offline against a capturing model, so the instructions, limits and tool definitions are the ones the code builds.
// No provider, no real vault (a temporary git fixture), no network. Deliberately not using test/threads-fixture.ts, so a plain script
// (tools/history-audit/report.ts) can call it without starting the node:test runner.
//
// What is wired here: the chat tools, admin operations (ops_admin_*), vault edits (vault_*), PR inspection, research, sessions and
// photo tools. NOT wired (so not measured): tier 3 system operations (ops_sys_*), semantic photo search (photos_search) and the
// config view. Production requests can therefore be larger than this; the result is a LOWER BOUND for the full production tool set.

export type Captured = {
  toolNames: string[];
  // instructions(limits, no notes, tools, rounds) at step 0 and at the forced final step (no tools offered).
  instructionsChars: number;
  instructionsFinalChars: number;
  toolSchemaChars: number;
  limits: number;
  // The reference material ORBIT built for this turn (vault hits, devices, digest) in this offline fixture.
  notesChars: number;
};

const OWNER = "rai@example.com";

export async function captureAssistantRequest(): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "orbit-history-audit-"));
  const fx = makeFixture();
  const clone = fx.make();
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  const notify = notifier(jsonStore(undefined, "n", []));
  const proposals = newProposals();
  const jobs = jobRegistry(jsonStore(dir, "jobs", []), Buffer.alloc(32, 1), notify);
  const control: ControlRepo = { pushBrief: async (job) => ({ branch: `orbit/${job}`, commit: "c0ffee" }) };
  const routine: Routine = { name: "orbit", fire: async () => ({ sessionId: "cse_1", sessionUrl: "https://claude.ai/code/cse_1" }) };
  const admin = adminOps({ client: { call: async () => ({ ok: true, data: { operation: { state: "accepted" } } }) }, store: jsonStore(dir, "ops-admin", []), notify, proposals });
  const seen: { limits: string[]; notes?: string; tools: ToolDef[]; rounds?: ToolRounds }[] = [];
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/history-audit", detail: "offline capture", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "unused", provenance: "live", source: "model/fake" }),
    step: async (_input, limits, notes, tools, opts): Promise<Step> => {
      seen.push({ limits, notes, tools, rounds: opts?.rounds });
      return { text: "ok", calls: [] };
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
    jobs,
    adminOps: admin,
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
    vaultEdits: vaultEdits({ clone, memory, proposals }),
    prInspect: prInspectTools({ token: () => undefined, repos: () => ["example/repo"], fetcher: async () => { throw new Error("offline"); } }),
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/assistant/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "What is open in the vault this week?" }) });
    if (res.status !== 200) throw new Error(`capture turn failed: HTTP ${res.status}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
  const s = seen[0];
  if (!s) throw new Error("the capture turn made no model request");
  const names = s.tools.map((t) => t.name);
  const max = s.rounds?.max ?? 5;
  return {
    toolNames: names,
    instructionsChars: instructions(s.limits, undefined, names, s.rounds).length,
    instructionsFinalChars: instructions(s.limits, undefined, [], { round: max, max, offered: names }).length,
    toolSchemaChars: JSON.stringify(responsesTools(s.tools)).length,
    limits: s.limits.length,
    notesChars: s.notes?.length ?? 0,
  };
}
