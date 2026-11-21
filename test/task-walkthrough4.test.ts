import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TaskVaultPort } from "../src/task-vault.ts";
import type { SupervisorWake } from "../src/task-wake.ts";
import { wakeFile } from "../src/task-wake.ts";
import { taskFile, taskStore } from "../src/tasks.ts";
import type { TaskBackend } from "../src/tasks.ts";
import { lastUser, stack } from "./tasks-fixture.ts";
import { call } from "./threads-fixture.ts";

// Repair 4: the combined local integration walkthrough (docs/adr/0003-supervised-tasks.md, "Repair 4", acceptance matrix). One flow
// through the real HTTP server, stores and turn code over ONE temporary state directory, restarted once in the middle, with a scripted
// model, the fixture's fake routine and a fake vault port. SIMULATED: nothing here ran on a host, against a real model, a real routine or
// a real vault. Operator switches (automatic follow-up, supervisor wake) are on in this test only.

const A = { title: "Garden sensor CSV", goal: "A weekly CSV of synthetic garden sensor readings is produced by a tested exporter.", acceptance: ["The exporter writes one row per sensor per day"], project: "example/garden" };
const B = { title: "Garden sensor dashboard", goal: "A dashboard reads the weekly CSV.", acceptance: ["The dashboard shows one chart per sensor"], project: "example/garden" };
const BRIEF = "Build the garden dashboard with tests, using synthetic readings only.";
const activityOf = (notes?: string) => {
  const m = /<orbit-data name="task-activity"[^>]*>[\s\S]*?\n(\{[\s\S]*\})\s*<\/orbit-data>/.exec(notes ?? "");
  return m ? JSON.parse(m[1]!) : undefined;
};
const wait = async (cond: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("walkthrough (simulated): create and link sessions, direct and Assistant steering, concurrent tasks, dependency and blocker escalation, follow-up and wake opt-ins with budgets, pause/resume, restart with interrupted turn and wake, vault write recovery, honest cancellation, human-only completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-walk4-"));
  // The task file can be made to fail on demand (to show vault bookkeeping recovery); everything else is the real store.
  const disk = { fail: false };
  const inner = taskFile(dir);
  const backend: TaskBackend = { persisted: true, load: () => inner.load(), save: (f) => (disk.fail ? (() => { throw new Error("ENOSPC: no space left on device"); })() : inner.save(f)) };
  const note = { text: "# Garden\n\n## Status\n- Rai: started the garden work\n", appends: 0 };
  const taskVault: TaskVaultPort = {
    read: async () => note.text,
    append: async (_p, _h, line) => {
      note.appends += 1;
      note.text += `${line}\n`;
      return { commit: "c".repeat(40) };
    },
  };
  const w = { current: undefined as SupervisorWake | undefined };
  // This server's own task store (a restart makes a new one over the same file).
  let store = taskStore(backend);
  const boot = () => (
    (store = taskStore(backend)),
    stack({
      dir,
      taskVault,
      followUps: true,
      turnsMax: 1,
      extra: () => ({ tasks: store, supervisorWake: { enabled: true, tickMs: 0, minIntervalMs: 0, backend: wakeFile(dir), onWake: (s: SupervisorWake) => (w.current = s) } }),
    })
  );
  let x = boot();

  // 1. Create two tasks and open their linked sessions; B depends on A (met only when Rai marks A done).
  const a = (await x.assistantTool("task_create", { ...A, vaultNote: "Tasks/garden.md", vaultHeading: "## Status" })).result.task;
  const b = (await x.assistantTool("task_create", B)).result.task;
  const threadA = a.session.link.slice("/sessions/".length);
  for (const t of [a, b]) assert.equal((await x.api(`/threads/${t.session.link.slice("/sessions/".length)}`)).data.thread.task.id, t.id);
  assert.equal((await x.api(`/tasks/${b.id}/update`, "POST", { rev: b.rev, dependsOn: [a.id] })).status, 200);

  // 2. Direct steering (Rai in A's session) and Assistant steering; the supervisor sees Rai's own words, labeled as his.
  assert.equal((await x.send(threadA, "Use only synthetic readings.")).status, 200);
  await x.assistantTool("task_steer", { id: a.id, rev: (await x.inspect(a.id)).rev, text: "Prefer CSV over JSON." });
  await x.assistantTool("tasks_list", {});
  const act = activityOf([...x.d.seen].reverse().find((s) => !s.taskTurn && activityOf(s.notes))!.notes);
  assert.equal(act.shown.find((s: { id: string }) => s.id === a.id).raiLatestInstruction.text, "Use only synthetic readings.");

  // 3. Concurrent tasks with one turn slot: A's turn holds it, B's start is refused (429, nothing queued), then B runs.
  let open!: () => void;
  x.d.ctl.gate = new Promise<void>((r) => (open = r));
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "blocker", text: "Which sensors count?" }, "a1")], reply: "Blocked on sensors." });
  assert.equal((await x.api(`/tasks/${a.id}/turn`, "POST", { rev: (await x.inspect(a.id)).rev })).status, 202);
  assert.equal((await x.api(`/tasks/${b.id}/turn`, "POST", { rev: (await x.inspect(b.id)).rev })).status, 429);
  open();
  x.d.ctl.gate = undefined;
  await x.settled(a.id);
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "job", text: "Build the dashboard", brief: BRIEF }, "b1"), call("task_request", { kind: "job", text: "Build the chart legend", brief: `${BRIEF} Legend.` }, "b2")], reply: "Asked for builds." });
  assert.equal((await x.api(`/tasks/${b.id}/turn`, "POST", { rev: (await x.inspect(b.id)).rev })).status, 202);
  await x.settled(b.id);

  // 4. Blocker escalation: A's blocker is attention (new); the Assistant answers it, which resolves it.
  let cur = await x.inspect(a.id);
  assert.ok(cur.attention.items.some((i: { kind: string; new: boolean }) => i.kind === "blocker" && i.new));
  await x.assistantTool("task_respond", { id: a.id, rev: cur.rev, request: "req-1", action: "answer", text: "Outdoor sensors only." });
  cur = await x.inspect(a.id);
  assert.equal(cur.attention.open, 0);

  // 5. Automatic follow-up opt-in (Rai, perDay 1): one automatic turn for a due time; the next due time waits on the budget, with attention.
  assert.equal((await x.api(`/tasks/${a.id}/follow-up`, "POST", { rev: cur.rev, enabled: true, perDay: 1 })).status, 200);
  cur = await x.inspect(a.id);
  await x.api(`/tasks/${a.id}/update`, "POST", { rev: cur.rev, followUpAt: new Date(Date.now() - 20_000).toISOString() });
  x.d.ctl.taskSteps.push({ calls: [], reply: "Followed up." });
  assert.equal((await x.sched.current!.tick()).started.length, 1);
  await x.settled(a.id);
  cur = await x.inspect(a.id);
  await x.api(`/tasks/${a.id}/update`, "POST", { rev: cur.rev, followUpAt: new Date(Date.now() - 10_000).toISOString() });
  const t2 = await x.sched.current!.tick();
  assert.equal(t2.started.length, 0);
  cur = await x.inspect(a.id);
  assert.equal(cur.automaticFollowUp.state, "budget-task");
  assert.ok(cur.attention.items.some((i: { kind: string }) => i.kind === "budget"));

  // 6. Supervisor wake opt-in (Rai): B's two job requests are undelivered attention; one bounded wake turn delivers them (not answers).
  assert.equal((await w.current!.tick()).outcome, "off");
  assert.equal((await x.api("/tasks/wake", "POST", { enabled: true, perDay: 3 })).status, 200);
  assert.equal((await w.current!.tick()).outcome, "started");
  await w.current!.idle();
  const bNow = await x.inspect(b.id);
  assert.equal(bNow.attention.new, 0, "delivered by the wake turn");
  assert.equal(bNow.requestsWaiting.length, 2, "delivered is not answered");

  // 7. Pause and resume A (the budget item is acknowledged meanwhile; it stays until its cause clears).
  cur = await x.inspect(a.id);
  const budget = cur.attention.items.find((i: { kind: string }) => i.kind === "budget");
  await x.api(`/tasks/${a.id}/attention`, "POST", { attention: budget.id, note: "fine for today" });
  cur = await x.inspect(a.id);
  assert.equal((await x.api(`/tasks/${a.id}/pause`, "POST", { rev: cur.rev })).data.task.lifecycle, "paused");
  cur = await x.inspect(a.id);
  assert.equal((await x.api(`/tasks/${a.id}/resume`, "POST", { rev: cur.rev })).data.task.lifecycle, "active");

  // 8. Escalation to a launch: B's first job request is proposed, linked and confirmed (running); the second is proposed and linked only.
  const p1 = (await x.assistantTool("job_launch", { routine: "orbit", brief: BRIEF })).result.proposalId as string;
  await x.assistantTool("task_respond", { id: b.id, rev: (await x.inspect(b.id)).rev, request: "req-1", action: "link_proposal", proposalId: p1 });
  const job = await x.api(`/chat/proposals/${p1}/confirm`, "POST", {});
  assert.equal(job.status, 202);
  const p2 = (await x.assistantTool("job_launch", { routine: "orbit", brief: `${BRIEF} Legend.` })).result.proposalId as string;
  await x.assistantTool("task_respond", { id: b.id, rev: (await x.inspect(b.id)).rev, request: "req-2", action: "link_proposal", proposalId: p2 });

  // 9. Restart during a running task turn AND a running wake turn: both are interrupted, neither is re-run, nothing was delivered.
  x.d.ctl.gate = new Promise(() => {});
  x.d.ctl.taskSteps.push({ calls: [], reply: "never" });
  assert.equal((await x.api(`/tasks/${a.id}/turn`, "POST", { rev: (await x.inspect(a.id)).rev })).status, 202);
  x.d.ctl.taskSteps.push({ calls: [], reply: "never" });
  // A new request on A to wake for; the wake's model request hangs (ORBIT "stops" before it ends).
  const hang = x.d.model.step!;
  let wakeReached = false;
  x.d.model.step = async (input, limits, notes, tools, opts) => ((lastUser(input)?.content ?? "").startsWith("[ORBIT supervisor wake]") ? ((wakeReached = true), new Promise(() => {})) : hang(input, limits, notes, tools, opts));
  store.fileRequest(b.id, { kind: "clarification", text: "Bars or lines?" }, { actor: "task", via: "task-turn", turn: 9 });
  assert.equal((await w.current!.tick()).outcome, "started");
  await wait(() => wakeReached, "the wake turn to reach the model");
  x.server.close();
  x = boot();
  await x.api("/status");
  cur = await x.inspect(a.id);
  assert.equal(cur.lastTurn.state, "interrupted");
  assert.ok(cur.attention.items.some((i: { kind: string; state: string }) => i.kind === "turn-interrupted" && i.state === "open"));
  const wv = (await x.api("/tasks/wake")).data.wake;
  assert.equal(wv.last.state, "interrupted");
  assert.ok((await x.inspect(b.id)).attention.new >= 1, "what the interrupted wake was shown is still undelivered");
  // Acknowledging the interrupted turn resolves it (the acknowledgement is kept).
  const ti = cur.attention.items.find((i: { kind: string }) => i.kind === "turn-interrupted");
  assert.equal((await x.api(`/tasks/${a.id}/attention`, "POST", { attention: ti.id, note: "will rerun" })).data.state, "resolved");

  // 10. Vault sync with recovery: the line lands but ORBIT's bookkeeping after it fails: reported as in the vault, not recorded; the task
  // shows `unconfirmed`; the retry finds the line by its key, writes no second line, and records it. Rai's line is untouched.
  const realAppend = taskVault.append;
  taskVault.append = async (...args) => {
    const r = await realAppend(...args);
    disk.fail = true;
    return r;
  };
  const s1 = await x.api(`/tasks/${a.id}/sync`, "POST", { rev: (await x.inspect(a.id)).rev });
  disk.fail = false;
  taskVault.append = realAppend;
  assert.equal(s1.status, 200);
  assert.deepEqual([s1.data.sync.state, s1.data.sync.written, s1.data.sync.recorded], ["written-unrecorded", true, false]);
  assert.equal((await x.inspect(a.id)).vault.coherence.state, "unconfirmed");
  const s2 = await x.api(`/tasks/${a.id}/sync`, "POST", { rev: (await x.inspect(a.id)).rev });
  assert.equal(s2.data.sync.state, "already-written");
  assert.equal(note.appends, 1);
  assert.equal((await x.inspect(a.id)).vault.coherence.state, "current");
  assert.match(note.text, /- Rai: started the garden work\n/);

  // 11. Honest cancellation of B: its open card is withdrawn; its confirmed job keeps running and is reported as continuing.
  const cancel = await x.api(`/tasks/${b.id}/cancel`, "POST", { rev: (await x.inspect(b.id)).rev, reason: "re-planning" });
  assert.equal(cancel.status, 200);
  const outcomes = Object.fromEntries(cancel.data.cancellation.runs.map((r: { request: string; outcome: string }) => [r.request, r.outcome]));
  // After the restart the proposal store is empty (cards made before a restart expire), so req-2's card shows as not launched.
  assert.equal(outcomes["req-1"], "continuing");
  assert.ok(["card-withdrawn", "not-launched"].includes(outcomes["req-2"]), outcomes["req-2"]);
  assert.equal(cancel.data.cancellation.jobCancellation, "unsupported");
  assert.ok(["registered", "running"].includes(x.jobs.get(job.data.id)!.state), "ORBIT did not (and cannot) stop the job");

  // 12. Completion stays human-only and evidence-gated: refused before Rai attests, accepted after.
  cur = await x.inspect(a.id);
  assert.equal((await x.api(`/tasks/${a.id}/complete`, "POST", { rev: cur.rev })).status, 409);
  await x.api(`/tasks/${a.id}/evidence`, "POST", { rev: cur.rev, criterion: "ac1", kind: "note", ref: "Checked the synthetic CSV myself" });
  cur = await x.inspect(a.id);
  assert.equal((await x.api(`/tasks/${a.id}/complete`, "POST", { rev: cur.rev })).data.task.lifecycle, "done");
});
