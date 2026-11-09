# orbit-ops-admin: owner-confirmed server operations (tier 2)

Tier 1 (`docs/orbit-ops.md`) answers questions. Tier 2 lets ORBIT **change** a small, fixed set of its own things, but only after the owner clicks Confirm, and only through a separate privileged helper. It is not installed by a normal deploy: a person runs the installer as root (below). Tier 1 is unchanged: `orbit-ops@.service` (including `ProtectSystem=strict`, nothing writable, `PrivateNetwork=yes`), its socket, helper and `orbit.service` are byte-identical (a test pins their hashes).

## The five actions

| Chat tool (proposes only) | Helper action | What the helper does | Counted as done only when |
|---|---|---|---|
| `ops_propose_restart_orbit` | `restart_orbit` | `systemctl restart orbit.service` from a separate runner unit that outlives the restart | within 60 s `/status` answers 200 **and serves the same commit** that `/opt/orbit/current/COMMIT` named before |
| `ops_propose_deploy_now` | `deploy_now` | `systemctl start orbit-deploy.service` (the unit the deploy timer starts; it runs the installed `pull-deploy.sh`) | a new release is deployed **and** `/status` serves its commit. No new release is `no_change`, a failed deploy is `failed` |
| `ops_propose_rollback` | `rollback_release` | `/usr/local/lib/orbit/pull-deploy.sh --rollback`: the deploy script's own switch/restart/verify/restore flow, targeting the previous known-good release | `current/COMMIT` really changed **and** `/status` serves it |
| `ops_propose_config_change` | `apply_config` | edits `orbit.env`, restarts, verifies, restores the backup if unhealthy | `/status` healthy on the same commit within 60 s (and, for `ORBIT_INGRESS_PORT`, the job listener answers on the new port) |
| `ops_propose_refresh_vault` | `refresh_vault` | `pull-deploy.sh --refresh-vault`: fast-forward pull of `/opt/orbit/vault`, writes `state/vault.json` | `state/vault.json` was written during the run with a valid commit |

`ops_admin_operations` lists confirmed operations with what the helper observed. Everything else (arbitrary commands, other units, other `orbit.env` keys, credentials, OpenClaw) has no action and cannot be requested here. Reboots, OS updates and the orbit-jobs Funnel are **tier 3** (`docs/orbit-ops-sys.md`): a separate, separately installed helper that is not part of tier 2.

### Rollback target

The deploy script now keeps `state/history.jsonl` (successful deploys, newest 50; `install-admin.sh` seeds it with the running release, and the first deploy after install seeds it with the release it replaces). "Previous" is the newest earlier entry whose release directory still exists with a matching `COMMIT` and `release.env`, and which was not itself rolled back from (`state/rejected`). After a verified rollback the commit rolled back from is written to `state/failed` (the existing mechanism that stops the timer redeploying a bad commit) and to `state/rejected`; a newer commit on `main` deploys as normal. It refuses (exit 64, nothing changed) when there is no history, no usable earlier release, an unresolved `rollback-failed-*.json`, or an unfinished drill. If the target fails its health check, the running release is restored and verified (exit 1); if even that fails the failure is recorded for an operator (exit 2).

### `ORBIT_MODEL`, `ORBIT_ROUTINES`, `ORBIT_ROUTINE_REPOS`, `ORBIT_PUBLIC_JOB_URL`, `ORBIT_INGRESS_PORT`

Validated against the formats the code actually reads (`src/ops/admin-protocol.ts`, checked in ORBIT before a proposal exists and again in the helper and in the runner): unknown keys are refused; a value must be non-empty printable ASCII without spaces or any of `" ' $ \` ; & | # \ < >`, so it cannot carry a second line, a command or a second setting.

- `ORBIT_MODEL`: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`.
- `ORBIT_ROUTINES`: `name=trig_<id>` pairs, at most 8, unique names (`src/launcher.ts` reads exactly this shape).
- `ORBIT_ROUTINE_REPOS`: `name=owner/repo` pairs, at most 8, unique names (`parseRoutineRepos`).
- `ORBIT_PUBLIC_JOB_URL`: `https://<name>.ts.net` only: no port, path, query, fragment or credentials (what `install.sh` writes from the Tailscale DNS name).
- `ORBIT_INGRESS_PORT`: integer 1024 to 65535, and the runner also refuses a port equal to `PORT`.

**What the change does.** The runner reads `orbit.env`, refuses unless it is a plain root-owned file with the same group as the runner and under 64 KiB, and refuses (changing nothing) if a target key appears twice, indented, exported, spaced or on a continued line, or if the file contains NUL or CR. It saves the old bytes as `/opt/orbit/state/env-backup-<12 hex>.env` (mode 0600, newest 5 kept), writes the new file next to it and renames it over `orbit.env` keeping the mode, reads it back, restarts `orbit.service`, and polls `/status` (and, for a port change, `http://127.0.0.1:<port>/v1/jobs/healthcheck/steers`, which must answer 401 from the job listener) for up to 60 s. If that fails it writes the old bytes back, restarts again and verifies again. The outcome is `verified`, `restored` (new settings unhealthy; old ones restored and verified), or `restore_failed` (ORBIT may be down; the summary names the backup file). A change that is already in effect is `no_change` and does not restart.

**Limits worth knowing.** Changing `ORBIT_INGRESS_PORT` or `ORBIT_PUBLIC_JOB_URL` does not touch Tailscale Funnel (out of scope). The Funnel still points at whatever port it was set to, so after changing the port the public job path stays broken until Funnel is repointed by hand; the result says only that the local listener answered. Setting a routine in `ORBIT_ROUTINES` whose `orbit.routine.<name>` credential is not installed is accepted but ignored by ORBIT (as it always was); `/status` stays healthy, so this is not caught by verification.

### `orbit.env` and secrets (the conflict, and how it is resolved)

`orbit.env` is root's configuration file and may hold things that should not be read out: `ORBIT_ROUTINES` contains Routine trigger ids (not the Routine tokens, which are systemd credentials), and an operator may keep other values there. So:

- The helper never reads `/etc/credstore` or any credential, and no admin unit is given `ImportCredential=`, `LoadCredential=` or `EnvironmentFile=`.
- `orbit.env` is **opaque text**. Only the five target keys (and `HOST`/`PORT`, to find `/status`) are interpreted. Every other line is copied byte for byte into the new file and the backup and is never parsed, logged, audited or returned. A test puts a token-shaped line in `orbit.env` and asserts it is preserved in the file and appears in no record, audit line or answer.
- Old values of the target keys are never reported. New values are shown to the owner on the confirmation card, except trigger ids, which appear as `name=trig_…abcd` (names and last four characters) on the card, in the ledger, in audit lines and in results. The exact value stays only in the in-memory proposal, the request on the local socket, and the helper's root-only pending record, which is deleted when the operation ends.
- The backups carry the same bytes as the original file (root-only, 0600). That is inherent in a restorable backup; they are pruned to the newest five.
- **Residual exposure.** The model sees what the owner types in chat, so a trigger id pasted into chat is in the conversation and in the tool-call arguments shown by the UI. The owner could avoid that by editing `ORBIT_ROUTINES` by hand instead. `pull-deploy.sh` already sources `orbit.env` as shell, as before; the validation above is what keeps a changed value from becoming code there.

## Who can ask for what

1. **Proposal.** Chat tools are offered only to the owner (`isOwner && model.step`); `decide("agent", tool)` is owner-only; a non-owner has no tools at all. A tool call validates the action and settings, then creates an owner-only proposal (like `job_launch` / `job_steer`). Nothing is sent to the helper. The proposal records a summary, the masked settings and a SHA-256 **digest** of the exact validated action and arguments, and expires after **10 minutes**.
2. **Confirmation.** `POST /chat/proposals/<id>/confirm` is owner-only (the same Tailscale identity check as every owner route) and needs `{"digest": "<the digest on the card>"}`. A missing or different digest changes nothing and leaves the proposal open. The proposal is then spent (one shot); ORBIT re-checks the stored arguments against the digest, refuses a proposal id it already has in the ledger, and derives the operation id from the proposal id.
3. **Helper.** The kernel (group `orbit-ops`, socket mode 0660) decides who can connect, exactly as in tier 1. The helper also refuses a repeated operation id (it returns the existing record and never runs again), so even a replay that got past ORBIT would not execute twice.
4. **Serialisation.** One operation at a time: an exclusive slot file in the helper's state directory (a second request gets `busy`), and `restart_orbit`/`apply_config` additionally hold the deploy lock (`state/deploy.lock`, the one the timer, drills, rollbacks and vault refreshes use) for their whole run. `deploy_now` and rollback take that lock inside the script.
5. **Persistence.** Each accepted operation is a root-only JSON record under `/var/lib/orbit-ops-admin/ops/`, written before the runner starts and updated at every step, so it survives a helper, runner or ORBIT restart. ORBIT's ledger (`STATE_DIRECTORY/ops-admin.json`) records confirmations and results; on restart (and every 30 s) ORBIT asks the helper for any operation not yet ended, records what it observed, and sends one notification when it ends. A runner that died is reported as `interrupted` (outcome unknown), never as success. Unconfirmed proposals are in memory only: an ORBIT restart cancels them, which fails safe.

"Accepted" and "running" are never reported as success. Chat replies and cards say a dispatch is **not verified**; a result appears only when the runner has itself probed `/status` (or, for the vault, read the written sync record).

## Privileges (what each unit may do)

| Unit | Runs | Writable | Network | Capabilities |
|---|---|---|---|---|
| `orbit-ops-admin.socket` | systemd | creates `/run/orbit-ops-admin.sock` `root:orbit-ops` 0660, `Accept=yes`, max 4 | n/a | n/a |
| `orbit-ops-admin@.service` (front, one per connection) | validates, records, starts a runner | **only** `/var/lib/orbit-ops-admin` (`StateDirectory`, 0700) | none (`PrivateNetwork`, `AF_UNIX`) | none (`CapabilityBoundingSet=` empty) |
| `orbit-ops-admin-run@<op>.service` (restart, deploy, rollback, config) | does the work, verifies | `/opt/orbit` (as a directory, because `orbit.env` and the `current` link are replaced by rename), with `repo` and `vault` read-only; its state directory | only to `localhost`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48` (to probe `/status` at `HOST:PORT`) | none |
| `orbit-ops-admin-vault@<op>.service` (vault refresh) | the vault refresh only | `/opt/orbit/vault`, `/opt/orbit/state`, its state directory | none | none; `ProtectHome=read-only` so the vault clone's origin (`/root/orbit-vault`) can be read |

All: `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp/Devices`, kernel/clock/cgroup protections, `RestrictNamespaces`, `SystemCallFilter=@system-service`, `UMask=0077`, memory/task limits. The only commands they run are fixed absolute paths with fixed arguments: `/usr/bin/systemctl start --no-block orbit-ops-admin-{run,vault}@<validated 40-hex id>.service`, `is-active` on that instance, `restart orbit.service`, `start orbit-deploy.service`, `/usr/local/lib/orbit/pull-deploy.sh --rollback|--refresh-vault`. A test asserts that every command either helper issues is one of these. The only caller values that reach the host are the validated 40-hex id and the five validated settings.

Real paths this was written against: `/opt/orbit/{orbit.env,current,releases/<sha>,state/,repo,vault}`, `/usr/local/lib/orbit/pull-deploy.sh`, `/usr/local/lib/orbit/ops/`, `/usr/local/bin/node`, `orbit.service`, `orbit-deploy.service`/`.timer`. **Why `/opt/orbit` is writable:** renaming a file over `orbit.env` or the `current` link needs the directory writable; a narrower mount would force in-place, non-atomic writes. If your `HOST` in `orbit.env` is a LAN address outside the allowed ranges, add it to `IPAddressAllow=` in `orbit-ops-admin-run@.service`.

## Audit

Every request leaves one line on the front's stderr (`journalctl -u 'orbit-ops-admin@*'`): time, action, first 12 characters of the operation id, outcome (`accepted`, `replayed`, `rejected`, `error`, `ok`), error code, a short redacted message, bytes, ms. Never the raw request. Every runner step and the final result leave a line on the runner's stderr (`journalctl -u 'orbit-ops-admin-run@*' -u 'orbit-ops-admin-vault@*'`), each at most 200 characters (300 for the result) and redacted by the same rules as tier 1 (tokens, bearer/basic, JWTs, PEM, `key=value` secrets, URL userinfo, long opaque strings). Responses are capped at 16 KiB; records keep at most 40 steps. ORBIT audits each confirm (`ops confirm:<action>`) with the proposal id and digest prefix.

## Install on the host (root; this job did not run any of it)

A normal deploy cannot install root services, so after this change is merged and the normal deploy is live, run on the server, as root:

```bash
sudo test -f /opt/orbit/current/deploy/install-admin.sh && echo "release contains tier 2"   # must print this
sudo /opt/orbit/current/deploy/install-admin.sh
```

`install-admin.sh` is idempotent and touches only tier 2: it creates group `orbit-ops` if missing (tier 1 already did), installs `pull-deploy.sh` (with the new `--rollback` and `--refresh-vault`; the timer uses this installed copy, so this step is what enables them) to `/usr/local/lib/orbit/pull-deploy.sh`, the five helper files to `/usr/local/lib/orbit/ops/` (root-owned, 0644), the four units to `/etc/systemd/system/`, seeds `state/history.jsonl` with the running release, then `daemon-reload`, enables and (re)starts `orbit-ops-admin.socket`. It does **not** restart `orbit.service` (it is already in `orbit-ops`), rewrite `orbit.env`, or touch credentials, Tailscale, Funnel or OpenClaw. `deploy/install.sh` calls it too. Until the next deploy after the merge, ORBIT itself has no admin tools wired to a live socket; the tools say the helper "is not available" if the socket is missing.

## Verify (python3; this host has no socat)

```bash
getent group orbit-ops                               # exists
ls -l /run/orbit-ops-admin.sock                      # srw-rw---- root orbit-ops
systemctl is-active orbit-ops-admin.socket           # active
sudo ls -l /usr/local/lib/orbit/ops/                 # admin-*.ts, helper.ts, protocol.ts, root-owned
sudo grep -c -- '--rollback' /usr/local/lib/orbit/pull-deploy.sh   # 1 or more
systemd-analyze security orbit-ops-admin@.service orbit-ops-admin-run@x.service orbit-ops-admin-vault@x.service   # review exposure

# Harmless requests, as root. None changes anything: an unknown id, a malformed request, an unknown action.
sudo python3 - <<'PY'
import json, socket
def call(req):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(15)
    s.connect("/run/orbit-ops-admin.sock"); s.sendall(json.dumps(req).encode() + b"\n")
    buf = b""
    while not buf.endswith(b"\n"):
        d = s.recv(65536)
        if not d: break
        buf += d
    return buf.decode().strip()
print(call({"action": "op_status", "opId": "0" * 40}))                    # {"ok":false,...,"code":"not_found"}
print(call({"action": "restart_orbit", "opId": "0" * 40, "unit": "x"}))   # bad_arguments (extra key)
print(call({"action": "reboot", "opId": "0" * 40}))                       # unknown_action
print(call({"action": "apply_config", "opId": "0" * 40, "changes": {"HOST": "0.0.0.0"}}))   # bad_arguments (not a permitted key)
PY

# The kernel must refuse an unprivileged user (expect PermissionError):
sudo -u nobody python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("/run/orbit-ops-admin.sock")'

sudo journalctl -u 'orbit-ops-admin@*' -n 10 --no-pager   # one audit line per request, no raw requests, no secrets
```

## Manual acceptance checks (not done by the runner; do these at a quiet time, with a second SSH session open)

1. Ask ORBIT in chat as the owner for `ops_propose_refresh_vault`. Expect a card ("Nothing has been done yet"), then Confirm; the card says dispatched, **not verified**; then ORBIT's notification "verified … Vault copy refreshed" and `ops_admin_operations` shows `verified`. Check `cat /opt/orbit/state/vault.json`.
2. `ops_propose_restart_orbit`, Confirm. ORBIT drops for a few seconds; after it returns, the notification should say `/status is healthy and serves the same commit <sha>`; compare with `curl -s http://$HOST:$PORT/status`.
3. `ops_propose_config_change` with a harmless value (for example the current `ORBIT_MODEL`'s neighbour you can verify, or re-send the same value to see `no_change`). Check the `env-backup-*.env` file appears with mode 0600 and the other lines of `orbit.env` are unchanged (`diff` against the backup).
4. **Failure/restore path:** deliberately breaking the server to see a restore is not recommended. The restore, `restored` and `restore_failed` paths are exercised by the fake-host tests only; on the host, confirm that the backup file from step 3 matches the pre-change `orbit.env` byte for byte (`cmp`) so a restore would have something correct to put back.
5. `ops_propose_deploy_now` while `main` is unchanged: expect `no_change`, not success. After a real merge: expect `verified` with the new commit.
6. Rollback: after at least two deploys, `ops_propose_rollback`; confirm; expect `verified` with the earlier commit, `state/failed` naming the commit rolled back from, and the timer not redeploying it. A new commit on `main` should then deploy normally.
7. Try to confirm from a different Tailscale identity or without the digest (curl): expect 403 / 409.

## Known limitations

- Written and tested against fakes and real temp directories (including the real `pull-deploy.sh` with mocked `systemctl`/`curl`). The units, the sandboxing (notably the empty capability set, `IPAddressAllow`, `ProtectHome=read-only` for the vault unit) and `systemctl` from inside a sandbox have **not** been exercised on a live host. Watch the first runs with `journalctl -fu 'orbit-ops-admin@*' -u 'orbit-ops-admin-run@*'`; loosen a directive only as needed.
- The 60-second window is for `/status` after the restart; the deploy and rollback paths use the script's own bounded health check (about 105 s worst case) and then a further 60 s check by the runner.
- A runner killed hard mid-change is reported as `interrupted` (outcome unknown). If it died between writing the new `orbit.env` and verifying, the file may be the new one while ORBIT is running the old process; the backup `env-backup-<id>.env` is the way back.
- Ledger and helper records keep the newest 50 operations; the history file the newest 50 deploys.
- Funnel/Tailscale are never touched, so port or URL changes can leave the public job endpoint out of step until changed by hand.
