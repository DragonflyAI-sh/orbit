import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./threads.ts";

// Private photo attachments (docs/photos.md). One processed JPEG per attachment in <state>/attachments/, beside a small JSON record.
// Never under the repository, the vault or a public static directory, and never served without the owner check and a scope check.
//
// Lifecycle: an upload is stored `pending` in one conversation scope ("assistant" or "chat:<thread uuid>"). Sending a message binds
// its attachments (all or none) to that message: `bound` attachments are kept as long as the conversation, are never bound again
// and never deleted by cleanup. A pending upload nobody sent is deleted after PENDING_TTL_MS. Only processed bytes reach here: the
// route stores what src/jpeg.ts rebuilt, never the request body itself.

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
// Uploads waiting to be sent, per conversation. A batch is at most 10; the slack allows retries and a second draft.
export const MAX_PENDING_PER_SCOPE = 30;
// Unsent uploads older than this are deleted by cleanup. Bound attachments are never deleted by cleanup.
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
// All stored attachments together. New uploads are refused (nothing is evicted) once this is reached.
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const ID = /^a[0-9a-f]{32}$/;
export const isAttachmentId = (s: unknown): s is string => typeof s === "string" && ID.test(s);
// IMPORT_SCOPE: photos brought in by the operator-run legacy importer (docs/photo-import-backfill.md). They are never a conversation's
// photos: they are stored bound (never pending, so cleanup never deletes them), only the Assistant's reach can read them
// (src/photo-access.ts photoPolicy), and their provenance lives in the import ledger (src/photo-import-ledger.ts), not in any message.
export const IMPORT_SCOPE = "import";
const SCOPE = /^(assistant|import|chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type AttachmentState = "pending" | "bound";
export type AttachmentMeta = {
  id: string;
  scope: string;
  state: AttachmentState;
  type: "image/jpeg";
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
  boundAt?: string;
};
// What a stored message keeps of each attachment: the id and safe facts, never the bytes.
export type AttachmentRef = { id: string; type: "image/jpeg"; bytes: number; width: number; height: number };
export const refOf = (m: AttachmentMeta): AttachmentRef => ({ id: m.id, type: m.type, bytes: m.bytes, width: m.width, height: m.height });

export class AttachmentError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function writeBytesAtomic(file: string, data: Buffer): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing left to clean
    }
    throw err;
  }
}

// ---- reading the records ---------------------------------------------------------------------------------------------------------
// One attachment record that cannot be used: the record's file name (an opaque random id, never a path, caption or byte of its
// content) and a fixed reason. The store skips it (never deletes it); the importer refuses to plan or apply while any exist, because
// such a record may hold the very bytes it would otherwise store a second time (docs/photo-import-backfill.md).
export type DamagedReason = "unreadable" | "not-json" | "not-an-attachment-record" | "photo-file-missing" | "photo-file-unreadable" | "photo-file-wrong-size";
export type DamagedRecord = { record: string; reason: DamagedReason };
export const DAMAGED_REASON_TEXT: Record<DamagedReason, string> = {
  unreadable: "the record file cannot be read",
  "not-json": "the record is not valid JSON",
  "not-an-attachment-record": "the record does not have the fields of an attachment record",
  "photo-file-missing": "its photo file is missing",
  "photo-file-unreadable": "its photo file cannot be checked",
  "photo-file-wrong-size": "its photo file has the wrong size",
};
const code = (err: unknown) => (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string" ? ((err as { code: string }).code).slice(0, 20) : "unknown");

// Every record in an attachment directory, checked exactly as the store checks them when it opens, WITHOUT changing anything (no
// temporary file or orphan is tidied). The store's own start and the importer's read-only dry run both use this, so they always agree
// on which stored photos exist and which records are damaged. A missing directory is an empty store; any other failure to list it is
// `ok: false` with the error code only (never a path).
export function scanAttachmentRecords(dir: string): { ok: true; names: string[]; metas: AttachmentMeta[]; damaged: DamagedRecord[] } | { ok: false; code: string } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (code(err) === "ENOENT") return { ok: true, names: [], metas: [], damaged: [] };
    return { ok: false, code: code(err) };
  }
  names.sort();
  const metas: AttachmentMeta[] = [];
  const damaged: DamagedRecord[] = [];
  for (const name of names) {
    const m = name.match(/^(a[0-9a-f]{32})\.json$/);
    if (!m) continue;
    const bad = (reason: DamagedReason) => damaged.push({ record: name, reason });
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      bad("unreadable");
      continue;
    }
    let meta: AttachmentMeta;
    try {
      meta = JSON.parse(text) as AttachmentMeta;
    } catch {
      bad("not-json");
      continue;
    }
    if (!validRecord(meta, m[1]!)) {
      bad("not-an-attachment-record");
      continue;
    }
    let size: number;
    try {
      size = statSync(join(dir, `${meta.id}.jpg`)).size;
    } catch (err) {
      bad(code(err) === "ENOENT" ? "photo-file-missing" : "photo-file-unreadable");
      continue;
    }
    if (size !== meta.bytes) {
      bad("photo-file-wrong-size");
      continue;
    }
    metas.push(meta);
  }
  return { ok: true, names, metas, damaged };
}
function validRecord(x: unknown, id: string): x is AttachmentMeta {
  const m = x as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  if (m.id !== id || typeof m.scope !== "string" || !SCOPE.test(m.scope) || (m.state !== "pending" && m.state !== "bound")) return false;
  return typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) && Number.isInteger(m.bytes) && (m.bytes as number) > 0;
}

// What removeImported did: `removed` (its files are gone now), `not-stored` (no record and no photo file: already removed),
// `not-imported` (an attachment of a conversation, never removed by the importer), `damaged` (its record is on disk but could not be
// read when the store opened: left for the operator, never deleted).
export type RemoveImportedResult = "removed" | "not-stored" | "not-imported" | "damaged";

export type Attachments = ReturnType<typeof attachmentStore>;

// `dir` undefined keeps attachments in memory (tests, or a service without a state directory) and says so through `persisted`.
export function attachmentStore(dir: string | undefined, opts: { now?: () => Date; pendingTtlMs?: number; maxTotalBytes?: number; maxPendingPerScope?: number } = {}) {
  const now = opts.now ?? (() => new Date());
  const ttl = opts.pendingTtlMs ?? PENDING_TTL_MS;
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxPending = opts.maxPendingPerScope ?? MAX_PENDING_PER_SCOPE;
  const metas = new Map<string, AttachmentMeta>();
  const memBytes = new Map<string, Buffer>();
  const problems: string[] = [];
  const damaged: DamagedRecord[] = [];
  const jpg = (id: string) => join(dir!, `${id}.jpg`);
  const rec = (id: string) => join(dir!, `${id}.json`);

  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const scan = scanAttachmentRecords(dir);
    if (!scan.ok) throw new AttachmentError(500, `The attachment directory cannot be read (${scan.code}).`);
    for (const m of scan.metas) metas.set(m.id, m);
    // Never deleted: left for a person to look at.
    for (const d of scan.damaged) {
      damaged.push(d);
      problems.push(`${d.record}: ${DAMAGED_REASON_TEXT[d.reason]}`);
    }
    const names = scan.names;
    for (const name of names) {
      // A temporary file left by a crash mid-write is never a stored attachment.
      if (name.endsWith(".tmp")) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // left for a person
        }
      }
    }
    // A photo file without a record was written by an upload that stopped before its record: it was never usable. Removed once old.
    for (const name of names) {
      const m = name.match(/^(a[0-9a-f]{32})\.jpg$/);
      if (!m || metas.has(m[1]!) || names.includes(`${m[1]}.json`)) continue;
      try {
        if (now().getTime() - statSync(join(dir, name)).mtimeMs > ttl) unlinkSync(join(dir, name));
      } catch {
        // left for a person
      }
    }
  }

  const totalBytes = () => [...metas.values()].reduce((n, m) => n + m.bytes, 0);
  const persistMeta = (m: AttachmentMeta) => {
    if (dir) writeAtomic(rec(m.id), JSON.stringify(m, null, 2));
  };
  const remove = (id: string) => {
    metas.delete(id);
    memBytes.delete(id);
    if (!dir) return;
    // The record goes first: a photo file without a record is never served and is removed later.
    for (const f of [rec(id), jpg(id)]) {
      try {
        unlinkSync(f);
      } catch {
        // already gone
      }
    }
  };

  const store = {
    persisted: Boolean(dir),
    problems: () => [...problems],

    // Imported legacy photos (docs/photo-import-backfill.md): processed bytes (from src/jpeg.ts, exactly as an upload) stored directly as
    // bound in IMPORT_SCOPE at `at`. The same bytes already stored anywhere (an earlier import, or a photo Rai sent in a conversation)
    // are never stored twice: the existing attachment is returned with `reused: true` and nothing is written. The storage bound applies.
    putImported(bytes: Buffer, facts: { width: number; height: number }, at: string): { meta: AttachmentMeta; reused: boolean } {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // An imported copy first (an interrupted import's photo is then finished, even when the same bytes were also sent in a
      // conversation), else a copy bound in a conversation; the lowest id when there are several, so the choice never depends on order.
      const byId = (a: AttachmentMeta, b: AttachmentMeta) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const copies = [...metas.values()].filter((m) => m.sha256 === sha256).sort(byId);
      const same = copies.find((m) => m.scope === IMPORT_SCOPE) ?? copies.find((m) => m.state === "bound");
      if (same) return { meta: { ...same }, reused: true };
      if (totalBytes() + bytes.length > maxTotal) throw new AttachmentError(507, "ORBIT's photo storage is full. Nothing was stored.");
      const meta: AttachmentMeta = { id: `a${randomBytes(16).toString("hex")}`, scope: IMPORT_SCOPE, state: "bound", type: "image/jpeg", bytes: bytes.length, width: facts.width, height: facts.height, sha256, createdAt: at, boundAt: at };
      if (dir) {
        writeBytesAtomic(jpg(meta.id), bytes);
        try {
          persistMeta(meta);
        } catch (err) {
          try {
            unlinkSync(jpg(meta.id));
          } catch {
            // removed at the next start
          }
          throw err;
        }
      } else memBytes.set(meta.id, Buffer.from(bytes));
      metas.set(meta.id, meta);
      return { meta: { ...meta }, reused: false };
    },

    // Reverses one imported photo (the importer's rollback): only an attachment in IMPORT_SCOPE can be removed this way, never a photo
    // sent in a conversation. Unlike cleanup, a file that cannot be removed is never taken as removed: any error other than "not found"
    // throws an AttachmentError (the error code only, never a path), and the attachment is then left as it was, so a later call can
    // retry it. The record goes first (a photo file without its record is never served); if the photo file then cannot be removed, the
    // record is written back. Idempotent: a call for files already gone is `not-stored`.
    removeImported(id: string): RemoveImportedResult {
      if (!isAttachmentId(id)) return "not-stored";
      const m = metas.get(id);
      if (m && m.scope !== IMPORT_SCOPE) return "not-imported";
      if (!dir) {
        if (!m) return "not-stored";
        metas.delete(id);
        memBytes.delete(id);
        return "removed";
      }
      const gone = (f: string): boolean => {
        try {
          unlinkSync(f);
          return true;
        } catch (err) {
          if (code(err) === "ENOENT") return false;
          throw err;
        }
      };
      if (!m) {
        // Not loaded: either removed already, or its record is damaged (left for the operator), or a photo file whose record went
        // earlier (an interrupted removal): such a file is never served, and it is removed now.
        let text: string | undefined;
        try {
          text = readFileSync(rec(id), "utf8");
        } catch (err) {
          if (code(err) !== "ENOENT") return "damaged";
        }
        if (text !== undefined) {
          // A record on disk that the store did not load. Only one that is still a valid IMPORT_SCOPE record (its photo file missing
          // or the wrong size: a removal interrupted half way) is removed; anything else is left for the operator.
          let x: unknown;
          try {
            x = JSON.parse(text);
          } catch {
            return "damaged";
          }
          if (!validRecord(x, id) || x.scope !== IMPORT_SCOPE) return "damaged";
          try {
            gone(rec(id));
          } catch (err) {
            throw new AttachmentError(500, `The stored record could not be removed (${code(err)}); nothing was removed.`);
          }
        }
        try {
          return gone(jpg(id)) || text !== undefined ? "removed" : "not-stored";
        } catch (err) {
          throw new AttachmentError(500, `The photo file could not be removed (${code(err)})${text !== undefined ? "; its record is removed, so it is never served, and a retry removes it" : "; nothing was removed"}.`);
        }
      }
      try {
        gone(rec(id));
      } catch (err) {
        throw new AttachmentError(500, `The stored record could not be removed (${code(err)}); nothing was removed.`);
      }
      try {
        gone(jpg(id));
      } catch (err) {
        try {
          persistMeta(m);
        } catch {
          // The record is gone and the photo file stayed: it is never served, and the next call (or the store's next start, once it
          // is old) removes it.
          metas.delete(id);
          throw new AttachmentError(500, `The photo file could not be removed (${code(err)}) and its record could not be restored; the file is never served and a retry removes it.`);
        }
        throw new AttachmentError(500, `The photo file could not be removed (${code(err)}); nothing was removed.`);
      }
      metas.delete(id);
      return "removed";
    },

    // The records that could not be read when the store opened (src/attachments.ts scanAttachmentRecords), as safe facts.
    damaged: (): DamagedRecord[] => damaged.map((d) => ({ ...d })),

    // Every stored attachment with these exact bytes (any scope or state), as safe records: the importer's duplicate check.
    withSha256(sha256: string): AttachmentMeta[] {
      return [...metas.values()].filter((m) => m.sha256 === sha256).map((m) => ({ ...m }));
    },

    // Stores processed bytes (from src/jpeg.ts) pending in `scope`. The same photo uploaded again into the same scope while still
    // pending (a retry after a lost answer) returns the existing attachment instead of a second copy.
    put(scope: string, bytes: Buffer, facts: { width: number; height: number }): { meta: AttachmentMeta; reused: boolean } {
      if (!SCOPE.test(scope) || scope === IMPORT_SCOPE) throw new AttachmentError(400, "Unknown conversation.");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const same = [...metas.values()].find((m) => m.scope === scope && m.state === "pending" && m.sha256 === sha256);
      if (same) return { meta: { ...same }, reused: true };
      store.cleanup();
      if ([...metas.values()].filter((m) => m.scope === scope && m.state === "pending").length >= maxPending) throw new AttachmentError(429, `Too many unsent photos in this conversation (${maxPending}). Send or remove some first; unsent photos are deleted after ${Math.round(ttl / 3_600_000)} hours.`);
      if (totalBytes() + bytes.length > maxTotal) throw new AttachmentError(507, "ORBIT's photo storage is full. Nothing was stored.");
      const meta: AttachmentMeta = { id: `a${randomBytes(16).toString("hex")}`, scope, state: "pending", type: "image/jpeg", bytes: bytes.length, width: facts.width, height: facts.height, sha256, createdAt: now().toISOString() };
      if (dir) {
        writeBytesAtomic(jpg(meta.id), bytes);
        try {
          persistMeta(meta);
        } catch (err) {
          try {
            unlinkSync(jpg(meta.id));
          } catch {
            // removed at the next start
          }
          throw err;
        }
      } else memBytes.set(meta.id, Buffer.from(bytes));
      metas.set(meta.id, meta);
      return { meta: { ...meta }, reused: false };
    },

    get(id: string): AttachmentMeta | undefined {
      const m = isAttachmentId(id) ? metas.get(id) : undefined;
      return m ? { ...m } : undefined;
    },

    // The bytes of an attachment, only when it belongs to `scope`. Undefined for an unknown id, another conversation's attachment,
    // or a file that cannot be read: the caller cannot tell these apart, so nothing about other conversations leaks.
    read(id: string, scope: string): Buffer | undefined {
      const m = store.get(id);
      if (!m || m.scope !== scope) return undefined;
      if (!dir) return memBytes.get(id);
      try {
        const b = readFileSync(jpg(id));
        return b.length === m.bytes ? b : undefined;
      } catch {
        return undefined;
      }
    },

    // Whether the photo file of an attachment of `scope` is there with its recorded size (a cheap check for a page view; the image
    // route itself loads and verifies the SHA-256 with load()).
    present(id: string, scope: string): boolean {
      const m = store.get(id);
      if (!m || m.scope !== scope) return false;
      if (!dir) return memBytes.has(id);
      try {
        return statSync(jpg(id)).size === m.bytes;
      } catch {
        return false;
      }
    },

    // The bytes of an attachment of `scope` with the reason when they cannot be used (src/photo-access.ts): `missing` (no record in
    // this scope, or the file is gone or has the wrong size) or `corrupt` (the file no longer matches the SHA-256 recorded when it was
    // stored). The caller decides what to reveal; this never says which conversation an id belongs to.
    load(id: string, scope: string): { ok: true; bytes: Buffer; meta: AttachmentMeta } | { ok: false; reason: "missing" | "corrupt" } {
      const m = store.get(id);
      if (!m || m.scope !== scope) return { ok: false, reason: "missing" };
      const b = store.read(id, scope);
      if (!b) return { ok: false, reason: "missing" };
      if (createHash("sha256").update(b).digest("hex") !== m.sha256) return { ok: false, reason: "corrupt" };
      return { ok: true, bytes: b, meta: m };
    },

    // Every attachment already sent with a message (state bound), as safe records (no bytes). For photo discovery, which applies the
    // caller's own scope policy (src/photo-access.ts); pending uploads are never listed.
    bound(): AttachmentMeta[] {
      return [...metas.values()].filter((m) => m.state === "bound").map((m) => ({ ...m }));
    },

    // Binds attachments to a message, all or none. Each must exist in `scope` and still be pending: one from another conversation is
    // "not found" (404), one already sent with a message is refused (409), so an id can never be reused in another message or context.
    bind(ids: unknown, scope: string): AttachmentRef[] {
      if (ids === undefined || ids === null) return [];
      if (!Array.isArray(ids)) throw new AttachmentError(400, "attachments must be a list of photo ids.");
      if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new AttachmentError(400, `At most ${MAX_ATTACHMENTS_PER_MESSAGE} photos per message (got ${ids.length}). Nothing was sent.`);
      if (!ids.every(isAttachmentId)) throw new AttachmentError(400, "attachments must be photo ids returned by the upload route.");
      if (new Set(ids).size !== ids.length) throw new AttachmentError(400, "The same photo is listed twice.");
      const found = ids.map((id) => metas.get(id));
      if (found.some((m) => !m || m.scope !== scope)) throw new AttachmentError(404, "A photo was not found in this conversation (it may have expired). Nothing was sent; attach it again.");
      if (found.some((m) => m!.state !== "pending")) throw new AttachmentError(409, "A photo was already sent with another message and cannot be sent again. Nothing was sent; attach it again.");
      const at = now().toISOString();
      const done: AttachmentMeta[] = [];
      try {
        for (const m of found) {
          const next: AttachmentMeta = { ...m!, state: "bound", boundAt: at };
          persistMeta(next);
          metas.set(next.id, next);
          done.push(m!);
        }
      } catch (err) {
        // A failed write binds nothing: the ones already written go back to pending.
        for (const m of done) {
          try {
            persistMeta(m);
          } catch {
            // left bound: kept, never deleted, only unusable for another message
          }
          metas.set(m.id, m);
        }
        throw err;
      }
      return found.map((m) => refOf(metas.get(m!.id)!));
    },

    // Undoes a bind whose message was never stored (the turn was refused before writing it), so the photos can be sent again.
    release(ids: string[], scope: string): void {
      for (const id of ids) {
        const m = metas.get(id);
        if (!m || m.scope !== scope || m.state !== "bound") continue;
        const next: AttachmentMeta = { ...m, state: "pending" };
        delete next.boundAt;
        try {
          persistMeta(next);
          metas.set(id, next);
        } catch {
          // stays bound: kept, never deleted
        }
      }
    },

    // Deletes pending uploads older than the TTL. Bound attachments are never touched. Returns how many were deleted.
    cleanup(): number {
      const cut = now().getTime() - ttl;
      let n = 0;
      for (const m of [...metas.values()]) {
        if (m.state === "pending" && Date.parse(m.createdAt) < cut) {
          remove(m.id);
          n++;
        }
      }
      return n;
    },

    stats: () => {
      const all = [...metas.values()];
      return { count: all.length, pending: all.filter((m) => m.state === "pending").length, bytes: totalBytes(), maxBytes: maxTotal };
    },
  };
  return store;
}
