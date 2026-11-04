import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discordWebhook, notifier } from "../src/notify.ts";
import type { Notification, Sink } from "../src/notify.ts";
import { parseJob, scheduler } from "../src/schedule.ts";
import type { Job } from "../src/schedule.ts";
import { jsonStore } from "../src/store.ts";
import { nextDaily, quietUntil } from "../src/time.ts";

const at = (iso: string) => () => new Date(iso);

test("quiet hours hold messages until 08:00 Pacific", () => {
  // 2026-11-05 07:00Z is 23:00 PST.
  assert.equal(quietUntil(new Date("2026-11-05T07:00:00Z"))?.toISOString(), "2026-11-05T16:00:00.000Z");
  assert.equal(quietUntil(new Date("2026-11-05T20:00:00Z")), undefined);
});

test("daily times follow Pacific across the daylight-saving change", () => {
  // 2026-11-01 is the change to PST. 09:00 PDT is 16:00Z; 09:00 PST is 17:00Z.
  assert.equal(nextDaily("09:00", new Date("2026-10-31T12:00:00Z")).toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(nextDaily("09:00", new Date("2026-11-02T12:00:00Z")).toISOString(), "2026-11-02T17:00:00.000Z");
});

test("a non-urgent message at night is held; an urgent one is not", () => {
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, at("2026-11-05T07:30:00Z"));
  assert.ok(notify.send("later").holdUntil);
  assert.equal(notify.send("now", true).holdUntil, undefined);
  assert.deepEqual(notify.inbox().map((n) => n.text), ["now"]);
});

test("Discord delivery records a receipt with the message id, or the failure", async () => {
  const ok: Sink = { name: "discord", send: async () => "msg-1" };
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), ok, at("2026-11-05T20:00:00Z"));
  notify.send("hello");
  await notify.pump();
  assert.deepEqual([notify.recent()[0].discord?.ok, notify.recent()[0].discord?.messageId], [true, "msg-1"]);

  const broken: Sink = { name: "discord", send: async () => { throw new Error("HTTP 401"); } };
  const failing = notifier(jsonStore<Notification[]>(undefined, "n", []), broken, at("2026-11-05T20:00:00Z"));
  failing.send("hello");
  await failing.pump();
  assert.equal(failing.recent()[0].discord?.ok, false);
  assert.equal(failing.status().state, "degraded");
});

test("the Discord webhook needs a message id back", async () => {
  const sink = discordWebhook("https://discord.example/hook", (async () => new Response(JSON.stringify({}))) as typeof fetch);
  await assert.rejects(sink.send("x"), /no message id/);
});

test("a one-shot job fires once and is removed; a repeating job reschedules", async () => {
  let clock = new Date("2026-11-05T20:00:00Z");
  const now = () => clock;
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, now);
  const schedule = scheduler(jsonStore<Job[]>(undefined, "j", []), notify, now);
  schedule.add(parseJob({ text: "once", at: "2026-11-05T20:01:00Z" }, clock) as Job);
  schedule.add(parseJob({ text: "every", everyMinutes: 10 }, clock) as Job);
  clock = new Date("2026-11-05T20:11:00Z");
  await schedule.tick();
  await schedule.tick();
  assert.deepEqual(notify.recent().map((n) => n.text).sort(), ["every", "once"]);
  assert.deepEqual(schedule.list().map((j) => j.text), ["every"]);
  assert.equal(schedule.list()[0].nextRun, "2026-11-05T20:21:00.000Z");
});

test("jobs persist across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-state-"));
  const clock = new Date("2026-11-05T20:00:00Z");
  const first = scheduler(jsonStore<Job[]>(dir, "jobs", []), notifier(jsonStore<Notification[]>(dir, "n", [])));
  first.add(parseJob({ text: "standup", dailyAt: "09:30" }, clock) as Job);
  const second = scheduler(jsonStore<Job[]>(dir, "jobs", []), notifier(jsonStore<Notification[]>(dir, "n", [])));
  assert.equal(second.list()[0].text, "standup");
  assert.equal(second.status().state, "degraded"); // persisted, but it has not ticked yet
});

test("invalid jobs are refused with a reason", () => {
  const now = new Date("2026-11-05T20:00:00Z");
  assert.match(parseJob({ text: "x" }, now) as string, /exactly one/);
  assert.match(parseJob({ text: "x", dailyAt: "25:00" }, now) as string, /HH:MM/);
  assert.match(parseJob({ text: "x", at: "2020-01-01T00:00:00Z" }, now) as string, /future/);
});
