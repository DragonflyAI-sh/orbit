# Workspace tools: independent security review and sandbox validation attempt (2026-11-19)

Scope: the merged workspace filesystem/exec slice (PR #142). This is a **review and test-harness change only**. It changes no production
code, enables nothing, and does not authorize activation. The reviewer is not the author of PR #142 (review job
`orbit-202611190811-6ykm`). Review of this job's own test and doc changes is still needed (section 8).

| | |
|---|---|
| Baseline reviewed | `main` at `0546559638f927071a025198eee7dff2a0e74053` (squash merge of #142) |
| PR #142 final head | `e1be614ad151e44548e81015fd6599002e6d84a8`: `src/`, `test/` and `docs/` are byte-identical to the baseline (`git diff --quiet e1be614 0546559 -- src test docs`) |
| Tested commit | this branch (`orbit/orbit-202611190811-6ykm`) = baseline + test/doc/tool changes listed in section 8; no `src/` change |
| Prior review | PR #142 comment 7001571607 (on older head `a489a54`), retrieved read-only and reconciled in section 5 |
| CI for #142 final head | GitHub check run `checks` (Actions run 44475871296) concluded `success`; its logs were not read here |

## 1. Verdict

* **Blocking findings (code):** none found at source level.
* **Lesser findings:** 7 Low and 7 nits (WS-R1 to WS-R14, section 4). Each has a reproducer or exact location. None is fixed here.
  Production fixes need a separate change.
* **Activation gates still open (blocking for activation, not code defects):**
  1. **OS isolation is unverified.** The real-sandbox suite did not run (section 6). No qualifying isolated environment was available.
  2. Live-host isolation checks (checklist item 3): not authorized for this job and not done.
  3. Checklist item 1 needs the findings below resolved or explicitly accepted, and needs this job's own changes reviewed.
  4. Checklist item 4 (operator decisions): not done.

  **This is not a "safe" or "ready" verdict.** Unit and stub tests show that ORBIT's gating logic behaves as described. They say
  nothing about kernel enforcement.

Evidence classes used below: **S** = source reading; **U** = unit/stub/mock test that ran here; **OS** = real OS-enforced sandbox test
(none ran); **H** = production-host check (not authorized; none done).

## 2. The startup race (fixed in e1be614): independent verification

Requirement: the public sandbox status stays `unknown` while the self-test runs, only the private self-test may launch, a normal
confirmed exec is denied until success, failures and timeouts never become `supported`, and concurrent initialization or restart
cannot bypass this.

| Property | Result | Evidence |
|---|---|---|
| Never-probed launcher is `unknown`; `start()` spawns nothing | **pass** | S `sandbox.ts:138,214-217`; U R1 |
| During a slow *passing* self-test the state is only ever `unknown`; ordinary `start()` refused at every sample; exactly one launch (the probe's) | **pass** | S `sandbox.ts:207-216,280,313`; U R2 (and the existing `workspace-config.test.ts` stub test for a failing self-test) |
| Self-test killed by the probe's 20 s limit ends `unsupported` | **pass** | U R3 (mocked timer drives the real kill path) |
| Failed self-test, or a transcript that fails `judgeProbe`, ends `unsupported` | **pass** | U R4 |
| A re-probe makes the state `unknown` at once; an exec confirmed meanwhile fails `sandbox_changed`; nothing launches | **pass** | S `service.ts:476`; U R5 |
| A run queued before a re-probe and dequeued during it is refused at start (`not_started`); nothing launches | **pass** | S `service.ts:524`, `sandbox.ts:215`; U R6 |
| Restart: a new launcher instance is `unknown` and refuses runs even while another instance (same state dir) is mid-probe | **pass** | U R7 |
| Running as root: the probe never launches, verdict `unsupported` | **pass** | U R8 |
| `exec_start` refused while `unknown` (no proposal made) | **pass** | S `service.ts:326-327`; U R9 |
| **Overlapping `probe()` calls** | **fail (latent)** | WS-R1: the older verdict can overwrite a newer one, and `supported` can show while a newer self-test still runs. Not reachable today: `select.ts:41` is the only caller and calls it once |
| Probe that throws | **partial** | Fails closed (stays `unknown`), but with a stale reason and no log: WS-R2 |

R1 to R9 are in `test/workspace-review.test.ts`. They drive the production `bwrapSandbox` with stub `bwrap`/`prlimit` and a plain
directory standing in for the cgroup. They are U evidence of gating and supervision only.

## 3. Pre-activation checklist and control mapping

### 3.1 The checklist (`docs/workspace-tools.md` section 9)

| Item | Status | Justification |
|---|---|---|
| 1. Independent security review, findings recorded and resolved | **partial** | This document records it. Findings WS-R1 to WS-R14 are open. This job's own changes need review (section 8) |
| 2. Real sandbox suite: all pass, not skip, in an isolated VM matching the host | **unverified** | Not run: no qualifying environment (section 6). Runbook in section 7 |
| 3. Live-host isolation checks | **not done (not authorized)** | Production-host checks are out of scope for this job |
| 4. Decisions recorded (workspaces, exec, limits, no secrets) | **not done** | Operator step |
| 5. Write the checklist line and the env flag only after 1 to 4 | **holds** | S `config.ts:235-252`, U `workspace-config.test.ts`: off by default; no file in this repository sets it |

### 3.2 Controls

| Control | Status | Evidence / justification |
|---|---|---|
| Owner auth: tools offered only to the owner | pass | S `server.ts:511-512` (`isOwner && model.step`) |
| Owner auth: every tool call re-checked (`agent` + `workspace` ports) | pass | S `server.ts:534-565`, `policy.ts` `OWNER_PORTS`; U `workspace-approvals` "owner-only port" |
| Primary and fallback models share one dispatch path | pass | S: tool execution and `allow` live in `agent.ts:430` (`execute(..., allow, ...)`); `fallback.ts` only produces model steps; U "every mutating tool, called directly" |
| Disabled by default; checklist string required; not as root; Linux + `/proc/self/fd`; state dir | pass | S `config.ts:234-258`, `select.ts:15-27`; U `workspace-config` |
| Off state: no tools, every confirmation refused | pass | S `service.ts:424,596`, `server.ts:1088`; U |
| Card shows the operation in full | pass, with nits | S `service.ts:75-113,156-161`. Identity and policy hash are shown as 19-character prefixes (WS-R11). Bidi and invisible characters are rendered raw (WS-R5) |
| Digest binding (canonical JSON, sorted keys) | pass | S `service.ts:46-51,421-423`, `server.ts:1087` |
| Conversation (origin) binding | pass | S `server.ts:1089` |
| Single use: `take()` plus card CAS; replay refused | pass | S `server.ts:1090-1092`, `service.ts:414-415`; U |
| Expiry (10 min); held op lost on restart → 410 | pass | S `service.ts:17,420`; U `workspace-server` |
| Stale input refusal: write/patch version re-checked under the lock | pass | S `service.ts:442-469`, `fsops.ts:413-428`; U, plus the "review check" test |
| Workspace identity binding (id, root, dev, ino, exec, policy hash incl. limits) | pass | S `config.ts:229-230`, `service.ts:425-426` |
| Exec snapshot binding re-taken under the lock; any difference → `stale` | pass | S `service.ts:500-521`, `fsops.ts:493-544`; U. The snapshot leaves out the root's own mode (nit, in WS-R11) |
| Script/argv/cwd/env/policy binding | pass | S `service.ts:338,476,524`; env is the fixed `CLEAN_ENV`. The policy *id* is not compared again at dequeue (nit, WS-R11) |
| Descriptor walk (`O_PATH\|O_NOFOLLOW` per component, device check) | pass | S `fsops.ts:132-165`; U `workspace-fs` |
| Traversal, symlinks (all depths), hardlinks, special files | pass | S `fsops.ts:62-79,152,202-206`; U |
| Mounts inside the workspace | pass | S `fsops.ts:92-107,151,176-179`; U (bind-mount case ran as root) |
| TOCTOU: content read through the pinned inode | pass | S `fsops.ts:182-200`; U symlink-swap race tests |
| TOCTOU: write parent vs. precondition walk | pass within threat model | `atomicWrite` walks the parent, then `currentVersion` walks again by name (`fsops.ts:418-423`). Only a concurrent writer as ORBIT's own user could exploit the gap; the lock excludes ORBIT's runs |
| Atomic updates (`link` for new, `rename` for replace, fsync, mode & 0700) | pass | S `fsops.ts:429-466`; U |
| Concurrency: one lock per workspace, a global run cap | pass | S `service.ts:443-447,487-498,502`; U |
| No ambient secrets in the sandbox: `--clearenv`, launcher env `{}` | pass (S), unverified (OS) | S `sandbox.ts:64-66,230`; OS test exists but did not run |
| No sockets or host state mounted; fixed bubblewrap argv; model text only after `--` | pass (S/U), unverified (OS) | S `sandbox.ts:56-82`; U `workspace-config` "fixed bubblewrap argv" |
| Runtime allowlist, root-owned, not group/other-writable; merged-/usr links | pass (S/U) | S `config.ts:159-178`. Binaries and runtime are later used by path: WS-R9 |
| Namespaces (user, pid, net, ipc, uts, cgroup-try), `--disable-userns` | unverified (OS) | S `sandbox.ts:57-59`; `--unshare-cgroup-try` (WS-R13) |
| No network, including host loopback; abstract sockets | unverified (OS) | Probe checks interfaces only (WS-R10). OS tests exist, plus a new abstract-socket test; none ran |
| uid 1000, `--cap-drop ALL`, no_new_privs | unverified (OS) | S; the self-test does not check CapEff or NoNewPrivs (WS-R10) |
| cgroup v2 memory/pids/cpu per run; the wrapper joins before exec | unverified (OS) | S `sandbox.ts:94-98,159-172,229` |
| rlimits (cpu, as, fsize, nofile, nproc backstop, core 0) | unverified (OS) | S `sandbox.ts:87-90` |
| Output caps, wall-clock timeout | pass (U), unverified (OS) | S `sandbox.ts:231-255`; U |
| Workspace disk bound = dedicated mount ≤ `workspaceBytes`, `nosuid,nodev` | pass (S/U); unverified on a real loop/tmpfs mount | S `config.ts:129-142` |
| Cancellation and descendants: SIGKILL, cgroup.kill, `treeGone` evidence | pass (U), unverified (OS) | S `sandbox.ts:181-205,246-270`. When `treeGone` is false, later runs are still allowed: WS-R8 |
| Audit privacy: no contents, argv, script or output | pass with exception | S `service.ts:43,127-133`. Error messages can carry model- or workspace-chosen path text, unmasked: WS-R6 |
| Restart recovery: never success; leftovers reaped | pass | S `service.ts:558-592`; U. Ledger opIds are not validated: WS-R4 |
| Honest status (`workspace_list`, `describe`, card live state) | pass with exception | The probe verdict is never logged; a thrown probe leaves a stale reason (WS-R2) |
| Corrupt ledger → tools off, ORBIT starts | pass | S `ledger.ts:51-62`, `select.ts:29-37`; U |

## 4. Findings

Severity is the reviewer's judgement in this deployment's threat model: a possibly prompt-injected model and hostile workspace
content, with Rai's confirmation as the human gate. A host-level attacker already running as ORBIT's user is out of scope except
where noted. **Every finding is open. None was repaired in this job.**

### Low

**WS-R1. Overlapping probes: a stale verdict wins, and `supported` can show while another self-test runs.** `src/workspace/sandbox.ts:278-320`.
`probe()` has no generation guard. Each call sets `state` when it finishes, so the last one to finish wins, not the newest. Overlapping
calls also share `probe-workspace` (`:308-310`: a second probe deletes the first's directory). Their run ids come from
`Date.now()` (`:313`), so two calls in the same millisecond collide.
*Reachability:* none today, because `select.ts:41` calls it once. Any future re-probe (a periodic check, an admin "recheck") would make this
a fail-open.
*Reproducer:* `test/workspace-review.test.ts` "finding WS-R1" and "WS-R1b" (todo). They show the final state `supported` after the
newest self-test failed, and `supported` while a self-test is still running.
*Remediation:* a monotonically increasing probe generation. Only the newest probe may write `state`, and `status()` stays `unknown`
while any probe is pending. Use a unique per-probe run id and probe workspace, or serialize probes behind one promise.

**WS-R2. A probe that throws leaves `unknown` with the stale reason "the sandbox self-test is running", and nothing is logged.**
`sandbox.ts:280`, `select.ts:41` (`.catch(() => undefined)`). Fail-closed holds, but the status is not honest, and an operator never
sees why exec is unavailable. *Reproducer:* "finding WS-R2" (todo). *Remediation:* in `probe()`, use try/finally that sets
`unsupported` with the error, and log the verdict line (`workspace-sandbox: <state> (<reasons>)`) at startup.

**WS-R3. Unbounded directory walks on the main event loop.** `fsops.ts:340-376` (`search`): the 2000 limit counts only regular
files. Symlinks, special files, directories and undecodable names are visited without bound. `listDir` (`:247`) reads and sorts
the whole directory. All filesystem work is synchronous on ORBIT's single event loop. A workspace filled by an approved command, or
any writer to a read-only workspace, can stall ORBIT (HTTP, chat, jobs) whenever the model calls `fs_search`/`fs_list`. The model can call
those without approval. *Reproducer:* "finding WS-R3" (todo): 2,500 symlinks are all visited, and the search reports
`complete: true`. *Remediation:* count every visited entry against a limit, cap `readdir` (stream with `opendirSync` and stop), and
consider a worker thread for snapshot and search.

**WS-R4. Ledger opIds are not validated before restart recovery joins them into paths.** `ledger.ts:58-62` checks only that
`opId` is a string. `sandbox.ts:144,326-336` then joins it into the cgroup path, `killCgroup` and `rmSync(join(runsDir, id), { recursive: true })`.
A tampered `ledger.json` with `opId: "../victim"` makes recovery delete `<state>/workspace/victim`. `orbit-run-../../x` normalizes
to `<cgroupParent>/../x`. That reaches sibling cgroups in the delegated tree, such as the one ORBIT itself runs in (`../main`), and
`killCgroup` would kill the processes listed there. *Precondition:* write access to ORBIT's 0600 state
(ORBIT's own user), so this is defense in depth. *Reproducer:* "finding WS-R4" (todo). *Remediation:* accept only `^ws-[0-9a-f]{16}$`
(and `probe-…` internally) on load and in `reap()`; check that the resolved path stays under `runsDir` and `cgroupParent`.

**WS-R5. Approval cards render bidi and invisible characters raw.** `service.ts:75-113` and `src/web/index.html` (the
`workspace_op` card builds `pre.textContent` from `${k}: ${v}` lines). Script, content, argv and patch text may contain U+202A-U+202E,
U+2066-U+2069 and zero-width characters (Trojan-Source style), or newlines that imitate card fields and `!` warnings. A prompt-injected
model can make what Rai reads differ from what runs. Impact stays inside the workspace and the sandbox, but this weakens the main
human control. *Reproducer:* "finding WS-R5" (todo). *Remediation:* refuse, or visibly escape (`‮`), bidi, zero-width and other
format characters in every card field. Fence multi-line fields with explicit begin/end markers and line numbers.

**WS-R6. Audit lines can carry model- or workspace-chosen text, unmasked.** `service.ts:202` (denial detail is `err.message`),
`:438` (result detail includes `reason`), `:515` (`stale:` reasons can include names created by a sandboxed command). The sink in
`main.ts` (`console.log(JSON.stringify(e))`) does not mask. The docs say details are "states, error codes and reasons". *Reproducer:*
"finding WS-R6" (todo): a credential-shaped path reaches the audit line verbatim. *Remediation:* audit the error code only, or pass the
detail through `maskVaultText` and cap it. Keep paths out of the journal.

**WS-R8. A run whose process tree was not confirmed gone does not block later runs.** `service.ts:539-548`: `treeGone: false` is
recorded, but the workspace lock is released and the queue continues. A leftover process could then change the workspace between the
next run's snapshot check and its launch. It is unclear whether this is reachable once the cgroup is real, since `cgroup.kill`
should empty it (unverified, OS). *Remediation:* if `treeGone !== true`, mark the workspace (or the sandbox) unavailable until an
operator or a later reap confirms the cgroup is empty.

### Nits / hardening

* **WS-R7.** `FORBIDDEN_ROOTS` is an equality check (`config.ts:23,121`), although its comment says "may never be (or contain)". A
  read-only workspace at `/proc/<pid>/fd` (mode 0500, owned by ORBIT's user) is accepted. Operator misconfiguration only.
  *Reproducer:* "finding WS-R7" (todo). *Fix:* refuse any root under `/proc`, `/sys`, `/dev`, `/etc`, `/run`, `/boot`.
* **WS-R9.** Path-based use after a check. `trustedBinary` (`config.ts:108-118`) checks the final file, but not the directories on
  its path. bwrap, prlimit and the shell are later exec'ed by path. The workspace root is bound with `--bind <path>` (`sandbox.ts:77`)
  after a dev/ino check made through a different descriptor. Only an attacker who can already modify those directories (ORBIT's user
  or root) benefits. *Fix:* check parent-directory ownership and modes, and bind the pinned descriptor (`--bind-fd`), or re-check the
  root's dev/ino immediately before spawn.
* **WS-R10.** The self-test (`sandbox.ts:100-131`) does not check `CapEff=0`, `NoNewPrivs=1`, that the run sits in its own cgroup
  with the limits applied, or that host loopback is unreachable. The checklist's live checks cover these manually. *Fix:* add them to
  the probe transcript and to `judgeProbe`.
* **WS-R11.** Doc/code mismatches. The card shows identity and policy hash as 19-character prefixes, but docs section 6 says "every
  field the digest covers, in full". `runOne` does not compare `policyId()` again at dequeue (`service.ts:476` checks only at
  confirm). The snapshot does not include the workspace root's own mode.
* **WS-R12.** If `makeCgroup` fails after `prepareRunDir` (`sandbox.ts:223-228`), `runs/<id>/` (with a copy of the script) is never
  removed: the entry ends `failed` and is never reaped.
* **WS-R13.** `--unshare-cgroup-try` (`sandbox.ts:58`) silently runs without a cgroup namespace if the kernel lacks one. Use
  `--unshare-cgroup`, or have the probe check it.
* **WS-R14.** `removeCgroup` blocks the event loop for up to about 1 s per finished run (`Atomics.wait`, `sandbox.ts:197-205`). Each
  stub run in the tests above pays this. Make it asynchronous.

## 5. Prior review (comment 7001571607, head a489a54) reconciled

| # | Prior finding | Status at baseline | Evidence |
|---|---|---|---|
| 1 | Medium: `supported` during the self-test | **fixed** for the single-call case | S `sandbox.ts:207-216,280`; U R1-R9; residual WS-R1 and WS-R2 |
| 2 | Medium: PR claims not backed by CI | **superseded** | The final-head check run `checks` concluded `success` (it includes the gitleaks step after `pnpm test`, `.github/workflows/delivery.yml:23-27`). Logs not read here |
| 3 | Low: unreadable `lost+found` breaks snapshots | **fixed** (S) | `fsops.ts:500-506` → `snapshot_unsupported`; docs section 9. Its test is **skipped as root** here, so not runtime-verified in this run |
| 4 | Nit: `fs_write` limit vs card budget | **fixed** | `fsops.ts:35` (20,000); U |
| 5 | Nit: cleanup wait wording | **fixed** | docs section 4 now says "up to about one second" |
| 6 | Nit: corrupt ledger stops ORBIT | **fixed** | `ledger.ts:51-62`, `select.ts:29-37`; U |

## 6. Validation phase: environment and outcome

Environment inventory (`sh tools/workspace-sandbox-preflight/preflight.sh`, non-sensitive output):

```text
uid=0                                  (root)
kernel=6.18.44 (Firecracker microVM, container runtime reported)
os=ubuntu 24.04, node=v22.23.5
max_user_namespaces=64272; unprivileged_userns_clone, apparmor_restrict_unprivileged_userns: absent
bwrap=bubblewrap 0.9.0 (installed by this job inside the disposable environment: apt package, root-owned, not setuid)
    every REQUIRED_FLAGS option is offered (checked with the production regex): missing=[]
prlimit=util-linux 2.39.3; python3 present
cgroup_layout=hybrid: memory, pids, cpu bound to cgroup v1; the v2 hierarchy (/sys/fs/cgroup/unified) offers only hugetlb
UNMET: running as root
UNMET: cgroup v2 is not the unified hierarchy (memory/pids/cpu cannot be delegated as v2)
UNMET: ORBIT_SANDBOX_TEST_CGROUP not set
```

**Outcome: the real-sandbox phase was stopped.** The environment cannot meet the requirements without host changes that are not
authorized: creating an unprivileged user, and re-binding cgroup controllers from v1 to v2 (which would change this session's own
containment). An attempt to create a throwaway non-root user to check bubblewrap's namespaces alone was refused by this
environment's permission policy. It was not retried, and no workaround was tried. Therefore:

* **0** OS-enforced tests ran. The 11 real-sandbox tests (7 original plus 4 added) and the requirement gate all **skipped**. In
  `ORBIT_SANDBOX_TEST_REQUIRED=1` mode they **fail** (12 of 12), as designed.
* No claim of OS isolation, network isolation, cgroup or rlimit enforcement, read-only runtime, or cleanup is made from this run.
* bubblewrap 0.9.0 (Ubuntu 24.04's package) offers every required option. That is a flag-compatibility fact only.

## 7. Runbook: isolated-VM real-sandbox validation

Run on a **disposable** VM, never the production host. Use the same distribution, kernel series and bubblewrap version as the host.
Do not weaken any launcher check to make a test pass. Stop at the first unexpected result and record it.

1. **VM:** a pure cgroup v2 boot (`systemd.unified_cgroup_hierarchy=1`, the default on current distributions), unprivileged user
   namespaces enabled (on Ubuntu with `apparmor_restrict_unprivileged_userns=1`, bubblewrap needs its AppArmor profile), `bubblewrap`
   and `util-linux` installed from the distribution, node 22, python3.
2. **User:** a non-root user, e.g. `orbittest` (uid ≠ 0). Do everything below as that user, except the systemd delegation.
3. **Delegated cgroup:** `systemd-run --user --scope -p Delegate=yes --unit orbit-sbx-test sh` (or a system unit with `Delegate=memory pids cpu`
   and `User=orbittest`). Inside that scope:
   `D=/sys/fs/cgroup$(grep '^0::' /proc/self/cgroup | cut -d: -f3)`; `mkdir "$D/main" "$D/runs"`; `echo $$ > "$D/main/cgroup.procs"`
   (cgroup v2 allows no processes in a cgroup that delegates controllers); `echo "+memory +pids +cpu" > "$D/cgroup.subtree_control"`;
   `echo "+memory +pids +cpu" > "$D/runs/cgroup.subtree_control"`; `export ORBIT_SANDBOX_TEST_CGROUP="$D/runs"`. If a controller
   cannot be enabled, the VM's systemd does not delegate it: fix the unit's `Delegate=`; do not run the suite without it.
4. **Preflight:** `sh tools/workspace-sandbox-preflight/preflight.sh`. **Expected:** `RESULT: all requirements met`, exit 0.
5. **Suite:** `pnpm install --frozen-lockfile && ORBIT_SANDBOX_TEST_REQUIRED=1 node --test test/workspace-sandbox.test.ts`.
   **Expected:** 12 tests, **12 pass, 0 fail, 0 skipped**. Specifically:
   * probe `supported`; uid `1000`, `CapEff`/`CapBnd` all zero, `NoNewPrivs: 1`, nested userns refused;
   * interfaces exactly `lo`; the host 127.0.0.1 service, the host abstract unix socket and `::1` are unreachable;
   * the outside canary, `/etc/shadow`, `/home`, `/sys/fs/cgroup` are absent; `/usr` and `/` are not writable; `/proc/sys` is not
     writable; mount and remount are refused; the workspace and `/tmp` are writable;
   * `env` shows only the clean set;
   * the background, timeout and cancel cases leave 0 sleeper processes, with `treeGone: true`;
   * the per-run cgroup exists with `memory.max`/`pids.max` as configured and is removed afterwards;
   * fork bomb contained (`pids.max`), a 300 MB allocation fails under 64 MiB, output capped at 4096 bytes and truncated, `/tmp` and
     file size bounded.
6. **Also run** `node --test test/workspace-*.test.ts` as the non-root user. **Expected:** the `lost+found` snapshot test (skipped
   as root) passes. The `todo` tests stay `todo` until their findings are fixed.
7. **Record** the full TAP output, `bwrap --version`, `uname -r` and the preflight output in the review record (checklist item 2).
   Then destroy the VM.

## 8. What this job changed, how it was tested, and what still needs review

Changed (tests, docs and tools only; no `src/` change):

* `test/workspace-review.test.ts` (new): race regression tests R1-R9, 8 `todo` reproducers (WS-R1, R1b, R2, R3, R4, R5, R6, R7) and one
  precondition check.
* `test/workspace-sandbox.test.ts`: lists every unmet requirement; `ORBIT_SANDBOX_TEST_REQUIRED=1` turns skips into failures (plus a
  requirement-gate test); 4 new real-sandbox tests (abstract socket and IPv6 loopback, host processes, mounts and `/proc/sys`,
  per-run cgroup). **These new tests have never run on a qualifying runner.** Their first VM run needs review: a failure may be a
  test bug, not a sandbox bug, and must be analysed, not "fixed" by weakening anything.
* `tools/workspace-sandbox-preflight/preflight.sh` (new): read-only environment inventory.
* This report.

Commands run (baseline and branch):

```text
pnpm install --frozen-lockfile
pnpm typecheck                                    # passes
node --test test/workspace-*.test.ts              # workspace files only (counts below)
node --test test/*.test.ts                        # the full suite, as `pnpm test`
ORBIT_SANDBOX_TEST_REQUIRED=1 node --test test/workspace-sandbox.test.ts   # 12 fail by design here (requirements unmet)
sh tools/workspace-sandbox-preflight/preflight.sh                           # exit 1, 3 unmet
```

Results on this runner (root, no delegated cgroup v2):

| Run | Commit | Tests | Pass | Fail | Skipped | Todo |
|---|---|---|---|---|---|---|
| `pnpm typecheck` | baseline and branch | | passes | | | |
| workspace files | baseline `0546559` | 55 | 47 | 0 | 8 | 0 |
| `test/workspace-review.test.ts` | branch | 18 | 10 | 0 | 0 | 8 (fail by design) |
| full suite, run 1 | branch | 1948 | 1926 | 1 | 13 | 8 |
| full suite, run 2 | branch | 1948 | 1926 | 1 | 13 | 8 |
| full suite, run 3 | branch | 1948 | 1927 | 0 | 13 | 8 |
| full suite, runs 1 and 2 | baseline `0546559` | 1925 | 1917 | 0 | 8 | 0 |

* The failures in branch runs 1 and 2 were in `test/research-bootstrap.test.ts`. They were two different retry tests (`:289` and
  `:310`), each asserting curl's reset classification; one got `connect-failed (curl exit 7)` under full-suite load. This job did not
  touch that file or its code. PR #142's own commit already describes this race ("a reset that lands while curl is still connecting
  reports exit 7"). Run alone 3 times, and 3 times together with `test/workspace-review.test.ts`, it passed every time (6/6). The
  evidence points to a pre-existing load flake that the new file does not cause, but 3 branch runs against 2 baseline runs cannot rule
  out a small timing effect.
* Skipped on the branch (13): the 7 original real-sandbox tests, the 4 added ones, the requirement gate (not required in this run),
  and the `lost+found` snapshot test (needs non-root).
* gitleaks: **not run locally.** The docker CLI exists but its daemon is not running. Fetching the gitleaks binary was refused by this
  environment's permission policy, and was not retried. A manual grep of this branch's diff for key, token, JWT, private-key and
  password shapes found only commit SHAs. Test fakes are built at runtime (`"ghp_" + "Ab1".repeat(12)`). CI's gitleaks step is the
  authoritative check.

**Still needed before activation:** review of this job's test, harness and tool changes; fixes or explicit acceptance for WS-R1 to WS-R14
in a separate production change, with their own review; the section 7 VM run; the live-host checks (checklist item 3); and the operator
decisions (item 4). A clean or partly clean review does not authorize activation.

## 9. Resolution of WS-R1 to WS-R14 (job `orbit-202611190917-2nsg`, 2026-11-19)

These fixes were made by the activation job, **not** by the reviewer, and need their own review. Each finding's reproducer in
`test/workspace-review.test.ts` is now an ordinary regression test (no `todo` remains); further regressions were added for the findings
that had none. Evidence class of all of them: **U** (unit/stub). None is OS evidence; the on-host validation
(`docs/workspace-tools.md`, section 9) is where the isolation itself is checked.

| Finding | Fix | Regression test(s) |
|---|---|---|
| WS-R1 overlapping probes | Probes serialized behind one promise and generation-pinned: only the newest sets the verdict; status stays `unknown` while any is pending; per-probe random run id and scratch workspace | "WS-R1 (fixed)", "WS-R1b (fixed)" |
| WS-R2 thrown probe | A throw is a failed self-test (`unsupported`, with the error); `select.ts` logs `workspace-sandbox: <state> (<reasons>)` after recovery | "WS-R2 (fixed)" |
| WS-R3 unbounded walks | `fs_search` counts every visited entry (2,000) and stops at 3 s; `fs_list` streams at most 10,000 names (`totalIsLowerBound`); snapshot streams within its entry bound and stops at 15 s | three "WS-R3 (fixed)" tests |
| WS-R4 ledger opIds into paths | Ledger entries must have `ws-<16 hex>` ids, known states and kinds (else the ledger is refused, tools off); run ids validated and every run/cgroup path checked to be a direct child; `reap()` refuses foreign ids | "WS-R4 (fixed)" |
| WS-R5 bidi/invisible text on cards | Visible `⟨U+XXXX⟩` markers for format, bidi, zero-width and control characters; multi-line values fenced and line-prefixed; applied to summary, every display field and helper-provided plan text | "WS-R5 (fixed)", card-budget test, setup escaping test |
| WS-R6 audit privacy | Denials and results audit error codes and states only; workspace field only a configured id | "WS-R6 (fixed)" |
| WS-R7 roots under `/proc` etc. | Prefix check for `/proc`, `/sys`, `/dev`, `/etc`, `/run`, `/boot`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/root` | "WS-R7 (fixed)" |
| WS-R8 unverified tree does not block | A launched run without positive cleanup evidence (`false` **or none**) pauses exec (`cleanup_unverified`) at proposal, confirmation and dequeue, until a reap finds its cgroup gone or empty (`cleanupVerifiedAt`); restart recovery records `treeGone` only from that evidence | three "WS-R8 (fixed)" tests |
| WS-R9 path use after check | Every directory on the resolved path of bwrap/prlimit/shell must be root-owned and not group/other-writable; the launcher re-checks the root's dev/ino immediately before spawning | two "WS-R9 (fixed)" tests |
| WS-R10 self-test coverage | Transcript and `judgeProbe` check `CapEff`, `CapBnd`, `NoNewPrivs`, a private cgroup namespace and nested userns refusal; cgroup limits read back; the self-test's own tree must be confirmed gone | `workspace-config` "probe verdicts" |
| WS-R11 doc/code mismatches | Full identity and policy hash on the card; policy re-checked at dequeue; snapshot includes the root's mode | "WS-R11 (fixed)", R6 |
| WS-R12 leftover run dir | Removed when the cgroup cannot be prepared | "WS-R12 (fixed)" |
| WS-R13 `--unshare-cgroup-try` | `--unshare-cgroup` required | "WS-R13 (fixed)" |
| WS-R14 blocking cleanup wait | Asynchronous wait; `reap()` and recovery are async | "WS-R14 (fixed)" |

**Deferred or partial, stated plainly (not called fixed):**

* WS-R3: walks are **bounded**, not moved to a worker thread. A slow filesystem can still hold the event loop for up to the time
  budgets (3 s search, 15 s snapshot) per call.
* WS-R9: the workspace is still bound by **path** (`--bind`, not `--bind-fd`); the dev/ino re-check narrows the window to the
  microseconds between that check and bubblewrap's own path lookup. Only an attacker who can already rename directories next to the
  workspace root (ORBIT's user or root) could use it.
* WS-R10: host-loopback unreachability is still implied by the private network namespace (interfaces `lo` only), not probed by
  connecting to a host service; the on-host validation additionally checks that there are no routes and that a TCP attempt to a
  TEST-NET address fails.
* Section 3.1 checklist items 2-4 (separate-VM suite, live-host checks, recorded decisions) are **superseded** by the owner-approved
  on-host path (`docs/workspace-tools.md`, section 9): host setup by the separately installed helper, then a bounded validation under
  the production sandbox that enable cannot skip. The full adversarial suite (section 7) remains available as an optional offline check.
