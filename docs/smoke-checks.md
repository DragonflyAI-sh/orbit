# Startup smoke checks

Status: **built and covered by CI tests with mocked providers.** No real provider, production host or deployment was contacted while building it. Nothing here proves that a real key, model or deployment works; it shows that, once deployed, the serving process will collect that evidence by itself.

## Why

Rai saw `photo-embeddings` shown as degraded after a deploy until the first photo search. That was checked in the code before anything changed, and the cause was confirmed:

- `embeddingsStatus` (src/embeddings.ts) returned `live` with `verifiedAt` set to the Unix epoch ("not exercised yet") until a request succeeded.
- `/status` applies the 5-minute staleness rule (`withStaleness` in src/server.ts) to every port except `model`, so it rewrote that line as `degraded: Not verified since 1970-01-01…`. The watch ignored it (epoch), so no alert was sent, but `/status` and the page showed it as degraded.
- After a success, the same rule turned the port degraded again 5 minutes later, and the watch would alert after 5 more minutes of no searches, although nothing had failed.

Nothing was broken in the adapter. What was missing was evidence: nothing exercised the capability until a user did, and an on-demand port was aged as if it were polled.

## What changed

1. **A bounded smoke runner** (`src/smoke.ts`) and **ORBIT's check registry** (`src/smoke-checks.ts`).
2. **Started by the real server.** `buildServer` starts the suite on the server's `listening` event, so the deploy path (`pull-deploy.sh` → `systemctl restart orbit` → `node src/main.ts`) runs it with no user activity. It is not awaited and never blocks listening or any request.
3. **Read-only `/status`.** `GET /status` gains a top-level `smoke` block (run state, process identity, per-check records) and an optional `check` field on each port. It only reads the records and never starts a check.
4. **`photo-embeddings` is on-demand** like `model`: `/status` no longer ages it into degraded. Its state comes from the latest real outcome (see "Ordering"). Until a request has succeeded in this process it is `degraded` with an epoch `verifiedAt` ("not verified yet in this process"), never `live` from configuration alone. The watch still ignores an epoch `verifiedAt`.
5. **The embeddings probe** goes through the same adapter instance `photos_search` uses, so its result is the port's own evidence. It sends one fixed synthetic string, with no retry.
6. **The status pill tooltip** on the page shows the port's startup check. The pill colour and the overall dot still depend on `state` alone.

## Status fields (additive)

`PortStatus.state` keeps its four values (`live`, `mock`, `degraded`, `down`) and their meanings, so every existing consumer (the page, the watch, `orbit_config_view`, the chat's "not connected" list, `pull-deploy.sh`) works unchanged. New optional fields:

```text
/status.smoke = {
  runId, process: { commit, pid, startedAt },        # the serving process; never read from disk
  state: pending | running | done,
  startedAt?, finishedAt?, durationMs?, deadlineMs,
  counts: { pending, running, passed, failed, skipped, untested, stale },
  checks: [record…]
}
port.check = record   # only for ports that have a check
record = {
  id, port, property, evidence: functional | readiness | operation | local, cost,
  state: pending | running | passed | failed | skipped | untested | stale,
  skip?: disabled | unconfigured | mock | paid | side-effects | budget | on-demand,
  reason?, detail?,                                  # sanitized, one line, ≤200 chars
  startedAt?, observedAt?,                           # attempt start; when it ended (any outcome)
  verifiedAt?,                                       # ONLY set by a pass
  durationMs?, runId,
  superseded?                                        # a newer real result decides the port's state
}
```

What each check state means:

| state | meaning |
| --- | --- |
| `pending` | The suite has not run this check yet (the process just started). |
| `running` | The check is in flight. |
| `passed` | The check observed its `property` in this process. `verifiedAt` is when. |
| `stale` | Passed, but more than 60 minutes ago. The suite runs once per process. |
| `failed` | Observed a failure: a provider error, malformed answer, timeout, or the port itself reporting `down`. |
| `untested` | No observation. Not a failure. Examples: the suite deadline passed, or a tick-observed port showed no activity in time. |
| `skipped` | Deliberately not run. `skip` says why: `disabled`, `unconfigured`, `mock`, `paid`, `side-effects`, `budget` or `on-demand`. |

## Bounds

- **Once per process.** `start()` is single-flight: a second call returns the same promise, and a finished run is not repeated. There is no manual trigger and no HTTP route, so there is nothing new to authorize or rate-limit.
- **Deadlines.** Each check has its own deadline. When it passes, the check's signal is aborted and the check is recorded `failed` (timeout); a result that arrives later is ignored. The whole suite has a 45 s deadline: checks still waiting or running then are recorded `untested`.
- **Concurrency.** At most 3 checks at once.
- **Isolation.** A check that throws, rejects or hangs affects only its own record.
- **Non-fatal.** A failed check changes no exit code, restarts nothing and does not affect deploy rollback. `pull-deploy.sh`'s readiness gate is unchanged: `/status` must serve the expected commit.
- **Sanitized.** Reasons and details are cut to one line of at most 200 characters, and key-, token-, JWT- and URL-credential-shaped text is removed before anything is stored or logged. Provider payloads, vectors, memory hits and private content are never recorded.
- **One log line** per run: `{"smoke":"done", runId, commit, durationMs, checks:[{id, state, skip?, reason?, durationMs?}]}`.

## Ordering: late probe results versus real operations

- **Inside the runner**, a check's record is final once it times out or the suite deadline passes, so a late result cannot overwrite it.
- **In the embeddings adapter**, the port's state comes from the outcome of the most recently *started* call (`stats.latest`), not the most recently finished one. If the probe starts, a real search starts after it and succeeds, and then the probe fails late, the port stays `live`. Its `check` shows `failed` with `superseded: true`. The reverse also holds: an older call that succeeds late does not hide a newer failure. A cancelled call ("aborted") is not evidence about the provider and changes nothing.

## Matrix

Every port `/status` can show, plus the other capabilities, with what (if anything) runs automatically.

| Port / capability | Property a pass asserts | Probe | Depends on | Cost / side effects | Deadline | Evidence | Skip reason when not run |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `policy` | `decide()` refuses an owner-only action for a non-owner and an action on an unknown port even for the owner, and allows the owner | In-process calls of `decide()` | none | none | 1 s | local | n/a |
| `channel` | `GET /` on the listening address returns the web page (200, text/html) | One loopback HTTP GET of `/` | the HTTP server | one local request; no identity lookup, no writes | 5 s | functional | n/a |
| `model` | the model answers a request | **none** | ChatGPT login or API key; OpenRouter fallback | paid or usage-limited generation | n/a | n/a | `paid`: needs separate authorization; `mock` when no model is configured. The port keeps reporting from real replies and its local login check. |
| `memory` | a keyword search over the vault copy answers | `memory.search("orbit", 1)`, result discarded | vault copy or writable clone | local file reads; no network, no writes | 10 s | functional | `unconfigured` when no vault copy exists |
| `notify` | a notification is delivered | **none** | web inbox, Discord webhook | would send a message | n/a | n/a | `side-effects`: receipts from real notifications are the evidence |
| `schedule` | the scheduler ticked in this process | reads `schedule.status()` until live with a `verifiedAt` from this process | the service tick | none beyond the normal tick | 15 s | operation | n/a (`untested` if no tick was seen) |
| `runs` | the run queue was pumped in this process | reads `runs.status()` the same way | the service tick | none beyond the normal tick | 15 s | operation | n/a |
| `tools` | a read-only tool answers | **none** | GitHub API for a caller-named repository | external request; no fixed safe target | n/a | n/a | `on-demand`: checked when called |
| `nodes` | device presence was read from tailscaled in this process | reads `nodes.status()`; `failed` only if the port itself reports `down` | tailscaled socket (read by the normal tick) | none beyond the normal tick | 15 s | operation | n/a |
| `jobs` | a cloud job can be launched | **none** | orbit-work credential, Routine | starts a cloud session | n/a | n/a | `side-effects`: the job API reports from real runner events |
| `watch` | the port watch ticked in this process | reads `watch.status()` | the service tick | none beyond the normal tick | 15 s | operation | n/a |
| `photo-embeddings` | the dedicated adapter returns one finite, non-zero vector of the configured dimensions for a fixed synthetic string | `embed(["orbit startup check"], signal, { attempts: 1 })` on the same adapter `photos_search` uses | `ORBIT_PHOTO_SEMANTIC=on`, the `orbit.openai-embeddings` credential, a readable budget ledger | **1 request of 19 bytes (≤19 input tokens), no retry, at most once per process**, counted against ORBIT's daily embeddings budget; no photo or private text; nothing cached | 20 s (the adapter's own request timeout is 15 s) | functional | `disabled` (flag off), `unconfigured` (no or bad credential or settings), `budget` (ledger unreadable or no room today). Never builds or activates the adapter. |
| OpenRouter fallback (inside `model`) | n/a | **none** | `ORBIT_OPENROUTER_ENABLED`, spend ledger | paid | n/a | n/a | not a separate port; paid |
| Research lane (inside `jobs` detail) | n/a | **none** | research Routine and credential | starts a cloud session | n/a | n/a | not a separate port; side effects |
| Vault writes, `orbit_config_view`, PR inspection, `orbit-ops` helpers | n/a | **none** | credentials, root helper | writes, or privileged reads on the host | n/a | n/a | not `/status` ports; writes and privileged actions are never smoke side effects |
| `/status.photos`, `/status.deploy` | n/a | **none** | local capability resolution, deploy state file | none | n/a | n/a | already local reads on every `/status`; nothing more to exercise |

`readiness`-only evidence (a local precondition, never a functional claim) is used by no check in this version. Paid and side-effectful capabilities are `skipped`, not given readiness passes, so a skipped record can never be mistaken for proof.

## The watch and the probe

The smoke suite sends nothing itself. If the embeddings probe meets an auth, quota or configuration error, the adapter halts for an hour exactly as it does after a search, and the port is `degraded` with a current `verifiedAt`. The existing watch then sends one message if that lasts 5 minutes, just as it would after a user's search hit the same error. Other probe failures with no earlier success leave `verifiedAt` at the epoch, which the watch ignores, as before.

## Test coverage

`test/smoke.test.ts`. Provider responses are deterministic mocks at the HTTP boundary of the real `openaiEmbedder`.

| Covered | Test |
| --- | --- |
| Startup without user activity runs the suite; pending → running → result | "real server: the suite starts on listening…", "startup wiring: `node src/main.ts`…" |
| Configured embeddings succeed with the synthetic fixture through the adapter; one request; budget counted; port goes from not-verified to live | "configured embeddings…" |
| Disabled, unconfigured and out-of-budget skip with no request | "embeddings disabled, unconfigured or out of budget…" |
| Timeout, auth (401), quota, rate limit (429), 5xx, malformed shape, malformed JSON, non-finite numbers, network error: one request each, honest failure kind | "embeddings provider errors…", "embeddings timeout…" |
| Independent failure isolation (throwing, hanging, failing checks) | "isolation…" |
| Duplicate start and single-flight; one call | "records start pending…" |
| Bounded concurrency and the total deadline (untested, not failed) | "bounded concurrency…" |
| Late result after the deadline is ignored | "a result that arrives after the check's deadline…" |
| `GET /status` runs no probes | "real server…" (5 extra GETs, still 1 provider request) |
| Evidence tied to the serving process and commit (pid, ORBIT_COMMIT, runId; a new process starts pending) | "evidence is tied to the serving process…", "startup wiring…" |
| Newer real-operation result wins over a late probe, in both directions | "ordering: …" (two tests) |
| No key or token in records, logs or `/status` | "sanitize…", "embeddings provider errors…", "real server…" |
| Status compatibility: four states only; no `smoke` or `check` without a runner; page dot unchanged | "real server…", "real server without a smoke runner…", "the status pill…" |
| On-demand ports are not aged; other ports keep the 5-minute rule | "photo-embeddings and model are on-demand…" |

**Not tested, on purpose:**

- A real embeddings request, real key, real billing path or real model output.
- Real tailscaled, a real vault, a real ChatGPT login, Discord, GitHub.
- The production deploy itself (`pull-deploy.sh` is unchanged and its tests still pass).
- Functional checks of model generation, notification delivery, job launches, tool calls, vault writes and ops helpers. These are never automated here and need separate authorization.

## Operator steps

None are required. The suite ships with the code and runs on the next deploy's restart. No unit, environment, credential or script change is needed, and nothing was done on any server.

## Deployment acceptance checklist

After the next deploy, on the host:

- [ ] `curl -s localhost:8790/status | jq '.commit, .smoke.process, .smoke.state'`: the commit is the deployed one, `smoke.process.commit` matches it, and within about a minute `state` is `done`.
- [ ] `jq '.smoke.checks[] | {id, state, skip, reason}'`: `policy` and `channel` passed; `schedule`, `runs` and `watch` passed; `nodes` passed (or failed with a tailscaled reason worth looking at); `model`, `notify`, `jobs` and `tools` skipped with their reasons.
- [ ] If `ORBIT_PHOTO_SEMANTIC=on` with the credential installed: `photo-embeddings` check `passed`, the port `live` with a `verifiedAt` from this process, and the daily count in the port detail up by exactly 1 request. If it `failed`, the reason says auth, quota, config, rate-limit, server, timeout, network or malformed. If semantic search is off: `skipped` / `disabled`, and no `photo-embeddings` port.
- [ ] `journalctl -u orbit | grep '"smoke":"done"'` shows exactly one line for this start, with no key or token in it.
- [ ] Reload `/status` a few times: the embeddings daily count does not grow (`/status` never probes).
- [ ] Restart again: `smoke.process.pid` and `startedAt` change, records start `pending`, and nothing from the earlier process is shown as verified.
