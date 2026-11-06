import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultMemory } from "../src/memory.ts";
import { mockModel } from "../src/model.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { notifier } from "../src/notify.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";
import type { ControlRepo, Routine } from "../src/launcher.ts";
import type { Tool } from "../src/tools.ts";
import { decide } from "../src/policy.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import type { PortStatus } from "../src/ports.ts";
import { buildServer, STALE_AFTER_MS, withStaleness } from "../src/server.ts";

const deploy = { lastFailed: { commit: "bad1", at: "2026-11-02T00:00:00Z" } };
const vault = mkdtempSync(join(tmpdir(), "orbit-vault-"));
writeFileSync(join(vault, "now.md"), "Top priority: money noodle PR.\n");
let caller: string | undefined = "rai@example.com";
const notify = notifier(jsonStore(undefined, "n", []));
const schedule = scheduler(jsonStore(undefined, "j", []), notify);
const memoryPort = vaultMemory(vault);
const runs = runner(jsonStore(undefined, "r", []), [memoryReport(memoryPort)], notify);
const echo: Tool = { name: "echo", description: "", readOnly: true, validate: () => undefined, run: async (i) => ({ value: i, provenance: "live", source: "tools/echo" }) };
const writer: Tool = { ...echo, name: "writer", readOnly: false };
const tools = toolbox([echo, writer]);
const nodes = devicePresence(
  async () => ({
    Self: { HostName: "orbit-host", OS: "linux" },
    User: { "1": { LoginName: "rai@example.com" } },
    Peer: { a: { HostName: "air", OS: "macOS", Online: true, UserID: 1 } },
  }),
  "rai@example.com",
);
await nodes.refresh();
const jobs = jobRegistry(jsonStore(undefined, "jc", []), Buffer.alloc(32, 1), notify);
let fireText = "";
let failFire = false;
const control: ControlRepo = { pushBrief: async (job) => ({ branch: `orbit/${job}`, commit: "c0ffee" }) };
const routine: Routine = {
  name: "orbit",
  fire: async (text) => {
    if (failFire) throw new Error("HTTP 401");
    fireText = text;
    return { sessionId: "cse_9", sessionUrl: "https://claude.ai/code/cse_9" };
  },
};
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
  model: mockModel("test"),
  memory: memoryPort,
  notify,
  schedule,
  runs,
  tools,
  nodes,
  jobs,
  publicJobUrl: "https://orbit.example:8443",
  control,
  routines: new Map([["orbit", routine]]),
  commit: "abc123",
  owner: "rai@example.com",
  identify: async () => caller,
  deploy: () => deploy,
});
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const chat = (body: unknown) =>
  fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("status reports the commit and every port", async () => {
  const body = await (await fetch(`${base}/status`)).json();
  assert.equal(body.commit, "abc123");
  assert.deepEqual(body.ports.map((p: PortStatus) => p.port), ["policy", "channel", "model", "memory", "notify", "schedule", "runs", "tools", "nodes", "jobs", ...MOCK_PORT_NAMES]);
});

test("status shows the last failed deploy beside the running commit", async () => {
  const body = await (await fetch(`${base}/status`)).json();
  assert.deepEqual(body.deploy, deploy);
});

test("no port is still a mock", async () => {
  const body = await (await fetch(`${base}/status`)).json();
  assert.deepEqual(body.ports.filter((p: PortStatus) => p.state === "mock" && p.port !== "model").map((p: PortStatus) => p.port), []);
});

test("the avatar is served for the page and its icons", async () => {
  const res = await fetch(`${base}/avatar.png`);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).slice(1, 4)], [80, 78, 71]);
});

test("the web page is served at /", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>ORBIT<\/title>/);
});

test("a chat reply carries provenance and the limits ORBIT has", async () => {
  const res = await chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply.provenance, "mock");
  assert.ok(body.limits.some((l: string) => l.startsWith("runs is degraded")));
});

test("the owner's chat brings in matching vault notes", async () => {
  caller = "rai@example.com";
  const body = await (await chat({ messages: [{ role: "user", content: "money noodle status?" }] })).json();
  assert.deepEqual(body.memory, ["now.md"]);
  assert.match(body.reply.value, /now\.md/);
});

test("anyone else gets no memory, in chat or directly", async () => {
  for (const who of ["someone@example.com", undefined]) {
    caller = who;
    const body = await (await chat({ messages: [{ role: "user", content: "money noodle status?" }] })).json();
    assert.deepEqual(body.memory, []);
    assert.ok(body.limits.some((l: string) => l.startsWith("memory is refused")));
    const direct = await fetch(`${base}/ports/memory/search`, { method: "POST", body: JSON.stringify({ query: "money" }) });
    assert.equal(direct.status, 403);
  }
  caller = "rai@example.com";
});

test("the owner can search and read memory directly", async () => {
  const search = await (await fetch(`${base}/ports/memory/search`, { method: "POST", body: JSON.stringify({ query: "money" }) })).json();
  assert.equal(search.value[0].path, "now.md");
  const read = await fetch(`${base}/ports/memory/read`, { method: "POST", body: JSON.stringify({ path: "../x.md" }) });
  assert.equal(read.status, 404);
});

test("chat rejects malformed input", async () => {
  assert.equal((await chat({ messages: [] })).status, 400);
  assert.equal((await chat({ messages: [{ role: "system", content: "x" }] })).status, 400);
  assert.equal((await chat({ messages: [{ role: "assistant", content: "x" }] })).status, 400);
});

test("policy refuses actions that are not built", async () => {
  assert.equal(decide("devices", "wipe", true).allow, false);
  const res = await fetch(`${base}/ports/devices/wipe`, { method: "POST" });
  assert.equal(res.status, 403);
});

test("the owner can schedule a job and see notifications; nobody else can", async () => {
  caller = "rai@example.com";
  const created = await fetch(`${base}/schedule`, { method: "POST", body: JSON.stringify({ text: "stretch", everyMinutes: 30 }) });
  assert.equal(created.status, 201);
  assert.equal((await (await fetch(`${base}/schedule`)).json()).jobs.length, 1);
  const bad = await fetch(`${base}/schedule`, { method: "POST", body: JSON.stringify({ text: "x", everyMinutes: 1 }) });
  assert.equal(bad.status, 400);

  const sent = await (await fetch(`${base}/notifications`, { method: "POST", body: JSON.stringify({ text: "hi", urgent: true }) })).json();
  const inbox = await (await fetch(`${base}/notifications`)).json();
  assert.ok(inbox.inbox.some((n: { id: string }) => n.id === sent.id));
  const acked = await (await fetch(`${base}/notifications/${sent.id}/ack`, { method: "POST" })).json();
  assert.equal(acked.shown.detail, "Shown in the ORBIT web page");

  caller = "someone@example.com";
  assert.equal((await fetch(`${base}/schedule`)).status, 403);
  assert.equal((await fetch(`${base}/notifications`)).status, 403);
  assert.equal((await fetch(`${base}/notifications`, { method: "POST", body: JSON.stringify({ text: "x" }) })).status, 403);
  caller = "rai@example.com";
});

test("a live port that has not been verified recently is degraded", () => {
  const now = new Date();
  const status: PortStatus = {
    port: "model",
    state: "live",
    impl: "x",
    detail: "ok",
    verifiedAt: new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString(),
  };
  assert.equal(withStaleness(status, now).state, "degraded");
});

test("the owner can submit a run and read it back; a repeated key returns the same run", async () => {
  caller = "rai@example.com";
  const submit = (key?: string) =>
    fetch(`${base}/runs`, { method: "POST", body: JSON.stringify({ worker: "memory-report", input: { query: "money" }, key }) });
  const first = await submit("k1");
  assert.equal(first.status, 202);
  const run = await first.json();
  const again = await (await submit("k1")).json();
  assert.equal(again.id, run.id);
  assert.equal(again.deduped, true);
  assert.equal((await fetch(`${base}/runs`, { method: "POST", body: JSON.stringify({ worker: "nope" }) })).status, 400);
  assert.equal((await (await fetch(`${base}/runs/${run.id}`)).json()).worker, "memory-report");

  caller = undefined;
  assert.equal((await submit()).status, 403);
  assert.equal((await fetch(`${base}/runs`)).status, 403);
  caller = "rai@example.com";
});

test("the owner can call a read-only tool; write tools and other callers are refused", async () => {
  caller = "rai@example.com";
  const ok = await fetch(`${base}/tools/echo`, { method: "POST", body: JSON.stringify({ x: 1 }) });
  assert.deepEqual((await ok.json()).value, { x: 1 });
  assert.equal((await fetch(`${base}/tools/writer`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/tools/nope`, { method: "POST", body: "{}" })).status, 404);
  caller = "someone@example.com";
  assert.equal((await fetch(`${base}/tools/echo`, { method: "POST", body: "{}" })).status, 403);
  caller = "rai@example.com";
});

test("model sign-in endpoints are owner only and say when a model has no sign-in", async () => {
  caller = "rai@example.com";
  assert.equal((await fetch(`${base}/model/login`)).status, 404);
  caller = "someone@example.com";
  assert.equal((await fetch(`${base}/model/login`, { method: "POST" })).status, 403);
  caller = "rai@example.com";
});

test("the owner sees devices and chat knows them; others do not", async () => {
  caller = "rai@example.com";
  const list = await (await fetch(`${base}/nodes`)).json();
  assert.deepEqual(list.devices.map((d: { name: string }) => d.name), ["orbit-host", "air"]);
  const reply = await (await chat({ messages: [{ role: "user", content: "is my laptop on?" }] })).json();
  assert.match(reply.reply.value, /Devices right now/);
  caller = "someone@example.com";
  assert.equal((await fetch(`${base}/nodes`)).status, 403);
  const other = await (await chat({ messages: [{ role: "user", content: "is my laptop on?" }] })).json();
  assert.doesNotMatch(other.reply.value, /Devices right now/);
  caller = "rai@example.com";
});

test("the owner registers a job and steers it; nobody else can", async () => {
  caller = "rai@example.com";
  const created = await (await fetch(`${base}/jobs`, { method: "POST", body: JSON.stringify({ id: "job-1" }) })).json();
  assert.equal(created.job.id, "job-1");
  assert.match(created.token, /^job-1\./);
  assert.equal(created.api, "https://orbit.example:8443");
  const steer = await (await fetch(`${base}/jobs/job-1/steer`, { method: "POST", body: JSON.stringify({ text: "go" }) })).json();
  assert.equal(steer.n, 1);
  assert.equal((await (await fetch(`${base}/jobs/job-1`)).json()).steers.length, 1);
  caller = "someone@example.com";
  assert.equal((await fetch(`${base}/jobs`)).status, 403);
  assert.equal((await fetch(`${base}/jobs`, { method: "POST", body: JSON.stringify({ id: "x" }) })).status, 403);
  assert.equal((await fetch(`${base}/jobs/job-1/steer`, { method: "POST", body: JSON.stringify({ text: "x" }) })).status, 403);
  caller = "rai@example.com";
});

test("the owner launches a job: brief written, Routine fired with the job token, session recorded", async () => {
  caller = "rai@example.com";
  const res = await fetch(`${base}/jobs/launch`, { method: "POST", body: JSON.stringify({ routine: "orbit", brief: "Fix the bug." }) });
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.match(job.id, /^orbit-\d{12}-[a-z0-9]+$/);
  assert.deepEqual([job.launch.branch, job.launch.briefCommit, job.launch.sessionUrl], [`orbit/${job.id}`, "c0ffee", "https://claude.ai/code/cse_9"]);
  assert.equal(job.health, "ok");
  const token = fireText.match(/^Token: (.+)$/m)![1];
  assert.equal(JSON.stringify(job).includes(token), false, "the token is never returned");
  assert.equal(JSON.stringify(await (await fetch(`${base}/jobs/${job.id}`)).json()).includes(token), false);
  assert.ok(jobs.verify(job.id, token), "the fire text carries a token that works for this job");
  assert.match(fireText, /^Job id: orbit-/);
  assert.match(fireText, /^API: https:\/\/orbit\.example:8443$/m);
});

test("a launch that fails is recorded, notified, and flagged", async () => {
  caller = "rai@example.com";
  failFire = true;
  const res = await fetch(`${base}/jobs/launch`, { method: "POST", body: JSON.stringify({ routine: "orbit", brief: "x" }) });
  failFire = false;
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /routine not fired: HTTP 401/);
  assert.equal(body.job.health, "launch-failed");
  assert.ok(notify.recent().some((n) => n.text.includes("could not launch")));
});

test("launch refuses an unknown routine, a missing brief, and anyone but the owner", async () => {
  caller = "rai@example.com";
  assert.equal((await fetch(`${base}/jobs/launch`, { method: "POST", body: JSON.stringify({ routine: "nope", brief: "x" }) })).status, 400);
  assert.equal((await fetch(`${base}/jobs/launch`, { method: "POST", body: JSON.stringify({ routine: "orbit" }) })).status, 400);
  caller = "someone@example.com";
  assert.equal((await fetch(`${base}/jobs/launch`, { method: "POST", body: JSON.stringify({ routine: "orbit", brief: "x" }) })).status, 403);
  caller = "rai@example.com";
});
