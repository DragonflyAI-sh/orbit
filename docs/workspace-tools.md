# Workspace tools: confined files and sandboxed commands (implemented, OFF, NOT activated)

ORBIT's first local filesystem and command tools. They work only inside dedicated workspaces that the operator configures. Reads
are owner-only and run directly. Every write, patch and command is a **proposal** that Rai confirms on a card. Commands run in a
separate, unprivileged bubblewrap sandbox. It has no network, no host state and no ORBIT credentials, and the workspace is the only
place it can write.

**Status.** This is code and tests only. It was written and tested on a cloud runner, not on the production host. Nothing has been
installed, enabled or run on a live host. The capability is **off by default**: merging or deploying this code turns nothing on.
Turning it on needs two things that have not happened yet: the independent security review and the live-host isolation checks in
section 9. The real-sandbox integration tests **did not run** on this job's runner (section 8), so OS isolation is
**unverified**.

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
| Durable ledger, audit lines, restart recovery | Any change to the `orbit-ops` helpers, their protocol, or their units |
| Default off and a pre-activation gate | Installing bubblewrap, changing `orbit.service`, cgroup delegation: these are operator steps, not done here |

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

* **Activation** (`config.ts`, `select.ts`). The tools exist only when `ORBIT_WORKSPACE_TOOLS=enabled` **and** the JSON file named by
  `ORBIT_WORKSPACES_FILE` contains `"preActivationChecklist": "workspace-tools-preactivation-v1"`. ORBIT must also not be running as
  root, the platform must be Linux with `/proc/self/fd`, and ORBIT must have a state directory. In every other case `selectWorkspace`
  returns a service that offers **no tools** and refuses every confirmation. The startup log line `workspace-tools: <state> (<reason>)`
  says which case applies.
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

* **Namespaces.** User, PID, network, IPC, UTS and cgroup namespaces are all new (`--unshare-*`). `--disable-userns` blocks nested
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
  the PID namespace. ORBIT then writes `cgroup.kill` and waits until `cgroup.procs` is empty before it removes the cgroup.
  `treeGone` records that evidence. If ORBIT itself dies, `--die-with-parent` tears the namespace down, and recovery at the next start
  kills whatever is left in the cgroups of runs that were in flight.
* **No fallback.** At startup ORBIT probes:
  * bubblewrap must offer every required option;
  * `prlimit` must be present;
  * the delegated cgroup must enable `memory pids cpu` for its children and must be writable;
  * a live self-test must run a command in the sandbox. That command checks its uid, network interfaces, PID namespace, environment,
    that host paths (ORBIT state, credentials, `/etc/shadow`, `/home`, `/root`, `/var`, `/opt`) are hidden, and that the runtime is
    read-only.

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
| `fs_list` | `workspace`, `path?`, `cursor?`, `limit?` (max 200) | `entries[{name, type, size?, nlink?, mount?}]`, `total`, `nextCursor`, `omittedUndecodableNames?` |
| `fs_stat` | `workspace`, `path` | `type` (file, dir, symlink, fifo, socket, char-device, block-device), `size`, `mode`, `nlink`, `modifiedAt`, `version` or `versionUnavailable` |
| `fs_read` | `workspace`, `path`, `offset?`, `length?` (default 8 KiB, max 16 KiB) | `text` (masked) or `binary: true`, `version` (whole file), `size`, `offset`, `bytes`, `nextOffset`, `truncated`, `masked?`, `untrusted: true` |
| `fs_search` | `workspace`, `query` (literal, 1-200 characters, one line), `path?`, `maxResults?` (max 100) | `matches[{path, line, text}]` (masked), `filesSearched`, `bytesSearched`, `complete`, `stoppedBecause?`, `skipped{...}`, `untrusted: true` |
| `fs_write` | `workspace`, `path`, `content` (at most 24,000 bytes of text), exactly one of `expectedVersion` or `createOnly: true` | `status: "pending-confirmation"`, `executed: false`, `proposalId`, `digest`, `expiresAt`, `warnings` |
| `fs_patch` | `workspace`, `path`, `expectedVersion`, `edits[{find, replace}]` (1-8) | the same proposal fields |
| `exec_start` | `workspace`, `argv` (1-64 strings, each at most 4096 characters), `script?` (at most 16,000 bytes, at `/run/orbit/script`), `cwd?` | the same proposal fields |
| `exec_status` | `runId?`, `stream?` (stdout or stderr), `offset?`, `length?` (max 16 KiB) | without `runId`: `proposals[{state: "proposal", ...}]` and the last 10 `operations`. With it: `operation{state, reason, exitCode, signal, killedBy, processTreeGone, output{...}, events[]}` and an `output` page (masked, `untrusted: true`) |
| `exec_cancel` | `runId` | `cancelled` / `cancelRequested` with the state. A running command is reported `cancelled` only after its exit is observed |

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
  workspace snapshot). It then holds the frozen canonical operation in memory and opens a `workspace_op` card. The card shows
  **every field the digest covers, in full**: the path and the whole content, every patch edit and the resulting version, the exact
  argv and script, cwd, clean environment, network `none`, sandbox implementation and policy hash, limits, and the reviewed snapshot.
  It also shows the mutation scope: "the command can create, change or delete ANY file in workspace X; nothing else". Nothing is
  ever clipped. An operation whose card would exceed 24,000 characters, or whose text the content filter flags as credential-shaped,
  is refused, and no proposal exists.
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
* **Snapshot strategy for exec.** The approval is bound to the workspace's **reviewed snapshot**. That is a digest over every entry:
  path, type, mode and size, the content hash of each regular file, and the target of each link. It is bounded at 20,000 entries,
  128 MiB and depth 64. A workspace too large for this cannot be used for exec. When the run starts, under the workspace lock, the
  snapshot is taken again. If **anything** differs (an edited script, a changed input, a mode change, a new file, or another run's
  effects), the run fails as `stale` and does not start. A changed executable or input therefore never inherits an earlier approval.
* **Backend enforcement.** Owner, digest, workspace identity, preconditions, snapshot, sandbox state and policy are all checked in
  the backend at run time. The model is never trusted for any of them. A tool's output, a file's content or a command's output can
  never change the sandbox policy or skip a confirmation.
* **Every model path is the same.** The primary model and the OpenRouter fallback get the same tool objects and the same
  server-side `allow` (`src/fallback.ts`). Calling a mutating tool from any path only proposes
  (`test/workspace-approvals.test.ts`: "every mutating tool, called directly ...").

## 7. Audit, privacy and retention

* **Audit lines.** Each proposal, confirmation, denial, invocation, result, cancellation and recovery is one JSON line on stdout
  (the journal): `{at, port: "workspace", event, kind, workspace, proposalId?, opId?, digest (prefix), detail}`. The details are
  states, error codes and reasons. File contents, script text, argv and command output are **never** included (tested). The server
  also writes its usual `agent.<tool>` and `workspace.confirm:<action>` policy audit lines.
* **Ledger.** The ledger is `$STATE_DIRECTORY/workspace/ledger.json` (written atomically, mode 0600). Run output is stored in
  `output/<opId>.stdout|stderr` (mode 0600, at most `outputBytes` per stream). The 200 most recent finished entries are kept, and a
  dropped entry's output files are deleted with it. Deleting `$STATE_DIRECTORY/workspace` removes all of it.
* **Masking.** Content shown to the model or on cards goes through the vault content filter (masking by credential shape). Masking
  is defense in depth, not authorization. File and command output is marked `untrusted: true`, and the tool descriptions tell the
  model it is data, never instructions.
* **No secrets in workspaces.** A credential-shaped write, argv or script is refused. Service secrets are never copied anywhere:
  the sandbox has no ORBIT environment and no credential directory, and the probe checks this.

## 8. Tests (this job's runner)

All of these use synthetic temporary directories. No production data or host is involved.

| File | Tests | Ran here |
|---|---|---|
| `test/workspace-fs.test.ts` | 14: lexical rules; symlinks at every depth (to the outside, `/proc/self/root`, `/`, relative ones); hard links; FIFO and character device; bind mount inside the workspace; root replaced; **symlink-swap races** on reads and on writes; atomic write preconditions and modes; patch; paging, UTF-8 and binary; list and search bounds; snapshot sensitivity | yes, as root (device and bind-mount cases need root) |
| `test/workspace-approvals.test.ts` | 18: owner-only port; disabled refusal; propose then confirm then replay; tampering (digest, card, workspace, identity); stale file; patch; tool confinement and unknown arguments; secret refusal and masking; exec card disclosure and single run; changed script or mode means stale; concurrency (busy, queue, cross-workspace); cancel queued and running; timeout and no-pid; no unsandboxed fallback; restart recovery; status and paging; ledger persistence; no effect from direct calls | yes (supervision through a labelled test double; **not** isolation evidence) |
| `test/workspace-config.test.ts` | 8: default off and checklist gate; production wiring off; root rules; exec requirements (dedicated mount, trusted binaries, runtime allowlist, cgroup); identity binding; fixed bubblewrap argv; probe verdicts; `nosuid,nodev` | yes |
| `test/workspace-server.test.ts` | 4: through the real server, model call, card, non-owner and wrong digest refused, owner confirm once, result on the card; exec end to end; expiry and cancel; disabled and non-owner offering | yes |
| `test/workspace-sandbox.test.ts` | 7 **real sandbox** tests: probe; uid, capabilities, no_new_privs, nested userns; network and host loopback; host filesystem invisibility and read-only runtime; environment; process-tree cleanup on exit, timeout and cancel; fork bomb, memory, output, `/tmp` and file-size limits | **SKIPPED.** This runner runs as root, has no bubblewrap, and has no cgroup v2 controllers. **OS isolation is unverified** |

To run the real sandbox suite, use an isolated Linux VM, never production. It needs a bubblewrap at `/usr/bin/bwrap` that offers every
option in `REQUIRED_FLAGS` (`src/workspace/sandbox.ts`, including `--size` and `--disable-userns`; a recent release is expected), and a
non-root user that owns a cgroup v2 directory with `memory pids cpu` in its `cgroup.subtree_control`. Then run
`ORBIT_SANDBOX_TEST_CGROUP=<dir> node --test test/workspace-sandbox.test.ts`. All 7 tests must pass, not skip.

## 9. Operator setup, disable, and the pre-activation checklist

Nothing below has been done. It must not be done until **every** checklist item is complete and recorded.

**Pre-activation checklist** (all required, in order):

1. **Independent security review** of `src/workspace/*`, the `workspace_op` confirm route and card, and this document. The reviewer
   must not be the author. Record the reviewer, date and findings, and resolve the findings.
2. **Real sandbox suite** (`test/workspace-sandbox.test.ts`): all 7 pass, not skip, in an isolated Linux VM with the same
   distribution, kernel series and bubblewrap version as the host. Record the output.
3. **Live-host isolation checks** with throwaway workspaces, run after deploy but **before** the checklist line is written:
   * the startup probe reports `supported`;
   * from inside a run, check that: there are no interfaces other than `lo`; ORBIT's port and the helper sockets are unreachable;
     `/etc/shadow`, `$STATE_DIRECTORY`, `/etc/credstore`, `/opt/orbit` and `/home` are absent; `NoNewPrivs: 1`; `CapEff` is 0;
     the uid is 1000;
   * a fork bomb and a memory hog are contained by the run cgroup, and the host stays healthy;
   * after cancel and timeout, `cgroup.procs` is empty.

   Adversarial tests run only in a disposable workspace, and their results go in the review record.
4. **Decisions recorded:** which workspaces exist and which allow exec; the limits; that production workspaces hold no secrets or
   copies of production data.
5. Only then write `"preActivationChecklist": "workspace-tools-preactivation-v1"` into the workspaces file, set the env flag, and
   restart.

**Operator setup** (host changes, each its own reviewed change; this job made none):

* Install bubblewrap (root-owned, not setuid, offering every option in `REQUIRED_FLAGS`; the probe refuses an older one) and util-linux
  `prlimit`.
* Make one dedicated filesystem per exec workspace, mounted `nosuid,nodev`, no larger than `workspaceBytes`. For example, a tmpfs
  or a loop-mounted ext4 under `/srv/orbit-workspaces/<id>`. Make the root directory owned by the ORBIT user, mode `0700`. Read-only
  workspaces (exec off) only need the directory.
* Delegate a cgroup v2 subtree to ORBIT: an `orbit.service` drop-in with `Delegate=memory pids cpu` and `DelegateSubgroup=main`
  (systemd ≥ 254), and a child directory with `+memory +pids +cpu` in its `cgroup.subtree_control`. Name that directory as
  `cgroupParent`. This changes a pinned unit (`test/tier12-pin.test.ts`), so it needs its own reviewed change.
* Write the workspaces file (mode 0600, owned by root, readable by ORBIT). Values are schematic:

  ```json
  {
    "preActivationChecklist": "<written only at step 5>",
    "workspaces": [{ "id": "scratch", "root": "/srv/orbit-workspaces/scratch", "exec": true }],
    "sandbox": {
      "bwrap": "/usr/bin/bwrap", "prlimit": "/usr/bin/prlimit", "shell": "/bin/sh",
      "runtime": ["/usr", "/bin", "/sbin", "/lib", "/lib64"],
      "cgroupParent": "/sys/fs/cgroup/system.slice/orbit.service/workspace-exec",
      "limits": { "timeoutSec": 300, "cpuSec": 120, "memoryBytes": 1073741824, "processes": 64, "fileSizeBytes": 67108864,
                  "openFiles": 256, "outputBytes": 1048576, "tmpBytes": 67108864, "workspaceBytes": 1073741824 },
      "maxConcurrentRuns": 1
    }
  }
  ```

  Then set `ORBIT_WORKSPACE_TOOLS=enabled` and `ORBIT_WORKSPACES_FILE=<path>` in `orbit.env`. Those keys are not among the five that
  `ops_propose_config_change` may change, so this is a manual operator step.

**Disable.** Use any one of these, then restart ORBIT: remove `ORBIT_WORKSPACE_TOOLS` (or set it to anything but `enabled`), remove
the checklist line, or remove the file. ORBIT then offers no workspace tool and refuses every confirmation. Running commands die
with the old process. At the next start, recovery records them as `uncertain` and kills any leftovers. The ledger stays readable
on disk.

## 10. Remaining risks and limitations

* **OS isolation is unverified here** (section 8). The bubblewrap options, the cgroup steps and the probe are untested against a real
  kernel in this job.
* **Kernel attack surface.** There is no seccomp filter beyond what bubblewrap and no_new_privs give. Unprivileged user namespaces
  are required on the host (Ubuntu's AppArmor userns restriction must allow bubblewrap). A kernel bug reachable from an unprivileged
  user namespace would break the boundary. Adding a seccomp profile is a recommended follow-up.
* **Same kernel uid.** Inside the sandbox the command is uid 1000, but on the host its processes and files belong to ORBIT's own
  service user, the only user that can create the user namespace without a privileged helper. The namespaces, the absent mounts and
  the dropped capabilities keep it away from ORBIT's files, processes and sockets. A sandbox escape would land as ORBIT's user,
  though, not as a separate account. A dedicated sandbox user needs a privileged launcher, which this slice deliberately does not
  add.
* **Device nodes in `/dev`.** bubblewrap's minimal `/dev` includes `null`, `zero`, `full`, `random`, `urandom`, `tty` and `pts`.
  `tty` is unusable with `--new-session`.
* **CPU** is limited to one CPU per run (`cpu.max`) and by `RLIMIT_CPU` per process, not by a run-wide CPU-seconds budget. The
  wall-clock timeout bounds the total.
* **Workspace size** is bounded only by the dedicated mount. ORBIT checks that mount's size at load time and does not enforce a
  quota itself.
* **Reads during a run** may see a workspace in flux. They stay inside the boundary, and versions make any later write fail
  deterministically.
* **Held proposals live in memory.** A restart loses them (`410`), like vault proposals.
* **Mount and option checks** read `/proc/self/mountinfo` from ORBIT's namespace, so they cover what ORBIT sees.
* The card is the review surface. A 24,000-character card is long, and Rai must read it.
