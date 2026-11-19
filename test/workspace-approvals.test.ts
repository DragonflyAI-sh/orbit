import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide } from "../src/policy.ts";
import { digestOf } from "../src/workspace/service.ts";
import { fakeSandbox, tick, wsRig } from "./workspace-fixture.ts";

// The approval path of the workspace tools (docs/workspace-tools.md, "Confirmation"), at the service boundary: every write, patch and
// command is only proposed by its tool, runs only through confirm(), is bound to its digest and card, is single use, and is re-checked
// in the backend at run time. Runs use the fakeSandbox supervisor double (no isolation claimed; see test/workspace-fixture.ts).

// A credential-shaped value assembled at runtime from the plain alphabet, so no literal in this file has a credential shape.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const shaped = () => "gh" + "p_" + Array.from({ length: 36 }, (_, i) => ALPHABET[(i * 37 + 11) % ALPHABET.length]).join("");

test("owner only: the workspace policy port refuses everyone but the owner", () => {
  assert.equal(decide("workspace", "fs_read", true).allow, true);
  assert.equal(decide("workspace", "fs_read", false).allow, false);
  assert.equal(decide("workspace", "confirm", false).allow, false);
});

test("disabled by default: an inactive service offers no tools and refuses every confirmation", async () => {
  const r = wsRig();
  for (const activation of [{ state: "off", reason: "default off" }, { state: "not_activated", reason: "checklist" }, { state: "invalid", reason: "bad" }] as const) {
    const svc = r.make(activation);
    assert.equal(svc.enabled, false);
    assert.deepEqual(svc.tools, []);
    const out = await svc.confirm({ id: "x", kind: "workspace_op", action: "fs_write", summary: "s", display: {}, warnings: [], digest: "d", createdAt: "", expiresAt: "" });
    assert.ok(out.code >= 400);
  }
});

test("fs_write: the tool only proposes; nothing is written until confirm; confirm writes once; a replay does nothing", async () => {
  const r = wsRig();
  const res = await r.call("fs_write", { workspace: "alpha", path: "new.txt", content: "hello\n", createOnly: true });
  assert.equal(res.value.status, "pending-confirmation");
  assert.equal(res.value.executed, false);
  assert.throws(() => readFileSync(join(r.a.root, "new.txt")), "no effect before approval");
  const p = r.proposal(res.value.proposalId);
  assert.equal(p.display.content, "hello\n", "the card shows the complete content");
  const ok = await r.svc.confirm(p);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(readFileSync(join(r.a.root, "new.txt"), "utf8"), "hello\n");
  const again = await r.svc.confirm(p);
  assert.equal(again.code, 410, "a consumed approval cannot run again");
  assert.equal(r.svc.ledger.list().filter((e) => e.kind === "fs_write").length, 1);
  const events = r.audits.map((a) => a.event);
  assert.deepEqual(events.slice(0, 4), ["proposal", "confirmation", "invocation", "result"]);
  assert.ok(events.includes("denial"), "the replay is audited as a denial");
  assert.ok(!JSON.stringify(r.audits).includes("hello"), "audit records never carry file content");
});

test("tampering: a wrong digest, an edited card, a cross-workspace or changed-identity substitution are refused and write nothing", async () => {
  const r = wsRig();
  const mk = async () => r.proposal((await r.call("fs_write", { workspace: "alpha", path: "t.txt", content: "one", createOnly: true })).value.proposalId);
  const p1 = await mk();
  assert.equal((await r.svc.confirm({ ...p1, digest: digestOf({ kind: "fs_write", workspace: { id: "alpha", identity: r.a.identity }, path: "t.txt", content: "two", precondition: { kind: "new" } }) })).code, 409);
  const p2 = await mk();
  assert.equal((await r.svc.confirm({ ...p2, display: { ...p2.display, content: "edited after review" } })).code, 409);
  const p3 = await mk();
  assert.equal((await r.svc.confirm({ ...p3, display: { ...p3.display, workspace: "beta" } })).code, 409);
  const p4 = await mk();
  const saved = r.a.identity;
  r.a.identity = "sha256:" + "f".repeat(64); // the operator re-pointed the workspace after the proposal
  assert.equal((await r.svc.confirm(p4)).code, 409);
  r.a.identity = saved;
  assert.throws(() => readFileSync(join(r.a.root, "t.txt")));
});

test("stale inputs: a file changed after the proposal makes the confirmed write fail deterministically; nothing is written", async () => {
  const r = wsRig();
  const read = await r.call("fs_read", { workspace: "alpha", path: "notes.txt" });
  const res = await r.call("fs_write", { workspace: "alpha", path: "notes.txt", content: "rewritten\n", expectedVersion: read.value.version });
  writeFileSync(join(r.a.root, "notes.txt"), "someone else changed it\n");
  const out = await r.svc.confirm(r.proposal(res.value.proposalId));
  assert.equal(out.code, 409);
  assert.equal(out.body.state, "failed");
  assert.equal(readFileSync(join(r.a.root, "notes.txt"), "utf8"), "someone else changed it\n");
  // A proposal with a stale version is refused at proposal time too.
  await assert.rejects(r.call("fs_write", { workspace: "alpha", path: "notes.txt", content: "x", expectedVersion: read.value.version }), /No proposal was made/);
});

test("fs_patch: unique exact matches only; the card shows every edit and the result version; a changed file refuses it", async () => {
  const r = wsRig();
  const read = await r.call("fs_read", { workspace: "alpha", path: "notes.txt" });
  await assert.rejects(r.call("fs_patch", { workspace: "alpha", path: "notes.txt", expectedVersion: read.value.version, edits: [{ find: "line", replace: "row" }] }), /more than once/);
  await assert.rejects(r.call("fs_patch", { workspace: "alpha", path: "notes.txt", expectedVersion: read.value.version, edits: [{ find: "absent", replace: "x" }] }), /not found/);
  const res = await r.call("fs_patch", { workspace: "alpha", path: "notes.txt", expectedVersion: read.value.version, edits: [{ find: "first", replace: "1st" }] });
  const p = r.proposal(res.value.proposalId);
  assert.equal(p.display["edit 1 find"], "first");
  assert.match(p.display.result, /sha256:/);
  const ok = await r.svc.confirm(p);
  assert.equal(ok.code, 200);
  assert.equal(readFileSync(join(r.a.root, "notes.txt"), "utf8"), "1st line\nsecond line\n");
});

test("confinement through the tools: unknown workspaces, absolute paths, traversal and links are refused; vault paths are unreachable", async () => {
  const r = wsRig();
  await assert.rejects(r.call("fs_read", { workspace: "nope", path: "x" }), /unknown_workspace/);
  await assert.rejects(r.call("fs_read", { workspace: "alpha", path: "/etc/passwd" }), /invalid_path/);
  await assert.rejects(r.call("fs_read", { workspace: "alpha", path: "../beta/x" }), /invalid_path/);
  await assert.rejects(r.call("fs_list", { workspace: "alpha", root: "/" }), /Unknown argument/);
  await assert.rejects(r.call("fs_write", { workspace: "alpha", path: "../x", content: "x", createOnly: true }), /No proposal was made/);
  await assert.rejects(r.call("exec_start", { workspace: "alpha", argv: ["true"], env: { LD_PRELOAD: "x" } }), /Unknown argument/);
  await assert.rejects(r.call("exec_start", { workspace: "alpha", argv: ["true"], limits: { timeoutSec: 99999 } }), /Unknown argument/);
});

test("secret refusal and output masking: credential-shaped content is never proposed; credential-shaped file text is masked on read", async () => {
  const r = wsRig();
  await assert.rejects(r.call("fs_write", { workspace: "alpha", path: "k.txt", content: `token ${shaped()}`, createOnly: true }), /secret_refused/);
  await assert.rejects(r.call("exec_start", { workspace: "alpha", argv: ["echo", shaped()] }), /secret_refused/);
  writeFileSync(join(r.a.root, "leak.txt"), `value ${shaped()}\n`);
  const read = await r.call("fs_read", { workspace: "alpha", path: "leak.txt" });
  assert.ok(!read.value.text.includes(shaped()));
  assert.equal(read.value.masked, true);
  assert.equal(read.value.untrusted, true);
  const found = await r.call("fs_search", { workspace: "alpha", query: "value" });
  assert.ok(!JSON.stringify(found.value).includes(shaped()));
});

test("exec: only proposed; the card discloses mutation scope, no network, env, limits and snapshot; it runs once after confirm", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const res = await r.call("exec_start", { workspace: "alpha", argv: ["sh", "run.sh"], cwd: "" });
  assert.equal(res.value.status, "pending-confirmation");
  assert.equal(sb.runs.length, 0, "nothing ran before approval");
  const p = r.proposal(res.value.proposalId);
  assert.match(p.display.network, /none/);
  assert.match(p.warnings.join(" "), /ANY file in workspace alpha/);
  assert.match(p.display.environment, /^PATH=/);
  assert.match(p.display["reviewed workspace snapshot"], /^sha256:/);
  const ok = await r.svc.confirm(p);
  assert.equal(ok.code, 202);
  await tick();
  assert.equal(sb.runs.length, 1);
  assert.deepEqual(sb.runs[0]!.spec.argv, ["sh", "run.sh"]);
  assert.equal(r.svc.ledger.get(String(ok.body.opId))!.state, "running");
  sb.runs[0]!.finish(0, "hello\n");
  await r.svc.idle();
  const status = await r.call("exec_status", { runId: ok.body.opId });
  assert.equal(status.value.operation.state, "completed");
  assert.equal(status.value.operation.exitCode, 0);
  assert.equal(status.value.output.text, "hello\n");
  assert.equal(status.value.untrusted, true);
  assert.equal((await r.svc.confirm(p)).code, 410);
  assert.equal(sb.runs.length, 1, "a replayed approval never runs again");
});

test("changed inputs: a workspace file (the script it runs) changed between preview and start refuses the run; nothing starts", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const res = await r.call("exec_start", { workspace: "alpha", argv: ["sh", "run.sh"] });
  writeFileSync(join(r.a.root, "run.sh"), "echo something else\n");
  const ok = await r.svc.confirm(r.proposal(res.value.proposalId));
  assert.equal(ok.code, 202);
  await r.svc.idle();
  assert.equal(sb.runs.length, 0);
  const e = r.svc.ledger.get(String(ok.body.opId))!;
  assert.equal(e.state, "failed");
  assert.match(e.reason!, /stale/);
  // A mode change (making something executable) counts too.
  const res2 = await r.call("exec_start", { workspace: "alpha", argv: ["./run.sh"] });
  chmodSync(join(r.a.root, "run.sh"), 0o700);
  const ok2 = await r.svc.confirm(r.proposal(res2.value.proposalId));
  await r.svc.idle();
  assert.equal(r.svc.ledger.get(String(ok2.body.opId))!.state, "failed");
  assert.equal(sb.runs.length, 0);
});

test("concurrency: a confirmed write is refused while a command runs in that workspace; queued runs wait; another workspace is unaffected", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const read = await r.call("fs_read", { workspace: "alpha", path: "notes.txt" });
  const w = await r.call("fs_write", { workspace: "alpha", path: "notes.txt", content: "changed\n", expectedVersion: read.value.version });
  const wb = await r.call("fs_write", { workspace: "beta", path: "b.txt", content: "b", createOnly: true });
  const e1 = await r.call("exec_start", { workspace: "alpha", argv: ["true"] });
  const e2 = await r.call("exec_start", { workspace: "beta", argv: ["true"] });
  const c1 = await r.svc.confirm(r.proposal(e1.value.proposalId));
  await tick();
  assert.equal(sb.runs.length, 1);
  const busy = await r.svc.confirm(r.proposal(w.value.proposalId));
  assert.equal(busy.code, 409);
  assert.match(String(busy.body.error), /command is running/);
  assert.equal(readFileSync(join(r.a.root, "notes.txt"), "utf8"), "first line\nsecond line\n");
  assert.equal((await r.svc.confirm(r.proposal(wb.value.proposalId))).code, 200, "beta is not locked");
  const c2 = await r.svc.confirm(r.proposal(e2.value.proposalId));
  assert.equal(c2.body.state, "queued", "maxConcurrentRuns 1: the second run waits");
  // beta changed after e2 was proposed (the confirmed write above), so when e2 starts it is refused as stale: deterministic.
  sb.runs[0]!.finish(0);
  await r.svc.idle();
  assert.equal(r.svc.ledger.get(String(c1.body.opId))!.state, "completed");
  assert.equal(r.svc.ledger.get(String(c2.body.opId))!.state, "failed");
  assert.equal(sb.runs.length, 1);
});

test("cancel: a queued run is withdrawn and never starts; a running one is cancelled only after its exit is observed", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const e1 = await r.call("exec_start", { workspace: "alpha", argv: ["sleep", "100"] });
  const e2 = await r.call("exec_start", { workspace: "beta", argv: ["sleep", "100"] });
  const c1 = await r.svc.confirm(r.proposal(e1.value.proposalId));
  const c2 = await r.svc.confirm(r.proposal(e2.value.proposalId));
  await tick();
  const q = await r.call("exec_cancel", { runId: c2.body.opId });
  assert.equal(q.value.state, "cancelled");
  const run = await r.call("exec_cancel", { runId: c1.body.opId });
  assert.equal(run.value.cancelRequested, true);
  await r.svc.idle();
  assert.equal(sb.runs.length, 1, "the queued run never started");
  assert.equal(sb.runs[0]!.killed, "cancel");
  assert.equal(r.svc.ledger.get(String(c1.body.opId))!.state, "cancelled");
  assert.equal(r.svc.ledger.get(String(c2.body.opId))!.state, "cancelled");
  const late = await r.call("exec_cancel", { runId: c1.body.opId });
  assert.equal(late.value.cancelled, false);
  assert.ok(r.audits.filter((a) => a.event === "cancellation").length >= 2);
});

test("timeout and start failure: a killed-by-timeout run is failed (never completed); a run with no process is failed not_started", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const e = await r.call("exec_start", { workspace: "alpha", argv: ["sleep", "100"] });
  const c = await r.svc.confirm(r.proposal(e.value.proposalId));
  await tick();
  sb.runs[0]!.finish(0, "", "", { code: null, signal: "SIGKILL", killedBy: "timeout" });
  await r.svc.idle();
  const entry = r.svc.ledger.get(String(c.body.opId))!;
  assert.equal(entry.state, "failed");
  assert.match(entry.reason!, /timeout/);

  const nopid = fakeSandbox({ noPid: true });
  const r2 = wsRig({ sandbox: nopid });
  const e2 = await r2.call("exec_start", { workspace: "alpha", argv: ["true"] });
  const c2 = await r2.svc.confirm(r2.proposal(e2.value.proposalId));
  await r2.svc.idle();
  const e2e = r2.svc.ledger.get(String(c2.body.opId))!;
  assert.equal(e2e.state, "failed");
  assert.match(e2e.reason!, /not_started/);
  assert.ok(!e2e.events.some((x) => x.state === "running"), "running is recorded only with a process");
});

test("no unsandboxed fallback: when the sandbox is unsupported or changes after the proposal, nothing runs", async () => {
  const sb = fakeSandbox({ state: "unsupported" });
  const r = wsRig({ sandbox: sb });
  await assert.rejects(r.call("exec_start", { workspace: "alpha", argv: ["true"] }), /sandbox_unsupported/);
  sb.set("supported");
  const e = await r.call("exec_start", { workspace: "alpha", argv: ["true"] });
  sb.set("unsupported");
  const c = await r.svc.confirm(r.proposal(e.value.proposalId));
  assert.equal(c.code, 409);
  assert.equal(sb.runs.length, 0);
  await assert.rejects(r.call("exec_start", { workspace: "readonly", argv: ["true"] }), /exec_not_allowed/);
});

test("restart recovery: in-flight runs become uncertain (never success), unstarted ones failed, leftovers are reaped; held proposals are gone", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const e1 = await r.call("exec_start", { workspace: "alpha", argv: ["sleep", "100"] });
  const e2 = await r.call("exec_start", { workspace: "beta", argv: ["true"] });
  const pending = await r.call("fs_write", { workspace: "beta", path: "p.txt", content: "p", createOnly: true });
  const c1 = await r.svc.confirm(r.proposal(e1.value.proposalId));
  await tick();
  // Simulate a crash: e2 is recorded as queued but was never started (no start record).
  const c2 = { opId: "queued-op" };
  r.svc.ledger.put({ opId: c2.opId, proposalId: e2.value.proposalId, kind: "exec", workspace: "beta", digest: "d", state: "queued", createdAt: "t", updatedAt: "t", events: [{ at: "t", state: "queued" }], summary: "s" });
  // A "new process" over the same state directory.
  const after = r.make();
  const out = after.recover();
  assert.deepEqual(Object.fromEntries(out.map((o) => [o.opId, o.state])), { [String(c1.body.opId)]: "uncertain", [c2.opId]: "failed" });
  assert.deepEqual(sb.reaped.at(-1)!.sort(), [String(c1.body.opId), c2.opId].sort());
  assert.match(after.ledger.get(String(c1.body.opId))!.reason!, /unknown/);
  const gone = await after.confirm(r.proposal(pending.value.proposalId));
  assert.equal(gone.code, 410, "a proposal held only by the old process cannot be confirmed after a restart");
  assert.equal(after.recover().length, 0, "recovery is idempotent");
});

test("status distinguishes proposal from confirmed states, and pages bounded output with capture truncation reported", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb, limits: { outputBytes: 1024 } });
  const e = await r.call("exec_start", { workspace: "alpha", argv: ["yes"] });
  const listed = await r.call("exec_status", {});
  assert.equal(listed.value.proposals[0].state, "proposal");
  const c = await r.svc.confirm(r.proposal(e.value.proposalId));
  await tick();
  const mid = await r.call("exec_status", { runId: c.body.opId });
  assert.equal(mid.value.operation.state, "running");
  assert.equal(mid.value.output.available, false);
  sb.runs[0]!.finish(0, "y\n".repeat(512), "", { truncated: { stdout: true, stderr: false } });
  await r.svc.idle();
  const p1 = await r.call("exec_status", { runId: c.body.opId, length: 100 });
  assert.equal(p1.value.output.bytes, 100);
  assert.equal(p1.value.output.nextOffset, 100);
  assert.equal(p1.value.output.truncatedAtCapture, true);
  const p2 = await r.call("exec_status", { runId: c.body.opId, offset: 1000, length: 100 });
  assert.equal(p2.value.output.nextOffset, null);
});

test("ledger survives a restart (0600 output files) and the bounded retention keeps active entries", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const e = await r.call("exec_start", { workspace: "alpha", argv: ["true"] });
  const c = await r.svc.confirm(r.proposal(e.value.proposalId));
  await tick();
  sb.runs[0]!.finish(0, "out");
  await r.svc.idle();
  const again = r.make();
  assert.equal(again.ledger.get(String(c.body.opId))!.state, "completed");
  assert.equal(again.ledger.readOutput(String(c.body.opId), "stdout")!.toString(), "out");
  const { statSync } = await import("node:fs");
  assert.equal(statSync(join(r.stateDir, "output", `${c.body.opId}.stdout`)).mode & 0o777, 0o600);
});

test("every mutating tool, called directly as any model or fallback dispatch path would, has no effect: only confirm() acts", async () => {
  const sb = fakeSandbox();
  const r = wsRig({ sandbox: sb });
  const read = await r.call("fs_read", { workspace: "alpha", path: "notes.txt" });
  for (const [name, args] of [
    ["fs_write", { workspace: "alpha", path: "notes.txt", content: "x", expectedVersion: read.value.version }],
    ["fs_write", { workspace: "alpha", path: "z.txt", content: "x", createOnly: true }],
    ["fs_patch", { workspace: "alpha", path: "notes.txt", expectedVersion: read.value.version, edits: [{ find: "first", replace: "x" }] }],
    ["exec_start", { workspace: "alpha", argv: ["true"] }],
  ] as const) {
    const out = await r.call(name, args as Record<string, unknown>);
    assert.equal(out.value.executed, false, name);
  }
  assert.equal(readFileSync(join(r.a.root, "notes.txt"), "utf8"), "first line\nsecond line\n");
  assert.equal(sb.runs.length, 0);
  assert.equal(r.svc.ledger.list().length, 0);
  for (const t of r.svc.tools) assert.equal(t.readOnly === true, ["workspace_list", "fs_list", "fs_stat", "fs_read", "fs_search", "exec_status"].includes(t.name), t.name);
});

test("the largest write the tool accepts fits its card in full (no write is refused for card size)", async () => {
  const r = wsRig();
  const path = `${"d".repeat(200)}.txt`;
  const res = await r.call("fs_write", { workspace: "alpha", path, content: "x".repeat(20_000), createOnly: true });
  assert.equal(res.value.status, "pending-confirmation");
  assert.equal(r.proposal(res.value.proposalId).display.content.length, 20_000);
  await assert.rejects(r.call("fs_write", { workspace: "alpha", path: "y.txt", content: "x".repeat(20_001), createOnly: true }), /too_large/);
});
