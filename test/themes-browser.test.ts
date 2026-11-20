import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// Light, Dark and System themes (docs/design-system.md): the header's theme menu, the stored choice applied before the
// first paint, System following the device live, other tabs following a change, keyboard and dismissal behaviour, and
// WCAG AA contrast for text and 3:1 for focus and selection in both themes, chosen explicitly or through the device.
// Chromium only, synthetic content. Skipped, saying so, without Playwright.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

test("markup: a pre-paint theme script in <head>, the theme menu is native radios, and both dark routes hold the same values", () => {
  const head = html.slice(0, html.indexOf("</head>"));
  const pre = head.indexOf('localStorage.getItem("orbit.theme")');
  assert.ok(pre > 0 && pre < head.indexOf("<style>"), "the stored theme is applied in <head>, before the stylesheet and the body");
  assert.match(html, /<button type="button" id="themebtn" class="hbtn" data-mode="system" aria-expanded="false" aria-controls="themepicker" aria-label="Theme: System"/);
  assert.match(html, /<div id="themepicker" hidden><fieldset><legend>Theme<\/legend>/);
  assert.deepEqual([...html.matchAll(/<input type="radio" name="theme" value="(\w+)">/g)].map((m) => m[1]), ["system", "light", "dark"]);
  // The dark palette is written twice (device route and explicit choice); the two must not drift apart.
  const media = html.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)![1]!;
  const explicit = html.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)![1]!;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  assert.equal(norm(media), norm(explicit));
  assert.match(media, /color-scheme: dark;/);
  assert.match(html, /:root \{\s*color-scheme: light;/);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; theme browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 6, card: true, notes: 3 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

// Records, when <body> first appears in the parse, which theme the page already had: the proof there is no flash.
const AT_BODY = `new MutationObserver((ms, o) => { if (document.body) { window.__themeAtBody = document.documentElement.getAttribute("data-theme"); o.disconnect(); } }).observe(document, { childList: true, subtree: true });`;
async function context(colorScheme: "light" | "dark", opts: { width?: number; height?: number; phone?: boolean } = {}) {
  const ctx = await chromium.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 }, colorScheme, ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(AT_BODY);
  return ctx;
}
async function load(page: any, route = "/#assistant") {
  await page.goto(url + route);
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg, #log .msg").length > 0);
}
const state = (page: any) => page.evaluate(() => ({
  attr: document.documentElement.getAttribute("data-theme"), bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  scheme: getComputedStyle(document.documentElement).colorScheme, stored: localStorage.getItem("orbit.theme"), atBody: (window as any).__themeAtBody ?? null,
  label: document.getElementById("themebtn")!.getAttribute("aria-label"), mode: document.getElementById("themebtn")!.dataset.mode,
  meta: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content")),
}));
const LIGHT_BG = "#f4f2fb", DARK_BG = "#080a1a";

test("browser: System is the default and follows the device, live, without storing anything", { skip }, async () => {
  const ctx = await context("light");
  const page = await ctx.newPage();
  await load(page);
  let s = await state(page);
  assert.deepEqual([s.attr, s.bg, s.scheme, s.stored, s.mode, s.label], [null, LIGHT_BG, "light", null, "system", "Theme: System (light now)"]);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.getElementById("themebtn")!.getAttribute("aria-label") === "Theme: System (dark now)");
  s = await state(page);
  assert.deepEqual([s.attr, s.bg, s.scheme, s.stored], [null, DARK_BG, "dark", null]);
  assert.deepEqual(s.meta, [DARK_BG, LIGHT_BG], "the browser colour still follows each media query");
  await ctx.close();
});

test("browser: an explicit choice wins over the device, persists, is applied before the body is parsed, and other tabs follow", { skip }, async () => {
  for (const [os, pick, want] of [["light", "dark", DARK_BG], ["dark", "light", LIGHT_BG]] as const) {
    const ctx = await context(os);
    const page = await ctx.newPage();
    await load(page);
    const other = await ctx.newPage();
    await load(other, "/sessions");
    await page.click("#themebtn");
    await page.check(`#themepicker input[value="${pick}"]`);
    let s = await state(page);
    assert.deepEqual([s.attr, s.bg, s.stored, s.mode, s.label], [pick, want, pick, pick, `Theme: ${pick === "dark" ? "Dark" : "Light"}`], `${os} device, ${pick} chosen`);
    assert.deepEqual(s.meta, [want, want], "the browser colour matches the chosen theme");
    await other.waitForFunction((t: string) => document.documentElement.getAttribute("data-theme") === t, pick);
    assert.equal((await state(other)).mode, pick, "another open tab follows");
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length > 0);
    s = await state(page);
    assert.equal(s.atBody, pick, "already set when <body> started: no flash of the device's theme");
    assert.equal(s.bg, want);
    // Back to System: nothing stored, the device's theme again.
    await page.click("#themebtn");
    await page.check('#themepicker input[value="system"]');
    s = await state(page);
    assert.deepEqual([s.attr, s.stored, s.bg], [null, null, os === "dark" ? DARK_BG : LIGHT_BG]);
    await ctx.close();
  }
});

test("browser: the theme menu works by keyboard, closes on Escape, a click outside or focus leaving, and stays on screen", { skip }, async () => {
  for (const [w, h, phone] of [[1280, 800, false], [640, 400, false], [390, 844, true], [320, 568, true]] as const) {
    const ctx = await context("light", { width: w, height: h, phone });
    const page = await ctx.newPage();
    await load(page);
    await page.focus("#themebtn");
    await page.keyboard.press("Enter");
    assert.equal(await page.getAttribute("#themebtn", "aria-expanded"), "true");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).value), "system", `${w}px: focus on the current choice`);
    const g = await page.evaluate(() => {
      const m = document.getElementById("themepicker")!.getBoundingClientRect(), b = document.getElementById("themebtn")!.getBoundingClientRect();
      const top = document.elementFromPoint(m.left + 12, m.top + 12);
      return { m: { l: m.left, r: m.right, t: m.top, b: m.bottom }, btn: b.bottom, vw: document.documentElement.clientWidth, vh: window.innerHeight,
        onTop: Boolean(top && document.getElementById("themepicker")!.contains(top)), x: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    assert.ok(g.m.l >= 0 && g.m.r <= g.vw && g.m.b <= g.vh && g.m.t >= g.btn, `${w}px: under the button and on screen`);
    assert.equal(g.onTop, true, `${w}px: above the page`);
    assert.equal(g.x, false, `${w}px: no sideways scroll`);
    // Native radios: arrow keys move and choose.
    await page.keyboard.press("ArrowDown");
    assert.equal((await state(page)).mode, "light", `${w}px: ArrowDown chooses Light`);
    await page.keyboard.press("ArrowDown");
    assert.equal((await state(page)).attr, "dark", `${w}px: and then Dark`);
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    assert.equal(ring, "solid", `${w}px: the focused radio shows the focus ring`);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "themebtn", `${w}px: Escape returns focus`);
    assert.equal(await page.isVisible("#themepicker"), false);
    // A click outside closes it without moving focus into the menu.
    await page.click("#themebtn");
    assert.equal(await page.isVisible("#themepicker"), true);
    await page.mouse.click(5, h - 120);
    assert.equal(await page.isVisible("#themepicker"), false, `${w}px: a click outside closes it`);
    assert.equal(await page.getAttribute("#themebtn", "aria-expanded"), "false");
    // Focus leaving (Tab past the last option) closes it.
    await page.click("#themebtn");
    await page.keyboard.press("Tab");
    assert.equal(await page.isVisible("#themepicker"), false, `${w}px: focus leaving closes it`);
    await ctx.close();
  }
});

// Resolves any CSS colour (hex, rgb(), color-mix()) to sRGB through the browser, then computes WCAG contrast.
const CONTRAST = `(pairs) => {
  const probe = document.createElement("div"); document.body.append(probe);
  const rgb = (expr) => {
    probe.style.color = ""; probe.style.color = expr; const c = getComputedStyle(probe).color;
    let m = c.match(/^rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/); if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
    m = c.match(/^color\\(srgb ([\\d.e-]+) ([\\d.e-]+) ([\\d.e-]+)/); if (m) return [+m[1], +m[2], +m[3]];
    throw new Error("unreadable colour " + expr + " -> " + c);
  };
  const lum = (c) => { const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const out = pairs.map(([fg, bg, min]) => { const a = lum(rgb(fg)), b = lum(rgb(bg)); return { pair: fg + " on " + bg, r: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), min }; });
  probe.remove(); return out;
}`;
const TEXT = 4.5, UI = 3;
const PAIRS: [string, string, number][] = [
  ["var(--fg)", "var(--bg)", TEXT], ["var(--fg)", "var(--card)", TEXT], ["var(--fg)", "var(--surface-2)", TEXT], ["var(--muted)", "var(--bg)", TEXT],
  ["var(--muted)", "var(--card)", TEXT], ["var(--muted)", "var(--surface-2)", TEXT], ["var(--info)", "var(--card)", TEXT], ["var(--info)", "var(--bg)", TEXT],
  ["var(--ok)", "var(--card)", TEXT], ["var(--ok)", "var(--bg)", TEXT], ["var(--warn)", "var(--card)", TEXT], ["var(--warn)", "var(--bg)", TEXT],
  ["var(--danger)", "var(--card)", TEXT], ["var(--danger)", "var(--bg)", TEXT], ["var(--danger)", "var(--danger-soft)", TEXT], ["var(--fg)", "var(--info-soft)", TEXT],
  ["var(--fg)", "var(--attention-soft)", TEXT], ["var(--on-accent)", "var(--accent)", TEXT], ["var(--on-accent)", "var(--accent-2)", TEXT],
  ["var(--fg)", "color-mix(in srgb, var(--accent) 8%, var(--card))", TEXT], // the current page tab
  ["var(--bg)", "var(--fg)", TEXT], // the time tip (inverted)
  ["var(--accent-2)", "var(--bg)", UI], ["var(--accent-2)", "var(--card)", UI], // focus ring and expanded toggles
  ["var(--accent)", "var(--card)", UI], // checked radios and checkboxes (accent-color)
  ["var(--attention)", "var(--card)", UI], ["var(--danger)", "var(--card)", UI], // card edges that carry meaning
];

test("browser: AA contrast for text, and 3:1 for focus, selection and meaningful edges, in both themes by device and by choice", { skip }, async () => {
  for (const [os, choice] of [["light", null], ["dark", null], ["dark", "light"], ["light", "dark"]] as const) {
    const ctx = await context(os);
    if (choice) await ctx.addInitScript((t: string) => { try { localStorage.setItem("orbit.theme", t); } catch { /* */ } }, choice);
    const page = await ctx.newPage();
    await load(page);
    const rows: { pair: string; r: number; min: number }[] = await page.evaluate(`(${CONTRAST})(${JSON.stringify(PAIRS)})`);
    for (const { pair, r, min } of rows) assert.ok(r >= min, `${choice ?? os} (${choice ? "chosen" : "device"}): ${pair} is ${r.toFixed(2)}:1, below ${min}:1`);
    // The placeholder really is drawn in --muted, opaque.
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("ainput")!, "::placeholder").opacity), "1");
    await ctx.close();
  }
});
