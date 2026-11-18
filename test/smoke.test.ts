import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { embeddingBudget, embeddingsConfig, embeddingsStatus, openaiEmbedder } from "../src/embeddings.ts";
import type { EmbeddingsSettings } from "../src/embeddings.ts";
import { ON_DEMAND_PORTS, withCheck, withFreshness } from "../src/server.ts";
import { embeddingsCheck, observedCheck, orbitSmokeChecks, SMOKE_EMBED_TEXT } from "../src/smoke-checks.ts";
import { processIdentity, sanitize, smokeRunner } from "../src/smoke.ts";
import type { CheckOutcome, SmokeCheck } from "../src/smoke.ts";
import { rig } from "./threads-fixture.ts";

// Startup smoke checks (src/smoke.ts, src/smoke-checks.ts, docs/smoke-checks.md). Every provider response here is a deterministic MOCK
// at the HTTP boundary of the real embeddings adapter: nothing contacts OpenAI or any other provider, and nothing here proves that a
// real key, model or deployment works. The last test starts the real `node src/main.ts` with no credentials.

/* eslint-disable @typescript-eslint/no-explicit-any */
// A fake key built at runtime (no secret-shaped literal in the repository).
const KEY = ["sk", "proj", "x".repeat(40)].join("-");
const ID = { commit: "c".repeat(40), pid: 4242, startedAt: "2026-11-17T00:00:00.000Z" };
const quiet = () => {};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const check = (id: string, run: SmokeCheck["run"], over: Partial<SmokeCheck> = {}): SmokeCheck => ({ id, port: id, property: `${id} works`, evidence: "functional", timeoutMs: 1_000, cost: "test", run, ...over });

// ---- the runner ---------------------------------------------------------------------------------------------------------------------

test("records start pending, show running while a check runs, then the observed result; start() is single-flight", async () => {
  const g = gate();
  let calls = 0;
  const r = smokeRunner({ identity: ID, log: quiet, checks: [check("a", async () => (calls++, await g.p, { state: "passed", detail: "ok" }))] });
  assert.equal(r.summary().state, "pending");
  assert.equal(r.forPort("a")!.state, "pending");
  assert.equal(r.forPort("a")!.verifiedAt, undefined);
  const p1 = r.start();
  const p2 = r.start();
  assert.equal(p1, p2, "the same run");
  await tick();
  assert.equal(r.summary().state, "running");
  assert.equal(r.forPort("a")!.state, "running");
  g.open();
  await p1;
  await r.start();
  assert.equal(calls, 1, "one run per process");
  const a = r.forPort("a")!;
  assert.equal(a.state, "passed");
  assert.ok(a.verifiedAt && a.observedAt && a.startedAt && typeof a.durationMs === "number");
  assert.equal(r.summary().state, "done");
  assert.equal(r.summary().counts.passed, 1);
});

test("isolation: a throwing, a hanging and a failing check each get their own record; the others pass", async () => {
  const r = smokeRunner({
    identity: ID,
    log: quiet,
    totalMs: 5_000,
    checks: [
      check("throws", async () => {
        throw new Error("boom");
      }),
      check("hangs", () => new Promise<CheckOutcome>(() => {}), { timeoutMs: 50 }),
      check("fails", async () => ({ state: "failed", reason: "said no" })),
      check("fine", async () => ({ state: "passed" })),
    ],
  });
  await r.start();
  const s = Object.fromEntries(r.summary().checks.map((c) => [c.id, c]));
  assert.equal(s.throws.state, "failed");
  assert.match(s.throws.reason!, /boom/);
  assert.equal(s.hangs.state, "failed");
  assert.match(s.hangs.reason!, /^timeout/);
  assert.equal(s.fails.state, "failed");
  assert.equal(s.fine.state, "passed");
  for (const c of [s.throws, s.hangs, s.fails]) assert.equal(c.verifiedAt, undefined, "only a pass sets verifiedAt");
});

test("a result that arrives after the check's deadline is ignored; its signal was aborted", async () => {
  const g = gate();
  let aborted = false;
  const r = smokeRunner({
    identity: ID,
    log: quiet,
    checks: [
      check("late", async (signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        await g.p;
        return { state: "passed" };
      }, { timeoutMs: 30 }),
    ],
  });
  await r.start();
  assert.equal(r.forPort("late")!.state, "failed");
  assert.ok(aborted);
  g.open();
  await tick(10);
  assert.equal(r.forPort("late")!.state, "failed", "the late pass did not overwrite the record");
  assert.equal(r.forPort("late")!.verifiedAt, undefined);
});

test("bounded concurrency and a total deadline: checks not finished in time are untested, not failed", async () => {
  let peak = 0;
  let live = 0;
  const slow = (id: string) =>
    check(id, async (signal) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => {
        const t = setTimeout(r, 1_000);
        signal.addEventListener("abort", () => (clearTimeout(t), r(undefined)));
      });
      live--;
      return { state: "passed" };
    }, { timeoutMs: 5_000 });
  const r = smokeRunner({ identity: ID, log: quiet, concurrency: 2, totalMs: 60, checks: ["a", "b", "c", "d", "e"].map(slow) });
  const t0 = Date.now();
  await r.start();
  assert.ok(Date.now() - t0 < 900, "the total deadline bounds the run");
  assert.equal(peak, 2);
  const states = r.summary().checks.map((c) => c.state);
  assert.deepEqual(states, ["untested", "untested", "untested", "untested", "untested"]);
  assert.ok(r.summary().checks.every((c) => /deadline/.test(c.reason!)));
});

test("a skipped check never runs; skip reasons and kinds are recorded", async () => {
  let ran = false;
  const r = smokeRunner({ identity: ID, log: quiet, checks: [check("x", async () => ((ran = true), { state: "passed" }), { skip: () => ({ kind: "disabled", reason: "off" }) })] });
  await r.start();
  assert.equal(ran, false);
  assert.deepEqual([r.forPort("x")!.state, r.forPort("x")!.skip, r.forPort("x")!.reason], ["skipped", "disabled", "off"]);
});

test("stale: a pass older than the window reads as stale; verifiedAt still says when it passed", async () => {
  let t = Date.parse("2026-11-17T01:00:00Z");
  const r = smokeRunner({ identity: ID, log: quiet, now: () => new Date(t), staleAfterMs: 1_000, checks: [check("a", async () => ({ state: "passed" }))] });
  await r.start();
  assert.equal(r.forPort("a")!.state, "passed");
  t += 2_000;
  assert.equal(r.forPort("a")!.state, "stale");
  assert.equal(r.forPort("a")!.verifiedAt, "2026-11-17T01:00:00.000Z");
  assert.equal(r.summary().counts.stale, 1);
});

test("evidence is tied to the serving process: a new process starts with every record pending and nothing verified", async () => {
  const first = smokeRunner({ identity: ID, log: quiet, checks: [check("a", async () => ({ state: "passed" }))] });
  await first.start();
  const second = smokeRunner({ identity: { ...ID, pid: 4343, startedAt: "2026-11-17T00:05:00.000Z" }, log: quiet, checks: [check("a", async () => ({ state: "passed" }))] });
  assert.notEqual(first.runId, second.runId);
  assert.equal(second.forPort("a")!.state, "pending");
  assert.equal(second.forPort("a")!.verifiedAt, undefined);
  assert.equal(second.summary().process.pid, 4343);
  assert.equal(first.summary().checks[0].runId, first.runId);
  const me = processIdentity("abc");
  assert.equal(me.pid, process.pid);
  assert.ok(Date.parse(me.startedAt) <= Date.now());
});

test("sanitize: reasons are one short line and never carry key- or token-shaped text", () => {
  const gh = ["gh", "p_", "a".repeat(36)].join("");
  const jwt = ["ey", "J", "a".repeat(20), ".", "b".repeat(20), ".", "c".repeat(10)].join("");
  const out = sanitize(`failed ${KEY}\nwith Bearer ${"z".repeat(30)} and ${gh} and ${jwt} at https://user:pw@host.example/x and token=${"q".repeat(20)}`);
  for (const bad of [KEY, gh, jwt, "z".repeat(30), "user:pw", "q".repeat(20)]) assert.equal(out.includes(bad), false, bad);
  assert.equal(out.includes("\n"), false);
  assert.ok(sanitize("x".repeat(1000).replace(/x/g, "x ")).length <= 201);
});

// ---- the embeddings probe through the real adapter -------------------------------------------------------------------------------

const settings = (over: Partial<EmbeddingsSettings> = {}): EmbeddingsSettings => ({ model: "text-embedding-3-small", dims: 4, sendDimensions: false, dailyRequests: 50, dailyTokens: 100_000, ...over });
const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okBody = (dims = 4) => JSON.stringify({ object: "list", model: "text-embedding-3-small", data: [{ object: "embedding", index: 0, embedding: Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0.25)) }], usage: { prompt_tokens: 4, total_tokens: 4 } });
type Reply = Response | Error | ((signal: AbortSignal | undefined) => Promise<Response>);
function provider(replies: Reply[], over: { settings?: Partial<EmbeddingsSettings>; timeoutMs?: number } = {}) {
  const bodies: any[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies.shift();
    if (!r) throw new Error("unexpected extra request");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(init.signal ?? undefined) : r;
  }) as unknown as typeof fetch;
  const s = settings(over.settings);
  const budget = embeddingBudget(undefined, s);
  const embedder = openaiEmbedder({ key: KEY, settings: s, budget, fetcher, sleep: async () => {}, timeoutMs: over.timeoutMs });
  const config = { state: "ready" as const, key: KEY, settings: s };
  return { bodies, budget, embedder, config, status: () => embeddingsStatus(config, embedder, budget) };
}
const runEmbeddings = async (p: ReturnType<typeof provider>, timeoutMs?: number) => {
  const lines: string[] = [];
  const r = smokeRunner({ identity: ID, log: (l) => lines.push(JSON.stringify(l)), checks: [embeddingsCheck({ config: p.config, embedder: p.embedder, budget: p.budget, timeoutMs })] });
  await r.start();
  return { rec: r.forPort("photo-embeddings")!, lines };
};

test("configured embeddings: one request with the fixed synthetic string through the adapter; the port goes from not-verified to live", async () => {
  const p = provider([json(200, okBody())]);
  const before = p.status();
  assert.equal(before.state, "degraded", "not live from configuration alone");
  assert.equal(before.verifiedAt, new Date(0).toISOString());
  assert.match(before.detail, /not verified yet/);
  const { rec } = await runEmbeddings(p);
  assert.equal(rec.state, "passed", JSON.stringify(rec));
  assert.equal(p.bodies.length, 1);
  assert.deepEqual(p.bodies[0].input, [SMOKE_EMBED_TEXT]);
  assert.equal(p.bodies[0].model, "text-embedding-3-small");
  const after = p.status();
  assert.equal(after.state, "live");
  assert.ok(Date.parse(after.verifiedAt) > 0);
  assert.equal(p.budget.used().requests, 1, "counted against the daily budget");
  assert.ok(Buffer.byteLength(SMOKE_EMBED_TEXT) <= 32);
});

test("embeddings provider errors are failures with the honest kind, each from exactly one request (no retry storm)", async () => {
  const cases: [string, Reply, RegExp, number?][] = [
    ["auth", json(401, { error: { code: "invalid_api_key", message: `Incorrect API key provided: ${KEY}` } }), /^auth:/],
    ["quota", json(429, { error: { code: "insufficient_quota", type: "insufficient_quota" } }), /^quota:/],
    ["rate-limit", json(429, { error: { code: "rate_limit_exceeded" } }), /^rate-limit:/],
    ["server", json(503, "unavailable"), /^server:/],
    ["malformed shape", json(200, okBody(3)), /^malformed:/],
    ["malformed json", json(200, "not json"), /^malformed:/],
    ["non-finite", json(200, okBody().replace("0.25", "1e999")), /^malformed:/],
    ["network", new TypeError(`connect failed ${KEY}`), /^network:/],
  ];
  for (const [name, reply, reason] of cases) {
    const p = provider([reply]);
    const { rec, lines } = await runEmbeddings(p);
    assert.equal(rec.state, "failed", name);
    assert.match(rec.reason!, reason, name);
    assert.equal(p.bodies.length, 1, `${name}: one request`);
    assert.equal(rec.verifiedAt, undefined, name);
    assert.equal(JSON.stringify(rec).includes(KEY), false, `${name}: no key in the record`);
    assert.equal(lines.join("").includes(KEY), false, `${name}: no key in the log`);
    assert.equal(JSON.stringify(p.status()).includes(KEY), false, `${name}: no key in /status`);
    assert.notEqual(p.status().state, "live", name);
  }
});

test("embeddings timeout: the adapter's request deadline fails the check with one request", async () => {
  const hang: Reply = (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const p = provider([hang], { timeoutMs: 30 });
  const { rec } = await runEmbeddings(p, 2_000);
  assert.equal(rec.state, "failed");
  assert.match(rec.reason!, /^timeout:/);
  assert.equal(p.bodies.length, 1);
});

test("embeddings disabled, unconfigured or out of budget: skipped with the reason, nothing built or sent", async () => {
  const off = embeddingsConfig({});
  const mis = embeddingsConfig({ ORBIT_PHOTO_SEMANTIC: "on" }, () => undefined);
  for (const [cfg, kind] of [[off, "disabled"], [mis, "unconfigured"]] as const) {
    const r = smokeRunner({ identity: ID, log: quiet, checks: [embeddingsCheck({ config: cfg, embedder: undefined, budget: undefined })] });
    await r.start();
    assert.equal(r.forPort("photo-embeddings")!.state, "skipped");
    assert.equal(r.forPort("photo-embeddings")!.skip, kind);
  }
  const p = provider([], { settings: { dailyRequests: 1 } });
  p.budget.reserve(1);
  const { rec } = await runEmbeddings(p);
  assert.deepEqual([rec.state, rec.skip], ["skipped", "budget"]);
  assert.equal(p.bodies.length, 0);
});

test("ordering: a late probe failure does not hide a newer real search success, and the record is marked superseded", async () => {
  const probe = gate();
  const p = provider([async () => (await probe.p, json(503, "unavailable")), json(200, okBody())]);
  const r = smokeRunner({ identity: ID, log: quiet, checks: [embeddingsCheck({ config: p.config, embedder: p.embedder, budget: p.budget })] });
  const running = r.start();
  await tick(5);
  // A real search starts after the probe and succeeds first.
  await tick(2);
  await p.embedder.embed(["a real search"]);
  assert.equal(p.status().state, "live");
  probe.open();
  await running;
  assert.equal(r.forPort("photo-embeddings")!.state, "failed");
  const st = withCheck(p.status(), r.forPort("photo-embeddings"));
  assert.equal(st.state, "live", "the newer real success still decides the port");
  assert.equal(st.check!.superseded, true);
});

test("ordering: an older call's late success does not hide a newer failure", async () => {
  const slow = gate();
  const p = provider([async () => (await slow.p, json(200, okBody())), json(503, "down")]);
  const older = p.embedder.embed(["older"], undefined, { attempts: 1 });
  await tick(2);
  await assert.rejects(p.embedder.embed(["newer"], undefined, { attempts: 1 }));
  slow.open();
  await older;
  assert.equal(p.status().state, "degraded");
});

test("photo-embeddings and model are on-demand: /status does not age them into degraded; other ports keep the 5-minute rule", () => {
  const old = { state: "live" as const, impl: "x", detail: "d", verifiedAt: "2026-11-17T00:00:00.000Z" };
  const later = new Date("2026-11-17T01:00:00Z");
  assert.ok(ON_DEMAND_PORTS.has("photo-embeddings"));
  assert.equal(withFreshness({ ...old, port: "photo-embeddings" }, later).state, "live");
  assert.equal(withFreshness({ ...old, port: "model" }, later).state, "live");
  assert.equal(withFreshness({ ...old, port: "nodes" }, later).state, "degraded");
});

test("observed checks: untested when nothing was observed, failed only when the port reports down, passed on live evidence from this process", async () => {
  const start = new Date();
  const mk = (state: "live" | "down" | "degraded", at: string) => observedCheck({ port: "p", property: "ticked", status: () => ({ port: "p", state, impl: "x", detail: "d", verifiedAt: at }), processStart: start, timeoutMs: 40, pollMs: 10 });
  const run = async (c: SmokeCheck) => {
    const r = smokeRunner({ identity: ID, log: quiet, checks: [c] });
    await r.start();
    return r.forPort("p")!;
  };
  assert.equal((await run(mk("live", new Date(0).toISOString()))).state, "untested");
  assert.equal((await run(mk("degraded", new Date().toISOString()))).state, "untested");
  assert.equal((await run(mk("down", new Date(Date.now() + 1).toISOString()))).state, "failed");
  assert.equal((await run(mk("live", new Date(Date.now() + 1).toISOString()))).state, "passed");
});

// ---- the real server: start on listening, /status read-only ------------------------------------------------------------------------

test("real server: the suite starts on listening with no user activity; GET /status reports pending/running then results and never probes", async () => {
  const g = gate();
  let probes = 0;
  const p = provider([async () => (probes++, await g.p, json(200, okBody()))]);
  let base: () => string | undefined = () => undefined;
  const smoke = smokeRunner({
    identity: { ...ID, startedAt: new Date(Date.now() - 1_000).toISOString() },
    log: quiet,
    checks: orbitSmokeChecks({
      base: () => base(),
      processStart: new Date(Date.now() - 1_000),
      memory: { status: () => ({ port: "memory", state: "live", impl: "vault-keyword", detail: "", verifiedAt: new Date().toISOString() }), search: () => ({}) },
      modelMock: () => true,
      schedule: { status: () => ({ port: "schedule", state: "live", impl: "x", detail: "", verifiedAt: new Date().toISOString() }) },
      runs: { status: () => ({ port: "runs", state: "live", impl: "x", detail: "", verifiedAt: new Date().toISOString() }) },
      nodes: { status: () => ({ port: "nodes", state: "live", impl: "x", detail: "", verifiedAt: new Date().toISOString() }) },
      embeddings: { config: p.config, embedder: p.embedder, budget: p.budget },
    }),
  });
  const r = rig({ extra: () => ({ smoke, photoSemantic: { embedder: p.embedder, cacheDir: undefined, status: p.status } }) });
  base = () => {
    const a = r.server.address() as AddressInfo | null;
    return a ? `http://127.0.0.1:${a.port}` : undefined;
  };
  // While the probe is held, /status shows it running and the port not verified.
  let st: any;
  for (let i = 0; i < 50; i++) {
    st = (await r.api("/status")).data;
    if (st.smoke.checks.find((c: any) => c.id === "photo-embeddings").state === "running") break;
    await tick(10);
  }
  const port = () => st.ports.find((x: any) => x.port === "photo-embeddings");
  assert.equal(st.smoke.state, "running");
  assert.equal(port().check.state, "running");
  assert.equal(port().state, "degraded");
  assert.equal(port().verifiedAt, new Date(0).toISOString());
  g.open();
  await smoke.start();
  st = (await r.api("/status")).data;
  assert.equal(st.smoke.state, "done");
  assert.equal(st.smoke.process.commit, ID.commit);
  assert.equal(port().state, "live");
  assert.equal(port().check.state, "passed");
  assert.ok(Date.parse(port().verifiedAt) > 0);
  assert.equal(st.ports.find((x: any) => x.port === "channel").check.state, "passed", "the loopback page check reached the real server");
  for (let i = 0; i < 5; i++) await r.api("/status");
  assert.equal(probes, 1, "GET /status never probes; the suite ran once");
  assert.equal(p.bodies.length, 1);
  // Compatibility: every port state is still one of the four, and the new fields are additive.
  for (const x of st.ports) assert.ok(["live", "mock", "degraded", "down"].includes(x.state), x.port);
  assert.equal(JSON.stringify(st).includes(KEY), false);
  r.server.close();
});

test("real server without a smoke runner: /status has no smoke block and no check fields (unchanged shape)", async () => {
  const r = rig();
  const st = (await r.api("/status")).data;
  assert.equal("smoke" in st, false);
  assert.ok(st.ports.every((x: any) => !("check" in x)));
  r.server.close();
});

test("the status pill shows the smoke record on hover only; the overall indicator still keys on state (and the model's fallback route) alone", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  assert.match(html, /Startup check: \$\{c\.state\}/);
  const dot = html.match(/\/\/ <status-dot>([\s\S]*?)\/\/ <\/status-dot>/)![1]!;
  assert.match(dot, /const bad = entries\.filter\(\(e\) => e\.state !== "live"\);/);
  assert.doesNotMatch(dot, /\.check\b/, "the smoke record never changes the overall level");
});

// ---- the actual startup wiring: node src/main.ts --------------------------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

test("startup wiring: `node src/main.ts` runs the suite by itself and /status advances to results, tied to ORBIT_COMMIT", async () => {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "orbit-smoke-main-"));
  const commit = "a".repeat(40);
  // No credentials at all: semantic search is switched on but has no key, so its check must skip and nothing can reach a provider.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: state, PORT: String(port), HOST: "127.0.0.1", STATE_DIRECTORY: state, ORBIT_COMMIT: commit, ORBIT_PHOTO_SEMANTIC: "on" };
  const child = spawn(process.execPath, ["src/main.ts"], { cwd: new URL("..", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    let st: any;
    for (let i = 0; i < 200; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        st = await res.json();
        if (st.smoke?.state === "done") break;
      } catch {
        // not listening yet
      }
      await tick(100);
    }
    assert.equal(st?.smoke?.state, "done", out);
    assert.equal(st.commit, commit);
    assert.equal(st.smoke.process.commit, commit);
    assert.equal(st.smoke.process.pid, child.pid);
    const by = Object.fromEntries(st.smoke.checks.map((c: any) => [c.id, c]));
    assert.equal(by.channel.state, "passed");
    assert.equal(by.policy.state, "passed");
    assert.equal(by.schedule.state, "passed");
    assert.deepEqual([by["photo-embeddings"].state, by["photo-embeddings"].skip], ["skipped", "unconfigured"]);
    assert.deepEqual([by.model.state, by.model.skip], ["skipped", "mock"]);
    assert.deepEqual([by.notify.state, by.jobs.state], ["skipped", "skipped"]);
    assert.ok(st.smoke.checks.every((c: any) => c.state !== "pending" && c.state !== "running"));
    assert.match(out, /"smoke":"done"/, "the result is logged once by the serving process");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
});
