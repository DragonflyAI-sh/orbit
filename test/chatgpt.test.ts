import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { chatgptModel, textFromStream, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(claims: object, key = privateKey) {
  const head = b64({ alg: "RS256", kid: "k1" });
  const body = b64(claims);
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
}
const sse = (text: string) =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
  `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } })}\n\n`;

type Call = { url: string; init?: RequestInit };

function fakeOpenAI(opts: { scope?: string; nonce?: () => string | undefined; sub?: string; failFirstReply?: number } = {}) {
  const calls: Call[] = [];
  let issued = 0;
  let replies = 0;
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) {
      issued += 1;
      const form = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: opts.scope ?? "openid email resource.invoke chatgpt.tokens.use.direct offline_access",
        id_token: idToken({
          iss: "https://auth.openai.com",
          aud: form.get("client_id"),
          sub: opts.sub ?? "user-1",
          email: "rai@example.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: opts.nonce?.(),
        }),
      });
    }
    if (url.endsWith("/v1/responses")) {
      replies += 1;
      if (replies <= (opts.failFirstReply ?? 0)) return new Response("", { status: 401 });
      return new Response(sse("hello from chatgpt"));
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const saved = (over: Partial<Tokens> = {}): Tokens => ({
  access: "access-0",
  refresh: "refresh-0",
  expires: Date.now() + 3_600_000,
  idToken: idToken({ iss: "https://auth.openai.com", aud: "oaiapp_x", sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }),
  clientId: "oaiapp_x",
  subject: "user-1",
  scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access",
  ...over,
});

async function signIn(fake: ReturnType<typeof fakeOpenAI>, nonceHolder: { nonce?: string }) {
  const file = tokenFile(undefined);
  const model = chatgptModel("gpt-x", file, { fetcher: fake.fetcher });
  const pending = await model.startLogin();
  assert.equal(pending.state, "pending");
  const authorize = new URL(pending.state === "pending" ? pending.authorizeUrl : "");
  nonceHolder.nonce = authorize.searchParams.get("nonce") ?? undefined;
  const callback = `http://localhost:8080/auth/callback?code=c1&state=${authorize.searchParams.get("state")}&client_id=oaiapp_abc`;
  return { file, model, authorize, callback };
}

test("sign-in builds a token-sharing link and finishes from the pasted address", async () => {
  const holder: { nonce?: string } = {};
  const fake = fakeOpenAI({ nonce: () => holder.nonce });
  const { file, model, authorize, callback } = await signIn(fake, holder);
  assert.equal(authorize.origin + authorize.pathname, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(authorize.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.match(authorize.searchParams.get("scope")!, /chatgpt\.tokens\.use\.direct/);
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://localhost:8080/auth/callback");
  const done = await model.finishLogin(callback);
  assert.equal(done.state, "signed-in");
  assert.equal(file.read()?.clientId, "oaiapp_abc");
  const exchange = new URLSearchParams(String(fake.calls.find((c) => c.url.endsWith("/oauth/token"))!.init!.body));
  assert.deepEqual([exchange.get("grant_type"), exchange.get("client_id"), exchange.get("resource")], ["authorization_code", "oaiapp_abc", "https://api.openai.com/v1"]);
  assert.ok(exchange.get("code_verifier"));
});

test("a pasted address from another sign-in, or with a bad nonce, is refused", async () => {
  const holder: { nonce?: string } = {};
  const { model } = await signIn(fakeOpenAI({ nonce: () => holder.nonce }), holder);
  assert.match(((await model.finishLogin("http://localhost:8080/auth/callback?code=c&state=wrong&client_id=oaiapp_a")) as { detail: string }).detail, /different sign-in/);

  const bad = await signIn(fakeOpenAI({ nonce: () => "not-the-nonce" }), {});
  const failed = await bad.model.finishLogin(bad.callback);
  assert.match((failed as { detail: string }).detail, /nonce/);
  assert.equal(bad.file.read(), undefined);
});

test("sign-in without token sharing granted is refused", async () => {
  const holder: { nonce?: string } = {};
  const { model, callback, file } = await signIn(fakeOpenAI({ nonce: () => holder.nonce, scope: "openid email offline_access" }), holder);
  assert.match(((await model.finishLogin(callback)) as { detail: string }).detail, /token sharing was not granted/);
  assert.equal(file.read(), undefined);
});

test("a reply goes to the Responses API with the shared token and comes back live", async () => {
  const fake = fakeOpenAI();
  const file = tokenFile(undefined);
  file.write(saved());
  const model = chatgptModel("gpt-x", file, { fetcher: fake.fetcher });
  const reply = await model.reply([{ role: "user", content: "hi" }], ["runs is mock"]);
  assert.deepEqual([reply.value, reply.provenance], ["hello from chatgpt", "live"]);
  const req = fake.calls.find((c) => c.url === "https://api.openai.com/v1/responses")!;
  const headers = req.init!.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer access-0");
  assert.equal(headers["x-openai-chatpass-test"], "codex-direct");
  const body = JSON.parse(String(req.init!.body));
  assert.deepEqual([body.model, body.store, body.stream], ["gpt-x", false, true]);
  assert.match(body.instructions, /runs is mock/);
  assert.equal(model.status().state, "live");
});

test("an expiring login is refreshed once for concurrent replies, keeps the same account, and is saved", async () => {
  const fake = fakeOpenAI();
  const file = tokenFile(undefined);
  file.write(saved({ expires: Date.now() + 1000 }));
  const model = chatgptModel("gpt-x", file, { fetcher: fake.fetcher });
  await Promise.all([model.reply([{ role: "user", content: "a" }], []), model.reply([{ role: "user", content: "b" }], [])]);
  const refreshes = fake.calls.filter((c) => c.url.endsWith("/oauth/token"));
  assert.equal(refreshes.length, 1);
  const form = new URLSearchParams(String(refreshes[0].init!.body));
  assert.deepEqual([form.get("grant_type"), form.get("client_id"), form.get("resource")], ["refresh_token", "oaiapp_x", "https://api.openai.com/v1"]);
  assert.equal(file.read()?.refresh, "refresh-1");
});

test("a refresh that returns a different account is refused", async () => {
  const fake = fakeOpenAI({ sub: "someone-else" });
  const file = tokenFile(undefined);
  file.write(saved({ expires: Date.now() + 1000 }));
  await assert.rejects(chatgptModel("gpt-x", file, { fetcher: fake.fetcher }).reply([{ role: "user", content: "a" }], []), /account changed/);
  assert.equal(file.read()?.refresh, "refresh-0");
});

test("a 401 forces one refresh and retry", async () => {
  const fake = fakeOpenAI({ failFirstReply: 1 });
  const file = tokenFile(undefined);
  file.write(saved());
  const reply = await chatgptModel("gpt-x", file, { fetcher: fake.fetcher }).reply([{ role: "user", content: "hi" }], []);
  assert.equal(reply.value, "hello from chatgpt");
});

test("without a sign-in, status says how to sign in; stream parsing handles deltas", async () => {
  const model = chatgptModel("gpt-x", tokenFile(undefined), { fetcher: fakeOpenAI().fetcher });
  await assert.rejects(model.reply([{ role: "user", content: "hi" }], []), /not signed in/);
  assert.match(model.status().detail, /Sign in from the web page/);
  assert.equal(textFromStream(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n`), "partial");
});
