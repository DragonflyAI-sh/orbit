import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discordChannel, INTENTS, MAX_CONTENT, selectDiscordChannel } from "../src/discord.ts";
import type { ChannelTurn, ChannelTurnResult } from "../src/discord.ts";
import { OWNER, rig, say, scripted } from "./threads-fixture.ts";

// Discord as a chat channel (src/discord.ts) against a fake gateway and a fake REST API. Offline: nothing reaches Discord.

const CHANNEL = "1575982468467531787";
const OWNER_ID = "123456789012345678";
const BOT_ID = "999999999999999999";
const persona = (discord?: object) => ({ id: "nova", ...(discord ? { discord } : {}) });
const creds = (token?: string) => {
  const d = mkdtempSync(join(tmpdir(), "discord-cred-"));
  if (token !== undefined) writeFileSync(join(d, "nova.discord-bot"), token);
  return d;
};

test("selection: off when nothing is set, refused with the reason when partly set, on when all three are valid", () => {
  assert.ok("off" in selectDiscordChannel({}, persona()));
  const partial = selectDiscordChannel({ CREDENTIALS_DIRECTORY: creds("tok") }, persona({ channelId: CHANNEL }));
  assert.ok("invalid" in partial && /owner's Discord user id/.test(partial.invalid));
  const noToken = selectDiscordChannel({}, persona({ channelId: CHANNEL, ownerUserId: OWNER_ID }));
  assert.ok("invalid" in noToken && /nova\.discord-bot/.test(noToken.invalid));
  const env = selectDiscordChannel({ CREDENTIALS_DIRECTORY: creds("tok\n"), ORBIT_DISCORD_OWNER: OWNER_ID }, persona({ channelId: CHANNEL }));
  assert.deepEqual(env, { config: { token: "tok", channelId: CHANNEL, ownerId: OWNER_ID } }, "the env sets the owner; the token's trailing newline is dropped");
  const bad = selectDiscordChannel({ CREDENTIALS_DIRECTORY: creds("tok"), ORBIT_DISCORD_CHANNEL: "general" }, persona({ ownerUserId: OWNER_ID }));
  assert.ok("invalid" in bad && /channel id is not a Discord id/.test(bad.invalid));
});

type Sent = { method: string; path: string; body: any };
function harness(turn: ChannelTurn, o: { gateway?: number; webUrl?: string } = {}) {
  const sent: Sent[] = [];
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    url: string;
    out: any[] = [];
    closed?: number;
    listeners: Record<string, ((ev: any) => void)[]> = {};
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(data: string) {
      this.out.push(JSON.parse(data));
    }
    close(code?: number) {
      this.closed = code;
    }
    addEventListener(type: string, fn: (ev: any) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type: string, ev: any) {
      for (const fn of this.listeners[type] ?? []) fn(ev);
    }
    receive(p: object) {
      this.emit("message", { data: JSON.stringify(p) });
    }
  }
  const fakeFetch = (async (url: string, init: any) => {
    const path = url.replace("https://discord.com/api/v10", "");
    sent.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined });
    assert.equal(init.headers.authorization, "Bot tok");
    if (path === "/gateway/bot") return new Response(JSON.stringify({ url: "wss://gateway.discord.gg" }), { status: o.gateway ?? 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const ch = discordChannel({ token: "tok", channelId: CHANNEL, ownerId: OWNER_ID }, turn, { fetch: fakeFetch, WebSocket: FakeSocket as any, random: () => 0.5, log: () => undefined, webUrl: o.webUrl });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(ok(), "condition not reached");
  };
  const ready = async () => {
    ch.start();
    await until(() => sockets.length === 1);
    const ws = sockets[0]!;
    ws.receive({ op: 10, d: { heartbeat_interval: 3_600_000 } });
    ws.receive({ op: 0, s: 1, t: "READY", d: { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg", user: { id: BOT_ID, username: "Nova" } } });
    return ws;
  };
  const message = (ws: FakeSocket, d: object, s = 2) => ws.receive({ op: 0, s, t: "MESSAGE_CREATE", d: { id: `m${s}`, type: 0, channel_id: CHANNEL, author: { id: OWNER_ID }, content: "hello", ...d } });
  const posts = () => sent.filter((x) => x.method === "POST" && x.path === `/channels/${CHANNEL}/messages`);
  return { ch, sent, sockets, ready, message, posts, until };
}

test("identifies with the message intents, goes live on READY, and runs only the owner's messages in its channel", async () => {
  const seen: string[] = [];
  const h = harness(async (text) => (seen.push(text), { reply: `echo: ${text}` }));
  const ws = await h.ready();
  assert.ok(ws.url.startsWith("wss://gateway.discord.gg/?v=10&encoding=json"));
  const identify = ws.out.find((p) => p.op === 2);
  assert.equal(identify.d.token, "tok");
  assert.equal(identify.d.intents, INTENTS);
  assert.equal(h.ch.status().state, "live");
  h.message(ws, { author: { id: "111111111111111111" }, content: "someone else" }, 2);
  h.message(ws, { author: { id: OWNER_ID, bot: true }, content: "a bot" }, 3);
  h.message(ws, { author: { id: BOT_ID }, content: "myself" }, 4);
  h.message(ws, { channel_id: "222222222222222222", content: "other channel" }, 5);
  h.message(ws, { content: "  what's up?  " }, 6);
  await h.until(() => h.posts().length === 1);
  await h.ch.idle();
  assert.deepEqual(seen, ["what's up?"], "only the owner's message in the channel reached the model");
  const [post] = h.posts();
  assert.equal(post!.body.content, "echo: what's up?");
  assert.deepEqual(post!.body.allowed_mentions, { parse: [] }, "a reply never pings anyone");
  assert.equal(post!.body.message_reference.message_id, "m6");
  assert.ok(h.sent.some((x) => x.path === `/channels/${CHANNEL}/typing`), "typing is shown while the turn runs");
  h.ch.stop();
});

test("a long reply is posted whole, in order, in parts within Discord's limit; proposals and errors are spelled out", async () => {
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${"x".repeat(180)}`).join("\n\n");
  const results: ChannelTurnResult[] = [{ reply: long }, { reply: "Proposed.", proposals: 2 }, { busy: true }, { error: "model is down" }];
  const h = harness(async () => results.shift()!, { webUrl: "http://vultr:8792/" });
  const ws = await h.ready();
  h.message(ws, {}, 2);
  await h.until(() => h.ch.handled() === 1);
  await h.ch.idle();
  assert.ok(h.posts().length >= 3, "split into several messages");
  const parts = h.posts().map((p) => p.body.content as string);
  assert.ok(parts.every((p) => p.length <= MAX_CONTENT));
  assert.equal(parts.join(""), long, "joined again, the parts are exactly the reply");
  assert.ok(h.posts()[0]!.body.message_reference && !h.posts()[1]!.body.message_reference, "only the first part answers the message");
  const n = h.posts().length;
  h.message(ws, {}, 3);
  h.message(ws, {}, 4);
  h.message(ws, {}, 5);
  await h.until(() => h.ch.handled() === 4);
  await h.ch.idle();
  await h.ch.idle();
  const [proposed, busy, failed] = h.posts().slice(n).map((p) => p.body.content as string);
  assert.match(proposed!, /^Proposed\.\n\n🔒 2 proposals are waiting for your confirmation on http:\/\/vultr:8792\/\. Nothing has run yet\.$/);
  assert.match(busy!, /already in progress.*not run/);
  assert.match(failed!, /⚠️ model is down/);
  h.ch.stop();
});

test("Message Content Intent off (close 4014) or a refused token is down with the fix, and never retried", async () => {
  const h = harness(async () => ({ reply: "never" }));
  const ws = await h.ready();
  ws.emit("close", { code: 4014 });
  assert.equal(h.ch.status().state, "down");
  assert.match(h.ch.status().detail, /Message Content Intent/);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(h.sockets.length, 1, "no reconnect");
  h.ch.stop();
  const bad = harness(async () => ({ reply: "never" }), { gateway: 401 });
  bad.ch.start();
  await bad.until(() => bad.ch.status().detail.includes("token"));
  assert.equal(bad.ch.status().state, "down");
  assert.equal(bad.sockets.length, 0);
  bad.ch.stop();
});

test("a dropped connection resumes the same session", async () => {
  const h = harness(async () => ({ reply: "ok" }));
  const ws = await h.ready();
  ws.emit("close", { code: 1006 });
  assert.equal(h.ch.status().state, "degraded");
  await h.until(() => h.sockets.length === 2);
  const again = h.sockets[1]!;
  assert.ok(again.url.startsWith("wss://resume.discord.gg/"));
  again.receive({ op: 10, d: { heartbeat_interval: 3_600_000 } });
  assert.deepEqual(again.out.find((p) => p.op === 6)?.d, { token: "tok", session_id: "s1", seq: 1 });
  again.receive({ op: 0, s: 2, t: "RESUMED", d: {} });
  assert.equal(h.ch.status().state, "live");
  h.ch.stop();
});

test("server: a channel turn is an owner turn in the Assistant conversation, stored and shown on the page", async () => {
  const d = mkdtempSync(join(tmpdir(), "discord-srv-"));
  let turn: ChannelTurn | undefined;
  const x = rig({ dir: d, extra: () => ({ assistantDir: join(d, "assistant"), channels: { onTurn: (t: ChannelTurn) => (turn = t), describe: "Web chat at /, and Discord." } }), model: scripted([say("Hello from Discord, Rai.")]) });
  assert.ok(turn, "the server hands the channel its turn function");
  const out = await turn!("hi from my phone");
  assert.deepEqual(out, { reply: "Hello from Discord, Rai." });
  x.caller.who = OWNER;
  const view = (await x.api("/assistant")).data.assistant;
  assert.deepEqual(view.chunks.flatMap((c: any) => c.messages.map((m: any) => m.text)), ["hi from my phone", "Hello from Discord, Rai."]);
  const channel = (await x.api("/status")).data.ports.find((p: any) => p.port === "channel");
  assert.equal(channel.detail, "Web chat at /, and Discord.");
  assert.match((await turn!(" ")).error ?? "", /1-/);
});
