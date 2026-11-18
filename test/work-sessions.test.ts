import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { assistantStore } from "../src/assistant-store.ts";
import { jobs as jobRegistry, type Job } from "../src/jobs.ts";
import { RoutineFireError } from "../src/launcher.ts";
import type { ControlRepo, Routine } from "../src/launcher.ts";
import type { Item } from "../src/model.ts";
import { notifier } from "../src/notify.ts";
import { renderDigest } from "../src/session-digest.ts";
import { assistantAdapter, chatAdapter, parseSessionId, sessionRegistry, sessionTools, workAdapter } from "../src/sessions.ts";
import { jsonStore, type Store } from "../src/store.ts";
import { threadStore } from "../src/threads.ts";
import { GOAL_NOTE, type WorkBackend, workFile, workSessions } from "../src/work-sessions.ts";
import { call, rig, say, scripted } from "./threads-fixture.ts";

// Session awareness slice 4 (docs/adr/0002-work-sessions.md): work sessions, run links and authoritative origin tracking through
// proposal, confirmation and launch. Offline: temp state directories, a scripted model, a fake control repo and routine.

const outputsOf = (items: Item[]) => items.flatMap((i) => ("type" in i && i.type === "function_call_output" ? [JSON.parse(i.output)] : []));
const BRIEF = (n: string) => `Build feature ${n} with tests and docs. Push only to orbit/<job-id>; never open a PR; end with PR title and PR body; run typecheck and tests; no secrets.`;

// A scripted model driven by the user message: "launch: X" proposes a launch; "tool: name {json}" calls a session tool.
const driver = () =>
  scripted((seen) => {
    const last = (seen.input.at(-1) as { content?: string })?.content ?? "";
    if (last.startsWith("launch: ")) return { text: "", calls: [call("job_launch", { routine: "orbit", brief: BRIEF(last.slice(8)) })] };
    const m = /^tool: (\w+) (.*)$/.exec(last);
    if (m) return { text: "", calls: [call(m[1]!, JSON.parse(m[2]!), `c_${m[1]}`)] };
    return say("ok");
  });

type StackOpts = { dir?: string; now?: () => Date; backend?: WorkBackend; routines?: Map<string, Routine>; control?: ControlRepo; jobsOverride?: ReturnType<typeof jobRegistry> };
function stack(o: StackOpts = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "orbit-work-"));
  const work = workSessions(o.backend ?? workFile(dir), o.now);
  const model = driver();
  const x = rig({
    dir,
    model,
    now: o.now,
    extra: () => ({ assistantDir: join(dir, "assistant"), workSessions: work, ...(o.routines ? { routines: o.routines } : {}), ...(o.control ? { control: o.control } : {}), ...(o.jobsOverride ? { jobs: o.jobsOverride } : {}) }),
  });
  const propose = async (threadId: string, name: string) => {
    const r = await x.send(threadId, `launch: ${name}`);
    return r.data.thread.cards.at(-1) as { id: string; state: string };
  };
  const proposeInAssistant = async (name: string) => {
    const r = await x.api("/assistant/messages", "POST", { text: `launch: ${name}` });
    return r.data.assistant.chunks.flatMap((c: { cards: { id: string }[] }) => c.cards).at(-1) as { id: string };
  };
  const confirm = (id: string, body?: unknown) => x.api(`/chat/proposals/${id}/confirm`, "POST", body);
  const assistantTool = async (name: string, args: unknown) => {
    await x.api("/assistant/messages", "POST", { text: `tool: ${name} ${JSON.stringify(args)}` });
    return outputsOf(model.seen.at(-1)!.input).at(-1);
  };
  return { ...x, dir, work, model, propose, proposeInAssistant, confirm, assistantTool };
}

const fileOf = (dir: string) => join(dir, "work-sessions.json");
const snapshot = (dir: string) => {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return files;
};

// ---- origin through proposal, confirmation and launch ------------------------------------------------------------------------

test("Chat origin: proposal -> confirm -> launch records a new work session, a launched link and the job's back-reference", async () => {
  const x = stack();
  const t = await x.create("Exporter");
  const card = await x.propose(t.id, "exporter");
  assert.equal(x.proposals.peek(card.id)!.origin, `chat:${t.id}`);
  // A pending proposal is not a run: nothing is recorded yet.
  assert.equal(x.work.links().length, 0);
  assert.equal(x.jobs.all().length, 0);
  const r = await x.confirm(card.id);
  assert.equal(r.status, 202);
  const job = x.jobs.all()[0]!;
  assert.equal(r.data.id, job.id);
  assert.match(r.data.work.workSession, /^work:[0-9a-f-]{36}$/);
  assert.equal(r.data.work.origin, `chat:${t.id}`);
  assert.equal(r.data.work.launch.state, "launched");
  assert.equal(r.data.work.attachment, "new");
  assert.deepEqual(job.work, { proposal: card.id, workSession: r.data.work.workSession, origin: `chat:${t.id}` });
  // The work session is distinct from the job id and from the runner's cloud session id.
  assert.notEqual(r.data.work.workSession, job.id);
  assert.notEqual(r.data.work.workSession, job.launch?.sessionId);
  const ws = x.work.session(r.data.work.workSession)!;
  assert.deepEqual(ws.origin, { session: `chat:${t.id}`, basis: "server-turn" });
  // Only references are stored: no brief text, no transcript.
  const raw = readFileSync(fileOf(x.dir), "utf8");
  assert.doesNotMatch(raw, /Build feature exporter/);
  assert.equal(x.fired.length, 1);
});

test("Assistant origin: a launch proposed in the Assistant is recorded as assistant:assistant", async () => {
  const x = stack();
  const card = await x.proposeInAssistant("assistant-work");
  const r = await x.confirm(card.id);
  assert.equal(r.status, 202);
  assert.equal(r.data.work.origin, "assistant:assistant");
  assert.equal(x.jobs.all()[0]!.work!.origin, "assistant:assistant");
});

test("confirmation from another context (the Jobs page list) keeps the original origin; request-body origin text is ignored", async () => {
  const x = stack();
  const t = await x.create("Origin chat");
  const card = await x.propose(t.id, "other-page");
  // The Jobs page lists open proposals and confirms by id, with no thread context at all.
  const listed = (await x.api("/chat/proposals")).data.proposals.find((p: { id: string }) => p.id === card.id);
  assert.equal(listed.origin, `chat:${t.id}`);
  const r = await x.confirm(card.id, { origin: "assistant:assistant", originSession: "chat:00000000-0000-4000-8000-000000000000" });
  assert.equal(r.status, 202);
  assert.equal(r.data.work.origin, `chat:${t.id}`);
});

test("a model cannot set a proposal's origin, and a proposal bound to one conversation never gets a card in another", () => {
  const p = newProposals();
  const made = p.propose({ kind: "job_launch", routine: "orbit", brief: "b", origin: "assistant:assistant" } as never);
  assert.equal(made.origin, undefined);
  assert.equal(p.bind(made.id, "chat:11111111-1111-4111-8111-111111111111"), true);
  assert.equal(p.bind(made.id, "chat:11111111-1111-4111-8111-111111111111"), true);
  assert.equal(p.bind(made.id, "assistant:assistant"), false);
  assert.equal(p.peek(made.id)!.origin, "chat:11111111-1111-4111-8111-111111111111");
});

test("an origin that disagrees with the card's conversation is refused before anything is spent", async () => {
  const x = stack();
  const t = await x.create("Real origin");
  const card = await x.propose(t.id, "mismatch");
  // Simulate a corrupted in-memory binding: the card is in t, the proposal claims the Assistant.
  const p = x.proposals.peek(card.id)!;
  (p as { origin?: string }).origin = "assistant:assistant";
  const r = await x.confirm(card.id);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /does not match/);
  assert.ok(x.proposals.peek(card.id), "the proposal is still open");
  assert.equal(x.jobs.all().length, 0);
  assert.equal(x.work.links().length, 0);
});

test("legacy /chat route: no stored card, so the origin is explicitly unknown and the launch cannot be attached to anything", async () => {
  const x = stack();
  const r = await x.api("/chat", "POST", { messages: [{ role: "user", content: "launch: legacy" }] });
  assert.equal(r.status, 200);
  const pid = r.data.proposals[0].id;
  assert.equal(x.proposals.peek(pid)!.origin, undefined);
  const c = await x.confirm(pid);
  assert.equal(c.status, 202);
  assert.equal(c.data.work.origin, null);
  const ws = x.work.session(c.data.work.workSession)!;
  assert.equal(ws.origin.session, null);
  assert.equal(ws.origin.basis, "unknown");
  // Another legacy proposal cannot attach to it: an unknown origin never matches.
  const r2 = await x.api("/chat", "POST", { messages: [{ role: "user", content: "launch: legacy-two" }] });
  const a = await x.confirm(r2.data.proposals[0].id, { attach: { workSession: ws.id, as: "follow-up" } });
  assert.equal(a.status, 409);
});

// ---- separation, reuse, retries ----------------------------------------------------------------------------------------------

test("two launches from one conversation are two work sessions; an explicit follow-up from the same conversation reuses one", async () => {
  const x = stack();
  const t = await x.create("Busy chat");
  const a = await x.confirm((await x.propose(t.id, "one")).id);
  const b = await x.confirm((await x.propose(t.id, "two")).id);
  assert.notEqual(a.data.work.workSession, b.data.work.workSession);
  const c = await x.confirm((await x.propose(t.id, "three")).id, { attach: { workSession: a.data.work.workSession, as: "follow-up" } });
  assert.equal(c.status, 202);
  assert.equal(c.data.work.workSession, a.data.work.workSession);
  assert.equal(c.data.work.attachment, "follow-up");
  assert.equal(x.work.sessions().length, 2);
  assert.equal(x.work.linksOf(a.data.work.workSession).length, 2);
});

test("attaching to another conversation's work session is refused before the job store is read; the proposal stays open", async () => {
  const x = stack();
  const t1 = await x.create("First");
  const t2 = await x.create("Second");
  const a = await x.confirm((await x.propose(t1.id, "first")).id);
  const card = await x.propose(t2.id, "second");
  let reads = 0;
  const all = x.jobs.all.bind(x.jobs);
  (x.jobs as { all: () => Job[] }).all = () => (reads++, all());
  for (const attach of [
    { workSession: a.data.work.workSession, as: "follow-up" },
    { workSession: a.data.work.workSession, as: "retry", retryOf: a.data.id },
    { workSession: "work:00000000-0000-4000-8000-000000000000", as: "follow-up" },
  ]) {
    const r = await x.confirm(card.id, { attach });
    assert.equal(r.status, 409, JSON.stringify(r.data));
  }
  assert.equal(reads, 0, "no job store read for a refused cross-session link");
  for (const attach of [{ workSession: "../etc/passwd", as: "follow-up" }, { workSession: a.data.work.workSession, as: "merge" }, "x", { workSession: a.data.work.workSession, as: "follow-up", origin: "chat:x" }]) {
    assert.equal((await x.confirm(card.id, { attach })).status, 400);
  }
  assert.ok(x.proposals.peek(card.id));
  assert.equal(x.jobs.all().length, 1);
  assert.equal((await x.confirm(card.id)).status, 202);
});

test("retry: a failed run can be retried as a new run in the same work session; the old run is not changed; a running one cannot", async () => {
  let fail = true;
  const fired: string[] = [];
  // A provider refusal (4xx) is a definitive failure: no session can exist, so a retry cannot run the same work twice.
  const routine: Routine = { name: "orbit", fire: async (text) => { if (fail) throw new RoutineFireError("Routine orbit fire returned HTTP 401", "rejected", 401); fired.push(text); return { sessionId: "cse_2", sessionUrl: "https://claude.ai/code/cse_2" }; } };
  const x = stack({ routines: new Map([["orbit", routine]]) });
  const t = await x.create("Retry chat");
  const first = await x.confirm((await x.propose(t.id, "flaky")).id);
  assert.equal(first.status, 502);
  assert.equal(first.data.work.launch.state, "failed");
  const failedJob = first.data.job.id;
  const before = JSON.stringify(x.jobs.get(failedJob));
  fail = false;
  const second = await x.confirm((await x.propose(t.id, "flaky again")).id, { attach: { workSession: first.data.work.workSession, as: "retry", retryOf: failedJob } });
  assert.equal(second.status, 202);
  assert.equal(second.data.work.workSession, first.data.work.workSession);
  assert.equal(second.data.work.retryOf, failedJob);
  assert.notEqual(second.data.id, failedJob);
  assert.equal(JSON.stringify(x.jobs.get(failedJob)), before, "the failed run is not mutated");
  // A run that is registered/running cannot be "retried".
  const third = await x.confirm((await x.propose(t.id, "not yet")).id, { attach: { workSession: first.data.work.workSession, as: "retry", retryOf: second.data.id } });
  assert.equal(third.status, 409);
  assert.equal(x.work.linksOf(first.data.work.workSession).length, 2);
});

// ---- idempotency ------------------------------------------------------------------------------------------------------------

test("repeated and concurrent confirmations launch once; repeats answer from the record with the same work link", async () => {
  const x = stack();
  const t = await x.create("Clicky");
  const card = await x.propose(t.id, "once");
  const results = await Promise.all(Array.from({ length: 6 }, () => x.confirm(card.id)));
  const ok = results.filter((r) => r.status === 202);
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.every((r) => r.status === 202 || r.status === 409 || r.status === 404));
  assert.equal(x.jobs.all().length, 1);
  assert.equal(x.fired.length, 1);
  assert.equal(x.work.links().length, 1);
  const again = await x.confirm(card.id);
  assert.equal(again.status, 409);
  assert.equal(again.data.work.workSession, ok[0]!.data.work.workSession);
  assert.equal(again.data.outcome.jobId, x.jobs.all()[0]!.id);
});

test("expired, cancelled and refused proposals record no run", async () => {
  let clock = new Date("2026-11-15T10:00:00.000Z");
  const x = stack({ now: () => clock });
  const t = await x.create("Expiry");
  const expired = await x.propose(t.id, "late");
  clock = new Date(clock.getTime() + 31 * 60_000);
  const r = await x.confirm(expired.id);
  assert.equal(r.status, 404);
  assert.equal(r.data.state, "expired");
  const cancelled = await x.propose(t.id, "cancel me");
  assert.equal((await x.api(`/chat/proposals/${cancelled.id}/cancel`, "POST")).status, 200);
  assert.equal((await x.confirm(cancelled.id)).status, 409);
  assert.equal(x.work.links().length, 0);
  assert.equal(x.jobs.all().length, 0);
});

test("an unknown routine at confirmation: not launched, no job, and the work session shows no active run", async () => {
  const routines = new Map<string, Routine>([["orbit", { name: "orbit", fire: async () => ({ sessionId: "s", sessionUrl: "u" }) }]]);
  const x = stack({ routines });
  const t = await x.create("Gone routine");
  const card = await x.propose(t.id, "routine removed");
  routines.delete("orbit");
  const r = await x.confirm(card.id);
  assert.equal(r.status, 400);
  assert.equal(r.data.work.launch.state, "not-launched");
  assert.equal(x.jobs.all().length, 0);
  const inspect = sessionRegistry({ adapters: [workAdapter(x.work, x.jobs)], jobs: x.jobs, work: x.work }).inspect({ isOwner: true }, r.data.work.workSession) as any;
  assert.equal(inspect.activity.state, "no-active-run");
  assert.equal(inspect.runs.items[0].native.status, "no-job");
});

// ---- partial writes, crashes and ambiguous launches --------------------------------------------------------------------------

test("the work record cannot be written: the launch is refused before any external step", async () => {
  const inner = workFile(mkdtempSync(join(tmpdir(), "orbit-work-inner-")));
  const backend: WorkBackend = { persisted: true, load: inner.load, save: () => { throw new Error("disk full"); } };
  const x = stack({ backend });
  const t = await x.create("Disk full");
  const card = await x.propose(t.id, "nope");
  const r = await x.confirm(card.id);
  assert.equal(r.status, 503);
  assert.match(r.data.error, /Nothing was sent/);
  assert.equal(x.jobs.all().length, 0);
  assert.equal(x.fired.length, 0);
  assert.equal(x.threads.card(card.id)!.state, "refused");
});

test("the launch result cannot be written: the link stays launching, and a restart repairs it from the job record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  const file = workFile(dir);
  let saves = 0;
  const backend: WorkBackend = { persisted: true, load: file.load, save: (f) => { saves++; if (saves === 2) throw new Error("write failed"); file.save(f); } };
  const x = stack({ dir, backend });
  const t = await x.create("Half written");
  const card = await x.propose(t.id, "half");
  const r = await x.confirm(card.id);
  assert.equal(r.status, 202);
  assert.match(r.data.work.note, /reconciled/);
  assert.equal(workSessions(workFile(dir)).linkOf(card.id)!.launch.state, "launching");
  x.close();
  const y = stack({ dir });
  const l = y.work.linkOf(card.id)!;
  assert.equal(l.launch.state, "launched");
  assert.equal(l.launch.job, x.jobs.all()[0]!.id);
  assert.ok(l.launch.repairedAt);
  assert.equal(y.fired.length, 0, "reconciliation never launches");
});

test("crash recovery: launching links are reconciled from the job store only; ambiguous fires are reported, never retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  const threads = threadStore(join(dir, "threads"));
  const t = threads.create("Crashy");
  const mid = threads.beginAssistant(t.id);
  const cards = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  for (const id of cards) {
    threads.addCard(t.id, mid, { id, kind: "job_launch", state: "open", createdAt: "2026-11-15T09:00:00.000Z", expiresAt: "2026-11-15T09:30:00.000Z", routine: "orbit", brief: "b" });
    threads.transitionCard(id, "open", "confirmed");
  }
  const origin = { session: `chat:${t.id}`, basis: "server-turn" as const };
  const w = workSessions(workFile(dir));
  const links = cards.map((id) => w.begin(id, origin, { attachment: "new" }));
  const jobs = jobRegistry(jsonStore(dir, "jobs", []), Buffer.alloc(32, 1), notifier(jsonStore(undefined, "n", [])));
  // Card 0: ORBIT stopped before registering a job. Card 1: registered, brief written, no fire result. Card 2: fired.
  jobs.register("orbit-amb", undefined, { work: { proposal: cards[1]!, workSession: links[1]!.workSession, origin: origin.session } });
  jobs.setLaunch("orbit-amb", { routine: "orbit", at: "2026-11-15T09:01:00.000Z", branch: "orbit/orbit-amb", briefCommit: "c0ffee" });
  jobs.register("orbit-ok", undefined, { work: { proposal: cards[2]!, workSession: links[2]!.workSession, origin: origin.session } });
  jobs.setLaunch("orbit-ok", { routine: "orbit", at: "2026-11-15T09:01:00.000Z", briefCommit: "c0ffee", sessionId: "cse_9", sessionUrl: "https://claude.ai/code/cse_9" });

  const x = stack({ dir });
  assert.equal(x.fired.length, 0);
  assert.equal(x.work.linkOf(cards[0]!)!.launch.state, "not-launched");
  assert.equal(x.work.linkOf(cards[1]!)!.launch.state, "ambiguous");
  assert.equal(x.work.linkOf(cards[1]!)!.launch.job, "orbit-amb");
  assert.match(x.work.linkOf(cards[1]!)!.launch.detail!, /not retried automatically/);
  assert.equal(x.work.linkOf(cards[2]!)!.launch.state, "launched");
  // Only metadata on the cards is repaired: ids from the job store, or a refusal where nothing was sent.
  assert.equal(x.threads.card(cards[0]!)!.state, "refused");
  assert.equal(x.threads.card(cards[1]!)!.outcome!.jobId, "orbit-amb");
  assert.equal(x.threads.card(cards[2]!)!.outcome!.jobId, "orbit-ok");
  // Jobs are not changed by reconciliation.
  assert.equal(x.jobs.get("orbit-amb")!.state, "registered");
  // The ambiguous run makes the work session's activity unknown, not active and not finished.
  const r = sessionRegistry({ adapters: [workAdapter(x.work, x.jobs)], jobs: x.jobs, work: x.work }).inspect({ isOwner: true }, links[1]!.workSession) as any;
  assert.equal(r.activity.state, "unknown");
  // A second start changes nothing more.
  x.close();
  const before = readFileSync(fileOf(dir), "utf8");
  stack({ dir });
  assert.equal(readFileSync(fileOf(dir), "utf8"), before);
});

test("the launcher throws (job store write failed): the job store is read, nothing is retried, and the outcome is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  const base = jsonStore<Job[]>(dir, "jobs", []);
  const broken: Store<Job[]> = { persisted: true, read: base.read, write: (v) => { if (v.some((j) => j.work)) throw new Error("EIO"); base.write(v); } };
  const jobs = jobRegistry(broken, Buffer.alloc(32, 1), notifier(jsonStore(undefined, "n", [])));
  const x = stack({ dir, jobsOverride: jobs });
  const t = await x.create("Broken jobs");
  const card = await x.propose(t.id, "throws");
  const r = await x.confirm(card.id);
  assert.equal(r.status, 500);
  assert.equal(r.data.outcome, "not-launched");
  assert.equal(r.data.work.launch.state, "not-launched");
  assert.equal(x.fired.length, 0);
});

test("a work-session file that cannot be read is never overwritten; launches are refused with the proposal left open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  writeFileSync(fileOf(dir), "{ not json");
  const x = stack({ dir });
  const t = await x.create("Corrupt");
  const card = await x.propose(t.id, "corrupt");
  const r = await x.confirm(card.id);
  assert.equal(r.status, 503);
  assert.ok(x.proposals.peek(card.id));
  assert.equal(readFileSync(fileOf(dir), "utf8"), "{ not json");
  writeFileSync(fileOf(dir), JSON.stringify({ v: 99, sessions: [], links: [] }));
  assert.equal(workSessions(workFile(dir)).status().state, "unavailable");
});

test("records this build does not understand are kept when the file is rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  const odd = { future: true, id: "work:zzz" };
  writeFileSync(fileOf(dir), JSON.stringify({ v: 1, sessions: [odd], links: [{ weird: 1 }] }));
  const w = workSessions(workFile(dir));
  assert.equal(w.sessions().length, 0);
  w.begin("p1", { session: "assistant:assistant", basis: "server-turn" }, { attachment: "new" });
  const raw = JSON.parse(readFileSync(fileOf(dir), "utf8"));
  assert.deepEqual(raw.sessions[0], odd);
  assert.deepEqual(raw.links[0], { weird: 1 });
});

// ---- restart readback, native state evolution, legacy -----------------------------------------------------------------------

test("restart: work sessions, links and origins read back unchanged and are inspectable through the Assistant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  const x = stack({ dir });
  const t = await x.create("Persisted");
  const r = await x.confirm((await x.propose(t.id, "persist")).id);
  const fileBefore = readFileSync(fileOf(dir), "utf8");
  x.close();
  const y = stack({ dir });
  assert.equal(readFileSync(fileOf(dir), "utf8"), fileBefore, "no rewrite at start when nothing needs repair");
  const list = await y.assistantTool("sessions_list", { kinds: ["work"] });
  assert.equal(list.ok, true);
  assert.equal(list.result.total, 1);
  assert.equal(list.result.sessions[0].id, r.data.work.workSession);
  assert.equal(list.result.sessions[0].work.origin.session, `chat:${t.id}`);
  const ins = await y.assistantTool("session_inspect", { id: r.data.work.workSession });
  assert.equal(ins.result.origin.session, `chat:${t.id}`);
  assert.equal(ins.result.origin.state, "found");
  assert.equal(ins.result.runs.items[0].id, `job:${r.data.id}`);
  assert.equal(ins.result.goal, GOAL_NOTE);
  // From the origin side too: the run carries its work session, and the work session is listed once.
  const chat = await y.assistantTool("session_inspect", { id: `chat:${t.id}` });
  assert.equal(chat.result.runs.total, 1);
  assert.equal(chat.result.runs.items[0].workSession, r.data.work.workSession);
  assert.equal(chat.result.workSessions.total, 1);
  // session_read on a work session is an explicit unsupported gap.
  const read = await y.assistantTool("session_read", { id: r.data.work.workSession });
  assert.equal(read.result.unsupported, true);
  assert.equal(read.result.messages, undefined);
});

test("native state evolution: runs move through the job store; ended runs never close the work session or claim success", async () => {
  const x = stack();
  const t = await x.create("Evolving");
  const a = await x.confirm((await x.propose(t.id, "evolve")).id);
  const ws = a.data.work.workSession;
  const reg = () => sessionRegistry({ adapters: [assistantAdapter(assistantStore(undefined)), chatAdapter(x.threads), workAdapter(x.work, x.jobs)], jobs: x.jobs, work: x.work });
  const activity = () => (reg().inspect({ isOwner: true }, ws) as any).activity;
  assert.equal(activity().state, "active");
  x.jobs.record(a.data.id, { type: "started" });
  assert.equal(activity().state, "active");
  x.jobs.record(a.data.id, { type: "summary", status: "failed", text: "broke" });
  assert.equal(activity().state, "no-active-run");
  assert.match(activity().basis, /not a claim that the work is finished/);
  const b = await x.confirm((await x.propose(t.id, "evolve 2")).id, { attach: { workSession: ws, as: "retry", retryOf: a.data.id } });
  assert.equal(b.status, 202);
  assert.equal(activity().state, "active");
  x.jobs.record(b.data.id, { type: "summary", status: "done", text: "ok" });
  const ins = reg().inspect({ isOwner: true }, ws) as any;
  assert.equal(ins.session.lifecycle, "open");
  assert.equal(ins.activity.state, "no-active-run");
  assert.deepEqual(ins.runs.items.map((i: any) => i.native.state), ["done", "failed"]);
  assert.doesNotMatch(JSON.stringify(ins), /"completed"|"success"/);
});

test("legacy records: a confirmed card and a job with no link stay unlinked; nothing is backfilled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  const threads = threadStore(join(dir, "threads"));
  const t = threads.create("Old chat");
  const mid = threads.beginAssistant(t.id);
  const cid = "44444444-4444-4444-8444-444444444444";
  threads.addCard(t.id, mid, { id: cid, kind: "job_launch", state: "open", createdAt: "2026-11-01T09:00:00.000Z", expiresAt: "2026-11-01T09:30:00.000Z", routine: "orbit", brief: "b" });
  threads.transitionCard(cid, "open", "confirmed");
  threads.recordOutcome(cid, { jobId: "orbit-legacy", httpStatus: 202 });
  const jobs = jobRegistry(jsonStore(dir, "jobs", []), Buffer.alloc(32, 1), notifier(jsonStore(undefined, "n", [])));
  jobs.register("orbit-legacy");
  const x = stack({ dir });
  assert.equal(x.work.sessions().length, 0);
  const chat = await x.assistantTool("session_inspect", { id: `chat:${t.id}` });
  assert.equal(chat.result.runs.items[0].id, "job:orbit-legacy");
  assert.equal(chat.result.runs.items[0].workSession, null);
  assert.match(chat.result.runs.items[0].workLink, /no work session is inferred/);
  assert.equal(chat.result.workSessions.total, 0);
  assert.equal(x.jobs.get("orbit-legacy")!.work, undefined);
});

test("missing origin and unavailable job store: unknown, never absent or inferred", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-work-"));
  const w = workSessions(workFile(dir));
  const gone = "chat:55555555-5555-4555-8555-555555555555";
  const l = w.begin("p-gone", { session: gone, basis: "server-turn" }, { attachment: "new" });
  w.settle("p-gone", { code: 202, body: { id: "orbit-x" } });
  const brokenJobs = { all: (): Job[] => { throw new Error("unreadable at /var/lib/x"); }, health: () => "ok" };
  const reg = sessionRegistry({ adapters: [assistantAdapter(assistantStore(undefined)), chatAdapter(threadStore(undefined)), workAdapter(w, brokenJobs)], jobs: brokenJobs, work: w });
  const r = reg.inspect({ isOwner: true }, l.workSession) as any;
  assert.equal(r.origin.state, "not-found");
  assert.equal(r.origin.session, gone);
  assert.equal(r.activity.state, "unknown");
  assert.equal(r.runs.items[0].native.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(r), /\/var\/lib/);
  const listed = reg.list({ isOwner: true }, { kinds: ["work"] });
  assert.equal(listed.sessions[0]!.work!.runActivity, "unknown");
});

// ---- discovery bounds, visibility and no writes ------------------------------------------------------------------------------

test("ids: work ids are validated strictly; forged ids and non-owners are refused before any store is read", () => {
  const ok = "abcdef11-1111-4111-8111-111111111111";
  assert.deepEqual(parseSessionId(`work:${ok}`), { ok: true, kind: "work", native: ok });
  for (const bad of ["work:../x", `work:${ok.toUpperCase()}`, "work:", `work:${ok}/..`, "work:orbit-202611150333-di81"]) assert.equal(parseSessionId(bad).ok, false, bad);
  let touched = 0;
  const spy = workSessions({ persisted: false, load: () => (touched++, undefined), save: () => {} });
  const reg = sessionRegistry({ adapters: [workAdapter(spy)], work: spy });
  assert.throws(() => reg.list({ isOwner: false }), /only the owner/);
  assert.throws(() => reg.inspect({ isOwner: false }, `work:${ok}`), /only the owner/);
  assert.throws(() => reg.read({ isOwner: false }, `work:${ok}`), /only the owner/);
  assert.throws(() => reg.inspect({ isOwner: true }, "work:../../etc"), /Malformed/);
  assert.equal(touched, 0);
  assert.throws(() => reg.inspect({ isOwner: true }, `work:${ok}`), /No visible session/);
});

test("discovery, inspection, reading and the digest write nothing and copy no transcript; the digest has no work rows", async () => {
  const x = stack();
  const t = await x.create("Quiet");
  const r = await x.confirm((await x.propose(t.id, "quiet")).id);
  await x.send(t.id, "SECRET-ISH-CONVERSATION-TEXT");
  const before = snapshot(x.dir);
  const reg = sessionRegistry({ adapters: [assistantAdapter(assistantStore(undefined)), chatAdapter(x.threads), workAdapter(x.work, x.jobs)], jobs: x.jobs, work: x.work });
  const [list, inspect, read] = sessionTools(reg, { caller: "assistant:assistant", isOwner: true });
  await list!.run({});
  await inspect!.run({ id: r.data.work.workSession });
  await inspect!.run({ id: `chat:${t.id}` });
  await read!.run({ id: r.data.work.workSession });
  const facts = reg.digest({ isOwner: true }, { rows: 8, runsPerRow: 2, recentHours: 72, exclude: ["assistant:assistant"] });
  assert.ok(facts.rows.every((row) => row.record.kind !== "work"));
  const digest = renderDigest(facts);
  assert.match(digest, new RegExp(r.data.work.workSession));
  assert.deepEqual(snapshot(x.dir), before);
  assert.doesNotMatch(readFileSync(fileOf(x.dir), "utf8"), /SECRET-ISH|Build feature/);
});

test("the Assistant's digest names a run's work session; a chat turn gets neither the digest nor work ids", async () => {
  const x = stack();
  const t = await x.create("Digest chat");
  const r = await x.confirm((await x.propose(t.id, "digest")).id);
  await x.api("/assistant/messages", "POST", { text: "hello" });
  assert.match(x.model.seen.at(-1)!.notes ?? "", new RegExp(r.data.work.workSession));
  await x.send(t.id, "and in chat?");
  const chatSeen = x.model.seen.at(-1)!;
  assert.doesNotMatch(JSON.stringify(chatSeen), /work:[0-9a-f-]{36}/);
  assert.ok(!chatSeen.tools.includes("sessions_list"));
});

test("list paging is bounded and work sessions page like any other kind", async () => {
  const w = workSessions(workFile(undefined));
  for (let i = 0; i < 30; i++) w.begin(`p${i}`, { session: "assistant:assistant", basis: "server-turn" }, { attachment: "new" });
  const reg = sessionRegistry({ adapters: [workAdapter(w)], work: w });
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = reg.list({ isOwner: true }, { kinds: ["work"], order: "created", limit: 25, ...(cursor ? { cursor } : {}) });
    assert.ok(page.returned <= 25);
    for (const s of page.sessions) seen.add(s.id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.size, 30);
});
