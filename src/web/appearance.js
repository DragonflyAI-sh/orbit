// ORBIT's appearance settings (docs/appearance.md): a look (preset) and three bounded overrides (accent colour, UI font, text
// size), kept per browser in localStorage ("orbit.appearance", versioned JSON) and nowhere else. Loaded in <head>, before the
// stylesheet, so the saved look is on <html> before the body is parsed (no flash); the Appearance dialog is wired later by the
// page (OrbitAppearance.mount). Nothing here downloads anything: the presets are CSS blocks in index.html, the fonts are
// stacks of faces already on the device, and an accent is a #rrggbb colour checked for contrast before it is used. Anything
// unreadable, unknown or out of range (a hand-edited or older stored value, blocked storage) falls back to the default for
// that one setting, so the page always renders, and with no stored value it is exactly today's look.
(function (global) {
  "use strict";

  const KEY = "orbit.appearance", VERSION = 1, THEME_KEY = "orbit.theme";

  // ---- The looks. Each non-Classic preset is a CSS block `:root[data-preset="<id>"]` in index.html with the full palette
  // (and its syntax colours); `scheme` is the colour scheme it is drawn for (it also sets data-theme, so native controls and
  // every theme-aware rule follow). `cards` and `bgs` are the surfaces an accent must stay visible on (3:1); Classic can show
  // either of its themes (the header's Light, Dark or System), so an accent there must suit both. `swatch` is shown next to
  // the name (page, card, accent). A test checks these colours against the CSS. How to add one: docs/appearance.md.
  const PRESETS = {
    classic: { name: "Classic", note: "Today's look. Light, Dark or System from the theme menu.", scheme: null,
      cards: ["#fdfcff", "#11142b"], bgs: ["#f4f2fb", "#080a1a"], themeColor: null, swatch: ["#f4f2fb", "#6d4fd8", "#080a1a"] },
    warm: { name: "Warm light", note: "Cream paper, brown ink and a terracotta accent.", scheme: "light",
      cards: ["#fffcf6"], bgs: ["#f5efe4"], themeColor: "#f5efe4", swatch: ["#f5efe4", "#a5481f", "#2b2119"] },
    cool: { name: "Cool dark", note: "Slate and teal, easy on the eyes in low light.", scheme: "dark",
      cards: ["#132024"], bgs: ["#0b1316"], themeColor: "#0b1316", swatch: ["#0b1316", "#3fb8ad", "#dde9ec"] },
  };
  // ---- UI fonts: faces that are already on the device (nothing is downloaded, no font files). Each stack ends in a generic family, so
  // something always renders. Code and the editor keep --font-mono whatever is chosen here.
  const FONTS = {
    system: { name: "System (default)", stack: null },
    humanist: { name: "Humanist sans", stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif' },
    rounded: { name: "Rounded", stack: 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", "Arial Rounded MT Bold", Calibri, source-sans-pro, sans-serif' },
    grotesque: { name: "Neo-grotesque", stack: 'Inter, Roboto, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif' },
    serif: { name: "Serif", stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, "Noto Serif", "DejaVu Serif", Georgia, serif' },
  };
  // ---- Text size: one multiplier on the type scale (--text-scale), bounded to these steps.
  const SIZES = {
    small: { name: "Small (90%)", scale: 0.9 },
    default: { name: "Default (100%)", scale: 1 },
    large: { name: "Large (110%)", scale: 1.1 },
    larger: { name: "Larger (120%)", scale: 1.2 },
  };
  // ---- Accent swatches: each keeps 3:1 on every preset's cards and page, so any of them is safe with any look (tested).
  // "" is the preset's own accent (no override). A custom colour is allowed when it passes the same check for the look.
  const ACCENTS = [
    { id: "", name: "Look's own" },
    { id: "#3d7fe0", name: "Blue" },
    { id: "#1f9a8a", name: "Teal" },
    { id: "#3c9a4a", name: "Green" },
    { id: "#c07a10", name: "Amber" },
    { id: "#d0567e", name: "Rose" },
  ];
  const DEFAULTS = Object.freeze({ preset: "classic", accent: "", font: "system", size: "default" });
  const MIN_UI = 3, MIN_TEXT = 4.5;
  const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

  // ---- Colour arithmetic (WCAG 2 relative luminance and contrast) for #rrggbb.
  const HEX = /^#[0-9a-f]{6}$/;
  function normHex(v) {
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase();
    return HEX.test(s) ? s : null;
  }
  function luminance(hex) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // The label colour for text on the accent (primary buttons, the user's avatar): white or ORBIT's ink, whichever reads at
  // 4.5:1, else pure black (some colour always reaches 4.5:1 against white or black).
  function onAccent(hex) {
    for (const c of ["#ffffff", "#0b0d1f", "#000000"]) if (contrast(hex, c) >= MIN_TEXT) return c;
    return contrast(hex, "#ffffff") >= contrast(hex, "#000000") ? "#ffffff" : "#000000";
  }
  // Can this accent be used with this look? It must stand out (3:1) from every card and page the look can show, since
  // checked controls, current-row marks and progress bars are drawn in it. The label colour is then chosen to fit.
  function checkAccent(accent, presetId) {
    const hex = normHex(accent);
    if (!hex) return { ok: false, message: "Use a colour written as #rrggbb." };
    const p = PRESETS[own(PRESETS, presetId) ? presetId : "classic"];
    let worst = Infinity, where = "", light = false;
    for (const [list, kind] of [[p.cards, "cards"], [p.bgs, "page"]]) {
      for (const s of list) {
        const r = contrast(hex, s), tone = luminance(s) > 0.5 ? "light" : "dark";
        if (r < worst) { worst = r; light = tone === "light"; where = kind === "cards" ? `${tone} cards` : `the ${tone} page`; }
      }
    }
    if (worst < MIN_UI) {
      const fix = light ? "a darker" : "a lighter";
      const both = p.cards.length > 1 ? " Classic can be light or dark, so its accent has to suit both." : "";
      return { ok: false, ratio: worst, message: `Too faint on ${where} (${worst.toFixed(1)}:1, needs ${MIN_UI}:1). Pick ${fix} shade.${both}` };
    }
    return { ok: true, ratio: worst, hex, on: onAccent(hex), message: "" };
  }

  // ---- Validation. Every field is checked on its own; a bad one becomes its default and is reported, the rest are kept.
  function normalize(raw) {
    const prefs = { ...DEFAULTS }, problems = [];
    if (raw === null || raw === undefined) return { prefs, problems };
    if (typeof raw !== "object" || Array.isArray(raw)) return { prefs, problems: ["not a settings object"] };
    if (raw.v !== undefined && raw.v !== VERSION) return { prefs, problems: [`unknown version ${String(raw.v).slice(0, 20)}`] };
    if (raw.preset !== undefined) { if (own(PRESETS, raw.preset)) prefs.preset = raw.preset; else problems.push("unknown look"); }
    if (raw.font !== undefined) { if (own(FONTS, raw.font)) prefs.font = raw.font; else problems.push("unknown font"); }
    if (raw.size !== undefined) { if (own(SIZES, raw.size)) prefs.size = raw.size; else problems.push("unknown text size"); }
    if (raw.accent !== undefined && raw.accent !== "") {
      const c = checkAccent(raw.accent, prefs.preset);
      if (c.ok) prefs.accent = c.hex; else problems.push("unusable accent");
    }
    return { prefs, problems };
  }
  function parse(text) {
    if (text === null || text === undefined || text === "") return { prefs: { ...DEFAULTS }, problems: [] };
    let raw;
    try { raw = JSON.parse(String(text)); } catch { return { prefs: { ...DEFAULTS }, problems: ["not JSON"] }; }
    return normalize(raw);
  }
  const isDefault = (p) => Object.keys(DEFAULTS).every((k) => p[k] === DEFAULTS[k]);
  const same = (a, b) => Object.keys(DEFAULTS).every((k) => a[k] === b[k]);
  function serialize(prefs) {
    const p = normalize(prefs).prefs;
    return JSON.stringify({ v: VERSION, preset: p.preset, accent: p.accent, font: p.font, size: p.size });
  }
  // Storage may be missing or throw (private mode, blocked site data): the defaults, said so.
  function read(storage) {
    let text = null;
    try { text = storage ? storage.getItem(KEY) : null; } catch { return { prefs: { ...DEFAULTS }, problems: ["storage unavailable"] }; }
    return parse(text);
  }
  // Saving the defaults removes the key, so a reset browser stores nothing (as before this feature). True when stored.
  function write(storage, prefs) {
    try {
      if (!storage) return false;
      const p = normalize(prefs).prefs;
      if (isDefault(p)) storage.removeItem(KEY); else storage.setItem(KEY, serialize(p));
      return true;
    } catch { return false; }
  }
  function themeMode(storage) {
    try { const t = storage ? storage.getItem(THEME_KEY) : null; return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; }
  }

  // ---- Applying a look to <html>. A preset sets data-preset and its scheme as data-theme; Classic removes data-preset and
  // gives data-theme back to the header's choice (Light, Dark or none for System). Overrides are inline custom properties on
  // <html>, removed when not set, so the stylesheet's values are untouched underneath.
  let current = { ...DEFAULTS };
  function apply(root, prefs, storage) {
    const p = normalize(prefs).prefs;
    const preset = PRESETS[p.preset];
    if (p.preset === "classic") root.removeAttribute("data-preset"); else root.setAttribute("data-preset", p.preset);
    const mode = themeMode(storage);
    const theme = preset.scheme || (mode === "system" ? null : mode);
    if (theme) root.setAttribute("data-theme", theme); else root.removeAttribute("data-theme");
    const st = root.style;
    const acc = p.accent ? checkAccent(p.accent, p.preset) : null;
    if (acc && acc.ok) {
      st.setProperty("--accent", acc.hex); st.setProperty("--on-accent", acc.on); st.setProperty("--accent-end", acc.hex);
    } else { st.removeProperty("--accent"); st.removeProperty("--on-accent"); st.removeProperty("--accent-end"); }
    if (FONTS[p.font].stack) st.setProperty("--font-sans", FONTS[p.font].stack); else st.removeProperty("--font-sans");
    if (SIZES[p.size].scale !== 1) st.setProperty("--text-scale", String(SIZES[p.size].scale)); else st.removeProperty("--text-scale");
    const doc = root.ownerDocument;
    if (doc && preset.themeColor) for (const m of doc.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", preset.themeColor);
    current = p;
    return p;
  }
  // The colour scheme the current look fixes (a preset), or null for Classic (the header's choice decides).
  const scheme = () => PRESETS[current.preset].scheme;
  const presetName = () => PRESETS[current.preset].name;
  function announce(doc) {
    try { doc.dispatchEvent(new CustomEvent("orbit:appearance", { detail: { ...current } })); } catch { /* no CustomEvent: nothing listens */ }
  }

  // ---- The Appearance dialog (index.html, #appearance). Every change is shown at once on the page (a live preview); Save
  // stores it in this browser, Cancel (or Escape) puts back what was saved, Reset to defaults shows the defaults (Save keeps
  // them). Opened from the theme menu's Appearance… row. Returns { open } for the page.
  function mount(opts) {
    const doc = opts.document || global.document, storage = opts.storage === undefined ? safeStorage() : opts.storage;
    const root = doc.documentElement, dlg = doc.getElementById("appearance");
    if (!dlg || typeof dlg.showModal !== "function") return null;
    const form = dlg.querySelector("form"), $ = (id) => doc.getElementById(id);
    const looks = $("aplooks"), accents = $("apaccents"), custom = $("apcustom"), fontSel = $("apfont"), sizeSel = $("apsize");
    const msg = $("apaccentmsg"), note = $("apnote"), saveBtn = $("apsave");
    let saved = read(storage).prefs, pending = { ...saved }, customHex = saved.accent && !ACCENTS.some((a) => a.id === saved.accent) ? saved.accent : "#3d7fe0";
    let returnTo = null;

    // Options are built from the tables above, so adding a preset, font or size needs no markup change.
    const el = (tag, attrs, text) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); if (text) e.textContent = text; return e; };
    for (const [id, p] of Object.entries(PRESETS)) {
      const lab = el("label", { class: "apopt" }), r = el("input", { type: "radio", name: "aplook", value: id });
      const chips = el("span", { class: "apchips", "aria-hidden": "true" });
      chips.style.background = `linear-gradient(90deg, ${p.swatch[0]} 0 34%, ${p.swatch[1]} 0 67%, ${p.swatch[2]} 0)`;
      const txt = el("span", { class: "aptext" }, p.name); txt.append(el("small", {}, p.note));
      lab.append(r, chips, txt); looks.append(lab);
    }
    for (const a of ACCENTS) {
      const lab = el("label", { class: "apopt apsw" }), r = el("input", { type: "radio", name: "apaccent", value: a.id });
      const chip = el("span", { class: "apchip", "aria-hidden": "true" }); if (a.id) chip.style.background = a.id; else chip.classList.add("apown");
      lab.append(r, chip, el("span", {}, a.name)); accents.insertBefore(lab, $("apcustomrow"));
    }
    for (const [id, f] of Object.entries(FONTS)) { const o = el("option", { value: id }, f.name); if (f.stack) o.style.fontFamily = f.stack; fontSel.append(o); }
    for (const [id, s] of Object.entries(SIZES)) sizeSel.append(el("option", { value: id }, s.name));

    const radios = (name) => [...form.querySelectorAll(`input[name="${name}"]`)];
    let invalid = false;
    function fill() {
      for (const r of radios("aplook")) r.checked = r.value === pending.preset;
      const known = ACCENTS.some((a) => a.id === pending.accent);
      for (const r of radios("apaccent")) r.checked = known ? r.value === pending.accent : r.value === "custom";
      custom.value = known ? customHex : pending.accent;
      fontSel.value = pending.font; sizeSel.value = pending.size;
    }
    // Reads the form into `pending` and previews it. A custom colour that would be unreadable is explained, not used, and
    // Save is off until it is fixed (another colour, a swatch or another look).
    function update() {
      const look = radios("aplook").find((r) => r.checked), acc = radios("apaccent").find((r) => r.checked);
      pending.preset = look ? look.value : DEFAULTS.preset;
      pending.font = own(FONTS, fontSel.value) ? fontSel.value : DEFAULTS.font;
      pending.size = own(SIZES, sizeSel.value) ? sizeSel.value : DEFAULTS.size;
      let accent = acc ? acc.value : "";
      if (accent === "custom") { customHex = normHex(custom.value) || customHex; accent = customHex; }
      const c = accent ? checkAccent(accent, pending.preset) : { ok: true };
      invalid = !c.ok;
      pending.accent = c.ok ? (accent ? c.hex : "") : "";
      custom.setAttribute("aria-invalid", invalid ? "true" : "false");
      msg.textContent = invalid ? `${c.message} The look's own accent is shown meanwhile.` : "";
      msg.hidden = !invalid;
      saveBtn.disabled = invalid;
      apply(root, pending, storage);
      announce(doc);
    }
    function setNote(text, alert) { note.textContent = text; note.classList.toggle("aperr", Boolean(alert)); note.setAttribute("role", alert ? "alert" : "status"); }

    function open(from) {
      returnTo = from || doc.activeElement;
      saved = read(storage).prefs; pending = { ...saved };
      if (saved.accent && !ACCENTS.some((a) => a.id === saved.accent)) customHex = saved.accent;
      fill(); update(); setNote("", false);
      dlg.showModal();
      const first = radios("aplook").find((r) => r.checked) || radios("aplook")[0];
      if (first) first.focus();
    }
    function finish() {
      if (dlg.open) dlg.close();
      if (returnTo && typeof returnTo.focus === "function" && doc.contains(returnTo)) returnTo.focus();
      returnTo = null;
    }
    function cancel() { pending = { ...saved }; apply(root, saved, storage); announce(doc); finish(); }

    form.addEventListener("change", (e) => { if (e.target === custom) { const r = radios("apaccent").find((x) => x.value === "custom"); if (r) r.checked = true; } update(); });
    custom.addEventListener("input", () => { const r = radios("apaccent").find((x) => x.value === "custom"); if (r) r.checked = true; update(); });
    form.addEventListener("submit", (e) => e.preventDefault());
    $("apcancel").addEventListener("click", cancel);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); cancel(); });
    $("apreset").addEventListener("click", () => {
      pending = { ...DEFAULTS }; fill(); update();
      setNote(isDefault(saved) ? "These are the defaults." : "Defaults shown. Save to keep them, or Cancel to go back.", false);
    });
    saveBtn.addEventListener("click", () => {
      update();
      if (invalid) return;
      if (!write(storage, pending)) { setNote("Not saved: this browser is blocking storage. The look stays on this page until you reload or press Cancel.", true); return; }
      saved = { ...pending };
      finish();
    });
    // Another tab saved a look: show it here too, unless this tab is in the middle of choosing one.
    global.addEventListener("storage", (e) => {
      if (e.key !== KEY && e.key !== null) return;
      saved = read(storage).prefs;
      if (!dlg.open) { pending = { ...saved }; apply(root, saved, storage); announce(doc); }
    });
    return { open, close: cancel, isOpen: () => dlg.open };
  }
  function safeStorage() { try { return global.localStorage; } catch { return null; } }

  // ---- Before the first paint: the saved look, or today's look when there is none or it cannot be read.
  function boot() {
    const doc = global.document;
    if (!doc || !doc.documentElement) return;
    const storage = safeStorage();
    apply(doc.documentElement, read(storage).prefs, storage);
  }

  global.OrbitAppearance = { KEY, VERSION, PRESETS, FONTS, SIZES, ACCENTS, DEFAULTS, normalize, parse, serialize, read, write, checkAccent, contrast, onAccent,
    apply, scheme, presetName, mount, isDefault, same, current: () => ({ ...current }) };
  boot();
})(typeof window !== "undefined" ? window : globalThis);
