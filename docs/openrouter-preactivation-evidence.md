# OpenRouter fallback: pre-activation evidence matrix and operator checklist

Status (job orbit-202611130045-6b3m, base main `7f5e5ad` = PR #68 merged): **NOT activated, NOT production verified, NOT a security review.** All new work is tested offline only (fakes, temporary directories). Public OpenRouter metadata was re-read (unauthenticated) at 2026-11-13 00:47 UTC. The operator procedure is now **`docs/openrouter-activation-runbook.md`** (exact settings, credential, provisioning, prerequisite checks, smoke test, enablement, stop conditions, rollback).

**Verdict: the remaining engineering blocker (G2) is fixed in code; what is left is owner decisions and live-only operations.** No code change is needed for the other gates before Rai decides.

## G1-G9 disposition (this job)
| Gate | Disposition | Evidence / what is left |
| --- | --- | --- |
| G1 model and prices | **Owner decision** (+ live re-check on the day) | Metadata re-read 00:47 UTC: `deepseek/deepseek-v4-flash` unchanged (13 endpoints, prompt 0.05-0.21, completion 0.1652-0.56 USD/M, cache read <= prompt, no fees or windows, `reasoning.mandatory` false, efforts `xhigh,high,none`, every endpoint lists `max_tokens`, `temperature`, `reasoning`, `tools`, `tool_choice`). Price check with the new output bound: OK, 13/13 admitted, smallest output bound 1,048,576, reservation for the largest request $0.704162. Recommended: 0.25 / 0.60 USD/M, output bound 1,048,576. Rai confirms; runbook section 2 re-runs the check. |
| G2 reasoning vs max_tokens | **Code fix done** (this job) | The reservation no longer trusts `max_tokens` for the output side: it reserves `ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS` (required, no default, >= max_tokens; set to the largest admitted `context_length`/`max_completion_tokens`, checked by the price tool). Requests also send `reasoning: {effort: "none"}` and `provider.require_parameters: true` (only endpoints that support `max_tokens` and `reasoning` are routed to), and no longer send the deprecated `usage.include`. Tests: `test/openrouter-output-bound.test.ts` (8). Remaining assumption, stated: one call's billable output does not exceed the model's context length, and OpenRouter applies `max_price`. Not verified live; the smoke test records `completion_tokens` vs `max_tokens`. |
| G3 key-side limit | **Live-only (owner)** | Dashboard: smoke key $1, production key <= $150 lifetime (runbook section 3). The only hard ceiling. |
| G4 B8 continuity | **Owner decision** | Unchanged: no provider cross-check built. Smallest acceptable option: rely on the key's lifetime limit <= $150 as the continuity bound after total local state loss. |
| G5 B9 disallowed tool call | **Owner decision** | Unchanged: the turn fails and the call is charged. Each such call is now bounded by its reservation and all of them by the caps. |
| G6 host rehearsal | **Live-only** | Runbook section 5 and operator checklist step 6 below. |
| G7 paid smoke test | **Prepared, not run; needs authorisation** | `tools/openrouter-smoke/smoke.ts` (tested offline, `test/openrouter-smoke.test.ts`, 4): <= 3 requests, $1 key limit, $1 local caps, `max_tokens` 256, synthetic prompt, tool call checked but never run, isolated temporary ledger; exact command, pass criteria, dashboard comparison and stop list in runbook section 6. |
| G8 independent review | **ORBIT** | This branch needs a normal independent review; the activation checklist's two security reviews are still not done. |
| G9 deployment / rollback | **Live-only** | Runbook sections 7 and 9: hand edit of `orbit.env` (the chat config tool cannot set these keys), restart, `/status` checks, disable with accounting preserved. |

Also fixed from the PR #68 review (comment 6840060827): finding 1 (the price check now counts fee and price-shape blockers only for endpoints that `max_price` and `require_parameters` could actually route to; test), finding 2 (stale `{}` comment), finding 3 (the stale-file sweep continues past a file that vanished; test fails before, passes after), finding 5 (`prefix.slice(0)`). Finding 4 was a note, no change asked.

**Consequences of the conservative bound (accepted by design, Rai to note):** about $0.63-0.70 of allowance is held per call in flight; an unknown-cost call (timeout, 5xx, no cost) is charged that much locally, so about seven of them exhaust a $5 day; the last ~$0.70 of each day is not usable. The ledger and caps are ORBIT's own count, not a provider ceiling.

---

Earlier status (job orbit-202611130016-r416, kept for the record; superseded where the table above says so):

Status (job orbit-202611130016-r416, continuing blocked job orbit-202611122129-f6ax; base main `f426b7d`, prior head `b03261a` carried forward unchanged): **NOT activated, NOT production verified, NOT a security review, NOT ready for activation.** The ledger and fallback work is tested offline only (fakes, temporary directories, real child processes). Public OpenRouter metadata is now **read and recorded** (below), but it is evidence about one moment, not a guarantee, and it does not close the gates that need the real host, a real key or an independent review.

**Verdict:** *not* "ready for owner activation decision". What changed since f6ax: `openrouter.ai` is reachable from the job environment (HTTP 200, no proxy block), so the model and pricing metadata gate moved from BLOCKED to "evidence recorded, owner choice pending", and an offline price check (`tools/openrouter-price-check`) now tests the reservation bound against that metadata. Still open, each with exact evidence needed in "Open gates" below: owner model/price choice, reasoning-token and time-window semantics that the docs leave open, key-side limit, B8 continuity, B9, host rehearsal, separately approved paid smoke test, and an independent review of the final head.

## Evidence matrix
Legend: **T** implemented and tested offline (test file); **D** remaining defect/limit; **O** owner decision; **L** live-only verification.

| Gate | T: implemented / tested (fakes) | D: remaining limit | O / L |
| --- | --- | --- | --- |
| Caps $5/day (UTC), $150 total, unchanged | T `openrouter-fallback` "daily cap", "total cap", config defaults; `spend-ledger-multiprocess` 6 processes admit exactly the allowance | Local count, not a hard ceiling; one reported cost above the bound is recorded in full | L key-side credit limit <= $150 set in dashboard (O) |
| Durable reserve / settle, concurrency, crash, restart | T `spend-ledger-multiprocess` (SIGKILL at 5 points, orphan adoption), `openrouter-fallback` "restart durability", "concurrency" | Filesystem assumptions (local, honours link/rename/fsync) untested on the host | L rehearsal on real host layout |
| Uncertain billed outcome fails closed | T `openrouter-pr64-followups` (latch on every unrecorded outcome), `openrouter-fallback` "ambiguous or missing costs" | Cleared only by restart (by design) | O in-process clear route: not built |
| Tool-call-only accounting warning visible, structured | T `openrouter-fallback` "billed tool-call-only reply...", "accounting diagnostics ... never fed back"; `/chat` and thread tests | | |
| Background reply AND step calls cannot silently spend | T `openrouter-fallback` "reply: background callers", "step(): tool-using turns never spend unless opted in", "runChat: no paid fallback by default" (zero provider requests counted) | Any new caller must opt in explicitly (default is no spend) | |
| Fallback only on intended primary limits; recovery; provenance | T "only usage and rate limits fall back", "real reset", "no reset time given", "provenance", "persisted replies" | Reset/limit wording comes from the provider's own error | L forced-limit smoke on the real host |
| Missing credentials/config stay disabled | T "config: disabled by default; every missing or bad setting makes the fallback unavailable", "missing key" | | |
| Malformed / partial / tool-call responses cannot run tools improperly | T `openrouter-hardening` B14 and PR64 finding 3 (tool call only after stop/tool_calls/function_call), allowlist tests, bounded reads B11 | A disallowed tool call fails the turn and is still charged (B9, open) | |
| Timeouts / cancellation and accounting | T "timeouts are bounded ... charged at its bound", B11 stalled body, PR64 finding 4 | No caller-side cancel: only the deadline cancels an in-flight call (reservation then stays charged) | |
| Balance diagnostics leak nothing / imply nothing | T "the fallback's own spend never leaks a secret", "balance ... labeled as the account side", STALE flag, non-JSON body | `/key` field semantics unverified against live API | L |
| **PR65-1** crash after break guard created | T `spend-ledger-multiprocess` (recovers on proven-dead guard owner; unprovable/live guard never touched; unsafe token never broken; 5-way race x8; stale temp sweep). Before/after below | Unprovable owners (other host/namespace/no /proc) need the manual step | O accept manual recovery as a gate |
| **PR65-2** /proc, host, boot id, pidns identity | T simulated: other host, no boot id, live pid, garbled, reboot, dead pid, reused pid (`spend-ledger-multiprocess`). Fail-closed behaviour documented in `openrouter-ledger-integrity.md` | Real pidns change and `hidepid` not simulated | L rehearsal below |
| **PR65-3** `Atomics.wait` blocks the loop | T `spend-ledger-pr65-followups`: lock wait 3000 -> 250 ms; real holder process; `inspect()` never waits | Rare bounded ~250 ms stall per refused admission remains | O accept, or async ledger |
| **PR65-4** `inspect()` "unprovisioned" after both files vanish | T `spend-ledger-pr65-followups`: reports loss; admission and status agree; fresh install still "unprovisioned" | A *restarted* process cannot know | |
| **PR65-5** total state loss resets budget | T provisioning now requires stated opening spend, `{}` refused, recovery needs acknowledgement; `spend-ledger-pr65-followups`, provisioning tests | Local ledger cannot establish provider lifetime spend after total state loss (trust boundary, documented) | O B8 continuity design (provider cross-check / key limit) |
| **B6/B10** model metadata and price bound (new in r416) | T `openrouter-price-check` (6 tests, synthetic fixtures): admitted/excluded endpoints, time and long-context windows, extra fees, unknown keys and conditions, bound formula equals the client's, CLI exit codes. Run against the real saved metadata: see "Price check results" | Metadata is a snapshot; providers and prices change. max_price vs time windows and reasoning vs max_tokens are not fully specified by the docs (see "Reservation bound") | O choose model and prices; L re-fetch and re-run the check on activation day |

**Before/after (same new tests, `src/spend-ledger.ts` at `f426b7d`):** `spend-ledger-pr65-followups` 3 of 4 fail before (lock wait blocked about 3 s; loss reported unprovisioned; `{}` provisioned an empty history; the 4th is the unchanged fresh-install control), 4 of 4 pass after. The guard recovery tests in `spend-ledger-multiprocess` (5 new/rewritten): 4 fail before (stuck guard never recovers, the sweep, and the unsafe-token and guard-owner cases, which assert the new scoped-guard behaviour), 1 (race) passes before and after. Old behaviour of the stuck guard: every call `busy` forever. After: full suite 884 of 884, `tsc` clean.

The before/after counts above are from job f6ax and were not re-run against `f426b7d` in this job. What this job re-ran on `b03261a` before any change: `pnpm typecheck` clean, `pnpm test` 884 of 884; targeted `spend-ledger-pr65-followups`, `spend-ledger-multiprocess`, `spend-ledger-provisioning`, `openrouter-pr64-followups` 34 of 34; `openrouter-fallback` and `openrouter-hardening` 69 of 69. Final-head numbers are in the job summary.

### Preserved fixes from f6ax, checked in code and tests (offline only)
- Stale break-guard recovery only on proof that the guard owner is dead; a live or unprovable owner fails closed (`busy`), no lock or guard of such an owner is removed (tests: "a process killed while breaking a dead lock...", "a break guard whose owner is not provably dead is never removed...", "a lock token that is not file-name safe is never broken...", "two live breakers racing...").
- Lock wait 250 ms (`src/spend-ledger.ts`, `lockWaitMs ?? 250`); `inspect()` never waits. **Still a synchronous stall of up to 250 ms per contended admission** (stays an explicit owner decision; the alternative is an async ledger).
- Loss of ledger and marker after use is reported as loss by status and admission alike; a restarted process cannot know (stays explicit).
- Provisioning needs a stated opening spend (`{}` refused); recovery needs an acknowledgement. **Local state loss cannot establish lifetime provider spend** (trust boundary unchanged).
- Identity limits unchanged: other host, missing boot id, other pid namespace and `hidepid` are treated as unprovable (fail closed, manual step); real pid-namespace change and `hidepid` were not simulated.

## External inputs (public metadata): RETRIEVED 2026-11-13, unauthenticated, read-only
No key, no authenticated endpoint, no balance call, no inference. Responses are treated as untrusted data. Nothing was bypassed: the session's network policy now allows `openrouter.ai`. Historical balances (for example the $17.41 Rai mentioned on 2026-11-11) are not current evidence and were not checked.

| Retrieved (UTC) | URL | Result |
| --- | --- | --- |
| 00:17:11 | https://openrouter.ai/api/v1/models | HTTP 200, no redirect, 856,457 bytes, 475 models, Cloudflare cache HIT age 73 s, sha256 `615ba88e...39add` |
| 00:17:26 | https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints | HTTP 200, no redirect, 13 endpoints, sha256 `93313114...6dcb` |
| 00:17:26 | .../deepseek/deepseek-v4-flash-0731/endpoints | HTTP 200, 27 endpoints, sha256 `a6fae81b...3865` |
| 00:17:26 | .../deepseek/deepseek-v4.1-flash/endpoints | HTTP 200, 38 endpoints, sha256 `aec57319...1f9b` |
| 00:17:26 | .../deepseek/deepseek-v4.1-flash-1017/endpoints | HTTP 200, 48 endpoints, sha256 `97edc729...714a` |
| 00:17:45 | https://openrouter.ai/docs/features/provider-routing | HTTP 200 after 1 redirect to /docs/guides/routing/provider-selection |
| 00:18:00-01 | https://openrouter.ai/docs/guides/routing/provider-selection.md, .../guides/best-practices/reasoning-tokens.md, .../guides/overview/models.md, .../guides/features/tool-calling.md | HTTP 200 each, no redirect |
| 00:22:10 | https://openrouter.ai/docs/cookbook/administration/usage-accounting.md, .../guides/best-practices/capping-shared-agent-keys.md | HTTP 200 each |
| 00:17:47 | https://openrouter.ai/docs/api-reference/list-endpoints-for-a-model | HTTP 404 (guessed path; not used) |
| 00:47:01 (job 6b3m) | .../api/v1/models/deepseek/deepseek-v4-flash/endpoints; .../api/v1/models | HTTP 200 each; 14,342 bytes, 13 endpoints, sha256 `1c971ce2...f6090c7`; 856,458 bytes, sha256 `962b2862...ce9dd5` |
| 00:47 (job 6b3m) | .../docs/guides/best-practices/reasoning-tokens.md, .../docs/guides/routing/provider-selection.md, .../docs/guides/features/tool-calling.md, .../docs/cookbook/administration/usage-accounting.md | HTTP 200 each. Quoted: reasoning tokens count against `max_tokens` "On most providers"; `effort: "none"` "Disables reasoning entirely"; `require_parameters`: "Only use providers that support all parameters in your request" (without it, providers "will ignore unknown parameters"); `usage: {include: true}` "deprecated and have no effect". `/docs/api/reference/parameters.md` returned 307 (not followed) |

The raw files are not committed (size, and they are third-party data); re-fetch them with the same URLs. Prices in the API are USD **per token** (`docs/guides/overview/models.md`, "Pricing Object"); below they are converted to USD per million tokens (x 1e6).

### Official semantics that matter for the bound (quoted facts, docs retrieved above)
- `provider.max_price` `{"prompt": 1, "completion": 2}` "will route to any provider with a price of <= $1/m prompt tokens, and <= $2/m completion tokens"; unlike latency preferences it "will prevent your request from running if the price is not available" (provider-selection.md). **So ORBIT's units are right**: it sends its configured USD-per-million prices as `max_price`.
- `allow_fallbacks` default `true`; ORBIT sends `false`. `data_collection: "deny"` restricts to providers that do not store data. The public endpoints data does **not** say which endpoints pass `data_collection: "deny"`, so the admitted set below may be smaller in practice (that can only refuse calls, not raise cost).
- `require_parameters` default `false`; `tools` is a soft preference (requests go to tool-supporting providers when some support it). All 13 v4-flash endpoints list `tools`; one (`atlas-cloud/fp4`) lists `tool_choice: auto` as unsupported. ORBIT sends `tool_choice: "auto"` (the default behaviour), so this is noted, not a blocker.
- Reasoning tokens "are considered output tokens and charged accordingly. **On most providers** they also count against the request's" output limit; on Chat Completions that budget is `max_tokens`; if reasoning uses it all the reply ends `finish_reason: "length"` with empty content and the reasoning is still billed (reasoning-tokens.md). "Most" is not "all": see "Reservation bound".
- The models `pricing` object is "Pricing from the top provider", not a maximum over providers; it can carry `request`, `image`, `web_search`, `internal_reasoning`, `input_cache_read`, `input_cache_write` and `overrides` (time windows `utc_start`/`utc_end`/`utc_days`, long-context `min_prompt_tokens`). The docs do **not** say whether `max_price` is compared with the base price or the window price in force.
- `usage` is always returned on Chat Completions; `usage: {include: true}` (which ORBIT sends) "is deprecated and has no effect" (usage-accounting.md). `usage.cost` is the cost in credits; `is_byok` and `cost_details.upstream_inference_cost` exist. ORBIT settles from `usage.cost` and keeps the bound when it is absent.
- Key credit limit (`limit`, optional `limit_reset` daily/weekly/monthly, unset = lifetime): "When the key's combined spend reaches `limit`, requests on that key fail with `403 Forbidden`" (capping-shared-agent-keys.md). A workspace budget can combine daily and lifetime limits. Neither is described as pre-reserving a request, so the call that crosses the limit can still overshoot it (inference from the wording, not verified).

### Candidate (recommendation only; Rai confirms; nothing selected or enabled)
Rai asked for "a simple model like DeepSeek flash". DeepSeek flash ids in `/api/v1/models` at retrieval (all list `tools` and `tool_choice`): `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-0731`, `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4.1-flash-1017`, plus `:batch` variants and `~deepseek/...-latest` aliases (moving targets; ORBIT's id check rejects the `~` form anyway).

**Recommended: `deepseek/deepseek-v4-flash`** (name "DeepSeek: DeepSeek V4 Flash 0423", `canonical_slug` `deepseek/deepseek-v4-flash-20260423`, text in / text out). Why this one: it has the narrowest provider price spread, **no time-of-day overrides on any endpoint** (so the undocumented max_price/window question does not arise), and no fees beyond prompt, completion and cached input.

| Field | Value (source: /api/v1/models and /endpoints, 2026-11-13 00:17 UTC) |
| --- | --- |
| Tool support | `supported_parameters` includes `tools` and `tool_choice`; all 13 endpoints list `tools` |
| Context | `context_length` 1,048,576 (endpoints 1,000,000 to 1,048,576) |
| Output limit | `top_provider.max_completion_tokens` 393,216; endpoints 131,072 to 943,718. ORBIT's `max_tokens` default 2,048 (hard max 8,192) is far below all of them |
| Headline price (top provider only) | prompt 0.09, completion 0.18, cached input 0.018 USD per million tokens |
| Range over the 13 endpoints | prompt 0.05 to 0.21; completion 0.1652 to 0.56; cached input at most 0.075 (always <= that endpoint's prompt price) |
| Other fees | none non-zero (`request`, `internal_reasoning`, `web_search`, `input_cache_write` absent or 0); some endpoints list a `discount`, which only lowers price |
| Reasoning | optional (`reasoning.mandatory` not set; supported efforts `xhigh`, `high`, `none`; default effort `high`). ORBIT sends no `reasoning` field, so the model's default applies and reasoning tokens are billed as output |
| Data caveat | which endpoints pass `data_collection: "deny"` is not in the public data |

Alternatives, not recommended now: `deepseek/deepseek-v4-flash-0731` (endpoint completion up to 1.32 per M incl. time windows; two Alibaba endpoints have peak/off-peak windows); `deepseek/deepseek-v4.1-flash` (completion up to 12.0 per M on one endpoint, `venice/ultrafast`); `deepseek/deepseek-v4.1-flash-1017` (the `deepseek` endpoint doubles price on weekday windows: 0.15/0.6 -> 0.3/1.2). Whether the plain id `deepseek/deepseek-v4-flash` can later be re-pointed to a newer snapshot is not stated anywhere I read: re-check its `canonical_slug` on activation day.

### Reservation bound (src/openrouter.ts) checked against this metadata
**Superseded by job 6b3m:** the output side is now `ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS`, not `max_tokens`, so (d) and (e) below no longer limit the bound; see the G2 row above. Original text: per call ORBIT reserved `(request bytes + 64) x priceIn + max_tokens x priceOut` at the **configured** prices and sends those prices as `max_price`. Conditions from the f6ax doc, now with evidence:
- (a) configured prices >= every endpoint max_price admits: **holds by construction for the base price** (max_price filters it). For time windows the docs are silent, so the price check treats any endpoint whose base is admitted but a window is not as a **blocker**; v4-flash has no windows, so this does not arise for it.
- (b) tokens in <= request bytes + 64: unchanged reasoning (no tokenizer emits more than one token per byte of text; chat-template tokens are covered by the JSON overhead per message plus 64). Not verified against DeepSeek's tokenizer; the provider-reported cost is what is charged in the end.
- (c) no fee outside prompt/completion: **holds for v4-flash today** (checked per endpoint by the tool).
- (d) `max_tokens` within the output limit: holds (2,048 vs >= 131,072).
- (e) reasoning inside `max_tokens`: the docs say "on most providers". **Open.** If a provider did not count reasoning against `max_tokens`, one call could exceed its reservation. Worst case for one call under max_price with the suggested prices (0.25 in / 0.60 out, largest request 300,064 tokens in, highest admitted endpoint output limit 943,718): **about $0.64**; the normal reservation for that largest request is **about $0.076**. The overshoot is recorded in full and flagged (existing test "a provider cost above the reserved bound is recorded in full and flagged"), and later calls are refused at the caps, but the $5 day can be exceeded by up to one such call. Mitigations for Rai to choose (not implemented, no live evidence they work): send `reasoning: {effort: "none"}` (v4-flash lists `none`), or accept the one-call overshoot behind a key/workspace limit.

### Price check results
Job 6b3m, metadata of 00:47 UTC (`endpoints.json` sha256 `1c971ce2...f6090c7`), new tool (`--output-bound` required, `require_parameters` applied): `node tools/openrouter-price-check/check.ts endpoints.json --in 0.25 --out 0.6 --output-bound 1048576` -> exit 0, OK, 13 / 13 admitted, smallest output bound 1,048,576, reservation for the largest request $0.704162. With `--output-bound 2048`: exit 1, BLOCKED ("output bound 2048 is below 1048576").

Earlier table (job r416, old tool: output side `max_tokens` 2048):
| Model | Prices (USD/M in / out) | Result | Admitted / total | Reservation, largest request | One call if reasoning uncapped |
| --- | --- | --- | --- | --- | --- |
| deepseek/deepseek-v4-flash | 0.25 / 0.60 (suggested: >= every endpoint, rounded up) | OK | 13 / 13 | $0.076245 | $0.641247 |
| deepseek/deepseek-v4-flash | 0.15 / 0.50 | OK | 12 / 13 | $0.046034 | $0.516869 |
| deepseek/deepseek-v4-flash-0731 | 0.15 / 0.60 | OK | 17 / 27 | $0.046238 | $0.61124 |
| deepseek/deepseek-v4.1-flash-1017 | 0.30 / 1.20 | OK | 46 / 48 | $0.092477 | $1.222481 |
| deepseek/deepseek-v4.1-flash-1017 | 0.15 / 0.60 | BLOCKED: `deepseek` endpoint base within, weekday window 0.3/1.2 not | | | |

Typical turns are far below the largest-request figures: a 20 KB request at 0.25/0.60 reserves about $0.0063. These are offline computations on a snapshot, not a rehearsal against the API.

## B6, B8, B9 and cancellation (clarified from existing docs; no decision taken here)
- **B6 key-side limit (owner).** The only hard cap is outside ORBIT. From the docs above: a key credit limit is either lifetime (no `limit_reset`) or rolling; a workspace budget can hold daily and lifetime limits together. Suggested minimum: key lifetime limit <= $150 (much lower for the smoke test). Overshoot by the crossing call is possible (inference). The local ledger records a reported cost of any size in full and refuses later calls; it is not a hard ceiling.
- **B8 continuity (owner).** Unchanged: options in `docs/openrouter-ledger-integrity.md` ("Decision for Rai"). Only the key-side limit and a provider-side cross-check (not built; `/api/v1/key` fields still unverified because that endpoint needs a key) bound loss after total local state loss.
- **B9 disallowed tool call (owner).** Unchanged and open: a fallback reply that calls a tool outside `FALLBACK_TOOLS` fails the whole turn, and the paid call **is still charged** (its cost is recorded). The audit's options: return a refusal result to the model once, or keep the abort. Repeated injected calls can burn budget up to the caps.
- **Cancellation.** There is no caller-side cancel: only ORBIT's deadline (`ORBIT_OPENROUTER_TIMEOUT_MS`, default 60 s) aborts an in-flight call; a timed-out or abandoned call stays charged at its bound. Closing the page does not stop a paid call.

## Open gates (each needs the named evidence; none is closed by tests)
| Gate | Evidence needed | Who / where |
| --- | --- | --- |
| G1 model and prices | Rai confirms the model id and the two prices; re-fetch `/models` and `/endpoints` on activation day and re-run the price check with exit 0 | Rai; any session that can reach openrouter.ai |
| G2 reasoning vs max_tokens | **Done in job 6b3m** (output-bound reservation, reasoning off, require_parameters); the smoke test still records `usage.completion_tokens <= max_tokens` | done (code); live evidence in G7 |
| G3 key-side limit | Key (or workspace) limit <= $150 visible in the dashboard; lower for the smoke test | Rai, dashboard |
| G4 B8 continuity | Decision recorded (key limit only, or cross-check built) | Rai |
| G5 B9 | Decision recorded | Rai |
| G6 host rehearsal | Operator checklist step 6 run on the real host, outputs recorded | Rai at the host |
| G7 paid smoke test | Separate explicit approval with a stated budget; results compared with the dashboard | Rai |
| G8 independent review | ORBIT review job on this branch's final head; two independent security reviews per the activation checklist | ORBIT |
| G9 deployment / rollback drill | Rai's normal process; `/status` "armed" with the right model; rollback restores the untouched primary | Rai |

## Operator checklist (document only; none of it was run)
**Superseded by `docs/openrouter-activation-runbook.md`** (job 6b3m), which adds the required `ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS`, the dynamic-user ownership of the provision file, the prepared smoke tool and exact commands. Kept for the rehearsal detail in step 6. Everything below is for Rai at the host, in order. Replace `<state>` with the orbit service's state directory.
1. **Decide** (G1, G2, G4, G5): model id (recommended `deepseek/deepseek-v4-flash`, after re-checking its metadata); prices at or above every endpoint you are willing to use (suggested 0.25 in / 0.60 out USD per M for v4-flash at today's data); the reasoning choice; the 250 ms lock wait; manual recovery for unprovable lock owners; B8 and B9.
2. **Dashboard** (G3): fund minimally; create a new key with a credit limit <= $150 (lifetime, no reset) and, if wanted, a workspace budget with a daily $5 limit; for the smoke test use a separate key with a limit of about $0.10. Note lifetime and today's usage (0 for a new key).
3. **Credential, outside chat:** as root, typed directly into the SSH session (not via `!`, not pasted to any agent): `install -m 0600` the key to `/etc/credstore/orbit.openrouter`. Agents never read it.
4. **Config** in `/opt/orbit/orbit.env`: `ORBIT_OPENROUTER_ENABLED=1`, `ORBIT_OPENROUTER_MODEL=<confirmed id>`, `ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK`, `ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK` (the checked prices), `ORBIT_OPENROUTER_DAILY_CAP_USD=5`, `ORBIT_OPENROUTER_TOTAL_CAP_USD=150` (superseded: Rai corrected the budget to 150 per month; use `ORBIT_OPENROUTER_MONTHLY_CAP_USD=150` with `ORBIT_OPENROUTER_TOTAL_CAP_USD=off` or an explicit higher lifetime value, `docs/openrouter-spend-caps.md`), optional `..._MAX_OUTPUT_TOKENS`, `..._TIMEOUT_MS`. Routing settings are fixed in code: `max_price` = the configured prices, `allow_fallbacks: false`, `data_collection: "deny"`.
5. **Provision the ledger explicitly** (service user): `printf '{"openingLifetimeUsd": 0, "openingTodayUsd": 0, "note": "new key, dashboard showed $0 on <date>"}' > <state>/openrouter-spend.provision`; restart ORBIT; `/status` must say "OpenRouter fallback armed" with the stated spend. After any loss or restored/replaced state directory: stop, read the dashboard, use the recovery procedure in `openrouter-ledger-integrity.md` with the dashboard's figures rounded up.
6. **Rehearse before any paid call** (G6; isolated, never the live ledger): (a) `node --test test/spend-ledger-multiprocess.test.ts` in a clone on the host. (b) a throwaway systemd unit with its own `StateDirectory` running `node test/helpers/ledger-worker.ts`; `systemctl kill -s KILL` mid-section, restart, confirm recovery; a pid-namespace-isolated unit fails closed with `busy` and the manual step clears it. Never point it at `/var/lib/orbit`. (c) Fake-provider smoke on the host layout: forced limit served and labelled, background call during a limit does not spend, cap refusal text.
7. **Separately approved bounded paid smoke test** (G7; needs Rai's explicit go and a stated budget, separate low-limit key): one short fallback turn after a forced ChatGPT limit. Check: reply labelled "FALLBACK, paid" with model and reset provenance; `/status` spend equals the dashboard within the reported `usage.cost`; `usage.completion_tokens <= max_tokens`; a background job during the limit does not spend; recovery to ChatGPT after the reset.
8. **Stop / rollback:** `ORBIT_OPENROUTER_ENABLED=0` and restart (primary untouched); remove `/etc/credstore/orbit.openrouter`; revoke the key in the dashboard. Keep `openrouter-spend.json` and `.marker`.
9. **Tooling gaps (not bypassed):** no scripted host rehearsal runner; no tool to clear lock/guard files (manual recovery needs a person); no independent-review trigger from inside a job.

## Content-filter observations
None encountered in this job.

## Review
Not independently reviewed. This job's checks (typecheck, tests, the price check) are self-checks, not a review and not production verification.
