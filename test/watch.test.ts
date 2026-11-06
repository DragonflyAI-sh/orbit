import assert from "node:assert/strict";
import { test } from "node:test";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import type { PortState, PortStatus } from "../src/ports.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { jsonStore } from "../src/store.ts";
import { watcher } from "../src/watch.ts";
import type { WatchState } from "../src/watch.ts";

const MIN = 60_000;
const EPOCH = new Date(0).toISOString();

// 2026-11-05 20:00Z is noon Pacific, outside quiet hours.
function rig(store = jsonStore<WatchState>(undefined, "w", { ports: {} }), start = "2026-11-05T20:00:00Z") {
  let t = new Date(start).getTime();
  const now = () => new Date(t);
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, now);
  const states = new Map<string, { state: PortState; verifiedAt?: string; detail?: string }>();
  const watch = watcher(store, notify, now);
  watch.attach(() => [...states].map(([port, s]) => ({ port, state: s.state, impl: "x", detail: s.detail ?? `${port} detail`, verifiedAt: s.verifiedAt ?? now().toISOString() }) as PortStatus));
  const advance = (min: number) => void (t += min * MIN);
  const texts = () => notify.recent().reverse().map((n) => n.text);
  return { watch, notify, states, advance, texts, store, now };
}

test("a port bad for 5 minutes alerts once, and recovers once with how long it was out", () => {
  const r = rig();
  r.states.set("memory", { state: "degraded", detail: "vault unreachable" });
  r.watch.tick();
  r.advance(4);
  r.watch.tick();
  assert.equal(r.texts().length, 0);
  r.advance(1);
  r.watch.tick();
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /"memory" is degraded since 2026-11-05T20:00:00.000Z: vault unreachable/);
  for (let i = 0; i < 10; i++) { r.advance(5); r.watch.tick(); }
  assert.equal(r.texts().length, 1, "no stream");
  assert.match(r.watch.status().detail, /Alerting: memory degraded since/);
  r.states.set("memory", { state: "live" });
  r.advance(1);
  r.watch.tick();
  r.watch.tick();
  assert.equal(r.texts().length, 2);
  assert.match(r.texts()[1], /live again after 56 min/);
  assert.equal(r.watch.status().detail, "Nothing alerting. Not persisted: a restart may repeat an alert.");
});

test("a short blip never alerts and sends no recovery", () => {
  const r = rig();
  r.states.set("tools", { state: "down" });
  r.watch.tick();
  r.advance(3);
  r.states.set("tools", { state: "live" });
  r.watch.tick();
  r.advance(10);
  r.states.set("tools", { state: "down" });
  r.watch.tick();
  r.advance(3);
  r.watch.tick();
  assert.deepEqual(r.texts(), []);
});

test("a port that was never used (epoch verifiedAt) is ignored", () => {
  const r = rig();
  r.states.set("model", { state: "degraded", verifiedAt: EPOCH, detail: "Signed in, not exercised yet" });
  for (let i = 0; i < 5; i++) { r.watch.tick(); r.advance(5); }
  assert.deepEqual(r.texts(), []);
  assert.match(r.watch.status().detail, /Nothing alerting\./);
});

test("only down is urgent: it bypasses quiet hours, degraded is held", () => {
  // 2026-11-05 07:00Z is 23:00 Pacific.
  const r = rig(undefined, "2026-11-05T07:00:00Z");
  r.states.set("memory", { state: "degraded" });
  r.states.set("tools", { state: "down" });
  r.watch.tick();
  r.advance(5);
  r.watch.tick();
  const byText = (s: string) => r.notify.recent().find((n) => n.text.includes(`"${s}"`))!;
  assert.equal(byText("tools").urgent, true);
  assert.equal(byText("tools").holdUntil, undefined);
  assert.equal(byText("memory").urgent, false);
  assert.ok(byText("memory").holdUntil);
});

test("degraded that turns down alerts again as urgent once it has stayed down 5 minutes", () => {
  const r = rig();
  r.states.set("runs", { state: "degraded" });
  r.watch.tick();
  r.advance(5);
  r.watch.tick();
  r.states.set("runs", { state: "down" });
  r.advance(1);
  r.watch.tick();
  r.advance(4);
  r.watch.tick();
  assert.equal(r.texts().length, 1);
  r.advance(1);
  r.watch.tick();
  assert.equal(r.texts().length, 2);
  assert.equal(r.notify.recent()[0].urgent, true);
  r.advance(30);
  r.watch.tick();
  assert.equal(r.texts().length, 2);
});

test("a restart does not re-alert, and still reports the recovery with the original start", () => {
  const disk = { ports: {} } as WatchState;
  const file = { read: () => structuredClone(disk), write: (v: WatchState) => void Object.assign(disk, structuredClone(v)), persisted: true };
  const a = rig(file);
  a.states.set("memory", { state: "down" });
  a.watch.tick();
  a.advance(5);
  a.watch.tick();
  assert.equal(a.texts().length, 1);
  assert.ok(disk.ports.memory);

  // New process, same state directory, same trouble.
  const b = rig(file, "2026-11-05T20:10:00Z");
  b.states.set("memory", { state: "down" });
  b.watch.tick();
  b.advance(10);
  b.watch.tick();
  assert.equal(b.texts().length, 0, "already reported");
  b.states.set("memory", { state: "live" });
  b.advance(1);
  b.watch.tick();
  assert.equal(b.texts().length, 1);
  assert.match(b.texts()[0], /live again after 21 min/);
  assert.deepEqual(disk.ports, {});
});

test("the watch port never watches itself", () => {
  const r = rig();
  r.states.set("watch", { state: "down" });
  r.watch.tick();
  r.advance(10);
  r.watch.tick();
  assert.deepEqual(r.texts(), []);
});

function jobRig() {
  let t = new Date("2026-11-05T20:00:00Z").getTime();
  const now = () => new Date(t);
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, now);
  const registry = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 1), notify, now);
  const store = jsonStore<WatchState>(undefined, "w", { ports: {} });
  const watch = watcher(store, notify, now, registry);
  const advance = (min: number) => void (t += min * MIN);
  const alerts = () => notify.recent().filter((n) => n.text.startsWith("Job ") && /is (quiet|not started)/.test(n.text));
  const launch = (id: string) => {
    registry.register(id);
    registry.setLaunch(id, { routine: "r", at: now().toISOString(), sessionUrl: `https://claude.ai/code/session_${id}` });
  };
  return { registry, watch, advance, alerts, launch, notify, store, now };
}

test("a job that never starts alerts once with its id and session link", () => {
  const r = jobRig();
  r.launch("j1");
  r.advance(9);
  r.watch.tick();
  assert.equal(r.alerts().length, 0);
  r.advance(2);
  r.watch.tick();
  r.advance(30);
  r.watch.tick();
  r.watch.tick();
  assert.equal(r.alerts().length, 1);
  assert.match(r.alerts()[0].text, /Job j1 is not started.*https:\/\/claude\.ai\/code\/session_j1.*no check-in yet/);
  assert.match(r.watch.status().detail, /Jobs alerting: j1 not-started/);
});

test("a quiet job alerts once with its last check-in; reporting again and going quiet again alerts anew; finishing never does", () => {
  const r = jobRig();
  r.launch("j2");
  r.registry.record("j2", { type: "started" });
  r.registry.record("j2", { type: "checkin", text: "reading the code" });
  r.advance(16);
  r.watch.tick();
  r.advance(60);
  r.watch.tick();
  assert.equal(r.alerts().length, 1);
  assert.match(r.alerts()[0].text, /Job j2 is quiet.*session_j2.*reading the code/);

  r.registry.record("j2", { type: "checkin", text: "back" });
  r.watch.tick();
  assert.equal(r.alerts().length, 1, "no extra message when it reports again");
  r.advance(16);
  r.watch.tick();
  assert.equal(r.alerts().length, 2, "a new stall is a new alert");

  r.registry.record("j2", { type: "summary", status: "done", text: "ok" });
  r.advance(120);
  r.watch.tick();
  assert.equal(r.alerts().length, 2);
  assert.doesNotMatch(r.watch.status().detail, /Jobs alerting/);
});

test("a job that finishes while quiet, or a failed launch, does not alert", () => {
  const r = jobRig();
  r.launch("j3");
  r.registry.record("j3", { type: "summary", status: "failed", text: "x" });
  r.registry.setLaunch("j4", { routine: "r", at: r.now().toISOString() });
  r.registry.register("j4");
  r.registry.setLaunch("j4", { routine: "r", at: r.now().toISOString(), failedAt: r.now().toISOString(), error: "no" });
  r.advance(60);
  r.watch.tick();
  assert.equal(r.alerts().length, 0);
});

test("job alerts survive a restart without repeating", () => {
  const r = jobRig();
  r.launch("j5");
  r.advance(11);
  r.watch.tick();
  assert.equal(r.alerts().length, 1);
  const again = watcher(r.store, r.notify, r.now, r.registry);
  again.tick();
  again.tick();
  assert.equal(r.alerts().length, 1);
});
