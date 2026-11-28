import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isAttachmentId } from "./attachments.ts";
import { isPhotoRef } from "./photo-ref.ts";
import { untrustedText } from "./sessions.ts";
import { maskContent, writeAtomic } from "./threads.ts";

// The import ledger (docs/photo-import-backfill.md): the provenance of photos the operator-run legacy importer brought into ORBIT, the
// import batches (for safe retries and rollback), and the narrowly scoped photo-to-project links the importer assigned from explicit or
// operator-approved evidence. One JSON file, <state>/photo-imports/ledger.json, written atomically (temp file, fsync, rename) with mode
// 0600 by the host-local importer only (tools/photo-import/import.ts, run while ORBIT is stopped). The server only reads it.
//
// What it holds per imported photo is the minimum the gallery needs to say where the photo came from: the legacy source name, the
// manifest item id, the legacy send time, a short caption (masked, flattened, bounded), opaque session and message pointers, the batch
// and the import time. Never a file path, a transcript, a URL, image data or anything from the source beyond those fields.
//
// Project links are an association between a photo ref and a vault project note path (Projects/<name>.md). They are not written into
// the vault and never change a project file: the gallery shows them read-only.

export const IMPORT_LEDGER_CONTRACT = "orbit-photo-import-ledger/1";
export const IMPORT_SOURCES = ["openclaw"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const SOURCE_LABEL: Record<ImportSource, string> = { openclaw: "OpenClaw (legacy assistant)" };
export const IMPORT_CAPTION_MAX = 280;
export const POINTER = /^[A-Za-z0-9_.:-]{1,128}$/;
export const ITEM_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
export const BATCH_ID = /^ib_[0-9a-f]{16}$/;
export const PROJECT_PATH = /^Projects\/[^/\\\u0000-\u001f]{1,120}\.md$/;
export const LINK_EVIDENCE = ["explicit", "operator-approved"] as const;
export type LinkEvidence = (typeof LINK_EVIDENCE)[number];
const LEDGER_BYTES_MAX = 8 * 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export type ImportedPhoto = {
  attachment: string;
  ref: string;
  source: ImportSource;
  item: string;
  batch: string;
  // When Rai sent it in the legacy assistant (the manifest's time), and when ORBIT imported it.
  sentAt: string;
  importedAt: string;
  caption: string;
  pointers: { session?: string; message?: string };
};
// `unremoved`: after a revert, the stored copies (attachment ids) whose files could not be removed yet. They are hidden (no ledger
// entry), and a revert of the same batch again retries exactly these (docs/photo-import-backfill.md, Reverse).
export type ImportBatch = { id: string; source: ImportSource; manifestSha256: string; at: string; state: "applied" | "reverted"; revertedAt?: string; items: number; unremoved?: string[] };
export const UNREMOVED_MAX = 10_000;
export type ProjectLink = { ref: string; project: string; evidence: LinkEvidence; batch: string; item: string; at: string };
type LedgerFile = { v: 1; contract: string; rev: number; photos: ImportedPhoto[]; batches: ImportBatch[]; links: ProjectLink[] };

// A caption from an export: flattened, bounded and masked for secret-shaped values, as stored message text is.
export const importCaption = (s: unknown): string => (typeof s === "string" ? maskContent(untrustedText(s, IMPORT_CAPTION_MAX).text) : "");

function safePhoto(v: unknown): ImportedPhoto | undefined {
  const p = v as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return undefined;
  const ptr = (p.pointers ?? {}) as Record<string, unknown>;
  if (!isAttachmentId(p.attachment) || !isPhotoRef(p.ref) || !IMPORT_SOURCES.includes(p.source as ImportSource)) return undefined;
  if (typeof p.item !== "string" || !ITEM_ID.test(p.item) || typeof p.batch !== "string" || !BATCH_ID.test(p.batch)) return undefined;
  if (typeof p.sentAt !== "string" || !ISO.test(p.sentAt) || typeof p.importedAt !== "string" || !ISO.test(p.importedAt) || typeof p.caption !== "string" || p.caption.length > IMPORT_CAPTION_MAX) return undefined;
  for (const k of ["session", "message"]) if (ptr[k] !== undefined && (typeof ptr[k] !== "string" || !POINTER.test(ptr[k] as string))) return undefined;
  return {
    attachment: p.attachment,
    ref: p.ref,
    source: p.source as ImportSource,
    item: p.item,
    batch: p.batch,
    sentAt: p.sentAt,
    importedAt: p.importedAt,
    caption: p.caption,
    pointers: { ...(ptr.session ? { session: ptr.session as string } : {}), ...(ptr.message ? { message: ptr.message as string } : {}) },
  };
}
function safeLink(v: unknown): ProjectLink | undefined {
  const l = v as Record<string, unknown> | undefined;
  if (!l || typeof l !== "object" || !isPhotoRef(l.ref) || typeof l.project !== "string" || !PROJECT_PATH.test(l.project) || !LINK_EVIDENCE.includes(l.evidence as LinkEvidence)) return undefined;
  if (typeof l.batch !== "string" || !BATCH_ID.test(l.batch) || typeof l.item !== "string" || !ITEM_ID.test(l.item) || typeof l.at !== "string" || !ISO.test(l.at)) return undefined;
  return { ref: l.ref, project: l.project, evidence: l.evidence as LinkEvidence, batch: l.batch, item: l.item, at: l.at };
}
function safeBatch(v: unknown): ImportBatch | undefined {
  const b = v as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object" || typeof b.id !== "string" || !BATCH_ID.test(b.id) || !IMPORT_SOURCES.includes(b.source as ImportSource)) return undefined;
  if (typeof b.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.manifestSha256) || typeof b.at !== "string" || !ISO.test(b.at) || (b.state !== "applied" && b.state !== "reverted") || !Number.isInteger(b.items)) return undefined;
  if (b.revertedAt !== undefined && (typeof b.revertedAt !== "string" || !ISO.test(b.revertedAt))) return undefined;
  if (b.unremoved !== undefined && (b.state !== "reverted" || !Array.isArray(b.unremoved) || b.unremoved.length > UNREMOVED_MAX || !b.unremoved.every(isAttachmentId) || new Set(b.unremoved).size !== b.unremoved.length)) return undefined;
  const unremoved = Array.isArray(b.unremoved) && b.unremoved.length ? { unremoved: [...(b.unremoved as string[])] } : {};
  return { id: b.id, source: b.source as ImportSource, manifestSha256: b.manifestSha256, at: b.at, state: b.state, items: b.items as number, ...(b.revertedAt ? { revertedAt: b.revertedAt as string } : {}), ...unremoved };
}

export type ImportLedger = ReturnType<typeof importLedger>;

// `dir` undefined keeps the ledger in memory (tests, or a service without a state directory). The server reads the file again when its
// size or modification time changes, so a restart is not needed for a read, though the attachment store itself is only read at start.
export function importLedger(dir: string | undefined) {
  const file = dir ? join(dir, "ledger.json") : undefined;
  let mem: LedgerFile = { v: 1, contract: IMPORT_LEDGER_CONTRACT, rev: 0, photos: [], batches: [], links: [] };
  let seen: string | undefined;
  let problem: string | undefined;
  // photo() is called for every imported photo of a gallery listing: one stat per call, and a map instead of a scan.
  let byAttachment = new Map<string, ImportedPhoto>();
  const index = () => (byAttachment = new Map(mem.photos.map((p) => [p.attachment, p])));
  // Nothing is created until the first write, so reading a state directory (a dry run) changes nothing in it.
  const load = (): LedgerFile => {
    if (!file) return mem;
    let st;
    try {
      st = statSync(file);
    } catch {
      problem = undefined;
      seen = undefined;
      mem = { v: 1, contract: IMPORT_LEDGER_CONTRACT, rev: 0, photos: [], batches: [], links: [] };
      index();
      return mem;
    }
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (stamp === seen) return mem;
    seen = stamp;
    try {
      // Fixed reasons only: a parser's message can quote the file's content (captions), which never belongs in a report.
      if (st.size > LEDGER_BYTES_MAX) throw new Error("the ledger is over its size bound");
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        throw new Error("the ledger file cannot be read");
      }
      let x: Partial<LedgerFile>;
      try {
        x = JSON.parse(text) as Partial<LedgerFile>;
      } catch {
        throw new Error("the ledger is not valid JSON");
      }
      if (!x || typeof x !== "object" || x.v !== 1 || x.contract !== IMPORT_LEDGER_CONTRACT || !Number.isInteger(x.rev) || !Array.isArray(x.photos) || !Array.isArray(x.batches) || !Array.isArray(x.links)) throw new Error("not an import ledger");
      const photos = x.photos.map(safePhoto).filter((p): p is ImportedPhoto => Boolean(p));
      const batches = x.batches.map(safeBatch).filter((b): b is ImportBatch => Boolean(b));
      const links = x.links.map(safeLink).filter((l): l is ProjectLink => Boolean(l));
      const dropped = x.photos.length - photos.length + x.batches.length - batches.length + x.links.length - links.length;
      problem = dropped ? `${dropped} ledger entr${dropped === 1 ? "y" : "ies"} broke the contract and are not served` : undefined;
      mem = { v: 1, contract: IMPORT_LEDGER_CONTRACT, rev: x.rev as number, photos, batches, links };
      index();
    } catch (err) {
      // Unreadable: nothing imported is visible and writes refuse, so the file is left for the operator to look at.
      problem = `the import ledger is unreadable (${err instanceof Error ? err.message : "unknown"}); imported photos are not shown`;
      mem = { v: 1, contract: IMPORT_LEDGER_CONTRACT, rev: -1, photos: [], batches: [], links: [] };
      index();
    }
    return mem;
  };
  return {
    persisted: Boolean(dir),
    problem: () => (load(), problem),
    // The provenance of one imported attachment, or undefined (never imported, or reverted).
    photo(attachmentId: string): ImportedPhoto | undefined {
      load();
      const p = byAttachment.get(attachmentId);
      return p ? { ...p, pointers: { ...p.pointers } } : undefined;
    },
    photos: (): ImportedPhoto[] => structuredClone(load().photos),
    batches: (): ImportBatch[] => structuredClone(load().batches),
    links: (): ProjectLink[] => structuredClone(load().links),
    // The project links of one photo ref, deduplicated by project.
    linksOf(ref: string): ProjectLink[] {
      const out = new Map<string, ProjectLink>();
      for (const l of load().links) if (l.ref === ref && !out.has(l.project)) out.set(l.project, { ...l });
      return [...out.values()];
    },
    // One atomic change (importer only). Refused when the file on disk is unreadable, or when some of its entries broke the contract
    // (they are not served, and rewriting would drop them for good), so a damaged ledger is never overwritten.
    mutate<T>(change: (f: { photos: ImportedPhoto[]; batches: ImportBatch[]; links: ProjectLink[] }) => T): T {
      const cur = load();
      if (cur.rev < 0) throw new Error("The import ledger is unreadable, so nothing was changed. It is left as it is for the operator to look at.");
      if (problem) throw new Error(`The import ledger has entries that break its contract (${problem}), so nothing was changed: rewriting it would lose them. It is left as it is for the operator to look at.`);
      const next = structuredClone({ photos: cur.photos, batches: cur.batches, links: cur.links });
      const result = change(next);
      const photos = next.photos.map(safePhoto);
      const batches = next.batches.map(safeBatch);
      const links = next.links.map(safeLink);
      if (photos.some((p) => !p) || batches.some((b) => !b) || links.some((l) => !l)) throw new Error("A ledger entry broke the import contract, so nothing was saved.");
      const out: LedgerFile = { v: 1, contract: IMPORT_LEDGER_CONTRACT, rev: cur.rev + 1, photos: photos as ImportedPhoto[], batches: batches as ImportBatch[], links: links as ProjectLink[] };
      const text = JSON.stringify(out, null, 1);
      if (Buffer.byteLength(text) > LEDGER_BYTES_MAX) throw new Error("The import ledger would exceed its size bound, so nothing was saved.");
      if (file) {
        mkdirSync(dir!, { recursive: true, mode: 0o700 });
        writeAtomic(file, text);
        seen = undefined;
      } else {
        mem = out;
        index();
      }
      load();
      return result;
    },
  };
}
