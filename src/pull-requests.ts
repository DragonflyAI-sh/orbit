import type { Job, Jobs, TitleSource } from "./jobs.ts";
import { credential } from "./launcher.ts";
import type { Notifier } from "./notify.ts";
import { PART_CHARS, partMarker, splitText, wrapPart } from "./split-text.ts";

// When a coding job finishes `done`, ORBIT opens the pull request from orbit/<job> to main in the project repo,
// if that branch exists there. Merging stays Rai's. The token is the systemd credential orbit.github-orbit-prs.

type Fetch = typeof fetch;
const GITHUB = "https://api.github.com";
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
// A delivery that failed part-way is retried (see retry below) this many times in all, then left for Rai with the error on the job.
export const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_GAP_MS = 2 * 60_000;
const MAX_TITLE = 250;

// ORBIT_ROUTINE_REPOS="orbit=DragonflyAI-sh/orbit,money-noodle=DragonflyAI-sh/money-noodle"
export function parseRoutineRepos(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const repo = pair.slice(i + 1).trim();
    if (i > 0 && REPO.test(repo)) map.set(name, repo);
  }
  return map;
}

// `## PR title` runs to the next `## ` heading. `## PR body` runs to the end of the summary, or to a later
// `## PR title`, so the body may carry its own headings.
export function prSections(summary: string): { title?: string; body?: string } {
  const lines = summary.split("\n");
  const find = (name: string) => lines.findIndex((l) => l.trim().toLowerCase() === `## ${name}`);
  const t = find("pr title");
  const b = find("pr body");
  let title: string | undefined;
  if (t >= 0) {
    let end = lines.findIndex((l, i) => i > t && l.startsWith("## "));
    if (end < 0) end = lines.length;
    title = lines.slice(t + 1, end).find((l) => l.trim())?.replace(/^#+\s*/, "").trim().slice(0, 250) || undefined;
  }
  let body: string | undefined;
  if (b >= 0) {
    const end = t > b ? t : lines.length;
    body = lines.slice(b + 1, end).join("\n").trim() || undefined;
  }
  return { title, body };
}

// The PR title: the runner's `## PR title` when there is one, otherwise a title made from the job, and which of the two it was.
// Never "ORBIT job <id>": that says nothing about the change.
export function prTitle(job: Job, summary: string): { title: string; source: TitleSource } {
  const { title, body } = prSections(summary);
  if (title) return { title, source: "pr-title-section" };
  for (const raw of (body ?? summary).split("\n")) {
    const line = raw.trim().replace(/^(#+|[-*>]|\d+[.)])\s+/, "").replace(/[*_`]+/g, "").trim();
    if (/^(summary|pr body|pr title|what|why|overview|status|result)\s*:?$/i.test(line) || !/[A-Za-z0-9].*[A-Za-z0-9].*[A-Za-z0-9]/.test(line) || line.length < 8) continue;
    return { title: line.length > 120 ? `${line.slice(0, 119)}…` : line, source: "summary-first-line" };
  }
  return { title: `${job.launch?.routine ?? "Project"}: changes from job ${job.id}`, source: "job-routine" };
}

export const TITLE_SOURCE_TEXT: Record<TitleSource, string> = {
  "pr-title-section": "the runner's ## PR title",
  "summary-first-line": "the first line of the summary (the runner wrote no usable ## PR title)",
  "job-routine": "the job id and routine (the runner wrote no usable ## PR title and the summary had no usable first line)",
};

// The whole description as ordered parts. Part 1 is the PR description (with a notice when there are more); each later part is a
// comment body with its marker. The chunks, joined, are the complete body plus footer: nothing is clipped.
export function prText(job: Job, summary: string): { title: string; titleSource: TitleSource; body: string; comments: { marker: string; body: string }[]; total: number } {
  const { title, source } = prTitle(job, summary);
  const { body } = prSections(summary);
  const session = job.launch?.sessionUrl;
  const footer = `\n\n---\nOpened by ORBIT for job \`${job.id}\`${session ? `. Session: ${session}` : "."}`;
  const chunks = splitText(`${(body ?? summary).trim()}${footer}`, PART_CHARS);
  const total = chunks.length;
  const first = total === 1 ? chunks[0]! : `> This description is long: it is part 1 of ${total}. ORBIT posts parts 2 to ${total} as ordered comments below.\n\n${chunks[0]}`;
  const comments = chunks.slice(1).map((c, i) => {
    const marker = partMarker(job.id, "pr", i + 2, total);
    return { marker, body: wrapPart(marker, `Part ${i + 2}/${total} of the description for job \`${job.id}\``, c) };
  });
  return { title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title, titleSource: source, body: first, comments, total };
}

export type CommentPort = {
  // Posts an issue comment on the PR and returns its URL.
  post(repo: string, pull: number, body: string): Promise<string>;
  // The URL of a comment on the PR whose text contains `marker`, if there is one (so a retry never posts a part twice).
  find?(repo: string, pull: number, marker: string): Promise<string | undefined>;
};

// Posts parts[from..] to the PR in order, stopping at the first failure. `onPosted(n, url)` runs after each part is on GitHub.
// A part already there (found by its marker, after a crash or a retry) counts as posted and is not posted again.
export async function postParts(comments: CommentPort, repo: string, pull: number, parts: { marker: string; body: string }[], from: number, onPosted: (index: number, url: string) => void): Promise<{ error?: string; failedAt?: number }> {
  for (let i = from; i < parts.length; i++) {
    try {
      let url = await comments.find?.(repo, pull, parts[i]!.marker);
      url ??= await comments.post(repo, pull, parts[i]!.body);
      onPosted(i, url);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "unknown error", failedAt: i };
    }
  }
  return {};
}

export type PullPort = {
  // "no-branch" when orbit/<job> does not exist in the repo; otherwise the PR, new or already there.
  open(repo: string, job: string, title: string, body: string): Promise<{ status: "no-branch" } | { status: "opened" | "exists"; url: string; head?: { ref: string; repo: string }; headSha?: string }>;
};

export async function httpFailure(what: string, res: Response): Promise<never> {
  let detail = "";
  try {
    const m = ((await res.json()) as { message?: unknown }).message;
    if (typeof m === "string") detail = `: ${m.slice(0, 200)}`;
  } catch {
    /* no JSON body */
  }
  throw new Error(`${what} returned HTTP ${res.status}${detail}`);
}

export function githubCaller(token: string, fetcher: Fetch = fetch) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetcher(`${GITHUB}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "orbit (github.com/DragonflyAI-sh/orbit)",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };
}

// A full lowercase commit id, or nothing: anything else is not recorded as a SHA.
const commitSha = (v: unknown): string | undefined => (typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? v : undefined);

export function githubPulls(token: string, fetcher: Fetch = fetch): PullPort {
  const call = githubCaller(token, fetcher);
  const fail = httpFailure;
  return {
    async open(repo, job, title, body) {
      const branch = `orbit/${job}`;
      const ref = await call("GET", `/repos/${repo}/git/ref/heads/${branch}`);
      if (ref.status === 404) return { status: "no-branch" };
      if (!ref.ok) return fail("Checking the branch", ref);
      const owner = repo.split("/")[0];
      const existing = await call("GET", `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      if (!existing.ok) return fail("Looking for an existing pull request", existing);
      const found = (await existing.json()) as { html_url?: string; head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } }[];
      if (found[0]?.html_url) {
        const head = found[0].head;
        return { status: "exists", url: found[0].html_url, head: head?.ref && head.repo?.full_name ? { ref: head.ref, repo: head.repo.full_name } : undefined, ...(commitSha(head?.sha) ? { headSha: commitSha(head?.sha) } : {}) };
      }
      const made = await call("POST", `/repos/${repo}/pulls`, { title, head: branch, base: "main", body });
      if (!made.ok) return fail("Opening the pull request", made);
      const pr = (await made.json()) as { html_url?: string; head?: { sha?: string } };
      if (!pr.html_url) throw new Error("GitHub opened the pull request but returned no URL");
      return { status: "opened", url: pr.html_url, ...(commitSha(pr.head?.sha) ? { headSha: commitSha(pr.head?.sha) } : {}) };
    },
  };
}

export function selectPulls(env: NodeJS.ProcessEnv): PullPort | undefined {
  const token = credential(env, "orbit.github-orbit-prs");
  return token ? githubPulls(token) : undefined;
}

// Registers on the job registry: a complete `done` summary, from the API or from git, opens at most one PR per job. A summary that
// arrived only in part waits for the rest from git; one over the size limit is reported and not turned into a PR.
export function pullRequestOpener(jobs: Jobs, repos: Map<string, string>, pulls: PullPort | undefined, notify: Notifier, now: () => Date = () => new Date(), onOpened?: (job: Job, url: string, headSha?: string) => void, comments?: CommentPort) {
  const inFlight = new Set<string>();
  const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;

  // Posts the parts after the description. Safe to call again: it resumes after the last part recorded, and a part already on the
  // PR is found by its marker. "Delivered in full" is claimed only when every part is on GitHub.
  const deliverRest = async (jobId: string): Promise<void> => {
    const job = jobs.get(jobId);
    const pr = job?.pr;
    if (!job || !pr?.url || !pr.total || (pr.posted ?? 1) >= pr.total || inFlight.has(jobId)) return;
    inFlight.add(jobId);
    try {
      const m = PR_URL.exec(pr.url);
      const repo = job.launch?.routine ? repos.get(job.launch.routine) : undefined;
      const text = job.summary?.state === "complete" ? job.summary.text : undefined;
      const fail = (error: string) => {
        const attempts = (pr.attempts ?? 0) + 1;
        jobs.setPr(jobId, { ...jobs.get(jobId)!.pr!, error, attempts, lastAttemptAt: now().toISOString() });
        if (attempts === 1 || attempts === MAX_DELIVERY_ATTEMPTS) notify.send(`PR ${pr.url}: only ${jobs.get(jobId)!.pr!.posted} of ${pr.total} parts of the description are posted (${error}). ${attempts >= MAX_DELIVERY_ATTEMPTS ? "ORBIT has stopped retrying; the full text is in the job's summary." : "ORBIT will retry."} Job ${jobId}.`, attempts >= MAX_DELIVERY_ATTEMPTS);
      };
      if (!m || !repo || !text) return fail(!comments ? "no pull-request credential is installed" : "the PR address, repo or complete summary is missing");
      if (!comments) return fail("no pull-request credential (orbit.github-orbit-prs) is installed");
      const { comments: parts } = prText(job, text);
      const done = await postParts(comments, m[1]!, Number(m[2]), parts, (pr.posted ?? 1) - 1, (i) => {
        const cur = jobs.get(jobId)!.pr!;
        jobs.setPr(jobId, { ...cur, posted: i + 2 });
      });
      if (done.error) return fail(`part ${done.failedAt! + 2} of ${pr.total} failed: ${done.error}`);
      const cur = jobs.get(jobId)!.pr!;
      const { error: _e, ...ok } = cur;
      jobs.setPr(jobId, ok);
      notify.send(`PR ${pr.url}: all ${pr.total} parts of the description are posted.`, false);
    } finally {
      inFlight.delete(jobId);
    }
  };

  const handle = async (job: Job, summary: string): Promise<void> => {
    const repo = job.launch?.routine ? repos.get(job.launch.routine) : undefined;
    if (!repo) return;
    const at = now().toISOString();
    if (job.summary?.state === "oversize") {
      jobs.setPr(job.id, { at, error: `the summary is ${job.summary.chars} characters, over the limit ORBIT keeps whole; no pull request was opened. The full text is in git (orbit/${job.id}).` });
      return;
    }
    if (!pulls) {
      // A project repo is mapped but ORBIT cannot open PRs: say so once, once per job.
      jobs.setPr(job.id, { at, error: "no pull-request credential (orbit.github-orbit-prs) is installed" });
      notify.send(`Job ${job.id} finished, but ORBIT could not open its pull request: no pull-request credential is installed. Branch orbit/${job.id} in ${repo}, if it exists.`, false);
      return;
    }
    jobs.setPr(job.id, { at }); // claims the job synchronously, before any await, so a second summary cannot open another
    try {
      const { title, titleSource, body, total } = prText(job, summary);
      const result = await pulls.open(repo, job.id, title, body);
      if (result.status === "no-branch") {
        jobs.setPr(job.id, undefined); // nothing was pushed (a non-coding job): no PR and nothing to report
        return;
      }
      const opened = result.status === "opened";
      // Only a PR ORBIT just opened carries ORBIT's title and parts; an existing one keeps whatever it already has.
      jobs.setPr(job.id, { at, url: result.url, ...(opened ? { title, titleSource, total, posted: 1 } : {}) });
      notify.send(`PR ready: ${result.url}${opened && titleSource !== "pr-title-section" ? ` (the title comes from ${TITLE_SOURCE_TEXT[titleSource]})` : ""}${opened && total > 1 ? `. The description is long: part 1 is the PR description and ${total - 1} more part(s) follow as comments` : ""}`, false);
      // A PR ORBIT just opened gets a review. So does one that already existed, but only if its head is this job's own
      // branch in the mapped repo (the runner opened it); the reviewer starts at most one review per job.
      const runnerOpened = result.status === "exists" && result.head?.ref === `orbit/${job.id}` && result.head.repo.toLowerCase() === repo.toLowerCase() && result.url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`);
      if (runnerOpened) notify.send(`PR ${result.url} for job ${job.id} was opened by the runner, not by ORBIT. ORBIT is reviewing it anyway.`, false);
      if (opened || runnerOpened) {
        try {
          onOpened?.(jobs.get(job.id) ?? job, result.url, result.headSha);
        } catch (err) {
          console.error(JSON.stringify({ at: new Date().toISOString(), review: String(err) }));
        }
      }
      if (opened && total > 1) await deliverRest(job.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : "unknown error";
      jobs.setPr(job.id, { ...jobs.get(job.id)?.pr, at, error });
      notify.send(`Job ${job.id} finished, but ORBIT could not open its pull request in ${repo}: ${error}. It will not retry; open orbit/${job.id} by hand.`, false);
    }
  };
  jobs.onSummary((job, fullText, complete) => {
    if (job.kind === "review" || job.state !== "done" || job.pr) return;
    // A partial summary is not acted on: git completes it and this listener runs again with the whole text.
    if (!complete && job.summary?.state !== "oversize") return;
    void handle(job, fullText ?? "").catch((err) => console.error(JSON.stringify({ at: new Date().toISOString(), pr: String(err) })));
  });

  return {
    // Retries the delivery of description parts that failed, at most MAX_DELIVERY_ATTEMPTS times each, RETRY_GAP_MS apart.
    async retry(): Promise<void> {
      for (const job of jobs.all()) {
        const pr = job.pr;
        if (!pr?.url || !pr.total || (pr.posted ?? 1) >= pr.total || (pr.attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS) continue;
        if (pr.lastAttemptAt && now().getTime() - new Date(pr.lastAttemptAt).getTime() < RETRY_GAP_MS) continue;
        await deliverRest(job.id).catch(() => {});
      }
    },
  };
}
