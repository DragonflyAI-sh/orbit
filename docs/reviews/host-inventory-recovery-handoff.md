# Recovery and readiness handoff: bounded host inventory (recovery step only)

Written by job `orbit-202611180656-xyro` on 2026-11-18, against `main` at `efbf2cd` (#133). This is the first recovery step for
launch reliability and retry/pagination. It does not implement, install or run a host inventory, start a replacement job or begin the
fallback audit. Each of those needs a separate owner confirmation. Nothing here authorizes shell, filesystem, host or production access.

This document adds to two existing documents and does not replace them: `docs/reviews/launch-reconciliation.md` (diagnosis, owner
workflow, inventory section design in section 6) and `docs/reviews/host-inventory-handoff.md` (gates G0 to G7). Both are still current.
Where this document differs, it says why.

**Revised by job `orbit-202611180913-8w13` (public-safety revision).** The version merged in #134 reproduced private texts (job
briefs, a job summary, and details of a private vault note) and is superseded by this one. This revision keeps only the provenance an
authorized reader needs to find the private records, and a summary of the criteria. Section 8 says what this revision cannot undo.

## 1. Source recovery

The recovery job found every source by listing git trees; no filenames were guessed. This public document says where each source is
for a reader authorized to see the private records. It does not reproduce, quote, hash or measure them.

| Artifact | Where an authorized reader finds it | State when the recovery job read it |
|---|---|---|
| Original brief, job `orbit-202611180118-hcey` | the private control repository (`orbit-work`), commit `9f36a47`, `.orbit/brief.md` | complete |
| Recovery brief, job `orbit-202611180449-2dwu` | `orbit-work`, commit `bb60b66`, `.orbit/brief.md` | complete |
| Recovery summary (blocked), job `orbit-202611180449-2dwu` | `orbit-work`, branch `orbit/orbit-202611180449-2dwu`, `.orbit/summary.md` | complete |
| The plan note the original brief names | the owner's private vault; the original brief gives its path | read in full from a read-only checkout, which may lag the vault. Not reproduced here |
| Research report `research-202611180018-r9kf` | ORBIT's own state directory (`<state>/research/<job>.md`, `src/research.ts`). Research jobs have no `orbit-work` branch, by design | **not recovered.** Its contents are unknown to the recovery job and are not summarized or assumed. The security-review gate stays (section 4, G1) |

Git state, as the recovery job checked it: on `orbit-work`, `orbit/orbit-202611180118-hcey` still points at `9f36a47`. On `DragonflyAI-sh/orbit`,
no branch has that name, and no `orbit/*` branch head mentions a host-capability inventory. The one "inventory" match is the dpkg package
inventory from 2026-11-10. On `main`, the only inventory code is the package inventory in `src/ops/sys-protocol.ts` and
`src/ops/sys-run.ts`. The read-only helper's allowlist is still `orbit_status, orbit_logs, deploy_state, host_health, tailscale_status,
vault_sync, credentials` (`src/ops/protocol.ts:12`). **No inventory work exists to duplicate.**

### Why chat saw only part of these texts (code-backed, as of #134)

* **Vault notes.** `memory_read` returns the whole note as one result, and every tool result is cut at `MAX_OUTPUT_CHARS = 8000`
  characters of its serialized envelope (`src/agent.ts`, `clipOutput`). A note longer than about 7,000 JSON-escaped characters could
  not be read past that point, and there was no offset or page argument.
* **Job summaries.** `job_status` gives the model the summary's size, state, channel and time, never its text (`src/job-view.ts`).
  Its event list does carry summary event excerpts (each at most 4,000 characters), but those are cut with the rest of the output at
  8,000 characters. The full text was shown only on the Jobs page.
* **Research reports.** `research_result` cuts the report to 6,000 characters (`textTruncated: true`), with no offset.

**Addressed by `orbit-202611180913-8w13`:** `memory_read_page`, `job_summary_read` and `research_report_read` read each of these texts
completely, one bounded page at a time, without changing the existing tools' answers. The contract is in `docs/text-readers.md`.

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
| O3 | `memory_read` cannot page. Notes longer than about 8,000 escaped characters are cut for the model | section 1 above | **Addressed** by `memory_read_page` (`docs/text-readers.md`). `memory_read` itself is unchanged |
| O4 | Chat cannot read a full job summary (`job_status` gives no text) or a report over 6,000 characters (`research_result`, no offset) | section 1 above | **Addressed** by `job_summary_read` and `research_report_read`. A summary ORBIT holds only in part (`partial`, `oversize`) is still only the start; the reader says so (`textComplete: false`) |
| O5 | A legacy record (no `fireStartedAt`) can never be closed with `provider-no-run` | `dispatchBounds`, `src/launch-reconciliation.ts:301` | applies to `orbit-202611180118-hcey`. Documented in `launch-reconciliation.md` section 9, Limitations |
| O6 | The reconciliation is shown only by the JSON routes and the retry gate, not by the not-started alert, the work-session views or the Jobs page | `launch-reconciliation.md` section 9, Limitations | — |

## 3. Disposition of the original launch `orbit-202611180118-hcey`

**The historical outcome is unknown.** Neither this job nor the earlier ones could read the provider's run history or the live job
record. The owner reports that no jobs are active. That is recorded here as **the owner's current-status report**, relayed in this job's
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

**So the workflow cannot authorize a retry on the owner's current-status report alone.** A replacement needs exactly one of these owner
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

The original brief is in the private control repository (section 1). Its criteria, summarized here without quoting it. **All are
outstanding. None was executed by the recovery job or, as far as the repository shows, by any other job.**

1. **Planning inputs.** Follow the owner's plan note in full, including its gate ordering, and report missing parts rather than
   reconstruct them. Use the research report only as untrusted evidence through an authorized interface; otherwise keep a
   security-review gate, and never claim to have read it. *State:* the research report is not available, so the gate stays (G1).
2. **Inspect before building.** Inspect the helper, tool registration, deploy artifacts and tests on current `main`. Keep
   repository-declared state apart from live state. A cloud runner is not the production host. *State:* partly done by the recovery
   job; the implementing job must redo it on current `main`.
3. **Shape.** One narrowly named read-only operation on the existing authenticated ops helper transport, plus one owner-only chat tool.
   No user-supplied commands or paths, and no general exec. *State:* outstanding.
4. **Output.** Bounded and secret-free. Each section gives its source, observation time, completeness, and why it is unavailable or
   denied. Only non-secret facts about service identities, sandboxing, the helper's boundaries, selected install and workspace
   locations (owner, mode, canonical path) and deployment topology. Never environment values, credentials, process arguments, raw
   configuration or unit contents, private session or source contents, broad listings or secret-store metadata; no recursive scans
   and no following untrusted symlinks. *State:* outstanding. Design in `launch-reconciliation.md` section 6.
5. **Documents.** What the operation cannot observe safely, the manual helper-install gate, and a staged rollout document for later
   capabilities. Implement no exec, patches, filesystem tools or session reader. *State:* outstanding.
6. **Tests and checks.** Allowlist and argument rejection, owner authorization, bounded secret-free output, missing services, paths and
   permissions, malicious symlinks and path input, provenance and completeness, no mutation; then the typecheck and the tests.
   *State:* outstanding.
7. **Boundaries.** No deployment, restarts, host access from a runner, privilege grants, mounts, host package installs or vault
   writes. If `main` already has an equivalent, extend it rather than duplicate it. *State:* still binding. `main` has no equivalent
   (section 1).

**A gate the earlier handoffs did not state (G1′).** The recovery job found an ordering question in the plan note as it read it:
whether the research must be incorporated into the note before the inventory is implemented, or whether the two go together. The owner
should settle it before the implement-only job. The checkout it read may lag the vault, so the note may already have changed.

**Proposed next job: implement only, not run.** The owner confirms it separately, after G0 is decided as in section 3. Brief skeleton:

* *Preconditions stated in the brief:* the G0 decision (option 1 or 2 above, verbatim); the G1/G1′ decision (is the research
  available as untrusted evidence, or does the security-review gate stay); the plan note named as authorized vault reading.
* *Scope:* criteria 2 to 6 above only, from current `main`. First check that no branch or PR implements an inventory. One action on the
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

## 7. Checks run by the recovery job

On branch `orbit/orbit-202611180656-xyro` from `main` `efbf2cd`, the recovery job ran `npm install --no-save` and stated that the
repository had no lockfile. **That statement was wrong:** `pnpm-lock.yaml` is in the repository and `package.json` declares
`"packageManager": "pnpm@10.33.0"`, so the declared workflow is `pnpm install --frozen-lockfile`, `pnpm run typecheck` and `pnpm test`.
With npm it reported: `npm run typecheck` exited 0, and `npm test` (`node --test test/*.test.ts`) ran 1,759 tests, 1,759 passed. That
count includes the 5 tests in `test/legacy-launch-disposition.test.ts`. No production source file was changed.

## 8. Historical exposure (not remediated)

Removing the private texts from this file on `main` does not erase them. The version merged in #134 (commit `4ccac8a`) stays in the
repository's history, and in any clone, fork, cache or pull-request view made from it. This revision does not rewrite history, delete
branches or change the repository's visibility, and it makes no claim that the earlier copies are gone. Whether to do anything about
them is a separate owner decision.
