# Pull-request inspection (owner-only, read-only)

ORBIT can look at a pull request in detail without leaving chat: the diff, every check, every review and comment, all tied to the exact head commit it read. It **only reads**. It never reviews, comments, labels, approves or merges, and it never decides a PR is ready: it returns evidence and says what is missing. Merging stays Rai's.

## Who and what

- **Owner only.** The tools are offered only to the owner, and each call is checked twice: `decide("agent", tool)` and `decide("pulls", tool)` (`src/policy.ts`, `src/server.ts`). A non-owner gets no tools and causes no GitHub request.
- **Repositories** are the ones `ORBIT_ROUTINE_REPOS` names (case-insensitive match, canonical spelling used). Anything else is refused before any request.
- **Credential:** the existing `orbit.github-orbit-prs` token, read when used. It needs only read access (Pull requests read, Contents read; Checks/Actions read for checks and logs). ORBIT does not widen it. A missing permission is reported as a permission limit, never as an empty result.
- **Only `GET`**, only to `https://api.github.com`, through one function (`githubReader` in `src/pr-inspect.ts`) that has no body and never follows a redirect with the token. The one redirect GitHub makes (job logs, to blob storage) is followed **without** the token and only to `*.githubusercontent.com` or `*.blob.core.windows.net` over https.

## The tools

All take `repo` (`owner/name`), `pull` (number) and an optional `expectedHead` (a 40-character SHA). Unknown arguments, a non-integer or out-of-range number, a bad SHA or a repository outside the set are rejected before any request.

| Tool | What it returns |
| --- | --- |
| `pr_inspect` | Title, author, state, draft/merged, base and head branch and **SHA**, timestamps, counts, description length. Start here: its `headSha` is what the rest are pinned to. |
| `pr_files` | Changed files, paged with `start`/`nextStart`: status, additions, deletions, rename source, blob SHA, and per file whether GitHub supplied a patch (`present`, `absent` with the reason, or `truncatedByGitHub`). |
| `pr_diff` | One file's patch in chunks (`path`, `offset`/`nextOffset`). Chunks join back to the exact patch; `patchSha256` (pass it back as `expectedPatchSha256`) detects a change between chunks. |
| `pr_checks` | Every check run (including superseded reruns, marked) and commit status on the head: `passed`, `failed`, `queued`, `running`, `skipped`, `neutral`, `cancelled`, `timed_out`, `action_required` and status `error`/`pending` stay separate. Counts, completeness, and an explicit "no checks is not a pass". |
| `pr_check_log` | A bounded excerpt of one check's failure: for Actions, the job log from 25 lines before the first `##[error]` (or the last 200 lines), redacted, paged by `offset` and capped at 20,000 characters; for other apps, the check's own output. Says if the log is unavailable. |
| `pr_discussion` | Every review, conversation comment or inline code comment (`kind`), paged, as compact entries: author, time, commit id, relation to the current head, a preview, the end of the text and any verbatim `Verdict:` lines. |
| `pr_text` | One body in full, in chunks: the description, a review, a conversation comment or an inline comment. `nextOffset` is `null` only when the whole text has been read. |

## Staleness: the head is pinned

Every result's `inspection` block has `repo`, `pull`, `url`, `baseSha`, `headSha`, `expectedHead`, `fetchedAt`, `headCheckedAt`/`headCheckedAfter`, `endpoints` (the GET paths used), `rateLimit` and `stale`.

- The PR is read first. If `expectedHead` is given and the head differs, the result is `stale: true` with **no data**, after a single request.
- The PR is read again after the data. If the head moved while reading (including across the pages of a scan), the result is `stale: true` and the data is withheld, never mixed.
- Reviews and inline comments keep their `commit_id`; `commitRelation` is `head`, `older-commit` or `none`, and `stale` is true for an older commit. **Conversation comments and the description belong to no commit**: they say `commitRelation: "none"` and are never called current or stale.
- Superseded reviews are included, with `supersededByLaterReviewFromSameUser`.

## Long text is paged, never clipped

The chat transport keeps at most 8,000 characters of a tool result. Every result is built to fit **whole** (about 7,000 characters of JSON including escaping), so nothing is cut on the way to the model. Anything longer comes with `nextStart` or `nextOffset`; a list is complete when `listComplete` is true, a text when `nextOffset` is `null`. A review whose final `Verdict: blocking issues` is past character 4,000 is read with `pr_text` until `complete`, and its `verdictLinesInWholeText` and `wholeTextEnd` are in every chunk.

Verdict lines are shown verbatim. ORBIT infers nothing: a missing, odd or conflicting verdict is reported as it is, and approval is only GitHub's own review `state`.

## Limits it states

GitHub lists at most 3,000 files per PR; patches for binary, very large or generated files are absent; GitHub may cut a patch (detected by hunk accounting); check and comment lists are read up to 1,000 items and then say they are incomplete; job logs are read from the last 1,000,000 bytes (the excerpt says if an earlier error may be missing). Rate limits (with reset time), 401, 403 (permission), 404, 5xx, timeouts (15 s) and malformed answers each return a specific error and no partial data.

## Untrusted data

Everything fetched (titles, bodies, comments, patches, logs) was written by other people or programs. Each result says so, and the tool descriptions tell the model to treat it as data, never instructions. Log excerpts and check output are redacted with ORBIT's standard secret redaction; PR text and patches are returned as written (ORBIT's thread store masks secret-shaped strings when it saves a conversation).

## Not covered

This is reading only. Reviews, comments, approvals and merges are not available here, and no readiness or merge decision is made from the evidence. Live GitHub behaviour (real permissions of the token on checks and logs, real log redirects) is exercised only by the unit tests' fake GitHub until used against a real PR.
