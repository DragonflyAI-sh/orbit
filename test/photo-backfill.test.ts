import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistantStore } from "../src/assistant-store.ts";
import type { Attachments } from "../src/attachments.ts";
import { EmbeddingUnavailable } from "../src/embeddings.ts";
import type { Embedder } from "../src/embeddings.ts";
import type { Message, ModelPort, Reply } from "../src/model.ts";
import { photoRef as refOf } from "../src/photo-access.ts";
import { BACKFILL_PROMPT, checkpoint, parseAnswer, runBackfill, selectMissing } from "../src/photo-backfill.ts";
import type { BackfillDeps } from "../src/photo-backfill.ts";
import { applyImport, EXPORT_FORMAT, planImport, storeIndex } from "../src/photo-import.ts";
import { BACKFILL_SOURCE, observationId, readableRecords, saveBackfillObservation } from "../src/photo-observations.ts";
import type { ObservationRecord } from "../src/photo-observations.ts";
import type { SemanticSources } from "../src/photo-semantic.ts";
import { vectorCache } from "../src/photo-semantic.ts";
import { galleryRig } from "./helpers/gallery-fixture.ts";
import { smallJpeg } from "./jpeg-fixture.ts";

// The operator-run missing-observations backfill (src/photo-backfill.ts, tools/photo-backfill/backfill.ts, docs/photo-import-backfill.md)
// against a real ORBIT server, its stores and gallery, with a FAKE vision model and a fake embedder (no provider is called). Synthetic
// photos and text only. Covers the capability gate, selection (forgotten, corrected, observed, imported), provenance, gallery
// visibility and search, interrupted reruns, provider failures, malformed answers, and indexing failures and retries.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fake = ModelPort & { calls: Message[][]; answer: (n: number, m: Message[]) => string | Error | Reply };
function fakeVision(answer: Fake["answer"], ok = true): Fake {
  const calls: Message[][] = [];
  const m: Fake = {
    calls,
    answer,
    status: () => ({ port: "model", state: "live", impl: "fake/vision", detail: "test", verifiedAt: new Date().toISOString() }),
    images: () => (ok ? { ok: true, detail: "test model takes photos" } : { ok: false, detail: "ORBIT blocked the photos locally, before any request: it does not know that the configured model fake-model takes image input" }),
    reply: async (messages) => {
      calls.push(messages);
      const a = m.answer(calls.length, messages);
      if (a instanceof Error) throw a;
      if (typeof a === "string") return { value: a, provenance: "live", source: "model/fake" };
      return a;
    },
  };
  return m;
}
const describe = (...obs: string[]) => JSON.stringify({ observations: obs, limitations: ["Synthetic: the corners are dark"] });

// The server's photo sources over the rig's state directory (the Assistant store is read again from its files).
function sourcesOf(g: Awaited<ReturnType<typeof galleryRig>>): SemanticSources {
  const assistant = assistantStore(join(g.dir, "assistant"));
  return {
    assistant: () => assistant.photoSource(),
    chat: (tid) => g.threads.photoSource(tid),
    imported: (aid) => g.photoImports.photo(aid),
    message: (c, m) => (c === "assistant:assistant" ? assistant.messageState(m) : /^chat:/.test(c) ? g.threads.messageState(c.slice(5), m) : "gone"),
    discussion: () => undefined,
  };
}
function deps(g: Awaited<ReturnType<typeof galleryRig>>, model: ModelPort, extra: Partial<BackfillDeps> = {}): BackfillDeps {
  return { attachments: g.attachments, sources: sourcesOf(g), store: g.photoObservations, model, modelName: "fake-vision-model", checkpoint: checkpoint(join(g.dir, "photo-backfill")), sleep: async () => {}, ...extra };
}
async function importOne(g: Awaited<ReturnType<typeof galleryRig>>, seed: number, caption: string) {
  const root = mkdtempSync(join(tmpdir(), "orbit-export-"));
  writeFileSync(join(root, "p.jpg"), smallJpeg(seed));
  writeFileSync(join(root, "orbit-photo-export.json"), JSON.stringify({ format: EXPORT_FORMAT, source: "openclaw", items: [{ id: `imp-${seed}`, file: "p.jpg", sentAt: "2026-01-02T03:04:05Z", sender: "owner", caption }] }));
  const r = applyImport(planImport({ root, existing: storeIndex(g.attachments), ledger: g.photoImports }), { root, attachments: g.attachments, ledger: g.photoImports });
  return r.imported[0]!.ref;
}
function forget(g: Awaited<ReturnType<typeof galleryRig>>, ref: string) {
  const located = g.attachments.bound().map((m) => ({ m, ref: refOf(m.id) })).find((x) => x.ref === ref)!.m;
  const rec: ObservationRecord = { v: 1, id: observationId({ conversation: "assistant:assistant", message: "m-old", callId: "c-old", ref }), kind: "model-observation", state: "forgotten", ref, image: { sha256: located.sha256, bytes: located.bytes, width: located.width, height: located.height }, at: "2026-11-20T09:00:00Z", source: { conversation: "assistant:assistant", message: "m-old", callId: "c-old" }, forgotten: { at: "2026-11-20T10:00:00Z", conversation: "assistant:assistant", message: "m-forget" } };
  g.photoObservations.mutate(ref, (records) => ({ records: [...records, rec], result: undefined }));
}
test("blocked vision: the run stops before any photo is read or sent, and nothing is saved", async () => {
  const g = await galleryRig();
  await g.send({ caption: "a photo nobody described" });
  let loads = 0;
  const attachments: Attachments = { ...g.attachments, load: (id, scope) => (loads++, g.attachments.load(id, scope)) };
  const model = fakeVision(() => describe("should never be asked"), false);
  const d = deps(g, model, { attachments });
  const dry = await runBackfill(d, { dryRun: true });
  assert.equal(dry.capability.ok, false);
  assert.match(dry.stopped!, /vision blocked: ORBIT blocked the photos locally/);
  assert.equal(dry.items.length, 1);
  assert.equal(dry.items[0]!.status, "would-describe");
  const run = await runBackfill(d, { dryRun: false });
  assert.match(run.stopped!, /No photo was read or sent, nothing was saved and no configuration was changed/);
  assert.equal(model.calls.length, 0);
  assert.equal(loads, 0);
  assert.equal(g.photoObservations.refs().length, 0);
});

test("describes only photos without a usable observation; skips forgotten and corrected ones; sends the photo alone, never its caption", async () => {
  const g = await galleryRig();
  const observed = await g.send({ caption: "observed already", observe: { observations: ["A red kettle on a stove"] } });
  const corrected = await g.send({ caption: "corrected", observe: { observations: ["A white mug"] } });
  await g.correct(corrected.refs[0]!, "The mug is green");
  const plain = await g.send({ thread: "Garden plans", caption: "Synthetic caption: the shed roof after the storm" });
  const forgotten = await g.send({ caption: "forgotten" });
  forget(g, forgotten.refs[0]!);
  const imported = await importOne(g, 7, "Synthetic legacy caption: bicycle by the door");
  const model = fakeVision((n) => (n === 1 ? describe("A wooden garden shed with a dented metal roof", "Puddles on a gravel path") : describe("A blue bicycle leaning on a door")));
  const d = deps(g, model);
  const sel = selectMissing(d);
  assert.deepEqual(new Set(sel.candidates.map((l) => l.ref)), new Set([plain.refs[0], imported]));
  assert.deepEqual(Object.fromEntries(sel.skipped.map((s) => [s.ref, s.reason])), { [observed.refs[0]!]: "has-observation", [corrected.refs[0]!]: "corrected", [forgotten.refs[0]!]: "forgotten" });
  const report = await runBackfill(d, { dryRun: false, intervalMs: 1000 });
  assert.equal(report.counts.saved, 2, JSON.stringify(report));
  assert.equal(model.calls.length, 2);
  for (const call of model.calls) {
    assert.equal(call.length, 1);
    assert.equal(call[0]!.content, BACKFILL_PROMPT, "the prompt is fixed: no caption, title or conversation text");
    assert.equal(call[0]!.images!.length, 1);
    assert.ok(!JSON.stringify(call).includes("Synthetic caption") && !JSON.stringify(call).includes("Synthetic legacy caption"));
  }
  // The image sent is the stored, integrity-checked copy.
  const plainMeta = g.attachments.bound().find((m) => refOf(m.id) === plain.refs[0])!;
  const sentImages = model.calls.map((c) => c[0]!.images![0]!.data);
  assert.ok(sentImages.includes(g.attachments.read(plainMeta.id, plainMeta.scope)!.toString("base64")));
  // Saved with backfill provenance about the exact version sent; existing records untouched.
  const rec = g.photoObservations.records(plain.refs[0]!).find((r) => r.state === "active")!;
  assert.equal(rec.source.conversation, BACKFILL_SOURCE);
  assert.equal(rec.inspection!.via, "backfill");
  assert.equal(rec.inspection!.model, "fake-vision-model");
  assert.equal(rec.image.sha256, plainMeta.sha256);
  assert.equal(g.photoObservations.records(observed.refs[0]!).length, 1);
  assert.equal(g.photoObservations.records(corrected.refs[0]!).filter((r) => r.source.conversation === BACKFILL_SOURCE).length, 0);
  assert.equal(g.photoObservations.records(forgotten.refs[0]!).length, 1, "a forgotten photo gets nothing new");
  // The gallery shows it as an operator backfill observation, and keyword search finds both photos by the new descriptions at once.
  const detail = await g.api(`/gallery/photos/${plain.refs[0]}`);
  assert.equal(detail.data.observations[0].inspection.via, "backfill");
  assert.equal(detail.data.observations[0].source.conversation.kind, "operator");
  assert.equal(detail.data.observations[0].source.link, "");
  assert.ok((await g.api("/gallery/search?q=dented%20roof")).data.matches.some((m: any) => m.photo.ref === plain.refs[0]));
  assert.ok((await g.api("/gallery/search?q=bicycle%20door")).data.matches.some((m: any) => m.photo.ref === imported));
  assert.equal((await g.api("/gallery/photos")).data.photos.find((p: any) => p.ref === imported).ai.observations, 1);
  // A chat thread does not read operator records (the Assistant's reach does).
  const tid = `chat:${plain.thread!.id}`;
  assert.equal(readableRecords(g.photoObservations, d.sources, tid, plain.refs[0]!, plainMeta.sha256).readable.length, 0);
  assert.equal(readableRecords(g.photoObservations, d.sources, "assistant:assistant", plain.refs[0]!, plainMeta.sha256).readable.length, 1);
  // A rerun has nothing left to describe.
  const again = await runBackfill(d, { dryRun: false });
  assert.equal(again.items.length, 0);
  assert.equal(model.calls.length, 2);
  assert.equal(report.items.every((i) => i.index === "not-configured"), true, "no embedder configured: the index status says so");
  assert.ok(!JSON.stringify(report).includes("dented"), "the report never carries observation text");
});

test("an interrupted run resumes from its checkpoint without duplicating; a retried save is idempotent", async () => {
  const g = await galleryRig();
  for (let i = 0; i < 3; i++) await g.send({ caption: `p${i}` });
  const ac = new AbortController();
  const model = fakeVision((n) => {
    if (n === 1) ac.abort();
    return describe(`Synthetic object number ${n}`);
  });
  const first = await runBackfill(deps(g, model, { signal: ac.signal }), { dryRun: false });
  assert.match(first.stopped!, /interrupted/);
  assert.equal(first.counts.saved, 1);
  const cp = JSON.parse(readFileSync(join(g.dir, "photo-backfill", "checkpoint.json"), "utf8"));
  assert.equal(Object.values(cp.items).filter((x: any) => x.status === "saved").length, 1);
  const second = await runBackfill(deps(g, model), { dryRun: false });
  assert.equal(second.counts.saved, 2);
  const all = g.photoObservations.refs().flatMap((r) => g.photoObservations.records(r));
  assert.equal(all.length, 3);
  // The same run and item saved twice: one record.
  const ref = g.photoObservations.refs()[0]!;
  const r0 = g.photoObservations.records(ref)[0]!;
  const meta = g.attachments.bound().find((m) => refOf(m.id) === ref)!;
  const again = saveBackfillObservation(g.photoObservations, { ref, current: () => meta, sentSha256: meta.sha256, run: r0.source.message, item: r0.source.callId, model: "fake-vision-model", scope: "x", observations: ["again"], limitations: [], at: "2026-11-27T00:00:00Z" });
  assert.deepEqual(again, { saved: true, id: r0.id, duplicate: true });
  // A changed image version is never described with the old answer.
  const other = saveBackfillObservation(g.photoObservations, { ref, current: () => meta, sentSha256: "0".repeat(64), run: "bf_other", item: "it", model: "m", scope: "x", observations: ["y"], limitations: [], at: "2026-11-27T00:00:00Z" });
  assert.deepEqual(other, { saved: false, skipped: "version-changed" });
});

test("provider failures stop the run and are retried a bounded number of times; malformed, refused and fallback answers save nothing", async () => {
  const g = await galleryRig();
  for (let i = 0; i < 3; i++) await g.send({ caption: `f${i}` });
  // A key-shaped value in a provider error, built at runtime (no secret-shaped literal in the repository).
  const fakeKey = ["sk", "proj", "x".repeat(32)].join("-");
  const failing = fakeVision(() => new Error(`HTTP 503: upstream unavailable ${fakeKey}`));
  for (let run = 1; run <= 3; run++) {
    const r = await runBackfill(deps(g, failing), { dryRun: false });
    assert.match(r.stopped!, /3 model calls failed in a row/);
    assert.equal(r.counts.failed, 3);
  }
  const cp = JSON.parse(readFileSync(join(g.dir, "photo-backfill", "checkpoint.json"), "utf8"));
  assert.ok(Object.values(cp.items).every((x: any) => x.attempts === 3 && x.status === "failed"));
  assert.ok(!JSON.stringify(cp).includes(fakeKey), "provider text is redacted in the checkpoint");
  const gaveUp = await runBackfill(deps(g, failing), { dryRun: false });
  assert.equal(gaveUp.photos.skipped["gave-up"], 3);
  assert.equal(failing.calls.length, 9, "no call after the attempts are used up");

  const h = await galleryRig();
  for (let i = 0; i < 4; i++) await h.send({ caption: `m${i}` });
  const answers = ["not json at all", JSON.stringify({ cannotSee: "no image arrived" }), JSON.stringify({ observations: ["ok"], extra: "field" }), { value: describe("From a fallback"), provenance: "live" as const, source: "model/fallback", fallback: { provider: "openrouter" as const, model: "x", reason: "usage_limit" as const, primaryLimit: { until: "2026-11-28T00:00:00Z", estimated: true } } }];
  const odd = fakeVision((n) => answers[n - 1]!);
  const r = await runBackfill(deps(h, odd), { dryRun: false });
  assert.equal(r.counts["model-refused"], 1);
  assert.equal(r.counts.failed, 3);
  assert.ok(r.items.some((i) => /fallback model/.test(i.reason ?? "")));
  assert.equal(h.photoObservations.refs().length, 0);
  assert.deepEqual(parseAnswer("```json\n{\"observations\":[\"a\"]}\n```"), { ok: true, observations: ["a"], limitations: [] });
});

test("indexing is separate from the observation: an embedding failure keeps the observation and reports the error; --index-only retries", async () => {
  const g = await galleryRig();
  await g.send({ caption: "to index" });
  const id = { model: "fake-embed", dims: 4, format: "test" };
  const broken: Embedder = { id, embed: async () => { throw new EmbeddingUnavailable("server", "HTTP 500 from the embeddings endpoint"); } };
  const cache = vectorCache(join(g.dir, "photo-vectors"), id);
  const model = fakeVision(() => describe("A stack of synthetic blue boxes"));
  const r = await runBackfill(deps(g, model, { index: { embedder: broken, cache } }), { dryRun: false });
  assert.equal(r.counts.saved, 1);
  assert.equal(r.items[0]!.index, "error");
  assert.match(r.items[0]!.indexError!, /HTTP 500/);
  assert.equal(r.index.errors, 1);
  assert.equal(cache.count(), 0);
  assert.ok((await g.api("/gallery/search?q=blue%20boxes")).data.matches.length, "keyword-searchable at once, whatever the index state");
  let texts: string[] = [];
  const working: Embedder = { id, embed: async (t) => ((texts = t), t.map((_, i) => [1, i, 0.5, 0.25])) };
  const retry = await runBackfill(deps(g, model, { index: { embedder: working, cache } }), { dryRun: false, indexOnly: true });
  assert.equal(retry.items[0]!.index, "indexed");
  assert.equal(cache.count(), 1);
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /^visual-observation: A stack of synthetic blue boxes/);
  assert.equal(model.calls.length, 1, "index-only never calls the vision model");
});

test("CLI: refuses unless ORBIT is stopped; with no model configured it reads and sends nothing", () => {
  const state = mkdtempSync(join(tmpdir(), "orbit-state-"));
  const env = { PATH: process.env.PATH ?? "" };
  const cli = (...a: string[]) => spawnSync(process.execPath, ["tools/photo-backfill/backfill.ts", "--state", state, ...a], { encoding: "utf8", env });
  const noStop = cli();
  assert.equal(noStop.status, 2);
  assert.match(JSON.parse(noStop.stdout).why, /stop ORBIT/);
  const run = cli("--orbit-stopped", "--apply");
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.capability.ok, false);
  assert.match(report.stopped, /vision blocked: no model is connected/);
  assert.equal(cli("--orbit-stopped", "--bogus").status, 2);
});
