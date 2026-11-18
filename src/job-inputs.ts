import { createHash } from "node:crypto";
import type { DispatchSnapshot } from "./jobs.ts";
import { maskVaultText } from "./vault/filter.ts";

// What a job was given, recorded and shown without secrets (the Jobs page's "Inputs sent to Claude").
//
// The dispatch boundary (src/job-launch.ts, src/launcher.ts) carries exactly these things to a runner:
//   - the Routine fire request: POST .../routines/<trigger>/fire with headers (the Routine credential, API version headers) and the body
//     {text}. The text is `Job id`, `API`, `Token`, `Tool commit` (plus `Lane: research` and `Tool sha256` on the research lane).
//   - the brief: for the build lane, the file .orbit/brief.md that ORBIT commits to orbit-work before firing; for the research lane, the
//     brief held on the job and served to the runner by the job API (GET /v1/jobs/<id>/brief) with fixed budget and report fields.
//   - later: steers (queued here, fetched by the runner over the job API or read from git) and, for a review job, the review brief ORBIT
//     writes (it travels the same way as any build brief).
// Not part of what ORBIT sends, so never recorded here: the Routine's own stored prompt (it lives in Claude; deploy/routines/*.md is the
// reference copy), the headers, and the credentials. The token appears only in the fire text, and only its label is kept.

export const REDACTED_TOKEN = "[redacted: one-job runner token]";
// The most of a brief a snapshot keeps. Longer briefs keep this much, say so (retainedChars < chars), and stay whole in orbit-work.
export const DISPATCH_BRIEF_CHARS = 60_000;

// Credential shapes masked on top of the vault filter's rules (assignments such as `token: …` or `password=…`, keys and the like).
// Deliberately narrower than the ops helper's redactor: a commit id, a session URL or a long path in a brief is not a secret and stays.
const SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted key]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]"],
  [/(\bhttps?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|tskey-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g, "[redacted token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]"],
];

const MARK = /\[redacted[^\]]*\]/g;
const marks = (s: string) => s.match(MARK)?.length ?? 0;

// Masks secret-shaped values in owner-visible text. `known` are exact secret values (a token) replaced by `knownLabel` wherever they
// appear. Returns the text and how many values were masked. Everything else (prose, layout, links, commit ids) is kept byte for byte.
export function redactText(text: string, known: string[] = [], knownLabel = "[redacted]"): { text: string; count: number } {
  let out = text;
  for (const k of known) if (k) out = out.split(k).join(knownLabel);
  for (const [re, to] of SHAPES) out = out.replace(re, to);
  out = maskVaultText(out);
  return { text: out, count: Math.max(0, marks(out) - marks(text)) };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Built from the very `text` and brief the launcher sends, in the same function, just before the fire request.
export function dispatchSnapshot(input: {
  at: string;
  lane: "build" | "research";
  origin: DispatchSnapshot["origin"];
  proposal?: string;
  fireText: string;
  token: string;
  brief: string;
}): DispatchSnapshot {
  const fire = redactText(input.fireText, [input.token], REDACTED_TOKEN);
  const retained = input.brief.slice(0, DISPATCH_BRIEF_CHARS);
  const brief = redactText(retained, [input.token], REDACTED_TOKEN);
  const redactions: DispatchSnapshot["redactions"] = [];
  if (fire.count) redactions.push({ field: "fireText", what: "the one-job runner token (and any other secret-shaped value)", count: fire.count });
  if (brief.count) redactions.push({ field: "brief", what: "secret-shaped values in the brief", count: brief.count });
  return {
    v: 1,
    at: input.at,
    lane: input.lane,
    origin: input.origin,
    ...(input.proposal ? { proposal: input.proposal } : {}),
    fireText: fire.text,
    brief: { text: brief.text, chars: input.brief.length, retainedChars: retained.length, sha256: sha256(input.brief), delivery: input.lane === "research" ? "job-api" : "orbit-work" },
    redactions,
  };
}
