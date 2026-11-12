import assert from "node:assert/strict";
import { test } from "node:test";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { githubPulls, parseRoutineRepos, prSections, prText, pullRequestOpener } from "../src/pull-requests.ts";
import type { PullPort } from "../src/pull-requests.ts";
import { jsonStore } from "../src/store.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));
function setup(pulls: PullPort | undefined, repos = "orbit=DragonflyAI-sh/orbit") {
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 1), notify);
  pullRequestOpener(jobs, parseRoutineRepos(repos), pulls, notify);
  const texts = () => notify.recent().map((n) => n.text);
  return { jobs, notify, texts };
}
const launched = (jobs: ReturnType<typeof setup>["jobs"], id: string, routine = "orbit") => {
  jobs.register(id);
  jobs.setLaunch(id, { routine, at: new Date().toISOString(), sessionUrl: `https://claude.ai/code/${id}` });
};

test("ORBIT_ROUTINE_REPOS parses name=owner/repo pairs and drops malformed ones", () => {
  const m = parseRoutineRepos("orbit=DragonflyAI-sh/orbit, noodle = a/b ,bad=nope,=x/y,evil=a/b/../c");
  assert.deepEqual([...m], [["orbit", "DragonflyAI-sh/orbit"], ["noodle", "a/b"]]);
  assert.equal(parseRoutineRepos(undefined).size, 0);
});

test("title and body come from the PR sections; the body may have its own headings", () => {
  const s = "Did it.\n\n## PR title\nAdd the jobs page\n\n## Verified\nnot this\n\n## PR body\n## What\nA page.\n\n## Why\nBecause.\n";
  assert.deepEqual(prSections(s), { title: "Add the jobs page", body: "## What\nA page.\n\n## Why\nBecause." });
  // Body first, title after: the body stops at the title heading.
  assert.deepEqual(prSections("## PR body\nB\n## PR title\nT\n"), { title: "T", body: "B" });
  assert.deepEqual(prSections("no sections"), { title: undefined, body: undefined });
});

test("without sections the title is made from the summary (never 'ORBIT job <id>') and says so; the body is the whole summary; the footer links the session", () => {
  const job = { id: "orbit-1", launch: { routine: "orbit", at: "x", sessionUrl: "https://claude.ai/code/s1" } } as Job;
  const t = prText(job, "Everything I did.\n\nMore detail.");
  assert.equal(t.title, "Everything I did.");
  assert.equal(t.titleSource, "summary-first-line");
  assert.match(t.body, /^Everything I did\./);
  assert.match(t.body, /Opened by ORBIT for job `orbit-1`\. Session: https:\/\/claude\.ai\/code\/s1$/);
  const bare = prText(job, "## PR body\n\n");
  assert.equal(bare.titleSource, "job-routine");
  assert.equal(bare.title, "orbit: changes from job orbit-1");
  assert.equal(prText(job, "## PR title\nReal title here\n\n## PR body\nBody").titleSource, "pr-title-section");
});

test("a done summary opens one PR, records its URL, notifies, and never opens a second", async () => {
  const opened: string[][] = [];
  const { jobs, texts } = setup({ open: async (repo, job, title, body) => (opened.push([repo, job, title, body]), { status: "opened", url: "https://github.com/DragonflyAI-sh/orbit/pull/7" }) });
  launched(jobs, "j1");
  jobs.record("j1", { type: "summary", status: "done", text: "## PR title\nDo it\n\n## PR body\nBody here", via: "api" });
  await tick();
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].slice(0, 3), ["DragonflyAI-sh/orbit", "j1", "Do it"]);
  assert.match(opened[0][3], /^Body here\n\n---\nOpened by ORBIT/);
  assert.equal(jobs.get("j1")!.pr?.url, "https://github.com/DragonflyAI-sh/orbit/pull/7");
  assert.ok(texts().includes("PR ready: https://github.com/DragonflyAI-sh/orbit/pull/7"));
  // The same summary arriving again (say, from git) does nothing.
  jobs.record("j1", { type: "summary", status: "done", text: "again", via: "git" });
  await tick();
  assert.equal(opened.length, 1);
});

test("two summaries at once still open one PR", async () => {
  let n = 0;
  const { jobs } = setup({ open: async () => (n++, await tick(), { status: "opened", url: "https://github.com/a/b/pull/1" }) });
  launched(jobs, "j2");
  jobs.record("j2", { type: "summary", status: "done", text: "x" });
  jobs.record("j2", { type: "summary", status: "done", text: "x", via: "git" });
  await tick();
  await tick();
  assert.equal(n, 1);
});

test("no branch, a non-done summary, an unmapped routine, or no launch means no PR and no notification", async () => {
  let calls = 0;
  const { jobs, texts } = setup({ open: async () => (calls++, { status: "no-branch" as const }) });
  launched(jobs, "nb");
  jobs.record("nb", { type: "summary", status: "done", text: "research only" });
  launched(jobs, "bl");
  jobs.record("bl", { type: "summary", status: "blocked", text: "need input" });
  launched(jobs, "um", "other");
  jobs.record("um", { type: "summary", status: "done", text: "x" });
  jobs.register("manual");
  jobs.record("manual", { type: "summary", status: "done", text: "x" });
  await tick();
  assert.equal(calls, 1, "only the mapped, done, launched job asked GitHub");
  assert.equal(jobs.get("nb")!.pr, undefined);
  assert.ok(!texts().some((t) => t.includes("PR ready") || t.includes("pull request")));
});

test("a failure is recorded and notified once, and is not retried", async () => {
  let calls = 0;
  const { jobs, texts } = setup({ open: async () => { calls++; throw new Error("Opening the pull request returned HTTP 422: No commits between main and orbit/j3"); } });
  launched(jobs, "j3");
  jobs.record("j3", { type: "summary", status: "done", text: "x" });
  await tick();
  assert.match(jobs.get("j3")!.pr!.error!, /HTTP 422/);
  assert.ok(texts().some((t) => t.includes("could not open its pull request") && t.includes("HTTP 422")));
  jobs.record("j3", { type: "summary", status: "done", text: "x", via: "git" });
  await tick();
  assert.equal(calls, 1);
});

test("with a mapped repo but no credential, the job records why and Rai is told", async () => {
  const { jobs, texts } = setup(undefined);
  launched(jobs, "j4");
  jobs.record("j4", { type: "summary", status: "done", text: "x" });
  await tick();
  assert.match(jobs.get("j4")!.pr!.error!, /no pull-request credential/);
  assert.ok(texts().some((t) => t.includes("no pull-request credential")));
});

// ---- the GitHub calls, with a fake fetch

function fakeGithub(routes: Record<string, { status: number; json?: unknown }>) {
  const seen: { method: string; url: string; auth: string; body?: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const h = init.headers as Record<string, string>;
    seen.push({ method: init.method ?? "GET", url, auth: h.authorization, body: init.body as string | undefined });
    const r = routes[`${init.method ?? "GET"} ${new URL(url).pathname}`] ?? { status: 500 };
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as typeof fetch;
  return { seen, fetcher };
}
const REF = "GET /repos/o/r/git/ref/heads/orbit/j";

test("githubPulls: no branch means no PR is opened", async () => {
  const g = fakeGithub({ [REF]: { status: 404 } });
  assert.deepEqual(await githubPulls("TOK", g.fetcher).open("o/r", "j", "t", "b"), { status: "no-branch" });
  assert.equal(g.seen.length, 1);
});

test("githubPulls: opens from orbit/<job> to main with the title and body, using the bearer token", async () => {
  const g = fakeGithub({ [REF]: { status: 200 }, "GET /repos/o/r/pulls": { status: 200, json: [] }, "POST /repos/o/r/pulls": { status: 201, json: { html_url: "https://github.com/o/r/pull/3" } } });
  assert.deepEqual(await githubPulls("TOK", g.fetcher).open("o/r", "j", "T", "B"), { status: "opened", url: "https://github.com/o/r/pull/3" });
  const post = g.seen.find((s) => s.method === "POST")!;
  assert.deepEqual(JSON.parse(post.body!), { title: "T", head: "orbit/j", base: "main", body: "B" });
  assert.ok(g.seen.every((s) => s.auth === "Bearer TOK"));
  assert.match(g.seen[1].url, /head=o%3Aorbit%2Fj/);
});

test("githubPulls: an existing PR for the branch is returned, not duplicated", async () => {
  const g = fakeGithub({ [REF]: { status: 200 }, "GET /repos/o/r/pulls": { status: 200, json: [{ html_url: "https://github.com/o/r/pull/2", head: { ref: "orbit/j", repo: { full_name: "o/r" } } }] } });
  assert.deepEqual(await githubPulls("TOK", g.fetcher).open("o/r", "j", "T", "B"), { status: "exists", url: "https://github.com/o/r/pull/2", head: { ref: "orbit/j", repo: "o/r" } });
  assert.ok(!g.seen.some((s) => s.method === "POST"));
});

test("githubPulls: an API error says what failed, and never contains the token", async () => {
  const g = fakeGithub({ [REF]: { status: 200 }, "GET /repos/o/r/pulls": { status: 200, json: [] }, "POST /repos/o/r/pulls": { status: 403, json: { message: "Resource not accessible by personal access token" } } });
  await assert.rejects(githubPulls("SECRET-TOKEN", g.fetcher).open("o/r", "j", "T", "B"), (e: Error) => /HTTP 403: Resource not accessible/.test(e.message) && !e.message.includes("SECRET-TOKEN"));
});

test("githubPulls: the head commit GitHub reports is returned for opened and existing PRs, and only when it is a full SHA", async () => {
  const sha = "ab".repeat(20);
  const opened = fakeGithub({ [REF]: { status: 200 }, "GET /repos/o/r/pulls": { status: 200, json: [] }, "POST /repos/o/r/pulls": { status: 201, json: { html_url: "https://github.com/o/r/pull/3", head: { sha } } } });
  assert.deepEqual(await githubPulls("TOK", opened.fetcher).open("o/r", "j", "T", "B"), { status: "opened", url: "https://github.com/o/r/pull/3", headSha: sha });
  const existing = fakeGithub({ [REF]: { status: 200 }, "GET /repos/o/r/pulls": { status: 200, json: [{ html_url: "https://github.com/o/r/pull/2", head: { ref: "orbit/j", sha, repo: { full_name: "o/r" } } }] } });
  assert.equal(((await githubPulls("TOK", existing.fetcher).open("o/r", "j", "T", "B")) as { headSha?: string }).headSha, sha);
  const odd = fakeGithub({ [REF]: { status: 200 }, "GET /repos/o/r/pulls": { status: 200, json: [] }, "POST /repos/o/r/pulls": { status: 201, json: { html_url: "https://github.com/o/r/pull/3", head: { sha: "ABC" } } } });
  assert.equal("headSha" in ((await githubPulls("TOK", odd.fetcher).open("o/r", "j", "T", "B")) as object), false);
});
