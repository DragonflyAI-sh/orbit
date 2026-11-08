import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptModel, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import type { PortStatus } from "../src/ports.ts";
import { withFreshness, withStaleness, STALE_AFTER_MS } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { watcher } from "../src/watch.ts";
import type { WatchState } from "../src/watch.ts";

const SEC = 1000;
const MIN = 60 * SEC;
const START = new Date("2026-11-05T20:00:00Z").getTime(); // noon Pacific, outside quiet hours

const sse = (text: string) =>
  `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } })}\n\n`;

// Fake time and a fake auth/inference server. Nothing here touches the network or a real timer.
function rig(over: { expiresIn?: number; expires?: number } = {}) {
  let t = START;
  const now = () => t;
  const file = tokenFile(undefined);
  const first: Tokens = {
    access: "access-0",
    refresh: "refresh-0",
    expires: over.expires ?? START + 60 * MIN,
    idToken: "",
    clientId: "oaiapp_x",
    subject: "user-1",
    scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  };
  // Renewals reuse the saved identity token without verifying it again, but read its subject.
  first.idToken = `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`;
  file.write(first);
  const log = { token: 0, inference: 0 };
  const tokenMode: { mode: "ok" | "fail" | "revoked" | "hold"; release?: () => void; gate?: Promise<void> } = { mode: "ok" };
  let issued = 0;
  const fetcher = (async (url: string) => {
    if (url.endsWith("/oauth/token")) {
      log.token += 1;
      if (tokenMode.mode === "hold") await tokenMode.gate;
      if (tokenMode.mode === "fail") return new Response("{}", { status: 503 });
      if (tokenMode.mode === "revoked") return Response.json({ error: "invalid_grant" }, { status: 400 });
      issued += 1;
      return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: over.expiresIn ?? 3600, token_type: "Bearer" });
    }
    if (url.endsWith("/v1/responses")) {
      log.inference += 1;
      if (inference.status !== 200) return new Response("nope", { status: inference.status });
      return new Response(sse("hi"));
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const inference = { status: 200 };
  const model = chatgptModel("gpt-x", file, { fetcher, now });
  const advance = (ms: number) => void (t += ms);
  const hold = () => {
    tokenMode.mode = "hold";
    tokenMode.gate = new Promise<void>((r) => (tokenMode.release = r));
  };
  return { model, file, log, tokenMode, inference, advance, now, hold };
}


const chat = (m: { reply: (...a: [{ role: "user"; content: string }[], string[]]) => Promise<unknown> }) => m.reply([{ role: "user", content: "x" }], []);
const age = (r: { now: () => number }, s: PortStatus) => r.now() - new Date(s.verifiedAt).getTime();

// The model status as /status and the watch see it: through the same freshness rule the server applies.
function watched() {
  const r = rig();
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, () => new Date(r.now()));
  const watch = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), notify, () => new Date(r.now()));
  watch.attach(() => [withFreshness(r.model.status(), new Date(r.now()))]);
  const tick = async () => {
    await r.model.maintain?.();
    watch.tick();
  };
  const run = async (ms: number) => {
    for (let i = 0; i < ms / (30 * SEC); i++) {
      r.advance(30 * SEC);
      await tick();
    }
  };
  const view = () => withFreshness(r.model.status(), new Date(r.now()));
  return { r, notify, watch, tick, run, view };
}

test("an idle healthy model stays live well past five minutes and the watch stays quiet", async () => {
  const w = watched();
  await chat(w.r.model);
  await w.run(40 * MIN); // login checks only: still inside the token's renewal margin
  assert.equal(w.view().state, "live");
  assert.ok(age(w.r, w.view()) <= 30 * SEC, "background login checks keep verification current");
  assert.equal(w.notify.recent().length, 0);
});

test("with no call at all, successful background login checks keep verification current", async () => {
  const w = watched();
  await w.run(20 * MIN);
  const s = w.view();
  assert.equal(s.state, "live");
  assert.equal(w.r.log.inference, 0, "no model call was made to verify");
  assert.ok(age(w.r, s) <= 30 * SEC);
});

test("a successful renewal updates verification and does not claim a model answer", async () => {
  const w = watched();
  await chat(w.r.model);
  const answered = w.r.model.status().verifiedAt;
  await w.run(55 * MIN);
  assert.equal(w.r.log.token, 1);
  const s = w.view();
  assert.equal(s.state, "live");
  assert.ok(s.verifiedAt > answered);
  assert.equal(w.r.log.inference, 1);
  assert.equal(w.notify.recent().length, 0);
});

test("a failed model call stays down through idle time and login checks, and clears only on a real answer", async () => {
  const w = watched();
  await chat(w.r.model);
  w.r.advance(SEC); // the fake clock must move so the failure is later than the answer
  w.r.inference.status = 500;
  await assert.rejects(chat(w.r.model), /HTTP 500/);
  const failedAt = w.r.model.status().verifiedAt;
  await w.run(20 * MIN);
  const s = w.view();
  assert.equal(s.state, "down");
  assert.match(s.detail, /Last call failed: HTTP 500/);
  assert.equal(s.verifiedAt, failedAt, "login checks do not rewrite the failure's time");
  assert.equal(w.notify.recent().length, 1, "sustained failure alerted once");
  assert.match(w.notify.recent()[0].text, /"model" is down/);
  w.r.inference.status = 200;
  await w.run(5 * MIN);
  assert.equal(w.view().state, "down", "time and login checks are not recovery");
  await chat(w.r.model);
  assert.equal(w.view().state, "live");
  await w.run(MIN);
  assert.match(w.notify.recent()[0].text, /"model" is live again/);
});

test("a failed login renewal is degraded, then down on expiry, and a successful renewal recovers it", async () => {
  const w = watched();
  await chat(w.r.model);
  w.r.tokenMode.mode = "fail";
  await w.run(52 * MIN); // renewal falls due at 50 min and keeps failing; the old token works until 60
  assert.equal(w.view().state, "degraded");
  await w.run(10 * MIN);
  assert.equal(w.view().state, "down");
  const bad = w.view();
  assert.match(bad.detail, /Renewing the ChatGPT login failed/);
  w.r.tokenMode.mode = "ok";
  await w.run(20 * MIN);
  assert.equal(w.view().state, "live");
});

test("a login check never marks verification while a renewal is failing or the token is expired", async () => {
  const r = rig({ expires: START + 3 * MIN });
  r.tokenMode.mode = "fail";
  await r.model.maintain?.();
  const before = r.model.status();
  assert.equal(before.state, "degraded");
  r.advance(10 * MIN);
  await r.model.maintain?.();
  const after = r.model.status();
  assert.equal(after.state, "down");
  assert.notEqual(after.state, "live");
});

test("never exercised: the epoch status still reaches the watch unchanged, which ignores it", async () => {
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, () => new Date(START));
  const watch = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), notify, () => new Date(START + 20 * MIN));
  const epoch: PortStatus = { port: "model", state: "degraded", impl: "x", detail: "Configured but not exercised yet.", verifiedAt: new Date(0).toISOString() };
  assert.deepEqual(withFreshness(epoch, new Date(START)), epoch);
  watch.attach(() => [withFreshness(epoch, new Date(START))]);
  watch.tick();
  assert.equal(notify.recent().length, 0);
});

test("other ports keep the five-minute rule; only the model is exempt", () => {
  const now = new Date("2026-11-05T20:00:00Z");
  const old = new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString();
  for (const port of ["memory", "notify", "nodes", "runs"]) {
    const s: PortStatus = { port, state: "live", impl: "x", detail: "ok", verifiedAt: old };
    assert.equal(withFreshness(s, now).state, "degraded", port);
    assert.deepEqual(withFreshness(s, now), withStaleness(s, now));
  }
  const model: PortStatus = { port: "model", state: "live", impl: "x", detail: "ok", verifiedAt: old };
  assert.equal(withFreshness(model, now).state, "live");
});
