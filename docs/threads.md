# Server-side chat threads

Chat history used to live in a JavaScript array in the page and was sent to the server as text (the last 40 messages). A refresh, another device or a deploy lost it, and earlier tool calls and results never reached the model. Threads move the history to the server. They are shared by every device, owner only, kept until archived, and never deleted automatically.

The page shows threads as **sessions** on the Sessions page (`/sessions`, formerly Chat; see "Addresses"). The Assistant page (one rolling conversation, `/#assistant`) is separate and described in `docs/assistant.md`; it shares the turn code but not this storage, compaction or the rolling note.

Code: `src/threads.ts` (store), `src/thread-context.ts` (model context, compaction), `src/thread-service.ts` (a turn, cards, live state), `src/recent-context.ts` (rolling note), `src/duplicates.ts` (duplicate-launch warning), routes in `src/server.ts`, page in `src/web/index.html`.

## Storage and schema

One JSON file per thread in `<STATE_DIRECTORY>/threads/<id>.json` (id is a UUID), plus `meta.json` for the one-time notice. Without `STATE_DIRECTORY` threads live in memory and `GET /threads` says `persisted: false`. Files are written atomically: a unique temporary file, `fsync`, then `rename`. Nothing is deleted by ORBIT, ever: archiving only flips a flag.

```
Thread   { schema, id, title, titleSet, createdAt, updatedAt, archived, archivedAt?, rev,
           messages: Message[], cards: Card[], summary?: Summary, compaction?: { lastError? } }
Message  { id, role: "user"|"assistant", at, text, status?: pending|done|error|interrupted, error?,
           calls?: Call[], cards?: string[] (card ids), memory?: string[], provenance?, source?, capped? }
Call     { callId, name, arguments (the JSON string the model sent), output (the JSON the model received:
           ok, provenance, source, result), ok, provenance?, source?, summary, at }
Card     { id (= proposal id), kind: job_launch|job_steer|ops_admin|ops_sys, state, createdAt, expiresAt, decidedAt?,
           display fields (routine, brief, job, text, action, summary, display, warnings, digest), duplicates?,
           outcome?: { jobId?, opId?, steerN?, httpStatus?, error? } }
Summary  { text, covers (how many leading messages it stands for), at, method: model|extractive, degraded? }
```

An assistant message with tool calls is one stored unit: its calls (each with its result) in order, then its text. A call and its result are never separated, so the model input is always valid.

Secrets are masked before anything is written (`maskText` in `src/threads.ts`): routine trigger ids become `trig_…last4`, and everything else goes through the same `redact()` the ops helpers use (bearer tokens, API keys, JWTs, private keys, `password=`-style pairs, and any 32+ character opaque string; a 40-hex git commit is kept). It applies to user text, titles, tool arguments and results, summaries, errors and card display data, so the masked form is also what the page shows and what the model is sent. Consequence: UUIDs and other long ids inside stored tool results appear as `[redacted]` (cards keep their own ids and digests unmasked, because the Confirm button needs them). Card `brief` and `text` are masked for display; if masking changed a brief the card says so, and the launch itself still uses the brief the proposal held.

## Routes

Every route is owner only (`decide("threads", ...)`, 403 for anyone else, checked before the thread is looked up, so a stranger learns nothing). Every POST is subject to the existing cross-site refusal.

| Route | Does |
|---|---|
| `GET /threads[?archived=1]` | List (newest activity first), the one-time `notice`, `persisted`, unreadable files in `problems`, recent-context status |
| `POST /threads {title?}` | Create |
| `GET /threads/:id` | Open: messages (tool results are summarised, not sent in full), cards with `live`, `summary`, `busy` |
| `POST /threads/:id/rename {title}` | Rename (1-100 chars, masked) |
| `POST /threads/:id/archive {archived?}` | Archive (default) or restore with `archived:false`; data is untouched |
| `POST /threads/:id/messages {text, attachments?}` | Continue: runs one turn and returns the thread (502 plus the thread if the model failed). `attachments`: up to 10 photo ids of this thread; `text` may then be empty (docs/photos.md) |
| `POST /threads/:id/attachments`, `GET /threads/:id/attachments/:aid` | Upload a processed JPEG into this thread; read one of this thread's photos (docs/photos.md) |
| `GET /threads/:id/photos/:ref` | A photo shown in one of this thread's galleries (`photos_show`); only this thread's own photos, re-authorized on every request (docs/photo-recall.md) |
| `POST /threads/notice/ack` | Dismiss the one-time notice for every device |
| `POST /chat/proposals/:id/confirm|cancel` | Existing routes; they now also settle the card |

The old `POST /chat` (client-sent history) is kept unchanged for API callers and for the page when the viewer is not the owner; the owner's page does not use it. It stores nothing.

## Addresses

In the page these threads are called **sessions**, shown under the **Sessions** page link (it was called Chat before). Internal names and the API (`/threads/...`, `POST /chat`, `/chat/proposals`) are unchanged.

Each session has its own page address: **`/sessions/<session id>`** (the canonical form: the lowercase UUID, unencoded). The address is what a tab shows, so two tabs (or two windows) can have two different sessions open at once and each keeps its own across a reload. The server serves the page itself at `/sessions` and `/sessions/<one path segment>` (`isPageRoute` in `src/server.ts`, the same page as `/`, for anyone: the thread routes still decide who may read what, with the same owner checks), so a direct link and a reload work. Which session a path names is the page's business: it fetches `GET /threads/:id` and posts to `POST /threads/:id/messages` with the id from the address, as before. Deeper paths (`/sessions/a/b`) are not page addresses (404).

| Address | What the tab does |
|---|---|
| `/sessions/<id>` (a link, a typed address, a reload) | Opens that session. The stored selection is ignored. An uppercase or percent-encoded copy of a real id opens it and the address is rewritten to the canonical form in place. |
| `/sessions` (plain; the Sessions link) | Fallback: if a session is already open in this tab, keeps it; otherwise opens the session last opened in this browser (`localStorage` `orbit.thread`, shared by all tabs), else the newest open session, else the empty state. The address is then **replaced** with that session's, so Back never lands on an unresolved `/sessions`. With no sessions, the address stays `/sessions` until the first send creates one. `/sessions/` is rewritten to `/sessions`. |
| `/sessions/<anything else>` (not a UUID, bad percent-encoding) | Nothing is fetched. The conversation area and the status line under the header say the address does not name a session; Send is disabled. |

**Old Chat addresses** keep working and land on the same session, never on a different one:

| Old address | What happens |
|---|---|
| `/#chat/<id>` (a bookmark; also a gallery's stored "Open conversation" link `#chat/<id>`, followed from any page address) | The page replaces the address, in place (no extra history entry, so Back cannot bounce to it), with `/sessions/<id>`, keeping the query. Same id rules as above. |
| `/#chat`, `/#chat/` | Replaced with `/sessions` (keeping the query), then as plain `/sessions`. |
| `/#chat/<anything else>` | Left as it is, and reported as above: an invalid fragment is never turned into a path. |
| `GET /chat`, `GET /chat/` | The server answers `302` to `/sessions`, keeping the query (the browser keeps any fragment). |
| `GET /chat/<id>` (any case) | `302` to `/sessions/<lowercase id>`, keeping the query. Only a UUID is redirected; the target is built from a fixed prefix and the validated id, so it is always same-origin. Anything else under `/chat` (for example `/chat/proposals`, or `/chat//elsewhere`) is not redirected and answers as before. `POST /chat` is the legacy API and is never redirected. |

`#assistant` and `#jobs` followed from a Sessions address move to `/#assistant` and `/#jobs`, where those pages live; the Assistant is still `/`.

- **No reloads between pages.** Links within the page (the page links, a gallery's link to a session) switch views with `pushState` instead of loading the page again, so the draft in the message box, the photo tray and a reply in flight are kept. Modified clicks (new tab, new window) are left to the browser. Back and Forward (`popstate`, and `hashchange` for an edited fragment) apply the address; the page's own updates fire neither, so there is no loop.
- **Picking a session or New** adds a history entry with the new address (only once the session has opened). Starting a session by sending from the empty state replaces `/sessions`. Archive moves on like a pick.
- **Back/Forward** open the session the address names. They never create a session.
- **The address is authoritative for its tab.** Other tabs write the shared stored selection; it is only the plain-`/sessions` fallback, and the page has no `storage` listener, so another tab never moves this one.
- **Missing, deleted or refused sessions.** When the address names a session that answers 404 (also when it is deleted while open: the next poll, within 10 seconds, reports it), 401/403, another error or no answer, the tab shows no session, says why (with Try again) and sends nothing: a message is never sent to, and no new session is started in place of, a session other than the one the address names. Choosing a session or New recovers. A failed pick from the picker keeps the old behaviour (the session shown stays, the address stays on it).
- **Requests are bound to their session.** Every load, poll and send carries its thread id and the navigation generation it started in; an answer that arrives after the address (or the picker) moved on is dropped and draws nothing (transcript, errors, cards). As before, one tab sends one message at a time (Send stays disabled until the reply is in, whichever session is shown); another tab is not held up. The late reply stays in its own session and shows when that session is opened again. Nothing is resent automatically. Text typed in the box stays with the box (it goes where the address is when Send is pressed).
- Non-owners (no sessions, the legacy stateless page) given a `/sessions/<id>` address are told sessions are owner only and nothing is sent; plain `/sessions` works as the old plain `#chat` did. The Assistant and Jobs addresses are unchanged.
- The tab's title is `<session title> · Sessions · ORBIT` on Sessions, `Jobs · ORBIT` on Jobs and `ORBIT` on the Assistant.

### The session picker

The header shows the open session's title and a chevron in the bar itself, between the page links and the notification and status toggles; there is no separate session toolbar. A long title is cut with an ellipsis to the room left in the bar (it never pushes the toggles or scrolls the page sideways); its full text is the button's hover text and its accessible name (`Session: <title>. Show sessions`, with "(archived)" for an archived one). The button (`aria-expanded`, `aria-controls`) opens the picker, which overlays the page under the header (it does not push the conversation down) and holds:

- **New session**, and **Show archived** (archived sessions are listed only with it, marked "(archived)", as the old menu did);
- the list of sessions (marked current with `aria-current`; "· n waiting" and "· replying…" as before), scrolling inside the picker when it is long;
- **This session: Rename** (a prompt) and **Archive** / **Restore** (same server routes and semantics as before: archiving only flips the flag, an archived session takes no messages until restored).

It closes with Escape, the button, a click outside it, focus moving out of it, or a choice; Escape and a choice put focus back on the button (New puts it in the message box, as before). Opening it focuses the open session's entry (or New session when there is none). Up/Down, Home and End move through the list; Down on the closed button opens it. Entries are at least 40px tall (44px on touch screens). Status messages ("Opening …", what failed) show on a line under the header only while there is one.

Server side, nothing about sessions needed changing beyond serving the page at its addresses: every thread route takes the id from the path (`/threads/:id...`, `src/server.ts`), and the one-reply-at-a-time lock is per thread (`tryBegin(id)` in `src/threads.ts`, used by `turn()` in `src/thread-service.ts`), so two tabs on two sessions run two turns at once and a busy session blocks only itself (`test/threads.test.ts`, "a reply in progress in one thread does not block…"). Two tabs on the **same** session share it as two devices always did: the second send while a reply runs gets 409.

Tests: `test/chat-address.test.ts` (address parsing and canonical forms always run; in Chromium against a fake server: direct link, reload, plain `/sessions`, canonicalizing, legacy `#chat` bookmarks and links, the empty state, pick/New/Back/Forward, switching pages without a reload, invalid, missing, deleted and refused addresses, late history/poll/send answers after the address moved, and two tabs of one browser sending concurrently); `test/server.test.ts` (the page at the `/sessions` paths, the `/chat` redirects, the `/chat` API routes unchanged); `test/acceptance-browser-real-server.test.ts` (canonical and legacy addresses, reload, Back/Forward and where a send lands, on the real server); `test/sessions-picker-browser.test.ts` (the header control and picker at desktop and phone widths, on the real server).

Manual two-tab check (owner, two sessions A and B):

1. Open A in tab 1; the address becomes `/sessions/<A>`. Copy it.
2. Open a second tab at `/sessions`, pick B from the header picker; its address becomes `/sessions/<B>`.
3. Send a message in tab 1 and, before it answers, one in tab 2. Each reply appears only in its own tab and session.
4. Reload tab 1: it still shows A (although tab 2 opened B last). Reload tab 2: still B.
5. In tab 2 pick A, then press Back: B again, with no new session in the picker. Forward: A.
6. Open `/sessions/not-a-thread` and `/sessions/<a made-up UUID>`: each says why, Send is disabled, and nothing appears in any session.
7. Open an old bookmark `/#chat/<A>` and the path `/chat/<A>`: both end at `/sessions/<A>`, showing A.

## Message rows and times

Chat and the Assistant draw messages with the same parts (`messageParts` in `src/web/index.html`; the Assistant adds its collapsible panes). The list is one left-aligned column for Rai and ORBIT, with no bubbles and no left/right split. Every message is its own row, never grouped: the sender's icon (ORBIT's own `/avatar.png`, or Rai's initial; no outside avatar service), then a line with the sender's name and a small muted time, then the content (text or Markdown, code, tables, photos, galleries, tags, warnings, tool calls, proposal cards) in one content column. The senders differ by icon and name, so color is never the only cue; each keeps its color in the name and in a thin line down the content's left edge, never as a background. On a narrow screen the icon column shrinks and nothing scrolls sideways.

The time is the `at` ORBIT stored with the message: when a user message was received, and when a reply started (a reply keeps that time while it runs and after it finishes). Nothing new is stored and no stored time is changed or back-filled. It is shown in ORBIT's configured owner zone (`src/time.ts` `ZONE`, written into the page's `orbit-time-zone` meta tag by the server), on that zone's calendar days, so midnight and daylight-saving changes fall where the owner's clock puts them: today shows the time ("9:00 PM"), the day before "Yesterday at 9:00 PM", earlier days "Nov 3 at 12:15 PM", and another year "Dec 31, 2025 at 3:00 PM". Labels follow the clock (checked every 30 seconds and when the tab becomes visible), so a message from 11:58 PM becomes "Yesterday at 11:58 PM" after midnight without a reload.

The time is a button holding a `<time datetime>` element. Its accessible name, and a tip shown on hover, on keyboard focus and on a tap (`aria-expanded`; a tap elsewhere or Escape closes it), give the weekday, the full date, the time to the second, the zone's abbreviation (PST or PDT) and the zone's name. Rows the page has not had stored never show a time: the reader's own message while it is being sent says "Sending…", ORBIT's placeholder "Waiting…", and an error note or a reply in the no-history chat "Not saved". A missing or malformed stored time (only an ISO 8601 time with a zone is accepted) says "Time unknown"; it is never guessed. If the page has no usable configured zone it uses the browser's own and names it in the full time.

## Concurrency and atomicity

The service is one Node process. Every change to a thread is `mutate(id, fn)`: a synchronous read-modify-write on a copy that is written to disk first and only then replaces the live copy. There is no `await` between the read and the write, so concurrent requests cannot overwrite each other (a rename during a reply is kept), and a failed write changes nothing and returns 500. Two processes sharing one state directory are not supported.

A thread runs one reply at a time: a second `messages` request, or an archive, while one is running gets 409. The assistant message exists as `pending` from the start of the turn and each tool call is stored as it completes, so a model error or a crash mid-turn leaves the user message and every call that really ran on record (the reply is `error`, or `interrupted` after a restart). A thread file that cannot be parsed is reported in `problems` and left untouched. Cost: each change rewrites the thread's file; fine for chat-sized threads.

## Context sent to the model

`buildItems` (`src/thread-context.ts`) turns the stored thread into the Responses API items the adapters already use: user and assistant messages, and each tool call as `function_call` followed by its `function_call_output` (call ids made unique across the input). Only messages after the summary are sent. The browser sends only the new text. Reference material goes in the instructions as `<orbit-data>` blocks, which the system prompt calls data, never instructions: vault excerpts, the rolling recent-work note, the thread summary, and one line per proposal card from the records (state, job or operation id, the record's current state), so a confirmed card is not offered again. Stored content cannot close its own block (`</orbit-data` is neutralized).

The system prompt (`recordCheckInstruction` in `src/model.ts`) asks ORBIT to check `jobs_list`, `job_status`, `ops_admin_operations` or `ops_sys_operations` in the same turn before claiming a job or action did or did not happen, to treat summaries, notes and cards as not proof, and to check for an existing equal job before proposing one. This is a request. Tests show it is in the prompt and in the request the adapter sends; nothing can show a model will always obey, which is why card states and job state on the page come from the records themselves.

## Compaction

Budget, per thread (`src/thread-context.ts`): when the messages after the summary hold more than `CONTEXT_BUDGET_CHARS` = 48,000 characters (text plus tool arguments and results, roughly 12k tokens), the oldest ones are summarized. At least `KEEP_RECENT_CHARS` = 16,000 characters and `KEEP_RECENT_MESSAGES` = 4 messages stay verbatim, and the kept part starts at a user message, so a turn (and any call with its result) is never split. The check runs at the start of a turn, before the model call.

The summary (at most 6,000 characters, masked) is stored in `thread.summary` with `covers` = how many leading messages it stands for. No message is changed or removed; the page still shows all of them and marks where the summary starts. A later compaction summarizes the earlier summary plus the newly old messages. The model is told the text is data to summarize, not instructions. If no real model is connected (mock) a deterministic digest is used and no model call is made. If the model fails, a mechanical digest is stored instead, flagged `degraded` with the error, and shown on the page; if even storing fails the thread is left exactly as it was and the error is recorded. A summary failure never blocks the reply. A summary is never empty: a model answer that is empty, whitespace or only invisible characters (zero-width spaces, blank braille, Hangul fillers) counts as a failed call, and `setSummary` refuses an empty text outright. A failed call stores the mechanical digest instead, marked `degraded` (shown on the page and noted to the model); the digest is bounded to 6,000 characters and, when it cannot hold everything, says in its own first line (and in `degraded`) how many of the oldest messages it omits and whether the earlier summary was cut. If even the digest is unusable nothing is stored and the cutoff does not move. A stored summary with no usable text (written before this rule) covers nothing: `buildItems`, the budget and the cutoff ignore it, so the full thread is sent, the page says the summary is not used, and the next compaction replaces it.

## Rolling recent context

A short note (at most 1,500 characters) about Rai's recent work and open questions, given to every thread as a data block marked possibly stale and not verified. It sits behind `RecentContextPort` (`read`, `write`, `describe`, all async) in `src/recent-context.ts`. `stateRecentContext` keeps it in ORBIT's state (`recent-context.json`) and is used when there is no state directory (and in tests). Otherwise `vaultRecentContext` stores it as `Memory/recent-context.md` through the vault write pipeline (same policy, secret refusal, Log line and git push as every vault write; no bypass), and falls back to reading the old state note until the vault has one. A save that cannot happen (no credential, sync or push failure, a secret-shaped value, a new sensitive category that needs Rai's confirmation) throws, so the old note stays, `lastError` in `GET /threads` says why and `describe()` says the note is not being updated. See `docs/vault-writes.md`.

Refresh criteria: after a reply, a thread is notable when it has at least 3 user messages, or any proposal card, or any call to a job or ops tool; a notable thread that changed since its last attempt triggers a rewrite at most every 10 minutes, and archiving a notable thread asks for one immediately. Rewrites run one at a time in the background, never throw, and keep the old note on failure (the error is shown in `GET /threads`). The rewrite prompt includes the cards' recorded states and tells the model to mark anything a message merely claims as unverified. A mock model never rewrites.

## Proposal cards

A proposal made by a tool call is stored on the thread as a card. States: `open`, `confirmed`, `cancelled`, `expired`, `refused`.

- `open`: waiting for a click. It becomes `expired` when its proposal's time is up or the proposal is gone (a restart drops open proposals), which is applied whenever the thread is read.
- `confirmed`: the owner confirmed it and the confirmation produced a job id, an operation id or a steer number, stored in `outcome`. The page shows the id and the live state read from the jobs record or the admin/sys ledger at that moment (`live`), never a success inferred from the confirmation; "accepted", "running" and "registered" are shown as such. If no id was recorded (for example ORBIT restarted mid-launch) the card says so.
- `cancelled`: the owner cancelled. `refused`: the confirmation failed before anything started (helper refused, job gone, launch precondition failed); the proposal is spent, so ORBIT must propose again.

A launch card's proposal is bound to the conversation whose turn made it (server context, never model text), and its confirmation records a work session and run link before the launch, so the job, its work session (`work:<uuid>`) and this conversation stay linked across restarts; a repeat confirmation answers with the same link. See `docs/adr/0002-work-sessions.md`.

Single use has two guards that must both agree and are both synchronous: `proposals.take()` (the existing store) and a compare-and-set of the card from `open`. Of any number of concurrent or retried confirmations exactly one executes; the others get 404/409 with the card's state. The privileged boundaries are unchanged: owner check, digest for `ops_admin` and `ops_sys` cards (a wrong digest changes nothing and leaves the card open), and the helpers' own checks.

Duplicate-launch warning (`src/duplicates.ts`): a launch records the distinct words of its brief on the job (`launch.briefWords`, not the brief). A new `job_launch` proposal is compared with jobs launched in the last 24 hours, in any state: briefs match when the smaller word set has at least 8 words and the Jaccard similarity of the sets is at least 0.7. The proposal is still made; the warning is on the card and in the tool result the model reads. Jobs launched before this feature have no signature and cannot match.

## Migration

Nothing is imported: the old history existed only in browsers, so ORBIT cannot see it. On first load `GET /threads` returns a one-time `notice` saying so; the page shows it with a "Got it" button, and `POST /threads/notice/ack` records it in `meta.json` so it does not return on any device or after a restart. The page remembers the selected thread id per device in `localStorage` (guarded, optional) and otherwise opens the most recently active thread; it re-fetches the open thread every 10 seconds while the Chat tab is visible, so another device's messages and card changes appear. Each re-fetch is drawn incrementally (`reconcileChildren` in `src/web/index.html`): messages are keyed by thread and message id, cards by card id, and every part of a message by a signature of what it shows, so an unchanged message keeps its DOM nodes and with them the reader's text selection, focus and inner scroll positions; only a reply in progress or a card whose state changed is redrawn. The log follows new messages only when the reader was already near the bottom and is not selecting text. A slower, older answer (a late poll, a thread the reader has left, a lower `rev`) is dropped rather than drawn.

Navigation beats polling. Picking a thread, New and Archive are navigations: each bumps a generation counter synchronously and marks the page pending until its own answer is in (`openThread` in `src/web/index.html`). Only the latest navigation's answer is used: an earlier one, success or failure, is ignored (so A, B, then A again ends on A however B answers), and a background refresh that started before a navigation or while one is pending is dropped and does not draw. Polls fetch the open thread only when no navigation is pending; among refreshes of the same thread the newest still wins. While a navigation is pending the menu shows the chosen thread, the bar says it is opening, the log is marked busy, Send is disabled, and Enter or Send does nothing and keeps the typed text, so nothing goes to the thread being left. The stored selection changes only when the new thread is drawn. If the load fails (HTTP error or no connection) the page keeps the thread it was showing, the menu and the stored selection go back to it, and the bar says what failed; the menu is put back even when the list of options did not change. After any navigation settles, the menu, the drawn messages, the stored selection and the thread a message is sent to are the same thread. Tests: `test/chat-reconcile.test.ts` (fake DOM, always runs) and `test/chat-browser.test.ts` (real Chromium; skipped where Playwright is not installed, as in CI).

Mutations answer late too, and a newer navigation beats them as well. Rename, Archive or Restore, and a send are not navigations (except that Archive moves on to the next thread), but each waits for the server. Each one records its target thread and the navigation generation before the request. Its answer may draw only while the page still "owns" it (`owns` in `src/web/index.html`): no newer navigation, none pending, and the thread drawn is still the target. Rename also needs the answer's `rev` to be no older than what is showing. Otherwise the answer only refreshes the thread list, so the menu learns the new title or archived flag, and the menu, log, stored selection and send target stay where the reader put them. A rename that fails while still owned says so in the bar. Archive draws the archived thread before opening the next one, so if that open fails the page shows Restore and takes no messages. The submit handler refuses to send to an archived thread even when the disabled controls are bypassed, and the server refuses too (409). A send whose answer or error arrives after the reader moved on adds nothing to the thread they moved to. List answers are numbered, so an older list cannot overwrite a newer one.

| Async path | What may change the view | Guard |
|---|---|---|
| Pick a thread (`openThread`) | menu, log, stored selection | latest `navGen` only; failure restores the thread shown |
| New | same | `navGen`; a later pick wins, and the new thread just joins the list |
| Archive / Restore | archived state, then the next thread | `navGen` + `owns`; a draw before moving on; the fallback is shown correctly |
| Rename | title, log redraw | `owns` + `rev`; otherwise list only |
| Send (`sendThreaded`) | reply, error line | target `current.id` and not pending; errors only in the target thread |
| Poll / card Confirm (`loadThread`) | log redraw | `navGen`, not pending, `loadSeq`, same thread, `rev` |
| List refresh (`loadList`) | menu options, notice | sequence number; never touches selection |

Remaining limits: a send still appends its "Working…" placeholder at once and is not cancelled by a switch (the reply stays in its own thread). A thread that returns 404 during a poll clears the stored selection without redrawing; threads are never deleted, so this needs a server-side fault. Dismissing the notice redraws the current thread in place.

## Limits

One process only. A viewer who is not the owner gets the old stateless chat, with no tools and no stored history. Stored conversation text and the results of vault, memory, job and pull-request tools are masked by known credential shape only (`docs/content-filter.md`), so note names, paths and ids are kept; the results of `ops_*` and `orbit_*` tools keep the tier-1 masking, which still hides long opaque ids. Duplicate matching is word-overlap, not meaning. The live state on a card is the last known ledger state; it is not refreshed from the root helper on every page load (the Jobs tab and `ops_*_operations` do that).
