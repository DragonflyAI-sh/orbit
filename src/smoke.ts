// Post-deploy smoke checks (docs/smoke-checks.md): a bounded, once-per-process suite that runs as soon as the server is listening, so
// /status carries fresh evidence from THIS process without waiting for a user to touch each capability.
//
// - Started by buildServer on the server's "listening" event (src/server.ts), never by GET /status: /status only reads the records.
// - Single-flight: start() runs the suite at most once per process; a second call returns the same promise. There is no manual trigger.
// - Bounded: at most `concurrency` checks at once, a per-check deadline (the check's own timeoutMs) and a total deadline. A check that
//   runs past its deadline is recorded as failed (timeout) and its signal is aborted; anything it reports later is ignored, so a late
//   result can never overwrite the record. At the total deadline, checks still waiting or running are recorded as untested.
// - Isolated: a check that throws, hangs or rejects affects only its own record.
// - Honest: a check is `passed` only when it actually observed what its `property` says. Not observed is `untested`, never `failed`.
//   Disabled, unconfigured, paid or side-effectful capabilities are `skipped` with the reason, and their checks never run. `verifiedAt`
//   is set only by a passed check, and every record is tied to this process (commit, pid, start time): nothing is read from disk, so
//   a previous process's evidence is never carried forward.
// - Sanitized: reasons are cut to one short line and anything shaped like a key or token is removed before it is stored or logged.

export type CheckState = "pending" | "running" | "passed" | "failed" | "skipped" | "untested";
// What a passed check proves: `functional` exercised the capability itself (read-only or bounded); `readiness` a supported local
// precondition only; `operation` observed the service's own work (its tick); `local` an in-process computation.
export type Evidence = "functional" | "readiness" | "operation" | "local";
export type SkipKind = "disabled" | "unconfigured" | "mock" | "paid" | "side-effects" | "budget" | "on-demand";

export type CheckOutcome = { state: "passed"; detail?: string } | { state: "failed"; reason: string } | { state: "untested"; reason: string };

export type SmokeCheck = {
  id: string;
  // The /status port this check speaks for.
  port: string;
  // The one property a pass asserts, in words.
  property: string;
  evidence: Evidence;
  timeoutMs: number;
  // Requests, cost and side effects of one run, for the matrix and the record.
  cost: string;
  // Decided when the run starts. A skipped check never runs.
  skip?: () => { kind: SkipKind; reason: string } | undefined;
  run?: (signal: AbortSignal) => Promise<CheckOutcome>;
};

export type ProcessIdentity = { commit: string; pid: number; startedAt: string };

export type CheckRecord = {
  id: string;
  port: string;
  property: string;
  evidence: Evidence;
  cost: string;
  // `stale` is derived when read: a pass older than staleAfterMs.
  state: CheckState | "stale";
  skip?: SkipKind;
  reason?: string;
  detail?: string;
  startedAt?: string;
  // When this attempt ended (passed, failed, untested or skipped).
  observedAt?: string;
  // Only a passed check sets it.
  verifiedAt?: string;
  durationMs?: number;
  runId: string;
  // Set by the status merge in src/server.ts: the port has real-operation evidence newer than this attempt's start.
  superseded?: boolean;
};

export type SmokeSummary = {
  runId: string;
  process: ProcessIdentity;
  state: "pending" | "running" | "done";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  deadlineMs: number;
  counts: Record<CheckState | "stale", number>;
  checks: CheckRecord[];
};

export const SMOKE_TOTAL_MS = 45_000;
export const SMOKE_CONCURRENCY = 3;
// A pass older than this reads as `stale`. The suite runs once per process, so this says how old the startup evidence is.
export const SMOKE_STALE_AFTER_MS = 60 * 60_000;
const REASON_MAX = 200;

// One short line, with anything shaped like a credential removed. Applied to every reason and detail before it is stored or logged.
export function sanitize(text: string, max = REASON_MAX): string {
  let out = String(text).replace(/\s+/g, " ").trim();
  out = out
    .replace(/\b(Bearer|Basic|token|Authorization)(?:\s*[:=]\s*|\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function processIdentity(commit: string, now: () => Date = () => new Date()): ProcessIdentity {
  return { commit, pid: process.pid, startedAt: new Date(now().getTime() - Math.round(process.uptime() * 1000)).toISOString() };
}

export type SmokeRunner = ReturnType<typeof smokeRunner>;

export function smokeRunner(o: {
  checks: SmokeCheck[];
  identity: ProcessIdentity;
  now?: () => Date;
  totalMs?: number;
  concurrency?: number;
  staleAfterMs?: number;
  log?: (line: Record<string, unknown>) => void;
}) {
  const now = o.now ?? (() => new Date());
  const totalMs = o.totalMs ?? SMOKE_TOTAL_MS;
  const concurrency = Math.max(1, o.concurrency ?? SMOKE_CONCURRENCY);
  const staleAfterMs = o.staleAfterMs ?? SMOKE_STALE_AFTER_MS;
  const log = o.log ?? ((line) => console.log(JSON.stringify(line)));
  const runId = `${o.identity.commit.slice(0, 12)}-${o.identity.pid}-${new Date(o.identity.startedAt).getTime()}`;
  const ids = new Set<string>();
  for (const c of o.checks) {
    if (ids.has(c.id)) throw new Error(`duplicate smoke check id ${c.id}`);
    ids.add(c.id);
  }
  const records = new Map<string, CheckRecord>(o.checks.map((c) => [c.id, { id: c.id, port: c.port, property: c.property, evidence: c.evidence, cost: c.cost, state: "pending", runId }]));
  let state: SmokeSummary["state"] = "pending";
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let running: Promise<void> | undefined;
  // Checks still running or waiting when the total deadline passes are closed as untested; their late results are ignored.
  const final = new Set<string>();

  const settle = (id: string, patch: Partial<CheckRecord>) => {
    if (final.has(id)) return;
    final.add(id);
    const r = records.get(id)!;
    const ended = now();
    records.set(id, { ...r, ...patch, observedAt: ended.toISOString(), ...(r.startedAt ? { durationMs: Math.max(0, ended.getTime() - new Date(r.startedAt).getTime()) } : {}) });
  };

  const runOne = async (c: SmokeCheck, suite: AbortSignal): Promise<void> => {
    if (final.has(c.id)) return;
    const ctl = new AbortController();
    const onSuite = () => ctl.abort();
    suite.addEventListener("abort", onSuite, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CheckOutcome>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve({ state: "failed", reason: `timeout: no answer within ${c.timeoutMs} ms` });
      }, c.timeoutMs);
    });
    let outcome: CheckOutcome;
    try {
      outcome = await Promise.race([
        Promise.resolve().then(() => c.run!(ctl.signal)),
        deadline,
        new Promise<CheckOutcome>((resolve) => suite.addEventListener("abort", () => resolve({ state: "untested", reason: `the suite's ${totalMs} ms deadline passed before this check finished` }), { once: true })),
      ]);
    } catch (err) {
      outcome = { state: "failed", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      suite.removeEventListener("abort", onSuite);
    }
    ctl.abort();
    if (outcome.state === "passed") {
      const at = now().toISOString();
      settle(c.id, { state: "passed", verifiedAt: at, ...(outcome.detail ? { detail: sanitize(outcome.detail) } : {}) });
    } else settle(c.id, { state: outcome.state, reason: sanitize(outcome.reason) });
  };

  const execute = async (): Promise<void> => {
    state = "running";
    const t0 = now();
    startedAt = t0.toISOString();
    const suite = new AbortController();
    const queue: SmokeCheck[] = [];
    for (const c of o.checks) {
      let skip: ReturnType<NonNullable<SmokeCheck["skip"]>>;
      try {
        skip = c.skip?.();
      } catch (err) {
        settle(c.id, { state: "failed", reason: sanitize(`could not decide whether to run: ${err instanceof Error ? err.message : String(err)}`) });
        continue;
      }
      if (skip) settle(c.id, { state: "skipped", skip: skip.kind, reason: sanitize(skip.reason) });
      else if (!c.run) settle(c.id, { state: "skipped", skip: "on-demand", reason: "no safe automatic check exists for this capability" });
      else queue.push(c);
    }
    const total = setTimeout(() => {
      suite.abort();
      for (const c of queue) if (!final.has(c.id)) settle(c.id, { state: "untested", reason: `the suite's ${totalMs} ms deadline passed before this check ran` });
    }, totalMs);
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const c = queue.find((q) => records.get(q.id)!.state === "pending" && !final.has(q.id));
        if (!c || suite.signal.aborted) return;
        // Claim before awaiting so two workers never take the same check.
        records.set(c.id, { ...records.get(c.id)!, state: "running", startedAt: now().toISOString() });
        await runOne(c, suite.signal);
      }
    });
    await Promise.all(workers);
    clearTimeout(total);
    state = "done";
    const t1 = now();
    finishedAt = t1.toISOString();
    log({ at: finishedAt, smoke: "done", runId, commit: o.identity.commit, durationMs: t1.getTime() - t0.getTime(), checks: [...records.values()].map((r) => ({ id: r.id, state: r.state, ...(r.skip ? { skip: r.skip } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) })) });
  };

  const view = (r: CheckRecord, at: Date): CheckRecord => (r.state === "passed" && r.verifiedAt && at.getTime() - new Date(r.verifiedAt).getTime() > staleAfterMs ? { ...r, state: "stale" } : { ...r });

  return {
    runId,
    identity: o.identity,
    // Runs the suite once per process. Never throws; a second call returns the same promise.
    start(): Promise<void> {
      running ??= execute().catch((err) => {
        state = "done";
        finishedAt = now().toISOString();
        log({ at: finishedAt, smoke: "error", runId, error: sanitize(err instanceof Error ? err.message : String(err)) });
      });
      return running;
    },
    // Read-only views: they never start or run anything.
    forPort(port: string, at: Date = now()): CheckRecord | undefined {
      const r = [...records.values()].find((x) => x.port === port);
      return r ? view(r, at) : undefined;
    },
    summary(at: Date = now()): SmokeSummary {
      const checks = [...records.values()].map((r) => view(r, at));
      const counts = { pending: 0, running: 0, passed: 0, failed: 0, skipped: 0, untested: 0, stale: 0 };
      for (const c of checks) counts[c.state]++;
      return {
        runId,
        process: o.identity,
        state,
        ...(startedAt ? { startedAt } : {}),
        ...(finishedAt ? { finishedAt } : {}),
        ...(startedAt && finishedAt ? { durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime() } : {}),
        deadlineMs: totalMs,
        counts,
        checks,
      };
    },
  };
}
