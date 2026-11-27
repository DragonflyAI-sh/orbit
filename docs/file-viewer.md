# File viewer and editor

A file chosen in the left sidebar's **Files** section (docs/sidebar.md) opens in the centre of the page: its folder and name at
the top, then an editor or a viewer that fits its type, with **Save** (editable files only) and **Close**. It replaces the
inline preview the sidebar had before.

Code: `src/web/files.js` (file types, the highlighter, the Markdown reader, the editor and the viewer; no framework, nothing from
a CDN), `src/web/index.html` (layout, colours, and the wiring to the sidebar and the server), `src/sidebar.ts` (`sidebarNote`,
`sidebarSave`), `src/server.ts` (`GET`/`POST /sidebar/note`, `GET /files.js`), `src/vault/edit.ts` (the `rewrite_note` edit).
Tests: `test/file-viewer.test.ts`, `test/file-viewer-browser.test.ts`.

## What it does

- **Opening.** Clicking a file in the sidebar opens it in the centre pane. The conversation (or Jobs) and the composer are hidden,
  not closed, while it shows. A file that is already open is switched to, never opened twice; with more than one file open, a
  row of tabs above the path switches between them (arrow keys move along it). The sidebar marks the file that is showing
  (tinted, an accent bar, its name underlined, `aria-current="true"`).
- **Closing.** Close closes the file that is showing; the next open file takes its place, and after the last one the page is back
  where it was. A file with unsaved changes asks first. Choosing a page tab (Home, Assistant, Jobs, Sessions), following a link inside
  the page, or Back hides the viewer and keeps the open files (and their unsaved text) until they are closed; clicking the file
  again shows it. Only a plain click does that: a Ctrl or Command, Shift or Alt+click on a link (the brand, a page tab) is the
  browser's (a new tab or window, or a download), so the file stays in front in this tab. Leaving the page with unsaved changes asks the browser's "leave site?" question.
- **On phones** (the sidebar is a drawer below 1024px) choosing a file closes the drawer and puts focus on the file's name.

| Type (by extension) | View |
| --- | --- |
| Markdown: `.md`, `.markdown` | **Edit** and **Preview** tabs (Edit first). Preview renders headings, bold, italic, strikethrough, inline code, links, wiki links (as text), bullet, numbered, nested and task lists, quotes, rules, fenced code (highlighted when its language is known) and front matter (shown apart). |
| Code: `.ts .tsx .js .jsx .mjs .cjs .py .rs .go .c .h .css .html .sh .yml .yaml .json` | Editor with syntax highlighting (keywords, strings, numbers, comments, functions, types, properties, tags). |
| Text: `.txt .log .csv .tsv .toml .env .ini .conf .cfg` | Plain editor. |
| PDF: `.pdf` | View only: the browser's own PDF viewer in a sandboxed frame, plus "Open the PDF in a new tab". No Save. |
| Image: `.png .jpg .jpeg .gif .svg .webp` | View only: the image, scaled to fit. No Save. |
| Anything else | Plain editor. |

The editor has line numbers, a monospace font and (for code) colours; Ctrl+S (⌘S) saves. It is a textarea laid over a highlighted
copy of the same text with the same metrics, so typing, selection, undo, spell-check settings and screen readers are the
browser's own; the textarea is the only scroll region and the copy and the line numbers follow it. The syntax colours are
`--tk-*` tokens with values for Light and Dark, each at least 4.5:1 against the editor's background (checked in Chromium).

Everything a file says is set as text or built as DOM nodes, never parsed as HTML. In the Markdown preview only `http(s):` and
`mailto:` links are links (they open in a new tab with `noopener noreferrer`); `javascript:`, `data:` and other targets stay text,
and images in a note are shown as a link, not loaded.

## What the vault gives it, and saving

The sidebar's Files list is unchanged (vault notes: `now.md`, project notes, tasks and notes that link to a project). The vault
snapshot ORBIT reads holds **Markdown notes only**, so in practice every file in the list is a note. The code, text, PDF and image
views are built and tested, and the page asks only for `.md` files from the vault: any other path says "ORBIT reads only Markdown
notes from the vault for now". Serving other vault files (a raw-file route and a listing that includes them) is a follow-up.

- **Reading:** `GET /sidebar/note?path=` (owner only) as before, now with `note.editable`, `note.sha` and `writable`.
  `editable` is true only when the text the page gets is the note byte for byte: nothing masked as a secret-shaped value
  (src/vault/filter.ts), no control characters removed, not cut at the 20,000-character bound, not empty. Only then is `sha`
  (SHA-256 of the note) given. `writable` says whether vault writes are on (`vaultEdits` exists). A note that is not editable
  opens read-only, without Save, and says why.
  A note with a carriage return (Windows CRLF line endings, or a lone CR) is never editable and comes with `note.crlf: true`:
  a browser textarea turns every CR into LF, so the editor would show unsaved changes as soon as it opened and a save would
  rewrite every line ending. The page says "Read-only: this file uses Windows line endings (CRLF)…", and a save of such a note
  is refused with `422`.
- **Saving:** `POST /sidebar/note {path, sha, text}` (owner only, policy port `vault.editor-save`, same-origin only like every
  POST). The server checks it against the snapshot (`sidebarSave`: known fields only, a note that is editable, the quoted hash,
  at most 20,000 characters), then hands **one `rewrite_note` edit** to the same pipeline the chat's vault tools use
  (`vaultEdits.apply`, docs/vault-writes.md): path rules and areas, `#rai`/protected/sensitive-detail proposals, secret refusal,
  one commit with the Log line, push without force, and the remote read back. `rewrite_note` applies only while the note in the
  freshly fetched clone still has the quoted hash, so a change made elsewhere since the note was opened (in the snapshot or only on
  GitHub) is never overwritten or merged unseen: the save fails with `precondition_failed` and the editor keeps the text.
- **Answers:** `200 {status: "committed", commit}`; `200 {status: "unchanged"}`; `202 {status: "pending-confirmation",
  proposalId, reasons}` when the policy asks Rai (the page says to confirm it under "Waiting for your click" on the Jobs page;
  nothing is written until then); `409` (changed since opened), `422` (not editable, refused by policy or the secret check),
  `413` (too long), `400` (bad request), `403` (not the owner, or cross-site), `503` (vault writes off, vault unreadable).
- **After a save** the page reads the note back: the saved text becomes the editor's baseline only when the vault now holds exactly
  that. Otherwise it says the vault's copy differs and pauses editing until the file is reopened.

## Tests

- `test/file-viewer.test.ts`: file types; the highlighter for every language is lossless (tokens join back to the input) and finds
  the main token kinds, and is quick on 20,000 characters; the Markdown reader (blocks, inline nodes, unsafe links, unclosed
  fences); `sidebarNote` (editable only byte for byte, no hash for masked, cut, bidi or empty notes; CRLF and lone-CR notes read-only); `sidebarSave`; and on the real
  server over a real vault clone (a bare git repository, synthetic token): read, save, the exact text on the remote with ORBIT's
  commit and Log line, read back, a stale hash refused, unchanged text, a masked note refused, a CRLF note read-only and refused with its line endings kept, a change made on GitHub since the
  snapshot not overwritten, a `#rai` note turned into a proposal, secret-shaped text refused without echoing it, owner only,
  cross-site refused, writes off, and `/files.js` served with `nosniff`.
- `test/vault-review-fixes.test.ts`: `rewrite_note` is on the confirmation card in full, and cannot rewrite ORBIT's append-only log.
- `test/file-viewer-browser.test.ts` (Chromium, real server, real vault clone): open from the sidebar, Edit/Preview, edit and Save
  (button and Ctrl+S) with the remote read back, two files as tabs without duplicates, the sidebar mark, page tabs hiding the
  viewer, Close back to the conversation; the unsaved-changes question; a change on GitHub not overwritten; a CRLF note opening read-only with the reason, no Save and no unsaved-changes question; a `#rai` note needing
  confirmation; code highlighting and line numbers with the textarea and its copy sharing metrics and scrolling together and the
  editor never growing past the window; plain text; PDF and image view-only without Save; an unreadable file; Markdown that tries
  to be HTML staying text; AA contrast of every syntax colour in Light and Dark; the phone drawer closing on open.
- `test/sidebar-browser.test.ts`: a file from the sidebar opens in the centre pane and Close returns.

## Screenshots

Chromium, synthetic content, in `docs/file-viewer/`: `1280-{light,dark}-markdown-edit.jpg`, `1280-{light,dark}-markdown-preview.jpg`,
`1280-{light,dark}-code.jpg` (the code view is driven with a scripted read, as the vault holds notes only).

## Not verified

- A screen reader was not tried; roles, names and states are checked in the DOM only.
- Real phones and iOS Safari were not used (Chromium emulation only). The overlay editor relies on the textarea and its copy
  having identical metrics, which is checked in Chromium only.
- The PDF and image views were driven with scripted sources; ORBIT has no route that serves non-Markdown vault files yet.
- Not run against Rai's real vault or the deployed host.
