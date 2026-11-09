import { connect } from "node:net";
import type { Result } from "./ports.ts";
import { ACTIONS, MAX_RESPONSE_BYTES, SOCKET_PATH, parseRequest, redactDeep, type Action } from "./ops/protocol.ts";

// ORBIT's side of orbit-ops. Who may connect is decided by the kernel (socket group orbit-ops, mode 0660), not here.
// Read-only: the helper has no action that changes anything. When it is not installed or not reachable the answer says
// so; nothing is invented.
export type Ops = { call(action: Action, args?: Record<string, unknown>): Promise<Result<unknown>> };

const TIMEOUT_MS = 8000;

export function opsClient(socketPath = SOCKET_PATH, timeoutMs = TIMEOUT_MS): Ops {
  return {
    async call(action, args = {}) {
      // Same strict validation the helper applies, so a bad call never leaves ORBIT.
      const request = JSON.stringify({ action, ...args });
      parseRequest(request);
      return await new Promise<Result<unknown>>((resolve, reject) => {
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
        const timer = setTimeout(() => end(() => reject(new Error("orbit-ops did not answer in time."))), timeoutMs);
        socket.on("connect", () => socket.write(`${request}\n`));
        socket.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES + 1024) end(() => reject(new Error("orbit-ops answered with more than the response limit.")));
          else if (body.includes("\n")) end(() => finish(body.split("\n")[0]!, action, resolve, reject));
        });
        socket.on("end", () => end(() => (body ? finish(body, action, resolve, reject) : reject(new Error("orbit-ops closed the connection without answering.")))));
        socket.on("error", (err: NodeJS.ErrnoException) =>
          end(() =>
            reject(
              new Error(
                err.code === "ENOENT" || err.code === "ECONNREFUSED"
                  ? "orbit-ops is not available: the helper socket is not there (the root helper is not installed or not running)."
                  : err.code === "EACCES" || err.code === "EPERM"
                    ? "orbit-ops refused access: the ORBIT service is not in the orbit-ops group (the installer has not been run, or orbit has not been restarted since)."
                    : "orbit-ops could not be reached.",
              ),
            ),
          ),
        );
      });
    },
  };
}

function finish(line: string, action: Action, resolve: (r: Result<unknown>) => void, reject: (e: Error) => void): void {
  try {
    const res = JSON.parse(line) as { ok?: unknown; action?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    if (res.ok === true && res.action === action) return resolve({ value: redactDeep(res.data), provenance: "live", source: `ops/${action}` });
    if (res.ok === false && typeof res.error?.message === "string") return reject(new Error(`orbit-ops refused: ${redactDeep(res.error.message).slice(0, 200)}`));
  } catch {
    // fall through
  }
  reject(new Error("orbit-ops sent an answer ORBIT could not understand."));
}

export { ACTIONS };
