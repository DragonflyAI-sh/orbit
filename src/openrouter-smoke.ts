// The smallest paid smoke test of the OpenRouter fallback (G7). It is PREPARED, NOT RUN: running it spends real money and needs Rai's
// explicit, separate authorisation (docs/openrouter-activation-runbook.md, "Paid smoke test").
//
// What it does, and nothing else: ORBIT's own fallback path (src/fallback.ts + src/openrouter.ts, unchanged) in front of a fake ChatGPT
// that always reports a usage limit, against a FRESH ledger in a new temporary directory (never the service's state directory), with at
// most three paid requests: one plain reply, one tool-call turn, one turn that reads a synthetic tool result. The tool is never
// executed: the model's call is checked and a fixed, synthetic result is fed back. The prompt is synthetic and carries no private data.
// It stops at the first failed check, so a failure cannot lead to more spend.
//
// Refuses unless: the confirmation flag is given, the configuration is complete exactly as ORBIT would read it, both local caps are at
// most SMOKE_MAX_CAP_USD and max_tokens is at most SMOKE_MAX_OUTPUT_TOKENS.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "./chatgpt.ts";
import { fallbackModel } from "./fallback.ts";
import type { Item, ModelPort } from "./model.ts";
import { openrouterConfig, reservationUsd } from "./openrouter.ts";
import { PROVISION_FILE, spendLedger, toMicro } from "./spend-ledger.ts";

export const SMOKE_MAX_CAP_USD = 1;
export const SMOKE_MAX_OUTPUT_TOKENS = 512;
export const SMOKE_MAX_REQUESTS = 3;
export const CONFIRM_FLAG = "--confirm-paid-smoke";

export type SmokeCheck = { name: string; ok: boolean; detail: string };
export type SmokeReport = {
  ok: boolean;
  refused?: string;
  model?: string;
  requests: number;
  checks: SmokeCheck[];
  // Per paid request, as the provider reported it (no text, no key): cost, tokens, the reservation ORBIT made for it.
  calls: { costUsd: number | null; promptTokens: number | null; completionTokens: number | null; reasoningTokens: number | null; reservedUsd: number }[];
  ledger?: { lifetimeUsd: number; spentTodayUsd: number; reservedUsd: number; uncertainRequests: number; dir: string };
};

type Usage = { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function runSmoke(argv: string[], env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch, now: () => number = Date.now, readKey?: (dir: string) => string): Promise<SmokeReport> {
  const report: SmokeReport = { ok: false, requests: 0, checks: [], calls: [] };
  if (!argv.includes(CONFIRM_FLAG)) return { ...report, refused: `This spends real money. Run only with Rai's explicit authorisation, and pass ${CONFIRM_FLAG}.` };
  const cfg = readKey ? openrouterConfig(env, readKey) : openrouterConfig(env);
  if (cfg.state !== "ready") return { ...report, refused: `The configuration is not complete: ${cfg.reason}` };
  if (cfg.dailyCapUsd > SMOKE_MAX_CAP_USD || cfg.totalCapUsd > SMOKE_MAX_CAP_USD) return { ...report, refused: `For the smoke test both ORBIT_OPENROUTER_DAILY_CAP_USD and ORBIT_OPENROUTER_TOTAL_CAP_USD must be at most ${SMOKE_MAX_CAP_USD}.` };
  if (cfg.maxOutputTokens > SMOKE_MAX_OUTPUT_TOKENS) return { ...report, refused: `For the smoke test ORBIT_OPENROUTER_MAX_OUTPUT_TOKENS must be at most ${SMOKE_MAX_OUTPUT_TOKENS}.` };
  report.model = cfg.model;

  // A fresh, isolated ledger: its own new directory, provisioned with a stated zero opening for THIS test only.
  const dir = mkdtempSync(join(tmpdir(), "orbit-openrouter-smoke-"));
  writeFileSync(join(dir, PROVISION_FILE), JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0, note: "isolated paid smoke test ledger" }), { mode: 0o600 });
  const ledger = spendLedger(dir, { dailyMicro: toMicro(cfg.dailyCapUsd), totalMicro: toMicro(cfg.totalCapUsd) });
  ledger.open();

  // Counts every request and keeps only the numbers of each response's usage (the body itself is not kept or printed).
  const counted = (async (url: string, init: RequestInit) => {
    if (report.requests >= SMOKE_MAX_REQUESTS) throw new Error("smoke request limit reached");
    report.requests++;
    const sentBytes = Buffer.byteLength(String(init.body ?? ""));
    const res = await fetcher(url, init);
    let usage: Usage = {};
    try {
      usage = ((await res.clone().json()) as { usage?: Usage })?.usage ?? {};
    } catch {
      // unreadable: recorded as unknown below
    }
    report.calls.push({
      costUsd: numOrNull(usage.cost),
      promptTokens: numOrNull(usage.prompt_tokens),
      completionTokens: numOrNull(usage.completion_tokens),
      reasoningTokens: numOrNull(usage.completion_tokens_details?.reasoning_tokens),
      reservedUsd: Math.round(reservationUsd(sentBytes, cfg.priceIn, cfg.priceOut, cfg.outputBoundTokens) * 1e6) / 1e6,
    });
    return res;
  }) as unknown as typeof fetch;

  const resets = new Date(now() + 30 * 60_000).toISOString();
  const limited: ModelPort = {
    status: () => ({ port: "model", state: "degraded", impl: "smoke/fake-chatgpt", detail: "Fake primary: always usage-limited.", verifiedAt: new Date(now()).toISOString() }),
    reply: async () => {
      throw new ProviderError("usage_limit", "Fake ChatGPT usage limit (smoke test).", resets);
    },
    step: async () => {
      throw new ProviderError("usage_limit", "Fake ChatGPT usage limit (smoke test).", resets);
    },
  };
  const model = fallbackModel({ primary: limited, config: cfg, ledger, fetcher: counted, now });
  const check = (name: string, ok: boolean, detail: string) => {
    report.checks.push({ name, ok, detail });
    return ok;
  };
  const finish = () => {
    const v = ledger.view();
    report.ledger = { lifetimeUsd: v.lifetimeUsd, spentTodayUsd: v.spentTodayUsd, reservedUsd: v.reservedUsd, uncertainRequests: v.uncertainRequests, dir };
    // Per paid request: the provider's own numbers. completion_tokens above max_tokens means this route lets reasoning ignore
    // max_tokens: the reservation still covered it (the output bound), but it is a stop condition before production enablement.
    report.calls.forEach((c, i) => {
      check(`request ${i + 1}: usage reported`, c.costUsd !== null && c.completionTokens !== null, `cost ${c.costUsd}, completion tokens ${c.completionTokens}`);
      if (c.completionTokens !== null) check(`request ${i + 1}: completion tokens within max_tokens (reasoning included)`, c.completionTokens <= cfg.maxOutputTokens, `${c.completionTokens} of ${cfg.maxOutputTokens}; reasoning ${c.reasoningTokens}`);
      if (c.costUsd !== null) check(`request ${i + 1}: cost within its reservation`, c.costUsd <= c.reservedUsd, `${c.costUsd} <= ${c.reservedUsd}`);
    });
    report.ok = report.checks.every((c) => c.ok);
    return report;
  };
  const tool = { name: "jobs_list", description: "List ORBIT jobs. (Smoke test: returns fixed synthetic data; nothing real is read.)", parameters: { type: "object", properties: {}, additionalProperties: false } };

  // 1. Plain reply.
  try {
    const r = await model.reply([{ role: "user", content: "This is an automated connectivity test. Reply with exactly: ORBIT smoke OK" }], []);
    if (!check("reply served by the fallback with provenance", r.fallback?.provider === "openrouter" && r.fallback.model === cfg.model && r.fallback.reason === "usage_limit" && r.fallback.primaryLimit.until === resets && /FALLBACK, paid/.test(r.source), `source ${r.source}`)) return finish();
    if (!check("reply has text and no accounting problem", r.value.length > 0 && !r.accounting?.length, `${r.value.length} chars${r.accounting?.length ? `; accounting: ${r.accounting.join("; ")}` : ""}${r.incomplete?.length ? `; incomplete: ${r.incomplete.join("; ")}` : ""}`)) return finish();
  } catch (err) {
    check("reply served by the fallback with provenance", false, err instanceof Error ? err.message.slice(0, 300) : "failed");
    return finish();
  }
  if (!check("ledger settled after the reply", ledger.view().reservedUsd === 0 && ledger.view().uncertainRequests === 0, JSON.stringify(ledger.view()))) return finish();

  // 2. A tool-call turn. The tool is offered and allowed in fallback mode; its call is only inspected, never run.
  const input: Item[] = [{ role: "user", content: "Automated test: call the jobs_list tool exactly once with no arguments, then say how many jobs it returned." }];
  let callId = "";
  try {
    const s = await model.step!(input, [], undefined, [tool], { fallback: true });
    const call = s.calls[0];
    if (!check("tool call requested and well formed", s.calls.length === 1 && call?.name === "jobs_list" && Boolean(call.call_id), `${s.calls.length} call(s): ${s.calls.map((c) => c.name).join(", ")}`)) return finish();
    callId = call!.call_id;
    input.push({ type: "function_call", call_id: callId, name: "jobs_list", arguments: call!.arguments });
  } catch (err) {
    check("tool call requested and well formed", false, err instanceof Error ? err.message.slice(0, 300) : "failed");
    return finish();
  }
  // 3. The synthetic result goes back; the model answers from it.
  input.push({ type: "function_call_output", call_id: callId, output: JSON.stringify({ jobs: [{ id: "smoke-1" }, { id: "smoke-2" }] }) });
  try {
    const s = await model.step!(input, [], undefined, [tool], { fallback: true });
    check("answer after the synthetic tool result", s.calls.length === 0 && s.text.length > 0, `${s.text.length} chars, ${s.calls.length} further call(s)`);
  } catch (err) {
    check("answer after the synthetic tool result", false, err instanceof Error ? err.message.slice(0, 300) : "failed");
  }
  return finish();
}
