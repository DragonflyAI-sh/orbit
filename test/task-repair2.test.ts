import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { proposals as newProposals } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { vaultMemory } from "../src/memory.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { isTaskExcludedNote, TaskNoteRefused, taskMemory, taskNotePath, taskScopedTools } from "../src/task-context.ts";
import { taskSupervisor } from "../src/task-supervisor.ts";
import { parseCreate, TASK_TURNS_KEPT, TaskError, taskFile, taskStore, unseenInstructions } from "../src/tasks.ts";
import type { Observers, Provenance, Tasks } from "../src/tasks.ts";
import { textReaderTools } from "../src/text-readers.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";

// Supervised tasks, Repair 2: the review findings on PR #153 (docs/adr/0003-supervised-tasks.md, "Repair 2"), at unit level, through
// the real vault memory port, task store, thread store and turn code. Synthetic data only.

const NOW = new Date("2026-11-20T12:00:00.000Z");
const clock = () => NOW;
const ASSISTANT: Provenance = { actor: "assistant", via: "assistant-tool" };
const HUMAN: Provenance = { actor: "human", via: "task-panel" };
const INPUT = { title: "Garden sensor report", goal: "A weekly CSV of synthetic garden sensor readings exists.", acceptance: ["The CSV has one row per sensor per day"] };
const noObs: Observers = { proposal: () => ({ state: "unknown" }), job: () => ({ found: false, why: "none" }) };
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const make = (tasks: Tasks) => tasks.create(parseCreate(INPUT as never, NOW), ASSISTANT, () => randomUUID()).task;
const code = (n: number, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === n && (!re || re.test(e.message));

// ---- finding 1: the task memory boundary against the real vault memory port ------------------------------------------------------

const MARK = "WALNUTLEDGER";
function vault() {
  const root = tmp("orbit-r2-vault-");
  const notes: Record<string, string> = {
    "Memory/recent-context.md": `rolling summary ${MARK}`,
    "Memory/garden-facts.md": "garden facts",
    "Projects/garden.md": "garden project",
    // A long ordinary note, read in pages.
    "Projects/long.md": Array.from({ length: 900 }, (_, i) => `line ${i} garden sensors`).join("\n"),
  };
  for (const [p, text] of Object.entries(notes)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  // Symbolic-link aliases of the rolling note: a file link and a directory link. The port never indexes links (src/memory.ts collect).
  symlinkSync(join(root, "Memory/recent-context.md"), join(root, "Projects/alias.md"));
  symlinkSync(join(root, "Memory"), join(root, "MemAlias"));
  return { root, notes };
}

test("repair 2 finding 1: spellings the port itself resolves to the rolling note (absolute, through the root's own name) are refused in a task turn; the ordinary port still resolves them", () => {
  const { root } = vault();
  const plain = vaultMemory(root);
  const scoped = taskMemory(plain);
  const abs = join(root, "Memory/recent-context.md");
  const viaRoot = `../${basename(root)}/Memory/recent-context.md`;
  // The bypass Repair 1 left: the ordinary port reads these as the note itself.
  assert.match(plain.read(abs).value, new RegExp(MARK));
  assert.match(plain.read(viaRoot).value, new RegExp(MARK));
  const spellings = [
    abs,
    `${root}//Memory/./recent-context.md`,
    `${root}/Projects/../Memory/recent-context.md`,
    viaRoot,
    `Projects/../../${basename(root)}/Memory/recent-context.md`,
    "/Memory/recent-context.md",
    "//Memory/recent-context.md",
    "Memory/recent-context.md",
    "./Memory/recent-context.md",
    "Memory//recent-context.md",
    "Memory/./recent-context.md",
    "Memory/recent-context.md/",
    "Projects/../Memory/recent-context.md",
    "memory/RECENT-context.md",
    "Memory\\recent-context.md",
    "~/Memory/recent-context.md",
    "C:\\vault\\Memory\\recent-context.md",
    " Memory/recent-context.md\t",
    "Memory/recent-context.md\u0000",
  ];
  for (const p of spellings) {
    assert.throws(() => scoped.read(p), (e: unknown) => e instanceof TaskNoteRefused && !new RegExp(MARK).test((e as Error).message), p);
    assert.equal(isTaskExcludedNote(p), true, p);
  }
  // Symlink aliases are not notes to the port (never indexed), so they cannot name the rolling note either way.
  for (const p of ["Projects/alias.md", "MemAlias/recent-context.md"]) {
    assert.throws(() => plain.read(p), /no such note/, p);
    assert.throws(() => scoped.read(p), /no such note/, p);
  }
  assert.ok(!plain.search("rolling summary walnutledger").value.some((h) => /alias/i.test(h.path)), "links are not indexed");
});

test("repair 2 finding 1: ordinary notes stay readable under every accepted spelling (the canonical path is what the port is given); search and excerpts drop only the rolling note", () => {
  const { root, notes } = vault();
  const plain = vaultMemory(root);
  const scoped = taskMemory(plain);
  for (const p of ["Projects/garden.md", "./Projects/garden.md", "Projects//garden.md", "Projects/./garden.md", "Projects/garden.md/", " Projects/garden.md "]) assert.equal(scoped.read(p).value, notes["Projects/garden.md"], p);
  assert.equal(scoped.read("Memory/garden-facts.md").value, "garden facts", "other Memory/ notes stay readable");
  assert.deepEqual(taskNotePath("./Projects//garden.md/"), { ok: true, path: "Projects/garden.md", excluded: false });
  // Search (what the automatic excerpts and memory_search use) never returns the rolling note, and still fills the limit.
  assert.ok(plain.search("garden rolling summary walnutledger", 10).value.some((h) => h.path === "Memory/recent-context.md"));
  const hits = scoped.search("garden rolling summary walnutledger", 3).value.map((h) => h.path);
  assert.equal(hits.length, 3);
  assert.ok(!hits.includes("Memory/recent-context.md"));
  // Ordinary notes under spellings a task turn does not accept are refused as spellings (the boundary is fail-closed), not read.
  assert.throws(() => scoped.read(join(root, "Projects/garden.md")), /absolute paths are not accepted/);
  assert.throws(() => scoped.read("Memory/../Projects/garden.md"), /paths with \.\. are not accepted/);
});

test("repair 2 finding 1: memory_read_page over the task port: refuses the rolling note under absolute and traversal spellings (denied, no text) and pages an ordinary long note to the end", async () => {
  const { root, notes } = vault();
  const [page] = textReaderTools({ memory: taskMemory(vaultMemory(root)) });
  for (const p of [join(root, "Memory/recent-context.md"), `../${basename(root)}/Memory/recent-context.md`, "Memory//recent-context.md"]) {
    await assert.rejects(page!.run({ path: p }), (e: unknown) => /denied/.test(JSON.stringify(e) + String((e as Error).message ?? "")) && !new RegExp(MARK).test(String((e as Error).message)), p);
  }
  // Paging an ordinary note: every page comes from the canonical path, through to the end.
  let cursor: string | undefined;
  let text = "";
  for (let i = 0; i < 50; i++) {
    const r = (await page!.run({ path: "./Projects//long.md", ...(cursor ? { cursor } : {}) })).value as { text: string; nextCursor?: string | null; done?: boolean };
    text += r.text;
    cursor = r.nextCursor ?? undefined;
    if (!cursor) break;
  }
  assert.equal(text, notes["Projects/long.md"]);
});

test("repair 2 finding 1: vault write tools in a task turn get the canonical path, and refuse absolute, traversal and rolling-note targets", async () => {
  const { root } = vault();
  const calls: string[] = [];
  const tool = (name: string, readOnly = false): ChatTool => ({ name, description: name, parameters: {}, readOnly, run: async (a) => (calls.push(`${name}:${String(a.path)}`), { value: "ok", provenance: "live", source: "test" }) });
  const [replace] = taskScopedTools([tool("vault_replace_text")]);
  for (const p of [join(root, "Memory/recent-context.md"), `../${basename(root)}/Memory/recent-context.md`, "Memory/../Memory/recent-context.md", "/Tasks/garden.md", "Memory/recent-context.md"])
    await assert.rejects(replace!.run({ path: p, find: "x", replace: "y" }), /vault_replace_text is refused here: .*Nothing was written/, p);
  await replace!.run({ path: "./Tasks//garden.md", find: "x", replace: "y" });
  assert.deepEqual(calls, ["vault_replace_text:Tasks/garden.md"]);
});

// ---- finding 2: a repeated turn request whose turn record aged out ----------------------------------------------------------------

function supRig(tasks: Tasks) {
  let prepared = 0;
  const sup = taskSupervisor({
    tasks,
    createThread: () => randomUUID(),
    threadBusy: () => false,
    threadExists: () => true,
    turn: async () => ({ thread: { id: "t", title: "t", messages: [{ id: "m1", role: "assistant", text: "ok", calls: [] }] } as never }),
    prepare: async () => ((prepared += 1), { used: [], current: [], offered: [] }),
    allowChat: () => () => undefined,
    decide: () => ({ allow: true, reason: "test" }),
    observers: noObs,
    linkable: () => ({ ok: false, why: "test" }),
    modelName: () => "fake",
    canUseTools: () => true,
    now: clock,
    log: () => {},
  });
  return { sup, prepared: () => prepared };
}

test("repair 2 finding 2: a repeated turn request returns its turn's real recorded state (error, interrupted); once that record aged out it is 409 expired, never an invented done, and nothing runs twice", async () => {
  const dir = tmp("orbit-r2-prior-");
  let tasks = taskStore(taskFile(dir), clock);
  const t = make(tasks);
  // An errored turn: the repeat answers with state error.
  const erroredRev = tasks.get(t.id)!.rev;
  let rev = erroredRev;
  const errored = tasks.beginTurn(t.id, rev, HUMAN, "fake", "owner:req-errored-01");
  tasks.endTurn(t.id, errored.turn.n, { state: "error", error: "model unavailable" });
  const again = tasks.beginTurn(t.id, rev, HUMAN, "fake", "owner:req-errored-01");
  assert.equal(again.duplicate, true);
  assert.equal(again.turn.state, "error");
  // An interrupted turn (ORBIT stopped while it ran): after the restart, the repeat answers with state interrupted, not re-run.
  rev = tasks.get(t.id)!.rev;
  tasks.beginTurn(t.id, rev, HUMAN, "fake", "owner:req-interrupt-1");
  tasks = taskStore(taskFile(dir), clock);
  tasks.recover();
  const seqBefore = tasks.get(t.id)!.turnSeq;
  const interrupted = tasks.beginTurn(t.id, rev, HUMAN, "fake", "owner:req-interrupt-1");
  assert.equal(interrupted.duplicate, true);
  assert.equal(interrupted.turn.state, "interrupted");
  assert.equal(tasks.get(t.id)!.turnSeq, seqBefore, "nothing new started");
  // Push the errored turn's record out of the kept window.
  for (let i = 0; i < TASK_TURNS_KEPT; i++) {
    const b = tasks.beginTurn(t.id, undefined, ASSISTANT, "fake");
    tasks.endTurn(t.id, b.turn.n, { state: "done" });
  }
  assert.ok(!tasks.get(t.id)!.turns.some((x) => x.n === errored.turn.n), "the errored turn's record aged out");
  const seq = tasks.get(t.id)!.turnSeq;
  assert.throws(() => tasks.beginTurn(t.id, erroredRev, HUMAN, "fake", "owner:req-errored-01"), code(409, new RegExp(`turn ${errored.turn.n} .*no longer kept.*unknown here \\(expired\\)\\. Nothing was started`)));
  // Through the supervisor (the owner route and task_run_turn): refused before anything is prepared or run.
  const s = supRig(tasks);
  await assert.rejects(s.sup.startTurn(t.id, { trigger: HUMAN, isOwner: true, expectRev: erroredRev, key: "owner:req-errored-01" }), code(409, /expired/));
  assert.equal(s.prepared(), 0, "no turn was prepared or sent to the model");
  assert.equal(tasks.get(t.id)!.turnSeq, seq, "no turn number was used");
  assert.equal(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0].turnSeq, seq, "and none was persisted");
});

// ---- finding 3: rollback by identity when a steer lands between admission and the failed append ------------------------------------

test("repair 2 finding 3: admission, an Assistant steer while the turn code awaits beforeTurn, append failure, rollback: only the admitted instruction is removed, the steer stays, versions are not reused, and a reload agrees", async () => {
  const dir = tmp("orbit-r2-revert-");
  const tasks = taskStore(taskFile(dir), clock);
  const threads = threadStore(join(dir, "threads"));
  const ctl = { failAppend: false, steerDuringPrep: false };
  const store = new Proxy(threads, { get: (t, k, r) => (k === "appendUser" && ctl.failAppend ? () => { throw new Error("disk full"); } : Reflect.get(t, k, r)) });
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "test", verifiedAt: NOW.toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (): Promise<Step> => ({ text: "reply", calls: [] }),
  };
  const t = tasks.create(parseCreate(INPUT as never, NOW), ASSISTANT, () => threads.create("Task: x", { taskSession: true }).id).task;
  // Deterministic interleaving: the turn code awaits beforeTurn after admission and before storing the message. The Assistant's steer
  // (task_steer, rev-checked) lands exactly there.
  let steered: number | undefined;
  const svc = threadService({
    threads: store,
    model,
    proposals: newProposals(),
    compact: false,
    beforeTurn: async () => {
      if (!ctl.steerDuringPrep) return;
      const cur = tasks.get(t.id)!;
      steered = tasks.steer(t.id, cur.rev, "Assistant: also include humidity.", ASSISTANT).instruction.v;
    },
  });
  const sup = taskSupervisor({
    tasks,
    createThread: (title) => threads.create(title, { taskSession: true }).id,
    threadBusy: (tid) => threads.isBusy(tid),
    threadExists: (tid) => Boolean(threads.get(tid)),
    turn: (tid, text, prep, opts) => svc.turn(tid, text, prep, opts),
    prepare: async () => ({ used: [], current: [], offered: [] }),
    allowChat: () => () => undefined,
    decide: () => ({ allow: true, reason: "test" }),
    observers: noObs,
    linkable: () => ({ ok: false, why: "test" }),
    modelName: () => "fake",
    canUseTools: () => true,
    now: clock,
    log: () => {},
  });
  const base = { memory: [], limits: [], tools: [], isOwner: true };
  // One instruction already seen by a completed interactive turn.
  const first = await sup.humanTurn(t.id, "Use metric units.", base);
  assert.deepEqual(first.admitted, { instruction: 1, turn: 1 });
  // The race.
  ctl.failAppend = true;
  ctl.steerDuringPrep = true;
  await assert.rejects(sup.humanTurn(t.id, "Rai: only synthetic readings.", base), /disk full/);
  ctl.failAppend = false;
  ctl.steerDuringPrep = false;
  assert.equal(steered, 3, "the steer was recorded after the admitted instruction (v2)");
  const check = (x: Tasks) => {
    const now = x.get(t.id)!;
    assert.deepEqual(now.instructions.map((i) => [i.v, i.by.actor, i.text]), [[1, "human", "Use metric units."], [3, "assistant", "Assistant: also include humidity."]], "no orphan instruction from the failed message; the steer kept");
    const failed = now.turns.find((x) => x.n === 2)!;
    assert.equal(failed.state, "error");
    assert.match(failed.error!, /Not run: the message could not be stored/);
    assert.equal(failed.instructionsSeen, 1, "the turn that never ran saw only what the turn before it saw");
    assert.deepEqual(unseenInstructions(now).map((i) => i.v), [3], "the Assistant's steer is still unseen by the task");
  };
  check(tasks);
  check(taskStore(taskFile(dir), clock)); // reload from the file
  // The removed version is not reused: the next instruction is v4.
  const next = await sup.humanTurn(t.id, "Rai: weekly totals too.", base);
  assert.equal(next.admitted?.instruction, 4);
  assert.deepEqual(tasks.get(t.id)!.instructions.map((i) => i.v), [1, 3, 4]);
  assert.equal(threads.get(t.session.thread)!.messages.filter((m) => m.role === "user").length, 2, "the failed message is not in the thread");
});

test("repair 2 finding 3: rollback touches only the admission's own records (identity mismatch removes nothing)", () => {
  const tasks = taskStore(taskFile(tmp("orbit-r2-ident-")), clock);
  const t = make(tasks);
  tasks.steer(t.id, tasks.get(t.id)!.rev, "from the panel", HUMAN);
  // A rollback naming v1 as a sessions-ui admission does not remove a task-panel steer that happens to have that version.
  tasks.revertAdmission(t.id, { instruction: 1 }, "test");
  assert.equal(tasks.get(t.id)!.instructions.length, 1);
});

// ---- finding 4: malformed, unsupported and newer schema versions ---------------------------------------------------------------------

test("repair 2 finding 4: a schema version that is not a positive whole number is malformed (not 'newer'); a newer one is newer; both are refused and the file is left as it is", () => {
  const cases: [unknown, RegExp][] = [
    [0, /not a valid version number, so the file is malformed or damaged/],
    [-1, /not a valid version number/],
    [1.5, /not a valid version number/],
    [Number.MAX_SAFE_INTEGER + 2, /not a valid version number/],
    [3, /schema version 3, newer than this build understands \(2\)/],
  ];
  for (const [v, re] of cases) {
    const dir = tmp("orbit-r2-ver-");
    const raw = JSON.stringify({ v, tasks: [] });
    writeFileSync(join(dir, "tasks.json"), raw);
    const tasks = taskStore(taskFile(dir), clock);
    assert.throws(() => tasks.all(), code(503, re), String(v));
    if (v !== 3) assert.throws(() => tasks.all(), (e: unknown) => !/newer/.test((e as Error).message), String(v));
    assert.throws(() => tasks.create(parseCreate(INPUT as never, NOW), HUMAN, () => randomUUID()), code(503));
    assert.equal(readFileSync(join(dir, "tasks.json"), "utf8"), raw, "the file is never overwritten");
  }
  const dir = tmp("orbit-r2-ver-");
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({ v: "2", tasks: [] }));
  assert.throws(() => taskStore(taskFile(dir), clock).all(), code(503, /unknown shape/));
});

// ---- finding 5: ownership of a task session is checked by humanTurn ---------------------------------------------------------------

test("repair 2 finding 5: humanTurn itself refuses a non-owner (403) in every lifecycle, and records nothing", async () => {
  const tasks = taskStore(taskFile(tmp("orbit-r2-owner-")), clock);
  const t = make(tasks);
  const s = supRig(tasks);
  const base = { memory: [], limits: [], tools: [], isOwner: false };
  await assert.rejects(s.sup.humanTurn(t.id, "hello", base), code(403, /Only Rai/));
  tasks.setLifecycle(t.id, tasks.get(t.id)!.rev, "cancelled", HUMAN);
  await assert.rejects(s.sup.humanTurn(t.id, "hello", base), code(403, /Only Rai/));
  assert.equal(tasks.get(t.id)!.instructions.length, 0);
  assert.equal(tasks.get(t.id)!.turns.length, 0);
});
