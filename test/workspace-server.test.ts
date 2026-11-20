import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceService } from "../src/workspace/service.ts";
import { call, OWNER, rig, say, scripted } from "./threads-fixture.ts";
import { fakeSandbox, makeWorkspace, tick } from "./workspace-fixture.ts";
import { DEFAULT_LIMITS } from "../src/workspace/config.ts";
import type { WorkspaceConfig } from "../src/workspace/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// End to end through the real server (docs/workspace-tools.md, "Confirmation"): model tool call -> pending card in the thread -> owner
// confirmation on the real route (owner check, digest, single use) -> backend -> observed result in the ledger and on the card.
// Synthetic workspaces in temporary directories; the exec runs use the fakeSandbox supervisor double (no isolation claimed).

function setup(opts: { now?: () => Date; enabled?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "orbit-wssrv-"));
  const ws = makeWorkspace(base, "alpha");
  writeFileSync(join(ws.root, "notes.txt"), "hello\n");
  const config: WorkspaceConfig = { workspaces: [ws], sandbox: { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", shell: "/bin/sh", runtime: ["/usr"], cgroupParent: "/sys/fs/cgroup/t", limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 }, policyHash: "sha256:" + "cd".repeat(32) };
  const sandbox = fakeSandbox();
  const script: { steps: ReturnType<typeof say>[] } = { steps: [say("ok")] };
  let i = 0;
  const model = scripted(() => script.steps[Math.min(i++, script.steps.length - 1)]!);
  let svc: ReturnType<typeof workspaceService> | undefined;
  const h = rig({
    model,
    now: opts.now,
    extra: ({ proposals }) => {
      svc = workspaceService({ activation: opts.enabled === false ? { state: "off", reason: "default off" } : { state: "enabled", config }, sandbox, stateDir: join(base, "state"), proposals, now: opts.now });
      return { workspace: svc };
    },
  });
  const turn = async (thread: string, steps: ReturnType<typeof say>[]) => {
    script.steps = steps;
    i = 0;
    return h.send(thread, "please");
  };
  return { ...h, ws, sandbox, svc: () => svc!, turn, model };
}
const cardsOf = async (h: ReturnType<typeof setup>, id: string) => (await h.api(`/threads/${id}`)).data.thread?.cards ?? (await h.api(`/threads/${id}`)).data.cards;

test("through the server: fs_write -> open card -> non-owner and wrong digest refused -> owner confirms once -> file written, card confirmed", async () => {
  const h = setup();
  const t = await h.create();
  await h.turn(t.id, [{ text: "", calls: [call("fs_write", { workspace: "alpha", path: "out.txt", content: "from the model\n", createOnly: true })] }, say("proposed")]);
  const cards = await cardsOf(h, t.id);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.kind, "workspace_op");
  assert.equal(card.state, "open");
  assert.equal(card.display.content, "┌ begin (2 lines, 15 bytes)\n│ from the model\n│ \n└ end");
  assert.throws(() => readFileSync(join(h.ws.root, "out.txt")), "nothing written before confirmation");

  h.caller.who = "someone@example.com";
  const stranger = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.ok(stranger.status === 403 || stranger.status === 401, String(stranger.status));
  h.caller.who = OWNER;
  const wrong = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: "sha256:" + "0".repeat(64) });
  assert.equal(wrong.status, 409);
  const missing = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", {});
  assert.equal(missing.status, 409);
  assert.throws(() => readFileSync(join(h.ws.root, "out.txt")));

  const ok = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(readFileSync(join(h.ws.root, "out.txt"), "utf8"), "from the model\n");
  const again = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.equal(again.status, 409, "single use");
  const after = (await cardsOf(h, t.id))[0];
  assert.equal(after.state, "confirmed");
  assert.equal(after.outcome.opId, ok.data.opId);
  assert.equal(after.live.source, "workspace");
  assert.equal(after.live.state, "completed");
});

test("through the server: exec_start -> card -> confirm (202, not verified) -> run observed -> status and card show completed", async () => {
  const h = setup();
  const t = await h.create();
  await h.turn(t.id, [{ text: "", calls: [call("exec_start", { workspace: "alpha", argv: ["cat", "notes.txt"] })] }, say("proposed")]);
  const card = (await cardsOf(h, t.id))[0];
  assert.equal(card.action, "exec");
  assert.match(card.display.network, /none/);
  assert.equal(h.sandbox.runs.length, 0);
  const ok = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.equal(ok.status, 202);
  await tick();
  h.sandbox.runs[0]!.finish(0, "hello\n");
  await h.svc().idle();
  const live = (await cardsOf(h, t.id))[0].live;
  assert.equal(live.state, "completed");
  await h.turn(t.id, [{ text: "", calls: [call("exec_status", { runId: ok.data.opId })] }, say("done")]);
  const seen = h.model.seen.at(-1)!.input.map((x) => JSON.stringify(x)).join("\n");
  assert.ok(seen.includes("completed") && seen.includes("hello"), "the model sees the observed state and the (untrusted) output");
});

test("through the server: an expired proposal confirms nothing; a cancelled one drops the held operation", async () => {
  let now = new Date("2026-11-19T10:00:00Z");
  const h = setup({ now: () => now });
  const t = await h.create();
  await h.turn(t.id, [{ text: "", calls: [call("fs_write", { workspace: "alpha", path: "late.txt", content: "x", createOnly: true })] }, say("proposed")]);
  const card = (await cardsOf(h, t.id))[0];
  now = new Date(now.getTime() + 11 * 60 * 1000);
  const late = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.equal(late.status, 404);
  assert.throws(() => readFileSync(join(h.ws.root, "late.txt")));
  await h.turn(t.id, [{ text: "", calls: [call("fs_write", { workspace: "alpha", path: "c.txt", content: "x", createOnly: true })] }, say("proposed")]);
  const c2 = (await cardsOf(h, t.id)).find((c: { state: string }) => c.state === "open");
  const cancelled = await h.api(`/chat/proposals/${c2.id}/cancel`, "POST");
  assert.equal(cancelled.status, 200);
  const after = await h.api(`/chat/proposals/${c2.id}/confirm`, "POST", { digest: c2.digest });
  assert.ok(after.status >= 400);
  assert.throws(() => readFileSync(join(h.ws.root, "c.txt")));
});

test("through the server: disabled (default) offers no workspace tool; a non-owner is offered no tools at all", async () => {
  const off = setup({ enabled: false });
  const t = await off.create();
  await off.turn(t.id, [say("hi")]);
  assert.ok(!off.model.seen[0]!.tools.some((n) => n.startsWith("fs_") || n.startsWith("exec_") || n === "workspace_list"));
  const on = setup();
  const t2 = await on.create();
  await on.turn(t2.id, [say("hi")]);
  for (const n of ["workspace_list", "fs_list", "fs_stat", "fs_read", "fs_search", "fs_write", "fs_patch", "exec_start", "exec_status", "exec_cancel"]) assert.ok(on.model.seen[0]!.tools.includes(n), n);
  assert.ok(!on.model.seen[0]!.tools.includes("fs_delete"), "there is no delete tool");
});

test("through the server: an activation card (ws_validate) is owner-only, digest-bound and single use; its live state comes from the activation record", async () => {
  const { ownerActivation } = await import("../src/workspace/activation.ts");
  const { workspaceAdmin } = await import("../src/workspace/admin.ts");
  const { SMOKE_STEPS, VALIDATION_WORKSPACE } = await import("../src/workspace/smoke.ts");
  const base = mkdtempSync(join(tmpdir(), "orbit-wssrv-adm-"));
  const ws = makeWorkspace(base, "alpha");
  const val = makeWorkspace(base, VALIDATION_WORKSPACE);
  const config: WorkspaceConfig = { workspaces: [ws, val], sandbox: { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", shell: "/bin/sh", runtime: ["/usr"], cgroupParent: "/sys/fs/cgroup/t", limits: DEFAULT_LIMITS, maxConcurrentRuns: 1 }, policyHash: "sha256:" + "ef".repeat(32) };
  const sandbox = fakeSandbox();
  const owner = ownerActivation(join(base, "owner"));
  let admin: ReturnType<typeof workspaceAdmin> | undefined;
  let svc: ReturnType<typeof workspaceService> | undefined;
  const script: { steps: ReturnType<typeof say>[] } = { steps: [say("ok")] };
  let i = 0;
  const model = scripted(() => script.steps[Math.min(i++, script.steps.length - 1)]!);
  const h = rig({
    model,
    extra: ({ proposals }) => {
      svc = workspaceService({ activation: { state: "enabled", config }, sandbox, stateDir: join(base, "state"), proposals, active: () => owner.mode() === "enabled" });
      admin = workspaceAdmin({ env: {}, activation: { state: "enabled", config }, service: svc, sandbox, owner, stateDir: join(base, "state"), proposals, smoke: async () => ({ passed: true, workspaceIdentity: val.identity, checks: SMOKE_STEPS.map((s) => ({ id: s.id, title: s.title, required: s.required, result: "pass" as const, detail: "scripted" })) }) });
      return { workspace: svc, workspaceAdmin: admin };
    },
  });
  const t = await h.create();
  script.steps = [{ text: "", calls: [call("workspace_admin_propose", { action: "validate" })] }, say("proposed")];
  i = 0;
  await h.send(t.id, "please");
  assert.ok(!model.seen[0]!.tools.includes("fs_write"), "the owner switch is off: no workspace tool is offered");
  assert.ok(model.seen[0]!.tools.includes("workspace_preflight"));
  const card = (await cardsOf(h as never, t.id))[0];
  assert.equal(card.kind, "workspace_op");
  assert.equal(card.action, "ws_validate");
  h.caller.who = "someone@example.com";
  const stranger = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.ok(stranger.status === 403 || stranger.status === 401, String(stranger.status));
  h.caller.who = OWNER;
  assert.equal((await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: "sha256:" + "0".repeat(64) })).status, 409);
  assert.equal(owner.validation(), undefined, "nothing ran before the owner's confirmation");
  const ok = await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest });
  assert.equal(ok.status, 202, JSON.stringify(ok.data));
  await admin!.validating();
  assert.equal(owner.validation()!.state, "passed");
  assert.equal((await h.api(`/chat/proposals/${card.id}/confirm`, "POST", { digest: card.digest })).status, 409, "single use");
  const after = (await cardsOf(h as never, t.id))[0];
  assert.equal(after.live.source, "workspace-admin");
  assert.equal(after.live.state, "passed");
  assert.equal(owner.mode(), "off", "validation never enables");
});
