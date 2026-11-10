# ORBIT

Operational Reasoning Bot for Intelligent Tasks. Always live: merging to main deploys, and `GET /status` says what is real.

Every capability is a port that reports `live`, `mock`, `degraded` or `down`. Every answer carries its provenance, so mock data can't pass as real. `policy` fails closed.

```bash
pnpm install && pnpm test && pnpm start
curl localhost:8790/status
```

Open `/` for web chat. Every reply is tagged `live` or `mock`, and the model is told which parts of ORBIT are not connected.

## Chat tools

For the owner, the model can call ORBIT's own actions during a reply (up to 5 rounds): `memory_search`, `memory_read`, `github_repo_status`, `jobs_list` (a compact row per job and the true total), `job_status` (last 20 events and how many were left out), `job_steer`, `notify` and `job_launch`, plus the `ops_*` server tools when the helper is installed. Each call is checked by `decide("agent", tool)`, and the reply lists every call with its provenance. `job_launch` only creates a proposal; the page shows it with Confirm and Cancel, and only a click calls the launcher (`POST /chat/proposals/:id/confirm`). Anyone else, or a model that cannot call tools (the mock), gets none and is told so.

## Threads

Chat is stored on the server as threads, shared by every device, owner only, kept until archived (nothing is deleted). The page lists, opens, creates, renames and archives threads, restores the selection after a refresh, and shows proposal cards with their final state and the job or operation id. The model's context is built from the stored thread, including earlier tool calls and results, with per-thread compaction and a rolling recent-work note. Storage, routes, concurrency, migration, budgets, the recent-context interface and the proposal lifecycle are in `docs/threads.md`.

## Server operations (`orbit-ops`)

Seven read-only chat tools (`ops_orbit_status`, `ops_orbit_logs`, `ops_deploy_state`, `ops_host_health`, `ops_tailscale_status`, `ops_vault_sync`, `ops_credentials`) ask a small root helper behind `/run/orbit-ops.sock` (group `orbit-ops`, mode 0660). Fixed named actions only, bounded and redacted, credentials by name/size/date only, no per-read confirmation. It is installed by `deploy/install.sh`, not by a normal deploy: see `docs/orbit-ops.md` for the exact commands, protections and verification.

## Jobs page and pull requests

The owner's page has a Jobs tab next to chat (hidden for anyone else). It lists jobs with health (`not-started`, `quiet` and `launch-failed` stand out), the latest check-in and whether it came over the API or git, and a link to the session. Opening a job shows its events and steers and a steer box, which uses `POST /jobs/<id>/steer` because Rai is acting directly. Open chat proposals (launch and steer) are listed from `GET /chat/proposals` with Confirm and Cancel, so they survive the chat reply scrolling away. The page refreshes every 15 seconds while visible.

When a job's summary arrives with status `done` (API or git) and its routine has a project repo in `ORBIT_ROUTINE_REPOS` (`orbit=DragonflyAI-sh/orbit,money-noodle=owner/name`), ORBIT opens a pull request from `orbit/<job-id>` to `main` there, if that branch exists. The token is the systemd credential `orbit.github-orbit-prs` (Pull requests read and write, Contents read). The title and body come from the summary's `## PR title` and `## PR body` sections (the body runs to the end, or to a later `## PR title`); otherwise `ORBIT job <id>` and the whole summary. A footer links the session. The PR URL is recorded on the job and shown on the page, only one is ever opened, and Rai is told `PR ready: <url>`. A failure is recorded, notified and not retried. No branch in the project repo means no PR and no message. Merging stays Rai's.

### Reviews

Jobs have a `kind`: `work` (default) or `review`. When ORBIT *opens* a PR for a work job (not when the PR already existed), it launches one review job on the same Routine with a brief it writes: the PR, the branch `orbit/<work-job>`, read the diff against `main`, run typecheck and tests, look for bugs, security problems and unsupported claims in the PR body, push nothing, and end the summary with `## Findings` and `Verdict: no blocking issues` or `Verdict: blocking issues`. ORBIT starts it itself, so it needs no confirmation click. A review job never opens a PR and never starts a review; there is at most one per work job. When its `done` summary arrives, ORBIT posts it as a comment on the PR (issue-comments API, same `orbit.github-orbit-prs` credential) with a footer naming the review job and its session, records the comment URL on both jobs, and tells Rai once: `PR <url>: review done, <verdict>`. A launch or posting failure, or a review that ends `failed` or `blocked`, is recorded and notified, never retried. A stalled review is covered by the job alerts. The Jobs tab shows each job's kind, and a work job's review verdict and comment link. The posting credential needs Issues or Pull requests write on the project repo.

## Memory

Keyword search over the vault copy, read-only. Only the owner can use it: ORBIT asks tailscaled who sent each request and compares that login with `ORBIT_OWNER`. Anyone else, or a request it cannot identify, gets no memory.

## Notify and schedule

Owner only. `POST /notifications {text, urgent}` queues a message; `POST /schedule` takes `{text, at}`, `{text, everyMinutes}` (5 or more) or `{text, dailyAt: "HH:MM"}` (Pacific). Jobs are checked every 30 seconds and persist in the service's state directory.

Quiet hours, 23:00-08:00 Pacific, hold non-urgent messages. Every notification records receipts only when delivery is proven: `shown` when the web page displayed it, `discord` with the message id when Discord accepted it. Discord is off until a webhook URL is installed at `/etc/credstore/orbit.discord-webhook` (root, 0600).

**Watch.** Every 30-second tick, ORBIT checks its own parts. A part `degraded` or `down` for 5 minutes sends one message (urgent only for `down`), and one more when it is `live` again, with how long it was out. A part that goes from degraded to down sends one more, urgent. Parts whose `verifiedAt` is the Unix epoch ("not exercised yet") are ignored. A job that is `not-started` or `quiet` sends one message with its session link and last check-in; a finished job never does. What was already reported is kept in `watch.json` in the state directory, so a restart does not repeat it, and `/status` shows it as the `watch` part.

## Runs

Owner only. `POST /runs {worker, input, key}` queues background work; `GET /runs/:id` shows its timeline; `POST /runs/:id/cancel` stops it. Workers today: `memory-report {query}` and `model-task {prompt}`.

A run moves through `requested`, `accepted`, `running`, `reviewed` and `delivered`, or ends `failed` or `cancelled`. It is `delivered` only when its notification has a receipt. The same `key` returns the existing run instead of starting another. At most 4 run at once. After a restart, runs that were in flight are re-queued only if their worker is safe to repeat; the rest are marked interrupted. A scheduled job can submit a run with `{text, run: {worker, input}, ...}`.

## Tools

Owner only, read-only. `GET /tools` lists them; `POST /tools/<name>` calls one. Write tools are refused until approvals exist. Today: `github-repo-status {repo: "owner/name"}` returns open PRs and the latest main CI run for a public repo, with no credential. The `tool` worker runs a tool as a background run, so a schedule can deliver it, for example a daily repo digest.

## Nodes

Owner only. `GET /nodes` lists the owner's devices on the tailnet, online or offline with last-seen, read from this host's tailscaled every 30 seconds. Devices of other tailnet users are never listed. The owner's chat gets the same summary, so ORBIT can answer "is my laptop on?". Presence only for now: desktop notifications will need a helper on each laptop.

## Cloud runners: `orbit-job`

`tools/orbit-job` is the job protocol for Claude cloud runners. A job's control files live in the private `DragonflyAI-sh/orbit-work` repo on branch `orbit/<job-id>`: ORBIT writes `.orbit/brief.md` and `.orbit/steer/<n>.md`; the runner writes `started.json`, `checkins.jsonl`, `replies/<n>.md` and `summary.md`. Code always goes to the project repo, never `orbit-work`.

```bash
orbit-job start --job <id>        # check out orbit/<id>, record the start, print the brief path
orbit-job checkin "<status>"      # record progress, then show new steers
orbit-job reply <n> <file>        # answer steer n
orbit-job summary --status done|blocked|failed [--repo <dir>] [--code-branch] <file>
```

Each command reports what really happened (`ok git=pushed <sha> api=sent`, `api=failed`, or `FAILED ...`). With `--api <url> --token <token>`, every step also calls ORBIT back and a check-in fetches steers queued through the API; the tool writes them into `.orbit/steer/` so git stays the complete record. If the API is unreachable, the step still lands in git.

**Summary contract.** `orbit-job summary --status done` requires `## PR title` and `## PR body` when the job pushed a code branch, because ORBIT opens the pull request from them. The check runs before anything is written, committed or sent to the API: a refused summary exits 2 with a list of what to fix and leaves no trace, so the runner corrects the file and runs the same command again. Meaningful means a title line of at least 8 characters with letters or digits that is not a placeholder (`TBD`, `TODO`, `n/a`), and a body of at least 40 non-space characters. Headings are matched the way ORBIT reads them (own line, case-insensitive, `src/pull-requests.ts`). `blocked` and `failed` summaries, and `done` summaries of jobs with no pushed code branch (research, reviews), are unchanged.

*How a pushed code branch is detected.* The evidence is job-specific: the branch `orbit/<job-id>` exists on the `origin` of a project checkout (`git ls-remote`). Checkouts considered are `--repo <dir>` (repeatable), `ORBIT_JOB_REPOS` (colon-separated), the current directory, and every checkout directly under the directories in `ORBIT_JOB_SEARCH` (default `$HOME:/home/user`). The `orbit-work` checkout is skipped, since its `orbit/<job-id>` is the control record. If origin cannot be reached, the checkout's remote-tracking ref `origin/orbit/<job-id>` counts. *Limitations:* a push made without a visible checkout (GitHub API tools, a checkout outside the search directories) is not detected unless the runner passes `--repo` or `--code-branch`; a branch that was never pushed, or a push to a differently named branch, is not evidence; the check is the runner-side gate only, so a summary written by hand into `orbit-work` or sent straight to the API bypasses it, and ORBIT still falls back to `ORBIT job <id>` and the whole summary for the PR text when the sections are absent. The API event carries only the first 4000 characters of the summary; git has all of it.

**Tool commit provenance.** The fire text names the commit ORBIT is running; the runner verifies that commit on `main`, copies the tool out of it, and tells the tool what it verified: `orbit-job start --job <id> --tool-commit <40-hex>` (or the environment variable `ORBIT_JOB_TOOL_COMMIT`; the option wins). The tool never infers it from the job checkout, HEAD or ORBIT's version. A missing value is recorded as the literal `unknown`; a value that is not a full lowercase 40-character hex commit makes `start` fail rather than record junk. It is written as `toolCommit` in `.orbit/started.json` and sent as `toolCommit` on the `started` API event (ingestion drops anything malformed, or on other event types). ORBIT stores it on the job (`Job.toolCommit`; the git-record fallback, `gitReconciler`, reads it from `started.json` when the API missed the start). `/jobs` (rows and detail) return `toolCommit` (`unknown` if absent, as for every job started before this field) and `toolCommitStatus`: `match` or `mismatch` against `ORBIT_COMMIT` (the same value `/status` reports, never the job branch), or `unknown` when either side is unknown. Only `mismatch` is flagged in the Jobs view; an unknown commit is shown as "tool commit: unknown", never as a mismatch. Limitation: the commit is the runner's own claim, so ORBIT records what was reported and cannot itself prove the runner verified it.

**Fire text.** Every job's fire text (the owner's launch route, a confirmed chat proposal, and ORBIT's own review launches all build it in `jobLauncher`, `src/job-launch.ts`) ends with `Tool commit: <sha>`: the commit of the ORBIT runtime that generated it, from `ORBIT_COMMIT` (written to `release.env` by `deploy/pull-deploy.sh`, and the same value `/status` reports), not the tip of main and not the job branch. If it is unset, `unknown`, or not a hex commit id, the line says `Tool commit: unknown`; no SHA is ever guessed. The existing lines (`Job id`, `API`, `Token`) are unchanged.

**Job API.** The owner registers a job with `POST /jobs {id}` and gets a token that works for that one job and expires in 24 hours; `POST /jobs/<id>/steer {text}` queues a steer. Runners talk to a separate listener (`ORBIT_INGRESS_PORT`, bound to 127.0.0.1). It is published by a second Tailscale node, `orbit-jobs`, with its own identity, on port 443, because the cloud sandbox proxy only reaches 443. `deploy/install.sh` sets that node up when the one-time auth key `/etc/credstore/orbit.tailscale-jobs` exists that serves only `POST /v1/jobs/<id>/events` and `GET /v1/jobs/<id>/steers`, with the job's token. It has no access to memory, tools or owner routes. Replies and summaries notify the owner. `tools/orbit-job/install.sh` installs the tool and its skill (`SKILL.md`) in a cloud session.

## Model

Set `ORBIT_MODEL` in `/opt/orbit/orbit.env`. ORBIT then uses "Sign in with ChatGPT" token sharing, the method OpenClaw's OpenAI plugin uses: ChatGPT authorizes eligible Responses API calls (`api.openai.com/v1/responses`) on your subscription.

To sign in, press "Sign in with ChatGPT" on the web page, open the link and approve ORBIT. The browser then lands on a `localhost:8080` address that will not load, because ORBIT runs on the server; paste that address into the page. ORBIT verifies the identity token against OpenAI's published keys, checks that token sharing was granted, and keeps its own login in its private state directory. It renews the login itself and never shares OpenClaw's, because every renewal replaces the token.

**Renewal.** The 30-second tick renews the ChatGPT login in the background when the access token has 10 minutes or less left (or half its last lifetime, if shorter, so a short-lived token is not renewed in a loop), with no model call. A call that finds the token within 5 minutes of expiry still renews it on demand. The background renewal and calls share one request, and the new token is saved before it is used. A failed renewal is retried after 1, 2, 4, 8, then 15 minutes; a revoked login is not retried. Status stays `live` through routine renewals. A failed renewal is `degraded` while the old token still works and `down` once it has expired, with `verifiedAt` the time of the failure; the watch alerts only if that lasts 5 minutes. Renewal never sets the model's last-answer time and never clears a failed model call. On SIGTERM/SIGINT ORBIT waits (up to 10 s) for a renewal in flight so a rotated token is saved.

**Idle is not degraded.** The model port is exempt from the 5-minute "not verified" rule that other ports keep. Each 30-second tick re-checks the saved login on disk (complete, token sharing granted, unexpired, no failed renewal); a pass, like a successful renewal, advances `verifiedAt`, so an idle healthy model stays `live`. These checks are not model answers: they never set the last-answer time and never clear a failed model call. Degraded/down come only from errors: a failed call is `down` until a later call succeeds (neither elapsed time, a login check nor a renewal recovers it); a failed renewal is `degraded` while the old token works and `down` once it expires, recovering when a renewal succeeds; an incomplete or revoked login, or an expired token not yet renewed, is reported as such. A model never exercised since startup keeps its existing semantics (local readiness, or the epoch `verifiedAt` the watch ignores). If the tick itself stopped, the token would eventually expire and the model would report that.

An OpenAI API key at `/etc/credstore/orbit.openai` (root, 0600) takes precedence if present. Without either, replies are mock and `/status` says why.

**Server operations (tier 2).** ORBIT can propose a restart, a deploy now, a rollback, a change to five `orbit.env` settings, or a vault refresh. Each is an owner-only proposal that does nothing until Rai confirms the exact action, and then runs through a separate privileged helper whose result ORBIT reports only once it has verified `/status`. See `docs/orbit-ops-admin.md` (privileges, install commands, acceptance checks).

**Server operations (tier 3).** Code only; not installed or verified on any host. ORBIT can propose installing OS updates, rebooting, or enabling/disabling the existing orbit-jobs Tailscale Funnel. Each is a separate owner-only proposal with a separate confirmation, bound to an exact digest, and runs through a separate privileged helper (`deploy/install-sys.sh`, which nothing runs automatically and which needs `--approved-by-owner`). Updates never reboot; a reboot or Funnel change counts as done only when the helper observed it. See `docs/orbit-ops-sys.md` (threat model, update policy, Funnel topology, rollback, staged live acceptance, evidence gaps).

**Rollback drill.** `deploy/pull-deploy.sh --drill` is an opt-in, operator-run drill of the real rollback path; see `docs/rollback-drill.md`. An app deploy does not update `/usr/local/lib/orbit/pull-deploy.sh`; the runbook says how to verify and install it.
