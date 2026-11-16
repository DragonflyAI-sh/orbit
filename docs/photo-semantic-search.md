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

`/status` gains a `photo-embeddings` part only when `ORBIT_PHOTO_SEMANTIC` is set. It shows the model, the halt state and today's counts, and is "not exercised" (epoch) until the first success, so the watch ignores an idle port.

## Secure provisioning (owner, on the host; not done by this change)

1. In the OpenAI platform, use a **dedicated project** for ORBIT embeddings, with an API key restricted to that project. If the console offers per-endpoint key permissions, allow only embeddings. Set the project's **monthly budget / hard limit** and the usage limits as low as practical. Confirm in the console how the grant or credits apply and **whether usage beyond them is billed**. **ORBIT cannot verify billing coverage.** A successful request does not show that a grant paid for it, and credits do not by themselves prevent paid overage.
2. Install the key without echoing it:
   `sudo sh -c 'umask 077; read -rs K; printf "%s" "$K" > /etc/credstore/orbit.openai-embeddings; unset K'`, then paste the key and press Enter. Then check `sudo stat -c '%a %U' /etc/credstore/orbit.openai-embeddings`, which should print `600 root`.
3. Add `ORBIT_PHOTO_SEMANTIC=on` to `orbit.env` (and optionally the budget settings above). Restart: `sudo systemctl restart orbit`. Check `curl -s localhost:8790/status`: `photo-embeddings` should be `live` (not exercised).
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
- Full suite: `pnpm test` and `pnpm typecheck` pass.

**Synthetic comparison (stand-in, not semantic).** The fixture has 20 queries, 14 of them answerable, over one corpus. Forgotten, superseded, stale and unauthorized evidence are removed first.

| | Keyword, captions and titles (`photos_list` today) | Keyword, all eligible evidence (fair baseline) | Hybrid with **trigram stand-in** |
|---|---|---|---|
| Intended photo at rank 1 | 5 | 10 | 12 |
| Intended photo in the top 3 | 5 | 10 | 13 |
| Unanswerable queries returning nothing (of 6) | 6 | 5 | 4 |
| Queries returning an excluded photo | 0 | 0 | 0 |

The stand-in used 21 requests and 36 texts, with no failures. The cache held 16 entries in about 29 KB.

Reading it:

- Most of the gain over today comes from **coverage**: searching observations at all. That is visible in the fair keyword column.
- The stand-in's extra hits are spelling tolerance ("bookshelfs") and partial-word overlap. That is not meaning.
- "That place with the library behind it" **failed** with the stand-in. The only result was the garden photo, through its labelled context line.
- "Place we ate with all the books" ranked the intended photo second.
- "City library" and "pizza place bookshelves" returned non-intended photos instead of no match.
- Ambiguity was not flagged on this fixture. It is shown only by the dedicated twin test.
- Whether a real model does better is **unverified** until the owner-run evaluation.

**Not verified:** any live request, key, project, billing or grant coverage; real-model quality, latency or threshold calibration; whether a real chat model follows the guidance; any production data or configuration. No runner credential was available, so no live call was made.

## Unresolved and residual risks

- **Thresholds.** The floor, context weight and ambiguity ratio are uncalibrated. Weak semantic hits can surface for unanswerable queries. The no-match and ambiguity wording mitigates this; it does not eliminate it.
- **Data sent to OpenAI.** Untrusted stored text (observations, captions, titles, Rai's follow-ups) and the query are sent to OpenAI's embeddings endpoint. That is a new data flow under a separate key, and its retention follows that project's settings.
- **Forgotten text in replies.** Assistant reply prose that quoted an observation still exists after forgetting (as in milestone 2). It is not used as evidence here.
- **Coverage.** A photo nobody inspected, captioned or titled cannot match.
- **Single writer.** There is no cross-process lock.
- **Archived Assistant chunks.** Messages there are not read for captions or discussion, as with photo discovery.
- **Budget scope.** The budget is ORBIT's own count per state directory. The provider-side limit is the only hard ceiling.
- **Dependencies.** The original keyword job `orbit-202611160439-fakl` has no branch on the remote. This change builds on the merged `photos_list` query and the milestone 2 code on `main` and does not touch that job.
