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
| Palette | The avatar colours plus status colours named for the status vocabulary (`--live`, `--mock`, `--down`). Components used them directly, so "warning" and "degraded" were the same variable by accident. Dark mode was available only through the OS setting. The light gold (`#c9921f`) measured 2.7:1 on cards: too faint for the sign-in code text and for the gold card edges. | Palette kept, with deliberate per-theme values. Semantic names (`--info`, `--ok`, `--warn`, `--danger`, `--attention`) map onto it, each with a soft tint. Light gold becomes `#b07d12` (3.5:1 as an edge), and the sign-in code is ink text on a gold tint. A Light/Dark/System choice was added. |
| Typography | `system-ui` at 15px, with about ten one-off sizes (11, 12, 12.5, 13, 14 and 17px) and three different monospace stacks. | System fonts only, and one scale (below). One monospace stack. |
| Iconography | Inline SVG, 2px stroke, round caps (bell, plus, send, external link, chevron). Consistent. | Kept. No icon font or icon library. |
| Buttons | Almost every button was the gradient (primary) style. Cancel, Rename and Archive were near-identical one-offs, and destructive actions looked like neutral ones. A request in flight only disabled the button. | Primary, secondary and destructive variants, one height, plus a loading state (below). |
| Microcopy | Truthful and specific ("Nothing has launched yet.", "This is NOT verified yet"). | Not changed. The confirmation card shows its first sentence as the card's title, with the same words. |

## Themes: Light, Dark and System

- **Both themes are designed on their own, not inverted.**
  - Light: a soft lavender page (`#f4f2fb`), cards that are barely off-white (`#fdfcff`, so no surface glares), deep
    ink text, and a restrained violet and blue accent.
  - Dark: deep space (`#080a1a`), raised navy cards (`#11142b`), text just below white (`#e4e1fa`) for long reading,
    and lighter accents and status colours that keep AA contrast.
  - Both: the background glow is soft, and saturated colour appears only on primary buttons, the current-tab
    underline and status marks.
- **The choice:** a theme button in the header (left of Notifications) shows the current choice as its icon (monitor,
  sun or moon) and in its accessible name ("Theme: System (dark now)"). It opens a small menu of native radio buttons:
  System ("Follows this device"), Light and Dark.
  - A choice applies at once.
  - Arrow keys move the choice.
  - Escape closes the menu and returns focus. A click outside or focus leaving also closes it.
- **Storage and compatibility:** System is the default and stores nothing. It is exactly the previous behaviour, which
  followed the OS through `prefers-color-scheme`, and there was no earlier stored preference to migrate. Light or Dark
  is stored in this browser as `orbit.theme` and applies in other open tabs at once (`storage` event). In System mode a
  change of the OS theme applies live.
- **No wrong-theme flash:** a few lines of script in `<head>`, before the stylesheet, set `data-theme` on `<html>`
  before the body is parsed. If storage is blocked, the page uses System.
- **Native parts:**
  - `color-scheme` is set per theme, so scrollbars, checkboxes, radios and selects match.
  - `theme-color` (the browser's toolbar colour) follows the chosen theme.
- **CSS:** the light values are on `:root`. The dark values are written twice: once under
  `prefers-color-scheme: dark` for `:root:not([data-theme="light"])`, and once for `:root[data-theme="dark"]`. A test
  checks that the two copies are identical. Every component reads semantic tokens, so nothing else has
  theme-specific rules.

## Fonts

- **UI:** `--font-sans`: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. That is San
  Francisco on Apple devices, Segoe UI on Windows, Roboto on Android and the desktop default on Linux. They are
  hinted for screens, render at once, and are the faces people already read every day.
- **Code:** `--font-mono`: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`.
- **Why no web font:** nothing is downloaded, so there is no third-party request (no tracker), no licence to check, no
  layout shift and no extra page weight. A test checks that there is no `@font-face` and no font-service URL.

## Tokens

All tokens are on `:root`. The theme (dark media query or `data-theme`) changes only the palette, `--header-shadow` and
`color-scheme`, and every derived token follows. Size media queries change only `--gutter`, `--text-lg`, `--ctl-sm`,
`--btn-h` and `--safe-b`.

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
  on the right. From 900 to 1023px the open panels hang under the toggles as cards, right-aligned and at most 520px
  wide (from 1024px they are the side panel, below). They stay in the header's flow and keep their current behaviour: they persist for the tab's
  session, open independently and never close themselves.
- **Header brand:** the logo and the ORBIT name are one quiet button (accessible name "ORBIT: Refresh page") that
  reloads the current page at the same address, path, query and hash, as the browser's reload does; nothing is sent or
  cleared. It has no button chrome at rest, only the shared hover ring, pressed look and focus ring, and a 44px tap area
  on touch screens.
- **Header (phones):** as in #148. The tabs sit on their own row as a borderless segmented track, and the header stays
  under 100px.
- **Page tabs:** a segmented control. The current page is a raised segment in bold with ORBIT's gradient as a 2px
  underline, plus `aria-current="page"`. Other tabs tint on hover.
- **Theme menu:** see Themes above. It is laid out like the session picker: a card at `--elev-2`, kept on screen. The
  current option has the info tint and bold text.
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

## Side panel: tabs, resize and collapse; no indicators in the header (November 2026, third pass)

*Update (November 2026, after the left sidebar): Status is now the first tab and the default view, then Notifications, in
the rail and in the open panel. The panel sits beside the left sidebar ([sidebar.md](sidebar.md), "Both panels"): on a
wide enough screen both stay open; when the conversation would have less than 480px, opening one closes the other.*

Rai asked for the side panel without its header (no title, no close button), for tabs to switch its sections, a resize
handle, a collapse to the right that leaves a handle to reopen it, and for the Notifications and status indicators (and
their "Notifications" and "All live" words) to leave the page header and live in the panel only. This replaces the
"Side panel" bullet of the second pass below (and the header toggles of the first pass) on every width.

- **Header.** Logo, page tabs, the session title (Sessions only) and the theme button. No notifications button, no status
  indicator, no "Notifications", "All live" or status words; the status line and the notifications are not in the header.
- **One side panel on every width** (`<aside id="side" aria-label="Side panel">`, after the header): at the right edge,
  from under the header to the bottom of the screen, on the card surface with a left border.
  - Head: the collapse button (`#sidetoggle`, chevrons, `aria-expanded`, `aria-controls="inbox statusline"`) and the
    tab list (`role="tablist"`, "Side panel views"): Notifications (bell, label and the count) and Status (the level dot
    and label). No heading, no ×. One view at a time, each a `tabpanel`; the view scrolls on its own under the head.
  - The indicators are the tabs. The count (`#notecount`) and the dot keep their meaning and states ("?" until read, the
    gold count above zero, the dot's colour and shape per level). The Notifications tab's name is "Notifications, 12"
    (hover: "Notifications: 12"); the Status tab's is "Status: All live (healthy, all live)" with the label and detail on
    hover, and the Status view shows them in words as before.
- **Collapsed (the default): a rail.** The panel slides away to the right (about 160ms; none with reduced motion) and
  leaves a 44px rail (46px on touch screens) at the edge: the expand button, then the two tabs as icons only (the bell
  with the count, the dot); their labels stay for screen readers. The rail is the visible handle: a tab opens the panel on
  its view, the button on the last view. Opening slides the panel back in.
- **Room.** On laptops and desktops (1024px and wider) the conversation, Jobs and the composer keep clear of the rail or
  the open panel and recentre their column in the room left (`--side-room`), so nothing is covered. Below 1024px the open
  panel lies over the page (with a deeper shadow) and the page keeps only the rail's room. Below 900px the rail stops above
  the composer, so the message box and Send keep the full width on a phone.
- **Resize.** A handle on the panel's inner (left) edge: the panel is anchored to the right edge, so its outer right edge
  is the screen's edge and the inner edge is the one that can move. An 8px strip (20px on touch) with a quiet grip, an
  accent line on hover, while dragging and on focus; `ew-resize` cursor. Drag with a mouse, pen or finger. It is a
  window splitter (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow`/`min`/`max` in pixels,
  `aria-valuetext` "360 pixels wide"): Left widens by 16px and Right narrows (64px with Shift), Home and End go to the
  narrowest and widest, Enter collapses the panel, a double-click resets the default (`clamp(320px, 30vw, 400px)`; below
  1024px `min(400px, 100vw - 40px)`). Bounds: 280 to 720px, and on laptops at most the window less 480px for the
  conversation; below 1024px at most the window less 24px. The width is kept on this device (`orbit.side-width` in
  localStorage) and clamped, not forgotten, on a smaller window.
- **Keyboard and focus.** Tab goes from the header to the collapse button, the selected tab (one tab stop), into the
  view, the resize handle and on out: no trap. Open, arrows (Left/Right), Home and End switch and show the view; in the
  rail the arrows (also Up/Down) only select, and Enter or Space opens. Escape inside the panel collapses it. The button
  and tabs are the same elements open and collapsed, so focus stays on them; when focus was in a view or on the handle
  (which go away), it moves to the selected tab. Nothing outside closes the panel and nothing opens it by itself.
- **Kept state and semantics.** Which view is open is the same pair of flags as before (`orbit.header-panels`, this tab's
  session); an older value with both open opens Notifications. Receipts are still sent only for notes listed in a shown
  Notifications view of a visible tab: never from the rail, the Status view or a collapsed panel; collapsing never
  dismisses.

**Tests.** `test/side-panel-browser.test.ts` (rewritten): the header has no indicators or their words at 320, 390, 900,
1024, 1280 and 1440; the rail by default (narrow, right edge, under the header, covering no message or Send); a tab opens
the panel with focus kept, no heading or close button, the column recentred; tabs switch, the selected tab stays, the
button collapses and reopens on the last view, state across a reload; the slide out and in, sampled mid-animation; tab
stops, arrows in the rail and open, Escape from a tab and from a view, Tab through and out; the resize handle by mouse
(drag, bounds 280/720, kept across a reload, double-click reset), by keyboard (16/64px steps, Home/End, Enter collapses,
focus ring) and by touch on a phone; a kept width clamped to a smaller window and restored; below 1024 (390 and 320
phones, 900) the overlay, the page not reflowing, labels that fit, the rail above the composer; receipts; status states;
Light and Dark. `test/header-panels.test.ts`: the width helpers (bounds, clamping, storage, keys), the markup (no
indicators in the header, the aside, tabs, tabpanels and separator, the status tab before the first read), and the
browser checks of the views now driven by the tabs. The other suites that used the header toggles now use the tabs;
layout checks centre the column left of the rail.

**Not verified:** a real screen reader (roles, names and states are checked in the DOM only), real phones and tablets
(Chromium emulation with touch), WebKit/Safari, and a real pen.

## Desktop menu, side panel and composer keys (November 2026, second pass)

Rai's feedback after #149: the phone menu is liked; on the laptop the menu items had an extra border that looked off;
Notifications and Status felt awkward as cards inside the header; and on a phone Return sent the message.

- **Desktop menu.** The extra border was two things: the shared button hover ring (a 2px ring) drawn around each session
  row as the mouse passed over it, and a 1px accent border around the open session. Both read as a box nested inside
  the menu card. From 900px the rows are plain aligned rows (same left edge and padding, 40px tall); a row tints on hover
  (`--surface-hover`), and the open session has the info tint, bold text and a 3px accent bar at its leading edge. Pressing
  no longer shrinks the row. The 2px keyboard focus ring stays, drawn just inside the row (`outline-offset: -2px`) so the
  list's edge cannot clip it. The page tabs lose their outline and the current tab its inner border (it stays raised by
  its card colour, shadow and gradient underline), which is the borderless track phones already had. Phones (below 900px)
  are unchanged: same picker rows, same tabs.
- **Side panel (1024px and wider; replaced by the third pass above).** Notifications and Status open in one panel on the right, under the header and down
  to the bottom of the screen, 320 to 400px wide (`--side-w: clamp(320px, 30vw, 400px)`), on the card surface with a
  left border.
  - Head: a heading naming the view, a close button (×, "Close the panel"), and two tabs (Notifications with the count,
    Status with the level dot). One view shows at a time. The head stays put; the view under it scrolls on its own.
  - The header toggles open the panel on their view, switch it if the panel shows the other view, and close it if it
    already shows theirs (`aria-expanded` is true only on the toggle of the shown view).
  - Not modal: opening never moves focus, nothing outside closes it, focus is not trapped (Tab goes from the toggles into
    the panel and on out of it). Escape inside the panel, or the close button, closes it and puts focus back on the toggle
    of the view that was showing. The tabs follow the ARIA tab pattern: one tab stop, arrow keys, Home and End switch
    and show the view; the views are `tabpanel`s labelled by their tab, and the panel is a region labelled by its heading.
  - Nothing is covered: the conversation, its status line, the Jobs list and the composer move left by the panel's width
    and recentre their reading column in the room left (the column paddings subtract `--side-w`). At 1024px the column
    is about 650px; at 1280 and wider the full 860px.
  - Status view: the overall status first (the same label and detail as the header indicator, with a coloured edge and
    the level dot), the link to the raw status page beside it, then the port states as a list of rows, then the running
    release. Notifications view: the same notes, `more`, `×` and `show all` as before, as tinted rows.
  - The open state is the same pair of flags kept for the tab's session as before (`orbit.header-panels`); the panel
    shows the last chosen view. Below 1024px (phones, tablets in portrait, a narrow laptop window, 200% zoom) the header
    panels are exactly as before: in the header, independent, both open at once if wanted. Resizing across 1024px
    switches presentation without losing the open state.
  - Semantics unchanged: a receipt is sent only for notes listed in a shown Notifications view of a visible tab (never
    from the Status view or a closed panel); closing never dismisses; the count is every undismissed note; nothing opens
    the panel by itself.
- **States.** Notifications keep "Reading notifications…", "No notifications." and the read-error alert. Status now has
  them too, on every width: "Reading status…" until the first answer, "ORBIT reported no status entries." for an empty
  list, and an alert when a read fails ("ORBIT's status could not be read (HTTP 500).", "ORBIT could not be reached for
  its status.") that adds "Showing the last answer." when older pills are kept.
- **Composer keys** (`<composer-keys>` in the script):
  - Touch-first devices (the primary pointer is coarse and there is no fine pointer anywhere: phones, tablets without a
    trackpad or mouse): Return inserts a new line, and only Send sends. The on-screen key is labelled return
    (`enterkeyhint="enter"`).
  - Every other device (a mouse or trackpad is present: laptops, desktops, touch laptops, tablets with a trackpad): Enter
    sends, Shift+Enter inserts a new line, as before (`enterkeyhint="send"`).
  - Everywhere: Ctrl+Enter or Cmd+Enter sends; no key sends while an input method is composing (`isComposing`, a
    composition seen between `compositionstart` and `compositionend`, or Safari's keyCode 229 after `compositionend`).
  - Why not the viewport width: a narrow desktop window still has a hardware keyboard, and a large tablet still has a
    touch keyboard. The pointer media queries are read at each key press, so attaching a mouse changes the behaviour at
    once. Limitation: no browser reports a hardware keyboard. A phone or tablet with a Bluetooth keyboard and no
    trackpad is treated as touch-first, so Return adds a line there and Cmd/Ctrl+Enter or Send sends. A desktop with a
    touch screen as its only pointer would also be treated as touch-first.
  - Drafts, multi-line text, photos and streaming are untouched: only which key calls the form's submit changed, and the
    submit handlers are the same.

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
- **Themes** (`test/themes-browser.test.ts`):
  - System follows the emulated device, live, and stores nothing.
  - Light chosen on a dark device, and Dark on a light one: the choice wins and persists. It is already set when
    `<body>` starts parsing (no flash), other open tabs follow, and the browser colour matches. Going back to System
    clears the stored choice.
  - The menu works by keyboard (Enter opens it, focus lands on the current choice, arrows choose, Escape returns focus)
    and closes on an outside click or focus leaving. It is checked at 1280, 640, 390 and 320px, on screen and above the
    page.
  - Contrast is checked for 26 colour pairs in four setups (light device, dark device, Light chosen, Dark chosen). The
    browser resolves each colour, including `color-mix` tints. Text must reach 4.5:1: body and secondary text on page,
    card and inset; links; ok, warning and danger (including danger on its tint); text on the selection and gold
    tints; text on the primary gradient's ends; the current tab; the inverted time tip. Focus ring, checked radio and
    meaningful card edges must reach 3:1. The placeholder is drawn opaque in `--muted`.
- **No overflow:** checked at 1440, 1280, 1024, 820 (tablet), 640, 390 and 320px, in light and dark, on both pages. No
  page or conversation overflows sideways, code and table regions stay inside the conversation, the composer is on the
  bottom edge and the header is within its cap.

- **Side panel and desktop menu** (`test/side-panel-browser.test.ts`): at 1024, 1280 and 1440 the panel opens on the
  right under the header, covers no message and not Send, leaves the column centred in the room left, and leaves focus
  on the toggle; toggles and tabs switch views and close; arrow keys, Home and End; Tab passes through and out; Escape
  and × restore focus; the view scrolls alone while the head and the conversation stay; receipts only from the shown
  Notifications view; status loading, error, kept-answer and empty states; an empty notifications state; below 1024 (390
  phone, 900) the header panels are unchanged and independent; resizing 1280 → 800 → 1280 keeps the open view; session
  rows have no hover ring or border box on desktop, keep a 2px inset focus ring and line up; desktop tabs have no inner
  borders while the phone's current tab keeps its edge; Light and Dark panel surfaces and AA contrast for the new pairs.
- **Composer keys** (`test/composer-keys.test.ts`): the heuristic and key table as pure functions; on an emulated phone
  Return adds lines and sends nothing (both boxes) and Send sends the whole multi-line draft; Ctrl/Cmd+Enter sends; on a
  desktop Enter sends and Shift+Enter adds a line; a real Chromium input-method composition (CDP `imeSetComposition`)
  and Safari-style keyCode 229 events never send.

The existing shell, composer, header-panel, picker, Jobs and message tests all still pass. Three of them were changed
on purpose:

- **Wide screens** (`message-layout-browser.test.ts`) now assert the centred column, not full-width rows.
- **Laptop header and composer padding** (`composer-browser.test.ts`) now assert the 24px gutter and the column
  alignment. The phone values are unchanged.
- **The composer resize check** goes from narrow to wide, because the box no longer grows past the column.

**Not verified:**

- Composer keys on real devices: the phone results are Chromium's touch emulation (`isMobile`, `hasTouch`), which sends
  a hardware-style Enter key, not a real iOS or Android keyboard. iOS Safari, Gboard and Samsung Keyboard, a real
  Japanese or Chinese input method, an iPad with a Magic Keyboard, and a Bluetooth keyboard on a phone were not tried.
- The side panel with a screen reader (VoiceOver, NVDA) was not tried; the roles and names are checked in the DOM only.

- Visual judgement: "easy on the eyes" was judged from the screenshots. The contrast is measured, but comfort over a
  long session was not tested with people.
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
- `1280-theme-menu.jpg`: the theme menu. There is none on the before side.
- `1280-dark-assistant.jpg` and `390-dark-assistant.jpg`: dark theme at laptop and phone widths.

To regenerate:

```
git show origin/main:src/web/index.html > /tmp/before.html
SHELL_SCREENS_SET=design SHELL_SCREENS_SMALL=1 node test/helpers/shell-screens.ts docs/design-system /tmp/before.html
```

Side panel, desktop menu and composer keys (before on main, after on the right), in `docs/side-panel/`:

- `1280-side-notes.jpg`, `1280-dark-side-notes.jpg`: 14 notifications with long ones, all shown, one opened.
- `1440-side-status.jpg`, `1280-dark-side-status.jpg` (Sessions, a reply streaming): the Status view.
- `1024-side-notes.jpg`: the narrowest side panel.
- `1280-session-menu.jpg`, `1280-dark-session-menu.jpg`: the session menu with the mouse over the second row.
- `390-panels.jpg`, `390-dark-panels.jpg`: the phone header panels, unchanged.
- `390-composer-return.jpg`: "First line", Return, "Second line", Return, "Third line" typed on a phone. Before, the
  first Return sent "First line"; after, all three lines are in the box and nothing was sent.

```
SHELL_SCREENS_SET=panel SHELL_SCREENS_SMALL=1 node test/helpers/shell-screens.ts docs/side-panel /tmp/before.html
```

## Manual acceptance checklist (laptop)

1. **Header.** At 1280 to 1440px wide, the header is one row: logo, tabs, then (on Sessions) the session title, with
   Notifications and the status on the right. The current page is bold and underlined.
2. **Reading column.** Assistant and Sessions read in a centred column, and the message box lines up with the messages.
   Long code and tables scroll inside their own box.
3. **Panels.** Open Notifications and the status. From 1024px they are one side panel on the right with a tab each
   (item 10); between 900 and 1023px they are two cards under their buttons. The conversation stays usable. Reload the
   page: they are still open. Open a new tab: they start closed.
4. **Session menu.** On Sessions, click the title. The menu opens under it, fully on screen. Arrow keys move through
   it, and Escape closes it with focus back on the title. Archive is red. Rename and New session still work.
5. **Confirmation card.** On a real proposal, Confirm is the strong button and Cancel the quiet one. Pressing one shows
   a spinner until the answer appears.
6. **Keyboard.** Tab through the header and the composer. Every control shows the blue focus ring.
7. **Theme.** Click the theme button (left of Notifications) and choose Dark, then Light. The page changes at once, with
   no flash on reload. Choose System and switch the OS between light and dark: the page follows. Open two tabs, change
   the theme in one, and the other follows. Read a long conversation in each theme for a few minutes: nothing glares
   and secondary text stays readable.
8. **Zoom.** At 200% browser zoom, nothing scrolls sideways and the menu still fits.
9. **Phone.** The #148 checklist in web-shell.md still passes. The tabs are a segmented row, and Send stays visible
   with the keyboard open.
10. **Side panel.** The header shows no Notifications or status. At the right edge, a rail shows the status dot, then
   the bell with the count. At 1280px, click the bell: the panel slides in on the right with Notifications and Status
   tabs (no title, no ×) and the conversation moves left, nothing covered. Click Status: the same panel shows Status.
   Drag the panel's left edge wider and narrower; reload: the width is kept; double-click the edge: back to the default.
   Press Escape (or the » button): it slides away to the rail, focus on the tab. Scroll a long list inside it: the
   conversation does not move. On a phone, tap the bell: the panel lies over the page; tap » to collapse it.
11. **Menu.** Open the session menu and move the mouse over the rows: a quiet tint, no ring or box.
12. **Phone composer.** On a real iPhone and Android phone, type two lines with Return: nothing is sent until Send.
   With a Japanese keyboard, confirm a conversion with Return: it only confirms. On a laptop, Enter still sends.

## Follow-ups (prioritized)

1. **Real-device and WebKit pass:** the iPhone checklist in web-shell.md, plus Safari on a Mac.
2. **An empty-state message for an empty conversation and an empty Jobs list.** It needs a truthful loading/empty
   distinction in the script.
3. **Jobs filters as a compact toolbar at laptop width** (search beside the filters, Clear as a secondary button
   aligned to the right).
4. **Visible borders on text fields and secondary buttons.** These use `--line`, which is decorative (under 3:1). The
   controls are identified by their text, placeholder and position, but a stronger field border would help people with
   low vision.
5. **Moving the remaining one-off spacing values (3px, 6px, 10px) onto the spacing scale.**
