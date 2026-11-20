import { createHash } from "node:crypto";
import type { VaultClone } from "./vault/clone.ts";
import { parseEdit, VaultError } from "./vault/edit.ts";
import { blockerOf, openRequests, readiness, TaskError } from "./tasks.ts";
import type { Observers, Task, Tasks } from "./tasks.ts";
import { ZONE } from "./time.ts";

// Vault coherence for supervised tasks (docs/adr/0003-supervised-tasks.md, "Vault sync"), first slice.
//
// What it does: appends ONE status line for a task to a note Rai linked to it, under a heading that already exists in that note, through
// the existing vault write pipeline (src/vault/clone.ts): fetch, path rules, symlink refusal, secret check, AGENTS.md classification,
// one commit with its Log line, push without force, remote verification. Nothing here bypasses or widens that pipeline.
//
// What it does not do (deliberately, to respect the vault's own task schema, which this slice does not read or change):
// - it never creates a note, a heading or front matter, and never replaces or removes text: human edits are never overwritten;
// - it never maps task fields onto the note's own schema (status fields, checkboxes); that mapping needs the schema reviewed first;
// - it never writes a note the policy protects: a `needs_confirmation` classification is reported as `blocked`, no proposal is made.
//
// Idempotency: each line carries a content key (`orbit-task <id> #<key>`), a hash of the task facts it states. A sync whose key was
// already written (recorded, or found in the note after a crash between push and recording) writes nothing. A sync of unchanged facts
// writes nothing. Failures are recorded on the task (`vault.sync`: state, attempts, last error) and shown; retry is manual only.

export type TaskVaultPort = {
  // The note's current text, or undefined when it does not exist.
  read(path: string): Promise<string | undefined>;
  // Appends `text` at the end of the section `heading` of `path`, through the full pipeline. Resolves only when committed and verified.
  append(path: string, heading: string, text: string, summary: string): Promise<{ commit: string }>;
};

export function cloneTaskVault(clone: VaultClone): TaskVaultPort {
  return {
    // Fetch first, so the idempotency check reads the remote's current text (a line already pushed before a crash is found).
    read: async (path) => {
      await clone.sync();
      return clone.readNoteQueued(path);
    },
    append: async (path, heading, text, summary) => {
      const edit = parseEdit("append_section", { path, heading, text });
      const r = await clone.write([edit], { kind: "direct" }, { actor: "task-sync", summary });
      return { commit: r.commit };
    },
  };
}

// The facts a status line states, and their key.
export function statusFacts(t: Task, obs: Observers) {
  const r = readiness(t, obs);
  const blocker = blockerOf(t);
  return {
    lifecycle: t.lifecycle,
    next: t.nextAction?.text ?? null,
    waiting: openRequests(t).length,
    blocked: Boolean(blocker),
    accepted: r.criteria.filter((c) => c.satisfiedBy.length).length,
    criteria: r.criteria.length,
  };
}
export const factsKey = (f: ReturnType<typeof statusFacts>) => createHash("sha256").update(JSON.stringify(f)).digest("hex").slice(0, 12);
export const marker = (taskId: string, key: string) => `orbit-task ${taskId} #${key}`;

const oneLine = (s: string, n: number) => {
  const x = s.replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};
export function statusLine(t: Task, f: ReturnType<typeof statusFacts>, key: string, at: Date): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const parts = [`ORBIT task status: ${f.lifecycle}`, f.next ? `next: ${oneLine(f.next, 160)}` : "next: not set", `acceptance evidence: ${f.accepted}/${f.criteria} criteria`, `requests waiting: ${f.waiting}${f.blocked ? " (blocked)" : ""}`];
  return `- ${day} ${parts.join("; ")} (${marker(t.id, key)})`;
}

// What a sync did, as far as ORBIT can prove it. Two facts are kept apart: the vault write (`written`: the pipeline committed, pushed
// and verified the line; `already-written`/`up-to-date`: nothing needed writing; `failed`/`blocked`: nothing was written; `unknown`: the
// pipeline could not confirm either way) and ORBIT's own bookkeeping on the task (`recorded`: whether the outcome was saved on the task
// record). A write that succeeded is never reported as not saved because the bookkeeping after it failed.
// - synced: written and recorded.
// - written-unrecorded: the line IS in the vault (commit given), but the task record could not be updated. Retrying the sync finds the
//   line by its key and records it without writing a second line.
// - unknown: the vault pipeline could not confirm whether the push landed. Not saved as far as anyone can tell; retrying is safe (the
//   key check finds the line if it did land).
export type SyncState = "synced" | "written-unrecorded" | "up-to-date" | "already-written" | "failed" | "blocked" | "unknown";
export type SyncOutcome = { state: SyncState; commit?: string; error?: string; key: string; written: boolean; recorded: boolean; retry?: string };
// The pipeline errors that leave the push outcome open. Everything else from the pipeline is raised before any push (nothing written).
const OPEN_ENDED: readonly string[] = ["unverified", "push_failed"];

export function taskVaultSync(deps: { tasks: Tasks; port: TaskVaultPort | undefined; observers: Observers; now?: () => Date }) {
  const { tasks, port, observers } = deps;
  const now = deps.now ?? (() => new Date());
  const inFlight = new Set<string>();

  // Bookkeeping that never decides the outcome: returns whether the task record took it.
  const record = (id: string, patch: Parameters<Tasks["recordSync"]>[1]): boolean => {
    try {
      tasks.recordSync(id, patch);
      return true;
    } catch {
      return false;
    }
  };
  const RETRY_RECORD = "Run the sync again: it finds the line by its key and records it on the task without writing another line.";

  async function sync(id: string): Promise<SyncOutcome> {
    const t = tasks.get(id);
    if (!t) throw new TaskError(404, "No task with that id.");
    if (!t.vault) throw new TaskError(400, "This task has no linked vault note. Link one with vaultNote and vaultHeading first.");
    if (!port) {
      const recorded = record(id, { state: "failed", lastAttemptAt: now().toISOString(), attempts: t.vault.sync.attempts + 1, lastError: "Vault writes are not enabled on this ORBIT (no vault clone or credential). Nothing was written." });
      return { state: "failed", error: "vault writes are not enabled; nothing was written", key: "", written: false, recorded };
    }
    if (inFlight.has(id)) throw new TaskError(409, "A vault sync of this task is already running.");
    const f = statusFacts(t, observers);
    const key = factsKey(f);
    if (t.vault.sync.state === "synced" && t.vault.sync.syncedKey === key) return { state: "up-to-date", key, commit: t.vault.sync.commit, written: false, recorded: true };
    inFlight.add(id);
    const at = now();
    const attempt = { lastAttemptAt: at.toISOString(), attempts: t.vault.sync.attempts + 1 };
    try {
      let text: string | undefined;
      try {
        text = await port.read(t.vault.note);
      } catch (e) {
        const error = `NOT saved: the note could not be read before writing (${e instanceof VaultError ? `${e.code}: ` : ""}${e instanceof Error ? e.message.slice(0, 300) : "error"}). Nothing was written.`;
        const recorded = record(id, { ...attempt, state: "failed", lastError: error.slice(0, 500) });
        return { state: "failed", error, key, written: false, recorded };
      }
      if (text === undefined) {
        const error = `${t.vault.note} does not exist in the vault. ORBIT never creates task notes; create it (with the heading ${t.vault.heading}) or link another note. Nothing was written.`;
        const recorded = record(id, { ...attempt, state: "failed", lastError: error });
        return { state: "failed", error, key, written: false, recorded };
      }
      if (text.includes(marker(t.id, key))) {
        const recorded = record(id, { ...attempt, state: "synced", syncedKey: key, lastSuccessAt: at.toISOString(), lastError: undefined });
        return { state: "already-written", key, written: false, recorded, ...(recorded ? {} : { error: "The line is already in the vault, but ORBIT could not record that on the task.", retry: RETRY_RECORD }) };
      }
      let commit: string;
      try {
        commit = (await port.append(t.vault.note, t.vault.heading, statusLine(t, f, key, at), `task status for ${oneLine(t.title, 60)}`)).commit;
      } catch (e) {
        const blocked = e instanceof VaultError && e.code === "needs_confirmation";
        const open = !(e instanceof VaultError) || OPEN_ENDED.includes(e.code);
        const error = blocked
          ? `The vault policy protects this note (${e.message}). Task sync never makes proposals; nothing was written.`
          : open
            ? `NOT confirmed saved: the vault pipeline could not confirm whether the line reached the vault (${e instanceof VaultError ? `${e.code}: ` : ""}${e instanceof Error ? e.message.slice(0, 300) : "error"}). Treat it as not saved; a retry is safe, since it finds the line by its key if it did land.`
            : `NOT saved (${(e as VaultError).code}): ${(e as VaultError).message} Nothing was written.`;
        const state = blocked ? "blocked" : open ? "unknown" : "failed";
        const recorded = record(id, { ...attempt, state, lastError: error.slice(0, 500) });
        return { state, error, key, written: false, recorded, ...(open ? { retry: "Run the sync again." } : {}) };
      }
      // The pipeline committed, pushed and verified the line. From here on the vault write is a fact, whatever the bookkeeping does.
      const recorded = record(id, { ...attempt, state: "synced", syncedKey: key, commit, lastSuccessAt: now().toISOString(), lastError: undefined });
      if (recorded) return { state: "synced", commit, key, written: true, recorded: true };
      return { state: "written-unrecorded", commit, key, written: true, recorded: false, error: `The status line WAS committed and pushed (commit ${commit.slice(0, 12)}), but ORBIT could not record that on the task, so the task still shows its previous sync state.`, retry: RETRY_RECORD };
    } finally {
      inFlight.delete(id);
    }
  }
  return { sync, enabled: () => Boolean(port) };
}
export type TaskVaultSync = ReturnType<typeof taskVaultSync>;
