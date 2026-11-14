import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Step } from "../src/model.ts";
import { rig, say, scripted } from "./threads-fixture.ts";

// Acceptance 2026-11-14 (docs/acceptance-2026-11-14.md, area 5). The chat page in a real browser (Playwright's Chromium) against the
// REAL ORBIT server (buildServer, the real thread store and thread service, the real index.html), not a scripted fake of its routes.
// Only the model and the side-effect boundaries are fakes: the model is scripted and held by a gate, the vault is a temp directory,
// the launcher and routine are fakes from threads-fixture.ts. Nothing here reaches a provider, the vault or a production service.
// Skipped, and says so, where Playwright cannot be loaded (as in CI today).

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; real-server browser acceptance skipped";

// A model whose answer to a message containing HOLD waits until release() is called. Every other message is answered at once.
function gatedModel() {
  let release: () => void = () => {};
  let held = new Promise<void>((r) => (release = r));
  const lastUser = (input: unknown[]): string => {
    for (let i = input.length - 1; i >= 0; i--) {
      const m = input[i] as { role?: string; content?: string };
      if (m.role === "user" && typeof m.content === "string") return m.content;
    }
    return "";
  };
  const model = scripted(async (seen): Promise<Step> => {
    const text = lastUser(seen.input);
    if (text.includes("HOLD")) await held;
    return say(`reply to ${text.slice(text.lastIndexOf("\n") + 1)}`);
  });
  return { model, release: () => release(), reset: () => (held = new Promise<void>((r) => (release = r))) };
}

let browser: any;
before(async () => {
  if (skip) return;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); });

const long = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of a long earlier answer kept for reading.`).join("\n\n");

async function setup() {
  const g = gatedModel();
  const r = rig({ model: g.model });
  const alpha = await r.create("Alpha");
  const beta = await r.create("Beta");
  return { r, g, alpha, beta };
}

async function openPage(base: string, threadId: string) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.addInitScript(`localStorage.setItem("orbit.thread", ${JSON.stringify(threadId)})`);
  await page.goto(base);
  await page.waitForFunction((id: string) => (document.getElementById("threadsel") as HTMLSelectElement)?.value === id, threadId);
  return page;
}

const shown = (page: any) => page.evaluate(() => [...document.querySelectorAll("#log .msg")].map((m) => (m.textContent ?? "").slice(0, 60)));
const stored = async (r: ReturnType<typeof rig>, id: string) => ((await r.api(`/threads/${id}`)).data.thread.messages as { role: string; text: string; status?: string }[]).map((m) => `${m.role}:${m.text}`);
const baseOf = (r: ReturnType<typeof rig>) => r.api("/status").then(() => `http://127.0.0.1:${(r.server.address() as { port: number }).port}/`);

test("real server: a send in flight in Alpha, a switch to Beta, a blocked Enter in Beta, then the reply lands only in Alpha and Beta's later send lands in Beta", { skip }, async () => {
  const { r, g, alpha, beta } = await setup();
  const page = await openPage(await baseOf(r), alpha.id);
  try {
    await page.fill("#input", "alpha HOLD question");
    await page.press("#input", "Enter");
    // The request is in flight on the server (the model is held) and the page shows it as working.
    await page.waitForFunction(() => [...document.querySelectorAll("#log .msg")].some((m) => m.textContent === "Working…"));
    for (let i = 0; i < 50 && !(await r.api(`/threads/${alpha.id}`)).data.thread.busy; i++) await page.waitForTimeout(20);
    assert.equal((await r.api(`/threads/${alpha.id}`)).data.thread.busy, true, "Alpha is busy on the server while the model is held");

    // Switch to Beta while Alpha's request is in flight.
    await page.selectOption("#threadsel", beta.id);
    await page.waitForFunction(() => !document.querySelector("#log")!.textContent!.includes("alpha HOLD question"));
    assert.deepEqual(await shown(page), [], "Beta is empty and shows nothing of Alpha");

    // Enter in Beta while Alpha's send is still in flight: nothing is sent and the text stays in the box.
    await page.fill("#input", "beta question");
    await page.press("#input", "Enter");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#input"), "beta question", "the text stays in the box");
    assert.deepEqual(await stored(r, beta.id), [], "nothing reached Beta");

    // Alpha's reply arrives while Beta is showing: it is stored in Alpha and not drawn into Beta.
    g.release();
    for (let i = 0; i < 100 && (await r.api(`/threads/${alpha.id}`)).data.thread.busy; i++) await page.waitForTimeout(20);
    await page.waitForFunction("!sending");
    await page.waitForTimeout(100);
    assert.deepEqual(await stored(r, alpha.id), ["user:alpha HOLD question", "assistant:reply to alpha HOLD question"]);
    assert.deepEqual(await shown(page), [], "the late Alpha reply is not drawn over Beta");
    assert.equal(await page.evaluate(() => (document.getElementById("threadsel") as HTMLSelectElement).value), beta.id);

    // Now Enter sends the kept text to Beta, the thread on screen.
    await page.press("#input", "Enter");
    await page.waitForFunction(() => document.querySelector("#log")!.textContent!.includes("reply to beta question"));
    assert.deepEqual(await stored(r, beta.id), ["user:beta question", "assistant:reply to beta question"]);
    assert.deepEqual(await stored(r, alpha.id), ["user:alpha HOLD question", "assistant:reply to alpha HOLD question"], "Alpha is unchanged");

    // Back to Alpha: its history, including the reply that arrived while away, is drawn; nothing of Beta.
    await page.selectOption("#threadsel", alpha.id);
    await page.waitForFunction(() => document.querySelector("#log")!.textContent!.includes("reply to alpha HOLD question"));
    const alphaShown = (await shown(page)).join("|");
    assert.ok(!alphaShown.includes("beta question"), alphaShown);

    // A reload restores Alpha and the same history from the server.
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#log")!.textContent!.includes("reply to alpha HOLD question"));
    assert.equal(await page.evaluate(() => (document.getElementById("threadsel") as HTMLSelectElement).value), alpha.id);
    assert.equal((await page.$$("#log .msg")).length, 2, "no duplicated message after reload");
  } finally {
    await page.close();
  }
});

test("real server: a second device's message to a busy thread is refused (409) and the first device's reply is not duplicated", { skip }, async () => {
  const { r, g, alpha } = await setup();
  const page = await openPage(await baseOf(r), alpha.id);
  try {
    await page.fill("#input", "first HOLD");
    await page.press("#input", "Enter");
    for (let i = 0; i < 50 && !(await r.api(`/threads/${alpha.id}`)).data.thread.busy; i++) await page.waitForTimeout(20);
    const second = await r.send(alpha.id, "from another device");
    assert.equal(second.status, 409);
    assert.match(second.data.error, /already in progress/);
    g.release();
    await page.waitForFunction(() => document.querySelector("#log")!.textContent!.includes("reply to first HOLD"));
    assert.deepEqual(await stored(r, alpha.id), ["user:first HOLD", "assistant:reply to first HOLD"]);
    assert.equal((await r.api(`/threads/${alpha.id}`)).data.thread.busy, false, "the thread is free after the reply");
    const third = await r.send(alpha.id, "after release");
    assert.equal(third.status, 200);
  } finally {
    await page.close();
  }
});

test("real server: a selection and scroll position in a long Alpha history survive polls, a reply from another device and a switch away and back", { skip }, async () => {
  const g = gatedModel();
  let n = 0;
  const model = scripted(async (seen): Promise<Step> => (n++ === 0 ? say(`Older answer with a SELECTME phrase.\n\n${long(40)}`) : g.model.step!(seen.input, seen.limits, seen.notes, [])));
  const r = rig({ model });
  const alpha = await r.create("Alpha");
  const beta = await r.create("Beta");
  assert.equal((await r.send(alpha.id, "tell me a long story")).status, 200);
  const page = await openPage(await baseOf(r), alpha.id);
  try {
    await page.waitForFunction(() => document.querySelector("#log")!.textContent!.includes("SELECTME"));
    await page.evaluate(() => { document.getElementById("log")!.scrollTop = 120; });
    await page.evaluate(() => {
      const p = [...document.querySelectorAll("#log .msg p")].find((x) => x.textContent!.includes("SELECTME"))!;
      const t = [...p.childNodes].find((c) => c.nodeType === 3 && c.textContent!.includes("SELECTME"))!;
      const i = t.textContent!.indexOf("SELECTME");
      const range = document.createRange();
      range.setStart(t, i); range.setEnd(t, i + 8);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      (window as any).__t = t;
    });
    const top = await page.evaluate(() => document.getElementById("log")!.scrollTop);
    const check = () => page.evaluate(() => ({ sel: getSelection()!.toString(), same: getSelection()!.rangeCount > 0 && getSelection()!.getRangeAt(0).startContainer === (window as any).__t, top: document.getElementById("log")!.scrollTop }));

    for (let i = 0; i < 3; i++) await page.evaluate("pollThreads()");
    assert.deepEqual(await check(), { sel: "SELECTME", same: true, top }, "unchanged polls keep the selection, its node and the scroll");

    // Another device sends to Alpha through the real server; the next poll appends it without disturbing the reader.
    assert.equal((await r.send(alpha.id, "second device question")).status, 200);
    await page.evaluate("pollThreads()");
    await page.waitForFunction(() => document.querySelector("#log")!.textContent!.includes("reply to second device question"));
    assert.deepEqual(await check(), { sel: "SELECTME", same: true, top }, "an appended reply keeps the selection and the reading position");
    assert.equal((await page.$$("#log .msg")).length, 4);

    // Switching away and back draws the right thread each time (a switch is a new view, so the selection is not expected to survive it).
    await page.selectOption("#threadsel", beta.id);
    await page.waitForFunction(() => !document.querySelector("#log")!.textContent!.includes("SELECTME"));
    await page.selectOption("#threadsel", alpha.id);
    await page.waitForFunction(() => document.querySelector("#log")!.textContent!.includes("SELECTME"));
    assert.equal((await page.$$("#log .msg")).length, 4, "Alpha's four messages, no duplicates, nothing from Beta");
  } finally {
    await page.close();
  }
});
