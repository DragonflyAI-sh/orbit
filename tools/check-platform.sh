#!/usr/bin/env bash
# CI check for instance repos (orbit, nova, ...): everything outside the instance's own paths (INSTANCE_FILES, at least persona/)
# must be exactly the platform (DragonflyAI-sh/agent-platform) at the commit in PLATFORM_COMMIT. So a feature can only be added in
# the platform, and reaches every instance through tools/sync-platform.sh; an instance can never quietly carry code of its own.
#
#   tools/check-platform.sh            exit 0 same, 1 drift (the files are listed), 2 the platform commit could not be fetched
#
# In the platform repo itself (no PLATFORM_COMMIT) it does nothing and exits 0.
set -euo pipefail
here="$(git rev-parse --show-toplevel)"
cd "$here"
[ -f PLATFORM_COMMIT ] || { echo "check-platform: no PLATFORM_COMMIT (the platform repo itself); nothing to check"; exit 0; }
[ -f INSTANCE_FILES ] || { echo "check-platform: PLATFORM_COMMIT without INSTANCE_FILES" >&2; exit 1; }
sha="$(tr -d '[:space:]' < PLATFORM_COMMIT)"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "check-platform: PLATFORM_COMMIT is not a full commit id" >&2; exit 1; }
platform="${PLATFORM_REPO:-https://github.com/DragonflyAI-sh/agent-platform.git}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git init -q "$tmp/p"
if ! git -C "$tmp/p" fetch -q --depth=1 "$platform" "$sha" 2>/dev/null; then
  echo "check-platform: could not fetch platform commit $sha from $platform" >&2
  exit 2
fi
mkdir "$tmp/tree"
git -C "$tmp/p" archive FETCH_HEAD | tar -x -C "$tmp/tree"

mapfile -t keep < <(sed -e 's/#.*//' -e 's/[[:space:]]*$//' INSTANCE_FILES | grep -v '^$')
keep+=(INSTANCE_FILES PLATFORM_COMMIT)
is_kept() { local f="$1" k; for k in "${keep[@]}"; do k="${k%/}"; if [ "$f" = "$k" ] || [[ "$f" == "$k/"* ]]; then return 0; fi; done; return 1; }

drift=()
# Files here that differ from the platform's, or that the platform does not have.
while IFS= read -r -d '' f; do
  is_kept "$f" && continue
  if [ ! -e "$tmp/tree/$f" ]; then drift+=("only in this repo: $f")
  elif ! cmp -s "$f" "$tmp/tree/$f"; then drift+=("differs from the platform: $f"); fi
done < <(git ls-files -z)
# Platform files missing here.
while IFS= read -r -d '' f; do
  f="${f#./}"
  is_kept "$f" && continue
  git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 || drift+=("missing here: $f")
done < <(cd "$tmp/tree" && find . -type f -print0)

if [ "${#drift[@]}" -gt 0 ]; then
  echo "check-platform: this repo has drifted from agent-platform ${sha:0:7}:"
  printf '  %s\n' "${drift[@]}"
  echo "Change platform code in DragonflyAI-sh/agent-platform and run tools/sync-platform.sh; change only ${keep[*]} here."
  exit 1
fi
echo "check-platform: identical to agent-platform ${sha:0:7} outside ${keep[*]}"
