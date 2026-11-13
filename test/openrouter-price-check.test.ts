import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPrices } from "../src/openrouter-price-check.ts";
import { MAX_REQUEST_BYTES, reservationUsd } from "../src/openrouter.ts";

// Synthetic endpoints responses in the shape of GET /api/v1/models/<id>/endpoints (prices are USD per token, as strings).
type Ep = { tag: string; pricing: Record<string, unknown>; max_completion_tokens?: number; context_length?: number; supported_parameters?: string[] };
const ep = (tag: string, prompt: string, completion: string, extra: Partial<Ep> = {}, more: Record<string, unknown> = {}): Ep => ({
  tag,
  pricing: { prompt, completion, ...more },
  max_completion_tokens: 393216,
  context_length: 1048576,
  supported_parameters: ["tools", "tool_choice", "max_tokens", "temperature", "reasoning"],
  ...extra,
});
const doc = (...endpoints: Ep[]) => ({ data: { id: "vendor/model-a", endpoints } });
const cfg = { priceIn: 0.25, priceOut: 0.6, maxOutputTokens: 2048, outputBoundTokens: 1048576 };

test("price check: every endpoint within the configured prices is admitted, a dearer one is excluded, and the bound matches the client's formula", () => {
  const r = checkPrices(doc(ep("cheap", "0.00000009", "0.00000018"), ep("dear", "0.0000003", "0.0000012")), cfg);
  assert.equal(r.ok, true);
  assert.deepEqual(r.admitted.map((v) => v.tag), ["cheap"]);
  assert.deepEqual(r.excluded.map((v) => v.tag), ["dear"]);
  assert.equal(r.admitted[0].maxPromptPerMtok, 0.09);
  assert.equal(r.blockers.length, 0);
  // Same formula as src/openrouter.ts: (bytes + 64) x in + output bound x out, per million (the output bound, not max_tokens).
  assert.equal(r.boundPerCallUsd, Math.round((((MAX_REQUEST_BYTES + 64) * 0.25 + 1048576 * 0.6) / 1e6) * 1e6) / 1e6);
  assert.equal(r.boundPerCallUsd, Math.round(reservationUsd(MAX_REQUEST_BYTES, 0.25, 0.6, 1048576) * 1e6) / 1e6);
  // The admitted endpoint's context length is the smallest output bound that covers it.
  assert.equal(r.requiredOutputBoundTokens, 1048576);
});

test("price check: a base price inside the limits with a dearer time window is a blocker, because max_price's handling of windows is not documented", () => {
  const peak = ep("peaky", "0.00000015", "0.0000006", {}, {
    overrides: [
      { utc_days: ["monday"], utc_start: 100, utc_end: 400, prompt: "0.0000003", completion: "0.0000012" },
      { utc_days: ["saturday", "sunday"], prompt: "0.00000015", completion: "0.0000006" },
    ],
  });
  const r = checkPrices(doc(peak), cfg);
  assert.equal(r.ok, false);
  assert.equal(r.admitted.length, 0);
  assert.match(r.blockers.join("\n"), /peaky: base price is within .* window is not \(0\.3 \/ 1\.2 per M\)/);
  // With prices that cover the peak window it is admitted.
  assert.equal(checkPrices(doc(peak), { ...cfg, priceIn: 0.3, priceOut: 1.2 }).ok, true);
});

test("price check: fees the reservation bound does not include block; fees for inputs ORBIT never sends only warn", () => {
  for (const fee of ["request", "internal_reasoning", "input_cache_write", "web_search"]) {
    const r = checkPrices(doc(ep("x", "0.0000001", "0.0000002", {}, { [fee]: "0.001" })), cfg);
    assert.equal(r.ok, false, fee);
    assert.match(r.blockers.join("\n"), new RegExp(`non-zero ${fee} fee`));
  }
  const zero = checkPrices(doc(ep("x", "0.0000001", "0.0000002", {}, { request: "0", internal_reasoning: "0" })), cfg);
  assert.equal(zero.ok, true, "zero-valued fees are fine");
  const img = checkPrices(doc(ep("x", "0.0000001", "0.0000002", {}, { image: "0.002" })), cfg);
  assert.equal(img.ok, true);
  assert.match(img.warnings.join("\n"), /image fee/);
  const unknown = checkPrices(doc(ep("x", "0.0000001", "0.0000002", {}, { teleport: "0.5" })), cfg);
  assert.match(unknown.blockers.join("\n"), /unknown non-zero price key teleport/);
  const cache = checkPrices(doc(ep("x", "0.0000001", "0.0000002", {}, { input_cache_read: "0.000001" })), cfg);
  assert.match(cache.blockers.join("\n"), /cached-input price 1 per M/);
});

test("price check: unknown override conditions, missing prices, an empty list and nothing admitted all block", () => {
  const cond = checkPrices(doc(ep("x", "0.0000001", "0.0000002", {}, { overrides: [{ moon_phase: "full", prompt: "0.0000001" }] })), cfg);
  assert.match(cond.blockers.join("\n"), /condition ORBIT does not know \(moon_phase\)/);
  const noPrice = checkPrices(doc({ tag: "x", pricing: { prompt: "0.0000001" }, supported_parameters: ["max_tokens", "temperature", "reasoning"] }), cfg);
  assert.equal(noPrice.ok, false);
  assert.match(noPrice.blockers.join("\n"), /no prompt or completion price/);
  for (const bad of [{}, { data: { endpoints: [] } }, null, "text"]) assert.equal(checkPrices(bad, cfg).ok, false);
  const none = checkPrices(doc(ep("dear", "0.000003", "0.000012")), cfg);
  assert.match(none.blockers.join("\n"), /No endpoint is within the configured prices/);
});

test("price check: a long-context window is included in the maxima; missing tools and a small output limit are warned", () => {
  const lc = checkPrices(doc(ep("lc", "0.0000001", "0.0000002", {}, { overrides: [{ min_prompt_tokens: 200000, prompt: "0.0000005", completion: "0.0000002" }] })), cfg);
  assert.equal(lc.ok, false);
  assert.match(lc.warnings.join("\n"), /long-context pricing above 200000/);
  const w = checkPrices(doc(ep("small", "0.0000001", "0.0000002", { max_completion_tokens: 1024, supported_parameters: ["max_tokens", "temperature", "reasoning"] })), cfg);
  assert.equal(w.ok, true);
  assert.match(w.warnings.join("\n"), /does not list both tools and tool_choice/);
  assert.match(w.warnings.join("\n"), /output limit 1024 is below max_tokens 2048/);
});

test("price check tool: reads a saved file only, exits 0 ok / 1 blocked / 2 usage", () => {
  const TOOL = new URL("../tools/openrouter-price-check/check.ts", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "orbit-price-"));
  const f = join(dir, "endpoints.json");
  writeFileSync(f, JSON.stringify(doc(ep("cheap", "0.00000009", "0.00000018"))));
  const ok = spawnSync(process.execPath, [TOOL, f, "--in", "0.25", "--out", "0.6", "--output-bound", "1048576"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /vendor\/model-a: OK/);
  assert.match(ok.stdout, /smallest output bound covering every admitted endpoint: 1048576 tokens/);
  const blocked = spawnSync(process.execPath, [TOOL, f, "--in", "0.01", "--out", "0.01", "--output-bound", "1048576", "--json"], { encoding: "utf8" });
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).ok, false);
  // An output bound below the admitted context length is blocked, exactly as the client would under-reserve.
  assert.equal(spawnSync(process.execPath, [TOOL, f, "--in", "0.25", "--out", "0.6", "--output-bound", "2048"], { encoding: "utf8" }).status, 1);
  assert.equal(spawnSync(process.execPath, [TOOL, f], { encoding: "utf8" }).status, 2);
  // The output bound is required, like ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: no default.
  assert.equal(spawnSync(process.execPath, [TOOL, f, "--in", "0.25", "--out", "0.6"], { encoding: "utf8" }).status, 2);
  writeFileSync(f, "not json");
  assert.equal(spawnSync(process.execPath, [TOOL, f, "--in", "1", "--out", "1", "--output-bound", "1048576"], { encoding: "utf8" }).status, 2);
});

test("price check: an output bound below an admitted endpoint's context length or output limit is a blocker (reasoning may ignore max_tokens)", () => {
  const r = checkPrices(doc(ep("a", "0.0000001", "0.0000002", { context_length: 131072, max_completion_tokens: 943718 })), { ...cfg, outputBoundTokens: 943717 });
  assert.equal(r.ok, false);
  assert.equal(r.requiredOutputBoundTokens, 943718);
  assert.match(r.blockers.join("\n"), /output bound 943717 is below 943718/);
  assert.equal(checkPrices(doc(ep("a", "0.0000001", "0.0000002", { context_length: 131072, max_completion_tokens: 943718 })), { ...cfg, outputBoundTokens: 943718 }).ok, true);
  // max_tokens alone (the pre-change bound) is never enough for a large context.
  assert.equal(checkPrices(doc(ep("a", "0.0000001", "0.0000002")), { ...cfg, outputBoundTokens: 2048 }).ok, false);
  // An admitted endpoint with no context length cannot be bounded.
  const noCtx = checkPrices(doc({ tag: "n", pricing: { prompt: "0.0000001", completion: "0.0000002" }, supported_parameters: ["max_tokens", "temperature", "reasoning"] }), cfg);
  assert.equal(noCtx.ok, false);
  assert.match(noCtx.blockers.join("\n"), /n: no context_length/);
});

test("price check: require_parameters excludes an endpoint that does not list max_tokens, temperature or reasoning, and its fees do not block", () => {
  const r = checkPrices(doc(ep("good", "0.0000001", "0.0000002"), ep("noreason", "0.00000005", "0.0000001", { supported_parameters: ["max_tokens", "temperature", "tools", "tool_choice"] }, { request: "0.01" })), cfg);
  assert.equal(r.ok, true, r.blockers.join("\n"));
  assert.deepEqual(r.admitted.map((v) => v.tag), ["good"]);
  assert.deepEqual(r.excluded.find((v) => v.tag === "noreason")?.missingParams, ["reasoning"]);
  assert.match(r.warnings.join("\n"), /noreason: excluded because it does not list reasoning/);
});

test("price check: fee and price-shape problems of an endpoint max_price already excludes do not block the model (PR #68 review, finding 1)", () => {
  // The reviewer's probe: one cheap endpoint inside 0.25/0.60, one excluded endpoint at 5/10 with a request fee.
  const r = checkPrices(doc(ep("cheap", "0.0000001", "0.0000002"), ep("pricey", "0.000005", "0.00001", {}, { request: "0.01", teleport: "1", input_cache_read: "0.00001" })), cfg);
  assert.equal(r.ok, true, r.blockers.join("\n"));
  assert.deepEqual(r.admitted.map((v) => v.tag), ["cheap"]);
  // The same fee on an endpoint routing CAN reach still blocks.
  const reach = checkPrices(doc(ep("cheap", "0.0000001", "0.0000002"), ep("feed", "0.0000001", "0.0000002", {}, { request: "0.01" })), cfg);
  assert.equal(reach.ok, false);
  assert.match(reach.blockers.join("\n"), /feed: non-zero request fee/);
});
