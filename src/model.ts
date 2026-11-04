import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortStatus, Result } from "./ports.ts";

export type Message = { role: "user" | "assistant"; content: string };

export type ModelPort = {
  status(): PortStatus;
  reply(messages: Message[], limits: string[], notes?: string): Promise<Result<string>>;
};

export function instructions(limits: string[], notes?: string): string {
  return [
    "You are ORBIT (Operational Reasoning Bot for Intelligent Tasks), Rai's personal assistant.",
    "Be concise and technical. Never present a guess as fact.",
    "These parts of you are not connected yet, so you know nothing from them. Say so plainly when it matters:",
    ...limits.map((l) => `- ${l}`),
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

export function openaiModel(model: string, key: string, fetcher: Fetch = fetch): ModelPort {
  let lastOk: string | undefined;
  let lastError: { at: string; detail: string } | undefined;
  const impl = `openai/${model}`;

  return {
    status: () => {
      if (lastError && (!lastOk || lastError.at > lastOk)) {
        return { port: "model", state: "down", impl, detail: `Last call failed: ${lastError.detail}`, verifiedAt: lastError.at };
      }
      if (lastOk) return { port: "model", state: "live", impl, detail: "Answering.", verifiedAt: lastOk };
      return { port: "model", state: "degraded", impl, detail: "Configured but not exercised yet.", verifiedAt: new Date(0).toISOString() };
    },
    reply: async (messages, limits, notes) => {
      const at = new Date().toISOString();
      try {
        const res = await fetcher("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, instructions: instructions(limits, notes), input: messages }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { output?: { type: string; content?: { type: string; text: string }[] }[] };
        const text = (body.output ?? [])
          .filter((o) => o.type === "message")
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("");
        if (!text) throw new Error("response had no text");
        lastOk = at;
        return { value: text, provenance: "live", source: `model/${impl}` };
      } catch (err) {
        lastError = { at, detail: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    },
  };
}

// The key comes from a systemd credential (ImportCredential=orbit.*), never from the environment file.
export function selectModel(env: NodeJS.ProcessEnv): ModelPort {
  const model = env.ORBIT_MODEL;
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!model) return mockModel("No model is configured (ORBIT_MODEL unset), so replies are mock.");
  try {
    const key = readFileSync(join(dir ?? "", "orbit.openai"), "utf8").trim();
    if (!dir || !key) throw new Error("empty");
    return openaiModel(model, key);
  } catch {
    return mockModel(`ORBIT_MODEL is ${model} but no orbit.openai credential is installed, so replies are mock.`);
  }
}
