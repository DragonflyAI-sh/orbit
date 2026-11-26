# Left sidebar

The web page has a left sidebar: Rai's active projects, an index of the Plan views (docs/plan.md), the related files of
the selected project, and the photos that name it. It is the page's main navigation and organisation panel. ORBIT's live status and notifications stay
in the right-hand side panel (docs/design-system.md, "Side panel"), Status first; the two panels can be open together
("Both panels" below).

## What it shows

Read from `GET /sidebar?project=<id>` (owner only; src/sidebar.ts, src/plan.ts, src/server.ts). The answer's `overview` is
the Plan's project cards (docs/plan.md); its older `plan` field (plan headings of now.md or the selected project, and open
tasks) is still sent but no longer drawn. Nothing is mock data: the vault parts
come from the same vault snapshot memory search reads (the writable clone, or the read-only copy, as `vault.source` says),
and the photos from the attachment store.

| Section | Source | Without a project | With a project |
| --- | --- | --- | --- |
| **Projects** | Hub notes `Projects/<name>.md` (top level only) whose `status:` is not done, dropped, archived, cancelled, completed, abandoned or closed | — | The selector's choice, remembered in this browser |
| **Plan** | Every hub note `Projects/<name>.md`, read as a project card (docs/plan.md) | **All projects** (opens the overview in the main area), how many projects need attention, then each open project by priority with a status dot and a priority badge; each opens its detail in the main area | The same list: the Plan does not follow the selector |
| **Files** | Vault notes, each with an on-demand preview (`GET /sidebar/note?path=`) | `now.md` and every active project's hub note | The project note, its tasks (open or not), every other note that links `[[id]]` (the activity `Log/` aside), and the items under its Locations heading |
| **Images** | Photos Rai sent in the Assistant or a chat thread that still exists (archived threads aside), the same reach as the Assistant's photo tools; 10 per page (`images=<page>`) | Every photo, newest first | Those whose caption or conversation title contains the project's id (as words), title or an alias as a whole phrase |

Each photo in **Images** is a row: its thumbnail, the day it was sent, its caption, an **AI** badge and count when a model
observation is saved for it (counted for the page shown only, from the records the Assistant may read), and an "Open" link
to its conversation. **Previous** and **Next** page through the list (the page is kept while the sidebar refreshes and
goes back to the first when the project changes). A thumbnail opens the photo gallery (docs/photo-gallery.md) in the
centre pane with that photo enlarged; the section's search box and "Open the photo gallery" open the gallery too.

Every vault string is masked for secret-shaped values (src/vault/filter.ts), flattened to one line and bounded; a note
preview is masked and cut at 20,000 characters, and only a note in the snapshot can be previewed. Photo captions and
titles are untrusted text and only ever set as text. A photo is shown only from its validated ref through
`/assistant/photos/<ref>`, which re-authorizes every fetch; its "Open" link goes only to the Assistant or a chat thread.

When the vault cannot be read, the answer says so (`vault: { ok: false, error }`) and the page shows that error in each
vault section; the photos are still listed. A failed read of `/sidebar` itself is shown in the Projects note ("could not
be read (HTTP 500)", "could not be reached", owner only on 403) and keeps what was shown. A remembered project that is no
longer active falls back to everything, and the page says so.

The page reads `/sidebar` at load, when the project changes, when the sidebar opens after a minute, and every minute while
it is open in a visible tab.

## Layout and behaviour

- **1024px and wider: docked.** On the left, under the header and down to the bottom of the screen, 280px wide by default,
  open by default. The conversation, the Jobs list and the composer move right by its width and recentre their reading
  column in the room left, so nothing is covered.
  - A handle on its right edge (`#navhandle`, "Collapse the sidebar") collapses it to the left edge; collapsed, the same
    handle sits at the left edge ("Show the sidebar") and the content takes the full width.
  - A separator on the same edge (`role="separator"`, `aria-valuenow`) resizes it: drag it, or focus it and use the arrow
    keys (16px, 64px with Shift), Home (220px) and End (480px, never more than half the window).
  - Not modal: nothing here moves focus, except that collapsing it while the keyboard is inside puts focus on the handle.
- **Narrower: a drawer.** Closed by default; the menu button that starts the page links' row (`#navbtn`) opens it. It is a
  modal dialog while open: everything else on the page is `inert`, focus moves into it, and Escape, its × or a tap
  outside closes it with focus back where it was. Crossing 1024px drops an open drawer and keeps the docked choice.
- **Sections.** Each section header is a button (`aria-expanded`, `aria-controls`) that shows or hides its content; the
  header stays. Projects, Plan, Files and Images are remembered in this browser.
- **Status and notifications** are not in the sidebar: they are in the right-hand side panel, whose rail (collapsed) and
  tabs (open) show Status first, then Notifications; a first open shows Status. The header holds neither.
- **Both panels.** On laptops and desktops the sidebar and the side panel can be open at the same time when the
  conversation keeps at least 480px between them (`MAIN_MIN_W`); its column is then centred between the two. When it would
  not, opening one closes the other: opening the side panel collapses the docked sidebar, and opening the sidebar collapses
  the side panel to its rail. When the window narrows with both open, the one opened earlier closes. Resizing either one
  never squeezes the conversation below 480px while the other is open. Below 1024px the sidebar is a modal drawer and the
  open side panel lies over the page, as before.

Remembered per browser in `localStorage["orbit.sidebar"]`: `{ open, width, closed, project }` (`<sidebar-lib>` in
src/web/index.html). Storage that is blocked or unreadable falls back to the defaults.

## Tests

- `test/sidebar.test.ts`: front matter, active projects, plan items, task and note links, locations, photo matching,
  masking and bounds, the note preview; `GET /sidebar` and `/sidebar/note` on the real server with a vault and real photo
  uploads (owner only, nothing of the vault to anyone else, a vault that cannot be read); the remembered layout.
- `test/sidebar-browser.test.ts` (Chromium): docked at 1024, 1280 and 1440 with every section filled from the real
  `sidebarView`; collapse and reopen; resize by keyboard and drag; per-section collapse; choosing a project, a preview and
  the photo viewer; fallback and error states; no status or notifications in it; the phone drawer (modal, inert page,
  focus return, scrim); crossing 1024px; Light and Dark contrast.
- `test/side-panel-browser.test.ts` (Chromium): the right-hand side panel (rail, tabs with Status first, resize, keyboard,
  receipts, status states), with the sidebar collapsed; and both panels together: open side by side at 1440px, one closing
  the other at 1024px, and the earlier one closing when the window narrows.
- The layout and design tests centre the column between the sidebar and the side panel's rail.

## Screenshots

Before (main) on the left, after on the right, Chromium, synthetic content, in `docs/sidebar/`:

```
SHELL_SCREENS_SET=sidebar SHELL_SCREENS_SMALL=1 node test/helpers/shell-screens.ts docs/sidebar /tmp/before.html
```

## Not verified

- A screen reader (VoiceOver, NVDA) was not tried; roles, names and states are checked in the DOM only.
- Real phones and iOS Safari were not used (Chromium emulation only), nor a real vault: the vault parsing follows the
  conventions in AGENTS.md and is tested on synthetic notes, so headings or front matter written differently in Rai's
  notes may show fewer plan items than expected.
