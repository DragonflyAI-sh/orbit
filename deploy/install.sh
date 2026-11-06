#!/usr/bin/env bash
# One-time host setup, run as root: install.sh <bind-address> <owner-tailscale-login> [vault-source]
# Changes to pull-deploy.sh or the units need this re-run; app changes deploy themselves.
set -euo pipefail
bind="$1"
owner="$2"
vault_source="${3:-/root/orbit-vault}"
ROOT=/opt/orbit
src="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$ROOT/state" "$ROOT/releases" /usr/local/lib/orbit
[ -d "$ROOT/repo/.git" ] || git clone -q https://github.com/DragonflyAI-sh/orbit.git "$ROOT/repo"

# Read-only vault copy: markdown only, cloned from this host's vault clone, so no GitHub credential is needed.
getent group orbit-vault >/dev/null || groupadd --system orbit-vault
if [ ! -d "$ROOT/vault/.git" ]; then
  git clone -q --no-checkout "$vault_source" "$ROOT/vault"
  git -C "$ROOT/vault" sparse-checkout set --no-cone '*.md' '!/.obsidian/'
  git -C "$ROOT/vault" checkout -q
fi
chgrp -R orbit-vault "$ROOT/vault"
chmod 750 "$ROOT/vault"

# Keep settings install.sh does not manage, such as ORBIT_MODEL.
managed='^(HOST|PORT|ORBIT_DEPLOY_STATE|ORBIT_VAULT|ORBIT_VAULT_STATE|ORBIT_OWNER)='
kept="$(grep -Ev "$managed" "$ROOT/orbit.env" 2>/dev/null || true)"
{
  printf 'HOST=%s\nPORT=8790\nORBIT_DEPLOY_STATE=%s/state/deploy.json\n' "$bind" "$ROOT"
  printf 'ORBIT_VAULT=%s/vault\nORBIT_VAULT_STATE=%s/state/vault.json\nORBIT_OWNER=%s\n' "$ROOT" "$ROOT" "$owner"
  if [ -n "$kept" ]; then printf '%s\n' "$kept"; fi
} > "$ROOT/orbit.env.new"
mv "$ROOT/orbit.env.new" "$ROOT/orbit.env"

install -m 755 "$src/pull-deploy.sh" /usr/local/lib/orbit/pull-deploy.sh
install -m 644 "$src"/systemd/orbit.service "$src"/systemd/orbit-deploy.service "$src"/systemd/orbit-deploy.timer /etc/systemd/system/
# Public job listener: its own Tailscale node, orbit-jobs, publishing only 127.0.0.1:8791 on port 443.
# Set up only when the one-time auth key exists; the cloud proxy only reaches port 443.
jobs_key=/etc/credstore/orbit.tailscale-jobs
if [ -s "$jobs_key" ]; then
  install -m 644 "$src"/systemd/orbit-tailscale-jobs.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now orbit-tailscale-jobs.service
  ts="tailscale --socket=/run/orbit-tailscale-jobs/tailscaled.sock"
  for _ in 1 2 3 4 5; do $ts status >/dev/null 2>&1 && break; $ts up --auth-key="file:$jobs_key" --hostname=orbit-jobs --accept-dns=false --accept-routes=false && break; sleep 2; done
  $ts funnel --bg --https=443 http://127.0.0.1:8791
  sed -i "/^ORBIT_INGRESS_PORT=/d;/^ORBIT_PUBLIC_JOB_URL=/d" "$ROOT/orbit.env"
  name="$($ts status --self --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
  printf 'ORBIT_INGRESS_PORT=8791\nORBIT_PUBLIC_JOB_URL=https://%s\n' "$name" >> "$ROOT/orbit.env"
fi

systemctl daemon-reload
systemctl enable orbit.service
systemctl enable --now orbit-deploy.timer
systemctl start orbit-deploy.service
systemctl restart orbit.service
