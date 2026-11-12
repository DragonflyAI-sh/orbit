import assert from "node:assert/strict";
import { test } from "node:test";
import { cardDisplay, parseEdit, secretFindings, sensitiveCategories, VaultError } from "../src/vault/edit.ts";
import type { VaultEdit } from "../src/vault/edit.ts";
import { hasVaultFindings, maskVaultText, vaultFindings, wordLikeRun } from "../src/vault/filter.ts";
import { maskText } from "../src/threads.ts";
import { makeFixture } from "./vault-fixture.ts";

// Regression tests for the two privacy/secret-screen regressions found in review of the vault content filter. Every fixture is
// synthetic. Secret-shaped values and "name: value" credential pairs are assembled at run time from a seeded generator (the
// repository scans commits for secret-shaped literals), so nothing here is, or looks like, a real credential or a real disclosure.
let seed = 0x51f3a77;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const random = (n: number, alphabet = LOWER + "0123456789"): string => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
const word = (): string => random(5 + Math.floor(rnd() * 4), LOWER);
const E = (op: string, a: Record<string, unknown>): VaultEdit => parseEdit(op, a);
const direct = { kind: "direct" } as const;
const meta = { actor: "test" };

// ---- 1. health screen --------------------------------------------------------------------------------------------------------------

// The screen as it was before the narrowing (the pattern the first review compared against).
const OLD_HEALTH = /\b(diagnos\w*|prescri\w+|medicat\w+|therap(y|ist)\w*|psychiatr\w+|depress(ed|ion)|anxiety|disorder|surgery|cancer|hiv|pregnan\w+|chronic|illness|symptom\w*|blood pressure|mental health)\b/i;
const health = (t: string): boolean => sensitiveCategories(t, "").includes("health");

test("health: named third-party disclosures are classified, not only pronoun constructions", () => {
  const disclosures = [
    "Sam's diagnosis: diabetes",
    "Jo was prescribed sertraline",
    "Sam has ADHD",
    "Jo is bipolar",
    "Pat has a heart condition",
    // possessives, named people, passives, drugs and conditions
    "Pat’s diagnosis came back", "the diagnosis for Alex is pending", "Alex's symptoms returned", "Kim was diagnosed last spring",
    "Lee takes metformin daily", "Robin started lithium", "Dana: chronic migraines", "Morgan has an anxiety disorder",
    "Sam's prescription was renewed", "Jo struggles with a sleep disorder", "Casey has epilepsy", "Taylor is on insulin",
    // case and punctuation
    "SAM'S DIAGNOSIS: DIABETES", "jo was PRESCRIBED sertraline.", "sam has adhd!", "(Pat) diagnosis—cancer", "Sam's\tdiagnosis",
    "Jordan's chronic condition", "Avery's disorder", "Riley's symptoms: fatigue and nausea",
  ];
  for (const t of disclosures) assert.equal(health(t), true, t);
});

test("health: every old condition-bearing word is still asked about unless the sentence is demonstrably technical", () => {
  // Each word in a non-technical sentence: old screen flagged it, the new one must too.
  const sentences = [
    "diagnosis", "diagnosed", "diagnoses", "diagnostic", "prescribed", "prescribing", "prescription", "symptom", "symptoms", "chronic", "disorder",
  ].flatMap((w) => [`Sam: ${w}`, `${w} for Jo`, `Pat mentioned the ${w} again`, `his ${w}`, `${w.toUpperCase()}, per Alex`]);
  for (const t of sentences) {
    assert.equal(OLD_HEALTH.test(t), true, `old screen: ${t}`);
    assert.equal(health(t), true, `new screen: ${t}`);
  }
  // No sentence the old screen flagged for these words is waved through unless it is on the explicit technical list below.
  for (const t of TECHNICAL) assert.equal(OLD_HEALTH.test(t), true, `the old screen asked about: ${t}`);
});

const TECHNICAL = [
  "service health diagnostics",
  "diagnostics for the failing job; diagnosis: the queue stalled; we diagnosed the cause",
  "symptoms: timeouts and retries; the symptom is a stale lock",
  "chronic failures in CI; a disorder of event ordering; prescribed format for the log line",
  "run diagnostics on the server and check the system logs",
];

test("health: unambiguously technical prose is still not flagged", () => {
  for (const t of [...TECHNICAL, "health check endpoint and system health dashboard", "the build has a race condition in the cache"]) assert.equal(health(t), false, t);
});

test("health: a technical cue does not launder a personal one in the same sentence", () => {
  for (const t of [
    "The server diagnostics passed and Sam's diagnosis is in the doctor's note",
    "service logs are fine; my symptoms are not",
    "the build failed and Jo was prescribed sertraline",
    "the queue stalled. Sam was diagnosed with something",
  ]) assert.equal(health(t), true, t);
});

test("health: an unambiguous term already in the note is not 'new' (unchanged behavior)", () => {
  assert.deepEqual(sensitiveCategories("Sam has ADHD", "Sam has ADHD"), []);
});

test("health approval routing: real writes of disclosures need confirmation, technical prose is written directly", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const append = (text: string) => E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text });
  const before = fx.remoteHead();
  for (const text of ["- Sam's diagnosis: diabetes", "- Jo was prescribed sertraline", "- Sam has ADHD", "- Jo is bipolar", "- Pat has a heart condition", "- SAM'S DIAGNOSIS: DIABETES"]) {
    const err = await clone.write([append(text)], direct, meta).catch((e) => e as VaultError);
    assert.ok(err instanceof VaultError, text);
    assert.equal(err.code, "needs_confirmation", text);
    assert.match(JSON.stringify(err.details), /sensitive personal detail \(health\)/, text);
    assert.equal(fx.remoteHead(), before, "nothing was written");
  }
  // Confirmed with exactly the reasons shown: runs. Confirmed with other reasons: refused.
  const edit = append("- Sam's diagnosis: diabetes");
  const reasons = ((await clone.write([edit], direct, meta).catch((e) => e)) as VaultError).details;
  await assert.rejects(clone.write([edit], { kind: "confirmed", reasons: ["something else"] }, meta), (e: unknown) => e instanceof VaultError && e.code === "policy_refused");
  assert.equal((await clone.write([edit], { kind: "confirmed", reasons }, meta)).status, "committed");
  // Technical prose goes straight through.
  const ok = await clone.write([append("- service health diagnostics: the queue stalled; we diagnosed the cause")], direct, meta);
  assert.equal(ok.status, "committed");
});

// ---- 2. credential assignments judged on the whole value ------------------------------------------------------------------------------

const PW = "pass" + "word";
const STRONG_KEYS = ["secret", "token", "secretkey", "api key", "api_key", "api-key", PW, "client_" + "secret", "access_token"];
const flagged = (t: string): boolean => hasVaultFindings(t);
const assignmentOnly = (t: string): boolean => vaultFindings(t).some((f) => f.rule === "secret.credential-assignment");

test("secret assignments: quoted multiword values are judged as a whole, whatever the first word is", () => {
  for (const key of STRONG_KEYS) {
    for (const q of ['"', "'"]) {
      const first = ["a", "my", "to", "is", "ok", "the"][Math.floor(rnd() * 6)]!;
      const v = `${first} ${word()} ${word()} ${word()}`;
      for (const sep of [": ", "=", " = ", ":"]) assert.equal(assignmentOnly(`${key}${sep}${q}${v}${q}`), true, `${key}${sep}${q}…`);
    }
  }
  // JSON, markdown wrapper, escaped quotes and an unclosed quote.
  const v = `${word()} ${word()} ${word()}`;
  assert.equal(assignmentOnly(`{"${PW}": "a ${v}"}`), true);
  assert.equal(assignmentOnly(`**${PW}:** "to ${v}"`), true);
  assert.equal(assignmentOnly(`${PW}: "ab\\" ${v}"`), true, "an escaped quote does not end the value early");
  assert.equal(assignmentOnly(`${PW}: "a ${v}`), true, "an unclosed quote runs to the end of the line");
  assert.equal(assignmentOnly(`${PW}: 'a ${v}\n`), true);
  // A semicolon or a pipe inside a quoted value does not cut it short.
  assert.equal(assignmentOnly(`token: "a;${word()}|${word()}"`), true);
});

test("secret assignments: unquoted multiword values and multi-word api keys are flagged", () => {
  for (const key of STRONG_KEYS) {
    const v = `${word()} ${word()} ${word()} ${word()}`;
    assert.equal(assignmentOnly(`${key}: ${v}`), true, key);
    assert.equal(assignmentOnly(`- **${key}:** ${v}`), true, key);
    assert.equal(assignmentOnly(`${key} = ${word()}-${word()} ${word()}`), true, key);
  }
  // A short first word does not hide the rest.
  assert.equal(assignmentOnly(`${PW}: my ${word()} ${word()}`), true);
  assert.equal(assignmentOnly(`api key: ${random(5)} ${random(6)} ${random(5)}`), true);
});

test("secret assignments: 4-7 character values under strong keys, which the old global rule caught, are flagged", () => {
  for (const key of ["secret", "token", "secretkey", "api key", PW]) {
    for (const n of [4, 5, 6, 7]) {
      const v = random(n, LOWER);
      const t = `${key}: ${v}`;
      if (key !== "api key") assert.notEqual(maskText(t), t, `the old rule caught ${key} ${n}`); // (the global masker never matched a spaced "api key")
      assert.equal(assignmentOnly(t), true, `${key} with a ${n}-character value`);
      assert.equal(assignmentOnly(`${key}=${random(n)}`), true);
    }
  }
});

test("secret assignments: findings and masks never carry the value; the whole value is masked", () => {
  const value = `${word()} ${word()} ${word()}`;
  const t = `intro\n${PW}: "a ${value}" and more\nnext line`;
  const f = vaultFindings(t);
  assert.deepEqual(f, [{ rule: "secret.credential-assignment", line: 2 }]);
  assert.ok(!JSON.stringify(f).includes(value.split(" ")[0]!));
  const masked = maskVaultText(t);
  for (const w of value.split(" ")) assert.ok(!masked.includes(w), "a word of the value survived masking");
  assert.ok(masked.includes("[redacted]") && masked.includes("and more") && masked.includes("next line"));
  const multi = `${PW}: ${value}`;
  for (const w of value.split(" ")) assert.ok(!maskVaultText(multi).includes(w));
  // A second assignment on the same line is still seen.
  assert.equal(vaultFindings(`status: fine; token: ${random(12)}`).length, 1);
});

test("secret assignments: legitimate empty headings, technical descriptions and placeholders still pass", () => {
  const benign = [
    "## Credential:", "# Token", "**Secret:**", "### Password:\n\n- note one", "## API key:\n\nSome notes about rotation.", "## Credential:\n  - item",
    "**Credential:** an API key lives in the host's secret store, never in a note.",
    "token: the bearer token is stored in the vault and never in a note",
    "secret: kept in the host environment; password: none; api key: n/a",
    "token: <your-token>", "api key: ${API_KEY}", "secret: {{secret}}", "password: ********", "token: xxxxxxxx", "api_key=[redacted]",
    "tokens: 4096", "token: 2026-11-12", "token: v1.2.3", "secret: tbd", "password: required", "secret: optional",
    "- PASS: all 770 tests; passed: 12 of 12",
  ];
  for (const t of benign) assert.equal(flagged(t), false, t + " :: " + JSON.stringify(vaultFindings(t)));
});

test("secret assignments: only plain placeholders are exempt; brackets around a value do not hide it", () => {
  for (const v of [`<${random(8)}1>`, `<${word()} ${word()}>`, `{{${random(8)} ${word()}}}`, `<${word()}${random(3, "0123456789")}>`]) assert.equal(assignmentOnly(`${PW}: ${v}`), true, v.slice(0, 3));
});

test("secret assignments: stop words only exempt a whole value, and are not weak passwords' cover", () => {
  assert.equal(assignmentOnly(`${PW}: none ${word()} ${word()}`), true, "a stop word first does not exempt the rest");
  assert.equal(assignmentOnly(`secret: n/a ${word()}`), true);
  for (const weak of ["pass", "true", "false", "yes"]) assert.equal(assignmentOnly(`${PW}: ${weak}`), true, weak);
  assert.equal(assignmentOnly(`${PW}: "none ${word()}"`), true);
  assert.equal(assignmentOnly(`token: none`), false);
});

test("secret assignments: an indented value under a bare name is judged; a bare heading is not", () => {
  assert.equal(assignmentOnly(`${PW}:\n  ${word()} ${word()} ${word()}`), true);
  assert.equal(assignmentOnly(`token:\n    ${random(14)}`), true);
  assert.equal(assignmentOnly(`## Token:\n\n${random(14)}`), false, "a blank line ends the heading");
  assert.equal(assignmentOnly(`## Token:\n- ${random(14)}`), false);
  assert.ok(!maskVaultText(`token:\n    ${"zq" + random(12)}`).includes("zq"));
});

test("secret assignments: tier-1 style rules are unchanged (provider keys, private keys, URL credentials, JWTs, bearer values)", () => {
  const fakes = ["s" + "k-" + random(40), "gh" + "p_" + random(36), "ey" + "J" + random(20) + "." + random(20), "https://u:" + random(10) + "@h.example/", "Bear" + "er " + random(24), "-----BEGIN " + "PRIVATE KEY-----\n" + random(30)];
  for (const f of fakes) assert.equal(flagged(f), true, f.slice(0, 8));
});

test("secret write and context paths refuse multiword values without echoing them", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const value = `a ${word()} ${word()} ${word()}`;
  const before = fx.remoteHead();
  for (const text of [`${PW}: "${value}"`, `api key: ${word()} ${word()} ${word()}`, `${PW}: ${random(6)}`, `secretkey=${random(7)}`]) {
    await assert.rejects(clone.write([E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text })], direct, meta), (e: unknown) => {
      assert.ok(e instanceof VaultError && e.code === "secret_refused");
      assert.match(e.message, /secret\.credential-assignment at line 1/);
      for (const w of text.split(/[\s:="]+/).slice(1)) if (w.length > 4) assert.ok(!e.message.includes(w), "value echoed");
      return true;
    });
  }
  assert.equal(fx.remoteHead(), before);
  // Confirmation cards: a multiword secret stops the card and is not shown.
  const bad = parseEdit("append_section", { path: "Projects/orbit-next.md", heading: "## Notes", text: `${PW}: "${value}"` });
  assert.throws(() => cardDisplay(bad, ["x"]), (e: unknown) => e instanceof VaultError && e.code === "policy_refused" && !e.message.includes(value.split(" ")[1]!));
});

// ---- 3. stated limitations of the long-opaque exemption --------------------------------------------------------------------------------

test("known limitation: long English-like runs outside an assignment are exempt, and an assignment is still screened", () => {
  const repeated = "a".repeat(33);
  const diceware = ["tavern", "glimmer", "orchard", "paddle", "quiver", "lantern"].join("-");
  // Documented exemption (docs/content-filter.md): not flagged by the long-opaque rule on its own. This pins the limit; it is not a promise.
  assert.equal(wordLikeRun(repeated), true);
  assert.equal(wordLikeRun(diceware), true);
  assert.equal(flagged(repeated), false);
  assert.equal(flagged(`see ${diceware}`), false);
  // Credential-bearing assignments are screened regardless of the exemption.
  for (const key of ["secret", PW, "api key"]) {
    assert.equal(assignmentOnly(`${key}: ${repeated}`), true, key);
    assert.equal(assignmentOnly(`${key}: ${diceware}`), true, key);
    assert.equal(assignmentOnly(`${key} = "${diceware.replaceAll("-", " ")}"`), true, key);
  }
  // A random run of the same length is still flagged.
  assert.equal(flagged(random(33)), true);
});
