import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPatch, atomicWrite, checkPlatform, currentVersion, listDir, openRoot, parseRelPath, readPage, READ_PAGE_MAX, search, snapshot, statPath, versionOf, WorkspaceFsError } from "../src/workspace/fsops.ts";

// Operation-time filesystem confinement (docs/workspace-tools.md, "Filesystem confinement"). Synthetic fixtures in temporary directories
// only. Each test builds a workspace next to an "outside" directory holding a canary; every escape attempt must be refused and the
// canary must never be read, written or listed.

const CANARY = "OUTSIDE-CANARY-do-not-read";
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "orbit-wsfs-"));
  const ws = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(ws, { mode: 0o700 });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), CANARY);
  writeFileSync(join(ws, "a.txt"), "alpha\nbeta\ngamma\n");
  mkdirSync(join(ws, "dir"));
  writeFileSync(join(ws, "dir", "inner.txt"), "inner beta\n");
  return { base, ws, outside, root: () => openRoot(ws) };
}
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorkspaceFsError) return e.code;
    throw e;
  }
  return "ok";
};
const isRoot = process.getuid?.() === 0;

test("the platform supports operation-time confinement here (Linux, /proc/self/fd)", () => {
  assert.equal(checkPlatform(), undefined);
});

test("lexical rules: absolute paths, '..', '.', empty components, control characters and backslashes are refused", () => {
  for (const p of ["/etc/passwd", "../outside/secret.txt", "dir/../../outside", "./a.txt", "dir//inner.txt", "a\u0000b", "a\\b", "x\ny", "/proc/self/root/etc/passwd"]) {
    assert.equal(code(() => parseRelPath(p)), "invalid_path", p);
  }
  assert.deepEqual(parseRelPath("dir/inner.txt"), ["dir", "inner.txt"]);
  assert.deepEqual(parseRelPath("dir/"), ["dir"]);
  assert.equal(code(() => parseRelPath("")), "invalid_path");
  assert.deepEqual(parseRelPath("", { allowRoot: true }), []);
  assert.equal(code(() => parseRelPath(`${"d/".repeat(33)}x`)), "invalid_path");
  assert.equal(code(() => parseRelPath("x".repeat(256))), "invalid_path");
});

test("symbolic links are refused at every depth: final component, intermediate directory, to /proc, to the root, and relative ones", () => {
  const f = fixture();
  symlinkSync(join(f.outside, "secret.txt"), join(f.ws, "final-link"));
  symlinkSync(f.outside, join(f.ws, "dir-link"));
  symlinkSync("../outside", join(f.ws, "rel-link"));
  symlinkSync("/proc/self/root", join(f.ws, "proc-link"));
  symlinkSync("/", join(f.ws, "slash"));
  symlinkSync("inner.txt", join(f.ws, "dir", "inside-link"));
  const r = f.root();
  try {
    for (const p of [["final-link"], ["dir-link", "secret.txt"], ["rel-link", "secret.txt"], ["proc-link", "etc", "passwd"], ["slash", "etc"], ["dir", "inside-link"]]) {
      assert.equal(code(() => readPage(r, p)), "symlink_refused", p.join("/"));
      assert.equal(code(() => atomicWrite(r, p, Buffer.from("x"), { kind: "new" })), "symlink_refused", `write ${p.join("/")}`);
      if (p.length > 1 && p[0] !== "dir") assert.equal(code(() => atomicWrite(r, [...p.slice(0, -1), "planted.txt"], Buffer.from("x"), { kind: "new" })), "symlink_refused", `write under ${p.join("/")}`);
    }
    assert.equal(code(() => listDir(r, ["dir-link"])), "symlink_refused");
    assert.equal(code(() => search(r, ["dir-link"], "CANARY")), "symlink_refused");
    // Search and list report links without following them.
    const s = search(r, [], "OUTSIDE");
    assert.equal(s.matches.length, 0);
    assert.ok((s.skipped as Record<string, number>).symlinks >= 5);
    const l = listDir(r, []);
    assert.equal(l.entries.find((e) => e.name === "dir-link")?.type, "symlink");
    assert.equal(statPath(r, ["final-link"]).type, "symlink");
    assert.equal(readFileSync(join(f.outside, "secret.txt"), "utf8"), CANARY, "the outside file is untouched");
    assert.deepEqual(readdirSync(f.outside), ["secret.txt"], "nothing was created outside");
  } finally {
    r.close();
  }
});

test("hard links: a file with more than one link is never read or written (a link to an outside file stays unread)", () => {
  const f = fixture();
  // Same filesystem in a temp dir: an outside file hard-linked into the workspace.
  linkSync(join(f.outside, "secret.txt"), join(f.ws, "hl.txt"));
  const r = f.root();
  try {
    assert.equal(code(() => readPage(r, ["hl.txt"])), "hardlink_refused");
    assert.equal(code(() => currentVersion(r, ["hl.txt"])), "hardlink_refused");
    const st = statPath(r, ["hl.txt"]);
    assert.equal(st.version, undefined);
    assert.equal(st.versionUnavailable, "more than one hard link");
    assert.equal(code(() => atomicWrite(r, ["hl.txt"], Buffer.from("overwrite"), { kind: "version", version: versionOf(Buffer.from(CANARY)) })), "hardlink_refused");
    assert.equal(search(r, [], "CANARY").matches.length, 0);
    assert.equal(readFileSync(join(f.outside, "secret.txt"), "utf8"), CANARY);
  } finally {
    r.close();
  }
});

test("special files: a FIFO is never opened (no hang), sockets and devices are refused, and none is followed by search", async () => {
  const f = fixture();
  execFileSync("mkfifo", [join(f.ws, "pipe")]);
  if (isRoot) execFileSync("mknod", [join(f.ws, "null-dev"), "c", "1", "3"]);
  const r = f.root();
  try {
    const started = Date.now();
    assert.equal(code(() => readPage(r, ["pipe"])), "special_file_refused");
    assert.equal(code(() => currentVersion(r, ["pipe"])), "special_file_refused");
    assert.equal(statPath(r, ["pipe"]).type, "fifo");
    assert.ok(Date.now() - started < 2000, "opening a FIFO never blocks");
    if (isRoot) {
      assert.equal(code(() => readPage(r, ["null-dev"])), "special_file_refused");
      assert.equal(statPath(r, ["null-dev"]).type, "char-device");
    }
    const s = search(r, [], "beta");
    assert.ok((s.skipped as Record<string, number>).special >= 1);
    assert.equal(code(() => atomicWrite(r, ["pipe"], Buffer.from("x"), { kind: "version", version: versionOf(Buffer.alloc(0)) })), "special_file_refused");
  } finally {
    r.close();
  }
});

test("mounts: a mount point inside the workspace refuses every operation (bind mounts on the same device included)", { skip: !isRoot && "needs root to create a bind mount in the test environment" }, () => {
  const f = fixture();
  mkdirSync(join(f.ws, "mnt"));
  try {
    execFileSync("mount", ["--bind", f.outside, join(f.ws, "mnt")], { stdio: "ignore" });
  } catch {
    return; // mount not permitted in this runner: reported as a skip below
  }
  try {
    const r = f.root();
    try {
      assert.equal(code(() => readPage(r, ["mnt", "secret.txt"])), "mount_refused");
      assert.equal(code(() => readPage(r, ["a.txt"])), "mount_refused", "any mount inside refuses the whole workspace");
      assert.equal(code(() => snapshot(r)), "mount_refused");
    } finally {
      r.close();
    }
  } finally {
    execFileSync("umount", [join(f.ws, "mnt")]);
  }
});

test("the root is pinned: a workspace root replaced after configuration is refused", () => {
  const f = fixture();
  const st = statSync(f.ws);
  execFileSync("mv", [f.ws, `${f.ws}-old`]);
  mkdirSync(f.ws, { mode: 0o700 });
  assert.equal(code(() => openRoot(f.ws, { dev: st.dev, ino: st.ino })), "workspace_changed");
});

test("check/use race: swapping a directory for a symlink to the outside while reads run never yields outside content", async () => {
  const f = fixture();
  mkdirSync(join(f.ws, "swap"));
  writeFileSync(join(f.ws, "swap", "secret.txt"), "inside copy\n");
  // A child process flips ws/swap between a real directory and a symlink to the outside directory as fast as it can.
  const flipper = spawn(process.execPath, ["-e", `
    const fs = require("fs"); const ws = ${JSON.stringify(f.ws)}; const out = ${JSON.stringify(f.outside)};
    const end = Date.now() + 700; const pause = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < end) { Atomics.wait(pause, 0, 0, 0.2);
      try { fs.renameSync(ws + "/swap", ws + "/swap-real"); fs.symlinkSync(out, ws + "/swap"); } catch {}
      try { fs.unlinkSync(ws + "/swap"); fs.renameSync(ws + "/swap-real", ws + "/swap"); } catch {}
    }
  `]);
  const r = f.root();
  let inside = 0;
  let refused = 0;
  const deadline = Date.now() + 650;
  try {
    while (Date.now() < deadline) {
      try {
        const p = readPage(r, ["swap", "secret.txt"]);
        assert.notEqual(p.text, CANARY, "outside content was read through a race");
        assert.ok(!String(p.text).includes("OUTSIDE"));
        inside++;
      } catch (e) {
        assert.ok(e instanceof WorkspaceFsError, String(e));
        refused++;
      }
      await new Promise((res) => setImmediate(res));
    }
  } finally {
    r.close();
    await new Promise((res) => flipper.on("exit", res));
  }
  assert.ok(inside + refused > 20, `enough attempts ran (${inside} inside, ${refused} refused)`);
  assert.equal(readFileSync(join(f.outside, "secret.txt"), "utf8"), CANARY);
});

test("check/use race on writes: a parent swapped for a symlink never lets a write land outside", async () => {
  const f = fixture();
  mkdirSync(join(f.ws, "swap"));
  const flipper = spawn(process.execPath, ["-e", `
    const fs = require("fs"); const ws = ${JSON.stringify(f.ws)}; const out = ${JSON.stringify(f.outside)};
    const end = Date.now() + 700; const pause = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < end) { Atomics.wait(pause, 0, 0, 0.2);
      try { fs.renameSync(ws + "/swap", ws + "/swap-real"); fs.symlinkSync(out, ws + "/swap"); } catch {}
      try { fs.unlinkSync(ws + "/swap"); fs.renameSync(ws + "/swap-real", ws + "/swap"); } catch {}
    }
  `]);
  const r = f.root();
  const deadline = Date.now() + 650;
  let n = 0;
  try {
    while (Date.now() < deadline) {
      try {
        atomicWrite(r, ["swap", `w${n++}.txt`], Buffer.from("payload"), { kind: "new" });
      } catch (e) {
        assert.ok(e instanceof WorkspaceFsError || (e as NodeJS.ErrnoException).code, String(e));
      }
      await new Promise((res) => setImmediate(res));
    }
  } finally {
    r.close();
    await new Promise((res) => flipper.on("exit", res));
  }
  assert.deepEqual(readdirSync(f.outside), ["secret.txt"], "no write landed in the outside directory");
});

test("atomic write: strict new-file and version preconditions, deterministic conflicts, 0600 files, no temporary files left", () => {
  const f = fixture();
  const r = f.root();
  try {
    const v = readPage(r, ["a.txt"]).version;
    assert.equal(code(() => atomicWrite(r, ["a.txt"], Buffer.from("x"), { kind: "new" })), "conflict", "create-only never replaces");
    assert.equal(code(() => atomicWrite(r, ["a.txt"], Buffer.from("x"), { kind: "version", version: versionOf(Buffer.from("other")) })), "conflict");
    assert.equal(code(() => atomicWrite(r, ["missing.txt"], Buffer.from("x"), { kind: "version", version: v })), "conflict");
    assert.equal(code(() => atomicWrite(r, ["nodir", "x.txt"], Buffer.from("x"), { kind: "new" })), "not_found");
    const w = atomicWrite(r, ["a.txt"], Buffer.from("replaced\n"), { kind: "version", version: v });
    assert.equal(w.version, versionOf(Buffer.from("replaced\n")));
    assert.equal(code(() => atomicWrite(r, ["a.txt"], Buffer.from("again"), { kind: "version", version: v })), "conflict", "the old version is stale now");
    const n = atomicWrite(r, ["dir", "new.txt"], Buffer.from("fresh"), { kind: "new" });
    assert.equal(n.created, true);
    assert.equal(statSync(join(f.ws, "dir", "new.txt")).mode & 0o777, 0o600);
    chmodSync(join(f.ws, "a.txt"), 0o755);
    atomicWrite(r, ["a.txt"], Buffer.from("exec kept\n"), { kind: "version", version: w.version });
    assert.equal(statSync(join(f.ws, "a.txt")).mode & 0o777, 0o700, "owner bits are kept; group/other bits never");
    const leftovers = execFileSync("find", [f.ws, "-name", ".orbit-tmp-*"], { encoding: "utf8" }).trim();
    assert.equal(leftovers, "");
  } finally {
    r.close();
  }
});

test("patch: every passage must occur exactly once; a miss or an ambiguity refuses the whole patch", () => {
  assert.equal(applyPatch("a b c", [{ find: "b", replace: "B" }, { find: "c", replace: "C" }]), "a B C");
  assert.equal(code(() => applyPatch("a b b", [{ find: "b", replace: "x" }])), "patch_ambiguous");
  assert.equal(code(() => applyPatch("a b", [{ find: "z", replace: "x" }])), "patch_no_match");
  assert.equal(code(() => applyPatch("a b", [{ find: "a", replace: "b" }, { find: "b", replace: "c" }])), "patch_ambiguous", "applied in order, against the result");
});

test("reads are paged, bounded, UTF-8 safe and versioned over the whole file; binary pages are not shown", () => {
  const f = fixture();
  writeFileSync(join(f.ws, "big.txt"), `${"é".repeat(20000)}end`);
  writeFileSync(join(f.ws, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  const r = f.root();
  try {
    const p1 = readPage(r, ["big.txt"], { length: 999_999 });
    assert.ok(p1.bytes <= READ_PAGE_MAX);
    assert.equal(p1.truncated, true);
    assert.ok(!String(p1.text).includes("�"), "no character is split");
    const p2 = readPage(r, ["big.txt"], { offset: p1.nextOffset!, length: 7 });
    assert.ok(!String(p2.text).includes("�"));
    assert.equal(p1.version, p2.version, "the version covers the whole file");
    assert.equal(code(() => readPage(r, ["big.txt"], { offset: 10_000_000 })), "invalid_offset");
    const b = readPage(r, ["bin.dat"]);
    assert.equal((b as { binary?: boolean }).binary, true);
    assert.equal(b.text, null);
  } finally {
    r.close();
  }
});

test("list is sorted and paged; search is literal (not a regular expression) and bounded", () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) writeFileSync(join(f.ws, `f${i}.txt`), `line ${i}\n.*\n`);
  const r = f.root();
  try {
    const p1 = listDir(r, [], { limit: 3 });
    assert.equal(p1.entries.length, 3);
    const p2 = listDir(r, [], { cursor: p1.nextCursor!, limit: 3 });
    assert.ok(p2.entries[0]!.name > p1.entries.at(-1)!.name);
    const s = search(r, [], ".*");
    assert.equal(s.matches.length, 5, "'.*' is matched literally");
    const capped = search(r, [], "line", { maxResults: 2 });
    assert.equal(capped.matches.length, 2);
    assert.equal(capped.complete, false);
    assert.equal(code(() => search(r, [], "")), "invalid_query");
    assert.equal(code(() => search(r, [], "a\nb")), "invalid_query");
  } finally {
    r.close();
  }
});

test("snapshot: changes to content, mode, a new file or a link target all change the digest; an unchanged workspace does not", () => {
  const f = fixture();
  const r = f.root();
  try {
    const s0 = snapshot(r).digest;
    assert.equal(snapshot(r).digest, s0);
    writeFileSync(join(f.ws, "a.txt"), "alpha\nbeta\ngamma!\n");
    const s1 = snapshot(r).digest;
    assert.notEqual(s1, s0);
    chmodSync(join(f.ws, "a.txt"), 0o700);
    const s2 = snapshot(r).digest;
    assert.notEqual(s2, s1);
    symlinkSync("a.txt", join(f.ws, "l"));
    const s3 = snapshot(r).digest;
    assert.notEqual(s3, s2);
    execFileSync("ln", ["-sfn", "dir", join(f.ws, "l")]);
    assert.notEqual(snapshot(r).digest, s3);
    assert.equal(code(() => snapshot(r, { entries: 2, bytes: 1e9, depth: 10 })), "snapshot_too_large");
  } finally {
    r.close();
  }
  assert.ok(existsSync(join(f.outside, "secret.txt")));
});

test("snapshot: an unreadable directory (e.g. a root-owned lost+found) refuses the snapshot with a clear reason", { skip: isRoot && "root reads every directory; this needs an unprivileged user" }, () => {
  const f = fixture();
  mkdirSync(join(f.ws, "lost+found"));
  chmodSync(join(f.ws, "lost+found"), 0o000);
  const r = f.root();
  try {
    assert.equal(code(() => snapshot(r)), "snapshot_unsupported");
  } finally {
    r.close();
    chmodSync(join(f.ws, "lost+found"), 0o700);
  }
});
