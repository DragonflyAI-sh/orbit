// Synthetic fixture for related-concept photo retrieval (src/photo-semantic.ts relatedTier, docs/photo-semantic-search.md
// "Related matches").
//
// EVERYTHING HERE IS INVENTED. Refs, hashes, captions, titles and observations describe no real photo, and no real photo data was used
// to write them.
//
// `conceptMock` is a MOCK embedder, not a model. Each word gets its own identity direction plus hand-assigned weights on a few named
// concepts ("saw", "puzzle", "seating", ...), and every text shares a small background direction, so unrelated texts score a little
// above zero as real embedding models do. The weights were chosen by hand to give the SHAPE of the reported live miss: an ambiguous
// single word ("jigsaw") that is near a related object ("a benchtop scroll saw") but below the close-match floor. Its similarities are
// not measurements of any real model, and results produced with it must not be reported as real retrieval quality. It exists to make
// the ranking stages (floor, related tier, fusion, caps) testable deterministically and offline.
import { createHash } from "node:crypto";
import type { Embedder } from "../src/embeddings.ts";
import type { Access, Evidence } from "../src/photo-semantic.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const ref = (n: string) => `ph_${h(`related-fixture:${n}`).slice(0, 32)}`;
const ver = (n: string) => h(`related-image:${n}`);

export const R = {
  scrollSaw: ref("scroll-saw"),
  pruningSaw: ref("pruning-saw"),
  chainsaw: ref("chainsaw"),
  seesaw: ref("seesaw"),
  couch: ref("couch"),
  canoe: ref("canoe"),
  mug: ref("mug"),
  receipt: ref("receipt"),
  puzzle: ref("puzzle"),
  jigsawTool: ref("jigsaw-tool"),
} as const;
export const RLABEL: Record<string, string> = Object.fromEntries(Object.entries(R).map(([k, v]) => [v, k]));
export const SAWS: string[] = [R.scrollSaw, R.pruningSaw, R.chainsaw, R.jigsawTool];

type Photo = { ref: string; caption?: string; title: string; observation: string };
const PHOTOS: Record<keyof typeof R, Photo> = {
  // The main observation the brief names.
  scrollSaw: { ref: R.scrollSaw, caption: "new tool for the shop", title: "Shop upgrades", observation: "A benchtop scroll saw with a thin vertical blade sits on a workshop bench" },
  // Saw distractors: other saws, and a word that only contains "saw".
  pruningSaw: { ref: R.pruningSaw, title: "Garden jobs", observation: "A curved pruning saw hangs on a hook in the garden shed" },
  chainsaw: { ref: R.chainsaw, caption: "winter prep", title: "Cabin", observation: "A chainsaw resting on a pile of split firewood" },
  seesaw: { ref: R.seesaw, title: "Park day", observation: "Two children on a seesaw at the playground" },
  // Unrelated objects, two of them halves of related pairs beyond saws (couch for "sofa", canoe for "kayak").
  couch: { ref: R.couch, caption: "it arrived", title: "Living room", observation: "A grey three-seat couch with two cushions in the living room" },
  canoe: { ref: R.canoe, caption: "morning on the water", title: "Lake trip", observation: "A red canoe pulled up on the lake shore with two paddles" },
  mug: { ref: R.mug, caption: "first coffee", title: "Kitchen", observation: "A blue ceramic coffee mug on the kitchen counter" },
  receipt: { ref: R.receipt, caption: "receipt for the plumber", title: "House", observation: "A printed paper receipt on a desk" },
  // Exact-word fixtures for the other sense and for the same tool.
  puzzle: { ref: R.puzzle, caption: "rainy day project", title: "Weekend", observation: "A half-finished jigsaw puzzle of a lighthouse spread across the dining table" },
  jigsawTool: { ref: R.jigsawTool, caption: "borrowed for the weekend", title: "Shop upgrades", observation: "A cordless jigsaw with a straight blade lies on the workshop shelf" },
};

// Three corpora:
// - liveLike: the reported situation, 8 photos and 22 evidence records, no stored text containing "jigsaw";
// - withPuzzle: plus a jigsaw puzzle (the other sense of the word);
// - workshop: plus an exact jigsaw (the tool), so exact and related evidence both exist.
export const CORPORA = {
  liveLike: ["scrollSaw", "pruningSaw", "chainsaw", "seesaw", "couch", "canoe", "mug", "receipt"],
  withPuzzle: ["scrollSaw", "pruningSaw", "chainsaw", "seesaw", "couch", "canoe", "mug", "receipt", "puzzle"],
  workshop: ["scrollSaw", "pruningSaw", "chainsaw", "seesaw", "couch", "canoe", "mug", "receipt", "puzzle", "jigsawTool"],
} as const satisfies Record<string, (keyof typeof R)[]>;
export type CorpusName = keyof typeof CORPORA;

// Evidence as collectEvidence builds it: caption (when there is one), conversation title, the observation statements.
export function relatedEvidence(corpus: CorpusName): Evidence[] {
  const out: Evidence[] = [];
  for (const k of CORPORA[corpus]) {
    const p = PHOTOS[k];
    const base = { ref: p.ref, photoSha256: ver(p.ref), state: "active" as const };
    if (p.caption) out.push({ ...base, kind: "caption", sourceType: "message-caption", sourceId: `msg-${k}`, text: p.caption });
    out.push({ ...base, kind: "conversation-title", sourceType: "conversation-title", sourceId: `conv-${k}`, text: p.title });
    out.push({ ...base, kind: "visual-observation", sourceType: "observation-record", sourceId: `obs-${k}`, text: p.observation });
  }
  return out;
}
export function relatedAccess(corpus: CorpusName): Access {
  const refs = new Set(CORPORA[corpus].map((k) => R[k]));
  return { authorizedRefs: () => new Set(refs), currentVersion: (r) => (refs.has(r) ? ver(r) : undefined), revalidate: (r, v) => refs.has(r) && v === ver(r) };
}

// ---- the mock embedder ------------------------------------------------------------------------------------------------------------
const CONCEPTS = ["background", "saw", "finecut", "puzzle", "workshop", "garden", "park", "seating", "home", "boat", "water", "drink", "kitchen", "paper", "animal", "food"] as const;
type Concept = (typeof CONCEPTS)[number];
// Hand-assigned, MOCK. "jigsaw" is deliberately two-sensed (a fine-cut saw, and a puzzle).
const LEXICON: Record<string, Partial<Record<Concept, number>>> = {
  jigsaw: { saw: 0.6, finecut: 0.5, puzzle: 0.9 },
  scroll: { finecut: 0.8, paper: 0.2 },
  saw: { saw: 1 },
  blade: { saw: 0.6, finecut: 0.2 },
  benchtop: { workshop: 0.6 },
  bench: { workshop: 0.4, seating: 0.2 },
  workshop: { workshop: 1 },
  shop: { workshop: 0.6 },
  tool: { workshop: 0.6, saw: 0.2 },
  cordless: { workshop: 0.4, saw: 0.2 },
  shelf: { workshop: 0.2, home: 0.2 },
  pruning: { garden: 0.8, saw: 0.2 },
  shed: { garden: 0.4, workshop: 0.3 },
  garden: { garden: 1 },
  chainsaw: { saw: 0.9, garden: 0.3 },
  firewood: { garden: 0.5 },
  seesaw: { park: 1, seating: 0.2 },
  playground: { park: 1 },
  children: { park: 0.5 },
  puzzle: { puzzle: 1 },
  pieces: { puzzle: 0.6 },
  table: { seating: 0.2, home: 0.3 },
  dining: { home: 0.4, food: 0.3 },
  couch: { seating: 1, home: 0.5 },
  sofa: { seating: 1, home: 0.5 },
  armchair: { seating: 0.3, home: 0.1 },
  cushions: { seating: 0.5, home: 0.3 },
  living: { home: 0.6 },
  room: { home: 0.3 },
  canoe: { boat: 1, water: 0.5 },
  kayak: { boat: 1, water: 0.5 },
  rowboat: { boat: 0.3, water: 0.1 },
  paddles: { boat: 0.7, water: 0.3 },
  lake: { water: 1 },
  shore: { water: 0.5 },
  water: { water: 1 },
  mug: { drink: 1, kitchen: 0.3 },
  coffee: { drink: 0.9 },
  ceramic: { kitchen: 0.3 },
  kitchen: { kitchen: 1, home: 0.3 },
  counter: { kitchen: 0.5 },
  receipt: { paper: 1 },
  paper: { paper: 1 },
  printed: { paper: 0.6 },
  desk: { home: 0.3, paper: 0.2 },
  giraffe: { animal: 1 },
  birthday: { food: 0.5 },
  cake: { food: 1 },
};
const STOP = new Set(["a", "an", "the", "on", "of", "in", "at", "with", "for", "to", "and", "two", "up", "it", "lies", "sits", "hangs", "resting", "spread", "across", "pulled", "query"]);
const IDENTITY_DIMS = 4096;
const BACKGROUND = 0.35;

export function conceptMock(): Embedder {
  const dims = CONCEPTS.length + IDENTITY_DIMS;
  const vec = (s: string) => {
    const v = new Array<number>(dims).fill(0);
    const words = s.toLowerCase().replace(/^[a-z-]+: /, "").match(/[a-z]+/g) ?? [];
    for (const w of words) {
      if (STOP.has(w)) continue;
      v[0]! += BACKGROUND;
      v[CONCEPTS.length + (parseInt(h(`id:${w}`).slice(0, 8), 16) % IDENTITY_DIMS)]! += 1;
      for (const [c, x] of Object.entries(LEXICON[w] ?? {})) v[CONCEPTS.indexOf(c as Concept)]! += x!;
    }
    if (!v.some((x) => x !== 0)) v[0] = 1;
    return v;
  };
  return { id: { model: "concept-mock (NOT a model)", dims, format: "offline-test" }, embed: async (texts) => texts.map(vec) };
}
