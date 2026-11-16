// The durable photo reference contract (docs/photo-recall.md). No imports, so the thread stores (src/threads.ts) and the photo
// tools (src/photo-access.ts) share it without a cycle.
//
// A photo ref ("ph_" + 32 hex) is derived from the attachment's server-issued id (src/photo-access.ts photoRef). It is stable for as
// long as the attachment is stored, names no conversation, path or URL, and is never accepted by the upload or read routes. It grants
// nothing by itself: every use (search, display, image fetch, replay of a stored gallery, inspection) re-checks the caller's policy
// and the photo's source.

export const PHOTO_REF_CONTRACT = "orbit-photo-ref/1";
const REF = /^ph_[0-9a-f]{32}$/;
export const isPhotoRef = (s: unknown): s is string => typeof s === "string" && REF.test(s);

// A gallery photos_show displayed under an assistant reply, as stored on that message: only the ordered refs and where they came
// from, never titles, captions, bytes, ids or URLs (those are resolved again, under the viewer's policy, every time it is shown).
// `callId` is the tool call that produced it, so a replayed or re-recorded call never adds a second gallery.
export type StoredGallery = { v: 1; callId: string; at: string; refs: string[] };
export const GALLERY_ITEMS_MAX = 10;
export const GALLERIES_PER_MESSAGE_MAX = 3;

// What may be stored, whatever a caller passes: unknown versions, malformed refs, duplicates and anything over the bounds are dropped.
export function safeGalleries(v: unknown): StoredGallery[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: StoredGallery[] = [];
  for (const g of v) {
    if (out.length >= GALLERIES_PER_MESSAGE_MAX) break;
    if (!g || typeof g !== "object") continue;
    const x = g as Record<string, unknown>;
    if (x.v !== 1 || typeof x.callId !== "string" || !x.callId || x.callId.length > 128 || typeof x.at !== "string" || !Array.isArray(x.refs)) continue;
    const refs = [...new Set(x.refs.filter(isPhotoRef))].slice(0, GALLERY_ITEMS_MAX);
    if (!refs.length || out.some((o) => o.callId === x.callId)) continue;
    out.push({ v: 1, callId: x.callId, at: x.at.slice(0, 40), refs });
  }
  return out;
}
