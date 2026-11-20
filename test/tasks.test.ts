import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { evidenceStatus, parseCreate, readiness, requestStatus, TASK_OPEN_REQUESTS_MAX, TaskError, taskFile, taskStore, unseenInstructions } from "../src/tasks.ts";
import type { JobObservation, Observers, ProposalObservation, Provenance, Tasks } from "../src/tasks.ts";
import { cloneTaskVault, marker, taskVaultSync } from "../src/task-vault.ts";
import type { TaskVaultPort } from "../src/task-vault.ts";
import { VaultError } from "../src/vault/edit.ts";
import { makeFixture } from "./vault-fixture.ts";

// Supervised tasks, store level (docs/adr/0003-supervised-tasks.md). Synthetic data in temporary directories only: no ORBIT state,
// no vault, no network. The vault-pipeline test uses the throwaway bare repository of test/vault-fixture.ts.

const HUMAN: Provenance = { actor: "human", via: "task-panel" };
const ASSISTANT: Provenance = { actor: "assistant", via: "assistant-tool", userMessage: "m1" };
const TASK = (turn = 1): Provenance => ({ actor: "task", via: "task-turn", turn });
const NOW = new Date("2026-11-20T12:00:00.000Z");
const clock = () => NOW;
const INPUT = { title: "Garden sensor report", goal: "A weekly CSV of synthetic garden sensor readings exists.", acceptance: ["The CSV has one row per sensor per day", "A test checks the totals"] };

const fresh = (dir?: string) => taskStore(taskFile(dir ?? mkdtempSync(join(tmpdir(), "orbit-tasks-"))), clock);
const make = (tasks: Tasks, input: Record<string, unknown> = INPUT) => tasks.create(parseCreate(input as never, NOW), ASSISTANT, () => randomUUID()).task;
const noObs: Observers = { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) };
const expectError = (fn: () => unknown, code: number, re?: RegExp) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TaskError, `expected TaskError, got ${e}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return;
  }
  assert.fail("expected an error");
};

test("create: validated input, stable task id (not a session id), linked thread, active with no turn; identical create is deduplicated", () => {
  const tasks = fresh();
  const t = make(tasks);
  assert.match(t.id, /^task-[0-9a-f-]{36}$/);
  assert.equal(t.lifecycle, "active");
  assert.equal(t.rev, 1);
  assert.deepEqual(t.acceptance.map((c) => c.id), ["ac1", "ac2"]);
  assert.equal(t.turns.length, 0);
  assert.deepEqual(t.createdBy, ASSISTANT);
  // The same create again (a repeated tool call) returns the first task; no thread is made for it.
  let made = 0;
  const again = tasks.create(parseCreate(INPUT as never, NOW), ASSISTANT, () => (made++, randomUUID()));
  assert.equal(again.duplicate, true);
  assert.equal(again.task.id, t.id);
  assert.equal(made, 0);
  assert.equal(tasks.all().length, 1);
  expectError(() => parseCreate({ title: "x", goal: "y", acceptance: [] } as never, NOW), 400, /acceptance criteria/);
  expectError(() => parseCreate({ ...INPUT, vaultNote: "Journal/2026/x.md", vaultHeading: "## Status" } as never, NOW), 400, /Projects\/ or Tasks\//);
  expectError(() => parseCreate({ ...INPUT, vaultNote: "Tasks/x.md", vaultHeading: "Status" } as never, NOW), 400, /heading/);
  expectError(() => parseCreate({ ...INPUT, followUpAt: "2020-01-01T00:00:00Z" } as never, NOW), 400, /followUpAt/);
});

test("persistence and restart: the same task, instructions, requests and evidence come back; a turn left running is marked interrupted, never re-run", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-tasks-"));
  const a = fresh(dir);
  const t = make(a);
  a.steer(t.id, 1, "Use only synthetic data.", HUMAN);
  a.fileRequest(t.id, { kind: "clarification", text: "Which sensors count?" }, TASK(1));
  a.addEvidence(t.id, { criterion: "ac1", kind: "note", ref: "draft CSV written" }, TASK(1));
  const begun = a.beginTurn(t.id, undefined, ASSISTANT, "fake/scripted");
  assert.equal(begun.turn.state, "running");
  // A new store over the same file (a restart).
  const b = fresh(dir);
  assert.deepEqual(b.recover(), [t.id]);
  const back = b.get(t.id)!;
  assert.equal(back.id, t.id);
  assert.equal(back.session.thread, t.session.thread);
  assert.equal(back.instructions[0]!.text, "Use only synthetic data.");
  assert.equal(back.requests[0]!.state, "pending");
  assert.equal(back.evidence.length, 1);
  assert.equal(back.turns.at(-1)!.state, "interrupted");
  assert.match(back.turns.at(-1)!.error!, /not re-run/);
  // Recovery runs once per load and a second start finds nothing to repair.
  assert.deepEqual(b.recover(), []);
  assert.deepEqual(fresh(dir).recover(), []);
  // A new turn gets the next number: turn numbers are never reused.
  assert.equal(b.beginTurn(t.id, undefined, ASSISTANT, "fake").turn.n, 2);
});

test("an unreadable or newer task file is reported and never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-tasks-"));
  writeFileSync(join(dir, "tasks.json"), "{not json");
  const tasks = fresh(dir);
  assert.equal(tasks.status().state, "unavailable");
  assert.throws(() => make(tasks), (e: unknown) => e instanceof TaskError && e.code === 503);
  assert.equal(readFileSync(join(dir, "tasks.json"), "utf8"), "{not json");
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({ v: 99, tasks: [] }));
  const newer = fresh(dir);
  assert.equal(newer.status().state, "unavailable");
  assert.match(newer.status().detail, /schema version 99/);
});

test("stale mutations are refused and change nothing; concurrent steering with the same base rev: exactly one wins", () => {
  const tasks = fresh();
  const t = make(tasks);
  const first = tasks.steer(t.id, 1, "Prefer CSV over XLSX.", HUMAN);
  assert.equal(first.task.rev, 2);
  assert.equal(first.instruction.v, 1);
  // A second steer based on the same view (rev 1) conflicts.
  expectError(() => tasks.steer(t.id, 1, "Prefer XLSX.", ASSISTANT), 409, /stale/);
  expectError(() => tasks.setLifecycle(t.id, 1, "paused", ASSISTANT), 409, /stale/);
  const now = tasks.get(t.id)!;
  assert.equal(now.rev, 2);
  assert.equal(now.instructions.length, 1);
  assert.equal(now.lifecycle, "active");
  // With the current rev it is accepted as version 2; both versions are kept with their provenance.
  const second = tasks.steer(t.id, 2, "Prefer XLSX after all.", ASSISTANT);
  assert.deepEqual(second.task.instructions.map((i) => [i.v, i.by.actor]), [[1, "human"], [2, "assistant"]]);
  expectError(() => tasks.steer(t.id, undefined as never, "", HUMAN), 400);
  expectError(() => tasks.requireRev(undefined), 400, /rev is required/);
});

test("an owner request id makes a repeated steer or turn request a no-op", () => {
  const tasks = fresh();
  const t = make(tasks);
  const a = tasks.steer(t.id, 1, "Add a README.", HUMAN, "owner:req-12345678");
  const b = tasks.steer(t.id, 1, "Add a README.", HUMAN, "owner:req-12345678");
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(tasks.get(t.id)!.instructions.length, 1);
  const r1 = tasks.beginTurn(t.id, 2, HUMAN, "fake", "owner:turn-12345678");
  const r2 = tasks.beginTurn(t.id, 2, HUMAN, "fake", "owner:turn-12345678");
  assert.equal(r2.duplicate, true);
  assert.equal(r2.turn.n, r1.turn.n);
  assert.equal(tasks.get(t.id)!.turns.length, 1);
});

test("turns of one task are serialized; a paused or cancelled task starts none; only Rai cancels", () => {
  const tasks = fresh();
  const t = make(tasks);
  const r = tasks.beginTurn(t.id, undefined, ASSISTANT, "fake");
  expectError(() => tasks.beginTurn(t.id, undefined, ASSISTANT, "fake"), 409, /already running/);
  tasks.endTurn(t.id, r.turn.n, { state: "done", reply: "did it" });
  // The ended turn saw instruction version 0; a steer after it is unseen until the next turn.
  tasks.steer(t.id, tasks.get(t.id)!.rev, "Also chart it.", HUMAN);
  assert.equal(unseenInstructions(tasks.get(t.id)!).length, 1);
  const p = tasks.setLifecycle(t.id, tasks.get(t.id)!.rev, "paused", ASSISTANT, "waiting for Rai");
  assert.equal(p.lifecycle, "paused");
  expectError(() => tasks.beginTurn(t.id, undefined, ASSISTANT, "fake"), 409, /paused/);
  expectError(() => tasks.fileRequest(t.id, { kind: "blocker", text: "x" }, TASK(2)), 409, /paused/);
  expectError(() => tasks.setLifecycle(t.id, p.rev, "cancelled", ASSISTANT), 403, /Only Rai/);
  const c = tasks.setLifecycle(t.id, p.rev, "cancelled", HUMAN);
  assert.equal(c.lifecycle, "cancelled");
  assert.deepEqual(c.lifecycleHistory.map((h) => [h.from, h.to, h.by.actor]), [["active", "paused", "assistant"], ["paused", "cancelled", "human"]]);
  // Terminal: nothing else changes.
  expectError(() => tasks.steer(t.id, c.rev, "more", HUMAN), 409, /cancelled/);
  expectError(() => tasks.setLifecycle(t.id, c.rev, "active", HUMAN), 409, /cancelled/);
});

test("duplicate requests are counted, not filed twice; the open-request cap stops a task flooding its supervisor", () => {
  const tasks = fresh();
  const t = make(tasks);
  const a = tasks.fileRequest(t.id, { kind: "job", text: "Run the CSV build", brief: "Build the CSV exporter with tests." }, TASK(1));
  const b = tasks.fileRequest(t.id, { kind: "job", text: "  run the CSV   build ", brief: "Build the CSV exporter with tests." }, TASK(2));
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.request.id, a.request.id);
  const stored = tasks.get(t.id)!;
  assert.equal(stored.requests.length, 1);
  assert.equal(stored.requests[0]!.duplicates, 1);
  // A different brief is a different request.
  assert.equal(tasks.fileRequest(t.id, { kind: "job", text: "Run the CSV build", brief: "Something else." }, TASK(2)).duplicate, false);
  for (let i = 0; i < TASK_OPEN_REQUESTS_MAX - 2; i++) tasks.fileRequest(t.id, { kind: "clarification", text: `question ${i}` }, TASK(3));
  expectError(() => tasks.fileRequest(t.id, { kind: "clarification", text: "one too many" }, TASK(3)), 429);
  expectError(() => tasks.fileRequest(t.id, { kind: "job", text: "no brief" }, TASK(3)), 400, /brief/);
});

test("request status is explicit and derived: pending -> awaiting-confirmation -> confirmed -> running -> result; expiry allows a new link", () => {
  const tasks = fresh();
  const t = make(tasks);
  const req = tasks.fileRequest(t.id, { kind: "job", text: "Run the build", brief: "Build it." }, TASK(1)).request;
  const props = new Map<string, ProposalObservation>();
  const jobsMap = new Map<string, JobObservation>();
  const obs: Observers = { proposal: (id) => props.get(id) ?? { state: "unknown" }, job: (id) => jobsMap.get(id) ?? { found: false, why: "missing" } };
  assert.equal(requestStatus(req, obs).status, "pending");
  // A clarification answer is not a way to resolve a job request.
  expectError(() => tasks.respond(t.id, tasks.get(t.id)!.rev, req.id, "answer", ASSISTANT, { text: "ok" }), 400, /job request/);
  props.set("p1", { state: "awaiting-confirmation" });
  const linked = tasks.respond(t.id, tasks.get(t.id)!.rev, req.id, "link", ASSISTANT, { proposal: "p1", observe: obs.proposal }).request;
  assert.equal(linked.state, "proposed");
  assert.equal(requestStatus(linked, obs).status, "awaiting-confirmation");
  // While the card waits, a second link is refused.
  props.set("p2", { state: "awaiting-confirmation" });
  expectError(() => tasks.respond(t.id, tasks.get(t.id)!.rev, req.id, "link", ASSISTANT, { proposal: "p2", observe: obs.proposal }), 409, /awaiting-confirmation/);
  props.set("p1", { state: "confirmed", job: "orbit-202611201200-ab12" });
  assert.equal(requestStatus(linked, obs).status, "confirmed");
  jobsMap.set("orbit-202611201200-ab12", { found: true, state: "running" });
  assert.equal(requestStatus(linked, obs).status, "running");
  jobsMap.set("orbit-202611201200-ab12", { found: true, state: "failed" });
  const result = requestStatus(linked, obs);
  assert.equal(result.status, "result");
  assert.equal(result.jobState, "failed");
  assert.match(result.detail!, /not task completion/);
  // An expired card: not confirmed, and a new proposal may be linked; the old one is kept in `previous`.
  const r2 = tasks.fileRequest(t.id, { kind: "job", text: "Run the docs build", brief: "Docs." }, TASK(1)).request;
  props.set("p3", { state: "awaiting-confirmation" });
  tasks.respond(t.id, tasks.get(t.id)!.rev, r2.id, "link", ASSISTANT, { proposal: "p3", observe: obs.proposal });
  props.set("p3", { state: "expired" });
  assert.equal(requestStatus(tasks.get(t.id)!.requests[1]!, obs).status, "not-confirmed");
  props.set("p4", { state: "awaiting-confirmation" });
  const relinked = tasks.respond(t.id, tasks.get(t.id)!.rev, r2.id, "link", ASSISTANT, { proposal: "p4", observe: obs.proposal }).request;
  assert.equal(relinked.proposal!.id, "p4");
  assert.deepEqual(relinked.previous!.map((p) => [p.id, p.endedAs]), [["p3", "expired"]]);
  // One proposal cannot answer two requests.
  const r3 = tasks.fileRequest(t.id, { kind: "job", text: "Third", brief: "Third." }, TASK(1)).request;
  expectError(() => tasks.respond(t.id, tasks.get(t.id)!.rev, r3.id, "link", ASSISTANT, { proposal: "p4", observe: obs.proposal }), 409, /already linked/);
  // The Assistant cannot withdraw a task's request.
  expectError(() => tasks.respond(t.id, tasks.get(t.id)!.rev, r3.id, "withdraw", ASSISTANT, {}), 403);
});

test("completion needs acceptance evidence: a model's claim or a job ending is not enough, and only Rai can mark a task done", () => {
  const tasks = fresh();
  const t = make(tasks);
  const JOB = "orbit-202611201200-cd34";
  const props = new Map<string, ProposalObservation>();
  const jobsMap = new Map<string, JobObservation>();
  const obs: Observers = { proposal: (id) => props.get(id) ?? { state: "unknown" }, job: (id) => jobsMap.get(id) ?? { found: false, why: "missing" } };
  expectError(() => tasks.complete(t.id, 1, HUMAN, obs), 409, /ac1, ac2/);
  // The task's model claims both criteria, and says a done job proves one: claimed, not accepted.
  tasks.addEvidence(t.id, { criterion: "ac1", kind: "note", ref: "I checked it, it is done" }, TASK(1));
  tasks.addEvidence(t.id, { criterion: "ac2", kind: "job", ref: JOB }, TASK(1));
  jobsMap.set(JOB, { found: true, state: "done" });
  let task = tasks.get(t.id)!;
  assert.equal(evidenceStatus(task, task.evidence[1]!, obs).status, "claimed");
  expectError(() => tasks.complete(t.id, task.rev, HUMAN, obs), 409, /Not done/);
  // A job this task's own request produced, that the job store shows done, verifies its criterion.
  const req = tasks.fileRequest(t.id, { kind: "job", text: "Run the tests", brief: "Run them." }, TASK(1)).request;
  props.set("p9", { state: "awaiting-confirmation" });
  tasks.respond(t.id, tasks.get(t.id)!.rev, req.id, "link", ASSISTANT, { proposal: "p9", observe: obs.proposal });
  props.set("p9", { state: "confirmed", job: JOB });
  task = tasks.get(t.id)!;
  assert.equal(evidenceStatus(task, task.evidence[1]!, obs).status, "verified");
  jobsMap.set(JOB, { found: true, state: "failed" });
  assert.equal(evidenceStatus(task, task.evidence[1]!, obs).status, "not-verified");
  jobsMap.set(JOB, { found: true, state: "done" });
  assert.deepEqual(readiness(task, obs).missing, ["ac1"]);
  // Neither the Assistant nor the task can complete it, even when it is ready.
  tasks.addEvidence(t.id, { criterion: "ac1", kind: "url", ref: "https://example.invalid/report" }, HUMAN, tasks.get(t.id)!.rev);
  task = tasks.get(t.id)!;
  assert.equal(readiness(task, obs).ready, true);
  expectError(() => tasks.complete(t.id, task.rev, ASSISTANT, obs), 403, /Only Rai/);
  expectError(() => tasks.complete(t.id, task.rev, TASK(2), obs), 403, /Only Rai/);
  // A running turn blocks completion.
  const turn = tasks.beginTurn(t.id, task.rev, HUMAN, "fake").turn;
  expectError(() => tasks.complete(t.id, tasks.get(t.id)!.rev, HUMAN, obs), 409, /running/);
  tasks.endTurn(t.id, turn.n, { state: "done" });
  const done = tasks.complete(t.id, tasks.get(t.id)!.rev, HUMAN, obs);
  assert.equal(done.lifecycle, "done");
  assert.match(done.lifecycleHistory.at(-1)!.reason!, /ac1=ev-3/);
});

test("stored text is masked for credential shapes and stripped of control characters", () => {
  const tasks = fresh();
  const fake = "sk" + "-" + "proj" + "-" + "Z".repeat(40);
  const t = make(tasks, { ...INPUT, goal: `Use the key ${fake} to\u0007 fetch data\u202e.` });
  assert.ok(!t.goal.includes(fake));
  assert.ok(!t.goal.includes("\u0007"));
  assert.ok(!t.goal.includes("\u202e"));
});

// ---- vault sync ---------------------------------------------------------------------------------------------------------

const linked = (tasks: Tasks) => make(tasks, { ...INPUT, vaultNote: "Tasks/garden-report.md", vaultHeading: "## Status" });
function fakePort(note: string | undefined) {
  const state = { note, writes: [] as string[], fail: undefined as Error | undefined };
  const port: TaskVaultPort = {
    read: async () => state.note,
    append: async (_p, _h, text) => {
      if (state.fail) throw state.fail;
      state.writes.push(text);
      state.note = `${state.note}\n${text}`;
      return { commit: "c".repeat(40) };
    },
  };
  return { port, state };
}

test("vault sync: failures are recorded and visible with attempts; manual retry succeeds; unchanged status writes nothing; a written line is never written twice", async () => {
  const tasks = fresh();
  const t = linked(tasks);
  const { port, state } = fakePort("# Garden report\n\n## Status\n- started by hand\n");
  const sync = taskVaultSync({ tasks, port, observers: noObs, now: clock });
  state.fail = new VaultError("sync_failed", "fetch failed");
  const failed = await sync.sync(t.id);
  assert.equal(failed.state, "failed");
  let v = tasks.get(t.id)!.vault!.sync;
  assert.equal(v.state, "failed");
  assert.equal(v.attempts, 1);
  assert.match(v.lastError!, /NOT saved \(sync_failed\)/);
  assert.equal(v.retry, "manual");
  // Sync bookkeeping does not bump rev (it is not task content, so it never makes a view stale).
  assert.equal(tasks.get(t.id)!.rev, 1);
  state.fail = undefined;
  const ok = await sync.sync(t.id);
  assert.equal(ok.state, "synced");
  v = tasks.get(t.id)!.vault!.sync;
  assert.equal(v.state, "synced");
  assert.equal(v.attempts, 2);
  assert.equal(v.lastError, undefined);
  assert.equal(state.writes.length, 1);
  assert.match(state.writes[0]!, /ORBIT task status: active; next: not set; acceptance evidence: 0\/2 criteria; requests waiting: 0/);
  assert.ok(state.writes[0]!.includes(marker(t.id, ok.key)));
  // Same facts: nothing is written.
  assert.equal((await sync.sync(t.id)).state, "up-to-date");
  assert.equal(state.writes.length, 1);
  // A crash after the push but before recording: the line is in the note; a retry finds it and writes nothing.
  tasks.setNextAction(t.id, "Draft the CSV", TASK(1));
  const key2 = (await (async () => {
    const { factsKey, statusFacts } = await import("../src/task-vault.ts");
    return factsKey(statusFacts(tasks.get(t.id)!, noObs));
  })());
  state.note += `\n- (orbit-task ${t.id} #${key2})`;
  assert.equal((await sync.sync(t.id)).state, "already-written");
  assert.equal(state.writes.length, 1);
  // A note that is gone: failed, never created.
  state.note = undefined;
  tasks.setNextAction(t.id, "Chart it", TASK(1));
  const gone = await sync.sync(t.id);
  assert.equal(gone.state, "failed");
  assert.match(gone.error!, /never creates task notes/);
  // A policy-protected note: blocked, no proposal.
  state.note = "# x\n## Status\n";
  state.fail = new VaultError("needs_confirmation", "This change needs Rai's confirmation: the note is tagged #rai.", ["the note is tagged #rai"]);
  const blocked = await sync.sync(t.id);
  assert.equal(blocked.state, "blocked");
  assert.equal(tasks.get(t.id)!.vault!.sync.state, "blocked");
  assert.match(blocked.error!, /never makes proposals/);
  // No vault on this ORBIT: failed with the reason, nothing attempted.
  const off = await taskVaultSync({ tasks, port: undefined, observers: noObs, now: clock }).sync(t.id);
  assert.equal(off.state, "failed");
  assert.match(tasks.get(t.id)!.vault!.sync.lastError!, /not enabled/);
});

test("vault sync through the real write pipeline (temporary bare repo): appends under the existing heading, keeps human edits, refuses protected notes and missing headings", async () => {
  const fx = makeFixture({
    "AGENTS.md": "# Vault rules\n",
    "System/conventions.md": "# Conventions\n",
    "System/memory.md": "# Memory\n",
    "Tasks/garden-report.md": "---\nstatus: active\n---\n# Garden report\n\n## Status\n- started by hand\n\n## Notes\n- human note\n",
    "Tasks/private.md": "# Private\n#rai\n\n## Status\n",
    "Tasks/no-heading.md": "# No heading here\n",
  });
  const clone = fx.make();
  const tasks = fresh();
  const t = linked(tasks);
  const sync = taskVaultSync({ tasks, port: cloneTaskVault(clone), observers: noObs, now: clock });
  const r = await sync.sync(t.id);
  assert.equal(r.state, "synced", r.error);
  const text = fx.remoteFile("Tasks/garden-report.md");
  // Front matter, the human's line and the other section are untouched; the status line is at the end of ## Status.
  assert.ok(text.startsWith("---\nstatus: active\n---\n# Garden report\n\n## Status\n- started by hand\n"));
  assert.match(text, /- started by hand\n- \d{4}-\d{2}-\d{2} ORBIT task status: active[^\n]*\(orbit-task task-[0-9a-f-]+ #[0-9a-f]{12}\)\n/);
  assert.match(text, /## Notes\n- human note\n/);
  assert.match(fx.remoteLog().split("\n")[0]!, /ORBIT <orbit@users\.noreply\.github\.com>/);
  // Rai edits the note meanwhile; the next sync appends and keeps the edit.
  fx.elsewhere({ "Tasks/garden-report.md": text.replace("- human note", "- human note, edited by Rai") });
  tasks.setNextAction(t.id, "Chart the readings", TASK(1));
  assert.equal((await sync.sync(t.id)).state, "synced");
  const after = fx.remoteFile("Tasks/garden-report.md");
  assert.match(after, /edited by Rai/);
  assert.equal((after.match(/ORBIT task status/g) ?? []).length, 2);
  // A #rai note: the pipeline asks for confirmation; task sync reports blocked and writes nothing.
  const p = make(tasks, { ...INPUT, title: "Private one", vaultNote: "Tasks/private.md", vaultHeading: "## Status" });
  const blocked = await sync.sync(p.id);
  assert.equal(blocked.state, "blocked");
  assert.equal(fx.remoteFile("Tasks/private.md"), "# Private\n#rai\n\n## Status\n");
  // A heading the note does not have: failed (ORBIT never adds headings).
  const h = make(tasks, { ...INPUT, title: "No heading", vaultNote: "Tasks/no-heading.md", vaultHeading: "## Status" });
  const missing = await sync.sync(h.id);
  assert.equal(missing.state, "failed");
  assert.equal(fx.remoteFile("Tasks/no-heading.md"), "# No heading here\n");
});
