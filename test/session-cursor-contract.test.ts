import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_OUTPUT_CHARS, runChat } from "../src/agent.ts";
import { assistantStore } from "../src/assistant-store.ts";
import { FALLBACK_TOOLS } from "../src/fallback.ts";
import { type Item, type ModelPort, responsesTools, type Step } from "../src/model.ts";
import { assistantAdapter, BAD_READ_CURSOR, chatAdapter, type SessionAdapter, sessionRegistry, sessionTools, SESSION_TOOL_NAMES, TRANSCRIPT_NOTICE, UNAVAILABLE_RECOVERY } from "../src/sessions.ts";
import { threadStore } from "../src/threads.ts";
import { call, rig, say, scripted } from "./threads-fixture.ts";

// The session_read first-read / continuation / error contract (docs/adr/0001-session-registry.md, "First read, continuation and
// errors"), exercised through the model-facing tool definitions and the agent's real dispatch (runChat: JSON arguments parsed,
// strict keys, registry, output clipping) and the server's Assistant wiring. Offline and deterministic: a scripted model stands in
// for the provider, so these prove retrieval through the transport, not live-model recall.
//
// Fixture: a synthetic "Copper Finch" chat only (release code CF-7319, window Thursday 14:20 UTC, packaging violet, then a
// correction to Friday 16:40 UTC). It contains no budget, on purpose.

const ORIGINAL = "Memory test. Please remember: release code CF-7319, release window Thursday at 14:20 UTC, packaging violet.";
const CORRECTION = "Correction: the release window is now Friday at 16:40 UTC. Everything else stays the same.";
const ACK = "Noted.";

const ticking = (start = Date.parse("2026-11-14T10:00:00.000Z")) => {
  let t = start;
  return () => new Date((t += 1000));
};

const stores = (dir = mkdtempSync(join(tmpdir(), "orbit-cursor-"))) => {
  const now = ticking();
  const threads = threadStore(join(dir, "threads"), now);
  const assistant = assistantStore(join(dir, "assistant"), { now });
  const registry = sessionRegistry({ adapters: [assistantAdapter(assistant), chatAdapter(threads)], now });
  const tools = sessionTools(registry, { caller: "assistant:assistant", isOwner: true });
  return { dir, threads, assistant, registry, tools };
};

const exchange = (threads: ReturnType<typeof threadStore>, id: string, user: string, reply: string) => {
  threads.appendUser(id, user);
  const mid = threads.beginAssistant(id);
  threads.patchMessage(id, mid, { text: reply, status: "done" });
  return mid;
};

const copperFinch = (threads: ReturnType<typeof threadStore>) => {
  const t = threads.create("Memory test — Copper Finch");
  exchange(threads, t.id, ORIGINAL, ACK);
  exchange(threads, t.id, CORRECTION, ACK);
  return t.id;
};

// A model that makes the given tool calls, one per round, then answers. `next` sees the outputs so far, so a call can depend on
// the previous page (its nextCursor), exactly as a model would copy it. An output ORBIT cut to fit the reply's tool-result budget
// (src/tool-result-budget.ts) is incomplete: it is counted in `cut` and not used as a page, so the next reply asks for that page again.
type Out = { ok: boolean; error?: string; result?: any; raw: string };
const driver = (next: (outs: Out[]) => Record<string, unknown> | undefined) => {
  const outs: Out[] = [];
  const cut: string[] = [];
  let n = 0;
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/driver", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
    step: async (input: Item[]): Promise<Step> => {
      const last = input.at(-1) as any;
      if (last?.type === "function_call_output" && /to fit this reply's tool-result budget/.test(last.output)) cut.push(last.output);
      else if (last?.type === "function_call_output") {
        let parsed: any;
        try {
          parsed = JSON.parse(last.output);
        } catch {
          parsed = { ok: false, error: "UNPARSEABLE (clipped)" };
        }
        outs.push({ ...parsed, raw: last.output });
      }
      const args = next(outs);
      if (!args) return { text: "done", calls: [] };
      return { text: "", calls: [{ call_id: `c${n++}`, name: "session_read", arguments: JSON.stringify(args) }] };
    },
  };
  return { model, outs, cut };
};

// One reply, or, when the reply's tool-result budget stops it before `next` is done, further replies that continue from the last whole
// page ("continue"), as Rai would ask. `replies` counts them.
const turn = async (tools: ReturnType<typeof sessionTools>, next: (outs: Out[]) => Record<string, unknown> | undefined, maxRounds = 40) => {
  const d = driver(next);
  let r = await runChat({ model: d.model, messages: [{ role: "user", content: "read it" }], limits: [], tools, maxRounds });
  let replies = 1;
  while (r.resultBudget?.stopped && next(d.outs) !== undefined && replies < 20) {
    r = await runChat({ model: d.model, messages: [{ role: "user", content: "continue" }], limits: [], tools, maxRounds });
    replies += 1;
  }
  return { ...d, outcome: r, replies };
};

// ---- the model-facing schema and its transports ------------------------------------------------------------------------------

test("schema: session_read requires only id; cursor is an optional string whose description states the first-page contract", () => {
  const s = stores();
  const read = s.tools.find((t) => t.name === "session_read")!;
  const p = read.parameters as any;
  assert.deepEqual(p.required, ["id"]);
  assert.equal(p.additionalProperties, false);
  assert.equal(p.properties.cursor.type, "string");
  assert.match(p.properties.cursor.description, /Leave out for the first page/);
  assert.match(p.properties.cursor.description, /null or an empty string also mean the first page/);
  assert.match(p.properties.cursor.description, /exactly as the previous page/);
  assert.match(read.description, /First page: leave cursor out/);
  assert.match(read.description, /never repeat a call that failed the same way/);
  const list = s.tools.find((t) => t.name === "sessions_list")!;
  assert.match((list.parameters as any).properties.cursor.description, /Leave out for the first page/);
});

test("transport: the primary (Responses API) tool definitions carry the schema unchanged; the paid fallback is never offered the session tools", () => {
  const s = stores();
  const defs = s.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const sent = responsesTools(defs);
  for (const [i, d] of defs.entries()) {
    assert.deepEqual(sent[i], { type: "function", ...d });
    // ORBIT sends no `strict` flag and no schema rewrite: optional properties stay optional.
    assert.equal("strict" in sent[i]!, false);
  }
  // OpenRouter (fallback) only ever sees FALLBACK_TOOLS, which excludes every session tool, so no schema translation applies there.
  for (const name of SESSION_TOOL_NAMES) assert.equal(FALLBACK_TOOLS.has(name), false);
});

// ---- first read: omitted, null, empty ------------------------------------------------------------------------------------------

test("first read: cursor omitted, null or \"\" (and null for every optional argument) all return the same first page through dispatch", async () => {
  const s = stores();
  const id = `chat:${copperFinch(s.threads)}`;
  const variants: Record<string, unknown>[] = [{ id }, { id, cursor: null }, { id, cursor: "" }, { id, from: null, limit: null, maxChars: null, cursor: null }, { id, from: "start", cursor: "" }];
  const { outs } = await turn(s.tools, (o) => variants[o.length]);
  assert.equal(outs.length, variants.length);
  for (const o of outs) {
    assert.equal(o.ok, true, o.error);
    assert.deepEqual(
      o.result.messages.map((m: any) => [m.role, m.text]),
      [
        ["user", ORIGINAL],
        ["assistant", ACK],
        ["user", CORRECTION],
        ["assistant", ACK],
      ],
    );
    assert.equal(o.result.coverage.reachedStart, true);
    assert.equal(o.result.coverage.reachedEnd, true);
    assert.equal(o.result.nextCursor, null);
  }
});

test("Copper Finch through the server: the Assistant retrieves original then correction with provenance; nothing about a budget; Chat stays isolated", async () => {
  const d = mkdtempSync(join(tmpdir(), "orbit-cursor-srv-"));
  let chatId = "";
  const model = scripted((seen) => {
    const last = seen.input.at(-1) as any;
    if (last?.content === "what are the current Copper Finch values?") return { text: "", calls: [call("session_read", { id: `chat:${chatId}`, from: "start", cursor: null, limit: 2 }, "r1")] };
    if (last?.type === "function_call_output" && last.call_id === "r1") return { text: "", calls: [call("session_read", { id: `chat:${chatId}`, cursor: JSON.parse(last.output).result.nextCursor }, "r2")] };
    if (last?.content === "chat: read Copper Finch") return { text: "", calls: [call("session_read", { id: `chat:${chatId}`, cursor: "" }, "x1")] };
    return say(ACK);
  });
  const x = rig({ dir: d, extra: () => ({ assistantDir: join(d, "assistant") }), model });
  const t = await x.create("Memory test — Copper Finch");
  chatId = t.id;
  await x.send(t.id, ORIGINAL);
  await x.send(t.id, CORRECTION);

  const r = await x.api("/assistant/messages", "POST", { text: "what are the current Copper Finch values?" });
  assert.equal(r.status, 200);
  const outs = (model.seen.at(-1)!.input as any[]).filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output));
  assert.equal(outs.length, 2);
  for (const o of outs) {
    assert.equal(o.ok, true, o.error);
    assert.equal(o.result.notice, TRANSCRIPT_NOTICE);
    assert.equal(o.result.session.id, `chat:${chatId}`);
    assert.equal(o.result.session.source.store, "chat-threads");
    assert.equal(o.result.session.source.persisted, true);
  }
  const msgs = outs.flatMap((o) => o.result.messages);
  assert.deepEqual(
    msgs.map((m: any) => m.text),
    [ORIGINAL, ACK, CORRECTION, ACK],
  );
  // Order and completeness evidence: times ascend, every message complete, both edges reached across the two pages.
  assert.ok(msgs.every((m: any, i: number) => m.complete && (i === 0 || m.at >= msgs[i - 1].at)));
  assert.equal(outs[0].result.coverage.reachedStart, true);
  assert.equal(outs[1].result.coverage.reachedEnd, true);
  assert.equal(outs[1].result.nextCursor, null);
  // The correction (Friday 16:40) comes after the original (Thursday 14:20), so the original is superseded; the other values stand.
  const all = msgs.map((m: any) => m.text).join("\n");
  assert.ok(all.indexOf("Thursday at 14:20 UTC") < all.indexOf("Friday at 16:40 UTC"));
  assert.match(all, /CF-7319/);
  assert.match(all, /violet/);
  // No budget in the fixture, and none appears in what was retrieved.
  assert.doesNotMatch(all, /budget/i);

  // An ordinary Chat is not offered the session tools, and a call to one is refused without reading anything.
  const other = await x.create("Ordinary chat");
  const cr = await x.send(other.id, "chat: read Copper Finch");
  for (const name of SESSION_TOOL_NAMES) assert.ok(!model.seen.at(-2)!.tools.includes(name));
  const chatCall = cr.data.thread.messages.at(-1).calls[0];
  assert.equal(chatCall.name, "session_read");
  assert.equal(chatCall.ok, false);
  assert.doesNotMatch(JSON.stringify(cr.data), /CF-7319|violet/);
});

// ---- continuation ----------------------------------------------------------------------------------------------------------------

test("continuation: returned cursors are used verbatim through dispatch, one message per page, both directions, nothing skipped or repeated", async () => {
  const s = stores();
  const id = `chat:${copperFinch(s.threads)}`;
  for (const from of ["start", "end"] as const) {
    // Page sizes are per call (not carried in the cursor), so each call passes limit 1.
    const { outs } = await turn(s.tools, (o) => (o.length === 0 ? { id, from, limit: 1 } : o.at(-1)!.ok && o.at(-1)!.result.nextCursor ? { id, cursor: o.at(-1)!.result.nextCursor, limit: 1 } : undefined));
    assert.ok(outs.every((o) => o.ok));
    assert.equal(outs.length, 4);
    const texts = outs.map((o) => o.result.messages[0].text);
    assert.deepEqual(from === "start" ? texts : texts.reverse(), [ORIGINAL, ACK, CORRECTION, ACK]);
    assert.ok(outs.slice(0, -1).every((o) => o.result.truncated === true && typeof o.result.nextCursor === "string"));
  }
});

test("output size: every page fits the tool-output limit, so it is never clipped and its cursor is whole; following it reconstructs every message", async () => {
  const s = stores();
  const t = s.threads.create("Long");
  const texts: string[] = [];
  for (let i = 0; i < 12; i++) {
    const u = `question ${i} ` + 'filler "quoted" line\n'.repeat(80 + i * 7);
    const a = `answer ${i} ` + "é\\x ".repeat(500 + i * 40);
    exchange(s.threads, t.id, u, a);
    texts.push(u, a);
  }
  const id = `chat:${t.id}`;
  for (const first of [{ id, from: "start" }, { id, from: "start", maxChars: 12000, limit: 30 }, { id, maxChars: 12000, limit: 30 }, { id }]) {
    const { outs, replies, outcome } = await turn(s.tools, (o) => (o.length === 0 ? first : o.at(-1)!.ok && o.at(-1)!.result.nextCursor ? { id, cursor: o.at(-1)!.result.nextCursor } : undefined), 200);
    // Each reply's tool results stay within the budget; a read longer than one budget continues in the next reply from the last whole
    // page, and nothing is lost or repeated (checked below by reassembling every message).
    assert.ok(!outcome.resultBudget || outcome.resultBudget.usedBytes <= outcome.resultBudget.maxBytes);
    if (!first.maxChars) assert.ok(replies >= 2, `the long read needed more than one reply (${replies})`);
    for (const o of outs) {
      assert.ok(o.raw.length <= MAX_OUTPUT_CHARS, `output ${o.raw.length} > ${MAX_OUTPUT_CHARS}`);
      assert.doesNotMatch(o.raw, /… \(truncated\)$/);
      assert.equal(o.ok, true, o.error);
    }
    if (first.maxChars) assert.ok(outs.some((o) => o.result.stoppedBy === "output-size"), "the output budget, not maxChars, bounded a page");
    // Reassemble the parts by message id, in character order: every message once, whole, in conversation order.
    type Entry = { at: string; parts: { from: number; to: number; text: string }[] };
    const byId = new Map<string, Entry>();
    for (const p of outs.flatMap((o) => o.result.messages)) {
      const e: Entry = byId.get(p.id) ?? { at: p.at, parts: [] };
      e.parts.push({ from: p.chars.from, to: p.chars.to, text: p.text });
      byId.set(p.id, e);
    }
    const joined = [...byId.values()]
      .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))
      .map((e) => {
        const ps = e.parts.sort((x, y) => x.from - y.from);
        ps.forEach((q, i) => assert.equal(q.from, i === 0 ? 0 : ps[i - 1]!.to, "parts are contiguous, none repeated"));
        return ps.map((q) => q.text).join("");
      });
    assert.equal(joined.length, texts.length);
    for (const [i, tx] of texts.entries()) assert.equal(joined[i], tx.replace(/\r\n?/g, "\n"), `message ${i}`);
  }
});

// ---- invalid input, foreign cursors, staleness, unavailability ---------------------------------------------------------------

test("invalid cursors stay refused (malformed, shortened, altered, other session, other direction, non-string) with actionable text that names no session", async () => {
  const s = stores();
  const a = copperFinch(s.threads);
  const b = s.threads.create("Other");
  exchange(s.threads, b.id, "unrelated", "ok");
  const id = `chat:${a}`;
  const first = await s.tools.find((t) => t.name === "session_read")!.run({ id, from: "start", limit: 1 });
  const cur = (first.value as any).nextCursor as string;
  const outer = JSON.parse(Buffer.from(cur, "base64url").toString("utf8"));
  const altered = Buffer.from(JSON.stringify({ ...outer, b: outer.b.replace('"i":1', '"i":0') })).toString("base64url");
  const cases: Record<string, unknown>[] = [
    { id, cursor: "x" },
    { id, cursor: " " },
    { id, cursor: cur.slice(0, -6) },
    { id, cursor: altered },
    { id: `chat:${b.id}`, cursor: cur },
    { id: "assistant:assistant", cursor: cur },
    { id, cursor: 42 },
    { id, cursor: { v: 1 } },
    { id, cursor: cur, from: "end" },
  ];
  const { outs } = await turn(s.tools, (o) => cases[o.length]);
  assert.equal(outs.length, cases.length);
  for (const o of outs) {
    assert.equal(o.ok, false);
    assert.match(o.error!, /^invalid-cursor: /);
    assert.doesNotMatch(o.error!, new RegExp(`${a}|${b.id}`));
    assert.doesNotMatch(o.error!, /CF-7319|violet/);
  }
  assert.equal(outs[0]!.error, BAD_READ_CURSOR);
  assert.match(BAD_READ_CURSOR, /exactly as the previous page returned it/);
  assert.match(BAD_READ_CURSOR, /leave cursor out/);
  assert.match(outs.at(-1)!.error!, /leave from out/);
  // The genuine cursor still works after all of that.
  const ok = await s.tools.find((t) => t.name === "session_read")!.run({ id, cursor: cur });
  assert.equal((ok.value as any).messages[0].text, ACK);
});

test("a non-owner is refused before any cursor or id is looked at, whatever the cursor", async () => {
  const s = stores();
  const id = `chat:${copperFinch(s.threads)}`;
  const owner = sessionTools(s.registry, { caller: "assistant:assistant", isOwner: true }).find((t) => t.name === "session_read")!;
  const cur = ((await owner.run({ id, from: "start", limit: 1 })).value as any).nextCursor;
  const stranger = sessionTools(s.registry, { caller: "assistant:assistant", isOwner: false });
  for (const cursor of [undefined, null, "", cur, "junk"]) {
    const { outs } = await turn(stranger, (o) => (o.length ? undefined : { id, ...(cursor === undefined ? {} : { cursor }) }));
    assert.equal(outs[0]!.ok, false);
    assert.match(outs[0]!.error!, /only the owner/);
  }
});

test("mutation between pages: a stale cursor fails explicitly with a bounded restart instruction; one restart from the first page succeeds", async () => {
  const s = stores();
  const t = s.threads.create("Memory test — Copper Finch");
  const mid = exchange(s.threads, t.id, ORIGINAL, `${ACK} ${"Repeating it back for the record. ".repeat(60)}`);
  exchange(s.threads, t.id, CORRECTION, ACK);
  const id = `chat:${t.id}`;
  let edited = false;
  const { outs } = await turn(s.tools, (o) => {
    if (o.length === 0) return { id, from: "start", maxChars: 500 };
    const last = o.at(-1)!;
    if (o.length === 1) {
      // The reply being read part-way changes before the next page (as a hand edit would).
      s.threads.patchMessage(t.id, mid, { text: `${ACK} (rewritten) ${"Different text now. ".repeat(80)}` });
      edited = true;
      return { id, cursor: last.result.nextCursor };
    }
    // A model following the instruction: restart once from the first page, then page to the end.
    if (!last.ok) return o.filter((x) => !x.ok).length > 1 ? undefined : { id, from: "start" };
    return last.result.nextCursor ? { id, cursor: last.result.nextCursor } : undefined;
  });
  assert.ok(edited);
  assert.equal(outs[0]!.ok, true);
  assert.equal(outs[0]!.result.messages.at(-1).complete, false);
  assert.equal(outs[1]!.ok, false);
  assert.match(outs[1]!.error!, /^stale-cursor: /);
  assert.match(outs[1]!.error!, /read the first page again \(same id and from, no cursor\)/);
  assert.match(outs[1]!.error!, /at most once/);
  assert.match(outs[1]!.error!, /do not combine them/);
  // Exactly one failure; the restart reads the current state from the first message.
  assert.equal(outs.filter((o) => !o.ok).length, 1);
  const after = outs.slice(2).flatMap((o) => o.result.messages);
  assert.equal(after[0].text, ORIGINAL);
  assert.match(after.map((m: any) => m.text).join(""), /\(rewritten\)/);
  assert.equal(after.at(-1).text, ACK);
});

test("an agent turn is capped: a model that keeps repeating a failing call stops at maxRounds", async () => {
  const s = stores();
  const id = `chat:${copperFinch(s.threads)}`;
  const { outs, outcome } = await turn(s.tools, () => ({ id, cursor: "repeat-me" }), 5);
  assert.ok(outs.length <= 5);
  assert.ok(outs.every((o) => !o.ok && o.error === BAD_READ_CURSOR));
  assert.ok(outcome);
});

test("unavailable and deleted sources: explicit answers with recovery guidance, nothing fabricated", async () => {
  const s = stores();
  const id = copperFinch(s.threads);
  const broken: SessionAdapter = { ...chatAdapter(s.threads), transcript: () => { throw new Error("disk gone"); } };
  const reg = sessionRegistry({ adapters: [broken] });
  const tools = sessionTools(reg, { caller: "assistant:assistant", isOwner: true });
  const { outs } = await turn(tools, (o) => (o.length ? undefined : { id: `chat:${id}`, cursor: null }));
  assert.equal(outs[0]!.ok, true);
  assert.equal(outs[0]!.result.available, false);
  assert.equal(outs[0]!.result.recovery, UNAVAILABLE_RECOVERY);
  assert.equal(outs[0]!.result.messages, undefined);
  // A chat whose file was removed (then a restart) is not found, the same answer as an id that never existed.
  const dir = s.dir;
  writeFileSync(join(dir, "threads", `${id}.json`), "");
  const s2 = stores(dir);
  const gone = await turn(s2.tools, (o) => (o.length ? undefined : { id: `chat:${id}`, cursor: "" }));
  assert.equal(gone.outs[0]!.ok, false);
  assert.equal(gone.outs[0]!.error, "No visible session with that id.");
});

test("restart: a persisted Copper Finch chat reads back after a restart, and a cursor from before it continues", async () => {
  const s = stores();
  const id = `chat:${copperFinch(s.threads)}`;
  const before = await turn(s.tools, (o) => (o.length ? undefined : { id, from: "start", limit: 2 }));
  const cur = before.outs[0]!.result.nextCursor as string;
  // The file on disk holds the synthetic messages (and no budget).
  const file = readFileSync(join(s.dir, "threads", `${id.slice(5)}.json`), "utf8");
  assert.match(file, /CF-7319/);
  assert.doesNotMatch(file, /budget/i);
  const s2 = stores(s.dir);
  const after = await turn(s2.tools, (o) => (o.length ? undefined : { id, cursor: cur }));
  assert.equal(after.outs[0]!.ok, true);
  assert.deepEqual(
    after.outs[0]!.result.messages.map((m: any) => m.text),
    [CORRECTION, ACK],
  );
  assert.equal(after.outs[0]!.result.coverage.reachedEnd, true);
});

test("sessions_list: cursor null or \"\" is the first page; a malformed one is still refused", async () => {
  const s = stores();
  copperFinch(s.threads);
  const list = s.tools.find((t) => t.name === "sessions_list")!;
  const base = ((await list.run({})).value as any).sessions.map((x: any) => x.id);
  for (const cursor of [null, ""]) assert.deepEqual(((await list.run({ cursor })).value as any).sessions.map((x: any) => x.id), base);
  await assert.rejects(list.run({ cursor: "!!!" }), /cursor is not valid/);
  await assert.rejects(list.run({ cursor: 7 }), /cursor must be a string/);
});
