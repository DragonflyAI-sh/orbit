// A real ORBIT server for the photo gallery tests (test/photo-gallery.test.ts, test/photo-gallery-browser.test.ts): the real
// buildServer, thread and Assistant stores, attachment store and observation store in a temporary directory, with a scripted model
// that takes photos and, when a test asks, saves an observation (photos_observe) or relays a correction (photos_correct) through the
// real tools. Photos are synthetic JPEGs; a settable clock spreads them over several days. Nothing reaches a provider.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentStore } from "../../src/attachments.ts";
import { photoRef } from "../../src/photo-access.ts";
import { observationStore } from "../../src/photo-observations.ts";
import { importLedger } from "../../src/photo-import-ledger.ts";
import { smallJpeg } from "../jpeg-fixture.ts";
import { call, rig, say, scripted } from "../threads-fixture.ts";
import type { Seen } from "../threads-fixture.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Step = ReturnType<typeof say> | { text: string; calls: ReturnType<typeof call>[] };

// The server reads the legacy import ledger from <dir>/photo-imports (docs/photo-import-backfill.md); tests write it with the importer.
export async function galleryRig(start = "2026-11-20T09:00:00Z") {
  const dir = mkdtempSync(join(tmpdir(), "orbit-gallery-"));
  let t = Date.parse(start);
  const now = () => new Date(t);
  const queue: ((seen: Seen) => Step)[] = [];
  const model = Object.assign(scripted((seen) => (queue.shift() ?? (() => say("Noted.")))(seen)), { images: () => ({ ok: true, detail: "test model takes photos" }) });
  const attachments = attachmentStore(join(dir, "attachments"), { now });
  const photoObservations = observationStore(join(dir, "photo-observations"));
  const photoImports = importLedger(join(dir, "photo-imports"));
  const r = rig({ dir, model, now, extra: () => ({ assistantDir: join(dir, "assistant"), attachments, photoObservations, photoImports }) });
  await r.api("/status");
  const base = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
  let seed = 1;
  const upload = async (path: string) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(smallJpeg(seed++, 48 + (seed % 5) * 8, 32 + (seed % 3) * 8)) });
    assert.equal(res.status, 201);
    return ((await res.json()) as any).attachment.id as string;
  };
  // Rai sends `count` photos with a caption, in a new chat thread titled `thread` or in the Assistant. With `observe`, the model saves
  // what it "saw" in the first photo (it really was given it). Returns the refs, in message order.
  const send = async (o: { thread?: string; caption: string; count?: number; observe?: { observations: string[]; limitations?: string[]; scope?: string } }) => {
    const th = o.thread ? await r.create(o.thread) : undefined;
    const path = th ? `/threads/${th.id}` : "/assistant";
    const ids: string[] = [];
    for (let i = 0; i < (o.count ?? 1); i++) ids.push(await upload(`${path}/attachments`));
    const refs = ids.map(photoRef);
    if (o.observe) {
      const ob = o.observe;
      queue.push(() => ({ text: "", calls: [call("photos_observe", { ref: refs[0], scope: ob.scope ?? "what is in this photo", observations: ob.observations, limitations: ob.limitations ?? null, supersedes: null }, `obs_${seed}`)] }), () => say("Noted."));
    }
    const res = await r.api(`${path}/messages`, "POST", { text: o.caption, attachments: ids });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    if (o.observe) assert.equal(photoObservations.records(refs[0]!).length, 1, "the observation was saved");
    return { refs, thread: th };
  };
  // Rai corrects what was recorded about a photo, in the Assistant; the model relays it with photos_correct.
  const correct = async (ref: string, correction: string) => {
    const oid = photoObservations.records(ref).find((x) => x.kind === "model-observation" && x.state === "active")!.id;
    queue.push(() => ({ text: "", calls: [call("photos_correct", { ref, correction, supersedes: [oid] }, `fix_${seed++}`)] }), () => say("Corrected."));
    const res = await r.api("/assistant/messages", "POST", { text: `No: ${correction}` });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(photoObservations.records(ref).some((x) => x.kind === "user-correction"), "the correction was saved");
    return oid;
  };
  return { ...r, dir, base, attachments, photoObservations, photoImports, queue, send, correct, advance: (hours: number) => void (t += hours * 3_600_000) };
}

// A small realistic set: four days, the Assistant and two chat threads, observations on two photos and a correction on one.
export async function galleryScene() {
  const g = await galleryRig();
  const garden = await g.send({ thread: "Garden plans", caption: "The raised beds after the rain", count: 2, observe: { observations: ["Two wooden raised beds with young lettuce", "A blue watering can on the path"], limitations: ["The far corner is out of focus"], scope: "what is growing in the beds" } });
  g.advance(26);
  const desk = await g.send({ caption: "My desk this morning", observe: { observations: ["A white mug beside a laptop", "Bookshelves behind the desk"], scope: "what is on the desk" } });
  g.advance(3);
  await g.correct(desk.refs[0]!, "The mug is green, not white");
  g.advance(30);
  const receipt = await g.send({ thread: "Receipts", caption: "Hardware store receipt" });
  g.advance(50);
  const sky = await g.send({ caption: "", count: 1 });
  return { g, refs: { garden: garden.refs, desk: desk.refs[0]!, receipt: receipt.refs[0]!, sky: sky.refs[0]! }, threads: { garden: garden.thread!, receipt: receipt.thread! } };
}
