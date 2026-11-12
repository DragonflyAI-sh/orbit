import { createHash } from "node:crypto";
import { describeFindings, hasVaultFindings, vaultFindings, type Finding } from "./filter.ts";

// Pure parts of the vault write tools: the five edit operations, path validation and the write policy. Nothing here touches
// the disk, git or the network; the clone (clone.ts) supplies the current text through `Read` and applies the result.
// docs/vault-writes.md describes the policy. The rules below are coded from AGENTS.md sections 3 and 4; they are NOT parsed from the
// vault's AGENTS.md at run time (the clone only requires the file to exist and compares its hash with a baseline: policy-check.ts).

export type VaultErrorCode =
  | "invalid_input"
  | "invalid_path"
  | "policy_refused"
  | "needs_confirmation"
  | "secret_refused"
  | "precondition_failed"
  | "no_change"
  | "auth_unavailable"
  | "policy_unavailable"
  | "sync_failed"
  | "conflict"
  | "push_failed"
  | "unverified";

export class VaultError extends Error {
  code: VaultErrorCode;
  // needs_confirmation: why. conflict: which files.
  details: string[];
  constructor(code: VaultErrorCode, message: string, details: string[] = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type VaultValue = string | number | boolean | string[];

// One requested change. `rewrite_body` is not offered to the model as a tool: the rolling-note writer uses it, through the same
// policy, secret check, log line and git pipeline as every other edit.
export type VaultEdit =
  | { op: "create_note"; path: string; content: string }
  | { op: "append_section"; path: string; heading: string; text: string }
  | { op: "replace_text"; path: string; find: string; replace: string }
  | { op: "set_frontmatter"; path: string; key: string; value: VaultValue }
  | { op: "archive_note"; path: string }
  | { op: "rewrite_body"; path: string; expectBodySha: string; text: string };

export const MAX_TEXT = 20_000;
export const MAX_NOTE = 256 * 1024;
export const MAX_EDITS = 3;

const OPS = new Set(["create_note", "append_section", "replace_text", "set_frontmatter", "archive_note", "rewrite_body"]);
export const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const bodyShaOf = (text: string) => sha(splitFrontmatter(text).body);

// ---- paths ----------------------------------------------------------------------------------------------------------------

const SEGMENT = /^[\p{L}\p{N} ._()&,'+-]+$/u;
const TEXT_EXT = /\.md$/i;
// Outside the notes themselves, confirmed edits may touch these (System/, .obsidian/, scripts/ hold config and tooling).
const CONFIG_EXT = /\.(md|json|txt|css|ya?ml|sh|py)$/i;
const bad = (message: string): never => {
  throw new VaultError("invalid_path", message);
};

// A vault-relative path: forward slashes, no traversal, no hidden segments except .obsidian, no .git, a conservative character set.
// Returns the NFC-normalised path. Everything the vault tools accept goes through here first.
export function validatePath(input: unknown): string {
  if (typeof input !== "string" || !input) return bad("A path is required.");
  const path = input.normalize("NFC");
  if (path.length > 240) bad("The path is too long.");
  if (/[\u0000-\u001f\u007f\\]/.test(path)) bad("The path has control characters or a backslash.");
  if (path.startsWith("/") || path.endsWith("/")) bad("The path must be relative to the vault and name a file.");
  const segments = path.split("/");
  if (segments.length > 8) bad("The path is nested too deeply.");
  for (const s of segments) {
    if (!s || s === "." || s === "..") bad("The path has an empty, . or .. segment.");
    if (s.length > 100) bad("A path segment is too long.");
    if (s.toLowerCase().startsWith(".git")) bad("Paths inside or named like .git are refused.");
    if (s.startsWith(".") && s !== ".obsidian") bad("Hidden paths are refused.");
    if (!SEGMENT.test(s) && s !== ".obsidian") bad("The path has characters that are not allowed (letters, digits, space and . _ - ( ) & , ' + only).");
    if (s.startsWith("-") || s.startsWith(" ") || s.endsWith(" ") || s.endsWith(".")) bad("A path segment cannot start with - or a space, or end with a space or a dot.");
  }
  return path;
}

const lower = (s: string) => s.toLowerCase();
export type Area = "direct" | "journal" | "protected" | "archive" | "outside";

const DIRECT_DIRS = ["Projects", "Tasks", "Areas", "Resources", "Memory", "Inbox"];
const PROTECTED_DIRS = ["System", ".obsidian", "scripts"];
const LOG_FILE = /^Log\/\d{4}\/\d{4}-\d{2}-\d{2}-orbit\.md$/;
export const isOrbitLog = (path: string): boolean => LOG_FILE.test(path);
// Append-only: the whole existing text is still the start of the new text, and something was added.
export const isAppendOnly = (before: string, after: string): boolean => after.length > before.length && after.startsWith(before);

// Where a path sits, per AGENTS.md sections 3 and 4. Protected names are matched without regard to case, so Obsidian on a
// case-insensitive disk cannot be used to slip past them; direct areas need the exact spelling.
export function areaOf(path: string): { area: Area; label: string } {
  const segs = path.split("/");
  const top = segs[0]!;
  if (segs.length === 1 && lower(top) === "agents.md") return { area: "protected", label: "AGENTS.md" };
  if (PROTECTED_DIRS.some((d) => lower(d) === lower(top))) return { area: "protected", label: `${top}/` };
  if (lower(top) === "journal") return { area: "journal", label: "Journal/" };
  if (lower(top) === "archive") return { area: "archive", label: "Archive/" };
  if (segs.length > 1 && DIRECT_DIRS.includes(top)) return { area: "direct", label: `${top}/` };
  if (path === "now.md" || path === "Machines/orbit.md" || LOG_FILE.test(path)) return { area: "direct", label: path };
  return { area: "outside", label: top };
}

// ---- front matter ----------------------------------------------------------------------------------------------------------

export function splitFrontmatter(text: string): { fm: string[] | undefined; body: string; head: string } {
  if (!text.startsWith("---\n")) return { fm: undefined, body: text, head: "" };
  const lines = text.split("\n");
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (close < 0) return { fm: undefined, body: text, head: "" };
  return { fm: lines.slice(1, close), body: lines.slice(close + 1).join("\n"), head: `${lines.slice(0, close + 1).join("\n")}\n` };
}

const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const NUMERIC = /^[-+]?[0-9][0-9_.:eE+-]*$/;

function scalar(v: string | number | boolean): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new VaultError("invalid_input", "A number value must be finite.");
    return String(v);
  }
  if (typeof v === "boolean") return String(v);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new VaultError("invalid_input", "A front matter value must be one line without control characters.");
  if (v.length > 300) throw new VaultError("invalid_input", "A front matter value is limited to 300 characters.");
  return PLAIN.test(v) && !RESERVED.test(v) && !NUMERIC.test(v) && !v.endsWith(" ") && !/:\s/.test(v) ? v : JSON.stringify(v);
}

export function formatValue(value: VaultValue): string {
  if (Array.isArray(value)) {
    if (value.length > 20) throw new VaultError("invalid_input", "A list value is limited to 20 items.");
    return `[${value.map((x) => scalar(x)).join(", ")}]`;
  }
  return scalar(value);
}

// Sets one top-level key. Replaces the key's line (and any block list under it), or adds it; creates front matter when there is none.
export function setFrontmatter(text: string, key: string, value: VaultValue): string {
  if (!KEY.test(key)) throw new VaultError("invalid_input", "A front matter key is letters, digits, _ and -, starting with a letter.");
  if (text.includes("\r")) throw new VaultError("precondition_failed", "This note uses CRLF line endings; front matter edits are not supported for it.");
  const line = `${key}: ${formatValue(value)}`;
  const { fm, body } = splitFrontmatter(text);
  if (!fm) return `---\n${line}\n---\n${text}`;
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < fm.length; i++) {
    const l = fm[i]!;
    if (l.startsWith(`${key}:`)) {
      if (!replaced) out.push(line);
      replaced = true;
      while (i + 1 < fm.length && /^(\s+|- )/.test(fm[i + 1]!)) i++;
      continue;
    }
    out.push(l);
  }
  if (!replaced) out.push(line);
  return `---\n${out.join("\n")}\n---\n${body}`;
}

// ---- sections ------------------------------------------------------------------------------------------------------------

type Heading = { index: number; level: number; text: string };

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | undefined;
  lines.forEach((l, index) => {
    const f = l.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = undefined;
      return;
    }
    if (fence) return;
    const h = l.match(/^(#{1,6}) +(\S.*?)\s*$/);
    if (h) out.push({ index, level: h[1]!.length, text: h[2]! });
  });
  return out;
}

const LIST = /^\s*([-*+]|\d+[.)]) /;

// Appends text at the end of the section whose heading line is exactly `heading` (for example "## Plan"). The heading must occur
// once; a missing or repeated heading is an error, never a guess.
export function appendToSection(text: string, heading: string, add: string): { text: string; heading: string } {
  if (text.includes("\r")) throw new VaultError("precondition_failed", "This note uses CRLF line endings; section edits are not supported for it.");
  const want = heading.match(/^(#{1,6}) +(\S.*?)\s*$/);
  if (!want) throw new VaultError("invalid_input", 'heading must be the full heading line, for example "## Plan".');
  const lines = text.split("\n");
  const all = headings(lines);
  const found = all.filter((h) => h.level === want[1]!.length && h.text === want[2]);
  if (!found.length) throw new VaultError("precondition_failed", `No heading "${heading}" in this note.`);
  if (found.length > 1) throw new VaultError("precondition_failed", `The heading "${heading}" appears ${found.length} times; refusing to guess which.`);
  const h = found[0]!;
  const next = all.find((x) => x.index > h.index && x.level <= h.level);
  const end = next ? next.index : lines.length;
  let last = end - 1;
  while (last > h.index && lines[last]!.trim() === "") last--;
  const addLines = add.replace(/\n+$/, "").split("\n");
  const sep = last === h.index || !(LIST.test(lines[last]!) && LIST.test(addLines[0]!)) ? [""] : [];
  const merged = [...lines.slice(0, last + 1), ...sep, ...addLines, ...lines.slice(last + 1)];
  return { text: merged.join("\n"), heading: want[2]! };
}

// ---- #rai tags and sensitive categories ---------------------------------------------------------------------------------------

const BODY_RAI = /(^|[^\w/#&])#rai(?![\w-])/i;

// A note is tagged #rai when the body has the tag or the tags/tag front matter lists it.
export function isTaggedRai(text: string): boolean {
  const { fm, body } = splitFrontmatter(text);
  if (BODY_RAI.test(body)) return true;
  if (!fm) return false;
  let inTags = false;
  for (const l of fm) {
    const m = l.match(/^([A-Za-z_-]+):(.*)$/);
    if (m) inTags = /^tags?$/i.test(m[1]!);
    if (!inTags) continue;
    const rest = m ? m[2]! : l;
    if (rest.split(/[\s,[\]'"-]+/).some((t) => /^#?rai(\/.*)?$/i.test(t))) return true;
  }
  return false;
}

// Categories of sensitive personal detail that need Rai's confirmation before ORBIT records them (AGENTS.md section 4). This is a
// keyword screen and errs toward asking: it can over-match, never under-match known words. A category already present in the
// note is not "new", so adding to an established note is not blocked by what is already there.
// Health: condition and treatment words always count. Words that are everyday technical vocabulary (diagnose, diagnostics,
// diagnosis, symptom, chronic, disorder, prescribed) count only in a personal or medical construction, so a bug write-up that
// "diagnoses" a failure or lists "symptoms" is not asked about, while "diagnosed with ...", "my symptoms", "chronic pain",
// "prescribed antibiotics" or "an anxiety disorder" still are. When a phrase is both, the screen asks (it errs toward asking).
const HEALTH = new RegExp(
  [
    "psychiatr\\w+|depress(?:ed|ion)|anxiety|cancer|hiv|pregnan\\w+|illness|surgery|medicat\\w+|therap(?:y|ist)\\w*|prescription\\w*|blood pressure|mental health",
    "diagnosed (?:with|me|him|her|them)|diagnosis of|(?:my|his|her|their|your) (?:\\w+ )?diagnos(?:is|es|ed)",
    "(?:my|his|her|their|your|having|experiencing|new) (?:\\w+ )?symptoms?",
    "chronic (?:pain|illness|fatigue|condition|disease|migraines?|headaches?|insomnia|asthma|back|stress)",
    "(?:anxiety|bipolar|eating|sleep|mood|personality|panic|autism|attention|mental|seizure|stress) disorders?|(?:my|his|her|their|your) disorder",
    "prescribed (?:me|him|her|them|\\d+\\w*|an?|some|medication|medicine|drugs?|antibiotics?|pills?)",
  ].join("|").replace(/^/, "\\b(?:").concat(")\\b"),
  "i",
);

const SENSITIVE: [string, RegExp][] = [
  ["health", HEALTH],
  ["finances", /\b(bank account|account number|routing number|credit card|salary|net worth|tax return|mortgage|debt|loan balance|income of)\b/i],
  ["identity documents", /\b(passport|social security|ssn|driver'?s licen[cs]e|national id|date of birth|home address)\b/i],
  ["sexual or relationship detail", /\b(sexual\w*|orientation|affair|divorce|breakup|dating)\b/i],
  ["religion or politics", /\b(religio\w+|church|synagogue|mosque|vote[ds]? for|political part\w+)\b/i],
  ["legal or immigration", /\b(lawsuit|arrest\w*|convict\w*|criminal record|immigration|visa status|asylum|custody)\b/i],
  ["family members' private details", /\b(my (son|daughter|child|kid|wife|husband|partner|mother|father)'?s? (health|diagnos\w+|school|grades))\b/i],
];

export function sensitiveCategories(inserted: string, before: string): string[] {
  return SENSITIVE.filter(([, re]) => re.test(inserted) && !re.test(before)).map(([name]) => name);
}

// ---- applying an edit ------------------------------------------------------------------------------------------------------------

export type Read = (path: string) => string | undefined;

export type Applied = {
  edit: VaultEdit;
  // New full text for each path written (absent value = file removed, which only archive_note does after writing its copy).
  writes: Map<string, string | null>;
  // Text the edit adds. This is what the secret check and the sensitive-category screen look at.
  inserted: string[];
  // Text of the touched note before the edit ("" for a new note).
  before: string;
  after: string;
  // Section heading for append_section, so the Journal plan rule can see it.
  heading?: string;
  describe: string;
};

const need = (cond: boolean, message: string): void => {
  if (!cond) throw new VaultError("invalid_input", message);
};
const textOf = (v: unknown, name: string, { empty = false }: { empty?: boolean } = {}): string => {
  need(typeof v === "string", `${name} must be a string.`);
  const s = v as string;
  need(empty || s.length > 0, `${name} must not be empty.`);
  need(s.length <= MAX_TEXT, `${name} is limited to ${MAX_TEXT} characters.`);
  need(!/\u0000/.test(s), `${name} has a NUL character.`);
  return s;
};

const exactKeys = (a: Record<string, unknown>, allowed: string[]) => {
  const extra = Object.keys(a).filter((k) => !allowed.includes(k));
  need(!extra.length, `Unexpected argument: ${extra.map((k) => k.slice(0, 30)).join(", ")}.`);
};

// Strict parsing of a tool's arguments into an edit. Unknown arguments are refused, never ignored.
export function parseEdit(op: string, a: Record<string, unknown>): VaultEdit {
  need(OPS.has(op), "Unknown vault operation.");
  const path = validatePath(a.path);
  switch (op) {
    case "create_note":
      exactKeys(a, ["path", "content"]);
      return { op, path, content: textOf(a.content, "content") };
    case "append_section":
      exactKeys(a, ["path", "heading", "text"]);
      return { op, path, heading: textOf(a.heading, "heading").trim(), text: textOf(a.text, "text") };
    case "replace_text":
      exactKeys(a, ["path", "find", "replace"]);
      return { op, path, find: textOf(a.find, "find"), replace: textOf(a.replace, "replace", { empty: true }) };
    case "set_frontmatter": {
      exactKeys(a, ["path", "key", "value"]);
      const key = textOf(a.key, "key");
      need(KEY.test(key), "key is letters, digits, _ and -, starting with a letter.");
      const v = a.value;
      const ok = typeof v === "string" || typeof v === "number" || typeof v === "boolean" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
      need(ok, "value must be a string, number, boolean or list of strings.");
      formatValue(v as VaultValue);
      return { op, path, key, value: v as VaultValue };
    }
    case "archive_note":
      exactKeys(a, ["path"]);
      return { op, path };
    default:
      throw new VaultError("invalid_input", "That operation is not available as a tool.");
  }
}

const needFile = (read: Read, path: string): string => {
  const text = read(path);
  if (text === undefined) throw new VaultError("precondition_failed", `${path} does not exist.`);
  return text;
};

function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

export function archivePathOf(path: string): string {
  return `Archive/${path}`;
}

// Applies one edit to the text `read` returns. Throws VaultError("precondition_failed") when what the edit relies on is not true
// (a missing note, a passage that is not there exactly once, a heading that is absent or ambiguous).
export function applyEdit(edit: VaultEdit, read: Read): Applied {
  const writes = new Map<string, string | null>();
  const path = edit.path;
  switch (edit.op) {
    case "create_note": {
      if (read(path) !== undefined) throw new VaultError("precondition_failed", `${path} already exists; create_note never overwrites.`);
      writes.set(path, edit.content.endsWith("\n") ? edit.content : `${edit.content}\n`);
      return { edit, writes, inserted: [edit.content], before: "", after: writes.get(path)!, describe: `created ${path}` };
    }
    case "append_section": {
      const before = needFile(read, path);
      const r = appendToSection(before, edit.heading, edit.text);
      writes.set(path, r.text);
      return { edit, writes, inserted: [edit.text], before, after: r.text, heading: r.heading, describe: `appended to "${r.heading}" in ${path}` };
    }
    case "replace_text": {
      const before = needFile(read, path);
      const n = occurrences(before, edit.find);
      if (n === 0) throw new VaultError("precondition_failed", `The passage to replace is not in ${path} (exact match required).`);
      if (n > 1) throw new VaultError("precondition_failed", `The passage to replace occurs ${n} times in ${path}; include more context so it is unique.`);
      const after = before.replace(edit.find, () => edit.replace);
      if (after === before) throw new VaultError("no_change", "The replacement is identical to the passage.");
      writes.set(path, after);
      return { edit, writes, inserted: [edit.replace], before, after, describe: `replaced a passage in ${path}` };
    }
    case "set_frontmatter": {
      const before = needFile(read, path);
      const after = setFrontmatter(before, edit.key, edit.value);
      if (after === before) throw new VaultError("no_change", `${edit.key} already has that value.`);
      writes.set(path, after);
      return { edit, writes, inserted: [`${edit.key}: ${formatValue(edit.value)}`], before, after, describe: `set ${edit.key} in ${path}` };
    }
    case "rewrite_body": {
      const before = needFile(read, path);
      if (bodyShaOf(before) !== edit.expectBodySha) throw new VaultError("precondition_failed", `${path} changed since it was read; the rewrite was not applied.`);
      const { head } = splitFrontmatter(before);
      const after = `${head}${edit.text.endsWith("\n") ? edit.text : `${edit.text}\n`}`;
      if (after === before) throw new VaultError("no_change", "The note already says this.");
      writes.set(path, after);
      return { edit, writes, inserted: [edit.text], before, after, describe: `rewrote the body of ${path}` };
    }
    case "archive_note": {
      const before = needFile(read, path);
      const dest = archivePathOf(path);
      if (read(dest) !== undefined) throw new VaultError("precondition_failed", `${dest} already exists; nothing is overwritten.`);
      writes.set(dest, before);
      writes.set(path, null);
      return { edit, writes, inserted: [], before, after: before, describe: `moved ${path} to ${dest}` };
    }
  }
}

// ---- policy ----------------------------------------------------------------------------------------------------------------

export type Verdict = { kind: "direct" } | { kind: "protected"; reasons: string[] } | { kind: "refused"; reason: string };

const PLAN_HEADING = /^plan\b/i;
const MOVABLE = new Set(["Projects", "Tasks", "Areas", "Resources", "Memory", "Inbox"]);

// AGENTS.md section 3 (direct writes) and section 4 (needs Rai). Fails closed: a path or operation the policy does not
// explicitly allow is refused, and a protected change is only ever a proposal. Rules:
//  - direct: Projects/ Tasks/ Areas/ Resources/ Memory/ Inbox/, now.md, Machines/orbit.md, Log/<year>/<date>-orbit.md;
//  - Journal/ is direct only for appending to a plan section of an existing note;
//  - protected (proposal card): other Journal/ changes, notes tagged #rai (before or after), a new sensitive category,
//    AGENTS.md, System/, .obsidian/, scripts/;
//  - refused outright: anything else, writing into Archive/ except by archive_note, and archiving anything not movable.
export function classify(applied: Applied): Verdict {
  const { edit } = applied;
  const reasons: string[] = [];

  if (edit.op === "archive_note") {
    const src = areaOf(edit.path);
    if (src.area === "archive") return { kind: "refused", reason: "Archive/ notes are already archived." };
    const movable = src.area === "journal" || (src.area === "direct" && MOVABLE.has(edit.path.split("/")[0]!));
    if (!movable) return { kind: "refused", reason: `${src.label} cannot be archived by ORBIT (only notes under Projects/, Tasks/, Areas/, Resources/, Memory/, Inbox/, and Journal/ with confirmation).` };
    if (src.area === "journal") reasons.push("moving a Journal/ note");
    if (isTaggedRai(applied.before)) reasons.push("note is tagged #rai");
    return reasons.length ? { kind: "protected", reasons } : { kind: "direct" };
  }

  const where = areaOf(edit.path);
  if (where.area === "archive") return { kind: "refused", reason: "Archive/ is written only by archive_note." };
  if (isOrbitLog(edit.path) && !isAppendOnly(applied.before, applied.after)) {
    return { kind: "refused", reason: `${edit.path} is ORBIT's audit log and is append-only: an edit may add lines after the existing text but never change, replace or remove what is there.` };
  }
  if (where.area === "outside") return { kind: "refused", reason: `${edit.path} is outside the areas ORBIT may write (Projects/, Tasks/, Areas/, Resources/, Memory/, Inbox/, now.md, Machines/orbit.md, its own Log/ file).` };
  const ext = where.area === "protected" ? CONFIG_EXT : TEXT_EXT;
  if (!ext.test(edit.path)) return { kind: "refused", reason: where.area === "protected" ? "Only text and config files can be edited here." : "Only .md notes can be edited." };

  if (where.area === "protected") reasons.push(`${where.label} is protected (AGENTS.md section 4)`);
  if (where.area === "journal") {
    const plan = edit.op === "append_section" && PLAN_HEADING.test(applied.heading ?? "");
    if (!plan) reasons.push("Journal/ beyond appending to a plan section");
  }
  if (isTaggedRai(applied.before) || isTaggedRai(applied.after)) reasons.push("note is tagged #rai");
  const cats = sensitiveCategories(applied.inserted.join("\n"), applied.before);
  if (cats.length) reasons.push(`possible new category of sensitive personal detail (${cats.join(", ")})`);
  return reasons.length ? { kind: "protected", reasons } : { kind: "direct" };
}

// The secret check. Redaction exists to hide secrets in output; for a vault write ORBIT refuses instead, so redacted text is
// never silently committed. Looks only at what the edit adds (an old note that already holds something odd does not block edits).
// It uses the vault filter (filter.ts): the same rules as the global masker, with the two prose-prone ones (credential assignment,
// long opaque run) judged by what the value looks like, so headings, note names, paths and wikilinks pass while real secrets do not.
export function secretFindings(texts: string[]): boolean {
  return texts.some(hasVaultFindings);
}

// The same check with where it fired: rule identifiers and a line number in the text that was checked, never the matched text.
export function secretFindingsDetail(texts: string[]): string {
  const parts: string[] = [];
  texts.forEach((t, i) => {
    const f: Finding[] = vaultFindings(t);
    if (f.length) parts.push(`${describeFindings(f)}${texts.length > 1 ? ` of text ${i + 1}` : ""}`);
  });
  return parts.join("; ");
}

// ---- confirmation digest ---------------------------------------------------------------------------------------------------------

export function canonical(edit: VaultEdit): string {
  const o = edit as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
}

// SHA-256 over the exact edit and the reasons shown to Rai. A confirmation names this digest, so what runs is what was shown.
export function digestOfEdit(edit: VaultEdit, reasons: string[]): string {
  return createHash("sha256").update(JSON.stringify({ edit: canonical(edit), reasons: [...reasons].sort() })).digest("hex");
}

// ---- what the confirmation card shows ---------------------------------------------------------------------------------------------

// The most the card can show of one edit. A protected edit whose complete text is longer than this is refused when it is
// proposed, never clipped: the digest covers the whole edit, so the card must show the whole edit.
export const CARD_MAX_CHARS = 24_000;

// Everything the digest covers, in full and labelled: path, operation, the reasons and every field of the edit. An edit with a
// field that is not rendered here would be approved unseen, so cardChange has a case for every operation and a test checks that
// each field of each operation appears in it.
export function cardChange(edit: VaultEdit): string {
  switch (edit.op) {
    case "create_note":
      return edit.content;
    case "append_section":
      return `heading: ${edit.heading}\nappend:\n${edit.text}`;
    case "replace_text":
      return `- ${edit.find}\n+ ${edit.replace}`;
    case "set_frontmatter":
      return `${edit.key}: ${JSON.stringify(edit.value)}`;
    case "archive_note":
      return `moves to ${archivePathOf(edit.path)}`;
    case "rewrite_body":
      return `body hash it expects: ${edit.expectBodySha}\nnew body:\n${edit.text}`;
  }
}

// The card for a protected edit: complete or not at all. Throws policy_refused when the complete change is longer than
// CARD_MAX_CHARS, or when the text would be altered by masking on its way to the page (a masked card would not show what runs).
export function cardDisplay(edit: VaultEdit, reasons: string[]): Record<string, string> {
  const change = cardChange(edit);
  if (change.length > CARD_MAX_CHARS) {
    throw new VaultError("policy_refused", `This protected change is ${change.length} characters, more than the ${CARD_MAX_CHARS} a confirmation card can show in full. ORBIT does not ask for approval of text Rai cannot see; split it into smaller edits. Nothing was written.`);
  }
  const display = { path: edit.path, operation: edit.op, why: reasons.join("; "), change };
  if (Object.values(display).some(hasVaultFindings)) {
    throw new VaultError("policy_refused", "This protected change contains text that would be masked on the confirmation card (it looks like a secret or credential), so the card could not show what would run. Nothing was written.");
  }
  return display;
}

export function summarize(edit: VaultEdit): string {
  switch (edit.op) {
    case "create_note":
      return `Create ${edit.path}`;
    case "append_section":
      return `Append to "${edit.heading}" in ${edit.path}`;
    case "replace_text":
      return `Replace a passage in ${edit.path}`;
    case "set_frontmatter":
      return `Set ${edit.key} in ${edit.path}`;
    case "archive_note":
      return `Move ${edit.path} to ${archivePathOf(edit.path)}`;
    case "rewrite_body":
      return `Rewrite the body of ${edit.path}`;
  }
}
