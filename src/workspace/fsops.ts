import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";

// Workspace filesystem operations, confined at OPERATION time (docs/workspace-tools.md, "Filesystem confinement").
//
// The boundary is not a lexical or realpath check. Every operation starts from a directory descriptor for the workspace root and
// walks one component at a time. Each component is opened with O_PATH | O_NOFOLLOW relative to the descriptor of its parent, through
// the kernel's /proc/self/fd/<fd>/<name> lookup (Node has no openat; resolving a name under the magic link of a held directory
// descriptor is the same lookup openat does: it starts at that directory, whatever it is now called). The descriptor is fstat'ed
// before it is used: a symbolic link (at any depth), a different device (a mount), a mount point recorded inside the workspace, a
// special file (FIFO, socket, device) or a regular file with more than one hard link is refused. Content is then read through the
// SAME inode (reopening /proc/self/fd/<O_PATH fd>), so nothing can be swapped between the check and the use. O_PATH never opens the
// file itself, so a device or FIFO is never opened even for the check.
//
// Mutations (atomic write, patch) run only under the workspace's exclusive lock (src/workspace/service.ts), so no sandboxed command
// runs in that workspace while a version precondition is checked and the new file is renamed into place.

export const O_PATH = 0o10000000; // Linux; refused on other platforms by checkPlatform().
const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_DIRECTORY = constants.O_DIRECTORY;
const O_NONBLOCK = constants.O_NONBLOCK;

export const PATH_MAX_CHARS = 1024;
export const PATH_MAX_DEPTH = 32;
export const SEGMENT_MAX_BYTES = 255;
// Files larger than this have no version (they are never hashed whole) and cannot be written or patched.
export const VERSION_MAX_BYTES = 16 * 1024 * 1024;
export const READ_PAGE_DEFAULT = 8 * 1024;
export const READ_PAGE_MAX = 16 * 1024;
export const LIST_PAGE_DEFAULT = 100;
export const LIST_PAGE_MAX = 200;
// Below the 24,000-character card budget (src/workspace/service.ts CARD_MAX_CHARS) with room for the path and the fixed card fields,
// so every write the tool accepts can be shown in full.
export const WRITE_MAX_BYTES = 20_000;
export const PATCH_EDITS_MAX = 8;
export const SEARCH_LIMITS = { files: 2000, bytesPerFile: 1024 * 1024, totalBytes: 16 * 1024 * 1024, depth: 16, matchesDefault: 50, matchesMax: 100, lineChars: 200, queryMax: 200 };

export class WorkspaceFsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: string, message: string): never => {
  throw new WorkspaceFsError(code, message);
};

export function checkPlatform(): string | undefined {
  if (process.platform !== "linux") return `workspace tools need Linux (this is ${process.platform})`;
  try {
    const fd = openSync("/proc/self/fd", O_PATH | O_DIRECTORY);
    closeSync(fd);
  } catch {
    return "/proc/self/fd is not available, so operation-time confinement cannot be enforced";
  }
  return undefined;
}

// A model-supplied relative path. Lexical rules are only the first filter; the operation-time walk is the boundary.
export function parseRelPath(input: unknown, opts: { allowRoot?: boolean } = {}): string[] {
  if (input === undefined || input === null || input === "" || input === ".") {
    if (opts.allowRoot) return [];
    fail("invalid_path", "A file path relative to the workspace is required.");
  }
  if (typeof input !== "string") return fail("invalid_path", "The path must be a string.");
  if (input.length > PATH_MAX_CHARS) fail("invalid_path", `The path is longer than ${PATH_MAX_CHARS} characters.`);
  if (input.startsWith("/")) fail("invalid_path", "Absolute paths are refused: give a path relative to the workspace.");
  if (/[\u0000-\u001f\u007f\\]/.test(input)) fail("invalid_path", "The path contains a control character or a backslash.");
  const segments = input.split("/").filter((s, i, all) => !(s === "" && i === all.length - 1));
  if (segments.length > PATH_MAX_DEPTH) fail("invalid_path", `The path is deeper than ${PATH_MAX_DEPTH} components.`);
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") fail("invalid_path", "Empty, '.' and '..' path components are refused.");
    if (Buffer.byteLength(s) > SEGMENT_MAX_BYTES) fail("invalid_path", `A path component is longer than ${SEGMENT_MAX_BYTES} bytes.`);
  }
  if (!segments.length && !opts.allowRoot) fail("invalid_path", "A file path relative to the workspace is required.");
  return segments;
}

const via = (fd: number, name?: string) => (name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);
const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const typeOf = (st: Stats): "file" | "dir" | "symlink" | "fifo" | "socket" | "char-device" | "block-device" | "other" =>
  st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : st.isFIFO() ? "fifo" : st.isSocket() ? "socket" : st.isCharacterDevice() ? "char-device" : st.isBlockDevice() ? "block-device" : "other";
export type EntryType = ReturnType<typeof typeOf>;

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const versionOf = (b: Buffer) => `sha256:${sha256(b)}`;

// Mount points strictly inside the root, from this process's own mount table. A mount inside a workspace is refused at operation
// time even when it is on the same device (a bind mount), which the st_dev comparison alone would miss.
export function mountsInside(root: string, mountinfo = "/proc/self/mountinfo"): string[] {
  let text: string;
  try {
    text = readFileSync(mountinfo, "utf8");
  } catch {
    return fail("unavailable", "The mount table could not be read, so mount escapes cannot be ruled out.");
  }
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return text
    .split("\n")
    .map((l) => l.split(" ")[4])
    .filter((m): m is string => typeof m === "string")
    .map(unescape)
    .filter((m) => m.startsWith(prefix));
}

export type RootHandle = { fd: number; dev: number; ino: number; path: string; close(): void };

// Opens the configured root (operator configuration, already validated at load) and checks it is still the same directory.
export function openRoot(root: string, expect?: { dev: number; ino: number }): RootHandle {
  let fd: number;
  try {
    fd = openSync(root, O_PATH | O_DIRECTORY | O_NOFOLLOW);
  } catch (e) {
    return fail("workspace_unavailable", `The workspace root cannot be opened (${errno(e) ?? "error"}).`);
  }
  const st = fstatSync(fd);
  if (!st.isDirectory() || (expect && (st.dev !== expect.dev || st.ino !== expect.ino))) {
    closeSync(fd);
    fail("workspace_changed", "The workspace root is no longer the directory that was configured.");
  }
  return { fd, dev: st.dev, ino: st.ino, path: root, close: () => closeSync(fd) };
}

type Walked = { parentFd: number; name: string | undefined; fd: number; st: Stats; opened: number[] };

// Walks `segments` from the root, one O_PATH|O_NOFOLLOW component at a time. Every intermediate component must be a real directory
// on the root's device. Returns the final component's O_PATH descriptor (not followed) and its lstat-equivalent fstat. The caller
// closes `opened`.
function walk(root: RootHandle, segments: string[], opts: { missingOk?: boolean; finalLinkOk?: boolean } = {}): Walked | { missing: true; parentFd: number; name: string; opened: number[] } {
  const opened: number[] = [];
  let cur = root.fd;
  try {
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!;
      const last = i === segments.length - 1;
      let fd: number;
      try {
        fd = openSync(via(cur, name), O_PATH | O_NOFOLLOW);
      } catch (e) {
        const code = errno(e);
        if (code === "ENOENT" && last && opts.missingOk) return { missing: true, parentFd: cur, name, opened };
        if (code === "ENOENT") fail("not_found", `${segments.slice(0, i + 1).join("/")} does not exist.`);
        if (code === "EACCES" || code === "EPERM") fail("permission_denied", `${segments.slice(0, i + 1).join("/")} cannot be accessed.`);
        return fail("unavailable", `${segments.slice(0, i + 1).join("/")} could not be opened (${code ?? "error"}).`);
      }
      opened.push(fd);
      const st = fstatSync(fd);
      if (st.dev !== root.dev) fail("mount_refused", `${segments.slice(0, i + 1).join("/")} is on another filesystem (a mount); it is outside the workspace boundary.`);
      if (st.isSymbolicLink() && !(last && opts.finalLinkOk)) fail("symlink_refused", `${segments.slice(0, i + 1).join("/")} is a symbolic link; links are never followed.`);
      if (!last) {
        if (!st.isDirectory()) fail("not_a_directory", `${segments.slice(0, i + 1).join("/")} is not a directory.`);
        cur = fd;
        continue;
      }
      return { parentFd: cur, name, fd, st, opened };
    }
    return { parentFd: root.fd, name: undefined, fd: root.fd, st: fstatSync(root.fd), opened };
  } catch (e) {
    for (const fd of opened) closeSync(fd);
    throw e;
  }
}
const closeAll = (fds: number[]) => {
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
};

function guardRoot(root: RootHandle) {
  const inside = mountsInside(root.path);
  if (inside.length) fail("mount_refused", `The workspace contains a mount point (${inside.length}); operations are refused until it is removed.`);
}

// Reads the whole content of a regular file through the inode pinned by its O_PATH descriptor (never by name again).
function readPinned(pathFd: number, st: Stats, max: number): Buffer {
  if (st.size > max) fail("too_large", `The file is ${st.size} bytes, more than ${max}.`);
  const fd = openSync(via(pathFd), constants.O_RDONLY | O_NONBLOCK);
  try {
    const again = fstatSync(fd);
    if (again.ino !== st.ino || again.dev !== st.dev || !again.isFile()) fail("changed", "The file changed while it was opened.");
    const out = Buffer.alloc(Math.min(again.size, max) + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, out, n, out.length - n, null);
      if (r === 0) break;
      n += r;
      if (n >= out.length) fail("too_large", `The file grew past ${max} bytes while it was read.`);
    }
    return out.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function requireRegular(st: Stats, rel: string) {
  if (st.isSymbolicLink()) fail("symlink_refused", `${rel} is a symbolic link; links are never followed.`);
  if (!st.isFile()) fail("special_file_refused", `${rel} is a ${typeOf(st)}, not a regular file.`);
  if (st.nlink > 1) fail("hardlink_refused", `${rel} has ${st.nlink} hard links; files with more than one link are refused.`);
}

const modeString = (st: Stats) => (st.mode & 0o7777).toString(8).padStart(4, "0");

export function statPath(root: RootHandle, segments: string[]) {
  guardRoot(root);
  // The final component is described, not followed: a link is reported as a link (its target is never resolved or read).
  const w = walk(root, segments, { finalLinkOk: true });
  if ("missing" in w) return fail("not_found", "Not found.");
  try {
    const rel = segments.join("/") || ".";
    const type = typeOf(w.st);
    let version: string | undefined;
    let versionUnavailable: string | undefined;
    if (type === "file") {
      if (w.st.nlink > 1) versionUnavailable = "more than one hard link";
      else if (w.st.size > VERSION_MAX_BYTES) versionUnavailable = `larger than ${VERSION_MAX_BYTES} bytes`;
      else version = versionOf(readPinned(w.fd, w.st, VERSION_MAX_BYTES));
    }
    return {
      path: rel,
      type,
      size: w.st.size,
      mode: modeString(w.st),
      nlink: w.st.nlink,
      modifiedAt: w.st.mtime.toISOString(),
      ...(version ? { version } : {}),
      ...(versionUnavailable ? { versionUnavailable } : {}),
    };
  } finally {
    closeAll(w.opened);
  }
}

export function listDir(root: RootHandle, segments: string[], opts: { cursor?: string; limit?: number } = {}) {
  guardRoot(root);
  const limit = Math.min(Math.max(1, opts.limit ?? LIST_PAGE_DEFAULT), LIST_PAGE_MAX);
  const w = walk(root, segments);
  if ("missing" in w) return fail("not_found", "Not found.");
  try {
    if (!w.st.isDirectory()) fail("not_a_directory", `${segments.join("/")} is not a directory.`);
    const raw = readdirSync(via(w.fd), { encoding: "buffer" }) as Buffer[];
    let undecodable = 0;
    const names: string[] = [];
    for (const b of raw) {
      const s = b.toString("utf8");
      if (Buffer.from(s, "utf8").equals(b) && !/[\u0000-\u001f\u007f\\]/.test(s)) names.push(s);
      else undecodable++;
    }
    names.sort();
    const start = opts.cursor ? names.findIndex((n) => n > opts.cursor!) : 0;
    const page = start < 0 ? [] : names.slice(start, start + limit);
    const entries = page.map((name) => {
      try {
        const st = lstatSync(via(w.fd, name));
        return { name, type: typeOf(st), size: st.isFile() ? st.size : undefined, ...(st.isFile() && st.nlink > 1 ? { nlink: st.nlink } : {}), ...(st.dev !== root.dev ? { mount: true } : {}) };
      } catch {
        return { name, type: "unavailable" as const };
      }
    });
    const more = start >= 0 && start + limit < names.length;
    return { path: segments.join("/") || ".", total: names.length, entries, nextCursor: more ? page.at(-1) : null, ...(undecodable ? { omittedUndecodableNames: undecodable } : {}) };
  } finally {
    closeAll(w.opened);
  }
}

// A page of a file, by byte offset. The version covers the whole file (so a later write can name it), the page only what is shown.
export function readPage(root: RootHandle, segments: string[], opts: { offset?: number; length?: number } = {}) {
  guardRoot(root);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const length = Math.min(Math.max(1, Math.floor(opts.length ?? READ_PAGE_DEFAULT)), READ_PAGE_MAX);
  const w = walk(root, segments);
  if ("missing" in w) return fail("not_found", "Not found.");
  try {
    const rel = segments.join("/");
    requireRegular(w.st, rel);
    if (w.st.size > VERSION_MAX_BYTES) fail("too_large", `${rel} is ${w.st.size} bytes; files over ${VERSION_MAX_BYTES} bytes are not read.`);
    const all = readPinned(w.fd, w.st, VERSION_MAX_BYTES);
    const version = versionOf(all);
    if (offset > all.length) fail("invalid_offset", `Offset ${offset} is past the end of the file (${all.length} bytes).`);
    let end = Math.min(all.length, offset + length);
    // Never split a UTF-8 sequence at the end of a page: back off to the start of the cut character.
    while (end < all.length && end > offset && (all[end]! & 0xc0) === 0x80) end--;
    const slice = all.subarray(offset, end);
    const binary = slice.includes(0);
    return {
      path: rel,
      version,
      size: all.length,
      offset,
      bytes: slice.length,
      nextOffset: end < all.length ? end : null,
      truncated: end < all.length,
      ...(binary ? { binary: true, text: null, note: "Binary content (a NUL byte in this page) is not shown." } : { text: slice.toString("utf8") }),
    };
  } finally {
    closeAll(w.opened);
  }
}

// Literal (not regular-expression) search, bounded in files, bytes, depth and matches. Links, mounts, special files and
// multiply-linked files are skipped and counted, never followed or opened.
export function search(root: RootHandle, segments: string[], query: string, opts: { maxResults?: number } = {}) {
  guardRoot(root);
  if (typeof query !== "string" || !query.length || query.length > SEARCH_LIMITS.queryMax || /[\u0000\n\r]/.test(query)) fail("invalid_query", `The query must be 1-${SEARCH_LIMITS.queryMax} characters on one line.`);
  const max = Math.min(Math.max(1, opts.maxResults ?? SEARCH_LIMITS.matchesDefault), SEARCH_LIMITS.matchesMax);
  const start = walk(root, segments);
  if ("missing" in start) return fail("not_found", "Not found.");
  const matches: { path: string; line: number; text: string }[] = [];
  const skipped = { symlinks: 0, special: 0, hardlinked: 0, mounts: 0, tooLarge: 0, binary: 0, unreadable: 0, tooDeep: 0, undecodableNames: 0 };
  let files = 0;
  let bytes = 0;
  let stop: string | undefined;
  const needle = Buffer.from(query, "utf8");
  const visitFile = (fd: number, st: Stats, rel: string) => {
    if (st.size > SEARCH_LIMITS.bytesPerFile) return void skipped.tooLarge++;
    if (bytes + st.size > SEARCH_LIMITS.totalBytes) return void (stop = `stopped after ${bytes} bytes (limit ${SEARCH_LIMITS.totalBytes})`);
    let buf: Buffer;
    try {
      buf = readPinned(fd, st, SEARCH_LIMITS.bytesPerFile);
    } catch {
      return void skipped.unreadable++;
    }
    files++;
    bytes += buf.length;
    if (buf.includes(0)) return void skipped.binary++;
    if (!buf.includes(needle)) return;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length && matches.length < max; i++) {
      if (lines[i]!.includes(query)) matches.push({ path: rel, line: i + 1, text: lines[i]!.length > SEARCH_LIMITS.lineChars ? `${lines[i]!.slice(0, SEARCH_LIMITS.lineChars)}…` : lines[i]! });
    }
    if (matches.length >= max) stop = `stopped at ${max} matches`;
  };
  const visitDir = (dirFd: number, rel: string, depth: number) => {
    if (depth > SEARCH_LIMITS.depth) return void skipped.tooDeep++;
    let names: Buffer[];
    try {
      names = (readdirSync(via(dirFd), { encoding: "buffer" }) as Buffer[]).sort(Buffer.compare);
    } catch {
      return void skipped.unreadable++;
    }
    for (const b of names) {
      if (stop) return;
      const name = b.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(b) || name.includes("/")) {
        skipped.undecodableNames++;
        continue;
      }
      if (files >= SEARCH_LIMITS.files) return void (stop = `stopped after ${files} files (limit ${SEARCH_LIMITS.files})`);
      let fd: number;
      try {
        fd = openSync(via(dirFd, name), O_PATH | O_NOFOLLOW);
      } catch {
        skipped.unreadable++;
        continue;
      }
      try {
        const st = fstatSync(fd);
        const childRel = rel ? `${rel}/${name}` : name;
        if (st.dev !== root.dev) skipped.mounts++;
        else if (st.isSymbolicLink()) skipped.symlinks++;
        else if (st.isDirectory()) visitDir(fd, childRel, depth + 1);
        else if (!st.isFile()) skipped.special++;
        else if (st.nlink > 1) skipped.hardlinked++;
        else visitFile(fd, st, childRel);
      } finally {
        closeSync(fd);
      }
    }
  };
  try {
    const rel = segments.join("/");
    if (start.st.isDirectory()) visitDir(start.fd, rel, 0);
    else {
      requireRegular(start.st, rel);
      visitFile(start.fd, start.st, rel);
    }
  } finally {
    closeAll(start.opened);
  }
  return { query, matches, filesSearched: files, bytesSearched: bytes, complete: !stop, ...(stop ? { stoppedBecause: stop } : {}), skipped: Object.fromEntries(Object.entries(skipped).filter(([, v]) => v > 0)) };
}

export type WritePrecondition = { kind: "new" } | { kind: "version"; version: string };

// The precondition check for a write or patch: the target as it is NOW, through the confined walk.
export function currentVersion(root: RootHandle, segments: string[]): { exists: false } | { exists: true; version: string; content: Buffer; mode: number } {
  guardRoot(root);
  const w = walk(root, segments, { missingOk: true });
  if ("missing" in w) {
    closeAll(w.opened);
    return { exists: false };
  }
  try {
    requireRegular(w.st, segments.join("/"));
    const content = readPinned(w.fd, w.st, VERSION_MAX_BYTES);
    return { exists: true, version: versionOf(content), content, mode: w.st.mode };
  } finally {
    closeAll(w.opened);
  }
}

// Atomic write: a new file in the target's own directory (O_CREAT|O_EXCL|O_NOFOLLOW, 0600), fsync, then either link() (new file:
// fails if anything appeared at the name, atomically) or rename() over the checked old version, then fsync of the directory. The
// precondition is checked through the confined walk immediately before; the caller holds the workspace lock, so no sandboxed
// command in this workspace runs in between. Returns the new version.
export function atomicWrite(root: RootHandle, segments: string[], content: Buffer, pre: WritePrecondition): { version: string; created: boolean } {
  guardRoot(root);
  if (!segments.length) fail("invalid_path", "A file path is required.");
  const parentSegs = segments.slice(0, -1);
  const name = segments.at(-1)!;
  const parent = walk(root, parentSegs);
  if ("missing" in parent) return fail("not_found", "The parent directory does not exist.");
  try {
    if (!parent.st.isDirectory()) fail("not_a_directory", "The parent is not a directory.");
    const dirFd = parent.fd;
    const now = currentVersion(root, segments);
    if (pre.kind === "new" && now.exists) fail("conflict", `${segments.join("/")} already exists; nothing was written.`);
    if (pre.kind === "version") {
      if (!now.exists) fail("conflict", `${segments.join("/")} no longer exists; nothing was written.`);
      if (now.exists && now.version !== pre.version) fail("conflict", `${segments.join("/")} changed since it was read (expected ${pre.version.slice(0, 19)}…, found ${now.version.slice(0, 19)}…); nothing was written.`);
    }
    const tmp = `.orbit-tmp-${randomBytes(9).toString("hex")}`;
    const fd = openSync(via(dirFd, tmp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    let placed = false;
    try {
      let n = 0;
      while (n < content.length) n += writeSync(fd, content, n, content.length - n);
      const keep = now.exists ? now.mode & 0o700 : 0o600;
      fchmodSync(fd, keep | 0o600);
      fsyncSync(fd);
      closeSync(fd);
      if (pre.kind === "new") {
        try {
          linkSync(via(dirFd, tmp), via(dirFd, name));
        } catch (e) {
          if (errno(e) === "EEXIST") fail("conflict", `${segments.join("/")} appeared while it was written; nothing was written.`);
          throw e;
        }
        unlinkSync(via(dirFd, tmp));
      } else {
        renameSync(via(dirFd, tmp), via(dirFd, name));
      }
      placed = true;
    } finally {
      if (!placed) {
        try {
          unlinkSync(via(dirFd, tmp));
        } catch {
          /* already gone */
        }
      }
    }
    const dfd = openSync(via(dirFd), constants.O_RDONLY | O_DIRECTORY);
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
    return { version: versionOf(content), created: pre.kind === "new" };
  } finally {
    closeAll(parent.opened);
  }
}

export type PatchEdit = { find: string; replace: string };

// Exact-match patch: every `find` must occur exactly once in the CURRENT text (applied in order, each against the result of the
// previous one). Deterministic: any miss or ambiguity refuses the whole patch.
export function applyPatch(text: string, edits: PatchEdit[]): string {
  let out = text;
  edits.forEach((e, i) => {
    const first = out.indexOf(e.find);
    if (first < 0) fail("patch_no_match", `Edit ${i + 1}: the passage was not found; nothing was written.`);
    if (out.indexOf(e.find, first + 1) >= 0) fail("patch_ambiguous", `Edit ${i + 1}: the passage occurs more than once; nothing was written.`);
    out = out.slice(0, first) + e.replace + out.slice(first + e.find.length);
  });
  return out;
}

// The workspace's reviewed snapshot: every entry (path, type, mode, size; content hash for regular files; target for links),
// sorted, hashed. An exec approval is bound to this digest: if anything in the workspace differs when the run starts, the approval
// does not carry over. Bounded; a workspace too large to snapshot cannot be used for exec.
export const SNAPSHOT_LIMITS = { entries: 20_000, bytes: 128 * 1024 * 1024, depth: 64 };
export type Snapshot = { digest: string; entries: number; bytes: number };

export function snapshot(root: RootHandle, limits = SNAPSHOT_LIMITS): Snapshot {
  guardRoot(root);
  const h = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const visit = (dirFd: number, rel: string, depth: number) => {
    if (depth > limits.depth) fail("snapshot_too_large", `The workspace is deeper than ${limits.depth} levels.`);
    let names: Buffer[];
    try {
      names = (readdirSync(via(dirFd), { encoding: "buffer" }) as Buffer[]).sort(Buffer.compare);
    } catch (e) {
      // An unreadable directory (for example a root-owned lost+found left by mkfs) cannot be part of a reviewed snapshot.
      return fail("snapshot_unsupported", `${rel || "the workspace root"} cannot be read (${errno(e) ?? "error"}), so the workspace cannot be snapshotted; remove it or make it readable by ORBIT.`);
    }
    for (const b of names) {
      if (++entries > limits.entries) fail("snapshot_too_large", `The workspace has more than ${limits.entries} entries.`);
      const name = b.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(b)) fail("snapshot_unsupported", "A file name is not valid UTF-8; the workspace cannot be snapshotted.");
      const childRel = rel ? `${rel}/${name}` : name;
      let fd: number;
      try {
        fd = openSync(via(dirFd, name), O_PATH | O_NOFOLLOW);
      } catch (e) {
        return fail("snapshot_unsupported", `${childRel} cannot be opened (${errno(e) ?? "error"}), so the workspace cannot be snapshotted.`);
      }
      try {
        const st = fstatSync(fd);
        if (st.dev !== root.dev) fail("mount_refused", "The workspace contains a mount point.");
        const type = typeOf(st);
        let extra = "";
        if (type === "file") {
          bytes += st.size;
          if (bytes > limits.bytes) fail("snapshot_too_large", `The workspace holds more than ${limits.bytes} bytes.`);
          try {
            extra = sha256(readPinned(fd, st, limits.bytes));
          } catch (e) {
            if (e instanceof WorkspaceFsError) throw e;
            fail("snapshot_unsupported", `${childRel} cannot be read (${errno(e) ?? "error"}), so the workspace cannot be snapshotted.`);
          }
        } else if (type === "symlink") {
          extra = sha256(readlinkSync(via(dirFd, name), { encoding: "buffer" }));
        }
        h.update(`${JSON.stringify([childRel, type, st.mode & 0o7777, type === "file" ? st.size : 0, extra])}\n`);
        if (type === "dir") visit(fd, childRel, depth + 1);
      } finally {
        closeSync(fd);
      }
    }
  };
  visit(root.fd, "", 0);
  return { digest: `sha256:${h.digest("hex")}`, entries, bytes };
}
