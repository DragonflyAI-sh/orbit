#!/usr/bin/env bash
# Updates this instance repo to a commit of the platform (DragonflyAI-sh/agent-platform), keeping the instance's own files.
#
#   tools/sync-platform.sh [ref]       ref: a branch, tag or commit of the platform (default: main)
#
# An instance repo (orbit, nova, ...) is the platform's tree at the commit in PLATFORM_COMMIT plus the paths listed in
# INSTANCE_FILES (at least persona/). The host deploys it with `git archive` and Node runs its TypeScript directly, so the
# platform is a pinned copy here rather than a submodule (left out of `git archive`) or a package (Node does not strip
# types under node_modules). This script replaces every other file with the platform's, deletes files the platform
# deleted, writes PLATFORM_COMMIT, and leaves the result uncommitted for review: run `pnpm typecheck && pnpm test`, then
# commit "Sync platform <sha>" and open a PR.
set -euo pipefail
ref="${1:-main}"
platform="${PLATFORM_REPO:-https://github.com/DragonflyAI-sh/agent-platform.git}"
here="$(git rev-parse --show-toplevel)"
cd "$here"
[ -f INSTANCE_FILES ] || { echo "sync-platform: no INSTANCE_FILES here; is this an instance repo?" >&2; exit 64; }
if [ -n "$(git status --porcelain)" ]; then echo "sync-platform: the working tree has changes; commit or stash them first" >&2; exit 64; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone -q --filter=blob:none --no-checkout "$platform" "$tmp/p"
sha="$(git -C "$tmp/p" rev-parse --verify "$ref^{commit}" 2>/dev/null || { git -C "$tmp/p" fetch -q origin "$ref" && git -C "$tmp/p" rev-parse FETCH_HEAD; })"
mkdir "$tmp/tree"
git -C "$tmp/p" archive "$sha" | tar -x -C "$tmp/tree"

# Instance paths, one per line (comments and blank lines ignored). They are never overwritten or deleted.
mapfile -t keep < <(sed -e 's/#.*//' -e 's/[[:space:]]*$//' INSTANCE_FILES | grep -v '^$')
keep+=(INSTANCE_FILES PLATFORM_COMMIT)
is_kept() { local f="$1" k; for k in "${keep[@]}"; do k="${k%/}"; [ "$f" = "$k" ] || [[ "$f" == "$k/"* ]] && return 0; done; return 1; }

# Delete tracked files that are neither the platform's nor the instance's.
git ls-files -z | while IFS= read -r -d '' f; do
  if ! is_kept "$f" && [ ! -e "$tmp/tree/$f" ]; then git rm -q -- "$f"; fi
done
# Copy the platform's files, except where the instance owns the path.
(cd "$tmp/tree" && find . -type f -print0) | while IFS= read -r -d '' f; do
  f="${f#./}"
  is_kept "$f" && continue
  mkdir -p "$(dirname "$f")"
  cp -p "$tmp/tree/$f" "$f"
done
echo "$sha" > PLATFORM_COMMIT
git add -A
echo "sync-platform: staged platform $sha; review with git diff --cached, then pnpm typecheck && pnpm test"
