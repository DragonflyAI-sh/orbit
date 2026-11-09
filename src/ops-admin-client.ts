import { connect } from "node:net";
import { ADMIN_MAX_RESPONSE_BYTES, ADMIN_SOCKET_PATH, parseAdminRequest, redact, type AdminAction, type ConfigChanges } from "./ops/admin-protocol.ts";
import { redactDeep } from "./ops/protocol.ts";

// ORBIT's side of orbit-ops-admin. The kernel decides who may connect (socket group orbit-ops, mode 0660). ORBIT only calls it
// for an operation the owner has confirmed; this client never decides that.
export type AdminReply = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };
export type AdminClient = { call(action: AdminAction, opId: string, changes?: ConfigChanges): Promise<AdminReply> };

const TIMEOUT_MS = 10_000;

export function adminClient(socketPath = ADMIN_SOCKET_PATH, timeoutMs = TIMEOUT_MS): AdminClient {
  return {
    async call(action, opId, changes) {
      const request = JSON.stringify({ action, opId, ...(changes ? { changes } : {}) });
      parseAdminRequest(request); // the same strict validation the helper applies, so a bad call never leaves ORBIT
      return await new Promise<AdminReply>((resolve, reject) => {
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
        const timer = setTimeout(() => end(() => reject(new Error("orbit-ops-admin did not answer in time."))), timeoutMs);
        socket.on("connect", () => socket.write(`${request}\n`));
        socket.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > ADMIN_MAX_RESPONSE_BYTES + 1024) end(() => reject(new Error("orbit-ops-admin answered with more than the response limit.")));
          else if (body.includes("\n")) end(() => parse(body.split("\n")[0]!, resolve, reject));
        });
        socket.on("end", () => end(() => (body ? parse(body, resolve, reject) : reject(new Error("orbit-ops-admin closed the connection without answering.")))));
        socket.on("error", (err: NodeJS.ErrnoException) =>
          end(() =>
            reject(
              new Error(
                err.code === "ENOENT" || err.code === "ECONNREFUSED"
                  ? "orbit-ops-admin is not available: the admin helper socket is not there (tier 2 is not installed or not running)."
                  : err.code === "EACCES" || err.code === "EPERM"
                    ? "orbit-ops-admin refused access: the ORBIT service is not in the orbit-ops group."
                    : "orbit-ops-admin could not be reached.",
              ),
            ),
          ),
        );
      });
    },
  };
}

function parse(line: string, resolve: (r: AdminReply) => void, reject: (e: Error) => void): void {
  try {
    const res = JSON.parse(line) as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    if (res.ok === true && res.data && typeof res.data === "object") return resolve({ ok: true, data: redactDeep(res.data as Record<string, unknown>) });
    if (res.ok === false && typeof res.error?.message === "string") {
      return resolve({ ok: false, code: typeof res.error.code === "string" ? res.error.code.slice(0, 40) : "error", message: redact(res.error.message).slice(0, 200) });
    }
  } catch {
    // fall through
  }
  reject(new Error("orbit-ops-admin sent an answer ORBIT could not understand."));
}
