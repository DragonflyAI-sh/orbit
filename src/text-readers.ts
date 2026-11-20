import type { ChatTool } from "./agent.ts";
import type { Jobs } from "./jobs.ts";
import type { MemoryPort } from "./memory.ts";
import { TaskNoteRefused } from "./task-context.ts";
import type { Result } from "./ports.ts";
import { CURSOR_PARAM, PAGING_CONTRACT, PageError, pageArgs, pageId, pagePath, textPage } from "./text-pages.ts";

// The owner's complete readers for a long vault note and a job's final summary (docs/text-readers.md). They sit beside memory_read and
// job_status (src/chat-tools.ts), which keep their compact one-shot answers unchanged: memory_read returns the whole note in one result
// (cut at the tool-output limit), and job_status gives the summary's size and state only. research_report_read lives with the other
// research tools (src/research-tools.ts). The paging contract is in src/text-pages.ts.

export const TEXT_READER_NAMES = ["memory_read_page", "job_summary_read"] as const;

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

export const SUMMARY_TRUST =
  "Runner-reported: the runner's own account of its job, stored by ORBIT as received. Not verified; check the records (job_status, the pull request) before stating an outcome.";

export function textReaderTools(d: { memory: MemoryPort; jobs?: Jobs }): ChatTool[] {
  const tools: ChatTool[] = [
    {
      name: "memory_read_page",
      readOnly: true,
      description: `Read one vault note completely, one page at a time, by the path memory_search returned. Use it when a note may be longer than about 7,000 characters: memory_read returns a note in one result, and a longer one is cut at the tool-output limit. ${PAGING_CONTRACT} version.sha256 is the digest of the whole note as read; the source says which vault copy answered. Same path rules as memory_read. Read-only.`,
      parameters: obj({ path: str("Note path"), cursor: CURSOR_PARAM }, ["path"]),
      run: async (a) => {
        pageArgs("memory_read_page", a, ["path", "cursor"]);
        const path = pagePath("memory_read_page", a.path);
        await d.memory.refresh?.(30_000);
        let read: Result<string>;
        try {
          read = d.memory.read(path);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          if (err instanceof TaskNoteRefused) throw new PageError("denied", m);
          if (m === "no such note") throw new PageError("not-found", "there is no note at that path in the vault copy that answered. Nothing was read. Find the path with memory_search.");
          if (m === "path is outside the vault") throw new PageError("denied", "the path is outside the vault, or is not a .md note. Nothing was read.");
          throw new PageError("unavailable", `the vault could not be read now (${m.slice(0, 300)}). Nothing was read; do not treat the note as missing or empty.`);
        }
        if (typeof read.value !== "string") throw new PageError("unavailable", "the vault answered without note text. Nothing was read.");
        return { value: textPage({ tool: "memory_read_page", identity: { path }, text: read.value, fields: { kind: "vault-note" } }, a.cursor, read), provenance: read.provenance, source: read.source };
      },
    },
  ];
  const jobs = d.jobs;
  if (jobs) {
    tools.push({
      name: "job_summary_read",
      readOnly: true,
      description: `Read one job's final summary completely, one page at a time (job_status gives only the summary's size and state, and its event texts are short excerpts). ${PAGING_CONTRACT} The summary is runner-reported: what the runner says it did, not verified by ORBIT. summary.state complete means ORBIT holds the whole text (textComplete true); partial or oversize means it holds only the start (textComplete false), so the last page is the end of what ORBIT holds, not of the summary. Read-only.`,
      parameters: obj({ id: str("Job id"), cursor: CURSOR_PARAM }, ["id"]),
      run: async (a) => {
        pageArgs("job_summary_read", a, ["id", "cursor"]);
        const id = pageId("job_summary_read", a.id);
        const job = jobs.get(id);
        if (!job) throw new PageError("not-found", "there is no job with that id. Nothing was read. Check the id with jobs_list.");
        const sum = job.summary;
        if (!sum) throw new PageError("no-content", `job ${id} has no final summary yet (state ${job.state}). Nothing was read; this is not an empty summary.`);
        const complete = sum.state === "complete";
        const source = `jobs/${id}/summary (runner-reported)`;
        const fields = {
          kind: "job-summary",
          jobState: job.state,
          summary: { state: sum.state, via: sum.via, at: sum.at, chars: sum.chars, ...(sum.sha ? { commit: sum.sha } : {}) },
          textComplete: complete,
          ...(complete
            ? {}
            : { held: `ORBIT holds only the first ${sum.text.length} of ${sum.chars} characters of this summary (${sum.state === "partial" ? "only the start arrived over the API; ORBIT reads the full text from git" : "it is over ORBIT's size limit; the full text is in git"}). The last page is the end of what ORBIT holds, not the end of the summary.` }),
          trust: SUMMARY_TRUST,
        };
        return { value: textPage({ tool: "job_summary_read", identity: { id }, text: sum.text, fields }, a.cursor, { provenance: "live", source }), provenance: "live", source };
      },
    });
  }
  return tools;
}
