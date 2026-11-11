import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openaiModel, instructions, recordCheckInstruction } from "../src/model.ts";
import type { Item } from "../src/model.ts";
import { OWNER, call, rig, say, scripted } from "./threads-fixture.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRIG = ["trig", "_", "abcdef123456"].join("");
const KEY = ["sk", "-", "proj", "abcdefghijklmnop1234"].join("");

// ---- durability and sharing ----------------------------------------------------------------------------------------

test("history is durable: a restarted ORBIT shows the same thread, messages and tool calls", async () => {
  const a = rig({ model: scripted([{ text: "", calls: [call("jobs_list", {})] }, say("No jobs yet.")]) });
  const t = await a.create("Plan");
  const r = await a.send(t.id, "what jobs exist?");
  assert.equal(r.status, 200);
  a.close();
  const b = rig({ dir: a.dir });
  const list = (await b.api("/threads")).data;
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].title, "Plan");
  const again = (await b.api(`/threads/${t.id}`)).data.thread;
  assert.deepEqual(again.messages.map((m: { role: string; text: string }) => [m.role, m.text]), [["user", "what jobs exist?"], ["assistant", "No jobs yet."]]);
  assert.equal(again.messages[1].calls[0].name, "jobs_list");
  assert.equal(again.messages[1].calls[0].provenance, "live");
  assert.equal(again.messages[1].status, "done");
  b.close();
});

test("two clients see the same thread, and what one writes the other reads", async () => {
  const x = rig({ model: scripted([say("hello from ORBIT")]) });
  const fromPhone = await x.api("/threads", "POST", { title: "Shared" }, { "user-agent": "phone" });
  const id = fromPhone.data.thread.id;
  await x.send(id, "hi");
  const fromLaptop = await x.api(`/threads/${id}`, "GET", undefined, { "user-agent": "laptop" });
  assert.equal(fromLaptop.data.thread.messages.length, 2);
  assert.equal((await x.api("/threads")).data.threads[0].id, id);
  x.close();
});

test("a reply in progress shows as pending to other clients and as interrupted after a restart", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const x = rig({ model: scripted(async () => (await gate, say("done"))) });
  const t = await x.create();
  const running = x.send(t.id, "slow one");
  await wait(50);
  const mid = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.equal(mid.busy, true);
  assert.equal(mid.messages.at(-1).status, "pending");
  assert.equal((await x.send(t.id, "second at the same time")).status, 409, "one reply at a time per thread");
  assert.equal((await x.api(`/threads/${t.id}/archive`, "POST", {})).status, 409, "not archived mid-reply");
  // A rename during the reply is not lost, and the reply is not lost either.
  assert.equal((await x.api(`/threads/${t.id}/rename`, "POST", { title: "Renamed meanwhile" })).status, 200);
  const dirCopy = x.dir;
  const snapshot = rig({ dir: dirCopy }); // a restart while pending
  const crashed = (await snapshot.api(`/threads/${t.id}`)).data.thread;
  assert.equal(crashed.messages.at(-1).status, "interrupted");
  assert.match(crashed.messages.at(-1).error, /restarted/);
  snapshot.close();
  release();
  const done = await running;
  assert.equal(done.status, 200);
  const final = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.equal(final.title, "Renamed meanwhile");
  assert.deepEqual(final.messages.map((m: { text: string }) => m.text), ["slow one", "done"]);
  x.close();
});

// ---- what the model is sent ----------------------------------------------------------------------------------------

test("the next turn sends the model the earlier tool calls and their provenance-bearing results, in valid order", async () => {
  const model = scripted([{ text: "", calls: [call("jobs_list", {}, "c1")] }, say("Listed."), say("Second answer.")]);
  const x = rig({ model });
  x.jobs.register("seen-job");
  const t = await x.create();
  await x.send(t.id, "list jobs");
  await x.send(t.id, "and now?");
  const input = model.seen.at(-1)!.input;
  const kinds = input.map((i: Item) => ("type" in i ? i.type : i.role));
  assert.deepEqual(kinds, ["user", "function_call", "function_call_output", "assistant", "user"]);
  const fc = input[1] as { call_id: string; name: string };
  const out = input[2] as { call_id: string; output: string };
  assert.equal(fc.name, "jobs_list");
  assert.equal(out.call_id, fc.call_id, "every result follows its own call");
  const body = JSON.parse(out.output);
  assert.equal(body.ok, true);
  assert.equal(body.provenance, "live");
  assert.equal(body.source, "jobs");
  assert.equal(body.result.jobs[0].id, "seen-job");
  assert.deepEqual(input.at(-1), { role: "user", content: "and now?" });
  x.close();
});

test("history comes from the server: the legacy client-sent history is not used for threads", async () => {
  const model = scripted([say("one"), say("two")]);
  const x = rig({ model });
  const t = await x.create();
  await x.send(t.id, "first");
  // A client cannot inject earlier turns: unknown body fields are ignored.
  const r = await x.api(`/threads/${t.id}/messages`, "POST", { text: "second", messages: [{ role: "user", content: "INJECTED" }] });
  assert.equal(r.status, 200);
  const sent = JSON.stringify(model.seen.at(-1)!.input);
  assert.doesNotMatch(sent, /INJECTED/);
  assert.match(sent, /first/);
  x.close();
});

test("call ids that repeat across turns stay unique in the context, with each result still paired", async () => {
  const model = scripted([{ text: "", calls: [call("jobs_list", {}, "same")] }, say("a"), { text: "", calls: [call("jobs_list", {}, "same")] }, say("b"), say("c")]);
  const x = rig({ model });
  const t = await x.create();
  await x.send(t.id, "1");
  await x.send(t.id, "2");
  await x.send(t.id, "3");
  const items = model.seen.at(-1)!.input;
  const ids = items.filter((i) => "type" in i && i.type === "function_call").map((i) => (i as { call_id: string }).call_id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.equal(items.filter((i) => "call_id" in i && (i as { call_id: string }).call_id === id).length, 2, "one call, one result");
  x.close();
});

test("a failed model call keeps the user message and the calls that already ran, marks the reply failed, and the next turn works", async () => {
  let failNext = true;
  const model = scripted((_s, n) => {
    if (n === 0) return { text: "", calls: [call("jobs_list", {}, "ok1")] };
    if (failNext) {
      failNext = false;
      throw new Error("HTTP 500");
    }
    return say("recovered");
  });
  const x = rig({ model });
  const t = await x.create();
  const r = await x.send(t.id, "go");
  assert.equal(r.status, 502);
  const stored = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.equal(stored.messages[0].text, "go");
  assert.equal(stored.messages[1].status, "error");
  assert.equal(stored.messages[1].calls.length, 1, "the completed call is on record");
  assert.equal((await x.send(t.id, "again")).status, 200);
  const sent = model.seen.at(-1)!.input;
  assert.ok(sent.some((i) => "type" in i && i.type === "function_call_output"), "the call that did run is still in context");
  assert.ok(!sent.some((i) => "role" in i && i.role === "assistant" && (i as { content: string }).content === ""), "a failed reply adds no empty assistant message");
  x.close();
});

test("a failed model call reports the call's own error, not the model port's status line", async () => {
  const model = scripted(() => {
    throw new Error("ChatGPT usage limit reached for this plan: try later.");
  });
  model.status = () => ({ port: "model", state: "down", impl: "fake", detail: "Last call failed: something else", verifiedAt: new Date(0).toISOString() });
  const x = rig({ model });
  const t = await x.create();
  const r = await x.send(t.id, "go");
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "The model call failed: ChatGPT usage limit reached for this plan: try later.");
  const stored = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.equal(stored.messages[1].error, "The model call failed: ChatGPT usage limit reached for this plan: try later.");
  x.close();
});

// ---- the record-check instruction ------------------------------------------------------------------------------------

test("the system prompt asks the model to check job and operation records before claiming an outcome (a request, not a guarantee)", async () => {
  const tooling = ["jobs_list: x", "job_status: y", "ops_admin_operations: z"];
  const text = instructions([], undefined, tooling);
  assert.match(text, /Before you say that a job or an action did happen or did not happen/);
  assert.match(text, /jobs_list, job_status, ops_admin_operations/);
  assert.match(text, /not proof/);
  assert.match(recordCheckInstruction([]), /cannot check .* unverified/);
  // It really goes out in the request the adapter sends. That is all this can show: whether a model obeys is not tested here.
  let sent: { instructions?: string } = {};
  const m = openaiModel("m", "k", (async (_u: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }));
  }) as typeof fetch);
  await m.step!([{ role: "user", content: "x" }], [], undefined, [{ name: "jobs_list", description: "d", parameters: {} }]);
  assert.match(sent.instructions ?? "", /check ORBIT's actual records in this turn with jobs_list/);
});

// ---- cards: single use, ids, live state ------------------------------------------------------------------------------

async function proposeLaunch(x: ReturnType<typeof rig>) {
  const t = await x.create();
  const r = await x.send(t.id, "launch it");
  return { t, card: r.data.thread.cards.at(-1) };
}

test("a confirmed card cannot be confirmed again, even concurrently or on retry, and it shows the job id and the job's live state", async () => {
  const model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: "Implement the widget exporter with tests and docs for the billing module please" })] }, say("Proposed; waiting for your confirmation.")]);
  const x = rig({ model });
  const { t, card } = await proposeLaunch(x);
  assert.equal(card.state, "open");
  assert.equal(card.kind, "job_launch");
  const results = await Promise.all(Array.from({ length: 6 }, () => x.api(`/chat/proposals/${card.id}/confirm`, "POST")));
  assert.equal(results.filter((r) => r.status === 202).length, 1, "exactly one confirmation goes through");
  assert.equal(x.fired.length, 1, "the runner was launched once");
  assert.equal(x.jobs.all().length, 1);
  const retry = await x.api(`/chat/proposals/${card.id}/confirm`, "POST");
  assert.equal(retry.status, 409, "a retry is told it was already used");
  assert.equal(retry.data.state, "confirmed");
  assert.equal(x.fired.length, 1);
  const shown = (await x.api(`/threads/${t.id}`)).data.thread.cards[0];
  assert.equal(shown.state, "confirmed");
  const jobId = x.jobs.all()[0]!.id;
  assert.equal(shown.outcome.jobId, jobId, "the card shows the resulting job id");
  assert.equal(shown.live.found, true);
  assert.equal(shown.live.state, "registered", "live state comes from the jobs record, not from the confirmation");
  x.jobs.record(jobId, { type: "started" });
  assert.equal((await x.api(`/threads/${t.id}`)).data.thread.cards[0].live.state, "running", "and it follows the record");
  // Another client sees the same final state, and cancelling a confirmed card does nothing.
  assert.equal((await x.api(`/chat/proposals/${card.id}/cancel`, "POST")).status, 409);
  assert.equal((await x.api(`/threads/${t.id}`)).data.thread.cards[0].state, "confirmed");
  x.close();
});

test("cancelled, expired and refused cards keep their final state across reloads and restarts, and nothing runs", async () => {
  let clock = new Date("2026-11-10T00:00:00Z");
  const brief = (n: number) => `Distinct brief number ${n}: ${"alpha beta gamma delta ".repeat(3)}${["one", "two", "three"][n]} unique${n}`;
  const model = scripted([
    { text: "", calls: [call("job_launch", { routine: "orbit", brief: brief(0) }, "a")] }, say("p1"),
    { text: "", calls: [call("job_launch", { routine: "orbit", brief: brief(1) }, "b")] }, say("p2"),
    { text: "", calls: [call("job_steer", { id: "vanishing", text: "hello" }, "c")] }, say("p3"),
  ]);
  const x = rig({ model, now: () => clock });
  // The proposal store uses the injected clock too.
  x.jobs.register("vanishing");
  const t = await x.create();
  const c1 = (await x.send(t.id, "one")).data.thread.cards[0];
  const c2 = (await x.send(t.id, "two")).data.thread.cards[1];
  const c3 = (await x.send(t.id, "three")).data.thread.cards[2];
  assert.equal((await x.api(`/chat/proposals/${c1.id}/cancel`, "POST")).status, 200);
  clock = new Date("2026-11-10T02:00:00Z");
  const view = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.deepEqual(view.cards.map((c: { state: string }) => c.state), ["cancelled", "expired", "expired"]);
  const late = await x.api(`/chat/proposals/${c2.id}/confirm`, "POST");
  assert.ok(late.status === 404 || late.status === 409, "an expired card cannot be confirmed");
  assert.equal(late.data.state, "expired");
  assert.ok([404, 409].includes((await x.api(`/chat/proposals/${c3.id}/confirm`, "POST")).status));
  assert.equal(x.fired.length, 0, "nothing ran");
  // A card that was still open when ORBIT restarted is expired afterwards: its proposal is gone.
  const model2 = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: brief(2) }, "d")] }, say("p4")]);
  const y = rig({ dir: x.dir, model: model2 });
  const t2 = await y.create();
  const open = (await y.send(t2.id, "four")).data.thread.cards[0];
  assert.equal(open.state, "open");
  y.close();
  const z = rig({ dir: x.dir });
  const after = (await z.api(`/threads/${t2.id}`)).data.thread.cards[0];
  assert.equal(after.state, "expired");
  assert.ok([404, 409].includes((await z.api(`/chat/proposals/${open.id}/confirm`, "POST")).status));
  assert.equal((await z.api(`/threads/${t.id}`)).data.thread.cards.map((c: { state: string }) => c.state).join(), "cancelled,expired,expired");
  x.close();
  z.close();
});

test("a confirmed steer card shows the steer number and whether the runner has picked it up", async () => {
  const model = scripted([{ text: "", calls: [call("job_steer", { id: "steer-me", text: "Add a test." })] }, say("proposed")]);
  const x = rig({ model });
  x.jobs.register("steer-me");
  const t = await x.create();
  const card = (await x.send(t.id, "steer it")).data.thread.cards[0];
  assert.equal((await x.api(`/chat/proposals/${card.id}/confirm`, "POST")).status, 201);
  let shown = (await x.api(`/threads/${t.id}`)).data.thread.cards[0];
  assert.equal(shown.outcome.steerN, 1);
  assert.equal(shown.live.delivered, false);
  x.jobs.acknowledge("steer-me", [1]);
  shown = (await x.api(`/threads/${t.id}`)).data.thread.cards[0];
  assert.equal(shown.live.delivered, true);
  x.close();
});

test("server-operation cards need their digest, are single use, and show the ledger's state, never an inferred success", async () => {
  const model = scripted([{ text: "", calls: [call("ops_propose_restart_orbit", {})] }, say("Proposed restart.")]);
  const x = rig({ model, admin: true });
  const t = await x.create();
  const card = (await x.send(t.id, "restart")).data.thread.cards[0];
  assert.equal(card.kind, "ops_admin");
  assert.ok(card.digest);
  assert.equal((await x.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: "wrong" })).status, 409);
  assert.equal((await x.api(`/threads/${t.id}`)).data.thread.cards[0].state, "open", "a wrong digest leaves the card open");
  const both = await Promise.all([x.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest }), x.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest })]);
  assert.equal(both.filter((r) => r.status === 202).length, 1, "one of two concurrent confirmations goes through");
  assert.ok(both.every((r) => r.status === 202 || r.status === 404 || r.status === 409));
  assert.equal(x.helper.calls.filter((a) => a === "restart_orbit").length, 1, "dispatched once");
  const shown = (await x.api(`/threads/${t.id}`)).data.thread.cards[0];
  assert.equal(shown.state, "confirmed");
  assert.ok(shown.outcome.opId);
  assert.equal(shown.live.source, "ops-admin");
  assert.equal(shown.live.state, "accepted", "accepted is shown as accepted, not as success");
  x.close();
});

test("a confirmation the helper refuses leaves a refused card with no execution, and it cannot be retried", async () => {
  const model = scripted([{ text: "", calls: [call("ops_propose_refresh_vault", {})] }, say("proposed")]);
  const x = rig({ model, admin: true });
  x.helper.refuse = true;
  const t = await x.create();
  const card = (await x.send(t.id, "refresh the vault")).data.thread.cards[0];
  const r = await x.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.ok(r.status >= 400);
  const shown = (await x.api(`/threads/${t.id}`)).data.thread.cards[0];
  assert.equal(shown.state, "refused");
  assert.match(shown.outcome.error, /refused/);
  x.helper.refuse = false;
  assert.ok((await x.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest })).status >= 400, "no retry on a spent proposal");
  assert.equal(x.helper.calls.filter((a) => a === "refresh_vault").length, 1);
  x.close();
});

// ---- duplicate launch warning --------------------------------------------------------------------------------------------

test("a launch proposal that matches a recent job's brief carries a duplicate warning on the tool result and the card", async () => {
  const brief = "Implement server-side sessions and threads for ORBIT chat with tests and docs, atomically persisted, owner only";
  const model = scripted([
    { text: "", calls: [call("job_launch", { routine: "orbit", brief }, "l1")] }, say("p1"),
    { text: "", calls: [call("job_launch", { routine: "orbit", brief: `${brief} please` }, "l2")] }, say("p2"),
    { text: "", calls: [call("job_launch", { routine: "orbit", brief: "Rotate the vault deploy key and update the install notes for the helper units on the server" }, "l3")] }, say("p3"),
  ]);
  const x = rig({ model });
  const t = await x.create();
  const first = (await x.send(t.id, "launch")).data.thread.cards[0];
  assert.equal(first.duplicates, undefined);
  assert.equal((await x.api(`/chat/proposals/${first.id}/confirm`, "POST")).status, 202);
  const jobId = x.jobs.all()[0]!.id;
  const second = (await x.send(t.id, "launch again")).data.thread;
  const card = second.cards[1];
  assert.equal(card.duplicates[0].job, jobId);
  assert.ok(card.duplicates[0].similarity >= 0.7);
  const toolOutput = x.threads.get(t.id)!.messages.at(-1)!.calls![0]!.output;
  assert.match(toolOutput, /duplicateWarning/);
  assert.match(toolOutput, new RegExp(jobId));
  const third = (await x.send(t.id, "something else")).data.thread.cards[2];
  assert.equal(third.duplicates, undefined, "an unrelated brief is not flagged");
  // The proposal itself is still made: the warning does not block, Rai decides.
  assert.equal(card.state, "open");
  x.close();
});

// ---- authorization and cross-site ------------------------------------------------------------------------------------------

test("every thread route refuses anyone but the owner, and reveals nothing", async () => {
  const x = rig({ model: scripted([say("secret reply")]) });
  const t = await x.create("Private title");
  await x.send(t.id, "private text");
  for (const who of ["stranger@example.com", undefined]) {
    x.caller.who = who;
    const attempts = [
      x.api("/threads"),
      x.api("/threads", "POST", {}),
      x.api(`/threads/${t.id}`),
      x.api(`/threads/${t.id}/rename`, "POST", { title: "x" }),
      x.api(`/threads/${t.id}/archive`, "POST", {}),
      x.api(`/threads/${t.id}/messages`, "POST", { text: "x" }),
      x.api("/threads/notice/ack", "POST", {}),
      x.api(`/threads/00000000-0000-0000-0000-000000000000`),
    ];
    for (const r of await Promise.all(attempts)) {
      assert.equal(r.status, 403);
      assert.doesNotMatch(JSON.stringify(r.data), /Private title|private text|secret reply/);
    }
  }
  x.caller.who = OWNER;
  const after = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.equal(after.title, "Private title");
  assert.equal(after.messages.length, 2, "the stranger changed nothing");
  x.close();
});

test("cross-site POSTs to every thread mutation are refused and change nothing", async () => {
  const x = rig();
  const t = await x.create("Mine");
  const evil = { "sec-fetch-site": "cross-site", origin: "https://evil.example" };
  for (const [path, body] of [["/threads", {}], [`/threads/${t.id}/rename`, { title: "Hacked" }], [`/threads/${t.id}/archive`, {}], [`/threads/${t.id}/messages`, { text: "do it" }], ["/threads/notice/ack", {}]] as [string, object][]) {
    assert.equal((await x.api(path, "POST", body, evil)).status, 403, path);
  }
  const now = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.equal(now.title, "Mine");
  assert.equal(now.archived, false);
  assert.equal(now.messages.length, 0);
  assert.equal((await x.api("/threads")).data.threads.length, 1);
  assert.ok((await x.api("/threads/notice/ack", "POST", {}, { "sec-fetch-site": "same-origin" })).status === 200);
  x.close();
});

// ---- archive, rename, notice ------------------------------------------------------------------------------------------------

test("archiving hides a thread without deleting anything, restoring brings it back, and an archived thread cannot be continued", async () => {
  const x = rig({ model: scripted([say("kept")]) });
  const t = await x.create("Old work");
  await x.send(t.id, "remember this");
  const archived = (await x.api(`/threads/${t.id}/archive`, "POST", {})).data.thread;
  assert.equal(archived.archived, true);
  assert.ok(archived.archivedAt);
  assert.equal((await x.api("/threads")).data.threads.length, 0);
  assert.equal((await x.api("/threads?archived=1")).data.threads.length, 1);
  const opened = (await x.api(`/threads/${t.id}`)).data.thread;
  assert.deepEqual(opened.messages.map((m: { text: string }) => m.text), ["remember this", "kept"]);
  assert.equal((await x.send(t.id, "more")).status, 409);
  x.close();
  const y = rig({ dir: x.dir });
  assert.equal((await y.api(`/threads/${t.id}`)).data.thread.archived, true, "still archived after a restart, nothing deleted");
  const back = (await y.api(`/threads/${t.id}/archive`, "POST", { archived: false })).data.thread;
  assert.equal(back.archived, false);
  assert.equal(back.messages.length, 2);
  assert.equal(readdirSync(join(x.dir, "threads")).filter((f) => f.endsWith(".json") && f !== "meta.json").length, 1);
  y.close();
});

test("rename validates, trims, masks, and an untitled thread is titled from its first message", async () => {
  const x = rig();
  const t = await x.create();
  assert.equal(t.title, "New thread");
  assert.equal((await x.api(`/threads/${t.id}/rename`, "POST", { title: "   " })).status, 400);
  assert.equal((await x.api(`/threads/${t.id}/rename`, "POST", {})).status, 400);
  const r = (await x.api(`/threads/${t.id}/rename`, "POST", { title: `  Deploy\n notes ${KEY} ` })).data.thread;
  assert.equal(r.title.includes(KEY), false);
  assert.match(r.title, /^Deploy notes/);
  assert.equal((await x.api("/threads/not-a-thread/rename", "POST", { title: "x" })).status, 404);
  const u = await x.create();
  await x.send(u.id, "What is the state of the money noodle PR?");
  assert.equal((await x.api(`/threads/${u.id}`)).data.thread.title, "What is the state of the money noodle PR?");
  await x.api(`/threads/${t.id}/rename`, "POST", { title: "Mine" });
  await x.send(t.id, "later message");
  assert.equal((await x.api(`/threads/${t.id}`)).data.thread.title, "Mine", "a chosen title is not overwritten");
  x.close();
});

test("migration: nothing is imported on first load, the notice shows once, and acknowledging it persists across restarts and devices", async () => {
  const x = rig();
  const first = (await x.api("/threads")).data;
  assert.deepEqual(first.threads, [], "no threads are made up from old browser history");
  assert.match(first.notice.text, /not imported/);
  assert.equal(first.notice.id, "server-threads-v1");
  assert.equal((await x.api("/threads/notice/ack", "POST", {})).status, 200);
  assert.equal((await x.api("/threads")).data.notice, null);
  x.close();
  const y = rig({ dir: x.dir });
  assert.equal((await y.api("/threads")).data.notice, null, "it does not come back after a restart");
  y.close();
});

// ---- secrets ----------------------------------------------------------------------------------------------------------------------

test("secrets and trigger ids are masked everywhere a thread persists, and the model is not sent them either", async () => {
  const model = scripted([say("ok"), say("ok2")]);
  const x = rig({ model });
  const t = await x.create();
  await x.send(t.id, `here is a key ${KEY} and routine ${TRIG}`);
  const stored = JSON.stringify(x.threads.get(t.id));
  assert.ok(!stored.includes(KEY) && !stored.includes(TRIG));
  const onDisk = readdirSync(join(x.dir, "threads")).map((f) => readFileSync(join(x.dir, "threads", f), "utf8")).join("\n");
  assert.ok(!onDisk.includes(KEY) && !onDisk.includes(TRIG), "not on disk");
  assert.match(onDisk, /trig_…3456/);
  assert.ok(!JSON.stringify(model.seen[0]!.input).includes(KEY), "not sent to the model");
  const view = JSON.stringify((await x.api(`/threads/${t.id}`)).data);
  assert.ok(!view.includes(KEY) && !view.includes(TRIG));
  x.close();
});

test("tool results with secrets are masked before they are stored", async () => {
  const model = scripted([{ text: "", calls: [call("memory_read", { path: "leaky.md" })] }, say("done")]);
  const x = rig({ model, vault: { "leaky.md": `deploy key: ${KEY}\nroutine ${TRIG}\n` } });
  const t = await x.create();
  await x.send(t.id, "read it");
  const call0 = x.threads.get(t.id)!.messages[1]!.calls![0]!;
  assert.equal(call0.ok, true);
  assert.match(call0.output, /deploy key/, "the note was really read");
  assert.ok(!call0.output.includes(KEY) && !call0.output.includes(TRIG), "but its secrets are masked in the stored result");
  assert.ok(!JSON.stringify((await x.api(`/threads/${t.id}`)).data).includes(KEY));
  x.close();
});

// ---- failure paths ----------------------------------------------------------------------------------------------------------------

test("a thread file that cannot be read is reported and left alone, never overwritten or deleted", async () => {
  const x = rig();
  const t = await x.create("Fine");
  x.close();
  const bad = join(x.dir, "threads", "11111111-1111-1111-1111-111111111111.json");
  writeFileSync(bad, "{ not json");
  const y = rig({ dir: x.dir });
  const list = (await y.api("/threads")).data;
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].id, t.id);
  assert.match(list.problems[0], /11111111-1111-1111-1111-111111111111\.json/);
  assert.equal(readFileSync(bad, "utf8"), "{ not json");
  y.close();
});

test("a failed disk write changes nothing in memory and reports an error instead of pretending", async () => {
  const x = rig();
  const t = await x.create("Stays");
  rmSync(join(x.dir, "threads"), { recursive: true, force: true });
  const r = await x.api(`/threads/${t.id}/rename`, "POST", { title: "Lost" });
  assert.equal(r.status, 500);
  assert.equal(x.threads.get(t.id)!.title, "Stays", "no half-applied change");
  x.close();
});

test("writes are atomic: no temporary files are left behind and the file always parses", async () => {
  const x = rig({ model: scripted([say("a")]) });
  const t = await x.create();
  await Promise.all(Array.from({ length: 8 }, (_, i) => x.api(`/threads/${t.id}/rename`, "POST", { title: `T${i}` })));
  const files = readdirSync(join(x.dir, "threads"));
  assert.ok(!files.some((f) => f.endsWith(".tmp")));
  assert.equal(JSON.parse(readFileSync(join(x.dir, "threads", `${t.id}.json`), "utf8")).id, t.id);
  assert.ok(existsSync(join(x.dir, "threads", `${t.id}.json`)));
  x.close();
});

test("concurrent messages in different threads do not mix: each proposal goes on its own thread's card", async () => {
  const model = scripted(async (s, n) => {
    await wait(n % 2 === 0 ? 30 : 5);
    const last = s.input.filter((i) => "role" in i && i.role === "user").at(-1) as { content: string } | undefined;
    if (s.input.some((i) => "type" in i && i.type === "function_call_output")) return say("proposed");
    return { text: "", calls: [call("job_launch", { routine: "orbit", brief: `Brief for ${last?.content} ${"padding words here ".repeat(4)}` })] };
  });
  const x = rig({ model });
  const a = await x.create();
  const b = await x.create();
  const [ra, rb] = await Promise.all([x.send(a.id, "alpha-thread"), x.send(b.id, "beta-thread")]);
  assert.equal(ra.data.thread.cards.length, 1);
  assert.equal(rb.data.thread.cards.length, 1);
  assert.match(ra.data.thread.cards[0].brief, /alpha-thread/);
  assert.match(rb.data.thread.cards[0].brief, /beta-thread/);
  x.close();
});

