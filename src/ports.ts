import type { ModelHealth } from "./model-health.ts";
import type { CheckRecord } from "./smoke.ts";

export type PortState = "live" | "mock" | "degraded" | "down";

export type PortStatus = {
  port: string;
  state: PortState;
  impl: string;
  detail: string;
  verifiedAt: string;
  // Optional, added by /status only: this process's startup smoke-check record for the port (docs/smoke-checks.md). Additive: `state`
  // keeps its four values and its meaning, so consumers that ignore `check` are unchanged.
  check?: CheckRecord;
  // Optional, model port only, set by the OpenRouter fallback wrapper while the primary's limit is recorded (src/fallback.ts). Additive
  // like `check`: `state` keeps its meaning. `answering` is true only while the limit is in force, the fallback is usable (configured,
  // ledger sound, enough allowance left for the smallest possible call) AND the latest paid fallback call in this limit window
  // succeeded. It is evidence, not a promise: a larger request can still be refused by the caps; that refusal turns it false only when
  // no request in this window is known to fit (src/fallback.ts, status()). After the limit time it is false.
  fallback?: FallbackRoute;
  // Optional, model port only: whether a real reply can come from some model right now (src/model-availability.ts). Additive like
  // `check`. `/status` always sets it on the model port; the page's overall indicator reads it before `state`. It is about the model,
  // not about the ORBIT process: a status answer at all already shows the process is running.
  availability?: ModelAvailability;
  // Optional, model port only: whether the PRIMARY model is answering (healthy), ORBIT is in fallback, or it is not known, from the
  // post-deploy model smoke check and real calls (src/model-health.ts, docs/model-health.md). Additive like `check`.
  health?: ModelHealth;
};

export type FallbackRoute = {
  provider: "openrouter";
  model: string;
  answering: boolean;
  reason: "usage_limit" | "rate_limit";
  until: string;
  estimated: boolean;
  // Additive. What the latest paid fallback call in this limit window did (latest to start among those finished): "succeeded",
  // "failed" (a provider or network error, a ledger fault, or a cap or lock refusal that counts as evidence; see src/fallback.ts), or
  // "none" (no paid call yet in this window). A configured fallback with no call is not evidence.
  lastCall?: "succeeded" | "failed" | "none";
};

// `available`: true, a real reply is expected from the primary or the fallback; false, none can come (both unusable, or the model
// is down or a mock); null, not known (for example a fallback that has not been tried yet while the primary is limited). `via` names
// the route a reply would take.
export type ModelAvailability = { available: boolean | null; via: "primary" | "fallback" | "none" | "unknown"; reason: string };

export type Result<T> = {
  value: T;
  provenance: "live" | "mock";
  source: string;
};

export type Port = {
  name: string;
  status(): PortStatus;
  call(action: string, input: unknown): Result<unknown>;
};

// Every port is real now; mockPort stays for the next capability that starts as a mock.
export const MOCK_PORT_NAMES: readonly string[] = [];

export function mockPort(name: string, now: () => Date = () => new Date()): Port {
  const impl = "mock-static";
  return {
    name,
    status: () => ({
      port: name,
      state: "mock",
      impl,
      detail: `${name} is a mock. Its answers are not real.`,
      verifiedAt: now().toISOString(),
    }),
    call: (action) => ({
      value: { note: `Mock answer from ${name}.${action}. Nothing real happened.` },
      provenance: "mock",
      source: `${name}/${impl}`,
    }),
  };
}
