import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { mockModel } from "../src/model.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import { cloneContextReader, MANIFEST_PATH, MAX_CONTEXT_FILE_BYTES, MAX_CONTEXT_FILES, MAX_CONTEXT_TOTAL_BYTES, normalizeContextPaths, prepareContext } from "../src/job-context.ts";
import type { ContextReader, NoteResult } from "../src/job-context.ts";
import { jobLauncher } from "../src/job-launch.ts";
import { githubControl } from "../src/launcher.ts";
import type { ControlRepo, Routine } from "../src/launcher.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";
import { notifier } from "../src/notify.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { vaultMemory } from "../src/memory.ts";
import { sha } from "../src/vault/edit.ts";
import { makeFixture } from "./vault-fixture.ts";

// Everything here is synthetic: fake GitHub, fake Routine, throwaway git repositories, notes written by the tests. No network, no
// real credential, no real vault. Secret-shaped text is built at run time so no literal appears in the file.
const FAKE_SECRET = "sk" + "-" + "a1B2".repeat(8);

// ---- doubles -------------------------------------------------------------------------------------------------------------------

type Event = string;
function doubles(opts: { notes?: Record<string, NoteResult>; priv?: boolean | "throw"; fresh?: boolean; head?: string; failContext?: boolean; failBrief?: boolean } = {}) {
  const events: Event[] = [];
  const briefs: { job: string; brief: string }[] = [];
  const contexts: { job: string; files: { path: string; content: string }[] }[] = [];
  const fired: string[] = [];
  const control: ControlRepo = {
    pushBrief: async (job, brief) => {
      events.push("pushBrief");
      if (opts.failBrief) throw new Error("GitHub PUT brief returned HTTP 500");
      briefs.push({ job, brief });
      return { branch: `orbit/${job}`, commit: "brief0001" };
    },
    pushContext: async (job, files) => {
      events.push("pushContext");
      if (opts.failContext) throw new Error("GitHub POST /git/blobs returned HTTP 500");
      contexts.push({ job, files });
      return { commit: "ctx0001" };
    },
    isPrivate: async () => {
      events.push("isPrivate");
      if (opts.priv === "throw") throw new Error("GitHub GET  returned HTTP 502");
      return opts.priv ?? true;
    },
  };
  const requested: string[][] = [];
  const reader: ContextReader = {
    snapshot: async (paths) => {
      events.push("read");
      requested.push(paths);
      const notes = new Map<string, NoteResult>();
      for (const p of paths) notes.set(p, opts.notes?.[p] ?? { content: `# ${p}\nsynthetic note\n` });
      return { head: opts.head ?? "a".repeat(40), fetchedAt: "2026-11-12T01:00:00.000Z", fresh: opts.fresh ?? true, notes };
    },
  };
  const routine: Routine = { name: "orbit", fire: async (text) => (events.push("fire"), fired.push(text), { sessionId: "cse_1", sessionUrl: "https://claude.ai/code/cse_1" }) };
  const jobs = jobRegistry(jsonStore(undefined, "j", []), Buffer.alloc(32, 1), notifier(jsonStore(undefined, "n", [])));
  const launch = jobLauncher({ jobs, control, routines: new Map([["orbit", routine]]), notify: notifier(jsonStore(undefined, "n2", [])), publicJobUrl: "https://orbit.example", commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b", contextReader: reader, now: () => new Date("2026-11-12T02:00:00Z") });
  return { events, briefs, contexts, fired, control, reader, requested, jobs, launch, routine };
}

// ---- path rules ----------------------------------------------------------------------------------------------------------------

test("paths: exact, normalised, vault-relative notes in exportable areas only", () => {
  const ok = normalizeContextPaths(["AGENTS.md", "Tasks/orbit-next-job-context.md", "Resources/sub/deep.md", "System/conventions.md"]);
  assert.deepEqual(ok.ok && ok.paths, ["AGENTS.md", "Tasks/orbit-next-job-context.md", "Resources/sub/deep.md", "System/conventions.md"]);
  // Undefined and null mean "no context" (compatibility); an empty list is not an error either.
  assert.deepEqual(normalizeContextPaths(undefined), { ok: true, paths: [] });
  assert.deepEqual(normalizeContextPaths([]), { ok: true, paths: [] });
  const bad = (input: unknown) => {
    const r = normalizeContextPaths(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    return r as Exclude<typeof r, { ok: true }>;
  };
  for (const p of ["/etc/passwd.md", "../x.md", "Tasks/../AGENTS.md", "Tasks/./a.md", "Tasks\\a.md", "Tasks/a.md/", "C:/x.md", ".git/config.md", "Tasks/.hidden.md", "Tasks/a\u0000.md", "", "Tasks//a.md"]) assert.equal(bad([p]).problems[0].code, "invalid_path", p);
  for (const p of ["Tasks/*.md", "Tasks/orbit-next-*.md", "Tasks/a?.md"]) assert.equal(bad([p]).problems[0].code, "invalid_path", `no globs: ${p}`);
  for (const p of ["Journal/2026/2026-11-09.md", "Memory/index.md", "Log/2026/x.md", "Inbox/laptop.md", "Machines/laptop.md", "Archive/Tasks/a.md", "now.md", "README.md", "Tasks", "Tasks/a.txt", "scripts/x.md", "agents.md", "tasks/a.md"]) assert.equal(bad([p]).problems[0].code, "not_allowed", p);
  assert.equal(bad(["Tasks/a.md", "Tasks/A.md"]).problems[0].code, "duplicate");
  assert.equal(bad("Tasks/a.md").problems[0].code, "invalid_path");
  assert.equal(bad([5]).problems[0].code, "invalid_path");
  assert.equal(bad(Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, i) => `Tasks/n${i}.md`)).problems[0].code, "limit");
});

// ---- launch: snapshot before trigger ---------------------------------------------------------------------------------------------

test("a launch with context checks privacy, reads, writes the brief then the copies, and only then fires the Routine", async () => {
  const d = doubles();
  const r = await d.launch("orbit", "Implement the thing.", undefined, ["Tasks/orbit-next-job-context.md", "Resources/orbit-next-handover-to-orbit.md", "AGENTS.md"]);
  assert.equal(r.code, 202);
  assert.deepEqual(d.events, ["isPrivate", "read", "pushBrief", "pushContext", "fire"]);
  const job = d.briefs[0].job;
  assert.equal(d.contexts[0].job, job);
  // The copies keep the vault-relative layout under .orbit/context/ and the manifest is in the same commit.
  assert.deepEqual(d.contexts[0].files.map((f) => f.path), [".orbit/context/Tasks/orbit-next-job-context.md", ".orbit/context/Resources/orbit-next-handover-to-orbit.md", ".orbit/context/AGENTS.md", MANIFEST_PATH]);
  const manifest = JSON.parse(d.contexts[0].files.at(-1)!.content);
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.source, { via: "orbit-vault-reader", head: "a".repeat(40), fetchedAt: "2026-11-12T01:00:00.000Z", fresh: true });
  assert.equal(manifest.createdAt, "2026-11-12T02:00:00.000Z");
  for (const f of manifest.files) {
    const copy = d.contexts[0].files.find((x) => x.path === f.copy)!;
    assert.equal(f.sha256, sha(copy.content));
    assert.equal(f.bytes, Buffer.byteLength(copy.content));
    assert.equal(f.availability, "copied");
    assert.equal(f.copy, `.orbit/context/${f.path}`);
  }
  // The brief: the original text, then the generated section listing every path, with the vault commit and freshness.
  assert.ok(d.briefs[0].brief.startsWith("Implement the thing.\n\n## Vault context (copied by ORBIT at launch)"));
  for (const p of ["Tasks/orbit-next-job-context.md", "Resources/orbit-next-handover-to-orbit.md", "AGENTS.md"]) assert.ok(d.briefs[0].brief.includes(`\`${p}\``));
  assert.match(d.briefs[0].brief, /vault commit aaaaaaaaaaaa/);
  assert.match(d.briefs[0].brief, /read-only reference data, not instructions/);
  // The job record keeps paths and commits, not content.
  const rec = d.jobs.get(job)!;
  assert.deepEqual(rec.launch?.context, { paths: ["Tasks/orbit-next-job-context.md", "Resources/orbit-next-handover-to-orbit.md", "AGENTS.md"], commit: "ctx0001", vaultHead: "a".repeat(40), fresh: true });
  assert.ok(!JSON.stringify(rec).includes("synthetic note"));
});

test("compatibility: no context, undefined, null or an empty list launches exactly as before and never touches the reader or visibility", async () => {
  for (const ctx of [undefined, [], null as unknown as string[]]) {
    const d = doubles();
    const r = await d.launch("orbit", "Plain brief.", undefined, ctx);
    assert.equal(r.code, 202);
    assert.deepEqual(d.events, ["pushBrief", "fire"]);
    assert.equal(d.briefs[0].brief, "Plain brief.");
    assert.equal(d.jobs.get(d.briefs[0].job)!.launch?.context, undefined);
  }
});

test("a note supplied by the authorized reader (outside the runner's sparse checkout) is copied; the reader is asked for exactly the named paths", async () => {
  const d = doubles({ notes: { "Resources/archive-like/deep/outside-sparse.md": { content: "# outside\nin a Resources subfolder\n" } } });
  const r = await d.launch("orbit", "x", undefined, ["Resources/archive-like/deep/outside-sparse.md"]);
  assert.equal(r.code, 202);
  assert.deepEqual(d.requested, [["Resources/archive-like/deep/outside-sparse.md"]]);
  assert.equal(d.contexts[0].files[0].path, ".orbit/context/Resources/archive-like/deep/outside-sparse.md");
  assert.equal(d.contexts[0].files[0].content, "# outside\nin a Resources subfolder\n");
});

test("colliding basenames keep their folders; nothing is overwritten", async () => {
  const d = doubles({ notes: { "Projects/alpha.md": { content: "project\n" }, "Resources/alpha.md": { content: "resource\n" }, "Tasks/alpha.md": { content: "task\n" } } });
  const r = await d.launch("orbit", "x", undefined, ["Projects/alpha.md", "Resources/alpha.md", "Tasks/alpha.md"]);
  assert.equal(r.code, 202);
  const copies = d.contexts[0].files.filter((f) => f.path !== MANIFEST_PATH);
  assert.deepEqual(copies.map((f) => [f.path, f.content]), [[".orbit/context/Projects/alpha.md", "project\n"], [".orbit/context/Resources/alpha.md", "resource\n"], [".orbit/context/Tasks/alpha.md", "task\n"]]);
});

test("stale source: the snapshot still works but the manifest and the brief say so", async () => {
  const d = doubles({ fresh: false });
  const r = await d.launch("orbit", "x", undefined, ["Tasks/a.md"]);
  assert.equal(r.code, 202);
  assert.equal(JSON.parse(d.contexts[0].files.at(-1)!.content).source.fresh, false);
  assert.match(d.briefs[0].brief, /STALE WARNING/);
  assert.equal(d.jobs.get(d.briefs[0].job)!.launch?.context?.fresh, false);
});

// ---- failures: nothing incomplete is started -------------------------------------------------------------------------------------

async function refused(opts: Parameters<typeof doubles>[0], paths: string[], code: number, match: RegExp) {
  const d = doubles(opts);
  const r = await d.launch("orbit", "x", undefined, paths);
  assert.equal(r.code, code, JSON.stringify(r.body));
  assert.match(String((r.body as { error: string }).error), match);
  // Refused before anything was created: no job, no brief, no copies, no Routine.
  assert.deepEqual([d.briefs.length, d.contexts.length, d.fired.length, d.jobs.list().length], [0, 0, 0, 0]);
  assert.ok(!d.events.includes("pushBrief") && !d.events.includes("fire"));
  return { d, body: r.body as { error: string; context: { refused: true; problems: { path?: string; code: string }[] } } };
}

test("a missing note refuses the launch before any job exists, naming the path and the reason", async () => {
  const { body } = await refused({ notes: { "Tasks/missing.md": { error: "missing" } } }, ["Tasks/ok.md", "Tasks/missing.md"], 422, /Tasks\/missing\.md: not found in the vault clone/);
  assert.deepEqual(body.context.problems, [{ path: "Tasks/missing.md", code: "missing" }]);
  assert.match(body.error, /No job was created and no runner was started/);
});

test("unsafe (symlink), too large, unreadable and invalid-text notes are each refused with a fixed reason", async () => {
  await refused({ notes: { "Tasks/link.md": { error: "unsafe" } } }, ["Tasks/link.md"], 422, /symbolic link/);
  await refused({ notes: { "Tasks/big.md": { error: "too_large" } } }, ["Tasks/big.md"], 422, /never clips/);
  await refused({ notes: { "Tasks/x.md": { error: "unreadable" } } }, ["Tasks/x.md"], 422, /could not be read/);
  await refused({ notes: { "Tasks/bin.md": { content: "abc\uFFFDdef" } } }, ["Tasks/bin.md"], 422, /not valid UTF-8/);
});

test("limits: a note over the per-note limit and a set over the total limit are refused whole, never clipped", async () => {
  const big = "plain words here. ".repeat(Math.ceil((MAX_CONTEXT_FILE_BYTES + 1) / 18));
  await refused({ notes: { "Tasks/big.md": { content: big } } }, ["Tasks/big.md"], 422, /never clips/);
  const each = "plain words here. ".repeat(Math.floor(MAX_CONTEXT_FILE_BYTES / 18)).slice(0, MAX_CONTEXT_FILE_BYTES);
  const names = Array.from({ length: Math.ceil(MAX_CONTEXT_TOTAL_BYTES / MAX_CONTEXT_FILE_BYTES) + 1 }, (_, i) => `Tasks/part${i}.md`);
  const notes = Object.fromEntries(names.map((n) => [n, { content: each }]));
  await refused({ notes }, names, 422, /over the limit/);
  await refused({}, Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, i) => `Tasks/n${i}.md`), 400, /over the limit/);
  // A note exactly at the limit is accepted.
  const d = doubles({ notes: { "Tasks/edge.md": { content: "plain words here. ".repeat(Math.floor(MAX_CONTEXT_FILE_BYTES / 18)).slice(0, MAX_CONTEXT_FILE_BYTES) } } });
  assert.equal((await d.launch("orbit", "x", undefined, ["Tasks/edge.md"])).code, 202);
});

test("secrets: a note with secret-shaped text is refused and neither the error, the job store nor the notification repeats it", async () => {
  const note = `# Setup\nthe key is ${FAKE_SECRET} keep it\n`;
  const { d, body } = await refused({ notes: { "Tasks/leaky.md": { content: note } } }, ["Tasks/leaky.md"], 422, /looks like it contains a secret/);
  // The refusal names the stable rule and the line, never the matched text.
  assert.deepEqual(body.context.problems, [{ path: "Tasks/leaky.md", code: "secret_detected", findings: [{ rule: "secret.long-opaque", line: 2 }, { rule: "secret.provider-token", line: 2 }] }]);
  assert.match(body.error, /secret\.provider-token at line 2/);
  const everything = JSON.stringify([body, d.jobs.all(), d.events]);
  assert.ok(!everything.includes(FAKE_SECRET) && !everything.includes("the key is"));
  // The same for a note tagged #rai: private notes are never exported.
  await refused({ notes: { "Tasks/mine.md": { content: "# Mine\n#rai personal\n" } } }, ["Tasks/mine.md"], 422, /tagged #rai/);
});

test("a secret-shaped path is not echoed", async () => {
  const d = doubles({ notes: { [`Tasks/${FAKE_SECRET}.md`]: { error: "missing" } } });
  const out = await d.launch("orbit", "x", undefined, [`Tasks/${FAKE_SECRET}.md`]);
  assert.ok(!JSON.stringify(out.body).includes(FAKE_SECRET));
});

test("fail closed: control repo not confirmed private (public, error, or no way to ask), or no reader, refuses with nothing written", async () => {
  await refused({ priv: false }, ["Tasks/a.md"], 403, /could not be confirmed private/);
  await refused({ priv: "throw" }, ["Tasks/a.md"], 403, /could not be confirmed private/);
  // A control repo without the visibility check or the context writer cannot export.
  const d = doubles();
  const noVis = jobLauncher({ jobs: d.jobs, control: { pushBrief: d.control.pushBrief, pushContext: d.control.pushContext }, routines: new Map([["orbit", d.routine]]), notify: notifier(jsonStore(undefined, "n3", [])), contextReader: d.reader });
  const r1 = await noVis("orbit", "x", undefined, ["Tasks/a.md"]);
  assert.equal(r1.code, 503);
  assert.deepEqual([d.events.includes("pushBrief"), d.fired.length], [false, 0]);
  const noReader = jobLauncher({ jobs: d.jobs, control: d.control, routines: new Map([["orbit", d.routine]]), notify: notifier(jsonStore(undefined, "n4", [])) });
  const r2 = await noReader("orbit", "x", undefined, ["Tasks/a.md"]);
  assert.equal(r2.code, 503);
  assert.match(String((r2.body as { error: string }).error), /no vault reader/);
  assert.equal(d.fired.length, 0);
  // A reader that cannot read at all (no credential, no clone) refuses too.
  const broken: ContextReader = { snapshot: async () => { throw new Error("secret-bearing detail must not appear"); } };
  const r = await prepareContext(["Tasks/a.md"], { reader: broken, isPrivate: async () => true });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("secret-bearing"));
});

test("an invalid path list is refused before anything is touched", async () => {
  const d = doubles();
  const r = await d.launch("orbit", "x", undefined, ["../outside.md"]);
  assert.equal(r.code, 400);
  assert.deepEqual(d.events, []);
});

test("a write failure for the copies marks the launch failed and never fires the Routine", async () => {
  const d = doubles({ failContext: true });
  const r = await d.launch("orbit", "x", undefined, ["Tasks/a.md"]);
  assert.equal(r.code, 502);
  assert.deepEqual(d.events, ["isPrivate", "read", "pushBrief", "pushContext"]);
  assert.equal(d.fired.length, 0);
  const job = d.jobs.list()[0];
  assert.equal(job.launch?.failedAt !== undefined, true);
  assert.match(String(job.launch?.error), /runner was not started/);
  assert.equal(d.jobs.health(job), "launch-failed");
  // A failing brief write also stops before the copies.
  const e = doubles({ failBrief: true });
  assert.equal((await e.launch("orbit", "x", undefined, ["Tasks/a.md"])).code, 502);
  assert.deepEqual(e.events, ["isPrivate", "read", "pushBrief"]);
});

// ---- GitHub: the copies land on the job's own branch only ------------------------------------------------------------------------

function fakeGithub() {
  const calls: { method: string; path: string; body?: any }[] = [];
  const refs = new Map<string, string>([["heads/main", "main-commit"]]);
  const commits = new Map<string, { tree: string; parents: string[] }>([["main-commit", { tree: "main-tree", parents: [] }]]);
  const trees = new Map<string, { base?: string; entries: { path: string; sha: string }[] }>([["main-tree", { entries: [] }]]);
  const blobs = new Map<string, string>();
  let n = 0;
  let isPrivate: unknown = true;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.github.com/repos/o/work", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (v: unknown, status = 200) => Response.json(v as object, { status });
    if (path === "" && method === "GET") return json({ private: isPrivate, visibility: isPrivate === true ? "private" : "public" });
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/git\/ref\/(.+)$/.exec(path))) return refs.has(m[1]) ? json({ object: { sha: refs.get(m[1]) } }) : json({}, 404);
    if (method === "POST" && path === "/git/refs") return refs.set(body.ref.replace("refs/", ""), body.sha), json({}, 201);
    if (method === "PUT" && path === "/contents/.orbit/brief.md") {
      const c = `brief-commit-${++n}`;
      commits.set(c, { tree: `tree-${n}`, parents: [refs.get(`heads/${body.branch}`)!] });
      trees.set(`tree-${n}`, { base: "main-tree", entries: [{ path: ".orbit/brief.md", sha: "b" }] });
      refs.set(`heads/${body.branch}`, c);
      return json({ commit: { sha: c } }, 201);
    }
    if (method === "GET" && (m = /^\/git\/commits\/(.+)$/.exec(path))) return commits.has(m[1]) ? json({ tree: { sha: commits.get(m[1])!.tree } }) : json({}, 404);
    if (method === "POST" && path === "/git/blobs") {
      const s = `blob-${++n}`;
      blobs.set(s, Buffer.from(body.content, "base64").toString());
      return json({ sha: s }, 201);
    }
    if (method === "POST" && path === "/git/trees") {
      const s = `tree-${++n}`;
      trees.set(s, { base: body.base_tree, entries: body.tree.map((t: any) => ({ path: t.path, sha: t.sha })) });
      return json({ sha: s }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      const s = `commit-${++n}`;
      commits.set(s, { tree: body.tree, parents: body.parents });
      return json({ sha: s }, 201);
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/(.+)$/.exec(path))) return refs.set(m[1], body.sha), json({ object: { sha: body.sha } });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return {
    calls,
    refs,
    commits,
    trees,
    blobs,
    fetcher,
    setPrivate: (v: unknown) => void (isPrivate = v),
    // Every file visible at a ref: the files added by each tree in the commit's history.
    filesAt: (ref: string) => {
      const out = new Map<string, string>();
      let c: string | undefined = refs.get(ref);
      while (c) {
        for (const e of trees.get(commits.get(c)!.tree)?.entries ?? []) if (!out.has(e.path)) out.set(e.path, blobs.get(e.sha) ?? "(brief)");
        c = commits.get(c)!.parents[0];
      }
      return out;
    },
  };
}

test("GitHub: copies and manifest land in ONE commit on orbit/<job> only; main, other branches and the vault are never touched", async () => {
  const gh = fakeGithub();
  const control = githubControl("synthetic-gh-" + "tok" + "en", "o/work", gh.fetcher);
  await control.pushBrief!("j1", "brief");
  const out = await control.pushContext!("j1", [
    { path: ".orbit/context/Tasks/a.md", content: "A\n" },
    { path: ".orbit/context/Resources/a.md", content: "R\n" },
    { path: MANIFEST_PATH, content: "{}\n" },
  ]);
  assert.equal(gh.refs.get("heads/main"), "main-commit");
  assert.equal(gh.refs.get("heads/orbit/j1"), out.commit);
  const files = gh.filesAt("heads/orbit/j1");
  assert.equal(files.get(".orbit/context/Tasks/a.md"), "A\n");
  assert.equal(files.get(".orbit/context/Resources/a.md"), "R\n");
  assert.ok(files.has(".orbit/brief.md"), "the brief commit stays in the history");
  assert.equal(gh.filesAt("heads/main").size, 0);
  // One commit for all copies, a plain (non-forced) update of the job branch, and no call about any other ref or repository.
  assert.equal(gh.calls.filter((c) => c.method === "POST" && c.path === "/git/commits").length, 1);
  const patches = gh.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => [c.path, c.body.force]), [["/git/refs/heads/orbit/j1", false]]);
  assert.ok(gh.calls.every((c) => !/vault/.test(c.path) && !/heads\/main$/.test(c.path) || (c.method === "GET" && c.path === "/git/ref/heads/main")));
  // The new commit sits on the brief commit.
  assert.deepEqual(gh.commits.get(out.commit)!.parents, ["brief-commit-1"]);
});

test("GitHub: pushContext refuses a path outside .orbit/context/ before any call", async () => {
  const gh = fakeGithub();
  const control = githubControl("t", "o/work", gh.fetcher);
  for (const p of [".orbit/brief.md", "src/x.ts", ".orbit/context/../brief.md", ".orbit/context//a.md", ".orbit/contextual/a.md"]) await assert.rejects(control.pushContext!("j1", [{ path: p, content: "x" }]), /outside \.orbit\/context/);
  assert.equal(gh.calls.length, 0);
});

test("GitHub: only a repository GitHub calls private is private", async () => {
  const gh = fakeGithub();
  const control = githubControl("t", "o/work", gh.fetcher);
  assert.equal(await control.isPrivate!(), true);
  for (const v of [false, "true", undefined, null]) {
    gh.setPrivate(v);
    assert.equal(await control.isPrivate!(), false, String(v));
  }
  await assert.rejects(githubControl("t", "o/work", (async () => new Response("", { status: 404 })) as unknown as typeof fetch).isPrivate!(), /HTTP 404/);
});

test("end to end over the GitHub double: launch writes brief then copies on orbit/<job>, then fires", async () => {
  const gh = fakeGithub();
  const control = githubControl("t", "o/work", gh.fetcher);
  const d = doubles();
  const launch = jobLauncher({ jobs: d.jobs, control, routines: new Map([["orbit", d.routine]]), notify: notifier(jsonStore(undefined, "n5", [])), contextReader: d.reader });
  const r = await launch("orbit", "Do it.", undefined, ["Tasks/a.md"]);
  assert.equal(r.code, 202);
  const job = d.jobs.list()[0].id;
  const files = gh.filesAt(`heads/orbit/${job}`);
  assert.ok(files.has(".orbit/context/Tasks/a.md") && files.has(MANIFEST_PATH) && files.has(".orbit/brief.md"));
  assert.equal(gh.refs.get("heads/main"), "main-commit");
  assert.equal(d.fired.length, 1);
});

// ---- the real vault clone as the reader -------------------------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });

test("clone reader: notes anywhere in the vault are read whole, with the vault head; a newer note than the Routine checkout is picked up by the fetch", async () => {
  const fx = makeFixture({ "AGENTS.md": "# rules\n", "Resources/a/deep.md": "# deep v1\n", "Projects/alpha.md": "# alpha\n" });
  const clone = fx.make();
  await clone.sync();
  const reader = cloneContextReader(clone);
  const first = await reader.snapshot(["Resources/a/deep.md", "Projects/alpha.md", "Tasks/none.md"]);
  assert.equal(first.fresh, true);
  assert.equal(first.head, fx.remoteHead());
  assert.deepEqual(first.notes.get("Resources/a/deep.md"), { content: "# deep v1\n" });
  assert.deepEqual(first.notes.get("Tasks/none.md"), { error: "missing" });
  // Someone updates the vault; the reader fetches first, so the copy is current and the head moves.
  const head2 = fx.elsewhere({ "Resources/a/deep.md": "# deep v2\n" });
  const second = await reader.snapshot(["Resources/a/deep.md"]);
  assert.equal(second.head, head2);
  assert.deepEqual(second.notes.get("Resources/a/deep.md"), { content: "# deep v2\n" });
  // Through the whole path: copy content and manifest hash match the vault's file.
  const prepared = await prepareContext(["Resources/a/deep.md"], { reader, isPrivate: async () => true });
  assert.ok(prepared.ok);
  if (prepared.ok) {
    assert.equal(prepared.manifest.files[0].sha256, sha(fx.remoteFile("Resources/a/deep.md")));
    assert.equal(prepared.manifest.source.head, head2);
  }
});

test("clone reader: a stale clone (fetch failing) is used and reported fresh: false; no credential or no clone is an error", async () => {
  const fx = makeFixture({ "AGENTS.md": "# rules\n", "Tasks/a.md": "# a v1\n" });
  const clone = fx.make();
  await clone.sync();
  // The remote disappears: the next fetch fails, the last good clone answers.
  renameSync(fx.remote, `${fx.remote}.gone`);
  const broken = clone;
  const stale = await cloneContextReader(broken).snapshot(["Tasks/a.md"]);
  assert.equal(stale.fresh, false);
  assert.deepEqual(stale.notes.get("Tasks/a.md"), { content: "# a v1\n" });
  const prepared = await prepareContext(["Tasks/a.md"], { reader: cloneContextReader(broken), isPrivate: async () => true });
  assert.ok(prepared.ok && prepared.manifest.source.fresh === false && /STALE WARNING/.test(prepared.section));
  // No credential: cannot read, even though a clone directory exists.
  await assert.rejects(cloneContextReader(fx.make({ credential: () => undefined })).snapshot(["Tasks/a.md"]), /no credential/);
  // A clone that never synced: nothing to read.
  const fresh = makeFixture({ "AGENTS.md": "x\n" });
  const never = fresh.make({ remote: "/nonexistent/remote.git" });
  await assert.rejects(cloneContextReader(never).snapshot(["Tasks/a.md"]), /not available/);
});

test("clone reader: symlinks (leaf or directory), oversize notes and directories are refused with fixed reasons and are not read", async () => {
  const fx = makeFixture({ "AGENTS.md": "# rules\n", "Tasks/real.md": "# real\n", "Resources/ok/inside.md": "# inside\n" });
  // Links committed to the vault: a leaf link to a file outside, and a directory link.
  const outside = join(fx.root, "outside-secret.md");
  writeFileSync(outside, "outside the vault\n");
  symlinkSync(outside, join(fx.work, "Tasks", "link.md"));
  symlinkSync(join(fx.work, "Resources", "ok"), join(fx.work, "Resources", "dirlink"));
  mkdirSync(join(fx.work, "Tasks", "folder.md"), { recursive: true });
  writeFileSync(join(fx.work, "Tasks", "folder.md", "x"), "x");
  writeFileSync(join(fx.work, "Tasks", "huge.md"), "plain words here. ".repeat(Math.ceil((300 * 1024) / 18)));
  git(fx.work, "add", "-A");
  git(fx.work, "commit", "-q", "-m", "links");
  git(fx.work, "push", "-q", "origin", "main");
  const clone = fx.make();
  await clone.sync();
  const snap = await cloneContextReader(clone).snapshot(["Tasks/link.md", "Resources/dirlink/inside.md", "Tasks/folder.md", "Tasks/huge.md", "Tasks/real.md"]);
  assert.deepEqual(snap.notes.get("Tasks/link.md"), { error: "unsafe" });
  assert.deepEqual(snap.notes.get("Resources/dirlink/inside.md"), { error: "unsafe" });
  assert.deepEqual(snap.notes.get("Tasks/folder.md"), { error: "unsafe" });
  assert.deepEqual(snap.notes.get("Tasks/huge.md"), { error: "too_large" });
  assert.deepEqual(snap.notes.get("Tasks/real.md"), { content: "# real\n" });
  const out = await prepareContext(["Tasks/link.md"], { reader: cloneContextReader(clone), isPrivate: async () => true });
  assert.ok(!out.ok && out.code === 422 && !JSON.stringify(out).includes("outside the vault"));
});

// ---- propagation through chat proposals, the confirm route and /jobs/launch -----------------------------------------------------------

let model: ModelPort;
const d = doubles();
const vaultDir = join(process.env.TMPDIR ?? "/tmp", "orbit-job-context-vault");
mkdirSync(vaultDir, { recursive: true });
writeFileSync(join(vaultDir, "now.md"), "x\n");
const memoryPort = vaultMemory(vaultDir);
const notify = notifier(jsonStore(undefined, "n6", []));
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
  model: { status: () => model.status(), reply: (...a) => model.reply(...a), step: (...a) => model.step!(...a) },
  memory: memoryPort,
  notify,
  schedule: scheduler(jsonStore(undefined, "s", []), notify),
  runs: runner(jsonStore(undefined, "r", []), [memoryReport(memoryPort)], notify),
  tools: toolbox([]),
  nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), "rai@example.com"),
  jobs: d.jobs,
  publicJobUrl: "https://orbit.example",
  control: d.control,
  contextReader: d.reader,
  routines: new Map([["orbit", d.routine]]),
  commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
  owner: "rai@example.com",
  identify: async () => "rai@example.com",
});
let base = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const scripted = (steps: Step[]): ModelPort => {
  let i = 0;
  return { ...mockModel("test"), step: async () => steps[Math.min(i++, steps.length - 1)] };
};
const call = (name: string, args: unknown) => ({ call_id: `c_${name}`, name, arguments: JSON.stringify(args) });
const chat = () => fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "launch it" }] }) });

test("confirmed launch: the exact paths from the proposal reach the copies; the card shows them; nothing happens before the confirm", async () => {
  model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: "Do X.", context: ["Tasks/orbit-next-job-context.md", "Resources/orbit-next-handover-to-orbit.md"] })] }, { text: "Proposed.", calls: [] }]);
  const body = await (await chat()).json();
  assert.equal(body.calls[0].ok, true);
  assert.deepEqual(body.proposals[0].context, ["Tasks/orbit-next-job-context.md", "Resources/orbit-next-handover-to-orbit.md"]);
  assert.deepEqual([d.events.length, d.fired.length], [0, 0]);
  const res = await fetch(`${base}/chat/proposals/${body.proposals[0].id}/confirm`, { method: "POST" });
  assert.equal(res.status, 202);
  assert.deepEqual(d.requested.at(-1), ["Tasks/orbit-next-job-context.md", "Resources/orbit-next-handover-to-orbit.md"]);
  assert.deepEqual(d.events, ["isPrivate", "read", "pushBrief", "pushContext", "fire"]);
  assert.equal(d.contexts[0].files.length, 3);
  assert.match(d.briefs[0].brief, /^Do X\./);
});

test("a chat proposal with a bad path fails at proposal time with no proposal; one without context carries none", async () => {
  model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: "Do X.", context: ["Journal/2026/2026-11-09.md"] })] }, { text: "failed", calls: [] }]);
  const bad = await (await chat()).json();
  assert.equal(bad.calls[0].ok, false);
  assert.equal(bad.proposals.length, 0);
  model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: "Plain." })] }, { text: "ok", calls: [] }]);
  const plain = await (await chat()).json();
  assert.equal(plain.proposals[0].context, undefined);
});

test("/jobs/launch passes the context list; a refusal returns the structured problems and starts nothing", async () => {
  const before = d.fired.length;
  const post = (input: unknown) => fetch(`${base}/jobs/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const ok = await post({ routine: "orbit", brief: "Via route.", context: ["Projects/orbit-next.md"] });
  assert.equal(ok.status, 202);
  assert.deepEqual(d.requested.at(-1), ["Projects/orbit-next.md"]);
  const refusedRes = await post({ routine: "orbit", brief: "Via route.", context: ["Memory/index.md"] });
  assert.equal(refusedRes.status, 400);
  assert.equal(((await refusedRes.json()) as { context: { problems: { code: string }[] } }).context.problems[0].code, "not_allowed");
  assert.equal(d.fired.length, before + 1);
  const plain = await post({ routine: "orbit", brief: "No context." });
  assert.equal(plain.status, 202);
});


test("vault filter on context export: headings, long note names and wikilinks export; a secret refuses with rule ids and no value, and does not retry", async () => {
  const note = "# Plan\n\n**Credential:** the key lives on the host.\nsee [[orbit-next-compaction-empty-summary]] and Tasks/orbit-next-web-feedback-and-links.md\n";
  const d = doubles({ notes: { "Tasks/orbit-next-filter-reliability-note.md": { content: note } } });
  const ok = await d.launch("orbit", "x", undefined, ["Tasks/orbit-next-filter-reliability-note.md"]);
  assert.equal(ok.code, 202, JSON.stringify(ok.body));
  assert.equal(d.contexts[0].files.find((f) => f.path.endsWith("orbit-next-filter-reliability-note.md"))?.content, note, "exported whole, unmasked");

  const value = "Zp4" + "Kw8Tn2Xc6Vb1Ld9Hq3Rm7Sj5Yf0Ga";
  const bad = doubles({ notes: { "Tasks/orbit-next-long-kebab-name-for-display.md": { content: `# T\n\n**Credential:** ${value}\n` } } });
  const r = await bad.launch("orbit", "x", undefined, ["Tasks/orbit-next-long-kebab-name-for-display.md"]);
  assert.equal(r.code, 422);
  const body = r.body as { error: string; context: { problems: { path: string; code: string; findings: { rule: string; line: number }[] }[] } };
  assert.ok(body.error.includes("Tasks/orbit-next-long-kebab-name-for-display.md"), "the note name is shown, not [redacted]");
  assert.match(body.error, /secret\.credential-assignment at line 3/);
  assert.match(body.error, /separate launch and needs its own confirmation/);
  assert.ok(!JSON.stringify(body).includes(value.slice(0, 10)));
  assert.deepEqual([bad.briefs.length, bad.contexts.length, bad.fired.length, bad.jobs.list().length], [0, 0, 0, 0], "nothing was created, omitted or retried");
});
