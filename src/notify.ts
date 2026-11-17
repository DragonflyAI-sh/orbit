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
  // `shown` is a display receipt, not a read receipt. With `listed: true` the web page reported that the note was listed in
  // its open notifications panel in a visible tab (docs/assistant.md, "Notifications"). Without it, the receipt came from an
  // older page that acknowledged on arrival; what it means cannot be told afterwards, so such receipts are kept as written.
  shown?: Receipt & { listed?: true };
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

    // Due and not yet shown (unchanged, for older pages and callers).
    inbox: (): Notification[] => list().filter((n) => due(n) && !n.shown),

    // What the web page lists until it is dismissed there: due notes not yet shown, plus those shown under the listing
    // receipt, oldest first. Notes acknowledged by an older page (a receipt without `listed`) are not included: their
    // receipts may predate this rule, and nothing here claims to recover them.
    current: (): Notification[] => list().filter((n) => due(n) && (!n.shown || n.shown.listed === true)),

    recent: (): Notification[] => list().slice(-50).reverse(),

    get: (id: string): Notification | undefined => list().find((n) => n.id === id),

    // Records the shown receipt. Idempotent: a note that already has one keeps it unchanged (a retry or a second tab never
    // rewrites it, and an old receipt is never upgraded), and the note is returned as it is. `listed` is the web page saying
    // the note was listed in its open, visible panel. Undefined only for an unknown id.
    ack(id: string, opts: { listed?: boolean } = {}): Notification | undefined {
      const existing = list().find((n) => n.id === id);
      if (!existing || existing.shown) return existing;
      const shown: Notification["shown"] = opts.listed
        ? { at: now().toISOString(), detail: "Listed in the open notifications panel of the ORBIT web page", listed: true }
        : { at: now().toISOString(), detail: "Shown in the ORBIT web page" };
      let found: Notification | undefined;
      save(list().map((n) => (n.id === id && !n.shown ? (found = { ...n, shown }) : n)));
      return found ?? list().find((n) => n.id === id);
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
