import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEdit, sensitiveCategories, VaultError } from "../src/vault/edit.ts";
import type { VaultEdit } from "../src/vault/edit.ts";
import { makeFixture } from "./vault-fixture.ts";

// Regression tests for the sensitive-personal-detail policy (src/vault/sensitive.ts; the health screen). Credential recognition is in
// vault-filter.test.ts and vault-filter-matrix.test.ts. Every fixture is synthetic.
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

test("health: ambiguous words (diagnosis, symptoms, prescribed, chronic, disorder) ask with a person frame and pass as technical prose", () => {
  // The old screen asked about every occurrence of these words; that flagged ordinary technical notes. They now ask only when the
  // sentence has a person frame (a pronoun, a name's possessive, a named person mid-sentence, a medical setting) and no technical cue.
  for (const w of ["diagnosis", "diagnoses", "symptom", "symptoms", "chronic", "disorder"]) {
    for (const t of [`his ${w}`, `my ${w} again`, `the ${w} for Alex is pending`, `Sam's ${w}`, `the doctor discussed the ${w}`]) assert.equal(health(t), true, t);
    for (const t of [`the build ${w} in CI`, `the ${w} output of the queue service`, `a ${w} in the log pipeline`]) assert.equal(health(t), false, t);
  }
  // Unambiguous condition, treatment and drug words still ask wherever they appear.
  for (const t of ["cancer", "therapy", "prescribed sertraline", "chronic pain", "diagnosed with something", "an anxiety disorder"]) assert.equal(health(t), true, t);
  for (const t of TECHNICAL) assert.equal(health(t), false, t);
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
