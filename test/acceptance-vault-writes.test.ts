import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import type { Proposal } from "../src/agent.ts";
import { parseEdit, VaultError } from "../src/vault/edit.ts";
import { vaultFindings } from "../src/vault/filter.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { git, makeFixture } from "./vault-fixture.ts";

// Acceptance 2026-11-14 (docs/acceptance-2026-11-14.md, area 1): the vault write path as chat uses it (vaultEdits -> clone.write ->
// commit -> plain push -> remote read-back), against a throwaway bare repository. Synthetic data only: no production vault, no
// network, no real credential. Every credential-shaped value is assembled at runtime from harmless pieces, so no literal in this
// file has a credential shape. These cover what the D3/D4 tests (vault-sk-names-and-refusals.test.ts) do not: names near the
// path-length limit, every edit operation, the full confirm round trip, refusals for each operation, a multi-edit write refused
// part way, and a push the remote rejects.

const fixedNow = () => new Date("2026-11-14T20:00:00Z");
const LOG = "Log/2026/2026-11-14-orbit.md";

// Benign kebab-case names that start with "sk-", one close to the 100-character path-segment limit (with ".md").
const words = ["learn", "pipeline", "migration", "notes", "for", "the", "quarterly", "platform", "review", "and", "follow", "up"];
const longName = (n: number) => {
  let s = "sk";
  for (let i = 0; s.length < n; i++) s += `-${words[i % words.length]}`;
  return s.slice(0, n).replace(/-+$/, "");
};
const NAME = longName(97);
const NAME2 = "sk-proj-" + longName(80).slice(3);
const NAME3 = "sk-ant-" + longName(60).slice(3);
// A wikilink target longer than any path segment may be: it lives only in text.
const LINK = longName(180);

// A random-looking body (mixed case and digits, as generated keys are), produced at runtime from the plain alphabet.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const body = (n: number) => Array.from({ length: n }, (_, i) => ALPHABET[(i * 37 + 11) % ALPHABET.length]).join("");
const SK = () => "s" + "k-" + "proj-" + body(48);
const GHP = () => "gh" + "p_" + body(36);

function rig() {
  const fx = makeFixture();
  const clone = fx.make({ now: fixedNow });
  const props = newProposals(fixedNow);
  const tools = vaultEdits({ clone, memory: { name: "memory" } as never, proposals: props, now: fixedNow });
  const tool = (name: string) => tools.tools.find((t) => t.name === name)!;
  return { fx, clone, props, tools, tool };
}
const clean = (fx: ReturnType<typeof makeFixture>) => {
  assert.equal(git(fx.cloneDir, "status", "--porcelain", "--ignored").trim(), "", "the clone's working tree is clean");
  assert.equal(git(fx.cloneDir, "rev-parse", "HEAD").trim(), fx.remoteHead(), "the clone holds no unpushed commit");
};
type Committed = { value: { status: string; commit: string; verifiedOnRemote: boolean } };

test("vault acceptance: every operation writes long benign sk- names and wikilinks through the chat tools, verified on the remote", async () => {
  assert.ok(NAME.length >= 90 && NAME.length <= 97, String(NAME.length));
  for (const n of [NAME, NAME2, NAME3, LINK]) assert.deepEqual(vaultFindings(n), [], n);
  const { fx, tool } = rig();
  await fx.make().sync();
  const path = `Tasks/${NAME}.md`;
  const runs: Committed[] = [];
  runs.push((await tool("vault_create_note").run({ path, content: `# Notes\n\nSee [[${LINK}]] and [[${NAME2}|the project notes]].\n` })) as Committed);
  runs.push((await tool("vault_append_section").run({ path: "Projects/alpha.md", heading: "## Notes", text: `- moved to [[${NAME}]] and [[${NAME3}]]` })) as Committed);
  runs.push((await tool("vault_replace_text").run({ path, find: `[[${NAME2}|the project notes]]`, replace: `[[${NAME3}]]` })) as Committed);
  runs.push((await tool("vault_set_frontmatter").run({ path, key: "related", value: [`[[${NAME2}]]`, `[[${LINK}]]`] })) as Committed);
  for (const r of runs) {
    assert.equal(r.value.status, "committed");
    assert.equal(r.value.verifiedOnRemote, true);
  }
  assert.equal(runs.at(-1)!.value.commit, fx.remoteHead());
  const note = fx.remoteFile(path);
  assert.ok(note.includes(`[[${LINK}]]`) && note.includes(`[[${NAME3}]]`) && note.includes(`[[${NAME2}]]`), "names are written whole, never masked");
  assert.ok(!note.includes("[redacted"), "nothing was redacted");
  assert.match(fx.remoteFile("Projects/alpha.md"), new RegExp(`- moved to \\[\\[${NAME}\\]\\]`));
  const archived = (await tool("vault_archive_note").run({ path })) as Committed;
  assert.equal(archived.value.status, "committed");
  assert.ok(fx.remoteFile(`Archive/Tasks/${NAME}.md`).includes(`[[${LINK}]]`));
  const log = fx.remoteFile(LOG);
  assert.equal(log.split("\n").filter((l) => l.startsWith("- ")).length, 5, "one audit line per write");
  assert.ok(log.includes(`Tasks/${NAME}.md`), "the audit line names the long sk- note unmasked");
  clean(fx);
});

test("vault acceptance: a protected-area write is only a proposal until confirmed; the confirm runs once, and a tampered card is refused", async () => {
  const { fx, props, tools, tool } = rig();
  await fx.make().sync();
  const before = fx.remoteHead();
  const path = `System/${NAME}.md`;
  const r = (await tool("vault_create_note").run({ path, content: `# Rule\n\nSee [[${LINK}]].\n` })) as { value: { status: string; proposalId: string; saved: boolean } };
  assert.equal(r.value.status, "pending-confirmation");
  assert.equal(r.value.saved, false);
  assert.equal(fx.remoteHead(), before, "nothing written before confirmation");
  const p = props.peek(r.value.proposalId) as Proposal & { kind: "vault_edit"; display: Record<string, string> };
  assert.equal(p.display.path, path, "the card shows the long benign path in full");

  // A card whose shown change differs from the held one is refused and writes nothing.
  const tampered = await tools.confirm({ ...p, display: { ...p.display, path: "System/other.md" } });
  assert.equal(tampered.code, 409);
  assert.equal(fx.remoteHead(), before);

  // The proposal is single use: the tampered attempt consumed the held change, so ask again and confirm the real card.
  const again = (await tool("vault_create_note").run({ path, content: `# Rule\n\nSee [[${LINK}]].\n` })) as { value: { proposalId: string } };
  const real = props.peek(again.value.proposalId) as Proposal & { kind: "vault_edit" };
  const ok = await tools.confirm(real);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verifiedOnRemote, true);
  assert.ok(fx.remoteFile(path).includes(`[[${LINK}]]`));
  const twice = await tools.confirm(real);
  assert.equal(twice.code, 410, "a confirmed proposal cannot run again");
  assert.equal(fx.remoteFile(LOG).split("\n").filter((l) => l.startsWith("- ")).length, 1, "exactly one write landed");

  // The Journal beyond its plan section and a #rai note still need confirmation, with a benign sk- link in the text.
  for (const [name, args] of [
    ["vault_append_section", { path: "Journal/2026/2026-11-09.md", heading: "## Reflections", text: `- read [[${NAME}]]` }],
    ["vault_replace_text", { path: "Projects/secret-rai.md", find: "do not touch", replace: `see [[${NAME}]]` }],
  ] as const) {
    const res = (await tool(name).run(args)) as { value: { status: string } };
    assert.equal(res.value.status, "pending-confirmation", name);
  }
  clean(fx);
});

test("vault acceptance: a genuine credential is refused in every operation, the refusal names only rule and line, and nothing changes", async () => {
  const { fx, clone, props, tool } = rig();
  await fx.make().sync();
  fx.elsewhere({ "Tasks/target.md": "---\nstatus: open\n---\n# Target\n\n## Notes\n- placeholder\n" });
  const before = fx.remoteHead();
  const key = SK();
  const gh = GHP();
  const cases: [string, Record<string, unknown>][] = [
    ["vault_create_note", { path: "Tasks/leak.md", content: `# Leak\n\nkey ${key}\n` }],
    ["vault_create_note", { path: `System/${NAME}.md`, content: `# Protected\n\n${gh}\n` }],
    ["vault_append_section", { path: "Tasks/target.md", heading: "## Notes", text: `- api ${key}` }],
    ["vault_replace_text", { path: "Tasks/target.md", find: "placeholder", replace: gh }],
    ["vault_set_frontmatter", { path: "Tasks/target.md", key: "token", value: key }],
    ["vault_set_frontmatter", { path: "Tasks/target.md", key: "links", value: [`[[${NAME}]]`, gh] }],
  ];
  for (const [name, args] of cases) {
    let message = "";
    await assert.rejects(tool(name).run(args), (e: unknown) => {
      assert.ok(e instanceof Error);
      message = e.message;
      return true;
    }, name);
    assert.match(message, /^NOT saved \(secret_refused\)/, `${name}: ${message.slice(0, 80)}`);
    assert.match(message, /secret\.provider-token at line \d+/, name);
    for (const s of [key, gh]) assert.ok(!message.includes(s), `${name}: the refusal does not echo the value`);
    assert.deepEqual(vaultFindings(message), [], `${name}: nothing credential-shaped in the refusal`);
    assert.equal(fx.remoteHead(), before, `${name}: nothing pushed`);
    clean(fx);
  }
  // A credential-shaped heading that does not exist fails its precondition first; that refusal masks the value too.
  await assert.rejects(tool("vault_append_section").run({ path: "Tasks/target.md", heading: `## ${gh}`, text: "- benign" }), (e: unknown) => {
    assert.match((e as Error).message, /^NOT saved \(precondition_failed\): No heading "## \[redacted token\]"/);
    assert.ok(!(e as Error).message.includes(gh));
    return true;
  });
  assert.equal(fx.remoteHead(), before);
  assert.deepEqual(props.list(), [], "a secret in a protected-area write never becomes a proposal card");
  // The clone's recorded last error (shown on /status) carries the refusal, masked the same way.
  const state = clone.state();
  assert.ok(state.lastError, "a refusal is recorded");
  for (const s of [key, gh]) assert.ok(!JSON.stringify(state).includes(s), "the clone state does not hold the value");

});

test("vault acceptance: a multi-edit write refused part way leaves nothing, locally or on the remote; the next write succeeds", async () => {
  const { fx, clone } = rig();
  await clone.sync();
  const before = fx.remoteHead();
  const edits = [
    parseEdit("create_note", { path: `Tasks/${NAME}.md`, content: "# Fine\n" }),
    parseEdit("append_section", { path: "Projects/alpha.md", heading: "## Notes", text: `- ok [[${NAME}]]` }),
    parseEdit("create_note", { path: "Tasks/leak.md", content: `token ${SK()}\n` }),
  ];
  await assert.rejects(clone.write(edits, { kind: "direct" }, { actor: "test" }), (e: unknown) => e instanceof VaultError && e.code === "secret_refused");
  assert.equal(fx.remoteHead(), before);
  assert.throws(() => fx.remoteFile(`Tasks/${NAME}.md`), "the first edit did not land either");
  assert.doesNotMatch(fx.remoteFile("Projects/alpha.md"), /- ok/);
  clean(fx);
  const r = await clone.write(edits.slice(0, 2), { kind: "direct" }, { actor: "test" });
  assert.equal(r.commit, fx.remoteHead());
  clean(fx);
});

test("vault acceptance: a push the remote rejects is reported, leaves no unpushed commit behind, and is never pushed later", async () => {
  const { fx, clone, tool } = rig();
  await clone.sync();
  const before = fx.remoteHead();
  const hook = join(fx.remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'rejected by policy' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  await assert.rejects(tool("vault_create_note").run({ path: `Tasks/${NAME}.md`, content: "# Refused by remote\n" }), /NOT saved \(push_failed\)/);
  assert.equal(fx.remoteHead(), before);
  clean(fx);
  writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  const r = (await tool("vault_create_note").run({ path: "Tasks/after.md", content: "# After\n" })) as Committed;
  assert.equal(r.value.status, "committed");
  assert.throws(() => fx.remoteFile(`Tasks/${NAME}.md`), "the rejected commit was not carried into the next push");
  assert.equal(fx.remoteFile(LOG).split("\n").filter((l) => l.startsWith("- ")).length, 1);
  clean(fx);
});
