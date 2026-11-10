import assert from "node:assert/strict";
import { readFileSync, readdirSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VaultError, parseEdit } from "../src/vault/edit.ts";
import type { VaultEdit } from "../src/vault/edit.ts";
import { TOKEN, git, makeFixture } from "./vault-fixture.ts";

const fixedNow = () => new Date("2026-11-10T18:05:00Z");
const E = (op: string, a: Record<string, unknown>): VaultEdit => parseEdit(op, a);
const direct = { kind: "direct" } as const;
const meta = { actor: "test" };

async function rejects(p: Promise<unknown>, code: string, match?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof VaultError, `expected VaultError, got ${String(e)}`);
    assert.equal(e.code, code, (e as Error).message);
    if (match) assert.match(e.message, match);
    return true;
  });
}

test("direct writes: all five operations commit, push, log in the same commit and verify on the remote", async () => {
  const fx = makeFixture();
  const clone = fx.make({ now: fixedNow });

  const created = await clone.write([E("create_note", { path: "Projects/beta.md", content: "# Beta\n\n## Notes\n" })], direct, meta);
  assert.equal(created.status, "committed");
  assert.equal(created.verifiedOnRemote, true);
  assert.equal(created.commit, fx.remoteHead());
  assert.equal(created.logFile, "Log/2026/2026-11-10-orbit.md");
  assert.deepEqual(new Set(created.files), new Set(["Projects/beta.md", "Log/2026/2026-11-10-orbit.md"]));
  // The log line is in the SAME commit as the note.
  const showed = git(fx.remote, "show", "--name-only", "--format=%an <%ae>", created.commit);
  assert.match(showed, /^ORBIT <orbit@users\.noreply\.github\.com>/);
  assert.match(showed, /Projects\/beta\.md/);
  assert.match(showed, /Log\/2026\/2026-11-10-orbit\.md/);
  assert.match(fx.remoteFile("Log/2026/2026-11-10-orbit.md"), /- 10:05 orbit: created Projects\/beta\.md \(test\)/);

  await clone.write([E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text: "- second" })], direct, meta);
  assert.match(fx.remoteFile("Projects/alpha.md"), /## Notes\n- first\n- second\n\n## Plan/);

  await clone.write([E("replace_text", { path: "Tasks/todo.md", find: "- [ ] one", replace: "- [x] one" })], direct, meta);
  assert.equal(fx.remoteFile("Tasks/todo.md"), "# Todo\n- [x] one\n");

  await clone.write([E("set_frontmatter", { path: "Projects/alpha.md", key: "status", value: "paused" })], direct, meta);
  assert.match(fx.remoteFile("Projects/alpha.md"), /^---\nstatus: paused\ntags: \[project\]\n---\n/);

  const moved = await clone.write([E("archive_note", { path: "Tasks/todo.md" })], direct, meta);
  assert.ok(moved.files.includes("Archive/Tasks/todo.md"));
  assert.equal(fx.remoteFile("Archive/Tasks/todo.md"), "# Todo\n- [x] one\n");
  assert.throws(() => fx.remoteFile("Tasks/todo.md"));
  // A second write the same day appends to the same log file; every commit is by ORBIT.
  const log = fx.remoteFile("Log/2026/2026-11-10-orbit.md");
  assert.equal(log.split("\n").filter((l) => l.startsWith("- ")).length, 5);
  assert.ok(fx.remoteLog().split("\n").filter((l) => l.includes("ORBIT")).length >= 5);
});

test("protected and unlisted paths are refused as direct writes; confirmed mode does not widen what is allowed", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  for (const [op, a] of [
    ["replace_text", { path: "AGENTS.md", find: "Section 3", replace: "Section X" }],
    ["create_note", { path: "System/new.md", content: "x" }],
    ["create_note", { path: "system/new.md", content: "x" }],
    ["create_note", { path: ".obsidian/app.json", content: "{}" }],
    ["create_note", { path: "scripts/run.md", content: "x" }],
    ["create_note", { path: "Journal/2026/new.md", content: "x" }],
    ["replace_text", { path: "Journal/2026/2026-11-09.md", find: "quiet day", replace: "loud day" }],
    ["append_section", { path: "Journal/2026/2026-11-09.md", heading: "## Reflections", text: "more" }],
    ["replace_text", { path: "Projects/secret-rai.md", find: "do not touch", replace: "changed" }],
    ["create_note", { path: "Projects/new.md", content: "contains #rai tag" }],
    ["set_frontmatter", { path: "Projects/alpha.md", key: "tags", value: ["project", "rai"] }],
    ["create_note", { path: "Resources/health.md", content: "My therapist prescribed medication." }],
  ] as const) {
    await rejects(clone.write([E(op, a as Record<string, unknown>)], direct, meta), "needs_confirmation");
  }
  // Not confirmable at all: outside the areas, Archive/ directly, hidden/odd paths.
  for (const [op, a] of [
    ["create_note", { path: "Elsewhere/x.md", content: "x" }],
    ["create_note", { path: "Archive/x.md", content: "x" }],
    ["create_note", { path: "Projects/x.txt", content: "x" }],
    ["create_note", { path: "root-note.md", content: "x" }],
  ] as const) {
    await rejects(clone.write([E(op, a as Record<string, unknown>)], { kind: "confirmed", reasons: ["whatever"] }, meta), "policy_refused");
  }
  for (const bad of ["../x.md", "Projects/../System/x.md", "/etc/x.md", "Projects//x.md", "Projects/.git/x.md", "Projects/.hidden.md", "Projects\\x.md", "Projects/-x.md", "Projects/a\u0000.md", "a/b/c/d/e/f/g/h/i.md", "Projects/x:y.md"]) {
    assert.throws(() => E("create_note", { path: bad, content: "x" }), (e: unknown) => e instanceof VaultError && e.code === "invalid_path", bad);
  }
  assert.equal(fx.remoteHead(), git(fx.work, "rev-parse", "HEAD").trim(), "nothing was pushed");
});

test("Journal plan sections can be appended directly; confirmed mode runs only the exact reasons shown", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const planAppend = E("append_section", { path: "Journal/2026/2026-11-09.md", heading: "## Plan", text: "- call the dentist" });
  const r = await clone.write([planAppend], direct, meta);
  assert.equal(r.verifiedOnRemote, true);
  assert.match(fx.remoteFile("Journal/2026/2026-11-09.md"), /- ship it\n- call the dentist\n\n## Reflections/);

  const edit = E("replace_text", { path: "AGENTS.md", find: "Section 3", replace: "Section Three" });
  const err = await clone.write([edit], direct, meta).catch((e) => e as VaultError);
  assert.equal((err as VaultError).code, "needs_confirmation");
  const reasons = (err as VaultError).details;
  // Confirmed with other reasons: refused (the change was not what the card showed).
  await rejects(clone.write([edit], { kind: "confirmed", reasons: ["something else"] }, meta), "policy_refused");
  // Confirmed with the reasons that were shown: runs, still through the same pipeline and log line.
  const done = await clone.write([edit], { kind: "confirmed", reasons }, meta);
  assert.equal(done.verifiedOnRemote, true);
  assert.match(fx.remoteFile("AGENTS.md"), /Section Three/);
  assert.match(fx.remoteFile(done.logFile), /replaced a passage in AGENTS\.md/);
});

test("secret-shaped content is refused, never redacted into a commit", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const before = fx.remoteHead();
  for (const text of ["tok" + "en = " + "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123", "pass" + "word: " + "hunter2hunter2", "sk" + "-" + "abcdefghijklmnop1234", "-----BEGIN " + "PRIVATE KEY-----\nabc\n-----END " + "PRIVATE KEY-----", "routine " + "tri" + "g_" + "01ABCDEFGHIJKLMNOP", "Zq".repeat(20)]) {
    await rejects(clone.write([E("create_note", { path: "Projects/leak.md", content: text })], direct, meta), "secret_refused", /Nothing was written/);
    await rejects(clone.write([E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text })], direct, meta), "secret_refused");
  }
  assert.equal(fx.remoteHead(), before);
  assert.throws(() => fx.remoteFile("Projects/leak.md"));
});

test("exact replacement stays exact: missing, repeated and stale passages fail without writing", async () => {
  const fx = makeFixture({ ...{ "AGENTS.md": "# r\n" }, "Tasks/dup.md": "x\nx\n", "Tasks/one.md": "alpha beta\n" });
  const clone = fx.make();
  await rejects(clone.write([E("replace_text", { path: "Tasks/one.md", find: "alpha  beta", replace: "z" })], direct, meta), "precondition_failed", /exact/);
  await rejects(clone.write([E("replace_text", { path: "Tasks/dup.md", find: "x", replace: "y" })], direct, meta), "precondition_failed", /2 times/);
  await rejects(clone.write([E("replace_text", { path: "Tasks/gone.md", find: "x", replace: "y" })], direct, meta), "precondition_failed", /does not exist/);
  await rejects(clone.write([E("append_section", { path: "Tasks/one.md", heading: "## Nope", text: "x" })], direct, meta), "precondition_failed", /No heading/);
  await rejects(clone.write([E("create_note", { path: "Tasks/one.md", content: "overwrite" })], direct, meta), "precondition_failed", /never overwrites/);
  assert.equal(fx.remoteFile("Tasks/one.md"), "alpha beta\n");
});

test("competing remote change in another file: ORBIT rereads, reapplies once and pushes without force", async () => {
  const fx = makeFixture();
  let raced = false;
  const clone = fx.make({
    beforePush: (attempt) => {
      if (attempt === 1 && !raced) {
        raced = true;
        fx.elsewhere({ "Resources/other.md": "someone else wrote this\n" }, "competing change");
      }
    },
  });
  const r = await clone.write([E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text: "- from orbit" })], direct, meta);
  assert.equal(r.attempts, 2);
  assert.equal(r.verifiedOnRemote, true);
  assert.equal(fx.remoteFile("Resources/other.md"), "someone else wrote this\n", "the other change is kept");
  assert.match(fx.remoteFile("Projects/alpha.md"), /- from orbit/);
  // History is linear and contains the competing commit: nothing was force-pushed over it.
  assert.match(fx.remoteLog(), /competing change/);
});

test("competing change to the same passage: reapply fails safely and reports the file", async () => {
  const fx = makeFixture();
  let raced = false;
  const clone = fx.make({
    beforePush: () => {
      if (!raced) {
        raced = true;
        fx.elsewhere({ "Tasks/todo.md": "# Todo\n- [x] one (done by Rai)\n" }, "rai edits todo");
      }
    },
  });
  const before = fx.remoteHead();
  const err = await clone.write([E("replace_text", { path: "Tasks/todo.md", find: "- [ ] one", replace: "- [x] one" })], direct, meta).catch((e) => e as VaultError);
  assert.equal((err as VaultError).code, "conflict");
  assert.deepEqual((err as VaultError).details, ["Tasks/todo.md"]);
  assert.match((err as VaultError).message, /Nothing was pushed/);
  assert.match(fx.remoteFile("Tasks/todo.md"), /done by Rai/);
  assert.notEqual(fx.remoteHead(), before, "Rai's commit is the head; ORBIT added nothing");
  assert.doesNotMatch(fx.remoteLog().split("\n")[0]!, /ORBIT/);
});

test("a persistent race stops after one retry with an explicit file report, never forcing", async () => {
  const fx = makeFixture();
  let n = 0;
  const clone = fx.make({
    beforePush: () => {
      n++;
      fx.elsewhere({ "Tasks/todo.md": `# Todo\n- [ ] one\n- race ${n}\n`, "Projects/beta.md": `race ${n}\n` }, `race ${n}`);
    },
  });
  const err = await clone.write([E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text: "- mine" })], direct, meta).catch((e) => e as VaultError);
  assert.equal((err as VaultError).code, "conflict");
  assert.equal(n, 2, "one reapply, then stop");
  assert.match((err as VaultError).message, /stopped after one retry/);
  assert.ok((err as VaultError).details.length > 0);
  assert.ok(fx.remoteLog().includes("race 2"), "the other side's last commit is intact");
  assert.doesNotMatch(fx.remoteFile("Projects/alpha.md"), /- mine/);
  // The clone does not keep ORBIT's unpushed commit around.
  assert.equal(git(fx.cloneDir, "status", "--porcelain").trim(), "");
});

test("the credential never appears in the clone's config, git output, errors or result", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const r = await clone.write([E("create_note", { path: "Inbox/note.md", content: "hello" })], direct, meta);
  const seen = [JSON.stringify(r), JSON.stringify(clone.state())];
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(join(fx.cloneDir, ".git"))) {
    const text = readFileSync(f, "latin1");
    assert.ok(!text.includes(TOKEN) && !text.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64")), `${f} holds the credential`);
  }
  assert.equal(git(fx.cloneDir, "config", "--get", "remote.origin.url").trim(), fx.remote);
  // A failure message is scrubbed too: point the clone at a remote that fails.
  const broken = fx.make({ dir: join(fx.root, "other-clone"), remote: join(fx.root, "missing.git") });
  const err = await broken.write([E("create_note", { path: "Inbox/n.md", content: "x" })], direct, meta).catch((e) => e as Error);
  seen.push(String((err as Error).message), JSON.stringify(broken.state()));
  assert.ok(seen.every((s) => !s.includes(TOKEN)));
  assert.equal((err as VaultError).code, "sync_failed");
});

test("without the credential nothing is written and the error says why", async () => {
  const fx = makeFixture();
  const clone = fx.make({ credential: () => undefined });
  await rejects(clone.write([E("create_note", { path: "Inbox/n.md", content: "x" })], direct, meta), "auth_unavailable", /not available/);
  await rejects(clone.sync(), "auth_unavailable");
  assert.equal(clone.state().credential, "missing");
  assert.equal(clone.state().clone, "absent");
});

test("a missing AGENTS.md fails closed", async () => {
  const fx = makeFixture({ "Projects/a.md": "# a\n" });
  const clone = fx.make();
  await rejects(clone.write([E("append_section", { path: "Projects/a.md", heading: "# a", text: "x" })], direct, meta), "policy_unavailable");
});

test("symlinks in the clone are refused, not followed", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  await clone.sync();
  // A symlink on the remote (committed by someone else) pointing outside the vault.
  mkdirSync(join(fx.work, "Projects"), { recursive: true });
  writeFileSync(join(fx.root, "outside.md"), "outside\n");
  symlinkSync(join(fx.root, "outside.md"), join(fx.work, "Projects", "link.md"));
  symlinkSync(join(fx.root, "state"), join(fx.work, "Areas"));
  git(fx.work, "add", "-A");
  git(fx.work, "commit", "-q", "-m", "symlinks");
  git(fx.work, "push", "-q", "origin", "main");
  await rejects(clone.write([E("replace_text", { path: "Projects/link.md", find: "outside", replace: "x" })], direct, meta), "policy_refused", /symbolic link/);
  await rejects(clone.write([E("create_note", { path: "Areas/new.md", content: "x" })], direct, meta), "policy_refused", /symbolic link/);
  assert.equal(readFileSync(join(fx.root, "outside.md"), "utf8"), "outside\n");
});

test("serialization: concurrent writes all land, one at a time", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const results = await Promise.all(["a", "b", "c", "d"].map((n) => clone.write([E("create_note", { path: `Inbox/${n}.md`, content: n })], direct, meta)));
  assert.equal(new Set(results.map((r) => r.commit)).size, 4);
  for (const n of ["a", "b", "c", "d"]) assert.equal(fx.remoteFile(`Inbox/${n}.md`), `${n}\n`);
  assert.equal(fx.remoteFile(results[0]!.logFile).split("\n").filter((l) => l.startsWith("- ")).length, 4);
});

test("archive keeps the folder structure, never overwrites, and only moves notes ORBIT may move", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  await rejects(clone.write([E("archive_note", { path: "now.md" })], direct, meta), "policy_refused");
  await rejects(clone.write([E("archive_note", { path: "AGENTS.md" })], direct, meta), "policy_refused");
  await rejects(clone.write([E("archive_note", { path: "System/memory.md" })], direct, meta), "policy_refused");
  await rejects(clone.write([E("archive_note", { path: "Projects/secret-rai.md" })], direct, meta), "needs_confirmation");
  await rejects(clone.write([E("archive_note", { path: "Journal/2026/2026-11-09.md" })], direct, meta), "needs_confirmation");
  await clone.write([E("archive_note", { path: "Projects/alpha.md" })], direct, meta);
  await clone.write([E("create_note", { path: "Projects/alpha.md", content: "again" })], direct, meta);
  await rejects(clone.write([E("archive_note", { path: "Projects/alpha.md" })], direct, meta), "precondition_failed", /already exists/);
});
