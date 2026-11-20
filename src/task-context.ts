import { posix } from "node:path";
import type { ChatTool } from "./agent.ts";
import type { MemoryPort } from "./memory.ts";
import { RECENT_NOTE_PATH } from "./recent-context.ts";

// The task-scoped memory policy (docs/adr/0003-supervised-tasks.md, "Isolation").
//
// A task turn (supervised or interactive) runs without the rolling recent-context note: that note is a model-written summary of what Rai
// has been doing across ALL conversations, so feeding it to a task would carry other conversations into the task session. The thread
// service for task sessions is already built without it (no `recent` port), but the same note is also an ordinary vault file
// (Memory/recent-context.md), so ordinary memory search could still pull it in as an automatic excerpt, and the read-only memory tools
// could read it directly. This module closes those routes and only those:
// - memory search (automatic excerpts and memory_search) never returns the note;
// - memory_read and memory_read_page refuse it, under any spelling that resolves to it (./, //, ../, a leading slash, letter case);
// - the vault write tools (offered only in an interactive task turn, when Rai is writing) refuse it as a target, so a replace_text
//   cannot be used to probe its content.
// Every other vault note stays reachable exactly as in any chat (project notes, task notes, the vault rules): this is not general
// conversation isolation, and the docs say so.

export const TASK_EXCLUDED_NOTES: readonly string[] = [RECENT_NOTE_PATH];
const EXCLUDED = new Set(TASK_EXCLUDED_NOTES.map((p) => p.toLowerCase()));

// The vault-relative form a path resolves to (the memory port resolves it against the vault root the same way), lower-cased, so every
// spelling of an excluded note compares equal. Not a validator: the memory port and the vault pipeline still check paths themselves.
export function normalizedNotePath(p: string): string {
  let s = p.normalize("NFC").trim().replace(/\\/g, "/");
  s = posix.normalize(`/${s}`).replace(/^\/+/, "");
  return s.toLowerCase();
}
export const isTaskExcludedNote = (p: unknown): boolean => typeof p === "string" && EXCLUDED.has(normalizedNotePath(p));

// The refusal of an excluded note. A class, so the paged reader reports it as `denied` (not as the vault being unavailable).
export class TaskNoteRefused extends Error {}

export const EXCLUDED_REFUSAL = `that note is not available in a task session: ${RECENT_NOTE_PATH} is ORBIT's rolling summary of all of Rai's conversations, and a task works without other conversations' context. Nothing was read.`;

// The memory port a task turn uses: the same notes, minus the excluded ones.
export function taskMemory(memory: MemoryPort): MemoryPort {
  return {
    ...memory,
    name: "memory",
    status: () => memory.status(),
    search: (query, limit = 5) => {
      const r = memory.search(query, limit + TASK_EXCLUDED_NOTES.length);
      return { ...r, value: r.value.filter((h) => !isTaskExcludedNote(h.path)).slice(0, limit) };
    },
    read: (path) => {
      if (isTaskExcludedNote(path)) throw new TaskNoteRefused(EXCLUDED_REFUSAL);
      return memory.read(path);
    },
    ...(memory.refresh ? { refresh: (ms?: number) => memory.refresh!(ms) } : {}),
    ...(memory.invalidate ? { invalidate: () => memory.invalidate!() } : {}),
    ...(memory.sourceInfo ? { sourceInfo: () => memory.sourceInfo!() } : {}),
  };
}

// Tools in a task turn that take a vault path (the vault write tools) refuse an excluded note. Read tools get the filtered memory port
// instead (src/server.ts prepare), so they are not wrapped here.
export function taskScopedTools(tools: ChatTool[]): ChatTool[] {
  return tools.map((t) =>
    t.name.startsWith("vault_") && t.readOnly !== true
      ? {
          ...t,
          run: async (a, ctx) => {
            if (isTaskExcludedNote(a.path)) throw new Error(`${t.name} is refused here: ${EXCLUDED_REFUSAL.replace("Nothing was read.", "Nothing was written.")}`);
            return t.run(a, ctx);
          },
        }
      : t,
  );
}
