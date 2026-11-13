import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEDGER_FILE, SpendError, selfIdentity, spendLedger } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";

// B7: real competing child processes on one temporary state directory, with deterministic fault injection (the ledger's `fault` hook
// kills or fails a process at a named point inside its critical section). Mocked money only: no network, no real ledger.

const WORKER = new URL("./helpers/ledger-worker.ts", import.meta.url).pathname;
const NOW = () => new Date("2026-11-12T10:00:00Z");
const dir = () => mkdtempSync(join(tmpdir(), "orbit-mp-"));
const stateOf = (d: string) => JSON.parse(readFileSync(join(d, LEDGER_FILE), "utf8"));
const GONE = { pid: 2_147_483_000, start: "1" };

type Spec = Record<string, unknown> & { ops: unknown[] };
type Result = { code: number | null; signal: string | null; lines: Record<string, any>[] };

// Starts every worker, waits until all are ready, releases them together, and collects what each printed.
async function race(d: string, caps: { dailyMicro: number; totalMicro: number }, specs: Spec[]): Promise<Result[]> {
  const go = join(d, `go-${Math.random().toString(16).slice(2)}`);
  const procs = specs.map((s) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify({ dir: d, caps, go, ...s })], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    const lines: Record<string, any>[] = [];
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    child.stdout.on("data", (c) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        lines.push(line);
        if (line.ready) ready();
      }
    });
    child.stderr.on("data", (c) => (err += c));
    const done = new Promise<Result>((resolve) => child.on("close", (code, signal) => resolve({ code, signal, lines: (err && code ? [...lines, { stderr: err.slice(0, 400) }] : lines) })));
    return { isReady, done };
  });
  await Promise.all(procs.map((p) => p.isReady));
  writeFileSync(go, "");
  return Promise.all(procs.map((p) => p.done));
}
const all = (rs: Result[]) => rs.flatMap((r) => r.lines);

test("competing processes near the cap: exactly the allowance is admitted, never more, and the file agrees", async () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  provisioned(d, caps, NOW);
  // 6 processes x 5 attempts of 10,000 against a 100,000 daily cap: 30 attempts, room for exactly 10.
  const rs = await race(d, caps, Array.from({ length: 6 }, () => ({ ops: [{ op: "reserve", micro: 10_000, count: 5 }] })));
  for (const r of rs) assert.equal(r.code, 0, JSON.stringify(r.lines));
  const lines = all(rs);
  const admitted = lines.filter((l) => l.ok).length;
  const refused = lines.filter((l) => l.err === "daily_cap").length;
  assert.equal(admitted, 10, "exactly the cap's worth was admitted");
  assert.equal(refused, 20);
  assert.equal(lines.filter((l) => l.err && l.err !== "daily_cap").length, 0, "nothing failed any other way");
  const s = stateOf(d);
  // A worker that exited with its requests unsettled is a gone process: a later critical section charged those at their bound
  // (that is the orphan rule, not a loss). Whatever the split, every admitted request is accounted for exactly once.
  const reserved = Object.values<{ micro: number }>(s.reservations).reduce((a, r) => a + r.micro, 0);
  assert.equal(reserved + s.lifetimeMicro, 100_000, "every admitted reservation is in the file, reserved or charged: none lost, none doubled");
  assert.equal(Object.keys(s.reservations).length + s.uncertain.length, 10);
  assert.deepEqual(readdirSync(d).filter((f) => /\.new\.|lock/.test(f)), [], "no temp or lock file left behind");
});

test("competing processes settling: no charge is lost and no write is overwritten (the write counter adds up exactly)", async () => {
  const d = dir();
  const caps = { dailyMicro: 10_000_000, totalMicro: 100_000_000 };
  provisioned(d, caps, NOW);
  const before = stateOf(d).seq;
  const rs = await race(d, caps, [
    ...Array.from({ length: 4 }, () => ({ ops: [{ op: "reserve", micro: 1000, count: 15, settle: 700 }] })),
    ...Array.from({ length: 2 }, () => ({ ops: [{ op: "reserve", micro: 1000, count: 10, settle: null }] })), // cost unknown: bound stays charged
  ]);
  for (const r of rs) assert.equal(r.code, 0, JSON.stringify(r.lines));
  const s = stateOf(d);
  assert.equal(s.lifetimeMicro, 4 * 15 * 700 + 2 * 10 * 1000);
  assert.equal(s.days["2026-11-12"], s.lifetimeMicro);
  assert.equal(Object.keys(s.reservations).length, 0);
  assert.equal(s.uncertain.length, 20);
  // 80 operations, each reserve + settle is one write: a lost update would leave the counter short.
  assert.equal(s.seq - before, 2 * (4 * 15 + 2 * 10));
});

test("a process killed while its request is reserved: the reservation counts against the caps at once and is charged at its bound by the next process", async () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  provisioned(d, caps, NOW);
  const [crash] = await race(d, caps, [{ ops: [{ op: "reserve", micro: 60_000 }, { op: "die" }] }]);
  assert.equal(crash!.signal, "SIGKILL");
  assert.equal(crash!.lines.filter((l) => l.ok).length, 1);
  // Before anything adopts it: still reserved, so 60,000 more does not fit under the 100,000 cap.
  assert.equal(spendLedger(d, caps, NOW).inspect().state, "ok");
  // A second process (a "restart") sees the first one is gone: charged at its bound, once, and kept in `uncertain`.
  const v = spendLedger(d, caps, NOW).open();
  assert.equal(v.reservedUsd, 0);
  assert.equal(v.lifetimeUsd, 0.06);
  assert.equal(v.uncertainRequests, 1);
  assert.throws(() => spendLedger(d, caps, NOW).reserve(60_000), (e: unknown) => e instanceof SpendError && e.code === "daily_cap");
  // And a further restart does not charge it again.
  assert.equal(spendLedger(d, caps, NOW).open().lifetimeUsd, 0.06);
});

test("a process killed INSIDE the critical section: before the rename nothing changed, after it the change is whole; the stale lock is cleared only because its owner is proven dead", async () => {
  for (const [point, changed] of [["locked", false], ["loaded", false], ["tmp-written", false], ["renamed", true], ["written", true]] as const) {
    const d = dir();
    const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
    provisioned(d, caps, NOW);
    const before = readFileSync(join(d, LEDGER_FILE), "utf8");
    const [crash] = await race(d, caps, [{ ops: [{ op: "reserve", micro: 5_000 }], fault: { point, action: "kill" } }]);
    assert.equal(crash!.signal, "SIGKILL", point);
    assert.ok(existsSync(join(d, "openrouter-spend.lock")), `${point}: the dead process left its lock behind`);
    const after = readFileSync(join(d, LEDGER_FILE), "utf8");
    if (changed) assert.equal(Object.keys(JSON.parse(after).reservations).length, 1, point);
    else assert.equal(after, before, `${point}: the file is exactly as it was (the rename is atomic)`);
    // The next process finds the lock, proves its owner gone, removes it and carries on.
    const l = spendLedger(d, caps, NOW, { lockWaitMs: 2000 });
    const r = l.reserve(5_000);
    assert.ok(r.id);
    assert.ok(!existsSync(join(d, "openrouter-spend.lock")), "released normally afterwards");
    // The dead owner's own reservation (point renamed/written) is an orphan, charged at its bound; the others never existed.
    assert.equal(l.view().lifetimeUsd, changed ? 0.005 : 0, point);
  }
});

test("a lock held by a LIVE process is never taken: the waiting call is refused, nothing is charged, and the lock stays", async () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  provisioned(d, caps, NOW);
  const holderStarted = race(d, caps, [{ ops: [{ op: "reserve", micro: 1000 }], fault: { point: "locked", action: "hold", ms: 1500 } }]);
  // Wait (event loop free) until the holder reports that it is inside its critical section.
  const lockFile = join(d, "openrouter-spend.lock");
  for (let i = 0; i < 500 && !existsSync(lockFile); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(lockFile));
  const owner = JSON.parse(readFileSync(lockFile, "utf8"));
  const waiting = spendLedger(d, caps, NOW, { lockWaitMs: 300 });
  const t0 = Date.now();
  assert.throws(() => waiting.reserve(1000), (e: unknown) => e instanceof SpendError && e.code === "busy");
  assert.ok(Date.now() - t0 >= 280, "it waited for the whole allowance before giving up");
  assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).tok, owner.tok, "the lock was not taken over on a timeout");
  const [held] = await holderStarted;
  assert.equal(held!.code, 0, JSON.stringify(held!.lines));
  // The holder finished its own work and released; the refused call charged nothing; the same instance works again.
  assert.equal(stateOf(d).seq, 2, "provisioning + the holder's one reserve; the refused call wrote nothing");
  assert.ok(waiting.reserve(1000).id);
});

test("a lock whose owner cannot be shown to be gone is treated as held: another host, a live pid, a garbled file", () => {
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  const me = selfIdentity();
  const forged: [string, unknown][] = [
    ["another host", { ...me, host: `${me.host}-other`, tok: "t1", at: "x" }],
    ["a pid that is alive", { ...me, tok: "t2", at: "x" }],
    ["no boot id (cannot be proven either way)", { pid: GONE.pid, host: me.host, tok: "t3", at: "x" }],
    ["garbled content", "not json {"],
  ];
  for (const [name, rec] of forged) {
    const d = dir();
    const l = provisioned(d, caps, NOW, { lockWaitMs: 150 });
    const lock = join(d, "openrouter-spend.lock");
    writeFileSync(lock, typeof rec === "string" ? rec : JSON.stringify(rec));
    const before = readFileSync(lock, "utf8");
    assert.throws(() => l.reserve(1000), (e: unknown) => e instanceof SpendError && e.code === "busy", name);
    assert.equal(readFileSync(lock, "utf8"), before, `${name}: left alone`);
  }
  // Positive control: the same forged lock with a provably dead owner (this host and boot, a pid that cannot exist) IS cleared.
  const d = dir();
  const l = provisioned(d, caps, NOW, { lockWaitMs: 500 });
  writeFileSync(join(d, "openrouter-spend.lock"), JSON.stringify({ ...me, ...GONE, tok: "t4", at: "x" }));
  assert.ok(l.reserve(1000).id);
});

test("a host that rebooted since the lock was written has no live owner left: its lock is cleared", () => {
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  const d = dir();
  const l = provisioned(d, caps, NOW, { lockWaitMs: 500 });
  writeFileSync(join(d, "openrouter-spend.lock"), JSON.stringify({ ...selfIdentity(), boot: "00000000-0000-0000-0000-000000000000", tok: "t5", at: "x" }));
  assert.ok(l.reserve(1000).id);
});

test("a process killed while breaking a dead lock leaves a guard, and the next caller recovers: the dead breaker is proven dead, nothing is charged or lost", async () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  provisioned(d, caps, NOW);
  await race(d, caps, [{ ops: [{ op: "reserve", micro: 1000 }], fault: { point: "locked", action: "kill" } }]); // leaves a dead lock
  const [breaker] = await race(d, caps, [{ ops: [{ op: "reserve", micro: 1000 }], fault: { point: "breaking", action: "kill" } }]);
  assert.equal(breaker!.signal, "SIGKILL");
  const names = () => readdirSync(d).filter((f) => f.startsWith("openrouter-spend.lock"));
  assert.ok(names().includes("openrouter-spend.lock") && names().some((f) => f.startsWith("openrouter-spend.lock.break.")), "the dead lock and the dead breaker's guard are both left");
  const l = spendLedger(d, caps, NOW, { lockWaitMs: 1000 });
  assert.ok(l.reserve(1000).id, "recovered: the guard's owner is proven dead, so it is superseded and the dead lock is cleared");
  assert.deepEqual(names(), [], "no lock, guard or token file is left behind");
  const st = stateOf(d);
  assert.equal(st.lifetimeMicro + Object.values<any>(st.reservations).reduce((a, r) => a + r.micro, 0), 1000, "exactly the one admitted reservation: the two killed processes reserved nothing, and nothing was lost");
});

test("a break guard whose owner is not provably dead is never removed or superseded: the call is refused busy", () => {
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  const me = selfIdentity();
  const forgedGuards: [string, Record<string, unknown>][] = [
    ["a guard of a live pid", { ...me, tok: "g1", at: "x" }],
    ["a guard of another host", { ...me, host: `${me.host}-other`, tok: "g2", at: "x" }],
    ["a guard with no boot id", { pid: GONE.pid, host: me.host, tok: "g3", at: "x" }],
  ];
  for (const [name, guard] of forgedGuards) {
    const d = dir();
    const l = provisioned(d, caps, NOW, { lockWaitMs: 150 });
    writeFileSync(join(d, "openrouter-spend.lock"), JSON.stringify({ ...me, ...GONE, tok: "deadlock", at: "x" }));
    const gpath = join(d, "openrouter-spend.lock.break.deadlock.1");
    writeFileSync(gpath, JSON.stringify(guard));
    assert.throws(() => l.reserve(1000), (e: unknown) => e instanceof SpendError && e.code === "busy", name);
    assert.ok(existsSync(join(d, "openrouter-spend.lock")) && existsSync(gpath), `${name}: lock and guard untouched`);
    assert.equal(JSON.parse(readFileSync(gpath, "utf8")).tok, guard.tok);
  }
});

test("a lock token that is not file-name safe is never broken, even when its owner is dead", () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  const l = provisioned(d, caps, NOW, { lockWaitMs: 100 });
  writeFileSync(join(d, "openrouter-spend.lock"), JSON.stringify({ ...selfIdentity(), ...GONE, tok: "../../x", at: "x" }));
  assert.throws(() => l.reserve(1000), (e: unknown) => e instanceof SpendError && e.code === "busy");
  assert.ok(existsSync(join(d, "openrouter-spend.lock")));
});

test("two live breakers racing for the same dead lock: exactly one breaks it, the new lock is never broken by the other", async () => {
  const caps = { dailyMicro: 1_000_000, totalMicro: 10_000_000 };
  for (let round = 0; round < 8; round++) {
    const d = dir();
    provisioned(d, caps, NOW);
    await race(d, caps, [{ ops: [{ op: "reserve", micro: 1000 }], fault: { point: "locked", action: "kill" } }]);
    const rs = await race(d, caps, Array.from({ length: 5 }, () => ({ ops: [{ op: "reserve", micro: 1000, count: 4 }], lockWaitMs: 5000 })));
    for (const r of rs) assert.equal(r.code, 0, JSON.stringify(r.lines));
    assert.equal(all(rs).filter((l) => l.ok).length, 20, `round ${round}: every attempt admitted`);
    const st = stateOf(d);
    assert.equal(st.lifetimeMicro + Object.values<any>(st.reservations).reduce((a, r) => a + r.micro, 0), 20_000, "every admitted reservation is accounted for exactly once (charged as an orphan or still reserved), none lost or doubled");
    assert.deepEqual(readdirSync(d).filter((f) => f.startsWith("openrouter-spend.lock")), []);
  }
});

test("stray lock token temp files: old ones are swept at startup, a recent one (a live process may be using it) is kept", () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  writeFileSync(join(d, "openrouter-spend.provision"), JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0 }));
  const oldTmp = join(d, "openrouter-spend.lock.11111111-1111-1111-1111-111111111111");
  const newTmp = join(d, "openrouter-spend.lock.22222222-2222-2222-2222-222222222222");
  const oldGuard = join(d, "openrouter-spend.lock.break");
  for (const f of [oldTmp, newTmp, oldGuard]) writeFileSync(f, "x");
  const longAgo = new Date(Date.now() - 10 * 60_000);
  utimesSync(oldTmp, longAgo, longAgo);
  utimesSync(oldGuard, longAgo, longAgo);
  spendLedger(d, caps, NOW).open();
  assert.ok(!existsSync(oldTmp) && !existsSync(oldGuard), "old leftovers are removed");
  assert.ok(existsSync(newTmp), "a recent file is left alone");
});

test("stray-file sweep: one entry that cannot be stat'ed does not stop the sweep of the others (PR #68 review, finding 3)", () => {
  // A dangling symlink stands in for a guard removed between readdir and stat: statSync throws ENOENT for it. Before the per-file
  // try/catch, that throw ended the whole sweep, so whichever leftovers the directory listed after it survived.
  const d = dir();
  writeFileSync(join(d, "openrouter-spend.provision"), JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0 }));
  const longAgo = new Date(Date.now() - 10 * 60_000);
  const old: string[] = [];
  for (let i = 0; i < 24; i++) {
    const f = join(d, `openrouter-spend.lock.z${String(i).padStart(7, "0")}-1111-1111-1111-111111111111`);
    writeFileSync(f, "x");
    utimesSync(f, longAgo, longAgo);
    old.push(f);
  }
  // Named to list before the leftovers where the directory order is sorted, and several of them where it is hashed.
  for (let i = 0; i < 4; i++) symlinkSync(join(d, `gone-${i}`), join(d, `openrouter-spend.lock.a${i}-dangling`));
  spendLedger(d, { dailyMicro: 100_000, totalMicro: 1_000_000 }, NOW).open();
  assert.deepEqual(old.filter((f) => existsSync(f)), [], "every old leftover is removed");
});

test("write failure: a failing write refuses the call, leaves the ledger byte for byte as it was, releases the lock and leaves no temp file", () => {
  for (const point of ["tmp-written", "renamed"]) {
    const d = dir();
    const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
    let armed = false;
    const l = provisioned(d, caps, NOW, {
      fault: (p) => {
        if (armed && p === point) throw new Error(`injected EIO at ${p}`);
      },
    });
    const before = readFileSync(join(d, LEDGER_FILE), "utf8");
    armed = true;
    assert.throws(() => l.reserve(1000), /injected/);
    armed = false;
    if (point === "tmp-written") assert.equal(readFileSync(join(d, LEDGER_FILE), "utf8"), before, "unchanged");
    assert.ok(!existsSync(join(d, "openrouter-spend.lock")), `${point}: lock released after the failure`);
    assert.deepEqual(readdirSync(d).filter((f) => f.includes(".new.")), [], `${point}: no temp file`);
    assert.ok(l.reserve(1000).id, "the ledger is usable again");
  }
});

test("lost-update prevention: a writer that finds its lock was taken over writes nothing and stops using the ledger", () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  const me = selfIdentity();
  let armed = false;
  const l = provisioned(d, caps, NOW, {
    fault: (p) => {
      // Between its read and its rename, somebody else replaces the lock (a defect or an operator's rm): this writer no longer holds it.
      if (armed && p === "tmp-written") writeFileSync(join(d, "openrouter-spend.lock"), JSON.stringify({ ...me, tok: "usurper", at: "x" }));
    },
  });
  const before = readFileSync(join(d, LEDGER_FILE), "utf8");
  armed = true;
  assert.throws(() => l.reserve(1000), /lock was lost/);
  armed = false;
  assert.equal(readFileSync(join(d, LEDGER_FILE), "utf8"), before, "nothing was written");
  assert.throws(() => l.reserve(1000), (e: unknown) => e instanceof SpendError && e.code === "ledger", "this instance is out of service until ORBIT restarts");
});

test("reservations of a process that is not provably gone stay reserved and keep counting against the caps", () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  const me = selfIdentity();
  const elsewhere = provisioned(d, caps, NOW, { identity: { host: `${me.host}-other` } });
  elsewhere.reserve(60_000);
  const here = spendLedger(d, caps, NOW);
  const v = here.open();
  assert.equal(v.reservedUsd, 0.06);
  assert.equal(v.uncertainRequests, 0, "not adopted: it might be in flight on the other host");
  assert.throws(() => here.reserve(60_000), (e: unknown) => e instanceof SpendError && e.code === "daily_cap");
});

test("a ledger file rolled back underneath a running process is refused, not trusted", () => {
  const d = dir();
  const caps = { dailyMicro: 100_000, totalMicro: 1_000_000 };
  const l = provisioned(d, caps, NOW);
  const old = readFileSync(join(d, LEDGER_FILE));
  l.settle(l.reserve(1000).id, 900);
  writeFileSync(join(d, LEDGER_FILE), old);
  assert.throws(() => l.reserve(1000), /rolled back/);
  assert.equal(l.inspect().state, "failed");
  assert.equal(readFileSync(join(d, LEDGER_FILE)).equals(old), true, "left for a person to look at");
});
