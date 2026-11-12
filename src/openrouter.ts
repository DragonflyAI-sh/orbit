import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderError } from "./chatgpt.ts";
import { instructions } from "./model.ts";
import type { Item, Step, ToolCall, ToolDef } from "./model.ts";
import { SpendError, toMicro } from "./spend-ledger.ts";
import type { SpendLedger } from "./spend-ledger.ts";

// OpenRouter as a paid, explicitly identified fallback behind the ChatGPT token-sharing model. This file is only the client: when to use
// it is src/fallback.ts, and the money rules are src/spend-ledger.ts. docs/openrouter-fallback.md describes the whole feature.

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_DAILY_CAP_USD = 5;
export const DEFAULT_TOTAL_CAP_USD = 150;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const HARD_MAX_OUTPUT_TOKENS = 8192;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_REQUEST_BYTES = 300_000;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_REPLY_CHARS = 32_000;
export const MAX_TOOL_CALLS = 8;
export const BALANCE_EVERY_MS = 10 * 60_000;

const MODEL_ID = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*(:[a-z0-9_-]+)?$/;
// Suffixes that change what is billed or where the call goes (web search, routing by speed). Never accepted.
const BILLABLE_SUFFIX = /:(online|nitro|floor|exacto|extended)$/;

export type OpenRouterConfig =
  | { state: "disabled"; reason: string }
  | { state: "unavailable"; reason: string }
  | {
      state: "ready";
      key: string;
      model: string;
      // USD per million tokens. Both are required: there is no default price.
      priceIn: number;
      priceOut: number;
      maxOutputTokens: number;
      timeoutMs: number;
      dailyCapUsd: number;
      totalCapUsd: number;
    };

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// Reads the settings and the root-only credential orbit.openrouter. Never throws and never returns the key anywhere but in `key`.
// Anything missing or wrong is "unavailable" with a reason that is safe to show; the fallback then does nothing.
export function openrouterConfig(env: NodeJS.ProcessEnv, readKey: (dir: string) => string = (d) => readFileSync(join(d, "orbit.openrouter"), "utf8")): OpenRouterConfig {
  const on = (env.ORBIT_OPENROUTER_ENABLED ?? "").trim().toLowerCase();
  if (on !== "1" && on !== "true") return { state: "disabled", reason: "The OpenRouter fallback is disabled (ORBIT_OPENROUTER_ENABLED is not 1)." };
  const bad = (reason: string): OpenRouterConfig => ({ state: "unavailable", reason });
  const model = (env.ORBIT_OPENROUTER_MODEL ?? "").trim();
  if (!model) return bad("ORBIT_OPENROUTER_MODEL is not set. There is no default model.");
  if (!MODEL_ID.test(model) || BILLABLE_SUFFIX.test(model)) return bad("ORBIT_OPENROUTER_MODEL must be a plain OpenRouter model id like vendor/name, without a routing or web-search suffix.");
  const priceIn = num(env.ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK);
  const priceOut = num(env.ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK);
  if (priceIn === undefined || priceOut === undefined) return bad("The model's price is not set (ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK and ..._OUT_...). Spend cannot be bounded without it.");
  for (const p of [priceIn, priceOut]) if (!(p > 0) || p > 1000) return bad("The model price must be a positive number of USD per million tokens, at most 1000.");
  const maxOut = num(env.ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOut) || maxOut < 16 || maxOut > HARD_MAX_OUTPUT_TOKENS) return bad(`ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS must be a whole number from 16 to ${HARD_MAX_OUTPUT_TOKENS}.`);
  const timeoutMs = num(env.ORBIT_OPENROUTER_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) return bad("ORBIT_OPENROUTER_TIMEOUT_MS must be a whole number from 1000 to 120000.");
  const dailyCapUsd = num(env.ORBIT_OPENROUTER_DAILY_CAP_USD) ?? DEFAULT_DAILY_CAP_USD;
  const totalCapUsd = num(env.ORBIT_OPENROUTER_TOTAL_CAP_USD) ?? DEFAULT_TOTAL_CAP_USD;
  if (!(dailyCapUsd > 0) || !(totalCapUsd > 0) || dailyCapUsd > totalCapUsd) return bad("The spend caps must be positive and the daily cap cannot exceed the lifetime cap.");
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return bad("No credential directory: the orbit.openrouter credential cannot be read.");
  let key = "";
  try {
    key = readKey(dir).trim();
  } catch {
    // Absent or unreadable is the same to the caller.
  }
  if (!key) return bad("The orbit.openrouter credential is not installed.");
  return { state: "ready", key, model, priceIn, priceOut, maxOutputTokens: maxOut, timeoutMs, dailyCapUsd, totalCapUsd };
}

// Replaces the key and anything shaped like an OpenRouter key, and cuts the text. Provider error text reaches the page, the thread
// store and the log, so it is cleaned here, once.
export function sanitize(text: string, key: string, max = 200): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (key) out = out.split(key).join("[key]");
  out = out.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "[key]").replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [token]");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

type Fetch = typeof fetch;
type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: null; tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

// Responses-style items to chat-completions messages. Consecutive function calls become one assistant message, as the API expects.
export function toMessages(system: string, input: Item[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const it of input) {
    if ("role" in it) out.push({ role: it.role, content: it.content });
    else if (it.type === "function_call") {
      const call = { id: it.call_id, type: "function" as const, function: { name: it.name, arguments: it.arguments } };
      const last = out.at(-1);
      if (last && last.role === "assistant" && "tool_calls" in last) last.tool_calls.push(call);
      else out.push({ role: "assistant", content: null, tool_calls: [call] });
    } else out.push({ role: "tool", tool_call_id: it.call_id, content: it.output });
  }
  return out;
}

export type PaidStep = Step & { costUsd: number | undefined; model: string };

export type OpenRouterClient = {
  readonly model: string;
  step(input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[]): Promise<PaidStep>;
  // The key's own limits and use as OpenRouter reports them. This is the account/key view, NOT the local allowance.
  balance(): Promise<{ limitUsd: number | null; remainingUsd: number | null; usedUsd: number | null }>;
};

export function openrouterClient(cfg: Extract<OpenRouterConfig, { state: "ready" }>, ledger: SpendLedger, fetcher: Fetch = fetch): OpenRouterClient {
  const fail = (message: string, kind: ConstructorParameters<typeof ProviderError>[0] = "failed") => new ProviderError(kind, `OpenRouter: ${sanitize(message, cfg.key)}`);
  const headers = { authorization: `Bearer ${cfg.key}`, "content-type": "application/json", "x-title": "ORBIT" };

  const readBody = async (res: Response): Promise<string> => {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw fail("the response was too large and was discarded");
    return text;
  };

  return {
    model: cfg.model,

    async step(input, limits, notes, tools) {
      const system = instructions(limits, notes, tools.map((t) => `${t.name}: ${t.description}`));
      const body = JSON.stringify({
        model: cfg.model,
        messages: toMessages(system, input),
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" } : {}),
        // Every billable lever is pinned: output length, the provider's price ceiling, no web search or plugins, no routing to
        // another model, no provider that keeps or trains on the data, and the cost reported back.
        max_tokens: cfg.maxOutputTokens,
        stream: false,
        temperature: 0.2,
        usage: { include: true },
        provider: { max_price: { prompt: cfg.priceIn, completion: cfg.priceOut }, data_collection: "deny", allow_fallbacks: false },
      });
      const bytes = Buffer.byteLength(body);
      if (bytes > MAX_REQUEST_BYTES) throw fail(`the conversation is too long to send (${bytes} bytes; the limit is ${MAX_REQUEST_BYTES})`);
      // Upper bound on tokens in: no tokenizer produces more than one token per byte. Out: max_tokens, which covers reasoning too.
      // USD per million tokens is micro-USD per token.
      const bound = toMicro((bytes + 64) * cfg.priceIn / 1_000_000 + cfg.maxOutputTokens * cfg.priceOut / 1_000_000);
      let reservation: { id: string; micro: number };
      try {
        reservation = ledger.reserve(bound);
      } catch (err) {
        throw err instanceof SpendError ? err : fail("spend accounting failed");
      }

      let res: Response;
      try {
        res = await fetcher(`${OPENROUTER_BASE}/chat/completions`, { method: "POST", headers, body, signal: AbortSignal.timeout(cfg.timeoutMs) });
      } catch (err) {
        // The request may have reached OpenRouter and been billed: its bound stays charged.
        ledger.settle(reservation.id, undefined, "no answer (timeout or network): the request may have been billed");
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw fail(timedOut ? `no answer within ${cfg.timeoutMs / 1000} s` : "the request failed before an answer arrived");
      }

      let text: string;
      try {
        text = await readBody(res);
      } catch (err) {
        ledger.settle(reservation.id, undefined, "response unreadable");
        throw err;
      }
      let json: { error?: { message?: string; code?: unknown }; choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: { cost?: unknown } } | undefined;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const costOf = (): number | undefined => {
        const c = json?.usage?.cost;
        return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : undefined;
      };

      if (!res.ok || json?.error) {
        const status = res.status;
        const said = sanitize(json?.error?.message ?? "", cfg.key);
        // A refusal before any work (auth, bad request, rate limit) is not billed; a server error is unknown.
        if (status === 401 || status === 402 || status === 403 || status === 400 || status === 404 || status === 429) ledger.release(reservation.id);
        else ledger.settle(reservation.id, costOf() === undefined ? undefined : toMicro(costOf()!), `HTTP ${status}, cost unknown`);
        throw fail(`HTTP ${status}${said ? `: ${said}` : ""}`);
      }

      // A good response: charge what the provider says it cost. No cost reported means the bound stays charged.
      const cost = costOf();
      ledger.settle(reservation.id, cost === undefined ? undefined : toMicro(cost), "provider reported no cost");
      const choice = json?.choices?.[0];
      const message = choice?.message;
      if (!message) throw fail("the response had no message");
      const calls: ToolCall[] = (message.tool_calls ?? [])
        .filter((c) => c.id && c.function?.name)
        .map((c) => ({ call_id: String(c.id), name: String(c.function!.name), arguments: c.function!.arguments ?? "{}" }));
      if (calls.length > MAX_TOOL_CALLS) throw fail(`the model asked for ${calls.length} tool calls at once; the limit is ${MAX_TOOL_CALLS}`);
      // A reply cut off by the length limit may carry half a tool call: it is never run.
      if (choice?.finish_reason === "length" && calls.length) throw fail("the reply hit the output limit in the middle of a tool call, so no tool was run");
      const content = typeof message.content === "string" ? message.content.slice(0, MAX_REPLY_CHARS) : "";
      if (!content && !calls.length) throw fail(`the response had no text and no tool call${choice?.finish_reason ? ` (finish: ${sanitize(choice.finish_reason, cfg.key, 40)})` : ""}`);
      return { text: content, calls, costUsd: cost, model: cfg.model };
    },

    async balance() {
      const res = await fetcher(`${OPENROUTER_BASE}/key`, { headers, signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 15_000)) });
      if (!res.ok) throw fail(`balance lookup returned HTTP ${res.status}`);
      const d = ((JSON.parse(await readBody(res)) as { data?: { limit?: unknown; limit_remaining?: unknown; usage?: unknown } }).data ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return { limitUsd: n(d.limit), remainingUsd: n(d.limit_remaining), usedUsd: n(d.usage) };
    },
  };
}
