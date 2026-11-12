import assert from "node:assert/strict";
import { test } from "node:test";
import { runChat, type ChatTool } from "../src/agent.ts";
import { buildItems, extractiveDigest } from "../src/thread-context.ts";
import { maskCall, threadStore, type StoredCall } from "../src/threads.ts";
import { hasVaultFindings, maskStoredText, maskVaultText, vaultFindings } from "../src/vault/filter.ts";
import { parseEdit, sensitiveCategories, VaultError } from "../src/vault/edit.ts";
import { makeFixture } from "./vault-fixture.ts";
import { say } from "./threads-fixture.ts";

// Follow-up to PR #66. Every credential-shaped value is generated here at run time from inert pieces; none is a live value.
const alnum = (n: number, seed: string) => Array.from({ length: n }, (_, i) => seed[(i * 7 + 3) % seed.length]).join("");
const GH = () => "gh" + "p_" + alnum(36, "aZ09kQ7mXb2LpR4tVw8nYc5dHe");
const URLPW = () => "Zq" + alnum(10, "kT9xLm2Pw4");
const awsSecret = (variant: "slash" | "plus" | "plain" | "both") => {
  const base = "wJalrXUtnFEMI" + (variant === "slash" || variant === "both" ? "/" : "") + "K7MDENG" + (variant === "plus" || variant === "both" ? "+" : "") + "bPxRfiCYEXAMPLE0";
  return (base + "Kq9Zr2Tb5Wm8Lx1Vc4Hs7Jd3Nf6").slice(0, 40);
};

// ---- 1. plain-text and JSON summaries ----------------------------------------------------------------------------------------------

test("maskStoredText: plain error text, valid JSON, clipped JSON, escaped, nested and CRLF forms all lose known credential values", () => {
  const gh = GH();
  const pw = URLPW();
  const url = `https://deploy:${pw}@git.example.test/repo.git`;
  const forms = [
    `git push failed: bad credentials ${gh} for remote`, // plain
    `fetch failed: ${url}`, // plain, URL credentials
    JSON.stringify({ ok: false, error: `bad token ${gh}` }), // valid JSON
    JSON.stringify({ a: { b: [`x\r\ntoken: ${gh}\r\ny`] } }), // nested, CRLF inside a string
    JSON.stringify({ ok: true }).slice(0, 8) + `"error":"call to ${url} failed\\nretry`, // clipped mid-string with an escape
    `{"error":"bad ${gh}` , // malformed: unterminated
    `Error: {"detail": "${gh}"} (after retry)`, // JSON quoted inside plain text
    `line one\r\nline two ${gh}\r\nline three`, // multiline CRLF plain
    JSON.stringify(`${gh}`), // a bare JSON string
  ];
  for (const f of forms) {
    const out = maskStoredText(f);
    assert.ok(!out.includes(gh) && !out.includes(pw), `survived: ${f.slice(0, 40)}`);
    assert.ok(!hasVaultFindings(out.replace(/\[redacted[^\]]*\]/g, "")), "nothing left to flag");
  }
  // Valid JSON stays valid JSON after masking.
  const j = maskStoredText(JSON.stringify({ ok: false, error: `bad ${gh}`, n: 3 }));
  assert.deepEqual(JSON.parse(j).n, 3);
  // Benign identifiers and prose are untouched.
  for (const b of ["Projects/alpha-release-notes.md failed to parse", JSON.stringify({ ok: true, result: { path: "Resources/some-token-note.md", heading: "## Credentials" } }), "task-force-planning-2026 queued"]) assert.equal(maskStoredText(b), b);
});

test("maskCall: a plain-text failure summary, its output, arguments and source are masked; ops_ calls keep the tier-1 masker", () => {
  const gh = GH();
  const base: StoredCall = { callId: "c1", name: "vault_read", arguments: "{}", output: JSON.stringify({ ok: false, error: gh }), ok: false, summary: `remote said ${gh}`, at: "2026-01-01T00:00:00Z" };
  const m = maskCall(base);
  assert.ok(![m.arguments, m.output, m.summary].join("\n").includes(gh));
  assert.equal(maskCall({ ...base, name: "ops_status", summary: "plain", output: "{}" }).summary, "plain");
});

test("agent failure -> stored call -> history, page view and model context never carry the credential", async () => {
  const gh = GH();
  const pw = URLPW();
  const tool: ChatTool = { name: "vault_read", description: "x", parameters: {}, run: async () => { throw new Error(`clone failed https://u:${pw}@h.example.test/r.git with ${gh}`); } };
  const threads = threadStore(undefined);
  const t = threads.create("t");
  threads.appendUser(t.id, "read it");
  const mid = threads.beginAssistant(t.id);
  let n = 0;
  const model = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "t", verifiedAt: "" }),
    reply: async () => ({ value: "x", provenance: "live" as const, source: "f" }),
    step: async () => (n++ === 0 ? { text: "", calls: [{ call_id: "c1", name: "vault_read", arguments: "{}" }] } : say("done")),
  };
  await runChat({
    model: model as never, messages: [], limits: [], tools: [tool],
    onCall: ({ call_id, name, arguments: args, output, record }) => threads.addCall(t.id, mid, { callId: call_id, name, arguments: args, output, ok: record.ok, provenance: record.provenance, source: record.source, summary: record.summary, at: "2026-01-01T00:00:00Z" }),
  });
  threads.patchMessage(t.id, mid, { text: "done", status: "done" });
  const stored = threads.get(t.id)!;
  const call = stored.messages.find((m) => m.calls?.length)!.calls![0]!;
  assert.equal(call.ok, false);
  const surfaces = [JSON.stringify(stored), JSON.stringify(buildItems({ ...stored, messages: stored.messages.map((m) => ({ ...m, status: "done" as const })) })), extractiveDigest(undefined, stored.messages).text, call.summary, call.output];
  for (const s of surfaces) assert.ok(!s.includes(gh) && !s.includes(pw), s.slice(0, 80));
  assert.match(call.summary, /clone failed/); // the useful part of the message is kept
});

// ---- 2. sensitive-personal-detail policy ------------------------------------------------------------------------------------------

const health = (t: string): boolean => sensitiveCategories(t, "").includes("health");

test("health: generic words (notes, vault, orbit, tool) never override a personal disclosure", () => {
  for (const t of ["Sam's diagnosis notes: pending", "He has a condition", "She has a condition", "diagnosis of the queue service", "my symptoms in the vault note", "Jo's symptoms: see orbit notes", "the tool says Pat was diagnosed", "diagnosis: pending", "They have a chronic issue; orbit note"]) assert.equal(health(t), true, t);
});

test("health: genuinely technical service-health prose stays usable, mixed text asks", () => {
  for (const t of ["service health diagnostics for the queue", "the build symptoms: timeouts and retries", "chronic failures in CI", "the orbit service has a race condition in the cache", "diagnose the failing job in the pipeline"]) assert.equal(health(t), false, t);
  for (const t of ["The service logs are fine and Sam's diagnosis is pending", "queue stalled; Sam's diagnosis: pending", "the vault note says he has a condition"]) assert.equal(health(t), true, t);
});

test("health: the real write flow asks for confirmation on the review probes and writes technical prose directly", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const append = (text: string) => parseEdit("append_section", { path: "Projects/alpha.md", heading: "## Notes", text });
  const direct = { kind: "direct" } as const;
  const meta = { actor: "test" };
  const before = fx.remoteHead();
  for (const text of ["- Sam's diagnosis notes: pending", "- He has a condition", "- diagnosis of the queue service"]) {
    const err = await clone.write([append(text)], direct, meta).catch((e) => e as VaultError);
    assert.ok(err instanceof VaultError && err.code === "needs_confirmation", text);
    assert.equal(fx.remoteHead(), before);
  }
  assert.equal((await clone.write([append("- service health diagnostics: the queue stalled")], direct, meta)).status, "committed");
});

// ---- 3. path exemption vs AWS secret access keys ---------------------------------------------------------------------------------

test("AWS secret access key values are detected and masked with the same span, whatever slash/plus they hold", () => {
  for (const variant of ["slash", "plus", "both", "plain"] as const) {
    const v = awsSecret(variant);
    assert.equal(v.length, 40);
    for (const line of [
      `AWS_SECRET_ACCESS_KEY=${v}`, `export AWS_SECRET_ACCESS_KEY=${v}`, `AWS_SECRET_ACCESS_KEY="${v}"`, `export AWS_SECRET_ACCESS_KEY='${v}'`,
      `aws_secret_access_key = ${v}`, `secret_access_key: ${v}`, `AWS_SECRET_ACCESS_KEY=${v}\r\nNEXT=1`, `AWS_SECRET_ACCESS_KEY=${v}.`,
    ]) {
      const findings = vaultFindings(line);
      assert.ok(findings.some((f) => f.rule === "secret.credential-assignment"), line);
      const masked = maskVaultText(line);
      assert.ok(!masked.includes(v), line);
      assert.ok(masked.startsWith(line.slice(0, line.indexOf(v))), "the name and prefix are kept");
      assert.ok(masked.includes("[redacted]"));
      assert.ok(masked.endsWith(line.slice(line.indexOf(v) + v.length).replace(/^\./, ".")), "what follows the span is kept");
    }
  }
});

test("legitimate paths, file names and identifiers still pass under a credential-looking name", () => {
  for (const line of [
    "token_file: /home/user/.config/tool/credentials.json", "secret: ./secrets/store.yaml", "SECRET_PATH=~/Documents/Projects/alpha-notes.md", "password_file=/etc/app/db_password.txt",
    "api_key_path: ../config/api-keys.env", "private_key: C:\\Users\\rai\\keys\\id_main.pem", "secret: src/vault/filter.ts", "token: Resources/Some-Note-Name.md",
    "credentials: Projects/orbit-vault.md", "access_key_file: keys/team2026/primary.pem", "token: /var/lib/orbit/state/threads/index.json",
  ]) assert.deepEqual(vaultFindings(line), [], line);
});

// ---- 4. documented permissive limits (pinned: intended behaviour, not a promise of safety) -----------------------------------------

test("supported vs intentionally unsupported shapes (see docs/content-filter.md)", () => {
  const opaque = alnum(32, "Qm4Zx8Rt2Lp7Vb9Kd3Hs6Jc1");
  // Supported: a lowercase scheme is matched too (case-insensitive), as long as the value is credential-shaped.
  for (const t of [`authorization: bearer ${opaque}`, `Authorization: Bearer ${opaque}`, `api_key: ${opaque}`, `https://u:abc@host.example.test/`]) assert.ok(hasVaultFindings(t), t.slice(0, 30));
  // Intentionally not detected: they pass, by design. A pass is not a claim that the text is safe.
  for (const t of [
    `bearer ${opaque.slice(0, 10)}`, // a short value after the scheme
    `password = correct horse battery staple`, // a multiword value
    `the password is ${opaque}`, // a natural-language statement with no colon or equals sign
    `my key is ${opaque} ok`, // a bare, unprefixed opaque value
    opaque, // a long opaque run on its own
    `https://u:ab@host.example.test/`, // a URL password shorter than 3 characters
  ]) assert.equal(hasVaultFindings(t), false, t.slice(0, 30));
});
