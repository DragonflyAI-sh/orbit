# Launch reconciliation: the registered, no-events launch of `orbit-202611180118-hcey`

Diagnostic job `orbit-202611180238-cajq`, 2026-11-18. Read-only diagnosis of one ambiguous launch, a narrow fix to how ORBIT records
and reports launch dispatch, and a plan for the next stage. **This document does not say whether the original launch ran.** The
repository evidence cannot settle it, and the live records that could settle it were not available to this job (see
[Owner checklist](#owner-read-only-reconciliation-checklist)).

Nothing in this job relaunched, retried, cancelled, steered or messaged the original job or any cloud session, and nothing here adds
automatic retries.

## 1. The launch in question

| Item | Value | Source |
|---|---|---|
| Job id | `orbit-202611180118-hcey` | diagnostic brief |
| Registered | 2026-11-18T01:18:14Z | diagnostic brief (ORBIT record) |
| Brief commit | `9f36a472f088bfcf85da5d222676b0d82a97044d` on `DragonflyAI-sh/orbit-work`, branch `orbit/orbit-202611180118-hcey`, committed 2026-11-18T01:18:16Z | git, verified |
| ORBIT record as reported | no events, no tool commit, health `not-started` | diagnostic brief. Not seen by this job: whether `launch.sessionId` / `launch.sessionUrl` are set is **not known** |
| Routine | `orbit` (prefix of the id) | `src/job-launch.ts:60` id format |
| What it was for | first prerequisite of the shell/filesystem tool plan: a bounded, read-only host capability inventory through the existing ops helper, and a staged security design | the brief file at `9f36a47:.orbit/brief.md` (4,875 bytes, read in full from git) |

## 2. Repository findings (verified)

These were checked in git or in the code at `main` = `4297487`.

**F1. The original job's control branch holds the brief and nothing else.** `orbit/orbit-202611180118-hcey` on `orbit-work` points at
`9f36a47`, one commit on top of `main`, touching only `.orbit/brief.md`. There is no `.orbit/started.json`, no `checkins.jsonl` and no
`summary.md`. `DragonflyAI-sh/orbit` has no `orbit/orbit-202611180118-hcey` branch. So no runner reached `orbit-job start` with a working
git push for that job. This does **not** show that no session was created (see F5).

**F2. Neighbouring launches did start.** Every other `orbit` job on 2026-11-18 before 02:38Z wrote `started.json` within about a minute:

| Job | Brief | Runner start | Tool commit the runner reported |
|---|---|---|---|
| `orbit-202611180030-4fjn` | 00:30Z | yes | `2d2228b4…` |
| `orbit-202611180118-hcey` | 01:18:16Z | **no** | none |
| `orbit-202611180123-rqry` | 01:23:30Z | 01:23:55Z | `32bfcc7b…` |
| `orbit-202611180141-omjx` | 01:41Z | yes | `32bfcc7b…` |
| `orbit-202611180235-o1mu` | 02:35Z | yes | `4297487b…` |

**F3. ORBIT's running release changed between 00:30Z and 01:23Z, around the original launch.** `696b9d9` (#118) merged at 01:14:29Z and
`32bfcc7` (#119) at 01:15:09Z. The 01:23:30Z launch was fired by a process running `32bfcc7` (the fire text's tool commit is the running
release, `src/job-launch.ts:16-20`; the runner echoed it). The deploy timer polls every 2 minutes (`deploy/systemd/orbit-deploy.timer`) and a
deploy restarts `orbit` (`deploy/pull-deploy.sh`, `switch_and_verify`). So at least one restart happened between 01:15Z and 01:23:30Z. Its
exact time is not in the repository.

**F4. A restart during a launch abandons the fire and leaves no outcome.** The launch path (`src/job-launch.ts`) registers the job, writes
the brief, stores the brief commit, then awaits `routine.fire()`. Only when that promise settles does it store `sessionId`/`sessionUrl` or
`failedAt`/`error`. The SIGTERM handler (`src/main.ts:183-187`) waits only for the ChatGPT renewal (at most 10 s) and then calls
`process.exit(0)`; it does not wait for launches in flight. If ORBIT stops after the fire request is sent and before the answer is
stored, the record keeps `briefCommit` with no session and no failure, permanently. `health()` then reports `not-started` after 10 minutes,
the same as for a session the provider accepted that never reported.

**F5. Missing callbacks cannot show that no session exists.** A session can stop before `orbit-job start`: the Routine prompt checks the
tool commit first (exactly 40 lowercase hex characters, an ancestor of `orbit` main) and stops on any failure. `toolCommit()`
(`src/job-launch.ts:17-20`) accepts 7–64 hex characters or sends `unknown`. A session can also fail to start, or fail on both the API and
the git push. None of these leave anything in ORBIT's record or in `orbit-work`. Before this change the tool commit that was sent was not
stored on the job at all.

**F6. The fire's failure text overstated what was known.** Every fire exception was recorded as `routine not fired: …` with health
`launch-failed` (`src/job-launch.ts`, before this change). A connection reset or timeout after the request was sent, or a 5xx, may still
have created a session. A 2xx with no session id means the provider accepted the request.

**F7. Two follow-on gaps meant a runner that did start could never clear `launch-failed`.** `health()` returned `launch-failed` whenever
`failedAt` was set, even after the runner reported. The git reconciler skipped every job with `failedAt` (`src/launcher.ts`, before this
change), so a start found only in git was never recorded.

**F8. The work-session layer already has an "ambiguous" state.** `src/work-sessions.ts:162-173` classifies a confirmation's link as
`ambiguous` when the job has a brief commit and no fire result, and `reconcile()` runs at every start (`src/server.ts:382-391`), logging
`work_link_reconciled`. So if ORBIT restarted mid-fire, the original confirmation's link should be recorded as `ambiguous` with a
`repairBasis` (see the checklist, step 2). The job record itself, the jobs page and the not-started alert did not show that distinction.

## 3. What can cause a registered job with no events

| Window | What happens | What the record held before this change | Can a session exist? |
|---|---|---|---|
| W1 brief write in flight, ORBIT stops | job registered, no launch record | no `launch` at all; health stays `ok` forever | no: the fire is only sent after the brief commit is stored |
| W2 brief write fails | `failedAt`, `brief not written` | `launch-failed` | no |
| W3 fire in flight, ORBIT stops (restart, deploy, crash) | brief commit stored, fire never settles | `briefCommit` only; `not-started` | **unknown** |
| W4 fire fails without a provider answer (reset, timeout) | `failedAt`, `routine not fired: fetch failed` | `launch-failed` | **unknown** |
| W5 provider 5xx | `failedAt`, `HTTP 5xx` | `launch-failed` | **unknown** |
| W6 provider 4xx | `failedAt`, `HTTP 4xx` | `launch-failed` | not expected (the provider refused the request) |
| W7 provider 2xx without a session id | `failedAt`, `returned no session` | `launch-failed` | **yes**, id unknown |
| W8 provider accepted, runner stops before `start` (tool-commit check, startup failure) | `sessionId` stored | `not-started` | **yes** |
| W9 runner started, API and git push both failed | `sessionId` stored | `not-started` | **yes** |

The original launch's reported state (brief commit, no events, `not-started`, no `failedAt`) matches **W3, W8 or W9** and nothing else.
The `launch.sessionId` field decides between them: absent means W3, present means W8 or W9. That field was not visible to this job.

## 4. Change made: record and report dispatch evidence (backward compatible)

All of it is additive or narrows a misleading report. The fire text, the token handling, the API routes and the stored `error` prefix are
unchanged. Nothing retries, redispatches, cancels or calls the provider beyond the existing single fire.

* **Persisted before each step** (`src/job-launch.ts`): the launch record is written as soon as the job is registered (closes W1's blind
  spot). `fireStartedAt` and `toolCommitSent` (the `Tool commit:` line, a commit id or `unknown`, never the token) are written immediately
  before the fire request. `firedAt` is written with the session, and `fireFailure` with any failure. New fields are optional on `Launch`
  (`src/jobs.ts`), and older records still read.
* **Classified fire failures** (`src/launcher.ts`, `RoutineFireError`, `fireFailureOf`): `rejected` (4xx), `server-error` (5xx),
  `no-session` (2xx without a usable session) and `transport` (anything else, including unclassified errors). Error messages keep the
  `routine not fired:` prefix that existing readers match. When the provider may have received the request, the message adds
  `(outcome unknown: the request may have reached the provider)`, and the notification says it was not retried.
* **`dispatchEvidence(job)`** (`src/launch-evidence.ts`): a read-only classification with a basis and a caveat. The states are
  `no-launch-record`, `in-flight`, `never-dispatched`, `dispatch-unknown`, `provider-rejected`, `provider-accepted` and `runner-reported`. Legacy records
  (no `fireStartedAt`) are read conservatively, and a missing field is never taken as proof of no dispatch. Every state where a session may
  exist carries the caveat "No runner callback is not evidence that no cloud session exists". `in-flight` lasts 30 minutes (longer than
  fetch's default timeouts let a request hang), after which a launch with no result was cut off by ORBIT stopping.
* **Reported where people look**: `/jobs/:id` and `/jobs` (`dispatch` object), the jobs-page rows (`dispatch` state), the `job_status`
  tool view (state, plus basis and caveat while the runner has said nothing; `src/job-view.ts`), and the not-started alert
  (`src/watch.ts`), which now ends with `Dispatch: <state> (<basis>)`. `health` keeps its existing values. The `jobs_list` rows are
  unchanged, so they stay inside the model's 8,000-character tool-result clip.
* **A runner that reports outranks a recorded failure**: `health()` shows `launch-failed` only while the job has no events, and
  `status()` counts such a job as active again. `src/work-sessions.ts` evidence also ranks events first. The git reconciler still reads a
  failed launch unless it is provably `never-dispatched` or `provider-rejected`. That is read-only GitHub access, never a retry.

Not changed, and deliberately left for a decision: the shutdown handler still does not wait for launches in flight (F4). A bounded wait
of a few seconds would shrink W3 but cannot remove it, so it should be a separate, reviewed change. No fire timeout was added, because a
timeout turns a hang into W4 rather than removing the uncertainty.

### Tests

`test/launch-evidence.test.ts` (synthetic only: fake GitHub, fake Routine, in-memory stores, no network):

* W3 reproduced with a fire that never settles: the record holds `briefCommit`, `fireStartedAt` and `toolCommitSent`. It reads
  `in-flight` and then `dispatch-unknown`, while `health` is `not-started`, identical to W8.
* W1 reproduced with a brief write that never settles: `in-flight`, then `never-dispatched`, and the routine is never fired.
* W2 gives `never-dispatched`. W8 gives `provider-accepted` with the session id and the callback caveat.
* The trigger classifies 401/429 (rejected), 502 (server-error), 2xx with empty or invalid body (no-session) and a network rejection
  (transport). An unclassified error is never read as a refusal.
* Each failure kind is stored, keeps the `routine not fired` prefix and maps to the right dispatch state. Only unknown outcomes say "Not
  retried".
* W4 followed by a runner start: health leaves `launch-failed`, the status count includes the job, and the failure stays in the record.
* The git reconciler reads only the unknown-outcome failure, never a 4xx refusal or a failed brief write.
* Legacy record shapes are covered, including the reported shape of `orbit-202611180118-hcey`. It is `dispatch-unknown` without a session id
  and `provider-accepted` with one, which shows the record alone cannot resolve it.
* A tool commit the Routine prompt would refuse is called out, and the token is never stored on the launch record.
* The fire text is unchanged. Views and the not-started alert carry the evidence, and `jobs_list` rows stay unchanged. Work-session
  evidence ranks runner events first.

## 5. Unverified production hypotheses

These are consistent with the repository evidence but **not verified**. Do not act on them without the checklist below.

* **H1 (W3): a deploy restart interrupted the fire.** The release changed between 01:15Z and 01:23:30Z (F3), the original brief was written at
  01:18:16Z, and the fire follows the brief write within milliseconds. If `orbit` received SIGTERM in that window, the record would look
  exactly as reported. A session may or may not exist. This would also explain why only this launch, among its neighbours, did not start.
* **H2 (W8): the provider accepted the fire, and the session stopped before `orbit-job start`.** For example it hit a startup failure, or
  its tool-commit check failed (for instance if the fire carried a commit the session's fresh clone could not yet fetch). The commits that
  could have been sent (`2d2228b`, `696b9d9`, `32bfcc7`) were all on `main` by 01:15:09Z, which makes the tool-commit variant less likely
  but does not exclude it.
* **H3 (W9): the session started, but both its API call and its git push failed.** This is least likely, because later runners on the same
  path succeeded within minutes.

## Owner read-only reconciliation checklist

Everything here is a read. Do not resume, message or cancel any session found, and do not relaunch from the old record. Identifiers: job
`orbit-202611180118-hcey`, routine `orbit`, launch window **2026-11-18T01:18:14Z to 01:19Z**, brief commit `9f36a47`, control branch
`DragonflyAI-sh/orbit-work:orbit/orbit-202611180118-hcey`. The candidate restart window is 01:15Z to 01:23:30Z.

1. **The job record** (decides W3 or W8/W9). Ask ORBIT for `job_status orbit-202611180118-hcey`, or read `GET /jobs/orbit-202611180118-hcey`
   as owner. Note `launch.sessionId`, `launch.sessionUrl`, `launch.failedAt` and `launch.error`. On the host, the same record is the
   `orbit-202611180118-hcey` entry in `jobs-cloud.json` in `orbit`'s state directory (`StateDirectory=orbit`). Read it, and do not edit it. Once
   this change is deployed, the `dispatch` object states the reading directly.
2. **The confirmation's work-session link.** In `work-sessions.json` (same state directory), find the link whose `launch.job` is
   `orbit-202611180118-hcey`. Note `launch.state` (`launching`, `ambiguous` or `launched`), `repairedAt` and `repairBasis`. A
   `work_link_reconciled` line for this job in `orbit`'s journal at a start after 01:18Z means ORBIT restarted with this launch unsettled,
   which supports H1.
3. **Restart and deploy times.** Run `ops_orbit_status` (`ActiveEnterTimestamp`, `NRestarts`) and `ops_deploy_state` (release directories
   `696b9d9…` and `32bfcc7…`, with their modified times, and `lastDeployed`). If retained, check the systemd journal for `orbit.service` and
   `orbit-deploy.service` between 01:14Z and 01:24Z. A stop or start of `orbit` between 01:18:14Z and 01:18:20Z supports H1.
4. **Notifications around the launch.** Look for `Job orbit-202611180118-hcey could not launch` (it should be absent, given no
   `failedAt`) and `Job orbit-202611180118-hcey is not started …` (expected at about 01:28Z or later). Note what the alert said about the
   session link.
5. **The provider's own record.** If step 1 gave a `sessionUrl`, open it read-only and see whether it ran, where it stopped (for example
   at the tool-commit check), and its tool commit line. If there is no session id, look at the `orbit` Routine's run history on
   claude.ai/code for a run started between 01:18Z and 01:19Z whose first message begins `Job id: orbit-202611180118-hcey`. Do not
   copy the token line anywhere.
6. **Git, again.** Confirm `orbit/orbit-202611180118-hcey` on `orbit-work` still points at `9f36a47`, and that `DragonflyAI-sh/orbit` has no
   branch of that name. Both were true at the time of writing.

Reading the results:

| Finding | Conclusion | Next step (owner decides) |
|---|---|---|
| No session id, and no Routine run for that job id | never reached the provider (W3, request not delivered) | A fresh, explicitly confirmed launch of the inventory brief is safe. The old record stays as history. |
| No session id, but a Routine run exists | W3, provider accepted | Read that session read-only. If it did no work, relaunch explicitly. If it pushed anything, reconcile it first. |
| Session id present, session stopped before `start` | W8 | Note where it stopped. Fix the cause (for example the tool-commit line) before any relaunch. |
| Session id present, session did work | W9 | Recover its output from the session. Do not run the job twice. |
| Nothing can be read (journal rotated, no run history) | unresolved | Record it as unresolved. A relaunch is an explicit owner decision made knowing a duplicate is possible. |

## 6. Next-stage handoff: bounded, read-only host inventory (plan only)

This is a plan for the job the original launch was meant to do. It does **not** authorize shell or filesystem access, host access from a
runner, or a live inventory. It starts only after the original launch is reconciled (above), so that two inventory implementations
cannot race. Metadata only: no credential contents, environment values, process arguments or raw unit/config text.

**Shape.** Add one more fixed, named action to the existing read-only helper (`src/ops/helper.ts`, socket `/run/orbit-ops.sock`, unit
`orbit-ops@.service`), and one owner-only chat tool next to `ops_host_health`. The action takes no arguments and no paths. Each section
returns `{source, observedAt, complete, unavailable?: reason}`, the same convention as the existing actions. It must not grow into an
exec or a general file reader.

**Sections, each from a fixed list declared in the repository:**

1. **Service identities.** For each unit in `deploy/systemd/` (`orbit.service`, `orbit-deploy.service`, `orbit-tailscale-jobs.service`,
   `orbit-ops@`, `orbit-ops-sys@`, `orbit-ops-admin@` and their `-run`/`-vault`/`-plan`/`-update`/`-reboot`/`-funnel`/`-recover` units):
   unit state, and the effective `User`/`Group`, `DynamicUser` and `SupplementaryGroups`, read through `systemctl show -p` with a fixed property
   list as `unitProps` does now. Report UID/GID only for the declared users and groups (`orbit-ops`, `orbit-vault`, and the dynamic `orbit`
   user while it runs).
2. **Sandbox restrictions.** Per unit, the same fixed property read: `ProtectSystem`, `ProtectHome`, `PrivateNetwork`, `NoNewPrivileges`,
   `CapabilityBoundingSet`, `RestrictAddressFamilies`, `ReadWritePaths`, `ReadOnlyPaths` and `StateDirectory`. These should be compared with
   what the repository declares (for example `orbit-ops@` keeps only `CAP_DAC_READ_SEARCH`), and any drift reported as a finding, not fixed.
3. **Helper ownership and actions.** For the three sockets (`/run/orbit-ops.sock`, `/run/orbit-ops-sys.sock`, `/run/orbit-ops-admin.sock`):
   `lstat` owner, group and mode (expected `root:orbit-ops 0660`), not following symlinks. List the action names each helper accepts, taken
   from the code (`src/ops/*-protocol.ts`), not from the host.
4. **Approved paths.** For a fixed list (`/opt/orbit`, `/opt/orbit/current` as a link target name only, `/opt/orbit/releases`,
   `/opt/orbit/repo`, `/opt/orbit/vault`, `/opt/orbit/state`, `/usr/local/lib/orbit`, and `orbit`'s state directory): `lstat` type, owner,
   group, mode, and whether each is a symlink (never followed). No directory listings beyond the release names `ops_deploy_state` already
   shows, and no file contents.
5. **Mounts.** For the same fixed paths only: the mount point and the `ro`/`rw`/`nosuid`/`nodev` flags from `/proc/self/mountinfo`, matched
   by path. Never the whole table, never device or source names.
6. **Deployment separation.** Whether `orbit` (DynamicUser) can write under `/opt/orbit/releases` or `/opt/orbit/repo` (expected: no).
   Which units can write `/opt/orbit` (the ops-admin run unit, per `deploy/systemd/orbit-ops-admin-run@.service`). The serving commit and
   deploy state, through the existing `deploy_state` action.
7. **Credentials.** Presence only, through the existing `ops_credentials` action (names, sizes, dates; contents never read). The inventory
   adds nothing here.

**Facts this action cannot safely observe** (owner gates): effective permissions inside other units' namespaces, secrets or tokens of any
kind, the contents of `orbit.env`, Tailscale ACLs, and anything outside the fixed path list.

**Tests the implementing job owes:** a fixed allowlist with every argument rejected; owner-only access; bounded, secret-free output (built
with runtime-generated fake secrets); missing units, paths and permission failures each reported as `unavailable`; symlinked paths
reported, never followed; provenance and completeness on every section; and no write or exec beyond the fixed `systemctl show` and
`lstat` calls.

**Rollout gates (in order):** review and merge → normal deploy of the helper (`deploy/install.sh` installs `/usr/local/lib/orbit/ops`;
this is a manual, owner-run step) → run the inventory once and reconcile it against the repository's declarations → security review with
the full research report before any file tools are designed.

## 7. Uncertainties

* Whether the original record has a session id (decides W3 or W8/W9). Not visible here.
* The exact restart times between 01:15Z and 01:23:30Z, and which release fired the original launch.
* Whether the provider created a session for the original fire, and, if so, what it did.
* Whether any journal for 01:18Z is still retained.
* The 30-minute `in-flight` bound assumes fetch's default timeouts (no explicit timeout is set on the GitHub or Routine requests).
