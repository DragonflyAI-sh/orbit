import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { seededJobs } from "./jobs-page-fixture.ts";

// The Jobs page in Chromium against the real server: a research job whose tool was served but which has not checked in reads "awaiting
// first check-in" with no runner activity (dispatch times are not shown as activity), and an overdue job shows its first-callback alert as
// queued with its delivery state, never as read. Skipped, saying so, without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; Jobs progress browser tests skipped";

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

test("browser: awaiting first check-in and an overdue job's alert are labelled honestly in the list and the detail", { skip }, async () => {
  const s = await seededJobs({ filler: 0, events: 3 });
  const { jobs, notify } = s.r;
  const now = Date.now();
  const add = (id: string, at: number) => {
    jobs.register(id, undefined, { research: { brief: "Research question: does the lane work?\n\nCheck one page." } });
    jobs.setLaunch(id, { routine: "research", at: new Date(at).toISOString(), fireStartedAt: new Date(at).toISOString(), firedAt: new Date(at + 1000).toISOString(), sessionId: "cse_r", sessionUrl: "https://claude.ai/code/cse_r" });
    jobs.toolServed(id, "e".repeat(64));
  };
  add("research-awaiting", now - 60_000);
  add("research-overdue", now - 20 * 60_000);
  const n = notify.send("Job research-overdue is not started (test fixture).");
  jobs.setCallbackAlert("research-overdue", { firstAt: n.createdAt, at: n.createdAt, count: 1, dispatch: "provider-accepted", stage: "tool-served", notificationId: n.id });
  await s.r.api("/status");
  const base = `http://127.0.0.1:${(s.r.server.address() as AddressInfo).port}`;
  const page = await browser.newPage({ viewport: { width: 390, height: 860 } });
  const problems: string[] = [];
  page.on("pageerror", (e: Error) => problems.push(e.message));
  await page.goto(`${base}/#jobs`);
  await page.waitForSelector(".jrow");
  const row = await page.$$eval(".jrow", (rs: HTMLElement[]) => rs.map((r) => r.innerText).find((t) => t.includes("research-awaiting")) ?? "");
  assert.match(row, /health: awaiting first check-in/);
  assert.match(row, /no runner activity yet/);
  assert.doesNotMatch(row, /last activity/, "a dispatch time is never labelled as activity");
  const overdueRow = await page.$$eval(".jrow", (rs: HTMLElement[]) => rs.map((r) => r.innerText).find((t) => t.includes("research-overdue")) ?? "");
  assert.match(overdueRow, /health: first check-in overdue/);

  await page.goto(`${base}/#jobs/research-awaiting`);
  await page.waitForSelector(".jdetail");
  let text = await page.$eval("#jobs", (el: HTMLElement) => el.innerText);
  assert.match(text, /Last runner activity\s+none yet: the times above are ORBIT's dispatch, not runner activity/);
  assert.match(text, /awaiting first check-in\s+Awaiting the runner's first check-in: execution unverified/);
  assert.match(text, /Runner tool sent by the job API: done/);
  assert.match(text, /a tool download does not prove the tool ran/);

  await page.goto(`${base}/#jobs/research-overdue`);
  await page.waitForFunction(() => document.getElementById("jobs")?.innerText.includes("research-overdue") && document.querySelector(".jdetail"));
  text = await page.$eval("#jobs", (el: HTMLElement) => el.innerText);
  assert.match(text, /first check-in overdue\s+First check-in overdue/);
  assert.match(text, /Not-started alert\s+queued/);
  assert.match(text, /Web page: not yet shown in the ORBIT web page\. Discord: not connected/);
  assert.match(text, /not proof that Rai read it/);
  assert.deepEqual(problems, []);
  await page.close();
});
