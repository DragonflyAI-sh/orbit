#!/usr/bin/env bash
# Removes ONLY the orbit-ops-ws helper, run as root:  sudo /opt/orbit/current/deploy/uninstall-ws.sh [--purge-state]
# Stops and disables its socket, removes its four units and the ws-*.ts files, and (only with --purge-state) deletes
# /var/lib/orbit-ops-ws (operation records only). It never touches what a setup created: workspace images and data, mounts and their
# units, the orbit.service drop-in, /etc/orbit/workspaces.json, the orbit user and group, or packages. It leaves tiers 1-3 and the
# shared protocol.ts alone. What it leaves, and how to remove each by hand, is printed at the end.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "uninstall-ws: run as root" >&2; exit 1; }
systemctl disable --now orbit-ops-ws.socket 2>/dev/null || true
# A runner that is mid-operation is not killed: the operation finishes or is stopped by systemd's own timeout.
active="$(systemctl list-units --plain --no-legend 'orbit-ops-ws-run@*.service' 'orbit-ops-ws-pkg@*.service' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
[ -z "$active" ] || echo "uninstall-ws: WARNING: runners still active (left running, not killed): $active" >&2
rm -f /etc/systemd/system/orbit-ops-ws.socket /etc/systemd/system/orbit-ops-ws@.service /etc/systemd/system/orbit-ops-ws-run@.service /etc/systemd/system/orbit-ops-ws-pkg@.service
rm -f /usr/local/lib/orbit/ops/ws-protocol.ts /usr/local/lib/orbit/ops/ws-core.ts /usr/local/lib/orbit/ops/ws-helper.ts /usr/local/lib/orbit/ops/ws-run.ts
systemctl daemon-reload
[ "${1:-}" != "--purge-state" ] || rm -rf /var/lib/orbit-ops-ws
cat <<'EOF'
uninstall-ws: done. The helper is removed; tiers 1-3 are unchanged.
uninstall-ws: LEFT IN PLACE (never removed by this script). To undo by hand, in this order, at a quiet time:
  1. Stop permitting workspace tools: remove the Environment= line from (or delete)
       /etc/systemd/system/orbit.service.d/60-orbit-workspace.conf
     then: systemctl daemon-reload && systemctl restart orbit.service
  2. Workspace mounts (DATA INSIDE IS LOST if you delete the images afterwards; copy it out first):
       systemctl disable --now 'srv-orbit\x2dworkspaces-scratch.mount' 'srv-orbit\x2dworkspaces-orbit\x2dvalidation.mount'
       rm '/etc/systemd/system/srv-orbit\x2dworkspaces-scratch.mount' '/etc/systemd/system/srv-orbit\x2dworkspaces-orbit\x2dvalidation.mount'
       systemctl daemon-reload
  3. Images (irreversible):          /var/lib/orbit-workspaces/*.img
  4. Workspaces file:                /etc/orbit/workspaces.json
  5. The static orbit user/group (ORBIT then gets a dynamic uid again at its next restart):  userdel orbit
  6. The bubblewrap package:         apt-get remove bubblewrap   (only if nothing else needs it)
EOF
