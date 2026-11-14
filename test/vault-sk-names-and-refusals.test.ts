import assert from "node:assert/strict";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { VaultError, parseEdit } from "../src/vault/edit.ts";
import type { VaultEdit } from "../src/vault/edit.ts";
import { maskVaultText, vaultFindings } from "../src/vault/filter.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { git, makeFixture } from "./vault-fixture.ts";

// Readiness audit 2026-11-13, D3 and D4.
//  D3: an ordinary kebab-case note name that starts with "sk-" was flagged secret.provider-token, so a wikilink to it, or a note
//      whose path is long enough to reach the audit log line, was refused as a "secret".
//  D4: a refused vault write repeated the raw, model-supplied path (and other refusals echo it too), so a credential-shaped path
//      travelled back to the model and into the tool error unmasked.
// Every credential-shaped value below is built at runtime from harmless pieces; none is a real credential and no literal in this
// file has a credential shape.

const fixedNow = () => new Date("2026-11-10T18:05:00Z");
const LOG = "Log/2026/2026-11-10-orbit.md";
const E = (op: string, a: Record<string, unknown>): VaultEdit => parseEdit(op, a);
const direct = { kind: "direct" } as const;
const meta = { actor: "test" };

// Synthetic credential shapes (random-looking: mixed case and digits, the way generated keys are).
const body = (n: number) => "Q7vR2mXk9TpL4wZs8NbY3cHd6FgJ1aUe5KqW0oPi".repeat(3).slice(0, n);
const SK = (prefix = "") => "s" + "k-" + prefix + body(48);
const GHP = () => "gh" + "p_" + body(36);

// Benign names that begin with "sk-".
const BENIGN = [
  "sk-learn-pipeline-migration-notes",
  "sk-learn-upgrade-notes",
  "sk-proj-roadmap-planning-notes",
  "sk-ant-colony-optimisation-reading-list",
  "sk-live-event-checklist-for-the-team",
  "sk-or-v1-release-retrospective-notes",
  "sk-image-2026-upgrade-plan-and-notes",
];

test("D3: ordinary note names starting with sk- are not credentials, in text, wikilinks, paths and log lines", () => {
  for (const name of BENIGN) {
    for (const text of [name, `[[${name}]]`, `See [[${name}|the notes]] for details.`, `Tasks/${name}.md`, `- 10:05 orbit: created Tasks/${name}.md (chat)`]) {
      assert.deepEqual(vaultFindings(text), [], text);
      assert.equal(maskVaultText(text), text, text);
    }
  }
});

test("D3: genuine sk- keys (every prefix variant) are still recognised, in text, wikilinks and paths, and masked", () => {
  const keys = [SK(), SK("proj-"), SK("ant-"), SK("live-"), SK("or-v1-"), "s" + "k-ant-api03-" + body(40) + "-" + body(20), "s" + "k-" + "abcd0123efgh4567ijkl8901mnop"];
  for (const key of keys) {
    for (const text of [key, `key ${key} here`, `[[${key}]]`, `Tasks/${key}.md`, `- 10:05 orbit: created Tasks/${key}.md (chat)`]) {
      assert.deepEqual(vaultFindings(text).map((f) => f.rule), ["secret.provider-token"], text.slice(0, 12));
      assert.ok(!maskVaultText(text).includes(key), "the key is masked");
    }
  }
});

test("D3: a benign sk- note can be created, linked and logged by a direct write", async () => {
  const fx = makeFixture();
  const clone = fx.make({ now: fixedNow });
  const name = "sk-learn-pipeline-migration-notes";
  const path = `Tasks/${name}.md`;
  const r = await clone.write([E("create_note", { path, content: `# Migration\n\nSee also [[${name}]] and [[sk-learn-upgrade-notes]].\n` })], direct, meta);
  assert.equal(r.status, "committed");
  assert.equal(r.commit, fx.remoteHead());
  assert.match(fx.remoteFile(path), /\[\[sk-learn-pipeline-migration-notes\]\]/);
  assert.ok(fx.remoteFile(LOG).includes(`created ${path} (test)`), "the audit line names the note, unmasked");
  await clone.write([E("append_section", { path: "Projects/alpha.md", heading: "## Notes", text: `- moved to [[${name}]]` })], direct, meta);
  assert.match(fx.remoteFile("Projects/alpha.md"), /- moved to \[\[sk-learn-pipeline-migration-notes\]\]/);
});

// The refusal must not carry the credential-shaped path or the matched value, and nothing may change anywhere.
async function refusedQuietly(fx: ReturnType<typeof makeFixture>, p: Promise<unknown>, code: string, secrets: string[]): Promise<string> {
  const head = fx.remoteHead();
  let message = "";
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof Error, String(e));
    if (e instanceof VaultError) assert.equal(e.code, code, e.message);
    else assert.match(e.message, new RegExp(`\\(${code}\\)`));
    message = e.message;
    return true;
  });
  for (const s of secrets) assert.ok(!message.includes(s), `the refusal does not echo a sensitive value: ${message.slice(0, 80)}`);
  assert.deepEqual(vaultFindings(message), [], "nothing credential-shaped is left in the refusal");
  assert.equal(fx.remoteHead(), head, "nothing was pushed");
  return message;
}

test("D4: a write refused for its text does not echo a credential-shaped path or the value, and writes nothing", async () => {
  const fx = makeFixture();
  const clone = fx.make({ now: fixedNow });
  await clone.sync();
  const before = fx.remoteHead();
  const path = `Tasks/${GHP()}.md`;
  const key = SK("proj-");
  const msg = await refusedQuietly(fx, clone.write([E("create_note", { path, content: `# Keys\n\napi ${key}\n` })], direct, meta), "secret_refused", [GHP(), key]);
  assert.match(msg, /secret\.provider-token at line 3/, "the refusal still says which rule fired and where");
  assert.match(msg, /Tasks\/\[redacted token\]\.md/, "the path is shown with only the credential-shaped part masked");
  assert.equal(fx.remoteHead(), before);
  assert.equal(git(fx.cloneDir, "status", "--porcelain").trim(), "", "the clone's working tree is clean");
  assert.equal(git(fx.cloneDir, "rev-parse", "HEAD").trim(), before, "no local commit either");
});

test("D4: other refusals (missing note, outside area, audit line) do not echo a credential-shaped path", async () => {
  const fx = makeFixture();
  const clone = fx.make({ now: fixedNow });
  await clone.sync();
  const before = fx.remoteHead();
  const tok = GHP();
  await refusedQuietly(fx, clone.write([E("replace_text", { path: `Tasks/${tok}.md`, find: "a", replace: "b" })], direct, meta), "precondition_failed", [tok]);
  await refusedQuietly(fx, clone.write([E("create_note", { path: `Elsewhere/${tok}.md`, content: "# Hi\n" })], direct, meta), "policy_refused", [tok]);
  // Benign text at a credential-shaped path: the audit line would carry the path, so the write is refused without echoing it.
  await refusedQuietly(fx, clone.write([E("create_note", { path: `Tasks/${tok}.md`, content: "# Hi\n" })], direct, meta), "secret_refused", [tok]);
  assert.equal(fx.remoteHead(), before);
  assert.equal(git(fx.cloneDir, "status", "--porcelain").trim(), "");
});

test("D4: the chat tool error and the proposal path do not carry a credential-shaped path; no proposal is made", async () => {
  const fx = makeFixture();
  const clone = fx.make({ now: fixedNow });
  await clone.sync();
  const props = newProposals();
  const tools = vaultEdits({ clone, memory: { name: "memory" } as never, proposals: props });
  const create = tools.tools.find((t) => t.name === "vault_create_note")!;
  const replace = tools.tools.find((t) => t.name === "vault_replace_text")!;
  const tok = GHP();
  const key = SK();
  await refusedQuietly(fx, create.run({ path: `Tasks/${tok}.md`, content: `token ${key}\n` }), "secret_refused", [tok, key]);
  await refusedQuietly(fx, replace.run({ path: `Projects/${tok}.md`, find: "x", replace: "y" }), "precondition_failed", [tok]);
  await refusedQuietly(fx, create.run({ path: `Nowhere/${tok}.md`, content: "# Hi\n" }), "policy_refused", [tok]);
  // A protected path (System/) would become a proposal; with a credential-shaped path the card cannot show it, so it is refused.
  await refusedQuietly(fx, create.run({ path: `System/${tok}.md`, content: "# Hi\n" }), "policy_refused", [tok]);
  assert.deepEqual(props.list(), [], "no proposal was created");
});

test("D3/D4: confirmation safeguards still apply to a benign sk- name in a protected area", async () => {
  const fx = makeFixture();
  const clone = fx.make({ now: fixedNow });
  await clone.sync();
  const props = newProposals();
  const tools = vaultEdits({ clone, memory: { name: "memory" } as never, proposals: props });
  const create = tools.tools.find((t) => t.name === "vault_create_note")!;
  const before = fx.remoteHead();
  const r = (await create.run({ path: "System/sk-learn-pipeline-migration-notes.md", content: "# Notes\n" })) as { value: { status: string; proposalId: string } };
  assert.equal(r.value.status, "pending-confirmation", "System/ still needs Rai's confirmation");
  assert.equal(fx.remoteHead(), before, "nothing written before confirmation");
  const p = props.peek(r.value.proposalId) as { display: Record<string, string> };
  assert.equal(p.display.path, "System/sk-learn-pipeline-migration-notes.md", "the card shows the benign path in full");
});
