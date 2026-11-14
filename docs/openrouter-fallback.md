# OpenRouter fallback

ChatGPT token sharing stays ORBIT's model. While ChatGPT reports a **usage limit or rate limit**, ORBIT can answer through OpenRouter instead, clearly labeled, with restricted tools and a spend guard. It is **off** until Rai configures it. Nothing in this change activates it.

## When it answers

- Only when the primary throws a typed `ProviderError` of kind `usage_limit` or `rate_limit` (including ORBIT's own pause refusal after one). Authentication failures, overload, incomplete responses and every other error are reported as they are, with no fallback.
- While the limit is in force ChatGPT is **not called**: the provider's reset time is used, or, when it gave none, ORBIT's existing estimated pause (`USAGE_PAUSE_MS`/`RATE_PAUSE_MS`), always shown as an estimate, never as a reset. The existing no-reset pause and overload retry in `src/chatgpt.ts` are unchanged.
- **Usage limit versus rate limit** (audit D2). Only the provider's structured `type`/`code` marks an exhausted quota (`usage_limit_reached`, `usage_not_included`, `insufficient_quota`, `quota_exceeded`, `plan_limit`; a quota tag wins over a rate-limit tag). Any other 429, or a `rate_limit`/`too_many_requests` tag, is a temporary rate limit, whatever its message says ("limit", "usage", "plan" no longer make it a usage limit), so with no valid timing ORBIT pauses for `RATE_PAUSE_MS` (1 min), not `USAGE_PAUSE_MS` (15 min). Timing precedence, first valid wins: body `resets_at`, body `resets_in_seconds`, then the HTTP `Retry-After` header (integer seconds or an IMF-fixdate). Past, zero, negative, malformed or beyond-`MAX_RESET_MS` values are skipped. ChatGPT is called again exactly at `until`, once; no background or extra retry is added.
- After the reset/pause time the next call goes to ChatGPT. Only a **successful ChatGPT call** counts as recovered; status says "not confirmed recovered" until then. If it is limited again, the fallback resumes.
- A model turn is atomic: the fallback is used only when the primary returned nothing, so no partial output is ever mixed or replayed. Mid-reply (after tool rounds) the fallback continues from the recorded tool results; tools are never re-run. Such a reply is marked as mixed.
- Missing key, disabled, or invalid config: the limit error is thrown as before, with "The OpenRouter fallback did not answer: <reason>" appended, and the port is reported `down` with that reason.

## Provenance

Every fallback reply has `source` = `model/openrouter/<model> (FALLBACK, paid: ChatGPT usage limit, resets <time> | ORBIT's estimated pause until <time>[; earlier rounds ... came from <primary>])`, and a structured `fallback` object (`provider`, `model`, `reason`, `primaryLimit`, `costUsd`) on the `/chat` reply and on the persisted thread message. The page prefixes such replies with "⚠ Fallback model, not ChatGPT". `/status` for the model port shows the limit, its reset or estimate, which model answers, the local allowance, and (if available) the OpenRouter key balance, labeled separately as account side.

## Permissions

Server-enforced in `src/fallback.ts` (`FALLBACK_TOOLS`), not by prompt: the fallback is offered only read-only tools (memory, repo/PR/jobs/ops reads, `orbit_config_view`, `vault_policy`) plus `job_launch`, which only creates a proposal. If the fallback model names any other tool, the step is discarded and nothing runs. Not allowed: `notify`, `job_steer`, vault writes, every `ops_propose_*`, `ops_sys_cancel_reboot`. Owner/policy checks and confirmation cards are untouched; the fallback sits below them. **Rai must approve this tool scope before activation.**

## Privacy

While the fallback answers, the conversation, memory excerpts, tool results and device summary are sent to OpenRouter and its provider. Requests set `provider.data_collection: "deny"`, `allow_fallbacks: false`, `require_parameters: true`, no plugins, no web search, no routing to other models. Rai must approve this data flow.

## Configuration (all in `orbit.env`, by hand; not in the ops config allowlist)

| Setting | Meaning |
| --- | --- |
| `ORBIT_OPENROUTER_ENABLED=1` | Off unless exactly `1`/`true`. |
| `ORBIT_OPENROUTER_MODEL` | Exact OpenRouter id. **No default.** Suffixes `:online`, `:nitro`, `:floor`, `:exacto`, `:extended` are refused. |
| `ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK`, `..._OUT_...` | Required, verified by Rai. No default: without them spend cannot be bounded and the fallback is unavailable. |
| `ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS` | Default 2048, 16 to 8192. Sent as `max_tokens`; on most providers it also covers reasoning, but the reservation does not rely on that. |
| `ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS` | **Required, no default.** Tokens. Largest billable output (reasoning included) one call is reserved for: the largest `context_length`/`max_completion_tokens` of every admitted endpoint (`tools/openrouter-price-check` prints it; 1,048,576 for `deepseek/deepseek-v4-flash` on 2026-11-13). At least max output tokens, at most 4,194,304. The daily cap must be at least the reservation for the largest request. |
| `ORBIT_OPENROUTER_TIMEOUT_MS` | Default 60000, 1000 to 120000. |
| `ORBIT_OPENROUTER_DAILY_CAP_USD` | USD per UTC day. Default 5. |
| `ORBIT_OPENROUTER_MONTHLY_CAP_USD` | USD per UTC calendar month. Optional, no default. When set, `..._TOTAL_CAP_USD` must be set explicitly too. |
| `ORBIT_OPENROUTER_TOTAL_CAP_USD` | USD **lifetime** (never resets). Default 150 when no monthly cap is set; `off` only together with a monthly cap. |

Caps nest (daily <= monthly <= lifetime), `0` and malformed values are refused, and at least one of monthly/lifetime is always in force. Full rules, the proposed 5/day + 150/month settings and the migration caveats: `docs/openrouter-spend-caps.md`.

Credential: root-only `/etc/credstore/orbit.openrouter` (0600), picked up by the existing `ImportCredential=orbit.*`, read with `CREDENTIALS_DIRECTORY` like `orbit.openai`. Never read at build time, never logged, redacted from errors. Requires `STATE_DIRECTORY` (the ledger is durable; without it the fallback is unavailable).

## Spend guard (`src/spend-ledger.ts`)

Money is integer micro-USD. `<state>/openrouter-spend.json` (0600 file, fsynced, atomic rename, directory fsync). Several processes are protected by a lock and a missing ledger is never a new budget: see `docs/openrouter-ledger-integrity.md` for the lock, stale-lock policy, crash behaviour, provisioning and recovery.

1. **Reserve before sending.** Upper bound = (request bytes + 64) × input price + output bound × output price (`reservationUsd`). Bytes bound tokens (no tokenizer emits more than one token per byte); the output bound, not `max_tokens`, bounds output, because OpenRouter says reasoning counts against `max_tokens` only "on most providers". Requests also send `reasoning: {effort: "none"}` and `provider.require_parameters: true`; the bound does not depend on either. The reservation counts against every configured cap (daily, monthly, lifetime) until settled, also after a day or month rollover. Calls that would exceed the remaining daily, monthly or lifetime allowance are refused; concurrent calls, in this process or in another one sharing the state directory, cannot jointly exceed it (every step is one lock-protected read-check-write).
2. **Provider-side price ceiling.** The request sets `provider.max_price` to the configured prices, so OpenRouter should refuse a route that costs more than the bound assumes.
3. **Settle** with `usage.cost` (always returned on Chat Completions; the deprecated `usage.include` is not sent). Missing, non-numeric or negative cost, a timeout/network failure after sending, or a 5xx: the **whole reserved bound stays charged** and the request is listed under `uncertain`. Nothing is refunded on a guess. A cost above the bound is recorded in full and flagged. Only a refusal that proves no work was done (400/401/402/403/404/429) releases the reservation.
4. **Restart.** A reservation whose owning process is proven gone is a request that may have been billed: charged at its bound as orphaned. A live or unprovable owner's reservation stays reserved. Spend never resets on restart.
5. **UTC days and months.** The day key is the UTC date at reserve time; a settled or orphaned charge goes to that day, once. The daily counter is per day, the monthly total is the sum of the UTC calendar month's days (plus a declared opening balance in the ledger's creation month, see `docs/openrouter-spend-caps.md`); the lifetime counter is separate and never resets. A ledger whose monthly total cannot be reconstructed refuses every call while a monthly cap is configured.
6. **Fail closed.** A missing, unreadable, corrupt, invalid, rolled-back or replaced ledger refuses all paid calls; it is never recreated or zeroed. It is created only by the startup step and only when Rai asked for it (`openrouter-spend.provision`); a marker file detects deletion of the ledger alone. A person must inspect and repair it.
7. **Latched fault.** If a paid call's outcome could not be recorded (billed answer, HTTP error, timeout, unreadable body), or the ledger refused at admission, no further paid call is admitted by that process and status says NOT armed; only a restart after checking the ledger clears it, and the unrecorded call is then charged at its bound.

**What is and is not guaranteed.** The local ledger prevents ORBIT from *sending* a request whose proven bound would exceed the caps, assuming (a) every writer uses the lock (ORBIT does; a human editing the file or a local filesystem without reliable `link`/`rename`/`fsync` does not), (b) the configured prices and output bound are right, (c) OpenRouter honors `provider.max_price`, and (d) one call's billable output does not exceed the model's context length (it no longer assumes reasoning is inside `max_tokens`). It is not a provider-enforced hard cap: a provider that ignores those parameters, a wrong price, or an out-of-band use of the key can spend beyond it, and it sees only costs the provider reports. For a real hard cap, **also set a credit limit on the OpenRouter key** (and fund the account only with what Rai accepts losing); verify the key limit options in OpenRouter's dashboard before activation. Do not describe the guard as a hard cap without that.

The OpenRouter key balance (`GET /api/v1/key`, read at most every 10 minutes, no spend) is shown only if the call works and is always labeled account side, separate from the local allowance. The endpoint's field names were not verifiable from this environment; if it fails, status says "balance unavailable".

**Status is observation only.** `/status` never spends, never asks OpenRouter for anything (the balance is read by the periodic maintenance tick, not by status), and never writes the ledger: it reads the ledger file and reports what it finds. It says "armed" only when the configuration is complete and the ledger was read and validated on that very call. A ledger that is corrupt, unreadable, invalid or deleted after it was written, or a billed call whose ledger write failed, shows "NOT armed" (and, while ChatGPT is limited, the model port is "down" because no fallback can answer); a ledger not created yet shows "configured but not verified". A missing ledger shows "NOT armed ... not provisioned" (and says so if Rai's provision request is waiting for the next start); ORBIT creates it only at startup and only for that request (`src/main.ts`), never from a status poll or a call. A fault latched by a paid call also shows NOT armed. The model id, key and prices shown come from ORBIT's configuration: **nothing in `/status` means OpenRouter verified them.** The balance carries its read time and is marked STALE after 20 minutes. The local allowance is ORBIT's own count as last written, not a hard spending ceiling.

**Bounded responses.** Every provider body is read as a stream and counted in bytes as it arrives: completions up to 1,000,000 bytes, error bodies up to 64,000, the balance body up to 32,000. `Content-Length` is only used to refuse early; a missing or false one changes nothing. One deadline (the configured timeout) covers the request and the whole body. On a size or time limit the stream is cancelled, the call fails with a fixed message (no provider text), a possibly billed request stays charged at its bound, and nothing is retried. An error body that cannot be read is still classified by its HTTP status: a 400/401/402/403/404/429 releases the reservation, anything else stays charged.

**Incomplete replies.** `incomplete` (on the `/chat` reply and the stored thread message, rendered by the page as "Incomplete reply: ...") says a reply was cut off at the output limit, ended early (`content_filter`, `error`), had an unrecognised finish reason or none at all, was shortened by ORBIT's 32,000-character limit, or had tool calls without an id or name dropped. It is separate from `text`, from tool arguments and from `accounting`, so it is never sent back to the model and never hides or replaces a billing warning. A reply that ended early in the middle of a tool call, or that carries a tool call with a missing, null or unrecognised finish reason, is refused and no tool runs (a tool call runs only after `stop`, `tool_calls` or `function_call`).

## Model recommendation (research, not activation)

ORBIT defaults to no model. On 2026-11-13 OpenRouter's public `/api/v1/models` and `/endpoints` data was read directly (unauthenticated): the recommended candidate is `deepseek/deepseek-v4-flash` (V4 Flash 0423): `tools` and `tool_choice` supported, context 1,048,576, per-endpoint prices 0.05-0.21 USD per M input and 0.1652-0.56 per M output, no time-window pricing or extra fees. The earlier web-search figures are withdrawn. The headline price in `/api/v1/models` is one provider's price, not a maximum, so set `ORBIT_OPENROUTER_PRICE_*` from the per-endpoint data with `tools/openrouter-price-check` (see `docs/openrouter-preactivation-evidence.md`, which also lists the open questions about reasoning tokens and time-window prices). Rai confirms the id and prices; this is not activation.

## Activation (Rai, not part of this change)

Exact procedure, smoke test and rollback: **`docs/openrouter-activation-runbook.md`**. Summary:

1. Confirm the model id, tool support and prices; approve the tool scope and the data flow above.
2. Fund the OpenRouter account minimally; set a credit limit on a new key.
3. As root: `install -m 0600` the key to `/etc/credstore/orbit.openrouter`.
4. Edit `/opt/orbit/orbit.env` with the settings above, then restart ORBIT. `/status` should say "OpenRouter fallback armed" (this means the configuration is complete and the local ledger reads cleanly; it does not mean OpenRouter has verified the key, model or prices).

## Rollback

Set `ORBIT_OPENROUTER_ENABLED=0` (or remove it) and restart: the primary model is used exactly as before. Delete the credential to revoke access; revoke the key in OpenRouter. Keep `openrouter-spend.json` and `openrouter-spend.marker` so lifetime spend is not lost if re-enabled (a marker without its ledger stops spending).

## Tests

`test/openrouter-fallback.test.ts`, `test/openrouter-hardening.test.ts` and `test/openrouter-pr64-followups.test.ts` use a fake provider (streamed, stalled and oversized bodies included) and fake time; `test/spend-ledger-multiprocess.test.ts` and `test/spend-ledger-provisioning.test.ts` use real child processes and temporary directories. No paid call is possible.
