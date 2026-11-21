import { AUTO_GLOBAL_PER_DAY_DEFAULT, autoEligibility, AutoNotEligible, dependencyState, TaskError } from "./tasks.ts";
import type { Tasks } from "./tasks.ts";
import type { TaskSupervisor } from "./task-supervisor.ts";

// The follow-up scheduler (docs/adr/0003-supervised-tasks.md, "Automatic follow-up").
//
// Off by default, at two levels: the operator's switch for this ORBIT (`ORBIT_TASK_FOLLOWUPS=on`, src/main.ts) and Rai's per-task
// opt-in (POST /tasks/:id/follow-up, an owner route; no model can turn it on). When both are on, each tick looks for tasks whose
// follow-up time has passed and starts ONE bounded supervised turn per due time, through the supervisor's normal startTurn (same tools,
// same round limit, no paid fallback, the same per-task serialization and global cap as a turn Rai or the Assistant starts).
//
// What makes it restart-safe and single-start:
// - The due time is claimed in the same store change that records the turn (tasks.beginTurn with `auto`), after the store rechecks
//   eligibility on the fresh record. Nothing is written before that, and nothing is sent to a model before it is written. So a second
//   tick, an overlapping tick, a restart or a racing manual start finds the due time claimed (or a turn running) and starts nothing.
// - A turn cut off by a restart is marked interrupted (tasks.recover) and its follow-up `interrupted`: whether the model request was made
//   is unknown, so it is never re-run automatically. A new follow-up time, or a turn Rai or the Assistant starts, is the explicit retry.
// - Capacity is not failure (Repair 3). When every supervised turn slot is busy, or the task's session has a reply in progress, the due
//   time is DEFERRED (`capacity-wait`): no attempt is used, nothing is sent, and the next tick tries again. When the slots are full the
//   tick does not call startTurn at all for the remaining due tasks (no hot loop of refused starts), and due tasks are taken oldest due
//   time first, so the task that has waited longest gets the next free slot (no starvation by later ones).
// - Only other failures before the claim are retried (an unexpected error such as a write failure): at most AUTO_ATTEMPTS_MAX attempts
//   per due time with growing waits, recorded on the task. Anything else (a refusal, the model unable to call tools, a missing session)
//   gives up at once, says why and raises an attention item for the supervisor.
// - A due follow-up held back by a turn budget raises one attention item per due time; one waiting on an unmet dependency waits
//   (`dependency-wait`) and is shown, never started.
// - Budgets: at most `perDay` automatic turns per task and `globalPerDay` across tasks in any 24 hours. They count turns started, not
//   spend; each turn is bounded by its tool rounds and has no paid fallback, but provider cost is not measured or capped here.
// - It never reschedules: a turn consumes its due time, and the task's own tools cannot set a follow-up time. Only Rai or the Assistant
//   (in an owner turn) sets one.
// - It notifies no one and starts no Assistant turn. What a task asks for is filed as a durable request (task_request), which the
//   Assistant sees in its task-activity block the next time Rai talks to it, and Rai sees in the task banner.

export const FOLLOW_UP_TICK_MS = 60_000;

export type TickReport = {
  at: string;
  skipped?: "scheduler-off" | "tick-in-progress" | "store-unavailable";
  started: { task: string; turn: number; dueAt: string }[];
  retrying: { task: string; dueAt: string; error: string }[];
  // Due, but no turn slot (or the task's session) was free: deferred, no attempt used (Repair 3).
  deferred: { task: string; dueAt: string; why: string }[];
  gaveUp: { task: string; dueAt: string; error: string }[];
  notEligible: { task: string; why: string }[];
  // Bookkeeping that could not be written (the attempt changed nothing durable, so the next tick sees the same state).
  unrecorded: { task: string; error: string }[];
};

// Capacity before the claim (Repair 3): the global turn cap (429) or the task's turn or session busy (409). A deferral, never an attempt.
const capacity = (e: unknown) => e instanceof TaskError && (e.code === 429 || (e.code === 409 && /already running|reply in progress/.test(e.message)));
// Other failures that may clear by themselves: anything that is not one of ORBIT's own refusals (for example a task file write error).
const transient = (e: unknown) => !(e instanceof TaskError);

export function taskScheduler(d: { tasks: Tasks; supervisor: Pick<TaskSupervisor, "startTurn"> & Partial<Pick<TaskSupervisor, "capacity">>; enabled: boolean; globalPerDay?: number; now?: () => Date; log?: (e: Record<string, unknown>) => void }) {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? ((e) => console.log(JSON.stringify({ at: now().toISOString(), ...e })));
  const globalPerDay = d.globalPerDay ?? AUTO_GLOBAL_PER_DAY_DEFAULT;
  let ticking = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  // Bookkeeping that never decides anything: a failure to write it is reported, and the next tick sees the same state.
  function note(fn: () => unknown, task: string, report: TickReport) {
    try {
      fn();
    } catch (rec) {
      report.unrecorded.push({ task, error: rec instanceof Error ? rec.message.slice(0, 200) : "error" });
    }
  }
  let current: TickReport | undefined;
  function defer(task: string, dueAt: string, why: string) {
    current!.deferred.push({ task, dueAt, why: why.slice(0, 200) });
    note(() => d.tasks.recordAutoAttempt(task, dueAt, { transient: true, capacity: true, error: why }), task, current!);
  }

  async function tick(): Promise<TickReport> {
    const at = now();
    const report: TickReport = { at: at.toISOString(), started: [], retrying: [], deferred: [], gaveUp: [], notEligible: [], unrecorded: [] };
    if (!d.enabled) return { ...report, skipped: "scheduler-off" };
    if (ticking) return { ...report, skipped: "tick-in-progress" };
    ticking = true;
    current = report;
    try {
      let all;
      try {
        all = d.tasks.all();
      } catch {
        return { ...report, skipped: "store-unavailable" };
      }
      const lookup = (id: string) => all.find((x) => x.id === id);
      const due: { id: string; dueAt: string; since: string }[] = [];
      for (const t of all) {
        if (!t.auto?.enabled) continue;
        const e = autoEligibility(t, now(), { used: d.tasks.autoGlobalUsed(now()), max: globalPerDay }, dependencyState(t, lookup));
        if (!e.eligible || !e.dueAt) {
          if (e.state !== "not-due" && e.state !== "no-follow-up" && e.state !== "ended") report.notEligible.push({ task: t.id, why: e.detail });
          if ((e.state === "budget-task" || e.state === "budget-global") && e.dueAt) note(() => d.tasks.noteAutoBudget(t.id, e.dueAt!, e.state as "budget-task" | "budget-global", e.detail), t.id, report);
          continue;
        }
        const slot = t.auto.slot?.dueAt === e.dueAt ? t.auto.slot : undefined;
        due.push({ id: t.id, dueAt: e.dueAt, since: slot?.deferredSince ?? e.dueAt });
      }
      // Oldest due time first (it has waited longest), then the longest deferred, then by id: a later due time never overtakes an earlier one.
      due.sort((x, y) => (x.dueAt < y.dueAt ? -1 : x.dueAt > y.dueAt ? 1 : x.since < y.since ? -1 : x.since > y.since ? 1 : x.id < y.id ? -1 : 1));
      for (const { id, dueAt } of due) {
        // Slots full: defer without asking startTurn (it would only refuse), so a full ORBIT costs one cheap check per due task per tick.
        const cap = d.supervisor.capacity?.();
        if (cap && cap.running >= cap.max) {
          defer(id, dueAt, `all ${cap.max} supervised task turn slots are busy`);
          continue;
        }
        try {
          const r = await d.supervisor.startTurn(id, { trigger: { actor: "orbit", via: "follow-up", dueAt }, isOwner: true, auto: { dueAt } });
          report.started.push({ task: id, turn: r.turn.n, dueAt });
          log({ event: "task_follow_up_started", task: id, turn: r.turn.n, dueAt });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // The store's recheck found it no longer eligible (paused, turned off, claimed by another start): nothing to record.
          if (err instanceof AutoNotEligible) {
            report.notEligible.push({ task: id, why: msg });
            continue;
          }
          if (capacity(err)) {
            defer(id, dueAt, msg);
            continue;
          }
          const tr = transient(err);
          try {
            const after = d.tasks.recordAutoAttempt(id, dueAt, { transient: tr, error: msg });
            const slot = after.auto?.slot;
            if (slot?.state === "retry-wait") report.retrying.push({ task: id, dueAt, error: msg });
            else report.gaveUp.push({ task: id, dueAt, error: msg });
            log({ event: "task_follow_up_not_started", task: id, dueAt, state: slot?.state, attempts: slot?.attempts, detail: msg.slice(0, 200) });
          } catch (rec) {
            report.unrecorded.push({ task: id, error: rec instanceof Error ? rec.message.slice(0, 200) : "error" });
            log({ event: "task_follow_up_record_failed", task: id, dueAt, detail: rec instanceof Error ? rec.message.slice(0, 200) : "error" });
          }
        }
      }
      return report;
    } finally {
      ticking = false;
    }
  }

  return {
    enabled: d.enabled,
    tick,
    // Starts the periodic tick (unref'd, so it never keeps the process alive). Does nothing when the scheduler is switched off.
    start(everyMs = FOLLOW_UP_TICK_MS) {
      if (!d.enabled || timer || everyMs <= 0) return;
      timer = setInterval(() => void tick().catch((e) => log({ event: "task_follow_up_tick_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "error" })), everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
export type TaskScheduler = ReturnType<typeof taskScheduler>;
