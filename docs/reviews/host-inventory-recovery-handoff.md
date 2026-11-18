# Recovery and readiness handoff: bounded host inventory (recovery step only)

Written by job `orbit-202611180656-xyro` on 2026-11-18, against `main` at `efbf2cd` (#133). This is the first recovery step for
launch reliability and retry/pagination. It does not implement, install or run a host inventory, start a replacement job or begin the
fallback audit. Each of those needs a separate owner confirmation. Nothing here authorizes shell, filesystem, host or production access.

This document adds to two existing documents and does not replace them: `docs/reviews/launch-reconciliation.md` (diagnosis, owner
workflow, inventory section design in section 6) and `docs/reviews/host-inventory-handoff.md` (gates G0 to G7). Both are still current.
Where this document differs, it says why.

## 1. Source recovery

All sources were found by listing git trees (`git show --stat`, `git ls-tree -r`). No filenames were guessed. Hashes are SHA-256 of the
exact bytes.

| Artifact | Source | Size | SHA-256 | Completeness |
|---|---|---|---|---|
| Original brief, job `orbit-202611180118-hcey` | `DragonflyAI-sh/orbit-work` commit `9f36a472f088bfcf85da5d222676b0d82a97044d`, `.orbit/brief.md` (the only file that commit changes; parent `9459edf`) | 4,875 bytes, 5 lines | `e9c48f344650ff255cfb8e7f742a9dcaaa4be084681015842610ede66b8dea25` | **Complete.** Verbatim in [Appendix A](#appendix-a-original-brief-orbit-202611180118-hcey). Nothing redacted. |
| Recovery brief, job `orbit-202611180449-2dwu` | same repo, commit `bb60b668777be94a41b479f5161119a16c95c55a`, `.orbit/brief.md`. Unchanged at `edf7663` | 4,151 bytes | `48482a3c7d087cda5a94a1dc03daf34781b31ca4f51182b12b5ec5bd3441fde9` | **Complete.** Verbatim in [Appendix B](#appendix-b-recovery-brief-orbit-202611180449-2dwu). Nothing redacted. |
| Recovery summary (blocked), job `orbit-202611180449-2dwu` | same repo, branch `orbit/orbit-202611180449-2dwu` = commit `edf766362de85f8b574f4bf864255c99b9700a08`, `.orbit/summary.md`. Same tree: `brief.md`, `checkins.jsonl` (2 lines), `started.json`, `README.md` | 6,909 bytes, 6,903 characters. Body after front matter, trimmed: **6,852 characters** | `36a0071251c6d0c5bde0e6333cc68d3e191d3c5848bc3b7cb18125cfaf642a1a` | **Complete.** The 6,852-character body matches the figure chat reported. Verbatim in [Appendix C](#appendix-c-recovery-summary-orbit-202611180449-2dwu). Nothing redacted. |
| Plan note `Resources/orbit-shell-filesystem-access-plan.md` | `phairow/orbit-vault`, from the read-only sparse checkout in the runner session. This checkout may lag the vault | 9,967 bytes | `bc6d4ff7676083be0d4acf05fdb999222baded31b4e7bc03aca468b6be218cd5` | **Read in full:** front matter, sections 1 to 10 and "Next step". It is not copied here; the vault is private. Only short facts used for gating appear below. |
| Research report `research-202611180018-r9kf` | **Not recovered.** Research jobs have no `orbit-work` branch, by design (`src/research.ts`, isolation check). ORBIT keeps reports in its own state directory (`<state>/research/<job>.md`, `src/research.ts:291`). No `orbit-work` ref names this job. No authorized artifact available to a runner exposes the report | the original brief reports 41,883 characters, 39 sources, SHA-256 `e8a3bab5…451b`. **Unverified here** | — | **Missing.** Its contents are unknown to this job and are not summarized or assumed. The security-review gate stays (section 4, G1). |

Git state, checked during this job: on `orbit-work`, `orbit/orbit-202611180118-hcey` still points at `9f36a47`. On `DragonflyAI-sh/orbit`,
no branch has that name, and no `orbit/*` branch head mentions a host-capability inventory. The one "inventory" match is the dpkg package
inventory from 2026-11-10. On `main`, the only inventory code is the package inventory in `src/ops/sys-protocol.ts` and
`src/ops/sys-run.ts`. The read-only helper's allowlist is still `orbit_status, orbit_logs, deploy_state, host_health, tailscale_status,
vault_sync, credentials` (`src/ops/protocol.ts:12`). **No inventory work exists to duplicate.**

### Why chat saw only part of these texts (code-backed)

* **Vault notes.** `memory_read` returns the whole note (`src/memory.ts:171-179`). Every tool result is then cut at
  `MAX_OUTPUT_CHARS = 8000` (`src/agent.ts:23`, `clipOutput` at `src/agent.ts:214`, applied at `src/agent.ts:539`). The plan note
  becomes 10,203 characters once JSON-escaped. Its "## 8." heading starts at escaped offset 7,335 and "## 9." at 8,054, before the
  result envelope is even counted. So no `memory_read` of this note can reach section 9. That matches "sections 1–7 and part of 8".
  There is no offset or page argument.
* **Job summaries.** `job_status` gives the model the summary's size, state, channel and time, never its text
  (`src/job-view.ts:53-55`). The full text is shown only on the Jobs page.
* **Research reports.** `research_result` cuts the report to 6,000 characters (`textTruncated: true`), with no offset
  (`src/research-tools.ts`, `research_result`).

## 2. Launch, retry and pagination: what is enforced on `main` now

### Fixed, with code and tests

| Concern | Enforcement | Tests |
|---|---|---|
| Dispatch evidence was not persisted before the fire (W1/W3 blind spots) | #122: `fireStartedAt` and `toolCommitSent` are written before the fire request, and fire failures are classified (`src/job-launch.ts`, `src/launcher.ts` `RoutineFireError`). `dispatchEvidence()` (`src/launch-evidence.ts:67`) reads a record with no `fireStartedAt` as `legacy`, and never takes a missing field as proof of no dispatch | `test/launch-evidence.test.ts`, which includes the reported shape of `orbit-202611180118-hcey` (line 194) |
| Different readers disagreed about a launch, and any `failedAt` counted as ended | #125: one reading, `launchOutcome()` (`src/launch-evidence.ts:113`). Only `never-dispatched` and `provider-rejected` count as not launched. Everything else without runner events is `unresolved` | `test/launch-outcome.test.ts` |
| Retrying an unresolved launch could run the work twice | `plan()` (`src/work-sessions.ts:209-262`) refuses a `retry` attachment for `runner-active` and for `unresolved` launches unless the owner's reconciliation reading allows it. An unreadable store or log answers 503 | `test/launch-reconciliation.test.ts:314` |
| No way to record what the owner finds in the provider's records | #132: owner-only, two-step (preview, then a confirm bound to a digest), append-only `POST /jobs/<id>/reconcile` (`src/launch-reconciliation.ts`, `src/server.ts:1166`). The job record is never changed | `test/launch-reconciliation.test.ts` |
| A `provider-no-run` window anchored to `launch.at` could miss the real fire, and corrupt log entries were skipped silently | #133: the window must cover `fireStartedAt` − 5 min to the recorded fire end + 15 min (`dispatchBounds`, `noRunProblem`, `src/launch-reconciliation.ts:299-334`). Legacy, interrupted and inconsistent records fail closed. Entries are checked at every reading, and the whole log fails closed (503) on any integrity problem | `test/launch-reconciliation-safety.test.ts` |
| Long tool output in chat | Paging exists where it was built: `session_read` cursors (`src/sessions.ts`), PR inspection by explicit offset (`src/pr-inspect.ts:21`, #131 continuation), and per-read paging state in omitted history (#127, `pageCursor` in `src/assistant-context.ts:73`) | the respective suites |

This job adds `test/legacy-launch-disposition.test.ts`, a characterization test with no production change. It pins how the current code
treats a legacy record shaped like `orbit-202611180118-hcey`, as described in section 3.

### Outstanding: found or confirmed here, not fixed (each needs its own confirmed job)

| # | Issue | Evidence | Effect |
|---|---|---|---|
| O1 | **A new, unattached launch is never checked against the reconciliation.** `plan(undefined)` returns `{attachment: "new"}` without reading the job store or the log (`src/work-sessions.ts:210`). The only check is the duplicate-launch *warning* (`src/duplicates.ts`: briefs launched in the last 24 hours, Jaccard ≥ 0.7, never blocks) | pinned by `test/legacy-launch-disposition.test.ts`, last case | The retry gate guards only `attach.as = "retry"`. A replacement inventory job launched as new work passes no code gate. The duplicate-risk decision belongs to the owner alone |
| O2 | The shutdown handler does not wait for launches in flight, so new W3 cases (ORBIT stops mid-fire) stay possible (F4) | `src/main.ts:188-192` | already documented in `launch-reconciliation.md` sections 4 and 9 |
| O3 | `memory_read` cannot page. Notes longer than about 8,000 escaped characters are cut for the model | section 1 above | vault plans and briefs reach chat truncated. This job exists partly because of that |
| O4 | Chat cannot read a full job summary (`job_status` gives no text) or a report over 6,000 characters (`research_result`, no offset) | section 1 above | summaries and reports reach chat only in part. The full text is on the Jobs page or in the state directory |
| O5 | A legacy record (no `fireStartedAt`) can never be closed with `provider-no-run` | `dispatchBounds`, `src/launch-reconciliation.ts:301` | applies to `orbit-202611180118-hcey`. Documented in `launch-reconciliation.md` section 9, Limitations |
| O6 | The reconciliation is shown only by the JSON routes and the retry gate, not by the not-started alert, the work-session views or the Jobs page | `launch-reconciliation.md` section 9, Limitations | — |

## 3. Disposition of the original launch `orbit-202611180118-hcey`

**The historical outcome is unknown.** Neither this job nor the earlier ones could read the provider's run history or the live job
record. The owner reports "no jobs are active". That is recorded here as **the owner's current-status report**, relayed in this job's
brief. It is not provider evidence, and it does not prove the 01:18Z fire never created a session: a session that ran and ended is also
"not active", and could have pushed work somewhere this job cannot see. This job did not reconcile, cancel, retry, steer or mark the
job, and did not change any live record.

As this job's brief reports it, the record has a brief commit, no `fireStartedAt`, no `sessionId`, no failure and no events. The code
reads that as `record: legacy`, `dispatch-unknown`, outcome `unresolved`.

**What the existing owner-confirmed workflow (`POST /jobs/<id>/reconcile`, preview then confirm) permits for this record.** Each row
is traced to code and pinned by `test/legacy-launch-disposition.test.ts`:

| Owner records | Accepted? | Reading | Work-session retry |
|---|---|---|---|
| nothing | — | `none` | refused, 409 `unresolved (dispatch-unknown)` |
| `provider-no-run`, any window | **refused, 409** ("no fire-start time"), nothing written | — | — |
| `abandon-tracking` (the only kind that fits an owner report without provider evidence; any evidence field is refused) | yes | `tracking-abandoned`, job record unchanged byte for byte | refused, 409 ("residual duplicate risk") |
| `provider-session-running`, with a session id found by the owner | yes | `provider-confirmed-running` | refused |
| `provider-session-ended`, output `pushed` or `unknown` | yes | `provider-confirmed-ended` | refused: recover the output first |
| `provider-session-ended`, output `none` | yes | `provider-confirmed-ended` | **allowed**, with its own confirmation |

**What the workflow cannot establish.** It cannot verify anything the owner reports (the reading always says it is unverified). It
cannot show that no session ran for a legacy record, because no window can be shown to cover a fire whose start time was never
recorded. It cannot detect a session that ran and pushed somewhere other than the job's branches. And because of O1, it governs only
the work-session retry path, not a fresh launch.

**So the workflow cannot authorize a retry on the owner's "no jobs are active" alone.** A replacement needs exactly one of these owner
decisions, and none is taken here:

1. **Provider evidence of an ended session.** Look at the `orbit` Routine's run history for 2026-11-18 01:18–01:19Z (steps in
   `launch-reconciliation.md` section 9). If a session for `orbit-202611180118-hcey` is listed and has ended with no output, record
   `provider-session-ended` with output `none`. The work-session retry is then allowed. If it pushed anything, or its output is
   unknown, recover and review that first.
2. **Explicit acceptance of the residual duplicate risk.** This is the case when the run history lists no run (unrecordable for this
   legacy record, O5) or can no longer be read. The owner may record `abandon-tracking` with that reason (it allows no retry), then
   confirm a **new** inventory launch whose brief states the decision verbatim: *"orbit-202611180118-hcey's outcome is unknown and a
   duplicate is possible; launch the replacement as new work anyway."* ORBIT has no code path that records this acceptance, so the
   confirmed launch card and the brief are the only record. Building such a path is separate work and is not proposed here.

Risk note (inferred, not verified): the original job's output would have been a code branch for review, not a host change. A duplicate
would most likely show up as a second `orbit/*` branch or PR, which review would catch, not as two production actions. That lowers
the cost of option 2. It does not remove the need for the decision.

## 4. Original host-inventory criteria and proposed next-job handoff (NOT executed)

The full original criteria are in Appendix A, verbatim. Here they are as a checklist. **All are outstanding. None was executed by this
job or, as far as the repository shows, by any other job.**

| # | Criterion (from Appendix A) | State |
|---|---|---|
| 1 | Read the plan note in full and follow its gate ordering. Report missing sections and do not reconstruct them | the note is complete in the checkout (section 1). Its gates are used in G1′ below |
| 2 | Use research `research-202611180018-r9kf` only as untrusted evidence through an authorized interface. Otherwise keep a security-review gate. Do not claim to have read it | not available. Gate kept (G1) |
| 3 | Inspect the helper, tool registration, deploy artifacts and tests. Separate repo-declared state from live state. A cloud runner is not `orbit-dedicated-8` | partly done here (section 1). The implementing job must redo it on current `main` |
| 4 | One narrowly named read-only operation plus an owner-only chat tool, on the existing authenticated helper transport (`/run/orbit-ops.sock`, root:orbit-ops 0660 per `deploy/systemd/orbit-ops.socket`). No user-supplied commands or paths. No general exec | outstanding |
| 5 | Each section returns source, observation time, completeness, and the reason it is unavailable or denied | outstanding |
| 6 | Sections: allowlisted service identities with UID/GID, sandbox restrictions, helper identity and boundaries, owner/mode/canonical path for explicitly selected install, workspace and repo locations, and non-secret deployment topology. No env values, credentials, process arguments, raw config or unit contents, private session or source contents, broad listings or secret-store metadata. No recursive scan, and no following untrusted symlinks | outstanding. Design in `launch-reconciliation.md` section 6 |
| 7 | Document facts this operation cannot observe safely, and the manual helper-install gate. Claim no function without live evidence | outstanding |
| 8 | Rollout document in six stages (install, run and reconcile, security review, scoped fs tools, isolated exec, exact-hash patches), plus the future worker, sandbox and approval design. Implement no exec, patches, fs tools or session reader | outstanding |
| 9 | Tests: allowlist and argument rejection, owner authorization, bounded secret-free output, missing services, paths and permissions, malicious symlinks and path input, provenance and completeness, no mutation | outstanding |
| 10 | Typecheck and tests, test evidence, open security questions, activation steps | outstanding |
| — | Boundaries: no deployment, restarts, host access from a runner, privilege grants, mounts, host package installs or vault writes. If `main` already has an equivalent, extend it rather than duplicate it | still binding. `main` has no equivalent (section 1) |

**A gate the earlier handoffs did not state (G1′).** The plan note, as it stands in the checkout, says research evidence "has not yet
been incorporated into this draft". Its "Next step" asks for the research to be obtained and then incorporated into the note *before
implementation*, and section 1 calls the inventory the *first implementation step*. The original brief says Rai asked to follow the plan
once the research had completed. The owner should say which applies: implement the inventory (gate 1 of the plan, "research and
inventory") alongside the research review, or incorporate the research into the note first. The checkout may lag the vault, so the
note may already have changed.

**Proposed next job: implement only, not run.** The owner confirms it separately, after G0 is decided as in section 3. Brief skeleton:

* *Preconditions stated in the brief:* the G0 decision (option 1 or 2 above, verbatim); the G1/G1′ decision (is the research
  available as untrusted evidence, or does the security-review gate stay); the plan note named as authorized vault reading.
* *Scope:* criteria 3 to 10 only, from current `main`. First check that no branch or PR implements an inventory. One action on the
  existing `orbit-ops` helper and one owner-only tool next to `ops_host_health`. Fixed lists declared in the repository (units, sockets
  and paths per `launch-reconciliation.md` section 6), read only with `systemctl show -p <fixed list>` and `lstat`. Matching mount
  flags by path only. No arguments. Keep the response under the helper's `MAX_RESPONSE_BYTES` (32 KiB, `src/ops/protocol.ts`). Each
  section has `{source, observedAt, complete, unavailable?}`. Every value is labelled `repo-declared` or `host-observed`.
* *Boundaries, unchanged:* everything in the original brief. Also: the cloud runner is not the production host, synthetic fixtures
  only, no gitleaks-shaped literals.
* *Done:* code, tests and a rollout document, with the helper install (`deploy/install.sh`) left as a manual owner step (G3), and the
  first live run and reconciliation left to the owner (G4).

## 5. Later fallback audit (outline only; not started)

A separate, owner-confirmed job should check how tools are enforced on the OpenRouter fallback **in code**, not assume what the
fallback can or cannot do. Since #126 the fallback is offered the caller's whole tool list, unchanged (`src/fallback.ts:17-18`,
`:164-167`). An inventory tool would therefore also be offered to it.

1. List the tools each caller offers (chat threads, Assistant, legacy `/chat`, background callers). Confirm `fallback: true` is set only
   for the interactive owner chat (`src/agent.ts:228`, `src/fallback.ts:235-240`).
2. For each tool that mutates or proposes, trace the safeguard to the place it runs (owner route checks and `decide`, `allowAgent`
   policy and audit, single-use confirmation cards, per-tool policy, spend caps and ledger, photo blocking). Show that none depends on
   which model asked.
3. Read the existing evidence, not just the docs: `test/fallback-parity.test.ts`, `test/fallback-availability-followups.test.ts`,
   `docs/reviews/openrouter-fallback-audit.md`. Add negative tests where a safeguard has none.
4. Once an inventory tool exists, add a parity case: same owner gate, same bounded output, same refusal of arguments on both routes.
5. Report gaps as findings for separately confirmed fixes. The audit changes no code.

## 6. Next confirmation boundary

In order. Each step needs the owner, and nothing here starts any of them:

1. **G0:** option 1 or option 2 in section 3, for `orbit-202611180118-hcey`.
2. **G1/G1′:** the research report's availability, and whether the plan note must incorporate it before implementation.
3. **Launch** the implement-only inventory job (section 4) as new work, with a brief that states both decisions.
4. Later and separately: review, merge and install (G3), first live run (G4), security review (G5), the fallback audit (section 5),
   and any fix for O1 to O6.

## 7. Checks run by this job

On branch `orbit/orbit-202611180656-xyro` from `main` `efbf2cd`, after `npm install --no-save` (there is no lockfile):
`npm run typecheck` exited 0. `npm test` (`node --test test/*.test.ts`) ran 1,759 tests: 1,759 passed, 0 failed, 0 skipped. That count
includes the 5 new tests in `test/legacy-launch-disposition.test.ts`. No production source file was changed.

In Appendices A and B, the source files have no trailing newline. The closing fence comes immediately after the source text, and each
block's text matches the file byte for byte.

---

## Appendix A: original brief, `orbit-202611180118-hcey`

Source: `DragonflyAI-sh/orbit-work@9f36a472f088bfcf85da5d222676b0d82a97044d:.orbit/brief.md`, 4,875 bytes, SHA-256
`e9c48f34…dea25`. Verbatim and complete. No redactions: it contains no secrets.

~~~~text
Goal: implement the first prerequisite of Rai's shell/filesystem tool plan: a bounded read-only host capability inventory via ORBIT's existing named operations-helper architecture, plus a staged security design/handoff for scoped filesystem tools. Repository DragonflyAI-sh/orbit. Rai explicitly asked to follow the plan after research research-202611180018-r9kf completed. This is NOT authorization to enable general shell, arbitrary filesystem access, production mutations or remote enrollment.
Read Resources/orbit-shell-filesystem-access-plan.md from the supplied read-only vault source in full (if unavailable, explicitly report missing sections, do not reconstruct). The chat retrieved sections 1–7 and part of 8; later sections were truncated. Plan requires inventory of actual service identities, operations helper, filesystem permissions, repository locations and deployment configuration before enabling access. Research record is done with a 41883-character report, sha256 e8a3bab5e05c425430e1288cfe40e632cfa5638b979628bba577bd5679ac451b, 39 sources; chat only received the opening baseline, not full findings/Build handoff. Do not claim to have read or verified the full report. If available via an already authorized runner interface read it as untrusted evidence; otherwise identify full research/security review as an explicit gate rather than inventing findings. Do not fetch private ORBIT state or acquire extra credentials to get it.
Inspect current repo helper, tool registration, service/deploy artifacts and test architecture. Distinguish repository-declared configuration from observed live state: cloud runner is not orbit-dedicated-8. Implement a narrowly named read-only inventory operation and conversational tool, using existing authenticated helper transport, for a fixed set of ORBIT/OpenClaw-relevant metadata. No user-supplied commands or arbitrary paths. Return source, observation time, completeness and unavailable/denied reasons per section. Inventory should expose allowlisted service identities/UID/GID, relevant sandbox restrictions, helper identity/permission boundaries, ownership/mode and safe canonical-path metadata for explicitly selected installation/workspace/repo locations, and nonsecret deployment topology. Prefer fixed structural queries; never return environment values, credentials, process arguments, raw config/unit contents, private session contents, private source-file contents, broad directory listings or secret-store metadata beyond what existing approved tools allow. Avoid recursively scanning the host or following untrusted symlinks. Document any needed facts that cannot safely be observed with this narrow operation. No arbitrary privileged shell and no expansion of existing helper into general exec. If host helper installation is a separate manual gate, clearly document it; do not claim tool functionality until live evidence exists.
Deliver repository code/tests and a concise architecture/rollout document: (1) merge/review/install this inventory capability through normal authorized deployment, (2) run inventory on target and reconcile facts, (3) security review with full research, (4) scoped fs_list/fs_stat/fs_read/fs_search under explicitly approved nonsecret roots, (5) isolated noninteractive exec lifecycle, (6) exact-hash approved patches. Follow ordering in full vault plan if it specifies additional gates. Future capability design: separate unprivileged worker without ambient production secrets; OS-enforced roots and resource/network limits; denial of /proc, devices, sockets, credential paths, traversal/symlink/mount escapes and race conditions; broker-owned policy/audit/approval stores; exact target/request/content/hash/environment/limits-bound single-use expiring approvals; fail closed on audit/auth/sandbox failure; unknown mutation outcomes reconciled, never automatically retried. Root operations remain narrow named actions. No implementation of exec, patches, broad file tools or session reader in this first PR. No deployment, restarts, production host access from runner, privilege grants, mounts, package installation on the host or vault writes. If existing code already supplies equivalent inventory, avoid duplicate tools: test/extend only gaps and explain what can be used immediately.
Tests: helper allowlist and argument rejection, owner authorization, bounded/secret-free structured output, missing services/paths/permission failures, malicious symlinks/path input, provenance/completeness and no mutation. Run the typecheck and the tests before finishing. Report exact test evidence, unresolved security questions and concrete activation steps. Push only to the branch orbit/<job-id>; never open, edit or comment on a pull request (ORBIT opens it). End the job summary with `## PR title` and `## PR body` sections. Put no secrets in code, commits or the summary.
~~~~

## Appendix B: recovery brief, `orbit-202611180449-2dwu`

Source: `DragonflyAI-sh/orbit-work@bb60b668777be94a41b479f5161119a16c95c55a:.orbit/brief.md`, 4,151 bytes, SHA-256 `48482a3c…fde9`. Verbatim
and complete. No redactions.

~~~~text
Goal: safely recover the original bounded host-inventory work for DragonflyAI-sh/orbit without duplicating an ambiguous launch. This is a gated repository recovery/implementation task, not public-web research or authorization to operate the production host.
Verified ORBIT evidence at 2026-11-18T04:47Z: original job orbit-202611180118-hcey is registered, events empty, toolCommit unknown; dispatch state dispatch-unknown. Its brief commit is 9f36a472f088bfcf85da5d222676b0d82a97044d, branch orbit/orbit-202611180118-hcey, routine orbit, launch time 2026-11-18T01:18:14.824Z. No provider answer or failure was recorded. Absence of callbacks is NOT evidence no cloud session exists. Work session work:e2635fd8-46ce-4818-b6a7-83ed04df1b1c records ambiguous launch. Do not retry or alter that job.
Phase 1, mandatory gate: use the authorized orbit-work checkout/history to recover the COMPLETE original brief at the specified commit. Locate it rather than assuming a filename. Read authorized repository artifacts for that job and any existing implementation/PR. Check available read-only provider/session evidence if accessible. No live job token or secret reads, no credential discovery, no privilege escalation. Distinguish repository evidence from actual provider execution evidence: a missing branch or commit does not establish non-launch. Report original goals, acceptance criteria, existing artifacts, and whether duplicated work can be ruled out. If full brief cannot be recovered, or potentially active duplicate work cannot be ruled out from reliable evidence, STOP before implementing the inventory. Return a concise reconciliation report and precise owner action/evidence needed; do not claim recovery completed or manufacture a code change.
Phase 2 ONLY if phase 1 establishes the original work is not active and identifies outstanding original acceptance criteria: work from current main and complete only that recovered original scope. Earlier conversation described metadata-only inventory of service identities, sandbox restrictions, helper permissions, approved paths/mounts, and deployment separation. This description is partial, NOT the original brief and must not substitute for it. Inventory access to the production host must remain bounded/read-only through existing authorized fixed helpers; a cloud runner's host is NOT the production host. If the original task requires implementing a read-only helper/tool, preserve fixed allowlists, bounded output, redaction, authorization, and existing confirmation boundaries. Do not introduce arbitrary shell execution, arbitrary paths, recursive private-file scans, or broader privileges. Distinguish repo-configured expectations from live verified metadata. If live verification is unavailable, mark it unverified with a safe validation handoff, never fabricate host results.
Constraints: no deployments, merges, restarts, installs, permission changes, live config changes, host writes, reading file contents containing credentials/private data, or changes to original job records. No vault writes. Do not duplicate ongoing Jobs UI work or separate fallback work. No automatic retry of any ambiguous launch. If recovered original scope exceeds these constraints, report the conflict and stop for clarification.
Done: source-linked recovery evidence with full original acceptance mapping; explicit duplicate-risk gate result; either bounded implementation plus regression tests and validation handoff, or honest blocked reconciliation with next required evidence. Run the typecheck and the tests before finishing; report exact commands and results (or precise inability), inspected main SHA, and remaining limitations. Put no sensitive host metadata into a public repository; keep code/tests synthetic and sanitize the summary.
Push only to the branch orbit/<job-id>; never open, edit or comment on a pull request (ORBIT opens it). End the job summary with `## PR title` and `## PR body` sections; if blocked/no changes, explain that clearly in those sections rather than inventing a PR. Run the typecheck and the tests before finishing. Put no secrets in code, commits or the summary.
~~~~

## Appendix C: recovery summary, `orbit-202611180449-2dwu`

Source: `DragonflyAI-sh/orbit-work@edf766362de85f8b574f4bf864255c99b9700a08:.orbit/summary.md`, 6,909 bytes, SHA-256 `36a00712…1a1a`.
Verbatim and complete, including front matter. No redactions. Its statements are as of 04:54Z; sections 1 to 3 above supersede its
description of `main`. Since it was written, #129 to #133 merged, and the vault plan note was read by later jobs.

~~~~markdown
---
status: blocked
at: 2026-11-18T04:54:20Z
---

**Blocked at the Phase 1 gate. No inventory was implemented and no code was changed or pushed.** I recovered the original brief in full. Duplicate work by the original launch still can't be ruled out with reliable evidence: the repository shows no trace of an active session, but I could not read the provider's session record, and only that record decides the question. I did not retry, steer, cancel or change job orbit-202611180118-hcey or its records.

## Phase 1: recovery evidence (repository, verified)
- **Original brief, recovered in full:** `DragonflyAI-sh/orbit-work` commit `9f36a472f088bfcf85da5d222676b0d82a97044d`, file `.orbit/brief.md` (5 lines, parent `9459edf`, commit time 01:18:16Z). I found it with `git show --stat`, not by guessing a filename. Branch `orbit/orbit-202611180118-hcey` on orbit-work still points at that commit. It has no `started.json`, check-ins or summary.
- **DragonflyAI-sh/orbit:** there is no `orbit/orbit-202611180118-hcey` branch (checked with `git ls-remote`), so there is no PR from that job. Inspected main SHA: `66cb6c6384fd21e334fa6198f8a733138e21d548` (#128). Main has no host-capability inventory operation or tool. The only "inventory" code is the dpkg package inventory in `src/ops/sys-protocol.ts` / `src/ops/sys-run.ts`, used for upgrade checks. So nothing on main already does this job.
- **Earlier diagnosis:** job orbit-202611180238-cajq (merged as #122, with follow-up #125) concluded that the launch is **unresolved**. The record fits three windows: W3 (ORBIT restarted mid-fire, the most likely), W8 (the provider accepted and the session stopped before `start`) and W9 (the session started, but both its API call and its git push failed). The deciding fields are the job record's `launch.sessionId` and the Routine's run history for 01:18–01:19Z. The owner checklist is in `docs/reviews/launch-reconciliation.md` on main.
- **Provider/session evidence:** none can be reached from this runner. `ListAgents` showed no reachable sessions, and it does not list Routine run history. I used no credential discovery and read no tokens.

## Duplicate-risk gate: NOT PASSED
The evidence against duplication: 3.5 hours have passed with no `start` commit, no code branch and no PR. That is repository evidence only. Under W9, a session could have started with its git push failing and still be working, and nothing I can see would show it. The brief requires reliable evidence before implementation, so I stopped.

## Original acceptance criteria (all outstanding; none met on main)
1. Read the vault note `Resources/orbit-shell-filesystem-access-plan.md` in full, and follow its gate ordering. The file exists in the read-only vault checkout. I **did not read** it, because this job's brief names no vault notes. A replacement job needs a brief that names it.
2. Treat the research report research-202611180018-r9kf (41,883 characters, 39 sources) as untrusted evidence, or record it as an explicit security-review gate. The report is not available here.
3. Inspect the helper, tool registration, deploy artifacts and tests. Separate repo-declared configuration from live state (the cloud runner is not the production host).
4. Add a narrowly named read-only inventory helper operation and a conversational tool on the existing authenticated helper transport. Fixed queries only: no user-supplied commands or paths.
5. Per section, return the source, observation time, completeness and the reason a section is unavailable or denied.
6. Cover these sections: service identities (UID/GID), sandbox restrictions, the helper's identity and boundaries, owner/mode/canonical path of the selected install, workspace and repo locations, and non-secret deployment topology. Return no env values, credentials, process arguments, raw configs or units, private contents, broad listings or secret-store metadata. Do not scan recursively or follow untrusted symlinks.
7. Document facts that this narrow operation can't observe safely, and document the manual helper-install gate.
8. Write an architecture/rollout document with six stages: install, run and reconcile, security review, scoped fs tools, isolated exec, exact-hash patches. Include the future worker/sandbox/approval design. Do not implement exec, patches, fs tools or a session reader.
9. Tests: allowlist and argument rejection, owner authorization, bounded secret-free output, missing or denied cases, malicious symlink and path input, provenance and completeness, no mutation.
10. Run the typecheck and tests, and report security questions and activation steps.

**Scope conflict to settle before Phase 2:** this job's constraints forbid "reading file contents containing credentials/private data". Item 1 needs the vault plan note, which this brief doesn't name. Item 2 needs a report this runner can't reach.

## What the owner needs to do (read-only)
1. Look up the live job record for `orbit-202611180118-hcey` and check whether `launch.sessionId` is present.
2. Open the Routine `orbit` run history for 2026-11-18 01:18–01:19Z and see whether a session was created. If one was, check that it has ended and whether it pushed anything.
3. Once there is evidence that no session exists, or that the session has ended without output, start a replacement job. Its brief should (a) state the reconciliation result, (b) name the vault note `Resources/orbit-shell-filesystem-access-plan.md`, and (c) say whether the research report is available or must stay a gate.

## Checks (main 66cb6c6, unmodified)
- `npm install --no-save` (there is no lockfile, so `npm ci` failed; this added only typescript and @types/node, in the runner)
- `npm run typecheck`: exit 0
- `node --test test/*.test.ts`: 1670 tests, 1670 pass, 0 fail
- gitleaks: not run, because nothing was committed or pushed to a code repo.

## Notes
- `orbit-job start` reported `api=failed`. The first check-in was `api=sent` and the second `api=failed`. Every git push succeeded.
- I read no vault note contents; I only checked that the file exists. I accessed no production host.
- I did not touch the unrelated Jobs UI job orbit-202611180426-9usk, which is in progress with no summary.

## PR title
No PR: host-inventory recovery blocked at the duplicate-risk gate

## PR body
There is no pull request for this job. No code branch was pushed and no repository files changed. The original brief for orbit-202611180118-hcey was recovered in full from orbit-work commit 9f36a472f088bfcf85da5d222676b0d82a97044d. Main (66cb6c6) has no equivalent host inventory. Whether the original launch has a live or finished provider session can't be verified from the runner. Until the owner checks that job's `launch.sessionId` and the Routine run history for 01:18–01:19Z, implementing the inventory could duplicate it. The baseline on main passes: the typecheck exits 0 and 1670/1670 tests pass.
~~~~
