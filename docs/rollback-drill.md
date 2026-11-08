# Production rollback drill (operator runbook)

The drill proves, on the real host, that a failed candidate is rolled back and the known-good release is served again. It runs the same `switch_and_verify` and `rollback_to` code as a real deployment, against a throwaway candidate. It is opt-in, never started by the timer, and never run by CI or by agents. Do not use old `orbit-1` hosts or migration rollback scripts for any step here.

## What the drill does

- Takes the lock `/opt/orbit/state/deploy.lock` (shared with the timer and manual runs). If it cannot get it within `ORBIT_LOCK_WAIT` (60 s for a drill) it exits 75 and changes nothing. A normal run that finds the lock busy logs it and exits 0.
- Refuses unless `ORBIT_DRILL_CONFIRM` equals the commit that `/opt/orbit/current` serves, `current` points under `/opt/orbit/releases`, `/status` currently serves that commit, and no `state/rollback-failed-*.json` is left over (exit 64).
- Copies the running release to `/opt/orbit/drill/<id>/`. That is outside `releases/`, so cleanup never counts or removes it, and the running release is never modified. The candidate's `COMMIT` is a sentinel `drill-<id>` that `/status` can never return. Its `release.env` still names the real commit, so orbit really runs. The candidate smoke test therefore fails deterministically, once. No broken commit is deployed.
- Switches `current` to the candidate, restarts orbit, runs the bounded smoke test (fails by design), then rolls back: switch `current` to the recorded known-good target, restart, and require `/status` to serve the known-good commit.
- Drill state lives only in `/opt/orbit/state/drill/`. It never writes `state/failed`, `deploy.json` (`lastDeployed` / `lastFailed`) or any other normal-deploy state, so normal failed-SHA suppression and `/status` deploy reporting are unaffected.
- While a drill runs it keeps `state/drill/in-progress.json`. If the drill is killed (even `kill -9`), the next normal run restores the known-good release before anything else.

## Bounds

| Step | Bound |
| --- | --- |
| Each `/status` probe | `curl --connect-timeout 2 --max-time 5` (`ORBIT_CURL_CONNECT_TIMEOUT`, `ORBIT_CURL_MAX_TIME`) |
| One health check | 15 attempts, 2 s apart (`ORBIT_HEALTH_ATTEMPTS`, `ORBIT_HEALTH_SLEEP`); worst case about 105 s |
| Lock wait | 60 s for a drill, 0 s for the timer path |
| Expected drill duration | about 40-60 s: pre-flight check (seconds), candidate smoke failure (the full 15 attempts, about 30 s), rollback (seconds) |
| Worst case | pre-flight + candidate + rollback, about 5.5 minutes |

Expected outage: two orbit restarts, a few seconds each. The candidate runs the same code, but `/status` is judged "failing" for about 30 s, and chat can briefly drop at each restart. Pick a quiet time.

## Prerequisites

1. Open **two** SSH sessions to the host. Keep the second one idle as an independent recovery connection, and confirm it works (`sudo true`). Do not rely on orbit, Tailscale-served ORBIT routes or chat to reach the host. Do the drill from a session that survives disconnects (the `systemd-run` command below does).
2. Merge the change and wait for `checks` to pass on `main` and the normal deploy to go live. That deploys the application only. **`/usr/local/lib/orbit/pull-deploy.sh` is a separate file and is not updated by an application deploy.**
3. Verify the installed script is the updated one:
   ```
   sudo grep -c -- '--drill' /usr/local/lib/orbit/pull-deploy.sh      # must be 1 or more
   sudo git -C /opt/orbit/repo fetch -q origin main
   sudo sha256sum /usr/local/lib/orbit/pull-deploy.sh
   sudo git -C /opt/orbit/repo show origin/main:deploy/pull-deploy.sh | sha256sum   # must match
   ```
4. If it does not match, install it. First stop the timer and make sure no deploy is running, because the old script has no lock, and replacing a running shell script is unsafe:
   ```
   sudo systemctl stop orbit-deploy.timer
   systemctl is-active orbit-deploy.service      # wait until "inactive"
   sudo git -C /opt/orbit/repo show origin/main:deploy/pull-deploy.sh | sudo install -m 755 /dev/stdin /usr/local/lib/orbit/pull-deploy.sh
   ```
   Re-run step 3. (Re-running `deploy/install.sh <bind> <owner>` also installs it, but it also restarts orbit and rewrites unit files, so it is not needed for this.)
5. Check the host is healthy and idle: `systemctl is-active orbit`, `curl -fsS --max-time 5 http://$HOST:$PORT/status | jq .commit` (take `HOST` and `PORT` from `/opt/orbit/orbit.env`), no `/opt/orbit/state/rollback-failed-*.json`, and a chat message gets a reply.

## Record the known-good release

Write these down (a local note, not the repo). Do not skip it: manual recovery uses them.

```
KNOWN_TARGET="$(readlink -f /opt/orbit/current)"; echo "$KNOWN_TARGET"      # absolute path under /opt/orbit/releases/
KNOWN_COMMIT="$(cat "$KNOWN_TARGET/COMMIT")"; echo "$KNOWN_COMMIT"           # 40-hex; must equal the /status commit
```

## Stop timer overlap

```
sudo systemctl stop orbit-deploy.timer
systemctl is-active orbit-deploy.service     # "inactive"; if "activating", wait for it to finish
```

The lock already blocks overlap, but stopping the timer keeps a real deploy from landing in the middle of the drill.

## Run the drill

```
sudo systemd-run --unit=orbit-drill --wait --collect --pipe \
  --setenv=ORBIT_DRILL_CONFIRM="$KNOWN_COMMIT" \
  /usr/local/lib/orbit/pull-deploy.sh --drill
```

(If `systemd-run` is not available, run `sudo ORBIT_DRILL_CONFIRM="$KNOWN_COMMIT" /usr/local/lib/orbit/pull-deploy.sh --drill | tee ~/orbit-drill.log` inside `tmux`.)

### Expected log, success

```
drill: known-good <KNOWN_COMMIT> at /opt/orbit/releases/<KNOWN_COMMIT>
drill: failure injection: candidate /opt/orbit/drill/<id> must fail its smoke test (expects drill-<id>); only the candidate is affected
deploy: drill-<id> failed its smoke test
deploy: rolled back to <KNOWN_COMMIT> (verified serving)
drill: injected candidate failure observed; rollback verified, serving <KNOWN_COMMIT>
drill: PASSED (recovery verified; normal deploy state untouched)
```

### Exit codes

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | Injected failure observed, rollback verified | Verify and clean up below |
| 1 | Only from a normal deploy: candidate failed, rollback verified | Not a drill result |
| 2 | **Rollback failed** (`ROLLBACK FAILED:` in the log), or recovery unverified | Manual recovery now |
| 3 | The injection did not fail the candidate; known-good was restored and verified | Report as a bug in the drill |
| 64 | Refused (missing/wrong `ORBIT_DRILL_CONFIRM`, unhealthy start, unresolved failure file, bad usage) | Nothing was changed |
| 75 | Lock busy after the wait | Nothing was changed; find the other run |

## Verify after a pass

```
readlink -f /opt/orbit/current                       # equals $KNOWN_TARGET
curl -fsS --max-time 5 http://$HOST:$PORT/status | jq .commit     # equals $KNOWN_COMMIT
systemctl is-active orbit
cat /opt/orbit/state/drill/last.json                 # {"passed": {commit, at}}
test ! -e /opt/orbit/state/drill/in-progress.json
ls /opt/orbit/drill/                                 # empty after a pass
```

Also send a chat message and confirm a reply. Confirm `state/failed` and `state/deploy.json` did not change from before the drill.

## Manual recovery (exit 2, or anything looks wrong)

Use the `KNOWN_TARGET` you recorded, not a guessed path. From the independent SSH session:

```
ls -d "$KNOWN_TARGET" && cat "$KNOWN_TARGET/COMMIT"       # still there, and the commit you recorded
sudo ln -sfn "$KNOWN_TARGET" /opt/orbit/current.new && sudo mv -T /opt/orbit/current.new /opt/orbit/current
sudo systemctl restart orbit
sleep 5; curl -fsS --max-time 5 http://$HOST:$PORT/status | jq .commit      # must equal $KNOWN_COMMIT
sudo journalctl -u orbit -n 50 --no-pager                  # if it does not
```

Never delete or rebuild `$KNOWN_TARGET`, and never remove `releases/` entries by hand until this is resolved. Keep `/opt/orbit/state/rollback-failed-*.json` and the candidate in `/opt/orbit/drill/` for inspection (they hold paths and commits only, no secrets). Once `/status` serves `$KNOWN_COMMIT` and chat works, record the cause, then clear the block:

```
sudo mkdir -p /opt/orbit/state/recovered && sudo mv /opt/orbit/state/rollback-failed-*.json /opt/orbit/state/recovered/
sudo rm -f /opt/orbit/state/drill/in-progress.json
```

(If you skip clearing `in-progress.json`, the next normal run just redoes and verifies the restore, which is harmless. Further drills stay refused until the failure files are moved.) Only after `current` is not the candidate may you `rm -rf /opt/orbit/drill/<id>`.

## Clean up and restore normal scheduling (success or failure)

Do this once orbit is verified healthy on `$KNOWN_COMMIT`, whatever the drill result:

```
sudo systemctl start orbit-deploy.timer
systemctl list-timers orbit-deploy.timer --no-pager      # next run scheduled
systemctl is-enabled orbit-deploy.timer                  # enabled
```

Confirm normal deploys resume: `sudo systemctl start orbit-deploy.service`, then `journalctl -u orbit-deploy.service -n 20 --no-pager`. Expect no output, or `deploy: <sha> is live` if main moved. A drill never marks a commit failed, so nothing is suppressed. Check `state/failed` is unchanged.

## Limitations

- The injected failure is a candidate smoke failure. Candidate restart failure and rollback failures are covered by the automated tests (`test/pull-deploy.test.ts`) with mocked `systemctl`, `curl` and GitHub, not by the production drill.
- The drill briefly restarts the real service twice; a drill cannot be outage-free.
- It proves the rollback path and the host script, not that a future broken release will be caught by the real smoke test (only `/status` commit equality is checked).
- Rollback verification trusts `/status` `.commit`. A release whose `COMMIT` file is missing cannot be verified and is reported as a rollback failure.
- The lock is advisory (`flock` on `state/deploy.lock`). The old installed script does not take it, which is why the script must be updated first and the timer stopped.
- If the host has no previous release, a failed deploy still stops orbit, as before. The drill refuses to run without a known-good release.
