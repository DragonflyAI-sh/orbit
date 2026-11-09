#!/usr/bin/env bash
# Installs or updates ONLY the tier 3 helper (OS updates, reboot, orbit-jobs Funnel), run as root from a release directory:
#   sudo /opt/orbit/current/deploy/install-sys.sh --approved-by-owner
# It is NOT called by install.sh, install-admin.sh or any deploy: what runs as root changes only when a person runs this, and only
# after Rai has separately approved installing it (docs/orbit-ops-sys.md, "Staged live acceptance"). Idempotent. It installs files and
# enables two units; it does not run any operation, restart orbit.service, rewrite orbit.env or touch credentials, OpenClaw or any
# Tailscale instance. Remove it again with deploy/uninstall-sys.sh.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
[ "${1:-}" = "--approved-by-owner" ] || { echo "install-sys: refusing: pass --approved-by-owner once Rai has approved installing tier 3 (docs/orbit-ops-sys.md)" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "install-sys: run as root" >&2; exit 1; }
[ -x /usr/local/bin/node ] || { echo "install-sys: /usr/local/bin/node is missing (the helper runs on the same node as orbit.service)" >&2; exit 1; }
for f in /usr/bin/systemctl /usr/bin/apt-get /usr/bin/dpkg /usr/bin/dpkg-query /usr/bin/flock; do
  [ -x "$f" ] || { echo "install-sys: $f is missing; tier 3 needs it" >&2; exit 1; }
done
[ -x /usr/bin/tailscale ] || echo "install-sys: note: /usr/bin/tailscale is missing, so the Funnel actions will fail closed (OS updates and reboot are unaffected)" >&2
[ -d /usr/local/lib/orbit/ops ] || { echo "install-sys: tiers 1 and 2 are not installed (/usr/local/lib/orbit/ops is missing); install them first" >&2; exit 1; }

# Same group as tiers 1 and 2: the ORBIT service is already a member, so it needs no restart for this.
getent group orbit-ops >/dev/null || groupadd --system orbit-ops

# The tier 3 files import the shared protocol/core files, so those are installed alongside (the same bytes tier 2 installs).
install -m 644 -o root -g root \
  "$src"/../src/ops/sys-protocol.ts "$src"/../src/ops/sys-core.ts "$src"/../src/ops/sys-helper.ts "$src"/../src/ops/sys-run.ts \
  "$src"/../src/ops/admin-protocol.ts "$src"/../src/ops/admin-core.ts "$src"/../src/ops/protocol.ts \
  /usr/local/lib/orbit/ops/
install -m 644 -o root -g root \
  "$src"/systemd/orbit-ops-sys.socket "$src"/systemd/orbit-ops-sys@.service "$src"/systemd/orbit-ops-sys-update@.service \
  "$src"/systemd/orbit-ops-sys-reboot@.service "$src"/systemd/orbit-ops-sys-funnel@.service "$src"/systemd/orbit-ops-sys-recover.service \
  /etc/systemd/system/

systemctl daemon-reload
systemctl enable orbit-ops-sys.socket orbit-ops-sys-recover.service
systemctl restart orbit-ops-sys.socket
if ! systemctl show orbit.service -p SupplementaryGroups --value 2>/dev/null | grep -qw orbit-ops; then
  echo "install-sys: WARNING: orbit.service is not in group orbit-ops yet; install tier 1 (deploy/install.sh) and restart the ORBIT service" >&2
fi
echo "install-sys: done. Socket: $(ls -l /run/orbit-ops-sys.sock 2>/dev/null || echo missing)"
echo "install-sys: nothing was run. Follow the staged acceptance checklist in docs/orbit-ops-sys.md before using any action."
