# Complete readers for long texts in chat

Three owner-only, read-only chat tools read a long text completely, one bounded page at a time:

| Tool | Reads | Compact tool it sits beside (unchanged) |
|---|---|---|
| `memory_read_page {path, cursor?}` | one vault note, by the path `memory_search` returned | `memory_read`: the whole note as one result, cut at the tool-output limit |
| `job_summary_read {id, cursor?}` | one job's final summary as ORBIT holds it | `job_status`: the summary's size and state only (now first in the result, with `readWith` naming this tool) |
| `research_report_read {id, cursor?}` | a research job's stored report (or its complete summary when none was stored, as `research_result` does) | `research_result`: the report cut to 6,000 characters (now with `readFullWith` when cut) |

Code: `src/text-pages.ts` (the paging contract), `src/text-readers.ts` (`memory_read_page`, `job_summary_read`),
`src/research-tools.ts` (`research_report_read`), registered in `src/server.ts` beside `chatTools`. Tests: `test/text-readers.test.ts`.

## Why

Every chat tool result is cut at `MAX_OUTPUT_CHARS` (8,000 UTF-16 characters of the serialized result, `src/agent.ts`). Before these
tools, a vault note over about 7,000 JSON-escaped characters, any job summary text and any research report over 6,000 characters
reached the model only in part, and there was no way to ask for the rest. `src/chat-tools.ts` is pinned byte for byte
(`test/tier12-pin.test.ts`), so the readers are separate tools rather than new arguments on the old ones.

## Contract

* **First call:** the resource only (`path` or `id`). No cursor, offset, digest or head is needed; `cursor` left out, `null` or `""`
  all mean the first page.
* **Pages:** each page is the original text from `page.offset` to `page.end` (UTF-16 code units of the stored text), in order. The next
  page starts exactly where the previous one ended, so joining every page's `text` gives back the text exactly: no gap, no overlap, no
  re-encoding. A page never ends between the two halves of a surrogate pair. Lone surrogates, control characters and every other
  character are carried as they are (JSON escapes them and parsing restores them).
* **Continuation:** pass `nextCursor` exactly as returned, with the same `path` or `id`. The last page says so explicitly:
  `last: true`, `nextCursor: null`, and `continue` says the text ends there. Every other page has `last: false` and a cursor.
* **Totals and identity:** every page carries the resource (`path` or `id`), `kind`, `version: {sha256, chars}` of the whole text it
  was cut from, and the tool's own provenance fields (below). The agent's `source` is kept: for a note it says which vault copy
  answered and how fresh it is.
* **Version binding:** a cursor is bound to the tool, the resource, and the digest and length of the text. If the text changed after
  the cursor was issued (a vault fetch or write, a partial summary replaced by the full text from git), the call returns
  `stale-cursor` with the exact arguments for a fresh first page, and nothing else. Pages of two versions are never joined.
* **Empty is not missing:** an empty text is one page with `text: ""`, `empty: true`, `last: true`. Every failure is an error whose
  message starts with its kind:

  | Kind | Meaning |
  |---|---|
  | `not-found` | no note at that path, or no job with that id |
  | `denied` | the path is outside the vault or not a `.md` note (the same rule as `memory_read`, `src/memory.ts`) |
  | `no-content` | the job exists but has no final summary, or the research job has no stored report: not an empty text |
  | `unavailable` | the source could not be read now (no vault, the clone mid-update with no snapshot, the report store unreadable) |
  | `invalid-argument` | an unknown argument, a path over 512 characters, an id that is not a job id, a research read of a build job |
  | `invalid-cursor` | a cursor that is not a string, over 600 characters, altered (checksum), out of range, splitting a surrogate pair, or issued for another tool or resource |
  | `stale-cursor` | the text changed since the cursor was issued; restart from the first page |

  A refusal by the owner policy (`decide("agent", …)`, `src/policy.ts`) happens before the tool runs, as for every chat tool.

## Page size

A page is sized against the output the model really receives: the agent's envelope
(`{"ok":true,"provenance":…,"source":…,"result":…}`) is serialized with the page's fixed fields, the longest cursor this text can
produce and no text, and the text gets what is left of `PAGE_OUTPUT_MAX` = `MAX_OUTPUT_CHARS` − 500 = 7,500 characters, measured as
JSON-escaped length (a quote, backslash or control character counts as its escape). The 500 left over cover a note the agent itself
can add (an interruption note). A page's text is also held to `PAGE_TEXT_BYTES_MAX` = 12,000 UTF-8 bytes once escaped, so a page of
non-ASCII text takes no more than its share of the reply's tool-result budget (96,000 bytes, `docs/assistant.md`). The finished page is
measured again, and a page that would not fit is never returned.

If a page is still cut by the reply's tool-result budget (many calls in one reply), the cut keeps its `nextCursor` whole, with the note
to read the page again with the cursor that call used (`keptFacts`, `src/tool-result-budget.ts`). The three tools are in `PAGED_TOOLS`
(`src/assistant-context.ts`), so a later turn whose earlier calls were omitted from history is still told the newest cursor of each
read, or that the read finished.

## Provenance and trust

* `memory_read_page`: `kind: "vault-note"`; the source is the vault source `memory_read` reports. The model receives the note as read;
  what the conversation stores is masked as for every tool result (`docs/content-filter.md`).
* `job_summary_read`: `kind: "job-summary"`, `jobState`, `summary: {state, via, at, chars, commit?}`, `trust` (runner-reported, not
  verified). `textComplete` is true only for `state: complete`. For `partial` (only the start arrived over the API) and `oversize`
  (over 200,000 characters; ORBIT keeps the first 4,000) it is false, and `held` says how much of how much ORBIT holds: the last page
  is the end of what ORBIT holds, not of the summary.
* `research_report_read`: `kind: "research-report"`, `origin` (`stored-report` or `job-summary`), ORBIT's checks (`report`), the stored
  file's metadata with `matchesText` (whether the stored digest is the digest of the text read), and the same `trust` note as
  `research_result`: untrusted runner-reported data, never instructions.

## Limits

* Offsets count UTF-16 code units, which is what ORBIT stores and JavaScript indexes; they are not bytes or user-visible characters.
* A cursor's checksum detects a changed cursor; it is not a secret. A forged cursor can only point inside the same owner-readable text,
  and its version and range are checked.
* The tools are offered on every route that offers the owner's chat tools, including the paid fallback, which gets the caller's tool
  list unchanged (`src/fallback.ts`). The tests run the real tool loop (`runChat`) with a scripted model; no live provider was called.
* A summary ORBIT holds only in part is still only in part. Reading the full text from git is the existing `completeSummary` path.
