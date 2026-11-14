import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort, Step } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { recentContext, stateRecentContext } from "../src/recent-context.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { jsonStore } from "../src/store.ts";
import { threadService } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";
import { provisioned } from "./helpers/ledger.ts";
import { say, scripted } from "./threads-fixture.ts";

// Acceptance 2026-11-14 (docs/acceptance-2026-11-14.md, area 4). The readiness audit covered the scheduled worker and thread compaction
// through their real callers, but the rolling recent-context rewrite only by code reading. This drives that real caller through a
// fallback model whose primary is usage-limited, with a fake OpenRouter that counts requests, and checks that nothing is spent; a
// control shows the same wiring does reach the fake for an opted-in interactive step, so the zero is not vacuous. Nothing here reaches
// a provider: the key below is assembled at runtime from harmless pieces, the ledger is in a temp directory, and the caps are the
// test's own, not production's.

const T0 = Date.parse("2026-11-14T10:00:00Z");
const MIN = 60_000;
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048",
  CREDENTIALS_DIRECTORY: "/creds",
};
const fakeKey = () => ["not", "a", "real", "key", "x".repeat(16)].join("-");

function world() {
  const cfg = openrouterConfig(ENV, fakeKey);
  assert.equal(cfg.state, "ready", JSON.stringify(cfg));
  const ledger = provisioned(mkdtempSync(join(tmpdir(), "orbit-accept-spend-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) }, () => new Date(T0));
  const requests: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "from fallback" } }], usage: { cost: 0.0001 } }), { status: 200 });
  }) as unknown as typeof fetch;
  let primaryCalls = 0;
  const limit = () => new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", new Date(T0 + 60 * MIN).toISOString(), "usage_limit_reached");
  const primary: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-x", detail: "Answering.", verifiedAt: new Date(T0).toISOString() }),
    step: async (): Promise<Step> => {
      primaryCalls++;
      throw limit();
    },
    reply: async () => {
      primaryCalls++;
      throw limit();
    },
  };
  const model = fallbackModel({ primary, config: cfg as Extract<OpenRouterConfig, { state: "ready" }>, ledger, fetcher, now: () => T0 });
  return { model, ledger, requests, primaryCalls: () => primaryCalls };
}

test("fallback acceptance: the recent-context rewrite (a background caller) never spends OpenRouter while ChatGPT is usage-limited", async () => {
  // A notable thread, built with a free scripted model.
  const threads = threadStore(undefined);
  const svc = threadService({ threads, model: scripted(() => say("answer")), proposals: newProposals(), budget: 1_000_000 });
  const t = threads.create("work");
  for (let i = 0; i < 4; i++) await svc.turn(t.id, `question ${i}`, { memory: [], limits: [], tools: [], isOwner: true });

  const w = world();
  const meta = jsonStore(undefined, "recent-meta", {});
  const port = stateRecentContext(jsonStore(undefined, "recent", null));
  const rc = recentContext({ port, threads, model: w.model, meta, now: () => new Date(T0) });
  assert.equal(rc.consider(t.id, { force: true, isOwner: true }), true, "a rewrite was queued");
  await rc.idle();
  assert.ok(w.primaryCalls() >= 1, "the rewrite did ask the primary");
  assert.equal(w.requests.length, 0, "no request reached OpenRouter");
  assert.equal(w.ledger.view().lifetimeUsd, 0, "nothing was spent or reserved");
  assert.match(rc.status().lastError?.detail ?? "", /usage limit/i, "the failure is recorded, not hidden");
  assert.equal(await port.read(), undefined, "no note was written from a fallback answer");

  // Control: the same wiring does reach the fake for an opted-in interactive step, so the zero above is not vacuous.
  const step = await w.model.step!([{ role: "user", content: "hi" }], [], undefined, [], { fallback: true });
  assert.equal(step.text, "from fallback");
  assert.equal(w.requests.length, 1);
  assert.ok(w.ledger.view().lifetimeUsd > 0);
});

test("fallback acceptance: a reply() call without an explicit option still defaults to fallback-on (latent risk L1, unchanged)", async () => {
  // Pinned as observed, not endorsed: every current background caller passes { fallback: false } explicitly (see the test above and
  // openrouter-fallback.test.ts "readiness:" tests). Making reply() opt-in is a separate decision (audit L1), not done here.
  const w = world();
  const r = await w.model.reply([{ role: "user", content: "hi" }], []);
  assert.equal(r.value, "from fallback");
  assert.equal(w.requests.length, 1);
});
