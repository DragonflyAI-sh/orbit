import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultMemory } from "../src/memory.ts";
import { mockModel } from "../src/model.ts";
import { notifier } from "../src/notify.ts";
import { scheduler } from "../src/schedule.ts";
import { jsonStore } from "../src/store.ts";
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
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((name) => mockPort(name)),
  model: mockModel("test"),
  memory: vaultMemory(vault),
  notify,
  schedule,
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
  assert.deepEqual(body.ports.map((p: PortStatus) => p.port), ["policy", "channel", "model", "memory", "notify", "schedule", ...MOCK_PORT_NAMES]);
});

test("status shows the last failed deploy beside the running commit", async () => {
  const body = await (await fetch(`${base}/status`)).json();
  assert.deepEqual(body.deploy, deploy);
});

test("unbuilt ports say they are mocks", async () => {
  const body = await (await fetch(`${base}/status`)).json();
  for (const p of body.ports.filter((x: PortStatus) => MOCK_PORT_NAMES.includes(x.port as never))) {
    assert.equal(p.state, "mock");
  }
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
  assert.ok(body.limits.some((l: string) => l.startsWith("runs is mock")));
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

test("a mock answer carries mock provenance", async () => {
  const res = await fetch(`${base}/ports/runs/describe`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).provenance, "mock");
});

test("policy refuses actions that are not built", async () => {
  assert.equal(decide("tools", "run", true).allow, false);
  const res = await fetch(`${base}/ports/tools/run`, { method: "POST" });
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
