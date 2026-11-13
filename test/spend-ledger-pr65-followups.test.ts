import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEDGER_FILE, MARKER_FILE, PROVISION_FILE, SpendError, spendLedger } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";

// PR65 review follow-ups 3, 4 and 5 (finding 1 and 2 are in spend-ledger-multiprocess.test.ts). Fakes and temporary directories only.
const WORKER = new URL("./helpers/ledger-worker.ts", import.meta.url).pathname;
const NOW = () => new Date("2026-11-12T10:00:00Z");
const dir = () => mkdtempSync(join(tmpdir(), "orbit-pr65-"));
const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };

// A real second process takes the ledger lock and stays inside its critical section for `ms` (a live competitor: never provably dead).
async function holder(d: string, ms: number): Promise<{ done: Promise<void> }> {
  const go = join(d, "go");
  writeFileSync(go, "");
  const child = spawn(process.execPath, [WORKER, JSON.stringify({ dir: d, caps, go, ops: [{ op: "reserve", micro: 1000 }], fault: { point: "locked", action: "hold", ms } })], { stdio: ["ignore", "pipe", "ignore"] });
  let buf = "";
  await new Promise<void>((resolve) =>
    child.stdout.on("data", (c) => {
      buf += c;
      if (buf.includes('"holding"')) resolve();
    }),
  );
  return { done: new Promise((r) => child.on("close", () => r())) };
}

test("follow-up 3: under lock contention a paid admission is refused within a small bound, and the event loop is not stalled for seconds; status reads stay instant", async () => {
  const d = dir();
  const l = provisioned(d, caps, NOW); // production default wait
  const h = await holder(d, 2500);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const t0 = Date.now();
  assert.throws(() => l.reserve(1000), (e: unknown) => e instanceof SpendError && e.code === "busy");
  const blocked = Date.now() - t0;
  assert.ok(blocked < 1000, `the synchronous wait was ${blocked} ms (the previous default blocked for about 3000 ms)`);
  // status path: no lock, so a held lock does not delay it at all
  const t1 = Date.now();
  for (let i = 0; i < 50; i++) assert.equal(l.inspect().state, "ok");
  assert.ok(Date.now() - t1 < 250, "inspect() never waits for the lock");
  // timers keep firing between refused calls (the loop is free again after each bounded wait)
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(timer);
  assert.ok(ticks > 0, "the event loop ran again right after the refusal");
  await h.done;
  assert.ok(l.reserve(1000).id, "once the holder has finished, admission works again; the refusal charged nothing");
});

test("follow-up 4: ledger AND marker both vanish after this process has used the ledger: loss, not 'unprovisioned'; status and admission agree", () => {
  const d = dir();
  const l = provisioned(d, caps, NOW);
  l.settle(l.reserve(1000).id, 800);
  rmSync(join(d, LEDGER_FILE));
  rmSync(join(d, MARKER_FILE));
  const seen = l.inspect();
  assert.equal(seen.state, "failed");
  assert.match((seen as { reason: string }).reason, /both disappeared since this process last read it.*spend since then is unknown/);
  for (const call of [() => l.reserve(1000), () => l.view()]) assert.throws(call, (e: unknown) => e instanceof SpendError && e.code === "ledger" && /both disappeared/.test(e.message));
  assert.ok(!existsSync(join(d, LEDGER_FILE)), "nothing was recreated");
  // A plain provision request after the loss does not give a fresh budget: it must acknowledge the loss.
  writeFileSync(join(d, PROVISION_FILE), JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0 }));
  assert.throws(() => l.open(), /must set acknowledgeLoss/);
  assert.ok(!existsSync(join(d, LEDGER_FILE)));
  // A deliberate recovery states the spend and is charged in full.
  writeFileSync(join(d, PROVISION_FILE), JSON.stringify({ acknowledgeLoss: true, openingLifetimeUsd: 0.5, openingTodayUsd: 0.1, note: "from the provider" }));
  assert.equal(l.open().lifetimeUsd, 0.5);
});

test("follow-up 4 (fresh install control): with no history this process has seen, both files absent is still just 'unprovisioned'", () => {
  const l = spendLedger(dir(), caps, NOW);
  assert.deepEqual(l.inspect(), { state: "unprovisioned", requested: false });
});

test("follow-up 5: no silent fresh budget: even the first provisioning must state the spend so far; '{}' creates nothing", () => {
  const d = dir();
  for (const text of ["{}", JSON.stringify({ note: "first" }), JSON.stringify({ openingLifetimeUsd: 0 })]) {
    writeFileSync(join(d, PROVISION_FILE), text);
    assert.throws(() => spendLedger(d, caps, NOW).open(), /must state openingLifetimeUsd and openingTodayUsd/, text);
    assert.ok(!existsSync(join(d, LEDGER_FILE)) && !existsSync(join(d, MARKER_FILE)), `${text}: nothing created`);
  }
  writeFileSync(join(d, PROVISION_FILE), JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0, note: "new key, dashboard shows $0" }));
  assert.equal(spendLedger(d, caps, NOW).open().lifetimeUsd, 0);
  assert.equal(JSON.parse(readFileSync(join(d, LEDGER_FILE), "utf8")).schema, 2);
});
