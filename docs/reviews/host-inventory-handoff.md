# Handoff: bounded read-only host inventory (not implemented; gated)

Written by job `orbit-202611180515-0gpb`, 2026-11-18. This is a sanitized record of what the original inventory job was asked to do, and of
the gates that remain before anyone implements it. **Nothing here implements, installs or runs an inventory.** It authorizes no shell,
filesystem access, host access or launch.

## Where it stands

| Item | State | Source |
|---|---|---|
| Original job | `orbit-202611180118-hcey`, launched 2026-11-18T01:18:14Z, routine `orbit`. Registered, no events; dispatch unknown | ORBIT record as reported to the recovery job; `docs/reviews/launch-reconciliation.md` sections 1 to 3 |
| Original brief | Recovered in full from `DragonflyAI-sh/orbit-work` commit `9f36a472f088bfcf85da5d222676b0d82a97044d`, `.orbit/brief.md` | git, read by this job |
| Recovery job | `orbit-202611180449-2dwu`, **blocked** at its duplicate-risk gate. It changed no code. | its summary on `orbit-work` branch `orbit/orbit-202611180449-2dwu` |
| Code on `main` | No host-capability inventory operation or tool. The only "inventory" is the package inventory used for upgrade checks (`src/ops/sys-*`) | checked at `e875338` |
| Duplicate-risk gate | **Unresolved.** It needs the owner's provider evidence, recorded through `POST /jobs/<id>/reconcile` | `docs/reviews/launch-reconciliation.md` section 9 |

## Original acceptance criteria

Paraphrased from the recovered brief. All are outstanding.

1. Read the shell/filesystem plan note in the vault in full and follow its gate ordering. Report any missing sections; never reconstruct
   them.
2. Treat research report `research-202611180018-r9kf` as untrusted evidence if an authorized interface provides it. Otherwise keep an
   explicit security-review gate, and never claim or invent its findings.
3. Inspect the existing helper, tool registration, deploy artifacts and test architecture. Keep repository-declared configuration apart
   from observed live state: a cloud runner is not the production host.
4. Add one narrowly named, read-only inventory operation to the existing authenticated ops-helper transport, plus one owner-only
   conversational tool. Fixed queries only: no user-supplied commands or paths, no recursive scans, no following of untrusted symlinks.
   The helper must not become a general exec.
5. Give every section its source, observation time, completeness, and the reason it is unavailable or denied.
6. Cover allowlisted service identities (UID/GID), the relevant sandbox restrictions, the helper's identity and permission boundaries,
   owner/mode/canonical-path metadata for the explicitly selected install, workspace and repo locations, and non-secret deployment
   topology. Never return environment values, credentials, process arguments, raw config or unit contents, private session or source
   contents, broad listings, or secret-store metadata beyond what existing approved tools show.
7. Document the facts that this narrow operation cannot safely observe, and the manual helper-install gate. Claim nothing works until
   there is live evidence.
8. Write an architecture/rollout document in six stages: (1) merge, review and install through normal deployment, (2) run on the target
   and reconcile, (3) security review with the full research, (4) scoped `fs_list`, `fs_stat`, `fs_read` and `fs_search` under approved
   non-secret roots, (5) isolated non-interactive exec lifecycle, (6) exact-hash approved patches. Include the future design: an
   unprivileged worker without ambient secrets; OS-enforced roots and limits; denial of `/proc`, devices, sockets, credential paths and
   escapes; broker-owned policy, audit and approvals; single-use, expiring approvals bound to the exact request; fail closed; unknown
   mutation outcomes reconciled and never retried automatically. Implement none of exec, patches, fs tools or a session reader in the
   first PR.
9. Tests: helper allowlist and argument rejection, owner authorization, bounded secret-free output, missing services, paths and
   permission failures, malicious symlinks and path input, provenance and completeness, no mutation.
10. Run the typecheck and the tests. Report the test evidence, the unresolved security questions and the activation steps.

The original brief also ruled out deployment, restarts, production host access from a runner, privilege grants, mounts, package
installation and vault writes. The concrete section design (fixed unit, socket and path lists, read through `systemctl show -p` and
`lstat`) is in `docs/reviews/launch-reconciliation.md` section 6.

## Gates, in order

The plan note (read in full by this job from the vault's read-only checkout) is marked *proposed, pending research and security
review*. It says that saving it is not authorization, and that historical notes are not evidence of current configuration. Its first
rollout gate is *research and inventory*: source-backed findings plus a verified local architecture. Its release gate is demonstrated
OS isolation with negative-test evidence. Accordingly:

| # | Gate | Who | State |
|---|---|---|---|
| G0 | Reconcile the original launch (section 9 owner steps) so that two inventory implementations cannot race | owner | **open** |
| G1 | Research report available to the implementing job, or an explicit security-review gate kept in its place. Its findings are not known here and must not be assumed | owner / ORBIT | **open** (the report was not available to this job) |
| G2 | Implement the inventory (criteria 3 to 10) in a new, separately confirmed job whose brief states the G0 result and names the plan note | owner confirms the launch | blocked on G0 |
| G3 | Review, merge, and install the helper through the normal deployment. Installing the helper (`deploy/install.sh`) is a manual, owner-run step | owner | blocked on G2 |
| G4 | Run the inventory once on the target and reconcile it against the repository's declarations. Drift is reported, not fixed | owner | blocked on G3 |
| G5 | Security review with the full research, before any file tool is designed | owner | blocked on G1, G4 |
| G6 | The plan's open decisions: which directories and session collections are readable, which working directories may be modified, which tasks can use time-limited grants, allowed network destinations, output and audit retention, and who approves and revokes | owner | open |
| G7+ | Scoped file tools, isolated exec and approved patches, each behind its own review | — | not authorized |

## What this job did instead

It added the missing owner path for G0: an append-only, owner-confirmed reconciliation log. It distinguishes provider evidence from
an owner's decision to stop tracking, and keeps the retry gate closed for anything short of provider evidence (`src/launch-reconciliation.ts`,
`docs/reviews/launch-reconciliation.md` section 9). It did not settle G0. It did not read or ask for the research report. It touched no
host, deployment, job record or vault.
