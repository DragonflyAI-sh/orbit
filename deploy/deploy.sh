#!/usr/bin/env bash
# Usage: deploy.sh <image> <commit> <bind-address>
# Starts the image, checks /status reports the commit, and restores the previous image on failure.
set -u
image="$1"; commit="$2"; bind="$3"
name="${ORBIT_CONTAINER:-orbit}"; port="${ORBIT_PORT:-8790}"

previous="$(docker inspect --format '{{.Config.Image}}' "$name" 2>/dev/null || true)"

start() {
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" --restart unless-stopped -p "$bind:$port:8790" "$1" >/dev/null
}

healthy() {
  for _ in $(seq 1 15); do
    curl -fsS "http://$bind:$port/status" 2>/dev/null | grep -q "\"commit\": \"$1\"" && return 0
    sleep 2
  done
  return 1
}

docker pull "$image" || { echo "deploy: pull failed; running build untouched"; exit 1; }
if start "$image" && healthy "$commit"; then
  echo "deploy: $commit is live"
  exit 0
fi
echo "deploy: $commit failed its smoke test"
if [ -n "$previous" ]; then
  start "$previous" && echo "deploy: rolled back to $previous"
fi
exit 1
