// Privacy-preserving corpus validation for the vault content filter (docs/content-filter.md, "Corpus validation").
//
//   node tools/vault-filter-corpus/corpus.ts <vault-checkout> [--baseline <old-filter.ts>] [--json]
//
// Runs the filter over every .md note of an authorized, local vault checkout, and over any extra text files named with --extra
// (for example saved job logs or PR text). With --baseline it runs the same corpus through an older copy of filter.ts and
// prints the old/new comparison. It prints ONLY aggregates: corpus size and revision, per-rule counts of notes and findings,
// and a shape histogram of what was masked (length bucket, character classes, kind of line). It never prints a matched value,
// a note name, a path, or a line of text. Nothing is written anywhere. The vault is opened read-only.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fabricated, ordinary } from "./fabricated.ts";

type Filter = { vaultFindings(t: string): { rule: string; line: number }[]; maskVaultText(t: string): string };

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const many = (n: string): string[] => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]!] : []));
const root = args.find((a, i) => !a.startsWith("--") && !["--baseline", "--extra"].includes(args[i - 1] ?? ""));
if (!root) {
  console.error("usage: node tools/vault-filter-corpus/corpus.ts <vault-checkout> [--baseline <old-filter.ts>] [--extra <file>]... [--json]");
  process.exit(2);
}

function* walk(dir: string, top = true): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, false);
    else if (e.isFile() && e.name.endsWith(".md")) yield p;
  }
  void top;
}

const bucket = (n: number): string => (n < 8 ? "<8" : n < 16 ? "8-15" : n < 32 ? "16-31" : n < 64 ? "32-63" : n < 128 ? "64-127" : "128+");
const classes = (s: string): string => [/[a-z]/.test(s) && "lower", /[A-Z]/.test(s) && "upper", /\d/.test(s) && "digit", /[^A-Za-z0-9\s]/.test(s) && "symbol"].filter(Boolean).join("+") || "none";

// What changed between the original text and the masked text, as value-free shapes. The changed spans are located by trimming the
// common prefix and suffix of each line; only length bucket, character classes and word count leave this function.
function shapes(original: string, masked: string): string[] {
  const a = original.split("\n");
  const b = masked.split("\n");
  const out: string[] = [];
  if (a.length !== b.length) {
    out.push("layout-changed");
    return out;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    let s = 0;
    while (s < a[i]!.length && a[i]![s] === b[i]![s]) s++;
    let e = 0;
    while (e < a[i]!.length - s && e < b[i]!.length - s && a[i]![a[i]!.length - 1 - e] === b[i]![b[i]!.length - 1 - e]) e++;
    const span = a[i]!.slice(s, a[i]!.length - e);
    const kind = /^\s*#{1,6}\s/.test(a[i]!) ? "heading" : /^\s*\|/.test(a[i]!) ? "table" : /^\s*[-*+]\s/.test(a[i]!) ? "list" : "text";
    out.push(`${kind}|len ${bucket(span.length)}|${classes(span)}|words ${Math.min(span.trim().split(/\s+/).length, 6)}`);
  }
  return out;
}

async function load(path: string): Promise<Filter> {
  return (await import(pathToFileURL(resolve(path)).href)) as Filter;
}

type Tally = { notes: number; findings: number; byRule: Record<string, { notes: number; findings: number }>; shapes: Record<string, number>; maskedBytes: number };
const tally = (): Tally => ({ notes: 0, findings: 0, byRule: {}, shapes: {}, maskedBytes: 0 });

function run(f: Filter, texts: string[]): { t: Tally; perNote: string[][] } {
  const t = tally();
  const perNote: string[][] = [];
  for (const text of texts) {
    const found = f.vaultFindings(text);
    perNote.push([...new Set(found.map((x) => x.rule))].sort());
    if (!found.length) continue;
    t.notes++;
    t.findings += found.length;
    const seen = new Set<string>();
    for (const x of found) {
      const r = (t.byRule[x.rule] ??= { notes: 0, findings: 0 });
      r.findings++;
      if (!seen.has(x.rule)) {
        seen.add(x.rule);
        r.notes++;
      }
    }
    const masked = f.maskVaultText(text);
    for (const s of shapes(text, masked)) t.shapes[s] = (t.shapes[s] ?? 0) + 1;
    for (const [i, line] of text.split("\n").entries()) if (line !== masked.split("\n")[i]) t.maskedBytes += line.length;
  }
  return { t, perNote };
}

const files = [...walk(resolve(root!))].sort();
const texts = [...files, ...many("--extra")].map((p) => readFileSync(p, "utf8"));
let head = "unknown";
try {
  head = execFileSync("git", ["-C", resolve(root!), "rev-parse", "--short=12", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
const bytes = texts.reduce((n, t) => n + Buffer.byteLength(t), 0);
const crlf = texts.filter((t) => t.includes("\r\n")).length;

const current = await load(new URL("../../src/vault/filter.ts", import.meta.url).pathname);
const now = run(current, texts);
const base = flag("--baseline") ? run(await load(flag("--baseline")!), texts) : undefined;

// Notes whose set of firing rules changed between old and new (counts only).
let fixed = 0;
let added = 0;
if (base) {
  for (let i = 0; i < texts.length; i++) {
    const o = base.perNote[i]!;
    const n = now.perNote[i]!;
    if (o.length && !n.length) fixed++;
    if (!o.length && n.length) added++;
  }
}

// Fabricated blocked cases (recall) and ordinary texts (precision), per rule, current and baseline. Run-time generated, never real.
function synthetic(f: Filter): { blocked: Record<string, { hit: number; total: number }>; ordinaryFlagged: number; ordinaryTotal: number } {
  const blocked: Record<string, { hit: number; total: number }> = {};
  for (const c of fabricated()) {
    const b = (blocked[c.rule] ??= { hit: 0, total: 0 });
    b.total++;
    const found = f.vaultFindings(c.text);
    const masked = f.maskVaultText(c.text);
    if (found.some((x) => x.rule === c.rule) && masked !== c.text) b.hit++;
  }
  const o = ordinary();
  return { blocked, ordinaryFlagged: o.filter((c) => f.vaultFindings(c.text).length).length, ordinaryTotal: o.length };
}
const synNow = synthetic(current);
const synBase = base ? synthetic(await load(flag("--baseline")!)) : undefined;

const report = {
  synthetic: { current: synNow, ...(synBase ? { baseline: synBase } : {}) },
  corpus: { vaultRevision: head, notes: files.length, extraTexts: many("--extra").length, bytes, notesWithCrlf: crlf, sparse: existsSync(join(resolve(root!), ".git")) ? "see vault checkout (sparse clones lack some folders)" : "not a git checkout" },
  current: now.t,
  ...(base ? { baseline: base.t, comparison: { notesClearedByNew: fixed, notesNewlyFlagged: added } } : {}),
};
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  const row = (label: string, t: Tally) => {
    console.log(`${label}: ${t.notes} of ${texts.length} texts flagged, ${t.findings} findings, ${t.maskedBytes} characters would be masked`);
    for (const [r, v] of Object.entries(t.byRule).sort()) console.log(`  ${r}: ${v.notes} texts, ${v.findings} findings`);
    for (const [s, n] of Object.entries(t.shapes).sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`  shape ${s}: ${n}`);
  };
  console.log(`corpus: vault revision ${head}, ${files.length} notes + ${many("--extra").length} extra texts, ${bytes} bytes, ${crlf} with CRLF`);
  if (base) row("baseline", base.t);
  row("current", now.t);
  const synRow = (label: string, v: ReturnType<typeof synthetic>) => {
    console.log(`fabricated blocked cases, ${label}: ${Object.entries(v.blocked).sort().map(([r, x]) => `${r} ${x.hit}/${x.total}`).join(", ")}; ordinary texts wrongly flagged ${v.ordinaryFlagged}/${v.ordinaryTotal}`);
  };
  if (synBase) synRow("baseline", synBase);
  synRow("current", synNow);
  if (base) console.log(`comparison: ${fixed} texts flagged by the baseline are clean now, ${added} texts are newly flagged`);
}
