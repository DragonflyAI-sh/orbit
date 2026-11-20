import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposals as newProposals } from "../src/agent.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { taskScheduler } from "../src/task-scheduler.ts";
import { taskSupervisor } from "../src/task-supervisor.ts";
import type { SupervisorDeps } from "../src/task-supervisor.ts";
import { parseCreate, TaskError, taskFile, taskStore } from "../src/tasks.ts";
import type { Observers, Provenance, TaskBackend } from "../src/tasks.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";

// A unit-level supervised-task rig (Repair 3): a fake clock, the real task store on a temporary directory (with an injectable write
// failure), the real thread store, turn code, supervisor and scheduler, and a scripted model. Synthetic data only.

export const T0 = Date.parse("2026-11-20T12:00:00.000Z");
export const MIN = 60_000;
export const HUMAN: Provenance = { actor: "human", via: "task-panel" };
export const ASSISTANT: Provenance = { actor: "assistant", via: "assistant-tool" };
export const INPUT = { title: "Garden sensor report", goal: "A weekly CSV of synthetic garden sensor readings exists.", acceptance: ["The CSV has one row per sensor per day"] };
export const noObs: Observers = { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) };
export const code = (n: number, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === n && (!re || re.test(e.message));

export function rig(o: { dir?: string; maxConcurrent?: number; hold?: boolean; enabled?: boolean; observers?: Observers; linkable?: SupervisorDeps["linkable"] } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "orbit-repair3-"));
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const inner = taskFile(dir);
  const disk = { fail: false, saves: 0 };
  const backend: TaskBackend = {
    persisted: true,
    load: () => inner.load(),
    save: (f) => {
      if (disk.fail) throw new Error("ENOSPC: no space left on device");
      disk.saves += 1;
      inner.save(f);
    },
  };
  const tasks = taskStore(backend, now);
  const threads = threadStore(join(dir, "threads"));
  const model = { calls: 0 };
  const fake: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/scripted", detail: "test", verifiedAt: now().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (): Promise<Step> => {
      model.calls += 1;
      return { text: "Checked; next: the totals test.", calls: [] };
    },
  };
  const svc = threadService({ threads, model: fake, proposals: newProposals(), compact: false });
  const gate = { held: o.hold === true, releases: [] as (() => void)[] };
  const sup = taskSupervisor({
    tasks,
    createThread: (title) => threads.create(title, { taskSession: true }).id,
    threadBusy: (tid) => threads.isBusy(tid),
    threadExists: (tid) => Boolean(threads.get(tid)),
    turn: (tid, text, prep, opts) => svc.turn(tid, text, prep, opts),
    prepare: async () => {
      if (gate.held) await new Promise<void>((resolve) => gate.releases.push(resolve));
      return { used: [], current: [], offered: [] };
    },
    allowChat: () => () => undefined,
    decide: () => ({ allow: true, reason: "test" }),
    observers: o.observers ?? noObs,
    linkable: o.linkable ?? (() => ({ ok: false, why: "test" })),
    modelName: () => "fake/scripted",
    canUseTools: () => true,
    now,
    maxConcurrent: o.maxConcurrent ?? 2,
    followUps: { enabled: o.enabled !== false, globalPerDay: 10 },
    log: () => {},
  });
  // Counts startTurn calls the scheduler makes, to show a full ORBIT is not hammered with refused starts.
  const starts = { n: 0 };
  const counted = { ...sup, startTurn: (...a: Parameters<typeof sup.startTurn>) => ((starts.n += 1), sup.startTurn(...a)) };
  const sched = taskScheduler({ tasks, supervisor: counted, enabled: o.enabled !== false, globalPerDay: 10, now, log: () => {} });
  const create = (extra: Record<string, unknown> = {}) => tasks.create(parseCreate({ ...INPUT, ...extra } as never, now()), ASSISTANT, () => threads.create("Task: x", { taskSession: true }).id).task;
  const optedIn = (extra: Record<string, unknown> = {}, perDay?: number) => {
    const t = create({ followUpAt: new Date(clock.t + 10 * MIN).toISOString(), ...extra });
    return tasks.setAuto(t.id, t.rev, true, HUMAN, perDay);
  };
  const release = () => {
    gate.held = false;
    for (const r of gate.releases.splice(0)) r();
  };
  const tool = (name: string) => sup.assistantTools(true).find((x) => x.name === name)!;
  return { dir, clock, now, advance: (ms: number) => (clock.t += ms), tasks, threads, model, sup, sched, gate, release, disk, starts, create, optedIn, tool, file: () => readFileSync(join(dir, "tasks.json"), "utf8") };
}

