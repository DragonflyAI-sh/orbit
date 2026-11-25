import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { ModelPort } from "../src/model.ts";
import { modelAvailability, withAvailability } from "../src/model-availability.ts";
import { openrouterConfig, reservationUsd } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import type { PortStatus } from "../src/ports.ts";
import { spendLedger, toMicro } from "../src/spend-ledger.ts";
import { provisioned } from "./helpers/ledger.ts";
import { rig, say, scripted } from "./threads-fixture.ts";

// Effective model availability (src/model-availability.ts, src/fallback.ts status(), the page's aggregateStatus): the backend fields,
// the indicator level and its label must agree. Real state transitions of the fallback wrapper, offline: the primary is a switchable
// scripted model and OpenRouter a fake fetch; nothing paid is reachable.

const MIN = 60_000;
const ENV = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "vendor/cheap-model",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048",
  CREDENTIALS_DIRECTORY: "/creds",
};
const ready = () => {
  const c = openrouterConfig(ENV, () => ["sk", "or", "v1", "0".repeat(32)].join("-"));
  assert.equal(c.state, "ready");
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};
// The smallest reservation any request can make at these prices (an empty body): 832 micro-USD.
const SMALLEST = toMicro(reservationUsd(0, 0.2, 0.4, 2048));

// The page's own aggregation, loaded from the page as the page tests do.
type Overall = { level: "ok" | "degraded" | "down" | "unknown"; ok: boolean; label: string; detail: string };
const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ <status-dot>([\s\S]*?)\/\/ <\/status-dot>/)![1]!;
const { aggregateStatus } = new Function(`${block}; return { aggregateStatus };`)() as { aggregateStatus: (s: unknown, failure?: unknown) => Overall };
const live = (port: string): PortStatus => ({ port, state: "live", impl: "x", detail: `${port} detail`, verifiedAt: "t" });
// What /status serves: the model port (with availability, as server.ts adds it) among otherwise healthy ports.
const page = (model: PortStatus, extra: PortStatus[] = []) => {
  const ports = [live("policy"), live("channel"), withAvailability(model), live("memory"), live("notify"), live("jobs"), ...extra];
  const byName = new Map(ports.map((p) => [p.port, p]));
  return aggregateStatus({ ports: JSON.parse(JSON.stringify([...byName.values()])) });
};

type Mode = "ok" | "error" | "network";
function world(opts: { config?: OpenRouterConfig; ledger?: "provisioned" | "unprovisioned" } = {}) {
  const clock = { t: Date.parse("2026-11-18T06:00:00.000Z") };
  const sw = { limited: false };
  const inner = scripted(() => say("primary"));
  const limit = () => new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", new Date(clock.t + 30 * MIN).toISOString());
  const primary: ModelPort = {
    images: () => ({ ok: true, detail: "the configured model takes photos" }),
    status: () => ({ port: "model", state: sw.limited ? "down" : "live", impl: "chatgpt/gpt-x", detail: sw.limited ? "usage limit" : "Answering.", verifiedAt: new Date(clock.t).toISOString() }),
    reply: async (m, l, n, o) => {
      if (sw.limited) throw limit();
      return inner.reply(m, l, n, o);
    },
    step: async (i, l, n, t, o) => {
      if (sw.limited) throw limit();
      return inner.step!(i, l, n, t, o);
    },
  };
  const or = { mode: "ok" as Mode, requests: 0 };
  const fetcher = (async () => {
    or.requests++;
    if (or.mode === "network") throw new TypeError("fetch failed");
    if (or.mode === "error") return new Response(JSON.stringify({ error: { message: "provider unavailable" } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fallback answer" } }], usage: { cost: 0.0001 } }));
  }) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "orbit-availability-"));
  const caps = { dailyMicro: toMicro(5), totalMicro: toMicro(150) };
  const ledger = opts.ledger === "unprovisioned" ? spendLedger(dir, caps, () => new Date(clock.t)) : provisioned(dir, caps, () => new Date(clock.t));
  const model = fallbackModel({ primary, config: opts.config ?? ready(), ledger, fetcher, now: () => clock.t });
  const ask = () => model.reply([{ role: "user", content: "hi" }], []);
  // Leave exactly `micro` micro-USD of headroom under the caps (settled spend, nothing in flight).
  const leave = (micro: number) => {
    const left = toMicro(ledger.view().remainingTodayUsd);
    const r = ledger.reserve(left - micro);
    ledger.settle(r.id, left - micro);
    assert.equal(toMicro(ledger.view().remainingTodayUsd), micro);
  };
  return { model, sw, or, ledger, clock, ask, leave };
}
const view = (m: ModelPort) => withAvailability(m.status());

// ---- both models unusable: false, down, red ---------------------------------------------------------------------------------------

test("dual failure: ChatGPT limited and the fallback's cap used up is available false, down and red, with the process still running", async () => {
  const w = world();
  w.sw.limited = true;
  await w.ask();
  w.leave(0);
  const st = view(w.model);
  assert.equal(st.state, "down");
  assert.deepEqual([st.availability?.available, st.availability?.via], [false, "none"]);
  assert.equal(st.fallback?.answering, false);
  assert.match(st.availability!.reason, /daily spend cap is used up: no reply can come from either model/);
  const r = page(w.model.status());
  assert.deepEqual([r.level, r.ok, r.label], ["down", false, "Down: model"]);
  assert.match(r.detail, /No reply can come from ChatGPT or a fallback model: ChatGPT is limited and the OpenRouter fallback's daily spend cap is used up/);
  assert.match(r.detail, /ORBIT itself is running: it answered this status request\./, "process liveness is told apart from model availability");
  // A call now really fails: the status was not pessimistic.
  await assert.rejects(w.ask(), /The OpenRouter fallback did not answer/);
});

test("exhausted budget: headroom above zero but below the smallest possible call is unusable (false, red), not a working fallback", async () => {
  const w = world();
  w.sw.limited = true;
  await w.ask();
  w.leave(SMALLEST - 1);
  const st = view(w.model);
  assert.equal(st.state, "down");
  assert.equal(st.availability?.available, false);
  assert.equal(st.fallback?.answering, false);
  assert.match(st.detail, /remaining allowance is below the smallest possible call's reservation/);
  assert.match(st.detail, /less than the \$0\.0008 the smallest possible call reserves/);
  assert.equal(page(w.model.status()).level, "down");
  const before = w.or.requests;
  await assert.rejects(w.ask(), /The OpenRouter fallback did not answer/);
  assert.equal(w.or.requests, before, "the caps refused it before anything was sent");
});

test("exhausted budget: enough for the smallest call but not this request: the refused call turns the route red, not amber", async () => {
  const w = world();
  w.sw.limited = true;
  await w.ask();
  assert.equal(page(w.model.status()).level, "degraded");
  w.leave(SMALLEST + 50);
  // The lower bound alone still allows a call, so before one is refused nothing claims otherwise...
  assert.equal(view(w.model).fallback?.answering, true);
  // ...but the real request reserves more than is left: the caps refuse it, and that is evidence.
  await assert.rejects(w.ask(), /The OpenRouter fallback did not answer/);
  const st = view(w.model);
  assert.equal(st.state, "down");
  assert.deepEqual([st.availability?.available, st.fallback?.answering, st.fallback?.lastCall], [false, false, "failed"]);
  assert.equal(page(w.model.status()).level, "down");
});

// ---- primary down, fallback working: true, degraded, amber ------------------------------------------------------------------------

test("primary limited with a fallback that answered: available true via the fallback, degraded and amber, never unavailable", async () => {
  const w = world();
  w.sw.limited = true;
  const reply = await w.ask();
  assert.equal(reply.fallback?.model, "vendor/cheap-model");
  const st = view(w.model);
  assert.equal(st.state, "degraded");
  assert.deepEqual([st.availability?.available, st.availability?.via], [true, "fallback"]);
  assert.deepEqual([st.fallback?.answering, st.fallback?.lastCall], [true, "succeeded"]);
  const r = page(w.model.status());
  assert.deepEqual([r.level, r.ok, r.label], ["degraded", false, "Degraded: fallback model"]);
  assert.match(r.detail, /Replies come from the fallback model openrouter\/vendor\/cheap-model, not ChatGPT/);
});

// ---- configured but unusable fallback ---------------------------------------------------------------------------------------------

test("configured but unusable fallback (no credential, ledger not provisioned, ledger latched): false, down, red", async () => {
  // No client at all: the configuration is incomplete.
  const a = world({ config: { state: "unavailable", reason: "the OpenRouter credential is not installed" } as OpenRouterConfig });
  a.sw.limited = true;
  await assert.rejects(a.ask(), /The OpenRouter fallback did not answer: the OpenRouter credential is not installed/);
  let st = view(a.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback], ["down", false, undefined]);
  assert.equal(page(a.model.status()).level, "down");

  // Configured, but the ledger was never provisioned: no paid call can be admitted.
  const b = world({ ledger: "unprovisioned" });
  b.sw.limited = true;
  await assert.rejects(b.ask(), /The OpenRouter fallback did not answer/);
  st = view(b.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.answering], ["down", false, false]);
  assert.match(st.detail, /NOT armed/);
  assert.equal(page(b.model.status()).level, "down");
  assert.equal(b.or.requests, 0);
});

// Without model health (no `health` field): the wrapper's own verdict. /status with model health recording `fallback` reports this case as
// degraded and available via the fallback (amber): test/model-health.test.ts, "/status: ChatGPT limited and the fallback not called yet".
test("without model health, a configured fallback that has not been tried since the limit began is not known (null), shown grey, never green or amber", async () => {
  const w = world();
  w.sw.limited = true;
  // A background caller (no `fallback: true`) hits the limit: it never spends, so the fallback is not tried.
  await assert.rejects(w.model.step!([{ role: "user", content: "compact" }], [], undefined, []), /usage limit/);
  assert.equal(w.or.requests, 0);
  const st = view(w.model);
  assert.equal(st.state, "degraded");
  assert.deepEqual([st.availability?.available, st.availability?.via, st.fallback?.answering, st.fallback?.lastCall], [null, "unknown", false, "none"]);
  assert.match(st.detail, /configured but has not been called since the limit began, so whether it answers is not known/);
  const r = page(w.model.status());
  assert.deepEqual([r.level, r.ok, r.label], ["unknown", false, "Status unknown: model"]);
  assert.match(r.detail, /Whether a model can reply is not known: ChatGPT is limited and the OpenRouter fallback has not been tried since/);
  assert.doesNotMatch(r.detail, /Also not live/, "everything else is live");
  assert.match(page(w.model.status(), [{ ...live("memory"), state: "degraded" }]).detail, /Also not live: memory: degraded\./);
  // The first owner call that the fallback answers is the evidence: amber.
  await w.ask();
  assert.equal(page(w.model.status()).level, "degraded");
});

// ---- failure after the fallback was selected ---------------------------------------------------------------------------------------

test("failure after fallback selection: a provider error or network failure on the selected fallback is red until a call succeeds", async () => {
  for (const mode of ["error", "network"] as const) {
    const w = world();
    w.sw.limited = true;
    await w.ask();
    assert.equal(page(w.model.status()).label, "Degraded: fallback model", mode);
    w.or.mode = mode;
    await assert.rejects(w.ask(), /The OpenRouter fallback did not answer/);
    let st = view(w.model);
    assert.equal(st.state, "down", mode);
    assert.deepEqual([st.availability?.available, st.fallback?.answering, st.fallback?.lastCall], [false, false, "failed"], mode);
    assert.match(st.detail, /latest OpenRouter fallback call \(.*\) failed, so no reply is known to work until one succeeds/);
    assert.match(st.detail, /Last fallback error:/);
    const r = page(w.model.status());
    assert.deepEqual([r.level, r.label], ["down", "Down: model"], mode);
    assert.match(r.detail, /the latest OpenRouter fallback call failed/);
    // It answers again: amber again, with the error cleared.
    w.or.mode = "ok";
    await w.ask();
    st = view(w.model);
    assert.deepEqual([st.state, st.availability?.available, st.fallback?.answering], ["degraded", true, true], mode);
    assert.doesNotMatch(st.detail, /Last fallback error/);
    assert.equal(page(w.model.status()).level, "degraded");
  }
});

test("photos refused before a request are a modality limit, not a fallback failure: the route stays amber", async () => {
  const w = world();
  w.sw.limited = true;
  await w.ask();
  const photo = { role: "user" as const, content: "look", images: [{ ref: "att_x", mime: "image/jpeg", data: "AAAA" }] };
  await assert.rejects(w.model.reply([photo as never], []), /The OpenRouter fallback did not answer/);
  const st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.fallback?.lastCall], ["degraded", true, "succeeded"]);
});

// ---- recovery ---------------------------------------------------------------------------------------------------------------------

test("recovery: after the reset it is amber (not confirmed), and the first successful ChatGPT call returns to green", async () => {
  const w = world();
  w.sw.limited = true;
  await w.ask();
  w.or.mode = "error";
  await assert.rejects(w.ask());
  assert.equal(page(w.model.status()).level, "down");
  // The reset time passes and ChatGPT answers again; nothing is confirmed until a call succeeds.
  w.sw.limited = false;
  w.clock.t += 31 * MIN;
  let st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.availability?.via, st.fallback?.answering], ["degraded", true, "primary", false]);
  assert.equal(page(w.model.status()).level, "degraded");
  const reply = await w.ask();
  assert.equal(reply.fallback, undefined, "ChatGPT answered");
  st = view(w.model);
  assert.deepEqual([st.state, st.availability?.available, st.availability?.via, st.fallback], ["live", true, "primary", undefined]);
  const r = page(w.model.status());
  assert.deepEqual([r.level, r.ok, r.label], ["ok", true, "All live"]);
});

test("a new limit window starts without evidence: an earlier window's failure is not carried over", async () => {
  const w = world();
  w.sw.limited = true;
  w.or.mode = "error";
  await assert.rejects(w.ask());
  assert.equal(view(w.model).availability?.available, false);
  w.sw.limited = false;
  w.clock.t += 31 * MIN;
  await w.ask();
  assert.equal(view(w.model).state, "live");
  // Limited again, hit by a background call: not known, not the old failure.
  w.sw.limited = true;
  await assert.rejects(w.model.step!([{ role: "user", content: "compact" }], [], undefined, []));
  const st = view(w.model);
  assert.deepEqual([st.availability?.available, st.fallback?.lastCall], [null, "none"]);
});

// ---- nonfatal degradation and core-failure precedence -------------------------------------------------------------------------------

test("nonfatal degradation stays amber; a core failure wins over it; unknown model availability wins over amber but not over red", () => {
  const degradedMemory = { ...live("memory"), state: "degraded" as const };
  // Model live, an optional port degraded: amber, available true.
  let r = page(live("model"), [degradedMemory]);
  assert.deepEqual([r.level, r.label], ["degraded", "Degraded: 1 not live"]);
  // ChatGPT degraded for another nonfatal reason (token not renewed yet): amber, available true via the primary.
  const tokenStale: PortStatus = { ...live("model"), state: "degraded", detail: "token expired, not renewed yet" };
  assert.deepEqual(modelAvailability(tokenStale), { available: true, via: "primary", reason: "The primary model is degraded but expected to answer (not confirmed)." });
  assert.equal(page(tokenStale).level, "degraded");
  // Model down (a genuine core failure) with optional degradation: red, and the other caveats stay in the detail.
  r = page({ ...live("model"), state: "down" }, [degradedMemory]);
  assert.equal(r.level, "down");
  assert.match(r.detail, /Also not live: memory: degraded\./);
  // Policy down while the model answers on the fallback: red names policy, not the model.
  const onFallback: PortStatus = { ...live("model"), state: "degraded", fallback: { provider: "openrouter", model: "m", answering: true, reason: "usage_limit", until: "u", estimated: false, lastCall: "succeeded" }, availability: { available: true, via: "fallback", reason: "fallback answered" } };
  r = aggregateStatus({ ports: [{ ...live("policy"), state: "down" }, live("channel"), withAvailability(onFallback)] });
  assert.deepEqual([r.level, r.label], ["down", "Down: policy"]);
  assert.doesNotMatch(r.detail, /No reply can come/);
  // Not known beats amber...
  const untried: PortStatus = { ...live("model"), state: "degraded", availability: { available: null, via: "unknown", reason: "not tried" } };
  assert.equal(page(untried, [degradedMemory]).level, "unknown");
  // ...but a core failure beats not known.
  r = aggregateStatus({ ports: [{ ...live("channel"), state: "down" }, live("policy"), withAvailability(untried)] });
  assert.equal(r.level, "down");
});

test("availability and state cannot disagree in the healthy direction: down or mock is never available; a bad value is never green", () => {
  const claimsUp = { available: true, via: "fallback", reason: "stale claim" } as const;
  for (const state of ["down", "mock"] as const) {
    const a = modelAvailability({ ...live("model"), state, availability: claimsUp });
    assert.deepEqual([a.available, a.via], [false, "none"], state);
    assert.equal(page({ ...live("model"), state, availability: claimsUp }).level, "down", state);
  }
  // An unreadable state is never more than "not known".
  assert.equal(modelAvailability({ ...live("model"), state: "LIVE" as never }).available, null);
  // A live port whose availability says false or null is not green.
  assert.equal(aggregateStatus({ ports: [live("policy"), live("channel"), { ...live("model"), availability: { available: false, via: "none", reason: "x" } }] }).level, "down");
  assert.equal(aggregateStatus({ ports: [live("policy"), live("channel"), { ...live("model"), availability: { available: null, via: "unknown", reason: "x" } }] }).level, "unknown");
  // A malformed availability is not known (grey), never healthy.
  for (const bad of [{}, "yes", 1, { available: "true" }, null]) {
    const r = aggregateStatus({ ports: [live("policy"), live("channel"), { ...live("model"), availability: bad }] });
    assert.equal(r.level, "unknown", JSON.stringify(bad));
    assert.match(r.detail, /could not be read/);
  }
  // An answer without the field (an older ORBIT) is read as before.
  assert.equal(aggregateStatus({ ports: [live("policy"), live("channel"), live("model")] }).level, "ok");
});

// ---- the real /status ------------------------------------------------------------------------------------------------------------

test("/status: the model entry carries availability consistent with its state through each transition; the contract is additive", async () => {
  const w = world();
  const x = rig({ model: w.model });
  const model = async () => {
    const res = await x.api("/status");
    assert.equal(res.status, 200, "the status endpoint answers 200 whatever the model's availability");
    assert.ok(typeof res.data.commit === "string" || res.data.commit === null || typeof res.data.commit === "object");
    for (const p of res.data.ports) if (p.port !== "model") assert.equal("availability" in p, false, `${p.port}: only the model port gets it`);
    const m = res.data.ports.find((p: PortStatus) => p.port === "model");
    assert.ok(["live", "degraded", "down", "mock"].includes(m.state), "state keeps its four values");
    return [m.state, m.availability.available, m.availability.via];
  };
  assert.deepEqual(await model(), ["live", true, "primary"]);
  w.sw.limited = true;
  await w.ask();
  assert.deepEqual(await model(), ["degraded", true, "fallback"]);
  w.or.mode = "error";
  await assert.rejects(w.ask());
  assert.deepEqual(await model(), ["down", false, "none"]);
  w.sw.limited = false;
  w.clock.t += 31 * MIN;
  assert.deepEqual(await model(), ["degraded", true, "primary"]);
  await w.ask();
  assert.deepEqual(await model(), ["live", true, "primary"]);
  x.close();
});
