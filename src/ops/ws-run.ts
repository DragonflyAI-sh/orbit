// orbit-ops-ws-run: the runner for ONE accepted operation (orbit-ops-ws-run@<opId>.service), and, in "pkg" mode, the package step
// of that operation (orbit-ops-ws-pkg@<opId>.service, the only unit with network access, because apt-get needs the mirrors).
//
// ws_setup: runs only a record in `accepted`. It recomputes the fixed plan and refuses, with nothing changed, if the plan key differs
// from the one the owner confirmed or a step is blocked. It then executes the steps that are to do, in order, with bounded timeouts,
// recording each; it stops at the first failure (no rollback: it never deletes an image or workspace data, never removes a package,
// user or file). Afterwards it verifies by OBSERVATION: the recomputed plan must show every step done, and ORBIT's /status must
// answer 200 and serve the same commit as before. `verified` comes only from that; nothing to do is `no_change`.
// ws_revoke: rewrites the drop-in without its Environment= line, reloads, restarts ORBIT and verifies the same way. It never deletes
// images, mounts, the user, the workspaces file or packages.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OP_ID, cap, isWsTerminal, type WsRecord } from "./ws-protocol.ts";
import {
  APT_ARGS,
  APT_ENV,
  APT_LOCK_TEXT,
  BIN,
  DROPIN_PATH,
  DROPIN_REVOKED_TEXT,
  DROPIN_TEXT,
  NSS_ENV,
  ORBIT_UNIT,
  ORBIT_USER,
  SANDBOX,
  WS_CONFIG,
  addStep,
  T,
  clearImageMarker,
  computePlan,
  currentCommit,
  describeOp,
  gatherFacts,
  loadRecord,
  mountPoint,
  opWorstMs,
  orbitOutOfDate,
  parseMountinfo,
  saveRecord,
  setupWorstMs,
  statusAddress,
  systemWsEnv,
  workspaceOfImage,
  writeImageMarker,
  type Op,
  type WsConfig,
  type WsEnv,
} from "./ws-core.ts";

type Audit = (line: object) => void;
type Ctx = { env: WsEnv; c: WsConfig; rec: WsRecord; audit: Audit; created: Set<string>; expected?: string; address?: { host: string; port: number }; deadline?: number };

const step = (x: Ctx, name: string, detail: string) => addStep(x.c, x.rec, x.env, name, detail, x.audit);
const lastLines = (text: string, n = 2) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).map((l) => cap(l, 120)).join(" | ");
const short = (op: Op) => cap(describeOp(op).split("\n")[0]!, 140);

function finish(x: Ctx, state: WsRecord["state"], summary: string, verification: NonNullable<WsRecord["verification"]>, extra: Partial<WsRecord> = {}): void {
  Object.assign(x.rec, extra);
  x.rec.state = state;
  x.rec.summary = cap(summary, 600);
  x.rec.verification = { ...verification, detail: cap(verification.detail, 300) };
}

// ---- health: /status must answer 200 and serve the commit that was deployed before; nothing else counts ----

type Health = { healthy: boolean; served?: string; detail: string };
async function waitHealthy(x: Ctx): Promise<Health> {
  const { address, expected } = x;
  if (!address || !expected) return { healthy: false, detail: "HOST/PORT or the deployed commit could not be read, so /status could not be checked." };
  const deadline = x.env.now().getTime() + x.c.healthWindowMs;
  let served: string | undefined;
  let reached = false;
  for (;;) {
    const p = await x.env.probe(address.host, address.port, "/status");
    reached = reached || p.reachable;
    served = p.commit ?? served;
    if (p.reachable && p.httpStatus === 200 && p.commit === expected) return { healthy: true, served: p.commit, detail: `/status served ${expected.slice(0, 12)}.` };
    if (x.env.now().getTime() >= deadline) break;
    await x.env.sleep(x.c.healthIntervalMs);
  }
  const why = !reached ? "/status never answered" : served === expected ? "/status did not answer 200" : `/status served ${served ? served.slice(0, 12) : "no commit"}, expected ${expected.slice(0, 12)}`;
  return { healthy: false, ...(served ? { served } : {}), detail: `${why} within ${Math.round(x.c.healthWindowMs / 1000)}s.` };
}

// ---- one operation of a step ----

type OpResult = { ok: boolean; detail: string };

async function resolveGid(x: Ctx, group: "root" | "orbit"): Promise<number | undefined> {
  if (group === "root") return 0;
  const r = await x.env.exec(BIN.getent, ["group", ORBIT_USER], T.short, { env: { ...NSS_ENV } });
  const f = r.code === 0 ? r.stdout.split("\n")[0]!.split(":") : [];
  return f[0] === ORBIT_USER && /^[0-9]{1,10}$/.test(f[2] ?? "") ? Number(f[2]) : undefined;
}

function bwrapOk(x: Ctx): boolean {
  const b = x.env.fs.stat(SANDBOX.bwrap);
  return Boolean(b && b.kind === "file" && b.uid === 0 && !(b.mode & 0o6022));
}

async function runOp(x: Ctx, op: Op): Promise<OpResult> {
  const { env, c } = x;
  switch (op.k) {
    case "exec": {
      // mkfs.ext4 is only ever run on an image this operation itself created a moment ago (never on an existing one).
      if (op.file === BIN.mkfs && !x.created.has(op.args.at(-1)!)) return { ok: false, detail: "refused: mkfs.ext4 is only run on an image this operation created" };
      const r = await env.exec(op.file, op.args, op.timeoutMs, op.env ? { env: op.env } : undefined);
      const ok = r.code === 0 && !r.timedOut;
      // The image is formatted: it is no longer a partial leftover (finding 5). Until this point a crash leaves the marker behind.
      if (ok && op.file === BIN.mkfs) {
        const id = workspaceOfImage(op.args.at(-1)!);
        if (id) clearImageMarker(c, id);
      }
      return { ok, detail: `${short(op)}: ${r.timedOut ? "timed out" : `exit ${r.code}`}${ok ? "" : ` ${lastLines(r.stderr || r.stdout)}`}` };
    }
    case "pkg": {
      x.rec.pkgRequested = true;
      saveRecord(c, x.rec, env);
      const unit = `${c.units.pkg}${x.rec.opId}.service`;
      const r = await env.exec(BIN.systemctl, ["start", unit], T.pkg);
      // The package unit wrote its own steps into the record: take them over before writing again.
      const fresh = loadRecord(c, x.rec.opId);
      if (fresh) Object.assign(x.rec, fresh);
      delete x.rec.pkgRequested;
      saveRecord(c, x.rec, env);
      const ok = bwrapOk(x);
      const why =
        x.rec.pkgResult === "busy" ? "the package manager was busy (another apt, dpkg or unattended-upgrades held the lock); nothing was changed, killed or unlocked"
        : x.rec.pkgResult === "failed" ? "apt-get install failed"
        : r.code !== 0 ? `the package unit failed (systemctl exit ${r.code})`
        : "after the package unit";
      return { ok, detail: ok ? `${SANDBOX.bwrap} is now present, root-owned and not setuid (observed)` : `${SANDBOX.bwrap} is not usable: ${why}` };
    }
    case "ensure_dir":
      env.fs.ensureDir(op.path, op.mode);
      return { ok: true, detail: `directory ${op.path} present, mode 0${op.mode.toString(8)}` };
    case "create_image": {
      try {
        env.fs.createExclusive(op.path, 0o600);
      } catch (err) {
        return { ok: false, detail: `${op.path} could not be created exclusively (${(err as NodeJS.ErrnoException).code ?? "error"}); an existing file is never formatted` };
      }
      x.created.add(op.path);
      // Durable evidence that THIS helper created this exact file and has not formatted it yet: if the runner is killed before mkfs
      // succeeds, the next setup recognises the leftover by inode and replaces only it (finding 5 of the PR #147 review).
      const st = env.fs.lstat(op.path);
      const id = workspaceOfImage(op.path);
      if (!st || st.dev === undefined || st.ino === undefined || !id) return { ok: false, detail: `${op.path} was created but could not be identified; stopped before formatting it` };
      writeImageMarker(c, id, { path: op.path, dev: st.dev, ino: st.ino, opId: x.rec.opId, at: env.now().toISOString() });
      return { ok: true, detail: `created empty ${op.path} (0600; recorded as unformatted until mkfs succeeds)` };
    }
    case "discard_partial_image": {
      const mounted = parseMountinfo(env.fs.readText("/proc/self/mountinfo", 4 * 1024 * 1024) ?? "").some((m) => m.point === mountPoint(op.workspace));
      if (mounted) return { ok: false, detail: `refused: something is mounted at ${mountPoint(op.workspace)}; ${op.path} was not removed` };
      try {
        env.fs.removeExact(op.path, { dev: op.dev, ino: op.ino });
      } catch (err) {
        return { ok: false, detail: `refused: ${cap(err instanceof Error ? err.message : "error", 120)}` };
      }
      clearImageMarker(c, op.workspace);
      return { ok: true, detail: `removed the partial image ${op.path} (inode ${op.ino}) left by an interrupted earlier setup` };
    }
    case "write": {
      const gid = await resolveGid(x, op.group);
      if (gid === undefined) return { ok: false, detail: `group ${op.group} could not be resolved; ${op.path} was not written` };
      try {
        env.fs.writeFile(op.path, op.content, { mode: op.mode, uid: 0, gid, noClobber: op.noClobber });
      } catch (err) {
        return { ok: false, detail: `${op.path} was not written (${(err as NodeJS.ErrnoException).code ?? "error"})${op.noClobber ? "; an existing file is never overwritten" : ""}` };
      }
      const same = env.fs.readText(op.path, 64 * 1024) === op.content;
      return { ok: same, detail: `wrote ${op.path} (${same ? "read back identical" : "read back DIFFERENT"})` };
    }
    case "tidy_lost_found": {
      const lf = `${op.root}/lost+found`;
      if (!env.fs.lstat(lf)) return { ok: true, detail: `no ${lf}` };
      return runOp(x, { k: "exec", file: BIN.rmdir, args: [lf], timeoutMs: T.short });
    }
    case "restart_and_health": {
      const reload = await env.exec(BIN.systemctl, ["daemon-reload"], T.reload);
      step(x, "daemon-reload", reload.timedOut ? "timed out" : `exit ${reload.code}`);
      if (reload.code !== 0 || reload.timedOut) return { ok: false, detail: "systemctl daemon-reload failed; ORBIT was not restarted" };
      step(x, "restart", `restarting ${ORBIT_UNIT}; expecting /status to serve ${x.expected?.slice(0, 12)}`);
      const r = await env.exec(BIN.systemctl, ["restart", ORBIT_UNIT], T.restart);
      step(x, "restart-command", r.timedOut ? "timed out" : `exit ${r.code}`);
      const h = await waitHealthy(x);
      return { ok: h.healthy, detail: h.detail };
    }
  }
}

const blockerNote = (ids: string[]) => (ids.length ? ` Host blockers remain (${ids.join(", ")}): sandboxed exec stays unavailable until an operator resolves them; this helper never changes them.` : "");

// ---- ws_setup ----

async function setup(x: Ctx): Promise<void> {
  const plan = await computePlan(x.env, x.c);
  const blockers = plan.blockers.map((b) => b.id);
  x.rec.blockers = blockers;
  const blocked = plan.steps.filter((s) => s.state === "blocked").map((s) => s.id);
  if (blocked.length) return finish(x, "failed", `Nothing was changed: ${blocked.join(", ")} became blocked since the plan was confirmed. See ws_status.`, { checked: false, detail: "Refused before any change." }, { failedStep: "plan", code: "plan_blocked" });
  if (plan.planKey !== x.rec.planKey) {
    return finish(x, "failed", "Nothing was changed: the host no longer matches the plan that was confirmed (it changed in between). Ask for the current plan and confirm that one.", { checked: false, detail: `Plan key is now ${plan.planKey}, confirmed ${x.rec.planKey}.` }, { failedStep: "plan", code: "plan_changed" });
  }
  const todo = plan.planned.filter((s) => s.state === "todo");
  if (!todo.length) return finish(x, "no_change", `The host is already set up; nothing was changed.${blockerNote(blockers)}`, { checked: false, detail: "Nothing to do." });
  // Time bounds (finding 5): the plan's worst case must fit the runner's budget, which the unit's TimeoutStartSec covers. A plan that
  // does not fit is refused before any change, so systemd never has to kill the runner in the middle of a step.
  const worst = setupWorstMs(todo, x.c.healthWindowMs, x.c.healthIntervalMs);
  if (worst > x.c.runBudgetMs) return finish(x, "failed", `Nothing was changed: the plan could take up to ${Math.ceil(worst / 1000)} s, more than the runner's budget of ${Math.round(x.c.runBudgetMs / 1000)} s.`, { checked: false, detail: "Refused before any change." }, { failedStep: "plan", code: "over_budget" });
  x.expected = currentCommit(x.env, x.c);
  x.address = statusAddress(x.env, x.c);
  if (!x.expected || !x.address) return finish(x, "failed", "Nothing was changed: the deployed commit or ORBIT's HOST/PORT could not be read, so the result could not be verified.", { checked: false, detail: "Refused before any change." }, { failedStep: "plan", code: "unverifiable" });

  const done: string[] = [];
  for (const s of todo) {
    step(x, s.id, `starting: ${s.title}`);
    for (const op of s.ops) {
      let r: OpResult;
      // Never start a step that could outlive the budget (a safety net: the up-front check above already bounds the plan).
      if (x.deadline !== undefined && x.env.now().getTime() + opWorstMs(op, x.c.healthWindowMs, x.c.healthIntervalMs) > x.deadline) {
        r = { ok: false, detail: `not started: ${short(op)} could not finish within the runner's time budget` };
      } else {
        try {
          r = await runOp(x, op);
        } catch (err) {
          r = { ok: false, detail: `${short(op)}: ${cap(err instanceof Error ? err.message : "error", 100)}` };
        }
      }
      step(x, s.id, r.detail);
      if (!r.ok) {
        const left = [...x.created].length ? ` The new image file(s) ${[...x.created].join(", ")} were left in place (possibly empty or unformatted) and recorded as unformatted: the next setup replaces exactly such a file and nothing else. This helper never deletes any other image.` : "";
        return finish(
          x,
          "failed",
          `Stopped at ${s.id}: ${r.detail}. ${done.length ? `Completed before it: ${done.join(", ")}.` : "No earlier step had completed."} Nothing was rolled back or deleted and later steps were not run.${left}${blockerNote(blockers)}`,
          { checked: s.id === "apply", healthy: false, expectedCommit: x.expected, detail: r.detail },
          { failedStep: s.id, code: "step_failed" },
        );
      }
    }
    done.push(s.id);
  }

  // Verification from observation only.
  const h = await waitHealthy(x);
  step(x, "verify-status", h.detail);
  const after = await computePlan(x.env, x.c);
  const open = after.steps.filter((s) => s.state !== "done").map((s) => `${s.id} (${s.state})`);
  step(x, "verify-plan", open.length ? `still not done: ${open.join(", ")}` : "every step is done");
  const ver = { checked: true, healthy: h.healthy, planComplete: !open.length, expectedCommit: x.expected, ...(h.served ? { servedCommit: h.served } : {}) };
  if (h.healthy && !open.length) {
    return finish(x, "verified", `Workspace host setup applied (${done.join(", ")}); every step is now observed done and /status serves ${x.expected.slice(0, 12)}. Workspace tools stay off until the owner enables them in ORBIT.${blockerNote(blockers)}`, { ...ver, detail: h.detail });
  }
  finish(x, "failed", `The steps ran (${done.join(", ")}) but verification failed: ${h.healthy ? "" : `${h.detail} `}${open.length ? `still not done: ${open.join(", ")}.` : ""} Nothing was rolled back.${blockerNote(blockers)}`, { ...ver, detail: h.healthy ? `Plan incomplete: ${open.join(", ")}` : h.detail }, { failedStep: "verify", code: "not_verified" });
}

// ---- ws_revoke ----

async function revoke(x: Ctx): Promise<void> {
  const f = await gatherFacts(x.env);
  if (!f.dropIn) return finish(x, "no_change", "There is no orbit-ops-ws drop-in, so the host does not permit workspace tools; nothing was changed.", { checked: false, detail: "Nothing to do." });
  const text = f.dropInText;
  if (text !== DROPIN_TEXT && text !== DROPIN_REVOKED_TEXT) {
    return finish(x, "failed", `Nothing was changed: ${DROPIN_PATH} has content this helper did not write. Remove its Environment= line by hand, then run systemctl daemon-reload and restart orbit.service.`, { checked: false, detail: "Refused before any change." }, { failedStep: "plan", code: "operator_managed" });
  }
  if (text === DROPIN_REVOKED_TEXT && !orbitOutOfDate(f, false).length) return finish(x, "no_change", "Already revoked: the drop-in has no Environment= line and ORBIT runs with it. Nothing was changed.", { checked: false, detail: "Nothing to do." });
  x.expected = currentCommit(x.env, x.c);
  x.address = statusAddress(x.env, x.c);
  if (!x.expected || !x.address) return finish(x, "failed", "Nothing was changed: the deployed commit or ORBIT's HOST/PORT could not be read, so the result could not be verified.", { checked: false, detail: "Refused before any change." }, { failedStep: "plan", code: "unverifiable" });
  if (text === DROPIN_TEXT) {
    const w = await runOp(x, { k: "write", path: DROPIN_PATH, content: DROPIN_REVOKED_TEXT, mode: 0o644, group: "root", noClobber: false });
    step(x, "dropin", w.detail);
    if (!w.ok) return finish(x, "failed", `Stopped: ${w.detail}. ORBIT was not restarted.`, { checked: false, detail: w.detail }, { failedStep: "service_dropin", code: "step_failed" });
  }
  const r = await runOp(x, { k: "restart_and_health" });
  step(x, "apply", r.detail);
  const after = await gatherFacts(x.env);
  const stale = orbitOutOfDate(after, false);
  const revoked = after.dropInText === DROPIN_REVOKED_TEXT;
  const ver = { checked: true, healthy: r.ok, planComplete: revoked && !stale.length, expectedCommit: x.expected };
  if (r.ok && revoked && !stale.length) return finish(x, "verified", `Revoked: the drop-in no longer sets ORBIT_WORKSPACE_TOOLS or ORBIT_WORKSPACES_FILE; ORBIT restarted and /status serves ${x.expected.slice(0, 12)}. Images, mounts, the orbit user, the workspaces file and packages were kept.`, { ...ver, detail: r.detail });
  finish(x, "failed", `Revocation not verified: ${r.ok ? "" : `${r.detail} `}${revoked ? "" : "the drop-in does not read back as revoked. "}${stale.length ? stale.join("; ") : ""}`, { ...ver, detail: r.detail }, { failedStep: r.ok ? "verify" : "apply", code: "not_verified" });
}

// ---- driver ----

export async function runOperation(opId: string, env: WsEnv, c: WsConfig, audit: Audit): Promise<WsRecord | undefined> {
  const rec = loadRecord(c, opId);
  if (!rec) return undefined;
  const x: Ctx = { env, c, rec, audit, created: new Set(), deadline: env.now().getTime() + c.runBudgetMs };
  if (rec.state !== "accepted") {
    audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), action: rec.action, step: "refused", detail: `already ${rec.state}; not run again` });
    return rec;
  }
  rec.state = "running";
  rec.startedAt = env.now().toISOString();
  step(x, "start", `running ${rec.action}`);
  try {
    if (rec.action === "ws_setup") await setup(x);
    else await revoke(x);
  } catch (err) {
    finish(x, "failed", `The runner hit an unexpected error (${cap(err instanceof Error ? err.message : "error", 80)}). The outcome is unknown; ask for ws_status.`, { checked: false, detail: "Not verified." });
  } finally {
    if (!isWsTerminal(rec.state)) finish(x, "failed", "The runner ended without a result.", { checked: false, detail: "Not verified." });
    rec.finishedAt = env.now().toISOString();
    delete rec.pkgRequested;
    saveRecord(c, rec, env);
    audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), action: rec.action, step: "result", detail: `${rec.state}: ${rec.summary ?? ""}`.slice(0, 300) });
  }
  return rec;
}

// The package unit (orbit-ops-ws-pkg@<opId>.service). It runs apt-get at most once, and only when the runner of a running ws_setup
// asked for it a moment ago (pkgRequested in the record, cleared here before anything runs). Returns the unit's exit code.
export async function runPackage(opId: string, env: WsEnv, c: WsConfig, audit: Audit): Promise<number> {
  const rec = loadRecord(c, opId);
  if (!rec || rec.action !== "ws_setup" || rec.state !== "running" || rec.pkgRequested !== true) {
    audit({ at: env.now().toISOString(), opId: opId.slice(0, 12), step: "pkg-refused", detail: "no running ws_setup asked for the package step; nothing ran" });
    return 1;
  }
  const x: Ctx = { env, c, rec, audit, created: new Set() };
  delete rec.pkgRequested;
  if (bwrapOk(x)) {
    rec.pkgResult = "already_present";
    step(x, "package", `${SANDBOX.bwrap} is already present; apt-get was not run`);
    return 0;
  }
  step(x, "package", `running ${BIN.aptGet} ${APT_ARGS.join(" ")}`);
  const r = await env.exec(BIN.aptGet, [...APT_ARGS], 1_800_000, { env: { ...APT_ENV }, noKill: true });
  const busy = r.code !== 0 && APT_LOCK_TEXT.test(`${r.stderr}\n${r.stdout}`);
  rec.pkgResult = r.code === 0 ? "installed" : busy ? "busy" : "failed";
  step(x, "package", r.code === 0 ? "apt-get install finished (exit 0)" : busy ? "the package manager is busy (lock held); nothing was changed, killed or unlocked" : `apt-get install failed (exit ${r.code}): ${lastLines(r.stderr)}`);
  return r.code === 0 ? 0 : 1;
}

// The runner holds the deploy lock (/opt/orbit/state/deploy.lock, the one deploys, rollbacks and tier 2 restarts use) for its whole run,
// because it restarts orbit.service. It re-runs itself under flock, as tier 2 does. The package unit does not take it. These are the
// only two commands the runner issues outside the WsEnv interface (finding 8 of the PR #147 review); the allowlist test covers them:
// /usr/bin/flock, and node itself (process.execPath, i.e. the unit's /usr/local/bin/node) running this same file.
export function lockedRerun(c: WsConfig, opId: string, node: string, self: string): [string, string[]] {
  if (!OP_ID.test(opId)) throw new Error("bad operation id");
  return ["/usr/bin/flock", ["-w", String(c.lockWaitSeconds), `${c.orbitRoot}/state/deploy.lock`, node, "--max-old-space-size=64", self, opId, "run"]];
}
async function main(): Promise<void> {
  const [opId, mode] = process.argv.slice(2);
  if (!opId || !OP_ID.test(opId) || (mode !== "run" && mode !== "pkg")) {
    process.stderr.write("orbit-ops-ws-run: usage: ws-run.ts <opId> run|pkg\n");
    process.exit(64);
  }
  const audit: Audit = (line) => process.stderr.write(`orbit-ops-ws-run ${JSON.stringify(line)}\n`);
  if (mode === "pkg") process.exit(await runPackage(opId, systemWsEnv, WS_CONFIG, audit));
  const rec = loadRecord(WS_CONFIG, opId);
  if (rec?.state === "accepted" && process.env.ORBIT_WS_LOCKED !== "1") {
    const [file, args] = lockedRerun(WS_CONFIG, opId, process.execPath, fileURLToPath(import.meta.url));
    const code = await new Promise<number>((resolve) => {
      const child = execFile(file, args, { env: { ...process.env, ORBIT_WS_LOCKED: "1" } }, (err) => {
        resolve(err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0);
      });
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    });
    const after = loadRecord(WS_CONFIG, opId);
    if (code !== 0 && after && after.state === "accepted") {
      after.state = "failed";
      after.summary = "Not run: the deploy lock could not be taken in time (a deploy, rollback or restart was running). Nothing was changed.";
      after.finishedAt = new Date().toISOString();
      after.verification = { checked: false, detail: "Nothing ran." };
      saveRecord(WS_CONFIG, after, systemWsEnv);
      audit({ at: new Date().toISOString(), opId: opId.slice(0, 12), action: after.action, step: "result", detail: `failed: ${after.summary}` });
    }
    process.exit(0);
  }
  const done = await runOperation(opId, systemWsEnv, WS_CONFIG, audit);
  process.exit(done ? 0 : 1);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) void main();
