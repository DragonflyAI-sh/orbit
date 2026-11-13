# OpenRouter fallback: operator activation runbook

Status: **prepared, not run.** Nothing here has been executed on the host. No key exists in any job, no paid request has been made, and nothing is activated. Every step is for Rai (or an operator Rai names) at the host, in order. Steps marked **STOP** end the procedure: roll back (section 9) and report.

Two separate approvals are needed, and the first does not imply the second:
- **A. Paid smoke test** (section 6): an isolated run with its own key and a $1 ceiling. It does not touch the service, its ledger or its configuration.
- **B. Production enablement** (sections 7 and 8): the service's own fallback, with the $5/day and $150 lifetime caps. These are the values proposed earlier; Rai confirms them at activation and they are not raised here. Nothing here assumes what the account balance is today.

Source of truth for every key, path and message below: `src/openrouter.ts` (config, request, reservation), `src/fallback.ts` (when it answers, status text), `src/spend-ledger.ts` (ledger, provisioning), `src/main.ts` (startup), `deploy/systemd/orbit.service` (unit), `src/ops/admin-protocol.ts` (what the chat config tool may change).

## 0. What ORBIT's own tools can and cannot do here
- Chat `ops_propose_config_change` changes only `ORBIT_MODEL`, `ORBIT_ROUTINES`, `ORBIT_ROUTINE_REPOS`, `ORBIT_PUBLIC_JOB_URL` and `ORBIT_INGRESS_PORT` (`CONFIG_KEYS` in `src/ops/admin-protocol.ts`). **None of the OpenRouter settings can be set through it, and `ORBIT_MODEL` is the ChatGPT model, not the fallback: do not touch it.** The OpenRouter settings are edited by hand in `/opt/orbit/orbit.env` as root (section 7). This is the owner-side secure setup step; no tool was widened to avoid it.
- No tool installs the credential, provisions the ledger, or runs the smoke test. Those are root steps at the host.
- Chat `ops_propose_restart_orbit` (owner-confirmed) restarts `orbit.service` and checks `/status` serves the same commit. `sudo systemctl restart orbit.service` does the same by hand.
- `install.sh` keeps settings it does not manage (it manages only `HOST`, `PORT`, `ORBIT_DEPLOY_STATE`, `ORBIT_VAULT`, `ORBIT_VAULT_STATE`, `ORBIT_OWNER`), so the OpenRouter lines survive a reinstall; pull deploys do not edit `orbit.env`.

## 1. Settings (non-secret), units and recommended values
All in `/opt/orbit/orbit.env`. Anything missing or invalid makes the fallback `unavailable` with a reason in `/status`; it never answers with a guessed value.

| Key | Unit | Recommended (production) | Smoke test | Rule in code |
| --- | --- | --- | --- | --- |
| `ORBIT_OPENROUTER_ENABLED` | flag | `1` | `1` (in the smoke environment only) | off unless exactly `1` or `true` |
| `ORBIT_OPENROUTER_MODEL` | OpenRouter model id | `deepseek/deepseek-v4-flash` (Rai confirms) | same | required, no default; no `:online`/`:nitro`/`:floor`/`:exacto`/`:extended`, no `~` alias |
| `ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK` | USD per million input tokens | `0.25` | same | required; 0 < p <= 1000; sent as `provider.max_price.prompt` |
| `ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK` | USD per million output tokens | `0.6` | same | required; sent as `provider.max_price.completion` |
| `ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS` | tokens | `1048576` | same | **required, no default**; >= max output tokens, <= 4,194,304. Must be >= the largest `context_length`/`max_completion_tokens` of every admitted endpoint (the price check prints it) |
| `ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS` | tokens | `2048` (default) | `256` | 16 to 8192; sent as `max_tokens` |
| `ORBIT_OPENROUTER_TIMEOUT_MS` | milliseconds | `60000` (default) | `60000` | 1000 to 120000 |
| `ORBIT_OPENROUTER_DAILY_CAP_USD` | USD per UTC day | `5` | `1` | daily <= monthly <= lifetime <= 10000; daily must be >= the reservation for the largest request (0.704162 USD at the values above); `0` refused |
| `ORBIT_OPENROUTER_MONTHLY_CAP_USD` | USD per UTC calendar month | `150` | unset (or at most `1`) | optional; when set, the lifetime setting must be explicit; `0` refused |
| `ORBIT_OPENROUTER_TOTAL_CAP_USD` | USD **lifetime**, never resets | `off` (with the monthly cap) | `1` (a number, not `off`) | default 150 only when no monthly cap is set; `off` only with a monthly cap |

Rai's stated budget is 5 USD per day and 150 USD per **month**, not lifetime: hence `MONTHLY=150` with `TOTAL=off`. Setting only `TOTAL_CAP_USD=150` (the earlier recommendation) would stop the fallback for good once 150 USD had been spent in total. Rules, status text and migration caveats: `docs/openrouter-spend-caps.md`.

Fixed in code, not configurable: `reasoning: {effort: "none"}`, `provider: {max_price, data_collection: "deny", allow_fallbacks: false, require_parameters: true}`, `stream: false`, `temperature: 0.2`, no plugins, no model list.

**What the reservation guarantees, and what it does not.** Each call reserves `(request bytes + 64) x price in + output bound x price out` (`reservationUsd` in `src/openrouter.ts`) before it is sent. It no longer relies on `max_tokens` for the output side, because OpenRouter documents reasoning as counting against `max_tokens` only "on most providers". It does rely on: (1) OpenRouter applying `max_price` so no endpoint above the configured prices is used; (2) a call's billable output, reasoning included, not exceeding the model's context length (each generated token occupies the context window); (3) the provider's `usage.cost` being reported, or, if not, the whole reservation stays charged. A cost above the reservation is recorded in full and flagged, never dropped. **This is ORBIT's own count, not a provider-enforced ceiling**: the only hard ceiling is the key's credit limit (section 3). Consequences of the conservative bound, stated plainly: each call in flight holds about $0.63-0.70 of allowance until settled; a call whose cost is unknown (timeout, network error, 5xx, missing cost) is charged the whole reservation, so about seven such calls exhaust a $5 day; the last ~$0.70 of a day cannot be spent (admission refuses when less than one reservation is left).

## 2. Prerequisite checks (any machine that can reach openrouter.ai; no key)
1. Fetch the public metadata (unauthenticated, read only):
   `curl -fsS https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints -o endpoints.json`
   `curl -fsS https://openrouter.ai/api/v1/models -o models.json`
2. Same model snapshot as recommended, reasoning not mandatory:
   `jq -r '.data[] | select(.id=="deepseek/deepseek-v4-flash") | [.canonical_slug, .context_length, (.reasoning.mandatory|tostring), (.reasoning.supported_efforts|join(","))] | @tsv' models.json`
   Expected (2026-11-13): `deepseek/deepseek-v4-flash-20260423  1048576  false  xhigh,high,none`. **STOP** if the slug changed, `mandatory` is `true`, or `none` is missing (the fallback would get HTTP 400 on every call).
3. Price check, from a checkout of the commit you will deploy:
   `node tools/openrouter-price-check/check.ts endpoints.json --in 0.25 --out 0.6 --output-bound 1048576`
   Expected: exit 0, `OK`, `smallest output bound covering every admitted endpoint: 1048576 tokens`, reservation for the largest request `0.704162 USD`. **STOP** on exit 1 (any BLOCKER) or if the smallest output bound printed is above the value you will configure. If prices moved, choose new prices that pass, never lower the output bound below the printed value.
4. Host: `systemctl is-active orbit.service` is `active`; `sudo test -d /var/lib/private/orbit` (the unit's `StateDirectory=orbit` under `DynamicUser=yes`; `/var/lib/orbit` links to it); `sudo ls /var/lib/private/orbit/openrouter-spend.*` shows **nothing** for a first activation. If a ledger or marker already exists, do not delete it: follow `docs/openrouter-ledger-integrity.md` (procedures 2-4).
5. Record the deployed commit: `cat /opt/orbit/current/COMMIT`. It must contain this change (`grep -c OUTPUT_BOUND_TOKENS /opt/orbit/current/src/openrouter.ts` prints a number above 0). **STOP** otherwise: older code ignores the output bound and reserves only `max_tokens`.

## 3. Dashboard (Rai, OpenRouter website)
1. Fund the account minimally (what Rai accepts losing).
2. Smoke key: create a new key named e.g. `orbit-smoke`, **credit limit $1, no reset**. Production key: a separate new key named e.g. `orbit-fallback`, credit limit **<= $150, no reset** (lifetime); optionally a workspace budget with a daily $5 limit. Record each key's usage figures (0 for new keys) with the date.
3. Settings, privacy: leave data collection off (ORBIT also sends `data_collection: "deny"`).
Limit semantics from OpenRouter's docs: when a key's combined spend reaches its limit, requests fail with 403; nothing says a request is pre-reserved, so the call that crosses the limit can overshoot it.

## 4. Credential installation (root, typed into the SSH session)
Never paste a key into chat, an agent, a `!` command, a file in a repository, or shell history. On the host, as root:
```
read -rs KEY && umask 077 && printf '%s' "$KEY" > /etc/credstore/openrouter-smoke.new && unset KEY && \
  chmod 0600 /etc/credstore/openrouter-smoke.new && mv /etc/credstore/openrouter-smoke.new /etc/credstore/openrouter-smoke
```
(type the smoke key at the silent prompt). For production use the same command with the production key and the file name `orbit.openrouter` (the unit's `ImportCredential=orbit.*` picks it up at the next start; ORBIT reads it from `CREDENTIALS_DIRECTORY` and never logs it). The smoke key file is deliberately named `openrouter-smoke`, outside the unit's `ImportCredential=orbit.*` pattern, so the running service never receives it. Check: `sudo stat -c '%n %U %a %s' /etc/credstore/openrouter-smoke /etc/credstore/orbit.openrouter` shows `root 600` and a non-zero size. Do not `cat` it.

## 5. Host rehearsal before any paid call (G6; no key used)
In a separate checkout of the deployed commit on the host (never against `/var/lib/orbit`): `pnpm install --frozen-lockfile && node --test test/spend-ledger-multiprocess.test.ts test/openrouter-output-bound.test.ts test/openrouter-smoke.test.ts`. All must pass. The deeper rehearsal (throwaway unit, `systemctl kill -s KILL`, pid-namespace case) is in `docs/openrouter-preactivation-evidence.md`, operator checklist step 6.

## 6. Paid smoke test (approval A; PREPARED, NOT RUN)
**Authorisation needed, in Rai's words:** "I authorise one paid OpenRouter smoke test of model deepseek/deepseek-v4-flash with the orbit-smoke key (credit limit $1), at most 3 requests." Nothing else authorises it.

Ceilings: key credit limit **$1** (provider side, the hard one); local caps `1`/`1` USD; at most **3** requests (enforced by the tool); `max_tokens` 256; expected cost well under $0.01 (three short prompts, reasoning off). Worst case on the provider side is bounded by the key limit (plus a possible overshoot by the crossing call, not observed or verified).

What runs: `tools/openrouter-smoke/smoke.ts` (code in `src/openrouter-smoke.ts`, tests in `test/openrouter-smoke.test.ts`). It drives ORBIT's real fallback path with a fake ChatGPT that is always usage-limited, against a new temporary ledger (not the service's), with three requests: (1) plain reply to a synthetic prompt; (2) a tool-using turn offering `jobs_list` (allowed in fallback mode), whose call is checked and **never executed**; (3) a fixed synthetic tool result fed back for the final answer. It stops at the first failed check. It prints JSON with each request's reported cost, token counts and reservation, and the isolated ledger's totals; no reply text and no key.

Command (root, on the host, with the service untouched; the key reaches only the transient unit through `LoadCredential`, never the shell):
```
sudo systemd-run --quiet --pipe --wait --collect -p DynamicUser=yes -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes \
  -p LoadCredential=orbit.openrouter:/etc/credstore/openrouter-smoke -p WorkingDirectory=/opt/orbit/current \
  -E ORBIT_OPENROUTER_ENABLED=1 -E ORBIT_OPENROUTER_MODEL=deepseek/deepseek-v4-flash \
  -E ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK=0.25 -E ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK=0.6 \
  -E ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS=1048576 -E ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS=256 \
  -E ORBIT_OPENROUTER_DAILY_CAP_USD=1 -E ORBIT_OPENROUTER_TOTAL_CAP_USD=1 \
  /usr/local/bin/node tools/openrouter-smoke/smoke.ts --confirm-paid-smoke | tee /root/openrouter-smoke-$(date -u +%Y%m%dT%H%M%SZ).json
```
Pass criteria (all): exit 0; `requests` 3; every check `ok: true` (fallback provenance with model and reset time; text present; no accounting problem; ledger settled with nothing reserved or uncertain; well-formed `jobs_list` call; final answer with no further call; per request: usage reported, `completion_tokens <= 256`, cost within its reservation). Then, within an hour, compare with the dashboard (Activity for the `orbit-smoke` key): number of generations is 3, each one's cost equals the report's `costUsd` (to the dashboard's rounding), the key's usage equals the report's `ledger.lifetimeUsd`, and each generation's provider is one of the 13 admitted endpoints the price check listed.

**STOP** (and do not proceed to production) if: exit 1 or 2; more than 3 generations in the dashboard; any cost above its reservation; `completion_tokens` above 256 (reasoning ran past `max_tokens` on that provider: the reservation still covered it, but decide with that evidence before enabling); dashboard and report disagree by more than rounding; any generation used a provider not in the admitted list; the key shows spend you cannot account for.

Afterwards, in every case: revoke the `orbit-smoke` key in the dashboard and `sudo rm /etc/credstore/openrouter-smoke`. Keep the JSON report.

## 7. Production enablement (approval B; separate from A)
**Authorisation needed, in Rai's words:** confirmation of the model id, the two prices, the output bound, the caps ($5/day, $150 lifetime), the tool scope (`FALLBACK_TOOLS` in `src/fallback.ts`, including `job_launch`), the data flow (conversation, memory excerpts and tool results go to OpenRouter and its provider), and the open owner decisions in `docs/openrouter-preactivation-evidence.md` (G4, G5).
1. Production key installed as `/etc/credstore/orbit.openrouter` (section 4).
2. Back up and edit the environment file as root, keeping its owner, group and mode (the admin config runner refuses a file that is not a plain root-owned file):
   `sudo cp -p /opt/orbit/orbit.env /root/orbit.env.before-openrouter`
   `sudo grep -c '^ORBIT_OPENROUTER_' /opt/orbit/orbit.env` must print `0` (no duplicates). Then:
   ```
   sudo tee -a /opt/orbit/orbit.env >/dev/null <<'EOF'
   ORBIT_OPENROUTER_ENABLED=1
   ORBIT_OPENROUTER_MODEL=deepseek/deepseek-v4-flash
   ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK=0.25
   ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK=0.6
   ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS=1048576
   ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS=2048
   ORBIT_OPENROUTER_TIMEOUT_MS=60000
   ORBIT_OPENROUTER_DAILY_CAP_USD=5
   ORBIT_OPENROUTER_MONTHLY_CAP_USD=150
   ORBIT_OPENROUTER_TOTAL_CAP_USD=off
   EOF
   ```
3. Provision the ledger with the spend so far, read from the dashboard for the production key (lifetime and today, UTC; both 0 for a new key). The file must be readable by the service's dynamic user, so give it the state directory's owner:
   ```
   D=/var/lib/private/orbit
   printf '%s\n' '{"openingLifetimeUsd": 0, "openingTodayUsd": 0, "openingMonthUsd": 0, "note": "new key orbit-fallback; dashboard showed $0 on <YYYY-MM-DD>"}' > /root/openrouter-spend.provision
   sudo install -m 0600 -o "$(sudo stat -c %u $D)" -g "$(sudo stat -c %g $D)" /root/openrouter-spend.provision $D/openrouter-spend.provision
   ```
   A non-zero key history uses the real figures, rounded up; `openingMonthUsd` (optional) is the part spent in the current UTC month, otherwise the whole opening balance counts against this month's cap. `{}` is refused. A root-only file the service cannot read is treated as absent (status then says "not provisioned").
4. Restart: `sudo systemctl restart orbit.service` (or chat `ops_propose_restart_orbit` and confirm).
5. Verify:
   - `sudo journalctl -u orbit.service --since -5min | grep -i openrouter` shows no "could not be opened at startup" line.
   - `sudo ls $D` shows `openrouter-spend.json`, `openrouter-spend.marker` and `openrouter-spend.provision.used-<epoch>`, and no `openrouter-spend.provision`.
   - `sudo sh -c '. /opt/orbit/orbit.env; curl -fsS "http://$HOST:$PORT/status"' | jq -r '.ports[] | select(.port=="model") | .detail'` contains `OpenRouter fallback armed: deepseek/deepseek-v4-flash` and `$0.0000 spent today of $5`, `$0.0000 spent in UTC month <YYYY-MM> of $150`, `$0.0000 lifetime (no lifetime cap)`, `$0.0000 reserved` (or the declared opening). "Armed" means the configuration is complete and the ledger reads cleanly; it does not mean OpenRouter verified the key, model or prices.
   - Within about 10 minutes the same detail shows `OpenRouter key (account side, not the local allowance): limit $150.00 ...`. If it says "balance unavailable", the key or network is wrong: **STOP**.
   - ChatGPT replies as before (no "FALLBACK" in normal replies).
6. **STOP** conditions after enabling: status says `unavailable` or `NOT armed`; any fallback reply without the "FALLBACK, paid" source; dashboard spend above the local lifetime figure; a `provider cost exceeded the reserved bound` entry; a latched ledger fault. Then disable (section 9).

## 8. Operating notes
- The fallback answers only interactive chat turns while ChatGPT reports a usage or rate limit; background work fails with the limit instead. ChatGPT is retried after the reset or ORBIT's estimated pause; only a successful ChatGPT call counts as recovered.
- A latched fault ("the spend ledger is latched as untrusted") clears only on restart after the ledger is checked; the unrecorded call is then charged at its reservation.
- Lock or guard files that cannot be proven stale need the manual step in `docs/openrouter-ledger-integrity.md`.

## 9. Disable and roll back (accounting preserved)
1. `sudo sed -i 's/^ORBIT_OPENROUTER_ENABLED=.*/ORBIT_OPENROUTER_ENABLED=0/' /opt/orbit/orbit.env` (or restore `/root/orbit.env.before-openrouter` with `sudo cp -p`), then `sudo systemctl restart orbit.service`. The primary is used exactly as before; status no longer mentions the fallback.
2. `sudo rm /etc/credstore/orbit.openrouter`; revoke the key in the dashboard.
3. **Keep** `/var/lib/private/orbit/openrouter-spend.json` and `openrouter-spend.marker` (and the `.used-*` provision records). Deleting the ledger alone makes a later re-enable refuse ("marker without ledger"); deleting both erases the local lifetime count, which ORBIT then cannot tell from a first run.
4. Re-enabling later: same model and caps, set `ENABLED=1`, reinstall a key, restart; the existing ledger continues. A new key with old local history is fine (local lifetime only grows).
