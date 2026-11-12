import { randomUUID } from "node:crypto";
import type { MemoryPort } from "./memory.ts";
import type { ModelPort } from "./model.ts";
import type { Notifier } from "./notify.ts";
import type { PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";
import type { Toolbox } from "./tools.ts";

export type RunState = "requested" | "accepted" | "running" | "reviewed" | "delivered" | "failed" | "cancelled";
export type Output = { text: string; provenance: "live" | "mock" };

export type Run = {
  id: string;
  key?: string;
  worker: string;
  input: Record<string, unknown>;
  state: RunState;
  createdAt: string;
  events: { at: string; state: RunState; detail: string }[];
  output?: Output;
  review?: { ok: boolean; detail: string };
  notification?: string;
};

export type Worker = {
  name: string;
  // Safe to run again after a restart interrupted it.
  idempotent: boolean;
  timeoutMs: number;
  validate(input: Record<string, unknown>): string | undefined;
  run(input: Record<string, unknown>, signal: AbortSignal): Promise<Output>;
  review(output: Output): { ok: boolean; detail: string };
};

export const MAX_CONCURRENT = 4;
const KEEP = 200;
const FINAL: RunState[] = ["delivered", "failed", "cancelled"];

export function memoryReport(memory: MemoryPort): Worker {
  return {
    name: "memory-report",
    idempotent: true,
    timeoutMs: 60_000,
    validate: (input) => (typeof input.query === "string" && input.query.trim() ? undefined : "memory-report needs {query}."),
    run: async (input) => {
      const hits = memory.search(String(input.query), 10).value;
      const lines = hits.map((h) => `- ${h.path}${h.snippet ? `: ${h.snippet}` : ""}`);
      return {
        text: hits.length ? `Notes matching "${input.query}":\n${lines.join("\n")}` : `No notes match "${input.query}".`,
        provenance: "live",
      };
    },
    review: (output) => ({ ok: output.text.length > 0, detail: "Report built from the vault copy." }),
  };
}

export function modelTask(model: ModelPort): Worker {
  return {
    name: "model-task",
    idempotent: true,
    timeoutMs: 10 * 60_000,
    validate: (input) => (typeof input.prompt === "string" && input.prompt.trim() ? undefined : "model-task needs {prompt}."),
    run: async (input) => {
      const reply = await model.reply([{ role: "user", content: String(input.prompt) }], [], undefined, { fallback: false });
      return { text: reply.value, provenance: reply.provenance };
    },
    review: (output) =>
      !output.text.trim()
        ? { ok: false, detail: "The model returned nothing." }
        : output.provenance === "mock"
          ? { ok: true, detail: "Output is mock: no model is connected." }
          : { ok: true, detail: "Model answered." },
  };
}

export function toolCall(tools: Toolbox): Worker {
  return {
    name: "tool",
    idempotent: true,
    timeoutMs: 60_000,
    validate: (input) => {
      const tool = typeof input.name === "string" ? tools.get(input.name) : undefined;
      if (!tool) return "tool needs {name, input} naming a known tool.";
      if (!tool.readOnly) return `${tool.name} is not read-only, so it is refused until approvals exist.`;
      return tool.validate((input.input ?? {}) as Record<string, unknown>);
    },
    run: async (input) => {
      const result = await tools.call(String(input.name), (input.input ?? {}) as Record<string, unknown>);
      return { text: JSON.stringify(result.value, null, 2), provenance: result.provenance };
    },
    review: (output) => ({ ok: output.text.length > 2, detail: "Tool answered." }),
  };
}

export type Runner = ReturnType<typeof runner>;

export function runner(store: Store<Run[]>, workers: Worker[], notify: Notifier, now: () => Date = () => new Date()) {
  const byName = new Map(workers.map((w) => [w.name, w]));
  const active = new Map<string, AbortController>();
  let lastPump: string | undefined;

  const list = () => store.read();
  const update = (id: string, change: (r: Run) => Run) => store.write(list().map((r) => (r.id === id ? change(r) : r)).slice(-KEEP));
  const move = (id: string, state: RunState, detail: string, extra: Partial<Run> = {}) =>
    update(id, (r) => ({ ...r, ...extra, state, events: [...r.events, { at: now().toISOString(), state, detail }] }));

  const deliver = (run: Run, text: string) => {
    const n = notify.send(text, false);
    update(run.id, (r) => ({ ...r, notification: n.id }));
  };

  async function execute(run: Run, worker: Worker) {
    const controller = new AbortController();
    active.set(run.id, controller);
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${worker.timeoutMs} ms`)), worker.timeoutMs);
    move(run.id, "running", "Worker started.");
    try {
      const output = await Promise.race([
        worker.run(run.input, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason))),
      ]);
      if (list().find((r) => r.id === run.id)?.state === "cancelled") return;
      const review = worker.review(output);
      if (!review.ok) {
        move(run.id, "failed", `Review failed: ${review.detail}`, { output, review });
        deliver(run, `Run ${worker.name} failed review: ${review.detail}`);
        return;
      }
      move(run.id, "reviewed", `${review.detail} Waiting for a delivery receipt.`, { output, review });
      deliver(run, `Run ${worker.name} finished (${output.provenance}).\n\n${output.text}`);
    } catch (err) {
      const current = list().find((r) => r.id === run.id);
      if (current?.state === "cancelled") return;
      const detail = err instanceof Error ? err.message : String(err);
      move(run.id, "failed", `Worker failed: ${detail}`);
      deliver(run, `Run ${worker.name} failed: ${detail}`);
    } finally {
      clearTimeout(timer);
      active.delete(run.id);
    }
  }

  return {
    // Accepted runs that were mid-flight when the process stopped. Re-queue only what is safe to repeat.
    recover(): void {
      for (const r of list().filter((x) => x.state === "accepted" || x.state === "running")) {
        const worker = byName.get(r.worker);
        if (worker?.idempotent) move(r.id, "requested", "Re-queued after a restart; the worker is safe to repeat.");
        else move(r.id, "failed", "Interrupted by a restart; not retried because the worker is not safe to repeat.");
      }
    },

    submit(workerName: string, input: Record<string, unknown>, key?: string): { run?: Run; deduped?: boolean; error?: string } {
      const worker = byName.get(workerName);
      if (!worker) return { error: `No worker named ${workerName}. Workers: ${[...byName.keys()].join(", ")}.` };
      const invalid = worker.validate(input);
      if (invalid) return { error: invalid };
      if (key) {
        const existing = list().find((r) => r.key === key);
        if (existing) return { run: existing, deduped: true };
      }
      const at = now().toISOString();
      const run: Run = {
        id: randomUUID(),
        key,
        worker: workerName,
        input,
        state: "requested",
        createdAt: at,
        events: [{ at, state: "requested", detail: "Requested." }],
      };
      store.write([...list(), run].slice(-KEEP));
      return { run };
    },

    // Starts queued runs up to the cap and marks reviewed runs delivered once their notification has a receipt.
    pump(): void {
      lastPump = now().toISOString();
      for (const r of list().filter((x) => x.state === "reviewed" && x.notification)) {
        const n = notify.get(r.notification!);
        const receipt = n?.shown ?? (n?.discord?.ok ? n.discord : undefined);
        if (receipt) move(r.id, "delivered", `Receipt: ${receipt.detail} at ${receipt.at}.`);
      }
      for (const r of list().filter((x) => x.state === "requested")) {
        if (active.size >= MAX_CONCURRENT) break;
        const worker = byName.get(r.worker);
        if (!worker) {
          move(r.id, "failed", `No worker named ${r.worker}.`);
          continue;
        }
        move(r.id, "accepted", `Accepted; ${active.size + 1} of ${MAX_CONCURRENT} slots in use.`);
        void execute({ ...r, state: "accepted" }, worker);
      }
    },

    cancel(id: string): Run | undefined {
      const run = list().find((r) => r.id === id);
      if (!run || FINAL.includes(run.state) || run.state === "reviewed") return undefined;
      move(id, "cancelled", "Cancelled by the owner.");
      active.get(id)?.abort(new Error("cancelled"));
      return list().find((r) => r.id === id);
    },

    list: (): Run[] => list().slice(-50).reverse(),
    get: (id: string): Run | undefined => list().find((r) => r.id === id),
    workers: (): string[] => [...byName.keys()],

    status(): PortStatus {
      const runs = list();
      const count = (s: RunState) => runs.filter((r) => r.state === s).length;
      const persisted = store.persisted ? "" : " Not persisted: runs are lost on restart.";
      return {
        port: "runs",
        state: store.persisted && lastPump ? "live" : "degraded",
        impl: "in-process",
        detail:
          `${active.size} running, ${count("requested")} queued, ${count("reviewed")} awaiting a receipt, ` +
          `cap ${MAX_CONCURRENT}. Workers: ${[...byName.keys()].join(", ")}.${persisted}`,
        verifiedAt: lastPump ?? new Date(0).toISOString(),
      };
    },
  };
}
