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
  const jpg = (id: string) => join(dir!, `${id}.jpg`);
  const rec = (id: string) => join(dir!, `${id}.json`);

  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const names = readdirSync(dir);
    for (const name of names) {
      // A temporary file left by a crash mid-write is never a stored attachment.
      if (name.endsWith(".tmp")) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // left for a person
        }
        continue;
      }
      const m = name.match(/^(a[0-9a-f]{32})\.json$/);
      if (!m) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8")) as AttachmentMeta;
        if (meta.id !== m[1] || !SCOPE.test(meta.scope) || (meta.state !== "pending" && meta.state !== "bound")) throw new Error("not an attachment record");
        if (statSync(jpg(meta.id)).size !== meta.bytes) throw new Error("its photo file is missing or has the wrong size");
        metas.set(meta.id, meta);
      } catch (err) {
        // Never deleted: left for a person to look at.
        problems.push(`${name}: ${err instanceof Error ? err.message : "unreadable"}`);
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
    // sent in a conversation. Returns whether something was removed.
    removeImported(id: string): boolean {
      const m = isAttachmentId(id) ? metas.get(id) : undefined;
      if (!m || m.scope !== IMPORT_SCOPE) return false;
      remove(id);
      return true;
    },

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
