import type { ModelPort } from "./model.ts";

// Task-turn model routing (docs/task-model-routing.md, "Repair 4"). A small, explicit table from the KIND of task turn to one of the
// model ports ORBIT was configured with; nothing else. It adds no provider, reads no credential and has no default of its own: with no
// table (main.ts configures none), every task turn runs on the same port as today, exactly as before.
//
// Fail closed:
// - a route may only name a port in `ports`; a route to an unknown port, a port that cannot call tools, or a port marked `paid` is a
//   configuration problem, reported by `describe()`, and every turn of that kind is REFUSED (503) with the reason; it never falls back
//   silently to another port;
// - a kind with no route uses the default port (the one every other turn uses), which is the existing behaviour;
// - task turns never use the paid fallback, whichever port they run on (src/task-supervisor.ts passes fallback: false).
// Each turn records the port name and the port's actual `impl` (TurnRecord.model, TurnRecord.route).

export const TASK_TURN_KINDS = ["supervised", "automatic", "interactive"] as const;
export type TaskTurnKind = (typeof TASK_TURN_KINDS)[number];
export type RoutedPort = { port: ModelPort; paid?: boolean };
export type TaskRouting = { ports: Record<string, RoutedPort>; routes?: Partial<Record<string, string>> };
export type Resolved = { ok: true; name: string; port: ModelPort; impl: string; routed: boolean } | { ok: false; why: string };

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function taskRouter(defaultPort: ModelPort, cfg?: TaskRouting) {
  const ports = new Map<string, RoutedPort>(Object.entries(cfg?.ports ?? {}));
  const problems: string[] = [];
  const routes = new Map<TaskTurnKind, string>();
  for (const [kind, name] of Object.entries(cfg?.routes ?? {})) {
    if (!(TASK_TURN_KINDS as readonly string[]).includes(kind)) {
      problems.push(`route for unknown turn kind ${JSON.stringify(kind).slice(0, 40)} is ignored (kinds: ${TASK_TURN_KINDS.join(", ")})`);
      continue;
    }
    if (typeof name !== "string" || !NAME.test(name)) {
      problems.push(`route ${kind}: port name ${JSON.stringify(name).slice(0, 40)} is not a plain name; ${kind} turns are refused`);
      routes.set(kind as TaskTurnKind, "\u0000invalid");
      continue;
    }
    routes.set(kind as TaskTurnKind, name);
    const p = ports.get(name);
    if (!p) problems.push(`route ${kind}: no configured port named ${name}; ${kind} turns are refused (no silent fallback)`);
    else if (p.paid) problems.push(`route ${kind}: port ${name} is a paid port, which task turns never use; ${kind} turns are refused`);
    else if (!p.port.step) problems.push(`route ${kind}: port ${name} cannot call tools; ${kind} turns are refused`);
  }

  function resolve(kind: TaskTurnKind): Resolved {
    const name = routes.get(kind);
    if (name === undefined) return { ok: true, name: "default", port: defaultPort, impl: defaultPort.status().impl, routed: false };
    const p = ports.get(name);
    if (!p) return { ok: false, why: `task ${kind} turns are routed to a model port that is not configured (${name.startsWith("\u0000") ? "an invalid name" : name}); no turn is started and nothing falls back to another model` };
    if (p.paid) return { ok: false, why: `task ${kind} turns are routed to port ${name}, a paid port; task turns never use paid models, so no turn is started` };
    if (!p.port.step) return { ok: false, why: `task ${kind} turns are routed to port ${name}, which cannot call tools; no turn is started` };
    return { ok: true, name, port: p.port, impl: p.port.status().impl, routed: true };
  }

  return {
    resolve,
    // What is configured, for task views and /status: the port each kind uses (name, impl, state), and any configuration problems.
    describe() {
      return {
        configured: Boolean(cfg && (Object.keys(cfg.routes ?? {}).length || ports.size)),
        kinds: TASK_TURN_KINDS.map((k) => {
          const r = resolve(k);
          return r.ok ? { kind: k, port: r.name, impl: r.impl, state: r.port.status().state, routed: r.routed } : { kind: k, refused: r.why };
        }),
        problems,
        fallback: "never: task turns are sent with fallback off, whichever port they use",
        limits: "bounded by TASK_TURN_MAX_ROUNDS tool rounds per supervised or automatic turn; ports are not ranked and no model is recommended",
      };
    },
    // The port named `name` (for the thread service that runs turns on it).
    port: (name: string): ModelPort | undefined => (name === "default" ? defaultPort : ports.get(name)?.port),
  };
}
export type TaskRouter = ReturnType<typeof taskRouter>;
