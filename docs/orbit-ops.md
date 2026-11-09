# orbit-ops: read-only server operations (tier 1)

A small root helper lets ORBIT answer questions about its own server without ORBIT itself having any privilege. It is read-only, has seven fixed actions, and is **not** installed by a normal deploy: someone has to run the installer on the host once.

## What it can do

One chat tool per action, owner only (`decide("agent", tool)`), no per-read confirmation, results shown with the usual provenance (`live`, source `ops/<action>`):

| Chat tool | Action | Returns |
|---|---|---|
| `ops_orbit_status` | `orbit_status` | systemd state/substate/result/restarts of `orbit.service`, and the commit it serves |
| `ops_orbit_logs {lines?}` | `orbit_logs` | last N log lines (default 50, **max 100**, each cut to 200 chars, at most ~7000 chars total, redacted) |
| `ops_deploy_state` | `deploy_state` | deployed commit, last deployed/failed commit and time, up to 10 releases, count of unresolved rollback-failure files, deploy timer state |
| `ops_host_health` | `host_health` | disk (`/` and `/opt/orbit`), memory, load, uptime, pending updates **from the existing update-notifier cache** (never refreshed, nothing installed), restart-required flag |
| `ops_tailscale_status` | `tailscale_status` | state of the host's tailscaled and of the `orbit-jobs` node, with the **local** Funnel configuration |
| `ops_vault_sync` | `vault_sync` | commit and age of the server's vault copy |
| `ops_credentials` | `credentials` | file names, sizes and modified dates under `/etc/credstore` only |

Limits worth knowing:

- **Funnel.** The helper reads the local tailscaled's serve configuration. `funnel.enabledLocally: true` means the local config asks for Funnel; it does **not** prove `orbit-jobs` is reachable from the internet. The answer always says remote reachability was not checked.
- **Credentials.** Metadata only, from fixed directories, via `lstat`/`readdir`. Contents are never opened, not even to redact them. Symlinks are listed as symlinks and not followed; names outside `[A-Za-z0-9._-]{1,64}` are counted, not listed; a directory that is a symlink, not root-owned, or group/world-writable is refused.
- **Pending updates** report "unavailable" when the update-notifier cache does not exist on the host.
- Anything the helper cannot read is reported as unavailable with a reason, never guessed. If the helper is not installed, the tool says so.

## How it is protected

- **Who can connect** is decided by the kernel: `/run/orbit-ops.sock` is `root:orbit-ops`, mode `0660`. The ORBIT service is a `DynamicUser`, so it joins the static system group `orbit-ops` with `SupplementaryGroups=` (as it already does for `orbit-vault`). Nothing else should be in that group. This is file-permission authorization, not an obscure path.
- **Fixed actions only.** The request is one JSON line, at most 256 bytes: `{"action": "<one of seven>"}` or `{"action":"orbit_logs","lines":N}`. Unknown actions, any other key, non-integers and out-of-range `lines` are refused before anything runs. The commands that run are fixed absolute paths (`/usr/bin/systemctl show`, `/usr/bin/journalctl`) with `shell: false`; the only caller-influenced value is the validated integer. No path, unit name or command comes from the caller.
- **Bounds.** Response at most 32 KiB; subprocess 5 s and 256 KiB; per-connection `RuntimeMaxSec=20`, `MemoryMax=192M`, `TasksMax=32`, at most 8 concurrent connections.
- **Sandbox** (`deploy/systemd/orbit-ops@.service`): root, but `ProtectSystem=strict` with nothing writable, `PrivateNetwork`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, capabilities limited to `CAP_DAC_READ_SEARCH`, `AF_UNIX` only, syscall filter `@system-service`, no environment and no credentials.
- **Redaction** of tokens, bearer/basic credentials, JWTs, PEM keys, `key=value` secrets, URL userinfo and long opaque strings, applied before a response is sent, before the audit line is written, and again in ORBIT. Free-form text is only returned for log lines; everything else is structured and validated.
- **Audit:** one line per request on the helper's stderr (the journal, `orbit-ops@*.service`): time, action, validated `lines`, outcome, error code, a short redacted message, bytes and milliseconds. Never the raw request and never the response data.
- **The root code does not come from deploys.** The installer copies `helper.ts` and `protocol.ts` to `/usr/local/lib/orbit/ops/` (root-owned, not writable by others). A normal app deploy never changes what runs as root; re-run the installer to update it.

## Install on the host (needs root; not done by any runner)

The release directories contain the full repository tree, so after the change is merged and the normal deploy is live, run the installer from the live release. It takes the same arguments as before; read them from the existing environment file instead of retyping:

```bash
sudo test -f /opt/orbit/current/deploy/systemd/orbit-ops.socket && echo "release contains orbit-ops"   # must print this
HOST="$(sudo sed -n 's/^HOST=//p' /opt/orbit/orbit.env)"
OWNER="$(sudo sed -n 's/^ORBIT_OWNER=//p' /opt/orbit/orbit.env)"
sudo /opt/orbit/current/deploy/install.sh "$HOST" "$OWNER"
```

`install.sh <bind-address> <owner-tailscale-login> [vault-source]` is idempotent: it keeps the existing vault copy and unmanaged `orbit.env` settings. For this change it additionally creates the `orbit-ops` group, installs the helper into `/usr/local/lib/orbit/ops/`, installs `orbit-ops.socket` and `orbit-ops@.service`, enables and starts the socket, and (as it always does) reinstalls the unit files, runs a deploy check and **restarts `orbit.service`**, which is required for ORBIT to pick up the new group. Expect a short ORBIT restart. It does not touch credentials or OpenClaw.

## Verify

```bash
getent group orbit-ops                                   # exists, no members listed (the service gets it via systemd)
ls -l /run/orbit-ops.sock                                # srw-rw---- root orbit-ops
systemctl is-active orbit-ops.socket                     # active
systemctl show orbit.service -p SupplementaryGroups      # contains orbit-vault and orbit-ops
sudo ls -l /usr/local/lib/orbit/ops/                     # helper.ts, protocol.ts, root-owned
systemd-analyze security orbit-ops@.service              # review the exposure score
# A request from root, then from an unprivileged user (must be refused by the kernel):
printf '{"action":"vault_sync"}\n' | sudo socat - UNIX-CONNECT:/run/orbit-ops.sock
printf '{"action":"vault_sync"}\n' | socat - UNIX-CONNECT:/run/orbit-ops.sock            # as a normal user: Permission denied
printf '{"action":"orbit_logs","lines":1000}\n' | sudo socat - UNIX-CONNECT:/run/orbit-ops.sock   # {"ok":false,...bad_arguments}
sudo journalctl -u 'orbit-ops@*' -n 10 --no-pager        # one audit line per request, no secrets
```

Then ask ORBIT in chat (as the owner) for the server status; the reply should list `ops_orbit_status` with provenance `live` and source `ops/orbit_status`. A non-owner gets no tools. If a tool says the helper "is not available" the socket is missing; "refused access" means `orbit.service` has not been restarted since it joined `orbit-ops`.

## Known limitations

- Written and tested against fakes and real temp directories; the units have not been exercised on a live host by the runner. The first install should be watched with `journalctl -u 'orbit-ops@*' -f`. If the syscall filter or capability set blocks something on your distribution, the helper answers `unavailable` or `internal_error` for that action rather than failing open; loosen `SystemCallFilter=`/`CapabilityBoundingSet=` only as needed.
- Pending-update data needs `/var/lib/update-notifier/updates-available` (Ubuntu). Elsewhere it is reported unavailable.
- Requires `/usr/local/bin/node` (the same node the ORBIT unit uses; Node 22.18+ runs the `.ts` helper directly).
- Tier 2 (owner-confirmed restart, deploy-now, rollback, `orbit.env` changes, vault refresh) is a separate helper: see `docs/orbit-ops-admin.md`. Tier 3 and scheduling are not implemented.
