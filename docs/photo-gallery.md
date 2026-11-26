# Photo gallery

The web page's photo gallery: a centre-pane page (`/#gallery`) that shows every photo Rai sent, grouped by day or month,
with what ORBIT saved about each one. It is opened from the sidebar's **Images** section (docs/sidebar.md): a photo's
thumbnail opens the gallery with that photo enlarged, **Open the photo gallery** opens the grid, and the section's search
box opens the gallery with that search. Read-only: nothing on the page edits, deletes, inspects or sends a photo.

## What it shows

- **Grid.** Photos newest first, under a header per day (or per month, "By month"; the choice is remembered in this
  browser, `localStorage["orbit.gallery.group"]`). Four columns on a wide screen, three below 900px, two on a phone. Each
  photo shows its time and caption, an **AI** badge when a model observation is saved for it, and a ✎ badge when Rai
  corrected one. The first 24 are read; **Load more photos** (or browsing past the last one) reads the next page.
- **Enlarged photo.** A modal dialog over the page: the photo, previous and next buttons (and the ← → keys), a counter,
  and the metadata panel beside it (below it on a phone). Escape or ✕ closes it and puts focus back on the photo in the
  grid; everything behind it is `inert` while it is open.
- **Metadata panel.**
  - *File*: the photo's ref and type, when it was sent, its size in pixels and bytes. **Date taken and file name are not
    known**: the page strips EXIF and GPS before upload (docs/photos.md) and the original file name is never stored, so the
    panel says so instead of showing a made-up value.
  - *Source*: the conversation (the Assistant or a chat thread's title, archived marked), which photo of the message it
    was, and a link to that conversation.
  - *Caption*: the text of the message the photo was sent with, or that there was none.
  - *Search match* (when the photo was found by a search): each stored text that matched, which words, and a snippet.
  - *AI observations*: every saved model observation the Assistant may read (photos_recall's read): what the model said it
    saw, the limitations it noted, when, how the image reached it (sent with the message, or photos_inspect) and which
    model, what it was inspecting for (the record's scope), and the conversation it was made in, with a link. A
    superseded observation is struck through and says it was superseded (by Rai's correction, when one names it).
  - *Corrections*: "Rai corrected: …" with the time, a note that it is Rai's statement relayed from Rai's message and not a
    visual inspection, and the original observation it replaced, struck through.
  - Records that cannot be reused (about an older image version, whose conversation is gone, or forgotten) are counted,
    never shown.
- **Search.** A box at the top of the gallery, and one in the sidebar's Images section. Results replace the grid (still
  grouped by date) and each photo says what matched and how, for example `matched caption: 'garden'`,
  `matched AI observation: 'bookshelves'`, `matched Rai's correction: 'green'`. A match that needs Rai's next message
  after the photo is marked "only with conversation context". The page also states the rule and that a match is not proof
  of what the photo shows. **Clear** goes back to every photo.

## Where the data comes from

`GET` routes, owner only (src/server.ts, src/photo-gallery.ts). Each request is audited as attachment reading and session
reading, the decisions the Assistant's photo tools and the sidebar need; anyone else gets 403 and nothing of the photos.

| Route | Answer | Built from |
| --- | --- | --- |
| `/gallery/photos?limit=&cursor=` | One page (default 24, at most 60) and `nextCursor` | `photos_list`'s reach (`reachablePhotos` for the Assistant: every owner conversation that still exists, archived threads aside), its order (newest first, then message order, then ref) and opaque cursors, but over every date rather than one day window |
| `/gallery/search?q=` | Matching photos with `hits` (kind, words, snippet) | `photos_search`'s corpus (`collectEvidence`: captions, conversation titles, active model observations, active corrections and Rai's next message) and its keyword rule (`keywordRanking`: every word must appear, case and accents ignored); when semantic search is configured, its candidates (`semantic.search`) are added with their similarity |
| `/gallery/photos/<ref>` | The photo, its observations and corrections | `photos_recall`'s read (`readableRecords`), superseded records included so a correction can show what it replaced |

Images are never in these answers. The page loads each one from `/assistant/photos/<ref>`, the route that shows
`photos_show` galleries in the Assistant; it re-authorizes the ref and checks the stored file against the SHA-256
recorded at upload on every fetch, as `photos_inspect` does before it loads a photo. The page builds that address itself
from a validated ref, and links only to `#assistant` or `#chat/<uuid>`; captions, titles, observations and corrections
are untrusted text and are only ever set as text.

Differences from the tools, on purpose:

- The gallery lists every date; `photos_list` lists one day or a range of at most 31 days for the model.
- The gallery search returns every keyword match (at most 120 shown, the rest counted); `photos_search` gives the model
  its top 3 candidates. Like `photos_search`, it searches the newest 500 photos and says how many older ones were not.
- `photos_inspect` is not called: it supplies a photo to the model, and the page only needs to display it.

## Tests

- `test/photo-gallery.test.ts`: the routes on the real server with photos, observations saved by `photos_observe` and a
  correction relayed by `photos_correct` through the real tools: paging every photo exactly once, AI counts, search by
  caption, title, observation, correction and context (a superseded observation does not match), the detail with
  limitations, scope, context and the superseded original, refusals (owner only, GET only, bad cursor, limit and query,
  unknown refs); the sidebar's paged Images list; the page's pure helpers.
- `test/photo-gallery-browser.test.ts` (Chromium, desktop 1280px and phone 390px): opening a photo from the sidebar, the
  metadata panel, arrow keys, Escape and focus return, inert background, layout (beside or below), date and month
  groups, search from the gallery and the sidebar with match notes, a hostile caption shown as text, the sidebar pager and
  loading past the first page.

## Not verified

- A screen reader and Safari on a real iPhone were not tried (Chromium emulation only).
- Semantic matches in the gallery were not exercised in a browser; the merge is the same `semantic.search` call
  `photos_search` makes, which `test/photo-search-server.test.ts` covers.
