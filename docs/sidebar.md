# Left sidebar

The web page has a left sidebar: Rai's active projects, the plan and related files of the selected project, the photos
that name it, and ORBIT's notifications and live status. It replaces the right-hand side panel (docs/design-system.md,
"Side panel"), and it is the page's main navigation and organisation panel.

## What it shows

Read from `GET /sidebar?project=<id>` (owner only; src/sidebar.ts, src/server.ts). Nothing is mock data: the vault parts
come from the same vault snapshot memory search reads (the writable clone, or the read-only copy, as `vault.source` says),
and the photos from the attachment store.

| Section | Source | Without a project | With a project |
| --- | --- | --- | --- |
| **Projects** | Hub notes `Projects/<name>.md` (top level only) whose `status:` is not done, dropped, archived, cancelled, completed, abandoned or closed | — | The selector's choice, remembered in this browser |
| **Plan** | List items under plan headings (Next actions, Next steps, Plan, Resume here, Now, Focus, Today, Top priorities, To do, Tasks, Actions); checked `[x]` and dropped `[-]` items are left out; a "Resume here" paragraph counts. Then open tasks from `Tasks/*.md` | `now.md`, and every open task (due first) | The project note, and the open tasks whose `project:` names it (`[[id]]`, `[[id\|label]]`, `Projects/id` or `id`) |
| **Files** | Vault notes, each with an on-demand preview (`GET /sidebar/note?path=`) | `now.md` and every active project's hub note | The project note, its tasks (open or not), every other note that links `[[id]]` (the activity `Log/` aside), and the items under its Locations heading |
| **Images** | Photos Rai sent in the Assistant or a chat thread that still exists (archived threads aside), the same reach as the Assistant's photo tools | The newest 24 | Those whose caption or conversation title contains the project's id (as words), title or an alias as a whole phrase |
| **Notifications and status** | `GET /notifications`, `GET /status`, as before | | |

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
- **Notifications and status.** Two tabs (Notifications with the count, Status with the level dot), one view at a time,
  the ARIA tab pattern as before (one tab stop; arrows, Home and End switch). The section's open state and view are the
  same `orbit.header-panels` pair as before (this tab's session; a new tab starts collapsed). The header's bell and status
  dot, and the full indicators at the bottom of the sidebar ("Notifications 5", "● All live"), each toggle their view: they
  show the sidebar on that view (opening the drawer, with focus on the view's tab, on narrow screens), switch to it, or
  collapse the section if it already shows. `aria-expanded` is true only while the view is on screen.
- **Receipts** are unchanged in meaning: sent only for notes listed in a Notifications view that is on screen in a visible
  tab, so a collapsed sidebar, a closed drawer or the Status view sends none.
- **Header.** The words "Notifications" and the status label ("All live", "Degraded: …") are gone from the header; the bell
  with its count and the status dot stay, and their accessible names and hover text still carry the words.

Remembered per browser in `localStorage["orbit.sidebar"]`: `{ open, width, closed, project }` (`<sidebar-lib>` in
src/web/index.html). Storage that is blocked or unreadable falls back to the defaults.

## Tests

- `test/sidebar.test.ts`: front matter, active projects, plan items, task and note links, locations, photo matching,
  masking and bounds, the note preview; `GET /sidebar` and `/sidebar/note` on the real server with a vault and real photo
  uploads (owner only, nothing of the vault to anyone else, a vault that cannot be read); the remembered layout.
- `test/sidebar-browser.test.ts` (Chromium): docked at 1024, 1280 and 1440 with every section filled from the real
  `sidebarView`; collapse and reopen; resize by keyboard and drag; per-section collapse; choosing a project, a preview and
  the photo viewer; fallback and error states; the header toggles, tabs and receipts; the phone drawer (modal, inert page,
  focus return, scrim); crossing 1024px; Light and Dark contrast.
- Existing header, panel, notification, deploy-info, layout and design tests were updated where they asserted the old
  right-hand panel or header labels (one view at a time instead of two independent header panels; the column centred in
  the room right of the sidebar; laptop widths for the notification receipt tests, whose drawer case is in the sidebar test).

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
