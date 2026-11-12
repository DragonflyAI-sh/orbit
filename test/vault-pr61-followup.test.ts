import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareContext } from "../src/job-context.ts";
import { VaultError, parseEdit, secretFindings, secretFindingsDetail, sensitiveCategories } from "../src/vault/edit.ts";
import { makeFixture } from "./vault-fixture.ts";
import { describeFindings, maskVaultText, vaultFindings } from "../src/vault/filter.ts";

// Follow-up to the PR #61 review. Everything is synthetic; values are assembled at run time from a seeded generator.
let seed = 0x51a7c3;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = (a: string, n: number): string => Array.from({ length: n }, () => a[Math.floor(rnd() * a.length)]).join("");
const MIXED = (): string => "Zq" + pick("abcdefghijklmnopqrstuvwxyz", 5) + pick("0123456789", 3) + "Kp";
const OPAQUE = (): string => pick("abcdefghijklmnopqrstuvwxyz0123456789", 14);
const SHORT = (): string => pick("abcdefghijklmnopqrstuvwxyz", 3) + pick("0123456789", 1);
const WORDS = ["correct horse battery staple", "orchid planet window ladder", "pencil river lantern ocean"];
const KEYS = ["password", "token", "secret", "secretkey", "api key"];

const flagged = (t: string): boolean => vaultFindings(t).some((f) => f.rule === "secret.credential-assignment");

// ---- Priority 1: function and technical words do not immunize the rest of the value -------------------------------------------------

test("P1: separator-form prose templates around a secret value are flagged for every strong key and value shape", () => {
  const values = [MIXED(), OPAQUE(), SHORT(), ...WORDS, "vault " + MIXED(), "the " + OPAQUE() + " of the vault"];
  const templates = [
    (k: string, v: string) => `${k}: it is ${v} for the vault`,
    (k: string, v: string) => `${k}: ${v} is the key for the service`,
    (k: string, v: string) => `${k}: the value of the prod ${k} is ${v}`,
    (k: string, v: string) => `${k} = the ${k} is ${v} and not in the file`,
    (k: string, v: string) => `**${k}:** it is ${v} for the vault`,
  ];
  for (const k of KEYS) for (const v of values) for (const t of templates) {
    const text = t(k, v);
    assert.equal(flagged(text), true, `${k} :: ${t.name || "tpl"} :: ${v.length}`);
    assert.ok(!maskVaultText(text).includes(v), `value must be masked (${k}, ${v.length} chars)`);
  }
});

test("P1: paired negatives: prose made only of known function/technical words stays exempt, one extra word does not", () => {
  for (const ok of [
    "**Credential:** an API key lives in the host's secret store, never in a note.",
    "token: the bearer token is stored in the vault and never in a note",
    "secret: kept in the host environment",
    "password: stored in the keychain of the host",
  ]) assert.equal(flagged(ok), false, ok);
  for (const k of KEYS) {
    const w = MIXED();
    assert.equal(flagged(`${k}: an API key lives in the host's secret store, never in a note ${w}`), true, "trailing value");
    assert.equal(flagged(`${k}: ${w} an API key lives in the host's secret store`), true, "leading value");
    assert.equal(flagged(`${k}: an API key lives in the host's ${OPAQUE()} store`), true, "embedded value");
    assert.equal(flagged(`${k}: an API key lives in the host's orchid store`), true, "an English word is not vocabulary");
  }
});

test("P1: the unsurprising paths agree: vaultFindings, masking, secretFindings, write-path detail and context export", async () => {
  const v = MIXED();
  const note = `# Setup\n\npassword: it is ${v} for the vault\nthe rest is plain.\n`;
  assert.deepEqual(vaultFindings(note), [{ rule: "secret.credential-assignment", line: 3 }]);
  const masked = maskVaultText(note);
  assert.ok(!masked.includes(v));
  assert.equal(masked.split("\n").length, note.split("\n").length);
  assert.equal(secretFindings([note]), true);
  const detail = secretFindingsDetail([note]);
  assert.match(detail, /secret\.credential-assignment at line 3/);
  assert.ok(!detail.includes(v));
  // the write path refuses (the edit would be a secret-bearing addition) and does not echo the value
  const fx = makeFixture();
  const clone = fx.make();
  const head = fx.remoteHead();
  for (const text of [`password: it is ${v} for the vault`, `password:\n\n  ${v}`]) {
    await assert.rejects(clone.write([parseEdit("append_section", { path: "Projects/alpha.md", heading: "## Notes", text })], { kind: "direct" }, { actor: "test" }), (e: unknown) => {
      assert.ok(e instanceof VaultError && e.code === "secret_refused");
      assert.match(e.message, /secret\.credential-assignment at line 1|secret\.credential-assignment at line 3/);
      assert.ok(!e.message.includes(v));
      return true;
    });
  }
  assert.equal(fx.remoteHead(), head, "nothing was written");
  // job-context export refuses without echoing the value
  const res = await prepareContext(["Tasks/x.md"], {
    reader: { snapshot: async () => ({ fresh: true, notes: new Map([["Tasks/x.md", { content: note }]]) }) },
    isPrivate: async () => true,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 422);
    assert.deepEqual(res.problems, [{ path: "Tasks/x.md", code: "secret_detected", findings: [{ rule: "secret.credential-assignment", line: 3 }] }]);
    assert.ok(!JSON.stringify(res).includes(v));
  }
});

test("P1: documented limits are pinned, not hidden: all-vocabulary sentences are prose, and no-separator forms are out of scope", () => {
  // A passphrase made only of function/technical words is indistinguishable from prose and is not flagged.
  assert.equal(flagged("secret: it is the key for the vault"), false);
  // No separator ("the password is X"), and the pwd alias, are outside this rule (documented in docs/content-filter.md).
  assert.equal(flagged(`the password is ${MIXED()}`), false);
  assert.equal(flagged(`pwd: ${MIXED()}`), false);
});

// ---- Secondary: indented values -----------------------------------------------------------------------------------------------------

test("indented value: masking keeps the newline and the indent, and the finding is on the value's line", () => {
  const v = MIXED();
  for (const [text, line] of [[`password:\n    ${v}\nafter`, 2], [`intro\n\ntoken:\n\t${v}\nafter`, 4], [`secret:\n  two words ${v}\nafter`, 2]] as [string, number][]) {
    assert.deepEqual(vaultFindings(text), [{ rule: "secret.credential-assignment", line }], text.length.toString());
    const m = maskVaultText(text);
    assert.ok(!m.includes(v));
    assert.equal(m.split("\n").length, text.split("\n").length, "line count kept");
    assert.match(m, /(?:password|token|secret):\n[ \t]+(?:\[redacted\]|two words \[redacted\]|[^\n]*)/);
    assert.ok(m.includes("\n    [redacted]") || m.includes("\n\t[redacted]") || m.includes("\n  [redacted]"), m);
    assert.ok(m.endsWith("\nafter"));
  }
});

test("indented value: bounded blank-line continuation; unindented text, headings and lists are never swallowed", () => {
  const v = MIXED();
  // up to two blank lines, then an indented value
  assert.equal(flagged(`password:\n\n  ${v}`), true);
  assert.equal(flagged(`password:\n\n\n  ${v}`), true);
  assert.deepEqual(vaultFindings(`password:\n\n\n  ${v}`), [{ rule: "secret.credential-assignment", line: 4 }]);
  assert.equal(flagged(`password:\n \t \n  ${v}`), true, "whitespace-only lines count as blank");
  // three blank lines end the continuation
  assert.equal(flagged(`password:\n\n\n\n  ${v}`), false);
  // an unindented paragraph, heading, list item or quote is never a value
  for (const after of [v, `# ${v}`, `- ${v}`, `  - ${v}`, `> ${v}`, `  # ${v}`, `  1. ${v}`]) {
    assert.equal(flagged(`password:\n\n${after.startsWith(" ") ? after : after}`), false, after.slice(0, 4));
  }
  // an unrelated paragraph two lines later is not swallowed
  assert.equal(flagged(`password:\n\nSome unrelated paragraph ${v} here.`), false);
  // a markdown heading takes no continuation across a blank line, even when the next line is indented
  assert.equal(flagged(`## Password:\n\n    ${v}`), false);
  assert.equal(flagged(`## Password:\n    ${v}`), true, "directly indented under the heading line is still judged (as before)");
  // an indented value that is plainly empty or a placeholder stays exempt
  assert.equal(flagged("password:\n\n  <your-password>"), false);
  assert.equal(flagged("password:\n\n  none"), false);
});

// ---- Secondary: health screen --------------------------------------------------------------------------------------------------------

test("health: named disclosures involving Crohn's (both apostrophes), lupus, MS, chemo, rehab ask for confirmation", () => {
  for (const t of [
    "Pat has Crohn's disease.", "Pat has Crohn’s disease.", "Sam has Crohns.", "Lee was diagnosed with lupus.", "Lee has lupus.",
    "Kim has multiple sclerosis.", "Kim was diagnosed with MS.", "Kim has MS.", "Ana started chemo last week.", "Ana had chemotherapy.", "Jo is in rehab.",
  ]) assert.deepEqual(sensitiveCategories(t, ""), ["health"], t);
  // already present in the note: not new
  assert.deepEqual(sensitiveCategories("Pat has Crohn's disease.", "Pat has Crohn's disease."), []);
});

test("health: technical prose with MS as milliseconds, MS Office or MS SQL is not matched", () => {
  for (const t of ["The request took 20 ms and the retry took 3 MS.", "MS Office build failed on the CI host.", "MS SQL server latency is 40 ms.", "Use ms resolution in the metrics.", "The scheduler stalled for 5 ms."])
    assert.deepEqual(sensitiveCategories(t, ""), [], t);
});

test("health: finite coverage is stated: unlisted conditions and bare acronyms are not caught; routing still goes through confirmation", () => {
  assert.deepEqual(sensitiveCategories("Pat has fibromyalgia.", ""), []);
  assert.deepEqual(sensitiveCategories("Pat has MS and sees a doctor.", ""), ["health"]);
  // describeFindings never carries values
  assert.ok(!describeFindings(vaultFindings(`password: it is ${MIXED()} for the vault`)).match(/Zq/));
});
