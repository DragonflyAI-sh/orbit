# ORBIT

Operational Reasoning Bot for Intelligent Tasks. Always live: merging to main deploys, and `GET /status` says what is real.

Every capability is a port that reports `live`, `mock`, `degraded` or `down`. Every answer carries its provenance, so mock data can't pass as real. `policy` fails closed.

```bash
pnpm install && pnpm test && pnpm start
curl localhost:8790/status
```

Open `/` for web chat. Every reply is tagged `live` or `mock`, and the model is told which parts of ORBIT are not connected.

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

## Model

Set `ORBIT_MODEL` in `/opt/orbit/orbit.env` and put an OpenAI API key in `/etc/credstore/orbit.openai` (root, 0600), then restart `orbit`. Without both, replies are mock and `/status` says why. The key never goes in the environment file or the repo.

## Deploy

The host pulls. Every 2 minutes `orbit-deploy.timer` fetches main and deploys the newest commit whose `checks` passed. It then smoke tests `/status` and restores the previous release if that fails. `/status` shows the running commit and the last failed one. CI holds no deploy credentials.

One-time host setup, as root: `deploy/install.sh <bind-address> <owner-tailscale-login>`. The deployer also refreshes a read-only, markdown-only copy of the vault at `/opt/orbit/vault` from the host's own vault clone. Re-run it after changing anything in `deploy/`.

This repo holds no personal data or secrets.
