# ORBIT

Operational Reasoning Bot for Intelligent Tasks. Always live: merging to main deploys, and `GET /status` says what is real.

Every capability is a port that reports `live`, `mock`, `degraded` or `down`. Every answer carries its provenance, so mock data can't pass as real. `policy` fails closed.

```bash
pnpm install && pnpm test && pnpm start
curl localhost:8790/status
```

Open `/` for web chat. Every reply is tagged `live` or `mock`, and the model is told which parts of ORBIT are not connected.

## Chat tools

For the owner, the model can call ORBIT's own actions during a reply (up to 5 rounds): `memory_search`, `memory_read`, `github_repo_status`, `jobs_list`, `job_status`, `job_steer`, `notify` and `job_launch`. Each call is checked by `decide("agent", tool)`, and the reply lists every call with its provenance. `job_launch` only creates a proposal; the page shows it with Confirm and Cancel, and only a click calls the launcher (`POST /chat/proposals/:id/confirm`). Anyone else, or a model that cannot call tools (the mock), gets none and is told so.

## Memory

Keyword search over the vault copy, read-only. Only the owner can use it: ORBIT asks tailscaled who sent each request and compares that login with `ORBIT_OWNER`. Anyone else, or a request it cannot identify, gets no memory.

## Notify and schedule

Owner only. `POST /notifications {text, urgent}` queues a message; `POST /schedule` takes `{text, at}`, `{text, everyMinutes}` (5 or more) or `{text, dailyAt: "HH:MM"}` (Pacific). Jobs are checked every 30 seconds and persist in the service's state directory.

Quiet hours, 23:00-08:00 Pacific, hold non-urgent messages. Every notification records receipts only when delivery is proven: `shown` when the web page displayed it, `discord` with the message id when Discord accepted it. Discord is off until a webhook URL is installed at `/etc/credstore/orbit.discord-webhook` (root, 0600).

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
orbit-job summary --status done|blocked|failed <file>
```

Each command reports what really happened (`ok git=pushed <sha> api=sent`, `api=failed`, or `FAILED ...`). With `--api <url> --token <token>`, every step also calls ORBIT back and a check-in fetches steers queued through the API; the tool writes them into `.orbit/steer/` so git stays the complete record. If the API is unreachable, the step still lands in git.

**Job API.** The owner registers a job with `POST /jobs {id}` and gets a token that works for that one job and expires in 24 hours; `POST /jobs/<id>/steer {text}` queues a steer. Runners talk to a separate listener (`ORBIT_INGRESS_PORT`, bound to 127.0.0.1). It is published by a second Tailscale node, `orbit-jobs`, with its own identity, on port 443, because the cloud sandbox proxy only reaches 443. `deploy/install.sh` sets that node up when the one-time auth key `/etc/credstore/orbit.tailscale-jobs` exists that serves only `POST /v1/jobs/<id>/events` and `GET /v1/jobs/<id>/steers`, with the job's token. It has no access to memory, tools or owner routes. Replies and summaries notify the owner. `tools/orbit-job/install.sh` installs the tool and its skill (`SKILL.md`) in a cloud session.

## Model

Set `ORBIT_MODEL` in `/opt/orbit/orbit.env`. ORBIT then uses "Sign in with ChatGPT" token sharing, the method OpenClaw's OpenAI plugin uses: ChatGPT authorizes eligible Responses API calls (`api.openai.com/v1/responses`) on your subscription.

To sign in, press "Sign in with ChatGPT" on the web page, open the link and approve ORBIT. The browser then lands on a `localhost:8080` address that will not load, because ORBIT runs on the server; paste that address into the page. ORBIT verifies the identity token against OpenAI's published keys, checks that token sharing was granted, and keeps its own login in its private state directory. It renews the login itself and never shares OpenClaw's, because every renewal replaces the token.

An OpenAI API key at `/etc/credstore/orbit.openai` (root, 0600) takes precedence if present. Without either, replies are mock and `/status` says why.
