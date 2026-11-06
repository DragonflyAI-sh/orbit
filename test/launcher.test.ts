import assert from "node:assert/strict";
import { test } from "node:test";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { githubControl, routineTrigger, selectRoutines } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";

type Call = { url: string; init: RequestInit };

test("the brief is written on a new orbit/<job> branch cut from main", async () => {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "main123" } });
    if (url.endsWith("/git/refs")) return Response.json({ ref: "refs/heads/orbit/j1" }, { status: 201 });
    if (url.endsWith("/contents/.orbit/brief.md")) return Response.json({ commit: { sha: "brief456" } }, { status: 201 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const result = await githubControl("gh-token", "o/work", fetcher).pushBrief("j1", "Do the thing.");
  assert.deepEqual(result, { branch: "orbit/j1", commit: "brief456" });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { ref: "refs/heads/orbit/j1", sha: "main123" });
  const put = JSON.parse(String(calls[2].init.body));
  assert.equal(Buffer.from(put.content, "base64").toString(), "Do the thing.");
  assert.equal(put.branch, "orbit/j1");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer gh-token");
});

test("a GitHub failure says which call failed", async () => {
  const fetcher = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(githubControl("t", "o/work", fetcher).pushBrief("j1", "x"), /GET \/git\/ref\/heads\/main returned HTTP 403/);
});

test("firing a Routine uses the documented trigger and returns the session", async () => {
  let call: Call | undefined;
  const fetcher = (async (url: string, init: RequestInit) => {
    call = { url, init };
    return Response.json({ claude_code_session_id: "cse_1", claude_code_session_url: "https://claude.ai/code/cse_1" });
  }) as unknown as typeof fetch;
  const fired = await routineTrigger("orbit", "trig_1", "rt-token", fetcher).fire("Job id: j1");
  assert.deepEqual(fired, { sessionId: "cse_1", sessionUrl: "https://claude.ai/code/cse_1" });
  assert.equal(call!.url, "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire");
  const headers = call!.init.headers as Record<string, string>;
  assert.equal(headers["anthropic-beta"], "experimental-cc-routine-2026-04-01");
  assert.equal(headers.authorization, "Bearer rt-token");
  assert.deepEqual(JSON.parse(String(call!.init.body)), { text: "Job id: j1" });
});

test("a Routine is only configured when its token credential exists", () => {
  assert.equal(selectRoutines({ ORBIT_ROUTINES: "orbit=trig_1", CREDENTIALS_DIRECTORY: "/nonexistent" }).size, 0);
  assert.equal(selectRoutines({}).size, 0);
});

test("jobs that do not start, or go quiet, are flagged", () => {
  let clock = new Date("2026-11-06T10:00:00Z");
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const registry = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 3), notify, () => clock);
  registry.register("j1");
  registry.setLaunch("j1", { routine: "orbit", at: clock.toISOString() });
  assert.equal(registry.health(registry.get("j1")!), "ok");
  clock = new Date("2026-11-06T10:11:00Z");
  assert.equal(registry.health(registry.get("j1")!), "not-started");
  registry.record("j1", { type: "started" });
  assert.equal(registry.health(registry.get("j1")!), "ok");
  clock = new Date("2026-11-06T10:27:00Z");
  assert.equal(registry.health(registry.get("j1")!), "quiet");
  registry.record("j1", { type: "summary", status: "done" });
  assert.equal(registry.health(registry.get("j1")!), "finished");
});
