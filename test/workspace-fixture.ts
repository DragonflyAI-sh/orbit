import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposals as newProposals } from "../src/agent.ts";
import type { Proposal } from "../src/agent.ts";
import { DEFAULT_LIMITS } from "../src/workspace/config.ts";
import type { Activation, Workspace, WorkspaceConfig } from "../src/workspace/config.ts";
import type { ProbeState, RunExit, RunHandle, RunSpec, Sandbox } from "../src/workspace/sandbox.ts";
import { workspaceService } from "../src/workspace/service.ts";
import type { WorkspaceAudit } from "../src/workspace/service.ts";

// Fixtures for the workspace service tests. Synthetic temporary directories only.
//
// fakeSandbox is a TEST DOUBLE FOR THE SUPERVISOR ONLY: it lets tests decide when a "run" exits, what it printed, and whether it was
// killed, so the approval, queue, cancellation, timeout and recovery logic can be checked deterministically. It provides NO isolation
// and proves nothing about the OS sandbox; test/workspace-sandbox.test.ts runs the real bubblewrap sandbox where the runner supports it.

export type FakeRun = { spec: RunSpec; finish(code: number, stdout?: string, stderr?: string, extra?: Partial<RunExit>): void; killed?: "timeout" | "cancel" };

export function fakeSandbox(opts: { state?: ProbeState["state"]; noPid?: boolean } = {}) {
  const runs: FakeRun[] = [];
  const reaped: string[][] = [];
  let state: ProbeState = { state: opts.state ?? "supported", reasons: opts.state === "unsupported" ? ["bubblewrap lacks required options: --disable-userns"] : [], checkedAt: "2026-11-19T00:00:00.000Z", bwrapVersion: "0.11.0" };
  const sandbox: Sandbox & { runs: FakeRun[]; reaped: string[][]; set(s: ProbeState["state"]): void; reapGone: boolean } = {
    runs,
    reaped,
    reapGone: true,
    set: (s) => (state = { ...state, state: s, reasons: s === "supported" ? [] : ["changed by test"] }),
    probe: async () => state,
    status: () => state,
    policyId: () => "bwrap:0.11.0:fake",
    start(spec: RunSpec): RunHandle {
      let resolve!: (r: RunExit) => void;
      const done = new Promise<RunExit>((r) => (resolve = r));
      const run: FakeRun = {
        spec,
        finish: (code, stdout = "", stderr = "", extra = {}) => resolve({ code, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), truncated: { stdout: false, stderr: false }, treeGone: true, ...extra }),
      };
      runs.push(run);
      if (opts.noPid) {
        resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: { stdout: false, stderr: false }, startError: "spawn failed" });
        return { pid: undefined, done, kill: () => {} };
      }
      return {
        pid: 4242,
        done,
        kill: (reason) => {
          run.killed = reason;
          resolve({ code: null, signal: "SIGKILL", killedBy: reason, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: { stdout: false, stderr: false }, treeGone: true });
        },
      };
    },
    reap: async (ids) => {
      reaped.push(ids);
      return Object.fromEntries(ids.map((id) => [id, { leftover: 0, killed: false, gone: sandbox.reapGone }]));
    },
  };
  return sandbox;
}

export function makeWorkspace(base: string, id: string, exec = true): Workspace {
  const root = join(base, id);
  mkdirSync(root, { mode: 0o700 });
  const st = statSync(root);
  return { id, root, exec, dev: st.dev, ino: st.ino, identity: `sha256:${id.padEnd(64, "0").slice(0, 64)}` };
}

export function wsRig(opts: { sandbox?: ReturnType<typeof fakeSandbox>; activation?: Activation; now?: () => Date; stateDir?: string; maxConcurrentRuns?: number; limits?: Partial<WorkspaceConfig["sandbox"]["limits"]> } = {}) {
  const base = mkdtempSync(join(tmpdir(), "orbit-wsvc-"));
  const a = makeWorkspace(base, "alpha");
  const b = makeWorkspace(base, "beta");
  const ro = makeWorkspace(base, "readonly", false);
  writeFileSync(join(a.root, "notes.txt"), "first line\nsecond line\n");
  writeFileSync(join(a.root, "run.sh"), "echo hello\n");
  const config: WorkspaceConfig = {
    workspaces: [a, b, ro],
    sandbox: { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", shell: "/bin/sh", runtime: ["/usr"], cgroupParent: "/sys/fs/cgroup/test", limits: { ...DEFAULT_LIMITS, ...opts.limits }, maxConcurrentRuns: opts.maxConcurrentRuns ?? 1 },
    policyHash: "sha256:" + "ab".repeat(32),
  };
  const proposals = newProposals(opts.now);
  const sandbox = opts.sandbox ?? fakeSandbox();
  const audits: WorkspaceAudit[] = [];
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "orbit-wsvc-state-"));
  const make = (activation: Activation = opts.activation ?? { state: "enabled", config }) => workspaceService({ activation, sandbox, stateDir, proposals, audit: (e) => audits.push(e), now: opts.now });
  const svc = make();
  const tool = (name: string) => svc.tools.find((t) => t.name === name)!;
  const call = async (name: string, args: Record<string, unknown>) => (await tool(name).run(args)) as { value: any };
  const proposal = (id: string) => proposals.peek(id) as Proposal & { kind: "workspace_op" };
  return { base, a, b, ro, config, proposals, sandbox, audits, stateDir, svc, make, tool, call, proposal };
}

export const tick = () => new Promise((r) => setImmediate(r));
