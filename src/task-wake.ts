import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNew, unresolved } from "./task-attention.ts";
import { cleanText, TaskError, TERMINAL } from "./tasks.ts";
import type { Provenance, Tasks } from "./tasks.ts";

// The opt-in supervisor wake (docs/adr/0003-supervised-tasks.md, "Repair 4"). When task attention is waiting that the Assistant has not
// been given yet, it may start ONE bounded Assistant turn so the supervisor looks at it without waiting for Rai to write.
//
// Off by default at two levels, both required, neither set anywhere by this repository:
// 1. the operator's switch for this ORBIT (`ORBIT_SUPERVISOR_WAKE=on`, src/main.ts);
// 2. Rai's own opt-in (POST /tasks/wake {enabled: true}, an owner route; the Assistant page's control). No model can turn it on: the
//    Assistant has no tool for it, and a task's tools never see it.
// Rai can pause it (POST /tasks/wake/pause) or turn it off at any time; three wake turns in a row that end in an error pause it by itself.
//
// Bounds (all checked on every tick, from the durable record):
// - concurrency: one wake at a time, and never while the Assistant has a reply in progress (Rai's own turn, another tab): then nothing
//   is claimed and the attention stays pending (delivered by Rai's next turn, or by a later wake);
// - rate: at least WAKE_MIN_INTERVAL_MS between wake starts;
// - budget: at most `perDay` wake turns in any 24 hours (default WAKE_PER_DAY_DEFAULT, at most WAKE_PER_DAY_LIMIT);
// - retries: an attention item is the cause of at most WAKE_TRIES_PER_ITEM wakes; after that it waits for Rai's next turn (it stays
//   pending and visible; it is never marked handled);
// - each wake turn: at most WAKE_MAX_ROUNDS tool rounds, NO paid fallback, and only read-only tools plus the task supervisor's answering
//   tools and the launch PROPOSAL tools (src/server.ts wakeTools): no vault writes, no ops, no workspace changes, no task turns, no
//   resume. A launch proposal is a card that waits for Rai's Confirm, exactly as in any Assistant turn: nothing is approved here.
//
// Restart safety: a wake is claimed (written as `running`, with the items that caused it and their try counts) BEFORE its turn starts;
// nothing starts if that write fails. At start, a wake still `running` is marked `interrupted` and never re-run; whatever it was given is
// still not delivered (delivery is recorded only when the Assistant turn completes, src/server.ts), so it stays pending.
//
// Delivery is not acknowledgement or resolution: a wake turn that completes marks the attention it was SHOWN as delivered (no longer
// `new`); every item stays open until the Assistant or Rai answers, acknowledges or resolves it.

export const WAKE_PER_DAY_DEFAULT = 4;
export const WAKE_PER_DAY_LIMIT = 12;
export const WAKE_MIN_INTERVAL_MS = 20 * 60_000;
export const WAKE_TRIES_PER_ITEM = 2;
export const WAKE_FAILURES_PAUSE = 3;
export const WAKE_MAX_ROUNDS = 6;
export const WAKE_TICK_MS = 60_000;
export const WAKE_KEPT = 50;
const WINDOW_MS = 24 * 60 * 60 * 1000;
export const WAKE_FILE_VERSION = 1;

export type WakeState = "running" | "done" | "error" | "interrupted" | "not-run";
export type WakeRecord = { n: number; startedAt: string; endedAt?: string; state: WakeState; items: { task: string; attention: string; key: string }[]; error?: string; reply?: string };
export type WakeFile = {
  v: number;
  optIn?: { enabled: boolean; changedAt: string; changedBy: Provenance; perDay: number };
  paused?: { at: string; by: Provenance | { actor: "orbit"; via: "system" }; reason: string };
  wakes: WakeRecord[];
  seq: number;
  // Wakes caused per attention item (`<task>/<item id>`), for the retry limit. Pruned with the items.
  tries: Record<string, number>;
  consecutiveFailures: number;
};
export type WakeBackend = { persisted: boolean; load(): WakeFile | undefined; save(f: WakeFile): void };
export function wakeFile(dir: string | undefined): WakeBackend {
  if (!dir) {
    let mem: WakeFile | undefined;
    return { persisted: false, load: () => (mem ? structuredClone(mem) : undefined), save: (f) => void (mem = structuredClone(f)) };
  }
  const file = join(dir, "supervisor-wake.json");
  return {
    persisted: true,
    load: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as WakeFile) : undefined),
    save: (f) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.new`, JSON.stringify(f, null, 2));
      renameSync(`${file}.new`, file);
    },
  };
}

// What the server runs for one wake: one Assistant turn (src/server.ts). `error`: the turn ended in an error; `notStarted`: the Assistant
// was busy at the moment the turn tried to take it (nothing was sent or stored).
export type WakeTurn = (text: string) => Promise<{ error?: string; notStarted?: string; reply?: string }>;

export type WakeTickReport = { at: string; outcome: "operator-off" | "off" | "paused" | "running" | "budget" | "interval" | "nothing-pending" | "assistant-busy" | "store-unavailable" | "claim-failed" | "started"; detail: string; wake?: number };

export function supervisorWake(d: { tasks: Tasks; backend: WakeBackend; enabled: boolean; assistantBusy(): boolean; turn: WakeTurn; now?: () => Date; log?: (e: Record<string, unknown>) => void; minIntervalMs?: number }) {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? ((e) => console.log(JSON.stringify({ at: now().toISOString(), ...e })));
  const minInterval = d.minIntervalMs ?? WAKE_MIN_INTERVAL_MS;
  let file: WakeFile | undefined;
  let problem: string | undefined;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const pending = new Set<Promise<unknown>>();

  const load = (): WakeFile => {
    if (file) return file;
    let raw: WakeFile | undefined;
    try {
      raw = d.backend.load();
    } catch (e) {
      problem = `the wake file could not be read (${e instanceof Error ? e.name : "error"}); it is left as it is`;
      throw new TaskError(503, `Supervisor wake is unavailable: ${problem}.`);
    }
    raw ??= { v: WAKE_FILE_VERSION, wakes: [], seq: 0, tries: {}, consecutiveFailures: 0 };
    if (typeof raw !== "object" || raw === null || raw.v !== WAKE_FILE_VERSION || !Array.isArray(raw.wakes)) {
      problem = `the wake file has an unknown shape or version (${JSON.stringify((raw as { v?: unknown } | null)?.v ?? null).slice(0, 20)}); it is left as it is`;
      throw new TaskError(503, `Supervisor wake is unavailable: ${problem}.`);
    }
    problem = undefined;
    file = { ...raw, tries: raw.tries ?? {}, consecutiveFailures: raw.consecutiveFailures ?? 0, seq: raw.seq ?? raw.wakes.length };
    return file;
  };
  const commit = (next: WakeFile) => {
    d.backend.save(next);
    file = next;
  };
  const mutate = <R>(fn: (f: WakeFile) => R): R => {
    const f = structuredClone(load());
    const r = fn(f);
    commit(f);
    return r;
  };

  // Restart recovery, once: a wake left running was cut off. Marked interrupted, never re-run (its attention is still undelivered).
  function recover(): number[] {
    const f = load();
    const cut = f.wakes.filter((w) => w.state === "running").map((w) => w.n);
    if (!cut.length) return [];
    const at = now().toISOString();
    mutate((x) => {
      for (const w of x.wakes) if (w.state === "running") Object.assign(w, { state: "interrupted", endedAt: at, error: "ORBIT stopped while this wake turn was running; it was not re-run, and what it was shown is still not delivered" });
    });
    return cut;
  }

  const startedSince = (f: WakeFile, at: Date) => f.wakes.filter((w) => w.state !== "not-run" && at.getTime() - Date.parse(w.startedAt) < WINDOW_MS);
  // Attention the Assistant has not been given yet (open, never delivered), across open tasks, oldest first, minus items that already
  // caused WAKE_TRIES_PER_ITEM wakes.
  function candidates(f: WakeFile) {
    const out: { task: string; attention: string; key: string; createdAt: string }[] = [];
    for (const t of d.tasks.all()) {
      if (TERMINAL.includes(t.lifecycle)) continue;
      for (const a of unresolved(t)) if (isNew(a)) out.push({ task: t.id, attention: a.id, key: `${t.id}/${a.id}`, createdAt: a.createdAt });
    }
    const waiting = out.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.key.localeCompare(y.key));
    return { eligible: waiting.filter((c) => (f.tries[c.key] ?? 0) < WAKE_TRIES_PER_ITEM), exhausted: waiting.filter((c) => (f.tries[c.key] ?? 0) >= WAKE_TRIES_PER_ITEM).length };
  }

  function view() {
    const at = now();
    let f: WakeFile;
    try {
      f = load();
    } catch (e) {
      return { state: "unavailable" as const, detail: e instanceof Error ? e.message : "unavailable", operatorOn: d.enabled };
    }
    const used = startedSince(f, at).length;
    const perDay = f.optIn?.perDay ?? WAKE_PER_DAY_DEFAULT;
    const last = f.wakes.filter((w) => w.state !== "not-run").at(-1);
    let c: ReturnType<typeof candidates> | undefined;
    try {
      c = candidates(f);
    } catch {
      c = undefined;
    }
    const state = !d.enabled ? "operator-off" : !f.optIn?.enabled ? "off" : f.paused ? "paused" : busy || f.wakes.some((w) => w.state === "running") ? "running" : used >= perDay ? "budget" : "on";
    const detail =
      state === "operator-off"
        ? "The supervisor wake is switched off on this ORBIT (operator setting). Nothing wakes the Assistant; task attention waits for your next message to it."
        : state === "off"
          ? "Off (the default). Task attention waits for your next message to the Assistant."
          : state === "paused"
            ? `Paused: ${f.paused!.reason}`
            : state === "budget"
              ? `On, but the budget of ${perDay} wake turn(s) per 24 hours is used.`
              : state === "running"
                ? "A wake turn is running in the Assistant."
                : `On: when task attention waits that the Assistant has not been given, ORBIT may start one bounded Assistant turn (at most ${perDay} per 24 hours, at least ${Math.round(minInterval / 60_000)} minutes apart, no paid fallback, nothing approved).`;
    return {
      state,
      detail,
      operatorOn: d.enabled,
      optedIn: f.optIn?.enabled === true,
      changed: f.optIn ? { at: f.optIn.changedAt, by: f.optIn.changedBy.actor === "human" ? "Rai" : f.optIn.changedBy.actor } : null,
      paused: f.paused ? { at: f.paused.at, reason: f.paused.reason, by: f.paused.by.actor === "human" ? "Rai" : "ORBIT" } : null,
      budget: { last24h: used, perDay, perDayLimit: WAKE_PER_DAY_LIMIT, minIntervalMinutes: Math.round(minInterval / 60_000), triesPerItem: WAKE_TRIES_PER_ITEM, counts: "wake turns started, not model spend; each is bounded by its tool rounds and has no paid fallback" },
      pending: c ? { undelivered: c.eligible.length + c.exhausted, waitingForRai: c.exhausted } : null,
      last: last ? { n: last.n, state: last.state, startedAt: last.startedAt, endedAt: last.endedAt ?? null, items: last.items.length, error: last.error ?? null } : null,
      consecutiveFailures: f.consecutiveFailures,
      persisted: d.backend.persisted,
    };
  }

  // Rai's opt-in. Turning it on is a human owner action only; turning it off is also allowed to ORBIT itself (never needed so far).
  function setOptIn(enabled: boolean, by: Provenance, perDay?: unknown) {
    if (by.actor !== "human" || by.via === "sessions-ui") throw new TaskError(403, "Only Rai can turn the supervisor wake on or off, from its control. Nothing was changed.");
    const sent = perDay !== undefined && perDay !== null;
    if (enabled && sent && (typeof perDay !== "number" || !Number.isSafeInteger(perDay) || perDay < 1 || perDay > WAKE_PER_DAY_LIMIT)) throw new TaskError(400, `perDay must be a whole number from 1 to ${WAKE_PER_DAY_LIMIT}. Nothing was changed.`);
    const f = load();
    if (!enabled && !f.optIn?.enabled) return { changed: false, view: view() };
    mutate((x) => {
      const keep = x.optIn?.perDay ?? WAKE_PER_DAY_DEFAULT;
      x.optIn = { enabled, changedAt: now().toISOString(), changedBy: by, perDay: enabled && sent ? (perDay as number) : keep };
      if (enabled) x.consecutiveFailures = 0;
    });
    return { changed: true, view: view() };
  }
  function setPaused(paused: boolean, by: Provenance, reason?: unknown) {
    if (by.actor !== "human") throw new TaskError(403, "Only Rai can pause or resume the supervisor wake. Nothing was changed.");
    const f = load();
    if (paused === Boolean(f.paused)) return { changed: false, view: view() };
    mutate((x) => {
      if (paused) x.paused = { at: now().toISOString(), by, reason: cleanText(reason, 200) || "paused by Rai" };
      else {
        delete x.paused;
        x.consecutiveFailures = 0;
      }
    });
    return { changed: true, view: view() };
  }

  async function tick(): Promise<WakeTickReport> {
    const at = now();
    const rep = (outcome: WakeTickReport["outcome"], detail: string, wake?: number): WakeTickReport => ({ at: at.toISOString(), outcome, detail, ...(wake ? { wake } : {}) });
    if (!d.enabled) return rep("operator-off", "the operator switch is off");
    if (busy) return rep("running", "a wake turn is running");
    let f: WakeFile;
    let c: ReturnType<typeof candidates>;
    try {
      f = load();
      if (!f.optIn?.enabled) return rep("off", "Rai has not turned the supervisor wake on");
      if (f.paused) return rep("paused", f.paused.reason);
      if (f.wakes.some((w) => w.state === "running")) return rep("running", "a wake turn is recorded as running");
      const perDay = f.optIn.perDay;
      if (startedSince(f, at).length >= perDay) return rep("budget", `${perDay} wake turn(s) in the last 24 hours`);
      const last = f.wakes.filter((w) => w.state !== "not-run").at(-1);
      if (last && at.getTime() - Date.parse(last.startedAt) < minInterval) return rep("interval", `the last wake started at ${last.startedAt}`);
      c = candidates(f);
    } catch (e) {
      return rep("store-unavailable", e instanceof Error ? e.message.slice(0, 200) : "unavailable");
    }
    if (!c.eligible.length) return rep("nothing-pending", c.exhausted ? `${c.exhausted} undelivered item(s) already caused ${WAKE_TRIES_PER_ITEM} wakes each; they wait for Rai's next Assistant turn` : "no undelivered task attention");
    // The Assistant is busy (Rai is talking to it, or another tab): nothing is claimed, the attention stays pending.
    if (d.assistantBusy()) return rep("assistant-busy", "the Assistant has a reply in progress; nothing was claimed");
    const items = c.eligible.map(({ task, attention, key }) => ({ task, attention, key }));
    let n: number;
    try {
      n = mutate((x) => {
        x.seq += 1;
        for (const i of items) x.tries[i.key] = (x.tries[i.key] ?? 0) + 1;
        x.wakes = [...x.wakes, { n: x.seq, startedAt: at.toISOString(), state: "running" as const, items }].slice(-WAKE_KEPT);
        // Keep try counts only for items still waiting.
        const live = new Set(c.eligible.map((i) => i.key).concat(Object.keys(x.tries).filter((k) => (x.tries[k] ?? 0) >= WAKE_TRIES_PER_ITEM)));
        x.tries = Object.fromEntries(Object.entries(x.tries).filter(([k]) => live.has(k)).slice(-500));
        return x.seq;
      });
    } catch (e) {
      return rep("claim-failed", `the wake could not be recorded, so it was not started (${e instanceof Error ? e.message.slice(0, 160) : "error"})`);
    }
    busy = true;
    const tasksN = new Set(items.map((i) => i.task)).size;
    const text = `[ORBIT supervisor wake] Not from Rai. ORBIT started this Assistant turn because task attention is waiting that you have not been given yet (${items.length} item(s) on ${tasksN} task(s)), under Rai's opt-in (wake ${startedSince(load(), at).length} of ${f.optIn!.perDay} in 24 hours). Look at the task-activity block: answer or decline requests you can decide with task_respond, acknowledge what you looked at with task_attention_ack, and propose a launch only where a task request asks for one (Rai confirms every card). Nothing is approved by you or by this turn; do not mark anything done. Reply to Rai with a short summary of what needs him.`;
    log({ event: "supervisor_wake_started", wake: n, items: items.length, tasks: tasksN });
    const run = (async () => {
      let out: { error?: string; notStarted?: string; reply?: string };
      try {
        out = await d.turn(text);
      } catch (e) {
        out = { error: e instanceof Error ? e.message : "the wake turn failed" };
      } finally {
        busy = false;
      }
      try {
        mutate((x) => {
          const w = x.wakes.find((y) => y.n === n);
          if (!w) return;
          const endedAt = now().toISOString();
          if (out.notStarted) {
            // Nothing was sent: the claim is undone (its try counts returned), recorded as not run.
            Object.assign(w, { state: "not-run", endedAt, error: cleanText(out.notStarted, 300) });
            for (const i of w.items) if (x.tries[i.key]) x.tries[i.key] = Math.max(0, x.tries[i.key]! - 1);
            return;
          }
          Object.assign(w, { state: out.error ? "error" : "done", endedAt, ...(out.error ? { error: cleanText(out.error, 300) } : {}), ...(out.reply ? { reply: cleanText(out.reply, 400) } : {}) });
          x.consecutiveFailures = out.error ? x.consecutiveFailures + 1 : 0;
          if (x.consecutiveFailures >= WAKE_FAILURES_PAUSE && !x.paused) x.paused = { at: endedAt, by: { actor: "orbit", via: "system" }, reason: `${x.consecutiveFailures} wake turns in a row ended in an error (last: ${cleanText(out.error ?? "", 160)}); paused until Rai resumes it` };
        });
      } catch (e) {
        log({ event: "supervisor_wake_record_failed", wake: n, detail: e instanceof Error ? e.message.slice(0, 200) : "error" });
      }
      log({ event: "supervisor_wake_ended", wake: n, state: out.notStarted ? "not-run" : out.error ? "error" : "done" });
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
    return rep("started", `wake ${n} started for ${items.length} item(s)`, n);
  }

  return {
    enabled: d.enabled,
    recover,
    view,
    setOptIn,
    setPaused,
    tick,
    problem: () => problem,
    idle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    start(everyMs = WAKE_TICK_MS) {
      if (!d.enabled || timer || everyMs <= 0) return;
      timer = setInterval(() => void tick().catch((e) => log({ event: "supervisor_wake_tick_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "error" })), everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
export type SupervisorWake = ReturnType<typeof supervisorWake>;
