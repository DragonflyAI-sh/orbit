# ADR 0002: Work sessions, run links and origin tracking (session awareness slice 4)

Status: accepted for slice 4. Code: `src/work-sessions.ts` (store, attachment rules, reconciliation, derived views), the confirm route and start-up reconciliation in `src/server.ts`, origin binding in `src/agent.ts` (`Proposal.origin`, `proposals.bind`) and `src/thread-service.ts` (`origin` option), the job back-reference in `src/jobs.ts` (`Job.work`, `register(id, ttl, {work})`) and `src/job-launch.ts` (fourth `JobLauncher` argument), the `work` adapter and run/work references in `src/sessions.ts`, and the digest field in `src/session-digest.ts`. Tests: `test/work-sessions.test.ts`. Builds on ADR 0001 (slices 1-3).

## Context (read from the code before this change)

- A launch proposal (`job_launch`) lived only in memory (`proposals()` in `src/agent.ts`, 30-minute lifetime, lost on restart). Its **card** was persisted in the conversation whose turn made it (a chat thread file or an Assistant chunk), and the card's `outcome.jobId` was the only link from a conversation to a job.
- The confirm route (`POST /chat/proposals/:id/confirm`) made confirmation single use with two synchronous guards (`proposals.take()` and the card's `open -> confirmed` compare-and-set), then awaited `jobLauncher`, then settled the card. Nothing recorded the confirmation before the launch, and the job record had no reference back to the proposal or conversation. A crash between registering the job and settling the card left a confirmed card with no outcome ("no result recorded yet") and no way to find its job.
- Jobs (`jobs-cloud.json`, newest 200) are the execution record: `registered -> running -> done / blocked / failed`, with `launch.failedAt`, the runner's cloud session (`launch.sessionId`) and events.
- ADR 0001 listed "record the launching session on the job itself" and a run "producedBy" field as follow-ups. No task, research or workflow store exists.

## Decision

### Three identities, kept distinct

| Identity | Id | Owner | Created | Cardinality |
|---|---|---|---|---|
| Origin (initiating conversation) | `chat:<uuid>` or `assistant:assistant` | the chat thread store / the Assistant store (unchanged) | by the existing stores | one origin per proposal; one origin per work session |
| Work session (durable activity context) | `work:<uuid>`, ORBIT-generated | `src/work-sessions.ts` (`<state>/work-sessions.json`) | when a launch proposal is **confirmed** without an attachment | one work session has 1..n runs |
| Run (one execution) | `job:<job id>` | the job store (unchanged, authoritative for execution state) | by `jobLauncher` | one run belongs to at most one work session |

A work session id is never a chat id, never a job id and never the runner's cloud session id (`Job.launch.sessionId`). A pending proposal is none of these: nothing is recorded in the work-session store until a confirmation is accepted.

**Default: one work session per confirmed launch.** Two launches confirmed from the same conversation are two work sessions; ORBIT never groups them because they share an origin, a title, similar text or timing. A launch joins an existing work session only through an explicit **attachment** (below).

### Schema (`<state>/work-sessions.json`, version 1)

```json
{
  "v": 1,
  "sessions": [
    { "id": "work:3f6c…", "createdAt": "2026-11-15T09:00:00.000Z",
      "origin": { "session": "chat:9b1e…", "basis": "server-turn" },
      "createdBy": "<proposal id>", "lifecycle": "open" }
  ],
  "links": [
    { "proposal": "<proposal id>", "workSession": "work:3f6c…",
      "origin": { "session": "chat:9b1e…", "basis": "server-turn" },
      "attachment": "new", "confirmedAt": "2026-11-15T09:00:00.000Z",
      "launch": { "state": "launched", "job": "orbit-202611150900-ab12", "at": "2026-11-15T09:00:02.000Z" } }
  ]
}
```

- `origin` is `{session, basis: "server-turn"}` or `{session: null, basis: "unknown", why}`.
- `attachment` is `new`, `follow-up` or `retry`; a retry also has `retryOf` (the earlier job id).
- `launch.state`: `launching` (recorded before the launch began, not settled yet), `launched` (the routine accepted the fire, or the runner reported in), `failed` (the launcher recorded a failure; the job exists with `launch.failedAt`), `not-launched` (refused before any external step: no job, or a job that was never fired), `ambiguous` (a job was registered and its brief written, but whether the routine was fired is unknown). `repairedAt` and `repairBasis` appear when reconciliation set the state.
- `lifecycle` is `open` only. Nothing closes a work session in this slice; a run that ends does not close it, and ORBIT does not track whether the work's goal is finished (`GOAL_NOTE`).

Stored: ids, times, the attachment kind, the launch state and a short launcher error (at most 300 characters, the same text the card already holds). Not stored: the brief, any transcript, tool arguments or outputs, titles. The job store keeps the job; the conversation stores keep the transcript and the card.

The job record gains one optional field, written in the **same write that registers the job**: `Job.work = {proposal, workSession, origin}` (ids only). Jobs from `/jobs/launch`, review launches and every job registered before this change have no `work` field.

### Migration and compatibility

- **Additive only.** The work-session file is new; a missing file is an empty store. `Job.work`, `Proposal.origin`, the `work` session kind, the `work` field on session records, `workSession`/`workLink` on run references and `workSessions` on conversation inspection are all new optional fields. `JobLauncher`'s new fourth argument and `jobs.register`'s new third argument are optional, so existing callers are unchanged.
- **Lazy, safe load.** The file is read on first use. A file that exists but cannot be parsed, has an unknown shape or a newer `v` is reported (`status().state = "unavailable"`) and is **never overwritten**; launches that need it are refused (below) until it is fixed. Records this build does not understand are kept in the file untouched when it is rewritten.
- **No backfill.** Existing confirmed cards and jobs stay legacy/unlinked: inspection shows `workSession: null` with "no work session is inferred". Nothing is deleted from any store; the work-session file is not pruned (it grows by one small link per confirmed launch; see remaining work).
- Atomic writes: write `work-sessions.json.new`, then rename; the in-memory copy changes only after the write succeeds.

### Origin: the trust boundary

The origin is taken from **server request context only**:

1. A turn runs in a conversation the route named and the server validated (`/threads/<id>/messages` for an existing thread, owner only; `/assistant/messages`). When a tool call in that turn creates a proposal, the thread service binds the proposal to that conversation (`proposals.bind(id, origin)`) and only then stores the card there. The binding is first-wins: a proposal already bound to another conversation gets no card here.
2. `proposals.propose()` drops any `origin` an action carries, so a tool's arguments (model text) can never set it.
3. At confirmation the origin is re-derived from the two server-side records: the conversation that **stores the card** and the proposal's **binding**. If both exist and disagree the confirmation is refused (409) before anything is spent. If neither exists (the legacy `/chat` route stores no card) the origin is `unknown`; it is never inferred from titles, text, timing or proximity.
4. The request body's own fields (`origin`, anything else) are ignored for the origin. The confirming page or device does not matter: a launch proposed in a chat and confirmed from the Jobs page, another tab or the Assistant keeps the chat as its origin.

### Attachment (explicit follow-up or retry)

The confirm route accepts an optional body `{"attach": {"workSession": "work:<uuid>", "as": "follow-up" | "retry", "retryOf": "<job id>"}}`. It is the owner's confirmation request (Tailscale identity, the existing owner check and cross-site guard), not a model tool: no chat tool can request an attachment, and the page does not offer it yet (API only, see acceptance step 7). Rules, checked **before** the proposal is spent and in this order:

1. Shape: only those keys; a well-formed `work:<uuid>`; `as` is `follow-up` or `retry`; a retry names a job id. Otherwise 400.
2. **Cross-session check, before any job store read**: the work session exists, is open, and its recorded origin equals this proposal's origin. An unknown origin never matches. Otherwise 409 with one message that does not say which condition failed.
3. Retry only: `retryOf` is a run of that work session (from its own links) and the job store shows it `failed` or `blocked` (or launch-failed). A run that is registered, running or `done`, or whose state is unknown, cannot be retried (409); an unreadable job store is 503.

A refused attachment leaves the proposal open. A retry is a **new run** with its own job; the earlier job is not changed.

### Confirmation and launch (idempotent)

```mermaid
sequenceDiagram
    autonumber
    participant M as Model (tool call)
    participant TS as Thread service (turn in conversation X)
    participant P as Proposals (memory)
    participant C as Card (conversation X store)
    participant R as Confirm route (owner)
    participant W as Work-session store
    participant L as jobLauncher
    participant J as Job store
    participant G as orbit-work + Routine
    M->>P: job_launch -> propose() (origin dropped if supplied)
    TS->>P: bind(proposal, X)  (server turn context)
    TS->>C: addCard (state open)
    Note over P,C: Pending: no work session, no run
    R->>P: peek; originOf = card's conversation == binding (else 409)
    R->>W: check() store readable (else 503, proposal open)
    R->>W: plan(attach): shape, same origin, retry rules (else 4xx, proposal open)
    R->>P: take()  (sync, single use)
    R->>C: open -> confirmed (sync compare-and-set)
    R->>W: begin(): new work session (or attach) + link "launching" (one atomic write; fails -> card refused, 503, nothing sent)
    R->>L: launch(routine, brief, work link)
    L->>J: register(job, {work}) (one write, before any external step)
    L->>G: pushBrief, then fire routine
    L->>J: setLaunch (brief commit, cloud session or failedAt)
    L-->>R: result (202 / 4xx / 502) or throws
    R->>W: settle(): launched / failed / not-launched (write fails -> stays launching)
    R->>C: settle card (job id or refusal)
    Note over W,J: On start: reconcile() links still launching/ambiguous from J; never launches
```

- **Repeat clicks and concurrent requests.** `take()` and the card's compare-and-set are synchronous, so exactly one request gets past them; the others get 404/409. A repeat after the fact is answered from the card (`409`, `state`, `outcome.jobId`) plus the recorded work link (`work`), and nothing runs again. `begin()` also refuses a second link for the same proposal.
- **Restart before confirmation.** Proposals are in memory: after a restart the card shows `expired` and can't be confirmed. No link exists, so no run is shown.
- **Expiry, cancel, refusal.** No link is written for an expired or cancelled proposal, nor for a legacy-context refusal. An unknown routine or missing credential at launch time records `not-launched` (no job). A launch that fails after registration records `failed` with the job id.
- **Partial persistence failures.**
  - The work-session store is unreadable: 503 before `take()`; the proposal stays open.
  - `begin()`'s write fails: the card is settled `refused` with "Nothing was sent to a runner"; no job is registered.
  - `settle()`'s write fails: the response says so; the link stays `launching`, and the job carries its link, so the next start repairs the link from the job store.
  - The launcher throws (for example the job store write failed): the route reads the job store for that proposal (it does not retry), records what it shows (no job: `not-launched`, because registration precedes every external step; a registered job with a brief and no fire result: `ambiguous`) and answers 500 with `outcome`.
- **Ambiguous launches are never retried automatically.** "Exactly once" external launch is not claimed: if ORBIT stops after the routine accepted a fire but before the job record was updated, the job shows a brief commit and no cloud session, and the link is `ambiguous`. The existing job health (`not-started` after 10 minutes, the watch alert) and the runner's own `started` event remain the evidence; Rai can retry explicitly with `attach: {as: "retry"}` once the run is shown failed or blocked, or leave it.

### Reconciliation (authoritative lifecycle)

`work.reconcile(jobs)` runs once when the server is built (before it serves; nothing is in flight) and for a single proposal after a launcher throws. For each link in `launching` or `ambiguous` it finds the job whose `work.proposal` is that proposal (or the job id already on the link) and sets the link from the job record:

| Job store shows | Link becomes |
|---|---|
| no job for the proposal | `not-launched` (nothing was sent) |
| `launch.failedAt` | `failed` |
| a cloud session id, or any runner event | `launched` |
| a brief commit and no fire result | `ambiguous` (kept, re-examined at each start) |
| registered, no brief recorded | `not-launched` (never fired) |

It writes only link metadata in the work-session store, plus, where the card is `confirmed` and has no outcome at all, the job id (or a refusal when nothing was sent) on the card. It never launches, retries, approves, changes a job, deletes anything or touches legacy cards. With an unreadable job store it changes nothing. A start with nothing to repair does not rewrite the file.

Read paths (`sessions_list`, `session_inspect`, `session_read`, the digest) never reconcile or write: they derive an **observed** launch state from the job record on the fly (`evidence()`), and show it next to the recorded one.

### Derived activity of a work session

From its runs' native job state, at observation time (`workActivity`):

| State | Meaning |
|---|---|
| `active` | at least one run is `registered` or `running` in the job store (and not launch-failed or ambiguous) |
| `pending` | a confirmation is being launched (or ORBIT stopped before recording it) and no run is known to be active |
| `unknown` | no run is known to be active, but at least one run's state is unknown: job not in the job store (it keeps the newest 200), job store unavailable, or launch ambiguous |
| `no-active-run` | every run ended (`done`, `failed`, `blocked`, launch-failed) or never launched. Not a claim that the work is finished |

Counts (`pending`, `active`, `ended`, `notLaunched`, `unknown`) are given. Native job states are passed through unchanged; nothing is collapsed into success.

### Discovery, inspection and the digest

- **Kind `work`.** `parseSessionId` accepts `work:<lowercase uuid>` only. `sessions_list` lists work sessions (all kinds by default; `kinds: ["work"]` for just them) with the same visibility gate, keyset paging (at most 25 per page), cursors and source status as other kinds. A work session's record has a code-written title (`Work started from chat:<uuid>`, `titleSource: fixed`), `activity.state: idle` with `lastMessageAt: null` (it has no turns of its own), and `work: {origin, runs, runActivity}`.
- **`session_inspect work:<uuid>`**: `origin` (`session`, `basis`, and `state`: `found` / `not-found` / `unavailable` / `unknown`, checked read-only against the origin's own store; a missing origin keeps its recorded id), `createdBy`, `runs` (newest first, at most 20; each with `proposal`, `attachment`, `retryOf`, `launch.recorded`/`launch.observed`/`basis` and the job's `native` state), `activity`, `goal` and `transcript: unsupported`. Job store errors are not passed on as text.
- **`session_inspect chat:<uuid>` / `assistant:assistant`**: run references now merge confirmed cards with the launch links recorded for that conversation, one row per job (links also cover runs whose card sits in an archived Assistant chunk). Each row says `workSession` (or `null` with "no work session is inferred" for legacy runs, or `unknown` if the store cannot be read). `workSessions` lists the work sessions started there (at most 10, newest first, with run counts and derived activity).
- **`session_read work:<uuid>`** answers `available: false, unsupported: true` with a gap explaining there is no transcript. Nothing is fabricated.
- **Digest.** Work sessions are not digest rows (their runs already appear under the conversation they came from, so nothing is counted twice; the digest reads conversation adapters only). Each run shown carries `workSession`. Budgets are unchanged.
- **Not in Chat.** Chat turns, the legacy `/chat` route and non-owners still get no session tools and no digest; nothing about work sessions is added to a chat's context (its proposal-card lines are unchanged).

### Policy and pinned surfaces

No policy port, tool name or route was added. `src/chat-tools.ts` (pinned by `test/tier12-pin.test.ts`) is unchanged: origin binding happens in the thread service, not in the `job_launch` tool. The confirm route's only new input is the optional `attach` object, validated as above; without it the route behaves as before plus the `work` field in its answer. Visibility is `owner` for work sessions, like every source.

## Failure handling summary

| Failure | Behaviour |
|---|---|
| Work-session file unreadable / newer version | Not overwritten; `status` unavailable; launch confirmations 503 with the proposal open; discovery reports the source unavailable |
| `begin()` write fails | Card refused, 503, no job, nothing fired |
| Launcher returns an error | Link `failed` (job exists) or `not-launched` (no job); card as before |
| Launcher throws | Job store read for that proposal; link `not-launched` or `ambiguous`; 500 with `outcome`; never retried |
| `settle()` write fails | Link stays `launching`; repaired from the job record at next start |
| Crash mid-launch | Repaired at next start from the job record (table above); ambiguous fires reported, not retried |
| Job store unreadable | Activity `unknown`; reconciliation changes nothing; a retry attachment is refused (503) |
| Origin conversation missing | Recorded id kept; `origin.state: not-found` |

## Manual acceptance (not performed on a live host by this change)

On a running ORBIT, as the owner, with a model that can call tools:

1. In `/#chat`, create "Exporter", ask ORBIT to propose a job, and click Confirm. The response (browser dev tools, or the Jobs page detail) carries `work.workSession` (`work:<uuid>`), `work.origin` `chat:<uuid>` and `work.launch.state` `launched`. `<state>/work-sessions.json` has one session and one link and contains no brief text.
2. In the same chat, propose and confirm a second job: a second, different `work:` id.
3. In the Assistant, ask "what work is going on?". `sessions_list` (or the digest) shows both runs under the exporter chat, each with its `workSession`; `session_inspect` on one `work:` id shows the origin chat (`state: found`), one run with the job's own state, and `activity: active`.
4. Propose a job in the Assistant, then confirm it from the Jobs page's open-proposal list: the work link's origin is `assistant:assistant`.
5. Click Confirm on an already-confirmed card (or replay the request): 409 with the same `work.workSession`; the Jobs page shows one job.
6. Restart ORBIT and repeat step 3: same ids, same origins; the work-session file is unchanged.
7. After a job ends `failed`, propose a new job in the same chat and confirm it with `curl -X POST -H 'content-type: application/json' -d '{"attach":{"workSession":"work:<uuid>","as":"retry","retryOf":"<failed job id>"}}' https://<orbit>/chat/proposals/<id>/confirm` from the owner's device: the new job joins that work session with `retryOf`; the failed job is unchanged. The same request from a proposal made in a different chat is refused (409) and the proposal stays open.
8. Ask the Assistant to `session_read` a `work:` id: it reports that work sessions have no transcript.
9. In a chat thread, ask about other work: no digest, no session tools, no `work:` ids.

## Remaining work and limits

- **No UI for attachment.** Follow-up/retry attachment is an API body on the existing confirm route; the page does not offer it. A future card control must pass the same body and keep the same checks.
- **No close/archive of work sessions**, and no "goal finished" state; lifecycle is always `open`.
- **Steers are not linked** to work sessions (a `job_steer` card is still evidenced on its conversation only).
- **Exactly-once external launch is not claimed.** A crash after the routine accepted a fire and before `setLaunch` is recorded leaves the link `ambiguous` until the runner reports in (then it is observed as `launched`, and repaired at the next start).
- **Jobs beyond the newest 200** are not in the job store: their runs show `not-in-job-store` and work activity `unknown`.
- **The work-session file is not pruned.** It grows by about 300 bytes per confirmed launch; retention needs its own decision.
- **The legacy `/chat` route** creates work sessions with an unknown origin; they can never be attached to.
- **An unreadable work-session file blocks launch confirmations** (fail closed) until an operator fixes or moves it.
- Not verified with a real model, a real routine or on a live host.
