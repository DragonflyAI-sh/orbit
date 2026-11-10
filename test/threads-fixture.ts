import type { AddressInfo } from "node:net";
import { after } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposals as newProposals } from "../src/agent.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { ControlRepo, Routine } from "../src/launcher.ts";
import { vaultMemory } from "../src/memory.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { notifier } from "../src/notify.ts";
import { adminOps } from "../src/ops-admin.ts";
import type { AdminClient } from "../src/ops-admin-client.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { stateRecentContext } from "../src/recent-context.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { threadStore } from "../src/threads.ts";
import { toolbox } from "../src/tools.ts";

// Isolated fixtures for the thread tests: a temp state directory, a scripted model, fake launcher and fake admin helper.
// Nothing here touches the host, the real vault or any real service.

export type Seen = { input: Item[]; notes?: string; limits: string[]; tools: string[] };
export type Script = (seen: Seen, n: number) => Step | Promise<Step>;

export function scripted(script: Script | Step[], opts: { reply?: (prompt: string) => string | Promise<string>; state?: "live" | "mock" } = {}) {
  const seen: Seen[] = [];
  const replies: string[] = [];
  let n = 0;
  const model: ModelPort & { seen: Seen[]; replies: string[] } = {
    seen,
    replies,
    status: () => ({ port: "model", state: opts.state ?? "live", impl: "fake/scripted", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async (messages) => {
      const prompt = messages.map((m) => m.content).join("\n");
      replies.push(prompt);
      const text = opts.reply ? await opts.reply(prompt) : "plain reply";
      return { value: text, provenance: "live", source: "model/fake" };
    },
    step: async (input, limits, notes, tools) => {
      const s: Seen = { input: [...input], notes, limits, tools: tools.map((t) => t.name) };
      seen.push(s);
      const i = n++;
      return typeof script === "function" ? script(s, i) : script[Math.min(i, script.length - 1)]!;
    },
  };
  return model;
}
export const say = (text: string): Step => ({ text, calls: [] });
export const call = (name: string, args: unknown, id = `c_${name}`) => ({ call_id: id, name, arguments: JSON.stringify(args) });

const open = new Set<{ close(): void }>();
after(() => {
  for (const r of open) r.close();
  open.clear();
});

export const OWNER = "rai@example.com";

export function rig(opts: { dir?: string; model?: ModelPort; admin?: boolean; now?: () => Date; vault?: Record<string, string>; extra?: (ctx: { proposals: ReturnType<typeof newProposals>; memory: ReturnType<typeof vaultMemory> }) => Partial<Parameters<typeof buildServer>[0]> } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "orbit-threads-"));
  const vault = mkdtempSync(join(tmpdir(), "orbit-threads-vault-"));
  writeFileSync(join(vault, "now.md"), "Top priority: money noodle PR.\n");
  for (const [name, text] of Object.entries(opts.vault ?? {})) writeFileSync(join(vault, name), text);
  const memory = vaultMemory(vault);
  const notify = notifier(jsonStore(undefined, "n", []));
  const proposals = newProposals(opts.now);
  const jobs = jobRegistry(jsonStore(dir, "jobs", []), Buffer.alloc(32, 1), notify);
  const fired: string[] = [];
  const control: ControlRepo = { pushBrief: async (job) => ({ branch: `orbit/${job}`, commit: "c0ffee" }) };
  const routine: Routine = { name: "orbit", fire: async (text) => (fired.push(text), { sessionId: "cse_1", sessionUrl: "https://claude.ai/code/cse_1" }) };
  const helper = { calls: [] as string[], refuse: false };
  const client: AdminClient = {
    call: async (action) => {
      helper.calls.push(action);
      if (helper.refuse) return { ok: false, code: "busy", message: "another operation is running" };
      return { ok: true, data: { operation: { state: "accepted" } } };
    },
  };
  const admin = opts.admin ? adminOps({ client, store: jsonStore(dir, "ops-admin", []), notify, proposals, now: opts.now }) : undefined;
  const threads = threadStore(join(dir, "threads"));
  const recentStore = jsonStore(dir, "recent-context", null);
  const model = opts.model ?? scripted([say("ok")]);
  const caller = { who: OWNER as string | undefined };
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
    identify: async () => caller.who,
    proposals,
    threads,
    now: opts.now,
    recentContext: stateRecentContext(recentStore),
    ...opts.extra?.({ proposals, memory }),
  });
  let base = "";
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)).then(() => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  const api = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    await ready;
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  };
  const send = async (id: string, text: string) => api(`/threads/${id}/messages`, "POST", { text });
  const create = async (title?: string) => (await api("/threads", "POST", title ? { title } : {})).data.thread;
  const handle = { dir, api, send, create, caller, jobs, threads, proposals, fired, helper, model, admin, server, close: () => (server.close(), server.closeAllConnections()), recentStore };
  open.add(handle);
  return handle;
}

// Every rig opened by a test file is closed when the file finishes, even if a test fails half way.

