# Server-side chat threads

Chat history used to live in a JavaScript array in the page and was sent to the server as text (the last 40 messages). A refresh, another device or a deploy lost it, and earlier tool calls and results never reached the model. Threads move the history to the server. They are shared by every device, owner only, kept until archived, and never deleted automatically.

The Assistant page (one rolling conversation, `/#assistant`) is separate and described in `docs/assistant.md`; it shares the turn code but not this storage, compaction or the rolling note.

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
| `POST /threads/:id/messages {text}` | Continue: runs one turn and returns the thread (502 plus the thread if the model failed) |
| `POST /threads/notice/ack` | Dismiss the one-time notice for every device |
| `POST /chat/proposals/:id/confirm|cancel` | Existing routes; they now also settle the card |

The old `POST /chat` (client-sent history) is kept unchanged for API callers and for the page when the viewer is not the owner; the owner's page does not use it. It stores nothing.

## Addresses

Each thread has its own page address: **`/#chat/<thread id>`** (the canonical form: the lowercase UUID, unencoded). The address is what a tab shows, so two tabs (or two windows) can have two different threads open at once and each keeps its own across a reload. The fragment is never sent to the HTTP server, so nothing changed on the server for the address; the page fetches `GET /threads/:id` and posts to `POST /threads/:id/messages` with the id from the address, as before.

| Address | What the tab does |
|---|---|
| `/#chat/<id>` (a link, a typed address, a reload) | Opens that thread. The stored selection is ignored. An uppercase or percent-encoded copy of a real id opens it and the address is rewritten to the canonical form in place. |
| `/#chat` (plain; the Chat link) | Fallback: if a thread is already open in this tab, keeps it; otherwise opens the thread last opened in this browser (`localStorage` `orbit.thread`, shared by all tabs), else the newest open thread, else the empty state. The address is then **replaced** with that thread's, so Back never lands on an unresolved `#chat`. With no threads, the address stays `#chat` until the first send creates one. |
| `/#chat/<anything else>` (not a UUID, bad percent-encoding, extra path) | Nothing is fetched. The log and the bar say the address does not name a thread; Send is disabled. |

- **Picking a thread or New** adds a history entry with the new address (only once the thread has opened). Starting a thread by sending from the empty state replaces `#chat`. Archive moves on like a pick.
- **Back/Forward** open the thread the address names. They never create a thread, and the page's own address updates use `pushState`/`replaceState` (no `hashchange`), so there is no loop.
- **The address is authoritative for its tab.** Other tabs write the shared stored selection; it is only the plain-`#chat` fallback, and the page has no `storage` listener, so another tab never moves this one.
- **Missing, deleted or refused threads.** When the address names a thread that answers 404 (also when it is deleted while open: the next poll, within 10 seconds, reports it), 401/403, another error or no answer, the tab shows no thread, says why (with Try again) and sends nothing: a message is never sent to, and no new thread is started in place of, a thread other than the one the address names. Choosing a thread or New recovers. A failed pick from the menu keeps the old behaviour (the thread shown stays, the address stays on it).
- **Requests are bound to their thread.** Every load, poll and send carries its thread id and the navigation generation it started in; an answer that arrives after the address (or the menu) moved on is dropped and draws nothing (transcript, errors, cards). As before, one tab sends one message at a time (Send stays disabled until the reply is in, whichever thread is shown); another tab is not held up. The late reply stays in its own thread and shows when that thread is opened again. Nothing is resent automatically. Text typed in the box stays with the box (it goes where the address is when Send is pressed).
- Non-owners (no threads, the legacy page) given a `#chat/<id>` address are told threads are owner only and nothing is sent; plain `#chat` works as before. The Assistant and Jobs addresses are unchanged.

Server side, nothing needed changing: every thread route takes the id from the path (`/threads/:id...`, `src/server.ts`), and the one-reply-at-a-time lock is per thread (`tryBegin(id)` in `src/threads.ts`, used by `turn()` in `src/thread-service.ts`), so two tabs on two threads run two turns at once and a busy thread blocks only itself (`test/threads.test.ts`, "a reply in progress in one thread does not block…"). Two tabs on the **same** thread share it as two devices always did: the second send while a reply runs gets 409.

Tests: `test/chat-address.test.ts` (address parsing always runs; in Chromium against a fake server: direct link, reload, plain `#chat`, canonicalizing, the empty state, pick/New/Back/Forward, invalid, missing, deleted and refused addresses, late history/poll/send answers after the address moved, and two tabs of one browser sending concurrently).

Manual two-tab check (owner, two threads A and B):

1. Open A in tab 1; the address becomes `/#chat/<A>`. Copy it.
2. Open a second tab at `/#chat`, pick B; its address becomes `/#chat/<B>`.
3. Send a message in tab 1 and, before it answers, one in tab 2. Each reply appears only in its own tab and thread.
4. Reload tab 1: it still shows A (although tab 2 opened B last). Reload tab 2: still B.
5. In tab 2 pick A, then press Back: B again, with no new thread in the menu. Forward: A.
6. Open `/#chat/not-a-thread` and `/#chat/<a made-up UUID>`: each says why, Send is disabled, and nothing appears in any thread.

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
