# Reliability repair acceptance — 2026-11-14

Job `orbit-202611140238-96x8`. This is a bounded acceptance check of the recent reliability repairs (#74 to #80), not a new audit, not
a readiness certification, and not one of the two independent reviews that sensitive changes need.

- **Revision checked:** `DragonflyAI-sh/orbit` main at **`b9de2402c20a0e69c478842cc07a1ca4af386345`** (PR #80). It is also the runner's
  verified tool commit, and main had not moved when this job started. Every result below is for that revision plus the test files this
  branch adds. **No production code was changed.**
- **Environment:** Linux cloud runner, Node v22.23.4, pnpm 10.33.0, TypeScript 6.0.3, Playwright 1.63.0 with Chromium 153.0.8010.12
  (headless). All offline.
- **Not done, by instruction:** no production access, deploy, rollback, Routine or config change, provider call (paid or free), secret
  access, real vault read or write through ORBIT, or production send.

**Status values.** *Passed*: exercised here, offline, with the result shown. *Unverified*: not exercised here (it needs production, an
operator, or a decision). *Failed*: reproduced wrong behaviour. No area was verified live.

## Commands and totals

| Command (repo root) | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | ok |
| `pnpm typecheck` at `b9de240`, before any change | clean, exit 0 |
| `pnpm test` at `b9de240`, before any change | **1007/1007 pass**, 0 fail, 0 skipped (the 22 Playwright tests in `chat-browser.test.ts` ran, because Playwright is installed on this runner) |
| `pnpm typecheck` with this branch's tests | clean, exit 0 |
| `pnpm test` with this branch's tests | **1021/1021 pass**, 0 fail, 0 skipped (+14 new) |
| The 4 new files, run 5 times in a row | 14/14 pass on every run |
| `chat-browser` and the new real-server browser file without Playwright (`NODE_PATH` pointing elsewhere) | skipped with a reason, as in CI |

New test files (synthetic data only; every credential-shaped value is built at runtime):
`test/acceptance-vault-writes.test.ts` (5), `test/acceptance-recovery.test.ts` (4), `test/acceptance-fallback.test.ts` (2),
`test/acceptance-browser-real-server.test.ts` (3, Playwright).

## Acceptance matrix

All rows are at `b9de240`.

| # | Area | Evidence | Result | Remaining blocker | Live or manual follow-up |
| --- | --- | --- | --- | --- | --- |
| 1a | Vault writes: ordinary writes with long benign `sk-` names and wikilinks | New: `acceptance-vault-writes` "every operation writes long benign sk- names…". It covers all five operations through the chat tools (`vaultEdits` → `clone.write` → commit → plain push → remote read-back) in a temporary bare repository. Names start with `sk-`, `sk-proj-` and `sk-ant-`, one is 96 characters (close to the 100-character segment limit), and a wikilink target is 180 characters. All are written whole and unmasked, including in the audit line. Existing tests: `vault-sk-names-and-refusals` (7), `vault-write` (15). | **Passed** | none | Live acceptance after deploy (one benign `sk-` note in the real vault). This needs Rai. |
| 1b | Protected areas need confirmation | New: "a protected-area write is only a proposal until confirmed…". A `System/` note with a long `sk-` name becomes a proposal and nothing is written. A card whose display was tampered with gets 409, and the held change is spent. The real card gets 200 and is verified on the remote; confirming it again gets 410; exactly one write lands. A Journal reflection and a `#rai` note still need confirmation. | **Passed** | none | none |
| 1c | Genuine credentials are refused, refusals are sanitized, nothing changes on refusal | New: "a genuine credential is refused in every operation…". Covered: create, append, replace, set-frontmatter (a string value and a list value), and a protected-area create. Every refusal is `secret_refused` and names only `rule at line N`. It never contains the value, the filter finds nothing in the message, no proposal is made, the remote head is unchanged, the clone has no stray files or commits, and the clone's recorded `lastError` holds no value. A credential-shaped heading fails its precondition, and that message masks the value too. New: "a multi-edit write refused part way leaves nothing…" (two valid edits plus one secret: none of them lands, locally or remotely). New: "a push the remote rejects…" (a pre-receive hook refuses the push: `push_failed`, no leftover commit, and the next write does not carry it). | **Passed** | none | none |
| 2a | No-export launches: regression coverage | Existing: `job-context` (13), including "an ordinary launch writes only the brief…", "GitHub: a launch creates orbit/<job> and puts .orbit/brief.md only…", "no source file keeps the export plumbing…", and the legacy-context refusals. `sparse-checkout` (4). | **Passed** (test evidence) | none | none |
| 2b | No-export launches: this run's control branch | **Observed evidence, separate from test evidence.** In `orbit-work`, the launch commit `1f64a7c` ("brief for orbit-202611140238-96x8", parent `9459edf`, the initial commit holding only `README.md`) adds exactly one file, `.orbit/brief.md`. There is no `.orbit/context/` and no other path. Every later commit on the branch is this runner's own (`started.json`, `checkins.jsonl`). | **Passed** (for this one launch) | none | none. It is one launch, made by the deployed ORBIT, whose commit this runner did not check. |
| 3a | Timeouts: request deadline, cancellation, partial tool call | Existing: `model-deadline` (15). It covers no headers, a stalled body, an endless stream, a stalled 429 body, caller cancellation, listener cleanup, no fallback on a timeout, and a stall after a partial tool call (no tool run, the thread is freed, the next turn works). | **Passed** | none | none |
| 3b | Recovery: late answers, stall after a tool ran, busy-thread release, cancellation | New `acceptance-recovery`: (1) A transport that **ignores the abort** and delivers a full tool call 80 ms after the deadline: no tool runs, and a snapshot of the thread taken after the turn is byte-identical once the late answer has arrived (no late write). The next turn works. (2) A stall in round 2, after a tool ran in round 1: the call stays on the failed reply once, is not re-run, the thread is freed, there are 4 messages with no duplicate, and there is no automatic retry. (3) While thread A is stalled, a second message to A gets 409 and is not stored, and thread B answers normally. (4) A caller cancellation is `cancelled`, the port is not marked down, and the next request answers. | **Passed** | none for the repaired scope | Live observation of one real ChatGPT stall, if Rai wants it. Not required. |
| 3c | Tool execution inside a turn is unbounded | Reproduced in a scratch script (not committed): a chat tool whose `run` never resolves keeps the thread `busy` (checked after 2 s). Reproduced again at `47cf112` through `POST /threads/:id/messages` (still pending after 1.5 s). **Follow-up fix (job `orbit-202611140329-437e`):** every tool call now has a deadline (180 s default, 2 s abort grace; `docs/tool-deadlines.md`). The turn ends exactly once, the thread is freed, a late result writes nothing, and a tool that may have an effect is reported as outcome unknown and is never retried. Evidence: `test/tool-deadline.test.ts` (13). | **Fixed** in the follow-up (offline evidence only) | none for "a thread can never be held" by a tool | Not observed in production. The limitations are listed in `docs/tool-deadlines.md`. |
| 4a | Rate limit vs usage limit, reset evidence, recovery | Existing: `chatgpt-rate-vs-usage` (10). A generic 429 is a rate limit with a 1-minute pause. Structured quota codes are a usage limit. Timing precedence is `resets_at`, then `resets_in_seconds`, then `Retry-After`. Bad timing falls through. The primary is eligible again exactly at the boundary. `openrouter-fallback` (46): "a real reset: ChatGPT is not called before it…", "no reset time given…", "a call during a limit made after a restart…". | **Passed** | none | Provider reset timing in production is still unverified (as already tracked). |
| 4b | Paid fallback exclusions preserved | Existing: `chatgpt-rate-vs-usage` "fallback: timeouts, cancellation, auth, 5xx, overload and other failures never reach the paid fallback". `openrouter-fallback` "only usage and rate limits fall back…", plus the readiness tests for the scheduled worker and thread compaction. `model-deadline` "a ChatGPT timeout never reaches the paid OpenRouter fallback…". **New:** `acceptance-fallback` drives the **recent-context rewrite** (the one background caller the 2026-11-13 audit covered only by reading the code) through a usage-limited fallback model. It made 0 OpenRouter requests, spent and reserved $0, wrote no note and recorded the failure. A control shows the same wiring does reach the fake for an opted-in interactive step. | **Passed** | none | Production fallback, accounting and cap enforcement are still unverified (as already tracked). No eligibility, cap or provider setting was touched. |
| 4c | Latent risk L1: `reply()` defaults to fallback-on | New: `acceptance-fallback` pins the current behaviour as observed. A `reply()` with no option uses the fallback. Every current background caller passes `{ fallback: false }`. | **Unverified/open** (latent, unchanged) | No (no live leak today) | Rai to decide whether to make `reply()` opt-in (audit L1). |
| 5a | Browser: scripted fake of the thread routes | Existing: `chat-browser` (22), run in Chromium 153 on this runner. It covers selection, focus and scroll across polls, thread switches, late answers, A-B-A races, rename and archive races, sends blocked during a pending switch, and failed sends after a switch. | **Passed** | none | none |
| 5b | Browser: the **real ORBIT server** with a mocked model | New `acceptance-browser-real-server`, Chromium 153, against `buildServer` with the real thread store and service, the real `index.html`, a gated scripted model and fake launcher and vault (`threads-fixture.ts`). Results: (1) While Alpha's send is in flight (server-side `busy: true`), switching to Beta shows Beta empty. Enter in Beta sends nothing and keeps the text. The late Alpha reply is stored in Alpha only and is not drawn over Beta. Enter then sends to Beta, and the server shows exactly one exchange in each thread. Switching back shows Alpha's reply, and a reload restores Alpha with 2 messages and no duplicates. (2) A second device's send to a busy thread gets 409, and the first reply is not duplicated. (3) A selection and scroll position in a long history survive 3 polls and a reply appended from another device. Switching away and back shows Alpha's 4 messages and nothing from Beta. | **Passed** | none | A manual check on Rai's real browser and devices (below). Real phone and desktop browsers, a real network and the real model were not exercised. |

## What this does not establish

- Nothing here was observed in production: the deployed revision, the live vault, the live model, OpenRouter accounting and cap
  enforcement, provider reset timing, the real Routine, and recovery or rollback are all outside this run.
- Project-wide closure is **not** claimed. Of the two project notes the brief named, `Tasks/orbit-next-handover-to-orbit.md` was not in
  the runner's read-only vault checkout, so its gates were not checked here. Gates outside this brief (break-glass instructions,
  functional post-deploy checks, last-known-good, tier-2 rollback evidence, two independent reviews, the long-random-string policy) are
  unchanged by this run.
- Browser acceptance is Chromium only, headless, at one viewport, against a scripted model.

## Manual follow-up checklist (Rai, production, optional)

Each is read-only or a benign write Rai chooses to make; none needs a paid call.

1. After the next deploy, in chat: create a note `Tasks/sk-learn-<something>-notes.md` with a wikilink to another `sk-` name. Expect
   `committed`, and the note and its Log line unmasked in the vault.
2. Ask for a `System/` change and confirm the card once. Expect one commit; a second click is refused.
3. In the real browser: send a message, switch threads before the reply arrives, and check that the reply appears only in the first
   thread and that a message typed meanwhile goes to the thread on screen. Then reload and check that the history is the same.
4. Select text in an older reply and wait at least 10 s (one poll). The selection and scroll position should hold.
5. On the next launched job, check that its control-branch launch commit adds only `.orbit/brief.md` (as row 2b did for this one).

## Fixes

None in this acceptance run. No concrete blocker inside the acceptance scope was reproduced. The one open item, unbounded tool execution
(row 3c), was a documented limitation whose fix needed a design decision, so it was left to a separate job. It was fixed afterwards by job
`orbit-202611140329-437e` (bounded chat tool execution, `docs/tool-deadlines.md`).
