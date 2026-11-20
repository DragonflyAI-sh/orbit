import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Proposal } from "../src/agent.ts";
import { enableBlockers, ownerActivation, VALIDATION_MAX_AGE_MS } from "../src/workspace/activation.ts";
import type { ValidationRecord } from "../src/workspace/activation.ts";
import { DISPATCH_GRACE_MS, hostOpIdFor, parsePlan, workspaceAdmin } from "../src/workspace/admin.ts";
import type { WsHostClient, WsReply } from "../src/workspace/admin.ts";
import { ensureRunParent, ownCgroup } from "../src/workspace/cgroup.ts";
import { makeWorkspace, tick, wsRig, fakeSandbox } from "./workspace-fixture.ts";
import type { FakeRun } from "./workspace-fixture.ts";
import { runSmoke, SMOKE_STEPS, VALIDATION_WORKSPACE } from "../src/workspace/smoke.ts";
import type { RunExit, RunHandle, RunSpec, Sandbox } from "../src/workspace/sandbox.ts";
import { workspaceService } from "../src/workspace/service.ts";

// The owner-confirmed activation path (docs/workspace-tools.md, "Activation"): owner switch, enable gating on a passing validation for
// the current policy, disable with honest reporting, host setup dispatched to the root helper exactly as shown, and the bounded smoke
// harness. Synthetic temporary directories and test doubles only. The doubles test ORBIT's gating and reporting logic; they are NOT
// evidence of OS isolation (that is what the on-host validation itself provides, under the real sandbox).

const T0 = new Date("2026-11-19T10:00:00.000Z");

function rig(opts: { sandboxState?: "supported" | "unsupported"; host?: WsHostClient; disableWaitMs?: number; smokePass?: boolean; smokeGate?: Promise<void> } = {}) {
  const sb = fakeSandbox({ state: opts.sandboxState ?? "supported" });
  const r = wsRig({ sandbox: sb });
  // Add the validation workspace to the configuration (the host setup creates it).
  const v = makeWorkspace(r.base, VALIDATION_WORKSPACE);
  r.config.workspaces.push(v);
  const stateDir = mkdtempSync(join(tmpdir(), "orbit-wsact-"));
  // What ORBIT runs with now (select.ts builds the same from the live configuration and sandbox); tests may change it.
  const cur = { policyHash: r.config.policyHash, validationIdentity: v.identity as string | undefined, permitted: true };
  const current = () => (cur.permitted ? { policyHash: cur.policyHash, sandboxPolicy: sb.policyId(), sandboxState: sb.status().state, validationIdentity: cur.validationIdentity } : undefined);
  const owner = ownerActivation(stateDir, current);
  let clock = T0;
  const notes: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const svc = workspaceService({ activation: { state: "enabled", config: r.config }, sandbox: sb, stateDir: join(stateDir, "svc"), proposals: r.proposals, active: () => owner.mode() === "enabled" });
  let smokeCalls = 0;
  const admin = workspaceAdmin({
    env: {},
    activation: { state: "enabled", config: r.config },
    service: svc,
    sandbox: sb,
    owner,
    stateDir,
    proposals: r.proposals,
    host: opts.host,
    notify: (t) => notes.push(t),
    audit: (e) => audits.push(e as Record<string, unknown>),
    now: () => clock,
    disableWaitMs: opts.disableWaitMs ?? 200,
    smoke: async () => {
      smokeCalls++;
      await opts.smokeGate;
      const pass = opts.smokePass ?? true;
      return { passed: pass, workspaceIdentity: v.identity, checks: SMOKE_STEPS.map((s) => ({ id: s.id, title: s.title, required: s.required, result: pass || s.id !== "network_isolated" ? ("pass" as const) : ("fail" as const), detail: "scripted" })) };
    },
  });
  const take = (id: string) => r.proposals.take(id) as Proposal & { kind: "workspace_op" };
  const tool = (n: string) => admin.tools.find((t) => t.name === n)!;
  const propose = async (action: string) => ((await tool("workspace_admin_propose").run({ action })) as { value: { proposalId: string } }).value;
  const validate = async () => {
    const p = await propose("validate");
    const c = await admin.confirm(take(p.proposalId));
    await admin.validating();
    return c;
  };
  return { ...r, sb, v, owner, svc, admin, stateDir, notes, audits, take, tool, propose, validate, cur, current, smokeCalls: () => smokeCalls, setClock: (d: Date) => (clock = d) };
}

// ---- the owner switch ----------------------------------------------------------------------------------------------------------

test("owner switch: default off; a corrupt or foreign record is off; enabled persists across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-wsact-own-"));
  assert.equal(ownerActivation(dir).mode(), "off");
  writeFileSync(join(dir, "activation.json"), "{not json");
  assert.equal(ownerActivation(dir).mode(), "off");
  writeFileSync(join(dir, "activation.json"), JSON.stringify({ schema: 1, mode: "ENABLED" }));
  assert.equal(ownerActivation(dir).mode(), "off");
  writeFileSync(join(dir, "activation.json"), JSON.stringify({ schema: 2, mode: "enabled" }));
  assert.equal(ownerActivation(dir).mode(), "off");
  // Enabled needs a binding to a passed validation of exactly what runs now (finding 1 of the PR #147 review).
  assert.throws(() => ownerActivation(dir).set("enabled", { at: T0.toISOString(), proposalId: "p1" }), /binding/);
  const binding = { validationId: "val-a", validatedAt: T0.toISOString(), policyHash: "P", sandboxPolicy: "S", validationIdentity: "W" };
  const now = () => ({ policyHash: "P", sandboxPolicy: "S", sandboxState: "supported", validationIdentity: "W" });
  ownerActivation(dir).saveValidation({ id: "val-a", state: "passed", startedAt: T0.toISOString(), finishedAt: T0.toISOString(), proposalId: "p", policyHash: "P", sandboxPolicy: "S", workspaceIdentity: "W", checks: [] });
  ownerActivation(dir).set("enabled", { at: T0.toISOString(), proposalId: "p1", binding });
  assert.equal(ownerActivation(dir, now).mode(), "enabled", "persists across a restart while the binding holds");
  assert.equal(ownerActivation(dir).mode(), "off", "nothing to compare with: off (and not reset)");
  assert.equal(ownerActivation(dir, now).mode(), "enabled");
  // A hand-written "enabled" without a binding is off, and is reset.
  writeFileSync(join(dir, "activation.json"), JSON.stringify({ schema: 1, mode: "enabled" }));
  assert.equal(ownerActivation(dir, now).mode(), "off");
  assert.equal(ownerActivation(dir, now).record().mode, "off");
  assert.equal(ownerActivation(undefined).mode(), "off", "no state directory: nothing can be switched on");
});

test("owner switch: a validation that was running when ORBIT stopped is 'interrupted' after the restart, never passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-wsact-int-"));
  ownerActivation(dir).saveValidation({ id: "val-1", state: "running", startedAt: T0.toISOString(), proposalId: "p", policyHash: "h", sandboxPolicy: "s", workspaceIdentity: "w", checks: [] });
  assert.equal(ownerActivation(dir).validation()!.state, "interrupted");
});

test("service gate: with the owner switch off the model gets no workspace tool and every held confirmation is refused", async () => {
  let on = true;
  const r = wsRig();
  const svc = workspaceService({ activation: { state: "enabled", config: r.config }, sandbox: r.sandbox, stateDir: mkdtempSync(join(tmpdir(), "orbit-wsact-gate-")), proposals: r.proposals, active: () => on });
  const p = (await svc.tools.find((t) => t.name === "fs_write")!.run({ workspace: "alpha", path: "g.txt", content: "x", createOnly: true })) as { value: { proposalId: string } };
  on = false;
  assert.deepEqual(svc.tools, []);
  assert.equal(svc.active, false);
  const out = await svc.confirm(r.proposals.take(p.value.proposalId) as never);
  assert.equal(out.code, 503);
  assert.match(String(out.body.error), /switched off by the owner/);
  assert.equal(existsSync(join(r.a.root, "g.txt")), false);
});

// ---- enable gating ---------------------------------------------------------------------------------------------------------------

const passed = (o: Partial<ValidationRecord> = {}): ValidationRecord => ({ id: "val-a", state: "passed", startedAt: T0.toISOString(), finishedAt: T0.toISOString(), proposalId: "p", policyHash: "P", sandboxPolicy: "S", workspaceIdentity: "W", checks: [], ...o });
test("enableBlockers: every precondition is required, and each failure is named", () => {
  const base = { configured: true, sandboxState: "supported", sandboxPolicy: "S", policyHash: "P", validationIdentity: "W", quarantined: [], validation: passed(), now: T0 };
  assert.deepEqual(enableBlockers(base), []);
  assert.match(enableBlockers({ ...base, configured: false, hostReason: "flag off" }).join(), /host does not permit/);
  assert.match(enableBlockers({ ...base, sandboxState: "unsupported", sandboxReasons: ["no userns"] }).join(), /self-test has not passed.*no userns/);
  assert.match(enableBlockers({ ...base, quarantined: ["ws-1"] }).join(), /not confirmed gone/);
  assert.match(enableBlockers({ ...base, validation: undefined }).join(), /no synthetic validation/);
  assert.match(enableBlockers({ ...base, validation: passed({ state: "failed" }) }).join(), /did not pass/);
  assert.match(enableBlockers({ ...base, validation: passed({ policyHash: "OTHER" }) }).join(), /different sandbox policy/);
  assert.match(enableBlockers({ ...base, validation: passed({ sandboxPolicy: "bwrap:0.12" }) }).join(), /different sandbox implementation/);
  assert.match(enableBlockers({ ...base, validation: passed({ workspaceIdentity: "X" }) }).join(), /different validation workspace/);
  assert.match(enableBlockers({ ...base, now: new Date(T0.getTime() + VALIDATION_MAX_AGE_MS + 1) }).join(), /older than 24 hours/);
});

test("enable: refused (no proposal) before a validation passed; after it, one confirmation turns the tools on and says what it observed", async () => {
  const r = rig();
  await assert.rejects(r.propose("enable"), /no synthetic validation/);
  assert.equal(r.proposals.list().length, 0);
  const c = await r.validate();
  assert.equal(c.code, 202);
  assert.equal(r.owner.validation()!.state, "passed");
  assert.equal(r.owner.mode(), "off", "a passing validation alone enables nothing");
  assert.deepEqual(r.svc.tools, []);
  const p = await r.propose("enable");
  assert.deepEqual(r.svc.tools, [], "proposing enables nothing");
  const card = r.proposals.peek(p.proposalId) as Proposal & { kind: "workspace_op" };
  assert.match(card.display.evidence, /validation val-[0-9a-f]{16} passed/);
  const out = await r.admin.confirm(r.take(p.proposalId));
  assert.equal(out.code, 200, JSON.stringify(out.body));
  assert.equal(out.body.verified, true);
  assert.equal(r.owner.mode(), "enabled");
  assert.ok((r.svc.tools as { name: string }[]).some((t) => t.name === "exec_start"));
  // Replay of the same approval: nothing (the held operation is spent).
  assert.equal((await r.admin.confirm(card)).code, 410);
});

test("enable: a failed validation, an unsupported sandbox, or an unverified cleanup blocks it", async () => {
  const failing = rig({ smokePass: false });
  await failing.validate();
  assert.equal(failing.owner.validation()!.state, "failed");
  assert.match(failing.owner.validation()!.summary!, /network_isolated/);
  await assert.rejects(failing.propose("enable"), /did not pass/);
  const unsupported = rig({ sandboxState: "unsupported" });
  await assert.rejects(unsupported.propose("validate"), /self-test has not passed/);
  const q = rig();
  await q.validate();
  q.svc.ledger.put({ opId: "ws-00000000000000f1", proposalId: "x", kind: "exec", workspace: "alpha", digest: "d", state: "completed", createdAt: "t", updatedAt: "t", events: [{ at: "t", state: "running" }], summary: "s", treeGone: false });
  await assert.rejects(q.propose("enable"), /not confirmed gone/);
});

test("enable: a card whose validation or policy changed before the click is refused; a forged digest changes nothing", async () => {
  const r = rig();
  await r.validate();
  const p = await r.propose("enable");
  // A newer validation (a different record) replaces the one the card showed.
  r.owner.saveValidation({ ...r.owner.validation()!, id: "val-ffffffffffffffff" });
  const out = await r.admin.confirm(r.take(p.proposalId));
  assert.equal(out.code, 409);
  assert.equal(r.owner.mode(), "off");
  const p2 = await r.propose("enable");
  const forged = { ...(r.take(p2.proposalId) as Proposal & { kind: "workspace_op" }), digest: `sha256:${"0".repeat(64)}` };
  assert.equal((await r.admin.confirm(forged)).code, 409);
  assert.equal(r.owner.mode(), "off");
});

test("validation: refused while the tools are on; the record binds the policy, the sandbox implementation and the validation workspace", async () => {
  const r = rig();
  await r.validate();
  const v = r.owner.validation()!;
  assert.equal(v.policyHash, r.config.policyHash);
  assert.equal(v.sandboxPolicy, r.sb.policyId());
  assert.equal(v.workspaceIdentity, r.v.identity);
  assert.equal(v.checks.length, SMOKE_STEPS.length);
  const p = await r.propose("enable");
  await r.admin.confirm(r.take(p.proposalId));
  await assert.rejects(r.propose("validate"), /only while the tools are switched off/);
  assert.ok(r.notes.some((n) => /validation passed/.test(n)));
});

// ---- disable ---------------------------------------------------------------------------------------------------------------------

async function enabled(opts: Parameters<typeof rig>[0] = {}) {
  const r = rig(opts);
  await r.validate();
  const p = await r.propose("enable");
  await r.admin.confirm(r.take(p.proposalId));
  return r;
}

test("disable: the switch goes off first; queued runs are withdrawn; a running one is reported cancelled only once its exit was observed", async () => {
  const r = await enabled();
  const exec = r.svc.tools.find((t) => t.name === "exec_start")!;
  const p1 = ((await exec.run({ workspace: "alpha", argv: ["sleep", "100"] })) as { value: { proposalId: string } }).value;
  const p2 = ((await exec.run({ workspace: "beta", argv: ["true"] })) as { value: { proposalId: string } }).value;
  const c1 = await r.svc.confirm(r.take(p1.proposalId));
  const c2 = await r.svc.confirm(r.take(p2.proposalId));
  await tick();
  assert.equal(c2.body.state, "queued");
  const d = await r.propose("disable");
  const out = await r.admin.confirm(r.take(d.proposalId));
  assert.equal(out.code, 200);
  assert.equal(r.owner.mode(), "off");
  assert.deepEqual(r.svc.tools, []);
  assert.deepEqual(out.body.withdrawn, [String(c2.body.opId)]);
  const killed = out.body.killed as { opId: string; state: string; processTreeGone: boolean | null; note: string }[];
  assert.equal(killed.length, 1);
  assert.equal(killed[0]!.opId, String(c1.body.opId));
  assert.equal(killed[0]!.state, "cancelled");
  assert.equal(killed[0]!.processTreeGone, true);
  assert.equal(r.svc.ledger.get(String(c2.body.opId))!.state, "cancelled");
});

test("disable: a run whose exit is not observed in time is reported as still running (kill sent), never as cleaned up", async () => {
  const r = await enabled({ disableWaitMs: 50 });
  // A run that ignores the kill (the double resolves only when the test says so).
  const runs: FakeRun[] = r.sb.runs;
  const exec = r.svc.tools.find((t) => t.name === "exec_start")!;
  const p = ((await exec.run({ workspace: "alpha", argv: ["sleep", "100"] })) as { value: { proposalId: string } }).value;
  const c = await r.svc.confirm(r.take(p.proposalId));
  await tick();
  const handle = runs[0]!;
  const d = await r.propose("disable");
  // Emulate a run that does not die when killed: drain reports the kill request but the double is never resolved by it.
  (r.svc as unknown as { drain: (why: string) => { withdrawn: string[]; killRequested: string[] } }).drain = () => ({ withdrawn: [], killRequested: [String(c.body.opId)] });
  const out = await r.admin.confirm(r.take(d.proposalId));
  const killed = out.body.killed as { state: string; note: string }[];
  assert.equal(killed[0]!.state, "running");
  assert.match(killed[0]!.note, /NOT been observed/);
  assert.match(String(out.body.message), /not observed yet/);
  handle.finish(0);
  await r.svc.idle();
});

// ---- setup through the root helper -----------------------------------------------------------------------------------------------

function fakeHost(plan: Record<string, unknown>, opts: { reply?: (action: string, opId: string, key?: string) => WsReply } = {}) {
  const calls: { action: string; opId: string; planKey?: string }[] = [];
  const host: WsHostClient = {
    status: async () => ({ ok: true, data: { plan } }),
    call: async (action, opId, planKey) => {
      calls.push({ action, opId, ...(planKey ? { planKey } : {}) });
      if (opts.reply) return opts.reply(action, opId, planKey);
      if (action === "op_status") return { ok: true, data: { operation: { state: "verified", summary: "all steps done; /status healthy on the same commit", finishedAt: T0.toISOString() } } };
      return { ok: true, data: { operation: { state: "accepted" } } };
    },
  };
  return { host, calls };
}
const PLAN = {
  planKey: Array.from({ length: 24 }, (_, i) => (i % 16).toString(16)).join(""), // synthetic 24-hex fixture built at runtime (no key-shaped literal)
  steps: [
    { id: "package_bubblewrap", title: "bubblewrap package", state: "todo", action: "apt-get install -y --no-install-recommends bubblewrap" },
    { id: "identity", title: "static system user orbit", state: "done", detail: "exists" },
    { id: "service_dropin", title: "orbit.service drop-in", state: "todo", action: "write /etc/systemd/system/orbit.service.d/60-orbit-workspace.conf:\n[Service]\nDelegate=memory pids cpu" },
  ],
  blockers: [{ id: "apparmor_userns", title: "AppArmor restricts unprivileged user namespaces", detail: "operator decision" }],
};

test("setup: the card shows every planned step verbatim, what is already done and what needs separate operator approval; confirm dispatches exactly that plan key once", async () => {
  const { host, calls } = fakeHost(PLAN);
  const r = rig({ host });
  const p = await r.propose("setup");
  const card = r.proposals.peek(p.proposalId) as Proposal & { kind: "workspace_op" };
  assert.equal(card.action, "ws_setup");
  assert.equal(card.display["step 1: bubblewrap package"], "apt-get install -y --no-install-recommends bubblewrap");
  assert.match(card.display["step 2: orbit.service drop-in"]!, /┌ begin \(3 lines/);
  assert.match(card.display["already done (unchanged)"]!, /static system user orbit/);
  assert.match(card.display["NOT done by this (needs separate operator approval)"]!, /AppArmor/);
  assert.equal(card.display["plan key"], PLAN.planKey);
  assert.equal(calls.length, 0, "proposing sends nothing to the helper");
  const out = await r.admin.confirm(r.take(p.proposalId));
  assert.equal(out.code, 202);
  assert.equal(out.body.verified, false);
  assert.deepEqual(calls, [{ action: "ws_setup", opId: hostOpIdFor(p.proposalId), planKey: PLAN.planKey }]);
  assert.equal((await r.admin.confirm(card)).code, 410, "a replay sends nothing");
  assert.equal(calls.length, 1);
  await r.admin.refresh();
  const st = r.admin.status();
  assert.equal(st.hostOperations[0]!.state, "verified");
  await r.admin.refresh();
  assert.equal(r.notes.filter((n) => /host setup verified/.test(n)).length, 1, "the result is reported once");
  assert.equal(r.owner.mode(), "off", "setup never enables the tools");
});

test("setup: no proposal when the helper is missing, refuses, has nothing to do, or sends a malformed plan; a helper refusal at dispatch is 'not dispatched'", async () => {
  await assert.rejects(rig().propose("setup"), /not available here/);
  const refusing: WsHostClient = { status: async () => ({ ok: false, code: "unavailable", message: "socket missing" }), call: async () => ({ ok: false, code: "x", message: "x" }) };
  await assert.rejects(rig({ host: refusing }).propose("setup"), /refused or is unavailable/);
  const done = fakeHost({ ...PLAN, steps: PLAN.steps.map((s) => ({ ...s, state: "done" })) });
  await assert.rejects(rig({ host: done.host }).propose("setup"), /Nothing to set up.*AppArmor/s);
  const bad = fakeHost({ ...PLAN, planKey: "nope" });
  await assert.rejects(rig({ host: bad.host }).propose("setup"), /malformed/);
  const changed = fakeHost(PLAN, { reply: () => ({ ok: false, code: "plan_changed", message: "the host plan differs from the confirmed one; nothing was done" }) });
  const r = rig({ host: changed.host });
  const p = await r.propose("setup");
  const out = await r.admin.confirm(r.take(p.proposalId));
  assert.equal(out.code, 502);
  assert.equal(r.admin.status().hostOperations[0]!.state, "not_dispatched");
});

test("setup: helper-provided text with invisible or bidi characters is shown escaped on the card", async () => {
  const { host } = fakeHost({ ...PLAN, steps: [{ id: "x", title: "step", state: "todo", action: "write /etc/x‮;rm" }] });
  const r = rig({ host });
  const p = await r.propose("setup");
  const card = r.proposals.peek(p.proposalId) as Proposal & { kind: "workspace_op" };
  assert.equal(card.display["step 1: step"], "write /etc/x⟨U+202E⟩;rm");
});

test("parsePlan: steps need ids and states; the plan key is 24 hex", () => {
  assert.throws(() => parsePlan({ plan: { steps: [{ title: "x" }], planKey: "0".repeat(24) } }), /malformed step/);
  assert.throws(() => parsePlan({ plan: { steps: [], planKey: "0".repeat(64) } }), /malformed/);
  assert.equal(parsePlan({ plan: { steps: [], planKey: "a".repeat(24), blockers: ["needs x"] } }).blockers[0]!.detail, "needs x");
  // The helper's real shape: blockers beside the plan.
  assert.equal(parsePlan({ plan: { steps: [], planKey: "a".repeat(24) }, blockers: [{ id: "apparmor_userns", detail: "restricted" }] }).blockers[0]!.id, "apparmor_userns");
});

// ---- preflight and model paths ------------------------------------------------------------------------------------------------------

test("preflight: read-only, names the next step, and never echoes environment values", async () => {
  const r = rig();
  const secretShaped = "ghp_" + "Zq9".repeat(12);
  const pf = workspaceAdmin({ env: { ORBIT_WORKSPACE_TOOLS: "enabled", SOME_TOKEN: secretShaped }, activation: { state: "enabled", config: r.config }, service: r.svc, sandbox: r.sb, owner: r.owner, proposals: r.proposals });
  const out = await pf.preflight();
  const text = JSON.stringify(out);
  assert.ok(!text.includes(secretShaped));
  for (const id of ["platform", "not_root", "bubblewrap", "prlimit", "user_namespaces", "cgroup_v2", "cgroup_delegation", "host_permission", "workspaces", "validation_workspace", "sandbox_self_test", "cleanup", "validation", "owner_switch"]) assert.ok(out.checks.some((c) => c.id === id), id);
  assert.match(out.nextStep, /validation/);
  assert.equal(r.owner.mode(), "off");
  assert.equal(r.proposals.list().length, 0, "preflight proposes nothing");
});

test("model paths: the admin tools only propose; unknown actions and extra arguments are refused; they are offered only when there is something to administer", async () => {
  const r = rig();
  await assert.rejects(r.tool("workspace_admin_propose").run({ action: "rm -rf /" }), /must be one of/);
  await assert.rejects(r.tool("workspace_admin_propose").run({ action: "enable", path: "/etc" }), /Unknown argument/);
  await assert.rejects(r.tool("workspace_preflight").run({ path: "/" }), /no arguments/);
  const hidden = workspaceAdmin({ env: {}, activation: { state: "off", reason: "default off" }, service: r.svc, owner: r.owner, proposals: r.proposals, offered: () => false });
  assert.deepEqual(hidden.tools, []);
});

// ---- the smoke harness (driven by a SCRIPTED launcher: logic only, no isolation claimed) ---------------------------------------------

// A launcher double that behaves like a correctly isolated sandbox for the fixed smoke commands, or like a leaky one.
function scriptedLauncher(o: { leaky?: boolean; state?: "supported" | "unsupported" } = {}): Sandbox & { started: RunSpec[] } {
  const started: RunSpec[] = [];
  const exit = (x: Partial<RunExit>): RunExit => ({ code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: { stdout: false, stderr: false }, treeGone: true, ...x });
  const transcript = (leaky: boolean) =>
    [
      `uid=1000`,
      `ifaces=lo,${leaky ? "eth0," : ""}`,
      `routes=${leaky ? 1 : 0}`,
      "capeff=0000000000000000",
      "nnp=1",
      ...(leaky ? ["visible=/etc/shadow"] : []),
      "env=HOME,LANG,LOGNAME,PATH,PWD,SHLVL,TMPDIR,USER,",
      `net=${leaky ? "connected" : "failed"}`,
      "",
    ].join("\n");
  return {
    started,
    probe: async () => ({ state: o.state ?? "supported", reasons: [] }),
    status: () => ({ state: o.state ?? "supported", reasons: o.state === "unsupported" ? ["scripted"] : [] }),
    policyId: () => "bwrap:scripted",
    reap: async (ids) => Object.fromEntries(ids.map((id) => [id, { leftover: 0, killed: false, gone: true }])),
    start(spec: RunSpec): RunHandle {
      started.push(spec);
      const cmd = spec.argv.join(" ");
      const root = spec.workspace.root;
      if (spec.script !== undefined) return { pid: 1, kill: () => {}, done: Promise.resolve(exit({ stdout: Buffer.from(transcript(Boolean(o.leaky))) })) };
      const m = /^\/bin\/sh -c echo smoke-exec > (\S+); id -u$/.exec(cmd);
      if (m) {
        writeFileSync(join(root, m[1]!), "smoke-exec\n");
        return { pid: 1, kill: () => {}, done: Promise.resolve(exit({ stdout: Buffer.from("1000\n") })) };
      }
      if (cmd === "sleep 30" && spec.limits.timeoutSec === 3) return { pid: 1, kill: () => {}, done: Promise.resolve(exit({ code: null, signal: "SIGKILL", killedBy: "timeout" })) };
      if (cmd === "sleep 60") {
        let resolve!: (r: RunExit) => void;
        const done = new Promise<RunExit>((r) => (resolve = r));
        return { pid: 1, done, kill: (why) => resolve(exit({ code: null, signal: "SIGKILL", killedBy: why })) };
      }
      const rm = /^\/bin\/sh -c rm -f (smoke-[0-9a-f]+)-\*$/.exec(cmd);
      if (rm) for (const f of readdirSync(root)) if (f.startsWith(`${rm[1]}-`)) rmSync(join(root, f));
      return { pid: 1, kill: () => {}, done: Promise.resolve(exit({})) };
    },
  };
}

function smokeRig(launcher: Sandbox, withValidationWs = true) {
  const r = wsRig();
  if (withValidationWs) r.config.workspaces.push(makeWorkspace(r.base, VALIDATION_WORKSPACE));
  const stateDir = mkdtempSync(join(tmpdir(), "orbit-wssmoke-"));
  return { r, stateDir, run: () => runSmoke({ config: r.config, sandbox: launcher, stateDir, timeouts: { runMs: 2000, startMs: 2000 } }) };
}

test("smoke: against a launcher that behaves like the isolated sandbox, every required check passes, nothing is left behind, and nothing outside the validation workspace is touched", async () => {
  const l = scriptedLauncher();
  const s = smokeRig(l);
  const before = readFileSync(join(s.r.a.root, "notes.txt"), "utf8");
  const out = await s.run();
  assert.equal(out.passed, true, JSON.stringify(out.checks.filter((c) => c.result !== "pass")));
  assert.deepEqual(out.checks.map((c) => c.id), SMOKE_STEPS.map((x) => x.id));
  assert.ok(l.started.every((x) => x.workspace.id === VALIDATION_WORKSPACE), "every run is in the validation workspace");
  const vroot = s.r.config.workspaces.find((w) => w.id === VALIDATION_WORKSPACE)!.root;
  assert.deepEqual(readdirSync(vroot), [], "the synthetic files were removed");
  assert.ok(!readdirSync(s.stateDir).some((f) => f.startsWith("validation-canary-")), "the canary was removed");
  assert.equal(readFileSync(join(s.r.a.root, "notes.txt"), "utf8"), before);
});

test("smoke: a leaky launcher FAILS the isolation checks (network, hidden paths); the record says which", async () => {
  const out = await smokeRig(scriptedLauncher({ leaky: true })).run();
  assert.equal(out.passed, false);
  const failed = out.checks.filter((c) => c.result === "fail").map((c) => c.id);
  assert.ok(failed.includes("network_isolated"));
  assert.ok(failed.includes("host_paths_hidden"));
  assert.match(out.checks.find((c) => c.id === "host_paths_hidden")!.detail, /\/etc\/shadow/);
});

test("smoke: an unsupported sandbox or a missing validation workspace fails at once, and every step that did not run is recorded as failed (never passed)", async () => {
  for (const out of [await smokeRig(scriptedLauncher({ state: "unsupported" })).run(), await smokeRig(scriptedLauncher(), false).run()]) {
    assert.equal(out.passed, false);
    assert.equal(out.checks.length, SMOKE_STEPS.length);
    assert.ok(out.checks.filter((c) => c.required).every((c) => c.result === "fail"));
  }
});

// ---- the run-parent cgroup ---------------------------------------------------------------------------------------------------------

test("run-parent cgroup: created only as a sibling of ORBIT's own subgroup inside its delegated unit cgroup; anything else is left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-wscg-"));
  const unit = join(root, "system.slice", "orbit.service");
  mkdirSync(join(unit, "main"), { recursive: true });
  writeFileSync(join(unit, "cgroup.controllers"), "cpu memory pids\n");
  writeFileSync(join(unit, "cgroup.subtree_control"), "\n");
  const self = "/system.slice/orbit.service/main";
  assert.equal(ownCgroup("12:pids:/x\n0::/system.slice/orbit.service/main\n"), self);
  const ok = ensureRunParent(join(unit, "workspace-exec"), { root, self });
  assert.equal(ok.ok, true, ok.detail);
  assert.ok(existsSync(join(unit, "workspace-exec")));
  assert.equal(readFileSync(join(unit, "cgroup.subtree_control"), "utf8"), "+memory +pids +cpu");
  for (const bad of [join(root, "system.slice", "other"), join(unit, "main"), join(unit, "workspace-exec", "deeper"), join(root, "system.slice", "orbit.service", "..", "x")]) {
    const r = ensureRunParent(bad, { root, self });
    assert.equal(r.ok, false, bad);
    assert.deepEqual(r.changed, []);
  }
  writeFileSync(join(unit, "cgroup.controllers"), "cpu\n");
  const notDelegated = ensureRunParent(join(unit, "workspace-exec2"), { root, self });
  assert.equal(notDelegated.ok, false);
  assert.match(notDelegated.detail, /not delegated memory, pids/);
  assert.equal(existsSync(join(unit, "workspace-exec2")), false);
});

test("owner switch turned off without a drain (e.g. by hand): a queued run never starts", async () => {
  let on = true;
  const r = wsRig({ maxConcurrentRuns: 1 });
  const svc = workspaceService({ activation: { state: "enabled", config: r.config }, sandbox: r.sandbox, stateDir: mkdtempSync(join(tmpdir(), "orbit-wsact-q-")), proposals: r.proposals, active: () => on });
  const exec = svc.tools.find((t) => t.name === "exec_start")!;
  const p1 = ((await exec.run({ workspace: "alpha", argv: ["true"] })) as { value: { proposalId: string } }).value;
  const p2 = ((await exec.run({ workspace: "beta", argv: ["true"] })) as { value: { proposalId: string } }).value;
  await svc.confirm(r.proposals.take(p1.proposalId) as never);
  const c2 = await svc.confirm(r.proposals.take(p2.proposalId) as never);
  assert.equal(c2.body.state, "queued");
  on = false;
  r.sandbox.runs[0]!.finish(0);
  await svc.idle();
  assert.equal(svc.ledger.get(String(c2.body.opId))!.state, "cancelled");
  assert.match(String(svc.ledger.get(String(c2.body.opId))!.reason), /^disabled/);
  assert.equal(r.sandbox.runs.length, 1);
});

// ---- PR #147 review, finding 1: the switch is bound to the validated evidence ------------------------------------------------------

test("binding: a policy change while enabled turns the switch off durably (reverting the change does not bring it back)", async () => {
  const r = await enabled();
  assert.equal(r.owner.mode(), "enabled");
  const exec = r.svc.tools.find((t) => t.name === "fs_list")!;
  r.cur.policyHash = "sha256:" + "cd".repeat(32);
  assert.equal(r.owner.mode(), "off");
  assert.deepEqual(r.svc.tools, [], "no tool is offered");
  // A tool object handed out before the change is refused at dispatch.
  await assert.rejects(exec.run({ workspace: "alpha" }), /switched off/);
  assert.match(String(r.owner.record().reason), /sandbox policy changed/);
  r.cur.policyHash = r.config.policyHash;
  assert.equal(r.owner.mode(), "off", "the reset is durable");
  assert.equal(ownerActivation(r.stateDir, r.current).mode(), "off", "and survives a restart");
});

test("binding: a changed sandbox implementation or validation workspace turns it off; an unfinished startup self-test only holds it off", async () => {
  const a = await enabled();
  const orig = a.sb.policyId;
  a.sb.set("unknown");
  assert.equal(a.owner.mode(), "off", "self-test not finished: off for now");
  assert.equal(a.owner.record().mode, "enabled", "but not reset");
  a.sb.set("supported");
  assert.equal(a.owner.mode(), "enabled", "the same implementation after the self-test: on again");
  (a.sb as { policyId: () => string }).policyId = () => "bwrap:0.12.0:fake";
  assert.equal(a.owner.mode(), "off");
  (a.sb as { policyId: () => string }).policyId = orig;
  assert.equal(a.owner.mode(), "off", "durable");
  const b = await enabled();
  b.cur.validationIdentity = "sha256:" + "0".repeat(64);
  assert.equal(b.owner.mode(), "off");
  assert.match(String(b.owner.record().reason), /validation workspace changed/);
});

test("binding: a missing, replaced, failed or invalidated validation turns it off", async () => {
  const gone = await enabled();
  rmSync(join(gone.stateDir, "validation.json"));
  assert.equal(gone.owner.mode(), "off");
  const replaced = await enabled();
  replaced.owner.saveValidation({ ...replaced.owner.validation()!, id: "val-0000000000000001" });
  assert.equal(replaced.owner.mode(), "off");
  const failed = await enabled();
  failed.owner.saveValidation({ ...failed.owner.validation()!, state: "failed" });
  assert.equal(failed.owner.mode(), "off");
  const inval = await enabled();
  inval.owner.invalidateValidation(T0.toISOString(), "test");
  assert.equal(inval.owner.mode(), "off");
});

test("binding: across restarts it stays on while everything holds, and its age alone never switches it off (24 h applies at enable)", async () => {
  const r = await enabled();
  r.setClock(new Date(T0.getTime() + 3 * VALIDATION_MAX_AGE_MS));
  assert.equal(ownerActivation(r.stateDir, r.current).mode(), "enabled");
  // ...but a validation that old is not evidence for a NEW enable.
  const p = await r.propose("disable");
  await r.admin.confirm(r.take(p.proposalId));
  await assert.rejects(r.propose("enable"), /older than 24 hours/);
});

test("revoke then setup: revoke turns the switch off at once and invalidates the validation; a later setup leaves the tools OFF", async () => {
  const { host } = fakeHost(PLAN);
  const r = await enabled({ host });
  const p = await r.propose("revoke");
  const out = await r.admin.confirm(r.take(p.proposalId));
  assert.equal(out.code, 202);
  assert.equal(r.owner.mode(), "off");
  assert.ok(r.owner.validation()!.invalidatedAt);
  // ORBIT restarts without the host permission (the helper removed it).
  r.cur.permitted = false;
  assert.equal(ownerActivation(r.stateDir, r.current).mode(), "off");
  // The host is set up again (same configuration): the switch stays off and enable needs a NEW validation.
  r.cur.permitted = true;
  const s = await r.propose("setup");
  assert.equal((await r.admin.confirm(r.take(s.proposalId))).code, 202);
  assert.equal(ownerActivation(r.stateDir, r.current).mode(), "off");
  await assert.rejects(r.propose("enable"), /invalidated/);
  await r.validate();
  const e = await r.propose("enable");
  assert.equal((await r.admin.confirm(r.take(e.proposalId))).code, 200);
});

test("revoke done by hand (host permission absent at a start): the recorded switch is reset and the validation invalidated", async () => {
  const r = await enabled();
  // The production wiring at a start with the host permission removed (ORBIT_WORKSPACE_TOOLS unset).
  const parent = mkdtempSync(join(tmpdir(), "orbit-wsact-sel-"));
  mkdirSync(join(parent, "workspace"));
  for (const f of ["activation.json", "validation.json"]) writeFileSync(join(parent, "workspace", f), readFileSync(join(r.stateDir, f)));
  const { selectWorkspace } = await import("../src/workspace/select.ts");
  const lines: string[] = [];
  const w = selectWorkspace({}, { stateDir: parent, proposals: r.proposals, protectedPaths: [], log: (l) => lines.push(l) });
  assert.equal(w.activation.state, "off");
  const after = ownerActivation(join(parent, "workspace"), r.current);
  assert.equal(after.record().mode, "off");
  assert.match(String(after.record().reason), /host does not permit/);
  assert.ok(after.validation()!.invalidatedAt);
  assert.equal(after.mode(), "off", "even with the same policy back");
  assert.ok(lines.some((l) => /workspace-owner: reset to off/.test(l)));
});

test("enable races: a validation started after the card, a setup confirmed after it, or a second enable card are all refused", async () => {
  const a = rig();
  await a.validate();
  const p = await a.propose("enable");
  await a.validate(); // a newer validation replaces the one the card showed
  assert.equal((await a.admin.confirm(a.take(p.proposalId))).code, 409);
  assert.equal(a.owner.mode(), "off");

  const { host } = fakeHost(PLAN);
  const b = rig({ host });
  await b.validate();
  const e = await b.propose("enable");
  const s = await b.propose("setup");
  await b.admin.confirm(b.take(s.proposalId));
  const out = await b.admin.confirm(b.take(e.proposalId));
  assert.equal(out.code, 409);
  assert.match(String(out.body.error), /invalidated/);
  assert.equal(b.owner.mode(), "off");

  const c = rig();
  await c.validate();
  const e1 = await c.propose("enable");
  const e2 = await c.propose("enable");
  assert.equal((await c.admin.confirm(c.take(e1.proposalId))).code, 200);
  const second = await c.admin.confirm(c.take(e2.proposalId));
  assert.equal(second.code, 200, "a second enable of the same validation is idempotent: still exactly bound to it");
  assert.equal(c.owner.record().binding!.validationId, c.owner.validation()!.id);
});

test("setup confirmed while the tools are on: the switch goes off first and queued commands are withdrawn", async () => {
  const { host } = fakeHost(PLAN);
  const r = await enabled({ host });
  const exec = r.svc.tools.find((t) => t.name === "exec_start")!;
  const p1 = ((await exec.run({ workspace: "alpha", argv: ["sleep", "1"] })) as { value: { proposalId: string } }).value;
  const s = await r.propose("setup");
  // The command card is confirmed only after the setup card: it is refused (switched off).
  await r.admin.confirm(r.take(s.proposalId));
  assert.equal(r.owner.mode(), "off");
  assert.equal((await r.svc.confirm(r.take(p1.proposalId))).code, 503);
  assert.equal(r.sb.runs.length, 0);
});

test("a validation that finishes after a host change keeps its invalidation", async () => {
  const { host } = fakeHost(PLAN);
  let release!: () => void;
  const r = rig({ host, smokeGate: new Promise<void>((res) => (release = res)) });
  const p = await r.propose("validate");
  assert.equal((await r.admin.confirm(r.take(p.proposalId))).code, 202);
  assert.equal(r.owner.validation()!.state, "running");
  const s = await r.propose("setup");
  await r.admin.confirm(r.take(s.proposalId));
  release();
  await r.admin.validating();
  assert.equal(r.owner.validation()!.state, "passed");
  assert.ok(r.owner.validation()!.invalidatedAt, "the validation's own final write kept the invalidation");
  await assert.rejects(r.propose("enable"), /invalidated/);
});

// ---- PR #147 review, finding 4: dispatch races with refresh ------------------------------------------------------------------------

test("setup dispatch: a refresh while the dispatch is pending neither judges it nor hides its result; the result is reported exactly once", async () => {
  let recorded = false;
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>((res) => (releaseDispatch = res));
  const host: WsHostClient = {
    status: async () => ({ ok: true, data: { plan: PLAN } }),
    call: async (action) => {
      if (action === "op_status") return recorded ? { ok: true, data: { operation: { state: "verified", summary: "verified by observation", finishedAt: T0.toISOString() } } } : { ok: false, code: "not_found", message: "No operation with that id." };
      await dispatchGate;
      recorded = true;
      return { ok: true, data: { operation: { state: "accepted" } } };
    },
  };
  const r = rig({ host });
  const p = await r.propose("setup");
  const confirming = r.admin.confirm(r.take(p.proposalId));
  await tick();
  // The 30-second tick runs while the helper has not recorded the operation yet.
  await r.admin.refresh();
  assert.equal(r.admin.status().hostOperations[0]!.state, "dispatching");
  assert.equal(r.notes.filter((n) => /host setup/.test(n)).length, 0, "nothing reported, and certainly not 'nothing was done'");
  releaseDispatch();
  assert.equal((await confirming).code, 202);
  await r.admin.refresh();
  await r.admin.refresh();
  assert.equal(r.admin.status().hostOperations[0]!.state, "verified");
  assert.equal(r.notes.filter((n) => /host setup verified/.test(n)).length, 1);
});

test("setup dispatch across a restart: 'not found' within the dispatch window waits; after it, 'not dispatched' is reported once", async () => {
  const entries = [{ opId: "a".repeat(40), proposalId: "p-1", action: "ws_setup" as const, confirmedAt: T0.toISOString(), state: "dispatching" }];
  let mem: unknown[] = entries;
  const store = { read: () => mem as never, write: (v: unknown[]) => void (mem = v) };
  const host: WsHostClient = { status: async () => ({ ok: true, data: { plan: PLAN } }), call: async () => ({ ok: false, code: "not_found", message: "No operation with that id." }) };
  const r = rig({ host });
  let clock = new Date(T0.getTime() + 10_000);
  const notes: string[] = [];
  const admin = workspaceAdmin({ env: {}, activation: { state: "enabled", config: r.config }, service: r.svc, sandbox: r.sb, owner: r.owner, proposals: r.proposals, host, hostStore: store, notify: (t) => notes.push(t), now: () => clock });
  await admin.refresh();
  assert.equal(admin.status().hostOperations[0]!.state, "dispatching");
  assert.equal(notes.length, 0);
  clock = new Date(T0.getTime() + DISPATCH_GRACE_MS + 1);
  await admin.refresh();
  await admin.refresh();
  assert.equal(admin.status().hostOperations[0]!.state, "not_dispatched");
  assert.equal(notes.length, 1);
});

test("host operation records: unfinished or unreported entries are never pruned", async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ opId: i.toString(16).padStart(40, "0"), proposalId: `p-${i}`, action: "ws_setup" as const, confirmedAt: T0.toISOString(), state: i === 0 ? "running" : "verified", ...(i === 0 ? {} : { reportedAt: T0.toISOString() }) }));
  let mem: unknown[] = many;
  const store = { read: () => mem as never, write: (v: unknown[]) => void (mem = v) };
  const { host } = fakeHost(PLAN);
  const r = rig({ host });
  const admin = workspaceAdmin({ env: {}, activation: { state: "enabled", config: r.config }, service: r.svc, sandbox: r.sb, owner: r.owner, proposals: r.proposals, host, hostStore: store, now: () => T0 });
  const p = await admin.propose("setup");
  await admin.confirm(r.take(p.proposalId));
  const kept = (mem as { opId: string; state: string }[]);
  assert.ok(kept.some((e) => e.opId === many[0]!.opId), "the running entry is kept");
  assert.ok(kept.length <= 52);
});
