import { createHash } from "node:crypto";
import { ModelProtocolError, runChat, screenReply, TurnInterrupted } from "./agent.ts";
import type { ChatTool, Proposal, Proposals } from "./agent.ts";
import type { Jobs } from "./jobs.ts";
import { replySource } from "./model.ts";
import type { FallbackInfo, Item, Message, ModelPort } from "./model.ts";
import type { ProtocolDiagnostic } from "./tool-protocol.ts";
import type { AdminOps } from "./ops-admin.ts";
import type { SysOps } from "./ops-sys.ts";
import type { RecentContextRefresher } from "./recent-context.ts";
import { buildItems, buildMessages, compactThread, dataBlock, summaryNote, summaryUnusable } from "./thread-context.ts";
import { maskContent, maskDeep, maskText, ThreadError } from "./threads.ts";
import { maskVaultText } from "./vault/filter.ts";
import type { AttachmentRef } from "./attachments.ts";
import { hasPhotos, MODEL_IMAGE_BYTES_MAX, MODEL_IMAGES_MAX, withoutPhotos, withPhotos } from "./photo-context.ts";
import { photoRef } from "./photo-access.ts";
import type { GalleryView } from "./photo-access.ts";
import { GALLERIES_PER_MESSAGE_MAX, GALLERY_ITEMS_MAX, safeGalleries } from "./photo-ref.ts";
import type { StoredGallery } from "./photo-ref.ts";
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
  // Photos sent with this message, already bound to it in the attachment store (docs/photos.md). Stored on the user message as refs.
  attachments?: AttachmentRef[];
  // Supervised task turns (src/task-supervisor.ts, docs/adr/0003-supervised-tasks.md). Absent: the defaults every chat turn had before.
  // `maxRounds`: this reply's tool-round ceiling (lower than MAX_ROUNDS for a bounded task turn). `fallback`: whether the paid fallback
  // may answer (default true: the owner's interactive chat; false for a supervised task turn nobody is typing in). `author`: the user
  // message was written by ORBIT's task supervisor, not Rai, and is stored and shown as such.
  maxRounds?: number;
  fallback?: boolean;
  author?: "orbit-supervisor";
  // Admission (a task's session, src/task-supervisor.ts humanTurn): called synchronously right after the thread's reply lock is taken,
  // before anything is stored or awaited. If it throws, the lock is freed and nothing is stored. What it returns: reference material
  // to add for this turn, and `rollback`, called if the user message then cannot be stored (the admission is undone).
  admit?: () => { notes?: string; rollback?: (reason: string) => void };
};

export type Live = { source: "jobs" | "ops-admin" | "ops-sys" | "workspace" | "workspace-admin"; found: boolean; state?: string; health?: string; detail?: string; url?: string; delivered?: boolean };
export type CardView = Card & { live?: Live };
// `galleries`: the message's stored galleries resolved for the page now (docs/photo-recall.md); the stored refs themselves are not sent.
export type MessageView = Omit<ThreadMessage, "calls" | "gallery"> & { calls?: (Omit<StoredCall, "output"> & { outputChars: number })[]; galleries?: GalleryView[] };
// summaryUnusable: a summary is stored but has no usable text, so it is not used and the full thread is sent instead.
export type ThreadView = Omit<Thread, "messages" | "cards"> & { messages: MessageView[]; cards: CardView[]; busy: boolean; summaryUnusable?: true };

export type ThreadService = ReturnType<typeof threadService>;

// A turn refused because of its photos (the model takes none, or a photo could not be loaded). Nothing was sent to the model.
class PhotoRefusal extends Error {}

// What a turn needs from its store. The chat thread store (src/threads.ts) is one; the Assistant's chunk store
// (src/assistant-store.ts) is the other, so both run the same turn, tool, card and confirmation code.
export type TurnStore = Pick<
  Threads,
  "get" | "isBusy" | "tryBegin" | "end" | "holds" | "appendUser" | "beginAssistant" | "addCall" | "patchMessage" | "addCard" | "threadOfCard" | "card" | "transitionCard" | "recordOutcome"
>;

export function threadService(d: {
  threads: TurnStore;
  model: ModelPort;
  proposals: Proposals;
  jobs?: Jobs;
  admin?: AdminOps;
  sys?: SysOps;
  // The workspace operations ledger (src/workspace/ledger.ts): where a confirmed workspace card's result is looked up.
  workspace?: { ledger: { list(): { opId: string; proposalId: string; state: string; reason?: string }[] } };
  // The named activation operations (src/workspace/admin.ts) keep their own records.
  workspaceAdmin?: { cardState(proposalId: string): { state: string; detail?: string } | undefined };
  recent?: RecentContextRefresher;
  now?: () => Date;
  // Characters of live context before compaction starts. Tests lower it; production uses the documented default.
  budget?: number;
  // Tool execution deadline and abort grace period (docs/tool-deadlines.md). Tests lower them; production uses the defaults.
  toolDeadlineMs?: number;
  abortGraceMs?: number;
  // Where a tool call that ends after its turn stopped waiting is reported. Logging only; nothing is written to the thread.
  onLateTool?: (late: { thread: string; name: string; ok: boolean; error?: string }) => void;
  // Where a model response rejected as tool-call markup written as text is reported (src/tool-protocol.ts). Privacy-safe evidence only:
  // no model text. Default: one JSON log line.
  onProtocol?: (d: ProtocolDiagnostic & { thread: string }) => void;
  // How the model input is built from the stored conversation. Absent: the whole thread after its summary (chat threads).
  // The Assistant passes its bounded chunk context (src/assistant-context.ts) and turns compaction off.
  context?: { items(t: Thread): Item[]; messages(t: Thread): Message[] };
  // false: never compact older messages in the thread store (the Assistant keeps a bounded window and its own rolling summary). Default true.
  compact?: boolean;
  // Runs before the turn's context is built: the Assistant's rolling-summary roll (src/assistant-summary.ts), which summarizes archived
  // chunks not yet covered. Its failure never blocks the reply (it reports its own degraded state in the summary block).
  beforeTurn?: (threadId: string) => Promise<unknown>;
  // The rolling-summary block for this turn's reference material. Absent: the thread's own stored summary (chat threads, summaryNote).
  summaryNote?: (t: Thread) => string | undefined;
  // At most this many proposal cards (the newest) are described to the model. Absent: all of them (chat threads).
  maxCardLines?: number;
  // The session id of a thread of this store (`chat:<uuid>`, or `assistant:assistant` for the Assistant). When set, a proposal made in
  // a turn is bound to that origin before its card is stored, and a proposal already bound to another conversation gets no card here.
  origin?: (threadId: string) => string;
  // The processed bytes of one photo of a thread of this store, or undefined (docs/photos.md). Each store passes a loader bound to its
  // own conversation scope, so a request is only ever given photos of the conversation it belongs to. Absent: no photos are loaded.
  photos?: (threadId: string, attachmentId: string) => Buffer | undefined;
  // Resolves a message's stored galleries for the page, under the policy of the conversation that shows them (src/photo-access.ts
  // photoDisplay). Present: photos_show may display galleries in this store's replies. Absent: display is refused.
  galleries?: (threadId: string, stored: StoredGallery[] | undefined) => GalleryView[] | undefined;
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
    if (c.kind === "workspace_op" && c.action?.startsWith("ws_")) {
      const e = d.workspaceAdmin?.cardState(c.id);
      return e ? { source: "workspace-admin", found: true, state: e.state, detail: e.detail } : { source: "workspace-admin", found: false, detail: "ORBIT has no record of this activation operation." };
    }
    if (c.kind === "workspace_op") {
      const e = d.workspace?.ledger.list().find((x) => x.proposalId === c.id);
      return e ? { source: "workspace", found: true, state: e.state, detail: e.reason } : { source: "workspace", found: false, detail: "ORBIT's workspace ledger has no record for this confirmation." };
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
      ...(summaryUnusable(t) ? { summaryUnusable: true as const } : {}),
      messages: t.messages.map(({ calls, gallery, ...m }): MessageView => {
        const galleries = gallery?.length ? d.galleries?.(id, safeGalleries(gallery)) : undefined;
        return { ...m, ...(calls ? { calls: calls.map(({ output, ...c }) => ({ ...c, outputChars: output.length })) } : {}), ...(galleries?.length ? { galleries } : {}) };
      }),
      cards: t.cards.map((c) => ({ ...c, live: liveOf(c) })),
    };
  }

  // One line per card from the records, for the model's reference material and the recent-context rewrite.
  function cardLines(t: Thread): string[] {
    return t.cards.map((c) => {
      const live = liveOf(c);
      const what = c.kind === "job_launch" ? `${c.lane === "research" ? "research " : ""}launch on routine ${c.routine}` : c.kind === "job_steer" ? `steer of job ${c.job}` : c.kind === "vault_edit" ? `vault edit ${c.summary ?? c.action}` : c.kind === "workspace_op" ? `workspace ${c.action} ${c.summary ?? ""}`.trim() : `server operation ${c.action}`;
      const rec = c.state !== "confirmed" ? "" : live ? (live.found ? `; record now: ${live.state}${live.health ? ` (${live.health})` : ""}` : "; the record could not be found") : c.outcome?.error ? `; confirmation problem: ${c.outcome.error}` : "; no result recorded yet";
      const id = c.outcome?.jobId ?? c.outcome?.opId ?? (c.outcome?.commit ? `commit ${c.outcome.commit.slice(0, 7)} (pushed, remote verified)` : undefined);
      return `- proposal ${c.id.slice(0, 8)} (${what}): ${c.state}${id ? `, id ${id}` : ""}${rec}${c.duplicates?.length ? `; was flagged as similar to ${c.duplicates.map((x) => x.job).join(", ")}` : ""}`;
    });
  }

  const cardOf = (p: Proposal): Card => {
    const base = { id: p.id, state: "open" as const, createdAt: p.createdAt, expiresAt: p.expiresAt };
    if (p.kind === "job_launch") {
      const brief = maskContent(p.brief);
      return { ...base, kind: p.kind, routine: p.routine, ...(p.lane === "research" ? { lane: "research" as const } : {}), brief, ...(brief !== p.brief ? { briefMasked: true } : {}), ...(p.duplicates?.length ? { duplicates: p.duplicates } : {}) };
    }
    if (p.kind === "job_steer") return { ...base, kind: p.kind, job: p.job, text: maskContent(p.text) };
    // A vault edit card shows exactly what will run (cardDisplay refuses text the vault filter would mask), so it is masked by the
    // same filter and a note name or path is not turned into "[redacted]"; every other card keeps the global masking.
    // A workspace card shows exactly what will run (the service refuses an operation the content filter would mask), masked by value.
    if (p.kind === "workspace_op") return { ...base, kind: p.kind, action: p.action, summary: maskVaultText(p.summary), display: Object.fromEntries(Object.entries(p.display).map(([k, v]) => [k, maskVaultText(v)])), warnings: p.warnings.map(maskVaultText), digest: p.digest };
    if (p.kind === "vault_edit") return { ...base, kind: p.kind, action: p.action, summary: maskVaultText(p.summary), display: Object.fromEntries(Object.entries(p.display).map(([k, v]) => [k, typeof v === "string" ? maskVaultText(v) : v])) as typeof p.display, digest: p.digest };
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

  const onLateTool =
    d.onLateTool ??
    ((late: { thread: string; name: string; ok: boolean; error?: string }) =>
      console.log(JSON.stringify({ at: now().toISOString(), event: "chat_tool_late", thread: late.thread, tool: late.name, ok: late.ok, note: "ended after its turn stopped waiting; nothing was written to the thread" })));

  const onProtocol =
    d.onProtocol ?? ((p: ProtocolDiagnostic & { thread: string }) => console.log(JSON.stringify({ at: now().toISOString(), event: "model_protocol_text", ...p })));

  // `signal` cancels the turn (docs/tool-deadlines.md). No route passes one yet.
  async function turn(id: string, text: string, prep: TurnPrep, opts: { signal?: AbortSignal } = {}): Promise<{ thread: ThreadView; error?: string }> {
    const token = threads.tryBegin(id);
    if (!token) {
      throw new ThreadError(409, threads.get(id) ? "A reply is already in progress in this thread." : "No thread with that id.");
    }
    // Admission runs in the same synchronous step as taking the lock: no other request can start, steer or take the lock between them.
    let admitted: ReturnType<NonNullable<TurnPrep["admit"]>> | undefined;
    try {
      if (threads.get(id)?.archived) throw new ThreadError(409, "This thread is archived. Restore it to continue.");
      admitted = prep.admit?.();
    } catch (err) {
      threads.end(id, token);
      throw err;
    }
    let outcome: { error?: string };
    try {
      outcome = await held(id, text, admitted?.notes ? { ...prep, notes: [prep.notes, admitted.notes].filter(Boolean).join("\n\n") } : prep, opts, token, admitted?.rollback);
    } finally {
      threads.end(id, token);
    }
    // Taken after the thread is freed, so the view the caller gets says `busy: false`.
    return { thread: view(id)!, ...outcome };
  }

  async function held(id: string, text: string, prep: TurnPrep, opts: { signal?: AbortSignal }, token: symbol, rollback?: (reason: string) => void): Promise<{ error?: string }> {
    let userMessage: string;
    try {
      if (threads.get(id)!.archived) throw new ThreadError(409, "This thread is archived. Restore it to continue.");
      reconcile(id);
      // Older context is summarized first, so the model call below is within budget. A failure here never blocks the reply.
      // Only a chat thread store compacts (the Assistant passes compact: false and never reaches this with its own store).
      if (d.compact !== false) await compactThread({ threads: threads as Threads, model, id, now, budget: d.budget }).catch(() => {});
      if (d.beforeTurn) await d.beforeTurn(id).catch(() => {});
      userMessage = (prep.author ? threads.appendUser(id, text, prep.attachments, prep.author) : threads.appendUser(id, text, prep.attachments)).id;
    } catch (err) {
      // The message was not stored: an admission made for it is undone, so nothing records a message that was never sent.
      try {
        rollback?.(err instanceof Error ? err.message.slice(0, 200) : "the message could not be stored");
      } catch {
        // The undo could not be written either; the task's view shows the turn running until restart recovery marks it interrupted.
      }
      throw err;
    }
    const mid = threads.beginAssistant(id);
    const t = threads.get(id)!;
    const notes = [prep.notes, await recent?.note(), d.summaryNote ? d.summaryNote(t) : summaryNote(t), t.cards.length ? dataBlock("proposal-cards", `Proposal cards in this thread, from ORBIT's records:\n${(d.maxCardLines ? cardLines(t).slice(-d.maxCardLines) : cardLines(t)).join("\n")}`) : undefined].filter(Boolean).join("\n\n") || undefined;
    // Photos (docs/photos.md): load the bounded set this request may carry, and refuse rather than drop photos the model cannot take.
    const photoNotes: string[] = [];
    // Set once photos passed ORBIT's own check and go out with the request: a failure after that is the provider's, not a local block.
    let photosSent = false;
    // What the request already carries, so photos a tool supplies later in this reply stay within the same per-request bounds.
    let carried = { images: 0, bytes: 0 };
    // The photos this request really carries as image input, with the SHA-256 of the bytes sent (docs/photo-recall.md, "Evidence").
    let delivered: { ref: string; sha256: string }[] = [];
    const photoInput = <T extends Item>(items: T[]): T[] => {
      if (!hasPhotos(items)) return items;
      const support = model.images?.() ?? { ok: false, detail: "the connected model does not take photos" };
      if (!support.ok) {
        const stripped = withoutPhotos(items);
        // One sentence end, whatever the detail ends with (the block Rai saw had a doubled period).
        const why = support.detail.replace(/[.\s]+$/, "");
        if (stripped.current) throw new PhotoRefusal(`This message has ${stripped.current} photo${stripped.current === 1 ? "" : "s"}, but they cannot be analyzed: ${why}. The photos are stored with the message; nothing was sent to the model.`);
        if (stripped.removed) photoNotes.push(`The model answered without seeing ${stripped.removed} earlier photo(s): ${why}.`);
        return stripped.items;
      }
      const hashes = new Map<string, string>();
      const plan = withPhotos(
        items,
        (aid) => {
          const b = d.photos?.(id, aid);
          if (b) hashes.set(aid, createHash("sha256").update(b).digest("hex"));
          return b;
        },
        { refOf: photoRef },
      );
      if (plan.currentMissing) throw new PhotoRefusal(`${plan.currentMissing} photo(s) of this message could not be loaded from ORBIT's storage, so nothing was sent to the model.`);
      if (plan.missing) photoNotes.push(`${plan.missing} earlier photo(s) could not be loaded from storage and were not sent.`);
      photosSent = hasPhotos(plan.items);
      carried = { images: plan.sent, bytes: plan.sentBytes };
      delivered = plan.items.flatMap((it) => ("role" in it && it.images ? it.images.filter((img) => img.data && hashes.has(img.id)).map((img) => ({ ref: photoRef(img.id), sha256: hashes.get(img.id)! })) : []));
      return plan.items;
    };
    // Galleries shown in this reply (photos_show), in order; written to the reply as each call completes, so a refresh mid-turn or a
    // later failure keeps the ones already shown. Keyed by call id: a call recorded twice never adds a second gallery.
    const shownGalleries: StoredGallery[] = [];
    try {
      let reply: string;
      let provenance: "live" | "mock";
      let source: string;
      let capped = false;
      let fallback: FallbackInfo | undefined;
      let accounting: string[] | undefined;
      let incomplete: string[] | undefined;
      if (prep.tools.length && model.step) {
        const outcome = await runChat({
          model,
          messages: photoInput(d.context ? d.context.items(t) : buildItems(t)),
          limits: prep.limits,
          notes,
          tools: prep.tools,
          allow: prep.allow,
          // The owner's interactive chat is the one place a tool-using turn may use the paid fallback. A supervised task turn says false.
          fallback: prep.fallback ?? true,
          ...(prep.maxRounds !== undefined ? { maxRounds: prep.maxRounds } : {}),
          toolDeadlineMs: d.toolDeadlineMs,
          abortGraceMs: d.abortGraceMs,
          signal: opts.signal,
          onLate: (late) => onLateTool({ thread: id, ...late }),
          onProtocol: (p) => onProtocol({ thread: id, ...p }),
          // Photos a tool loads (photos_inspect, src/photo-access.ts) go through the same capability check and bounds as the turn's own.
          media: {
            support: () => model.images?.() ?? { ok: false, detail: "the connected model does not take photos" },
            images: carried.images,
            bytes: carried.bytes,
            maxImages: MODEL_IMAGES_MAX,
            maxBytes: MODEL_IMAGE_BYTES_MAX,
          },
          ...(d.galleries ? { display: { maxGalleries: GALLERIES_PER_MESSAGE_MAX, maxItems: GALLERY_ITEMS_MAX } } : {}),
          // The turn's identity, from this service's own records (never model text): what photo observations are attributed to.
          ...(d.origin ? { turn: { conversation: d.origin(id), replyMessage: mid, userMessage, model: model.status().impl }, delivered } : {}),
          onCall: ({ call_id, name, arguments: args, output, record, display }) => {
            // Only the turn that holds the thread writes to it.
            if (!threads.holds(id, token)) throw new Error("This turn no longer holds the thread.");
            // A tool may keep its arguments and output out of the transcript (photo observations): the stub is what is stored and replayed.
            const kept = prep.tools.find((t) => t.name === name)?.transcript?.({ arguments: args, output, summary: record.summary, ok: record.ok }) ?? { arguments: args, output, summary: record.summary };
            threads.addCall(id, mid, { callId: call_id, name, arguments: kept.arguments, output: kept.output, ok: record.ok, provenance: record.provenance, source: record.source, summary: kept.summary, at: now().toISOString(), ...(record.interrupted ? { interrupted: record.interrupted } : {}), ...(record.abort ? { abort: record.abort } : {}), ...(record.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(record.notRun ? { notRun: record.notRun } : {}), ...(record.budgetCut ? { budgetCut: record.budgetCut } : {}) });
            const pid = proposalIdOf(output);
            const p = pid ? proposals.peek(pid) : undefined;
            if (p && (!d.origin || proposals.bind(p.id, d.origin(id)))) threads.addCard(id, mid, cardOf(p));
            if (display && d.galleries && !shownGalleries.some((g) => g.callId === call_id)) {
              shownGalleries.push({ v: 1, callId: call_id, at: now().toISOString(), refs: display.refs.slice(0, GALLERY_ITEMS_MAX) });
              threads.patchMessage(id, mid, { gallery: [...shownGalleries] });
            }
          },
        });
        reply = outcome.text || "(the model returned no text)";
        provenance = "live";
        fallback = outcome.fallback;
        source = replySource(model.status().impl, fallback, outcome.mixed);
        capped = outcome.capped;
        accounting = outcome.accounting;
        incomplete = outcome.incomplete;
      } else {
        const r = await model.reply(photoInput(d.context ? d.context.messages(t) : buildMessages(t)), prep.limits, notes, opts.signal ? { signal: opts.signal } : undefined);
        // A plain reply made of tool-call markup is refused, never stored as the answer (no tools were offered, so nothing could run).
        screenReply(r.value, r.fallback ? r.fallback.model : "primary", (p) => onProtocol({ thread: id, ...p }));
        reply = r.value;
        provenance = r.provenance;
        source = r.source;
        fallback = r.fallback;
        accounting = r.accounting;
        incomplete = r.incomplete;
      }
      if (photoNotes.length) incomplete = [...photoNotes, ...(incomplete ?? [])];
      threads.patchMessage(id, mid, { text: reply, status: "done", provenance, source, memory: prep.memory, ...(capped ? { capped } : {}), ...(fallback ? { fallback } : {}), ...(accounting?.length ? { accounting } : {}), ...(incomplete?.length ? { incomplete } : {}) });
      recent?.consider(id, { isOwner: prep.isOwner });
      return {};
    } catch (err) {
      // A tool call cut off by its deadline or a cancellation is not a model failure: say exactly what is known about it.
      const error =
        err instanceof TurnInterrupted || err instanceof PhotoRefusal || err instanceof ModelProtocolError
          ? err.message
          : `The model call failed${photosSent ? " after ORBIT's own photo check passed and the photos were sent to the provider (this is not ORBIT's local capability block)" : ""}: ${err instanceof Error ? err.message : String(err)}`;
      // The user's message and every call that completed (or was cut off) stay on record; the reply is marked as not completed.
      threads.patchMessage(id, mid, { status: "error", error });
      return { error };
    }
  }

  return {
    view,
    liveOf,
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
      const wsEntry = opId ? d.workspace?.ledger.list().find((e) => e.opId === opId) : undefined;
      const produced = Boolean(jobId || steerN || commit || (opId && !wsEntry && entry?.state !== "not_dispatched") || (wsEntry && wsEntry.state !== "failed"));
      const state: CardState = result.code < 300 || produced ? "confirmed" : "refused";
      threads.recordOutcome(proposalId, { ...(jobId ? { jobId } : {}), ...(opId ? { opId } : {}), ...(commit ? { commit } : {}), ...(steerN ? { steerN } : {}), httpStatus: result.code, ...(error ? { error: error.slice(0, 300) } : {}) }, state);
    },
  };
}
