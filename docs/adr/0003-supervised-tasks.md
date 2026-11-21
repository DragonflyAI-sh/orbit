# ADR 0003: Supervised tasks, first slice

Status: accepted for the first slice, hardened by "Repair 1" (below) after review of PR #151, "Repair 2" after review of PR #153, "Repair 3" after review of PR #154 (which also adds durable supervisor attention, research-lane requests, dependencies, vault coherence views and an offline model-evaluation harness; see "Repair 3"), and "Repair 4" after review of PR #155 (which also adds attention delivery that only a completed Assistant turn records, attention counts in Sessions and on the Assistant page, an opt-in supervisor wake that is off by default at two levels, honest cancellation coordination, vault sync recovery and a fail-closed task-turn routing table; see "Repair 4"). Repair 2 also adds one bounded piece of background behaviour, **automatic follow-up** (below): off by default at two levels (the operator's switch and Rai's per-task opt-in), at most one bounded supervised turn per follow-up due time, budgeted, never re-run when its outcome is uncertain. It is not enabled on any host by this change. Other background autonomy (recurring supervision, self-scheduling, dependencies) is not built.

Code: `src/tasks.ts` (record, store, derived views), `src/task-supervisor.ts` (the Assistant's task tools, the task's own tools, bounded turns, the activity block), `src/task-context.ts` (the task-scoped memory policy), `src/task-vault.ts` (status lines through the vault write pipeline), `src/task-scheduler.ts` (the follow-up scheduler, Repair 2), wiring in `src/server.ts` (routes, `prepare`/`allowAgent`, the task-session branch of the thread route, restart recovery), `src/main.ts` (`<state>/tasks.json`, the vault adapter), `src/policy.ts` (the `tasks` port), and hooks in the turn code: `src/thread-service.ts` (`TurnPrep.maxRounds`, `fallback`, `author`, `admit`) and `src/threads.ts` (`ThreadMessage.author`, `Thread.taskSession`). Page: `src/web/index.html` (task banner in a task's session, supervisor-authored messages labeled). Tests: `test/tasks.test.ts` (store, derived status, evidence gate, vault sync with a fake port and through the real pipeline on a temporary bare repository), `test/task-supervisor.test.ts` (real server: acceptance walkthrough, authorization, concurrency and pause, duplicates, restart, the page in Chromium, and one test per Repair 1 finding), `test/task-repair.test.ts` (Repair 1 at unit level: memory policy, admission races through the real thread store and turn code, links across restarts, version 1 files, vault bookkeeping failures), `test/task-repair2.test.ts` (Repair 2 findings), `test/task-scheduler.test.ts` (automatic follow-up with a fake clock).

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
| `followUp` | `{at, note, by, autonomous: "disabled"}`: the follow-up time. `autonomous: "disabled"` is kept for file compatibility: the follow-up record itself grants nothing. |
| `auto` | Automatic follow-up (Repair 2): `{enabled, changedAt, changedBy, perDay, started[], slot?}`. Absent on every task until Rai turns it on, so tasks that already had follow-up times stay off. |
| `instructionSeq` | The highest instruction version ever given out (Repair 2): versions are never reused. |
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

Filled by the server from the route or turn, never from model text: `human` (`task-panel`, `sessions-ui`, `api`), `assistant` (the Assistant's tool call, with the user message and reply it belongs to, from the turn identity `runChat` passes to tools), `task` (the task's own turn `n`), `orbit` (`system`: recovery; `follow-up`: the scheduler's automatic turn for one due time, labeled "ORBIT (automatic follow-up due ..., which Rai turned on)"). A steer the Assistant relays is labeled as the Assistant's (model-written), not Rai's. Rai's own steers come from the task banner (`POST /tasks/:id/steer`) or from writing in the task session.

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
| Started by | the Assistant (`task_run_turn`) or Rai (banner, `POST /tasks/:id/turn`); or the follow-up scheduler, only for a task Rai opted in and only when the operator switched it on (below) | Rai writing in the task session |
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
| `memory_read`, `memory_read_page` | take only a canonical vault-relative path (Repair 2, below) and refuse the note; the paged reader answers `denied` |
| Vault write tools (offered only in an interactive turn, when Rai writes) | take the same canonical paths and refuse the note as a target, so an edit cannot probe its content |

**The exact path boundary (Repair 2).** The vault memory port reads `relative(root, resolve(root, path))`, so an absolute path under the vault root, or a relative one that leaves the root and comes back through the root's own directory name (`../<root>/Memory/...`), names the same note as the plain path. In a task turn (`src/task-context.ts` `taskNotePath`):

- **Refused as spellings** (for every note, with "refused in a task session"; nothing read or written): absolute paths (`/...`, `//...`, `~...`, `C:...`), any `..` segment, backslashes, control characters, empty paths. None is needed to name a note: `memory_search` returns plain paths.
- **Canonicalized**: empty and `.` segments are dropped (`./`, `//`, a trailing `/`), and that canonical path is both what is checked and what the port is given. With no `..`, leading `/` or `.`/empty segment, the port's `resolve` + `relative` returns the same string, so the port looks up exactly what was checked.
- **Compared ignoring letter case** against the excluded note (stricter than the port, whose lookup is case-sensitive).
- **Symbolic links**: the port never indexes a link (file or directory; `collect` skips them), so a link to the note answers "no such note" in every conversation. Tested with a file link and a directory link.
- **Not covered**: a copy of the note's text under another path (an ordinary note), and stores other than the vault memory port.
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

### Follow-up and recovery

- `followUp {at, note}` is stored and shown as due (`followUp.due`, activity block, banner) once its time passes. Without automatic follow-up (the default), that is all: nothing wakes the task.
- At start, a turn left `running` by a stop is marked `interrupted` (with that reason) and is never re-run; the thread store already marks the interrupted reply. Proposals are in memory, so a launch card made before a restart shows `expired`; the request then derives `not-confirmed` and a new proposal may be linked.
- Every supervised turn (manual or automatic) is rechecked just before the model is called (Repair 2): if the task was paused or cancelled while the turn prepared, or (automatic) the follow-up was turned off, the turn ends `error` "Not run: ..." and nothing is sent.

### Automatic follow-up (Repair 2)

**Activation contract.** Two switches, both off by default, both required:

1. **Operator** (per ORBIT): `ORBIT_TASK_FOLLOWUPS=on` in the service environment (`src/main.ts`). No deploy file in this repository sets it, and this change enables it nowhere. Off: the scheduler never starts a turn, and an opted-in task shows `scheduler-off`.
2. **Rai** (per task): `POST /tasks/:id/follow-up {rev, enabled: true, perDay?}` (owner route; the banner's "Allow automatic follow-up"). Only a human owner route can turn it on: the store refuses the Assistant, the task's model, ORBIT itself and a message written in the session (`sessions-ui`), and the Assistant's `task_update` accepts only `autoFollowUp: "off"`. The task's own tools have no follow-up or autonomy control and cannot set a follow-up time. Turning it off: Rai (route or banner) or the Assistant (`task_update autoFollowUp: "off"`).

**What it does.** Every minute (`FOLLOW_UP_TICK_MS`; only while the server listens; one tick at a time), for each opted-in active task whose `followUp.at` has passed, it starts **one** supervised turn for that due time through `startTurn`: the same tools (read-only plus the task's own), the same `TASK_TURN_MAX_ROUNDS` (6), no paid fallback, the same per-task serialization (task record and thread lock) and global cap (`taskTurnsMax`, 2) as any turn. The turn consumes the due time; another automatic turn needs a new follow-up time, which only Rai or the Assistant (in an owner turn) can set. It never reschedules itself.

**One durable fact for claim and start.** The due time is claimed inside the same store change that records the running turn (`tasks.beginTurn` with `auto`), after the store rechecks eligibility on the fresh record (enabled, active, this due time, not already claimed, no turn running, budgets). Nothing is persisted before that change and nothing is sent to a model before it is persisted. So repeated or overlapping ticks, a restart, or a manual start racing the scheduler start at most one turn (tested), and a write failure at the claim leaves the file unchanged and nothing dispatched.

**States** (`automaticFollowUp` in `tasks_list`, `task_inspect`, the owner routes and the banner; `automaticFollowUp.state` in the Assistant's task-activity block):

| State | Meaning | Next |
|---|---|---|
| `off` | not opted in (the default) | nothing starts |
| `scheduler-off` | opted in, operator switch off | nothing starts |
| `no-follow-up`, `not-due` | no time set / time not reached (`nextAt`) | waits |
| `inactive` | paused, cancelled or done | nothing starts; on resume a due follow-up runs at the next tick |
| `turn-running` | another turn of the task holds it (Rai's interactive turn, a manual turn) | waits; not counted as an attempt |
| `due` | eligible now | the next tick starts one turn |
| `capacity-wait` (Repair 3) | every supervised turn slot was busy, or the task's session had a reply in progress: a **deferral**, `deferrals` and `deferredSince` | the next tick tries again, oldest due time first; uses no attempt, never gives up for capacity alone |
| `dependency-wait` (Repair 3) | a dependency (`dependsOn`) is not done | waits; shown with the blocked reason |
| `retry-wait` | a pre-dispatch failure that may clear (an unexpected error before the claim, such as a write failure); `attempts`, `nextTryAt` | retried after 1, 5, 15 minutes |
| `gave-up` | 4 pre-dispatch attempts failed, or a failure that is not transient (missing session, model cannot call tools, policy); raises an attention item | no automatic attempt for this due time |
| `started` | turn `n` was started for this due time | its outcome follows |
| `ended` | that turn ended (`outcome` done or error, from the turn record, in the same store change) | consumed |
| `interrupted` | ORBIT stopped while that turn ran: whether the model was called is unknown | **never re-run automatically** |
| `budget-task`, `budget-global` | this task's `perDay` (default 2, at most 6) or ORBIT's 10 automatic turns in any 24 hours are used; `nextAt` says when the task's window frees | waits for the window |

Retries happen only for failures before the claim (nothing dispatched); a turn that started and failed is its own outcome (`ended`, `error`), never retried automatically. Capacity is not a failure (Repair 3): it defers without using an attempt. Attempt and deferral bookkeeping does not bump `rev`.

**Budgets: what they constrain.** They count **automatic turns started**, per task and across ORBIT, per rolling 24 hours. With the existing per-turn bounds (6 tool rounds, no paid fallback, 2 supervised turns at once) that bounds how many bounded model conversations the scheduler can cause. They do **not** measure or cap provider spend: the cost of a turn depends on the model port and context size, and no dollar figure is guaranteed.

**What it does not do.** It notifies no one (no Discord, no notification) and starts no Assistant turn. What an automatic turn needs from anyone is a durable `task_request`, which the Assistant sees in its task-activity block the next time Rai talks to it and Rai sees in the banner; jobs still need the Assistant's proposal and Rai's Confirm (tested end to end). Vault sync stays manual (`task_vault_sync` is an Assistant tool, not offered in task turns). Human confirmations for jobs, steers and ops are unchanged.

**Recovery procedure.**

- `interrupted`: look at the task session (the reply may be partial or absent) and the turn's record in `task_inspect`. To retry, start one turn (banner "Run one turn", `task_run_turn`), or set a new follow-up time.
- `gave-up`: the `lastAttempt.error` says why; fix that (free a turn slot, restore the session, model with tools), then start a turn or set a new follow-up time.
- `budget-*`: wait for `nextAt`, start a turn manually (manual turns are not counted), or raise `perDay` (Rai: turn it on again with `perDay`, up to 6).
- To stop everything at once: unset `ORBIT_TASK_FOLLOWUPS` and restart; or turn a task's follow-up off; or pause the task (a running turn is aborted).

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

## Routes (owner only; every POST takes `rev` except `/attention` and the wake controls)

Repair 4 adds `GET /tasks/attention` (counts per task with session links, and the wake state), `GET /tasks/wake`, `POST /tasks/wake {enabled, perDay?}` and `POST /tasks/wake/pause {paused, reason?}` (Rai only); `GET /tasks` also reports `routing` and `wake`; `/cancel` answers `cancellation` (see "Repair 4"). No-op updates are rev-checked like every other mutation (Repair 4).


`GET /tasks`, `POST /tasks` (create), `GET /tasks/projects?project=&closed=1` (read-only reconciliation; Repair 3), `GET /tasks/:id`, `POST /tasks/:id/follow-up {rev, enabled, perDay?}` (Rai's opt-in; Repair 2; answers `changed`, and `ignored: ["perDay"]` when turning off), `POST /tasks/:id/update {rev, nextAction?, followUpAt?, followUpNote?, project?, vaultNote?, vaultHeading?, dependsOn?, autoFollowUp?: "off"}` (one atomic change; Repair 3), `POST /tasks/:id/attention {attention, note?}` (acknowledge a non-request attention item; Repair 3), `POST /tasks/:id/steer {rev, text, requestId?}`, `/pause`, `/resume`, `/cancel {rev, reason?}`, `/turn {rev, requestId?}` (202, runs in the background; a repeat whose turn record is no longer kept is 409 `expired`), `/evidence {rev, criterion, kind, ref, note?}` (attested), `/respond {rev, request, action, text?, proposalId?, acceptBriefSha256?}` (`acceptBriefSha256`: Rai only, to link a proposal whose brief differs, naming its digest), `/sync` (200 for `synced`, `written-unrecorded`, `already-written`, `up-to-date`; 502 for `failed`, `blocked`, `unknown`), `/complete {rev}`. Errors: 400 bad input, 403 not owner, 404 unknown task, 409 stale rev / conflicting state / not ready / a requestId reused with another payload, 429 at the turn cap or the open-request cap, 503 store unavailable.

## Assistant tools (Assistant scope, owner only, `tasks` port)

`tasks_list` and `task_inspect` (read-only), `task_create`, `task_steer`, `task_pause` (pause/resume), `task_run_turn`, `task_respond` (answer/decline/link_proposal), `task_update` (next action, follow-up time, project, vault link, dependencies; `autoFollowUp: "off"` only; one atomic change), `task_vault_sync`, `task_attention_ack` and `tasks_project_status` (read-only) (Repair 3). The task's own `task_request` takes `research` as a kind (Repair 3). Not offered in chat threads; refused there by name. The task's own tools are offered only inside its turns and refused by name elsewhere. `src/chat-tools.ts` (pinned) is unchanged.

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
| Automatic follow-up: one bounded turn per due time, operator switch plus Rai's per-task opt-in, claim and start in one store change, restart-safe, bounded pre-dispatch retry, per-task and global turn budgets, visible state | Implemented, tested with a fake clock and end to end (Repair 2); **not enabled on any host** |
| Recurring supervision, self-scheduling, Assistant wakeups or notifications on follow-up events | **Not built** |
| Dependencies between tasks, wall-time and spend budgets per task, cancellation propagated to jobs | **Deferred** (next phase) |
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

## Repair 2: review findings on PR #153

Each finding was reproduced against `main` at 0e8720f by running `test/task-repair2.test.ts` against main's sources (a copy of the test with the one new import removed): the tests named below fail there and pass here.

| # | Finding | Reproduced on main | Fix | Tests |
|---|---|---|---|---|
| 1 | Blocker: the task memory policy compared a normalized string that dropped leading slashes, while the port resolves absolute paths; `<vault root>/Memory/recent-context.md` read the excluded note through `memory_read` and `memory_read_page` | yes: the absolute path, and also `../<root dir name>/Memory/recent-context.md`, returned the note's text through `taskMemory` | canonical path policy (above): absolute, `..`, backslash and control-character spellings refused; the canonical path is checked and handed to the port; write tools get the same | `task-repair2` (real `vaultMemory` on temporary roots: 19 spellings, symlink file and directory aliases, ordinary notes under accepted spellings, search filling its limit, `memory_read_page` denied and an ordinary long note paged to the end, write tools); `task-supervisor` "finding 1" (real server: absolute and root-name spellings through `memory_read` and `memory_read_page` in a supervised turn, automatic excerpts, interactive turn, ordinary chat unchanged) |
| 2 | `priorTurn` invented `state: "done"` for a repeated turn request whose turn record aged out (newest 50 kept) | yes: the repeat returned a made-up record, no error | the repeat is refused 409 with the turn number and "expired"; nothing is prepared, started or numbered; repeats whose record is kept still return its real state (`error`, `interrupted`) | `task-repair2` "finding 2" (errored, interrupted across a restart, evicted; through the store and through `startTurn`, no prepare call, `turnSeq` unchanged on disk) |
| 3 | `revertAdmission` removed the instruction only if it was the last; a steer landing while the turn code awaited compaction/`beforeTurn` left the never-sent message as a durable instruction | yes: deterministic race (admission, Assistant steer in `beforeTurn`, append failure) left v2 on record | removal by identity (version, time, `sessions-ui` author) wherever it is; `instructionSeq` so versions are never reused; the unrun turn's `instructionsSeen` is reset to the previous turn's, so nothing is marked seen that was not sent | `task-repair2` "finding 3" (race, reload from file, next version, thread has no failed message; identity mismatch removes nothing); `task-repair` "finding 2" updated (the retry after a failed admission is v2, not a reused v1) |
| 4 | A file with `v: 0` or a non-integer said "newer than this build" | yes: `v: 0` gave the "newer" message | three refusals: malformed (not a positive whole number), newer, older-unsupported; the file is never overwritten | `task-repair2` "finding 4" (0, -1, 1.5, beyond safe integer, 3, "2") |
| 5 | `humanTurn`'s comment said the thread route checks ownership; `humanTurn` itself does | the 403 already held (test passes on main); the comment was wrong | comment corrected (the route answers anyone the chat channel allows; only `humanTurn` refuses a non-owner in a task session) | `task-repair2` "finding 5" (non-owner, active and cancelled: 403, nothing recorded) |

File version stays 2: `instructionSeq` is an optional field (absent means "the newest version on record"). An older build keeps it untouched but does not use it, so while that older build runs it can still reuse a removed version as before; this build then continues from the higher of the field and the newest version.

## Repair 3: review findings on PR #154, supervisor escalation, and the next increment

Code: `src/tasks.ts`, `src/task-attention.ts` (new), `src/task-scheduler.ts`, `src/task-supervisor.ts`, `src/task-eval.ts` (new), routes in `src/server.ts`, the banner in `src/web/index.html`. Tests: `test/task-repair3.test.ts` (findings), `test/task-attention.test.ts` (attention, research lane, dependencies, vault coherence), `test/task-acceptance.test.ts` (simulated end-to-end walkthrough and the banner in Chromium), `test/task-eval.test.ts` (harness), shared rigs `test/task-rig.ts` and `test/tasks-fixture.ts`. Model routing: `docs/task-model-routing.md`.

### Priority 1: the four reported findings

The findings were reports, not verified facts. Each was reproduced on `main` at 4b39cb4 with a scratch script against main's own store and scheduler before any change (output quoted), then fixed here with regression tests.

| # | Finding | Observed on main | Fix | Tests (`test/task-repair3.test.ts` unless named) |
|---|---|---|---|---|
| a | `task_update` persisted its fields, then errored when automatic follow-up was already off | `nextAction` saved at rev 2, then "Automatic follow-up is already off for this task." | `tasks.updateDetailed`: every field, including `autoFollowUp: "off"`, validated and applied in ONE store change; off-when-off is a no-op; a patch that changes nothing writes nothing (`changed: false`, no rev bump, even from a stale view) | combined update, idempotent off (no write), one-rev combined change, refusal anywhere applies nothing, write failure mid-update, two racing updates from one view |
| b | busy slots consumed the scheduler's retries | slot `gave-up` after 4 attempts: "At most 2 supervised task turns run at once (gave up after 4 attempts)" | capacity (global cap, task session busy) is a **deferral**: `capacity-wait`, no attempt used, retried at the next tick (no backoff, so no hot loop and no extra wait), the scheduler does not call `startTurn` while slots are full, and due tasks are taken **oldest due time first**. Only other pre-dispatch failures use attempts | `task-scheduler` (12 deferrals over hours, then started), no startTurn calls while full, fairness, session busy, real failure still backs off and gives up once, restart while deferred with two racing ticks |
| c | off/on reset a custom daily budget | `perDay` 5 → 2 after off and on | turning on keeps the explicit `perDay` (and `perDaySetBy`); only a new `perDay` from Rai changes it; `started[]` (usage) is never reset | toggles by Rai and the Assistant and a restart; usage still counts after toggling |
| d | turning off validated an irrelevant `perDay` | "perDay must be a whole number from 1 to 6." and still enabled | off ignores `perDay` entirely (`ignored: ["perDay"]`), never applies it; on validates it and changes nothing when it is bad | five junk values; junk while already off; bad value when turning on |

Found while testing (not in the review): the first fairness order compared deferral times, which tie for tasks deferred at the same tick, so the order was random; it now compares due times first. File version stays 2: every new field is optional and an older build keeps unknown fields untouched.

### Priority 2: supervisor attention, the escalation path

**Audit before the change.** Requests (clarification, blocker, job) were durable and deduplicated, and the Assistant saw request ids each turn; but failures (errored or interrupted turns, a follow-up that gave up, a budget wait, a failed vault sync) were only visible as state on the task, nothing said "this needs you", and nothing distinguished "shown to the Assistant" from "dealt with".

**Attention items** (`src/task-attention.ts`, stored as `task.attention[]`): raised by the task store **in the same store change** as their cause, so cause and item are one durable fact.

| Kind | Raised when | Resolved when | Acknowledgeable |
|---|---|---|---|
| `clarification`, `blocker`, `job`, `research` | the task files a request (a repeat counts on the same item) | the request is answered, declined, withdrawn or linked to a proposal | **no**: only answering resolves it (shown is not answered) |
| `turn-failed` | a supervised or automatic turn ends in error (including one a pause cut short); not Rai's own interactive turn | acknowledged | yes |
| `turn-interrupted` | restart recovery marks a running turn interrupted | acknowledged | yes |
| `follow-up-gave-up` | the scheduler gives up on a due time | the follow-up time is replaced | yes |
| `budget` | a due follow-up waits on a turn budget (once per due time) | a turn starts for it, or the follow-up time is replaced | yes |
| `vault-sync` | a sync ends failed, blocked or unknown (one item; repeats counted, an acknowledged one reopens) | a later sync saves, or the vault link changes | yes |
| `launch-not-confirmed`, `dependency-blocked` | **derived** at view time (a linked card expired/cancelled/refused; a dependency cancelled or missing) | the cause clears | no (not stored) |

Each item carries ORBIT's own one-line `summary` (never model text), a `source` (request id, turn number and who started it, follow-up due time, vault note and attempt) and the task `rev` when raised. Lifecycle: `open` → `acknowledged` (Rai or the Assistant, with a note; stays listed) → `resolved` (with why). `surfaced` records when the Assistant was shown an item; it changes nothing else. Unresolved items are never pruned; resolved history is capped at 100.

**Next-turn delivery, and why nothing wakes the Assistant.** The Assistant's task-activity block is built from the store at every owner Assistant turn, so anything raised while it was busy is there next turn, marked `new` until shown once. **Automatic supervisor wake is deferred (not built):** nothing starts an Assistant turn, sends a notification, or pages anyone. Building it needs its own opt-in (default off), restart safety, a rate and budget limit, and no paid fallback; until then attention is durable next-turn context and the Sessions banner.

**Rai's direct steering** is visible to the supervisor: the activity block carries each task's newest instruction from Rai (his own words, the route, whether the task has seen it). It goes to the Assistant only, never into another task's context.

**Dependencies** (`dependsOn`, at most 5, set by Rai's update route or the Assistant's `task_update`): explicit, refused when they would close a cycle (the path is named), met **only** when the other task is `done` (Rai, with attested evidence); a job ending never meets one. An automatic follow-up waits (`dependency-wait`); manual turns still run (the task's context lists the dependency ids and lifecycles only, no other task's content).

**Surfaces.** Assistant: `tasks_list` and `task_inspect` (`attention`, `dependencies`), the task-activity block, `task_attention_ack`, `task_update dependsOn`. Rai: the banner in the task session lists items with kind, state, source and rev, an Acknowledge button for non-request items, and dependency links to the other tasks' sessions; routes `POST /tasks/:id/attention {attention, note?}` (no rev: it is bookkeeping about the item), `POST /tasks/:id/update {rev, ...}`.

### Priority 3: task requests to the Assistant, research lane

Audited: job requests already had exact proposal binding, global exclusivity, rev checks, derived awaiting-confirmation/confirmed/running/result/not-confirmed statuses, and claimed-versus-verified evidence. Added:

- **Research requests** (`task_request kind: research`): linked only to a **research-lane** proposal (`research_launch`, the proposal store's own `lane`), and a build request only to a build proposal; a research request cannot be answered by text either. Binding: the proposal's brief must be `Research question: <request text>` + the request's brief (what `research_launch` builds from those two fields), or exactly the request's brief; the binding records `lane`.
- Unchanged and still tested: a task never launches, links, confirms or approves; duplicate links are refused across all tasks; stale revs are refused; a job's or research run's result is never task completion and model text never becomes verified evidence. When the research lane is not configured, `research_launch` refuses (as before) and the request stays pending for the Assistant to decline with that reason: no build is ever substituted.

### Priority 4: vault coherence

- Each linked note has a derived `coherence` state: `pending` (never synced), `current` (the last saved line states today's facts), `stale` (saved earlier, the task changed since), `failed`, `blocked`, `unknown`. Failures are attention items until a later sync saves.
- `GET /tasks/projects` and the Assistant's `tasks_project_status`: read-only reconciliation per project (lifecycles, open attention, unmet dependencies, vault states, which tasks need a sync). It writes and syncs nothing.
- Unchanged: sync is manual, through the existing policy-checked pipeline (secret refusal, AGENTS classification, protected notes blocked without proposals), idempotent by key, and reports the vault write and the bookkeeping separately. No automatic sync and no write loop were added. Tests use fake ports and temporary repositories only; no real vault was written.

### Priority 5: model routing readiness

`docs/task-model-routing.md`: current routing as read from the code (task turns use the same port as every turn; no paid fallback in task turns), requirements on any future routing, and `src/task-eval.ts`, an offline harness with six synthetic scenarios (planning, tool correctness, context isolation, interruption recovery, escalation, cost and latency) that fails closed on a model not in its allow list, not live, or without tools. No model is recommended; the questions and decision criteria for a separate evaluation are listed there.

### The recurring bootstrap flake

`test/research-bootstrap.test.ts` "connection reset during the TLS handshake" failed in the baseline full run. Reproduced: 0 of 30 runs alone, 26 of 36 with 12 copies in parallel. Cause: under load the test server's reset arrives before curl's non-blocking connect completes, and curl reports exit 7 (`connect-failed`) instead of 35/52/56. The bootstrap classifies exit 7 as a retried connect failure, so its behaviour was right and the expectation too narrow (the `orbit-research` tool test in the same file already accepts exit 7 for the same reason). The two reset tests now accept exit 7; 36 of 36 passed under the same load.

### Acceptance matrix (Repair 3)

Simulated means: the real server and stores over temporary directories, a scripted model, the fixture's fake routine, fake vault ports. **None of this is live production validation.**

| Capability | State | Evidence |
|---|---|---|
| Findings a-d fixed, with race, retry and restart tests | Implemented, tested | `task-repair3`, `task-scheduler` |
| Task creation and session navigation; two tasks | Implemented, tested (simulated) | `task-acceptance` steps 1, 2 |
| Direct (Sessions) and Assistant steering, visible to the supervisor | Implemented, tested (simulated) | `task-acceptance` step 3 |
| Two concurrent tasks, capacity deferral, then start | Implemented, tested (simulated) | `task-acceptance` step 4 |
| Escalation round trip: request → attention (new) → shown, still open → link → resolved → Rai confirms → running → result | Implemented, tested (simulated, fake routine) | `task-acceptance` steps 6, 7 |
| Refused launch (card cancelled) → not-confirmed, derived attention, nothing ran | Implemented, tested (simulated) | `task-acceptance` step 8 |
| Vault sync failure (unknown), retry, idempotent, attention raised and resolved | Implemented, tested (fake port) | `task-acceptance` step 10, `task-attention` |
| Due scheduled turn; budget exhaustion with attention | Implemented, tested (simulated, operator switch on in the test only) | `task-acceptance` steps 4, 5 |
| Pause/resume; aborted turn as attention; acknowledgement | Implemented, tested (simulated) | `task-acceptance` step 11 |
| Restart/unknown interruption recovery as attention | Implemented, tested | `task-acceptance` step 12, `task-repair3` |
| No task can turn automatic follow-up on, approve, mark itself done, or have claims counted | Implemented, tested | `task-acceptance` step 13, `task-attention` |
| Prior regressions: isolation absolute paths, atomic admission/rollback, photo-only input | Tested (unchanged suites pass) | `task-supervisor`, `task-repair`, `task-repair2` |
| Banner attention, sources, Acknowledge, dependency links, light/dark, desktop/phone, no horizontal overflow | Implemented, tested (Chromium) | `task-acceptance` page test |
| Research requests on the research lane only | Implemented, tested (unit, fake proposals) | `task-attention` |
| Dependencies with cycle detection, done-only, dependency-wait | Implemented, tested | `task-attention`, `task-acceptance` step 2 |
| Project reconciliation, read-only | Implemented, tested | `task-attention`, `task-acceptance` step 10 |
| Evaluation harness, fail closed, no fallback | Implemented, tested (scripted ports) | `task-eval` |
| Research request end to end through a configured research lane on the server | **Partial**: unit-tested binding with fake proposals; not run through `research_launch` on the server | |
| Attention surfaced in the Sessions list (per-session badge) and the Assistant page | **Partial**: in the task banner and the Assistant's model context only | |
| Automatic supervisor wake (an Assistant turn or notification on new attention) | **Deferred** (not built; see above) | |
| Vault schema mapping, reading human edits back, sync on change | **Deferred** (unchanged) | |
| Cancellation propagated to cards and jobs; wall-time and spend budgets | **Deferred** (unchanged) | |
| Real model evaluation, routing changes | **Deferred**: separate, approved evaluation | |
| Live host verification | **Not done** | |

### Operator acceptance runbook (for later live testing; nothing here was run on a host)

Preconditions: an ORBIT built from this change, the owner signed in, a model port that can call tools, `ORBIT_TASK_FOLLOWUPS` **unset** (automatic follow-up off) unless step 6 is being tested on purpose, and a throwaway vault note under `Tasks/` with a `## Status` heading for step 5.

1. **Create and navigate.** Ask the Assistant to create two small synthetic tasks under one project. Open each session link; each banner says `active`, `No turn has run yet`.
2. **Dependencies.** Ask the Assistant to make the second depend on the first. The second banner shows "Depends on (waiting)" with a link that opens the first. Ask for the reverse dependency: refused as a cycle, nothing changed.
3. **Steering.** Write an instruction in the first task's session. Ask the Assistant "what's new on my tasks?": it should quote your instruction as yours and say whether the task has seen it.
4. **Escalation.** Run one turn of the first task and get it to ask for a job (or a clarification). The banner shows "Needs attention" with the request; ask the Assistant: it names the request, and its next turn still shows it open until it answers. For a job: it proposes, links, and the card waits for your Confirm. Cancel one card and confirm another; the cancelled one shows not-confirmed, the confirmed one running, then result; the task stays active.
5. **Vault.** Link the throwaway note and sync: `current`. Change the next action: `stale`. Unlink the note's heading in the vault (or point at a missing note) and sync: the banner shows a vault-sync attention item and nothing is written; fix it and sync: resolved, one new line.
6. **Automatic follow-up (only with the operator switch on, on a test host).** Opt a task in from the banner with `perDay` 1, set a follow-up a minute ahead, keep the other task's turn running: the opted-in task shows `capacity-wait` with attempts 0, then starts once the slot frees. Set a second follow-up: `budget-task` and a budget attention item. Turn it off twice: the second is a no-op.
7. **Pause and restart.** Pause during a running turn: the turn ends with an error and an attention item. Restart ORBIT during a running turn: the turn shows `interrupted` and an attention item; nothing re-runs.
8. **Completion.** Attest each criterion yourself and mark done; the dependent task's dependency becomes met.

Record for each step: what the banner showed, what the Assistant said, and the task's `GET /tasks/:id` excerpt. Any mismatch is a defect.

### Activation prerequisites (none are changed by this work)

- Automatic follow-up stays off: `ORBIT_TASK_FOLLOWUPS=on` on the host **and** Rai's per-task opt-in are both still required; no deploy file sets the first.
- Vault sync needs the vault clone and its credential on the host (as before) and runs only when asked.
- The research lane needs its own routine configuration (docs/research-lane.md); without it research requests can only be declined.
- Automatic supervisor wake does not exist; activating one later needs a separate design and opt-in.
- No new environment variables, providers, credentials or paid features are introduced.

### Remaining work (exact)

1. A server-level test of a research request through `research_launch` with a configured research lane, and a banner action to answer a request from Sessions (Rai can answer through the Assistant or `POST /tasks/:id/respond` today).
2. A Sessions-list badge for task sessions with open attention, and an attention count on the Assistant page.
3. The opt-in automatic supervisor wake (design first: default off, restart-safe claim, rate and budget limits, no paid fallback).
4. Vault schema mapping and reading human edits back (needs the vault's task schema reviewed); cancellation propagated to open cards and running jobs as proposals Rai confirms.
5. A recorded evaluation of candidate models with the harness, approved separately (docs/task-model-routing.md lists the questions).
6. Live verification on a host with the runbook above.

### Limits (Repair 3)

- Simulated only: scripted models, fake routine, fake vault ports; nothing ran on a host or against a real model or vault.
- `surfaced` is recorded when the activity block is built for an Assistant turn; if that turn then fails before the model reads it, the item still says surfaced (it stays open and listed, only the `new` marker is lost).
- An older build (rollback) keeps the new fields but does not maintain them: it does not raise or resolve attention items. A request item whose request was answered meanwhile is not shown as waiting (derived), but other items may be left open until acknowledged.
- Deferral bookkeeping writes the task file once per deferred task per tick (one minute) while slots stay full.
- The page check covers the task banner only (two widths, two schemes); other pages were not changed.

## Repair 4: review findings on PR #155, attention delivery, supervisor wake, lifecycles, cancellation, routing

Code: `src/task-attention.ts` (resolution by acknowledgement, ordering, record repair, delivery fields), `src/tasks.ts` (rev checks on no-ops, capacity-wait attention, `repairAttention`, `markUndelivered`, `recordCancellation`, `vault.sync.pending`, `TurnRecord.route`), `src/task-supervisor.ts` (`activity`/`delivered`/`undelivered`, ordered attention, `attentionSummary`, cancellation coordination, routed turns), `src/task-wake.ts` (new: the opt-in supervisor wake), `src/task-routing.ts` (new: the task-turn routing table), `src/task-vault.ts` (pending marker), `src/task-eval.ts` (path confinement), `src/server.ts` (delivery after the Assistant turn, wake turn and routes, `/tasks/attention`, Sessions-list counts, card withdrawal on cancel, routing), `src/assistant-store.ts`/`src/threads.ts` (`author: "orbit-wake"`), `src/main.ts` (`ORBIT_SUPERVISOR_WAKE`, `<state>/supervisor-wake.json`), `src/web/index.html` (Sessions list and tab counts, the Assistant page's task strip and wake control). Tests: `test/task-repair4.test.ts` (unit: findings, delivery, wake, routing, vault recovery), `test/task-repair4-server.test.ts` (server: research and build lifecycles, cancellation, delivery through the Assistant route, wake end to end, the pages in Chromium), `test/task-walkthrough4.test.ts` (the combined walkthrough with a restart), `test/task-eval.test.ts` (new fixtures).

### Priority 1: the four reported findings

Reports, not proven defects. Each was reproduced on `main` at 2eead11 (a scratch test against main's own store, scheduler and harness, run in a separate worktree; output quoted) before it was fixed.

| # | Finding | Observed on main | Fix | Tests |
|---|---|---|---|---|
| 1 (blocking) | acknowledged `turn-failed`/`turn-interrupted` items were never resolved or pruned and, five of them, pushed newer attention out of the bounded activity block | five acknowledges each answered `acknowledged`; the block then showed `turn-failed:acknowledged` ×5 and not the new blocker, whose `surfaced` stayed `null` | acknowledging a past turn outcome **resolves** it (the ADR's own rule), keeping the `ack` (who, when, note) on the resolved item; items are shown **most actionable first** (undelivered requests, other undelivered items, delivered-but-open requests, other open items, derived, acknowledged; oldest first within each group) with `notShown` counting the rest; tasks with the same score are ordered by their oldest undelivered item; resolved history is pruned by resolution time with a count (`attentionPruned`); stored records are **repaired once at start** (`repairAttention`: acknowledged turn items and request items whose request is no longer pending are resolved; idempotent; no rev bump) and every view applies the same rules read-only, so a record is shown right even before (or without) the repair write | `task-repair4`: reproduction, ordering, no starvation with more than 5 items per task and more than 8 tasks, record repair (write failure, idempotency, ack kept); `task-acceptance` step 11 updated |
| 2 | a capacity deferral never gave up and never raised attention | 180 ticks over 3 hours: `capacity-wait`, 180 deferrals, 0 attempts, 0 attention items, 180 file writes | still a deferral (no attempt, no backoff beyond the 1-minute tick, oldest due first, never gives up for capacity alone), but a wait longer than `AUTO_CAPACITY_ATTENTION_MS` (30 minutes) raises **one** `capacity-wait` item per due time (later deferrals only move its time; an acknowledged one is not reopened); it resolves when the turn starts or the follow-up time is replaced | `task-repair4` (session busy for 35+ ticks; short waits raise nothing), `task-scheduler` updated |
| 3 | no-op paths skipped the rev check | `updateDetailed(rev+7, {})` and `setAutoDetailed(rev+7, off)` both answered `changed: false` | the same `staleCheck` runs on every mutation path, including no-ops: a stale rev is 409 whether or not anything would change; from the current rev a no-op still writes nothing | `task-repair4`, `task-repair3` finding-a test updated |
| 4 | the eval harness wrote scenario vault paths without confinement | a scenario path `../../escaped-by-eval.md` **was written outside** the harness's temporary vault | every scenario path is checked before anything runs (`scenarioPathProblem`: relative, plain segments, no `..`/`.`/empty segments, no absolute, `~`, drive letter, backslash or control character); writes go through `writeConfined` (each directory created here or a real directory, a symbolic link anywhere refused, the parent's real path inside the root's, `O_CREAT|O_EXCL|O_NOFOLLOW`) | `task-repair4`: spellings, symlinked directory, planted file link, no overwrite, refusal before any model call |

What is and is not guaranteed after the fix: unresolved items are never dropped; resolved items beyond 100 per task are dropped with a count; the block shows at most 8 tasks and 5 items per task per Assistant turn, so delivery of a large backlog takes several completed turns (each delivers what it showed; nothing is skipped). Deferral bookkeeping still writes the task file once per deferred task per tick (1/minute), which is bounded but not free.

### Delivery is not acknowledgement or resolution

Before: `surfaced` was written when the activity block was built, so an Assistant turn that then failed or was interrupted still marked its items as seen (a Repair 3 limit). Now the block records nothing; the server marks what it showed **delivered** (`surfaced`) only after the Assistant turn completed without an error, and counts a failed turn on each item (`undelivered`). An interrupted turn (ORBIT stopped) records nothing, so its items stay `new`. Delivery never acknowledges or resolves: a delivered request stays open until it is answered. Tests: `task-repair4` (failed, interrupted, restart), `task-repair4-server` (a model failure through `POST /assistant/messages`, then a completed turn).

### Attention in Sessions and the Assistant page

`GET /threads` (owner) carries `task: {task, lifecycle, open, new, derived}` on each task session; the Sessions list says "N need(s) attention (M new)" on that row (gold edge as a cue only) and the Sessions tab shows how many task sessions need attention. `GET /tasks/attention` (owner) returns counts per task with session links; the Assistant page shows a strip "Tasks needing attention" linking to each task session, and the wake control where the operator switch is on. Reading these delivers nothing. Checked in Chromium at 1200×900 and 390×844, light and dark, no horizontal overflow (`task-repair4-server` page test).

### The opt-in supervisor wake (`src/task-wake.ts`)

Off by default at two levels, both required: the operator's `ORBIT_SUPERVISOR_WAKE=on` (no deploy file sets it) and Rai's own opt-in (`POST /tasks/wake {enabled, perDay?}`, the Assistant page's "Allow supervisor wake"). No model can turn it on; the Assistant has no tool for it.

| Bound | Value |
|---|---|
| Trigger | open attention that no completed Assistant turn was given (`new`) |
| Concurrency | one wake at a time; never while the Assistant has a reply in progress (then nothing is claimed; the attention stays pending) |
| Rate | at least 20 minutes between wake starts |
| Budget | `perDay` wake turns per rolling 24 hours (default 4, at most 12); counts turns, not spend |
| Retries | an item causes at most 2 wakes; then it waits for Rai's next Assistant turn (shown as `waitingForRai`, never marked handled) |
| Failures | 3 wake turns in a row ending in an error pause it with the reason; only Rai resumes |
| Turn | one Assistant turn authored `orbit-wake` ("ORBIT supervisor wake", never Rai), at most 6 tool rounds, **no paid fallback**, tools: read-only ones plus `task_respond`, `task_attention_ack`, `task_steer`, `task_update`, `job_launch`, `research_launch` (proposals: cards wait for Rai's Confirm); no vault writes, ops, workspace changes, task turns, task creation, pause/resume or vault sync |
| Restart | claimed (written `running`, with its items and try counts) before the turn starts; nothing starts if that write fails; a wake still `running` at start becomes `interrupted` and is never re-run; its items stay undelivered |
| Controls | `GET /tasks/wake`, `POST /tasks/wake {enabled, perDay?}`, `POST /tasks/wake/pause {paused, reason?}` (Rai only); turning it off or unsetting the operator switch stops it |

Rai's own send while a wake turn runs is refused (409) as for another tab; nothing is queued or lost. Tests: `task-repair4` (defaults, opt-in authority, rate, budget, retry limit, busy, not-started, claim on disk, restart, failure pause), `task-repair4-server` (end to end through the server, tools offered and withheld, fallback off, author, delivery), `task-walkthrough4` (restart during a wake).

### Task requests: build and research lifecycles

Unchanged rules, now tested end to end through the server for both lanes: the task requests; the Assistant evaluates and proposes on the request's own lane (`job_launch` for build, `research_launch` for research, whose brief is `Research question: <request text>` + the request's brief); the link binds the proposal to that task, request, lane and brief (exact or Rai's digest acceptance) and is globally exclusive; only Rai's Confirm launches; status is derived (`awaiting-confirmation` → `confirmed` → `running` → `result`, or `not-confirmed`); a repeat link is a duplicate; a build proposal never answers research nor text a launch request. A runner's summary ("done", "approved") is a run result: the task's evidence citing it stays `claimed`; `execution: verified` says only that ORBIT's own records tie the job to the request; completion remains Rai's attestation (`task-repair4-server`: research and build lifecycle tests).

### Cancellation: task versus cloud job

Cancelling a task (Rai only) stops a running supervised turn of it and, new here, **withdraws the task's open launch cards** exactly as the card's own Cancel does (nothing launches for a cancelled task). It does **not** and cannot stop a cloud job: ORBIT has no job cancellation. The cancel answer and the task (`cancellation.recorded`, written right after the cancel) list each launch request with its outcome: `card-withdrawn`, `card-not-withdrawn` (with why), `continuing` ("NOT stopped: ORBIT cannot cancel a cloud job"), `ended` (already ended before), `not-launched`, `unknown`; `jobCancellation: "unsupported"`. The view's `cancellation.now` follows the job store, so a continuing run is shown until the job store says it ended. Tests: `task-repair4-server`, `task-walkthrough4` step 11.

### Vault mapping and recovery

Unchanged: explicit link (note under `Projects/` or `Tasks/`, existing heading), append-only through the policy-checked pipeline, protected notes `blocked` without proposals, idempotent by key, manual retry, project association by `project` and read-only reconciliation (`GET /tasks/projects`). New: the sync records `pending {key, at}` **before** the vault write and clears it with the outcome. If the outcome can never be recorded (ORBIT stopped mid-write, or the record after a successful write failed), the task shows coherence **`unconfirmed`** with the attempt time instead of silently keeping its previous state; the retry finds the line by its key, writes no second line and records it. If the pre-write record fails, nothing is written to the vault. Rai's text is never touched (append only). Tests use fake ports only: `task-repair4` (restart in between), `task-walkthrough4` step 10. No real vault was written.

### Task-turn model routing (`src/task-routing.ts`)

An explicit table from turn kind (`supervised`, `automatic`, `interactive`) to configured model ports (`Deps.taskModels: {ports, routes}`). No table (main.ts configures none): every task turn uses the default port, exactly as before. A route to an unknown port, a port marked `paid`, or a port that cannot call tools refuses that kind of turn (503, with the reason; no silent fallback). Each turn records the actual `impl` and, when routed, the port name (`TurnRecord.route`); `GET /tasks` reports the table (`routing`). Task turns never use the paid fallback on any port. No provider is added and no model is recommended. See docs/task-model-routing.md for the deferred real-model evaluation plan.

### Acceptance matrix (Repair 4)

Simulated means: the real server and stores over temporary directories, scripted models, the fixture's fake routines, fake vault ports, operator switches on inside tests only. **None of this is live production validation.**

| Capability | State | Evidence |
|---|---|---|
| Finding 1: acknowledged turn items resolved, ordering, no starvation, record repair | Implemented, tested | `task-repair4` (4 tests), `task-acceptance` |
| Finding 2: prolonged capacity wait surfaced, no attempts, no hot loop, oldest first | Implemented, tested | `task-repair4` (2), `task-scheduler` |
| Finding 3: rev checks on no-op updates | Implemented, tested | `task-repair4`, `task-repair3` |
| Finding 4: eval path confinement (traversal, absolute, symlinks) | Implemented, tested | `task-repair4` (3) |
| Delivery distinct from acknowledgement/resolution; failed and interrupted Assistant turns; restart | Implemented, tested | `task-repair4`, `task-repair4-server` |
| Attention badges and counts in Sessions and the Assistant page with session links | Implemented, tested (Chromium, light/dark, desktop/phone) | `task-repair4-server` page test |
| Rai's direct steering visible to the supervisor | Implemented (Repair 3), tested again | `task-walkthrough4` step 2 |
| Opt-in supervisor wake: default off, restart-safe, concurrency, rate, retry, budget, pause, no paid fallback, no approvals | Implemented, tested (simulated; operator switch on in tests only) | `task-repair4` (3), `task-repair4-server`, `task-walkthrough4` |
| Build request lifecycle (refusal, cancellation of a card, re-proposal, confirm, running, result, cross-task duplicate) | Tested end to end (fake routine) | `task-repair4-server` |
| Research request lifecycle on the research lane through `research_launch` (configured lane, fake research routine) | Tested end to end | `task-repair4-server` |
| Runner claims unverified; job completion is not task completion | Tested | `task-repair4-server`, `task-walkthrough4` step 12 |
| Cancellation truthfulness (cards withdrawn, jobs continuing, unsupported) | Implemented, tested | `task-repair4-server`, `task-walkthrough4` step 11 |
| Vault pending/unconfirmed recovery; Rai's text untouched | Implemented, tested (fake ports) | `task-repair4`, `task-walkthrough4` step 10 |
| Routing table, fail closed, default unchanged | Implemented, tested (scripted ports); **not configured** anywhere | `task-repair4` |
| Combined walkthrough: create/link, steering, concurrency, dependency, blocker escalation, follow-up and wake opt-ins, budgets, pause/resume, restart with interruption, vault recovery, cancellation, human-only completion | Tested (simulated) | `task-walkthrough4` |
| Prior regressions: memory exclusion including absolute paths, atomic admission and rollback, photo-only input | Unchanged suites pass | `task-supervisor`, `task-repair`, `task-repair2`, eval fixture `context-isolation-absolute-path` |
| Evaluation fixtures (9 scenarios, offline) | Extended, tested with scripted ports | `task-eval` |
| Real-model evaluation, routing changes, new providers | **Deferred** (plan in docs/task-model-routing.md) | |
| Vault schema mapping (front matter, checkboxes), reading human edits back, sync on change | **Deferred** (needs the vault's task schema reviewed) | |
| Live host verification | **Not done** (runbook: docs/task-live-runbook.md) | |

### Remaining work (exact)

1. Live verification on a host with docs/task-live-runbook.md (nothing here ran on a host).
2. A recorded real-model evaluation with the harness, approved separately, before any routing table is configured.
3. Vault schema mapping and reading human edits back, after the vault's task schema is reviewed.
4. A banner action to answer a clarification or blocker from Sessions (Rai answers through the Assistant or `POST /tasks/:id/respond` today).
5. Wall-time and spend budgets (the follow-up and wake budgets count turns, not money).

### Limits (Repair 4)

- Simulated only. The wake was exercised with a scripted model; its usefulness with a real model is unmeasured.
- A wake turn is an Assistant turn: it appears in Rai's Assistant conversation (labeled), takes the Assistant's lock while it runs (Rai's send then gets 409), and feeds the Assistant's rolling summary like any turn.
- Withdrawing open cards on cancel uses the proposal store and the card; a card made before a restart is already expired (shown `not-launched`).
- The wake's try limit counts wakes per item, not model calls; an item that waits for Rai stays visible in the strip and the banner.
- The Sessions badge reads task counts from the task store at list time; it refreshes with the Sessions poll, not instantly.

## Next slice (prioritized plan; not built here)

Written after Repair 1. Repair 2 built a smaller version of items 1 and 2 (automatic follow-up, above): the claim lives in the task record's `auto.slot` instead of a separate wakeup table, an interrupted turn is never re-run (instead of retried once), and budgets count turns, not wall time or spend. What remains of items 1-2: wall-time and spend budgets, over-budget pausing, and a global daily cap shown on /status. Items 3 and 4 are unchanged.

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
- Automatic follow-up (Repair 2) was tested offline only (fake clock, scripted model); it has not run on a host. Budgets count turns, not spend. The scheduler's tick is per process; ORBIT is one process, and two processes over one state directory are not supported (as for every store here). The task banner shows the state and the on/off control; its phone layout was not checked.
