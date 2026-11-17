import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { rig, say, scripted } from "./threads-fixture.ts";

// The Sessions page's header session control (docs/threads.md, "The session picker") in a real browser (Playwright's
// Chromium) against the REAL ORBIT server (buildServer, the real thread store and index.html). Only the model is a fake.
// It checks, at a desktop width and a narrow phone width: no permanent session toolbar (only the title button), a long title
// cut with an ellipsis and no sideways scroll, the full title as hover text and accessible name, opening and closing the
// picker (click, Escape, a click outside, focus moving out), keyboard use (Down/Up/Home/End, Enter), focus going back to the
// button, New session, picking, Rename, Archive and Restore with Show archived, the empty state, a long list scrolling
// inside the picker, and the header's shadow under its separator line in both colour schemes. Screenshots go to
// ORBIT_SCREENSHOTS when it is set (nothing is written otherwise).
// Skipped, and says so, where Playwright cannot be loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; session picker browser checks skipped";

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

// 100 characters, the longest title ORBIT stores.
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
async function openAt(url: string, size: (typeof SIZES)[number], scheme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ viewport: size.viewport, colorScheme: scheme, deviceScaleFactor: shots ? 2 : 1, ...(size.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(url);
  return { ctx, page, errors };
}
const ready = (page: any, id: string) => page.waitForFunction((i: string) => document.getElementById("sessbtn")?.dataset.session === i && !(window as any).navPending(), id);
const expanded = (page: any) => page.getAttribute("#sessbtn", "aria-expanded");
const pickerShown = (page: any) => page.evaluate(() => !document.getElementById("sesspicker")!.hidden);
const active = (page: any) => page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.id || a.dataset.id || a.tagName; });
const listOrder = (page: any): Promise<string[]> => page.$$eval("#sesslist .sitem", (bs: HTMLElement[]) => bs.map((b) => b.dataset.id!));
const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const size of SIZES) {
  test(`browser (${size.name}): the header shows only the session title and chevron; a long title is cut, fully available, and nothing scrolls sideways`, { skip }, async () => {
    const { r, made, base } = await setup(["Alpha", LONG]);
    const { ctx, page, errors } = await openAt(`${base}/sessions/${made[1]!.id}`, size);
    try {
      await ready(page, made[1]!.id);
      // No permanent toolbar: New, Rename, Archive, Show archived and the list are all inside the closed picker.
      for (const id of ["tnew", "trename", "tarchive", "tshowarch", "sesslist"]) assert.equal(await page.isVisible(`#${id}`), false, `${id} is not always visible`);
      assert.equal(await page.locator("header select").count(), 0, "no <select> menu in the header");
      assert.equal(await page.isVisible("#sessbtn"), true);
      assert.equal(await expanded(page), "false");
      assert.equal(await page.getAttribute("#sessbtn", "aria-controls"), "sesspicker");
      // The title is cut with an ellipsis inside the header bar; the full title is the hover text and the accessible name.
      const box = await page.evaluate(() => {
        const t = document.getElementById("sesstitle")!, b = document.getElementById("sessbtn")!.getBoundingClientRect(), bar = document.querySelector("header .bar")!.getBoundingClientRect();
        const h = document.getElementById("health")!.getBoundingClientRect(), n = document.getElementById("notesbtn")!.getBoundingClientRect();
        return { cut: t.scrollWidth > t.clientWidth, ellipsis: getComputedStyle(t).textOverflow, btn: { left: b.left, right: b.right, top: b.top, h: b.height }, bar: { left: bar.left, right: bar.right }, notesLeft: n.left, healthTop: h.top, header: document.querySelector("header")!.getBoundingClientRect().height };
      });
      assert.equal(box.cut, true, "the long title is cut");
      assert.equal(box.ellipsis, "ellipsis");
      assert.ok(box.btn.right <= box.notesLeft, `the title never runs under the notifications toggle (${box.btn.right} > ${box.notesLeft})`);
      assert.ok(box.btn.left >= box.bar.left, "the title stays in the bar");
      assert.ok(Math.abs(box.btn.top - box.healthTop) < 12, "on the same row as the toggles");
      assert.ok(box.btn.h >= (size.phone ? 40 : 32), `the title button is a usable target (${box.btn.h}px)`);
      // Header height: the session control adds no row. One row on desktop; the logo row plus the page links on a phone.
      assert.ok(box.header <= (size.phone ? 100 : 56), `the header stays compact (${box.header}px)`);
      assert.equal(await page.getAttribute("#sessbtn", "title"), LONG);
      assert.match(await page.getAttribute("#sessbtn", "aria-label"), new RegExp(`^Session: ${LONG}\\. Show sessions$`));
      assert.equal(await page.title(), `${LONG} · Sessions · ORBIT`);
      assert.equal(await noSideways(page), true, "no horizontal scroll");
      await shot(page, `${size.name}-closed-long-title`);
      // The Assistant shows no session control at all.
      await page.click("#assistanttab");
      await page.waitForFunction(() => document.body.dataset.tab === "assistant");
      assert.equal(await page.isVisible("#sessbtn"), false);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); r.server.close(); }
  });

  test(`browser (${size.name}): the picker opens and closes by click, Escape, a click outside and focus leaving; keyboard moves through it and picks`, { skip }, async () => {
    const { r, made, base } = await setup(["Alpha", "Beta", "Gamma"]);
    const { ctx, page, errors } = await openAt(`${base}/sessions/${made[0]!.id}`, size);
    try {
      await ready(page, made[0]!.id);
      // Click opens it under the header, focus goes to the open session in the list, which is marked current.
      await page.click("#sessbtn");
      assert.equal(await expanded(page), "true");
      assert.equal(await pickerShown(page), true);
      assert.equal(await active(page), made[0]!.id);
      assert.equal(await page.getAttribute(`#sesslist .sitem[data-id="${made[0]!.id}"]`, "aria-current"), "true");
      const geo = await page.evaluate(() => { const p = document.getElementById("sesspicker")!.getBoundingClientRect(); return { left: p.left, right: p.right, top: p.top, bottom: p.bottom, vw: document.documentElement.clientWidth, vh: window.innerHeight, header: document.querySelector("header")!.getBoundingClientRect().bottom, btn: document.getElementById("sessbtn")!.getBoundingClientRect().bottom }; });
      assert.ok(geo.left >= 0 && geo.right <= geo.vw, `the picker fits the width (${geo.left}–${geo.right} of ${geo.vw})`);
      assert.ok(geo.top >= geo.btn && geo.bottom <= geo.vh, "below the button, within the viewport");
      assert.equal(await noSideways(page), true);
      // Each list entry is a usable target; the focused one shows a visible focus ring.
      const item = await page.evaluate((id: string) => { const b = document.querySelector(`#sesslist .sitem[data-id="${id}"]`)!; const cs = getComputedStyle(b); return { h: b.getBoundingClientRect().height, ring: cs.outlineStyle, ringW: parseFloat(cs.outlineWidth) }; }, made[0]!.id);
      assert.ok(item.h >= (size.phone ? 44 : 40), `list entries are at least ${size.phone ? 44 : 40}px tall (${item.h})`);
      await shot(page, `${size.name}-picker-open`);
      // Escape closes it and puts focus back on the button.
      await page.keyboard.press("Escape");
      assert.equal(await expanded(page), "false");
      assert.equal(await pickerShown(page), false);
      assert.equal(await active(page), "sessbtn");
      // Keyboard: Enter on the button opens it; Down/Up/End/Home move (in the list's order); Enter picks; focus returns to the button.
      await page.keyboard.press("Enter");
      assert.equal(await expanded(page), "true");
      const order = await listOrder(page);
      assert.equal(order.length, 3);
      await page.keyboard.press("End");
      assert.equal(await active(page), order[2]);
      await page.keyboard.press("Home");
      assert.equal(await active(page), order[0]);
      await page.keyboard.press("ArrowDown");
      assert.equal(await active(page), order[1]);
      await page.keyboard.press("ArrowUp");
      assert.equal(await active(page), order[0]);
      await page.keyboard.press("ArrowUp");
      assert.equal(await active(page), order[0], "Up stops at the top");
      const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement!); return { style: cs.outlineStyle, w: parseFloat(cs.outlineWidth) }; });
      assert.equal(ring.style, "solid", "a visible focus ring on the focused entry");
      assert.ok(ring.w >= 2);
      const target = order.find((id) => id !== made[0]!.id)!;
      await page.focus(`#sesslist .sitem[data-id="${target}"]`);
      await page.keyboard.press("Enter");
      await ready(page, target);
      assert.equal(await expanded(page), "false");
      assert.equal(await active(page), "sessbtn");
      assert.equal(await page.evaluate(() => location.pathname), `/sessions/${target}`);
      assert.equal(await page.textContent("#sesstitle"), ["Alpha", "Beta", "Gamma"][made.findIndex((m) => m.id === target)]);
      // ArrowDown on the closed button opens it too.
      await page.keyboard.press("ArrowDown");
      assert.equal(await expanded(page), "true");
      // A click (tap) outside closes it without taking focus anywhere odd and without doing anything else.
      const before = await page.evaluate(() => location.href);
      await page.mouse.click(Math.round(size.viewport.width / 2), size.viewport.height - 200);
      assert.equal(await expanded(page), "false");
      assert.equal(await page.evaluate(() => location.href), before);
      // Focus moving out of it (Tab past its last control) closes it.
      await page.click("#sessbtn");
      await page.focus("#tarchive");
      await page.keyboard.press("Tab");
      assert.equal(await expanded(page), "false");
      // The button toggles it closed again.
      await page.click("#sessbtn");
      await page.click("#sessbtn");
      assert.equal(await expanded(page), "false");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); r.server.close(); }
  });

  test(`browser (${size.name}): New session, picking, Rename, Archive and Restore (with Show archived) all work from the picker`, { skip }, async () => {
    const { r, made, base } = await setup(["Alpha", "Beta"]);
    const { ctx, page, errors } = await openAt(`${base}/sessions/${made[0]!.id}`, size);
    const [alpha, beta] = made as [{ id: string }, { id: string }];
    try {
      await ready(page, alpha.id);
      // New session: the picker closes, a session is created and opened, its address pushed, focus in the message box.
      await page.click("#sessbtn");
      await page.click("#tnew");
      await page.waitForFunction((a: string) => { const s = document.getElementById("sessbtn")!.dataset.session; return s && s !== a && !(window as any).navPending(); }, alpha.id);
      const fresh = await page.evaluate(() => document.getElementById("sessbtn")!.dataset.session!);
      assert.equal(await page.evaluate(() => location.pathname), `/sessions/${fresh}`);
      assert.equal(await expanded(page), "false");
      assert.equal(await active(page), "input");
      assert.ok((await r.api("/threads")).data.threads.some((t: { id: string }) => t.id === fresh));
      // Picking Beta.
      await page.click("#sessbtn");
      await page.click(`#sesslist .sitem[data-id="${beta.id}"]`);
      await ready(page, beta.id);
      // Rename (a prompt): the header, the list and the server all get the new title; the picker stays open on Rename.
      page.once("dialog", (d: any) => { assert.equal(d.message(), "Rename session"); d.accept("Beta renamed"); });
      await page.click("#sessbtn");
      await page.click("#trename");
      await page.waitForFunction(() => document.getElementById("sesstitle")!.textContent === "Beta renamed");
      assert.equal((await r.api(`/threads/${beta.id}`)).data.thread.title, "Beta renamed");
      assert.match(await page.textContent(`#sesslist .sitem[data-id="${beta.id}"]`), /^Beta renamed/);
      assert.equal(await page.evaluate(() => document.title), "Beta renamed · Sessions · ORBIT");
      // Archive: the session is archived on the server (same semantics as before) and the next open session opens.
      await page.click("#tarchive").catch(async () => { await page.click("#sessbtn"); await page.click("#tarchive"); });
      await page.waitForFunction((b: string) => { const s = document.getElementById("sessbtn")!.dataset.session; return s && s !== b && !(window as any).navPending(); }, beta.id);
      assert.equal((await r.api(`/threads/${beta.id}`)).data.thread.archived, true);
      assert.equal(await active(page), "sessbtn", "focus goes back to the session button");
      // Archived sessions are listed only with Show archived; picking one shows Restore, and no message can be sent.
      await page.click("#sessbtn");
      assert.equal(await page.locator(`#sesslist .sitem[data-id="${beta.id}"]`).count(), 0);
      await page.check("#tshowarch");
      assert.match(await page.textContent(`#sesslist .sitem[data-id="${beta.id}"]`), /\(archived\)/);
      await page.click(`#sesslist .sitem[data-id="${beta.id}"]`);
      await ready(page, beta.id);
      assert.match(await page.getAttribute("#sessbtn", "aria-label"), /\(archived\)/);
      assert.equal(await page.isDisabled("#input"), true, "an archived session takes no messages");
      await page.click("#sessbtn");
      assert.equal(await page.textContent("#tarchive"), "Restore");
      await page.click("#tarchive");
      await page.waitForFunction(() => !(window as any).navPending() && document.getElementById("tarchive")!.textContent === "Archive");
      assert.equal((await r.api(`/threads/${beta.id}`)).data.thread.archived, false);
      assert.equal(await page.isDisabled("#input"), false);
      assert.equal(await noSideways(page), true);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); r.server.close(); }
  });
}

test("browser: with no sessions the header says so and the picker offers New session; a long list scrolls inside the picker", { skip }, async () => {
  const empty = await setup([]);
  let { ctx, page } = await openAt(`${empty.base}/sessions`, SIZES[1]);
  try {
    await page.waitForFunction(() => document.getElementById("sesstitle")!.textContent === "No sessions yet");
    assert.equal(await page.evaluate(() => location.pathname), "/sessions");
    await page.click("#sessbtn");
    assert.match(await page.textContent("#sesslist"), /No sessions yet/);
    assert.equal(await active(page), "tnew", "focus goes to New session when there is nothing to pick");
    assert.equal(await page.isDisabled("#trename"), true);
    assert.equal(await page.isDisabled("#tarchive"), true);
    await shot(page, "phone-picker-empty");
  } finally { await ctx.close(); empty.r.server.close(); }
  const titles = Array.from({ length: 40 }, (_, i) => `Session number ${i + 1}`);
  const many = await setup(titles);
  ({ ctx, page } = await openAt(`${many.base}/sessions/${many.made[0]!.id}`, SIZES[1]));
  try {
    await ready(page, many.made[0]!.id);
    await page.click("#sessbtn");
    const g = await page.evaluate(() => { const l = document.getElementById("sesslist")!, p = document.getElementById("sesspicker")!.getBoundingClientRect(); return { scrolls: l.scrollHeight > l.clientHeight, bottom: p.bottom, vh: window.innerHeight }; });
    assert.equal(g.scrolls, true, "the list scrolls inside the picker");
    assert.ok(g.bottom <= g.vh, "the picker stays within the viewport");
    // The current session is scrolled into view when it is far down the list.
    await page.keyboard.press("Escape");
    await page.click("#sessbtn");
    const last = (await listOrder(page)).at(-1)!;
    await page.keyboard.press("End");
    assert.equal(await active(page), last);
    await page.keyboard.press("Enter");
    await ready(page, last);
    await page.click("#sessbtn");
    const seen = await page.evaluate((id: string) => { const b = document.querySelector(`#sesslist .sitem[data-id="${id}"]`)!.getBoundingClientRect(), l = document.getElementById("sesslist")!.getBoundingClientRect(); return b.top >= l.top - 1 && b.bottom <= l.bottom + 1; }, last);
    assert.equal(seen, true, "the open session is in view when the picker opens");
    await shot(page, "phone-picker-long-list");
  } finally { await ctx.close(); many.r.server.close(); }
});

test("browser: the header has a clear shadow under its separator in both colour schemes, without moving the layout or clipping the picker", { skip }, async () => {
  const { r, made, base } = await setup(["Alpha"]);
  try {
    for (const scheme of ["light", "dark"] as const) {
      for (const size of SIZES) {
        const { ctx, page } = await openAt(`${base}/sessions/${made[0]!.id}`, size, scheme);
        await ready(page, made[0]!.id);
        const h = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector("header")!); return { shadow: cs.boxShadow, border: cs.borderBottomStyle, position: cs.position, z: cs.zIndex }; });
        const m = /rgba\(\d+, \d+, \d+, (0?\.\d+)\) 0px 4px 14px -4px/.exec(h.shadow);
        assert.ok(m, `${scheme}/${size.name}: a clear downward shadow (${h.shadow})`);
        assert.ok(Number(m[1]) >= 0.2, `${scheme}/${size.name}: strong enough to see (${h.shadow})`);
        assert.equal(h.border, "solid", "the separator line stays");
        assert.equal(h.position, "relative");
        assert.equal(h.z, "10", "the header (and its shadow) paints above the positioned message rows");
        // The picker and focus rings are not clipped by the header.
        await page.click("#sessbtn");
        const vis = await page.evaluate(() => { const p = document.getElementById("sesspicker")!.getBoundingClientRect(); const at = document.elementFromPoint(p.left + p.width / 2, p.bottom - 10); return Boolean(at && document.getElementById("sesspicker")!.contains(at)); });
        assert.equal(vis, true, `${scheme}/${size.name}: the picker is on top, all the way down`);
        await page.keyboard.press("Escape");
        await shot(page, `${size.name}-${scheme}-header`);
        await ctx.close();
      }
    }
  } finally { r.server.close(); }
});
