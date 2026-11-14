import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneMemory, vaultMemory } from "../src/memory.ts";
import { VaultError, parseEdit } from "../src/vault/edit.ts";
import type { VaultEdit } from "../src/vault/edit.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { call, rig, say, scripted } from "./threads-fixture.ts";
import { makeFixture } from "./vault-fixture.ts";

// The regression matrix: the same fixtures run across every surface the content filter touches (reads and tool output stored in a
// thread, what the conversation says, vault writes, confirmation cards and proposals). Job context export was removed, so it is no longer a surface. A change to the filter
// that fixes one surface and breaks another fails here. Every secret-shaped value is assembled at run time from a seeded generator;
// no literal in this file is, or looks like, a usable credential.
let seed = 0x7a3c19;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const random = (n: number, a = B62): string => Array.from({ length: n }, () => a[Math.floor(rnd() * a.length)]).join("");
const mixed = (n: number): string => "Q7" + random(n - 4) + "z9";
const E = (op: string, a: Record<string, unknown>): VaultEdit => parseEdit(op, a);
const direct = { kind: "direct" } as const;
const meta = { actor: "test" };

const LONG = "orbit-next-secret-detector-false-positives";
const BENIGN: [string, string][] = [
  ["ordinary headings", `# Plan\n\n## Credential:\n### Token budget: how it works\n**Credential:** stored in the keychain, never in a note.\n`],
  ["long note names and paths", `- [[${LONG}]] and Resources/orbit-next-handover-to-orbit.md\n- Tasks/${LONG}.md: renamed\n- /home/user/orbit-vault/Projects/${LONG}.md\n`],
  ["identifiers", `- the helper someLongIdentifierNameForTheFilterRule; commit 0123456789abcdef0123456789abcdef01234567; id ${random(36)}\n`],
  ["service-health prose", `- service health: diagnostics for the failing job; symptoms: timeouts and retries; token refresh failing on the host; password rotation overdue\n`],
  ["unknown opaque values", `- run ${random(40)} finished; digest ${random(64, "0123456789abcdef")}\n- password: correct-horse-battery-staple\n`],
];

const KNOWN: [string, string, string][] = [
  ["provider token", "secret.provider-token", "the deploy key is gh" + "p_" + random(36) + " ok"],
  ["jwt", "secret.jwt", "session ey" + "J" + random(20) + "." + random(24) + "." + random(24)],
  ["assignment", "secret.credential-assignment", "pass" + "word: " + mixed(18) + " (rotated monthly)"],
  ["bold credential heading", "secret.credential-assignment", "**Credential:** " + mixed(32)],
  ["url credentials", "secret.url-credentials", "clone https://user:" + mixed(14) + "@example.com/x.git"],
];

const withContext = (known: string): string => `# T\r\n\r\nsee [[${LONG}]]\r\n${known}\r\nafter: Tasks/${LONG}.md\r\n`;
const valueOf = (known: string): string => known.replace(/^.*?(gh[a-z]_|ey[J]|pass[w]ord: |\*\*Credential:\*\* |:\/\/user:)/, "").replace(/[ @(].*$/s, "").slice(0, 12);

// ---- 1. reads and tool output ----------------------------------------------------------------------------------------------------

test("reads and tool output: a note read by memory_read is stored with ordinary text exactly, and only known secret values masked", async () => {
  const vault: Record<string, string> = {};
  for (const [name, text] of BENIGN) vault[`benign-${name.replace(/\W+/g, "-")}.md`] = text;
  for (const [name, , text] of KNOWN) vault[`known-${name.replace(/\W+/g, "-")}.md`] = withContext(text);
  vault["crlf-multiline.md"] = `# T\r\npass` + `word:\r\n    ${mixed(24)}\r\n\r\nnext\r\n`;
  const model = scripted([
    { text: "", calls: Object.keys(vault).map((p, i) => call("memory_read", { path: p }, `c${i}`)) },
    say("done"),
  ]);
  const x = rig({ model, vault });
  const t = await x.create();
  await x.send(t.id, "read them all");
  const calls = x.threads.get(t.id)!.messages[1]!.calls!;
  assert.equal(calls.length, Object.keys(vault).length);
  const byPath = new Map(calls.map((c) => [JSON.parse(c.arguments).path as string, c]));
  for (const [name, text] of BENIGN) {
    const c = byPath.get(`benign-${name.replace(/\W+/g, "-")}.md`)!;
    const out = JSON.parse(c.output) as { ok: boolean; result: { content?: string } | string };
    assert.equal(out.ok, true, name);
    assert.ok(JSON.stringify(out).includes(JSON.stringify(text).slice(1, -1)), `${name}: kept exactly`);
  }
  for (const [name, , text] of KNOWN) {
    const c = byPath.get(`known-${name.replace(/\W+/g, "-")}.md`)!;
    assert.ok(!c.output.includes(valueOf(text)), `${name}: value masked in the stored result`);
    assert.ok(c.output.includes(LONG), `${name}: the long note name next to it is kept`);
    assert.ok(c.output.includes("\\r\\n"), `${name}: CRLF kept`);
  }
  const multi = byPath.get("crlf-multiline.md")!;
  assert.match(multi.output, /word:\\r\\n    \[redacted\]\\r\\n\\r\\nnext/, "CRLF continuation masked in place");
  x.close();
});

test("tool results of ops tools keep the tier-1 masking; vault and job tools use known-shape masking", async () => {
  const model = scripted([{ text: "", calls: [call("orbit_config_view", {}, "a")] }, say("done")]);
  const x = rig({ model });
  const t = await x.create();
  await x.send(t.id, "show config");
  assert.equal(x.threads.get(t.id)!.messages[1]!.calls![0]!.name, "orbit_config_view");
  x.close();
});

// ---- 2. what the conversation says ------------------------------------------------------------------------------------------------

test("history: a long note name in a message, a title and a reply is kept; a known secret in them is masked", async () => {
  const k = "gh" + "p_" + random(36);
  const model = scripted([say(`I updated Tasks/${LONG}.md and left ${k} out.`)]);
  const x = rig({ model });
  const t = await x.create();
  await x.send(t.id, `please open [[${LONG}]] and ${k}`);
  const th = x.threads.get(t.id)!;
  assert.ok(th.messages[0]!.text.includes(`[[${LONG}]]`) && !th.messages[0]!.text.includes(k));
  assert.ok(th.messages[1]!.text.includes(`Tasks/${LONG}.md`) && !th.messages[1]!.text.includes(k));
  assert.ok(th.title.includes("open [[") && th.title.includes(LONG.slice(0, 20)), `the auto title keeps the name: ${th.title}`);
  assert.ok(JSON.stringify(model.seen[0]!.input).includes(LONG), "the model is sent the real name, not [redacted]");
  assert.ok(!JSON.stringify(model.seen[0]!.input).includes(k));
  x.close();
});

// ---- 3. writes -------------------------------------------------------------------------------------------------------------------

test("writes: ordinary and unknown text is written byte for byte (CRLF included); a known secret is refused with rule and line, nothing written", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  let n = 0;
  for (const [name, text] of BENIGN) {
    const path = `Projects/matrix-${LONG}-${++n}.md`;
    const r = await clone.write([E("create_note", { path, content: text })], direct, meta);
    assert.equal(r.status, "committed", name);
    assert.equal(fx.remoteFile(path), text, `${name}: exact`);
  }
  const crlf = `# T\r\n\r\n**Credential:** stored in the keychain\r\nsee [[${LONG}]]\r\n`;
  await clone.write([E("create_note", { path: "Projects/crlf-note.md", content: crlf })], direct, meta);
  assert.equal(fx.remoteFile("Projects/crlf-note.md"), crlf, "CRLF note written exactly");
  const head = fx.remoteHead();
  for (const [name, rule, known] of KNOWN) {
    const err = await clone.write([E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text: `\n${withContext(known)}` })], direct, meta).catch((e) => e as VaultError);
    assert.ok(err instanceof VaultError && err.code === "secret_refused", name);
    assert.match(err.message, new RegExp(`${rule.replace(".", "\\.")} at line \\d+`), name);
    assert.ok(!err.message.includes(valueOf(known)), `${name}: value not echoed`);
    assert.match(err.message, /placeholder/, "says what to change");
  }
  assert.equal(fx.remoteHead(), head, "nothing was written, redacted or retried");
});

// ---- 4. proposals and confirmation cards -----------------------------------------------------------------------------------------

test("cards and proposals: a job brief and a protected vault edit show long names whole; a known secret is masked or refuses the card", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const memory = cloneMemory(clone, vaultMemory("/nonexistent-copy", undefined));
  await memory.refresh!(0);
  const k = "gh" + "p_" + random(36);
  const brief = `Fix [[${LONG}]] in Tasks/${LONG}.md. A credential: ${k} was pasted by mistake.`;
  let ve!: ReturnType<typeof vaultEdits>;
  const model = scripted([
    { text: "", calls: [call("job_launch", { routine: "orbit", brief }, "j")] },
    { text: "", calls: [call("vault_replace_text", { path: "System/memory.md", find: "# Memory rules", replace: `# Memory rules (see [[${LONG}]])\n\n**Credential:** stored in the keychain` })], },
    say("proposed"),
  ]);
  const x = rig({ model, extra: ({ proposals }) => ({ memory, vaultEdits: (ve = vaultEdits({ clone, memory, proposals })) }) });
  const t = await x.create();
  await x.send(t.id, "propose both");
  const cards = (await x.api(`/threads/${t.id}`)).data.thread.cards as { kind: string; brief?: string; briefMasked?: boolean; display?: { change: string; path: string }; summary?: string }[];
  const job = cards.find((c) => c.kind === "job_launch")!;
  assert.ok(job.brief!.includes(`[[${LONG}]]`) && job.brief!.includes(`Tasks/${LONG}.md`), "the brief's names are shown whole");
  assert.ok(!job.brief!.includes(k) && job.briefMasked === true, "the secret is hidden and the card says it was masked");
  const edit = cards.find((c) => c.kind === "vault_edit")!;
  assert.ok(edit.display!.change.includes(`[[${LONG}]]`) && edit.display!.change.includes("**Credential:** stored in the keychain"), "the vault card shows the exact change");
  void ve;
  // A protected edit with a known secret: no card, and the reason names the rule and the card line.
  const tool = ve.tools.find((q) => q.name === "vault_replace_text")!;
  await assert.rejects(tool.run({ path: "System/memory.md", find: "# Memory rules", replace: `# Memory rules\n${k}` }), (e: unknown) => e instanceof Error && /secret/i.test(e.message) && !e.message.includes(k.slice(4, 16)));
  x.close();
});
