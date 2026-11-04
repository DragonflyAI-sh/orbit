import assert from "node:assert/strict";
import { test } from "node:test";
import { accountIdOf, chatgptModel, textFromStream, tokenFile } from "../src/chatgpt.ts";

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const access = (n: number) => jwt({ n, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
const sse = (text: string) =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
  `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } })}\n\n`;

type Call = { url: string; init: RequestInit };

function fakeOpenAI(opts: { pendingPolls?: number; failFirstReply?: number } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  let issued = 0;
  let replies = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: 1 });
    if (url.endsWith("/deviceauth/token")) {
      if (polls++ < (opts.pendingPolls ?? 1)) return new Response("", { status: 403 });
      return Response.json({ authorization_code: "code-1", code_verifier: "ver-1" });
    }
    if (url.endsWith("/oauth/token")) {
      issued += 1;
      return Response.json({ access_token: access(issued), refresh_token: `refresh-${issued}`, expires_in: 3600 });
    }
    if (url.endsWith("/codex/responses")) {
      replies += 1;
      if (replies <= (opts.failFirstReply ?? 0)) return new Response("", { status: 401 });
      return new Response(sse("hello from gpt"));
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

test("device sign-in shows a code, waits, then stores ORBIT's own tokens", async () => {
  const { fetcher, calls } = fakeOpenAI({ pendingPolls: 2 });
  const file = tokenFile(undefined);
  const model = chatgptModel("gpt-x", file, { fetcher, pollMs: 1 });
  assert.equal(model.status().state, "down");
  const pending = await model.startLogin();
  assert.deepEqual([pending.state, pending.state === "pending" && pending.userCode], ["pending", "ABCD-1234"]);
  assert.match(model.status().detail, /enter ABCD-1234/);
  await until(() => model.login().state === "signed-in");
  assert.equal(model.login().state, "signed-in");
  assert.equal(file.read()?.accountId, "acct-1");
  const exchange = calls.find((c) => c.url.endsWith("/oauth/token"))!;
  assert.match(String(exchange.init.body), /grant_type=authorization_code/);
  assert.match(String(exchange.init.body), /code_verifier=ver-1/);
});

test("a reply goes to the Codex endpoint with the account header and comes back live", async () => {
  const { fetcher, calls } = fakeOpenAI();
  const file = tokenFile(undefined);
  file.write({ access: access(0), refresh: "refresh-0", expires: Date.now() + 3_600_000, accountId: "acct-1" });
  const model = chatgptModel("gpt-x", file, { fetcher });
  const reply = await model.reply([{ role: "user", content: "hi" }], ["runs is mock"]);
  assert.deepEqual([reply.value, reply.provenance], ["hello from gpt", "live"]);
  const req = calls.find((c) => c.url.endsWith("/codex/responses"))!;
  const headers = req.init.headers as Record<string, string>;
  assert.equal(headers["chatgpt-account-id"], "acct-1");
  const body = JSON.parse(String(req.init.body));
  assert.equal(body.model, "gpt-x");
  assert.equal(body.store, false);
  assert.match(body.instructions, /runs is mock/);
  assert.equal(model.status().state, "live");
});

test("an expiring token is refreshed once, even for concurrent replies, and the new one is saved", async () => {
  const { fetcher, calls } = fakeOpenAI();
  const file = tokenFile(undefined);
  file.write({ access: access(0), refresh: "refresh-0", expires: Date.now() + 1000, accountId: "acct-1" });
  const model = chatgptModel("gpt-x", file, { fetcher });
  await Promise.all([model.reply([{ role: "user", content: "a" }], []), model.reply([{ role: "user", content: "b" }], [])]);
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth/token")).length, 1);
  assert.equal(file.read()?.refresh, "refresh-1");
});

test("a 401 forces one refresh and retry", async () => {
  const { fetcher, calls } = fakeOpenAI({ failFirstReply: 1 });
  const file = tokenFile(undefined);
  file.write({ access: access(0), refresh: "refresh-0", expires: Date.now() + 3_600_000 });
  const reply = await chatgptModel("gpt-x", file, { fetcher }).reply([{ role: "user", content: "hi" }], []);
  assert.equal(reply.value, "hello from gpt");
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth/token")).length, 1);
});

test("without a sign-in, replies fail and status says how to sign in", async () => {
  const model = chatgptModel("gpt-x", tokenFile(undefined), { fetcher: fakeOpenAI().fetcher });
  await assert.rejects(model.reply([{ role: "user", content: "hi" }], []), /not signed in/);
  assert.match(model.status().detail, /Sign in from the web page|not signed in/i);
});

test("stream text and account id parsing", () => {
  assert.equal(textFromStream(sse("abc")), "abc");
  assert.equal(textFromStream(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n`), "partial");
  assert.equal(accountIdOf(access(1)), "acct-1");
  assert.equal(accountIdOf("garbage"), undefined);
});
