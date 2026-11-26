import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// The web page's component library (docs/ui-library.md): Pico CSS 2.1.1, ORBIT's scoped build, vendored in
// src/web/vendor/pico and served by ORBIT. These checks pin the vendored file, how the page loads it (its own cascade layer,
// no CDN), that it styles nothing outside a .pico element, and the three things it was brought in for: the select's chevron
// with room on its right, the menus' shared card, and the side panel. Chromium (Playwright) with synthetic content only;
// the browser checks are skipped, saying so, without Playwright.

const dir = new URL("../src/web/vendor/pico/", import.meta.url);
const css = readFileSync(new URL("pico.orbit.min.css", dir), "utf8");
const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const SHA256 = "eb0efc5d835b1aa55fe2f926aed07b3d8b757e8cfb52c079c29dde98469f753b";

test("the vendored file is the recorded build of Pico 2.1.1, with its licence and the recipe to rebuild it", () => {
  assert.equal(createHash("sha256").update(css).digest("hex"), SHA256, "edit orbit-pico.scss and run build.sh, not the built file");
  assert.match(css, /^\/\*!\n \* Pico CSS .* v2\.1\.1 \(https:\/\/picocss\.com\)\n \* Copyright 2019-2025 - Licensed under MIT\n \*\//);
  assert.notEqual(css.charCodeAt(0), 0xfeff, "no byte-order mark");
  assert.doesNotMatch(css, /sourceMappingURL|@import|@font-face|https?:\/\/(?!picocss\.com|www\.w3\.org\/2000\/svg)/, "nothing fetched from elsewhere");
  assert.match(readFileSync(new URL("LICENSE.md", dir), "utf8"), /^MIT License/);
  const readme = readFileSync(new URL("README.md", dir), "utf8");
  assert.ok(readme.includes(SHA256), "the README records the same hash");
  const build = readFileSync(new URL("build.sh", dir), "utf8");
  assert.match(build, /PICO_VERSION=2\.1\.1/);
  assert.match(build, /--ignore-scripts/);
  const scss = readFileSync(new URL("orbit-pico.scss", dir), "utf8");
  assert.match(scss, /\$parent-selector: "\.pico"/);
  for (const off of ["layout/document", "layout/landmarks", "layout/container", "layout/grid", "content/button", "content/typography"]) assert.match(scss, new RegExp(`"${off}": false`));
  for (const on of ["themes/default", "forms/basics", "forms/checkbox-radio-switch", "components/dropdown"]) assert.match(scss, new RegExp(`"${on}": true`));
});

test("the page imports it first, into its own cascade layer, from ORBIT's own address; the library areas are marked .pico", () => {
  const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.equal(html.split("<style>").length, 2, "one stylesheet");
  // @layer and @import come before any rule, so the import is valid; every unlayered ORBIT rule then wins over Pico.
  assert.match(style, /^<style>\n(?:\s*\/\*[\s\S]*?\*\/)?\s*@layer pico;\n\s*@import url\("\/vendor\/pico\.orbit\.min\.css"\) layer\(pico\);\n/);
  assert.equal((html.match(/@import/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<link[^>]+stylesheet|cdn\.|unpkg|jsdelivr/i, "no CDN");
  // The areas the library styles, and nothing else.
  assert.match(html, /<div class="navbody pico" id="navbody-projects"><select id="navproject"/);
  assert.match(html, /<div id="sesspicker" class="pico" role="group" aria-label="Sessions" hidden>/);
  assert.match(html, /<div id="themepicker" class="pico" hidden>/);
  assert.match(html, /<aside id="side" class="pico" aria-label="Side panel">/);
  assert.match(html, /el\("div", \{ className: "row pico" \}, state\.s, health\.s, lane\.s, kind\.s, routine\.s,/);
  assert.equal((html.match(/<[a-z]+ [^>]*class="[^"]*\bpico\b/g) ?? []).length, 4, "four in the markup (the Jobs row is built by the script)");
  // Pico's variables are ORBIT's tokens inside .pico (the bridge), so the library follows the theme with no rules of its own.
  const bridge = style.match(/\n {2}\.pico \{([^}]*)\}/)?.[1] ?? "";
  for (const [name, token] of [["background-color", "--card"], ["color", "--fg"], ["primary-background", "--accent"], ["form-element-border-color", "--line"],
    ["form-element-active-border-color", "--accent-2"], ["dropdown-background-color", "--card"], ["dropdown-box-shadow", "--elev-2"], ["font-family", "--font-sans"]] as const) {
    assert.match(bridge, new RegExp(`--pico-${name}: [^;]*var\\(${token}\\)`), `--pico-${name} maps to ${token}`);
  }
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; component library browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 6, card: true, notes: 12 });
const bare = shellServer({ exchanges: 6, card: true, notes: 12, html: html.replace(/\n\s*@import url\("\/vendor\/pico\.orbit\.min\.css"\) layer\(pico\);/, "") });
let url = "";
let bareUrl = "";
before(async () => { if (skip) return; url = await fixture.start(); bareUrl = await bare.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); bare.close(); });

async function open(base: string, width = 1280, height = 800, route = "/#assistant", colorScheme = "light") {
  const ctx = await chromium.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("request", (r: any) => { if (!r.url().startsWith(base) && !r.url().startsWith("data:")) foreign.push(r.url()); });
  await page.goto(base + route);
  await page.waitForFunction(() => document.getElementById("notecount")!.textContent !== "?");
  await page.waitForFunction(() => document.getElementById("navprojnote")!.textContent !== "Reading the vault…");
  return { page, ctx, errors, foreign };
}

test("the scoped build: every rule is under .pico except Pico's own variables and color-scheme on the root", { skip }, async () => {
  const ctx = await chromium.newContext();
  const page = await ctx.newPage();
  await page.setContent(`<style>${css}</style>`);
  const loose = await page.evaluate(() => {
    const out: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of [...rules]) {
        if ((r as CSSGroupingRule).cssRules && !(r as CSSStyleRule).selectorText) { walk((r as CSSGroupingRule).cssRules); continue; }
        const s = r as CSSStyleRule;
        if (!s.selectorText) continue;
        const props = [...s.style].filter((p) => !p.startsWith("--pico-") && p !== "color-scheme");
        const unscoped = s.selectorText.split(/,(?![^(]*\))/).filter((sel) => !sel.includes(".pico"));
        // The one unscoped pseudo-element rule is Pico's nav list marker, :where(nav li)::before, with no specificity; ORBIT's
        // page has no nav list items.
        if (unscoped.length && props.length && s.selectorText !== ":where(nav li)::before") out.push(`${s.selectorText} { ${props.join(", ")} }`);
      }
    };
    walk(document.styleSheets[0]!.cssRules);
    return out;
  });
  assert.deepEqual(loose, []);
  await ctx.close();
});

test("browser: the library changes nothing outside a .pico element (computed styles with and without it), and loads nothing from elsewhere", { skip }, async () => {
  const snap = (page: any) => page.evaluate(() => {
    const SIZE = new Set(["width", "height", "inline-size", "block-size", "perspective-origin", "transform-origin"]);
    const out: Record<string, string> = {};
    const path = (e: Element): string => (e.id ? `#${e.id}` : e.parentElement ? `${path(e.parentElement)}>${e.tagName}:${[...e.parentElement.children].indexOf(e)}` : e.tagName);
    for (const e of [document.documentElement, ...document.querySelectorAll("body *")]) {
      if (e.closest(".pico") || e.closest("script, style")) continue;
      const cs = getComputedStyle(e);
      // Every computed property but the used box size (and the origins worked out from it): a box that holds a .pico element
      // grows or shrinks with it, which is layout, not style.
      out[path(e)] = [...cs].filter((p) => !p.startsWith("--pico-") && !SIZE.has(p)).sort().map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
    }
    return out;
  });
  for (const colorScheme of ["light", "dark"]) {
    const a = await open(url, 1280, 800, "/#assistant", colorScheme);
    const b = await open(bareUrl, 1280, 800, "/#assistant", colorScheme);
    const [withLib, without] = [await snap(a.page), await snap(b.page)];
    const keys = Object.keys(without).filter((k) => k in withLib);
    assert.ok(keys.length > 200, `compared enough elements (${keys.length})`);
    const differ = keys.filter((k) => withLib[k] !== without[k]);
    assert.deepEqual(differ, [], `identical outside .pico in ${colorScheme}`);
    // The library really did load (inside .pico it does change things).
    assert.notEqual(await a.page.$eval("#navproject", (s: HTMLElement) => getComputedStyle(s).backgroundImage), "none");
    assert.equal(await b.page.$eval("#navproject", (s: HTMLElement) => getComputedStyle(s).backgroundImage), "none");
    assert.deepEqual(a.foreign, [], "no request leaves ORBIT");
    assert.deepEqual(a.errors, []);
    await a.ctx.close(); await b.ctx.close();
  }
});

test("browser: the dropdowns (Projects and the Jobs filters) draw Pico's chevron with room on its right, and the text keeps clear of it", { skip }, async () => {
  for (const colorScheme of ["light", "dark"]) {
    const { page, ctx } = await open(url, 1280, 800, "/#jobs", colorScheme);
    await page.waitForSelector("#jobf-state");
    for (const sel of ["#navproject", "#jobf-state", "#jobf-routine"]) {
      const s = await page.$eval(sel, (e: HTMLElement) => { const c = getComputedStyle(e); return { img: c.backgroundImage, x: c.backgroundPositionX, size: c.backgroundSize, pr: parseFloat(c.paddingRight), pl: parseFloat(c.paddingLeft), appearance: c.appearance, h: e.getBoundingClientRect().height }; });
      assert.match(s.img, /^url\("data:image\/svg\+xml/, `${sel}: Pico's chevron (${colorScheme})`);
      assert.equal(s.appearance, "none", `${sel}: no native arrow under it`);
      assert.match(s.x, /^(right 10px|calc\(100% - 10px\))$/, `${sel}: the chevron sits 10px in from the right edge, not flush (${s.x})`);
      assert.ok(s.pr >= 30 && s.pr >= s.pl + 16, `${sel}: the text stops before the chevron (padding ${s.pl} / ${s.pr})`);
      assert.ok(s.h >= 31, `${sel}: a full control height (${s.h})`);
    }
    await ctx.close();
  }
});

test("browser: the two menus are one component: the same card, a group label, plain rows and the current choice marked the same way", { skip }, async () => {
  const { page, ctx } = await open(url, 1280, 800, "/sessions");
  await page.waitForFunction(() => !document.getElementById("sesswrap")!.hidden);
  await page.click("#sessbtn");
  await page.waitForFunction(() => document.querySelectorAll("#sesslist .sitem").length === 2);
  const card = (sel: string) => page.$eval(sel, (e: HTMLElement) => { const c = getComputedStyle(e); return [c.backgroundColor, c.borderTopColor, c.borderTopLeftRadius, c.boxShadow, c.paddingTop].join("|"); });
  const sess = await card("#sesspicker");
  const row = await page.$eval("#sesslist .sitem", (e: HTMLElement) => { const c = getComputedStyle(e); return { pl: c.paddingLeft, radius: c.borderTopLeftRadius, border: c.borderTopWidth, bg: c.backgroundColor }; });
  const label = await page.$eval("#pcurlabel", (e: HTMLElement) => { const c = getComputedStyle(e); return [c.textTransform, c.fontSize, c.color].join("|"); });
  // Show archived is Pico's checkbox: drawn by the library, square-cornered, in ORBIT's colours.
  const box = await page.$eval("#tshowarch", (e: HTMLElement) => { const c = getComputedStyle(e); return { appearance: c.appearance, radius: c.borderTopLeftRadius, w: c.width }; });
  assert.deepEqual(box, { appearance: "none", radius: "4px", w: "16px" });
  assert.equal(row.border, "0px");
  assert.equal(row.bg, "rgba(0, 0, 0, 0)", "rows have no box of their own");
  await page.keyboard.press("Escape");
  await page.click("#themebtn");
  await page.waitForFunction(() => !document.getElementById("themepicker")!.hidden);
  assert.equal(await card("#themepicker"), sess, "the theme menu is the same card");
  const legend = await page.$eval("#themepicker legend", (e: HTMLElement) => { const c = getComputedStyle(e); return [c.textTransform, c.fontSize, c.color].join("|"); });
  assert.equal(legend, label, "the same group label");
  const topt = await page.$eval(".topt", (e: HTMLElement) => { const c = getComputedStyle(e); return { radius: c.borderTopLeftRadius, w: e.getBoundingClientRect().width, parent: e.parentElement!.getBoundingClientRect().width }; });
  assert.equal(topt.radius, row.radius);
  assert.ok(Math.abs(topt.w - topt.parent) < 1, "a theme row spans the menu (Pico's labels shrink to their text; these do not)");
  const radio = await page.$eval('.topt input[value="system"]', (e: HTMLElement) => { const c = getComputedStyle(e); return { appearance: c.appearance, radius: c.borderTopLeftRadius }; });
  assert.deepEqual(radio, { appearance: "none", radius: "50%" }, "Pico's radio");
  assert.equal(await page.$eval(".topt:has(input:checked)", (e: HTMLElement) => getComputedStyle(e).fontWeight), "600", "the current choice is bold, as the open session is");
  await ctx.close();
});

test("browser: the side panel's lists (services, notifications) are flat rows with hairlines; no gold edge or tint on each note", { skip }, async () => {
  const { page, ctx } = await open(url, 1440, 900);
  await page.click("#sidetab-notes");
  await page.waitForFunction(() => document.querySelectorAll("#inbox .note").length > 1);
  const notes = await page.$$eval("#inbox .note", (ns: HTMLElement[]) => ns.slice(0, 2).map((n) => { const c = getComputedStyle(n); return { left: c.borderLeftWidth, top: c.borderTopWidth, bg: c.backgroundColor }; }));
  assert.deepEqual(notes[0], { left: "0px", top: "0px", bg: "rgba(0, 0, 0, 0)" });
  assert.deepEqual(notes[1], { left: "0px", top: "1px", bg: "rgba(0, 0, 0, 0)" }, "a hairline between notes");
  await page.click("#sidetab-status");
  await page.waitForFunction(() => document.querySelectorAll("#ports .pill").length > 0);
  // Each service is one row: the name on the left, its state on the right; the text is still "model: live".
  const rows = await page.$$eval("#ports .pill", (ps: HTMLElement[]) => ps.map((p) => {
    const n = p.querySelector(".pname")!.getBoundingClientRect(), s = p.querySelector(".pstate")!.getBoundingClientRect(), r = p.getBoundingClientRect();
    return { text: p.textContent, stateRight: r.right - s.right < 16, nameLeft: n.left - r.left < 32 };
  }));
  assert.deepEqual(rows.map((r: { text: string }) => r.text), ["model: live", "vault: live", "jobs: degraded"]);
  assert.ok(rows.every((r: { stateRight: boolean; nameLeft: boolean }) => r.stateRight && r.nameLeft));
  const labels = await page.$$eval("#statusline .sidelabel", (ls: HTMLElement[]) => ls.map((l) => l.textContent));
  assert.deepEqual(labels, ["Services", "Release"]);
  await ctx.close();
});
