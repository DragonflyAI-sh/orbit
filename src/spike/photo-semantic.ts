// SPIKE, NOT WIRED IN. Hybrid (keyword + embedding) photo retrieval prototype for docs/photo-semantic-spike.md.
//
// Nothing in ORBIT imports this module: no chat tool, route, port or startup path uses it, and it creates no index under ORBIT's state
// directory. It exists so the design can be exercised offline with synthetic records. Whether ORBIT's ChatGPT login can call any
// embeddings endpoint is UNVERIFIED (see the design note), so this file contains no endpoint, no model name and no HTTP client: an
// `Embedder` is injected. The only embedders that exist here are the refusing `unverifiedEmbedder` and the test-only lexical stand-in
// in test/photo-semantic-spike.test.ts, which measures plumbing, never semantic quality.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { matchTerms, queryTerms } from "../photo-access.ts";
import { untrustedText } from "../sessions.ts";

// ---- evidence ------------------------------------------------------------------------------------------------------------------------
// One piece of text ORBIT holds about a photo, with where it came from. Kinds stay separate end to end: a discussion line is never
// presented as something visible in the photo.
export type EvidenceKind = "visual-observation" | "user-correction" | "caption" | "conversation-title" | "discussion-context";
export type Evidence = {
  ref: string; // photo ref (ph_…)
  kind: EvidenceKind;
  sourceType: string; // e.g. "observation-record", "attachment-caption", "thread-title", "thread-message"
  sourceId: string; // record id, message id, thread id
  photoSha256: string; // the processed image version this evidence is about
  state: "active" | "superseded" | "forgotten" | "stale";
  text: string; // held in memory only; never written to the cache
};
export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  "visual-observation": "model observation from an earlier inspection (not a verified fact)",
  "user-correction": "Rai's correction (relayed statement, not a visual inspection)",
  caption: "caption Rai sent with the photo",
  "conversation-title": "title of the conversation the photo was sent in",
  "discussion-context": "discussion near the photo in its conversation (context, not a description of the photo)",
};
export const DISCUSSION_CHARS_MAX = 400;
export const EVIDENCE_TEXT_MAX = 600;

// The access/lifecycle view the retriever needs. In a real integration these would be backed by photoReach, readableRecords and the
// attachment store; here tests supply them.
export type Access = {
  // Refs the caller may read right now (the candidate set is restricted to these BEFORE any ranking or counting).
  authorizedRefs(): Set<string>;
  // Current processed-image SHA-256 for a ref, or undefined when the photo or its file is gone.
  currentVersion(ref: string): string | undefined;
  // Final check immediately before returning a result (source still present, still authorized, same version).
  revalidate(ref: string, sha256: string): boolean;
};

// Only active evidence about the current image version of an authorized photo is eligible. Forgotten, superseded and stale evidence
// is dropped here, before embedding, matching, ranking or counting, so it can never influence results.
export function eligibleEvidence(all: Evidence[], access: Access): Evidence[] {
  const allowed = access.authorizedRefs();
  return all.filter((e) => {
    if (!allowed.has(e.ref) || e.state !== "active") return false;
    const v = access.currentVersion(e.ref);
    return v !== undefined && v === e.photoSha256 && e.text.trim().length > 0;
  });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// The text actually embedded: flattened, bounded, prefixed with its kind so the vector of a discussion line is not the vector of the
// same words stated as an observation. Source text is untrusted data; it is only ever embedded and quoted, never followed.
export function embedText(e: Evidence): string {
  const max = e.kind === "discussion-context" ? DISCUSSION_CHARS_MAX : EVIDENCE_TEXT_MAX;
  return `${e.kind}: ${untrustedText(e.text, max).text}`;
}

// ---- embedder ------------------------------------------------------------------------------------------------------------------------
export type EmbedderId = { model: string; dims: number; format: string };
export type Embedder = { id: EmbedderId; embed(texts: string[]): Promise<number[][]> };
export class EmbeddingUnavailable extends Error {}
// The only embedder this spike may construct for ORBIT: it refuses, because no supported, subscription-covered endpoint is established.
export const unverifiedEmbedder: Embedder = {
  id: { model: "unverified", dims: 0, format: "none" },
  embed: async () => {
    throw new EmbeddingUnavailable("No embeddings endpoint is verified for ORBIT's ChatGPT login; semantic retrieval is off.");
  },
};
// Counts requests and texts, and enforces a hard request budget (no unbounded retries). Every evaluation reports these counts.
export function countingEmbedder(inner: Embedder, maxRequests: number) {
  const counts = { requests: 0, texts: 0, failures: 0, refusedOverBudget: 0 };
  const embedder: Embedder = {
    id: inner.id,
    async embed(texts) {
      if (counts.requests >= maxRequests) {
        counts.refusedOverBudget++;
        throw new EmbeddingUnavailable(`embedding request budget of ${maxRequests} reached`);
      }
      counts.requests++;
      counts.texts += texts.length;
      try {
        return await inner.embed(texts);
      } catch (err) {
        counts.failures++;
        throw err;
      }
    },
  };
  return { embedder, counts };
}

// ---- filesystem vector cache ---------------------------------------------------------------------------------------------------------
// Private, disposable, derived data. Layout: <dir>/<namespace>/<key>.json, namespace = hash(format, model, dims, CACHE_FORMAT).
// A key is derived from everything that makes a vector valid (namespace, ref, source type/id, image version, embedded-text hash), so
// a changed caption, correction, supersession or new image version simply maps to a different key: stale entries are never looked up.
// Entries hold no source text. Deleting the whole directory is always safe; it is rebuilt from the authoritative stores.
export const CACHE_FORMAT = "orbit-photo-vector/1";
export type CacheEntry = {
  v: 1;
  format: string;
  model: string;
  dims: number;
  ref: string;
  kind: EvidenceKind;
  sourceType: string;
  sourceId: string;
  photoSha256: string;
  contentHash: string; // SHA-256 of the embedded text (the text itself is not stored)
  vector: number[];
};
export const ENTRY_BYTES_MAX = 128 * 1024;

export function vectorCache(dir: string, id: EmbedderId) {
  const ns = sha(`${CACHE_FORMAT}|${id.format}|${id.model}|${id.dims}`).slice(0, 16);
  const root = join(dir, ns);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Leftover temp files from an interrupted write are removed on open; the old or new entry is intact either way.
  for (const f of readdirSync(root)) if (f.includes(".tmp-")) unlinkSync(join(root, f));

  const keyOf = (e: Evidence) => sha(`${ns}|${e.ref}|${e.sourceType}|${e.sourceId}|${e.photoSha256}|${sha(embedText(e))}`).slice(0, 40);
  const path = (key: string) => join(root, `${key}.json`);

  const valid = (x: unknown, e: Evidence): x is CacheEntry => {
    const c = x as CacheEntry;
    return (
      !!c && c.v === 1 && c.format === CACHE_FORMAT && c.model === id.model && c.dims === id.dims && c.ref === e.ref &&
      c.sourceId === e.sourceId && c.photoSha256 === e.photoSha256 && c.contentHash === sha(embedText(e)) &&
      Array.isArray(c.vector) && c.vector.length === id.dims && c.vector.every((n) => Number.isFinite(n))
    );
  };

  return {
    root,
    keyOf,
    // A damaged, oversized or mismatched entry is a miss (and is re-embedded), never an error and never trusted.
    get(e: Evidence): number[] | undefined {
      try {
        const p = path(keyOf(e));
        if (statSync(p).size > ENTRY_BYTES_MAX) return undefined;
        const x: unknown = JSON.parse(readFileSync(p, "utf8"));
        return valid(x, e) ? x.vector : undefined;
      } catch {
        return undefined;
      }
    },
    // Atomic: write a uniquely named temp file, fsync, rename. Concurrent writers of the same key write identical content, so the
    // last rename wins harmlessly; a crash leaves either no entry or a complete one.
    put(e: Evidence, vector: number[]) {
      const entry: CacheEntry = {
        v: 1, format: CACHE_FORMAT, model: id.model, dims: id.dims, ref: e.ref, kind: e.kind, sourceType: e.sourceType,
        sourceId: e.sourceId, photoSha256: e.photoSha256, contentHash: sha(embedText(e)), vector,
      };
      const final = path(keyOf(e));
      const tmp = `${final}.tmp-${randomBytes(6).toString("hex")}`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(entry));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, final);
    },
    // Removes every entry not backing currently eligible evidence: forgotten/superseded/stale/revoked evidence loses its vector.
    // Run after forgetting or correction (eagerly) and opportunistically after a build. Returns how many were removed.
    prune(live: Evidence[]): number {
      const keep = new Set(live.map((e) => `${keyOf(e)}.json`));
      let removed = 0;
      for (const f of readdirSync(root)) {
        if (!keep.has(f)) {
          unlinkSync(join(root, f));
          removed++;
        }
      }
      return removed;
    },
    bytes(): number {
      return readdirSync(root).reduce((n, f) => n + statSync(join(root, f)).size, 0);
    },
    count(): number {
      return readdirSync(root).length;
    },
  };
}
export type VectorCache = ReturnType<typeof vectorCache>;

// ---- retrieval -----------------------------------------------------------------------------------------------------------------------
export const RRF_K = 60;
export const RESULTS_MAX = 3;
export const SEMANTIC_LIST_MAX = 10;
// Below this cosine a semantic hit is not admitted at all (tuned only on synthetic data; must be re-set against the real model).
export const SEMANTIC_FLOOR_DEFAULT = 0.35;
// Top two fused scores within this ratio: ambiguous, say so and show both instead of picking one.
export const AMBIGUITY_RATIO = 0.9;
export const EMBED_BATCH = 16;

export type Candidate = {
  ref: string;
  rank: number;
  score: number;
  via: ("keyword" | "semantic")[];
  evidence: { kind: EvidenceKind; label: string; sourceType: string; sourceId: string; snippet: string; similarity?: number }[];
};
export type RetrievalResult = {
  mode: "hybrid" | "keyword-only";
  degraded?: string;
  candidates: Candidate[];
  ambiguous: boolean;
  noMatch: boolean;
  caveat: string;
  stats: { eligibleEvidence: number; authorizedPhotos: number; embedded: number; reused: number; ms: number };
};
export const CAVEAT =
  "Candidates are ranked by keyword and text-similarity matches over ORBIT's stored text about photos (observations, corrections, captions, titles, nearby discussion). Similarity is not proof of what a photo shows; context lines describe the conversation, not the image.";
export const NO_MATCH_CAVEAT =
  "Nothing stored about the photos you can see matched closely enough. That says nothing about what the photos show, since image content itself is not searched.";

const cosine = (a: number[], b: number[]) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

// Keyword ranking reusing the existing photos_list rule (every term must appear in caption or conversation title), ordered by how many
// term hits there are, then by ref for determinism. This is the baseline the hybrid is compared against.
export function keywordRanking(query: string, evidence: Evidence[]): string[] {
  let terms: string[];
  try {
    terms = queryTerms(query);
  } catch {
    return [];
  }
  const byRef = new Map<string, { caption: string; title: string }>();
  for (const e of evidence) {
    if (e.kind !== "caption" && e.kind !== "conversation-title") continue;
    const f = byRef.get(e.ref) ?? { caption: "", title: "" };
    if (e.kind === "caption") f.caption += ` ${e.text}`;
    else f.title += ` ${e.text}`;
    byRef.set(e.ref, f);
  }
  const hits: { ref: string; n: number }[] = [];
  for (const [ref, f] of byRef) {
    const m = matchTerms(terms, f);
    if (m) hits.push({ ref, n: m.caption.length + m.title.length });
  }
  return hits.sort((a, b) => b.n - a.n || a.ref.localeCompare(b.ref)).map((h) => h.ref);
}

async function vectorsFor(items: Evidence[], cache: VectorCache, embedder: Embedder) {
  const out = new Map<Evidence, number[]>();
  const missing: Evidence[] = [];
  for (const e of items) {
    const v = cache.get(e);
    if (v) out.set(e, v);
    else missing.push(e);
  }
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vs = await embedder.embed(batch.map(embedText));
    if (vs.length !== batch.length) throw new EmbeddingUnavailable("embedder returned the wrong number of vectors");
    batch.forEach((e, j) => {
      if (vs[j].length !== embedder.id.dims) throw new EmbeddingUnavailable("embedder returned a vector of the wrong size");
      cache.put(e, vs[j]);
      out.set(e, vs[j]);
    });
  }
  return { vectors: out, embedded: missing.length, reused: items.length - missing.length };
}

export type RetrieveOptions = {
  query: string;
  evidence: Evidence[]; // everything the sources hold; eligibility is applied here
  access: Access;
  embedder: Embedder;
  cache: VectorCache;
  queryCache?: Map<string, number[]>;
  floor?: number;
  now?: () => number;
};

export async function retrieve(o: RetrieveOptions): Promise<RetrievalResult> {
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const authorized = o.access.authorizedRefs();
  const eligible = eligibleEvidence(o.evidence, o.access);
  const floor = o.floor ?? SEMANTIC_FLOOR_DEFAULT;
  const keyword = keywordRanking(o.query, eligible);

  let mode: RetrievalResult["mode"] = "hybrid";
  let degraded: string | undefined;
  let embedded = 0;
  let reused = 0;
  const best = new Map<string, { sim: number; e: Evidence }[]>();
  try {
    const qText = `query: ${untrustedText(o.query, 200).text}`;
    let q = o.queryCache?.get(qText);
    if (!q) {
      [q] = await o.embedder.embed([qText]);
      if (!q || q.length !== o.embedder.id.dims) throw new EmbeddingUnavailable("embedder returned a query vector of the wrong size");
      o.queryCache?.set(qText, q);
    }
    const r = await vectorsFor(eligible, o.cache, o.embedder);
    embedded = r.embedded;
    reused = r.reused;
    for (const [e, v] of r.vectors) {
      const sim = cosine(q, v);
      if (sim < floor) continue;
      const list = best.get(e.ref) ?? [];
      list.push({ sim, e });
      best.set(e.ref, list);
    }
  } catch (err) {
    // Any embedder failure (unverified endpoint, auth, quota, timeout, budget) falls back to keyword-only for this call. No retry.
    mode = "keyword-only";
    degraded = `semantic ranking unavailable: ${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}`;
    best.clear();
  }

  // A photo's semantic score is its best evidence similarity; context-only evidence counts at half weight so that a library discussion
  // attached to an unrelated image cannot outrank a photo whose own observations or caption match.
  const semScore = (ref: string) =>
    Math.max(...(best.get(ref) ?? []).map((x) => (x.e.kind === "discussion-context" ? x.sim * 0.5 : x.sim)), 0);
  const semantic = [...best.keys()].sort((a, b) => semScore(b) - semScore(a) || a.localeCompare(b)).slice(0, SEMANTIC_LIST_MAX);

  // Reciprocal rank fusion; refs are unique per list, so photos are deduplicated by construction.
  const fused = new Map<string, { score: number; via: Set<"keyword" | "semantic"> }>();
  const add = (list: string[], via: "keyword" | "semantic") =>
    list.forEach((ref, i) => {
      const f = fused.get(ref) ?? { score: 0, via: new Set() };
      f.score += 1 / (RRF_K + i + 1);
      f.via.add(via);
      fused.set(ref, f);
    });
  add(keyword, "keyword");
  add(semantic, "semantic");

  const ordered = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const candidates: Candidate[] = [];
  for (const [ref, f] of ordered) {
    if (candidates.length >= RESULTS_MAX) break;
    const v = o.access.currentVersion(ref);
    // Revalidate before returning: still authorized, still present, same version.
    if (!authorized.has(ref) || !v || !o.access.revalidate(ref, v)) continue;
    const sem = (best.get(ref) ?? []).sort((a, b) => b.sim - a.sim).slice(0, 2);
    const kw = f.via.has("keyword") ? eligible.filter((e) => e.ref === ref && (e.kind === "caption" || e.kind === "conversation-title")).slice(0, 1) : [];
    const shown = [...kw.map((e) => ({ e, sim: undefined as number | undefined })), ...sem.filter((s) => !kw.includes(s.e))];
    candidates.push({
      ref,
      rank: candidates.length + 1,
      score: Number(f.score.toFixed(5)),
      via: [...f.via],
      evidence: shown.map(({ e, sim }) => ({
        kind: e.kind,
        label: EVIDENCE_LABEL[e.kind],
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        snippet: untrustedText(e.text, 160).text,
        ...(sim === undefined ? {} : { similarity: Number(sim.toFixed(3)) }),
      })),
    });
  }
  // RRF scores are compressed (1/61 vs 1/62), so ambiguity is judged on match strength instead: best semantic similarity, plus 1 for a
  // keyword match. Two candidates of near-equal strength are reported as ambiguous and both shown; ORBIT does not pick for Rai.
  const strength = (c: Candidate) => semScore(c.ref) + (c.via.includes("keyword") ? 1 : 0);
  const ambiguous = candidates.length >= 2 && strength(candidates[1]) >= strength(candidates[0]) * AMBIGUITY_RATIO;
  return {
    mode,
    ...(degraded ? { degraded } : {}),
    candidates,
    ambiguous,
    noMatch: candidates.length === 0,
    caveat: candidates.length ? CAVEAT : NO_MATCH_CAVEAT,
    stats: { eligibleEvidence: eligible.length, authorizedPhotos: authorized.size, embedded, reused, ms: Number((now() - t0).toFixed(2)) },
  };
}
