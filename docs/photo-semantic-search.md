# Opt-in semantic photo search (milestone 3a)

Status: **built, off by default, not enabled anywhere.** It builds on the design and prototype from the spike (`docs/photo-semantic-spike.md`, #101). The prototype `src/spike/photo-semantic.ts` was replaced by `src/photo-semantic.ts`. Nothing changes unless the owner sets `ORBIT_PHOTO_SEMANTIC=on` and installs a dedicated credential. **Live retrieval quality and live access are unverified.** No real embedding request was made while building this (see "Evidence").

## What it does

When it is enabled, one extra read-only chat tool, `photos_search {query, includeArchived?}`, is offered. It ranks Rai's photos against a description such as "that place with the library behind it" or "place we ate with all the books". It ranks by stored **text**:

| Evidence kind | Source | Label in results |
|---|---|---|
| `visual-observation` | active model observations (`photos_observe`), the statements only | model observation, not a verified fact |
| `user-correction` | active corrections (`photos_correct`) | Rai's statement, not a visual inspection |
| `caption` | the text of the message that carried the photo | caption |
| `conversation-title` | current title of that conversation | title |
| `discussion-context` | **Rai's own** next message after the photo, within 30 minutes, if it has text and no photos | context, not a description of the photo |

An observation record's `scope` (what the inspection was about, often Rai's question) and its `limitations` are never matched or embedded: "whether a bicycle is in the photo" is a question, not evidence of a bicycle (tested).

Discussion uses only Rai's messages. Assistant replies are never used, because they may quote observation text that was later corrected or forgotten, and forgotten text must not come back from history. The current turn's own message is excluded, so a search request is never context for itself. Context similarity counts at half weight.

Each result has at most 3 candidates. A candidate has the ref, conversation, message, send time, `matchedBy` (`keyword`, `semantic`), up to 3 labelled evidence snippets with their source ids, `ambiguous` with an instruction to show the candidates and ask, `noMatch` with a "says nothing about what the photos show" caveat, and coverage counts. The tool returns no image. Display (`photos_show`) and inspection (`photos_inspect`) are unchanged and stay separate, and nothing inspects a photo automatically. There is no LLM reranker.

**Ranking.** There are two lists over the **same eligible evidence**:

- **Keyword.** Every query word must appear in the photo's own evidence. Matches that need a context line rank after all own-evidence matches.
- **Semantic.** The best cosine similarity per photo. Anything below the floor of 0.35 is dropped, and the list keeps the top 10.

The two lists are fused with reciprocal rank fusion (k = 60) and deduplicated by ref. A result is ambiguous when the second candidate's strength is at least 0.9 of the first's. **The floor and the ambiguity ratio are not calibrated for any real model**: they were set on synthetic data only.

- **Related (bounded, ranked last).** A photo with no keyword or close match whose own evidence is near the query in meaning, but below the floor, can be returned as a `related` candidate after every exact one. See "Related matches".

## Related matches

Everyday names are often related, not identical, to what was recorded: a model observation says "a benchtop scroll saw" and Rai asks for "jigsaw". Keyword search cannot match a word that is not there, and the close-match floor is a single absolute cut for every query. So a related object can score just under it and the search returns nothing, even though the related photo is the only plausible answer.

The related tier (`relatedTier` in `src/photo-semantic.ts`) admits such a hit only as a **separate, lower-ranked** candidate, and only when it stands out:

| Gate | Value | Why |
|---|---|---|
| Related floor | cosine ≥ 0.25 (and below the 0.35 floor) | absolute lower bound |
| Distinct from the background | ≥ 0.08 above the query's **median** similarity over the eligible evidence | a query about nothing in the corpus has every similarity at about the same level, so nothing is admitted |
| Near the best | ≥ 0.45 × the query's **best** similarity | when one sense of the query matches strongly ("jigsaw puzzle" → a puzzle), weak hits on another sense (saws) are dropped |
| Own evidence only | observations, corrections, captions, titles; never a discussion-context line | context describes the conversation, not the photo |
| Bounded | at most 2 related photos; never a photo that is already a keyword or close candidate; needs at least 4 indexed evidence texts | cannot flood results or estimate a background from nothing |
| Ranked last | after **every** keyword or close candidate; fills only free slots of the 3 | an exact match is never pushed down |

Attribution is explicit. A related candidate has `matchedBy: ["related"]`; its evidence carries `related: true`, its similarity and the label "related concept: … not an exact match, and not a verified label of what the photo shows". When every candidate is related, the result has `relatedOnly: true` and a caveat saying nothing matched exactly or closely. The tool result adds a `related` note, and the chat guidance tells the model to call it a related match. The gallery shows "related in meaning to AI observation (0.32), not an exact match". Observations are never rewritten, and no label is inferred.

**Cost and rebuild.** None. The tier reads the similarities `retrieve()` already computes for the close tier. There is no extra provider request, no new text or field sent, no change to the embedded text or to the cache keys, and so no index rebuild. Budgets, keyword-only fallback, scoping, revalidation and the cross-site refusal are unchanged. Without vectors (feature off, no adapter, query embedding failed) there is no related tier.

**Not calibrated.** The three numbers were set on the labelled mock fixture only (`test/photo-related-fixture.ts`, a hand-weighted stand-in, not a model). Check them on the host with the diagnose view below before relying on them.

## Diagnosing a miss (the `jigsaw` report)

**Reported.** On the live Assistant, `jigsaw` returned no candidates in hybrid mode, and `scroll saw` returned the intended photo at rank 1 by keyword and semantic. Both searches reported 8 photos, 22 evidence records, 22 reused vectors and 0 not yet indexed.

**What the code establishes (main at d3f1445).** These are the stages, and what the report rules in or out at each:

1. **Eligibility and scope.** Both queries see the same 22 eligible records (eligibility does not depend on the query), and `scroll saw` returned the photo, so its observation was eligible, authorized and passed revalidation. *Ruled out.*
2. **Indexing and model/cache compatibility.** 22 reused and 0 pending means every eligible record had a vector in the current namespace. The namespace is a hash of the cache format, adapter format, embedding model and dimensions, so a vector from another embedding model is never mixed in. The vision model that wrote the observation is irrelevant: embeddings are made by the configured embedding model (default `text-embedding-3-small`) from the stored text. *Ruled out.*
3. **Query embedding.** The mode was hybrid, so the query vector existed. (An embedding failure gives `keyword-only` with a `degraded` reason.) *Ruled out.*
4. **Keyword.** No stored text contains "jigsaw". The keyword list is empty, as it should be.
5. **Semantic floor.** With the keyword list empty, an empty result means no eligible evidence reached cosine 0.35 against `query: jigsaw`. That includes the scroll saw observation, `visual-observation: A benchtop scroll saw …` in the brief's wording. *This is where the miss happens.* The list cap (10), RRF fusion and the 3-result cap only remove candidates when there are more of them, and there were none.
6. **Revalidation.** Only applies to fused candidates, and there were none.

So the miss is at the semantic close-match floor. That is a design limit: one absolute cut for every query, uncalibrated, and set on synthetic text. It is not a data, scope or cache fault.

**Unknown.** The actual similarity of `jigsaw` to that observation under the live model was not measured. No provider credential or live corpus was used. It is likely in the related band, since a single ambiguous word scores lower than a phrase, but that is an expectation, not a measurement. Other unknowns: the exact query string the chat model sent, and how many statements the live observation record joins. Statements are joined into one embedded text, and extra statements about other objects dilute a single-object query.

**Opt-in diagnose view (owner, on the host).** `GET /gallery/search?q=<query>&diagnose=1[&target=<photo ref>]` is the gallery's own owner-only, same-origin route: the same authorization and cross-site refusal, and the same single search. It adds `diagnostics` to that response only. It holds numbers and fixed reason words: thresholds; eligible photos, evidence and vectors; keyword candidates; whether the query was embedded; the best and median similarity and the top 5 per-photo similarities; close photos and how many the list cap cut; related band, admitted and rejected-by-reason counts; exact and returned candidates and drops by cap or revalidation. With `target`, it reports that photo's path: whether it is in the candidate set, its evidence and vectors, keyword match and position, best similarity and band (`close`, `related`, `below-related-floor`, `no-vector`, `not-embedded`), the related gate's verdict, and the final position or outcome (`returned`, `not-matched`, `results-cap`, `revalidation-failed`). It never contains the query, any evidence text, a vector, a ref or a source id, and nothing writes it to a log, the audit lines or a transcript (tested). `photos_search` itself is unchanged by it.

**Host checklist (Rai, after deploy; no config change needed).** Open ORBIT's page in your browser as the owner, open the developer console on that page (a same-origin request, so it passes the cross-site refusal), and run each request as `await (await fetch("/gallery/search?q=…")).json()`. Do not paste the output anywhere public. It holds no text, but the similarities are about private photos.

1. Find the scroll saw photo's ref: `GET /gallery/search?q=scroll%20saw`, then `matches[0].photo.ref`.
2. `GET /gallery/search?q=jigsaw&diagnose=1&target=<ref>`. Expect `diagnostics.target.inCandidateSet: true`, `withVector` equal to `evidence`, `keyword.matched: false`, and a `semantic.bestSimilarity`:
   - **≥ 0.35** (`band: close`) but not returned: the floor was not the cause. Report `final.outcome` and the `fused` counts.
   - **0.25 to 0.35** (`band: related`): this confirms the floor as the cause. With this change, `semantic.related` should be `admitted` and `final.position` 1 to 3. If it says `not-distinct` or `far-below-best`, note `semantic.median` and `semantic.best`: those are the numbers to calibrate the margin and ratio.
   - **< 0.25** (`below-related-floor`): the related tier does not cover it. The next lever is evidence granularity (one embedded text per statement, which costs a re-index), not a lower floor.
3. The matches for `jigsaw` show the scroll saw labelled "related in meaning … not an exact match". In the Assistant, "find the photo of my jigsaw" should present it as a related match, not as a jigsaw.
4. `scroll saw` is still rank 1, matched by keyword and semantic. A clearly unrelated query (for example `giraffe`) still says nothing matched. If a jigsaw puzzle photo exists, `jigsaw puzzle` returns it first and no saw is `related`.
5. `/status` `photo-embeddings` daily request counts rise by the same amount as before for the same searches: one request per uncached query, with no new requests from this change.

### Before/after fixture (MOCK embedder, not a model)

`test/photo-related.test.ts` and `test/photo-related-fixture.ts` hold an invented corpus. Its main observation is "A benchtop scroll saw with a thin vertical blade sits on a workshop bench", plus saw distractors (a pruning saw, a chainsaw, a seesaw), unrelated objects (a couch, a canoe, a mug, a receipt) and, in larger corpora, a jigsaw puzzle and a cordless jigsaw. `liveLike` has 8 photos and 22 records, with no stored "jigsaw". `conceptMock` gives each word an identity direction plus hand-set concept weights, so its similarities have the **shape** of the report. **They are not real-model measurements.** "Before" is `related: false`, which is main's ranking. Every row also asserts that the exact candidates are unchanged, in order.

| Query | Corpus | Before | After |
|---|---|---|---|
| `jigsaw` | liveLike | none | scrollSaw (related) |
| `jigsaw` | withPuzzle | puzzle (keyword+semantic) | puzzle (keyword+semantic), scrollSaw (related) |
| `jigsaw` | workshop | jigsawTool, puzzle (both keyword+semantic; ambiguous) | jigsawTool, puzzle, scrollSaw (related) |
| `jigsaw workshop` | workshop | jigsawTool (keyword+semantic), scrollSaw, puzzle (semantic) | unchanged |
| `jigsaw puzzle` | withPuzzle | puzzle (keyword+semantic) | unchanged (scroll saw rejected: far below best) |
| `jigsaw puzzle` | workshop | puzzle (keyword+semantic), jigsawTool (semantic) | unchanged; the related tier adds no saw |
| `scroll saw` | liveLike | scrollSaw (keyword+semantic), pruningSaw (semantic) | the same, plus chainsaw (related) third |
| `scroll saw` | workshop | scrollSaw (keyword+semantic), pruningSaw, jigsawTool (semantic) | unchanged |
| `armchair` | liveLike | none | couch (related) |
| `rowboat` | liveLike | none | canoe (related) |
| `sofa` / `kayak` | liveLike | couch / canoe (semantic) | unchanged |
| `giraffe`, `birthday cake` | liveLike, workshop | none | none |
| `seesaw` | workshop | seesaw (keyword+semantic) | unchanged |

In the `jigsaw puzzle` / workshop row, the cordless jigsaw, which shares the exact word, is a **close** match under the mock. That comes from the unchanged close tier, ranked below the puzzle. Whether a real model puts it above 0.35 is unmeasured: that is checklist step 4.

## Authorization and lifecycle

- **Candidate set first.** The candidate set is `reachablePhotos` (`src/photo-access.ts`), using the same policy as `photos_list`. The Assistant reaches every conversation. A chat thread reaches only its own photos. Archived threads are included only with `includeArchived`. Observation records go through `readableRecords`: the source must be readable by the caller, still exist and be about the current image version. Only this evidence is matched, ranked, counted or sent for embedding. Inaccessible evidence never affects matches, rankings or counts (tested: a thread searching sees `photosSearched: 1` and none of another thread's text).
- **Re-read after every await.** When an embedding request returns, the evidence is collected again from the stores. Anything forgotten, corrected, revoked or changed in the meantime is not cached (`discarded`), not ranked and not returned.
- **Revalidation.** Each candidate is authorized again with a fresh `photoReach` and checked with an integrity-checked load just before it is returned.
- **Forget and correct.** `photos_forget` and `photos_correct` call `onChange(ref)` in the same tool call. That deletes the photo's vector directory in **every** namespace and bumps the photo's generation, so an embedding write already in flight for that photo is refused (tested with a forget during a held request).
- **Version change and other removals.** A changed image version or caption is a new cache key, so the old entry is never used again. `maintain()` runs at most every 10 minutes during searches. It computes the eligible evidence of **every** conversation, and only uses that to delete: entries no longer backed by evidence, photos with none, and other model namespaces.
- **Transcript.** The stored transcript of a `photos_search` call keeps refs, positions, `matchedBy` and evidence kinds and source ids. It keeps no snippets, the same rule `photos_recall` follows.

## Vector cache (`<state>/photo-vectors`)

- **Layout.** `<namespace>/<ref>/<key>.json`, with directories at mode 0700 and files at 0600. The namespace is a hash of (cache format `orbit-photo-vector/2`, adapter format, model, dimensions). The key is a hash of (namespace, ref, source type and id, image SHA-256, hash of the embedded text).
- **Entry contents.** Ids, hashes, the kind, and the vector as base64 float32 with its own SHA-256. **No source text.** A damaged, oversized (over 128 KiB), mismatched or tampered entry is a miss and is re-embedded.
- **Writes.** Each entry is written to a temp file, fsynced and renamed. Temp leftovers are removed when the cache is opened. Concurrent writers of one key write equivalent content. As with the other stores, only one ORBIT process per state directory is supported.
- **Bounds.** At most 20,000 entries. At most 500 newest photos are searched per call. At most 48 new evidence texts are embedded per call (3 requests of 16, plus the query). Anything left over is reported as `notYetIndexed` and still covered by keyword ranking. Query vectors are cached in memory (200).
- **Authority.** The cache is derived, private and disposable. Deleting the directory is always safe, and it is never read to decide whether evidence exists or is allowed.

## The embeddings adapter (`src/embeddings.ts`)

- **Request.** Standard `POST https://api.openai.com/v1/embeddings` with a bearer **API key**, `encoding_format: "float"`, and `dimensions` only when a smaller size is configured for a `text-embedding-3-*` model. No `user` field. **ChatGPT token sharing is not used, and chat inference authentication is unchanged.**
- **Credential.** The systemd credential `orbit.openai-embeddings`, which is deliberately **not** `orbit.openai`. Installing `orbit.openai` would switch chat replies to API-key inference (`src/model.ts selectModel`). The unit already imports `orbit.*` (`ImportCredential=orbit.*`), so no unit change is needed.
- **Validation.** The status must be 200 and the body valid JSON. There must be exactly one vector per input, the indices must be a permutation (results are reordered by index), and each vector must have the configured dimensions, finite numbers and not be all zeros. The model must match. The body must be at most about n×dims×26 bytes + 64 KiB. Anything else is refused and nothing from it is cached.
- **Input and concurrency bounds.** A batch holds 1–16 non-empty texts of at most 2,000 characters each. Each request has a 15 s timeout, and at most 2 requests are in flight per process.
- **Retries.** At most 3 attempts in total, only on network errors, timeouts, 5xx and rate-limit 429. `Retry-After` is honoured up to 10 s; otherwise the backoff is 0.5 s, then 1 s. A caller's cancellation stops at once.
- **No retry on auth, quota or configuration errors.** 401 and 403 (auth), 429 `insufficient_quota` (quota) and 400, 404 and 422 (config) are not retried. They **halt** the adapter for 1 hour: every call fails fast with the reason, and `/status` shows the `photo-embeddings` port as `degraded`.
- **Hard budgets.** These are per UTC day and persisted in `<state>/embeddings-budget.json`. Every **attempt** reserves one request and an upper bound of its tokens (UTF-8 bytes) **before** it is sent. The reservation is settled down to `usage.prompt_tokens` when one is reported. An over-budget call sends nothing. An unreadable ledger sends nothing. The defaults are 200 requests and 100,000 input tokens per day. These are ORBIT's own counts, **not a provider-enforced ceiling**.
- **Errors.** Error text is cut and scrubbed of the key and key-shaped strings. Neither `/status` nor results ever carry the key.
- **Fallback.** If the query cannot be embedded, the search is `keyword-only` over the same corpus, with a `degraded` reason. If evidence cannot be embedded, it ranks with what is already indexed and says so. Without a usable adapter (credential missing, misconfigured), `photos_search` still works as keyword-only. With the feature off, `photos_search` is not offered at all. In every case, chat, `photos_list` and the other photo tools behave exactly as before.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `ORBIT_PHOTO_SEMANTIC` | unset = off | `on` offers `photos_search`. Any value other than `on` or `off` is treated as misconfigured: the port is `down` and the tool runs keyword-only. |
| `ORBIT_EMBEDDINGS_MODEL` | `text-embedding-3-small` | Any model needs a known size or `ORBIT_EMBEDDINGS_DIMENSIONS`. |
| `ORBIT_EMBEDDINGS_DIMENSIONS` | native (1536 for small) | Up to the native size; `text-embedding-3-*` only. A change means a new namespace and a full rebuild. |
| `ORBIT_EMBEDDINGS_DAILY_REQUESTS` | 200 | HTTP attempts per UTC day (1–10,000). |
| `ORBIT_EMBEDDINGS_DAILY_TOKENS` | 100000 | Reserved input tokens per UTC day (1–10,000,000). |
| credential `orbit.openai-embeddings` | absent | A single-line API key. |

`/status` gains a `photo-embeddings` part only when `ORBIT_PHOTO_SEMANTIC` is set. It shows the model, the halt state and today's counts. Until a request has succeeded in this process it is `degraded` with an epoch `verifiedAt` ("not verified yet in this process"), which the watch ignores. It is on-demand, like `model`, so `/status` does not age it into degraded while idle; the most recently started request decides its state. When it is on and configured, the startup smoke check (`docs/smoke-checks.md`) sends one 19-byte synthetic string through this adapter, with no retry, once per process, so the port has fresh evidence right after a deploy.

## Secure provisioning (owner, on the host; not done by this change)

1. In the OpenAI platform, use a **dedicated project** for ORBIT embeddings, with an API key restricted to that project. If the console offers per-endpoint key permissions, allow only embeddings. Set the project's **monthly budget / hard limit** and the usage limits as low as practical. Confirm in the console how the grant or credits apply and **whether usage beyond them is billed**. **ORBIT cannot verify billing coverage.** A successful request does not show that a grant paid for it, and credits do not by themselves prevent paid overage.
2. Install the key without echoing it:
   `sudo sh -c 'umask 077; read -rs K; printf "%s" "$K" > /etc/credstore/orbit.openai-embeddings; unset K'`, then paste the key and press Enter. Then check `sudo stat -c '%a %U' /etc/credstore/orbit.openai-embeddings`, which should print `600 root`.
3. Add `ORBIT_PHOTO_SEMANTIC=on` to `orbit.env` (and optionally the budget settings above). Restart: `sudo systemctl restart orbit`. Check `curl -s localhost:8790/status`: within about a minute, `smoke.checks` shows `photo-embeddings` `passed` and the port is `live`, or `failed` with the reason (`docs/smoke-checks.md`).
4. Rollback: remove `ORBIT_PHOTO_SEMANTIC` and restart. Optionally delete `/var/lib/private/orbit/photo-vectors` and `embeddings-budget.json`; both are derived data.

Never copy this key to a runner, a job brief, chat or the vault.

## Production enablement checklist

- [ ] PR reviewed and merged (merging deploys code with the feature still **off**).
- [ ] Dedicated project, key and hard spend limit confirmed by the owner (step 1), including whether overage is billed.
- [ ] Live synthetic evaluation (below) run by the owner and its report kept. Floor and ambiguity ratio reviewed against it.
- [ ] Credential installed (step 2), flag set (step 3), `/status` checked.
- [ ] Manual acceptance: in a chat thread, send a non-private test photo and let the model save an observation ("What's in this photo?"). In the Assistant, ask "find the photo of the place with the books". The reply should call `photos_search`, present candidates as possible matches, and call `photos_show` (not `photos_inspect`) when asked to show it.
- [ ] Forgetting check: say "forget what you saw in that photo", then search again. The photo must not match on that text. Optionally check that `photo-vectors/*/<ref>` is gone.
- [ ] Watch `photo-embeddings` on `/status` and the daily counts for a week.

## Live evaluation (owner-run, bounded, synthetic)

`tools/photo-semantic-eval/eval.ts` runs the **same** harness as the tests against the real adapter. It sends only invented fixture text: one probe (`"synthetic probe text"`), then 20 queries and the 16 eligible of 20 fixture evidence records. Its hard bounds are **25 HTTP attempts and 10,000 input tokens in total**, enforced by the adapter's ledger before each attempt. Nothing over the bounds is sent. It reads and writes no ORBIT state and prints JSON with counts, rankings for all three columns, latency and the ledger. It never prints the key.

Before running it: complete provisioning step 1, and run it only from the ORBIT host or the owner's machine with the key in a 0600 file. Never run it from a cloud runner.

```bash
node tools/photo-semantic-eval/eval.ts --confirm-synthetic-live-eval --key-file /path/to/0600-key-file
```

It exits 0 when complete, 1 when a request failed (including the probe: a 401, 403 or 429 `insufficient_quota` stops at once), and 2 when refused (nothing sent). Expected use is about 22 requests and well under 3,000 tokens. Ten synthetic photos are **indicative only**, not a general quality measure.

## Evidence

**Measured offline, with mocks and a stand-in (this change).** **Nothing here measures real semantic quality.**

- `test/embeddings.test.ts` checks the actual adapter against **mocked HTTP**:
  - the request shape and key, and reordering by index;
  - each malformed-response case (count, indices, size, non-finite, zero vector, model, not JSON, oversize), each refused without retry;
  - 401, 403, `insufficient_quota`, 400 and 404 not retried and halting;
  - 429 with `Retry-After`, 503, network errors and timeouts retried at most 3 times; a caller's cancellation stops at once;
  - request and token budgets reserved before sending, persisted (0600), surviving a restart and resetting per UTC day; an unreadable ledger refusing;
  - input bounds and a concurrency peak of 2;
  - the key never appearing in errors or status;
  - the configuration rules, including that `orbit.openai` alone does **not** enable it.
- `test/photo-semantic.test.ts` covers retrieval and the cache, using a character-trigram **stand-in** embedder:
  - cache reuse, no source text in entries, 0700/0600 permissions, damaged and tampered entries, temp cleanup;
  - correction, forgetting, version change and revocation; `maintain()`;
  - **forget during an in-flight embedding** (the write is discarded and nothing is returned);
  - **revocation during a request**;
  - namespaces;
  - keyword fallback (query failure, no adapter, budget 0) and partial indexing;
  - per-call indexing bounds, wrong-size vectors, concurrent writers;
  - labels, ambiguity between two near-identical photos, and no match.
- `test/photo-search-server.test.ts` exercises the real server, stores, policy and `runChat`, with a scripted model:
  - with the feature disabled, the tool is not offered, the guidance is unchanged, there is no port and nothing is written;
  - with it enabled, an observation is found from the Assistant;
  - a chat thread neither sees nor counts another thread's photo or text;
  - the transcript holds no snippets;
  - `photos_forget` deletes the vectors and the text never matches again;
  - a provider halted on quota gives keyword-only with exactly 1 attempt;
  - discussion context is labelled, and the search request is not context for itself.
- `test/photo-related.test.ts` covers the related tier with the labelled mock: the before/after table above, each gate (related floor, background margin, best ratio, context-only, exact excluded, cap, too few vectors), provider-disabled and query-failure fallback with no extra request, and the diagnostics' content (no query, text, ref or source id; an unauthorized target is not in the candidate set).
- `test/photo-search-server.test.ts` also checks, through the real server, that the Assistant's `photos_search` and `GET /gallery/search` return and label the same related match, that `diagnose=1` explains it and refuses a non-ref target and cross-site reads, and that with the provider disabled both stay keyword-only.
- Full suite: `pnpm test` and `pnpm typecheck` pass.

**Synthetic comparison (stand-in, not semantic).** The fixture has 20 queries, 14 of them answerable, over one corpus. Forgotten, superseded, stale and unauthorized evidence are removed first.

| | Keyword, captions and titles (`photos_list` today) | Keyword, all eligible evidence (fair baseline) | Hybrid with **trigram stand-in** |
|---|---|---|---|
| Intended photo at rank 1 | 5 | 10 | 12 |
| Intended photo in the top 3 | 5 | 10 | 13 |
| Unanswerable queries returning nothing (of 6) | 6 | 5 | 3 (4 before the related tier) |
| Queries returning an excluded photo | 0 | 0 | 0 |

The stand-in used 21 requests and 36 texts, with no failures. The cache held 16 entries in about 29 KB.

Reading it:

- Most of the gain over today comes from **coverage**: searching observations at all. That is visible in the fair keyword column.
- The stand-in's extra hits are spelling tolerance ("bookshelfs") and partial-word overlap. That is not meaning.
- "That place with the library behind it" **failed** with the stand-in. The only result was the garden photo, through its labelled context line.
- "Place we ate with all the books" ranked the intended photo second.
- "City library" and "pizza place bookshelves" returned non-intended photos instead of no match.
- Ambiguity was not flagged on this fixture. It is shown only by the dedicated twin test.
- With the related tier, "big bookcase cafe" (whose cafe photo's observation was forgotten) returns the bookshelf restaurant as a labelled **related** candidate instead of nothing. The forgotten photo is still never surfaced. This is the trade-off of the tier: a weak, labelled near match where there used to be a no-match. Its gates are what keep it rare, and they are uncalibrated.
- Whether a real model does better is **unverified** until the owner-run evaluation.

**Not verified:** any live request, key, project, billing or grant coverage; real-model quality, latency or threshold calibration; whether a real chat model follows the guidance; any production data or configuration. No runner credential was available, so no live call was made.

## Unresolved and residual risks

- **Thresholds.** The floor, context weight, ambiguity ratio and the related tier's floor, margin and ratio are uncalibrated. Weak semantic hits can surface for unanswerable queries. The no-match and ambiguity wording mitigates this; it does not eliminate it.
- **Data sent to OpenAI.** Untrusted stored text (observations, captions, titles, Rai's follow-ups) and the query are sent to OpenAI's embeddings endpoint. That is a new data flow under a separate key, and its retention follows that project's settings.
- **Forgotten text in replies.** Assistant reply prose that quoted an observation still exists after forgetting (as in milestone 2). It is not used as evidence here.
- **Coverage.** A photo nobody inspected, captioned or titled cannot match.
- **Single writer.** There is no cross-process lock.
- **Archived Assistant chunks.** Messages there are not read for captions or discussion, as with photo discovery.
- **Budget scope.** The budget is ORBIT's own count per state directory. The provider-side limit is the only hard ceiling.
- **Dependencies.** The original keyword job `orbit-202611160439-fakl` has no branch on the remote. This change builds on the merged `photos_list` query and the milestone 2 code on `main` and does not touch that job.
