# Host inventory: one read-only, fixed-scope action (implemented, NOT installed, NOT activated)

`host_inventory` is an eighth fixed action on the existing read-only `orbit-ops` helper, with one owner-only chat tool,
`ops_host_inventory`. It reports how ORBIT is deployed on its host: service identities, sandbox settings, helper boundaries,
ownership and mode of a fixed list of paths, mount flags for those paths, and deployment separation.

**Status.** Code and tests only, written against synthetic fixtures on a cloud runner, which is not the production host. Nothing here
has been installed or activated or run on a live host, so there is **no live evidence that it works**. Every claim below is about the
code. Turning it on needs the separate activation review in section 5. That review has not been done, and this document does not
authorize it.

It implements the inventory prerequisite (gate G2) from `docs/reviews/host-inventory-handoff.md`, following the section design in
`docs/reviews/launch-reconciliation.md` section 6. It adds no file tools, exec, patches or session reader.

## 1. Shape

| Piece | Where | What it does |
|---|---|---|
| Action name | `src/ops/protocol.ts:12` | `host_inventory` added to `ACTIONS`. The request is `{"action":"host_inventory"}`. Any other key is refused by the same `parseRequest` before anything runs |
| Activation constants | `src/ops/protocol.ts:15-20` | marker path `/etc/orbit-ops/host-inventory.enabled`, and the `disabled` / `unsupported` messages |
| Gate and dispatch | `src/ops/helper.ts:340-363`, case at `:381` | checks the marker and the module (both must be root-owned and not group/world-writable, and neither may be a symlink), then loads `./inventory.ts` with a fixed literal import. Otherwise it answers `disabled` or `unsupported`. It never falls back to anything else |
| Inventory | `src/ops/inventory.ts` | fixed lists (`SPEC`, `:31`), one `systemctl show` (`:307`), lstat walked one component at a time (`inspectPath`, `:197`), `/etc/group` (`readGroups`), mountinfo (`parseMountinfo`, `mountFor`), derived separation (`deriveSeparation`), output bound (`fitToBound`) |
| Chat tool | `src/host-inventory.ts` | `ops_host_inventory {section?, part?}` over the existing `opsClient` (`d.ops.call("host_inventory")`, no arguments sent). Overview, section pages, a comparison with the repository's unit files, and explicit status mapping (`classify`) |
| Wiring | `src/main.ts:253`, `src/server.ts:117`, `:479` | the tool goes into the owner's tool list only when `ORBIT_HOST_INVENTORY=enabled` |
| Tests | `test/host-inventory.test.ts` (30 tests) | see section 8 |

The transport is unchanged: the kernel decides who may connect (`/run/orbit-ops.sock`, `root:orbit-ops 0660`), the helper runs in
`orbit-ops@.service`'s existing sandbox, and the helper's request size limit, 32 KiB response cap, redaction and audit line all
apply. The audit line records only the action, outcome, error code, bytes and milliseconds, never the response.
`docs/orbit-ops.md` is otherwise unchanged. The pins in `test/tier12-pin.test.ts` and `test/ops-admin.test.ts` were deliberately
updated for `helper.ts`, `protocol.ts`, `docs/orbit-ops.md` and `test/ops-admin.test.ts`. `test/ops.test.ts`, `chat-tools.ts`, the unit
files and every installer are byte-identical.

## 2. Fixed scope (nothing else is inspected)

All lists are in `src/ops/inventory.ts` `SPEC`. A test checks the unit lists against `deploy/systemd/`.

* **Units:** the 13 service units and 3 socket units in `deploy/systemd/`.
* **Properties** (`ALL_PROPS`):
  * identity: `LoadState`, `ActiveState`, `SubState`, `User`, `Group`, `DynamicUser`, `SupplementaryGroups`, `UID`, `GID`;
  * sandbox: `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `PrivateNetwork`, `NoNewPrivileges`, `RestrictSUIDSGID`,
    `CapabilityBoundingSet`, `AmbientCapabilities`, `RestrictAddressFamilies`, `ReadWritePaths`, `ReadOnlyPaths`, `StateDirectory`;
  * socket: `SocketUser`, `SocketGroup`, `SocketMode`, `Accept`, `MaxConnections`;
  * `MainPID`, for `orbit.service` only, used inside the helper and never returned.

  No `Environment*`, `Exec*`, credential or fragment property is requested. If systemctl prints one anyway, it is dropped.
* **Groups:** `orbit-ops`, `orbit-vault`. The answer gives each one's GID and a count of explicit members, never member names.
* **Paths:** `/opt/orbit` and its `current`, `releases`, `repo`, `vault` and `state` entries; `/usr/local/lib/orbit` and its `ops`
  directory; `/var/lib/orbit`; `/var/lib/private/orbit`; the three helper sockets; and the root-run code files under
  `/usr/local/lib/orbit` (metadata only, never opened).
* **Mounts:** `/proc/1/mountinfo` (the host's view) and `/proc/<orbit MainPID>/mountinfo` (the ORBIT service's view). For each
  approved path the answer gives only the holding mount point (an ancestor of that path), the `ro`/`nosuid`/`nodev`/`noexec` flags, and
  the filesystem type from a fixed list. It never gives device or source names. The PID is checked again after the read, and if it
  changed, that view is dropped.

## 3. What comes back, and how to read it

Every section has `origin`, `source`, `observedAt`, `complete`, `unavailable[]`, `warnings[]` and `items[]`.

| `origin` | Meaning |
|---|---|
| `systemd-loaded` | what systemd has loaded, drop-ins included. **This is configuration, not proof of enforcement.** The sandbox section says so in every answer |
| `host-observed` | seen on the host: lstat metadata, `/etc/group`, mount flags |
| `derived` | worked out from the observations above. `deploymentSeparation` names its inputs for each path. Only `read-only-mount-observed` is an observed, effective restriction. `not-writable-by-mode` ignores ACLs, capabilities and other namespaces. A missing input gives `not-established` and `complete: false`. **Missing evidence is never a pass** |
| `repo-declared vs systemd-loaded` | (`declaredVsLoaded`, on the ORBIT side) the repository's unit files in the running release, compared setting by setting. Drift is reported, not fixed. A setting the repository leaves undeclared is counted, not compared |

The tool's statuses:

* `ok`
* `disabled`: the host is not activated.
* `unsupported`: the helper predates `host_inventory`, or the module is missing or unsafe.
* `unavailable`: there is no socket, no permission, a timeout, or an answer of the wrong shape.

A status other than `ok` carries `observedAt: null` and says that no host facts were obtained. With no arguments the tool returns an
overview. `{section, part}` returns one page of a section. Each page stays under 5,000 characters, so it reaches the model whole, and
each call is a fresh observation.

## 4. Data minimization and bounds

* **No caller input.** The helper action takes no arguments. The tool's `section` and `part` are a closed enum and an integer, used
  only to choose a page of the one fixed answer. No path, unit, command, environment or shell text is accepted at any layer.
* **Values must pass a shape check.** Each property has its own check: names, capability tokens, `AF_*` tokens, absolute paths without
  `..`, and short words. Anything else becomes `[unrecognised]` with a warning. A capability set of 30 or more is summarized as a count.
* **Symlinks:** lstat only, walked one component at a time from `/`. An ancestor that is a symlink makes the path `denied` (fail
  closed). A final symlink is reported as a symlink, and its target only if it matches an approved shape: `releases/<40-hex>` for
  `current`, and `private/orbit` for `/var/lib/orbit`. Non-canonical paths (`..`, `.`, `//`) are denied.
* **No listing, no contents.** No `readdir`, and nothing is opened except `/etc/group` (64 KiB cap) and the two mountinfo files
  (256 KiB cap each). A truncated read makes its section incomplete.
* **Time.** There are at most two `systemctl` processes, each with the helper's 5 s timeout and `shell: false`. No subprocess starts
  more than 1.5 s into the request, so the answer stays inside ORBIT's 8 s client timeout.
* **Size.** The answer is at most 24 KiB. Over that, whole sections are dropped, starting with the least important, and each dropped
  section is marked with the reason. The helper's own 32 KiB cap and redaction still apply.
* **Errors** give a short fixed reason. They never include systemctl's stderr or raw data.

## 5. Activation: off by default, separate review required (NOT done)

Two independent switches, both off after any merge, deploy or `install.sh` run:

1. **Host (root).** The helper answers only while `/etc/orbit-ops/host-inventory.enabled` exists. It must be a regular file, not a
   symlink, root-owned and not group/world-writable, in a directory with the same properties. Its contents are never read. The module
   `inventory.ts` must also sit next to `helper.ts`, root-owned. `install.sh` copies only `helper.ts` and `protocol.ts`, and no file under
   `deploy/` mentions the module, the marker or the flag (a test checks this). A normal deploy never changes root code.
2. **ORBIT.** The tool is offered only with `ORBIT_HOST_INVENTORY=enabled`, and exactly that value. It is not one of the five settings
   the tier 2 config proposal can change, so only someone editing `orbit.env` as root can set it.

**Kill switch:** remove the marker. The next request answers `disabled`, and no restart is needed. Unsetting the flag and restarting
ORBIT removes the tool.

**Activation review (owner, separately confirmed; none of this has been run):**

1. Review and merge this change. The normal deploy changes only ORBIT's side, and the tool stays off.
2. Security review of this action before activation (see section 7). In particular:
   * can the root helper read `/proc/1/mountinfo` and `/proc/<pid>/mountinfo` of a DynamicUser process under `CapabilityBoundingSet=CAP_DAC_READ_SEARCH`?
   * does this systemd accept `systemctl show` for template names (`orbit-ops@.service`)?
   * does it report `UID`/`GID` for running services?

   If the answer to any of these is no, that section reports `unavailable` (tested). It is not a failure of the whole action.
3. On the host, as root, from the live release:
   * re-run `install.sh` as documented in `docs/orbit-ops.md`, so the helper has the dispatch. This restarts ORBIT, as `install.sh`
     always does;
   * `install -m 644 -o root -g root /opt/orbit/current/src/ops/inventory.ts /usr/local/lib/orbit/ops/`;
   * `install -d -m 755 -o root -g root /etc/orbit-ops && install -m 600 -o root -g root /dev/null /etc/orbit-ops/host-inventory.enabled`.

   Before the marker exists, `printf '{"action":"host_inventory"}\n' | sudo socat - UNIX-CONNECT:/run/orbit-ops.sock` must answer `disabled`.
4. Set `ORBIT_HOST_INVENTORY=enabled` in `orbit.env` and restart ORBIT.
5. Run it once and reconcile the results against the repository's declarations (gate G4). Results stay in ORBIT's private chat. They
   are never put into repository fixtures or docs.

## 6. Not observed by this action (owner gates)

* Kernel enforcement of sandbox settings, beyond the mount flags seen in the ORBIT service's namespace.
* The sandbox of units that are not running. Templates run one instance per connection, and instance names are not listed.
* ACLs, file capabilities and LSM policy.
* Secrets, credentials and their metadata, environment values, process arguments, `orbit.env` and unit file text. Credential
  presence remains the existing `ops_credentials` action.
* **OpenClaw and raiclaw.** No approved list of their units, installation, workspace or session paths exists in this repository, so
  nothing about them is inspected. Adding them needs the owner's decision on which paths are readable (plan decision "which exact
  directories and session collections are readable"), followed by a separate change.
* Tailscale ACLs, and anything outside the fixed lists.

## 7. Staged rollout and future capability design (not implemented)

The owner's plan is followed in its order: research and inventory, then a read-only pilot, isolated commands, controlled writes,
production actions, and finally terminal and remote hosts. Each stage has its own review. The plan's release gate is demonstrated OS
isolation with negative-test evidence, not happy-path commands.

1. **Merge, review and install** this inventory through the normal deployment, plus the manual helper step in section 5.
2. **Run it on the target and reconcile** what it finds with the repository's declarations. Drift is a finding.
3. **Security review with the full research.** The research report has not been available to any implementing job. Its findings are
   unknown here and are not assumed. This gate is open, and it comes before any file tool is designed.
4. **Scoped `fs_list`, `fs_stat`, `fs_read`, `fs_search`** under explicitly approved, non-secret roots.
5. **Isolated, non-interactive exec lifecycle** (start, status, bounded output, cancel).
6. **Exact-hash approved patches.**

**Design constraints for stages 4 to 6:**

* **Worker.** A separate unprivileged worker with no ambient production secrets, and roots and CPU, memory, process, output, disk,
  time and network limits enforced by the OS.
* **Denied paths.** Deny `/proc`, devices, sockets and credential paths, and every traversal, symlink, mount or check/use-race escape.
* **Broker.** The broker owns policy, audit and approval stores, and the worker cannot change them.
* **Approvals.** Single-use and expiring, and bound to the exact target, identity, request, content hash, environment, network policy
  and limits.
* **Failure.** Fail closed on any audit, auth or sandbox failure. A mutation with an unknown outcome is reconciled, never retried
  automatically.
* **Root.** Root operations stay narrow, named helper actions.

## 8. Tests (`test/host-inventory.test.ts`)

| Area | Tests (line) |
|---|---|
| Unsupported arguments; command and path injection in keys, values and the action name | 175 |
| Default-off activation: unsafe markers and directories; missing, unsafe or broken module; no deploy file installs or enables it; exact flag value | 196, 206, 226, 258 |
| Dispatch, and the response and size bounds | 246 |
| Provenance and completeness on every section | 275 |
| Fixed queries only: exact `systemctl` argv, fixed lstat set, no listing, statfs or tailscaled | 291 |
| Allowlisted, shape-checked fields | 310 |
| Secret suppression (fakes generated at runtime), environment and arguments, member names, device and source names | 330 |
| Symlink boundary (fake filesystem and a real temp filesystem) | 343, 361 |
| Mount matching | 388 |
| Derived separation; missing evidence is not a pass | 407 |
| Missing units, sections and permissions, partial systemctl output, timeouts | 438 |
| PID reuse | 478 |
| Time budget, input caps, section drop | 487 |
| No write, exec or open path; no generic access | 518 |
| Tool schema and argument refusal | 552 |
| Overview and paging | 571, 585 |
| Repository vs loaded comparison | 604, 625 |
| Explicit `disabled`, `unsupported` and `unavailable` statuses, including over a real unix socket with an old helper | 632, 655 |
| Owner-only policy | 679 |
| Absent from `chatTools` | 693 |
| Through the real server: owner offered and allowed, non-owner gets no tools, not offered when not activated | 750, 769 |

## 9. Known limitations and open questions

* No live evidence. In particular, it is unknown whether the helper sandbox can read the two mountinfo files and whether systemd
  shows template units and `UID`/`GID` as assumed. Each of these degrades to `unavailable`.
* `systemctl show` reports configuration. The only effective restriction observed is the mount flags in ORBIT's namespace.
* Fallback route: when the OpenRouter fallback is armed, it is offered the owner's whole tool list (`src/fallback.ts`), so it would be
  offered this tool too. The owner gate is in the server, not in the model. Checking this is part of the separately approved fallback
  enforcement audit (`docs/reviews/host-inventory-recovery-handoff.md` section 5), which has not been started.
* Check/use races: an lstat-only, metadata-only read cannot be made to read content through a race. A race can only make the answer
  stale, and each part carries its observation time.
* Duplicate risk from the earlier launch `orbit-202611180118-hcey` was accepted by the owner for this job. Its outcome is still unknown,
  and this job did not change its records.
