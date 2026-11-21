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

export type AttentionKind = "clarification" | "blocker" | "job" | "research" | "turn-failed" | "turn-interrupted" | "follow-up-gave-up" | "budget" | "vault-sync" | "capacity-wait";
export const REQUEST_ATTENTION: readonly AttentionKind[] = ["clarification", "blocker", "job", "research"];
// Kinds whose cause is a past event that nothing later clears by itself (a turn that failed or was cut off). Repair 4 (review finding 1
// on PR #155): acknowledging such an item RESOLVES it, as the ADR always said ("Resolved when: acknowledged"); before, it stayed
// "acknowledged" forever, was never pruned, and five of them pushed newer items out of the Assistant's bounded task-activity block.
// The acknowledgement is kept on the resolved item (who, when, note), so nothing of the audit history is lost.
export const RESOLVED_BY_ACK: readonly AttentionKind[] = ["turn-failed", "turn-interrupted"];
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
  // Delivery (Repair 4): `surfaced` records that the item was part of an Assistant turn that COMPLETED (its reply was stored without an
  // error). An item put in front of a turn that then failed or was interrupted is not delivered: it stays `new` and is offered again,
  // and the failure is counted in `undelivered`. Delivery is not acknowledgement and not resolution: a delivered item stays open.
  surfaced?: { first: string; last: string; count: number };
  undelivered?: { count: number; last: string; why: string };
  ack?: { at: string; by: Provenance; note?: string };
  resolved?: { at: string; why: string };
};

export const ATTENTION_KEPT = 100;
// Items shown per task in the Assistant's task-activity block (the rest are counted, never dropped from the store).
export const ATTENTION_SHOWN_PER_TASK = 5;

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

// Keeps every unresolved item and the newest resolved ones, up to ATTENTION_KEPT in all. What is dropped is counted on the task
// (`attentionPruned`: how many resolved items, and the newest resolution time among them), so the history says items existed.
export function prune(t: Task): void {
  const list = t.attention ?? [];
  if (list.length <= ATTENTION_KEPT) return;
  const unresolved = list.filter((x) => x.state !== "resolved");
  // The most recently resolved are kept (by resolution time, then list order), so a repair that resolves old items keeps them visible.
  const resolved = list
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => x.state === "resolved")
    .sort((a, b) => (a.x.resolved?.at ?? "").localeCompare(b.x.resolved?.at ?? "") || a.i - b.i)
    .slice(-Math.max(0, ATTENTION_KEPT - unresolved.length))
    .map(({ x }) => x);
  const keep = new Set([...unresolved, ...resolved]);
  const dropped = list.filter((x) => !keep.has(x));
  if (dropped.length) {
    const last = dropped.map((x) => x.resolved?.at ?? x.lastAt).sort().at(-1)!;
    t.attentionPruned = { count: (t.attentionPruned?.count ?? 0) + dropped.length, lastResolvedAt: t.attentionPruned && t.attentionPruned.lastResolvedAt > last ? t.attentionPruned.lastResolvedAt : last };
  }
  t.attention = list.filter((x) => keep.has(x));
}

// Repair of stored records (Repair 4), applied by the store once at start (tasks.repairAttention) and, read-only, by every view, so a
// record written by Repair 3 (or an older build after a rollback) is shown correctly even before the repair is written:
// - an ACKNOWLEDGED turn-failed / turn-interrupted item is resolved (acknowledgement is its resolution), keeping its ack;
// - a request item whose request is no longer pending is resolved (the request was answered, declined, withdrawn or linked by a build
//   that did not maintain items);
// - resolved history beyond ATTENTION_KEPT is pruned (counted in attentionPruned).
// Returns how many items it changed. Idempotent: a second run changes nothing.
export function repairItems(t: Task, at: string): number {
  let n = 0;
  for (const x of t.attention ?? []) {
    if (x.state === "resolved") continue;
    if (x.state === "acknowledged" && RESOLVED_BY_ACK.includes(x.kind)) {
      Object.assign(x, { state: "resolved", resolved: { at, why: `acknowledged${x.ack ? ` at ${x.ack.at}` : ""} (a past turn outcome is resolved by its acknowledgement; repaired from a record that kept it acknowledged)` } });
      n += 1;
    } else if (stale(t, x)) {
      const r = t.requests.find((q) => q.id === (x.source as { request: string }).request);
      Object.assign(x, { state: "resolved", resolved: { at, why: r ? `the request is ${r.state}${r.response ? ` since ${r.response.at}` : ""} (repaired: the record still showed it waiting)` : "the request is no longer on record (repaired)" } });
      n += 1;
    }
  }
  const before = t.attention?.length ?? 0;
  prune(t);
  return n + (before - (t.attention?.length ?? 0));
}

// The order items are shown in (Repair 4): what someone must act on first, oldest first within each group, so a bounded list never
// starves a newer request behind older, already-handled items, and never starves an older new item behind newer ones:
//   0 open and not yet delivered, a request (only answering resolves it)
//   1 open and not yet delivered, anything else
//   2 open request, delivered before (still unanswered)
//   3 open, delivered before
//   4 derived (computed at view time: a launch not confirmed, a dependency that can never be met)
//   5 acknowledged (waiting for its cause to clear; nothing to do now)
export function rank(a: { state?: AttentionState; kind: string; new?: boolean; derived?: boolean; surfaced?: unknown }): number {
  if (a.derived) return 4;
  if (a.state === "acknowledged") return 5;
  const isReq = (REQUEST_ATTENTION as readonly string[]).includes(a.kind);
  const fresh = a.new ?? !a.surfaced;
  return fresh ? (isReq ? 0 : 1) : isReq ? 2 : 3;
}
export function ordered<X extends { state?: AttentionState; kind: string; new?: boolean; derived?: boolean; createdAt?: string; id: string }>(items: X[]): X[] {
  return [...items].sort((x, y) => rank(x) - rank(y) || (x.createdAt ?? "").localeCompare(y.createdAt ?? "") || x.id.localeCompare(y.id));
}

// A request item whose request is no longer pending is resolved in substance even if the record says otherwise (for example a request
// answered by an older build that did not keep attention items, after a rollback): it is never shown as still waiting. The stored state
// is corrected at the next change of the request; reading never writes.
const stale = (t: Task, x: Attention): boolean => x.source.type === "request" && t.requests.find((r) => r.id === (x.source as { request: string }).request)?.state !== "pending";
// Unresolved, as a view: stale request items and acknowledged turn items (Repair 4) are not counted, even before the stored record is
// repaired.
export const unresolved = (t: Task): Attention[] => (t.attention ?? []).filter((x) => x.state !== "resolved" && !stale(t, x) && !(x.state === "acknowledged" && RESOLVED_BY_ACK.includes(x.kind)));
export const openAttention = (t: Task): Attention[] => unresolved(t).filter((x) => x.state === "open");
// Shown to the Assistant at least once? Items it has never been shown are `new` in its next task-activity block.
export const isNew = (a: Attention): boolean => a.state === "open" && !a.surfaced;
