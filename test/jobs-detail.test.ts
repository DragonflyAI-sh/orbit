import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventsPage, jobDetail, jobLinks, jobTitle, listRows, parseRowQuery, safeUrl } from "../src/job-detail.ts";
import type { JobLink } from "../src/job-detail.ts";
import { DISPATCH_BRIEF_CHARS, REDACTED_TOKEN, redactText } from "../src/job-inputs.ts";
import { jobLauncher } from "../src/job-launch.ts";
import { buildIngress } from "../src/ingress.ts";
import { KEEP_EVENTS, jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import type { ControlRepo, Routine } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { loadResearchTool } from "../src/research.ts";
import { jsonStore } from "../src/store.ts";
import { fakeSecret, seededJobs } from "./jobs-page-fixture.ts";
import { OWNER } from "./threads-fixture.ts";

// The Jobs page's data (src/job-detail.ts, src/job-inputs.ts): what was really sent at dispatch, redaction, paged lists and histories,
// links that say where they came from, input states from evidence, and owner-only access.

const COMMIT = "9991f4adb81fc41b8fe2f55ff923484303f2bf6b";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function world(dir?: string) {
  const notify = notifier(jsonStore<Notification[]>(undefined, `n${Math.random()}`, []));
  const jobs = jobRegistry(jsonStore<Job[]>(dir, "jobs", []), Buffer.alloc(32, 7), notify);
  const pushed: { job: string; brief: string }[] = [];
  const fired: string[] = [];
  const control: ControlRepo = { pushBrief: async (job, brief) => (pushed.push({ job, brief }), { branch: `orbit/${job}`, commit: "d".repeat(40) }) };
  const routine: Routine = { name: "orbit", fire: async (text) => (fired.push(text), { sessionId: "cse_x", sessionUrl: "https://claude.ai/code/cse_x" }) };
  const researchFired: string[] = [];
  const research: Routine = { name: "research", fire: async (text) => (researchFired.push(text), { sessionId: "cse_r", sessionUrl: "https://claude.ai/code/cse_r" }) };
  const launch = jobLauncher({ jobs, control, routines: new Map([["orbit", routine]]), notify, publicJobUrl: "https://orbit-jobs.example", commit: COMMIT, research: { routines: new Map([["research", research]]), tool: loadResearchTool()! } });
  return { jobs, pushed, fired, researchFired, launch };
}
const tokenOf = (fire: string) => /^Token: (.+)$/m.exec(fire)![1]!;

// ---- dispatch snapshots -------------------------------------------------------------------------------------------------------

test("the dispatch snapshot is the fire text exactly as sent with only the token replaced, and the brief exactly as written", async () => {
  const w = world();
  const brief = "## Goal\nMake the jobs page better.\n\n## Steps\n1. Read the README.";
  const res = await w.launch("orbit", `  ${brief}\n\n`);
  assert.equal(res.code, 202);
  const id = (res.body as Job).id;
  const snap = w.jobs.get(id)!.launch!.dispatch!;
  const sent = w.fired[0]!;
  const token = tokenOf(sent);
  assert.equal(snap.v, 1);
  assert.equal(snap.fireText, sent.split(token).join(REDACTED_TOKEN), "everything but the token is byte for byte what was sent");
  assert.ok(!snap.fireText.includes(token) && !JSON.stringify(w.jobs.get(id)).includes(token), "the token is never stored");
  assert.equal(snap.brief.text, w.pushed[0]!.brief, "the brief is what ORBIT wrote to orbit-work");
  assert.equal(snap.brief.sha256, sha(w.pushed[0]!.brief));
  assert.equal(snap.brief.chars, w.pushed[0]!.brief.length);
  assert.equal(snap.brief.delivery, "orbit-work");
  assert.equal(snap.origin, "owner-route");
  assert.equal(snap.lane, "build");
  assert.deepEqual(snap.redactions, [{ field: "fireText", what: "the one-job runner token (and any other secret-shaped value)", count: 1 }]);
  assert.equal(w.jobs.get(id)!.launch!.fireStartedAt, snap.at, "recorded in the same write as the fire start");
});

test("a chat-proposal launch and a review launch say where they came from", async () => {
  const w = world();
  const a = await w.launch("orbit", "Brief A", undefined, { proposal: "p-1", workSession: "work:x", origin: null });
  assert.equal(w.jobs.get((a.body as Job).id)!.launch!.dispatch!.origin, "chat-proposal");
  assert.equal(w.jobs.get((a.body as Job).id)!.launch!.dispatch!.proposal, "p-1");
  const b = await w.launch("orbit", "Review brief", { of: "x", prUrl: "https://github.com/o/r/pull/1", repo: "o/r" });
  assert.equal(w.jobs.get((b.body as Job).id)!.launch!.dispatch!.origin, "orbit-review");
});

test("secret-shaped text in a brief is redacted before it is stored, and the redaction is labelled; nothing secret reaches the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-snap-"));
  const w = world(dir);
  const secret = fakeSecret();
  const res = await w.launch("orbit", `Deploy it.\npassword=${secret}\nThen report.`);
  const id = (res.body as Job).id;
  const snap = w.jobs.get(id)!.launch!.dispatch!;
  assert.match(snap.brief.text, /password=\[redacted\]/);
  assert.ok(!snap.brief.text.includes(secret));
  assert.deepEqual(snap.redactions.find((r) => r.field === "brief"), { field: "brief", what: "secret-shaped values in the brief", count: 1 });
  assert.equal(snap.brief.sha256, sha(w.pushed[0]!.brief), "the digest is of the brief as sent, so it can be checked against orbit-work");
  const stored = readFileSync(join(dir, "jobs.json"), "utf8");
  assert.ok(!stored.includes(secret), "the raw secret is never persisted");
  assert.ok(!stored.includes(tokenOf(w.fired[0]!)), "the token is never persisted");
});

test("a brief over the snapshot limit keeps its start, says how much, and points to git for the rest", async () => {
  const w = world();
  const long = "x".repeat(DISPATCH_BRIEF_CHARS + 500);
  const res = await w.launch("orbit", long);
  const job = w.jobs.get((res.body as Job).id)!;
  assert.equal(job.launch!.dispatch!.brief.retainedChars, DISPATCH_BRIEF_CHARS);
  assert.equal(job.launch!.dispatch!.brief.chars, DISPATCH_BRIEF_CHARS + 500);
  const d = jobDetail(job, "ok", { all: [job] });
  assert.match(d.inputs.brief.note!, new RegExp(`first ${DISPATCH_BRIEF_CHARS} of ${DISPATCH_BRIEF_CHARS + 500}`));
});

test("a research launch snapshots its fire text (token, tool digest) and brief; the brief fetch is recorded as received", async () => {
  const w = world();
  const res = await w.launch("research", "Find three sources on X.");
  assert.equal(res.code, 202, JSON.stringify(res.body));
  const id = (res.body as Job).id;
  const snap = w.jobs.get(id)!.launch!.dispatch!;
  const sent = w.researchFired[0]!;
  assert.equal(snap.fireText, sent.split(tokenOf(sent)).join(REDACTED_TOKEN));
  assert.match(snap.fireText, /^Lane: research$/m);
  assert.equal(snap.brief.delivery, "job-api");
  let d = jobDetail(w.jobs.get(id)!, "ok", { all: [] });
  assert.equal(d.inputs.stages.find((s) => s.key === "received")!.status, "pending", "not received until the runner fetches it");
  const ingress = buildIngress(w.jobs);
  await new Promise<void>((r) => ingress.listen(0, "127.0.0.1", r));
  const port = (ingress.address() as { port: number }).port;
  const got = await fetch(`http://127.0.0.1:${port}/v1/jobs/${id}/brief`, { headers: { authorization: `Bearer ${tokenOf(sent)}` } });
  const body = await got.text();
  ingress.close();
  assert.equal(got.status, 200);
  const served = w.jobs.get(id)!.research!.briefServed!;
  assert.equal(served.count, 1);
  assert.equal(served.sha256, sha(JSON.stringify(JSON.parse(body))));
  d = jobDetail(w.jobs.get(id)!, "ok", { all: [] });
  assert.equal(d.inputs.stages.find((s) => s.key === "received")!.status, "done");
});

test("a legacy launch shows its brief and fire text as unavailable, never reconstructed, with the brief's git location", () => {
  const w = world();
  w.jobs.register("legacy-1");
  w.jobs.setLaunch("legacy-1", { routine: "orbit", at: "2026-11-01T00:00:00.000Z", branch: "orbit/legacy-1", briefCommit: "e".repeat(40), firedAt: "2026-11-01T00:00:01.000Z", sessionId: "s", sessionUrl: "https://claude.ai/code/s", toolCommitSent: COMMIT });
  const d = jobDetail(w.jobs.get("legacy-1")!, "ok", { all: [] });
  assert.equal(d.inputs.brief.state, "unavailable");
  assert.equal((d.inputs.brief as { text?: string }).text, undefined);
  assert.match(d.inputs.brief.note!, /before ORBIT kept a dispatch snapshot/);
  assert.equal((d.inputs.brief as { url?: string }).url, `https://github.com/DragonflyAI-sh/orbit-work/blob/${"e".repeat(40)}/.orbit/brief.md`);
  assert.equal(d.inputs.fireText.state, "unavailable");
  assert.equal((d.inputs.fireText as { toolCommitSent?: string }).toolCommitSent, COMMIT, "only the recorded field");
  assert.equal(d.inputs.snapshot, null);
  assert.equal(d.inputs.stages.find((s) => s.key === "confirmed")!.status, "unknown");
});

// ---- the list ------------------------------------------------------------------------------------------------------------------

function many(n: number) {
  const w = world();
  for (let i = 0; i < n; i++) {
    const id = `job-${String(i).padStart(3, "0")}`;
    w.jobs.register(id);
    w.jobs.setLaunch(id, { routine: i % 2 ? "orbit" : "money-noodle", at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() });
    if (i % 5 === 0) w.jobs.record(id, { type: "summary", status: "done", text: `Finished ${i}` });
  }
  return w;
}
const health = () => "ok";

test("the list pages every stored job exactly once with a cursor, newest first, and reports the true totals", () => {
  const w = many(180);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const p = listRows(w.jobs.all(), health, COMMIT, { limit: 50, cursor });
    assert.equal(p.total, 180);
    assert.equal(p.matched, 180);
    seen.push(...p.jobs.map((j) => j.id));
    if (!p.next) break;
    cursor = p.next;
  }
  assert.equal(seen.length, 180);
  assert.equal(new Set(seen).size, 180);
  assert.equal(seen[0], "job-179");
  assert.equal(seen.at(-1), "job-000");
});

test("a page boundary does not move when a new job arrives at the top", () => {
  const w = many(60);
  const first = listRows(w.jobs.all(), health, COMMIT, { limit: 25 });
  w.jobs.register("newest");
  w.jobs.setLaunch("newest", { routine: "orbit", at: "2026-12-01T00:00:00.000Z" });
  const second = listRows(w.jobs.all(), health, COMMIT, { limit: 25, cursor: first.next! });
  assert.equal(second.jobs[0]!.id, "job-034", "continues right after the last row of the first page");
});

test("search and filters narrow the list, and the facets count the whole store", () => {
  const w = many(40);
  const done = listRows(w.jobs.all(), health, COMMIT, { state: "done", limit: 200 });
  assert.equal(done.matched, 8);
  assert.ok(done.jobs.every((j) => j.state === "done"));
  assert.equal(listRows(w.jobs.all(), health, COMMIT, { routine: "orbit", limit: 200 }).matched, 20);
  assert.equal(listRows(w.jobs.all(), health, COMMIT, { q: "job-03", limit: 200 }).matched, 10);
  assert.equal(listRows(w.jobs.all(), health, COMMIT, { q: "finished 35", limit: 200 }).jobs[0]!.id, "job-035", "the latest line is searchable");
  assert.equal(listRows(w.jobs.all(), (j) => (j.id === "job-007" ? "quiet" : "ok"), COMMIT, { attention: true }).matched, 1);
  assert.equal(listRows(w.jobs.all(), health, COMMIT, { lane: "research" }).matched, 0);
  const all = listRows(w.jobs.all(), health, COMMIT, {});
  assert.deepEqual(all.facets.routines, ["money-noodle", "orbit"]);
  assert.equal(all.facets.state.done, 8);
});

test("row queries are bounded", () => {
  assert.equal(parseRowQuery(new URLSearchParams("limit=100000")).limit, 200);
  assert.equal(parseRowQuery(new URLSearchParams("limit=0")).limit, 1);
  assert.equal(parseRowQuery(new URLSearchParams("limit=abc")).limit, 50);
  assert.equal(parseRowQuery(new URLSearchParams(`q=${"a".repeat(1000)}`)).q!.length, 200);
  const w = many(3);
  assert.equal(listRows(w.jobs.all(), health, COMMIT, { cursor: "not-a-cursor" }).jobs.length, 3, "a bad cursor starts at the top");
});

test("titles come from recorded words and say which", () => {
  const job = (extra: Partial<Job>): Job => ({ id: "t1", createdAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z", state: "running", events: [], steers: [], ...extra });
  assert.deepEqual(jobTitle(job({ pr: { at: "x", title: "Add the thing" } })), { text: "Add the thing", source: "pr-title" });
  assert.deepEqual(jobTitle(job({ state: "done", summary: { text: "## PR title\nFrom the summary\n\n## PR body\nbody", chars: 10, state: "complete", via: "api", at: "x" } })), { text: "From the summary", source: "summary-pr-title" });
  const snap = { v: 1 as const, at: "x", lane: "build" as const, origin: "owner-route" as const, fireText: "", brief: { text: "## Goal\n\nFix the **login** bug", chars: 1, retainedChars: 1, sha256: "", delivery: "orbit-work" as const }, redactions: [] };
  assert.deepEqual(jobTitle(job({ launch: { routine: "orbit", at: "x", dispatch: snap } })), { text: "Fix the login bug", source: "brief" });
  assert.deepEqual(jobTitle(job({ launch: { routine: "orbit", at: "x" } })), { text: "orbit work job", source: "none" });
  assert.equal(jobTitle(job({ kind: "review", review: { of: "w1", prUrl: "https://github.com/o/r/pull/9", repo: "o/r" } })).text, "Review of w1 (o/r#9)");
});

// ---- events ---------------------------------------------------------------------------------------------------------------------

test("a long history is paged back to the first retained event, and dropped events are counted, not hidden", () => {
  const w = world();
  w.jobs.register("long");
  for (let i = 1; i <= KEEP_EVENTS + 30; i++) w.jobs.record("long", { type: "checkin", text: `c${i}` });
  const job = w.jobs.get("long")!;
  assert.equal(job.events.length, KEEP_EVENTS);
  assert.equal(job.eventsDropped, 30);
  const seen: number[] = [];
  let before: number | undefined;
  for (let i = 0; i < 20; i++) {
    const p = eventsPage(job, before, 50);
    seen.push(...p.events.map((e) => e.seq));
    assert.equal(p.dropped, 30);
    assert.match(p.note!, /30 earlier event\(s\) were dropped/);
    if (p.next === null) break;
    before = p.next;
  }
  assert.equal(seen.length, KEEP_EVENTS);
  assert.equal(seen[0], KEEP_EVENTS + 30, "newest first, numbered from the job's first event");
  assert.equal(seen.at(-1), 31);
  assert.equal(job.events.find((e) => e.text === "c31") !== undefined, true);
});

test("a legacy record already at the event limit says the dropped count is unknown", () => {
  const job: Job = { id: "old", createdAt: "x", expiresAt: "y", state: "running", steers: [], events: Array.from({ length: KEEP_EVENTS }, (_, i) => ({ at: `2026-11-01T00:00:${String(i % 60).padStart(2, "0")}Z`, type: "checkin" as const, text: `e${i}` })) };
  const p = eventsPage(job);
  assert.equal(p.dropped, null);
  assert.match(p.note!, /unknown/);
  assert.equal(eventsPage({ ...job, events: job.events.slice(0, 5) }).dropped, 0, "under the limit nothing was ever dropped");
});

test("event text is redacted, a clipped event says so, and the full text length is kept", () => {
  const w = world();
  w.jobs.register("ev");
  w.jobs.record("ev", { type: "checkin", text: `found token: ${fakeSecret()}` });
  w.jobs.record("ev", { type: "reply", n: 1, text: "y".repeat(5000) });
  const p = eventsPage(w.jobs.get("ev")!);
  const reply = p.events[0]!, check = p.events[1]!;
  assert.ok(!check.text!.includes(fakeSecret()));
  assert.equal(check.redacted, 1);
  assert.equal(reply.textClipped, true);
  assert.equal(reply.textChars, 5000);
  assert.equal(reply.text!.length, 4000);
});

// ---- steers and their states ----------------------------------------------------------------------------------------------------

test("steers show queued, received and answered from evidence, with their source; a long steer says it was cut", () => {
  const w = world();
  w.jobs.register("st");
  w.jobs.steer("st", "one", { source: "owner" });
  w.jobs.steer("st", "two", { source: "proposal", proposal: "prop-2" });
  w.jobs.steer("st", "z".repeat(4500));
  w.jobs.acknowledge("st", [1, 2]);
  w.jobs.record("st", { type: "reply", n: 1, text: "done one" });
  const d = jobDetail(w.jobs.get("st")!, "ok", { all: [] }, [{ id: "pp", job: "st", text: "four?", createdAt: "a", expiresAt: "b" }, { id: "other", job: "x", text: "no", createdAt: "a", expiresAt: "b" }]);
  const byN = Object.fromEntries(d.inputs.steers.map((s) => [s.n, s]));
  assert.equal(byN[1]!.state, "replied");
  assert.equal(byN[1]!.reply!.text, "done one");
  assert.equal(byN[1]!.source, "owner");
  assert.equal(byN[2]!.state, "delivered");
  assert.equal(byN[2]!.source, "proposal");
  assert.equal(byN[2]!.proposal, "prop-2");
  assert.equal(byN[3]!.state, "queued", "never called received before the runner acknowledges it");
  assert.equal(byN[3]!.source, "unrecorded");
  assert.equal(byN[3]!.clipped, true);
  assert.equal(byN[3]!.chars, 4500);
  assert.deepEqual(d.inputs.proposedSteers.map((p) => [p.id, p.state]), [["pp", "proposed"]]);
});

// ---- links --------------------------------------------------------------------------------------------------------------------

const link = (links: JobLink[], label: string) => links.find((l) => l.label === label);

test("links say recorded, derived or unavailable, and a missing PR is never invented", () => {
  const w = world();
  w.jobs.register("lk");
  w.jobs.setLaunch("lk", { routine: "orbit", at: "x", branch: "orbit/lk", briefCommit: "a".repeat(40), sessionId: "s1", sessionUrl: "https://claude.ai/code/s1", toolCommitSent: COMMIT });
  const links = jobLinks(w.jobs.get("lk")!, { all: [], routineRepo: "DragonflyAI-sh/orbit" });
  assert.equal(link(links, "Claude session")!.basis, "recorded");
  assert.equal(link(links, "Brief commit")!.url, `https://github.com/DragonflyAI-sh/orbit-work/commit/${"a".repeat(40)}`);
  assert.equal(link(links, "Brief commit")!.basis, "derived");
  assert.equal(link(links, "Tool commit sent in the fire text")!.url, `https://github.com/DragonflyAI-sh/orbit/commit/${COMMIT}`);
  assert.equal(link(links, "Project repository")!.basis, "derived");
  assert.match(link(links, "Code branch")!.note!, /has not checked that it exists/);
  assert.equal(link(links, "Pull request")!.basis, "unavailable");
  assert.equal(link(links, "Pull request")!.url, undefined);
  assert.equal(link(links, "Pull request checks"), undefined, "no derived PR links without a recorded PR");
});

test("unsafe or malformed recorded URLs are never linked", () => {
  for (const bad of ["javascript:alert(1)", "https://evil.example/pull/1", "https://github.com/o/r/pull/1/../../x", "https://github.com.evil.example/o/r/pull/1", "https://user:pw@github.com/o/r/pull/1", "http://github.com/o/r/pull/1", "https://github.com/o/r/pull/1\" onmouseover=\"x"]) {
    assert.equal(safeUrl(bad, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/), undefined, bad);
  }
  const w = world();
  w.jobs.register("bad");
  w.jobs.setLaunch("bad", { routine: "orbit", at: "x", sessionUrl: "javascript:alert(1)", branch: "orbit/other-job", briefCommit: "<img src=x>" });
  w.jobs.setPr("bad", { at: "x", url: "https://evil.example/pull/1" });
  const links = jobLinks(w.jobs.get("bad")!, { all: [] });
  for (const l of links) if (l.url) assert.match(l.url, /^https:\/\/(github\.com|claude\.ai)\//, l.label);
  assert.equal(link(links, "Claude session")!.basis, "unavailable");
  assert.equal(link(links, "Control branch (orbit-work)")!.basis, "unavailable", "a branch that is not this job's is not linked");
  assert.equal(link(links, "Pull request")!.basis, "unavailable");
  assert.match(link(links, "Pull request")!.note!, /not have the expected GitHub pull-request shape/);
});

test("a work job and its review job link each other, with the review's comment and the PR head it started from", async () => {
  const s = await seededJobs({ events: 1 });
  const work = jobLinks(s.r.jobs.get(s.done)!, { all: s.r.jobs.all() });
  assert.equal(link(work, "Review job")!.job, s.review);
  assert.equal(link(work, "Pull request")!.basis, "recorded");
  assert.equal(link(work, "Pull request commits")!.url, "https://github.com/DragonflyAI-sh/orbit/pull/127/commits");
  assert.equal(link(work, "Pull request checks")!.basis, "derived");
  const rv = jobLinks(s.r.jobs.get(s.review)!, { all: s.r.jobs.all() });
  assert.equal(link(rv, "Reviewed work job")!.job, s.done);
  assert.equal(link(rv, "Review comment")!.url, "https://github.com/DragonflyAI-sh/orbit/pull/127#issuecomment-99");
  assert.equal(link(rv, "PR head when the review launched")!.url, `https://github.com/DragonflyAI-sh/orbit/commit/${"c".repeat(39)}3`);
  s.r.close();
});

// ---- the owner routes -------------------------------------------------------------------------------------------------------------

test("routes: rows, detail and events are owner only; detail carries the snapshot redacted and open steer proposals", async () => {
  const s = await seededJobs({ events: 120 });
  const detail = (await s.r.api(`/jobs/${s.id}?view=detail`)).data;
  assert.equal(detail.inputs.brief.state, "recorded");
  assert.ok(!JSON.stringify(detail).includes(fakeSecret()), "no secret in the detail");
  assert.match(detail.inputs.fireText.text, new RegExp(REDACTED_TOKEN.replace(/[[\]]/g, "\\$&")));
  assert.equal(detail.timeline.events.events.length, 50);
  const older = (await s.r.api(`/jobs/${s.id}/events?before=${detail.timeline.events.next}`)).data;
  assert.equal(older.events[0].seq, detail.timeline.events.next - 1);
  assert.equal((await s.r.api(`/jobs/${s.id}/events?before=abc`)).status, 400);
  const rows = (await s.r.api("/jobs?view=rows&limit=2")).data;
  assert.equal(rows.jobs.length, 2);
  assert.ok(rows.next);
  assert.equal((await s.r.api("/jobs/nope?view=detail")).status, 404);
  s.r.caller.who = "someone@example.com";
  for (const path of ["/jobs?view=rows", `/jobs/${s.id}?view=detail`, `/jobs/${s.id}/events`, `/jobs/${s.id}`]) assert.equal((await s.r.api(path)).status, 403, path);
  s.r.caller.who = undefined;
  assert.equal((await s.r.api(`/jobs/${s.id}?view=detail`)).status, 403);
  s.r.caller.who = OWNER;
  s.r.close();
});

test("routes: a steer sent from the page and one confirmed from a chat proposal record their source", async () => {
  const s = await seededJobs({ events: 1 });
  const direct = (await s.r.api(`/jobs/${s.done}/steer`, "POST", { text: "direct" })).data;
  assert.equal(direct.source, "owner");
  const p = s.r.proposals.propose({ kind: "job_steer", job: s.done, text: "via chat" });
  const d1 = (await s.r.api(`/jobs/${s.done}?view=detail`)).data;
  assert.deepEqual(d1.inputs.proposedSteers.map((x: { id: string }) => x.id), [p.id], "an open proposal shows as proposed");
  const ok = await s.r.api(`/chat/proposals/${p.id}/confirm`, "POST");
  assert.equal(ok.status, 201);
  const d2 = (await s.r.api(`/jobs/${s.done}?view=detail`)).data;
  const steer = d2.inputs.steers.find((x: { text: string }) => x.text === "via chat");
  assert.equal(steer.source, "proposal");
  assert.equal(steer.proposal, p.id);
  assert.equal(steer.state, "queued");
  assert.deepEqual(d2.inputs.proposedSteers, []);
  s.r.close();
});

test("the model's job_status view keeps the snapshot's shape, not the brief text", async () => {
  const { detailJob } = await import("../src/job-view.ts");
  const w = world();
  const res = await w.launch("orbit", "A brief the model does not need to see again.");
  const v = detailJob(w.jobs.get((res.body as Job).id)!, "ok", COMMIT) as { launch: { dispatch: Record<string, unknown> } };
  assert.ok(!JSON.stringify(v).includes("does not need to see again"));
  assert.equal(v.launch.dispatch.briefChars, "A brief the model does not need to see again.".length);
});

test("redactText keeps commit ids, URLs and prose, and masks credential shapes", () => {
  const keep = `commit ${COMMIT} https://claude.ai/code/session_01XboYN1UamYyMs6KUvTZsyV and https://github.com/o/r/pull/1`;
  assert.deepEqual(redactText(keep), { text: keep, count: 0 });
  const key = ["sk", "-", "A1b2".repeat(8)].join("");
  const r = redactText(`key ${key} and Bearer ${"q".repeat(30)}`);
  assert.equal(r.count, 2);
  assert.ok(!r.text.includes(key));
});

// ---- the page's pure helpers (src/web/index.html <routing> and <jobs-lib>) ------------------------------------------------------

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";
const lib = new Function(`${block("routing")}; ${block("jobs-lib")}; return { pageFor, canonicalAddress, jobFromHash, jobHref, rowsQuery, internalHref, isLongText };`)() as {
  pageFor(p: string, h: string, j: boolean, a: boolean): string;
  canonicalAddress(p: string, s: string, h: string): string | null;
  jobFromHash(h: string): string | null;
  jobHref(id: string): string;
  rowsQuery(q: Record<string, unknown>, cursor?: string | null): string;
  internalHref(l: { job?: string; session?: string }): string | null;
  isLongText(t: string): boolean;
};

test("page: /#jobs/<id> opens that job on the Jobs page; anything else after #jobs/ names no job", () => {
  assert.equal(lib.pageFor("/", "#jobs/orbit-1", true, true), "jobs");
  assert.equal(lib.pageFor("/", "#jobs/orbit-1", false, true), "home", "owner only, as #jobs: the default page (Home)");
  assert.equal(lib.canonicalAddress("/sessions", "", "#jobs/orbit-1"), "/#jobs/orbit-1");
  assert.equal(lib.jobFromHash("#jobs/orbit-202611180426-9usk"), "orbit-202611180426-9usk");
  assert.equal(lib.jobFromHash("#jobs/orbit%2D1"), "orbit-1");
  for (const bad of ["#jobs", "#jobs/", "#jobs/<img>", "#jobs/..%2Fx", "#jobs/%E0%A4%A", `#jobs/${"a".repeat(65)}`]) assert.equal(lib.jobFromHash(bad), null, bad);
  assert.equal(lib.jobHref("a.b_c-1"), "/#jobs/a.b_c-1");
});

test("page: the list query carries only set filters and the cursor; in-page links are jobs, sessions or the Assistant", () => {
  assert.equal(lib.rowsQuery({ q: "", state: "", attention: false }), "");
  assert.equal(lib.rowsQuery({ q: "login bug", state: "done", attention: true }, "abc"), "&q=login+bug&state=done&attention=1&cursor=abc");
  assert.equal(lib.internalHref({ job: "orbit-1" }), "/#jobs/orbit-1");
  assert.equal(lib.internalHref({ job: "<x>" }), null);
  assert.equal(lib.internalHref({ session: "/sessions/12345678-1234-1234-1234-123456789abc" }), "/sessions/12345678-1234-1234-1234-123456789abc");
  assert.equal(lib.internalHref({ session: "javascript:alert(1)" }), null);
  assert.equal(lib.internalHref({ session: "https://evil.example/" }), null);
  assert.equal(lib.isLongText("short"), false);
  assert.equal(lib.isLongText("x\n".repeat(30)), true);
});
