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

// ---- follow-ups from ORBIT's review of #50/#51 (2026-11-11) ----------------------------------------------------------

// A rig whose responses are released one at a time, to put two calls in flight together.
function gatedRig() {
  let t = START;
  const file = tokenFile(undefined);
  file.write({
    access: "access-0",
    refresh: "refresh-0",
    expires: START + 600 * MIN,
    idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`,
    clientId: "oaiapp_x",
    subject: "user-1",
    scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  });
  const waiting: ((body: string) => void)[] = [];
  const fetcher = (async (url: string) => {
    if (!url.endsWith("/v1/responses")) return new Response("", { status: 404 });
    const body = await new Promise<string>((resolve) => waiting.push(resolve));
    return new Response(body);
  }) as unknown as typeof fetch;
  const model = chatgptModel("gpt-x", file, { fetcher, now: () => t });
  const settle = () => new Promise((r) => setImmediate(r));
  return { model, waiting, settle, advance: (ms: number) => void (t += ms) };
}

test("absurd, past, zero and invalid reset times are not believed: ORBIT's own pause applies and nothing throws", () => {
  for (const body of [
    { code: "usage_limit_reached", resets_in_seconds: 1e15 },
    { code: "usage_limit_reached", resets_in_seconds: 8 * 24 * 3600 },
    { code: "usage_limit_reached", resets_at: 1 },
    { code: "usage_limit_reached", resets_at: 0 },
    { code: "usage_limit_reached", resets_in_seconds: 0 },
    { code: "usage_limit_reached", resets_at: "not a date" },
    { code: "usage_limit_reached", resets_at: "1970-01-01T00:00:00Z" },
  ]) {
    const e = streamProblem(failedStream(body), START);
    assert.equal(e?.kind, "usage_limit", JSON.stringify(body));
    assert.equal(e?.resetsAt, undefined, JSON.stringify(body));
    assert.doesNotMatch(e!.message, /1970|resets at/, JSON.stringify(body));
  }
  // A plausible reset (three days) is still believed.
  assert.equal(streamProblem(failedStream({ code: "usage_limit_reached", resets_in_seconds: 3 * 24 * 3600 }), START)?.resetsAt, new Date(START + 3 * 24 * 60 * MIN).toISOString());
});

test("a huge reset value gives the usual 15 minute pause, not a crash or an endless block", async () => {
  const r = rig();
  r.next.body = failedStream({ code: "usage_limit_reached", message: "Limit.", resets_in_seconds: 1e15 });
  await assert.rejects(chat(r.model), (err: unknown) => err instanceof ProviderError && err.kind === "usage_limit");
  assert.match(r.model.status().detail, /pauses model calls until .* \(in 15 min\)/);
});

test("calls that were in flight when a limit began do not push the pause later", async () => {
  const g = gatedRig();
  const a = chat(g.model).catch((e) => e);
  const b = chat(g.model).catch((e) => e);
  await g.settle();
  assert.equal(g.waiting.length, 2, "both calls are in flight");
  g.waiting[0]!(failedStream({ code: "usage_limit_reached" }));
  await a;
  g.advance(5 * MIN);
  g.waiting[1]!(failedStream({ code: "usage_limit_reached" }));
  await b;
  assert.match(g.model.status().detail, /\(in 10 min\)/, "the pause still ends 15 minutes after it began");
});

test("an in-flight call that answers after a limit began does not make the port live while the limit is in force", async () => {
  const g = gatedRig();
  const ok = chat(g.model);
  const limited = chat(g.model).catch((e) => e);
  await g.settle();
  g.waiting[1]!(failedStream({ code: "usage_limit_reached" }));
  await limited;
  g.advance(1000);
  g.waiting[0]!(textStream("late answer"));
  assert.equal((await ok).value, "late answer");
  const s = g.model.status();
  assert.equal(s.state, "down");
  assert.match(s.detail, /pauses model calls until/);
});

test("refusals during a pause change neither the last failure time nor the pause", async () => {
  const r = rig();
  r.next.body = failedStream({ code: "usage_limit_reached" });
  await assert.rejects(chat(r.model));
  const first = r.model.status().verifiedAt;
  r.advance(3 * MIN);
  await assert.rejects(chat(r.model), /No call was made/);
  assert.equal(r.model.status().verifiedAt, first);
  assert.match(r.model.status().detail, /in 12 min/);
});

test("secrets of any common shape in a provider message are redacted before anyone sees them", () => {
  const jwt = ["eyJ" + "a".repeat(20), "b".repeat(30), "c".repeat(30)].join(".");
  const key = ["s", "k-"].join("") + "z".repeat(40);
  const e = httpProblem(400, JSON.stringify({ error: { code: "bad_request", message: `bad header ${jwt} and ${key}` } }), START);
  assert.ok(!e.message.includes("b".repeat(30)), "no JWT body");
  assert.ok(!e.message.includes("z".repeat(40)), "no key");
  assert.match(e.message, /bad header/);
});

test("an HTML error page is summarised, not shown", () => {
  const e = httpProblem(502, "<!DOCTYPE html><html><body><h1>Bad gateway</h1><script>x()</script></body></html>", START);
  assert.equal(e.message, "HTTP 502: ChatGPT returned an error: (an HTML error page).");
});

// ---- one retry on overload ---------------------------------------------------------------------------------------------

function retryRig(responses: { status?: number; body: string }[]) {
  let t = START;
  const file = tokenFile(undefined);
  file.write({
    access: "access-0",
    refresh: "refresh-0",
    expires: START + 600 * MIN,
    idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`,
    clientId: "oaiapp_x",
    subject: "user-1",
    scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  });
  const log = { inference: 0, sleeps: [] as number[] };
  const fetcher = (async (url: string) => {
    if (!url.endsWith("/v1/responses")) return new Response("", { status: 404 });
    const r = responses[log.inference++] ?? responses.at(-1)!;
    return new Response(r.body, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const sleep = async (ms: number) => void log.sleeps.push(ms);
  const model = chatgptModel("gpt-x", file, { fetcher, now: () => t, sleep });
  return { model, log };
}

const overloaded = failedStream({ code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." });

test("an overload before any output is retried once after a short wait, and the answer comes through", async () => {
  const r = retryRig([{ body: overloaded }, { body: textStream("second try") }]);
  assert.equal((await chat(r.model)).value, "second try");
  assert.equal(r.log.inference, 2);
  assert.equal(r.log.sleeps.length, 1);
  assert.ok(r.log.sleeps[0]! >= 2000 && r.log.sleeps[0]! < 3000);
  assert.equal(r.model.status().state, "live");
});

test("a second overload is reported as overloaded, asked twice, with no pause afterwards", async () => {
  const r = retryRig([{ body: overloaded }, { body: overloaded }, { body: textStream("later") }]);
  await assert.rejects(chat(r.model), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, "overloaded");
    assert.match(err.message, /^ChatGPT's servers are overloaded: Our servers are currently overloaded\. Please try again later \(asked twice, [23] s apart\)\.$/);
    return true;
  });
  assert.equal(r.log.inference, 2, "only one retry");
  assert.equal((await chat(r.model)).value, "later", "an overload sets no pause");
});

test("an overload after output started, and other errors, are not retried; HTTP 503 is", async () => {
  const afterOutput = event({ type: "response.output_item.added", item: { type: "message" } }) + event({ type: "error", error: { code: "server_is_overloaded", message: "Overloaded." } });
  const r1 = retryRig([{ body: afterOutput }, { body: textStream("x") }]);
  await assert.rejects(chat(r1.model), /overloaded/);
  assert.equal(r1.log.inference, 1);

  const r2 = retryRig([{ body: failedStream({ code: "server_error", message: "Boom." }) }, { body: textStream("x") }]);
  await assert.rejects(chat(r2.model), /Boom/);
  assert.equal(r2.log.inference, 1);

  const r3 = retryRig([{ status: 503, body: "Service Unavailable" }, { body: textStream("ok") }]);
  assert.equal((await chat(r3.model)).value, "ok");
  assert.equal(r3.log.inference, 2);
});
