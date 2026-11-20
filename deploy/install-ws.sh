#!/usr/bin/env bash
# Installs or updates ONLY orbit-ops-ws, the workspace host-setup helper (docs/orbit-ops-ws.md), run as root from a release directory:
#   sudo /opt/orbit/current/deploy/install-ws.sh --approved-by-owner
# It is NOT called by install.sh, install-admin.sh, install-sys.sh or any deploy: what runs as root changes only when a person runs this,
# and only after Rai has separately approved installing it. Idempotent. It installs files and enables one socket; it does NOT run the
# setup, restart orbit.service, rewrite orbit.env, create users, images, mounts or drop-ins, or touch credentials, Tailscale or
# OpenClaw. Tiers 1-3 are left as they are. Remove it again with deploy/uninstall-ws.sh.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
[ "${1:-}" = "--approved-by-owner" ] || { echo "install-ws: refusing: pass --approved-by-owner once Rai has approved installing orbit-ops-ws (docs/orbit-ops-ws.md)" >&2; exit 2; }
[ "$#" = 1 ] || { echo "install-ws: refusing: unexpected arguments after --approved-by-owner" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "install-ws: run as root" >&2; exit 1; }
[ -x /usr/local/bin/node ] || { echo "install-ws: /usr/local/bin/node is missing (the helper runs on the same node as orbit.service)" >&2; exit 1; }
for f in /usr/bin/systemctl /usr/bin/getent /usr/sbin/useradd /usr/bin/fallocate /usr/sbin/mkfs.ext4 /usr/bin/chown /usr/bin/chmod /usr/bin/rmdir /usr/bin/apt-get /usr/bin/flock; do
  [ -x "$f" ] || { echo "install-ws: $f is missing; orbit-ops-ws needs it" >&2; exit 1; }
done
[ -d /srv ] || { echo "install-ws: /srv is missing; the workspace mounts live under /srv/orbit-workspaces" >&2; exit 1; }
[ -d /opt/orbit/state ] || { echo "install-ws: /opt/orbit/state is missing; install ORBIT (deploy/install.sh) first" >&2; exit 1; }

# The protocol file is shared with tier 1. It is pinned byte-identical in the repository, so the installed copy should be the same
# bytes. If it is not, installing would change tier 1's file: refuse instead and say so.
install -d -m 755 -o root -g root /usr/local/lib/orbit/ops
if [ -e /usr/local/lib/orbit/ops/protocol.ts ] && ! cmp -s "$src"/../src/ops/protocol.ts /usr/local/lib/orbit/ops/protocol.ts; then
  echo "install-ws: refusing: /usr/local/lib/orbit/ops/protocol.ts differs from this release's copy; installing would change tier 1. Reinstall tiers 1/2 from this release first." >&2
  exit 1
fi

# Same group as tiers 1-3: the ORBIT service is already a member, so it needs no restart for this.
getent group orbit-ops >/dev/null || groupadd --system orbit-ops

install -m 644 -o root -g root \
  "$src"/../src/ops/ws-protocol.ts "$src"/../src/ops/ws-core.ts "$src"/../src/ops/ws-helper.ts "$src"/../src/ops/ws-run.ts \
  /usr/local/lib/orbit/ops/
[ -e /usr/local/lib/orbit/ops/protocol.ts ] || install -m 644 -o root -g root "$src"/../src/ops/protocol.ts /usr/local/lib/orbit/ops/
install -m 644 -o root -g root \
  "$src"/systemd/orbit-ops-ws.socket "$src"/systemd/orbit-ops-ws@.service "$src"/systemd/orbit-ops-ws-run@.service "$src"/systemd/orbit-ops-ws-pkg@.service \
  /etc/systemd/system/

systemctl daemon-reload
systemctl enable orbit-ops-ws.socket
systemctl restart orbit-ops-ws.socket
if ! systemctl show orbit.service -p SupplementaryGroups --value 2>/dev/null | grep -qw orbit-ops; then
  echo "install-ws: WARNING: orbit.service is not in group orbit-ops yet; install tier 1 (deploy/install.sh) and restart the ORBIT service" >&2
fi
echo "install-ws: done. Socket: $(ls -l /run/orbit-ops-ws.sock 2>/dev/null || echo missing)"
echo "install-ws: nothing was set up. Follow the verify steps in docs/orbit-ops-ws.md before any ws_setup."
