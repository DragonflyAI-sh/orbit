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
| `ops_propose_os_updates` | `plan_os_updates` (at proposal), then `install_os_updates` (after the click) | Proposal: the helper's own runner does `apt-get update` then `apt-get -s upgrade` to get an explicit package/version plan (**nothing is installed**; `apt-get update` refreshes apt metadata and is **not literally read-only**). Execution: re-simulates, refuses if the plan differs from the confirmed one, then `apt-get upgrade` | exit 0 **and** `dpkg --audit` clean **and** no package gone **and** every planned package at its planned version **and** ORBIT's `/status` serves the same commit. Reboot-required is reported, never acted on |
| `ops_propose_reboot_host` (optional `at`) / `ops_sys_cancel_reboot` | `reboot_host` / `cancel_reboot` | now, or at a UTC time 2 minutes to 24 hours ahead: persists the pre-reboot state, runs `systemctl reboot` once. A scheduled reboot can be cancelled until it fires | after the boot: the **boot id changed** and ORBIT's `/status` serves the commit recorded before. Otherwise `unverified` or `failed`. A cancellation is reported only if the helper confirms nothing was issued |
| `ops_propose_funnel_enable` / `ops_propose_funnel_disable` | `funnel_enable` / `funnel_disable` | `tailscale --socket=<orbit-jobs socket> funnel ...` on the orbit-jobs node only | the **orbit-jobs node's own serve configuration**, read back, shows the wanted state. External reachability is reported as "not tested" |

Updates and reboot are two proposals and two confirmations; nothing is bundled and updates never reboot. `ops_sys_operations` shows what the helper observed.

### States

`proposed` (an open proposal in ORBIT, nothing on the host) → `confirmed` (ledger entry `dispatching`: the owner clicked, the helper has not yet answered) → `accepted` (recorded, runner not yet working) → `running` → one of `verified`, `no_change`, `failed`, `unverified`, `interrupted`. A reboot additionally passes through `rebooting` and ends only through the post-boot recovery. A reboot for later is `scheduled` (nothing issued, cancellable) until its time, then `accepted`; a withdrawn one ends `cancelled` (nothing was issued). `accepted`, `scheduled`, `running` and `rebooting` never mean success; `unverified` means a command ran but nothing could confirm the result; `interrupted` means the runner vanished and the outcome is unknown. A chat reply may only say a proposal exists if the propose tool returned a `proposalId`; if a check fails the tool throws and no proposal exists.

## Who can ask for what (authorization chain)

1. **Proposal.** Owner-only chat tools (`isOwner && model.step`; `decide("agent", tool)` is owner-only). The tools take **no arguments** (the one exception: `ops_propose_reboot_host` accepts an optional UTC time `at`, and `ops_sys_cancel_reboot` an optional operation id), so the model can name no package, service, path, host or destination. ORBIT asks the helper's read-only `sys_status` first (host name, whether the orbit-jobs socket exists, whether an operation is already open) and throws, creating nothing, if the helper is missing, refuses, is busy, or (for Funnel) the orbit-jobs node is not on this host. The card shows the exact target, the action, the impact (shared host, production OpenClaw), recovery limits and the active-job warning.
2. **Confirmation.** `POST /chat/proposals/<id>/confirm` is owner-only and needs `{"digest": "<digest on the card>"}`: a missing or different digest changes nothing. The proposal is spent (one shot), ORBIT re-validates the stored target against the digest, rechecks job state (below), checks expiry, refuses a proposal id already in the ledger, and derives the operation id from the proposal id.
3. **Helper (the privileged boundary)** enforces, regardless of what ORBIT did: strict argument validation (fixed actions, fixed target shapes, no extra keys); the **digest** recomputed from action + target; **expiry** (`expiresAt` must be in the future and within 15 minutes, whatever the request says, and the runner refuses a record that expired before it started); **host name** (a confirmation for another host is refused, again in the runner); for Funnel, the target must equal `ORBIT_PUBLIC_JOB_URL` host and `ORBIT_INGRESS_PORT` in the root-owned `orbit.env`, and the socket must belong to the `orbit-jobs` node; **replay** (a repeated operation id returns the recorded state and never runs again, even after the confirmation expired); **one operation at a time** (exclusive slot files on persistent disk, in two lanes: see [Exclusivity matrix](#exclusivity-matrix)); a 30-minute **reboot cool-down** (from the last reboot actually *issued*; see below); and `restart_orbit`/`apply_config` style serialisation: update and reboot runners take the same deploy lock (`state/deploy.lock`) as Tier 2, so they cannot interleave with a deploy, rollback, restart or config change.
4. **What the digest is, and is not.** The digest binds the *request* (action, target, and for an update the full package plan, for a scheduled reboot the time) to what the card showed: the helper recomputes it, so a request cannot be changed after the card was shown without the digest no longer matching. It does **not** prove the owner clicked: it is a SHA-256 of public values that any process able to talk to the socket can compute. **Membership in the `orbit-ops` group is the trust boundary, exactly as in Tier 2.** This design provides no cryptographic, independent owner approval, and nothing in this repository or its PR claims it does. Cancellation needs no confirmation either: it can only prevent a change, and it is recorded and audited.
5. **Kernel.** Socket mode 0660, group `orbit-ops` (the group the ORBIT service already has), as in Tiers 1 and 2.

## Threat model

Assets: the shared host (ORBIT and production OpenClaw), the public job path, `orbit.env` and credentials.

| Threat | Mitigation | Residual |
|---|---|---|
| A prompt-injected model asks for a dangerous action | No tool takes arguments; only four fixed actions exist; owner-only tools; every action needs a separate click on a digest-bound card; ORBIT states impact before the click | The owner can click Confirm on a bad idea. The card text is the control |
| A compromised ORBIT process forges a request | The socket is group-restricted, not credentialed, so **the helper cannot know the owner clicked** (same as Tier 2). What a forger gets is bounded: four fixed actions, a digest it must compute, a host name and a Funnel target that must equal what root finds, one-at-a-time, replay protection, a reboot cool-down, and no way to name a package, path, unit or destination | A compromised ORBIT can still request an update, a reboot or a Funnel toggle of the approved target. Mitigation if that matters: do not install Tier 3, or give it its own group (drop-in `SupplementaryGroups=` on ORBIT; see below) |
| Argument injection / confused deputy | Targets are validated shapes (`^[a-z0-9-]+$` host; `orbit-jobs.<tailnet>.ts.net` + port 1024-65535); commands are fixed absolute paths with fixed arguments | none known |
| Toggling the wrong Tailscale node (the host's own) | Only the orbit-jobs socket path appears in the code (a test greps the source for `/run/tailscale/`); the Funnel runner unit has `InaccessiblePaths=/run/tailscale`; the node behind the socket must report host name `orbit-jobs` and a DNS name equal to the confirmed target; the target must equal `orbit.env` | If `orbit.env` and the jobs node were both misconfigured consistently, the toggle would apply to that node |
| Replay or delayed confirmation | Operation id derived from the proposal; helper refuses a repeated id; 10-minute expiry enforced by ORBIT **and** the helper; the digest binds action + target | none known |
| Two requests both taking over a stale slot | Takeover is atomic: only the party that creates the one-time `retired/<holder>` marker may remove that holder's slot (see "Slot ownership") | A process killed between creating the marker and removing the slot leaves an *orphaned marker*: recovered automatically once the marker is 10 minutes old and the holder's record is terminal (see "Slot ownership"); a kill inside the microsecond removal critical section leaves a claim file, which fails closed until an operator removes it |
| Crash / retry / double execution | A record runs only from `accepted`; a retried unit, restarted helper or recovery never re-runs a record; a reboot is issued once, after the pre-reboot state is persisted; the recovery unit has no mutation code path (a test asserts it executes nothing) | A runner killed mid-update leaves package state unknown: reported `interrupted`, an operator must run `dpkg --audit` |
| Package-manager contention | `apt-get -o DPkg::Lock::Timeout=120`; on a lock error the operation fails with "nothing changed"; **no process is killed, no lock file is removed**; no `fuser`/`kill`/`rm` anywhere; `SendSIGKILL=no` on the update unit | If systemd's own 2h20m start timeout fires it sends SIGTERM to apt/dpkg; that can interrupt an upgrade (see recovery) |
| Information disclosure | Nothing reads credentials; `orbit.env` is read for `HOST`, `PORT`, `ORBIT_PUBLIC_JOB_URL`, `ORBIT_INGRESS_PORT` only and never written; every record, audit line and answer is redacted and bounded; boot ids are stored only as a 24-hex digest; the front never logs request bodies | Package names and versions appear in summaries (not secrets) |
| Privilege | No general root, sudo or SSH is granted to ORBIT. The front has no network and no capabilities. Reboot, Funnel and recovery runners have empty capability sets and no (or loopback-only) network | **The update and plan runners are the least confined units**: dpkg needs to write `/usr`, `/etc`, `/var`, `/boot` and run maintainer scripts, so it has no `ProtectSystem` and no capability limit. Its restriction is the fixed command list and the policy checks, not the sandbox |
| Disruption of other services | Stated on the card; ORBIT's health verified; OpenClaw **not touched and not inspected** | OpenClaw health after an update or reboot is the owner's to check |

## Allowed update policy

- The only upgrade command is `apt-get upgrade` (installed packages move to newer versions; apt itself never removes or newly installs under `upgrade`), and it runs only for **the exact plan the owner confirmed** (see "OS update plan").
- **Never run**: `dist-upgrade`, `full-upgrade`, `autoremove`, `remove`, `purge`, `do-release-upgrade`, `needrestart`, `reboot`, or any package name, repository, pin or file taken from a request. There are no package arguments at all.
- Before changing anything the runner refuses (nothing changed) if `dpkg --audit` is not clean, if the package manager is busy, if the **simulation** (`apt-get -s upgrade`) is malformed or shows any removal or any newly installed package, or if the simulated plan is not the confirmed plan.
- Config prompts are answered `--force-confold --force-confdef`; `DEBIAN_FRONTEND=noninteractive`, `APT_LISTCHANGES_FRONTEND=none`.
- **No reboot, ever, from an update.** If `/run/reboot-required` appears it is reported as "reboot required" and a reboot is a separate proposal. (Whether the host's *own* unattended-upgrades is configured to reboot is host configuration this code does not read or change: check `Unattended-Upgrade::Automatic-Reboot` by hand.)
- **Services may still restart.** This tool restarts no service itself and suspends needrestart (`NEEDRESTART_SUSPEND=1`), **but package maintainer scripts (openssh, tailscale, libc, systemd and others) can restart daemons on their own, and nothing here can prevent that.** A tailscaled or sshd upgrade can drop connections; a libc upgrade makes running daemons want a restart. The card and the result text say this; no document, comment or message in this change claims that services are never restarted.
- After the upgrade it compares the installed-package list (no package may have disappeared) and each planned package's installed version, re-runs `dpkg --audit`, counts what is still upgradable (held back), and checks ORBIT's `/status` for the same commit. Any failure is `failed`; installed versions that differ from the plan are `unverified`; never `verified`.
- Side effects on a shared host that remain possible and are stated on the card: library/daemon upgrades can disturb running services (including OpenClaw); kernel/libc upgrades want a reboot; a failed upgrade can leave dpkg half-configured. **Recovery limits**: package upgrades are not rolled back by ORBIT; ORBIT's own recovery is limited to reporting.

### OS update plan (proposal step and execution step)

1. **Proposal.** ORBIT calls `plan_os_updates` (no digest, no arguments but a random operation id). The helper's runner (`orbit-ops-sys-plan@.service`, same sandbox as the update runner because `apt-get update` needs the network and `/var`) runs `dpkg --audit`, `apt-get update` and `apt-get -s upgrade`. **`apt-get update` refreshes apt metadata under `/var/lib/apt/lists` and takes the apt lock: it is not literally read-only. Neither step installs or upgrades any package.** The plan op takes the same running-operation slot as everything else. ORBIT waits for it for at least as long as the runner may run, and says so honestly when it gives up: see [Plan timeouts](#plan-timeouts).
2. **Parsing is strict.** Every `Inst` line must be `Inst <pkg> [<old>] (<new> ...)` with package and version in a restricted alphabet, and the `N upgraded, M newly installed, K to remove and J not upgraded.` summary line must exist and agree with the lines. A removal, a new package, a malformed or duplicate line, a missing summary, more than 150 packages (a bound that keeps the plan inside the helper's response limit; a bigger backlog is refused, never truncated) or no pending upgrade yields **no plan** (`failed`, or `no_change` for nothing pending), so no proposal exists.
3. **Card.** The plan (sorted, `name old -> new`, every line) is on the card, with a `FLAGGED PACKAGES` banner naming kernel (`linux-image/modules/headers/generic/...`), libc, systemd (`systemd`, `libsystemd*`, `udev`), openssh and tailscale packages.
4. **Binding.** `planDigest = sha256(canonical JSON of the sorted [package, from, to] list)`. The confirmation digest is `sha256({tier, action, target, planDigest})`. The request carries `planDigest` and the helper recomputes the confirmation digest from it; ORBIT recomputes the plan digest from the plan it received and refuses a plan whose helper-reported 24-character digest key does not match. (Digests travel as a 24-character key because the shared redactor blanks 64-hex strings.)
5. **Execution.** After `dpkg --audit`, the runner runs `apt-get -s upgrade` again (it does **not** run `apt-get update`: the owner approved a plan against specific package lists, and a refresh in between simply shows up as a different plan), recomputes the digest and **refuses before installing anything** if it differs from the confirmed one (a new package, a new version, a package gone, nothing pending). The owner must then ask again and confirm a new plan. A busy package manager, a failed or timed-out simulation or malformed output also end the operation with nothing changed.
6. **Remaining limits, stated honestly.** (a) The plan is a simulation at one moment. Between the final simulation and `apt-get upgrade` apt resolves again against whatever package lists exist then (apt-daily, another administrator): the version check afterwards reports any difference as `unverified`, it cannot prevent it. (b) Another process can take the apt lock between steps: the runner then fails with "busy" and never kills or unlocks anything. (c) Package state is not transactional: a failed upgrade can leave packages half-configured. (d) The runner does not pass the plan as explicit `pkg=version` arguments; it keeps `apt-get upgrade` (no package arguments exist anywhere), which keeps the "no names from a request" rule at the cost of (a).

## Reboot: scheduling, cancellation, cool-down

**Scheduling.** `ops_propose_reboot_host` takes an optional UTC time `at` in the canonical form `YYYY-MM-DDTHH:MM:SS.sssZ` (one time, one spelling, one digest). ORBIT requires it to be at least 2 minutes and at most 24 hours ahead *before any card exists*; the helper independently requires at least 60 seconds and at most 24 hours ahead at acceptance (so a slow confirmation that makes the time too close is refused with nothing dispatched). The time is part of the confirmation digest; a reboot "now" keeps the original digest form. The confirmation's own 15-minute expiry applies when the helper accepts the request; after that the schedule, not the expiry, governs.

**Persistence and recovery.** An accepted scheduled reboot is a record in state `scheduled` with `schedule.at`, and, while it waits, it holds only the `scheduled` lane (so a second reboot, an update or a plan is `busy` until it is done or cancelled, but a **Funnel change and a cancellation are not blocked**: see [Exclusivity matrix](#exclusivity-matrix)). It takes the running-operation slot itself when it fires. The helper starts the reboot runner unit at once; the unit waits (sleeping, checking for a cancellation every 15 seconds at most) **without holding the deploy lock**, so a long wait never blocks a Tier 2 deploy, and takes the deploy lock only when it is due. ORBIT's ledger and the helper's record are on disk, so an ORBIT restart loses nothing: `ops_sys_operations` and `ops_sys_cancel_reboot` still see it. If the *runner* is lost before the time (the host restarted for another reason, the unit was killed) the record is settled `interrupted` with the text "NO reboot was issued by this operation and it will not fire later", never relaunched; schedule it again if it is still wanted. (Re-arming a schedule across a host reboot was not built: it would need the recovery unit to start a runner, which is deliberately impossible.)

**Cancellation (`cancel_reboot`).** Owner-only chat tool; no confirmation, because it can only prevent a change. Cancel versus fire is decided by **one exclusive marker file** (`decided/<opId>`, created with `O_EXCL`, containing `cancel` or `fire`). The runner writes `fire` when the time arrives (or, for a reboot "now", right after it has the deploy lock and before it writes anything); the front writes `cancel`. Whoever creates the file first decides; the other reads the answer. So: a cancel that finds `fire` answers `too_late` ("already dispatched, NOT cancelled") and is shown as an error by ORBIT, which then re-reads the operation's real state; a runner that finds `cancel` stops without touching the record. A cancellation is reported as success only if the helper won that decision. It is recorded as a `cancelled` step in the operation, the record's state is `cancelled`, ORBIT's ledger gets `cancelledAt`, and the helper writes an audit line to the journal. Repeating a cancel answers "already cancelled" with no new record; cancelling a non-reboot, an unknown id, or an already-ended reboot is refused with a specific code. Cancelling an unreachable helper's reboot is reported as **not** cancelled ("may still fire").

**Cool-down (re-derived from the code).** PR #40's review comment on this (finding 6) is cut off in what could be read (it ends "Reboot cool-down counts fail"); the following is derived from `src/ops/sys-helper.ts` as merged, not from the missing text. The 30-minute cool-down looked at `acceptedAt` of **every** `reboot_host` record, whatever became of it, and ran **before** the slot was taken:
1. A reboot request that never issued a reboot (runner could not be started, wrong host, confirmation expired before the runner ran, the deploy lock was not available, `systemctl reboot` refused) still blocked the owner for 30 minutes. The old test even asserted it ("even a finished one"), with a record in state `failed`.
2. It counted from acceptance, not from the reboot: a reboot that waited minutes for the deploy lock got a shorter protection, and with scheduling a reboot accepted hours earlier would have started the clock long before anything happened.
3. It was a check-then-act outside the slot: nothing serialised two requests between the check and the record.
4. It depended on the 50-record retention (`pruneRecords`): a pruned record forgot the reboot.
Fix: the cool-down counts from `reboot.issuedAt` (persisted before `systemctl reboot`; a refused command removes it) plus a `last-reboot-issued` stamp file that survives pruning; it is checked **while holding the slot** and the slot is given straight back on refusal; for a scheduled reboot it is checked at the *scheduled* time at acceptance and again when it fires; `sys_status` reports `rebootCooldownUntil` so ORBIT refuses a proposal inside the cool-down before any card. Residual: a reboot done by hand or by the host itself is invisible to it.

## Slot ownership (stale-slot takeover)

There are two slot files in `/var/lib/orbit-ops-sys` (lanes), each holding one operation id: `active` (**main**: the operation that is running or being accepted) and `active-scheduled` (**scheduled**: a reboot that is only waiting for its time). The merged code removed a stale slot with check-then-unlink: two requests could both read the stale holder, one remove it and take the slot, the other then remove *that* slot and take its own, and both dispatch. The protocol now is:

1. **Acquire** by `link(2)` of a fully written temp file: the slot is never visible empty, and creation fails if it exists.
2. **Retire** (every removal: a holder's own release, a stale takeover, a give-back): create the one-time marker `retired/<holder>` (`O_EXCL`; `retired/<holder>.scheduled` for the scheduled lane). Only the creator may proceed. Ids are not reused, so the slot cannot hold that holder again and nobody else can replace it while it exists.
3. **Remove under a claim.** The only code that unlinks a slot (`removeIfHolder`) first creates the exclusive claim `recovering/<holder>[.scheduled]`, re-reads the slot, removes it only if it **still holds that holder**, and releases the claim. While a claim is held nobody else removes that holder's slot, so the read-check-remove cannot interleave with another remover (the original retirer and a recoverer are serialised by it). A holder id can be removed at most once.
4. If the removal throws, the retirer takes its marker back (no orphaned marker), the slot stays held (fails closed) and the next caller retires it normally.
5. A slot with no record is `busy` while young (a request mid-accept) and retired when older than `staleAfterMs` (30 s); a slot whose content is not an operation id fails closed. Markers go with the record when it is pruned.

**Abandon** (a request that took a slot but fails before it saved its record: a refusal such as the cool-down, or *any* throw) uses exactly the same retirement (`abandonSlot` = `retireSlot`), so it never removes a slot that holds someone else and never leaves an orphan. Consequence: an id whose slot was given back is spent (its marker is one-time); a retry with the same id is refused with "already used and its slot given back" and needs a fresh id. ORBIT never reuses one (a confirmation is single-use).

**Orphaned marker recovery.** A retirer killed after creating the marker and before removing the slot leaves the slot held and the marker behind. `takeSlot` recovers it automatically (`recoverOrphanedRetirement`) when **all** hold, otherwise it does nothing and the request is `busy` (fail safe):

| Condition | If not met |
|---|---|
| the marker exists, is a regular file, and its age is at least **`orphanMarkerAfterMs` = 10 minutes** | `young` / `ambiguous` (a marker from the future, a directory, an unreadable one): untouched |
| the holder's record exists | `no_record`: untouched |
| the holder's record is terminal | `nonterminal`: untouched, however old the marker |
| the exclusive claim is won | `claimed`: another party is finishing it |
| the slot **still holds that holder** (read under the claim) | nothing is removed; only the stale marker is cleared, so a newer holder is never deleted |

*Why 10 minutes.* The retirement critical section is a handful of synchronous file operations (microseconds, no `await`), so a live retirer never holds a marker for more than a moment; 10 minutes is 20 times the staleness limit and far longer than any scheduling pause of a healthy process, yet short enough that a crashed retirement heals within one ORBIT proposal cycle. It is configurable (`SysConfig.orphanMarkerAfterMs`). The age is measured against the helper's clock and the marker's mtime.

Residual: a process killed *inside* the removal critical section (holding the claim) leaves a claim file; every later removal of that holder answers `claimed` (busy, fail closed) until an operator removes `recovering/<holder>`. This was deliberately not auto-recovered: breaking a claim would reintroduce a window where two parties remove. A slot holding something this helper did not write is never touched.

## Exclusivity matrix

Rows are the new request, columns what is already open. **busy** = refused by the helper with `busy` and nothing recorded or dispatched; **ok** = accepted. Cancellation (`cancel_reboot`) takes no slot and is never blocked.

| New request \ open | update | plan | reboot now / firing | scheduled reboot (waiting) | Funnel change |
|---|---|---|---|---|---|
| **update** | busy | busy | busy | busy | busy |
| **plan** | busy | busy | busy | busy | busy |
| **reboot now** | busy | busy | busy | busy | busy |
| **scheduled reboot** | busy | busy | busy | busy | **ok** |
| **funnel_enable / funnel_disable** | busy | busy | busy | **ok** | busy |
| **cancel_reboot** | ok | ok | too_late if fired | ok | ok |

How it is enforced: update, plan, reboot now and Funnel take `main`; a scheduled reboot takes `scheduled`. After taking its own lane a request checks the other one (update/plan/reboot-now look at `scheduled`; a scheduled reboot looks at `main`; Funnel does not look at `scheduled`), and gives its lane back through the marker protocol if the matrix says busy. Each side publishes its intent and then looks at the other, so two requests racing across lanes may both be refused but never both proceed. `sys_status` reports every open operation (`openOperations`; `openOperation` stays the most recent) and ORBIT applies the same matrix before it makes a card.

**When a scheduled reboot fires** (`awaitSchedule`): it takes the running-operation slot `main` *before* it claims `fire`. A Funnel change still in flight is waited for (cancellation still wins meanwhile); once the reboot holds `main` no Funnel change can start (they are busy) and the waiting lane is released (exclusion is continuous). If `main` is still not free after `fireSlotWaitMs` (2 minutes), it does **not** fire: nothing is issued, the record ends `failed` with "NOT rebooted ... NO reboot was issued by this operation. Schedule it again", and it never claimed `fire`. A finished holder, or an orphaned retirement of one, does not stop it. A holder whose runner is dead is not guessed about by the runner: it waits, then does not fire (fail safe). The cool-down, the host check, the deploy lock and the single `systemctl reboot` are unchanged.

## Plan timeouts

The plan runner executes `dpkg --audit` (limit 60 s), `apt-get update` (600 s) and `apt-get -s upgrade` (120 s), each apt command also waiting up to 120 s for the apt lock (`DPkg::Lock::Timeout=120`). These limits are constants in `sys-protocol.ts` (`PLAN_*`), used by the runner and by ORBIT: `PLAN_RUNNER_MAX_MS` = 60 + 600 + 120 + 2 x 120 = **1020 s**. ORBIT waits `PLAN_WAIT_MS` = runner maximum + 60 s margin = **1080 s** (360 polls of 3 s; it used to wait 300 s against a runner that could run 600 s, so it could give up on a plan that was still running). Tests pin that the wait is never shorter than the runner's budget and that the runner uses the same constants.

The limits are nominal: apt-get is never killed (`noKill`), so a plan can in principle outlive them. A plan cannot be cancelled (that would mean killing apt), so ORBIT does not pretend to: when it gives up it reads the plan's status once more and reports it exactly: "the update plan (operation ...) is STILL running on the helper ... ORBIT stopped waiting ... that did not stop it ... it holds the tier 3 slot until it ends ... Nothing was installed ... No proposal was created". It sends no cancel and creates nothing. While the helper still reports the plan open, new proposals are refused up front with that reason (no second plan is started); when the runner ends it releases the slot, and a runner that died is settled `interrupted` by the next request, which then takes the slot (both tested with fakes). A late plan result is discarded.

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

It requires Tiers 1 and 2 to be installed (it needs `/usr/local/lib/orbit/ops` and the `orbit-ops` group), installs `sys-*.ts` and the shared `admin-protocol.ts`, `admin-core.ts`, `protocol.ts` (the same bytes Tier 2 installs) root-owned, installs seven units (the front, the update, plan, reboot and Funnel runners, the socket and the recovery unit), enables `orbit-ops-sys.socket` and `orbit-ops-sys-recover.service`, and restarts only the socket. It does not restart ORBIT. Manual prerequisites: `/usr/bin/apt-get`, `dpkg`, `dpkg-query`, `flock`, `systemctl`; `/usr/bin/tailscale` for Funnel (without it Funnel fails closed); the ORBIT service in group `orbit-ops` (Tier 1 provides it).

## Staged live acceptance

**Requires Rai's separate approval for each stage. Nothing here has been done.** Do them at a quiet time, with no active jobs, with a second SSH session open and provider-console access confirmed. Stop at the first surprise.

0. **Review and merge** the branch. Confirm ORBIT's propose tools throw "not available" (helper not installed): `ops_propose_os_updates` in chat must produce no proposal.
1. **Install (approval A).** Run `install-sys.sh --approved-by-owner`. Check `ls -l /run/orbit-ops-sys.sock` (root:orbit-ops 0660), `systemctl is-enabled orbit-ops-sys.socket orbit-ops-sys-recover.service`, `systemctl status orbit-ops-sys@*` shows nothing running. Tier 1/2 still work. Probe `sys_status` (see the socket probe in `docs/orbit-ops-admin.md`, using `{"action":"sys_status"}`) and an `unknown_action` and a bad digest: expect refusals and no state change in `/var/lib/orbit-ops-sys`.
2. **Funnel read-only.** `tailscale --socket=/run/orbit-tailscale-jobs/tailscaled.sock serve status --json` and `status --json`: confirm it is the `orbit-jobs` node, `Self.DNSName` equals `ORBIT_PUBLIC_JOB_URL`, the serve config is exactly `https:443 → 127.0.0.1:$ORBIT_INGRESS_PORT`. Record the output as evidence. If it is not, stop: the topology assumption is wrong.
3. **Funnel disable/enable round trip (approval B).** With no active jobs: propose disable, read the card, confirm; expect `verified` with evidence "externalReachability: not tested". Then from **outside** the tailnet (e.g. a phone off Wi-Fi) test `https://<orbit-jobs>/` is unreachable; propose enable, confirm, expect `verified`, then test reachability from outside again. Only now is "reachability" something that was actually tested, and it is yours, not the tool's. Check the exact `funnel ... off` behaviour on this Tailscale version.
4. **OS updates dry run (approval C).** Run `apt-get -s upgrade` by hand and read the plan. If it removes or installs anything, stop (the tool will refuse too). Check `unattended-upgrades` config for automatic reboot. Note the OpenClaw state to compare. Then ask ORBIT to propose the update **only** (do not confirm): it must run `apt-get update` and a simulation through the helper, show a card whose package list matches your own simulation, and flag any kernel/libc/systemd/openssh/tailscale package; let the card expire. Confirm via `journalctl` and `/var/log/apt/history.log` that nothing was installed.
5. **OS updates (approval D).** Propose and confirm. Expect `verified`, `rebootRequired` as reported, **no reboot**. Check OpenClaw, and `journalctl` for daemons the package scripts restarted (sshd, tailscaled). Also try (while it runs) another proposal: expect `busy`. Separately (approval D2) change the package lists between the card and the click (`apt-get update` by hand, if upstream moved) and confirm: expect a refusal "no longer the plan you confirmed" with nothing installed.
6. **Reboot (approval E, the riskiest).** Only with the console available and OpenClaw owners informed. Propose and confirm. The card must say `dispatched, not verified`. After the host returns: `ops_sys_operations` should show `verified` with a changed boot key and ORBIT healthy; compare `uptime -s`. Check OpenClaw. Also confirm a second reboot proposal within 30 minutes is refused (`cooldown`).
6a. **Scheduled reboot and cancellation (approval E2, separate from E).** Schedule a reboot 10 minutes ahead; confirm `systemctl status orbit-ops-sys-reboot@*` shows the runner waiting and that it holds no `deploy.lock` (`fuser`/`lsof` on `/opt/orbit/state/deploy.lock` shows nothing from it) and that a Tier 2 deploy is not blocked; cancel it from chat and confirm the unit exits, the record is `cancelled`, the journal has the audit line, and no reboot happens. Then schedule again and cancel after the time passes (a second or two after): expect "too late", a reboot, and the ledger not marked cancelled. Restart ORBIT while one is scheduled and check the ledger still shows it. Only the reboot at the end of this stage needs the E preparations.
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

## Fake-test evidence

Everything below ran against fakes only: a recording fake `exec` that answers from a script (no `apt-get`, `dpkg`, `systemctl`, `tailscale` or any other command is ever executed), real temp directories for the state directory, a fake clock and sleep, and a fake helper client on ORBIT's side. Nothing touched a host.

Commands (from the repository root):

```sh
pnpm install --frozen-lockfile
pnpm typecheck        # tsc
pnpm test             # node --test test/*.test.ts
```

Result at the time of writing: `tsc` exit 0; `node --test test/*.test.ts`: see the job summary for the exact figures of the pushed commit.

| Requirement | Where it is tested (fakes) |
|---|---|
| Atomic stale-slot takeover | `test/ops-sys-helper.test.ts`: "stale slot: two simultaneous requests ... at most one dispatch" (both contenders held at the stale-holder check by a gate, then released: exactly one `systemctl start`), "... must not delete the replacement holder's slot when it resumes late" (and a late release by the replaced holder), "slot primitives", "slot with no record". The two tests above pass even for a read-then-unlink `retireSlot` (shown below); the strengthened ones that fail for it are: "retireSlot race: a late contender whose read is interleaved ..." and "takeover race end to end ..." (`slotHooks.afterRead` runs a rival retirement and a takeover between the contender's read and its removal) |
| Orphaned marker recovery | "orphaned marker: ..." (old + terminal recovered; young, nonterminal, no record, no marker, directory, future mtime, foreign slot all fail safe; a newer holder is never deleted; two recoverers and the waking original retirer are serialised by the claim), "slot removal that fails leaves no orphaned marker" |
| Abandon on the marker protocol | "abandon: a throw building the record / inside saveRecord" for update, Funnel and reboot (clock failure injected at exact calls), "abandon never deletes another holder", "abandon whose own removal fails", the cool-down give-back |
| Exclusivity matrix and fire time | "a waiting scheduled reboot does not block funnel_enable or funnel_disable", "cancellation is never blocked by a Funnel change in flight", "... IS exclusive with update, plan, reboot now ...", "prohibited and allowed combinations from the other side", "fire time: ..." (Funnel waited for; not fired after `fireSlotWaitMs`; cancel while waiting; free slot; cancel-versus-fire), ORBIT: "exclusivity at the proposal", "cancelling ... not gated on the helper's open operations" |
| Plan timeouts | "plan timeouts: ORBIT waits at least as long as the plan runner may run", "boundaries", "when ORBIT gives up it says the plan is still running ...", "outstanding plan, then slot cleanup"; helper: "plan slot cleanup" |
| Host name validated at proposal | `test/ops-sys.test.ts`: "the helper's host name is validated at proposal time" (FQDN, upper case, underscore, edge lengths; no card, no plan call) |
| Honest restart claims | "no tier 3 code or unit claims services are never restarted"; card text asserted in "OS update proposal: the helper makes the plan first" |
| Digest vs click | "the docs state what the digest is and is not" |
| Cool-down | "cool-down counts reboots actually ISSUED ...", "cool-down starts when the reboot is issued ... survives record pruning ... checked while holding the slot", "cool-down and schedules" |
| OS update plan | plan runner: success, nothing pending, busy/failed refresh, failed/timed-out/malformed simulation, removals, new packages, 151 packages; strict parser incl. injection-shaped versions; digest sensitivity to any package/version change; flags; execution: stable plan verified, drift refused **before any install** (new version, extra package, package gone, nothing pending, wrong digest), policy and malformed output at execution, lock contention without kill/unlock, version mismatch after upgrade = `unverified`; ORBIT: card lists every package, flags, binds the digest, dispatches `planDigest`, refuses on every bad plan, polls a slow plan, gives up on a stuck one |
| Scheduled reboot | time validation (canonical form, 60 s/2 min minimum, 24 h maximum, edges), digest binds the time, `scheduled` state and persistence, duplicate = busy/replay, fire only at the time with exactly one `systemctl reboot` and no command during the wait, expiry only at acceptance, ORBIT proposal/confirm/410 when the time can no longer be honoured, cool-down interplay, dead runner settled as `interrupted` with "NO reboot was issued", ORBIT restart keeps the ledger |
| Cancellation | cancel before fire (record, audit, ledger, idempotent, slot freed, a later runner does nothing and does not overwrite), cancel during the wait, cancel after fire = `too_late` and not recorded as cancelled, both race orders with gates (cancel paused while the runner claims; runner paused while the cancel wins), immediate reboot cancellable until claimed, non-reboot/unknown/ended refused, ORBIT never reports success on `too_late` or an unreachable helper |
| Tier 1/2 byte identity | `test/tier12-pin.test.ts` |

Not proven by any of this: that the units work under their sandboxes, that real `apt-get -s upgrade` output parses (the parser is written to the documented format and tested on samples written by hand), that `systemctl reboot` works from the reboot unit, that the 24-hour unit wait survives on a real systemd, that tailscale behaves as assumed, or anything about OpenClaw.

## Review follow-up 2: mutation evidence

Finding 1 asked that the stale-slot race tests fail if `retireSlot` regresses to read-then-unlink. The existing tests did **not**: both passed against the mutant, because their interleaving only paused contenders at the stale-holder check, before `retireSlot` ran. The new tests use `slotHooks.afterRead` (a test seam in `sys-core.ts`, unset in production) to run a rival retirement and a takeover *between the late contender's read and its removal*.

Procedure (done once, with the file restored byte-for-byte afterwards; the restored sha256 was checked against the pre-mutation copy, and `grep MUTATION src/ops/sys-core.ts` finds nothing):

1. Replace the body of `retireSlot` with `if (readSlot(c, lane) !== holderId) return false; rmSync(lanePath(c, lane), { force: true }); return true;`.
2. Run `node --test --test-name-pattern="retireSlot race|takeover race end to end|stale slot|replacement holder" test/ops-sys-helper.test.ts`.

Result with the mutant:

```
ok 1 - stale slot: two simultaneous requests that both saw the stale holder cannot both take over: at most one dispatch
ok 2 - stale slot: a request that saw the stale holder must not delete the replacement holder's slot when it resumes late
not ok 3 - retireSlot race: a late contender whose read is interleaved with a retirement AND a takeover removes nothing (fails for read-then-unlink)
not ok 4 - takeover race end to end: a contender paused between reading the dead holder and removing it cannot delete the replacement; it is refused, nothing of its own dispatched
# tests 4  # pass 2  # fail 2
```

(test 3's failure: `true !== false`, the late contender removed a slot it was not entitled to remove). Result with the correct implementation restored: `# tests 4  # pass 4  # fail 0`.

Limitation: this proves the tests detect that one mutation (check-then-unlink without the marker); it is not a general mutation-testing run, and the slot tests use real files in a temp directory on one machine, not a live host.

## Installation prerequisites

Nothing is installed by this change and nothing here was done. When Rai separately approves installation (see the exact commands in the job summary, which are derived from `deploy/install-sys.sh`):

- Tiers 1 and 2 installed (`/usr/local/lib/orbit/ops` exists, group `orbit-ops` exists and `orbit.service` is in it).
- `/usr/local/bin/node` (same node as `orbit.service`), `/usr/bin/systemctl`, `apt-get`, `dpkg`, `dpkg-query`, `flock`; `/usr/bin/tailscale` for Funnel only.
- This follow-up adds **one unit** (`orbit-ops-sys-plan@.service`) and changes `orbit-ops-sys-reboot@.service` (`TimeoutStartSec=26h`) and `orbit-ops-sys-update@.service` (comments only). `install-sys.sh` copies all of them; it does not start any runner and does not restart ORBIT.
- If Tier 3 from PR #40 were ever installed already, re-run `install-sys.sh` to pick up the new files; the socket restart is the only service action.
- Before relying on a scheduled reboot, check the host's other reboot sources (unattended-upgrades `Automatic-Reboot`, provider maintenance): they are invisible to the cool-down.

## Future live acceptance of the follow-up

**Separate from the stages above, and each stage needs Rai's separate approval. None of it has been done.** Same preconditions: quiet time, no active jobs, a second SSH session, provider console access. Stop at the first surprise.

- **F1 Plan only.** Ask ORBIT to propose an OS update and do not confirm. Check on the host: the plan unit ran (`journalctl -u 'orbit-ops-sys-plan@*'`), `apt-get update` refreshed the lists, no package changed (`/var/log/apt/history.log`), the card matches `apt-get -s upgrade` run by hand, flags are right, and the slot is free afterwards.
- **F2 Plan drift.** Propose, then change the lists by hand (`apt-get update` after upstream moved, or pin a version in a test setup), confirm: expect a refusal naming a changed plan and no install.
- **F3 Scheduled reboot, cancel.** Schedule 10 minutes ahead; verify the runner waits without holding `deploy.lock` and a Tier 2 deploy is not blocked; cancel; verify no reboot, record `cancelled`, journal audit line.
- **F4 Cancel too late.** Schedule 3 minutes ahead (after the proposal minimum), cancel only after the time: expect `too_late`, a reboot, and the ledger not `cancelled`. Needs the reboot preparations.
- **F5 Cool-down.** After F4, a reboot proposal inside 30 minutes must be refused; a proposal whose scheduled time is more than 30 minutes after the first must be accepted.
- **F6 Restart persistence.** Schedule a reboot, restart `orbit.service`, confirm the ledger shows it and cancel still works.
- **F7 Uninstall guard.** With a scheduled reboot pending, `uninstall-sys.sh` must print the "SCHEDULED REBOOT WILL STILL FIRE" warning.

