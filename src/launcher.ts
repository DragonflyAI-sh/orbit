import { readFileSync } from "node:fs";
import { join } from "node:path";

// Starting cloud jobs: write the brief to orbit-work through GitHub's API, then fire a saved Routine
// through its documented API trigger. Both tokens are systemd credentials and never leave this process.

type Fetch = typeof fetch;

export const CONTROL_REPO = "DragonflyAI-sh/orbit-work";
const GITHUB = "https://api.github.com";
const ROUTINES = "https://api.anthropic.com/v1/claude_code/routines";

export function credential(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  try {
    return readFileSync(join(dir, name), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export type GitRecord = { head?: string; started: boolean; summary?: { status: string; text: string } };
export type ControlRepo = {
  pushBrief(job: string, brief: string): Promise<{ branch: string; commit: string }>;
  // What the runner wrote on orbit/<job>, read from git. Undefined when the branch does not exist.
  readJob?(job: string): Promise<GitRecord | undefined>;
};

// Parses the summary front matter that orbit-job writes: ---\nstatus: done\nat: ...\n---\n\n<text>
export function parseSummary(raw: string): { status: string; text: string } | undefined {
  const m = raw.match(/^---\nstatus: (done|blocked|failed)\n(?:at: [^\n]*\n)?---\n\n?([\s\S]*)$/);
  return m ? { status: m[1], text: m[2].trim() } : undefined;
}

// Creates orbit/<job> from main and commits .orbit/brief.md on it.
export function githubControl(token: string, repo = CONTROL_REPO, fetcher: Fetch = fetch): ControlRepo {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetcher(`${GITHUB}/repos/${repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "orbit (github.com/DragonflyAI-sh/orbit)",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} returned HTTP ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    async pushBrief(job, brief) {
      const branch = `orbit/${job}`;
      const main = (await call("/git/ref/heads/main")) as { object: { sha: string } };
      await call("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: main.object.sha }) });
      const put = (await call("/contents/.orbit/brief.md", {
        method: "PUT",
        body: JSON.stringify({ message: `brief for ${job}`, content: Buffer.from(brief).toString("base64"), branch }),
      })) as { commit: { sha: string } };
      return { branch, commit: put.commit.sha };
    },

    async readJob(job) {
      const branch = encodeURIComponent(`orbit/${job}`);
      const file = async (path: string) => {
        const res = await fetcher(`${GITHUB}/repos/${repo}/contents/${path}?ref=${branch}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw+json", "user-agent": "orbit (github.com/DragonflyAI-sh/orbit)" },
        });
        if (res.status === 404) return undefined;
        if (!res.ok) throw new Error(`GitHub read ${path} returned HTTP ${res.status}`);
        return res.text();
      };
      let head: string | undefined;
      try {
        head = ((await call(`/commits/${branch}`)) as { sha?: string }).sha;
      } catch (err) {
        if (String(err).includes("HTTP 404") || String(err).includes("HTTP 422")) return undefined;
        throw err;
      }
      const summary = await file(".orbit/summary.md");
      return { head, started: (await file(".orbit/started.json")) !== undefined, summary: summary ? parseSummary(summary) : undefined };
    },
  };
}

// Fills in what the API missed: for open jobs not heard from over the API for 2 minutes,
// read the git record at most every 2 minutes and record a start or summary found there.
export function gitReconciler(jobs: import("./jobs.ts").Jobs, control: ControlRepo, now: () => number = Date.now) {
  const lastRead = new Map<string, number>();
  const QUIET_MS = 2 * 60_000;
  return async (): Promise<void> => {
    if (!control.readJob) return;
    for (const job of jobs.list()) {
      if (job.state !== "registered" && job.state !== "running") continue;
      if (job.launch?.failedAt) continue;
      const lastApi = job.lastEventAt ? new Date(job.lastEventAt).getTime() : new Date(job.launch?.at ?? job.createdAt).getTime();
      if (now() - lastApi < QUIET_MS || now() - (lastRead.get(job.id) ?? 0) < QUIET_MS) continue;
      lastRead.set(job.id, now());
      let record: GitRecord | undefined;
      try {
        record = await control.readJob(job.id);
      } catch {
        continue; // GitHub was unreachable; try again next round.
      }
      if (!record) continue;
      const types = new Set(job.events.map((e) => e.type));
      // A job that has already reported anything has started; only an empty timeline needs the git start.
      if (record.started && job.events.length === 0) jobs.record(job.id, { type: "started", via: "git" });
      if (record.summary && !types.has("summary")) {
        jobs.record(job.id, { type: "summary", status: record.summary.status, text: record.summary.text, sha: record.head?.slice(0, 64), via: "git" });
      }
    }
  };
}

export type Fired = { sessionId: string; sessionUrl: string };
export type Routine = { name: string; fire(text: string): Promise<Fired> };

export function routineTrigger(name: string, triggerId: string, token: string, fetcher: Fetch = fetch): Routine {
  return {
    name,
    async fire(text) {
      const res = await fetcher(`${ROUTINES}/${triggerId}/fire`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": "experimental-cc-routine-2026-04-01",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Routine ${name} fire returned HTTP ${res.status}`);
      const body = (await res.json()) as { claude_code_session_id?: string; claude_code_session_url?: string };
      if (!body.claude_code_session_id || !body.claude_code_session_url) throw new Error(`Routine ${name} fire returned no session`);
      return { sessionId: body.claude_code_session_id, sessionUrl: body.claude_code_session_url };
    },
  };
}

// ORBIT_ROUTINES="orbit=trig_...,money-noodle=trig_..."; each token is the credential orbit.routine.<name>.
export function selectRoutines(env: NodeJS.ProcessEnv): Map<string, Routine> {
  const routines = new Map<string, Routine>();
  for (const pair of (env.ORBIT_ROUTINES ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [name, id] = pair.split("=");
    const token = name && id ? credential(env, `orbit.routine.${name}`) : undefined;
    if (name && id && token) routines.set(name, routineTrigger(name, id, token));
  }
  return routines;
}

export function selectControl(env: NodeJS.ProcessEnv): ControlRepo | undefined {
  const token = credential(env, "orbit.github-orbit-work");
  return token ? githubControl(token) : undefined;
}
