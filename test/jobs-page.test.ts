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
  assert.equal(html.match(/setInterval\(/g)?.length, 3, "only the status, inbox and message-time timers; the jobs timer is the poller");
  // The page's visibility listeners are the notifications receipt (docs/assistant.md, "Notifications"): it acks notes the
  // page already holds when they become visible on screen, and the message-time relabel (docs/threads.md, "Message rows and
  // times"). Neither refreshes anything (no rows, no lists).
  assert.deepEqual(html.match(/[^\n]*visibilitychange[^\n]*/g)?.map((l) => l.trim()), ['document.addEventListener("visibilitychange", () => ackListedNotes());', 'document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tickTimes(); });']);
  // The message-time tick only relabels what is drawn: it makes no request.
  const tick = html.match(/const tickTimes = [^\n]*/)![0] + (html.match(/\/\/ <msgtime>[\s\S]*?\/\/ <\/msgtime>/)?.[0] ?? "");
  assert.ok(tick.includes("refreshMsgTimes(alog") && tick.includes("function refreshMsgTimes("));
  assert.doesNotMatch(tick, /fetch\(|tapi\(|XMLHttpRequest/);
  const ackFn = html.match(/function ackListedNotes\(\) \{[\s\S]*?\n  \}/)![0];
  assert.deepEqual(ackFn.match(/fetch\(`[^`]*`/g), ["fetch(`/notifications/${encodeURIComponent(n.id)}/ack`"]);
  assert.match(html, /makePoller\(refreshJobs, \(\) => tab === "jobs" && document\.visibilityState === "visible", setInterval, 15000\)/);
});
