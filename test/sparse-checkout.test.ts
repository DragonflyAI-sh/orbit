import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

// A synthetic repository shaped like the vault, used to check what the Routine's sparse paths really check out
// (deploy/routines/orbit-jobs.md, "What the sparse paths actually check out"). Local git only; nothing real.
const PATHS = ["AGENTS.md", "System/", "Projects/orbit-next.md", "Resources/orbit-next-*", "Tasks/orbit-next-*"];
const FILES = [
  "AGENTS.md", "README.md", "home.md", "now.md", "System/conventions.md", "System/sub/deep.md",
  "Projects/orbit-next.md", "Projects/other.md", "Projects/sub/inner.md",
  "Resources/orbit-next-a.md", "Resources/other.md", "Resources/sub/inner.md", "Resources/sub/deeper/z.md",
  "Tasks/orbit-next-t.md", "Tasks/other.md", "Tasks/sub/inner.md",
  "Journal/2026/j.md", "Memory/m.md", "Log/2026/l.md", "Inbox/i.md", "Machines/m.md", "Areas/a.md", "Archive/old.md", "scripts/s.sh",
];
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });

function source() {
  const root = mkdtempSync(join(tmpdir(), "orbit-sparse-"));
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  for (const f of FILES) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    writeFileSync(join(src, f), "x\n");
  }
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "seed");
  return { root, src };
}

function checkout(setArgs: string[]): { files: string[]; set: ReturnType<typeof spawnSync> } {
  const { root, src } = source();
  const dir = join(root, "c");
  git(root, "clone", "-q", "--no-checkout", src, dir);
  const set = spawnSync("git", ["sparse-checkout", "set", ...setArgs], { cwd: dir, env, encoding: "utf8" });
  git(dir, "checkout", "-q", "main");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === ".git") continue;
      const p = join(d, e);
      statSync(p).isDirectory() ? walk(p) : files.push(relative(dir, p));
    }
  };
  walk(dir);
  return { files: files.sort(), set };
}

const topLevel = (names: string[], dir: string) => names.filter((f) => f.startsWith(`${dir}/`) && f.split("/").length === 2).sort();

test("the Routine's sparse paths, as git cone mode applies them: root files, System/ recursively, top-level notes of Projects/Resources/Tasks, no subfolders", (t) => {
  const { files, set } = checkout(["--skip-checks", ...PATHS]);
  if (set.status !== 0 && /unknown option|--skip-checks/.test(String(set.stderr))) return t.skip("this git has no --skip-checks");
  assert.equal(set.status, 0, String(set.stderr));
  const expected = [
    ...FILES.filter((f) => !f.includes("/")),
    ...FILES.filter((f) => f.startsWith("System/")),
    ...topLevel(FILES, "Projects"),
    ...topLevel(FILES, "Resources"),
    ...topLevel(FILES, "Tasks"),
  ].sort();
  assert.deepEqual(files, expected);
  // Left out: every subfolder of the three, and every other folder.
  for (const gone of ["Projects/sub/inner.md", "Resources/sub/inner.md", "Resources/sub/deeper/z.md", "Tasks/sub/inner.md", "Journal/2026/j.md", "Memory/m.md", "Log/2026/l.md", "Inbox/i.md", "Machines/m.md", "Areas/a.md", "Archive/old.md", "scripts/s.sh"]) assert.ok(!files.includes(gone), gone);
  // The wildcard and file entries select nothing by themselves: notes that do not match `orbit-next` are checked out too.
  assert.ok(files.includes("Resources/other.md") && files.includes("Tasks/other.md") && files.includes("Projects/other.md"));
});

test("plain `set` refuses these paths as patterns, and a leading slash is refused in cone mode", () => {
  const plain = checkout(PATHS);
  assert.notEqual(plain.set.status, 0);
  assert.match(String(plain.set.stderr), /specify directories rather than patterns/);
  const slash = checkout(["/AGENTS.md", "/System/"]);
  assert.notEqual(slash.set.status, 0);
  assert.match(String(slash.set.stderr), /no leading slash/);
});

test("a plain folder list would widen the checkout to every Resources subfolder; a non-cone checkout would be narrower than the configuration", () => {
  const folders = checkout(["System/", "Projects/", "Resources/", "Tasks/"]).files;
  for (const f of ["Resources/sub/inner.md", "Resources/sub/deeper/z.md", "Projects/sub/inner.md", "Tasks/sub/inner.md"]) assert.ok(folders.includes(f), f);
  assert.ok(!folders.includes("Journal/2026/j.md"));
  const noCone = checkout(["--no-cone", ...PATHS]).files;
  assert.deepEqual(noCone, ["AGENTS.md", "Projects/orbit-next.md", "Resources/orbit-next-a.md", "System/conventions.md", "System/sub/deep.md", "Tasks/orbit-next-t.md"]);
});

test("the Routine file records exactly these paths", () => {
  const doc = readFileSync(new URL("../deploy/routines/orbit-jobs.md", import.meta.url), "utf8");
  assert.ok(doc.includes(`\`${JSON.stringify(PATHS)}\``));
  assert.ok(doc.includes("/home/user/orbit-vault") && doc.includes("https://github.com/phairow/orbit-vault"));
});
