import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssistantStore, Chunk, ContextUse } from "./assistant-store.ts";
import type { ContextPlan } from "./assistant-context.ts";
import type { ModelPort } from "./model.ts";
import { carryGaps, mechanicalDigest, renderPage, renderSections, requestSummary, rollPrompt, ROLL_PAGE_MAX_CHARS, ROLL_TIMEOUT_MS, sourceDigest, summaryBlock } from "./rolling-summary.ts";
import type { Gap, PageEntry, Sections } from "./rolling-summary.ts";
import { writeAtomic } from "./threads.ts";

// The Assistant's cumulative rolling summary (docs/rolling-summaries.md). When rotation archives chunks (the page roll), the archived
// chunks not yet covered are summarized together with the previous summary, and the result is stored as a NEW immutable version file
// that holds the summary and the exact source boundary it covers, written in one atomic exclusive create:
//
//   <state>/assistant/summaries/baseline.json        { schema, legacyThrough, at }: chunks archived before summaries existed (written once)
//   <state>/assistant/summaries/<version>.json       one immutable version: summary + covered boundary + the page it was made from
//
// A version is never rewritten or deleted. The latest readable version is the summary; an unreadable file is reported and skipped, and its
// number is never reused. Only one roll runs at a time (a promise chain), and a commit is compare-and-swap on the version it was made from,
// so a stale result can never replace a newer summary and no chunk is skipped or covered twice.

export const SUMMARY_SCHEMA = 1;
export const ASSISTANT_CONVERSATION = "assistant:assistant";
// At most this many archived chunks are summarized by one request, and at most ROLL_PAGES_PER_TRIGGER requests run per trigger, so a long
// backlog (many chunks archived at once, or after failures) drains over several turns instead of in an unbounded loop.
export const ROLL_CHUNKS_MAX = 8;
export const ROLL_PAGES_PER_TRIGGER = 3;
// A failed summarization of the same page is retried at most this many times in total (per process) before the page is carried forward
// mechanically, explicitly marked as such. Deferral never advances coverage.
export const ROLL_ATTEMPTS_MAX = 2;
// An archived chunk file larger than this is not read by the summarizer; it is named as a gap.
export const ROLL_CHUNK_MAX_BYTES = 4 * 1024 * 1024;

export type SummaryVersion = {
  schema: number;
  conversation: string;
  version: number;
  // The version this one was made from (0: none); commits are compare-and-swap on it. Usually version - 1 (higher only when a number was
  // taken by an unreadable file).
  prevVersion: number;
  at: string;
  method: "model" | "mechanical";
  // The cumulative covered run of archived chunk numbers: from the first chunk after the legacy baseline through the last one summarized.
  covers: { from: number; through: number };
  // The page this version was made from: chunk numbers summarized now, a digest of exactly what was read, and what could not be read.
  page: { from: number; through: number; seqs: number[]; digest: string; unreadable: number[]; unseen: number[] };
  sections?: Sections;
  mechanical?: string[];
  mechanicalDropped?: number;
  gaps: Gap[];
  olderGaps: number;
  degraded?: string;
};

export type RollResult =
  | { status: "disabled" | "idle" }
  | { status: "committed"; version: number; method: "model" | "mechanical"; through: number }
  | { status: "deferred"; from: number; through: number; attempts: number; reason: string }
  | { status: "stale"; detail: string };

const VERSION_FILE = /^(\d{12})\.json$/;
const vname = (v: number) => `${String(v).padStart(12, "0")}.json`;
const range = (a: number, b: number) => (a === b ? `chunk ${a}` : `chunks ${a} to ${b}`);

// Exclusive create: the version file appears whole or not at all, and never replaces an existing one (a hard link fails if the name is
// taken). The temporary file is removed either way.
function createExclusive(file: string, data: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, file);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
  try {
    const d = openSync(join(file, ".."), "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  } catch {
    // not every platform can fsync a directory; the link itself is atomic
  }
}

const isVersion = (v: unknown, n: number): v is SummaryVersion => {
  const s = v as SummaryVersion;
  return (
    !!s &&
    s.schema === SUMMARY_SCHEMA &&
    s.conversation === ASSISTANT_CONVERSATION &&
    s.version === n &&
    Number.isSafeInteger(s.prevVersion) &&
    s.prevVersion >= 0 &&
    s.prevVersion < n &&
    (s.method === "model" || s.method === "mechanical") &&
    Number.isSafeInteger(s.covers?.from) &&
    Number.isSafeInteger(s.covers?.through) &&
    s.covers.through >= s.covers.from - 1 &&
    Array.isArray(s.page?.seqs) &&
    Array.isArray(s.gaps)
  );
};

export type AssistantSummaries = ReturnType<typeof assistantSummaries>;

export function assistantSummaries(
  dir: string | undefined,
  deps: { store: AssistantStore; model: ModelPort; now?: () => Date; timeoutMs?: number; enabled?: boolean; log?: (event: Record<string, unknown>) => void },
) {
  const now = deps.now ?? (() => new Date());
  const enabled = deps.enabled !== false;
  const log = deps.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify({ at: now().toISOString(), ...e })));
  const problems: string[] = [];
  const versions: SummaryVersion[] = [];
  let taken = 0;
  let legacyThrough = 0;

  if (dir) {
    const fresh = !existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const baselineFile = join(dir, "baseline.json");
    try {
      const b = JSON.parse(readFileSync(baselineFile, "utf8")) as { legacyThrough?: unknown };
      if (!Number.isSafeInteger(b.legacyThrough) || (b.legacyThrough as number) < 0) throw new Error("no legacyThrough");
      legacyThrough = b.legacyThrough as number;
    } catch (err) {
      if (existsSync(baselineFile)) {
        // Never guessed: without a readable baseline every archived chunk is treated as not covered by any summary until one is made.
        problems.push(`summaries/baseline.json: ${err instanceof Error ? err.message : "unreadable"}; treated as covering no legacy chunks`);
        legacyThrough = Math.max(0, ...deps.store.archivedSeqs());
      } else {
        // First open with summaries: whatever is archived now predates them and is not covered (no backfill).
        legacyThrough = fresh || !readdirSync(dir).some((f) => VERSION_FILE.test(f)) ? Math.max(0, ...deps.store.archivedSeqs()) : 0;
        writeAtomic(baselineFile, JSON.stringify({ schema: SUMMARY_SCHEMA, legacyThrough, at: now().toISOString() }, null, 2));
      }
    }
    const files = readdirSync(dir).flatMap((f) => (VERSION_FILE.test(f) ? [Number(f.slice(0, 12))] : [])).sort((a, b) => a - b);
    taken = Math.max(0, ...files);
    for (const n of files) {
      try {
        const v = JSON.parse(readFileSync(join(dir, vname(n)), "utf8")) as unknown;
        if (!isVersion(v, n)) throw new Error("not a summary version");
        versions.push(v);
      } catch (err) {
        // Left in place for a person; its number is never reused, and an older readable version stays the summary.
        problems.push(`summaries/${vname(n)}: ${err instanceof Error ? err.message : "unreadable"}`);
      }
    }
  } else {
    legacyThrough = Math.max(0, ...deps.store.archivedSeqs());
  }

  const latest = (): SummaryVersion | undefined => versions.at(-1);
  // The first archived chunk the summary does not cover yet.
  const nextFrom = () => (latest()?.covers.through ?? legacyThrough) + 1;
  // Failed attempts per page start (this process only), and the latest failure, for the coverage note and the page.
  const attempts = new Map<number, { n: number; reason: string; at: string }>();

  const entriesOf = (c: Chunk): PageEntry[] => c.messages.map((m) => ({ ref: `chunk ${c.seq}`, m }));
  const priorText = (v: SummaryVersion | undefined): string | undefined => {
    if (!v) return undefined;
    const parts = [v.sections ? renderSections(v.sections) : "(no model-written sections yet)"];
    if (v.mechanical?.length) parts.push(`MECHANICAL DIGEST of turns the model could not summarize earlier (lossy):\n${v.mechanical.join("\n")}`);
    if (v.gaps.length) parts.push(`NOT COVERED (keep naming these):\n${v.gaps.map((g) => `- ${g.from === g.to ? g.from : `${g.from} to ${g.to}`}: ${g.reason}`).join("\n")}`);
    return parts.join("\n\n");
  };

  // One page: the next uncovered archived chunks, whole chunks only, as many as the summarizer may be shown.
  async function rollOnce(): Promise<RollResult> {
    const base = latest();
    const from = nextFrom();
    const pending = deps.store.archivedSeqs().filter((s) => s >= from);
    if (!pending.length) return { status: "idle" };
    const seqs = pending.slice(0, ROLL_CHUNKS_MAX);
    const read: { seq: number; chunk?: Chunk; reason?: string }[] = seqs.map((seq) => {
      const r = deps.store.archivedChunk(seq, ROLL_CHUNK_MAX_BYTES);
      return r.ok ? { seq, chunk: r.chunk } : { seq, reason: r.reason };
    });
    // Whole chunks while the page fits the summarizer's bound; at least the first chunk (whose overflow, if any, is named as unseen).
    let k = read.length;
    let page = renderPage(read.flatMap((r) => (r.chunk ? entriesOf(r.chunk) : [])), ROLL_PAGE_MAX_CHARS);
    while (k > 1 && page.unseen.length) {
      k--;
      page = renderPage(read.slice(0, k).flatMap((r) => (r.chunk ? entriesOf(r.chunk) : [])), ROLL_PAGE_MAX_CHARS);
    }
    const used = read.slice(0, k);
    const through = used.at(-1)!.seq;
    const entries = used.flatMap((r) => (r.chunk ? entriesOf(r.chunk) : []));
    const digest = sourceDigest(entries);
    const unreadable = used.filter((r) => !r.chunk).map((r) => r.seq);
    const unseen = [...new Set(page.unseen.map((e) => Number(e.ref.slice(6))))];
    // Chunk numbers inside the page that are not in the archive at all (an unreadable active file keeps its number): never covered.
    const missing: number[] = [];
    for (let s = from; s <= through; s++) if (!pending.includes(s)) missing.push(s);
    const newGaps: Gap[] = [
      ...unreadable.map((s) => ({ from: `chunk ${s}`, to: `chunk ${s}`, reason: `archived file could not be read (${used.find((r) => r.seq === s)?.reason}); not summarized` })),
      ...unseen.map((s) => ({ from: `chunk ${s}`, to: `chunk ${s}`, reason: "too large for the summarizer: its later part was not seen" })),
      ...(missing.length ? [{ from: `chunk ${missing[0]}`, to: `chunk ${missing.at(-1)}`, reason: "not in the archive (an unreadable or missing chunk file); not summarized" }] : []),
    ];
    const prompt = rollPrompt({ conversation: ASSISTANT_CONVERSATION, prior: priorText(base), page: page.text || "(no readable messages)", covers: range(from, through) });
    const attempt = entries.length ? await requestSummary(deps.model, prompt, base?.sections, deps.timeoutMs ?? ROLL_TIMEOUT_MS) : ({ ok: false, reason: "empty", detail: "no readable messages in this page" } as const);

    let next: Omit<SummaryVersion, "version" | "prevVersion" | "at" | "schema" | "conversation">;
    if (attempt.ok) {
      const g = carryGaps(base?.gaps, newGaps);
      next = { method: "model", covers: { from: legacyThrough + 1, through }, page: { from, through, seqs: used.map((r) => r.seq), digest, unreadable, unseen }, sections: attempt.sections, gaps: g.gaps, olderGaps: (base?.olderGaps ?? 0) + g.olderGaps };
    } else {
      const prior = attempts.get(from);
      const n = (prior?.n ?? 0) + 1;
      const retryable = attempt.reason !== "mock" && entries.length > 0;
      if (retryable && n < ROLL_ATTEMPTS_MAX) {
        // Deferred: coverage does not move, the prior version stays the summary, and the coverage note names the uncovered chunks.
        attempts.set(from, { n, reason: attempt.detail, at: now().toISOString() });
        log({ event: "rolling_summary_deferred", conversation: ASSISTANT_CONVERSATION, from, through, attempts: n, reason: attempt.reason });
        return { status: "deferred", from, through, attempts: n, reason: attempt.detail };
      }
      // Carried forward mechanically: the previous valid sections unchanged, a lossy digest of the page, and the page named as a gap.
      const mech = mechanicalDigest(entries, base?.mechanical);
      const why = attempt.reason === "mock" ? "no model is connected: mechanical digest only" : `summarized mechanically only (${attempt.detail})`;
      const g = carryGaps(base?.gaps, [{ from: `chunk ${from}`, to: `chunk ${through}`, reason: why }, ...newGaps]);
      next = {
        method: "mechanical",
        covers: { from: legacyThrough + 1, through },
        page: { from, through, seqs: used.map((r) => r.seq), digest, unreadable, unseen },
        ...(base?.sections ? { sections: base.sections } : {}),
        mechanical: mech.lines,
        mechanicalDropped: (base?.mechanicalDropped ?? 0) + mech.dropped,
        gaps: g.gaps,
        olderGaps: (base?.olderGaps ?? 0) + g.olderGaps,
        ...(attempt.reason === "mock" ? {} : { degraded: `The model could not summarize ${range(from, through)} after ${n} attempt(s): ${attempt.detail}. Those turns are carried forward as a lossy mechanical digest; the originals are stored.` }),
      };
    }
    // Compare-and-swap: only a result made from the current latest version may be stored. (One roll runs at a time, so this only fails
    // if something else changed the summaries meanwhile; the result is then dropped and the next roll starts from the newer version.)
    if (latest()?.version !== base?.version) {
      log({ event: "rolling_summary_stale", conversation: ASSISTANT_CONVERSATION, madeFrom: base?.version ?? 0, latest: latest()?.version ?? 0 });
      return { status: "stale", detail: `made from version ${base?.version ?? 0}, but version ${latest()?.version ?? 0} is now the latest` };
    }
    const version = Math.max(taken, base?.version ?? 0) + 1;
    const record: SummaryVersion = { schema: SUMMARY_SCHEMA, conversation: ASSISTANT_CONVERSATION, version, prevVersion: base?.version ?? 0, at: now().toISOString(), ...next };
    if (dir) {
      try {
        createExclusive(join(dir, vname(version)), JSON.stringify(record, null, 2));
      } catch (err) {
        taken = Math.max(taken, version);
        log({ event: "rolling_summary_store_failed", conversation: ASSISTANT_CONVERSATION, version, detail: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
        return { status: "stale", detail: "the version could not be stored; nothing changed" };
      }
    }
    taken = version;
    versions.push(record);
    attempts.delete(from);
    log({ event: "rolling_summary_committed", conversation: ASSISTANT_CONVERSATION, version, method: record.method, from, through, chunks: record.page.seqs.length, gaps: newGaps.length, degraded: Boolean(record.degraded) });
    return { status: "committed", version, method: record.method, through };
  }

  let chain: Promise<unknown> = Promise.resolve();
  // Serialized: a roll requested while one runs starts after it, from whatever that one stored.
  function roll(): Promise<RollResult> {
    if (!enabled) return Promise.resolve({ status: "disabled" });
    const run = async (): Promise<RollResult> => {
      let last: RollResult = { status: "idle" };
      for (let i = 0; i < ROLL_PAGES_PER_TRIGGER; i++) {
        const r = await rollOnce();
        if (r.status !== "committed") return i && r.status === "idle" ? last : r;
        last = r;
      }
      return last;
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    return p;
  }

  // The block given to every conversation model call of a turn (normal, tool continuations and the paid fallback alike: it travels in
  // the reference material of each request). It says what the summary covers, what is neither covered nor visible, and what is visible.
  function block(plan: ContextPlan): { text: string; use: NonNullable<ContextUse["summary"]> } | undefined {
    if (!enabled) return undefined;
    const v = latest();
    const archived = deps.store.archivedSeqs();
    const uncovered = archived.filter((s) => s >= nextFrom());
    const window: string[] = [];
    if (legacyThrough > 0) window.push(`NOT COVERED: chunks 1 to ${legacyThrough} were archived before rolling summaries existed for this conversation; they are not summarized here.`);
    if (uncovered.length) {
      const a = attempts.get(nextFrom());
      window.push(`NOT COVERED AND NOT IN YOUR CONTEXT: ${range(uncovered[0]!, uncovered.at(-1)!)} (archived, not summarized yet${a ? `: the last attempt failed: ${a.reason}` : ""}). Do not assume what they said.`);
    }
    if (plan.omitted.length) window.push(`NOT IN YOUR CONTEXT THIS TURN: active ${range(plan.omitted[0]!, plan.omitted.at(-1)!)} did not fit the context budget (not summarized yet; they will be archived and summarized at the next roll).`);
    if (plan.included.length) window.push(`IN YOUR CONTEXT BELOW: ${range(plan.included[0]!.seq, plan.included.at(-1)!.seq)}${plan.included.some((i) => i.form !== "full") ? " (some shortened, as marked in each)" : ""}.`);
    if (!v && !window.some((w) => w.startsWith("NOT"))) return undefined;
    const recoveryHint = `Originals are stored in full: read them with session_read (id "${ASSISTANT_CONVERSATION}", from "start") when a detail matters; Rai can use Load earlier messages.`;
    const text = v
      ? summaryBlock({ conversation: ASSISTANT_CONVERSATION, version: v.version, method: v.method, at: v.at, covers: range(v.covers.from, v.covers.through), sections: v.sections, mechanical: v.mechanical, mechanicalDropped: v.mechanicalDropped, gaps: v.gaps, olderGaps: v.olderGaps, degraded: v.degraded, window, recoveryHint })
      : summaryBlock({ conversation: ASSISTANT_CONVERSATION, version: 0, method: "mechanical", at: now().toISOString(), covers: "nothing yet (no summary has been made)", gaps: [], window, recoveryHint });
    return { text, use: { version: v?.version ?? 0, through: v?.covers.through ?? legacyThrough, chars: text.length, method: v ? v.method : "none", degraded: Boolean(v?.degraded) || uncovered.length > 0, ...(uncovered.length ? { uncovered: [uncovered[0]!, uncovered.at(-1)!] as [number, number] } : {}) } };
  }

  return {
    enabled,
    roll,
    block,
    latest: (): SummaryVersion | undefined => (latest() ? structuredClone(latest()) : undefined),
    // Owner diagnostics (GET /assistant): coverage, method, gaps and deferral, never the conversation text itself beyond the summary.
    view() {
      const v = latest();
      const uncovered = deps.store.archivedSeqs().filter((s) => s >= nextFrom());
      const a = attempts.get(nextFrom());
      return {
        enabled,
        legacyThrough,
        problems: [...problems],
        ...(v ? { version: v.version, at: v.at, method: v.method, covers: v.covers, gaps: v.gaps, olderGaps: v.olderGaps, degraded: v.degraded ?? null, text: priorText(v) } : { version: 0 }),
        uncovered: uncovered.length ? [uncovered[0], uncovered.at(-1)] : null,
        ...(a ? { lastFailure: { attempts: a.n, reason: a.reason, at: a.at } } : {}),
      };
    },
  };
}
