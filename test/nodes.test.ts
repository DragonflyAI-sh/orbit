import assert from "node:assert/strict";
import { test } from "node:test";
import { nodes } from "../src/nodes.ts";

const status = {
  Self: { HostName: "orbit-dedicated-8", OS: "linux" },
  User: { "1": { LoginName: "rai@example.com" }, "2": { LoginName: "guest@example.com" } },
  Peer: {
    a: { HostName: "Rai's MacBook Air", OS: "macOS", Online: true, LastSeen: "2026-11-03T22:30:00Z", UserID: 1 },
    b: { HostName: "rai-macbookpro14-1", OS: "linux", Online: false, LastSeen: "2026-11-02T16:56:55Z", UserID: 1 },
    c: { HostName: "localhost", OS: "iOS", Online: true, UserID: 1 },
    d: { HostName: "guest-laptop", OS: "windows", Online: true, UserID: 2 },
  },
};

test("only the owner's devices are listed, with last-seen only when offline", async () => {
  const presence = nodes(async () => status, "rai@example.com");
  await presence.refresh();
  const { devices } = presence.list();
  assert.deepEqual(devices.map((d) => d.name), ["orbit-dedicated-8", "Rai's MacBook Air", "rai-macbookpro14-1", "iOS device"]);
  assert.equal(devices[1].lastSeen, undefined);
  assert.equal(devices[2].lastSeen, "2026-11-02T16:56:55Z");
  assert.match(presence.status().detail, /3 of 4 devices online/);
  assert.equal(presence.status().state, "live");
  assert.match(presence.summary(), /rai-macbookpro14-1 \(linux\): offline, last seen/);
});

test("without an owner, no peers are trusted as the owner's", async () => {
  const presence = nodes(async () => status, undefined);
  await presence.refresh();
  assert.deepEqual(presence.list().devices.map((d) => d.name), ["orbit-dedicated-8"]);
});

test("a tailscaled failure is down before any success, degraded after one", async () => {
  let fail = true;
  const presence = nodes(async () => {
    if (fail) throw new Error("tailscaled did not answer");
    return status;
  }, "rai@example.com");
  await presence.refresh();
  assert.equal(presence.status().state, "down");
  fail = false;
  await presence.refresh();
  fail = true;
  await presence.refresh();
  assert.equal(presence.status().state, "degraded");
  assert.match(presence.status().detail, /Last check failed/);
});

test("presence goes stale if it stops refreshing", async () => {
  let clock = new Date("2026-11-04T00:00:00Z");
  const presence = nodes(async () => status, "rai@example.com", () => clock);
  await presence.refresh();
  clock = new Date("2026-11-04T00:06:00Z");
  assert.equal(presence.status().state, "degraded");
});
