import type { ChatTool, Proposals } from "./agent.ts";
import type { Job } from "./jobs.ts";
import type { DuplicateJob } from "./threads.ts";

// Duplicate-launch warning. A new launch proposal is compared with the briefs of jobs launched recently.
//
// Matching: each brief is reduced to its set of distinct words (lower-case letters and digits, 3+ characters, the first
// WORDS_KEPT of them). Two briefs match when the smaller set has at least MIN_WORDS words and the Jaccard similarity of the
// sets is at least THRESHOLD. Window: jobs launched within the last WINDOW_MS, whatever their state (a failed or finished
// job still counts, and the warning shows its state). Only briefs launched through ORBIT after this feature shipped carry a
// signature (Launch.briefWords); older jobs cannot be matched. A warning never blocks the proposal: Rai decides.

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const THRESHOLD = 0.7;
export const MIN_WORDS = 8;
export const WORDS_KEPT = 300;

export function briefWords(brief: string): string {
  const seen = new Set<string>();
  for (const w of brief.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    seen.add(w);
    if (seen.size >= WORDS_KEPT) break;
  }
  return [...seen].join(" ");
}

export function similarity(a: string, b: string): number {
  const x = new Set(a.split(" ").filter(Boolean));
  const y = new Set(b.split(" ").filter(Boolean));
  if (Math.min(x.size, y.size) < MIN_WORDS) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export function findDuplicates(brief: string, jobs: Job[], health: (j: Job) => string, now: Date = new Date()): DuplicateJob[] {
  const mine = briefWords(brief);
  const out: DuplicateJob[] = [];
  for (const j of jobs) {
    const launched = j.launch?.at;
    const theirs = j.launch?.briefWords;
    if (!launched || !theirs || now.getTime() - new Date(launched).getTime() > WINDOW_MS) continue;
    const s = similarity(mine, theirs);
    if (s >= THRESHOLD) out.push({ job: j.id, similarity: Math.round(s * 100) / 100, state: `${j.state}/${health(j)}`, launchedAt: launched });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

// Wraps the job_launch chat tool so its proposal carries the duplicate warning, without changing the tool itself (chat-tools.ts is
// pinned by test/tier12-pin.test.ts). The proposal is still made; the warning goes on the proposal (and so the card) and into the
// tool result the model reads.
export function withDuplicateWarning(tools: ChatTool[], proposals: Proposals, find: (brief: string) => DuplicateJob[]): ChatTool[] {
  return tools.map((t) =>
    t.name !== "job_launch"
      ? t
      : {
          ...t,
          run: async (a, ctx) => {
            const found = typeof a.brief === "string" ? find(a.brief) : [];
            const result = await t.run(a, ctx);
            const v = result.value as { proposalId?: unknown } | null;
            const p = typeof v?.proposalId === "string" ? proposals.peek(v.proposalId) : undefined;
            if (!found.length || !p || p.kind !== "job_launch") return result;
            p.duplicates = found;
            return {
              ...result,
              value: {
                ...(result.value as object),
                duplicateWarning: `This brief closely matches ${found.length} job(s) launched in the last 24 hours (${found.map((x) => `${x.job} ${x.state}`).join(", ")}). Check job_status before telling Rai this is new work; the card shows the same warning.`,
                duplicates: found,
              },
            };
          },
        },
  );
}
