import { runChat } from "./agent.ts";
import type { ChatTool, Proposal, Proposals } from "./agent.ts";
import type { Jobs } from "./jobs.ts";
import type { ModelPort } from "./model.ts";
import type { AdminOps } from "./ops-admin.ts";
import type { SysOps } from "./ops-sys.ts";
import type { RecentContextRefresher } from "./recent-context.ts";
import { buildItems, buildMessages, compactThread, dataBlock, summaryNote } from "./thread-context.ts";
import { maskDeep, maskText, ThreadError } from "./threads.ts";
import type { Card, CardState, StoredCall, Thread, ThreadMessage, Threads } from "./threads.ts";

// Runs one chat turn against a stored thread and shapes threads for the page. The server owns the policy checks and the
// confirmation routes; this module owns what is written to the thread and what the model is sent from it.

export type TurnPrep = {
  // Reference material gathered for this turn (device summary, vault excerpts). Not stored.
  notes?: string;
  memory: string[];
  limits: string[];
  tools: ChatTool[];
  allow?: (tool: string) => string | undefined;
  // The verified owner check of the request that started this turn, carried to everything the turn triggers (the rolling note).
  isOwner: boolean;
};

export type Live = { source: "jobs" | "ops-admin" | "ops-sys"; found: boolean; state?: string; health?: string; detail?: string; url?: string; delivered?: boolean };
export type CardView = Card & { live?: Live };
export type MessageView = Omit<ThreadMessage, "calls"> & { calls?: (Omit<StoredCall, "output"> & { outputChars: number })[] };
export type ThreadView = Omit<Thread, "messages" | "cards"> & { messages: MessageView[]; cards: CardView[]; busy: boolean };

export type ThreadService = ReturnType<typeof threadService>;

export function threadService(d: {
  threads: Threads;
  model: ModelPort;
  proposals: Proposals;
  jobs?: Jobs;
  admin?: AdminOps;
  sys?: SysOps;
  recent?: RecentContextRefresher;
  now?: () => Date;
  // Characters of live context before compaction starts. Tests lower it; production uses the documented default.
  budget?: number;
}) {
  const { threads, model, proposals, jobs, admin, sys, recent } = d;
  const now = d.now ?? (() => new Date());

  // A card still marked open whose proposal is gone (expired, or lost in a restart) can no longer be confirmed: say so.
  function reconcile(id: string): void {
    const t = threads.get(id);
    if (!t) return;
    for (const c of t.cards) {
      if (c.state === "open" && (new Date(c.expiresAt) <= now() || !proposals.peek(c.id))) threads.transitionCard(c.id, "open", "expired");
    }
  }

  // The state of the thing a confirmed card produced, read from the authoritative record at the moment the card is shown.
  function liveOf(c: Card): Live | undefined {
    if (c.state !== "confirmed") return undefined;
    if (c.kind === "job_launch" && c.outcome?.jobId) {
      const j = jobs?.get(c.outcome.jobId);
      return j
        ? { source: "jobs", found: true, state: j.state, health: jobs!.health(j), url: j.launch?.sessionUrl, detail: j.launch?.error }
        : { source: "jobs", found: false, detail: "ORBIT's jobs record has no job with this id." };
    }
    if (c.kind === "job_steer" && c.job && c.outcome?.steerN) {
      const j = jobs?.get(c.job);
      const s = j?.steers.find((x) => x.n === c.outcome!.steerN);
      return s ? { source: "jobs", found: true, state: s.deliveredAt ? "picked up by the runner" : "queued, not picked up yet", delivered: Boolean(s.deliveredAt) } : { source: "jobs", found: false, detail: "ORBIT's jobs record has no such steer." };
    }
    if (c.kind === "ops_admin" || c.kind === "ops_sys") {
      const e = (c.kind === "ops_admin" ? admin?.list() : sys?.list())?.find((x) => x.proposalId === c.id);
      const source = c.kind === "ops_admin" ? "ops-admin" : "ops-sys";
      return e
        ? { source, found: true, state: e.state, detail: e.result ?? e.error, health: e.verification && "healthy" in e.verification && e.verification.healthy !== undefined ? (e.verification.healthy ? "verified healthy" : "not healthy") : undefined }
        : { source, found: false, detail: "ORBIT's operations ledger has no record for this confirmation." };
    }
    return undefined;
  }

  function view(id: string): ThreadView | undefined {
    reconcile(id);
    const t = threads.get(id);
    if (!t) return undefined;
    return {
      ...t,
      busy: threads.isBusy(id),
      messages: t.messages.map(({ calls, ...m }): MessageView => ({ ...m, ...(calls ? { calls: calls.map(({ output, ...c }) => ({ ...c, outputChars: output.length })) } : {}) })),
      cards: t.cards.map((c) => ({ ...c, live: liveOf(c) })),
    };
  }

  // One line per card from the records, for the model's reference material and the recent-context rewrite.
  function cardLines(t: Thread): string[] {
    return t.cards.map((c) => {
      const live = liveOf(c);
      const what = c.kind === "job_launch" ? `launch on routine ${c.routine}` : c.kind === "job_steer" ? `steer of job ${c.job}` : c.kind === "vault_edit" ? `vault edit ${c.summary ?? c.action}` : `server operation ${c.action}`;
      const rec = c.state !== "confirmed" ? "" : live ? (live.found ? `; record now: ${live.state}${live.health ? ` (${live.health})` : ""}` : "; the record could not be found") : c.outcome?.error ? `; confirmation problem: ${c.outcome.error}` : "; no result recorded yet";
      const id = c.outcome?.jobId ?? c.outcome?.opId ?? (c.outcome?.commit ? `commit ${c.outcome.commit.slice(0, 7)} (pushed, remote verified)` : undefined);
      return `- proposal ${c.id.slice(0, 8)} (${what}): ${c.state}${id ? `, id ${id}` : ""}${rec}${c.duplicates?.length ? `; was flagged as similar to ${c.duplicates.map((x) => x.job).join(", ")}` : ""}`;
    });
  }

  const cardOf = (p: Proposal): Card => {
    const base = { id: p.id, state: "open" as const, createdAt: p.createdAt, expiresAt: p.expiresAt };
    if (p.kind === "job_launch") {
      const brief = maskText(p.brief);
      return { ...base, kind: p.kind, routine: p.routine, brief, ...(brief !== p.brief ? { briefMasked: true } : {}), ...(p.duplicates?.length ? { duplicates: p.duplicates } : {}) };
    }
    if (p.kind === "job_steer") return { ...base, kind: p.kind, job: p.job, text: maskText(p.text) };
    return { ...base, kind: p.kind, action: p.action, summary: maskText(p.summary), display: maskDeep(p.display), digest: p.digest, ...(p.kind === "ops_sys" ? { warnings: p.warnings.map(maskText) } : {}) };
  };

  // The card for a proposal a tool call just made. The tool's own result names the proposal, so a concurrent reply in another
  // thread can never be credited with this one's proposals.
  const proposalIdOf = (output: string): string | undefined => {
    try {
      const id = (JSON.parse(output) as { result?: { proposalId?: unknown } }).result?.proposalId;
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  };

  async function turn(id: string, text: string, prep: TurnPrep): Promise<{ thread: ThreadView; error?: string }> {
    if (!threads.tryBegin(id)) {
      throw new ThreadError(409, threads.get(id) ? "A reply is already in progress in this thread." : "No thread with that id.");
    }
    try {
      if (threads.get(id)!.archived) throw new ThreadError(409, "This thread is archived. Restore it to continue.");
      reconcile(id);
      // Older context is summarized first, so the model call below is within budget. A failure here never blocks the reply.
      await compactThread({ threads, model, id, now, budget: d.budget }).catch(() => {});
      threads.appendUser(id, text);
      const mid = threads.beginAssistant(id);
      const t = threads.get(id)!;
      const notes = [prep.notes, await recent?.note(), summaryNote(t), t.cards.length ? dataBlock("proposal-cards", `Proposal cards in this thread, from ORBIT's records:\n${cardLines(t).join("\n")}`) : undefined].filter(Boolean).join("\n\n") || undefined;
      try {
        let reply: string;
        let provenance: "live" | "mock";
        let source: string;
        let capped = false;
        if (prep.tools.length && model.step) {
          const outcome = await runChat({
            model,
            messages: buildItems(t),
            limits: prep.limits,
            notes,
            tools: prep.tools,
            allow: prep.allow,
            onCall: ({ call_id, name, arguments: args, output, record }) => {
              threads.addCall(id, mid, { callId: call_id, name, arguments: args, output, ok: record.ok, provenance: record.provenance, source: record.source, summary: record.summary, at: now().toISOString() });
              const pid = proposalIdOf(output);
              const p = pid ? proposals.peek(pid) : undefined;
              if (p) threads.addCard(id, mid, cardOf(p));
            },
          });
          reply = outcome.text || "(the model returned no text)";
          provenance = "live";
          source = `model/${model.status().impl}`;
          capped = outcome.capped;
        } else {
          const r = await model.reply(buildMessages(t), prep.limits, notes);
          reply = r.value;
          provenance = r.provenance;
          source = r.source;
        }
        threads.patchMessage(id, mid, { text: reply, status: "done", provenance, source, memory: prep.memory, ...(capped ? { capped } : {}) });
        recent?.consider(id, { isOwner: prep.isOwner });
        return { thread: view(id)! };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // The user's message and every call that completed stay on record; the reply is marked as failed.
        threads.patchMessage(id, mid, { status: "error", error: `The model call failed: ${detail}` });
        return { thread: view(id)!, error: `The model call failed: ${model.status().detail}` };
      }
    } finally {
      threads.end(id);
    }
  }

  return {
    view,
    cardLines,
    turn,
    reconcile,

    // ---- confirmation routes ----
    // Returns true when the card (if any) moved from open to `to`; false when a card exists and is no longer open. No card is fine.
    claim(proposalId: string, to: "confirmed" | "cancelled"): boolean {
      const tid = threads.threadOfCard(proposalId);
      return tid ? threads.transitionCard(proposalId, "open", to) : true;
    },
    // The proposal was not in the store: say what the thread's card knows (and mark an open one expired).
    missing(proposalId: string): { code: number; body: unknown } | undefined {
      const c = threads.card(proposalId);
      if (!c) return undefined;
      if (c.state === "open") {
        threads.transitionCard(proposalId, "open", "expired");
        return { code: 404, body: { error: "This proposal expired or was lost in a restart. Nothing was done.", state: "expired" } };
      }
      return { code: 409, body: { error: `This proposal was already ${c.state}. Nothing was done again.`, state: c.state, outcome: c.outcome } };
    },
    // What a confirmation returned, recorded on the card: ids into the authoritative records, or a refusal.
    settle(proposalId: string, result: { code: number; body: unknown }): void {
      if (!threads.threadOfCard(proposalId)) return;
      const b = (result.body ?? {}) as { id?: unknown; opId?: unknown; commit?: unknown; steer?: { n?: unknown }; error?: unknown; job?: { id?: unknown } };
      const jobId = typeof b.id === "string" ? b.id : typeof b.job?.id === "string" ? b.job.id : undefined;
      const opId = typeof b.opId === "string" ? b.opId : undefined;
      const steerN = typeof b.steer?.n === "number" ? b.steer.n : undefined;
      const error = typeof b.error === "string" ? b.error : undefined;
      // A confirmation that failed is "refused" when nothing was started: no job or operation id, or the ledger says the helper never took it.
      const entry = opId ? [...(admin?.list() ?? []), ...(sys?.list() ?? [])].find((e) => e.opId === opId) : undefined;
      const commit = typeof b.commit === "string" ? b.commit : undefined;
      const produced = Boolean(jobId || steerN || commit || (opId && entry?.state !== "not_dispatched"));
      const state: CardState = result.code < 300 || produced ? "confirmed" : "refused";
      threads.recordOutcome(proposalId, { ...(jobId ? { jobId } : {}), ...(opId ? { opId } : {}), ...(commit ? { commit } : {}), ...(steerN ? { steerN } : {}), httpStatus: result.code, ...(error ? { error: error.slice(0, 300) } : {}) }, state);
    },
  };
}
