import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_ROUNDS, REPEAT_FAILURES_MAX, REPEAT_RECOVERIES_MAX, runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { boundChunk, type ChunkLike, pageStreams, planContext, planItems } from "../src/assistant-context.ts";
import type { Item, ModelPort, Step, ToolCall } from "../src/model.ts";
import type { StoredCall, ThreadMessage } from "../src/threads.ts";
import { durabilityConversation, TITLE } from "./helpers/session-durability-fixture.ts";
import { call, rig, say, scripted, type Seen } from "./threads-fixture.ts";

// Two follow-ups to #120 (no-progress guard) and #124 (bounded Assistant history), checked against main before changing anything:
// (1) a call the guard blocked stayed blocked for the rest of the reply even after another call satisfied its prerequisite; it now
// gets a bounded number of retries after real progress. (2) The calls-omitted note kept one cursor per tool name, newest first,
// skipping pages without a cursor: a completed read's older cursor was offered again, and a second session or list query lost its
// cursor. It now keeps one paging state per read (session id and direction, or list query), with explicit completion.
// Deterministic and offline: scripted models and stub tools; nothing reaches a provider.

const user: Item[] = [{ role: "user", content: "go" }];

// A scripted model that plays `plan` (one entry per step, each a list of parallel calls), then answers.
function planned(plan: ToolCall[][], answer = "done") {
  const seen: { tools: string[]; input: Item[] }[] = [];
  let n = 0;
  const port: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/plan", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (input, _l, _n, tools): Promise<Step> => {
      seen.push({ tools: tools.map((t) => t.name), input: [...input] });
      return tools.length && n < plan.length ? { text: "", calls: plan[n++]! } : say(answer);
    },
  };
  return { port, seen };
}

// A deploy check that fails until `prepare` has run, and the prerequisite itself.
function prerequisite() {
  const state = { ready: false, checks: 0, prepares: 0 };
  const check: ChatTool = {
    name: "deploy_check",
    readOnly: true,
    description: "Check the deploy.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      state.checks++;
      if (!state.ready) throw new Error("Not ready: the workspace is not prepared.");
      return { value: { deployed: true }, provenance: "live", source: "test/deploy" };
    },
  };
  const prepare: ChatTool = {
    name: "workspace_prepare",
    readOnly: true,
    description: "Prepare the workspace.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      state.prepares++;
      state.ready = true;
      return { value: { prepared: true }, provenance: "live", source: "test/prepare" };
    },
  };
  return { state, check, prepare };
}
// A tool that always fails the same way, and one that always succeeds (`same`: with an identical result every time).
const failing = (runs: { n: number }): ChatTool => ({ name: "always_fails", readOnly: true, description: "d", parameters: { type: "object", properties: {} }, run: async () => (runs.n++, Promise.reject(new Error("Permanently broken."))) });
const succeeding = (runs: { n: number }, same = false): ChatTool => ({
  name: "other_read",
  readOnly: true,
  description: "d",
  parameters: { type: "object", properties: {} },
  run: async (a) => (runs.n++, { value: same ? { status: "unchanged" } : { page: a.page ?? null, n: runs.n }, provenance: "live", source: "test/other" }),
});

// ---- (1) the no-progress guard: bounded recovery after progress ------------------------------------------------------------

test("prerequisite recovery: A fails twice, B satisfies A's prerequisite, and the identical A then runs and succeeds", async () => {
  const p = prerequisite();
  const m = planned([[call("deploy_check", {}, "a1")], [call("deploy_check", {}, "a2")], [call("workspace_prepare", {}, "b1")], [call("deploy_check", {}, "a3")]], "Deployed.");
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [p.check, p.prepare] });
  assert.equal(p.state.checks, 3, "the third identical check ran: the prepare in between was progress");
  assert.deepEqual(out.calls.map((c) => c.ok), [false, false, true, true]);
  assert.equal(out.stalled, undefined);
  assert.equal(out.text, "Deployed.");
});

test("prerequisite recovery through the Assistant: the stored turn shows the third check ran and succeeded", async () => {
  const p = prerequisite();
  const plan = [[call("deploy_check", {}, "a1")], [call("deploy_check", {}, "a2")], [call("workspace_prepare", {}, "b1")], [call("deploy_check", {}, "a3")]];
  let n = 0;
  const model = scripted((seen) => (seen.tools.includes("deploy_check") && n < plan.length ? { text: "", calls: plan[n++]! } : say("Deployed after preparing.")));
  const r = rig({ model, extra: () => ({ prInspect: [p.check, p.prepare] }) });
  try {
    const res = await r.api("/assistant/messages", "POST", { text: "check the deploy" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const reply = res.data.assistant.chunks.at(-1).messages.at(-1);
    assert.equal(reply.text, "Deployed after preparing.");
    assert.deepEqual(reply.calls.map((c: { name: string; ok: boolean }) => [c.name, c.ok]), [["deploy_check", false], ["deploy_check", false], ["workspace_prepare", true], ["deploy_check", true]]);
    assert.equal(p.state.checks, 3);
    assert.equal(reply.stalled, undefined);
  } finally {
    r.close();
  }
});

test("repeated identical failures without progress are still stopped after REPEAT_FAILURES_MAX runs, and the tools are withdrawn", async () => {
  const runs = { n: 0 };
  const m = planned(Array.from({ length: 10 }, (_, i) => [call("always_fails", {}, `f${i}`)]));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [failing(runs)] });
  assert.equal(runs.n, REPEAT_FAILURES_MAX);
  assert.equal(out.stalled, true);
  assert.match(out.calls.at(-1)!.summary, /no other call has succeeded with a new result since/);
  assert.deepEqual(m.seen.at(-1)!.tools, []);
});

test("an identical no-op success is not progress: it reopens a blocked call once (its first result is new), never again", async () => {
  const fails = { n: 0 };
  const noop = { n: 0 };
  const plan = [[call("always_fails", {}, "f1")], [call("always_fails", {}, "f2")], [call("other_read", {}, "o1")], [call("always_fails", {}, "f3")], [call("other_read", {}, "o2")], [call("always_fails", {}, "f4")], [call("other_read", {}, "o3")], [call("always_fails", {}, "f5")]];
  const m = planned(plan);
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [failing(fails), succeeding(noop, true)] });
  assert.equal(noop.n, 2, "the second no-op ran; the next round was only a blocked repeat, so the reply stopped");
  assert.equal(fails.n, REPEAT_FAILURES_MAX + 1, "only the first (new) result counted as progress; the identical repeats did not");
  assert.equal(out.stalled, true, "the last round was nothing but a blocked repeat");
});

test("bounded retries despite irrelevant successes: new successes every round reopen a failing call at most REPEAT_RECOVERIES_MAX times", async () => {
  const fails = { n: 0 };
  const other = { n: 0 };
  // Every round: the failing call and a successful read with a new page (a new result each time), for the whole round budget.
  const m = planned(Array.from({ length: MAX_ROUNDS + 5 }, (_, i) => [call("always_fails", {}, `f${i}`), call("other_read", { page: i }, `o${i}`)]));
  const out = await runChat({ model: m.port, messages: user, limits: [], tools: [failing(fails), succeeding(other)] });
  assert.equal(fails.n, REPEAT_FAILURES_MAX + REPEAT_RECOVERIES_MAX, "bounded per call per reply, however many other calls succeed");
  assert.equal(other.n, MAX_ROUNDS, "the per-reply round ceiling is unchanged");
  assert.equal(out.capped, true);
  assert.equal(out.rounds, MAX_ROUNDS);
  const refusals = out.calls.filter((c) => c.name === "always_fails" && /did not run/.test(c.summary));
  assert.ok(refusals.length > 0);
  assert.match(refusals.at(-1)!.summary, new RegExp(`including ${REPEAT_RECOVERIES_MAX} retries after other calls made progress, which is the most one reply allows`));
});

test("a recovery retry that fails identically is blocked again at once, until there is further progress", async () => {
  const fails = { n: 0 };
  const other = { n: 0 };
  const plan = [
    [call("always_fails", {}, "f1")],
    [call("always_fails", {}, "f2")],
    [call("other_read", { page: 1 }, "o1")],
    [call("always_fails", {}, "f3")], // recovery 1: runs, fails identically
    [call("always_fails", {}, "f4")], // no progress since: blocked, so the tools are withdrawn
  ];
  const out = await runChat({ model: planned(plan).port, messages: user, limits: [], tools: [failing(fails), succeeding(other)] });
  assert.equal(fails.n, REPEAT_FAILURES_MAX + 1);
  assert.equal(out.stalled, true);
  assert.match(out.calls.at(-1)!.summary, /at most 1 more time in this reply/);
});

// ---- (2) paging state in the Assistant's bounded history ---------------------------------------------------------------------

type Call = StoredCall;
const page = (cursor: string | null, filler = 1_400) => JSON.stringify({ ok: true, provenance: "live", source: "test/sessions", result: { messages: ["x".repeat(filler)], nextCursor: cursor } });
let callSeq = 0;
const read = (args: Record<string, unknown>, output: string, name = "session_read"): Call => ({ callId: `k${callSeq++}`, name, arguments: JSON.stringify(args), output, ok: !/"ok":false/.test(output), summary: "s", at: "2026-11-18T04:00:01.000Z" });
const turn = (seq: number, calls: Call[], text = "y".repeat(3_000)): ChunkLike => ({
  seq,
  id: `chunk${seq}`,
  createdAt: "2026-11-18T04:00:00.000Z",
  messages: [
    { id: `u${seq}`, role: "user", at: "2026-11-18T04:00:00.000Z", status: "done", text: "read them" } as ThreadMessage,
    { id: `a${seq}`, role: "assistant", at: "2026-11-18T04:00:01.000Z", status: "done", text, calls } as ThreadMessage,
  ],
});
// Opaque cursors, as long and varied as real ones (base64url).
const cur = (tag: string) => Buffer.from(JSON.stringify({ b: `${tag}-${"q".repeat(40)}`, h: tag })).toString("base64url");

test("pagination completed: nextCursor null supersedes the read's older cursor in the omitted-calls note; it is never resurrected", async () => {
  const [b1, b2] = [cur("B1"), cur("B2")];
  const calls = [read({ id: "chat:B", from: "start" }, page(b1)), read({ id: "chat:B", cursor: b1 }, page(b2)), read({ id: "chat:B", cursor: b2 }, page(null))];
  const b = boundChunk(turn(3, [...calls, ...calls.map((c) => ({ ...c, callId: `${c.callId}x`, arguments: JSON.stringify({ id: "chat:Z", from: "start" }), output: page(null) }))]));
  assert.equal(b.form, "calls-omitted");
  const note = b.messages[1]!.text;
  assert.ok(!note.includes(b1) && !note.includes(b2), "no older cursor of a completed read is offered");
  assert.match(note, /session_read \(id chat:B, from start\) complete: nextCursor null/);
});

test("missing cursor information is not completion: a failed or unreadable later page leaves the read's last cursor in place", () => {
  const a1 = cur("A1");
  const failed = JSON.stringify({ ok: false, error: "stale-cursor: the session changed" });
  const s = pageStreams([read({ id: "chat:A" }, page(a1)), read({ id: "chat:A", cursor: a1 }, failed), read({ id: "chat:A", cursor: a1 }, "not json")]);
  assert.deepEqual(s, [{ tool: "session_read", identity: "id chat:A", state: { cursor: a1 } }]);
  // A page whose result has no nextCursor field at all is missing information too, not completion.
  assert.deepEqual(pageStreams([read({ id: "chat:A" }, JSON.stringify({ ok: true, result: { messages: [] } }))]), []);
});

test("interleaved session ids and list queries keep separate cursors, each copied byte-for-byte with what it belongs to", () => {
  const [a1, a2, b1, l1, l2, w1] = ["A1", "A2", "B1", "L1", "L2", "W1"].map(cur);
  const calls = [
    read({ id: "chat:A", from: "start" }, page(a1)),
    read({ id: "chat:B" }, page(b1)),
    read({ kinds: ["chat"], limit: 1 }, page(l1), "sessions_list"),
    read({ id: "chat:A", cursor: a1 }, page(a2)),
    read({ order: "created", kinds: ["work"] }, page(w1), "sessions_list"),
    read({ limit: 2, kinds: ["chat"], cursor: l1 }, page(l2), "sessions_list"),
  ];
  const streams = pageStreams(calls);
  assert.deepEqual(
    streams.map((x) => [x.tool, x.identity, "cursor" in x.state ? x.state.cursor : null]),
    [
      ["session_read", "id chat:B", b1],
      ["session_read", "id chat:A, from start", a2],
      ["sessions_list", 'query {"kinds":["work"],"order":"created"}', w1],
      ["sessions_list", 'query {"kinds":["chat"]}', l2],
    ],
  );
  const b = boundChunk(turn(4, [...calls, ...calls.map((c) => ({ ...c, callId: `${c.callId}x`, name: "jobs_list" }))]));
  assert.equal(b.form, "calls-omitted");
  for (const c of [a2, b1, w1, l2]) assert.ok(b.messages[1]!.text.includes(`nextCursor: "${c}"`), `cursor ${c.slice(0, 12)}… kept whole`);
  for (const c of [a1, l1]) assert.ok(!b.messages[1]!.text.includes(c), "a superseded cursor is not offered");
});

test("the same session read in both directions, and a continuation of an earlier turn's cursor, stay separate streams", () => {
  const [s1, e1, old, next] = ["S1", "E1", "OLD", "NEXT"].map(cur);
  const streams = pageStreams([read({ id: "chat:A", from: "start" }, page(s1)), read({ id: "chat:A" }, page(e1)), read({ id: "chat:A", cursor: old }, page(next)), read({ id: "chat:A", cursor: s1 }, page(null))]);
  assert.deepEqual(
    streams.map((x) => [x.identity, "cursor" in x.state ? x.state.cursor : "complete"]),
    [
      ["id chat:A", e1],
      ["id chat:A", next],
      ["id chat:A, from start", "complete"],
    ],
  );
});

test("clipped history: a cut last page still says the read is complete, and a cut middle page keeps its cursor whole", () => {
  const c1 = cur("C1");
  const calls = [read({ id: "chat:C" }, page(c1, 3_000)), read({ id: "chat:C", cursor: c1 }, page(null, 3_000))];
  const b = boundChunk(turn(5, calls, "short"), 5_000);
  assert.equal(b.form, "clipped");
  const [first, last] = b.messages[1]!.calls!;
  assert.ok(first!.output.endsWith(`nextCursor: "${c1}"`));
  assert.match(last!.output, /nextCursor: null \(this was the last page: the read is complete\)$/);
});

test("a turn too large even without its calls (placeholder) still carries its paging state", () => {
  const p1 = cur("P1");
  const big: ChunkLike = { ...turn(6, [read({ id: "chat:P" }, page(p1))]) };
  big.messages = [{ ...big.messages[0]!, text: "z".repeat(30_000) }, { ...big.messages[1]!, text: "w".repeat(30_000) }, { ...big.messages[0]!, id: "u6b", text: "z".repeat(30_000) }];
  const b = boundChunk(big);
  assert.equal(b.form, "placeholder");
  assert.match(b.messages[0]!.text, new RegExp(`session_read \\(id chat:P\\) nextCursor: "${p1}"`));
});

test("the plan keeps #124's bounds: four bounded turns with paging notes fit, and the note survives into the model input", () => {
  const turns = [1, 2, 3, 4].map((s) => turn(s, Array.from({ length: 10 }, (_, i) => read({ id: `chat:T${s}` }, page(cur(`T${s}-${i}`))))));
  const plan = planContext(turns, [{ id: "now", role: "user", at: "", status: "done", text: "continue" } as ThreadMessage]);
  assert.equal(plan.floor.met, true);
  assert.ok(plan.historyChars <= 48_000);
  const sent = JSON.stringify(planItems(plan));
  for (const s of [1, 2, 3, 4]) assert.ok(sent.includes(cur(`T${s}-9`)), `turn ${s}'s newest cursor reaches the model`);
});

// ---- (2) through the Assistant: interleaved reads across turns -------------------------------------------------------------

test("Assistant: interleaved reads of two sessions and two list queries; the next turn continues each from its own state", async () => {
  const conv = durabilityConversation();
  const d = mkdtempSync(join(tmpdir(), "orbit-paging-"));
  let ids = { long: "", short: "" };
  // Turn 1: alternate one-message pages of the long chat (from the start) and the short chat (from the end), until the short one is
  // read to its end; then two list queries of one item each. Turn 2: continue from the paging state found in the history only.
  const outsOf = (seen: Seen) => {
    const at = (seen.input as any[]).findLastIndex((i) => i.role === "user");
    const items = (seen.input as any[]).slice(at + 1);
    return items.filter((i) => i.type === "function_call_output").map((o) => ({ name: items.find((c) => c.type === "function_call" && c.call_id === o.call_id)!.name as string, args: JSON.parse(items.find((c) => c.type === "function_call" && c.call_id === o.call_id)!.arguments), out: JSON.parse(o.output) }));
  };
  const history = (seen: Seen) => {
    const at = (seen.input as any[]).findLastIndex((i) => i.role === "user");
    return JSON.stringify((seen.input as any[]).slice(0, at));
  };
  const turn1: { name: string; args: any; out: any }[] = [];
  const turn2: { name: string; args: any; out: any }[] = [];
  const model = scripted((seen) => {
    if (!seen.tools.includes("session_read") && seen.tools.length) return say(conv.reply(((seen.input as any[]).findLast((i) => i.role === "user")?.content as string) ?? ""));
    if (!seen.tools.length) return say("stopped");
    const u = (seen.input as any[]).findLast((i) => i.role === "user")?.content as string;
    const outs = outsOf(seen);
    const last = (pred: (o: (typeof outs)[number]) => boolean) => outs.filter(pred).at(-1);
    if (u === "read both") {
      const L = last((o) => o.name === "session_read" && (o.args.id === `chat:${ids.long}`));
      const S = last((o) => o.name === "session_read" && (o.args.id === `chat:${ids.short}`));
      const sDone = S && S.out.result.nextCursor === null;
      const calls: ToolCall[] = [];
      if (!L) calls.push(call("session_read", { id: `chat:${ids.long}`, from: "start", limit: 1 }, `l${outs.length}`));
      else if (outs.filter((o) => o.name === "session_read" && o.args.id === `chat:${ids.long}`).length < 6) calls.push(call("session_read", { id: `chat:${ids.long}`, cursor: L.out.result.nextCursor, limit: 1 }, `l${outs.length}`));
      if (!S) calls.push(call("session_read", { id: `chat:${ids.short}`, limit: 1 }, `s${outs.length}`));
      else if (!sDone) calls.push(call("session_read", { id: `chat:${ids.short}`, cursor: S.out.result.nextCursor, limit: 1 }, `s${outs.length}`));
      if (!calls.length) {
        if (!outs.some((o) => o.name === "sessions_list")) return { text: "", calls: [call("sessions_list", { kinds: ["chat"], limit: 1 }, "q1"), call("sessions_list", { kinds: ["chat"], order: "created", limit: 1 }, "q2")] };
        turn1.push(...outs);
        return say("Paused: the long chat is partly read, the short chat is read to its end, two lists started.");
      }
      return { text: "", calls };
    }
    if (u === "continue") {
      if (outs.length) {
        turn2.push(...outs);
        return say("continued");
      }
      const h = history(seen);
      const cursorFor = (re: RegExp) => re.exec(h)?.[1];
      const lc = cursorFor(new RegExp(`session_read \\(id chat:${ids.long}, from start\\) nextCursor: \\\\"([A-Za-z0-9_-]+)\\\\"`));
      const sc = cursorFor(new RegExp(`session_read \\(id chat:${ids.short}\\) nextCursor: \\\\"([A-Za-z0-9_-]+)\\\\"`));
      const q1 = cursorFor(/sessions_list \(query \{\\"kinds\\":\[\\"chat\\"\]\}\) nextCursor: \\"([A-Za-z0-9_-]+)\\"/);
      const q2 = cursorFor(/sessions_list \(query \{\\"kinds\\":\[\\"chat\\"\],\\"order\\":\\"created\\"\}\) nextCursor: \\"([A-Za-z0-9_-]+)\\"/);
      assert.equal(sc, undefined, "the completed short read offers no cursor");
      assert.ok(new RegExp(`session_read \\(id chat:${ids.short}\\) complete: nextCursor null`).test(h), "and says it is complete");
      assert.ok(lc && q1 && q2, `paging state for each open read is in the history: ${h.slice(0, 200)}`);
      return {
        text: "",
        calls: [
          call("session_read", { id: `chat:${ids.long}`, cursor: lc, limit: 1 }, "c1"),
          call("sessions_list", { kinds: ["chat"], cursor: q1, limit: 1 }, "c2"),
          call("sessions_list", { kinds: ["chat"], order: "created", cursor: q2, limit: 1 }, "c3"),
        ],
      };
    }
    return say("ok");
  });
  const x = rig({ dir: d, extra: () => ({ assistantDir: join(d, "assistant") }), model });
  try {
    const seed = async (title: string, users: string[]) => {
      const t = await x.create(title);
      for (const u of users) assert.equal((await x.send(t.id, u)).status, 200);
      return t.id as string;
    };
    ids = { long: await seed(TITLE, conv.users), short: await seed("Short chat", conv.users.slice(0, 2)) };
    const r1 = await x.api("/assistant/messages", "POST", { text: "read both" });
    assert.equal(r1.status, 200, JSON.stringify(r1.data.error));
    const pagesOf = (id: string) => turn1.filter((o) => o.name === "session_read" && o.args.id === id).map((o) => o.out.result.nextCursor as string | null);
    const longPages = pagesOf(`chat:${ids.long}`);
    const shortPages = pagesOf(`chat:${ids.short}`);
    assert.equal(shortPages.at(-1), null, "the short chat was read to its end in turn 1");
    assert.ok(shortPages.length >= 2, "and had cursors before that");
    assert.equal(typeof longPages.at(-1), "string");

    const r2 = await x.api("/assistant/messages", "POST", { text: "continue" });
    assert.equal(r2.status, 200, JSON.stringify(r2.data.error));
    const view = (await x.api("/assistant")).data.assistant;
    const firstSeq = view.chunks.at(-2).seq;
    assert.equal(view.chunks.at(-1).context.included.find((c: any) => c.seq === firstSeq)?.form, "calls-omitted", "turn 1 reached turn 2 in omitted-calls form");
    assert.equal(turn2.length, 3);
    for (const o of turn2) assert.equal(o.out.ok, true, `${o.name} continued without a cursor error: ${JSON.stringify(o.out).slice(0, 200)}`);
    assert.equal(turn2[0]!.args.cursor, longPages.at(-1), "the long read continued from its own newest cursor, byte-for-byte");
    // The two list queries continued from different cursors, each under the query it was issued for.
    assert.notEqual(turn2[1]!.args.cursor, turn2[2]!.args.cursor);
    for (const c of shortPages.filter(Boolean)) assert.ok(!JSON.stringify(view.chunks.at(-1)).includes(`"cursor":"${c}"`));
  } finally {
    x.close();
  }
});
