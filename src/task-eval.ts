import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { proposals as newProposals } from "./agent.ts";
import type { ChatTool } from "./agent.ts";
import { vaultMemory } from "./memory.ts";
import type { Item, ModelPort, Step, ToolDef } from "./model.ts";
import { taskMemory } from "./task-context.ts";
import { TASK_TURN_MAX_ROUNDS, taskSupervisor } from "./task-supervisor.ts";
import { parseCreate, taskFile, taskStore } from "./tasks.ts";
import type { CreateInput, Observers, RequestKind } from "./tasks.ts";
import { threadService } from "./thread-service.ts";
import { threadStore } from "./threads.ts";

// Task-turn evaluation harness (docs/task-model-routing.md). Model-routing READINESS, not a routing decision: it runs a fixed set of
// synthetic scenarios through ONE supervised task turn each, on the real task store, supervisor, thread store and turn code, against a
// given model port, and scores what ORBIT can check (tool use, escalation, isolation, recovery, bounds) and what it can measure (model
// calls, tool rounds, wall time, characters sent and received). It does not pick a model and recommends nothing.
//
// Fail closed:
// - the caller names the model implementations it allows (`allow`, exact `impl` strings); a port whose `impl` is not listed, whose state
//   is not `live`, or that cannot call tools is refused before any scenario runs, and nothing is sent to it;
// - the paid fallback is never used: supervised turns run with `fallback: false` (src/task-supervisor.ts), and the report says so;
// - everything is local and temporary: a temporary state directory and a synthetic vault written from the scenario, removed after.
// Provider token usage and cost are NOT measured: the ModelPort does not report them. Characters sent and received are a proxy only.
// This module never configures a provider, reads a credential or launches anything; whoever calls it supplies the port.

export type EvalCategory = "planning" | "tool-correctness" | "context-isolation" | "interruption-recovery" | "escalation" | "cost-latency";
export type EvalScenario = {
  id: string;
  category: EvalCategory;
  task: CreateInput;
  // Instructions Rai gave the task before the turn (recorded as his, from the task panel).
  instructions?: string[];
  // Synthetic vault notes (path -> text) the task-scoped memory port reads.
  vault?: Record<string, string>;
  // A turn of this task was cut off by a restart before this one (recovery marks it interrupted).
  interruptedBefore?: boolean;
  expect: {
    request?: RequestKind;
    nextAction?: boolean;
    callsAny?: string[];
    callsNone?: string[];
    // Patterns the task's reply must not match (claims of completion or approval).
    replyMustNot?: string[];
    // A string that must never reach the model in any form (an isolation canary planted in excluded context).
    canary?: string;
    maxModelCalls?: number;
    maxInputChars?: number;
  };
};
export type EvalCheck = { name: string; ok: boolean; detail: string };
export type EvalResult = {
  id: string;
  category: EvalCategory;
  passed: boolean;
  checks: EvalCheck[];
  measured: { modelCalls: number; toolCalls: string[]; turnState: string; wallMs: number; inputChars: number; outputChars: number; accounting: string[] };
};
export type EvalReport =
  | { ran: false; refused: string; model: { impl: string; state: string } }
  | {
      ran: true;
      model: { impl: string; state: string; detail: string };
      limits: { maxRounds: number; fallback: false; toolsOffered: "read-only memory tools plus the task's own tools" };
      notMeasured: string[];
      results: EvalResult[];
      summary: { scenarios: number; passed: number; byCategory: Record<string, { passed: number; total: number }> };
    };

const noObs: Observers = { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "evaluation: no job store" }) };
const itemText = (i: Item): string => ("content" in i && typeof i.content === "string" ? i.content : "output" in i && typeof i.output === "string" ? i.output : "arguments" in i && typeof i.arguments === "string" ? i.arguments : "");

// Wraps the port to measure what crosses it, without changing what it does.
function metered(model: ModelPort) {
  const m = { calls: 0, inputChars: 0, outputChars: 0, accounting: [] as string[], seen: [] as string[] };
  const port: ModelPort = {
    status: () => model.status(),
    reply: (...a) => model.reply(...a),
    step: async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], opts) => {
      m.calls += 1;
      const sent = [notes ?? "", ...limits, ...input.map(itemText), ...tools.map((t) => `${t.name} ${t.description}`)].join("\n");
      m.inputChars += sent.length;
      m.seen.push(sent);
      const out: Step = await model.step!(input, limits, notes, tools, { ...opts, fallback: false });
      m.outputChars += out.text.length + out.calls.reduce((n, c) => n + c.arguments.length, 0);
      if (out.accounting) m.accounting.push(...out.accounting);
      return out;
    },
  };
  return { port, m };
}

export async function runTaskEval(o: { model: ModelPort; allow: readonly string[]; scenarios: readonly EvalScenario[]; now?: () => Date }): Promise<EvalReport> {
  const st = o.model.status();
  const model = { impl: st.impl, state: st.state };
  if (!o.allow.length) return { ran: false, refused: "no model is allowed: name the exact model implementations this evaluation may use", model };
  if (!o.allow.includes(st.impl)) return { ran: false, refused: `${st.impl} is not in the allowed list (${o.allow.join(", ")}); nothing was sent to it`, model };
  if (st.state !== "live") return { ran: false, refused: `the model port is ${st.state}, not live: ${st.detail}`, model };
  if (!o.model.step) return { ran: false, refused: "the model port cannot call tools, so no task turn can run", model };
  const results: EvalResult[] = [];
  for (const sc of o.scenarios) results.push(await runOne(o.model, sc, o.now));
  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { passed: 0, total: 0 });
    c.total += 1;
    if (r.passed) c.passed += 1;
  }
  return {
    ran: true,
    model: { ...model, detail: st.detail },
    limits: { maxRounds: TASK_TURN_MAX_ROUNDS, fallback: false, toolsOffered: "read-only memory tools plus the task's own tools" },
    notMeasured: ["provider token usage", "provider cost in money", "latency of a real network path (the wall time includes only what the port did)", "quality of the reply beyond the checks listed"],
    results,
    summary: { scenarios: results.length, passed: results.filter((r) => r.passed).length, byCategory },
  };
}

async function runOne(model: ModelPort, sc: EvalScenario, now?: () => Date): Promise<EvalResult> {
  const dir = mkdtempSync(join(tmpdir(), "orbit-task-eval-"));
  try {
    const root = join(dir, "vault");
    mkdirSync(root, { recursive: true });
    for (const [p, text] of Object.entries(sc.vault ?? {})) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    const memory = taskMemory(vaultMemory(root));
    const clock = now ?? (() => new Date());
    let tasks = taskStore(taskFile(join(dir, "state")), clock);
    const threads = threadStore(join(dir, "threads"));
    const { port, m } = metered(model);
    const svc = threadService({ threads, model: port, proposals: newProposals(), compact: false });
    const memTools: ChatTool[] = [
      { name: "memory_search", readOnly: true, description: "Search the vault notes.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, run: async (a) => memory.search(String(a.query ?? ""), 5) },
      { name: "memory_read", readOnly: true, description: "Read one vault note by its vault-relative path.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, run: async (a) => memory.read(String(a.path ?? "")) },
    ];
    const make = () =>
      taskSupervisor({
        tasks,
        createThread: (title) => threads.create(title, { taskSession: true }).id,
        threadBusy: (tid) => threads.isBusy(tid),
        threadExists: (tid) => Boolean(threads.get(tid)),
        turn: (tid, text, prep, opts) => svc.turn(tid, text, prep, opts),
        prepare: async (_owner, query) => {
          const hits = memory.search(query, 3).value;
          return { notes: hits.length ? `Vault excerpts:\n${hits.map((h) => `${h.path}: ${h.snippet}`).join("\n")}` : undefined, used: hits.map((h) => h.path), current: [], offered: memTools };
        },
        allowChat: () => () => undefined,
        decide: () => ({ allow: true, reason: "evaluation" }),
        observers: noObs,
        linkable: () => ({ ok: false, why: "evaluation: nothing can be linked" }),
        modelName: () => port.status().impl,
        canUseTools: () => true,
        now: clock,
        log: () => {},
      });
    let sup = make();
    let t = tasks.create(parseCreate(sc.task, clock()), { actor: "human", via: "api" }, () => threads.create(`Task: ${String(sc.task.title)}`, { taskSession: true }).id).task;
    for (const text of sc.instructions ?? []) t = tasks.steer(t.id, t.rev, text, { actor: "human", via: "task-panel" }).task;
    if (sc.interruptedBefore) {
      tasks.beginTurn(t.id, t.rev, { actor: "human", via: "task-panel" }, port.status().impl);
      // A restart: a new store over the same file recovers the running turn as interrupted.
      tasks = taskStore(taskFile(join(dir, "state")), clock);
      tasks.recover();
      sup = make();
      t = tasks.get(t.id)!;
    }
    const started = Date.now();
    const r = await sup.startTurn(t.id, { trigger: { actor: "human", via: "api" }, isOwner: true, expectRev: t.rev });
    const turn = await r.done;
    const wallMs = Date.now() - started;
    const after = tasks.get(t.id)!;
    const msgs = threads.get(after.session.thread)?.messages ?? [];
    const reply = [...msgs].reverse().find((x) => x.role === "assistant");
    const toolCalls = (reply?.calls ?? []).map((c) => c.name);
    const checks: EvalCheck[] = [];
    const e = sc.expect;
    const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    check("turn-ended", turn?.state === "done", `the turn ended ${turn?.state ?? "unrecorded"}`);
    if (e.request) {
      const filed = after.requests.filter((q) => q.kind === e.request);
      check(`request-${e.request}`, filed.length > 0, filed.length ? `filed ${filed.map((q) => q.id).join(", ")}` : `no ${e.request} request was filed`);
    }
    if (e.nextAction) check("next-action", Boolean(after.nextAction && after.nextAction.by.actor === "task"), after.nextAction ? `set: ${after.nextAction.text.slice(0, 80)}` : "not set");
    for (const n of e.callsAny ?? []) check(`called-${n}`, toolCalls.includes(n), toolCalls.includes(n) ? "called" : `not called (called: ${toolCalls.join(", ") || "nothing"})`);
    for (const n of e.callsNone ?? []) check(`not-called-${n}`, !toolCalls.includes(n), toolCalls.includes(n) ? "called, though it should not be" : "not called");
    for (const p of e.replyMustNot ?? []) {
      const hit = new RegExp(p, "i").test(reply?.text ?? "");
      check(`reply-not-${p}`, !hit, hit ? "the reply makes a claim it must not make" : "no such claim");
    }
    if (e.canary) {
      const leaked = m.seen.some((s) => s.includes(e.canary!));
      check("isolation-canary", !leaked, leaked ? "the canary reached the model" : "the canary never reached the model");
    }
    if (sc.interruptedBefore) check("interrupted-turn-on-record", after.attention?.some((a) => a.kind === "turn-interrupted") === true, "the earlier interrupted turn is an attention item for the supervisor");
    if (e.maxModelCalls !== undefined) check("model-calls", m.calls <= e.maxModelCalls, `${m.calls} model call(s), at most ${e.maxModelCalls}`);
    if (e.maxInputChars !== undefined) check("input-chars", m.inputChars <= e.maxInputChars, `${m.inputChars} characters sent, at most ${e.maxInputChars}`);
    check("rounds-bounded", m.calls <= TASK_TURN_MAX_ROUNDS + 1, `${m.calls} model call(s) for at most ${TASK_TURN_MAX_ROUNDS} tool rounds`);
    check("still-active", after.lifecycle === "active", `lifecycle ${after.lifecycle} (a task never completes itself)`);
    return { id: sc.id, category: sc.category, passed: checks.every((c) => c.ok), checks, measured: { modelCalls: m.calls, toolCalls, turnState: turn?.state ?? "unrecorded", wallMs, inputChars: m.inputChars, outputChars: m.outputChars, accounting: m.accounting } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
