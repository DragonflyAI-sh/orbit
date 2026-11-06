import { readFileSync } from "node:fs";
import { join } from "node:path";

// Starting cloud jobs: write the brief to orbit-work through GitHub's API, then fire a saved Routine
// through its documented API trigger. Both tokens are systemd credentials and never leave this process.

type Fetch = typeof fetch;

export const CONTROL_REPO = "DragonflyAI-sh/orbit-work";
const GITHUB = "https://api.github.com";
const ROUTINES = "https://api.anthropic.com/v1/claude_code/routines";

function credential(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  try {
    return readFileSync(join(dir, name), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export type ControlRepo = { pushBrief(job: string, brief: string): Promise<{ branch: string; commit: string }> };

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
