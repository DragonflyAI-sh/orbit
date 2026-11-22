import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The desktop design pass (docs/design-system.md): the laptop header (grouped, page tabs as navigation, labelled toggles,
// panels hung under their toggles), the centred reading column shared by the conversation and the composer, the button
// variants and their busy state, the session picker anchored under its button, and no sideways overflow at laptop widths,
// at 200% zoom and with long content. Chromium only, synthetic content (test/helpers/shell-fixture.ts). Skipped, saying so,
// without Playwright.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

test("markup: the design tokens exist once, components use them, and no web font is loaded", () => {
  for (const t of ["--font-sans", "--font-mono", "--text-2xs", "--text-ui", "--text-xl", "--leading-tight", "--leading-code", "--weight-strong", "--radius-xs",
    "--dur-1", "--dur-2", "--ease", "--btn-h", "--surface-2", "--focus-ring", "--field-halo", "--measure", "--measure-wide",
    "--info", "--ok", "--warn", "--danger", "--attention", "--danger-soft"]) {
    assert.ok(new RegExp(`\\s${t}:`).test(css), `${t} is defined`);
  }
  // One monospace stack and one transition timing, both from tokens.
  assert.equal(css.match(/ui-monospace/g)?.length, 1, "the monospace stack is written once, in --font-mono");
  assert.doesNotMatch(css, /\.12s ease|\.08s ease/, "transitions use the motion tokens");
  assert.doesNotMatch(css, /border-radius: (6|8|10|12)px/, "radii come from the radius scale");
  // System fonts only: nothing fetched from a font service, no @font-face.
  assert.doesNotMatch(html, /@font-face|fonts\.googleapis|fonts\.gstatic|typekit|\.woff2?\b/i);
  // Variants exist, and reduced motion still turns motion off (the busy spinner included).
  for (const sel of [".btn-secondary", ".btn-danger", 'button[aria-busy="true"]::after', "@keyframes orbit-spin"]) assert.ok(css.includes(sel), sel);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ transition: none !important; animation: none !important;/);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; desktop design browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 24, card: true, notes: 5 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

async function open(width: number, height: number, route: string, opts: { phone?: boolean; colorScheme?: string } = {}) {
  const ctx = await chromium.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light", ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(url + route);
  const conv = route.includes("sessions") ? "log" : "alog";
  await page.waitForFunction((id: string) => document.getElementById(id)!.querySelectorAll(".msg").length > 0, conv);
  await page.waitForTimeout(150);
  return { page, ctx, errors, conv };
}
const sideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

for (const [width, height] of [[1280, 800], [1440, 900]] as const) {
  test(`browser ${width}px: one grouped header row, page tabs read as navigation, icon toggles with the full indicators in the sidebar`, { skip }, async () => {
    const { page, ctx, errors } = await open(width, height, "/#assistant");
    const g = await page.evaluate(() => {
      const r = (e: Element) => e.getBoundingClientRect();
      const header = document.querySelector("header")!, brand = document.querySelector(".brand")!, nav = document.getElementById("tabs")!;
      const tabs = [...nav.querySelectorAll("a:not([hidden])")] as HTMLElement[];
      const cur = tabs.find((a) => a.getAttribute("aria-current") === "page")!, other = tabs.find((a) => a !== cur)!;
      const cs = (e: Element) => getComputedStyle(e);
      return {
        header: r(header).height, brand: r(brand), nav: r(nav), notes: r(document.getElementById("notesbtn")!), health: r(document.getElementById("health")!), vw: document.documentElement.clientWidth,
        divider: cs(brand).borderRightWidth, cur: { w: Number(cs(cur).fontWeight), bg: cs(cur).backgroundImage, shadow: cs(cur).boxShadow }, other: { w: Number(cs(other).fontWeight), bg: cs(other).backgroundImage },
        track: cs(nav).backgroundColor, headerText: (document.querySelector("header .hctl") as HTMLElement).innerText.trim(),
        foot: { notes: (document.getElementById("navnotes") as HTMLElement).innerText.replace(/\s+/g, " ").trim(), status: (document.getElementById("navstatus") as HTMLElement).innerText.trim() },
      };
    });
    assert.ok(g.header <= 56, `the header stays compact (${g.header}px)`);
    const mid = (b: any) => b.top + b.height / 2;
    for (const k of ["nav", "notes", "health"] as const) assert.ok(Math.abs(mid(g[k]) - mid(g.brand)) <= 3, `${k} on the brand's row`);
    assert.equal(g.divider, "1px", "a divider separates the brand from the page tabs");
    assert.ok(g.nav.left > g.brand.right && g.notes.left > g.nav.right && g.health.left >= g.notes.right && g.health.right <= g.vw, "brand, tabs, then the toggles at the right edge");
    assert.notEqual(g.track, "rgba(0, 0, 0, 0)", "the tabs sit on a track");
    assert.ok(g.cur.w >= 600 && g.other.w < 600, `the current page is bold (${g.cur.w} vs ${g.other.w})`);
    assert.match(g.cur.bg, /linear-gradient/, "the current page carries ORBIT's gradient underline");
    assert.equal(g.other.bg, "none", "other tabs do not");
    // The header keeps the bell with its count and the status dot; the words live in the sidebar's indicators (docs/sidebar.md).
    assert.equal(g.headerText, "5", "no Notifications or status words in the header, only the count");
    assert.equal(g.foot.notes, "Notifications 5");
    assert.match(g.foot.status, /^(All live|Degraded: .+)$/);
    assert.equal(await sideways(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`browser ${width}px: the conversation and the composer share one centred reading column; Send is clear`, { skip }, async () => {
    for (const route of ["/#assistant", "/sessions"]) {
      const { page, ctx, conv } = await open(width, height, route);
      const g = await page.evaluate((id: string) => {
        const log = document.getElementById(id)!, form = document.getElementById(id === "alog" ? "aform" : "form")!;
        const rows = [...log.querySelectorAll(".msg")].map((m) => m.getBoundingClientRect());
        const box = form.querySelector("textarea")!.getBoundingClientRect(), plus = form.querySelector(".phbtn")!.getBoundingClientRect(), send = form.querySelector(".sendbtn")!;
        const s = send.getBoundingClientRect(), hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
        return { left: Math.min(...rows.map((r) => r.left)), right: Math.max(...rows.map((r) => r.right)), plusLeft: plus.left, sendRight: s.right, boxRight: box.right, sendLeft: s.left,
          vw: document.documentElement.clientWidth, sendHit: Boolean(hit && (hit === send || send.contains(hit))), nav: document.getElementById("nav")!.getBoundingClientRect().right };
      }, conv);
      const col = g.right - g.left;
      assert.ok(col <= 860 && col >= 840, `${route}: rows form an ~860px column (${col})`);
      // The sidebar is docked open by default from 1024px (docs/sidebar.md): the column is centred in the room right of it.
      assert.ok(g.nav >= 220, `${route}: the sidebar is open on the left (${g.nav})`);
      assert.ok(Math.abs(g.left - (g.nav + (g.vw - g.nav - 860) / 2)) <= 1, `${route}: the column is centred in the room left by the sidebar (left ${g.left})`);
      assert.ok(Math.abs(g.plusLeft - g.left) <= 1, `${route}: the composer starts where the messages start (${g.plusLeft} vs ${g.left})`);
      assert.ok(g.sendRight <= g.left + 860 + 1, `${route}: Send ends inside the column`);
      assert.ok(g.sendLeft - g.boxRight >= 8, `${route}: an explicit gap before Send`);
      assert.equal(g.sendHit, true, `${route}: Send is not covered`);
      assert.equal(await sideways(page), false);
      await ctx.close();
    }
  });
}

// Below 1024px the sidebar is a drawer (test/sidebar-browser.test.ts): the header's bell opens it on the notifications.
test("browser 960px: the bell opens the sidebar drawer on the notifications, over the page, and closes back to the bell", { skip }, async () => {
  const { page, ctx } = await open(960, 800, "/#assistant");
  await page.click("#notesbtn");
  await page.waitForFunction(() => document.querySelectorAll("#inbox .note").length > 0);
  const g = await page.evaluate(() => {
    const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return { nav: r("nav"), inbox: r("inbox"), role: document.getElementById("nav")!.getAttribute("role"), modal: document.getElementById("nav")!.getAttribute("aria-modal"),
      inert: document.querySelector("header")!.hasAttribute("inert"), vw: document.documentElement.clientWidth, vh: window.innerHeight };
  });
  assert.ok(g.nav.left === 0 && g.nav.width <= 361 && Math.abs(g.nav.bottom - g.vh) <= 1, `a drawer from the left edge, full height (${JSON.stringify(g.nav)})`);
  assert.ok(g.inbox.left >= g.nav.left && g.inbox.right <= g.nav.right, "the notifications are inside it");
  assert.deepEqual([g.role, g.modal, g.inert], ["dialog", "true", true], "modal while open: the page behind is inert");
  assert.equal(await sideways(page), false);
  // Notification controls keep working: dismiss one with the keyboard; focus stays in the panel.
  await page.focus("#inbox .note .x");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.getElementById("inbox")!.contains(document.activeElement)), true, "focus stays in the panel after a dismissal");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement!.id), "notesbtn");
  assert.equal(await page.evaluate(() => document.querySelector("header")!.hasAttribute("inert")), false);
  await ctx.close();
});

test("browser: the session picker is anchored under its button and inside the screen at 1280, 900 and 200% zoom (640px)", { skip }, async () => {
  for (const [w, h] of [[1280, 800], [900, 700], [640, 400]] as const) {
    const { page, ctx } = await open(w, h, "/sessions");
    await page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
    await page.click("#sessbtn");
    const g = await page.evaluate(() => {
      const p = document.getElementById("sesspicker")!.getBoundingClientRect(), b = document.getElementById("sessbtn")!.getBoundingClientRect();
      const top = document.elementFromPoint(p.left + 20, p.top + 20);
      return { p: { l: p.left, r: p.right, t: p.top, b: p.bottom }, b: { l: b.left, b: b.bottom }, vw: document.documentElement.clientWidth, vh: window.innerHeight,
        onTop: Boolean(top && document.getElementById("sesspicker")!.contains(top)), archive: document.getElementById("tarchive")!.className };
    });
    assert.ok(g.p.t >= g.b.b && g.p.t - g.b.b <= 10, `${w}px: right under the button`);
    assert.ok(g.p.l >= 0 && g.p.r <= g.vw && g.p.b <= g.vh, `${w}px: inside the screen`);
    assert.ok(Math.abs(g.p.l - g.b.l) <= 1 || g.p.r >= g.vw - 9, `${w}px: aligned with the button, or held in from the right edge`);
    assert.equal(g.onTop, true, `${w}px: above the conversation`);
    assert.match(g.archive, /btn-danger/, `${w}px: Archive is styled as destructive`);
    assert.equal(await sideways(page), false, `${w}px: no sideways scroll`);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "sessbtn", `${w}px: Escape returns focus to the button`);
    await ctx.close();
  }
});

test("browser: confirmation cards put Confirm (primary) and Cancel (secondary) in one row, and Confirm shows a busy state while waiting", { skip }, async () => {
  const { page, ctx } = await open(1280, 800, "/#assistant");
  const look = await page.evaluate(() => {
    const card = document.querySelector("#alog .proposal")!, [ok, no] = [...card.querySelectorAll(".pactions button")] as HTMLElement[];
    const cs = (e: Element) => getComputedStyle(e);
    return { title: card.querySelector(".ptitle")?.textContent, okBg: cs(ok!).backgroundImage, noBg: cs(no!).backgroundImage, noBorder: cs(no!).borderTopWidth,
      sameRow: Math.abs(ok!.getBoundingClientRect().top - no!.getBoundingClientRect().top) < 1, h: ok!.getBoundingClientRect().height, texts: [ok!.textContent, no!.textContent] };
  });
  assert.match(look.title!, /^Proposed job on routine "orbit"\. Nothing has launched yet\.$/, "the truthful wording is kept, as the card's title");
  assert.deepEqual(look.texts, ["Confirm", "Cancel"]);
  assert.match(look.okBg, /linear-gradient/, "Confirm is primary");
  assert.equal(look.noBg, "none", "Cancel is secondary");
  assert.equal(look.noBorder, "1px");
  assert.equal(look.sameRow, true);
  assert.ok(look.h >= 32, `action buttons are at least 32px (${look.h})`);
  // Hold the confirm request: Confirm is disabled and busy (with a spinner) until the answer replaces the buttons.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/chat/proposals/**", async (route: any) => { await held; await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "synthetic refusal" }) }); });
  await page.click("#alog .proposal .pactions button:not(.cancel)");
  const busy = await page.evaluate(() => { const b = document.querySelector("#alog .proposal .pactions button:not(.cancel)") as HTMLButtonElement; return { busy: b.getAttribute("aria-busy"), disabled: b.disabled, spinner: getComputedStyle(b, "::after").animationName, other: (document.querySelector("#alog .proposal .cancel") as HTMLButtonElement).disabled }; });
  assert.deepEqual(busy, { busy: "true", disabled: true, spinner: "orbit-spin", other: true });
  release();
  await page.waitForFunction(() => /Launch failed: synthetic refusal/.test(document.querySelector("#alog .proposal")!.textContent!));
  assert.equal(await page.$$eval("#alog .proposal button", (b: unknown[]) => b.length), 0, "the answer replaces the buttons");
  await ctx.close();
});

test("browser: reduced motion stops the busy spinner", { skip }, async () => {
  const ctx = await chromium.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(url + "/#assistant");
  await page.waitForSelector("#alog .proposal .pactions button");
  const name = await page.evaluate(() => { const b = document.querySelector("#alog .proposal .pactions button") as HTMLElement; b.setAttribute("aria-busy", "true"); return getComputedStyle(b, "::after").animationName; });
  assert.equal(name, "none");
  await ctx.close();
});

test("browser: keyboard focus on a page tab and on the header toggles shows the shared focus ring", { skip }, async () => {
  const { page, ctx } = await open(1280, 800, "/#assistant");
  await page.focus("#assistanttab");
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => { const e = document.activeElement as HTMLElement, cs = getComputedStyle(e); return { id: e.id, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }; });
  assert.equal(ring.style, "solid", `${ring.id} shows a ring`);
  assert.ok(ring.width >= 2);
  await page.focus("#notesbtn");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const r2 = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  assert.equal(r2, "solid", "the notifications toggle shows a ring");
  await ctx.close();
});

test("browser: no sideways overflow and nothing covered at laptop, tablet, phone and 200%/400% zoom widths, light and dark", { skip }, async () => {
  for (const [w, h, phone] of [[1440, 900, false], [1280, 800, false], [1024, 768, false], [820, 1180, true], [640, 400, false], [390, 844, true], [320, 568, true]] as const) {
    for (const colorScheme of ["light", "dark"]) {
      for (const route of ["/#assistant", "/sessions"]) {
        const { page, ctx, conv } = await open(w, h, route, { phone, colorScheme });
        const g = await page.evaluate((id: string) => {
          const log = document.getElementById(id)!, f = document.getElementById(id === "alog" ? "aform" : "form")!.getBoundingClientRect(), hd = document.querySelector("header")!.getBoundingClientRect();
          return { logX: log.scrollWidth > log.clientWidth + 1, formBottom: f.bottom, vh: window.innerHeight, header: hd.height,
            pre: [...log.querySelectorAll(".scrollx")].every((p) => p.getBoundingClientRect().right <= log.getBoundingClientRect().right + 1) };
        }, conv);
        const what = `${w}x${h} ${colorScheme} ${route}`;
        assert.equal(await sideways(page), false, `${what}: no page overflow`);
        assert.equal(g.logX, false, `${what}: the conversation does not scroll sideways (long code scrolls inside)`);
        assert.equal(g.pre, true, `${what}: code and table regions stay inside the conversation (they scroll inside)`);
        assert.ok(Math.abs(g.formBottom - g.vh) <= 1, `${what}: composer on the bottom edge`);
        assert.ok(g.header <= h * 0.6, `${what}: header within its cap`);
        await ctx.close();
      }
    }
  }
});
