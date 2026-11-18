import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fakeSecret, seededJobs } from "./jobs-page-fixture.ts";

// The Jobs page in Chromium against the real server (docs/jobs-page.md): phone and desktop layout, keyboard access, deep links,
// untrusted text, and a refresh that never resets what Rai opened, expanded, typed or scrolled. Skipped, saying so, without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; Jobs page browser tests skipped";

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

async function open(width: number, path: string, opts: { clock?: boolean; filler?: number } = {}) {
  const s = await seededJobs({ filler: opts.filler ?? 60, events: 120 });
  await s.r.api("/status");
  const base = `http://127.0.0.1:${(s.r.server.address() as AddressInfo).port}`;
  const page = await browser.newPage({ viewport: { width, height: 860 } });
  const problems: string[] = [];
  page.on("pageerror", (e: Error) => problems.push(e.message));
  page.on("dialog", async (d: any) => { problems.push(`dialog: ${d.message()}`); await d.dismiss(); });
  if (opts.clock) await page.clock.install();
  await page.goto(`${base}${path.replace("$ID", s.id).replace("$LEGACY", s.legacy).replace("$DONE", s.done)}`);
  return { s, page, problems, base };
}
const noPageScroll = (page: any) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth <= window.innerWidth, jobs: document.getElementById("jobs")!.scrollWidth <= document.getElementById("jobs")!.clientWidth }));

for (const width of [390, 1280]) {
  test(`browser ${width}px: the list shows title, id, lane, state and health apart, pages, and filters without a page reload`, { skip }, async () => {
    const { s, page, problems } = await open(width, "/#jobs");
    await page.waitForSelector(".jrow");
    assert.deepEqual(await noPageScroll(page), { doc: true, jobs: true }, "nothing wider than the screen");
    const first = await page.$eval(".jrow", (r: HTMLElement) => r.innerText);
    assert.match(first, /state: /);
    assert.match(first, /health: /);
    assert.match(await page.$eval("#jobs .jstatus", (n: HTMLElement) => n.textContent), /Showing 1–50 of 6\d, newest first/);
    await page.click("text=Older →");
    await page.waitForFunction(() => /Showing 51–/.test(document.querySelector("#jobs .jstatus")!.textContent!));
    await page.click("text=← Newer");
    await page.waitForFunction(() => /Showing 1–/.test(document.querySelector("#jobs .jstatus")!.textContent!));
    await page.fill("#jobsearch", s.done);
    // The work job and its review job (whose title and record name it) match; nothing else does.
    await page.waitForFunction((id: string) => { const rows = [...document.querySelectorAll(".jrow")]; return rows.length === 2 && rows.every((r) => (r as HTMLElement).innerText.includes(id)); }, s.done);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "jobsearch", "typing keeps focus while the list updates");
    await page.fill("#jobsearch", "");
    await page.selectOption("#jobf-state", "done");
    await page.waitForFunction(() => [...document.querySelectorAll(".jrow .badge.state")].every((b) => b.textContent === "state: done") && document.querySelectorAll(".jrow").length > 0);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`browser ${width}px: a job's detail has the five sections, recorded and derived links, the inputs sent, and no unsafe link`, { skip }, async () => {
    const { s, page, problems } = await open(width, "/#jobs/$ID");
    await page.waitForSelector(".jdetail .lrow");
    assert.deepEqual(await page.$$eval(".jdetail > h2, .jdetail details.jsec > summary h2", (hs: HTMLElement[]) => hs.map((h) => h.textContent)), ["Overview", "Steer", "Links & artifacts", "Inputs sent to Claude", "Activity", "Results & review"]);
    assert.deepEqual(await noPageScroll(page), { doc: true, jobs: true });
    const text = await page.$eval("#jobs", (n: HTMLElement) => n.innerText);
    assert.match(text, /Routine fire text/);
    assert.match(text, /\[redacted: one-job runner token\]/);
    assert.ok(!text.includes(fakeSecret()), "a redacted value never reaches the page");
    assert.match(text, /<script>alert\(0\)<\/script>/, "markup in a brief shows as text");
    assert.equal(await page.$$eval("#jobs script, #jobs b", (n: Element[]) => n.length), 0, "and is never parsed");
    assert.match(text, /queued, not yet received by the runner/);
    assert.match(text, /answered by the runner/);
    assert.match(await page.title(), new RegExp(s.id));
    const hrefs: string[] = await page.$$eval("#jobs a[href]", (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute("href")!));
    for (const h of hrefs) assert.match(h, /^(https:\/\/(github\.com|claude\.ai)\/|https:\/\/orbit\.example$|\/#jobs|\/sessions\/|\/#assistant)/, h);
    assert.deepEqual(problems, []);
    await page.close();
  });
}

test("browser: a legacy job says what was not retained, and its unsafe recorded URLs are not links", { skip }, async () => {
  const { page, problems } = await open(1280, "/#jobs/$LEGACY");
  await page.waitForSelector(".jdetail .lrow");
  const text = await page.$eval("#jobs", (n: HTMLElement) => n.innerText);
  assert.match(text, /Not retained on this job: it was launched before ORBIT kept a dispatch snapshot/);
  assert.match(text, /source not recorded \(older steer\)/);
  assert.match(text, /does not have the expected claude\.ai shape/);
  assert.equal(await page.$$eval('#jobs a[href^="javascript"], #jobs a[href*="evil.example"]', (a: Element[]) => a.length), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test("browser: keyboard only, a job opens from the list, a section folds, and Back returns to the same list", { skip }, async () => {
  const { s, page, problems } = await open(1280, "/#jobs");
  await page.waitForSelector(".jrow");
  await page.focus(`.jrow a.jtitle[href="/#jobs/${s.done}"]`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".jdetail .lrow");
  assert.equal(await page.evaluate(() => location.hash), `#jobs/${s.done}`);
  await page.focus('details[data-sec="links"] > summary');
  await page.keyboard.press("Enter");
  assert.equal(await page.$eval('details[data-sec="links"]', (d: HTMLDetailsElement) => d.open), false);
  await page.goBack();
  await page.waitForSelector(".jrow");
  assert.equal(await page.evaluate(() => location.hash), "#jobs");
  assert.deepEqual(problems, []);
  await page.close();
});

test("browser: a refresh with new events keeps folded sections, expanded text, the steer draft, loaded history and the scroll position", { skip }, async () => {
  const { s, page, problems } = await open(1280, "/#jobs/$ID", { clock: true });
  await page.waitForSelector(".jdetail .lrow");
  await page.click('details[data-sec="links"] > summary');
  await page.click('.lt:has(.ltlabel:text-is("Brief")) button:has-text("Expand full text")');
  await page.fill("textarea.steer", "half-written steer");
  await page.click("text=/Load older events/");
  await page.waitForFunction(() => document.querySelectorAll(".ev").length > 50);
  const loaded = await page.$$eval(".ev", (e: Element[]) => e.length);
  await page.evaluate(() => document.querySelector('details[data-sec="activity"]')!.scrollIntoView());
  const scrolled = await page.$eval("#jobs", (n: HTMLElement) => n.scrollTop);
  assert.ok(scrolled > 0);
  s.r.jobs.record(s.id, { type: "checkin", text: "A new check-in arrives during the refresh." });
  await page.clock.runFor(16_000);
  await page.waitForFunction(() => document.body.innerText.includes("A new check-in arrives during the refresh."));
  assert.equal(await page.$eval('details[data-sec="links"]', (d: HTMLDetailsElement) => d.open), false, "a folded section stays folded");
  assert.equal(await page.$eval('.lt:has(.ltlabel:text-is("Brief")) pre', (p: HTMLElement) => p.classList.contains("folded")), false, "expanded text stays expanded");
  assert.equal(await page.$eval("textarea.steer", (t: HTMLTextAreaElement) => t.value), "half-written steer");
  assert.equal(await page.$$eval(".ev", (e: Element[]) => e.length), loaded + 1, "older events stay loaded and the new one is added");
  assert.ok(Math.abs((await page.$eval("#jobs", (n: HTMLElement) => n.scrollTop)) - scrolled) < 120, "the reader keeps their place");
  assert.deepEqual(problems, []);
  await page.close();
});
