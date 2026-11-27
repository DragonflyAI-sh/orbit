import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { IMPORT_SCOPE } from "./attachments.ts";
import type { Attachments } from "./attachments.ts";
import { normalizeJpeg, sniff } from "./jpeg.ts";
import { photoRef } from "./photo-access.ts";
import { BATCH_ID, IMPORT_SOURCES, importCaption, ITEM_ID, LINK_EVIDENCE, POINTER, PROJECT_PATH } from "./photo-import-ledger.ts";
import type { ImportLedger, ImportSource, LinkEvidence } from "./photo-import-ledger.ts";

// The operator-run legacy photo importer (docs/photo-import-backfill.md). It reads ONE documented, allowlisted export bundle on the
// ORBIT host (a directory holding orbit-photo-export.json and the photo files it names), never a transcript, a URL or anything outside that
// directory, and plans what it would import. A plan is a dry run: it changes nothing. Applying a reviewed plan stores each importable
// photo through the same JPEG check and normalization an upload gets (src/jpeg.ts: signature, structure, size and dimension bounds,
// every metadata segment dropped), as a private bound attachment in IMPORT_SCOPE (src/attachments.ts), and records its provenance and
// any explicit or operator-approved project link in the import ledger (src/photo-import-ledger.ts). The export itself is only read.
//
// Project links are never inferred: an item is linked only to a project its export entry names with explicit evidence, or that the
// operator approved for it in a reviewed approvals file, and only when that project's hub note exists. Anything else (several
// explicit projects, unconfirmed candidates, an unknown project) is reported for review and left unlinked.

export const EXPORT_FORMAT = "orbit-legacy-photo-export/1";
export const APPROVALS_FORMAT = "orbit-legacy-photo-approvals/1";
export const MANIFEST_NAME = "orbit-photo-export.json";
export const MANIFEST_BYTES_MAX = 4 * 1024 * 1024;
export const APPROVALS_BYTES_MAX = 1024 * 1024;
export const ITEMS_MAX = 5000;
// A source file larger than this is refused before it is read. Whatever its size, only a JPEG that passes the upload bounds after
// normalization (at most 1 MiB, 1600 px, 2.56 MP) is stored: the host has no image decoder, so larger photos must be converted first.
export const SOURCE_FILE_BYTES_MAX = 16 * 1024 * 1024;
export const PROJECTS_PER_ITEM_MAX = 8;
const FILE_EXT = /\.(jpe?g)$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ITEM_KEYS = ["id", "file", "sentAt", "sender", "caption", "session", "message", "projects", "projectCandidates"];
const TOP_KEYS = ["format", "source", "exportedAt", "items"];

export type ItemStatus = "importable" | "already-imported" | "already-present" | "duplicate-in-export" | "missing" | "rejected";
export type LinkStatus = "linked" | "none" | "ambiguous" | "unmatched" | "unverified" | "declined";
export type PlannedLink = { status: LinkStatus; project?: string; evidence?: LinkEvidence; candidates?: string[]; reason?: string };
export type PlannedItem = {
  item: string;
  status: ItemStatus;
  reason?: string;
  // For importable and duplicate items: the normalized bytes' SHA-256 (what would be stored) and the photo ref it is or would be.
  sha256?: string;
  ref?: string;
  link: PlannedLink;
  // Kept for apply only; never printed (src/photo-import.ts reportOf).
  file?: string;
  sentAt?: string;
  caption?: string;
  pointers?: { session?: string; message?: string };
};
export type ImportPlan = {
  format: typeof EXPORT_FORMAT;
  source: ImportSource;
  manifestSha256: string;
  approvalsSha256?: string;
  items: PlannedItem[];
  counts: Record<ItemStatus, number> & { links: Record<LinkStatus, number> };
};

export class ImportError extends Error {}

// ---- reading inside the export root only ----------------------------------------------------------------------------------------------
// The export root, resolved once. Every file the importer reads must resolve (symlinks followed) to a regular file strictly inside it.
export function exportRoot(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new ImportError("The export directory does not exist or cannot be read.");
  }
  if (!statSync(real).isDirectory()) throw new ImportError("The export path is not a directory.");
  return real;
}
export type Confined = { ok: true; path: string; bytes: number } | { ok: false; status: "missing" | "rejected"; reason: string };
export function confinedFile(root: string, rel: unknown): Confined {
  if (typeof rel !== "string" || !rel || rel.length > 240) return { ok: false, status: "rejected", reason: "file: a relative path of at most 240 characters is required" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return { ok: false, status: "rejected", reason: "file: URLs are never fetched; give a path inside the export" };
  if (isAbsolute(rel) || rel.includes("\\") || /[\u0000-\u001f]/.test(rel) || rel.split("/").some((p) => p === ".." || p === "." || p === "")) return { ok: false, status: "rejected", reason: "file: must be a plain relative path inside the export (no absolute path, '..', '.', empty part or backslash)" };
  if (!FILE_EXT.test(rel)) return { ok: false, status: "rejected", reason: "file: only .jpg or .jpeg files are imported; convert other formats to JPEG first" };
  const joined = join(root, rel);
  try {
    lstatSync(joined);
  } catch {
    return { ok: false, status: "missing", reason: "the file named by the export is not there (missing or expired)" };
  }
  let real: string;
  try {
    real = realpathSync(joined);
  } catch {
    return { ok: false, status: "missing", reason: "the file named by the export is a broken link (missing or expired)" };
  }
  if (!real.startsWith(root + sep)) return { ok: false, status: "rejected", reason: "file: resolves outside the export directory" };
  const st = statSync(real);
  if (!st.isFile()) return { ok: false, status: "rejected", reason: "file: not a regular file" };
  if (st.size > SOURCE_FILE_BYTES_MAX) return { ok: false, status: "rejected", reason: `file: ${st.size} bytes is over the ${SOURCE_FILE_BYTES_MAX}-byte source limit; convert it to a JPEG within the upload bounds first` };
  return { ok: true, path: real, bytes: st.size };
}
// Reads at most `max` bytes (the size was checked just before; a file that grew is refused).
function readBounded(path: string, max: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
      if (n > max) throw new ImportError("the file grew while it was read");
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// What one source file becomes: the normalized JPEG an upload would store, or why it cannot be imported.
export function processSource(root: string, rel: unknown): { ok: true; bytes: Buffer; width: number; height: number; sha256: string } | { ok: false; status: "missing" | "rejected"; reason: string } {
  const c = confinedFile(root, rel);
  if (!c.ok) return c;
  let raw: Buffer;
  try {
    raw = readBounded(c.path, SOURCE_FILE_BYTES_MAX);
  } catch (err) {
    return { ok: false, status: "rejected", reason: err instanceof ImportError ? err.message : "the file could not be read" };
  }
  const kind = sniff(raw);
  if (kind !== "jpeg") return { ok: false, status: "rejected", reason: `type: the file is ${kind ? `a ${kind.toUpperCase()} file` : "not a recognised image"}, not a JPEG; convert it first` };
  const n = normalizeJpeg(raw);
  if (!n.ok) {
    const why = n.kind === "size" ? "oversize: over 1 MiB after metadata removal; re-encode it within the upload bounds first" : n.kind === "dimensions" ? "oversize: over 1600 px or 2.56 MP; resize it first" : n.kind === "format" ? "type: not a JPEG ORBIT stores" : `corrupt: ${n.reason ?? "the JPEG does not decode"}`;
    return { ok: false, status: "rejected", reason: why };
  }
  return { ok: true, bytes: n.bytes, width: n.width, height: n.height, sha256: createHash("sha256").update(n.bytes).digest("hex") };
}

// ---- manifest and approvals ---------------------------------------------------------------------------------------------------------
export function readManifest(root: string): { text: string; sha256: string; manifest: { source: ImportSource; items: unknown[] } } {
  const path = join(root, MANIFEST_NAME);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new ImportError(`The export has no ${MANIFEST_NAME}. See docs/photo-import-backfill.md for the bundle format.`);
  }
  if (!st.isFile()) throw new ImportError(`${MANIFEST_NAME} must be a regular file (not a link or directory).`);
  if (st.size > MANIFEST_BYTES_MAX) throw new ImportError(`${MANIFEST_NAME} is over ${MANIFEST_BYTES_MAX} bytes.`);
  const text = readBounded(path, MANIFEST_BYTES_MAX).toString("utf8");
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ImportError(`${MANIFEST_NAME} is not valid JSON.`);
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new ImportError(`${MANIFEST_NAME} must be a JSON object.`);
  const extra = Object.keys(x).filter((k) => !TOP_KEYS.includes(k));
  if (extra.length) throw new ImportError(`${MANIFEST_NAME} has unknown top-level field(s): ${extra.slice(0, 5).map((k) => k.slice(0, 40)).join(", ")}. Allowed: ${TOP_KEYS.join(", ")}.`);
  if (x.format !== EXPORT_FORMAT) throw new ImportError(`${MANIFEST_NAME}: format must be "${EXPORT_FORMAT}".`);
  if (!IMPORT_SOURCES.includes(x.source as ImportSource)) throw new ImportError(`${MANIFEST_NAME}: source must be one of ${IMPORT_SOURCES.join(", ")}.`);
  if (!Array.isArray(x.items)) throw new ImportError(`${MANIFEST_NAME}: items must be a list.`);
  if (x.items.length > ITEMS_MAX) throw new ImportError(`${MANIFEST_NAME}: at most ${ITEMS_MAX} items per bundle (got ${x.items.length}); split the export.`);
  return { text, sha256: createHash("sha256").update(text).digest("hex"), manifest: { source: x.source as ImportSource, items: x.items } };
}

export type Approvals = { links: Map<string, string | null>; skip: Set<string>; sha256: string };
export function parseApprovals(text: string, manifestSha256: string): Approvals {
  if (Buffer.byteLength(text) > APPROVALS_BYTES_MAX) throw new ImportError("The approvals file is over its size bound.");
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ImportError("The approvals file is not valid JSON.");
  }
  if (!x || typeof x !== "object" || x.format !== APPROVALS_FORMAT) throw new ImportError(`The approvals file must be an object with format "${APPROVALS_FORMAT}".`);
  const extra = Object.keys(x).filter((k) => !["format", "manifestSha256", "links", "skip"].includes(k));
  if (extra.length) throw new ImportError(`The approvals file has unknown field(s): ${extra.slice(0, 5).map((k) => k.slice(0, 40)).join(", ")}.`);
  if (x.manifestSha256 !== manifestSha256) throw new ImportError("The approvals file was made for a different manifest (manifestSha256 does not match). Review the current dry run again.");
  const links = new Map<string, string | null>();
  const rawLinks = (x.links ?? {}) as Record<string, unknown>;
  if (typeof rawLinks !== "object" || Array.isArray(rawLinks)) throw new ImportError("approvals.links must be an object of item id to project path (or null for no link).");
  for (const [k, v] of Object.entries(rawLinks)) {
    if (!ITEM_ID.test(k)) throw new ImportError("approvals.links has a key that is not an item id.");
    if (v !== null && (typeof v !== "string" || !PROJECT_PATH.test(v))) throw new ImportError(`approvals.links.${k} must be a project hub note path (Projects/<name>.md) or null.`);
    links.set(k, v as string | null);
  }
  const skip = new Set<string>();
  if (x.skip !== undefined) {
    if (!Array.isArray(x.skip) || !x.skip.every((s) => typeof s === "string" && ITEM_ID.test(s))) throw new ImportError("approvals.skip must be a list of item ids.");
    for (const s of x.skip as string[]) skip.add(s);
  }
  return { links, skip, sha256: createHash("sha256").update(text).digest("hex") };
}

// The project hub notes that exist: Projects/<name>.md for each .md file directly in the vault's Projects directory. Names only; no
// project file is opened or changed.
export function knownProjects(projectsDir: string | undefined): Set<string> | undefined {
  if (!projectsDir) return undefined;
  try {
    return new Set(readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => `Projects/${e.name}`).filter((p) => PROJECT_PATH.test(p)));
  } catch {
    throw new ImportError("The projects directory cannot be read.");
  }
}

// ---- validating one entry -------------------------------------------------------------------------------------------------------------
type Entry = { item: string; file: unknown; sentAt: string; caption: string; pointers: { session?: string; message?: string }; explicit: string[]; candidates: string[] };
function entryOf(raw: unknown): { ok: true; e: Entry } | { ok: false; item: string; reason: string } {
  const r = raw as Record<string, unknown>;
  const idOk = r && typeof r === "object" && typeof r.id === "string" && ITEM_ID.test(r.id);
  const item = idOk ? (r.id as string) : "";
  const bad = (reason: string) => ({ ok: false as const, item, reason });
  if (!r || typeof r !== "object" || Array.isArray(r)) return bad("not an object");
  if (!idOk) return bad("id: 1-64 characters of letters, digits and _ . : - are required");
  const extra = Object.keys(r).filter((k) => !ITEM_KEYS.includes(k));
  if (extra.length) return bad(`unknown field(s) ${extra.slice(0, 5).map((k) => k.slice(0, 40)).join(", ")}: only ${ITEM_KEYS.join(", ")} are read (no transcripts, URLs or other message content)`);
  if (r.sender !== "owner") return bad("sender: only photos the owner sent are imported (sender must be \"owner\")");
  if (typeof r.sentAt !== "string" || !ISO.test(r.sentAt) || Number.isNaN(Date.parse(r.sentAt))) return bad("sentAt: an ISO UTC time (YYYY-MM-DDTHH:MM:SSZ) is required");
  if (Date.parse(r.sentAt) > Date.now() + 86_400_000) return bad("sentAt: in the future");
  if (r.caption !== undefined && r.caption !== null && typeof r.caption !== "string") return bad("caption: must be text");
  if (typeof r.caption === "string" && r.caption.length > 4000) return bad("caption: over 4000 characters; captions are short message text, never a transcript");
  for (const k of ["session", "message"]) if (r[k] !== undefined && r[k] !== null && (typeof r[k] !== "string" || !POINTER.test(r[k] as string))) return bad(`${k}: an opaque id of 1-128 characters of letters, digits and _ . : -`);
  const explicit: string[] = [];
  if (r.projects !== undefined && r.projects !== null) {
    if (!Array.isArray(r.projects) || r.projects.length > PROJECTS_PER_ITEM_MAX) return bad(`projects: a list of at most ${PROJECTS_PER_ITEM_MAX} entries`);
    for (const p of r.projects as unknown[]) {
      const q = p as Record<string, unknown>;
      if (!q || typeof q !== "object" || typeof q.project !== "string" || !PROJECT_PATH.test(q.project)) return bad("projects[].project: a project hub note path (Projects/<name>.md)");
      if (q.evidence !== "explicit") return bad("projects[].evidence: must be \"explicit\" (the legacy message itself named or tagged the project); anything weaker goes in projectCandidates");
      if (typeof q.basis !== "string" || !q.basis.trim() || q.basis.length > 200) return bad("projects[].basis: a short statement of the explicit evidence (at most 200 characters)");
      const extraP = Object.keys(q).filter((k) => !["project", "evidence", "basis"].includes(k));
      if (extraP.length) return bad("projects[]: only project, evidence and basis are read");
      explicit.push(q.project);
    }
  }
  const candidates: string[] = [];
  if (r.projectCandidates !== undefined && r.projectCandidates !== null) {
    if (!Array.isArray(r.projectCandidates) || r.projectCandidates.length > PROJECTS_PER_ITEM_MAX || !r.projectCandidates.every((p) => typeof p === "string" && PROJECT_PATH.test(p))) return bad(`projectCandidates: a list of at most ${PROJECTS_PER_ITEM_MAX} project hub note paths`);
    candidates.push(...(r.projectCandidates as string[]));
  }
  return {
    ok: true,
    e: {
      item,
      file: r.file,
      sentAt: new Date(Date.parse(r.sentAt)).toISOString(),
      caption: importCaption(r.caption ?? ""),
      pointers: { ...(typeof r.session === "string" ? { session: r.session } : {}), ...(typeof r.message === "string" ? { message: r.message } : {}) },
      explicit: [...new Set(explicit)],
      candidates: [...new Set(candidates)],
    },
  };
}

// The link an item gets: only explicit or operator-approved evidence, only to an existing project, never a guess.
function linkFor(e: Entry, approvals: Approvals | undefined, projects: Set<string> | undefined): PlannedLink {
  const approved = approvals?.links.has(e.item) ? approvals.links.get(e.item) : undefined;
  if (approved === null) return { status: "declined", reason: "the operator approved no link for this item" };
  const exists = (p: string) => projects?.has(p) ?? false;
  if (typeof approved === "string") {
    if (!projects) return { status: "unverified", project: approved, reason: "no projects directory was given, so the project cannot be checked; nothing is linked" };
    return exists(approved) ? { status: "linked", project: approved, evidence: "operator-approved" } : { status: "unmatched", project: approved, reason: "the approved project has no hub note in the projects directory" };
  }
  if (e.explicit.length > 1) return { status: "ambiguous", candidates: e.explicit, reason: "the export names several projects explicitly; approve one (or null) in the approvals file" };
  if (e.explicit.length === 1) {
    const p = e.explicit[0]!;
    if (!projects) return { status: "unverified", project: p, reason: "no projects directory was given, so the project cannot be checked; nothing is linked" };
    return exists(p) ? { status: "linked", project: p, evidence: "explicit" } : { status: "unmatched", project: p, reason: "the project named by the export has no hub note in the projects directory" };
  }
  if (e.candidates.length) return { status: "ambiguous", candidates: e.candidates, reason: "only unconfirmed candidates: never linked without explicit evidence or the operator's approval" };
  return { status: "none" };
}

// ---- planning (the dry run) ------------------------------------------------------------------------------------------------------------
export type ExistingIndex = { bySha(sha256: string): { id: string; scope: string } | undefined };
// When the same bytes are stored more than once (an imported photo later sent again in a conversation gives a second, chat copy), the
// copy that counts is the same whatever order the store lists them in: an imported copy first (the one the ledger names), then the
// lowest id. The dry run and apply therefore agree (the reviewed plan's digest depends on it).
function preferred<T extends { id: string; scope: string }>(list: T[]): T | undefined {
  return [...list].sort((a, b) => Number(b.scope === IMPORT_SCOPE) - Number(a.scope === IMPORT_SCOPE) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}
// A read-only view of what is already stored, for a dry run: the attachment records' SHA-256 values, read without opening the store
// (which would tidy the directory). Unreadable records are skipped.
export function readOnlyIndex(attachmentsDir: string | undefined): ExistingIndex {
  const map = new Map<string, { id: string; scope: string }[]>();
  if (attachmentsDir) {
    let names: string[] = [];
    try {
      names = readdirSync(attachmentsDir);
    } catch {
      names = [];
    }
    for (const n of names) {
      if (!/^a[0-9a-f]{32}\.json$/.test(n)) continue;
      try {
        const m = JSON.parse(readFileSync(join(attachmentsDir, n), "utf8")) as { id?: string; scope?: string; state?: string; sha256?: string };
        if (typeof m.sha256 === "string" && typeof m.id === "string" && typeof m.scope === "string" && (m.state === "bound" || m.scope === IMPORT_SCOPE)) map.set(m.sha256, [...(map.get(m.sha256) ?? []), { id: m.id, scope: m.scope }]);
      } catch {
        // not ours to judge here
      }
    }
  }
  return { bySha: (sha) => preferred(map.get(sha) ?? []) };
}
export const storeIndex = (attachments: Attachments): ExistingIndex => ({
  bySha: (sha) => {
    const m = preferred(attachments.withSha256(sha).filter((x) => x.state === "bound" || x.scope === IMPORT_SCOPE));
    return m ? { id: m.id, scope: m.scope } : undefined;
  },
});

export function planImport(o: { root: string; approvalsText?: string; projects?: Set<string>; existing: ExistingIndex; ledger: ImportLedger }): ImportPlan {
  const { sha256, manifest } = readManifest(o.root);
  const approvals = o.approvalsText !== undefined ? parseApprovals(o.approvalsText, sha256) : undefined;
  const imported = o.ledger.photos();
  const seenIds = new Set<string>();
  const seenSha = new Map<string, string>();
  const items: PlannedItem[] = [];
  for (const raw of manifest.items) {
    const v = entryOf(raw);
    if (!v.ok) {
      items.push({ item: v.item || `#${items.length + 1}`, status: "rejected", reason: v.reason, link: { status: "none" } });
      continue;
    }
    const e = v.e;
    if (seenIds.has(e.item)) {
      items.push({ item: e.item, status: "rejected", reason: "id: the same item id appears twice in the export", link: { status: "none" } });
      continue;
    }
    seenIds.add(e.item);
    const link = linkFor(e, approvals, o.projects);
    if (approvals?.skip.has(e.item)) {
      items.push({ item: e.item, status: "rejected", reason: "skipped by the operator in the approvals file", link: { status: "none" } });
      continue;
    }
    const got = processSource(o.root, e.file);
    if (!got.ok) {
      items.push({ item: e.item, status: got.status, reason: got.reason, link });
      continue;
    }
    const keep = { file: e.file as string, sentAt: e.sentAt, caption: e.caption, pointers: e.pointers };
    const earlier = imported.find((p) => p.source === manifest.source && p.item === e.item);
    const existing = o.existing.bySha(got.sha256);
    if (earlier && (!existing || existing.id !== earlier.attachment)) {
      items.push({ item: e.item, status: "rejected", reason: "this item id was imported earlier with different bytes; give the new photo a new id", link });
      continue;
    }
    if (seenSha.has(got.sha256)) {
      items.push({ item: e.item, status: "duplicate-in-export", reason: `the same photo as item ${seenSha.get(got.sha256)}`, sha256: got.sha256, link, ...keep });
      continue;
    }
    seenSha.set(got.sha256, e.item);
    if (existing) {
      const inLedger = imported.find((p) => p.attachment === existing.id);
      const status: ItemStatus = existing.scope === IMPORT_SCOPE ? (inLedger ? "already-imported" : "importable") : "already-present";
      const reason = status === "already-imported" ? `already imported (item ${inLedger!.item})` : status === "already-present" ? "the same photo is already stored in ORBIT (sent in a conversation); it is not imported again" : "stored by an interrupted import without its ledger entry; applying finishes it";
      items.push({ item: e.item, status, reason, sha256: got.sha256, ref: photoRef(existing.id), link, ...keep });
      continue;
    }
    items.push({ item: e.item, status: "importable", sha256: got.sha256, link, ...keep });
  }
  const counts = { importable: 0, "already-imported": 0, "already-present": 0, "duplicate-in-export": 0, missing: 0, rejected: 0, links: { linked: 0, none: 0, ambiguous: 0, unmatched: 0, unverified: 0, declined: 0 } } as ImportPlan["counts"];
  for (const it of items) {
    counts[it.status]++;
    counts.links[it.link.status]++;
  }
  return { format: EXPORT_FORMAT, source: manifest.source, manifestSha256: sha256, ...(approvals ? { approvalsSha256: approvals.sha256 } : {}), items, counts };
}

// The reviewed plan's digest: what apply will do, item by item. It covers the manifest and approvals hashes and, for every item, its
// status, the SHA-256 of the normalized bytes that would be stored, the photo ref it is (or is already stored as) and its project link.
// The dry run prints it; apply rebuilds the plan from the files as they are then and refuses unless the digest is the one the owner
// reviewed, so a swapped photo, a changed approvals file or a store that changed in between never goes through unreviewed.
export function planDigest(plan: ImportPlan): string {
  const items = plan.items.map((i) => [i.item, i.status, i.sha256 ?? null, i.ref ?? null, i.link.status, i.link.project ?? null, i.link.evidence ?? null]);
  const canon = JSON.stringify({ format: plan.format, source: plan.source, manifestSha256: plan.manifestSha256, approvalsSha256: plan.approvalsSha256 ?? null, items });
  return createHash("sha256").update(canon).digest("hex");
}

// What may be printed or written as a report: item ids, statuses, reason codes, refs, hashes and project paths. Never captions,
// pointers, file names or paths (the operator has the manifest).
export function reportOf(plan: ImportPlan) {
  return {
    format: plan.format,
    source: plan.source,
    planSha256: planDigest(plan),
    manifestSha256: plan.manifestSha256,
    ...(plan.approvalsSha256 ? { approvalsSha256: plan.approvalsSha256 } : {}),
    counts: plan.counts,
    items: plan.items.map((i) => ({ item: i.item, status: i.status, ...(i.reason ? { reason: i.reason } : {}), ...(i.ref ? { ref: i.ref } : {}), ...(i.sha256 ? { sha256: i.sha256 } : {}), link: i.link })),
  };
}

// ---- applying a reviewed plan (host-local, ORBIT stopped) ---------------------------------------------------------------------------
export type ApplyResult = { batch: string; imported: { item: string; ref: string }[]; finished: { item: string; ref: string }[]; linked: { item: string; ref: string; project: string; evidence: LinkEvidence }[]; skipped: { item: string; reason: string }[]; failed: { item: string; reason: string }[] };

export function applyImport(plan: ImportPlan, o: { root: string; attachments: Attachments; ledger: ImportLedger; now?: () => Date; batch?: string }): ApplyResult {
  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const batch = o.batch ?? `ib_${createHash("sha256").update(`${plan.manifestSha256}:${startedAt}:${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 16)}`;
  if (!BATCH_ID.test(batch)) throw new ImportError("bad batch id");
  const out: ApplyResult = { batch, imported: [], finished: [], linked: [], skipped: [], failed: [] };
  o.ledger.mutate((f) => {
    if (f.batches.some((b) => b.id === batch)) throw new ImportError("This batch id already exists.");
    f.batches.push({ id: batch, source: plan.source, manifestSha256: plan.manifestSha256, at: startedAt, state: "applied", items: 0 });
  });
  const link = (item: PlannedItem, ref: string, at: string) => {
    if (item.link.status !== "linked" || !item.link.project || !item.link.evidence || !LINK_EVIDENCE.includes(item.link.evidence)) return;
    const project = item.link.project;
    const evidence = item.link.evidence;
    const added = o.ledger.mutate((f) => {
      if (f.links.some((l) => l.ref === ref && l.project === project)) return false;
      f.links.push({ ref, project, evidence, batch, item: item.item, at });
      return true;
    });
    if (added) out.linked.push({ item: item.item, ref, project, evidence });
  };
  for (const item of plan.items) {
    const at = now().toISOString().replace(/\.\d{3}Z$/, "Z");
    try {
      if (item.status === "already-present" || item.status === "already-imported") {
        if (item.ref) link(item, item.ref, at);
        out.skipped.push({ item: item.item, reason: item.status });
        continue;
      }
      if (item.status !== "importable") {
        out.skipped.push({ item: item.item, reason: item.status });
        continue;
      }
      // Read and check again: the bytes stored must be the ones the reviewed plan described.
      const got = processSource(o.root, item.file);
      if (!got.ok || got.sha256 !== item.sha256) {
        out.failed.push({ item: item.item, reason: got.ok ? "the file changed since the reviewed dry run; run the dry run again" : got.reason });
        continue;
      }
      const { meta, reused } = o.attachments.putImported(got.bytes, { width: got.width, height: got.height }, at);
      if (reused && meta.scope !== IMPORT_SCOPE) {
        out.skipped.push({ item: item.item, reason: "already-present" });
        link(item, photoRef(meta.id), at);
        continue;
      }
      const ref = photoRef(meta.id);
      const wrote = o.ledger.mutate((f) => {
        if (f.photos.some((p) => p.attachment === meta.id)) return false;
        if (f.photos.some((p) => p.source === plan.source && p.item === item.item)) throw new ImportError("this item id was imported earlier with different bytes");
        f.photos.push({ attachment: meta.id, ref, source: plan.source, item: item.item, batch, sentAt: item.sentAt!.replace(/\.\d{3}Z$/, "Z"), importedAt: at, caption: item.caption ?? "", pointers: item.pointers ?? {} });
        const b = f.batches.find((x) => x.id === batch)!;
        b.items++;
        return true;
      });
      if (wrote) (reused ? out.finished : out.imported).push({ item: item.item, ref });
      else out.skipped.push({ item: item.item, reason: "already-imported" });
      link(item, ref, at);
    } catch (err) {
      out.failed.push({ item: item.item, reason: err instanceof Error ? err.message.slice(0, 200) : "unknown error" });
    }
  }
  return out;
}

// ---- reversing a batch --------------------------------------------------------------------------------------------------------------
// The ledger entries go first (the photos stop being visible at once), then the stored copies that no other ledger entry uses. Links the
// batch added (including links to photos that were already in ORBIT) are removed. Only IMPORT_SCOPE attachments are ever deleted.
// Saved observations about the reversed photos stay in the observation store but are never served (their photo is gone); derived
// search vectors are pruned by the semantic index's own maintenance. Idempotent.
export function revertImport(batch: string, o: { attachments: Attachments; ledger: ImportLedger; now?: () => Date }) {
  if (!BATCH_ID.test(batch)) throw new ImportError("The batch id must look like ib_<16 hex characters> (from the apply report).");
  const now = o.now ?? (() => new Date());
  const at = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = o.ledger.mutate((f) => {
    const b = f.batches.find((x) => x.id === batch);
    if (!b) throw new ImportError("No such import batch in the ledger.");
    const photos = f.photos.filter((p) => p.batch === batch);
    const links = f.links.filter((l) => l.batch === batch).length;
    f.photos = f.photos.filter((p) => p.batch !== batch);
    f.links = f.links.filter((l) => l.batch !== batch);
    const already = b.state === "reverted";
    b.state = "reverted";
    b.revertedAt ??= at;
    return { photos, links, already, remaining: new Set(f.photos.map((p) => p.attachment)) };
  });
  // The batch is already hidden (the ledger is written); a file that cannot be removed now is reported, not thrown, so the report says
  // what changed. It is invisible without its ledger entry, and a later revert of the same batch cannot reach it, so it is named.
  let removed = 0;
  const removeFailed: { ref: string; reason: string }[] = [];
  for (const p of res.photos) {
    if (res.remaining.has(p.attachment)) continue;
    try {
      if (o.attachments.removeImported(p.attachment)) removed++;
    } catch (err) {
      removeFailed.push({ ref: p.ref, reason: err instanceof Error ? err.message.slice(0, 200) : "unknown error" });
    }
  }
  return { batch, alreadyReverted: res.already && !res.photos.length, photosHidden: res.photos.length, filesRemoved: removed, ...(removeFailed.length ? { removeFailed } : {}), linksRemoved: res.links, refs: res.photos.map((p) => p.ref) };
}
