import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { chatTools } from "../src/chat-tools.ts";
import { vaultMemory } from "../src/memory.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { notifier } from "../src/notify.ts";
import { ADMIN_PROPOSAL_TTL_MS, adminOps, type LedgerEntry } from "../src/ops-admin.ts";
import type { AdminClient, AdminReply } from "../src/ops-admin-client.ts";
import { adminClient } from "../src/ops-admin-client.ts";
import { opIdFor } from "../src/ops/admin-protocol.ts";
import type { ConfigChanges } from "../src/ops/admin-protocol.ts";
import { decide } from "../src/policy.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const part = (...p: string[]) => p.join("");
const TRIG = part("trig", "_", "abcdef123456");
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(new URL(`../${p}`, import.meta.url))).digest("hex");

// A helper client that records every call and answers like a helper would.
type Call = { action: string; opId: string; changes?: ConfigChanges };
function fakeClient(answer: (c: Call) => AdminReply | Promise<AdminReply> = (c) => ({ ok: true, data: { operation: { state: c.action === "op_status" ? "running" : "accepted" } } })) {
  const calls: Call[] = [];
  const client: AdminClient = {
    call: async (action, opId, changes) => {
      const c: Call = { action, opId, ...(changes ? { changes } : {}) };
      calls.push(c);
      return answer(c);
    },
  };
  return { client, calls, mutations: () => calls.filter((c) => c.action !== "op_status") };
}

function ledger(opts: { client?: AdminClient; now?: () => Date } = {}) {
  const store = jsonStore<LedgerEntry[]>(undefined, "ops-admin", []);
  const notify = notifier(jsonStore(undefined, "n", []));
  const proposals = newProposals(opts.now);
  const admin = adminOps({ client: opts.client, store, notify, proposals, now: opts.now });
  return { admin, store, notify, proposals };
}

// ---------------------------------------------------------------- proposals and confirmation

test("a proposal creates nothing on the host: the helper is not called until the owner confirms", async () => {
  const f = fakeClient();
  const { admin, proposals } = ledger({ client: f.client });
  for (const action of ["restart_orbit", "deploy_now", "rollback_release", "refresh_vault"] as const) {
    const p = admin.propose(action);
    assert.equal(p.kind, "ops_admin");
    assert.equal(p.action, action);
    assert.match(p.digest, /^[0-9a-f]{64}$/);
  }
  admin.propose("apply_config", { changes: { ORBIT_MODEL: "gpt-5" } });
  assert.equal(proposals.list().length, 5);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(admin.list(), []);
});

test("proposals refuse unknown or invalid settings and arguments before anything is created", () => {
  const { admin, proposals } = ledger({ client: fakeClient().client });
  assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_OWNER: "x" } }), /not a setting/);
  assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_INGRESS_PORT: 80 } }), /1024/);
  assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_MODEL: "x\nORBIT_OWNER=y" } }), /ORBIT_MODEL/);
  assert.throws(() => admin.propose("apply_config", {}), /changes/);
  assert.throws(() => admin.propose("restart_orbit", { changes: { ORBIT_MODEL: "x" } }), /no arguments/);
  assert.deepEqual(proposals.list(), []);
});

test("confirming dispatches exactly once, with the operation id derived from the proposal, and reports 'not verified'", async () => {
  const f = fakeClient();
  const { admin, proposals, store } = ledger({ client: f.client });
  const p = admin.propose("apply_config", { changes: { ORBIT_MODEL: "gpt-5", ORBIT_ROUTINES: `orbit=${TRIG}` } });
  assert.ok(!JSON.stringify(p).includes(TRIG), "the proposal never carries the trigger id");
  const taken = proposals.take(p.id)!;
  const res = await admin.confirm(taken as typeof p);
  assert.equal(res.code, 202);
  const body = res.body as { dispatched: boolean; verified: boolean; note: string };
  assert.equal(body.dispatched, true);
  assert.equal(body.verified, false);
  assert.match(body.note, /Nothing is verified yet/);
  assert.deepEqual(f.mutations(), [{ action: "apply_config", opId: opIdFor(p.id), changes: { ORBIT_MODEL: "gpt-5", ORBIT_ROUTINES: `orbit=${TRIG}` } }]);
  const [entry] = store.read();
  assert.equal(entry!.state, "accepted");
  assert.equal(entry!.result, undefined, "no result is recorded for a mere dispatch");
  assert.ok(!JSON.stringify(store.read()).includes(TRIG), "the persisted ledger holds the masked form only");
});

test("a confirmation cannot be replayed, and an altered proposal is refused without calling the helper", async () => {
  const f = fakeClient();
  const { admin, proposals } = ledger({ client: f.client });
  const p = admin.propose("restart_orbit");
  const first = await admin.confirm(proposals.take(p.id) as typeof p);
  assert.equal(first.code, 202);
  // the same proposal object presented again (a replay)
  const replay = await admin.confirm(p);
  assert.equal(replay.code, 409);
  assert.equal(f.mutations().length, 1);

  // a proposal whose action or digest was changed after validation
  const q = admin.propose("restart_orbit");
  const swapped = await admin.confirm({ ...proposals.take(q.id)!, action: "rollback_release" } as typeof q);
  assert.equal(swapped.code, 409);
  const r = admin.propose("apply_config", { changes: { ORBIT_MODEL: "gpt-5" } });
  const forged = await admin.confirm({ ...proposals.take(r.id)!, digest: "0".repeat(64) } as typeof r);
  assert.equal(forged.code, 409);
  // a proposal ORBIT never created
  const stranger = await admin.confirm({ ...q, id: "00000000-0000-4000-8000-000000000000" });
  assert.equal(stranger.code, 409);
  assert.equal(f.mutations().length, 1);
});

test("a proposal expires, and an expired one cannot be confirmed", async () => {
  let t = Date.parse("2026-11-09T12:00:00Z");
  const now = () => new Date(t);
  const f = fakeClient();
  const { admin, proposals } = ledger({ client: f.client, now });
  const p = admin.propose("restart_orbit");
  assert.equal(Date.parse(p.expiresAt) - Date.parse(p.createdAt), ADMIN_PROPOSAL_TTL_MS);
  assert.ok(ADMIN_PROPOSAL_TTL_MS <= 15 * 60 * 1000);
  t += ADMIN_PROPOSAL_TTL_MS + 1;
  assert.equal(proposals.take(p.id), undefined);
  assert.equal(proposals.peek(p.id), undefined);
  assert.equal(f.calls.length, 0);
});

test("a helper that refuses (busy, not installed, unreachable) leaves an honest entry and nothing is claimed", async () => {
  const busy = fakeClient(() => ({ ok: false, code: "busy", message: "Another administrative operation is still running." }));
  const a = ledger({ client: busy.client });
  const p = a.admin.propose("restart_orbit");
  const res = await a.admin.confirm(a.proposals.take(p.id) as typeof p);
  assert.equal(res.code, 409);
  assert.equal(a.admin.list()[0]!.state, "not_dispatched");

  const down = fakeClient(() => {
    throw new Error("orbit-ops-admin is not available: the admin helper socket is not there (tier 2 is not installed or not running).");
  });
  const b = ledger({ client: down.client });
  const q = b.admin.propose("deploy_now");
  const out = await b.admin.confirm(b.proposals.take(q.id) as typeof q);
  assert.equal(out.code, 502);
  assert.match(JSON.stringify(out.body), /Nothing is verified/);
  assert.equal(b.admin.list()[0]!.state, "dispatching", "unknown whether it arrived; refresh asks the helper");

  const none = ledger({});
  const r = none.admin.propose("deploy_now");
  assert.equal((await none.admin.confirm(none.proposals.take(r.id) as typeof r)).code, 503);
});

// ---------------------------------------------------------------- results survive a restart and are reported once

test("the ledger is persisted: after a restart ORBIT collects the verified result from the helper and reports it once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-admin-ledger-"));
  const mk = (client: AdminClient) => {
    const store = jsonStore<LedgerEntry[]>(dir, "ops-admin", []);
    const notify = notifier(jsonStore(dir, "notifications", []));
    const proposals = newProposals();
    return { admin: adminOps({ client, store, notify, proposals }), notify, proposals };
  };
  const first = fakeClient();
  const a = mk(first.client);
  const p = a.admin.propose("restart_orbit");
  assert.equal((await a.admin.confirm(a.proposals.take(p.id) as typeof p)).code, 202);

  // ORBIT restarts: a new process, new in-memory state, same state directory. The helper finished the restart meanwhile.
  const sha40 = "a".repeat(40);
  const second = fakeClient(() => ({ ok: true, data: { operation: { state: "verified", summary: `orbit.service restarted; /status is healthy and serves the same commit ${sha40.slice(0, 12)}.`, finishedAt: "2026-11-09T12:00:30Z", verification: { checked: true, healthy: true, expectedCommit: sha40, servedCommit: sha40, detail: "ok" } } } }));
  const b = mk(second.client);
  assert.equal(b.admin.list().length, 1, "the confirmation survived the restart");
  assert.equal(b.admin.list()[0]!.state, "accepted");
  await b.admin.refresh();
  const [entry] = b.admin.list();
  assert.equal(entry!.state, "verified");
  assert.equal(entry!.verification!.healthy, true);
  assert.equal(entry!.verification!.servedCommit, sha40);
  assert.equal(b.notify.inbox().length, 1);
  assert.match(b.notify.inbox()[0]!.text, /verified: orbit\.service restarted; \/status is healthy and serves the same commit/);
  await b.admin.refresh();
  await b.admin.refresh();
  assert.equal(b.notify.inbox().length, 1, "reported once");
  assert.equal(second.calls.filter((c) => c.action === "op_status").length, 1, "an ended operation is not polled again");
});

test("while the helper cannot be reached the last known state stays; unknown operations are marked, never invented", async () => {
  let reachable = false;
  const f = fakeClient((c) => {
    if (c.action !== "op_status") return { ok: true, data: { operation: { state: "accepted" } } };
    if (!reachable) throw new Error("orbit-ops-admin could not be reached.");
    return { ok: true, data: { operation: { state: "running" } } };
  });
  const { admin, proposals, notify } = ledger({ client: f.client });
  const p = admin.propose("restart_orbit");
  await admin.confirm(proposals.take(p.id) as typeof p);
  await admin.refresh();
  assert.equal(admin.list()[0]!.state, "accepted");
  reachable = true;
  await admin.refresh();
  assert.equal(admin.list()[0]!.state, "running");
  assert.equal(notify.inbox().length, 0, "running is not reported as a result");

  const lost = fakeClient((c) => (c.action === "op_status" ? { ok: false, code: "not_found", message: "No operation with that id." } : { ok: true, data: { operation: { state: "accepted" } } }));
  const l = ledger({ client: lost.client });
  const q = l.admin.propose("deploy_now");
  await l.admin.confirm(l.proposals.take(q.id) as typeof q);
  await l.admin.refresh();
  assert.equal(l.admin.list()[0]!.state, "interrupted");
  assert.match(l.admin.list()[0]!.result!, /outcome is unknown/);
  assert.equal(l.notify.inbox().length, 1);
});

test("a dispatch whose answer was lost is settled by asking the helper: not found means it never ran", async () => {
  let first = true;
  const f = fakeClient((c) => {
    if (c.action !== "op_status") {
      first = false;
      throw new Error("orbit-ops-admin did not answer in time.");
    }
    return { ok: false, code: "not_found", message: "No operation with that id." };
  });
  const { admin, proposals } = ledger({ client: f.client });
  const p = admin.propose("rollback_release");
  const res = await admin.confirm(proposals.take(p.id) as typeof p);
  assert.equal(res.code, 502);
  assert.equal(first, false);
  await admin.refresh();
  assert.equal(admin.list()[0]!.state, "not_dispatched");
  assert.match(admin.list()[0]!.result!, /nothing was done/);
});

// ---------------------------------------------------------------- the model's tools

const never = (): ModelPort => ({
  status: () => ({ port: "model", state: "live", impl: "fake", detail: "", verifiedAt: "2026-11-09T12:00:00Z" }),
  reply: async () => ({ value: "x", provenance: "live", source: "model/fake" }),
});

function toolsFor(admin?: ReturnType<typeof adminOps>) {
  const proposals = newProposals();
  return chatTools({ memory: vaultMemory(mkdtempSync(join(tmpdir(), "v-"))), toolbox: toolbox([]), admin, notify: notifier(jsonStore(undefined, "n", [])), proposals, launchable: () => ({ routines: [] }) });
}

test("the admin tools exist only when the admin ops are configured, only propose, and are owner-only by policy", async () => {
  assert.ok(!toolsFor().some((t) => t.name.startsWith("ops_propose")));
  const f = fakeClient();
  const { admin } = ledger({ client: f.client });
  const tools = toolsFor(admin);
  const names = tools.map((t) => t.name);
  for (const n of ["ops_propose_restart_orbit", "ops_propose_deploy_now", "ops_propose_rollback", "ops_propose_refresh_vault", "ops_propose_config_change", "ops_admin_operations"]) {
    assert.ok(names.includes(n), n);
    assert.equal(decide("agent", n, true).allow, true);
    assert.equal(decide("agent", n, false).allow, false);
  }
  assert.equal(decide("ops", "list", false).allow, false);
  assert.equal(decide("ops", "list", true).allow, true);
  const restart = tools.find((t) => t.name === "ops_propose_restart_orbit")!;
  const res = await restart.run({});
  const v = res.value as { status: string; executed: boolean; proposalId: string };
  assert.equal(v.status, "pending-confirmation");
  assert.equal(v.executed, false);
  assert.equal(res.source, "chat/proposals");
  assert.deepEqual(f.calls, [], "calling a propose tool never reaches the helper");
  await assert.rejects(() => restart.run({ unit: "sshd.service" }), /no arguments/);
  const cfg = tools.find((t) => t.name === "ops_propose_config_change")!;
  await assert.rejects(() => cfg.run({ changes: { HOST: "0.0.0.0" } }), /not a setting/);
  await assert.rejects(() => cfg.run({ changes: { ORBIT_MODEL: "gpt-5" }, extra: 1 }), /Only \{changes/);
  assert.equal(((cfg.parameters as { properties: { changes: { additionalProperties: boolean } } }).properties.changes).additionalProperties, false);
  assert.equal(f.calls.length, 0);
});

test("ops_admin_operations lists results with provenance and says in-flight operations are not verified", async () => {
  const f = fakeClient((c) => (c.action === "op_status" ? { ok: true, data: { operation: { state: "running" } } } : { ok: true, data: { operation: { state: "accepted" } } }));
  const { admin, proposals } = ledger({ client: f.client });
  const p = admin.propose("refresh_vault");
  await admin.confirm(proposals.take(p.id) as typeof p);
  const tool = toolsFor(admin).find((t) => t.name === "ops_admin_operations")!;
  assert.match(tool.description, /NOT verified/);
  const res = await tool.run({});
  assert.deepEqual([res.provenance, res.source], ["live", "ops-admin/ledger"]);
  const rows = res.value as { state: string; verification?: unknown; proposalId?: string }[];
  assert.equal(rows[0]!.state, "running");
  assert.equal(rows[0]!.verification, undefined);
  assert.equal(rows[0]!.proposalId, undefined);
});

// ---------------------------------------------------------------- over HTTP: owner only, digest-bound, one shot

let caller: string | undefined = "rai@example.com";
const f = fakeClient();
const hold = ledger({ client: f.client });
let script: Step[] = [];
let scriptAt = 0;
const model: ModelPort = {
  ...never(),
  step: async (_i: Item[]) => script[Math.min(scriptAt++, script.length - 1)]!,
};
const notify = notifier(jsonStore(undefined, "n", []));
const vault = mkdtempSync(join(tmpdir(), "orbit-vault-"));
writeFileSync(join(vault, "now.md"), "x\n");
const memory = vaultMemory(vault);
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((n) => mockPort(n)),
  model,
  memory,
  notify,
  schedule: scheduler(jsonStore(undefined, "j", []), notify),
  runs: runner(jsonStore(undefined, "r", []), [memoryReport(memory)], notify),
  tools: toolbox([]),
  adminOps: hold.admin,
  proposals: hold.proposals,
  nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), "rai@example.com"),
  commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
  owner: "rai@example.com",
  identify: async () => caller,
});
let base = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
const ask = async () => {
  scriptAt = 0;
  script = [{ text: "", calls: [{ call_id: "1", name: "ops_propose_restart_orbit", arguments: "{}" }] }, { text: "Waiting for your confirmation.", calls: [] }];
  const res = await post("/chat", { messages: [{ role: "user", content: "restart yourself" }] });
  return (await res.json()) as { proposals: { id: string; kind: string; digest: string; action: string }[]; calls: { name: string; ok: boolean }[] };
};

test("end to end: the model's request only proposes; the owner's confirmation with the matching digest dispatches once", async () => {
  caller = "rai@example.com";
  f.calls.length = 0;
  const chat = await ask();
  assert.equal(chat.calls[0]!.ok, true);
  assert.equal(chat.proposals.length, 1);
  const p = chat.proposals[0]!;
  assert.equal(p.kind, "ops_admin");
  assert.equal(f.mutations().length, 0, "nothing ran from the model's request");

  assert.equal((await post(`/chat/proposals/${p.id}/confirm`)).status, 409, "no digest");
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: "0".repeat(64) })).status, 409, "wrong digest");
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: 5 })).status, 409);
  assert.equal(f.mutations().length, 0, "refused confirmations do nothing and leave the proposal open");
  assert.equal(((await (await fetch(`${base}/chat/proposals`)).json()) as { proposals: unknown[] }).proposals.length, 1);

  const ok = await post(`/chat/proposals/${p.id}/confirm`, { digest: p.digest });
  assert.equal(ok.status, 202);
  const body = (await ok.json()) as { verified: boolean; dispatched: boolean };
  assert.deepEqual([body.dispatched, body.verified], [true, false]);
  assert.equal(f.mutations().length, 1);
  assert.equal(f.mutations()[0]!.action, "restart_orbit");

  const again = await post(`/chat/proposals/${p.id}/confirm`, { digest: p.digest });
  assert.equal(again.status, 404, "a second confirmation finds nothing");
  assert.equal(f.mutations().length, 1);
});

test("a non-owner cannot propose or confirm, and cannot disturb the owner's open proposal", async () => {
  caller = "rai@example.com";
  const chat = await ask();
  const p = chat.proposals[0]!;
  const before = f.mutations().length;

  caller = "someone@example.com";
  const theirs = await ask();
  assert.deepEqual(theirs.proposals ?? [], [], "no tools are offered to a non-owner");
  assert.equal(theirs.calls?.length ?? 0, 0);
  for (const verb of ["confirm", "cancel"]) assert.equal((await post(`/chat/proposals/${p.id}/${verb}`, { digest: p.digest })).status, 403);
  assert.equal((await fetch(`${base}/chat/proposals`)).status, 403);
  assert.equal((await fetch(`${base}/ops/admin`)).status, 403);
  caller = undefined;
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: p.digest })).status, 403);
  assert.equal(f.mutations().length, before);

  caller = "rai@example.com";
  assert.equal(((await (await fetch(`${base}/chat/proposals`)).json()) as { proposals: { id: string }[] }).proposals.some((x) => x.id === p.id), true, "still open for the owner");
  assert.equal((await post(`/chat/proposals/${p.id}/cancel`)).status, 200);
  assert.equal((await post(`/chat/proposals/${p.id}/confirm`, { digest: p.digest })).status, 404);
  assert.equal(f.mutations().length, before);
});

test("the owner can read the operations ledger over HTTP", async () => {
  caller = "rai@example.com";
  const res = await fetch(`${base}/ops/admin`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { operations: { action: string; proposalId?: string }[] };
  assert.ok(body.operations.length >= 1);
  assert.ok(body.operations.every((o) => o.action));
});

// ---------------------------------------------------------------- the socket client

test("the client speaks the helper's line protocol, validates before sending, and says plainly when the helper is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "admin-sock-"));
  const path = join(dir, "s.sock");
  const seen: string[] = [];
  const srv = createServer((s) => {
    s.on("data", (d) => {
      seen.push(String(d));
      s.end(`${JSON.stringify({ ok: true, action: "restart_orbit", data: { operation: { state: "accepted" }, note: "x".repeat(10) } })}\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(path, r));
  const client = adminClient(path, 2000);
  const res = await client.call("restart_orbit", "3".repeat(40));
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(seen[0]!), { action: "restart_orbit", opId: "3".repeat(40) });
  await assert.rejects(() => client.call("apply_config", "3".repeat(40), { ORBIT_OWNER: "x" } as ConfigChanges), /not a setting/);
  await assert.rejects(() => client.call("restart_orbit", "nope"), /opId/);
  assert.equal(seen.length, 1, "bad calls never leave ORBIT");
  srv.close();
  await assert.rejects(() => adminClient(join(dir, "missing.sock")).call("restart_orbit", "3".repeat(40)), /tier 2 is not installed or not running/);
  assert.equal(adminClient().call.length, 3);
});

// ---------------------------------------------------------------- tier 1 is unchanged; the new units are as narrow as designed

test("tier 1 is untouched: its unit, socket, helper, protocol and the ORBIT service unit are byte-identical to the shipped ones", () => {
  assert.equal(sha("deploy/systemd/orbit-ops@.service"), "088be396050509047680bb157b625b19e11a6e25f0042e1753a4045765a86c63");
  assert.equal(sha("deploy/systemd/orbit-ops.socket"), "9f2516a3337a99551b220d198c63b8b5dc100a0d0465fc6947d62add4d31c27e");
  assert.equal(sha("deploy/systemd/orbit.service"), "1516761d0bda57cd699cf76e77108f079ac82185c267ea1920f3ab9b1b40d48e");
  assert.equal(sha("src/ops/helper.ts"), "47e6384d82720177166f876ce9dd5bc7d56a9efa3ba01b208c6b96a8078fad5a");
  assert.equal(sha("src/ops/protocol.ts"), "3a1dea9c7c865639387531b173c5f6e93d3ba346f789a1b482db2d7cb338b1f1");
  const u = read("deploy/systemd/orbit-ops@.service");
  for (const re of [/^ProtectSystem=strict$/m, /^PrivateNetwork=yes$/m, /^CapabilityBoundingSet=CAP_DAC_READ_SEARCH$/m]) assert.match(u, re);
  assert.ok(!/^ReadWritePaths=/m.test(u));
});

test("the admin socket uses the same group-based access and is a separate socket from tier 1", () => {
  const s = read("deploy/systemd/orbit-ops-admin.socket");
  assert.match(s, /^ListenStream=\/run\/orbit-ops-admin\.sock$/m);
  assert.match(s, /^SocketUser=root$/m);
  assert.match(s, /^SocketGroup=orbit-ops$/m);
  assert.match(s, /^SocketMode=0660$/m);
  assert.match(s, /^Accept=yes$/m);
  assert.notEqual(read("deploy/systemd/orbit-ops.socket"), s);
});

test("the front unit can write only its own state directory and has no network and no capabilities", () => {
  const u = read("deploy/systemd/orbit-ops-admin@.service");
  for (const re of [/^ProtectSystem=strict$/m, /^PrivateNetwork=yes$/m, /^NoNewPrivileges=yes$/m, /^CapabilityBoundingSet=$/m, /^RestrictAddressFamilies=AF_UNIX$/m, /^StateDirectory=orbit-ops-admin$/m, /^StateDirectoryMode=0700$/m, /^ProtectHome=yes$/m, /^StandardInput=socket$/m, /^RuntimeMaxSec=\d+$/m]) assert.match(u, re);
  assert.ok(!/^ReadWritePaths=/m.test(u));
  assert.match(u, /^ExecStart=\/usr\/local\/bin\/node .*\/usr\/local\/lib\/orbit\/ops\/admin-helper\.ts$/m);
  assert.ok(!/^(EnvironmentFile|ImportCredential|LoadCredential)=/m.test(u));
});

test("the runner units have exactly the write access and network their actions need, and not more", () => {
  const run = read("deploy/systemd/orbit-ops-admin-run@.service");
  assert.match(run, /^ReadWritePaths=\/opt\/orbit$/m);
  assert.match(run, /^ReadOnlyPaths=\/opt\/orbit\/repo \/opt\/orbit\/vault$/m);
  assert.match(run, /^ProtectHome=yes$/m);
  assert.match(run, /^IPAddressDeny=any$/m);
  assert.match(run, /^IPAddressAllow=localhost 100\.64\.0\.0\/10 fd7a:115c:a1e0::\/48$/m);
  assert.match(run, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(run, /^CapabilityBoundingSet=$/m);
  assert.match(run, /^Type=oneshot$/m);
  assert.match(run, /admin-run\.ts %i ops$/m);
  const vault = read("deploy/systemd/orbit-ops-admin-vault@.service");
  assert.match(vault, /^ReadWritePaths=\/opt\/orbit\/vault \/opt\/orbit\/state$/m);
  assert.match(vault, /^PrivateNetwork=yes$/m);
  assert.match(vault, /^ProtectHome=read-only$/m);
  assert.match(vault, /admin-run\.ts %i vault$/m);
  for (const u of [run, vault]) {
    assert.match(u, /^ProtectSystem=strict$/m);
    assert.match(u, /^NoNewPrivileges=yes$/m);
    assert.ok(!/credstore|ImportCredential|LoadCredential|EnvironmentFile/.test(u), "no credentials are given to any admin unit");
  }
});

test("the installer installs the admin helper root-owned, without restarting ORBIT or touching credentials, and is wired into install.sh", () => {
  const i = read("deploy/install-admin.sh");
  assert.match(i, /install -m 644 -o root -g root .*admin-protocol\.ts.*admin-core\.ts.*admin-helper\.ts.*admin-run\.ts.*protocol\.ts \/usr\/local\/lib\/orbit\/ops\//);
  assert.match(i, /install -m 755 -o root -g root "\$src\/pull-deploy\.sh" \/usr\/local\/lib\/orbit\/pull-deploy\.sh/);
  assert.match(i, /systemctl enable orbit-ops-admin\.socket/);
  assert.ok(!/restart orbit\.service|orbit\.env|credstore|tailscale|openclaw/i.test(i.replace(/#.*$/gm, "")), "no orbit restart, env rewrite, credential or Tailscale access");
  assert.match(read("deploy/install.sh"), /install-admin\.sh/);
  const deploy = read("deploy/pull-deploy.sh");
  assert.ok(!/orbit-ops|install-admin|lib\/orbit\/ops/.test(deploy), "the app deploy never installs or starts the admin helper");
});
