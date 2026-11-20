import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { taskScheduler } from "../src/task-scheduler.ts";
import { taskSupervisor } from "../src/task-supervisor.ts";
import { AUTO_ATTEMPTS_MAX, AUTO_RETRY_BACKOFF_MS, parseCreate, TaskError, taskFile, taskStore } from "../src/tasks.ts";
import type { Observers, Provenance, TaskBackend } from "../src/tasks.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";

// Repair 3, Priority 1: the four review findings reported on PR #154, each reproduced on main at 4b39cb4 before the fix (see the ADR,
// "Repair 3"), with regression tests for races, retries and restart. Deterministic: a fake clock, the real task store on a temporary
// directory, the real thread store, turn code, supervisor and scheduler, and a scripted model. Synthetic data only.

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const HUMAN: Provenance = { actor: "human", via: "task-panel" };
const ASSISTANT: Provenance = { actor: "assistant", via: "assistant-tool" };
const INPUT = { title: "Garden sensor report", goal: "A weekly CSV of synthetic garden sensor readings exists.", acceptance: ["The CSV has one row per sensor per day"] };
const noObs: Observers = { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) };
const code = (n: number, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === n && (!re || re.test(e.message));

function rig(o: { dir?: string; maxConcurrent?: number; hold?: boolean; enabled?: boolean } = {}) {
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
    observers: noObs,
    linkable: () => ({ ok: false, why: "test" }),
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

// ---- finding (a): task_update persisted its other fields, then errored, when automatic follow-up was already off ----

test("finding a: task_update with other fields and autoFollowUp off, when it is already off: one atomic change, no error, the already-off part is a no-op", async () => {
  const r = rig();
  const t = r.create();
  const out = (await r.tool("task_update").run({ id: t.id, rev: t.rev, nextAction: "Write the totals test", autoFollowUp: "off" })) as { value: any };
  assert.equal(out.value.changed, true);
  assert.match(out.value.notes[0], /already off/);
  const after = r.tasks.get(t.id)!;
  assert.equal(after.nextAction!.text, "Write the totals test");
  assert.equal(after.rev, t.rev + 1, "exactly one change");
  assert.equal(after.auto, undefined, "nothing about automatic follow-up was invented");
});

test("finding a: autoFollowUp off alone, when already off, is idempotent: no write, no rev bump, no error, even from a stale view", async () => {
  const r = rig();
  const t = r.create();
  const before = r.file();
  const saves = r.disk.saves;
  for (const rev of [t.rev, t.rev + 7]) {
    const u = r.tasks.updateDetailed(t.id, rev, { autoFollowUp: "off" }, ASSISTANT);
    assert.equal(u.changed, false);
    assert.equal(u.task.rev, t.rev);
  }
  // The dedicated control is idempotent too, for Rai and for the Assistant.
  assert.equal(r.tasks.setAutoDetailed(t.id, t.rev, false, HUMAN).changed, false);
  assert.equal(r.tasks.setAutoDetailed(t.id, t.rev, false, ASSISTANT).changed, false);
  assert.equal(r.disk.saves, saves, "nothing was written");
  assert.equal(r.file(), before);
});

test("finding a: a combined update that turns follow-up off while it is on applies both in ONE rev; a refusal anywhere applies nothing", async () => {
  const r = rig();
  const t = r.optedIn();
  const u = r.tasks.updateDetailed(t.id, t.rev, { nextAction: "Check totals", autoFollowUp: "off" }, ASSISTANT);
  assert.equal(u.task.rev, t.rev + 1);
  assert.equal(u.task.auto!.enabled, false);
  assert.equal(u.task.nextAction!.text, "Check totals");
  // Invalid vault link in the same patch: nothing of it is saved, not the next action, not the follow-up time.
  const before = r.file();
  assert.throws(() => r.tasks.update(t.id, u.task.rev, { nextAction: "Other", followUpAt: new Date(r.clock.t + 99 * MIN).toISOString(), vaultNote: "../etc/passwd", vaultHeading: "## S" }, ASSISTANT), code(400));
  assert.equal(r.file(), before);
  assert.equal(r.tasks.get(t.id)!.nextAction!.text, "Check totals");
  // A write failure in the middle of a combined update changes nothing in memory either.
  r.disk.fail = true;
  assert.throws(() => r.tasks.update(t.id, u.task.rev, { nextAction: "Lost", project: "p" }, ASSISTANT), /ENOSPC/);
  r.disk.fail = false;
  assert.equal(r.tasks.get(t.id)!.nextAction!.text, "Check totals");
  assert.equal(r.tasks.get(t.id)!.project, undefined);
});

test("finding a: two racing updates from the same view: exactly one applies, the other is refused as stale and changes nothing", async () => {
  const r = rig();
  const t = r.optedIn();
  const results = await Promise.allSettled([Promise.resolve().then(() => r.tasks.update(t.id, t.rev, { nextAction: "A", autoFollowUp: "off" }, ASSISTANT)), Promise.resolve().then(() => r.tasks.update(t.id, t.rev, { nextAction: "B" }, HUMAN))]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.ok(results.some((x) => x.status === "rejected" && code(409, /stale/)(x.reason)));
  const after = r.tasks.get(t.id)!;
  assert.equal(after.rev, t.rev + 1);
  assert.equal(after.nextAction!.text, "A");
  assert.equal(after.auto!.enabled, false, "the winner's whole patch, including the off switch");
});

// ---- finding (c): turning automatic follow-up off and on reset Rai's custom daily budget ----

test("finding c: Rai's custom perDay survives off/on toggles (by Rai or the Assistant) and a restart; only a new perDay from Rai changes it", async () => {
  const r = rig();
  let t = r.optedIn({}, 5);
  assert.equal(t.auto!.perDay, 5);
  t = r.tasks.setAuto(t.id, t.rev, false, ASSISTANT);
  t = r.tasks.setAuto(t.id, t.rev, true, HUMAN);
  assert.equal(t.auto!.perDay, 5, "kept, not reset to the default");
  t = r.tasks.updateDetailed(t.id, t.rev, { autoFollowUp: "off" }, HUMAN).task;
  // Restart: a new store over the same file.
  const again = taskStore(taskFile(r.dir), r.now);
  let u = again.get(t.id)!;
  assert.equal(u.auto!.perDay, 5);
  u = again.setAuto(u.id, u.rev, true, HUMAN);
  assert.equal(u.auto!.perDay, 5);
  assert.deepEqual(u.auto!.perDaySetBy, HUMAN);
  u = again.setAuto(u.id, u.rev, true, HUMAN, 1);
  assert.equal(u.auto!.perDay, 1, "an explicit new perDay from Rai changes it");
});

test("finding c: toggling never resets usage: automatic turns already started still count against the 24-hour budget", async () => {
  const r = rig();
  let t = r.optedIn({}, 1);
  r.advance(11 * MIN);
  assert.equal((await r.sched.tick()).started.length, 1);
  await r.sup.idle();
  t = r.tasks.get(t.id)!;
  t = r.tasks.update(t.id, t.rev, { followUpAt: new Date(r.clock.t + MIN).toISOString() }, HUMAN);
  t = r.tasks.setAuto(t.id, t.rev, false, HUMAN);
  t = r.tasks.setAuto(t.id, t.rev, true, HUMAN);
  assert.equal(t.auto!.started.length, 1);
  r.advance(2 * MIN);
  const rep = await r.sched.tick();
  assert.deepEqual(rep.started, []);
  assert.equal(r.sup.view(r.tasks.get(t.id)!).automaticFollowUp.state, "budget-task");
  assert.equal(r.model.calls, 1);
});

// ---- finding (d): turning automatic follow-up off validated an irrelevant perDay ----

test("finding d: turning off ignores perDay entirely (any value, any type), says so, and never applies it; turning on with a bad perDay changes nothing", async () => {
  const r = rig();
  let t = r.optedIn({}, 3);
  for (const bad of [99, -1, 1.5, "lots", { n: 1 }]) {
    t = r.tasks.get(t.id)!;
    if (!t.auto!.enabled) t = r.tasks.setAuto(t.id, t.rev, true, HUMAN);
    const off = r.tasks.setAutoDetailed(t.id, t.rev, false, HUMAN, bad);
    assert.equal(off.changed, true);
    assert.deepEqual(off.ignored, ["perDay"]);
    assert.equal(off.task.auto!.enabled, false);
    assert.equal(off.task.auto!.perDay, 3, "the ignored value was not applied");
  }
  // Already off, with junk: still a quiet success.
  t = r.tasks.get(t.id)!;
  assert.equal(r.tasks.setAutoDetailed(t.id, t.rev, false, HUMAN, "junk").changed, false);
  // Turning ON validates perDay, and a bad one leaves everything as it was (still off, perDay 3).
  const before = r.file();
  assert.throws(() => r.tasks.setAuto(t.id, t.rev, true, HUMAN, 99), code(400, /Nothing was changed/));
  assert.equal(r.file(), before);
  assert.equal(r.tasks.get(t.id)!.auto!.enabled, false);
});

// ---- finding (b): busy execution slots consumed the scheduler's retries ----

test("finding b: with every slot full the scheduler does not call startTurn at all (no hot loop of refused starts), and uses no attempt", async () => {
  const r = rig({ maxConcurrent: 1, hold: true });
  const busy = r.create({ title: "Busy" });
  await r.sup.startTurn(busy.id, { trigger: HUMAN, isOwner: true, expectRev: busy.rev });
  const ts = [r.optedIn({ title: "One" }), r.optedIn({ title: "Two" }), r.optedIn({ title: "Three" })];
  r.advance(11 * MIN);
  r.starts.n = 0;
  for (let i = 0; i < 5; i++) {
    const rep = await r.sched.tick();
    assert.equal(rep.deferred.length, 3);
    r.advance(MIN);
  }
  assert.equal(r.starts.n, 0, "a full ORBIT is checked once per due task, never asked for a turn it would refuse");
  for (const t of ts) assert.equal(r.tasks.get(t.id)!.auto!.slot!.attempts, 0);
  r.release();
  await r.sup.idle();
});

test("finding b: fairness: when one slot frees, the due time deferred longest starts first; later ones keep waiting without using attempts", async () => {
  const r = rig({ maxConcurrent: 1, hold: true });
  const busy = r.create({ title: "Busy" });
  await r.sup.startTurn(busy.id, { trigger: HUMAN, isOwner: true, expectRev: busy.rev });
  const early = r.optedIn({ title: "Early" });
  r.advance(5 * MIN);
  const late = r.optedIn({ title: "Late" });
  r.advance(20 * MIN);
  await r.sched.tick();
  // The busy turn ends; the next tick has one slot for two due tasks. Held again, so the started turn keeps its slot.
  r.release();
  await r.sup.idle();
  r.gate.held = true;
  const rep = await r.sched.tick();
  assert.deepEqual(rep.started.map((s) => s.task), [early.id]);
  assert.deepEqual(rep.deferred.map((s) => s.task), [late.id]);
  assert.equal(r.tasks.get(late.id)!.auto!.slot!.attempts, 0);
  r.release();
  await r.sup.idle();
  const rep2 = await r.sched.tick();
  assert.deepEqual(rep2.started.map((s) => s.task), [late.id]);
  await r.sup.idle();
});

test("finding b: the task's own session busy (Rai's reply in progress) is capacity too: deferred, not an attempt", async () => {
  const r = rig();
  const t = r.optedIn();
  r.advance(11 * MIN);
  const thread = r.tasks.get(t.id)!.session.thread;
  const tok = r.threads.tryBegin(thread)!;
  assert.ok(tok);
  const rep = await r.sched.tick();
  assert.equal(rep.deferred.length, 1);
  assert.match(rep.deferred[0]!.why, /reply in progress/);
  assert.equal(r.tasks.get(t.id)!.auto!.slot!.attempts, 0);
  r.threads.end(thread, tok);
  assert.equal((await r.sched.tick()).started.length, 1);
  await r.sup.idle();
});

test("finding b: a real pre-dispatch failure still uses attempts with backoff, then gives up once and raises one attention item", async () => {
  const r = rig();
  const t = r.optedIn();
  r.advance(11 * MIN);
  // A failure that is not ORBIT's own refusal (an unexpected error before the claim): transient, retried with backoff.
  const flaky = taskScheduler({ tasks: r.tasks, supervisor: { startTurn: async () => { throw new Error("EIO: thread store read failed"); }, capacity: () => ({ running: 0, max: 2 }) }, enabled: true, now: r.now, log: () => {} });
  for (let attempt = 1; attempt < AUTO_ATTEMPTS_MAX; attempt++) {
    const rep = await flaky.tick();
    assert.equal(rep.retrying.length, 1, `attempt ${attempt}`);
    assert.equal(r.tasks.get(t.id)!.auto!.slot!.attempts, attempt);
    r.advance(AUTO_RETRY_BACKOFF_MS[attempt - 1]! - 1000);
    assert.deepEqual((await flaky.tick()).retrying, [], "not before the backoff");
    r.advance(1000);
  }
  assert.equal((await flaky.tick()).gaveUp.length, 1);
  const att = r.tasks.get(t.id)!.attention!.filter((a) => a.kind === "follow-up-gave-up");
  assert.equal(att.length, 1);
  assert.equal(att[0]!.state, "open");
  await flaky.tick();
  assert.equal(r.tasks.get(t.id)!.attention!.filter((a) => a.kind === "follow-up-gave-up").length, 1, "deduplicated");
});

test("finding b: restart while deferred: the capacity-wait slot is on disk, the new process starts exactly one turn, and a second scheduler racing it starts none", async () => {
  const r = rig({ maxConcurrent: 1, hold: true });
  const busy = r.create({ title: "Busy" });
  await r.sup.startTurn(busy.id, { trigger: HUMAN, isOwner: true, expectRev: busy.rev });
  const t = r.optedIn();
  r.advance(11 * MIN);
  await r.sched.tick();
  assert.equal(JSON.parse(r.file()).tasks.find((x: { id: string }) => x.id === t.id).auto.slot.state, "capacity-wait");
  // "Restart": a new process over the same state directory. The busy turn was cut off (interrupted); the deferred one starts once.
  const b = rig({ dir: r.dir });
  b.clock.t = r.clock.t;
  b.tasks.recover();
  const both = await Promise.all([b.sched.tick(), b.sched.tick()]);
  assert.equal(both.reduce((n, x) => n + x.started.length, 0), 1);
  await b.sup.idle();
  const after = b.tasks.get(t.id)!;
  assert.equal(after.turns.length, 1);
  assert.equal(after.auto!.slot!.attempts, 1);
  assert.equal(after.auto!.slot!.deferrals, 1);
  // The interrupted turn of the other task is an attention item for the supervisor (raised by recovery).
  assert.ok(b.tasks.get(busy.id)!.attention!.some((a) => a.kind === "turn-interrupted" && a.state === "open"));
  r.release();
});
