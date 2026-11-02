import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { decide } from "../src/policy.ts";
import { mockPort, PORT_NAMES } from "../src/ports.ts";
import type { PortStatus } from "../src/ports.ts";
import { buildServer, STALE_AFTER_MS, withStaleness } from "../src/server.ts";

const server = buildServer(PORT_NAMES.map((name) => mockPort(name)), "abc123");
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("status reports the commit and every port", async () => {
  const body = await (await fetch(`${base}/status`)).json();
  assert.equal(body.commit, "abc123");
  assert.deepEqual(body.ports.map((p: PortStatus) => p.port), ["policy", ...PORT_NAMES]);
});

test("unbuilt ports say they are mocks", async () => {
  const body = await (await fetch(`${base}/status`)).json();
  for (const p of body.ports.filter((x: PortStatus) => x.port !== "policy")) {
    assert.equal(p.state, "mock");
  }
});

test("a mock answer carries mock provenance", async () => {
  const res = await fetch(`${base}/ports/memory/describe`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).provenance, "mock");
});

test("policy refuses anything but describe", async () => {
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
