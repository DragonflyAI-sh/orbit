import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The side panel's collapse handle and the icon-only header indicators (docs/design-system.md, "Side panel" and "Header"):
// - laptops and desktops (1024px and wider): the side panel has no visible heading and no close button. A handle on its
//   left edge (a real button: aria-expanded, aria-controls, a name that says what it will do, a chevron pointing the way)
//   collapses it, giving the page its width back, and stays at the screen's right edge so the panel can always be opened
//   again on the view last shown. Collapsed, nothing inside the panel can take focus. The panel stays a named region.
// - the header: the notifications toggle shows its bell and count only, and the status indicator its dot only while
//   everything is live; their accessible names and hover text still say what they are and their state, and any level other
//   than all live keeps its words.
// - phones and tablets keep the header panels as before, with no handle.
// Chromium (Playwright) with synthetic content only (test/helpers/shell-fixture.ts). Skipped, saying so, without Playwright.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

test("markup: no close button or visible heading in the side panel; one handle controlling it; no visible Notifications word on the toggle", () => {
  assert.doesNotMatch(html, /id="sideclose"/, "no close button");
  assert.match(html, /<div class="sidehead"><h2 id="sidetitle" class="vh">Notifications<\/h2><div class="sidetabs"/, "the heading names the panel for assistive technology only");
  assert.match(html, /<\/div><\/div><button type="button" id="sidehandle" aria-expanded="false" aria-controls="side" aria-label="Expand the Notifications panel" title="Expand the Notifications panel"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6"\/><\/svg><\/button><div id="sesspicker"/, "the handle sits outside the panel, so it is there when the panel is not");
  const notes = html.match(/<button type="button" id="notesbtn"[\s\S]*?<\/button>/)![0];
  assert.doesNotMatch(notes.replace(/<[^>]+>/g, " "), /Notifications/, "no visible word, only the bell and the count");
  assert.match(notes, /aria-label="Notifications: not read yet" title="Notifications: not read yet\. Show or hide the notifications\."/);
  assert.match(html, /#health\.ok \.label \{ display: none; \}/, "All live hides its words; other levels keep theirs");
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; side panel collapse and header indicator browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 8, card: false, notes: 5 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

const ALL_LIVE = { ports: [{ port: "model", state: "live" }, { port: "vault", state: "live" }, { port: "jobs", state: "live" }], deploy: { at: "2026-11-18T05:00:00Z", commit: "0123456789abcdef0123456789abcdef01234567" } };

async function open(width: number, height: number, opts: { touch?: boolean; phone?: boolean; allLive?: boolean; colorScheme?: string; route?: string } = {}) {
  const ctx = await chromium.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light",
    ...(opts.phone ? { isMobile: true, hasTouch: true } : opts.touch ? { hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  if (opts.allLive) await page.route("**/status", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ALL_LIVE) }));
  await page.goto(url + (opts.route ?? "/#assistant"));
  await page.waitForFunction(() => document.getElementById("alog")!.querySelectorAll(".msg").length > 0 || document.getElementById("log")!.querySelectorAll(".msg").length > 0);
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?" && document.getElementById("health")!.className !== "unknown");
  return { page, ctx, errors };
}
const shown = (page: any, sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden"); }, sel);
const active = (page: any) => page.evaluate(() => document.activeElement?.id || "");
const attrs = (page: any) => page.evaluate(() => { const h = document.getElementById("sidehandle")!; return { expanded: h.getAttribute("aria-expanded"), controls: h.getAttribute("aria-controls"), label: h.getAttribute("aria-label"), title: h.title }; });
const rect = (page: any, sel: string) => page.evaluate((s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; }, sel);
// The chevron points right (towards the edge the panel folds into) when open, and left (the way it comes out) when collapsed.
const chevron = (page: any) => page.evaluate(() => getComputedStyle(document.querySelector("#sidehandle svg")!).transform);
// Everything inside the panel that could take focus, and whether any of it is rendered.
const focusableShownInSide = (page: any) => page.evaluate(() => [...document.querySelectorAll("#side :is(button, a[href], input, select, textarea, [tabindex])")]
  .filter((e) => (e as HTMLElement).getClientRects().length > 0).length);

for (const [width, height] of [[1024, 700], [1280, 800], [1440, 900]] as const) {
  test(`browser ${width}px: the handle collapses the panel, the page takes the width back, and the handle stays to expand it again`, { skip }, async () => {
    const { page, ctx, errors } = await open(width, height);
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    // Collapsed (the default): the handle is at the right edge, says Expand, and points left.
    assert.equal(await shown(page, "#side"), false);
    assert.equal(await shown(page, "#sidehandle"), true);
    assert.deepEqual(await attrs(page), { expanded: "false", controls: "side", label: "Expand the Notifications panel", title: "Expand the Notifications panel" });
    assert.equal(await chevron(page), "none", "the chevron points left, the way the panel comes out");
    let h = await rect(page, "#sidehandle");
    const header = await rect(page, "header");
    assert.ok(Math.abs(h.right - vw) <= 1, `at the right edge (${h.right} of ${vw})`);
    assert.ok(h.top >= header.bottom, "below the header");
    assert.equal(await focusableShownInSide(page), 0, "nothing inside a collapsed panel can take focus");
    const wide = await rect(page, "#aform");
    // Expand with the handle: the panel opens on Notifications and the handle moves to its left edge, saying Collapse.
    await page.click("#sidehandle");
    assert.equal(await shown(page, "#side"), true);
    assert.equal(await active(page), "sidehandle", "focus stays on the handle");
    assert.deepEqual(await attrs(page), { expanded: "true", controls: "side", label: "Collapse the Notifications panel", title: "Collapse the Notifications panel (Esc)" });
    assert.match(await chevron(page), /^matrix\(-1, 0, 0, 1/, "the chevron points right, towards the edge it folds into");
    const side = await rect(page, "#side");
    h = await rect(page, "#sidehandle");
    assert.ok(Math.abs(h.right - side.left) <= 1.5, `the handle sits on the panel's left edge (${h.right} vs ${side.left})`);
    assert.ok(h.top >= side.top, "beside the top of the panel");
    const narrow = await rect(page, "#aform");
    assert.ok(narrow.right <= side.left + 0.5, "the composer is not covered");
    // Switch to Status, collapse: the page takes the panel's width back.
    await page.click("#sidetab-status");
    const release = await page.textContent("#deployinfo");
    assert.equal((await attrs(page)).label, "Collapse the Status panel", "the name follows the view");
    await page.click("#sidehandle");
    assert.equal(await shown(page, "#side"), false);
    assert.equal(await shown(page, "#sidehandle"), true, "still there to open it again");
    assert.equal((await attrs(page)).label, "Expand the Status panel");
    assert.equal(await page.getAttribute("#health", "aria-expanded"), "false");
    const back = await rect(page, "#aform");
    assert.ok(Math.abs(back.right - wide.right) <= 1 && Math.abs(back.left - wide.left) <= 1, "collapsing reclaims the space: the composer is where it was before the panel opened");
    assert.equal(await focusableShownInSide(page), 0);
    // Expand again: it reopens on Status, with its contents.
    await page.click("#sidehandle");
    assert.equal(await shown(page, "#statusline"), true, "reopens on the view last shown");
    assert.equal(await page.textContent("#statuslabel"), await page.textContent("#health .label"), "the status contents are as before");
    assert.equal(await page.textContent("#deployinfo"), release, "the running release is still shown");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test("browser 1280px: the handle works by keyboard (Enter and Space), shows a focus ring, and Tab never reaches a collapsed panel", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  // From the status indicator, Tab skips the collapsed panel and lands on the handle.
  await page.focus("#health");
  await page.keyboard.press("Tab");
  assert.equal(await active(page), "sidehandle");
  const ring = await page.$eval("#sidehandle", (b: HTMLElement) => ({ style: getComputedStyle(b).outlineStyle, width: getComputedStyle(b).outlineWidth }));
  assert.equal(ring.style, "solid", "a visible focus ring");
  assert.equal(ring.width, "2px");
  await page.keyboard.press("Enter");
  assert.equal(await shown(page, "#side"), true, "Enter expands");
  assert.equal(await page.getAttribute("#sidehandle", "aria-expanded"), "true");
  assert.equal(await active(page), "sidehandle");
  await page.keyboard.press("Space");
  assert.equal(await shown(page, "#side"), false, "Space collapses");
  assert.equal(await page.getAttribute("#sidehandle", "aria-expanded"), "false");
  await page.keyboard.press("Space");
  assert.equal(await shown(page, "#side"), true, "Space expands");
  // Open: Tab goes from the toggles into the panel (the selected tab), and on through it to the handle.
  await page.focus("#health");
  await page.keyboard.press("Tab");
  assert.equal(await active(page), "sidetab-notes");
  for (let i = 0; i < 20 && (await page.evaluate(() => document.getElementById("side")!.contains(document.activeElement))); i++) await page.keyboard.press("Tab");
  assert.equal(await active(page), "sidehandle", "after the panel comes its handle");
  // Escape inside the panel still collapses it and puts focus on the toggle of the view that was showing.
  await page.focus("#sidetab-notes");
  await page.keyboard.press("Escape");
  assert.equal(await shown(page, "#side"), false);
  assert.equal(await active(page), "notesbtn");
  assert.equal(await page.getAttribute("#sidehandle", "aria-expanded"), "false");
  await ctx.close();
});

test("browser 1280px: the panel is still a named region without the visible heading, and the state survives a reload", { skip }, async () => {
  const { page, ctx } = await open(1280, 800);
  await page.click("#health");
  assert.equal(await page.getAttribute("#side", "role"), "region");
  assert.equal(await page.getAttribute("#side", "aria-labelledby"), "sidetitle");
  assert.equal(await page.textContent("#sidetitle"), "Status", "the region is named after the view");
  const title = await rect(page, "#sidetitle");
  assert.ok(title.width <= 1 && title.height <= 1, "the heading is not visible");
  await page.click("#sidehandle");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  assert.equal(await shown(page, "#side"), false, "collapsed stays collapsed");
  assert.equal(await page.getAttribute("#sidehandle", "aria-label"), "Expand the Notifications panel", "after a reload the panel opens on its default view");
  await ctx.close();
});

test("browser 1280px with touch: the handle has a 44px tap area and a tap toggles it", { skip }, async () => {
  const { page, ctx } = await open(1280, 800, { touch: true });
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (!coarse) { await ctx.close(); return assert.fail("Chromium with touch did not report a coarse pointer"); }
  const g = await page.evaluate(() => {
    const b = document.getElementById("sidehandle")!, r = b.getBoundingClientRect(), a = getComputedStyle(b, "::after");
    return { w: r.width, h: r.height, after: a.content !== "none" ? -parseFloat(a.left) : 0 };
  });
  assert.ok(g.h >= 44, `44px tall (${g.h})`);
  assert.ok(g.w + g.after >= 44, `a 44px wide hit area (${g.w} + ${g.after})`);
  const h = await rect(page, "#sidehandle");
  const hit = await page.evaluate(([x, y]: number[]) => document.elementFromPoint(x!, y!)?.closest("#sidehandle") !== null, [h.left - 10, h.top + h.height / 2]);
  assert.equal(hit, true, "a tap just left of the visible tab still hits the handle");
  await page.tap("#sidehandle");
  assert.equal(await shown(page, "#side"), true);
  await page.tap("#sidehandle");
  assert.equal(await shown(page, "#side"), false);
  await ctx.close();
});

for (const [name, width, height, phone] of [["phone 390", 390, 844, true], ["phone 360", 360, 740, true], ["tablet 768", 768, 1024, true], ["laptop 900", 900, 800, false]] as const) {
  test(`browser ${name}: no handle; the header panels and toggles are as before; no sideways scroll`, { skip }, async () => {
    const { page, ctx, errors } = await open(width, height, { phone });
    assert.equal(await shown(page, "#sidehandle"), false, "no side panel, so no handle");
    assert.equal(await shown(page, "#sidetitle"), false);
    await page.click("#health");
    assert.equal(await shown(page, "#statusline"), true, "the status line opens in the header");
    await page.click("#notesbtn");
    assert.equal(await shown(page, "#inbox"), true);
    assert.equal(await shown(page, "#statusline"), true, "independent of each other");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    const notes = await rect(page, "#notesbtn"), health = await rect(page, "#health"), vw = await page.evaluate(() => document.documentElement.clientWidth);
    assert.ok(health.right <= vw && notes.right <= health.left + 0.5, "the toggles stay on the right, in order");
    if (phone) assert.ok(notes.height >= 36 && health.height >= 36, "touch-sized toggles");
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

for (const [width, phone] of [[390, true], [1280, false]] as const) {
  test(`browser ${width}px: the notifications toggle shows the bell and count only; its name and hover text say the rest`, { skip }, async () => {
    const { page, ctx } = await open(width, 800, { phone });
    const n = await page.evaluate(() => { const b = document.getElementById("notesbtn")!; return { text: b.innerText.trim(), label: b.getAttribute("aria-label"), title: b.title, icon: !!b.querySelector("svg.ico") && b.querySelector("svg.ico")!.getBoundingClientRect().width > 0 }; });
    assert.equal(n.text, "5", "only the count is visible");
    assert.equal(n.icon, true, "the bell is visible");
    assert.equal(n.label, "Notifications: 5");
    assert.equal(n.title, "Notifications: 5. Show or hide the notifications.");
    await ctx.close();
  });

  test(`browser ${width}px: All live shows the dot only, its words in the name and hover text; other levels keep their words`, { skip }, async () => {
    const live = await open(width, 800, { phone, allLive: true });
    const a = await live.page.evaluate(() => { const b = document.getElementById("health")!, l = b.querySelector(".label") as HTMLElement, d = b.querySelector(".dot")!.getBoundingClientRect();
      return { cls: b.className, shownText: b.innerText.trim(), labelText: l.textContent, label: b.getAttribute("aria-label"), title: b.title, dot: d.width > 0 && d.height > 0, w: b.getBoundingClientRect().width }; });
    assert.equal(a.cls, "ok");
    assert.equal(a.shownText, "", "no visible All live");
    assert.equal(a.labelText, "All live", "the words are kept for the status line and the side panel");
    assert.equal(a.dot, true, "the dot shows");
    assert.match(a.label ?? "", /^Overall status: healthy, all live\. All live\. All 3 status entries are live\.$/);
    assert.match(a.title, /^All 3 status entries are live\. Show or hide the status line\.$/);
    assert.ok(a.w >= (phone ? 44 : 28), `still a usable target (${a.w}px)`);
    await live.ctx.close();
    // The fixture's own status is degraded: its words stay visible wherever the width shows them (wider than 480px).
    const deg = await open(width, 800, { phone });
    const d = await deg.page.evaluate(() => { const b = document.getElementById("health")!; return { cls: b.className, shownText: b.innerText.trim(), label: b.getAttribute("aria-label") }; });
    assert.equal(d.cls, "degraded");
    assert.match(d.label ?? "", /^Overall status: degraded/);
    if (width > 480) assert.match(d.shownText, /^Degraded/, "non-live status is not suppressed");
    else assert.equal(d.shownText, "", "phones show the shape-coded dot only, as before");
    await deg.ctx.close();
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`browser 1280px ${scheme}: the handle is on the card surface with a visible edge in both states`, { skip }, async () => {
    const { page, ctx } = await open(1280, 800, { colorScheme: scheme });
    const look = () => page.evaluate(() => { const s = getComputedStyle(document.getElementById("sidehandle")!); return { bg: s.backgroundColor, border: s.borderTopWidth, color: s.color }; });
    const closed = await look();
    assert.notEqual(closed.bg, "rgba(0, 0, 0, 0)", "a solid surface");
    assert.equal(closed.border, "1px");
    await page.click("#sidehandle");
    await page.mouse.move(10, 400);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(350); // the shared hover transition
    const opened = await look();
    assert.equal(opened.bg, closed.bg, "the same surface open and collapsed");
    await ctx.close();
  });
}
