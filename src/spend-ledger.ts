import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

// Durable spend accounting for the paid OpenRouter fallback. Money is whole micro-dollars (1e-6 USD), never floats.
// docs/openrouter-fallback.md and docs/openrouter-ledger-integrity.md have the full account; this is the short form.
//
// Money rules
//  - A call reserves a conservative upper bound BEFORE it is sent. The reservation counts against EVERY cap (daily, monthly, lifetime)
//    until it is settled, whatever day or month it was made in: a call in flight across midnight or a month boundary occupies budget
//    in the new period too, so a rollover never frees budget a pending call may still use. When it settles (or is charged as orphaned)
//    it is charged to the UTC day it was reserved on, once.
//  - Settling replaces the reservation with the provider's reported cost. A missing, non-numeric or negative cost is ambiguous:
//    the whole reserved bound stays charged. Nothing is ever refunded on a guess.
//  - A reservation whose owning process is PROVEN gone (see "Owners") is charged at its bound as "orphaned". Spend is never cleared
//    automatically, not by a restart and not by a day rollover.
//  - A file that cannot be read, parsed or validated stops all spending (SpendError "ledger") instead of starting from zero.
//  - Days are UTC calendar days (YYYY-MM-DD); months are UTC calendar months (YYYY-MM), the sum of their days. The lifetime counter is
//    its own number and does not depend on the day table.
//  - Caps: a daily cap always; a monthly cap and a lifetime cap each optional, but at least one of them. Lowering a cap below what is
//    already spent refuses further calls; it never deletes or rewrites history.
//  - Monthly spend is rebuilt from the day table. The only spend not in it is an opening balance declared at provisioning; it is placed
//    in the ledger's creation month (conservative: it was spent at or before then) unless the provision file split it with
//    openingMonthUsd. A ledger whose day table adds up to MORE than its lifetime total cannot be reconstructed: with a monthly cap
//    configured that stops all spending (SpendError "ledger").
//
// Several processes (single-writer protection, B7)
//  - Every admit / reserve / settle / release / recovery step is ONE critical section: take the lock, read the file, change it, write
//    it (temp file, fsync, rename, directory fsync), release the lock. Nothing slow runs inside it (the provider call happens between
//    two sections, covered by the reservation, not by the lock), so a hold lasts milliseconds.
//  - The lock is a file created atomically with link(2) with its whole content (owner identity and a random token) already in it. It is
//    released by deleting it, only after checking that the token is still ours. A waiter polls and gives up after `lockWaitMs`
//    with SpendError "busy": the call is refused and nothing is charged. A timeout NEVER takes the lock.
//  - A lock is removed by someone else only when its owner is PROVEN dead (same host, same boot, same pid namespace, and the pid is
//    gone or now belongs to a process that started later). Anything unprovable (another host, no /proc, an unreadable or garbled
//    lock, a live pid) is treated as held: fail closed. The removal itself is serialised by a second, momentary guard file.
//  - A writer that crashes holding the lock leaves the ledger as it was or as it should be: the rename is atomic, so a reader sees the
//    old file or the new one, never half of one.
//
// Owners and restart
//  - Each reservation records who made it. At every critical section reservations whose owner is proven dead are charged at their
//    bound; reservations of live or unprovable owners stay reserved (they count against the caps, so no cap can be bypassed).
//
// Provisioning, loss and rollback (B8)
//  - A missing ledger is NOT a new budget. The file is created only by open() (ORBIT's startup), and only when the owner has
//    deliberately asked for it by creating the provision file by hand. A separate marker file records the ledger's epoch; a marker
//    without a ledger, or a ledger whose epoch differs from the marker, stops all spending. See docs/openrouter-ledger-integrity.md
//    for what local markers can and cannot prove (not continuity after the whole state directory is deleted or restored).

export type SpendErrorCode = "ledger" | "busy" | "daily_cap" | "monthly_cap" | "total_cap" | "bad_amount";
export class SpendError extends Error {
  readonly code: SpendErrorCode;
  constructor(code: SpendErrorCode, message: string) {
    super(message);
    this.name = "SpendError";
    this.code = code;
  }
}

// Who a process is, as far as it can be proven later. host+boot+pidns scope the pid; start (/proc start time in clock ticks) tells a
// reused pid from the original process.
export type ProcId = { pid: number; host: string; boot?: string; pidns?: string; start?: string; inst?: string };
type Reservation = { at: string; day: string; micro: number; owner?: ProcId };
type Ledger = {
  schema: 1 | 2;
  // Identity of this ledger. Also in the marker file. Absent only in a schema 1 file (given one at the next write).
  epoch?: string;
  // Counts writes; never decreases. A smaller value than one already seen means the file was rolled back.
  seq?: number;
  createdAt: string;
  // Settled plus orphaned/ambiguous spend, all time.
  lifetimeMicro: number;
  // Settled spend per UTC day.
  days: Record<string, number>;
  reservations: Record<string, Reservation>;
  // Requests charged at their reserved bound because the real cost is unknown. Kept for the owner to read; never removed.
  uncertain: { at: string; day: string; micro: number; why: string }[];
  // Part of the declared opening balance the owner stated was spent BEFORE the creation month (openingLifetimeUsd - openingMonthUsd).
  // Absent: none is known to be, so the whole opening balance outside the day table counts in the creation month.
  priorMonthsMicro?: number;
};
type Marker = { schema: 1; epoch: string; createdAt: string };

// dailyMicro is required. monthlyMicro (UTC calendar month) and totalMicro (lifetime, never resets) are each optional, but at least one
// must be given: there is always a cap beyond one day. An absent cap is not enforced; there is no zero-means-unlimited value.
export type SpendCaps = { dailyMicro: number; monthlyMicro?: number; totalMicro?: number };
export type CapName = "daily" | "monthly" | "lifetime";
export type SpendView = {
  day: string;
  // UTC calendar month, YYYY-MM.
  month: string;
  // null: that cap is not configured (not enforced).
  caps: { dailyUsd: number; monthlyUsd: number | null; totalUsd: number | null };
  spentTodayUsd: number;
  // Settled and charged spend in this UTC month, opening balance included where it belongs (see above). null only when it cannot be
  // reconstructed and no monthly cap is configured (with one, that is a ledger failure instead).
  spentMonthUsd: number | null;
  // All outstanding reservations; each counts against every cap until it is settled.
  reservedUsd: number;
  lifetimeUsd: number;
  // What one more call could still reserve right now under ALL configured caps (the smallest headroom).
  remainingTodayUsd: number;
  // Headroom under that one cap alone; null when the cap is not configured.
  remainingMonthUsd: number | null;
  remainingTotalUsd: number | null;
  // Caps with no headroom left at all: every paid call is refused until the named cap resets (daily, monthly) or is raised (lifetime).
  exhausted: CapName[];
  // When the daily and monthly counts start again (UTC). The lifetime count never resets.
  resets: { dailyAt: string; monthlyAt: string };
  uncertainRequests: number;
};

export const toMicro = (usd: number): number => Math.ceil(usd * 1_000_000 - 1e-9) + 0; // + 0: never -0
export const toUsd = (micro: number): number => micro / 1_000_000;
const isMicro = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Start of the next UTC day and of the next UTC month after `d` (Date.UTC carries December into January of the next year).
export const nextUtcDay = (d: Date): string => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
export const nextUtcMonth = (d: Date): string => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();

// File names inside the state directory.
export const LEDGER_FILE = "openrouter-spend.json";
export const MARKER_FILE = "openrouter-spend.marker";
export const PROVISION_FILE = "openrouter-spend.provision";
const LOCK_FILE = "openrouter-spend.lock";

// What a read-only look at the ledger found. Never a spend, never a write, never a repair.
//  ok: the file (or the in-memory ledger) was read and validated just now.
//  unprovisioned: no ledger exists and ORBIT has not been told to create one. NOT a fresh budget: no paid call is made.
//    `requested` is true when the owner's provision file is already there (it is applied at the next ORBIT start, never by a poll).
//  failed: unreadable, corrupt, invalid, lost, rolled back or locked by a process that cannot be shown to be gone; every paid call is
//    refused until it is fixed by hand. `reason` carries no file path.
export type SpendInspection = { state: "ok"; view: SpendView } | { state: "unprovisioned"; requested: boolean } | { state: "failed"; reason: string };

export type SpendLedger = {
  // The explicit startup step: creates the ledger ONLY if the owner's provision file asks for it (see docs), retires a used provision
  // file, and charges reservations of proven-dead owners. Throws SpendError("ledger") when the ledger is missing without a request.
  open(): SpendView;
  reserve(maxMicro: number): { id: string; micro: number };
  // Replaces the reservation with the real cost. `actualMicro` undefined means the cost is unknown.
  settle(id: string, actualMicro: number | undefined, why?: string): void;
  // The request was never sent (a failure before the network call): the reservation can be released safely.
  release(id: string): void;
  // Like reserve/settle, a locked read that also charges proven-dead owners' reservations. Never creates the ledger.
  view(): SpendView;
  // Read-only observation for status pages. Unlike view(), it takes no lock, never creates anything, never adopts orphaned
  // reservations and never writes: polling it any number of times leaves the ledger byte for byte as it was.
  inspect(): SpendInspection;
};

// Test seams. Production passes none of them.
export type SpendOptions = {
  // How long one call waits for the lock before it is refused (never before it takes it). Default 250 ms: the wait is synchronous and blocks ORBIT's event loop for at most this long.
  lockWaitMs?: number;
  // Called at named points inside a critical section ("locked", "loaded", "tmp-written", "renamed", "written", "marker-tmp-written", "marker-written",
  // "breaking"); it may throw or kill the process to simulate a fault there.
  fault?: (point: string) => void;
  // Replaces this process's identity (to play a process that has since died).
  identity?: Partial<ProcId>;
};

const readText = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

// The identity of this process, as far as the OS lets it be proven. Linux only; elsewhere boot/pidns/start are undefined and nothing
// is ever provable, which is the safe direction (no lock is broken, no foreign reservation is adopted).
const startOf = (pid: number): { state: string; start: string } | "gone" | undefined => {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : undefined;
  }
  // "pid (comm) state ppid ...": comm may hold spaces and parentheses, so split after the LAST ")". Field 22 is the start time.
  const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const state = rest[0];
  const start = rest[19];
  return state && start ? { state, start } : undefined;
};
const bootId = () => readText("/proc/sys/kernel/random/boot_id")?.trim() || undefined;
const pidNs = () => {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
};
export const selfIdentity = (): ProcId => {
  const s = startOf(process.pid);
  return { pid: process.pid, host: hostname(), boot: bootId(), pidns: pidNs(), start: typeof s === "object" ? s.start : undefined };
};

export type Liveness = "alive" | "dead" | "unknown";
// "dead" only when it is proven; "unknown" means treat as alive.
export function livenessOf(o: ProcId, me: ProcId): Liveness {
  if (o.inst !== undefined && o.inst === me.inst) return "alive"; // this very ledger instance: its own request is never an orphan
  if (o.host !== me.host) return "unknown";
  if (o.boot && me.boot && o.boot !== me.boot) return "dead"; // the host rebooted since: every process of that boot is gone
  if (!o.boot || !me.boot || o.boot !== me.boot || !o.pidns || !me.pidns || o.pidns !== me.pidns) return "unknown";
  const now = startOf(o.pid);
  if (now === "gone") return "dead";
  if (!now || !o.start) return "unknown";
  if (now.state === "Z" || now.state === "X") return "dead";
  return now.start === o.start ? "alive" : "dead"; // a different start time is a different process that reused the pid
}

const sleepMs = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

type Opening = { lifetimeMicro: number; todayMicro: number; monthMicro?: number; note: string; recover: boolean };

export function spendLedger(dir: string | undefined, caps: SpendCaps, now: () => Date = () => new Date(), opts: SpendOptions = {}): SpendLedger {
  const capOk = (n: number | undefined) => n === undefined || (isMicro(n) && n > 0);
  if (!isMicro(caps.dailyMicro) || caps.dailyMicro <= 0 || !capOk(caps.monthlyMicro) || !capOk(caps.totalMicro)) {
    throw new SpendError("bad_amount", "Spend caps must be positive and no larger than about 9 billion USD.");
  }
  if (caps.monthlyMicro === undefined && caps.totalMicro === undefined) {
    throw new SpendError("bad_amount", "A monthly or a lifetime spend cap is required besides the daily cap.");
  }
  const at = (name: string) => join(dir!, name);
  const file = dir ? at(LEDGER_FILE) : undefined;
  const lockWaitMs = opts.lockWaitMs ?? 250;
  const fault = opts.fault ?? (() => {});
  const me: ProcId = { ...selfIdentity(), ...opts.identity, inst: randomUUID() };
  let memory: Ledger | undefined;
  // Highest write counter and lifetime this process has seen. A file below either was rolled back underneath us.
  let seen = { seq: 0, lifetime: 0 };
  // Set when the lock was found taken over while we held it: nothing more is written by this instance.
  let poisoned: string | undefined;
  // Set once this process has read a valid ledger. A ledger and marker that are BOTH gone after that are a loss, never a first run.
  let known = false;

  const bad = (m: string): never => {
    throw new SpendError("ledger", `The spend ledger is not usable (${m}), so no paid call is made. Fix or restore the ledger file; it is never reset automatically.`);
  };

  const fresh = (epoch: string, o?: Opening): Ledger => {
    const l: Ledger = { schema: 2, epoch, seq: 0, createdAt: now().toISOString(), lifetimeMicro: 0, days: {}, reservations: {}, uncertain: [] };
    if (o) {
      l.lifetimeMicro = o.lifetimeMicro;
      if (o.todayMicro) l.days[utcDay(now())] = o.todayMicro;
      if (o.monthMicro !== undefined && o.lifetimeMicro > o.monthMicro) l.priorMonthsMicro = o.lifetimeMicro - o.monthMicro;
      if (o.lifetimeMicro) l.uncertain.push({ at: now().toISOString(), day: utcDay(now()), micro: o.lifetimeMicro, why: `opening balance declared by the owner at ${o.recover ? "RECOVERY after ledger loss" : "provisioning"}: ${o.note}` });
    }
    return l;
  };

  const validate = (v: unknown): Ledger => {
    if (!v || typeof v !== "object") return bad("not an object");
    const l = v as Ledger;
    if (l.schema !== 1 && l.schema !== 2) return bad("unknown schema");
    if (l.schema === 2 && (typeof l.epoch !== "string" || !l.epoch || !isMicro(l.seq))) return bad("identity");
    if (!isMicro(l.lifetimeMicro)) return bad("lifetime");
    if (l.priorMonthsMicro !== undefined && !isMicro(l.priorMonthsMicro)) return bad("opening split");
    if (!l.days || typeof l.days !== "object" || !l.reservations || typeof l.reservations !== "object" || !Array.isArray(l.uncertain)) return bad("shape");
    for (const [d, m] of Object.entries(l.days)) if (!DAY.test(d) || !isMicro(m)) return bad("day entry");
    for (const r of Object.values(l.reservations)) {
      if (!r || !DAY.test(r.day) || !isMicro(r.micro)) return bad("reservation");
      if (r.owner !== undefined && (!r.owner || !Number.isSafeInteger(r.owner.pid) || typeof r.owner.host !== "string")) return bad("reservation owner");
    }
    return l;
  };

  // ---- files ----------------------------------------------------------------------------------------------------------

  // undefined: the file does not exist. Anything else wrong throws.
  const readLedgerFile = (): Ledger | undefined => {
    let raw: string;
    try {
      raw = readFileSync(file!, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SpendError("ledger", "The spend ledger file cannot be read, so no paid call is made.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SpendError("ledger", `The spend ledger file is corrupt, so no paid call is made. Fix or restore the ledger file; it is never reset automatically.`);
    }
    return validate(parsed);
  };

  const readMarker = (): Marker | undefined => {
    let raw: string;
    try {
      raw = readFileSync(at(MARKER_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SpendError("ledger", "The spend ledger's history marker could not be read, so no paid call is made.");
    }
    try {
      const m = JSON.parse(raw) as Marker;
      if (m && m.schema === 1 && typeof m.epoch === "string" && m.epoch) return m;
    } catch {
      // fall through
    }
    throw new SpendError("ledger", "The spend ledger's history marker is corrupt, so no paid call is made. It is never rewritten automatically.");
  };

  const syncDir = () => {
    const fd = openSync(dir!, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  // Atomic replace: temp file (unique name, private), fsync, rename, then fsync of the directory so the rename itself is durable.
  const putFile = (name: string, text: string, tmpPoint: string) => {
    const target = at(name);
    const tmp = `${target}.new.${process.pid}.${randomUUID().slice(0, 8)}`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fault(tmpPoint);
      assertHeld();
      renameSync(tmp, target);
      fault("renamed");
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw err;
    }
    syncDir();
  };

  const write = (l: Ledger) => {
    if (!dir) {
      memory = l;
      return;
    }
    l.schema = 2;
    l.epoch ??= randomUUID();
    l.seq = (l.seq ?? 0) + 1;
    putFile(LEDGER_FILE, JSON.stringify(l), "tmp-written");
    fault("written");
    seen = { seq: l.seq, lifetime: l.lifetimeMicro };
  };

  const writeMarker = (epoch: string, createdAt: string) => {
    putFile(MARKER_FILE, JSON.stringify({ schema: 1, epoch, createdAt } satisfies Marker), "marker-tmp-written");
    fault("marker-written");
  };

  // ---- the lock -------------------------------------------------------------------------------------------------------

  type LockRec = ProcId & { tok: string; at: string };
  const readLock = (name: string): LockRec | "garbled" | undefined => {
    const raw = readText(at(name));
    if (raw === undefined) return undefined;
    try {
      const r = JSON.parse(raw) as LockRec;
      if (r && typeof r.tok === "string" && Number.isSafeInteger(r.pid) && typeof r.host === "string") return r;
    } catch {
      // garbled
    }
    return "garbled";
  };

  // Creates `name` atomically with its full content, or reports that it already exists.
  const tryLink = (name: string, rec: LockRec): boolean => {
    const tmp = at(`${name}.${rec.tok}`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(rec));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, at(name));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  };

  let held: string | undefined;
  const assertHeld = () => {
    if (!dir || held === undefined) return;
    const cur = readLock(LOCK_FILE);
    if (!cur || cur === "garbled" || cur.tok !== held) {
      poisoned = "the ledger lock was taken over while it was held";
      throw new SpendError("ledger", "The spend ledger lock was lost while it was held, so nothing was written and no paid call is made.");
    }
  };

  // Removes a lock whose owner is proven dead. Breakers are serialised by a momentary guard that is scoped to THAT dead lock (its token is
  // in the guard's name) and numbered: `openrouter-spend.lock.break.<lock token>.<n>`. A guard is only ever created while that dead
  // owner's lock is in place, so nobody else can change the lock in the meantime. A breaker that dies holding guard n leaves it behind;
  // the next breaker supersedes it by creating n+1 (exclusive, so only one wins) but ONLY when guard n's owner is proven dead by the same
  // proof as for locks. A guard whose owner is alive or cannot be proven gone is waited for (fail closed, busy), never removed.
  const TOKEN = /^[A-Za-z0-9-]{1,64}$/;
  const guardNumbers = (prefix: string): number[] => {
    try {
      return readdirSync(dir!)
        .filter((f) => f.startsWith(prefix) && /^\d{1,9}$/.test(f.slice(prefix.length)))
        .map((f) => Number(f.slice(prefix.length)));
    } catch {
      return [];
    }
  };
  const breakDead = (dead: LockRec) => {
    if (!TOKEN.test(dead.tok)) return; // a forged or odd token never becomes part of a file name; the lock stays (busy)
    const prefix = `${LOCK_FILE}.break.${dead.tok}.`;
    const top = Math.max(0, ...guardNumbers(prefix));
    if (top > 0) {
      const g = readLock(`${prefix}${top}`);
      if (g === undefined) return; // just removed by its owner: look again on the next turn
      if (g === "garbled" || livenessOf(g, me) !== "dead") return; // held, or not provably gone: wait
    }
    const rec: LockRec = { ...me, tok: randomUUID(), at: now().toISOString() };
    if (!tryLink(`${prefix}${top + 1}`, rec)) return;
    try {
      const cur = readLock(LOCK_FILE);
      if (cur && cur !== "garbled" && cur.tok === dead.tok && livenessOf(cur, me) === "dead") {
        fault("breaking");
        unlinkSync(at(LOCK_FILE));
      }
    } finally {
      // The dead lock is gone (or was never ours to break): every guard for it, ours and any dead predecessor's, is now meaningless.
      for (const n of guardNumbers(prefix)) {
        try {
          unlinkSync(at(`${prefix}${n}`));
        } catch {
          // already gone
        }
      }
    }
  };

  const withLock = <T>(fn: () => T): T => {
    if (!dir) return fn();
    if (poisoned) throw new SpendError("ledger", `The spend ledger is not used by this process any more (${poisoned}); restart ORBIT after checking the ledger.`);
    mkdirSync(dir, { recursive: true });
    const rec: LockRec = { ...me, tok: randomUUID(), at: now().toISOString() };
    const deadline = Date.now() + lockWaitMs;
    let pause = 2;
    for (;;) {
      if (tryLink(LOCK_FILE, rec)) break;
      const cur = readLock(LOCK_FILE);
      // Clearing a lock whose owner is proven dead does not skip the deadline below: if another breaker (or a stuck guard) is in the
      // way, this call still gives up with "busy" instead of spinning.
      if (cur !== undefined && cur !== "garbled" && livenessOf(cur, me) === "dead") breakDead(cur);
      if (Date.now() >= deadline) {
        throw new SpendError("busy", "The spend ledger is locked by another process, so this call is not made. Nothing was charged. A lock is never taken over on a timeout.");
      }
      sleepMs(pause);
      pause = Math.min(pause * 2, 40);
    }
    held = rec.tok;
    try {
      fault("locked");
      return fn();
    } finally {
      const cur = readLock(LOCK_FILE);
      if (cur && cur !== "garbled" && cur.tok === rec.tok) {
        try {
          unlinkSync(at(LOCK_FILE));
        } catch {
          // left behind: it names this live process, so others wait; it is cleared when this process ends
        }
      } else poisoned = "the ledger lock was taken over while it was held";
      held = undefined;
    }
  };

  // ---- provisioning, loss and rollback (B8) -----------------------------------------------------------------------------

  // The owner's one-shot request to create a ledger. Every request states the spend so far (`{}` is refused, PR65 finding 5), the very
  // first one too: {"openingLifetimeUsd": 0, "openingTodayUsd": 0, "note": "..."}. After a loss (a marker exists but the ledger does
  // not) it must also acknowledge the loss, because ORBIT cannot know the spend:
  //   {"acknowledgeLoss": true, "openingLifetimeUsd": 12.5, "openingTodayUsd": 0.3, "note": "from the OpenRouter dashboard"}
  // Optional "openingMonthUsd" (today <= month <= lifetime) says how much of it was spent in the current UTC month. Without it the whole
  // opening balance counts against this month's cap (conservative); with it, the rest is recorded as spent in earlier months.
  const readProvision = (marker: Marker | undefined): Opening | undefined => {
    const raw = readText(at(PROVISION_FILE));
    if (raw === undefined) return undefined;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(raw) as Record<string, unknown>;
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("shape");
    } catch {
      return bad("the provision file is not a JSON object");
    }
    const usd = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000_000 ? toMicro(v) : undefined);
    const life = p.openingLifetimeUsd === undefined ? 0 : usd(p.openingLifetimeUsd);
    const today = p.openingTodayUsd === undefined ? 0 : usd(p.openingTodayUsd);
    if (life === undefined || today === undefined || today > life) return bad("the provision file's opening amounts are not valid (today cannot exceed lifetime)");
    const month = p.openingMonthUsd === undefined ? undefined : usd(p.openingMonthUsd);
    if (p.openingMonthUsd !== undefined && (month === undefined || month < today || month > life)) {
      return bad("the provision file's openingMonthUsd is not valid (it must be a number from openingTodayUsd to openingLifetimeUsd)");
    }
    const note = typeof p.note === "string" ? p.note.replace(/\s+/g, " ").trim().slice(0, 200) : "no note";
    if (marker) {
      if (p.acknowledgeLoss !== true) {
        return bad("a history marker exists, so this is a recovery: the provision file must set acknowledgeLoss true and state openingLifetimeUsd and openingTodayUsd");
      }
    }
    // No silent fresh budget: even the first provisioning states the spend so far (0 is a statement, not a default), because after a total
    // loss of the state directory a first provisioning cannot be told from a recovery.
    if (p.openingLifetimeUsd === undefined || p.openingTodayUsd === undefined) {
      return bad("the provision file must state openingLifetimeUsd and openingTodayUsd (0 only if the key has really spent nothing); a ledger is never created with an assumed empty history");
    }
    return { lifetimeMicro: life, todayMicro: today, ...(month !== undefined ? { monthMicro: month } : {}), note: note || "no note", recover: Boolean(marker) };
  };

  const retireProvision = (epoch: string) => {
    try {
      renameSync(at(PROVISION_FILE), at(`${PROVISION_FILE}.used-${epoch}`));
      syncDir();
    } catch {
      // nothing to retire
    }
  };

  // Stray temp files can only come from a writer that died or failed; under the lock no ledger writer is active. Lock and guard files
  // (`openrouter-spend.lock.*`: token temp files, break guards, the pre-guard-numbering `.break`) are removed only when over a minute old: a
  // live process holds one for milliseconds, and one that stalls longer merely fails its own link, it can never gain a lock by it. This
  // process holds the lock itself, so the lock file (a different name) is never touched.
  const sweepTmp = () => {
    try {
      for (const f of readdirSync(dir!)) {
        // Per file: one that vanished between the listing and its stat or unlink (a concurrent breaker removed it) must not end the
        // sweep for the files after it (PR #68 review, finding 3).
        try {
          if (f.startsWith(`${LEDGER_FILE}.new.`) || f.startsWith(`${MARKER_FILE}.new.`)) unlinkSync(at(f));
          else if (f.startsWith(`${LOCK_FILE}.`) && Date.now() - statSync(at(f)).mtimeMs > 60_000) unlinkSync(at(f));
        } catch {
          // best effort, this file only
        }
      }
    } catch {
      // best effort: the directory could not be listed
    }
  };

  // Reads and checks the ledger under the lock. `provision` is true only for open().
  const load = (provision: boolean): Ledger => {
    if (!dir) {
      memory ??= fresh("memory");
      return memory;
    }
    const l = readLedgerFile();
    const m = readMarker();
    // Both files gone after this process read the ledger is a loss, not a first run. Only the explicit startup step with a recovery request
    // (which must acknowledge the loss and state the spend) may proceed.
    if (!l && !m && known && !provision) return bad("the ledger file and its history marker have both disappeared since this process last read it: spend since then is unknown");
    if (l) known = true;
    if (!l) {
      if (!provision) {
        throw new SpendError("ledger", m ? "The spend ledger file is missing although a history marker shows one existed, so spend since then is unknown and no paid call is made. It is never recreated automatically." : "The spend ledger has not been provisioned, so no paid call is made. It is never created automatically.");
      }
      const open = readProvision(m ?? (known ? ({ schema: 1, epoch: "lost", createdAt: "" } as Marker) : undefined));
      if (!open) {
        throw new SpendError("ledger", m ? "The spend ledger file is missing although a history marker shows one existed, so spend since then is unknown and no paid call is made. See the recovery steps in docs/openrouter-ledger-integrity.md." : "The spend ledger has not been provisioned, so no paid call is made. See docs/openrouter-ledger-integrity.md.");
      }
      const made = fresh(randomUUID(), open);
      write(made); // the ledger first, then the marker, then the request is retired: a crash in between never leaves a marker without a ledger
      writeMarker(made.epoch!, made.createdAt);
      retireProvision(made.epoch!);
      return made;
    }
    if (m && l.epoch !== undefined && m.epoch !== l.epoch) return bad("the ledger and its history marker do not belong together: the file was replaced or restored");
    if (m && l.epoch === undefined) return bad("the history marker names a ledger identity this file does not have: the file was replaced or restored");
    if (l.seq !== undefined && (l.seq < seen.seq || l.lifetimeMicro < seen.lifetime)) return bad("the file is older than what this process already saw: it was rolled back");
    if (provision) retireProvision(l.epoch ?? "existing");
    if (!m) {
      // The ledger holds the spend, the marker only identifies it. A lost marker does not lose spend: re-create it, once, from the ledger.
      if (l.epoch === undefined) {
        l.epoch = randomUUID();
        write(l);
      }
      writeMarker(l.epoch!, l.createdAt);
    }
    return l;
  };

  // Reservations whose owner is proven gone are charged at their bound; the others stay reserved. Returns whether anything changed.
  const adoptOrphans = (l: Ledger): boolean => {
    let changed = false;
    for (const [id, r] of Object.entries(l.reservations)) {
      if (r.owner && livenessOf(r.owner, me) !== "dead") continue;
      l.days[r.day] = (l.days[r.day] ?? 0) + r.micro;
      l.lifetimeMicro += r.micro;
      l.uncertain.push({ at: now().toISOString(), day: r.day, micro: r.micro, why: "orphaned: the process that made the request is gone and it was never settled" });
      delete l.reservations[id];
      changed = true;
    }
    return changed;
  };

  // One critical section: lock, read and check, charge orphans, run `fn`, write if anything changed, unlock.
  const tx = <T>(provision: boolean, fn: (l: Ledger, touch: () => void) => T): T =>
    withLock(() => {
      if (dir && provision) sweepTmp();
      const l = load(provision);
      fault("loaded");
      let dirty = adoptOrphans(l);
      const out = fn(l, () => (dirty = true));
      if (dirty) write(l);
      return out;
    });

  // Every outstanding reservation, whatever day it was made: it counts against each cap of the current period until it is settled.
  const outstanding = (l: Ledger) => Object.values(l.reservations).reduce((a, r) => a + r.micro, 0);

  // Charged spend in a UTC month: its days, plus the opening balance (the only spend outside the day table) if it belongs there. The
  // opening balance was spent at or before the ledger's creation, so it is counted in the creation month (all of it, unless the owner
  // stated how much was earlier: priorMonthsMicro) and, should the clock read an earlier month, there too. Never an undercount.
  const monthSpent = (l: Ledger, month: string): { micro: number } | { unknown: string } => {
    let inMonth = 0;
    let all = 0;
    for (const [d, m] of Object.entries(l.days)) {
      all += m;
      if (d.slice(0, 7) === month) inMonth += m;
    }
    const outside = l.lifetimeMicro - all;
    if (outside < 0) return { unknown: "its per-day spend adds up to more than its lifetime total" };
    const prior = l.priorMonthsMicro ?? 0;
    if (prior > outside) return { unknown: "its opening balance split is larger than the opening balance" };
    if (outside === 0) return { micro: inMonth };
    const created = Date.parse(l.createdAt);
    if (!Number.isFinite(created)) return { unknown: "its opening balance cannot be placed in a month because its creation time is unreadable" };
    const createdMonth = utcDay(new Date(created)).slice(0, 7);
    return { micro: inMonth + (month < createdMonth ? outside : month === createdMonth ? outside - prior : 0) };
  };
  const unreconstructable = (why: string) =>
    new SpendError("ledger", `The spend ledger's monthly total cannot be reconstructed (${why}), so no paid call is made. Fix or restore the ledger file; it is never reset automatically.`);

  function viewOf(l: Ledger): SpendView {
    const t = now();
    const day = utcDay(t);
    const month = day.slice(0, 7);
    const today = l.days[day] ?? 0;
    const out = outstanding(l);
    const m = monthSpent(l, month);
    if ("unknown" in m && caps.monthlyMicro !== undefined) throw unreconstructable(m.unknown);
    const left = (cap: number | undefined, used: number | undefined) => (cap === undefined || used === undefined ? undefined : Math.max(0, cap - used - out));
    const leftDay = left(caps.dailyMicro, today)!;
    const leftMonth = left(caps.monthlyMicro, "micro" in m ? m.micro : undefined);
    const leftTotal = left(caps.totalMicro, l.lifetimeMicro);
    const exhausted: CapName[] = [];
    if (leftDay === 0) exhausted.push("daily");
    if (leftMonth === 0) exhausted.push("monthly");
    if (leftTotal === 0) exhausted.push("lifetime");
    const usdOrNull = (n: number | undefined) => (n === undefined ? null : toUsd(n));
    return {
      day,
      month,
      caps: { dailyUsd: toUsd(caps.dailyMicro), monthlyUsd: usdOrNull(caps.monthlyMicro), totalUsd: usdOrNull(caps.totalMicro) },
      spentTodayUsd: toUsd(today),
      spentMonthUsd: "micro" in m ? toUsd(m.micro) : null,
      reservedUsd: toUsd(out),
      lifetimeUsd: toUsd(l.lifetimeMicro),
      remainingTodayUsd: toUsd(Math.min(leftDay, leftMonth ?? Infinity, leftTotal ?? Infinity)),
      remainingMonthUsd: usdOrNull(leftMonth),
      remainingTotalUsd: usdOrNull(leftTotal),
      exhausted,
      resets: { dailyAt: nextUtcDay(t), monthlyAt: nextUtcMonth(t) },
      uncertainRequests: l.uncertain.length,
    };
  }

  return {
    open() {
      return tx(true, (l) => viewOf(l));
    },

    reserve(maxMicro) {
      if (!isMicro(maxMicro) || maxMicro <= 0) throw new SpendError("bad_amount", "The cost bound for this request is not a positive amount, so it is not sent.");
      return tx(false, (l, touch) => {
        const t = now();
        const day = utcDay(t);
        const month = day.slice(0, 7);
        const out = outstanding(l);
        if ((l.days[day] ?? 0) + out + maxMicro > caps.dailyMicro) {
          throw new SpendError("daily_cap", `The OpenRouter daily cap of $${toUsd(caps.dailyMicro).toFixed(2)} (UTC day ${day}, resets ${nextUtcDay(t)}) would be exceeded.`);
        }
        if (caps.monthlyMicro !== undefined) {
          const m = monthSpent(l, month);
          if ("unknown" in m) throw unreconstructable(m.unknown);
          if (m.micro + out + maxMicro > caps.monthlyMicro) {
            throw new SpendError("monthly_cap", `The OpenRouter monthly cap of $${toUsd(caps.monthlyMicro).toFixed(2)} (UTC month ${month}, resets ${nextUtcMonth(t)}) would be exceeded.`);
          }
        }
        if (caps.totalMicro !== undefined && l.lifetimeMicro + out + maxMicro > caps.totalMicro) {
          throw new SpendError("total_cap", `The OpenRouter lifetime cap of $${toUsd(caps.totalMicro).toFixed(2)} would be exceeded. It never resets.`);
        }
        const id = randomUUID();
        l.reservations[id] = { at: now().toISOString(), day, micro: maxMicro, owner: me };
        touch();
        return { id, micro: maxMicro };
      });
    },

    settle(id, actualMicro, why) {
      tx(false, (l, touch) => {
        const r = l.reservations[id];
        if (!r) throw new SpendError("ledger", "Settling a reservation that is not in the ledger.");
        const known = isMicro(actualMicro);
        const charge = known ? actualMicro : r.micro;
        l.days[r.day] = (l.days[r.day] ?? 0) + charge;
        l.lifetimeMicro += charge;
        if (!known) l.uncertain.push({ at: now().toISOString(), day: r.day, micro: r.micro, why: why ?? "provider cost missing" });
        else if (charge > r.micro) l.uncertain.push({ at: now().toISOString(), day: r.day, micro: charge, why: "provider cost exceeded the reserved bound" });
        delete l.reservations[id];
        touch();
      });
    },

    release(id) {
      tx(false, (l, touch) => {
        if (!l.reservations[id]) return;
        delete l.reservations[id];
        touch();
      });
    },

    view() {
      return tx(false, (l) => viewOf(l));
    },

    inspect() {
      try {
        if (!dir) return memory ? { state: "ok", view: viewOf(memory) } : { state: "unprovisioned", requested: false };
        const l = readLedgerFile();
        const m = readMarker();
        if (!l && known) return { state: "failed", reason: "the spend ledger file and its history marker have both disappeared since this process last read it (loss; spend since then is unknown)" };
        if (l) known = true;
        if (!l) {
          if (m) return { state: "failed", reason: "the spend ledger file is missing although a history marker shows one existed (possible loss; spend since then is unknown)" };
          return { state: "unprovisioned", requested: readText(at(PROVISION_FILE)) !== undefined };
        }
        if (m && (l.epoch === undefined || m.epoch !== l.epoch)) return { state: "failed", reason: "the spend ledger and its history marker do not belong together (the file was replaced or restored)" };
        if (l.seq !== undefined && (l.seq < seen.seq || l.lifetimeMicro < seen.lifetime)) return { state: "failed", reason: "the spend ledger is older than what this process already saw (rolled back)" };
        // A normal hold lasts milliseconds. A lock this old is reported, never broken here.
        try {
          if (Date.now() - statSync(at(LOCK_FILE)).mtimeMs > 60_000) return { state: "failed", reason: "the spend ledger lock has been held for over a minute by a process that cannot be shown to be gone" };
        } catch {
          // no lock file: the normal case
        }
        return { state: "ok", view: viewOf(l) };
      } catch (err) {
        // validate() names the file in its text; the status never shows a path.
        const text = err instanceof SpendError ? err.message.split(file ?? "\0").join("the ledger file").split(/ Fix or restore/)[0]! : "the spend ledger could not be checked";
        const reason = text.replace(/\.$/, "").replace(/, so no paid call is made$/, "");
        return { state: "failed", reason: reason.charAt(0).toLowerCase() + reason.slice(1) };
      }
    },
  };
}
