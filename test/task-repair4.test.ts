import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ATTENTION_KEPT, ATTENTION_SHOWN_PER_TASK, ordered } from "../src/task-attention.ts";
import { runTaskEval, scenarioPathProblem, writeConfined } from "../src/task-eval.ts";
import type { EvalScenario } from "../src/task-eval.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { taskRouter } from "../src/task-routing.ts";
import { taskVaultSync } from "../src/task-vault.ts";
import type { TaskVaultPort } from "../src/task-vault.ts";
import { supervisorWake, WAKE_FAILURES_PAUSE, WAKE_MIN_INTERVAL_MS, WAKE_TRIES_PER_ITEM, wakeFile } from "../src/task-wake.ts";
import { AUTO_CAPACITY_ATTENTION_MS, taskFile, taskStore } from "../src/tasks.ts";
import type { Provenance, Task } from "../src/tasks.ts";
import { ASSISTANT, code, HUMAN, MIN, rig, T0 } from "./task-rig.ts";

// Repair 4 (docs/adr/0003-supervised-tasks.md, "Repair 4"): regression tests for the four review findings on PR #155, attention
// delivery across failed and interrupted Assistant turns, the opt-in supervisor wake, task-turn routing, and vault sync recovery.
// Unit level: the real task store, supervisor, thread store, turn code and scheduler over temporary directories, a scripted model and a
// fake clock. Synthetic data only.

const TASK_TURN = (n: number): Provenance => ({ actor: "task", via: "task-turn", turn: n });
const block = (r: ReturnType<typeof rig>) => {
  const a = r.sup.activity();
  return { data: JSON.parse(/\n(\{[\s\S]*\})\s*<\/orbit-data>/.exec(a.block!)![1]!), shown: a.shown };
};
// A completed Assistant turn: build, then deliver what it showed.
const completedTurn = (r: ReturnType<typeof rig>) => {
  const b = block(r);
  r.sup.delivered(b.shown);
  return b.data;
};
// ---- Finding 1 (blocking): historical acknowledged turn items hid newer attention ----

test("finding 1: reproduction: five acknowledged turn-failed items no longer push a new blocker out of the block; the blocker is first, new, and delivered", async () => {
  const r = rig({ hold: true });
  const t = r.create();
  for (let i = 0; i < 5; i++) {
    const cur = r.tasks.get(t.id)!;
    const s = await r.sup.startTurn(t.id, { trigger: ASSISTANT, isOwner: true, expectRev: cur.rev });
    r.sup.setLifecycle(t.id, r.tasks.get(t.id)!.rev, "paused", HUMAN);
    r.release();
    await s.done;
    r.gate.held = true;
    r.sup.setLifecycle(t.id, r.tasks.get(t.id)!.rev, "active", HUMAN);
  }
  const failed = r.tasks.get(t.id)!.attention!.filter((a) => a.kind === "turn-failed");
  assert.equal(failed.length, 5);
  for (const a of failed) {
    const ack = r.tasks.acknowledge(t.id, a.id, ASSISTANT, "looked at it");
    // Acknowledging a past turn outcome resolves it; the acknowledgement is kept on the item (audit history).
    assert.equal(ack.item.state, "resolved");
    assert.equal(ack.item.ack!.note, "looked at it");
    assert.match(ack.item.resolved!.why, /acknowledged by the Assistant: looked at it/);
  }
  r.tasks.fileRequest(t.id, { kind: "blocker", text: "Which sensors count?" }, TASK_TURN(9));
  const data = completedTurn(r);
  const row = data.shown.find((s: { id: string }) => s.id === t.id);
  assert.equal(row.attention[0].kind, "blocker", "the new blocker is shown, first");
  assert.equal(row.attention[0].new, true);
  assert.equal(row.attention.length, 1, "resolved turn items are no longer listed");
  const stored = r.tasks.get(t.id)!.attention!.find((a) => a.kind === "blocker")!;
  assert.equal(stored.surfaced!.count, 1, "delivered once its turn completed: no longer `new`");
  assert.equal(r.tasks.get(t.id)!.attention!.filter((a) => a.state === "resolved").length, 5, "history kept");
});

test("finding 1: ordering: undelivered requests first, then other undelivered items, then delivered ones, derived, acknowledged; oldest first within a group", () => {
  const items = [
    { id: "a", kind: "vault-sync", state: "acknowledged" as const, createdAt: "1" },
    { id: "b", kind: "turn-failed", state: "open" as const, new: false, createdAt: "2" },
    { id: "c", kind: "blocker", state: "open" as const, new: false, createdAt: "3" },
    { id: "d", kind: "launch-not-confirmed", derived: true, createdAt: "0" },
    { id: "e", kind: "budget", state: "open" as const, new: true, createdAt: "5" },
    { id: "f", kind: "job", state: "open" as const, new: true, createdAt: "6" },
    { id: "g", kind: "clarification", state: "open" as const, new: true, createdAt: "4" },
  ];
  assert.deepEqual(ordered(items).map((x) => x.id), ["g", "f", "e", "c", "b", "d", "a"]);
});

test("finding 1: bounded lists never starve: more than ATTENTION_SHOWN_PER_TASK new items on one task, and more than 8 tasks with new items, are all delivered over successive completed turns, oldest first", () => {
  const r = rig();
  const many = r.create({ title: "Many" });
  for (let i = 0; i < ATTENTION_SHOWN_PER_TASK + 3; i++) {
    r.advance(1000);
    if (i < 5) r.tasks.fileRequest(many.id, { kind: "clarification", text: `Question ${i}?` }, TASK_TURN(i));
  }
  // Non-request items too (vault link, then three failed syncs on separate notes are one item, so use budget items per due time).
  for (let i = 0; i < 3; i++) {
    r.advance(1000);
    r.tasks.noteAutoBudget(many.id, new Date(T0 + i * MIN).toISOString(), "budget-task", "used");
  }
  const tasks = [] as Task[];
  for (let i = 0; i < 10; i++) {
    r.advance(1000);
    const t = r.create({ title: `T${i}`, goal: `Goal ${i}` });
    r.tasks.fileRequest(t.id, { kind: "blocker", text: `Blocked ${i}` }, TASK_TURN(1));
    tasks.push(t);
  }
  const seen = new Set<string>();
  for (let turn = 0; turn < 6; turn++) {
    const d = completedTurn(r);
    for (const row of d.shown) for (const a of row.attention) if (a.new) seen.add(`${row.id}/${a.id}`);
  }
  const all = [many, ...tasks].flatMap((t) => r.tasks.get(t.id)!.attention!.map((a) => `${t.id}/${a.id}`));
  assert.equal(all.length, 8 + 10);
  for (const k of all) assert.ok(seen.has(k), `delivered at some turn: ${k}`);
  for (const t of [many, ...tasks]) for (const a of r.tasks.get(t.id)!.attention!) assert.ok(a.surfaced, "every item was delivered");
});

test("finding 1: stored records from Repair 3 are repaired once (acknowledged turn items and stale request items resolved, history pruned with a count), idempotently, and views are right even before the repair is written", () => {
  const r = rig();
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "clarification", text: "CSV?" }, TASK_TURN(1));
  // Write a Repair-3-shaped record by hand: six acknowledged turn-failed items, one request item left open although its request was
  // answered (as an older build would leave it), and 120 resolved items.
  const raw = JSON.parse(r.file());
  const rec = raw.tasks[0];
  rec.requests[0].state = "answered";
  rec.requests[0].response = { at: new Date(T0).toISOString(), by: ASSISTANT, text: "Yes." };
  const ack = { at: new Date(T0).toISOString(), by: ASSISTANT, note: "seen" };
  for (let i = 1; i <= 6; i++) rec.attention.push({ id: `att-${100 + i}`, key: `turn:${i}`, kind: "turn-failed", summary: `Turn ${i} failed`, source: { type: "turn", turn: i, trigger: "assistant" }, rev: 1, createdAt: new Date(T0 + i).toISOString(), lastAt: new Date(T0 + i).toISOString(), occurrences: 1, state: "acknowledged", ack });
  for (let i = 0; i < 120; i++) rec.attention.push({ id: `att-${200 + i}`, key: `old:${i}`, kind: "budget", summary: "old", source: { type: "follow-up", dueAt: new Date(T0).toISOString() }, rev: 1, createdAt: new Date(T0).toISOString(), lastAt: new Date(T0).toISOString(), occurrences: 1, state: "resolved", resolved: { at: new Date(T0 + i).toISOString(), why: "old" } });
  writeFileSync(join(r.dir, "tasks.json"), JSON.stringify(raw));
  const f = rig({ dir: r.dir });
  // Before the repair is written (and with writes failing), the views already apply the same rules.
  f.disk.fail = true;
  assert.throws(() => f.tasks.repairAttention(), /ENOSPC/);
  const v = f.sup.view(f.tasks.get(t.id)!) as { attention: { open: number; acknowledged: number; items: unknown[] } };
  assert.deepEqual([v.attention.open, v.attention.acknowledged, v.attention.items.length], [0, 0, 0]);
  f.disk.fail = false;
  const fixed = rig({ dir: r.dir });
  fixed.advance(60 * MIN); // the repair runs at a later start
  const rep = fixed.tasks.repairAttention();
  assert.deepEqual(rep.tasks, [t.id]);
  const after = fixed.tasks.get(t.id)!;
  assert.equal(after.attention!.filter((a) => a.state !== "resolved").length, 0);
  assert.ok(after.attention!.length <= ATTENTION_KEPT);
  assert.ok(after.attentionPruned!.count > 0, "pruned history is counted, not silently dropped");
  const turnItem = after.attention!.find((a) => a.key === "turn:6")!;
  assert.deepEqual([turnItem.state, turnItem.ack?.note], ["resolved", "seen"], "the acknowledgement stays on the resolved item");
  // The stale request item is resolved (and, being the oldest resolved item, may then be pruned: counted above).
  const req = after.attention!.find((a) => a.key === "request:req-1");
  if (req) assert.match(req.resolved!.why, /answered/);
  assert.equal(after.rev, f.tasks.get(t.id)!.rev, "a repair is bookkeeping: no rev bump");
  // Idempotent: a second store over the repaired file changes nothing.
  const again = rig({ dir: r.dir });
  const saves = again.disk.saves;
  assert.deepEqual(again.tasks.repairAttention(), { tasks: [], items: 0 });
  assert.equal(again.disk.saves, saves);
});

// ---- Finding 2: prolonged capacity waits ----

test("finding 2: a prolonged capacity wait (session busy) raises ONE attention item, uses no attempt, is not reopened by later deferrals after it is acknowledged, and resolves when the follow-up time is replaced", async () => {
  const r = rig();
  const t = r.optedIn();
  r.advance(11 * MIN);
  // The task's session has a reply in progress (Rai typing elsewhere): a capacity deferral every tick.
  const tid = r.tasks.get(t.id)!.session.thread;
  const lock = r.threads.tryBegin(tid);
  assert.ok(lock);
  const ticks = Math.ceil(AUTO_CAPACITY_ATTENTION_MS / MIN) + 5;
  for (let i = 0; i < ticks; i++) {
    const rep = await r.sched.tick();
    assert.equal(rep.deferred.length, 1);
    assert.deepEqual([rep.gaveUp.length, rep.retrying.length], [0, 0]);
    if (i === Math.ceil(AUTO_CAPACITY_ATTENTION_MS / MIN) + 1) {
      const item = r.tasks.get(t.id)!.attention!.find((a) => a.kind === "capacity-wait")!;
      r.tasks.acknowledge(t.id, item.id, HUMAN, "my long reply");
    }
    r.advance(MIN);
  }
  const slot = r.tasks.get(t.id)!.auto!.slot!;
  assert.deepEqual([slot.state, slot.attempts], ["capacity-wait", 0], "never an attempt, never gave up");
  const items = r.tasks.get(t.id)!.attention!.filter((a) => a.kind === "capacity-wait");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.state, "acknowledged", "later deferrals of the same wait do not reopen it");
  assert.match(items[0]!.summary, /waited \d+ minutes/);
  // Rai replaces the follow-up time: the wait it described is over.
  const cur = r.tasks.get(t.id)!;
  r.tasks.update(t.id, cur.rev, { followUpAt: new Date(r.clock.t + 60 * MIN).toISOString() }, HUMAN);
  assert.equal(r.tasks.get(t.id)!.attention!.find((a) => a.kind === "capacity-wait")!.state, "resolved");
  r.threads.end(tid, lock!);
});

test("finding 2: a short capacity wait raises nothing", async () => {
  const r = rig({ maxConcurrent: 1, hold: true });
  const busy = r.create({ title: "Busy" });
  const s = await r.sup.startTurn(busy.id, { trigger: HUMAN, isOwner: true, expectRev: busy.rev });
  const t = r.optedIn();
  r.advance(11 * MIN);
  for (let i = 0; i < 5; i++) {
    await r.sched.tick();
    r.advance(MIN);
  }
  assert.equal((r.tasks.get(t.id)!.attention ?? []).filter((a) => a.kind === "capacity-wait").length, 0);
  r.release();
  await s.done;
});

// ---- Finding 3: optimistic revision checks on no-op updates ----

test("finding 3: no-op updates are rev-checked: a stale rev is refused (409) for updateDetailed and for turning follow-up off when already off; the current rev writes nothing", () => {
  const r = rig();
  const t = r.create();
  const saves = r.disk.saves;
  assert.throws(() => r.tasks.updateDetailed(t.id, t.rev - 1 || t.rev + 1, {}, ASSISTANT), code(409, /stale/));
  assert.throws(() => r.tasks.setAutoDetailed(t.id, t.rev + 3, false, HUMAN), code(409, /stale/));
  assert.throws(() => r.tasks.updateDetailed(t.id, t.rev + 3, { autoFollowUp: "off" }, HUMAN), code(409, /stale/));
  assert.equal(r.tasks.updateDetailed(t.id, t.rev, {}, ASSISTANT).changed, false);
  assert.equal(r.tasks.setAutoDetailed(t.id, t.rev, false, HUMAN).changed, false);
  assert.equal(r.disk.saves, saves, "nothing written by any of them");
  // The Assistant's tool says stale too.
  return r
    .tool("task_update")
    .run({ id: t.id, rev: t.rev + 9, autoFollowUp: "off" }, undefined as never)
    .then(
      () => assert.fail("a stale no-op was accepted"),
      (e: Error) => assert.match(e.message, /stale/),
    );
});

// ---- Finding 4: evaluation fixture paths ----

test("finding 4: scenario vault paths: traversal, absolute, backslash, control and dot spellings are refused; plain paths pass", () => {
  for (const bad of ["../x.md", "a/../../x.md", "/etc/x.md", "~/x.md", "C:/x.md", "a\\b.md", "a//b.md", "./a.md", "a/./b.md", "a\u0000.md", ".hidden/x.md", "", "a/".repeat(9) + "x.md"]) assert.ok(scenarioPathProblem(bad), `refused: ${JSON.stringify(bad)}`);
  for (const ok of ["Projects/garden.md", "Memory/recent-context.md", "Tasks/a b (1).md"]) assert.equal(scenarioPathProblem(ok), undefined, ok);
});

test("finding 4: writeConfined never writes outside its root: symlinked directories and planted file links are refused, existing files are not overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-confine-"));
  const root = join(dir, "vault");
  const outside = join(dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeConfined(root, "Projects/ok.md", "fine");
  assert.equal(readFileSync(join(root, "Projects/ok.md"), "utf8"), "fine");
  symlinkSync(outside, join(root, "Linked"));
  assert.throws(() => writeConfined(root, "Linked/x.md", "escape"), /symbolic link/);
  assert.equal(existsSync(join(outside, "x.md")), false);
  symlinkSync(join(outside, "target.md"), join(root, "Projects/planted.md"));
  assert.throws(() => writeConfined(root, "Projects/planted.md", "escape"));
  assert.equal(existsSync(join(outside, "target.md")), false, "a planted link is not followed");
  assert.throws(() => writeConfined(root, "Projects/ok.md", "again"), /EEXIST/);
  assert.equal(readFileSync(join(root, "Projects/ok.md"), "utf8"), "fine");
  assert.throws(() => writeConfined(root, "../outside/y.md", "escape"), /'\.\.' segment/);
  assert.equal(existsSync(join(outside, "y.md")), false);
});

test("finding 4: runTaskEval refuses a scenario with an escaping path before running anything or calling the model", async () => {
  let calls = 0;
  const port: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/eval", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
    step: async (): Promise<Step> => ((calls += 1), { text: "ok", calls: [] }),
  };
  const sc: EvalScenario = { id: "escape", category: "planning", task: { title: "x", goal: "y", acceptance: ["z"] }, vault: { "Projects/fine.md": "a", "../../escape.md": "b" }, expect: {} };
  const rep = await runTaskEval({ model: port, allow: ["fake/eval"], scenarios: [sc] });
  assert.equal(rep.ran, false);
  assert.match((rep as { refused: string }).refused, /escape: vault path .* refused/);
  assert.equal(calls, 0);
});

// ---- Delivery distinct from acknowledgement and resolution ----

test("delivery: attention shown to an Assistant turn that FAILED stays new (counted as undelivered), survives a restart, and is delivered only by a completed turn; delivery never acknowledges or resolves", () => {
  const r = rig();
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "blocker", text: "Need a decision" }, TASK_TURN(1));
  const first = block(r);
  r.sup.undelivered(first.shown, "the model request timed out");
  let item = r.tasks.get(t.id)!.attention![0]!;
  assert.equal(item.surfaced, undefined);
  assert.deepEqual([item.undelivered!.count, item.undelivered!.why], [1, "the model request timed out"]);
  // An interrupted turn records nothing at all (ORBIT stopped): a new store still sees it new.
  block(r);
  const fresh = rig({ dir: r.dir });
  assert.equal(block(fresh).data.shown[0].attention[0].new, true);
  completedTurn(fresh);
  item = fresh.tasks.get(t.id)!.attention![0]!;
  assert.equal(item.surfaced!.count, 1);
  assert.equal(item.state, "open", "delivered is not answered");
  assert.equal(block(fresh).data.shown[0].attention[0].new, false);
});

// ---- The opt-in supervisor wake ----

function wakeRig(o: { enabled?: boolean; dir?: string; turn?: (text: string) => Promise<{ error?: string; notStarted?: string }>; busy?: () => boolean } = {}) {
  const r = rig(o.dir ? { dir: o.dir } : {});
  const calls: string[] = [];
  const turn = o.turn ?? (async () => ({}));
  const w = supervisorWake({ tasks: r.tasks, backend: wakeFile(r.dir), enabled: o.enabled !== false, assistantBusy: o.busy ?? (() => false), turn: async (text) => (calls.push(text), turn(text)), now: r.now, log: () => {} });
  return { ...r, w, calls };
}

test("wake: off by default at both levels; only Rai can opt in; nothing starts without pending undelivered attention", async () => {
  const off = wakeRig({ enabled: false });
  const t = off.create();
  off.tasks.fileRequest(t.id, { kind: "blocker", text: "Help" }, TASK_TURN(1));
  assert.equal((await off.w.tick()).outcome, "operator-off");
  const r = wakeRig();
  const u = r.create();
  assert.equal((await r.w.tick()).outcome, "off", "operator on, Rai not opted in");
  assert.throws(() => r.w.setOptIn(true, ASSISTANT), code(403));
  assert.throws(() => r.w.setOptIn(true, { actor: "human", via: "sessions-ui" }), code(403));
  assert.throws(() => r.w.setOptIn(true, TASK_TURN(1)), code(403));
  assert.throws(() => r.w.setOptIn(true, HUMAN, 99), code(400));
  assert.equal(r.w.setOptIn(true, HUMAN, 3).changed, true);
  assert.equal((await r.w.tick()).outcome, "nothing-pending");
  r.tasks.fileRequest(u.id, { kind: "blocker", text: "Help" }, TASK_TURN(1));
  const rep = await r.w.tick();
  assert.equal(rep.outcome, "started");
  await r.w.idle();
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0]!, /^\[ORBIT supervisor wake\] Not from Rai\./);
  assert.equal(r.w.view().last!.state, "done");
});

test("wake: rate, budget and per-item retry limits; Assistant busy claims nothing; a not-started turn returns its tries", async () => {
  let busy = false;
  let fail = true;
  const r = wakeRig({ busy: () => busy, turn: async () => (fail ? { error: "model unavailable" } : {}) });
  r.w.setOptIn(true, HUMAN, 3);
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "blocker", text: "Help" }, TASK_TURN(1));
  busy = true;
  assert.equal((await r.w.tick()).outcome, "assistant-busy");
  assert.equal(r.calls.length, 0);
  busy = false;
  assert.equal((await r.w.tick()).outcome, "started");
  await r.w.idle();
  assert.equal((await r.w.tick()).outcome, "interval");
  r.advance(WAKE_MIN_INTERVAL_MS);
  assert.equal((await r.w.tick()).outcome, "started");
  await r.w.idle();
  r.advance(WAKE_MIN_INTERVAL_MS);
  // The item caused WAKE_TRIES_PER_ITEM wakes (both failed, so it is still undelivered): it now waits for Rai's own turn.
  assert.equal(WAKE_TRIES_PER_ITEM, 2);
  const rep = await r.w.tick();
  assert.equal(rep.outcome, "nothing-pending");
  assert.match(rep.detail, /wait for Rai's next Assistant turn/);
  assert.equal(r.w.view().pending!.waitingForRai, 1);
  // A new item may wake again, within the budget (3 per day).
  fail = false;
  r.tasks.fileRequest(t.id, { kind: "clarification", text: "Which week?" }, TASK_TURN(2));
  assert.equal((await r.w.tick()).outcome, "started");
  await r.w.idle();
  r.advance(WAKE_MIN_INTERVAL_MS);
  r.tasks.fileRequest(t.id, { kind: "clarification", text: "Which sensor?" }, TASK_TURN(3));
  assert.equal((await r.w.tick()).outcome, "budget");
  // A turn that could not take the Assistant (it became busy at the last moment) is not run and returns its tries.
  const n = wakeRig({ turn: async () => ({ notStarted: "the Assistant had a reply in progress" }) });
  n.w.setOptIn(true, HUMAN);
  const u = n.create();
  n.tasks.fileRequest(u.id, { kind: "blocker", text: "Help" }, TASK_TURN(1));
  for (let i = 0; i < 4; i++) {
    assert.equal((await n.w.tick()).outcome, "started");
    await n.w.idle();
  }
  assert.equal(JSON.parse(readFileSync(join(n.dir, "supervisor-wake.json"), "utf8")).wakes.every((x: { state: string }) => x.state === "not-run"), true);
});

test("wake: claimed before the turn, restart marks a running wake interrupted and never re-runs it; failures in a row pause it; pause and resume are Rai's", async () => {
  let release!: () => void;
  const hang = new Promise<{ error?: string }>((res) => (release = () => res({})));
  const r = wakeRig({ turn: () => hang });
  r.w.setOptIn(true, HUMAN);
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "blocker", text: "Help" }, TASK_TURN(1));
  assert.equal((await r.w.tick()).outcome, "started");
  const onDisk = JSON.parse(readFileSync(join(r.dir, "supervisor-wake.json"), "utf8"));
  assert.equal(onDisk.wakes[0].state, "running", "the claim is on disk before the turn returns");
  // A restart: a new wake over the same file.
  const again = supervisorWake({ tasks: r.tasks, backend: wakeFile(r.dir), enabled: true, assistantBusy: () => false, turn: async () => assert.fail("never re-run"), now: r.now, log: () => {} });
  assert.deepEqual(again.recover(), [1]);
  assert.equal(again.view().last!.state, "interrupted");
  assert.equal(r.tasks.get(t.id)!.attention![0]!.surfaced, undefined, "what it was shown is still undelivered");
  release();
  await r.w.idle();
  // Failures in a row pause it, with the reason; only Rai resumes.
  const f = wakeRig({ turn: async () => ({ error: "model unavailable" }) });
  f.w.setOptIn(true, HUMAN);
  for (let i = 0; i < WAKE_FAILURES_PAUSE; i++) {
    const u = f.create({ title: `F${i}`, goal: `G${i}` });
    f.tasks.fileRequest(u.id, { kind: "blocker", text: `Help ${i}` }, TASK_TURN(1));
    assert.equal((await f.w.tick()).outcome, "started");
    await f.w.idle();
    f.advance(WAKE_MIN_INTERVAL_MS);
  }
  const v = f.w.view();
  assert.equal(v.state, "paused");
  assert.match(v.paused!.reason, /in a row ended in an error/);
  assert.equal((await f.w.tick()).outcome, "paused");
  assert.throws(() => f.w.setPaused(false, ASSISTANT), code(403));
  assert.equal(f.w.setPaused(false, HUMAN).changed, true);
  assert.equal(f.w.view().consecutiveFailures, 0);
  assert.equal(f.w.setOptIn(false, HUMAN).changed, true);
  assert.equal((await f.w.tick()).outcome, "off");
});

// ---- Task-turn model routing ----

const port = (impl: string, tools = true): ModelPort => ({
  status: () => ({ port: "model", state: "live", impl, detail: "test", verifiedAt: new Date().toISOString() }),
  reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
  ...(tools ? { step: async (): Promise<Step> => ({ text: "ok", calls: [] }) } : {}),
});

test("routing: no table keeps the default port; a configured route reports its port and impl; unknown, paid and tool-less routes refuse their kind with the reason, never falling back", () => {
  const def = port("default/model");
  assert.deepEqual(taskRouter(def).describe().kinds.map((k) => ("port" in k ? k.port : k.refused)), ["default", "default", "default"]);
  const r = taskRouter(def, { ports: { small: { port: port("local/small") }, pricey: { port: port("paid/x"), paid: true }, chat: { port: port("no/tools", false) } }, routes: { automatic: "small", supervised: "pricey", interactive: "missing", wake: "small" } as never });
  const a = r.resolve("automatic");
  assert.ok(a.ok && a.name === "small" && a.impl === "local/small" && a.routed);
  const s = r.resolve("supervised");
  assert.ok(!s.ok && /paid/.test(s.why));
  const i = r.resolve("interactive");
  assert.ok(!i.ok && /not configured/.test(i.why));
  const d = r.describe();
  assert.ok(d.problems.some((p) => /unknown turn kind "wake"/.test(p)));
  assert.ok(d.problems.some((p) => /paid/.test(p)) && d.problems.some((p) => /no configured port named missing/.test(p)));
  const tl = taskRouter(def, { ports: { chat: { port: port("no/tools", false) } }, routes: { supervised: "chat" } }).resolve("supervised");
  assert.ok(!tl.ok && /cannot call tools/.test(tl.why));
});

// ---- Vault sync recovery ----

test("vault: a write that landed but whose bookkeeping failed shows `unconfirmed` (also after a restart); the retry finds the line by its key, writes no second line, and records it", async () => {
  const r = rig();
  const t = r.create({ vaultNote: "Tasks/garden.md", vaultHeading: "## Status" });
  const note = { text: "# Garden\n\n## Status\n- Rai's own line\n", appends: 0 };
  const vault: TaskVaultPort = {
    read: async () => note.text,
    append: async (_p, _h, line) => {
      note.appends += 1;
      note.text += `${line}\n`;
      // The vault write succeeded; the bookkeeping after it will fail.
      r.disk.fail = true;
      return { commit: "a".repeat(40) };
    },
  };
  const sync = taskVaultSync({ tasks: r.tasks, port: vault, observers: { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) }, now: r.now });
  const out = await sync.sync(t.id);
  assert.deepEqual([out.state, out.written, out.recorded], ["written-unrecorded", true, false]);
  r.disk.fail = false;
  const fresh = rig({ dir: r.dir });
  const v = fresh.sup.view(fresh.tasks.get(t.id)!) as { vault: { coherence: { state: string; detail: string } } };
  assert.equal(v.vault.coherence.state, "unconfirmed");
  assert.match(v.vault.coherence.detail, /never recorded as finished/);
  const sync2 = taskVaultSync({ tasks: fresh.tasks, port: vault, observers: { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) }, now: fresh.now });
  const again = await sync2.sync(t.id);
  assert.deepEqual([again.state, again.recorded], ["already-written", true]);
  assert.equal(note.appends, 1, "no second line");
  assert.match(note.text, /- Rai's own line\n/, "Rai's text is untouched");
  assert.equal((fresh.sup.view(fresh.tasks.get(t.id)!) as { vault: { coherence: { state: string } } }).vault.coherence.state, "current");
  // If even the pre-write record cannot be written, nothing is written to the vault.
  const cur = fresh.tasks.get(t.id)!;
  fresh.tasks.update(t.id, cur.rev, { nextAction: "Totals" }, HUMAN);
  fresh.disk.fail = true;
  const refused = await sync2.sync(t.id);
  fresh.disk.fail = false;
  assert.deepEqual([refused.state, refused.written], ["failed", false]);
  assert.equal(note.appends, 1);
});

// The rig's own store over a missing directory is unaffected (sanity: taskStore over a fresh dir starts empty).
test("sanity: a fresh store has nothing to repair", () => {
  const s = taskStore(taskFile(mkdtempSync(join(tmpdir(), "orbit-r4-"))));
  assert.deepEqual(s.repairAttention(), { tasks: [], items: 0 });
});
