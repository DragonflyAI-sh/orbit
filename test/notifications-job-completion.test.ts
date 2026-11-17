import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildIngress } from "../src/ingress.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { notifier } from "../src/notify.ts";
import type { Notification, Sink } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";
import { OWNER, rig } from "./threads-fixture.ts";

// A job's completion, end to end on the REAL code: the runner's summary event through the job ingress (src/ingress.ts, with
// the job's own token), the real job registry and notifier on JSON stores in a temp state directory, the real server's
// GET /notifications, and the real index.html in Chromium. Nothing is re-queued by the test.
//
// The regression: a job that finishes during quiet hours (23:00-08:00 Pacific; job ids are UTC, so a job id stamped 07:48 is
// 23:48 Pacific) records a non-urgent "finished: done" note held until 08:00. The page listed only due notes, so it showed a
// count of 0 and "No notifications." although the note was stored. Quiet hours are for pushed delivery (Discord): the page
// now lists held notes at once, and Discord still waits for 08:00.
// Also: a failed read of GET /notifications is shown as a failure, never as an empty inbox.
// The API tests always run; the browser tests are skipped, saying so, where Playwright cannot be loaded. Offline, no Discord.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; job-completion notification browser tests skipped";

const QUIET = new Date("2026-11-17T07:48:00Z").getTime(); // 23:48 Pacific
const MORNING = new Date("2026-11-17T16:00:00Z").getTime(); // 08:00 Pacific, when the hold ends
const JOB = "orbit-202611170748-e4yy";
const clock = { t: QUIET };
const now = () => new Date(clock.t);
const stateDir = () => mkdtempSync(join(tmpdir(), "orbit-jobnotes-"));

// One ORBIT process (server, job registry and notifier sharing one state directory, as in src/main.ts) plus its job ingress.
// Calling it again on the same directory is a restart. `discord` is a fake sink that only records what it was asked to send.
function orbit(dir: string, discord?: Sink) {
  let notify!: ReturnType<typeof notifier>;
  let jobs!: ReturnType<typeof jobRegistry>;
  const r = rig({
    dir,
    extra: () => {
      notify = notifier(jsonStore<Notification[]>(dir, "notifications", []), discord, now);
      jobs = jobRegistry(jsonStore<Job[]>(dir, "jobs-cloud", []), Buffer.alloc(32, 7), notify, now);
      return { notify, jobs };
    },
  });
  const ingress = buildIngress(jobs, () => clock.t);
  const ready = new Promise<void>((res) => ingress.listen(0, "127.0.0.1", res));
  const event = async (id: string, token: string, body: object) => {
    await ready;
    const res = await fetch(`http://127.0.0.1:${(ingress.address() as AddressInfo).port}/v1/jobs/${id}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  };
  const base = async () => (await r.api("/status"), `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`);
  const close = () => { r.close(); ingress.close(); };
  after(close);
  return { r, notify, jobs, event, base, close };
}
type Orbit = ReturnType<typeof orbit>;

// Registers the job and has its runner report a start and a finished summary over the ingress, as orbit-job does.
async function finishJob(o: Orbit, text = "All done.", id = JOB) {
  const reg = o.jobs.register(id);
  assert.ok("token" in reg);
  assert.equal(await o.event(id, reg.token, { type: "started" }), 200);
  assert.equal(await o.event(id, reg.token, { type: "summary", status: "done", text }), 200);
  return reg.token;
}
const finished = (o: Orbit) => o.notify.recent().filter((n) => n.text.startsWith(`Job ${JOB} finished: done`));

// ---- the server's contract (always runs) ------------------------------------------------------------------------------

test("API: a job that finishes in quiet hours is stored, held for Discord, and listed in `current` at once", async () => {
  clock.t = QUIET;
  const o = orbit(stateDir());
  await finishJob(o);
  const [note, ...more] = finished(o);
  assert.ok(note, "the completion created a notification");
  assert.equal(more.length, 0);
  assert.equal(note.urgent, false, "a done job is not urgent");
  assert.equal(note.holdUntil, new Date(MORNING).toISOString(), "held for pushed delivery until 08:00 Pacific");
  const body = (await o.r.api("/notifications")).data;
  assert.deepEqual(body.current.map((n: Notification) => n.id), [note.id], "the page's list has the held completion");
  assert.deepEqual(body.inbox, [], "`inbox` (older pages) still lists due notes only");
});

test("API: a repeated completion does not add a second note; the note survives a restart", async () => {
  clock.t = QUIET;
  const dir = stateDir();
  const o = orbit(dir);
  const token = await finishJob(o);
  // A runner retrying its summary: the job is finished, so its token no longer works and nothing is recorded.
  assert.equal(await o.event(JOB, token, { type: "summary", status: "done", text: "All done." }), 401);
  assert.equal(finished(o).length, 1);
  const id = finished(o)[0]!.id;
  o.close();
  const o2 = orbit(dir);
  assert.deepEqual((await o2.r.api("/notifications")).data.current.map((n: Notification) => n.id), [id], "kept across a restart");
});

test("API: Discord still waits for the end of quiet hours and sends the completion once, listed or not", async () => {
  clock.t = QUIET;
  const sent: string[] = [];
  const discord: Sink = { name: "discord", send: async (text) => (sent.push(text), `msg-${sent.length}`) };
  const o = orbit(stateDir(), discord);
  await finishJob(o);
  const id = finished(o)[0]!.id;
  // The page lists it and records the listing receipt during quiet hours.
  assert.equal((await o.r.api(`/notifications/${id}/ack`, "POST", { listed: true })).data.shown.listed, true);
  await o.notify.pump();
  assert.deepEqual(sent, [], "nothing is pushed during quiet hours");
  clock.t = MORNING;
  await o.notify.pump();
  await o.notify.pump();
  assert.equal(sent.length, 1, "pushed once when the hold ends");
  assert.match(sent[0]!, new RegExp(`^Job ${JOB} finished: done`));
  assert.equal(o.notify.get(id)!.discord?.ok, true);
  clock.t = QUIET;
});

test("API: the completion stays owner-only", async () => {
  clock.t = QUIET;
  const o = orbit(stateDir());
  await finishJob(o);
  o.r.caller.who = "someone@example.com";
  try {
    const res = await o.r.api("/notifications");
    assert.equal(res.status, 403);
    assert.equal(JSON.stringify(res.data).includes(JOB), false);
  } finally {
    o.r.caller.who = OWNER;
  }
});

// ---- the page in a real browser against the real server ---------------------------------------------------------------

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

async function openPage(url: string, opts: { context?: any; setup?: (page: any) => Promise<void> } = {}) {
  const context = opts.context ?? (await browser.newContext({ viewport: { width: 900, height: 700 } }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await opts.setup?.(page);
  await page.goto(url);
  await page.waitForFunction(() => document.readyState === "complete");
  return { page, context, errors };
}
const countIs = (page: any, v: string) => page.waitForFunction((want: string) => document.getElementById("notecount")!.textContent === want, v);
const label = (page: any) => page.getAttribute("#notesbtn", "aria-label");
const settle = () => new Promise((r) => setTimeout(r, 300));

test("browser: a quiet-hours completion shows on the count and in the panel on every page, across a reload and a restart", { skip }, async () => {
  clock.t = QUIET;
  const dir = stateDir();
  const o = orbit(dir);
  // Runner text is untrusted: it must show as text.
  await finishJob(o, 'Finished <img src=x onerror="window.__pwned=1"> fine.');
  const base = await o.base();
  const { page, context, errors } = await openPage(`${base}/#assistant`);
  try {
    await countIs(page, "1");
    assert.equal(await label(page), "Notifications: 1");
    assert.equal(await page.evaluate(() => document.getElementById("notesbtn")!.classList.contains("has")), true);
    // The header's page links: Jobs, Sessions, back to the Assistant. The count stays right on each.
    await page.click("#jobstab");
    await page.waitForFunction(() => location.hash === "#jobs");
    await countIs(page, "1");
    await page.click("#sessionstab");
    await page.waitForFunction(() => location.pathname.startsWith("/sessions"));
    await countIs(page, "1");
    await page.click("#notesbtn");
    const text = await page.textContent("#inbox .note");
    assert.match(text, new RegExp(`Job ${JOB} finished: done`));
    assert.equal(await page.isVisible("#inbox .empty"), false, "no 'No notifications.' next to a listed note");
    await page.click("#inbox .note button:not(.x)"); // "more": the summary text, as text
    assert.match(await page.textContent("#inbox .note"), /Finished <img src=x onerror="window.__pwned=1"> fine\./);
    assert.equal(await page.locator("#inbox img").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
    await page.click("#assistanttab");
    await page.waitForFunction(() => location.hash === "#assistant" || location.pathname === "/");
    await countIs(page, "1");
    // Reload (the panel stays open, as before): the server still has the note.
    await page.reload();
    await countIs(page, "1");
    // Restart ORBIT on the same state directory and open the Sessions page from the new process.
    o.close();
    const o2 = orbit(dir);
    const again = await openPage(`${await o2.base()}/sessions`, { context });
    await countIs(again.page, "1");
    assert.match(await again.page.textContent("#inbox .note"), new RegExp(`Job ${JOB} finished: done`));
    assert.deepEqual([...errors, ...again.errors], [], "no page errors");
  } finally {
    await context.close();
  }
});

test("browser: a repeated completion leaves one note and a count of 1", { skip }, async () => {
  clock.t = QUIET;
  const o = orbit(stateDir());
  const token = await finishJob(o);
  const { page, context } = await openPage(`${await o.base()}/#assistant`);
  try {
    await countIs(page, "1");
    assert.equal(await o.event(JOB, token, { type: "summary", status: "done", text: "All done." }), 401);
    await page.evaluate("refreshInbox()");
    await settle();
    assert.equal(await page.textContent("#notecount"), "1");
    await page.click("#notesbtn");
    assert.equal(await page.locator("#inbox .note").count(), 1);
  } finally {
    await context.close();
  }
});

test("browser: a failed read is shown as a failure, never as an empty inbox; a real empty inbox says so", { skip }, async () => {
  clock.t = QUIET;
  const o = orbit(stateDir());
  // 1. ORBIT answers 500 first: the count is "?", not 0, and the panel says the read failed.
  let mode: "500" | "abort" | "garbage" | "pass" = "500";
  const { page, context } = await openPage(`${await o.base()}/#assistant`, {
    setup: (p) => p.route("**/notifications", (route: any) => {
      if (route.request().method() !== "GET") return route.continue();
      if (mode === "500") return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      if (mode === "abort") return route.abort();
      if (mode === "garbage") return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return route.continue();
    }),
  });
  try {
    await page.click("#notesbtn");
    await page.waitForSelector("#inbox .readerr");
    assert.equal(await page.textContent("#notecount"), "?");
    assert.equal(await label(page), "Notifications: could not be read");
    assert.equal(await page.textContent("#inbox .readerr"), "ORBIT's notifications could not be read (HTTP 500).");
    assert.equal(await page.locator("#inbox .empty").count(), 0, "not 'No notifications.'");
    // 2. A 200 that is not a notifications answer is a failure too.
    mode = "garbage";
    await page.evaluate("refreshInbox()");
    await page.waitForFunction(() => document.querySelector("#inbox .readerr")?.textContent === "ORBIT's answer about notifications could not be read.");
    assert.equal(await page.textContent("#notecount"), "?");
    // 3. ORBIT answers with a genuinely empty list: that, and only that, is "No notifications." with a count of 0.
    mode = "pass";
    await page.evaluate("refreshInbox()");
    await countIs(page, "0");
    assert.equal(await page.textContent("#inbox .empty"), "No notifications.");
    assert.equal(await page.locator("#inbox .readerr").count(), 0);
    assert.equal(await label(page), "Notifications: none");
    // 4. A job finishes; the page lists it. Then ORBIT becomes unreachable: the last list stays, with the failure said.
    await finishJob(o);
    await page.evaluate("refreshInbox()");
    await countIs(page, "1");
    mode = "abort";
    await page.evaluate("refreshInbox()");
    await page.waitForSelector("#inbox .readerr");
    assert.equal(await page.textContent("#inbox .readerr"), "ORBIT could not be reached for notifications. Showing the last list read.");
    assert.equal(await page.textContent("#notecount"), "1");
    assert.equal(await label(page), "Notifications: 1 (the last list read; the latest refresh failed)");
    assert.equal(await page.locator("#inbox .note").count(), 1);
    // 5. ORBIT is back: the failure line goes.
    mode = "pass";
    await page.evaluate("refreshInbox()");
    await page.waitForFunction(() => !document.querySelector("#inbox .readerr"));
    assert.equal(await label(page), "Notifications: 1");
  } finally {
    await context.close();
  }
});

test("browser: someone who is not the owner is told the notifications are the owner's, not shown an empty inbox", { skip }, async () => {
  clock.t = QUIET;
  const o = orbit(stateDir());
  await finishJob(o);
  const base = await o.base();
  o.r.caller.who = "someone@example.com";
  const { page, context } = await openPage(`${base}/sessions`);
  try {
    await page.click("#notesbtn");
    await page.waitForSelector("#inbox .readerr");
    assert.equal(await page.textContent("#inbox .readerr"), "Notifications are for ORBIT's owner; this sign-in cannot read them.");
    assert.equal(await page.textContent("#notecount"), "?");
    assert.equal(await page.locator("#inbox .note").count(), 0);
    assert.equal((await page.content()).includes(JOB), false, "nothing of the owner's note reaches the page");
  } finally {
    o.r.caller.who = OWNER;
    await context.close();
  }
});
