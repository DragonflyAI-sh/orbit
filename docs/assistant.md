# The Assistant: one rolling conversation

The Assistant is the page that opens at `/` (and `/#assistant`). It is a single conversation, owned by the server and the same on every device, refresh, restart and deploy. Chat (`/#chat`) is unchanged: its threads, picker, compaction and stored files are untouched and separate.

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

Vault retrieval (memory search excerpts), the device summary, the system prompt, the tool list and the policy checks are the same as for chat (`prepare()` in `src/server.ts`). The Assistant's conversation store is conversation context only; it is not durable memory and does not write to the vault.

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
| `BOUNDED_OUTPUT_CHARS` / `BOUNDED_TEXT_CHARS` | 1,500 / 4,000 | inside a shortened chunk, each tool output / message text is cut to this |

The chat thread budget is 48,000 characters of live messages; the Assistant's 52,000 conversation cap is of the same order, chosen so the existing model/context settings (the same models, the same 8,000-character tool output clip, the same 20,000-character message cap) need no change.

Within one turn, the model's input also grows with that turn's own tool calls, exactly as in chat (`runChat`: at most 5 rounds, each tool output clipped to 8,000 characters). That growth is the existing behaviour and is not counted in the 52,000.

## The context bound

`planContext` builds the model input for a turn:

1. The new user message (at most 20,000 characters).
2. Complete active chunks, newest first, each in its *bounded representation*, while they fit in the remaining budget. The first one that does not fit stops the walk, so what is sent is always a contiguous, newest run with no gap. Older active chunks that did not fit are reported as `omitted` and are archived by the next rotation.
3. `buildItems` (the chat builder) turns the result into model items, with call ids made unique.

The bounded representation of a chunk (`boundChunk`), tried in order, never changing the stored chunk:

- `full`: as stored, when it is at most 12,000 characters.
- `clipped`: each tool output cut to 1,500 and each text to 4,000 characters; each cut ends with `[ORBIT: … cut from N to M characters for the model's context; the full text is stored in assistant chunk <seq>]`.
- `calls-omitted`: the turn's tool calls are removed as whole pairs (a call is never sent without its result, or a result without its call) and replaced by a one-line note listing them and their outcomes. Tool arguments are never cut, because a cut argument would no longer be valid JSON.
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
| `POST /assistant/messages {text, requestId?}` | Runs one turn; returns the view (502 with the view if the model failed; 409 if busy or a duplicate) |
| `POST /chat/proposals/:id/confirm|cancel` | Existing routes; a card from the Assistant settles in the Assistant (`cardSvc` in `src/server.ts`) |

## The page

- Navigation: Assistant, Chat, Jobs, Status (in that order). `/` with no hash, or with a hash that names no page, opens the Assistant; `#chat` and `#jobs` open those pages as before. For a viewer who is not the owner the Assistant link hides and the page falls back to Chat (the old behaviour).
- The ORBIT logo header is kept. The Chat thread bar shows only on Chat.
- Assistant: scrolling conversation, the input and Send; no session picker, New or delete. Replies render with the existing Markdown renderer. Each reply has two collapsible panes, closed by default: Tool output (each call with its state, including outcome unknown) and Resource usage (model and provenance, fallback model and cost when reported, tool call count, context characters sent of the budget, shortened or omitted turns, vault notes read, spend-accounting and incomplete notes). Spend-accounting and incomplete warnings, errors and proposal cards (with Confirm and Cancel) are never inside a pane.
- A line marks where the model's context begins; turns above it (archived, or over budget) are dimmed and labelled as not sent.
- Status dot (header, every page): green only when `/status` answered with at least one entry and every entry's `state` is exactly `live`. Any other state, an error, an unreadable answer, no answer, or before the first answer: red. It is a link to `/status`, with the state in its text, tooltip and accessible name ("All live", "2 not live" with the names, "Status unknown"). It uses the existing 30-second status refresh.
- The Assistant refreshes every 10 seconds while it is showing and the page is visible (the existing poller), so another device's turns, a reply in progress and card changes appear.

## Tests (all offline, mocked model)

- `test/assistant-store.test.ts`: empty start and fixed identity, separate directory, restart, one turn at a time, interrupted turns, crash recovery of an open chunk, deterministic rotation with no loss or duplication, archive paging and exclusion from context, cards holding rotation and still settling once archived, a chunk found in both directories, unreadable files, masking on disk, bounded chunks for huge outputs/many calls/huge arguments, a randomized check that every plan fits the budget with paired calls and a contiguous newest run, notes cap.
- `test/assistant-server.test.ts`: owner-only routes and cross-site refusal, server-named singleton, isolation from chat threads in both directions, restart continuity, concurrent sends (one runs, the other 409), model failure, end-to-end bound with huge tool output over many turns with rotation, confirm and cancel of Assistant proposals through the existing routes (single use), expired cards after restart, duplicate request ids.
- `test/assistant-restart.test.ts`: revisions across restarts. A store and a real server reopened on the same state directory serve revisions above every earlier one (the regression); repeated restarts, several within a second and with the clock set back; a store from before epochs and an unreadable `epoch.json`; an epoch that fills up; memory-only stores. The page's own `aNewer` rule (loaded from the page) and the PR #83 rule both accept the restarted server and reject a late answer from the old process. Send versus poll ordering across a restart; a turn interrupted by a restart is not re-run. In Chromium against the real server behind a stable address: two open tabs keep updating across three restarts without reload or sending, an answer from the old process does not roll a tab back, a poll held back during a send and a send answer held back behind a newer poll are both ignored.
- `test/assistant-page.test.ts`: status aggregation and routing (pure, always run); in Chromium against a fake server: default page and nav order, explicit `#chat` and `#jobs`, non-owner fallback, status dot transitions (live, degraded, HTTP error, no answer), collapsed panes with visible warnings and a working Confirm, send, 409 and no-answer handling, busy elsewhere, loading archived turns.
- Existing tests: the nav tests now expect the Assistant link first; the Chat browser tests open `/#chat` explicitly. Nothing else in them changed.

## Manual browser acceptance (not performed by the job that built this)

On a deployed ORBIT, as the owner:

1. Open `/`: the Assistant is selected, first in the nav; the conversation is empty on first use; the header shows the ORBIT logo and the status dot.
2. Compare the dot with `/status`: green only if every entry says `live`; stop a non-model port or wait for a stale one and check it turns red with the port named in its tooltip.
3. Send a message; reload the page; open `/` on a second device: the same conversation appears.
4. Ask for something that uses a tool: the reply shows "Tool output" and "Resource usage" closed; open them with the keyboard (Tab, Enter).
5. Ask ORBIT to propose a job; check the card is visible outside the panes; Cancel it, then propose again and Confirm; check the card shows the job id and that the job exists under Jobs.
6. Send from two tabs at once: one gets the reply, the other says a reply is in progress and keeps its text.
7. Open `/#chat`: threads, picker, New, Rename and Archive work as before and the Assistant's messages are not there.
8. After many long turns, check "Load earlier messages" appears and loads older turns marked as not sent; check `<state>/assistant/archive/` holds them.
9. Restart ORBIT during a reply: after restart the reply shows as interrupted and nothing was repeated.
10. Check the page at phone width: no horizontal scrolling; Send and the panes are reachable.
11. Leave two tabs open on the Assistant, restart ORBIT, and send from a third device: both tabs show the new turn within about 10 seconds without reloading (repeat for a second and third restart; full steps in `docs/assistant-architecture.md`).

## Limits

- The budget is in characters, not tokens; a text in a script with many tokens per character can use more tokens than the estimate.
- A turn's own tool rounds can add up to the existing `runChat` limits on top of the 52,000-character conversation cap.
- While a confirmable card is pending, the active window can exceed 32,000 characters for up to the proposal lifetime (30 minutes); the prompt bound still holds.
- Request ids are remembered for active chunks and for chunks archived since the process started; a repeat of a very old send after a restart is not recognized (the browser only repeats within one request).
- Revision order between processes depends on `epoch.json` (or, without a state directory, the clock). If `epoch.json` is lost and the clock is also set back, or the state directory is restored from a backup with an older `epoch.json`, open tabs ignore the new process until they are reloaded.
- Not verified in a real deployment or with a real model; see the acceptance steps above.
