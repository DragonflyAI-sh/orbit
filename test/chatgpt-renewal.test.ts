import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptModel, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
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

test("no background renewal before the margin, and none needs a model call", async () => {
  const r = rig();
  r.advance(49 * MIN); // 11 minutes left, margin is 10
  await r.model.maintain?.();
  assert.equal(r.log.token, 0);
  assert.equal(r.model.status().state, "live");
});

test("renews inside the margin with no inference call, persists the new expiry and stays live", async () => {
  const r = rig();
  r.advance(51 * MIN); // 9 minutes left
  await r.model.maintain?.();
  assert.deepEqual(r.log, { token: 1, inference: 0 });
  assert.equal(r.file.read()?.access, "access-1");
  assert.equal(r.file.read()?.expires, r.now() + 60 * MIN);
  const s = r.model.status();
  assert.equal(s.state, "live");
  assert.match(s.detail, /No model call has been made yet/);
  assert.match(s.detail, /last renewed at/);
  // Renewal is not an inference: a later tick does nothing, and lastOk is still absent.
  r.advance(30 * SEC);
  await r.model.maintain?.();
  assert.equal(r.log.token, 1);
});

test("a renewal does not invent a model verification or clear a real model failure", async () => {
  const r = rig();
  r.inference.status = 500;
  await assert.rejects(chat(r.model), /HTTP 500/);
  assert.equal(r.model.status().state, "down");
  const failedAt = r.model.status().verifiedAt;
  r.advance(55 * MIN);
  await r.model.maintain?.();
  assert.equal(r.log.token, 1);
  const s = r.model.status();
  assert.equal(s.state, "down");
  assert.match(s.detail, /Last call failed: HTTP 500/);
  assert.equal(s.verifiedAt, failedAt);
});

test("after a successful call, renewal keeps status live with the call's own timestamp", async () => {
  const r = rig();
  await chat(r.model);
  const ok = r.model.status().verifiedAt;
  r.advance(55 * MIN);
  await r.model.maintain?.();
  const s = r.model.status();
  assert.equal(s.state, "live");
  assert.equal(s.verifiedAt, ok);
});

test("a failed renewal is degraded while the token works, backs off, and recovers after a retry", async () => {
  const r = rig();
  r.tokenMode.mode = "fail";
  r.advance(51 * MIN);
  await r.model.maintain?.();
  let s = r.model.status();
  assert.equal(s.state, "degraded");
  assert.equal(s.verifiedAt, new Date(r.now()).toISOString());
  assert.match(s.detail, /Renewing the ChatGPT login failed: ChatGPT token refresh_token failed: HTTP 503/);
  assert.match(s.detail, /still works until/);
  assert.doesNotMatch(s.detail, /access-0|refresh-0/);
  // Ticks every 30 s inside the back-off make no requests: 1 minute, then 2, then 4.
  r.advance(30 * SEC);
  await r.model.maintain?.();
  assert.equal(r.log.token, 1);
  r.advance(30 * SEC);
  await r.model.maintain?.();
  assert.equal(r.log.token, 2);
  for (let i = 0; i < 3; i++) {
    r.advance(30 * SEC);
    await r.model.maintain?.();
  }
  assert.equal(r.log.token, 2, "second back-off is 2 minutes");
  r.advance(30 * SEC);
  r.tokenMode.mode = "ok";
  await r.model.maintain?.();
  assert.equal(r.log.token, 3);
  s = r.model.status();
  assert.equal(s.state, "live");
  assert.equal(r.file.read()?.access, "access-1");
});

test("back-off is capped at 15 minutes", async () => {
  const r = rig();
  r.tokenMode.mode = "fail";
  r.advance(51 * MIN);
  for (let i = 0; i < 12; i++) {
    await r.model.maintain?.();
    r.advance(30 * MIN);
  }
  const before = r.log.token;
  assert.equal(before, 12, "one attempt per 30 minutes once capped, never more than one per tick");
  await r.model.maintain?.();
  await r.model.maintain?.();
  assert.equal(r.log.token, before + 1);
});

test("when the token expires during a failing renewal, status is down", async () => {
  const r = rig();
  r.tokenMode.mode = "fail";
  r.advance(51 * MIN);
  await r.model.maintain?.();
  assert.equal(r.model.status().state, "degraded");
  r.advance(10 * MIN);
  const s = r.model.status();
  assert.equal(s.state, "down");
  assert.match(s.detail, /expired at/);
});

test("a revoked login is reported once and not retried, and says to sign in again", async () => {
  const r = rig();
  r.tokenMode.mode = "revoked";
  r.advance(51 * MIN);
  await r.model.maintain?.();
  for (let i = 0; i < 20; i++) {
    r.advance(5 * MIN);
    await r.model.maintain?.();
  }
  assert.equal(r.log.token, 1);
  const s = r.model.status();
  assert.equal(s.state, "down");
  assert.match(s.detail, /revoked; sign in again/);
  assert.match(s.detail, /Sign in again from the web page/);
});

test("startup with an expired token renews in the background; until then it is not called live", async () => {
  const r = rig({ expires: START - 5 * MIN });
  r.model.status();
  assert.equal(r.model.status().state, "degraded");
  r.hold();
  const pending = r.model.maintain?.();
  assert.equal(r.model.status().state, "degraded");
  r.tokenMode.mode = "ok";
  r.tokenMode.release?.();
  await pending;
  assert.equal(r.model.status().state, "live");
  assert.equal(r.log.inference, 0);
});

test("an expired token after a good call is not reported live", async () => {
  const r = rig();
  await chat(r.model);
  r.advance(61 * MIN);
  const s = r.model.status();
  assert.equal(s.state, "degraded");
  assert.match(s.detail, /expired and has not been renewed/);
});

test("a background renewal and a call share one renewal request", async () => {
  const r = rig();
  r.advance(55 * MIN);
  r.hold();
  const background = r.model.maintain?.();
  const call = chat(r.model);
  const more = r.model.maintain?.();
  await new Promise((resolve) => setImmediate(resolve));
  r.tokenMode.mode = "ok";
  r.tokenMode.release?.();
  await Promise.all([background, call, more]);
  assert.equal(r.log.token, 1);
  assert.equal(r.log.inference, 1);
  assert.equal(r.file.read()?.access, "access-1");
  assert.equal(r.file.read()?.refresh, "refresh-1");
});

test("on-demand renewal still works with no background tick", async () => {
  const r = rig();
  r.advance(58 * MIN);
  await chat(r.model);
  assert.equal(r.log.token, 1);
  assert.equal(r.file.read()?.access, "access-1");
});

test("a call during back-off uses the still-valid token without hammering the token endpoint", async () => {
  const r = rig();
  r.tokenMode.mode = "fail";
  r.advance(51 * MIN);
  await r.model.maintain?.();
  await chat(r.model);
  await chat(r.model);
  assert.equal(r.log.token, 1);
  assert.equal(r.log.inference, 2);
});

test("a short-lived token is renewed at half its life, not in a loop", async () => {
  const r = rig({ expiresIn: 300, expires: START + 60 * SEC });
  await r.model.maintain?.(); // first renewal learns the lifetime
  assert.equal(r.log.token, 1);
  for (let i = 0; i < 20; i++) {
    r.advance(30 * SEC); // ten minutes of ticks
    await r.model.maintain?.();
  }
  assert.ok(r.log.token >= 3 && r.log.token <= 5, `renewals: ${r.log.token}`);
  assert.equal(r.model.status().state, "live");
});

test("a refused token is renewed once, not in a loop", async () => {
  const r = rig();
  r.inference.status = 401;
  await assert.rejects(chat(r.model), /HTTP 401/);
  assert.equal(r.log.token, 1);
  assert.equal(r.log.inference, 2);
});

test("stop waits for a renewal in flight and prevents new ones", async () => {
  const r = rig();
  r.advance(55 * MIN);
  r.hold();
  const pending = r.model.maintain?.();
  let stopped = false;
  const stop = r.model.stop().then(() => (stopped = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  r.tokenMode.mode = "ok";
  r.tokenMode.release?.();
  await Promise.all([pending, stop]);
  assert.equal(r.file.read()?.access, "access-1", "the rotated token was saved before stop returned");
  r.advance(55 * MIN);
  await r.model.maintain?.();
  assert.equal(r.log.token, 1);
});

// Model status feeding the real watch, as the periodic tick does.
function watched() {
  const r = rig();
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []), undefined, () => new Date(r.now()));
  const watch = watcher(jsonStore<WatchState>(undefined, "w", { ports: {} }), notify, () => new Date(r.now()));
  watch.attach(() => [r.model.status()]);
  const tick = async () => {
    await r.model.maintain?.();
    watch.tick();
  };
  return { r, notify, watch, tick };
}

test("routine renewals over many hours never reach the watch", async () => {
  const { r, notify, tick } = watched();
  for (let i = 0; i < 6 * 120; i++) {
    r.advance(30 * SEC);
    await tick();
  }
  assert.ok(r.log.token >= 5, `renewals: ${r.log.token}`);
  assert.equal(r.log.inference, 0);
  assert.equal(notify.recent().length, 0);
});

test("a renewal that fails once and then succeeds does not alert", async () => {
  const { r, notify, tick } = watched();
  r.advance(51 * MIN);
  r.tokenMode.mode = "fail";
  await tick();
  r.advance(MIN);
  r.tokenMode.mode = "ok";
  await tick();
  r.advance(10 * MIN);
  await tick();
  assert.equal(notify.recent().length, 0);
});

test("sustained renewal failure alerts once, escalates when the token expires, and recovery is announced", async () => {
  const { r, notify, tick } = watched();
  r.advance(51 * MIN);
  r.tokenMode.mode = "fail";
  for (let i = 0; i < 8; i++) {
    await tick();
    r.advance(30 * SEC);
  }
  const texts = () => notify.recent().reverse().map((n) => n.text);
  assert.equal(texts().length, 0, "not yet 5 minutes");
  for (let i = 0; i < 6; i++) {
    r.advance(30 * SEC);
    await tick();
  }
  assert.equal(texts().length, 1);
  assert.match(texts()[0], /"model" is degraded .*Renewing the ChatGPT login failed/);
  for (let i = 0; i < 40; i++) {
    r.advance(30 * SEC);
    await tick();
  }
  assert.equal(texts().length, 2);
  assert.match(texts()[1], /"model" is down .*expired at/);
  r.tokenMode.mode = "ok";
  for (let i = 0; i < 40; i++) {
    r.advance(30 * SEC);
    await tick();
  }
  assert.equal(texts().length, 3);
  assert.match(texts()[2], /"model" is live again/);
});
