import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import type { ControlRepo, Routine } from "../src/launcher.ts";
import { vaultMemory } from "../src/memory.ts";
import { mockModel } from "../src/model.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { notifier } from "../src/notify.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { loadResearchTool, researchStore } from "../src/research.ts";
import type { ResearchLane } from "../src/research.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";

// The research lane through the real HTTP server: owner-only confirmation of a research proposal launches on the research routine
// and nothing else; a build proposal can never launch on it; /status says honestly whether the lane is configured and proven.

const events: string[] = [];
const control: ControlRepo = { pushBrief: async (job) => (events.push(`pushBrief:${job}`), { branch: `orbit/${job}`, commit: "c1" }), readJob: async () => undefined };
const routine = (name: string): Routine => ({ name, fire: async (text) => (events.push(`fire:${name}:${text.split("\n")[0]}`), { sessionId: `cse_${name}`, sessionUrl: `https://claude.ai/code/cse_${name}` }) });
const notify = notifier(jsonStore(undefined, "rs-n", []));
const jobs = jobRegistry(jsonStore<Job[]>(undefined, "rs-j", []), Buffer.alloc(32, 9), notify);
const props = newProposals();
const memory = vaultMemory(mkdtempSync(`${tmpdir()}/rs-vault-`));
let who = "rai@example.com";
let lane: ResearchLane = { state: "configured", names: ["research"], routines: new Map([["research", routine("research")]]) };

const make = () =>
  buildServer({
    ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
    model: mockModel("test"),
    memory,
    notify,
    schedule: scheduler(jsonStore(undefined, "rs-s", []), notify),
    runs: runner(jsonStore(undefined, "rs-r", []), [memoryReport(memory)], notify),
    tools: toolbox([]),
    nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), "rai@example.com"),
    jobs,
    publicJobUrl: "https://orbit-jobs.example.ts.net",
    control,
    routines: new Map([["orbit", routine("orbit")]]),
    research: { lane, store: researchStore(undefined), tool: loadResearchTool() },
    commit: "be8d654f68b030f85e007fb4f46190c4fda33fd3",
    owner: "rai@example.com",
    identify: async () => who,
    proposals: props,
  });
let server = make();
let base = "";
const start = async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
before(start);
after(() => server.close());
const confirm = (id: string) => fetch(`${base}/chat/proposals/${id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

test("a confirmed research proposal launches on the research routine only, with nothing written to orbit-work", async () => {
  events.length = 0;
  const p = props.propose({ kind: "job_launch", routine: "research", brief: "Research question: Which RFC?\n\nFind it.", lane: "research" });
  assert.deepEqual(events, [], "nothing before confirmation");
  const res = await confirm(p.id);
  assert.equal(res.status, 202);
  assert.deepEqual(events, ["fire:research:Lane: research"]);
  const body = (await res.json()) as { id: string; kind: string };
  assert.equal(body.kind, "research");
  assert.equal(jobs.get(body.id)?.research?.brief, "Research question: Which RFC?\n\nFind it.");
  assert.equal((await confirm(p.id)).status === 202, false, "single use");
});

test("a build proposal naming the research routine, or a research proposal naming the build routine, is refused at confirmation", async () => {
  events.length = 0;
  const a = props.propose({ kind: "job_launch", routine: "research", brief: "Change code." });
  const ra = await confirm(a.id);
  assert.equal(ra.status, 409);
  const b = props.propose({ kind: "job_launch", routine: "orbit", brief: "Look things up.", lane: "research" });
  const rb = await confirm(b.id);
  assert.equal(rb.status, 409);
  assert.match(((await rb.json()) as { error: string }).error, /never falls back to a build routine/);
  assert.deepEqual(events, []);
});

test("someone other than the owner cannot confirm a research launch", async () => {
  events.length = 0;
  const p = props.propose({ kind: "job_launch", routine: "research", brief: "x", lane: "research" });
  who = "someone@example.com";
  try {
    assert.equal((await confirm(p.id)).status, 403);
  } finally {
    who = "rai@example.com";
  }
  assert.deepEqual(events, []);
});

test("/status reports the research lane honestly: configured but not proven, then unconfigured", async () => {
  const status = async () => ((await (await fetch(`${base}/status`)).json()) as { ports: { port: string; detail: string }[] }).ports.find((p) => p.port === "jobs")!.detail;
  assert.match(await status(), /Research lane configured \(research\); no research report received yet: not proven live\./);
  server.close();
  lane = { state: "unconfigured", reason: "ORBIT_RESEARCH_ROUTINES is not set.", routines: new Map(), names: [] };
  server = make();
  await start();
  assert.match(await status(), /Research lane unconfigured\./);
  events.length = 0;
  const p = props.propose({ kind: "job_launch", routine: "research", brief: "x", lane: "research" });
  assert.equal((await confirm(p.id)).status, 409);
  assert.deepEqual(events, []);
});
