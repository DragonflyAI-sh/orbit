import { credential } from "./launcher.ts";
import type { JobLauncher } from "./job-launch.ts";
import type { Job, Jobs, Verdict } from "./jobs.ts";
import type { Notifier } from "./notify.ts";
import { githubCaller, httpFailure } from "./pull-requests.ts";

// When ORBIT opens a PR for a `work` job, it starts one review-only job on the same Routine, then posts the review's
// findings as a comment on that PR. The review never opens a PR or starts a review of its own. Merging stays Rai's.

type Fetch = typeof fetch;
const MAX_COMMENT = 60000;
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

// The verdict is the last `Verdict:` line of the summary; anything else is "no verdict" rather than a guess.
export function parseVerdict(summary: string): Verdict {
  const lines = summary.split("\n").map((l) => l.trim().replace(/^[*_`]+|[*_`]+$/g, "").trim());
  const line = [...lines].reverse().find((l) => /^verdict:/i.test(l));
  const v = line?.slice(line.indexOf(":") + 1).trim().toLowerCase().replace(/\.$/, "");
  return v === "no blocking issues" || v === "blocking issues" ? v : "no verdict";
}

export function reviewComment(job: Job, summary: string): string {
  const session = job.launch?.sessionUrl;
  const footer = `\n\n---\nReview by ORBIT job \`${job.id}\`${session ? `. Session: ${session}` : "."}`;
  return `${summary.trim().slice(0, MAX_COMMENT)}${footer}`;
}

export type CommentPort = {
  // Posts an issue comment on the PR and returns its URL.
  post(repo: string, pull: number, body: string): Promise<string>;
};

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
  };
}

export function reviewer(jobs: Jobs, launch: JobLauncher, comments: CommentPort | undefined, notify: Notifier, now: () => Date = () => new Date()) {
  const unfinished = (work: Job, why: string) => {
    const prUrl = work.pr?.url ?? "(no PR)";
    notify.send(`PR ${prUrl}: the review did not complete: ${why}`, false);
  };

  // Called once a PR was opened (not found) for a job. Starts at most one review per work job.
  const start = async (work: Job, prUrl: string): Promise<void> => {
    if (work.kind === "review" || work.reviewJob) return;
    const match = PR_URL.exec(prUrl);
    const routine = work.launch?.routine;
    if (!match || !routine) return;
    const at = now().toISOString();
    jobs.setReviewJob(work.id, { at }); // claims the review synchronously, before any await
    try {
      const result = await launch(routine, reviewBrief(work.id, match[1], prUrl), { of: work.id, prUrl, repo: match[1] });
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
    const verdict = parseVerdict(summary);
    jobs.setReview(job.id, { ...review, verdict, comment: { at } }); // claims the posting before any await
    outcome({ verdict });
    const done = (url: string | undefined, error?: string) => {
      jobs.setReview(job.id, { ...review, verdict, comment: { at, url, error } });
      outcome({ verdict, commentUrl: url, error });
    };
    const match = PR_URL.exec(review.prUrl);
    if (!comments || !match) {
      const error = !comments ? "no pull-request credential (orbit.github-orbit-prs) is installed" : "the pull request address is not a GitHub PR";
      done(undefined, error);
      notify.send(`PR ${review.prUrl}: review done, ${verdict}, but its findings were not posted: ${error}. See job ${job.id}.`, false);
      return;
    }
    try {
      const url = await comments.post(match[1], Number(match[2]), reviewComment(job, summary));
      done(url);
      notify.send(`PR ${review.prUrl}: review done, ${verdict}`, false);
    } catch (err) {
      const error = err instanceof Error ? err.message : "unknown error";
      done(undefined, error);
      notify.send(`PR ${review.prUrl}: review done, ${verdict}, but posting the findings failed: ${error}. It will not retry; see job ${job.id}.`, false);
    }
  };

  jobs.onSummary((job, fullText) => {
    if (job.kind !== "review") return;
    void finish(job, fullText ?? "").catch((err) => console.error(JSON.stringify({ at: new Date().toISOString(), review: String(err) })));
  });
  return { start };
}

export function selectComments(env: NodeJS.ProcessEnv): CommentPort | undefined {
  const token = credential(env, "orbit.github-orbit-prs");
  return token ? githubComments(token) : undefined;
}
