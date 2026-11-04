import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mockModel } from "../src/model.ts";
import { decide } from "../src/policy.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import type { PortStatus } from "../src/ports.ts";
import { buildServer, STALE_AFTER_MS, withStaleness } from "../src/server.ts";

const deploy = { lastFailed: { commit: "bad1", at: "2026-11-02T00:00:00Z" } };
const server = buildServer(MOCK_PORT_NAMES.map((name) => mockPort(name)), mockModel("test"), "abc123", () => deploy);
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
  assert.deepEqual(body.ports.map((p: PortStatus) => p.port), ["policy", "channel", "model", ...MOCK_PORT_NAMES]);
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
  assert.ok(body.limits.some((l: string) => l.startsWith("memory is mock")));
});

test("chat rejects malformed input", async () => {
  assert.equal((await chat({ messages: [] })).status, 400);
  assert.equal((await chat({ messages: [{ role: "system", content: "x" }] })).status, 400);
  assert.equal((await chat({ messages: [{ role: "assistant", content: "x" }] })).status, 400);
});

test("a mock answer carries mock provenance", async () => {
  const res = await fetch(`${base}/ports/memory/describe`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).provenance, "mock");
});

test("policy refuses anything but reads and chat", async () => {
  assert.equal(decide("notify", "send").allow, false);
  const res = await fetch(`${base}/ports/notify/send`, { method: "POST" });
  assert.equal(res.status, 403);
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
