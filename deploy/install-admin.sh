#!/usr/bin/env bash
# Installs or updates ONLY the tier 2 admin helper, run as root from a release directory:
#   sudo /opt/orbit/current/deploy/install-admin.sh
# Idempotent. It does not restart orbit.service, rewrite orbit.env, or touch credentials, Tailscale, Funnel or OpenClaw.
# install.sh calls it too. A normal app deploy never runs it: what runs as root changes only when a person runs this.
set -euo pipefail
ROOT=/opt/orbit
src="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "install-admin: run as root" >&2; exit 1; }
[ -x /usr/local/bin/node ] || { echo "install-admin: /usr/local/bin/node is missing (the helper runs on the same node as orbit.service)" >&2; exit 1; }

# Same group as tier 1: the ORBIT service is already a member through SupplementaryGroups=, so it needs no restart for this.
getent group orbit-ops >/dev/null || groupadd --system orbit-ops
mkdir -p "$ROOT/state"

# The deploy script gained --rollback and --refresh-vault; the timer and the runners both use the installed copy.
install -m 755 -o root -g root "$src/pull-deploy.sh" /usr/local/lib/orbit/pull-deploy.sh
install -d -m 755 -o root -g root /usr/local/lib/orbit/ops
install -m 644 -o root -g root "$src"/../src/ops/admin-protocol.ts "$src"/../src/ops/admin-core.ts "$src"/../src/ops/admin-helper.ts "$src"/../src/ops/admin-run.ts "$src"/../src/ops/protocol.ts /usr/local/lib/orbit/ops/
install -m 644 -o root -g root "$src"/systemd/orbit-ops-admin.socket "$src"/systemd/orbit-ops-admin@.service "$src"/systemd/orbit-ops-admin-run@.service "$src"/systemd/orbit-ops-admin-vault@.service /etc/systemd/system/

# A rollback needs to know which release was live before the current one. Seed the history with the release running now.
if [ ! -s "$ROOT/state/history.jsonl" ]; then
  c="$(cat "$ROOT/current/COMMIT" 2>/dev/null || true)"
  if [[ "$c" =~ ^[0-9a-f]{40}$ ]]; then jq -cn --arg c "$c" --arg at "$(date -u +%FT%TZ)" '{commit: $c, at: $at}' > "$ROOT/state/history.jsonl"; fi
fi

systemctl daemon-reload
systemctl enable orbit-ops-admin.socket
systemctl restart orbit-ops-admin.socket
if ! systemctl show orbit.service -p SupplementaryGroups --value 2>/dev/null | grep -qw orbit-ops; then
  echo "install-admin: WARNING: orbit.service is not in group orbit-ops yet; install tier 1 (deploy/install.sh) and restart orbit.service" >&2
fi
echo "install-admin: done. Socket: $(ls -l /run/orbit-ops-admin.sock 2>/dev/null || echo missing)"
