import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { proposals as newProposals } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { vaultMemory } from "../src/memory.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { isTaskExcludedNote, taskMemory, taskNotePath, taskScopedTools } from "../src/task-context.ts";
import { taskSupervisor } from "../src/task-supervisor.ts";
import { marker, taskVaultSync } from "../src/task-vault.ts";
import type { TaskVaultPort } from "../src/task-vault.ts";
import { evidenceStatus, parseCreate, TASK_FILE_VERSION, TaskError, taskFile, taskStore } from "../src/tasks.ts";
import type { LinkableProposal, Observers, Provenance, Tasks, TaskBackend } from "../src/tasks.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";
import { VaultError } from "../src/vault/edit.ts";

// Supervised tasks, repair of the first slice's review findings (docs/adr/0003-supervised-tasks.md, "Repair 1"), at unit level: the
// task memory policy, deterministic admission races through the real thread store and turn code, link exclusivity across a restart,
// legacy (version 1) records, and the vault sync's split between the vault write and ORBIT's bookkeeping. Synthetic data only.

const NOW = new Date("2026-11-20T12:00:00.000Z");
const clock = () => NOW;
const HUMAN: Provenance = { actor: "human", via: "task-panel" };
const ASSISTANT: Provenance = { actor: "assistant", via: "assistant-tool" };
const TASK = (turn = 1): Provenance => ({ actor: "task", via: "task-turn", turn });
const INPUT = { title: "Garden sensor report", goal: "A weekly CSV of synthetic garden sensor readings exists.", acceptance: ["The CSV has one row per sensor per day", "A test checks the totals"] };
const P = (id: string, brief: string, routine = "orbit"): LinkableProposal => ({ id, kind: "job_launch", routine, brief, origin: "assistant:assistant", createdAt: NOW.toISOString() });
const noObs: Observers = { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) };
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const make = (tasks: Tasks, input: Record<string, unknown> = INPUT) => tasks.create(parseCreate(input as never, NOW), ASSISTANT, () => randomUUID()).task;
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

// ---- finding 1: the task memory policy ---------------------------------------------------------------------------------------

test("finding 1: every spelling of the rolling note resolves to it and is excluded; search drops it; reads refuse it; other notes are untouched", () => {
  // Repair 2: spellings the port would resolve but the task policy does not accept (a leading slash, .., backslashes) are refused as
  // spellings; the rest are canonicalized and the canonical form is compared (test/task-repair2.test.ts has the port-level proof).
  for (const p of ["Memory/recent-context.md", "./Memory/recent-context.md", "Memory//recent-context.md", "/Memory/recent-context.md", "Projects/../Memory/recent-context.md", "Memory/./recent-context.md", "memory/RECENT-CONTEXT.md", "Memory\\recent-context.md", " Memory/recent-context.md ", "../Memory/recent-context.md/..", 42, undefined])
    assert.equal(isTaskExcludedNote(p), true, String(p));
  for (const p of ["Memory/recent-context.md.bak", "Memory/recent-context", "Projects/recent-context.md", "Memory/other.md"])
    assert.equal(isTaskExcludedNote(p), false, String(p));
  assert.deepEqual(taskNotePath("./Memory//recent-context.md/"), { ok: true, path: "Memory/recent-context.md", excluded: true });

  const root = tmp("orbit-task-memory-");
  const notes: Record<string, string> = { "Memory/recent-context.md": "garden cross-conversation WALNUTLEDGER", "Projects/garden.md": "garden project", "Memory/garden-facts.md": "garden facts" };
  for (const [p, text] of Object.entries(notes)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const plain = vaultMemory(root);
  const scoped = taskMemory(plain);
  assert.ok(plain.search("garden").value.some((h) => h.path === "Memory/recent-context.md"), "the ordinary port still finds it");
  const hits = scoped.search("garden", 2).value.map((h) => h.path);
  assert.equal(hits.length, 2, "the limit is still filled from the remaining notes");
  assert.ok(!hits.includes("Memory/recent-context.md"));
  assert.throws(() => scoped.read("Memory//recent-context.md"), /not available in a task session/);
  assert.equal(plain.read("Memory//recent-context.md").value, notes["Memory/recent-context.md"], "and the ordinary port can read it");
  assert.equal(scoped.read("Memory/garden-facts.md").value, "garden facts", "other Memory/ notes stay readable");
});

test("finding 1: vault write tools in a task turn refuse the rolling note as a target (no probing); other paths and read tools pass through", async () => {
  const calls: string[] = [];
  const tool = (name: string, readOnly = false): ChatTool => ({ name, description: name, parameters: {}, readOnly, run: async (a) => (calls.push(`${name}:${String(a.path)}`), { value: "ok", provenance: "live", source: "test" }) });
  const [replace, policy, other] = taskScopedTools([tool("vault_replace_text"), tool("vault_policy", true), tool("jobs_list", true)]);
  await assert.rejects(replace!.run({ path: "Memory/../Memory/recent-context.md", find: "x", replace: "y" }), /vault_replace_text is refused here: .*Nothing was written/);
  await replace!.run({ path: "Tasks/garden.md" });
  await policy!.run({});
  await other!.run({});
  assert.deepEqual(calls, ["vault_replace_text:Tasks/garden.md", "vault_policy:undefined", "jobs_list:undefined"]);
});

// ---- finding 2: admission through the real thread store and turn code, with a supervised turn held in its prepare step ---------

function admissionRig(o: { failAppend?: () => boolean } = {}) {
  const dir = tmp("orbit-task-admission-");
  const tasks = taskStore(taskFile(dir), clock);
  const threads = threadStore(join(dir, "threads"));
  // A thread store whose appendUser can be made to fail (a full disk), seen through the turn code as the real store.
  const store = new Proxy(threads, { get: (t, k, r) => (k === "appendUser" && o.failAppend?.() ? () => { throw new Error("disk full"); } : Reflect.get(t, k, r)) });
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "test", verifiedAt: NOW.toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (): Promise<Step> => ({ text: "reply", calls: [] }),
  };
  const svc = threadService({ threads: store, model, proposals: newProposals(), compact: false });
  const gate = { open: undefined as (() => void) | undefined, entered: undefined as (() => void) | undefined };
  const sup = taskSupervisor({
    tasks,
    createThread: (title) => threads.create(title, { taskSession: true }).id,
    threadBusy: (tid) => threads.isBusy(tid),
    threadExists: (tid) => Boolean(threads.get(tid)),
    turn: (tid, text, prep, opts) => svc.turn(tid, text, prep, opts),
    // The supervised turn's prepare step: held open while the test sends Rai's message. Its turn record already says running.
    prepare: async () => {
      if (gate.entered) {
        gate.entered();
        await new Promise<void>((resolve) => (gate.open = resolve));
      }
      return { used: [], current: [], offered: [] };
    },
    allowChat: () => () => undefined,
    decide: () => ({ allow: true, reason: "test" }),
    observers: noObs,
    linkable: () => ({ ok: false, why: "test" }),
    modelName: () => "fake",
    canUseTools: () => true,
    now: clock,
    log: () => {},
  });
  const t = tasks.create(parseCreate(INPUT as never, NOW), ASSISTANT, () => threads.create("Task: x", { taskSession: true }).id).task;
  const base = { memory: [], limits: [], tools: [], isOwner: true };
  return { tasks, threads, sup, t, gate, base };
}

test("finding 2: a supervised turn waiting in prepare (recorded running, thread not locked) makes Rai's message a clean refusal; after it, the retry is recorded exactly once", async () => {
  const r = admissionRig();
  const entered = new Promise<void>((resolve) => (r.gate.entered = resolve));
  const started = await r.sup.startTurn(r.t.id, { trigger: ASSISTANT, isOwner: true, expectRev: r.t.rev });
  await entered;
  assert.equal(r.tasks.get(r.t.id)!.turns.at(-1)!.state, "running");
  assert.equal(r.threads.isBusy(r.t.session.thread), false, "the supervised turn has not taken the thread lock yet");
  await assert.rejects(r.sup.humanTurn(r.t.id, "Use metric units.", r.base), (e: unknown) => e instanceof TaskError && e.code === 409 && /not sent or recorded/.test(e.message));
  assert.equal(r.tasks.get(r.t.id)!.instructions.length, 0, "the refused message is not an instruction");
  assert.equal(r.threads.get(r.t.session.thread)!.messages.length, 0, "and not in the thread");
  assert.equal(r.threads.isBusy(r.t.session.thread), false, "the refusal freed the lock");
  r.gate.entered = undefined;
  r.gate.open!();
  await started.done;
  assert.equal(r.tasks.get(r.t.id)!.turns.at(-1)!.state, "done", "the supervised turn was not disturbed by the refused message");
  const ok = await r.sup.humanTurn(r.t.id, "Use metric units.", r.base);
  assert.deepEqual(ok.admitted, { instruction: 1, turn: 2 });
  const after = r.tasks.get(r.t.id)!;
  assert.deepEqual(after.instructions.map((i) => i.text), ["Use metric units."]);
  assert.equal(after.turns.at(-1)!.instructionsSeen, 1);
  // Two of Rai's messages racing: exactly one is admitted while the other's turn holds the task.
  const [a, b] = await Promise.allSettled([r.sup.humanTurn(r.t.id, "first", r.base), r.sup.humanTurn(r.t.id, "second", r.base)]);
  assert.deepEqual([a.status, b.status].sort(), ["fulfilled", "rejected"]);
  assert.equal(r.tasks.get(r.t.id)!.instructions.length, 2);
});

test("finding 2: when the message cannot be stored after admission, the admission is undone (no instruction, turn ended as not run)", async () => {
  let fail = true;
  const r = admissionRig({ failAppend: () => fail });
  await assert.rejects(r.sup.humanTurn(r.t.id, "This will not be stored.", r.base), /disk full/);
  const t = r.tasks.get(r.t.id)!;
  assert.equal(t.instructions.length, 0);
  assert.equal(t.turns.at(-1)!.state, "error");
  assert.match(t.turns.at(-1)!.error!, /Not run: the message could not be stored/);
  assert.equal(r.threads.isBusy(r.t.session.thread), false);
  fail = false;
  const ok = await r.sup.humanTurn(r.t.id, "This one is stored.", r.base);
  // Repair 2: the undone admission's version (1) is not reused, so nothing that recorded v1 can later point at another text.
  assert.equal(ok.admitted?.instruction, 2);
  assert.deepEqual(r.tasks.get(r.t.id)!.instructions.map((i) => [i.v, i.text]), [[2, "This one is stored."]]);
});

// ---- finding 4: links across tasks and restarts; legacy records ----------------------------------------------------------------

test("finding 4: a proposal links one request across tasks, durably across a restart; earlier links stay reserved; mismatched routine refused", () => {
  const dir = tmp("orbit-task-links-");
  let tasks = taskStore(taskFile(dir), clock);
  const a = make(tasks);
  const b = make(tasks, { ...INPUT, title: "Second" });
  const ra = tasks.fileRequest(a.id, { kind: "job", text: "Build", brief: "Build the exporter." }, TASK()).request;
  const rb = tasks.fileRequest(b.id, { kind: "job", text: "Build", brief: "Build the exporter.", routine: "orbit" }, TASK()).request;
  expectError(() => tasks.respond(b.id, tasks.get(b.id)!.rev, rb.id, "link", ASSISTANT, { proposal: P("p-routine", "Build the exporter.", "other") }), 409, /routine orbit/);
  tasks.respond(a.id, tasks.get(a.id)!.rev, ra.id, "link", ASSISTANT, { proposal: P("p1", "Build  the\nexporter.") });
  assert.equal(tasks.get(a.id)!.requests[0]!.proposal!.binding!.match, "exact", "whitespace differences are not a different brief");
  // Restart: a new store over the same file still refuses p1 for task B.
  tasks = taskStore(taskFile(dir), clock);
  expectError(() => tasks.respond(b.id, tasks.get(b.id)!.rev, rb.id, "link", ASSISTANT, { proposal: P("p1", "Build the exporter.") }), 409, new RegExp(`already linked to task ${a.id}`));
  // An expired link moves to `previous`; its id stays reserved for everyone.
  const obs: Observers = { proposal: (id) => (id === "p1" ? { state: "expired" } : { state: "awaiting-confirmation" }), job: () => ({ found: false, why: "none" }) };
  tasks.respond(a.id, tasks.get(a.id)!.rev, ra.id, "link", ASSISTANT, { proposal: P("p2", "Build the exporter."), observe: obs.proposal });
  assert.deepEqual(tasks.get(a.id)!.requests[0]!.previous!.map((p) => [p.id, p.endedAs, p.binding?.match]), [["p1", "expired", "exact"]]);
  expectError(() => tasks.respond(b.id, tasks.get(b.id)!.rev, rb.id, "link", ASSISTANT, { proposal: P("p1", "Build the exporter.") }), 409, /as an earlier link/);
  assert.deepEqual(tasks.proposalLinks("p1"), [{ task: a.id, request: ra.id, current: false }]);
  assert.equal(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).v, TASK_FILE_VERSION);
});

test("finding 4 and 7: a version 1 file is read without inventing provenance: legacy links are never verified, ambiguous links are flagged, legacy request ids are refused; it is written as version 2 only on change", () => {
  const dir = tmp("orbit-task-legacy-");
  const id = `task-${randomUUID()}`;
  const other = `task-${randomUUID()}`;
  const base = (tid: string, extra: Record<string, unknown>) => ({ id: tid, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), rev: 3, title: "Legacy", goal: "g", acceptance: [{ id: "ac1", text: "c" }], lifecycle: "active", lifecycleHistory: [], session: { thread: randomUUID() }, createdBy: HUMAN, instructions: [], requests: [], evidence: [], turns: [], turnSeq: 0, ...extra });
  const legacyRequest = { id: "req-1", kind: "job", text: "Build", key: "k", createdAt: NOW.toISOString(), by: TASK(), job: { brief: "Build." }, state: "proposed", proposal: { id: "p-old", linkedAt: NOW.toISOString(), by: ASSISTANT } };
  const file = { v: 1, tasks: [base(id, { seen: ["owner:legacy-key-01"], requests: [legacyRequest], evidence: [{ id: "ev-1", criterion: "ac1", kind: "job", ref: "job-1", at: NOW.toISOString(), by: TASK() }] }), base(other, { requests: [legacyRequest] })] };
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(file));
  const tasks = taskStore(taskFile(dir), clock);
  const t = tasks.get(id)!;
  const obs: Observers = { proposal: () => ({ state: "confirmed", job: "job-1" }), job: () => ({ found: true, state: "done", proposal: "p-old" }), links: (pid) => tasks.proposalLinks(pid).length };
  // Two version 1 tasks link the same proposal (the old per-task check allowed it): ambiguous is checked after binding, so a legacy
  // link reports legacy-unbound first; either way it is never verified.
  const ex = evidenceStatus(t, t.evidence[0]!, obs).execution!;
  assert.equal(ex.state, "legacy-unbound");
  assert.equal(tasks.proposalLinks("p-old").length, 2);
  // A legacy request id cannot be answered safely: refused for both operations, nothing changed.
  expectError(() => tasks.steer(id, 3, "x", HUMAN, "owner:legacy-key-01"), 409, /earlier ORBIT build/);
  expectError(() => tasks.beginTurn(id, 3, HUMAN, "fake", "owner:legacy-key-01"), 409, /earlier ORBIT build/);
  assert.equal(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).v, 1, "reading does not rewrite the file");
  tasks.steer(id, 3, "new instruction", HUMAN, "owner:fresh-key-0001");
  const written = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
  assert.equal(written.v, 2);
  assert.deepEqual(written.tasks[0].seen, ["owner:legacy-key-01"], "legacy keys are kept, not converted into guesses");
  assert.equal(written.tasks[0].requests[0].proposal.binding, undefined, "no binding is invented for a legacy link");
  // A file newer than this build is refused and left alone.
  const newer = tmp("orbit-task-newer-");
  writeFileSync(join(newer, "tasks.json"), JSON.stringify({ v: TASK_FILE_VERSION + 1, tasks: [] }));
  expectError(() => taskStore(taskFile(newer), clock).all(), 503, /newer than this build/);
});

test("finding 4: ambiguous bound links (one proposal on two requests) are never verified", () => {
  const tasks = taskStore(taskFile(tmp("orbit-task-amb-")), clock);
  const a = make(tasks);
  const r = tasks.fileRequest(a.id, { kind: "job", text: "Build", brief: "Build." }, TASK()).request;
  tasks.respond(a.id, tasks.get(a.id)!.rev, r.id, "link", ASSISTANT, { proposal: P("p1", "Build.") });
  tasks.addEvidence(a.id, { criterion: "ac1", kind: "job", ref: "job-1" }, TASK());
  const t = tasks.get(a.id)!;
  const obs = (links: number): Observers => ({ proposal: () => ({ state: "confirmed", job: "job-1" }), job: () => ({ found: true, state: "done", proposal: "p1" }), links: () => links });
  assert.equal(evidenceStatus(t, t.evidence[0]!, obs(1)).execution!.state, "verified");
  assert.equal(evidenceStatus(t, t.evidence[0]!, obs(2)).execution!.state, "ambiguous");
  // A job whose own record names another proposal is not this request's, whatever the card says.
  const elsewhere: Observers = { ...obs(1), job: () => ({ found: true, state: "done", proposal: "p-other" }) };
  assert.equal(evidenceStatus(t, t.evidence[0]!, elsewhere).execution!.state, "unlinked");
  // A job registered without a work link: ORBIT's record does not say which proposal launched it.
  const noLink: Observers = { ...obs(1), job: () => ({ found: true, state: "done" }) };
  assert.equal(evidenceStatus(t, t.evidence[0]!, noLink).execution!.state, "unknown");
});

// ---- finding 6: the vault write and ORBIT's bookkeeping are separate facts --------------------------------------------------------

function failingBackend(dir: string) {
  const inner = taskFile(dir);
  const ctl = { failNextSave: false };
  const backend: TaskBackend = {
    persisted: true,
    load: () => inner.load(),
    save: (f) => {
      if (ctl.failNextSave) {
        ctl.failNextSave = false;
        throw new Error("ENOSPC: no space left on device");
      }
      inner.save(f);
    },
  };
  return { backend, ctl };
}

test("finding 6: append succeeds then the task record cannot be written: reported as written (with the commit), not as NOT saved; the retry records it without a second line", async () => {
  const { backend, ctl } = failingBackend(tmp("orbit-task-vault-"));
  const tasks = taskStore(backend, clock);
  const t = make(tasks, { ...INPUT, vaultNote: "Tasks/garden.md", vaultHeading: "## Status" });
  const state = { note: "# Garden\n\n## Status\n", appends: 0 };
  const port: TaskVaultPort = {
    read: async () => state.note,
    append: async (_p, _h, text) => {
      state.appends += 1;
      state.note += `${text}\n`;
      ctl.failNextSave = true; // the very next task-file write (the bookkeeping) fails
      return { commit: "a".repeat(40) };
    },
  };
  const sync = taskVaultSync({ tasks, port, observers: noObs, now: clock });
  const first = await sync.sync(t.id);
  assert.equal(first.state, "written-unrecorded");
  assert.equal(first.written, true);
  assert.equal(first.recorded, false);
  assert.equal(first.commit, "a".repeat(40));
  assert.match(first.error!, /WAS committed and pushed/);
  assert.doesNotMatch(first.error!, /NOT saved/);
  assert.match(first.retry!, /without writing another line/);
  assert.equal(tasks.get(t.id)!.vault!.sync.state, "never", "the task record honestly still shows its previous state");
  // Retry: the line is found by its key, recorded, and not written again.
  const second = await sync.sync(t.id);
  assert.equal(second.state, "already-written");
  assert.equal(second.recorded, true);
  assert.equal(state.appends, 1);
  assert.equal(state.note.split("\n").filter((l) => l.includes(marker(t.id, first.key))).length, 1);
  assert.equal(tasks.get(t.id)!.vault!.sync.state, "synced");
  assert.equal((await sync.sync(t.id)).state, "up-to-date");
});

test("finding 6: an unconfirmed push is 'unknown', never committed or saved; a policy-protected note is blocked with no proposal; a pre-push refusal is NOT saved", async () => {
  const tasks = taskStore(taskFile(tmp("orbit-task-vault2-")), clock);
  const t = make(tasks, { ...INPUT, vaultNote: "Tasks/garden.md", vaultHeading: "## Status" });
  let next: Error | undefined;
  const port: TaskVaultPort = { read: async () => "# Garden\n\n## Status\n", append: async () => { throw next!; } };
  const sync = taskVaultSync({ tasks, port, observers: noObs, now: clock });
  next = new VaultError("unverified", "The push reported success but ORBIT could not verify that the commit is on the remote.");
  const unknown = await sync.sync(t.id);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.written, false);
  assert.equal(unknown.commit, undefined);
  assert.match(unknown.error!, /NOT confirmed saved/);
  assert.doesNotMatch(unknown.error!, /committed/i);
  assert.equal(tasks.get(t.id)!.vault!.sync.state, "unknown");
  next = new Error("socket hang up");
  assert.equal((await sync.sync(t.id)).state, "unknown");
  next = new VaultError("needs_confirmation", "This change needs Rai's confirmation: a note tagged #rai.", ["a note tagged #rai"]);
  const blocked = await sync.sync(t.id);
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.error!, /never makes proposals; nothing was written/);
  next = new VaultError("secret_refused", "secret-shaped text");
  const refused = await sync.sync(t.id);
  assert.equal(refused.state, "failed");
  assert.match(refused.error!, /NOT saved \(secret_refused\)/);
  assert.equal(tasks.get(t.id)!.vault!.sync.attempts, 4);
});
