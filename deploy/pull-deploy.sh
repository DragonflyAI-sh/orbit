#!/usr/bin/env bash
# Pull-based deploy, run by orbit-deploy.timer on the host.
# Deploys the newest main commit whose `checks` passed, then restores the previous release if /status fails.
set -euo pipefail
ROOT=/opt/orbit
REPO=DragonflyAI-sh/orbit
STATE="$ROOT/state"
mkdir -p "$STATE" "$ROOT/releases"
# shellcheck source=/dev/null
. "$ROOT/orbit.env"

# Refresh the read-only vault copy. A failure here never blocks a deploy; /status shows the sync age.
if [ -d "$ROOT/vault/.git" ]; then
  if git -C "$ROOT/vault" pull -q --ff-only; then
    jq -n --arg c "$(git -C "$ROOT/vault" rev-parse HEAD)" --arg at "$(date -u +%FT%TZ)" '{commit: $c, at: $at}' > "$STATE/vault.json.new" \
      && mv "$STATE/vault.json.new" "$STATE/vault.json"
  else
    echo "deploy: vault refresh failed"
  fi
fi

git -C "$ROOT/repo" fetch -q origin main
sha="$(git -C "$ROOT/repo" rev-parse origin/main)"
current="$(cat "$ROOT/current/COMMIT" 2>/dev/null || true)"
[ "$sha" = "$current" ] && exit 0
[ "$sha" = "$(cat "$STATE/failed" 2>/dev/null || true)" ] && exit 0

conclusion="$(curl -fsS "https://api.github.com/repos/$REPO/commits/$sha/check-runs?check_name=checks" \
  | jq -r '[.check_runs[] | select(.status == "completed") | .conclusion][0] // "pending"')"
if [ "$conclusion" != success ]; then
  echo "deploy: $sha checks are $conclusion; not deploying"
  exit 0
fi

release="$ROOT/releases/$sha"
rm -rf "$release" && mkdir -p "$release"
git -C "$ROOT/repo" archive "$sha" | tar -x -C "$release"
echo "$sha" > "$release/COMMIT"
echo "ORBIT_COMMIT=$sha" > "$release/release.env"

previous="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
point() { ln -sfn "$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"; }
record() {
  jq -n --arg k "$1" --arg c "$2" --arg at "$(date -u +%FT%TZ)" --slurpfile old <(cat "$STATE/deploy.json" 2>/dev/null || echo '{}') \
    '$old[0] + {($k): {commit: $c, at: $at}}' > "$STATE/deploy.json.new"
  mv "$STATE/deploy.json.new" "$STATE/deploy.json"
}
healthy() {
  for _ in $(seq 1 15); do
    curl -fsS "http://$HOST:$PORT/status" 2>/dev/null | jq -e --arg c "$1" '.commit == $c' >/dev/null && return 0
    sleep 2
  done
  return 1
}

point "$release"
systemctl restart orbit
if healthy "$sha"; then
  rm -f "$STATE/failed"
  record lastDeployed "$sha"
  echo "deploy: $sha is live"
else
  echo "$sha" > "$STATE/failed"
  record lastFailed "$sha"
  echo "deploy: $sha failed its smoke test"
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    point "$previous" && systemctl restart orbit && echo "deploy: rolled back to $(cat "$previous/COMMIT")"
  else
    systemctl stop orbit && echo "deploy: no previous release; orbit stopped"
  fi
  exit 1
fi

# Keep the five newest releases; never the running one.
keep="$(readlink -f "$ROOT/current")"
ls -1t "$ROOT/releases" | tail -n +6 | while read -r name; do
  if [[ "$name" =~ ^[0-9a-f]{40}$ ]] && [ "$ROOT/releases/$name" != "$keep" ]; then
    rm -rf "${ROOT:?}/releases/$name"
  fi
done
