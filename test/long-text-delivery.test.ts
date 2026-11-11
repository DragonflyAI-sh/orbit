import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { jobLauncher } from "../src/job-launch.ts";
import { jobRow } from "../src/job-view.ts";
import { jobs as jobRegistry, MAX_SUMMARY_CHARS } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import type { ControlRepo } from "../src/launcher.ts";
import { gitReconciler } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { MAX_DELIVERY_ATTEMPTS, parseRoutineRepos, prText, pullRequestOpener } from "../src/pull-requests.ts";
import type { CommentPort, PullPort } from "../src/pull-requests.ts";
import { readVerdict, reviewComment, reviewParts, reviewer } from "../src/review.ts";
import { PART_CHARS, splitText, unwrapPart } from "../src/split-text.ts";
import { jsonStore } from "../src/store.ts";

// Long summaries and reviews: nothing is clipped, the title and the verdict survive, and split delivery is exact, resumable and honest.
// Everything runs against fakes; no GitHub or ORBIT service is contacted.

const tick = () => new Promise((r) => setTimeout(r, 10));
const PR = "https://github.com/DragonflyAI-sh/orbit/pull/7";
const GITHUB_LIMIT = 65_536;

// Varied lines, so a lossy cut or a repeated chunk cannot go unnoticed.
const longText = (chars: number, tag: string) => {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${tag} line ${i}: ${"abcdefghij".repeat(i % 7)}\n${i % 13 === 0 ? "\n" : ""}`;
  return out.slice(0, chars);
};

// A fake GitHub issue-comments API: stores comments, can fail chosen calls, and can "lose the answer" after storing one.
function fakeComments() {
  const stored: { body: string; url: string }[] = [];
  const state = { failAt: new Set<number>(), loseAnswerAt: new Set<number>(), posts: 0 };
  const port: CommentPort = {
    post: async (_repo, _pull, body) => {
      const n = ++state.posts;
      if (state.failAt.has(n)) throw new Error("Posting the review comment returned HTTP 502: bad gateway");
      stored.push({ body, url: `${PR}#issuecomment-${stored.length + 1}` });
      if (state.loseAnswerAt.has(n)) throw new Error("connection reset after the comment was created");
      return stored.at(-1)!.url;
    },
    find: async (_repo, _pull, marker) => stored.find((c) => c.body.includes(marker))?.url,
  };
  return { port, stored, state };
}

function world(comments?: CommentPort) {
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 1), notify);
  const opened: { title: string; body: string }[] = [];
  const pulls: PullPort = { open: async (_repo, _job, title, body) => (opened.push({ title, body }), { status: "opened", url: PR }) };
  const briefs: string[] = [];
  const control = { pushBrief: async (id: string, text: string) => (briefs.push(text), { branch: `orbit/${id}`, commit: "c1" }) } as unknown as ControlRepo;
  const routine = { name: "orbit", fire: async () => ({ sessionId: "s", sessionUrl: "https://claude.ai/code/s" }) };
  const launch = jobLauncher({ jobs, control, routines: new Map([["orbit", routine]]), notify, publicJobUrl: "https://api.example", commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b" });
  const review = reviewer(jobs, launch, comments, notify);
  const prs = pullRequestOpener(jobs, parseRoutineRepos("orbit=DragonflyAI-sh/orbit"), pulls, notify, () => new Date(), (job, url) => void review.start(job, url), comments);
  const texts = () => notify.recent().map((n) => n.text);
  const work = (id: string) => {
    jobs.register(id);
    jobs.setLaunch(id, { routine: "orbit", at: new Date().toISOString(), sessionUrl: `https://claude.ai/code/${id}` });
  };
  return { jobs, notify, texts, opened, review, prs, work };
}

// ---- splitting --------------------------------------------------------------------------------------------------------

test("splitText: the parts joined are exactly the original, each fits, and a short text is one part", () => {
  const text = longText(PART_CHARS * 2 + 12_345, "split");
  const parts = splitText(text);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), text, "no gap and no repeat");
  assert.ok(parts.every((p) => p.length <= PART_CHARS));
  assert.equal(splitText("short").length, 1);
  assert.deepEqual(splitText(""), [""]);
  // A text with no line breaks at all is still cut exactly, and a surrogate pair is never torn.
  const flat = "😀".repeat(PART_CHARS);
  const flatParts = splitText(flat);
  assert.equal(flatParts.join(""), flat);
  assert.ok(flatParts.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p)));
});

// ---- PR descriptions --------------------------------------------------------------------------------------------------

test("a long summary is stored whole and a ## PR title written after the long body is honoured (the old 4000-character clip lost it)", async () => {
  const w = world(fakeComments().port);
  w.work("long1");
  const body = longText(9_000, "body");
  const summary = `## PR body\n${body}\n\n## PR title\nHonour the late title`;
  w.jobs.record("long1", { type: "summary", status: "done", text: summary, via: "api" });
  await tick();
  const j = w.jobs.get("long1")!;
  assert.equal(j.summary!.text, summary, "the full text is stored on the job");
  assert.equal(j.summary!.chars, summary.length);
  assert.ok(j.events.at(-1)!.textClipped, "the display copy says it is clipped");
  assert.equal(w.opened[0]!.title, "Honour the late title");
  assert.ok(w.opened[0]!.body.includes(body.trim()), "the body is complete past 4000 characters");
  assert.equal(j.pr!.titleSource, "pr-title-section");
});

test("an oversized description is split into ordered parts below GitHub's limit, reconstructs exactly, and is delivered in full", async () => {
  const c = fakeComments();
  const w = world(c.port);
  w.work("big1");
  const body = longText(190_000, "desc");
  w.jobs.record("big1", { type: "summary", status: "done", text: `## PR title\nA very long change\n\n## PR body\n${body}`, via: "api" });
  await tick();
  await tick();
  const pr = w.jobs.get("big1")!.pr!;
  assert.equal(pr.total, 4);
  assert.equal(pr.posted, 4);
  assert.equal(pr.error, undefined);
  assert.equal(c.stored.length, 3);
  const all = [w.opened[0]!.body, ...c.stored.map((x) => x.body)];
  assert.ok(all.every((b) => b.length < GITHUB_LIMIT), "every body is under GitHub's 65,536-character limit");
  assert.match(w.opened[0]!.body, /^> This description is long: it is part 1 of 4/);
  // Strip the wrappers, join: complete body plus footer, exactly.
  const first = w.opened[0]!.body.replace(/^> [^\n]*\n\n/, "");
  const rebuilt = first + c.stored.map((x) => unwrapPart(x.body)).join("");
  assert.equal(rebuilt, `${body.trim()}\n\n---\nOpened by ORBIT for job \`big1\`. Session: https://claude.ai/code/big1`);
  assert.ok(c.stored.every((x, i) => x.body.startsWith(`<!-- orbit-part job=big1 kind=pr part=${i + 2}/4 -->`)), "comments carry ordered markers");
  assert.ok(w.texts().some((t) => t.includes("all 4 parts of the description are posted")));
});

test("a split delivery that fails part-way says so, never claims full delivery, and retries resume without duplicating (even after a lost answer)", async () => {
  const c = fakeComments();
  const w = world(c.port);
  c.state.loseAnswerAt.add(1); // part 2 is created on GitHub but the answer never arrives
  c.state.failAt.add(2); // and the next post (part 3, on the retry) fails outright
  w.work("big2");
  w.jobs.record("big2", { type: "summary", status: "done", text: `## PR title\nSplit and fail\n\n## PR body\n${longText(190_000, "x")}`, via: "api" });
  await tick();
  await tick();
  const later = () => w.jobs.setPr("big2", { ...w.jobs.get("big2")!.pr!, lastAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  let pr = w.jobs.get("big2")!.pr!;
  assert.equal(pr.url, PR);
  assert.equal(pr.posted, 1, "only the description is recorded as delivered");
  assert.match(pr.error!, /part 2 of 4 failed/);
  assert.ok(!w.texts().some((t) => t.includes("all 4 parts")), "no claim of full delivery");
  assert.ok(w.texts().some((t) => t.includes("only 1 of 4 parts")));
  // Retry 1 finds part 2 already on the PR (by its marker, so it is not posted twice); posting part 3 fails.
  later();
  await w.prs.retry();
  pr = w.jobs.get("big2")!.pr!;
  assert.equal(pr.posted, 2);
  assert.match(pr.error!, /part 3 of 4 failed/);
  // Retry 2 finishes.
  later();
  await w.prs.retry();
  pr = w.jobs.get("big2")!.pr!;
  assert.equal(pr.posted, 4);
  assert.equal(pr.error, undefined);
  assert.deepEqual(c.stored.map((x) => /part=(\d)\/4/.exec(x.body)![1]), ["2", "3", "4"], "each part exactly once, in order");
  assert.ok(w.texts().some((t) => t.includes("all 4 parts of the description are posted")));
});

test("retries stop after MAX_DELIVERY_ATTEMPTS and the failure stays on the job", async () => {
  const c = fakeComments();
  for (let i = 1; i <= 50; i++) c.state.failAt.add(i);
  const w = world(c.port);
  w.work("big3");
  w.jobs.record("big3", { type: "summary", status: "done", text: `## PR title\nNever delivered\n\n## PR body\n${longText(70_000, "y")}`, via: "api" });
  await tick();
  await tick();
  for (let i = 0; i < 10; i++) {
    const pr = w.jobs.get("big3")!.pr!;
    w.jobs.setPr("big3", { ...pr, lastAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    await w.prs.retry();
  }
  const pr = w.jobs.get("big3")!.pr!;
  assert.equal(pr.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(pr.posted, 1);
  assert.equal(c.state.posts, MAX_DELIVERY_ATTEMPTS);
  assert.ok(w.texts().some((t) => t.includes("stopped retrying")));
});

test("the title source is recorded and reported when the runner wrote no title", async () => {
  const w = world(fakeComments().port);
  w.work("t1");
  w.jobs.record("t1", { type: "summary", status: "done", text: "Fixed the thing that broke login.\n\nDetails follow.", via: "api" });
  await tick();
  assert.equal(w.opened[0]!.title, "Fixed the thing that broke login.");
  assert.equal(w.jobs.get("t1")!.pr!.titleSource, "summary-first-line");
  assert.ok(w.texts().some((t) => t.includes("PR ready:") && t.includes("title comes from the first line of the summary")));
  assert.equal(jobRow(w.jobs.get("t1")!, "finished").prTitleSource, "summary-first-line");
  assert.ok(!w.opened.some((o) => /^ORBIT job /.test(o.title)));
});

test("a summary that reaches ORBIT only in part opens nothing until git completes it, then opens once with the real title", async () => {
  const w = world(fakeComments().port);
  w.work("p1");
  const full = `## PR body\n${longText(20_000, "part")}\n\n## PR title\nTitle only in the full text`;
  w.jobs.record("p1", { type: "summary", status: "done", text: full.slice(0, 4000), textComplete: false, via: "api" });
  await tick();
  assert.equal(w.opened.length, 0, "nothing is opened from a partial summary");
  assert.equal(w.jobs.get("p1")!.summary!.state, "partial");
  assert.ok(w.texts().some((t) => t.includes("Only the start of the summary reached ORBIT")));
  const control = { pushBrief: async () => ({ branch: "", commit: "" }), readJob: async () => ({ head: "abc", started: true, summary: { status: "done", text: full } }) } as unknown as ControlRepo;
  await gitReconciler(w.jobs, control, () => Date.now() + 10 * 60_000)();
  await tick();
  assert.equal(w.jobs.get("p1")!.summary!.state, "complete");
  assert.equal(w.opened.length, 1);
  assert.equal(w.opened[0]!.title, "Title only in the full text");
  assert.ok(w.opened[0]!.body.includes("part line 100"));
});

test("a summary over the size limit is reported, not cut: no PR, an explicit error", async () => {
  const w = world(fakeComments().port);
  w.work("o1");
  w.jobs.record("o1", { type: "summary", status: "done", text: "x".repeat(MAX_SUMMARY_CHARS + 1), via: "git" });
  await tick();
  assert.equal(w.opened.length, 0);
  const j = w.jobs.get("o1")!;
  assert.equal(j.summary!.state, "oversize");
  assert.equal(j.summary!.chars, MAX_SUMMARY_CHARS + 1);
  assert.match(j.pr!.error!, /over the limit/);
});

test("prText reports total parts and never exceeds the limit even for the footer", () => {
  const t = prText({ id: "z", launch: { routine: "orbit", at: "x" } } as Job, `## PR title\nT title here\n\n## PR body\n${longText(PART_CHARS - 50, "edge")}`);
  assert.ok(t.body.length < GITHUB_LIMIT && t.comments.every((c) => c.body.length < GITHUB_LIMIT));
});

// ---- review verdicts and long reviews -----------------------------------------------------------------------------------

test("readVerdict: a blocking verdict is never turned into approval, and missing or ambiguous verdicts are explicit", () => {
  assert.deepEqual(readVerdict("## Findings\nnone\n\nVerdict: no blocking issues"), { verdict: "no blocking issues" });
  assert.equal(readVerdict("1. bug\n\nVerdict: blocking issues").verdict, "blocking issues");
  const none = readVerdict("## Findings\n1. a.ts:1 broken");
  assert.equal(none.verdict, "no verdict");
  assert.match(none.reason!, /no `Verdict:` line/);
  const conflict = readVerdict("Verdict: blocking issues\n...\nVerdict: no blocking issues");
  assert.equal(conflict.verdict, "ambiguous");
  assert.match(conflict.reason!, /conflicting/);
  const unknown = readVerdict("Verdict: looks fine to me");
  assert.equal(unknown.verdict, "ambiguous");
  assert.match(unknown.reason!, /unrecognised/);
  for (const marked of ["1. [blocking] src/a.ts:3 data loss", "**Blocker** x\n- **blocking** y", "Severity: blocking", "Blocking: src/a.ts:9"]) {
    const r = readVerdict(`## Findings\n${marked}\n\nVerdict: no blocking issues`);
    assert.equal(r.verdict, "ambiguous", marked);
    assert.match(r.reason!, /marked blocking/);
  }
  // Prose that merely mentions the phrase is not a marker.
  assert.equal(readVerdict("## Blocking issues\nNone found, no blocking issues.\n\nVerdict: no blocking issues").verdict, "no blocking issues");
});

test("a long review with the blocking verdict at the end is posted whole in ordered parts, every part names the verdict, and the verdict is persisted", async () => {
  const c = fakeComments();
  const w = world(c.port);
  w.work("w1");
  w.jobs.record("w1", { type: "summary", status: "done", text: "## PR title\nShip it now\n\n## PR body\nB", via: "api" });
  await tick();
  await tick();
  const rid = w.jobs.get("w1")!.reviewJob!.id!;
  const findings = `## Findings\n${longText(130_000, "finding")}\n\nVerdict: blocking issues`;
  w.jobs.record(rid, { type: "summary", status: "done", text: findings, via: "api" });
  await tick();
  await tick();
  assert.equal(c.stored.length, 3);
  assert.ok(c.stored.every((x) => x.body.length < GITHUB_LIMIT));
  assert.ok(c.stored.every((x) => x.body.includes("ORBIT-recorded verdict: blocking issues")), "every part carries the verdict");
  assert.ok(c.stored.at(-1)!.body.includes("Verdict: blocking issues"), "the model's own last line is in the last part");
  const footer = /\n\n---\nORBIT-recorded verdict: \*\*blocking issues\*\*\nReview by ORBIT job `[^`]+`\. Session: https:\/\/claude\.ai\/code\/s$/;
  const rebuilt = c.stored.map((x) => unwrapPart(x.body)).join("");
  assert.equal(rebuilt.replace(footer, ""), findings.trim(), "no gap, no repeat, nothing clipped");
  assert.ok(footer.test(rebuilt));
  const review = w.jobs.get(rid)!.review!;
  assert.equal(review.verdict, "blocking issues");
  assert.equal(review.comment!.posted, 3);
  assert.equal(review.comment!.total, 3);
  assert.equal(w.jobs.get(rid)!.summary!.text, findings, "the full review text is kept as evidence");
  assert.equal(w.jobs.get("w1")!.reviewJob!.verdict, "blocking issues");
  assert.ok(w.texts().some((t) => t.includes("review done, blocking issues") && t.includes("3 ordered comments")));
  assert.equal(jobRow(w.jobs.get("w1")!, "finished").reviewVerdict, "blocking issues");
  const row = jobRow(w.jobs.get(rid)!, "finished");
  assert.equal(row.reviewVerdict, "blocking issues");
  assert.deepEqual(row.reviewDelivery, { total: 3, posted: 3 });
});

test("a review with no Verdict line, or an ambiguous one, is recorded as such with the reason, and is never approval", async () => {
  for (const [text, verdict] of [["## Findings\n1. a.ts:3 broken\n(clipped)", "no verdict"], ["[blocking] a.ts:3\n\nVerdict: no blocking issues", "ambiguous"]] as const) {
    const c = fakeComments();
    const w = world(c.port);
    w.work("w1");
    w.jobs.record("w1", { type: "summary", status: "done", text: "## PR title\nShip it now\n\n## PR body\nB", via: "api" });
    await tick();
    await tick();
    const rid = w.jobs.get("w1")!.reviewJob!.id!;
    w.jobs.record(rid, { type: "summary", status: "done", text, via: "api" });
    await tick();
    await tick();
    const j = w.jobs.get(rid)!.review!;
    assert.equal(j.verdict, verdict);
    assert.ok(j.verdictReason);
    assert.notEqual(j.verdict, "no blocking issues");
    assert.ok(c.stored[0]!.body.includes(`ORBIT-recorded verdict: **${verdict}**`));
    assert.equal(w.jobs.get("w1")!.reviewJob!.verdictReason, j.verdictReason);
  }
});

test("a review split that fails part-way is not reported as delivered, and the retry resumes without duplicating", async () => {
  const c = fakeComments();
  const w = world(c.port);
  w.work("w1");
  w.jobs.record("w1", { type: "summary", status: "done", text: "## PR title\nShip it now\n\n## PR body\nB", via: "api" });
  await tick();
  await tick();
  const rid = w.jobs.get("w1")!.reviewJob!.id!;
  c.state.failAt.add(2);
  const findings = `${longText(130_000, "rv")}\n\nVerdict: blocking issues`;
  w.jobs.record(rid, { type: "summary", status: "done", text: findings, via: "api" });
  await tick();
  await tick();
  let comment = w.jobs.get(rid)!.review!.comment!;
  assert.equal(comment.posted, 1);
  assert.match(comment.error!, /part 2 of 3 failed/);
  assert.ok(!w.texts().some((t) => t.includes("review done, blocking issues") && !t.includes("failed")), "no success message");
  assert.ok(w.texts().some((t) => t.includes("posting the findings failed") && t.includes("1 of 3 parts")));
  assert.equal(w.jobs.get("w1")!.reviewJob!.error, comment.error);
  w.jobs.setReview(rid, { ...w.jobs.get(rid)!.review!, comment: { ...comment, lastAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString() } });
  await w.review.retry();
  comment = w.jobs.get(rid)!.review!.comment!;
  assert.equal(comment.posted, 3);
  assert.equal(comment.error, undefined);
  assert.equal(w.jobs.get("w1")!.reviewJob!.error, undefined);
  assert.deepEqual(c.stored.map((x) => /part=(\d)\/3/.exec(x.body)![1]), ["1", "2", "3"]);
  assert.equal(c.stored.map((x) => unwrapPart(x.body)).join("").split("\n\n---\nORBIT-recorded")[0], findings.trim());
});

test("a review that arrives only in part waits for git; an oversize review is reported with no verdict read from a cut-off text", async () => {
  const c = fakeComments();
  const w = world(c.port);
  w.work("w1");
  w.jobs.record("w1", { type: "summary", status: "done", text: "## PR title\nShip it now\n\n## PR body\nB", via: "api" });
  await tick();
  await tick();
  const rid = w.jobs.get("w1")!.reviewJob!.id!;
  const full = `${longText(12_000, "r")}\n\nVerdict: blocking issues`;
  w.jobs.record(rid, { type: "summary", status: "done", text: full.slice(0, 4000), textComplete: false, via: "api" });
  await tick();
  assert.equal(c.stored.length, 0, "nothing is posted or recorded from the cut-off text");
  assert.equal(w.jobs.get(rid)!.review!.verdict, undefined);
  w.jobs.completeSummary(rid, full, "abc");
  await tick();
  await tick();
  assert.equal(w.jobs.get(rid)!.review!.verdict, "blocking issues");
  assert.equal(c.stored.length, 1);

  const w2 = world(fakeComments().port);
  w2.work("w1");
  w2.jobs.record("w1", { type: "summary", status: "done", text: "## PR title\nShip it now\n\n## PR body\nB", via: "api" });
  await tick();
  await tick();
  const rid2 = w2.jobs.get("w1")!.reviewJob!.id!;
  w2.jobs.record(rid2, { type: "summary", status: "done", text: `${"z".repeat(MAX_SUMMARY_CHARS)}\nVerdict: no blocking issues`, via: "git" });
  await tick();
  const r2 = w2.jobs.get(rid2)!.review!;
  assert.equal(r2.verdict, "no verdict");
  assert.match(r2.comment!.error!, /over the limit/);
});

test("reviewParts: a short review is one comment, the findings verbatim plus a footer with the recorded verdict", () => {
  const job = { id: "r1", launch: { routine: "orbit", at: "x", sessionUrl: "https://claude.ai/code/s" } } as Job;
  const parts = reviewParts(job, "Findings.\n\nVerdict: no blocking issues", "no blocking issues");
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.body, "Findings.\n\nVerdict: no blocking issues\n\n---\nORBIT-recorded verdict: **no blocking issues**\nReview by ORBIT job `r1`. Session: https://claude.ai/code/s");
  assert.equal(reviewComment(job, "Findings.\n\nVerdict: no blocking issues"), parts[0]!.body);
});

// ---- the Jobs page ----------------------------------------------------------------------------------------------------

test("the Jobs page labels blocking, missing and ambiguous verdicts as problems, never as approval, and renders text safely", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const block = html.match(/\/\/ <verdict-label>([\s\S]*?)\/\/ <\/verdict-label>/)?.[1] ?? "";
  const label = new Function(`${block}; return verdictLabel;`)() as (v: string | undefined, r?: string) => { text: string; bad: boolean };
  assert.deepEqual(label("no blocking issues"), { text: "review verdict: no blocking issues", bad: false });
  assert.equal(label("blocking issues").bad, true);
  assert.match(label("blocking issues").text, /BLOCKING ISSUES/);
  for (const v of ["no verdict", "ambiguous", undefined]) {
    const l = label(v, "the review has no `Verdict:` line");
    assert.equal(l.bad, true);
    assert.match(l.text, /not approved/);
    assert.ok(!/no blocking issues/.test(l.text));
  }
  // The page only ever puts job text in through textContent (never innerHTML), including the full summary.
  assert.match(html, /el\("pre", \{ textContent: j\.summary\.text \}\)/);
  assert.ok(!/innerHTML\s*=\s*[^;]*summary/.test(html));
});
