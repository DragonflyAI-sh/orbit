export type PortState = "live" | "mock" | "degraded" | "down";

export type PortStatus = {
  port: string;
  state: PortState;
  impl: string;
  detail: string;
  verifiedAt: string;
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

export const PORT_NAMES = [
  "channel",
  "model",
  "memory",
  "runs",
  "schedule",
  "tools",
  "nodes",
  "notify",
] as const;

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
