# Pull-request inspection (owner-only, read-only)

ORBIT can look at a pull request in detail without leaving chat: the diff, every check, every review and comment, all tied to the exact head commit it read. It **only reads**. It never reviews, comments, labels, approves or merges, and it never decides a PR is ready: it returns evidence and says what is missing. Merging stays Rai's.

## Who and what

- **Owner only.** The tools are offered only to the owner, and each call is checked twice: `decide("agent", tool)` and `decide("pulls", tool)` (`src/policy.ts`, `src/server.ts`). A non-owner gets no tools and causes no GitHub request.
- **Repositories** are the ones `ORBIT_ROUTINE_REPOS` names (case-insensitive match, canonical spelling used). Anything else is refused before any request.
- **Credential:** the existing `orbit.github-orbit-prs` token, read when used. It needs only read access (Pull requests read, Contents read; Checks/Actions read for checks and logs). ORBIT does not widen it. A missing permission is reported as a permission limit, never as an empty result.
- **Only `GET`**, only to `https://api.github.com`, through one function (`githubReader` in `src/pr-inspect.ts`) that has no body and never follows a redirect with the token. The one redirect GitHub makes (job logs, to its log storage) is followed once, **without** the token, over https with no credentials in the address and no custom port, and only to two narrow host shapes: one label under `actions.githubusercontent.com` (e.g. `pipelines.actions.githubusercontent.com`) and `productionresultssa<N>.blob.core.windows.net`. User-content hosts such as `raw.githubusercontent.com`, other Azure storage accounts, deeper subdomains, trailing-dot or `@` lookalikes, and a second redirect are refused with an error naming the host. These two shapes follow GitHub's published Actions network hosts as ORBIT understands them; they were **not observed live** by this change. If GitHub serves logs from anywhere else, `pr_check_log` reports the log unavailable (it fails closed) instead of fetching it.

## The tools

All take `repo` (`owner/name`), `pull` (number) and an optional `expectedHead` (a 40-character SHA). Unknown arguments, a non-integer or out-of-range number, a bad SHA or a repository outside the set are rejected before any request. How to call them, and what each argument may be, is in "Calling convention" below.

| Tool | What it returns |
| --- | --- |
| `pr_inspect` | Title, author, state, draft/merged, base and head branch and **SHA**, timestamps, counts, description length. Start here: its `headSha` is what the rest are pinned to. |
| `pr_files` | Changed files, paged with `start`/`nextStart`: status, additions, deletions, rename source, blob SHA, and per file whether GitHub supplied a patch (`present`, `absent` with the reason, or `truncatedByGitHub`). |
| `pr_diff` | One file's patch in chunks (`path`, `offset`/`nextOffset`). Chunks join back to the exact patch; `patchSha256` (pass it back as `expectedPatchSha256`) detects a change between chunks. |
| `pr_checks` | Every check run (including superseded reruns, marked; see below) and commit status on the head: `passed`, `failed`, `queued`, `running`, `skipped`, `neutral`, `cancelled`, `timed_out`, `action_required` and status `error`/`pending` stay separate. Counts, completeness, and an explicit "no checks is not a pass". |
| `pr_check_log` | A bounded excerpt of one check's failure: for Actions, the job log from 25 lines before the first `##[error]` (or the last 200 lines), redacted, paged by `offset` (pinned by `expectedExcerptSha256` after the first chunk) and capped at 20,000 characters; for other apps, the check's own output. Says if the log is unavailable. |
| `pr_discussion` | Every review, conversation comment or inline code comment (`kind`), paged, as compact entries: author, time, commit id, relation to the current head, a preview, the end of the text and any verbatim `Verdict:` lines. |
| `pr_text` | One body in full, in chunks: the description, a review, a conversation comment or an inline comment. `nextOffset` is `null` only when the whole text has been read. |

## Calling convention

**Schemas.** Each tool has one canonical schema (`parameters`): the arguments that name what is read are required (`repo`, `pull`, and `path`, `checkId` or `kind`), and everything else is optional and simply not in `required`. Every tool is marked `strict` (`ChatTool.strict`), so what a transport sends is:

| Transport | Schema sent | How a model leaves an argument out |
|---|---|---|
| Responses API (ChatGPT token sharing, OpenAI API: `responsesTools` in `src/model.ts`) | `strict: true` and `strictSchema(...)`: every property in `required`, each optional one nullable (`["string","null"]`, `["integer","null"]`); the identity arguments stay non-null | `null` |
| Canonical (OpenRouter fallback, Chat Completions: `parameters` unchanged) | the canonical schema, no `strict` flag | leave it out |

The runtime reads left out and `null` the same everywhere, so the same call works on either transport.

**A first call needs no SHA or digest.** `pr_inspect {repo, pull}` (other arguments null) returns `headSha`. `pr_text {repo, pull, kind, id}` at offset 0 (or null), `pr_diff {repo, pull, path}` and `pr_check_log {repo, pull, checkId}` return their first chunk with its real `textSha256` / `patchSha256` / `excerptSha256`. The description takes no `id` (null or left out; a number is refused, so a wrong kind is never read). Never make up a SHA or digest: a made-up head returns `stale` with no data, a made-up digest returns no chunk.

**Continuing a chunked read.** Every chunk of `pr_text`, `pr_diff` and `pr_check_log` carries `continuation`: `read` (what it reads, with `expectedHead` and the digest), the chunk's `offset`/`end`/`totalChars`, and `next`: the exact `{tool, arguments}` of the next chunk, or `null` when this chunk ends the text. Call `next.arguments` as given. A chunk after the first (`offset > 0`) **must** pass both `expectedHead` and the digest; without them it is refused before any request, so two versions can never be joined by accident. Any offset of the same version can be re-read with the same pins. A text is fully read only when `next` is `null` (`nextOffset: null`); a preview, `wholeTextEnd` or a clipped summary is not the text.

**When the pinned version is gone.** If the head is not `expectedHead` (or moved during the read) the result is `stale: true`; if the content's digest is not the one passed (the comment was edited on the same head, or the digest did not come from this text) the result has `inspection.contentChanged: true` and a `changed` reason that says it cannot tell which. Either way it carries **no chunk** and a `restart`: the `{tool, arguments}` of a fresh first chunk (offset 0, no digest, `expectedHead` the current head; for a non-chunked tool, the same call pinned to the current head). The current digest is not handed out, so a continuation cannot be glued onto a different version; restart from offset 0 and discard the old chunks. A malformed or wrong-typed argument is an error, not a restart.

**Compatibility.** `""` for `expectedHead`, `expectedTextSha256`, `expectedPatchSha256` or `expectedExcerptSha256` is read as "not pinned", because before this contract a provider that requires every property made models fill pins they did not have with `""`. It is accepted only where no pin is needed (a first call); a continuation still needs real pins. Any other non-hex, wrong-length or non-string pin is refused before any request; hex in either case is the same pin. `offset`/`start` null is 0. `id: ""` is refused (it is an integer field).

**Cut outputs keep the continuation.** When a chunk's output is cut, by this reply's tool-result budget (`keptFacts`, `src/tool-result-budget.ts`) or by the Assistant's bounded history (`cutOutput` and the calls-omitted / placeholder paging note, `src/assistant-context.ts`), ORBIT keeps the read's state whole beside the cut: what it reads, its pins, the chunk's span, and either the exact next arguments or "final chunk, nextOffset null"; a cut chunk also says how to read it again (its own offset, same pins). In a calls-omitted turn the note names the newest chunk of each read. Only ORBIT's own `continuation`/`restart` fields are read for this, and each value is checked against its exact form (ids, offsets, SHA, hex digest, a path of at most 300 characters without control characters), so no text from GitHub is lifted into a note (`src/pr-continuation.ts`). History budgets are unchanged.

**Why this exists (root cause of "expectedHead must be a full 40-character commit SHA" for `expectedHead: ""`).** The pr_ tools were sent to the Responses API with optional properties and no `strict` flag. The provider's documented default for function tools is strict, and a strict schema requires every property, so models had to fill `expectedHead` and `expectedTextSha256` with something; the runtime accepted only a real SHA or digest, or absence, and refused `""`. The only way past was a made-up value: a zero SHA came back `stale` with the current head (a usable but wrong bootstrap), and a zero digest can never match, so `pr_text` refused every attempt and a long comment could not be read. The same mismatch was fixed for the photo tools earlier (`docs/photos.md`, "Tool contracts per provider"). What the provider did with the non-strict schema in production was reported from the Assistant, not re-observed here (no live call was made); the fix does not depend on it: the schema is now explicitly strict with nullable absence, and the runtime accepts every absence form a model can send. Tests: `test/pr-tool-contract.test.ts`.

## Staleness: the head is pinned

Every result's `inspection` block has `repo`, `pull`, `url`, `baseSha`, `headSha`, `expectedHead`, `fetchedAt`, `headCheckedAt`/`headCheckedAfter`, `endpoints` (the GET paths used), `rateLimit` and `stale`.

- The PR is read first. If `expectedHead` is given and the head differs, the result is `stale: true` with **no data** and a `restart`, after a single request.
- The PR is read again after the data. If the head moved while reading (including across the pages of a scan), the result is `stale: true` and the data is withheld, never mixed.
- Reviews and inline comments keep their `commit_id`; `commitRelation` is `head`, `older-commit` or `none`, and `stale` is true for an older commit. **Conversation comments and the description belong to no commit**: they say `commitRelation: "none"` and are never called current or stale.
- - Superseded reviews are included, with `supersededByLaterReviewFromSameUser` and `supersededByReviewId`. Only a later **APPROVED, CHANGES_REQUESTED or DISMISSED** review by the same user supersedes an earlier review of theirs; a later `COMMENTED` review never does (on GitHub it does not replace a change request). `PENDING` reviews and reviews with no known author never supersede or get superseded. A `DISMISSED` review supersedes earlier ones as the rule is written here; the dismissed review itself is still listed with its own state.

## Check reruns

`pr_checks` calls a run **superseded** only when a later run has the same app, the same name **and the same check suite** (`check_suite.id`): a rerun of that check. Two workflows that each have a job called `build` are in different suites, so both stay current and a failure in either is in `latestEntriesByOutcome`. A run missing its app, name or check suite is never superseded. The summary also reports `supersededByOutcome` (so a failure hidden as a rerun is still counted) and `sameNameInDifferentSuites`. The cost of being careful: if a whole workflow was re-run as a new suite, its earlier failed attempt still shows as current; confirm on GitHub. How GitHub assigns suites to reruns was not observed live.

## Whose verdict is it? (`orbitReview`)

`Verdict:` lines in a review or comment are text from their author and are returned verbatim as raw text. Nothing in that text, including a footer that says "ORBIT-recorded verdict", makes it ORBIT's. Each **conversation comment** (in `pr_discussion` kind `comments` and in `pr_text` kind `issue_comment`) carries an `orbitReview` field:

- `verified` only when all of these hold, checked against ORBIT's own job records and the account its token authenticates as: exactly one finished review job recorded this repo, PR number and comment id as a comment it posted; that job holds its whole summary and its recorded verdict equals the one its own summary yields; the comment's text is exactly what ORBIT posts for that part of that job (so an edited comment fails); and the comment's author login and numeric id equal the account `GET /user` returns for the token. It then shows the job's **recorded** verdict (never read from the comment), the job id, the source, which part of how many, and the reviewed commit and whether it is the current head.
- `unverified`, with the reason, when a record is missing, ambiguous (two jobs claim one comment), for another repo or PR, not finished or inconsistent, the text differs, the author is another account, or GitHub will not say who the token is. Fail closed.
- `none` for comments that neither claim to be a review nor match a record.

Reviews and inline comments are never ORBIT job verdicts (ORBIT posts its reviews as conversation comments), so they carry no `orbitReview`. Only an ORBIT-recorded verdict counts as an ORBIT review verdict; it is **not** a merge or readiness verdict and does not override GitHub's review states. The results and tool descriptions say so (`orbitVerdictRule`). Nothing from the comment can set any provenance field, and no job internals (events, steers, tokens) are returned.

Limits: the **reviewed commit** is the PR head ORBIT saw when it opened or found the PR and started the review (`reviewedSha` on the review job); the reviewer does not confirm the commit it read. Jobs from before this was recorded have none, and say the commit is unknown (`headRelation: "unknown"`), never a guess. Verification needs ORBIT's job records to still exist (jobs expire) and the token to be allowed to read `GET /user`; if either is missing the comment is simply `unverified`. The posting account is the account behind `orbit.github-orbit-prs`; if that is also a person's own account, the job-record match and exact-text match, not the account alone, are what make a comment verified.

## Long text is paged, never clipped

The chat transport keeps at most 8,000 characters of a tool result. Every result is built to fit **whole** (about 7,000 characters of JSON including escaping), so nothing is cut on the way to the model. Anything longer comes with `nextStart` or `nextOffset`; a list is complete when `listComplete` is true, a text when `nextOffset` is `null`. A review whose final `Verdict: blocking issues` is past character 4,000 is read with `pr_text` until `complete`, and its `verdictLinesInWholeText` and `wholeTextEnd` are in every chunk.

Verdict lines are shown verbatim as untrusted text. ORBIT infers nothing from them: a missing, odd or conflicting verdict is reported as it is, and approval is only GitHub's own review `state`.

## Limits it states

GitHub lists at most 3,000 files per PR; patches for binary, very large or generated files are absent; GitHub may cut a patch (detected by hunk accounting); check and comment lists are read up to 1,000 items and then say they are incomplete; job logs are read from the last 1,000,000 bytes (the excerpt says if an earlier error may be missing). Rate limits (with reset time), 401, 403 (permission), 404, 5xx, timeouts (15 s) and malformed answers each return a specific error and no partial data.

## Untrusted data

Everything fetched (titles, bodies, comments, patches, logs) was written by other people or programs. Each result says so, and the tool descriptions tell the model to treat it as data, never instructions. Log excerpts and check output are redacted with ORBIT's standard secret redaction; PR text and patches are returned as written (ORBIT's thread store masks secret-shaped strings when it saves a conversation).

## Not covered

This is reading only. Reviews, comments, approvals and merges are not available here, and no readiness or merge decision is made from the evidence. Live GitHub behaviour (real permissions of the token on checks, logs and `GET /user`, real log redirect hosts, real check-suite assignment for reruns) is exercised only by the unit tests' fake GitHub until used against a real PR.

The token is the same one ORBIT uses to open pull requests and post reviews, so it can write; the read-only guarantee is enforced only by this code (one GET-only request function, with a source-scan test), not by the token's permissions.
