import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proposals as newProposals } from "../agent.ts";
import type { Proposal } from "../agent.ts";
import type { ValidationCheck } from "./activation.ts";
import type { WorkspaceConfig } from "./config.ts";
import type { Sandbox } from "./sandbox.ts";
import { workspaceService } from "./service.ts";
import type { WorkspaceAudit } from "./service.ts";

// The bounded on-host validation (docs/workspace-tools.md, "Validation"). It runs ON THE PRODUCTION HOST, UNDER THE PRODUCTION SANDBOX,
// with the same code ORBIT uses for the model: the workspace service's tools, its proposal/confirmation checks, its queue and the
// bubblewrap launcher with the operator's delegated cgroup and limits. It is the owner-approved replacement for a separate VM run.
//
// What it is NOT: a stress or adversarial suite. No fork bombs, no memory exhaustion, no unbounded load, no destructive probes. Every
// command is fixed here (never from the model), runs in the dedicated "orbit-validation" workspace only, and touches nothing else:
// its files are synthetic, its canary is a fresh random file in ORBIT's own state directory (never a host secret), and every wait is
// bounded. It keeps its own operation records (<state>/workspace/validation-runs), separate from the model's.
//
// Its checks are evidence about THIS host at THIS moment, for THIS policy. Designing the sandbox is not proving it; this run is the
// proof that the basic isolation holds where ORBIT actually runs, and it cannot be skipped or faked: enable requires a passing record
// whose policy, sandbox implementation and validation workspace equal the running ones (src/workspace/activation.ts).

export const VALIDATION_WORKSPACE = "orbit-validation";
export const SMOKE_STEPS: readonly { id: string; title: string; required: boolean }[] = [
  { id: "sandbox_supported", title: "The production sandbox self-test passed (state 'supported')", required: true },
  { id: "write_no_effect_before_confirm", title: "fs_write only proposes: the file does not exist before confirmation", required: true },
  { id: "write_confirmed_once", title: "Confirming writes the file exactly once (atomic, version recorded)", required: true },
  { id: "replay_refused", title: "Confirming the same approval again is refused and changes nothing", required: true },
  { id: "digest_tamper_refused", title: "An approval whose digest does not match the held operation is refused; nothing is written", required: true },
  { id: "list_read_stat", title: "fs_list, fs_read and fs_stat see the written file through the confined walk", required: true },
  { id: "patch_confirmed", title: "fs_patch proposes, and confirming applies exactly the shown edit", required: true },
  { id: "stale_patch_refused", title: "A patch confirmed after the file changed is refused (version precondition at run time)", required: true },
  { id: "exec_no_effect_before_confirm", title: "exec_start only proposes: the command's output file does not exist before confirmation", required: true },
  { id: "exec_confirmed", title: "A confirmed command runs once in the sandbox as uid 1000 and writes only in the workspace", required: true },
  { id: "network_isolated", title: "No network: only the sandbox's own loopback, no routes, a connection attempt to a TEST-NET address fails", required: true },
  { id: "host_paths_hidden", title: "A fresh canary outside the workspace, ORBIT's state, credentials, /etc/shadow, /home, /root, /var, /opt are invisible", required: true },
  { id: "runtime_read_only", title: "The runtime (/usr), the sandbox root and /etc are read-only", required: true },
  { id: "unprivileged", title: "No capabilities (CapEff 0) and no_new_privs set", required: true },
  { id: "clean_environment", title: "Only the fixed clean environment is visible", required: true },
  { id: "timeout_enforced", title: "The launcher kills a run at its wall-clock limit (3 s here) and its process tree is confirmed gone", required: true },
  { id: "cancel_kills_tree", title: "exec_cancel kills a running command; it is reported cancelled only after its exit, tree confirmed gone", required: true },
  { id: "background_process_cleaned", title: "A background process left by a command is killed with it (tree confirmed gone)", required: true },
  { id: "no_cleanup_quarantine", title: "No validation run left an unverified process tree", required: true },
  { id: "synthetic_files_removed", title: "The synthetic files and the canary were removed afterwards", required: false },
];

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

export type SmokeDeps = {
  config: WorkspaceConfig;
  sandbox: Sandbox;
  stateDir: string;
  audit?: (e: WorkspaceAudit) => void;
  // Each check as it completes (progress for the record and the journal).
  onCheck?: (c: ValidationCheck) => void;
  timeouts?: { runMs?: number; startMs?: number };
};

export async function runSmoke(d: SmokeDeps): Promise<{ checks: ValidationCheck[]; passed: boolean; workspaceIdentity: string }> {
  const checks: ValidationCheck[] = [];
  const runMs = d.timeouts?.runMs ?? 60_000;
  const startMs = d.timeouts?.startMs ?? 15_000;
  const record = (id: string, ok: boolean | "not_checked", detail: string) => {
    const step = SMOKE_STEPS.find((s) => s.id === id)!;
    const c: ValidationCheck = { id, title: step.title, required: step.required, result: ok === "not_checked" ? "not_checked" : ok ? "pass" : "fail", detail: detail.slice(0, 300) };
    checks.push(c);
    d.onCheck?.(c);
    return ok === true;
  };
  const finishWith = (identity: string) => {
    // Every step has a result; a step that never ran (an earlier failure stopped the run) is a failure, never a pass.
    for (const s of SMOKE_STEPS) if (!checks.some((c) => c.id === s.id)) record(s.id, s.required ? false : "not_checked", "did not run (an earlier step failed or the run stopped)");
    const passed = checks.every((c) => !c.required || c.result === "pass");
    return { checks: SMOKE_STEPS.map((s) => checks.find((c) => c.id === s.id)!), passed, workspaceIdentity: identity };
  };

  const w = d.config.workspaces.find((x) => x.id === VALIDATION_WORKSPACE);
  if (!w || !w.exec) {
    record("sandbox_supported", false, `the validation workspace "${VALIDATION_WORKSPACE}" (exec) is not configured; the host setup creates it`);
    return finishWith("");
  }
  const sb = d.sandbox.status();
  if (!record("sandbox_supported", sb.state === "supported", `state ${sb.state}${sb.reasons.length ? `: ${sb.reasons.join("; ")}` : ""}`)) return finishWith(w.identity);

  // A private service over the validation workspace only: the production tools, confirmation checks, queue and launcher, its own
  // proposals (no card ever reaches a conversation) and its own records.
  const proposals = newProposals();
  const svc = workspaceService({ activation: { state: "enabled", config: { ...d.config, workspaces: [w] } }, sandbox: d.sandbox, stateDir: join(d.stateDir, "validation-runs"), proposals, audit: d.audit });
  await svc.recover();
  const tool = (n: string) => svc.tools.find((t) => t.name === n)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (n: string, a: Record<string, unknown>): Promise<any> => ((await tool(n).run(a)) as { value: unknown }).value;
  const take = (id: string) => proposals.take(id) as Proposal & { kind: "workspace_op" };
  const exists = async (path: string) => {
    try {
      await call("fs_stat", { workspace: w.id, path });
      return true;
    } catch (e) {
      if (/not_found/.test(String(e))) return false;
      throw e;
    }
  };
  const settle = async (ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)));
    const out = await Promise.race([svc.idle().then(() => "idle" as const), t]);
    clearTimeout(timer);
    return out;
  };
  const tag = randomBytes(6).toString("hex");
  const A = `smoke-${tag}-a.txt`;
  const B = `smoke-${tag}-b.txt`;
  const C = `smoke-${tag}-exec.txt`;
  const canary = join(d.stateDir, `validation-canary-${tag}`);

  // The steps; `return` stops at the first failure that makes later steps meaningless.
  const steps = async (): Promise<void> => {
    // ---- file proposals, confirmation, replay, tamper -------------------------------------------------------------------------
    const pw = await call("fs_write", { workspace: w.id, path: A, content: `orbit validation ${tag}\nline two\n`, createOnly: true });
    if (!record("write_no_effect_before_confirm", pw.status === "pending-confirmation" && pw.executed === false && !(await exists(A)), `proposal ${pw.status}; file present: ${await exists(A)}`)) return;
    const heldW = take(pw.proposalId);
    const cw = await svc.confirm(heldW);
    const readA = cw.code === 200 ? await call("fs_read", { workspace: w.id, path: A }) : undefined;
    if (!record("write_confirmed_once", cw.code === 200 && readA?.text === `orbit validation ${tag}\nline two\n` && readA?.version === cw.body.version, `confirm ${cw.code}; version matches: ${readA?.version === cw.body.version}`)) return;
    const replay = await svc.confirm(heldW);
    const readA2 = await call("fs_read", { workspace: w.id, path: A });
    record("replay_refused", replay.code >= 400 && readA2.version === readA.version, `replay answered ${replay.code}; file unchanged: ${readA2.version === readA.version}`);
    const pb = await call("fs_write", { workspace: w.id, path: B, content: "tamper\n", createOnly: true });
    const heldB = take(pb.proposalId);
    const forged = { ...heldB, digest: `sha256:${"0".repeat(64)}` };
    const ct = await svc.confirm(forged);
    record("digest_tamper_refused", ct.code === 409 && !(await exists(B)), `confirm with a forged digest answered ${ct.code}; file present: ${await exists(B)}`);

    const list = await call("fs_list", { workspace: w.id });
    const st = await call("fs_stat", { workspace: w.id, path: A });
    record("list_read_stat", list.entries.some((e: { name: string }) => e.name === A) && st.type === "file" && st.version === readA.version, `listed: ${list.entries.some((e: { name: string }) => e.name === A)}; stat ${st.type}`);

    const pp = await call("fs_patch", { workspace: w.id, path: A, expectedVersion: readA.version, edits: [{ find: "line two", replace: "line two (patched)" }] });
    const cp = await svc.confirm(take(pp.proposalId));
    const readA3 = await call("fs_read", { workspace: w.id, path: A });
    record("patch_confirmed", cp.code === 200 && readA3.text === `orbit validation ${tag}\nline two (patched)\n`, `confirm ${cp.code}`);
    const stale = await call("fs_patch", { workspace: w.id, path: A, expectedVersion: readA3.version, edits: [{ find: "patched", replace: "stale" }] });
    const rewrite = await call("fs_write", { workspace: w.id, path: A, content: "replaced\n", expectedVersion: readA3.version });
    const cr = await svc.confirm(take(rewrite.proposalId));
    const cs = await svc.confirm(take(stale.proposalId));
    const readA4 = await call("fs_read", { workspace: w.id, path: A });
    record("stale_patch_refused", cr.code === 200 && cs.code === 409 && readA4.text === "replaced\n", `rewrite ${cr.code}; stale patch ${cs.code}`);

    // ---- a confirmed command, and the isolation transcript ------------------------------------------------------------------
    const pe = await call("exec_start", { workspace: w.id, argv: ["/bin/sh", "-c", `echo smoke-exec > ${C}; id -u`] });
    if (!record("exec_no_effect_before_confirm", pe.status === "pending-confirmation" && !(await exists(C)), `proposal ${pe.status}`)) return;
    const ce = await svc.confirm(take(pe.proposalId));
    const se = ce.code === 202 ? await settle(runMs) : "refused";
    const ee = svc.ledger.get(String(ce.body.opId));
    const outE = ee ? svc.ledger.readOutput(ee.opId, "stdout")?.toString("utf8") : undefined;
    const readC = (await exists(C)) ? (await call("fs_read", { workspace: w.id, path: C })).text : undefined;
    if (!record("exec_confirmed", se === "idle" && ee?.state === "completed" && ee.exitCode === 0 && readC === "smoke-exec\n" && outE === "1000\n" && ee.treeGone === true, `confirm ${ce.code}; ${se}; state ${ee?.state}; exit ${ee?.exitCode}; uid ${(outE ?? "").trim()}; tree gone ${ee?.treeGone}`)) return;

    writeFileSync(canary, `orbit validation canary ${tag}\n`, { mode: 0o600 });
    const hidden = [canary, d.stateDir, "/etc/shadow", "/etc/credstore", "/home", "/root", "/var", "/opt", "/opt/orbit", "/run/systemd"];
    const script = [
      'echo "uid=$(id -u)"',
      'printf "ifaces="; tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " " | tr "\\n" ","; echo',
      'echo "routes=$(tail -n +2 /proc/net/route 2>/dev/null | wc -l)"',
      'echo "capeff=$(grep "^CapEff:" /proc/self/status | cut -f2)"',
      'echo "nnp=$(grep "^NoNewPrivs:" /proc/self/status | cut -f2)"',
      ...hidden.map((p) => `test -e ${q(p)} && echo "visible=${p.replace(/[^A-Za-z0-9/._-]/g, "_")}"`),
      "touch /usr/.orbit-smoke 2>/dev/null && echo runtime_writable",
      "touch /.orbit-smoke 2>/dev/null && echo root_writable",
      "mkdir /etc/.orbit-smoke 2>/dev/null && echo etc_writable",
      'echo "env=$(env | cut -d= -f1 | sort | tr "\\n" ",")"',
      // One TCP connection attempt to 192.0.2.1 (TEST-NET-1, never routed): in a network namespace with only loopback it must fail at
      // once. Needs python3 in the runtime; without it this sub-check is reported as not checked (the interface and route checks stay).
      "if command -v python3 >/dev/null 2>&1; then python3 -c 'import socket",
      "s = socket.socket(); s.settimeout(2)",
      "try:",
      "    s.connect((\"192.0.2.1\", 9)); print(\"net=connected\")",
      "except OSError as e:",
      "    print(\"net=failed\")'; else echo net=not_checked; fi",
      "true",
    ].join("\n");
    const pi = await call("exec_start", { workspace: w.id, argv: ["/bin/sh", "/run/orbit/script"], script });
    const ci = await svc.confirm(take(pi.proposalId));
    const si = ci.code === 202 ? await settle(runMs) : "refused";
    const ei = svc.ledger.get(String(ci.body.opId));
    const out = (ei ? svc.ledger.readOutput(ei.opId, "stdout")?.toString("utf8") : undefined) ?? "";
    const ran = si === "idle" && ei?.state === "completed" && ei.exitCode === 0;
    const lines = out.split("\n");
    const val = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
    const why = ran ? "" : `the transcript command did not complete (${si}; ${ei?.state}; exit ${ei?.exitCode}); `;
    const net = val("net");
    record("network_isolated", ran && val("ifaces") === "lo," && val("routes") === "0" && net !== "connected" && net !== undefined, `${why}interfaces ${val("ifaces")}; routes ${val("routes")}; TCP attempt ${net === "not_checked" ? "not checked (no python3 in the runtime)" : net}`);
    const visible = lines.filter((l) => l.startsWith("visible="));
    record("host_paths_hidden", ran && !visible.length, `${why}${visible.length ? `visible: ${visible.map((l) => l.slice(8)).join(", ")}` : `${hidden.length} paths absent, including a fresh canary`}`);
    record("runtime_read_only", ran && !["runtime_writable", "root_writable", "etc_writable"].some((x) => lines.includes(x)), `${why}${["runtime_writable", "root_writable", "etc_writable"].filter((x) => lines.includes(x)).join(", ") || "all refused"}`);
    record("unprivileged", ran && val("uid") === "1000" && /^0+$/.test(val("capeff") ?? "") && val("nnp") === "1", `${why}uid ${val("uid")}; CapEff ${val("capeff")}; NoNewPrivs ${val("nnp")}`);
    const env = (val("env") ?? "").split(",").filter(Boolean);
    const extra = env.filter((k) => !["PATH", "HOME", "LANG", "TMPDIR", "USER", "LOGNAME", "PWD", "SHLVL", "_", "OLDPWD"].includes(k));
    record("clean_environment", ran && env.length > 0 && !extra.length, `${why}${extra.length ? `unexpected: ${extra.length} variable(s)` : "only the fixed set"}`);

    // ---- timeout, cancel, background cleanup ------------------------------------------------------------------------------------
    // The wall-clock kill is the launcher's own; it is exercised directly with a 3-second limit (the configured limit is minutes).
    const t0 = Date.now();
    const ht = d.sandbox.start({ runId: `ws-${randomBytes(8).toString("hex")}`, workspace: w, cwd: [], argv: ["sleep", "30"], limits: { ...d.config.sandbox.limits, timeoutSec: 3 } });
    const rt = await ht.done;
    const took = Date.now() - t0;
    record("timeout_enforced", ht.pid !== undefined && rt.killedBy === "timeout" && rt.treeGone === true && took < 15_000, `killed by ${rt.killedBy ?? "nothing"} after ${Math.round(took / 100) / 10} s; tree gone ${rt.treeGone}${rt.startError ? `; ${rt.startError}` : ""}`);

    const pk = await call("exec_start", { workspace: w.id, argv: ["sleep", "60"] });
    const ck = await svc.confirm(take(pk.proposalId));
    const kid = String(ck.body.opId);
    const s0 = Date.now();
    while (svc.ledger.get(kid)?.state !== "running" && Date.now() - s0 < startMs) await sleep(50);
    const cancel = svc.ledger.get(kid)?.state === "running" ? await call("exec_cancel", { runId: kid }) : undefined;
    const sk = await settle(startMs);
    const ek = svc.ledger.get(kid);
    record("cancel_kills_tree", Boolean(cancel?.cancelRequested) && sk === "idle" && ek?.state === "cancelled" && ek.treeGone === true, `cancel requested: ${Boolean(cancel?.cancelRequested)}; ${sk}; state ${ek?.state}; tree gone ${ek?.treeGone}`);

    const b0 = Date.now();
    const pg = await call("exec_start", { workspace: w.id, argv: ["/bin/sh", "-c", "sleep 60 & echo started"] });
    const cg = await svc.confirm(take(pg.proposalId));
    const sg = cg.code === 202 ? await settle(startMs + 5000) : "refused";
    const eg = svc.ledger.get(String(cg.body.opId));
    record("background_process_cleaned", sg === "idle" && eg?.state === "completed" && eg.treeGone === true && Date.now() - b0 < startMs + 5000, `${sg}; state ${eg?.state}; tree gone ${eg?.treeGone}`);
  };
  try {
    await steps();
  } catch (e) {
    // An unexpected refusal or error ends the run; every step that did not run is recorded as failed by finishWith.
    const pending = SMOKE_STEPS.find((s) => !checks.some((c) => c.id === s.id));
    if (pending) record(pending.id, false, `error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    record("no_cleanup_quarantine", svc.quarantined().length === 0, svc.quarantined().length ? `unverified: ${svc.quarantined().join(", ")}` : "none");
    let removed = false;
    try {
      rmSync(canary, { force: true });
      const pc = await call("exec_start", { workspace: w.id, argv: ["/bin/sh", "-c", `rm -f smoke-${tag}-*`] });
      const cc = await svc.confirm(take(pc.proposalId));
      removed = cc.code === 202 && (await settle(runMs)) === "idle" && svc.ledger.get(String(cc.body.opId))?.state === "completed";
    } catch {
      removed = false;
    }
    record("synthetic_files_removed", removed ? true : "not_checked", removed ? "removed" : `could not be confirmed; leftover files are named smoke-${tag}-* in the validation workspace`);
  }
  return finishWith(w.identity);
}
