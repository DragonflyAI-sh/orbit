import type { Proposal, Proposals } from "./agent.ts";
import type { Notifier } from "./notify.ts";
import type { AdminClient } from "./ops-admin-client.ts";
import {
  displayConfig,
  digestOf,
  isTerminal,
  opIdFor,
  validateConfigChanges,
  cap,
  type AdminArgs,
  type ConfigChanges,
  type MutatingAction,
} from "./ops/admin-protocol.ts";
import type { Store } from "./store.ts";

// ORBIT's side of tier 2: turns a model request into an owner-only proposal, and a confirmed proposal into exactly one helper
// operation. Nothing here runs from the model's request alone. The ledger is persisted (STATE_DIRECTORY), so a confirmation and
// its result survive an ORBIT restart; after the restart ORBIT asks the helper for the outcome and reports it once.

export const ADMIN_PROPOSAL_TTL_MS = 10 * 60 * 1000;
const LEDGER_MAX = 50;

export type LedgerState = "dispatching" | "accepted" | "running" | "verified" | "no_change" | "failed" | "restored" | "restore_failed" | "interrupted" | "not_dispatched";
export type LedgerEntry = {
  opId: string;
  proposalId: string;
  action: MutatingAction;
  summary: string;
  display: Record<string, string> | null;
  digest: string;
  confirmedAt: string;
  state: LedgerState;
  // What the helper observed, never "dispatched". Absent until the operation has ended.
  result?: string;
  verification?: { checked: boolean; healthy?: boolean; expectedCommit?: string; servedCommit?: string; detail: string };
  finishedAt?: string;
  checkedAt?: string;
  reportedAt?: string;
  error?: string;
};

const ended = (s: LedgerState) => s === "not_dispatched" || isTerminal(s);

const SUMMARY: Record<MutatingAction, (a: AdminArgs) => string> = {
  restart_orbit: () => "Restart orbit.service (ORBIT is offline for a few seconds), then check that /status is healthy and serves the same commit.",
  deploy_now: () => "Run the deploy now by starting orbit-deploy.service, the unit the timer starts: it deploys the newest main commit whose checks are green (if there is one), rolls back if it fails, then I check /status and the commit.",
  rollback_release: () => "Roll back to the previous known-good release using the deploy script's rollback (restarts ORBIT), then check /status and that the commit really changed.",
  apply_config: (a) =>
    `Change orbit.env: ${Object.entries(displayConfig(a.changes ?? {})).map(([k, v]) => `${k}=${v}`).join(", ")}. The old file is backed up, ORBIT restarts, and /status must be healthy within 60 seconds or the backup is restored.`,
  refresh_vault: () => "Refresh the server's read-only vault copy now (a fast-forward pull), then check the sync record was written.",
};

export type AdminOps = ReturnType<typeof adminOps>;

export function adminOps(deps: { client?: AdminClient; store: Store<LedgerEntry[]>; notify: Notifier; proposals: Proposals; now?: () => Date }) {
  const { client, store, notify, proposals } = deps;
  const now = deps.now ?? (() => new Date());
  // Exact validated arguments for open proposals, in memory only. A restart drops them together with the proposals.
  const pending = new Map<string, { action: MutatingAction; args: AdminArgs }>();
  let refreshing: Promise<void> | undefined;

  const save = (entries: LedgerEntry[]) => store.write(entries.slice(-LEDGER_MAX));
  const update = (opId: string, patch: Partial<LedgerEntry>) => {
    const all = store.read();
    const i = all.findIndex((e) => e.opId === opId);
    if (i >= 0) {
      all[i] = { ...all[i]!, ...patch };
      save(all);
    }
  };

  return {
    available: Boolean(client),

    // Validates, then makes an owner-only proposal. Nothing is sent to the helper.
    propose(action: MutatingAction, input: { changes?: unknown } = {}): Proposal & { kind: "ops_admin" } {
      const args: AdminArgs = {};
      if (action === "apply_config") args.changes = validateConfigChanges(input.changes);
      else if (input.changes !== undefined) throw new Error(`${action} takes no arguments.`);
      const p = proposals.propose(
        { kind: "ops_admin", action, summary: SUMMARY[action](args), display: args.changes ? displayConfig(args.changes) : null, digest: digestOf(action, args) },
        ADMIN_PROPOSAL_TTL_MS,
      );
      for (const id of pending.keys()) if (!proposals.peek(id)) pending.delete(id);
      pending.set(p.id, { action, args });
      return p as Proposal & { kind: "ops_admin" };
    },

    // Called after the route checked the owner and the digest the owner confirmed, and spent the proposal. Re-checks both against
    // what was validated at proposal time, then makes one dispatch.
    async confirm(p: Proposal & { kind: "ops_admin" }): Promise<{ code: number; body: unknown }> {
      const held = pending.get(p.id);
      pending.delete(p.id);
      if (!held || held.action !== p.action || digestOf(held.action, held.args) !== p.digest) {
        return { code: 409, body: { error: "This proposal no longer matches what was validated (or ORBIT restarted since). Nothing was done; ask again." } };
      }
      if (!client) return { code: 503, body: { error: "The admin helper is not configured. Nothing was done." } };
      const opId = opIdFor(p.id);
      const all = store.read();
      if (all.some((e) => e.proposalId === p.id || e.opId === opId)) return { code: 409, body: { error: "This confirmation was already used. Nothing was done." } };
      save([...all, { opId, proposalId: p.id, action: p.action, summary: p.summary, display: p.display, digest: p.digest, confirmedAt: now().toISOString(), state: "dispatching" }]);
      let reply;
      try {
        reply = await client.call(p.action, opId, held.args.changes);
      } catch (err) {
        // The call may or may not have reached the helper: leave it dispatching; refresh() will ask the helper and settle it.
        update(opId, { error: cap(err instanceof Error ? err.message : "error", 200) });
        return { code: 502, body: { error: `The admin helper did not confirm the dispatch (${cap(err instanceof Error ? err.message : "error", 160)}). Nothing is verified. ORBIT will check with the helper and report.`, opId } };
      }
      if (!reply.ok) {
        update(opId, { state: "not_dispatched", error: `${reply.code}: ${reply.message}`, finishedAt: now().toISOString(), reportedAt: now().toISOString() });
        return { code: reply.code === "busy" ? 409 : 502, body: { error: `The admin helper refused: ${reply.message}. Nothing was done.`, opId } };
      }
      const op = reply.data.operation as { state?: LedgerState } | undefined;
      update(opId, { state: op?.state && op.state !== ("dispatching" as string) ? op.state : "accepted" });
      return {
        code: 202,
        body: {
          status: "dispatched",
          dispatched: true,
          verified: false,
          opId,
          action: p.action,
          note: "Dispatched to the root helper's separate runner. Nothing is verified yet: ORBIT will report the verified result, and ops_admin_operations shows it.",
        },
      };
    },

    list: (): LedgerEntry[] => store.read(),

    // Asks the helper about every operation that has not ended and records what it observed. Reports each end once. An
    // unreachable helper changes nothing: the last known state stays, marked with when it was last checked.
    refresh(): Promise<void> {
      refreshing ??= (async () => {
        if (!client) return;
        for (const e of store.read().filter((x) => !ended(x.state))) {
          try {
            const r = await client.call("op_status", e.opId);
            const at = now().toISOString();
            if (!r.ok) {
              if (r.code === "not_found") {
                update(e.opId, e.state === "dispatching" ? { state: "not_dispatched", result: "The helper has no record of this operation: it never started, nothing was done.", finishedAt: at, checkedAt: at } : { state: "interrupted", result: "The helper lost this operation's record; the outcome is unknown. Check the server.", finishedAt: at, checkedAt: at });
              }
              continue;
            }
            const op = (r.data.operation ?? {}) as Partial<LedgerEntry> & { summary?: string };
            update(e.opId, { state: op.state ?? e.state, ...(op.summary ? { result: cap(op.summary, 400) } : {}), ...(op.verification ? { verification: op.verification } : {}), ...(op.finishedAt ? { finishedAt: op.finishedAt } : {}), checkedAt: at });
          } catch {
            // helper unreachable (for example while orbit-ops-admin restarts); try again on the next tick
          }
        }
        for (const e of store.read().filter((x) => ended(x.state) && !x.reportedAt)) {
          const text = `Server action "${e.action}" ${e.state === "verified" ? "verified" : e.state.replace("_", " ")}: ${e.result ?? e.error ?? "no detail"}`;
          update(e.opId, { reportedAt: now().toISOString() });
          notify.send(cap(text, 600), e.state === "failed" || e.state === "restore_failed" || e.state === "interrupted");
        }
      })().finally(() => (refreshing = undefined));
      return refreshing;
    },
  };
}

export type { ConfigChanges };
