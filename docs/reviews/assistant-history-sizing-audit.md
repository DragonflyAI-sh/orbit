# Assistant rolling history sizing: audit and recommendation

- Job: `orbit-202611180123-rqry`. **Audit and recommendation only.** No runtime behaviour, budget, prompt, configuration or deployment
  was changed. What was added: this report, an offline measurement harness (`test/history-audit-fixture.ts`,
  `test/history-audit-capture.ts`), its test (`test/history-audit.test.ts`) and a report printer (`tools/history-audit/report.ts`).
- **Audited commit: `32bfcc7b7cc437d07fa4bfc5e120ddbbb64eebb2`** (`main`, "Web UI: collapsed "Details" footer for each message's
  metadata (Assistant and Chat) (#119)"). Every path and line below refers to that commit.
- No private chat, credential, provider or external service was read or called. All workloads are invented.

Terms used throughout:

- **Code-evidenced**: read in the source at the audited commit.
- **Synthetic measurement**: produced by running ORBIT's own code (store rotation, context planner, tool loop, instructions and tool
  schema builders) offline on invented workloads. Reproducible with the commands in section 8. Not a measurement of Rai's use.
- **Estimate**: tokens are not counted by any tokenizer. ORBIT has none; its code documents "about 4 characters per token"
  (`src/assistant-context.ts:10`) and bounds tokens by request bytes for spend reservations (`reservationUsd`, `src/openrouter.ts:151-157`).
  Here `est. tokens = ceil(chars / 4)`. The synthetic text is ASCII, so the byte upper bound equals the character count.
- **Unobserved**: a live setting or provider limit that is not in the repository and was not observed (the deployed `ORBIT_MODEL`, the
  provider's context window, its output reserve, its caching).

## 1. Summary

1. **Assistant history is bounded in characters, not messages or tokens.** Ceiling: `ASSISTANT_ACTIVE_BUDGET_CHARS` = 32,000 chars of
   bounded turns (~8k tokens est.). There is no explicit minimum; the code guarantees an **implicit floor of the 2 newest complete
   turns** because a turn is never sent larger than 12,000 chars and at least 32,000 chars are always free for history. There is no
   message-count limit at all.
2. **The history is not the largest part of a request.** In one offline capture of a real Assistant turn, the fixed part (instructions
   9,048 chars + 41 tool schemas 39,774 chars = 48,822 chars, ~12.2k tokens est.) is larger than the whole history ceiling, and this is a
   lower bound (tier 3 `ops_sys_*` tools, `photos_search` and the config view were not wired).
3. **Current-turn tool results are the dominant and unbounded growth.** With the current cap of 5 tool rounds, a heavy synthetic reply
   adds ~129k chars (~32k tokens est.) of tool results by its last request; with 20 rounds ~515k chars (~129k tokens est.). No per-round
   call count and no per-reply total bounds this; only each output is clipped (8,000 chars; `vault_policy` 42,000).
4. **No ORBIT-side check compares a request with a model context window.** The primary ChatGPT route sends no output limit and no
   truncation setting; the context window of the deployed model is unobserved. The only hard request-size limit in code is the paid
   fallback's 300,000-byte request cap.
5. **Recommendation:** raise the Assistant ceiling modestly to **48,000 chars** (context budget 68,000 chars, derived as today) and make
   the floor explicit at **4 newest complete turns** (48,000 / 12,000), keeping the 12,000-char per-turn cap and the character unit.
   Synthetic effect: typical history 6 to 9 turns, heavy history 2 to 4 turns, ~+4.3k tokens est. per request at the ceiling, ~+19%
   cumulative input for a 5-round typical reply. Do not take the larger option now; if 20 tool rounds is approved, pair it with a
   per-reply tool-result budget, which matters far more for overflow than the history size. Implementation is a separate, approval-gated
   step (section 13).

## 2. Entry points and where history is built

| Entry point | Route | History source | Compaction or bound | Code |
| --- | --- | --- | --- | --- |
| **Assistant** | `POST /assistant/messages` (owner only) | the Assistant chunk store: one chunk per turn, `active/` and `archive/` | **bounded window**, no summaries (`compact: false`) | `src/server.ts:294-319` (`asvc`, `planTurn`), `:812-857`; `src/assistant-store.ts`; `src/assistant-context.ts` |
| **Chat threads** | `POST /threads/:id/messages` | the stored thread after its summary | **compaction** into a model-written summary | `src/server.ts:294` (`svc`), `:785-806`; `src/thread-context.ts`; `src/thread-service.ts:202` |
| Legacy chat | `POST /chat` | whatever the client sends | at most 40 messages (`MAX_MESSAGES`, `src/server.ts:66`) within a 64 KiB body (`MAX_BODY_BYTES`, `:65`) | `src/server.ts:567-600` |

Both stored entry points run the same turn code (`threadService(...).turn`, `src/thread-service.ts:182-324`) and the same tool loop
(`runChat`, `src/agent.ts:154-338`). The Assistant swaps in its own context builder:
`context: { items: () => planItems(planTurn()), ... }` (`src/server.ts:318`), so its model input is `planContext` over the active,
complete chunks plus the current user message (`src/assistant-store.ts:572-574`). Each turn records what was sent on its chunk
(`recordContext`, `src/assistant-store.ts:576-580`), which the page shows as "Context sent: N of 52000 characters".

## 3. Current Assistant minimum, maximum, units and precedence

All units are **characters**, counted by `messageChars` (`src/thread-context.ts:24-25`): message text plus every tool call's
arguments and output. Images, metadata and JSON framing are not counted.

| Symbol | Value | Role | Code |
| --- | --- | --- | --- |
| `ASSISTANT_CHUNK_MAX_CHARS` | 12,000 | the largest one turn is ever sent | `src/assistant-context.ts:15` |
| `BOUNDED_OUTPUT_CHARS` / `BOUNDED_TEXT_CHARS` | 1,500 / 4,000 | inside an over-cap turn: each tool output / text is cut to this | `src/assistant-context.ts:25-26` |
| `ASSISTANT_ACTIVE_BUDGET_CHARS` | 32,000 | **history ceiling**: rotation keeps the newest complete turns whose bounded sizes fit | `src/assistant-context.ts:13`; `rotate`, `src/assistant-store.ts:277-313` |
| `MAX_MESSAGE_CHARS` | 20,000 | the largest new message (the route refuses more) | `src/threads.ts:17`; `src/server.ts:832` |
| `ASSISTANT_CONTEXT_BUDGET_CHARS` | 52,000 = 32,000 + 20,000 | hard cap on history + current message in one input | `src/assistant-context.ts:18`; `planContext`, `:121-147` |
| (none) | no message-count minimum or maximum | | |

**Precedence (what wins), code-evidenced:**

1. **Per turn** (`boundChunk`, `src/assistant-context.ts:73-106`): a turn over 12,000 chars is tried as `clipped` (each tool output to
   1,500 and each text to 4,000, with markers; a `session_read`/`sessions_list` `nextCursor` and a write's outcome facts kept whole),
   then `calls-omitted` (every tool call/result pair replaced by a one-line note with each call's outcome facts), then a one-line
   `placeholder`. The stored chunk is never changed.
2. **Rotation** (`rotate`, run when a turn ends and at start, `src/assistant-store.ts:314`, `:368`): walking newest first, keep complete
   turns while their bounded sizes fit in 32,000; archive every older complete turn (one `rename` each). It never archives past an open
   turn or a turn whose proposal card can still be confirmed, so the active window can exceed 32,000 for up to a proposal's lifetime.
3. **Plan** (`planContext`): reserve the current message first (cut to 20,000), then walk active complete turns newest first while they
   fit in `52,000 - current`; the first that does not fit stops the walk (contiguous, no gaps). Turns not sent are listed as `omitted`
   and archived by the next rotation.

**The floor and what happens when it conflicts with space.** There is no configured minimum. The structure gives one: a bounded turn is
at most 12,000 chars and the room for history is at least 52,000 - 20,000 = 32,000, so the 2 newest complete turns always survive
rotation and are always sent (`floor = floor(32,000 / 12,000) = 2`; asserted in `test/history-audit.test.ts`). Because rotation already
caps active history at 32,000, `planContext` normally omits nothing; it only omits turns kept active by a pending card. The floor
therefore never conflicts with available space *inside the character budget*. It is not checked against the model's token window
(section 5), so the conflict that can occur in practice is the whole request exceeding a provider limit, and then the turn fails
(section 10, "Overflow").

**What is not history:** the current turn's chunk is open, so it is never part of the history; its user message is passed separately
and its tool results grow inside `runChat` (section 6). Archived turns are never sent automatically (`docs/assistant.md`, "Rotation and the
archive"); the model can read them only through `session_read`.

### Chat threads, for comparison (code-evidenced)

`src/thread-context.ts:11-14`: compaction starts when messages after the summary exceed `CONTEXT_BUDGET_CHARS` = 48,000; it then
summarizes the oldest messages and keeps verbatim at least `KEEP_RECENT_CHARS` = 16,000 chars **and** `KEEP_RECENT_MESSAGES` = 4 messages,
starting at a user message (`compactionCut`, `:160-175`). The summary is at most `SUMMARY_MAX_CHARS` = 6,000. Compaction runs before the
turn (`src/thread-service.ts:202`); a failure never blocks the reply. Chat history is not clipped per turn: stored tool outputs (up to
8,000 each) are sent verbatim, and the kept tail has no upper bound, so one very large recent turn can keep a chat request well above
48,000. Chat's minimum is therefore a message count *and* a character count; its maximum is a soft trigger, not a cap.

## 4. What one Assistant request contains

| Part | Bound | Unit | Counted in a history budget? | Code |
| --- | --- | --- | --- | --- |
| Fixed instructions (rules, status limits, tool names, round guidance, photo and lane guidance, record-check rule) | none; measured 9,048 at a tool step, 2,532 at the forced final step | chars | no | `instructions`, `src/model.ts:150-185`; `roundGuidance`, `:134-150` |
| Tool schemas | none; measured 39,774 for 41 tools (lower bound); **not sent** at the forced final step | chars of JSON | no | `responsesTools`, `src/model.ts:242`; `src/chatgpt.ts:777-783` |
| Retrieved notes: vault hits (5 x 2,000 chars) and the device summary | cut to `ASSISTANT_NOTES_MAX_CHARS` = 12,000 | chars | no | `src/server.ts:435-451`, `:67`; `boundNotes`, `src/assistant-context.ts:155-162` |
| Session activity digest | `DIGEST_TOTAL_MAX_CHARS` = 6,000, added after the notes cap | chars | no | `src/session-digest.ts:13-18`; `src/server.ts:851` |
| Proposal card lines | at most 20 lines (`ASSISTANT_CARD_LINES_MAX`); no per-line bound | lines | no | `src/assistant-context.ts:22`; `src/thread-service.ts:206` |
| Rolling recent-work note, thread summary | not given to the Assistant (chat only: note 1,500, summary 6,000) | chars | n/a | `src/recent-context.ts:125`; `src/thread-context.ts:14` |
| **Rolling history** | 32,000 active; 52,000 with the current message | chars | yes | section 3 |
| Current user message | 20,000 | chars | yes | `src/threads.ts:17` |
| Photos | at most 10 images and 10 MiB per request, photos from at most 2 earlier messages; tools may add images in at most 3 calls per reply within the same bounds | images, bytes | no | `src/photo-context.ts:12-14`; `MEDIA_CALLS_MAX`, `src/agent.ts:49` |
| **Current-turn tool calls and results** | each output clipped to `MAX_OUTPUT_CHARS` = 8,000 (`vault_policy`: `POLICY_OUTPUT_MAX` = 42,000); **no bound on calls per round or on the reply total** | chars | no ("not counted in the 52,000", `docs/assistant.md:79`) | `src/agent.ts:12`, `:151-152`, `:383`; `src/vault/tools.ts:15-17` |
| Response (output) reserve | primary: **none sent**; fallback: `max_tokens` default 2,048, at most 8,192 | tokens | no | `src/chatgpt.ts:777-801`; `src/openrouter.ts:19-20`, `:296` |

The reference material (notes, digest, cards) travels inside the `instructions` string, after the rules (`src/model.ts:177-183`).
Image token cost is provider-specific and not estimated here.

## 5. Model and provider configuration: what is known

- **Model:** `ORBIT_MODEL` selects it (`selectModel`, `src/model.ts:375-386`; `src/main.ts:63`). The repository has **no default**
  (`deploy/install.sh:26` leaves it to the operator). The deployed value is **unobserved**.
- **Primary transport:** ChatGPT token sharing, Responses API body `{model, instructions, input, tools, stream, store: false}`
  (`src/chatgpt.ts:777-801`). It sends **no `max_output_tokens`, no truncation setting and no cache key**. ORBIT documents that this
  route has no model metadata endpoint (`CHATGPT_NO_METADATA`, `src/chatgpt.ts:379-380`), so ORBIT cannot read the context window.
- **API-key transport** (`openaiModel`, `src/model.ts:318-330`): same body shape, also no output limit.
- **Paid fallback (OpenRouter, off by default):** `max_tokens` from `ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS` (default 2,048, max 8,192),
  and a **hard request cap of 300,000 bytes** (`MAX_REQUEST_BYTES`, `src/openrouter.ts:29`, checked at `:303`). The model's
  `context_length` is checked only by the offline price check tool, not per request.
- **Context capacity:** not determinable from the repository. This report therefore states requirements ("a request needs N tokens
  est. plus the output reserve") rather than percentages of an assumed window. No 128k or 200k figure is assumed anywhere.

## 6. Tool-round enforcement

- `MAX_ROUNDS = 5` (`src/agent.ts:11`). `runChat` takes `maxRounds` as an option (`:162`, `:189`) but **no caller passes it**
  (`grep maxRounds src` finds only `src/agent.ts`), so every chat thread, Assistant and legacy `/chat` reply uses 5.
- Steps 0..4 may call tools; step 5 is sent with **no tools** and must answer (`capped`, `:257-279`); a capped reply carries an
  owner-visible `BUDGET_NOTE`. So a reply makes at most **6 model requests** today; at 20 rounds it would make at most **21**.
- Every request re-sends the whole input so far: history, current message and **every earlier tool call and result of this reply**
  (`input.push`, `:298`, `:321`). Nothing in the loop trims or budgets that growth.
- The 20-round scenario below is evaluated only by passing `maxRounds: 20` to `runChat` in the offline harness. That change was
  requested separately; it is **not implemented here and not assumed deployed**.

## 7. Preservation guarantees (code-evidenced)

- **Complete tool exchanges.** History items are built as `function_call` immediately followed by its `function_call_output`
  (`buildItems`, `src/thread-context.ts:65-89`). `boundChunk` clips outputs in place and, when it must drop calls, drops each call with
  its result and keeps each call's outcome facts (`src/assistant-context.ts:86-98`). No path sends a call without its result.
- **Newest user instruction.** The current message is reserved before any history (`planContext`, `:123-127`) and is never cut below
  20,000 chars (the route refuses longer). The newest 2 complete turns are always sent (section 3).
- **Old tool outputs first?** Partly. Inside an over-cap turn, tool outputs (to 1,500) and texts (to 4,000) are cut *in the same stage*;
  turns under the cap are sent whole regardless of age. Two feasible refinements, neither needed for the recommendation:
  (a) cut outputs before texts; (b) age tiers: send turns older than the newest 2 in clipped form even when they would fit whole.
  From the synthetic shapes, (b) shrinks a typical turn from 5,640 to about 4,740 chars (~16%); heavy turns are already clipped. So (b)
  buys roughly one more typical turn per 48,000 chars, at the cost of more marker text in older turns.
- **Fixed counts versus token-aware maximum.** The Assistant does not use message counts (chat compaction does: 4 messages). A
  token-aware adaptive maximum would need (1) a tokenizer (none in the repo; it would be a new dependency) and (2) the model's window,
  which ORBIT cannot read on the primary route (section 5). A practical intermediate: keep characters, and later derive the ceiling from
  an operator-declared window, `min(ceiling, window - fixed - reference - current - tool reserve - output reserve)`, never below the floor.
  Not recommended now: the window is unknown and the fixed and tool-result parts dominate.

## 8. Methodology (reproducible)

- Harness: `test/history-audit-fixture.ts` (invented turn shapes, histories, reference sizes and tool loads; runs the real
  `assistantStore` rotation in memory with an option's `activeBudget`, then the real `planContext` with that option's context budget;
  runs the real `runChat` loop with a scripted model and a synthetic read tool, recording `JSON.stringify(responsesInput(input))` of
  every request).
- Fixed part: `test/history-audit-capture.ts` starts ORBIT's real server offline (temporary state, a temporary git vault fixture, a
  capturing model), sends one Assistant message, and measures `instructions(limits, no notes, tools, rounds)` and
  `JSON.stringify(responsesTools(tools))` for the tools the server offered. Wired: chat tools, admin operations, vault edits, PR
  inspection, research, sessions, photos (41 tools). Not wired: `ops_sys_*`, `photos_search`, config view. **Lower bound.**
- Options differ only in `active` (the history ceiling); the context budget is `active + 20,000` as today; the per-turn cap stays
  12,000; floor = `floor(active / 12,000)`.
- Occupancy of a request = fixed + reference material + history (`messageChars` of the plan) + current message + tool results added so
  far (growth of the measured input since the first request). The forced final step uses the final-step instructions and no schemas.
  Cumulative input = sum over all requests of the reply.
- Commands: `node tools/history-audit/report.ts` prints every table in section 9; `node --test test/history-audit.test.ts` checks the
  harness and the floor and monotonicity properties. Both are offline and deterministic for a given commit.
- Approximations: history JSON framing (call ids, roles) is not counted, as in ORBIT's own budget; the 300,000-byte check compares
  characters with bytes and ignores JSON escaping, so it is marked "approx."; images are excluded.

## 9. Synthetic measurements

<!-- generated: node tools/history-audit/report.ts (audited commit 32bfcc7) -->
All figures below are SYNTHETIC measurements of ORBIT's own code on invented workloads; token figures are ESTIMATES (characters / 4).

Fixed part measured offline (lower bound, 41 tools wired): instructions 9,048 chars at a tool step, 2,532 at the forced final step; tool schemas 39,774 chars (not sent at the forced final step).

### Turn shapes

| turn | user | reply | tool calls | stored chars | est. tokens |
| --- | ---: | ---: | --- | ---: | ---: |
| small | 160 | 500 | none | 660 | 165 |
| typical | 400 | 1,400 | 2,400 + 1,200 | 5,640 | 1,410 |
| heavy | 1,200 | 3,000 | 8,000 + 8,000 + 4,000 + 2,000 | 27,000 | 6,750 |

### History retention by option (current message 400 chars)

| option | active / context budget | floor (turns) | history | turns sent (of 120) | forms | history chars | est. tokens |
| --- | ---: | ---: | --- | ---: | --- | ---: | ---: |
| Baseline (current code) | 32,000 / 52,000 | 2 | small | 48 | 48 full | 31,680 | 7,920 |
| Baseline (current code) | 32,000 / 52,000 | 2 | typical | 6 | 5 full, 1 clipped | 29,230 | 7,308 |
| Baseline (current code) | 32,000 / 52,000 | 2 | heavy | 2 | 2 clipped | 21,992 | 5,498 |
| Modest (recommended) | 48,000 / 68,000 | 4 | small | 72 | 72 full | 47,520 | 11,880 |
| Modest (recommended) | 48,000 / 68,000 | 4 | typical | 9 | 7 full, 2 clipped | 46,524 | 11,631 |
| Modest (recommended) | 48,000 / 68,000 | 4 | heavy | 4 | 4 clipped | 43,984 | 10,996 |
| Larger | 72,000 / 92,000 | 6 | small | 109 | 109 full | 71,940 | 17,985 |
| Larger | 72,000 / 92,000 | 6 | typical | 13 | 3 clipped, 10 full | 69,456 | 17,364 |
| Larger | 72,000 / 92,000 | 6 | heavy | 6 | 6 clipped | 65,976 | 16,494 |

### Current-turn tool rounds (real runChat loop, history = typical/baseline)

| load | max rounds | model requests | tool-result chars added by the last request | est. tokens |
| --- | ---: | ---: | ---: | ---: |
| light (600 per round) | 5 | 6 | 4,635 | 1,159 |
| light (600 per round) | 20 | 21 | 18,560 | 4,640 |
| typical (2,500 + 1,500 per round) | 5 | 6 | 23,680 | 5,920 |
| typical (2,500 + 1,500 per round) | 20 | 21 | 94,760 | 23,690 |
| heavy (12,000 + 8,000 + 8,000 per round) | 5 | 6 | 128,845 | 32,212 |
| heavy (12,000 + 8,000 + 8,000 per round) | 20 | 21 | 515,440 | 128,860 |

### Whole request: occupancy and cumulative input (typical history, typical reference material, current message 400 chars)

| option | load | max rounds | requests | first request (fixed / retrieved / history / current) chars | first est. tokens | peak request chars (step) | peak est. tokens | tool results at peak | cumulative input est. tokens |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| baseline | typical | 5 | 6 | 87,952 (48,822 / 9,500 / 29,230 / 400) | 21,988 | 106,896 (4) | 26,724 | 18,944 | 138,116 |
| baseline | typical | 20 | 21 | 87,952 (48,822 / 9,500 / 29,230 / 400) | 21,988 | 177,972 (19) | 44,493 | 90,020 | 698,871 |
| baseline | heavy | 5 | 6 | 87,952 (48,822 / 9,500 / 29,230 / 400) | 21,988 | 191,028 (4) | 47,757 | 103,076 | 216,990 |
| baseline | heavy | 20 | 21 | 87,952 (48,822 / 9,500 / 29,230 / 400) | 21,988 | 577,617 (19) | 144,405 | 489,665 | 1,803,131 |
| modest | typical | 5 | 6 | 105,246 (48,822 / 9,500 / 46,524 / 400) | 26,312 | 124,190 (4) | 31,048 | 18,944 | 164,057 |
| modest | typical | 20 | 21 | 105,246 (48,822 / 9,500 / 46,524 / 400) | 26,312 | 195,266 (19) | 48,817 | 90,020 | 789,664 |
| modest | heavy | 5 | 6 | 105,246 (48,822 / 9,500 / 46,524 / 400) | 26,312 | 208,322 (4) | 52,081 | 103,076 | 242,931 |
| modest | heavy | 20 | 21 | 105,246 (48,822 / 9,500 / 46,524 / 400) | 26,312 | 594,911 (19) | 148,728 | 489,665 | 1,893,924 |
| larger | typical | 5 | 6 | 128,178 (48,822 / 9,500 / 69,456 / 400) | 32,045 | 147,122 (4) | 36,781 | 18,944 | 198,455 |
| larger | typical | 20 | 21 | 128,178 (48,822 / 9,500 / 69,456 / 400) | 32,045 | 218,198 (19) | 54,550 | 90,020 | 910,057 |
| larger | heavy | 5 | 6 | 128,178 (48,822 / 9,500 / 69,456 / 400) | 32,045 | 231,254 (4) | 57,814 | 103,076 | 277,329 |
| larger | heavy | 20 | 21 | 128,178 (48,822 / 9,500 / 69,456 / 400) | 32,045 | 617,843 (19) | 154,461 | 489,665 | 2,014,317 |

### Bound case (heavy history, maximum reference material, 20,000-char message)

| option | load | max rounds | first request chars | first est. tokens | peak request chars | peak est. tokens | over 300,000 (fallback request cap)? |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | typical | 5 | 113,814 | 28,454 | 132,758 | 33,190 | no |
| baseline | heavy | 5 | 113,814 | 28,454 | 216,890 | 54,223 | no |
| baseline | heavy | 20 | 113,814 | 28,454 | 603,479 | 150,870 | yes (approx.) |
| modest | typical | 5 | 135,806 | 33,952 | 154,750 | 38,688 | no |
| modest | heavy | 5 | 135,806 | 33,952 | 238,882 | 59,721 | no |
| modest | heavy | 20 | 135,806 | 33,952 | 625,471 | 156,368 | yes (approx.) |
| larger | typical | 5 | 157,798 | 39,450 | 176,742 | 44,186 | no |
| larger | heavy | 5 | 157,798 | 39,450 | 260,874 | 65,219 | no |
| larger | heavy | 20 | 157,798 | 39,450 | 647,463 | 161,866 | yes (approx.) |

Reading the tables:

- **Retention.** Today a typical mixed history keeps the newest 6 of 120 turns and a heavy one only 2 (the floor). Modest keeps 9 and 4;
  larger 13 and 6. Small turns are cheap: 48, 72 and 109 turns.
- **First request.** In the typical case the fixed part is 48,822 of 87,952 chars (56%) at baseline. Modest adds 17,294 chars of
  history (~4.3k tokens est., +20% on the first request); larger adds 40,226 (~10k tokens est., +46%).
- **Tool rounds dominate the peak.** At 5 rounds the typical load adds ~19k chars by the peak request and the heavy load ~103k; at 20
  rounds ~90k and ~490k. The difference between history options (17k to 40k chars) is small next to a heavy reply's own tool results.
- **Cumulative input** per 5-round typical reply: 138k (baseline), 164k (modest, +19%), 198k (larger, +44%) tokens est. At 20 rounds:
  699k, 790k (+13%), 910k (+30%). The relative cost of a larger history falls as rounds grow, but the absolute cost of rounds grows
  roughly quadratically, because every request re-sends all earlier results.
- **Peak** (largest single request; the forced final step drops ~40k chars of schemas, so the peak is usually the last tool step):
  typical 5-round 26.7k / 31.0k / 36.8k tokens est. (baseline / modest / larger); heavy 20-round ~144k to 154k tokens est. in every
  option. In the bound case only the heavy 20-round reply exceeds the fallback's 300,000-byte cap, in every option.

## 10. Options compared

| | Baseline (today) | **Modest (recommended)** | Larger |
| --- | --- | --- | --- |
| History ceiling (`ASSISTANT_ACTIVE_BUDGET_CHARS`) | 32,000 (~8k tok est.) | **48,000 (~12k)** | 72,000 (~18k) |
| Context budget (ceiling + 20,000) | 52,000 | **68,000** | 92,000 |
| Per-turn cap | 12,000 | 12,000 | 12,000 |
| Floor (newest complete turns always sent) | 2 (implicit) | **4 (make explicit)** | 6 |
| Turns kept: small / typical / heavy history | 48 / 6 / 2 | 72 / 9 / 4 | 109 / 13 / 6 |
| First request, typical case (tokens est.) | 21,988 | 26,312 (+20%) | 32,045 (+46%) |
| Cumulative input, 5 typical rounds (tokens est.) | 138,116 | 164,057 (+19%) | 198,455 (+44%) |
| Peak, 5 heavy rounds, bound case (tokens est.) | 54,223 | 59,721 | 65,219 |
| Needs a model window of at least (5 rounds, bound case) | ~54k + output reserve | ~60k + output reserve | ~65k + output reserve |

**Retention benefit.** Modest raises the floor from 2 to 4 turns, which is what matters most in heavy, research-style use (two heavy
turns today means the model loses the turn before last as soon as a third arrives). For typical use it adds ~3 turns.

**Overflow behaviour (all options, code-evidenced).** The character budgets are hard: history and current message never exceed the
context budget (randomized check in `test/assistant-store.test.ts:283-306`). The whole request is not checked against any window. If the
provider refuses an oversized request, the turn ends as an error: the reply is marked `error` with "The model call failed: ..." and the
user message and every completed tool call stay stored; nothing is retried (`src/thread-service.ts:314-322`). No code recognizes a
context-length error specifically. On the fallback, a request over 300,000 bytes fails before sending ("the conversation is too long to
send", `src/openrouter.ts:303`). A larger history moves every request closer to such a failure by the same fixed amount; tool rounds
move late requests much further.

**Remaining tool and output headroom.** Not computable as a percentage because the window is unobserved. What can be said: at 5 rounds,
the bound case needs ~54k (baseline) to ~65k (larger) tokens est. plus the output reserve and reasoning; at 20 heavy rounds, ~151k to
~162k. Modest costs ~5.5k tokens est. of that headroom in the bound case; the 20-round change, without a tool-result budget, can cost
~96k more.

**Cost and latency (qualitative).** No rates or timings are evidenced for the primary (a ChatGPT subscription route), so none are
claimed. Input processed per reply grows linearly with history and roughly quadratically with tool rounds (table above). Caching: ORBIT
sends `store: false` and no cache key; whether the provider reuses a cached prefix is **unobserved**. Note for any cache assumption: the
instructions string changes at every step (the round guidance line "this is step N" precedes the reference material), so any prefix that
reuses the instructions would end at that line; the history items that follow are stable across the steps of one reply. This is an
observation about request shape, not a measurement.

## 11. Recommendation

1. **Assistant history: adopt the modest option.** Ceiling `ASSISTANT_ACTIVE_BUDGET_CHARS` 32,000 to **48,000**; context budget follows
   (68,000); keep the 12,000-char per-turn cap, the 20,000 message cap and the character unit. Make the floor explicit as a documented
   constant of **4 turns** with an invariant (ceiling >= 4 x per-turn cap; context = ceiling + message cap).
2. **Do not take the larger option yet.** It adds ~10k tokens est. to every request (+44% cumulative for a typical reply) for ~4 more
   typical turns, before anything is known about the deployed window.
3. **If 20 tool rounds is approved, add a per-reply tool-result budget first or together** (for example: once the reply's tool results
   exceed a character budget, the next step is the forced final step, as at the round cap; or older rounds' outputs are cut to 1,500 with
   facts and cursors kept). That bound protects the window far more than any history choice.
4. **Chat threads: no change recommended in this job** (their 48,000 trigger is already above the Assistant's ceiling); see open
   questions.
5. Keep token-aware sizing as a later step tied to an operator-declared window; it is not useful while the window is unobserved.

## 12. Rollout notes for the recommended change

- Raising the ceiling never brings archived turns back (the archive is never re-activated); retention grows over the next turns.
- Rolling back to 32,000 is safe: the next rotation archives the extra turns; nothing is deleted.
- The page reads the budgets from `GET /assistant` (`budgets`, `src/server.ts:421`) and each turn's recorded `context`, so the "Context
  sent: N of M" line follows automatically. Browser tests use literal fixture budgets and are unaffected.

## 13. Proposed implementation and test plan (for Rai's approval; not done here)

Scope: one small PR, Assistant only.

1. `src/assistant-context.ts`: `ASSISTANT_ACTIVE_BUDGET_CHARS = 48_000`; add `ASSISTANT_MIN_TURNS = 4` (documentation of the floor);
   update the "~8k, 3k and 13k tokens" comment to ~12k, 3k and 17k.
2. `docs/assistant.md`: budgets table (48,000 / 68,000), the floor sentence, and the "Limits" bullets.
3. Tests:
   - `test/assistant-store.test.ts`: add `ASSISTANT_ACTIVE_BUDGET_CHARS >= ASSISTANT_MIN_TURNS * ASSISTANT_CHUNK_MAX_CHARS` and a
     randomized check that the `ASSISTANT_MIN_TURNS` newest complete turns are always sent, with a 20,000-char message, without a held
     card.
   - Existing budget tests (`:204`, `:283-311`, `test/assistant-server.test.ts:156`) use the constants and should pass unchanged.
   - `test/history-audit.test.ts` keeps the baseline row equal to the code, so it must be updated in the same PR (baseline becomes 48,000).
4. Acceptance: on the deployed host, after several long turns, the "Context sent" line shows "of 68000" and the dimmed "not sent" line
   moves later; restart keeps the split.
5. Separate, only with the 20-round change: a per-reply tool-result budget in `runChat` with its own tests (budget reached means the
   forced final step and the `BUDGET_NOTE`-style owner note; pairs never split; cursors and outcome facts kept).

## 14. Unresolved questions (for Rai)

1. What is the deployed `ORBIT_MODEL`, and what context window and output limit does the ChatGPT token-sharing route give it? (Not in the
   repository; ORBIT cannot read it on that route.)
2. Does the provider count reasoning tokens against the same window, and is there any default output reserve on the primary route?
3. Is the 20-round increase approved, and should it ship with a per-reply tool-result budget (recommended)? If so, what budget?
4. Should chat threads change too (for example `KEEP_RECENT_CHARS` 16,000 to 24,000), or stay as they are?
5. Is prompt caching expected on the primary? If it matters, a later change could move the per-step round guidance after the stable
   material; that is outside this audit.
6. Are live per-turn context records (the `context` field already stored on each chunk) acceptable to read, with Rai's approval, to
   replace these synthetic shapes with real size distributions? This audit did not read them.

## 15. Limits of this audit

- All sizes are synthetic and all tokens estimated; real conversations, real tool outputs and real tokenization can differ, especially
  for non-English text, code and JSON (more tokens per character).
- The fixed part is a lower bound (section 8). Images are not costed.
- Provider behaviour (window, output reserve, caching, error shapes for oversize requests) is unobserved.

## 16. Verification

| Check | Command | Outcome |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` (`tsc`) | exit 0, no output |
| Tests | `pnpm test` (`node --test test/*.test.ts`) | exit 0: tests 1555, pass 1555, fail 0, cancelled 0, skipped 0, todo 0 (about 97 s). Includes the 5 tests of `test/history-audit.test.ts`. |
| Report | `node tools/history-audit/report.ts` | the tables in section 9, regenerated after the last code change |
| Secret scan | `docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 git /repo --redact -v --log-opts=HEAD` | **Not run**: the Docker client exists but no daemon is reachable in this environment (`failed to connect to the docker API at unix:///var/run/docker.sock`). The new files were grepped for secret shapes instead (none). CI's gitleaks job remains the real check. |

`tools/` is outside `tsconfig.json`'s `include`, so the report printer is kept to a few lines; all of its logic is in `test/` and is
typechecked.
