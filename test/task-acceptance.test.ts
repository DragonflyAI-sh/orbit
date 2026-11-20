import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { TaskVaultPort } from "../src/task-vault.ts";
import { TASK_ASSISTANT_TOOL_NAMES } from "../src/task-supervisor.ts";
import { taskFile, taskStore } from "../src/tasks.ts";
import { VaultError } from "../src/vault/edit.ts";
import { lastUser, stack } from "./tasks-fixture.ts";
import { call } from "./threads-fixture.ts";

// Repair 3 acceptance walkthrough (docs/adr/0003-supervised-tasks.md, "Repair 3", acceptance matrix). SIMULATED: the real HTTP server
// and stores over temporary directories, a scripted model, the fixture's fake routine (no job really launches anywhere), a fake vault
// port (no vault is written). It is not live production validation.

const A = { title: "Garden sensor CSV", goal: "A weekly CSV of synthetic garden sensor readings is produced by a tested exporter.", acceptance: ["The exporter writes one row per sensor per day"], project: "example/garden" };
const B = { title: "Garden sensor dashboard", goal: "A dashboard reads the weekly CSV.", acceptance: ["The dashboard shows one chart per sensor"], project: "example/garden" };
const BRIEF = "Build the garden sensor CSV exporter with tests, using synthetic readings only. Push only to orbit/<job-id>; end with PR title and PR body.";
const lastActivity = (x: ReturnType<typeof stack>) => {
  const s = [...x.d.seen].reverse().find((v) => !v.taskTurn && v.notes?.includes("task-activity"))!;
  const m = /<orbit-data name="task-activity"[^>]*>[\s\S]*?\n(\{[\s\S]*\})\s*<\/orbit-data>/.exec(s.notes!);
  assert.ok(m, "the Assistant's turn carries the task-activity block");
  return JSON.parse(m![1]!);
};

test("acceptance (simulated): two tasks, sessions, direct and Assistant steering, capacity deferral, escalation round trip with a confirmed and a refused launch, dependencies, vault failure/retry, budget, pause/resume, restart recovery", async () => {
  // A vault port that fails its first write as unconfirmed (the push may or may not have landed), then succeeds.
  const note = { text: "# Garden\n\n## Status\n- started by Rai\n", failNext: true, appends: 0 };
  const taskVault: TaskVaultPort = {
    read: async () => note.text,
    append: async (_p, _h, line) => {
      if (note.failNext) {
        note.failNext = false;
        throw new VaultError("push_failed", "the remote refused the push");
      }
      note.appends += 1;
      note.text += `${line}\n`;
      return { commit: "c".repeat(40) };
    },
  };
  const x = stack({ taskVault, followUps: true, turnsMax: 1 });

  // 1. Creation and session navigation: two tasks, each with its own session that Sessions opens.
  const a = (await x.assistantTool("task_create", { ...A, vaultNote: "Tasks/garden.md", vaultHeading: "## Status" })).result.task;
  const b = (await x.assistantTool("task_create", B)).result.task;
  for (const t of [a, b]) {
    const thread = t.session.link.slice("/sessions/".length);
    assert.equal((await x.api(`/threads/${thread}`)).data.thread.task.id, t.id);
    assert.equal((await x.api(`/sessions/${thread}`)).status, 200);
  }
  const threadA = a.session.link.slice("/sessions/".length);

  // 2. Dependencies: B depends on A (met only when Rai marks A done). A cycle back is refused, and changes nothing.
  let r = await x.api(`/tasks/${b.id}/update`, "POST", { rev: b.rev, dependsOn: [a.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.task.dependencies.met, false);
  assert.equal(r.data.task.dependencies.tasks[0].session, a.session.link);
  const aNow = await x.inspect(a.id);
  r = await x.api(`/tasks/${a.id}/update`, "POST", { rev: aNow.rev, dependsOn: [b.id], nextAction: "should not be saved" });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /cycle/);
  assert.equal((await x.inspect(a.id)).nextAction, null, "atomic: nothing of the refused patch was saved");

  // 3. Direct steering by Rai in A's session, and Assistant steering; the supervisor sees Rai's own words, labeled, next turn.
  assert.equal((await x.send(threadA, "Use only synthetic readings.")).status, 200);
  let cur = await x.inspect(a.id);
  await x.assistantTool("task_steer", { id: a.id, rev: cur.rev, text: "Prefer CSV over JSON." });
  await x.assistantTool("tasks_list", {});
  let act = lastActivity(x);
  const rowA = act.shown.find((s: { id: string }) => s.id === a.id);
  assert.equal(rowA.raiLatestInstruction.text, "Use only synthetic readings.");
  assert.equal(rowA.raiLatestInstruction.via, "sessions-ui");
  // Nothing of A's conversation reaches B's context: B's turn sees A only as a dependency id and lifecycle.
  x.d.ctl.taskSteps.push({ calls: [], reply: "Waiting on the exporter." });
  cur = await x.inspect(b.id);
  assert.equal((await x.api(`/tasks/${b.id}/turn`, "POST", { rev: cur.rev })).status, 202);
  await x.settled(b.id);
  const bStep = [...x.d.seen].reverse().find((s) => s.taskTurn && s.notes?.includes(b.id))!;
  assert.match(bStep.notes!, new RegExp(`"dependsOn":\\[\\{"task":"${a.id}","lifecycle":"active","met":false\\}\\]`));
  assert.doesNotMatch(bStep.notes!, /Use only synthetic readings|Prefer CSV over JSON|weekly CSV of synthetic garden sensor readings is produced/);

  // 4. Concurrency and capacity deferral: A's turn holds the only slot; B's due automatic follow-up is deferred (no attempt used), and
  // starts at the first tick after the slot frees. (B's dependency is unmet, so its follow-up waits: remove it for this step.)
  cur = await x.inspect(b.id);
  r = await x.api(`/tasks/${b.id}/update`, "POST", { rev: cur.rev, dependsOn: [], followUpAt: new Date().toISOString() });
  r = await x.api(`/tasks/${b.id}/follow-up`, "POST", { rev: r.data.task.rev, enabled: true, perDay: 1 });
  assert.equal(r.status, 200);
  let release!: () => void;
  x.d.ctl.gate = new Promise<void>((res) => (release = res));
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "job", text: "Run the exporter build", brief: BRIEF }, "j1"), call("task_request", { kind: "blocker", text: "Which sensors count?" }, "j2")], reply: "Asked for a build and a decision." });
  cur = await x.inspect(a.id);
  assert.equal((await x.api(`/tasks/${a.id}/turn`, "POST", { rev: cur.rev })).status, 202);
  let tick = await x.sched.current!.tick();
  assert.deepEqual(tick.deferred.map((d) => d.task), [b.id]);
  assert.equal(x.tasks.get(b.id)!.auto!.slot!.attempts, 0);
  assert.equal((await x.inspect(b.id)).automaticFollowUp.state, "capacity-wait");
  x.d.ctl.gate = undefined;
  release();
  await x.settled(a.id);
  x.d.ctl.taskSteps.push({ calls: [], reply: "Follow-up turn." });
  tick = await x.sched.current!.tick();
  assert.deepEqual(tick.started.map((s) => s.task), [b.id]);
  await x.settled(b.id);

  // 5. Budget exhaustion: B's budget is 1 automatic turn per 24 hours; a new due time waits and raises one attention item.
  cur = await x.inspect(b.id);
  await x.api(`/tasks/${b.id}/update`, "POST", { rev: cur.rev, followUpAt: new Date().toISOString() });
  await x.sched.current!.tick();
  await x.sched.current!.tick();
  assert.equal((await x.inspect(b.id)).automaticFollowUp.state, "budget-task");
  assert.equal(x.tasks.get(b.id)!.attention!.filter((i) => i.kind === "budget" && i.state === "open").length, 1);

  // 6. Escalation: A's two requests are attention items, new at the Assistant's next turn (metadata and ORBIT's summary, never the
  // request text). Being shown is not an answer: they stay open after the turn, and cannot be acknowledged away.
  await x.assistantTool("tasks_list", {});
  act = lastActivity(x);
  const items = act.shown.find((s: { id: string }) => s.id === a.id).attention;
  assert.deepEqual(items.map((i: { kind: string; new: boolean }) => [i.kind, i.new]), [["job", true], ["blocker", true]]);
  assert.doesNotMatch(JSON.stringify(act), /Run the exporter build|Which sensors count/);
  const jobItem = items[0];
  const ack = await x.assistantTool("task_attention_ack", { id: a.id, attention: jobItem.id, note: "will propose" });
  assert.equal(ack.ok, false);
  assert.match(ack.error, /not an answer/);
  await x.assistantTool("tasks_list", {});
  act = lastActivity(x);
  assert.deepEqual(act.shown.find((s: { id: string }) => s.id === a.id).attention.map((i: { state: string; new: boolean }) => [i.state, i.new]), [["open", false], ["open", false]]);

  // 7. Confirmed launch: the Assistant proposes with the request's exact brief and links it; the job item resolves; only Rai's
  // Confirm launches (the fixture's fake routine); the request follows the job store; a job ending is not task completion.
  const p1 = (await x.assistantTool("job_launch", { routine: "orbit", brief: BRIEF })).result.proposalId as string;
  cur = await x.inspect(a.id);
  const linked = await x.assistantTool("task_respond", { id: a.id, rev: cur.rev, request: "req-1", action: "link_proposal", proposalId: p1 });
  assert.equal(linked.result.status, "awaiting-confirmation");
  assert.equal(x.jobs.all().length, 0);
  cur = await x.inspect(a.id);
  assert.equal(cur.attention.items.filter((i: { kind: string }) => i.kind === "job").length, 0, "resolved by the link, not by being shown");
  const confirmed = await x.api(`/chat/proposals/${p1}/confirm`, "POST", {});
  assert.equal(confirmed.status, 202);
  x.jobs.record(confirmed.data.id, { type: "summary", status: "done", text: "Built." });
  cur = await x.inspect(a.id);
  assert.equal(cur.requests.find((q: { id: string }) => q.id === "req-1").status, "result");
  assert.equal(cur.lifecycle, "active");

  // 8. Refused launch: a second build request, proposed and linked, then Rai cancels the card: the request shows not-confirmed and a
  // derived attention item says nothing ran; a research proposal is refused for a build request (lanes never substitute).
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "job", text: "Run the totals check", brief: `${BRIEF} Totals.` }, "j3")], reply: "Asked for a totals check." });
  cur = await x.inspect(a.id);
  await x.api(`/tasks/${a.id}/turn`, "POST", { rev: cur.rev });
  await x.settled(a.id);
  const p2 = (await x.assistantTool("job_launch", { routine: "orbit", brief: `${BRIEF} Totals.` })).result.proposalId as string;
  cur = await x.inspect(a.id);
  assert.equal((await x.assistantTool("task_respond", { id: a.id, rev: cur.rev, request: "req-3", action: "link_proposal", proposalId: p2 })).ok, true);
  assert.equal((await x.api(`/chat/proposals/${p2}/cancel`, "POST", {})).status, 200);
  cur = await x.inspect(a.id);
  assert.equal(cur.requests.find((q: { id: string }) => q.id === "req-3").status, "not-confirmed");
  assert.ok(cur.attention.items.some((i: { kind: string; derived?: boolean }) => i.kind === "launch-not-confirmed" && i.derived));
  assert.equal(x.jobs.all().length, 1, "the refused launch ran nothing");

  // 9. The blocker is answered: its attention item resolves.
  cur = await x.inspect(a.id);
  await x.assistantTool("task_respond", { id: a.id, rev: cur.rev, request: "req-2", action: "answer", text: "All outdoor sensors." });
  assert.equal((await x.inspect(a.id)).attention.items.filter((i: { kind: string }) => i.kind === "blocker").length, 0);

  // 10. Vault sync failure, then retry: the unconfirmed push is NOT reported saved and raises attention; the retry writes once and resolves it.
  let sync = await x.api(`/tasks/${a.id}/sync`, "POST", { rev: (await x.inspect(a.id)).rev });
  assert.equal(sync.status, 502);
  assert.equal(sync.data.sync.state, "unknown");
  cur = await x.inspect(a.id);
  assert.equal(cur.vault.coherence.state, "unknown");
  const vItem = cur.attention.items.find((i: { kind: string }) => i.kind === "vault-sync");
  assert.equal(vItem.state, "open");
  sync = await x.api(`/tasks/${a.id}/sync`, "POST", { rev: cur.rev });
  assert.equal(sync.status, 200);
  assert.equal(sync.data.sync.state, "synced");
  cur = await x.inspect(a.id);
  assert.equal(cur.vault.coherence.state, "current");
  assert.equal(cur.attention.items.filter((i: { kind: string }) => i.kind === "vault-sync").length, 0);
  assert.equal((await x.api(`/tasks/${a.id}/sync`, "POST", { rev: cur.rev })).data.sync.state, "up-to-date");
  assert.equal(note.appends, 1);
  // Project reconciliation: read-only, both tasks under one project, A's note current.
  const proj = (await x.api("/tasks/projects")).data.projects.find((p: { project: string }) => p.project === "example/garden");
  assert.equal(proj.tasks, 2);
  assert.deepEqual(proj.vault, { current: 1, "not-linked": 1 });

  // 11. Pause and resume: pause stops a running supervised turn; resume makes the task active again.
  x.d.ctl.gate = new Promise(() => {});
  x.d.ctl.taskSteps.push({ calls: [], reply: "held" });
  cur = await x.inspect(a.id);
  await x.api(`/tasks/${a.id}/turn`, "POST", { rev: cur.rev });
  cur = await x.inspect(a.id);
  const paused = await x.api(`/tasks/${a.id}/pause`, "POST", { rev: cur.rev });
  assert.equal(paused.data.stoppedRunningTurn, true);
  x.d.ctl.gate = undefined;
  x.d.ctl.taskSteps.length = 0;
  cur = await x.settled(a.id);
  assert.equal(cur.lastTurn.state, "error");
  // The aborted supervised turn is an attention item (the supervisor should know it did not finish).
  assert.ok(cur.attention.items.some((i: { kind: string; source: { turn?: number } }) => i.kind === "turn-failed" && i.source.turn === cur.lastTurn.n));
  const resumed = await x.api(`/tasks/${a.id}/resume`, "POST", { rev: cur.rev });
  assert.equal(resumed.data.task.lifecycle, "active");
  // The Assistant acknowledges the failed turn: it stays listed as acknowledged (not resolved, not hidden).
  const tf = resumed.data.task.attention.items.find((i: { kind: string }) => i.kind === "turn-failed");
  const acked = await x.assistantTool("task_attention_ack", { id: a.id, attention: tf.id, note: "paused on purpose" });
  assert.equal(acked.result.state, "acknowledged");
  assert.equal((await x.inspect(a.id)).attention.acknowledged, 1);

  // 12. Restart with an interrupted turn: a turn left running is marked interrupted (never re-run) and becomes an attention item.
  x.d.ctl.gate = new Promise(() => {});
  x.d.ctl.taskSteps.push({ calls: [], reply: "never" });
  cur = await x.inspect(a.id);
  await x.api(`/tasks/${a.id}/turn`, "POST", { rev: cur.rev });
  const restarted = taskStore(taskFile(x.dir));
  assert.deepEqual(restarted.recover(), [a.id]);
  const after = restarted.get(a.id)!;
  assert.equal(after.turns.at(-1)!.state, "interrupted");
  assert.ok(after.attention!.some((i) => i.kind === "turn-interrupted" && i.state === "open"));

  // 13. What no task can do: its turn is never offered the supervisor's tools (so it cannot turn automatic follow-up on, link, respond
  // or approve), its evidence is only claimed, and it cannot mark itself done.
  const turnSeen = [...x.d.seen].reverse().find((s) => s.taskTurn)!;
  for (const n of [...TASK_ASSISTANT_TOOL_NAMES, "job_launch", "research_launch", "task_complete"]) assert.ok(!turnSeen.tools.includes(n), n);
  assert.equal((await x.api(`/tasks/${a.id}/complete`, "POST", { rev: (await x.inspect(a.id)).rev })).status, 409);
  assert.ok(join(x.dir, "tasks.json"));
  void lastUser;
});
