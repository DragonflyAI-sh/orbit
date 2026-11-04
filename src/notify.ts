import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";
import { quietUntil } from "./time.ts";

export type Receipt = { at: string; detail: string };

export type Notification = {
  id: string;
  text: string;
  urgent: boolean;
  createdAt: string;
  holdUntil?: string;
  // A receipt exists only once a sink proves delivery; a failure is recorded, never a guess.
  shown?: Receipt;
  discord?: Receipt & { ok: boolean; messageId?: string };
};

export type Sink = { name: string; send(text: string): Promise<string> };

type Fetch = typeof fetch;

export function discordWebhook(url: string, fetcher: Fetch = fetch): Sink {
  return {
    name: "discord",
    send: async (text) => {
      const res = await fetcher(`${url}?wait=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const id = ((await res.json()) as { id?: string }).id;
      if (!id) throw new Error("Discord returned no message id");
      return id;
    },
  };
}

export function selectDiscord(env: NodeJS.ProcessEnv): Sink | undefined {
  try {
    const url = readFileSync(join(env.CREDENTIALS_DIRECTORY ?? "", "orbit.discord-webhook"), "utf8").trim();
    return env.CREDENTIALS_DIRECTORY && url.startsWith("https://") ? discordWebhook(url) : undefined;
  } catch {
    return undefined;
  }
}

const KEEP = 200;

export type Notifier = ReturnType<typeof notifier>;

export function notifier(store: Store<Notification[]>, discord?: Sink, now: () => Date = () => new Date()) {
  let lastPump: string | undefined;
  const list = () => store.read();
  const save = (items: Notification[]) => store.write(items.slice(-KEEP));
  const due = (n: Notification) => !n.holdUntil || new Date(n.holdUntil) <= now();

  return {
    send(text: string, urgent = false): Notification {
      const at = now();
      const hold = urgent ? undefined : quietUntil(at);
      const n: Notification = { id: randomUUID(), text, urgent, createdAt: at.toISOString(), holdUntil: hold?.toISOString() };
      save([...list(), n]);
      return n;
    },

    // Delivers due notifications to Discord when it is connected. Runs on the schedule tick.
    async pump(): Promise<void> {
      lastPump = now().toISOString();
      if (!discord) return;
      for (const n of list().filter((x) => due(x) && !x.discord?.ok)) {
        const at = now().toISOString();
        let receipt: Notification["discord"];
        try {
          receipt = { at, ok: true, messageId: await discord.send(n.text), detail: "Discord accepted the message" };
        } catch (err) {
          receipt = { at, ok: false, detail: `Discord send failed: ${err instanceof Error ? err.message : err}` };
        }
        save(list().map((x) => (x.id === n.id ? { ...x, discord: receipt } : x)));
      }
    },

    // What the web inbox should show: due and not yet shown.
    inbox: (): Notification[] => list().filter((n) => due(n) && !n.shown),

    recent: (): Notification[] => list().slice(-50).reverse(),

    ack(id: string): Notification | undefined {
      let found: Notification | undefined;
      save(
        list().map((n) => {
          if (n.id !== id || n.shown) return n;
          found = { ...n, shown: { at: now().toISOString(), detail: "Shown in the ORBIT web page" } };
          return found;
        }),
      );
      return found;
    },

    status(): PortStatus {
      const failed = list().filter((n) => n.discord && !n.discord.ok).length;
      const sinks = [
        "web inbox live",
        discord ? `Discord live${failed ? `, ${failed} failed sends` : ""}` : "Discord not connected (no orbit.discord-webhook credential)",
      ];
      const persisted = store.persisted ? "" : " Not persisted: notifications are lost on restart.";
      return {
        port: "notify",
        state: !store.persisted || failed ? "degraded" : "live",
        impl: discord ? "web-inbox+discord" : "web-inbox",
        detail: `${sinks.join("; ")}. Quiet hours 23:00-08:00 Pacific hold non-urgent messages.${persisted}`,
        verifiedAt: lastPump ?? now().toISOString(),
      };
    },
  };
}
