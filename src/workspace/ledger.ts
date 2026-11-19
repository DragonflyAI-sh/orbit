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
  snapshotBefore?: string;
  snapshotAfter?: string;
  output?: { stdoutBytes: number; stderrBytes: number; truncated: { stdout: boolean; stderr: boolean }; limitBytes: number };
};

export const LEDGER_MAX = 200;
export const ACTIVE: OpState[] = ["accepted", "queued", "running"];

export function opLedger(dir: string | undefined) {
  const entries = new Map<string, OpEntry>();
  const memOut = new Map<string, { stdout: Buffer; stderr: Buffer }>();
  const file = dir ? join(dir, "ledger.json") : undefined;
  const outDir = dir ? join(dir, "output") : undefined;
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (file && existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: OpEntry[] };
    for (const e of raw.entries ?? []) entries.set(e.opId, e);
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
    if (outDir) for (const s of ["stdout", "stderr"]) rmSync(join(outDir, `${opId}.${s}`), { force: true });
  };
  return {
    get: (opId: string) => entries.get(opId),
    list: () => [...entries.values()],
    put(e: OpEntry) {
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
      if (!outDir) return void memOut.set(opId, { stdout, stderr });
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(outDir, `${opId}.stdout`), stdout, { mode: 0o600 });
      writeFileSync(join(outDir, `${opId}.stderr`), stderr, { mode: 0o600 });
    },
    readOutput(opId: string, stream: "stdout" | "stderr"): Buffer | undefined {
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
