import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The Plan views (docs/plan.md) in Chromium, over the real planOverview and projectDetail on synthetic vault notes read on a
// fixed day (test/helpers/shell-fixture.ts, Thu 2026-11-26 in Los Angeles):
// - the sidebar's Plan section is a compact index: All projects, how many need attention, each open project with a status
//   dot and a priority badge; its links open views in the main area and mark the one that is open;
// - All projects (/#plan) is cards with priority, status, a one-line summary, the next action, progress and relative dates,
//   with quick stats on top and the finished projects folded away;
// - one project (/#plan/<id>) shows status and progress, next steps, blockers, a timeline, recent activity, linked tasks and
//   notes, with no raw UTC timestamps or message ids;
// - the other sidebar sections, the Assistant and the back button keep working; the phone drawer closes on a Plan link.
// Skipped, saying so, without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; Plan browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 3, notes: 3 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

async function open(width: number, height: number, route: string, opts: { phone?: boolean; colorScheme?: string; sidebar?: "ok" | "vault-down" } = {}) {
  fixture.set({ sidebar: opts.sidebar ?? "ok" });
  const ctx = await chromium.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light", ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(url + route);
  await page.waitForFunction(() => document.getElementById("navprojnote")!.textContent !== "Reading the vault…");
  return { page, ctx, errors };
}
const words = (page: any, sel: string) => page.$$eval(sel, (es: HTMLElement[]) => es.map((e) => e.textContent!.replace(/\s+/g, " ").trim()));
// As laid out: one line each (block parts and line breaks become spaces).
const texts = (page: any, sel: string) => page.$$eval(sel, (es: HTMLElement[]) => es.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
const shown = (page: any, sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.getClientRects().length); }, sel);
const sideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const current = (page: any) => page.$$eval("#navplan [aria-current=page]", (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute("href")));
// Text a person reads in the Plan view: nothing an agent wrote for itself.
const AGENTISH = /#orbit\d|\bUTC\b|\d{2}:\d{2}Z|\b\d{4}-\d{2}-\d{2}\b/;

test("browser 1440px: All projects is cards by priority with stats, next actions and relative dates; the sidebar marks it", { skip }, async () => {
  const { page, ctx, errors } = await open(1440, 900, "/#plan");
  await page.waitForSelector("#plan .plcard");
  assert.equal(await shown(page, "#plan"), true);
  assert.equal(await shown(page, "#alog"), false, "the Plan replaces the conversation in the main area");
  assert.equal(await page.title(), "All projects · Plan · ORBIT");
  assert.equal(await page.textContent("#plan h2.pltitle"), "All projects");
  assert.match(await page.textContent("#plan .plsub"), /Today is Thu, Nov 26, 2026\./);
  assert.deepEqual(await texts(page, "#plan .plstats li"), ["2 active projects", "1 overdue", "1 with blockers", "1 paused"]);
  assert.deepEqual(await words(page, "#plan ul[aria-label='Open projects'] .plcard h3"), ["Alpha Garden", "Gamma Roof", "Beta Desk"]);
  assert.deepEqual(await words(page, "#plan ul[aria-label='Open projects'] .pbadge"), ["P1", "P2", "P3"]);
  assert.deepEqual(await words(page, "#plan ul[aria-label='Open projects'] .pstate"), ["Active · on track", "Active · at risk", "Paused · needs attention"]);
  assert.deepEqual(await words(page, "#plan ul[aria-label='Open projects'] .plnext"), ["Next Order the synthetic seeds", "Next Call the roofer", "Next Fix the drawer"]);
  assert.deepEqual(await words(page, "#plan ul[aria-label='Open projects'] .plmeta"), [
    "Last activity 2 days ago · Target Dec 15 (in 3 weeks)",
    "Last activity yesterday · Overdue: target was Nov 1 (4 weeks ago) · 1 blocker",
    "Last activity 8 weeks ago · Status: paused",
  ]);
  assert.deepEqual(await words(page, "#plan ul[aria-label='Open projects'] .plprog > span"), ["1/3 beds done (33%)", "0/1 tasks done (0%)"]);
  assert.equal(await page.getAttribute("#plan .plprog .bar", "aria-valuenow"), "1");
  // The full date is on hover.
  assert.equal(await page.getAttribute("#plan .plmeta span", "title"), "Tue, Nov 24, 2026");
  // Finished projects are folded away.
  assert.equal(await page.textContent("#plan details.pldone summary"), "Finished (1)");
  assert.equal(await page.$eval("#plan details.pldone", (d: HTMLDetailsElement) => d.open), false);
  assert.equal(await page.isVisible("#plan ul[aria-label='Finished projects'] h3"), false);
  await page.click("#plan details.pldone summary");
  assert.deepEqual(await words(page, "#plan ul[aria-label='Finished projects'] .plcard h3"), ["Old Shed"]);
  assert.deepEqual(await words(page, "#plan ul[aria-label='Finished projects'] .plnext"), ["Finished."]);
  assert.doesNotMatch(await page.innerText("#plan"), AGENTISH);
  assert.deepEqual(await current(page), ["/#plan"]);
  assert.equal(await sideways(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1440px: a card opens the project's detail; Back and the browser's back button return; the sidebar follows", { skip }, async () => {
  const { page, ctx, errors } = await open(1440, 1000, "/#plan");
  await page.waitForSelector("#plan .plcard");
  await page.click("#plan .plcard a[data-id='alpha-garden']");
  await page.waitForSelector("#plan .pldetail");
  assert.equal(new URL(page.url()).hash, "#plan/alpha-garden");
  assert.equal(await page.title(), "Alpha Garden · Plan · ORBIT");
  assert.equal(await page.evaluate(() => document.activeElement!.matches("#plan h2.pltitle")), true, "the view's heading takes focus");
  assert.equal(await page.textContent("#plan h2.pltitle"), "Alpha Garden");
  assert.deepEqual(await words(page, "#plan .plsec h3"), ["Status", "Next steps", "Blockers", "Timeline", "Recent activity", "Linked tasks", "Notes"]);
  const sec = (name: string) => `#plan .plsec[aria-label='${name}']`;
  assert.match(await page.textContent(sec("Status")), /1\/3 beds done \(33%\)/);
  assert.match(await page.textContent(sec("Status")), /Last activity 2 days ago/);
  assert.deepEqual(await words(page, `${sec("Next steps")} li`), ["Order the synthetic seeds", "Draw the watering plan", "Buy seeds (due Nov 30)"]);
  assert.equal(await page.textContent(`${sec("Blockers")} .empty`), "No blockers recorded.");
  assert.deepEqual(await texts(page, `${sec("Timeline")} li`), [
    "Started Tue, Sep 1, 2026 · 3 months ago",
    "Beds built ✓ Thu, Oct 1, 2026 · 8 weeks ago",
    "Today Thu, Nov 26, 2026",
    "Buy seeds (task due) Mon, Nov 30, 2026 · in 4 days",
    "First planting Tue, Dec 1, 2026 · in 5 days",
    "Target Tue, Dec 15, 2026 · in 3 weeks",
  ]);
  assert.match(await page.textContent(sec("Timeline")), /Day 86 of 105 \(82% of the time to the target\)/);
  // The log line was written in UTC with a message id: it reads in Rai's time, with the id gone.
  assert.deepEqual(await texts(page, `${sec("Recent activity")} li`), ["2 days ago · Nov 24 Trellis sketch drafted.", "2 weeks ago · Nov 10 Soil delivered."]);
  assert.equal(await page.getAttribute(`${sec("Recent activity")} .actwhen`, "title"), "Nov 24, 2026, 10:30 AM PST");
  assert.deepEqual(await texts(page, `${sec("Linked tasks")} li`), ["Buy seeds todo due Nov 30 (in 4 days)"]);
  assert.deepEqual(await words(page, `${sec("Notes")} li`), ["Ask about the community seed swap."]);
  assert.doesNotMatch(await page.innerText("#plan"), AGENTISH);
  assert.deepEqual(await current(page), ["/#plan/alpha-garden"]);
  // Back to all projects, by the link and by the browser.
  await page.click("#plan a.back");
  await page.waitForSelector("#plan .plcard");
  assert.equal(new URL(page.url()).hash, "#plan");
  await page.goBack();
  await page.waitForSelector("#plan .pldetail");
  assert.equal(await page.textContent("#plan h2.pltitle"), "Alpha Garden");
  // The sidebar opens another project; the overdue one says why it is at risk.
  await page.click("#navplan a[data-id='gamma-roof']");
  await page.waitForFunction(() => document.querySelector("#plan h2.pltitle")?.textContent === "Gamma Roof" && document.querySelector("#plan .pldetail"));
  assert.match(await page.textContent("#plan .pldetail .pstate"), /Active · at risk \(Past its target date \(Nov 1\)\)/);
  assert.deepEqual(await words(page, "#plan .plsec[aria-label='Blockers'] li"), ["Waiting on the roofer's quote"]);
  assert.deepEqual(await current(page), ["/#plan/gamma-roof"]);
  // The other pages and sidebar sections still work.
  await page.click("#assistanttab");
  await page.waitForFunction(() => !document.getElementById("alog")!.hidden);
  assert.equal(await shown(page, "#plan"), false);
  assert.deepEqual(await current(page), [], "nothing marked open while the Plan is not showing");
  assert.equal(await page.$$eval("#navfiles .navfile", (b: unknown[]) => b.length), 4);
  assert.equal(await page.$$eval("#navimages img", (i: unknown[]) => i.length), 3);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1440px: Back before a project's detail arrives keeps All projects; the late answer is dropped", { skip }, async () => {
  const { page, ctx, errors } = await open(1440, 900, "/#plan");
  await page.waitForSelector("#plan .plcard");
  // Hold the project's answer until the view has gone back to All projects.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/sidebar/project?**", async (route: any) => { await held; await route.continue(); });
  await page.click("#plan .plcard a[data-id='alpha-garden']");
  await page.waitForFunction(() => document.querySelector("#plan .empty")?.textContent === "Reading the project…");
  await page.click("#plan a.back");
  await page.waitForFunction(() => location.hash === "#plan" && document.querySelector("#plan .plcard"));
  const answered = page.waitForResponse((r: any) => r.url().includes("/sidebar/project?"));
  release();
  await answered;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  assert.equal(await page.textContent("#plan h2.pltitle"), "All projects");
  assert.equal(await page.$("#plan .pldetail"), null, "the late detail does not replace the overview");
  assert.ok((await page.$$("#plan .plcard")).length > 0);
  assert.equal(await page.title(), "All projects · Plan · ORBIT");
  assert.deepEqual(await current(page), ["/#plan"]);
  // The project still opens once asked again.
  await page.unroute("**/sidebar/project?**");
  await page.click("#plan .plcard a[data-id='alpha-garden']");
  await page.waitForSelector("#plan .pldetail");
  assert.equal(await page.textContent("#plan h2.pltitle"), "Alpha Garden");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1440px: projects named with spaces, commas, brackets, apostrophes and accents open from their card and the sidebar", { skip }, async () => {
  const names = ["Café Rebuild, Q4 (plan)", "Mom's 70th"];
  fixture.set({ planNotes: new Map(names.map((n) => [`Projects/${n}.md`, `---\nstatus: active\npriority: 1\n---\n# ${n}\n\n## Next actions\n- Book the hall\n`])) });
  const { page, ctx, errors } = await open(1440, 900, "/#plan");
  try {
    await page.waitForSelector("#plan .plcard");
    for (const id of names) {
      await page.goto(`${url}/#plan`);
      await page.waitForSelector("#plan .plcard");
      await page.locator("#plan .plcard a").filter({ hasText: id }).first().click();
      await page.waitForSelector("#plan .pldetail");
      assert.equal(await page.textContent("#plan h2.pltitle"), id);
      assert.equal(await page.$("#plan .err"), null, `${id}: no error`);
      assert.deepEqual(await words(page, "#plan .plsec[aria-label='Next steps'] li"), ["Book the hall"]);
      assert.equal(decodeURIComponent(new URL(page.url()).hash), `#plan/${id}`);
      assert.equal(await page.title(), `${id} · Plan · ORBIT`);
    }
    // From the sidebar's Plan index too.
    await page.goto(`${url}/#plan`);
    await page.waitForSelector("#navplan a.planitem");
    await page.locator("#navplan a.planitem").filter({ hasText: names[0]! }).click();
    await page.waitForFunction((t: string) => document.querySelector("#plan h2.pltitle")?.textContent === t && document.querySelector("#plan .pldetail"), names[0]);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    fixture.set({ planNotes: undefined });
  }
});

test("browser 1280px: an unknown project, a bad address and an unreadable vault are said plainly, never blank", { skip }, async () => {
  let { page, ctx } = await open(1280, 800, "/#plan/no-such-project");
  await page.waitForSelector("#plan .err");
  assert.equal(await page.textContent("#plan .err"), "No project “no-such-project” in the vault (Projects/no-such-project.md).");
  await page.goto(`${url}/#plan/..%2Fnow`);
  await page.waitForSelector("#plan .err");
  assert.equal(await page.textContent("#plan .err"), "This address does not name a project.");
  await ctx.close();
  ({ page, ctx } = await open(1280, 800, "/#plan", { sidebar: "vault-down" }));
  await page.waitForSelector("#plan .err");
  assert.equal(await page.textContent("#plan .err"), "The vault could not be read: synthetic outage");
  assert.equal(await page.textContent("#navplan"), "The vault could not be read: synthetic outage");
  await ctx.close();
  fixture.set({ sidebar: "ok" });
});

test("browser (390 phone): the drawer's Plan link opens the project in the main area and the drawer closes; nothing goes sideways; dark theme", { skip }, async () => {
  const { page, ctx, errors } = await open(390, 844, "/#assistant", { phone: true, colorScheme: "dark" });
  await page.click("#navbtn");
  await page.waitForSelector("#navplan a[data-id='alpha-garden']");
  await page.click("#navplan a[data-id='alpha-garden']");
  await page.waitForSelector("#plan .pldetail");
  assert.equal(await shown(page, "#nav"), false, "the drawer closed");
  assert.equal(await page.evaluate(() => document.querySelector("header")!.hasAttribute("inert")), false);
  assert.equal(await page.evaluate(() => document.activeElement!.matches("#plan h2.pltitle")), true);
  assert.equal(await sideways(page), false);
  await page.click("#plan a.back");
  await page.waitForSelector("#plan .plcard");
  assert.equal(await sideways(page), false);
  // The status dots differ from the card in both themes.
  const dot = await page.$eval("#plan .plcard .pdot.green", (d: Element) => getComputedStyle(d).backgroundColor);
  assert.equal(dot, "rgb(95, 211, 138)");
  assert.deepEqual(errors, []);
  await ctx.close();
});
