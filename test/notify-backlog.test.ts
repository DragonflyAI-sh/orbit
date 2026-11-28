import assert from "node:assert/strict";
import { test } from "node:test";
import { notifier, PUSH_MAX_AGE_MS } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";
import type { Notification } from "../src/notify.ts";

// A sink that connects for the first time (Nova's bot) or after a long outage must not flood the channel with a stale backlog:
// notes older than a day stay on the web page only.
test("pump never pushes a note older than a day; newer ones are pushed in order", async () => {
  let t = new Date("2026-11-27T20:00:00Z"); // 12:00 Pacific, outside quiet hours
  const sent: string[] = [];
  const n = notifier(jsonStore<Notification[]>(undefined, "notifications", []), { name: "discord", send: async (text) => (sent.push(text), `m${sent.length}`) }, () => t);
  n.send("old", true);
  t = new Date(t.getTime() + PUSH_MAX_AGE_MS + 60_000);
  n.send("new one", true);
  n.send("new two", true);
  await n.pump();
  assert.deepEqual(sent, ["new one", "new two"]);
  assert.equal(n.recent().find((x) => x.text === "old")?.discord, undefined, "the old note has no receipt: not sent, not failed");
});
