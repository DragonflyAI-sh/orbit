# ADR 0003: Supervised tasks, first slice

Status: accepted for the first slice, hardened by "Repair 1" (below) after review of PR #151. Background autonomy (wakeups, schedules, retries) is **not** part of it and stays off until budgets and activation are agreed (see "Next slice").

Code: `src/tasks.ts` (record, store, derived views), `src/task-supervisor.ts` (the Assistant's task tools, the task's own tools, bounded turns, the activity block), `src/task-context.ts` (the task-scoped memory policy), `src/task-vault.ts` (status lines through the vault write pipeline), wiring in `src/server.ts` (routes, `prepare`/`allowAgent`, the task-session branch of the thread route, restart recovery), `src/main.ts` (`<state>/tasks.json`, the vault adapter), `src/policy.ts` (the `tasks` port), and hooks in the turn code: `src/thread-service.ts` (`TurnPrep.maxRounds`, `fallback`, `author`, `admit`) and `src/threads.ts` (`ThreadMessage.author`, `Thread.taskSession`). Page: `src/web/index.html` (task banner in a task's session, supervisor-authored messages labeled). Tests: `test/tasks.test.ts` (store, derived status, evidence gate, vault sync with a fake port and through the real pipeline on a temporary bare repository), `test/task-supervisor.test.ts` (real server: acceptance walkthrough, authorization, concurrency and pause, duplicates, restart, the page in Chromium, and one test per Repair 1 finding), `test/task-repair.test.ts` (Repair 1 at unit level: memory policy, admission races through the real thread store and turn code, links across restarts, version 1 files, vault bookkeeping failures).

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

### The task record (`src/tasks.ts`, file version 2)

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
| `idem[]` | The last 50 owner request ids, **per operation** (`steer`, `turn`), each with the digest of its payload (text and rev) and what it produced (instruction version or turn number). |
| `seen[]` | Version 1's request ids, which did not record their operation. Kept as they were and never extended; reusing one is refused (409), never guessed. |

File version 2 (Repair 1) is read alongside version 1: a version 1 file is migrated in memory and written as version 2 at its first change (so an older build then refuses it as newer, rather than misreading it). Text is masked for credential shapes (the conversation stores' filter), stripped of control and bidirectional characters, and capped. Records this build cannot parse are kept untouched in the file.

### Provenance

Filled by the server from the route or turn, never from model text: `human` (`task-panel`, `sessions-ui`, `api`), `assistant` (the Assistant's tool call, with the user message and reply it belongs to, from the turn identity `runChat` passes to tools), `task` (the task's own turn `n`), `orbit` (recovery). A steer the Assistant relays is labeled as the Assistant's (model-written), not Rai's. Rai's own steers come from the task banner (`POST /tasks/:id/steer`) or from writing in the task session.

### Requests: durable, deduplicated, explicit

A task asks its supervisor with `task_request {kind: clarification | blocker | job, text, brief?, routine?}`.

- **Deduplication.** The key is a hash of the kind, the whitespace- and case-normalized text, and (job) the brief. An identical request that exists in any state but `withdrawn` is returned with `duplicate: true` and counted (`duplicates`); nothing is filed twice. At most 5 requests may wait at once (429 beyond), 100 per task in total.
- **Recorded states** (what the supervisor did): `pending`, `answered`, `proposed`, `declined`, `withdrawn`.
- **Explicit status** (derived at observation time, never stored): `pending` → `awaiting-confirmation` (a launch card waits for Rai) → `confirmed` (Rai confirmed; the card names the job) → `running` (the job store says registered/running) → `result` (the job store says done/failed/blocked: the run's result, **not** task completion); or `not-confirmed` (the card expired, was cancelled or refused; a new proposal may then be linked, the old one is kept in `previous`), `answered`, `declined`, `withdrawn`, `unknown`.
- **Linking** (`task_respond action: link_proposal`, or Rai's `POST /tasks/:id/respond`) needs an **open `job_launch` proposal bound to the Assistant** (`proposals.peek`, `origin === "assistant:assistant"`): a made-up id, a used one, or one from a chat thread is refused. Linking launches nothing; Rai still confirms each launch on its card.
- **Binding** (Repair 1). At link time ORBIT copies from the proposal store, once and immutably, a `binding`: routine, SHA-256 of the proposal's brief and of the request's brief (whitespace-normalized, after the same masking the stored brief had), the proposal's origin and time, and the request's dedup key. The link is refused when the request named a routine and the proposal launches another, or when the briefs differ. If the briefs differ on purpose, only **Rai** can link it, and only by sending `acceptBriefSha256` equal to the proposal brief's digest that the refusal showed him (binding `match: "accepted-by-rai"`); the Assistant cannot.
- **Global exclusivity** (Repair 1). A proposal id answers at most one request across **all** tasks, ever: the check covers every task's current and earlier (`previous`) links, runs in the same synchronous store change that writes the link, and reads the persisted file, so it holds across restarts. A repeat of a link already made (same request, same proposal) is answered as a duplicate before the rev check and changes nothing.

Repeated runner callbacks, repeated confirmations and repeated owner POSTs are idempotent: request status is derived (nothing is stored per callback), the confirm route answers a repeat from the card (unchanged), and owner routes accept a `requestId`. Request ids are namespaced by operation (Repair 1): the same id used for a steer and for a turn are two different requests. A repeat with the same payload returns the result it recorded (the instruction version or the turn number, never "the newest turn"); a reuse with another payload (other text, other rev) is 409 and changes nothing.

### Evidence and completion

Repair 1 separates two questions that the first slice merged. A job being done is not proof that an arbitrary acceptance criterion passed.

**Acceptance** (`status`, what counts toward a criterion):

| Status | When | Counts toward completion |
|---|---|---|
| `attested` | added by Rai (`POST /tasks/:id/evidence`, owner route) | yes |
| `claimed` | anything a model added (the task or the Assistant), of any kind | no |

**Execution** (`execution`, job evidence only, shown beside the status, never counted by itself):

| State | Meaning |
|---|---|
| `verified` | a request of this task holds a **bound** link (above) to a proposal no other request ever claimed, the job store's own work link (`job.work.proposal`, written at registration from the confirmed card) names that proposal, and the job is `done`. It says the job this task asked for ran and finished, nothing about any criterion. |
| `not-done` | the same chain, the job is not `done` (running, failed, blocked). |
| `unlinked` | no request of this task produced this job (for example another task's job, or a job launched some other way). |
| `legacy-unbound` | the request's link was made by the first slice, without a binding, so ORBIT does not attribute the job to the request. No binding is invented for it. |
| `ambiguous` | the proposal is linked to more than one request (possible only in version 1 files). |
| `unknown` | the job record cannot be read, or does not say which proposal launched it. |

`POST /tasks/:id/complete` (Rai only, with the current rev) is refused unless every criterion has `attested` evidence and no turn is running. Rai may attest a criterion by citing a job (`kind: job`), and the view then shows both his attestation and the execution check. There is no tool that completes a task; the store refuses non-human completion as well (tested). A model saying "done", "APPROVED", or a job ending (even one whose execution is verified) changes nothing.

### Turns

| | Supervised turn | Interactive turn |
|---|---|---|
| Started by | the Assistant (`task_run_turn`) or Rai (banner, `POST /tasks/:id/turn`); never by a timer | Rai writing in the task session |
| Prompt | a message authored `orbit-supervisor` (stored and shown as "ORBIT task supervisor", never as Rai) | Rai's message (text and/or photos), admitted atomically (below); its text is recorded as a new instruction version from Rai (`sessions-ui`), photos alone record none |
| Tools | read-only chat tools plus the task's own (`task_request`, `task_add_evidence`, `task_set_next_action`); proposal and effect tools withheld and listed in the limits | the owner's chat tools as in any chat thread (proposals still need Rai's click) plus the task's own |
| Bounds | at most `TASK_TURN_MAX_ROUNDS` (6) tool rounds; the paid fallback is off | the usual chat bounds |
| Context | the task record as an `<orbit-data name="task">` block (instructions labeled with who wrote them), memory excerpts under the task-scoped memory policy and devices; **no** session tools, session digest, task-activity block or rolling recent-context note (see "Isolation") | the same, plus "Rai is writing in this task's session now" |

#### Direct steering in the task session (Repair 1)

Rai's message in a task's session is admitted by the task store in one synchronous step with taking the thread's reply lock (`TurnPrep.admit`, `tasks.admitHuman`), so there is no window between "accepted" and "recorded":

| Lifecycle | What a message does | Refused (nothing recorded, nothing sent) when |
|---|---|---|
| active | text: instruction v(n+1) from Rai **and** an interactive turn record that has seen it, in one store change; photos only: the turn record (with a photo count), **no** instruction | any turn of the task is running, including a supervised turn still in its prepare step before it holds the thread lock (409); the task's lifecycle changed while the reply was being prepared (409) |
| paused | text: instruction v(n+1) from Rai, kept for when the task resumes; **no turn runs**, the reply has the task's context read-only and no task tools, and the model is told exactly that; photos only: nothing recorded | the task's lifecycle changed meanwhile (409) |
| done, cancelled | an ordinary reply with the task's context read-only; nothing is recorded, and the model is told so | |

If the user message then cannot be stored in the thread (a write failure), the admission is undone: its instruction is removed and its turn record ends as an error ("Not run"). The banner shows the server's own sentence for the current lifecycle (`sessionWriting`), the same rule the model is given. If the task store cannot be read, a message to a task's session (a thread created with `taskSession: true`, or titled "Task: " for sessions made before that field) is answered 503 and nothing is sent, rather than answered as an ordinary chat without the task's policy.

The task model is a port: `Deps.taskModel` (absent: the same model port as every other turn; `main.ts` sets none). Each turn records the port's `impl`. Which model is best for task turns is left open (no routing logic, no hard-coded model).

### Concurrency and stale state

- A task's turns are serialized twice: the task record allows one `running` turn, and the thread lock allows one reply. A second start is 409.
- At most `taskTurnsMax` (default 2) supervised turns run at once across tasks; beyond that 429, and **nothing is queued**.
- Every mutation for Rai or the Assistant carries the rev it was based on; a stale rev is 409 and changes nothing (two concurrent steers from one view: exactly one wins, tested). The task's own turn writes are not rev-checked (they are its own record) but are refused once the task is no longer active.
- A steer from the task panel (`POST /tasks/:id/steer`) or the Assistant that arrives while a turn runs is recorded at once; the running turn does not see it (`instructionsSeen`), and the supervisor is told (`notSeenFromRai`). A message written **in the task session** while a turn runs is refused instead (above): it would otherwise need a reply the running turn cannot give.
- Human turns in a task session are not counted toward the supervised-turn cap (Rai is present); they are serialized with supervised turns by the task record.
- Pause and cancel abort a running supervised turn (its model request or tool call is cancelled; what already happened stays on record).

### What the supervisor sees

Each owner Assistant turn gets an `<orbit-data name="task-activity">` block beside the session digest: open tasks (at most 8, those with a running turn, waiting requests, Rai's unseen instructions or a due follow-up first), metadata only (ids, rev, title, lifecycle, session link, request ids and kinds, counts, last turn, completion readiness, vault sync state). Request text and replies stay behind `task_inspect`, whose answers carry a notice that task-written text is untrusted data. Built per turn, never stored.

### Isolation: what is and is not isolated

A task turn (supervised or interactive) is isolated from **other conversations' content delivered as context**, through these specific routes, each enforced in code and tested:

| Route | In a task turn |
|---|---|
| Rolling recent-context note as the thread-service note | not given (the task sessions' thread service has no `recent` port) |
| The same note as a vault file, `Memory/recent-context.md`, as an automatic memory excerpt | never: search through the task-scoped memory port drops it (`src/task-context.ts`, `taskMemory`) |
| `memory_search` | never returns it |
| `memory_read`, `memory_read_page` | refuse it under every spelling that resolves to it (`./`, `//`, `..`, a leading slash, backslashes, letter case); the paged reader answers `denied` |
| Vault write tools (offered only in an interactive turn, when Rai writes) | refuse it as a target, so an edit cannot probe its content |
| Session tools, session digest, task-activity block | not offered / not built (Assistant scope only) |
| Photos | only the task session's own (unchanged photo policy) |
| A task session feeding the rolling note | never (archive route) |

Ordinary access is unchanged: the Assistant and ordinary chat threads still get the rolling note and can read it (tested).

**Not isolated** (deliberately, or not yet), so "a task sees no other conversation" would be an overclaim:

- Every other vault note stays reachable as in any chat, including notes that themselves summarize past work (project notes, `Log/`, `now.md`, other `Memory/` notes). Only the rolling cross-conversation note is excluded.
- The read-only job tools (`jobs_list`, `job_status`, `job_summary_read`, research results) show jobs launched from any conversation, with their briefs and summaries; the duplicate-launch warning compares against all jobs.
- Server and host read tools (ops, config view, host inventory, pull-request inspection) show ORBIT-wide state.
- Rai, writing in the task session, can paste anything.

The Assistant may read a task's session with its existing `session_read` (it is a chat thread): the supervisor reading its subordinate is the intended direction. Assistant answers to a task's request reach that task's next turn only, labeled as the Assistant's.

### Vault sync (`src/task-vault.ts`)

- A task may link one existing note under `Projects/` or `Tasks/` and a heading that already exists in it. `task_vault_sync` (or `POST /tasks/:id/sync`) appends one status line under that heading: lifecycle, next action, accepted criteria count, waiting requests, and a key `(orbit-task <id> #<hash>)`.
- **Through the existing pipeline only** (`clone.write`, direct mode): fetch, path and symlink rules, secret check, AGENTS.md classification, one commit with the Log line, push without force, remote verification.
- **Respecting the vault's task schema**: this slice does not read or change it. ORBIT never creates a note, heading or front matter, never maps task fields onto the note's own fields, and never replaces or removes text, so human edits are preserved (tested against a temporary bare repository with a concurrent human edit).
- **Idempotency**: unchanged facts write nothing (`up-to-date`); a line whose key is already in the note (a crash between push and recording) writes nothing (`already-written`).
- **The vault write and ORBIT's bookkeeping are separate facts** (Repair 1). Every outcome says `written` (the pipeline committed, pushed and verified the line in this call) and `recorded` (the task record took the outcome):

  | State | Vault | Task record | Answer |
  |---|---|---|---|
  | `synced` | written, verified | recorded | saved |
  | `written-unrecorded` | written, verified (commit given) | could **not** be written | the line IS in the vault; the task still shows its previous state; run the sync again and it finds the line by its key and records it without a second line |
  | `already-written`, `up-to-date` | nothing needed | recorded (or `recorded: false` with the same retry guidance) | saved earlier |
  | `failed` | nothing written (refused before any push: path, secret, conflict, fetch, missing note, ...) | recorded when possible | NOT saved |
  | `blocked` | nothing written; the policy protects the note; **no proposal is made** | recorded when possible | NOT saved |
  | `unknown` | the pipeline could not confirm whether the push landed (`unverified`, `push_failed`, an unexpected error) | recorded when possible | NOT confirmed saved; never "committed"; a retry is safe (the key check finds the line if it landed) |

  `task_vault_sync` returns `inVault` and `recordedOnTask` and tells the model to say saved only when `inVault` is true. The owner route answers 502 for `failed`, `blocked` and `unknown`.
- **Failures are visible**: `vault.sync = {state: never | synced | failed | blocked | unknown, attempts, lastAttemptAt, lastSuccessAt, lastError, commit, retry: "manual"}` on the task, in `task_inspect`, the activity block and the banner. A `#rai` or otherwise protected note is `blocked` (no proposal). Retry is manual; there is no automatic retry.
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
    A->>S: task_respond link_proposal (open, Assistant-made, same brief; never linked anywhere else)
    R->>P: Confirm (owner identity, single use)
    P->>J: register + launch (ADR 0002 flow)
    S-->>A: req-1 status derived: awaiting-confirmation -> confirmed -> running -> result
    R->>T: writes in the task session (Sessions)
    T->>S: admitted atomically: instruction v(n+1) from Rai (sessions-ui) + interactive turn, or 409 with nothing recorded
    R->>S: attest each criterion (may cite the job, whose execution ORBIT verifies separately); Mark done
    A->>S: task_vault_sync -> status line through the vault pipeline (written / recorded reported separately)
```

## Routes (owner only; every POST takes `rev`)

`GET /tasks`, `POST /tasks` (create), `GET /tasks/:id`, `POST /tasks/:id/steer {rev, text, requestId?}`, `/pause`, `/resume`, `/cancel {rev, reason?}`, `/turn {rev, requestId?}` (202, runs in the background), `/evidence {rev, criterion, kind, ref, note?}` (attested), `/respond {rev, request, action, text?, proposalId?, acceptBriefSha256?}` (`acceptBriefSha256`: Rai only, to link a proposal whose brief differs, naming its digest), `/sync` (200 for `synced`, `written-unrecorded`, `already-written`, `up-to-date`; 502 for `failed`, `blocked`, `unknown`), `/complete {rev}`. Errors: 400 bad input, 403 not owner, 404 unknown task, 409 stale rev / conflicting state / not ready / a requestId reused with another payload, 429 at the turn cap or the open-request cap, 503 store unavailable.

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
| Stale-mutation refusal (rev), idempotent owner POSTs, namespaced by operation with payload identity | Implemented, tested (Repair 1) |
| Durable deduplicated requests with explicit pending/awaiting-confirmation/confirmed/running/result | Implemented, tested |
| Job requests through the existing owner confirmation flow; proposals bound to the request's brief and routine, globally exclusive, durable across restart | Implemented, tested (fake routine; Repair 1) |
| Direct human steering in Sessions and the task panel, with provenance, surfaced to the supervisor; atomic admission; photo-only messages; paused sessions record for resume | Implemented, tested (Repair 1) |
| Evidence-gated completion, human only: Rai attests every criterion; job execution verified separately and never counted alone | Implemented, tested (Repair 1) |
| Task-scoped memory policy (no rolling recent-context note by any route) | Implemented, tested (Repair 1); other cross-conversation routes listed under "Isolation" are not isolated |
| Pause/cancel stop a running supervised turn | Implemented, tested (pause) |
| Restart recovery (running turn -> interrupted, not re-run) | Implemented, tested |
| Vault status lines through the pipeline, idempotent, failures visible, manual retry, human edits preserved, protected notes blocked; vault write and bookkeeping reported separately | Implemented, tested (fake port and temporary bare repo; Repair 1 with injected bookkeeping failure) |
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
5. **Direct steering.** While a turn is running, write in the task session: the message is refused (409) and nothing is recorded. When it has ended, write "Use only synthetic readings": `task_inspect` shows it as instruction v(n) by "Rai (sessions-ui)"; the Assistant's next task-activity block shows it until a turn has seen it. Pause the task and write again: the banner says the message is recorded for resume and no turn runs.
6. **Status.** Ask the Assistant for the task's status: lifecycle, next action, blocker, requests with explicit statuses and their binding, evidence (claimed/attested, with the execution check for jobs), completion readiness, vault sync state.
7. **Completion.** "Mark done" appears only when you have attested every criterion; `POST /tasks/:id/complete` refuses otherwise with the criteria missing, even when the task's job finished and its execution is verified.
8. **Vault sync.** With a linked note, ask the Assistant to sync: it reports `inVault` and `recordedOnTask` separately; a second sync with unchanged facts writes nothing.

## Repair 1: review findings on PR #151

Each finding was checked against `main` at be9636a by running the new server-level tests there (findings 1, 2, 3, 4, 5 and 7 fail on `main`; the column says what was observed, and where a detail rests on code reading instead) and fixed with regression tests that pass here.

| # | Finding | Reproduced on main | Fix | Tests |
|---|---|---|---|---|
| 1 | Context boundary: ordinary `prepare` memory search inserted `Memory/recent-context.md` into a task turn, and `memory_read`/`memory_read_page` read it | the task turn's notes contained the rolling note's text | `src/task-context.ts`: task-scoped memory port (search drops it, reads refuse every spelling, paged reader `denied`), vault write tools refuse it as a target; `prepare(..., {taskSession: true})` for supervised and interactive turns; a task session fails closed (503) when the task store cannot be read | `task-supervisor` "finding 1" (automatic excerpt, `memory_search`, 7 read spellings, paged read, interactive turn, ordinary chat unchanged); `task-repair` "finding 1" (normalization, limit filling, write-tool refusal) |
| 2 | Admission: `humanTurn` steered before `beginTurn`; a supervised turn recorded running while in prepare made Rai's refused message a durable instruction | 409 "A turn of this task is already running", instruction recorded | `tasks.admitHuman` (instruction + turn record in one store change, refused while any turn runs), called through `TurnPrep.admit` in the same synchronous step as the thread lock; rollback if the message cannot be stored | `task-supervisor` "finding 2"; `task-repair` "finding 2" (supervised turn held in its real prepare step, two racing messages, append failure rollback) |
| 3 | Photo-only messages: the thread route accepted them, the task steer refused them | 400 "A steer needs text." | admission records a turn with a photo count and no instruction; paused photo-only records nothing; attachment binding unchanged | `task-supervisor` "finding 3" (real upload and message routes, foreign photo refused) |
| 4 | Linking checked only open/Assistant/job-launch and per-task uniqueness; a done job counted as criterion evidence | a proposal for an unrelated brief was linked (observed); cross-task reuse of one proposal by code reading (the uniqueness check looked only at the same task) | immutable `binding` (routine, brief digests, origin, time, request key), refused on mismatch; Rai-only `acceptBriefSha256` for intended differences; global exclusivity over current and earlier links, durable; acceptance (`attested` only) separated from execution (`verified` needs the bound link and the job's own work link); legacy links `legacy-unbound`, never verified | `task-supervisor` "finding 4", the walkthrough; `task-repair` (restart, routine, previous links, version 1 file, ambiguous, unlinked, no work link) |
| 5 | Paused session wording said nothing changes while the text was stored as an instruction | the test fails on `main` (no session wording in the view); the contradiction itself by code reading: the paused prompt said "nothing you say here changes the task" after `steer` recorded the text | paused prompt and banner (`sessionWriting`) say the message is recorded for resume and no turn runs; done/cancelled say nothing is recorded | `task-supervisor` "finding 5" |
| 6 | Vault sync: append succeeded, then `recordSync` failed, and the catch said NOT saved | code reading of `src/task-vault.ts` at be9636a: a `recordSync` throw after a successful `append` fell into the same catch and was reported "NOT saved" (the unit test needs the new API, so it was not run on `main`) | `written` and `recorded` reported separately; `written-unrecorded` with the commit and retry guidance; `unknown` for unconfirmed pushes; never "committed" on a proposal or unknown result | `task-repair` "finding 6" (injected task-file failure after a successful append, retry, one line) |
| 7 | Steer and turn shared request ids: a steer's id made the turn route crash (no turns) or answer a false "started" | turn route threw reading `.n` of undefined | `idem[]` per operation with payload digest and recorded result; legacy `seen` ids refused; file version 2 | `task-supervisor` "finding 7"; `task-repair` (legacy ids) |

## Next slice (prioritized plan; not built here)

Nothing below is implemented by Repair 1, and task powers were not widened. In order:

1. **Restart recovery and durable follow-up wakeups (first, together).** A durable wakeup table in `tasks.json` (`wakeups[]: {task, dueAt, reason, claim?: {by: processStart, until}}`), claimed with a lease before a turn starts, through the same `beginTurn` serialization, so a crash between claim and start is retried once and a duplicate start is refused. On start, expired claims are released and reported, never silently re-run; turns left running stay `interrupted` (as now). The scheduler only ever calls `startTurn` with an `orbit` provenance and the task's current rev; it is off by default behind an explicit setting and the wakeup is shown on the banner and in the activity block before it is enabled.
2. **Budgets before any wakeup fires.** Per task: turns per day, wall time per turn, tool rounds per turn (exists: 6), model spend per day (the spend ledger for the fallback, an estimate for the primary); global: the supervised-turn cap (exists: 2) and a daily turn cap. Over budget pauses the task with the reason; nothing queues. Retries only for errors marked transient (model unavailable, timeout), at most N with 1/5/30 minute backoff; never for refusals, policy or protocol errors.
3. **Model-routing evaluation, before any routing rule.** A fixed synthetic task set run offline through `Deps.taskModel` on each configured model port, scoring tool-use correctness (requests filed rather than claims made, no approvals claimed), bound compliance and cost per turn; results recorded per turn (`model` already is). No paid fallback for task turns stays the default until the evaluation says otherwise and Rai decides.
4. Then: dependencies between tasks, cancellation propagated to open cards and running jobs (as proposals Rai confirms), vault schema mapping with expected-hash edits, a session-registry `task` kind.

## Limits

- Not verified with a real model, a real routine or on a live host.
- The page check covers one desktop viewport; phone layouts of the banner were not checked (it reuses the existing banner style).
- A task turn started in the background reports its outcome only through the task record (`task_inspect`, the banner); the Assistant is not notified when it ends.
- `tasks.json` is not pruned; done and cancelled tasks stay (about a few KB each).
- The open-request cap is per task; a supervisor that never answers leaves a task stuck at 5 waiting requests (visible).
- The vault sync idempotency check reads the note after a fetch; a concurrent human push between that read and ORBIT's push is handled by the pipeline's own reapply-once rule.
- The task memory policy excludes one note by path. A copy of the rolling note's text under another path (for example pasted into a project note) is an ordinary note and is not excluded.
- A message written in a task session while a turn runs is refused, not queued: Rai sends it again when the turn ends (the banner shows a turn running).
- Briefs are compared after whitespace normalization only; a semantically equivalent brief worded differently is a mismatch (the Assistant re-proposes, or Rai accepts it by digest).
- Execution verification needs the job store's work link (`job.work.proposal`); a job registered without one (an older job) is `unknown`, never verified.
- No UI for Rai's brief-difference acceptance: it is an owner API field (`acceptBriefSha256`) only.
