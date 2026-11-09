#!/usr/bin/env bash
# Removes ONLY tier 3, run as root:  sudo /opt/orbit/current/deploy/uninstall-sys.sh [--purge-state]
# Stops and disables the tier 3 socket and the post-boot recovery, removes their units and the sys-*.ts files, and (only with
# --purge-state) deletes /var/lib/orbit-ops-sys (operation records). It leaves tiers 1 and 2, the shared protocol/core files, orbit.env,
# credentials, OpenClaw and every Tailscale instance alone. It does not undo an operation that already ran (see "Rollback" in
# docs/orbit-ops-sys.md): ORBIT then simply reports tier 3 as unavailable and offers no proposals.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "uninstall-sys: run as root" >&2; exit 1; }
systemctl disable --now orbit-ops-sys.socket orbit-ops-sys-recover.service 2>/dev/null || true
# A runner that is mid-operation is not killed: the operation finishes or is stopped by systemd's own timeout.
active="$(systemctl list-units --plain --no-legend 'orbit-ops-sys-*@*.service' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
if systemctl list-units --plain --no-legend 'orbit-ops-sys-reboot@*.service' 2>/dev/null | grep -q .; then
  echo "uninstall-sys: WARNING: a reboot runner is active. A SCHEDULED REBOOT WILL STILL FIRE if it is left running: cancel it first (ORBIT chat: ops_sys_cancel_reboot), or stop it by hand (systemctl stop 'orbit-ops-sys-reboot@*.service')." >&2
fi
[ -z "$active" ] || echo "uninstall-sys: WARNING: runners still active (left running, not killed): $active" >&2
rm -f /etc/systemd/system/orbit-ops-sys.socket /etc/systemd/system/orbit-ops-sys@.service /etc/systemd/system/orbit-ops-sys-update@.service \
  /etc/systemd/system/orbit-ops-sys-reboot@.service /etc/systemd/system/orbit-ops-sys-funnel@.service /etc/systemd/system/orbit-ops-sys-recover.service /etc/systemd/system/orbit-ops-sys-plan@.service
rm -f /usr/local/lib/orbit/ops/sys-protocol.ts /usr/local/lib/orbit/ops/sys-core.ts /usr/local/lib/orbit/ops/sys-helper.ts /usr/local/lib/orbit/ops/sys-run.ts
systemctl daemon-reload
[ "${1:-}" != "--purge-state" ] || rm -rf /var/lib/orbit-ops-sys
echo "uninstall-sys: done. Tier 3 is removed; tiers 1 and 2 are unchanged."
