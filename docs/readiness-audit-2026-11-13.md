# Reliability readiness audit — 2026-11-13

Scope: whether ORBIT is ready for **bounded, human-confirmed feature development**. This audit does not cover unattended autonomy, which is a separate, later gate.
Job: `orbit-202611130644-epou`. Base: `DragonflyAI-sh/orbit` main at **`51c1ae3eb6501612325d159439058d56f5cda0c3`** (PR #70, monthly caps). The runner's tool commit is the same commit.

**Status values**
- **PASS**: there is an implementation and an offline (mocked) test that exercises it.
- **MISSING EVIDENCE**: the behaviour can only be shown in production or by an operator, or no test covers it.
- **DEFECT**: the code is wrong today, shown with a concrete input.

A PASS never means production works: no gate here was verified live by this runner.

> **Later change (2026-11-14):** launch-time vault context export was removed (`docs/job-context.md`). The rows below that cite context export, `prepareContext`, `pushContext` or the post-deploy context end-to-end check describe code that no longer exists; that live check is no longer needed. They are kept as the record of this audit.

This audit adds tests and this document only. It changes no production code. It is not one of the two independent reviews that sensitive changes need.

## How it was checked

| Command (repo root, offline) | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | ok |
| `pnpm typecheck` at `51c1ae3` (before changes) | clean, exit 0 |
| `pnpm test` at `51c1ae3` (before changes) | **932/932 pass**, 0 fail, 0 skipped. Matches the 932 reported for the PR #70 review of `7cb2df8`. |
| `pnpm typecheck` with this branch's tests | clean, exit 0 |
| `pnpm test` with this branch's tests | **937/937 pass**, 0 fail, 0 skipped |
| One-off check, not committed: the real `42c5e7f:src/spend-ledger.ts` opens, writes and rolls forward a ledger written by `51c1ae3` under 5/day, 150/month, lifetime off | old code read it (lifetime 1.35), kept `priorMonthsMicro`, and the current code re-opened it correctly afterwards |

Not done, by instruction:
- no production SSH or deploy
- no config or Routine change
- no provider call or paid test
- no repeat of the smoke test
- no access to `/root` or the smoke report
- no vault edits

**Vault context.** The brief has no snapshot section. All nine named notes were read from the read-only vault checkout (vault HEAD `f0a2f44`): `Projects/orbit-next.md`, `Resources/orbit-next-handover-to-orbit.md` and seven `Tasks/orbit-next-*` notes. Nothing was copied from them here beyond short facts.

During the gate-4 code reading, an audit sub-step also opened two vault notes the brief did not name (a 2026-11-08 daily log and `Tasks/orbit-next-server-ops-tools.md`). This audit does not rely on either of them. The rollback-drill evidence below is cited from the named project note instead.

## Gate 1: content filter

| Item | Status | Evidence |
| --- | --- | --- |
| Ordinary notes and paths pass on reads, writes, context export and cards | **PASS** (one exception, D3) | One detector, `scan()`, in `src/vault/filter.ts:265-280`, guarded by `wordLikeRun` (:50-93) and the path and file-name exemptions (:103-173). Tests: `test/vault-filter-matrix.test.ts` (all 6 surface tests); `test/vault-filter.test.ts` "ordinary vault text passes: headings, long names and paths, wikilinks…"; `test/vault-write.test.ts` "vault filter on the write path…"; `test/job-context.test.ts` "vault filter on context export…". Probed here: `[[orbit-next-compaction-empty-summary]]` and `**Credential:** an OpenRouter API key` produce no findings. |
| Known secrets blocked (`sk-`, `ghp_`, `github_pat_`, JWT, token and password assignments) | **PASS** | `PROVIDER` and `JWT` at `filter.ts:192-211`; assignments at :129-168. Tests: `vault-filter.test.ts` "known credential shapes are recognised…"; `vault-write.test.ts` "secret-shaped content is refused, never redacted into a commit". |
| "Long random strings" blocked | **Policy gap, needs Rai's decision** | `secret.long-opaque` was removed on purpose in PR #66 (`docs/content-filter.md:34`). Random strings with no known prefix and no credential name now pass, and `vault-filter.test.ts` "unknown and weakly suspicious content passes (permissive policy)" pins that. The brief's gate wording expects them blocked. Do not mark this passed or change it without Rai. |
| Safe diagnostic explanations | **PASS**, plus defect D4 | Findings are only `{rule, line}` (`filter.ts:35`, `describeFindings` :350-361). Tests: `vault-filter.test.ts` "findings are rule ids and line numbers only…"; `job-context.test.ts` "a secret-shaped path is not echoed". |
| Live acceptance, real logs, full-vault corpus, two independent reviews | **MISSING EVIDENCE** | Listed as not done in `docs/content-filter.md:166-171`. |

## Gate 2: development feedback

| Item | Status | Evidence |
| --- | --- | --- |
| Full PR review and comment pagination | **PASS** | `src/pr-inspect.ts:140` follows the Link `rel=next` header; `ctx.all` requests `per_page=100` (:412-421); lists are capped at 1,000 items, and a capped list says so (`readAllPages:false` and `incompleteNote`, :717). **New tests:** `test/pr-inspect.test.ts` "readiness: reviews beyond GitHub's first page of 100 are all read, and the final verdict on page 2 is reachable" and "readiness: conversation comments beyond the first page are all read". Still untested: the 1,000-item cap path, check runs with fewer listed than `total_count`, and commit-status paging. |
| Final-head pinning, stale marking, verified verdicts | **PASS** | `expectedHead` and head re-read before and after each call (`pr-inspect.ts:362`, :390, :425); checks grouped by app, suite and name (:576); a COMMENTED review never supersedes a change request (:541, :695-701); verdicts verified against job records and the poster's account (`src/orbit-review-provenance.ts:47-103`). Tests in `test/pr-inspect.test.ts`, including "a head that moves while a call is reading marks the result stale…", "two workflows with the same-named job are both current…", "a later COMMENTED review never supersedes a CHANGES_REQUESTED review…" and "a forged verdict from another account… is unverified". All three findings from the PR #54 review are fixed (PR #55). |
| Review runner pinned to the reviewed SHA | **MISSING EVIDENCE** | `reviewedSha` is the PR head when the review job was launched. The review brief (`src/review.ts:18-34`) does not make the runner check out exactly that SHA. |
| Job context access | **PASS offline, MISSING EVIDENCE live** | Snapshot and manifest with sha256 (`src/job-context.ts:181-187`), one commit on `orbit/<job>` (`src/launcher.ts:76-92`). Tests: `job-context.test.ts`, `sparse-checkout.test.ts`. This runner saw the vault checkout at `/home/user/orbit-vault` and, because this brief has no context section, no `.orbit/context/`. The post-deploy end-to-end check (one note inside the sparse set, one outside) is still open. |
| Partial-launch cleanup | **PASS** for no-fire; the leftover branch is **not cleaned** | When a context upload fails, the launch is recorded as `launch-failed` and the Routine is not fired (`src/job-launch.ts:62-70`). Test: `job-context.test.ts` "a write failure for the copies marks the launch failed and never fires the Routine". The branch is kept, and only ORBIT's job list marks it failed (`docs/job-context.md:33`). |
| Model request timeout | **DEFECT D1** | See the defects section. OpenRouter is bounded (`src/openrouter.ts:310`, :397). |

## Gate 3: fallback and spend

| Item | Status | Evidence |
| --- | --- | --- |
| Fallback only on usage or rate limit | **PASS**, plus defect D2 | `isLimit` (`src/fallback.ts:59`). Test: `test/openrouter-fallback.test.ts` "only usage and rate limits fall back; auth, overload, incomplete and arbitrary errors do not"; recovery tests "a real reset: ChatGPT is not called before it…". |
| No paid background work | **PASS** for the current callers; latent risk L1 | `step()` uses the fallback only on opt-in (`fallback.ts:184`). The current background `reply()` callers all pass `fallback:false`: `src/runs.ts:64`, `src/thread-context.ts:167`, `src/recent-context.ts:183`. **New tests** (through the real callers): `openrouter-fallback.test.ts` "readiness: the scheduled model-task worker never spends OpenRouter while ChatGPT is limited" and "readiness: thread compaction never spends OpenRouter while ChatGPT is limited…". The recent-context rewrite is covered by code reading only. |
| Tool-call-only error accounting | **PASS** | `src/openrouter.ts:360`, :383; test "client: a billed tool-call-only reply with empty content keeps its calls and surfaces the ledger error". |
| Diagnostics kept apart from model text | **PASS** | Separate `accounting` and `incomplete` fields (`src/model.ts:28-29`); error messages filtered out of model input (`thread-context.ts:55`, :64). Tests: "server and thread UI: diagnostics reach the owner… and stay out of the next model turn"; `openrouter-hardening.test.ts` accounting tests. |
| Daily and monthly caps, concurrency | **PASS** | Reserve before fetch; all caps checked in one locked section (`src/spend-ledger.ts:693-716`); link(2) lock. Tests: "concurrency: simultaneous calls cannot together exceed the allowance"; `spend-ledger-multiprocess.test.ts` "competing processes near a MONTHLY cap (no lifetime cap)…"; `openrouter-monthly-caps.test.ts`. |
| Settlement, orphan and crash recovery | **PASS** offline | Atomic fsync, rename and directory fsync (`spend-ledger.ts:317-340`); dead owners' reservations are charged at their bound. Tests: `spend-ledger-multiprocess.test.ts` "a process killed while its request is reserved…", "…killed INSIDE the critical section…". |
| Durable per-call provenance | **MISSING EVIDENCE** (gap) | The ledger keeps day totals and uncertain entries, not a per-call record. Neither `fallback.ts` nor `openrouter.ts` logs settled calls. Comparing against the provider dashboard per generation therefore depends on stored threads and the smoke report. |
| Lifetime off, rollback compatibility | **PASS** offline, with an operator precondition | `TOTAL=off` is allowed only together with a monthly cap (`src/openrouter.ts:127-132`). **New test:** `test/readiness-rollback-compat.test.ts` checks that a 5/150/off ledger keeps the earlier schema and passes the 42c5e7f validator. Precondition: older code reads `TOTAL=off` as NaN, so the fallback becomes `unavailable` (fail-closed) unless a numeric total is restored before rolling back (`docs/openrouter-spend-caps.md:64`). |
| Production: fallback execution, smoke settlement and cost reconciliation, smoke-key revocation | **MISSING EVIDENCE** | Not verifiable here. See the operator checklist below. |

## Gate 4: recovery and deploy

| Item | Status | Evidence |
| --- | --- | --- |
| Recovery instructions usable without ORBIT | **MISSING** (documentation gap) | The manual SSH steps exist only inside the drill (`docs/rollback-drill.md:118-140`). Nothing tells an operator to run `pull-deploy.sh --rollback` by hand, how to stop autonomous work (pause the Routine, remove `orbit.routine.*` from credstore), where logs and state live, or how to restore state. The vault break-glass note does not exist (`Tasks/orbit-next-break-glass.md` item 2 is open). |
| Functional post-deploy smoke | **MISSING** (gap) | `healthy()` (`deploy/pull-deploy.sh:53-63`) passes when `/status` returns the expected commit. No chat, tool, vault, ingress-401 or threads probe runs, so a logical regression stays deployed and nothing raises an alert. `docs/rollback-drill.md:155` says the same. Outside failures and release regressions are therefore not told apart. |
| Automatic deploy rollback (the timer path) | **PASS**, live evidence from 2026-11-08 | `switch_and_verify` and `rollback_to` (`pull-deploy.sh:77-131`). Tests in `test/pull-deploy.test.ts`: "candidate smoke failure rolls back…", the "drill: …" tests. The vault project log records "2026-11-08 production rollback drill passed and verified (PR #27, `2005f6d`)". The only later change to `pull-deploy.sh` (`7bb9e1e`) does not touch these functions. |
| Tier-2 manual rollback (`rollback_release`) | **PASS** offline, **MISSING EVIDENCE** live | `rollback()` (`pull-deploy.sh:259-290`) and `src/ops/admin-run.ts:265-294`. Tests: `test/pull-deploy-admin.test.ts` "--rollback switches to the previous release…" and 5 more; `test/ops-admin-helper.test.ts` "rollback_release runs only the installed script's --rollback…". `Tasks/orbit-next-small-fixes.md` item 5 records that this path has never run live. The November 9 admin-ledger restart is not a rollback. |
| Rollback compatibility, including lifetime off and ledger history | **PASS** offline, with a precondition | See gate 3. The actual previous release on the host (`history.jsonl`) is unknown here, and it may be older than 42c5e7f. |
| Last-known-good evidence | **Partial** | `deploy.json` `lastDeployed` is written only after the commit check passes (`pull-deploy.sh:332`), and `history.jsonl` is kept (:249). `lastDeployed` means "serves the commit", not "works". No last-known-good value is recorded off-host. |

## Defects (each needs a separately reviewed fix; not changed here)

- **D1: no timeout on ChatGPT inference.**
  - Where: `src/chatgpt.ts:555` (`fetcher(RESPONSES_URL, …)` has no `signal`) and `:517` (the stream body is read with no deadline). The same applies to `openaiModel` (`src/model.ts:136`) and to `runChat` (`src/agent.ts`), which has no turn deadline.
  - Effect: when ChatGPT stalls after sending headers, the turn never ends. The thread stays busy and refuses new turns and archiving. A stall is not a usage limit, so the fallback does not take over.
  - Severity: high for reliability. Confidence: high (read in code; no test uses a hung primary).
  - Fix: one `AbortSignal.timeout` covering both the request and the body read, as `openrouter.ts:310` does, plus a hung-fake test.
- **D2: a 429 rate limit can be misclassified as a usage limit.**
  - Where: `src/chatgpt.ts:271` runs the usage-limit check first. Any 429 whose message contains "limit", "usage" or "plan" (for example "Rate limit reached") becomes `usage_limit`.
  - Effect: with no reset time, ORBIT pauses for 15 minutes instead of 1 minute. Paid fallback then answers for about 15 times longer than needed (it stays within caps, but it is unneeded spend).
  - Severity: low to medium. Confidence: medium-high (read in code; not executed).
  - Fix: test the `rate_limit` code before the message-text heuristic, and add a test.
  - Status (2026-11-14): fixed on branch `orbit/orbit-202611140009-3wq1`. The message-text heuristic is removed; only structured codes mark a usage limit, and `Retry-After` is honored. Tests: `test/chatgpt-rate-vs-usage.test.ts`.
- **D3: kebab-case names starting with `sk-` are treated as secrets.**
  - Where: `src/vault/filter.ts:194`. The body class includes `-` and there is no word-like guard.
  - Effect: `[[sk-learn-pipeline-migration-notes]]` and a bare `sk-learn-pipeline-migration-notes` are flagged `secret.provider-token`. Writes and context export are refused, and the name is masked. Verified here by calling `vaultFindings`. The path form `Tasks/sk-learn-upgrade-notes.md` passes.
  - Severity: medium (false positive). Confidence: high.
- **D4: the vault-write refusal repeats the raw path.**
  - Where: `src/vault/clone.ts:320`. The `secret_refused` message includes `${edit.path}` unmasked, and `validatePath` accepts `_`, so a token-shaped path is possible.
  - Effect: the model-supplied path is echoed back to the model and into the tool error. Job-context export masks the path in the same situation.
  - Severity: low. Confidence: medium (read in code, not executed).
- **L1 (latent, not a live leak): `reply()` defaults to fallback-on.**
  - Where: `src/fallback.ts:264`, `opts?.fallback !== false`.
  - Effect: a future background caller that forgets the option would spend on the fallback. `step()` is already opt-in.
  - Fix: make `reply()` opt-in, or keep the new caller tests as the guard.
- **Documentation drift.** `docs/openrouter-activation-runbook.md:7` and `:93` still say "$150 lifetime", and :54 recommends a "<= $150, no reset" production key credit limit, while the settings table (:29-33) and the current policy are $150 per UTC month with the lifetime cap off.

## Operator evidence checklist (owner-run; no secrets printed)

Run on the host as root, only with Rai's go-ahead. These commands only read, except the key revocation and credential removal in step 4, which are the intended cleanup. Record the outputs, minus anything secret, in the vault.

1. **Smoke report exists and is intact.** `sudo ls -l /root/openrouter-smoke-20261113T050421Z.json && sudo sha256sum /root/openrouter-smoke-20261113T050421Z.json`. Then `sudo jq '{requests, ok: ([.checks[]?.ok] | all), ledger: .ledger}' …` (adjust the field names to the actual report; never `cat` key files). Keep the file; do not delete or rerun.
2. **Settlement.** From the report: every request has a `costUsd` within its reservation, nothing is reserved or uncertain, and the isolated ledger's `lifetimeUsd` equals the sum of the costs.
3. **Provider comparison**, in the dashboard and by eye: the `orbit-smoke` key shows the same number of generations, each cost matches `costUsd` to the dashboard's rounding, key usage equals `ledger.lifetimeUsd`, and the provider is one of the admitted endpoints. Write down the figures, not screenshots of keys.
4. **Smoke-key revocation.** The dashboard shows `orbit-smoke` revoked or deleted. On the host, `sudo test -e /etc/credstore/openrouter-smoke && echo PRESENT || echo ABSENT` gives `ABSENT`. Never print the file.
5. **Production ledger preserved.** `sudo stat -c '%n %s %y' /var/lib/private/orbit/openrouter-spend.json /var/lib/private/orbit/openrouter-spend.marker`. Then `curl -fsS http://<host>:<port>/status | jq -r '.ports[]|select(.port=="model")|.detail'` shows the 5/day and 150/month caps, lifetime off, and current spend.
6. **Rollback precondition.** `sudo jq -c . /opt/orbit/state/deploy.json` and `sudo tail -n 5 /opt/orbit/state/history.jsonl`: note which commit a tier-2 rollback would target, and confirm a numeric `ORBIT_OPENROUTER_TOTAL_CAP_USD` will be restored if that target is earlier than `51c1ae3`.
7. **Rollback paths.** The automatic timer rollback has drill evidence from 2026-11-08. The tier-2 `rollback_release` has none: it needs one confirmed live run, then roll-forward, recorded with commits and times. The November 9 restart in the admin ledger is not that evidence.

## Closure plan, in order

**Runner work** (code and tests in reviewed PRs; no production access):
1. Fix D1 (ChatGPT and `openaiModel` request and body timeout, with a turn deadline), with hung-fake tests.
2. Fix D2 (429 classification order) and D3 (`sk-` word-like guard), with tests. Optionally fix D4 and L1.
3. Add `docs/break-glass.md`: manual `--rollback`, stopping jobs, log and state locations, restore, and keeping the ledger. Add pinning tests for the commit-only deploy check, and the paging tests still missing in gate 2.
4. Design the functional post-deploy smoke: chat or "model limited", one read-only tool, a vault read, ingress 401, the threads store. Outside failures alert; release regressions roll back.
5. Correct the runbook's lifetime wording.

**Owner-confirmed operations** (Rai):
6. Get two independent reviews of the D1-D3 fixes, then merge and deploy.
7. Run the operator evidence checklist above. Record the results in the vault.
8. One confirmed live tier-2 `rollback_release`, then roll-forward. Record the last-known-good commit.
9. Live context-export check and filter acceptance check after deploy. Decide the "long random strings" policy.

**Ready for bounded, human-confirmed feature development** once items 1, 6, 7 and 8 have evidence. This audit alone does not reach that point.
