# ADR 0003: Supervised tasks, first slice

Status: accepted for the first slice. Background autonomy (wakeups, schedules, retries) is **not** part of it and stays off until budgets and activation are agreed (see "Next phase").

Code: `src/tasks.ts` (record, store, derived views), `src/task-supervisor.ts` (the Assistant's task tools, the task's own tools, bounded turns, the activity block), `src/task-vault.ts` (status lines through the vault write pipeline), wiring in `src/server.ts` (routes, `prepare`/`allowAgent`, the task-session branch of the thread route, restart recovery), `src/main.ts` (`<state>/tasks.json`, the vault adapter), `src/policy.ts` (the `tasks` port), and two hooks in the turn code: `src/thread-service.ts` (`TurnPrep.maxRounds`, `fallback`, `author`) and `src/threads.ts` (`ThreadMessage.author`). Page: `src/web/index.html` (task banner in a task's session, supervisor-authored messages labeled). Tests: `test/tasks.test.ts` (store, derived status, evidence gate, vault sync with a fake port and through the real pipeline on a temporary bare repository), `test/task-supervisor.test.ts` (real server: acceptance walkthrough, authorization, concurrency and pause, duplicates, restart, and the page in Chromium).

Builds on ADR 0001 (session registry) and ADR 0002 (work sessions, run links, origin tracking). Nothing in either is removed or changed in meaning.

## Context: what exists (read from the code before this change)

| Area | What is there | Extension point used |
|---|---|---|
| Session registry | `src/sessions.ts`: read-only adapters over the Assistant chunk store, chat threads (`chat:<uuid>`) and work sessions (`work:<uuid>`). `task`, `research`, `workflow` are reserved kinds with no source. Session tools are owner-only and Assistant-only (`allowAgent(scope)`). | None changed. A task's session is an ordinary chat thread, so the registry, `session_read` and the digest already see it as `chat:<uuid>`. The reserved `task` session kind stays reserved: task ids are `task-<uuid>` (no colon), so they can never be mistaken for session ids. |
| Turn execution | `src/thread-service.ts` `turn()`: takes the thread's single-turn lock (`tryBegin`), appends the user message, runs `runChat` (tool dispatch, deadlines, result budget, round ceiling, no-progress guard, protocol screening), stores every call as it completes, binds proposals to the turn's origin, frees the lock. The Assistant uses the same code over its chunk store. | A third `threadService` instance (`tsvc`) over the same thread store, for task sessions: same lock, same tools and card code, the task model, no rolling recent-context note. `TurnPrep` gained three optional fields (`maxRounds`, `fallback`, `author`); defaults are exactly the old behaviour. |
| Jobs and proposals | `src/agent.ts` `proposals()` (in memory, 30 min, single use via `take()` plus the card's compare-and-set), `POST /chat/proposals/:id/confirm` (owner identity, cross-site guard, origin check, work link before launch). | Reused unchanged. A task never proposes; the Assistant proposes with its existing `job_launch` tool and links that proposal to the task's request. Only Rai's Confirm launches. The request's confirmed/running/result state is derived from the card and the job store. |
| Persistence | Small JSON files under `<state>`, written atomically (`.new` + rename) before memory changes; unreadable or newer files are reported and never overwritten (`src/work-sessions.ts`). | Same pattern: `<state>/tasks.json`, version 1. |
| Memory and vault | `memory_search`/`memory_read` on the vault clone; vault writes through `src/vault/clone.ts` (`write([edits], mode, meta)`): fetch, path rules, symlink refusal, secret check, AGENTS.md classification, one commit plus Log line, push without force, remote verification. | Task status lines are one `append_section` edit through that same `write()` (direct mode). A `needs_confirmation` classification is reported as `blocked`; no proposal is made. |
| UI routing | One page; Sessions at `/sessions/<thread uuid>`, rendered from `GET /threads/:id`. | `GET /threads/:id` (and the message route) carry `task` for a task's session; the page shows one banner with Rai's controls. The link a task tool returns is that same `/sessions/<uuid>` address. |
| Policy | `src/policy.ts` fail-closed, owner ports. | New owner port `tasks`. |

## Decision

### Four things that stay distinct

| Thing | Id | Store | What it is not |
|---|---|---|---|
| Task | `task-<uuid>` | `<state>/tasks.json` | not a conversation, not a run, not "done" because anyone says so |
| Task session | `chat:<uuid>` (link `/sessions/<uuid>`) | the chat thread store, unchanged | not the task record; it holds the conversation only |
| Run | `job:<id>` | the job store, unchanged | a job ending (even `done`) is the run's result, never the task's completion |
| Completion | `lifecycle: done` on the task | `<state>/tasks.json` | reachable only by Rai, and only with acceptance evidence |

### The task record (`src/tasks.ts`, file version 1)

| Field | Meaning |
|---|---|
| `id`, `createdAt`, `updatedAt`, `rev` | Stable identity. `rev` is bumped by every content change and is the basis of stale-mutation checks. |
| `title`, `goal`, `scope`, `acceptance[]` (`ac1`..`ac10`) | What the work is and what "done" means. |
| `project` | A free reference (repository or vault project note path); not resolved in this slice. |
| `lifecycle`, `lifecycleHistory[]` | `active`, `paused`, `done`, `cancelled`, with who changed it, when and why. `done` and `cancelled` are terminal. |
| `nextAction` | The next concrete step, with who set it. |
| `blocker` (derived) | The newest pending `blocker` request. |
| `followUp` | `{at, note, by, autonomous: "disabled"}`: intent only (below). |
| `session.thread` | The task session's thread id. |
| `instructions[]` | Versioned, append-only: `{v, at, text, by}`. Earlier versions are kept. |
| `requests[]` | Task-to-supervisor requests (below). |
| `evidence[]` | `{id, criterion, kind, ref, note, by}`: `job`, `commit`, `pull-request`, `url`, `vault-note`, `note`. |
| `turns[]`, `turnSeq` | The last 50 turn records; numbers are never reused. Each records its trigger, the instruction version it saw, the model port's `impl`, its messages, tool-call count, outcome. |
| `vault` | Linked note, heading, and sync state (below). |
| `seen[]` | The last 50 owner request ids, for idempotent POSTs. |

Text is masked for credential shapes (the conversation stores' filter), stripped of control and bidirectional characters, and capped. Records this build cannot parse are kept untouched in the file.

### Provenance

Filled by the server from the route or turn, never from model text: `human` (`task-panel`, `sessions-ui`, `api`), `assistant` (the Assistant's tool call, with the user message and reply it belongs to, from the turn identity `runChat` passes to tools), `task` (the task's own turn `n`), `orbit` (recovery). A steer the Assistant relays is labeled as the Assistant's (model-written), not Rai's. Rai's own steers come from the task banner (`POST /tasks/:id/steer`) or from writing in the task session.

### Requests: durable, deduplicated, explicit

A task asks its supervisor with `task_request {kind: clarification | blocker | job, text, brief?, routine?}`.

- **Deduplication.** The key is a hash of the kind, the whitespace- and case-normalized text, and (job) the brief. An identical request that exists in any state but `withdrawn` is returned with `duplicate: true` and counted (`duplicates`); nothing is filed twice. At most 5 requests may wait at once (429 beyond), 100 per task in total.
- **Recorded states** (what the supervisor did): `pending`, `answered`, `proposed`, `declined`, `withdrawn`.
- **Explicit status** (derived at observation time, never stored): `pending` → `awaiting-confirmation` (a launch card waits for Rai) → `confirmed` (Rai confirmed; the card names the job) → `running` (the job store says registered/running) → `result` (the job store says done/failed/blocked: the run's result, **not** task completion); or `not-confirmed` (the card expired, was cancelled or refused; a new proposal may then be linked, the old one is kept in `previous`), `answered`, `declined`, `withdrawn`, `unknown`.
- **Linking** (`task_respond action: link_proposal`) needs an **open `job_launch` proposal bound to the Assistant** (`proposals.peek`, `origin === "assistant:assistant"`): a made-up id, a used one, or one from a chat thread is refused. One proposal answers one request. Linking launches nothing.

Repeated runner callbacks, repeated confirmations and repeated owner POSTs are idempotent: request status is derived (nothing is stored per callback), the confirm route answers a repeat from the card (unchanged), and owner routes accept a `requestId`.

### Evidence and completion

| Evidence status | When | Counts toward completion |
|---|---|---|
| `attested` | added by Rai (`POST /tasks/:id/evidence`) | yes |
| `verified` | kind `job`, the job store shows it `done`, **and** one of this task's own requests produced it (its linked proposal's card names that job), so the chain is ORBIT's record | yes |
| `not-verified` | such a job, not `done` (or unknown) | no |
| `claimed` | anything a model added (the task or the Assistant), including a job that no request of this task produced | no |

`POST /tasks/:id/complete` (Rai only, with the current rev) is refused unless every criterion has attested or verified evidence and no turn is running. There is no tool that completes a task; the store refuses non-human completion as well (tested). A model saying "done", "APPROVED", or a job ending changes nothing.

### Turns

| | Supervised turn | Interactive turn |
|---|---|---|
| Started by | the Assistant (`task_run_turn`) or Rai (banner, `POST /tasks/:id/turn`); never by a timer | Rai writing in the task session |
| Prompt | a message authored `orbit-supervisor` (stored and shown as "ORBIT task supervisor", never as Rai) | Rai's message, also recorded as a new instruction version from Rai (`sessions-ui`) |
| Tools | read-only chat tools plus the task's own (`task_request`, `task_add_evidence`, `task_set_next_action`); proposal and effect tools withheld and listed in the limits | the owner's chat tools as in any chat thread (proposals still need Rai's click) plus the task's own |
| Bounds | at most `TASK_TURN_MAX_ROUNDS` (6) tool rounds; the paid fallback is off | the usual chat bounds |
| Context | the task record as an `<orbit-data name="task">` block (instructions labeled with who wrote them), memory excerpts and devices as in any chat; **no** session tools, session digest, task-activity block or rolling recent-context note | the same, plus "Rai is writing in this task's session now" |

A paused task's session answers Rai with the task's context read-only and no task tools (his message is still recorded as an instruction); a done or cancelled task's session answers as an ordinary chat and records nothing.

The task model is a port: `Deps.taskModel` (absent: the same model port as every other turn; `main.ts` sets none). Each turn records the port's `impl`. Which model is best for task turns is left open (no routing logic, no hard-coded model).

### Concurrency and stale state

- A task's turns are serialized twice: the task record allows one `running` turn, and the thread lock allows one reply. A second start is 409.
- At most `taskTurnsMax` (default 2) supervised turns run at once across tasks; beyond that 429, and **nothing is queued**.
- Every mutation for Rai or the Assistant carries the rev it was based on; a stale rev is 409 and changes nothing (two concurrent steers from one view: exactly one wins, tested). The task's own turn writes are not rev-checked (they are its own record) but are refused once the task is no longer active.
- A steer that arrives while a turn runs is recorded at once; the running turn does not see it (`instructionsSeen`), and the supervisor is told (`notSeenFromRai`).
- Pause and cancel abort a running supervised turn (its model request or tool call is cancelled; what already happened stays on record).

### What the supervisor sees

Each owner Assistant turn gets an `<orbit-data name="task-activity">` block beside the session digest: open tasks (at most 8, those with a running turn, waiting requests, Rai's unseen instructions or a due follow-up first), metadata only (ids, rev, title, lifecycle, session link, request ids and kinds, counts, last turn, completion readiness, vault sync state). Request text and replies stay behind `task_inspect`, whose answers carry a notice that task-written text is untrusted data. Built per turn, never stored.

### Isolation

- A task turn receives no other conversation's content: no session tools, no session digest, no task-activity block, no rolling note; a task session is never fed into the rolling note either (archive route).
- The Assistant may read a task's session with its existing `session_read` (it is a chat thread): the supervisor reading its subordinate is the intended direction.
- Assistant answers to a task's request reach that task's next turn only, labeled as the Assistant's.

### Vault sync (`src/task-vault.ts`)

- A task may link one existing note under `Projects/` or `Tasks/` and a heading that already exists in it. `task_vault_sync` (or `POST /tasks/:id/sync`) appends one status line under that heading: lifecycle, next action, accepted criteria count, waiting requests, and a key `(orbit-task <id> #<hash>)`.
- **Through the existing pipeline only** (`clone.write`, direct mode): fetch, path and symlink rules, secret check, AGENTS.md classification, one commit with the Log line, push without force, remote verification.
- **Respecting the vault's task schema**: this slice does not read or change it. ORBIT never creates a note, heading or front matter, never maps task fields onto the note's own fields, and never replaces or removes text, so human edits are preserved (tested against a temporary bare repository with a concurrent human edit).
- **Idempotency**: unchanged facts write nothing (`up-to-date`); a line whose key is already in the note (a crash between push and recording) writes nothing (`already-written`).
- **Failures are visible**: `vault.sync = {state: never | synced | failed | blocked, attempts, lastAttemptAt, lastSuccessAt, lastError, commit, retry: "manual"}` on the task, in `task_inspect`, the activity block and the banner. A `#rai` or otherwise protected note is `blocked` (no proposal). Retry is manual; there is no automatic retry.
- **Production**: `main.ts` passes the adapter only when the vault clone exists (the same condition as the vault write tools), so sync is inert on a host without the vault credential and reports "not enabled". It runs only when a person or the Assistant asks. **Coherence is not complete**: mapping task state to the vault's own task schema, reading human edits back into the task, and syncing on change are not built (see the matrix).

### Follow-up intent and recovery

- `followUp {at, note}` is stored and shown as due (`followUp.due`, activity block, banner) once its time passes. **Nothing wakes the task**: `autonomous: "disabled"`.
- At start, a turn left `running` by a stop is marked `interrupted` (with that reason) and is never re-run; the thread store already marks the interrupted reply. Proposals are in memory, so a launch card made before a restart shows `expired`; the request then derives `not-confirmed` and a new proposal may be linked.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant R as Rai
    participant A as Assistant (supervisor)
    participant S as Task store
    participant T as Task session (chat thread)
    participant P as Proposals + cards
    participant J as Job store
    R->>A: "Track the garden CSV exporter"
    A->>S: task_create (provenance: assistant, user message id)
    S->>T: new thread "Task: ..."; link /sessions/<uuid>
    A->>S: task_run_turn(rev) -> turn n running
    S->>T: supervisor-authored prompt; read-only + task tools; 6 rounds; no fallback
    T->>S: task_request(job), task_add_evidence (claimed), task_set_next_action
    A-->>A: next turn: task-activity block shows req-1 waiting
    A->>P: job_launch (card in the Assistant, bound origin)
    A->>S: task_respond link_proposal (verified open, Assistant-made)
    R->>P: Confirm (owner identity, single use)
    P->>J: register + launch (ADR 0002 flow)
    S-->>A: req-1 status derived: awaiting-confirmation -> confirmed -> running -> result
    R->>T: writes in the task session (Sessions)
    T->>S: instruction v(n+1) from Rai (sessions-ui); interactive turn
    R->>S: attest evidence; Mark done (refused until every criterion has attested or verified evidence)
```

## Routes (owner only; every POST takes `rev`)

`GET /tasks`, `POST /tasks` (create), `GET /tasks/:id`, `POST /tasks/:id/steer {rev, text, requestId?}`, `/pause`, `/resume`, `/cancel {rev, reason?}`, `/turn {rev, requestId?}` (202, runs in the background), `/evidence {rev, criterion, kind, ref, note?}` (attested), `/respond {rev, request, action, text?, proposalId?}`, `/sync`, `/complete {rev}`. Errors: 400 bad input, 403 not owner, 404 unknown task, 409 stale rev / conflicting state / not ready, 429 at the turn cap or the open-request cap, 503 store unavailable.

## Assistant tools (Assistant scope, owner only, `tasks` port)

`tasks_list` and `task_inspect` (read-only), `task_create`, `task_steer`, `task_pause` (pause/resume), `task_run_turn`, `task_respond` (answer/decline/link_proposal), `task_update` (next action, follow-up, project, vault link), `task_vault_sync`. Not offered in chat threads; refused there by name. The task's own tools are offered only inside its turns and refused by name elsewhere. `src/chat-tools.ts` (pinned) is unchanged.

## Implemented vs deferred

| Capability | State in this slice |
|---|---|
| Persistent task record: identity, goal/scope, acceptance, project ref, lifecycle, next action, blocker, follow-up, linked session, versioned instructions, requests, evidence | Implemented, tested (persistence and restart) |
| Assistant tools: create, list, inspect, steer, pause/resume, run a turn, respond, update, vault sync | Implemented, tested |
| Links into the task session in Sessions; banner with Rai's controls; supervisor messages labeled | Implemented, tested (real server in Chromium: banner, label, Pause) |
| One supervised bounded turn on the existing dispatch, configurable model port | Implemented, tested (tools, rounds, no fallback, context) |
| Serialized turns per task, conservative global cap, no queue | Implemented, tested |
| Stale-mutation refusal (rev), idempotent owner POSTs | Implemented, tested |
| Durable deduplicated requests with explicit pending/awaiting-confirmation/confirmed/running/result | Implemented, tested |
| Job requests through the existing owner confirmation flow | Implemented, tested (fake routine) |
| Direct human steering in Sessions and the task panel, with provenance, surfaced to the supervisor | Implemented, tested |
| Evidence-gated completion, human only | Implemented, tested |
| Pause/cancel stop a running supervised turn | Implemented, tested (pause) |
| Restart recovery (running turn -> interrupted, not re-run) | Implemented, tested |
| Vault status lines through the pipeline, idempotent, failures visible, manual retry, human edits preserved, protected notes blocked | Implemented, tested (fake port and temporary bare repo) |
| Mapping task state to the vault's own task schema (front matter, checkboxes), reading human edits back, sync on change | **Deferred**: the schema was not read in this slice and must be reviewed first |
| Session registry adapter for tasks (`task` kind), task rows in `sessions_list` | **Deferred**: tasks are reached through the task tools; their sessions already appear as chats |
| Autonomous wakeups, follow-up scheduling, recurring supervision | **Deferred and disabled** until budgets and activation are agreed |
| Dependencies between tasks, retry/backoff of turns, cost/time budgets per task, cancellation propagated to jobs | **Deferred** (next phase) |
| Task-scoped job proposals made directly by a task, cards in the task session | **Not done on purpose**: jobs go through the Assistant |
| Model routing for task turns | **Open**: a port exists (`taskModel`), no routing or evaluation |
| Live host verification | **Not done**: offline tests only |

## Acceptance walkthrough

Automated: `test/task-supervisor.test.ts`, "acceptance walkthrough", runs every step below against the real server with a scripted model and the fixture's fake routine. Manual (not performed on a live host by this change), on a running ORBIT as the owner with a model that can call tools:

1. **Create.** In the Assistant: "Make a task to build a garden sensor CSV exporter with synthetic data; done means it writes one row per sensor per day and its tests pass." `task_create` is called; the reply gives `/sessions/<uuid>`. Open it: the session is titled "Task: ..." and shows the task banner (active, no turn yet).
2. **Linked session.** `GET /tasks` lists the task; `GET /threads/<uuid>` carries `task`.
3. **A bounded turn.** Click "Run one turn" (or ask the Assistant to run one). The session shows a message from "ORBIT task supervisor" and the task's reply; the banner shows the last turn, the next action, and any request waiting. The turn was offered no proposal tools and at most 6 rounds.
4. **Escalation.** Ask the Assistant "anything from my tasks?". It names the waiting job request (from the task-activity block), inspects it, proposes the launch with `job_launch`, and links it with `task_respond`. The request shows `awaiting-confirmation`; nothing is launched until you click Confirm on the card; then `running`, later `result` with the job's own state. The task stays active.
5. **Direct steering.** Write "Use only synthetic readings" in the task session. `task_inspect` shows it as instruction v(n) by "Rai (sessions-ui)"; the Assistant's next task-activity block shows it until a turn has seen it.
6. **Status.** Ask the Assistant for the task's status: lifecycle, next action, blocker, requests with explicit statuses, evidence (claimed/verified/attested), completion readiness, vault sync state.
7. **Completion.** "Mark done" appears only when every criterion has attested or verified evidence; `POST /tasks/:id/complete` refuses otherwise with the criteria missing.

## Next phase (not built)

- **Restart-safe scheduling.** A durable wakeup table keyed by task id and due time, claimed with a lease (owner process id + expiry) before a turn starts, so a crash between claim and start is retried once and a duplicate start is refused by the existing `beginTurn` serialization. Activation behind an explicit setting, off by default.
- **Budgets.** Per task: max turns per day, max tool rounds per turn (exists), max model spend per day (from the spend ledger for the fallback, an estimate for the primary), max wall time per turn; a task over budget is paused with the reason. Global: the turn cap (exists) and a daily cap.
- **Retry and backoff.** A failed supervised turn retried at most N times with 1, 5, 30 minute backoff, only for errors marked transient (model unavailable, timeout); never for refusals, policy or protocol errors. Vault sync retry on the same schedule.
- **Dependencies.** `blockedBy: task-<id>[]`; a task does not start turns until its dependencies are done; cycles refused at write time.
- **Cancellation propagation.** Cancelling a task cancels its open proposals (cards) and asks running jobs it produced to stop through the existing job steer path, as a proposal Rai confirms, never silently.
- **Vault coherence.** Read the vault task schema (System/conventions.md and the task notes), decide a field mapping with Rai, write it through the pipeline with expected-hash edits (`rewrite_body` style) so a human edit makes the write fail and surfaces as a conflict instead of being overwritten.
- **Model routing evaluation.** Compare task-turn quality and cost across the configured model ports on a fixed synthetic task set before any routing rule is added.

## Limits

- Not verified with a real model, a real routine or on a live host.
- The page check covers one desktop viewport; phone layouts of the banner were not checked (it reuses the existing banner style).
- A task turn started in the background reports its outcome only through the task record (`task_inspect`, the banner); the Assistant is not notified when it ends.
- `tasks.json` is not pruned; done and cancelled tasks stay (about a few KB each).
- The open-request cap is per task; a supervisor that never answers leaves a task stuck at 5 waiting requests (visible).
- The vault sync idempotency check reads the note after a fetch; a concurrent human push between that read and ORBIT's push is handled by the pipeline's own reapply-once rule.
