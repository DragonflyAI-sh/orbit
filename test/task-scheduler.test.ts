import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { taskScheduler } from "../src/task-scheduler.ts";
import { taskSupervisor } from "../src/task-supervisor.ts";
import { AUTO_ATTEMPTS_MAX, AUTO_RETRY_BACKOFF_MS, autoEligibility, parseCreate, TaskError, taskFile, taskStore } from "../src/tasks.ts";
import type { Observers, Provenance, TaskBackend, Tasks } from "../src/tasks.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";

// Automatic task follow-up (docs/adr/0003-supervised-tasks.md, "Automatic follow-up"), deterministic: a fake clock, the real task store
// on a temporary directory, the real thread store and turn code, the real supervisor, a scripted model that counts its calls, and the
// scheduler ticked by the test (never on a timer). Synthetic data only.

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const HUMAN: Provenance = { actor: "human", via: "task-panel" };
const ASSISTANT: Provenance = { actor: "assistant", via: "assistant-tool" };
const INPUT = { title: "Garden sensor report", goal: "A weekly CSV of synthetic garden sensor readings exists.", acceptance: ["The CSV has one row per sensor per day"] };
const noObs: Observers = { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) };
const tmp = () => mkdtempSync(join(tmpdir(), "orbit-followup-"));
const code = (n: number, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === n && (!re || re.test(e.message));

function failing(dir: string) {
  const inner = taskFile(dir);
  const ctl = { fail: false };
  const backend: TaskBackend = {
    persisted: true,
    load: () => inner.load(),
    save: (f) => {
      if (ctl.fail) throw new Error("ENOSPC: no space left on device");
      inner.save(f);
    },
  };
  return { backend, ctl };
}

type RigOpts = { dir?: string; enabled?: boolean; maxConcurrent?: number; globalPerDay?: number; hold?: boolean };
function rig(o: RigOpts = {}) {
  const dir = o.dir ?? tmp();
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const disk = failing(dir);
  const tasks = taskStore(disk.backend, now);
  const threads = threadStore(join(dir, "threads"));
  const model = { calls: 0 };
  const fake: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/scripted", detail: "test", verifiedAt: now().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (): Promise<Step> => {
      model.calls += 1;
      return { text: "Checked the exporter; next: write the totals test.", calls: [] };
    },
  };
  const svc = threadService({ threads, model: fake, proposals: newProposals(), compact: false });
  // `gate`: holds a supervised turn in its prepare step (recorded running, nothing sent to the model) until released.
  const gate = { held: o.hold === true, release: undefined as (() => void) | undefined, entered: 0 };
  const sup = taskSupervisor({
    tasks,
    createThread: (title) => threads.create(title, { taskSession: true }).id,
    threadBusy: (tid) => threads.isBusy(tid),
    threadExists: (tid) => Boolean(threads.get(tid)),
    turn: (tid, text, prep, opts) => svc.turn(tid, text, prep, opts),
    prepare: async () => {
      if (gate.held) {
        gate.entered += 1;
        await new Promise<void>((resolve) => (gate.release = resolve));
      }
      return { used: [], current: [], offered: [] };
    },
    allowChat: () => () => undefined,
    decide: () => ({ allow: true, reason: "test" }),
    observers: noObs,
    linkable: () => ({ ok: false, why: "test" }),
    modelName: () => "fake/scripted",
    canUseTools: () => true,
    now,
    maxConcurrent: o.maxConcurrent ?? 2,
    followUps: { enabled: o.enabled !== false, globalPerDay: o.globalPerDay ?? 10 },
    log: () => {},
  });
  const sched = taskScheduler({ tasks, supervisor: sup, enabled: o.enabled !== false, globalPerDay: o.globalPerDay ?? 10, now, log: () => {} });
  const create = (extra: Record<string, unknown> = {}) => tasks.create(parseCreate({ ...INPUT, ...extra } as never, now()), ASSISTANT, () => threads.create("Task: x", { taskSession: true }).id).task;
  // A task with a follow-up due in 10 minutes, opted in by Rai.
  const optedIn = (extra: Record<string, unknown> = {}, perDay?: number) => {
    const t = create({ followUpAt: new Date(clock.t + 10 * MIN).toISOString(), ...extra });
    return tasks.setAuto(t.id, t.rev, true, HUMAN, perDay);
  };
  const advance = (ms: number) => (clock.t += ms);
  const at = (id: string) => sup.view(tasks.get(id)!).automaticFollowUp;
  return { dir, clock, now, advance, tasks, threads, model, sup, sched, gate, disk, create, optedIn, at };
}

test("follow-up: not due, then due: exactly one bounded supervised turn through the normal path, recorded as ORBIT's follow-up, and the due time is consumed", async () => {
  const r = rig();
  const t = r.optedIn();
  assert.equal(r.at(t.id).state, "not-due");
  assert.equal(r.at(t.id).nextAt, new Date(T0 + 10 * MIN).toISOString());
  assert.deepEqual((await r.sched.tick()).started, []);
  r.advance(10 * MIN);
  const rep = await r.sched.tick();
  assert.equal(rep.started.length, 1);
  await r.sup.idle();
  const after = r.tasks.get(t.id)!;
  const turn = after.turns.at(-1)!;
  assert.equal(turn.state, "done");
  assert.deepEqual(turn.trigger, { actor: "orbit", via: "follow-up", dueAt: new Date(T0 + 10 * MIN).toISOString() });
  assert.equal(r.model.calls, 1);
  assert.deepEqual({ state: after.auto!.slot!.state, turn: after.auto!.slot!.turn, outcome: after.auto!.slot!.outcome }, { state: "ended", turn: turn.n, outcome: "done" });
  // The supervised prompt is ORBIT's (authored orbit-supervisor), never Rai's.
  const msgs = r.threads.get(after.session.thread)!.messages;
  assert.equal(msgs[0]!.author, "orbit-supervisor");
  // Consumed: further ticks, now or a day later, start nothing for the same due time. No self-rescheduling.
  r.advance(25 * 60 * MIN);
  assert.deepEqual((await r.sched.tick()).started, []);
  assert.equal(r.tasks.get(t.id)!.turns.length, 1);
  assert.equal(r.at(t.id).state, "ended");
  // A new follow-up time (set by Rai or the Assistant, never by the task) is a new due time.
  const cur = r.tasks.get(t.id)!;
  r.tasks.update(t.id, cur.rev, { followUpAt: r.now().toISOString() }, ASSISTANT);
  assert.equal((await r.sched.tick()).started.length, 1);
  await r.sup.idle();
  assert.equal(r.tasks.get(t.id)!.turns.length, 2);
});

test("follow-up: off by default, including tasks that already have follow-up times; the operator switch off starts nothing even when a task is opted in", async () => {
  const r = rig();
  const plain = r.create({ followUpAt: new Date(T0 + MIN).toISOString() });
  r.advance(2 * MIN);
  assert.equal(r.at(plain.id).state, "off");
  assert.equal(r.at(plain.id).optedIn, false);
  assert.deepEqual((await r.sched.tick()).started, []);
  assert.equal(r.tasks.get(plain.id)!.turns.length, 0);
  // A version 2 file written by the previous build: follow-up set, no `auto` field. Read as off.
  const dir = tmp();
  const legacy = rig({ dir });
  const lt = legacy.create({ followUpAt: new Date(T0 + MIN).toISOString() });
  const file = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
  assert.equal(file.tasks[0].auto, undefined);
  const reread = rig({ dir });
  reread.advance(5 * MIN);
  assert.deepEqual((await reread.sched.tick()).started, []);
  assert.equal(reread.tasks.get(lt.id)!.turns.length, 0);
  // The operator switch off: an opted-in, due task starts nothing, and the view says why.
  const off = rig({ enabled: false });
  const t = off.optedIn();
  off.advance(11 * MIN);
  assert.equal((await off.sched.tick()).skipped, "scheduler-off");
  assert.equal(off.tasks.get(t.id)!.turns.length, 0);
  assert.equal(off.at(t.id).state, "scheduler-off");
  assert.equal(off.at(t.id).nextAt, null);
});

test("follow-up: only Rai (an owner route) can turn it on; the Assistant and the task cannot, Rai's message in the session cannot; the Assistant can turn it off", async () => {
  const r = rig();
  const t = r.create({ followUpAt: new Date(T0 + MIN).toISOString() });
  assert.throws(() => r.tasks.setAuto(t.id, t.rev, true, ASSISTANT), code(403, /Only Rai/));
  assert.throws(() => r.tasks.setAuto(t.id, t.rev, true, { actor: "task", via: "task-turn", turn: 1 }), code(403));
  assert.throws(() => r.tasks.setAuto(t.id, t.rev, true, { actor: "orbit", via: "system" }), code(403));
  assert.throws(() => r.tasks.setAuto(t.id, t.rev, true, { actor: "human", via: "sessions-ui" }), code(403), "a message written in the session is model-facing text, not the control");
  assert.throws(() => r.tasks.setAuto(t.id, t.rev, true, HUMAN, 7), code(400, /1 to 6/));
  // The Assistant's tool: turning on is refused by name; off works.
  const tools = r.sup.assistantTools(true);
  const update = tools.find((x) => x.name === "task_update")!;
  await assert.rejects(update.run({ id: t.id, rev: t.rev, autoFollowUp: "on" }), /Only Rai can turn on automatic follow-up/);
  assert.equal(r.tasks.get(t.id)!.auto, undefined);
  const on = r.tasks.setAuto(t.id, t.rev, true, HUMAN, 3);
  assert.equal(on.auto!.perDay, 3);
  await update.run({ id: t.id, rev: on.rev, autoFollowUp: "off" });
  assert.equal(r.tasks.get(t.id)!.auto!.enabled, false);
  assert.equal(r.tasks.get(t.id)!.auto!.changedBy.actor, "assistant");
  // The task's own tools have no follow-up control at all.
  assert.deepEqual(r.sup.turnTools(t.id, () => 1).map((x) => x.name), ["task_request", "task_add_evidence", "task_set_next_action"]);
});

test("follow-up: pause, cancel and done stop it at once; disabling stops it; a pause or disable during prepare means the turn is never sent to the model", async () => {
  const r = rig();
  const a = r.optedIn();
  const b = r.optedIn({ title: "Second" });
  const c = r.optedIn({ title: "Third" });
  r.tasks.setLifecycle(a.id, r.tasks.get(a.id)!.rev, "paused", HUMAN);
  r.tasks.setLifecycle(b.id, r.tasks.get(b.id)!.rev, "cancelled", HUMAN);
  r.tasks.setAuto(c.id, r.tasks.get(c.id)!.rev, false, ASSISTANT);
  r.advance(11 * MIN);
  assert.deepEqual((await r.sched.tick()).started, []);
  assert.equal(r.at(a.id).state, "inactive");
  assert.equal(r.at(c.id).state, "off");
  // Done (Rai attests and completes): not eligible either.
  const d = r.optedIn({ title: "Fourth", followUpAt: new Date(r.clock.t + MIN).toISOString() });
  r.tasks.addEvidence(d.id, { criterion: "ac1", kind: "note", ref: "checked by Rai" }, HUMAN, r.tasks.get(d.id)!.rev);
  r.tasks.complete(d.id, r.tasks.get(d.id)!.rev, HUMAN, noObs);
  r.advance(2 * MIN);
  assert.deepEqual((await r.sched.tick()).started, []);
  assert.equal(r.tasks.get(d.id)!.turns.length, 0);
  // Resumed: the due follow-up runs at the next tick.
  r.tasks.setLifecycle(a.id, r.tasks.get(a.id)!.rev, "active", HUMAN);
  // Held in prepare, then paused: recorded as not run, the model never called.
  r.gate.held = true;
  const started = await r.sched.tick();
  assert.deepEqual(started.started.map((s) => s.task), [a.id]);
  r.tasks.setLifecycle(a.id, r.tasks.get(a.id)!.rev, "paused", HUMAN);
  r.sup.stop(a.id);
  r.gate.release!();
  await r.sup.idle();
  const turn = r.tasks.get(a.id)!.turns.at(-1)!;
  assert.equal(turn.state, "error");
  assert.match(turn.error!, /Not run: the task became paused before the turn was sent to the model/);
  assert.equal(r.model.calls, 0);
  // Disabled while held in prepare: same.
  const e = r.optedIn({ title: "Fifth", followUpAt: new Date(r.clock.t + MIN).toISOString() });
  r.advance(2 * MIN);
  await r.sched.tick();
  r.tasks.setAuto(e.id, r.tasks.get(e.id)!.rev, false, HUMAN);
  r.gate.release!();
  await r.sup.idle();
  assert.match(r.tasks.get(e.id)!.turns.at(-1)!.error!, /automatic follow-up was turned off before the turn was sent/);
  assert.equal(r.model.calls, 0);
});

test("follow-up: duplicate and overlapping ticks start one turn; a manual start racing the scheduler: exactly one turn runs", async () => {
  const r = rig({ hold: true });
  const t = r.optedIn();
  r.advance(11 * MIN);
  const [x, y] = await Promise.all([r.sched.tick(), r.sched.tick()]);
  assert.equal(x.started.length + y.started.length, 1);
  assert.equal(y.skipped ?? x.skipped, "tick-in-progress");
  // Ticks while the turn is running (held): nothing more.
  for (let i = 0; i < 3; i++) assert.deepEqual((await r.sched.tick()).started, []);
  assert.equal(r.tasks.get(t.id)!.turns.length, 1);
  // A manual start while the automatic turn holds the task: refused, as for any second turn.
  await assert.rejects(r.sup.startTurn(t.id, { trigger: HUMAN, isOwner: true, expectRev: r.tasks.get(t.id)!.rev }), code(409, /already running/));
  r.gate.held = false;
  r.gate.release!();
  await r.sup.idle();
  assert.equal(r.model.calls, 1);
  // The other order: a manual turn holds the task when the follow-up comes due; the tick waits (not an attempt), then runs once.
  const u = r.optedIn({ title: "Second", followUpAt: new Date(r.clock.t + MIN).toISOString() });
  r.gate.held = true;
  const manual = await r.sup.startTurn(u.id, { trigger: HUMAN, isOwner: true, expectRev: r.tasks.get(u.id)!.rev });
  r.advance(2 * MIN);
  const waiting = await r.sched.tick();
  assert.deepEqual(waiting.started, []);
  assert.equal(r.at(u.id).state, "turn-running");
  assert.equal(r.tasks.get(u.id)!.auto!.slot, undefined, "waiting for a running turn is not a failed attempt");
  r.gate.held = false;
  r.gate.release!();
  await manual.done;
  assert.equal((await r.sched.tick()).started.length, 1);
  await r.sup.idle();
  assert.equal(r.tasks.get(u.id)!.turns.length, 2);
});

test("follow-up: Rai writing in the task session at the due time: serialized with the follow-up, never both", async () => {
  const r = rig();
  const t = r.optedIn();
  r.advance(11 * MIN);
  // Rai's interactive turn is admitted first (it records a running turn); the tick then waits.
  const base = { memory: [], limits: [], tools: [], isOwner: true };
  r.gate.held = false;
  const human = r.sup.humanTurn(t.id, "Use metric units.", base);
  const during = await r.sched.tick();
  assert.deepEqual(during.started, []);
  await human;
  assert.equal((await r.sched.tick()).started.length, 1);
  await r.sup.idle();
  assert.deepEqual(r.tasks.get(t.id)!.turns.map((x) => [x.trigger.actor, x.state]), [["human", "done"], ["orbit", "done"]]);
  // And the automatic turn saw Rai's instruction.
  assert.equal(r.tasks.get(t.id)!.turns.at(-1)!.instructionsSeen, 1);
});

// Repair 3 (finding b on PR #154): the global turn cap is CAPACITY, not failure. It used to consume the attempt budget (4 attempts, then
// gave-up); now it is a deferral that uses no attempt, waits for the next tick (no hot loop) and starts as soon as a slot frees.
test("follow-up: the global turn cap is a capacity deferral: no attempt used however long it lasts, never dispatched while full, started at the first tick after a slot frees", async () => {
  const r = rig({ maxConcurrent: 1, hold: true });
  const blocker = r.create({ title: "Busy" });
  const busy = await r.sup.startTurn(blocker.id, { trigger: HUMAN, isOwner: true, expectRev: blocker.rev });
  const t = r.optedIn();
  const rev = r.tasks.get(t.id)!.rev;
  r.advance(11 * MIN);
  // Far more ticks than the old attempt cap, over hours: each defers, none uses an attempt, none gives up.
  for (let i = 1; i <= AUTO_ATTEMPTS_MAX * 3; i++) {
    const rep = await r.sched.tick();
    assert.deepEqual(rep.started, []);
    assert.deepEqual(rep.gaveUp, []);
    assert.deepEqual(rep.retrying, []);
    assert.equal(rep.deferred.length, 1, `tick ${i}`);
    const v = r.at(t.id);
    assert.equal(v.state, "capacity-wait");
    assert.equal(v.lastAttempt!.attempts, 0, "a capacity deferral is not an attempt");
    assert.equal(r.tasks.get(t.id)!.auto!.slot!.deferrals, i);
    r.advance(20 * MIN);
  }
  assert.equal(r.tasks.get(t.id)!.turns.length, 0, "nothing was dispatched while every slot was busy");
  assert.equal(r.tasks.get(t.id)!.rev, rev, "deferral bookkeeping never makes a view stale");
  assert.ok(!(r.tasks.get(t.id)!.attention ?? []).length, "capacity alone raises no attention item");
  // A slot frees: the very next tick starts it, with its first attempt.
  r.gate.held = false;
  r.gate.release!();
  await busy.done;
  const rep = await r.sched.tick();
  assert.equal(rep.started.length, 1);
  await r.sup.idle();
  const slot = r.tasks.get(t.id)!.auto!.slot!;
  assert.equal(slot.state, "ended");
  assert.equal(slot.attempts, 1);
  assert.equal(slot.deferrals, AUTO_ATTEMPTS_MAX * 3, "the deferrals stay on record");
});

test("follow-up: a failure that is not transient (the session is gone, the model cannot call tools) gives up at once", async () => {
  const r = rig();
  // A task whose session thread does not exist (its id names no thread in the store).
  const ghost = r.tasks.create(parseCreate({ ...INPUT, title: "Ghost", followUpAt: new Date(r.clock.t + MIN).toISOString() } as never, r.now()), ASSISTANT, () => "00000000-0000-4000-8000-000000000000").task;
  r.tasks.setAuto(ghost.id, ghost.rev, true, HUMAN);
  r.advance(11 * MIN);
  const rep = await r.sched.tick();
  assert.ok(rep.gaveUp.some((g) => g.task === ghost.id && /no longer exists/.test(g.error)), JSON.stringify(rep));
  assert.equal(r.at(ghost.id).lastAttempt!.attempts, 1);
});

test("follow-up: budgets: per task per 24 hours, and across tasks; exhausted is visible with when it frees; budgets count turns, not spend", async () => {
  const r = rig({ globalPerDay: 2 });
  const t = r.optedIn({}, 1);
  r.advance(11 * MIN);
  assert.equal((await r.sched.tick()).started.length, 1);
  await r.sup.idle();
  r.tasks.update(t.id, r.tasks.get(t.id)!.rev, { followUpAt: r.now().toISOString() }, HUMAN);
  assert.deepEqual((await r.sched.tick()).started, []);
  const v = r.at(t.id);
  assert.equal(v.state, "budget-task");
  assert.equal(v.nextAt, new Date(T0 + 11 * MIN + 24 * 60 * MIN).toISOString());
  assert.match(v.budget.counts, /not model spend/);
  // Global: two other tasks, one slot left across ORBIT.
  const a = r.optedIn({ title: "A", followUpAt: new Date(r.clock.t + MIN).toISOString() });
  const b = r.optedIn({ title: "B", followUpAt: new Date(r.clock.t + MIN).toISOString() });
  r.advance(2 * MIN);
  const rep = await r.sched.tick();
  await r.sup.idle();
  assert.equal(rep.started.length, 1);
  const other = rep.started[0]!.task === a.id ? b.id : a.id;
  assert.equal(r.at(other).state, "budget-global");
  // A day later the windows free up.
  r.advance(24 * 60 * MIN);
  const later = await r.sched.tick();
  await r.sup.idle();
  assert.deepEqual(later.started.map((s) => s.task).sort(), [t.id, other].sort());
});

test("follow-up: restart around claim, start and result: nothing persisted before the claim, an interrupted turn is never re-run, a recorded result stays consumed", async () => {
  // 1. Crash (here: the write fails) at the claim: nothing persisted, nothing dispatched; after the restart it starts once.
  const dir = tmp();
  let r = rig({ dir });
  const t = r.optedIn();
  r.advance(11 * MIN);
  const before = readFileSync(join(dir, "tasks.json"), "utf8");
  r.disk.ctl.fail = true;
  const failed = await r.sched.tick();
  assert.deepEqual(failed.started, []);
  assert.equal(failed.unrecorded.length, 1, "the attempt could not be recorded either: the next tick sees the same state");
  assert.equal(readFileSync(join(dir, "tasks.json"), "utf8"), before, "nothing was written");
  assert.equal(r.model.calls, 0);
  r = rig({ dir, hold: true });
  r.advance(11 * MIN);
  assert.equal((await r.sched.tick()).started.length, 1);
  // 2. Crash while that turn runs (held in prepare; the claim and the running turn are on disk). Restart: interrupted, not re-run.
  let after = rig({ dir });
  after.advance(12 * MIN);
  assert.deepEqual(after.tasks.recover(), [t.id]);
  const rec = after.tasks.get(t.id)!;
  assert.equal(rec.turns.at(-1)!.state, "interrupted");
  assert.equal(rec.auto!.slot!.state, "interrupted");
  for (let i = 0; i < 3; i++) assert.deepEqual((await after.sched.tick()).started, []);
  assert.equal(after.at(t.id).state, "interrupted");
  assert.match(after.at(t.id).detail, /not re-run automatically/);
  assert.equal(after.model.calls, 0);
  // The explicit retry: a new follow-up time.
  after.tasks.update(t.id, after.tasks.get(t.id)!.rev, { followUpAt: after.now().toISOString() }, HUMAN);
  assert.equal((await after.sched.tick()).started.length, 1);
  await after.sup.idle();
  assert.equal(after.tasks.get(t.id)!.auto!.slot!.state, "ended");
  // 3. Restart after the result was recorded: consumed, nothing starts.
  after = rig({ dir });
  after.advance(30 * MIN);
  assert.deepEqual(after.tasks.recover(), []);
  assert.deepEqual((await after.sched.tick()).started, []);
  assert.equal(after.tasks.get(t.id)!.turns.length, 2);
  // (The first rig's held turn stands for the process that stopped: it is never released.)
});

test("follow-up: the claim is rechecked inside the store change: a stale eligibility decision cannot start a turn", () => {
  const r = rig();
  const t = r.optedIn();
  r.advance(11 * MIN);
  const dueAt = r.tasks.get(t.id)!.followUp!.at;
  assert.equal(autoEligibility(r.tasks.get(t.id)!, r.now(), { used: 0, max: 10 }).eligible, true);
  // Paused between the scheduler's look and its start.
  r.tasks.setLifecycle(t.id, r.tasks.get(t.id)!.rev, "paused", HUMAN);
  assert.throws(() => r.tasks.beginTurn(t.id, undefined, { actor: "orbit", via: "follow-up", dueAt }, "fake", undefined, { dueAt, globalMax: 10 }), code(409, /Automatic follow-up not started: the task is paused/));
  r.tasks.setLifecycle(t.id, r.tasks.get(t.id)!.rev, "active", HUMAN);
  // A due time that is not the task's current one (changed meanwhile).
  assert.throws(() => r.tasks.beginTurn(t.id, undefined, { actor: "orbit", via: "follow-up", dueAt }, "fake", undefined, { dueAt: new Date(T0).toISOString(), globalMax: 10 }), code(409));
  // Claimed once; the same claim again is refused.
  r.tasks.beginTurn(t.id, undefined, { actor: "orbit", via: "follow-up", dueAt }, "fake", undefined, { dueAt, globalMax: 10 });
  assert.throws(() => r.tasks.beginTurn(t.id, undefined, { actor: "orbit", via: "follow-up", dueAt }, "fake", undefined, { dueAt, globalMax: 10 }), code(409));
  assert.equal(r.tasks.get(t.id)!.turns.length, 1);
});
