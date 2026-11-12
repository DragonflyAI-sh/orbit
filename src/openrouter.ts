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
// Error bodies and the key/balance body are small by nature: they get a much smaller bound than a completion.
export const MAX_ERROR_BODY_BYTES = 64_000;
export const MAX_BALANCE_BODY_BYTES = 32_000;
export const MAX_REPLY_CHARS = 32_000;
export const MAX_TOOL_CALLS = 8;
// Largest cap accepted: far above any sane value, far below the ledger's integer range (2^53 micro-USD is about 9.0e9 USD).
export const MAX_CAP_USD = 10_000;
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
  if (dailyCapUsd > MAX_CAP_USD || totalCapUsd > MAX_CAP_USD) return bad(`The spend caps must be at most ${MAX_CAP_USD} USD.`);
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

// Why a bounded read stopped before the whole body was in memory.
export class ReadLimit extends Error {
  readonly why: "size" | "time" | "stream";
  constructor(why: "size" | "time" | "stream") {
    super(`response read stopped: ${why}`);
    this.why = why;
  }
}

// Reads a response body into memory without ever holding more than `maxBytes` (+ one chunk) of it, and stops when `signal` aborts.
// Content-Length is only a shortcut to refuse early: it can be absent or wrong, so the bytes actually received are counted. On any stop
// the stream is cancelled, so the connection is released and nothing keeps downloading. Nothing from the body is put into the error.
export async function readBounded(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  const body = res.body;
  if (res.headers.get("content-length") !== null && Number.isFinite(declared) && declared > maxBytes) {
    void body?.cancel().catch(() => {});
    throw new ReadLimit("size");
  }
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ReadLimit("time"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ReadLimit("size");
      chunks.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err instanceof ReadLimit ? err : new ReadLimit("stream");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Finish reasons that mean the model ended normally. `length` (output limit), `content_filter` and `error` are known not to; any other
// value is reported to the owner as unrecognised, never as a clean stop.
const NORMAL_FINISH = new Set(["stop", "tool_calls", "function_call"]);
const CUT_FINISH = new Set(["length", "content_filter", "error"]);

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
  // `accounting` is carried on the error as data; the owner-visible message also names it, built here once from that data.
  // ProviderError builds the owner-visible "Spend accounting" sentence itself, once, from this list.
  const fail = (message: string, kind: ConstructorParameters<typeof ProviderError>[0] = "failed", accounting: string[] = []) =>
    new ProviderError(kind, `OpenRouter: ${sanitize(message, cfg.key)}`, undefined, undefined, accounting);
  const headers = { authorization: `Bearer ${cfg.key}`, "content-type": "application/json", "x-title": "ORBIT" };

  // Ledger writes on an error path must never hide the original problem. A failed write is returned as a diagnostic, never thrown.
  const ACCOUNTING_FAILED = "the ledger could not record this call; it stays reserved until ORBIT restarts, then is charged at its upper bound";
  const safely = (fn: () => void): string[] => {
    try {
      fn();
      return [];
    } catch {
      return [ACCOUNTING_FAILED];
    }
  };

  const whyUnread = (err: unknown, what: string, ms: number): string => {
    const why = err instanceof ReadLimit ? err.why : "stream";
    return why === "size" ? `${what} was too large and was discarded` : why === "time" ? `${what} did not arrive within ${ms / 1000} s` : `${what} could not be read`;
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

      // One deadline covers the request and reading the whole body, so a provider that sends headers and then stalls cannot hold the turn.
      const signal = AbortSignal.timeout(cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetcher(`${OPENROUTER_BASE}/chat/completions`, { method: "POST", headers, body, signal });
      } catch (err) {
        // The request may have reached OpenRouter and been billed: its bound stays charged.
        const note = safely(() => ledger.settle(reservation.id, undefined, "no answer (timeout or network): the request may have been billed"));
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw fail(timedOut ? `no answer within ${cfg.timeoutMs / 1000} s` : "the request failed before an answer arrived", "failed", note);
      }

      // Bounded before anything is buffered or parsed. A refusal (non-2xx) body is small; a completion body has its own larger bound.
      let text = "";
      let bodyProblem: string | undefined;
      try {
        text = await readBounded(res, res.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES, signal);
      } catch (err) {
        bodyProblem = whyUnread(err, res.ok ? "the response" : "the error body", cfg.timeoutMs);
        if (res.ok) {
          // A 2xx answer that cannot be read may have been billed: its bound stays charged and nothing is retried.
          const note = safely(() => ledger.settle(reservation.id, undefined, "response unreadable"));
          throw fail(bodyProblem, "failed", note);
        }
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
        const note =
          status === 401 || status === 402 || status === 403 || status === 400 || status === 404 || status === 429
            ? safely(() => ledger.release(reservation.id))
            : safely(() => ledger.settle(reservation.id, costOf() === undefined ? undefined : toMicro(costOf()!), `HTTP ${status}, cost unknown`));
        throw fail(`HTTP ${status}${said ? `: ${said}` : ""}${bodyProblem ? ` (${bodyProblem})` : ""}`, "failed", note);
      }

      // A good response: charge what the provider says it cost. No cost reported means the bound stays charged.
      const cost = costOf();
      // A billed answer is not thrown away because the ledger write failed: it is returned with the failure as structured `accounting`
      // (also when the answer is only tool calls), and the reservation stays outstanding (charged at its bound after a restart).
      const settleNote = safely(() => ledger.settle(reservation.id, cost === undefined ? undefined : toMicro(cost), "provider reported no cost"));
      const choice = json?.choices?.[0];
      const message = choice?.message;
      if (!message) throw fail("the response had no message", "failed", settleNote);
      const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const calls: ToolCall[] = rawCalls
        .filter((c) => c && c.id && c.function?.name)
        .map((c) => ({ call_id: String(c.id), name: String(c.function!.name), arguments: c.function!.arguments ?? "{}" }));
      if (calls.length > MAX_TOOL_CALLS) throw fail(`the model asked for ${calls.length} tool calls at once; the limit is ${MAX_TOOL_CALLS}`, "failed", settleNote);
      const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
      // A reply cut off (output limit, content filter, error) may carry half a tool call: it is never run, whatever its arguments look like.
      if (finish !== undefined && CUT_FINISH.has(finish) && (calls.length || rawCalls.length)) {
        throw fail(`the reply ended early (finish: ${sanitize(finish, cfg.key, 40)}) in the middle of a tool call, so no tool was run`, "failed", settleNote);
      }
      const full = typeof message.content === "string" ? message.content : "";
      const content = full.slice(0, MAX_REPLY_CHARS);
      if (!content && !calls.length) throw fail(`the response had no text and no tool call${finish ? ` (finish: ${sanitize(finish, cfg.key, 40)})` : ""}`, "failed", settleNote);
      // Completeness notes are their own structured list, apart from spend accounting and never part of the text or of a tool argument,
      // so they cannot reach a later model request or change what a tool runs. A normal stop adds nothing.
      const incomplete: string[] = [];
      if (finish !== undefined && CUT_FINISH.has(finish)) incomplete.push(finish === "length" ? "The reply was cut off at the output limit (finish: length); it may be incomplete." : `The provider ended the reply early (finish: ${sanitize(finish, cfg.key, 40)}); it may be incomplete.`);
      else if (finish !== undefined && !NORMAL_FINISH.has(finish)) incomplete.push(`The provider gave an unrecognised finish reason (${sanitize(finish, cfg.key, 40)}), not a normal stop; the reply may be incomplete.`);
      if (full.length > content.length) incomplete.push(`ORBIT shortened the reply to ${MAX_REPLY_CHARS} characters.`);
      if (rawCalls.length > calls.length) incomplete.push(`${rawCalls.length - calls.length} tool call(s) from the model had no id or name and were dropped; nothing was run for them.`);
      return { text: content, calls, costUsd: cost, model: cfg.model, ...(settleNote.length ? { accounting: settleNote } : {}), ...(incomplete.length ? { incomplete } : {}) };
    },

    async balance() {
      const timeoutMs = Math.min(cfg.timeoutMs, 15_000);
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetcher(`${OPENROUTER_BASE}/key`, { headers, signal });
      if (!res.ok) {
        // The error body is not read at all: only the status is reported. Cancel it so the connection is released.
        void res.body?.cancel().catch(() => {});
        throw fail(`balance lookup returned HTTP ${res.status}`);
      }
      let parsed: { data?: Record<string, unknown> } | null;
      try {
        parsed = JSON.parse(await readBounded(res, MAX_BALANCE_BODY_BYTES, signal));
      } catch (err) {
        throw fail(err instanceof ReadLimit ? whyUnread(err, "the balance body", timeoutMs) : "balance lookup returned an unreadable body");
      }
      const d = (parsed && typeof parsed === "object" && parsed.data && typeof parsed.data === "object" ? parsed.data : {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return { limitUsd: n(d.limit), remainingUsd: n(d.limit_remaining), usedUsd: n(d.usage) };
    },
  };
}
