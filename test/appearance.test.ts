import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { rig } from "./threads-fixture.ts";

// Appearance settings (docs/appearance.md): src/web/appearance.js's pure parts (validation, storage, the accent check, applying
// a look to <html>) run here in a plain VM context with fake storage and a fake element; the CSS for each look and the page's
// wiring are checked against the markup; the real server serves the script. The page itself is checked in
// test/appearance-browser.test.ts. Synthetic values only.

/* eslint-disable @typescript-eslint/no-explicit-any */
const src = readFileSync(new URL("../src/web/appearance.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

// A storage double: a Map, or one whose every call throws (blocked site data, some private modes).
function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
}
const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); }, removeItem() { throw new Error("SecurityError"); } };
// The smallest <html> the apply step needs: attributes, an inline style with custom properties, and meta tags to recolour.
function fakeRoot() {
  const attrs = new Map<string, string>(), props = new Map<string, string>();
  const metas = [{ c: "", setAttribute(_k: string, v: string) { this.c = v; } }, { c: "", setAttribute(_k: string, v: string) { this.c = v; } }];
  const root: any = {
    attrs, props, metas,
    setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k), getAttribute: (k: string) => attrs.get(k) ?? null,
    style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) },
    ownerDocument: { querySelectorAll: () => metas },
  };
  return root;
}
// Loads the script as the page does. With `storage`, the boot step reads it (window.localStorage), as in <head>.
function load(storage: unknown = null, root = fakeRoot()) {
  const win: any = { document: { documentElement: root }, addEventListener() {} };
  Object.defineProperty(win, "localStorage", { get() { if (storage === "throws") throw new Error("SecurityError"); return storage; } });
  const ctx = vm.createContext({ window: win });
  vm.runInContext(src, ctx);
  return { A: win.OrbitAppearance, root };
}
const { A } = load();
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const DEFAULTS = { preset: "classic", accent: "", font: "system", size: "default" };

test("defaults: Classic, the look's own accent, the system font and 100% text; nothing stored means exactly that", () => {
  assert.deepEqual(plain(A.DEFAULTS), DEFAULTS);
  assert.deepEqual(plain(A.parse(null)), { prefs: DEFAULTS, problems: [] });
  assert.deepEqual(plain(A.read(memStorage())), { prefs: DEFAULTS, problems: [] });
  assert.equal(A.PRESETS.classic.scheme, null, "Classic leaves Light, Dark or System to the theme menu");
  assert.equal(A.FONTS.system.stack, null, "the default font changes nothing");
  assert.equal(A.SIZES.default.scale, 1);
  assert.equal(A.KEY, "orbit.appearance");
  assert.equal(A.VERSION, 1);
});

test("validation: each setting is checked on its own; anything unknown, malformed or out of range falls back to its default", () => {
  const ok = { v: 1, preset: "warm", accent: "#3D7FE0", font: "serif", size: "large" };
  assert.deepEqual(plain(A.normalize(ok)), { prefs: { preset: "warm", accent: "#3d7fe0", font: "serif", size: "large" }, problems: [] }, "a colour is kept lower-case");
  // One bad field does not cost the others.
  assert.deepEqual(plain(A.normalize({ ...ok, preset: "neon" })).prefs, { preset: "classic", accent: "#3d7fe0", font: "serif", size: "large" });
  assert.deepEqual(plain(A.normalize({ ...ok, font: "Comic Sans" })).prefs.font, "system");
  assert.deepEqual(plain(A.normalize({ ...ok, size: "huge" })).prefs.size, "default");
  assert.deepEqual(plain(A.normalize({ ...ok, size: 3 })).prefs.size, "default");
  for (const accent of ["red", "#fff", "#12345", "#1234567", "url(x)", "#3d7fe0; color: red", 42, null]) {
    const r = A.normalize({ ...ok, accent });
    assert.equal(r.prefs.accent, "", `accent ${String(accent)} is refused`);
    assert.deepEqual(plain(r.problems), ["unusable accent"]);
  }
  // Not a settings object, a future version, or not JSON at all: the defaults, said so.
  for (const raw of [[], "warm", 7, true]) assert.deepEqual(plain(A.normalize(raw)).prefs, DEFAULTS, `${JSON.stringify(raw)}`);
  assert.deepEqual(plain(A.normalize({ v: 2, preset: "warm" })), { prefs: DEFAULTS, problems: ["unknown version 2"] });
  assert.deepEqual(plain(A.parse("{not json")), { prefs: DEFAULTS, problems: ["not JSON"] });
  assert.deepEqual(plain(A.parse('{"v":1,"preset":"cool"}')).prefs, { ...DEFAULTS, preset: "cool" }, "missing fields are defaults");
  // Prototype keys are not settings.
  for (const k of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
    assert.deepEqual(plain(A.normalize({ preset: k, font: k, size: k })).prefs, DEFAULTS, k);
  }
});

test("storage: saved per browser as versioned JSON; the defaults store nothing; blocked or broken storage never throws", () => {
  const s = memStorage();
  assert.equal(A.write(s, { preset: "cool", accent: "#c07a10", font: "rounded", size: "small" }), true);
  assert.deepEqual(JSON.parse(s.m.get("orbit.appearance")!), { v: 1, preset: "cool", accent: "#c07a10", font: "rounded", size: "small" });
  assert.deepEqual(plain(A.read(s)), { prefs: { preset: "cool", accent: "#c07a10", font: "rounded", size: "small" }, problems: [] }, "round trip");
  // Saving the defaults (Reset, then Save) removes the key: the browser is back to storing nothing.
  assert.equal(A.write(s, DEFAULTS), true);
  assert.equal(s.m.has("orbit.appearance"), false);
  // Junk written by hand is cleaned on the way in and on the way out.
  s.m.set("orbit.appearance", JSON.stringify({ v: 1, preset: "warm", accent: "javascript:alert(1)", font: "x", extra: "<script>" }));
  assert.deepEqual(plain(A.read(s).prefs), { ...DEFAULTS, preset: "warm" });
  assert.equal(A.write(s, { preset: "warm", extra: "<script>" }), true);
  assert.deepEqual(Object.keys(JSON.parse(s.m.get("orbit.appearance")!)), ["v", "preset", "accent", "font", "size"], "only known fields are written");
  // Blocked storage: the defaults on read, false on write, never an exception.
  assert.deepEqual(plain(A.read(blocked)), { prefs: DEFAULTS, problems: ["storage unavailable"] });
  assert.equal(A.write(blocked, { preset: "warm" }), false);
  assert.equal(A.write(null, { preset: "warm" }), false);
  assert.deepEqual(plain(A.read(null)).prefs, DEFAULTS);
});

test("accent: it must stand out 3:1 on every card and page the look can show, and its label colour reads at 4.5:1", () => {
  // Every swatch suits every look, so a swatch never has to be refused.
  for (const a of A.ACCENTS.filter((x: any) => x.id)) {
    for (const p of Object.keys(A.PRESETS)) {
      const c = A.checkAccent(a.id, p);
      assert.equal(c.ok, true, `${a.name} with ${p}: ${c.message}`);
      assert.ok(A.contrast(c.on, c.hex) >= 4.5, `${a.name}: its label colour reads on it`);
    }
  }
  // Too light for Classic's light cards, and the message says why and what to do.
  const pale = A.checkAccent("#f2c46d", "classic");
  assert.equal(pale.ok, false);
  assert.match(pale.message, /^Too faint on (light cards|the light page) \(\d\.\d:1, needs 3:1\)\. Pick a darker shade\. Classic can be light or dark/);
  // Too dark for Cool dark, fine for Warm light.
  const deep = A.checkAccent("#1c1838", "cool");
  assert.equal(deep.ok, false);
  assert.match(deep.message, /Too faint on (dark cards|the dark page) .*Pick a lighter shade\.$/);
  assert.equal(A.checkAccent("#1c1838", "warm").ok, true);
  // Classic accepts only colours that suit both of its themes.
  assert.equal(A.checkAccent("#1c1838", "classic").ok, false);
  assert.equal(A.checkAccent("#8b6cf0", "classic").ok, true);
  assert.match(A.checkAccent("blue", "classic").message, /#rrggbb/);
  // The label colour: white when it reads, else ORBIT's ink, else black; always 4.5:1 for any colour.
  for (let i = 0; i < 4096; i += 7) {
    const hex = "#" + [i >> 8, (i >> 4) & 15, i & 15].map((n) => (n * 17).toString(16).padStart(2, "0")).join("");
    assert.ok(A.contrast(A.onAccent(hex), hex) >= 4.5, hex);
  }
  assert.equal(A.onAccent("#1a1a6e"), "#ffffff");
  assert.equal(A.onAccent("#3fb8ad"), "#0b0d1f");
});

test("apply: a look sets data-preset and its scheme; overrides are inline properties, removed again; Classic gives the theme back", () => {
  const root = fakeRoot(), s = memStorage({ "orbit.theme": "dark" });
  A.apply(root, { preset: "warm", accent: "#3d7fe0", font: "serif", size: "larger" }, s);
  assert.equal(root.getAttribute("data-preset"), "warm");
  assert.equal(root.getAttribute("data-theme"), "light", "the look's scheme wins over the stored Dark");
  assert.equal(A.scheme(), "light");
  assert.equal(A.presetName(), "Warm light");
  assert.deepEqual(Object.fromEntries(root.props), { "--accent": "#3d7fe0", "--on-accent": A.onAccent("#3d7fe0"), "--accent-end": "#3d7fe0", "--font-sans": A.FONTS.serif.stack, "--text-scale": "1.2" });
  assert.deepEqual(root.metas.map((m: any) => m.c), ["#f5efe4", "#f5efe4"], "the browser's toolbar colour follows the look");
  // Back to Classic: nothing inline, no data-preset, and data-theme is the header's choice again.
  A.apply(root, DEFAULTS, s);
  assert.equal(root.getAttribute("data-preset"), null);
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(root.props.size, 0);
  assert.equal(A.scheme(), null);
  A.apply(root, DEFAULTS, memStorage());
  assert.equal(root.getAttribute("data-theme"), null, "System: no data-theme, as before");
  // An accent that does not suit the look (a hand-edited value) is not applied: the look's own accent shows.
  A.apply(root, { preset: "cool", accent: "#1c1838" }, s);
  assert.equal(root.props.has("--accent"), false);
  assert.equal(root.getAttribute("data-theme"), "dark");
});

test("boot: the saved look is applied when the script loads; unreadable or blocked storage leaves today's look", () => {
  const saved = memStorage({ "orbit.appearance": JSON.stringify({ v: 1, preset: "cool", size: "large" }) });
  const a = load(saved);
  assert.equal(a.root.getAttribute("data-preset"), "cool");
  assert.equal(a.root.getAttribute("data-theme"), "dark");
  assert.equal(a.root.props.get("--text-scale"), "1.1");
  for (const storage of ["throws", blocked, memStorage({ "orbit.appearance": "{{" }), memStorage({ "orbit.appearance": '{"v":9,"preset":"cool"}' })]) {
    const b = load(storage);
    assert.equal(b.root.getAttribute("data-preset"), null);
    assert.equal(b.root.props.size, 0);
  }
  // The theme menu's stored choice still applies under Classic.
  const c = load(memStorage({ "orbit.theme": "light" }));
  assert.equal(c.root.getAttribute("data-theme"), "light");
});

test("each look has its CSS block, and the colours the accent check uses are the ones the CSS draws", () => {
  const hexOf = (block: string, name: string) => block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))?.[1];
  const light = css.match(/:root \{\s*color-scheme: light;([^}]*)\}/)![1]!;
  const dark = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)![1]!;
  assert.deepEqual([...A.PRESETS.classic.cards], [hexOf(light, "--card"), hexOf(dark, "--card")]);
  assert.deepEqual([...A.PRESETS.classic.bgs], [hexOf(light, "--bg"), hexOf(dark, "--bg")]);
  for (const [id, p] of Object.entries<any>(A.PRESETS)) {
    if (id === "classic") continue;
    const block = css.match(new RegExp(`:root\\[data-preset="${id}"\\] \\{([^}]*)\\}`))?.[1];
    assert.ok(block, `${id} has a :root[data-preset="${id}"] block`);
    assert.match(block!, new RegExp(`color-scheme: ${p.scheme};`), `${id}: its colour scheme matches`);
    for (const t of ["--bg", "--bg-glow", "--fg", "--muted", "--line", "--card", "--accent", "--accent-2", "--on-accent", "--live", "--mock", "--down", "--gold", "--header-shadow"]) {
      assert.match(block!, new RegExp(`\\s${t}:`), `${id} sets ${t}`);
    }
    assert.deepEqual([...p.cards], [hexOf(block!, "--card")], `${id}: card`);
    assert.deepEqual([...p.bgs], [hexOf(block!, "--bg")], `${id}: page`);
    assert.equal(p.themeColor, hexOf(block!, "--bg"), `${id}: toolbar colour is its page colour`);
    assert.ok(["light", "dark"].includes(p.scheme));
    // The look comes after Classic's theme blocks, so it wins at equal specificity.
    assert.ok(css.indexOf(`:root[data-preset="${id}"]`) > css.indexOf(':root[data-theme="dark"] {'));
  }
  // Every look's preset name is unique and short enough for the header button's name.
  const names = Object.values<any>(A.PRESETS).map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test("fonts and sizes are bounded: device fonts only, each stack ends in a generic family, code stays monospace", () => {
  for (const [id, f] of Object.entries<any>(A.FONTS)) {
    if (!f.stack) continue;
    assert.match(f.stack, /, (sans-serif|serif)$/, `${id} ends in a generic family`);
    assert.doesNotMatch(f.stack, /url\(|@import|monospace|[;{}]/, `${id} is a plain font stack`);
  }
  assert.doesNotMatch(src, /@font-face|fonts\.googleapis|fonts\.gstatic|\.woff2?\b|https?:\/\//i, "nothing is downloaded");
  const scales = Object.values<any>(A.SIZES).map((s) => s.scale);
  assert.ok(Math.min(...scales) >= 0.9 && Math.max(...scales) <= 1.2, `text size stays within 90-120% (${scales})`);
  // The type scale reads --text-scale; the monospace stack is still written once and never scaled away from monospace.
  for (const [t, px] of [["--text-2xs", 11], ["--text-xs", 12], ["--text-sm", 13], ["--text-ui", 14], ["--text-md", 15], ["--text-lg", 17], ["--text-xl", 20]] as const) {
    assert.match(css, new RegExp(`${t}: calc\\(${px}px \\* var\\(--text-scale\\)\\)`), t);
  }
  assert.match(css, /--text-scale: 1;/);
  assert.equal(css.match(/ui-monospace/g)?.length, 1);
});

test("markup: the script loads in <head> before the stylesheet; the theme menu opens an accessible Appearance dialog", () => {
  const head = html.slice(0, html.indexOf("</head>"));
  const at = head.indexOf('<script src="/appearance.js"></script>');
  assert.ok(at > head.indexOf('localStorage.getItem("orbit.theme")') && at < head.indexOf("<style>"), "after the theme script, before the stylesheet: no flash");
  assert.match(html, /<div class="tmore"><button type="button" id="appearancebtn" aria-haspopup="dialog" aria-controls="appearance">/);
  assert.match(html, /<dialog id="appearance" class="pico" aria-labelledby="aptitle" aria-describedby="apdesc"><form method="dialog" novalidate><h2 id="aptitle">Appearance<\/h2>/);
  for (const id of ["aplooks", "apaccents", "apcustom", "apaccentmsg", "apfont", "apsize", "apnote", "apreset", "apcancel", "apsave"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<label for="apfont">UI font<\/label><select id="apfont">/);
  assert.match(html, /<label for="apsize">Text size<\/label><select id="apsize">/);
  assert.match(html, /<input type="color" id="apcustom" value="#3d7fe0" aria-label="Custom accent colour" aria-describedby="apaccentmsg">/);
  // The page mounts it from the theme menu, and the menu follows a look's scheme.
  assert.match(html, /const appearance = A && A\.mount \? A\.mount\(\{\}\) : null;/);
  assert.match(html, /document\.addEventListener\("orbit:appearance", apply\);/);
  // The gradient's second stop is a token, so a custom accent can replace it.
  assert.doesNotMatch(css, /var\(--accent\), var\(--accent-2\)\)/);
  assert.match(css, /:root \{ --accent-end: var\(--accent-2\); \}/);
});

test("server: /appearance.js is served as a script with nosniff", async () => {
  const r = rig();
  try {
    await r.api("/status");
    const res = await fetch(`http://127.0.0.1:${(r.server.address() as { port: number }).port}/appearance.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await res.text(), src);
  } finally { r.close(); }
});
