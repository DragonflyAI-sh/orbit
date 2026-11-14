import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ASSISTANT_ACTIVE_BUDGET_CHARS,
  ASSISTANT_CHUNK_MAX_CHARS,
  ASSISTANT_CONTEXT_BUDGET_CHARS,
  ASSISTANT_NOTES_MAX_CHARS,
  boundChunk,
  boundNotes,
  planContext,
  planItems,
} from "../src/assistant-context.ts";
import type { ChunkLike } from "../src/assistant-context.ts";
import { ASSISTANT_ID, assistantStore } from "../src/assistant-store.ts";
import type { Chunk } from "../src/assistant-store.ts";
import type { Item } from "../src/model.ts";
import { messageChars } from "../src/thread-context.ts";
import { MAX_MESSAGE_CHARS } from "../src/threads.ts";
import type { StoredCall, ThreadMessage } from "../src/threads.ts";

// The Assistant's chunk store and bounded context (docs/assistant.md). Offline: temp directories only, no model.

const tmp = () => mkdtempSync(join(tmpdir(), "orbit-assistant-"));
const words = (n: number, w = "lorem") => Array.from({ length: n }, (_, i) => `${w}${i % 10}`).join(" ");

const callOf = (name: string, output: string, args = "{}", i = 0): StoredCall => ({ callId: `call_${name}_${i}`, name, arguments: args, output, ok: true, provenance: "live", source: "test", summary: "ok", at: "t" });

// Runs one whole turn through the store the way src/thread-service.ts does.
function turn(s: ReturnType<typeof assistantStore>, text: string, reply: string, calls: StoredCall[] = []) {
  const token = s.tryBegin(ASSISTANT_ID)!;
  assert.ok(token, "the store is free");
  s.appendUser(ASSISTANT_ID, text);
  const mid = s.beginAssistant(ASSISTANT_ID);
  for (const c of calls) s.addCall(ASSISTANT_ID, mid, c);
  s.patchMessage(ASSISTANT_ID, mid, { text: reply, status: "done", provenance: "live", source: "model/test" });
  s.end(ASSISTANT_ID, token);
  return mid;
}

const files = (dir: string, sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")).sort() : []);
const seqs = (dir: string, sub: string) => files(dir, sub).map((f) => Number(f.slice(0, 12)));

// Every function_call is immediately followed by its own output, and every output follows its call.
function assertPaired(items: Item[]) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as { type?: string; call_id?: string };
    if (it.type === "function_call") {
      const next = items[i + 1] as { type?: string; call_id?: string } | undefined;
      assert.equal(next?.type, "function_call_output", "a call is followed by its output");
      assert.equal(next?.call_id, it.call_id, "with the same call id");
    }
    if (it.type === "function_call_output") assert.equal((items[i - 1] as { type?: string; call_id?: string }).call_id, it.call_id, "no orphan output");
  }
}
const itemChars = (items: Item[]) => items.reduce((n, it) => n + ("content" in it ? it.content.length : "output" in it ? it.output.length : it.arguments.length), 0);

test("the store starts empty, with one fixed identity in its own directory, separate from chat threads", () => {
  const dir = tmp();
  const s = assistantStore(join(dir, "assistant"));
  assert.equal(s.persisted, true);
  assert.equal(s.active().length, 0);
  assert.equal(s.archivedCount(), 0);
  const session = JSON.parse(readFileSync(join(dir, "assistant", "session.json"), "utf8"));
  assert.equal(session.id, ASSISTANT_ID);
  assert.deepEqual(readdirSync(dir), ["assistant"], "nothing is written outside <state>/assistant");
  assert.deepEqual(readdirSync(join(dir, "assistant")).sort(), ["active", "archive", "epoch.json", "session.json"]);
  // Only the one server-named conversation exists: any other id is unknown.
  assert.equal(s.get("11111111-1111-4111-8111-111111111111"), undefined);
  assert.equal(s.tryBegin("other"), undefined);
  assert.throws(() => s.appendUser("other", "x"), /No such conversation/);
});

test("the identity and every turn survive a restart; sequence numbers keep counting", () => {
  const dir = tmp();
  const s1 = assistantStore(dir, { now: () => new Date("2026-11-14T00:00:00Z") });
  turn(s1, "first", "one");
  turn(s1, "second", "two");
  const created = s1.session().createdAt;
  const s2 = assistantStore(dir, { now: () => new Date("2026-12-01T00:00:00Z") });
  assert.equal(s2.session().createdAt, created, "the session identity is written once and kept");
  assert.deepEqual(s2.active().map((c) => [c.seq, c.messages.map((m) => m.text)]), [[1, ["first", "one"]], [2, ["second", "two"]]]);
  turn(s2, "third", "three");
  assert.deepEqual(seqs(dir, "active"), [1, 2, 3]);
  const c = JSON.parse(readFileSync(join(dir, "active", "000000000003.json"), "utf8")) as Chunk;
  assert.equal(c.state, "complete");
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.ok(c.createdAt && c.updatedAt);
});

test("one turn at a time: a second begin is refused while one runs, and only the holder can end it", () => {
  const s = assistantStore(undefined);
  const a = s.tryBegin(ASSISTANT_ID)!;
  assert.equal(s.tryBegin(ASSISTANT_ID), undefined, "a concurrent send is refused, not queued");
  assert.equal(s.isBusy(ASSISTANT_ID), true);
  assert.equal(s.end(ASSISTANT_ID, Symbol("other")), false);
  assert.equal(s.isBusy(ASSISTANT_ID), true);
  assert.equal(s.end(ASSISTANT_ID, a), true);
  assert.equal(s.isBusy(ASSISTANT_ID), false);
});

test("a turn ended without a reply is closed as interrupted, never left open, and nothing is retried", () => {
  const s = assistantStore(undefined);
  const t = s.tryBegin(ASSISTANT_ID)!;
  s.appendUser(ASSISTANT_ID, "do it");
  s.beginAssistant(ASSISTANT_ID);
  s.end(ASSISTANT_ID, t);
  const [c] = s.active();
  assert.equal(c!.state, "complete");
  assert.equal(c!.messages[1]!.status, "interrupted");
  assert.match(c!.messages[1]!.error!, /Nothing was retried/);
});

test("crash recovery: an open chunk with a pending reply is marked interrupted on restart, kept, and not re-run", () => {
  const dir = tmp();
  const s1 = assistantStore(dir);
  turn(s1, "before", "fine");
  const t = s1.tryBegin(ASSISTANT_ID)!;
  s1.appendUser(ASSISTANT_ID, "launch the thing");
  const mid = s1.beginAssistant(ASSISTANT_ID);
  s1.addCall(ASSISTANT_ID, mid, callOf("job_status", '{"ok":true}'));
  void t; // the process "dies" here: end() never runs
  const s2 = assistantStore(dir);
  const chunks = s2.active();
  assert.equal(chunks.length, 2, "no turn lost or duplicated");
  const last = chunks[1]!;
  assert.equal(last.state, "complete");
  assert.equal(last.messages[0]!.text, "launch the thing");
  assert.equal(last.messages[1]!.status, "interrupted");
  assert.match(last.messages[1]!.error!, /restarted.*Nothing was retried/);
  assert.equal(last.messages[1]!.calls!.length, 1, "the call that really ran stays on record");
  // The recovered turn is history now: it is sent, with its call paired, and a new turn gets the next number.
  const items = planItems(s2.plan());
  assertPaired(items);
  turn(s2, "after", "ok");
  assert.deepEqual(seqs(dir, "active"), [1, 2, 3]);
});

test("rotation is deterministic, keeps order, archives the oldest complete chunks and never loses or duplicates one", () => {
  const run = () => {
    const dir = tmp();
    const s = assistantStore(dir, { activeBudget: 3_000 });
    for (let i = 1; i <= 12; i++) turn(s, `question ${i} ${words(60)}`, `answer ${i} ${words(60)}`);
    return { dir, s };
  };
  const a = run();
  const b = run();
  assert.deepEqual(seqs(a.dir, "active"), seqs(b.dir, "active"), "the same turns rotate the same way");
  assert.deepEqual(seqs(a.dir, "archive"), seqs(b.dir, "archive"));
  const active = seqs(a.dir, "active"), archived = seqs(a.dir, "archive");
  assert.ok(archived.length > 0, "something was archived");
  assert.deepEqual([...archived, ...active], Array.from({ length: 12 }, (_, i) => i + 1), "every turn is in exactly one place, in order");
  assert.ok(Math.max(...archived) < Math.min(...active), "the archive holds the oldest turns");
  const activeChars = a.s.active().reduce((n, c) => n + boundChunk(c).chars, 0);
  assert.ok(activeChars <= 3_000, `active window ${activeChars} is within its budget`);
  // Archived data is kept in full.
  const first = JSON.parse(readFileSync(join(a.dir, "archive", "000000000001.json"), "utf8")) as Chunk;
  assert.match(first.messages[0]!.text, /^question 1 /);
  assert.match(first.messages[1]!.text, /^answer 1 /);
  // A restart sees the same split.
  const again = assistantStore(a.dir, { activeBudget: 3_000 });
  assert.deepEqual(again.active().map((c) => c.seq), active);
  assert.equal(again.archivedCount(), archived.length);
});

test("the archive is paged from the newest down, a page at a time, and never put in the model's context", () => {
  const dir = tmp();
  const s = assistantStore(dir, { activeBudget: 1_200 });
  for (let i = 1; i <= 15; i++) turn(s, `q${i} ${words(40)}`, `a${i} ${words(40)}`);
  const archived = seqs(dir, "archive");
  assert.ok(archived.length >= 10);
  const p1 = s.archivePage(undefined, 4);
  assert.deepEqual(p1.chunks.map((c) => c.seq), archived.slice(-4));
  assert.equal(p1.more, true);
  const p2 = s.archivePage(p1.chunks[0]!.seq, 4);
  assert.deepEqual(p2.chunks.map((c) => c.seq), archived.slice(-8, -4));
  const rest = s.archivePage(archived[0]! + 1, 4);
  assert.deepEqual(rest.chunks.map((c) => c.seq), [archived[0]]);
  assert.equal(rest.more, false);
  const plan = s.plan();
  for (const i of plan.included) assert.ok(!archived.includes(i.seq), "no archived chunk is in the context plan");
  const sent = JSON.stringify(planItems(plan));
  assert.doesNotMatch(sent, /\bq1 /, "the oldest turn's text is not sent");
});

test("a chunk whose card can still be confirmed is not archived, and neither is anything after it, until the card is decided", () => {
  const dir = tmp();
  const live = new Set<string>();
  const s = assistantStore(dir, { activeBudget: 1_500, held: (card) => live.has(card.id) });
  const t = s.tryBegin(ASSISTANT_ID)!;
  s.appendUser(ASSISTANT_ID, `launch ${words(40)}`);
  const mid = s.beginAssistant(ASSISTANT_ID);
  s.addCard(ASSISTANT_ID, mid, { id: "card-1", kind: "job_launch", state: "open", createdAt: "t", expiresAt: "2999-01-01T00:00:00Z", routine: "orbit", brief: "b" });
  live.add("card-1");
  s.patchMessage(ASSISTANT_ID, mid, { text: "proposed", status: "done" });
  s.end(ASSISTANT_ID, t);
  for (let i = 0; i < 8; i++) turn(s, `more ${i} ${words(40)}`, `ok ${words(40)}`);
  assert.equal(s.active()[0]!.seq, 1, "the chunk with a live card stays active");
  assert.equal(s.archivedCount(), 0);
  // The plan still respects the budget even while the active window is held open.
  const plan = s.plan();
  assert.ok(plan.historyChars <= ASSISTANT_CONTEXT_BUDGET_CHARS);
  // Decided: the card's chunk (and the older backlog) can be archived by the next rotation; the card is still findable there.
  assert.equal(s.transitionCard("card-1", "open", "cancelled"), true);
  live.delete("card-1");
  s.rotate();
  assert.ok(s.archivedCount() > 0);
  assert.equal(seqs(dir, "archive")[0], 1);
  assert.equal(s.card("card-1")!.state, "cancelled", "a card in an archived chunk is still found");
  assert.equal(s.transitionCard("card-1", "open", "confirmed"), false, "and its single-use guard still holds");
});

test("crash between the two directories: a chunk found in both is used once (the archived copy) and reported", () => {
  const dir = tmp();
  const s = assistantStore(dir, { activeBudget: 1_000 });
  for (let i = 1; i <= 6; i++) turn(s, `t${i} ${words(40)}`, `r${i} ${words(40)}`);
  const archived = seqs(dir, "archive");
  assert.ok(archived.length);
  const seq = archived.at(-1)!;
  const name = `${String(seq).padStart(12, "0")}.json`;
  copyFileSync(join(dir, "archive", name), join(dir, "active", name));
  const s2 = assistantStore(dir, { activeBudget: 1_000 });
  assert.ok(!s2.active().some((c) => c.seq === seq), "not loaded as active");
  assert.match(s2.problems().join("\n"), new RegExp(`active/${name}: also in archive/`));
  assert.equal(s2.archivedCount(), archived.length);
  assert.ok(existsSync(join(dir, "active", name)), "the stray copy is left for a person to look at");
});

test("an unreadable chunk file is reported, left untouched, and its number is never reused", () => {
  const dir = tmp();
  const s = assistantStore(dir);
  turn(s, "a", "b");
  writeFileSync(join(dir, "active", "000000000002.json"), "{ not json");
  const s2 = assistantStore(dir);
  assert.match(s2.problems().join("\n"), /000000000002\.json/);
  turn(s2, "c", "d");
  assert.equal(readFileSync(join(dir, "active", "000000000002.json"), "utf8"), "{ not json");
  assert.deepEqual(seqs(dir, "active"), [1, 2, 3]);
});

test("stored text is masked like chat threads: a secret-shaped value in a message never reaches the disk", () => {
  const dir = tmp();
  const s = assistantStore(dir);
  const fake = "sk" + "-" + "proj" + "x".repeat(40);
  turn(s, `here is ${fake}`, "noted", [callOf("memory_search", JSON.stringify({ result: fake }))]);
  const raw = readFileSync(join(dir, "active", "000000000001.json"), "utf8");
  assert.equal(raw.includes(fake), false);
});

// ---- the context bound ------------------------------------------------------------------------------------------------

const chunkOf = (seq: number, messages: ThreadMessage[]): ChunkLike => ({ seq, id: `id-${seq}`, createdAt: "2026-11-14T00:00:00Z", messages });
const user = (text: string): ThreadMessage => ({ id: `u${Math.random()}`, role: "user", at: "t", text });
const reply = (text: string, calls: StoredCall[] = [], status: ThreadMessage["status"] = "done"): ThreadMessage => ({ id: `a${Math.random()}`, role: "assistant", at: "t", text, status, calls });

test("a huge tool result is cut, not the pairing: the bounded chunk keeps every call with its own result and says what was cut", () => {
  const huge = "R".repeat(200_000);
  const c = chunkOf(7, [user("read the log"), reply("done", [callOf("ops_logs", huge, "{}", 1), callOf("ops_logs", huge, "{}", 2)])]);
  const b = boundChunk(c);
  assert.equal(b.form, "clipped");
  assert.ok(b.chars <= ASSISTANT_CHUNK_MAX_CHARS);
  assert.equal(b.messages[1]!.calls!.length, 2, "both calls kept");
  assert.match(b.messages[1]!.calls![0]!.output, /cut from 200000 to 1500 characters.*assistant chunk 7/);
  assert.equal(c.messages[1]!.calls![0]!.output.length, 200_000, "the stored chunk is not changed");
});

test("too many calls: whole call pairs are replaced by a note; too large even then: one placeholder stands for the turn", () => {
  const many = Array.from({ length: 30 }, (_, i) => callOf("jobs_list", "x".repeat(900), "{}", i));
  const b = boundChunk(chunkOf(3, [user("q"), reply("a", many)]));
  assert.equal(b.form, "calls-omitted");
  assert.equal(b.messages[1]!.calls!.length, 0, "no call without its result: none are sent");
  assert.match(b.messages[1]!.text, /30 tool call\(s\) of this turn are omitted/);
  assert.ok(b.chars <= ASSISTANT_CHUNK_MAX_CHARS);
  // Huge arguments cannot be cut without breaking them, so they go with their call; texts are cut first.
  const args = Array.from({ length: 10 }, (_, i) => callOf("vault_write", "{}", JSON.stringify({ text: "y".repeat(5_000) }), i));
  const p = boundChunk(chunkOf(4, [user("z".repeat(20_000)), reply("w".repeat(20_000), args), user("z".repeat(20_000)), reply("w".repeat(20_000))]));
  assert.ok(p.chars <= ASSISTANT_CHUNK_MAX_CHARS, `${p.form} ${p.chars}`);
  assert.ok(["calls-omitted", "placeholder"].includes(p.form));
});

test("no input can defeat the bound: every plan fits the budget, keeps call pairs, and sends a contiguous newest run", () => {
  let rnd = 42;
  const r = (n: number) => (rnd = (rnd * 1103515245 + 12345) % 2 ** 31) % n;
  for (let trial = 0; trial < 40; trial++) {
    const chunks: ChunkLike[] = [];
    for (let seq = 1; seq <= 1 + r(25); seq++) {
      const calls = Array.from({ length: r(6) }, (_, i) => callOf(`tool${i}`, "o".repeat(r(3) === 0 ? 50_000 : r(3000)), r(5) === 0 ? JSON.stringify({ a: "b".repeat(r(9000)) }) : "{}", i));
      chunks.push(chunkOf(seq, [user("u".repeat(r(3) === 0 ? MAX_MESSAGE_CHARS : r(2000))), reply("a".repeat(r(4) === 0 ? MAX_MESSAGE_CHARS : r(3000)), calls, r(5) === 0 ? "error" : "done")]));
    }
    const current = [user("c".repeat(r(2) ? MAX_MESSAGE_CHARS : r(100)))];
    const plan = planContext(chunks, current);
    const total = plan.messages.reduce((n, m) => n + messageChars(m), 0);
    assert.ok(total <= ASSISTANT_CONTEXT_BUDGET_CHARS, `trial ${trial}: ${total} within ${ASSISTANT_CONTEXT_BUDGET_CHARS}`);
    assert.equal(plan.historyChars + plan.currentChars, total);
    const items = planItems(plan);
    assertPaired(items);
    assert.ok(itemChars(items) <= ASSISTANT_CONTEXT_BUDGET_CHARS);
    // Contiguous: the included chunks are the newest ones, with no gap; omitted ones are all older.
    const inc = plan.included.map((i) => i.seq);
    if (inc.length) assert.deepEqual(inc, Array.from({ length: inc.length }, (_, i) => chunks.length - inc.length + 1 + i));
    for (const o of plan.omitted) assert.ok(!inc.length || o < inc[0]!);
    assert.equal(inc.length + plan.omitted.length, chunks.length);
  }
});

test("the active window always fits beside the largest allowed new message", () => {
  assert.ok(ASSISTANT_ACTIVE_BUDGET_CHARS + MAX_MESSAGE_CHARS <= ASSISTANT_CONTEXT_BUDGET_CHARS);
  assert.ok(ASSISTANT_CHUNK_MAX_CHARS <= ASSISTANT_ACTIVE_BUDGET_CHARS);
});

test("reference material is cut to its cap and says so", () => {
  assert.equal(boundNotes(undefined), undefined);
  assert.equal(boundNotes("short"), "short");
  const long = Array.from({ length: 2000 }, (_, i) => `### note-${i}\nline`).join("\n");
  const out = boundNotes(long)!;
  assert.ok(out.length <= ASSISTANT_NOTES_MAX_CHARS);
  assert.match(out, /reference material cut from \d+ to about 12000 characters/);
});
