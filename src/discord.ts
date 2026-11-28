// Discord as a chat channel (docs/discord.md). One bot, one channel, one human: messages the owner writes in the instance's channel
// are turns in the Assistant conversation (the same one the web page shows), and the reply is posted back to the channel.
//
// Configuration (all three, or the channel stays off):
//   token    the bot token, systemd credential <persona id>.discord-bot (/etc/credstore/<id>.discord-bot, root 0600)
//   channel  persona.json discord.channelId, or ORBIT_DISCORD_CHANNEL
//   owner    persona.json discord.ownerUserId, or ORBIT_DISCORD_OWNER: the only Discord account whose messages are run
//
// It speaks the Discord Gateway (v10, JSON) over Node's built-in WebSocket and the REST API over fetch: no dependency. Messages from
// anyone but the owner, from bots (itself included), from other channels, edits and DMs are ignored and never reach the model.
// Turns run one at a time, in arrival order. Confirmations (launches, server operations, protected vault writes) are never possible
// from Discord: the reply says how many are waiting and links the web page, where they are confirmed as always.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitText } from "./split-text.ts";
import type { PortState, PortStatus } from "./ports.ts";

export const API = "https://discord.com/api/v10";
export const MAX_CONTENT = 2000;
// GUILDS (1) | GUILD_MESSAGES (1 << 9) | MESSAGE_CONTENT (1 << 15, privileged: enabled on the app's Bot page).
export const INTENTS = 1 | (1 << 9) | (1 << 15);
const SNOWFLAKE = /^[0-9]{17,20}$/;
// Close codes after which reconnecting cannot help (https://discord.com/developers/docs/topics/opcodes-and-status-codes).
const FATAL: Record<number, string> = {
  4004: "Discord refused the bot token (authentication failed). Install a new token and restart.",
  4010: "Discord refused the shard settings.",
  4011: "Discord requires sharding for this bot.",
  4012: "Discord refused the gateway version.",
  4013: "Discord refused the intents.",
  4014: "Discord refused the intents: turn on Message Content Intent on the app's Bot page, then restart.",
};

export type ChannelTurnResult = { reply?: string; error?: string; busy?: boolean; proposals?: number };
export type ChannelTurn = (text: string) => Promise<ChannelTurnResult>;

export type DiscordConfig = { token: string; channelId: string; ownerId: string };
export type DiscordSelection = { config: DiscordConfig } | { off: string } | { invalid: string };

export function selectDiscordChannel(env: NodeJS.ProcessEnv, persona: { id: string; discord?: { channelId?: string; ownerUserId?: string } }): DiscordSelection {
  const channelId = (env.ORBIT_DISCORD_CHANNEL || persona.discord?.channelId || "").trim();
  const ownerId = (env.ORBIT_DISCORD_OWNER || persona.discord?.ownerUserId || "").trim();
  const credential = `${persona.id}.discord-bot`;
  let token = "";
  try {
    if (env.CREDENTIALS_DIRECTORY) token = readFileSync(join(env.CREDENTIALS_DIRECTORY, credential), "utf8").trim();
  } catch {
    token = "";
  }
  if (!token && !channelId) return { off: "Discord is not configured (no channel and no bot token)." };
  const missing = [!token && `the bot token (credential ${credential})`, !channelId && "the channel id (persona.json discord.channelId)", !ownerId && "the owner's Discord user id (persona.json discord.ownerUserId)"].filter(Boolean);
  if (missing.length) return { invalid: `Discord is off: missing ${missing.join(", ")}.` };
  if (!SNOWFLAKE.test(channelId)) return { invalid: "Discord is off: the channel id is not a Discord id." };
  if (!SNOWFLAKE.test(ownerId)) return { invalid: "Discord is off: the owner user id is not a Discord id." };
  if (/\s/.test(token)) return { invalid: `Discord is off: the bot token in ${credential} contains whitespace.` };
  return { config: { token, channelId, ownerId } };
}

type WS = { send(data: string): void; close(code?: number, reason?: string): void; addEventListener(type: string, fn: (ev: any) => void): void };
type Deps = {
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => WS;
  now?: () => Date;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  random?: () => number;
};

export type DiscordChannel = ReturnType<typeof discordChannel>;

export function discordChannel(config: DiscordConfig, turn: ChannelTurn, o: { webUrl?: string; name?: string } & Deps = {}) {
  const http = o.fetch ?? fetch;
  const Socket = o.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => WS);
  const now = o.now ?? (() => new Date());
  const later = o.setTimeout ?? setTimeout;
  const cancel = o.clearTimeout ?? clearTimeout;
  const every = o.setInterval ?? setInterval;
  const stopEvery = o.clearInterval ?? clearInterval;
  const random = o.random ?? Math.random;
  const log = o.log ?? ((event, detail) => console.log(JSON.stringify({ at: now().toISOString(), port: "discord", event, ...detail })));
  const auth = { authorization: `Bot ${config.token}`, "user-agent": "DiscordBot (https://github.com/DragonflyAI-sh/agent-platform, 1)" };

  let state: PortState = "down";
  let detail = "Connecting to Discord.";
  let verifiedAt = new Date(0).toISOString();
  let ws: WS | undefined;
  let seq: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let botId: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let firstBeat: ReturnType<typeof setTimeout> | undefined;
  let acked = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;
  let stopped = false;
  let fatal = false;
  let queue: Promise<void> = Promise.resolve();
  let handled = 0;

  const set = (s: PortState, d: string) => {
    state = s;
    detail = d;
    verifiedAt = now().toISOString();
  };

  async function rest(method: string, path: string, body?: unknown, attempt = 0): Promise<Response> {
    const res = await http(`${API}${path}`, { method, headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    if (res.status === 429 && attempt < 3) {
      const after = Number((await res.json().catch(() => ({})))?.retry_after);
      await new Promise((r) => later(r, Math.min(10_000, Math.max(250, Number.isFinite(after) ? after * 1000 : 1000))));
      return rest(method, path, body, attempt + 1);
    }
    return res;
  }

  // Posts a reply in order, each part within Discord's 2,000 characters; the first part answers the owner's message. Mentions in the
  // text never ping anyone. A part that fails is logged and the rest are not sent (so the channel never shows a reply with a hole).
  async function post(text: string, replyTo?: string): Promise<boolean> {
    const parts = splitText(text.trim() || "(empty reply)", MAX_CONTENT);
    for (const [i, content] of parts.entries()) {
      const res = await rest("POST", `/channels/${config.channelId}/messages`, { content, allowed_mentions: { parse: [] }, ...(i === 0 && replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}) }).catch((e) => e as Error);
      if (res instanceof Error || !res.ok) {
        log("post_failed", { part: i + 1, of: parts.length, status: res instanceof Error ? res.message.slice(0, 120) : res.status });
        return false;
      }
    }
    return true;
  }

  const typing = () => void rest("POST", `/channels/${config.channelId}/typing`).catch(() => undefined);

  async function handle(message: { id: string; content: string; attachments?: unknown[] }) {
    const text = message.content.trim();
    if (!text) {
      await post(message.attachments?.length ? "Photos and files can't be sent over Discord yet. Attach them on the web page instead." : "That message had no text, so there was nothing to answer.", message.id);
      return;
    }
    typing();
    const keepTyping = every(typing, 8000);
    let out: ChannelTurnResult;
    try {
      out = await turn(text);
    } catch (e) {
      out = { error: e instanceof Error ? e.message : "the turn failed" };
    } finally {
      stopEvery(keepTyping);
    }
    handled++;
    const web = o.webUrl ? ` ${o.webUrl}` : " the web page";
    const lines: string[] = [];
    if (out.busy) lines.push(`A reply is already in progress (maybe from the web page). This message was not run; send it again when that reply is done.`);
    else {
      if (out.reply) lines.push(out.reply);
      if (out.error) lines.push(`${out.reply ? "\n\n" : ""}⚠️ ${out.error}`);
      if (!out.reply && !out.error) lines.push("(The turn finished without a reply.)");
      if (out.proposals) lines.push(`\n\n🔒 ${out.proposals === 1 ? "1 proposal is" : `${out.proposals} proposals are`} waiting for your confirmation on${web}. Nothing has run yet.`);
    }
    await post(lines.join(""), message.id);
  }

  function dispatch(t: string, d: any) {
    if (t === "READY") {
      sessionId = d?.session_id;
      resumeUrl = d?.resume_gateway_url;
      botId = d?.user?.id;
      backoff = 1000;
      set("live", `Connected as ${d?.user?.username ?? "the bot"}; listening in channel ${config.channelId} for its owner only.`);
      log("ready", { bot: botId });
    } else if (t === "RESUMED") {
      backoff = 1000;
      set("live", `Connected (resumed); listening in channel ${config.channelId} for its owner only.`);
    } else if (t === "MESSAGE_CREATE") {
      if (d?.channel_id !== config.channelId || !d?.author || d.author.bot || d.author.id === botId) return;
      if (d.author.id !== config.ownerId) {
        log("ignored_non_owner", { author: String(d.author.id).slice(0, 20) });
        return;
      }
      if (d.type !== 0 && d.type !== 19) return; // default messages and replies only
      const message = { id: String(d.id), content: typeof d.content === "string" ? d.content : "", attachments: Array.isArray(d.attachments) ? d.attachments : [] };
      queue = queue.then(() => handle(message)).catch((e) => log("handle_failed", { detail: e instanceof Error ? e.message.slice(0, 200) : "error" }));
    }
  }

  function stopHeartbeat() {
    if (heartbeat) stopEvery(heartbeat);
    if (firstBeat) cancel(firstBeat);
    heartbeat = undefined;
    firstBeat = undefined;
  }

  function reconnect(resume: boolean, why: string) {
    stopHeartbeat();
    const old = ws;
    ws = undefined;
    try {
      old?.close(4000, "reconnecting");
    } catch {
      /* already closed */
    }
    if (stopped || fatal) return;
    if (!resume) {
      sessionId = undefined;
      seq = null;
    }
    if (state === "live") set("degraded", `Reconnecting to Discord: ${why}`);
    const wait = backoff;
    backoff = Math.min(60_000, backoff * 2);
    if (retry) cancel(retry);
    retry = later(() => void connect(), wait);
  }

  async function connect() {
    retry = undefined;
    if (stopped || fatal) return;
    let url = resumeUrl && sessionId ? resumeUrl : undefined;
    if (!url) {
      try {
        const res = await rest("GET", "/gateway/bot");
        if (res.status === 401) {
          fatal = true;
          set("down", FATAL[4004]!);
          log("fatal", { detail: FATAL[4004] });
          return;
        }
        if (!res.ok) throw new Error(`gateway lookup answered ${res.status}`);
        url = String((await res.json())?.url ?? "");
        if (!/^wss:\/\//.test(url)) throw new Error("gateway lookup gave no wss:// URL");
      } catch (e) {
        set("down", `Cannot reach Discord: ${e instanceof Error ? e.message.slice(0, 160) : "error"}. Retrying.`);
        reconnect(false, "gateway lookup failed");
        return;
      }
    }
    const socket = new Socket(`${url}/?v=10&encoding=json`);
    ws = socket;
    socket.addEventListener("message", (ev) => {
      if (ws !== socket) return;
      let p: any;
      try {
        p = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (typeof p?.s === "number") seq = p.s;
      switch (p?.op) {
        case 10: {
          const interval = Number(p.d?.heartbeat_interval) || 41_250;
          stopHeartbeat();
          acked = true;
          const beat = () => {
            if (!acked) return reconnect(true, "no heartbeat acknowledgement");
            acked = false;
            socket.send(JSON.stringify({ op: 1, d: seq }));
          };
          firstBeat = later(() => {
            firstBeat = undefined;
            if (ws !== socket) return;
            beat();
            heartbeat = every(beat, interval);
          }, Math.floor(interval * random()));
          if (sessionId && seq !== null) socket.send(JSON.stringify({ op: 6, d: { token: config.token, session_id: sessionId, seq } }));
          else socket.send(JSON.stringify({ op: 2, d: { token: config.token, intents: INTENTS, properties: { os: "linux", browser: "agent-platform", device: "agent-platform" } } }));
          break;
        }
        case 11:
          acked = true;
          if (state === "live") verifiedAt = now().toISOString();
          break;
        case 1:
          socket.send(JSON.stringify({ op: 1, d: seq }));
          break;
        case 7:
          reconnect(true, "Discord asked for a reconnect");
          break;
        case 9:
          later(() => reconnect(p.d === true, "Discord invalidated the session"), 1000 + Math.floor(random() * 4000));
          break;
        case 0:
          dispatch(String(p.t), p.d);
          break;
      }
    });
    socket.addEventListener("close", (ev) => {
      if (ws !== socket) return;
      const code = Number(ev?.code);
      if (FATAL[code]) {
        fatal = true;
        stopHeartbeat();
        ws = undefined;
        set("down", FATAL[code]!);
        log("fatal", { code, detail: FATAL[code] });
        return;
      }
      reconnect(code !== 4007 && code !== 4009 && code !== 1000, `connection closed (${code || "no code"})`);
    });
    socket.addEventListener("error", () => undefined);
  }

  return {
    start() {
      stopped = false;
      void connect();
    },
    stop() {
      stopped = true;
      stopHeartbeat();
      if (retry) cancel(retry);
      try {
        ws?.close(1000, "shutting down");
      } catch {
        /* already closed */
      }
      ws = undefined;
    },
    status(): PortStatus {
      return { port: "discord", state, impl: "discord-gateway", detail, verifiedAt };
    },
    // Tests: wait for queued turns and replies.
    idle: () => queue,
    handled: () => handled,
  };
}

// The port status for a Discord channel that is configured wrongly (partly set): down, with the reason, so /status and the watch say so.
export function discordOffStatus(reason: string): PortStatus {
  return { port: "discord", state: "down", impl: "discord-gateway", detail: reason, verifiedAt: new Date().toISOString() };
}
