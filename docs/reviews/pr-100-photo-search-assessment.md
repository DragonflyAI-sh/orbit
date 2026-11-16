# Assessment: PR #100 (keyword `photos_search`) against current `main`

Job `orbit-202611162307-8gik`, 2026-11-16. Read-only assessment of PR #100. Nothing on PR #100 or its branch was changed.

## Commits examined

| | Full SHA |
|---|---|
| PR #100 head (`orbit/orbit-202611160536-bsii`) | `b8921b9f517ec4eb0b8eb8c1c597d85a10c93c18` |
| PR #100 base (merge base with `main`) | `28cb9c3a3be5ef3e82ecf7f5f7fd6c680cbc2c51` (milestone 2, #99) |
| `main` at assessment | `a7929d2cfda4f7541497c41132e3466b8492457d` (#104) |

`main` gained three commits after the PR's base: `be8d654` (#101, semantic spike), `8048d02` (#102, opt-in semantic `photos_search`) and `a7929d2` (#104, research lane). The job branches behind #101 (`orbit-202611160650-9ihf`), #102 (`orbit-202611161940-3fbo`) and #104 (`orbit-202611162113-h8ai`) have trees identical to those `main` commits, so they were squash-merged. No branch for the original keyword job `orbit-202611160439-fakl` exists on the remote. No other open job branch touches photo search.

GitHub review and check state of PR #100 was not available to this job. The assessment uses only the git objects above.

## Verdict: superseded. Close #100 without merging.

`git merge-tree origin/main b8921b9` conflicts in 7 files: `README.md`, `docs/photo-recall.md`, `src/model.ts`, `src/photo-access.ts`, `src/photo-observations.ts`, `src/server.ts` and `src/threads.ts`. The conflicts are not the main problem, though. Both sides define a tool named **`photos_search`** with different schemas, outputs and guidance. Merging #100 in any form would replace or duplicate the newer tool.

| PR #100 change | State on `main` | Evidence |
|---|---|---|
| `photos_search` tool over corrections, observations, captions, titles and context | **Present, superseded.** The same evidence kinds, re-authorized per call, with keyword ranking plus optional embeddings. | `src/photo-semantic.ts` `collectEvidence`, `keywordRanking`, `photoSearchTool` (#102) |
| Per-call re-authorization (`photoReach`, `readableRecords`, active and current-version records only) | **Present.** `main` also re-reads evidence after every await and revalidates each candidate. | `eligibleEvidence`, `retrieve`, `Access.revalidate`; tests in `test/photo-semantic.test.ts` (lifecycle, forget in flight, revocation) |
| The transcript keeps no snippets | **Present.** | `photoSearchTool` `transcript`; server test "transcript keeps no snippets" |
| Context: Rai's own messages, 1 before and 2 after, within 6 h | **Obsolete. Harmful to reintroduce.** `main` uses only Rai's *next* message within 30 min and excludes the current turn's message. #100's window can treat the search request itself as context for a photo sent earlier the same day, and it never excludes it (from reading the code; not run). | `photoDiscussionOf` in `src/threads.ts`; `exclude` in `collectEvidence`; server test "the search request itself are never evidence" |
| `photoMessagesOf` rewrite in `threads.ts` / `assistant-store.ts` | **Obsolete.** It existed only for that context window. | Conflicts with `photoDiscussionOf` / `photoDiscussion` |
| Exports added to `photo-access.ts` (`resolver`, `cmp`, `ownerZone`, ...) | **Obsolete.** `main` uses `reachablePhotos` instead. | `src/photo-access.ts` on `main` |
| `photos_list` "not available" text, `photos_inspect` / `photos_show` descriptions naming `photos_search` | **Present in substance.** `main` has its own wording, which is conditional on the tool being offered. | `PHOTO_SEARCH_NOT_AVAILABLE`, `photoGuidance` |
| **Observation `scope` and `limitations` never searched** ("a question about a bicycle is not a bicycle") | **Missing on `main`.** `main` embedded and keyword-matched `scope` as a `visual-observation`. | Fixed on this branch (below) |
| Always-on keyword search (no flag) | **Different by design.** On `main`, `photos_search` is offered only with `ORBIT_PHOTO_SEMANTIC` set. With `on` and no credential it runs keyword-only, but `/status` shows the port as misconfigured. | `embeddingsConfig`, `src/server.ts` |
| Date/conversation filters, cursor paging, 2,000-photo scan, `negationNearby` flag, `basis` field | **Not on `main`.** `main` returns at most 3 candidates over the newest 500 photos, and points to `photos_list` for dates. | Product choices, listed as decisions below. They are not defects. |

## Fix carried over (this branch)

On `main`, `collectEvidence` built `visual-observation` text from `[scope, ...observations]`. `scope` is "what this inspection was about (Rai's question or the task)". A probe on unmodified `main` saved an observation with scope "whether a bicycle is in the photo" and statements "a red front door", "a potted plant". The keyword-only search "bicycle" returned that photo as the only candidate, labelled "model observation". It was not marked ambiguous and was not a no-match.

The change: only the observation statements are evidence. Neither `scope` nor `limitations` is matched or embedded (`src/photo-semantic.ts`). This changes the embedded text for observation records, so their cached vectors get new keys. The old entries are no longer backed by evidence, and `maintain()` removes them. The feature is off by default and documented as not enabled anywhere.

New tests in `test/photo-search-server.test.ts`:

- The scope is never evidence, in keyword-only mode and in hybrid mode with the stand-in embedder. This test fails on unmodified `main`.
- Archived-thread photos are hidden and counted unless `includeArchived` is true. `main` had no `photos_search` archive test.

## Decisions left to Rai (not done here)

1. Whether a keyword-only `photos_search`, with no embeddings and no external calls, should be offered by default instead of only behind `ORBIT_PHOTO_SEMANTIC`. Today it is behind the flag.
2. Whether to add any of #100's extra parameters to `main`'s tool: date or conversation filters, paging, or a negation flag.

Both would be new features on `main`'s tool. Neither is a reason to merge #100.
