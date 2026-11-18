# The Assistant: one rolling conversation

The Assistant is the page that opens at `/` (and `/#assistant`). It is a single conversation, owned by the server and the same on every device, refresh, restart and deploy. Sessions (`/sessions`, formerly Chat at `/#chat`; `docs/threads.md`) are separate: their threads, picker, compaction and stored files are untouched by the Assistant.

Code: `src/assistant-store.ts` (storage, rotation, recovery), `src/assistant-context.ts` (the context bound), routes and wiring in `src/server.ts`, the page in `src/web/index.html` (`<assistant-parts>`, `<status-dot>`, `<routing>` blocks and the Assistant section). The turn itself runs through the same `threadService` (`src/thread-service.ts`) as chat threads, so tools, policy checks, deadlines, proposal cards and confirmations behave identically.

Diagrams of how it works (the page and server sequence, including restarts, and the rolling-memory flowchart): `docs/assistant-architecture.md`.

## How chat threads work today (for comparison)

Read from the code, not from descriptions:

- One JSON file per thread in `<state>/threads/<uuid>.json`. Every change rewrites the whole file atomically (temp file, fsync, rename) through `mutate()` in `src/threads.ts`.
- The model is sent every message after the thread's summary (`buildItems` in `src/thread-context.ts`), with each tool call followed by its result.
- Compaction (`compactThread`): at the start of a turn, if the messages after the summary hold more than 48,000 characters, the oldest are summarized by the model (or a mechanical digest), keeping at least 16,000 characters and 4 messages verbatim. The summary is stored on the thread and sent as a data block. Messages are never removed.
- A rolling recent-work note is built from notable chat threads and given to every chat turn.
- One turn per thread at a time; a second send gets 409.

## How the Assistant differs

| | Chat threads | Assistant |
|---|---|---|
| Conversations | many, client picks by id | exactly one, named by the server (`assistant`); no route takes an id or path |
| Storage | one file per thread, rewritten on every change | one small file per turn ("chunk"), in an active/archive split |
| Context | whole thread after a model-written summary | the newest active chunks that fit a hard character budget; no summary |
| Older content | summarized into the prompt | archived: kept in full, never sent automatically |
| Model-written summaries | yes (compaction) | none; no background model calls at all |
| Rolling recent-work note | read and refreshed | neither read nor refreshed (it is built from chat threads, so it would mix sessions) |
| Page | thread picker, New, Rename, Archive | none of those; Load earlier messages |

Vault retrieval (memory search excerpts), the device summary, the system prompt, the tool list and the policy checks are the same as for chat (`prepare()` in `src/server.ts`), except that the Assistant alone is also offered the read-only session tools `sessions_list`, `session_inspect` and `session_read` (`docs/adr/0001-session-registry.md`). `session_read` returns a bounded, masked excerpt of another conversation's user and assistant messages (at most 30 messages and 12000 characters per call, every answer within the tool-output limit; the first page takes no cursor, and left out, `null` or empty all mean that; continuation passes `nextCursor` verbatim; errors start `invalid-cursor:` or `stale-cursor:` with what to do, see "First read, continuation and errors" in the ADR) as untrusted reference data: never tool outputs or cards, never instructions, and never a claim that the whole session was read. Reading changes nothing in the session read, and does not merge it into the Assistant's context beyond that one tool result. The session tools also list and inspect work sessions (`work:<uuid>`, one per confirmed launch unless explicitly attached to an existing one), each with its origin conversation and its runs' native states; `session_read` on one is an explicit unsupported gap (`docs/adr/0002-work-sessions.md`). The Assistant's conversation store is conversation context only; it is not durable memory and does not write to the vault.

### Session activity digest (automatic, slice 3)

Every owner Assistant turn also gets a small, metadata-only **session activity digest** as reference material: up to 8 other open conversations that have a reply running or a message in the last 72 hours, each with its stable id (`chat:<uuid>`), kind, title and where the title came from, derived activity (`turn-running` or `idle`, last message time), message count, and up to 2 runs that a confirmed card in that session names, with the job store's own state. It is built by ORBIT's code from the session registry for that turn (`prepare(..., "assistant")` in `src/server.ts`, `src/session-digest.ts`): no transcript, archive or excerpt is read, no model is called, and it is never stored in the Assistant's chunks, memory or any transcript, so it is rebuilt every turn and a restart neither loses nor duplicates it. It is at most 6000 characters including its `<orbit-data name="session-activity">` wrapper, sits after the 12,000-character notes cap (which never cuts it), and holds titles only as JSON data. It is not given to chat threads, the legacy `/chat` route or non-owners. It is an observation, not an outcome: the Assistant still checks `jobs_list`/`job_status` before claiming what a job did, and uses `session_read` to see what was said. Contract, budgets, provenance, trust boundary and acceptance steps: `docs/adr/0001-session-registry.md`, "Activity digest (slice 3)".

## Directory layout

```
<STATE_DIRECTORY>/assistant/
  session.json                 { schema, id: "assistant", createdAt }   written once, never rewritten
  epoch.json                   { schema, epoch }   the revision epoch, raised at every start (see "Revisions across restarts")
  active/<seq>.json            chunks that may be sent to the model
  archive/<seq>.json           older chunks: kept, never deleted, not sent automatically
```

`<seq>` is a 12-digit zero-padded sequence number (`000000000001.json`), so names sort in conversation order. Directories are created with mode 0700 and files with 0600. Without `STATE_DIRECTORY` the Assistant lives in memory and the page says a restart empties it (`persisted: false`). Nothing is migrated from chat threads and nothing in `<state>/threads/` is read or written.

A chunk is one turn:

```
Chunk { schema, id (uuid), seq, createdAt, updatedAt, rev,
        state: "open" | "complete",
        messages: [user message, assistant message (with its tool calls and results)],
        cards: Card[]                       proposal cards made in this turn (same shape as chat)
        context?: { budgetChars, historyChars, currentChars, included: [{seq, form, chars}], omitted: [seq] }
        requestId?: string }                the browser's id for the send that started it
```

Messages, calls and cards use the chat thread types and the same masking (`maskContent`, `maskCall`, `safePatch` in `src/threads.ts`), so a secret-shaped value never reaches the disk.

## Budgets (unit: characters)

Characters are counted as chat threads count them (`messageChars`: message text plus every tool call's arguments and output). At roughly 4 characters per token:

| Constant (`src/assistant-context.ts`) | Default | Meaning |
|---|---|---|
| `ASSISTANT_ACTIVE_BUDGET_CHARS` | 32,000 (~8k tokens) | rotation keeps the newest complete chunks whose bounded sizes add up to at most this |
| `ASSISTANT_CHUNK_MAX_CHARS` | 12,000 (~3k tokens) | the largest a single chunk is ever sent |
| `MAX_MESSAGE_CHARS` (existing) | 20,000 | the largest new message the route accepts |
| `ASSISTANT_CONTEXT_BUDGET_CHARS` | 52,000 (~13k tokens) | hard cap on the conversation part of one model input: history plus the new message (= 32,000 + 20,000, so the whole active window always fits beside the largest message) |
| `ASSISTANT_NOTES_MAX_CHARS` | 12,000 | vault excerpts and the device summary are cut to this, with a note saying so |
| `ASSISTANT_CARD_LINES_MAX` | 20 | at most this many proposal-card lines (newest) are given as reference |
| `DIGEST_TOTAL_MAX_CHARS` (`src/session-digest.ts`) | 6,000 | the session activity digest, wrapper included; added after the notes cap, so reference material is at most 12,000 + 6,000 plus the card lines |
| `BOUNDED_OUTPUT_CHARS` / `BOUNDED_TEXT_CHARS` | 1,500 / 4,000 | inside a shortened chunk, each tool output / message text is cut to this |

The chat thread budget is 48,000 characters of live messages; the Assistant's 52,000 conversation cap is of the same order, chosen so the existing model/context settings (the same models, the same 8,000-character tool output clip, the same 20,000-character message cap) need no change.

Within one turn, the model's input also grows with that turn's own tool calls, exactly as in chat (`runChat`: at most 20 tool rounds, see "The per-reply tool-round budget", each tool output clipped to 8,000 characters unless the tool sets its own bound: `vault_policy` does, see "Tool rounds and capability claims"). That growth is the existing behaviour and is not counted in the 52,000.

## The context bound

`planContext` builds the model input for a turn:

1. The new user message (at most 20,000 characters).
2. Complete active chunks, newest first, each in its *bounded representation*, while they fit in the remaining budget. The first one that does not fit stops the walk, so what is sent is always a contiguous, newest run with no gap. Older active chunks that did not fit are reported as `omitted` and are archived by the next rotation.
3. `buildItems` (the chat builder) turns the result into model items, with call ids made unique.

The bounded representation of a chunk (`boundChunk`), tried in order, never changing the stored chunk:

- `full`: as stored, when it is at most 12,000 characters.
- `clipped`: each tool output cut to 1,500 and each text to 4,000 characters; each cut ends with `[ORBIT: … cut from N to M characters for the model's context; the full text is stored in assistant chunk <seq>]`. A cut page of `session_read` or `sessions_list` keeps its `nextCursor` whole at the end, inside the same 1,500 characters, so a later turn can continue where a turn capped by its tool-round budget stopped (`test/session-durability.test.ts`). Likewise a cut write or proposal result keeps its outcome facts (status, saved, proposal id, commit) whole at the end, and `calls-omitted` lists each omitted call with those facts (`test/capability-claims.test.ts`).
- `calls-omitted`: the turn's tool calls are removed as whole pairs (a call is never sent without its result, or a result without its call) and replaced by a one-line note listing them and their outcomes. The note also keeps the newest `nextCursor` of each paged tool (`session_read`, `sessions_list`) whole, with the session id it was reading, so a turn that read more pages than fit even in clipped form (about 7 pages of 1,500 characters fit in 12,000) can still be continued. Tool arguments are never cut, because a cut argument would no longer be valid JSON.
- `placeholder`: one short note stands for the whole turn.

So no message, tool result or argument size can push the conversation past 52,000 characters. The form used is recorded per chunk (`context.included`) and shown on the page ("In the model's context this turn is shortened…").

An interrupted or failed reply keeps its tool calls (paired) and drops its text, as in chat. The open chunk of the turn in progress is never sent as history.

## Rotation and the archive

After every turn (and at startup), `rotate()`:

1. Walks complete active chunks newest first, keeping those whose bounded sizes fit in 32,000 characters; it stops at the first that does not fit.
2. Archives every older complete chunk, oldest first, each by a single `rename` from `active/` to `archive/`, then fsyncs both directories.
3. Stops at a chunk still open (a turn in progress) and at a chunk with a proposal card that can still be confirmed (open, proposal present and not expired). That chunk and everything after it stay active until the card is decided or expires, so a pending confirmation is never moved out of view. The prompt bound still holds meanwhile (step 2 of the plan omits what does not fit).

Rotation is deterministic: the same chunks and cards always give the same split. Archived chunks are never deleted or rewritten except to update a card's state or outcome (a confirmation that settles after its chunk moved, or an open card shown as expired once its proposal is gone).

The archive is never put in the model's context. The page loads it on request, 10 chunks at a time, newest first (`GET /assistant/history?before=<seq>&limit=<1-20>`); only that page's files are read. In memory the server keeps the active chunks and only the sequence numbers of archived ones.

## Concurrency, crashes and replays

- One process, synchronous writes: every change is a read-modify-write of one chunk on a copy, written atomically (temp file, fsync, rename) before it replaces the live copy. No `await` sits between the read and the write.
- One turn at a time. A send while a reply runs (from another tab or device) gets 409 before any vault search or model call, and is not queued. The page keeps the text in the box, says why, and pauses Send while the server reports a reply in progress.
- A user message is written as a new chunk before the model is called; the reply is `pending` and each tool call is stored as it completes (the chat semantics). Deadlines, outcome-unknown calls and late tool results are handled by the shared `runChat`/`threadService` code unchanged: an interrupted call is shown as interrupted or outcome unknown and never retried.
- Crash during a turn: on restart the open chunk's pending reply becomes `interrupted` ("ORBIT restarted before this reply finished. Nothing was retried."), the chunk is closed and becomes history. Nothing is re-run.
- Crash during rotation: each archive step is one rename, so a chunk is always in exactly one directory; a partial rotation leaves a consistent split that the next rotation finishes. If a chunk is ever found in both directories (only possible by copying files by hand), the archived copy is used, the active copy is left untouched and reported in `problems`.
- An unreadable chunk file is reported in `problems`, left untouched, and its sequence number is never reused.
- Replays: each send carries a random `requestId` stored on its chunk. A browser can silently repeat a POST whose connection dropped (Chromium does); a repeat of a send that already started a turn gets 409 `duplicate` and is not run again. After "ORBIT did not answer", the page reloads the conversation from the server and never resends on its own. Ids are checked against active chunks and chunks archived since the process started.
- Two ORBIT processes sharing one state directory are not supported (as for chat threads).

## Revisions across restarts

The view's `rev` orders answers: the page draws an answer only if its `rev` is not below the one shown (`aNewer` in the `<assistant-order>` block of `src/web/index.html`, used for polls and for a send's own answer), so a slow or out-of-order answer never rolls the conversation back. `rev` is `epoch × 2^20 + n` (`src/assistant-store.ts`): `n` counts changes in this process from 1, and `epoch` is raised at every start to at least the last stored epoch + 1 and the wall clock in whole seconds, and stored in `epoch.json` before any revision of it is served (raised again after 2^20 changes in one process). Every revision of a later process is above every revision of an earlier one, so:

- a tab open across a restart or deploy takes the new process's state on its next poll, with no reload and no send. That includes tabs still running the page from before this change (PR #83), whose rule was the same comparison against a counter that restarted at 1;
- a late answer from a process that has since stopped compares lower and is ignored, by the new and the old page alike;
- nothing stored is reset: chunks, the session identity and the archive are not rewritten. A missing `epoch.json` (a store from before this change) is normal; an unreadable one is reported in `problems` and replaced from the clock.

The view also carries `epoch`, for inspection; the page compares `rev` only. Before this change, `rev` was a counter in memory that started at 1 at every start, and an open tab ignored the new process until that counter caught up with the one it held.

## Routes (owner only)

All are refused with 403 for anyone but the owner (`decide("assistant", …)`), before anything is read. POSTs are subject to the existing cross-site refusal.

| Route | Does |
|---|---|
| `GET /assistant` | The active chunks (tool outputs summarized by size), cards with live state, `busy`, `rev` (never lower than any earlier answer, across restarts), `epoch`, `archivedChunks`, what the next turn would be sent (`next`), budgets, `persisted`, `problems` |
| `GET /assistant/history?before=&limit=` | A page of archived chunks, oldest first, and `more` |
| `POST /assistant/messages {text, requestId?, attachments?}` | Runs one turn; returns the view (502 with the view if the model failed; 409 if busy or a duplicate). `attachments`: up to 10 photo ids of the Assistant; `text` may then be empty (docs/photos.md) |
| `POST /assistant/attachments`, `GET /assistant/attachments/:aid` | Upload a processed JPEG; read one of the Assistant's photos (docs/photos.md) |
| `GET /assistant/photos/:ref` | A photo shown in an Assistant gallery (`photos_show`), re-authorized on every request (docs/photo-recall.md) |
| `POST /chat/proposals/:id/confirm|cancel` | Existing routes; a card from the Assistant settles in the Assistant (`cardSvc` in `src/server.ts`) |

## The page

- Navigation: Assistant, Jobs, Sessions (in that order), in the header bar beside the logo. There is no Status link in the page links; `/status` is linked from the status line (below). `/` with no hash, or with a hash that names no page, opens the Assistant; `/sessions` (and the old `#chat` addresses, which move there) and `#jobs` open those pages. For a viewer who is not the owner the Assistant link hides and the page falls back to Sessions (the old behaviour).
- The ORBIT logo header is kept, with a clear downward shadow under its separator line that stays visible over the content scrolling beneath it (the header stacks above the conversation; its overlays, the session picker and the photo viewer, still sit on top). The session title and its picker show only on Sessions (`docs/threads.md`, "The session picker").
- The main content (Assistant, Sessions and Jobs) uses the full width of the page, inside the usual edge padding (16 px, 12 px on a phone); messages, cards, banners and the context line have no fixed reading-width cap.
- Compact header and composers. The header has tight outer padding and compact toggle and link padding (the toggles stay at least 28 px tall). Each composer (Assistant and Sessions) is one row: a "+" button (accessible name "Add image") that opens the image picker (`docs/photos.md`; there is no separate camera button, a phone offers its camera from the picker), the message box, and an icon-only Send (a paper-airplane icon; accessible name and tooltip "Send", disabled while a send is in progress). Both buttons look compact (34 × 34 px, 17 px icons, matching the one-line box, whose inner padding is 5 px by 8 px) but their tap area is larger: 42 px wide and 42 px tall, 46 px tall on touch screens. The message box starts one line tall and grows upward as its text wraps or gains lines (typing, Shift+Enter, paste), up to eight lines, then scrolls inside; deleting text, or the reset after a send, shrinks it again, and text the page puts back after a refused send, a width change or a new placeholder re-measures it. "+" and Send stay level with the box's last line and the composer's bottom edge stays put; the bottom padding allows for a phone's home indicator. Enter sends and Shift+Enter adds a line, as before.
- Assistant: scrolling conversation, the input and Send; no session picker, New or delete. Replies render with the existing Markdown renderer. Each reply's metadata sits in a closed "Details" footer at the end of the message (the same footer as Chat, see [threads.md](threads.md)); inside it are the provenance/model/memory tag and two collapsible panes, closed by default: Tool output (each call with its state, including outcome unknown) and Resource usage (model and provenance, fallback model and cost when reported, tool call count, context characters sent of the budget, shortened or omitted turns, vault notes read, spend-accounting and incomplete notes). Spend-accounting and incomplete warnings, errors and proposal cards (with Confirm and Cancel) are never inside a pane or the footer.
- A line marks where the model's context begins; turns above it (archived, or over budget) are dimmed and labelled as not sent.
- Messages (Assistant and Chat alike, one shared renderer): see "Message rows and times" in `docs/threads.md`.
- Status dot (header, right, every page): green only when `/status` answered with at least one entry and every entry's `state` is exactly `live`. Any other state, an error, an unreadable answer, no answer, or before the first answer: red. The state is in its text, tooltip and accessible name ("All live", "2 not live" with the names, "Status unknown"). It uses the existing 30-second status refresh. It is a toggle button (`aria-expanded`, `aria-controls`), not a link: it shows or hides the status line directly below the header bar, which holds every status pill and an external-link icon that opens `/status` (raw JSON) in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).
- Notifications (header, right, beside the dot): a button with the number of notifications not dismissed in this browser (all of them, not only the three listed), which shows or hides the notifications panel (the existing list with more, ×, show all). ORBIT has no read/unread tracking, so the count says nothing about read. Showing or hiding never dismisses anything. The shown receipt is sent only for notes listed in the open panel of a visible tab (see "Notifications" below), so opening the panel can send receipts. At zero the button says "Notifications: none" and the open panel says "No notifications."
- Both panels are collapsed by default, independent of each other, and remembered for the tab's session (`sessionStorage`), so switching pages or reloading keeps them. Neither opens by itself: a status change or a new notification only updates the dot or the count, and a closed panel keeps updating. Refreshes never move focus.
- The Assistant refreshes every 10 seconds while it is showing and the page is visible (the existing poller), so another device's turns, a reply in progress and card changes appear.

## Notifications

Two separate things, neither of which means read:

- **Shown** is ORBIT's delivery receipt for the web page (`shown` on the notification, the same field as before). The page sends `POST /notifications/:id/ack {"listed": true}` for a note only while that note is listed in the notifications panel, the panel is open, and the tab is visible (`document.visibilityState === "visible"`). It is never sent for a collapsed panel (a new count on the badge is not display evidence), a hidden or background tab, or a note past the list limit (3 unless "show all"). Opening the panel, "show all", a dismissal that moves another note into the list, a refresh while the panel is open, and the tab becoming visible each send it for the notes that have just become listed. The receipt says `Listed in the open notifications panel of the ORBIT web page` and carries `listed: true`. A reviewed run moves to `delivered` on this receipt (or on a Discord receipt), as before.
- **Dismissed** (×) hides a note in this browser only (`localStorage`). ORBIT is not told, other browsers and devices still list it, and it is not a receipt. Collapsing the panel is neither shown nor dismissed.

Server side (`src/notify.ts`, `src/server.ts`), owner-only like the rest of the notification routes:

- `GET /notifications` returns `inbox` (due and not shown, unchanged), `recent` (unchanged) and `current`: notes that are not shown, or shown with a listing receipt, oldest first, including notes that quiet hours hold back from Discord (quiet hours hold pushed delivery only; a job that finishes at 23:30 Pacific is listed then, and reaches Discord at 08:00). The page lists `current`, replacing its list on every refresh, so a reload, another tab, another device or an ORBIT restart lists the same notes (minus what that browser dismissed). The notes are kept in `notifications.json` in the state directory (the last 200), as before.
- `POST /notifications/:id/ack` is idempotent: when the note already has a receipt it is returned unchanged (200), so a retry, a duplicate or a second tab never rewrites the first receipt. 404 is only for an unknown id (it used to mean "already shown" too). With no body (an older page) it records the original `Shown in the ORBIT web page` receipt; an old receipt is never upgraded to a listing receipt.
- A failed read of `GET /notifications` (an HTTP error, ORBIT unreachable, or an answer without a notifications list) is shown in the panel as a failure, never as "No notifications.": before the first good read the count is `?` (labelled "could not be read"); after one, the last list read stays, with the failure said in the panel and the label. A 403 says the notifications are the owner's. "No notifications." and a count of 0 mean ORBIT answered with an empty list.
- The page sends one ack per note at a time and stops once ORBIT has a listing receipt (or answers 404). A failed ack writes nothing and is retried at the next refresh (30 s), panel change or visibility change.

Limits:

- "Listed" is the panel's list, not the scroll position: with "show all" and many notes, a listed note may need scrolling inside the panel to be seen. A visible tab may still be behind another window.
- Receipts written before this change are kept as they are. That includes receipts that the PR #107 page wrote on arrival while the panel was collapsed, and the runs those receipts moved to `delivered`: nothing here can tell those apart from real displays, rewrites them, or brings those notes back. Notes with such a receipt (no `listed`) are not in `current`, so they do not reappear.
- A tab still running the PR #107 page keeps acking on arrival (without a body, so with the old receipt) until it is reloaded, and those notes then drop out of `current`. Reload open tabs after deploying.
- Dismissals live in one browser's `localStorage` (the last 200); clearing it brings dismissed notes back in that browser.

## Tests (all offline, mocked model)

- `test/assistant-store.test.ts`: empty start and fixed identity, separate directory, restart, one turn at a time, interrupted turns, crash recovery of an open chunk, deterministic rotation with no loss or duplication, archive paging and exclusion from context, cards holding rotation and still settling once archived, a chunk found in both directories, unreadable files, masking on disk, bounded chunks for huge outputs/many calls/huge arguments, a randomized check that every plan fits the budget with paired calls and a contiguous newest run, notes cap.
- `test/assistant-server.test.ts`: owner-only routes and cross-site refusal, server-named singleton, isolation from chat threads in both directions, restart continuity, concurrent sends (one runs, the other 409), model failure, end-to-end bound with huge tool output over many turns with rotation, confirm and cancel of Assistant proposals through the existing routes (single use), expired cards after restart, duplicate request ids.
- `test/assistant-restart.test.ts`: revisions across restarts. A store and a real server reopened on the same state directory serve revisions above every earlier one (the regression); repeated restarts, several within a second and with the clock set back; a store from before epochs and an unreadable `epoch.json`; an epoch that fills up; memory-only stores. The page's own `aNewer` rule (loaded from the page) and the PR #83 rule both accept the restarted server and reject a late answer from the old process. Send versus poll ordering across a restart; a turn interrupted by a restart is not re-run. In Chromium against the real server behind a stable address: two open tabs keep updating across three restarts without reload or sending, an answer from the old process does not roll a tab back, a poll held back during a send and a send answer held back behind a newer poll are both ignored.
- `test/assistant-page.test.ts`: status aggregation and routing (pure, always run); in Chromium against a fake server: default page and nav order, explicit `#chat` and `#jobs`, non-owner fallback, status dot transitions (live, degraded, HTTP error, no answer), collapsed panes with visible warnings and a working Confirm, send, 409 and no-answer handling, busy elsewhere, loading archived turns.
- `test/composer-browser.test.ts`: the composer markup (one image input behind a labelled "+", no camera input or button, an icon-only Send named "Send", a one-line box); in Chromium against the real server with a scripted model: Send and "+" by accessible name, keyboard focus rings, sending by click and by Enter (Shift+Enter adds a line) with Send disabled while a reply is held, the "+" file chooser (several images, validation, the image reaching the model), growth with typed newlines, paste and wrapping to the eight-line cap and internal scrolling, shrinking on delete and after a send, re-measuring on resize, on a refused send that puts the text back, on a page switch and on a placeholder change, bottom alignment of "+" and Send with a fixed composer bottom edge, compact header and composer padding, 40 px targets and no sideways scroll at 1280, 390 and 320 px.
- `test/header-panels.test.ts`: the header panels' pure helpers (default collapsed, unreadable storage, count label) and markup (page links in the bar, no Status link, toggles with `aria-expanded`/`aria-controls`, the status indicator saying "has not been read yet" before the first request); in Chromium against a fake server that keeps its notes like ORBIT (a read consumes nothing; nothing is re-queued): link placement and no sideways scroll at 900 and 360 px, the status toggle and its new-tab `/status` link, keyboard use, a collapsed line that keeps updating, a count over the listed limit that follows arrivals and dismissals (no duplicates on repeated refreshes), no receipt while collapsed and receipts for the listed notes only when opened, toggling that never dismisses, independent toggles across refreshes, page switches and a reload, refreshes that leave the message box focused, note text kept as text, light and dark themes.
- `test/notifications-real-server.test.ts`: against the real server (real notifier and runner on a temp state directory). API, always run: `current` versus `inbox`/`recent`, held notes, idempotent acks (retry, second tab, old receipt not upgraded, 404, bad JSON), owner-only routes with no receipt on a refusal, run delivery only on a receipt, notes and receipts across a restart. In Chromium: collapsed arrivals with no receipt and the run still reviewed, then a reload and a restart with the notes still there; opening the panel acks only the listed subset; "show all" acks the newly listed notes and delivers the run; a hidden tab (emulated by overriding `document.visibilityState` and firing `visibilitychange`) sends nothing until visible; a failed ack retried, no repeats, a second tab keeping the first receipt; dismissal per browser, collapsing not dismissing, the unlisted remainder left unshown; the initial status wording.
- `test/session-durability.test.ts`: durability and pagination acceptance with a synthetic long chat (see `docs/adr/0001-session-registry.md`, "Durability and pagination acceptance").
- `test/session-digest.test.ts`: the session activity digest (selection, bounds, runs, failing sources, visibility, adversarial titles, Assistant integration, restart, fallback).
- Existing tests: the nav tests now expect the Assistant link first; the Chat browser tests open `/#chat` explicitly. Nothing else in them changed.

## Tool rounds and capability claims

Why this exists: in a reported incident (reconstructed here only as sanitized fixtures, never from the transcript), Rai asked the
Assistant to plan shell/filesystem access and save it as a vault note. It called `vault_policy` and read helpers, then said it had no
research-launch or vault-write tool and gave an unsaved draft; asked again, it called the policy and paged `session_read` repeatedly,
then said no vault-write tool was available "in this reply"; challenged, it then reported `vault_create_note` success.

### What the code shows (supported causes)

1. **The round cap looked like a missing tool.** `runChat` allowed `MAX_ROUNDS` (then 5; now 20, see below) steps that may call tools; the next step is sent
   with no tools at all. Its instructions then listed no tools and said "None of the tools that read ORBIT's job and operation
   records are available in this reply", and nothing said the tools were withheld because the budget ran out. A model answering that
   step truthfully sees no write tool. Policy + several `session_read` pages exhaust 5 steps, which matches the second turn. And
   `capped` was only set when the final step still asked for tools, so a capped reply that answered in text was not marked at all.
2. **The vault policy never reached the model whole.** `vault_policy` returns AGENTS.md (up to 8,000 characters) plus two documents
   (up to 6,000 each); every tool output was cut at 8,000 characters of JSON. The vault's AGENTS.md is currently about 7,600
   characters, so with the JSON wrapper it alone takes about 7,850 of the 8,000: `System/conventions.md` was cut after its first
   lines and `System/memory.md` never arrived, with only "(truncated)" to say so, and any growth of AGENTS.md would cut the
   authoritative rules themselves. A policy the model is told to obey but only partly sees invites re-reading it instead of acting.
3. **Status lines contradicted the tool list.** The instructions headed every non-live port with "These parts of you are not
   connected yet, so you know nothing from them", including degraded ones that work (a stale vault clone). The memory port's
   fallback detail always said "Vault write tools are unavailable", even when the credential is present and a write would clone first.
4. **The paid fallback withholds tools without naming them.** OpenRouter fallback steps get only `FALLBACK_TOOLS` (no vault writes,
   no session tools) and were told only "You may only use the tools offered in this reply".
5. **Tool descriptions were sent twice** (once in the instructions, once in the request's tool list), and the omitted-call note in
   a shortened Assistant chunk said only `vault_create_note (ok)`, which reads the same for "committed" and "pending-confirmation".

### Hypotheses (not established)

- Which of 1, 3 and 4 applied to each incident turn. The stored reply's `source` (FALLBACK or not), `capped`, and the tool calls on
  the turn would say; the historical provider requests were not recorded, so exactly which tools each step carried is unknown.
- The first turn's claim may also come from the model generalising from status lines or from the clipped policy rather than from
  the round cap (that turn's call count is not known here).
- The later, confident "capability-reporting failure" diagnosis in the conversation is itself a model claim, not evidence.

### What changed

- `runChat` passes each step its position (`rounds`: step, budget, every tool offered). The instructions say how many tool steps are
  left and, on the forced final step, that the budget ran out, which tools are withheld for that step only, and that nothing not
  shown by a tool result was done. The record-check line says the record tools are withheld rather than unavailable.
  `capped` is now true whenever the budget ran out, and the reply carries an owner-visible `incomplete` note (`BUDGET_NOTE`).
- The tool list in the instructions is the names of the tools in that very request (no separate catalogue, no repeated
  descriptions), with: the list is the only authority; earlier claims (including the model's own) are not evidence and should be
  corrected; for a clear request a listed tool can do, call it after any policy check its description asks for; never call a tool
  only to probe it; refused or failed is not absent; never rebuild cut or missing text from memory.
- `vault_policy` has its own output bound (`maxOutputChars`) that fits its three documents and reports `complete` per document.
  Any other cut output now says how much was cut and that repeating the same call returns the same cut.
- Status lines: degraded is described as working with a caveat, and the memory port's write line is derived from the clone's state.
- Fallback steps name the tools withheld in fallback mode.
- Outcome facts (status, saved, proposal id, commit, job/op id; id-shaped values only) survive Assistant clipping, call omission and
  the chat digest/summary input.

Unchanged: every approval, the owner checks, policy refusals, proposal confirmation, secret refusal, round and context budgets, and
the absence of any automatic retry. No reply text is checked or rewritten; no tool is ever called to test whether it exists.

### The per-reply tool-round budget (20) and the no-progress guard

`MAX_ROUNDS` in `src/agent.ts` is the one place the number lives; it was raised from 5 to 20 with Rai's approval after weighing
latency, cost and loop risk. What it counts: **tool rounds within one reply**, that is model steps that asked for at least one tool
call. A step with several parallel calls is one round. User messages, earlier replies and individual calls are not counted, and every
new reply (for example after "continue") starts with a fresh budget.

- Steps 1..20 are offered the tools. If the model still asks for tools after the 20th round, one more step is sent with **no tools**
  and the instructions say the budget ran out (`TOOL-ROUND BUDGET EXHAUSTED`); any calls that step asks for are never run. So a reply
  makes at most 20 tool rounds and 21 model requests, and always ends with an answer the model wrote without tools. The reply is
  marked `capped` with `BUDGET_NOTE` beside it.
- It is a ceiling, not a target: the loop ends at the first step that answers without calling a tool, and every tool step's
  instructions say "This is a ceiling, not a target: answer as soon as you can". Most replies use 0-3 rounds as before.
- The instructions on every tool step say "this is step N; at most 20 steps … (K left, this one included)", built from the same
  counter and constant the loop enforces (`roundGuidance` in `src/model.ts`, used by the ChatGPT, OpenAI and OpenRouter adapters),
  so the number the model is told cannot drift from the number enforced.
- The final no-tool step asks for an honest summary: what was completed and what is still pending, only what tool results show, a
  failed, refused or uncalled tool did nothing, a proposal is not a completed action.

**No-progress guard.** With 20 rounds a model that keeps repeating a failing call could waste many steps. `runChat` keeps, per
reply, the last failure of each distinct call (tool name + arguments, keys sorted). When the identical call has failed with the
identical result `REPEAT_FAILURES_MAX` (2) times in a row, a further identical request is **not run**: it never reaches the policy
check or the tool, is recorded as a failed call, and the model gets `{ok: false, notRun: true, error: …}` saying nothing ran. If every
call of a round was such a blocked repeat, the next step is the final one, without tools, and its instructions say
`TOOL CALLS STOPPED FOR LACK OF PROGRESS`, explicitly that this is not the round budget, and that the tools still exist; the reply
gets `stalled: true` and the owner-visible `NO_PROGRESS_NOTE` (not `capped`). What it does not touch: a call that succeeded (polling
the same job), changed arguments (pagination with a new cursor), or a retry whose error changed or that succeeded in between: each
resets or avoids the count. It only stops an exact repeat after two identical failures; it does not detect loops that vary their
arguments, which the 20-round ceiling still bounds.

**Tradeoffs and bounds that did not change.** Latency and cost grow only for replies that actually need the rounds: each round is one
more model request (and re-sends the growing input). There is still **no whole-turn deadline**: a reply is bounded by at most 21 model
requests, each under the model request deadlines (`docs/model-request-deadlines.md`: ChatGPT 120 s to headers, 300 s idle, 600 s
total), and 20 rounds of tool calls, each call under its own deadline (180 s by default, `docs/tool-deadlines.md`). The theoretical
worst case is therefore much longer than before (it was 6 requests and 5 rounds); in practice a turn is ended earlier by the model
answering or by the guard. `runChat` supports cancellation (`signal`: the request in flight is aborted and nothing new starts), but
**no route passes a signal yet** (`src/thread-service.ts`), so Rai cannot stop a long turn from the page; the thread or Assistant
stays busy for the whole turn and a second send gets 409. A cancel control is a separate change. Within a turn the model's input grows with every tool result (each output bounded to 8,000
characters unless the tool sets its own bound); that growth is not part of the 52,000-character conversation cap, so a 20-round reply
sends larger requests in its late steps. In later turns a long reply's calls are shown in `calls-omitted` form more often (the chunk
cap is 12,000 characters); outcome facts and the newest page cursor are kept. The image budget (`MEDIA_CALLS_MAX`, per-reply image
and byte caps), gallery caps, OpenRouter spend caps and output bound, and every owner, policy and confirmation gate apply per call or
per reply exactly as before. `tools/capability-eval/eval.ts` derives its hard request bound from `MAX_ROUNDS`, so that owner-run
(possibly paid) evaluation's upper bound grew from 6 to 21 requests per scenario without its own `maxRounds`.

### Skills and the comparison with Rai's OpenClaw workspace

No skills framework was added. Every supported cause above is in tool plumbing or in instructions generated from the live tool list;
a skill (more prompt text loaded on demand) would add another catalogue to keep in step with the registry, without addressing the
round cap, the clipped policy or the status lines. Revisit only if evaluation shows a specific multi-step workflow (for example
"draft, check policy, save") still failing with the tools exposed and the budget sufficient.

The comparison with `phairow/raiclaw` was **not done**: that repository is not available to the job runner, and the job did not
broaden its access. To do it, Rai can provide redacted excerpts of: the core system/agent instructions (the section on tool use and
capability claims), any "skills" or workflow files that cover saving notes or confirmations, and how that workspace reports a tool
budget or a refused tool. No credentials, hostnames or private notes are needed.

### Tests and evaluation

- `test/tool-rounds.test.ts` (deterministic, offline, mocked loop): a task needing more than 5 rounds completes uncapped; exactly 20
  tool rounds run and no 21st; the final no-tool step's answer is the reply; early completion; parallel calls count as one round;
  policy refusal, cancellation and the tool deadline in late rounds; the no-progress guard (identical failures stop, pagination,
  polling and progressing retries do not, mixed rounds carry on, refused repeats never reach the policy check); the instructions sent
  through the OpenAI, ChatGPT and OpenRouter-fallback adapters; `/chat`, a chat thread and the Assistant completing a 7-round reply
  whose late `job_launch` still waits for Confirm.
- `test/capability-claims.test.ts` (deterministic, offline): exposed vault write with an explicit save (chat and Assistant, real
  OpenAI adapter request bodies over a fake fetch, real vault fixture); absent tool; exposed but refused; exposed but unconfigured;
  pending confirmation vs committed; tool errors; budget exhausted (loop, Assistant record, paid fallback); a history carrying the
  false claim and a clipped draft; large policy; cut-output note; retry after success (refused, one commit); research launch truthful
  and only proposed; evidence surviving shortening; secret refusal, protected path and untrusted-text boundaries unchanged.
- `test/capability-fixture.ts` + `tools/capability-eval/eval.ts`: synthetic scenarios scored against a LIVE model. Owner-run and
  possibly paid; refuses unless `--confirm-synthetic-live-eval`, `--key-file` and `--model` are given; bounded request count; tools
  are doubles that write nothing. `test/capability-eval.test.ts` checks the harness with scripted models only. **No live run was made
  by the job that built this.**

### Acceptance by Rai (manual)

1. Assistant: ask it to draft a short plan and "save it to the vault as Projects/<name>.md". Expect a `vault_create_note` call and a
   reply that says saved only with a commit; the call list shows `status committed`.
2. Ask for something that needs many reads first (for example "read the whole <long chat> and then save a summary"). If it runs out
   of rounds, the reply should say the tool-round budget ran out (not that a tool is unavailable), the details show "round limit
   reached" and the budget note, and "continue" should then save.
3. Ask for a note under `System/`: expect a proposal card and "waiting for your confirmation", never "saved", until you confirm.
4. Optional, paid: run `tools/capability-eval/eval.ts` as its header says and read the JSON report.

## Manual browser acceptance (not performed by the job that built this)

On a deployed ORBIT, as the owner:

1. Open `/`: the Assistant is selected, first in the nav; the conversation is empty on first use; the header shows the ORBIT logo, the page links, the notifications count and the status dot; the status line and notifications are closed.
2. Click the dot: the status line opens under the header with every pill; its link icon opens `/status` in a new tab. Click the notifications count: the list opens; dismiss one and check the count drops. Reload: both panels stay as you left them, and the undismissed notes are still listed. With the panel closed, queue a notification (`POST /notifications`) and check in `GET /notifications` that it has no `shown` until you open the panel.
3. Compare the dot with `/status`: green only if every entry says `live`; stop a non-model port or wait for a stale one and check it turns red with the port named in its tooltip.
4. Send a message; reload the page; open `/` on a second device: the same conversation appears.
5. Ask for something that uses a tool: the reply shows a closed "Details" footer; open it, then "Tool output" and "Resource usage" inside it, with the keyboard (Tab, Enter).
6. Ask ORBIT to propose a job; check the card is visible outside the panes; Cancel it, then propose again and Confirm; check the card shows the job id and that the job exists under Jobs.
7. Send from two tabs at once: one gets the reply, the other says a reply is in progress and keeps its text.
8. Open `/#chat`: threads, picker, New, Rename and Archive work as before and the Assistant's messages are not there.
9. After many long turns, check "Load earlier messages" appears and loads older turns marked as not sent; check `<state>/assistant/archive/` holds them.
10. Restart ORBIT during a reply: after restart the reply shows as interrupted and nothing was repeated.
11. Check the page at phone width: no horizontal scrolling; Send and the panes are reachable.
12. Leave two tabs open on the Assistant, restart ORBIT, and send from a third device: both tabs show the new turn within about 10 seconds without reloading (repeat for a second and third restart; full steps in `docs/assistant-architecture.md`).

## Limits

- The budget is in characters, not tokens; a text in a script with many tokens per character can use more tokens than the estimate.
- A turn's own tool rounds can add up to the existing `runChat` limits on top of the 52,000-character conversation cap.
- While a confirmable card is pending, the active window can exceed 32,000 characters for up to the proposal lifetime (30 minutes); the prompt bound still holds.
- Request ids are remembered for active chunks and for chunks archived since the process started; a repeat of a very old send after a restart is not recognized (the browser only repeats within one request).
- Revision order between processes depends on `epoch.json` (or, without a state directory, the clock). If `epoch.json` is lost and the clock is also set back, or the state directory is restored from a backup with an older `epoch.json`, open tabs ignore the new process until they are reloaded.
- Not verified in a real deployment or with a real model; see the acceptance steps above.
