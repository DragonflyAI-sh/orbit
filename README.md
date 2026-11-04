# ORBIT

Operational Reasoning Bot for Intelligent Tasks. Always live: merging to main deploys, and `GET /status` says what is real.

Every capability is a port that reports `live`, `mock`, `degraded` or `down`. Every answer carries its provenance, so mock data can't pass as real. `policy` fails closed.

```bash
pnpm install && pnpm test && pnpm start
curl localhost:8790/status
```

Open `/` for web chat. Every reply is tagged `live` or `mock`, and the model is told which parts of ORBIT are not connected.

## Model

Set `ORBIT_MODEL` in `/opt/orbit/orbit.env` and put an OpenAI API key in `/etc/credstore/orbit.openai` (root, 0600), then restart `orbit`. Without both, replies are mock and `/status` says why. The key never goes in the environment file or the repo.

## Deploy

The host pulls. Every 2 minutes `orbit-deploy.timer` fetches main and deploys the newest commit whose `checks` passed. It then smoke tests `/status` and restores the previous release if that fails. `/status` shows the running commit and the last failed one. CI holds no deploy credentials.

One-time host setup, as root: `deploy/install.sh <bind-address>`. Re-run it after changing anything in `deploy/`.

This repo holds no personal data or secrets.
