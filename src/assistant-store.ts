import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ASSISTANT_ACTIVE_BUDGET_CHARS, boundChunk, planContext } from "./assistant-context.ts";
import type { ChunkForm, ContextPlan } from "./assistant-context.ts";
import { jobCardsOf, maskCall, maskContent, maskDeep, MAX_MESSAGE_CHARS, safePatch, THREAD_SCHEMA, ThreadError, writeAtomic } from "./threads.ts";
import type { Card, CardState, JobCardRef, MessagePatch, StoredCall, Thread, ThreadMessage } from "./threads.ts";

// The Assistant: one durable rolling conversation, owned by the server (docs/assistant.md). It is stored as small chunk files,
// one per turn, apart from chat threads (<state>/threads/) and from the vault:
//
//   <state>/assistant/session.json            identity: { schema, id, createdAt }, written once
//   <state>/assistant/epoch.json              { schema, epoch }: the revision epoch, raised every time the store is opened
//   <state>/assistant/active/<seq>.json       chunks the model may be sent
//   <state>/assistant/archive/<seq>.json      older chunks: kept, never deleted, never sent to the model automatically
//
// <seq> is a 12-digit, zero-padded sequence number, so file names sort in conversation order. A chunk is in exactly one of the
// two directories at any time: archiving is a single rename, so a crash can never lose or duplicate one. The directories are the
// truth; there is no separate index that could disagree with them.

export const ASSISTANT_ID = "assistant";
export const ASSISTANT_TITLE = "Assistant";
export const CHUNK_SCHEMA = 1;

// What the model was sent for the turn of this chunk (recorded when the turn starts). Owner-visible, never sent to the model.
export type ContextUse = {
  budgetChars: number;
  historyChars: number;
  currentChars: number;
  included: { seq: number; form: ChunkForm; chars: number }[];
  omitted: number[];
};

export type Chunk = {
  schema: number;
  id: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  rev: number;
  // "open" while its turn runs; "complete" once the turn ended (done, error, or interrupted by a restart). Only complete chunks are
  // sent to the model as history or archived.
  state: "open" | "complete";
  messages: ThreadMessage[];
  cards: Card[];
  context?: ContextUse;
  // The browser's id for the send that started this turn. A repeat of the same send (a browser retry after a dropped connection)
  // is refused instead of run again.
  requestId?: string;
};

export type Session = { schema: number; id: string; createdAt: string };
// What the session registry reads from the Assistant store (sessionFacts below). `lastMessageAt` covers active chunks only.
export type AssistantFacts = { createdAt: string; busy: boolean; activeChunks: number; archivedChunks: number; activeMessages: number; lastMessageAt?: string; jobCards: JobCardRef[]; persisted: boolean; problems: number };

// ---- revisions that survive a restart ----
// The page draws a server answer only if its `rev` is not below the one it shows, so a slow or out-of-order answer never rolls the
// conversation back. A counter that started again at 1 in every process would make an already-open tab ignore the new process
// until the counter caught up. So the revision is `epoch * REV_STRIDE + n`: `n` counts changes within this process (from 1), and
// `epoch` is raised every time the store is opened and kept in epoch.json. Every revision of a later process is therefore above
// every revision of an earlier one (and above the small plain counters of the version before this one), so an open tab accepts the
// new process at once, with no change to the page, while a delayed answer from an old process still compares lower and is ignored.
// `epoch` is at least the wall clock in whole seconds, so a lost or unreadable epoch.json (or no state directory at all) still
// moves forward. 2^20 changes per epoch; past that the epoch is raised again. The largest revision stays a safe integer until the
// clock passes the year 2240.
export const REV_STRIDE = 2 ** 20;
const EPOCH_SCHEMA = 1;

const SEQ_FILE = /^(\d{12})\.json$/;
const name = (seq: number) => `${String(seq).padStart(12, "0")}.json`;

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every platform can fsync a directory; the rename itself is still atomic.
  }
}

export type AssistantStore = ReturnType<typeof assistantStore>;

// `dir` undefined keeps the conversation in memory (tests, or a service without a state directory) and says so through `persisted`.
// `held(card)` says whether an open card's proposal can still be confirmed; rotation never archives past such a chunk.
export function assistantStore(dir: string | undefined, opts: { now?: () => Date; held?: (card: Card) => boolean; activeBudget?: number; revStride?: number } = {}) {
  const now = opts.now ?? (() => new Date());
  const held = opts.held ?? (() => false);
  const activeBudget = opts.activeBudget ?? ASSISTANT_ACTIVE_BUDGET_CHARS;
  // Changes per epoch; smaller only in tests.
  const stride = opts.revStride ?? REV_STRIDE;
  const activeDir = dir ? join(dir, "active") : undefined;
  const archiveDir = dir ? join(dir, "archive") : undefined;
  const problems: string[] = [];

  // In memory: every active chunk in full; for the archive only the sequence numbers (from file names). Archived chunks are read
  // from disk a page at a time when asked for, never all at once.
  const active = new Map<number, Chunk>();
  let archived: number[] = [];
  // Active chunk files that could not be read: left in place for a person, their numbers never reused.
  const unreadable: number[] = [];
  // Archived chunks held in memory when there is no directory (tests).
  const memArchive = new Map<number, Chunk>();
  // card id -> chunk seq, for every active chunk and every chunk archived while this process runs.
  const cardIndex = new Map<string, number>();
  let busy: symbol | undefined;
  let epoch = 0;
  let changes = 1;
  // Request ids of the sends that made the active chunks (and chunks archived while this process runs), and the one the next turn
  // is for.
  const requestIds = new Set<string>();
  let nextRequest: string | undefined;
  let session: Session;

  const epochFile = dir ? join(dir, "epoch.json") : undefined;
  // Raises the epoch above the last one stored, the current one and the clock, and stores it before any revision of it is served.
  const raiseEpoch = (stored: number) => {
    epoch = Math.max(stored + 1, epoch + 1, Math.floor(now().getTime() / 1000));
    changes = 1;
    if (epochFile) writeAtomic(epochFile, JSON.stringify({ schema: EPOCH_SCHEMA, epoch }, null, 2));
  };
  const bump = () => {
    if (++changes >= stride) raiseEpoch(epoch);
  };

  const fileOf = (seq: number, where: "active" | "archive") => join(where === "active" ? activeDir! : archiveDir!, name(seq));
  const index = (c: Chunk) => {
    for (const card of c.cards) cardIndex.set(card.id, c.seq);
    if (c.requestId) requestIds.add(c.requestId);
  };
  const persist = (c: Chunk, where: "active" | "archive") => {
    if (dir) writeAtomic(fileOf(c.seq, where), JSON.stringify(c, null, 2));
  };

  // ---- load and recover ----
  if (dir) {
    mkdirSync(activeDir!, { recursive: true, mode: 0o700 });
    mkdirSync(archiveDir!, { recursive: true, mode: 0o700 });
    const sessionFile = join(dir, "session.json");
    try {
      session = JSON.parse(readFileSync(sessionFile, "utf8")) as Session;
      if (session.id !== ASSISTANT_ID) throw new Error("not the assistant session");
    } catch (err) {
      if (existsSync(sessionFile)) {
        // Left for a person to look at; the conversation itself is in the chunk files and is still loaded.
        problems.push(`session.json: ${err instanceof Error ? err.message : "unreadable"}`);
        session = { schema: CHUNK_SCHEMA, id: ASSISTANT_ID, createdAt: now().toISOString() };
      } else {
        session = { schema: CHUNK_SCHEMA, id: ASSISTANT_ID, createdAt: now().toISOString() };
        writeAtomic(sessionFile, JSON.stringify(session, null, 2));
      }
    }
    let stored = 0;
    try {
      const e = JSON.parse(readFileSync(epochFile!, "utf8")) as { epoch?: unknown };
      if (!Number.isSafeInteger(e.epoch) || (e.epoch as number) < 0) throw new Error("no epoch");
      stored = e.epoch as number;
    } catch (err) {
      // Missing (a new store, or one written before epochs): the clock floor starts it. Unreadable: said, and replaced below by a
      // new epoch from the clock; the file holds only that number, never conversation data.
      if (existsSync(epochFile!)) problems.push(`epoch.json: ${err instanceof Error ? err.message : "unreadable"}; a new epoch was started from the clock`);
    }
    raiseEpoch(stored);
    archived = readdirSync(archiveDir!).flatMap((f) => (SEQ_FILE.test(f) ? [Number(f.slice(0, 12))] : [])).sort((a, b) => a - b);
    const inArchive = new Set(archived);
    for (const f of readdirSync(activeDir!).sort()) {
      if (!SEQ_FILE.test(f)) continue;
      const seq = Number(f.slice(0, 12));
      if (inArchive.has(seq)) {
        // Cannot happen through ORBIT (archiving is one rename). If a copy left it in both places, the archived copy stands and the
        // active one is left untouched for a person to look at, never loaded twice.
        problems.push(`active/${f}: also in archive/; the archived copy is used`);
        continue;
      }
      try {
        const c = JSON.parse(readFileSync(join(activeDir!, f), "utf8")) as Chunk;
        if (c.seq !== seq || !Array.isArray(c.messages)) throw new Error("not a chunk");
        c.cards ??= [];
        // A turn that was running when the process stopped will never finish: say so, and close the chunk. Nothing is re-run.
        let changed = false;
        for (const m of c.messages) {
          if (m.status === "pending") {
            m.status = "interrupted";
            m.error = "ORBIT restarted before this reply finished. Nothing was retried.";
            changed = true;
          }
        }
        if (c.state !== "complete") {
          c.state = "complete";
          changed = true;
        }
        if (changed) {
          c.rev += 1;
          c.updatedAt = now().toISOString();
          writeAtomic(join(activeDir!, f), JSON.stringify(c, null, 2));
        }
        active.set(seq, c);
        index(c);
      } catch (err) {
        // Never deleted or overwritten. Its sequence number stays taken so a new chunk never reuses it.
        problems.push(`active/${f}: ${err instanceof Error ? err.message : "unreadable"}`);
        unreadable.push(seq);
      }
    }
  } else {
    session = { schema: CHUNK_SCHEMA, id: ASSISTANT_ID, createdAt: now().toISOString() };
    raiseEpoch(0);
  }
  let nextSeq = Math.max(0, ...archived, ...unreadable, ...active.keys()) + 1;

  const sortedActive = () => [...active.values()].sort((a, b) => a.seq - b.seq);
  const openChunk = () => sortedActive().find((c) => c.state === "open");

  // Every change goes through here: a synchronous read-modify-write on a copy, written before it replaces the live one.
  function mutateActive<R>(seq: number, fn: (c: Chunk) => R): R {
    const current = active.get(seq);
    if (!current) throw new ThreadError(404, "No such assistant chunk.");
    const next = structuredClone(current);
    const result = fn(next);
    next.rev = current.rev + 1;
    next.updatedAt = now().toISOString();
    persist(next, "active");
    active.set(seq, next);
    index(next);
    bump();
    return result;
  }

  // A chunk that is archived is read, changed and written back the same way (only a card's state and outcome ever change there).
  function readArchived(seq: number): Chunk | undefined {
    if (!dir) return structuredClone(memArchive.get(seq));
    try {
      return JSON.parse(readFileSync(fileOf(seq, "archive"), "utf8")) as Chunk;
    } catch {
      return undefined;
    }
  }
  function mutateAny<R>(seq: number, fn: (c: Chunk) => R): R | undefined {
    if (active.has(seq)) return mutateActive(seq, fn);
    const c = readArchived(seq);
    if (!c) return undefined;
    const result = fn(c);
    c.rev += 1;
    c.updatedAt = now().toISOString();
    if (dir) persist(c, "archive");
    else memArchive.set(seq, structuredClone(c));
    bump();
    return result;
  }

  const chunkOfMessage = (messageId: string): Chunk => {
    for (const c of active.values()) if (c.messages.some((m) => m.id === messageId)) return c;
    throw new ThreadError(404, "No such message.");
  };
  const checkId = (id: string) => {
    if (id !== ASSISTANT_ID) throw new ThreadError(404, "No such conversation.");
  };

  // ---- rotation ----
  // Keeps the newest complete chunks whose bounded sizes add up to at most the active budget; every older complete chunk is
  // archived, oldest first, one rename each. It stops at an open chunk (a turn in progress) and at a chunk with a card that can
  // still be confirmed, so a pending confirmation is never moved out of view; those chunks are archived by a later rotation.
  // Deterministic: the same chunks and cards always give the same result.
  function rotate(): number[] {
    const list = sortedActive();
    let room = activeBudget;
    let keepFrom = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]!;
      if (c.state !== "complete") {
        keepFrom = i;
        continue;
      }
      const size = boundChunk(c).chars;
      if (size > room) break;
      room -= size;
      keepFrom = i;
    }
    const moved: number[] = [];
    for (const c of list.slice(0, keepFrom)) {
      if (c.state !== "complete" || c.cards.some((card) => card.state === "open" && held(card))) break;
      if (dir) {
        renameSync(fileOf(c.seq, "active"), fileOf(c.seq, "archive"));
      } else {
        memArchive.set(c.seq, structuredClone(c));
      }
      active.delete(c.seq);
      archived.push(c.seq);
      moved.push(c.seq);
    }
    if (moved.length) {
      if (dir) {
        fsyncDir(archiveDir!);
        fsyncDir(activeDir!);
      }
      archived.sort((a, b) => a - b);
      bump();
    }
    return moved;
  }
  rotate();

  // The active chunks as a Thread, so the shared turn code (src/thread-service.ts) can read them.
  function asThread(): Thread {
    const list = sortedActive();
    return {
      schema: THREAD_SCHEMA,
      id: ASSISTANT_ID,
      title: ASSISTANT_TITLE,
      titleSet: true,
      createdAt: session.createdAt,
      updatedAt: list.at(-1)?.updatedAt ?? session.createdAt,
      archived: false,
      rev: epoch * stride + changes,
      messages: list.flatMap((c) => c.messages),
      cards: list.flatMap((c) => c.cards),
    };
  }

  return {
    persisted: Boolean(dir),
    problems: () => [...problems],
    session: (): Session => ({ ...session }),
    rev: () => epoch * stride + changes,
    epoch: () => epoch,
    rotate,

    // ---- the TurnStore surface used by src/thread-service.ts ----
    get(id: string): Thread | undefined {
      return id === ASSISTANT_ID ? structuredClone(asThread()) : undefined;
    },
    // One turn at a time. A second send while one runs is refused (409), never queued, so nothing is replayed later.
    tryBegin(id: string): symbol | undefined {
      if (id !== ASSISTANT_ID || busy) return undefined;
      busy = Symbol(id);
      return busy;
    },
    // Frees the conversation only for the turn that holds it, closes that turn's chunk and rotates. A reply still marked pending
    // here (the turn ended by an unexpected error) is marked interrupted: the chunk is never left open.
    end(id: string, token: symbol): boolean {
      if (id !== ASSISTANT_ID || busy !== token) return false;
      try {
        const open = openChunk();
        if (open) {
          mutateActive(open.seq, (c) => {
            c.state = "complete";
            for (const m of c.messages) {
              if (m.status === "pending") {
                m.status = "interrupted";
                m.error = "This turn ended before a reply was recorded. Nothing was retried.";
              }
            }
          });
        }
        rotate();
      } finally {
        busy = undefined;
      }
      return true;
    },
    holds: (id: string, token: symbol) => id === ASSISTANT_ID && busy === token,
    isBusy: (id: string) => id === ASSISTANT_ID && Boolean(busy),

    // A new turn: a new chunk, written before anything else happens, with the next sequence number.
    appendUser(id: string, text: string): ThreadMessage {
      checkId(id);
      if (openChunk()) throw new ThreadError(409, "A reply is already in progress in the Assistant.");
      const at = now().toISOString();
      const m: ThreadMessage = { id: randomUUID(), role: "user", at, text: maskContent(text).slice(0, MAX_MESSAGE_CHARS) };
      const c: Chunk = { schema: CHUNK_SCHEMA, id: randomUUID(), seq: nextSeq, createdAt: at, updatedAt: at, rev: 1, state: "open", messages: [m], cards: [], ...(nextRequest ? { requestId: nextRequest } : {}) };
      persist(c, "active");
      nextSeq++;
      nextRequest = undefined;
      active.set(c.seq, c);
      index(c);
      bump();
      return structuredClone(m);
    },
    beginAssistant(id: string): string {
      checkId(id);
      const open = openChunk();
      if (!open) throw new ThreadError(409, "No Assistant turn is in progress.");
      return mutateActive(open.seq, (c) => {
        const m: ThreadMessage = { id: randomUUID(), role: "assistant", at: now().toISOString(), text: "", status: "pending", calls: [] };
        c.messages.push(m);
        return m.id;
      });
    },
    addCall(id: string, messageId: string, call: StoredCall): void {
      checkId(id);
      mutateActive(chunkOfMessage(messageId).seq, (c) => void (c.messages.find((m) => m.id === messageId)!.calls ??= []).push(maskCall(call)));
    },
    patchMessage(id: string, messageId: string, patch: MessagePatch): void {
      checkId(id);
      mutateActive(chunkOfMessage(messageId).seq, (c) => void Object.assign(c.messages.find((m) => m.id === messageId)!, safePatch(patch)));
    },
    addCard(id: string, messageId: string, card: Card): void {
      checkId(id);
      mutateActive(chunkOfMessage(messageId).seq, (c) => {
        c.cards.push(card);
        (c.messages.find((m) => m.id === messageId)!.cards ??= []).push(card.id);
      });
    },
    threadOfCard: (cardId: string): string | undefined => (cardIndex.has(cardId) ? ASSISTANT_ID : undefined),
    card(cardId: string): Card | undefined {
      const seq = cardIndex.get(cardId);
      if (seq === undefined) return undefined;
      const c = active.get(seq) ?? readArchived(seq);
      const card = c?.cards.find((x) => x.id === cardId);
      return card ? structuredClone(card) : undefined;
    },
    // Compare-and-set on the card's state, wherever its chunk is now: succeeds for exactly one caller.
    transitionCard(cardId: string, from: CardState, to: CardState, patch: Partial<Card> = {}): boolean {
      const seq = cardIndex.get(cardId);
      if (seq === undefined) return false;
      return (
        mutateAny(seq, (c) => {
          const card = c.cards.find((x) => x.id === cardId);
          if (!card || card.state !== from) return false;
          card.state = to;
          card.decidedAt = now().toISOString();
          Object.assign(card, patch);
          return true;
        }) ?? false
      );
    },
    recordOutcome(cardId: string, outcome: NonNullable<Card["outcome"]>, state?: CardState): void {
      const seq = cardIndex.get(cardId);
      if (seq === undefined) return;
      mutateAny(seq, (c) => {
        const card = c.cards.find((x) => x.id === cardId);
        if (!card || card.state === "open") return;
        card.outcome = { ...card.outcome, ...maskDeep(outcome) };
        if (state && (card.state === "confirmed" || card.state === "refused")) card.state = state;
      });
    },

    // ---- Assistant-only ----
    // Whether a send with this request id already started a turn (it is never run again).
    seenRequest: (requestId: string) => requestIds.has(requestId),
    // The request id the next appended turn is for; undefined clears it (the turn did not start).
    expectRequest(requestId: string | undefined): void {
      nextRequest = requestId;
    },
    // Active chunks, oldest first (the open one, if a turn is running, last).
    // Read-only facts for the session registry (src/sessions.ts). Bounded to the active chunks (already in memory); the archive is
    // never read here. Nothing is cloned, written or counted as a change.
    sessionFacts(): AssistantFacts {
      let last: string | undefined;
      let messages = 0;
      const jobCards: JobCardRef[] = [];
      for (const c of sortedActive()) {
        for (const m of c.messages) if (!last || m.at > last) last = m.at;
        messages += c.messages.length;
        jobCards.push(...jobCardsOf(c.cards));
      }
      return { createdAt: session.createdAt, busy: Boolean(busy), activeChunks: active.size, archivedChunks: archived.length, activeMessages: messages, lastMessageAt: last, jobCards, persisted: Boolean(dir), problems: problems.length };
    },
    active: (): Chunk[] => structuredClone(sortedActive()),
    archivedCount: () => archived.length,
    // A page of archived chunks older than `before` (a sequence number; omitted: the newest archived), oldest first. Reads only
    // the files of that page. Open cards whose proposal is gone are marked expired here, as chat threads do when shown.
    archivePage(before: number | undefined, limit: number): { chunks: Chunk[]; more: boolean } {
      const older = archived.filter((s) => before === undefined || s < before);
      const page = older.slice(-limit);
      const chunks: Chunk[] = [];
      for (const seq of page) {
        let c = readArchived(seq);
        if (!c) {
          chunks.push({ schema: CHUNK_SCHEMA, id: `unreadable-${seq}`, seq, createdAt: "", updatedAt: "", rev: 0, state: "complete", messages: [{ id: `unreadable-${seq}`, role: "assistant", at: "", text: "", status: "error", error: `Archived chunk ${seq} could not be read. Its file is left as it is.` }], cards: [] });
          continue;
        }
        if (c.cards.some((card) => card.state === "open" && !held(card))) {
          index(c);
          mutateAny(seq, (x) => {
            for (const card of x.cards) if (card.state === "open" && !held(card)) Object.assign(card, { state: "expired", decidedAt: now().toISOString() });
          });
          c = readArchived(seq) ?? c;
        }
        chunks.push(c);
      }
      return { chunks, more: older.length > page.length };
    },
    // The context the model would be sent for a new message now (or was sent for the turn in progress), from the active chunks.
    plan(current: ThreadMessage[] = []): ContextPlan {
      return planContext(sortedActive().filter((c) => c.state === "complete"), current);
    },
    // Records on the turn's chunk what the model was sent. Owner-visible; never sent to the model.
    recordContext(plan: ContextPlan): void {
      const open = openChunk();
      if (!open) return;
      mutateActive(open.seq, (c) => void (c.context = { budgetChars: plan.budgetChars, historyChars: plan.historyChars, currentChars: plan.currentChars, included: plan.included, omitted: plan.omitted }));
    },
    // The user message of the turn in progress (for the context plan).
    currentTurn: (): ThreadMessage[] => structuredClone(openChunk()?.messages ?? []),
  };
}
