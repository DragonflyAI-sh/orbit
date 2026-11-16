// Synthetic fixture and evaluation harness for opt-in hybrid photo retrieval (docs/photo-semantic-search.md; first written for the
// spike, docs/photo-semantic-spike.md).
//
// Everything here is invented: refs, hashes, captions and observations describe no real photo. The `lexicalStandIn` embedder is a
// character-trigram hash: it measures PLUMBING (caching, lifecycle, access, fusion, fallback) and spelling tolerance, never semantic
// quality. Results produced with it must not be reported as semantic retrieval quality. `runEvaluation` takes any `Embedder`, so the
// same harness runs unchanged against the real adapter (tools/photo-semantic-eval, owner-run, bounded).
import { createHash } from "node:crypto";
import type { Embedder } from "../src/embeddings.ts";
import type { Access, Evidence, RetrievalResult, VectorCache } from "../src/photo-semantic.ts";
import { countingEmbedder, eligibleEvidence, keywordRanking, retrieve } from "../src/photo-semantic.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const ref = (n: string) => `ph_${h(`fixture:${n}`).slice(0, 32)}`;
const ver = (n: string, rev = 1) => h(`image:${n}:${rev}`);

export const P = {
  bookRestaurant: ref("book-restaurant"),
  noodleBar: ref("noodle-bar"),
  homeShelves: ref("home-shelves"),
  gardenWithLibraryTalk: ref("garden"),
  heron: ref("heron"),
  forgottenCafe: ref("forgotten-cafe"),
  stalePizza: ref("stale-pizza"),
  otherThreadBookstore: ref("other-thread-bookstore"),
  wineBarBooks: ref("wine-bar-books"),
  receipt: ref("receipt"),
} as const;
export const LABEL: Record<string, string> = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]));

const VERSION: Record<string, string> = Object.fromEntries(Object.values(P).map((r) => [r, ver(r)]));

type E = Omit<Evidence, "photoSha256" | "state"> & { photoSha256?: string; state?: Evidence["state"] };
const ev = (e: E): Evidence => ({ state: "active", photoSha256: VERSION[e.ref], ...e });

// 10 photos, 20 evidence records (the brief's "about 12 records" refers to photos/records; counts are reported exactly).
export function fixtureEvidence(): Evidence[] {
  return [
    ev({ ref: P.bookRestaurant, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-a1", text: "dinner at Marlow's" }),
    ev({ ref: P.bookRestaurant, kind: "conversation-title", sourceType: "thread-title", sourceId: "thr-a", text: "Weekend plans" }),
    ev({ ref: P.bookRestaurant, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-a1", text: "Restaurant dining room; tall wooden bookshelves full of books line the wall behind the tables." }),
    ev({ ref: P.noodleBar, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-b1", text: "lunch at the noodle bar" }),
    ev({ ref: P.noodleBar, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-b1", text: "Counter seating in a small noodle shop with red paper lanterns overhead." }),
    ev({ ref: P.homeShelves, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-c1", text: "new shelves done!" }),
    ev({ ref: P.homeShelves, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-c1", text: "Living room with white bookshelves holding paperbacks and a reading chair." }),
    ev({ ref: P.gardenWithLibraryTalk, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-d1", text: "tomatoes finally ripe" }),
    ev({ ref: P.gardenWithLibraryTalk, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-d1", text: "Vegetable garden bed with ripe red tomatoes on stakes." }),
    ev({ ref: P.gardenWithLibraryTalk, kind: "discussion-context", sourceType: "thread-message", sourceId: "msg-d2", text: "Also, should we go to the city library with all the books tomorrow?" }),
    ev({ ref: P.heron, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-e1", state: "superseded", text: "A crane standing in shallow water." }),
    ev({ ref: P.heron, kind: "user-correction", sourceType: "observation-record", sourceId: "ob-e2", text: "That bird is a heron." }),
    // Forgotten: the store deletes the text; it is kept here only to prove eligibility drops it before anything else sees it.
    ev({ ref: P.forgottenCafe, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-f1", state: "forgotten", text: "Cafe with a big bookcase behind the counter." }),
    ev({ ref: P.forgottenCafe, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-f1", text: "coffee" }),
    // Stale: observation about an earlier processed version.
    ev({ ref: P.stalePizza, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-g1", photoSha256: ver(P.stalePizza, 0), text: "Pizza place with bookshelves behind the oven." }),
    ev({ ref: P.stalePizza, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-g1", text: "friday" }),
    // Unauthorized for the evaluated caller (a chat thread that cannot read this other thread).
    ev({ ref: P.otherThreadBookstore, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-h1", text: "Bookstore cafe with shelves of books behind the tables." }),
    ev({ ref: P.wineBarBooks, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-i1", text: "drinks after work" }),
    ev({ ref: P.wineBarBooks, kind: "visual-observation", sourceType: "observation-record", sourceId: "ob-i1", text: "Wine bar with a wall of old books behind the bar." }),
    ev({ ref: P.receipt, kind: "caption", sourceType: "attachment-caption", sourceId: "msg-j1", text: "receipt for the plumber" }),
  ];
}

export function fixtureAccess(over: Partial<{ unauthorized: Set<string>; versions: Record<string, string | undefined>; revalidateFails: Set<string> }> = {}): Access {
  const unauthorized = over.unauthorized ?? new Set([P.otherThreadBookstore]);
  const versions = { ...VERSION, ...over.versions };
  return {
    authorizedRefs: () => new Set(Object.values(P).filter((r) => !unauthorized.has(r))),
    currentVersion: (r) => versions[r],
    revalidate: (r, v) => !(over.revalidateFails?.has(r)) && versions[r] === v && !unauthorized.has(r),
  };
}

export type Query = { q: string; intended: string | null; mustNot?: string[]; note: string };
export const QUERIES: Query[] = [
  { q: "restaurant bookshelves", intended: P.bookRestaurant, note: "exact words, observation only" },
  { q: "that place with the library behind it", intended: P.bookRestaurant, note: "paraphrase; wine bar is plausible too" },
  { q: "place we ate with all the books", intended: P.bookRestaurant, note: "paraphrase" },
  { q: "bookshelfs restaurant", intended: P.bookRestaurant, note: "misspelling" },
  { q: "Marlow's", intended: P.bookRestaurant, note: "exact caption word" },
  { q: "dinner", intended: P.bookRestaurant, note: "exact caption word" },
  { q: "bar with a wall of books", intended: P.wineBarBooks, note: "second plausible photo" },
  { q: "drinks after work", intended: P.wineBarBooks, note: "exact caption" },
  { q: "heron", intended: P.heron, note: "active correction" },
  { q: "crane in the water", intended: null, mustNot: [], note: "only the superseded observation said crane" },
  { q: "big bookcase cafe", intended: null, mustNot: [P.forgottenCafe], note: "forgotten observation" },
  { q: "pizza place bookshelves", intended: null, mustNot: [P.stalePizza], note: "stale (old version) observation" },
  { q: "bookstore cafe", intended: null, mustNot: [P.otherThreadBookstore], note: "unauthorized source" },
  { q: "city library", intended: null, mustNot: [], note: "context-only discussion on an unrelated garden photo" },
  { q: "noodle bar lunch", intended: P.noodleBar, note: "exact caption" },
  { q: "red lanterns", intended: P.noodleBar, note: "observation only" },
  { q: "paperbacks at home", intended: P.homeShelves, note: "observation only" },
  { q: "receipt", intended: P.receipt, note: "exact caption" },
  { q: "giraffe on the moon", intended: null, mustNot: [], note: "unanswerable" },
  { q: "tomatoes in the garden", intended: P.gardenWithLibraryTalk, note: "caption + observation" },
];

// Character-trigram hashing into a fixed number of dimensions. NOT A SEMANTIC MODEL: it knows nothing about meaning ("library" and
// "books" share no trigrams). It exists to drive the plumbing deterministically and offline.
export function lexicalStandIn(dims = 256): Embedder {
  const vec = (s: string) => {
    const v = new Array<number>(dims).fill(0);
    const words = s.toLowerCase().replace(/^[a-z-]+: /, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
    for (const w of words) {
      const p = ` ${w} `;
      for (let i = 0; i + 3 <= p.length; i++) {
        const g = p.slice(i, i + 3);
        let x = 2166136261;
        for (let j = 0; j < g.length; j++) x = Math.imul(x ^ g.charCodeAt(j), 16777619);
        v[(x >>> 0) % dims] += 1;
      }
    }
    return v;
  };
  return { id: { model: "lexical-stand-in", dims, format: "offline-test" }, embed: async (texts) => texts.map(vec) };
}
const STOP = new Set(["the", "and", "that", "with", "all", "for", "behind", "place", "query", "its", "this", "was", "are"]);

type Side = { rank: number | null; top3: boolean; misleading: string[] };
export type Row = { q: string; note: string; intended: string; keywordMetadata: Side; keywordAll: Side; hybrid: Side & { ambiguous: boolean; noMatch: boolean; mode: string; context: string[] } };

const rankOf = (r: string[], target: string | null) => (target ? r.indexOf(target) + 1 || null : null);

// Three rankings over the SAME eligible corpus (forgotten, superseded, stale and unauthorized evidence already removed):
// - keywordMetadata: photos_list's existing rule (captions and titles only), the status quo;
// - keywordAll: the fair keyword baseline over every evidence kind the hybrid sees, so coverage gains are not credited to embeddings;
// - hybrid: retrieve() with the given embedder.
export async function runEvaluation(o: { embedder: Embedder; cache: VectorCache; maxRequests: number; access?: Access; queries?: Query[] }) {
  const access = o.access ?? fixtureAccess();
  const { embedder, counts } = countingEmbedder(o.embedder, o.maxRequests);
  const queryCache = new Map<string, number[]>();
  const evidence = fixtureEvidence();
  const eligible = eligibleEvidence(evidence, access);
  const rows: Row[] = [];
  const results: RetrievalResult[] = [];
  const latencies: number[] = [];
  for (const q of o.queries ?? QUERIES) {
    const t0 = performance.now();
    const hy = await retrieve({ query: q.q, evidence, access, embedder, cache: o.cache, queryCache });
    latencies.push(performance.now() - t0);
    results.push(hy);
    const side = (refs: string[]): Side => ({ rank: rankOf(refs, q.intended), top3: q.intended ? refs.slice(0, 3).includes(q.intended) : refs.length === 0, misleading: refs.slice(0, 3).filter((r) => q.mustNot?.includes(r)).map((r) => LABEL[r]!) });
    const hyRefs = hy.candidates.map((c) => c.ref);
    rows.push({
      q: q.q,
      note: q.note,
      intended: q.intended ? LABEL[q.intended]! : "(none)",
      keywordMetadata: side(keywordRanking(q.q, eligible, "metadata").slice(0, 3)),
      keywordAll: side(keywordRanking(q.q, eligible, "all").slice(0, 3)),
      hybrid: { ...side(hyRefs), ambiguous: hy.ambiguous, noMatch: hy.noMatch, mode: hy.mode, context: hy.candidates.filter((c) => c.evidence.every((e) => e.kind === "discussion-context")).map((c) => LABEL[c.ref]!) },
    });
  }
  const answerable = rows.filter((r) => r.intended !== "(none)");
  const unanswerable = rows.filter((r) => r.intended === "(none)");
  const sum = (k: "keywordMetadata" | "keywordAll" | "hybrid") => ({
    top1: answerable.filter((r) => r[k].rank === 1).length,
    top3: answerable.filter((r) => r[k].top3).length,
    emptyOnUnanswerable: unanswerable.filter((r) => r[k].top3).length,
    misleading: rows.filter((r) => r[k].misleading.length).length,
  });
  return {
    rows,
    results,
    counts,
    summary: {
      queries: rows.length,
      answerable: answerable.length,
      unanswerable: unanswerable.length,
      keywordMetadata: sum("keywordMetadata"),
      keywordAll: sum("keywordAll"),
      hybrid: sum("hybrid"),
      ambiguousFlagged: rows.filter((r) => r.hybrid.ambiguous).length,
      cacheEntries: o.cache.count(),
      cacheBytes: o.cache.bytes(),
      latencyMsMedian: Number([...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)]!.toFixed(2)),
    },
  };
}
