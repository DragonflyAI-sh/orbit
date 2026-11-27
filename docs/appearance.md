# Appearance: looks, accent, font and text size

Rai can try other looks for the web page, adjust the accent colour, the UI font and the text size, and go back to today's look,
all from the page. Nothing here needs a code change, an account, the server's configuration or a deploy: the choice is kept in
this browser only.

Code: `src/web/appearance.js` (the looks, fonts, sizes and accent swatches; validation, storage, the accent check, applying a
look, the dialog), `src/web/index.html` (the CSS for each look, the type scale, the dialog's markup and styles, and the theme
menu's wiring), `src/server.ts` (`GET /appearance.js`). Tests: `test/appearance.test.ts`, `test/appearance-browser.test.ts`.
The Light, Dark and System themes it builds on are in [design-system.md](design-system.md), "Themes".

## Using it

- **Where:** the theme button in the header (the monitor, sun or moon on the right, on every width) opens the theme menu. Its
  last row, **Appearance…**, opens the dialog. On phones the dialog is a sheet along the bottom edge.
- **Look:** Classic (today's look; Light, Dark or System still come from the theme menu), Warm light (cream paper, brown ink,
  terracotta) and Cool dark (slate and teal). Each row shows three colour chips and a one-line description.
- **Accent colour:** the look's own, five swatches (Blue, Teal, Green, Amber, Rose), or Custom with the browser's colour picker.
- **UI font:** System (default), Humanist sans, Rounded, Neo-grotesque or Serif. Each is a stack of faces already on the device,
  ending in a generic family, so something always renders; which face you get depends on the device. Code, the editor and
  other monospace text keep the monospace face whatever is chosen.
- **Text size:** Small (90%), Default (100%), Large (110%) or Larger (120%). It scales the whole type scale.
- **Preview, Save, Cancel, Reset:** every change shows on the page at once. **Save** keeps it in this browser and closes the
  dialog. **Cancel** (or Escape) puts back what was saved. **Reset to defaults** shows today's look (Classic, the look's own
  accent, the system font, 100%) and says so; Save then keeps it, which removes the stored setting, and Cancel still goes back.
- **The theme menu while a look is on:** Warm light and Cool dark are drawn for one scheme, so Light, Dark and System are off
  (disabled, still visible) with a note: "Cool dark sets its own colours. Choose Classic in Appearance to use Light, Dark or
  System." The theme button names the look ("Theme: Cool dark (set in Appearance)") and shows a sun or moon for its scheme.

## Accent colours stay readable

An accent marks checked controls, current rows, the progress bars and the current tab, and fills primary buttons with a label
on it. So:

- An accent must reach **3:1** against every card and page colour the look can show. Classic can be light or dark (the theme
  menu can change it at any time), so a Classic accent has to suit both; Warm light only its light surfaces, Cool dark only
  its dark ones. All five swatches pass for every look (tested).
- A custom colour that fails is **not used**. The dialog says why and what to do, for example "Too faint on the light page
  (1.2:1, needs 3:1). Pick a darker shade. Classic can be light or dark, so its accent has to suit both. The look's own accent
  is shown meanwhile." The colour field is marked invalid, and Save is off until the colour, a swatch or the look changes.
  The same happens if the look changes under a custom accent that does not suit it.
- The **label colour** on the accent is chosen automatically: white if it reads at 4.5:1, else ORBIT's ink, else black (one of
  them always reaches 4.5:1). With a custom accent, primary buttons are filled with the accent alone (the gradient's second
  stop, `--accent-end`, becomes the accent), so the label is checked against one colour.
- **Text in the accent.** The user's own name in each message is drawn in the accent, and it is normal-size text, so it needs
  **4.5:1**, more than the 3:1 an accent must reach. The looks' own accents already reach 4.5:1 on their cards and pages. A
  custom accent (a swatch or your own colour) gets a text shade, `--accent-text`: the accent mixed with the theme's text
  colour (`color-mix(in srgb, <accent> N%, var(--fg))`), keeping as much of the accent (N, in steps of 5%) as still reads at
  4.5:1 on every card and page the look can show. Because `--fg` follows the theme, one value suits both of Classic's themes.
  Marks, controls and buttons keep the accent itself.
- Status colours (ok, warning, danger, waiting on Rai) are not affected by the accent, and keep their shapes and words, so
  status is never told by colour alone.

## Storage and safety

- Saved per browser in `localStorage` as `orbit.appearance`, versioned JSON: `{"v":1,"preset":"warm","accent":"#1f9a8a",
  "font":"serif","size":"larger"}`. Saving the defaults removes the key, so a browser that never chose anything (or chose
  Reset and Save) stores nothing, as before this feature. The theme menu's `orbit.theme` is unchanged and separate.
- Other open tabs follow a save at once (the `storage` event), unless that tab is in the middle of choosing in its own dialog.
- **Validation:** every field is checked on its own. An unknown look, font or size, a colour that is not `#rrggbb` or is
  unreadable for the look, another version, or text that is not JSON falls back to the default for that field only (or to
  all defaults for a wrong version or broken JSON). Only known fields are written back.
- **Blocked storage:** the page shows today's look, the dialog still previews, and Save says "Not saved: this browser is
  blocking storage. The look stays on this page until you reload or press Cancel." Nothing throws.
- **No flash:** `/appearance.js` is a small same-origin script loaded in `<head>`, after the theme script and before the
  stylesheet. It sets `data-preset`, `data-theme` and the inline overrides on `<html>` before the body is parsed.
- **No arbitrary CSS:** only these values reach the page, as custom properties on `<html>`: `--accent`, `--on-accent`,
  `--accent-end` (a checked `#rrggbb` and black, white or ink), `--accent-text` (that colour mixed with `var(--fg)` by a
  computed percentage), `--font-sans` (one of the listed stacks) and `--text-scale`
  (one of four numbers). Nothing is downloaded: no web font, no `@font-face`, no third-party request. The page's headers are
  unchanged; the new route sends the same `nosniff` and `no-cache` headers as `/files.js`.

## How it works

- `:root[data-preset="<id>"]` blocks in index.html hold each look's full palette (page, cards, text, muted, lines, both
  accents, status colours, the header's shadow) and its `color-scheme`. They come after Classic's Light and Dark blocks, so
  they win at the same specificity.
- Applying a look sets `data-preset` and also `data-theme` to the look's scheme (`light` or `dark`). Everything that already
  follows the theme follows the look: native controls (scrollbars, radios, selects, the editor's textarea), the syntax colours
  (`--tk-*`, the editor and Markdown code), the Plan's colours, the browser's toolbar colour. Classic removes `data-preset`
  and gives `data-theme` back to the theme menu's choice.
- Every component reads the semantic tokens (`--card`, `--fg`, `--info`, `--danger`...), so navigation, the conversation and
  composer, cards and menus, Plan, Files and the editor, and the Gallery's chrome change with no rules of their own. The
  photo viewer's dark overlay stays dark on purpose.
- The type scale is `calc(<px> * var(--text-scale))`, with `--text-scale: 1` by default, so the default sizes are exactly the
  old ones. A few fixed sizes (the wordmark, the 16px text fields on touch screens that stop iOS from zooming) are unchanged.

## Adding a look

1. In `src/web/index.html`, next to `:root[data-preset="warm"]`, add a block `:root[data-preset="<id>"] { color-scheme: light
   or dark; ... }` that sets every palette token the others set: `--bg`, `--bg-glow`, `--fg`, `--muted`, `--line`, `--card`,
   `--accent`, `--accent-2`, `--on-accent`, `--live`, `--mock`, `--down`, `--gold`, `--header-shadow` (and `--accent-end` if
   the gradient should not end on `--accent-2`). Keep it after the Classic blocks.
2. In `src/web/appearance.js`, add an entry to `PRESETS`: `name`, `note` (one line), `scheme` (`"light"` or `"dark"`), `cards`
   and `bgs` (its `--card` and `--bg`), `fgs` (its `--fg`), `themeColor` (its `--bg`) and `swatch` (page, accent, text, for the chips). The dialog
   builds its options from this table, so there is no markup to change.
3. Add the look to the setups in `test/appearance-browser.test.ts`'s contrast test. `test/appearance.test.ts` already checks
   that the block exists with every token and that the colours in `PRESETS` match it; the swatches are checked against every
   look automatically, so if a swatch fails on the new look, adjust the look (or the swatch).
4. Run `pnpm test` and look at the page in both a desktop and a phone window.

Fonts (`FONTS`), sizes (`SIZES`) and swatches (`ACCENTS`) are added the same way, in their tables; the tests bound text size
to 90-120% and require font stacks to be plain lists ending in a generic family.

## Verification

Automated (Chromium through Playwright, synthetic content; and plain unit tests):

- `test/appearance.test.ts`: defaults; per-field validation and fallback (unknown values, malformed colours, prototype keys,
  wrong version, broken JSON); storage round trip, defaults removing the key, junk cleaned, blocked storage never throwing;
  the accent check and its messages, every swatch against every look, the label colour at 4.5:1 for 586 sample colours; the
  accent's text shade at 4.5:1 for every swatch and some custom colours under every look;
  applying and removing a look and its overrides on `<html>`; the boot step; each look's CSS block matching `PRESETS`; fonts and
  sizes bounded and nothing downloaded; the markup and wiring; the server's `/appearance.js` headers.
- `test/appearance-browser.test.ts`: a fresh load is today's look (light and dark devices); the looks differ (page, cards,
  accent, scheme, toolbar colour) and preview without storing; the theme menu's radios turn off with the note; accent, font and
  size preview, code stays monospace, Save survives a reload and is applied before `<body>`, focus returns to the theme
  button, another tab follows; Cancel, Escape, Reset and saving defaults; broken, unknown and blocked storage; a refused custom
  accent and Save waiting for a readable one; AA text (including the user's name in the accent's text shade), 3:1 marks and focus, the syntax colours and the button labels for six
  setups (each look, custom accents, a serif font and other sizes), and the dialog on screen with no sideways scroll, reachable
  and with a visible focus ring by keyboard, at 1280, 390 and 320px; the file editor following Cool dark while its text stays
  monospace.
- The existing theme tests still pass; the theme menu test now tabs through Appearance… before focus leaves the menu.

Screenshots (`docs/appearance/`, synthetic content):

- `1280-classic-dialog.jpg`: the dialog over today's look. `1280-refused-accent.jpg`: a pale custom accent refused, Save off.
- `1280-warm.jpg`, `1280-cool.jpg`: the two other looks. `1280-warm-theme-menu.jpg`: the theme menu while a look is on.
- `1280-cool-custom-dialog.jpg`: Cool dark with the Amber accent, Serif and Large. `1280-cool-file-editor.jpg`: the editor.
- `390-dialog.jpg`, `390-cool-dialog.jpg`: the dialog as a bottom sheet on a phone. `390-warm.jpg`: Warm light at 120% text.
