# Job vault context

ORBIT does **not** read, copy or export vault notes when it launches a job. A runner that needs vault context reads the exact notes its brief names from the Routine's own read-only vault checkout at `/home/user/orbit-vault` (`deploy/routines/orbit-jobs.md`, "Vault source"), under the rules in `tools/orbit-job/SKILL.md`, "Vault context".

Launch-time export (ORBIT reading named notes through its vault clone and committing copies plus a manifest to `.orbit/context/` on the job's control branch) was removed on 2026-11-14. This document records what a launch does now, how old-style requests are handled, and how runners get vault context.

## What a launch does

Every launch path (the chat `job_launch` proposal and its Confirm button, `POST /jobs/launch`, and ORBIT's own review launches) ends in `jobLauncher` (`src/job-launch.ts`), which:

1. checks the routine, the control credential and that the brief is not empty;
2. registers the job;
3. creates `orbit/<job>` in `DragonflyAI-sh/orbit-work` and writes `.orbit/brief.md` with the brief as given (trimmed), nothing appended;
4. fires the Routine with the job id, the job API URL and token, and the tool commit.

It never touches the vault: no vault read, no vault filter decision, no visibility check of the control repository, no blobs, trees or extra commits. A launch therefore succeeds or fails independently of whether the vault is reachable or what any note contains. Owner checks, the explicit confirmation of chat proposals, and the failure handling (a brief that is not written never fires the Routine; a fire failure marks the job `launch-failed`) are unchanged.

## Old-style requests

Before the removal, a launch could carry `context: string[]`. Such a request is now **refused, never reinterpreted**: launching it without the notes would silently change what was asked or approved.

| Entry point | Absent, `null` or `[]` | Anything else (a non-empty list, a string, an object…) |
| --- | --- | --- |
| Chat `job_launch` tool | ordinary proposal | the tool call fails with the diagnostic below; no proposal is made. The tool's schema no longer offers `context` |
| `POST /jobs/launch` (owner only, checked first) | ordinary launch | HTTP 400, `{ error, context: { refused: true, reason: "unsupported" } }`; nothing registered, written or fired |
| Confirm of a proposal made by an older build that still carries `context` | — | HTTP 409 with the same body; the proposal is spent and its card shows `refused`; nothing registered, written or fired |

The diagnostic (`LEGACY_CONTEXT_ERROR` in `src/job-context.ts`) says that vault context attachments are no longer supported, that nothing was launched, and to launch again without `context`, naming the notes in the brief for the runner to read from its read-only checkout. It never contains note text.

Stored records from before the removal are left as they are: a job's `launch.context` and a thread card's `context` are shown as history and never acted on.

## How a runner gets vault context

- The brief names the exact vault-relative paths it relies on (for example `Tasks/orbit-next-x.md`). It should name only notes that are needed, and only notes inside the checkout's sparse set (`deploy/routines/orbit-jobs.md`); a note outside it is not available to the runner.
- The runner reads those notes, and nothing else, from `/home/user/orbit-vault`. It does not search the vault or follow links out of a note.
- If the checkout or a named note is missing, the runner says so in its first check-in and its summary, never guesses the content, and stops as `blocked` when the note is essential.
- The runner never writes to the vault and never copies or commits note bodies (into `orbit-work`, the project repo, tests, the PR or the summary) beyond the short fact the work needs.

## Not changed

- ORBIT's own vault access (memory search and read, vault write tools, the rolling recent-context note) is unaffected; see `docs/vault-writes.md`.
- The vault content filter (`docs/content-filter.md`) and the vault write policy are unchanged; job context is simply no longer one of the filter's surfaces.

## Tests

`test/job-context.test.ts`, all offline with synthetic fixtures: an ordinary launch writes only the brief and fires, with no vault read, even when a named note would be refused by the filter; the GitHub control creates the branch and puts `.orbit/brief.md` only; legacy `context` on the chat tool, `/jobs/launch` and a confirmed legacy proposal is refused with nothing started; owner checks and failure handling still hold; and no source file keeps the export plumbing.
