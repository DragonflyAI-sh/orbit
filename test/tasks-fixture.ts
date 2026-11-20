import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentStore } from "../src/attachments.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import type { buildServer } from "../src/server.ts";
import type { TaskScheduler } from "../src/task-scheduler.ts";
import type { TaskVaultPort } from "../src/task-vault.ts";
import { taskFile, taskStore } from "../src/tasks.ts";
import type { Tasks } from "../src/tasks.ts";
import { smallJpeg } from "./jpeg-fixture.ts";
import { call, rig, say } from "./threads-fixture.ts";

// The supervised-task server rig shared by test/task-supervisor.test.ts and test/task-acceptance.test.ts: the real server over temporary
// state, a fake model driven by the messages it is sent, the fixture's fake routine. Synthetic data only.

export type Seen = { input: Item[]; notes?: string; limits: string[]; tools: string[]; fallback?: boolean; taskTurn: boolean };
export const SUPERVISOR_PROMPT = "[ORBIT task supervisor]";
export const lastUser = (input: Item[]) => [...input].reverse().find((i): i is { role: "user"; content: string } => "role" in i && i.role === "user");

// The fake model. Assistant and human messages "tool: <name> <json>" call that tool. A supervised task turn runs the next batch of
// `taskSteps` (each a list of calls, then a reply); `gate` holds a task turn's first model request until released or aborted.
export function driver() {
  const seen: Seen[] = [];
  const outputs: { name: string; out: any }[] = [];
  const ctl = { taskSteps: [] as { calls: ReturnType<typeof call>[]; reply?: string }[], gate: undefined as Promise<void> | undefined, current: undefined as { calls: ReturnType<typeof call>[]; reply?: string } | undefined };
  const model: ModelPort & { seen: Seen[] } = {
    seen,
    status: () => ({ port: "model", state: "live", impl: "fake/scripted", detail: "test", verifiedAt: new Date().toISOString() }),
    images: () => ({ ok: true, detail: "test model takes photos" }),
    reply: async () => ({ value: "plain reply", provenance: "live", source: "model/fake" }),
    step: async (input, limits, notes, tools, opts): Promise<Step> => {
      const taskTurn = Boolean(lastUser(input)?.content.startsWith(SUPERVISOR_PROMPT));
      seen.push({ input: [...input], notes, limits, tools: tools.map((t) => t.name), fallback: opts?.fallback, taskTurn });
      const last = input.at(-1)!;
      if ("type" in last && last.type === "function_call_output") {
        // Every output of this round: the items after the last model step's own calls, back to the previous non-tool item.
        for (let i = input.length - 1; i >= 0; i--) {
          const it = input[i]!;
          if (!("type" in it)) break;
          if (it.type !== "function_call_output") continue;
          const c = input.find((x) => "type" in x && x.type === "function_call" && x.call_id === it.call_id) as { name: string } | undefined;
          outputs.push({ name: c?.name ?? "?", out: JSON.parse(it.output) });
        }
        return say(taskTurn ? (ctl.current?.reply ?? "Task turn reply.") : "ok");
      }
      if (taskTurn) {
        if (ctl.gate) {
          const signal = opts?.signal;
          await new Promise<void>((resolve, reject) => {
            ctl.gate!.then(resolve);
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        ctl.current = ctl.taskSteps.shift();
        return ctl.current?.calls.length ? { text: "", calls: ctl.current.calls } : say(ctl.current?.reply ?? "Task turn reply.");
      }
      const m = /^tool: (\w+) ([\s\S]*)$/.exec(lastUser(input)?.content ?? "");
      if (m) return { text: "", calls: [call(m[1]!, JSON.parse(m[2]!), `c_${m[1]}_${seen.length}`)] };
      return say("ok");
    },
  };
  return { model, seen, outputs, ctl };
}

export function stack(o: { dir?: string; turnsMax?: number; vault?: Record<string, string>; taskVault?: TaskVaultPort; followUps?: boolean; extra?: () => Partial<Parameters<typeof buildServer>[0]> } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "orbit-tasks-srv-"));
  const d = driver();
  const tasks: Tasks = taskStore(taskFile(dir));
  const attachments = attachmentStore(join(dir, "attachments"));
  // The follow-up scheduler, when switched on: never on a timer here (tickMs 0); the test ticks it.
  const sched = { current: undefined as TaskScheduler | undefined };
  const x = rig({ dir, model: d.model, ...(o.vault ? { vault: o.vault } : {}), extra: () => ({ assistantDir: join(dir, "assistant"), tasks, attachments, ...(o.taskVault ? { taskVault: o.taskVault } : {}), ...(o.turnsMax ? { taskTurnsMax: o.turnsMax } : {}), ...(o.followUps ? { taskFollowUps: { enabled: true, tickMs: 0, onScheduler: (s: TaskScheduler) => (sched.current = s) } } : {}), ...(o.extra?.() ?? {}) }) });
  const assistantTool = async (name: string, args: unknown) => {
    const before = d.outputs.length;
    const r = await x.api("/assistant/messages", "POST", { text: `tool: ${name} ${JSON.stringify(args)}` });
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
    const out = d.outputs.slice(before).filter((p) => p.name === name).at(-1);
    assert.ok(out, `no output for ${name}`);
    return out!.out;
  };
  const inspect = async (id: string) => (await x.api(`/tasks/${id}`)).data.task;
  const settled = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const t = await inspect(id);
      if (t.lastTurn && !t.turnRunning) return t;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the task turn did not end");
  };
  const upload = async (threadId: string, seed = 1) => {
    await x.api("/status");
    const res = await fetch(`http://127.0.0.1:${(x.server.address() as AddressInfo).port}/threads/${threadId}/attachments`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(smallJpeg(seed, 40, 30)) });
    const data = (await res.json()) as { attachment: { id: string } };
    assert.equal(res.status, 201, JSON.stringify(data));
    return data.attachment.id;
  };
  // The outputs of the task turn tools called in the last task turn, by name.
  const outputsOf = (name: string) => d.outputs.filter((p) => p.name === name).map((p) => p.out);
  return { ...x, dir, d, tasks, assistantTool, inspect, settled, upload, outputsOf, sched };
}

