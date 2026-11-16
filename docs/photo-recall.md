# Uploaded photo recall

Rai wants to say "Show me photos uploaded yesterday", "Find the screenshot from our garden conversation" and "Show the second one again" and get the real stored photos back on the page, without uploading them again and without a vision call. This document is the design and the staged plan. **Only milestone 1 is built.** Milestones 2 and 3 each need separate approval.

Builds on `docs/photos.md` (storage, `photos_list`, `photos_inspect`, the strict-schema and time-zone fixes). Nothing there was duplicated: search extends `photos_list`, and display reuses its refs, policy and source resolver.

## Milestones

| | Scope | State |
|---|---|---|
| **1. Metadata search and display** | Text search over what ORBIT already stores (captions, conversation titles), filterable by date and conversation; `photos_show` galleries stored on the reply; a re-authorizing image route; the page gallery. | **Built (this change).** |
| 2. Observations with provenance | After a genuine `photos_inspect`, optionally persist what the model said it saw, tied to the exact processed image version, and reuse it later, always labelled as a model observation. | Not built. Needs approval. |
| 3. Topic and observation search, corrections, recall UX | Search over saved observations and extracted topics, owner corrections and deletions of observations, better recall UX (for example "photos like this"). | Not built. Needs approval. |

## Milestone 1: what exists now

Source: `src/photo-access.ts` (search, `photos_show`, `photoReach`, `photoDisplay`), `src/photo-ref.ts` (the stored contract), `src/agent.ts` (`ToolDisplay`, display admission in `runChat`), `src/thread-service.ts` (stores galleries on the reply), `src/threads.ts` (`ThreadMessage.gallery`, `safePatch`), `src/assistant-context.ts` (gallery note when calls are omitted), `src/server.ts` (views and the image route), `src/model.ts` (guidance), `src/web/index.html` (gallery). Tests: `test/photos-recall.test.ts`, `test/photos-recall-browser.test.ts`.

### Search (`photos_list` with `query`)

- `query` is a new optional argument (nullable under the strict Responses schema; `null`, `""` and whitespace mean "no query"). Without it, `photos_list` behaves exactly as before, and cursors it issued before stay valid.
- **What is searched:** the caption (the text of the message the photo was sent with, as the store keeps it, already masked) and the current title of the photo's conversation ("Assistant" for the Assistant). ORBIT has **no user labels or tags**, so none are searched. Nothing about pixels is searched or inferred.
- **Rule:** the query is folded (Unicode NFKD, accents removed, lowercase) and split into words of 2+ characters (or containing a digit); at most 8 words and 200 characters. A photo matches when **every** word is a substring of its folded caption or its folded title. Deterministic: same data, same answer.
- **Window:** a query with no `day` or `from`/`to` searches every date; with one, the usual owner-zone window applies (midnight, 23 h and 25 h DST days unchanged). Dates are ORBIT's own: `sentAt` (when Rai sent the photo to ORBIT; the upload is at most 24 h earlier, `uploadedAt`). There is **no capture date**: EXIF and GPS are stripped before upload and are never restored or guessed.
- **Result:** the usual items (stable ref, conversation, message, times, caption, image facts), plus per item `match: {caption: [...], conversationTitle: [...], kind: "text match, not visual verification"}`, and a `search` block with the terms, fields, rule, basis and `notAvailable` (content search, saved visual observations, topic extraction, user labels, capture dates). Zero matches add `noMatch`: no stored text matched, which says nothing about what photos show.
- **Bounds:** pages of 10 (at most 25), shrunk to the tool-output limit; the opaque cursor binds caller, conversation, window, archive choice **and the query terms**, so a cursor never continues a different query.
- **No index.** Every call reads the attachment records and the conversation stores directly (all in memory already). A rename, caption change, archive, revocation or deletion is seen by the next call; there is no cache to go stale, nothing to rebuild and nothing written. If a separate index is ever needed (milestone 3), it must be rebuildable from these sources, private, bounded and idempotent.

### Display (`photos_show`)

- `photos_show {refs: [1..10]}` (strict; `refs` required). Each ref is re-authorized (`photoReach`: the caller's policy, bound photos only, source still present). Duplicates are dropped keeping the first. A ref that is not visible (forged, pending, attachment id, another conversation this caller may not read, source gone) gets the same `not-found` text and **takes no position**. A visible photo whose file is missing or fails its SHA-256 is kept at its position as an `unavailable` placeholder.
- The result tells the model, per position, what was displayed and from where, and that it has **not** seen them. The tool returns **no image data** and `runChat` adds no image input for it: display never needs a vision-capable model and never puts pixels in the model's context. `photos_inspect` is unchanged and is still the only way a model sees a stored photo.
- **Admission (`runChat`).** A display request is accepted only where the caller enabled display (both conversation stores do; the legacy `/chat` route does not, and gets a refusal). At most 3 galleries per reply; a gallery identical to one already shown in the reply is refused ("refer to it by its positions"). A call cut off by its deadline or a cancellation never adds a gallery, even if it finished during the grace period.
- **Persistence.** The thread service writes each admitted gallery to the reply as soon as its call completes (`ThreadMessage.gallery: [{v: 1, callId, at, refs}]`), keyed by call id so a call recorded twice never adds a second gallery. Only ordered refs are stored: no titles, captions, ids, URLs, paths or bytes. `safeGalleries` enforces the contract on every write and view (version 1, ref shape, no duplicates, at most 10 refs and 3 galleries).
- **Views.** `GET /threads/:id` and `GET /assistant` (and `/assistant/history`) never send the stored refs; they send `galleries`, resolved **now** under the viewing conversation's policy: per item `position`, `ref`, `status` (`ok`, `unavailable`, `not-found`), and for visible items the source (conversation id, kind, current title, archived), message and photo position, `sentAt`/local time, a short caption, `src` (this conversation's own route) and `link` (`#chat/<uuid>` or `#assistant`). `not-found` items carry no source facts.
- **Image route.** `GET /assistant/photos/:ref` and `GET /threads/:id/photos/:ref`: owner only (`attachments` port; the Assistant route also needs `sessions`, as for the photo tools there), same-site only (`Sec-Fetch-Site` other than `same-origin`/`none` is refused), GET only. The viewing conversation is the route's, never a parameter. Every request re-authorizes the ref under that conversation's policy, re-checks the source and loads the file with its SHA-256 check: 404 when not visible, 410 when visible but missing or damaged. Response headers: `image/jpeg`, `cache-control: private, no-store` (a revoked source must not keep showing from cache), `nosniff`, `default-src 'none'; sandbox`, `cross-origin-resource-policy: same-origin`. No public URL exists and no file is copied.
- **Page.** A gallery under the reply: a note that displaying is not the model looking; up to 10 square thumbnails of the stored processed copy (there are no server-side thumbnails; the stored copy is at most 1600 px and 1 MiB), each with its position, source title, send time, photo position, caption and a source link; tap or click enlarges it in an overlay (Escape, the close button or a tap outside closes it). The page builds every image URL itself from a validated ref and its own conversation route, and every link only from a validated conversation id; titles and captions are only ever set as text. `unavailable` and `not-found` items are placeholders; an image that fails to load later (removed or revoked after the view) is replaced by a placeholder, never a broken image.

### "The second one"

The `photos_show` output (stored with the reply as the call's text output) lists `position` and `ref` for each item, and the model's context replays earlier calls with their outputs. When the Assistant's bounded context omits a turn's calls for budget, the omission note now keeps the gallery's ordered refs (`gallery 1: 1=ph_…, 2=ph_…`). The guidance tells the model that "the second one" means position 2 of the most recent gallery or listing and to reuse its ref with `photos_show` or `photos_inspect`. Context carries refs and metadata text only, never image data.

### Authorization (unchanged policy, enforced at every step)

Owner only. **Assistant:** the Assistant and every chat thread that still exists. **Chat thread:** only its own photos; naming another conversation is refused by rule and the tool descriptions say cross-conversation recall is offered from the Assistant. This policy is re-applied on every search, every `photos_show`, every view of a stored gallery, every image fetch and every `photos_inspect`. A gallery copied or replayed into another conversation grants nothing: a chat thread viewing an Assistant gallery resolves only its own photos, and its image route serves only its own. Refs cannot be turned into paths or URLs: only `ph_` + 32 hex is accepted, and it is looked up among bound attachments the caller may read.

### Lifecycle and retention

- Refs live as long as the attachment is stored (bound photos are kept with their conversation; nothing here deletes or extends anything).
- Stored galleries are part of the reply message, so they follow the conversation's own retention, archive and deletion: archiving a thread keeps its messages (and galleries); an archived source stays viewable from the Assistant and is marked archived, as for inspection.
- When a source is renamed the next view shows the new title; when it is archived the next view says so; when a message stops referring to a photo or the conversation is gone, views show `not-found` and the route answers 404; when a file is missing or damaged, views show `unavailable` and the route answers 410.
- Nothing derived is stored besides the ordered refs on the reply. No search index, no thumbnails, no captions or titles copied, no observations.

## Contract for later milestones (the seam, not built)

`orbit-photo-ref/1` (`src/photo-ref.ts`): a ref is `ph_` + 32 hex derived from the attachment's server-issued id; a stored gallery is `{v: 1, callId, at, refs}`. The authoritative record stays the attachment store (`id`, `scope`, `state`, `type`, `bytes`, `width`, `height`, `sha256`, `createdAt`, `boundAt`) plus the conversation message that binds it; no second source of truth was introduced.

Milestone 2 would add observation records keyed by **(ref, `sha256` of the processed bytes)**, so an observation is tied to the exact processed image version and becomes invalid if the bytes ever change (`load()` already verifies the hash). Each record would carry its provenance: the model and backend that produced it, the `photos_inspect` call and reply it came from (conversation, message, call id), the time, and that it is a model statement, not ground truth. Its retention would follow the photo's: removed with the photo or its conversation, hidden when the source is not visible to the caller, and correctable or deletable by Rai. Only text a model actually produced after real image input would be stored; nothing would be inferred in the background, and no faces, sensitive attributes or embeddings would be extracted.

## Not built (by design, in milestone 1)

- Search of image content, saved visual observations, semantic topic extraction, user labels, embeddings, face recognition, OCR indexing.
- Capture dates or places (EXIF/GPS are stripped at upload).
- Cross-conversation recall from a chat thread (Assistant only, as before).
- Server-side thumbnails; galleries load the stored processed copy.
- Deleting individual photos or galleries.

## Evidence

**Automated, offline (this change):**

- `test/photos-recall.test.ts`, through the real server and the **real** ChatGPT token-sharing and OpenAI API adapters with scripted HTTP: from the Assistant, `photos_list` with `query: "garden"` (every other field `null`) finds a thread's photos by title with the exact basis; `photos_show` stores the gallery; the view gives three `ok` items in the shown order; the image route returns exactly the stored processed bytes with `no-store`; stored state holds only the ordered refs and no base64; after a restart over the same state directory the gallery is the same; "show the second one again" resolves position 2 from the earlier output in the next request and displays that ref; **no request of these turns carries an image part**; an explicit `photos_inspect` of the same ref still sends exactly the stored bytes as `input_image`. In a chat thread: search and display stay in the thread, the other thread's ref takes no position and its route refuses; a removed file becomes `unavailable`/410. The route is owner only and same-site only; rename and archive show at the next view. Tool level: caption and title matching, AND semantics, case and accent folding, no-match wording, any-date versus windowed search, bounds and types, `null`/blank queries as no query, live renames and caption changes, archive, revocation, deletion, Chat isolation, hostile captions kept as text, paging with query-bound cursors, midnight and 23 h/25 h DST windows; `photos_show` ordering, duplicates, forged/pending/attachment-id/foreign refs, unavailable placeholders, bounds, owner; views and fetches re-authorized for the wrong caller, revoked and deleted sources, corrupt and deleted files, renames and archive; `safeGalleries` bounds; `runChat` display admission (enabled only where configured, duplicates and extras refused, interrupted calls show nothing, no image input added); the context note; the strict schemas and guidance.
- `test/photos-recall-browser.test.ts` (Playwright **Chromium** on Linux, real server and page, scripted model) at **390×844 (phone, touch)** and **1280×800 (desktop)**: the gallery loads the stored photos in order from the display route only, labels show a hostile title and caption as text (no markup, no script ran), the source link targets the thread, no horizontal scroll, tap enlarges within the screen and Escape/close dismiss it, a reload keeps it, a removed file shows an "unavailable" placeholder and a fetch that fails after the view shows a "could not be loaded" placeholder, a later "second one" gallery appears, and the source link opens the thread. In a chat thread the gallery uses the thread's own route and shows only its own photo.

**Not verified:** no live model call (whether a real model picks `query`, calls `photos_show` and resolves "the second one" as instructed is unverified), no Safari/iOS run, no production data or configuration. Production behaviour is unverified until the owner's checklist below passes.

## Manual owner acceptance (after deploying)

Use non-private test photos. Change no configuration.

1. In a Chat thread titled, for example, "Garden test", send two distinctive photos with the caption "tomato bed screenshot".
2. In the **Assistant**, ask "Find the screenshot from our garden conversation". The reply should call `photos_list` with a query such as "garden" and say it matched the title or caption (not that it saw the photo).
3. Ask "Show it to me". A gallery should appear under the reply with the photos, their thread title, send time and "Open conversation" link. The reply must not describe the photos' content unless it also called `photos_inspect`.
4. Tap a photo: it enlarges; close it. Tap "Open conversation": the thread opens.
5. Reload the page and open the Assistant on another device: the gallery is still there, in the same order.
6. Ask "Show the second one again": a new gallery with only the second photo appears.
7. Ask "Show me photos uploaded yesterday" (with photos from yesterday, Pacific time): it lists by date and can show them.
8. Ask "What is in the second one?": it should call `photos_inspect` and answer from the photo (only with an image-capable model).
9. Rename the thread, then reload the Assistant: the gallery labels show the new title. Archive the thread: the labels say archived and the photos still show.
10. In a **different** Chat thread, ask "Show me the garden photos". It should find only that thread's own photos (or none) and say other conversations are reachable from the Assistant.
11. Ask for something no caption or title mentions ("photos of a dog"): the reply should say no caption or title matched, not that no such photo exists.
