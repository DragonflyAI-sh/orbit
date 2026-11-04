import { request } from "node:http";
import type { PortStatus } from "./ports.ts";

export type Device = { name: string; os: string; online: boolean; lastSeen?: string; self: boolean };

type Peer = { HostName?: string; OS?: string; Online?: boolean; LastSeen?: string; UserID?: number };
type TailscaleStatus = { Self?: Peer; Peer?: Record<string, Peer>; User?: Record<string, { LoginName?: string }> };

export type FetchStatus = () => Promise<TailscaleStatus>;

const SOCKET = "/run/tailscale/tailscaled.sock";
const STALE_MS = 5 * 60 * 1000;

export function tailscaleStatus(socketPath = SOCKET): FetchStatus {
  return () =>
    new Promise((resolve, reject) => {
      const req = request(
        { socketPath, path: "/localapi/v0/status", headers: { host: "local-tailscaled.sock" }, timeout: 3000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) throw new Error(`tailscaled returned HTTP ${res.statusCode}`);
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("tailscaled did not answer")));
      req.end();
    });
}

// iOS reports its hostname as "localhost"; name it by what it is instead.
function nameOf(peer: Peer): string {
  const host = peer.HostName ?? "unknown";
  return host === "localhost" ? `${peer.OS ?? "unknown"} device` : host;
}

export type Nodes = ReturnType<typeof nodes>;

// Presence for the owner's own devices on the tailnet, read from this host's tailscaled.
export function nodes(fetchStatus: FetchStatus, owner: string | undefined, now: () => Date = () => new Date()) {
  let devices: Device[] = [];
  let checkedAt: string | undefined;
  let error: string | undefined;

  return {
    async refresh(): Promise<void> {
      try {
        const status = await fetchStatus();
        const ownerIds = new Set(
          Object.entries(status.User ?? {})
            .filter(([, u]) => owner && u.LoginName === owner)
            .map(([id]) => Number(id)),
        );
        const mine = Object.values(status.Peer ?? {}).filter((p) => p.UserID !== undefined && ownerIds.has(p.UserID));
        devices = [
          ...(status.Self ? [{ name: nameOf(status.Self), os: status.Self.OS ?? "unknown", online: true, self: true }] : []),
          ...mine.map((p) => ({
            name: nameOf(p),
            os: p.OS ?? "unknown",
            online: p.Online === true,
            // Tailscale's last-seen is only meaningful once a device is offline.
            ...(p.Online ? {} : { lastSeen: p.LastSeen }),
            self: false,
          })),
        ];
        checkedAt = now().toISOString();
        error = undefined;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    },

    list: (): { devices: Device[]; checkedAt?: string } => ({ devices, checkedAt }),

    summary(): string {
      if (!checkedAt) return "Device presence is unknown.";
      return devices
        .map((d) => `- ${d.name} (${d.os}${d.self ? ", this host" : ""}): ${d.online ? "online" : `offline${d.lastSeen ? `, last seen ${d.lastSeen}` : ""}`}`)
        .join("\n");
    },

    status(): PortStatus {
      const at = now();
      if (error && !checkedAt) return { port: "nodes", state: "down", impl: "tailscale-presence", detail: `Cannot read devices: ${error}`, verifiedAt: at.toISOString() };
      const online = devices.filter((d) => d.online).length;
      const stale = !checkedAt || at.getTime() - new Date(checkedAt).getTime() > STALE_MS;
      return {
        port: "nodes",
        state: error || stale ? "degraded" : "live",
        impl: "tailscale-presence",
        detail: `${online} of ${devices.length} devices online. Presence only; desktop notifications need a helper on each laptop.${error ? ` Last check failed: ${error}` : ""}`,
        verifiedAt: checkedAt ?? new Date(0).toISOString(),
      };
    },
  };
}
