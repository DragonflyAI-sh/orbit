# Model request deadlines (audit D1)

The readiness audit (`docs/readiness-audit-2026-11-13.md`, defect D1) found that ChatGPT inference and the OpenAI API-key path had no
timeout. A request that never got headers, stalled mid-stream, or streamed forever held the turn, and with it the thread's busy flag,
indefinitely. Every request on those paths now has a bounded lifetime. OpenRouter already had its own bound (`src/openrouter.ts`,
`ORBIT_OPENROUTER_TIMEOUT_MS`), which is unchanged.

## Bounds

Implemented in `src/model-deadline.ts`. One request has three bounds, all enforced by aborting that request's own `AbortController`,
so the connection and the body stream are released, not only abandoned:

| Bound | Meaning | ChatGPT (`CHATGPT_BOUNDS`) | OpenAI API key (`OPENAI_BOUNDS`) |
| --- | --- | --- | --- |
| `headersMs` | from sending the request until response headers arrive | 120 s | 600 s |
| `idleMs` | longest gap between body chunks, including the wait for the first one | 300 s | 300 s |
| `totalMs` | the whole request, headers and body together | 600 s | 600 s |

Why these values:
- ChatGPT answers with a server-sent event stream; headers normally arrive at once and events keep coming while the model works.
  `idleMs` is 300 s, the stream idle timeout Codex CLI uses against the same backend, so a long silent reasoning phase is not cut short.
  `totalMs` caps a stream that keeps sending data but never finishes.
- The OpenAI API-key path is not streamed: headers come only when the whole answer is ready, so its header wait is the total bound.

The bounds are constants, not configuration. Tests pass short bounds and counted timers through `chatgptModel(..., { bounds, timers })`
and `openaiModel(..., { bounds, timers })`.

Scope of one bound set: each HTTP call. On ChatGPT that is the inference call, and separately the single retry after a 401 and the single
retry after an overload that came before any output (both existing behaviour). Token renewal keeps its own 20 s bound. So one model step
normally ends within 600 s of a stall, and in the theoretical worst case (401 retry and overload retry each also stalling) within about
four times that. `runChat` makes at most six model steps per turn.

## What happens on a timeout

- The request is aborted, the body reader is cancelled, and every timer and listener is cleared on every exit (success, HTTP error,
  stream error, timeout, cancellation).
- ChatGPT reports a `ProviderError` of kind `"timeout"` (code `timeout_headers`, `timeout_idle` or `timeout_total`). The OpenAI API-key
  path reports an `Error` with the same wording. The message is ORBIT's own text and contains no provider content, for example:
  `ChatGPT stopped sending its response: no data for 300 s, so ORBIT abandoned the request. Nothing from it was used and no tool call from it was run.`
- Partial stream text is never parsed, so a tool call that arrived before the stall is never run.
- A timeout is not a usage or rate limit: it does not pause model calls, and the paid OpenRouter fallback (which admits only
  `usage_limit` and `rate_limit`) never answers it. The model port shows `down` with "Last call failed: …" until a later call succeeds.
- An HTTP error response whose body stalls is still classified by its status (for example a 429 stays a rate limit), as before.
- In a thread, the turn ends with the assistant message marked `error` with that text, the user's message stays, the busy flag is cleared
  by the existing `finally`, and the next message in the same thread runs normally. Nothing is retried automatically.

## Caller cancellation

`ReplyOptions.signal` (on `reply` and `step`) cancels a request. It is honoured by `chatgptModel`, `openaiModel`, and passed through
`fallbackModel` to the primary. A cancellation is reported as kind `"cancelled"` (OpenAI path: `RequestCancelled`), never as a timeout
or a limit, and is not recorded as a model failure on the port. An already-cancelled signal sends nothing.

## Tests

`test/model-deadline.test.ts` (all offline, fake fetchers, bounds of tens of milliseconds, counted timers):
no headers, a stalled body, an endless stream ended by the total bound, a stalled 429 body, normal text, tool and HTTP-error answers,
caller cancellation (mid-stream and before sending), listener cleanup, no paid fallback on a timeout, the signal passing through the
fallback wrapper, a thread turn that stalls after a partial tool call (no tool run, thread freed, second turn answers, no duplicate
messages), and the same hang cases on `openaiModel`.

## Remaining limitations

- No caller passes a cancellation signal today; there is no user-facing "stop" for a turn. The bounds apply regardless.
- `runChat` has no whole-turn deadline. Tool execution inside a turn is now bounded separately: see `docs/tool-deadlines.md`.
- The overload-retry wait (`OVERLOAD_RETRY_MS`) is not interrupted by a cancellation; the cancellation is checked when it ends.
- The paid OpenRouter fallback does not take the caller's signal; it keeps its own `ORBIT_OPENROUTER_TIMEOUT_MS` bound.
- ChatGPT response size is not capped (unlike OpenRouter's `readBounded`); the total bound limits how long it can grow.
- (Fixed with the tool deadlines, `docs/tool-deadlines.md`.) `turn()` used to return a thread view taken before its `finally` cleared
  the busy flag, so that view said `busy: true`; it is now taken after the flag is freed.
- None of this was exercised against the live provider.
