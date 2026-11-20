# ORBIT web design system

The web page (`src/web/index.html`) has one small design system: tokens on `:root` near the top of the stylesheet, and
a few shared component rules that use them. This note has the brand audit behind it, the decisions, the token and
component reference, what was verified, and what is still open. The app shell itself (no page scrolling, safe areas,
keyboard handling) is in [web-shell.md](web-shell.md) and is unchanged.

## Brand audit (November 2026)

Looked at on `main` (after #148) with synthetic content at 1280, 1440 and 390px.

| Area | Found | Decision |
|---|---|---|
| Personality | A calm, technical assistant that acts for Rai, cautious and exact about what it has or has not done. The avatar (deep space, violet and blue ribbons, gold) carries it. | Keep it quiet and precise. Use colour to say what something means, not to decorate. Gold is kept for "waiting on Rai". |
| Hierarchy (laptop) | Header items read as one row of equal buttons. The current page tab looked like the primary action button. Messages ran across the whole 1280px window (lines of 150+ characters). The composer spanned the window, away from the text. | Group the header: brand, divider, page tabs, session switcher, then the toggles on the right. Show page tabs as navigation (a segmented control) and not as buttons. Put the conversation and the composer in one centred reading column. |
| Wordmark | Gradient, wide tracking, 16px. Distinctive. | Kept, with its tracking as a token (`--tracking-wordmark`) and a heavier weight. |
| Palette | The avatar colours plus status colours named for the status vocabulary (`--live`, `--mock`, `--down`). Components used them directly, so "warning" and "degraded" were the same variable by accident. | Palette kept (AA contrast was fixed in #148). Semantic names (`--info`, `--ok`, `--warn`, `--danger`, `--attention`) map onto it, each with a soft tint. Components use the semantic names. |
| Typography | `system-ui` at 15px, with about ten one-off sizes (11, 12, 12.5, 13, 14 and 17px) and three different monospace stacks. | System fonts only, and one scale (below). One monospace stack. |
| Iconography | Inline SVG, 2px stroke, round caps (bell, plus, send, external link, chevron). Consistent. | Kept. No icon font or icon library. |
| Buttons | Almost every button was the gradient (primary) style. Cancel, Rename and Archive were near-identical one-offs, and destructive actions looked like neutral ones. A request in flight only disabled the button. | Primary, secondary and destructive variants, one height, plus a loading state (below). |
| Microcopy | Truthful and specific ("Nothing has launched yet.", "This is NOT verified yet"). | Not changed. The confirmation card shows its first sentence as the card's title, with the same words. |

## Fonts

- **UI:** `--font-sans`: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. That is San
  Francisco on Apple devices, Segoe UI on Windows, Roboto on Android and the desktop default on Linux. They are
  hinted for screens, render at once, and are the faces people already read every day.
- **Code:** `--font-mono`: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`.
- **Why no web font:** nothing is downloaded, so there is no third-party request (no tracker), no licence to check, no
  layout shift and no extra page weight. A test checks that there is no `@font-face` and no font-service URL.

## Tokens

All tokens are on `:root`. Media queries change only a few of them: `--gutter`, `--text-lg`, `--ctl-sm`, `--btn-h`
and `--safe-b`.

| Group | Tokens |
|---|---|
| Type sizes | `--text-2xs` 11 (micro labels), `--text-xs` 12 (meta), `--text-sm` 13 (secondary), `--text-ui` 14 (UI text), `--text-md` 15 (body), `--text-lg` 17, or 18 at 900px and wider (titles), `--text-xl` 20 |
| Line heights | `--leading` 1.5 (body), `--leading-tight` 1.3 (titles), `--leading-code` 1.45 |
| Weights | `--weight-regular` 400, `--weight-medium` 500, `--weight-strong` 600, `--weight-heavy` 700 |
| Tracking | `--tracking-caps` .08em (uppercase labels), `--tracking-wordmark` .18em |
| Spacing | `--space-1..5`: 4, 8, 12, 16, 24px. `--gutter`: 12px at 480px or less, 16px, then 24px at 900px or more |
| Content width | `--measure` 860px (conversation, its status line, composer), `--measure-wide` 1040px (Jobs). Each region turns these into side paddings (`--col-l`, `--col-r`): the gutter, or enough to centre the column, whichever is larger |
| Radii | `--radius-xs` 4, `--radius-sm` 8, `--radius-md` 10, `--radius-lg` 12, `--radius-pill` |
| Borders | `--border` (1px `--line`) |
| Surfaces | `--card`, `--bg`, `--surface-2` (a quiet track or inset), `--surface-hover` |
| Semantic colour | `--info`, `--ok`, `--warn`, `--danger`, `--attention`, with `--info-soft`, `--warn-soft`, `--danger-soft` and `--attention-soft` |
| Elevation | `--elev-1` (header, floating button), `--elev-2` (popover), `--elev-3` (modal) |
| Focus | `--focus-ring` (2px solid `--accent-2`), `--field-halo` (text fields while focused) |
| Motion | `--dur-1` .08s (press), `--dur-2` .12s (hover and colour), `--ease`. Reduced motion turns every transition and animation off |
| Controls | `--btn-h` 32px (44px on touch screens), `--ctl-sm`, `--ctl-md`, `--tap` 44px |
| Layers, viewport | As in web-shell.md |

## Components

- **Header (900px and wider):** one row under 56px. The brand, a divider, the page tabs, the session switcher
  (Sessions only, capped at 520px), then the Notifications toggle (with a visible label) and the status toggle, both
  on the right. The open panels hang under the toggles as cards, right-aligned and at most 520px wide, side by side
  when both are open. They stay in the header's flow and keep their current behaviour: they persist for the tab's
  session, open independently and never close themselves.
- **Header (phones):** as in #148. The tabs sit on their own row as a borderless segmented track, and the header stays
  under 100px.
- **Page tabs:** a segmented control. The current page is a raised segment in bold with ORBIT's gradient as a 2px
  underline, plus `aria-current="page"`. Other tabs tint on hover.
- **Session picker (the header's menu):** placed under its button by the script and kept inside the visible area. It
  closes on Escape, on an outside click or when focus leaves, and returns focus to the button. Rename is secondary.
  Archive is destructive. Restore is secondary.
- **Buttons:** one shape (`--radius-md`) and one height (`--btn-h`).
  - Primary (a plain `<button>`): the gradient.
  - Secondary (`.btn-secondary`, and the existing quiet buttons such as Cancel, Rename, Jobs paging and Load earlier):
    a card with a border, tinted on hover.
  - Destructive (`.btn-danger`): red text and border, with a red tint and ring on hover.
  - Disabled: faded and inert.
  - Loading: `aria-busy="true"`, a spinner after the label and a progress cursor. The script sets it on the pressed
    Confirm or Cancel, on Send steer and on Load older events.
  - Focus: the shared 2px ring, keyboard only.
- **Text fields:** a card surface, the line border and `--radius-md`. The border tints on hover. While focused they
  get the accent border, the halo and the focus ring.
- **Confirmation card:** a card with a gold edge. Inside, in order: the proposal as its title, any duplicate warnings,
  the exact brief or command in an inset block, then Confirm (primary) and Cancel (secondary) in one row. The result
  replaces the buttons and takes focus if a button had it, as before.
- **Messages:** unchanged in structure (icon column, name, time, content). They fill the reading column, and rows sit
  12px apart at 900px and wider.
- **Notices and banners:** a card with a 3px edge in the meaning's colour.
- **Empty, loading and error states:**
  - Empty and loading ("No notifications.", "Reading notifications…"): muted text.
  - Errors (`role="alert"`): danger text on `--danger-soft` with a danger edge.

## Evidence

Chromium (Playwright) with synthetic content only. `test/desktop-design-browser.test.ts`:

- **Markup:** the tokens exist, there is one monospace stack, motion and radii come from tokens, and no web font is
  loaded. The variants exist, and reduced motion still turns animation off.
- **Header at 1280 and 1440:** one row under 56px, with a divider after the brand. The current tab is bold and has
  the gradient underline. The toggles are on the right, and Notifications is labelled.
- **Reading column at 1280 and 1440, Assistant and Sessions:** the rows form a centred column of about 860px. The
  composer starts where the messages start and Send ends inside the column. There is a gap of at least 8px before
  Send, nothing covers Send, and nothing scrolls sideways.
- **Panels at 1280:** side by side, right-aligned with the status toggle, at most 520px wide, as cards, with the
  conversation keeping at least 300px. Dismissing a notification by keyboard keeps focus in the panel.
- **Session picker at 1280, 900 and 640px (200% zoom of a 1280 window):** under its button, inside the screen and above
  the conversation. Archive is destructive, and Escape returns focus.
- **Confirmation card:** Confirm is primary and Cancel secondary, in one row and at least 32px tall. While the request
  is held, Confirm is disabled and busy with a spinner, and Cancel is disabled. The result replaces the buttons.
- **Motion and focus:** reduced motion stops the spinner. The page tabs and toggles show the focus ring on keyboard
  focus.
- **No overflow:** checked at 1440, 1280, 1024, 820 (tablet), 640, 390 and 320px, in light and dark, on both pages. No
  page or conversation overflows sideways, code and table regions stay inside the conversation, the composer is on the
  bottom edge and the header is within its cap.

The existing shell, composer, header-panel, picker, Jobs and message tests all still pass. Three of them were changed
on purpose:

- **Wide screens** (`message-layout-browser.test.ts`) now assert the centred column, not full-width rows.
- **Laptop header and composer padding** (`composer-browser.test.ts`) now assert the 24px gutter and the column
  alignment. The phone values are unchanged.
- **The composer resize check** goes from narrow to wide, because the box no longer grows past the column.

**Not verified:**

- WebKit: Playwright's WebKit is not installed here, so its check was skipped. Desktop WebKit is not iOS Safari anyway.
- Real devices: no real iPhone, Android phone or Mac was used. Phone results are Chromium emulation (`isMobile`,
  touch).
- Zoom: browser zoom at 200% and 400% was approximated by the equivalent CSS widths (640 and 320px for a 1280 window).
  Real text-only zoom (Safari's aA, Chrome's minimum font size) was not exercised.

## Screenshots

Before (main) on the left, after on the right, Chromium, synthetic content, in `docs/design-system/`:

- `1280-assistant.jpg`: header, conversation, confirmation card and composer.
- `1440-assistant-panels.jpg`: both header panels open.
- `1280-session-picker.jpg`: the header menu.
- `1280-dark-sessions.jpg`: dark theme, with a streaming reply.
- `390-assistant.jpg` and `390-session-picker.jpg`: phone.

To regenerate:

```
git show origin/main:src/web/index.html > /tmp/before.html
SHELL_SCREENS_SET=design SHELL_SCREENS_SMALL=1 node test/helpers/shell-screens.ts docs/design-system /tmp/before.html
```

## Manual acceptance checklist (laptop)

1. **Header.** At 1280 to 1440px wide, the header is one row: logo, tabs, then (on Sessions) the session title, with
   Notifications and the status on the right. The current page is bold and underlined.
2. **Reading column.** Assistant and Sessions read in a centred column, and the message box lines up with the messages.
   Long code and tables scroll inside their own box.
3. **Panels.** Open Notifications and the status. They appear as two cards under their buttons, on the right, and the
   conversation stays usable. Reload the page: they are still open. Open a new tab: they start closed.
4. **Session menu.** On Sessions, click the title. The menu opens under it, fully on screen. Arrow keys move through
   it, and Escape closes it with focus back on the title. Archive is red. Rename and New session still work.
5. **Confirmation card.** On a real proposal, Confirm is the strong button and Cancel the quiet one. Pressing one shows
   a spinner until the answer appears.
6. **Keyboard.** Tab through the header and the composer. Every control shows the blue focus ring.
7. **Zoom.** At 200% browser zoom, nothing scrolls sideways and the menu still fits.
8. **Phone.** The #148 checklist in web-shell.md still passes. The tabs are a segmented row, and Send stays visible
   with the keyboard open.

## Follow-ups (prioritized)

1. **Real-device and WebKit pass:** the iPhone checklist in web-shell.md, plus Safari on a Mac.
2. **An empty-state message for an empty conversation and an empty Jobs list.** It needs a truthful loading/empty
   distinction in the script.
3. **Jobs filters as a compact toolbar at laptop width** (search beside the filters, Clear as a secondary button
   aligned to the right).
4. **A contrast check for the soft tints** (`--danger-soft` and the others are `color-mix` values that the current
   hex-only contrast test cannot read).
5. **Moving the remaining one-off spacing values (3px, 6px, 10px) onto the spacing scale.**
