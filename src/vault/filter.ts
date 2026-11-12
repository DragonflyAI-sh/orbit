// The vault content filter: an application-layer refinement of the secret check for text that is *vault content* (context export,
// vault writes, confirmation cards, and the display of vault paths). src/ops/protocol.ts (tier 1, pinned) is untouched and its
// redact() stays the global masker for logs and chat; this file only decides, for the two rules that match ordinary prose, whether
// a match is really credential-shaped. Every other rule (private keys, bearer tokens with a token-shaped value, URL credentials,
// provider key prefixes, JWTs) is the same pattern protocol.ts uses, so nothing there is relaxed.
//
// The two refined rules:
//  - secret.credential-assignment: `<name containing password|secret|token|api key|credential|...> = / : <value>`. Before, any value
//    counted, including the "**" of a markdown heading such as "**Credential:** ..." and the file name in "some-credential-note.md:".
//    Now the value must itself look like a secret (see valueLooksSecret). A markdown wrapper never decides the outcome: it is
//    stripped and the value inside (or, for a bare wrapper, the next word) is judged.
//  - secret.long-opaque: a run of 32+ letters, digits, "_" and "-". Before, kebab-case note names and wikilinks matched. Now a run is
//    exempt only when it is made of 3+ short lowercase words (see wordLikeRun). A path or a wikilink around the run is never a
//    reason to exempt it: the same test applies to the run wherever it sits, and mixed case, digits mixed into letters, long
//    segments and vowel-less segments all keep the run flagged.
//
// Matched values are never returned or logged: a finding is a stable rule identifier plus a line number.

export type FilterRule =
  | "secret.private-key"
  | "secret.bearer-token"
  | "secret.url-credentials"
  | "secret.provider-token"
  | "secret.jwt"
  | "secret.credential-assignment"
  | "secret.long-opaque"
  | "secret.routine-trigger";

export type Finding = { rule: FilterRule; line: number };

const SHA1 = /^[0-9a-f]{40}$/;
const WRAP = /[*_`~[\](){}<>#|!"']/;
const FILE_EXT = /\.(md|ts|js|mjs|json|ya?ml|txt|toml|sh|py|css|html|canvas|csv|log)$/i;
const PROSE_AFTER_SCHEME = new Set(["tokens", "token", "authentication", "authorization", "auth", "header", "headers", "credentials", "scheme", "schemes", "prefix", "realm", "flow", "style", "type"]);
const STOP = new Set(["none", "null", "nil", "true", "false", "yes", "no", "n/a", "na", "tbd", "todo", "redacted", "unset", "empty", "optional", "required", "pass", "ok"]);

// A run of letters/digits/_/- that reads as short lowercase words, like a note name. Deliberately strict: everything else stays flagged.
export function wordLikeRun(run: string): boolean {
  return kebabWords(run) || camelWords(run) || joinedWords(run);
}

// someLongIdentifierName / SomeLongIdentifierName: letters only, 4+ words, every word 3+ letters with a vowel. Random mixed-case
// text breaks on capitals every two characters or so and never gets there.
function camelWords(run: string): boolean {
  if (!/^[A-Za-z]+$/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false;
  const words = run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  if (words.join("") !== run || words.length < 4) return false;
  return words.every((w) => w.length >= 3 && /[aeiouyAEIOUY]/.test(w) && !/[^aeiouyAEIOUY]{6,}/.test(w));
}

// Words run together without separators (a slug with the dashes dropped), lowercase with at most a few capitals. Only accepted when it reads like English:
// a third or more of the letters are vowels and no stretch of consonants is longer than four. Random lowercase text has about a
// fifth vowels and long consonant stretches.
function joinedWords(input: string): boolean {
  const run = input.replace(/\d/g, (d, i: number, all: string) => (all.length > 0 && (input.match(/\d/g) ?? []).length <= 3 ? "" : d)); // up to three stray digits ("...build9projects")
  if (!/^[A-Za-z]+$/.test(run)) return false;
  if ((run.match(/[A-Z]/g) ?? []).length * 6 > run.length) return false; // a few capitals at word starts, not random case
  const low = run.toLowerCase();
  const vowels = (low.match(/[aeiouy]/g) ?? []).length;
  return vowels / low.length >= 0.33 && !/[^aeiouy]{5,}/.test(low);
}

function kebabWords(run: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(run)) return false;
  const segs = run.split(/[-_]+/).filter(Boolean);
  let words = 0;
  let mixed = 0;
  let abbr = 0;
  for (const s of segs) {
    if (/^\d{1,4}$/.test(s)) continue; // a date part or version number
    if (/^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)$/.test(s) && s.length <= 16) {
      const l = s.toLowerCase();
      if (/[^aeiouy]{6,}/.test(l)) return false;
      if (s.length >= 3 && !/[aeiouy]/.test(l)) {
        if (s.length > 4) return false;
        abbr++; // snd, hda, cpu: short vowel-less abbreviations
      } else words++;
    } else if (/^[A-Za-z]+$/.test(s) || /^[A-Za-z0-9]{17,}$/.test(s)) {
      if (!(joinedWords(s) || camelWords(s))) return false; // a long letters-only chunk must itself read as words
      words += 3;
    } else if (/^(?:[A-Za-z]{1,6}\d{1,4}|\d{1,4}[A-Za-z]{1,6})$/.test(s)) mixed++; // v2, 2fa, pr275, oauth2
    else return false; // letters and digits mixed like a hash
  }
  return words >= 3 && mixed * 2 <= segs.length && abbr * 3 <= segs.length;
}

const strip = (v: string): string => {
  let s = v;
  while (s.length && WRAP.test(s[0]!)) s = s.slice(1);
  while (s.length && (WRAP.test(s[s.length - 1]!) || /[.,:;]/.test(s[s.length - 1]!))) s = s.slice(0, -1);
  return s;
};

const STRONG_KEY = /passw(?:or)?d|passphrase|secret|token|api[ _-]?key|authorization|credential|private[ _-]?key|cookie|session[_-]?id/i;
const DATE_LIKE = /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?|\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?|v?\d+(?:\.\d+){1,3})$/;

// Whether the value after `name = / :` looks like a credential. A markdown wrapper or a path around it changes nothing.
//  - a name with only "pass" in it (PASS: / passed: / bypass:) is a test verdict far more often than a credential, so its value must
//    look like a generated password: 10+ characters mixing upper case, lower case and digits;
//  - otherwise 8+ characters count, a password-like name is held to 4+, and shorter values count only when they mix three kinds of
//    character; a bare date, time or version number, and a pure number under 10 digits, are not secrets.
function valueLooksSecret(key: string, raw: string): boolean {
  const v = strip(raw);
  if (!v || STOP.has(v.toLowerCase())) return false;
  if (!STRONG_KEY.test(key)) return v.length >= 10 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);
  const passwordLike = /passw(?:or)?d|passphrase/i.test(key);
  if (DATE_LIKE.test(v)) return false;
  if (/^\d+$/.test(v)) return passwordLike ? v.length >= 4 : v.length >= 10;
  if (v.length >= 8) return true;
  if (passwordLike && v.length >= 4) return true;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return v.length >= 5 && kinds >= 3;
}

type Rule = { id: FilterRule; re: RegExp; replace: (m: RegExpExecArray, text: string) => string | undefined };

const RULES: Rule[] = [
  { id: "secret.private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: () => "[redacted key]" },
  {
    id: "secret.bearer-token",
    re: /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{6,})/gi,
    // "Bearer tokens are ..." and "Basic authentication" are prose. Only a short fixed list of such words is exempt; any other value
    // (including an all-lowercase one) is treated as the credential it may be.
    replace: (m) => {
      const v = m[2]!;
      if (PROSE_AFTER_SCHEME.has(v.toLowerCase())) return undefined;
      // "Basic" is also an ordinary English word ("basic identity"); a real Basic credential is base64 with digits or capitals.
      if (/^basic$/i.test(m[1]!) && /^[a-z][a-z./-]{0,23}$/.test(v)) return undefined;
      return `${m[1]} [redacted]`;
    },
  },
  { id: "secret.url-credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, replace: (m) => `${m[1]}[redacted]@` },
  {
    id: "secret.provider-token",
    re: /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|tskey-[A-Za-z0-9-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,})/g,
    replace: () => "[redacted token]",
  },
  { id: "secret.jwt", re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, replace: () => "[redacted jwt]" },
  {
    id: "secret.credential-assignment",
    re: /([\w.-]*(?:pass(?:word|wd)?|secret|token|api[ _-]?key|authorization|credential|private[ _-]?key|cookie|session[_-]?id)[\w.-]*)(["']?\s*[=:]\s*["']?)([^\s"',;&]+)/gi,
    replace: (m, text) => {
      const [whole, key, sep, value] = m as unknown as [string, string, string, string];
      if (FILE_EXT.test(key)) return undefined; // "some-token-note.md:" names a file, it is not an assignment
      let judged = value;
      if (!strip(value)) {
        // A bare wrapper such as "**" after "Credential:" decides nothing: judge the word that follows it.
        const next = /^\s*(\S+)/.exec(text.slice((m.index ?? 0) + whole.length));
        if (!next) return undefined;
        judged = next[1]!;
      }
      return valueLooksSecret(key, judged) ? `${key}${sep}[redacted]` : undefined;
    },
  },
  // Routine trigger ids are masked everywhere (trig_…last4), so they are never written into a note or an export.
  { id: "secret.routine-trigger", re: /\btrig_[A-Za-z0-9]{6,64}\b/g, replace: (m) => `trig_…${m[0].slice(-4)}` },
  { id: "secret.long-opaque", re: /[A-Za-z0-9_-]{32,}/g, replace: (m) => (SHA1.test(m[0]) || wordLikeRun(m[0]) ? undefined : "[redacted]") },
];

const lineOf = (text: string, index: number): number => {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

// Findings in one text: rule id and line only, in text order. Each rule scans the original text on its own.
export function vaultFindings(text: string): Finding[] {
  const out: Finding[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.replace(m as RegExpExecArray, text) !== undefined) out.push({ rule: rule.id, line: lineOf(text, m.index ?? 0) });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export const hasVaultFindings = (text: string): boolean => RULES.some((rule) => [...text.matchAll(rule.re)].some((m) => rule.replace(m as RegExpExecArray, text) !== undefined));

// Masks what vaultFindings would flag and nothing else. For vault surfaces only: global masking (logs, chat history) is still
// maskText.
export function maskVaultText(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, (...args) => {
    const groups = args.slice(0, -2) as string[];
    const index = args[args.length - 2] as number;
    const m = Object.assign(groups, { index, input: out }) as unknown as RegExpExecArray;
    return rule.replace(m, out) ?? groups[0]!;
  });
  return out;
}

// A short, value-free sentence for a refusal: which rules fired and on which line of the text that was checked.
export function describeFindings(findings: Finding[], label = "line"): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const f of findings) {
    const k = `${f.rule}@${f.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    parts.push(`${f.rule} at ${label} ${f.line}`);
    if (parts.length === 5) break;
  }
  return `${parts.join(", ")}${findings.length > parts.length ? `, and ${findings.length - parts.length} more` : ""}`;
}
