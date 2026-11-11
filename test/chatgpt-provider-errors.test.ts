import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptModel, httpProblem, ProviderError, streamProblem, streamShape, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";

const MIN = 60_000;
const START = new Date("2026-11-11T02:22:00Z").getTime();

const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const textStream = (text: string) => event({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } });
const failedStream = (error: Record<string, unknown>) => event({ type: "response.created" }) + event({ type: "response.failed", response: { error } });

// A fake inference server whose next answer the test sets. Nothing touches the network or a real timer.
function rig() {
  let t = START;
  const file = tokenFile(undefined);
  const tokens: Tokens = {
    access: "access-0",
    refresh: "refresh-0",
    expires: START + 600 * MIN,
    idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`,
    clientId: "oaiapp_x",
    subject: "user-1",
    scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  };
  file.write(tokens);
  const next = { status: 200, body: textStream("hi"), json: false };
  const log = { inference: 0 };
  const fetcher = (async (url: string) => {
    if (url.endsWith("/v1/responses")) {
      log.inference += 1;
      return new Response(next.body, { status: next.status, headers: next.json ? { "content-type": "application/json" } : {} });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const model = chatgptModel("gpt-x", file, { fetcher, now: () => t });
  return { model, next, log, advance: (ms: number) => void (t += ms), now: () => t };
}

const chat = (m: ReturnType<typeof rig>["model"]) => m.reply([{ role: "user", content: "x" }], []);

test("a usage limit in the stream is reported with its reset time, not as 'response had no text'", async () => {
  const r = rig();
  r.next.body = failedStream({ code: "usage_limit_reached", message: "You have hit your usage limit.", resets_in_seconds: 4 * 3600 + 9 * 60 });
  await assert.rejects(chat(r.model), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, "usage_limit");
    assert.equal(err.resetsAt, new Date(START + (4 * 60 + 9) * MIN).toISOString());
    assert.match(err.message, /usage limit reached/);
    assert.doesNotMatch(err.message, /had no text/);
    return true;
  });
  const s = r.model.status();
  assert.equal(s.state, "down");
  assert.match(s.detail, /usage limit reached/);
  assert.match(s.detail, /resets at 2026-11-11T06:31:00.000Z \(in 4 h 9 min\)/);
  assert.match(s.detail, /no model call until then/);
});

test("during a known limit no call is made, and the countdown on the port stays current", async () => {
  const r = rig();
  r.next.body = failedStream({ code: "usage_limit_reached", resets_in_seconds: 60 * 60 });
  await assert.rejects(chat(r.model));
  assert.equal(r.log.inference, 1);
  r.advance(30 * MIN);
  await assert.rejects(chat(r.model), /No call was made/);
  await assert.rejects(r.model.step!([{ role: "user", content: "x" }], [], undefined, []), /No call was made/);
  assert.equal(r.log.inference, 1, "the provider was not called again before the reset");
  assert.match(r.model.status().detail, /in 30 min/);
});

test("after the reset time the port says it is not confirmed, the next call goes out, and an answer makes it live", async () => {
  const r = rig();
  r.next.body = failedStream({ code: "usage_limit_reached", resets_in_seconds: 60 });
  await assert.rejects(chat(r.model));
  r.advance(2 * MIN);
  const waiting = r.model.status();
  assert.equal(waiting.state, "degraded");
  assert.match(waiting.detail, /due to reset at .* not confirmed/);
  r.next.body = textStream("back");
  const reply = await chat(r.model);
  assert.equal(reply.value, "back");
  assert.equal(r.log.inference, 2);
  assert.equal(r.model.status().state, "live");
});

test("an HTTP 429 usage limit body is read, with an epoch reset time", async () => {
  const r = rig();
  const resetsAt = Math.floor(START / 1000) + 3600;
  r.next.status = 429;
  r.next.json = true;
  r.next.body = JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: resetsAt } });
  await assert.rejects(chat(r.model), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, "usage_limit");
    assert.equal(err.resetsAt, new Date(resetsAt * 1000).toISOString());
    assert.match(err.message, /^HTTP 429: ChatGPT usage limit reached/);
    return true;
  });
});

test("an incomplete response, an error event and a refused login each say what happened", () => {
  const incomplete = streamProblem(event({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }), START);
  assert.equal(incomplete?.kind, "incomplete");
  assert.match(incomplete!.message, /incomplete: max_output_tokens/);

  const rate = streamProblem(event({ type: "error", error: { code: "rate_limit_exceeded", message: "Slow down" } }), START);
  assert.equal(rate?.kind, "rate_limit");
  assert.match(rate!.message, /rate limiting requests: Slow down/);

  const auth = httpProblem(403, JSON.stringify({ detail: { code: "forbidden", message: "Token sharing is not enabled" } }), START);
  assert.equal(auth.kind, "auth");
  assert.match(auth.message, /^HTTP 403: ChatGPT refused the login: Token sharing is not enabled/);

  const plain = httpProblem(500, "upstream exploded", START);
  assert.equal(plain.kind, "failed");
  assert.equal(plain.message, "HTTP 500: ChatGPT returned an error: upstream exploded.");

  assert.equal(streamProblem(textStream("fine"), START), undefined, "a normal stream has no problem");
});

test("a stream with no text and no error names its event types, never its content", async () => {
  const r = rig();
  r.next.body = event({ type: "response.created" }) + event({ type: "response.reasoning_summary_text.delta", delta: "private thoughts" });
  await assert.rejects(chat(r.model), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /stream events: response\.created, response\.reasoning_summary_text\.delta/);
    assert.doesNotMatch(err.message, /private thoughts/);
    return true;
  });
  assert.equal(streamShape(""), "no events");
});

test("a usage limit with no reset time pauses calls for 15 minutes, says the pause is ORBIT's, then tries again", async () => {
  const r = rig();
  // The message seen live on 2026-11-11, which came with no reset time.
  r.next.body = failedStream({ code: "usage_limit_reached", message: "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead." });
  await assert.rejects(chat(r.model), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.resetsAt, undefined, "no reset time is invented");
    assert.match(err.message, /use an API key instead\.$/);
    assert.doesNotMatch(err.message, /\.\./, "no double period");
    return true;
  });
  const down = r.model.status();
  assert.equal(down.state, "down");
  assert.match(down.detail, /The provider gave no reset time, so ORBIT pauses model calls until 2026-11-11T02:37:00.000Z \(in 15 min\)/);
  assert.doesNotMatch(down.detail, /resets at/, "ORBIT's pause is never called a reset");

  r.advance(5 * MIN);
  await assert.rejects(chat(r.model), /No call was made\. The provider gave no reset time, so ORBIT pauses model calls until .* \(in 10 min\)/);
  assert.equal(r.log.inference, 1, "no request during the pause");
  assert.match(r.model.status().detail, /in 10 min/, "a refusal during the pause does not restart it");

  r.advance(11 * MIN);
  const after = r.model.status();
  assert.equal(after.state, "degraded");
  assert.match(after.detail, /ORBIT's pause after the limit ended at .* not confirmed/);
  r.next.body = textStream("back");
  assert.equal((await chat(r.model)).value, "back");
  assert.equal(r.log.inference, 2);
  assert.equal(r.model.status().state, "live");
});

test("a rate limit with no reset time pauses for one minute", async () => {
  const r = rig();
  r.next.body = event({ type: "error", error: { code: "rate_limit_exceeded", message: "Slow down." } });
  await assert.rejects(chat(r.model), /rate limiting requests: Slow down\.$/);
  assert.match(r.model.status().detail, /pauses model calls until 2026-11-11T02:23:00.000Z \(in 1 min\)/);
  r.advance(61_000);
  r.next.body = textStream("ok");
  assert.equal((await chat(r.model)).value, "ok");
});

test("a bearer token echoed in a provider message is redacted", () => {
  const fake = ["Bear", "er ", "ab", "c".repeat(30)].join("");
  const e = httpProblem(401, JSON.stringify({ error: { code: "invalid_token", message: `rejected ${fake}` } }), START);
  assert.equal(e.kind, "auth");
  assert.ok(!e.message.includes("c".repeat(30)));
  assert.match(e.message, /\[redacted\]/);
});
