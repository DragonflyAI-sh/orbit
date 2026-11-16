# Spike: hybrid semantic photo retrieval on ChatGPT-subscription auth

Status: **design spike, not built into ORBIT.** Nothing here is wired into chat tools, routes, ports or startup, and no index is created under ORBIT's state directory. It belongs to milestone 3 of `docs/photo-recall.md`, which still needs separate approval.

## 1. Access: can ORBIT's ChatGPT login call an embeddings endpoint?

**Status: unverified, and not supported by any documentation found.** No probe was made.

What ORBIT uses today (code, `src/chatgpt.ts`): "Sign in with ChatGPT" token sharing. An OAuth login at `auth.openai.com` with scopes `openid email profile resource.invoke chatgpt.tokens.use.direct offline_access`, resource `https://api.openai.com/v1`. Inference is a bearer-token `POST https://api.openai.com/v1/responses` with `x-openai-chatpass-test: codex-direct`. The code calls no other endpoint for inference, and `CHATGPT_NO_METADATA` already notes that this route has no documented model-metadata endpoint.

What the provider documents. These pages were read through web-search summaries. `developers.openai.com` and `platform.openai.com` could not be fetched directly from the runner because DNS was blocked by the session's network policy, so the exact wording is still to be confirmed:

- Token-sharing guide, [Overview](https://developers.openai.com/siwc/token-sharing-open-source) and [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): plan usage covers "eligible Responses API requests". The documented call is `POST /v1/responses` with the access token as bearer. The guides say not to call ChatGPT `backend-api` endpoints. Embeddings are not mentioned.
- [Cookbook: Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt): plan usage needs the granted token-sharing scope, and identity sign-in alone does not grant it.
- [Embeddings guide](https://developers.openai.com/api/docs/guides/embeddings): `POST /v1/embeddings` is documented with a platform API key. That is a separate, metered billing path, not the subscription.
- Third-party write-ups (not authoritative, listed only for completeness): [apidog](https://apidog.com/blog/sign-in-with-chatgpt/) and [dev.to](https://dev.to/hassann/sign-in-with-chatgpt-for-developers-the-oauth-flow-plan-usage-and-what-it-means-for-your-api-bill-48f7) describe Responses-only constraints (`store: false`, streaming).

Conclusions, with documentation and testing kept apart:

| Question | Documented | Tested |
|---|---|---|
| Embeddings endpoint usable with a token-sharing token | No documentation found | Not tested |
| Embedding models, dimensions and input limits on this route | None documented | Not tested |
| Subscription covers embeddings, with no API-key billing | Not stated; "eligible Responses API requests" only | Not tested |
| ChatGPT inference works | Yes (Responses) | In production, outside this job. **Says nothing about embeddings.** |

The brief allowed a probe only if support and coverage were established and approved credentials were available in the runner. None of those three held. The runner has no ORBIT login: the token lives in `<state>/chatgpt-auth.json` on the production host, which this job may not access or copy. So no request was sent, and no endpoint or model name appears in the code.

**Safe next verification step** (needs Rai's decision, not this job's):

1. Allow `developers.openai.com` in a session's network policy, and record the exact token-sharing wording on which endpoints are eligible.
2. If, and only if, embeddings are documented as eligible, ask OpenAI or check the docs for which models and dimensions apply, and whether usage counts against the plan.
3. Only then, from the ORBIT host using its existing login (no token copied anywhere), send one synthetic request: `["synthetic probe text"]`. Record the HTTP status, the error code and the vector length. Treat a 401, 403 or 404 as "unsupported". Do not retry.

If embeddings are not eligible, the options are: keep keyword-only, use API-key embeddings (excluded by this brief, and costs money), or use a local model (excluded by this brief). That choice is Rai's.

## 2. Filesystem index design (prototype: `src/spike/photo-semantic.ts`, `vectorCache`)

- **Where.** `<state>/photo-vectors/<namespace>/<key>.json`, with the directory at mode 0700 and the files at 0600. This is private, disposable, derived data next to the existing stores. There is no database and no service. Deleting it is always safe.
- **Authority.** The attachment store, the observation store (`<state>/photo-observations`) and the conversation stores remain the only sources of truth. The index is never read to decide whether evidence exists or is allowed. It only supplies a vector for evidence that the sources say is eligible right now.
- **Entry** (`orbit-photo-vector/1`): photo ref, evidence kind, source type and id (observation record id, message id, thread id), photo version (SHA-256 of the processed JPEG), SHA-256 of the embedded text, model, dimensions, format, and the vector. **The source text is not stored.**
- **Namespace.** A hash of (cache format, embedder format, model, dims). A model or dimension change uses a new namespace, which is a full rebuild with nothing mixed. Old namespaces are deleted whole.
- **Key.** A hash of (namespace, ref, source type, source id, photo version, text hash). A changed caption, a correction, a supersession or a new image version maps to a new key. Stale entries are simply never looked up, so correctness does not depend on invalidation running.
- **Atomic writes.** Each entry is written to a uniquely named temp file, fsynced, then renamed. A crash leaves either no entry or a complete one. Leftover `*.tmp-*` files are removed when the index is opened. A damaged, oversized (over 128 KiB) or mismatched entry is treated as a miss and re-embedded; it is never trusted.
- **Incremental reuse.** Only evidence without a valid entry is embedded, in batches of 16. Query vectors are cached in memory per process.
- **Invalidation and deletion.** Forgetting, correction, revocation and conversation removal call `prune(currentEligible)`, which deletes every unreferenced entry. Forgotten text therefore also loses its derived vector, not just its matching. In the integration this should run inside the same tool call as `photos_forget` and `photos_correct`. A periodic prune covers anything missed.
- **Concurrency.** Entries are content-addressed and writes are idempotent. Two writers of one key write identical bytes, so the last rename wins harmlessly (tested). As with the other stores, only one ORBIT process per state directory is supported.
- **Fallback.** Any embedder error falls back to keyword-only for that call, with a `degraded` reason: unverified endpoint, auth, quota, timeout, a wrong vector size or count, or the request budget. There is no retry, and nothing is cached from a bad response.

## 3. Evidence, access and ranking

- **Evidence kinds**, kept separate end to end and labelled in results:
  - `visual-observation`: active model observations, labelled "not a verified fact".
  - `user-correction`: Rai's statement.
  - `caption`.
  - `conversation-title`.
  - `discussion-context`: a bounded excerpt of at most 400 characters from the source conversation, labelled "context, not a description of the photo".

  Each kind is prefixed to the embedded text. A discussion line is never presented as a visual fact. When scoring, its similarity is halved, so that a library discussion attached to a garden photo cannot outrank a photo whose own evidence matches.
- **Eligibility, decided before any embedding, matching, ranking or counting** (`eligibleEvidence`): the photo is in the caller's authorized set (today's `photoReach` and `photoPolicy`, with Assistant versus thread scope and archived sources unchanged), the evidence is `active`, and its image version equals the photo's current SHA-256. Forgotten records have no text, and none is ever rebuilt from replies, summaries or old tool outputs. Superseded and stale evidence is dropped.
- **Ranking.**
  - The keyword list reuses `photos_list`'s existing rule (`queryTerms` and `matchTerms` over captions and titles).
  - The semantic list ranks each photo by its best cosine similarity over eligible evidence. Evidence below a floor (0.35, set only on synthetic data) is excluded, and the list keeps at most 10 photos.
  - Reciprocal rank fusion (k = 60) merges the two lists and deduplicates by ref.
  - The top 3 photos are returned, each with up to two original evidence snippets (flattened and bounded, untrusted text), its source labels and how it matched.
- **Revalidation.** Just before a candidate is returned, it is checked again: still authorized, present and the same version. A candidate that fails is dropped.
- **Ambiguity.** If the second candidate's match strength (best similarity, plus 1 for a keyword hit) is at least 0.9 of the first's, the result is marked `ambiguous`. The model should show both photos (`photos_show`) and ask, not pick one.
- **No match.** `noMatch` comes with a caveat that nothing stored matched, which says nothing about what the photos show.
- **Every result carries the caveat** that similarity is not proof.
- **Photo tool contracts are unchanged.** In an integration this would be an opt-in `query` mode feeding `photos_list` and `photos_show` refs. Display still gives the model no vision. There is no automatic `photos_inspect` and no LLM reranker.

## 4. Synthetic evaluation (offline; `test/photo-semantic-fixture.ts`, `test/photo-semantic-spike.test.ts`)

**These are not measurements of semantic quality.** No real embedding model was called. The hybrid side used a **character-trigram hashing stand-in**: a lexical model with no notion of meaning, so "library" and "bookshelves" are unrelated to it. The fixture has 10 synthetic photos, 20 evidence records and 20 queries, including:

- the exact restaurant and bookshelves query, both paraphrases, the "bookshelfs" misspelling and two plausible photos;
- context-only library discussion on a garden photo;
- an unanswerable query;
- superseded, forgotten, stale-version and unauthorized cases.

Measured offline, with the stand-in, in one run (deterministic):

| Measure | Keyword-only | Hybrid (stand-in) |
|---|---|---|
| Intended photo at rank 1 (14 answerable) | 5 | 12 |
| Intended photo in the top 3 | 5 | 13 |
| Queries returning an excluded photo (forgotten, stale, unauthorized) | 0 | 0 |

Stand-in requests: 21 for 20 queries plus one batch, covering 36 texts (16 evidence and 20 queries). The budget was 40, with 0 failures. The index held 16 entries in about 14 KB.

How to read this:
- **The gap is mostly coverage, not semantics.** The existing keyword rule searches only captions and titles, while the hybrid also matches observation text.
- "That place with the library behind it" **failed** with the stand-in: none of its words appear in the fixture's text. The only result was the garden photo, matched only by its context line, which was labelled as context. This is exactly the misleading match the context labelling exists for.
- "Place we ate with all the books" ranked the intended photo **second**, behind the wine bar.
- "City library" and "pizza place bookshelves" returned non-intended photos instead of no match.
- Ambiguity never triggered on this fixture.

A real model is needed to say anything about paraphrases. Ten photos is not general validation.

Tested with mocks (plumbing only): cache reuse (a second run embeds only the query); no source text in entries; a damaged entry is re-embedded; temp leftovers are cleared; correction, forgetting, version change, revocation and failed revalidation all stop matching and `prune` removes the vectors; a model change uses a separate namespace; endpoint failure, the unverified embedder and an exhausted budget fall back to keyword-only with no retry; wrong-size vectors are refused and not cached; concurrent writers agree; labels are kept.

Proposed but not run: the same `runEvaluation` against a real, verified embedder, with a budget of about 40 requests, comparing rank-1 and top-3 results and recording latency, index size and the request count. Also: tuning the floor and the ambiguity ratio for that model, and a fixture where the keyword baseline also searches observations, which isolates the semantic gain from the coverage gain.

## 5. Risks

- The subscription route may never cover embeddings, which is the decisive blocker today.
- The floor, the context weight and the ambiguity ratio are guesses until there is a real model.
- Embeddings are derived data from text that was supposed to be forgotten. Prune has to run with forgetting, or vectors outlive the text.
- Untrusted text enters a third-party embedding request, which is the same exposure as inference.
- Rank fusion can surface weak semantic hits for unanswerable queries. The no-match and ambiguity guidance mitigate this; they do not eliminate it.

## 6. Follow-on brief (only if section 1's verification succeeds)

"Milestone 3a: wire `src/spike/photo-semantic.ts` behind an off-by-default config flag as an optional `semantic: true` mode of `photos_list`. Feed it evidence from `readableRecords` and the stores, restricted by `photoReach`. Run `prune` inside `photos_forget` and `photos_correct`. Put the index in `<state>/photo-vectors`, add a `/status` part for the embedder, run the real-model evaluation within its request budget, and keep `photos_show` and `photos_inspect` unchanged. No reranker and no automatic inspection."
