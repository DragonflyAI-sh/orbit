import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { mockModel } from "../src/model.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import { hasLegacyContext, LEGACY_CONTEXT_ERROR, refuseLegacyContext } from "../src/job-context.ts";
import { jobLauncher } from "../src/job-launch.ts";
import type { JobLauncher } from "../src/job-launch.ts";
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
import type { MemoryPort } from "../src/memory.ts";
import { proposals as newProposals } from "../src/agent.ts";
import type { ChatTool, ProposalAction } from "../src/agent.ts";
import { vaultFindings } from "../src/vault/filter.ts";

// Launch-time vault context export was removed. These tests pin that: an ordinary launch reads nothing from the vault, writes only the
// brief to the control branch and fires the Routine, whatever the vault holds or whether it exists; and a legacy `context` list on any
// entry point is refused with a fixed diagnostic before anything is registered, written or fired.
//
// Everything here is synthetic: fake GitHub, fake Routine, a throwaway notes directory written by the tests. No network, no real
// credential, no real vault. Secret-shaped text is built at run time so no literal appears in the file.
const FAKE_SECRET = "sk" + "-" + "a1B2".repeat(8);
const NOTE_MARK = "synthetic-note-body-" + "7f3a";

// ---- doubles -------------------------------------------------------------------------------------------------------------------

function doubles(opts: { failBrief?: boolean; failFire?: boolean } = {}) {
  const events: string[] = [];
  const briefs: { job: string; brief: string }[] = [];
  const fired: string[] = [];
  // A control double that still has the removed methods: if any launch path tried to use them, the events would show it.
  const control = {
    pushBrief: async (job: string, brief: string) => {
      events.push("pushBrief");
      if (opts.failBrief) throw new Error("GitHub PUT brief returned HTTP 500");
      briefs.push({ job, brief });
      return { branch: `orbit/${job}`, commit: "brief0001" };
    },
    pushContext: async () => (events.push("pushContext"), { commit: "ctx0001" }),
    isPrivate: async () => (events.push("isPrivate"), true),
  } as ControlRepo;
  const routine: Routine = {
    name: "orbit",
    fire: async (text) => {
      events.push("fire");
      if (opts.failFire) throw new Error("Routine API returned HTTP 503");
      fired.push(text);
      return { sessionId: "cse_1", sessionUrl: "https://claude.ai/code/cse_1" };
    },
  };
  const jobs = jobRegistry(jsonStore(undefined, "j", []), Buffer.alloc(32, 1), notifier(jsonStore(undefined, "n", [])));
  const launch = jobLauncher({ jobs, control, routines: new Map([["orbit", routine]]), notify: notifier(jsonStore(undefined, "n2", [])), publicJobUrl: "https://orbit.example", commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b" });
  return { events, briefs, fired, control, routine, jobs, launch };
}

// ---- the launcher ----------------------------------------------------------------------------------------------------------------

test("an ordinary launch writes only the brief, then fires; it never checks visibility, reads notes or writes copies", async () => {
  const d = doubles();
  const brief = "Implement the thing. Read Tasks/orbit-next-x.md from the read-only vault checkout.";
  const r = await d.launch("orbit", `  ${brief}\n`);
  assert.equal(r.code, 202);
  assert.deepEqual(d.events, ["pushBrief", "fire"]);
  assert.equal(d.briefs[0].brief, brief, "the brief is written as given (trimmed), with no generated context section");
  assert.doesNotMatch(d.briefs[0].brief, /\.orbit\/context|manifest\.json|## Vault context/);
  const job = d.jobs.get(d.briefs[0].job)!;
  assert.equal(job.launch?.context, undefined);
  assert.equal(job.launch?.briefCommit, "brief0001");
  assert.deepEqual(d.fired[0].split("\n").map((l) => l.split(":")[0]), ["Job id", "API", "Token", "Tool commit"], "the fire text carries ids only");
});

test("a legacy fourth argument cannot revive the export: the launcher has no export path to reach", async () => {
  const d = doubles();
  const legacy = d.launch as unknown as (...a: unknown[]) => ReturnType<JobLauncher>;
  const r = await legacy("orbit", "Do it.", undefined, ["Tasks/a.md", "Resources/b.md"]);
  assert.equal(r.code, 202);
  assert.deepEqual(d.events, ["pushBrief", "fire"]);
  assert.equal(d.briefs[0].brief, "Do it.");
});

test("failures stay safe: a brief write failure never fires; a fire failure is recorded; refusals before registration leave no job", async () => {
  const a = doubles({ failBrief: true });
  const ra = await a.launch("orbit", "Do it.");
  assert.equal(ra.code, 502);
  assert.deepEqual(a.events, ["pushBrief"]);
  assert.match(String(a.jobs.list()[0].launch?.error), /brief not written/);
  assert.ok(a.jobs.list()[0].launch?.failedAt);

  const b = doubles({ failFire: true });
  const rb = await b.launch("orbit", "Do it.");
  assert.equal(rb.code, 502);
  assert.deepEqual(b.events, ["pushBrief", "fire"]);
  assert.match(String(b.jobs.list()[0].launch?.error), /routine not fired/);

  const c = doubles();
  assert.equal((await c.launch("orbit", "   ")).code, 400);
  assert.equal((await c.launch("nope", "Do it.")).code, 400);
  assert.deepEqual([c.events, c.jobs.list().length], [[], 0]);
});

test("GitHub: a launch creates orbit/<job> and puts .orbit/brief.md only; no visibility check, blobs, trees, commits or ref updates", async () => {
  const calls: { method: string; path: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.github.com/repos/o/work", "");
    const method = init.method ?? "GET";
    calls.push({ method, path });
    if (method === "GET" && path === "/git/ref/heads/main") return Response.json({ object: { sha: "main-commit" } });
    if (method === "POST" && path === "/git/refs") return Response.json({}, { status: 201 });
    if (method === "PUT" && path === "/contents/.orbit/brief.md") return Response.json({ commit: { sha: "brief-commit" } }, { status: 201 });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const control = githubControl("t", "o/work", fetcher);
  assert.equal("pushContext" in control, false);
  assert.equal("isPrivate" in control, false);
  const d = doubles();
  const launch = jobLauncher({ jobs: d.jobs, control, routines: new Map([["orbit", d.routine]]), notify: notifier(jsonStore(undefined, "n5", [])) });
  const r = await launch("orbit", "Do it.");
  assert.equal(r.code, 202);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /git/ref/heads/main", "POST /git/refs", "PUT /contents/.orbit/brief.md"]);
  assert.equal(d.fired.length, 1);
});

// ---- the legacy guard ------------------------------------------------------------------------------------------------------------

test("hasLegacyContext: absent, null and [] are ordinary; anything else is a legacy request", () => {
  for (const v of [undefined, null, []]) assert.equal(hasLegacyContext(v), false, JSON.stringify(v));
  for (const v of [["Tasks/a.md"], "Tasks/a.md", {}, 0, false, [""]]) assert.equal(hasLegacyContext(v), true, JSON.stringify(v));
  assert.match(LEGACY_CONTEXT_ERROR, /no longer supported/);
  assert.match(LEGACY_CONTEXT_ERROR, /Nothing was launched/);
  assert.match(LEGACY_CONTEXT_ERROR, /read-only vault checkout/);
});

test("refuseLegacyContext: the job_launch tool refuses context without proposing, passes a plain call through, and leaves other tools alone", async () => {
  const seen: Record<string, unknown>[] = [];
  const launchTool: ChatTool = { name: "job_launch", description: "d", parameters: { type: "object", properties: { routine: {}, brief: {} } }, run: async (a) => (seen.push(a), { value: { proposalId: "p" }, provenance: "live", source: "chat/proposals" }) };
  const other: ChatTool = { name: "memory_read", description: "m", parameters: {}, run: async () => ({ value: 1, provenance: "live", source: "x" }) };
  const [wrapped, untouched] = refuseLegacyContext([launchTool, other]);
  assert.equal(untouched, other);
  assert.deepEqual(wrapped.parameters, launchTool.parameters, "the schema does not offer context");
  assert.equal(wrapped.description, launchTool.description);
  await assert.rejects(wrapped.run({ routine: "orbit", brief: "b", context: ["Tasks/a.md"] }), (e: unknown) => e instanceof Error && e.message === LEGACY_CONTEXT_ERROR);
  assert.equal(seen.length, 0, "no proposal was made");
  await wrapped.run({ routine: "orbit", brief: "b", context: [] });
  await wrapped.run({ routine: "orbit", brief: "b" });
  assert.deepEqual(seen, [{ routine: "orbit", brief: "b" }, { routine: "orbit", brief: "b" }]);
});

// ---- through the server: chat proposals, the confirm route and /jobs/launch ---------------------------------------------------------

// A vault directory holding a note the content filter would refuse. Launches name it in the brief; they must still succeed, must not read
// it, and nothing of it may reach the control branch or the fire text.
const vaultDir = mkdtempSync(join(tmpdir(), "orbit-no-export-vault-"));
mkdirSync(join(vaultDir, "Tasks"), { recursive: true });
writeFileSync(join(vaultDir, "now.md"), "x\n");
writeFileSync(join(vaultDir, "Tasks", "leaky.md"), `# Leaky\n${NOTE_MARK}\nkey: ${FAKE_SECRET}\n`);
assert.ok(vaultFindings(readFileSync(join(vaultDir, "Tasks", "leaky.md"), "utf8")).length > 0, "the fixture note is one the filter refuses");

// Every memory port call is counted, so a launch that touched the vault would show up.
const memoryCalls: string[] = [];
const realMemory = vaultMemory(vaultDir);
const memoryPort = new Proxy(realMemory, {
  get(target, prop, recv) {
    const v = Reflect.get(target, prop, recv);
    return typeof v === "function" && prop !== "status" ? (...a: unknown[]) => (memoryCalls.push(String(prop)), v.apply(target, a)) : v;
  },
}) as MemoryPort;

let model: ModelPort;
let who = "rai@example.com";
const d = doubles();
const props = newProposals();
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
  routines: new Map([["orbit", d.routine]]),
  commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
  owner: "rai@example.com",
  identify: async () => who,
  proposals: props,
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
const post = (input: unknown) => fetch(`${base}/jobs/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
const reset = () => {
  d.events.length = 0;
  memoryCalls.length = 0;
};
// Nothing exported anywhere it could land: the brief, the fire text or a recorded launch.
const assertNoExport = () => {
  for (const b of d.briefs) assert.ok(!b.brief.includes(NOTE_MARK) && !b.brief.includes(FAKE_SECRET) && !b.brief.includes(".orbit/context"));
  for (const f of d.fired) assert.ok(!f.includes(NOTE_MARK) && !f.includes(FAKE_SECRET));
  for (const j of d.jobs.list()) assert.equal(j.launch?.context, undefined);
  assert.ok(!d.events.includes("pushContext") && !d.events.includes("isPrivate"));
};

test("confirmed chat launch: no vault read at confirm, brief only, then fire; a note the filter would refuse does not matter", async () => {
  model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: "Do X. Read Tasks/leaky.md from the vault checkout." })] }, { text: "Proposed.", calls: [] }]);
  const body = await (await chat()).json();
  assert.equal(body.calls[0].ok, true);
  assert.equal(body.proposals[0].context, undefined);
  assert.deepEqual(d.fired.length, 0, "nothing happens before the confirm");
  reset();
  const res = await fetch(`${base}/chat/proposals/${body.proposals[0].id}/confirm`, { method: "POST" });
  assert.equal(res.status, 202);
  assert.deepEqual(d.events, ["pushBrief", "fire"]);
  assert.deepEqual(memoryCalls, [], "the launch never touched the vault");
  assert.equal(d.briefs.at(-1)!.brief, "Do X. Read Tasks/leaky.md from the vault checkout.");
  assertNoExport();
});

test("a chat job_launch that still passes context fails in chat with the legacy diagnostic and makes no proposal", async () => {
  const before = props.list().length;
  model = scripted([{ text: "", calls: [call("job_launch", { routine: "orbit", brief: "Do X.", context: ["Tasks/leaky.md"] })] }, { text: "failed", calls: [] }]);
  const bad = await (await chat()).json();
  assert.equal(bad.calls[0].ok, false);
  assert.equal(bad.proposals.length, 0);
  assert.equal(props.list().length, before);
});

test("/jobs/launch: legacy context is refused before anything starts; absent, null and [] launch normally with no vault read", async () => {
  const jobsBefore = d.jobs.list().length;
  const firedBefore = d.fired.length;
  reset();
  for (const context of [["Tasks/leaky.md"], ["Memory/index.md"], "Tasks/leaky.md", { path: "Tasks/leaky.md" }]) {
    const res = await post({ routine: "orbit", brief: "Via route.", context });
    assert.equal(res.status, 400, JSON.stringify(context));
    const body = (await res.json()) as { error: string; context: { refused: boolean; reason: string } };
    assert.equal(body.error, LEGACY_CONTEXT_ERROR);
    assert.deepEqual(body.context, { refused: true, reason: "unsupported" });
  }
  assert.deepEqual([d.events, d.jobs.list().length, d.fired.length, memoryCalls], [[], jobsBefore, firedBefore, []]);
  for (const extra of [{}, { context: null }, { context: [] }]) {
    reset();
    const res = await post({ routine: "orbit", brief: "No context.", ...extra });
    assert.equal(res.status, 202, JSON.stringify(extra));
    assert.deepEqual(d.events, ["pushBrief", "fire"]);
    assert.deepEqual(memoryCalls, []);
  }
  assertNoExport();
});

test("/jobs/launch stays owner-only: a non-owner is refused before the legacy check or any launch", async () => {
  reset();
  const jobsBefore = d.jobs.list().length;
  who = "someone@example.com";
  try {
    for (const input of [{ routine: "orbit", brief: "x" }, { routine: "orbit", brief: "x", context: ["Tasks/leaky.md"] }]) {
      const res = await post(input);
      assert.equal(res.status, 403);
      assert.ok(!(await res.text()).includes("no longer supported"));
    }
  } finally {
    who = "rai@example.com";
  }
  assert.deepEqual([d.events, d.jobs.list().length], [[], jobsBefore]);
});

test("a legacy proposal that still carries context is refused at confirm, spent, and never launched; a plain one still launches", async () => {
  const legacy = props.propose({ kind: "job_launch", routine: "orbit", brief: "Old proposal.", context: ["Tasks/leaky.md"] } as ProposalAction);
  const jobsBefore = d.jobs.list().length;
  reset();
  const res = await fetch(`${base}/chat/proposals/${legacy.id}/confirm`, { method: "POST" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, LEGACY_CONTEXT_ERROR);
  assert.deepEqual([d.events, d.jobs.list().length, memoryCalls], [[], jobsBefore, []]);
  const again = await fetch(`${base}/chat/proposals/${legacy.id}/confirm`, { method: "POST" });
  assert.ok(again.status === 404 || again.status === 409, "a refused proposal cannot be confirmed again");
  assert.deepEqual(d.events, []);

  const plain = props.propose({ kind: "job_launch", routine: "orbit", brief: "New proposal." });
  const ok = await fetch(`${base}/chat/proposals/${plain.id}/confirm`, { method: "POST" });
  assert.equal(ok.status, 202);
  assert.deepEqual(d.events, ["pushBrief", "fire"]);
  assertNoExport();
});

// ---- nothing left to export with ---------------------------------------------------------------------------------------------------

test("no source file keeps the export plumbing: no .orbit/context writes, copy manifests, snapshot reads or visibility gate", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|html)$/.test(name)) files.push(p);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  assert.ok(files.length > 10);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const banned of [".orbit/context", "pushContext", "snapshotNotes", "prepareContext", "manifest.json", "isPrivate("]) assert.ok(!text.includes(banned), `${f} still mentions ${banned}`);
  }
});

test("the runner skill points at the read-only vault checkout and no longer at launch copies", () => {
  const skill = readFileSync(new URL("../tools/orbit-job/SKILL.md", import.meta.url), "utf8");
  assert.ok(!skill.includes("manifest.json"), "no manifest to check");
  assert.ok(!/launch snapshot/i.test(skill), "no launch snapshot to prefer");
  assert.match(skill, /\/home\/user\/orbit-vault/);
  assert.match(skill, /does not copy vault notes/i);
});
