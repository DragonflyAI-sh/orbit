import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mockModel } from "../src/model.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { MAX_CONCURRENT, modelTask, runner } from "../src/runs.ts";
import type { Output, Run, Worker } from "../src/runs.ts";
import { parseJob, scheduler } from "../src/schedule.ts";
import type { Job } from "../src/schedule.ts";
import { jsonStore } from "../src/store.ts";

const daytime = () => new Date("2026-11-05T20:00:00Z");
const settle = () => new Promise((r) => setTimeout(r, 20));

function fake(name: string, opts: Partial<Worker> & { gate?: Promise<void> } = {}): Worker {
  return {
    name,
    idempotent: true,
    timeoutMs: 1000,
    validate: () => undefined,
    run: async (_input, signal) => {
      await opts.gate;
      if (signal.aborted) throw signal.reason;
      return { text: "done", provenance: "live" } as Output;
    },
    review: () => ({ ok: true, detail: "Checked." }),
    ...opts,
  };
}

function setup(workers: Worker[], dir?: string) {
  const notify = notifier(jsonStore<Notification[]>(dir, "n", []), undefined, daytime);
  const runs = runner(jsonStore<Run[]>(dir, "r", []), workers, notify, daytime);
  return { notify, runs };
}

test("a run moves requested, accepted, running, reviewed, then delivered only on a receipt", async () => {
  const { notify, runs } = setup([fake("w")]);
  const { run } = runs.submit("w", {});
  runs.pump();
  await settle();
  const reviewed = runs.get(run!.id)!;
  assert.deepEqual(reviewed.events.map((e) => e.state), ["requested", "accepted", "running", "reviewed"]);
  runs.pump();
  assert.equal(runs.get(run!.id)!.state, "reviewed", "no receipt yet, so not delivered");
  notify.ack(reviewed.notification!);
  runs.pump();
  assert.equal(runs.get(run!.id)!.state, "delivered");
  assert.match(runs.get(run!.id)!.events.at(-1)!.detail, /Shown in the ORBIT web page/);
});

test("a failed review fails the run and still tells the owner", async () => {
  const { notify, runs } = setup([fake("w", { review: () => ({ ok: false, detail: "empty" }) })]);
  const { run } = runs.submit("w", {});
  runs.pump();
  await settle();
  assert.equal(runs.get(run!.id)!.state, "failed");
  assert.match(notify.get(runs.get(run!.id)!.notification!)!.text, /failed review: empty/);
});

test("no more than the cap run at once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { runs } = setup([fake("slow", { gate })]);
  for (let i = 0; i < MAX_CONCURRENT + 2; i++) runs.submit("slow", {});
  runs.pump();
  assert.equal(runs.list().filter((r) => r.state === "running").length, MAX_CONCURRENT);
  assert.equal(runs.list().filter((r) => r.state === "requested").length, 2);
  release();
  await settle();
});

test("cancel stops a running worker and the result is not delivered", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { runs } = setup([fake("slow", { gate })]);
  const { run } = runs.submit("slow", {});
  runs.pump();
  assert.equal(runs.cancel(run!.id)?.state, "cancelled");
  release();
  await settle();
  assert.equal(runs.get(run!.id)!.state, "cancelled");
  assert.equal(runs.get(run!.id)!.notification, undefined);
});

test("a worker past its timeout fails", async () => {
  const { runs } = setup([fake("hang", { timeoutMs: 10, gate: new Promise(() => {}) })]);
  const { run } = runs.submit("hang", {});
  runs.pump();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs.get(run!.id)!.state, "failed");
  assert.match(runs.get(run!.id)!.events.at(-1)!.detail, /timed out/);
});

test("after a restart, safe runs are re-queued and unsafe ones are marked interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-runs-"));
  const before = setup([fake("safe"), fake("unsafe", { idempotent: false, gate: new Promise(() => {}) })], dir);
  const safe = before.runs.submit("safe", {}).run!;
  const unsafe = before.runs.submit("unsafe", {}).run!;
  // Simulate a crash while both are accepted.
  const store = jsonStore<Run[]>(dir, "r", []);
  store.write(store.read().map((r) => ({ ...r, state: "running" as const })));

  const after = setup([fake("safe"), fake("unsafe", { idempotent: false })], dir);
  after.runs.recover();
  assert.equal(after.runs.get(safe.id)!.state, "requested");
  assert.equal(after.runs.get(unsafe.id)!.state, "failed");
  assert.match(after.runs.get(unsafe.id)!.events.at(-1)!.detail, /not safe to repeat/);
});

test("a model task with no model connected is reviewed as mock", async () => {
  const { runs } = setup([modelTask(mockModel("no model"))]);
  const { run } = runs.submit("model-task", { prompt: "plan my week" });
  runs.pump();
  await settle();
  const done = runs.get(run!.id)!;
  assert.equal(done.output?.provenance, "mock");
  assert.match(done.review!.detail, /mock/);
  assert.equal(runs.submit("model-task", {}).error, "model-task needs {prompt}.");
});

test("a scheduled job can submit a run instead of a notification", async () => {
  let clock = new Date("2026-11-05T20:00:00Z");
  const { notify, runs } = setup([fake("w")]);
  const schedule = scheduler(jsonStore<Job[]>(undefined, "j", []), notify, () => clock, (w, i) => runs.submit(w, i));
  schedule.add(parseJob({ text: "daily report", everyMinutes: 60, run: { worker: "w", input: {} } }, clock) as Job);
  clock = new Date("2026-11-05T21:01:00Z");
  await schedule.tick();
  const record = schedule.list()[0].runs[0];
  assert.ok(record.run);
  assert.equal(runs.get(record.run!)!.worker, "w");
});
