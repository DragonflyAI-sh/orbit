import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { seededJobs } from "./jobs-page-fixture.ts";
import { rig } from "./threads-fixture.ts";

// The page links (Assistant, Jobs, Sessions) in Chromium against the real server: opening them in a new tab, a fresh tab at
// each address they generate, direct entry, reload, legacy addresses, ordinary in-page navigation with Back/Forward, and a
// cold start with slow API answers and no data. Each check looks at what is drawn (and for uncaught errors), not only the URL.
//
// A Command/Ctrl-click or middle-click opens the link in a background tab, which is hidden while it loads. Headless Chromium
// reports every page as visible, so the background tab is emulated the way test/notifications-real-server.test.ts does it:
// document.visibilityState is overridden before the page's script runs, and flipped (with a visibilitychange event) to show it.
// Skipped, saying so, without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; page link browser tests skipped";

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

// The modifier that opens a link in a new tab on this platform (Chromium follows the platform convention).
const NEW_TAB = process.platform === "darwin" ? "Meta" : "Control";

async function server(opts: { empty?: boolean } = {}) {
  if (opts.empty) {
    const r = rig();
    await r.api("/status");
    return { r, base: `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`, id: "", session: "" };
  }
  const s = await seededJobs({ filler: 3, events: 5 });
  const session = (await s.r.create("Trip planning")).id as string;
  return { r: s.r, base: `http://127.0.0.1:${(s.r.server.address() as AddressInfo).port}`, id: s.id, session };
}

type Watch = { problems: string[]; requests: string[] };
function watch(page: any): Watch {
  const w: Watch = { problems: [], requests: [] };
  page.on("pageerror", (e: Error) => w.problems.push(e.message));
  page.on("dialog", async (d: any) => { w.problems.push(`dialog: ${d.message()}`); await d.dismiss(); });
  page.on("request", (r: any) => { const u = new URL(r.url()); w.requests.push(u.pathname + u.search); });
  return w;
}
// Makes this page (or every page of this context) start hidden, as a background tab does, until `show` is called.
const HIDDEN_UNTIL_SHOWN = () => {
  let vis = "hidden";
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => vis });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => vis === "hidden" });
  (window as any).__show = () => { vis = "visible"; document.dispatchEvent(new Event("visibilitychange")); };
};
const show = (page: any) => page.evaluate(() => (window as any).__show());

// What the page draws, per view.
const view = (page: any) => page.evaluate(() => ({
  tab: document.body.dataset.tab,
  path: location.pathname + location.search + location.hash,
  assistant: document.getElementById("alog")!.hidden ? null : document.getElementById("alog")!.innerText,
  jobs: document.getElementById("jobs")!.hidden ? null : document.getElementById("jobs")!.innerText,
  sessions: document.getElementById("log")!.hidden ? null : document.getElementById("log")!.innerText,
  current: document.querySelector("#tabs a[aria-current=page]")?.getAttribute("data-tab") ?? null,
}));
// Drawn content for each view: the Assistant conversation (or its empty note), the Jobs list or one job, a Sessions page.
const drawn = {
  assistant: () => document.body.dataset.tab === "assistant" && /\S/.test(document.getElementById("alog")!.innerText),
  jobs: () => document.body.dataset.tab === "jobs" && !!document.querySelector("#jobs .jlistview .jstatus") && /\S/.test(document.querySelector("#jobs .jstatus")!.textContent!),
  job: () => document.body.dataset.tab === "jobs" && !!document.querySelector("#jobs .jdetail h2"),
  sessions: () => document.body.dataset.tab === "chat" && !document.getElementById("log")!.hidden && /\S/.test(document.getElementById("tstatus")!.textContent! + document.getElementById("log")!.innerText + document.getElementById("sesstitle")!.textContent!),
};
// Pollers refresh every 10 (Assistant) or 15 (Jobs) seconds; anything drawn well inside that came from the page opening.
const SOON = { timeout: 4000 };

test("browser: the page links from Jobs are real links to the canonical addresses, in Assistant → Jobs → Sessions order", { skip }, async () => {
  const { r, base } = await server();
  const page = await browser.newPage();
  const w = watch(page);
  await page.goto(`${base}/#jobs`);
  await page.waitForFunction(drawn.jobs, null, SOON);
  const links = await page.$$eval("#tabs a", (as: HTMLAnchorElement[]) => as.map((a) => ({ tab: a.dataset.tab, href: a.getAttribute("href"), abs: a.href, hidden: a.hidden })));
  assert.deepEqual(links.map((l: any) => [l.tab, l.href, l.hidden]), [["assistant", "/#assistant", false], ["jobs", "/#jobs", false], ["chat", "/sessions", false]]);
  for (const l of links) assert.equal(new URL(l.abs).origin, base);
  assert.deepEqual(w.problems, []);
  await page.close();
  r.close();
});

for (const [link, want, wantPath] of [["#assistanttab", "assistant", "/#assistant"], ["#jobstab", "jobs", "/#jobs"], ["#sessionstab", "sessions", "/sessions"]] as const) {
  test(`browser: ${NEW_TAB}-click and middle-click on ${want} from Jobs open a new tab that draws ${want}; Jobs stays as it was`, { skip }, async () => {
    const { r, base } = await server();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const w = watch(page);
    await page.goto(`${base}/#jobs`);
    await page.waitForFunction(drawn.jobs, null, SOON);
    for (const how of ["modifier", "middle"] as const) {
      const before = page.url();
      const [tab] = await Promise.all([ctx.waitForEvent("page", SOON), how === "modifier" ? page.click(link, { modifiers: [NEW_TAB] }) : page.click(link, { button: "middle" })]);
      const tw = watch(tab);
      await tab.waitForLoadState("domcontentloaded");
      // Plain /sessions opens the most recent session, whose address then replaces it.
      const opened = new URL(tab.url()).pathname + new URL(tab.url()).hash;
      if (want === "sessions") assert.match(opened, /^\/sessions(\/[0-9a-f-]{36})?$/, how); else assert.equal(opened, wantPath, `${how}: the new tab opens the link's own address`);
      await tab.waitForFunction(drawn[want], null, SOON);
      assert.deepEqual(tw.problems, [], `${how}: no uncaught errors in the new tab`);
      await tab.close();
      assert.equal(page.url(), before, `${how}: the click was left to the browser, not routed in the Jobs tab`);
      assert.equal((await view(page)).tab, "jobs");
    }
    assert.deepEqual(w.problems, []);
    await ctx.close();
    r.close();
  });
}

// The fresh-tab half on its own, so a platform whose modifier click behaves differently cannot hide a blank page: each address a
// page link generates, opened in a tab that loads hidden and is shown later, is drawn by the time it is shown.
for (const [path, want] of [["/#assistant", "assistant"], ["/#jobs", "jobs"], ["/sessions", "sessions"], ["/", "assistant"], ["/#jobs/$ID", "job"]] as const) {
  test(`browser: a background tab at ${path} (as a new-tab click opens it) is drawn before and when it is shown`, { skip }, async () => {
    const { r, base, id } = await server();
    const ctx = await browser.newContext();
    await ctx.addInitScript(HIDDEN_UNTIL_SHOWN);
    const page = await ctx.newPage();
    const w = watch(page);
    await page.goto(base + path.replace("$ID", id));
    await page.waitForFunction(drawn[want], null, SOON);
    await show(page);
    await page.waitForFunction(drawn[want], null, SOON);
    assert.deepEqual(w.problems, []);
    // Hidden or not, it drew once: the Jobs rows were asked for once, the Assistant once.
    if (want === "jobs") assert.equal(w.requests.filter((u) => u.startsWith("/jobs?view=rows")).length, 1, w.requests.join("\n"));
    if (want === "assistant") assert.equal(w.requests.filter((u) => u === "/assistant").length, 1, w.requests.join("\n"));
    await ctx.close();
    r.close();
  });
}

test("browser: a background tab opened from a Jobs link with a real modifier click is drawn when shown", { skip }, async () => {
  const { r, base } = await server();
  const ctx = await browser.newContext();
  await ctx.addInitScript(HIDDEN_UNTIL_SHOWN);
  const page = await ctx.newPage();
  await page.goto(`${base}/#jobs`);
  await show(page);
  await page.waitForFunction(drawn.jobs, null, SOON);
  for (const [link, want] of [["#assistanttab", "assistant"], ["#jobstab", "jobs"]] as const) {
    const [tab] = await Promise.all([ctx.waitForEvent("page", SOON), page.click(link, { modifiers: [NEW_TAB] })]);
    const tw = watch(tab);
    await tab.waitForLoadState("domcontentloaded");
    assert.equal(await tab.evaluate(() => document.visibilityState), "hidden", "the new tab loads hidden, as a background tab does");
    await tab.waitForFunction(drawn[want], null, SOON);
    await show(tab);
    assert.equal((await view(tab)).current, want === "assistant" ? "assistant" : "jobs");
    assert.deepEqual(tw.problems, []);
    await tab.close();
  }
  await ctx.close();
  r.close();
});

test("browser: from a path-based Sessions page, new-tab clicks on Assistant and Jobs open tabs that draw them", { skip }, async () => {
  const { r, base, session } = await server();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const w = watch(page);
  await page.goto(`${base}/sessions/${session}`);
  await page.waitForFunction(drawn.sessions, null, SOON);
  for (const [link, want, path] of [["#assistanttab", "assistant", "/#assistant"], ["#jobstab", "jobs", "/#jobs"]] as const) {
    const [tab] = await Promise.all([ctx.waitForEvent("page", SOON), page.click(link, { modifiers: [NEW_TAB] })]);
    const tw = watch(tab);
    await tab.waitForFunction(drawn[want], null, SOON);
    assert.equal((await view(tab)).path, path);
    assert.deepEqual(tw.problems, []);
    await tab.close();
  }
  assert.equal((await view(page)).path, `/sessions/${session}`);
  assert.deepEqual(w.problems, []);
  await ctx.close();
  r.close();
});

test("browser: direct entry and reload draw each page, including one job and one session", { skip }, async () => {
  const { r, base, id, session } = await server();
  const page = await browser.newPage();
  const w = watch(page);
  // Plain /sessions opens the most recent session (the only one here), and its address replaces /sessions, as before.
  for (const [path, want, at] of [["/", "assistant", "/"], ["/#assistant", "assistant", "/#assistant"], ["/#jobs", "jobs", "/#jobs"], [`/#jobs/${id}`, "job", `/#jobs/${id}`], ["/sessions", "sessions", `/sessions/${session}`], [`/sessions/${session}`, "sessions", `/sessions/${session}`]] as const) {
    await page.goto(base + path);
    await page.waitForFunction(drawn[want], null, SOON);
    await page.waitForFunction((p: string) => location.pathname + location.search + location.hash === p, at, SOON);
    await page.reload();
    await page.waitForFunction(drawn[want], null, SOON);
    await page.waitForFunction((p: string) => location.pathname + location.search + location.hash === p, at, SOON);
    if (path === `/#jobs/${id}`) assert.match((await view(page)).jobs!, new RegExp(id));
    if (path === `/sessions/${session}`) assert.equal(await page.textContent("#sesstitle"), "Trip planning");
  }
  assert.deepEqual(w.problems, []);
  await page.close();
  r.close();
});

test("browser: legacy and non-canonical addresses open the same page at its canonical address, keeping the query", { skip }, async () => {
  const { r, base, id, session } = await server();
  const page = await browser.newPage();
  const w = watch(page);
  const cases: [string, string, keyof typeof drawn][] = [
    ["/#chat", `/sessions/${session}`, "sessions"],
    [`/#chat/${session}`, `/sessions/${session}`, "sessions"],
    [`/#chat/${session.toUpperCase()}`, `/sessions/${session}`, "sessions"],
    ["/sessions#jobs", "/#jobs", "jobs"],
    [`/sessions/${session}#jobs/${id}`, `/#jobs/${id}`, "job"],
    ["/sessions/#assistant", "/#assistant", "assistant"],
    ["/?from=mail#jobs", "/?from=mail#jobs", "jobs"],
    ["/sessions?from=mail#jobs", "/?from=mail#jobs", "jobs"],
    ["/sessions?from=mail#assistant", "/?from=mail#assistant", "assistant"],
    [`/?from=mail#chat/${session}`, `/sessions/${session}?from=mail`, "sessions"],
    ["/chat", `/sessions/${session}`, "sessions"],
    [`/chat/${session}`, `/sessions/${session}`, "sessions"],
  ];
  for (const [from, to, want] of cases) {
    await page.goto(base + from);
    await page.waitForFunction(drawn[want], null, SOON);
    await page.waitForFunction((p: string) => location.pathname + location.search + location.hash === p, to, SOON).catch(() => {});
    assert.equal((await view(page)).path, to, from);
  }
  assert.deepEqual(w.problems, []);
  await page.close();
  r.close();
});

test("browser: an address that names no page falls back as before instead of drawing nothing", { skip }, async () => {
  const { r, base } = await server();
  const page = await browser.newPage();
  const w = watch(page);
  // A fragment that names no page opens the Assistant.
  await page.goto(`${base}/#nowhere`);
  await page.waitForFunction(drawn.assistant, null, SOON);
  // A malformed job id opens the Jobs list.
  await page.goto(`${base}/#jobs/not a job!`);
  await page.waitForFunction(drawn.jobs, null, SOON);
  // An unknown job says so.
  await page.goto(`${base}/#jobs/orbit-209901010000-none`);
  await page.waitForFunction(() => /No job orbit-209901010000-none is stored/.test(document.getElementById("jobs")!.innerText), null, SOON);
  // A Sessions address that names no session says so.
  await page.goto(`${base}/sessions/not-a-session`);
  await page.waitForFunction(() => document.body.dataset.tab === "chat" && /\S/.test(document.getElementById("tstatus")!.textContent!), null, SOON);
  assert.deepEqual(w.problems, []);
  await page.close();
  r.close();
});

test("browser: ordinary clicks switch pages in place, and Back/Forward walk them, each drawn", { skip }, async () => {
  const { r, base, session } = await server();
  const page = await browser.newPage();
  const w = watch(page);
  await page.goto(`${base}/#jobs`);
  await page.waitForFunction(drawn.jobs, null, SOON);
  await page.evaluate(() => { (window as any).__samePage = true; });
  await page.click("#assistanttab");
  await page.waitForFunction(drawn.assistant, null, SOON);
  assert.equal((await view(page)).path, "/#assistant");
  await page.click("#sessionstab");
  await page.waitForFunction(drawn.sessions, null, SOON);
  await page.waitForFunction((p: string) => location.pathname === p, `/sessions/${session}`, SOON);
  await page.click("#jobstab");
  await page.waitForFunction(drawn.jobs, null, SOON);
  assert.equal(await page.evaluate(() => (window as any).__samePage), true, "no page load: the links switched views in place");
  for (const [step, path, want] of [["back", `/sessions/${session}`, "sessions"], ["back", "/#assistant", "assistant"], ["back", "/#jobs", "jobs"], ["forward", "/#assistant", "assistant"], ["forward", `/sessions/${session}`, "sessions"]] as const) {
    await (step === "back" ? page.goBack() : page.goForward());
    await page.waitForFunction(drawn[want], null, SOON);
    assert.equal((await view(page)).path, path, `${step} to ${path}`);
  }
  assert.equal(await page.evaluate(() => (window as any).__samePage), true);
  assert.deepEqual(w.problems, []);
  await page.close();
  r.close();
});

// Slow answers on every bootstrap read, with nothing stored: the page still ends on the page the address names, drawn, with no
// duplicate requests once it settles.
for (const hidden of [false, true]) {
  test(`browser: cold start with slow API answers and no data${hidden ? ", in a background tab" : ""} draws the named page once`, { skip }, async () => {
    const { r, base } = await server({ empty: true });
    const ctx = await browser.newContext();
    if (hidden) await ctx.addInitScript(HIDDEN_UNTIL_SHOWN);
    await ctx.route(/\/(assistant|chat\/proposals|jobs|threads|status|notifications)(\?|$|\/)/, async (route: any) => { await new Promise((ok) => setTimeout(ok, 1200)); await route.continue(); });
    for (const [path, want, text] of [["/#jobs", "jobs", /No jobs yet\./], ["/#assistant", "assistant", /The Assistant conversation is empty/], ["/sessions", "sessions", null]] as const) {
      const page = await ctx.newPage();
      const w = watch(page);
      await page.goto(base + path);
      await page.waitForFunction(drawn[want], null, { timeout: 8000 });
      if (hidden) await show(page);
      const v = await view(page);
      if (text) assert.match(want === "jobs" ? v.jobs! : v.assistant!, text);
      assert.equal(v.path, path);
      await page.waitForTimeout(1500);
      assert.equal((await view(page)).tab, want === "sessions" ? "chat" : want, "it stays on the named page");
      if (want === "jobs") assert.equal(w.requests.filter((u) => u.startsWith("/jobs?view=rows")).length, 1, w.requests.join("\n"));
      assert.deepEqual(w.problems, []);
      await page.close();
    }
    await ctx.close();
    r.close();
  });
}
