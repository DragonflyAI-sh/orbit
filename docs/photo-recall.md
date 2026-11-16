# Uploaded photo recall

Rai wants to say "Show me photos uploaded yesterday", "Find the screenshot from our garden conversation" and "Show the second one again" and get the real stored photos back on the page, without uploading them again and without a vision call. This document is the design and the staged plan. **Milestones 1 and 2 are built.** Milestone 3 needs separate approval.

Builds on `docs/photos.md` (storage, `photos_list`, `photos_inspect`, the strict-schema and time-zone fixes). Nothing there was duplicated: search extends `photos_list`, and display reuses its refs, policy and source resolver.

## Milestones

| | Scope | State |
|---|---|---|
| **1. Metadata search and display** | Text search over what ORBIT already stores (captions, conversation titles), filterable by date and conversation; `photos_show` galleries stored on the reply; a re-authorizing image route; the page gallery. | **Built** (#98). |
| **2. Observations with provenance** | After a photo is genuinely supplied to the model (attached to Rai's message, or `photos_inspect`), the model may save what it saw, tied to the exact processed image version, with server-assigned provenance; `photos_recall` reuses it later without pixels, always labelled as a model observation; Rai's corrections and forgetting. | **Built (this change).** |
| 3. Topic and observation search, recall UX | Search over saved observations and extracted topics across the library, better recall UX (for example "photos like this"). | Not built. Needs approval. |

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
- Nothing derived is stored besides the ordered refs on the reply. No search index, no thumbnails, no captions or titles copied. (Milestone 2 adds observation records in their own store; see below.)

## Milestone 2: saved observations with provenance

Source: `src/photo-observations.ts` (store, `photos_observe`, `photos_recall`, `photos_correct`, `photos_forget`, `readableRecords`), `src/agent.ts` (`TurnIdentity`, `DeliveredImage`, `Evidence`, `ChatTool.transcript`, delivery tracking in `runChat`), `src/thread-service.ts` (turn identity, delivered photos with their SHA-256, transcript stubs), `src/photo-context.ts` (the photo note names refs), `src/threads.ts` / `src/assistant-store.ts` (`messageState`), `src/server.ts` and `src/main.ts` (wiring, `<state>/photo-observations`), `src/model.ts` (guidance). Tests: `test/photos-observations.test.ts`.

### What it does

1. Rai sends a photo, or asks about an earlier one and the model calls `photos_inspect`. The model really receives the image.
2. After looking, the model calls `photos_observe {ref, scope, observations, limitations?, supersedes?}` (one photo per call). ORBIT admits it only if the evidence rules below hold, stores the record atomically, and only then returns `saved: true` with the record id. The model's next step (the usual tool loop, no separate inference call to produce observations) answers Rai and may say it was saved.
3. Later, "what did you previously notice about this photo?" or a follow-up the records cover: the model calls `photos_recall {refs}` (text and metadata only, no image input) and answers "the earlier inspection recorded …" with date and source. For a detail the records do not mention, conflicting, stale or superseded records, or when Rai asks to look again, it calls `photos_inspect` as before.
4. "No, that's a heron": `photos_correct` stores Rai's statement and supersedes the named records. "Forget what you saw in that photo": `photos_forget` removes the text.

### Evidence: when a visual observation is admitted (`photos_observe`)

The backend can prove that an image was delivered, never that a description of it is correct. So a saved observation is always a **model observation** (label: "what the model said it saw when this exact processed image was supplied to it; not a verified fact"). ORBIT admits one only when **all** of these hold, checked in `runChat` and the tool from server state, never from arguments:

- **Delivered in this reply.** `runChat` keeps a per-reply map of refs that really reached the model as image input: the photos the first request carried (the turn's own message and, under the existing context rule, the newest earlier photo messages of the same conversation; the thread service records each with the SHA-256 of the exact bytes loaded), and photos `runChat` admitted from a `photos_inspect` result (hash of the admitted bytes). A blocked, refused, over-budget, not-found, unavailable or interrupted inspection adds nothing. Listing, showing, captions, titles, previous assistant text and saved observations never add anything.
- **Seen before the call.** Photos the message carried are seen from step 0; photos `photos_inspect` supplied in round *r* are seen from step *r* + 1 (they follow that round's tool results). A save in the same step as its inspection is refused.
- **A completed primary generation.** The step that asked for the save was not answered by the OpenRouter fallback (which is never given photos) and carried no `incomplete` note (cut off, or malformed calls dropped).
- **Same version.** The delivered bytes' SHA-256 equals the attachment's recorded SHA-256, and the stored file still passes its integrity check now.
- **Visible now.** The ref is re-authorized with `photoReach` for the calling conversation (owner, policy, bound, source still present).
- **Strict arguments.** Only `ref`, `scope`, `observations`, `limitations`, `supersedes` are accepted; any other key (for example `model`, `at`, `sha256`, `inspected`) is refused with "provenance is assigned by ORBIT".

The ref of a photo Rai attached is named in ORBIT's note in front of the images (`Refs in order: photo 1 = ph_…`), so a batch is assigned per photo; each call saves exactly one ref.

### Data contract (`orbit-photo-observation/1`)

One file per photo: `<state>/photo-observations/<ref>.json` = `{v: 1, contract, ref, rev, records: [...]}`, mode 0600 in a 0700 directory. A record:

| Field | Meaning | Set by |
|---|---|---|
| `id` | `ob_` + 24 hex = SHA-256 of (contract, conversation, reply message, call id, ref). Deterministic, so a call recorded or retried twice maps to one record. | server |
| `kind` | `model-observation` or `user-correction`. Never mixed. | server |
| `state` | `active`, `superseded` or `forgotten`. | server |
| `image` | `{sha256, bytes, width, height}` of the stored processed JPEG the record is about. | server (attachment record) |
| `at` | when it was saved (server clock). | server |
| `source` | `{conversation, message, callId, userMessage}`: the conversation (session id), the assistant reply and tool call that saved it, and Rai's message that started the turn. | server (turn context) |
| `inspection` | model observations only: `{via: "message" \| "photos_inspect", callId (the inspect call), step, model}`. `model` is the model ORBIT requested (`status().impl`), not an identity the provider confirmed. | server (`runChat` evidence) |
| `scope` | what the inspection was about, as the model stated it (≤ 160 chars). | model |
| `observations` | 1–6 short statements (≤ 240 chars each). | model |
| `limitations` | 0–3 (≤ 160 chars each). | model |
| `correction` | user corrections only: Rai's statement as relayed (≤ 300 chars). | model, relaying Rai |
| `supersedes`, `supersededBy`, `supersededAt` | supersession links. | server |
| `forgotten` | `{at, conversation, message}` of the forgetting turn. | server |

Authoritative upload facts stay in the attachment store; user context stays in the conversation; model observations and Rai's corrections are separate record kinds and are always labelled differently in `photos_recall`. Text is flattened (control and invisible characters removed), masked with the conversation masker, and refused if it contains a data URL or a long opaque run (base64, keys). No original upload, EXIF/GPS, base64, image bytes or transcripts are stored.

**Bounds:** 1–6 observations, 0–3 limitations, scope ≤ 160, correction ≤ 300, at most 6 superseded ids per write; at most 10 saves (observe and correct together) per reply; at most 12 active records and 30 records in total per photo (at the cap the oldest forgotten, then superseded, entries are dropped; active records are never evicted, a save is refused instead); a file over 256 KiB is not read or written; `photos_recall` takes at most 5 refs and is shrunk to the tool-output limit, oldest records first, saying how many it left out.

### Writes: atomicity, idempotency, concurrency, failure semantics

- Each change is one synchronous read-modify-write of one photo's file: read from disk, validate every record against the contract, apply, validate again, write a temp file, fsync, rename; `rev` increases by one. A crash leaves the old or the new file, never a mix; leftover temp files are removed at start. A file that does not parse or breaks the contract is not served and **never overwritten** (writes refuse), so a person can inspect it.
- ORBIT is the only writer, and Node runs each change to completion without interleaving, so concurrent turns (the Assistant and a chat thread) never lose an update. There is no cross-process lock: a second ORBIT process writing the same state directory is not supported (as for the thread stores).
- **Commit point: the tool call.** A record is written when `photos_observe` runs, after the model step that asked for it completed and the evidence checks passed. Nothing is staged and nothing is written later. Consequences: an aborted or failed model request, a cancelled turn, a step that never asks to save, or a refused call writes nothing and claims nothing; a reply that fails **after** a successful save keeps the record (the observation was made from a real delivery), and its source message is then an errored reply, which `photos_recall` still links to. The tool's result (and so the call row on the page) says `saved` only after the write returned.
- **Idempotency.** The same call id in the same reply is recorded once (`duplicate: true`); the same observations saved twice in one reply are stored once. A retried message is a new turn, a new delivery and so a new record.

### Reads (`photos_recall`) and the decision policy

For each ref: re-authorize the photo (`photoReach`) and load it with its SHA-256 check (a missing or damaged file: `photo-unavailable`, no record reusable). Then each record (`readableRecords`): its source conversation must be readable by the caller (Chat: only itself; Assistant: itself and every existing chat thread), that conversation must still exist and still hold the source message (an Assistant message in an archived chunk is kept and marked, as photo discovery does), and its image version must equal the photo's current SHA-256. Forgotten records, records about another version and records whose source is gone are **counts only** (`notReusable`), never text. Superseded records only with `includeSuperseded: true`, marked with `supersededBy`. A record from a conversation the caller cannot read is left out without a count, so a chat thread does not learn that the Assistant observed its photo.

Each returned record carries its label, id, kind, state, time (UTC and owner-zone), exact image version, source (conversation, title, archived, reply, Rai's message, call, page link), how the image was delivered and the requested model, scope, observations, limitations, correction and supersession links. The result returns no image and `runChat` adds no image input for it.

**Decision policy (guidance, `src/model.ts photoGuidance`).** ORBIT cannot decide whether recorded text answers a question; the model does, following the guidance: recall first for "what did you notice" and covered follow-ups; answer with "the earlier inspection recorded …" and never imply seeing the photo now; a correction wins over a model observation; inspect afresh for a detail the records do not mention, for conflicting, stale or superseded records, or when Rai asks to look again ("a detail missing from the records is not evidence that it is missing from the photo"); save after looking; never save for a photo only listed, shown, captioned or recalled. The backend enforces the structural rules above; the tests check this policy only with **scripted** models, which is not evidence that a real model follows it. The earlier wording ("saved visual observations do not exist yet") is replaced; the rule that a listing, caption or earlier description is not the photo is kept.

Note: in the **same** conversation, ORBIT's existing context rule (`docs/photos.md`) re-sends the newest photo messages with each request, so a follow-up there may carry the pixels anyway; recall matters most for photos not in the current request (another conversation, or older photos). This milestone does not change that rule.

### Corrections (`photos_correct`)

Owner only, needs a turn with a message from Rai (its id is recorded as `source.userMessage`), the photo visible and intact. Stored as `user-correction` with the photo's current version, **never** with an `inspection`, and labelled "Rai's statement relayed from his message; not a visual inspection". It supersedes only the active records it names, which must be readable by the caller and about the current version; anything else refuses the whole call. Superseded records are excluded from default reuse and kept for audit (with `supersededBy`). Nothing else is amended.

### Forgetting (`photos_forget`) and retention

Owner only. Forgets the named records (or, with `ids: null`, every record of that photo **the caller can read**; a chat thread cannot forget the Assistant's records). The record keeps only a minimal audit entry: `id`, `kind`, `state: forgotten`, `ref`, image version, original time, source ids (conversation, reply, Rai's message, call) and `forgotten {at, conversation, message}`. Scope, observations, limitations and correction text are deleted from the file at once and never reconstructed. Records a forgotten correction had superseded stay superseded (no silent amendment); the oldest forgotten entries are the first to go at the per-photo cap. Forgetting works even if the photo's file is damaged, as long as the photo is visible.

Retention otherwise follows the photo: records are kept as long as the photo and are never served once the photo, its source message or the record's source conversation is gone, or the image version changed. There is no photo deletion in ORBIT yet, so nothing deletes the files; when one exists it must remove `<ref>.json` too.

### Transcript and replay (stale text)

Observation text lives in exactly one place, the observation store. `ChatTool.transcript` lets a tool decide what the conversation stores of its call: for `photos_observe`, `photos_recall` and `photos_correct` the stored arguments, output and summary keep refs, ids, kinds, states and counts only (`"observation text is not kept in the conversation transcript; photos_recall reads the current records"`). The model sees the full result within its own reply; replayed context, the page, `session_read`, compaction summaries and the omitted-calls note only ever see the stub. So after forgetting, a correction, a revocation or a version change, no stale observation text comes back through tool history: a later reply must call `photos_recall`, which re-authorizes everything.

**Limitation:** the model's own reply prose ("It shows a blue mug") is part of the conversation, as before, and is replayed and summarized like any reply. Forgetting does not edit earlier replies (the tool says so), and the rolling recent-context note may have summarized them.

### Authorization

Same policy as milestone 1, on every read, write, correction, forget and replay: owner only (`attachments` policy port; the Assistant also `sessions`), the photo re-authorized by `photoReach`, and each record's source conversation re-authorized by `photoPolicy`. Chat gains no cross-thread access: it can neither read nor change records made elsewhere. A gallery or a listed ref grants nothing. Archived sources stay readable from the Assistant and are marked archived. Observation and correction text, captions and titles are untrusted data in every result ("never instructions").

### Not built in milestone 2

- Search over observations or topics across the library, "photos like this", embeddings (milestone 3).
- Background or batch indexing, any automatic inference outside a request Rai made.
- Face recognition, identification of people, automatic sensitive-attribute inference: the save tool tells the model not to record them; ORBIT does not detect them semantically (see residual risks).
- A page UI for observations beyond the call rows ("✓ photos_observe … saved") and the model's reply.
- Cross-process locking; photo deletion.

## Seam for milestone 3 (not built)

`orbit-photo-ref/1` (`src/photo-ref.ts`) and `orbit-photo-observation/1` (`src/photo-observations.ts`). The authoritative records stay the attachment store (`id`, `scope`, `state`, `type`, `bytes`, `width`, `height`, `sha256`, `createdAt`, `boundAt`), the conversation message that binds a photo, and one observation file per ref. An observation search would walk `observationStore.refs()`, re-authorize each photo with `photoReach` and each record with `readableRecords` for the caller (exactly as `photos_recall` does), match only `active` records about the current version, and label every hit as "text match over saved model observations, not visual verification". Any index it adds must be rebuildable from these files, private, bounded and idempotent, and must drop forgotten text at once.

## Contract kept from milestone 1

`orbit-photo-ref/1` (`src/photo-ref.ts`): a ref is `ph_` + 32 hex derived from the attachment's server-issued id; a stored gallery is `{v: 1, callId, at, refs}`. The authoritative record stays the attachment store (`id`, `scope`, `state`, `type`, `bytes`, `width`, `height`, `sha256`, `createdAt`, `boundAt`) plus the conversation message that binds it; no second source of truth was introduced.

The milestone 1 design said milestone 2 would key observations by **(ref, `sha256` of the processed bytes)** and carry their provenance, follow the photo's retention and be correctable and deletable by Rai; that is what was built (above), with one change: a record is admitted after any genuine delivery of the image to the model (the photo attached to Rai's message, or `photos_inspect`), not only after `photos_inspect`.

## Not built (by design, in milestone 1)

- Search of image content, saved visual observations (milestone 2 adds them, without search), semantic topic extraction, user labels, embeddings, face recognition, OCR indexing.
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

## Milestone 2 evidence

**Automated, offline (this change):** `test/photos-observations.test.ts`. Every image is synthetic; every model answer is scripted (at the ChatGPT token-sharing and OpenAI API adapters' HTTP boundary through the real server, or as a scripted `ModelPort` through the real `runChat` dispatch). The policy decisions in these tests (save after looking, recall first, inspect again for a new detail) are **scripted assertions of the guidance, not proof of what a real model does**.

- Acceptance, both adapters: a photo attached to Rai's message in a chat thread is sent as image input with its ref in ORBIT's note; `photos_observe` saves it with server-assigned provenance (thread, reply, Rai's message, call, delivered via the message at step 0, requested model, exact SHA-256); the stored transcript holds no observation text; after a restart over the same state directory the Assistant's `photos_recall` returns the record with its label, source, link, scope, limitations and version, **no request of that turn carries an image part**, and replayed history carries only the stub; a question about a detail the record does not mention goes through `photos_inspect`, whose request carries exactly the stored bytes.
- `photos_inspect` then save in the next step records `via: photos_inspect` with the inspect call id; listing and showing from the Assistant (with a hostile caption that asks for a save) cannot save.
- `runChat` evidence: an undelivered ref, fabricated provenance fields, a forged ref, a fallback step, a cut-off step and a missing turn context are refused; same-step inspect-and-save is refused; partial delivery (over budget) admits only the supplied photo; a blocked model admits none; a batch is assigned per photo.
- Aborted provider request and cancelled turn write nothing; the same call twice and the same observations twice give one record; four concurrent saves on one photo all land and `rev` counts each.
- Corrections supersede the named record, carry Rai's message id and no inspection, are labelled as his statement, and hide the superseded record by default; superseding a non-active record is refused.
- Forgetting removes the text from the file, keeps the audit entry, is idempotent, leaves records of other conversations alone, and the forgotten record is a count only.
- Access: a chat thread neither sees nor counts the Assistant's record of its own photo; another thread gets "not found" for read, save and forget; not-owner is refused; an archived source thread stays readable from the Assistant and is marked; a gone source message, a changed image version and a revoked photo give no reusable text; a damaged photo file gives `photo-unavailable` and refuses saves; a broken record file is not served and not overwritten.
- Hostile observation text is returned as data under the untrusted notice; data URLs, opaque runs, over-long and too many items are refused.
- Strict schemas: every optional field is nullable and listed as required in the strict form; null is accepted. Guidance contains the recall-first, "earlier inspection recorded", "not evidence of absence" and inspect-again rules, and the old "do not exist yet" wording is gone.
- Regression: the full suite (`pnpm test`) and `pnpm typecheck` pass, including milestone 1 search/display/route/browser tests and the photo upload, inspection and capability tests.

**Not verified:** no live model call (whether a real model saves after looking, recalls first, phrases answers as earlier inspections, or avoids sensitive attributes is unverified), no production data or configuration, no Safari/iOS run.

### Residual risks

- A saved observation is only as good as the model's description; ORBIT proves delivery, not correctness. Labels say so.
- The model writes `scope` and the observation text; it could misstate the scope, or relay a "correction" Rai did not make (the record names Rai's message so it can be checked).
- Sensitive attributes and identification of people are excluded by instruction only.
- The model may skip saving, or recall when it should inspect; nothing forces the policy.
- Reply prose that quoted an observation stays in the conversation after forgetting.
- Single-writer assumption: no cross-process lock on the observation files.
- In the same conversation the existing context rule may still re-send recent photos, so recall does not always avoid pixels there.

## Milestone 2 owner acceptance (after deploying)

Use non-private test photos (for example a mug with a sticky note). Change no configuration. Needs an image-capable model.

1. In a Chat thread "Desk test", send a photo with "What's in this photo?". The reply should describe it; the tool calls should show `✓ photos_observe(…)` with a saved record id. If the model did not save, note it (guidance is not enforcement).
2. In the **Assistant**, ask "What did you previously notice about the photo from Desk test?". It should call `photos_list` (if needed) and `photos_recall`, answer "the earlier inspection recorded …" with the date and thread, and not claim to see the photo.
3. Ask a detail you did not mention and the first answer did not cover ("what colour is the pen?"). It should call `photos_inspect` and answer from the photo.
4. Say "No, the mug is green, not blue." It should call `photos_correct`; ask again what was noticed: the correction should lead, labelled as your statement.
5. Say "Forget what you saw in that photo." It should call `photos_forget`; ask again: it should say nothing reusable is saved and offer to look again.
6. In a **different** Chat thread, ask about that photo: it should not find it or any observation.
7. Reload the page and restart ORBIT if convenient: steps 2 to 5 should behave the same.
8. Ask "Did you save anything about that photo?" right after a listing or a gallery without inspection: it should not claim a save.
