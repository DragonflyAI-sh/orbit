// Where a chunked pull-request read (pr_text, pr_diff, pr_check_log; src/pr-inspect.ts) stands, read back from a stored tool output,
// so that the facts a later call needs to continue it survive when the output itself is cut: in this reply's tool-result budget
// (src/tool-result-budget.ts keptFacts) and in the Assistant's bounded history (src/assistant-context.ts). Without them a cut chunk
// loses its nextOffset, its content digest and the head it was pinned to, and the only way on is to start again, or worse, to invent
// a digest (docs/pr-inspection.md, "Calling convention").
//
// Only ORBIT's own structured `continuation` field is read, and every value in it is checked against the exact shape the tool writes
// (ids, offsets, SHAs, hex digests, a bounded path), so no untrusted text from GitHub is lifted out of an output into a note. No
// imports: this is read by modules that the tools themselves depend on.

export const PR_CHUNKED_TOOLS = new Set(["pr_text", "pr_diff", "pr_check_log"]);

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PATH_MAX = 300;
const int = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
// The value checks per argument name. Anything else in an argument object makes the whole continuation unreadable.
const ARG: Record<string, (v: unknown) => boolean> = {
  repo: (v) => typeof v === "string" && REPO.test(v),
  pull: (v) => int(v, 1),
  kind: (v) => v === "description" || v === "review" || v === "issue_comment" || v === "inline_comment",
  id: (v) => int(v, 1),
  checkId: (v) => int(v, 1),
  path: (v) => typeof v === "string" && v.length > 0 && v.length <= PATH_MAX && !/[\u0000-\u001f\u007f]/.test(v),
  offset: (v) => int(v),
  expectedHead: (v) => typeof v === "string" && SHA.test(v),
  expectedTextSha256: (v) => typeof v === "string" && HEX64.test(v),
  expectedPatchSha256: (v) => typeof v === "string" && HEX64.test(v),
  expectedExcerptSha256: (v) => typeof v === "string" && HEX64.test(v),
};
const IDENTITY_KEYS = ["repo", "pull", "kind", "id", "path", "checkId"];
const PIN_KEYS = ["expectedHead", "expectedTextSha256", "expectedPatchSha256", "expectedExcerptSha256"];

const args = (v: unknown): Record<string, unknown> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) if (!ARG[k] || !ARG[k]!(x)) return undefined;
  return typeof o.repo === "string" && typeof o.pull === "number" ? o : undefined;
};
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// One chunked read's state as its output states it. `identity`: what is being read (repo, pull and kind/id, path or checkId).
// `pins`: the head and digest every later chunk of it must pass. `next`: the exact arguments of the next chunk, or null when this
// chunk was the last one (the read reached nextOffset null). `restart`: set instead when the call returned no chunk because the head
// or the content was not what it pinned; the arguments of a fresh first chunk (offset 0, no digest).
export type PrChunkState = {
  tool: string;
  identity: Record<string, unknown>;
  pins: Record<string, unknown>;
  offset: number;
  end: number;
  total: number;
  next: Record<string, unknown> | null;
} | { tool: string; identity: Record<string, unknown>; restart: Record<string, unknown> };

export function prChunkState(name: string, output: string): PrChunkState | undefined {
  if (!PR_CHUNKED_TOOLS.has(name)) return undefined;
  let r: Record<string, unknown> | undefined;
  try {
    const v = JSON.parse(output) as { ok?: unknown; result?: unknown } | null;
    if (!v || v.ok === false || !v.result || typeof v.result !== "object") return undefined;
    r = v.result as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const restart = r.restart as { tool?: unknown; arguments?: unknown } | undefined;
  if (restart && typeof restart === "object") {
    const a = restart.tool === name ? args(restart.arguments) : undefined;
    return a ? { tool: name, identity: pick(a, IDENTITY_KEYS), restart: a } : undefined;
  }
  const c = r.continuation as { tool?: unknown; read?: unknown; offset?: unknown; end?: unknown; totalChars?: unknown; next?: unknown } | undefined;
  if (!c || typeof c !== "object" || c.tool !== name) return undefined;
  const read = args(c.read);
  if (!read || !int(c.offset) || !int(c.end) || !int(c.totalChars) || c.offset > c.end || c.end > c.totalChars) return undefined;
  if (c.next === null) {
    if (c.end !== c.totalChars) return undefined;
    return { tool: name, identity: pick(read, IDENTITY_KEYS), pins: pick(read, PIN_KEYS), offset: c.offset, end: c.end, total: c.totalChars, next: null };
  }
  const next = args((c.next as { arguments?: unknown } | null)?.arguments);
  if (!next || (c.next as { tool?: unknown }).tool !== name || next.offset !== c.end || c.end >= c.totalChars) return undefined;
  return { tool: name, identity: pick(read, IDENTITY_KEYS), pins: pick(next, PIN_KEYS), offset: c.offset, end: c.end, total: c.totalChars, next };
}

// The one-line form of a chunk state, for ORBIT's notes. `cut`: the output this describes was cut, so the chunk's own text did not
// all reach the model; it says how to read that chunk again (the same pins at the chunk's own offset).
export function prChunkFact(s: PrChunkState, cut = false): string {
  const what = `${s.tool} ${JSON.stringify(s.identity)}`;
  if ("restart" in s) return `${what}: no chunk was returned (the head or the content was not the one pinned); start again with a first chunk: ${s.tool} ${JSON.stringify(s.restart)}`;
  const span = `chunk ${s.offset}-${s.end} of ${s.total} characters`;
  const again = cut ? `; this chunk was cut before it reached you: to see it again pass offset ${s.offset} with the same pins` : "";
  if (!s.next) return `${what} pinned ${JSON.stringify(s.pins)}: ${span}; final chunk, nextOffset null (read to its end)${again}`;
  return `${what}: ${span}; nextOffset ${s.end}. Continue with exactly ${s.tool} ${JSON.stringify(s.next)}${again}. Earlier offsets of the same text can be re-read with the same pins`;
}

export const prChunkFactOf = (name: string, output: string, cut = false): string | undefined => {
  const s = prChunkState(name, output);
  return s ? prChunkFact(s, cut) : undefined;
};

// The newest state of each chunked read in a list of calls (oldest first), at most `max`, for a note that stands in for omitted calls.
export function prChunkStreams(calls: readonly { name: string; output: string }[], max = 8): PrChunkState[] {
  const streams = new Map<string, PrChunkState>();
  for (const c of calls) {
    const s = prChunkState(c.name, c.output);
    if (!s) continue;
    const key = `${s.tool}\u0000${JSON.stringify(s.identity)}`;
    streams.delete(key);
    streams.set(key, s);
  }
  return [...streams.values()].slice(-max);
}
