# Web app shell and design tokens

The web page (`src/web/index.html`) is laid out as an app, not a document: a header, one region that scrolls (the
conversation or the Jobs list), and the composer, all inside a shell that fills exactly the visible area. This note
covers why the earlier layout felt like a page on a phone, what the shell does, the design tokens, and what was and was
not verified.

## What was wrong (diagnosed, not assumed)

Measured with synthetic content (`test/helpers/shell-fixture.ts`) in Playwright's Chromium at phone sizes, and reasoned
from how iOS Safari behaves:

1. **The document could move.** `body` was `height: 100dvh` in normal flow. Nothing stopped the page itself from
   scrolling or rubber-banding, and the conversation's scrolling chained to the page. On iOS Safari, focusing the
   composer makes Safari pan the visible area over the page (it never shrinks the layout viewport or `dvh` for the
   keyboard), which pushes the header off the top. After the keyboard closes the page can stay shifted, leaving content
   under Safari's toolbar. A page-level scroll also shows the page's scroll indicator along the right edge, over Send.
2. **iOS focus zoom.** The message box used 15px text. iOS Safari zooms the whole page into any focused text field under
   16px. That zoom shifts and enlarges the layout, which is part of the "feels like a page" effect.
3. **Safe-area padding did nothing.** The composer padded with `env(safe-area-inset-bottom)`, but without
   `viewport-fit=cover` that value is always 0 in Safari.
4. **The newest message could open hidden.** When the Assistant drew a conversation and, in the same moment, showed a
   status line or a taller placeholder, the conversation box got shorter after it had scrolled to the bottom. The
   jump-to-latest logic read that as the reader scrolling away. The page then opened about 60px short of the newest
   message (reproduced at 375×667).
5. **Header panels could push the composer off-screen.** With both the notifications and the status panels open on a
   short screen (568×320 landscape), the header grew past the screen and the composer was cut off (see
   `568x320-landscape-panels.jpg`).
6. **Contrast.** In the light theme the blue accent (`#2f8fd6`) measured 3.15:1 on the page and 3.49:1 on cards. That
   accent is used for links, ORBIT's name and the blue end of filled buttons. The live and amber state colours were also
   under 4.5:1 on the page background.

No open backlog issue or design document for this was found in the repository. The earlier header, composer and message
work (PRs #107–#118) is described in the CSS comments, and this change keeps those decisions unless noted here.

## The shell

- `html` and `body` never scroll. `body` is `position: fixed`, `overflow: hidden` and `overscroll-behavior: none`: a
  flex column of the header, the scroller and the composer. Only `#alog`, `#log`, `#jobs`, the sidebar's sections, the side panel's views, the session
  list, the message box and wide code/tables scroll. Each uses `overscroll-behavior: contain` so scrolling never chains
  to the page.
- **Height:** `100vh`, then `100dvh` where supported, then the page's own visual-viewport measurement (`viewportShell`
  in the script). It sets `--app-h` and `--app-top` and marks `data-vv` on `<html>`. It uses the visual viewport's
  height only: no keyboard height or inset is subtracted on top, so nothing is counted twice. While the reader has
  pinch-zoomed (scale > 1) it lets go and the CSS height applies, so zoom behaves normally. Updates are batched to one
  per animation frame. Listeners come off on `pagehide` and go back on `pageshow`.
- **Keyboard:** iOS keeps the layout height, so a gap of more than 120px between it and the visible height means the
  keyboard is open (`data-kb="open"`). The bottom safe-area inset is then dropped, because the keyboard already covers
  the home indicator. When the keyboard closes and the page was left scrolled, it is scrolled back to 0. On Chromium for
  Android, `interactive-widget=resizes-content` makes the layout itself shrink, so the same code just follows it.
- **Viewport meta:** `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. It
  never sets `maximum-scale` or `user-scalable=no`, and a test enforces that.
- **Safe areas:** the header (top and sides), the conversation (sides), the composer (sides and bottom), Jobs (bottom)
  and the photo viewer (all sides) pad with `env(safe-area-inset-*)` through the `--safe-*` tokens.
- **Composer:** a fixed row. An 8px gap separates the message box from Send. Send's enlarged hit area grows up, down and
  to the right (toward the screen edge), never left into the box, so a drag on the box's own scrollbar cannot land on
  Send. On touch screens the box uses 16px text, which stops the iOS focus zoom. It still grows to eight lines and then
  scrolls inside.
- **Scroll following:** a change in the conversation box's own height keeps a reader who was at the bottom there,
  whichever observer notices it first. A scroll event never pins. A reader scrolled back into history is never moved.
- **Header:** on a phone the page links are a row of equal-width tabs under the logo row. All pages stay visible; nothing
  is hidden behind a menu. On the Sessions page at 400px or less, the ORBIT wordmark is visually hidden (still in the
  accessibility tree) to give the session title room. On touch screens, header controls are 36px to look at, with a 44px
  hit area from an invisible frame, so the header does not get taller. The two panels share space when both are open
  (20% of the height each, else 30%). The header is capped at 60% of the height and scrolls inside past that.
- **Session picker** (the header's menu): a disclosure that keeps its existing semantics, keyboard handling, Escape and
  outside-tap dismissal, and focus return. It is placed under its button and now limited to the visible area (keyboard
  and Safari toolbars excluded). It is re-placed on visual-viewport changes and layered with `--z-popover`.

## Tokens

All defined on `:root` near the top of the stylesheet. Colours stay the existing theme variables.

> **Superseded:** the full and current token set (type scale, semantic colours, motion, the reading column, button
> variants) is in [design-system.md](design-system.md). The table below is the set #148 introduced, kept for context.

| Group | Tokens |
|---|---|
| Spacing | `--space-1..5`: 4, 8, 12, 16, 24px; `--gutter` (16px, 12px at 480px or less) |
| Type | `--text-xs/sm/md/lg`: 12, 13, 15, 17px; `--leading` 1.5 |
| Radii | `--radius-sm/md/lg/pill`: 6, 10, 12, 999px |
| Borders | `--border` (1px solid `--line`) |
| Elevation | `--elev-1` (header and floating button), `--elev-2` (popover), `--elev-3` (modal) |
| Layers | `--z-dock` 5, `--z-header` 10, `--z-popover` 40, `--z-modal` 50 |
| Controls | `--ctl-sm` (28px; 36px on touch), `--ctl-md` 36px, `--tap` 44px |
| Viewport | `--app-1` (1% of the app's visible height), `--safe-t/r/b/l` |

Colour changes (light theme only, to reach WCAG AA 4.5:1 as text):

| Token | Before | After |
|---|---|---|
| `--accent-2` | `#2f8fd6` | `#1a6f9e` |
| `--live` | `#1b7fb8` | `#17709f` |
| `--mock` | `#9a6a00` | `#855b00` |

The dark theme already passed and is unchanged.

## Evidence

`test/app-shell-browser.test.ts` (Chromium, synthetic content):

- **Widths and orientations:** 320, 375, 390 and 430px portrait; 568 and 844px landscape; tablet portrait and
  landscape; desktop. Each runs the Assistant and Sessions, with short and long chats.
- **Asserted at each size:** no page scrolling, no sideways overflow, header at the top and composer on the bottom edge,
  and the conversation between them. Send is on screen and not covered, with explicit space between Send and the box.
  The page opens at the newest message, and that message ends above the composer.
- **Zoom:** 200% and 400% equivalent widths.
- **Composer:** grows to eight lines, then scrolls. A touch on the box's scrollbar edge lands on the box. History
  position is kept, and the draft survives a page switch.
- **Session picker:** at 320, 375 and 568×320 it stays on screen and layered above the page, works by keyboard, and
  closes on Escape or an outside tap with focus returned.
- **Touch targets:** header controls and tabs have 44px hit areas, with a visible focus ring.
- **Panels:** bounded on a 568×320 screen.
- **Simulated iOS keyboard, toolbar and zoom:** a stand-in `visualViewport` drives the page's own logic, followed by an
  Android-style resize and rotation.
- **Other:** a streaming reply and a confirmation card at 320px; AA contrast for 13 colour pairs in both themes; reduced
  motion.
- **WebKit:** the WebKit check runs only where Playwright's WebKit is installed. It was not installed in the
  environment where this was built, so it was skipped. Desktop WebKit would not be iOS Safari anyway.

Before/after screenshots (Chromium, phone emulation, synthetic content) are in `docs/web-shell/`. Regenerate them with
`SHELL_SCREENS_SMALL=1 node test/helpers/shell-screens.ts docs/web-shell <old index.html>`.

**Not verified automatically:** a real iPhone. Chromium and desktop WebKit have no iOS keyboard, no Safari toolbar
collapse and expand, and no iOS focus zoom.

## Real-iPhone acceptance checklist (for Rai)

On an iPhone in Safari, with the real ORBIT page:

1. **Portrait, Assistant, long conversation.** The page opens at the newest message. Dragging anywhere does not move
   the header or composer, and the page does not bounce as a whole.
2. **Keyboard open.** Tap the message box. The page does not zoom in. The composer sits directly on the keyboard, the
   header stays visible at the top, and the newest message stays visible just above the composer.
3. **Keyboard closed.** Dismiss the keyboard. The composer returns to the bottom with a small gap above the home
   indicator. Nothing is left under Safari's address bar, and there is no blank strip.
4. **Long draft.** Type or paste more than eight lines. The box stops growing and scrolls inside. Send stays visible and
   tappable. Scrolling the box never sends.
5. **Reading history.** Scroll up in the conversation, then tap the box and type. The conversation does not jump.
   "↓ click to latest" returns to the bottom.
6. **Landscape.** Rotate with and without the keyboard open. The header, conversation and composer re-fit with no
   sideways scrolling, and the notch side is padded.
7. **Header controls.** Open the notifications, the status and (on Sessions) the session picker. Each opens fully on
   screen, closes with a tap outside, and the composer stays reachable.
8. **Zoom.** Pinch-zoom works. With Safari's text size raised (aA → larger), nothing scrolls sideways.
9. **Toolbar.** With Safari's address bar at the bottom (the default) and at the top, the composer is never covered by
   it.

Report any step that fails, with the iOS version and a screenshot.
