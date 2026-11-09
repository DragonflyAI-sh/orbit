# orbit-ops-sys: owner-confirmed OS updates, reboot and orbit-jobs Funnel (tier 3)

Tier 1 (`docs/orbit-ops.md`) answers questions. Tier 2 (`docs/orbit-ops-admin.md`) changes ORBIT's own things. Tier 3 changes the **shared host**: it can install OS updates, reboot, and switch the existing orbit-jobs Tailscale Funnel on or off. It follows the Tier 2 architecture (restricted socket, fixed actions, durable records, separate runner units, owner confirmation bound to a digest) and is a **separate** helper with its own socket, state directory, units and installer, so installing, removing or breaking it never changes Tier 1 or Tier 2.

## What has and has not happened

Keep these three things apart. Nothing below is a claim about the live host.

| Question | Answer today |
|---|---|
| Is the code merged / deployed? | It is a reviewable branch. Merging and the normal deploy put the **ORBIT side** (`src/ops-sys*.ts`, chat tools, routes) on the server. That side finds no helper socket and offers no usable proposals: every propose tool throws "not available, no proposal was created". |
| Are the privileged components installed? | **No.** `deploy/install-sys.sh` has not been run anywhere, and nothing runs it automatically (`install.sh`, `install-admin.sh` and the deploy script do not mention it, and a test pins that). It also refuses to run without `--approved-by-owner`. |
| Is live behaviour verified? | **No.** Every operation was exercised only against fakes (a recording fake `exec`, real temp directories, a fake clock). The unit files, their sandboxing, `systemctl reboot` from inside a sandbox, `apt-get` and `tailscale ... funnel` have never been run on a live host. Unit tests prove neither installation nor live behaviour. |

No live update, reboot or Funnel change was made, and none may be made without Rai's separate approval (see [Staged live acceptance](#staged-live-acceptance)).

## The actions

| Chat tool (proposes only) | Helper action | What the helper does | Counted as done only when |
|---|---|---|---|
| `ops_propose_os_updates` | `install_os_updates` | `apt-get update`, a simulated `apt-get -s upgrade`, then `apt-get upgrade` if policy allows | exit 0 **and** `dpkg --audit` clean **and** no package gone **and** ORBIT's `/status` serves the same commit. Reboot-required is reported, never acted on |
| `ops_propose_reboot_host` | `reboot_host` | persists the pre-reboot state, runs `systemctl reboot` once | after the boot: the **boot id changed** and ORBIT's `/status` serves the commit recorded before. Otherwise `unverified` or `failed` |
| `ops_propose_funnel_enable` / `ops_propose_funnel_disable` | `funnel_enable` / `funnel_disable` | `tailscale --socket=<orbit-jobs socket> funnel ...` on the orbit-jobs node only | the **orbit-jobs node's own serve configuration**, read back, shows the wanted state. External reachability is reported as "not tested" |

Updates and reboot are two proposals and two confirmations; nothing is bundled and updates never reboot. `ops_sys_operations` shows what the helper observed.

### States

`proposed` (an open proposal in ORBIT, nothing on the host) → `confirmed` (ledger entry `dispatching`: the owner clicked, the helper has not yet answered) → `accepted` (recorded, runner not yet working) → `running` → one of `verified`, `no_change`, `failed`, `unverified`, `interrupted`. A reboot additionally passes through `rebooting` and ends only through the post-boot recovery. `accepted`, `running` and `rebooting` never mean success; `unverified` means a command ran but nothing could confirm the result; `interrupted` means the runner vanished and the outcome is unknown. A chat reply may only say a proposal exists if the propose tool returned a `proposalId`; if a check fails the tool throws and no proposal exists.

## Who can ask for what (authorization chain)

1. **Proposal.** Owner-only chat tools (`isOwner && model.step`; `decide("agent", tool)` is owner-only). The tools take **no arguments**, so the model can name no package, service, path, host or destination. ORBIT asks the helper's read-only `sys_status` first (host name, whether the orbit-jobs socket exists, whether an operation is already open) and throws, creating nothing, if the helper is missing, refuses, is busy, or (for Funnel) the orbit-jobs node is not on this host. The card shows the exact target, the action, the impact (shared host, production OpenClaw), recovery limits and the active-job warning.
2. **Confirmation.** `POST /chat/proposals/<id>/confirm` is owner-only and needs `{"digest": "<digest on the card>"}`: a missing or different digest changes nothing. The proposal is spent (one shot), ORBIT re-validates the stored target against the digest, rechecks job state (below), checks expiry, refuses a proposal id already in the ledger, and derives the operation id from the proposal id.
3. **Helper (the privileged boundary)** enforces, regardless of what ORBIT did: strict argument validation (fixed actions, fixed target shapes, no extra keys); the **digest** recomputed from action + target; **expiry** (`expiresAt` must be in the future and within 15 minutes, whatever the request says, and the runner refuses a record that expired before it started); **host name** (a confirmation for another host is refused, again in the runner); for Funnel, the target must equal `ORBIT_PUBLIC_JOB_URL` host and `ORBIT_INGRESS_PORT` in the root-owned `orbit.env`, and the socket must belong to the `orbit-jobs` node; **replay** (a repeated operation id returns the recorded state and never runs again, even after the confirmation expired); **one operation at a time** (exclusive slot file on persistent disk); a 30-minute **reboot cool-down**; and `restart_orbit`/`apply_config` style serialisation: update and reboot runners take the same deploy lock (`state/deploy.lock`) as Tier 2, so they cannot interleave with a deploy, rollback, restart or config change.
4. **Kernel.** Socket mode 0660, group `orbit-ops` (the group the ORBIT service already has), as in Tiers 1 and 2.

## Threat model

Assets: the shared host (ORBIT and production OpenClaw), the public job path, `orbit.env` and credentials.

| Threat | Mitigation | Residual |
|---|---|---|
| A prompt-injected model asks for a dangerous action | No tool takes arguments; only four fixed actions exist; owner-only tools; every action needs a separate click on a digest-bound card; ORBIT states impact before the click | The owner can click Confirm on a bad idea. The card text is the control |
| A compromised ORBIT process forges a request | The socket is group-restricted, not credentialed, so **the helper cannot know the owner clicked** (same as Tier 2). What a forger gets is bounded: four fixed actions, a digest it must compute, a host name and a Funnel target that must equal what root finds, one-at-a-time, replay protection, a reboot cool-down, and no way to name a package, path, unit or destination | A compromised ORBIT can still request an update, a reboot or a Funnel toggle of the approved target. Mitigation if that matters: do not install Tier 3, or give it its own group (drop-in `SupplementaryGroups=` on ORBIT; see below) |
| Argument injection / confused deputy | Targets are validated shapes (`^[a-z0-9-]+$` host; `orbit-jobs.<tailnet>.ts.net` + port 1024-65535); commands are fixed absolute paths with fixed arguments | none known |
| Toggling the wrong Tailscale node (the host's own) | Only the orbit-jobs socket path appears in the code (a test greps the source for `/run/tailscale/`); the Funnel runner unit has `InaccessiblePaths=/run/tailscale`; the node behind the socket must report host name `orbit-jobs` and a DNS name equal to the confirmed target; the target must equal `orbit.env` | If `orbit.env` and the jobs node were both misconfigured consistently, the toggle would apply to that node |
| Replay or delayed confirmation | Operation id derived from the proposal; helper refuses a repeated id; 10-minute expiry enforced by ORBIT **and** the helper; the digest binds action + target | none known |
| Crash / retry / double execution | A record runs only from `accepted`; a retried unit, restarted helper or recovery never re-runs a record; a reboot is issued once, after the pre-reboot state is persisted; the recovery unit has no mutation code path (a test asserts it executes nothing) | A runner killed mid-update leaves package state unknown: reported `interrupted`, an operator must run `dpkg --audit` |
| Package-manager contention | `apt-get -o DPkg::Lock::Timeout=120`; on a lock error the operation fails with "nothing changed"; **no process is killed, no lock file is removed**; no `fuser`/`kill`/`rm` anywhere; `SendSIGKILL=no` on the update unit | If systemd's own 2h20m start timeout fires it sends SIGTERM to apt/dpkg; that can interrupt an upgrade (see recovery) |
| Information disclosure | Nothing reads credentials; `orbit.env` is read for `HOST`, `PORT`, `ORBIT_PUBLIC_JOB_URL`, `ORBIT_INGRESS_PORT` only and never written; every record, audit line and answer is redacted and bounded; boot ids are stored only as a 24-hex digest; the front never logs request bodies | Package names and versions appear in summaries (not secrets) |
| Privilege | No general root, sudo or SSH is granted to ORBIT. The front has no network and no capabilities. Reboot, Funnel and recovery runners have empty capability sets and no (or loopback-only) network | **The update runner is the least confined unit**: dpkg needs to write `/usr`, `/etc`, `/var`, `/boot` and run maintainer scripts, so it has no `ProtectSystem` and no capability limit. Its restriction is the fixed command list and the policy checks, not the sandbox |
| Disruption of other services | Stated on the card; ORBIT's health verified; OpenClaw **not touched and not inspected** | OpenClaw health after an update or reboot is the owner's to check |

## Allowed update policy

- The only upgrade command is `apt-get upgrade` (installed packages move to newer versions; apt itself never removes or newly installs under `upgrade`).
- **Never run**: `dist-upgrade`, `full-upgrade`, `autoremove`, `remove`, `purge`, `do-release-upgrade`, `needrestart`, `reboot`, or any package name, repository, pin or file taken from a request. There are no package arguments at all.
- Before changing anything the runner refuses (nothing changed) if `dpkg --audit` is not clean, if the package manager is busy, or if the **simulation** (`apt-get -s upgrade`) shows any removal or any newly installed package.
- Config prompts are answered `--force-confold --force-confdef`; `DEBIAN_FRONTEND=noninteractive`, `APT_LISTCHANGES_FRONTEND=none`.
- **No automatic reboot, and no automatic service restarts by this tool**: `NEEDRESTART_SUSPEND=1` suspends needrestart's own restarts. If `/run/reboot-required` appears it is reported as "reboot required" and a reboot is a separate proposal. (Whether the host's *own* unattended-upgrades is configured to reboot is host configuration this code does not read or change: check `Unattended-Upgrade::Automatic-Reboot` by hand.)
- After the upgrade it compares the installed-package list (no package may have disappeared), re-runs `dpkg --audit`, counts what is still upgradable (held back), and checks ORBIT's `/status` for the same commit. Any failure is `failed`, never `verified`.
- Side effects on a shared host that remain possible and are stated on the card: library/daemon upgrades can disturb running services (including OpenClaw) until they are restarted; kernel/libc upgrades want a reboot; a failed upgrade can leave dpkg half-configured. **Recovery limits**: package upgrades are not rolled back by ORBIT; ORBIT's own recovery is limited to reporting.

## Funnel topology

Evidence from this repository (what is known):

- `deploy/install.sh` (only when the one-time auth key `/etc/credstore/orbit.tailscale-jobs` exists) installs `orbit-tailscale-jobs.service`: a **second tailscaled on the same host**, userspace networking, own state dir, own socket `/run/orbit-tailscale-jobs/tailscaled.sock`, node name `orbit-jobs`; then runs `tailscale --socket=<that socket> funnel --bg --https=443 http://127.0.0.1:8791` and writes `ORBIT_INGRESS_PORT=8791` and `ORBIT_PUBLIC_JOB_URL=https://<orbit-jobs dns name>` to `orbit.env`.
- The Tier 1 helper reads **two** sockets: the host's own tailscaled (`/run/tailscale/tailscaled.sock`) and the orbit-jobs one. Its `tailscale_status` therefore reports local Funnel configuration of each node as the local daemon sees it and never tests reachability from outside.
- `deploy/routines/orbit-jobs.md` allows the domain `orbit-jobs.tail5bde08.ts.net` for the cloud runners.

So the repository's topology is: **orbit-jobs is a separate Tailscale node run by a second tailscaled on orbit-dedicated-8, and its Funnel is a serve configuration of that node reachable through that node's local socket.** The Tier 3 Funnel actions operate on exactly that socket and nothing else.

Unknown / not established by anything in the repository: whether the production `orbit-jobs` node was in fact installed this way (the install step is conditional on the auth key), or whether it runs on another machine; whether the `tailscale funnel --https=443 off` form behaves as documented on the installed Tailscale version; whether Funnel is reachable from the public internet (never tested here).

Behaviour that follows: if the orbit-jobs socket is absent, both the ORBIT side (at proposal) and the helper (at dispatch and again in the runner) **fail closed** with an explanation and these manual instructions, and the host's own Tailscale is never used as a substitute. A remote orbit-jobs node would need its own helper installed there; none exists, and this tool never invents connectivity to one.

Manual fallback (as root, on the machine that actually runs orbit-jobs):

```sh
ts="tailscale --socket=/run/orbit-tailscale-jobs/tailscaled.sock"
$ts serve status --json                          # inspect first
$ts funnel --bg --https=443 http://127.0.0.1:8791   # enable
$ts funnel --https=443 off                            # disable
```

Funnel changes only act on an **approved configuration**: the node's whole serve configuration must be empty or exactly the one `https:443 → http://127.0.0.1:<ORBIT_INGRESS_PORT>` proxy handler. Anything else is refused ("will not overwrite/modify") rather than touched.

### Active jobs

The helper cannot see jobs, so ORBIT checks, twice. At proposal it counts jobs that are registered/running and not expired, separating **active** from **quiet or not started** (possibly dead, possibly working) and treating a missing or unpersisted job registry as **unknown**; reboot and Funnel-disable cards list them and say unknown means assume running jobs can be cut off. At confirmation it checks again: new jobs since the card, or a known state that became unknown, refuse the confirmation (nothing done; propose again). Updates and Funnel-enable are not blocked by job state; updates only warn.

## Persistence, restart and reboot recovery

- ORBIT's ledger (`STATE_DIRECTORY/ops-sys.json`) and the helper's records (`/var/lib/orbit-ops-sys/ops/<opId>.json`, mode 0700 root-only, atomic writes) are on persistent disk. After an ORBIT restart (or the host's reboot) ORBIT's tick calls `op_status` for every unfinished entry and reports each end once, urgently.
- A reboot record carries `preBootKey` (a digest of `/proc/sys/kernel/random/boot_id`) and the deployed commit, written **before** `systemctl reboot` runs. `orbit-ops-sys-recover.service` runs after each boot; for a record in `rebooting` whose boot key changed it waits up to 5 minutes for ORBIT's `/status` to serve the recorded commit and writes `verified` (boot changed + ORBIT healthy, with the evidence), `failed` (boot changed, ORBIT not healthy) or `unverified` (no commit recorded). If the boot key did not change it does nothing. It executes **no command**.
- If the recovery never records a result (not installed, or the host never came back observably), the helper settles the record as `unverified` after 15 minutes. It is never reported as success without an observed boot change plus healthy ORBIT.
- Records that were `accepted` or `running` when the host went down become `interrupted`; they are never relaunched.

## Rollback and removal

Removing the code path: revert the merge; the ORBIT side then offers no tools. Removing the privileged part (run by a person as root; leaves Tiers 1 and 2, `orbit.env`, credentials, OpenClaw and Tailscale alone):

```sh
sudo /opt/orbit/current/deploy/uninstall-sys.sh              # stop/disable socket + recovery, remove units and sys-*.ts
sudo /opt/orbit/current/deploy/uninstall-sys.sh --purge-state   # also delete /var/lib/orbit-ops-sys (operation records)
```

It does not kill a runner that is mid-operation (it warns). ORBIT then reports tier 3 as unavailable.

Undoing an operation that already ran is **not** something this tool does:

- **OS updates**: no package rollback. Check `dpkg --audit`, `apt-get -s upgrade`, `/var/log/apt/history.log`; downgrade or `dpkg --configure -a` by hand.
- **Reboot**: not reversible. If the host does not return you need provider console access; ORBIT is down too.
- **Funnel**: run the opposite action (needs ORBIT up) or the manual commands above.

Optional hardening (not installed by default): give Tier 3 its own group so only an explicit drop-in grants ORBIT access: change `SocketGroup=` in `orbit-ops-sys.socket` to a new group and add a drop-in `SupplementaryGroups=` for `orbit.service`. That requires an ORBIT restart and was left out because the ORBIT unit is pinned by tests.

## Installation (manual, NOT performed by this change)

As root, from a release directory, **only after Rai has approved installation** (it does not run any operation):

```sh
sudo /opt/orbit/current/deploy/install-sys.sh --approved-by-owner
```

It requires Tiers 1 and 2 to be installed (it needs `/usr/local/lib/orbit/ops` and the `orbit-ops` group), installs `sys-*.ts` and the shared `admin-protocol.ts`, `admin-core.ts`, `protocol.ts` (the same bytes Tier 2 installs) root-owned, installs six units, enables `orbit-ops-sys.socket` and `orbit-ops-sys-recover.service`, and restarts only the socket. It does not restart ORBIT. Manual prerequisites: `/usr/bin/apt-get`, `dpkg`, `dpkg-query`, `flock`, `systemctl`; `/usr/bin/tailscale` for Funnel (without it Funnel fails closed); the ORBIT service in group `orbit-ops` (Tier 1 provides it).

## Staged live acceptance

**Requires Rai's separate approval for each stage. Nothing here has been done.** Do them at a quiet time, with no active jobs, with a second SSH session open and provider-console access confirmed. Stop at the first surprise.

0. **Review and merge** the branch. Confirm ORBIT's propose tools throw "not available" (helper not installed): `ops_propose_os_updates` in chat must produce no proposal.
1. **Install (approval A).** Run `install-sys.sh --approved-by-owner`. Check `ls -l /run/orbit-ops-sys.sock` (root:orbit-ops 0660), `systemctl is-enabled orbit-ops-sys.socket orbit-ops-sys-recover.service`, `systemctl status orbit-ops-sys@*` shows nothing running. Tier 1/2 still work. Probe `sys_status` (see the socket probe in `docs/orbit-ops-admin.md`, using `{"action":"sys_status"}`) and an `unknown_action` and a bad digest: expect refusals and no state change in `/var/lib/orbit-ops-sys`.
2. **Funnel read-only.** `tailscale --socket=/run/orbit-tailscale-jobs/tailscaled.sock serve status --json` and `status --json`: confirm it is the `orbit-jobs` node, `Self.DNSName` equals `ORBIT_PUBLIC_JOB_URL`, the serve config is exactly `https:443 → 127.0.0.1:$ORBIT_INGRESS_PORT`. Record the output as evidence. If it is not, stop: the topology assumption is wrong.
3. **Funnel disable/enable round trip (approval B).** With no active jobs: propose disable, read the card, confirm; expect `verified` with evidence "externalReachability: not tested". Then from **outside** the tailnet (e.g. a phone off Wi-Fi) test `https://<orbit-jobs>/` is unreachable; propose enable, confirm, expect `verified`, then test reachability from outside again. Only now is "reachability" something that was actually tested, and it is yours, not the tool's. Check the exact `funnel ... off` behaviour on this Tailscale version.
4. **OS updates dry run (approval C).** Run `apt-get -s upgrade` by hand and read the plan. If it removes or installs anything, stop (the tool will refuse too). Check `unattended-upgrades` config for automatic reboot. Note the OpenClaw state to compare.
5. **OS updates (approval D).** Propose and confirm. Expect `verified`, `rebootRequired` as reported, **no reboot**. Check OpenClaw yourself. Also try (while it runs) another proposal: expect `busy`.
6. **Reboot (approval E, the riskiest).** Only with the console available and OpenClaw owners informed. Propose and confirm. The card must say `dispatched, not verified`. After the host returns: `ops_sys_operations` should show `verified` with a changed boot key and ORBIT healthy; compare `uptime -s`. Check OpenClaw. Also confirm a second reboot proposal within 30 minutes is refused (`cooldown`).
7. **Negative checks.** Confirm without a digest (curl) → 409; from a different Tailscale identity → 403; let a card expire then confirm → no dispatch.

Record, per stage, what was run and the evidence, in the vault note for this task.

## Evidence gaps

- Never run on a real host: units' sandbox settings (empty capability sets, `PrivateNetwork`, `InaccessiblePaths`, `SendSIGKILL=no`), `systemctl reboot` and `systemctl start` from inside them, `apt-get -s upgrade` output format on this Ubuntu release (the parser is written to the documented `Inst`/`Remv` lines and is tested on samples I wrote, not captured output), `dpkg-query` status abbreviations, `tailscale ... serve status --json` shape and `funnel --https=443 off` semantics (taken from `src/ops/helper.ts`'s `ServeConfig` type and the Tailscale CLI documentation, not executed).
- Whether the production orbit-jobs node is the local second tailscaled (the repository says so; production was not inspected).
- OpenClaw: unit names, health and how it reacts to updates/reboot are unknown to this code; it is neither touched nor checked.
- The 2h update limit and 5-minute post-boot health window are guesses.
- The residual forged-request risk and the unconfined update runner are inherent to the design, not bugs to be fixed by this change.
- `redact()` treats any 32+ character opaque token as a secret; summaries therefore avoid raw boot ids.
- Tests prove validation, binding, expiry, replay, concurrency, recovery and verification *logic* against fakes. They prove neither installation nor live behaviour.
