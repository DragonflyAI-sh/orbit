import type { PortStatus, Result } from "./ports.ts";

export type Tool = {
  name: string;
  description: string;
  // Only read-only tools exist until approvals are built; the server refuses any other.
  readOnly: boolean;
  validate(input: Record<string, unknown>): string | undefined;
  // `signal`: the caller stopped waiting; a tool that makes requests passes it on so they are aborted.
  run(input: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<Result<unknown>>;
};

type Fetch = typeof fetch;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function githubRepoStatus(fetcher: Fetch = fetch): Tool & { rateRemaining(): string | undefined } {
  let remaining: string | undefined;
  const get = async (path: string, signal?: AbortSignal) => {
    const res = await fetcher(`https://api.github.com${path}`, {
      ...(signal ? { signal } : {}),
      headers: { accept: "application/vnd.github+json", "user-agent": "orbit (github.com/DragonflyAI-sh/orbit)" },
    });
    remaining = res.headers.get("x-ratelimit-remaining") ?? remaining;
    if (!res.ok) throw new Error(`GitHub ${path} returned HTTP ${res.status}`);
    return res.json();
  };

  return {
    name: "github-repo-status",
    description: "Open PRs and the latest main CI run for a public GitHub repo. Read-only, no credential.",
    readOnly: true,
    validate: (input) => (typeof input.repo === "string" && REPO.test(input.repo) ? undefined : "Needs {repo: \"owner/name\"}."),
    run: async (input, opts) => {
      const repo = String(input.repo);
      const signal = opts?.signal;
      const [pulls, runs] = await Promise.all([
        get(`/repos/${repo}/pulls?state=open&per_page=20`, signal) as Promise<
          { number: number; title: string; draft: boolean; html_url: string; updated_at: string }[]
        >,
        get(`/repos/${repo}/actions/runs?branch=main&per_page=1`, signal) as Promise<{
          workflow_runs: { name: string; status: string; conclusion: string | null; head_sha: string; html_url: string; updated_at: string }[];
        }>,
      ]);
      const latest = runs.workflow_runs[0];
      return {
        value: {
          repo,
          openPullRequests: pulls.map((p) => ({ number: p.number, title: p.title, draft: p.draft, url: p.html_url, updatedAt: p.updated_at })),
          mainCi: latest
            ? { workflow: latest.name, status: latest.status, conclusion: latest.conclusion, commit: latest.head_sha.slice(0, 7), url: latest.html_url, updatedAt: latest.updated_at }
            : null,
        },
        provenance: "live",
        source: "tools/github-repo-status",
      };
    },
    rateRemaining: () => remaining,
  };
}

export type Toolbox = ReturnType<typeof toolbox>;

export function toolbox(tools: Tool[], now: () => Date = () => new Date()) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const last = new Map<string, { at: string; ok: boolean; detail: string }>();

  return {
    get: (name: string) => byName.get(name),
    list: () => tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly, last: last.get(t.name) })),

    async call(name: string, input: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<Result<unknown>> {
      const tool = byName.get(name);
      if (!tool) throw new Error(`No tool named ${name}.`);
      const invalid = tool.validate(input);
      if (invalid) throw new Error(invalid);
      try {
        const result = await tool.run(input, opts);
        last.set(name, { at: now().toISOString(), ok: true, detail: "Answered." });
        return result;
      } catch (err) {
        last.set(name, { at: now().toISOString(), ok: false, detail: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },

    status(): PortStatus {
      const calls = [...last.values()];
      const failing = [...last.entries()].filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.detail}`);
      const newest = calls.map((c) => c.at).sort().at(-1);
      return {
        port: "tools",
        state: failing.length ? "degraded" : "live",
        impl: "read-only",
        detail: `${tools.map((t) => t.name).join(", ")}. Read-only; write tools are refused until approvals exist.${
          failing.length ? ` Last call failed: ${failing.join("; ")}` : newest ? "" : " Not called yet."
        }`,
        // Tools are checked when called, so an idle toolbox is not stale.
        verifiedAt: now().toISOString(),
      };
    },
  };
}
