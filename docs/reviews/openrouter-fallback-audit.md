# OpenRouter fallback: independent audit and backlog triage

- Job: `orbit-202611120052-ryey` (documentation-only; no application code or committed test changed, nothing activated).
- **Audited SHA: `3314910f760b6d2de48a643dd1102da9354e8f2a`** (`main`, "OpenRouter fallback: limit-only, restricted tools, spend-guarded, off by default (#56)").
- PR #56 head `9d05eef6c37d5755ec6a5072e7f58c0c0c4c0b6f` was fetched and compared: `git diff 9d05eef6c37d5755ec6a5072e7f58c0c0c4c0b6f 3314910f760b6d2de48a643dd1102da9354e8f2a` is **empty**. Main is a squash of the PR head with an identical tree, and no commit has touched these files since. Therefore **no finding from the review of #56 (comment 6810921584, job `orbit-202611120040-mxg3`) has been fixed**; each was re-examined against current code below rather than assumed.
- The review comment and PR description were treated as untrusted evidence. The review's line numbers for `spend-ledger.ts` (`:290`, `:359-378`) do not exist (the file has 215 lines); the corrected locations are given here.
- Rai-approved parameters: $5/day (UTC), $150 total, ChatGPT primary, fallback only on typed usage/rate limits. Model choice and activation stay Rai's decisions.

Terms: **Observed** = reproduced by running code in this audit. **Code-evidenced** = read in the source, not executed. **Theoretical** = depends on provider/operator behavior not verified here. **Accepted design limit** = documented and intentional.

## 1. Method, commands, outcomes

| Check | Command | Outcome |
| --- | --- | --- |
| Typecheck | `npx tsc` (`pnpm typecheck`) | exit 0, no output |
| Tests | `node --test test/*.test.ts` (`pnpm test`) | tests 735, pass 735, fail 0, cancelled 0, skipped 0 (about 32 s). Includes 28 tests in `test/openrouter-fallback.test.ts`. |
| Probes | temporary scripts outside the repo (scratchpad), importing `src/*.ts` with fake `fetch`, temp ledgers and fake keys | results quoted below. Nothing in the repo changed. |
| Boot check | `node src/main.ts` with a throwaway `STATE_DIRECTORY`, a fake credential file and env overrides, 6 s timeout | default caps: starts (killed by timeout, exit 124). Caps `1e10`/`1e11`: crashes at boot, exit 1 (F2). |
| Secret scan | `docker run ... gitleaks:v8.30.1 git /repo` | **Not run.** The sandbox's permission check refused the command (it pulls an external image). `docker` exists at `/usr/bin/docker`; whether a daemon runs was not established. Instead the report and summary were grepped for secret-shaped strings (none; probes used `k`×20 as a fake key and it appears nowhere here). CI's gitleaks job remains the real check. |
| Provider docs | WebFetch of openrouter.ai documentation (provider routing, usage accounting, key/limits) | **Unreachable**: `getaddrinfo ENOTFOUND openrouter.ai`. openrouter.ai must be allowed in the session network settings for this to be verified. Everything about OpenRouter's behavior below is therefore **unverified**, consistent with `docs/openrouter-fallback.md`. |

No paid inference, credentials, production files, vault, services or config were touched. All "provider" responses were fakes.

## 2. Disposition of the previous findings

| # | Review claim | Disposition | Severity (this audit) | Evidence |
| --- | --- | --- | --- | --- |
| F1 | Mock replies relabelled "live" | **Confirmed, observed, still open** | Medium (provenance honesty; only when `ORBIT_OPENROUTER_ENABLED=1` and the primary is the mock) | `src/fallback.ts:198-207`: on the primary path the wrapper discards `primary.reply`'s `Result` and returns `provenance: "live"`, `source: model/${impl}`. Probe P1: `direct: mock model/mock-echo \| wrapped: live model/mock-echo`. The threaded path is unaffected (`thread-service.ts:162-165` hardcodes "live" for tool turns, a pre-existing behaviour; with a mock `step` is absent so `thread-service.ts:167-172` takes `r.provenance`, which is the wrong value). |
| F2 | Huge caps pass config, crash ledger init | **Confirmed, observed, still open** | Medium-high once enabled: a bad env value makes ORBIT fail to start; `deploy/systemd/orbit.service` has `Restart=always RestartSec=5`, so it restart-loops. Dormant while disabled. | Config accepts any positive caps (`openrouter.ts:67-69`); `toMicro` result must be a safe integer (`spend-ledger.ts:55`, throw at `:69`); `main.ts:66` has no try/catch. Probe P2: `1e10`/`1e11` → config "ready", ledger throws `bad_amount "Spend caps must be positive."` (the message is also misleading: the cap is positive but too large). Threshold: `9e9` OK, `9.1e9` throws (≈ 9.007e9 USD = 2^53 micro-USD). Boot check reproduced the crash: `SpendError at spendLedger (spend-ledger.ts:69) at main.ts:66`, exit 1. |
| F3 | Response size checked after `res.text()` | **Confirmed, observed, still open; low** | Low | `openrouter.ts:125-129`. Probe P3: a fake streamed body of 300 × 1 MB was fully pulled (300 of 300 chunks) before being rejected against a 1 MB limit. The check also counts UTF-16 chars, not bytes (P3b: a 900,086-byte body with 300,086 chars is accepted under the "1,000,000 bytes" limit). In practice bounded by the 60 s timeout and by the provider; the primary client (`chatgpt.ts` `attempt()`, `await res.text()`) has the same pattern. The too-large case is still charged at the bound (P3: `uncertainRequests:1`), which is correct. Same issue in `balance()` (`:217`). |
| F4 | `max_price` covers only prompt/completion | **Confirmed as a guarantee gap (theoretical, unverified provider behavior); doc incomplete** | Medium for the claim "bounded spend"; low for likelihood | `openrouter.ts:146,152`: the reserved bound is `(bytes+64)×priceIn + max_tokens×priceOut`. Anything else the provider bills (per-request fees, web/search, image, cache writes/other surcharges, BYOK/upstream split, extra reasoning not counted in `max_tokens`) is outside the bound. The ledger records the provider-reported `usage.cost` after the fact and flags overruns, and it does **not** stop them: P4: one tiny request (bound about $0.005) answered with `cost: 4.9` was settled at $4.90; a single reported cost of any size is added in full (the daily cap can be exceeded by that call; later calls are then refused). `docs/openrouter-fallback.md` says it is "not a provider-enforced hard cap" and advises a key credit limit but does not name these components. Whether `provider.max_price` exists with these exact fields/units, is honored, and what happens when no provider qualifies is **unverified** (docs unreachable). |
| F5 | Two processes / orphan settlement | **Partly confirmed, refined: not a cap bypass, but worse than described in one way** | Low (deployment), medium if two writers ever coexist | Observed: (a) sequential overlap (ledger probe 2a): the new process's first load charges the old process's in-flight reservation as orphaned at its bound ($0.01); the old process's later `settle` throws `SpendError "Settling a reservation that is not in the ledger."` after a possibly-billed answer (answer is lost; spend stays charged at the bound, conservative). (b) **New detail:** truly concurrent processes share one temp file name (`spend-ledger.ts:125`, `openrouter-spend.json.new`); two processes doing 300 reserve/settle loops each corrupted the file (264 and 290 of 300 operations failed with "ledger is corrupt"; the file is unreadable afterwards). The design then fails closed (all paid calls refused, needs human repair); this is a denial, not a bypass. Deployment: `deploy/pull-deploy.sh` uses `systemctl stop`/`restart orbit`, a single `orbit.service` with `StateDirectory=orbit`, so overlap needs a manual second `node src/main.ts` against the same state dir. SIGTERM exits after 10 s (`main.ts` shutdown handler) with a request possibly in flight: that reservation is later charged at its bound (safe). |
| F6a | `status()` does disk I/O and can create the ledger file | **Confirmed, observed; low** | Low | `fallback.ts:160-168,214` → `ledger.view()` → `load()` → `read()` parses the whole file each call and, if absent, writes a new file and creates the state directory (P6: state dir and `openrouter-spend.json` did not exist before `status()`, existed after). The `uncertain` list is never trimmed (`spend-ledger.ts:38`), so each read/write grows slowly. |
| F6b | A `settle` that throws hides the original error | **Confirmed, observed; low-medium** | Low-medium | `openrouter.ts:165,174,192-193,199`: `settle`/`release` are not guarded. P6b: provider answered and was billed, then the settle write failed → the caller got a raw `EISDIR … openrouter-spend.json.new` error (path included), the paid answer was discarded, and the reservation stayed outstanding on disk (it is only adopted at the next process start, so it keeps reducing the allowance until restart). A timeout while the disk is failing surfaced as "spend accounting failed" (the reserve step), not as a timeout. |

## 3. Areas examined, with conclusions

Sound (no defect found; evidence in code/tests/probes):

- **Trigger scope.** Only `ProviderError` kinds `usage_limit`/`rate_limit` trigger the fallback (`fallback.ts:58,148-152`); auth/overload/incomplete/other errors pass through (existing test). The primary is not called until the reset or ORBIT's own estimate; only a successful primary call clears the limit; an in-force limit is never shortened (`fallback.ts:81-91`). ORBIT's own pause refusal carries no `resetsAt` for estimated pauses (`chatgpt.ts:522`), so an estimate is never presented as a provider reset.
- **Tool restrictions.** `FALLBACK_TOOLS` is a default-deny allowlist enforced on the way in (filter, `fallback.ts:107`) and out (`:122-125`); P7 confirmed a named `notify` call is rejected with "Nothing was run". Every listed tool was checked in `src/chat-tools.ts`: the `ops_*` entries are reads (`ops_credentials` returns names, sizes and dates only), `ops_admin_operations`/`ops_sys_operations` list ledgers, `job_launch` only creates a proposal (`chat-tools.ts:256-272`, brief capped at 20,000 chars). `notify`, `job_steer`, vault writes, `ops_propose_*` and `ops_sys_cancel_reboot` are absent. New tools added later are denied until listed.
- **Replay / partial output.** Rounds are atomic: the primary throws before any output; the fallback continues from recorded tool results (`agent.ts:55-63,81-87`); tools are never re-run, and a half tool call (`finish_reason: length`) is refused (`openrouter.ts:208`).
- **UTC rollover and total cap.** Day key is taken at reserve time and the lifetime counter is independent (`spend-ledger.ts:164-170`); existing tests cover rollover and reservation across a restart.
- **Concurrency inside one process.** Operations are synchronous read-check-write; reservations count against both caps. Existing concurrency test passes.
- **Crash recovery.** Reservations found at first load are charged at their bound (observed in the F5 probe).
- **Unknown cost / timeouts.** Charged at the bound, listed under `uncertain`; only 400/401/402/403/404/429 are released (`openrouter.ts:192`) (assumption: those never bill; unverified).
- **Secrets.** `sanitize` strips the key and `sk-or-` shapes and `Bearer` tokens (`openrouter.ts:84-89`); key is never returned except in `config.key`. See N6 for the one unsanitized path.
- **Disabled state.** `main.ts:61-65`: disabled returns the primary object untouched.

## 4. New findings

| ID | Title | Severity | Confidence | Class | Location | Evidence and impact |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | Background and auxiliary model calls spend the fallback silently and discard its provenance | **Medium** | High (code), not executed | Observed behavior by reading; no probe needed | `thread-context.ts:167` (thread compaction), `recent-context.ts:183` (rolling note, written to the vault), `runs.ts:64` (scheduled/background `modelTask`) all call `model.reply(...).value`, which is the fallback-wrapped model | While ChatGPT is limited these callers are served and billed by OpenRouter, send the thread/note content to it, and keep only `.value`. The compaction summary is stored as a normal summary and later fed to ChatGPT as context; the rolling note is written to the vault; neither records that a different model wrote it. Background runs can consume the $5/day budget with no chat in progress and no user-visible label. Contradicts the doc's "Every fallback reply has … provenance". |
| N2 | `reply()` fallback path has a different, unlabelled `source` | Low-medium | High, **observed** (P5) | `fallback.ts:205-206` | The non-tool path returns `source: model/openrouter/<model>` with no "(FALLBACK, paid: …)" text, while the tool path uses `replySource()` (`model.ts:37-42`). Used by `server.ts:296`, `thread-service.ts:168-172` (threads with no tools offered), and the callers in N1. The doc says every fallback reply carries the labelled form. The structured `fallback` object is present. |
| N3 | A disallowed tool call aborts the whole turn but the paid response is still charged | Low | High, **observed** (P7) | `fallback.ts:122-125` | Charged $0.01 and the user gets an error instead of the answer. Safe, but a prompt-injected or confused fallback model can repeatedly burn budget; rounds already executed are kept. Consider dropping the offending call or returning a refusal to the model once. |
| N4 | Overruns are recorded, not prevented; cap can be exceeded by one call of any size | Medium (guarantee), theoretical likelihood | High (mechanism, observed P4); provider behavior unverified | `openrouter.ts:152,199`, `spend-ledger.ts:177-189` | Same mechanism as F4, kept separate for the activation gate: the **only** hard cap available is a credit limit on the OpenRouter key, set and funded outside ORBIT. |
| N5 | Ledger is not anchored: deleting or losing the file resets spend to $0 | Low-medium (operational), theoretical | High, **observed** | `spend-ledger.ts:99-107` (the vanished-file protection applies only inside one process) | After a restart with the ledger file removed (state directory wiped, restore from older backup, `StateDirectory` change) lifetime spend read $0 after $1 had been recorded. The lifetime $150 cap then restarts. Backstop: key-side credit limit; plus a startup note when a ledger is created while the key balance shows prior usage. |
| N6 | `balance()` JSON failure leaks a response snippet unsanitized | Low | High, **observed** (P9) | `openrouter.ts:217`, `fallback.ts:183` | A non-JSON body raises a raw `SyntaxError` whose message includes the first ~10 characters of the body; `maintain` stores `err.message` unsanitized into the status text. Unlikely to contain a key; fix by wrapping in `fail()`/`sanitize`. |
| N7 | Status says "armed" while the ledger is failed closed | Low | High, code-evidenced | `fallback.ts:210-225,164-167` | A corrupt ledger shows "Spend ledger problem: …" appended to an "armed" sentence and the port stays `degraded`/non-down, although every paid call will be refused. |
| N8 | Reservation size vs model price can make the fallback unusable | Low (model-choice gate) | High, observed arithmetic (P8) | `openrouter.ts:152` | Worst case reservation at 300 KB request: $0.021 at $0.07/$0.17 per M tokens; $0.93 at $3/$15; $5.12 at $15/$75 with 8192 output (exceeds the $5 daily cap, so every large request is refused). Cheap models are fine; the exact price chosen by Rai determines how long a thread can get before the fallback refuses ("calls per day at worst case": 234, 5, 0). |
| N9 | Truncated or partly malformed replies are returned as complete | Low | High, code-evidenced | `openrouter.ts:203-211` | `finish_reason: "length"` with text is returned without a "cut off" marker; tool calls missing `id` or name are silently dropped (the rest run). Not a safety issue; a provenance/quality one. |
| N10 | A weaker model can author `job_launch` proposals from untrusted tool text | Low, theoretical | Medium | `fallback.ts:37`, `chat-tools.ts:256` | Confirmation is preserved, so impact is limited to Rai being asked. The pending card does not say the brief was written by the fallback model; a runner has push access, so this is the sharpest allowed tool. Requires Rai's tool-scope approval (already a gate). |

Not found: any path where a fallback response runs a tool outside the allowlist, any way to call the primary during an active limit, any secret in the log/status/error output produced by the paths tested.

## 5. Does the design support a hard spend guarantee?

**No, not by itself.** The local ledger gives these guarantees, given one writer, correct prices and a provider that honors `max_tokens` and `provider.max_price` (unverified): it never *sends* a request whose computed worst case would cross the caps, it fails closed on corruption, and unknown outcomes stay charged. It cannot bound a component outside the bound (F4/N4), a provider that ignores the parameters, an out-of-band use of the key, a reset ledger (N5) or concurrent writers (F5). The only enforceable cap is a credit limit on the OpenRouter key (and funding the account minimally). Do not describe the guard as a hard cap until the key limit exists and was verified.

## 6. Activation gates (all must be true before any paid use)

1. F1, F2 fixed (N2, N1 fixed or the auxiliary callers explicitly excluded from the fallback).
2. The OpenRouter key has a credit limit at or below the approved total ($150, ideally also a daily/periodic limit if offered) and the account funded only with an amount Rai accepts losing; verified in the dashboard.
3. Rai has confirmed from OpenRouter's own page/API (not reachable from this environment): exact model id (pinned, dated), `tools` in `supported_parameters`, prompt/completion prices, that `max_price` and `usage.cost` behave as assumed, and has set the prices in `orbit.env`.
4. Rai has approved the tool scope (including `job_launch`) and the data flow (conversation, memory, tool results, thread compaction input leave the host).
5. A rehearsal against a fake provider on the real host layout shows `/status` "armed", a forced limit served and labelled, and rollback (`ORBIT_OPENROUTER_ENABLED=0`) works.
6. Single-writer ownership of the state directory is documented in the runbook (no second ORBIT process).

## 7. Backlog

### Fix now (small, no live provider needed)

**B1. Return the primary's own `Result` untouched when the primary answers** (original F1) - Priority P1. Files: `src/fallback.ts:191-208`, test in `test/openrouter-fallback.test.ts`. Rationale: provenance must stay honest. Acceptance: with a mock primary, `reply()` returns `provenance: "mock"` and `source: model/mock-echo`, identical to the unwrapped model; with a live primary the primary's value, provenance and source pass through; only the fallback path adds `fallback`. Test: mock-primary wrapper test. Sources: review comment 6810921584 item 1; probe P1.

**B2. Bound cap settings and never let ledger construction crash boot** (F2) - P1. Files: `src/openrouter.ts:67-69`, `src/main.ts:60-66`, `src/spend-ledger.ts:69`. Acceptance: caps above a documented maximum (suggest 10,000 USD) give state `unavailable` with a reason; `spendLedger()` errors in `main.ts` are caught so ORBIT starts with the fallback unavailable; the ledger error message distinguishes "too large" from "not positive"; tests: `1e10`/`1e11` and `9.1e9` → unavailable and boot-time construction does not throw. Source: review item 2; boot check above.

**B3. Make the fallback's labelling consistent** (N2) - P2. Files: `src/fallback.ts:205-206`. Acceptance: `reply()` fallback `source` equals `replySource(...)` output; test asserts the "(FALLBACK, paid" text on the non-tool path and in a persisted thread message.

**B4. Guard ledger calls on error paths** (F6b) - P2. Files: `src/openrouter.ts:165,174,192-193,199`, `src/spend-ledger.ts`. Acceptance: if `settle`/`release` throws, the original timeout/HTTP error is still reported together with a "spend accounting failed" note, a billed answer is not silently discarded when settle fails (either returned with a warning or the reservation is retained and reported), and an unsettled in-process reservation is not left outstanding indefinitely. Tests: disk-failure simulation (directory at `openrouter-spend.json.new`, as in P6b).

### Before paid activation

**B5. Decide how background callers use the fallback** (N1) - P1 gate. Files: `src/thread-context.ts:167`, `src/recent-context.ts:183`, `src/runs.ts:64`, `src/fallback.ts`. Options: do not use the fallback for them (a `reply` option such as `noFallback`), or label and record provenance in their outputs. Acceptance: with the primary limited, compaction, rolling-note and scheduled-run calls either fail/skip without spending or store the fallback provenance; a test with a limited fake primary asserts zero OpenRouter requests (or labelled output) for each caller.

**B6. Key-side credit limit and prices verified; document the exact unbounded components** (F4, N4, N5) - P1 gate. Files: `docs/openrouter-fallback.md`, activation checklist. Acceptance: the doc lists what the pre-call bound does not cover and says the key limit is mandatory; the checklist records the verified model id, prices, `supported_parameters`, `max_price`/`usage.cost` semantics with URLs and date; the key limit value is noted. Not testable in code. Source: sections 2 and 5 above.

**B7. Single-writer protection for the ledger** (F5) - P2. Files: `src/spend-ledger.ts:118-134`. Acceptance: an exclusive lock file or a per-process temp name, so a second process cannot corrupt the ledger; a second writer is refused at start with a clear error; test with two child processes (as the probe in section 2). A reserve/settle in a stale process must not lose a billed answer.

**B8. Ledger anchoring** (N5) - P3. Files: `src/spend-ledger.ts:99-107`, `src/fallback.ts`. Acceptance: when a ledger is created fresh and the key balance (`/key`) shows prior usage, status shows a warning and paid calls need an explicit operator acknowledgment (or are refused), test with a fake balance.

**B9. Decide the disallowed-tool behavior and `job_launch` card text** (N3, N10) - P3. Files: `src/fallback.ts:122-125`, `src/agent.ts`, thread card rendering. Acceptance: a disallowed call produces a refusal result to the model (or an explicit decision to abort), cost is still recorded; a pending `job_launch` card created in a fallback turn shows that it was written by the fallback model.

**B10. Model-price rehearsal** (N8) - P3. Acceptance: with the chosen prices, the runbook records the worst-case reservation and calls/day figures (formula in `openrouter.ts:152`); max request size is lowered if a single worst case exceeds 20% of the daily cap.

### Later

**B11. Streamed, byte-counted response reading** (F3) - P3. Files: `src/openrouter.ts:125-129,217`. Acceptance: reading stops at `MAX_RESPONSE_BYTES` bytes (test with a streamed fake body that stops pulling early); the limit counts bytes.

**B12. Status without side effects** (F6a, N7) - P3. Files: `src/fallback.ts:160-168,210-225`, `src/spend-ledger.ts`. Acceptance: `status()` never creates the state dir or ledger file and reads a cached snapshot; "armed" is not shown when the ledger is failing; `uncertain` is capped or archived.

**B13. Sanitize `balance()` errors** (N6) - P3. Files: `src/openrouter.ts:214-220`, `src/fallback.ts:183`. Acceptance: a non-JSON 200 yields `OpenRouter: balance lookup returned an unreadable body` with no body text.

**B14. Mark truncated or partly malformed replies** (N9) - P3. Files: `src/openrouter.ts:203-211`. Acceptance: a `finish_reason: "length"` text reply gets a visible "cut off" note; dropped malformed tool calls are reported.

### No action

- Fallback trigger scope, tool allowlist (default-deny, both directions), no-replay behavior, primary pause/recovery, UTC rollover, in-process concurrency, fail-closed ledger corruption handling: examined, sound (section 3).
- Review item 5's "not a cap bypass": agreed for overlap and concurrent writes (they refuse or corrupt, they do not undercount); real exposure is N5 and F4/N4.
- Lack of a provider-enforced hard cap in the local ledger is an **accepted design limit**, documented; fixed only by the key credit limit (B6).

## 8. Limitations

- OpenRouter documentation and API unreachable (DNS): request fields (`provider.max_price`, `usage.include`, `data_collection`, `allow_fallbacks`), the billing of 4xx/5xx errors, the `/key` response shape and any key credit-limit options are **assumptions**, not verified.
- No real provider was called; every response was a fake. Behavior under real streaming, real latency, real `usage.cost` and real provider routing is unobserved.
- gitleaks was not run (refused by the sandbox); only a manual grep of this document.
- N1, N7, N9, N10 are code-evidenced, not executed; the other new findings were reproduced.
- Multi-process tests used two local Node processes on a temp directory (not systemd). Host behavior during a real deploy overlap was inferred from `deploy/pull-deploy.sh` and `orbit.service`, not exercised.
- Not audited: the page JavaScript rendering of the fallback badge beyond the persisted `fallback` field, other test files unrelated to the fallback, ChatGPT-side error classification accuracy (`chatgpt.ts` regexes at `:222-223`).
