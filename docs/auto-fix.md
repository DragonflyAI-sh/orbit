# Auto-fix proposals

When a job's pull request fails CI or has a merge conflict, ORBIT proposes a job to fix it, so Rai does not have to notice the failure and ask. It only **proposes**: the fix job is an ordinary `job_launch` card on the Jobs page ("Waiting for your click"), and nothing launches until Rai clicks Confirm. Code: `src/auto-fix.ts`.

## When ORBIT looks

1. A work job finishes `done` and ORBIT opens its PR (`src/pull-requests.ts`), then starts its review (`src/review.ts`). Neither changes.
2. The watch starts once that review has **settled**: it recorded a verdict or an error, or the review job ended, or it is still running 3 hours after it started. A job with no review is waited for 10 minutes after its PR. The fix brief carries the review's findings, so the review comes first; the auto-fix never replaces it.
3. From then on ORBIT reads the PR at most every 5 minutes, on its 30-second tick, for up to 48 hours after the PR was opened.

Only PRs ORBIT opened (they carry ORBIT's title) or reviews are watched: never a PR someone opened by hand. Review and research jobs have no PR and are never watched.

What it reads (credential `orbit.github-orbit-prs`, read only): the PR (open, closed or merged; head commit; `mergeable_state`), the newest run of every check on the head commit (`filter=latest`, so a rerun that passed hides the failure it replaced), and the commit statuses.

| Seen | What ORBIT does |
| --- | --- |
| PR merged or closed | Stops watching (`closed`). |
| No failed check and no conflict | Keeps watching (`seen`: `pending`, `passing` or `unknown` while GitHub computes mergeability). |
| A failed check (`failure`, `startup_failure`, `timed_out`; a status `failure` or `error`) | Waits while other checks still run, so the brief lists every failure, but at most 1 hour; then proposes. |
| `mergeable_state: dirty` (merge conflict) | Proposes at once (CI often does not run on a conflicted PR). |
| 48 hours after the PR opened | Stops watching (`expired`), quietly. |
| 12 reads in a row fail | Stops watching (`expired`, with the error) and tells Rai once. |

## The proposal

The fix job runs on the same routine as the job whose PR failed. Its brief, written by ORBIT:

- names the PR, its branch `orbit/<job>`, the head commit it saw and why (failed checks, merge conflict or both), and which attempt this is (`attempt 2 of at most 3`, and the job that began the chain);
- lists every failing check with its conclusion, title and link; for up to 3 of them, the **failing test names** read from the log (node:test `✖`/`not ok`, Jest `●`, pytest `FAILED`, Go `--- FAIL:`) and an **error excerpt**: the 60 lines before the first `##[error]` marker of the Actions log (or the last lines), at most 2,500 characters, timestamps removed and secret-shaped strings redacted. A non-Actions check gives its own output text; a commit status only its description;
- for a conflict, the **files changed on both the branch and `main`** since they diverged (two compare reads). GitHub's API does not name conflicting files, so the brief says that is what the list is;
- the review's `## Findings` section (at most 3,000 characters, redacted) and its verdict, or that the review did not complete;
- the steps: start the runner's own `orbit/<its job id>` from `orbit/<job>`, merge or rebase `main`, reproduce, fix, run the typecheck and the whole suite, push. ORBIT opens a new PR from it, which replaces the failing one (Rai closes the old one). The runner never pushes to the old branch or `main`, never touches a PR, and never skips or weakens a test to get green.

Everything quoted from CI, GitHub or the review is fenced and labelled as data, never instructions.

The card says it is an auto-fix (`autoFix` on the proposal: the job, the PR, the attempt and the limit), stays open for 24 hours (a chat card stays 30 minutes), and is confirmed or cancelled through the same route as every launch (`POST /chat/proposals/<id>/confirm`). Rai is notified when it is proposed: `PR <url>: CI checks failed (test). ORBIT proposed fix job attempt 1 of 3 ...`.

## No loops

- **One proposal per PR.** Once a PR's record is `proposed`, `escalated`, `closed`, `expired` or `lapsed`, ORBIT never reads it or proposes for it again.
- **A chain has a limit.** When Rai confirms a fix, the launched job carries the proposal id in its work link; ORBIT then records `fixOf` on it (`of`, `prUrl`, `attempt`, `root`, `proposal`) and `fixJob` on the job it fixes. The fix job's own PR is watched like any other. If it fails too, the next attempt is proposed, until the attempt would pass `ORBIT_AUTO_FIX_MAX_RETRIES`: then ORBIT sends Rai an **urgent** notification instead (`PR <url> needs you: ... after 3 auto-fix attempt(s) ... The auto-fix limit is 3`) and records `escalated`.
- **A card that ends without a launch** (cancelled, expired, refused, or lost in a restart: proposals are held in memory) is recorded as `lapsed` and Rai is told once. It is not proposed again; ask in chat for a fix if one is still wanted.
- Nothing here launches, steers or changes a job Rai launched himself; it only reads the PR and makes a card.

## Settings (`orbit.env`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `ORBIT_AUTO_FIX_ENABLED` | `true` | `false` (or `0`, `off`, `no`) turns the watch off: nothing is read, recorded or proposed. Any value other than true/false also turns it off, and the startup log says why: an unreadable switch never turns proposals on. |
| `ORBIT_AUTO_FIX_MAX_RETRIES` | `3` | Fix proposals per chain, `0` to `10`. `0` sends every failure straight to Rai. Any other value keeps `3`, and the startup log says so. |

Both are shown in the config view. Without the `orbit.github-orbit-prs` credential the watch reads nothing and the startup line (`auto-fix: ...`) says so.

## Records

`autoFix` on the job whose PR is watched (`state`, `since`, `attempt`, `checkedAt`, `headSha`, `seen`, `reason`, `failing`, `conflictFiles`, `proposal`, `fixJob`, `settledAt`, `error`) and `fixOf` on a fix job, both in the job store and written only by ORBIT. They are visible in the job's JSON (`GET /jobs/<id>`).

## Limits

- A PR that passes and is later broken by a change to `main` is caught only while it is inside its 48-hour window.
- The conflict file list is the overlap of both sides' changes, not git's exact conflict list; with more than 300 changed files on a side it may be incomplete (the brief says so).
- Test names are a heuristic over the log; the excerpt is the end of the failure output, not the whole log. The runner is told to reproduce the failure itself.
- Proposals live in memory: a restart drops an open auto-fix card, which is then reported as lapsed.
