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

## Model

Set `ORBIT_MODEL` in `/opt/orbit/orbit.env` and put an OpenAI API key in `/etc/credstore/orbit.openai` (root, 0600), then restart `orbit`. Without both, replies are mock and `/status` says why. The key never goes in the environment file or the repo.

## Deploy

The host pulls. Every 2 minutes `orbit-deploy.timer` fetches main and deploys the newest commit whose `checks` passed. It then smoke tests `/status` and restores the previous release if that fails. `/status` shows the running commit and the last failed one. CI holds no deploy credentials.

One-time host setup, as root: `deploy/install.sh <bind-address> <owner-tailscale-login>`. The deployer also refreshes a read-only, markdown-only copy of the vault at `/opt/orbit/vault` from the host's own vault clone. Re-run it after changing anything in `deploy/`.

This repo holds no personal data or secrets.
