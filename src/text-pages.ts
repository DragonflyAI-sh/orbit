import { createHash } from "node:crypto";

// Bounded, complete reading of one long text for chat (docs/text-readers.md): a vault note (memory_read_page), a job's final summary
// (job_summary_read) or a research report (research_report_read). Each call returns one page of the ORIGINAL text, cut by offset, that
// fits the chat transport whole (src/agent.ts clips any tool output over MAX_OUTPUT_CHARS (TOOL_OUTPUT_LIMIT below), which would cut the text and the cursor).
// Pages are contiguous: offset..end of one page is followed by end..next end, so joining the pages' `text` gives back the text exactly,
// with no gap and no overlap. The last page says so (`last: true`, `nextCursor: null`).
//
// The contract follows session_read (src/sessions.ts): the first call takes no cursor and no pin (null and "" mean the same); every
// later call passes nextCursor exactly as returned. A cursor is bound to the tool, the resource (path or job id) and the digest and
// length of the text it was cut from, and carries a checksum, so a cursor that was changed, belongs to another read, or points into a
// text that has changed since is refused with a message that says how to restart. Versions are never spliced.

export const TEXT_PAGE_TOOLS = ["memory_read_page", "job_summary_read", "research_report_read"] as const;
export type TextPageTool = (typeof TEXT_PAGE_TOOLS)[number];

// What one page's whole tool output may weigh, as the agent serializes it ({"ok":true,"provenance":…,"source":…,"result":…}) and
// measures it (UTF-16 length, src/agent.ts clipOutput). The 500 left over cover the fields the agent can add (an interruption note).
// The transport limit is src/agent.ts MAX_OUTPUT_CHARS, repeated here because agent.ts is in this module's import cycle (agent ->
// tool-result-budget -> assistant-context -> ... -> the tools); test/text-readers.test.ts checks the two are equal.
export const TOOL_OUTPUT_LIMIT = 8000;
export const PAGE_OUTPUT_MAX = TOOL_OUTPUT_LIMIT - 500;
// The most UTF-8 bytes of serialized text one page carries, so a page of non-ASCII text does not take three times its share of the
// reply's tool-result budget (src/tool-result-budget.ts, which counts bytes). ASCII pages are bound by PAGE_OUTPUT_MAX first.
export const PAGE_TEXT_BYTES_MAX = 12_000;
// The least room for text a page must have after its fixed fields; less means the envelope itself is too large to page safely.
export const PAGE_TEXT_MIN = 1_000;
export const PAGE_CURSOR_MAX = 600;
// Arguments longer than these are refused before anything is read.
export const PAGE_PATH_MAX = 512;
export const PAGE_ID_MAX = 64;

export type PageErrorKind = "invalid-argument" | "invalid-cursor" | "stale-cursor" | "not-found" | "denied" | "no-content" | "unavailable";
// Every failure starts with its kind, then says what happened and what to do. Nothing was read past the check that failed.
export class PageError extends Error {
  readonly kind: PageErrorKind;
  constructor(kind: PageErrorKind, message: string) {
    super(`${kind}: ${message}`);
    this.name = "PageError";
    this.kind = kind;
  }
}

// One readable text. `identity` names it exactly as the tool's arguments do (without the cursor); it is what a cursor is bound to and
// what a restart repeats. `fields` are the provenance and state facts shown on every page (source labels, runner-reported marks).
export type PageSource = { tool: TextPageTool; identity: Record<string, string>; text: string; fields?: Record<string, unknown> };
// The agent's envelope fields for this result, so the page is sized against what is really sent.
export type Envelope = { provenance: "live" | "mock"; source: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const identityKey = (tool: string, identity: Record<string, string>) =>
  sha256(`${tool}\u0000${JSON.stringify(Object.keys(identity).sort().map((k) => [k, identity[k]]))}`).slice(0, 16);
const cursorSum = (body: string) => createHash("sha256").update(`text_page:${body}`).digest("base64url").slice(0, 12);

type Cursor = { t: string; r: string; o: number; x: string; n: number };
export function encodeCursor(c: Cursor): string {
  const body = JSON.stringify({ v: 1, t: c.t, r: c.r, o: c.o, x: c.x, n: c.n });
  return Buffer.from(JSON.stringify({ b: body, h: cursorSum(body) })).toString("base64url");
}

const restartArgs = (identity: Record<string, string>) => JSON.stringify(identity);
const BAD_CURSOR = (tool: string, identity: Record<string, string>) =>
  new PageError(
    "invalid-cursor",
    `the cursor is not one ${tool} returned for this read, or it was changed or shortened. Nothing was read. Pass nextCursor exactly as the previous page returned it, with the same arguments. To read from the start, call ${tool} with ${restartArgs(identity)} and no cursor. Do not retry this cursor.`,
  );

// The first-page contract: undefined, null and "" mean no cursor. Anything else must be a cursor string.
function cursorArg(value: unknown, tool: string, identity: Record<string, string>): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw BAD_CURSOR(tool, identity);
  return value;
}

function decodeCursor(raw: string, tool: string, identity: Record<string, string>): Cursor {
  const bad = () => BAD_CURSOR(tool, identity);
  if (raw.length > PAGE_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  let o: Record<string, unknown>;
  try {
    const outer = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { b?: unknown; h?: unknown };
    if (!outer || typeof outer.b !== "string" || outer.h !== cursorSum(outer.b)) throw bad();
    o = JSON.parse(outer.b) as Record<string, unknown>;
  } catch {
    throw bad();
  }
  const int = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (!o || o.v !== 1 || typeof o.t !== "string" || typeof o.r !== "string" || !/^[0-9a-f]{16}$/.test(o.r) || !int(o.o) || !int(o.n) || typeof o.x !== "string" || !/^[0-9a-f]{16}$/.test(o.x)) throw bad();
  // A cursor is only ever issued for a position strictly inside its text.
  if ((o.o as number) <= 0 || (o.o as number) >= (o.n as number)) throw bad();
  if (o.t !== tool || o.r !== identityKey(tool, identity))
    throw new PageError(
      "invalid-cursor",
      `this cursor belongs to a different read (another tool, note or job), not to ${tool} with ${restartArgs(identity)}. Nothing was read. Use a cursor only with the arguments of the read that returned it; to read this one from the start, leave cursor out.`,
    );
  return { t: o.t, r: o.r, o: o.o as number, x: o.x as string, n: o.n as number };
}

// The JSON-serialized size of a slice, without its quotes: what it really costs in the output.
const cost = (s: string) => JSON.stringify(s).length - 2;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
// The longest slice from `off` whose serialized size fits `room` characters and `bytes` UTF-8 bytes, never ending between the two
// halves of a surrogate pair (a lone surrogate in the text is kept as it is; JSON escapes it and parsing restores it).
function fit(text: string, off: number, room: number, bytes: number): number {
  const ok = (n: number) => {
    const s = JSON.stringify(text.slice(off, off + n));
    return s.length - 2 <= room && Buffer.byteLength(s, "utf8") - 2 <= bytes;
  };
  let lo = 0;
  let hi = text.length - off;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  const end = off + lo;
  if (lo > 0 && end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) lo -= 1;
  return lo;
}

// One page of `src` for the call's `cursor` argument. Throws PageError for every refusal; returns the result value otherwise.
export function textPage(src: PageSource, cursor: unknown, env: Envelope): Record<string, unknown> {
  const { tool, identity, text } = src;
  const given = cursorArg(cursor, tool, identity);
  const digest = sha256(text);
  const total = text.length;
  const key = identityKey(tool, identity);
  let offset = 0;
  if (given !== undefined) {
    const c = decodeCursor(given, tool, identity);
    if (c.x !== digest.slice(0, 16) || c.n !== total)
      throw new PageError(
        "stale-cursor",
        `the text changed after this cursor was issued (it was cut from a version of ${c.n} characters with digest ${c.x}; the current one has ${total} characters, digest ${digest.slice(0, 16)}). Nothing was returned, so no two versions were mixed. Restart: call ${tool} with ${restartArgs(identity)} and no cursor, and read every page again from the first; do not combine pages read before this one with the new ones.`,
      );
    // Never start between the halves of a surrogate pair: no cursor ORBIT issued does.
    if (isLow(text.charCodeAt(c.o)) && isHigh(text.charCodeAt(c.o - 1))) throw BAD_CURSOR(tool, identity);
    offset = c.o;
  }
  const base = (pageText: string, end: number, next: string | null) => ({
    ...identity,
    ...src.fields,
    version: { sha256: digest, chars: total },
    page: { offset, end, chars: end - offset, unit: "UTF-16 code units of the stored text" },
    last: next === null,
    nextCursor: next,
    ...(total === 0 ? { empty: true } : {}),
    continue: next === null ? "This is the last page: the text ends here." : `More text follows. Call ${tool} with the same arguments and cursor set to nextCursor, exactly as given.`,
    text: pageText,
  });
  const envelopeSize = (value: unknown) => JSON.stringify({ ok: true, provenance: env.provenance, source: env.source, result: value }).length;
  // The fixed part of the output, measured with the longest cursor this text can produce, and no text.
  const widest = encodeCursor({ t: tool, r: key, o: Math.max(1, total), x: digest.slice(0, 16), n: total });
  const room = PAGE_OUTPUT_MAX - envelopeSize(base("", total, widest));
  if (room < PAGE_TEXT_MIN)
    throw new PageError("unavailable", `the fixed fields of this page leave only ${room} characters of the ${PAGE_OUTPUT_MAX}-character page for text, so ${tool} cannot page it safely. Nothing was returned. Report this; do not retry.`);
  let n = fit(text, offset, room, PAGE_TEXT_BYTES_MAX);
  if (n === 0 && offset < total) n = isHigh(text.charCodeAt(offset)) && offset + 1 < total && isLow(text.charCodeAt(offset + 1)) ? 2 : 1;
  const end = offset + n;
  const next = end < total ? encodeCursor({ t: tool, r: key, o: end, x: digest.slice(0, 16), n: total }) : null;
  const value = base(text.slice(offset, end), end, next);
  // Belt and braces: the measured page must fit; a page that would be clipped is never returned.
  if (envelopeSize(value) > PAGE_OUTPUT_MAX) throw new PageError("unavailable", `the page did not fit the ${PAGE_OUTPUT_MAX}-character output bound. Nothing was returned. Report this; do not retry.`);
  return value;
}

// Argument checks shared by the three tools. `allowed` are the accepted keys; unknown ones are refused (strict, like session_read).
export function pageArgs(tool: string, a: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(a).filter((k) => !allowed.includes(k));
  if (extra.length) throw new PageError("invalid-argument", `unknown argument(s) ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}. ${tool} accepts: ${allowed.join(", ")}.`);
}
export function pagePath(tool: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new PageError("invalid-argument", `${tool} needs {path: string}, the note path memory_search returned.`);
  if (v.length > PAGE_PATH_MAX) throw new PageError("invalid-argument", `path is ${v.length} characters; at most ${PAGE_PATH_MAX}.`);
  return v.trim();
}
export function pageId(tool: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new PageError("invalid-argument", `${tool} needs {id: string}, a job id.`);
  if (v.length > PAGE_ID_MAX || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.trim())) throw new PageError("invalid-argument", `id is not a job id (letters, digits, dot, underscore and dash, at most ${PAGE_ID_MAX} characters).`);
  return v.trim();
}

export const CURSOR_PARAM = {
  type: "string",
  description: "Leave out for the first page (null or an empty string also mean the first page). To continue, nextCursor exactly as the previous page of the same read returned it, unchanged.",
};
export const PAGING_CONTRACT =
  "Pages hold the original text in order, cut by character offset (page.offset..page.end of version.chars); joined, the pages' text is the whole text exactly. First page: no cursor. Continue with nextCursor exactly as returned and the same other arguments until last is true (nextCursor null); only then have you read all of it. One page is not the whole text: say how much you read. An error starting invalid-cursor or stale-cursor says how to restart; never repeat a call that failed the same way.";
