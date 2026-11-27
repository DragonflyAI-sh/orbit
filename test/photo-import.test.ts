import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { IMPORT_SCOPE } from "../src/attachments.ts";
import { metadataSegments, normalizeJpeg } from "../src/jpeg.ts";
import { photoPolicy, photoReach, photoRef } from "../src/photo-access.ts";
import { applyImport, APPROVALS_FORMAT, EXPORT_FORMAT, ImportError, knownProjects, planDigest, planImport, readOnlyIndex, reportOf, revertImport, storeIndex } from "../src/photo-import.ts";
import { importLedger } from "../src/photo-import-ledger.ts";
import { galleryRig } from "./helpers/gallery-fixture.ts";
import { encodeJpeg, pattern, smallJpeg, withMetadata } from "./jpeg-fixture.ts";

// The operator-run legacy photo importer (src/photo-import.ts, tools/photo-import/import.ts, docs/photo-import-backfill.md) against
// SYNTHETIC export bundles built here at runtime: invented captions, invented ids, generated JPEGs. Dry runs, apply through the real
// attachment store and ledger into a real ORBIT server's gallery, retries, duplicates, malformed entries, ambiguous project evidence,
// path and type refusals, and reversal. No real export, host, photo or vault is used.

/* eslint-disable @typescript-eslint/no-explicit-any */
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, pre: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${pre}${n}/`);
      else out[`${pre}${n}`] = sha(readFileSync(p));
    }
  };
  walk(dir, "");
  return out;
}

// A synthetic bundle: orbit-photo-export.json plus photo files. `items` are manifest entries; `files` maps relative path to bytes.
function bundle(items: unknown[], files: Record<string, Buffer>, top: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "orbit-export-"));
  for (const [rel, b] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), b);
  }
  writeFileSync(join(root, "orbit-photo-export.json"), JSON.stringify({ format: EXPORT_FORMAT, source: "openclaw", exportedAt: "2026-11-01T00:00:00Z", items, ...top }));
  return root;
}
function vaultProjects(names: string[]) {
  const d = mkdtempSync(join(tmpdir(), "orbit-projects-"));
  for (const n of names) writeFileSync(join(d, `${n}.md`), `# ${n}\n`);
  return d;
}
const item = (id: string, file: string, extra: Record<string, unknown> = {}) => ({ id, file, sentAt: "2026-03-04T18:22:10Z", sender: "owner", caption: `Synthetic caption ${id}`, session: `sess-${id}`, message: `msg-${id}`, ...extra });

test("dry run: classifies importable, duplicate, already present, missing, rejected and every project-link case, and changes nothing", async () => {
  const g = await galleryRig();
  // A photo Rai already sent in a conversation: its bytes in the export are a duplicate of a native photo.
  const sent = await g.send({ caption: "native photo" });
  const nativeBytes = g.attachments.read(g.attachments.bound()[0]!.id, "assistant")!;
  const a = withMetadata(smallJpeg(41), { exif: true, xmp: true, comment: "synthetic gps note" });
  const b = smallJpeg(42);
  const c = smallJpeg(43);
  const d = smallJpeg(44);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const big = encodeJpeg(1700, 40, pattern(3));
  const corrupt = smallJpeg(45).subarray(0, 200);
  const outside = mkdtempSync(join(tmpdir(), "orbit-outside-"));
  writeFileSync(join(outside, "secret.jpg"), smallJpeg(46));
  const root = bundle(
    [
      item("p-linked", "media/a.jpg", { projects: [{ project: "Projects/Garden.md", evidence: "explicit", basis: "the message was tagged #garden" }] }),
      item("p-candidates", "media/b.jpg", { projectCandidates: ["Projects/Garden.md", "Projects/Shed.md"] }),
      item("p-two", "media/c.jpg", { projects: [{ project: "Projects/Garden.md", evidence: "explicit", basis: "tag" }, { project: "Projects/Shed.md", evidence: "explicit", basis: "tag" }] }),
      item("p-unknown-project", "media/d.jpg", { projects: [{ project: "Projects/Nowhere.md", evidence: "explicit", basis: "tag" }] }),
      item("dup-in-export", "media/a-copy.jpg"),
      item("native-dup", "media/native.jpg"),
      item("gone", "media/expired.jpg"),
      item("bad-time", "media/b.jpg", { sentAt: "yesterday" }),
      item("not-owner", "media/b.jpg", { sender: "someone-else" }),
      item("transcript", "media/b.jpg", { transcript: "a whole conversation" }),
      item("url", "https://example.invalid/photo.jpg"),
      item("traversal", "../outside.jpg"),
      item("escape", "media/link.jpg"),
      item("png", "media/fake.jpg"),
      item("oversize", "media/big.jpg"),
      item("corrupt", "media/corrupt.jpg"),
      item("heic-name", "media/photo.heic"),
      item("p-linked", "media/a.jpg"),
      { id: "bad id with spaces", file: "media/a.jpg" },
      item("weak-evidence", "media/b.jpg", { projects: [{ project: "Projects/Garden.md", evidence: "visual-similarity", basis: "looks like a garden" }] }),
    ],
    { "media/a.jpg": a, "media/a-copy.jpg": a, "media/b.jpg": b, "media/c.jpg": c, "media/d.jpg": d, "media/native.jpg": nativeBytes, "media/fake.jpg": png, "media/big.jpg": big, "media/corrupt.jpg": corrupt },
  );
  symlinkSync(join(outside, "secret.jpg"), join(root, "media/link.jpg"));
  const projects = knownProjects(vaultProjects(["Garden", "Shed"]));
  const before = { state: tree(g.dir), export: tree(root) };
  const plan = planImport({ root, projects, existing: readOnlyIndex(join(g.dir, "attachments")), ledger: importLedger(join(g.dir, "photo-imports")) });
  // The first entry of each id (a repeated id is checked separately below).
  const by = Object.fromEntries([...plan.items].reverse().map((i) => [i.item, i]));
  assert.equal(by["p-linked"].status, "importable");
  assert.deepEqual(by["p-linked"].link, { status: "linked", project: "Projects/Garden.md", evidence: "explicit" });
  assert.equal(by["p-candidates"].link.status, "ambiguous", "candidates alone are never linked");
  assert.deepEqual(by["p-two"].link.candidates, ["Projects/Garden.md", "Projects/Shed.md"]);
  assert.equal(by["p-unknown-project"].link.status, "unmatched");
  assert.equal(by["dup-in-export"].status, "duplicate-in-export");
  assert.equal(by["native-dup"].status, "already-present");
  assert.equal(by["native-dup"].ref, sent.refs[0]);
  assert.equal(by.gone.status, "missing");
  for (const [k, why] of Object.entries({ "bad-time": /sentAt/, "not-owner": /owner/, transcript: /unknown field/, url: /URLs are never fetched/, traversal: /relative path/, escape: /outside the export/, png: /PNG/, oversize: /oversize/, corrupt: /corrupt/, "heic-name": /only \.jpg/, "weak-evidence": /must be "explicit"/ })) {
    assert.equal(by[k]?.status, "rejected", k);
    assert.match(by[k]!.reason!, why, k);
  }
  assert.ok(plan.items.some((i) => i.item === "p-linked" && i.status === "rejected" && /twice/.test(i.reason!)), "a repeated id is rejected");
  assert.ok(plan.items.some((i) => i.status === "rejected" && /id:/.test(i.reason!)), "a malformed id is rejected");
  assert.equal(plan.counts.importable, 4);
  // Nothing changed anywhere, and the report holds no caption, pointer, file name or path.
  assert.deepEqual(tree(g.dir), before.state);
  assert.deepEqual(tree(root), before.export);
  const printed = JSON.stringify(reportOf(plan));
  for (const leak of ["Synthetic caption", "sess-", "msg-", "media/", root, "secret"]) assert.ok(!printed.includes(leak), `report leaks ${leak}`);
});

test("apply: imported photos are private, metadata-free, in the gallery with provenance and read-only project links; the export is untouched", async () => {
  const g = await galleryRig();
  const thread = await g.create("Some chat");
  const exif = withMetadata(smallJpeg(51), { exif: true, xmp: true, comment: "synthetic" });
  const root = bundle(
    [
      item("legacy-1", "a.jpg", { caption: "Synthetic legacy caption about tomato seedlings", projects: [{ project: "Projects/Garden.md", evidence: "explicit", basis: "tag" }] }),
      item("legacy-2", "b.jpg", { sentAt: "2026-02-01T08:00:00Z", projectCandidates: ["Projects/Garden.md"] }),
    ],
    { "a.jpg": exif, "b.jpg": smallJpeg(52) },
  );
  const exportBefore = tree(root);
  const projects = knownProjects(vaultProjects(["Garden"]));
  const ledger = importLedger(join(g.dir, "photo-imports"));
  const plan = planImport({ root, projects, existing: storeIndex(g.attachments), ledger });
  const r = applyImport(plan, { root, attachments: g.attachments, ledger });
  assert.equal(r.imported.length, 2);
  assert.equal(r.failed.length, 0);
  assert.deepEqual(r.linked.map((l) => [l.item, l.project, l.evidence]), [["legacy-1", "Projects/Garden.md", "explicit"]]);
  assert.deepEqual(tree(root), exportBefore, "the export is only read");
  const ref1 = r.imported.find((x) => x.item === "legacy-1")!.ref;
  // Stored like an upload: normalized JPEG, no APPn/comment metadata, mode 0600, bound in the import scope.
  const meta = g.attachments.bound().find((m) => photoRef(m.id) === ref1)!;
  assert.equal(meta.scope, IMPORT_SCOPE);
  assert.equal(meta.state, "bound");
  const stored = g.attachments.read(meta.id, IMPORT_SCOPE)!;
  assert.deepEqual(metadataSegments(stored).filter((s) => s !== "APP0"), [], "only the fixed JFIF header remains");
  assert.equal(statSync(join(g.dir, "attachments", `${meta.id}.jpg`)).mode & 0o777, 0o600);
  assert.equal(statSync(join(g.dir, "photo-imports", "ledger.json")).mode & 0o777, 0o600);
  // The gallery shows it under its legacy time, as an import (never as a message), with the legacy caption and its project link.
  const list = await g.api("/gallery/photos");
  const p = list.data.photos.find((x: any) => x.ref === ref1);
  assert.equal(p.conversation.kind, "import");
  assert.match(p.conversation.title, /Imported from OpenClaw/);
  assert.equal(p.message, null);
  assert.equal(p.link, "");
  assert.equal(p.sentAt, "2026-03-04T18:22:10Z");
  assert.equal(p.caption, "Synthetic legacy caption about tomato seedlings");
  assert.equal(p.imported.item, "legacy-1");
  assert.match(p.imported.note, /not a message sent in ORBIT/);
  const detail = await g.api(`/gallery/photos/${ref1}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.projects.map((x: any) => [x.project, x.name, x.evidence]), [["Projects/Garden.md", "Garden", "explicit"]]);
  const other = await g.api(`/gallery/photos/${r.imported.find((x) => x.item === "legacy-2")!.ref}`);
  assert.deepEqual(other.data.projects, [], "an ambiguous candidate is not linked");
  const img = await fetch(`${g.base}/assistant/photos/${ref1}`);
  assert.equal(img.status, 200);
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(stored));
  // Only the Assistant's reach sees imports: a chat thread never does.
  assert.ok(photoPolicy("assistant:assistant").may(IMPORT_SCOPE));
  assert.equal(photoPolicy(`chat:${thread.id}`).may(IMPORT_SCOPE), false);
  const sources = { assistant: () => ({ messages: [], archivedChunks: 0 }), chat: () => undefined, imported: (aid: string) => ledger.photo(aid) };
  assert.ok(photoReach({ attachments: g.attachments, sources }, "assistant:assistant").find(ref1));
  assert.equal(photoReach({ attachments: g.attachments, sources }, `chat:${thread.id}`).find(ref1), undefined);
  // Keyword search finds it through its import title, never through image content.
  const s = await g.api(`/gallery/search?q=${encodeURIComponent("imported openclaw")}`);
  assert.ok(s.data.matches.some((m: any) => m.photo.ref === ref1));
});

test("retries are safe: a second apply imports nothing new; an interrupted import (photo stored, ledger entry missing) is finished", async () => {
  const g = await galleryRig();
  const root = bundle([item("one", "1.jpg"), item("two", "2.jpg")], { "1.jpg": smallJpeg(61), "2.jpg": smallJpeg(62) });
  const ledger = importLedger(join(g.dir, "photo-imports"));
  // Interrupted earlier: "two" was stored but its ledger entry was never written (a crash between the two writes). It is invisible.
  const n = normalizeJpeg(readFileSync(join(root, "2.jpg")));
  assert.ok(n.ok);
  g.attachments.putImported(n.bytes, { width: n.width, height: n.height }, "2026-11-20T09:00:00Z");
  assert.equal((await g.api("/gallery/photos")).data.total, 0, "a stored copy without its ledger entry is never shown");
  const plan0 = planImport({ root, existing: storeIndex(g.attachments), ledger });
  assert.equal(plan0.items.find((i) => i.item === "two")!.status, "importable");
  assert.match(plan0.items.find((i) => i.item === "two")!.reason!, /interrupted import/);
  const first = applyImport(plan0, { root, attachments: g.attachments, ledger });
  assert.deepEqual([first.imported.map((x) => x.item), first.finished.map((x) => x.item)], [["one"], ["two"]]);
  assert.equal((await g.api("/gallery/photos")).data.total, 2);
  const again = planImport({ root, existing: storeIndex(g.attachments), ledger });
  assert.deepEqual(again.items.map((i) => i.status), ["already-imported", "already-imported"]);
  const second = applyImport(again, { root, attachments: g.attachments, ledger });
  assert.equal(second.imported.length, 0);
  assert.equal(g.attachments.bound().filter((m) => m.scope === IMPORT_SCOPE).length, 2, "no second copy");
  assert.equal(ledger.photos().length, 2);
  // An item id reused for different bytes is refused, never silently replaced.
  writeFileSync(join(root, "1.jpg"), smallJpeg(63));
  const changed = planImport({ root, existing: storeIndex(g.attachments), ledger });
  assert.match(changed.items.find((i) => i.item === "one")!.reason!, /different bytes/);
});

test("approvals: bound to the reviewed manifest; pick one of several explicit projects, decline, or skip an item", async () => {
  const g = await galleryRig();
  const root = bundle(
    [
      item("two", "a.jpg", { projects: [{ project: "Projects/Garden.md", evidence: "explicit", basis: "tag" }, { project: "Projects/Shed.md", evidence: "explicit", basis: "tag" }] }),
      item("cand", "b.jpg", { projectCandidates: ["Projects/Shed.md"] }),
      item("skipme", "c.jpg"),
    ],
    { "a.jpg": smallJpeg(71), "b.jpg": smallJpeg(72), "c.jpg": smallJpeg(73) },
  );
  const ledger = importLedger(join(g.dir, "photo-imports"));
  const projects = knownProjects(vaultProjects(["Garden", "Shed"]));
  const dry = planImport({ root, projects, existing: storeIndex(g.attachments), ledger });
  assert.throws(() => planImport({ root, projects, existing: storeIndex(g.attachments), ledger, approvalsText: JSON.stringify({ format: APPROVALS_FORMAT, manifestSha256: "0".repeat(64), links: {} }) }), ImportError);
  const approvalsText = JSON.stringify({ format: APPROVALS_FORMAT, manifestSha256: dry.manifestSha256, links: { two: "Projects/Shed.md", cand: null }, skip: ["skipme"] });
  const plan = planImport({ root, projects, existing: storeIndex(g.attachments), ledger, approvalsText });
  const by = Object.fromEntries(plan.items.map((i) => [i.item, i]));
  assert.deepEqual(by.two.link, { status: "linked", project: "Projects/Shed.md", evidence: "operator-approved" });
  assert.equal(by.cand.link.status, "declined");
  assert.equal(by.skipme.status, "rejected");
  const r = applyImport(plan, { root, attachments: g.attachments, ledger });
  assert.deepEqual(r.linked.map((l) => [l.item, l.evidence]), [["two", "operator-approved"]]);
  // Without a projects directory nothing can be verified, so nothing is linked.
  const unverified = planImport({ root, existing: storeIndex(g.attachments), ledger, approvalsText });
  assert.equal(unverified.items.find((i) => i.item === "two")!.link.status, "unverified");
});

test("revert: the batch's photos and links disappear, only imported files are deleted, a photo sent in a conversation is untouched", async () => {
  const g = await galleryRig();
  const sent = await g.send({ caption: "native" });
  const native = g.attachments.bound()[0]!;
  const nativeBytes = g.attachments.read(native.id, "assistant")!;
  const root = bundle(
    [item("imp", "a.jpg", { projects: [{ project: "Projects/Garden.md", evidence: "explicit", basis: "tag" }] }), item("dup", "n.jpg", { projects: [{ project: "Projects/Garden.md", evidence: "explicit", basis: "tag" }] })],
    { "a.jpg": smallJpeg(81), "n.jpg": nativeBytes },
  );
  const ledger = importLedger(join(g.dir, "photo-imports"));
  const projects = knownProjects(vaultProjects(["Garden"]));
  const r = applyImport(planImport({ root, projects, existing: storeIndex(g.attachments), ledger }), { root, attachments: g.attachments, ledger });
  assert.deepEqual(r.linked.map((l) => l.ref).sort(), [r.imported[0]!.ref, sent.refs[0]].sort(), "the native duplicate gets the explicit link, not a second copy");
  assert.equal((await g.api("/gallery/photos")).data.total, 2);
  const undo = revertImport(r.batch, { attachments: g.attachments, ledger });
  assert.equal(undo.photosHidden, 1);
  assert.equal(undo.filesRemoved, 1);
  assert.equal(undo.linksRemoved, 2);
  const after = await g.api("/gallery/photos");
  assert.deepEqual(after.data.photos.map((p: any) => p.ref), sent.refs);
  assert.deepEqual((await g.api(`/gallery/photos/${sent.refs[0]}`)).data.projects, []);
  assert.ok(g.attachments.read(native.id, "assistant"), "the native photo is untouched");
  assert.equal(g.attachments.removeImported(native.id), false, "a conversation's photo can never be removed by the importer");
  assert.equal(ledger.batches()[0]!.state, "reverted");
  const twice = revertImport(r.batch, { attachments: g.attachments, ledger });
  assert.equal(twice.alreadyReverted, true);
  assert.throws(() => revertImport("ib_0000000000000000", { attachments: g.attachments, ledger }), /No such import batch/);
});

// PR #183/#184 reviews: when the same bytes are stored twice (an imported photo later sent again in a chat), which copy the dry run,
// apply and putImported chose depended on directory or map order, so a rerun could call an imported item "imported earlier with
// different bytes". The imported copy now always wins, then the lowest id.
test("duplicates: the imported copy is chosen whatever order the store lists the copies in, in the dry run and in apply", () => {
  const sha256 = "ab".repeat(32);
  const imp = { id: `a${"9".repeat(32)}`, scope: IMPORT_SCOPE, state: "bound", sha256 };
  const chatA = { id: `a${"1".repeat(32)}`, scope: "assistant", state: "bound", sha256 };
  const chatB = { id: `a${"5".repeat(32)}`, scope: "chat:t1", state: "bound", sha256 };
  for (const order of [[chatA, imp, chatB], [imp, chatB, chatA], [chatB, chatA, imp]]) {
    const store = { withSha256: () => order.map((m) => ({ ...m })) } as any;
    assert.equal(storeIndex(store).bySha(sha256)?.id, imp.id);
    const dir = mkdtempSync(join(tmpdir(), "orbit-attachments-"));
    for (const m of order) writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m));
    assert.equal(readOnlyIndex(dir).bySha(sha256)?.id, imp.id);
  }
  // Without an imported copy: the lowest id, the same both ways.
  const store = { withSha256: () => [{ ...chatB }, { ...chatA }] } as any;
  assert.equal(storeIndex(store).bySha(sha256)?.id, chatA.id);
  const dir = mkdtempSync(join(tmpdir(), "orbit-attachments-"));
  for (const m of [chatB, chatA]) writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m));
  assert.equal(readOnlyIndex(dir).bySha(sha256)?.id, chatA.id);
});

test("duplicates: a photo imported and then sent in a conversation is still 'already imported' on a rerun, and apply finishes an orphan", async () => {
  const g = await galleryRig();
  const root = bundle([item("one", "1.jpg")], { "1.jpg": smallJpeg(111) });
  const ledger = importLedger(join(g.dir, "photo-imports"));
  const first = applyImport(planImport({ root, existing: storeIndex(g.attachments), ledger }), { root, attachments: g.attachments, ledger });
  assert.equal(first.imported.length, 1);
  // The same bytes sent in a conversation: a second, chat-scope copy with the same SHA-256.
  const stored = g.attachments.bound().find((m) => m.scope === IMPORT_SCOPE)!;
  const bytes = g.attachments.read(stored.id, IMPORT_SCOPE)!;
  const up = await fetch(`${g.base}/assistant/attachments`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(bytes) });
  assert.equal(up.status, 201);
  const chatId = ((await up.json()) as any).attachment.id as string;
  assert.equal((await g.api("/assistant/messages", "POST", { text: "the same photo again", attachments: [chatId] })).status, 200);
  const copies = g.attachments.withSha256(stored.sha256).filter((m) => m.state === "bound");
  assert.deepEqual(copies.map((m) => m.scope).sort(), ["assistant", IMPORT_SCOPE].sort(), "two stored copies of the same bytes");
  // putImported (an interrupted import's retry) reuses the imported copy, not the conversation's.
  assert.equal(g.attachments.putImported(bytes, { width: stored.width, height: stored.height }, "2026-11-27T00:00:00Z").meta.id, stored.id);
  const rerunDry = planImport({ root, existing: readOnlyIndex(join(g.dir, "attachments")), ledger });
  const rerunApply = planImport({ root, existing: storeIndex(g.attachments), ledger });
  assert.deepEqual(rerunDry.items.map((i) => i.status), ["already-imported"]);
  assert.deepEqual(rerunApply.items.map((i) => i.status), ["already-imported"]);
  assert.equal(planDigest(rerunDry), planDigest(rerunApply), "the dry run and apply describe the same plan");
});

// PR #184 review: entries that fail validation were dropped on load and then lost at the next write, despite "a damaged ledger is
// never overwritten".
test("ledger: entries that break the contract are not served, and the ledger refuses to rewrite (and lose) them", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-ledger-"));
  const ledger = importLedger(dir);
  ledger.mutate((f) => void f.batches.push({ id: "ib_0123456789abcdef", source: "openclaw", manifestSha256: "c".repeat(64), at: "2026-11-27T00:00:00Z", state: "applied", items: 0 }));
  const file = join(dir, "ledger.json");
  const x = JSON.parse(readFileSync(file, "utf8"));
  x.photos.push({ attachment: "not-an-id", ref: "?", junk: true });
  writeFileSync(file, JSON.stringify(x));
  const before = readFileSync(file, "utf8");
  const fresh = importLedger(dir);
  assert.match(fresh.problem() ?? "", /1 ledger entry broke the contract/);
  assert.equal(fresh.batches().length, 1, "the valid entries are still served");
  assert.throws(() => fresh.mutate((f) => void f.links.splice(0)), /break its contract.*nothing was changed/);
  assert.equal(readFileSync(file, "utf8"), before, "the file is left as it was");
});

test("revert: a stored file that cannot be removed is reported (the batch is already hidden), not thrown as if nothing happened", async () => {
  const g = await galleryRig();
  const root = bundle([item("r1", "1.jpg"), item("r2", "2.jpg")], { "1.jpg": smallJpeg(121), "2.jpg": smallJpeg(122) });
  const ledger = importLedger(join(g.dir, "photo-imports"));
  const r = applyImport(planImport({ root, existing: storeIndex(g.attachments), ledger }), { root, attachments: g.attachments, ledger });
  const stuck = r.imported[0]!.ref;
  const stuckId = g.attachments.bound().find((m) => photoRef(m.id) === stuck)!.id;
  const attachments = new Proxy(g.attachments, { get: (t, k) => (k === "removeImported" ? (id: string) => { if (id === stuckId) throw new Error("synthetic EACCES"); return t.removeImported(id); } : (t as any)[k]) });
  const undo = revertImport(r.batch, { attachments, ledger });
  assert.equal(undo.photosHidden, 2);
  assert.equal(undo.filesRemoved, 1);
  assert.deepEqual(undo.removeFailed, [{ ref: stuck, reason: "synthetic EACCES" }]);
  assert.equal(ledger.photos().length, 0, "the batch is hidden");
});

test("malformed manifests are refused whole, before anything is read", () => {
  const ledger = importLedger(undefined);
  const existing = readOnlyIndex(undefined);
  const bad = (manifest: string | undefined, why: RegExp) => {
    const root = mkdtempSync(join(tmpdir(), "orbit-export-bad-"));
    if (manifest !== undefined) writeFileSync(join(root, "orbit-photo-export.json"), manifest);
    assert.throws(() => planImport({ root, existing, ledger }), why);
  };
  bad(undefined, /no orbit-photo-export\.json/);
  bad("{not json", /not valid JSON/);
  bad(JSON.stringify({ format: "other/1", source: "openclaw", items: [] }), /format must be/);
  bad(JSON.stringify({ format: EXPORT_FORMAT, source: "elsewhere", items: [] }), /source must be/);
  bad(JSON.stringify({ format: EXPORT_FORMAT, source: "openclaw", items: [], transcripts: [] }), /unknown top-level/);
  bad(JSON.stringify({ format: EXPORT_FORMAT, source: "openclaw", items: {} }), /items must be a list/);
});

test("CLI: dry run by default and prints no private text; apply and revert refuse unless ORBIT is stopped and the reviewed plan matches", () => {
  const state = mkdtempSync(join(tmpdir(), "orbit-state-"));
  const root = bundle([item("cli-1", "a.jpg", { caption: "Synthetic CLI caption" })], { "a.jpg": smallJpeg(91) });
  const cli = (...a: string[]) => spawnSync(process.execPath, ["tools/photo-import/import.ts", ...a], { encoding: "utf8" });
  const dry = cli("--export", root, "--state", state);
  assert.equal(dry.status, 0, dry.stderr);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.plan.counts.importable, 1);
  assert.match(report.plan.planSha256, /^[0-9a-f]{64}$/);
  assert.match(report.next, /--reviewed-plan-sha256/);
  assert.ok(!dry.stdout.includes("Synthetic CLI caption") && !dry.stdout.includes("a.jpg") && !dry.stdout.includes(root));
  assert.deepEqual(readdirSync(state), [], "a dry run creates nothing in the state directory");
  const noStop = cli("--export", root, "--state", state, "--apply", "--reviewed-plan-sha256", report.plan.planSha256);
  assert.equal(noStop.status, 2);
  assert.match(JSON.parse(noStop.stdout).why, /stop ORBIT/);
  // The manifest hash alone no longer applies anything: the reviewed plan's digest is required.
  const manifestOnly = cli("--export", root, "--state", state, "--apply", "--reviewed-manifest-sha256", report.plan.manifestSha256, "--orbit-stopped");
  assert.equal(manifestOnly.status, 2);
  assert.match(JSON.parse(manifestOnly.stdout).why, /--reviewed-plan-sha256/);
  const wrong = cli("--export", root, "--state", state, "--apply", "--reviewed-plan-sha256", "f".repeat(64), "--orbit-stopped");
  assert.equal(wrong.status, 2);
  assert.match(JSON.parse(wrong.stdout).why, /plan changed since the reviewed dry run/);
  const wrongManifest = cli("--export", root, "--state", state, "--apply", "--reviewed-plan-sha256", report.plan.planSha256, "--reviewed-manifest-sha256", "f".repeat(64), "--orbit-stopped");
  assert.equal(wrongManifest.status, 2);
  assert.match(JSON.parse(wrongManifest.stdout).why, /manifest changed/);
  const ok = cli("--export", root, "--state", state, "--apply", "--reviewed-plan-sha256", report.plan.planSha256, "--reviewed-manifest-sha256", report.plan.manifestSha256, "--orbit-stopped");
  assert.equal(ok.status, 0, ok.stdout);
  const applied = JSON.parse(ok.stdout);
  assert.equal(applied.result.imported.length, 1);
  assert.ok(!readdirSync(join(state, "photo-imports")).includes(".import.lock"), "the lock is released");
  const undo = cli("--state", state, "--revert", applied.batch, "--orbit-stopped");
  assert.equal(undo.status, 0, undo.stdout);
  assert.equal(JSON.parse(undo.stdout).reverted.filesRemoved, 1);
  assert.equal(cli("--state", state, "--bogus").status, 2);
});

// PR #183/#184 reviews: apply was pinned only to the manifest's hash, so a photo swapped in the export folder, or a different approvals
// file, went through after the owner reviewed the dry run. Apply now refuses unless the rebuilt plan's digest is the reviewed one.
test("CLI: apply refuses, changing nothing, when a photo or the approvals changed after the reviewed dry run", () => {
  const state = mkdtempSync(join(tmpdir(), "orbit-state-"));
  const projects = vaultProjects(["Alpha", "Beta"]);
  const root = bundle([item("i1", "1.jpg", { projects: [{ project: "Projects/Alpha.md", evidence: "explicit", basis: "tag" }, { project: "Projects/Beta.md", evidence: "explicit", basis: "tag" }] }), item("i2", "2.jpg")], { "1.jpg": smallJpeg(101), "2.jpg": smallJpeg(102) });
  const cli = (...a: string[]) => spawnSync(process.execPath, ["tools/photo-import/import.ts", "--export", root, "--state", state, "--projects-dir", projects, ...a], { encoding: "utf8" });
  const manifestSha256 = sha(readFileSync(join(root, "orbit-photo-export.json")));
  const approvals = (project: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "orbit-approvals-")), "approvals.json");
    writeFileSync(f, JSON.stringify({ format: APPROVALS_FORMAT, manifestSha256, links: { i1: project } }));
    return f;
  };
  const toAlpha = approvals("Projects/Alpha.md"), toBeta = approvals("Projects/Beta.md");
  const dry = JSON.parse(cli("--approvals", toAlpha).stdout);
  const reviewed = dry.plan.planSha256;
  assert.equal(dry.plan.items.find((i: any) => i.item === "i1").link.project, "Projects/Alpha.md");
  // A different approvals file (same manifest): the link would change, so apply refuses.
  const swappedApprovals = cli("--approvals", toBeta, "--apply", "--reviewed-plan-sha256", reviewed, "--orbit-stopped");
  assert.equal(swappedApprovals.status, 2, swappedApprovals.stdout);
  assert.match(JSON.parse(swappedApprovals.stdout).why, /plan changed since the reviewed dry run/);
  assert.equal(JSON.parse(swappedApprovals.stdout).changed, false);
  // A photo's bytes replaced by another valid JPEG (same manifest, same approvals): apply refuses.
  const original = readFileSync(join(root, "1.jpg"));
  writeFileSync(join(root, "1.jpg"), smallJpeg(103));
  const swappedPhoto = cli("--approvals", toAlpha, "--apply", "--reviewed-plan-sha256", reviewed, "--orbit-stopped");
  assert.equal(swappedPhoto.status, 2, swappedPhoto.stdout);
  assert.match(JSON.parse(swappedPhoto.stdout).why, /plan changed since the reviewed dry run/);
  assert.equal(importLedger(join(state, "photo-imports")).photos().length, 0, "nothing was imported");
  assert.equal(importLedger(join(state, "photo-imports")).links().length, 0, "nothing was linked");
  // Exactly what was reviewed: it applies.
  writeFileSync(join(root, "1.jpg"), original);
  const ok = cli("--approvals", toAlpha, "--apply", "--reviewed-plan-sha256", reviewed, "--orbit-stopped");
  assert.equal(ok.status, 0, ok.stdout);
  const done = JSON.parse(ok.stdout);
  assert.equal(done.result.imported.length, 2);
  assert.deepEqual(done.result.linked.map((l: any) => [l.item, l.project]), [["i1", "Projects/Alpha.md"]]);
});

test("the gallery page's helpers: an imported photo says where it came from, project links are read-only text, backfill context is named", () => {
  const sandbox: any = { localStorage: undefined };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(new URL("../src/web/gallery.js", import.meta.url), "utf8"), sandbox);
  const G = sandbox.OrbitGallery;
  const p = G.safePhoto({ ref: `ph_${"a".repeat(32)}`, status: "ok", conversation: { kind: "import", title: "Imported from OpenClaw (legacy assistant)" }, message: null, link: "#chat/../../evil", imported: { source: "OpenClaw (legacy assistant)", item: "legacy-1", importedLocal: "2026-11-27 01:00", note: "Imported by the operator" } });
  assert.equal(p.conversation.kind, "import");
  assert.equal(p.link, "", "an unvalidated link is dropped");
  assert.equal(p.imported.item, "legacy-1");
  assert.equal(G.whereOf(p, true), "Imported from OpenClaw (legacy assistant)");
  assert.equal(G.contextOf({ conversation: { kind: "operator" } }), "operator backfill (not a conversation)");
  assert.deepEqual(JSON.parse(JSON.stringify(G.safeProjects([{ project: "Projects/Garden.md", name: "Garden", evidence: "explicit", label: "x" }, { project: "../../etc/passwd", name: "bad" }, { project: "Projects/a/b.md" }]))), [{ name: "Garden", evidence: "explicit", label: "x" }]);
});
