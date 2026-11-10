import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneMemory, selectMemory, vaultMemory } from "../src/memory.ts";
import { notifier } from "../src/notify.ts";
import { proposals as newProposals } from "../src/agent.ts";
import { chatTools } from "../src/chat-tools.ts";
import { toolbox } from "../src/tools.ts";
import { jsonStore } from "../src/store.ts";
import { recentContext, vaultRecentContext, RECENT_NOTE_PATH } from "../src/recent-context.ts";
import { configView } from "../src/config-view.ts";
import { decide } from "../src/policy.ts";
import { gitRunner } from "../src/vault/git.ts";
import { credentialFile } from "../src/vault/clone.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { threadStore } from "../src/threads.ts";
import { threadService } from "../src/thread-service.ts";
import { call, OWNER, rig, say, scripted } from "./threads-fixture.ts";
import { TOKEN, git, makeFixture } from "./vault-fixture.ts";

const later = (ms: number) => new Date(Date.now() + ms);

test("memory: the clone answers when the credential is installed and says which source and how fresh; own writes are visible at once", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const copy = mkdtempSync(join(tmpdir(), "orbit-copy-"));
  writeFileSync(join(copy, "old-note.md"), "Stale copy text about zebras.\n");
  const memory = cloneMemory(clone, vaultMemory(copy, undefined));

  // Before the first sync the clone does not exist: fallback, with the reason.
  const first = memory.search("zebras");
  assert.match(first.source, /FALLBACK: the writable clone is not available yet/);
  assert.equal(memory.sourceInfo!().via, "fallback");

  await memory.refresh!(0);
  const r = memory.search("alpha");
  assert.equal(r.value[0]!.path, "Projects/alpha.md");
  assert.match(r.source, /^memory\/vault-clone@[0-9a-f]{7} \(fetched 20\d\d-/);
  assert.doesNotMatch(r.source, /FALLBACK|STALE/);
  assert.equal(memory.status().state, "live");
  assert.match(memory.status().detail, /writable vault clone/);

  // Own write: visible to the very next search without waiting for any refresh.
  const tools = vaultEdits({ clone, memory, proposals: newProposals() });
  const create = tools.tools.find((t) => t.name === "vault_create_note")!;
  const done = await create.run({ path: "Projects/giraffe.md", content: "# Giraffe\nTall animals.\n" });
  assert.equal((done.value as { status: string }).status, "committed");
  assert.equal(memory.search("giraffe").value[0]!.path, "Projects/giraffe.md");

  // Fresh remote data: someone else's commit shows up after a refresh, not before.
  fx.elsewhere({ "Resources/okapi.md": "Okapi facts\n" });
  assert.equal(memory.search("okapi").value.length, 0);
  await memory.refresh!(0);
  assert.equal(memory.search("okapi").value[0]!.path, "Resources/okapi.md");
});

test("memory: a failing fetch keeps answering from the last good clone and says STALE with the error; without the credential it falls back and says why", async () => {
  const fx = makeFixture();
  let credential: string | undefined = TOKEN;
  const clone = fx.make({ credential: () => credential });
  const copy = mkdtempSync(join(tmpdir(), "orbit-copy-"));
  writeFileSync(join(copy, "copy-only.md"), "Only in the lagging copy.\n");
  writeFileSync(join(copy, "sync.json"), JSON.stringify({ commit: "abcdef1234", at: "2026-01-01T00:00:00Z" }));
  const memory = cloneMemory(clone, vaultMemory(copy, join(copy, "sync.json")));
  await memory.refresh!(0);

  // Break the remote for one fetch: it is not there.
  renameSync(fx.remote, `${fx.remote}.moved`);
  try {
    await memory.refresh!(0);
  } finally {
    renameSync(`${fx.remote}.moved`, fx.remote);
  }
  const stale = memory.search("alpha");
  assert.equal(stale.value[0]!.path, "Projects/alpha.md");
  assert.match(stale.source, /STALE: the last fetch failed at .*:/);
  assert.equal(memory.status().state, "degraded");
  assert.doesNotMatch(JSON.stringify([stale, memory.status()]), new RegExp(TOKEN));

  // Credential missing: the read-only copy answers, labelled as a fallback that may lag.
  credential = undefined;
  const fallback = memory.search("lagging");
  assert.equal(fallback.value[0]!.path, "copy-only.md");
  assert.match(fallback.source, /^memory\/vault@abcdef1 \(FALLBACK: the vault write credential \(orbit\.github-vault\) is not installed.*may lag GitHub\)$/);
  assert.equal(memory.sourceInfo!().via, "fallback");
  const st = memory.status();
  assert.equal(st.state, "degraded");
  assert.match(st.detail, /FALLBACK/);
  assert.match(st.detail, /write tools are unavailable/);
});

test("memory: selectMemory without a clone is exactly the old read-only behaviour, and symlinked notes are never followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-vault-"));
  writeFileSync(join(dir, "a.md"), "alpha\n");
  writeFileSync(join(dir, "outside.txt"), "TOPSECRETWORD\n");
  symlinkSync(join(dir, "outside.txt"), join(dir, "evil.md"));
  const m = selectMemory({ ORBIT_VAULT: dir });
  assert.match(m.search("alpha").source, /^memory\/vault@/);
  assert.equal(m.search("TOPSECRETWORD").value.length, 0);
  assert.throws(() => m.read("evil.md"), /no such note/);
});

test("rolling note: written to Memory/recent-context.md through the vault pipeline, logged, pushed, readable back", async () => {
  const fx = makeFixture();
  const clone = fx.make({ now: () => new Date("2026-11-10T18:00:00Z") });
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  const port = vaultRecentContext({ memory, clone, legacy: jsonStore(undefined, "x", null), now: () => new Date("2026-11-10T18:00:00Z") });
  assert.match(port.describe(), /nothing saved yet/);
  assert.equal((await port.read())?.text, "Old note about work.");

  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  await port.write({ text: "Working on the vault tools. Open: confirm flow.", updatedAt: "2026-11-10T18:00:00.000Z", sources: [id] });
  const remote = fx.remoteFile(RECENT_NOTE_PATH);
  assert.match(remote, /^---\nupdatedAt: 2026-11-10T18:00:00\.000Z\nsources: \[0f8fad5b\]\n---\nWorking on the vault tools\./);
  assert.match(fx.remoteFile("Log/2026/2026-11-10-orbit.md"), /refreshed the rolling recent-work note \(Memory\/recent-context\.md\) \(recent-context\)/);
  const back = await port.read();
  assert.equal(back?.text, "Working on the vault tools. Open: confirm flow.");
  assert.deepEqual(back?.sources, ["0f8fad5b"]);
  assert.match(port.describe(), /last saved 2026/);
  // The commit author is ORBIT and the body and log line landed together.
  assert.match(git(fx.remote, "show", "--name-only", "--format=%an", "main"), /^ORBIT\n/);
});

test("rolling note: a missing note is created; secrets and new sensitive categories are NOT saved and the failure is honest", async () => {
  const fx = makeFixture({ "AGENTS.md": "# r\n" });
  const clone = fx.make();
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  const port = vaultRecentContext({ memory, clone });
  await port.write({ text: "First note.", updatedAt: "2026-11-10T18:00:00.000Z", sources: ["abc"] });
  assert.match(fx.remoteFile(RECENT_NOTE_PATH), /First note\./);
  const head = fx.remoteHead();

  // Sensitive-category approval has no automatic bypass: the write is refused, and nothing is claimed.
  await assert.rejects(port.write({ text: "First note. Rai started therapy.", updatedAt: "2026-11-10T19:00:00.000Z", sources: ["abc"] }), /NOT saved to the vault: .*confirmation.*sensitive/);
  assert.match(port.describe(), /last save FAILED/);
  assert.match(port.describe(), /not being updated/);
  // A secret-shaped value is refused, not redacted into the commit.
  await assert.rejects(port.write({ text: `key ${["gh", "p_"].join("")}abcdefghijklmnopqrstuvwx`, updatedAt: "2026-11-10T19:00:00.000Z", sources: [] }), /secret/);
  assert.equal(fx.remoteHead(), head);
  assert.doesNotMatch(fx.remoteFile(RECENT_NOTE_PATH), /therapy|ghp_/);
});

test("rolling note: no credential means nothing is saved, and the status says so; the legacy state note is still readable", async () => {
  const fx = makeFixture();
  const clone = fx.make({ credential: () => undefined });
  const copy = mkdtempSync(join(tmpdir(), "orbit-copy-"));
  const memory = cloneMemory(clone, vaultMemory(copy));
  const legacy = jsonStore<{ text: string; updatedAt: string; sources: string[] } | null>(undefined, "x", { text: "Legacy note", updatedAt: "2026-10-01T00:00:00Z", sources: ["t"] });
  const port = vaultRecentContext({ memory, clone, legacy });
  assert.equal((await port.read())?.text, "Legacy note");
  assert.match(port.describe(), /NOT saving: the vault write credential is not installed/);
  await assert.rejects(port.write({ text: "x", updatedAt: "2026-11-10T00:00:00.000Z", sources: [] }), /NOT saved to the vault: .*credential/);
  assert.match(port.describe(), /last save FAILED/);
  assert.equal(fx.remoteHead(), git(fx.work, "rev-parse", "HEAD").trim());
});

test("rolling note: the refresher hands the vault port unmasked text so it can refuse, and a failed write keeps the old note and records the error", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  const port = vaultRecentContext({ memory, clone });
  assert.equal(port.refusesSecrets, true);
  const clock = new Date("2026-11-10T00:00:00Z");
  const threads = threadStore(undefined, () => clock);
  const model = scripted(() => say("ok"), { reply: () => `Note ${["sk", "-", "abcdefghijklmnop12345678"].join("")}` });
  const rc = recentContext({ port, threads, model, now: () => clock });
  const svc = threadService({ threads, model, proposals: newProposals(), recent: rc, now: () => clock });
  const t = threads.create();
  for (let i = 0; i < 3; i++) await svc.turn(t.id, `m${i}`, { memory: [], limits: [], tools: [] });
  await rc.idle();
  assert.match(rc.status().lastError!.detail, /NOT saved to the vault.*secret/);
  assert.equal((await port.read())?.text, "Old note about work.");
});

test("chat tools: direct write returns verified provenance; a protected edit becomes a proposal and nothing is written until confirmed", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  const proposals = newProposals();
  const ve = vaultEdits({ clone, memory, proposals });
  const tools = chatTools({ memory, toolbox: toolbox([]), vault: ve, notify: notifier(jsonStore(undefined, "n", [])), proposals, launchable: () => ({ routines: [] }) });
  const by = (n: string) => tools.find((t) => t.name === n)!;
  assert.deepEqual(tools.filter((t) => t.name.startsWith("vault_")).map((t) => t.name).sort(), ["vault_append_section", "vault_archive_note", "vault_create_note", "vault_policy", "vault_replace_text", "vault_set_frontmatter"]);

  const ok = await by("vault_append_section").run({ path: "Projects/alpha.md", heading: "## Notes", text: "- via tool" });
  assert.equal((ok.value as { saved: boolean }).saved, true);
  assert.match(ok.source, /^vault\/clone@[0-9a-f]{7} \(pushed to GitHub, remote head verified\)$/);

  const head = fx.remoteHead();
  const p = await by("vault_replace_text").run({ path: "AGENTS.md", find: "Section 3", replace: "Section Three" });
  const v = p.value as { status: string; proposalId: string; digest: string; saved: boolean };
  assert.equal(v.status, "pending-confirmation");
  assert.equal(v.saved, false);
  assert.equal(fx.remoteHead(), head, "proposing writes nothing");
  assert.equal(proposals.peek(v.proposalId)?.kind, "vault_edit");

  // Refusals and failures are errors, never a claim.
  await assert.rejects(by("vault_create_note").run({ path: "Elsewhere/x.md", content: "x" }), /NOT saved \(policy_refused\)/);
  await assert.rejects(by("vault_create_note").run({ path: "../x.md", content: "x" }), /NOT saved \(invalid_path\)/);
  await assert.rejects(by("vault_create_note").run({ path: "Inbox/x.md", content: "tok" + "en: " + "abcdefABCDEF1234567890abcdefABCDEF12" }), /NOT saved \(secret_refused\)/);
  await assert.rejects(by("vault_create_note").run({ path: "Inbox/x.md", content: "x", mode: "force" }), /Unexpected argument/);
  const policy = await by("vault_policy").run({});
  assert.match(JSON.stringify(policy.value), /Vault rules/);
  assert.match(JSON.stringify(policy.value), /agentsMdSha/);
});

test("server: vault edits are owner-only; the confirmation needs the exact digest, revalidates, and settles the card with the verified commit", async () => {
  const fx = makeFixture();
  const clone = fx.make();
  let ve!: ReturnType<typeof vaultEdits>;
  const model = scripted([
    { text: "", calls: [call("vault_replace_text", { path: "System/memory.md", find: "# Memory rules", replace: "# Memory rules (edited)" })] },
    say("Proposed; waiting for your click."),
    { text: "", calls: [call("vault_create_note", { path: "Inbox/direct.md", content: "hello" })] },
    say("Saved."),
  ]);
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  const r = rig({ model, extra: ({ proposals }) => ({ memory, vaultEdits: (ve = vaultEdits({ clone, memory, proposals })) }) });
  const t = await r.create("vault");
  const sent = await r.send(t.id, "edit the memory rules");
  assert.equal(sent.status, 200);
  const view = (await r.api(`/threads/${t.id}`)).data.thread;
  const card = view.cards[0];
  assert.equal(card.kind, "vault_edit");
  assert.equal(card.state, "open");
  assert.match(card.summary, /needs your confirmation: System\/ is protected/);
  assert.equal(card.display.operation, "replace_text");
  const head = fx.remoteHead();

  // Not the owner: refused at the policy port, nothing happens.
  r.caller.who = "someone@else.example";
  assert.equal((await r.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest })).status, 403);
  r.caller.who = OWNER;
  // Wrong or missing digest: nothing is written and the proposal stays open.
  assert.equal((await r.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: "0".repeat(64) })).status, 409);
  assert.equal((await r.api(`/chat/proposals/${card.id}/confirm`, "POST", {})).status, 409);
  assert.equal(fx.remoteHead(), head);
  assert.ok(r.proposals.peek(card.id));

  // A competing change makes the exact passage vanish: the confirmed edit revalidates and fails safely.
  fx.elsewhere({ "System/memory.md": "# Rules rewritten by Rai\n" });
  const bad = await r.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /Not saved/);
  assert.match(bad.data.error, /passage|not in/);
  const after = (await r.api(`/threads/${t.id}`)).data.thread.cards[0];
  assert.equal(after.state, "refused");
  assert.match(fx.remoteFile("System/memory.md"), /Rules rewritten by Rai/);

  // A fresh proposal with the passage present: confirmed, committed, verified, card shows the commit.
  const again = await ve.tools.find((x) => x.name === "vault_replace_text")!.run({ path: "System/conventions.md", find: "Machine id: orbit.", replace: "Machine id: orbit (confirmed)." });
  const pid = (again.value as { proposalId: string; digest: string }).proposalId;
  const dig = (again.value as { digest: string }).digest;
  const ok = await r.api(`/chat/proposals/${pid}/confirm`, "POST", { digest: dig });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.verifiedOnRemote, true);
  assert.equal(ok.data.commit, fx.remoteHead());
  assert.match(fx.remoteFile("System/conventions.md"), /orbit \(confirmed\)/);
  assert.match(fx.remoteFile(ok.data.logFile), /replaced a passage in System\/conventions\.md/);
  // Single use.
  assert.equal((await r.api(`/chat/proposals/${pid}/confirm`, "POST", { digest: dig })).status, 404);

  // A non-owner thread reply has no vault tools at all.
  r.caller.who = "someone@else.example";
  const refused = await r.api("/chat", "POST", { messages: [{ role: "user", content: "write a note" }] });
  assert.ok(!JSON.stringify(refused.data).includes("committed"));
  r.caller.who = OWNER;
  assert.equal(decide("vault", "vault_create_note", false).allow, false);
  assert.equal(decide("vault", "vault_create_note", true).allow, true);
  assert.equal(decide("config", "orbit_config_view", false).allow, false);
});

test("git runner: the credential is only in the child's environment, scoped to github.com; never in argv, URL or files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-fakegit-"));
  const log = join(dir, "log.json");
  writeFileSync(join(dir, "git"), `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), env: process.env}));\nconsole.error("fatal: could not read from https://x-access-token:${TOKEN}@github.com/o/r.git Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}");\nprocess.exit(1);\n`);
  chmodSync(join(dir, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const runner = gitRunner({ token: TOKEN, allowProtocols: "https" });
    await assert.rejects(runner.run(["fetch", "origin"], { cwd: dir }), (e: Error) => {
      assert.doesNotMatch(e.message, new RegExp(TOKEN));
      assert.doesNotMatch(e.message, /eC1hY2Nlc3MtdG9rZW46/);
      return true;
    });
    const seen = JSON.parse(readFileSync(log, "utf8")) as { argv: string[]; env: Record<string, string> };
    assert.ok(!JSON.stringify(seen.argv).includes(TOKEN), "not in argv");
    const header = Object.entries(seen.env).filter(([k]) => k.startsWith("GIT_CONFIG_KEY_")).map(([k, v]) => [v, seen.env[k.replace("KEY", "VALUE")]]);
    const auth = header.find(([k]) => /extraHeader/i.test(k!))!;
    assert.equal(auth[0], "http.https://github.com/.extraHeader");
    assert.equal(auth[1], `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    assert.equal(seen.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(seen.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.ok(header.some(([k, v]) => k === "core.hooksPath" && v === "/dev/null"));
    assert.equal(seen.env.GIT_AUTHOR_EMAIL, "orbit@users.noreply.github.com");
    assert.ok(!("CREDENTIALS_DIRECTORY" in seen.env) && !("ORBIT_OWNER" in seen.env), "the environment is minimal");
    assert.equal(runner.scrub(`url https://${TOKEN}@github.com ${TOKEN}`), "url https://[credential]@github.com [credential]");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("the credential file is read fresh each time and is optional", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-cred-"));
  const read = credentialFile({ CREDENTIALS_DIRECTORY: dir });
  assert.equal(read(), undefined);
  writeFileSync(join(dir, "orbit.github-vault"), `${TOKEN}\n`);
  assert.equal(read(), `${TOKEN}\n`);
  assert.equal(credentialFile({})(), undefined);
});

test("source guard: no force push, no plus refspec, no shell in the vault code", () => {
  for (const f of ["src/vault/clone.ts", "src/vault/git.ts", "src/vault/tools.ts", "src/vault/edit.ts"]) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /--force|force-with-lease|"-f"|\+HEAD|\+refs|shell:\s*true|execSync|exec\(|child_process.*\bexec\b/, f);
    assert.doesNotMatch(text, /rmSync|rmdirSync|git.*"rm"/, `${f} never deletes`);
  }
});

test("config view: allowlisted env as running, masked trigger ids, credential names and sizes only, deployed commit, routine file, port states, honest unavailability", async () => {
  const creds = mkdtempSync(join(tmpdir(), "orbit-creds-"));
  writeFileSync(join(creds, "orbit.openai"), "super-secret-model-key" + "-1234567890");
  const env = {
    ORBIT_MODEL: "gpt-5",
    ORBIT_ROUTINES: "orbit=" + "tri" + "g_" + "01ABCDEFGHIJKLMNOPQRSTUV",
    ORBIT_ROUTINE_REPOS: "orbit=DragonflyAI-sh/orbit",
    ORBIT_PUBLIC_JOB_URL: "https://orbit-jobs.example.ts.net",
    ORBIT_OWNER: "rai@example.com",
    OPENAI_API_KEY: "sk" + "-" + "shouldnotappear1234567890",
    ORBIT_SECRET_THING: "nope",
    CREDENTIALS_DIRECTORY: creds,
    ORBIT_COMMIT: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
    PORT: "8790",
  };
  const ops = { call: async (action: string) => (action === "credentials" ? { value: [{ directory: "/etc/credstore", entries: [{ name: "orbit.openai", type: "file", sizeBytes: 33 }], contentsRead: false }], provenance: "live" as const, source: "ops/credentials" } : (() => { throw new Error("orbit-ops is not available: the helper socket is not there."); })()) };
  const repoRoot = new URL("..", import.meta.url).pathname;
  const view = configView({ env, ops: ops as never, commit: env.ORBIT_COMMIT, repoRoot, now: () => new Date("2026-11-10T18:00:00Z") });
  const out = await view([{ port: "memory", state: "degraded", impl: "vault-keyword", detail: "FALLBACK: x", verifiedAt: "2026-11-10T17:59:00Z" }]);
  const text = JSON.stringify(out);
  assert.equal(out.provenance, "live");
  const v = out.value as any;
  assert.equal(v.env.value.ORBIT_MODEL, "gpt-5");
  assert.equal(v.env.value.ORBIT_ROUTINES, "orbit=trig_…STUV");
  assert.equal(v.env.value.ORBIT_INGRESS_PORT, "(not set)");
  assert.ok(!("ORBIT_OWNER" in v.env.value) && !("OPENAI_API_KEY" in v.env.value) && !("ORBIT_SECRET_THING" in v.env.value) && !("CREDENTIALS_DIRECTORY" in v.env.value));
  for (const secret of ["rai@example.com", "sk" + "-" + "shouldnotappear", "super-secret-model-key", "tri" + "g_" + "01ABCDEFGHIJKLMNOPQRSTUV", "nope"]) assert.ok(!text.includes(secret), secret);
  assert.equal(v.credentials.tier1.state, "ok");
  assert.equal(v.credentials.tier1.value[0].entries[0].sizeBytes, 33);
  assert.deepEqual(v.credentials.loadedByThisProcess.value.entries, [{ name: "orbit.openai", sizeBytes: 33, type: "file" }]);
  assert.match(v.credentials.loadedByThisProcess.value.vaultWriteCredential, /not loaded in this process/);
  assert.equal(v.deployedCommit.runningProcess, env.ORBIT_COMMIT);
  assert.equal(v.deployedCommit.tier1DeployState.state, "unavailable");
  assert.match(v.deployedCommit.tier1DeployState.reason, /not available/);
  assert.equal(v.routine.state, "ok");
  assert.match(v.routine.value.text, /ORBIT jobs: orbit-work \+ orbit/);
  assert.ok(!v.routine.value.text.includes("tri" + "g_" + "014eYpYTZa1Gviqjp2C92ZVd"), "the routine task id is masked");
  assert.match(v.routine.value.text, /trig_…2ZVd/);
  assert.equal(v.ports.value[0].state, "degraded");
  // With no ops client and no credentials directory everything says so instead of inventing values.
  const bare = await configView({ env: { ORBIT_COMMIT: "unknown" }, commit: "unknown", repoRoot: "/nonexistent" })([]);
  const b = bare.value as any;
  assert.equal(b.credentials.tier1.state, "unavailable");
  assert.equal(b.credentials.loadedByThisProcess.state, "unavailable");
  assert.equal(b.routine.state, "unavailable");
});

test("config view is a tool without arguments and offers no way to change anything", async () => {
  const proposals = newProposals();
  let calls = 0;
  const tools = chatTools({ memory: { name: "memory", status: () => ({ port: "memory", state: "live", impl: "x", detail: "", verifiedAt: "" }), search: () => ({ value: [], provenance: "live", source: "x" }), read: () => ({ value: "", provenance: "live", source: "x" }) }, toolbox: toolbox([]), notify: notifier(jsonStore(undefined, "n", [])), proposals, launchable: () => ({ routines: [] }), config: async () => (calls++, { value: { ok: true }, provenance: "live", source: "config-view" }) });
  const t = tools.find((x) => x.name === "orbit_config_view")!;
  assert.deepEqual((t.parameters as { properties: object }).properties, {});
  await assert.rejects(t.run({ key: "ORBIT_MODEL", value: "x" }), /no arguments/);
  assert.equal(calls, 0);
  assert.equal((await t.run({})).source, "config-view");
  assert.match(t.description, /cannot change anything/);
  assert.equal(proposals.list().length, 0);
});

void mkdirSync;
void later;
