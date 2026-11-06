import assert from "node:assert/strict";
import { test } from "node:test";
import { jobLauncher } from "../src/job-launch.ts";
import { jobRow } from "../src/job-view.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import type { ControlRepo } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { parseRoutineRepos, pullRequestOpener } from "../src/pull-requests.ts";
import type { PullPort } from "../src/pull-requests.ts";
import { githubComments, parseVerdict, reviewBrief, reviewer } from "../src/review.ts";
import type { CommentPort } from "../src/review.ts";
import { jsonStore } from "../src/store.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));
const PR = "https://github.com/DragonflyAI-sh/orbit/pull/7";

function setup(opts: { head?: { ref: string; repo: string } | null; pull?: "opened" | "exists"; comments?: CommentPort | undefined; fire?: () => Promise<{ sessionId: string; sessionUrl: string }> } = {}) {
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 1), notify);
  const briefs: { id: string; text: string }[] = [];
  const fired: string[] = [];
  const control = { pushBrief: async (id: string, text: string) => (briefs.push({ id, text }), { branch: `orbit/${id}`, commit: "c1" }) } as unknown as ControlRepo;
  const routine = { name: "orbit", fire: opts.fire ?? (async (text: string) => (fired.push(text), { sessionId: "s", sessionUrl: "https://claude.ai/code/s" })) };
  const launch = jobLauncher({ jobs, control, routines: new Map([["orbit", routine]]), notify, publicJobUrl: "https://api.example" });
  const posted: { repo: string; pull: number; body: string }[] = [];
  const comments: CommentPort | undefined = "comments" in opts ? opts.comments : { post: async (repo, pull, body) => (posted.push({ repo, pull, body }), `${PR}#issuecomment-1`) };
  const review = reviewer(jobs, launch, comments, notify);
  let opens = 0;
  const pulls: PullPort = { open: async () => (opens++, { status: opts.pull ?? "opened", url: PR, ...(opts.pull === "exists" ? { head: opts.head === null ? undefined : (opts.head ?? { ref: "orbit/w1", repo: "DragonflyAI-sh/orbit" }) } : {}) }) };
  pullRequestOpener(jobs, parseRoutineRepos("orbit=DragonflyAI-sh/orbit"), pulls, notify, () => new Date(), (job, url) => void review.start(job, url));
  const texts = () => notify.recent().map((n) => n.text);
  const reviewId = (work: string) => jobs.get(work)!.reviewJob!.id!;
  return { jobs, notify, texts, briefs, fired, posted, opens: () => opens, reviewId };
}
const finishWork = async (s: ReturnType<typeof setup>, id = "w1") => {
  s.jobs.register(id);
  s.jobs.setLaunch(id, { routine: "orbit", at: new Date().toISOString() });
  s.jobs.record(id, { type: "summary", status: "done", text: "## PR title\nT\n\n## PR body\nB" });
  await tick();
  await tick();
};
const FINDINGS = "Looked.\n\n## Findings\n1. src/a.ts:3 off by one\n\nVerdict: blocking issues";

test("parseVerdict reads the last Verdict line and does not guess", () => {
  assert.equal(parseVerdict("## Findings\nnone\n\nVerdict: no blocking issues"), "no blocking issues");
  assert.equal(parseVerdict("x\n**Verdict: Blocking issues.**\n"), "blocking issues");
  assert.equal(parseVerdict("Verdict: blocking issues\nlater\nVerdict: no blocking issues"), "no blocking issues");
  assert.equal(parseVerdict("Verdict: maybe"), "no verdict");
  assert.equal(parseVerdict("no line at all"), "no verdict");
});

test("the brief names the PR, the branch, and forbids pushing to the project repo", () => {
  const b = reviewBrief("w1", "DragonflyAI-sh/orbit", PR);
  assert.match(b, /orbit\/w1/);
  assert.ok(b.includes(PR));
  assert.match(b, /Push nothing/);
  assert.match(b, /## Findings/);
  assert.match(b, /Verdict: no blocking issues/);
  assert.match(b, /Verdict: blocking issues/);
});

test("an opened PR starts exactly one review job on the same routine, marked as a review of the work job", async () => {
  const s = setup();
  await finishWork(s);
  assert.equal(s.briefs.length, 1);
  const rev = s.jobs.get(s.reviewId("w1"))!;
  assert.equal(rev.kind, "review");
  assert.deepEqual({ of: rev.review!.of, prUrl: rev.review!.prUrl, repo: rev.review!.repo }, { of: "w1", prUrl: PR, repo: "DragonflyAI-sh/orbit" });
  assert.equal(rev.launch?.routine, "orbit");
  assert.match(s.briefs[0].text, /orbit\/w1/);
  assert.match(s.fired[0], /Job id: orbit-/);
  // A second summary for the work job changes nothing.
  s.jobs.record("w1", { type: "summary", status: "done", text: "again", via: "git" });
  await tick();
  assert.equal(s.briefs.length, 1);
  assert.equal(s.opens(), 1);
});

test("a PR the runner opened (it already existed) on the job's own branch gets one review, and Rai is told who opened it", async () => {
  const s = setup({ pull: "exists" });
  await finishWork(s);
  assert.equal(s.briefs.length, 1);
  assert.ok(s.jobs.get("w1")!.reviewJob?.id);
  assert.equal(s.texts().filter((t) => t.includes("opened by the runner, not by ORBIT")).length, 1);
  s.jobs.record("w1", { type: "summary", status: "done", text: "again", via: "git" });
  await tick();
  await tick();
  assert.equal(s.briefs.length, 1, "still one review");
  assert.equal(s.opens(), 1);
});

test("an existing PR that is not from the job's own branch in the mapped repo gets no review", async () => {
  for (const head of [{ ref: "orbit/other", repo: "DragonflyAI-sh/orbit" }, { ref: "orbit/w1", repo: "someone/orbit" }, { ref: "main", repo: "DragonflyAI-sh/orbit" }, null]) {
    const s = setup({ pull: "exists", head });
    await finishWork(s);
    assert.equal(s.briefs.length, 0, JSON.stringify(head));
    assert.equal(s.jobs.get("w1")!.reviewJob, undefined);
    assert.ok(!s.texts().some((t) => t.includes("opened by the runner")));
  }
});

test("a review job never opens a PR and never starts a review, even when it finishes done", async () => {
  const s = setup();
  await finishWork(s);
  const id = s.reviewId("w1");
  s.jobs.record(id, { type: "summary", status: "done", text: FINDINGS });
  await tick();
  await tick();
  assert.equal(s.opens(), 1, "only the work job's PR was opened");
  assert.equal(s.jobs.get(id)!.pr, undefined);
  assert.equal(s.briefs.length, 1, "no second review");
});

test("the findings are posted once as a PR comment with a footer, recorded on both jobs, and Rai is told once", async () => {
  const s = setup();
  await finishWork(s);
  const id = s.reviewId("w1");
  s.jobs.record(id, { type: "summary", status: "done", text: FINDINGS });
  s.jobs.record(id, { type: "summary", status: "done", text: FINDINGS, via: "git" });
  await tick();
  await tick();
  assert.equal(s.posted.length, 1);
  assert.deepEqual([s.posted[0].repo, s.posted[0].pull], ["DragonflyAI-sh/orbit", 7]);
  assert.match(s.posted[0].body, /^Looked\./);
  assert.match(s.posted[0].body, new RegExp(`Review by ORBIT job \`${id}\`. Session: https://claude.ai/code/s$`));
  const url = `${PR}#issuecomment-1`;
  assert.equal(s.jobs.get(id)!.review!.comment!.url, url);
  assert.equal(s.jobs.get("w1")!.reviewJob!.commentUrl, url);
  assert.equal(s.jobs.get("w1")!.reviewJob!.verdict, "blocking issues");
  assert.equal(s.texts().filter((t) => t === `PR ${PR}: review done, blocking issues`).length, 1);
});

test("a failed post is recorded and notified, and not retried", async () => {
  let calls = 0;
  const s = setup({ comments: { post: async () => { calls++; throw new Error("Posting the review comment returned HTTP 403: nope"); } } });
  await finishWork(s);
  const id = s.reviewId("w1");
  s.jobs.record(id, { type: "summary", status: "done", text: FINDINGS });
  s.jobs.record(id, { type: "summary", status: "done", text: FINDINGS, via: "git" });
  await tick();
  await tick();
  assert.equal(calls, 1);
  assert.match(s.jobs.get("w1")!.reviewJob!.error!, /HTTP 403/);
  assert.ok(s.texts().some((t) => t.includes("posting the findings failed") && t.includes("HTTP 403")));
});

test("without a credential the findings are not posted and Rai is told why", async () => {
  const s = setup({ comments: undefined });
  await finishWork(s);
  s.jobs.record(s.reviewId("w1"), { type: "summary", status: "done", text: FINDINGS });
  await tick();
  assert.match(s.jobs.get("w1")!.reviewJob!.error!, /no pull-request credential/);
  assert.ok(s.texts().some((t) => t.includes("were not posted")));
});

test("a review that fails or is blocked posts nothing and Rai is told it did not complete", async () => {
  const s = setup();
  await finishWork(s);
  s.jobs.record(s.reviewId("w1"), { type: "summary", status: "failed", text: "could not run tests" });
  await tick();
  assert.equal(s.posted.length, 0);
  assert.ok(s.texts().some((t) => t.startsWith(`PR ${PR}: the review did not complete`)));
  assert.ok(s.jobs.get("w1")!.reviewJob!.error);
});

test("a review that cannot launch is recorded and notified, and the work job's PR is untouched", async () => {
  const s = setup({ fire: async () => { throw new Error("HTTP 500"); } });
  await finishWork(s);
  assert.match(s.jobs.get("w1")!.reviewJob!.error!, /routine not fired/);
  assert.equal(s.jobs.get("w1")!.pr!.url, PR);
  assert.ok(s.texts().some((t) => t.includes("the review did not complete") && t.includes("could not be launched")));
  assert.equal(s.briefs.length, 1, "no retry loop");
});

test("the jobs page rows show kind, and a work job's verdict and comment link", async () => {
  const s = setup();
  await finishWork(s);
  const id = s.reviewId("w1");
  s.jobs.record(id, { type: "summary", status: "done", text: FINDINGS });
  await tick();
  await tick();
  const work = jobRow(s.jobs.get("w1")!, "finished");
  assert.equal(work.kind, "work");
  assert.equal(work.reviewVerdict, "blocking issues");
  assert.equal(work.reviewCommentUrl, `${PR}#issuecomment-1`);
  const rev = jobRow(s.jobs.get(id)!, "finished");
  assert.equal(rev.kind, "review");
  assert.equal(rev.reviewOf, "w1");
});

test("githubComments posts to the issue-comments API with the bearer token and returns the comment URL", async () => {
  const seen: { url: string; method?: string; auth: string; body: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method, auth: (init.headers as Record<string, string>).authorization, body: String(init.body) });
    return new Response(JSON.stringify({ html_url: "https://github.com/o/r/pull/3#issuecomment-9" }), { status: 201 });
  }) as typeof fetch;
  assert.equal(await githubComments("TOK", fetcher).post("o/r", 3, "hi"), "https://github.com/o/r/pull/3#issuecomment-9");
  assert.deepEqual([seen[0].url, seen[0].method, seen[0].auth, JSON.parse(seen[0].body)], ["https://api.github.com/repos/o/r/issues/3/comments", "POST", "Bearer TOK", { body: "hi" }]);
  const bad = (async () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(githubComments("SECRET", bad).post("o/r", 3, "x"), (e: Error) => /HTTP 403: Forbidden/.test(e.message) && !e.message.includes("SECRET"));
});
