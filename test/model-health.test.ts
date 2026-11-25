import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderError } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import type { Message, ModelPort, Reply, ReplyOptions, Step } from "../src/model.ts";
import { modelAvailability, withAvailability } from "../src/model-availability.ts";
import { MODEL_SMOKE_PROMPT, modelHealthTracker, modelSmokeCheck, observeModel } from "../src/model-health.ts";
import type { ModelHealth } from "../src/model-health.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import type { PortState, PortStatus } from "../src/ports.ts";
import { orbitSmokeChecks } from "../src/smoke-checks.ts";
import { smokeRunner } from "../src/smoke.ts";
import { toMicro } from "../src/spend-ledger.ts";
import { jsonStore } from "../src/store.ts";
import { watcher } from "../src/watch.ts";
import type { WatchState } from "../src/watch.ts";
import { provisioned } from "./helpers/ledger.ts";
import { rig } from "./threads-fixture.ts";

// Post-deploy model smoke check and model health (src/model-health.ts, docs/model-health.md). Every model here is a scripted fake: nothing
// contacts ChatGPT, OpenRouter or any provider.

const quiet = () => {};
const usageLimit = () => new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", new Date(Date.now() + 3_600_000).toISOString());
const mem = () => jsonStore<ModelHealth | null>(undefined, "model-health", null);

type Script = (opts?: ReplyOptions) => Promise<string> | string;
// A scripted primary whose status behaves like the ChatGPT port: `live` from the local login check until a call fails, `down` after a
// limit. Records every call.
function primary(script: Script, initial: PortState = "live") {
  const calls: { messages: Message[]; limits: string[]; notes?: string; opts?: ReplyOptions }[] = [];
  let state: PortState = initial;
  const model: ModelPort & { signIn(): string } = {
    status: () => ({ port: "model", state, impl: "chatgpt-token-sharing/gpt-x", detail: state === "down" ? "ChatGPT usage limit." : "Signed in (checked locally).", verifiedAt: new Date().toISOString() }),
    async reply(messages, limits, notes, opts) {
      calls.push({ messages, limits, notes, opts });
      try {
        const value = await script(opts);
        state = "live";
        return { value, provenance: "live", source: "model/chatgpt-token-sharing/gpt-x" } as Reply;
      } catch (err) {
        if (err instanceof ProviderError && err.kind === "usage_limit") state = "down";
        throw err;
      }
    },
    async step(): Promise<Step> {
      calls.push({ messages: [], limits: [] });
      const text = await script();
      return { text, calls: [] };
    },
    signIn: () => "extra",
  };
  return { model, calls };
}

// ---- the tracker ---------------------------------------------------------------------------------------------------------------------

test("tracker: unknown at first; a newer call's evidence is never overwritten by an older call that finishes late", () => {
  const h = modelHealthTracker(mem(), { log: quiet });
  assert.equal(h.read().state, "unknown");
  assert.equal(h.read().smoke?.state, "pending", "this process's check has not run yet");
  assert.equal(h.confirmsRecovery(), false);
  const older = h.ticket();
  const newer = h.ticket();
  assert.equal(h.record(newer, { state: "fallback", source: "call", reason: "limit" }), true);
  assert.equal(h.record(older, { state: "healthy", source: "call" }), false, "the older call is ignored");
  assert.equal(h.read().state, "fallback");
  assert.equal(h.confirmsRecovery(), false);
  h.record(h.ticket(), { state: "healthy", source: "call", model: "gpt-x" });
  assert.equal(h.read().state, "healthy");
  assert.equal(h.read().reason, undefined, "a healthy record carries no stale reason");
  assert.equal(h.confirmsRecovery(), true);
});

test("tracker: the state is persisted, but after a restart only evidence from the new process confirms a recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-health-"));
  const a = modelHealthTracker(jsonStore<ModelHealth | null>(dir, "model-health", null), { log: quiet });
  a.record(a.ticket(), { state: "healthy", source: "smoke", model: "gpt-x" });
  const saved = JSON.parse(readFileSync(join(dir, "model-health.json"), "utf8"));
  assert.equal(saved.state, "healthy");
  const b = modelHealthTracker(jsonStore<ModelHealth | null>(dir, "model-health", null), { log: quiet });
  assert.equal(b.read().state, "healthy", "readable across restarts");
  assert.equal(b.read().smoke?.state, "pending", "the previous process's smoke result is not shown as this one's");
  assert.equal(b.confirmsRecovery(), false, "a persisted 'healthy' is not evidence for this process");
});

test("tracker: an unreadable or malformed store starts unknown", () => {
  const bad = { read: () => ({ state: "great" }) as unknown as ModelHealth, write: () => {}, persisted: false };
  assert.equal(modelHealthTracker(bad, { log: quiet }).read().state, "unknown");
  const throws = { read: () => { throw new Error("EIO"); }, write: () => { throw new Error("EIO"); }, persisted: true };
  const h = modelHealthTracker(throws, { log: quiet });
  h.record(h.ticket(), { state: "healthy", source: "call" });
  assert.equal(h.read().state, "healthy", "a failed write keeps the in-memory state");
});

// ---- the observer --------------------------------------------------------------------------------------------------------------------

test("observeModel: a primary answer is healthy, a limit is fallback (rethrown unchanged), other errors keep the state", async () => {
  const outcomes: (() => string)[] = [() => "hi", () => { throw usageLimit(); }, () => { throw new ProviderError("auth", "login refused"); }, () => "again"];
  let n = 0;
  const p = primary(() => outcomes[n++]!());
  const h = modelHealthTracker(mem(), { log: quiet });
  const m = observeModel(p.model, h);
  assert.equal((await m.reply([{ role: "user", content: "x" }], [])).value, "hi");
  assert.equal(h.read().state, "healthy");
  assert.equal(h.read().source, "call");
  assert.equal(h.read().model, "gpt-x");
  await assert.rejects(m.reply([{ role: "user", content: "x" }], []), (e: unknown) => e instanceof ProviderError && e.kind === "usage_limit");
  assert.equal(h.read().state, "fallback");
  assert.match(h.read().reason!, /usage limit/);
  await assert.rejects(m.reply([{ role: "user", content: "x" }], []), /login refused/);
  assert.equal(h.read().state, "fallback", "an auth error says nothing about the limit");
  await m.reply([{ role: "user", content: "x" }], []);
  assert.equal(h.read().state, "healthy");
  // The port's other functions stay reachable, and status gains the additive health field.
  assert.equal((m as typeof p.model).signIn(), "extra");
  const st = m.status();
  assert.equal(st.state, "live");
  assert.equal(st.health?.state, "healthy");
});

test("observeModel: a reply or step answered by the fallback is fallback; step is observed; a mock is not evidence", async () => {
  const h = modelHealthTracker(mem(), { log: quiet });
  const info = { provider: "openrouter" as const, model: "vendor/cheap", reason: "usage_limit" as const, primaryLimit: { until: new Date().toISOString(), estimated: true } };
  const viaFallback: ModelPort = {
    status: () => ({ port: "model", state: "degraded", impl: "chatgpt-token-sharing/gpt-x", detail: "", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "paid", provenance: "live", source: "x", fallback: info }),
    step: async () => ({ text: "paid", calls: [], fallback: info }),
  };
  const m = observeModel(viaFallback, h);
  await m.step!([], [], undefined, []);
  assert.equal(h.read().state, "fallback");
  assert.match(h.read().reason!, /vendor\/cheap/);
  const mock: ModelPort = { status: () => ({ port: "model", state: "mock", impl: "mock", detail: "", verifiedAt: new Date(0).toISOString() }), reply: async () => ({ value: "m", provenance: "mock", source: "mock" }) };
  const h2 = modelHealthTracker(mem(), { log: quiet });
  const mm = observeModel(mock, h2);
  assert.equal("step" in mm, false, "a model without tools stays without tools");
  await mm.reply([], []);
  assert.equal(h2.read().state, "unknown");
});

// ---- the smoke check -----------------------------------------------------------------------------------------------------------------

test("smoke check: one minimal call to the primary, never the paid fallback; a pass marks healthy and logs model and latency", async () => {
  const p = primary(() => "ok");
  const h = modelHealthTracker(mem(), { log: quiet });
  const lines: Record<string, unknown>[] = [];
  const c = modelSmokeCheck({ model: p.model, health: h, log: (l) => lines.push(l) });
  assert.equal(c.skip!(), undefined);
  const out = await c.run!(new AbortController().signal);
  assert.equal(out.state, "passed");
  assert.equal(p.calls.length, 1, "exactly one call");
  const call = p.calls[0]!;
  assert.deepEqual(call.messages, [{ role: "user", content: MODEL_SMOKE_PROMPT }], "a fixed prompt, no history");
  assert.deepEqual(call.limits, []);
  assert.equal(call.notes, undefined);
  assert.equal(call.opts?.fallback, false, "the paid fallback is never spent");
  assert.ok(call.opts?.signal instanceof AbortSignal, "the call is bounded");
  assert.equal(h.read().state, "healthy");
  assert.equal(h.read().source, "smoke");
  assert.equal(h.read().smoke?.state, "passed");
  assert.equal(typeof h.read().smoke?.latencyMs, "number");
  assert.equal(h.confirmsRecovery(), true);
  assert.deepEqual(lines.map((l) => l.model_smoke), ["started", "passed"]);
  assert.equal(lines[1]!.model, "gpt-x");
  assert.equal(typeof lines[1]!.latencyMs, "number");
  assert.equal(lines[1]!.health, "healthy");
});

test("smoke check: a usage limit keeps ORBIT in fallback and logs the reason", async () => {
  const p = primary(() => { throw usageLimit(); });
  const h = modelHealthTracker(mem(), { log: quiet });
  const lines: Record<string, unknown>[] = [];
  const out = await modelSmokeCheck({ model: p.model, health: h, log: (l) => lines.push(l) }).run!(new AbortController().signal);
  assert.equal(out.state, "failed");
  assert.match((out as { reason: string }).reason, /^usage_limit: /);
  assert.equal(h.read().state, "fallback");
  assert.equal(h.read().smoke?.kind, "usage_limit");
  assert.equal(h.confirmsRecovery(), false);
  assert.equal(lines[1]!.model_smoke, "failed");
  assert.equal(lines[1]!.kind, "usage_limit");
  assert.match(String(lines[1]!.reason), /usage limit/);
});

test("smoke check: a timeout is abandoned within a few seconds, keeps the earlier fallback state and says timeout", async () => {
  const p = primary((opts) => new Promise((_, reject) => opts!.signal!.addEventListener("abort", () => reject(new ProviderError("cancelled", "cancelled")))));
  const store = mem();
  store.write({ state: "fallback", since: "2026-11-25T06:00:00.000Z", at: "2026-11-25T06:00:00.000Z", source: "call", reason: "ChatGPT usage limit" });
  const h = modelHealthTracker(store, { log: quiet });
  const lines: Record<string, unknown>[] = [];
  const c = modelSmokeCheck({ model: p.model, health: h, timeoutMs: 50, log: (l) => lines.push(l) });
  assert.ok(c.timeoutMs <= 10_000, "the runner's backstop is a few seconds");
  const t0 = Date.now();
  const out = await c.run!(new AbortController().signal);
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(out.state, "failed");
  assert.match((out as { reason: string }).reason, /^timeout: no answer within 50 ms/);
  assert.equal(h.read().state, "fallback", "kept");
  assert.equal(h.read().smoke?.kind, "timeout");
  assert.equal(lines[1]!.kind, "timeout");
});

test("smoke check: a mock or a model that is down before any call is skipped with no call", async () => {
  const mock = primary(() => "x", "mock");
  const h = modelHealthTracker(mem(), { log: quiet });
  assert.equal(modelSmokeCheck({ model: mock.model, health: h, log: quiet }).skip!()?.kind, "mock");
  const down = primary(() => "x", "down");
  const s = modelSmokeCheck({ model: down.model, health: h, log: quiet }).skip!();
  assert.equal(s?.kind, "unconfigured");
  assert.equal(h.read().smoke?.state, "skipped");
  assert.equal(mock.calls.length + down.calls.length, 0);
});

test("smoke check through the OpenRouter fallback wrapper: a limited primary sends nothing to OpenRouter and records fallback", async () => {
  let fetches = 0;
  const fetcher = (async () => (fetches++, new Response("{}"))) as unknown as typeof fetch;
  const config = openrouterConfig(
    { ORBIT_OPENROUTER_ENABLED: "1", ORBIT_OPENROUTER_MODEL: "vendor/cheap-model", ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2", ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4", CREDENTIALS_DIRECTORY: "/creds" },
    () => ["k", "x".repeat(20)].join("-"),
  );
  const p = primary(() => { throw usageLimit(); });
  const wrapped = fallbackModel({ primary: p.model, config, fetcher, logHold: quiet });
  const h = modelHealthTracker(mem(), { log: quiet });
  const out = await modelSmokeCheck({ model: wrapped, health: h, log: quiet }).run!(new AbortController().signal);
  assert.equal(out.state, "failed");
  assert.equal(fetches, 0, "no paid request");
  assert.equal(p.calls.length, 1);
  assert.equal(h.read().state, "fallback");
  assert.equal(wrapped.fallbackState().usingFallback, true, "the wrapper recorded the limit, as after a real call");
  // And a healthy primary behind the wrapper passes.
  const ok = primary(() => "ok");
  const h2 = modelHealthTracker(mem(), { log: quiet });
  assert.equal((await modelSmokeCheck({ model: fallbackModel({ primary: ok.model, config, fetcher, logHold: quiet }), health: h2, log: quiet }).run!(new AbortController().signal)).state, "passed");
  assert.equal(h2.read().state, "healthy");
});

test("orbitSmokeChecks: with `model` the model entry is the real check; without it the model is skipped as before", () => {
  const live = (port: string) => ({ status: () => ({ port, state: "live" as const, impl: "x", detail: "", verifiedAt: new Date().toISOString() }) });
  const base = { base: () => undefined, processStart: new Date(), memory: { ...live("memory"), search: () => ({}) }, modelMock: () => false, schedule: live("schedule"), runs: live("runs"), nodes: live("nodes") };
  const without = orbitSmokeChecks(base).find((c) => c.id === "model")!;
  assert.equal(without.run, undefined);
  assert.equal(without.skip!()?.kind, "paid");
  const p = primary(() => "ok");
  const withModel = orbitSmokeChecks({ ...base, model: { port: p.model, health: modelHealthTracker(mem(), { log: quiet }) } }).find((c) => c.id === "model")!;
  assert.equal(typeof withModel.run, "function");
  assert.equal(withModel.evidence, "functional");
});

// ---- the watch: no false "model restored" after a deploy ---------------------------------------------------------------------------

// The situation after a deploy: the watch's persisted record says the model was alerted on (it was limited before the restart), and
// the new process's model port reports `live` from its local login check before any call.
function afterDeploy(script: Script) {
  const t0 = new Date("2026-11-05T20:00:00Z").getTime();
  let t = t0 + 60 * 60_000;
  const now = () => new Date(t);
  const store = jsonStore<WatchState>(undefined, "w", { ports: { model: { since: new Date(t0).toISOString(), state: "down" } } });
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, now);
  const healthStore = mem();
  healthStore.write({ state: "fallback", since: new Date(t0).toISOString(), at: new Date(t0).toISOString(), source: "call", reason: "ChatGPT usage limit" });
  const health = modelHealthTracker(healthStore, { log: quiet });
  const p = primary(script);
  const model = observeModel(p.model, health);
  const watch = watcher(store, notify, now, undefined, { modelRecovery: health.confirmsRecovery });
  watch.attach(() => [model.status() as PortStatus]);
  const smoke = smokeRunner({ identity: { commit: "c".repeat(40), pid: 1, startedAt: new Date().toISOString() }, log: quiet, checks: [modelSmokeCheck({ model: p.model, health, log: quiet })] });
  const texts = () => notify.recent().map((n) => n.text);
  return { watch, smoke, texts, store, health, p, advance: (min: number) => void (t += min * 60_000) };
}

test("after a deploy while still limited: the stale local 'live' sends no 'model restored', and the smoke check keeps fallback", async () => {
  const r = afterDeploy(() => { throw usageLimit(); });
  // The first watch tick runs before the smoke check has finished: the stale "live" must not be reported as a recovery.
  r.watch.tick();
  assert.deepEqual(r.texts(), []);
  assert.ok(r.store.read().ports.model, "the alert record is kept");
  await r.smoke.start();
  assert.equal(r.health.read().state, "fallback");
  for (let i = 0; i < 4; i++) {
    r.advance(1);
    r.watch.tick();
  }
  assert.deepEqual(r.texts(), [], "no false 'live again' and no new alert for a model that was already reported");
  assert.equal(r.p.calls.length, 1, "one smoke call only");
});

test("after a deploy when the primary really answers: the smoke check confirms it and the recovery is reported once", async () => {
  const r = afterDeploy(() => "ok");
  r.watch.tick();
  assert.deepEqual(r.texts(), [], "held until the smoke check answers");
  await r.smoke.start();
  assert.equal(r.health.read().state, "healthy");
  r.watch.tick();
  r.watch.tick();
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0]!, /"model" is live again/);
  assert.equal(r.store.read().ports.model, undefined);
});

test("after a deploy where the smoke check times out: the notice waits for a real primary answer", async () => {
  let first = true;
  const r = afterDeploy((opts) => {
    if (!first) return "ok";
    first = false;
    return new Promise((_, reject) => opts!.signal!.addEventListener("abort", () => reject(new ProviderError("cancelled", "cancelled"))));
  });
  r.smoke = smokeRunner({ identity: { commit: "c".repeat(40), pid: 1, startedAt: new Date().toISOString() }, log: quiet, checks: [modelSmokeCheck({ model: r.p.model, health: r.health, timeoutMs: 30, log: quiet })] });
  await r.smoke.start();
  assert.equal(r.health.read().state, "fallback", "a timeout keeps the earlier state");
  r.watch.tick();
  assert.deepEqual(r.texts(), []);
  // A real call (through the observed port every caller uses) answers from the primary: now the recovery is real.
  const observed = observeModel(r.p.model, r.health);
  await observed.reply([{ role: "user", content: "hello" }], []);
  r.watch.tick();
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0]!, /live again/);
});

test("the gate only affects the model's recovery notice; other ports and watches without a gate are unchanged", () => {
  const t = new Date("2026-11-05T20:00:00Z").getTime();
  const store = jsonStore<WatchState>(undefined, "w", { ports: { memory: { since: new Date(t - 3_600_000).toISOString(), state: "down" } } });
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, () => new Date(t));
  const watch = watcher(store, notify, () => new Date(t), undefined, { modelRecovery: () => false });
  watch.attach(() => [{ port: "memory", state: "live", impl: "x", detail: "", verifiedAt: new Date(t).toISOString() }]);
  watch.tick();
  assert.equal(notify.recent().length, 1);
  assert.match(notify.recent()[0]!.text, /"memory" is live again/);
});

// ---- /status: ORBIT in fallback is degraded, not unknown ---------------------------------------------------------------------------

// The page's own aggregation, loaded from the page as the page tests do.
type Overall = { level: "ok" | "degraded" | "down" | "unknown"; ok: boolean; label: string; detail: string };
const pageBlock = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8").match(/\/\/ <status-dot>([\s\S]*?)\/\/ <\/status-dot>/)![1]!;
const { aggregateStatus } = new Function(`${pageBlock}; return { aggregateStatus };`)() as { aggregateStatus: (s: unknown) => Overall };
const livePort = (port: string): PortStatus => ({ port, state: "live", impl: "x", detail: `${port} detail`, verifiedAt: new Date().toISOString() });
// The overall level with every other port live, so the model alone decides it.
const overall = (model: PortStatus) => aggregateStatus({ ports: JSON.parse(JSON.stringify([livePort("policy"), livePort("channel"), withAvailability(model), livePort("memory")])) });

// The deployed shape (src/main.ts): ChatGPT behind the OpenRouter fallback wrapper (configured, ledger provisioned, a fake OpenRouter),
// observed by the health tracker; the smoke check gets the built port and the tracker. Nothing contacts a provider.
function deployed(o: { saved?: ModelHealth } = {}) {
  const sw = { limited: true, openrouter: "ok" as "ok" | "error" };
  let fetches = 0;
  const fetcher = (async () => {
    fetches++;
    if (sw.openrouter === "error") return new Response(JSON.stringify({ error: { message: "provider unavailable" } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fallback answer" } }], usage: { cost: 0.0001 } }));
  }) as unknown as typeof fetch;
  const config = openrouterConfig(
    { ORBIT_OPENROUTER_ENABLED: "1", ORBIT_OPENROUTER_MODEL: "vendor/cheap-model", ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2", ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4", ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048", CREDENTIALS_DIRECTORY: "/creds" },
    () => ["k", "x".repeat(20)].join("-"),
  );
  const ledger = provisioned(mkdtempSync(join(tmpdir(), "orbit-health-status-")), { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  const p = primary(() => {
    if (sw.limited) throw usageLimit();
    return "ok";
  });
  const built = fallbackModel({ primary: p.model, config, ledger, fetcher, logHold: quiet });
  const store = mem();
  if (o.saved) store.write(o.saved);
  const health = modelHealthTracker(store, { log: quiet });
  const model = observeModel(built, health);
  const smoke = () => modelSmokeCheck({ model: built, health, log: quiet }).run!(new AbortController().signal);
  return { sw, built, model, health, smoke, fetches: () => fetches };
}

test("/status: ChatGPT limited and the fallback not called yet is degraded with a clear message, and ORBIT's overall status is degraded, not unknown", async () => {
  const d = deployed();
  // The post-deploy smoke check hits the limit: the tracker says fallback; nothing is sent to OpenRouter.
  assert.equal((await d.smoke()).state, "failed");
  assert.equal(d.health.read().state, "fallback");
  assert.equal(d.fetches(), 0);
  const x = rig({ model: d.model });
  const res = await x.api("/status");
  assert.equal(res.status, 200);
  const m = res.data.ports.find((p: PortStatus) => p.port === "model") as PortStatus;
  assert.equal(m.state, "degraded");
  assert.equal(m.health?.state, "fallback");
  assert.deepEqual([m.availability?.available, m.availability?.via], [true, "fallback"]);
  assert.match(m.availability!.reason, /^ChatGPT is at its usage limit; using the OpenRouter fallback \(vendor\/cheap-model\) until \S+: it has not been called since the limit began, so it is not confirmed yet\.$/);
  assert.doesNotMatch(m.availability!.reason, /is not known/);
  // The page's overall status, from the real /status body: degraded (amber), never unknown, with the same message.
  const r = aggregateStatus(res.data);
  assert.deepEqual([r.level, r.ok, r.label], ["degraded", false, "Degraded: fallback model"]);
  assert.match(r.detail, /ChatGPT is at its usage limit; using the OpenRouter fallback \(vendor\/cheap-model\)/);
  assert.doesNotMatch(r.detail, /Whether a model can reply is not known/);
  // With the model the only port not live, the overall status is degraded because of it.
  const only = overall(d.model.status());
  assert.deepEqual([only.level, only.label], ["degraded", "Degraded: fallback model"]);
  assert.match(only.detail, /Not live: model: degraded\.$/);
  // The first fallback answer keeps it amber, now with the route named as before.
  await d.model.reply([{ role: "user", content: "hi" }], []);
  assert.equal(d.fetches(), 1);
  const after = overall(d.model.status());
  assert.deepEqual([after.level, after.label], ["degraded", "Degraded: fallback model"]);
  assert.match(after.detail, /Replies come from the fallback model openrouter\/vendor\/cheap-model, not ChatGPT/);
  x.close();
});

test("/status after a deploy while in fallback: degraded before the smoke check, and the smoke check's result shows at the next /status", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  // Limited before the restart: the tracker's saved state is fallback; the new process's port reports `live` from the local login check.
  const d = deployed({ saved: { state: "fallback", since: at, at, source: "call", model: "gpt-x", reason: "ChatGPT usage limit: ChatGPT usage limit reached for this plan." } });
  const x = rig({ model: d.model });
  const model = async () => (await x.api("/status")).data.ports.find((p: PortStatus) => p.port === "model") as PortStatus;
  let m = await model();
  assert.equal(m.state, "degraded", "the stale local 'live' is not reported while the tracker says fallback");
  assert.match(m.detail, /^In fallback \(model health\): ChatGPT usage limit/);
  assert.deepEqual([m.availability?.available, m.availability?.via], [true, "primary"]);
  assert.match(m.availability!.reason, /^ORBIT is in fallback: ChatGPT usage limit: ChatGPT usage limit reached for this plan \(a model call at \S+\)\. The limit is not recorded in this process yet, so the next call tries ChatGPT first/);
  assert.equal(overall(m).level, "degraded");
  assert.equal(overall(m).label, "Degraded: fallback model");
  // The smoke check still hits the limit: the very next /status shows it (no restart, no cache), from the wrapper's own limit record.
  await d.smoke();
  m = await model();
  assert.equal(m.state, "degraded");
  assert.equal(m.health?.source, "smoke");
  assert.equal(m.availability?.via, "fallback");
  assert.match(m.availability!.reason, /^ChatGPT is at its usage limit; using the OpenRouter fallback/);
  assert.equal(overall(m).level, "degraded");
  x.close();

  // A second deploy where ChatGPT answers again: the smoke check makes it healthy and the next /status is live and green.
  const ok = deployed({ saved: { state: "fallback", since: at, at, source: "call", reason: "ChatGPT usage limit" } });
  ok.sw.limited = false;
  const y = rig({ model: ok.model });
  const first = (await y.api("/status")).data.ports.find((p: PortStatus) => p.port === "model") as PortStatus;
  assert.equal(first.state, "degraded");
  assert.equal((await ok.smoke()).state, "passed");
  const next = (await y.api("/status")).data.ports.find((p: PortStatus) => p.port === "model") as PortStatus;
  assert.deepEqual([next.state, next.health?.state, next.availability?.available, next.availability?.via], ["live", "healthy", true, "primary"]);
  assert.deepEqual([overall(next).level, overall(next).label], ["ok", "All live"]);
  y.close();
});

test("/status: unknown only when nothing has been recorded; a real dual failure stays down (red) even in fallback", async () => {
  // Nothing recorded: the tracker is unknown, so it changes nothing (a live port stays live; a limit the tracker never saw stays null).
  const fresh = deployed();
  assert.equal(fresh.health.read().state, "unknown");
  fresh.sw.limited = false;
  assert.deepEqual([withAvailability(fresh.model.status()).state, modelAvailability(fresh.model.status()).available], ["live", true]);
  fresh.sw.limited = true;
  // A background call made straight on the built port (not observed): the wrapper records the limit, the tracker does not.
  await assert.rejects(fresh.built.step!([{ role: "user", content: "compact" }], [], undefined, []), /usage limit/);
  assert.equal(fresh.health.read().state, "unknown");
  const unseen = withAvailability(fresh.model.status());
  assert.deepEqual([unseen.state, unseen.availability?.available], ["degraded", null]);
  assert.equal(overall(fresh.model.status()).level, "unknown");
  // In fallback, then the OpenRouter call fails too: no model can reply, so it is down and red, not amber.
  const d = deployed();
  await d.smoke();
  d.sw.openrouter = "error";
  await assert.rejects(d.model.reply([{ role: "user", content: "hi" }], []));
  assert.equal(d.health.read().state, "fallback");
  const st = withAvailability(d.model.status());
  assert.deepEqual([st.state, st.availability?.available, st.availability?.via], ["down", false, "none"]);
  assert.equal(overall(d.model.status()).level, "down");
  // A mock is never available, whatever the tracker says.
  const mock: PortStatus = { ...livePort("model"), state: "mock", health: { state: "fallback", since: "t", at: "t", source: "call" } };
  assert.equal(modelAvailability(mock).available, false);
});
