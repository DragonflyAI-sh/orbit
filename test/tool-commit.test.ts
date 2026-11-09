import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildIngress } from "../src/ingress.ts";
import { jobRow, toolCommitStatus, detailJob } from "../src/job-view.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { githubControl, gitReconciler } from "../src/launcher.ts";
import type { ControlRepo } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";

const TOOL = new URL("../tools/orbit-job/orbit-job", import.meta.url).pathname;
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();
const A = "a".repeat(40);
const B = "b".repeat(40);

let clock = new Date("2026-11-08T10:00:00Z");
const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, () => new Date("2026-11-08T20:00:00Z"));
const registry = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 9), notify, () => clock);
const ingress = buildIngress(registry);
let api = "";
before(async () => {
  await new Promise<void>((r) => ingress.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(ingress.address() as AddressInfo).port}`;
});
after(() => ingress.close());

function runTool(cwd: string, env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [TOOL, ...args], { cwd, env: { ...process.env, ...identity, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function setup(job: string, extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "orbit-tc-"));
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
  const env = { HOME: root, ORBIT_JOB_STATE: join(root, "state"), ORBIT_JOB_TOOL_COMMIT: "", ...extraEnv };
  const run = (...args: string[]) => runTool(runner, env, ...args);
  const started = () => JSON.parse(git(root, "--git-dir", remote, "show", `orbit/${job}:.orbit/started.json`));
  return { run, started };
}

test("start records a supplied --tool-commit in started.json and in the started event", async () => {
  const { token } = registry.register("t1") as { token: string };
  const { run, started } = setup("t1");
  const out = await run("start", "--job", "t1", "--api", api, "--token", token, "--tool-commit", A);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /api=sent/);
  assert.equal(started().toolCommit, A);
  assert.equal(registry.get("t1")!.toolCommit, A);
  assert.equal(registry.get("t1")!.events[0].toolCommit, A);
});

test("ORBIT_JOB_TOOL_COMMIT works the same, and the option wins over it", async () => {
  const a = setup("t2", { ORBIT_JOB_TOOL_COMMIT: A });
  assert.equal((await a.run("start", "--job", "t2")).status, 0);
  assert.equal(a.started().toolCommit, A);
  const b = setup("t3", { ORBIT_JOB_TOOL_COMMIT: A });
  assert.equal((await b.run("start", "--job", "t3", "--tool-commit", B)).status, 0);
  assert.equal(b.started().toolCommit, B);
});

test("a missing commit is the literal \"unknown\" in started.json and is not stored as a commit", async () => {
  const { token } = registry.register("t4") as { token: string };
  const { run, started } = setup("t4");
  assert.equal((await run("start", "--job", "t4", "--api", api, "--token", token)).status, 0);
  assert.equal(started().toolCommit, "unknown");
  const job = registry.get("t4")!;
  assert.equal(job.state, "running", "the start is still recorded");
  assert.equal(job.toolCommit, undefined);
  assert.equal(job.events[0].toolCommit, undefined);
  assert.equal(jobRow(job, "ok", A).toolCommit, "unknown");
  assert.equal(jobRow(job, "ok", A).toolCommitStatus, "unknown", "unknown is not a mismatch");
});

test("a malformed commit is refused before anything is recorded", async () => {
  const { run } = setup("t5");
  const out = await run("start", "--job", "t5", "--tool-commit", "main");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /40-character/);
});

test("the API ignores a malformed toolCommit and a toolCommit on other event types", async () => {
  const { token } = registry.register("t6") as { token: string };
  const post = (body: unknown) => fetch(`${api}/v1/jobs/t6/events`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  await post({ type: "checkin", status: "x", toolCommit: A });
  assert.equal(registry.get("t6")!.toolCommit, undefined);
  await post({ type: "started", toolCommit: "<b>x</b>" });
  assert.equal(registry.get("t6")!.toolCommit, undefined);
  await post({ type: "started", toolCommit: A });
  assert.equal(registry.get("t6")!.toolCommit, A);
});

test("git fallback: the reconciler records the start with the tool commit from started.json", async () => {
  registry.register("t7");
  registry.setLaunch("t7", { routine: "orbit", at: clock.toISOString() });
  registry.register("t8");
  registry.setLaunch("t8", { routine: "orbit", at: clock.toISOString() });
  const records: Record<string, { started: boolean; toolCommit?: string }> = { t7: { started: true, toolCommit: A }, t8: { started: true } };
  const control: ControlRepo = { pushBrief: async () => ({ branch: "", commit: "" }), readJob: async (id) => records[id] };
  const later = clock.getTime() + 3 * 60_000;
  await gitReconciler(registry, control, () => later)();
  assert.equal(registry.get("t7")!.toolCommit, A);
  assert.equal(registry.get("t7")!.events[0].via, "git");
  assert.equal(registry.get("t8")!.toolCommit, undefined, "legacy started.json: unknown");
});

test("git fallback: a job that reported over the API without the commit still gets it from git", async () => {
  registry.register("t9");
  registry.setLaunch("t9", { routine: "orbit", at: clock.toISOString() });
  registry.record("t9", { type: "checkin", status: "working" });
  const control: ControlRepo = { pushBrief: async () => ({ branch: "", commit: "" }), readJob: async () => ({ started: true, toolCommit: B }) };
  await gitReconciler(registry, control, () => clock.getTime() + 20 * 60_000)();
  assert.equal(registry.get("t9")!.toolCommit, B);
});

test("readJob parses toolCommit from started.json; legacy, junk and non-JSON give none", async () => {
  const read = async (started: string) => {
    const fetcher = (async (url: string) => {
      if (url.includes("/commits/")) return Response.json({ sha: "h" });
      if (url.includes("started.json")) return new Response(started);
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    return githubControl("t", "o/work", fetcher).readJob!("j1");
  };
  assert.equal((await read(JSON.stringify({ toolCommit: A })))!.toolCommit, A);
  assert.equal((await read("{}"))!.toolCommit, undefined);
  assert.equal((await read(JSON.stringify({ toolCommit: "unknown" })))!.toolCommit, undefined);
  const odd = await read("not json");
  assert.equal(odd!.started, true);
  assert.equal(odd!.toolCommit, undefined);
});

test("toolCommitStatus: match, mismatch, and unknown on either side", () => {
  assert.equal(toolCommitStatus(A, A), "match");
  assert.equal(toolCommitStatus(A, "AAAAAAA"), "match", "ORBIT may know a short id");
  assert.equal(toolCommitStatus(A, B), "mismatch");
  assert.equal(toolCommitStatus(undefined, A), "unknown");
  assert.equal(toolCommitStatus(A, "unknown"), "unknown", "ORBIT's own commit unknown is not a mismatch");
  assert.equal(toolCommitStatus(A, undefined), "unknown");
});

test("job rows and details carry the tool commit and its status", () => {
  const job: Job = { id: "x", createdAt: "", expiresAt: "", state: "running", events: [], steers: [], toolCommit: A };
  const legacy: Job = { ...job, id: "y", toolCommit: undefined };
  assert.deepEqual([jobRow(job, "ok", A).toolCommit, jobRow(job, "ok", A).toolCommitStatus], [A, "match"]);
  assert.equal(jobRow(job, "ok", B).toolCommitStatus, "mismatch");
  assert.deepEqual([jobRow(legacy, "ok", B).toolCommit, jobRow(legacy, "ok", B).toolCommitStatus], ["unknown", "unknown"]);
  assert.equal(detailJob(job, "ok", B).toolCommitStatus, "mismatch");
});

test("the Jobs page shows the commit as text, flags only a mismatch, and shows unknown explicitly", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const fn = html.match(/function toolCommitBadge\(r\) \{[\s\S]*?\n  \}\n/)?.[0] ?? "";
  assert.ok(fn, "toolCommitBadge exists");
  assert.ok(!/innerHTML/.test(fn), "text only");
  const el = (_tag: string, props: Record<string, string>) => ({ ...props, title: "", setAttribute() {} });
  const badge = new Function("el", `${fn}; return toolCommitBadge;`)(el) as (r: object) => { className: string; textContent: string };
  const m = badge({ toolCommit: A, toolCommitStatus: "mismatch" });
  assert.match(m.textContent, /aaaaaaa ≠ running ORBIT/);
  assert.equal(m.className, "health-launch-failed");
  assert.match(badge({ toolCommit: A, toolCommitStatus: "match" }).textContent, /matches ORBIT/);
  const u = badge({ toolCommit: "unknown", toolCommitStatus: "unknown" });
  assert.equal(u.textContent, "tool commit: unknown");
  assert.equal(u.className, "meta");
  assert.equal(badge({ toolCommitStatus: "unknown" }).textContent, "tool commit: unknown");
  const k = badge({ toolCommit: A, toolCommitStatus: "unknown" });
  assert.equal(k.className, "meta", "known commit but ORBIT's own commit unknown is not flagged");
  assert.match(k.textContent, /ORBIT's own commit unknown/);
});
