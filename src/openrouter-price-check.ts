// Offline check of ORBIT's configured OpenRouter prices against a saved copy of OpenRouter's public
// GET /api/v1/models/<id>/endpoints response. It reads data only: no network, no key, no ledger. It answers one question for the
// owner before activation (B10, price rehearsal): does the reservation bound in src/openrouter.ts stay an upper bound for every
// provider endpoint that `provider.max_price` could let through?
//
// Conservative on purpose. OpenRouter's docs do not say whether max_price is compared with an endpoint's base price or with the
// price of the time window in force (pricing.overrides), so an endpoint counts as admitted only when its base price AND every override
// price are within the configured prices; an endpoint whose base price is within them but some window is not is a blocker.
//
// Routing as ORBIT sends it: `provider.require_parameters: true`, so an endpoint that does not list every parameter ORBIT always sends
// (REQUIRED_PARAMS) is never routed to and is excluded here. Fee and price-shape blockers count only for endpoints that routing could
// actually reach (base price within the configured prices and every required parameter supported); an endpoint max_price or
// require_parameters already excludes cannot bill ORBIT, so it no longer blocks the whole model (PR #68 review, finding 1).
//
// The output side of the bound is ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS, not max_tokens: OpenRouter says reasoning counts against
// max_tokens only "on most providers". It must be at least the largest context_length and max_completion_tokens of every admitted
// endpoint (a generated token, reasoning or not, occupies the context window); a smaller value is a blocker.
import { MAX_REQUEST_BYTES, reservationUsd } from "./openrouter.ts";

// Parameters every ORBIT request carries (src/openrouter.ts). Tool turns add `tools` and `tool_choice`: an admitted endpoint without
// them is a warning (tool turns route elsewhere or are refused), not a blocker.
export const REQUIRED_PARAMS = ["max_tokens", "temperature", "reasoning"] as const;
const TOOL_PARAMS = ["tools", "tool_choice"] as const;

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
  outputBoundTokens: number; // as ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS
};

export type EndpointVerdict = {
  tag: string;
  maxPromptPerMtok: number; // highest prompt price over the base price and every override window
  maxCompletionPerMtok: number;
  admitted: boolean; // every window within the configured prices and every required parameter supported
  maxCompletionTokens: number | undefined;
  contextLength: number | undefined;
  tools: boolean; // lists both tools and tool_choice
  missingParams: string[]; // required parameters the endpoint does not list (require_parameters excludes it)
};

export type PriceCheck = {
  model: string;
  ok: boolean; // no blockers and at least one admitted endpoint
  admitted: EndpointVerdict[];
  excluded: EndpointVerdict[];
  blockers: string[];
  warnings: string[];
  // The reservation for the largest request ORBIT will send, as src/openrouter.ts computes it (output side: the output bound).
  boundPerCallUsd: number;
  // The smallest ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS that covers every admitted endpoint: the largest context_length or
  // max_completion_tokens among them. 0 when nothing is admitted.
  requiredOutputBoundTokens: number;
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
    // Problems of this endpoint's price data. They block the model only if routing could reach the endpoint (decided below).
    const own: string[] = [];
    const pricing = (e.pricing ?? {}) as Record<string, unknown>;
    const windows: Record<string, unknown>[] = [pricing];
    const overrides = Array.isArray(pricing.overrides) ? (pricing.overrides as Record<string, unknown>[]) : [];
    for (const o of overrides) {
      const unknown = Object.keys(o).filter((k) => !KNOWN_CONDITIONS.has(k) && perMtok(o[k]) === undefined);
      if (unknown.length) own.push(`${tag}: a price override has a condition ORBIT does not know (${unknown.join(", ")}).`);
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
          if (w === pricing) own.push(`${tag}: price ${k} is not a number.`);
          continue;
        }
        if (k === "prompt") maxIn = Math.max(maxIn, p);
        else if (k === "completion") maxOut = Math.max(maxOut, p);
        else if (k === "input_cache_read") {
          if (p > cfg.priceIn) own.push(`${tag}: cached-input price ${round6(p)} per M is above the configured input price.`);
        } else if (p > 0 && UNBOUNDED_FEES.has(k)) own.push(`${tag}: non-zero ${k} fee; the reservation bound does not include it.`);
        else if (p > 0 && UNUSED_INPUT_FEES.has(k)) warnings.push(`${tag}: ${k} fee (ORBIT sends no such input).`);
        else if (p > 0 && !COVERED.has(k)) own.push(`${tag}: unknown non-zero price key ${k}.`);
      }
      if (w === pricing && (perMtok(w.prompt) === undefined || perMtok(w.completion) === undefined)) priced = false;
    }
    const sp = Array.isArray(e.supported_parameters) ? (e.supported_parameters as unknown[]) : [];
    const missingParams = REQUIRED_PARAMS.filter((p) => !sp.includes(p));
    const basePrompt = perMtok(pricing.prompt) ?? Infinity;
    const baseCompletion = perMtok(pricing.completion) ?? Infinity;
    // Reachable: max_price lets the base price through (an unpriced endpoint counts as reachable: OpenRouter's handling of it is not
    // documented) and require_parameters does not exclude it.
    const reachable = (!priced || (basePrompt <= cfg.priceIn && baseCompletion <= cfg.priceOut)) && missingParams.length === 0;
    if (reachable) {
      blockers.push(...own);
      if (!priced) blockers.push(`${tag}: no prompt or completion price.`);
    }
    const admitted = priced && maxIn <= cfg.priceIn && maxOut <= cfg.priceOut && missingParams.length === 0;
    if (!admitted && reachable && priced)
      blockers.push(`${tag}: base price is within the configured prices but a time or context window is not (${round6(maxIn)} / ${round6(maxOut)} per M); whether max_price uses the window price is not documented.`);
    const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
    verdicts.push({
      tag,
      maxPromptPerMtok: round6(maxIn),
      maxCompletionPerMtok: round6(maxOut),
      admitted,
      maxCompletionTokens: int(e.max_completion_tokens),
      contextLength: int(e.context_length),
      tools: TOOL_PARAMS.every((p) => sp.includes(p)),
      missingParams,
    });
  }
  const admitted = verdicts.filter((v) => v.admitted);
  const excluded = verdicts.filter((v) => !v.admitted);
  if (verdicts.length && !admitted.length) blockers.push("No endpoint is within the configured prices and supports every required parameter: every call would be refused (max_price, require_parameters).");
  for (const v of admitted) {
    if (!v.tools) warnings.push(`${v.tag}: admitted but does not list both tools and tool_choice; tool turns will not route to it.`);
    if (v.maxCompletionTokens !== undefined && v.maxCompletionTokens < cfg.maxOutputTokens) warnings.push(`${v.tag}: output limit ${v.maxCompletionTokens} is below max_tokens ${cfg.maxOutputTokens}.`);
    // Without a context length the output of a call through this endpoint has no stated ceiling at all.
    if (v.contextLength === undefined) blockers.push(`${v.tag}: no context_length, so no output bound can be derived for it.`);
  }
  for (const v of excluded) if (v.missingParams.length && v.maxPromptPerMtok <= cfg.priceIn && v.maxCompletionPerMtok <= cfg.priceOut)
    warnings.push(`${v.tag}: excluded because it does not list ${v.missingParams.join(", ")} (require_parameters).`);
  const requiredOutputBoundTokens = Math.max(0, ...admitted.map((v) => Math.max(v.contextLength ?? 0, v.maxCompletionTokens ?? 0)));
  if (cfg.outputBoundTokens < cfg.maxOutputTokens) blockers.push(`The output bound ${cfg.outputBoundTokens} is below max_tokens ${cfg.maxOutputTokens}.`);
  if (admitted.length && cfg.outputBoundTokens < requiredOutputBoundTokens)
    blockers.push(`The output bound ${cfg.outputBoundTokens} is below ${requiredOutputBoundTokens}, the largest context_length / max_completion_tokens of an admitted endpoint: a call whose reasoning ignores max_tokens could cost more than its reservation.`);
  const boundPerCallUsd = round6(reservationUsd(MAX_REQUEST_BYTES, cfg.priceIn, cfg.priceOut, cfg.outputBoundTokens));
  return { model, ok: blockers.length === 0 && admitted.length > 0, admitted, excluded, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], boundPerCallUsd, requiredOutputBoundTokens };
}
