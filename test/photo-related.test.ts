import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { EmbeddingUnavailable } from "../src/embeddings.ts";
import type { Embedder } from "../src/embeddings.ts";
import { CAVEAT, NO_MATCH_CAVEAT, RELATED_CAVEAT, RELATED_FLOOR_DEFAULT, RELATED_MAX, RELATED_MIN_VECTORS, relatedTier, retrieve, SEMANTIC_FLOOR_DEFAULT, vectorCache } from "../src/photo-semantic.ts";
import type { Evidence, RetrievalResult } from "../src/photo-semantic.ts";
import { conceptMock, CORPORA, R, relatedAccess, relatedEvidence, RLABEL, SAWS } from "./photo-related-fixture.ts";
import type { CorpusName } from "./photo-related-fixture.ts";

// The related-concept tier (src/photo-semantic.ts relatedTier, docs/photo-semantic-search.md "Related matches"), offline.
// MOCK EVIDENCE: `conceptMock` is a hand-weighted stand-in, not a model (see test/photo-related-fixture.ts). These tests check the
// ranking stages deterministically (floor, related gates, caps, fusion order, attribution, fallback, diagnostics). They do NOT
// measure what a real embedding model scores for these texts; that is the host checklist in the docs.

const run = (query: string, corpus: CorpusName, o: { related?: boolean; embedder?: Embedder | null; target?: string; access?: ReturnType<typeof relatedAccess> } = {}) => {
  const embedder = o.embedder === null ? undefined : (o.embedder ?? conceptMock());
  return retrieve({ query, evidence: relatedEvidence(corpus), access: o.access ?? relatedAccess(corpus), embedder, cache: vectorCache(undefined, embedder?.id ?? { model: "none", dims: 1, format: "none" }), ...(o.related === false ? { related: false } : {}), diagnose: o.target ? { target: o.target } : {} });
};
const refs = (r: RetrievalResult) => r.candidates.map((c) => c.ref);
const names = (r: RetrievalResult) => r.candidates.map((c) => `${RLABEL[c.ref]}:${c.via.join("+")}`);
const viaOf = (r: RetrievalResult, ref: string) => r.candidates.find((c) => c.ref === ref)?.via;
const exact = (r: RetrievalResult) => r.candidates.filter((c) => !(c.via.length === 1 && c.via[0] === "related")).map((c) => c.ref);

// Every query of the before/after table: [query, corpus, what the brief asks of it].
const TABLE: [string, CorpusName, string][] = [
  ["jigsaw", "liveLike", "the reported miss: no stored text says jigsaw; the scroll saw is the related result"],
  ["jigsaw", "withPuzzle", "the exact word (a puzzle) first; the related scroll saw still in the top 3"],
  ["jigsaw", "workshop", "both exact jigsaws first; the related scroll saw after them"],
  ["jigsaw workshop", "workshop", "workshop intent: the exact jigsaw outranks the related scroll saw"],
  ["jigsaw puzzle", "withPuzzle", "the puzzle; no saw"],
  ["jigsaw puzzle", "workshop", "the puzzle first; the related tier adds no saw"],
  ["scroll saw", "liveLike", "exact: the scroll saw first"],
  ["scroll saw", "workshop", "exact: the scroll saw first"],
  ["armchair", "liveLike", "related pair beyond saws: the couch"],
  ["rowboat", "liveLike", "related pair beyond saws: the canoe"],
  ["sofa", "liveLike", "near-synonym: the couch (close match, unchanged)"],
  ["kayak", "liveLike", "near-synonym: the canoe (close match, unchanged)"],
  ["giraffe", "liveLike", "unrelated: no match"],
  ["birthday cake", "workshop", "unrelated: no match"],
  ["seesaw", "workshop", "a word that contains 'saw': the seesaw only"],
];

test("before/after fixture (MOCK embedder): the related tier fixes the jigsaw miss without moving any exact match", async () => {
  const rows: { query: string; corpus: string; expect: string; before: string[]; after: string[] }[] = [];
  for (const [q, c, expect] of TABLE) {
    const before = await run(q, c, { related: false });
    const after = await run(q, c);
    rows.push({ query: q, corpus: c, expect, before: names(before), after: names(after) });
    // Preserve exact-match ranking: the candidates main's ranking returns are exactly the leading, non-related candidates now, in order.
    assert.deepEqual(exact(after), refs(before), `${q} [${c}]: exact candidates must be unchanged`);
    assert.ok(after.candidates.length <= 3);
    assert.ok(after.candidates.filter((x) => x.via.includes("related")).length <= RELATED_MAX);
  }
  if (process.env.ORBIT_RELATED_REPORT) writeFileSync(process.env.ORBIT_RELATED_REPORT, JSON.stringify({ embedder: "concept-mock (hand-weighted MOCK, not a model)", rows }, null, 2));

  // The reported miss, reproduced: hybrid mode, everything indexed, and nothing returned.
  const missed = await run("jigsaw", "liveLike", { related: false });
  assert.equal(missed.mode, "hybrid");
  assert.equal(missed.stats.eligibleEvidence, 22, "8 photos, 22 evidence records, as reported");
  assert.equal(missed.stats.pending, 0);
  assert.equal(missed.noMatch, true);
  // After: the scroll saw, at rank 1, labelled as related, never as a match or a verified label.
  const fixed = await run("jigsaw", "liveLike");
  assert.deepEqual(names(fixed), ["scrollSaw:related"]);
  assert.equal(fixed.relatedOnly, true);
  assert.equal(fixed.noMatch, false);
  assert.equal(fixed.caveat, RELATED_CAVEAT);
  const ev = fixed.candidates[0]!.evidence[0]!;
  assert.equal(ev.related, true);
  assert.equal(ev.kind, "visual-observation");
  assert.match(ev.label, /model observation .*not a verified fact.*related concept.*not a verified label/);
  assert.ok(ev.similarity! < SEMANTIC_FLOOR_DEFAULT && ev.similarity! >= RELATED_FLOOR_DEFAULT);

  // The exact word first, then the related tool.
  const puzzleToo = await run("jigsaw", "withPuzzle");
  assert.deepEqual(names(puzzleToo), ["puzzle:keyword+semantic", "scrollSaw:related"]);
  assert.equal(puzzleToo.caveat, CAVEAT);
  const workshop = await run("jigsaw", "workshop");
  assert.deepEqual(refs(workshop).slice(0, 2).sort(), [R.jigsawTool, R.puzzle].sort());
  assert.equal(workshop.candidates[2]!.ref, R.scrollSaw);
  assert.deepEqual(viaOf(workshop, R.scrollSaw), ["related"]);
  assert.equal(workshop.ambiguous, true, "two exact jigsaws of different kinds: show both and ask");
  // Workshop intent, both present: exact jigsaw first, the scroll saw below it.
  const intent = await run("jigsaw workshop", "workshop");
  assert.equal(intent.candidates[0]!.ref, R.jigsawTool);
  assert.deepEqual(intent.candidates[0]!.via, ["keyword", "semantic"]);
  assert.ok(refs(intent).indexOf(R.scrollSaw) > 0 && refs(intent).indexOf(R.scrollSaw) < 3);

  // "jigsaw puzzle": the puzzle; the saws are not surfaced (each is in the related band at most, and far below the puzzle).
  const puzzle = await run("jigsaw puzzle", "withPuzzle", { target: R.scrollSaw });
  assert.deepEqual(refs(puzzle), [R.puzzle]);
  for (const s of SAWS) assert.ok(!refs(puzzle).includes(s));
  assert.equal(puzzle.diagnostics?.target?.semantic.related, "far-below-best");
  // With an exact-word jigsaw TOOL present, the related tier still adds no saw; the tool that shares the word "jigsaw" is a CLOSE
  // semantic match under the mock (unchanged close tier, below the puzzle). Whether a real model scores it above the floor is unmeasured.
  const puzzleWorkshop = await run("jigsaw puzzle", "workshop");
  assert.equal(puzzleWorkshop.candidates[0]!.ref, R.puzzle);
  assert.ok(puzzleWorkshop.candidates.every((x) => !x.via.includes("related")));

  // "scroll saw" still finds the scroll saw first, by keyword and semantic, in every corpus.
  for (const c of Object.keys(CORPORA) as CorpusName[]) {
    const r = await run("scroll saw", c);
    assert.equal(r.candidates[0]!.ref, R.scrollSaw, c);
    assert.deepEqual(r.candidates[0]!.via, ["keyword", "semantic"], c);
  }

  // Related pairs beyond saws: before nothing, after the related object; near-synonyms were already close matches.
  for (const [q, want] of [["armchair", R.couch], ["rowboat", R.canoe]] as const) {
    assert.equal((await run(q, "liveLike", { related: false })).noMatch, true, q);
    const r = await run(q, "liveLike");
    assert.deepEqual(refs(r), [want], q);
    assert.deepEqual(r.candidates[0]!.via, ["related"], q);
  }
  for (const [q, want] of [["sofa", R.couch], ["kayak", R.canoe]] as const) {
    const r = await run(q, "liveLike");
    assert.deepEqual(refs(r), [want], q);
    assert.deepEqual(r.candidates[0]!.via, ["semantic"], q);
  }
  // Unrelated: still no match.
  for (const [q, c] of [["giraffe", "liveLike"], ["birthday cake", "workshop"]] as const) {
    const r = await run(q, c);
    assert.equal(r.noMatch, true, q);
    assert.equal(r.caveat, NO_MATCH_CAVEAT);
  }
  // A word that only contains "saw" is not conflated with saws.
  assert.deepEqual(refs(await run("seesaw", "workshop")), [R.seesaw]);
});

test("related gates: floor band, distinct from the background, near the best, own evidence only, capped, never an exact candidate", () => {
  const e = (ref: string, kind: Evidence["kind"] = "visual-observation"): Evidence => ({ ref, kind, sourceType: "observation-record", sourceId: `s-${ref}-${kind}`, photoSha256: "v", state: "active", text: "synthetic" });
  const bg = Array.from({ length: 6 }, (_, i) => ({ sim: 0.1, e: e(`bg${i}`) }));
  const o = { floor: 0.35, relatedFloor: 0.25, exact: new Set<string>() };
  // Admitted: in the band, well above the 0.1 median, the best similarity.
  let t = relatedTier([...bg, { sim: 0.3, e: e("a") }], o);
  assert.deepEqual(t.admitted.map((x) => x.ref), ["a"]);
  // Below the related floor: not considered at all.
  t = relatedTier([...bg, { sim: 0.24, e: e("a") }], o);
  assert.deepEqual(t.admitted, []);
  // Not distinct: the whole corpus is about as similar (a query about nothing here).
  t = relatedTier([...Array.from({ length: 6 }, (_, i) => ({ sim: 0.27, e: e(`flat${i}`) })), { sim: 0.3, e: e("a") }], o);
  assert.deepEqual(t.admitted, []);
  assert.equal(t.reasons.get("a"), "not-distinct");
  // Far below the best: another sense of the query matches strongly.
  t = relatedTier([...bg, { sim: 0.8, e: e("strong") }, { sim: 0.3, e: e("a") }], { ...o, exact: new Set(["strong"]) });
  assert.equal(t.reasons.get("a"), "far-below-best");
  // Context lines never make a related candidate.
  t = relatedTier([...bg, { sim: 0.3, e: e("a", "discussion-context") }], o);
  assert.equal(t.reasons.get("a"), "context-only");
  // Exact candidates are never related candidates.
  t = relatedTier([...bg, { sim: 0.3, e: e("a") }], { ...o, exact: new Set(["a"]) });
  assert.deepEqual(t.admitted, []);
  assert.equal(t.reasons.has("a"), false);
  // Capped, best first.
  t = relatedTier([...bg, { sim: 0.3, e: e("a") }, { sim: 0.32, e: e("b") }, { sim: 0.31, e: e("c") }], o);
  assert.deepEqual(t.admitted.map((x) => x.ref), ["b", "c"]);
  assert.equal(t.reasons.get("a"), "over-cap");
  // Too few vectors to estimate a background: off.
  t = relatedTier([{ sim: 0.1, e: e("x") }, { sim: 0.3, e: e("a") }], o);
  assert.deepEqual(t.admitted, []);
  assert.match(t.disabledBecause!, new RegExp(`fewer than ${RELATED_MIN_VECTORS}`));
});

test("provider disabled or failing: keyword-only exactly as before, no related tier, no extra request", async () => {
  // No adapter (feature on, credential missing): keyword-only over the same corpus.
  const none = await run("jigsaw", "liveLike", { embedder: null });
  assert.equal(none.mode, "keyword-only");
  assert.equal(none.noMatch, true);
  assert.equal(none.relatedOnly, false);
  assert.equal(none.diagnostics?.related.enabled, false);
  const exactWord = await run("scroll saw", "liveLike", { embedder: null });
  assert.deepEqual(names(exactWord), ["scrollSaw:keyword"]);
  // The query cannot be embedded (budget, halted adapter): keyword-only, nothing related, one attempt.
  let calls = 0;
  const failing: Embedder = { id: conceptMock().id, embed: async () => (calls++, Promise.reject(new EmbeddingUnavailable("budget", "daily embeddings request budget of 0 reached"))) };
  const down = await run("jigsaw", "withPuzzle", { embedder: failing });
  assert.equal(down.mode, "keyword-only");
  assert.match(down.degraded!, /budget/);
  assert.deepEqual(names(down), ["puzzle:keyword"]);
  assert.equal(calls, 1);
  // Same number of provider requests with the related tier on or off: it reads similarities already computed.
  const count = (related: boolean) => {
    let n = 0;
    const inner = conceptMock();
    const e: Embedder = { id: inner.id, embed: (t, s) => (n++, inner.embed(t, s)) };
    return run("jigsaw", "liveLike", { embedder: e, related }).then(() => n);
  };
  assert.equal(await count(true), await count(false));
});

test("diagnostics (opt-in): stage counts and one target's path, with no query, text, vector, ref or source id", async () => {
  const before = await run("jigsaw", "liveLike", { related: false, target: R.scrollSaw });
  const t0 = before.diagnostics!.target!;
  assert.deepEqual([t0.inCandidateSet, t0.evidence, t0.withVector, t0.keyword.matched], [true, 3, 3, false]);
  assert.equal(t0.semantic.band, "related", "the miss is at the close-match floor: the best similarity is in the related band");
  assert.ok(t0.semantic.bestSimilarity! < before.diagnostics!.thresholds.floor);
  assert.deepEqual(t0.final, { position: null, outcome: "not-matched" });
  assert.equal(before.diagnostics!.related.disabledBecause, "turned off for this search");
  const after = await run("jigsaw", "liveLike", { target: R.scrollSaw });
  const d = after.diagnostics!;
  assert.deepEqual(d.eligible, { photos: 8, evidence: 22, withVector: 22 });
  assert.deepEqual([d.keyword.candidates, d.semantic.closePhotos, d.related.admitted, d.fused.exactCandidates, d.fused.returned], [0, 0, 1, 0, 1]);
  assert.equal(d.semantic.queryEmbedded, true);
  assert.ok(d.semantic.topPhotoSimilarities.length === 5 && d.semantic.median! < d.semantic.best!);
  assert.deepEqual(d.target!.final, { position: 1, outcome: "returned" });
  assert.equal(d.target!.semantic.related, "admitted");
  // Nothing private-shaped: not the query, any evidence text, any ref or source id.
  const text = JSON.stringify(d);
  for (const needle of ["jigsaw", "scroll", "workshop", ...Object.values(R), ...relatedEvidence("liveLike").map((x) => x.sourceId)]) assert.ok(!text.includes(needle), needle);
  // Unauthorized target: not in the candidate set, never returned, nothing about it leaks into the ranking.
  const access = relatedAccess("liveLike");
  const hidden = { ...access, authorizedRefs: () => new Set([...access.authorizedRefs()].filter((r) => r !== R.scrollSaw)) };
  const scoped = await run("jigsaw", "liveLike", { access: hidden, target: R.scrollSaw });
  assert.ok(!refs(scoped).includes(R.scrollSaw));
  assert.equal(scoped.diagnostics!.target!.inCandidateSet, false);
  assert.equal(scoped.diagnostics!.eligible.evidence, 19);
  // Without diagnose there is no diagnostics field at all.
  const plain = await retrieve({ query: "jigsaw", evidence: relatedEvidence("liveLike"), access: relatedAccess("liveLike"), embedder: conceptMock(), cache: vectorCache(undefined, conceptMock().id) });
  assert.equal("diagnostics" in plain, false);
});
