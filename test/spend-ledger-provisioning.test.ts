import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEDGER_FILE, MARKER_FILE, PROVISION_FILE, SpendError, spendLedger } from "../src/spend-ledger.ts";

// B8: a missing ledger is never a fresh budget. Local markers are the narrow design here; they detect deletion of the ledger file
// alone, not loss of the whole state directory (documented in docs/openrouter-ledger-integrity.md).

const FIRST = JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0, note: "test" });
const NOW = () => new Date("2026-11-12T10:00:00Z");
const caps = { dailyMicro: 5_000_000, totalMicro: 150_000_000 };
const dir = () => mkdtempSync(join(tmpdir(), "orbit-prov-"));
const L = (d: string) => spendLedger(d, caps, NOW);
const refuses = (fn: () => unknown, re: RegExp, msg?: string) => assert.throws(fn, (e: unknown) => e instanceof SpendError && e.code === "ledger" && re.test(e.message), msg);
const snapshot = (d: string) => Object.fromEntries(readdirSync(d).map((f) => [f, readFileSync(join(d, f), "utf8")]));

test("no ledger and no provision request: startup, view, reserve and status all refuse and create nothing", () => {
  const d = dir();
  const l = L(d);
  refuses(() => l.open(), /has not been provisioned/);
  refuses(() => l.view(), /has not been provisioned/);
  refuses(() => l.reserve(1000), /has not been provisioned/);
  for (let i = 0; i < 5; i++) assert.deepEqual(l.inspect(), { state: "unprovisioned", requested: false });
  assert.deepEqual(readdirSync(d), [], "nothing was created: the lock file is removed again and no ledger or marker appeared");
});

test("a provision request is applied ONLY by the explicit startup step, once, and is retired as used", () => {
  const d = dir();
  writeFileSync(join(d, PROVISION_FILE), FIRST);
  const l = L(d);
  // Polling status and an ordinary call do not apply it.
  assert.deepEqual(l.inspect(), { state: "unprovisioned", requested: true });
  refuses(() => l.reserve(1000), /has not been provisioned/);
  assert.deepEqual(readdirSync(d), [PROVISION_FILE]);
  const v = l.open();
  assert.equal(v.lifetimeUsd, 0);
  const files = readdirSync(d).sort();
  const epoch = JSON.parse(readFileSync(join(d, MARKER_FILE), "utf8")).epoch;
  assert.deepEqual(files, [LEDGER_FILE, MARKER_FILE, `${PROVISION_FILE}.used-${epoch}`].sort());
  assert.equal(JSON.parse(readFileSync(join(d, LEDGER_FILE), "utf8")).epoch, epoch, "ledger and marker name the same identity");
  assert.equal(l.inspect().state, "ok");
  // Starting again changes nothing and cannot re-provision.
  const same = snapshot(d);
  L(d).open();
  assert.equal(JSON.stringify(snapshot(d)).length > 0, true);
  assert.equal(readFileSync(join(d, MARKER_FILE), "utf8"), same[MARKER_FILE]);
});

test("ledger deleted after provisioning: every path refuses, nothing is recreated, even with a stale provision file left over", () => {
  const d = dir();
  writeFileSync(join(d, PROVISION_FILE), FIRST);
  const l = L(d);
  l.open();
  l.settle(l.reserve(1000).id, 800);
  rmSync(join(d, LEDGER_FILE));
  const restart = L(d);
  refuses(() => restart.open(), /missing although a history marker shows one existed/);
  refuses(() => restart.reserve(1000), /missing although a history marker/);
  refuses(() => restart.view(), /missing although a history marker/);
  const seen = restart.inspect();
  assert.equal(seen.state, "failed");
  assert.ok(!existsSync(join(d, LEDGER_FILE)), "no zero-spend ledger was created");
  // A leftover `{}` (the first provisioning's request) is not a recovery: it does not say the loss is acknowledged.
  writeFileSync(join(d, PROVISION_FILE), "{}");
  refuses(() => L(d).open(), /history marker exists, so this is a recovery/);
  writeFileSync(join(d, PROVISION_FILE), JSON.stringify({ acknowledgeLoss: true }));
  refuses(() => L(d).open(), /must state openingLifetimeUsd and openingTodayUsd/);
  assert.ok(!existsSync(join(d, LEDGER_FILE)));
});

test("recovery after a loss is deliberate and states the spend: the opening balance is charged and recorded, the old identity is not reused", () => {
  const d = dir();
  writeFileSync(join(d, PROVISION_FILE), FIRST);
  L(d).open();
  const oldEpoch = JSON.parse(readFileSync(join(d, MARKER_FILE), "utf8")).epoch;
  rmSync(join(d, LEDGER_FILE));
  rmSync(join(d, `${PROVISION_FILE}.used-${oldEpoch}`));
  writeFileSync(join(d, PROVISION_FILE), JSON.stringify({ acknowledgeLoss: true, openingLifetimeUsd: 12.5, openingTodayUsd: 0.3, note: "read from the provider dashboard" }));
  const v = L(d).open();
  assert.equal(v.lifetimeUsd, 12.5);
  assert.equal(v.spentTodayUsd, 0.3);
  assert.equal(v.uncertainRequests, 1, "the declared opening is recorded as owner-declared, not as measured");
  const ledger = JSON.parse(readFileSync(join(d, LEDGER_FILE), "utf8"));
  assert.match(ledger.uncertain[0].why, /RECOVERY after ledger loss.*read from the provider dashboard/);
  assert.notEqual(ledger.epoch, oldEpoch);
  assert.equal(JSON.parse(readFileSync(join(d, MARKER_FILE), "utf8")).epoch, ledger.epoch);
  assert.ok(readdirSync(d).some((f) => f.startsWith(`${PROVISION_FILE}.used-`)) && !existsSync(join(d, PROVISION_FILE)), "the request cannot be applied twice");
  // The new ledger enforces the caps with that spend in it: $12.50 of $150 used, so $140 more is refused.
  assert.throws(() => spendLedger(d, { dailyMicro: 150_000_000, totalMicro: 150_000_000 }, NOW).reserve(140_000_000), (e: unknown) => e instanceof SpendError && e.code === "total_cap");
});

test("a provision request with invalid amounts or text is refused and consumed by nothing", () => {
  for (const bad of ["not json", "[]", JSON.stringify({ openingLifetimeUsd: -1 }), JSON.stringify({ openingLifetimeUsd: 1, openingTodayUsd: 2 }), JSON.stringify({ openingLifetimeUsd: "5" })]) {
    const d = dir();
    writeFileSync(join(d, PROVISION_FILE), bad);
    refuses(() => L(d).open(), /provision file/, bad);
    assert.deepEqual(readdirSync(d), [PROVISION_FILE], `${bad}: left for the owner to fix`);
  }
});

test("a provision request never overwrites or resets an existing ledger, and an existing ledger is never replaced", () => {
  const d = dir();
  writeFileSync(join(d, PROVISION_FILE), FIRST);
  const l = L(d);
  l.open();
  l.settle(l.reserve(1000).id, 800);
  const before = readFileSync(join(d, LEDGER_FILE), "utf8");
  // An owner (or a leftover) drops a recovery request next to a live ledger: it is retired, the spend is untouched.
  writeFileSync(join(d, PROVISION_FILE), JSON.stringify({ acknowledgeLoss: true, openingLifetimeUsd: 0, openingTodayUsd: 0 }));
  const v = L(d).open();
  assert.equal(v.lifetimeUsd, 0.0008);
  assert.equal(JSON.parse(readFileSync(join(d, LEDGER_FILE), "utf8")).lifetimeMicro, JSON.parse(before).lifetimeMicro);
  assert.ok(!existsSync(join(d, PROVISION_FILE)), "retired so it cannot apply to a later loss");
});

test("a ledger that does not belong to its marker (replaced or restored from another install) is refused", () => {
  const a = dir();
  const b = dir();
  for (const x of [a, b]) {
    writeFileSync(join(x, PROVISION_FILE), FIRST);
    L(x).open();
  }
  const foreign = readFileSync(join(b, LEDGER_FILE));
  writeFileSync(join(a, LEDGER_FILE), foreign);
  refuses(() => L(a).open(), /do not belong together/);
  refuses(() => L(a).reserve(1000), /do not belong together/);
  const seen = L(a).inspect();
  assert.equal(seen.state, "failed");
  assert.equal((seen as { reason: string }).reason.includes(a), false, "no path in the status reason");
});

test("a lost marker does not lose spend: the ledger is authoritative and the marker is written again from it; a schema 1 ledger is upgraded", () => {
  const d = dir();
  writeFileSync(join(d, PROVISION_FILE), FIRST);
  const l = L(d);
  l.open();
  l.settle(l.reserve(1000).id, 800);
  rmSync(join(d, MARKER_FILE));
  assert.equal(L(d).open().lifetimeUsd, 0.0008);
  assert.equal(JSON.parse(readFileSync(join(d, MARKER_FILE), "utf8")).epoch, JSON.parse(readFileSync(join(d, LEDGER_FILE), "utf8")).epoch);
  // A ledger written by the previous version (no identity at all) is kept, given one, and gets its marker.
  const old = dir();
  writeFileSync(join(old, LEDGER_FILE), JSON.stringify({ schema: 1, createdAt: "2026-11-01T00:00:00.000Z", lifetimeMicro: 1_500_000, days: { "2026-11-12": 500_000 }, reservations: {}, uncertain: [] }));
  const v = L(old).open();
  assert.equal(v.lifetimeUsd, 1.5);
  assert.ok(existsSync(join(old, MARKER_FILE)));
  assert.equal(JSON.parse(readFileSync(join(old, LEDGER_FILE), "utf8")).schema, 2);
});

test("a crash during provisioning never leaves a marker without a ledger: the request is simply applied again at the next start", () => {
  for (const point of ["tmp-written", "renamed", "written"]) {
    const d = dir();
    writeFileSync(join(d, PROVISION_FILE), FIRST);
    const l = spendLedger(d, caps, NOW, {
      fault: (p) => {
        if (p === point) throw new Error("injected crash");
      },
    });
    assert.throws(() => l.open(), /injected/);
    assert.ok(!existsSync(join(d, MARKER_FILE)), `${point}: the marker is written only after the ledger`);
    assert.ok(existsSync(join(d, PROVISION_FILE)), `${point}: the request is not consumed before the ledger and marker exist`);
    // "renamed"/"written": the ledger is there already; the next start finds ledger-without-marker and completes it, never loses spend.
    const v = L(d).open();
    assert.equal(v.lifetimeUsd, 0);
    assert.ok(existsSync(join(d, MARKER_FILE)));
    assert.ok(!existsSync(join(d, PROVISION_FILE)));
  }
});
