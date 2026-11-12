import { randomUUID } from "node:crypto";
import type { FallbackInfo, Item, ModelPort, ToolDef } from "./model.ts";
import type { MutatingAction } from "./ops/admin-protocol.ts";
import type { SysMutatingAction } from "./ops/sys-protocol.ts";
import type { Result } from "./ports.ts";

// Tool use inside a chat reply. The model may call ChatTools; every call is checked by `allow` (ORBIT's policy)
// before it runs, and the reply lists every call with where its result came from.

export const MAX_ROUNDS = 5;
export const MAX_OUTPUT_CHARS = 8000;

export type ChatTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<Result<unknown>>;
};

export type CallRecord = {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  provenance?: "live" | "mock";
  source?: string;
  // Short, human-readable outcome; the model saw the full result.
  summary: string;
};

// `fallback` is set when any round was answered by the OpenRouter fallback; `mixed` when other rounds of the same reply came from the primary.
export type ChatOutcome = { text: string; calls: CallRecord[]; rounds: number; capped: boolean; fallback?: FallbackInfo; mixed?: boolean };

const def = (t: ChatTool): ToolDef => ({ name: t.name, description: t.description, parameters: t.parameters });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);

export async function runChat(options: {
  model: ModelPort;
  messages: Item[];
  limits: string[];
  notes?: string;
  tools: ChatTool[];
  // Policy hook: returns an error string when the call is refused.
  allow?: (tool: string) => string | undefined;
  maxRounds?: number;
  // Called after each tool call has run, with exactly what the model is about to see. A thread stores it here, call by call,
  // so a later failure cannot lose the calls that already happened. A throw ends the turn.
  onCall?: (done: { call_id: string; name: string; arguments: string; output: string; record: CallRecord }) => void | Promise<void>;
}): Promise<ChatOutcome> {
  const { model, limits, notes, tools, allow } = options;
  const maxRounds = options.maxRounds ?? MAX_ROUNDS;
  if (!model.step) throw new Error("This model cannot call tools.");
  const byName = new Map(tools.map((t) => [t.name, t]));
  const input: Item[] = [...options.messages];
  const calls: CallRecord[] = [];
  let fallback: FallbackInfo | undefined;
  let primaryRounds = 0;
  const provenance = () => (fallback ? { fallback, ...(primaryRounds ? { mixed: true } : {}) } : {});

  for (let round = 0; ; round++) {
    const capped = round >= maxRounds;
    // At the cap the model gets no tools, so it has to answer with what it has.
    const step = await model.step(input, limits, notes, capped ? [] : tools.map(def));
    if (step.fallback) fallback = step.fallback;
    else primaryRounds += 1;
    if (!step.calls.length || capped) {
      const text =
        step.text ||
        (capped ? `I stopped after ${maxRounds} rounds of tool calls without reaching an answer. Calls made are listed below.` : "");
      return { text, calls, rounds: round, capped: capped && step.calls.length > 0, ...provenance() };
    }
    for (const call of step.calls) {
      input.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments });
      const { output, record } = await execute(call.name, call.arguments, byName, allow);
      calls.push(record);
      input.push({ type: "function_call_output", call_id: call.call_id, output });
      await options.onCall?.({ call_id: call.call_id, name: call.name, arguments: call.arguments, output, record });
    }
  }
}

async function execute(
  name: string,
  rawArgs: string,
  byName: Map<string, ChatTool>,
  allow?: (tool: string) => string | undefined,
): Promise<{ output: string; record: CallRecord }> {
  let args: Record<string, unknown> = {};
  const fail = (error: string) => ({
    output: JSON.stringify({ ok: false, error }),
    record: { name, args, ok: false, summary: error } as CallRecord,
  });
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("Arguments must be a JSON object.");
    args = parsed;
  } catch {
    return fail("Arguments were not valid JSON.");
  }
  const tool = byName.get(name);
  if (!tool) return fail(`No tool named ${name}.`);
  const refused = allow?.(name);
  if (refused) return fail(refused);
  try {
    const result = await tool.run(args);
    const body = JSON.stringify({ ok: true, provenance: result.provenance, source: result.source, result: result.value });
    return {
      output: clip(body, MAX_OUTPUT_CHARS),
      record: { name, args, ok: true, provenance: result.provenance, source: result.source, summary: clip(JSON.stringify(result.value) ?? "", 300) },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "tool failed");
  }
}

// Actions with effects outside the conversation wait here for a click on Confirm: launching a job, and
// steering one (a steered runner has push access, and tool results can carry text written by others).
// ops_admin is a server operation (restart, deploy, rollback, orbit.env change, vault refresh). The proposal carries what Rai is
// shown (a summary, masked settings) and a digest of the exact validated action and arguments; the arguments themselves stay with
// ORBIT's admin ledger (src/ops-admin.ts), so a proposal listing never holds a setting value in full.
export type ProposalAction =
  // `duplicates`: recent jobs whose brief matches this one (src/duplicates.ts). A warning only.
  | { kind: "job_launch"; routine: string; brief: string; context?: string[]; duplicates?: { job: string; similarity: number; state: string; launchedAt?: string }[] }
  | { kind: "job_steer"; job: string; text: string }
  | { kind: "ops_admin"; action: MutatingAction; summary: string; display: Record<string, string> | null; digest: string }
  // Tier 3 (OS updates, reboot, orbit-jobs Funnel): same shape, plus the impact and recovery warnings the owner must see.
  | { kind: "ops_sys"; action: SysMutatingAction; summary: string; display: Record<string, string>; warnings: string[]; digest: string }
  // A vault edit AGENTS.md section 4 protects. The exact validated edit stays with src/vault/tools.ts; the proposal carries what Rai
  // is shown, the reasons it needs him, and a digest of the exact edit and reasons.
  | { kind: "vault_edit"; action: string; summary: string; display: Record<string, string>; digest: string; reasons: string[] };
export type Proposal = ProposalAction & { id: string; createdAt: string; expiresAt: string };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 20;

export function proposals(now: () => Date = () => new Date()) {
  const open = new Map<string, Proposal>();
  const sweep = () => {
    for (const [id, p] of open) if (new Date(p.expiresAt) <= now()) open.delete(id);
  };
  return {
    propose(action: ProposalAction, ttlMs: number = PROPOSAL_TTL_MS): Proposal {
      sweep();
      while (open.size >= MAX_PROPOSALS) open.delete(open.keys().next().value!);
      const at = now();
      const p: Proposal = { ...action, id: randomUUID(), createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString() };
      open.set(p.id, p);
      return p;
    },
    // Looks without consuming (the confirm route checks the digest before it spends the proposal).
    peek(id: string): Proposal | undefined {
      sweep();
      return open.get(id);
    },
    // Removes the proposal: a confirm or a cancel can happen once.
    take(id: string): Proposal | undefined {
      sweep();
      const p = open.get(id);
      open.delete(id);
      return p;
    },
    list: () => (sweep(), [...open.values()]),
  };
}
export type Proposals = ReturnType<typeof proposals>;
