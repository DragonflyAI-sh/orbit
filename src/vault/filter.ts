// The vault content filter: credential RECOGNITION and MASKING for text that is vault content or travels with it (context export,
// vault writes, confirmation cards, thread history and tool output). docs/content-filter.md is the contract.
//
// What this is. A convenience / preflight layer that keeps *known* credential shapes out of notes, exports and stored history. It is
// not a security boundary and does not try to be: unknown or only weakly suspicious text PASSES, on purpose. The things that decide
// whether an action is allowed (owner checks, the protected-vault confirmation, the sensitive-personal-detail policy in
// sensitive.ts, digests, size limits) are separate and are not decided here. The tier-1 masker in src/ops/protocol.ts is untouched and
// still masks ops output and logs at their source.
//
// What it recognises (every rule is an explicit, high-confidence shape; none is keyword-only, entropy-only or length-only):
//  - secret.private-key        a PEM private key block
//  - secret.provider-token     a token with a known vendor prefix and a plausible body (see PROVIDER)
//  - secret.jwt                three-part JSON web token
//  - secret.bearer-token       `Bearer` / `Basic` followed by a credential-shaped value (not a word)
//  - secret.url-credentials    `scheme://user:password@host` (or a long token as the user part of an http(s) URL)
//  - secret.routine-trigger    a Routine trigger id (masked as trig_…last4 by project policy)
//  - secret.credential-assignment  `<credential name> = / : <value>` where the value, taken as one token, has a credential shape
//                              (see judgeValue). A heading such as "Credential:", a file name with a keyword in it, or a sentence
//                              after the name never matches.
// What it deliberately does not do: block a long run of characters because it is long, a hex id because it is hex, a passphrase
// because it has several words, or a value because the name before it says "password". Those pass (documented limits).
//
// Masking hides the matched VALUE and nothing else: the rest of the line, the name, the path and the layout (including CRLF line
// endings) are kept exactly. A finding is a stable rule id plus a line number; matched text is never returned or logged.

export type FilterRule =
  | "secret.private-key"
  | "secret.bearer-token"
  | "secret.url-credentials"
  | "secret.provider-token"
  | "secret.jwt"
  | "secret.credential-assignment"
  | "secret.routine-trigger";

export type Finding = { rule: FilterRule; line: number };

// One recognised value: [start, end) in the text, the rule, and what masking puts in its place.
type Hit = { rule: FilterRule; start: number; end: number; replacement: string; at?: number };

// ---- shared small tests ------------------------------------------------------------------------------------------------------------

const PLACEHOLDER = /^(?:<[A-Za-z][A-Za-z0-9_ -]*>|\$\{?[A-Za-z_]\w*\}?|\$\([^)]*\)|\{\{[^}]*\}\}|%[A-Za-z_]\w*%|\[[^\]]*\]|[xX*•.…#_-]{3,}|x{3,}\w*|your[_-][\w-]+|example\w*|changeme|placeholder|redacted)$/i;
const DATE_LIKE = /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?|\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?|v?\d+(?:\.\d+){1,3})$/;
const FILE_EXT = /\.(md|ts|js|mjs|json|ya?ml|txt|toml|sh|py|css|html|canvas|csv|log|env|pem|key)$/i;
const PROSE_AFTER_SCHEME = new Set(["tokens", "token", "authentication", "authorization", "auth", "header", "headers", "credentials", "scheme", "schemes", "prefix", "realm", "flow", "style", "type"]);

// A single token that reads as ordinary words (a note name, a slug, camelCase, run-together English). Such a token is never judged a
// credential by shape: it passes. Real random secrets break these tests (capitals every few characters, digits inside letters,
// consonant clusters, vowel-poor segments).
export function wordLikeRun(run: string): boolean {
  return kebabWords(run) || camelWords(run) || joinedWords(run);
}

function camelWords(run: string): boolean {
  if (!/^[A-Za-z]+$/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false;
  const words = run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  if (words.join("") !== run || words.length < 3) return false;
  return words.every((w) => w.length >= 2 && /[aeiouyAEIOUY]/.test(w) && !/[^aeiouyAEIOUY]{6,}/.test(w));
}

function joinedWords(input: string): boolean {
  const digits = (input.match(/\d/g) ?? []).length;
  const run = digits <= 3 ? input.replace(/\d/g, "") : input;
  if (!/^[A-Za-z]+$/.test(run)) return false;
  if ((run.match(/[A-Z]/g) ?? []).length * 6 > run.length) return false;
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
    if (/^\d{1,4}$/.test(s)) continue;
    if (/^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)$/.test(s) && s.length <= 16) {
      const l = s.toLowerCase();
      if (/[^aeiouy]{6,}/.test(l)) return false;
      if (s.length >= 3 && !/[aeiouy]/.test(l)) {
        if (s.length > 4) return false;
        abbr++;
      } else words++;
    } else if (/^[A-Za-z]+$/.test(s) || /^[A-Za-z0-9]{17,}$/.test(s)) {
      if (!(joinedWords(s) || camelWords(s))) return false;
      words += 3;
    } else if (/^(?:[A-Za-z]{1,6}\d{1,4}|\d{1,4}[A-Za-z]{1,6})$/.test(s)) mixed++;
    else return false;
  }
  return words >= 2 && mixed * 2 <= segs.length && abbr * 3 <= segs.length;
}

const classesOf = (s: string): number => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;

// ---- credential-assignment ---------------------------------------------------------------------------------------------------------

// A name that says "credential": the keyword may sit inside a longer identifier (DB_PASSWORD, github_token, clientSecret).
const KEY = /([\w.-]*(?:passw(?:or)?d|passwd|passphrase|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|auth[ _-]?key|credentials?|cookie|session[_-]?id|authorization)[\w.-]*)(["']?[ \t]*[=:][ \t]*)/gi;
const PASSWORD_NAME = /passw(?:or)?d|passwd|passphrase/i;

// What a value must look like to be called a credential. Judged on ONE token:
//  - a placeholder, date, version, stop word, number, URL without credentials, path, or word-like name passes;
//  - under a password name: 6+ characters that mix at least two character classes, or 12+ characters that are not word-like;
//  - under any other credential name: 16+ characters mixing letters and digits (or symbols), or 24+ characters that are not word-like.
// Short, single-class and word-like values pass. This is intentionally permissive: it recognises the common generated shapes, not
// every password anyone can type.
// Whether a token reads as plain words. Under a password name a digit inside the token ("Hunter2hunter2") means it is not a plain word
// list, whatever its vowels do.
const wordish = (key: string, t: string): boolean => wordLikeRun(t.replace(/[^A-Za-z0-9_-]/g, "")) && !(PASSWORD_NAME.test(key) && /\d/.test(t));

function tokenLooksSecret(key: string, token: string): boolean {
  const t = token.replace(/[.,;:)\]}]+$/, "");
  if (!t || PLACEHOLDER.test(t) || DATE_LIKE.test(t) || /^\d+$/.test(t) && t.length < 12) return false;
  if (/^(?:none|null|nil|true|false|yes|no|n\/a|na|tbd|todo|unset|empty|optional|required|pass|ok|redacted)$/i.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/i.test(t)) return false; // a URL without credentials
  if (/^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(t) || /^[\w.-]+\/[\w./-]+$/.test(t)) return false; // a path
  if (FILE_EXT.test(t)) return false;
  if (wordish(key, t)) return false;
  if (PASSWORD_NAME.test(key)) return (t.length >= 6 && classesOf(t) >= 2) || t.length >= 12;
  return (t.length >= 16 && classesOf(t) >= 2 && /[A-Za-z]/.test(t) && /[\d\W_]/.test(t)) || t.length >= 24;
}

// The value after the separator, as a span: a quoted string (to its closing quote; an unclosed quote runs to the end of the line) or
// an unquoted run to the end of the line, a ";" or a "|". A markdown wrapper (`**`, `_`, backtick) before it is skipped. Returns the
// span of the token to mask, or undefined when the value is not a single credential-shaped token.
function valueSpan(text: string, from: number, key: string): { start: number; end: number } | undefined {
  let i = from;
  while (i < text.length && /[*_`~ \t]/.test(text[i]!)) i++;
  const q = text[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== q && text[j] !== "\n" && text[j] !== "\r") j += text[j] === "\\" ? 2 : 1;
    const inner = text.slice(i + 1, Math.min(j, text.length));
    if (/\s/.test(inner.trim())) return undefined; // a quoted sentence or multi-word phrase is prose, not a generated secret
    return tokenLooksSecret(key, inner) ? { start: i + 1, end: i + 1 + inner.length } : undefined;
  }
  let j = i;
  while (j < text.length && !/[\r\n;|]/.test(text[j]!)) j++;
  const raw = text.slice(i, j);
  const lead = raw.match(/^\S+/);
  if (!lead) return undefined;
  const first = lead[0].replace(/^[*_`~'"([{<]+/, "").replace(/[*_`~'")\]}>]+$/, "");
  const rest = raw.slice(lead[0].length).trim();
  // Several words: only the first word is a candidate, and only when it is a strong credential shape; the rest is prose after it.
  if (rest && !(first.length >= 8 && classesOf(first) >= 3 && /\d/.test(first) && !wordish(key, first))) return undefined;
  if (!tokenLooksSecret(key, first)) return undefined;
  const off = lead[0].indexOf(first);
  return { start: i + off, end: i + off + first.length };
}

function assignmentHits(text: string, out: Hit[]): void {
  for (const m of text.matchAll(KEY)) {
    const key = m[1]!;
    if (FILE_EXT.test(key)) continue; // "some-token-note.md:" names a file
    const afterSep = (m.index ?? 0) + m[0].length;
    let span = valueSpan(text, afterSep, key);
    if (!span && /^[*_`~]*[ \t]*(?:\r\n|\n|\r|$)/.test(text.slice(afterSep))) {
      // Nothing after the name on its own line (a bare heading or a bare wrapper): a YAML-style value may follow on an indented line,
      // after at most two blank lines. Unindented text (a paragraph, a heading) and list/quote lines never continue.
      const cont = /^[*_`~]*[ \t]*((?:\r\n|\n|\r)(?:[ \t]*(?:\r\n|\n|\r)){0,2}[ \t]+)(?![ \t]|[-*+#>]|\d+[.)]\s)/.exec(text.slice(afterSep));
      const heading = /^[ \t]{0,3}#{1,6}[ \t]/.test(text.slice(text.lastIndexOf("\n", (m.index ?? 0) - 1) + 1, (m.index ?? 0) + 1));
      const blank = cont ? /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)/.test(cont[1]!) : false;
      if (cont && !(heading && blank)) span = valueSpan(text, afterSep + cont[0].length, key);
    }
    if (span) out.push({ rule: "secret.credential-assignment", start: span.start, end: span.end, replacement: "[redacted]" });
  }
}

// ---- the explicit patterns ---------------------------------------------------------------------------------------------------------

// Known vendor prefixes, each with a body long enough that ordinary words cannot match. Anchored on a word boundary so a hyphenated
// word such as "task-force-..." or "sk-" inside a longer identifier is not a hit.
const PROVIDER = new RegExp(
  [
    "sk-(?:ant-|proj-|live-|or-v1-)?[A-Za-z0-9_-]{20,}", // OpenAI / Anthropic / OpenRouter style secret keys
    "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}", // Stripe
    "gh[pousr]_[A-Za-z0-9]{20,}", // GitHub tokens
    "github_pat_[A-Za-z0-9_]{20,}",
    "glpat-[A-Za-z0-9_-]{16,}", // GitLab
    "tskey-[A-Za-z0-9-]{16,}", // Tailscale
    "xox[baprs]-[A-Za-z0-9-]{12,}", // Slack
    "(?:AKIA|ASIA)[0-9A-Z]{16}", // AWS access key id
    "AIza[0-9A-Za-z_-]{35}", // Google API key
    "npm_[A-Za-z0-9]{36}", // npm
    "hf_[A-Za-z0-9]{30,}", // Hugging Face
    "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}", // SendGrid
    "dckr_pat_[A-Za-z0-9_-]{16,}", // Docker
  ].join("|").replace(/^/, "(?<![A-Za-z0-9])(?:").concat(")(?![A-Za-z0-9_])"),
  "g",
);

const JWT = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g;
const TRIGGER = /\btrig_[A-Za-z0-9]{6,64}\b/g;
const BEARER = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/=-]{6,})/gi;
const URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi;

function privateKeyHits(text: string, out: Hit[]): void {
  for (const m of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    const start = m.index ?? 0;
    const rest = text.slice(start);
    const end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(rest);
    if (end) {
      out.push({ rule: "secret.private-key", start, end: start + end.index + end[0].length, replacement: "[redacted key]" });
      continue;
    }
    // No END marker (a quoted header in prose, a truncated paste): hide the header and the base64 body that follows it, nothing more.
    const body = /^[^\r\n]*(?:(?:\r\n|\n|\r)[A-Za-z0-9+/=]{16,}[ \t]*)*/.exec(rest)!;
    out.push({ rule: "secret.private-key", start, end: start + body[0].length, replacement: "[redacted key]" });
  }
}

function bearerHits(text: string, out: Hit[]): void {
  for (const m of text.matchAll(BEARER)) {
    const scheme = m[1]!;
    const v = m[3]!;
    if (PROSE_AFTER_SCHEME.has(v.toLowerCase())) continue; // "Bearer tokens are ...", "Basic authentication"
    // The value must be credential-shaped: 12+ characters mixing digits or capitals with lower case, not word-like. A short or
    // all-lowercase word after "Basic" or "Bearer" is English.
    if (v.length < 12 || classesOf(v.replace(/[^A-Za-z0-9]/g, "")) < 2 || wordLikeRun(v.replace(/[^A-Za-z0-9_-]/g, ""))) continue;
    const start = (m.index ?? 0) + scheme.length + m[2]!.length;
    out.push({ rule: "secret.bearer-token", start, end: start + v.length, replacement: "[redacted]" });
  }
}

function urlCredentialHits(text: string, out: Hit[]): void {
  for (const m of text.matchAll(URL_CRED)) {
    const user = m[2]!;
    const scheme = m[1]!;
    const colon = user.indexOf(":");
    const password = colon >= 0 ? user.slice(colon + 1) : "";
    const real = (v: string) => v.length >= 3 && !PLACEHOLDER.test(v) && !/^[<{$%]/.test(v);
    // user:password@ (a real, non-placeholder password), or an http(s) URL whose user part is itself a long token (token@host).
    const hit = colon >= 0 ? real(password) : /^https?:\/\/$/i.test(scheme) && user.length >= 20 && !wordLikeRun(user);
    if (!hit) continue;
    const start = (m.index ?? 0) + scheme.length;
    out.push({ rule: "secret.url-credentials", start, end: start + user.length, replacement: "[redacted]" });
  }
}

function plainHits(text: string, re: RegExp, rule: FilterRule, replacement: (s: string) => string, out: Hit[]): void {
  for (const m of text.matchAll(re)) out.push({ rule, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, replacement: replacement(m[0]) });
}

// ---- scanning ----------------------------------------------------------------------------------------------------------------------

function scan(text: string): Hit[] {
  const hits: Hit[] = [];
  privateKeyHits(text, hits);
  plainHits(text, PROVIDER, "secret.provider-token", () => "[redacted token]", hits);
  plainHits(text, JWT, "secret.jwt", () => "[redacted jwt]", hits);
  bearerHits(text, hits);
  urlCredentialHits(text, hits);
  plainHits(text, TRIGGER, "secret.routine-trigger", (s) => `trig_…${s.slice(-4)}`, hits);
  assignmentHits(text, hits);
  // Overlaps (a token inside a private-key block, a provider token that is also an assignment value) are reported once, by the
  // earlier-starting, wider hit.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  for (const h of hits) if (!kept.length || h.start >= kept[kept.length - 1]!.end) kept.push(h);
  return kept;
}

// Line numbers count "\n" (so CRLF text counts the same as LF text), from 1.
function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Findings in one text: rule id and line only, in text order. Matched values are never returned.
export function vaultFindings(text: string): Finding[] {
  return scan(text)
    .map((h) => ({ rule: h.rule, line: lineOf(text, h.start) }))
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export const hasVaultFindings = (text: string): boolean => scan(text).length > 0;

// Masks what vaultFindings would flag, value only, and nothing else (names, paths, prose, layout and line endings stay).
export function maskVaultText(text: string): string {
  const hits = scan(text);
  if (!hits.length) return text;
  let out = "";
  let at = 0;
  for (const h of hits) {
    out += text.slice(at, h.start) + h.replacement;
    at = h.end;
  }
  return out + text.slice(at);
}

// Masking for text that is JSON, whole or clipped (a tool call's arguments and output are stored as JSON text, and a long output is
// cut mid-value). Every JSON string literal is decoded, masked as the text it holds (so a real line break, a CRLF pair or an indented
// continuation inside a note is seen as one), and written back only when masking changed it; everything outside the literals, and
// every literal that needs no masking, is kept byte for byte. A literal cut by the clip has no closing quote and is handled too.
const JSON_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
const decodeJsonString = (body: string): string => body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) => (e[0] === "u" && e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : (JSON_ESCAPES[e] ?? e)));
const encodeJsonString = (s: string): string => JSON.stringify(s).slice(1, -1);

export function maskJsonStrings(text: string): string {
  return text.replace(/"((?:[^"\\]|\\.)*\\?)("|$)/g, (whole, body: string, close: string) => {
    const decoded = decodeJsonString(body);
    const masked = maskVaultText(decoded);
    return masked === decoded ? whole : `"${encodeJsonString(masked)}${close}`;
  });
}

// The same masking applied to every string inside a value (objects, arrays), for tool output and cards.
export function maskVaultDeep<T>(value: T): T {
  if (typeof value === "string") return maskVaultText(value) as T;
  if (Array.isArray(value)) return value.map(maskVaultDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskVaultDeep(v)])) as T;
  return value;
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
