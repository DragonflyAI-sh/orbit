import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ <poller>([\s\S]*?)\/\/ <\/poller>/)?.[1] ?? "";
type Poller = { poll(): Promise<void>; start(): void };
const makePoller = new Function(`${block}; return makePoller;`)() as (r: () => Promise<void>, s: () => boolean, sch: (f: () => void, ms: number) => void, ms: number) => Poller;

// A fake clock: schedule() records the callback and `advance` fires it every `ms`.
function rig() {
  const page = { tab: "chat", visible: true, requests: 0, pending: undefined as undefined | (() => void) };
  let timer: { f: () => void; ms: number } | undefined;
  const poller = makePoller(
    () => { page.requests++; return page.pending ? new Promise<void>((r) => (page.pending = r)) : Promise.resolve(); },
    () => page.tab === "jobs" && page.visible,
    (f, ms) => void (timer = { f, ms }),
    15000,
  );
  poller.start();
  const seconds = async (n: number) => { for (let i = 0; i < n / (timer!.ms / 1000); i++) { timer!.f(); await Promise.resolve(); await Promise.resolve(); } };
  return { page, poller, seconds, timer: () => timer! };
}

test("opening the Jobs tab makes one request, then one every 15 seconds", async () => {
  const r = rig();
  assert.equal(r.timer().ms, 15000);
  await r.seconds(60);
  assert.equal(r.page.requests, 0, "none on the Chat tab");
  r.page.tab = "jobs";
  await r.poller.poll();
  assert.equal(r.page.requests, 1, "one on open");
  await r.seconds(60);
  assert.equal(r.page.requests, 5, "four more in 60 seconds");
});

test("none while the page is hidden, and none after returning to Chat", async () => {
  const r = rig();
  r.page.tab = "jobs";
  r.page.visible = false;
  await r.poller.poll();
  await r.seconds(120);
  assert.equal(r.page.requests, 0);
  r.page.visible = true;
  await r.seconds(30);
  assert.equal(r.page.requests, 2);
  r.page.tab = "chat";
  await r.seconds(120);
  assert.equal(r.page.requests, 2);
});

test("a slow request is not overlapped by the next tick", async () => {
  const r = rig();
  r.page.tab = "jobs";
  r.page.pending = () => {};
  const first = r.poller.poll();
  await r.seconds(45);
  assert.equal(r.page.requests, 1);
  r.page.pending?.();
  await first;
});

test("the page has one place that fetches the job rows, no extra timers or visibility refreshes", () => {
  assert.equal(html.split("/jobs?view=rows").length - 1, 1);
  assert.equal(html.match(/setInterval\(/g)?.length, 2, "only the status and inbox timers; the jobs timer is the poller");
  assert.doesNotMatch(html, /visibilitychange/);
  assert.match(html, /makePoller\(refreshJobs, \(\) => tab === "jobs" && document\.visibilityState === "visible", setInterval, 15000\)/);
});
