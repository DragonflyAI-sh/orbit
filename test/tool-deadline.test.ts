import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { proposals as newProposals, runChat, TOOL_DEADLINE_MS, TurnInterrupted } from "../src/agent.ts";
import type { ChatTool, ToolContext } from "../src/agent.ts";
import type { Step } from "../src/model.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { call, rig, say, scripted } from "./threads-fixture.ts";
import { git, makeFixture } from "./vault-fixture.ts";

// Chat tool execution deadlines (docs/tool-deadlines.md). Before this change a tool whose run() never settled held its thread busy
// until a restart (docs/acceptance-2026-11-14.md, row 3c). Everything here is offline: scripted models, synthetic tools, an
// in-memory or temporary thread store, and a temporary bare git repository for the vault write. Deadlines are tens of milliseconds.

const DEADLINE = 40;
const GRACE = 20;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMPTY = { type: "object", properties: {} };

// Any unhandled rejection during this file is a failure: a late rejection must always be observed.
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => void unhandled.push(e);
before(() => void process.on("unhandledRejection", onUnhandled));
after(() => {
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, [], "no unhandled rejection");
});

type Probe = { runs: number; signals: AbortSignal[]; resolve: (v?: unknown) => void; reject: (e: Error) => void };

// A tool that never settles on its own. `cooperative` makes it reject when asked to stop; otherwise it ignores the abort and can be
// settled late from the test (probe.resolve / probe.reject).
function stuckTool(name: string, opts: { readOnly?: boolean; cooperative?: boolean } = {}) {
  const probe: Probe = { runs: 0, signals: [], resolve: () => {}, reject: () => {} };
  const tool: ChatTool = {
    name,
    description: name,
    parameters: EMPTY,
    ...(opts.readOnly ? { readOnly: true } : {}),
    run: (_a, ctx?: ToolContext) => {
      probe.runs++;
      if (ctx) probe.signals.push(ctx.signal);
      return new Promise((resolve, reject) => {
        probe.resolve = (v = "late value") => resolve({ value: v, provenance: "live", source: "test" });
        probe.reject = reject;
        if (opts.cooperative) ctx?.signal.addEventListener("abort", () => reject(new Error("stopped on request")), { once: true });
      });
    },
  };
  return { tool, probe };
}

function quickTool(name: string, opts: { readOnly?: boolean } = {}) {
  const runs = { n: 0 };
  const tool: ChatTool = { name, description: name, parameters: EMPTY, ...(opts.readOnly ? { readOnly: true } : {}), run: async () => (runs.n++, { value: `${name} ran`, provenance: "live", source: "test" }) };
  return { tool, runs };
}

const turnStep = (...names: string[]): Step => ({ text: "", calls: names.map((n, i) => call(n, {}, `c${i}_${n}`)) });

function service(model: ReturnType<typeof scripted>, late: { name: string; ok: boolean; error?: string }[] = []) {
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model, proposals: newProposals(), budget: 1_000_000, toolDeadlineMs: DEADLINE, abortGraceMs: GRACE, onLateTool: (l) => void late.push(l) });
  return { threads, svc, late };
}

test("the production default is the documented 180 s", () => {
  assert.equal(TOOL_DEADLINE_MS, 180_000);
});

test("HTTP: a never-resolving read-only tool no longer holds the thread; the turn ends once and the next message answers", async () => {
  const stuck = stuckTool("lookup", { readOnly: true });
  const model = scripted((_s, n) => (n === 0 ? turnStep("lookup") : say("second answer")));
  const r = rig({ model, extra: () => ({ prInspect: [stuck.tool], toolDeadlineMs: DEADLINE, abortGraceMs: GRACE }) });
  const t = await r.create("hang");

  const started = Date.now();
  const first = await r.send(t.id, "look it up");
  assert.ok(Date.now() - started < 2_000, "the request came back after the deadline, not never");
  assert.equal(first.status, 502);
  assert.match(first.data.error, /^The tool call lookup did not finish within 40 ms, so ORBIT stopped waiting and asked it to stop \(it had not stopped when the turn ended\)\. It only reads, and no result from it was used\. The turn ended here\.$/);
  assert.equal(first.data.thread.busy, false, "the thread is free in the response itself");
  assert.equal(r.threads.isBusy(t.id), false);
  assert.equal(stuck.probe.runs, 1);
  assert.equal(stuck.probe.signals[0]!.aborted, true, "the abort was propagated to the tool");
  assert.equal(model.seen.length, 1, "the model was not asked again after the timeout");

  const stored = r.threads.get(t.id)!.messages[1]!;
  assert.equal(stored.status, "error");
  assert.equal(stored.calls?.length, 1);
  const c = stored.calls![0]!;
  assert.deepEqual([c.name, c.ok, c.interrupted, c.abort, c.outcomeUnknown], ["lookup", false, "timeout", "requested", undefined]);
  assert.deepEqual(JSON.parse(c.output), { ok: false, outcome: "no_result", interrupted: "timeout", abort: "requested", retried: false, error: "lookup did not finish within 40 ms; no result was used. It only reads, so nothing changed." });

  const second = await r.send(t.id, "anything else?");
  assert.equal(second.status, 200);
  assert.equal(r.threads.get(t.id)!.messages[3]!.text, "second answer");
  assert.equal(stuck.probe.runs, 1, "nothing was re-run");
  // The second turn's model saw the earlier interrupted call as interrupted, not as a result.
  const seenOutput = model.seen[1]!.input.find((i) => "type" in i && i.type === "function_call_output") as { output: string };
  assert.match(seenOutput.output, /"outcome":"no_result"/);
  assert.deepEqual(r.threads.get(t.id)!.messages.map((m) => `${m.role}:${m.status ?? ""}`), ["user:", "assistant:error", "user:", "assistant:done"]);
});

test("HTTP: the legacy /chat route is bounded the same way", async () => {
  const stuck = stuckTool("lookup", { readOnly: true });
  const r = rig({ model: scripted([turnStep("lookup"), say("never")]), extra: () => ({ prInspect: [stuck.tool], toolDeadlineMs: DEADLINE, abortGraceMs: GRACE }) });
  const res = await r.api("/chat", "POST", { messages: [{ role: "user", content: "go" }] });
  assert.equal(res.status, 502);
  assert.match(res.data.error, /The tool call lookup did not finish within 40 ms/);
});

test("cooperative abort: the tool stops when asked, the abort is recorded as confirmed, and its listener ran once", async () => {
  const stuck = stuckTool("lookup", { readOnly: true, cooperative: true });
  const model = scripted([turnStep("lookup"), say("never")]);
  const { threads, svc, late } = service(model);
  const t = threads.create("coop");
  const out = await svc.turn(t.id, "go", { memory: [], limits: [], tools: [stuck.tool], isOwner: true });
  assert.match(out.error ?? "", /asked it to stop \(it stopped\)\. It stopped when asked; no result from it was used\./);
  const c = threads.get(t.id)!.messages[1]!.calls![0]!;
  assert.deepEqual([c.interrupted, c.abort, c.outcomeUnknown], ["timeout", "confirmed", undefined]);
  await wait(30);
  assert.deepEqual(late, [], "it ended inside the grace period, so nothing is late");
  assert.equal(threads.isBusy(t.id), false);
});

test("abort ignored, late resolve and late reject: nothing is written after the turn, nothing is unhandled, the next turn works", async () => {
  for (const how of ["resolve", "reject"] as const) {
    const stuck = stuckTool("lookup", { readOnly: true });
    const model = scripted((_s, n) => (n === 0 ? turnStep("lookup") : say("fresh")));
    const { threads, svc, late } = service(model);
    const t = threads.create(how);
    const prep = { memory: [], limits: [], tools: [stuck.tool], isOwner: true };
    const first = await svc.turn(t.id, "go", prep);
    assert.match(first.error ?? "", /did not finish within 40 ms/);
    const snapshot = JSON.stringify(threads.get(t.id));

    if (how === "resolve") stuck.probe.resolve("a late answer");
    else stuck.probe.reject(new Error("late failure"));
    await wait(10);
    assert.deepEqual(late, [{ thread: t.id, name: "lookup", ok: how === "resolve", ...(how === "reject" ? { error: "late failure" } : {}) }], "the late end is only logged");
    assert.equal(JSON.stringify(threads.get(t.id)), snapshot, "the late result changed nothing in the thread");
    assert.equal(model.seen.length, 1, "the late result did not restart the model");

    const second = await svc.turn(t.id, "again", prep);
    assert.equal(second.error, undefined);
    assert.equal(threads.get(t.id)!.messages.length, 4);
    assert.equal(stuck.probe.runs, 1);
  }
});

test("a late completion of the old turn while a newer turn is busy does not touch the newer turn or its busy flag", async () => {
  const stuck = stuckTool("lookup", { readOnly: true });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const model = scripted(async (_s, n) => {
    if (n === 0) return turnStep("lookup");
    await gate; // the newer turn's model request is in flight
    return say("newer answer");
  });
  const { threads, svc, late } = service(model);
  const t = threads.create("overlap");
  const prep = { memory: [], limits: [], tools: [stuck.tool], isOwner: true };

  await svc.turn(t.id, "old", prep);
  const newer = svc.turn(t.id, "new", prep);
  await wait(10);
  assert.equal(threads.isBusy(t.id), true);
  const during = JSON.stringify(threads.get(t.id));

  stuck.probe.resolve("old turn's late result");
  await wait(10);
  assert.equal(late.length, 1);
  assert.equal(threads.isBusy(t.id), true, "the newer turn still holds the thread");
  assert.equal(JSON.stringify(threads.get(t.id)), during, "nothing from the old turn was appended to the newer one");
  assert.equal(model.seen.length, 2, "no extra model request");

  release();
  const out = await newer;
  assert.equal(out.error, undefined);
  assert.equal(threads.isBusy(t.id), false);
  const msgs = threads.get(t.id)!.messages;
  assert.deepEqual(msgs.map((m) => `${m.role}:${m.status ?? ""}`), ["user:", "assistant:error", "user:", "assistant:done"]);
  assert.equal(msgs[3]!.text, "newer answer");
  assert.equal(msgs[3]!.calls?.length ?? 0, 0);
});

test("the busy flag is freed only by the turn that holds it", () => {
  const threads = threadStore(undefined);
  const t = threads.create("tokens");
  const first = threads.tryBegin(t.id)!;
  assert.equal(threads.tryBegin(t.id), undefined, "a second turn is refused while one runs");
  assert.equal(threads.end(t.id, first), true);
  const second = threads.tryBegin(t.id)!;
  assert.equal(threads.end(t.id, first), false, "an old turn's end does not free a newer turn");
  assert.equal(threads.isBusy(t.id), true);
  assert.equal(threads.end(t.id, second), true);
  assert.equal(threads.isBusy(t.id), false);
});

test("cancellation: a running tool is asked to stop, the turn ends as cancelled, and a cancelled turn starts nothing new", async () => {
  const stuck = stuckTool("lookup", { readOnly: true });
  const next = quickTool("next", { readOnly: true });
  const model = scripted([turnStep("lookup", "next"), say("never")]);
  const threads = threadStore(undefined);
  // A long deadline, so only the cancellation can end the call.
  const svc = threadService({ threads, model, proposals: newProposals(), budget: 1_000_000, toolDeadlineMs: 60_000, abortGraceMs: GRACE, onLateTool: () => {} });
  const t = threads.create("cancel");
  const ctl = new AbortController();
  const p = svc.turn(t.id, "go", { memory: [], limits: [], tools: [stuck.tool, next.tool], isOwner: true }, { signal: ctl.signal });
  await wait(10);
  ctl.abort();
  const out = await p;
  assert.match(out.error ?? "", /^The tool call lookup was still running when the turn was cancelled, .*1 tool call the model asked for was not started\.$/);
  assert.equal(stuck.probe.signals[0]!.aborted, true);
  assert.equal(next.runs.n, 0, "the next call was not started");
  assert.equal(threads.get(t.id)!.messages[1]!.calls![0]!.interrupted, "cancelled");
  assert.equal(threads.isBusy(t.id), false);

  // Already cancelled: no model request is made at all.
  const ctl2 = new AbortController();
  ctl2.abort();
  const before = model.seen.length;
  await assert.rejects(runChat({ model, messages: [{ role: "user", content: "x" }], limits: [], tools: [next.tool], signal: ctl2.signal }), (e: unknown) => e instanceof TurnInterrupted && e.kind === "cancelled");
  assert.equal(model.seen.length, before);
});

test("a multi-tool sequence stops at the call that timed out: earlier calls stay on record, later ones never start", async () => {
  const first = quickTool("first", { readOnly: true });
  const stuck = stuckTool("slow", { readOnly: true });
  const third = quickTool("third");
  const model = scripted([turnStep("first", "slow", "third"), say("never")]);
  const { threads, svc } = service(model);
  const t = threads.create("multi");
  const out = await svc.turn(t.id, "go", { memory: [], limits: [], tools: [first.tool, stuck.tool, third.tool], isOwner: true });
  assert.match(out.error ?? "", /The tool call slow did not finish within 40 ms.* 1 tool call the model asked for was not started\.$/);
  assert.deepEqual([first.runs.n, stuck.probe.runs, third.runs.n], [1, 1, 0]);
  assert.deepEqual(threads.get(t.id)!.messages[1]!.calls!.map((c) => [c.name, c.ok, c.interrupted ?? null]), [["first", true, null], ["slow", false, "timeout"]]);
  assert.equal(model.seen.length, 1);
});

test("a tool that may have an effect is run once, its timeout is reported as outcome unknown (not failed), and it is never retried", async () => {
  const stuck = stuckTool("notify_like");
  const model = scripted((_s, n) => (n === 0 ? turnStep("notify_like") : say("I will not repeat it until it is checked.")));
  const { threads, svc, late } = service(model);
  const t = threads.create("mutating");
  const prep = { memory: [], limits: [], tools: [stuck.tool], isOwner: true };
  const out = await svc.turn(t.id, "send it", prep);
  assert.match(out.error ?? "", /Its outcome is UNKNOWN: it may still complete, so it is not reported as failed\. ORBIT did not retry it and will not repeat it on its own/);
  assert.doesNotMatch(out.error ?? "", /model call failed/);
  const c = threads.get(t.id)!.messages[1]!.calls![0]!;
  assert.deepEqual([c.ok, c.interrupted, c.abort, c.outcomeUnknown], [false, "timeout", "requested", true]);
  const body = JSON.parse(c.output);
  assert.equal(body.outcome, "unknown");
  assert.equal(body.retried, false);
  assert.match(body.error, /outcome is UNKNOWN, not failed/);
  assert.equal(c.arguments, "{}", "the call and its arguments are kept for reconciliation");

  // The next turn sees "unknown" and ORBIT itself re-runs nothing; the late completion is logged, not written.
  await svc.turn(t.id, "did it work?", prep);
  assert.equal(stuck.probe.runs, 1);
  assert.match(JSON.stringify(model.seen[1]!.input), /outcome\\":\\"unknown/);
  stuck.probe.resolve();
  await wait(10);
  assert.equal(late.length, 1);
  assert.equal(threads.get(t.id)!.messages.length, 4);
});

test("a vault write cut off mid-push: invoked once, outcome unknown, the clone's write lock still serializes, and it lands exactly once", async () => {
  const fx = makeFixture();
  // The remote holds the push in its pre-receive hook until the test opens the gate: a write whose effect is genuinely in flight.
  const gate = join(fx.root, "gate");
  const hook = join(fx.remote, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nwhile [ ! -f '${gate}' ]; do sleep 0.02; done\nexit 0\n`);
  chmodSync(hook, 0o755);
  const now = () => new Date("2026-11-14T12:00:00Z");
  const clone = fx.make({ now });
  await clone.sync();
  const edits = vaultEdits({ clone, memory: { name: "memory" } as never, proposals: newProposals(now), now });
  const create = edits.tools.find((x) => x.name === "vault_create_note")!;
  const append = edits.tools.find((x) => x.name === "vault_append_section")!;
  let invoked = 0;
  const counted: ChatTool = { ...create, run: (a, ctx) => (invoked++, create.run(a, ctx)) };
  assert.equal(counted.readOnly, undefined, "a vault write is not read-only");

  const model = scripted((_s, n) => (n === 0 ? { text: "", calls: [call("vault_create_note", { path: "Tasks/deadline-check.md", content: "# Check\n" })] } : say("ok")));
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model, proposals: newProposals(now), budget: 1_000_000, toolDeadlineMs: 300, abortGraceMs: GRACE, onLateTool: () => {} });
  const t = threads.create("vault");
  const head0 = fx.remoteHead();
  const out = await svc.turn(t.id, "write the note", { memory: [], limits: [], tools: [counted], isOwner: true });
  assert.match(out.error ?? "", /vault_create_note did not finish within 300 ms.*outcome is UNKNOWN/);
  assert.equal(threads.isBusy(t.id), false, "the thread is free while the push is still held");
  assert.equal(threads.get(t.id)!.messages[1]!.calls![0]!.outcomeUnknown, true);
  assert.equal(fx.remoteHead(), head0, "nothing has landed yet");

  // The UI stopped waiting, but the clone's own lock did not: a second write queues behind the first instead of overlapping it.
  let secondDone = false;
  const second = append.run({ path: "Tasks/todo.md", heading: "# Todo", text: "- [ ] two" }).then((r) => ((secondDone = true), r));
  await wait(200);
  assert.equal(secondDone, false, "the second write waits for the first one's lock");

  writeFileSync(gate, "open");
  const r2 = (await second) as { value: { status: string } };
  assert.equal(r2.value.status, "committed");
  assert.ok(existsSync(gate));
  const log = git(fx.root, "--git-dir", fx.remote, "log", "--format=%s", "main").trim().split("\n");
  assert.equal(log.filter((s) => /deadline-check/.test(s)).length, 1, `the cut-off write landed exactly once: ${log.join(" | ")}`);
  assert.match(fx.remoteFile("Tasks/deadline-check.md"), /# Check/);
  assert.equal(invoked, 1, "it was never retried");
  assert.equal(threads.get(t.id)!.messages.length, 2, "its late success wrote nothing to the thread");
});

test("confirmation rules are unchanged: after a timed-out turn, a launch is still only a proposal until Confirm", async () => {
  const stuck = stuckTool("lookup", { readOnly: true });
  const model = scripted((_s, n) => (n === 0 ? turnStep("lookup") : n === 1 ? { text: "", calls: [call("job_launch", { routine: "orbit", brief: "Do the thing; push only to orbit/<job-id>." })] } : say("proposed")));
  const r = rig({ model, extra: () => ({ prInspect: [stuck.tool], toolDeadlineMs: DEADLINE, abortGraceMs: GRACE }) });
  const t = await r.create("confirm");
  assert.equal((await r.send(t.id, "look")).status, 502);
  const res = await r.send(t.id, "launch it");
  assert.equal(res.status, 200);
  const card = res.data.thread.cards[0];
  assert.equal(card.state, "open");
  assert.equal(r.fired.length, 0, "nothing launched without a click");
});

test("the page and the model's thread digest never show a cut-off call as failed", async () => {
  const { readFileSync } = await import("node:fs");
  const { callState } = await import("../src/thread-context.ts");
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const block = html.match(/\/\/ <threads>([\s\S]*?)\/\/ <\/threads>/)![1]!;
  const page = new Function(`${block}; return callState;`)() as (c: unknown) => string;
  const unknown = { ok: false, interrupted: "timeout", abort: "requested", outcomeUnknown: true };
  const readTimeout = { ok: false, interrupted: "timeout", abort: "requested" };
  assert.equal(page(unknown), "outcome unknown, not retried");
  assert.equal(page(readTimeout), "timed out, no result");
  assert.equal(page({ ok: false }), "failed");
  assert.equal(callState(unknown as never), "outcome unknown (not retried)");
  assert.equal(callState({ ok: false, interrupted: "cancelled" }), "cancelled, no result");
  assert.equal(callState({ ok: false }), "failed");
});
