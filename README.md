# ORBIT

Operational Reasoning Bot for Intelligent Tasks. Always live: merging to main deploys, and `GET /status` says what is real.

Every capability is a port that reports `live`, `mock`, `degraded` or `down`. Every answer carries its provenance, so mock data can't pass as real. `policy` fails closed.

```bash
pnpm install && pnpm test && pnpm start
curl localhost:8790/status
```

## Deploy

The host pulls. Every 2 minutes `orbit-deploy.timer` fetches main and deploys the newest commit whose `checks` passed. It then smoke tests `/status` and restores the previous release if that fails. `/status` shows the running commit and the last failed one. CI holds no deploy credentials.

One-time host setup, as root: `deploy/install.sh <bind-address>`. Re-run it after changing anything in `deploy/`.

This repo holds no personal data or secrets.
