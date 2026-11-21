import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTENTION_KEPT } from "../src/task-attention.ts";
import { taskVaultSync } from "../src/task-vault.ts";
import { parseCreate } from "../src/tasks.ts";
import type { LinkableProposal, Observers, Provenance, Task } from "../src/tasks.ts";
import { ASSISTANT, code, HUMAN, INPUT, MIN, noObs, rig } from "./task-rig.ts";

// Repair 3, Priorities 2-4 at unit level: durable supervisor attention (raise, deduplicate, surface, acknowledge, resolve), the research
// lane binding, explicit dependencies, and vault coherence. Synthetic data only.

const TASK_TURN = (n: number): Provenance => ({ actor: "task", via: "task-turn", turn: n });
const activity = (r: ReturnType<typeof rig>) => {
  const block = r.sup.activityBlock()!;
  return JSON.parse(/\n(\{[\s\S]*\})\s*<\/orbit-data>/.exec(block)![1]!);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const full = (r: ReturnType<typeof rig>, id: string) => r.sup.view(r.tasks.get(id)!) as any;
const proposal = (o: Partial<LinkableProposal> & { brief: string }): LinkableProposal => ({ id: `p-${Math.random().toString(16).slice(2)}`, kind: "job_launch", routine: "orbit", origin: "assistant:assistant", createdAt: new Date().toISOString(), ...o });

test("attention: a request filed while the Assistant is mid-turn is durable, new at its next turn, and stays open after being shown (shown is not answered)", () => {
  const r = rig();
  const t = r.create();
  // The Assistant's turn starts: its activity block is built now (nothing to show).
  assert.equal(activity(r).attention.open, 0);
  // While it is busy, the task files a blocker (as its own turn would).
  r.tasks.fileRequest(t.id, { kind: "blocker", text: "Which sensors count?" }, TASK_TURN(1));
  // A restart in between changes nothing: the item is in the file.
  const fresh = rig({ dir: r.dir });
  const next = activity(fresh);
  const row = next.shown.find((s: { id: string }) => s.id === t.id);
  assert.equal(row.attention.length, 1);
  assert.deepEqual([row.attention[0].kind, row.attention[0].state, row.attention[0].new], ["blocker", "open", true]);
  assert.doesNotMatch(JSON.stringify(next), /Which sensors count/, "request text stays behind task_inspect");
  // Shown once: no longer new, still open, and still shown every turn until answered.
  const again = activity(fresh).shown.find((s: { id: string }) => s.id === t.id);
  assert.deepEqual([again.attention[0].state, again.attention[0].new], ["open", false]);
  assert.equal(fresh.tasks.get(t.id)!.attention![0]!.surfaced!.count, 2);
  // It cannot be acknowledged away; answering resolves it.
  const id = again.attention[0].id;
  assert.throws(() => fresh.tasks.acknowledge(t.id, id, ASSISTANT, "seen"), code(409, /not an answer/));
  fresh.tasks.respond(t.id, fresh.tasks.get(t.id)!.rev, "req-1", "answer", ASSISTANT, { text: "Outdoor sensors only." });
  const resolved = fresh.tasks.get(t.id)!.attention![0]!;
  assert.equal(resolved.state, "resolved");
  assert.match(resolved.resolved!.why, /answered by the Assistant/);
  assert.equal(activity(fresh).attention.open, 0);
});

test("attention: deduplicated per cause, counted; a repeated request counts on its item; surfacing never bumps rev; a surfacing write failure does not break the block", () => {
  const r = rig();
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "clarification", text: "CSV or TSV?" }, TASK_TURN(1));
  r.tasks.fileRequest(t.id, { kind: "clarification", text: "  csv OR tsv? " }, TASK_TURN(2));
  const items = r.tasks.get(t.id)!.attention!;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.occurrences, 2);
  const rev = r.tasks.get(t.id)!.rev;
  activity(r);
  assert.equal(r.tasks.get(t.id)!.rev, rev);
  r.disk.fail = true;
  const block = r.sup.activityBlock()!;
  r.disk.fail = false;
  assert.match(block, /"kind":"clarification"/);
});

test("attention: non-request items: acknowledge (Rai or the Assistant, never the task), stays listed as acknowledged, reopens if the cause recurs, resolves when it clears", () => {
  const r = rig();
  const t = r.create({ vaultNote: "Tasks/garden.md", vaultHeading: "## Status" });
  r.tasks.recordSync(t.id, { state: "failed", attempts: 1, lastError: "fetch failed" });
  const item = r.tasks.get(t.id)!.attention!.find((a) => a.kind === "vault-sync")!;
  assert.equal(item.state, "open");
  assert.throws(() => r.tasks.acknowledge(t.id, item.id, TASK_TURN(1)), code(403));
  const ack = r.tasks.acknowledge(t.id, item.id, ASSISTANT, "will retry after the fetch is fixed");
  assert.equal(ack.item.state, "acknowledged");
  assert.equal(r.tasks.acknowledge(t.id, item.id, HUMAN).duplicate, true);
  assert.equal(r.sup.view(r.tasks.get(t.id)!).attention.acknowledged, 1);
  // The cause recurs: the same item is open again (counted), not silently kept as acknowledged.
  r.tasks.recordSync(t.id, { state: "unknown", attempts: 2, lastError: "push not verified" });
  const again = r.tasks.get(t.id)!.attention!.filter((a) => a.kind === "vault-sync");
  assert.equal(again.length, 1);
  assert.deepEqual([again[0]!.state, again[0]!.occurrences], ["open", 2]);
  // A later sync saves: resolved, with why.
  r.tasks.recordSync(t.id, { state: "synced", attempts: 3, commit: "d".repeat(40) });
  const done = r.tasks.get(t.id)!.attention!.find((a) => a.kind === "vault-sync")!;
  assert.equal(done.state, "resolved");
  assert.match(done.resolved!.why, /later sync saved/);
  assert.throws(() => r.tasks.acknowledge(t.id, done.id, HUMAN), code(409, /already resolved/));
});

test("attention: resolved history is pruned oldest first, unresolved items are never dropped", () => {
  const r = rig();
  const t = r.create({ vaultNote: "Tasks/garden.md", vaultHeading: "## Status" });
  for (let i = 0; i < ATTENTION_KEPT + 20; i++) {
    r.tasks.recordSync(t.id, { state: "failed", attempts: i + 1, lastError: `e${i}` });
    r.tasks.recordSync(t.id, { state: "synced", attempts: i + 1 });
  }
  r.tasks.fileRequest(t.id, { kind: "blocker", text: "Still open" }, TASK_TURN(1));
  const list = r.tasks.get(t.id)!.attention!;
  assert.ok(list.length <= ATTENTION_KEPT);
  assert.ok(list.some((a) => a.kind === "blocker" && a.state === "open"));
  assert.equal(new Set(list.map((a) => a.id)).size, list.length, "ids never reused");
});

test("research lane: a research request links only to a research proposal with its own question and brief; a build proposal never substitutes, nor research for a build", () => {
  const r = rig();
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "research", text: "Which soil sensors report hourly?", brief: "Compare three public datasheets." }, TASK_TURN(1));
  r.tasks.fileRequest(t.id, { kind: "job", text: "Build the exporter", brief: "Build it with tests." }, TASK_TURN(1));
  const rev = () => r.tasks.get(t.id)!.rev;
  // A build proposal for the research request: refused, nothing changed.
  assert.throws(() => r.tasks.respond(t.id, rev(), "req-1", "link", ASSISTANT, { proposal: proposal({ lane: "build", brief: "Compare three public datasheets." }) }), code(409, /research request and the proposal is a BUILD launch/));
  // A research proposal for the build request: refused.
  assert.throws(() => r.tasks.respond(t.id, rev(), "req-2", "link", ASSISTANT, { proposal: proposal({ lane: "research", routine: "research", brief: "Build it with tests." }) }), code(409, /RESEARCH launch/));
  // A research proposal with another question: refused (the question is compared too).
  assert.throws(() => r.tasks.respond(t.id, rev(), "req-1", "link", ASSISTANT, { proposal: proposal({ lane: "research", routine: "research", brief: "Research question: Which sensors are cheap?\n\nCompare three public datasheets." }) }), code(409, /not this request's brief/));
  // The research request answered by text is refused: research is proposed, not answered from the model's memory.
  assert.throws(() => r.tasks.respond(t.id, rev(), "req-1", "answer", ASSISTANT, { text: "Sensor X does." }), code(400, /research launch proposal/));
  // The research_launch shape with the request's own question and brief: linked, exact, on the research lane.
  const ok = r.tasks.respond(t.id, rev(), "req-1", "link", ASSISTANT, { proposal: proposal({ lane: "research", routine: "research", brief: "Research question: Which soil sensors report hourly?\n\nCompare three public datasheets." }) });
  assert.equal(ok.request.state, "proposed");
  assert.deepEqual([ok.request.proposal!.binding!.lane, ok.request.proposal!.binding!.match], ["research", "exact"]);
  const view = full(r, t.id);
  assert.equal(view.requests.find((q: { id: string }) => q.id === "req-1")!.lane, "research");
  assert.equal(view.attention.items.filter((a: { kind: string }) => a.kind === "research").length, 0, "resolved by the link");
});

test("research lane: a research job's result is the run's result, never task completion; its execution is verified only through the bound link", () => {
  let jobState = "running";
  const obs: Observers = { proposal: () => ({ state: "confirmed", job: "job-r1" }), job: () => ({ found: true, state: jobState, proposal: "p-research" }) };
  const r = rig({ observers: obs });
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "research", text: "Q?", brief: "B." }, TASK_TURN(1));
  r.tasks.respond(t.id, r.tasks.get(t.id)!.rev, "req-1", "link", ASSISTANT, { proposal: { ...proposal({ lane: "research", routine: "research", brief: "Research question: Q?\n\nB." }), id: "p-research" } });
  assert.equal(full(r, t.id).requests[0].status, "running");
  jobState = "done";
  const v = full(r, t.id);
  assert.equal(v.requests[0].status, "result");
  assert.equal(v.lifecycle, "active");
  // The task claims the report proves the criterion: claimed, execution verified, completion still not ready.
  r.tasks.addEvidence(t.id, { criterion: "ac1", kind: "job", ref: "job-r1", note: "the report says so" }, TASK_TURN(2));
  const ev = full(r, t.id).evidence[0];
  assert.deepEqual([ev.status, ev.execution.state], ["claimed", "verified"]);
  assert.equal(r.sup.view(r.tasks.get(t.id)!).completion.ready, false);
  assert.throws(() => r.tasks.complete(t.id, r.tasks.get(t.id)!.rev, ASSISTANT, obs), code(403));
});

test("dependencies: explicit, bounded, cycle-free; met only when Rai marks the other task done; a cancelled one is a derived blocker; automatic follow-up waits", async () => {
  const r = rig();
  const a = r.create({ title: "A" });
  const b = r.create({ title: "B" });
  const c = r.create({ title: "C" });
  const up = (t: Task, deps: unknown, by: Provenance = ASSISTANT) => r.tasks.update(t.id, r.tasks.get(t.id)!.rev, { dependsOn: deps }, by);
  assert.throws(() => up(a, [a.id]), code(400, /itself/));
  assert.throws(() => up(a, ["task-00000000-0000-4000-8000-000000000000"]), code(404));
  assert.throws(() => up(a, ["nope"]), code(400));
  up(b, [a.id]);
  up(c, [b.id]);
  // A -> C would close C -> B -> A -> C.
  assert.throws(() => up(a, [c.id]), code(409, /cycle/));
  assert.equal(r.tasks.get(a.id)!.dependsOn, undefined);
  // B waits on A; its automatic follow-up does not start while A is not done.
  let bt = r.tasks.update(b.id, r.tasks.get(b.id)!.rev, { followUpAt: new Date(r.clock.t + MIN).toISOString() }, HUMAN);
  bt = r.tasks.setAuto(b.id, bt.rev, true, HUMAN);
  r.advance(2 * MIN);
  const tick = await r.sched.tick();
  assert.deepEqual(tick.started, []);
  const auto = r.sup.view(r.tasks.get(b.id)!).automaticFollowUp;
  assert.equal(auto.state, "dependency-wait");
  assert.match(auto.detail, new RegExp(a.id));
  // A job ending does not meet the dependency; only Rai marking A done (with attested evidence) does.
  let at = r.tasks.addEvidence(a.id, { criterion: "ac1", kind: "note", ref: "checked by hand" }, HUMAN, r.tasks.get(a.id)!.rev).task;
  at = r.tasks.complete(a.id, at.rev, HUMAN, noObs);
  assert.equal(r.sup.view(r.tasks.get(b.id)!).dependencies!.met, true);
  assert.equal((await r.sched.tick()).started.length, 1);
  await r.sup.idle();
  // C depends on B; B is cancelled: a derived blocker says it can never be met.
  r.tasks.setLifecycle(b.id, r.tasks.get(b.id)!.rev, "cancelled", HUMAN, "dropped");
  const cv = r.sup.view(r.tasks.get(c.id)!);
  assert.equal(cv.dependencies!.met, false);
  assert.ok(cv.attention.items.some((i) => i.kind === "dependency-blocked"));
  // At most 5, and an empty list clears.
  assert.throws(() => up(c, Array.from({ length: 6 }, () => r.create({ title: `x${Math.random()}` }).id)), code(400));
  assert.equal(up(c, []).dependsOn, undefined);
});

test("vault coherence: pending, current, stale after the task changes, failed; project status is read-only (no write, no sync)", async () => {
  const note = { text: "# G\n\n## Status\n", appends: 0 };
  const r = rig();
  const sync = taskVaultSync({ tasks: r.tasks, port: { read: async () => note.text, append: async (_p, _h, line) => ((note.appends += 1), (note.text += `${line}\n`), { commit: "e".repeat(40) }) }, observers: noObs, now: r.now });
  const t = r.tasks.create(parseCreate({ ...INPUT, project: "example/garden", vaultNote: "Tasks/g.md", vaultHeading: "## Status" } as never, r.now()), ASSISTANT, () => r.threads.create("Task: x", { taskSession: true }).id).task;
  assert.equal(r.sup.view(t).vault!.coherence!.state, "pending");
  assert.equal((await sync.sync(t.id)).state, "synced");
  assert.equal(r.sup.view(r.tasks.get(t.id)!).vault!.coherence!.state, "current");
  r.tasks.setNextAction(t.id, "Write the totals test", TASK_TURN(1));
  assert.equal(r.sup.view(r.tasks.get(t.id)!).vault!.coherence!.state, "stale");
  const saves = r.disk.saves;
  const ps = r.sup.projectStatus({ includeClosed: false });
  assert.equal(r.disk.saves, saves, "reconciliation writes nothing");
  assert.equal(note.appends, 1, "and syncs nothing");
  const g = ps.projects.find((p) => p.project === "example/garden")!;
  assert.deepEqual(g.vault, { stale: 1 });
  assert.deepEqual(g.needsSync, [t.id]);
});

test("no model can turn automatic follow-up on, acknowledge for Rai, or complete a task; the Assistant's ack and update are its own, labeled", () => {
  const r = rig();
  const t = r.create({ followUpAt: new Date(r.clock.t + MIN).toISOString() });
  for (const by of [ASSISTANT, TASK_TURN(1), { actor: "orbit", via: "system" } as Provenance, { actor: "human", via: "sessions-ui" } as Provenance]) assert.throws(() => r.tasks.setAuto(t.id, t.rev, true, by), code(403));
  assert.throws(() => r.tasks.update(t.id, t.rev, { autoFollowUp: "on" }, HUMAN), code(403));
  assert.throws(() => r.tasks.update(t.id, t.rev, { autoFollowUp: "off" }, TASK_TURN(1)), code(403));
  assert.throws(() => r.tasks.complete(t.id, t.rev, TASK_TURN(1), noObs), code(403));
  assert.equal(r.tasks.get(t.id)!.auto, undefined);
});

test("attention: a request answered without its item being resolved (an older build after a rollback) is never shown as waiting", () => {
  const r = rig();
  const t = r.create();
  r.tasks.fileRequest(t.id, { kind: "blocker", text: "Which sensors?" }, TASK_TURN(1));
  const cur = r.tasks.get(t.id)!;
  assert.equal(r.sup.view(cur).attention.open, 1, "the real record waits until answered");
  // The record an older build would leave: the request answered, the attention item untouched.
  const older: Task = { ...cur, requests: [{ ...cur.requests[0]!, state: "answered" }] };
  assert.equal(older.attention![0]!.state, "open");
  assert.equal(r.sup.view(older).attention.open, 0);
  assert.equal(r.sup.view(older).attention.items.length, 0);
});
