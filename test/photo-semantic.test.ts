import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddingUnavailable } from "../src/embeddings.ts";
import type { Embedder } from "../src/embeddings.ts";
import { countingEmbedder, eligibleEvidence, keywordRanking, retrieve, vectorCache } from "../src/photo-semantic.ts";
import type { Evidence } from "../src/photo-semantic.ts";
import { fixtureAccess, fixtureEvidence, lexicalStandIn, P, QUERIES, runEvaluation } from "./photo-semantic-fixture.ts";

// Hybrid photo retrieval (src/photo-semantic.ts) offline. The lexical stand-in is a character-trigram hash: it drives the plumbing
// (cache, lifecycle, access, fusion, fallback) deterministically. NOTHING HERE MEASURES SEMANTIC QUALITY.

const tmp = () => mkdtempSync(join(tmpdir(), "orbit-sem-"));
const EXCLUDED = [P.forgottenCafe, P.stalePizza, P.otherThreadBookstore];
const files = (root: string) => readdirSync(root).flatMap((r) => readdirSync(join(root, r)).map((f) => join(root, r, f)));

test("synthetic evaluation: same corpus for all three rankings, within budget, never surfacing forgotten, stale or unauthorized photos", async () => {
  const cache = vectorCache(tmp(), lexicalStandIn().id);
  const run = await runEvaluation({ embedder: lexicalStandIn(), cache, maxRequests: 40 });
  assert.equal(QUERIES.length, 20);
  assert.ok(run.counts.requests <= 40 && run.counts.refusedOverBudget === 0 && run.counts.failures === 0);
  for (const r of run.results) for (const c of r.candidates) assert.ok(!EXCLUDED.includes(c.ref as never), `excluded photo surfaced: ${c.ref}`);
  for (const r of run.results) assert.ok(r.candidates.length <= 3 && new Set(r.candidates.map((c) => c.ref)).size === r.candidates.length);
  for (const row of run.rows) assert.deepEqual([row.keywordMetadata.misleading, row.keywordAll.misleading, row.hybrid.misleading], [[], [], []], row.q);
  assert.equal(eligibleEvidence(fixtureEvidence(), fixtureAccess()).length, 16);
  if (process.env.ORBIT_SEMANTIC_REPORT) writeFileSync(process.env.ORBIT_SEMANTIC_REPORT, JSON.stringify({ embedder: "lexical-stand-in (NOT semantic)", summary: run.summary, counts: run.counts, rows: run.rows }, null, 2));
});

test("keyword baselines: metadata reproduces photos_list's rule; the fair baseline also searches observations and ranks context-only matches last", () => {
  const ev = eligibleEvidence(fixtureEvidence(), fixtureAccess());
  assert.deepEqual(keywordRanking("restaurant bookshelves", ev, "metadata"), []);
  assert.deepEqual(keywordRanking("restaurant bookshelves", ev, "all"), [P.bookRestaurant]);
  assert.deepEqual(keywordRanking("city library", ev, "all"), [P.gardenWithLibraryTalk], "context-only match exists but only in the context tier");
  assert.deepEqual(keywordRanking("giraffe", ev, "all"), []);
  assert.deepEqual(keywordRanking("!", ev, "all"), [], "a query with no searchable word ranks nothing");
});

test("cache: reuse, no source text, private permissions, damaged entry is a miss, temp leftovers removed", async () => {
  const dir = tmp();
  const stand = lexicalStandIn();
  await runEvaluation({ embedder: stand, cache: vectorCache(dir, stand.id), maxRequests: 40 });
  const cache = vectorCache(dir, stand.id);
  const second = countingEmbedder(stand, 40);
  const r = await retrieve({ query: "restaurant bookshelves", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: second.embedder, cache });
  assert.equal(r.stats.embedded, 0);
  assert.equal(second.counts.requests, 1, "only the query is embedded");
  assert.equal(cache.count(), 16);
  const all = files(cache.root!);
  const text = all.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const e of fixtureEvidence()) assert.ok(!text.includes(e.text), "cache must not contain source text");
  assert.equal(statSync(cache.root!).mode & 0o777, 0o700);
  for (const f of all) assert.equal(statSync(f).mode & 0o777, 0o600);
  writeFileSync(all[0]!, "{not json");
  writeFileSync(`${all[1]}.tmp-deadbeef0000`, "partial");
  const reopened = vectorCache(dir, stand.id);
  assert.ok(!files(reopened.root!).some((f) => f.includes(".tmp-")));
  const again = await retrieve({ query: "x restaurant", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: stand, cache: reopened });
  assert.equal(again.stats.embedded, 1, "damaged entry re-embedded, others reused");
  // A tampered vector (hash mismatch) is a miss too.
  const one = files(reopened.root!)[0]!;
  const x = JSON.parse(readFileSync(one, "utf8"));
  x.vec = Buffer.alloc(stand.id.dims * 4, 1).toString("base64");
  writeFileSync(one, JSON.stringify(x));
  const third = await retrieve({ query: "x restaurant", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: stand, cache: vectorCache(dir, stand.id) });
  assert.equal(third.stats.embedded, 1);
});

test("lifecycle: correction, forgetting, version change and revocation stop matching; maintain() removes their vectors", async () => {
  const dir = tmp();
  const stand = lexicalStandIn();
  const cache = vectorCache(dir, stand.id);
  const ev = fixtureEvidence();
  const before = await retrieve({ query: "red lanterns", evidence: ev, access: fixtureAccess(), embedder: stand, cache });
  assert.equal(before.candidates[0]?.ref, P.noodleBar);
  const after = ev.map((e) => (e.sourceId === "ob-b1" ? { ...e, state: "forgotten" as const, text: "" } : e));
  const access = fixtureAccess({ versions: { [P.bookRestaurant]: "f".repeat(64) } });
  const r = await retrieve({ query: "red lanterns", evidence: after, access, embedder: stand, cache });
  assert.ok(!r.candidates.some((c) => c.evidence.some((x) => x.sourceId === "ob-b1")));
  const r2 = await retrieve({ query: "restaurant bookshelves", evidence: after, access, embedder: stand, cache });
  assert.ok(!r2.candidates.some((c) => c.ref === P.bookRestaurant), "old-version evidence no longer matches");
  const removed = cache.maintain(eligibleEvidence(after, access));
  assert.ok(removed >= 4, `pruned ${removed}`);
  assert.equal(cache.count(), eligibleEvidence(after, access).length);
  const revoked = await retrieve({ query: "noodle bar lunch", evidence: ev, access: fixtureAccess({ unauthorized: new Set([P.noodleBar]) }), embedder: stand, cache });
  assert.ok(!revoked.candidates.some((c) => c.ref === P.noodleBar));
  const reval = await retrieve({ query: "receipt", evidence: ev, access: fixtureAccess({ revalidateFails: new Set([P.receipt]) }), embedder: stand, cache });
  assert.ok(!reval.candidates.some((c) => c.ref === P.receipt));
});

test("forget DURING an in-flight embedding: the racing write is discarded, nothing ranks or is returned, and invalidate() deletes every vector of the photo", async () => {
  const dir = tmp();
  const stand = lexicalStandIn();
  const cache = vectorCache(dir, stand.id);
  let evidence = fixtureEvidence();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const slow: Embedder = {
    id: stand.id,
    embed: async (texts) => {
      calls++;
      // The second request is the evidence batch: hold it while the observation is forgotten.
      if (calls === 2) await gate;
      return stand.embed(texts);
    },
  };
  const p = retrieve({ query: "red lanterns", evidence, access: fixtureAccess(), embedder: slow, cache, refresh: () => evidence });
  await new Promise((r) => setTimeout(r, 5));
  // photos_forget: the store drops the text, then onChange invalidates the photo's derived data.
  evidence = evidence.map((e) => (e.sourceId === "ob-b1" ? { ...e, state: "forgotten" as const, text: "" } : e));
  cache.invalidate(P.noodleBar);
  release();
  const r = await p;
  assert.ok(r.stats.discarded >= 1, "the in-flight vector of the forgotten record was discarded");
  for (const c of r.candidates) for (const e of c.evidence) assert.notEqual(e.sourceId, "ob-b1");
  assert.ok(!JSON.stringify(r).includes("lanterns"), "forgotten text is not returned");
  // Nothing for the noodle bar's forgotten record was written, and the other evidence of that photo was discarded with the old generation.
  const left = readdirSync(cache.root!).includes(P.noodleBar) ? readdirSync(join(cache.root!, P.noodleBar)) : [];
  assert.equal(left.length, 0);
  // invalidate removes existing vectors in every namespace.
  const other = vectorCache(dir, lexicalStandIn(128).id);
  await retrieve({ query: "noodle", evidence, access: fixtureAccess(), embedder: lexicalStandIn(128), cache: other });
  assert.ok(readdirSync(other.root!).includes(P.noodleBar));
  cache.invalidate(P.noodleBar);
  assert.ok(!readdirSync(other.root!).includes(P.noodleBar) && !readdirSync(cache.root!).includes(P.noodleBar));
});

test("a photo revoked during the request is not returned and its evidence does not rank", async () => {
  const stand = lexicalStandIn();
  let unauthorized = new Set<string>([P.otherThreadBookstore]);
  const access = { authorizedRefs: () => fixtureAccess({ unauthorized }).authorizedRefs(), currentVersion: (r: string) => fixtureAccess({ unauthorized }).currentVersion(r), revalidate: (r: string, v: string) => fixtureAccess({ unauthorized }).revalidate(r, v) };
  const slow: Embedder = {
    id: stand.id,
    embed: async (t) => {
      unauthorized = new Set([P.otherThreadBookstore, P.receipt]);
      return stand.embed(t);
    },
  };
  const r = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access, embedder: slow, cache: vectorCache(undefined, stand.id) });
  assert.ok(!r.candidates.some((c) => c.ref === P.receipt));
  assert.equal(r.stats.authorizedPhotos, 8);
});

test("model change uses a separate namespace; maintain() drops the old one", async () => {
  const dir = tmp();
  const a = vectorCache(dir, lexicalStandIn(256).id);
  const b = vectorCache(dir, lexicalStandIn(128).id);
  assert.notEqual(a.root, b.root);
  await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: lexicalStandIn(256), cache: a });
  const r = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: lexicalStandIn(128), cache: b });
  assert.equal(r.stats.reused, 0);
  b.maintain(eligibleEvidence(fixtureEvidence(), fixtureAccess()));
  assert.deepEqual(readdirSync(dir), [b.namespace]);
});

test("fallback: query failure is keyword-only over the same corpus; evidence failure keeps indexed vectors and says so; no retry loop", async () => {
  let calls = 0;
  const failing: Embedder = { id: { model: "m", dims: 4, format: "f" }, embed: async () => (calls++, Promise.reject(new EmbeddingUnavailable("auth", "the embeddings key was refused (HTTP 401)"))) };
  const r = await retrieve({ query: "red lanterns", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: failing, cache: vectorCache(undefined, failing.id) });
  assert.equal(r.mode, "keyword-only");
  assert.match(r.degraded ?? "", /HTTP 401/);
  assert.equal(r.candidates[0]?.ref, P.noodleBar, "keyword fallback searches observations too");
  assert.equal(calls, 1);
  const none = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: undefined, cache: vectorCache(undefined, failing.id) });
  assert.equal(none.mode, "keyword-only");
  assert.equal(none.candidates[0]?.ref, P.receipt);
  const { embedder, counts } = countingEmbedder(lexicalStandIn(), 0);
  const b = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder, cache: vectorCache(undefined, embedder.id) });
  assert.equal(b.mode, "keyword-only");
  assert.equal(counts.requests, 0);
  // Query succeeds, the evidence batch fails: hybrid over what is indexed (nothing yet), with the gap reported.
  const stand = lexicalStandIn();
  let n = 0;
  const half: Embedder = { id: stand.id, embed: async (t) => (n++ === 0 ? stand.embed(t) : Promise.reject(new EmbeddingUnavailable("timeout", "timed out"))) };
  const h = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: half, cache: vectorCache(undefined, stand.id) });
  assert.equal(h.mode, "hybrid");
  assert.match(h.degraded ?? "", /incomplete/);
  assert.equal(h.stats.pending, 16);
  assert.equal(h.candidates[0]?.ref, P.receipt);
});

test("bounded index work per call: at most embedTextsMax evidence texts, the rest pending until later calls", async () => {
  const stand = lexicalStandIn();
  const cache = vectorCache(undefined, stand.id);
  const c = countingEmbedder(stand, 100);
  const r1 = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: c.embedder, cache, embedTextsMax: 10 });
  assert.deepEqual([r1.stats.embedded, r1.stats.pending], [10, 6]);
  const r2 = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: c.embedder, cache, embedTextsMax: 10 });
  assert.deepEqual([r2.stats.embedded, r2.stats.reused, r2.stats.pending], [6, 10, 0]);
});

test("wrong-size vectors are refused, not cached", async () => {
  const bad: Embedder = { id: { model: "m", dims: 8, format: "f" }, embed: async (t) => t.map(() => [1, 2, 3]) };
  const cache = vectorCache(tmp(), bad.id);
  const r = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: bad, cache });
  assert.equal(r.mode, "keyword-only");
  assert.equal(cache.count(), 0);
});

test("concurrent retrievals on one cache directory agree and leave only complete entries", async () => {
  const dir = tmp();
  const stand = lexicalStandIn();
  const [x, y] = await Promise.all([
    retrieve({ query: "paperbacks at home", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: stand, cache: vectorCache(dir, stand.id) }),
    retrieve({ query: "paperbacks at home", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: stand, cache: vectorCache(dir, stand.id) }),
  ]);
  assert.deepEqual(x.candidates.map((c) => c.ref), y.candidates.map((c) => c.ref));
  for (const f of files(vectorCache(dir, stand.id).root!)) JSON.parse(readFileSync(f, "utf8"));
});

test("results keep evidence kinds and labels separate, flag ambiguity between two near-equal photos, and say no match plainly", async () => {
  const stand = lexicalStandIn();
  const r = await retrieve({ query: "city library", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: stand, cache: vectorCache(undefined, stand.id) });
  for (const c of r.candidates) for (const e of c.evidence) {
    if (e.kind === "discussion-context") assert.match(e.label, /context, not a description of the photo/);
    if (e.kind === "visual-observation") assert.match(e.label, /not a verified fact/);
  }
  assert.match(r.caveat, /not proof/);
  // Two photos described the same way are ambiguous.
  const twin: Evidence[] = fixtureEvidence().map((e) => (e.ref === P.wineBarBooks && e.kind === "visual-observation" ? { ...e, text: "Restaurant dining room; tall wooden bookshelves full of books line the wall behind the tables." } : e));
  const amb = await retrieve({ query: "restaurant bookshelves", evidence: twin, access: fixtureAccess(), embedder: stand, cache: vectorCache(undefined, stand.id) });
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(new Set(amb.candidates.slice(0, 2).map((c) => c.ref)), new Set([P.bookRestaurant, P.wineBarBooks]));
  const none = await retrieve({ query: "giraffe on the moon", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: stand, cache: vectorCache(undefined, stand.id) });
  assert.equal(none.noMatch, true);
  assert.match(none.caveat, /says nothing about what the photos show/);
});
