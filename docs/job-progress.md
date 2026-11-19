# Job progress and the first-callback alert

How ORBIT reports how far a cloud job got, from its own record, and what it does when a runner never checks in. Code: `src/job-progress.ts` (the shared reading), `src/jobs.ts` (`health`, the deadlines, the alert record), `src/watch.ts` (the alert). Tests: `test/job-progress.test.ts`, `test/jobs-progress-browser.test.ts`.

## One reading for every view

`jobs_list`, `job_status`, `research_result`, the Jobs page list and the Jobs page detail all compute status with the same two functions, at the same moment: `jobs.health(job)` and `jobProgress(job, health)`. So the views cannot disagree about one job at one time. Before this change two views could seem to disagree because the answer depended on *when* you asked: `job_status` read a few minutes after launch said `health: ok`, and `jobs_list` read after the 10-minute deadline said `not-started`. Both came from the same function (`src/jobs.ts` `health`). The problem was the word `ok`: a job with no runner event was called `ok` before the deadline. A dispatch, a provider session and a tool download do not show that the runner executed anything.

### Health values

| Health | Meaning |
| --- | --- |
| `awaiting-first-checkin` | **New.** No runner event yet, and the deadline has not passed (or the job has no launch record, so there is no deadline). Execution unverified. Older ORBITs called this `ok`. |
| `not-started` | No runner event 10 minutes (`NOT_STARTED_AFTER_MS`) after launch. Not checked in. That does not prove it failed or never launched, and it does not say why. |
| `ok` | The runner has reported (at least one runner event) and is not quiet. |
| `quiet` | The runner reported, then sent nothing for 15 minutes. |
| `launch-failed` | The launch recorded a failure and the runner has said nothing. |
| `finished` | `done`, `blocked` or `failed`. |

Health is computed on every read, never stored, so older records need no migration. A saved link with `?health=ok` still works; it just no longer matches a job that has not checked in. Host operations (`src/ops-sys.ts`) count an awaiting job as "quiet or not started (possibly still working)", not as known active.

### Milestones

`jobProgress` lists only the milestones the record has evidence for, in the order they happen. It never infers one from a later one:

| Milestone | Evidence | What it proves |
| --- | --- | --- |
| `registered` | `createdAt` | ORBIT registered the job |
| `dispatched` | `launch.fireStartedAt` (older records: the launch time, only if the provider answered) | ORBIT fired the Routine. This is the **dispatch time**, not runner activity |
| `provider-accepted` | `launch.sessionId` (`firedAt`) | The provider created a session. Nothing more |
| `tool-served` | `research.toolServed` (research only) | The job API answered the tool download. It does **not** show that the tool arrived intact or ran |
| `brief-served` | `research.briefServed` (research only) | The job API answered the brief request that `orbit-research start` makes before it checks in. Still not a check-in |
| `first-callback` | the first runner event | The runner's first authenticated callback: the first evidence that it executed its tool. Runner-reported |
| `report-received` | summary (research: stored report) | The final summary or report reached ORBIT |
| `validated` | `research.report.valid` (research only) | ORBIT's shape and bounds check passed or failed. It does not check the report's claims |

`progress.phase` is `awaiting-first-checkin`, `first-checkin-overdue`, `launch-failed`, `running`, `quiet` or `finished`. `progress.executionVerified` is true only once a runner event exists. `progress.dispatchedAt` and `progress.lastRunnerActivityAt` are kept separate. The Jobs page now says "last runner activity", or "no runner activity yet", where it used to show "last activity" (which fell back to dispatch times). `activityAt` stays in the rows for older pages, with `activityBasis` (`runner`, `provider`, `dispatch`, `registered`) saying which time it is.

What each view carries:
- `jobs_list`: unchanged rows, plus `lastVerified` (one milestone key) on rows with no runner event, so the list stays inside the 8,000-character tool limit.
- `job_status`: `progress` (milestones as key and time) and `firstCallbackAlert`.
- `research_result`: `progress` and `firstCallbackAlert` (with live delivery).
- The Jobs page: health words ("awaiting first check-in", "first check-in overdue", "checked in"), a Progress line, the "How far the launch got" stages (tool download before brief fetch, and for research the report received and checked), and the alert with its delivery.

## The first-callback alert

The watch (`src/watch.ts`, every 30 s) works only from stored times, so it needs nothing from the runner. It notices a runner that was stopped or refused before it could send any failure report. When a job becomes `not-started`, the watch:

1. **Queues one notice** through the existing notifier (web inbox, plus Discord when connected; non-urgent, so Discord holds it during quiet hours 23:00–08:00 Pacific). The notice says: not checked in, which is not proof that it failed or never launched, and not a cause. It also gives the session link, the **last verified stage** (for example "Runner tool sent by the job API at …", with what that does not prove), the dispatch evidence (`src/launch-evidence.ts`), and that nothing was retried or relaunched.
2. **Records it on the job** (`job.callbackAlert`: first and latest time, count, dispatch state, stage, notification id). `job_status`, `research_result` and the Jobs page show it.
3. **Deduplicates** using two records: the watch's own persisted store, and the alert on the job. A page refresh is a read and never alerts. A restart does not repeat it, even one that lost the watch store. A second notice is sent only when the dispatch evidence changes materially (the existing rule).
4. **Records a failure to queue.** If storing the notice throws, the error and attempt count are recorded on the job, it is retried once per tick at most `MAX_ALERT_ATTEMPTS` (3) times, and then marked given up. It is never shown as sent.
5. **Supersedes it on a late callback.** When a runner event arrives after the alert, the job's record is marked superseded (`runner-callback`, or `finished` if the job ended). If the job is still running, Rai gets one short note: "checked in at …, after ORBIT's not-started alert: that alert no longer applies". A finished job gets its normal completion notice instead. No view keeps showing the overdue warning after a callback.

**Queued, delivered and read are different.** Queued: ORBIT stored the notice. Delivered, per sink: the web page listed it (`shown.listed`), or Discord accepted it (a message id). Neither proves Rai read it. The Jobs page detail and `research_result` show the live state from the notification store: queued time, web page shown or not, and Discord accepted, failed, held for quiet hours, waiting, or not connected. `job_status` gets only the record on the job (state `queued` and the notification id) and says that receipts live on the notification.

What the alert does not do: it never declares failure, names a cause, retries, relaunches, re-registers or changes the job's state. After the token expires (3 hours for research) a silent job stays `not-started`/`registered`.

## Safe diagnostics for a job that never checked in

Read-only, from ORBIT's own record. Nothing here retries or relaunches anything.

1. Open the job on the Jobs page (or ask for `job_status` / `research_result`). Read `progress.lastVerified` and the stages.
2. Read what the last verified stage allows you to say:
   - **provider-accepted, no tool served** (research): ORBIT never answered a tool download. Either the request never reached ORBIT (a reset or TLS failure on the way leaves no record), or the session stopped before step 2. Read the session's own output (the session link).
   - **tool-served, no brief served, no check-in**: the download reached ORBIT, but the runner never got as far as `orbit-research start`'s brief request. This fits a digest mismatch, a refused or failed step 3, or a session that stopped. It does not tell them apart. Read the session output.
   - **brief-served, no check-in**: `start` ran and fetched the brief, but its `started` event did not arrive. Look for `FAILED api=failed (started)` in the session.
   - **first-callback present**: the runner is executing. Use the timeline.
3. Check the alert on the job detail: queued or not, and its delivery. For "Rai saw no notification": look for `Job <id> is not started` in the web notifications. Check the alert's Discord line, and the notify port on `/status` (Discord connected, or N failed sends). A Discord acceptance is not a read receipt.
4. Record what you found, with the job id and times, in the routine's History. Do not edit the job record, reuse its token, re-run a refused command, or relaunch from inside the diagnosis. A fresh launch is Rai's separate decision.
