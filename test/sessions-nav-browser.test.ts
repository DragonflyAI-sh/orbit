import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { rig, say, scripted } from "./threads-fixture.ts";

// The header's page links and the Sessions page's session control (docs/threads.md, "The session picker"), in a real browser
// (Playwright's Chromium) against the REAL ORBIT server (buildServer, the real thread store and index.html). Only the model
// is a fake. At a desktop width and a narrow phone width it checks: the links read Home, Assistant, Jobs, Sessions in the markup
// and on screen; the Sessions link shows on every page while the session title, chevron and picker show only on Sessions
// (/sessions and /sessions/<id>, legacy #chat addresses after they move there), on first load, after a link, on Back and
// Forward; elsewhere the control takes no room, is out of the tab order and the accessibility tree, and an open picker is
// closed; coming back keeps the session, its title and the draft; a long title never makes the page scroll sideways.
// Screenshots go to ORBIT_SCREENSHOTS when it is set (nothing is written otherwise).
// Skipped, and says so, where Playwright cannot be loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; Sessions navigation browser checks skipped";

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

const LONG = "A very long session title that keeps going past what any header could hold, even a wide desktop one".padEnd(100, ".");
const SIZES = [{ name: "desktop", viewport: { width: 1280, height: 800 }, phone: false }, { name: "phone", viewport: { width: 360, height: 740 }, phone: true }] as const;
const shots = process.env.ORBIT_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page: any, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

async function setup(titles: string[]) {
  const r = rig({ model: scripted(async () => say("ok")) });
  const made = [];
  for (const t of titles) made.push(await r.create(t));
  await r.api("/status");
  return { r, made, base: `http://127.0.0.1:${(r.server.address() as { port: number }).port}` };
}
async function openAt(url: string, size: (typeof SIZES)[number]) {
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: shots ? 2 : 1, ...(size.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(url);
  // Jobs is owner only: its link appears once the owner check answers. Wait for it so the order is the full one.
  await page.waitForFunction(() => !(document.getElementById("jobstab") as HTMLElement).hidden);
  return { ctx, page, errors };
}
const ready = (page: any, id: string) => page.waitForFunction((i: string) => document.body.dataset.tab === "chat" && document.getElementById("sessbtn")?.dataset.session === i && !(window as any).navPending(), id);
const onTab = (page: any, tab: string) => page.waitForFunction((t: string) => document.body.dataset.tab === t, tab);
const addr = (page: any) => page.evaluate(() => location.pathname + location.hash);
const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// The visible page links: their names in DOM order, and their boxes.
const links = (page: any) => page.$$eval("header nav#tabs a:not([hidden])", (as: HTMLAnchorElement[]) => as.map((a) => { const b = a.getBoundingClientRect(); return { name: a.textContent!.trim().split(/\s/)[0], left: b.left, right: b.right, top: b.top, visible: b.width > 0 && getComputedStyle(a).visibility !== "hidden" }; }));
async function assertLinkOrder(page: any, where: string) {
  const ls = await links(page);
  assert.deepEqual(ls.map((l: any) => l.name), ["Home", "Assistant", "Jobs", "Sessions"], `${where}: DOM order`);
  assert.ok(ls.every((l: any) => l.visible), `${where}: every page link is visible`);
  for (let i = 1; i < ls.length; i++) {
    assert.ok(Math.abs(ls[i].top - ls[0].top) < 4, `${where}: the links share one row`);
    assert.ok(ls[i].left >= ls[i - 1].right, `${where}: ${ls[i].name} is to the right of ${ls[i - 1].name}`);
  }
}
// The session control as a reader and a screen reader meet it: shown and sized, and reachable by role.
async function control(page: any) {
  const box = await page.evaluate(() => {
    const w = document.getElementById("sesswrap")!, p = document.getElementById("sesspicker")!;
    const r = w.getBoundingClientRect();
    return { display: getComputedStyle(w).display, width: r.width, height: r.height, pickerDisplay: getComputedStyle(p).display, expanded: document.getElementById("sessbtn")!.getAttribute("aria-expanded") };
  });
  const byRole = await page.getByRole("button", { name: /^Session: / }).count();
  const pickerByRole = await page.getByRole("button", { name: "New session" }).count();
  return { ...box, byRole, pickerByRole, visible: await page.isVisible("#sessbtn") };
}
async function assertNoControl(page: any, where: string) {
  const c = await control(page);
  assert.equal(c.visible, false, `${where}: no session title button`);
  assert.equal(c.display, "none", `${where}: the control is not rendered`);
  assert.equal(c.width, 0, `${where}: no blank space is kept for the title`);
  assert.equal(c.byRole, 0, `${where}: not in the accessibility tree`);
  assert.equal(c.pickerByRole, 0, `${where}: the picker's controls are not in the accessibility tree`);
  assert.equal(c.pickerDisplay, "none", `${where}: the picker is not rendered`);
  assert.equal(c.expanded, "false", `${where}: the picker is closed`);
  assert.equal(await page.isVisible("#sessionstab"), true, `${where}: the Sessions link stays`);
}
async function assertControl(page: any, title: string, where: string) {
  const c = await control(page);
  assert.equal(c.visible, true, `${where}: the session title button shows`);
  assert.equal(c.byRole, 1, `${where}: it is in the accessibility tree`);
  assert.equal(await page.getAttribute("#sessbtn", "title"), title, `${where}: the right title`);
  assert.equal(await page.textContent("#sesstitle"), title, `${where}: the right title text`);
}
// Tab from the first page link through the header; the ids (or tag) of each stop, until the status toggle.
async function tabStops(page: any) {
  await page.focus("#hometab");
  const stops = ["hometab"];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || "");
    stops.push(id);
    if (id === "sidetab-status") break;
  }
  return stops;
}

for (const size of SIZES) {
  test(`browser (${size.name}): page links read Home, Assistant, Jobs, Sessions; the session control shows on Sessions only and leaves no gap elsewhere`, { skip }, async () => {
    const { r, made, base } = await setup(["Alpha", LONG]);
    const { ctx, page, errors } = await openAt(`${base}/sessions/${made[1]!.id}`, size);
    try {
      await ready(page, made[1]!.id);
      await assertLinkOrder(page, "Sessions");
      await assertControl(page, LONG, "Sessions");
      assert.equal(await page.getAttribute("#sessionstab", "aria-current"), "page");
      // The title sits after the links on desktop (one row); on a phone the links take their own row under it.
      const geo = await page.evaluate(() => { const r = (id: string) => document.getElementById(id)!.getBoundingClientRect(); return { sessions: r("sessionstab"), btn: r("sessbtn"), theme: r("themebtn"), header: document.querySelector("header")!.getBoundingClientRect().height }; });
      if (!size.phone) assert.ok(geo.btn.left >= geo.sessions.right, "the title comes after the Sessions link");
      else assert.ok(geo.sessions.top > geo.btn.top, "on a phone the links are on the row under the title");
      assert.ok(geo.btn.right <= geo.theme.left, "the long title never runs under the theme toggle");
      assert.equal(await noSideways(page), true, "no horizontal scroll on Sessions");
      // Keyboard: the links in order, then the session control, the theme toggle, then the side panel (its button, its selected
      // tab, Status by default).
      assert.deepEqual(await tabStops(page), ["hometab", "assistanttab", "jobstab", "sessionstab", "sessbtn", "themebtn", "sidetoggle", "sidetab-status"]);
      await shot(page, `${size.name}-nav-sessions`);
      const sessionsHeader = geo.header;

      for (const [tab, link] of [["home", "#hometab"], ["assistant", "#assistanttab"], ["jobs", "#jobstab"]] as const) {
        await page.click(link);
        await onTab(page, tab);
        await assertLinkOrder(page, tab);
        await assertNoControl(page, tab);
        assert.equal(await page.getAttribute(link, "aria-current"), "page");
        assert.equal(await page.getAttribute("#sessionstab", "aria-current"), null);
        // Keyboard: straight from the links to the theme toggle and the side panel; the session control is not a stop.
        assert.deepEqual(await tabStops(page), ["hometab", "assistanttab", "jobstab", "sessionstab", "themebtn", "sidetoggle", "sidetab-status"], `${tab}: tab order`);
        const h = await page.evaluate(() => document.querySelector("header")!.getBoundingClientRect().height);
        assert.ok(h <= sessionsHeader, `${tab}: the header is no taller than on Sessions (${h} > ${sessionsHeader})`);
        assert.equal(await noSideways(page), true, `${tab}: no horizontal scroll`);
        await shot(page, `${size.name}-nav-${tab}`);
      }
      // Back to Sessions by its link: the same session and title.
      await page.click("#sessionstab");
      await ready(page, made[1]!.id);
      assert.equal(await addr(page), `/sessions/${made[1]!.id}`);
      await assertControl(page, LONG, "Sessions again");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); r.server.close(); }
  });

  test(`browser (${size.name}): Back and Forward gate the control by the page shown; leaving closes the picker and keeps the session, title and draft`, { skip }, async () => {
    const { r, made, base } = await setup(["Alpha", "Beta"]);
    const { ctx, page, errors } = await openAt(`${base}/sessions/${made[0]!.id}`, size);
    try {
      await ready(page, made[0]!.id);
      await page.fill("#input", "half-written draft");
      await page.click("#jobstab");
      await onTab(page, "jobs");
      await assertNoControl(page, "Jobs");
      await page.click("#assistanttab");
      await onTab(page, "assistant");
      await assertNoControl(page, "Assistant");
      // Back (Jobs), Back (Sessions): the control is back with the right title; the draft is still in the box.
      await page.goBack();
      await onTab(page, "jobs");
      await assertNoControl(page, "Back to Jobs");
      await page.goBack();
      await ready(page, made[0]!.id);
      assert.equal(await addr(page), `/sessions/${made[0]!.id}`);
      await assertControl(page, "Alpha", "Back to Sessions");
      assert.equal(await page.inputValue("#input"), "half-written draft");
      // Open the picker, then go Forward to Jobs: it is closed and gone, and focus is not left on a hidden control.
      await page.click("#sessbtn");
      assert.equal(await page.getAttribute("#sessbtn", "aria-expanded"), "true");
      await page.goForward();
      await onTab(page, "jobs");
      await assertNoControl(page, "Forward to Jobs with the picker open");
      assert.equal(await page.evaluate(() => { const a = document.activeElement; return Boolean(a && (document.getElementById("sesswrap")!.contains(a) || document.getElementById("sesspicker")!.contains(a))); }), false, "focus is not on a hidden control");
      // Back to Sessions: the picker stays closed; the same session, title and draft.
      await page.goBack();
      await ready(page, made[0]!.id);
      await assertControl(page, "Alpha", "Back to Sessions after closing");
      assert.equal(await page.getAttribute("#sessbtn", "aria-expanded"), "false");
      assert.equal(await page.isVisible("#sesspicker"), false);
      assert.equal(await page.inputValue("#input"), "half-written draft");
      // Picking another session still works, and Back returns to the first.
      await page.click("#sessbtn");
      await page.click(`#sesslist .sitem[data-id="${made[1]!.id}"]`);
      await ready(page, made[1]!.id);
      await assertControl(page, "Beta", "picked Beta");
      await page.goBack();
      await ready(page, made[0]!.id);
      await assertControl(page, "Alpha", "Back to Alpha");
      assert.equal(await noSideways(page), true);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); r.server.close(); }
  });
}

test("browser: on first load the control shows for /sessions, /sessions/<id> and legacy #chat addresses only", { skip }, async () => {
  const { r, made, base } = await setup(["Alpha"]);
  const id = made[0]!.id;
  try {
    for (const size of SIZES) {
      // Sessions addresses, including legacy ones that move to /sessions and an uppercase id that is canonicalized.
      for (const [from, to] of [[`/sessions/${id}`, `/sessions/${id}`], [`/sessions/${id.toUpperCase()}`, `/sessions/${id}`], [`/#chat/${id}`, `/sessions/${id}`]] as const) {
        const { ctx, page, errors } = await openAt(`${base}${from}`, size);
        await ready(page, id);
        assert.equal(await addr(page), to, `${size.name} ${from}: canonical address`);
        await assertLinkOrder(page, `${size.name} ${from}`);
        await assertControl(page, "Alpha", `${size.name} ${from}`);
        assert.deepEqual(errors, []);
        await ctx.close();
      }
      // Plain /sessions and legacy #chat: Sessions, with the control (the stored selection, or no session open).
      for (const from of ["/sessions", "/#chat"]) {
        const { ctx, page, errors } = await openAt(`${base}${from}`, size);
        await onTab(page, "chat");
        await page.waitForFunction(() => !(document.getElementById("sesswrap") as HTMLElement).hidden && !(window as any).navPending());
        assert.match(await addr(page), /^\/sessions(\/|$)/, `${size.name} ${from}: on a Sessions address`);
        assert.equal(await page.isVisible("#sessbtn"), true, `${size.name} ${from}: the control shows`);
        assert.deepEqual(errors, []);
        await ctx.close();
      }
      // Other pages, including a Jobs or Assistant fragment under /sessions (which moves to /): no control, even once the
      // session list has loaded behind the page.
      for (const [from, tab, to] of [["/", "home", "/"], ["/#home", "home", "/#home"], ["/#assistant", "assistant", "/#assistant"], ["/#jobs", "jobs", "/#jobs"], [`/sessions/${id}#jobs`, "jobs", "/#jobs"], [`/sessions#assistant`, "assistant", "/#assistant"]] as const) {
        const { ctx, page, errors } = await openAt(`${base}${from}`, size);
        await onTab(page, tab);
        await page.waitForFunction(() => !(document.getElementById("sesswrap") as HTMLElement).hidden);
        assert.equal(await addr(page), to, `${size.name} ${from}: canonical address`);
        await assertLinkOrder(page, `${size.name} ${from}`);
        await assertNoControl(page, `${size.name} ${from}`);
        assert.equal(await noSideways(page), true);
        assert.deepEqual(errors, []);
        await ctx.close();
      }
    }
  } finally { r.server.close(); }
});
