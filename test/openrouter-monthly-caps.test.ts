import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort } from "../src/model.ts";
import { CAP_OFF, DEFAULT_TOTAL_CAP_USD, openrouterConfig, spendCapsOf } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { LEDGER_FILE, PROVISION_FILE, SpendError, spendLedger, toMicro } from "../src/spend-ledger.ts";
import type { SpendCaps } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";

// Configurable daily + monthly (UTC calendar month) + lifetime spend caps. Offline only: no provider is called, time is a variable,
// every ledger lives in its own temporary directory.

const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048",
  CREDENTIALS_DIRECTORY: "/creds",
};
const readKey = () => KEY;
const cfgOf = (over: Record<string, string | undefined>) => openrouterConfig({ ...ENV, ...over }, readKey);
const ready = (over: Record<string, string | undefined>) => {
  const c = cfgOf(over);
  assert.equal(c.state, "ready", JSON.stringify(c));
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};
const unavailable = (over: Record<string, string | undefined>, re: RegExp) => {
  const c = cfgOf(over);
  assert.equal(c.state, "unavailable", JSON.stringify(over));
  assert.match((c as { reason: string }).reason, re, JSON.stringify(over));
};
// Rai's intended production budget: 5 USD per UTC day, 150 USD per UTC calendar month, no lifetime cutoff.
const PROPOSED = { ORBIT_OPENROUTER_DAILY_CAP_USD: "5", ORBIT_OPENROUTER_MONTHLY_CAP_USD: "150", ORBIT_OPENROUTER_TOTAL_CAP_USD: "off" };

const dir = () => mkdtempSync(join(tmpdir(), "orbit-month-"));
const clock = (iso: string) => {
  let t = Date.parse(iso);
  return { now: () => new Date(t), set: (s: string) => void (t = Date.parse(s)) };
};
const USD = toMicro;
const code = (c: string) => (e: unknown) => e instanceof SpendError && e.code === c;
const fileOf = (d: string) => JSON.parse(readFileSync(join(d, LEDGER_FILE), "utf8"));
const provisionWith = (d: string, p: Record<string, unknown>) => writeFileSync(join(d, PROVISION_FILE), JSON.stringify({ note: "test", ...p }));
// A process that is proven gone (same host, boot and pid namespace; the pid does not exist).
const GONE = { pid: 2_147_483_000, start: "1" };

// ---- configuration ----------------------------------------------------------------------------------------------------

test("config: the proposed 5/day + 150/month with the lifetime cap off is ready, and the ledger gets no lifetime cap", () => {
  const c = ready(PROPOSED);
  assert.deepEqual([c.dailyCapUsd, c.monthlyCapUsd, c.totalCapUsd], [5, 150, null]);
  assert.deepEqual(spendCapsOf(c), { dailyMicro: 5_000_000, monthlyMicro: 150_000_000 });
  // "off" is case-insensitive and may carry spaces, like every other setting.
  assert.equal(ready({ ...PROPOSED, ORBIT_OPENROUTER_TOTAL_CAP_USD: " OFF " }).totalCapUsd, null);
});

test("config: existing settings keep exactly their meaning; TOTAL stays the lifetime cap and is never read as monthly", () => {
  const none = ready({});
  assert.deepEqual([none.dailyCapUsd, none.monthlyCapUsd, none.totalCapUsd], [5, null, DEFAULT_TOTAL_CAP_USD]);
  assert.deepEqual(spendCapsOf(none), { dailyMicro: 5_000_000, totalMicro: 150_000_000 });
  const explicit = ready({ ORBIT_OPENROUTER_DAILY_CAP_USD: "5", ORBIT_OPENROUTER_TOTAL_CAP_USD: "150" });
  assert.deepEqual([explicit.monthlyCapUsd, explicit.totalCapUsd], [null, 150]);
  // Both, explicitly: a monthly budget inside a larger lifetime cap.
  const both = ready({ ORBIT_OPENROUTER_DAILY_CAP_USD: "5", ORBIT_OPENROUTER_MONTHLY_CAP_USD: "150", ORBIT_OPENROUTER_TOTAL_CAP_USD: "1000" });
  assert.deepEqual(spendCapsOf(both), { dailyMicro: 5_000_000, monthlyMicro: 150_000_000, totalMicro: 1_000_000_000 });
});

test("config: a monthly cap without an explicit lifetime setting is refused, so the old 150 lifetime default never sneaks in", () => {
  unavailable({ ORBIT_OPENROUTER_MONTHLY_CAP_USD: "150" }, /TOTAL_CAP_USD \(the LIFETIME cap, which never resets\) must be set explicitly/);
  unavailable({ ORBIT_OPENROUTER_MONTHLY_CAP_USD: "150", ORBIT_OPENROUTER_TOTAL_CAP_USD: "  " }, /must be set explicitly/);
});

test("config: the lifetime cap can be off only together with a monthly cap; daily alone is never enough", () => {
  unavailable({ ORBIT_OPENROUTER_TOTAL_CAP_USD: "off" }, /only when ORBIT_OPENROUTER_MONTHLY_CAP_USD is set/);
  unavailable({ ORBIT_OPENROUTER_DAILY_CAP_USD: "off" }, /DAILY_CAP_USD cannot be off/);
  unavailable({ ...PROPOSED, ORBIT_OPENROUTER_MONTHLY_CAP_USD: "off" }, /MONTHLY_CAP_USD cannot be off/);
});

test("config: zero, negative, non-numeric, non-finite and oversized caps are refused with a reason, for every cap", () => {
  for (const name of ["ORBIT_OPENROUTER_DAILY_CAP_USD", "ORBIT_OPENROUTER_MONTHLY_CAP_USD", "ORBIT_OPENROUTER_TOTAL_CAP_USD"]) {
    const base = name.includes("DAILY") ? PROPOSED : { ...PROPOSED, ORBIT_OPENROUTER_TOTAL_CAP_USD: "1000" };
    for (const v of ["0", "0.0", "+0", "000"]) unavailable({ ...base, [name]: v }, /is 0, which is not accepted.*ORBIT_OPENROUTER_ENABLED=0/);
    for (const v of ["-1", "-0.5", "abc", "NaN", "Infinity", "-Infinity", "0x10", "5 USD", "1,5", "5$", "1e", "--1"]) unavailable({ ...base, [name]: v }, /must be a plain number of USD/);
    for (const v of ["10001", "1e10", "9.1e9"]) unavailable({ ...base, [name]: v }, /at most 10000/);
  }
  // Values ORBIT already accepted keep working.
  assert.equal(ready({ ORBIT_OPENROUTER_DAILY_CAP_USD: "0.75", ORBIT_OPENROUTER_TOTAL_CAP_USD: "1" }).dailyCapUsd, 0.75);
  assert.equal(ready({ ORBIT_OPENROUTER_TOTAL_CAP_USD: "10000" }).totalCapUsd, 10000);
  assert.equal(ready({ ...PROPOSED, ORBIT_OPENROUTER_MONTHLY_CAP_USD: "1.5e2" }).monthlyCapUsd, 150);
});

test("config: the caps must nest (daily <= monthly <= lifetime), and the daily cap still has to cover the largest request", () => {
  unavailable({ ...PROPOSED, ORBIT_OPENROUTER_DAILY_CAP_USD: "200" }, /daily cap cannot exceed the monthly cap/);
  unavailable({ ...PROPOSED, ORBIT_OPENROUTER_TOTAL_CAP_USD: "100" }, /monthly cap cannot exceed the lifetime cap/);
  unavailable({ ORBIT_OPENROUTER_DAILY_CAP_USD: "200" }, /daily cap cannot exceed the lifetime cap/);
  unavailable({ ...PROPOSED, ORBIT_OPENROUTER_DAILY_CAP_USD: "0.0001", ORBIT_OPENROUTER_MONTHLY_CAP_USD: "1" }, /below the reservation for the largest request/);
});

test("ledger: caps are validated; a monthly or lifetime cap is required besides the daily one; 0 is never unlimited", () => {
  assert.throws(() => spendLedger(undefined, { dailyMicro: 1000 }), (e: unknown) => e instanceof SpendError && e.code === "bad_amount" && /monthly or a lifetime/.test(e.message));
  for (const caps of [{ dailyMicro: 1000, monthlyMicro: 0 }, { dailyMicro: 1000, monthlyMicro: -1 }, { dailyMicro: 1000, monthlyMicro: 1.5 }, { dailyMicro: 1000, monthlyMicro: Number.NaN }, { dailyMicro: 1000, monthlyMicro: Infinity }, { dailyMicro: 1000, totalMicro: 0 }] as SpendCaps[]) {
    assert.throws(() => spendLedger(undefined, caps), code("bad_amount"), JSON.stringify(caps));
  }
  assert.doesNotThrow(() => spendLedger(undefined, { dailyMicro: 1000, monthlyMicro: 2000 }));
});

// ---- enforcement ------------------------------------------------------------------------------------------------------

test("daily cap is enforced on its own: a day's cap stops that day only, the monthly allowance is untouched", () => {
  const c = clock("2026-11-12T10:00:00Z");
  const l = provisioned(dir(), { dailyMicro: USD(1), monthlyMicro: USD(100) }, c.now);
  l.settle(l.reserve(USD(0.8)).id, USD(0.8));
  assert.throws(() => l.reserve(USD(0.3)), (e: unknown) => code("daily_cap")(e) && /UTC day 2026-11-12, resets 2026-11-13T00:00:00\.000Z/.test((e as Error).message));
  let v = l.view();
  assert.equal(v.remainingTodayUsd, 0.2);
  assert.equal(v.remainingMonthUsd, 99.2);
  assert.equal(v.remainingTotalUsd, null, "no lifetime cap configured");
  assert.deepEqual(v.exhausted, []);
  l.settle(l.reserve(USD(0.2)).id, USD(0.2));
  assert.deepEqual(l.view().exhausted, ["daily"]);
  c.set("2026-11-13T00:00:00Z");
  v = l.view();
  assert.deepEqual([v.spentTodayUsd, v.spentMonthUsd, v.remainingTodayUsd, v.exhausted.length], [0, 1, 1, 0]);
  assert.doesNotThrow(() => l.reserve(USD(0.5)));
});

test("monthly cap is enforced on its own: days under their daily cap still stop at the month's total, until the next UTC month", () => {
  const c = clock("2026-11-01T00:00:00Z");
  const d = dir();
  const l = provisioned(d, { dailyMicro: USD(5), monthlyMicro: USD(12) }, c.now);
  for (const day of ["01", "02"]) {
    c.set(`2026-11-${day}T12:00:00Z`);
    l.settle(l.reserve(USD(5)).id, USD(5));
  }
  c.set("2026-11-03T12:00:00Z");
  assert.equal(l.view().remainingTodayUsd, 2, "the month, not the day, is what limits today");
  assert.equal(l.view().remainingMonthUsd, 2);
  assert.throws(() => l.reserve(USD(3)), (e: unknown) => code("monthly_cap")(e) && /monthly cap of \$12\.00 \(UTC month 2026-11, resets 2026-12-01T00:00:00\.000Z\)/.test((e as Error).message));
  l.settle(l.reserve(USD(2)).id, USD(2));
  const v = l.view();
  assert.deepEqual(v.exhausted, ["monthly"]);
  assert.equal(v.spentMonthUsd, 12);
  assert.equal(v.resets.monthlyAt, "2026-12-01T00:00:00.000Z");
  c.set("2026-11-30T23:59:59Z");
  assert.throws(() => l.reserve(1), code("monthly_cap"), "a new day does not reset the month");
  c.set("2026-12-01T00:00:00Z");
  assert.equal(l.view().spentMonthUsd, 0);
  assert.doesNotThrow(() => l.reserve(USD(5)));
  // History is kept: November's days are still in the file.
  assert.deepEqual(fileOf(d).days, { "2026-11-01": 5_000_000, "2026-11-02": 5_000_000, "2026-11-03": 2_000_000 });
});

test("year rollover: December's spend does not count in January, and the reset time crosses into the new year", () => {
  const c = clock("2026-12-31T23:00:00Z");
  const l = provisioned(dir(), { dailyMicro: USD(5), monthlyMicro: USD(5) }, c.now);
  l.settle(l.reserve(USD(5)).id, USD(5));
  assert.deepEqual(l.view().resets, { dailyAt: "2027-01-01T00:00:00.000Z", monthlyAt: "2027-01-01T00:00:00.000Z" });
  assert.throws(() => l.reserve(1), code("daily_cap"));
  c.set("2027-01-01T00:00:00Z");
  const v = l.view();
  assert.deepEqual([v.month, v.spentMonthUsd, v.lifetimeUsd, v.remainingTodayUsd], ["2027-01", 0, 5, 5]);
  // The same month number of another year is another month.
  c.set("2027-12-15T00:00:00Z");
  assert.equal(l.view().spentMonthUsd, 0);
});

test("lifetime cap still enforced next to a monthly cap (explicit lifetime caps keep working), and it never resets", () => {
  const c = clock("2026-11-12T10:00:00Z");
  const l = provisioned(dir(), { dailyMicro: USD(5), monthlyMicro: USD(10), totalMicro: USD(12) }, c.now);
  l.settle(l.reserve(USD(5)).id, USD(5));
  c.set("2026-11-13T10:00:00Z");
  l.settle(l.reserve(USD(5)).id, USD(5));
  c.set("2026-12-01T10:00:00Z");
  assert.equal(l.view().remainingTodayUsd, 2, "the lifetime cap binds after the month reset");
  assert.throws(() => l.reserve(USD(3)), (e: unknown) => code("total_cap")(e) && /never resets/.test((e as Error).message));
  // A lifetime-only ledger (the configuration before monthly caps) behaves as it always did.
  const old = provisioned(dir(), { dailyMicro: USD(5), totalMicro: USD(6) }, c.now);
  old.settle(old.reserve(USD(5)).id, USD(5));
  c.set("2027-02-01T10:00:00Z");
  assert.throws(() => old.reserve(USD(2)), code("total_cap"));
  assert.equal(old.view().caps.monthlyUsd, null);
  assert.equal(old.view().spentMonthUsd, 0, "the month is still reported, just not enforced");
});

// ---- reservations, uncertain charges and rollover -----------------------------------------------------------------------

test("a reservation in flight across a month boundary counts against the new month until settled, then is charged once to its own day", () => {
  const c = clock("2026-11-30T23:59:50Z");
  const d = dir();
  const l = provisioned(d, { dailyMicro: USD(5), monthlyMicro: USD(6) }, c.now);
  l.settle(l.reserve(USD(2)).id, USD(2));
  const r = l.reserve(USD(3));
  c.set("2026-12-01T00:00:05Z");
  let v = l.view();
  assert.deepEqual([v.spentMonthUsd, v.reservedUsd, v.remainingTodayUsd, v.remainingMonthUsd], [0, 3, 2, 3], "the pending bound still occupies budget");
  assert.throws(() => l.reserve(USD(2.5)), code("daily_cap"), "rollover does not free a pending reservation's budget");
  l.settle(r.id, USD(1));
  v = l.view();
  assert.deepEqual([v.spentMonthUsd, v.spentTodayUsd, v.reservedUsd, v.lifetimeUsd], [0, 0, 0, 3]);
  assert.deepEqual(fileOf(d).days, { "2026-11-30": 3_000_000 }, "charged to the day it was reserved on, once");
  c.set("2026-11-30T23:59:59Z");
  assert.equal(l.view().spentMonthUsd, 3);
});

test("an unknown cost across a year boundary charges the whole bound to the reserving month, as uncertain, never twice", () => {
  const c = clock("2026-12-31T23:59:00Z");
  const d = dir();
  const l = provisioned(d, { dailyMicro: USD(5), monthlyMicro: USD(10), totalMicro: USD(100) }, c.now);
  const r = l.reserve(USD(4));
  c.set("2027-01-01T00:01:00Z");
  l.settle(r.id, undefined, "no answer");
  const v = l.view();
  assert.deepEqual([v.spentMonthUsd, v.lifetimeUsd, v.uncertainRequests], [0, 4, 1]);
  assert.deepEqual(fileOf(d).days, { "2026-12-31": 4_000_000 });
  assert.equal(fileOf(d).uncertain[0].day, "2026-12-31");
});

test("an orphaned reservation found after a restart in the next month is charged at its bound to the month it was made in", () => {
  const c = clock("2026-11-30T23:59:00Z");
  const d = dir();
  const caps = { dailyMicro: USD(5), monthlyMicro: USD(6) };
  provisioned(d, caps, c.now);
  // A process that has since died reserved 4 and never settled.
  spendLedger(d, caps, c.now, { identity: GONE }).reserve(USD(4));
  c.set("2026-12-01T08:00:00Z");
  const restarted = spendLedger(d, caps, c.now);
  const v = restarted.open();
  assert.deepEqual([v.reservedUsd, v.spentMonthUsd, v.lifetimeUsd, v.uncertainRequests], [0, 0, 4, 1]);
  assert.deepEqual(fileOf(d).days, { "2026-11-30": 4_000_000 });
  // Opening again adopts nothing more: no double charge.
  assert.equal(spendLedger(d, caps, c.now).open().lifetimeUsd, 4);
  c.set("2026-11-30T23:59:30Z");
  assert.throws(() => spendLedger(d, caps, c.now).reserve(USD(1.5)), code("daily_cap"), "November 30 now holds the orphan's 4");
  c.set("2026-11-15T12:00:00Z");
  assert.throws(() => spendLedger(d, caps, c.now).reserve(USD(2.5)), code("monthly_cap"), "and so does November");
});

test("a live reservation of another owner keeps counting against the monthly cap after a restart; nothing is cleared", () => {
  const c = clock("2026-11-10T10:00:00Z");
  const d = dir();
  const caps = { dailyMicro: USD(10), monthlyMicro: USD(6) };
  provisioned(d, caps, c.now);
  const me = spendLedger(d, caps, c.now);
  me.reserve(USD(4));
  c.set("2026-11-11T10:00:00Z");
  const other = spendLedger(d, caps, c.now);
  assert.equal(other.open().reservedUsd, 4, "the owner is alive: still reserved, not orphaned");
  assert.throws(() => other.reserve(USD(2.5)), code("monthly_cap"));
});

// ---- restart, migration and lowered caps --------------------------------------------------------------------------------

test("monthly spend survives a restart: it is rebuilt from the file, not kept in memory", () => {
  const c = clock("2026-11-05T10:00:00Z");
  const d = dir();
  const caps = { dailyMicro: USD(5), monthlyMicro: USD(8) };
  const l = provisioned(d, caps, c.now);
  l.settle(l.reserve(USD(5)).id, USD(5));
  c.set("2026-11-06T10:00:00Z");
  const again = spendLedger(d, caps, c.now);
  assert.equal(again.open().spentMonthUsd, 5);
  assert.throws(() => again.reserve(USD(3.5)), code("monthly_cap"));
  const seen = again.inspect();
  assert.equal(seen.state, "ok");
  assert.equal(seen.state === "ok" && seen.view.remainingMonthUsd, 3);
});

test("migration: an opening balance with no month split counts in full against the creation month, and only that month", () => {
  const c = clock("2026-11-20T10:00:00Z");
  const d = dir();
  provisionWith(d, { openingLifetimeUsd: 40, openingTodayUsd: 1 });
  const caps = { dailyMicro: USD(5), monthlyMicro: USD(50) };
  const l = spendLedger(d, caps, c.now);
  const v = l.open();
  assert.deepEqual([v.lifetimeUsd, v.spentTodayUsd, v.spentMonthUsd, v.remainingMonthUsd], [40, 1, 40, 10]);
  c.set("2026-12-01T00:00:00Z");
  assert.equal(l.view().spentMonthUsd, 0, "spent before creation, so never in a later month");
  c.set("2026-10-31T00:00:00Z");
  assert.equal(l.view().spentMonthUsd, 39, "a clock reading an earlier month counts it there too (conservative)");
});

test("migration: openingMonthUsd places the rest of the opening balance before the creation month; bad splits are refused", () => {
  const c = clock("2026-11-20T10:00:00Z");
  const d = dir();
  provisionWith(d, { openingLifetimeUsd: 40, openingTodayUsd: 1, openingMonthUsd: 6 });
  const l = spendLedger(d, { dailyMicro: USD(5), monthlyMicro: USD(50) }, c.now);
  assert.equal(l.open().spentMonthUsd, 6);
  assert.equal(fileOf(d).priorMonthsMicro, 34_000_000);
  for (const month of [0.5, 41, -1, "6", null]) {
    const e = dir();
    provisionWith(e, { openingLifetimeUsd: 40, openingTodayUsd: 1, openingMonthUsd: month });
    assert.throws(() => spendLedger(e, { dailyMicro: USD(5), monthlyMicro: USD(50) }, c.now).open(), (x: unknown) => code("ledger")(x) && /openingMonthUsd/.test((x as Error).message), String(month));
  }
});

test("migration fails closed: a ledger whose day table exceeds its lifetime total cannot give a monthly total, so a monthly cap refuses every call", () => {
  const c = clock("2026-11-20T10:00:00Z");
  const d = dir();
  provisioned(d, { dailyMicro: USD(5), totalMicro: USD(150) }, c.now);
  const f = fileOf(d);
  f.days["2026-11-01"] = 7_000_000; // 7 in the day table, 0 lifetime: inconsistent
  writeFileSync(join(d, LEDGER_FILE), JSON.stringify(f));
  const monthly = spendLedger(d, { dailyMicro: USD(5), monthlyMicro: USD(150) }, c.now);
  assert.throws(() => monthly.reserve(1000), (e: unknown) => code("ledger")(e) && /monthly total cannot be reconstructed/.test((e as Error).message));
  assert.throws(() => monthly.open(), code("ledger"));
  const seen = monthly.inspect();
  assert.equal(seen.state, "failed");
  assert.match((seen as { reason: string }).reason, /^the spend ledger's monthly total cannot be reconstructed \(its per-day spend adds up to more than its lifetime total\)$/);
  assert.equal(JSON.stringify(fileOf(d)), JSON.stringify(f), "nothing was rewritten");
  // A lifetime-only configuration is unaffected (as before this change) and reports the month as unknown, not as zero.
  const lifetime = spendLedger(d, { dailyMicro: USD(5), totalMicro: USD(150) }, c.now);
  assert.equal(lifetime.view().spentMonthUsd, null);
  assert.doesNotThrow(() => lifetime.reserve(1000));
});

test("migration fails closed: an opening balance with an unreadable creation time, or a split larger than the balance", () => {
  const c = clock("2026-11-20T10:00:00Z");
  for (const breakIt of [(f: any) => (f.createdAt = "not a date"), (f: any) => (f.priorMonthsMicro = 50_000_000)]) {
    const d = dir();
    provisionWith(d, { openingLifetimeUsd: 40, openingTodayUsd: 1 });
    spendLedger(d, { dailyMicro: USD(5), totalMicro: USD(150) }, c.now).open();
    const f = fileOf(d);
    breakIt(f);
    writeFileSync(join(d, LEDGER_FILE), JSON.stringify(f));
    assert.throws(() => spendLedger(d, { dailyMicro: USD(5), monthlyMicro: USD(150) }, c.now).reserve(1000), (e: unknown) => code("ledger")(e) && /cannot be reconstructed/.test((e as Error).message));
  }
  const d = dir();
  provisioned(d, { dailyMicro: USD(5), totalMicro: USD(150) }, c.now);
  const f = fileOf(d);
  f.priorMonthsMicro = -1;
  writeFileSync(join(d, LEDGER_FILE), JSON.stringify(f));
  assert.throws(() => spendLedger(d, { dailyMicro: USD(5), monthlyMicro: USD(150) }, c.now).view(), (e: unknown) => code("ledger")(e) && /opening split/.test((e as Error).message));
});

test("an existing lifetime-only ledger opened with daily+monthly caps keeps its history: settled days count in their month", () => {
  const c = clock("2026-11-10T10:00:00Z");
  const d = dir();
  const before = provisioned(d, { dailyMicro: USD(5), totalMicro: USD(150) }, c.now);
  before.settle(before.reserve(USD(3)).id, USD(3));
  c.set("2026-11-11T10:00:00Z");
  before.settle(before.reserve(USD(4)).id, undefined, "unknown cost");
  const raw = readFileSync(join(d, LEDGER_FILE), "utf8");
  c.set("2026-11-12T10:00:00Z");
  const after = spendLedger(d, { dailyMicro: USD(5), monthlyMicro: USD(150) }, c.now);
  const v = after.open();
  assert.deepEqual([v.spentMonthUsd, v.lifetimeUsd, v.uncertainRequests, v.caps.totalUsd], [7, 7, 1, null]);
  assert.equal(readFileSync(join(d, LEDGER_FILE), "utf8"), raw, "opening with new caps wrote nothing");
});

test("lowering a cap below what is spent refuses every paid call and deletes no history", () => {
  const c = clock("2026-11-10T10:00:00Z");
  const d = dir();
  const l = provisioned(d, { dailyMicro: USD(5), monthlyMicro: USD(150) }, c.now);
  l.settle(l.reserve(USD(4)).id, USD(4));
  c.set("2026-11-11T10:00:00Z");
  l.settle(l.reserve(USD(4)).id, USD(4));
  const raw = readFileSync(join(d, LEDGER_FILE), "utf8");
  const lowered = spendLedger(d, { dailyMicro: USD(1), monthlyMicro: USD(5), totalMicro: USD(6) }, c.now);
  const v = lowered.open();
  assert.deepEqual([v.remainingTodayUsd, v.remainingMonthUsd, v.remainingTotalUsd], [0, 0, 0]);
  assert.deepEqual(v.exhausted, ["daily", "monthly", "lifetime"]);
  assert.deepEqual([v.spentTodayUsd, v.spentMonthUsd, v.lifetimeUsd], [4, 8, 8], "spend is reported as it is, not clamped to the cap");
  assert.throws(() => lowered.reserve(1), SpendError);
  assert.equal(readFileSync(join(d, LEDGER_FILE), "utf8"), raw, "nothing was rewritten or removed");
  // Next month the monthly cap allows again, the lifetime cap still does not.
  c.set("2026-12-01T10:00:00Z");
  assert.throws(() => lowered.reserve(1), code("total_cap"));
});

// ---- status ----------------------------------------------------------------------------------------------------------------

test("status names the daily, monthly and lifetime allowance truthfully, with reset times and which cap is used up", () => {
  const c = clock("2026-11-12T10:00:00Z");
  const cfg = ready(PROPOSED);
  const ledger = provisioned(dir(), spendCapsOf(cfg), c.now);
  ledger.settle(ledger.reserve(USD(2)).id, USD(2));
  const primary: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-x", detail: "Answering.", verifiedAt: c.now().toISOString() }),
    step: async () => ({ text: "x", calls: [] }),
    reply: async () => ({ value: "x", provenance: "live", source: "model/chatgpt-token-sharing/gpt-x" }),
  };
  const fetcher = (async () => new Response("{}")) as unknown as typeof fetch;
  const m = fallbackModel({ primary, config: cfg, ledger, fetcher, now: () => c.now().getTime() });
  let detail = m.status().detail;
  assert.match(detail, /\$2\.0000 spent today of \$5 \(resets 2026-11-13T00:00:00\.000Z\)/);
  assert.match(detail, /\$2\.0000 spent in UTC month 2026-11 of \$150 \(resets 2026-12-01T00:00:00\.000Z\)/);
  assert.match(detail, /\$2\.0000 lifetime \(no lifetime cap\)/);
  assert.match(detail, /\$3\.0000 can still be reserved now/);
  assert.doesNotMatch(detail, /used up/);
  ledger.settle(ledger.reserve(USD(3)).id, USD(3));
  detail = m.status().detail;
  assert.match(detail, /Every paid call is refused for now: the daily cap is used up\./);
  assert.doesNotMatch(detail, new RegExp(KEY));
});

test("status of a lifetime-only configuration says there is no monthly cap and keeps the lifetime figure", () => {
  const c = clock("2026-11-12T10:00:00Z");
  const cfg = ready({});
  assert.equal(cfg.monthlyCapUsd, null);
  const ledger = provisioned(dir(), spendCapsOf(cfg), c.now);
  const primary: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-x", detail: "Answering.", verifiedAt: c.now().toISOString() }),
    step: async () => ({ text: "x", calls: [] }),
    reply: async () => ({ value: "x", provenance: "live", source: "model/chatgpt-token-sharing/gpt-x" }),
  };
  const m = fallbackModel({ primary, config: cfg, ledger, fetcher: (async () => new Response("{}")) as unknown as typeof fetch, now: () => c.now().getTime() });
  const detail = m.status().detail;
  assert.match(detail, /no monthly cap \(\$0\.0000 spent in UTC month 2026-11\)/);
  assert.match(detail, /\$0\.0000 of \$150 lifetime \(never resets\)/);
  assert.equal(CAP_OFF, "off");
});
