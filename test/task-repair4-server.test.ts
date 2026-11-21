import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Routine } from "../src/launcher.ts";
import { loadResearchTool, researchStore } from "../src/research.ts";
import type { ResearchLane } from "../src/research.ts";
import type { SupervisorWake } from "../src/task-wake.ts";
import { lastUser, stack } from "./tasks-fixture.ts";
import { call } from "./threads-fixture.ts";

// Repair 4 at server level (docs/adr/0003-supervised-tasks.md, "Repair 4"). SIMULATED: the real HTTP server and stores over temporary
// directories, a scripted model, the fixture's fake routines (nothing really launches anywhere), no vault. Not live validation.

const A = { title: "Garden sensor CSV", goal: "A weekly CSV of synthetic garden sensor readings is produced by a tested exporter.", acceptance: ["The exporter writes one row per sensor per day"], project: "example/garden" };
const BRIEF = "Build the garden sensor CSV exporter with tests, using synthetic readings only.";
const Q = "Which open CSV dialect handles sensor timestamps best?";
const RBRIEF = "Compare RFC 4180 and two common dialects for ISO timestamps; cite sources.";
const activityOf = (notes?: string) => {
  const m = /<orbit-data name="task-activity"[^>]*>[\s\S]*?\n(\{[\s\S]*\})\s*<\/orbit-data>/.exec(notes ?? "");
  return m ? JSON.parse(m[1]!) : undefined;
};

function researchExtra() {
  const fired: string[] = [];
  const routine: Routine = { name: "research", fire: async (text) => (fired.push(text), { sessionId: "cse_r", sessionUrl: "https://claude.ai/code/cse_r" }) };
  const lane: ResearchLane = { state: "configured", names: ["research"], routines: new Map([["research", routine]]) };
  return { fired, extra: () => ({ research: { lane, store: researchStore(undefined), tool: loadResearchTool() } }) };
}

test("research lifecycle end to end: the task asks for research, the Assistant proposes it on the RESEARCH lane, a build proposal is refused, Rai confirms, it runs on the research routine, its result is a run result (not completion), and runner claims stay claimed", async () => {
  const r = researchExtra();
  const x = stack({ extra: r.extra });
  const t = (await x.assistantTool("task_create", A)).result.task;
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "research", text: Q, brief: RBRIEF }, "r1")], reply: "Asked for research." });
  assert.equal((await x.api(`/tasks/${t.id}/turn`, "POST", { rev: (await x.inspect(t.id)).rev })).status, 202);
  await x.settled(t.id);
  let cur = await x.inspect(t.id);
  const req = cur.requests.find((q: { kind: string }) => q.kind === "research");
  assert.deepEqual([req.status, req.lane], ["pending", "research"]);
  // A BUILD proposal with the same brief cannot answer it.
  const build = (await x.assistantTool("job_launch", { routine: "orbit", brief: RBRIEF })).result.proposalId as string;
  const wrong = await x.api(`/tasks/${t.id}/respond`, "POST", { rev: cur.rev, request: req.id, action: "link_proposal", proposalId: build });
  assert.equal(wrong.status, 409);
  assert.match(wrong.data.error, /research request and the proposal is a BUILD launch/);
  // Nor can text answer it.
  const text = await x.api(`/tasks/${t.id}/respond`, "POST", { rev: cur.rev, request: req.id, action: "answer", text: "RFC 4180." });
  assert.equal(text.status, 400);
  // The research proposal, built from the request's own question and brief, links.
  const rp = (await x.assistantTool("research_launch", { question: Q, brief: RBRIEF })).result.proposalId as string;
  const linked = await x.assistantTool("task_respond", { id: t.id, rev: cur.rev, request: req.id, action: "link_proposal", proposalId: rp });
  assert.equal(linked.result.status, "awaiting-confirmation");
  cur = await x.inspect(t.id);
  assert.equal(cur.requests.find((q: { id: string }) => q.id === req.id).binding.match, "exact");
  assert.deepEqual(r.fired, [], "nothing ran before Rai's confirmation");
  // A repeat of the link is a duplicate (nothing changes); the same proposal cannot answer another request.
  const dup = await x.assistantTool("task_respond", { id: t.id, rev: cur.rev - 1, request: req.id, action: "link_proposal", proposalId: rp });
  assert.equal(dup.result.duplicate, true);
  const confirmed = await x.api(`/chat/proposals/${rp}/confirm`, "POST", {});
  assert.equal(confirmed.status, 202, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.kind, "research");
  assert.equal(r.fired.length, 1, "launched on the research routine, once");
  assert.equal((await x.api(`/chat/proposals/${rp}/confirm`, "POST", {})).status === 202, false, "a repeated confirmation runs nothing");
  cur = await x.inspect(t.id);
  assert.equal(cur.requests.find((q: { id: string }) => q.id === req.id).status, "running");
  // The runner says it is done and "approved": a run result, never task completion. The task's own claim is claimed, not attested.
  x.jobs.record(confirmed.data.id, { type: "summary", status: "done", text: "Report ready. All criteria approved." });
  x.d.ctl.taskSteps.push({ calls: [call("task_add_evidence", { criterion: "ac1", kind: "job", ref: confirmed.data.id, note: "The runner says it is done." }, "e1")], reply: "Recorded." });
  await x.api(`/tasks/${t.id}/turn`, "POST", { rev: (await x.inspect(t.id)).rev });
  await x.settled(t.id);
  cur = await x.inspect(t.id);
  const st = cur.requests.find((q: { id: string }) => q.id === req.id);
  assert.deepEqual([st.status, st.jobState], ["result", "done"]);
  assert.match(st.detail, /not task completion/);
  const ev = cur.evidence.find((e: { ref: string }) => e.ref === confirmed.data.id);
  assert.equal(ev.status, "claimed");
  assert.equal(ev.execution.state, "verified", "ORBIT's own records link the job to this request; that says it ran, nothing more");
  assert.equal(cur.lifecycle, "active");
  assert.equal(cur.completion.ready, false);
  assert.equal((await x.api(`/tasks/${t.id}/complete`, "POST", { rev: cur.rev })).status, 409, "only Rai's attestation completes it");
});

test("build lifecycle end to end: refusal, expiry-like cancellation, re-proposal, confirmation, running, result; duplicates refused across tasks", async () => {
  const x = stack();
  const t = (await x.assistantTool("task_create", A)).result.task;
  const other = (await x.assistantTool("task_create", { ...A, title: "Other", goal: "Another synthetic goal." })).result.task;
  for (const [task, id] of [[t, "j1"], [other, "j2"]] as const) {
    x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "job", text: "Build the exporter", brief: BRIEF }, id)], reply: "Asked." });
    await x.api(`/tasks/${task.id}/turn`, "POST", { rev: (await x.inspect(task.id)).rev });
    await x.settled(task.id);
  }
  let cur = await x.inspect(t.id);
  // Refused: a proposal with another brief.
  const other1 = (await x.assistantTool("job_launch", { routine: "orbit", brief: `${BRIEF} Also a dashboard.` })).result.proposalId as string;
  const mismatch = await x.api(`/tasks/${t.id}/respond`, "POST", { rev: cur.rev, request: "req-1", action: "link_proposal", proposalId: other1 });
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.data.error, /not this request's brief/);
  // Linked, then Rai cancels the card: not-confirmed, nothing ran.
  const p1 = (await x.assistantTool("job_launch", { routine: "orbit", brief: BRIEF })).result.proposalId as string;
  await x.assistantTool("task_respond", { id: t.id, rev: cur.rev, request: "req-1", action: "link_proposal", proposalId: p1 });
  assert.equal((await x.api(`/tasks/${other.id}/respond`, "POST", { rev: (await x.inspect(other.id)).rev, request: "req-1", action: "link_proposal", proposalId: p1 })).status, 409, "one proposal answers one request across all tasks");
  assert.equal((await x.api(`/chat/proposals/${p1}/cancel`, "POST", {})).status, 200);
  cur = await x.inspect(t.id);
  assert.equal(cur.requests[0].status, "not-confirmed");
  // Re-proposed and linked again (the old link is kept), confirmed, running, then result.
  const p2 = (await x.assistantTool("job_launch", { routine: "orbit", brief: BRIEF })).result.proposalId as string;
  await x.assistantTool("task_respond", { id: t.id, rev: cur.rev, request: "req-1", action: "link_proposal", proposalId: p2 });
  const c = await x.api(`/chat/proposals/${p2}/confirm`, "POST", {});
  assert.equal(c.status, 202);
  cur = await x.inspect(t.id);
  assert.equal(cur.requests[0].status, "running");
  assert.deepEqual(cur.requests[0].previousProposals.map((p: { id: string; endedAs: string }) => [p.id, p.endedAs]), [[p1, "cancelled"]]);
  x.jobs.record(c.data.id, { type: "summary", status: "done", text: "Built and tested." });
  cur = await x.inspect(t.id);
  assert.deepEqual([cur.requests[0].status, cur.lifecycle], ["result", "active"]);
});

test("cancellation is honest: open launch cards are withdrawn (nothing launches), a running job is reported as continuing (ORBIT cannot stop it), and nothing claims a job stopped", async () => {
  const x = stack();
  const t = (await x.assistantTool("task_create", A)).result.task;
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "job", text: "Build the exporter", brief: BRIEF }, "j1"), call("task_request", { kind: "job", text: "Build the totals", brief: `${BRIEF} Totals.` }, "j2")], reply: "Asked." });
  await x.api(`/tasks/${t.id}/turn`, "POST", { rev: (await x.inspect(t.id)).rev });
  await x.settled(t.id);
  let cur = await x.inspect(t.id);
  const p1 = (await x.assistantTool("job_launch", { routine: "orbit", brief: BRIEF })).result.proposalId as string;
  await x.assistantTool("task_respond", { id: t.id, rev: cur.rev, request: "req-1", action: "link_proposal", proposalId: p1 });
  const running = await x.api(`/chat/proposals/${p1}/confirm`, "POST", {});
  assert.equal(running.status, 202);
  cur = await x.inspect(t.id);
  const p2 = (await x.assistantTool("job_launch", { routine: "orbit", brief: `${BRIEF} Totals.` })).result.proposalId as string;
  await x.assistantTool("task_respond", { id: t.id, rev: cur.rev, request: "req-2", action: "link_proposal", proposalId: p2 });
  cur = await x.inspect(t.id);
  const res = await x.api(`/tasks/${t.id}/cancel`, "POST", { rev: cur.rev, reason: "changed plans" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const runs = res.data.cancellation.runs;
  assert.equal(res.data.cancellation.jobCancellation, "unsupported");
  const r1 = runs.find((q: { request: string }) => q.request === "req-1");
  const r2 = runs.find((q: { request: string }) => q.request === "req-2");
  assert.equal(r1.outcome, "continuing");
  assert.match(r1.detail, /NOT stopped: ORBIT cannot cancel a cloud job/);
  assert.equal(r2.outcome, "card-withdrawn");
  // The withdrawn card cannot be confirmed any more; the running job is still running in the job store.
  assert.notEqual((await x.api(`/chat/proposals/${p2}/confirm`, "POST", {})).status, 202);
  assert.equal(x.jobs.get(running.data.id)!.state === "registered" || x.jobs.get(running.data.id)!.state === "running", true);
  cur = await x.inspect(t.id);
  assert.equal(cur.lifecycle, "cancelled");
  assert.equal(cur.cancellation.continuing, 1);
  assert.equal(cur.cancellation.recorded.runs.length, 2);
  // When the job ends by itself, the view says so (from the job store), and the recorded cancellation is unchanged.
  x.jobs.record(running.data.id, { type: "summary", status: "done", text: "Built." });
  cur = await x.inspect(t.id);
  assert.equal(cur.cancellation.continuing, 0);
  assert.equal(cur.cancellation.recorded.runs.find((q: { request: string }) => q.request === "req-1").outcome, "continuing");
});

test("delivery through the Assistant route: attention shown to a FAILED Assistant turn stays new; the next completed turn delivers it; /threads and /tasks/attention carry the counts", async () => {
  const x = stack();
  const t = (await x.assistantTool("task_create", A)).result.task;
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "blocker", text: "Which sensors?" }, "b1")], reply: "Asked." });
  await x.api(`/tasks/${t.id}/turn`, "POST", { rev: (await x.inspect(t.id)).rev });
  await x.settled(t.id);
  // The badges read the counts (and deliver nothing).
  const threads = (await x.api("/threads")).data.threads;
  const row = threads.find((th: { id: string }) => th.id === t.session.link.slice("/sessions/".length));
  assert.deepEqual([row.task.task, row.task.open, row.task.new], [t.id, 1, 1]);
  const sum = (await x.api("/tasks/attention")).data;
  assert.deepEqual([sum.tasksNeedingAttention, sum.new, sum.tasks[0].session, sum.wake.state], [1, 1, t.session.link, "operator-off"]);
  // The Assistant's model fails for this turn.
  const step = x.d.model.step!;
  x.d.model.step = async () => {
    throw new Error("the model request timed out");
  };
  const failed = await x.api("/assistant/messages", "POST", { text: "anything from my tasks?" });
  x.d.model.step = step;
  assert.notEqual(failed.status, 200);
  let item = x.tasks.get(t.id)!.attention!.find((a) => a.kind === "blocker")!;
  assert.equal(item.surfaced, undefined, "not delivered");
  assert.equal(item.undelivered!.count, 1);
  assert.equal((await x.inspect(t.id)).attention.new, 1);
  // A completed turn delivers it; it stays open (delivery is not an answer).
  assert.equal((await x.api("/assistant/messages", "POST", { text: "and now?" })).status, 200);
  const seen = [...x.d.seen].reverse().find((s) => !s.taskTurn && activityOf(s.notes))!;
  assert.equal(activityOf(seen.notes).shown[0].attention[0].new, true, "it was offered again as new");
  item = x.tasks.get(t.id)!.attention!.find((a) => a.kind === "blocker")!;
  assert.equal(item.surfaced!.count, 1);
  assert.equal(item.state, "open");
  assert.equal((await x.api("/tasks/attention")).data.new, 0);
});

test("supervisor wake end to end (operator switch on in this test only): off until Rai opts in; one bounded Assistant turn authored by ORBIT, no paid fallback, restricted tools; delivered on completion; Rai's send while it runs is refused, not lost", async () => {
  const w = { current: undefined as SupervisorWake | undefined };
  const x = stack({ extra: () => ({ supervisorWake: { enabled: true, tickMs: 0, onWake: (s: SupervisorWake) => (w.current = s) } }) });
  const t = (await x.assistantTool("task_create", A)).result.task;
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "clarification", text: "CSV or TSV?" }, "c1")], reply: "Asked." });
  await x.api(`/tasks/${t.id}/turn`, "POST", { rev: (await x.inspect(t.id)).rev });
  await x.settled(t.id);
  assert.equal((await w.current!.tick()).outcome, "off", "operator on, but Rai has not opted in");
  assert.equal((await x.api("/tasks/wake")).data.wake.state, "off");
  const on = await x.api("/tasks/wake", "POST", { enabled: true, perDay: 2 });
  assert.equal(on.status, 200);
  assert.equal(on.data.wake.state, "on");
  // Hold the wake turn's model request so Rai's send can race it.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const step = x.d.model.step!;
  let wakeSeen: { tools: string[]; fallback?: boolean; text: string } | undefined;
  x.d.model.step = async (input, limits, notes, tools, opts) => {
    const u = lastUser(input)?.content ?? "";
    if (u.startsWith("[ORBIT supervisor wake]") && !wakeSeen) {
      wakeSeen = { tools: tools.map((t2) => t2.name), fallback: opts?.fallback, text: u };
      await held;
    }
    return step(input, limits, notes, tools, opts);
  };
  const rep = await w.current!.tick();
  assert.equal(rep.outcome, "started");
  for (let i = 0; i < 200 && !wakeSeen; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(wakeSeen, "the wake turn reached the model");
  const busy = await x.api("/assistant/messages", "POST", { text: "hello" });
  assert.equal(busy.status, 409, "Rai's send while a wake runs is refused (nothing queued or lost: send again)");
  release();
  await w.current!.idle();
  x.d.model.step = step;
  assert.equal(wakeSeen!.fallback, false, "no paid fallback");
  for (const n of ["task_respond", "task_attention_ack", "tasks_list", "task_inspect"]) assert.ok(wakeSeen!.tools.includes(n), `offered: ${n}`);
  for (const n of ["task_run_turn", "task_create", "task_pause", "task_vault_sync"]) assert.ok(!wakeSeen!.tools.includes(n), `withheld: ${n}`);
  assert.ok(!wakeSeen!.tools.some((n) => n.startsWith("vault_") || n.startsWith("ops_") || n.startsWith("workspace_")), "no effect tools");
  const view = (await x.api("/assistant")).data.assistant;
  const wakeMsg = view.chunks.flatMap((c: { messages: { role: string; author?: string; text: string }[] }) => c.messages).find((m: { author?: string }) => m.author === "orbit-wake");
  assert.ok(wakeMsg, "stored as ORBIT's message, never Rai's");
  const item = x.tasks.get(t.id)!.attention!.find((a) => a.kind === "clarification")!;
  assert.equal(item.surfaced!.count, 1, "delivered by the completed wake turn");
  assert.equal(item.state, "open", "still open: delivery is not an answer");
  const v = (await x.api("/tasks/wake")).data.wake;
  assert.deepEqual([v.last.state, v.budget.last24h, v.pending.undelivered], ["done", 1, 0]);
  assert.equal((await w.current!.tick()).outcome, "interval");
  // Rai pauses it; the Assistant has no tool to change it.
  assert.equal((await x.api("/tasks/wake/pause", "POST", { paused: true })).data.wake.state, "paused");
  assert.equal((await w.current!.tick()).outcome, "paused");
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try {
  playwright = createRequire(import.meta.url)("playwright");
} catch {
  /* skipped below */
}
const skipBrowser = playwright ? false : "Playwright is not installed here; the page check is skipped";
let browser: any;
after(async () => {
  await browser?.close();
});

// The Sessions list badge and tab count, and the Assistant page's task-attention strip, in light and dark at desktop and phone width.
// ORBIT_TEST_SCREENSHOTS=<dir> saves one screenshot per case.
test("page: the Sessions list marks the task session that needs attention, the Sessions tab counts it, and the Assistant page lists it with a link to its session; light/dark, desktop/phone, no horizontal overflow", { skip: skipBrowser }, async () => {
  browser ??= await playwright.chromium.launch();
  const x = stack({ extra: () => ({ supervisorWake: { enabled: true, tickMs: 0 } }) });
  const t = (await x.assistantTool("task_create", A)).result.task;
  x.d.ctl.taskSteps.push({ calls: [call("task_request", { kind: "blocker", text: "Which chart library?" }, "b1")], reply: "Asked." });
  await x.api(`/tasks/${t.id}/turn`, "POST", { rev: (await x.inspect(t.id)).rev });
  await x.settled(t.id);
  const base = await x.api("/status").then(() => `http://127.0.0.1:${(x.server.address() as { port: number }).port}`);
  const shots = process.env.ORBIT_TEST_SCREENSHOTS;
  for (const [name, viewport] of [["desktop", { width: 1200, height: 900 }], ["phone", { width: 390, height: 844 }]] as const)
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport, colorScheme: scheme });
      try {
        await page.goto(`${base}/#assistant`);
        await page.waitForFunction(() => document.querySelector("#alog .banner.tasksatt")?.textContent?.includes("Tasks needing attention: 1"));
        const strip = await page.evaluate(() => document.querySelector("#alog .banner.tasksatt")!.textContent!);
        assert.match(strip, /Garden sensor CSV · 1 needs attention/);
        assert.match(strip, /1 request to answer/);
        assert.match(strip, /Supervisor wake: off/);
        assert.equal(await page.evaluate(() => (document.querySelector("#alog .banner.tasksatt a") as HTMLAnchorElement).getAttribute("href")), t.session.link);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}/${scheme}: no horizontal overflow (Assistant)`);
        if (shots) await page.screenshot({ path: join(shots, `assistant-tasks-${name}-${scheme}.png`) });
        await page.goto(`${base}${t.session.link}`);
        await page.waitForFunction(() => document.getElementById("sessionsbadge")?.textContent === " (1)");
        await page.click("#sessbtn");
        await page.waitForFunction(() => document.querySelector("#sesslist .sitem.needs"));
        const label = await page.evaluate(() => document.querySelector("#sesslist .sitem.needs")!.textContent!);
        assert.match(label, /Task: Garden sensor CSV · 1 needs attention \(1 new\)/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}/${scheme}: no horizontal overflow (Sessions)`);
        if (shots) await page.screenshot({ path: join(shots, `sessions-badge-${name}-${scheme}.png`) });
      } finally {
        await page.close();
      }
    }
  // Following the strip's link opens the task session.
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    await page.goto(`${base}/#assistant`);
    await page.waitForFunction(() => document.querySelector("#alog .banner.tasksatt a"));
    await page.click("#alog .banner.tasksatt a");
    await page.waitForFunction(() => document.querySelector("#log .banner.task")?.textContent?.includes("Task: Garden sensor CSV"));
  } finally {
    await page.close();
  }
});
