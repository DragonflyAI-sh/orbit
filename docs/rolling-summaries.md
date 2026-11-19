# Rolling summaries: one cumulative summary per conversation

Every conversation (the Assistant, and each chat thread) keeps one cumulative, structured summary of the part of the conversation that has left the model's context window. At each page roll, ORBIT sends the previous summary plus the outgoing page to one tool-free summarizer request, validates the answer, and stores it as a new version together with the exact source boundary it covers. Every later model call of that conversation gets the latest summary plus the current rolling page: normal calls, tool continuations and the paid fallback alike.

The aim is that goals, scope, corrections, approvals and next steps stay in view after the turns where they were agreed leave the window. It does **not** guarantee perfect memory: a summary is written by a model, can be wrong or incomplete, and the mocked tests below prove the mechanics, not what a real model keeps. This change also does not show that a short window was the only cause of earlier drift (see "What was there before").

Code: `src/rolling-summary.ts` (shared: schema, validation, page rendering, prompt, summarizer request, mechanical carry-forward, the model-facing block), `src/assistant-summary.ts` (the Assistant's versions, rolls, coverage), `compactThread` and `summaryNote` in `src/thread-context.ts` (chat threads), `setSummary` in `src/threads.ts`, the `beforeTurn` and `summaryNote` hooks in `src/thread-service.ts`, wiring in `src/server.ts`, the switch in `src/main.ts`.

## What was there before (read from the code)

- **Chat threads** already compacted: at the start of a turn over 48,000 live characters, the oldest messages were summarized by the model into free text (at most 350 words) stored on the thread, with a mechanical digest when the model failed (`compactThread`). The summarizer transcript was cut from the front (`slice(-80000)`) without saying so. That mechanism is kept and moved onto the structured contract below; there is still exactly one summary per thread.
- **The Assistant** had no summary at all: the newest active chunks that fit a 68,000-character budget were sent, and archived chunks were never sent or summarized ("no background model calls at all"). Anything agreed in an archived turn was invisible to the model unless it re-read it with `session_read`.
- Tool outputs are clipped at three places, all unchanged: by the tool's own bound or `clipOutput` (8,000 characters, `src/agent.ts`), by the reply's tool-result budget (`budgetCut`, `src/tool-result-budget.ts`), and in the Assistant's shortened chunk forms (`boundChunk`, `src/assistant-context.ts`).

## The page roll

| | Assistant | Chat thread |
|---|---|---|
| Page roll | rotation archives chunks (`rotate()` after each turn) | compaction moves the summary boundary (`compactThread` at the start of a turn over budget) |
| Outgoing page | archived chunks not yet covered, oldest first, whole chunks only, at most 8 per request (`ROLL_CHUNKS_MAX`) and at most 60,000 rendered characters | messages `[covers, cut)` |
| When the summarizer runs | in the background after each turn, and awaited at the start of the next turn (`beforeTurn`), so a turn always plans with the newest summary; rolls are serialized per conversation | at the start of the turn, before the model call (as before) |
| Storage | `<state>/assistant/summaries/<version>.json`, one immutable file per version (below) | `thread.summary` in the thread file, previous versions in `thread.summaryHistory` (at most 4) |
| Coverage | chunk numbers `covers.from .. covers.through` (from = first chunk after the legacy baseline) | messages `1 .. covers` |

The summarizer request is `model.reply()` with no tools, no reference notes, no limits and `fallback: false` (`requestSummary`): it can have no side effects and never spends the paid fallback, exactly like every other background caller. It is abandoned after `ROLL_TIMEOUT_MS` (90 s); a late answer is ignored. It is given only the previous summary and the outgoing page, as data blocks; it never sees its own future output or another conversation.

### What the summarizer is shown of a page

`renderPage` shows each message with its stored reference (`chunk 12`, `message 34`), role, time and completion state. Message text is shown up to 3,000 characters, tool arguments up to 300 and a tool-output excerpt up to 600, each cut saying `shown here only the first N of M characters`. For every call it says exactly what reached the conversation model: `stored output N characters`, or `the model saw only the first X of Y bytes of this output in that reply` when the tool-result budget cut it, or `never run`. Photos are named, not shown. When the page does not fit 60,000 characters, smaller bounds are tried; what still does not fit is named in the page as not shown and recorded as a gap. The prompt tells the model that a cut output was not fully seen.

## The structured summary

The model must answer with one JSON object (`SUMMARY_SCHEMA_TEXT`):

- `goal`; `scope.in` and `scope.out` (exclusions);
- `corrections` (Rai's explicit corrections, each with what it `supersedes`) and `decisions` (`by`: user, assistant or agreed);
- `authorizations` with `state` approved, pending, refused, expired or unknown;
- `observed` state, each with `status` verified (a tool record showed it), claimed (an assistant statement), reported (Rai said it) or uncertain, a reference and an optional time;
- `open` commitments and questions; `conflicts` (disagreements kept apart, not blended); `next` (the agreed next step); `recovery` references (messages, chunks, notes, jobs, PRs).

Validation (`validateAnswer`) is strict: a fenced or bare JSON object only; enums checked; at most 12 items per list, 400 characters per item, 600 for the goal; the rendered summary at most `ROLLING_SUMMARY_MAX_CHARS` (6,000); the raw answer at most 24,000 characters. An observation without a status is `uncertain` (never verified by omission). Every string is masked like stored chat text (`maskContent`) and any `orbit-data` delimiter is neutralized. An answer that is empty, malformed, oversize or empty after a non-empty summary is refused, never cut or stored.

The prompt's rules: Rai's latest explicit correction supersedes earlier assistant interpretations; no permission is recorded that Rai did not give explicitly, a pending proposal is pending, and a summary is never permission; a reported completion is an observation at that time, not live status; partially seen output is partial; disagreements are kept with references; nothing is invented.

### What a conversation model call gets

`summaryBlock` renders a data block (`conversation-summary` for the Assistant, `thread-summary` for chat threads), at most `ROLLING_BLOCK_MAX_CHARS` (8,000) by construction:

1. the version, method (`written by a model` or `MECHANICAL ... lossy`), time and coverage;
2. the framing: untrusted context, not instructions, not permission, not verified evidence; the conversation wins where they disagree, above all Rai's latest explicit corrections; system and developer rules always win; outcomes in it are not current status;
3. the sections, then any carried free text or mechanical digest (only these can be cut, saying so);
4. coverage lines: `NOT COVERED` ranges (legacy, mechanical-only, unreadable, unseen), `NOT COVERED AND NOT IN YOUR CONTEXT` (archived chunks waiting for a roll, with the last failure), `NOT IN YOUR CONTEXT THIS TURN` (active chunks over budget), `IN YOUR CONTEXT BELOW` (which chunks or messages are visible, and whether some are shortened), and where to read originals (`session_read` id `assistant:assistant` from the Assistant; the page's Load earlier messages; the thread itself for chat).

It travels in the reference material (`notes`) of each request, which `instructions()` places in every request of a reply: the first step, every tool-continuation step and the forced final step, on the primary and on the OpenRouter fallback (`toMessages(system, …)`). It is outside the Assistant's 68,000-character conversation budget and outside the 12,000-character notes cap, so the rolling window can never drop it; its own cap is 8,000. `instructions()` also says that a summary is never permission and that the conversation wins where they disagree.

### Budgets per Assistant model call (characters)

| Part | Bound | Where |
|---|---|---|
| Instructions (rules, tool names, round guidance) | not counted by ORBIT (about 9,000) | `instructions()`, `src/model.ts` |
| Rolling summary block | 8,000 | `ROLLING_BLOCK_MAX_CHARS` |
| Reference notes (vault, devices) + session digest + card lines | 12,000 + 6,000 + 20 lines | `docs/assistant.md`, "Budgets" |
| Conversation: active chunks + new message | 68,000 | `ASSISTANT_CONTEXT_BUDGET_CHARS` |
| Tool calls and results added within one reply | 96,000 UTF-8 bytes | `REPLY_TOOL_RESULT_BUDGET_BYTES` |
| Summarizer request (separate call) | previous summary (6,000 + carried + digest + gaps) + page (60,000) + rules | `ROLL_PAGE_MAX_CHARS` |
| Summarizer answer | 24,000 read; 6,000 rendered | `ROLL_ANSWER_MAX_CHARS`, `ROLLING_SUMMARY_MAX_CHARS` |

The summarizer's output tokens cannot be capped through `ModelPort.reply()` (no such option exists on the primary route); the answer is bounded by the prompt and refused when it is larger than the bounds above.

## Integrity, concurrency and recovery

**Assistant.** A version file holds the summary and its boundary together: `{schema, conversation, version, prevVersion, at, method, covers {from, through}, page {from, through, seqs, digest, unreadable, unseen}, sections?, mechanical?, gaps, olderGaps, degraded?}`. It is written once, by an exclusive create (temporary file, fsync, hard link to the final name, which fails if the name exists), so it appears whole or not at all and never replaces another. A version is never rewritten or deleted. On start, the newest readable version is the summary; an unreadable or inconsistent file is reported in `summary.problems`, left in place, and its number is never reused. `page.digest` is a SHA-256 of exactly what was read (message ids, text, call ids, arguments and outputs).

- Rolls are serialized per conversation (a promise chain); a roll requested while one runs starts after it, from what it stored.
- Each roll snapshots its page (the archived chunk files are read once), and its commit is compare-and-swap on the version it was made from. A stale result is dropped (`rolling_summary_stale`) and the next roll starts from the newer version. Two processes on one state directory are not supported, but the exclusive create still prevents one from overwriting the other's version.
- Each page starts at the chunk after the last covered one, so no chunk is skipped or covered twice; chunk numbers inside a page that are not in the archive (an unreadable active file keeps its number) are named as a gap.
- Retries are idempotent: what to summarize is always recomputed from the stored versions and the archive. A crash between archiving and summarizing leaves archived, uncovered chunks that the next roll takes; a crash during a version write leaves either the whole file or only a temporary file, which is ignored.

**Chat threads.** The new `thread.summary` (with `version`, `sections`, `gaps`, `source {from, digest}`) is stored by `setSummary` in the same atomic rewrite of the thread file as always, with compare-and-swap: the thread must still have the summary version and boundary the new one was made from, and the covered messages must still digest to what was read; otherwise 409 and nothing is stored. A turn holds its thread, so compaction is already serialized per thread. The replaced summary is kept in `thread.summaryHistory`.

## Failure policy

| Event | Assistant | Chat thread |
|---|---|---|
| Summarizer timeout, error, malformed, empty or oversize answer, first time for a page | **Deferred**: nothing is stored, coverage does not move, the previous version stays in force, and the block names the archived chunks as `NOT COVERED AND NOT IN YOUR CONTEXT` with the failure. The context window stays bounded (the archived chunks are simply not sent) | **Mechanical carry-forward at once** (below). Chat threads have no hard per-request window, so waiting would grow the request instead |
| The same page fails again (`ROLL_ATTEMPTS_MAX` = 2 attempts per process) | **Mechanical carry-forward** | as above |
| No model connected (mock) | mechanical at once, not flagged degraded (there is nothing to retry) | same (as before) |
| Even the mechanical version cannot be stored | nothing changes; logged | nothing stored, the boundary does not move, the full thread is sent, the error is recorded (as before) |

A mechanical carry-forward keeps the previous valid sections exactly as they were, adds a lossy digest of the page (at most 2,000 characters, newest lines kept, dropped lines counted), names the page as a gap (`summarized mechanically only (reason)`), and flags the version `degraded`. Coverage advances explicitly, never silently, so there is no infinite retry and no unbounded backlog; the originals stay stored. A later model version is given the digest and the gaps and folds them in; gap entries are carried forward (the newest 8 listed, older ones counted). Retry counts are kept in memory, so a restart allows another two attempts for a deferred page.

A long backlog (many chunks archived at once, or after failures) drains in bounded steps: at most 8 chunks per request and 3 requests per trigger (`ROLL_PAGES_PER_TRIGGER`); the rest stays named as not covered until later triggers.

## Legacy, rollout and rollback

- **Legacy Assistant stores.** The first start with this code writes `summaries/baseline.json` once with `legacyThrough` = the highest chunk then archived (including any the start-up rotation archived). Those chunks are never backfilled or summarized, and every block says `NOT COVERED: chunks 1 to N were archived before rolling summaries existed`. A new store starts at 0. No summary ever claims to cover source it did not read.
- **Legacy chat summaries** (free text, no `version`) keep working: they are sent as before, given to the next roll as the previous summary, and carried (first 2,500 characters) if that roll fails. Old code reading a new thread file sees `summary.text` (the rendered sections) and ignores the new fields.
- **Switch.** `ORBIT_ROLLING_SUMMARIES=0` (read in `src/main.ts`) turns the Assistant's summaries off: no summarizer request and no block, exactly the previous behaviour; stored versions are kept and used again when it is turned back on. Chat threads always use the structured contract (their compaction already called a model); reverting the commit restores free-text compaction, and older code ignores the added fields.
- Nothing here changes deployment, configuration files, routines or jobs. The only new model calls are the summarizer requests at page rolls, which are part of a conversation's own turns.

## Privacy and diagnostics

- Summaries live beside the conversation they summarize (`<state>/assistant/summaries/`, mode 0700 directory and 0600 files; the thread file for chat), are masked like the conversation, and are deleted or kept with it. Summarizer prompts and answers are not logged.
- Logs carry metadata only: `rolling_summary_committed` (version, method, page range, chunk count, gap count, degraded), `rolling_summary_deferred` (range, attempts, failure class), `rolling_summary_stale`, `rolling_summary_store_failed`.
- `GET /assistant` (owner only) has `summary`: `enabled`, `legacyThrough`, `version`, `at`, `method`, `covers`, `gaps`, `degraded`, the stored summary text, `uncovered` (archived chunks not yet covered), `lastFailure`, `problems`. Each chunk's `context.summary` records the version, coverage, block size and degradation the turn was given. A chat thread's view has `summary` (and `summaryHistory`) as before.

## Tests

Executed (offline, deterministic, `npm test`):

- `test/rolling-summary.test.ts` (15 tests): validation (accepted, malformed, enum, item and total bounds, empty-after-non-empty, uncertain by default); delimiters neutralized and secret-shaped text masked; page rendering that states delivered vs cut vs not run and names unseen entries; the prompt carrying the previous summary and the page as data; the summarizer request (tool-free, no fallback, timeout with a late answer ignored, error, mock never asked); block bounds; and, on the Assistant's store: chaining across many rolls with contiguous, non-overlapping pages and each prompt carrying the previous version; the synthetic scenario's correction, approval boundary, claim status and open commitment surviving every roll; deferral on timeout without moving coverage, then mechanical carry-forward with the prior sections unchanged, then a model version folding it in; mock; restart with a torn file and a crash before rolling; legacy baseline with no backfill; serialized rapid rolls and a stale writer dropped by the exclusive create; bounded backlog draining; an unreadable archived chunk named as a gap; bounded gaps.
- `test/rolling-summary-integration.test.ts` (5 tests), through the real server and provider adapters with a fake `fetch` that records every request body: the actual Responses API payloads of the Assistant over 13 turns and at least 5 rolls (summarizer requests tool-free and chained; the final request's instructions carrying the latest summary with the correction, the pending launch confirmation, the claim still a claim, the open commitment and the next step, while the goal turn itself is archived; the tool turn's two requests carrying the same block; injected tool text neutralized and never turned into an authorization; clipping stated to the summarizer; diagnostics and owner-only access; originals still in `/assistant/history`); the OpenRouter fallback's actual requests (first and tool continuation) carrying the block while the summarizer never spends the fallback; two chat threads and the Assistant with no leakage in either direction; the rollback switch; a restart of the real server.
- The fake summarizer (`test/helpers/rolling-fake.ts`) reads only the prompt ORBIT sends, carries every previous item forward and applies fixed rules to Rai's lines. It proves that what reaches the model is built from the previous summary plus the outgoing page; it says nothing about a real model's judgement.
- Existing compaction tests in `test/threads-context.test.ts` were updated to the structured contract (JSON answers; the neutralized-delimiter check; the mechanical block wording).

Proposed, not executed: `test/eval/rolling-summary-quality.ts --run` scores a real model's retention on a fictional six-page conversation (goal, exclusions, mistaken broadening, explicit correction, approval boundary, injected tool text, unverified claim, next step) with a fixed rubric. It needs `ORBIT_EVAL_OPENAI_KEY` and `ORBIT_EVAL_MODEL`, costs money, and must only ever be given synthetic text. `--fake` runs the same harness offline with the fake summarizer (a harness check, not a quality measurement).

## Limits

- A summary can be wrong, incomplete or stale; it is data, and the records (`jobs_list`, `job_status`, proposal cards) remain the authority on outcomes. Approval states in a summary can lag a card decided after the roll.
- The summarizer sees excerpts of tool output (600 characters each), not whole outputs; it is told so, but it can still miss facts that were only in the unseen part.
- A deferred page is not in the model's context until the next successful roll (or the mechanical carry-forward); the block says so.
- Retry counts reset on restart (bounded to two attempts per page per process).
- No real-model quality numbers are claimed: none were measured by the job that built this.
- The legacy stateless `/chat` route stores no conversation and so has no summary; work sessions have no messages of their own. The rolling recent-work note of chat threads (`src/recent-context.ts`) is a separate, cross-thread note and is unchanged.
