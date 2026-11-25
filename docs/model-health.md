# Model health and the post-deploy model smoke check

Status: **built and covered by CI tests with scripted models.** No real ChatGPT login, OpenRouter key or deployment was contacted while building it.

## Why

After a deploy, ORBIT sometimes sent "ORBIT part "model" is live again" while ChatGPT was still usage-limited. The next real call hit the same limit, fell back again, and the watch later alerted again: a false "restored" notice and needless recovery churn.

The cause, checked in the code:

- The ChatGPT port keeps its limit record in memory (`src/chatgpt.ts`, `limited`), and so does the OpenRouter fallback wrapper (`src/fallback.ts`, `limit`). A restart drops both.
- Before any call, the new process's ChatGPT port reports from its local login check (`readiness()`): `live`, with `verifiedAt` set to now. That says the saved login looks usable, not that the model answers.
- The watch (`src/watch.ts`) keeps its alert record across restarts (`<state>/watch.json`). On its first tick it saw `live` for a port it had alerted on and sent the recovery notice.

## What changed

1. **Model health state** (`src/model-health.ts`, `modelHealthTracker`): `healthy`, `fallback` or `unknown`, persisted in `<state>/model-health.json` and shown on `/status` as `ports[model].health`.
   - `healthy`: the primary model answered.
   - `fallback`: the primary returned a usage or rate limit, or a reply came from the OpenRouter fallback.
   - `unknown`: no evidence yet (a fresh install).
   - Other failures (auth, timeout, network, overload) say nothing about the limit and leave the state as it was.
   - A call that started earlier never overwrites the result of a call that started later.
2. **Every real call updates it.** `observeModel()` wraps the model port every caller uses (chat, threads, runs, summaries). It changes no result or error and keeps every other function of the port (sign-in routes, images, maintain).
3. **The post-deploy model smoke check** (`modelSmokeCheck`) replaces the `model` entry that was always skipped in the startup smoke suite (`docs/smoke-checks.md`). It runs once per process, when the server starts listening, with no user activity.
   - **One call** to the model port as built (ChatGPT, or the OpenRouter fallback wrapper around it). The prompt is a fixed line ("ORBIT health check. Reply with the single word: ok"). There are no tools, no history and no notes, and nothing is retried.
   - **Never the paid fallback.** The call passes `fallback: false`. While the primary is limited, the wrapper refuses at once and sends nothing to OpenRouter.
   - **Bounded.** The call is abandoned after 8 s (`MODEL_SMOKE_TIMEOUT_MS`), and the runner's backstop is 10 s. It never blocks the deploy: `pull-deploy.sh` still waits only for `/status` to serve the new commit.
   - **Invisible.** The answer is not stored, shown or added to any thread, run or notification.
   - **Real evidence for the port too.** The call goes through the port's own `reply()`, so a limit is recorded there just as after a real call. The port then reports the limit, not the stale local `live`.
   - **Outcome.** A pass sets `healthy`. A limit sets `fallback`. Anything else keeps the state and records the kind (`timeout`, `auth`, ...).
   - **Skipped** when the model is a mock, or is already `down` before any call (for example, signed out).
4. **The watch checks it before "model is live again".** `watcher(..., { modelRecovery })` holds that one notice until `confirmsRecovery()` is true. That needs the state to be `healthy` with evidence from this process. A `healthy` written by the previous process does not count.
   - While the notice is held, the alert record is kept, so a real recovery later is still reported exactly once.
   - Every other port, and every alert (not recovery) message, works as before.

## Ordering after a deploy

```text
restart → tick 1 (watch: model "live" from the local check, recovery NOT confirmed → held, logged once)
        → server listening → smoke suite → model smoke call
             primary answers   → health healthy  → next watch tick: "model is live again" (once)
             usage/rate limit  → health fallback → port reports the limit; no recovery notice
             timeout / other   → health unchanged → the notice waits for a real primary answer
```

## Logs

One JSON line each, with no prompt text, answer, token or key:

- `{"model_smoke":"started", model, timeoutMs}`
- `{"model_smoke":"passed"|"failed"|"skipped", model, latencyMs?, kind?, reason?, health}`. `kind` is one of `usage_limit`, `rate_limit`, `timeout`, `auth`, `overloaded`, `incomplete`, `failed`, `cancelled`, `fallback-answered` or `error`. `reason` is sanitized and at most 200 characters.
- `{"model_health": <new state>, was, source, model?, reason?}`, only when the state changes.
- `{"watch":"model recovery notice held: ..."}`, once per hold.

## Status fields (additive)

```text
ports[model].health = {
  state: healthy | fallback | unknown,
  since, at, source: smoke | call | none, model?, reason?,
  smoke?: { state: pending | passed | failed | skipped, at, model?, latencyMs?, kind?, reason? }
}
```

`state` keeps its four values and meanings. `pull-deploy.sh` and other consumers are unchanged.

## How `/status` reports fallback

When `health.state` is `fallback`, `/status` treats ORBIT as **in fallback**: working but degraded, not unknown (`src/model-availability.ts`, applied by `/status` to the model entry on every request, so a new smoke check or call result shows at the next `/status` with no restart):

- ChatGPT's limit is recorded by the port and the OpenRouter fallback is usable but not called yet: `state` `degraded`, `availability` `{ available: true, via: fallback }`, reason "ChatGPT is at its usage limit; using the OpenRouter fallback (<model>) until <time>: it has not been called since the limit began, so it is not confirmed yet." (Before, this was `available: null`, shown grey as "Status unknown: model".)
- The limit is not recorded by the port in this process yet (right after a deploy, before the smoke check answers, while ChatGPT's local login check says `live`): `state` `degraded` (the detail starts "In fallback (model health): ..."), `availability` `{ available: true, via: primary }`, with the tracker's reason and that the next call tries ChatGPT first.
- A fallback verdict of `true` or `false` from the wrapper is kept, and `down` or `mock` still wins: ChatGPT limited with the fallback failing or unusable is red, since no model can reply.
- `health.state` `unknown` (nothing recorded yet) changes nothing.

The page's overall indicator reads that availability, so it shows amber, "Degraded: fallback model", with the reason in the detail.

## Cost

One request per process start to the primary model, using ChatGPT subscription usage. It never goes to the paid fallback. That is one request per deploy or restart.

## Tests

`test/model-health.test.ts`. Every model is scripted, and nothing contacts a provider. It covers:

- the tracker's ordering and persistence, and that a restart needs fresh evidence;
- the observer (healthy, limit, fallback answer, other errors, mock, step, extra functions);
- the smoke check: one call with the fixed prompt and `fallback: false`; pass, limit, timeout and skip;
- the smoke check through the real OpenRouter fallback wrapper, which sends no paid request while limited;
- the registry wiring;
- three post-deploy watch scenarios: still limited (no false notice), really recovered (one notice), smoke timeout (waits for a real answer);
- that other ports are unaffected;
- `/status` while in fallback: the model entry is `degraded` with the clear reason and the page's overall status is degraded, not unknown (fallback not called yet, and after a deploy before and after the smoke check, with the result visible at the next `/status`); `unknown` only when nothing is recorded; ChatGPT limited with the fallback failing stays red.

Removing the watch gate makes the three post-deploy scenarios fail.

**Not tested:** a real ChatGPT or OpenRouter call, a real deploy, or real usage accounting.

## Operator steps

None. The check ships with the code and runs on the next deploy's restart. To verify, after the next deploy:

- `journalctl -u orbit | grep model_smoke` shows `started`, then one result line with the model and latency.
- `curl -s localhost:8790/status | jq '.ports[] | select(.port=="model") | .health'` shows the state, and `.smoke.checks[] | select(.id=="model")` shows the check.
