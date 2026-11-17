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
};

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
