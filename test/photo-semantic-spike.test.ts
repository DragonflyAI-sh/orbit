import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { countingEmbedder, eligibleEvidence, retrieve, unverifiedEmbedder, vectorCache } from "../src/spike/photo-semantic.ts";
import type { Embedder } from "../src/spike/photo-semantic.ts";
import { fixtureAccess, fixtureEvidence, lexicalStandIn, P, QUERIES, runEvaluation } from "./photo-semantic-fixture.ts";

// Hybrid photo retrieval SPIKE (docs/photo-semantic-spike.md). Offline only: no network, no credentials, no real embedding model.
// The lexical stand-in embedder tests plumbing (cache, lifecycle, access, fusion, fallback). Nothing here measures semantic quality.

const tmp = () => mkdtempSync(join(tmpdir(), "orbit-sem-spike-"));
const EXCLUDED = [P.forgottenCafe, P.stalePizza, P.otherThreadBookstore];

test("offline evaluation runs within its request budget and never surfaces forgotten, stale or unauthorized photos", async () => {
  const cache = vectorCache(tmp(), lexicalStandIn().id);
  const run = await runEvaluation({ embedder: lexicalStandIn(), cache, maxRequests: 40 });
  assert.equal(QUERIES.length, 20);
  assert.ok(run.counts.requests <= 40 && run.counts.refusedOverBudget === 0 && run.counts.failures === 0);
  for (const r of run.results) for (const c of r.candidates) assert.ok(!EXCLUDED.includes(c.ref as never), `excluded photo surfaced: ${c.ref}`);
  for (const r of run.results) assert.ok(r.candidates.length <= 3 && new Set(r.candidates.map((c) => c.ref)).size === r.candidates.length);
  // Evidence: 20 records, of which superseded (1), forgotten (1), stale (1) and unauthorized (1) are dropped before ranking.
  assert.equal(eligibleEvidence(fixtureEvidence(), fixtureAccess()).length, 16);
  if (process.env.ORBIT_SPIKE_REPORT) writeFileSync(process.env.ORBIT_SPIKE_REPORT, JSON.stringify({ summary: run.summary, counts: run.counts, rows: run.rows }, null, 2));
});

test("cache: second run reuses every evidence vector; entries hold no source text; damaged entry is a miss; temp leftovers removed", async () => {
  const dir = tmp();
  const stand = lexicalStandIn();
  const first = await runEvaluation({ embedder: stand, cache: vectorCache(dir, stand.id), maxRequests: 40 });
  const cache = vectorCache(dir, stand.id);
  const second = countingEmbedder(stand, 40);
  const r = await retrieve({ query: "restaurant bookshelves", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: second.embedder, cache });
  assert.equal(r.stats.embedded, 0);
  assert.equal(second.counts.requests, 1, "only the query is embedded");
  assert.equal(first.summary.cacheEntries, 16);
  const files = readdirSync(cache.root);
  const all = files.map((f) => readFileSync(join(cache.root, f), "utf8")).join("\n");
  for (const e of fixtureEvidence()) assert.ok(!all.includes(e.text), "cache must not contain source text");
  writeFileSync(join(cache.root, files[0]), "{not json");
  writeFileSync(join(cache.root, `${files[1]}.tmp-deadbeef0000`), "partial");
  const reopened = vectorCache(dir, stand.id);
  assert.ok(!readdirSync(reopened.root).some((f) => f.includes(".tmp-")));
  const again = await retrieve({ query: "x restaurant", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: stand, cache: reopened });
  assert.equal(again.stats.embedded, 1, "damaged entry re-embedded, others reused");
});

test("lifecycle: correction, forgetting, version change and revocation stop matching; prune removes their vectors", async () => {
  const dir = tmp();
  const stand = lexicalStandIn();
  const cache = vectorCache(dir, stand.id);
  const ev = fixtureEvidence();
  const before = await retrieve({ query: "red lanterns", evidence: ev, access: fixtureAccess(), embedder: stand, cache });
  assert.equal(before.candidates[0]?.ref, P.noodleBar);
  // Forget the noodle observation (text deleted by the store) and change the restaurant's image version.
  const after = ev.map((e) => (e.sourceId === "ob-b1" ? { ...e, state: "forgotten" as const, text: "" } : e));
  const access = fixtureAccess({ versions: { [P.bookRestaurant]: "f".repeat(64) } });
  const r = await retrieve({ query: "red lanterns", evidence: after, access, embedder: stand, cache });
  assert.ok(!r.candidates.some((c) => c.evidence.some((x) => x.sourceId === "ob-b1")));
  const r2 = await retrieve({ query: "restaurant bookshelves", evidence: after, access, embedder: stand, cache });
  assert.ok(!r2.candidates.some((c) => c.ref === P.bookRestaurant), "old-version evidence no longer matches");
  const removed = cache.prune(eligibleEvidence(after, access));
  assert.ok(removed >= 4, `pruned ${removed}`);
  // Revocation: the photo becomes unauthorized; and a photo failing final revalidation is dropped even if it ranked.
  const revoked = await retrieve({ query: "noodle bar lunch", evidence: ev, access: fixtureAccess({ unauthorized: new Set([P.noodleBar]) }), embedder: stand, cache });
  assert.ok(!revoked.candidates.some((c) => c.ref === P.noodleBar));
  const reval = await retrieve({ query: "receipt", evidence: ev, access: fixtureAccess({ revalidateFails: new Set([P.receipt]) }), embedder: stand, cache });
  assert.ok(!reval.candidates.some((c) => c.ref === P.receipt));
});

test("model change uses a separate namespace (full rebuild, nothing mixed)", async () => {
  const dir = tmp();
  const a = vectorCache(dir, lexicalStandIn(256).id);
  const b = vectorCache(dir, lexicalStandIn(128).id);
  assert.notEqual(a.root, b.root);
  await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: lexicalStandIn(256), cache: a });
  const r = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: lexicalStandIn(128), cache: b });
  assert.equal(r.stats.reused, 0);
});

test("endpoint failure, unverified endpoint and exhausted budget fall back to keyword-only, without retry", async () => {
  let calls = 0;
  const failing: Embedder = { id: { model: "m", dims: 4, format: "f" }, embed: async () => (calls++, Promise.reject(new Error("HTTP 401 from provider"))) };
  const r = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: failing, cache: vectorCache(tmp(), failing.id) });
  assert.equal(r.mode, "keyword-only");
  assert.match(r.degraded ?? "", /HTTP 401/);
  assert.equal(r.candidates[0]?.ref, P.receipt);
  assert.equal(calls, 1);
  const u = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: unverifiedEmbedder, cache: vectorCache(tmp(), unverifiedEmbedder.id) });
  assert.equal(u.mode, "keyword-only");
  const { embedder, counts } = countingEmbedder(lexicalStandIn(), 0);
  const b = await retrieve({ query: "receipt", evidence: fixtureEvidence(), access: fixtureAccess(), embedder, cache: vectorCache(tmp(), embedder.id) });
  assert.equal(b.mode, "keyword-only");
  assert.equal(counts.requests, 0);
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
  const c = vectorCache(dir, stand.id);
  for (const f of readdirSync(c.root)) JSON.parse(readFileSync(join(c.root, f), "utf8"));
});

test("results keep evidence kinds and labels separate; context-only evidence is labelled as context", async () => {
  const r = await retrieve({ query: "city library", evidence: fixtureEvidence(), access: fixtureAccess(), embedder: lexicalStandIn(), cache: vectorCache(tmp(), lexicalStandIn().id) });
  for (const c of r.candidates) for (const e of c.evidence) {
    if (e.kind === "discussion-context") assert.match(e.label, /context, not a description of the photo/);
    if (e.kind === "visual-observation") assert.match(e.label, /not a verified fact/);
  }
  assert.match(r.caveat, /not proof/);
});
