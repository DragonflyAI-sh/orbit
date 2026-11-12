import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Durable spend accounting for the paid OpenRouter fallback. Money is whole micro-dollars (1e-6 USD), never floats.
//
// Rules (docs/openrouter-fallback.md has the full account):
//  - A call reserves a conservative upper bound BEFORE it is sent. The reservation counts against both caps until it is settled.
//  - Settling replaces the reservation with the provider's reported cost. A missing, non-numeric or negative cost is ambiguous:
//    the whole reserved bound stays charged. Nothing is ever refunded on a guess.
//  - A reservation found on disk at startup belongs to a request that may have been billed and never finished; it is charged at its
//    bound as "orphaned". Spend is never cleared automatically, not by a restart and not by a day rollover.
//  - A file that cannot be read, parsed or validated stops all spending (SpendError "ledger") instead of starting from zero.
//  - Days are UTC calendar days (YYYY-MM-DD). The lifetime counter is its own number and does not depend on the day table.
// Every operation is synchronous (read, check, write, rename) so two replies in one process cannot interleave. The ledger assumes
// one ORBIT process owns the file; it is not safe for two writers.

export type SpendErrorCode = "ledger" | "daily_cap" | "total_cap" | "bad_amount";
export class SpendError extends Error {
  readonly code: SpendErrorCode;
  constructor(code: SpendErrorCode, message: string) {
    super(message);
    this.name = "SpendError";
    this.code = code;
  }
}

type Reservation = { at: string; day: string; micro: number };
type Ledger = {
  schema: 1;
  createdAt: string;
  // Settled plus orphaned/ambiguous spend, all time.
  lifetimeMicro: number;
  // Settled spend per UTC day.
  days: Record<string, number>;
  reservations: Record<string, Reservation>;
  // Requests charged at their reserved bound because the real cost is unknown. Kept for the owner to read; never removed.
  uncertain: { at: string; day: string; micro: number; why: string }[];
};

export type SpendCaps = { dailyMicro: number; totalMicro: number };
export type SpendView = {
  day: string;
  caps: { dailyUsd: number; totalUsd: number };
  spentTodayUsd: number;
  reservedUsd: number;
  lifetimeUsd: number;
  remainingTodayUsd: number;
  remainingTotalUsd: number;
  uncertainRequests: number;
};

export const toMicro = (usd: number): number => Math.ceil(usd * 1_000_000 - 1e-9);
export const toUsd = (micro: number): number => micro / 1_000_000;
const isMicro = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

// What a read-only look at the ledger found. Never a spend, never a write, never a repair.
//  ok: the file (or the in-memory ledger) was read and validated just now.
//  uninitialized: no ledger exists yet and this process has not written one; the first paid call would create it. NOT verified to work.
//  failed: unreadable, corrupt, invalid or vanished; every paid call is refused until it is fixed by hand. `reason` carries no file path.
export type SpendInspection = { state: "ok"; view: SpendView } | { state: "uninitialized" } | { state: "failed"; reason: string };

export type SpendLedger = {
  reserve(maxMicro: number): { id: string; micro: number };
  // Replaces the reservation with the real cost. `actualMicro` undefined means the cost is unknown.
  settle(id: string, actualMicro: number | undefined, why?: string): void;
  // The request was never sent (a failure before the network call): the reservation can be released safely.
  release(id: string): void;
  view(): SpendView;
  // Read-only observation for status pages. Unlike view(), it never creates the file, never adopts orphaned reservations and never
  // writes: polling it any number of times leaves the ledger byte for byte as it was. Reservations found on disk are shown as reserved.
  inspect(): SpendInspection;
};

export function spendLedger(dir: string | undefined, caps: SpendCaps, now: () => Date = () => new Date()): SpendLedger {
  if (!isMicro(caps.dailyMicro) || !isMicro(caps.totalMicro) || caps.dailyMicro <= 0 || caps.totalMicro <= 0) {
    throw new SpendError("bad_amount", "Spend caps must be positive and no larger than about 9 billion USD.");
  }
  const file = dir ? join(dir, "openrouter-spend.json") : undefined;
  let memory: Ledger | undefined;
  let loaded = false;

  const fresh = (): Ledger => ({ schema: 1, createdAt: now().toISOString(), lifetimeMicro: 0, days: {}, reservations: {}, uncertain: [] });

  const validate = (v: unknown): Ledger => {
    const bad = (m: string): never => {
      throw new SpendError("ledger", `The spend ledger is not usable (${m}), so no paid call is made. Fix or restore ${file ?? "it"}; it is never reset automatically.`);
    };
    if (!v || typeof v !== "object") return bad("not an object");
    const l = v as Ledger;
    if (l.schema !== 1) return bad("unknown schema");
    if (!isMicro(l.lifetimeMicro)) return bad("lifetime");
    if (!l.days || typeof l.days !== "object" || !l.reservations || typeof l.reservations !== "object" || !Array.isArray(l.uncertain)) return bad("shape");
    for (const [d, m] of Object.entries(l.days)) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isMicro(m)) return bad("day entry");
    for (const r of Object.values(l.reservations)) if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !isMicro(r.micro)) return bad("reservation");
    return l;
  };

  const read = (): Ledger => {
    if (!file) {
      memory ??= fresh();
      return memory;
    }
    let raw: string | undefined;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new SpendError("ledger", `The spend ledger could not be read, so no paid call is made.`);
      // A missing file is a first run only if the ledger was never written by this process.
      if (loaded) throw new SpendError("ledger", "The spend ledger file disappeared, so no paid call is made.");
    }
    if (raw === undefined) {
      const l = fresh();
      write(l);
      return l;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SpendError("ledger", `The spend ledger is corrupt, so no paid call is made. Fix or restore ${file}; it is never reset automatically.`);
    }
    return validate(parsed);
  };

  const write = (l: Ledger) => {
    loaded = true;
    if (!file) {
      memory = l;
      return;
    }
    mkdirSync(dir!, { recursive: true });
    const tmp = `${file}.new`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(l));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  };

  // At startup every reservation on disk is from a request that did not finish in this process: charge its bound.
  const adoptOrphans = (l: Ledger): boolean => {
    const ids = Object.keys(l.reservations);
    if (!ids.length || loaded) return false;
    for (const id of ids) {
      const r = l.reservations[id];
      l.days[r.day] = (l.days[r.day] ?? 0) + r.micro;
      l.lifetimeMicro += r.micro;
      l.uncertain.push({ at: now().toISOString(), day: r.day, micro: r.micro, why: "orphaned: the process ended before the request was settled" });
      delete l.reservations[id];
    }
    return true;
  };

  const load = (): Ledger => {
    const first = !loaded;
    const l = read();
    if (first && adoptOrphans(l)) write(l);
    loaded = true;
    return l;
  };

  const outstanding = (l: Ledger, day?: string) => Object.values(l.reservations).filter((r) => !day || r.day === day).reduce((a, r) => a + r.micro, 0);

  return {
    reserve(maxMicro) {
      if (!isMicro(maxMicro) || maxMicro <= 0) throw new SpendError("bad_amount", "The cost bound for this request is not a positive amount, so it is not sent.");
      const l = load();
      const day = utcDay(now());
      if ((l.days[day] ?? 0) + outstanding(l, day) + maxMicro > caps.dailyMicro) {
        throw new SpendError("daily_cap", `The OpenRouter daily cap of $${toUsd(caps.dailyMicro).toFixed(2)} (UTC day ${day}) would be exceeded.`);
      }
      if (l.lifetimeMicro + outstanding(l) + maxMicro > caps.totalMicro) {
        throw new SpendError("total_cap", `The OpenRouter lifetime cap of $${toUsd(caps.totalMicro).toFixed(2)} would be exceeded.`);
      }
      const id = randomUUID();
      l.reservations[id] = { at: now().toISOString(), day, micro: maxMicro };
      write(l);
      return { id, micro: maxMicro };
    },

    settle(id, actualMicro, why) {
      const l = load();
      const r = l.reservations[id];
      if (!r) throw new SpendError("ledger", "Settling a reservation that is not in the ledger.");
      const known = isMicro(actualMicro);
      const charge = known ? actualMicro : r.micro;
      l.days[r.day] = (l.days[r.day] ?? 0) + charge;
      l.lifetimeMicro += charge;
      if (!known) l.uncertain.push({ at: now().toISOString(), day: r.day, micro: r.micro, why: why ?? "provider cost missing" });
      else if (charge > r.micro) l.uncertain.push({ at: now().toISOString(), day: r.day, micro: charge, why: "provider cost exceeded the reserved bound" });
      delete l.reservations[id];
      write(l);
    },

    release(id) {
      const l = load();
      if (!l.reservations[id]) return;
      delete l.reservations[id];
      write(l);
    },

    view() {
      return viewOf(load());
    },

    inspect() {
      try {
        if (!file) return memory ? { state: "ok", view: viewOf(memory) } : { state: "uninitialized" };
        let raw: string;
        try {
          raw = readFileSync(file, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { state: "failed", reason: "the spend ledger file cannot be read" };
          return loaded ? { state: "failed", reason: "the spend ledger file disappeared after it was written" } : { state: "uninitialized" };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { state: "failed", reason: "the spend ledger file is corrupt" };
        }
        return { state: "ok", view: viewOf(validate(parsed)) };
      } catch (err) {
        // validate() names the file in its text; the status never shows a path.
        const text = err instanceof SpendError ? err.message.split(file ?? "\0").join("the ledger file").split(/ Fix or restore/)[0]! : "the spend ledger could not be checked";
        return { state: "failed", reason: text.replace(/\.$/, "") };
      }
    },
  };

  function viewOf(l: Ledger): SpendView {
    const day = utcDay(now());
    const today = l.days[day] ?? 0;
    const reservedToday = outstanding(l, day);
    return {
      day,
      caps: { dailyUsd: toUsd(caps.dailyMicro), totalUsd: toUsd(caps.totalMicro) },
      spentTodayUsd: toUsd(today),
      reservedUsd: toUsd(outstanding(l)),
      lifetimeUsd: toUsd(l.lifetimeMicro),
      remainingTodayUsd: toUsd(Math.max(0, Math.min(caps.dailyMicro - today - reservedToday, caps.totalMicro - l.lifetimeMicro - outstanding(l)))),
      remainingTotalUsd: toUsd(Math.max(0, caps.totalMicro - l.lifetimeMicro - outstanding(l))),
      uncertainRequests: l.uncertain.length,
    };
  }
}
