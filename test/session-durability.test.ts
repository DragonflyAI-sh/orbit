import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_OUTPUT_CHARS, MAX_ROUNDS } from "../src/agent.ts";
import { BOUNDED_OUTPUT_CHARS, boundChunk } from "../src/assistant-context.ts";
import { SESSION_TOOL_NAMES, TRANSCRIPT_NOTICE } from "../src/sessions.ts";
import { threadStore } from "../src/threads.ts";
import { CORRECTION_1, CORRECTION_2, durabilityConversation, FACTS, findCursor, TITLE, WINDOWS } from "./helpers/session-durability-fixture.ts";
import { call, rig, say, scripted, type Seen } from "./threads-fixture.ts";

// Durability and pagination acceptance for session_read (docs/adr/0001-session-registry.md), past the short Copper Finch check in
// test/session-cursor-contract.test.ts: a synthetic chat long enough for several real tool-output pages, with successive corrections
// beyond the first page, read through the real Assistant dispatch (POST /assistant/messages: prepare, policy, runChat, tool clipping,
// chunk storage). Isolated temporary state directories; a deterministic scripted model, never a provider.
//
// What this proves and what it does not: every assertion below is about the data the tools returned (pages, cursors, bounds,
// provenance, order). Which value is "current" is computed by the test from that data. The scripted model only follows cursors the
// way the tool descriptions say to; it does no reasoning, so none of this is evidence that a real model draws the right conclusion.

const conv = durabilityConversation();
type Out = { ok: boolean; error?: string; result?: any; raw: string };

// The tool results of the current turn a model step was given (those after the newest user message), in order.
const outputsOf = (seen: Seen): Out[] => {
  const at = (seen.input as any[]).findLastIndex((i) => i.role === "user");
  return (seen.input as any[]).slice(at + 1).filter((i) => i.type === "function_call_output").map((i) => ({ ...JSON.parse(i.output), raw: i.output }));
};
const lastUser = (seen: Seen) => [...(seen.input as any[])].reverse().find((i) => i.role === "user")?.content as string | undefined;
// Chat turns are always offered tools; an Assistant turn is offered the session tools (or none, in its round-capped last step).
const isAssistant = (seen: Seen) => seen.tools.includes("session_read") || seen.tools.length === 0;

// A rig whose scripted model answers chat turns with the fixture's acknowledgement and hands Assistant turns to `assistant`.
const setup = (assistant: (seen: Seen) => ReturnType<typeof say>) => {
  const d = mkdtempSync(join(tmpdir(), "orbit-durability-"));
  const model = scripted((seen) => (isAssistant(seen) ? assistant(seen) : say(conv.reply(lastUser(seen) ?? ""))));
  const x = rig({ dir: d, extra: () => ({ assistantDir: join(d, "assistant") }), model });
  const seed = async (users = conv.users) => {
    const t = await x.create(TITLE);
    for (const u of users) assert.equal((await x.send(t.id, u)).status, 200);
    return t.id as string;
  };
  return { d, x, model, seed };
};

// The stored messages of a thread, as session_read would return their text (line breaks normalized), in order.
const stored = (threads: ReturnType<typeof threadStore>, id: string) => {
  const t = threads.sessionTranscript(id)!;
  return Array.from({ length: t.readable }, (_, i) => t.at(i)!).map((m) => ({ id: m.id, role: m.role, text: m.text.replace(/\r\n?/g, "\n") }));
};

// Reassemble pages into whole messages: parts joined by id in character order, each part contiguous, no part repeated; messages in
// the order they were first seen (forward reading) or sorted by time.
const reassemble = (pages: Out[]) => {
  type Parts = { at: string; role: string; parts: { from: number; to: number; text: string }[] };
  const byId = new Map<string, Parts>();
  for (const p of pages.flatMap((o) => o.result.messages)) {
    assert.equal(p.type, "message");
    const e: Parts = byId.get(p.id) ?? { at: p.at, role: p.role, parts: [] };
    e.parts.push({ from: p.chars.from, to: p.chars.to, text: p.text });
    byId.set(p.id, e);
  }
  return [...byId.entries()]
    .sort(([, a], [, b]) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map(([id, e]) => {
      const ps = e.parts.sort((a, b) => a.from - b.from);
      ps.forEach((q, i) => assert.equal(q.from, i === 0 ? 0 : ps[i - 1]!.to, `parts of ${id} are contiguous, none repeated`));
      return { id, role: e.role, text: ps.map((q) => q.text).join("") };
    });
};

// The page (0-based) on which a text first appears.
const pageOf = (pages: Out[], needle: string) => pages.findIndex((o) => o.result.messages.some((m: any) => m.text.includes(needle)));

const assertBoundedPage = (o: Out) => {
  assert.equal(o.ok, true, o.error);
  assert.ok(o.raw.length <= MAX_OUTPUT_CHARS, `tool output ${o.raw.length} > ${MAX_OUTPUT_CHARS}`);
  assert.doesNotMatch(o.raw, /… \(truncated\)$/, "never clipped by the agent, so its cursor is whole");
  assert.ok(o.result.returned.chars <= o.result.bounds.maxChars);
  assert.ok(o.result.returned.messages <= o.result.bounds.limit);
  assert.equal(o.result.notice, TRANSCRIPT_NOTICE);
  assert.equal(o.result.coverage.wholeSession.startsWith("Not claimed"), true);
};

// ---- one turn, several real pages -----------------------------------------------------------------------------------------------

test("long chat through the Assistant: several bounded pages, corrections beyond page one, unchanged facts, no approval, one source", async () => {
  let chatId = "";
  const PAGE = { maxChars: 12000, limit: 30 };
  const s = setup((seen) => {
    const outs = outputsOf(seen);
    if (!outs.length) return { text: "", calls: [call("session_read", { id: `chat:${chatId}`, from: "start", ...PAGE }, "p0")] };
    const last = outs.at(-1)!;
    return last.ok && last.result.nextCursor ? { text: "", calls: [call("session_read", { id: `chat:${chatId}`, cursor: last.result.nextCursor, ...PAGE }, `p${outs.length}`)] } : say("Read to the end.");
  });
  chatId = await s.seed();
  const before = s.x.threads.sessionTranscript(chatId)!.rev;

  const r = await s.x.api("/assistant/messages", "POST", { text: "What are the current Slate Heron values?" });
  assert.equal(r.status, 200);
  const pages = outputsOf(s.model.seen.at(-1)!);

  // Several real pages, each bounded by the tool-output limit (not by the count or maxChars), each with a usable cursor but the last.
  assert.ok(pages.length >= 3 && pages.length <= 5, `${pages.length} pages`);
  for (const [i, o] of pages.entries()) {
    assertBoundedPage(o);
    const lastPage = i === pages.length - 1;
    assert.equal(o.result.nextCursor === null, lastPage);
    assert.equal(o.result.truncated, !lastPage);
    if (!lastPage) assert.equal(o.result.stoppedBy, "output-size");
    // Provenance: one source, the persisted chat store, the same revision on every page (nothing changed while reading).
    assert.equal(o.result.session.id, `chat:${chatId}`);
    assert.equal(o.result.session.title, TITLE);
    assert.deepEqual(o.result.session.source, { store: "chat-threads", ref: chatId, persisted: true });
    assert.deepEqual(o.result.revision.rev, pages[0]!.result.revision.rev);
    assert.equal(o.result.coverage.storedMessages, conv.users.length * 2);
  }
  assert.equal(pages[0]!.result.coverage.reachedStart, true);
  assert.equal(pages.at(-1)!.result.coverage.reachedEnd, true);

  // Complete, ordered retrieval: every stored message exactly once, whole, in conversation order, with its role.
  const got = reassemble(pages);
  assert.deepEqual(got, stored(s.x.threads, chatId));

  // The corrections sit beyond page one, on successive pages, after the original.
  const [p0, p1, p2] = [pageOf(pages, FACTS), pageOf(pages, CORRECTION_1), pageOf(pages, CORRECTION_2)];
  assert.equal(p0, 0);
  assert.ok(p1 >= 1 && p2 > p1, `facts on page ${p0}, corrections on pages ${p1} and ${p2}`);

  // Data assertions (computed here from what was retrieved, not by the scripted model): the last statement of the deploy window in
  // conversation order is the second correction; build tag and review channel are stated once and never given another value; no
  // approval of anything appears in the conversation.
  const userTexts = got.filter((m) => m.role === "user").map((m) => m.text);
  const windowStatements = userTexts.flatMap((t) => WINDOWS.filter((w) => t.includes(w)));
  assert.deepEqual(windowStatements, WINDOWS);
  assert.equal(windowStatements.at(-1), "Wednesday at 15:45 UTC");
  const all = got.map((m) => m.text).join("\n");
  assert.deepEqual([...all.matchAll(/SH-\d+/g)].map((m) => m[0]), ["SH-4471"]);
  assert.deepEqual([...all.matchAll(/review channel (?!stay)(\w+)/g)].map((m) => m[1]), ["amber"]);
  assert.doesNotMatch(all, /approv/i);

  // Reading changed nothing in the chat.
  assert.equal(s.x.threads.sessionTranscript(chatId)!.rev, before);

  // Ordinary Chat stayed isolated while the conversation was built: no session tools and no session-activity digest in any chat turn.
  const chatTurns = s.model.seen.filter((x) => !isAssistant(x));
  assert.equal(chatTurns.length, conv.users.length);
  for (const t of chatTurns) {
    for (const name of SESSION_TOOL_NAMES) assert.ok(!t.tools.includes(name));
    assert.doesNotMatch(t.notes ?? "", /session-activity/);
  }
});

// ---- across turns: the cursor must survive in the Assistant's own history -------------------------------------------------------

test("continuation across Assistant turns: a turn capped mid-read leaves a usable nextCursor in history, and the next turn reads to the end", async () => {
  let chatId = "";
  const s = setup((seen) => {
    const outs = outputsOf(seen);
    const u = lastUser(seen);
    if (u === "read the Slate Heron chat from the start") {
      // One message per page (limit 1); follow nextCursor until the turn's round cap stops it.
      if (!outs.length) return { text: "", calls: [call("session_read", { id: `chat:${chatId}`, from: "start", limit: 1 }, "a0")] };
      const last = outs.at(-1)!;
      return last.ok && last.result.nextCursor ? { text: "", calls: [call("session_read", { id: `chat:${chatId}`, cursor: last.result.nextCursor, limit: 1 }, `a${outs.length}`)] } : say("done");
    }
    if (u === "continue reading it") {
      // This turn's own pages first; with none yet, the newest cursor in the history before this turn's message.
      const thisTurn = outs;
      const at = (seen.input as any[]).findLastIndex((i) => i.role === "user");
      const cursor = thisTurn.length ? thisTurn.at(-1)!.result.nextCursor : findCursor((seen.input as any[]).slice(0, at));
      if (!cursor) return say(thisTurn.length ? "done" : "no cursor in history");
      return { text: "", calls: [call("session_read", { id: `chat:${chatId}`, cursor, limit: 4 }, `b${thisTurn.length}`)] };
    }
    return say("ok");
  });
  chatId = await s.seed();

  const r1 = await s.x.api("/assistant/messages", "POST", { text: "read the Slate Heron chat from the start" });
  assert.equal(r1.status, 200, JSON.stringify(r1.data.error));
  const first = outputsOf(s.model.seen.at(-1)!);
  // The turn is capped (MAX_ROUNDS) before the chat ends: the chat needs more one-message pages than one turn may read.
  assert.equal(first.length, MAX_ROUNDS);
  first.forEach(assertBoundedPage);
  assert.equal(typeof first.at(-1)!.result.nextCursor, "string");

  const r2 = await s.x.api("/assistant/messages", "POST", { text: "continue reading it" });
  assert.equal(r2.status, 200);
  const seen2 = s.model.seen.at(-1)!;
  // Reproduction condition: the first turn is in the second turn's context in shortened form. A turn of MAX_ROUNDS pages is too large
  // even with its outputs cut, so its calls are omitted; the omitted-calls note still carries the newest page cursor.
  const view = (await s.x.api("/assistant")).data.assistant;
  const turn2 = view.chunks.at(-1);
  const firstSeq = view.chunks.at(-2).seq;
  assert.equal(turn2.context.included.find((c: any) => c.seq === firstSeq)?.form, "calls-omitted");
  assert.ok(JSON.stringify(seen2.input).includes(`nextCursor: \\"${first.at(-1)!.result.nextCursor}\\"`), "the omitted-calls note keeps the newest cursor whole");
  const second = outputsOf(seen2);
  assert.ok(second.length >= 1, "the second turn found the cursor in its history and continued");
  second.forEach(assertBoundedPage);
  assert.equal(second.at(-1)!.result.nextCursor, null);
  assert.equal(second.at(-1)!.result.coverage.reachedEnd, true);

  // Both turns together: every message exactly once, in order; nothing skipped at the turn boundary.
  assert.deepEqual(reassemble([...first, ...second]), stored(s.x.threads, chatId));
  assert.ok(pageOf([...first, ...second], CORRECTION_2) >= 1);
});

// ---- concurrent change: stale cursors, explicit recovery, no silent mixing ------------------------------------------------------

test("concurrent change mid-read through the Assistant: stale cursor refused, one restart reads one consistent revision; appends arrive in order", async () => {
  let chatId = "";
  let replyId = "";
  const OLD = "Repeating the facts back for the record. ";
  const NEW = "Rewritten while being read. ";
  let phase: "edit" | "append" = "edit";
  let changed = 0;
  const s = setup((seen) => {
    const outs = outputsOf(seen);
    const id = `chat:${chatId}`;
    if (phase === "edit") {
      if (!outs.length) return { text: "", calls: [call("session_read", { id, from: "start", maxChars: 1000 }, "e0")] };
      const last = outs.at(-1)!;
      if (outs.length === 1) {
        // Between pages, the message being read part-way changes (a concurrent source change).
        s.x.threads.patchMessage(chatId, replyId, { text: NEW.repeat(90) });
        changed++;
        return { text: "", calls: [call("session_read", { id, cursor: last.result.nextCursor }, "e1")] };
      }
      // Following the error text: restart once from the first page (same id and from, no cursor), then page to the end.
      if (!last.ok) return outs.filter((o) => !o.ok).length > 1 ? say("gave up") : { text: "", calls: [call("session_read", { id, from: "start", maxChars: 12000, limit: 30 }, `e${outs.length}`)] };
      return last.result.nextCursor ? { text: "", calls: [call("session_read", { id, cursor: last.result.nextCursor, maxChars: 12000, limit: 30 }, `e${outs.length}`)] } : say("done");
    }
    // Append phase: forward read; a new message is appended between pages.
    if (!outs.length) return { text: "", calls: [call("session_read", { id, from: "start", maxChars: 12000, limit: 30 }, "f0")] };
    const last = outs.at(-1)!;
    if (outs.length === 1) {
      s.x.threads.appendUser(chatId, "Third correction: the deploy window is now Thursday at 08:00 UTC.");
      changed++;
    }
    return last.ok && last.result.nextCursor ? { text: "", calls: [call("session_read", { id, cursor: last.result.nextCursor, maxChars: 12000, limit: 30 }, `f${outs.length}`)] } : say("done");
  });
  const d = s;
  // A short chat (the facts and two log entries), so each read fits in one turn's rounds.
  chatId = await d.seed(conv.users.slice(0, 3));
  // Give the first reply a long text, so the first page (maxChars 1000) stops part-way through it.
  replyId = stored(d.x.threads, chatId)[1]!.id;
  d.x.threads.patchMessage(chatId, replyId, { text: OLD.repeat(60) });

  const r = await d.x.api("/assistant/messages", "POST", { text: "read it" });
  assert.equal(r.status, 200);
  const outs = outputsOf(d.model.seen.at(-1)!);
  assert.equal(changed, 1);
  assert.equal(outs[0]!.ok, true);
  assert.equal(outs[0]!.result.messages.at(-1).id, replyId);
  assert.equal(outs[0]!.result.messages.at(-1).complete, false);
  // The continuation is refused explicitly, with nothing returned, and says how to recover.
  assert.equal(outs[1]!.ok, false);
  assert.match(outs[1]!.error!, /^stale-cursor: /);
  assert.match(outs[1]!.error!, /read the first page again \(same id and from, no cursor\)/);
  assert.match(outs[1]!.error!, /do not combine them/);
  assert.equal(outs.filter((o) => !o.ok).length, 1);
  // The restart: every page from one revision (newer than the page before the change), the current text only, complete.
  const fresh = outs.slice(2);
  fresh.forEach(assertBoundedPage);
  assert.ok(fresh.every((o) => o.result.revision.rev === fresh[0]!.result.revision.rev));
  assert.ok(fresh[0]!.result.revision.rev > outs[0]!.result.revision.rev);
  assert.deepEqual(reassemble(fresh), stored(d.x.threads, chatId));
  const freshText = fresh.flatMap((o) => o.result.messages.map((m: any) => m.text)).join("");
  assert.doesNotMatch(freshText, /Repeating the facts back/);
  assert.match(freshText, /Rewritten while being read/);

  // Appends during a forward read: the new message arrives once, at the end, in order; the page that carries it shows a newer
  // revision than the first page, so a reader can see the source moved. Nothing earlier is repeated or skipped.
  phase = "append";
  const r2 = await d.x.api("/assistant/messages", "POST", { text: "read it again" });
  assert.equal(r2.status, 200);
  const app = outputsOf(d.model.seen.at(-1)!);
  assert.equal(changed, 2);
  app.forEach(assertBoundedPage);
  const got = reassemble(app);
  assert.deepEqual(got, stored(d.x.threads, chatId));
  assert.match(got.at(-1)!.text, /^Third correction/);
  assert.ok(app.at(-1)!.result.revision.rev > app[0]!.result.revision.rev);
});

// ---- a real process restart -----------------------------------------------------------------------------------------------------

const HELPER = join(import.meta.dirname, "helpers", "session-durability-server.ts");
const runProcess = (dir: string, mode: "seed" | "resume") => {
  const p = spawnSync(process.execPath, [HELPER, dir, mode], { encoding: "utf8", timeout: 60_000, env: { ...process.env, STATE_DIRECTORY: "" } });
  assert.equal(p.status, 0, `${mode} process failed: ${p.stderr}`);
  const line = p.stdout.trim().split("\n").at(-1)!;
  const r = JSON.parse(line) as { pid: number; status: number; chatId: string; persisted: boolean; outputs: { name: string; raw: string }[] };
  return { ...r, outs: r.outputs.map((o) => ({ name: o.name, ...JSON.parse(o.raw), raw: o.raw })) as (Out & { name: string })[] };
};

test("process restart: a separate ORBIT process stops after one page; a new process on the same state discovers the chat and reads the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-durability-proc-"));
  const one = runProcess(dir, "seed");
  assert.equal(one.status, 200);
  assert.equal(one.persisted, true);
  assert.deepEqual(one.outs.map((o) => o.name), ["sessions_list", "session_read"]);
  const found1 = one.outs[0]!.result.sessions.find((x: any) => x.title === TITLE);
  assert.equal(found1.id, `chat:${one.chatId}`);
  const page1 = one.outs[1]!;
  assertBoundedPage(page1);
  assert.equal(typeof page1.result.nextCursor, "string");

  // The first process has exited. A new one starts on the same directory.
  const two = runProcess(dir, "resume");
  assert.notEqual(two.pid, one.pid);
  assert.equal(two.status, 200);
  // Discovery after the restart: the same id, title and persisted source; the message count is the full stored count.
  const found2 = two.outs[0]!.result.sessions.find((x: any) => x.title === TITLE);
  assert.equal(found2.id, found1.id);
  assert.equal(found2.createdAt, found1.createdAt);
  assert.equal(found2.source.persisted, true);
  assert.equal(found2.messages.count, conv.users.length * 2);
  // Bounded readback from the cursor kept in the Assistant's own persisted history: continues where page 1 stopped, to the end.
  const rest = two.outs.slice(1);
  assert.ok(rest.length >= 1 && rest.every((o) => o.name === "session_read"));
  rest.forEach(assertBoundedPage);
  assert.equal(rest.at(-1)!.result.nextCursor, null);
  assert.equal(rest.at(-1)!.result.coverage.reachedEnd, true);
  assert.equal(rest[0]!.result.revision.rev, page1.result.revision.rev, "the persisted chat did not change across the restart");

  // Across both processes: every stored message exactly once, in order, equal to the files on disk (read by a third store).
  const threads = threadStore(join(dir, "threads"));
  assert.deepEqual(reassemble([page1, ...rest]), stored(threads, one.chatId));
  assert.ok(pageOf([page1, ...rest], CORRECTION_1) >= 1);
});

// ---- the bound itself (src/assistant-context.ts) ---------------------------------------------------------------------------------

test("a shortened session_read page keeps its nextCursor whole within the same per-output bound; other outputs are cut as before", () => {
  const cursor = "c".repeat(40) + "_-" + "Z9".repeat(20);
  const page = JSON.stringify({ ok: true, provenance: "live", result: { notice: "n", messages: [{ text: "x".repeat(6000) }], nextCursor: cursor } });
  const other = JSON.stringify({ ok: true, result: { text: "y".repeat(6000), nextCursor: cursor } });
  const edge = JSON.stringify({ ok: true, result: { messages: [{ text: "x".repeat(6000) }], nextCursor: null } });
  const msg = (name: string, output: string, i: number) => ({ id: `m${i}`, role: "assistant" as const, at: "2026-11-15T00:00:00.000Z", status: "done" as const, text: "t", calls: [{ id: `c${i}`, name, arguments: "{}", ok: true, output, state: "done" }] as any });
  const chunk = { seq: 7, id: "k", createdAt: "2026-11-15T00:00:00.000Z", messages: [msg("session_read", page, 0), msg("jobs_list", other, 1), msg("session_read", edge, 2)] };
  const b = boundChunk(chunk);
  assert.equal(b.form, "clipped");
  const [read, jobs, last] = b.messages.map((m) => m.calls![0]!.output);
  assert.ok(read!.length <= BOUNDED_OUTPUT_CHARS);
  assert.match(read!, /cut from \d+ to 1500 characters/);
  assert.equal(findCursor([{ type: "function_call", name: "session_read", call_id: "c" }, { type: "function_call_output", call_id: "c", output: read }]), cursor);
  // Not a paged session tool: cut exactly as before, the cursor-shaped value is not kept.
  assert.ok(jobs!.length <= BOUNDED_OUTPUT_CHARS);
  assert.ok(!jobs!.includes(cursor));
  // At the edge (nextCursor null) there is nothing to keep.
  assert.doesNotMatch(last!, /kept whole/);
});
