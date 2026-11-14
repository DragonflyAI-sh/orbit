# Chat tool execution deadlines

Acceptance job `orbit-202611140238-96x8` (`docs/acceptance-2026-11-14.md`, row 3c) found that a chat tool whose `run()` never settles
held its thread `busy` until ORBIT restarted. The model request deadlines (`docs/model-request-deadlines.md`) cover model requests,
not tools. This change bounds every tool call in a chat turn and says exactly what is known about a call that was cut off.

## Reproduced failure

At `47cf112` (before this change), through the real HTTP route `POST /threads/:id/messages` with a scripted model and a tool that never
settles: the request had not returned after 1.5 s and the thread was still busy. Nothing would ever have ended it. The same check is now
the first HTTP test in `test/tool-deadline.test.ts`.

## Bound

Implemented in `runChat` (`src/agent.ts`), so it applies to both chat paths: the thread turn (`src/thread-service.ts`) and the legacy
`/chat` route.

| Constant | Value | Meaning |
| --- | --- | --- |
| `TOOL_DEADLINE_MS` | 180 s | How long ORBIT waits for one tool call. |
| `TOOL_ABORT_GRACE_MS` | 2 s | After the deadline, the call is asked to stop. ORBIT then waits this long to see whether it did. |
| `ops_propose_os_updates` (`deadlineMs`) | `PLAN_WAIT_MS` + 60 s (19 min) | This tool already waits for the helper's update plan for up to `PLAN_WAIT_MS` (18 min), and documents that wait. Its deadline sits above it, so its behaviour does not change. |

Why 180 s: it is above every bound the tools apply themselves, so a tool that is slow but still working is not cut short. Those bounds
are the vault clone's git fetch and push (120 s each), memory refresh (30 s) and the ops helper socket (8 s). It is also well below the
600 s that one model request may take. A tool can declare its own `deadlineMs` when it legitimately needs longer, as the OS-update
proposal does.

Tests inject short values (tens of milliseconds) through `runChat({ toolDeadlineMs, abortGraceMs })`, `threadService({ ... })` and
`buildServer({ ... })`. Production passes neither and gets the constants.

## What happens when a call is cut off

1. Each call runs under its own `AbortController`. Its signal reaches the tool as `run(args, { signal })`. When the deadline passes or
   the turn is cancelled, ORBIT aborts that signal (**abort requested**). Where the operation supports it, the abort reaches it:
   `github_repo_status` passes the signal to its GitHub requests. Most tools take no signal yet. For them the abort is only a request,
   and the call keeps running until it ends by itself.
2. ORBIT waits up to the grace period:
   - The call **ended with an error**: `abort: "confirmed"`. It stopped.
   - The call **completed**: its real result is recorded with `interrupted` set, because the outcome is known.
   - The call **had not ended**: `abort: "requested"`. It may still be running.
3. The call is stored once on the assistant message, with `interrupted` (`timeout` or `cancelled`), `abort`, and, for a tool that may
   have an effect, `outcomeUnknown: true`. The function output the model sees next turn says `outcome: "unknown"` (or `no_result` for a
   read-only tool) and `retried: false`, with the instruction not to call it again until its effect has been checked and Rai asks again.
4. **The turn ends there, exactly once.** No later tool call in the same round starts. Their number is named in the message. The model is
   not asked again. The assistant message is marked `error` with ORBIT's own text, which says what is known.
5. The thread is freed. The busy flag belongs to the turn that took it (a token from `threads.tryBegin`), and only that token frees it.
   So an old turn can never free a newer one. The view returned to the caller is taken after the flag is freed, so the HTTP response
   already says `busy: false`.
6. The cut-off call's promise was observed from the start. A late success or failure therefore never becomes an unhandled rejection,
   and it is only reported to `onLateTool`. By default that is one `chat_tool_late` log line with the thread id, tool name and ok/failed.
   **A late result writes nothing to the thread**: no call, no message, no busy change, no model step, no further tool. Every timer and
   abort listener is removed on every path.

### Read-only and possibly-effectful tools

A tool counts as read-only only if it is marked `readOnly: true`. These are marked: the memory reads, `github_repo_status`,
`orbit_config_view`, the `ops_*` status and log reads, `ops_admin_operations`, `ops_sys_operations`, `jobs_list`, `job_status`,
`vault_policy` and the `pr_*` inspection tools. Every other tool is treated as possibly having an effect. That covers `notify`, the
vault writes, every proposal tool, `job_steer`, `job_launch` and `ops_sys_cancel_reboot`, and any tool added later without the mark.
For those tools a cut-off is reported as:

> Its outcome is UNKNOWN: it may still complete, so it is not reported as failed. ORBIT did not retry it and will not repeat it on its
> own; check the record it would change before asking for it again.

The page shows such a call as `? name(...) [outcome unknown, not retried]`, never `✗ ... failed`. The thread digest used for compaction
and the rolling note says `outcome unknown (not retried)`.

### Side-effect semantics (what a timeout does NOT mean)

- A timeout does not establish that a write or external action stopped. ORBIT never claims rollback or cancellation of work that was
  already dispatched.
- Nothing is retried or replayed automatically, by `runChat`, the thread service, or the next turn.
- Atomic write and commit boundaries, per-resource serialization and approvals are unchanged. The vault clone's write queue
  (`src/vault/clone.ts`, `serial`) is not touched: a vault write that was cut off keeps its place. A later write waits behind it instead
  of overlapping it, and it lands once, as a single commit with its Log line. The test holds a real push in a temporary repository's
  `pre-receive` hook to show this. Proposal tools still only propose. Confirm and Cancel, digests and single-use claims are unchanged.
- The context for reconciliation is the stored call (name, arguments, `interrupted`, `abort`, `outcomeUnknown`) and the authoritative
  records the tool writes to (vault commits and Log lines, jobs, the ops ledgers, proposals).

## Cancellation

`runChat({ signal })` and `threadService.turn(id, text, prep, { signal })` take a cancellation signal. It aborts the model request in
flight (through the existing `ReplyOptions.signal`) and asks a running tool call to stop (as above, `interrupted: "cancelled"`). After
it, nothing new starts: no new tool call and no new model request. **No route passes a signal yet.** There is no user-facing Stop
button, and a closed browser connection does not cancel a turn, as before. That is a separate feature decision.

## Tests

`test/tool-deadline.test.ts` uses scripted models, synthetic tools, in-memory or temporary thread stores and a temporary bare git
repository. Nothing touches a provider, the real vault or a credential. The cases are:

- A never-resolving read-only tool through `POST /threads/:id/messages`: 502 with the exact text, `busy: false` in the response, abort
  propagated, one model request, and the next message answers.
- The legacy `/chat` route is bounded too.
- Cooperative abort: `abort: "confirmed"`.
- An abort-ignoring late resolve and a late reject: logged only, the thread is byte-identical, no model restart, the next turn works,
  and no unhandled rejection anywhere in the file.
- A late completion of the old turn while a newer turn's model request is in flight: the newer turn keeps the thread, nothing is
  appended, and it completes normally.
- The busy-token rules.
- Cancellation of a running tool, and a turn that was already cancelled: no request is made.
- A multi-tool round that stops at the call that timed out.
- A possibly-effectful tool: run once, `outcome: "unknown"`, `retried: false`, not called a model failure, and not re-run in the next
  turn.
- A real vault write held mid-push: outcome unknown, the thread is freed, a second write is serialized behind it, and it lands exactly
  once.
- Confirmation still required after a timed-out turn.
- Page and digest labels.

## Remaining limitations

- Most tools take no abort signal, so `abort: "requested"` is the usual result. Their work continues in the background until it ends by
  itself.
- A proposal tool that completes after its turn ended (for example a tier 3 proposal that waited on the helper) leaves an open proposal
  in `GET /chat/proposals` with no card in the thread. It still needs Rai's click to do anything.
- A vault write that is cut off while it waits in the clone's queue has not started yet when the turn ends. It will still run when its
  turn in the queue comes. Its outcome is reported as unknown. ORBIT does not withdraw queued writes.
- The page still tags the whole reply `error:`. The message text and the per-call labels say "outcome unknown".
- There is no whole-turn deadline beyond model and tool bounds. A turn is bounded by at most six model steps, each bounded by the model
  request deadlines, and at most five rounds of tool calls, each call bounded as above.
- None of this was exercised against production.
