import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./ops/protocol.ts";
import { maskStoredText, maskVaultText } from "./vault/filter.ts";
import type { FallbackInfo } from "./model.ts";

// Server-owned chat threads. One JSON file per thread in <state>/threads/, written atomically; the in-memory copy is
// the single source while ORBIT runs. docs/threads.md describes the schema, concurrency and migration.

export const THREAD_SCHEMA = 1;
export const DEFAULT_TITLE = "New thread";
export const MAX_TITLE = 100;
export const MAX_MESSAGE_CHARS = 20000;

// ---- masking: applied to everything that is written to a thread --------------------------------------------------

const TRIGGER = /\btrig_[A-Za-z0-9]{6,64}\b/g;

// Routine trigger ids are masked the way the admin cards mask them (trig_…last4); everything else goes through the same
// redaction the ops helpers use for secrets, tokens and long opaque strings.
export function maskText(text: string): string {
  return redact(text.replace(TRIGGER, (m) => `trig_…${m.slice(-4)}`));
}

// Whether a text carries anything a reader or the model could use: at least one letter or digit once whitespace, control and
// invisible format characters (zero-width spaces, byte-order marks, blank braille and Hangul fillers) are ignored. A summary
// that fails this is treated as empty everywhere: it is never stored, never counted as covering messages, never sent.
export const hasContent = (text: string | undefined): boolean => typeof text === "string" && /[\p{L}\p{N}]/u.test(text.replace(/[\u115f\u1160\u3164\uffa0]/g, ""));

// What the conversation itself holds (what Rai and ORBIT say, thread titles and summaries, and the results of vault, memory, job and
// pull-request tools) is masked by value, by known credential shape only (src/vault/filter.ts): a note name, a path, a heading or a
// run of letters is kept exactly, and only the matched secret value is replaced. The tier-1 masker above (redact) keeps masking
// everything that comes from ops tools (logs, host and admin output are already redacted at their source) and error text.
export const maskContent = (text: string): string => maskVaultText(text);

// Tool calls whose results are ops output (ops_*) or ORBIT's own configuration view (orbit_*) keep the tier-1 masking.
const isOpsTool = (name: string): boolean => /^(?:ops_|orbit_)/.test(name);

export function maskCall(call: StoredCall): StoredCall {
  if (isOpsTool(call.name)) return maskDeep(call);
  return { ...call, arguments: maskStoredText(call.arguments), output: maskStoredText(call.output), summary: maskStoredText(call.summary), ...(call.source !== undefined ? { source: maskContent(call.source) } : {}) };
}

export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskText(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  return value;
}

// ---- types ---------------------------------------------------------------------------------------------------------

// One tool call with its result, exactly as the model saw them (masked). `output` is the JSON the model received, which
// carries ok, provenance, source and the result; `provenance` and `source` are repeated for the page.
export type StoredCall = {
  callId: string;
  name: string;
  arguments: string;
  output: string;
  ok: boolean;
  provenance?: "live" | "mock";
  source?: string;
  summary: string;
  at: string;
};

export type DuplicateJob = { job: string; similarity: number; state: string; launchedAt?: string };

export type CardState = "open" | "confirmed" | "cancelled" | "expired" | "refused";
export type CardKind = "job_launch" | "job_steer" | "ops_admin" | "ops_sys" | "vault_edit";
// A proposal shown in a thread. The id is the proposal id; the lifecycle lives here, the executed result lives in ORBIT's
// own records (jobs, ops ledgers) and is only looked up when the card is shown.
export type Card = {
  id: string;
  kind: CardKind;
  state: CardState;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  // Display data (masked). `brief` and `text` can be long.
  routine?: string;
  brief?: string;
  briefMasked?: boolean;
  // Legacy (job_launch cards stored by an older build): the vault notes that build was to copy at launch. Never set any more.
  context?: string[];
  job?: string;
  text?: string;
  action?: string;
  summary?: string;
  display?: Record<string, string> | null;
  warnings?: string[];
  digest?: string;
  duplicates?: DuplicateJob[];
  // What the confirmation produced: ids that point into the authoritative records, never a claim of success.
  outcome?: { jobId?: string; opId?: string; steerN?: number; commit?: string; httpStatus?: number; error?: string };
};

export type MessageStatus = "pending" | "done" | "error" | "interrupted";
export type ThreadMessage = {
  id: string;
  role: "user" | "assistant";
  at: string;
  text: string;
  status?: MessageStatus;
  error?: string;
  calls?: StoredCall[];
  cards?: string[];
  memory?: string[];
  provenance?: "live" | "mock";
  source?: string;
  capped?: boolean;
  // Set when the OpenRouter fallback answered: provider, model, why, and when the primary limit ends.
  fallback?: FallbackInfo;
  // Spend-accounting diagnostics for the owner (a ledger write failed on a billed call). Not part of `text`, so never sent back to the model.
  accounting?: string[];
  // Notes that the reply is cut off or partly dropped (output limit, early finish, malformed tool calls not run). Not part of `text`, so never sent back to the model.
  incomplete?: string[];
};

export type Summary = {
  text: string;
  // How many leading messages the summary stands for. Those messages are all still stored.
  covers: number;
  at: string;
  method: "model" | "extractive";
  // Set when the model summarizer failed and a mechanical digest was used instead.
  degraded?: string;
};

export type Thread = {
  schema: number;
  id: string;
  title: string;
  titleSet: boolean;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt?: string;
  // Bumped by every change, so another client can tell it is looking at an old copy.
  rev: number;
  messages: ThreadMessage[];
  cards: Card[];
  summary?: Summary;
  compaction?: { lastError?: { at: string; detail: string } };
};

export type ThreadMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt?: string;
  rev: number;
  messageCount: number;
  openCards: number;
  busy: boolean;
  compactedMessages: number;
};

// ---- the store -----------------------------------------------------------------------------------------------------

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isThreadId = (s: string) => ID.test(s);

export class ThreadError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing left to clean
    }
    throw err;
  }
}

export type Threads = ReturnType<typeof threadStore>;

// `dir` undefined keeps threads in memory (tests, or a service without a state directory) and says so through `persisted`.
export function threadStore(dir: string | undefined, now: () => Date = () => new Date()) {
  const threads = new Map<string, Thread>();
  const cardIndex = new Map<string, string>();
  const busy = new Set<string>();
  const problems: string[] = [];
  let noticeAcked: string | undefined;

  const index = (t: Thread) => {
    for (const c of t.cards) cardIndex.set(c.id, t.id);
  };
  const file = (id: string) => join(dir!, `${id}.json`);
  const metaFile = () => join(dir!, "meta.json");

  if (dir) {
    mkdirSync(dir, { recursive: true });
    try {
      noticeAcked = (JSON.parse(readFileSync(metaFile(), "utf8")) as { noticeAcked?: string }).noticeAcked;
    } catch {
      // no meta yet
    }
    for (const name of readdirSync(dir)) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !ID.test(id)) continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, name), "utf8")) as Thread;
        if (t.id !== id || !Array.isArray(t.messages)) throw new Error("not a thread");
        t.cards ??= [];
        // A reply that was being written when the process stopped will never finish: say so instead of showing "pending" forever.
        let changed = false;
        for (const m of t.messages) {
          if (m.status === "pending") {
            m.status = "interrupted";
            m.error = "ORBIT restarted before this reply finished.";
            changed = true;
          }
        }
        threads.set(id, t);
        index(t);
        if (changed) writeAtomic(file(id), JSON.stringify(t, null, 2));
      } catch (err) {
        // Never deleted or overwritten: the file is left for a person to look at.
        problems.push(`${name}: ${err instanceof Error ? err.message : "unreadable"}`);
      }
    }
  }

  const persist = (t: Thread) => {
    if (dir) writeAtomic(file(t.id), JSON.stringify(t, null, 2));
  };

  // Every change goes through here: a synchronous read-modify-write on a copy, written before it replaces the live one. No
  // await sits between the read and the write, so two requests cannot overwrite each other, and a failed write changes nothing.
  function mutate<R>(id: string, fn: (t: Thread) => R, touch = true): R {
    const current = threads.get(id);
    if (!current) throw new ThreadError(404, "No thread with that id.");
    const next = structuredClone(current);
    const result = fn(next);
    next.rev = current.rev + 1;
    if (touch) next.updatedAt = now().toISOString();
    persist(next);
    threads.set(id, next);
    index(next);
    return result;
  }

  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const autoTitle = (text: string) => {
    const t = clean(maskContent(text));
    return t.length > 60 ? `${t.slice(0, 59)}…` : t || DEFAULT_TITLE;
  };

  const meta = (t: Thread): ThreadMeta => ({
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    archived: t.archived,
    archivedAt: t.archivedAt,
    rev: t.rev,
    messageCount: t.messages.length,
    openCards: t.cards.filter((c) => c.state === "open").length,
    busy: busy.has(t.id),
    compactedMessages: t.summary && hasContent(t.summary.text) ? t.summary.covers : 0,
  });

  return {
    persisted: Boolean(dir),
    problems: () => [...problems],
    meta,

    create(title?: string): Thread {
      const at = now().toISOString();
      const given = typeof title === "string" ? clean(maskContent(title)).slice(0, MAX_TITLE) : "";
      const t: Thread = { schema: THREAD_SCHEMA, id: randomUUID(), title: given || DEFAULT_TITLE, titleSet: Boolean(given), createdAt: at, updatedAt: at, archived: false, rev: 1, messages: [], cards: [] };
      persist(t);
      threads.set(t.id, t);
      return structuredClone(t);
    },

    // Newest activity first. Archived threads are only listed when asked for.
    list(includeArchived = false): ThreadMeta[] {
      return [...threads.values()]
        .filter((t) => includeArchived || !t.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(meta);
    },

    get: (id: string): Thread | undefined => {
      const t = threads.get(id);
      return t ? structuredClone(t) : undefined;
    },

    rename(id: string, title: unknown): Thread {
      if (typeof title !== "string" || !clean(title)) throw new ThreadError(400, "A thread needs a title.");
      const next = clean(maskContent(title)).slice(0, MAX_TITLE);
      mutate(id, (t) => void ((t.title = next), (t.titleSet = true)));
      return this.get(id)!;
    },

    // Archiving only flips a flag. Messages, cards and summary stay, and the thread can be restored.
    archive(id: string, archived = true): Thread {
      if (archived && busy.has(id)) throw new ThreadError(409, "A reply is in progress in this thread. Archive it when the reply has finished.");
      mutate(id, (t) => {
        t.archived = archived;
        if (archived) t.archivedAt = now().toISOString();
        else delete t.archivedAt;
      });
      return this.get(id)!;
    },

    // ---- one turn ----
    // A thread runs one reply at a time. A second request while one is running is refused, not queued, so messages cannot interleave.
    tryBegin(id: string): boolean {
      if (!threads.has(id) || busy.has(id)) return false;
      busy.add(id);
      return true;
    },
    end: (id: string) => void busy.delete(id),
    isBusy: (id: string) => busy.has(id),

    appendUser(id: string, text: string): ThreadMessage {
      return mutate(id, (t) => {
        const m: ThreadMessage = { id: randomUUID(), role: "user", at: now().toISOString(), text: maskContent(text).slice(0, MAX_MESSAGE_CHARS) };
        t.messages.push(m);
        if (!t.titleSet && t.title === DEFAULT_TITLE) t.title = autoTitle(text);
        return m;
      });
    },

    // The assistant message exists (status "pending") from the moment the turn starts, and every tool call is added to it as
    // it completes, so a crash or a model error mid-turn leaves the calls that really happened on record.
    beginAssistant(id: string): string {
      return mutate(id, (t) => {
        const m: ThreadMessage = { id: randomUUID(), role: "assistant", at: now().toISOString(), text: "", status: "pending", calls: [] };
        t.messages.push(m);
        return m.id;
      });
    },

    addCall(id: string, messageId: string, call: StoredCall): void {
      mutate(id, (t) => {
        const m = t.messages.find((x) => x.id === messageId);
        if (!m) throw new ThreadError(404, "No such message.");
        (m.calls ??= []).push(maskCall(call));
      });
    },

    patchMessage(id: string, messageId: string, patch: Partial<Omit<ThreadMessage, "id" | "role" | "at" | "calls">>): void {
      mutate(id, (t) => {
        const m = t.messages.find((x) => x.id === messageId);
        if (!m) throw new ThreadError(404, "No such message.");
        const safe = { ...patch };
        if (typeof safe.text === "string") safe.text = maskContent(safe.text).slice(0, MAX_MESSAGE_CHARS);
        if (typeof safe.error === "string") safe.error = maskText(safe.error).slice(0, 1000);
        if (Array.isArray(safe.accounting)) safe.accounting = safe.accounting.slice(0, 5).map((a) => maskText(String(a)).slice(0, 300));
        if (Array.isArray(safe.incomplete)) safe.incomplete = safe.incomplete.slice(0, 5).map((a) => maskText(String(a)).slice(0, 300));
        Object.assign(m, safe);
      });
    },

    // ---- cards ----
    addCard(id: string, messageId: string, card: Card): void {
      mutate(id, (t) => {
        const m = t.messages.find((x) => x.id === messageId);
        if (!m) throw new ThreadError(404, "No such message.");
        t.cards.push(card);
        (m.cards ??= []).push(card.id);
      });
    },

    threadOfCard: (cardId: string): string | undefined => cardIndex.get(cardId),
    card(cardId: string): Card | undefined {
      const tid = cardIndex.get(cardId);
      const c = tid ? threads.get(tid)?.cards.find((x) => x.id === cardId) : undefined;
      return c ? structuredClone(c) : undefined;
    },

    // Compare-and-set on the card's state: succeeds for exactly one caller. This is the single-use guard the thread keeps beside
    // the proposal store's own take(); both must agree before anything runs.
    transitionCard(cardId: string, from: CardState, to: CardState, patch: Partial<Card> = {}): boolean {
      const tid = cardIndex.get(cardId);
      if (!tid) return false;
      return mutate(tid, (t) => {
        const c = t.cards.find((x) => x.id === cardId);
        if (!c || c.state !== from) return false;
        c.state = to;
        c.decidedAt = now().toISOString();
        Object.assign(c, patch);
        return true;
      });
    },

    // Fills in what a confirmation produced, once, after the card is already confirmed or refused.
    recordOutcome(cardId: string, outcome: NonNullable<Card["outcome"]>, state?: CardState): void {
      const tid = cardIndex.get(cardId);
      if (!tid) return;
      mutate(tid, (t) => {
        const c = t.cards.find((x) => x.id === cardId);
        if (!c || c.state === "open") return;
        c.outcome = { ...c.outcome, ...maskDeep(outcome) };
        if (state && (c.state === "confirmed" || c.state === "refused")) c.state = state;
      });
    },

    // ---- compaction ----
    // `error` records that the model summarizer failed and a mechanical digest was stored instead (summary.degraded says the same).
    setSummary(id: string, summary: Summary, error?: string): void {
      // Never replace messages with nothing: an empty (or only-invisible) summary is refused here, whatever the caller did.
      const text = maskContent(summary.text);
      if (!hasContent(text)) throw new ThreadError(500, "Refusing to store an empty summary: the messages it would replace stay as they are.");
      mutate(id, (t) => {
        t.summary = { ...summary, text };
        t.compaction = error ? { lastError: { at: now().toISOString(), detail: maskText(error).slice(0, 300) } } : {};
      });
    },
    setCompactionError(id: string, detail: string): void {
      mutate(id, (t) => void (t.compaction = { lastError: { at: now().toISOString(), detail: maskText(detail).slice(0, 300) } }), false);
    },

    // ---- the one-time notice about the move to server-side threads ----
    notice: (): { id: string; text: string } | undefined => (noticeAcked ? undefined : { id: NOTICE_ID, text: NOTICE_TEXT }),
    ackNotice(): void {
      noticeAcked = now().toISOString();
      if (dir) writeAtomic(metaFile(), JSON.stringify({ noticeAcked }, null, 2));
    },
  };
}

export const NOTICE_ID = "server-threads-v1";
export const NOTICE_TEXT =
  "Chats are now saved on ORBIT's server and shared across your devices. Your earlier browser-only chat history was never stored by ORBIT, so it is not imported and cannot be recovered; start a new thread to continue.";
