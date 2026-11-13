import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEDGER_FILE, PROVISION_FILE, spendLedger, toMicro } from "../src/spend-ledger.ts";

// Readiness audit (orbit-202611130644-epou), rollback compatibility. A rollback from 51c1ae3 (monthly caps, PR #70) to the release
// before it (42c5e7f) leaves the spend ledger in place. These tests pin that a ledger written under the current policy
// ($5/day, $150/UTC month, lifetime cap off) stays readable by the earlier validator, so a rollback keeps its spend history.

// The schema-2 keys 42c5e7f writes, plus the one optional key PR #70 added.
const LEGACY_KEYS = ["schema", "epoch", "seq", "createdAt", "lifetimeMicro", "days", "reservations", "uncertain"];
const ADDED_KEYS = ["priorMonthsMicro"];

// The acceptance checks of 42c5e7f:src/spend-ledger.ts validate(), restated (it ignores unknown keys and re-serialises the object).
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isMicro = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
function acceptedBy42c5e7f(l: any): boolean {
  if (!l || typeof l !== "object") return false;
  if (l.schema !== 1 && l.schema !== 2) return false;
  if (l.schema === 2 && (typeof l.epoch !== "string" || !l.epoch || !isMicro(l.seq))) return false;
  if (!isMicro(l.lifetimeMicro)) return false;
  if (!l.days || typeof l.days !== "object" || !l.reservations || typeof l.reservations !== "object" || !Array.isArray(l.uncertain)) return false;
  for (const [d, m] of Object.entries(l.days)) if (!DAY.test(d) || !isMicro(m)) return false;
  for (const r of Object.values(l.reservations) as any[]) {
    if (!r || !DAY.test(r.day) || !isMicro(r.micro)) return false;
    if (r.owner !== undefined && (!r.owner || !Number.isSafeInteger(r.owner.pid) || typeof r.owner.host !== "string")) return false;
  }
  return true;
}

test("readiness: a ledger written under 5/day + 150/month with the lifetime cap off keeps the earlier schema and passes the 42c5e7f checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-rollback-"));
  writeFileSync(join(dir, PROVISION_FILE), JSON.stringify({ openingLifetimeUsd: 1.25, openingTodayUsd: 0.25, openingMonthUsd: 0.75, note: "readiness test" }));
  let t = Date.parse("2026-11-13T10:00:00Z");
  const ledger = spendLedger(dir, { dailyMicro: toMicro(5), monthlyMicro: toMicro(150) }, () => new Date(t));
  ledger.open();
  ledger.settle(ledger.reserve(toMicro(0.5)).id, toMicro(0.1));
  const open = ledger.reserve(toMicro(0.2)); // still in flight when the "rollback" happens
  t += 60_000;

  const raw = JSON.parse(readFileSync(join(dir, LEDGER_FILE), "utf8"));
  assert.equal(raw.schema, 2);
  for (const k of Object.keys(raw)) assert.ok(LEGACY_KEYS.includes(k) || ADDED_KEYS.includes(k), `unexpected ledger key ${k} would be new to the earlier release`);
  for (const k of LEGACY_KEYS) assert.ok(k in raw, `ledger keeps ${k}`);
  assert.ok(acceptedBy42c5e7f(raw), "the earlier release's validator accepts the ledger");
  assert.ok(raw.reservations[open.id], "the in-flight reservation is in the file, so the earlier release still counts it");
  // Spend history survives: opening balance plus the settled call.
  assert.equal(raw.lifetimeMicro, toMicro(1.25) + toMicro(0.1));
});
