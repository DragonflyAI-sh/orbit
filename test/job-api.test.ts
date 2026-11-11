import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildIngress } from "../src/ingress.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";

const TOOL = new URL("../tools/orbit-job/orbit-job", import.meta.url).pathname;
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();

const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, () => new Date("2026-11-05T20:00:00Z"));
const registry = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 7), notify);
const ingress = buildIngress(registry);
let api = "";

before(async () => {
  await new Promise<void>((r) => ingress.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(ingress.address() as AddressInfo).port}`;
});
after(() => ingress.close());

// The tool must run asynchronously here: a synchronous spawn would block the in-process listener it calls.
function runTool(cwd: string, env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [TOOL, ...args], { cwd, env: { ...process.env, ...identity, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function setup(job: string) {
  const root = mkdtempSync(join(tmpdir(), "orbit-api-"));
  const remote = join(root, "orbit-work.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const orbit = join(root, "orbit-side");
  git(root, "clone", "-q", remote, orbit);
  git(orbit, "switch", "-q", "-c", `orbit/${job}`);
  mkdirSync(join(orbit, ".orbit"));
  writeFileSync(join(orbit, ".orbit", "brief.md"), "Do the thing.\n");
  git(orbit, "add", ".");
  git(orbit, "commit", "-q", "-m", "brief");
  git(orbit, "push", "-q", "origin", `orbit/${job}`);
  const runner = join(root, "orbit-work");
  git(root, "clone", "-q", remote, runner);
  const env = { HOME: root, ORBIT_JOB_STATE: join(root, "state") };
  const run = (...args: string[]) => runTool(runner, env, ...args);
  const remoteFile = (path: string) => git(root, "--git-dir", remote, "show", `orbit/${job}:${path}`);
  return { run, runner, remoteFile };
}

test("events reach ORBIT, an API steer lands in git, and the reply and summary notify the owner", async () => {
  const { token } = registry.register("a1") as { token: string };
  const { run, runner, remoteFile } = setup("a1");
  const start = await run("start", "--job", "a1", "--api", api, "--token", token);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /ok git=pushed [0-9a-f]+ api=sent/);
  assert.equal(registry.get("a1")?.state, "running");
  assert.match(registry.get("a1")!.events[0].sha ?? "", /^[0-9a-f]+$/);

  registry.steer("a1", "Switch to the REST API.");
  const checkin = await run("checkin", "halfway");
  assert.equal(checkin.status, 0, checkin.stderr);
  assert.match(checkin.stdout, /--- steer 1/);
  assert.equal(remoteFile(".orbit/steer/1.md"), "Switch to the REST API.");
  assert.deepEqual(registry.pending("a1"), [], "the steer is acknowledged once it is in git");

  writeFileSync(join(runner, "r.md"), "Done, using REST.\n");
  assert.match((await run("reply", "1", join(runner, "r.md"))).stdout, /api=sent/);
  writeFileSync(join(runner, "s.md"), "All good.\n");
  assert.match((await run("summary", "--status", "done", join(runner, "s.md"))).stdout, /api=sent/);
  assert.equal(registry.get("a1")?.state, "done");
  const texts = notify.recent().map((n) => n.text);
  assert.ok(texts.some((t) => t.includes("Job a1 replied to steer 1") && t.includes("Done, using REST.")));
  assert.ok(texts.some((t) => t.startsWith("Job a1 finished: done.")));
});

test("a wrong token is refused, and the step still lands in git with api=failed", async () => {
  registry.register("a2");
  const { run, remoteFile } = setup("a2");
  const out = await run("start", "--job", "a2", "--api", api, "--token", "a2.wrong");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ok git=pushed [0-9a-f]+ api=failed/);
  assert.equal(JSON.parse(remoteFile(".orbit/started.json")).job, "a2");
  assert.equal(registry.get("a2")?.state, "registered");
});

test("an unreachable API falls back to git", async () => {
  const { token } = registry.register("a3") as { token: string };
  const { run } = setup("a3");
  const out = await run("start", "--job", "a3", "--api", "http://127.0.0.1:9", "--token", token);
  assert.match(out.stdout, /ok git=pushed [0-9a-f]+ api=failed/);
});

test("the listener: tokens are per job and expire; unknown jobs look the same as bad tokens; bodies are bounded", async () => {
  const { token: t1 } = registry.register("b1") as { token: string };
  registry.register("b2");
  const call = (id: string, token: string, init: RequestInit = {}) =>
    fetch(`${api}/v1/jobs/${id}/steers`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  assert.equal((await call("b1", t1)).status, 200);
  assert.equal((await call("b2", t1)).status, 401, "a token only works for its own job");
  assert.equal((await call("nope", t1)).status, 401);
  assert.equal((await fetch(`${api}/status`)).status, 404, "the public listener serves job routes only");
  const big = await fetch(`${api}/v1/jobs/b1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${t1}` },
    body: JSON.stringify({ type: "checkin", status: "x".repeat(700 * 1024) }),
  });
  assert.equal(big.status, 400);
  const bad = await fetch(`${api}/v1/jobs/b1/events`, { method: "POST", headers: { authorization: `Bearer ${t1}` }, body: JSON.stringify({ type: "delete" }) });
  assert.equal(bad.status, 400);

  let clock = new Date("2026-11-05T20:00:00Z");
  const expiring = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 9), notify, () => clock);
  const { token } = expiring.register("c1", 60_000) as { token: string };
  assert.equal(expiring.verify("c1", token), true);
  clock = new Date("2026-11-05T20:02:00Z");
  assert.equal(expiring.verify("c1", token), false);
});

test("a job id is validated before registering", () => {
  assert.ok("error" in registry.register("../etc"));
});

test("a long summary reaches ORBIT whole over the API (the old tool cut it at 4000 bytes), with the late title and the final verdict line", async () => {
  const { token } = registry.register("big1") as { token: string };
  const { run, runner } = setup("big1");
  await run("start", "--job", "big1", "--api", api, "--token", token);
  const middle = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"é".repeat(i % 9)}`).join("\n");
  const text = `## Findings\n${middle}\n\n## PR title\nLate title after the old cutoff\n\n## PR body\n${middle.slice(0, 500)}\n\nVerdict: blocking issues\n`;
  assert.ok(Buffer.byteLength(text) > 40_000);
  writeFileSync(join(runner, "s.md"), text);
  assert.match((await run("summary", "--status", "blocked", join(runner, "s.md"))).stdout, /api=sent/);
  const job = registry.get("big1")!;
  assert.equal(job.summary!.text, text.trim(), "complete, including the last line and the late title");
  assert.equal(job.summary!.state, "complete");
  assert.ok(job.summary!.text.endsWith("Verdict: blocking issues"));
  assert.equal(job.events.at(-1)!.textClipped, true, "the display copy of the event says it is clipped");
});

test("a summary over the API size is sent in part and flagged, so ORBIT reads the rest from git instead of acting on the start", async () => {
  const { token } = registry.register("big2") as { token: string };
  const { run, runner, remoteFile } = setup("big2");
  await run("start", "--job", "big2", "--api", api, "--token", token);
  const text = `${"0123456789".repeat(40_000)}\nVerdict: blocking issues\n`;
  writeFileSync(join(runner, "s.md"), text);
  const out = await run("summary", "--status", "blocked", join(runner, "s.md"));
  assert.equal(out.status, 0, out.stderr);
  const job = registry.get("big2")!;
  assert.equal(job.summary!.state, "partial", "ORBIT knows the API copy is only the start");
  assert.ok(job.summary!.text.length <= 200_000);
  assert.ok(remoteFile(".orbit/summary.md").endsWith("Verdict: blocking issues"), "git holds the whole file");
});
