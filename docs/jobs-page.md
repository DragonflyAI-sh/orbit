# Jobs page

The owner's Jobs page (`/#jobs`, one job at `/#jobs/<job id>`) is where Rai finds a job, follows its GitHub and Claude artifacts, and reads every input and result ORBIT retained for it. Owner only: every route below is checked by `decide("jobs", …)` like the rest of the jobs API, and nothing here launches, retries, posts, merges or decides readiness.

Code: `src/job-detail.ts` (list, detail, links, input states, event paging), `src/job-inputs.ts` (dispatch snapshot and redaction), the `Jobs page` block of `src/web/index.html`. Tests: `test/jobs-detail.test.ts`, `test/jobs-page-browser.test.ts`.

## List

`GET /jobs?view=rows` returns every stored job (not only the newest 50 as before), newest first by launch time, as compact rows: a descriptive title with its source, the id, lane and routine, kind, **state** (`registered`, `running`, `done`, `blocked`, `failed`: what the runner reported) and **health** (`ok`, `not-started`, `quiet`, `launch-failed`, `finished`: ORBIT's reading of whether it is alive) as separate fields, the latest line, launch and last-activity times, the PR link and the review verdict. Query parameters: `q` (words matched against id, title, routine, kind, lane, state, PR and session addresses, related job ids and the latest line), `state`, `health`, `lane`, `kind`, `routine`, `attention=1`, `limit` (1–200, default 50) and `cursor`. The cursor is a keyset (launch time, id), so a page boundary does not move when new jobs arrive. The answer carries `total` (stored), `matched`, `next`, facet counts over the whole store, and a retention note: ORBIT's store keeps the most recent 200 job records (`KEEP_JOBS`), and older ones are removed.

Titles come from recorded words only, in this order: the PR title ORBIT used, the summary's `## PR title`, `Review of <job>` for review jobs, the research report's title, the first meaningful line of the brief (from the dispatch snapshot or the research brief), else `<routine> <kind> job`. The source is shown under the title.

## Detail

`GET /jobs/<id>?view=detail` (the plain `GET /jobs/<id>` still returns the raw record) answers five sections, and the page shows them in that order with the steer box after the overview:

- **Overview**: title, id, lane, routine, kind, state, health, tool-commit badge, registration, launch, fire and acceptance times, last activity, token expiry, and the dispatch evidence state with its basis and caveat (`src/launch-evidence.ts`).
- **Links & artifacts**: every link with a basis. *recorded*: the URL is on the job as GitHub or the provider gave it (Claude session, PR, review comments). *derived*: ORBIT built it from recorded values (the orbit-work control branch, the brief commit and file, the summary commit, the tool commit sent in the fire text and the one the runner reported, the Routine prompt's reference copy at the commit ORBIT ran, the project repository and code branch, the PR's commits and checks pages, the PR head a review started from); the target is not checked unless the note says so. *unavailable*: the record does not hold it, with why. ORBIT never records implementation commits, check results or readiness, so those are only the PR's own GitHub pages. Related jobs (a work job's review job and the reverse), the launch proposal, the work session and the conversation it was proposed in are linked inside the page.
- **Inputs sent to Claude**: how far the launch got (proposed, confirmed or launched, brief written, Routine fired, accepted by the provider, brief fetched by a research runner, runner started), each with its evidence and time; the brief and the Routine fire text from the dispatch snapshot; a note that the Routine's own prompt lives in Claude and is not sent or recorded by ORBIT; a review job's review input; and every steer with its state and source, plus open chat proposals for this job as *proposed, not confirmed*.
- **Activity**: key times, then the events newest first, 50 at a time, with *Load older events* (`GET /jobs/<id>/events?before=<seq>&limit=<1–200>` continues back to the first retained event).
- **Results & review**: the whole stored summary, the PR record (title and its source, parts posted, attempts, error), the review outcome or this review's verdict and comment delivery, and a research job's report checks, isolation and vault save. A verdict is the review job's claim as ORBIT recorded it, never approval.

## What was sent: the dispatch snapshot

The dispatch boundary carries: the Routine fire request (headers with the Routine credential and API version, and the body `{text}` with `Job id`, `API`, `Token`, `Tool commit`, plus `Lane: research` and `Tool sha256` on the research lane); the brief (build: committed to orbit-work `.orbit/brief.md` before the fire; research: held on the job and served by `GET /v1/jobs/<id>/brief`); later, steers and, for a review, the review brief ORBIT writes.

Since this change, the launcher records `launch.dispatch` (version 1) in the same write as `fireStartedAt`, built from the very text it sends: `fireText` (the body text with the token replaced by `[redacted: one-job runner token]`), the brief (redacted copy, `chars` and `sha256` of the text as sent, `delivery`), the lane, the origin (`owner-route`, `chat-proposal` with the proposal id, `orbit-review`) and a list of redactions by field and count. Headers and credentials are never part of it. A brief over 60,000 characters keeps its start, says how much was kept, and stays whole in orbit-work. A research runner's brief fetch is recorded as `research.briefServed` (first and last time, count, sha256 of the first payload).

**Input states.** A steer is *queued* when ORBIT stores it, *received* only when the runner acknowledges it (the tool acks a steer once it has written it into git), and *answered* when a reply event names it. Steers record their source (`owner` from the Jobs page, `proposal` with the proposal id from a confirmed chat card). A steer over 4,000 characters is stored clipped and says so with its full length.

## Redaction

Secret-shaped values (credential assignments, private keys, bearer tokens, provider token shapes, JWTs, URL credentials; `redactText`) are masked before the snapshot is stored, and again when any free text (event text, summaries, steers, errors, research briefs, row previews) is serialized for the page. Commit ids, session URLs and ordinary prose are kept. Every redaction is labelled with a count; values are never stored or shown. The brief's distinct words kept for the duplicate-launch warning are computed from the redacted brief. Copy buttons copy the shown (redacted) text.

## Legacy records and what cannot be recovered

- Jobs launched before the dispatch snapshot have no stored brief or fire text. The page says so and links the brief file in orbit-work at the recorded brief commit (derived link); it never rebuilds either from today's templates. Their tool-commit line, if recorded, is shown as the only fire-text field.
- Steers queued before steer provenance show *source not recorded*.
- Events beyond the last 200 of a job are dropped by the store. New records count them (`eventsDropped`) and the page says how many; a record that was already at 200 events before the counter says the count is unknown. The runner's own check-in log stays in orbit-work.
- Research brief fetches before `briefServed` show as unknown once the runner has reported.
- The Routine's live prompt was never recorded; only the repository's reference copy is linked.

## Page behaviour

The list toolbar (search, filters, attention) and every detail section are built once and patched only when their data changes, so a refresh (every 15 seconds while the Jobs page is visible) keeps the search text and focus, folded sections, expanded text, loaded older events, the steer draft, and scroll positions. Long text starts folded with *Expand full text* and is never cut. All runner and user text goes in as text nodes or through `linkify` (https only); external links are only `https://github.com/…` and `https://claude.ai/…` addresses that pass a strict shape check on the server and again in the page.
