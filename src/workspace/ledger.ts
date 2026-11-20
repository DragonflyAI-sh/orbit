import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// The workspace operations ledger: what happened to every CONFIRMED write, patch and exec, from worker evidence only. States:
//   accepted  - Rai confirmed; nothing has been attempted yet
//   queued    - an exec waiting for a run slot or for its workspace
//   running   - the sandbox process was started (a pid exists)
//   completed - a file operation was applied / a command exited on its own (any exit code)
//   failed    - refused at run time (stale, busy, sandbox unavailable) or killed by its timeout; reason says which
//   cancelled - withdrawn before it started, or killed by a cancellation and observed to have exited
//   uncertain - ORBIT stopped while it was in flight: it may have had some effect; never reported as success
// Open proposals are not here: they live in the proposal store and the thread card until confirmed.
// Output of runs is stored separately (0600), bounded, and deleted with the entry it belongs to.

export type OpState = "accepted" | "queued" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
export type OpKind = "fs_write" | "fs_patch" | "exec";
export type OpEvent = { at: string; state: OpState | "starting" | "cancel_requested"; detail?: string };
export type OpEntry = {
  opId: string;
  proposalId: string;
  kind: OpKind;
  workspace: string;
  digest: string;
  state: OpState;
  createdAt: string;
  updatedAt: string;
  events: OpEvent[];
  summary: string;
  reason?: string;
  path?: string;
  newVersion?: string;
  exitCode?: number | null;
  signal?: string | null;
  killedBy?: "timeout" | "cancel";
  treeGone?: boolean;
  // Set when a later reap found the run's cgroup gone or empty: the evidence that ends a cleanup quarantine (WS-R8).
  cleanupVerifiedAt?: string;
  snapshotBefore?: string;
  snapshotAfter?: string;
  output?: { stdoutBytes: number; stderrBytes: number; truncated: { stdout: boolean; stderr: boolean }; limitBytes: number };
};

export const LEDGER_MAX = 200;
// A ledger that cannot be trusted stops the workspace tools (fail closed), never ORBIT itself (src/workspace/select.ts).
export class LedgerError extends Error {}
export const ACTIVE: OpState[] = ["accepted", "queued", "running"];
const STATES: OpState[] = ["accepted", "queued", "running", "completed", "failed", "cancelled", "uncertain"];
const KINDS: OpKind[] = ["fs_write", "fs_patch", "exec"];
// Operation ids are ORBIT's own ("ws-" + 16 hex, src/workspace/service.ts). They become file names (output/<opId>.*) and, for exec,
// run directory and cgroup names, so an entry with any other id makes the whole ledger untrusted (WS-R4).
export const OP_ID = /^ws-[0-9a-f]{16}$/;
const entryOk = (e: unknown): boolean => {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<OpEntry>;
  return typeof x.opId === "string" && OP_ID.test(x.opId) && STATES.includes(x.state as OpState) && KINDS.includes(x.kind as OpKind) && typeof x.workspace === "string" && Array.isArray(x.events);
};

export function opLedger(dir: string | undefined) {
  const entries = new Map<string, OpEntry>();
  const memOut = new Map<string, { stdout: Buffer; stderr: Buffer }>();
  const file = dir ? join(dir, "ledger.json") : undefined;
  const outDir = dir ? join(dir, "output") : undefined;
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (file && existsSync(file)) {
    let raw: { entries?: unknown };
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    } catch {
      throw new LedgerError("The workspace ledger (ledger.json) cannot be read or is not valid JSON; it was left untouched.");
    }
    if (!Array.isArray(raw?.entries) || !raw.entries.every(entryOk)) {
      throw new LedgerError("The workspace ledger (ledger.json) has an unexpected shape or an operation id ORBIT did not issue; it was left untouched.");
    }
    for (const e of raw.entries as OpEntry[]) entries.set(e.opId, e);
  }
  const persist = () => {
    while (entries.size > LEDGER_MAX) {
      const oldest = [...entries.values()].find((e) => !ACTIVE.includes(e.state));
      if (!oldest) break;
      entries.delete(oldest.opId);
      dropOutput(oldest.opId);
    }
    if (!file) return;
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify({ schema: 1, entries: [...entries.values()] }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  };
  const dropOutput = (opId: string) => {
    memOut.delete(opId);
    if (outDir && OP_ID.test(opId)) for (const s of ["stdout", "stderr"]) rmSync(join(outDir, `${opId}.${s}`), { force: true });
  };
  return {
    get: (opId: string) => entries.get(opId),
    list: () => [...entries.values()],
    put(e: OpEntry) {
      if (!OP_ID.test(e.opId)) throw new LedgerError("refused: not an ORBIT operation id");
      entries.set(e.opId, e);
      persist();
    },
    update(opId: string, patch: Partial<OpEntry>, event?: Omit<OpEvent, "at">, at?: string): OpEntry | undefined {
      const e = entries.get(opId);
      if (!e) return undefined;
      const when = at ?? new Date().toISOString();
      const next: OpEntry = { ...e, ...patch, updatedAt: when, events: event ? [...e.events, { at: when, ...event }].slice(-40) : e.events };
      entries.set(opId, next);
      persist();
      return next;
    },
    saveOutput(opId: string, stdout: Buffer, stderr: Buffer) {
      if (!OP_ID.test(opId)) return;
      if (!outDir) return void memOut.set(opId, { stdout, stderr });
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(outDir, `${opId}.stdout`), stdout, { mode: 0o600 });
      writeFileSync(join(outDir, `${opId}.stderr`), stderr, { mode: 0o600 });
    },
    readOutput(opId: string, stream: "stdout" | "stderr"): Buffer | undefined {
      if (!OP_ID.test(opId)) return undefined;
      if (!outDir) return memOut.get(opId)?.[stream];
      try {
        return readFileSync(join(outDir, `${opId}.${stream}`));
      } catch {
        return undefined;
      }
    },
  };
}
export type OpLedger = ReturnType<typeof opLedger>;
