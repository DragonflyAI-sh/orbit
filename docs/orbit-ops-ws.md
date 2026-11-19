# orbit-ops-ws: owner-confirmed host setup for workspace tools

ORBIT's workspace tools (`docs/workspace-tools.md`) need things on the host that ORBIT cannot create for itself: the bubblewrap
package, a stable uid, dedicated `nosuid,nodev` filesystems owned by that uid, a workspaces file, and a delegated cgroup. `orbit-ops-ws`
is a **separately installed** privileged helper that sets up exactly that, from a **fixed plan**, after the owner confirms the plan on a
card. It follows the tier 2 and tier 3 architecture (restricted socket, fixed actions, durable records, separate runner units, a
confirmation bound to a key) with its own socket, state directory, units and installer, so installing, removing or breaking it never
changes tiers 1-3, `orbit.service`'s unit file or the deploy.

## What has and has not happened

- Written and tested against fakes and real temporary directories only. **Nothing was run on a live host**: no package was installed,
  no user created, no image formatted, nothing mounted, no unit installed or started, and ORBIT was not restarted.
- It is **not installed** by any deploy or by `install.sh`, `install-admin.sh` or `install-sys.sh`. A person installs it as root with
  `deploy/install-ws.sh --approved-by-owner` after Rai has approved that separately.
- The ORBIT-side tools and cards that call it, and ORBIT's own owner-controlled switch for workspace tools, are being built separately.
  This document describes the helper and the client (`src/ops-ws-client.ts`) only.

## Actions

| Action | Arguments | What the helper does |
|---|---|---|
| `ws_status` | none | Inspects the host **read-only** and answers with facts, the plan (every step with its state and the exact action it would take), the 24-hex `planKey`, host-wide blockers, and whether an operation is open. Runs only queries (`systemctl show/--version/is-enabled`, `getent`). |
| `ws_setup` | `opId`, `planKey` | Recomputes the plan; refuses with `plan_changed` if its key differs from `planKey`, and with `plan_blocked` if any step is blocked. Otherwise records the operation and starts `orbit-ops-ws-run@<opId>.service`. With nothing to do it records `no_change` and starts nothing. |
| `ws_revoke` | `opId` | Records and starts the runner, which rewrites the drop-in **without** its `Environment=` line, reloads systemd, restarts ORBIT and verifies. |
| `op_status` | `opId` | The operation's public record. |

Requests are strict JSON (at most 4096 bytes; answers at most 16 KiB): exactly the keys above, `opId` = 40 lowercase hex, `planKey` = 24
lowercase hex, unknown actions and extra keys refused. `opIdFor(proposalId)` = first 40 hex of `sha256("orbit-ops-ws:" + proposalId)`.
Nothing in a request becomes a command, path, unit, size or file content.

## The plan

Fixed in `src/ops/ws-core.ts`. Workspaces: `scratch` (1 GiB, exec) and `orbit-validation` (64 MiB, exec; used only by ORBIT's
synthetic smoke validation). Each step is `{id, title, state: done|todo|blocked, action, detail}`; `action` is the exact command(s) and
file writes, shown verbatim on the owner's card (a test checks that redaction does not alter a character of it).

| Step | Done when | To do (exact) | Blocked when |
|---|---|---|---|
| `package_bubblewrap` | `/usr/bin/bwrap` is root-owned, not group/other-writable, not setuid/setgid, and `/usr/bin/prlimit` exists likewise | `DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends bubblewrap`, run in the separate package unit. A busy lock fails with nothing changed; nothing is killed or unlocked | `bwrap` is setuid/setgid or otherwise odd; `prlimit` missing (util-linux is never installed or changed here) |
| `identity` | `getent passwd orbit`: uid < 1000, shell nologin/false; `getent group orbit`: a system group | `/usr/sbin/useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin orbit` (`--gid orbit` instead of `--user-group` if a system group `orbit` already exists) | a non-system or login-shell `orbit` user, a user without the group, a non-system group |
| `storage_scratch`, `storage_orbit-validation` | mounted (per `/proc/self/mountinfo`) ext4 with `nosuid,nodev`, unit enabled, root owned by `orbit`, mode 0700, no `lost+found` | as needed: create `/var/lib/orbit-workspaces` (root 0700); create the image **exclusively** (0600), `fallocate -l <bytes>`, `mkfs.ext4 -q -F -L orbit-ws-<id>` **only on that new image**; write `/etc/systemd/system/srv-orbit\x2dworkspaces-<escaped id>.mount` (`What=<image>`, `Where=/srv/orbit-workspaces/<id>`, `Type=ext4`, `Options=loop,nosuid,nodev,noatime`, `Before=orbit.service`, `WantedBy=multi-user.target`), `systemctl daemon-reload`, `systemctl enable --now <unit>`; then `rmdir lost+found` if present (rmdir only removes an empty directory), `chown -h orbit:orbit`, `chmod 0700` on the mount root | an existing image without a recognised ext4 superblock (never formatted); a mount unit with other content; something else mounted there; a non-empty `lost+found` |
| `workspaces_file` | `/etc/orbit/workspaces.json` byte-identical to the fixed content, root:orbit 0640. **A different existing file is operator-managed: shown as `done`, "exists and differs; kept unchanged (operator-managed)", never overwritten** | create `/etc/orbit` (root 0755) and the file (root:orbit 0640, link-based, so it fails rather than replaces) with the fixed content; `cgroupParent` is `/sys/fs/cgroup` + `systemctl show orbit.service -p ControlGroup` + `/workspace-exec` | ORBIT's control group cannot be read (ORBIT not running) and the file is absent |
| `service_dropin` | `/etc/systemd/system/orbit.service.d/60-orbit-workspace.conf` byte-identical (below) | write it (root 0644); also when it is in the revoked form | the file has content this helper did not write (never replaced) |
| `apply` | none of the steps above was to do, no reload pending, the drop-in loaded, ORBIT started after the drop-in was written, ORBIT's main process owned by the static `orbit` uid | `systemctl daemon-reload`; `systemctl restart orbit.service` (**ORBIT is offline for a few seconds**); wait up to 60 s for `/status` to answer 200 with the commit `/opt/orbit/current/COMMIT` named before | never |

The drop-in:

```
# Managed by orbit-ops-ws (docs/orbit-ops-ws.md). Workspace tools stay OFF until the owner enables them in ORBIT.
[Service]
Delegate=memory pids cpu
DelegateSubgroup=main
ReadWritePaths=-/srv/orbit-workspaces/scratch -/srv/orbit-workspaces/orbit-validation
Environment=ORBIT_WORKSPACE_TOOLS=enabled ORBIT_WORKSPACES_FILE=/etc/orbit/workspaces.json
```

`ORBIT_WORKSPACE_TOOLS=enabled` here means **the host permits** workspace tools. ORBIT keeps them off until the owner separately enables
them in ORBIT (that switch is ORBIT's, built separately). The workspaces file's `preActivationChecklist` is
`workspace-tools-host-setup-v2`; ORBIT's loader currently expects `workspace-tools-preactivation-v1` (`src/workspace/config.ts`), so
until ORBIT is updated to accept the new value, this file alone does not activate anything.

**Shared-service impact of `identity`.** `orbit.service` has `DynamicUser=yes` and no `User=`, so systemd names the dynamic user after
the unit: `orbit`. Per systemd.exec(5), "If a statically allocated user or group of the configured name already exists, it is used and
no dynamic user/group is allocated." From ORBIT's next restart it therefore runs as the static, stable uid (which the workspace roots
are owned by), and at that start systemd re-owns ORBIT's state directory (`/var/lib/private/orbit`) recursively. While ORBIT still runs
as the dynamic user, nss-systemd reports that user under the same name; `getent` and `useradd` are run with
`SYSTEMD_NSS_DYNAMIC_BYPASS=1` (systemd's documented switch) so they see only static accounts. **Not verified live:** that `useradd`
honours the bypass on the target host; if it reports "user 'orbit' already exists" the step fails with nothing after it run.

**Plan key.** `planKey` = first 24 hex of `sha256(JSON.stringify([{id, action}, ...]))` over the steps that are `todo`, in order. Any
change to what would be done (a step becoming done, a different command, a different file content, a different control group) changes
the key. Details and done steps are not part of it.

**Blockers** (host-wide; never changed by this helper; reported by `ws_status` and repeated in every result):
`cgroup_v2` (`/sys/fs/cgroup` not cgroup2), `cgroup_controllers` (`cgroup.controllers` lacks memory, pids or cpu; a host-wide change
with a reboot), `systemd_version` (< 254: no `DelegateSubgroup=`), `apparmor_userns` (`/proc/sys/kernel/apparmor_restrict_unprivileged_userns`
= 1: bubblewrap needs an AppArmor profile that allows it to create user namespaces; on Ubuntu the operator may choose to rely on or
adjust the distribution's `bwrap-userns-restrict` profile under `/etc/apparmor.d`, a host-wide security policy decision this document
does not make and does not assume is present), `user_namespaces` (`/proc/sys/user/max_user_namespaces` = 0), `unprivileged_userns_clone`
(`/proc/sys/kernel/unprivileged_userns_clone` = 0). **Decision:** blockers do **not** stop `ws_setup`. The setup is harmless and
idempotent without them; the result says which blockers remain and that sandboxed exec stays unavailable until an operator resolves them.
A *blocked step* is different: it **does** stop `ws_setup` (`plan_blocked`), because later steps depend on earlier ones.

## Execution and verification

The runner (`orbit-ops-ws-run@<opId>.service`, `src/ops/ws-run.ts`) runs only a record in `accepted`, holds the deploy lock
(`/opt/orbit/state/deploy.lock`, like tier 2's restart), recomputes the plan, and refuses with nothing changed (`failed`, code
`plan_changed` or `plan_blocked`) if it differs. It executes the to-do steps in order with bounded timeouts, recording every operation,
and **stops at the first failure**: no rollback, nothing deleted (images, workspace data, packages, the user and files are never
removed); a new image whose formatting failed is left in place and named in the summary (the next plan then shows that workspace as
blocked). `mkfs.ext4` refuses to run on any image the operation did not create itself a moment earlier.

Outcome: `verified` only when, afterwards, the recomputed plan shows **every step done** and `/status` (HOST/PORT from
`/opt/orbit/orbit.env`) answers 200 with the commit read from `/opt/orbit/current/COMMIT` before the restart, within 60 s. `no_change`
when nothing was to do. `failed` names the step (`failedStep`) and why. A runner that vanished is `interrupted` (outcome unknown), never
success. One operation at a time (exclusive slot file, as tier 2); a repeated `opId` returns the existing record and never runs again.

`ws_revoke` never deletes images, mounts, the user, the workspaces file or packages. It is `no_change` when the drop-in is absent or
already revoked (and loaded); it refuses an operator-written drop-in.

Record (`/var/lib/orbit-ops-ws/ops/<opId>.json`, root 0600): `opId`, `action`, `state` (`accepted`, `running`, `verified`, `no_change`,
`failed`, `interrupted`), `acceptedAt`, `updatedAt`, `startedAt`, `finishedAt`, `planKey`, `todo` (step ids), `blockers` (ids),
`pkgResult`, `steps` (at most 64, each `{at, step, detail}` redacted and capped), `failedStep`, `code`, `verification` (`checked`,
`healthy`, `planComplete`, `expectedCommit`, `servedCommit`, `detail`), `summary`. Answers show the last 16 steps.

## Who can ask for what (authorization chain)

1. **Proposal.** ORBIT asks `ws_status` and shows the owner a card with every to-do step's exact action, the blockers, the
   shared-service impact (`identity`, `apply`) and the `planKey`.
2. **Confirmation.** The owner confirms that card in ORBIT; ORBIT derives the operation id from the proposal id and sends `ws_setup`
   with the plan key.
3. **Helper.** The kernel decides who can connect (`/run/orbit-ops-ws.sock`, `root:orbit-ops` 0660). The helper recomputes the plan and
   compares keys, refuses blocked plans, refuses repeated ids, serialises operations, and the runner compares the key again.
4. **What the plan key is, and is not.** The plan key binds the *request* to what the card showed: if the host would be changed in any
   other way, the key no longer matches and nothing happens. It does **not** prove the owner clicked: it is a hash of what `ws_status`
   tells any caller. **Membership of the `orbit-ops` group is the trust boundary**, exactly as in tiers 2 and 3:
   the helper cannot know the owner clicked. A compromised ORBIT process can request this fixed setup or a revoke, nothing else.

## Privileges

| Unit | Runs | Writable | Network | Capabilities |
|---|---|---|---|---|
| `orbit-ops-ws.socket` | systemd | creates `/run/orbit-ops-ws.sock` `root:orbit-ops` 0660, `Accept=yes`, max 4 | n/a | n/a |
| `orbit-ops-ws@.service` (front) | inspects read-only, validates, records, starts a runner | **only** `/var/lib/orbit-ops-ws` (`ProtectSystem=strict`) | none (`PrivateNetwork`, `AF_UNIX`) | `CAP_DAC_READ_SEARCH` only (read-only: to see inside the 0700 workspace roots so its plan matches the runner's) |
| `orbit-ops-ws-run@<op>.service` (runner) | the fixed steps, restart, verification | `ProtectSystem=yes`: `/etc`, `/var`, `/srv` writable (useradd, unit files, `/etc/orbit`, images, roots); `/usr`, `/boot` read-only; `/opt/orbit` read-only except `state/` (deploy lock) | only `localhost`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48` (to probe `/status`) | `CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_AUDIT_WRITE`; no `CAP_SYS_ADMIN` (systemd, not the runner, mounts) |
| `orbit-ops-ws-pkg@<op>.service` (package) | `apt-get install bubblewrap` once, only when the runner asked a moment ago | whatever dpkg needs (no `ProtectSystem`, like tier 3's update unit) | **yes**: apt must reach the mirrors. It is the only unit with general network, so the runner, which writes `/etc` and restarts ORBIT, has none beyond localhost and the tailnet | default root; `SendSIGKILL=no` |

Every command is a fixed absolute path with fixed arguments (`/usr/bin/systemctl`, `/usr/bin/getent`, `/usr/sbin/useradd`,
`/usr/bin/apt-get`, `/usr/bin/fallocate`, `/usr/sbin/mkfs.ext4`, `/usr/bin/chown`, `/usr/bin/chmod`, `/usr/bin/rmdir`); the only variable
token is the validated 40-hex id inside a unit instance name. A test asserts that every command any of the three programs issues is on
that list. Every step detail, summary, audit line and answer is redacted by the tier 1 rules and capped.

## Install (root; Rai's separate approval first)

```bash
sudo test -f /opt/orbit/current/deploy/install-ws.sh && echo "release contains orbit-ops-ws"   # must print this
sudo /opt/orbit/current/deploy/install-ws.sh --approved-by-owner
```

Idempotent. It refuses without `--approved-by-owner`, checks the binaries above, `/srv` and `/opt/orbit/state`, refuses if the installed
`/usr/local/lib/orbit/ops/protocol.ts` differs from this release's (installing would change tier 1), installs `ws-protocol.ts`,
`ws-core.ts`, `ws-helper.ts`, `ws-run.ts` (and `protocol.ts` only if absent) into `/usr/local/lib/orbit/ops/` root 0644, the four units
into `/etc/systemd/system`, runs `daemon-reload`, enables and restarts `orbit-ops-ws.socket`. It does **not** run the setup, restart
`orbit.service`, or create users, images, mounts or drop-ins.

## Verify (python3)

```bash
ls -l /run/orbit-ops-ws.sock                     # srw-rw---- root orbit-ops
systemctl is-active orbit-ops-ws.socket          # active
sudo ls -l /usr/local/lib/orbit/ops/ | grep ws-  # four files, root-owned
systemd-analyze security orbit-ops-ws@.service orbit-ops-ws-run@x.service orbit-ops-ws-pkg@x.service

sudo python3 - <<'PY'
import json, socket
def call(req):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(30)
    s.connect("/run/orbit-ops-ws.sock"); s.sendall(json.dumps(req).encode() + b"\n")
    buf = b""
    while not buf.endswith(b"\n"):
        d = s.recv(65536)
        if not d: break
        buf += d
    return json.loads(buf.decode())
st = call({"action": "ws_status"})                                      # read-only
print(json.dumps(st["data"]["plan"]["steps"], indent=1)); print(st["data"]["blockers"], st["data"]["plan"]["planKey"])
print(call({"action": "op_status", "opId": "0" * 40}))                    # not_found
print(call({"action": "ws_setup", "opId": "0" * 40, "planKey": "0" * 24}))  # plan_changed (nothing recorded)
print(call({"action": "ws_setup", "opId": "0" * 40}))                      # bad_arguments
print(call({"action": "mkfs", "opId": "0" * 40}))                          # unknown_action
PY
sudo -u nobody python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("/run/orbit-ops-ws.sock")'   # PermissionError
sudo ls /var/lib/orbit-ops-ws/ops/               # empty: none of the above recorded anything
sudo journalctl -u 'orbit-ops-ws@*' -n 10 --no-pager
```

After a confirmed setup: `findmnt /srv/orbit-workspaces/scratch` (ext4, `nosuid,nodev`), `stat -c '%U %a' /srv/orbit-workspaces/*`
(`orbit 700`), `getent passwd orbit`, `systemctl show orbit.service -p DropInPaths -p MainPID`, `ps -o user= -p <MainPID>` (`orbit`),
`journalctl -u 'orbit-ops-ws-run@*' -u 'orbit-ops-ws-pkg@*'`.

## Uninstall

`sudo /opt/orbit/current/deploy/uninstall-ws.sh [--purge-state]` disables the socket, removes the four units and the `ws-*.ts` files,
and with `--purge-state` deletes `/var/lib/orbit-ops-ws` (records). It never removes what a setup created: the drop-in, mount units and
mounts, images and workspace data, `/etc/orbit/workspaces.json`, the `orbit` user and group, or bubblewrap. It prints each of those and
how to remove it by hand. To stop the host permitting workspace tools without uninstalling, use `ws_revoke`.

## Known limitations

- Nothing was run on a live host. Not proven: the units under their sandboxes (notably `ProtectSystem=yes` with useradd,
  `CAP_DAC_READ_SEARCH` in the front, mount propagation of the new mounts into the runner's namespace so it can chown the roots),
  `SYSTEMD_NSS_DYNAMIC_BYPASS` with useradd while ORBIT runs, `systemctl show --timestamp=unix`, and the real outputs of `getent`,
  `systemctl is-enabled` and `mkfs.ext4` (written to their documented formats and tested on hand-written samples).
- `apt-get install` uses the package lists as they are; it does not run `apt-get update`. With stale lists the step fails and says so.
- If ORBIT is not running, its control group is unknown and `workspaces_file` is blocked until it runs again.
- The front and the runner must see the same host for the plan key to match; a host that changes between them (another admin at work)
  gives `plan_changed`, which is the intended, safe outcome.
- `ws_revoke` does not unmount or delete anything; removing workspaces is a manual, operator decision (see Uninstall).
