import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ASSISTANT_ID, assistantStore, REV_STRIDE } from "../src/assistant-store.ts";
import type { Step } from "../src/model.ts";
import { rig, say, scripted } from "./threads-fixture.ts";

// The Assistant across restarts and deploys (docs/assistant.md, "Revisions across restarts"). The page ignores any answer whose `rev`
// is below the one it shows (slow or out-of-order answers). Before this fix the revision was an in-memory counter that started at 1
// in every process, so a tab left open across a restart ignored the new process until its counter caught up. These tests open the
// same persisted store and server again and check that an open tab's own update rule accepts the new process at once, keeps
// rejecting stale answers (including a late answer from the old process), and that nothing stored is reset, replayed or lost.
// Offline: temp directories, a scripted model; the browser part runs only where Playwright is installed.

const tmp = () => mkdtempSync(join(tmpdir(), "orbit-assistant-restart-"));
type Store = ReturnType<typeof assistantStore>;

function turn(s: Store, text: string, reply: string) {
  const token = s.tryBegin(ASSISTANT_ID)!;
  assert.ok(token);
  s.appendUser(ASSISTANT_ID, text);
  const mid = s.beginAssistant(ASSISTANT_ID);
  s.patchMessage(ASSISTANT_ID, mid, { text: reply, status: "done", provenance: "live", source: "model/test" });
  s.end(ASSISTANT_ID, token);
}
const filesOf = (dir: string) => {
  const out: Record<string, string> = {};
  for (const sub of ["active", "archive"]) for (const f of readdirSync(join(dir, sub))) out[`${sub}/${f}`] = readFileSync(join(dir, sub, f), "utf8");
  return out;
};

// ---- the page's own update rule, loaded from the page ---------------------------------------------------------------

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))![1]!;
const { aNewer } = new Function(`${block("assistant-order")}; return { aNewer };`)() as { aNewer: (shown: unknown, incoming: unknown) => boolean };
// The rule of the page as shipped before this fix (PR #83), which every tab already open at a deploy is still running.
const prePR = (shown: { rev: number } | null, incoming: { rev: number }) => !(shown && incoming.rev < shown.rev);

// ---- store -----------------------------------------------------------------------------------------------------------

test("regression: a revision after reopening the same persisted store is above every revision the earlier process served", () => {
  const dir = tmp();
  const first = assistantStore(dir);
  for (let i = 0; i < 5; i++) turn(first, `question ${i}`, `answer ${i}`);
  const high = first.rev();
  const files = filesOf(dir);
  const second = assistantStore(dir);
  // Before the fix: high was 21 and the reopened store said 1, so an open tab rejected it.
  assert.ok(second.rev() > high, `reopened rev ${second.rev()} must be above ${high}`);
  assert.ok(second.epoch() > first.epoch());
  assert.deepEqual(filesOf(dir), files, "no chunk was rewritten, reset or deleted to get there");
  assert.deepEqual(second.session(), first.session(), "the same singleton");
  assert.deepEqual(second.active().map((c) => c.messages.map((m) => m.text)), first.active().map((c) => c.messages.map((m) => m.text)));
  // Within the new process every change still raises it.
  const r0 = second.rev();
  turn(second, "after restart", "still here");
  assert.ok(second.rev() > r0);
});

test("repeated restarts: every reopen is above the last, even several within one second and with a clock that goes backwards", () => {
  const dir = tmp();
  let clock = new Date("2026-11-14T12:00:00Z").getTime();
  const now = () => new Date(clock);
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    const s = assistantStore(dir, { now });
    seen.push(s.rev());
    turn(s, `q${i}`, `a${i}`);
    seen.push(s.rev());
    if (i === 3) clock -= 3_600_000; // the clock jumped back an hour
  }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! > seen[i - 1]!, `revision ${i} (${seen[i]}) is above ${seen[i - 1]}`);
  const last = assistantStore(dir, { now });
  assert.equal(last.active().length, 6, "every turn persisted across all six restarts");
  assert.ok(seen.every((r) => Number.isSafeInteger(r)));
});

test("upgrade from the store before epochs: no epoch.json, revisions far above the old process's small plain counter", () => {
  const dir = tmp();
  const old = assistantStore(dir);
  turn(old, "before the deploy", "ok");
  // A store written by the previous version has no epoch file; its process served revisions 1, 2, 3, ... from memory.
  const efile = join(dir, "epoch.json");
  rmSync(efile);
  const fresh = assistantStore(dir);
  assert.ok(fresh.rev() > 1e9, "far above any counter one process could have reached");
  assert.equal(fresh.active().length, 1);
  assert.deepEqual(fresh.problems(), [], "a store from before epochs is normal, not a problem");
  assert.ok(existsSync(efile));
  // An unreadable epoch file: said, not hidden; the clock floor still moves forward; nothing else is touched.
  writeFileSync(efile, "{not json");
  const files = filesOf(dir);
  const corrupt = assistantStore(dir);
  assert.match(corrupt.problems().join(";"), /epoch\.json/);
  assert.ok(corrupt.rev() > 1e9);
  assert.deepEqual(filesOf(dir), files);
  const again = assistantStore(dir);
  assert.ok(again.rev() > corrupt.rev());
  assert.deepEqual(again.problems(), [], "the replaced epoch file reads cleanly afterwards");
});

test("an epoch fills up: the next revision raises the epoch and stays above everything before it, then survives a restart", () => {
  const dir = tmp();
  const s = assistantStore(dir, { revStride: 8 });
  const revs = [s.rev()];
  for (let i = 0; i < 5; i++) {
    turn(s, `q${i}`, `a${i}`);
    revs.push(s.rev());
  }
  for (let i = 1; i < revs.length; i++) assert.ok(revs[i]! > revs[i - 1]!);
  assert.ok(s.epoch() > Math.floor(revs[0]! / 8), "the epoch was raised during the run");
  const reopened = assistantStore(dir, { revStride: 8 });
  assert.ok(reopened.rev() > revs.at(-1)!);
  assert.equal(REV_STRIDE, 2 ** 20);
});

test("no state directory: memory-only revisions still start above a restarted process's earlier ones (clock floor)", () => {
  let clock = new Date("2026-11-14T12:00:00Z").getTime();
  const a = assistantStore(undefined, { now: () => new Date(clock) });
  turn(a, "x", "y");
  clock += 2000;
  const b = assistantStore(undefined, { now: () => new Date(clock) });
  assert.ok(b.rev() > a.rev());
  assert.equal(b.persisted, false);
});

// ---- the page's update rule ------------------------------------------------------------------------------------------

test("client rule: higher or equal is drawn, lower is ignored, and an answer with no revision never replaces a drawn one", () => {
  assert.equal(aNewer(null, { rev: 5 }), true, "the first answer is always drawn");
  assert.equal(aNewer({ rev: 5 }, { rev: 5 }), true);
  assert.equal(aNewer({ rev: 5 }, { rev: 6 }), true);
  assert.equal(aNewer({ rev: 6 }, { rev: 5 }), false, "an out-of-order poll is ignored");
  assert.equal(aNewer({ rev: 6 }, {}), false);
  assert.equal(aNewer({ rev: 6 }, null), false);
});

// ---- real server, restarted on the same state directory ----------------------------------------------------------------

const viewOf = async (x: ReturnType<typeof rig>) => (await x.api("/assistant")).data.assistant;
const texts = (view: any) => view.chunks.flatMap((c: any) => c.messages.map((m: any) => m.text));

test("regression (server): a tab holding a high revision accepts the restarted server at once, and later updates from another device", async () => {
  const dir = tmp();
  const extra = () => ({ assistantDir: join(dir, "assistant") });
  const p1 = rig({ dir, extra, model: scripted((seen) => say(`one #${seen.input.length}`)) });
  // Drive the first process's revision high: many turns and polls, as a long-lived process would.
  for (let i = 0; i < 12; i++) assert.equal((await p1.api("/assistant/messages", "POST", { text: `turn ${i}` })).status, 200);
  const tab = { shown: await viewOf(p1) };
  const lateFromOld = await viewOf(p1); // answered by the old process, delivered to the tab only after the restart
  p1.close();

  const p2 = rig({ dir, extra, model: scripted((seen) => say(`two #${seen.input.length}`)) });
  const restarted = await viewOf(p2);
  assert.ok(restarted.epoch > tab.shown.epoch);
  // The new process's state: accepted by the new page rule and by the rule already-open tabs are still running.
  assert.equal(aNewer(tab.shown, restarted), true);
  assert.equal(prePR(tab.shown, restarted), true, "a tab opened before this deploy also resumes, without reload");
  tab.shown = restarted;
  assert.deepEqual(texts(restarted), texts(lateFromOld), "the same conversation, nothing reset");
  // The late answer from the old process never switches the tab back.
  assert.equal(aNewer(tab.shown, lateFromOld), false);
  assert.equal(prePR(tab.shown, lateFromOld), false);

  // Another device sends through the restarted server; the open tab's next poll shows it.
  const other = await p2.api("/assistant/messages", "POST", { text: "from my phone" });
  assert.equal(other.status, 200);
  const polled = await viewOf(p2);
  assert.equal(aNewer(tab.shown, polled), true);
  assert.ok(texts(polled).includes("from my phone"));
  tab.shown = polled;
  p2.close();

  // And again: repeated restarts keep moving forward, and the history is all there.
  let prev = tab.shown;
  for (let i = 0; i < 3; i++) {
    const p = rig({ dir, extra, model: scripted([say(`restart ${i}`)]) });
    assert.equal((await p.api("/assistant/messages", "POST", { text: `after restart ${i}` })).status, 200);
    const v = await viewOf(p);
    assert.equal(aNewer(prev, v), true, `restart ${i}`);
    assert.equal(aNewer(v, prev), false);
    assert.equal(v.session.id, "assistant");
    assert.deepEqual(v.session, restarted.session, "the singleton's identity never changes");
    prev = v;
    p.close();
  }
  assert.ok(texts(prev).includes("from my phone"));
  assert.equal(prev.problems.length, 0);
});

test("send versus poll: a poll answered before a turn finished is older than the send's answer, before and after a restart", async () => {
  const dir = tmp();
  const extra = () => ({ assistantDir: join(dir, "assistant") });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const model = scripted(async (): Promise<Step> => (await gate, say("done")));
  const p1 = rig({ dir, extra, model });
  const sending = p1.api("/assistant/messages", "POST", { text: "slow one" });
  let during = await viewOf(p1);
  for (let i = 0; i < 50 && !during.busy; i++) during = await viewOf(p1);
  assert.equal(during.busy, true);
  release();
  const sent = (await sending).data.assistant;
  // The poll answered while the turn ran arrives after the send's answer: ignored.
  assert.equal(aNewer(sent, during), false);
  assert.equal(aNewer(during, sent), true);
  p1.close();
  const p2 = rig({ dir, extra, model: scripted([say("again")]) });
  const v2 = await viewOf(p2);
  assert.equal(aNewer(sent, v2), true);
  assert.equal(aNewer(v2, sent), false, "the old process's send answer, delivered late, is ignored");
  assert.equal(aNewer(v2, during), false);
  assert.equal(v2.busy, false, "the restarted server is not busy and nothing is re-run");
  assert.deepEqual(texts(v2), ["slow one", "done"]);
  p2.close();
});

test("a turn interrupted by a restart is shown interrupted to an open tab, and is not run again", async () => {
  const dir = tmp();
  const extra = () => ({ assistantDir: join(dir, "assistant") });
  const p1 = rig({ dir, extra, model: scripted(async (): Promise<Step> => new Promise(() => {})) });
  void p1.api("/assistant/messages", "POST", { text: "never finishes" }).catch(() => {});
  let shown = await viewOf(p1);
  for (let i = 0; i < 50 && !shown.busy; i++) shown = await viewOf(p1);
  assert.equal(shown.busy, true);
  p1.close();
  const model = scripted([say("unused")]);
  const p2 = rig({ dir, extra, model });
  const v = await viewOf(p2);
  assert.equal(aNewer(shown, v), true);
  const reply = v.chunks[0].messages[1];
  assert.equal(reply.status, "interrupted");
  assert.equal(model.seen.length, 0, "nothing was retried");
  p2.close();
});

// ---- two real tabs in a browser, across a restart of the real server --------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level restart checks skipped";

// A stable address in front of whichever server process is "running", so a page keeps its URL across a restart. Any answer can be
// held back (`hold`) or sent to a chosen process (`route`), to deliver an old process's answer late.
function frontDoor() {
  const st = {
    target: "",
    route: undefined as undefined | ((method: string, path: string) => string | undefined),
    hold: undefined as undefined | ((method: string, path: string) => Promise<void> | undefined),
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = req.url!;
    const method = req.method!;
    const target = st.route?.(method, path) ?? st.target;
    let r: Response;
    try {
      r = await fetch(`${target}${path}`, { method, headers: { "content-type": "application/json" }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    } catch {
      return req.socket.destroy();
    }
    const body = Buffer.from(await r.arrayBuffer());
    const wait = st.hold?.(method, path);
    if (wait) await wait;
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream" });
    res.end(body);
  });
  return { st, server };
}
const baseOf = async (x: ReturnType<typeof rig>) => {
  await x.api("/assistant");
  return `http://127.0.0.1:${(x.server.address() as AddressInfo).port}`;
};

let browser: any;
before(async () => {
  if (skip) return;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); });

test("browser: two open tabs keep updating across repeated restarts, without reload or sending; old answers never roll them back", { skip }, async () => {
  const dir = tmp();
  const extra = () => ({ assistantDir: join(dir, "assistant") });
  const door = frontDoor();
  await new Promise<void>((r) => door.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(door.server.address() as AddressInfo).port}/`;
  let proc = rig({ dir, extra, model: scripted((seen) => say(`reply ${seen.input.length}`)) });
  door.st.target = await baseOf(proc);
  for (let i = 0; i < 8; i++) await proc.api("/assistant/messages", "POST", { text: `early ${i}` });

  const tabs = [await browser.newPage(), await browser.newPage()];
  for (const t of tabs) {
    await t.goto(url);
    await t.waitForFunction(() => /early 7/.test(document.getElementById("alog")!.textContent!));
  }
  const shownRev = (t: any) => t.evaluate("aview && aview.rev");
  const poll = (t: any) => t.evaluate("aload(true)");
  const has = (t: any, s: string) => t.evaluate((x: string) => document.getElementById("alog")!.textContent!.includes(x), s);
  const before1 = await shownRev(tabs[0]);

  for (let round = 0; round < 3; round++) {
    const old = proc;
    const oldBase = door.st.target;
    proc = rig({ dir, extra, model: scripted((seen) => say(`reply ${seen.input.length}`)) });
    door.st.target = await baseOf(proc);
    // Another device sends through the new process.
    assert.equal((await proc.api("/assistant/messages", "POST", { text: `phone after restart ${round}` })).status, 200);
    for (const t of tabs) {
      await poll(t);
      assert.equal(await has(t, `phone after restart ${round}`), true, `round ${round}: the open tab took the new process's state`);
    }
    // The old process (still draining) answers a later poll of tab 0: an older revision, ignored.
    door.st.route = (m, p) => (m === "GET" && p === "/assistant" ? oldBase : undefined);
    const keep = await shownRev(tabs[0]);
    await poll(tabs[0]);
    assert.equal(await shownRev(tabs[0]), keep, `round ${round}: the old process's answer did not roll the tab back`);
    assert.equal(await has(tabs[0], `phone after restart ${round}`), true);
    door.st.route = undefined;
    old.close();
  }
  assert.ok((await shownRev(tabs[0])) > before1);

  // Send versus poll in tab 1: a poll held back while tab 1 sends is delivered after the send's answer, and is ignored.
  let releasePoll: () => void = () => {};
  const heldPoll = new Promise<void>((r) => (releasePoll = r));
  door.st.hold = (m, p) => (m === "GET" && p === "/assistant" ? heldPoll : undefined);
  const pending = tabs[1].evaluate("aload(true)");
  await new Promise((r) => setTimeout(r, 100));
  door.st.hold = undefined;
  await tabs[1].fill("#ainput", "sent from tab one");
  await tabs[1].press("#ainput", "Enter");
  await tabs[1].waitForFunction(() => /reply \d+/.test([...document.querySelectorAll("#alog .msg")].at(-1)!.textContent!) && !(document.getElementById("asend") as HTMLButtonElement).disabled);
  assert.equal(await has(tabs[1], "sent from tab one"), true);
  releasePoll();
  await pending;
  assert.equal(await has(tabs[1], "sent from tab one"), true, "the older poll did not remove the sent turn");
  // Tab 0 sees tab 1's turn on its next poll.
  await poll(tabs[0]);
  assert.equal(await has(tabs[0], "sent from tab one"), true);

  // A send's answer held back while another device's turn lands and tab 1 polls: the late send answer does not roll it back.
  let releaseSend: () => void = () => {};
  const heldSend = new Promise<void>((r) => (releaseSend = r));
  door.st.hold = (m, p) => (m === "POST" && p === "/assistant/messages" ? heldSend : undefined);
  await tabs[1].fill("#ainput", "slow answer");
  await tabs[1].press("#ainput", "Enter");
  for (let i = 0; i < 50 && !(await proc.api("/assistant")).data.assistant.chunks.some((c: any) => c.messages.some((m: any) => m.text === "slow answer") && c.state === "complete"); i++) await new Promise((r) => setTimeout(r, 20));
  door.st.hold = undefined;
  assert.equal((await proc.api("/assistant/messages", "POST", { text: "phone meanwhile" })).status, 200);
  await poll(tabs[1]);
  assert.equal(await has(tabs[1], "phone meanwhile"), true);
  releaseSend();
  await tabs[1].waitForFunction(() => !(document.getElementById("asend") as HTMLButtonElement).disabled);
  assert.equal(await has(tabs[1], "phone meanwhile"), true, "the late send answer did not roll back the newer poll");
  assert.equal(await has(tabs[1], "slow answer"), true);

  for (const t of tabs) await t.close();
  proc.close();
  door.server.close();
});
