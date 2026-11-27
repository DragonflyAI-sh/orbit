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

// ---- The Plan section's summary of the project chosen in the Projects selector (docs/plan.md, "Sidebar summary") ----------

// Answers of GET /sidebar for one project, held until released (a slow network), by the project the page asked for.
async function holdSidebar(page: any, project: string) {
  let release!: () => void, asked!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const requested = new Promise<void>((r) => { asked = r; });
  const match = (u: URL) => u.pathname === "/sidebar" && u.searchParams.get("project") === project;
  const handler = async (route: any) => { asked(); await held; await route.continue().catch(() => { /* the page may be gone */ }); };
  await page.route(match, handler);
  return {
    requested,
    release: async () => {
      const answered = page.waitForResponse((r: any) => match(new URL(r.url())));
      release();
      await answered;
      await page.unroute(match, handler);
      await page.waitForTimeout(150);
    },
  };
}
// The Plan index's links as text (textContent, so it reads the same however far layout has got).
const indexText = (page: any) => words(page, "#navplan a");
const summaryOf = (page: any, id: string) => page.waitForSelector(`#navplan .plansum[data-id='${id}']:not(.loading)`);

test("browser 1280px: All projects keeps the priority-sorted index; a chosen project shows its summary, and only a click opens the full plan", { skip }, async () => {
  const { page, ctx, errors } = await open(1280, 900, "/#assistant");
  await page.waitForSelector("#navplan a.planitem");
  const index = await indexText(page);
  assert.deepEqual(index, ["All projects3 open", "Alpha Garden, on trackP1", "Gamma Roof, at riskP2", "Beta Desk, needs attentionP3"], "by priority, as before");
  assert.equal(await page.$("#navplan .plansum"), null);

  await page.selectOption("#navproject", "alpha-garden");
  await summaryOf(page, "alpha-garden");
  assert.equal(await page.$("#navplan a.planitem"), null, "the index gives way to the summary");
  assert.deepEqual(await texts(page, "#navplan .plansum > *"), [
    "Alpha Garden P1",
    "Active · on track · 1/3 beds done",
    "A synthetic vegetable garden that feeds the household through winter.",
    "NEXT", // set in capitals
    "Order the synthetic seeds Draw the watering plan Buy seeds (due Nov 30)",
    "Next date First planting · Dec 1 (in 5 days)",
    "Open tasks 1 (under Next)",
    "Open full plan",
  ]);
  assert.equal(await page.getAttribute("#navplan .plansum .psline[title]", "title"), "Tue, Dec 1, 2026", "the full date on hover");
  assert.equal(await page.getAttribute("#navplan .plansum .pdot", "class"), "pdot green");
  assert.equal(await page.getAttribute("#navplan a.plansumopen", "aria-label"), "Open the full plan for Alpha Garden");
  assert.doesNotMatch(await page.innerText("#navplan"), AGENTISH);
  // Choosing a project does not open the Plan in the main area.
  assert.equal(new URL(page.url()).hash, "#assistant");
  assert.equal(await shown(page, "#plan"), false);
  assert.equal(await shown(page, "#alog"), true);

  // A blocker and an overdue target are said, in red.
  await page.selectOption("#navproject", "gamma-roof");
  await summaryOf(page, "gamma-roof");
  assert.deepEqual(await texts(page, "#navplan .plansum .psline"), ["Blocker Waiting on the roofer's quote", "Overdue target was Nov 1 (4 weeks ago)"]);
  assert.deepEqual(await page.$$eval("#navplan .plansum .psline", (ps: Element[]) => ps.map((p) => p.classList.contains("hot"))), [true, true]);
  assert.match(await page.textContent("#navplan .psstate"), /^Active · at risk$/);

  // "Open full plan" opens the project's detail in the main area, focused, and marks itself.
  await page.selectOption("#navproject", "alpha-garden");
  await summaryOf(page, "alpha-garden");
  await page.click("#navplan a.plansumopen");
  await page.waitForSelector("#plan .pldetail");
  assert.equal(new URL(page.url()).hash, "#plan/alpha-garden");
  assert.equal(await page.textContent("#plan h2.pltitle"), "Alpha Garden");
  assert.equal(await page.evaluate(() => document.activeElement!.matches("#plan h2.pltitle")), true);
  assert.deepEqual(await current(page), ["/#plan/alpha-garden"]);

  // Changing the selector leaves the main area where it is.
  await page.selectOption("#navproject", "gamma-roof");
  await summaryOf(page, "gamma-roof");
  assert.equal(new URL(page.url()).hash, "#plan/alpha-garden");
  assert.equal(await page.textContent("#plan h2.pltitle"), "Alpha Garden");
  assert.deepEqual(await current(page), [], "another project's link is not marked");
  // Back to All projects: the same index, marking the project open in the main area; its links still work.
  await page.selectOption("#navproject", "");
  assert.deepEqual(await indexText(page), index, "drawn at once from the last answer");
  await page.waitForFunction(() => document.getElementById("navfiles")!.textContent!.includes("now.md"));
  assert.deepEqual(await indexText(page), index);
  assert.deepEqual(await current(page), ["/#plan/alpha-garden"]);
  await page.click("#navplan a.planall");
  await page.waitForSelector("#plan .plcard");
  assert.deepEqual(await current(page), ["/#plan"]);
  assert.equal(await sideways(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1280px: a sparse project's summary leaves out what its note does not say", { skip }, async () => {
  fixture.set({ planNotes: new Map([["Projects/zeta-bare.md", "---\nstatus: active\n---\n"], ["Projects/eta-script.md", "---\nstatus: active\npriority: 2\n---\n# <img src=x onerror=\"window.pwned=1\">\n\n## Next actions\n- <b>bold?</b> & <script>window.pwned=1</script>\n"]]) });
  const { page, ctx, errors } = await open(1280, 900, "/#assistant");
  try {
    await page.selectOption("#navproject", "zeta-bare");
    await summaryOf(page, "zeta-bare");
    assert.deepEqual(await texts(page, "#navplan .plansum > *"), ["zeta bare", "Active · needs attention (No recorded activity)", "Open full plan"]);
    for (const sel of [".psgoal", ".pslist", ".psline", ".navsub", ".pbadge"]) assert.equal(await page.$(`#navplan .plansum ${sel}`), null, `${sel}: left out`);
    // Project and task text is shown as text, never as markup.
    await page.selectOption("#navproject", "eta-script");
    await summaryOf(page, "eta-script");
    assert.equal(await page.textContent("#navplan .plansum .ptitle"), "<img src=x onerror=\"window.pwned=1\">");
    assert.equal(await page.$("#navplan img, #navplan script, #navplan b"), null);
    assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    fixture.set({ planNotes: undefined });
  }
});

test("browser 1280px: switching quickly (A→B, A→All projects) or a failed read never shows the wrong project's summary", { skip }, async () => {
  const { page, ctx, errors } = await open(1280, 900, "/#assistant");
  await page.waitForSelector("#navplan a.planitem");
  const index = await indexText(page);
  // A is slow; B is chosen before it answers: A's late answer is dropped.
  let a = await holdSidebar(page, "alpha-garden");
  await page.selectOption("#navproject", "alpha-garden");
  assert.deepEqual(await texts(page, "#navplan .plansum.loading > *"), ["Alpha Garden", "Reading the project…"], "A's name at once, nothing of the index");
  assert.equal(await page.getAttribute("#navplan .plansum.loading", "aria-busy"), "true");
  await page.selectOption("#navproject", "gamma-roof");
  await summaryOf(page, "gamma-roof");
  await a.release();
  await summaryOf(page, "gamma-roof");
  assert.doesNotMatch(await page.innerText("#navplan"), /Alpha|synthetic seeds|First planting/);
  assert.equal(await page.inputValue("#navproject"), "gamma-roof");
  assert.match(await page.textContent("#navfiles"), /Projects\/gamma-roof\.md/);

  // A is slow again; All projects is chosen before it answers: the index at once, and it stays.
  a = await holdSidebar(page, "alpha-garden");
  await page.selectOption("#navproject", "alpha-garden");
  await page.waitForSelector("#navplan .plansum.loading[data-id='alpha-garden']");
  await page.selectOption("#navproject", "");
  assert.deepEqual(await indexText(page), index, "the index, drawn at once");
  await page.waitForFunction(() => document.getElementById("navfiles")!.textContent!.includes("now.md"));
  await a.release();
  assert.deepEqual(await indexText(page), index);
  assert.equal(await page.$("#navplan .plansum"), null);
  assert.equal(await page.inputValue("#navproject"), "");

  // B's read fails: B's name and the failure, not the previous project's summary.
  await page.selectOption("#navproject", "gamma-roof");
  await summaryOf(page, "gamma-roof");
  fixture.set({ sidebar: 500 });
  await page.selectOption("#navproject", "beta-desk");
  await page.waitForFunction(() => document.querySelector("#navplan .plansum .err"));
  assert.deepEqual(await texts(page, "#navplan .plansum > *"), ["Beta Desk", "The sidebar could not be read (HTTP 500)."]);
  assert.doesNotMatch(await page.innerText("#navplan"), /Gamma|roofer/);
  // All projects can still be drawn from the last answer while reads fail.
  await page.selectOption("#navproject", "");
  assert.deepEqual(await indexText(page), index);
  fixture.set({ sidebar: "ok" });
  await page.selectOption("#navproject", "beta-desk");
  await summaryOf(page, "beta-desk");
  assert.deepEqual(await texts(page, "#navplan .plansum .pslist li"), ["Fix the drawer"]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser 1280px: a refresh that answers after the choice moved on is dropped; a refresh of the same choice updates it", { skip }, async () => {
  const ctx = await chromium.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.clock.install();
  fixture.set({ sidebar: "ok" });
  await page.goto(url + "/#assistant");
  await page.waitForSelector("#navplan a.planitem");
  const index = await indexText(page);
  await page.selectOption("#navproject", "alpha-garden");
  await summaryOf(page, "alpha-garden");
  // The minute's refresh for A is slow; All projects is chosen meanwhile.
  const a = await holdSidebar(page, "alpha-garden");
  await page.clock.fastForward(61_000);
  await a.requested;
  await page.selectOption("#navproject", "");
  assert.deepEqual(await indexText(page), index);
  await page.waitForFunction(() => document.getElementById("navfiles")!.textContent!.includes("now.md"));
  await a.release();
  assert.deepEqual(await indexText(page), index, "the late refresh of A does not bring its summary back");
  // A refresh of the same choice redraws it with the newer answer.
  await page.selectOption("#navproject", "gamma-roof");
  await summaryOf(page, "gamma-roof");
  fixture.set({ planNotes: new Map([["Projects/gamma-roof.md", "---\nstatus: active\npriority: 2\ntarget: 2026-11-01\nupdated: 2026-11-25\n---\n# Gamma Roof\n\n## Next steps\n- Sign the roofer's contract\n"]]) });
  try {
    await page.clock.fastForward(61_000);
    await page.waitForFunction(() => document.querySelector("#navplan .plansum .pslist li")?.textContent === "Sign the roofer's contract");
    assert.equal(await page.$("#navplan .plansum .psline.hot >> text=Blocker"), null, "the blocker that was removed is gone");
  } finally {
    fixture.set({ planNotes: undefined });
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser (390 phone): a chosen project's summary fits the drawer; Open full plan closes it and opens the detail; dark theme", { skip }, async () => {
  const { page, ctx, errors } = await open(390, 844, "/#assistant", { phone: true, colorScheme: "dark" });
  await page.click("#navbtn");
  await page.selectOption("#navproject", "alpha-garden");
  await summaryOf(page, "alpha-garden");
  assert.equal(await shown(page, "#nav"), true, "the drawer stays open while choosing");
  const fit = await page.evaluate(() => {
    const nav = document.getElementById("nav")!.getBoundingClientRect(), box = document.querySelector("#navplan .plansum")!.getBoundingClientRect();
    const scroller = document.querySelector("#nav .navscroll")!;
    return { inside: box.left >= nav.left && box.right <= nav.right + 0.5, overflow: scroller.scrollWidth > scroller.clientWidth, height: box.height };
  });
  assert.deepEqual([fit.inside, fit.overflow], [true, false]);
  assert.ok(fit.height < 360, `small: ${fit.height}px`);
  assert.equal(await sideways(page), false);
  const link = await page.$eval("#navplan a.plansumopen", (a: HTMLElement) => a.getBoundingClientRect().height);
  assert.ok(link >= 44, `a tap target: ${link}px`);
  await page.click("#navplan a.plansumopen");
  await page.waitForSelector("#plan .pldetail");
  assert.equal(await shown(page, "#nav"), false, "the drawer closed");
  assert.equal(await page.textContent("#plan h2.pltitle"), "Alpha Garden");
  assert.equal(await sideways(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});
