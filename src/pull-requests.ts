import type { Job, Jobs } from "./jobs.ts";
import { credential } from "./launcher.ts";
import type { Notifier } from "./notify.ts";

// When a coding job finishes `done`, ORBIT opens the pull request from orbit/<job> to main in the project repo,
// if that branch exists there. Merging stays Rai's. The token is the systemd credential orbit.github-orbit-prs.

type Fetch = typeof fetch;
const GITHUB = "https://api.github.com";
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_BODY = 60000;

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

export function prText(job: Job, summary: string): { title: string; body: string } {
  const { title, body } = prSections(summary);
  const session = job.launch?.sessionUrl;
  const footer = `\n\n---\nOpened by ORBIT for job \`${job.id}\`${session ? `. Session: ${session}` : "."}`;
  return { title: title ?? `ORBIT job ${job.id}`, body: `${(body ?? summary).trim().slice(0, MAX_BODY)}${footer}` };
}

export type PullPort = {
  // "no-branch" when orbit/<job> does not exist in the repo; otherwise the PR, new or already there.
  open(repo: string, job: string, title: string, body: string): Promise<{ status: "no-branch" } | { status: "opened" | "exists"; url: string }>;
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
      const found = (await existing.json()) as { html_url?: string }[];
      if (found[0]?.html_url) return { status: "exists", url: found[0].html_url };
      const made = await call("POST", `/repos/${repo}/pulls`, { title, head: branch, base: "main", body });
      if (!made.ok) return fail("Opening the pull request", made);
      const pr = (await made.json()) as { html_url?: string };
      if (!pr.html_url) throw new Error("GitHub opened the pull request but returned no URL");
      return { status: "opened", url: pr.html_url };
    },
  };
}

export function selectPulls(env: NodeJS.ProcessEnv): PullPort | undefined {
  const token = credential(env, "orbit.github-orbit-prs");
  return token ? githubPulls(token) : undefined;
}

// Registers on the job registry: a `done` summary, from the API or from git, opens at most one PR per job.
export function pullRequestOpener(jobs: Jobs, repos: Map<string, string>, pulls: PullPort | undefined, notify: Notifier, now: () => Date = () => new Date(), onOpened?: (job: Job, url: string) => void) {
  const handle = async (job: Job, summary: string): Promise<void> => {
    const repo = job.launch?.routine ? repos.get(job.launch.routine) : undefined;
    if (!repo) return;
    const at = now().toISOString();
    if (!pulls) {
      // A project repo is mapped but ORBIT cannot open PRs: say so once, once per job.
      jobs.setPr(job.id, { at, error: "no pull-request credential (orbit.github-orbit-prs) is installed" });
      notify.send(`Job ${job.id} finished, but ORBIT could not open its pull request: no pull-request credential is installed. Branch orbit/${job.id} in ${repo}, if it exists.`, false);
      return;
    }
    jobs.setPr(job.id, { at }); // claims the job synchronously, before any await, so a second summary cannot open another
    try {
      const { title, body } = prText(job, summary);
      const result = await pulls.open(repo, job.id, title, body);
      if (result.status === "no-branch") {
        jobs.setPr(job.id, undefined); // nothing was pushed (a non-coding job): no PR and nothing to report
        return;
      }
      jobs.setPr(job.id, { at, url: result.url });
      notify.send(`PR ready: ${result.url}`, false);
      // Only a PR ORBIT just opened gets a review; one that already existed does not.
      if (result.status === "opened") {
        try {
          onOpened?.(jobs.get(job.id) ?? job, result.url);
        } catch (err) {
          console.error(JSON.stringify({ at: new Date().toISOString(), review: String(err) }));
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "unknown error";
      jobs.setPr(job.id, { at, error });
      notify.send(`Job ${job.id} finished, but ORBIT could not open its pull request in ${repo}: ${error}. It will not retry; open orbit/${job.id} by hand.`, false);
    }
  };
  jobs.onSummary((job, fullText) => {
    if (job.kind === "review" || job.state !== "done" || job.pr) return;
    void handle(job, fullText ?? "").catch((err) => console.error(JSON.stringify({ at: new Date().toISOString(), pr: String(err) })));
  });
}
