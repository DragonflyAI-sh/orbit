# Server-side chat threads

Chat history used to live in a JavaScript array in the page and was sent to the server as text (the last 40 messages). A refresh, another device or a deploy lost it, and earlier tool calls and results never reached the model. Threads move the history to the server. They are shared by every device, owner only, kept until archived, and never deleted automatically.

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

## Concurrency and atomicity

The service is one Node process. Every change to a thread is `mutate(id, fn)`: a synchronous read-modify-write on a copy that is written to disk first and only then replaces the live copy. There is no `await` between the read and the write, so concurrent requests cannot overwrite each other (a rename during a reply is kept), and a failed write changes nothing and returns 500. Two processes sharing one state directory are not supported.

A thread runs one reply at a time: a second `messages` request, or an archive, while one is running gets 409. The assistant message exists as `pending` from the start of the turn and each tool call is stored as it completes, so a model error or a crash mid-turn leaves the user message and every call that really ran on record (the reply is `error`, or `interrupted` after a restart). A thread file that cannot be parsed is reported in `problems` and left untouched. Cost: each change rewrites the thread's file; fine for chat-sized threads.

## Context sent to the model

`buildItems` (`src/thread-context.ts`) turns the stored thread into the Responses API items the adapters already use: user and assistant messages, and each tool call as `function_call` followed by its `function_call_output` (call ids made unique across the input). Only messages after the summary are sent. The browser sends only the new text. Reference material goes in the instructions as `<orbit-data>` blocks, which the system prompt calls data, never instructions: vault excerpts, the rolling recent-work note, the thread summary, and one line per proposal card from the records (state, job or operation id, the record's current state), so a confirmed card is not offered again. Stored content cannot close its own block (`</orbit-data` is neutralized).

The system prompt (`recordCheckInstruction` in `src/model.ts`) asks ORBIT to check `jobs_list`, `job_status`, `ops_admin_operations` or `ops_sys_operations` in the same turn before claiming a job or action did or did not happen, to treat summaries, notes and cards as not proof, and to check for an existing equal job before proposing one. This is a request. Tests show it is in the prompt and in the request the adapter sends; nothing can show a model will always obey, which is why card states and job state on the page come from the records themselves.

## Compaction

Budget, per thread (`src/thread-context.ts`): when the messages after the summary hold more than `CONTEXT_BUDGET_CHARS` = 48,000 characters (text plus tool arguments and results, roughly 12k tokens), the oldest ones are summarized. At least `KEEP_RECENT_CHARS` = 16,000 characters and `KEEP_RECENT_MESSAGES` = 4 messages stay verbatim, and the kept part starts at a user message, so a turn (and any call with its result) is never split. The check runs at the start of a turn, before the model call.

The summary (at most 6,000 characters, masked) is stored in `thread.summary` with `covers` = how many leading messages it stands for. No message is changed or removed; the page still shows all of them and marks where the summary starts. A later compaction summarizes the earlier summary plus the newly old messages. The model is told the text is data to summarize, not instructions. If no real model is connected (mock) a deterministic digest is used and no model call is made. If the model fails, a mechanical digest is stored instead, flagged `degraded` with the error, and shown on the page; if even storing fails the thread is left exactly as it was and the error is recorded. A summary failure never blocks the reply.

## Rolling recent context

A short note (at most 1,500 characters) about Rai's recent work and open questions, given to every thread as a data block marked possibly stale and not verified. It sits behind `RecentContextPort` (`read`, `write`, `describe`, all async) in `src/recent-context.ts`. Today `stateRecentContext` keeps it in ORBIT's state (`recent-context.json`). A vault implementation that reads and writes `Memory/recent-context.md` only has to implement the same three methods and be passed to `buildServer` as `recentContext`; nothing here writes to the live vault.

Refresh criteria: after a reply, a thread is notable when it has at least 3 user messages, or any proposal card, or any call to a job or ops tool; a notable thread that changed since its last attempt triggers a rewrite at most every 10 minutes, and archiving a notable thread asks for one immediately. Rewrites run one at a time in the background, never throw, and keep the old note on failure (the error is shown in `GET /threads`). The rewrite prompt includes the cards' recorded states and tells the model to mark anything a message merely claims as unverified. A mock model never rewrites.

## Proposal cards

A proposal made by a tool call is stored on the thread as a card. States: `open`, `confirmed`, `cancelled`, `expired`, `refused`.

- `open`: waiting for a click. It becomes `expired` when its proposal's time is up or the proposal is gone (a restart drops open proposals), which is applied whenever the thread is read.
- `confirmed`: the owner confirmed it and the confirmation produced a job id, an operation id or a steer number, stored in `outcome`. The page shows the id and the live state read from the jobs record or the admin/sys ledger at that moment (`live`), never a success inferred from the confirmation; "accepted", "running" and "registered" are shown as such. If no id was recorded (for example ORBIT restarted mid-launch) the card says so.
- `cancelled`: the owner cancelled. `refused`: the confirmation failed before anything started (helper refused, job gone, launch precondition failed); the proposal is spent, so ORBIT must propose again.

Single use has two guards that must both agree and are both synchronous: `proposals.take()` (the existing store) and a compare-and-set of the card from `open`. Of any number of concurrent or retried confirmations exactly one executes; the others get 404/409 with the card's state. The privileged boundaries are unchanged: owner check, digest for `ops_admin` and `ops_sys` cards (a wrong digest changes nothing and leaves the card open), and the helpers' own checks.

Duplicate-launch warning (`src/duplicates.ts`): a launch records the distinct words of its brief on the job (`launch.briefWords`, not the brief). A new `job_launch` proposal is compared with jobs launched in the last 24 hours, in any state: briefs match when the smaller word set has at least 8 words and the Jaccard similarity of the sets is at least 0.7. The proposal is still made; the warning is on the card and in the tool result the model reads. Jobs launched before this feature have no signature and cannot match.

## Migration

Nothing is imported: the old history existed only in browsers, so ORBIT cannot see it. On first load `GET /threads` returns a one-time `notice` saying so; the page shows it with a "Got it" button, and `POST /threads/notice/ack` records it in `meta.json` so it does not return on any device or after a restart. The page remembers the selected thread id per device in `localStorage` (guarded, optional) and otherwise opens the most recently active thread; it re-fetches the open thread every 10 seconds while the Chat tab is visible, so another device's messages and card changes appear.

## Limits

One process only. A viewer who is not the owner gets the old stateless chat, with no tools and no stored history. Stored tool results lose long opaque ids to masking. Duplicate matching is word-overlap, not meaning. The live state on a card is the last known ledger state; it is not refreshed from the root helper on every page load (the Jobs tab and `ops_*_operations` do that).
