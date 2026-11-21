import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { memoryReport, runner } from "../src/runs.ts";
import type { Run } from "../src/runs.ts";
import { jsonStore } from "../src/store.ts";
import { OWNER, rig } from "./threads-fixture.ts";

// Notifications against the REAL ORBIT server (buildServer, the real notifier and runner on JSON stores in a temp state
// directory, the real index.html), not a fake of its routes. Nothing is re-queued by the test: what a reload, another
// browser or a restart sees is whatever the server kept. Pins the semantics in docs/assistant.md ("Notifications"):
// - shown: a receipt that the note was listed in the open notifications panel of a visible tab; never read; never sent for a
//   collapsed panel, a hidden tab or a note past the list limit; idempotent; it is what moves a reviewed run to delivered;
// - dismissed: recorded by ORBIT, so no browser, device or restart lists the note again; not a receipt; collapsing the panel
//   is neither.
// The API tests always run. The browser tests use Playwright's Chromium and are skipped, saying so, where it cannot be loaded.
// Offline: the model is the fixture's script, the vault a temp directory, no Discord.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; real-server notification browser tests skipped";

const LISTED = "Listed in the open notifications panel of the ORBIT web page";
// 12:00 Pacific, outside quiet hours, so nothing is held. A test can move it.
const clock = { t: new Date("2026-11-17T20:00:00Z").getTime() };
const now = () => new Date(clock.t);

// One ORBIT process on a state directory. Calling it again on the same directory is a restart.
function orbit(dir: string) {
  let notify!: ReturnType<typeof notifier>;
  let runs!: ReturnType<typeof runner>;
  const r = rig({
    dir,
    extra: ({ memory }) => {
      notify = notifier(jsonStore<Notification[]>(dir, "notifications", []), undefined, now);
      runs = runner(jsonStore<Run[]>(dir, "runs", []), [memoryReport(memory)], notify, now);
      return { notify, runs };
    },
  });
  const base = async () => (await r.api("/status"), `http://127.0.0.1:${(r.server.address() as { port: number }).port}/`);
  return { r, notify, runs, base };
}
const stateDir = () => mkdtempSync(join(tmpdir(), "orbit-notes-"));
const urgent = (o: ReturnType<typeof orbit>, n: number, from = 1) => Array.from({ length: n }, (_, i) => o.notify.send(`Note ${from + i}\nbody ${from + i}`, true));
const receipt = (o: ReturnType<typeof orbit>, id: string) => o.notify.get(id)?.shown;

// A reviewed memory-report run with its notification queued (non-urgent, due at noon).
async function reviewedRun(o: ReturnType<typeof orbit>): Promise<Run> {
  const sent = await o.r.api("/runs", "POST", { worker: "memory-report", input: { query: "noodle" } });
  assert.equal(sent.status, 202);
  for (let i = 0; i < 100 && o.runs.get(sent.data.id)?.state !== "reviewed"; i++) await new Promise((r) => setTimeout(r, 10));
  const run = o.runs.get(sent.data.id)!;
  assert.equal(run.state, "reviewed");
  assert.ok(run.notification);
  return run;
}

// ---- the server's contract (always runs) ------------------------------------------------------------------------------

test("API: GET /notifications adds `current` (unshown or listed, held or due) and keeps `inbox` and `recent` as they were", async () => {
  const o = orbit(stateDir());
  clock.t = new Date("2026-11-17T07:30:00Z").getTime(); // 23:30 Pacific: a non-urgent note is held
  const held = o.notify.send("held until morning");
  clock.t = new Date("2026-11-17T20:00:00Z").getTime();
  const [a, b, c] = urgent(o, 3);
  clock.t = new Date("2026-11-17T07:30:00Z").getTime();
  try {
    const body = (await o.r.api("/notifications")).data;
    // Quiet hours hold Discord only: the page lists the held note at once. `inbox` (older pages) is unchanged: due notes only.
    assert.deepEqual(body.current.map((n: Notification) => n.id), [held.id, a!.id, b!.id, c!.id], "unshown notes, oldest first, the held one too");
    assert.deepEqual(body.inbox.map((n: Notification) => n.id), [a!.id, b!.id, c!.id]);
    assert.ok(body.recent.some((n: Notification) => n.id === held.id));
    // A listing receipt keeps the note in `current` (until the page dismisses it) and takes it out of `inbox`, as before.
    assert.equal((await o.r.api(`/notifications/${a!.id}/ack`, "POST", { listed: true })).data.shown.detail, LISTED);
    // An older page's ack (no body) records the original receipt, which is never treated as a listing.
    const old = await o.r.api(`/notifications/${b!.id}/ack`, "POST");
    assert.deepEqual([old.status, old.data.shown.detail, old.data.shown.listed], [200, "Shown in the ORBIT web page", undefined]);
    const after = (await o.r.api("/notifications")).data;
    assert.deepEqual(after.current.map((n: Notification) => n.id), [held.id, a!.id, c!.id]);
    assert.deepEqual(after.inbox.map((n: Notification) => n.id), [c!.id]);
  } finally {
    clock.t = new Date("2026-11-17T20:00:00Z").getTime();
  }
});

test("API: an ack is idempotent: a retry or a second tab keeps the first receipt, and an old receipt is never upgraded", async () => {
  const o = orbit(stateDir());
  const [a, b] = urgent(o, 2);
  const first = await o.r.api(`/notifications/${a!.id}/ack`, "POST", { listed: true });
  clock.t += 60_000;
  const again = await o.r.api(`/notifications/${a!.id}/ack`, "POST", { listed: true });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.shown, first.data.shown, "the receipt is not rewritten");
  await o.r.api(`/notifications/${b!.id}/ack`, "POST");
  const upgraded = await o.r.api(`/notifications/${b!.id}/ack`, "POST", { listed: true });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.data.shown.listed, undefined, "an old receipt stays as written");
  assert.equal(upgraded.data.shown.detail, "Shown in the ORBIT web page");
  const missing = await o.r.api("/notifications/00000000-0000-4000-8000-000000000000/ack", "POST", { listed: true });
  assert.equal(missing.status, 404);
  assert.equal((await o.r.api(`/notifications/${a!.id}/ack`, "POST", "not json" as unknown as object)).status, 200, "a JSON string is a body, not a listing");
  const bad = await fetch(`${await o.base()}notifications/${b!.id}/ack`, { method: "POST", body: "{" });
  assert.equal(bad.status, 400);
});

test("API: notifications and acks stay owner-only; a refused ack writes no receipt", async () => {
  const o = orbit(stateDir());
  const [a] = urgent(o, 1);
  o.r.caller.who = "someone@example.com";
  try {
    assert.equal((await o.r.api("/notifications")).status, 403);
    assert.equal((await o.r.api(`/notifications/${a!.id}/ack`, "POST", { listed: true })).status, 403);
    o.r.caller.who = undefined;
    assert.equal((await o.r.api(`/notifications/${a!.id}/ack`, "POST", { listed: true })).status, 403);
  } finally {
    o.r.caller.who = OWNER;
  }
  assert.equal(receipt(o, a!.id), undefined);
});

test("API: a reviewed run is delivered only by a receipt; unshown and listed notes survive a restart unchanged", async () => {
  const dir = stateDir();
  const o = orbit(dir);
  const run = await reviewedRun(o);
  const [x] = urgent(o, 1);
  o.runs.pump();
  assert.equal(o.runs.get(run.id)!.state, "reviewed", "no receipt, no delivery");
  await o.r.api(`/notifications/${run.notification}/ack`, "POST", { listed: true });
  const shown = receipt(o, run.notification!);
  o.runs.pump();
  const delivered = o.runs.get(run.id)!;
  assert.equal(delivered.state, "delivered");
  assert.match(delivered.events.at(-1)!.detail, new RegExp(`^Receipt: ${LISTED} at `));
  o.r.close();
  const o2 = orbit(dir);
  const body = (await o2.r.api("/notifications")).data;
  assert.deepEqual(body.current.map((n: Notification) => n.id), [run.notification, x!.id], "both kept across the restart");
  assert.deepEqual(o2.notify.get(run.notification!)!.shown, shown, "the receipt is unchanged");
  assert.equal(o2.notify.get(x!.id)!.shown, undefined);
  assert.equal(o2.runs.get(run.id)!.state, "delivered");
});

test("API: a dismissal is kept by ORBIT: the note leaves `current` and `inbox` everywhere, idempotently, across a restart", async () => {
  const dir = stateDir();
  const o = orbit(dir);
  const [a, b, c] = urgent(o, 3);
  await o.r.api(`/notifications/${a!.id}/ack`, "POST", { listed: true });
  const shown = receipt(o, a!.id);
  const first = await o.r.api(`/notifications/${a!.id}/dismiss`, "POST", {});
  assert.equal(first.status, 200);
  assert.equal(first.data.dismissed.detail, "Dismissed in the ORBIT web page");
  assert.deepEqual(first.data.shown, shown, "dismissing never touches the shown receipt");
  // A note dismissed before it was ever listed is gone too, and still has no receipt.
  assert.equal((await o.r.api(`/notifications/${b!.id}/dismiss`, "POST")).status, 200);
  assert.equal(receipt(o, b!.id), undefined);
  const body = (await o.r.api("/notifications")).data;
  assert.deepEqual(body.current.map((n: Notification) => n.id), [c!.id]);
  assert.deepEqual(body.inbox.map((n: Notification) => n.id), [c!.id]);
  assert.ok(body.recent.some((n: Notification) => n.id === a!.id), "ORBIT still keeps the note in `recent`");
  // Repeating it (a retry, a second tab) keeps the first dismissal.
  clock.t += 60_000;
  const again = await o.r.api(`/notifications/${a!.id}/dismiss`, "POST", {});
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.dismissed, first.data.dismissed);
  assert.equal((await o.r.api("/notifications/00000000-0000-4000-8000-000000000000/dismiss", "POST", {})).status, 404);
  // Restart on the same state directory: the dismissals hold.
  o.r.close();
  const o2 = orbit(dir);
  assert.deepEqual((await o2.r.api("/notifications")).data.current.map((n: Notification) => n.id), [c!.id]);
  assert.deepEqual(o2.notify.get(a!.id)!.dismissed, first.data.dismissed);
});

test("API: dismissing is owner-only and a refused dismissal writes nothing; it never holds back Discord or run delivery", async () => {
  const o = orbit(stateDir());
  const run = await reviewedRun(o);
  const [a] = urgent(o, 1);
  o.r.caller.who = "someone@example.com";
  try {
    assert.equal((await o.r.api(`/notifications/${a!.id}/dismiss`, "POST", {})).status, 403);
  } finally {
    o.r.caller.who = OWNER;
  }
  assert.equal(o.notify.get(a!.id)!.dismissed, undefined);
  // A dismissal is not a receipt: the run stays reviewed until a real one arrives.
  await o.r.api(`/notifications/${run.notification}/dismiss`, "POST", {});
  o.runs.pump();
  assert.equal(o.runs.get(run.id)!.state, "reviewed");
  // Delivery itself is unchanged: a dismissed due note still goes to Discord when it is connected.
  const sent: string[] = [];
  const store = jsonStore<Notification[]>(undefined, "n", []);
  const withDiscord = notifier(store, { name: "discord", send: async (t) => (sent.push(t), "m1") }, now);
  const n = withDiscord.send("dismissed early", true);
  withDiscord.dismiss(n.id);
  await withDiscord.pump();
  assert.deepEqual(sent, ["dismissed early"]);
  assert.equal(withDiscord.get(n.id)!.discord?.ok, true);
  assert.deepEqual(withDiscord.current(), []);
});

// ---- the page in a real browser against the real server ---------------------------------------------------------------

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

// A page whose visibility the test can set (Chromium's headless tabs are always visible): it overrides
// document.visibilityState/hidden and fires visibilitychange, which is what the page listens to.
async function openPage(base: string, opts: { context?: any; notesOpen?: boolean; setup?: (page: any) => Promise<void> } = {}) {
  const context = opts.context ?? (await browser.newContext({ viewport: { width: 900, height: 700 } }));
  const page = await context.newPage();
  await page.addInitScript(`(() => {
    let vis = "visible";
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => vis });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => vis !== "visible" });
    window.__setVisibility = (v) => { vis = v; document.dispatchEvent(new Event("visibilitychange")); };
    ${opts.notesOpen ? `sessionStorage.setItem("orbit.header-panels", JSON.stringify({ status: false, notes: true }));` : ""}
  })()`);
  const acks: string[] = [];
  page.on("request", (req: any) => { const m = new URL(req.url()).pathname.match(/^\/notifications\/([^/]+)\/ack$/); if (m && req.method() === "POST") acks.push(m[1]); });
  await opts.setup?.(page);
  await page.goto(base);
  await page.waitForFunction(() => document.readyState === "complete");
  return { page, context, acks };
}
const count = (page: any) => page.textContent("#notecount");
const waitCount = (page: any, n: number) => page.waitForFunction((v: string) => document.getElementById("notecount")!.textContent === v, String(n));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), what);
}
const settle = () => new Promise((r) => setTimeout(r, 300));

test("browser: arrivals in a collapsed panel get no receipt and leave the run reviewed; they survive a reload and a restart", { skip }, async () => {
  const dir = stateDir();
  const o = orbit(dir);
  const run = await reviewedRun(o);
  const notes = urgent(o, 11, 2);
  const { page, context, acks } = await openPage(await o.base());
  try {
    await waitCount(page, 12);
    await settle();
    assert.equal(await page.getAttribute("#notesbtn", "aria-expanded"), "false");
    assert.deepEqual(acks, [], "the badge changed; nothing was displayed, so no ack");
    for (const id of [run.notification!, ...notes.map((n) => n.id)]) assert.equal(receipt(o, id), undefined, id);
    o.runs.pump();
    assert.equal(o.runs.get(run.id)!.state, "reviewed");
    // Reload: the server still holds every unseen note; the test re-adds nothing.
    await page.reload();
    await waitCount(page, 12);
    // Restart ORBIT on the same state directory and open the page from the new process.
    o.r.close();
    const o2 = orbit(dir);
    const again = await openPage(await o2.base(), { context });
    await waitCount(again.page, 12);
    await settle();
    assert.deepEqual(again.acks, []);
    // Open the panel: the ten listed (newest) notes get a listing receipt; the two past the limit do not.
    await again.page.click("#notesbtn");
    const listed = notes.slice(1).map((n) => n.id);
    await until(() => listed.every((id) => receipt(o2, id)?.listed === true), "the listed notes have a listing receipt");
    await settle();
    assert.equal(receipt(o2, notes[0]!.id), undefined, "past the limit: no receipt");
    assert.equal(receipt(o2, run.notification!), undefined, "past the limit: no receipt");
    o2.runs.pump();
    assert.equal(o2.runs.get(run.id)!.state, "reviewed", "the run's note was not listed yet");
    // Show all: the newly listed two get theirs, and the run is delivered on that receipt.
    await again.page.click("#inbox .showall");
    await until(() => receipt(o2, run.notification!)?.listed === true && receipt(o2, notes[0]!.id)?.listed === true, "newly listed notes acked");
    o2.runs.pump();
    assert.equal(o2.runs.get(run.id)!.state, "delivered");
    assert.match(o2.runs.get(run.id)!.events.at(-1)!.detail, new RegExp(`^Receipt: ${LISTED}`));
    // Shown is not dismissed: after a reload every note is still listed and counted.
    await again.page.reload();
    await waitCount(again.page, 12);
    await settle();
    assert.equal(new Set(again.acks).size, again.acks.length, "one ack per note: no duplicates");
  } finally {
    await context.close();
  }
});

test("browser: a hidden tab sends no receipt even with the panel open; becoming visible sends it", { skip }, async () => {
  const o = orbit(stateDir());
  const { page, context, acks } = await openPage(await o.base(), { notesOpen: true });
  try {
    assert.equal(await page.getAttribute("#notesbtn", "aria-expanded"), "true");
    await page.evaluate(() => (window as any).__setVisibility("hidden"));
    const [n] = urgent(o, 1);
    await page.evaluate("refreshInbox()");
    await waitCount(page, 1);
    assert.equal(await page.isVisible("#inbox .note"), true, "listed in the panel's markup");
    await settle();
    assert.deepEqual(acks, []);
    assert.equal(receipt(o, n!.id), undefined, "not on screen: the tab is hidden");
    await page.evaluate(() => (window as any).__setVisibility("visible"));
    await until(() => receipt(o, n!.id)?.listed === true, "acked once the tab is visible");
    // Open and visible: a new arrival is listed and acked at the refresh.
    const [m] = urgent(o, 1, 2);
    await page.evaluate("refreshInbox()");
    await until(() => receipt(o, m!.id)?.listed === true, "a new arrival in an open, visible panel is acked");
  } finally {
    await context.close();
  }
});

test("browser: a failed ack is retried later, a sent one is not repeated, and a second tab keeps the first receipt", { skip }, async () => {
  const o = orbit(stateDir());
  const [n] = urgent(o, 1);
  // The first try (at load: the panel is open and the tab visible) fails on the network: no receipt, nothing claimed.
  let fail = true;
  const { page, context, acks } = await openPage(await o.base(), {
    notesOpen: true,
    setup: (p) => p.route("**/notifications/*/ack", (route: any) => (fail ? (fail = false, route.abort()) : route.continue())),
  });
  try {
    await until(() => acks.length >= 1 && !fail, "the first ack was tried");
    await settle();
    assert.equal(receipt(o, n!.id), undefined, "a failed ack writes nothing");
    // The next refresh retries it.
    await page.evaluate("refreshInbox()");
    await until(() => receipt(o, n!.id)?.listed === true, "retried and recorded");
    const first = receipt(o, n!.id);
    const tries = acks.length;
    for (let i = 0; i < 3; i++) await page.evaluate("refreshInbox()");
    await page.click("#notesbtn");
    await page.click("#notesbtn");
    await settle();
    assert.equal(acks.length, tries, "no more acks once ORBIT has the receipt");
    // A second tab of a fresh browser lists it too; ORBIT already has a listing receipt, so it is not rewritten.
    clock.t += 120_000;
    const other = await openPage(await o.base(), { notesOpen: true });
    await waitCount(other.page, 1);
    await settle();
    assert.deepEqual(receipt(o, n!.id), first);
    assert.deepEqual(other.acks, [], "the server said it was already listed");
    await other.context.close();
  } finally {
    await context.close();
  }
});

test("browser: dismissing is explicit and kept by ORBIT for every browser; collapsing is not dismissing; the unlisted remainder stays unshown", { skip }, async () => {
  const dir = stateDir();
  const o = orbit(dir);
  const notes = urgent(o, 12);
  const ids = notes.map((n) => n.id);
  const { page, context } = await openPage(await o.base());
  try {
    await waitCount(page, 12);
    await page.click("#notesbtn");
    await until(() => ids.slice(2).every((id) => receipt(o, id)?.listed === true), "the ten listed notes acked");
    // Collapse and reopen: no dismissal, count unchanged.
    await page.click("#notesbtn");
    assert.equal(await page.evaluate(() => localStorage.getItem("orbit.dismissed-notes")), null);
    assert.equal(await count(page), "12");
    await page.click("#notesbtn");
    // Dismiss the newest: the count drops and the next note moves into the list, so it is now listed and acked.
    await page.click("#inbox .note .x");
    await waitCount(page, 11);
    await until(() => receipt(o, ids[1]!)?.listed === true, "the note that moved into the list is acked");
    await settle();
    assert.equal(receipt(o, ids[0]!), undefined, "the oldest was never listed: no receipt");
    assert.equal(await page.getAttribute("#notesbtn", "aria-label"), "Notifications: 11");
    // ORBIT recorded the dismissal: it no longer lists the note, and still keeps it.
    await until(() => o.notify.get(ids[11]!)?.dismissed !== undefined, "ORBIT recorded the dismissal");
    assert.deepEqual((await o.r.api("/notifications")).data.current.map((n: Notification) => n.id), ids.slice(0, 11));
    assert.ok(o.notify.get(ids[11]!), "the note is kept, only no longer listed");
    // This browser keeps its dismissal across a reload.
    await page.reload();
    await waitCount(page, 11);
    // Another browser (another device, or this one with its storage cleared) does not list it either.
    const other = await openPage(await o.base());
    await waitCount(other.page, 11);
    await other.context.close();
    // So does an ORBIT restart on the same state directory.
    o.r.close();
    const o2 = orbit(dir);
    const third = await openPage(await o2.base());
    await waitCount(third.page, 11);
    await third.context.close();
  } finally {
    await context.close();
  }
});

test("browser: a dismissal an older page kept in this browser only is sent to ORBIT; a failed one is retried", { skip }, async () => {
  const o = orbit(stateDir());
  const ids = urgent(o, 3).map((n) => n.id);
  // An older page dismissed the oldest note in this browser only.
  const { page, context } = await openPage(await o.base(), { setup: (p) => p.addInitScript(`localStorage.setItem("orbit.dismissed-notes", ${JSON.stringify(JSON.stringify([ids[0]]))})`) });
  try {
    await waitCount(page, 2);
    await until(() => o.notify.get(ids[0]!)?.dismissed !== undefined, "the browser-only dismissal reached ORBIT");
    // A dismissal whose request fails is still hidden here, and reaches ORBIT on a later refresh.
    let failing = true;
    await page.route("**/notifications/*/dismiss", (route: any) => (failing ? route.fulfill({ status: 503, body: "{}" }) : route.continue()));
    await page.click("#notesbtn");
    await page.click("#inbox .note .x");
    await waitCount(page, 1);
    await settle();
    assert.equal(o.notify.get(ids[2]!)!.dismissed, undefined, "the failed request wrote nothing");
    failing = false;
    await page.evaluate("refreshInbox()");
    await until(() => o.notify.get(ids[2]!)?.dismissed !== undefined, "the retry reached ORBIT");
    const other = await openPage(await o.base());
    await waitCount(other.page, 1);
    await other.context.close();
  } finally {
    await context.close();
  }
});

test("browser: the status indicator says not read yet before the first answer, and disconnected (unknown) after a failed request", { skip }, async () => {
  const o = orbit(stateDir());
  const context = await browser.newContext();
  const page = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/status", async (route: any) => { await held; await route.abort(); });
  try {
    await page.goto(await o.base());
    await page.waitForFunction(() => document.readyState === "complete");
    assert.match(await page.getAttribute("#health", "title"), /^ORBIT's status has not been read yet/);
    assert.match(await page.getAttribute("#health", "aria-label"), /has not been read yet/);
    release();
    await page.waitForFunction(() => /could not be reached/.test(document.getElementById("health")!.title));
    assert.equal(await page.getAttribute("#health", "class"), "unknown", "no answer is unknown (grey), never green and not claimed down");
    assert.equal(await page.textContent("#health .label"), "Disconnected");
  } finally {
    await context.close();
  }
});
