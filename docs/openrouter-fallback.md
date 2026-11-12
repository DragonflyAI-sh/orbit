# OpenRouter fallback

ChatGPT token sharing stays ORBIT's model. While ChatGPT reports a **usage limit or rate limit**, ORBIT can answer through OpenRouter instead, clearly labeled, with restricted tools and a spend guard. It is **off** until Rai configures it. Nothing in this change activates it.

## When it answers

- Only when the primary throws a typed `ProviderError` of kind `usage_limit` or `rate_limit` (including ORBIT's own pause refusal after one). Authentication failures, overload, incomplete responses and every other error are reported as they are, with no fallback.
- While the limit is in force ChatGPT is **not called**: the provider's reset time is used, or, when it gave none, ORBIT's existing estimated pause (`USAGE_PAUSE_MS`/`RATE_PAUSE_MS`), always shown as an estimate, never as a reset. The existing no-reset pause and overload retry in `src/chatgpt.ts` are unchanged.
- After the reset/pause time the next call goes to ChatGPT. Only a **successful ChatGPT call** counts as recovered; status says "not confirmed recovered" until then. If it is limited again, the fallback resumes.
- A model turn is atomic: the fallback is used only when the primary returned nothing, so no partial output is ever mixed or replayed. Mid-reply (after tool rounds) the fallback continues from the recorded tool results; tools are never re-run. Such a reply is marked as mixed.
- Missing key, disabled, or invalid config: the limit error is thrown as before, with "The OpenRouter fallback did not answer: <reason>" appended, and the port is reported `down` with that reason.

## Provenance

Every fallback reply has `source` = `model/openrouter/<model> (FALLBACK, paid: ChatGPT usage limit, resets <time> | ORBIT's estimated pause until <time>[; earlier rounds ... came from <primary>])`, and a structured `fallback` object (`provider`, `model`, `reason`, `primaryLimit`, `costUsd`) on the `/chat` reply and on the persisted thread message. The page prefixes such replies with "⚠ Fallback model, not ChatGPT". `/status` for the model port shows the limit, its reset or estimate, which model answers, the local allowance, and (if available) the OpenRouter key balance, labeled separately as account side.

## Permissions

Server-enforced in `src/fallback.ts` (`FALLBACK_TOOLS`), not by prompt: the fallback is offered only read-only tools (memory, repo/PR/jobs/ops reads, `orbit_config_view`, `vault_policy`) plus `job_launch`, which only creates a proposal. If the fallback model names any other tool, the step is discarded and nothing runs. Not allowed: `notify`, `job_steer`, vault writes, every `ops_propose_*`, `ops_sys_cancel_reboot`. Owner/policy checks and confirmation cards are untouched; the fallback sits below them. **Rai must approve this tool scope before activation.**

## Privacy

While the fallback answers, the conversation, memory excerpts, tool results and device summary are sent to OpenRouter and its provider. Requests set `provider.data_collection: "deny"`, `allow_fallbacks: false`, no plugins, no web search, no routing to other models. Rai must approve this data flow.

## Configuration (all in `orbit.env`, by hand; not in the ops config allowlist)

| Setting | Meaning |
| --- | --- |
| `ORBIT_OPENROUTER_ENABLED=1` | Off unless exactly `1`/`true`. |
| `ORBIT_OPENROUTER_MODEL` | Exact OpenRouter id. **No default.** Suffixes `:online`, `:nitro`, `:floor`, `:exacto`, `:extended` are refused. |
| `ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK`, `..._OUT_...` | Required, verified by Rai. No default: without them spend cannot be bounded and the fallback is unavailable. |
| `ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS` | Default 2048, 16 to 8192. Also covers reasoning tokens. |
| `ORBIT_OPENROUTER_TIMEOUT_MS` | Default 60000, 1000 to 120000. |
| `ORBIT_OPENROUTER_DAILY_CAP_USD`, `ORBIT_OPENROUTER_TOTAL_CAP_USD` | Default 5 and 150. Daily cannot exceed lifetime. |

Credential: root-only `/etc/credstore/orbit.openrouter` (0600), picked up by the existing `ImportCredential=orbit.*`, read with `CREDENTIALS_DIRECTORY` like `orbit.openai`. Never read at build time, never logged, redacted from errors. Requires `STATE_DIRECTORY` (the ledger is durable; without it the fallback is unavailable).

## Spend guard (`src/spend-ledger.ts`)

Money is integer micro-USD. `<state>/openrouter-spend.json` (0600 file, fsynced, atomic rename).

1. **Reserve before sending.** Upper bound = (request bytes + 64) × input price + `max_tokens` × output price. Bytes bound tokens (no tokenizer emits more than one token per byte); `max_tokens` bounds output. The reservation counts against both caps until settled. Calls that would exceed the remaining daily or lifetime allowance are refused; concurrent calls cannot jointly exceed it (every operation is synchronous read-check-write).
2. **Provider-side price ceiling.** The request sets `provider.max_price` to the configured prices, so OpenRouter should refuse a route that costs more than the bound assumes.
3. **Settle** with `usage.cost` (requested via `usage.include`). Missing, non-numeric or negative cost, a timeout/network failure after sending, or a 5xx: the **whole reserved bound stays charged** and the request is listed under `uncertain`. Nothing is refunded on a guess. A cost above the bound is recorded in full and flagged. Only a refusal that proves no work was done (400/401/402/403/404/429) releases the reservation.
4. **Restart.** A reservation found on disk at startup is a request that may have been billed: charged at its bound as orphaned. Spend never resets on restart.
5. **UTC days.** The day key is the UTC date at reserve time. The daily counter is per day; the lifetime counter is separate and never resets.
6. **Fail closed.** A missing-after-start, unreadable, corrupt or invalid ledger refuses all paid calls; it is never recreated or zeroed. A person must inspect and repair it.

**What is and is not guaranteed.** The local ledger prevents ORBIT from *sending* a request whose proven bound would exceed the caps, assuming (a) one ORBIT process owns the file, (b) the configured prices are right, and (c) OpenRouter honors `max_tokens` and `provider.max_price`. It is not a provider-enforced hard cap: a provider that ignores those parameters, a wrong price, or an out-of-band use of the key can spend beyond it, and it sees only costs the provider reports. For a real hard cap, **also set a credit limit on the OpenRouter key** (and fund the account only with what Rai accepts losing); verify the key limit options in OpenRouter's dashboard before activation. Do not describe the guard as a hard cap without that.

The OpenRouter key balance (`GET /api/v1/key`, read at most every 10 minutes, no spend) is shown only if the call works and is always labeled account side, separate from the local allowance. The endpoint's field names were not verifiable from this environment; if it fails, status says "balance unavailable".

## Model recommendation (research, not activation)

openrouter.ai and its API were not reachable from the job environment, so the ID and price below are **unverified**; ORBIT defaults to none. A web search (not OpenRouter's own API) pointed to `deepseek/deepseek-v4-flash` ([OpenRouter page](https://openrouter.ai/models/deepseek/deepseek-v4-flash)), reported as supporting `tools`/`tool_choice`, 1,048,576-token context, about $0.068/M input and $0.168/M output on one snapshot. Other pages listed different numbers ($0.10/$0.20, $0.14/$0.28), and dated variants (`-20260423`, `-0731`, `v4.1-flash`) exist with different prices. Before activating, Rai or a runner with access must read the model's page or `https://openrouter.ai/api/v1/models`, confirm the exact id, that `tools` is in `supported_parameters`, and the prompt/completion prices, then set those prices in `orbit.env`. Prefer a pinned dated id over an alias.

## Activation (Rai, not part of this change)

1. Confirm the model id, tool support and prices; approve the tool scope and the data flow above.
2. Fund the OpenRouter account minimally; set a credit limit on a new key.
3. As root: `install -m 0600` the key to `/etc/credstore/orbit.openrouter`.
4. Edit `/opt/orbit/orbit.env` with the settings above, then restart ORBIT. `/status` should say "OpenRouter fallback armed".

## Rollback

Set `ORBIT_OPENROUTER_ENABLED=0` (or remove it) and restart: the primary model is used exactly as before. Delete the credential to revoke access; revoke the key in OpenRouter. Keep `openrouter-spend.json` so lifetime spend is not lost if re-enabled.

## Tests

`test/openrouter-fallback.test.ts` uses a fake provider and fake time; no paid call is possible.
