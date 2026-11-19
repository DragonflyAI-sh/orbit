// A deterministic, rule-based stand-in for the summarizer model (docs/rolling-summaries.md, "Tests"). It reads ONLY what ORBIT sends it
// (the previous-summary and outgoing-page data blocks of the prompt), carries every item of the previous summary forward, and applies a
// few fixed rules to the page's USER lines. So a test can show that each summary is built from the previous one plus the outgoing page,
// and that what reaches the conversation model carries the result. It proves mechanics, not what a real model would retain.

export const between = (s: string, open: string, close = "</orbit-data>"): string | undefined => {
  const a = s.indexOf(open);
  if (a < 0) return undefined;
  const b = s.indexOf(close, a + open.length);
  return b < 0 ? undefined : s.slice(a + open.length, b);
};

type Parsed = { goal: string; in: string[]; out: string[]; corrections: string[]; decisions: { by: string; text: string }[]; auth: { state: string; text: string }[]; observed: { status: string; text: string }[]; open: string[]; conflicts: string[]; next: string; recovery: string[] };
const STATUS_BACK: Record<string, string> = { "verified by a tool record": "verified", "assistant claim, not verified": "claimed", "reported by Rai": "reported", uncertain: "uncertain" };

// Parses the rendered sections (src/rolling-summary.ts renderSections) back into lists.
export function parseRendered(text: string): Parsed {
  const p: Parsed = { goal: "", in: [], out: [], corrections: [], decisions: [], auth: [], observed: [], open: [], conflicts: [], next: "", recovery: [] };
  let section = "";
  for (const line of text.split("\n")) {
    const goal = /^GOAL: (.*)$/.exec(line);
    if (goal) {
      p.goal = goal[1] === "(not stated)" ? "" : goal[1]!;
      continue;
    }
    const next = /^AGREED NEXT STEP: (.*)$/.exec(line);
    if (next) {
      p.next = next[1] === "(none agreed)" ? "" : next[1]!;
      continue;
    }
    if (/^[A-Z][A-Z ()]+.*:$/.test(line)) {
      section = line;
      continue;
    }
    const item = /^- (.*)$/.exec(line)?.[1];
    if (!item) continue;
    if (section.startsWith("SCOPE (in)")) p.in.push(item);
    else if (section.startsWith("SCOPE (excluded)")) p.out.push(item);
    else if (section.startsWith("EXPLICIT USER CORRECTIONS")) p.corrections.push(item);
    else if (section.startsWith("DECISIONS")) {
      const m = /^\[(\w+)\] (.*)$/.exec(item);
      if (m) p.decisions.push({ by: m[1]!, text: m[2]! });
    } else if (section.startsWith("AUTHORIZATION")) {
      const m = /^\[(\w+)\] (.*)$/.exec(item);
      if (m) p.auth.push({ state: m[1]!, text: m[2]! });
    } else if (section.startsWith("OBSERVED STATE")) {
      const m = /^\[([^\]]+)\] (.*)$/.exec(item);
      const key = m ? Object.keys(STATUS_BACK).find((k) => m[1] === k || m[1]!.startsWith(`${k}, `)) : undefined;
      if (m) p.observed.push({ status: key ? STATUS_BACK[key]! : "uncertain", text: m[2]! });
    } else if (section.startsWith("UNRESOLVED COMMITMENTS")) p.open.push(item);
    else if (section.startsWith("UNRESOLVED DISAGREEMENTS")) p.conflicts.push(item);
    else if (section.startsWith("RECOVERY")) p.recovery.push(item);
  }
  return p;
}

// Rules over the outgoing page (only lines ORBIT rendered as `[chunk N | user ...]` or `[message N | user ...]` count as Rai's words):
//   GOAL: x            -> goal
//   RESEARCH ONLY: x   -> scope.out
//   IN SCOPE: x        -> scope.in
//   CORRECTION: x      -> corrections (supersedes the assistant's broadened decisions, which are dropped)
//   APPROVED: x / PENDING: x -> authorizations
//   DONE: x            -> removes open items containing x
//   NEXT: x            -> next
// Assistant lines: "I will also integrate ..." -> an assistant decision; "COMMIT: x" -> open; "CLAIM: x" -> observed (claimed).
// Tool lines: "-> ok" -> observed (verified by that tool). Everything else (quoted text, tool output, injected instructions) is ignored.
export function fakeSummarize(prompt: string, opts: { tag?: string } = {}): string {
  const prev = parseRendered(between(prompt, '<orbit-data name="previous-summary">') ?? "");
  const page = between(prompt, '<orbit-data name="outgoing-page">') ?? "";
  const covers = /The page covers ([^\n.]+)\./.exec(page)?.[1] ?? "?";
  const s = prev;
  let ref = "";
  let role = "";
  for (const line of page.split("\n")) {
    const head = /^\[((?:chunk|message) \d+) \| (user|assistant)[^\]]*\] (.*)$/.exec(line);
    if (head) {
      ref = head[1]!;
      role = head[2]!;
      const text = head[3]!.replace(/ \[ORBIT: [^\]]*\]$/, "");
      if (role === "user") {
        for (const part of text.split(/(?=\b(?:GOAL|RESEARCH ONLY|IN SCOPE|CORRECTION|APPROVED|PENDING|DONE|NEXT):)/)) {
          const m = /^(GOAL|RESEARCH ONLY|IN SCOPE|CORRECTION|APPROVED|PENDING|DONE|NEXT): ([^\n]*?)\s*$/.exec(part.trim());
          if (!m) continue;
          const [, k, v] = m as unknown as [string, string, string];
          // Test messages are padded with one repeated character to force rolls; the padding is not part of what Rai said.
          const val = v.replace(/\s+(\S)\1{19,}.*$/, "").trim();
          if (k === "GOAL") s.goal = `${val} (${ref})`;
          if (k === "RESEARCH ONLY") s.out.push(`${val} (${ref})`);
          if (k === "IN SCOPE") s.in.push(`${val} (${ref})`);
          if (k === "CORRECTION") {
            s.corrections.push(`${val} (${ref}) [supersedes: the assistant's broadened scope]`);
            s.decisions = s.decisions.filter((d) => !(d.by === "assistant" && /integrat/i.test(d.text)));
          }
          if (k === "APPROVED") s.auth.push({ state: "approved", text: `${val} (${ref})` });
          if (k === "PENDING") s.auth.push({ state: "pending", text: `${val} (${ref})` });
          if (k === "DONE") s.open = s.open.filter((o) => !o.includes(val));
          if (k === "NEXT") s.next = `${val} (${ref})`;
        }
      } else {
        const integ = /I will also integrate ([^.]*)/.exec(text);
        if (integ) s.decisions.push({ by: "assistant", text: `integrate ${integ[1]} (${ref})` });
        const commit = /COMMIT: ([^.]*)/.exec(text);
        if (commit) s.open.push(`${commit[1]} (${ref})`);
        const claim = /CLAIM: ([^.]*)/.exec(text);
        if (claim) s.observed.push({ status: "claimed", text: `${claim[1]} (${ref})` });
      }
      continue;
    }
    const tool = /^ {2}tool (\w+)\(.*?\) -> ok/.exec(line);
    if (tool) s.observed.push({ status: "verified", text: `${tool[1]} returned a result (${ref})` });
  }
  s.recovery.push(`${opts.tag ?? "page"}: ${covers}`);
  const cap = <T>(a: T[]) => a.slice(-12);
  return JSON.stringify({
    goal: s.goal,
    scope: { in: cap(s.in), out: cap(s.out) },
    corrections: cap(s.corrections).map((text) => ({ text })),
    decisions: cap(s.decisions).map((d) => ({ text: d.text, by: d.by })),
    authorizations: cap(s.auth).map((a) => ({ text: a.text, state: a.state })),
    observed: cap(s.observed).map((o) => ({ text: o.text, status: o.status })),
    open: cap(s.open),
    conflicts: cap(s.conflicts),
    next: s.next,
    recovery: cap(s.recovery),
  });
}

// The fictional conversation used by the integration tests: Rai's goal is building assistant tools; two external systems (Alpha Notes,
// Beta Board) are research references only; the assistant wrongly broadens scope to integrating them; Rai corrects it explicitly and sets
// approval boundaries; later turns are filler that push the early turns out of the window through several rolls.
export const SCENARIO = {
  goal: "GOAL: build assistant tools for ORBIT: a note reader and a job tracker.",
  research: "RESEARCH ONLY: Alpha Notes and Beta Board are research references only; do not integrate with them.",
  broaden: "I will also integrate Alpha Notes sync and Beta Board webhooks. COMMIT: draft the note reader design.",
  correction: "CORRECTION: no integrations with Alpha Notes or Beta Board; they stay research references only. APPROVED: drafting the note reader design. PENDING: any job launch needs my explicit confirmation on its card.",
  claim: "CLAIM: the job tracker prototype passed its tests.",
  next: "NEXT: review the note reader design draft together.",
};
