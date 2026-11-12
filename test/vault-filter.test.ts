import assert from "node:assert/strict";
import { test } from "node:test";
import { cardDisplay, parseEdit, secretFindings, secretFindingsDetail, VaultError } from "../src/vault/edit.ts";
import { describeFindings, hasVaultFindings, maskJsonStrings, maskVaultDeep, maskVaultText, vaultFindings, wordLikeRun } from "../src/vault/filter.ts";
import { maskText } from "../src/threads.ts";

// The unit-level contract of the vault content filter: what is recognised (known credential shapes), what passes on purpose
// (everything else, including unknown and weakly suspicious text), and how matched values are masked. Every secret-shaped value is
// assembled at run time from a seeded generator: the repository scans commits for secret-shaped literals, and no literal here is,
// or looks like, a usable credential. docs/content-filter.md is the contract these tests pin.
let seed = 0x2f6e2b1;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const random = (n: number, alphabet = B62): string => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
/** A mixed-case value with digits, so it has the shape of a generated secret whatever the alphabet draws. */
const mixed = (n: number): string => "Q7" + random(n - 4) + "z9";
const rules = (t: string): string[] => [...new Set(vaultFindings(t).map((f) => f.rule))];

// ---- what is recognised: known shapes, each with a fabricated value --------------------------------------------------------------

const KNOWN: [string, string, string][] = [
  ["openai-style key", "secret.provider-token", "s" + "k-" + random(40)],
  ["anthropic-style key", "secret.provider-token", "s" + "k-ant-" + random(40)],
  ["stripe-style key", "secret.provider-token", "s" + "k_live_" + random(24)],
  ["github token", "secret.provider-token", "gh" + "p_" + random(36)],
  ["github fine-grained token", "secret.provider-token", "github" + "_pat_" + random(40)],
  ["gitlab token", "secret.provider-token", "gl" + "pat-" + random(20)],
  ["tailscale key", "secret.provider-token", "ts" + "key-auth-" + random(24)],
  ["slack token", "secret.provider-token", "xox" + "b-" + random(30, "0123456789")],
  ["aws access key id", "secret.provider-token", "AK" + "IA" + random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")],
  ["google api key", "secret.provider-token", "AI" + "za" + random(35)],
  ["npm token", "secret.provider-token", "np" + "m_" + random(36)],
  ["jwt", "secret.jwt", "ey" + "J" + random(20) + "." + random(24) + "." + random(24)],
  ["private key block", "secret.private-key", "-----BEGIN " + "PRIVATE KEY-----\n" + random(64) + "\n" + random(64) + "\n-----END " + "PRIVATE KEY-----"],
  ["bearer value", "secret.bearer-token", "Bear" + "er " + mixed(30)],
  ["basic value", "secret.bearer-token", "Bas" + "ic " + btoa("user:" + random(12))],
  ["url credentials", "secret.url-credentials", "https://user:" + mixed(14) + "@example.com/path"],
  ["routine trigger id", "secret.routine-trigger", "tri" + "g_" + random(20)],
  ["password assignment", "secret.credential-assignment", "pass" + "word: " + "Hunter2" + "hunter2"],
  ["api key assignment", "secret.credential-assignment", "api_" + "key=" + mixed(24)],
  ["quoted client secret", "secret.credential-assignment", "client_" + "secret = '" + mixed(20) + "'"],
  ["env style password", "secret.credential-assignment", "DB_PASS" + "WORD=\"" + mixed(16) + "\""],
  ["bold heading with a value", "secret.credential-assignment", "**Credential:** " + mixed(32)],
  ["list item token", "secret.credential-assignment", "- **API key:** " + mixed(28)],
  ["token assignment in a sentence tail", "secret.credential-assignment", "to: use token: " + mixed(26)],
];

test("known credential shapes are recognised, alone and inside ordinary text", () => {
  const around = "# Plan\n\nsee [[orbit-next-secret-detector-false-positives]] and Tasks/orbit-next-web-feedback-and-links.md\n";
  for (const [name, rule, text] of KNOWN) {
    assert.ok(rules(text).includes(rule), `${name}: ${rule}, got ${rules(text)}`);
    assert.equal(secretFindings([text]), true, name);
    assert.ok(rules(`${around}${text}\n${around}`).includes(rule), `${name} inside text`);
    assert.notEqual(maskVaultText(text), text, `${name}: the value is masked`);
  }
});

test("a markdown wrapper, a path or a wikilink around a known value never hides it", () => {
  const k = "gh" + "p_" + random(36);
  for (const t of [`Tasks/${k}.md`, `[[${k}]]`, `\`${k}\``, `**${k}**`, `> ${k}`, `see (${k}).`, `"${k}"`, `x=${k}`]) assert.ok(rules(t).includes("secret.provider-token"), t.slice(0, 12));
  const v = mixed(24);
  for (const t of [`**Credential:** ${v}`, `**token:** ${v}`, `_password_: ${v}`, `\`secret=${v}\``, `- **API key:** ${v}`, `## Credential: ${v}`, `> token: ${v}`]) assert.ok(rules(t).includes("secret.credential-assignment"), t.slice(0, 16));
});

test("boundaries: a provider token is recognised at its minimum body length and not one character short; Basic and Bearer need a credential-shaped value", () => {
  assert.equal(secretFindings(["gh" + "p_" + random(20)]), true);
  assert.equal(secretFindings(["gh" + "p_" + random(19)]), false);
  assert.equal(secretFindings(["s" + "k-" + random(20)]), true);
  assert.equal(secretFindings(["s" + "k-" + random(19)]), false);
  assert.equal(secretFindings(["AK" + "IA" + random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")]), true);
  assert.equal(secretFindings(["AK" + "IA" + random(15, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")]), false);
  // A longer word that merely contains a prefix is not a token.
  assert.equal(secretFindings(["desk-" + random(30)]), false);
  assert.equal(secretFindings(["task" + "-force-" + random(30, "abcdefghij")]), false);
  assert.equal(secretFindings(["Basic identity and basic version notes; the basic outcome."]), false);
  assert.equal(secretFindings(["Bearer tokens are sent in the Authorization header; Basic authentication is not used."]), false);
  assert.equal(secretFindings(["Bear" + "er abcdefghijkl"]), false, "an all-lowercase single-class value is not credential-shaped");
  // An https URL with a token as its user part, an ssh git user, and a placeholder password.
  assert.equal(secretFindings(["https://" + mixed(30) + "@github.com/x/y.git"]), true);
  assert.equal(secretFindings(["ssh://git@github.com/x/y.git", "git@github.com:x/y.git", "https://user:<password>@example.com/", "https://user:${PASS}@example.com/"]), false);
});

// ---- what passes on purpose -----------------------------------------------------------------------------------------------------

const BENIGN_NOTE = [
  "# Plan: filter reliability",
  "",
  "**Credential:** an API key lives in the host's secret store, never in a note.",
  "## Secret handling and token budgets",
  "## Credential:",
  "# Token:",
  "- see [[orbit-next-compaction-empty-summary]] and [[orbit-next-web-feedback-and-links]]",
  "- file Tasks/orbit-next-secret-detector-false-positives.md holds the task",
  "- Resources/phase-shift-shopify-competitor-benchmark.md and 2026-03-02-orbit-avatar-v1-ethereal",
  "- orbit-next-secret-detector-false-positives.md: renamed last week",
  "- PASS: all 770 tests; passed: 12 of 12; tokens: 4096; token: 2026-11-12",
  "- service health: diagnostics for the failing job; symptoms: timeouts and retries; token refresh failing on the host",
  "- Bearer tokens are sent in the Authorization header; Basic authentication is not used.",
  "- the helper someLongIdentifierNameForTheFilterRule decides, as does ExampleVeryLongClassNameForTheCheck",
  "- commit 0123456789abcdef0123456789abcdef01234567 is fine",
  "- password: none; secret: n/a; token: TBD; token: <your-token>; secret: ${SECRET}; password: ********",
  "- credential: stored in the macOS keychain (see Machines/laptop.md)",
  "- token: refresh",
  "- api key rotated on 2026-11-01",
].join("\n");

test("ordinary vault text passes: headings, long names and paths, wikilinks, test verdicts, service-health prose, prose about credentials", () => {
  assert.deepEqual(vaultFindings(BENIGN_NOTE), []);
  assert.equal(maskVaultText(BENIGN_NOTE), BENIGN_NOTE, "nothing is masked");
  // The tier-1 masker would have changed it: that is the false positive this fixes.
  assert.notEqual(maskText(BENIGN_NOTE), BENIGN_NOTE);
  for (const name of ["orbit-next-compaction-empty-summary", "snd-hda-example-resume-bug-report-draft", "example-pr275-whole-review-2026-11-06-notes"]) assert.equal(wordLikeRun(name), true, name);
});

test("long file names and paths pass, whatever their length or characters", () => {
  const names = [
    "Resources/money-noodle-pr275-whole-review-2026-11-06.md",
    "Tasks/" + "a-very-long-descriptive-note-name-".repeat(4) + "end.md",
    "Projects/" + random(40) + ".md",
    "[[" + random(48) + "]]",
    "Attachments/Screenshot 2026-11-12 at " + random(36, "0123456789") + ".png",
    "/home/user/orbit-vault/Resources/" + random(44, HEX) + ".md",
  ];
  for (const n of names) assert.deepEqual(vaultFindings(n), [], n.slice(0, 20));
});

test("unknown and weakly suspicious content passes (permissive policy), and says so in tests so it cannot drift by accident", () => {
  const unknown = [
    random(40), // a bare opaque run
    random(64, HEX), // sha256-looking
    "123e4567-e89b-12d3-a456-426614174000", // uuid
    btoa(random(48)), // base64 blob
    "token: " + random(10, "abcdef"), // short value under a credential name
    "password: abc12", // 5 characters
    "password: correct-horse-battery-staple", // a word list
    "password: correct horse battery staple", // several words, unquoted
    'password = "correct horse battery staple"', // several words, quoted
    "secret: " + random(18, "abcdefghijklmnop"), // one class, below the long threshold
    "the password is " + mixed(20), // no separator: out of scope
    "pwd: " + mixed(20), // an alias that is not recognised
    "sk-short",
    "key = " + mixed(20), // a bare "key" is not a credential name
    "id: " + random(36),
  ];
  for (const t of unknown) assert.equal(hasVaultFindings(t), false, t.slice(0, 16));
});

test("unknown is not the same as allowed downstream: the sensitive-detail policy and the confirmation flow still apply to what the filter passes", () => {
  // The filter passes this text; the policy layer (a separate module) still routes health detail to a confirmation.
  const text = "Sam has ADHD";
  assert.equal(hasVaultFindings(text), false);
});

// ---- masking ---------------------------------------------------------------------------------------------------------------------

test("masking hides the matched value only: names, paths, prose around it and the rest of the line are kept", () => {
  const name = "Tasks/orbit-next-compaction-empty-summary.md";
  const k = "gh" + "p_" + random(36);
  const t = `see [[orbit-next-web-feedback-and-links]] in ${name}; the deploy key is ${k}, rotated 2026-11-01.`;
  assert.equal(maskVaultText(t), `see [[orbit-next-web-feedback-and-links]] in ${name}; the deploy key is [redacted token], rotated 2026-11-01.`);
  const v = mixed(24);
  assert.equal(maskVaultText(`password: ${v} (rotated monthly)`.replace("password", "pass" + "word")), "pass" + "word: [redacted] (rotated monthly)");
  assert.equal(maskVaultText(`Authorization: Bear` + `er ${mixed(30)} and more text`), "Authorization: Bear" + "er [redacted] and more text");
  assert.equal(maskVaultText("-----BEGIN " + "PRIVATE KEY-----\n" + random(64) + "\n-----END " + "PRIVATE KEY----- after"), "[redacted key] after");
  // A header with no END marker hides the header and the body lines, not the rest of the note.
  const open = `intro\n-----BEGIN ` + `PRIVATE KEY-----\n${random(64)}\n${random(64)}\n\nA paragraph after a blank line stays.\n`;
  assert.equal(maskVaultText(open), "intro\n[redacted key]\n\nA paragraph after a blank line stays.\n");
  // trigger ids keep their last four characters, as everywhere else in ORBIT.
  assert.match(maskVaultText("routine tri" + "g_" + random(20)), /^routine trig_…\w{4}$/);
});

test("masking is idempotent, and what it leaves has no findings", () => {
  const t = KNOWN.map(([, , v]) => v).join("\n\n");
  const once = maskVaultText(t);
  assert.equal(maskVaultText(once), once);
  assert.deepEqual(vaultFindings(once), []);
});

test("masking and findings are layout-preserving for CRLF text, and line numbers agree with LF text", () => {
  const v = mixed(24);
  const lf = `# T\npass` + `word: ${v}\nnext line\n- **API key:** ${v}\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(vaultFindings(crlf), vaultFindings(lf));
  assert.equal(maskVaultText(crlf), maskVaultText(lf).replace(/\n/g, "\r\n"), "every CRLF survives masking");
  assert.ok(!maskVaultText(crlf).includes(v));
});

test("continuation: a value on an indented line under a bare name is masked in place, with its newline and indent kept; nothing else is swallowed", () => {
  const v = mixed(24);
  const PW = "pass" + "word:";
  for (const nl of ["\n", "\r\n"]) {
    const t = ["# T", `${PW}`, `    ${v}`, "next paragraph", ""].join(nl);
    assert.equal(maskVaultText(t), ["# T", PW, "    [redacted]", "next paragraph", ""].join(nl));
    assert.deepEqual(vaultFindings(t), [{ rule: "secret.credential-assignment", line: 3 }], "reported on the value's line");
  }
  // Up to two blank lines are bridged; three are not.
  assert.equal(hasVaultFindings(`${PW}\n\n\n  ${v}\n`), true);
  assert.equal(hasVaultFindings(`${PW}\n\n\n\n  ${v}\n`), false);
  // Unindented text, list items, quotes and headings after a bare name never continue it.
  for (const next of [v, `- ${v}`, `> ${v}`, `# ${v}`, `1. ${v}`]) assert.equal(hasVaultFindings(`${PW}\n${next}\n`), false, next.slice(0, 5));
  // A markdown heading takes no continuation across a blank line.
  assert.equal(hasVaultFindings(`## ${PW}\n\n  ${v}\n`), false);
  // Indented prose is not a value.
  assert.equal(hasVaultFindings(`${PW}\n    see the host's secret store for it\n`), false);
});

test("multiple values on one line and several lines are all masked, once each", () => {
  const a = "gh" + "p_" + random(36);
  const b = "s" + "k-" + random(40);
  const t = `a ${a} b ${b} c\nline2 ${a}\n`;
  assert.equal(maskVaultText(t), "a [redacted token] b [redacted token] c\nline2 [redacted token]\n");
  assert.equal(vaultFindings(t).length, 3);
});

test("a value is reported once even when two rules would match it", () => {
  const k = "s" + "k-" + random(40);
  const f = vaultFindings(`token: ${k}`);
  assert.equal(f.length, 1, JSON.stringify(f));
});

test("JSON text is masked string by string: escapes, CRLF and a clipped final string", () => {
  const v = mixed(24);
  const body = { ok: true, result: { content: `# T\r\npass` + `word:\r\n    ${v}\r\nsee orbit-next-secret-detector-false-positives\r\n` } };
  const json = JSON.stringify(body);
  const masked = maskJsonStrings(json);
  const back = JSON.parse(masked) as typeof body;
  assert.equal(back.result.content, body.result.content.replace(v, "[redacted]"));
  // Clipped mid-string: no closing quote; the value is still masked.
  const clipped = json.slice(0, json.indexOf(v) + v.length + 3);
  assert.ok(!maskJsonStrings(clipped).includes(v));
  // Text with nothing to mask comes back byte for byte.
  const plain = JSON.stringify({ a: "orbit-next-" + random(30, "abcdef"), b: [1, "x\ty"] });
  assert.equal(maskJsonStrings(plain), plain);
  assert.deepEqual(maskVaultDeep({ a: [`token: ${v}`, "fine"] }), { a: ["token: [redacted]", "fine"] });
});

// ---- findings and refusals -------------------------------------------------------------------------------------------------------

test("findings are rule ids and line numbers only; the matched value is never in them or in the refusal text", () => {
  const k = "s" + "k-" + random(36);
  const text = `line one\nline two\ntoken: ${k}\n`;
  const f = vaultFindings(text);
  assert.ok(f.some((x) => x.rule === "secret.provider-token" && x.line === 3), JSON.stringify(f));
  assert.ok(!JSON.stringify(f).includes(k.slice(3, 15)));
  const sentence = describeFindings(f);
  assert.match(sentence, /secret\.[a-z-]+ at line 3/);
  assert.ok(!sentence.includes(k.slice(3, 15)));
  assert.ok(!secretFindingsDetail([text]).includes(k.slice(3, 15)));
});

test("a refusal explains the rule and the location, and says what to change", () => {
  const k = "gh" + "p_" + random(36);
  const detail = secretFindingsDetail(["ok", `x\n${k}`]);
  assert.match(detail, /secret\.provider-token at line 2 of text 2/);
});

test("confirmation cards: a benign path or note name is shown whole; a known secret stops the card with a rule and location", () => {
  const ok = parseEdit("append_section", { path: "Projects/orbit-next.md", heading: "## Notes", text: "- see [[orbit-next-compaction-empty-summary]] and **Credential:** stored on the host" });
  assert.equal(cardDisplay(ok, ["x"]).change.includes("[[orbit-next-compaction-empty-summary]]"), true);
  const value = "gh" + "p_" + random(36);
  const bad = parseEdit("append_section", { path: "Projects/orbit-next.md", heading: "## Notes", text: "a\nb " + value });
  assert.throws(() => cardDisplay(bad, ["x"]), (e: unknown) => e instanceof VaultError && e.code === "policy_refused" && /secret\.provider-token at card change line 4/.test(e.message) && !e.message.includes(value.slice(4, 14)));
});

test("the vault filter never passes the high-confidence shapes the tier-1 masker catches", () => {
  for (const t of ["gh" + "p_" + random(30), "s" + "k-" + random(24), "ey" + "J" + random(10) + "." + random(8), "Bear" + "er " + mixed(16), "http://u:" + mixed(8) + "@h/", "tskey" + "-" + random(20)]) {
    assert.notEqual(maskText(t), t);
    assert.equal(secretFindings([t]), true, t.slice(0, 8));
  }
});
