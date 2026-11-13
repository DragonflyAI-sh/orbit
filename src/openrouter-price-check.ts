// Offline check of ORBIT's configured OpenRouter prices against a saved copy of OpenRouter's public
// GET /api/v1/models/<id>/endpoints response. It reads data only: no network, no key, no ledger. It answers one question for the
// owner before activation (B10, price rehearsal): does the reservation bound in src/openrouter.ts stay an upper bound for every
// provider endpoint that `provider.max_price` could let through?
//
// Conservative on purpose. OpenRouter's docs do not say whether max_price is compared with an endpoint's base price or with the
// price of the time window in force (pricing.overrides), so an endpoint counts as admitted only when its base price AND every override
// price are within the configured prices; an endpoint whose base price is within them but some window is not is a blocker.
import { MAX_REQUEST_BYTES } from "./openrouter.ts";

// Price keys the reservation bound covers: prompt and completion. input_cache_read is covered when it is not above the prompt price
// ORBIT reserves (a cached token is still an input token). Anything else that is non-zero is a cost the bound does not include.
const COVERED = new Set(["prompt", "completion", "input_cache_read"]);
const NOT_PRICES = new Set(["discount", "overrides"]);
// Fees that apply to a text-only, no-web-search request if they are non-zero: the bound does not include them.
const UNBOUNDED_FEES = new Set(["request", "internal_reasoning", "input_cache_write", "web_search"]);
// Fees for inputs ORBIT never sends (images, audio): reported, not blocking.
const UNUSED_INPUT_FEES = new Set(["image", "audio", "input_audio", "image_output", "audio_output"]);
const KNOWN_CONDITIONS = new Set(["min_prompt_tokens", "utc_start", "utc_end", "utc_days"]);

export type PriceCheckInput = {
  priceIn: number; // USD per million tokens, as ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK
  priceOut: number; // USD per million tokens, as ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK
  maxOutputTokens: number; // as ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS
};

export type EndpointVerdict = {
  tag: string;
  maxPromptPerMtok: number; // highest prompt price over the base price and every override window
  maxCompletionPerMtok: number;
  admitted: boolean; // every window within the configured prices
  maxCompletionTokens: number | undefined;
  tools: boolean;
};

export type PriceCheck = {
  model: string;
  ok: boolean; // no blockers and at least one admitted endpoint
  admitted: EndpointVerdict[];
  excluded: EndpointVerdict[];
  blockers: string[];
  warnings: string[];
  // The reservation for the largest request ORBIT will send, as src/openrouter.ts computes it.
  boundPerCallUsd: number;
  // What one call could cost under max_price if a provider did NOT count reasoning tokens against max_tokens (OpenRouter's docs say
  // they count "on most providers"): largest request in, the highest admitted endpoint's own output limit out.
  worstIfReasoningUncappedUsd: number;
};

const perMtok = (v: unknown): number | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
};
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function checkPrices(endpointsJson: unknown, cfg: PriceCheckInput): PriceCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const root = (endpointsJson as { data?: unknown })?.data ?? endpointsJson;
  const model = String((root as { id?: unknown })?.id ?? "(unknown)");
  const list = (root as { endpoints?: unknown })?.endpoints;
  const verdicts: EndpointVerdict[] = [];
  if (!Array.isArray(list) || list.length === 0) blockers.push("The file has no endpoints list: nothing can be checked.");
  for (const raw of Array.isArray(list) ? list : []) {
    const e = raw as Record<string, unknown>;
    const tag = String(e.tag ?? e.provider_name ?? "(no tag)");
    const pricing = (e.pricing ?? {}) as Record<string, unknown>;
    const windows: Record<string, unknown>[] = [pricing];
    const overrides = Array.isArray(pricing.overrides) ? (pricing.overrides as Record<string, unknown>[]) : [];
    for (const o of overrides) {
      const unknown = Object.keys(o).filter((k) => !KNOWN_CONDITIONS.has(k) && perMtok(o[k]) === undefined);
      if (unknown.length) blockers.push(`${tag}: a price override has a condition ORBIT does not know (${unknown.join(", ")}).`);
      if ("min_prompt_tokens" in o) warnings.push(`${tag}: long-context pricing above ${String(o.min_prompt_tokens)} prompt tokens (included in the maxima below).`);
      windows.push(o);
    }
    let maxIn = 0;
    let maxOut = 0;
    let priced = true;
    for (const w of windows) {
      for (const [k, v] of Object.entries(w)) {
        if (NOT_PRICES.has(k) || KNOWN_CONDITIONS.has(k)) continue;
        const p = perMtok(v);
        if (p === undefined) {
          if (w === pricing) blockers.push(`${tag}: price ${k} is not a number.`);
          continue;
        }
        if (k === "prompt") maxIn = Math.max(maxIn, p);
        else if (k === "completion") maxOut = Math.max(maxOut, p);
        else if (k === "input_cache_read") {
          if (p > cfg.priceIn) blockers.push(`${tag}: cached-input price ${round6(p)} per M is above the configured input price.`);
        } else if (p > 0 && UNBOUNDED_FEES.has(k)) blockers.push(`${tag}: non-zero ${k} fee; the reservation bound does not include it.`);
        else if (p > 0 && UNUSED_INPUT_FEES.has(k)) warnings.push(`${tag}: ${k} fee (ORBIT sends no such input).`);
        else if (p > 0 && !COVERED.has(k)) blockers.push(`${tag}: unknown non-zero price key ${k}.`);
      }
      if (w === pricing && (perMtok(w.prompt) === undefined || perMtok(w.completion) === undefined)) priced = false;
    }
    if (!priced) blockers.push(`${tag}: no prompt or completion price.`);
    const basePrompt = perMtok(pricing.prompt) ?? Infinity;
    const baseCompletion = perMtok(pricing.completion) ?? Infinity;
    const admitted = priced && maxIn <= cfg.priceIn && maxOut <= cfg.priceOut;
    if (!admitted && basePrompt <= cfg.priceIn && baseCompletion <= cfg.priceOut)
      blockers.push(`${tag}: base price is within the configured prices but a time or context window is not (${round6(maxIn)} / ${round6(maxOut)} per M); whether max_price uses the window price is not documented.`);
    const sp = Array.isArray(e.supported_parameters) ? (e.supported_parameters as unknown[]) : [];
    const mct = typeof e.max_completion_tokens === "number" ? e.max_completion_tokens : undefined;
    verdicts.push({ tag, maxPromptPerMtok: round6(maxIn), maxCompletionPerMtok: round6(maxOut), admitted, maxCompletionTokens: mct, tools: sp.includes("tools") });
  }
  const admitted = verdicts.filter((v) => v.admitted);
  const excluded = verdicts.filter((v) => !v.admitted);
  if (verdicts.length && !admitted.length) blockers.push("No endpoint is within the configured prices: every call would be refused by max_price.");
  for (const v of admitted) {
    if (!v.tools) warnings.push(`${v.tag}: admitted but does not list tools support.`);
    if (v.maxCompletionTokens !== undefined && v.maxCompletionTokens < cfg.maxOutputTokens) warnings.push(`${v.tag}: output limit ${v.maxCompletionTokens} is below max_tokens ${cfg.maxOutputTokens}.`);
  }
  const maxTokensIn = MAX_REQUEST_BYTES + 64;
  const boundPerCallUsd = round6((maxTokensIn * cfg.priceIn + cfg.maxOutputTokens * cfg.priceOut) / 1_000_000);
  const largestOut = Math.max(cfg.maxOutputTokens, ...admitted.map((v) => v.maxCompletionTokens ?? 0));
  const worstIfReasoningUncappedUsd = round6((maxTokensIn * cfg.priceIn + largestOut * cfg.priceOut) / 1_000_000);
  return { model, ok: blockers.length === 0 && admitted.length > 0, admitted, excluded, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], boundPerCallUsd, worstIfReasoningUncappedUsd };
}
