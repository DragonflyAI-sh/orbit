#!/usr/bin/env bash
# One-time host setup, run as root: install.sh <bind-address>
# Changes to pull-deploy.sh or the units need this re-run; app changes deploy themselves.
set -euo pipefail
bind="$1"
ROOT=/opt/orbit
src="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$ROOT/state" "$ROOT/releases" /usr/local/lib/orbit
[ -d "$ROOT/repo/.git" ] || git clone -q https://github.com/DragonflyAI-sh/orbit.git "$ROOT/repo"
printf 'HOST=%s\nPORT=8790\nORBIT_DEPLOY_STATE=%s/state/deploy.json\n' "$bind" "$ROOT" > "$ROOT/orbit.env"
install -m 755 "$src/pull-deploy.sh" /usr/local/lib/orbit/pull-deploy.sh
install -m 644 "$src"/systemd/orbit.service "$src"/systemd/orbit-deploy.service "$src"/systemd/orbit-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable orbit.service
systemctl enable --now orbit-deploy.timer
systemctl start orbit-deploy.service
