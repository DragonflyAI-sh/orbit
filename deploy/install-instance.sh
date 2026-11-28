#!/usr/bin/env bash
# One-time setup of another instance of the platform on a host that already runs ORBIT, as root:
#
#   install-instance.sh <name> <owner/repo> <port> [bind-address] [owner-tailscale-login]
#   e.g. install-instance.sh nova DragonflyAI-sh/nova 8792
#
# The instance gets its own everything: /opt/<name> (repo clone, releases, state), <name>.env, <name>.service (its own
# DynamicUser and StateDirectory, so its threads, jobs and ChatGPT sign-in are separate from ORBIT's), and
# <name>-deploy.timer, which deploys the newest green commit of <owner/repo> every 2 minutes exactly as ORBIT's does.
# Bind address and owner default to ORBIT's (/opt/orbit/orbit.env), so the instance is reachable at the same host on <port>.
#
# Not set up for an instance (ORBIT-only, opt-in later): the root ops helpers (/run/orbit-ops*.sock), the orbit-jobs
# Tailscale node and job ingress, and the vault copy. /status reports each of those as not connected. Credentials are the
# instance's own: /etc/credstore/<name>.* (for example <name>.discord-bot), never ORBIT's orbit.*.
# Re-running is safe: it keeps settings in <name>.env it does not manage and never touches ORBIT's units or files.
set -euo pipefail
usage() { echo "usage: install-instance.sh <name> <owner/repo> <port> [bind-address] [owner-tailscale-login]" >&2; exit 64; }
[ "$#" -ge 3 ] || usage
name="$1" repo="$2" port="$3"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "name must be lowercase letters, digits and dashes" >&2; exit 64; }
[ "$name" != orbit ] || { echo "ORBIT is installed by deploy/install.sh, not this script" >&2; exit 64; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repo must be owner/name" >&2; exit 64; }
[[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || { echo "port must be 1024-65535" >&2; exit 64; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 64; }

orbit_env=/opt/orbit/orbit.env
from_orbit() { [ -r "$orbit_env" ] && sed -n "s/^$1=//p" "$orbit_env" | tail -1 || true; }
bind="${4:-$(from_orbit HOST)}"
owner="${5:-$(from_orbit ORBIT_OWNER)}"
[ -n "$bind" ] || { echo "no bind address given and none in $orbit_env" >&2; exit 64; }
[ -n "$owner" ] || { echo "no owner login given and none in $orbit_env" >&2; exit 64; }

ROOT="/opt/$name"
envfile="$ROOT/$name.env"
# Refuse a port someone else already listens on (ORBIT's own 8790/8791 included), unless it is this instance.
if command -v ss >/dev/null && ss -Hltn "sport = :$port" | grep -q . && ! { [ -r "$envfile" ] && grep -qx "PORT=$port" "$envfile"; }; then
  echo "port $port is already in use on this host" >&2; exit 64
fi

mkdir -p "$ROOT/state" "$ROOT/releases" "/usr/local/lib/$name"
[ -d "$ROOT/repo/.git" ] || git clone -q "https://github.com/$repo.git" "$ROOT/repo"

managed='^(HOST|PORT|ORBIT_DEPLOY_STATE|ORBIT_OWNER)='
kept="$(grep -Ev "$managed" "$envfile" 2>/dev/null || true)"
{
  printf 'HOST=%s\nPORT=%s\nORBIT_DEPLOY_STATE=%s/state/deploy.json\nORBIT_OWNER=%s\n' "$bind" "$port" "$ROOT" "$owner"
  if [ -n "$kept" ]; then printf '%s\n' "$kept"; fi
} > "$envfile.new"
mv "$envfile.new" "$envfile"

src="$(cd "$(dirname "$0")" && pwd)"
install -m 755 "$src/pull-deploy.sh" "/usr/local/lib/$name/pull-deploy.sh"

cat > "/etc/systemd/system/$name.service" <<EOF
[Unit]
Description=$name agent (platform instance)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
EnvironmentFile=$envfile
EnvironmentFile=$ROOT/current/release.env
WorkingDirectory=$ROOT/current
ExecStart=/usr/local/bin/node src/main.ts
Restart=always
RestartSec=5
DynamicUser=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
# Asks tailscaled who sent each request (owner check).
ReadWritePaths=/run/tailscale
# The instance's own credentials: /etc/credstore/$name.* (root, 0600), e.g. $name.discord-bot for Discord (docs/discord.md).
ImportCredential=$name.*
StateDirectory=$name

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/$name-deploy.service" <<EOF
[Unit]
Description=Deploy the newest green $name commit
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=ORBIT_INSTANCE=$name
Environment=ORBIT_DEPLOY_ROOT=$ROOT
Environment=ORBIT_DEPLOY_REPO=$repo
ExecStart=/usr/local/lib/$name/pull-deploy.sh
EOF

cat > "/etc/systemd/system/$name-deploy.timer" <<EOF
[Unit]
Description=Check for a new $name commit every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable "$name.service"
systemctl enable --now "$name-deploy.timer"
# The first deploy builds a release from the newest green commit and starts the service; it fails (and says why) if that
# commit's checks have not passed yet. The timer retries every 2 minutes.
systemctl start "$name-deploy.service" || true
journalctl -u "$name-deploy.service" -n 5 --no-pager || true
echo "$name: http://$bind:$port/  (status: http://$bind:$port/status)"
