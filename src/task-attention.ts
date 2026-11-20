import type { Provenance, Task } from "./tasks.ts";

// Supervisor attention (docs/adr/0003-supervised-tasks.md, "Repair 3: supervisor escalation"). Pure helpers over a task record; the
// task store (src/tasks.ts) calls them INSIDE the same store change as the event that raises or resolves an item, so an item and its
// cause are one durable fact: a restart, a busy Assistant or a failed write never leaves one without the other.
//
// An attention item says "something about this task needs the supervisor (the Assistant) or Rai". It is:
// - durable: stored on the task (`attention[]`), shown every Assistant turn until it is resolved or acknowledged, whatever happened to
//   the Assistant meanwhile (an item raised while the Assistant is mid-turn is simply there, `new`, at its next turn);
// - deduplicated: one item per cause (`key`: the request id, the turn number, the follow-up due time, the vault sync), repeats counted;
// - written by ORBIT: `summary` is ORBIT's own sentence about the cause (never model text); the cause itself is referenced by `source`
//   (request id, turn number, due time, vault commit or attempt) and the task `rev` at the time, for task_inspect to show in full;
// - explicit about its lifecycle (`state`):
//     open          raised and not yet dealt with (`surfaced` says whether and when the Assistant was shown it: SHOWN IS NOT ANSWERED)
//     acknowledged  the Assistant or Rai said they have seen it and what they will do (ack note); stays visible as acknowledged
//     resolved      its cause is gone (the request was answered, declined, withdrawn or linked; a later vault sync succeeded; the
//                   follow-up time it concerned was replaced), with why and when
//   A request item (clarification, blocker, job, research) can only be RESOLVED by answering the request (task_respond); it cannot be
//   acknowledged away, so surfacing or acknowledging never counts as an answer.

export type AttentionKind = "clarification" | "blocker" | "job" | "research" | "turn-failed" | "turn-interrupted" | "follow-up-gave-up" | "budget" | "vault-sync";
export const REQUEST_ATTENTION: readonly AttentionKind[] = ["clarification", "blocker", "job", "research"];
export type AttentionState = "open" | "acknowledged" | "resolved";
export type AttentionSource =
  | { type: "request"; request: string }
  | { type: "turn"; turn: number; trigger: Provenance["actor"] }
  | { type: "follow-up"; dueAt: string }
  | { type: "vault"; note: string; attempt: number; syncState: string };
export type Attention = {
  id: string;
  key: string;
  kind: AttentionKind;
  // ORBIT's own sentence about the cause. Never model text.
  summary: string;
  source: AttentionSource;
  // The task's rev when the item was raised (the version of the record the source refers to).
  rev: number;
  createdAt: string;
  lastAt: string;
  occurrences: number;
  state: AttentionState;
  surfaced?: { first: string; last: string; count: number };
  ack?: { at: string; by: Provenance; note?: string };
  resolved?: { at: string; why: string };
};

export const ATTENTION_KEPT = 100;

// Raise (or count again) the item for `key`. An unresolved item with the same key is counted, not duplicated; a resolved one is left as
// history and a new item is raised (the cause came back).
export function raise(t: Task, at: string, a: { key: string; kind: AttentionKind; summary: string; source: AttentionSource }): Attention {
  const list = (t.attention ??= []);
  const same = list.find((x) => x.key === a.key && x.state !== "resolved");
  if (same) {
    same.occurrences += 1;
    same.lastAt = at;
    same.summary = a.summary;
    same.source = a.source;
    // A cause that happens again after it was acknowledged needs looking at again.
    if (same.state === "acknowledged") same.state = "open";
    return same;
  }
  t.attentionSeq = (t.attentionSeq ?? list.length) + 1;
  const item: Attention = { id: `att-${t.attentionSeq}`, key: a.key, kind: a.kind, summary: a.summary.slice(0, 300), source: a.source, rev: t.rev, createdAt: at, lastAt: at, occurrences: 1, state: "open" };
  list.push(item);
  prune(t);
  return item;
}

export function resolve(t: Task, at: string, key: string, why: string): void {
  for (const x of t.attention ?? []) if (x.key === key && x.state !== "resolved") Object.assign(x, { state: "resolved", resolved: { at, why: why.slice(0, 300) } });
}
export function resolveWhere(t: Task, at: string, pred: (a: Attention) => boolean, why: string): void {
  for (const x of t.attention ?? []) if (x.state !== "resolved" && pred(x)) Object.assign(x, { state: "resolved", resolved: { at, why: why.slice(0, 300) } });
}

// Keeps every unresolved item and the newest resolved ones, up to ATTENTION_KEPT in all.
function prune(t: Task): void {
  const list = t.attention ?? [];
  if (list.length <= ATTENTION_KEPT) return;
  const unresolved = list.filter((x) => x.state !== "resolved");
  const resolved = list.filter((x) => x.state === "resolved").slice(-Math.max(0, ATTENTION_KEPT - unresolved.length));
  const keep = new Set([...unresolved, ...resolved]);
  t.attention = list.filter((x) => keep.has(x));
}

// A request item whose request is no longer pending is resolved in substance even if the record says otherwise (for example a request
// answered by an older build that did not keep attention items, after a rollback): it is never shown as still waiting. The stored state
// is corrected at the next change of the request; reading never writes.
const stale = (t: Task, x: Attention): boolean => x.source.type === "request" && t.requests.find((r) => r.id === (x.source as { request: string }).request)?.state !== "pending";
export const unresolved = (t: Task): Attention[] => (t.attention ?? []).filter((x) => x.state !== "resolved" && !stale(t, x));
export const openAttention = (t: Task): Attention[] => unresolved(t).filter((x) => x.state === "open");
// Shown to the Assistant at least once? Items it has never been shown are `new` in its next task-activity block.
export const isNew = (a: Attention): boolean => a.state === "open" && !a.surfaced;
