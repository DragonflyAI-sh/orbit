import { decide } from "./policy.ts";
import type { EmbeddingBudget, EmbeddingsConfig, OpenAIEmbedder } from "./embeddings.ts";
import { EmbeddingUnavailable } from "./embeddings.ts";
import type { PortStatus } from "./ports.ts";
import type { CheckOutcome, SmokeCheck } from "./smoke.ts";

// ORBIT's startup smoke checks: one entry per /status port. The matrix (property, probe, dependencies, cost, timeout, skip reason)
// is docs/smoke-checks.md; keep the two in step. Only checks that are read-only, free or explicitly bounded run automatically.
// Paid model generation, notification delivery, job launches, tool calls with caller-chosen targets and any write are never invoked
// here: they are recorded as skipped, with the reason, and their ports keep reporting from real operations.

// The one fixed, non-private, synthetic input the embeddings probe sends: 19 ASCII bytes, so at most 19 input tokens.
export const SMOKE_EMBED_TEXT = "orbit startup check";
// A fixed query for the read-only keyword search check. Its hits are never stored, logged or returned.
export const SMOKE_MEMORY_QUERY = "orbit";

const failedFrom = (err: unknown): CheckOutcome => ({ state: "failed", reason: err instanceof EmbeddingUnavailable ? `${err.kind}: ${err.message}` : err instanceof Error ? err.message : String(err) });

// Opt-in photo embeddings, through the SAME adapter instance photos_search uses, so its outcome is the port's own evidence. At most one
// request per process (the runner is single-flight; attempts: 1, so no retries), counted against ORBIT's daily embeddings budget like
// any request. Disabled or unconfigured: skipped, and nothing is built or sent.
export function embeddingsCheck(o: { config: EmbeddingsConfig; embedder: OpenAIEmbedder | undefined; budget: EmbeddingBudget | undefined; timeoutMs?: number }): SmokeCheck {
  const bytes = Buffer.byteLength(SMOKE_EMBED_TEXT, "utf8");
  return {
    id: "photo-embeddings",
    port: "photo-embeddings",
    property: "the dedicated embeddings adapter returns one finite, non-zero vector of the configured dimensions for a fixed synthetic string",
    evidence: "functional",
    timeoutMs: o.timeoutMs ?? 20_000,
    cost: `1 embeddings request of ${bytes} bytes (at most ${bytes} input tokens), no retry, counted against ORBIT's daily embeddings budget; no photo or private text is sent and nothing is cached`,
    skip: () => {
      if (o.config.state === "off") return { kind: "disabled", reason: "semantic photo search is off (ORBIT_PHOTO_SEMANTIC is not on)" };
      if (o.config.state === "misconfigured" || !o.embedder || !o.budget) return { kind: "unconfigured", reason: o.config.state === "misconfigured" ? o.config.detail : "the embeddings adapter is not built" };
      if (o.budget.unreadable()) return { kind: "budget", reason: "the embeddings budget ledger is unreadable, so no request is sent" };
      const u = o.budget.used();
      if (u.requests + 1 > o.budget.limits.dailyRequests || u.tokens + bytes > o.budget.limits.dailyTokens) return { kind: "budget", reason: "today's embeddings budget has no room for the check; real searches keep what is left" };
      return undefined;
    },
    run: async (signal) => {
      const e = o.embedder!;
      let vectors: number[][];
      try {
        vectors = await e.embed([SMOKE_EMBED_TEXT], signal, { attempts: 1 });
      } catch (err) {
        return failedFrom(err);
      }
      // The adapter validates the response; this re-checks the property the record claims.
      const v = vectors?.[0];
      if (vectors?.length !== 1 || !Array.isArray(v) || v.length !== e.id.dims || !v.every((z) => typeof z === "number" && Number.isFinite(z)) || !v.some((z) => z !== 0)) {
        return { state: "failed", reason: `malformed: expected one finite vector of ${e.id.dims} numbers` };
      }
      return { state: "passed", detail: `1 vector of ${v.length} finite numbers from ${e.id.model}` };
    },
  };
}

// Keyword search over the vault copy: local files only, no network, no writes. The result is discarded.
export function memoryCheck(o: { memory: { status(): PortStatus; search(query: string, limit?: number): unknown } }): SmokeCheck {
  return {
    id: "memory",
    port: "memory",
    property: "a keyword search over the vault copy answers (hits are not inspected, stored or shown)",
    evidence: "functional",
    timeoutMs: 10_000,
    cost: "one in-process search over local files; no network, no writes, nothing returned",
    skip: () => {
      const st = o.memory.status();
      return st.impl === "none" ? { kind: "unconfigured", reason: `memory has no readable vault copy: ${st.detail}` } : undefined;
    },
    run: async () => {
      try {
        o.memory.search(SMOKE_MEMORY_QUERY, 1);
      } catch (err) {
        return failedFrom(err);
      }
      return { state: "passed", detail: "keyword search answered" };
    },
  };
}

// The fail-closed policy, computed in-process for fixed cases.
export function policyCheck(): SmokeCheck {
  return {
    id: "policy",
    port: "policy",
    property: "decide() refuses an owner-only action for a non-owner and an action on an unknown port even for the owner, and allows the owner",
    evidence: "local",
    timeoutMs: 1_000,
    cost: "pure in-process computation",
    run: async () => {
      const ok = !decide("memory", "search", false).allow && decide("memory", "search", true).allow && !decide("smoke-unknown-port", "write", true).allow;
      return ok ? { state: "passed", detail: "fail-closed decisions as expected" } : { state: "failed", reason: "policy decisions differ from the fail-closed baseline" };
    },
  };
}

// The web channel: GET / over loopback from this process, the same route a browser loads. Read-only.
export function channelCheck(o: { base: () => string | undefined; fetcher?: typeof fetch }): SmokeCheck {
  return {
    id: "channel",
    port: "channel",
    property: "GET / on the listening address returns the web page (HTTP 200, text/html)",
    evidence: "functional",
    timeoutMs: 5_000,
    cost: "one loopback HTTP GET of the static page; no identity lookup, no writes",
    run: async (signal) => {
      const base = o.base();
      if (!base) return { state: "untested", reason: "the listening address is not known" };
      try {
        const res = await (o.fetcher ?? fetch)(`${base}/`, { signal });
        const type = res.headers.get("content-type") ?? "";
        await res.body?.cancel().catch(() => {});
        return res.status === 200 && type.startsWith("text/html") ? { state: "passed", detail: "web page served" } : { state: "failed", reason: `GET / answered HTTP ${res.status} ${type.split(";")[0]}` };
      } catch (err) {
        return failedFrom(err);
      }
    },
  };
}

// A port that is verified by the service's own work (the 30-second tick): passes once the port reports live with a verifiedAt from
// this process; fails only if the port itself reports down; otherwise, at its deadline, untested (no observation is not a failure).
export function observedCheck(o: { port: string; property: string; status: () => PortStatus; processStart: Date; timeoutMs?: number; pollMs?: number }): SmokeCheck {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const pollMs = o.pollMs ?? 250;
  return {
    id: o.port,
    port: o.port,
    property: o.property,
    evidence: "operation",
    timeoutMs: timeoutMs + 1_000,
    cost: "reads the port's own status; the work it observes is the service's normal tick",
    run: async (signal) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const s = o.status();
        const at = new Date(s.verifiedAt).getTime();
        if (s.state === "down" && at >= o.processStart.getTime()) return { state: "failed", reason: `${o.port} reports down: ${s.detail}` };
        if (s.state === "live" && at >= o.processStart.getTime()) return { state: "passed", detail: `observed ${s.verifiedAt}` };
        if (Date.now() >= until || signal.aborted) return { state: "untested", reason: `no ${o.port} activity from this process was observed within ${timeoutMs} ms (state ${s.state})` };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

export const skipped = (port: string, kind: NonNullable<ReturnType<NonNullable<SmokeCheck["skip"]>>>["kind"], property: string, reason: string): SmokeCheck => ({
  id: port,
  port,
  property,
  evidence: "readiness",
  timeoutMs: 0,
  cost: "none: not run",
  skip: () => ({ kind, reason }),
});

// The full registry for the running service. Order is the order /status lists the records in.
export function orbitSmokeChecks(o: {
  base: () => string | undefined;
  processStart: Date;
  memory: { status(): PortStatus; search(query: string, limit?: number): unknown };
  modelMock: () => boolean;
  schedule: { status(): PortStatus };
  runs: { status(): PortStatus };
  nodes: { status(): PortStatus };
  watch?: { status(): PortStatus };
  embeddings?: { config: EmbeddingsConfig; embedder: OpenAIEmbedder | undefined; budget: EmbeddingBudget | undefined };
}): SmokeCheck[] {
  return [
    policyCheck(),
    channelCheck({ base: o.base }),
    {
      ...skipped("model", "paid", "the model answers a request", "model generation uses the ChatGPT subscription or a paid fallback, so it is never called automatically; full verification needs separate authorization. The model port reports from real replies and its local login check."),
      ...(o.modelMock() ? { skip: () => ({ kind: "mock" as const, reason: "no model is configured; replies are mock" }) } : {}),
    },
    memoryCheck({ memory: o.memory }),
    skipped("notify", "side-effects", "a notification is delivered", "delivering a notification is a side effect (web inbox, Discord), so it is never sent automatically; receipts from real notifications are the evidence"),
    observedCheck({ port: "schedule", property: "the scheduler ticked in this process", status: o.schedule.status, processStart: o.processStart }),
    observedCheck({ port: "runs", property: "the run queue was pumped in this process", status: o.runs.status, processStart: o.processStart }),
    skipped("tools", "on-demand", "a read-only tool answers", "tools call external services for a target the caller names; there is no fixed safe target, so they are checked when called"),
    observedCheck({ port: "nodes", property: "device presence was read from tailscaled in this process", status: o.nodes.status, processStart: o.processStart }),
    skipped("jobs", "side-effects", "a cloud job can be launched", "launching a job starts a cloud session, so it is never done automatically; the job API reports from real runner events"),
    ...(o.watch ? [observedCheck({ port: "watch", property: "the port watch ticked in this process", status: o.watch.status, processStart: o.processStart })] : []),
    ...(o.embeddings ? [embeddingsCheck(o.embeddings)] : []),
  ];
}
