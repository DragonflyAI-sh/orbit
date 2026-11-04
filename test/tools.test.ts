import assert from "node:assert/strict";
import { test } from "node:test";
import { githubRepoStatus, toolbox } from "../src/tools.ts";

const github = ((url: string) => {
  const body = url.includes("/pulls")
    ? [{ number: 7, title: "Fix", draft: false, html_url: "u", updated_at: "t" }]
    : { workflow_runs: [{ name: "Delivery", status: "completed", conclusion: "success", head_sha: "abcdef123", html_url: "u", updated_at: "t" }] };
  return Promise.resolve(new Response(JSON.stringify(body), { headers: { "x-ratelimit-remaining": "57" } }));
}) as unknown as typeof fetch;

test("github-repo-status reports open PRs and main CI", async () => {
  const tool = githubRepoStatus(github);
  const { value, provenance } = (await tool.run({ repo: "o/r" })) as { value: { openPullRequests: unknown[]; mainCi: { conclusion: string; commit: string } }; provenance: string };
  assert.equal(provenance, "live");
  assert.equal(value.openPullRequests.length, 1);
  assert.deepEqual([value.mainCi.conclusion, value.mainCi.commit], ["success", "abcdef1"]);
  assert.equal(tool.rateRemaining(), "57");
});

test("github-repo-status refuses anything but owner/name", () => {
  const tool = githubRepoStatus(github);
  assert.equal(tool.validate({ repo: "o/r" }), undefined);
  assert.ok(tool.validate({ repo: "../../x" }));
  assert.ok(tool.validate({}));
});

test("a failing tool degrades the toolbox and says why", async () => {
  const failing = githubRepoStatus((async () => new Response("", { status: 403 })) as typeof fetch);
  const box = toolbox([failing]);
  assert.equal(box.status().state, "live");
  await assert.rejects(box.call("github-repo-status", { repo: "o/r" }));
  assert.equal(box.status().state, "degraded");
  assert.match(box.status().detail, /HTTP 403/);
});
