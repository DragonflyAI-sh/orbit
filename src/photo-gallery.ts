import type { Attachments } from "./attachments.ts";
import { comparePhotoKeys, localTime, photoKey, photoReach, queryTerms, reachablePhotos } from "./photo-access.ts";
import type { ConversationKind, Located, PhotoKey } from "./photo-access.ts";
import { isPhotoRef } from "./photo-ref.ts";
import { CORRECTION_LABEL, MODEL_LABEL, readableRecords } from "./photo-observations.ts";
import type { ObservationSources, ObservationStore, ReadableRecord } from "./photo-observations.ts";
import { collectEvidence, EVIDENCE_LABEL, keywordRanking } from "./photo-semantic.ts";
import type { Evidence, EvidenceKind, PhotoSemantic, SemanticSources } from "./photo-semantic.ts";
import { untrustedText } from "./sessions.ts";

// The page's photo gallery (docs/photo-gallery.md): the data behind the Images sidebar section's gallery in the centre pane. Read-only:
// nothing here writes a photo, an observation or a conversation. It is built from the same parts as the Assistant's photo tools, under
// the Assistant's reach (every owner conversation that still exists; archived threads aside), so the page never sees more than the
// Assistant's tools could:
// - list:   photos_list's reach, order (newest first, then message order, then ref) and opaque cursors, over every date;
// - search: photos_search's corpus (collectEvidence: captions, conversation titles, active model observations, active corrections and
//           Rai's next message) and its keyword rule (keywordRanking, every word must match), plus its semantic ranking when that
//           opt-in feature is configured, each result saying which words matched which stored text;
// - detail: photos_recall's records (readableRecords), superseded ones included so a correction can show what it replaced.
// Images are never sent here: the page fetches them through the Assistant's display route (/assistant/photos/<ref>, photos_show's),
// which re-authorizes and integrity-checks every fetch, as photos_inspect does before it loads a photo.

export const GALLERY_CALLER = "assistant:assistant";
export const GALLERY_PAGE_DEFAULT = 24;
export const GALLERY_PAGE_MAX = 60;
export const GALLERY_SEARCH_MAX = 120;
export const GALLERY_QUERY_MAX = 200;
const CAPTION_MAX = 280;
const TITLE_MAX = 100;
const SNIPPET_MAX = 160;
const OBS_TEXT_MAX = 240;
const CURSOR_MAX = 400;

export type GalleryPhoto = {
  ref: string;
  // Only when the stored file is present; built from the validated ref, never from stored text.
  src?: string;
  status: "ok" | "unavailable";
  sentAt: string;
  sentLocal: string;
  // The day and month it was sent, in ORBIT's configured zone (the zone photos_list's days use).
  day: string;
  month: string;
  caption: string;
  conversation: { id: string; kind: ConversationKind; title: string; archived?: true };
  message: { id: string; photo: number; of: number } | null;
  // Empty for an imported legacy photo, which has no ORBIT conversation to open.
  link: string;
  // Only for a photo the operator imported from a legacy assistant export (docs/photo-import-backfill.md): where it came from. The
  // caption above is then the legacy caption from the export, and sentAt the legacy send time.
  imported?: { source: string; item: string; importedAt: string; importedLocal: string; note: string };
  image: { type: string; width: number; height: number; bytes: number };
  // Counts of the saved records the Assistant may read about this exact image version (photos_recall's read), for the "AI" badge.
  ai: { observations: number; corrections: number };
};

export type MatchHit = {
  kind: EvidenceKind;
  label: string;
  terms: string[];
  snippet: string;
  source: { type: string; id: string };
  similarity?: number;
};
export type GalleryMatch = { photo: GalleryPhoto; via: ("keyword" | "semantic")[]; contextOnly: boolean; hits: MatchHit[] };

export type GalleryRecord = {
  id: string;
  kind: "model-observation" | "user-correction";
  state: "active" | "superseded";
  label: string;
  at: string;
  atLocal: string;
  scope?: string;
  observations?: string[];
  limitations?: string[];
  correction?: string;
  supersedes?: string[];
  supersededBy?: string;
  supersededAt?: string;
  inspection?: { via: "message" | "photos_inspect" | "backfill"; model: string };
  source: { conversation: { id: string; kind: "assistant" | "chat" | "operator"; title: string; archived?: true }; message: "present" | "archived"; link: string };
};

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
const text = (s: string, max: number) => untrustedText(s, max).text;
const linkOf = (conversation: string) => (conversation === GALLERY_CALLER ? "#assistant" : conversation.startsWith("chat:") ? `#chat/${conversation.slice("chat:".length)}` : "");
const dayIn = (iso: string, zone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

// A short window of the evidence text around the first matched term, so the page can show where the word was found.
export function snippetAround(raw: string, terms: string[], max = SNIPPET_MAX): string {
  const flat = text(raw, 10_000);
  if (flat.length <= max) return flat;
  const f = fold(flat);
  const at = Math.min(...terms.map((t) => f.indexOf(t)).filter((i) => i >= 0), flat.length);
  if (at >= flat.length) return text(flat, max);
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + max - 2).trim()}${start + max - 2 < flat.length ? "…" : ""}`;
}

// Which query terms one piece of evidence holds (case and accents ignored, as photos_list and photos_search match).
export function termsIn(raw: string, terms: string[]): string[] {
  const f = fold(text(raw, 10_000));
  return terms.filter((t) => f.includes(t));
}

// How many saved model observations and corrections `caller` may read about this photo's current version (photos_recall's read).
export function aiCounts(store: ObservationStore, sources: SemanticSources | ObservationSources, caller: string, l: Located) {
  let observations = 0;
  let corrections = 0;
  for (const x of readableRecords(store, sources, caller, l.ref, l.meta.sha256).readable) {
    if (x.r.kind === "model-observation") observations++;
    else corrections++;
  }
  return { observations, corrections };
}

// A photo's project links (docs/photo-import-backfill.md, "Project links"): read-only, from the import ledger. `project` is the vault
// path of the project's hub note; the gallery never reads or writes the vault for them.
export type GalleryProjectLink = { project: string; name: string; evidence: "explicit" | "operator-approved"; at: string };
export type GalleryDeps = { attachments: Attachments; sources: SemanticSources; store: ObservationStore; semantic?: PhotoSemantic; zone?: string; projects?: (ref: string) => GalleryProjectLink[] };
export const PROJECT_EVIDENCE_LABEL = {
  explicit: "linked from explicit project evidence in the legacy export",
  "operator-approved": "linked by the operator after review",
} as const;

export function photoGallery(d: GalleryDeps) {
  const zone = d.zone ?? "UTC";
  const caller = GALLERY_CALLER;
  const counts = (l: Located) => aiCounts(d.store, d.sources, caller, l);
  const view = (l: Located): GalleryPhoto => {
    const ok = d.attachments.present(l.meta.id, l.meta.scope);
    return {
      ref: l.ref,
      ...(ok ? { src: `/assistant/photos/${l.ref}` } : {}),
      status: ok ? "ok" : "unavailable",
      sentAt: l.sentAt,
      sentLocal: localTime(l.sentAt, zone),
      day: dayIn(l.sentAt, zone),
      month: dayIn(l.sentAt, zone).slice(0, 7),
      caption: (l.message?.caption ?? l.imported?.caption ?? "").trim() ? text(l.message?.caption ?? l.imported?.caption ?? "", CAPTION_MAX) : "",
      conversation: { id: l.conversation.id, kind: l.conversation.kind, title: text(l.conversation.title, TITLE_MAX), ...(l.conversation.archived ? { archived: true as const } : {}) },
      message: l.message ? { id: l.message.id, photo: l.message.photo, of: l.message.of } : null,
      link: linkOf(l.conversation.id),
      image: { type: l.meta.type, width: l.meta.width, height: l.meta.height, bytes: l.meta.bytes },
      ai: counts(l),
      ...(l.imported ? { imported: { source: text(l.imported.label, 80), item: l.imported.item, importedAt: l.imported.importedAt, importedLocal: localTime(l.imported.importedAt, zone), note: l.messageNote ?? "" } } : {}),
    };
  };
  const ordered = () => {
    const { photos, archivedHidden } = reachablePhotos(d, caller, false);
    return { photos: photos.sort((a, b) => comparePhotoKeys(photoKey(a), photoKey(b))), archivedHidden };
  };
  const record = (x: ReadableRecord): GalleryRecord => {
    const r = x.r;
    return {
      id: r.id,
      kind: r.kind,
      state: r.state === "superseded" ? "superseded" : "active",
      label: r.kind === "model-observation" ? MODEL_LABEL : CORRECTION_LABEL,
      at: r.at,
      atLocal: localTime(r.at, zone),
      ...(r.scope ? { scope: text(r.scope, OBS_TEXT_MAX) } : {}),
      ...(r.observations ? { observations: r.observations.map((o) => text(o, OBS_TEXT_MAX)) } : {}),
      ...(r.limitations?.length ? { limitations: r.limitations.map((o) => text(o, OBS_TEXT_MAX)) } : {}),
      ...(r.correction ? { correction: text(r.correction, 320) } : {}),
      ...(r.supersedes?.length ? { supersedes: r.supersedes } : {}),
      ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
      ...(r.supersededAt ? { supersededAt: r.supersededAt } : {}),
      ...(r.inspection ? { inspection: { via: r.inspection.via, model: text(r.inspection.model, 80) } } : {}),
      source: {
        conversation: { id: x.source.conversation, kind: x.source.kind, title: text(x.source.title, TITLE_MAX), ...(x.source.archived ? { archived: true as const } : {}) },
        message: x.source.message,
        link: linkOf(x.source.conversation),
      },
    };
  };

  return {
    // One page of every photo the Assistant may show, newest first. `cursor` is the opaque nextCursor of the previous page.
    list(opts: { cursor?: string; limit?: number } = {}) {
      const limit = opts.limit ?? GALLERY_PAGE_DEFAULT;
      if (!Number.isInteger(limit) || limit < 1 || limit > GALLERY_PAGE_MAX) throw new GalleryError(`limit must be an integer from 1 to ${GALLERY_PAGE_MAX}.`);
      let after: PhotoKey | undefined;
      if (opts.cursor) {
        try {
          if (opts.cursor.length > CURSOR_MAX) throw new Error();
          const c = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8")) as { v?: unknown; k?: PhotoKey };
          if (c.v !== 1 || !c.k || typeof c.k.s !== "string" || typeof c.k.c !== "string" || typeof c.k.p !== "number" || typeof c.k.r !== "string") throw new Error();
          after = c.k;
        } catch {
          throw new GalleryError("The cursor is not one this gallery gave. Start again from the first page.");
        }
      }
      const { photos, archivedHidden } = ordered();
      const rest = after ? photos.filter((l) => comparePhotoKeys(photoKey(l), after!) > 0) : photos;
      const page = rest.slice(0, limit);
      const more = rest.length > page.length;
      return {
        total: photos.length,
        returned: page.length,
        nextCursor: more && page.length ? Buffer.from(JSON.stringify({ v: 1, k: photoKey(page.at(-1)!) })).toString("base64url") : null,
        ...(archivedHidden ? { archivedHidden } : {}),
        zone,
        photos: page.map(view),
      };
    },

    // Photos whose stored text matches the query, newest first, each with how it matched. Keyword matching is photos_search's rule over
    // its corpus (every word must appear in the photo's own stored text; a match that needs Rai's next message is marked contextOnly);
    // semantic candidates are added when semantic search is configured. Nothing here looks at a photo.
    async search(query: string, opts: { signal?: AbortSignal } = {}) {
      if (typeof query !== "string" || !query.trim()) throw new GalleryError("Type a few words to search for.");
      if (query.length > GALLERY_QUERY_MAX) throw new GalleryError(`The search is at most ${GALLERY_QUERY_MAX} characters.`);
      let terms: string[];
      try {
        terms = queryTerms(query);
      } catch (err) {
        throw new GalleryError(err instanceof Error ? err.message.replace(/^query/, "The search") : "The search has no searchable word.");
      }
      const corpus = collectEvidence(d, caller, false);
      const eligible = corpus.evidence.filter((e) => e.state === "active" && e.text.trim());
      const byRef = new Map<string, Evidence[]>();
      for (const e of eligible) byRef.set(e.ref, [...(byRef.get(e.ref) ?? []), e]);
      // Matches keep the located photo; the page's view of it (with its AI counts) is built only for the matches returned.
      type Found = Omit<GalleryMatch, "photo"> & { l: Located };
      const matches = new Map<string, Found>();
      for (const ref of keywordRanking(query, eligible, "all")) {
        const l = corpus.byRef.get(ref);
        if (!l) continue;
        const ev = byRef.get(ref) ?? [];
        const own = new Set(ev.filter((e) => e.kind !== "discussion-context").flatMap((e) => termsIn(e.text, terms)));
        const hits: MatchHit[] = ev
          .map((e) => ({ e, t: termsIn(e.text, terms) }))
          .filter((x) => x.t.length)
          .map(({ e, t }) => ({ kind: e.kind, label: EVIDENCE_LABEL[e.kind], terms: t, snippet: snippetAround(e.text, t), source: { type: e.sourceType, id: e.sourceId } }));
        matches.set(ref, { l, via: ["keyword"], contextOnly: !terms.every((t) => own.has(t)), hits });
      }
      let mode: "keyword" | "hybrid" = "keyword";
      let degraded: string | undefined;
      if (d.semantic?.enabled) {
        try {
          const { r } = await d.semantic.search(caller, query, { includeArchived: false, signal: opts.signal });
          mode = r.mode === "hybrid" ? "hybrid" : "keyword";
          if (r.degraded) degraded = r.degraded;
          for (const c of r.candidates) {
            if (!c.via.includes("semantic")) continue;
            const l = corpus.byRef.get(c.ref) ?? photoReach(d, caller).find(c.ref);
            if (!l) continue;
            const hits: MatchHit[] = c.evidence.filter((e) => e.similarity !== undefined).map((e) => ({ kind: e.kind, label: e.label, terms: [], snippet: e.snippet, source: { type: e.sourceType, id: e.sourceId }, similarity: e.similarity }));
            const had = matches.get(c.ref);
            if (had) {
              had.via.push("semantic");
              had.hits.push(...hits);
            } else matches.set(c.ref, { l, via: ["semantic"], contextOnly: false, hits });
          }
        } catch (err) {
          degraded = `semantic ranking unavailable: ${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}`;
        }
      }
      // The gallery's order: newest first, the photos of one message in the order they were sent.
      const all = [...matches.values()].sort((a, b) => comparePhotoKeys(photoKey(a.l), photoKey(b.l)));
      return {
        query: text(query, GALLERY_QUERY_MAX),
        terms,
        mode,
        ...(degraded ? { degraded } : {}),
        rule:
          mode === "hybrid"
            ? "Every word must appear in a photo's stored text (keyword), or the stored text is close in meaning (semantic). Stored text is the caption, the conversation title, saved model observations, Rai's corrections and Rai's next message."
            : "Every word must appear in a photo's stored text: the caption, the conversation title, saved model observations, Rai's corrections and Rai's next message.",
        caveat: "A match means the words are in ORBIT's stored text about the photo, not that the photo shows them: image content is never searched, and observations are what a model said, not verified facts.",
        total: all.length,
        ...(all.length > GALLERY_SEARCH_MAX ? { more: all.length - GALLERY_SEARCH_MAX } : {}),
        coverage: { photosSearched: corpus.photos, ...(corpus.truncated ? { olderPhotosNotSearched: corpus.truncated } : {}), ...(corpus.archivedHidden ? { archivedHidden: corpus.archivedHidden } : {}) },
        matches: all.slice(0, GALLERY_SEARCH_MAX).map(({ l, ...m }): GalleryMatch => ({ photo: view(l), ...m })),
      };
    },

    // One photo with its saved records, or undefined when the ref is not a photo the Assistant may show now.
    detail(ref: string) {
      if (!isPhotoRef(ref)) return undefined;
      const l = photoReach(d, caller).find(ref);
      if (!l) return undefined;
      const recall = readableRecords(d.store, d.sources, caller, ref, l.meta.sha256);
      const records = recall.readable.map(record).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      const notReusable = { ...(recall.stale ? { olderImageVersion: recall.stale } : {}), ...(recall.sourceGone ? { sourceGone: recall.sourceGone } : {}), ...(recall.forgotten ? { forgotten: recall.forgotten } : {}) };
      return {
        photo: view(l),
        uploadedAt: l.meta.createdAt,
        ...(l.messageNote ? { messageNote: text(l.messageNote, 240) } : {}),
        observations: records.filter((r) => r.kind === "model-observation"),
        corrections: records.filter((r) => r.kind === "user-correction"),
        ...(Object.keys(notReusable).length ? { notReusable } : {}),
        projects: (d.projects?.(ref) ?? []).map((p) => ({ project: p.project, name: text(p.name, TITLE_MAX), evidence: p.evidence, label: PROJECT_EVIDENCE_LABEL[p.evidence], at: p.at })),
        labels: { observation: MODEL_LABEL, correction: CORRECTION_LABEL },
      };
    },
  };
}
export type PhotoGallery = ReturnType<typeof photoGallery>;

// A request the gallery refuses (a bad cursor, limit or query): the page shows the message; nothing was read.
export class GalleryError extends Error {}
