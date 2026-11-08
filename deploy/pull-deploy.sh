#!/usr/bin/env bash
# Pull-based deploy, run by orbit-deploy.timer on the host.
#   pull-deploy.sh           deploy the newest main commit whose `checks` passed; restore the previous release if /status fails
#   pull-deploy.sh --drill   opt-in rollback drill (see docs/rollback-drill.md); never part of the timer path
# Both modes share one lock, one switch-and-verify flow and one rollback flow (switch_and_verify / rollback_to).
# Exit codes: 0 ok/no-op, 1 candidate failed and rollback verified, 2 ROLLBACK FAILED (needs an operator),
#             3 drill: injection did not fail the candidate (known-good restored and verified),
#             5 drill: candidate activation/restart failed or it never answered /status, so the smoke failure was NOT exercised
#               (known-good restored and verified), 64 refused (usage/precondition), 75 lock busy.
# A drill reports PASSED (exit 0) only when all three hold: the candidate was activated and restarted, the intended smoke failure
# was observed (the candidate answered /status with a commit other than the sentinel), and the known-good release was verified restored.
set -euo pipefail
ROOT="${ORBIT_DEPLOY_ROOT:-/opt/orbit}"
REPO=DragonflyAI-sh/orbit
STATE="$ROOT/state"
mode=deploy
case "${1:-}" in
  "") ;;
  --drill) mode=drill ;;
  *) echo "usage: pull-deploy.sh [--drill]" >&2; exit 64 ;;
esac
mkdir -p "$STATE" "$ROOT/releases"

# One lock for the timer, manual runs and drills. The timer path skips when busy; a drill waits briefly, then refuses.
exec 9>"$STATE/deploy.lock"
if [ "$mode" = drill ]; then lock_wait="${ORBIT_LOCK_WAIT:-60}"; else lock_wait="${ORBIT_LOCK_WAIT:-0}"; fi
if ! flock -w "$lock_wait" 9; then
  echo "deploy: another deploy or drill holds $STATE/deploy.lock; not running"
  if [ "$mode" = drill ]; then exit 75; else exit 0; fi
fi

# shellcheck source=/dev/null
. "$ROOT/orbit.env"
HEALTH_ATTEMPTS="${ORBIT_HEALTH_ATTEMPTS:-15}"
HEALTH_SLEEP="${ORBIT_HEALTH_SLEEP:-2}"
CURL_CONNECT_TIMEOUT="${ORBIT_CURL_CONNECT_TIMEOUT:-2}"
CURL_MAX_TIME="${ORBIT_CURL_MAX_TIME:-5}"

point() { ln -sfn "$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"; }
record() { # record <file> <key> <commit>: merge {key: {commit, at}} into a JSON state file
  jq -n --arg k "$2" --arg c "$3" --arg at "$(date -u +%FT%TZ)" --slurpfile old <(cat "$1" 2>/dev/null || echo '{}') \
    '$old[0] + {($k): {commit: $c, at: $at}}' > "$1.new"
  mv "$1.new" "$1"
}
# Bounded: at most HEALTH_ATTEMPTS tries, each limited by curl's connect and total timeouts.
# LAST_SEEN is the last commit /status actually answered with (empty if it never answered).
LAST_SEEN=""
healthy() {
  local i body
  LAST_SEEN=""
  for ((i = 1; i <= HEALTH_ATTEMPTS; i++)); do
    body="$(curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "http://$HOST:$PORT/status" 2>/dev/null)" || body=""
    LAST_SEEN="$(jq -r '.commit // empty' <<<"$body" 2>/dev/null)" || LAST_SEEN=""
    if [ -n "$LAST_SEEN" ] && [ "$LAST_SEEN" = "$1" ]; then return 0; fi
    if [ "$i" -lt "$HEALTH_ATTEMPTS" ]; then sleep "$HEALTH_SLEEP"; fi
  done
  return 1
}

# Written when a rollback cannot be verified. Holds paths and commits only, never environment or tokens.
rollback_failed() { # rollback_failed <reason> <previous> <previous-commit> <candidate>
  local f="$STATE/rollback-failed-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  jq -n --arg mode "$mode" --arg reason "$1" --arg previous "$2" --arg previousCommit "$3" --arg candidate "$4" \
    --arg current "$(readlink -f "$ROOT/current" 2>/dev/null || true)" --arg at "$(date -u +%FT%TZ)" \
    '{mode: $mode, reason: $reason, knownGoodTarget: $previous, knownGoodCommit: $previousCommit, candidate: $candidate, currentTarget: $current, at: $at}' > "$f.new" \
    && mv "$f.new" "$f" || true
  echo "deploy: ROLLBACK FAILED: $1"
  echo "deploy: orbit may be down. Recover by hand: point $ROOT/current at $2 and restart orbit; details in $f"
}

# Shared rollback: switch back, restart, and confirm the restored commit is really served. 0 verified, 1 not.
rollback_to() { # rollback_to <previous> <previous-commit> <candidate>
  local previous="$1" prev_commit="$2" candidate="$3"
  if [ -z "$previous" ] || [ ! -d "$previous" ]; then
    systemctl stop orbit || true
    echo "deploy: no previous release; orbit stopped"
    return 1
  fi
  if ! point "$previous"; then rollback_failed "could not switch current back to the known-good release" "$previous" "$prev_commit" "$candidate"; return 2; fi
  if ! systemctl restart orbit; then rollback_failed "orbit failed to restart on the known-good release" "$previous" "$prev_commit" "$candidate"; return 2; fi
  if [ -z "$prev_commit" ]; then
    # Legacy release without a COMMIT file: restore it anyway (better than leaving the failed candidate), but identity cannot be proven.
    rollback_failed "restored $previous and restarted orbit, but UNVERIFIED: that release has no COMMIT, so what /status serves cannot be proven to be it" "$previous" "" "$candidate"
    return 2
  fi
  if ! healthy "$prev_commit"; then rollback_failed "known-good $prev_commit is not served on /status after rollback" "$previous" "$prev_commit" "$candidate"; return 2; fi
  echo "deploy: rolled back to $prev_commit (verified serving)"
  return 0
}

# Shared flow for deploys and drills. Returns 0 candidate healthy, 1 candidate failed and the previous release is verified restored
# (or there is no previous release), 2 candidate failed and restoration failed or could not be verified. It writes no deploy state.
# SWITCH_OUTCOME says why the candidate did not go live, so callers never have to guess from the return code:
#   healthy            candidate served the expected commit (return 0)
#   activation-failed  could not point current at the candidate; the restart was never attempted
#   restart-failed     systemctl restart orbit failed on the candidate
#   smoke-failed       restarted fine but /status never served the expected commit; SMOKE_SEEN is the commit it did serve (empty = no answer)
SWITCH_OUTCOME=""
SMOKE_SEEN=""
switch_and_verify() { # switch_and_verify <candidate-dir> <expected-commit> <previous-dir> <previous-commit>
  local candidate="$1" expected="$2" previous="$3" prev_commit="$4" rc=0
  SWITCH_OUTCOME=""; SMOKE_SEEN=""
  if ! point "$candidate"; then
    SWITCH_OUTCOME=activation-failed
    echo "deploy: could not switch to candidate $expected (activation failed)"
    # current should be untouched, so the previous release is still running. Prove it instead of assuming it.
    if [ -n "$previous" ] && [ "$(readlink -f "$ROOT/current" 2>/dev/null || true)" = "$previous" ] && [ -n "$prev_commit" ] && healthy "$prev_commit"; then
      echo "deploy: previous release $prev_commit still served (verified); nothing changed"
      return 1
    fi
    rollback_to "$previous" "$prev_commit" "$candidate" || rc=$?
    [ "$rc" = 2 ] && return 2
    return 1
  fi
  if systemctl restart orbit; then
    if healthy "$expected"; then SWITCH_OUTCOME=healthy; return 0; fi
    SWITCH_OUTCOME=smoke-failed; SMOKE_SEEN="$LAST_SEEN"
    echo "deploy: $expected failed its smoke test"
  else
    SWITCH_OUTCOME=restart-failed
    echo "deploy: orbit failed to restart on candidate $expected"
  fi
  rollback_to "$previous" "$prev_commit" "$candidate" || rc=$?
  [ "$rc" = 2 ] && return 2
  return 1
}

commit_of() { cat "$1/COMMIT" 2>/dev/null || true; }

# Remove a drill candidate directory, but only after restoration was verified, and only if it is provably a drill candidate:
# directly under $ROOT/drill/, not a symlink, and neither the release current resolves to nor the recovery target.
cleanup_candidate() { # cleanup_candidate <candidate> <known-good-target>
  local candidate="$1" known="$2" real cur
  [ -n "$candidate" ] && [ -n "$known" ] || return 0
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 0
  real="$(readlink -f "$candidate")"
  cur="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
  if [ "$(dirname "$real")" != "$(readlink -f "$ROOT/drill")" ] || [ "$real" = "$cur" ] || [ "$real" = "$(readlink -f "$known")" ]; then
    echo "deploy: not removing $candidate (not a drill candidate, or it is the running/recovery release)"
    return 0
  fi
  rm -rf "${real:?}"
  echo "deploy: removed drill candidate $real"
}

# A drill killed mid-flight leaves this marker. The next run restores the known-good release before anything else,
# and removes the drill candidate only once that restoration is verified.
DRILL_DIR="$STATE/drill"
recover_interrupted_drill() {
  local marker="$DRILL_DIR/in-progress.json" previous commit candidate
  [ -f "$marker" ] || return 0
  previous="$(jq -r '.knownGoodTarget // ""' "$marker")"
  commit="$(jq -r '.knownGoodCommit // ""' "$marker")"
  candidate="$(jq -r '.candidate // ""' "$marker")"
  if [ "$(dirname "$previous")" != "$ROOT/releases" ]; then
    echo "deploy: drill marker $marker names an unexpected recovery target; not guessing. Recover by hand (docs/rollback-drill.md)"; exit 2
  fi
  echo "deploy: an earlier drill was interrupted; restoring $commit"
  if rollback_to "$previous" "$commit" "interrupted drill"; then
    rm -f "$marker"
    cleanup_candidate "$candidate" "$previous"
  else
    exit 2
  fi
}

drill() {
  local current known candidate sentinel id rc=0 outcome
  current="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
  known="$(commit_of "$current")"
  if [[ ! "$known" =~ ^[0-9a-f]{40}$ ]] || [ "$(dirname "$current")" != "$ROOT/releases" ]; then
    echo "drill: refused: $ROOT/current must point at a release under $ROOT/releases with a 40-hex COMMIT"; exit 64
  fi
  if [ "${ORBIT_DRILL_CONFIRM:-}" != "$known" ]; then
    echo "drill: refused: set ORBIT_DRILL_CONFIRM to the known-good commit you recorded ($known) to opt in"; exit 64
  fi
  if compgen -G "$STATE/rollback-failed-*.json" >/dev/null; then
    echo "drill: refused: an unresolved rollback failure is recorded in $STATE; recover, then move rollback-failed-*.json aside"; exit 64
  fi
  if [ -f "$DRILL_DIR/in-progress.json" ]; then
    echo "drill: refused: $DRILL_DIR/in-progress.json exists (an earlier drill did not finish). Run pull-deploy.sh once without --drill to restore and clean up, or recover by hand"; exit 64
  fi
  if ! healthy "$known"; then
    echo "drill: refused: known-good $known is not currently served on /status; a drill must start healthy"; exit 64
  fi

  id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  candidate="$ROOT/drill/$id"          # separate from releases/: never counted by release cleanup, never the running release
  sentinel="drill-$id"                  # /status can never return this, so the candidate smoke test fails deterministically, once
  mkdir -p "$candidate" "$DRILL_DIR"
  cp -a "$current/." "$candidate/"
  echo "$sentinel" > "$candidate/COMMIT"   # release.env still says ORBIT_COMMIT=$known, so the candidate really runs
  jq -n --arg t "$current" --arg c "$known" --arg cand "$candidate" --arg at "$(date -u +%FT%TZ)" \
    '{knownGoodTarget: $t, knownGoodCommit: $c, candidate: $cand, at: $at}' > "$DRILL_DIR/in-progress.json"
  # On INT/TERM/HUP: ignore further signals, restore and verify, remove the candidate only if that was verified (recover exits 2 otherwise).
  trap 'trap "" INT TERM HUP; echo "drill: interrupted; restoring known-good"; recover_interrupted_drill; exit 130' INT TERM HUP
  echo "drill: known-good $known at $current"
  echo "drill: failure injection: candidate $candidate must fail its smoke test (expects $sentinel); only the candidate is affected"

  switch_and_verify "$candidate" "$sentinel" "$current" "$known" || rc=$?
  outcome="$SWITCH_OUTCOME"
  # The result is decided by the outcome of each step, never by "switch_and_verify returned non-zero".
  if [ "$rc" = 2 ]; then
    echo "drill: candidate outcome: $outcome; restoration of $known FAILED or is unverified"
  elif [ "$rc" = 0 ]; then
    echo "drill: INJECTION INEFFECTIVE: candidate passed its smoke test; restoring known-good"
    if rollback_to "$current" "$known" "$candidate"; then rc=3; else rc=2; fi
  elif [ "$outcome" = smoke-failed ] && [ "$SMOKE_SEEN" = "$known" ]; then
    echo "drill: injected candidate failure observed (candidate ran and served $SMOKE_SEEN, not $sentinel); rollback verified, serving $known"
    if [ "$(readlink -f "$ROOT/current")" != "$current" ]; then echo "drill: current does not point at the known-good target after rollback"; rc=2; else rc=0; fi
  else
    local seen_note="no usable /status answer"; [ -n "$SMOKE_SEEN" ] && seen_note="served $SMOKE_SEEN"
    # activation failed, restart failed, or the candidate never answered /status (or answered something unexpected): the intended failure was NOT exercised.
    echo "drill: NOT EXERCISED: candidate outcome '$outcome' ($seen_note); the smoke-failure path was not tested. Known-good restoration was verified"
    if [ "$(readlink -f "$ROOT/current")" != "$current" ]; then echo "drill: current does not point at the known-good target after rollback"; rc=2; else rc=5; fi
  fi
  if [ "$rc" = 2 ]; then
    record "$DRILL_DIR/last.json" rollback-failed "$known"
    echo "drill: FAILED: recovery not verified. Candidate kept at $candidate; follow the manual recovery in docs/rollback-drill.md"
    return 2
  fi
  # Restoration of $known is verified here, so the candidate may go.
  rm -f "$DRILL_DIR/in-progress.json"; cleanup_candidate "$candidate" "$current"
  if [ "$rc" = 3 ]; then record "$DRILL_DIR/last.json" injection-ineffective "$known"; return 3; fi
  if [ "$rc" = 5 ]; then record "$DRILL_DIR/last.json" "not-exercised-$outcome" "$known"; echo "drill: FAILED (not a pass): $outcome"; return 5; fi
  record "$DRILL_DIR/last.json" passed "$known"
  echo "drill: PASSED (candidate activated, intended smoke failure observed, recovery verified; normal deploy state untouched)"
}

if [ "$mode" = drill ]; then
  drill; exit $?
fi
recover_interrupted_drill

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

conclusion="$(curl -fsS --connect-timeout 10 --max-time 30 "https://api.github.com/repos/$REPO/commits/$sha/check-runs?check_name=checks" \
  | jq -r '[.check_runs[] | select(.status == "completed") | .conclusion][0] // "pending"')"
if [ "$conclusion" != success ]; then
  echo "deploy: $sha checks are $conclusion; not deploying"
  exit 0
fi

previous="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
release="$ROOT/releases/$sha"
# Never rebuild the running or known-good directory: it is the rollback target.
if [ -n "$previous" ] && [ "$(readlink -f "$release")" = "$previous" ]; then
  echo "deploy: $release is the running release; refusing to rebuild it"
  exit 0
fi
rm -rf "$release" && mkdir -p "$release"
git -C "$ROOT/repo" archive "$sha" | tar -x -C "$release"
echo "$sha" > "$release/COMMIT"
echo "ORBIT_COMMIT=$sha" > "$release/release.env"

prev_commit=""
if [ -n "$previous" ]; then prev_commit="$(commit_of "$previous")"; fi
rc=0
switch_and_verify "$release" "$sha" "$previous" "$prev_commit" || rc=$?
if [ "$rc" = 0 ]; then
  rm -f "$STATE/failed"
  record "$STATE/deploy.json" lastDeployed "$sha"
  echo "deploy: $sha is live"
else
  echo "$sha" > "$STATE/failed"
  record "$STATE/deploy.json" lastFailed "$sha"
  exit "$rc"
fi

# Keep the five newest releases; never the running one or the one just rolled away from (the rollback target).
keep="$(readlink -f "$ROOT/current")"
ls -1t "$ROOT/releases" | tail -n +6 | while read -r name; do
  if [[ "$name" =~ ^[0-9a-f]{40}$ ]] && [ "$ROOT/releases/$name" != "$keep" ] && [ "$ROOT/releases/$name" != "$previous" ]; then
    rm -rf "${ROOT:?}/releases/$name"
  fi
done
