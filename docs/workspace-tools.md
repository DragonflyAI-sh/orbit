# Workspace tools: confined files and sandboxed commands (implemented, OFF, NOT activated on any host)

ORBIT's first local filesystem and command tools. They work only inside dedicated workspaces that the operator configures. Reads
are owner-only and run directly. Every write, patch and command is a **proposal** that Rai confirms on a card. Commands run in a
separate, unprivileged bubblewrap sandbox. It has no network, no host state and no ORBIT credentials, and the workspace is the only
place it can write.

**Status.** This is code and tests only. It was written and tested on cloud runners, not on the production host. Nothing has been
installed, enabled or run on a live host. The capability is **off by default**: merging or deploying this code turns nothing on.
Turning it on is now an owner-approved path **on the existing ORBIT host** (section 9): a read-only preflight, an owner-confirmed host
setup by a separately installed root helper, a bounded synthetic validation under the production sandbox, and a separately confirmed
enable. None of these steps has been run anywhere. The real-sandbox tests **did not run** on the cloud runners (section 8), so OS
isolation is **unverified** until the on-host validation passes. Designing the isolation is not proving it.

Code: `src/workspace/config.ts` (activation and operator configuration), `fsops.ts` (operation-time file confinement), `sandbox.ts`
(the bubblewrap launcher, probe, limits and supervision), `ledger.ts` (durable operation records), `service.ts` (tools, proposals,
confirmation, queue, recovery), `select.ts` (production wiring). The integration points are the `workspace_op` proposal kind
(`src/agent.ts`), the `workspace_op` card kind (`src/threads.ts`, `src/thread-service.ts`, `src/web/index.html`), the confirm and
cancel routes (`src/server.ts`), the `workspace` policy port (`src/policy.ts`) and `src/main.ts`.

## 1. What is (and is not) in this slice

| In | Not in |
|---|---|
| `workspace_list`, `fs_list`, `fs_stat`, `fs_read` (paged, versioned), `fs_search` (literal, bounded) | Any delete tool |
| `fs_write` (atomic, strict preconditions), `fs_patch` (exact unique matches, version precondition): proposals | Writing vault notes (the vault tools remain the only route) |
| `exec_start` (a proposal), `exec_status` (states, paged output), `exec_cancel` | Network access of any kind, from any command |
| Durable ledger, audit lines, restart recovery | Any change to the tier 1-3 `orbit-ops` helpers, their protocol, or their units |
| Default off; three activation layers (host permission, on-host validation, owner switch) | Host-wide changes: the cgroup hierarchy, kernel or AppArmor settings, reboots, other services, package removal |
| Named, owner-confirmed activation operations (section 9) and a separately installed host-setup helper (`docs/orbit-ops-ws.md`) | Installing that helper (an operator step, like tiers 1-3) |

OpenClaw and other external systems are not touched, read or integrated.

## 2. Architecture

```text
model tool call ──► server policy (agent.<tool>, workspace.<tool>: owner only) ──► workspace service
   reads: fs_list/stat/read/search ── confined walk (fsops) ── masked, marked untrusted ──► result
   writes/exec: validate ─► preview against the current state ─► HELD canonical op (memory) + card (digest) ─► "pending-confirmation"
                                                                                                    │
Rai: POST /chat/proposals/<id>/confirm {digest} ── owner (workspace.confirm) ── digest ── card origin ── take() + card CAS (single use)
                                                                                                    ▼
   service.confirm: held op present? digest(op) == card digest? card rebuilt == card shown? workspace identity unchanged?
      file op: workspace lock ─► precondition re-checked through the confined walk ─► atomic write ─► ledger completed/failed
      exec:    queued ─► slot + workspace lock ─► snapshot re-taken == reviewed snapshot? sandbox policy unchanged?
               ─► "starting" recorded ─► bubblewrap (cgroup + rlimits) ─► running (pid) ─► exit observed ─► completed/failed/cancelled
```

* **Activation** (`config.ts`, `activation.ts`, `admin.ts`, `select.ts`). Three layers, all required:
  1. **Host permission:** `ORBIT_WORKSPACE_TOOLS=enabled` **and** the JSON file named by `ORBIT_WORKSPACES_FILE` contains
     `"preActivationChecklist": "workspace-tools-host-setup-v2"` (both written by the host setup, section 9). ORBIT must also not be
     running as root, the platform must be Linux with `/proc/self/fd`, and ORBIT must have a state directory.
  2. **Validation:** a bounded synthetic validation passed under the production sandbox for the **current** policy hash, sandbox
     implementation and validation workspace, at most 24 hours old when enable is confirmed (`smoke.ts`), and not invalidated since.
  3. **Owner switch:** Rai confirmed `enable` on a card; `$STATE_DIRECTORY/workspace/activation.json` says `enabled` **and is bound**
     to that validation: its id and finish time, and the policy hash, sandbox implementation and validation-workspace identity it
     proved. A missing, unreadable or malformed file is **off**, and so is an `enabled` record without a complete binding.

  **The switch is re-checked against the running configuration every time it is read** (when the tool list is built, at every tool
  dispatch, at every confirmation and when a queued command starts; `activation.ts`). It reads as **off** unless the validation file
  still holds that same validation, still `passed` and not invalidated, and the running policy hash, sandbox implementation and
  validation workspace all equal the bound ones. A definite mismatch (the workspaces file was edited, bubblewrap changed, the
  validation was replaced or invalidated, the host permission is gone) also **writes the switch off** with the reason, so reverting the
  change later never brings it back. While the startup self-test has not finished, the sandbox implementation is not known yet: the
  switch reads as off for that moment without being reset. Startup logs `workspace-owner: <enabled|off> (<why>)` once the self-test is
  done.

  **Expiry.** A validation is evidence for **enable** for 24 hours after it finished (the enable card and its confirmation both refuse
  an older one). Once enabled, the switch does **not** expire by age: it stays on exactly as long as everything it is bound to is
  unchanged, across restarts too. Any change turns it off, and turning it on again needs a validation of the new state (at most 24 hours
  old) and a new enable confirmation.

  **Host changes reset it.** Confirming `setup` or `revoke` turns the switch off first (and drains queued and running commands) and
  invalidates the latest validation, before anything is sent to the root helper. A start with the host permission absent (revoked by
  the helper or by hand, or an invalid configuration) resets a recorded `enabled` to off and invalidates the validation. So "revoke, then
  setup again" always leaves the tools **off** until a new validation passes and Rai confirms enable.

  Without layer 1, `selectWorkspace` returns a service that offers **no tools** and refuses every confirmation. With layer 1 but the
  switch off, the service loads (status, recovery, validation and disable need it) but still offers the model **no workspace tool**
  and refuses every workspace confirmation. Startup log lines: `workspace-tools: <state> (<reason>)`, `workspace-cgroup: ...`,
  `workspace-sandbox: <supported|unsupported> (<reasons>)`.
* **What the model controls.** Only a workspace **id**, relative paths, file content, patch edits, argv, an optional script and a cwd.
  Roots, mounts, environment, identity, runtime, limits and sandbox policy come only from the operator's file. Unknown arguments are
  refused, including `env`, `limits` and `root`.
* **Owner only.** Tools are offered only in the owner's replies. The `workspace` port is checked again on every tool call and on every
  confirmation. Status and cancel read only the owner's own ledger.

## 3. Filesystem confinement (`fsops.ts`)

The boundary holds when the operation runs, not just when the path is checked. Every operation starts from a descriptor for the
workspace root. The root is pinned by device and inode at load time and checked on every open. The walk then goes one component at
a time:

* Each component is opened with `O_PATH | O_NOFOLLOW` relative to its parent's **descriptor** (`/proc/self/fd/<fd>/<name>`, which
  does the same lookup as `openat`). Then it is `fstat`'ed. A symbolic link at any depth is refused, and so is a component on another
  device. An intermediate component must be a directory. Nothing is resolved by name a second time. There is no realpath check.
* **Mounts.** The walk refuses a component on another device. Each operation also reads `/proc/self/mountinfo` and refuses the whole
  workspace if any mount point lies inside it. This catches bind mounts from the same device.
* **Special files.** `O_PATH` never opens the file itself, so a FIFO or device is never opened, not even for the check. Reads and
  writes accept only regular files. FIFOs, sockets and devices are reported as such by list and stat, and search skips them.
* **Hard links.** A regular file with more than one link is never read, written or versioned.
* **Content** is read by reopening the pinned descriptor (`/proc/self/fd/<O_PATH fd>`), and the device and inode are checked again.
  The check and the use always refer to the same inode.
* **Paths.** A path must be relative, with no `..`, `.`, empty components, control characters or backslashes. It may have at most 32
  components, at most 255 bytes per component and at most 1024 characters. `/proc`, absolute paths and links to them are unreachable.
  These lexical checks are only a first filter: the walk is the actual boundary.
* **Atomic writes.** The new content goes into a temporary file in the target's own directory (`O_CREAT|O_EXCL|O_NOFOLLOW`, mode
  `0600`), which is fsynced. A new file is placed with `link()`, which fails atomically if anything already exists at that name. A
  replacement is placed with `rename()` over the checked version. Then the directory is fsynced. Only the owner's mode bits are kept
  (`mode & 0700`), so setuid, setgid and group/other bits never survive. If a write fails, its temporary file is removed.
* **Versions** are `sha256:<hex>` of the whole file, up to 16 MiB. Larger files have no version and cannot be written or patched.
  `fs_write` needs exactly one of `expectedVersion` or `createOnly: true`. `fs_patch` needs `expectedVersion`, and each `find` must
  occur exactly once, applied in order. Otherwise nothing is written.
* **Concurrency with exec.** File writes and patches take the workspace's exclusive lock. A running command holds the same lock. A
  write confirmed while a command runs in that workspace fails with `workspace_busy`. ORBIT's own operations are serialized by that
  lock. A command can create, rename or link files in the workspace while a **read** runs. The descriptor walk keeps reads inside the
  boundary anyway (tested with a concurrent symlink-swap attack). The worst case is a stale page, and its version then fails any later
  write.

## 4. Exec isolation (`sandbox.ts`)

Commands are launched through one fixed interface. ORBIT builds the arguments from the operator's file and the approved operation.
The model's argv appears only after `--`, as the command to run inside the sandbox. The launch chain is:

`/bin/sh -c '<fixed cgroup wrapper>' <run cgroup> → prlimit <rlimits> -- → bwrap <fixed options> -- <argv>`

* **Namespaces.** User, PID, network, IPC, UTS and cgroup namespaces are all new (`--unshare-*`; `--unshare-cgroup` is required, not
  `-try`, so a kernel without cgroup namespaces fails the self-test). `--disable-userns` blocks nested
  user namespaces, and `--uid/--gid 1000` makes the command an unprivileged user inside. bubblewrap must not be setuid, and ORBIT
  refuses to launch at all when running as root.
* **Privileges.** `--cap-drop ALL` drops all capabilities. no_new_privs is always set by bubblewrap. `--new-session` gives the
  command no controlling terminal. `--die-with-parent` is set.
* **Network.** The network namespace is private and contains only its own loopback. Host interfaces and host loopback services
  (ORBIT's own HTTP port, helper sockets, other daemons) are unreachable, and abstract unix sockets are separated too. There is no
  proxy and no exception.
* **Filesystem view.** The root is a fresh tmpfs, remounted read-only. It contains:
  * the operator's runtime, read-only. It may only be `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64` or `/libx32`, each
    root-owned and not group/other-writable, and merged-`/usr` links are recreated as links;
  * a synthetic `/etc/passwd` and `/etc/group`, and the approved script at `/run/orbit/script`, all read-only;
  * a private `/proc` and a minimal `/dev`;
  * `/tmp`, a tmpfs bounded by `tmpBytes`;
  * the workspace at `/workspace`, which is the **only** writable host directory.

  Nothing else of the host is mounted: no `/etc`, `/home`, `/var`, `/run`, `/opt`, ORBIT state, vault copy, credentials, sockets or
  devices.
* **Environment.** `--clearenv`, then a fixed set: `PATH`, `HOME=/workspace`, `LANG=C.UTF-8`, `TMPDIR=/tmp`, `USER`, `LOGNAME`.
  The launcher itself is spawned with an empty environment.
* **Limits.**
  * Aggregate limits per run come from a new **cgroup v2** child of the operator's delegated cgroup: `memory.max`, `memory.swap.max=0`,
    `pids.max` and `cpu.max` (one CPU). The wrapper moves itself into that cgroup before it execs, so nothing the run starts can be
    outside it. tmpfs pages (`/tmp`, `/dev/shm`) are charged to the run's memory.
  * Per-process rlimits: CPU seconds, address space, file size, open files, no core files. `RLIMIT_NPROC` gets a margin and is only
    a backstop.
  * Wall-clock timeout. stdout and stderr are each capped at `outputBytes`, and anything beyond is dropped and reported as truncated.
  * Workspace storage is bounded by the workspace being its own mount: an exec workspace must be a dedicated filesystem, no larger
    than `workspaceBytes`, mounted `nosuid,nodev`.
  * Concurrency: `maxConcurrentRuns` (1 to 4, default 1) runs at once overall, and one per workspace through its lock.
* **Cleanup.** On exit, timeout or cancel, ORBIT sends `SIGKILL` to bubblewrap. Its init dies, and the kernel kills every process in
  the PID namespace. ORBIT then writes `cgroup.kill`, waits (asynchronously, up to about one second) until no listed process still
  exists, and removes the cgroup. `treeGone` is true only on that evidence. **A launched run without it pauses exec**
  (`cleanup_unverified`): no command starts anywhere until a later reap (one re-check two seconds later, then at every ORBIT start)
  finds that run's cgroup gone or empty and records `cleanupVerifiedAt`. If ORBIT itself dies, `--die-with-parent` tears the
  namespace down, and recovery at the next start kills whatever is left in the cgroups of runs that were in flight. The validation
  runs (`validation-runs/ledger.json`, including the launcher's direct wall-clock run and the final cleanup run) count the same: the
  main service reads that ledger (read-only), so an unverified cleanup there pauses exec, blocks validate and enable, and fails the
  validation's own `no_cleanup_quarantine` check, which is judged after the last run. Recovery at a start covers that ledger too; an
  unreadable one counts as unverified.
* **Run ids and paths.** Run ids are ORBIT's own (`ws-` + 16 hex; `probe-` + 16 hex). A ledger entry with any other id makes the whole
  ledger untrusted (tools off, file untouched). Every run directory and cgroup path is checked to be a direct child of its parent
  before it is created, killed or removed, so a tampered ledger cannot aim cleanup anywhere else.
* **No fallback.** At startup ORBIT probes:
  * bubblewrap must offer every required option;
  * `prlimit` must be present;
  * the delegated cgroup must enable `memory pids cpu` for its children and must be writable;
  * while any probe runs, the sandbox state is `unknown` and nothing but the self-test itself can launch. Probes are serialized and
    generation-pinned: only the newest one sets the verdict. A probe that throws is `unsupported` with the error, never stuck;
  * a live self-test must run a command in the sandbox. That command checks its uid, network interfaces, PID namespace, environment,
    `CapEff`/`CapBnd` zero, `NoNewPrivs: 1`, a private cgroup namespace, that a nested user namespace is refused (when `unshare`
    exists in the runtime), that host paths (ORBIT state, credentials, `/etc/shadow`, `/home`, `/root`, `/var`, `/opt`) are hidden, and
    that the runtime is read-only. The run cgroup's limits are read back after they are written, and the self-test's own process tree
    must be confirmed gone.

  Any failure makes the sandbox `unsupported`: `exec_start` refuses and nothing runs. The sandbox is re-checked when a run is
  confirmed and when it starts. No other launcher exists, and every model path uses this one backend (section 6).

Commands are arbitrary code inside this boundary. argv and the script are not filtered: the boundary is the sandbox, not the
command text.

## 5. Tool schemas

Every tool's arguments are strict: unknown keys are refused, and `null` counts the same as a left-out argument. `workspace` is an
operator-configured id matching `^[a-z0-9][a-z0-9-]{0,31}$`.

| Tool | Arguments | Result (main fields) |
|---|---|---|
| `workspace_list` | none | `workspaces[{id, exec}]`, `sandbox{state, checkedAt, reasons}`, `limits` |
| `fs_list` | `workspace`, `path?`, `cursor?`, `limit?` (max 200) | `entries[{name, type, size?, nlink?, mount?}]`, `total`, `nextCursor`, `omittedUndecodableNames?`; at most 10,000 names of one directory are read (`totalIsLowerBound: true` beyond) |
| `fs_stat` | `workspace`, `path` | `type` (file, dir, symlink, fifo, socket, char-device, block-device), `size`, `mode`, `nlink`, `modifiedAt`, `version` or `versionUnavailable` |
| `fs_read` | `workspace`, `path`, `offset?`, `length?` (default 8 KiB, max 16 KiB) | `text` (masked) or `binary: true`, `version` (whole file), `size`, `offset`, `bytes`, `nextOffset`, `truncated`, `masked?`, `untrusted: true` |
| `fs_search` | `workspace`, `query` (literal, 1-200 characters, one line), `path?`, `maxResults?` (max 100) | `matches[{path, line, text}]` (masked), `filesSearched`, `entriesVisited` (every entry counts, at most 2,000), `bytesSearched`, `complete`, `stoppedBecause?` (also after 3 s), `skipped{...}`, `untrusted: true` |
| `fs_write` | `workspace`, `path`, `content` (at most 20,000 bytes of text, so the whole card fits its 24,000-character budget), exactly one of `expectedVersion` or `createOnly: true` | `status: "pending-confirmation"`, `executed: false`, `proposalId`, `digest`, `expiresAt`, `warnings` |
| `fs_patch` | `workspace`, `path`, `expectedVersion`, `edits[{find, replace}]` (1-8) | the same proposal fields |
| `exec_start` | `workspace`, `argv` (1-64 strings, each at most 4096 characters), `script?` (at most 16,000 bytes, at `/run/orbit/script`), `cwd?` | the same proposal fields |
| `exec_status` | `runId?`, `stream?` (stdout or stderr), `offset?`, `length?` (max 16 KiB) | without `runId`: `proposals[{state: "proposal", ...}]` and the last 10 `operations`. With it: `operation{state, reason, exitCode, signal, killedBy, processTreeGone, output{...}, events[]}` and an `output` page (masked, `untrusted: true`) |
| `exec_cancel` | `runId` | `cancelled` / `cancelRequested` with the state. A running command is reported `cancelled` only after its exit is observed |
| `workspace_preflight` | none | read-only `checks[{id, status, detail}]`, the host helper's setup plan, the owner record, `nextStep` |
| `workspace_admin_propose` | `action`: `setup`, `validate`, `enable`, `disable` or `revoke` | the same proposal fields (a `workspace_op` card with a `ws_*` action) |
| `workspace_admin_status` | none | owner switch, host permission, sandbox, unverified cleanups, latest validation with every check, host operations, enable blockers |

**States** (`exec_status`):

| State | Meaning |
|---|---|
| `proposal` | An open card |
| `accepted` | Confirmed, nothing attempted yet |
| `queued` | Waiting for a slot or for its workspace |
| `running` | A sandbox process exists (pid) |
| `completed` | A file operation was applied, or a command exited on its own (with any exit code) |
| `failed` | Refused at run time (stale, busy, sandbox changed, not started) or killed by its timeout, with `reason` |
| `cancelled` | Withdrawn while queued, or killed by a cancellation with its exit observed |
| `uncertain` | ORBIT stopped while it was in flight. Its effect is unknown. It is never reported as success |

## 6. Confirmation semantics

* **Proposing does nothing.** Each mutating tool validates its arguments and previews them against the current state (version, or
  workspace snapshot). It then holds the frozen canonical operation in memory and opens a `workspace_op` card. **What Rai reads is
  what runs:** characters that are invisible or reorder text (bidi controls, zero-width and other format characters, C0/C1 controls
  other than newline and tab) are shown as visible markers such as `⟨U+202E⟩`, and every multi-line value (content, script, patch
  text) is fenced (`┌ begin (N lines, M bytes)` … `└ end`) with each line prefixed `│ `, so no line can pass for a card field or a
  warning. The digest still covers the exact original text. The card shows **every field the digest covers, in full** (including
  the full workspace identity and policy hash): the path and the whole content, every patch edit and the resulting version, the exact
  argv and script, cwd, clean environment, network `none`, sandbox implementation and policy hash, limits, and the reviewed snapshot.
  It also shows the mutation scope: "the command can create, change or delete ANY file in workspace X; nothing else". Nothing is
  ever clipped. An operation whose card would exceed 24,000 characters **as shown** (after escaping and fencing; for example a write of
  thousands of very short lines), or whose text the content filter flags as credential-shaped, is refused, and no proposal exists.
* **Binding.** The digest is SHA-256 over the canonical (sorted-key) JSON of the held operation. That operation includes the
  workspace id and identity. The identity is a hash of the id, root, device, inode, exec flag and the whole sandbox policy, including
  the limits. The confirm route checks, in this order:
  1. owner (the `jobs` and `workspace` ports);
  2. the digest. A wrong or missing digest leaves the card open;
  3. that the card's conversation is the proposal's own;
  4. single use: `take()` plus the card's compare-and-set.

  The service then checks that it still holds the operation (a restart or expiry loses it: `410`), that its digest matches, that
  the card rebuilt from it equals the card shown, and that the workspace identity is unchanged. A changed config, root or limit is
  refused.
* **Expiry and replay.** Proposals expire after 10 minutes. A confirmed or cancelled proposal cannot be confirmed again.
  Cross-owner, cross-session and cross-workspace substitutions, edits after confirmation and stale inputs are all refused (tested in
  `test/workspace-approvals.test.ts` and `test/workspace-server.test.ts`).
* **Snapshot strategy for exec.** The approval is bound to the workspace's **reviewed snapshot**. That is a digest over the root's own
  mode and every entry: path, type, mode and size, the content hash of each regular file, and the target of each link. It is bounded
  at 20,000 entries, 128 MiB, depth 64 and 15 seconds. A workspace too large for this cannot be used for exec. When the run starts, under the workspace lock, the
  snapshot is taken again. If **anything** differs (an edited script, a changed input, a mode change, a new file, or another run's
  effects), the run fails as `stale` and does not start. A changed executable or input therefore never inherits an earlier approval.
* **Backend enforcement.** Owner, digest, workspace identity, preconditions, snapshot, sandbox state and policy (again at dequeue, not
  only at confirmation) and the cleanup pause are all checked in the backend at run time. The model is never trusted for any of them. A tool's output, a file's content or a command's output can
  never change the sandbox policy or skip a confirmation.
* **Every model path is the same.** The primary model and the OpenRouter fallback get the same tool objects and the same
  server-side `allow` (`src/fallback.ts`). Calling a mutating tool from any path only proposes
  (`test/workspace-approvals.test.ts`: "every mutating tool, called directly ...").

## 7. Audit, privacy and retention

* **Audit lines.** Each proposal, confirmation, denial, invocation, result, cancellation and recovery is one JSON line on stdout
  (the journal): `{at, port: "workspace", event, kind, workspace, proposalId?, opId?, digest (prefix), detail}`. The details are
  states and error **codes** only: never error messages (they can echo model- or workspace-chosen names), and the workspace field is a
  configured id or `?`. File contents, script text, argv, paths and command output are **never** included (tested). Activation
  operations (`ws_*`) are audited the same way. The server
  also writes its usual `agent.<tool>` and `workspace.confirm:<action>` policy audit lines.
* **Ledger.** The ledger is `$STATE_DIRECTORY/workspace/ledger.json` (written atomically, mode 0600). Run output is stored in
  `output/<opId>.stdout|stderr` (mode 0600, at most `outputBytes` per stream). The 200 most recent finished entries are kept, and a
  dropped entry's output files are deleted with it. Deleting `$STATE_DIRECTORY/workspace` removes all of it.
* **Masking.** Content shown to the model or on cards goes through the vault content filter (masking by credential shape). Masking
  is defense in depth, not authorization. File and command output is marked `untrusted: true`, and the tool descriptions tell the
  model it is data, never instructions.
* **No secrets in workspaces.** A credential-shaped write, argv or script is refused. Service secrets are never copied anywhere:
  the sandbox has no ORBIT environment and no credential directory, and the probe checks this.


## 8. Tests (cloud runner) and what they do not prove

All of these use synthetic temporary directories. No production data or host is involved.

| File | What | Ran on the cloud runner |
|---|---|---|
| `test/workspace-fs.test.ts` | lexical rules; symlinks at every depth; hard links; FIFO and device; bind mount inside the workspace; root replaced; symlink-swap races on reads and writes; atomic write preconditions and modes; patch; paging, UTF-8 and binary; list and search bounds; snapshot sensitivity | yes, as root (one `lost+found` case skips as root) |
| `test/workspace-approvals.test.ts` | owner-only port; disabled refusal; propose, confirm, replay; tampering; stale input; confinement and unknown arguments; secret refusal; exec card and single run; concurrency; cancel; timeout; restart recovery; status paging; card-budget refusal after fencing | yes (supervision through a labelled test double; **not** isolation evidence) |
| `test/workspace-config.test.ts` | default off and the host acknowledgement; root rules; exec requirements; identity binding; fixed bubblewrap argv; self-test verdicts (including capabilities, no_new_privs, cgroup namespace, nested userns) | yes |
| `test/workspace-server.test.ts` | through the real server: model call, card, owner/digest/single use, results on the card | yes |
| `test/workspace-review.test.ts` | the independent review's startup-race regressions (R1-R9) and one regression test per fixed finding WS-R1 to WS-R14, driving the production launcher with stub binaries | yes (gating and supervision only, **not** isolation evidence) |
| `test/workspace-activation.test.ts` | owner switch (default off, corrupt is off, an unbound `enabled` is off); enable gating on a passing validation for the current policy; the binding (policy, sandbox, validation-workspace changes while enabled, a missing/replaced/failed/invalidated validation, restarts, age), revoke then setup, permission lost at a start, enable races; replay/tamper/stale refusal of activation cards; disable reporting (exit observed vs not); setup dispatched exactly as the plan key on the card; dispatch/refresh races and restart (reported exactly once); escaped helper text and cwd; preflight read-only and secret-free; the smoke harness against a well-behaved and a leaky scripted launcher, unverified cleanups of the last and the direct runs, shared quarantine; run-parent cgroup containment | yes (logic only, scripted launchers; **not** isolation evidence) |
| `test/ops-ws.test.ts` | the host-setup helper against a fake host (`docs/orbit-ops-ws.md`): concurrent and duplicate dispatch, crash recovery of reservations, replay after pruning, time budgets, partial-image recovery, the complete command surface | yes (no host was changed) |
| `test/workspace-sandbox.test.ts` | 11 **real sandbox** tests and a requirement gate | **SKIPPED**: the runner is root and has no delegated cgroup v2. **OS isolation is unverified here** |

The real isolation evidence is the **on-host validation** (section 9, step 4): it runs under the production sandbox where ORBIT runs,
and enable refuses without a passing record for the current policy. The full real-sandbox suite (fork bomb, memory exhaustion and
other adversarial cases) stays an **optional offline** check on a disposable machine, never on the production host:
`ORBIT_SANDBOX_TEST_REQUIRED=1 ORBIT_SANDBOX_TEST_CGROUP=<dir> node --test test/workspace-sandbox.test.ts` as a non-root user with a
delegated cgroup (runbook: `docs/reviews/workspace-tools-security-review.md`, section 7; `tools/workspace-sandbox-preflight/preflight.sh`
lists unmet requirements first).

## 9. Activation on the existing ORBIT host

This replaces the former "separate VM only" gate. Rai accepted bounded, owner-approved testing on the existing host. Every host change
is a separately confirmed named operation done by the root helper (or an explicit operator step); nothing is changed by a deploy or a
merge; the tools stay off until the owner enables them after a passing validation.

**What changes on the host, and what never does.** The setup plan (built by the helper from what it finds, shown on the card in full)
can: install the distribution's `bubblewrap` package if it is missing; create a static system user and group `orbit` (ORBIT's unit is
`DynamicUser=yes` without `User=`, so systemd names its user after the unit and, when a static user of that name exists, uses it: ORBIT
gets a stable uid that can own the workspaces, and systemd re-owns ORBIT's state directory at the next start); create two loop-mounted
ext4 filesystems from image files under `/var/lib/orbit-workspaces/` (`scratch`, 1 GiB, and `orbit-validation`, 64 MiB) mounted
`nosuid,nodev` at `/srv/orbit-workspaces/<id>` (root `orbit:orbit`, mode 0700); write `/etc/orbit/workspaces.json` (root:orbit 0640,
never overwritten if an operator changed it); and write the drop-in `/etc/systemd/system/orbit.service.d/60-orbit-workspace.conf`
(`Delegate=memory pids cpu`, `DelegateSubgroup=main`, `ReadWritePaths=-` for the two workspaces, and the host permission
`Environment=ORBIT_WORKSPACE_TOOLS=enabled ORBIT_WORKSPACES_FILE=/etc/orbit/workspaces.json`). Then `daemon-reload` and a restart of
`orbit.service` only. It **never** changes the host's cgroup hierarchy, kernel or AppArmor settings, reboots, restarts or touches any
other service, removes a package, reformats an existing image or deletes workspace data. If the host needs any of those (cgroup v1,
`systemd` older than 254, unprivileged user namespaces disabled, `kernel.apparmor_restrict_unprivileged_userns=1` without a bubblewrap
profile), the plan lists it under **"NOT done by this (needs separate operator approval)"**, and exec stays unavailable until an
operator decides.

At start, ORBIT (unprivileged) creates its run-parent cgroup `<orbit.service cgroup>/workspace-exec` **inside its own delegated unit
cgroup only** and enables `memory pids cpu` for its children (`src/workspace/cgroup.ts`); a layout that does not match is left alone.

### The shortest operator sequence

Each step names who does it. Chat steps are owner-only; "card" means the `workspace_op` card in the thread; nothing happens without
Confirm.

1. **Deploy the app (normal).** Merge; the deploy timer puts the ORBIT side live. Effect: none. The workspace tools stay off; the admin
   tools appear only once the helper socket exists or the host permits the tools.
2. **Install the host-setup helper (operator, root, once; a deploy never does this):**
   ```bash
   sudo test -f /opt/orbit/current/deploy/install-ws.sh && echo "release contains orbit-ops-ws"   # must print this
   sudo /opt/orbit/current/deploy/install-ws.sh --approved-by-owner
   ls -l /run/orbit-ops-ws.sock                 # srw-rw---- root orbit-ops
   systemctl is-active orbit-ops-ws.socket      # active
   ```
   Full verification and the read-only socket checks: `docs/orbit-ops-ws.md`. It does not restart ORBIT and changes nothing else.
3. **Preflight (chat, read-only):** "run the workspace preflight". Read `nextStep`, the plan and any operator-approval items. If there
   are any, stop here: they are host-wide decisions outside this path.
4. **Setup (chat → card → Confirm).** "propose the workspace host setup". Check every step on the card (each is shown verbatim), then
   Confirm. ORBIT restarts after a short while; the notification "Workspace host setup verified" (or the failing step) follows. Check
   on the host:
   ```bash
   systemctl cat orbit.service | grep -A6 60-orbit-workspace     # the drop-in
   findmnt -no SOURCE,OPTIONS /srv/orbit-workspaces/scratch      # a loop device, nosuid,nodev
   ps -o user= -p "$(systemctl show -p MainPID --value orbit.service)"   # orbit
   sudo journalctl -u orbit.service -n 80 --no-pager | grep -E 'workspace-(tools|cgroup|sandbox)'
   #   workspace-tools: enabled (host permits them; owner switch off)
   #   workspace-cgroup: ready (...)
   #   workspace-sandbox: supported        (anything else: the reasons say what is missing; do not continue)
   ```
5. **Validate (chat → card → Confirm).** "propose the workspace validation". The card lists the fixed checks and commands. Confirm;
   it takes about a minute; the notification says `passed` or names the failed checks. `workspace_admin_status` shows every check.
   A failure is a finding: do not enable; fix the cause and validate again. **Nothing can skip or fake this step.**
6. **Enable (chat → card → Confirm).** "propose enabling the workspace tools". The card shows the validation it relies on. The answer
   says `ON (verified: N tools are offered from the next reply)`.
7. **Verify availability (chat):** "list the workspaces" → `workspace_list` shows `scratch` and `orbit-validation` and sandbox
   `supported`.
8. **First owner-confirmed command (chat → card → Confirm):** "in workspace scratch, run `ls -la`". Confirm the card; "status of that
   run" → `completed`, exit 0, `processTreeGone: true`.
9. **Disable (chat → card → Confirm), any time:** "propose disabling the workspace tools". The switch is off at once; queued runs are
   withdrawn; running ones are killed and each is reported `cancelled` only once its exit was observed (otherwise "kill sent; exit not
   observed yet", visible in `exec_status`).

### Recovery

* **Turn everything off without ORBIT's cooperation** (operator, root): remove the host permission and restart ORBIT. The tools are off
  after the restart; running commands die with the old process and are recorded `uncertain` at the next start.
  ```bash
  sudo sed -i '/^Environment=ORBIT_WORKSPACE_TOOLS=/d' /etc/systemd/system/orbit.service.d/60-orbit-workspace.conf
  sudo systemctl daemon-reload && sudo systemctl restart orbit.service
  ```
  (Or confirm `revoke` on a card: the switch goes off at once in ORBIT, then the helper does exactly this.) At the next start ORBIT
  also resets its recorded switch to off and invalidates the validation, so setting the host up again never re-enables anything. The
  owner switch is also a file: writing `{"schema":1,"mode":"off"}` to `/var/lib/private/orbit/workspace/activation.json` turns the tools
  off (it is read on every use).
* **ORBIT does not start after the setup** (not expected): `sudo rm /etc/systemd/system/orbit.service.d/60-orbit-workspace.conf &&
  sudo systemctl daemon-reload && sudo systemctl restart orbit.service`. The `orbit` user stays (ORBIT keeps running as it).
* **`cleanup_unverified`** (exec paused): restart ORBIT; recovery re-reaps and lifts the pause only if the run's cgroup is gone or
  empty. If it stays, inspect `/sys/fs/cgroup/system.slice/orbit.service/workspace-exec/orbit-run-*/cgroup.procs`.
* **Remove the helper:** `sudo /opt/orbit/current/deploy/uninstall-ws.sh` (units and code only; never data, images, mounts or the
  drop-in; it prints what is left and how to remove it by hand).

### Capabilities that still need an operator

Installing (and updating) the root helper; any item the plan lists under "needs separate operator approval" (AppArmor user-namespace
policy for bubblewrap, cgroup v2 unified hierarchy, systemd ≥ 254, unprivileged user namespaces); choosing other workspaces or limits
(edit `/etc/orbit/workspaces.json` by hand, then restart ORBIT: the switch turns itself off because the policy changed; validate
and enable again);
deleting workspace images or the `orbit` user.

## 10. Remaining risks and limitations

* **OS isolation is unverified until the on-host validation passes**, and the validation is a bounded smoke test, not an adversarial
  suite. It checks the basic properties where ORBIT runs (no network, hidden host paths and a fresh canary, read-only runtime, no
  capabilities, clean environment, timeout, cancel and process-tree cleanup); it does not attempt kernel exploits or resource
  exhaustion.
* **Kernel attack surface.** No seccomp filter beyond bubblewrap and no_new_privs. Unprivileged user namespaces are required. A kernel
  bug reachable from an unprivileged user namespace would break the boundary. A seccomp profile is a recommended follow-up.
* **Same kernel uid.** Inside the sandbox the command is uid 1000; on the host its processes and files belong to ORBIT's own user
  (`orbit` after the setup). A sandbox escape would land as ORBIT's user. A separate sandbox account needs a privileged launcher,
  which this design deliberately does not add.
* **The host-setup runner is root and the least confined unit** (it installs a package, creates a user, makes filesystems and writes
  systemd files). Its restriction is its fixed plan and command list, not its sandbox (`docs/orbit-ops-ws.md`).
* **The helper cannot know the owner clicked.** As in tiers 2 and 3, membership of the `orbit-ops` group is the trust boundary; the
  plan key binds the request to the card, it is not a signature.
* **Same-loop work.** File operations are synchronous on ORBIT's event loop. They are now bounded (entries and time), not moved to a
  worker thread.
* **Device nodes in `/dev`:** bubblewrap's minimal `/dev` (`null`, `zero`, `full`, `random`, `urandom`, `tty`, `pts`).
* **CPU** is one CPU per run (`cpu.max`) and `RLIMIT_CPU` per process; the wall-clock timeout bounds the total.
* **Workspace size** is bounded by the dedicated mount only.
* **Reads during a run** may see a workspace in flux; they stay inside the boundary, and versions make any later write fail.
* **A corrupt ledger** turns the workspace tools off with `invalid`; ORBIT still starts; the file is left untouched.
* **Held proposals live in memory.** A restart loses them (`410`).
* **Mount and option checks** read `/proc/self/mountinfo` from ORBIT's namespace.
* The card is the review surface. A 24,000-character card is long, and Rai must read it.

## 11. Implemented surface, gates and what is still missing

This is what the code does today. Code completion is not host readiness: nothing below has been run on the production host.

**Tools (model-facing, owner-only, `workspace` policy port).** `workspace_list`, `fs_list`, `fs_stat`, `fs_read`, `fs_search` (run at
once, read-only); `fs_write`, `fs_patch`, `exec_start` (only **propose**: each needs Rai's confirmation on its own card); `exec_status`,
`exec_cancel` (the owner's own ledger). There is no delete tool, no network, no vault access and no generic shell. They are offered only
when all three activation layers hold (section 2), and refused at dispatch otherwise.

**Administration tools (owner-only).** `workspace_preflight` and `workspace_admin_status` (read-only), `workspace_admin_propose` with
exactly `setup`, `validate`, `enable`, `disable` or `revoke` (each only proposes a card). Offered once the host permits the tools or the
`orbit-ops-ws` socket exists.

**Roots and limits.** Only operator-configured workspaces (`/etc/orbit/workspaces.json`; the host setup writes `scratch` at
`/srv/orbit-workspaces/scratch`, 1 GiB, and `orbit-validation`, 64 MiB). A root must exist, be a directory owned by ORBIT's user with
mode 0700, not be or pass through a symbolic link, and not be or lie under a forbidden or protected path (ORBIT's state, credentials,
the vault, `/opt/orbit`, `/etc/credstore` and the system trees in `config.ts`). An exec root must be its own `nosuid,nodev` mount no
larger than `workspaceBytes`. Paths: relative, at most 32 components, 255 bytes each, 1024 characters. Reads: 16 KiB pages, files up to
16 MiB versioned; search: 2,000 entries, 3 s, 100 results; writes: 20,000 bytes; patches: 8 edits. Command defaults (operator-settable
within bounds): wall 300 s, CPU 120 s, memory 1 GiB, 64 processes, files 64 MiB, 256 open files, output 1 MiB per stream, `/tmp`
64 MiB, one run at a time (at most 4).

**Approvals.** Every write, patch and command: one card, owner-confirmed, digest-bound, single use, 10-minute expiry, every
precondition re-checked at run time (section 6). Every activation operation: its own card. Installing the root helper: an operator, as
root, after Rai's separate approval.

**Gates, in order, each separately confirmed** (section 9 has the exact commands):

1. Install `orbit-ops-ws` (operator, root, `install-ws.sh --approved-by-owner`). Changes no ORBIT setting.
2. `workspace_preflight` (read-only). Stop on any "needs separate operator approval" item.
3. `setup` card → Confirm. The root helper applies exactly the plan on the card; ORBIT restarts; the tools stay **off**.
4. `validate` card → Confirm. The bounded smoke suite runs under the production sandbox; it must pass (every cleanup verified).
5. `enable` card → Confirm (within 24 hours of the validation). The switch is bound to that validation.
6. `disable` card at any time (off at once), or `revoke` card (off at once, then the host permission is removed; validate and enable
   again after any new setup).

**Missing or unverified (needs work or a separate decision):** OS isolation on the production host (the real-sandbox suite has never run
here: section 8); the units under their own sandboxes and the real outputs of the host commands (`docs/orbit-ops-ws.md`, Known
limitations); a seccomp profile; host-wide prerequisites the helper never changes (cgroup v2 with `memory pids cpu`, systemd 254 or
newer, unprivileged user namespaces, an AppArmor decision where `kernel.apparmor_restrict_unprivileged_userns=1`).
