import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentStore } from "../src/attachments.ts";
import { EmbeddingUnavailable } from "../src/embeddings.ts";
import type { Embedder } from "../src/embeddings.ts";
import { openaiModel } from "../src/model.ts";
import { photoRef } from "../src/photo-access.ts";
import { observationStore } from "../src/photo-observations.ts";
import { smallJpeg } from "./jpeg-fixture.ts";
import { lexicalStandIn } from "./photo-semantic-fixture.ts";
import { rig } from "./threads-fixture.ts";

// photos_search through the REAL server, stores, policy and runChat dispatch, with a scripted chat model (OpenAI adapter, mocked HTTP)
// and an offline stand-in embedder. These tests check wiring, authorization, transcript and invalidation; they say NOTHING about the
// quality of a real embedding model, and no provider is contacted.

/* eslint-disable @typescript-eslint/no-explicit-any */
const callJson = (name: string, args: unknown, id: string) => JSON.stringify({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] });
const textJson = (text: string) => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
type Script = (body: any) => { name: string; args: unknown } | { text: string };
const lastOutput = (body: any) => body.input.filter((i: any) => i.type === "function_call_output").map((i: any) => JSON.parse(i.output)).at(-1);

function provider() {
  const bodies: any[] = [];
  const scripts: Script[] = [];
  let n = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const s = scripts.shift();
    const r = s ? s(body) : { text: "Done." };
    return new Response("text" in r ? textJson(r.text) : callJson(r.name, r.args, `call_${++n}`), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { model: openaiModel("gpt-6-astra", ["test", "key", "x".repeat(8)].join("-"), fetcher), bodies, scripts };
}

function serverRig(semantic: { embedder: Embedder | undefined } | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-search-"));
  const p = provider();
  const now = () => new Date(Date.parse("2026-11-16T17:00:00Z"));
  const attachments = attachmentStore(join(dir, "attachments"), { now });
  const photoObservations = observationStore(join(dir, "photo-observations"));
  const cacheDir = join(dir, "photo-vectors");
  const photoSemantic = semantic ? { embedder: semantic.embedder, cacheDir, status: () => ({ port: "photo-embeddings", state: "live" as const, impl: "test", detail: "test", verifiedAt: new Date(0).toISOString() }) } : undefined;
  const r = rig({ dir, model: p.model, now, extra: () => ({ assistantDir: join(dir, "assistant"), attachments, photoObservations, ...(photoSemantic ? { photoSemantic } : {}) }) });
  const upload = async (path: string, bytes: Buffer) => {
    await r.api("/status");
    const res = await fetch(`http://127.0.0.1:${(r.server.address() as AddressInfo).port}${path}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(bytes) });
    return ((await res.json()) as any).attachment.id as string;
  };
  // Rai sends a photo in a new thread; the scripted model saves what it "saw" (it was really sent the photo), then answers.
  const photoWithObservation = async (title: string, caption: string, observation: string, seed: number) => {
    const th = await r.create(title);
    const id = await upload(`/threads/${th.id}/attachments`, smallJpeg(seed, 48, 32));
    const ref = photoRef(id);
    p.scripts.push(() => ({ name: "photos_observe", args: { ref, scope: "what is in this photo", observations: [observation], limitations: null, supersedes: null } }), () => ({ text: "Noted." }));
    const res = await r.api(`/threads/${th.id}/messages`, "POST", { text: caption, attachments: [id] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(photoObservations.records(ref).length, 1);
    return { th, ref };
  };
  const search = async (path: string, query: string) => {
    let out: any;
    p.scripts.push(() => ({ name: "photos_search", args: { query, includeArchived: null } }), (body) => ((out = lastOutput(body)), { text: "Here are the candidates." }));
    const res = await r.api(path, "POST", { text: `Find ${query}` });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return out;
  };
  return { ...r, dir, p, attachments, photoObservations, cacheDir, photoWithObservation, search };
}

const stateText = (dir: string) => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (n !== "photo-observations") walk(p);
      } else if (!n.endsWith(".jpg")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
};

test("disabled (the default): photos_search is not offered, no photo-embeddings port, nothing written; existing photo tools unchanged", async () => {
  const r = serverRig(undefined);
  await r.photoWithObservation("Dinner", "dinner at Marlow's", "Restaurant dining room with tall bookshelves behind the tables", 3);
  const names = r.p.bodies.at(-1).tools.map((t: any) => t.name);
  assert.ok(!names.includes("photos_search"));
  for (const t of ["photos_list", "photos_inspect", "photos_show", "photos_observe", "photos_recall", "photos_correct", "photos_forget"]) assert.ok(names.includes(t), t);
  assert.match(JSON.stringify(r.p.bodies.at(-1)), /does not exist yet/);
  assert.doesNotMatch(JSON.stringify(r.p.bodies.at(-1)), /Description search/);
  const st = await r.api("/status");
  assert.ok(!JSON.stringify(st.data).includes("photo-embeddings"));
  assert.equal(existsSync(r.cacheDir), false);
  r.close();
});

test("enabled: hybrid search finds a photo by its saved observation; a chat thread cannot see another thread's photo or evidence; transcript keeps no snippets", async () => {
  const r = serverRig({ embedder: lexicalStandIn() });
  const a = await r.photoWithObservation("Dinner", "dinner at Marlow's", "Restaurant dining room with tall wooden bookshelves behind the tables", 3);
  const b = await r.photoWithObservation("Drinks", "after work", "Wine bar with a wall of old books behind the bar", 5);
  assert.ok(r.p.bodies.at(-1).tools.some((t: any) => t.name === "photos_search" && t.strict === true));
  assert.match(JSON.stringify(r.p.bodies.at(-1)), /Description search \(photos_search/);
  // Assistant: both conversations are reachable.
  const fromAssistant = await r.search("/assistant/messages", "restaurant bookshelves");
  assert.equal(fromAssistant.ok, true, JSON.stringify(fromAssistant));
  const res = fromAssistant.result;
  assert.equal(res.candidates[0].ref, a.ref);
  assert.match(res.mode, /^hybrid/);
  assert.equal(res.coverage.photosSearched, 2);
  const ev = res.candidates[0].evidence.find((e: any) => e.kind === "visual-observation");
  assert.match(ev.label, /not a verified fact/);
  assert.match(res.notice, /NOT seen these photos/);
  // Thread B: only its own photo; thread A's photo and its observation neither match nor count.
  const fromB = (await r.search(`/threads/${b.th.id}/messages`, "restaurant bookshelves")).result;
  assert.equal(fromB.coverage.photosSearched, 1);
  assert.ok(!fromB.candidates.some((c: any) => c.ref === a.ref));
  assert.ok(!JSON.stringify(fromB).includes("Restaurant dining room"));
  // Stored conversation state keeps refs and kinds, never the evidence snippets.
  const text = stateText(r.dir);
  assert.ok(!text.includes("tall wooden bookshelves"), "observation text is not in the transcript or the vector cache");
  assert.ok(text.includes(a.ref));
  r.close();
});

test("enabled: photos_forget deletes the photo's vectors in the same call and the forgotten text never matches again", async () => {
  const r = serverRig({ embedder: lexicalStandIn() });
  const a = await r.photoWithObservation("Dinner", "dinner", "Restaurant dining room with tall wooden bookshelves behind the tables", 3);
  await r.search("/assistant/messages", "restaurant bookshelves");
  const ns = readdirSync(r.cacheDir);
  assert.equal(ns.length, 1);
  assert.ok(readdirSync(join(r.cacheDir, ns[0]!)).includes(a.ref));
  r.p.scripts.push(() => ({ name: "photos_forget", args: { ref: a.ref, ids: null } }), () => ({ text: "Forgotten." }));
  await r.api(`/threads/${a.th.id}/messages`, "POST", { text: "Forget what you saw in that photo" });
  assert.ok(!readdirSync(join(r.cacheDir, ns[0]!)).includes(a.ref), "vectors deleted by photos_forget");
  const after = (await r.search("/assistant/messages", "restaurant bookshelves")).result;
  assert.ok(!after.candidates.some((c: any) => c.ref === a.ref), JSON.stringify(after));
  assert.equal(after.noMatch, true);
  r.close();
});

test("enabled but provider unavailable: keyword ranking over the same evidence, chat keeps working", async () => {
  let calls = 0;
  const down: Embedder = { id: { model: "m", dims: 4, format: "f" }, embed: async () => (calls++, Promise.reject(new EmbeddingUnavailable("quota", "the embeddings project has no quota left (HTTP 429 insufficient_quota); no retry"))) };
  const r = serverRig({ embedder: down });
  const a = await r.photoWithObservation("Dinner", "dinner", "Restaurant dining room with tall wooden bookshelves behind the tables", 3);
  const out = (await r.search("/assistant/messages", "bookshelves")).result;
  assert.match(out.mode, /^keyword-only/);
  assert.match(out.degraded, /insufficient_quota/);
  assert.equal(out.candidates[0].ref, a.ref);
  assert.equal(calls, 1, "one attempt per search, no retry loop");
  // Feature on but no embedder at all (credential missing at startup): same keyword behaviour.
  const r2 = serverRig({ embedder: undefined });
  const b = await r2.photoWithObservation("Dinner", "dinner", "Restaurant dining room with tall wooden bookshelves behind the tables", 3);
  const out2 = (await r2.search("/assistant/messages", "bookshelves")).result;
  assert.equal(out2.candidates[0].ref, b.ref);
  r.close();
  r2.close();
});

test("discussion context: Rai's follow-up is labelled context; assistant replies and the search request itself are never evidence", async () => {
  const r = serverRig({ embedder: lexicalStandIn() });
  const a = await r.photoWithObservation("Trip", "lunch", "A sandwich on a plate", 3);
  r.p.scripts.push(() => ({ text: "Zeppelin hangar noted." }));
  await r.api(`/threads/${a.th.id}/messages`, "POST", { text: "the cafe was next to a zeppelin hangar" });
  const ctx = (await r.search("/assistant/messages", "zeppelin hangar")).result;
  assert.equal(ctx.candidates[0].ref, a.ref);
  const e = ctx.candidates[0].evidence.find((x: any) => x.kind === "discussion-context");
  assert.match(e.label, /context, not a description of the photo/);
  // A thread whose only follow-up is the search request: the request is not context for the photo, and the reply prose is never used.
  const b = await r.photoWithObservation("Walk", "walk", "A path through trees", 5);
  const own = (await r.search(`/threads/${b.th.id}/messages`, "noted giraffe")).result;
  assert.equal(own.noMatch, true, JSON.stringify(own));
  r.close();
});
