// The vault content filter: an application-layer refinement of the secret check for text that is *vault content* (context export,
// vault writes, confirmation cards, and the display of vault paths). src/ops/protocol.ts (tier 1, pinned) is untouched and its
// redact() stays the global masker for logs and chat; this file only decides, for the two rules that match ordinary prose, whether
// a match is really credential-shaped. Every other rule (private keys, bearer tokens with a token-shaped value, URL credentials,
// provider key prefixes, JWTs) is the same pattern protocol.ts uses, so nothing there is relaxed.
//
// The two refined rules:
//  - secret.credential-assignment: `<name containing password|secret|token|api key|credential|...> = / : <value>`. Before, any value
//    counted, including the "**" of a markdown heading such as "**Credential:** ..." and the file name in "some-credential-note.md:".
//    Now the whole value (a quoted string to its closing quote, an unquoted value to the end of the line) is judged by valueLooksSecret:
//    conservative under strong credential names, with narrow exemptions for placeholders, stop words, dates and credential prose.
//    A markdown wrapper never decides the outcome: it is skipped and the value inside is judged.
//  - secret.long-opaque: a run of 32+ letters, digits, "_" and "-". Before, kebab-case note names and wikilinks matched. Now a run is
//    exempt only when it is made of 3+ short lowercase words (see wordLikeRun). A path or a wikilink around the run is never a
//    reason to exempt it: the same test applies to the run wherever it sits, and mixed case, digits mixed into letters, long
//    segments and vowel-less segments all keep the run flagged. Known limitation (docs/content-filter.md): outside an assignment this
//    also exempts a 33-character repeated-letter run and a dash-separated diceware-style passphrase; inside a credential assignment
//    the value is screened by the rule above instead. This filter does not block every real secret.
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
// Under a password-like name these are weak passwords as much as placeholders, so they are not stop words there.
const WEAK_AS_PASSWORD = new Set(["yes", "no", "true", "false", "pass", "ok"]);
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

// A value that is plainly a stand-in, not a credential: <your-token> (letters only inside), ${TOKEN}, {{token}}, %TOKEN%, or a run
// of x / * / dots. Anything with digits, spaces or mixed content inside the brackets is not a placeholder.
const PLACEHOLDER = /^(?:<[A-Za-z][A-Za-z_-]*>|\$\{?[A-Za-z_]\w*\}?|\{\{\s*[A-Za-z_][\w.-]*\s*\}\}|%[A-Za-z_]\w*%|[xX*•.…#_-]{3,})$/;
// Words that make an unquoted multi-word value read as a sentence about a credential rather than a credential.
const FUNCTION_WORDS = new Set(["the", "a", "an", "in", "on", "of", "to", "is", "are", "was", "be", "and", "or", "for", "with", "not", "no", "by", "it", "its", "this", "that", "at", "from", "as", "when", "if", "see", "only", "never", "never", "are", "lives", "kept"]);
const TECH_WORDS = new Set(["store", "stored", "vault", "host", "env", "environment", "variable", "config", "configuration", "rotate", "rotated", "rotates", "expire", "expires", "expired", "header", "manager", "keychain", "file", "endpoint", "api", "key", "keys", "token", "tokens", "password", "passwords", "secret", "secrets", "credential", "credentials", "service", "server", "never", "budget", "limit", "scope", "bearer", "oauth", "login", "refresh"]);

// Plain connective words that appear in credential prose but are no credential content. Kept short and closed on purpose: a word
// that is not in one of these three lists makes the whole unquoted value be judged as a credential.
const PROSE_WORDS = new Set(["note", "notes", "commit", "committed", "git", "repo", "code", "docs", "chat", "here", "there", "ever", "any", "all", "but", "use", "used", "set", "kept", "stays", "lives"]);

const unescapeQuoted = (s: string): string => s.replace(/\\(.)/g, "$1");

// The value of a credential assignment: what follows `name = / :`, up to the end of the line, a ";" or a "|" (a markdown table cell),
// or the whole quoted string when the value is quoted ("..." or '...', with \" escapes; an unclosed quote runs to the end of the
// line). A markdown wrapper in front (`**`, `_`, backticks) is skipped. Empty means there is no value on this line.
function assignmentValue(raw: string): { text: string; quoted: boolean; raw: string } {
  const lead = raw.replace(/^[\s*_`~]+/, "");
  const q = lead[0];
  if (q === '"' || q === "'") {
    let i = 1;
    while (i < lead.length && lead[i] !== q) i += lead[i] === "\\" ? 2 : 1;
    const inner = unescapeQuoted(lead.slice(1, i));
    return { text: inner, quoted: true, raw: inner };
  }
  const whole = lead.trimEnd();
  return { text: strip(whole), quoted: false, raw: whole.replace(/[.,:;]+$/, "") };
}

// Whether the value after `name = / :` looks like a credential. The WHOLE value is judged, not its first word:
//  - a name that is not a strong credential name (a bare "pass": PASS: / passed: / bypass:) is a test verdict far more often than a
//    credential, so its value must look generated: 10+ characters mixing upper case, lower case and digits (first word if unquoted);
//  - under a strong name (password, passphrase, secret, token, api key, credential, private key, cookie, session id, authorization)
//    the screen is conservative: any value of 4+ characters counts (3+ for password-like names), quoted or not, one word or many.
//    What does not count: an empty value (a bare markdown heading), the stop words below, a bare date, time or version number, a
//    number under 10 digits (under a password-like name, 4+ digits count), a placeholder (see PLACEHOLDER), and an UNQUOTED
//    multi-word value that is plainly a sentence about credentials (2+ function words and a credential/technical word, such as
//    "an API key lives in the host's secret store"). A quoted value never gets the sentence exemption.
function valueLooksSecret(key: string, value: { text: string; quoted: boolean; raw: string }): boolean {
  const t = value.text.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (!STRONG_KEY.test(key)) {
    const first = value.quoted ? t : strip(t.split(/\s+/)[0]!);
    return first.length >= 10 && /[a-z]/.test(first) && /[A-Z]/.test(first) && /\d/.test(first);
  }
  const passwordLike = /passw(?:or)?d|passphrase/i.test(key);
  if (PLACEHOLDER.test(value.raw.trim()) || DATE_LIKE.test(t)) return false;
  if (STOP.has(lower) && !(passwordLike && WEAK_AS_PASSWORD.has(lower))) return false;
  if (/^\d+$/.test(t)) return passwordLike ? t.length >= 4 : t.length >= 10;
  const words = t.split(/\s+/);
  if (words.length > 1 && !value.quoted) {
    // Every word must be a known function or technical word. One unknown word (a name, a digit-bearing token, an English
    // passphrase word) means the value is not demonstrably prose, so it is judged as a credential: function words never
    // immunize the rest of the value.
    const norm = words.map((w) => strip(w).toLowerCase().replace(/['’]s$/, ""));
    const fn = norm.filter((w) => FUNCTION_WORDS.has(w)).length;
    const tech = norm.some((w) => TECH_WORDS.has(w));
    if (fn >= 2 && tech && norm.every((w) => FUNCTION_WORDS.has(w) || TECH_WORDS.has(w) || PROSE_WORDS.has(w))) return false;
  }
  return t.length >= (passwordLike ? 3 : 4);
}

type Rule = { id: FilterRule; re: RegExp; replace: (m: RegExpExecArray, text: string) => string | undefined; at?: (m: RegExpExecArray, text: string) => number };

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
    // key, separator, the rest of the value on the line (or the whole quoted string), and the next line when it is indented (a YAML
    // style "password:" followed by an indented value; only judged when nothing follows the name on its own line).
    re: /([\w.-]*(?:pass(?:word|wd)?|secret|token|api[ _-]?key|authorization|credential|private[ _-]?key|cookie|session[_-]?id)[\w.-]*)(["']?[ \t]*[=:][ \t]*)((?:[*_`~]*[ \t]*)?(?:"(?:[^"\\\n]|\\.)*(?:"|(?=\n|$))|'(?:[^'\\\n]|\\.)*(?:'|(?=\n|$))|[^\n;|]*))((?:(?:\n[ \t]*){0,2}\n[ \t]+(?![ \t]|[-*+#>]|\d+[.)]\s)[^\n;|]*)?)/gi,
    replace: (m, text) => {
      const [, key, sep, value, next] = m as unknown as [string, string, string, string, string | undefined];
      if (FILE_EXT.test(key)) return undefined; // "some-token-note.md:" names a file, it is not an assignment
      const own = assignmentValue(value);
      if (own.text.trim() || own.quoted) return valueLooksSecret(key, own) ? `${key}${sep}[redacted]${next ?? ""}` : undefined;
      // Nothing after the name on its own line (a bare markdown heading, or a bare wrapper such as "**"): only an indented
      // continuation line is a value. Continuation rule: at most two blank (or whitespace-only) lines, then a line indented by
      // a space or tab that is not a list item, heading or quote marker. Unindented text never continues, so a following
      // paragraph or heading is not swallowed, and a markdown heading line ("## Token:") takes no continuation across a blank line.
      if (!next) return undefined;
      const cont = /^((?:\n[ \t]*)*\n[ \t]+)([^\n]*)$/.exec(next);
      if (!cont) return undefined;
      const blanks = (next.match(/\n/g) ?? []).length > 1;
      if (blanks && isHeadingLine(text, m.index ?? 0)) return undefined;
      // The layout (newline and indent) is kept; only the value is replaced.
      return valueLooksSecret(key, assignmentValue(cont[2]!)) ? `${key}${sep}${value}${cont[1]}[redacted]` : undefined;
    },
    // A continuation finding is reported on the line that holds the value, not on the name's line.
    at: (m) => {
      const [, key, sep, value, next] = m as unknown as [string, string, string, string, string | undefined];
      const own = assignmentValue(value);
      if (own.text.trim() || own.quoted || !next) return m.index ?? 0;
      const cont = /^((?:\n[ \t]*)*\n[ \t]+)/.exec(next);
      return (m.index ?? 0) + key.length + sep.length + value.length + (cont ? cont[1]!.length : 0);
    },
  },
  // Routine trigger ids are masked everywhere (trig_…last4), so they are never written into a note or an export.
  { id: "secret.routine-trigger", re: /\btrig_[A-Za-z0-9]{6,64}\b/g, replace: (m) => `trig_…${m[0].slice(-4)}` },
  { id: "secret.long-opaque", re: /[A-Za-z0-9_-]{32,}/g, replace: (m) => (SHA1.test(m[0]) || wordLikeRun(m[0]) ? undefined : "[redacted]") },
];

const isHeadingLine = (text: string, index: number): boolean => /^[ \t]{0,3}#{1,6}[ \t]/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index + 1));

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
      if (rule.replace(m as RegExpExecArray, text) !== undefined) out.push({ rule: rule.id, line: lineOf(text, rule.at ? rule.at(m as RegExpExecArray, text) : (m.index ?? 0)) });
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
