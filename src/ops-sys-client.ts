import { connect } from "node:net";
import { SYS_MAX_RESPONSE_BYTES, SYS_SOCKET_PATH, parseSysRequest, redact } from "./ops/sys-protocol.ts";
import { redactDeep } from "./ops/protocol.ts";

// ORBIT's side of orbit-ops-sys (tier 3). The kernel decides who may connect (socket group orbit-ops, mode 0660). ORBIT only
// sends a mutation for an operation the owner has confirmed; this client never decides that. A request the privileged side would
// refuse as malformed (bad target, digest that does not match) never leaves ORBIT.
export type SysReply = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };
export type SysClient = { call(request: Record<string, unknown>): Promise<SysReply> };

const TIMEOUT_MS = 10_000;

export function sysClient(socketPath = SYS_SOCKET_PATH, timeoutMs = TIMEOUT_MS): SysClient {
  return {
    async call(req) {
      const request = JSON.stringify(req);
      parseSysRequest(request);
      return await new Promise<SysReply>((resolve, reject) => {
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
        const timer = setTimeout(() => end(() => reject(new Error("orbit-ops-sys did not answer in time."))), timeoutMs);
        socket.on("connect", () => socket.write(`${request}\n`));
        socket.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > SYS_MAX_RESPONSE_BYTES + 1024) end(() => reject(new Error("orbit-ops-sys answered with more than the response limit.")));
          else if (body.includes("\n")) end(() => parse(body.split("\n")[0]!, resolve, reject));
        });
        socket.on("end", () => end(() => (body ? parse(body, resolve, reject) : reject(new Error("orbit-ops-sys closed the connection without answering.")))));
        socket.on("error", (err: NodeJS.ErrnoException) =>
          end(() =>
            reject(
              new Error(
                err.code === "ENOENT" || err.code === "ECONNREFUSED"
                  ? "orbit-ops-sys is not available: the tier 3 helper socket is not there (tier 3 is not installed or not running)."
                  : err.code === "EACCES" || err.code === "EPERM"
                    ? "orbit-ops-sys refused access: the ORBIT service is not in the orbit-ops group."
                    : "orbit-ops-sys could not be reached.",
              ),
            ),
          ),
        );
      });
    },
  };
}

function parse(line: string, resolve: (r: SysReply) => void, reject: (e: Error) => void): void {
  try {
    const res = JSON.parse(line) as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    if (res.ok === true && res.data && typeof res.data === "object") return resolve({ ok: true, data: redactDeep(res.data as Record<string, unknown>) });
    if (res.ok === false && typeof res.error?.message === "string") {
      return resolve({ ok: false, code: typeof res.error.code === "string" ? res.error.code.slice(0, 40) : "error", message: redact(res.error.message).slice(0, 300) });
    }
  } catch {
    // fall through
  }
  reject(new Error("orbit-ops-sys sent an answer ORBIT could not understand."));
}
