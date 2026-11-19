// Shared by the orbit-ops-ws privileged helper (ws-helper.ts, ws-run.ts) and ORBIT's client (../ops-ws-client.ts). orbit-ops-ws is a
// separately installed tier that prepares the HOST for ORBIT's workspace tools (docs/orbit-ops-ws.md). Nothing in a request ever becomes
// a command, a path or a unit name: the setup plan is fixed in ws-core.ts, and the only caller-supplied values are a validated
// operation id and, for ws_setup, the 24-hex key of the plan the owner was shown. The installer copies this file next to the helper.
import { createHash } from "node:crypto";
import { OpsReject, redact } from "./protocol.ts";

export { OpsReject, redact };

export const WS_SOCKET_PATH = "/run/orbit-ops-ws.sock";
export const WS_MAX_REQUEST_BYTES = 4096;
export const WS_MAX_RESPONSE_BYTES = 16 * 1024;

export const WS_MUTATING_ACTIONS = ["ws_setup", "ws_revoke"] as const;
export const WS_ACTIONS = ["ws_status", ...WS_MUTATING_ACTIONS, "op_status"] as const;
export type WsMutatingAction = (typeof WS_MUTATING_ACTIONS)[number];
export type WsAction = (typeof WS_ACTIONS)[number];

// 40 hex characters, so it passes redaction like a commit id. Derived from ORBIT's proposal id: the same confirmation always maps to
// the same operation, which the helper never runs twice.
export const OP_ID = /^[0-9a-f]{40}$/;
export function opIdFor(proposalId: string): string {
  return createHash("sha256").update(`orbit-ops-ws:${proposalId}`).digest("hex").slice(0, 40);
}

// The plan key: the first 24 hex characters of a SHA-256 over the canonical JSON of the steps that are still to do (id plus the exact
// action text shown on the owner's card). 24, not 64, because the shared redactor blanks long hex strings (as in tier 3).
export const PLAN_KEY = /^[0-9a-f]{24}$/;
export function planKeyOf(steps: readonly { id: string; state: string; action: string }[]): string {
  const todo = steps.filter((s) => s.state === "todo").map((s) => ({ id: s.id, action: s.action }));
  return createHash("sha256").update(JSON.stringify(todo)).digest("hex").slice(0, 24);
}

// ---- what ws_status shows (and what an owner's card is built from) ----

export type StepState = "done" | "todo" | "blocked";
export type PlanStep = { id: string; title: string; state: StepState; action: string; detail: string };
// A host-wide condition this helper never changes. It does not stop setup; it keeps sandboxed exec unavailable until an operator
// resolves it with a separate, explicit approval.
export type Blocker = { id: string; detail: string };
export type Plan = { steps: PlanStep[]; blockers: Blocker[]; planKey: string };

export type WsRequest =
  | { action: "ws_status" }
  | { action: "ws_setup"; opId: string; planKey: string }
  | { action: "ws_revoke"; opId: string }
  | { action: "op_status"; opId: string };

const KEYS: Record<WsAction, readonly string[]> = {
  ws_status: ["action"],
  ws_setup: ["action", "opId", "planKey"],
  ws_revoke: ["action", "opId"],
  op_status: ["action", "opId"],
};

// Strict: a JSON object with exactly the keys the action takes. Unknown actions, unknown or missing keys and wrong shapes are refused;
// nothing is coerced.
export function parseWsRequest(raw: string): WsRequest {
  if (Buffer.byteLength(raw) > WS_MAX_REQUEST_BYTES) throw new OpsReject("request_too_large", `Request is larger than ${WS_MAX_REQUEST_BYTES} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OpsReject("bad_request", "Request is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OpsReject("bad_request", "Request must be a JSON object.");
  const obj = value as Record<string, unknown>;
  if (!Object.hasOwn(obj, "action") || typeof obj.action !== "string") throw new OpsReject("bad_request", "Request needs {action: string}.");
  if (!(WS_ACTIONS as readonly string[]).includes(obj.action)) throw new OpsReject("unknown_action", "Unknown action.");
  const action = obj.action as WsAction;
  const allowed = KEYS[action];
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new OpsReject("bad_arguments", `Unexpected argument for ${action}.`);
  if (action === "ws_status") return { action };
  if (typeof obj.opId !== "string" || !OP_ID.test(obj.opId)) throw new OpsReject("bad_arguments", "opId must be 40 lowercase hex characters.");
  if (action !== "ws_setup") return { action, opId: obj.opId };
  if (typeof obj.planKey !== "string" || !PLAN_KEY.test(obj.planKey)) throw new OpsReject("bad_arguments", "planKey must be 24 lowercase hex characters.");
  return { action, opId: obj.opId, planKey: obj.planKey };
}

// ---- operation records: one JSON file per operation under the helper's state directory ----

export const WS_OP_STATES = ["accepted", "running", "verified", "no_change", "failed", "interrupted"] as const;
export type WsOpState = (typeof WS_OP_STATES)[number];
export const WS_TERMINAL_STATES: readonly WsOpState[] = ["verified", "no_change", "failed", "interrupted"];
export const isWsTerminal = (s: string): boolean => (WS_TERMINAL_STATES as readonly string[]).includes(s);

export type WsStep = { at: string; step: string; detail: string };
export type WsRecord = {
  opId: string;
  action: WsMutatingAction;
  state: WsOpState;
  acceptedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  // ws_setup: the plan key the owner confirmed, and the step ids that were to do when it was accepted.
  planKey?: string;
  todo?: string[];
  // Host-wide blockers seen at acceptance (ids). They never stop setup; the summary repeats them.
  blockers?: string[];
  // Set by the runner just before it starts the package unit; read by that unit as its authorization to run apt-get once.
  pkgRequested?: boolean;
  pkgResult?: "installed" | "already_present" | "busy" | "failed";
  steps: WsStep[];
  // The plan step that failed (or "plan" when the runner refused before changing anything), and a short refusal code.
  failedStep?: string;
  code?: string;
  // Set only from what the runner itself observed afterwards: never from dispatch or from a command's exit status alone.
  verification?: { checked: boolean; healthy?: boolean; planComplete?: boolean; expectedCommit?: string; servedCommit?: string; detail: string };
  summary?: string;
};

export type WsResponse = { ok: true; action: WsAction; data: unknown } | { ok: false; action?: string; error: { code: string; message: string } };

export const STEP_LIMIT = 64;
export const DETAIL_CHARS = 200;
export const SUMMARY_CHARS = 600;
export const cap = (text: string, n: number): string => {
  const clean = redact(text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim());
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
};
