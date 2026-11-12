import { credential } from "./launcher.ts";
import type { JobLauncher } from "./job-launch.ts";
import type { Job, Jobs, Verdict } from "./jobs.ts";
import type { Notifier } from "./notify.ts";
import { MAX_DELIVERY_ATTEMPTS, githubCaller, httpFailure, postParts } from "./pull-requests.ts";
import type { CommentPort } from "./pull-requests.ts";
import { PART_CHARS, partMarker, splitText, wrapPart } from "./split-text.ts";

export type { CommentPort };

// When ORBIT opens a PR for a `work` job, it starts one review-only job on the same Routine, then posts the review's
// findings as a comment on that PR. The review never opens a PR or starts a review of its own. Merging stays Rai's.

type Fetch = typeof fetch;
const RETRY_GAP_MS = 2 * 60_000;
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;

export function reviewBrief(workJob: string, repo: string, prUrl: string): string {
  return `## Goal
Review pull request ${prUrl} (branch \`orbit/${workJob}\` in ${repo}, opened by job ${workJob}). This is a review-only job.

## Steps
1. Read the diff of \`orbit/${workJob}\` against \`main\` in ${repo}, and the PR description.
2. Run the typecheck and the tests on that branch.
3. Look for correctness bugs, security problems, and claims in the PR body that the code does not back up.

## Constraints
- Push nothing to ${repo}: no commits, no branches. Do not open a pull request and do not comment on the PR; ORBIT posts your findings.
- Do not change the code. If something needs a fix, say so in the findings.

## Summary
Write the findings in your summary under a \`## Findings\` heading, most serious first, each with file and line. If there are none, say so under that heading.
End the summary with exactly one last line: \`Verdict: no blocking issues\` or \`Verdict: blocking issues\`.
`;
}

export type VerdictResult = { verdict: Verdict; reason?: string };

// Findings the reviewer marked as blocking in a way that is easy to see: [blocking], **blocker**, "Severity: blocking", "Blocking: ...".
const BLOCKING_MARK = /\[(?:blocking|blocker)\]|\*\*(?:blocking|blocker)\*\*|severity\s*[:=]\s*\W*(?:blocking|blocker)\b|^\s*(?:[-*]|\d+[.)])?\s*(?:blocking|blocker)\s*:/im;

// The verdict, read from every `Verdict:` line of the summary, never guessed:
//  - no `Verdict:` line: "no verdict";
//  - the lines disagree, a value is not one of the two allowed, or the verdict says "no blocking issues" while a finding is marked
//    blocking: "ambiguous". Either way the reason is recorded, and neither is ever approval.
export function readVerdict(summary: string): VerdictResult {
  const lines = summary.split("\n").map((l) => l.trim().replace(/^[*_`]+|[*_`]+$/g, "").trim());
  const verdictLines = lines.filter((l) => /^verdict:/i.test(l));
  if (!verdictLines.length) return { verdict: "no verdict", reason: "the review has no `Verdict:` line" };
  const values = [...new Set(verdictLines.map((l) => l.slice(l.indexOf(":") + 1).trim().toLowerCase().replace(/\.$/, "")))];
  const bad = values.find((v) => v !== "no blocking issues" && v !== "blocking issues");
  if (bad !== undefined) return { verdict: "ambiguous", reason: `unrecognised verdict value: "${bad.slice(0, 60)}"` };
  if (values.length > 1) return { verdict: "ambiguous", reason: "the review has conflicting `Verdict:` lines" };
  const v = values[0] as "no blocking issues" | "blocking issues";
  if (v === "no blocking issues" && BLOCKING_MARK.test(lines.filter((l) => !/^verdict:/i.test(l)).join("\n"))) {
    return { verdict: "ambiguous", reason: "the verdict says no blocking issues, but a finding is marked blocking" };
  }
  return { verdict: v };
}

export const parseVerdict = (summary: string): Verdict => readVerdict(summary).verdict;

// The comment bodies for a review, in order. Up to PART_CHARS characters of findings fit in one comment, which is then the findings
// verbatim plus a footer; longer findings are split, and every part says its place and the verdict ORBIT recorded, so a reader of any
// part sees it. The parts, unwrapped and joined, are the whole review.
export function reviewParts(job: Job, summary: string, verdict: Verdict): { marker: string; body: string }[] {
  const session = job.launch?.sessionUrl;
  const footer = `\n\n---\nORBIT-recorded verdict: **${verdict}**\nReview by ORBIT job \`${job.id}\`${session ? `. Session: ${session}` : "."}`;
  const chunks = splitText(summary.trim(), PART_CHARS);
  if (chunks.length === 1) return [{ marker: partMarker(job.id, "review", 1, 1), body: `${chunks[0]}${footer}` }];
  return chunks.map((c, i) => {
    const marker = partMarker(job.id, "review", i + 1, chunks.length);
    return { marker, body: wrapPart(marker, `Part ${i + 1}/${chunks.length} of the review · ORBIT-recorded verdict: ${verdict}`, `${c}${i === chunks.length - 1 ? footer : ""}`) };
  });
}

export const reviewComment = (job: Job, summary: string, verdict: Verdict = parseVerdict(summary)): string => reviewParts(job, summary, verdict).map((p) => p.body).join("\n\n");

export function githubComments(token: string, fetcher: Fetch = fetch): CommentPort {
  const call = githubCaller(token, fetcher);
  return {
    async post(repo, pull, body) {
      const res = await call("POST", `/repos/${repo}/issues/${pull}/comments`, { body });
      if (!res.ok) return httpFailure("Posting the review comment", res);
      const made = (await res.json()) as { html_url?: string };
      if (!made.html_url) throw new Error("GitHub posted the comment but returned no URL");
      return made.html_url;
    },
    // Looks through the PR's comments (up to 1,000) for one that carries the marker.
    async find(repo, pull, marker) {
      for (let page = 1; page <= 10; page++) {
        const res = await call("GET", `/repos/${repo}/issues/${pull}/comments?per_page=100&page=${page}`);
        if (!res.ok) return httpFailure("Listing the PR comments", res);
        const list = (await res.json()) as { body?: string; html_url?: string }[];
        const hit = list.find((c) => typeof c.body === "string" && c.body.includes(marker));
        if (hit?.html_url) return hit.html_url;
        if (list.length < 100) return undefined;
      }
      return undefined;
    },
  };
}

export function reviewer(jobs: Jobs, launch: JobLauncher, comments: CommentPort | undefined, notify: Notifier, now: () => Date = () => new Date()) {
  const unfinished = (work: Job, why: string) => {
    const prUrl = work.pr?.url ?? "(no PR)";
    notify.send(`PR ${prUrl}: the review did not complete: ${why}`, false);
  };

  // Called once a PR was opened (not found) for a job. Starts at most one review per work job.
  const start = async (work: Job, prUrl: string, headSha?: string): Promise<void> => {
    if (work.kind === "review" || work.reviewJob) return;
    const match = PR_URL.exec(prUrl);
    const routine = work.launch?.routine;
    if (!match || !routine) return;
    const at = now().toISOString();
    jobs.setReviewJob(work.id, { at }); // claims the review synchronously, before any await
    try {
      const result = await launch(routine, reviewBrief(work.id, match[1], prUrl), { of: work.id, prUrl, repo: match[1], ...(headSha && /^[0-9a-f]{40}$/.test(headSha) ? { reviewedSha: headSha } : {}) });
      const id = (result.body as { id?: string; job?: { id?: string } }).id ?? (result.body as { job?: { id?: string } }).job?.id;
      if (result.code >= 300) {
        const error = (result.body as { error?: string }).error ?? `HTTP ${result.code}`;
        jobs.setReviewJob(work.id, { id, at, error });
        unfinished(jobs.get(work.id) ?? work, `it could not be launched: ${error}`);
        return;
      }
      jobs.setReviewJob(work.id, { id, at });
    } catch (err) {
      const error = err instanceof Error ? err.message : "unknown error";
      jobs.setReviewJob(work.id, { at, error });
      unfinished(jobs.get(work.id) ?? work, `it could not be launched: ${error}`);
    }
  };

  type Comment = NonNullable<NonNullable<Job["review"]>["comment"]>;
  const inFlight = new Set<string>();

  // Posts the review's comment parts, resuming after the last one recorded. "Posted" is claimed only when every part is on GitHub; a
  // part already on the PR (found by its marker) is not posted again. Failures record how far it got and are retried by retry().
  const deliver = async (jobId: string): Promise<void> => {
    const job = jobs.get(jobId);
    const review = job?.review;
    const text = job?.summary?.state === "complete" ? job.summary.text : undefined;
    if (!job || !review?.comment || !review.verdict || text === undefined || inFlight.has(jobId)) return;
    inFlight.add(jobId);
    try {
      const at = review.comment.at;
      const verdict = review.verdict;
      const workId = review.of;
      const outcome = (change: Partial<NonNullable<Job["reviewJob"]>>) => jobs.setReviewJob(workId, { ...jobs.get(workId)?.reviewJob, id: jobId, at: jobs.get(workId)?.reviewJob?.at ?? at, ...change });
      const save = (c: Comment) => {
        jobs.setReview(jobId, { ...jobs.get(jobId)!.review!, comment: c });
        outcome({ commentUrl: c.url, error: c.error });
      };
      const match = PR_URL.exec(review.prUrl);
      if (!comments || !match) {
        const error = !comments ? "no pull-request credential (orbit.github-orbit-prs) is installed" : "the pull request address is not a GitHub PR";
        save({ at, error });
        notify.send(`PR ${review.prUrl}: review done, ${verdict}, but its findings were not posted: ${error}. See job ${jobId}.`, false);
        return;
      }
      const parts = reviewParts(job, text, verdict);
      const cur = review.comment;
      const urls = [...(cur.urls ?? [])];
      let state: Comment = { ...cur, total: parts.length, posted: cur.posted ?? 0, urls };
      const result = await postParts(comments, match[1]!, Number(match[2]), parts, state.posted!, (i, url) => {
        urls[i] = url;
        state = { ...state, posted: i + 1, url: urls[0], urls: [...urls] };
        save(state);
      });
      if (result.error) {
        const attempts = (cur.attempts ?? 0) + 1;
        const error = parts.length > 1 ? `part ${result.failedAt! + 1} of ${parts.length} failed: ${result.error}` : result.error;
        save({ ...state, error, attempts, lastAttemptAt: new Date().toISOString() });
        if (attempts === 1 || attempts >= MAX_DELIVERY_ATTEMPTS) {
          notify.send(`PR ${review.prUrl}: review done, ${verdict}, but posting the findings failed: ${error}${parts.length > 1 ? ` (${state.posted} of ${parts.length} parts are posted)` : ""}. ${attempts >= MAX_DELIVERY_ATTEMPTS ? "ORBIT has stopped retrying" : "ORBIT will retry"}; the full review is in job ${jobId}.`, attempts >= MAX_DELIVERY_ATTEMPTS);
        }
        return;
      }
      const { error: _e, ...ok } = state;
      save(ok);
      notify.send(`PR ${review.prUrl}: review done, ${verdict}${parts.length > 1 ? ` (findings posted as ${parts.length} ordered comments)` : ""}`, false);
    } finally {
      inFlight.delete(jobId);
    }
  };

  const finish = async (job: Job, summary: string): Promise<void> => {
    const review = job.review;
    if (!review || review.comment) return;
    const at = now().toISOString();
    const workId = review.of;
    const outcome = (change: Partial<NonNullable<Job["reviewJob"]>>) => jobs.setReviewJob(workId, { ...jobs.get(workId)?.reviewJob, id: job.id, at: jobs.get(workId)?.reviewJob?.at ?? at, ...change });
    if (job.state !== "done") {
      const error = `the review job ${job.state === "blocked" ? "is blocked" : "failed"}`;
      jobs.setReview(job.id, { ...review, comment: { at, error } });
      outcome({ error });
      notify.send(`PR ${review.prUrl}: the review did not complete: ${error}. Job ${job.id}.`, false);
      return;
    }
    if (job.summary?.state === "oversize") {
      // Too long to hold whole: reported as such, never as a verdict read from a cut-off text.
      const error = `the review is ${job.summary.chars} characters, over the limit ORBIT keeps whole; its findings were not posted. The full text is in git (orbit/${job.id}).`;
      const reason = "the review was too large for ORBIT to read its verdict";
      jobs.setReview(job.id, { ...review, verdict: "no verdict", verdictReason: reason, comment: { at, error } });
      outcome({ verdict: "no verdict", verdictReason: reason, error });
      notify.send(`PR ${review.prUrl}: review done, no verdict, but ${error}`, true);
      return;
    }
    const { verdict, reason } = readVerdict(summary);
    // The structured verdict is stored before anything is posted, and claims the posting before any await.
    jobs.setReview(job.id, { ...review, verdict, ...(reason ? { verdictReason: reason } : {}), comment: { at } });
    outcome({ verdict, ...(reason ? { verdictReason: reason } : {}) });
    await deliver(job.id);
  };

  jobs.onSummary((job, fullText, complete) => {
    if (job.kind !== "review") return;
    // A partial summary waits for git to complete it; this listener then runs again with the whole text.
    if (!complete && job.summary?.state !== "oversize") return;
    void finish(job, fullText ?? "").catch((err) => console.error(JSON.stringify({ at: new Date().toISOString(), review: String(err) })));
  });
  return {
    start,
    // Retries comment parts that failed, at most MAX_DELIVERY_ATTEMPTS times each, RETRY_GAP_MS apart.
    async retry(): Promise<void> {
      for (const job of jobs.all()) {
        const c = job.review?.comment;
        if (!c?.error || !c.total || (c.posted ?? 0) >= c.total || (c.attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS) continue;
        if (c.lastAttemptAt && now().getTime() - new Date(c.lastAttemptAt).getTime() < RETRY_GAP_MS) continue;
        await deliver(job.id).catch(() => {});
      }
    },
  };
}

export function selectComments(env: NodeJS.ProcessEnv): CommentPort | undefined {
  const token = credential(env, "orbit.github-orbit-prs");
  return token ? githubComments(token) : undefined;
}
