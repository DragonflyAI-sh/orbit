import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The Appearance dialog in Chromium (docs/appearance.md): today's look on a fresh load, the looks clearly different, live
// preview of look, accent, font and text size, Save across a reload (applied before the body is parsed), Cancel and Reset to
// defaults, safe fallback for broken or blocked storage, a custom accent refused with a reason, and AA contrast and keyboard
// focus for every look at desktop and phone sizes. Synthetic content (test/helpers/shell-fixture.ts). Skipped, saying so,
// without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; appearance browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 6, card: true, notes: 3 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

const KEY = "orbit.appearance";
// Records, when <body> first appears in the parse, which look the page already had: the proof there is no flash.
const AT_BODY = `new MutationObserver((ms, o) => { if (document.body) { window.__atBody = { preset: document.documentElement.getAttribute("data-preset"), bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() }; o.disconnect(); } }).observe(document, { childList: true, subtree: true });`;
async function context(opts: { scheme?: "light" | "dark"; width?: number; height?: number; phone?: boolean; stored?: string | null; blockStorage?: boolean } = {}) {
  const ctx = await chromium.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 }, colorScheme: opts.scheme ?? "light", ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(AT_BODY);
  if (opts.stored !== undefined && opts.stored !== null) await ctx.addInitScript(([k, v]: string[]) => { if (!sessionStorage.getItem("__seeded")) { localStorage.setItem(k!, v!); sessionStorage.setItem("__seeded", "1"); } }, [KEY, opts.stored]);
  if (opts.blockStorage) {
    await ctx.addInitScript(() => {
      const no = () => { throw new DOMException("blocked", "SecurityError"); };
      Object.defineProperty(window, "localStorage", { get: no, configurable: true });
    });
  }
  return ctx;
}
async function load(page: any, route = "/#assistant") {
  await page.goto(url + route);
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg, #log .msg").length > 0);
}
const look = (page: any) => page.evaluate((k: string) => {
  const root = document.documentElement, cs = getComputedStyle(root), body = getComputedStyle(document.body);
  let stored: string | null = null;
  try { stored = localStorage.getItem(k); } catch { stored = "(blocked)"; }
  return {
    // Only the appearance overrides: the page keeps its own layout measurements inline on <html> too (--app-h, --nav-w...).
    inline: ["--accent", "--on-accent", "--accent-end", "--font-sans", "--text-scale"].filter((p) => root.style.getPropertyValue(p)).map((p) => `${p}: ${root.style.getPropertyValue(p)};`).join(" "),
    preset: root.getAttribute("data-preset"), theme: root.getAttribute("data-theme"),
    bg: cs.getPropertyValue("--bg").trim(), card: cs.getPropertyValue("--card").trim(), accent: cs.getPropertyValue("--accent").trim(), scheme: cs.colorScheme,
    font: body.fontFamily, size: body.fontSize, stored, atBody: (window as any).__atBody ?? null,
    label: document.getElementById("themebtn")!.getAttribute("aria-label"),
    meta: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content")),
  };
}, KEY);
async function openDialog(page: any) {
  await page.click("#themebtn");
  await page.click("#appearancebtn");
  await page.waitForFunction(() => (document.getElementById("appearance") as HTMLDialogElement).open);
}
const dialogOpen = (page: any) => page.evaluate(() => (document.getElementById("appearance") as HTMLDialogElement).open);
const CLASSIC_LIGHT = { bg: "#f4f2fb", card: "#fdfcff", accent: "#6d4fd8" }, CLASSIC_DARK_BG = "#080a1a";

test("browser: a fresh load is today's look: Classic, nothing inline, nothing stored, the system font at 15px", { skip }, async () => {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await context({ scheme });
    const page = await ctx.newPage();
    await load(page);
    const s = await look(page);
    assert.deepEqual([s.preset, s.theme, s.inline, s.stored], [null, null, "", null], `${scheme}: no look, no theme attribute, no inline style, nothing stored`);
    assert.equal(s.bg, scheme === "light" ? CLASSIC_LIGHT.bg : CLASSIC_DARK_BG);
    assert.equal(s.size, "15px", "the body text is the 15px it always was");
    assert.match(s.font, /^system-ui, -apple-system/);
    assert.equal(s.label, `Theme: System (${scheme} now)`);
    await ctx.close();
  }
});

test("browser: the looks are clearly different, preview at once, and set the scheme for native controls and the theme menu", { skip }, async () => {
  const ctx = await context({ scheme: "light" });
  const page = await ctx.newPage();
  await load(page);
  await openDialog(page);
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).value), "classic", "focus starts on the current look");
  const names = await page.$$eval("#aplooks .apopt .aptext", (els: Element[]) => els.map((e) => e.firstChild!.textContent));
  assert.deepEqual(names, ["Classic", "Warm light", "Cool dark"]);
  const seen: Record<string, any> = {};
  for (const id of ["warm", "cool", "classic"]) {
    await page.check(`#aplooks input[value="${id}"]`);
    seen[id] = await look(page);
  }
  assert.deepEqual([seen.warm.preset, seen.warm.theme, seen.warm.scheme, seen.warm.bg], ["warm", "light", "light", "#f5efe4"]);
  assert.deepEqual([seen.cool.preset, seen.cool.theme, seen.cool.scheme, seen.cool.bg], ["cool", "dark", "dark", "#0b1316"]);
  assert.deepEqual([seen.classic.preset, seen.classic.theme, seen.classic.bg], [null, null, CLASSIC_LIGHT.bg]);
  assert.equal(new Set([seen.warm.accent, seen.cool.accent, seen.classic.accent]).size, 3, "each look has its own accent");
  assert.equal(new Set([seen.warm.card, seen.cool.card, seen.classic.card]).size, 3, "and its own surfaces");
  assert.deepEqual(seen.cool.meta, ["#0b1316", "#0b1316"], "the browser toolbar follows the look");
  assert.equal(seen.cool.label, "Theme: Cool dark (set in Appearance)", "the theme button names the look while it previews");
  // Nothing is stored by previewing.
  assert.equal(seen.cool.stored, null);
  // A real difference on screen: the page background pixel under the composer area differs between looks.
  await page.check('#aplooks input[value="cool"]');
  await page.click("#apsave");
  await page.click("#themebtn");
  const radios = await page.$$eval('#themepicker input[name="theme"]', (els: HTMLInputElement[]) => els.map((r) => r.disabled));
  assert.deepEqual(radios, [true, true, true], "Light, Dark and System are off while a look fixes the scheme");
  assert.match(await page.textContent("#themenote"), /Cool dark sets its own colours\. Choose Classic in Appearance/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "appearancebtn", "the menu opens on its first usable row");
  await ctx.close();
});

test("browser: accent, font and text size preview live; code and the editor stay monospace; Save keeps them across a reload, before the body", { skip }, async () => {
  const ctx = await context({ scheme: "light" });
  const page = await ctx.newPage();
  await load(page);
  const codeFont = await page.evaluate(() => getComputedStyle(document.querySelector("#alog pre, #alog code")!).fontFamily);
  await openDialog(page);
  await page.check('#aplooks input[value="warm"]');
  await page.check('#apaccents input[value="#1f9a8a"]');
  await page.selectOption("#apfont", "serif");
  await page.selectOption("#apsize", "larger");
  let s = await look(page);
  assert.equal(s.accent, "#1f9a8a");
  assert.match(s.font, /^Charter, "Bitstream Charter"/);
  assert.equal(s.size, "18px", "15px at 120%");
  assert.equal(s.stored, null, "a preview stores nothing");
  const chrome = await page.evaluate(() => ({
    code: getComputedStyle(document.querySelector("#alog pre, #alog code")!).fontFamily,
    btn: getComputedStyle(document.getElementById("apsave")!).backgroundImage,
    on: getComputedStyle(document.getElementById("apsave")!).color,
    title: getComputedStyle(document.getElementById("aptitle")!).fontSize,
  }));
  assert.equal(chrome.code, codeFont, "code keeps its monospace face");
  assert.match(chrome.code, /monospace/);
  assert.match(chrome.btn, /rgb\(31, 154, 138\).*rgb\(31, 154, 138\)/, "a custom accent fills the primary button");
  assert.equal(chrome.on, "rgb(11, 13, 31)", "with a label colour that reads on it");
  assert.equal(chrome.title, "21.6px", "the dialog itself follows the size (18px titles x 1.2)");
  await page.click("#apsave");
  assert.equal(await dialogOpen(page), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "themebtn", "focus returns to the theme button");
  s = await look(page);
  assert.deepEqual(JSON.parse(s.stored!), { v: 1, preset: "warm", accent: "#1f9a8a", font: "serif", size: "larger" });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length > 0);
  s = await look(page);
  assert.deepEqual(s.atBody, { preset: "warm", bg: "#f5efe4" }, "already applied when <body> started: no flash of Classic");
  assert.deepEqual([s.preset, s.accent, s.size], ["warm", "#1f9a8a", "18px"]);
  assert.match(s.font, /^Charter/);
  // Another tab follows a saved change.
  const other = await ctx.newPage();
  await load(other, "/sessions");
  await openDialog(page);
  await page.check('#aplooks input[value="cool"]');
  await page.click("#apsave");
  await other.waitForFunction(() => document.documentElement.getAttribute("data-preset") === "cool");
  await ctx.close();
});

test("browser: Cancel and Escape put back what was saved; Reset to defaults previews today's look and Save stores nothing", { skip }, async () => {
  const ctx = await context({ scheme: "dark", stored: JSON.stringify({ v: 1, preset: "cool", accent: "#c07a10", font: "rounded", size: "small" }) });
  const page = await ctx.newPage();
  await load(page);
  const saved = await look(page);
  assert.deepEqual([saved.preset, saved.accent, saved.size], ["cool", "#c07a10", "13.5px"]);
  // Cancel.
  await openDialog(page);
  assert.equal(await page.isChecked('#apaccents input[value="#c07a10"]'), true, "the form shows what is saved");
  assert.equal(await page.inputValue("#apfont"), "rounded");
  await page.check('#aplooks input[value="warm"]');
  await page.selectOption("#apsize", "larger");
  assert.equal((await look(page)).preset, "warm");
  await page.click("#apcancel");
  let s = await look(page);
  assert.deepEqual([s.preset, s.accent, s.size, s.stored], ["cool", "#c07a10", "13.5px", saved.stored]);
  // Escape cancels too.
  await openDialog(page);
  await page.check('#aplooks input[value="classic"]');
  assert.equal((await look(page)).bg, CLASSIC_DARK_BG);
  await page.keyboard.press("Escape");
  assert.equal(await dialogOpen(page), false);
  assert.equal((await look(page)).preset, "cool");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "themebtn");
  // Reset to defaults: a preview of today's look, explained; Cancel would still go back.
  await openDialog(page);
  await page.click("#apreset");
  s = await look(page);
  assert.deepEqual([s.preset, s.inline, s.bg, s.size], [null, "", CLASSIC_DARK_BG, "15px"]);
  assert.match(await page.textContent("#apnote"), /Defaults shown\. Save to keep them/);
  assert.equal(await page.isChecked('#aplooks input[value="classic"]'), true);
  assert.equal(await page.inputValue("#apfont"), "system");
  await page.click("#apsave");
  s = await look(page);
  assert.equal(s.stored, null, "saving the defaults stores nothing, as before this feature");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#alog .msg").length > 0);
  s = await look(page);
  assert.deepEqual([s.preset, s.inline, s.bg], [null, "", CLASSIC_DARK_BG]);
  await ctx.close();
});

test("browser: broken, unknown or blocked storage falls back safely; a bad field costs only itself", { skip }, async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["{not json", { preset: null, inline: "" }],
    [JSON.stringify({ v: 7, preset: "cool" }), { preset: null, inline: "" }],
    [JSON.stringify({ v: 1, preset: "neon", accent: "red; background: url(x)", font: "Papyrus", size: "huge" }), { preset: null, inline: "" }],
    [JSON.stringify({ v: 1, preset: "cool", accent: "#1c1838", size: "large" }), { preset: "cool", inline: "--text-scale: 1.1;" }],
  ];
  for (const [stored, want] of cases) {
    const ctx = await context({ scheme: "light", stored });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await load(page);
    const s = await look(page);
    assert.deepEqual({ preset: s.preset, inline: s.inline }, want, stored);
    assert.deepEqual(errors, [], `${stored}: no script error`);
    // The dialog opens with the cleaned values.
    await openDialog(page);
    assert.equal(await page.isChecked(`#aplooks input[value="${want.preset ?? "classic"}"]`), true);
    await ctx.close();
  }
  // Storage blocked entirely: today's look, the dialog still previews, and Save says it could not keep it.
  const ctx = await context({ scheme: "light", blockStorage: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await load(page);
  assert.deepEqual([(await look(page)).preset, (await look(page)).stored], [null, "(blocked)"]);
  await openDialog(page);
  await page.check('#aplooks input[value="cool"]');
  assert.equal((await look(page)).preset, "cool", "the preview still works");
  await page.click("#apsave");
  assert.equal(await dialogOpen(page), true, "not closed as if saved");
  assert.equal(await page.getAttribute("#apnote", "role"), "alert");
  assert.match(await page.textContent("#apnote"), /^Not saved: this browser is blocking storage\./);
  await page.click("#apcancel");
  assert.equal((await look(page)).preset, null);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("browser: a custom accent that would be unreadable is explained and not used; Save waits for a readable one", { skip }, async () => {
  const ctx = await context({ scheme: "light" });
  const page = await ctx.newPage();
  await load(page);
  await openDialog(page);
  // Pale yellow on Classic's light cards: refused with the reason, the look's own accent stays, Save is off.
  await page.$eval("#apcustom", (i: HTMLInputElement) => { i.value = "#f6e27a"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.isChecked('#apaccents input[value="custom"]'), true, "editing the colour picks Custom");
  assert.equal(await page.getAttribute("#apcustom", "aria-invalid"), "true");
  assert.equal(await page.isVisible("#apaccentmsg"), true);
  assert.match(await page.textContent("#apaccentmsg"), /^Too faint on (light cards|the light page) \(1\.\d:1, needs 3:1\)\. Pick a darker shade\./);
  assert.equal((await look(page)).accent, CLASSIC_LIGHT.accent, "not applied");
  assert.equal(await page.isDisabled("#apsave"), true);
  // A readable custom colour is applied, with a label colour that reads on it.
  await page.$eval("#apcustom", (i: HTMLInputElement) => { i.value = "#7c5ce6"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.isDisabled("#apsave"), false);
  assert.equal(await page.isVisible("#apaccentmsg"), false);
  let s = await look(page);
  assert.equal(s.accent, "#7c5ce6");
  assert.match(s.inline, /--on-accent: #ffffff;/);
  // Deep navy is too dark for Classic (it can be dark), but fine for Warm light.
  await page.$eval("#apcustom", (i: HTMLInputElement) => { i.value = "#1a1a6e"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.isDisabled("#apsave"), true);
  assert.match(await page.textContent("#apaccentmsg"), /Too faint on (dark cards|the dark page) .*Classic can be light or dark, so its accent has to suit both\./);
  await page.check('#aplooks input[value="warm"]');
  assert.equal(await page.isDisabled("#apsave"), false);
  s = await look(page);
  assert.equal(s.accent, "#1a1a6e");
  assert.match(s.inline, /--on-accent: #ffffff;/);
  // ...unless the look changes under it: deep navy is too dark for Cool dark.
  await page.check('#aplooks input[value="cool"]');
  assert.equal(await page.isDisabled("#apsave"), true);
  assert.match(await page.textContent("#apaccentmsg"), /Too faint on (dark cards|the dark page) .*Pick a lighter shade/);
  assert.equal((await look(page)).accent, "#3fb8ad", "Cool dark's own accent meanwhile");
  await page.check('#apaccents input[value="#3d7fe0"]');
  assert.equal(await page.isDisabled("#apsave"), false, "a swatch always suits the look");
  await ctx.close();
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
// The same pairs as the Light and Dark themes (test/themes-browser.test.ts), plus the gradient's second stop under the
// button label, the syntax colours on the editor's card, and the Plan's own colours.
const PAIRS: [string, string, number][] = [
  ["var(--fg)", "var(--bg)", TEXT], ["var(--fg)", "var(--card)", TEXT], ["var(--fg)", "var(--surface-2)", TEXT], ["var(--muted)", "var(--bg)", TEXT],
  ["var(--muted)", "var(--card)", TEXT], ["var(--muted)", "var(--surface-2)", TEXT], ["var(--info)", "var(--card)", TEXT], ["var(--info)", "var(--bg)", TEXT],
  ["var(--ok)", "var(--card)", TEXT], ["var(--ok)", "var(--bg)", TEXT], ["var(--warn)", "var(--card)", TEXT], ["var(--warn)", "var(--bg)", TEXT],
  ["var(--danger)", "var(--card)", TEXT], ["var(--danger)", "var(--bg)", TEXT], ["var(--danger)", "var(--danger-soft)", TEXT], ["var(--fg)", "var(--info-soft)", TEXT],
  ["var(--fg)", "var(--attention-soft)", TEXT], ["var(--on-accent)", "var(--accent)", TEXT], ["var(--on-accent)", "var(--accent-end)", TEXT],
  ["var(--fg)", "color-mix(in srgb, var(--accent) 8%, var(--card))", TEXT], ["var(--bg)", "var(--fg)", TEXT],
  ["var(--accent-2)", "var(--bg)", UI], ["var(--accent-2)", "var(--card)", UI], ["var(--accent)", "var(--card)", UI], ["var(--accent)", "var(--bg)", UI],
  ["var(--attention)", "var(--card)", UI], ["var(--danger)", "var(--card)", UI],
  ...["comment", "keyword", "string", "number", "fn", "type", "prop", "tag", "meta", "var"].map((t) => [`var(--tk-${t})`, "var(--card)", TEXT] as [string, string, number]),
];

test("browser: every look and a custom accent keep AA text, 3:1 for focus and marks, and a visible focus ring, at desktop and phone sizes", { skip }, async () => {
  const setups: [string, string, "light" | "dark"][] = [
    ["warm", JSON.stringify({ v: 1, preset: "warm" }), "dark"],
    ["cool", JSON.stringify({ v: 1, preset: "cool" }), "light"],
    ["classic light + teal", JSON.stringify({ v: 1, accent: "#1f9a8a" }), "light"],
    ["classic dark + rose", JSON.stringify({ v: 1, accent: "#d0567e" }), "dark"],
    ["warm + amber, serif, larger", JSON.stringify({ v: 1, preset: "warm", accent: "#c07a10", font: "serif", size: "larger" }), "light"],
    ["cool + blue, small", JSON.stringify({ v: 1, preset: "cool", accent: "#3d7fe0", size: "small" }), "dark"],
  ];
  for (const [name, stored, scheme] of setups) {
    for (const [w, h, phone] of [[1280, 800, false], [390, 844, true], [320, 568, true]] as const) {
      const ctx = await context({ scheme, stored, width: w, height: h, phone });
      const page = await ctx.newPage();
      await load(page);
      if (w === 1280) {
        const rows: { pair: string; r: number; min: number }[] = await page.evaluate(`(${CONTRAST})(${JSON.stringify(PAIRS)})`);
        for (const { pair, r, min } of rows) assert.ok(r >= min, `${name}: ${pair} is ${r.toFixed(2)}:1, below ${min}:1`);
      }
      // The dialog fits the window, the page never scrolls sideways, and the keyboard focus ring shows on its controls.
      await page.focus("#themebtn");
      await page.keyboard.press("Enter");
      // From the current theme radio (or straight onto Appearance… when a look has turned the radios off).
      for (let i = 0; i < 3 && (await page.evaluate(() => document.activeElement?.id)) !== "appearancebtn"; i++) await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "appearancebtn", `${name} ${w}px: Appearance… by keyboard`);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => (document.getElementById("appearance") as HTMLDialogElement).open);
      const g = await page.evaluate(() => {
        const d = document.getElementById("appearance")!.getBoundingClientRect(), a = document.activeElement as HTMLElement;
        return { l: d.left, r: d.right, t: d.top, b: d.bottom, vw: document.documentElement.clientWidth, vh: window.innerHeight,
          x: document.documentElement.scrollWidth > document.documentElement.clientWidth, ring: getComputedStyle(a).outlineStyle, inDialog: document.getElementById("appearance")!.contains(a),
          over: [...document.querySelectorAll("#appearance .apopt, #appearance .aprow, #appearance .apbtns")].some((e) => e.scrollWidth > e.clientWidth + 1) };
      });
      assert.ok(g.l >= -0.5 && g.r <= g.vw + 0.5 && g.t >= -0.5 && g.b <= g.vh + 0.5, `${name} ${w}px: the dialog is on screen (${JSON.stringify(g)})`);
      assert.equal(g.x, false, `${name} ${w}px: no sideways scroll`);
      assert.equal(g.over, false, `${name} ${w}px: no row overflows`);
      assert.equal(g.inDialog, true, `${name} ${w}px: focus moves into the dialog`);
      assert.equal(g.ring, "solid", `${name} ${w}px: the focused option shows the focus ring`);
      // Tab reaches the buttons; the last one is Save, which is reachable and shows the ring too.
      for (let i = 0; i < 20 && (await page.evaluate(() => document.activeElement?.id)) !== "apsave"; i++) await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "apsave", `${name} ${w}px: Save by keyboard`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), "solid");
      await page.keyboard.press("Escape");
      await ctx.close();
    }
  }
});

test("browser: the file viewer and editor follow the look, and the editor text stays monospace", { skip }, async () => {
  const ctx = await context({ scheme: "light", stored: JSON.stringify({ v: 1, preset: "cool", font: "serif" }) });
  const page = await ctx.newPage();
  await load(page);
  await page.waitForSelector("#navfiles .navfile");
  await page.click("#navfiles .navfile >> nth=0");
  await page.waitForSelector("#fileview:not([hidden])");
  const edit = await page.$('#fileview .fmode:has-text("Edit")');
  if (edit) await edit.click();
  await page.waitForSelector("#fileview textarea");
  const s = await page.evaluate(() => {
    const ta = document.querySelector("#fileview textarea")!, pane = document.getElementById("fileview")!;
    const probe = document.createElement("i"); probe.style.color = "var(--card)"; pane.append(probe);
    const card = getComputedStyle(probe).color; probe.remove();
    return { font: getComputedStyle(ta).fontFamily, scheme: getComputedStyle(ta).colorScheme, card, ui: getComputedStyle(document.body).fontFamily };
  });
  assert.match(s.font, /ui-monospace/, "editor text is monospace");
  assert.match(s.ui, /^Charter/, "while the UI uses the chosen face");
  assert.equal(s.scheme, "dark", "native parts of the editor are drawn dark");
  assert.equal(s.card, "rgb(19, 32, 36)", "the look's card colour");
  await ctx.close();
});
