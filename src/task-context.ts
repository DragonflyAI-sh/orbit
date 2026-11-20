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
// - memory_read and memory_read_page take only a plain vault-relative path in a task turn (below), and refuse the note;
// - the vault write tools (offered only in an interactive task turn, when Rai is writing) take the same plain paths and refuse the note
//   as a target, so a replace_text cannot be used to probe its content.
// Every other vault note stays reachable exactly as in any chat (project notes, task notes, the vault rules): this is not general
// conversation isolation, and the docs say so.
//
// Why a canonical form and not a list of spellings (Repair 2). The vault memory port (src/memory.ts vaultMemory) reads a note by
// `relative(root, resolve(root, path))`: an ABSOLUTE path naming a file under the vault root, or a relative one that climbs out of the
// root and back in through the root's own directory name (`../vault/Memory/...`), resolves to the same note. Repair 1 compared a
// normalized string that treated those as other notes, so they bypassed the exclusion. Now a task turn's path must be one the check and
// the port agree on by construction:
// - refused: absolute paths (`/...`, `\...`, `C:...`, `~...`), any `..` segment, backslashes, control characters, and an empty path;
// - otherwise the path is reduced to its segments (empty and `.` segments dropped, so `./`, `//` and a trailing `/` collapse) and THAT
//   canonical path is what is checked and what is handed to the port. With no `..`, no leading `/` and no `.`/empty segments,
//   `resolve(root, p)` is `root/p` and `relative` gives `p` back, so the port looks up exactly the string that was checked;
// - the check ignores letter case (stricter than the port, whose lookup is case-sensitive);
// - symbolic links: the port never indexes a symlinked file or directory (collect skips them), so no alias path can name the note;
//   a path through a symlink answers "no such note".
// The refusals of the spellings above apply to every note in a task turn (none of them is needed to name a note: memory_search returns
// plain paths); ordinary chats and the Assistant keep the port's own rules.

export const TASK_EXCLUDED_NOTES: readonly string[] = [RECENT_NOTE_PATH];
const EXCLUDED = new Set(TASK_EXCLUDED_NOTES.map((p) => p.toLowerCase()));

export type TaskNotePath = { ok: true; path: string; excluded: boolean } | { ok: false; why: string };

// The canonical vault-relative path a task turn may use, or why the spelling is refused. See the header for the exact boundary.
export function taskNotePath(p: unknown): TaskNotePath {
  if (typeof p !== "string") return { ok: false, why: "the path is not text" };
  const s = p.trim();
  if (!s) return { ok: false, why: "the path is empty" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, why: "the path has control characters" };
  if (s.includes("\\")) return { ok: false, why: "the path has a backslash; use / between folders" };
  if (s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:/.test(s)) return { ok: false, why: "absolute paths are not accepted in a task session; use the vault-relative path memory_search returned" };
  const parts = s.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.some((x) => x === "..")) return { ok: false, why: "paths with .. are not accepted in a task session; use the vault-relative path memory_search returned" };
  if (!parts.length) return { ok: false, why: "the path names no note" };
  const path = parts.join("/");
  return { ok: true, path, excluded: EXCLUDED.has(path.normalize("NFC").toLowerCase()) };
}
// True when a task turn may not read or write this path: the excluded note, or a spelling the task policy does not accept.
export const isTaskExcludedNote = (p: unknown): boolean => {
  const c = taskNotePath(p);
  return !c.ok || c.excluded;
};

// The refusal of an excluded note or an unaccepted spelling. A class, so the paged reader reports it as `denied` (not as the vault being
// unavailable).
export class TaskNoteRefused extends Error {}

export const EXCLUDED_REFUSAL = `that note is not available in a task session: ${RECENT_NOTE_PATH} is ORBIT's rolling summary of all of Rai's conversations, and a task works without other conversations' context. Nothing was read.`;
const spellingRefusal = (why: string) => `that path is refused in a task session: ${why}. Nothing was read.`;

// The path a task turn's read or write goes to, or the refusal (thrown). `verb`: what the caller would have done.
function checked(p: unknown, verb: "read" | "written"): string {
  const c = taskNotePath(p);
  const done = verb === "read" ? "Nothing was read." : "Nothing was written.";
  if (!c.ok) throw new TaskNoteRefused(spellingRefusal(c.why).replace("Nothing was read.", done));
  if (c.excluded) throw new TaskNoteRefused(EXCLUDED_REFUSAL.replace("Nothing was read.", done));
  return c.path;
}

// The memory port a task turn uses: the same notes, minus the excluded ones, read only by canonical path.
export function taskMemory(memory: MemoryPort): MemoryPort {
  return {
    ...memory,
    name: "memory",
    status: () => memory.status(),
    search: (query, limit = 5) => {
      const r = memory.search(query, limit + TASK_EXCLUDED_NOTES.length);
      return { ...r, value: r.value.filter((h) => !isTaskExcludedNote(h.path)).slice(0, limit) };
    },
    // The canonical path is what was checked, and it is what the port is given.
    read: (path) => memory.read(checked(path, "read")),
    ...(memory.refresh ? { refresh: (ms?: number) => memory.refresh!(ms) } : {}),
    ...(memory.invalidate ? { invalidate: () => memory.invalidate!() } : {}),
    ...(memory.sourceInfo ? { sourceInfo: () => memory.sourceInfo!() } : {}),
  };
}

// Tools in a task turn that take a vault path (the vault write tools) take the same canonical paths and refuse an excluded note. Read
// tools get the filtered memory port instead (src/server.ts prepare), so they are not wrapped here.
export function taskScopedTools(tools: ChatTool[]): ChatTool[] {
  return tools.map((t) =>
    t.name.startsWith("vault_") && t.readOnly !== true
      ? {
          ...t,
          run: async (a, ctx) => {
            let path: string;
            try {
              path = checked(a.path, "written");
            } catch (e) {
              throw new Error(`${t.name} is refused here: ${(e as Error).message}`);
            }
            return t.run({ ...a, path }, ctx);
          },
        }
      : t,
  );
}
