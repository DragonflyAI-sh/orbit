import assert from "node:assert/strict";
import { test } from "node:test";
import { cardDisplay, parseEdit, secretFindings, secretFindingsDetail, sensitiveCategories, VaultError } from "../src/vault/edit.ts";
import { describeFindings, maskVaultText, vaultFindings, wordLikeRun } from "../src/vault/filter.ts";
import { maskText } from "../src/threads.ts";

// Every fixture here is synthetic and built independently of any real note. Secret-shaped values are assembled at run time (the
// repository scans commits for secret-shaped literals) from a small seeded generator, so the tests are the same on every run.
let seed = 0x2f6e2b1;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const random = (n: number, alphabet = B62): string => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
const rules = (t: string): string[] => [...new Set(vaultFindings(t).map((f) => f.rule))];

const BENIGN_NOTE = [
  "# Plan: filter reliability",
  "",
  "**Credential:** an API key lives in the host's secret store, never in a note.",
  "## Secret handling and token budgets",
  "- see [[orbit-next-compaction-empty-summary]] and [[orbit-next-web-feedback-and-links]]",
  "- file Tasks/orbit-next-secret-detector-false-positives.md holds the task",
  "- Resources/phase-shift-shopify-competitor-benchmark.md and 2026-03-02-orbit-avatar-v1-ethereal",
  "- orbit-next-secret-detector-false-positives.md: renamed last week",
  "- PASS: all 770 tests; passed: 12 of 12; tokens: 4096; token: 2026-11-12",
  "- Bearer tokens are sent in the Authorization header; Basic authentication is not used.",
  "- the helper someLongIdentifierNameForTheFilterRule decides, as does ExampleVeryLongClassNameForTheCheck",
  "- Basic identity and basic version notes; the basic outcome.",
  "- commit 0123456789abcdef0123456789abcdef01234567 is fine",
  "- password: none; secret: n/a; token: TBD",
].join("\n");

test("benign vault text passes: headings, long kebab names, paths, wikilinks, test verdicts, prose about tokens", () => {
  assert.deepEqual(vaultFindings(BENIGN_NOTE), []);
  assert.equal(secretFindings([BENIGN_NOTE]), false);
  // The global masker would have changed it: that is the false positive this fixes.
  assert.notEqual(maskText(BENIGN_NOTE), BENIGN_NOTE);
  for (const name of ["orbit-next-compaction-empty-summary", "snd-hda-example-resume-bug-report-draft", "example-pr275-whole-review-2026-11-06-notes"]) assert.equal(wordLikeRun(name), true, name);
});

test("real secrets still fail: runtime-built provider keys, JWTs, opaque values, credential assignments", () => {
  const fakes = [
    "s" + "k-" + random(40),
    "gh" + "p_" + random(36, B62),
    "github" + "_pat_" + random(40),
    "xox" + "b-" + random(30, "0123456789abcdef"),
    "AK" + "IA" + random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
    "ey" + "J" + random(20) + "." + random(20) + "." + random(24),
    random(40),
    random(64, "0123456789abcdef"),
    "token: " + random(24),
    "api_key=" + random(20),
    "password: Hunter2hunter2",
    "client_secret = '" + random(18) + "'",
    "Authorization: Bear" + "er " + random(30),
    "https://user:" + random(12) + "@example.com/path",
    "-----BEGIN " + "PRIVATE KEY-----\n" + random(30) + "\n-----END " + "PRIVATE KEY-----",
    "routine tri" + "g_" + random(20),
  ];
  for (const f of fakes) assert.equal(secretFindings([f]), true, f.slice(0, 12));
  assert.equal(secretFindings(["Basic " + random(24)]), true);
  assert.equal(secretFindings(["Bear" + "er abcdefghijkl"]), true, "a lowercase bearer value is not assumed to be prose");
  // Also with the benign note around them.
  for (const f of fakes) assert.equal(secretFindings([`${BENIGN_NOTE}\n${f}\n`]), true, f.slice(0, 12));
});

test("a path, a wikilink or a markdown wrapper never makes a secret safe", () => {
  const k = random(40);
  const shaped = [`Tasks/${k}.md`, `[[${k}]]`, `\`${k}\``, `**${k}**`, `> ${k}`, `Projects/orbit-next-${k}.md`, `[[orbit-next-web-feedback-and-links-${k}]]`];
  for (const t of shaped) assert.equal(secretFindings([t]), true, t.slice(0, 14));
  const v = random(16);
  for (const t of [`**Credential:** ${v}`, `**token:** ${v}`, `_password_: ${v}`, `\`secret=${v}\``, `- **API key:** ${v}`, `## Credential: ${v}`]) assert.equal(secretFindings([t]), true, t.slice(0, 16));
  // A kebab-looking value without vowels, or with digits mixed in, is not a note name.
  for (const run of [random(8, "bcdfghjklmnpqrstvwxz") + "-" + random(8, "bcdfghjklmnpqrstvwxz") + "-" + random(8, "bcdfghjklmnpqrstvwxz") + "-" + random(8, "bcdfghjklmnpqrstvwxz"), "a1b2c3d4-e5f6a7b8-c9d0e1f2-a3b4c5d6-e7f8", "123e4567-e89b-12d3-a456-426614174000"]) assert.equal(wordLikeRun(run), false, run.slice(0, 10));
  // Short passwords under a password-like name, and a bare "pass" with a generated-looking value.
  assert.equal(secretFindings(["password=hunter"]), true);
  assert.equal(secretFindings(["pass=" + "Ab3" + random(9)]), true);
});

test("findings are rule ids and line numbers only; the matched value is never in them or in the refusal text", () => {
  const k = "s" + "k-" + random(36);
  const text = `line one\nline two\ntoken: ${k}\n`;
  const f = vaultFindings(text);
  assert.ok(f.some((x) => x.rule === "secret.credential-assignment" && x.line === 3));
  assert.ok(f.some((x) => x.rule === "secret.provider-token" && x.line === 3));
  assert.ok(!JSON.stringify(f).includes(k.slice(3, 15)));
  const sentence = describeFindings(f);
  assert.match(sentence, /secret\.[a-z-]+ at line 3/);
  assert.ok(!sentence.includes(k.slice(3, 15)));
  assert.ok(!secretFindingsDetail([text]).includes(k.slice(3, 15)));
});

test("masking for vault display keeps note names and paths and still masks secrets", () => {
  const name = "Tasks/orbit-next-compaction-empty-summary.md";
  assert.equal(maskVaultText(`see [[orbit-next-web-feedback-and-links]] in ${name}`), `see [[orbit-next-web-feedback-and-links]] in ${name}`);
  assert.ok(maskText(name).includes("[redacted]"), "the global masker is unchanged");
  const k = random(40);
  const masked = maskVaultText(`${name} ${k} token: ${random(20)}\ntrig_${random(12)}`); // an unquoted value runs to the end of its line, so the id is on its own line
  assert.ok(masked.includes(name) && !masked.includes(k) && masked.includes("[redacted]") && /trig_…/.test(masked));
  assert.equal(maskVaultText(`Tasks/${k}.md`).includes(k), false);
});

test("the vault filter never passes what the global masker would catch in the high-confidence rules", () => {
  // The two refined rules are the only ones that may differ from redact(); every other rule is the same pattern.
  for (const t of ["gh" + "p_" + random(30), "s" + "k-" + random(20), "ey" + "J" + random(10) + "." + random(8), "Bear" + "er " + random(12), "http://u:" + random(8) + "@h/", "tskey" + "-" + random(20)]) {
    assert.notEqual(maskText(t), t);
    assert.equal(secretFindings([t]), true, t.slice(0, 8));
  }
});

test("health: technical planning text is not flagged, real sensitive details still are", () => {
  const benign = [
    "diagnostics for the failing job; diagnosis: the queue stalled; we diagnosed the cause",
    "symptoms: timeouts and retries; the symptom is a stale lock",
    "chronic failures in CI; a disorder of event ordering; prescribed format for the log line",
    "health check endpoint and system health dashboard",
  ];
  for (const t of benign) assert.deepEqual(sensitiveCategories(t, ""), [], t);
  const real = [
    "she was diagnosed with a condition last year",
    "my symptoms got worse this week",
    "his chronic pain flares up",
    "an anxiety disorder runs in the family",
    "the doctor prescribed antibiotics",
    "prescription refills on Friday",
    "mental health day",
    "my diagnosis came back",
    "surgery scheduled for May",
  ];
  for (const t of real) assert.deepEqual(sensitiveCategories(t, ""), ["health"], t);
  // Other categories are untouched, and a category already in the note is still not "new".
  assert.deepEqual(sensitiveCategories("her passport number", ""), ["identity documents"]);
  assert.deepEqual(sensitiveCategories("my symptoms again", "earlier: my symptoms"), []);
});

test("confirmation cards: a benign path or note name is shown whole; a secret still stops the card", () => {
  const ok = parseEdit("append_section", { path: "Projects/orbit-next.md", heading: "## Notes", text: "- see [[orbit-next-compaction-empty-summary]] and **Credential:** stored on the host" });
  assert.equal(cardDisplay(ok, ["x"]).change.includes("[[orbit-next-compaction-empty-summary]]"), true);
  const bad = parseEdit("append_section", { path: "Projects/orbit-next.md", heading: "## Notes", text: "token: " + random(24) });
  assert.throws(() => cardDisplay(bad, ["x"]), (e: unknown) => e instanceof VaultError && e.code === "policy_refused" && !/token: /.test(e.message));
});
