import { ProviderError } from "./chatgpt.ts";
import { primaryModelName } from "./model.ts";
import type { FallbackInfo, Item, Message, ModelPort, Reply, ReplyOptions, Step, ToolDef } from "./model.ts";
import type { PortStatus } from "./ports.ts";
import { sanitize } from "./smoke.ts";
import type { CheckOutcome, SmokeCheck } from "./smoke.ts";
import type { Store } from "./store.ts";

// Model health (docs/model-health.md): is the PRIMARY model actually answering, or is ORBIT in fallback?
//
// Why: after a deploy the new process has lost the in-memory limit record, so the ChatGPT port's local login check reports `live`
// before any call is made. The watch (src/watch.ts) then saw `live` for a model it had alerted on and sent "model is live again",
// although the next real call hit the same limit and fell back again. That was a false "restored" notice and needless churn.
//
// What decides it, newest first (a call that started earlier never overwrites a call that started later):
//   - the post-deploy model smoke check (modelSmokeCheck below): ONE minimal call to the primary right after the server starts
//     listening, before the watch may send a model recovery notice;
//   - every real model call made through observeModel(): a primary answer is `healthy`; a usage or rate limit, or an answer that came
//     from the OpenRouter fallback, is `fallback`. Other failures (auth, timeout, network) say nothing about the limit and leave it.
//   - `unknown`: no evidence at all yet (a fresh install).
// The state is persisted (<state>/model-health.json) so it is readable across restarts, but only evidence from THIS process can
// confirm a recovery: confirmsRecovery() is false after a restart until the smoke check or a real call has answered from the primary.

export type ModelHealthState = "healthy" | "fallback" | "unknown";
export type ModelSmokeKind = "usage_limit" | "rate_limit" | "timeout" | "auth" | "overloaded" | "incomplete" | "failed" | "cancelled" | "fallback-answered" | "error";
export type ModelSmokeResult = {
  state: "pending" | "passed" | "failed" | "skipped";
  at: string;
  // The primary model the call went to (the port's impl without its transport prefix).
  model?: string;
  latencyMs?: number;
  kind?: ModelSmokeKind;
  // One sanitized line.
  reason?: string;
};
export type ModelHealth = {
  state: ModelHealthState;
  // When `state` took its current value.
  since: string;
  // The time of the latest evidence (or of the startup reset).
  at: string;
  source: "smoke" | "call" | "none";
  // The primary model the evidence is about.
  model?: string;
  reason?: string;
  // The latest post-deploy smoke check (one per process).
  smoke?: ModelSmokeResult;
};

const EPOCH = new Date(0).toISOString();
const STATES: readonly ModelHealthState[] = ["healthy", "fallback", "unknown"];
const initial = (): ModelHealth => ({ state: "unknown", since: EPOCH, at: EPOCH, source: "none" });
const valid = (h: unknown): h is ModelHealth =>
  !!h && typeof h === "object" && STATES.includes((h as ModelHealth).state) && typeof (h as ModelHealth).since === "string" && typeof (h as ModelHealth).at === "string";

export type HealthLog = (line: Record<string, unknown>) => void;
const logLine: HealthLog = (line) => console.log(JSON.stringify(line));

export type Evidence = { state: Exclude<ModelHealthState, "unknown">; source: "smoke" | "call"; model?: string; reason?: string };

export type ModelHealthTracker = ReturnType<typeof modelHealthTracker>;

export function modelHealthTracker(store: Store<ModelHealth | null>, o: { now?: () => Date; log?: HealthLog } = {}) {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? logLine;
  let cur: ModelHealth;
  try {
    const saved = store.read();
    cur = valid(saved) ? saved : initial();
  } catch {
    cur = initial();
  }
  // The smoke record on disk is the previous process's: this process's check has not run yet. In memory only until something is written.
  cur = { ...cur, smoke: { state: "pending", at: now().toISOString() } };
  // Evidence from this process: only that can confirm a recovery.
  let fresh = false;
  let started = 0;
  let latest = 0;
  const save = (next: ModelHealth) => {
    cur = next;
    try {
      store.write(next);
    } catch (err) {
      // The in-memory value still serves this process; the next write tries again.
      log({ at: now().toISOString(), model_health: "could not be saved", error: sanitize(err instanceof Error ? err.message : String(err)) });
    }
  };

  return {
    read: (): ModelHealth => cur,
    // True only when the primary answered in THIS process and nothing newer says otherwise.
    confirmsRecovery: (): boolean => fresh && cur.state === "healthy",
    // Call when a model call starts; pass the ticket to record() when it ends.
    ticket: (): number => ++started,
    // Records a finished call's evidence. Ignored when a call that started later has already recorded (returns false).
    record(ticket: number, e: Evidence): boolean {
      if (ticket < latest) return false;
      latest = ticket;
      fresh = true;
      const at = now().toISOString();
      const changed = e.state !== cur.state;
      if (changed) log({ at, model_health: e.state, was: cur.state, source: e.source, ...(e.model ? { model: e.model } : {}), ...(e.reason ? { reason: sanitize(e.reason) } : {}) });
      save({ ...cur, state: e.state, since: changed ? at : cur.since, at, source: e.source, ...(e.model ? { model: e.model } : {}), ...(e.reason ? { reason: sanitize(e.reason) } : { reason: undefined }) });
      return true;
    },
    // The smoke check's own record (kept beside the state, whatever the state became).
    smoke(result: ModelSmokeResult): void {
      save({ ...cur, smoke: { ...result, ...(result.reason ? { reason: sanitize(result.reason) } : {}) } });
    },
  };
}

const isLimit = (err: unknown): err is ProviderError => err instanceof ProviderError && (err.kind === "usage_limit" || err.kind === "rate_limit");
const fellBack = (f: FallbackInfo) => `ChatGPT ${f.reason === "usage_limit" ? "usage limit" : "rate limit"}; the OpenRouter fallback (${f.model}) answered`;

// Wraps the model port every caller uses, so each real call's outcome updates the health state. Behaviour is otherwise unchanged:
// the same results and errors pass through, and the port's other functions (sign-in routes, images, maintain, fallbackState) stay
// reachable. status() gains an additive `health` field.
export function observeModel<M extends ModelPort>(inner: M, health: ModelHealthTracker): M {
  const name = () => primaryModelName(inner.status().impl);
  const done = (t: number, fallback: FallbackInfo | undefined) => {
    // A mock answer is not evidence about any real model.
    if (fallback) health.record(t, { state: "fallback", source: "call", model: name(), reason: fellBack(fallback) });
    else if (inner.status().state !== "mock") health.record(t, { state: "healthy", source: "call", model: name() });
  };
  const failed = (t: number, err: unknown) => {
    if (isLimit(err)) health.record(t, { state: "fallback", source: "call", model: name(), reason: `ChatGPT ${err.kind === "usage_limit" ? "usage limit" : "rate limit"}: ${err.base}` });
  };
  const wrapper = {
    status: (): PortStatus => ({ ...inner.status(), health: health.read() }),
    async reply(messages: Message[], limits: string[], notes?: string, opts?: ReplyOptions): Promise<Reply> {
      const t = health.ticket();
      try {
        const r = await inner.reply(messages, limits, notes, opts);
        done(t, r.fallback);
        return r;
      } catch (err) {
        failed(t, err);
        throw err;
      }
    },
    ...(inner.step
      ? {
          async step(input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], opts?: ReplyOptions): Promise<Step> {
            const t = health.ticket();
            try {
              const s = await inner.step!(input, limits, notes, tools, opts);
              done(t, s.fallback);
              return s;
            } catch (err) {
              failed(t, err);
              throw err;
            }
          },
        }
      : {}),
  } as Record<string, unknown>;
  for (const [k, v] of Object.entries(inner)) {
    if (!(k in wrapper) && typeof v === "function") wrapper[k] = v.bind(inner);
  }
  return wrapper as M;
}

// ---- the post-deploy model smoke check -------------------------------------------------------------------------------------------

// The fixed, non-private prompt. Nothing about Rai, no history, no tools; the answer is not inspected, stored or shown.
export const MODEL_SMOKE_PROMPT = "ORBIT health check. Reply with the single word: ok";
// The call is abandoned after this long. The check never blocks the deploy (it runs after the server is listening), but the watch
// holds a model recovery notice until it ends, so it must end soon.
export const MODEL_SMOKE_TIMEOUT_MS = 8_000;

const kindOf = (err: unknown, timedOut: boolean): ModelSmokeKind => {
  if (timedOut) return "timeout";
  if (err instanceof ProviderError) return err.kind;
  return "error";
};

// One minimal call to the PRIMARY model, made once per process by the smoke runner (src/smoke.ts) when the server starts listening.
// `model` is the port as built (ChatGPT, or the OpenRouter fallback wrapper around it); the call is made with `fallback: false`, so the
// paid fallback is never spent: while the primary is limited the wrapper refuses at once instead (src/fallback.ts, "Background callers
// never spend the paid fallback"). Outcome:
//   - the primary answers: health `healthy` (a recovery notice may go out);
//   - a usage or rate limit, or (defensively) an answer marked as from the fallback: health `fallback`, so no "model restored" notice;
//   - anything else (timeout, auth, network): the state is kept as it was (still fallback if it was), and the reason is logged.
// The call goes through the port's own reply(), so its outcome also updates the port's own state exactly as a real call would (a
// limit is recorded and the port reports it, instead of the stale "live" from the local login check).
export function modelSmokeCheck(o: { model: ModelPort; health: ModelHealthTracker; timeoutMs?: number; log?: HealthLog }): SmokeCheck {
  const timeoutMs = o.timeoutMs ?? MODEL_SMOKE_TIMEOUT_MS;
  const log = o.log ?? logLine;
  const name = () => primaryModelName(o.model.status().impl);
  const finish = (r: ModelSmokeResult) => {
    o.health.smoke(r);
    log({ at: r.at, model_smoke: r.state, ...(r.model ? { model: r.model } : {}), ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}), ...(r.kind ? { kind: r.kind } : {}), ...(r.reason ? { reason: sanitize(r.reason) } : {}), health: o.health.read().state });
  };
  return {
    id: "model",
    port: "model",
    property: "the primary model answers one minimal request (fixed one-line prompt, no tools, no history; never the paid fallback)",
    evidence: "functional",
    // The runner's own deadline is a backstop; the check abandons the call itself at timeoutMs and records why.
    timeoutMs: timeoutMs + 2_000,
    cost: `1 request to the primary model (ChatGPT subscription usage, not paid), a fixed one-line prompt, no tools, no history, no retry, abandoned after ${timeoutMs} ms; the answer is not stored or shown; never the paid OpenRouter fallback`,
    skip: () => {
      const st = o.model.status();
      const why = st.state === "mock" ? { kind: "mock" as const, reason: "no model is configured; replies are mock" } : st.state === "down" ? { kind: "unconfigured" as const, reason: `the model reports down before any call: ${sanitize(st.detail)}` } : undefined;
      if (why) finish({ state: "skipped", at: new Date().toISOString(), model: name(), reason: why.reason });
      return why;
    },
    run: async (signal): Promise<CheckOutcome> => {
      const model = name();
      const t = o.health.ticket();
      // An explicit timer (cleared below), not AbortSignal.timeout: the call is bounded whatever else keeps the process alive.
      const timer = new AbortController();
      const clock = setTimeout(() => timer.abort(), timeoutMs);
      const both = AbortSignal.any([signal, timer.signal]);
      const start = Date.now();
      const at = () => new Date().toISOString();
      o.health.smoke({ state: "pending", at: at(), model });
      log({ at: at(), model_smoke: "started", model, timeoutMs });
      try {
        const r = await o.model.reply([{ role: "user", content: MODEL_SMOKE_PROMPT }], [], undefined, { fallback: false, signal: both });
        const latencyMs = Date.now() - start;
        if (r.fallback) {
          const reason = `the primary did not answer: ${fellBack(r.fallback)}`;
          o.health.record(t, { state: "fallback", source: "smoke", model, reason });
          finish({ state: "failed", at: at(), model, latencyMs, kind: "fallback-answered", reason });
          return { state: "failed", reason };
        }
        o.health.record(t, { state: "healthy", source: "smoke", model });
        finish({ state: "passed", at: at(), model, latencyMs });
        return { state: "passed", detail: `${model} answered in ${latencyMs} ms` };
      } catch (err) {
        const latencyMs = Date.now() - start;
        const kind = kindOf(err, timer.signal.aborted && !signal.aborted);
        const text = kind === "timeout" ? `no answer within ${timeoutMs} ms` : err instanceof ProviderError ? err.base : err instanceof Error ? err.message : String(err);
        // Only a limit is evidence of fallback; any other failure keeps the state as it was.
        if (isLimit(err)) o.health.record(t, { state: "fallback", source: "smoke", model, reason: `ChatGPT ${kind === "usage_limit" ? "usage limit" : "rate limit"}: ${text}` });
        finish({ state: "failed", at: at(), model, latencyMs, kind, reason: text });
        return { state: "failed", reason: `${kind}: ${text}` };
      } finally {
        clearTimeout(clock);
      }
    },
  };
}
