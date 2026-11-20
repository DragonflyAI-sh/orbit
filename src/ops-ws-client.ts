import { connect } from "node:net";
import { WS_MAX_RESPONSE_BYTES, WS_SOCKET_PATH, parseWsRequest, redact } from "./ops/ws-protocol.ts";
import { redactDeep } from "./ops/protocol.ts";

// ORBIT's side of orbit-ops-ws (docs/orbit-ops-ws.md). The kernel decides who may connect (socket group orbit-ops, mode 0660). ORBIT
// sends ws_setup or ws_revoke only for an operation the owner has confirmed; this client never decides that. A request the helper
// would refuse as malformed never leaves ORBIT.
export type WsReply = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };
export type WsHostClient = {
  status(): Promise<WsReply>;
  call(action: "ws_setup" | "ws_revoke" | "op_status", opId: string, planKey?: string): Promise<WsReply>;
};

const TIMEOUT_MS = 20_000;

export function wsHostClient(socketPath = WS_SOCKET_PATH, timeoutMs = TIMEOUT_MS): WsHostClient {
  const send = async (req: Record<string, unknown>): Promise<WsReply> => {
    const request = JSON.stringify(req);
    parseWsRequest(request); // the same strict validation the helper applies
    return await new Promise<WsReply>((resolve, reject) => {
      const socket = connect(socketPath);
      let body = "";
      let done = false;
      const end = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(() => end(() => reject(new Error("orbit-ops-ws did not answer in time."))), timeoutMs);
      socket.on("connect", () => socket.write(`${request}\n`));
      socket.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > WS_MAX_RESPONSE_BYTES + 1024) end(() => reject(new Error("orbit-ops-ws answered with more than the response limit.")));
        else if (body.includes("\n")) end(() => parse(body.split("\n")[0]!, resolve, reject));
      });
      socket.on("end", () => end(() => (body ? parse(body, resolve, reject) : reject(new Error("orbit-ops-ws closed the connection without answering.")))));
      socket.on("error", (err: NodeJS.ErrnoException) =>
        end(() =>
          reject(
            new Error(
              err.code === "ENOENT"
                ? "orbit-ops-ws is not available: the workspace host-setup helper socket is not there (not installed)."
                : err.code === "ECONNREFUSED"
                  ? "orbit-ops-ws is not available: the workspace host-setup helper socket does not accept connections (installed but not running)."
                  : err.code === "EACCES" || err.code === "EPERM"
                    ? "orbit-ops-ws refused access: the ORBIT service is not in the orbit-ops group."
                    : "orbit-ops-ws could not be reached.",
            ),
          ),
        ),
      );
    });
  };
  return {
    status: () => send({ action: "ws_status" }),
    call: (action, opId, planKey) => send({ action, opId, ...(planKey !== undefined ? { planKey } : {}) }),
  };
}

function parse(line: string, resolve: (r: WsReply) => void, reject: (e: Error) => void): void {
  try {
    const res = JSON.parse(line) as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    if (res.ok === true && res.data && typeof res.data === "object") return resolve({ ok: true, data: redactDeep(res.data as Record<string, unknown>) });
    if (res.ok === false && typeof res.error?.message === "string") {
      return resolve({ ok: false, code: typeof res.error.code === "string" ? res.error.code.slice(0, 40) : "error", message: redact(res.error.message).slice(0, 300) });
    }
  } catch {
    // fall through
  }
  reject(new Error("orbit-ops-ws sent an answer ORBIT could not understand."));
}
