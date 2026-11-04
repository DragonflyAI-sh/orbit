import { request } from "node:http";
import type { IncomingMessage } from "node:http";

export type Identify = (req: IncomingMessage) => Promise<string | undefined>;

const SOCKET = "/run/tailscale/tailscaled.sock";

// Asks tailscaled who owns the node a request came from. Unknown means undefined, never a guess.
export function tailscaleIdentify(socketPath = SOCKET): Identify {
  return (req) =>
    new Promise((resolve) => {
      const addr = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      const lookup = request(
        { socketPath, path: `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, headers: { host: "local-tailscaled.sock" }, timeout: 2000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(res.statusCode === 200 ? JSON.parse(body).UserProfile?.LoginName : undefined);
            } catch {
              resolve(undefined);
            }
          });
        },
      );
      lookup.on("error", () => resolve(undefined));
      lookup.on("timeout", () => lookup.destroy());
      lookup.end();
    });
}
