import assert from "node:assert/strict";
import { test } from "node:test";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { githubControl, gitReconciler, parseSummary } from "../src/launcher.ts";
import type { ControlRepo, GitRecord } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";

function setup(start = "2026-11-06T16:00:00Z") {
  let clock = new Date(start);
  const now = () => clock;
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, () => new Date("2026-11-06T20:00:00Z"));
  const registry = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 5), notify, now);
  return { registry, notify, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)), now: () => clock.getTime() };
}

test("summary front matter is parsed, and anything else is ignored", () => {
  assert.deepEqual(parseSummary("---\nstatus: blocked\nat: 2026-11-06T16:00:00Z\n---\n\nNeed a decision.\n"), { status: "blocked", text: "Need a decision." });
  assert.equal(parseSummary("no front matter"), undefined);
  assert.equal(parseSummary("---\nstatus: maybe\n---\n\nx"), undefined);
});

test("a job that only reached git is finished from its git summary, once, and the owner is told", async () => {
  const { registry, notify, advance, now } = setup();
  registry.register("g1");
  registry.setLaunch("g1", { routine: "orbit", at: new Date(now()).toISOString() });
  let reads = 0;
  const record: GitRecord = { head: "abc1234", started: true, summary: { status: "done", text: "All steps ran; the API was unreachable." } };
  const control: ControlRepo = { pushBrief: async () => ({ branch: "", commit: "" }), readJob: async () => (reads++, record) };
  const reconcile = gitReconciler(registry, control, now);

  await reconcile();
  assert.equal(reads, 0, "too soon after launch to look");
  advance(3 * 60_000);
  await reconcile();
  const job = registry.get("g1")!;
  assert.equal(job.state, "done");
  assert.deepEqual(job.events.map((e) => [e.type, e.via]), [["started", "git"], ["summary", "git"]]);
  assert.equal(job.events[1].sha, "abc1234");
  assert.ok(notify.recent().some((n) => n.text.startsWith("Job g1 finished: done (found in git")));

  advance(3 * 60_000);
  await reconcile();
  assert.equal(reads, 1, "finished jobs are not read again");
});

test("a job still reporting over the API is left alone, and reads are throttled", async () => {
  const { registry, advance, now } = setup();
  registry.register("g2");
  registry.setLaunch("g2", { routine: "orbit", at: new Date(now()).toISOString() });
  let reads = 0;
  const control: ControlRepo = { pushBrief: async () => ({ branch: "", commit: "" }), readJob: async () => (reads++, { started: true }) };
  const reconcile = gitReconciler(registry, control, now);
  advance(30_000);
  registry.record("g2", { type: "checkin", status: "working" });
  advance(60_000);
  await reconcile();
  assert.equal(reads, 0, "heard from over the API a minute ago");
  advance(2 * 60_000);
  await reconcile();
  await reconcile();
  assert.equal(reads, 1, "at most one read per two minutes");
  assert.equal(registry.get("g2")!.events.filter((e) => e.type === "started").length, 0, "no duplicate start when the API already reported progress");
});

test("a failed launch is not read from git and is not counted as active", async () => {
  const { registry, now } = setup();
  registry.register("g3");
  registry.setLaunch("g3", { routine: "orbit", at: new Date(now()).toISOString(), failedAt: new Date(now()).toISOString(), error: "HTTP 400" });
  assert.match(registry.status().detail, /^0 active cloud jobs/);
});

test("a job's token stops working as soon as the job finishes", () => {
  const { registry } = setup();
  const { token } = registry.register("g4") as { token: string };
  assert.equal(registry.verify("g4", token), true);
  registry.record("g4", { type: "summary", status: "done" });
  assert.equal(registry.verify("g4", token), false);
});

test("readJob reads the branch head, the start marker and the summary, and a missing branch is undefined", async () => {
  const fetcher = (async (url: string) => {
    if (url.includes("/commits/orbit%2Fj1")) return Response.json({ sha: "head999" });
    if (url.includes("/contents/.orbit/started.json")) return new Response("{}");
    if (url.includes("/contents/.orbit/summary.md")) return new Response("---\nstatus: failed\nat: x\n---\n\nIt broke.");
    if (url.includes("/commits/orbit%2Fnope")) return new Response("", { status: 404 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const control = githubControl("t", "o/work", fetcher);
  assert.deepEqual(await control.readJob!("j1"), { head: "head999", started: true, summary: { status: "failed", text: "It broke." } });
  assert.equal(await control.readJob!("nope"), undefined);
});
