import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortStatus, Result } from "./ports.ts";

export type Message = { role: "user" | "assistant"; content: string };

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { call_id: string; name: string; arguments: string };
// Conversation items for the Responses API: chat turns plus function calls and their outputs.
export type Item =
  | Message
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };
export type Step = { text: string; calls: ToolCall[] };

export type ModelPort = {
  status(): PortStatus;
  // Periodic upkeep (renewing a login before it expires). Never throws; absent when there is nothing to maintain.
  maintain?(): Promise<void>;
  reply(messages: Message[], limits: string[], notes?: string): Promise<Result<string>>;
  // One model turn with tools offered. Absent when the model cannot call tools (the mock).
  step?(input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[]): Promise<Step>;
};

export function instructions(limits: string[], notes?: string, tooling?: string[]): string {
  return [
    "You are ORBIT (Operational Reasoning Bot for Intelligent Tasks), Rai's personal assistant.",
    "Be concise and technical. Never present a guess as fact.",
    "These parts of you are not connected yet, so you know nothing from them. Say so plainly when it matters:",
    ...limits.map((l) => `- ${l}`),
    ...(tooling?.length
      ? [
          "",
          "You can call these tools. Every call goes through ORBIT's owner and policy checks, and each result says where it came from:",
          ...tooling.map((t) => `- ${t}`),
          "Only say an action happened if its tool result says so. job_launch only proposes: Rai must click Confirm on the proposal before anything launches, so say it is waiting for his confirmation, never that it started. The same holds for every ops_propose_* tool (restart, deploy, rollback, config change, vault refresh): they only propose. After he confirms, an operation is only done when ops_admin_operations shows state verified; accepted or running is not verified, so never claim success on those.",
          "If a tool returns an error or is refused, report that plainly.",
        ]
      : []),
    ...(notes
      ? ["", "Excerpts from Rai's vault, the source of truth for his projects and commitments. Cite the note path. They may be partial:", notes]
      : []),
  ].join("\n");
}

export function mockModel(detail: string, now: () => Date = () => new Date()): ModelPort {
  return {
    status: () => ({ port: "model", state: "mock", impl: "mock-echo", detail, verifiedAt: now().toISOString() }),
    reply: async (messages, _limits, notes) => ({
      value: `Mock reply: no model is connected, so this is not a real answer. You said: "${messages.at(-1)?.content ?? ""}"${
        notes ? "\n\nMemory found these notes, which a real model would read:\n" + [...notes.matchAll(/^### (.+)$/gm)].map((m) => `- ${m[1]}`).join("\n") : ""
      }`,
      provenance: "mock",
      source: "model/mock-echo",
    }),
  };
}

type Fetch = typeof fetch;

type OutputItem = { type: string; content?: { type: string; text: string }[]; call_id?: string; name?: string; arguments?: string };

export function parseOutput(output: OutputItem[]): Step {
  return {
    text: output
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join(""),
    calls: output
      .filter((o) => o.type === "function_call" && o.call_id && o.name)
      .map((o) => ({ call_id: o.call_id!, name: o.name!, arguments: o.arguments ?? "{}" })),
  };
}

// The Responses API wants {type:"function", name, description, parameters}.
export const responsesTools = (tools: ToolDef[]) => tools.map((t) => ({ type: "function", ...t }));

export function openaiModel(model: string, key: string, fetcher: Fetch = fetch): ModelPort {
  let lastOk: string | undefined;
  let lastError: { at: string; detail: string } | undefined;
  const impl = `openai/${model}`;

  const request = async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[]): Promise<Step> => {
    const at = new Date().toISOString();
    try {
      const res = await fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: instructions(limits, notes, tools.map((t) => `${t.name}: ${t.description}`)),
          input,
          ...(tools.length ? { tools: responsesTools(tools) } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const step = parseOutput(((await res.json()) as { output?: OutputItem[] }).output ?? []);
      if (!step.text && !step.calls.length) throw new Error("response had no text");
      lastOk = at;
      return step;
    } catch (err) {
      lastError = { at, detail: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  };

  return {
    step: request,
    status: () => {
      if (lastError && (!lastOk || lastError.at > lastOk)) {
        return { port: "model", state: "down", impl, detail: `Last call failed: ${lastError.detail}`, verifiedAt: lastError.at };
      }
      if (lastOk) return { port: "model", state: "live", impl, detail: "Answering.", verifiedAt: lastOk };
      return { port: "model", state: "degraded", impl, detail: "Configured but not exercised yet.", verifiedAt: new Date(0).toISOString() };
    },
    reply: async (messages, limits, notes) => {
      const step = await request(messages, limits, notes, []);
      if (!step.text) throw new Error("response had no text");
      return { value: step.text, provenance: "live", source: `model/${impl}` };
    },
  };
}

// An OpenAI API key (systemd credential orbit.openai) wins; otherwise ORBIT signs in with ChatGPT like OpenClaw does.
export function selectModel(env: NodeJS.ProcessEnv, chatgpt?: (model: string) => ModelPort): ModelPort {
  const model = env.ORBIT_MODEL;
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!model) return mockModel("No model is configured (ORBIT_MODEL unset), so replies are mock.");
  try {
    const key = readFileSync(join(dir ?? "", "orbit.openai"), "utf8").trim();
    if (dir && key) return openaiModel(model, key);
  } catch {
    // No API key installed; fall through to ChatGPT sign-in.
  }
  if (chatgpt) return chatgpt(model);
  return mockModel(`ORBIT_MODEL is ${model} but no orbit.openai credential is installed, so replies are mock.`);
}
