import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CGROUP_CONTROLLERS } from "./sandbox.ts";

// The run-parent cgroup (docs/workspace-tools.md, "Cgroup delegation"). The host setup gives orbit.service a delegated cgroup v2 subtree
// (Delegate=memory pids cpu, DelegateSubgroup=main): systemd puts ORBIT itself in <unit>/main and hands the unit's cgroup to ORBIT's
// user. ORBIT then creates, INSIDE ITS OWN UNIT CGROUP ONLY, the sibling directory the sandbox uses as `cgroupParent`
// (<unit>/workspace-exec) and enables memory, pids and cpu for its children. Nothing outside ORBIT's own unit cgroup is ever written,
// the host's cgroup hierarchy is never reconfigured, and a layout that does not match is left alone (the sandbox self-test then
// reports what is missing).

export type RunParentResult = { ok: boolean; changed: string[]; detail: string };

// ORBIT's own cgroup v2 path, e.g. "/system.slice/orbit.service/main", or undefined (no unified hierarchy entry).
export function ownCgroup(text?: string): string | undefined {
  let t = text;
  if (t === undefined) {
    try {
      t = readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return undefined;
    }
  }
  const line = t.split("\n").find((l) => l.startsWith("0::"));
  const p = line?.slice(3).trim();
  return p && p.startsWith("/") ? p : undefined;
}

const enabled = (file: string) => {
  try {
    return readFileSync(file, "utf8").split(/\s+/).filter(Boolean);
  } catch {
    return undefined;
  }
};

export function ensureRunParent(cgroupParent: string, o: { root?: string; self?: string } = {}): RunParentResult {
  const root = o.root ?? "/sys/fs/cgroup";
  const self = o.self ?? ownCgroup();
  if (!self) return { ok: false, changed: [], detail: "ORBIT's own cgroup v2 path is unknown (no unified cgroup hierarchy?); nothing was created" };
  const unit = join(root, dirname(self));
  // Only a direct child of ORBIT's own unit cgroup, and never ORBIT's own subgroup, may be managed here.
  if (dirname(cgroupParent) !== unit || basename(cgroupParent) === basename(self) || basename(cgroupParent).startsWith("cgroup.") || dirname(self) === "/") {
    return { ok: false, changed: [], detail: `cgroupParent is not a sibling of ORBIT's own cgroup inside its delegated unit cgroup (${unit}); nothing was created` };
  }
  const changed: string[] = [];
  try {
    const avail = enabled(join(unit, "cgroup.controllers"));
    if (!avail) return { ok: false, changed, detail: `ORBIT's unit cgroup (${unit}) is not readable; is it delegated?` };
    const lack = CGROUP_CONTROLLERS.filter((c) => !avail.includes(c));
    if (lack.length) return { ok: false, changed, detail: `ORBIT's unit cgroup is not delegated ${lack.join(", ")} (needs Delegate=memory pids cpu on orbit.service)` };
    const unitSub = enabled(join(unit, "cgroup.subtree_control")) ?? [];
    const needUnit = CGROUP_CONTROLLERS.filter((c) => !unitSub.includes(c));
    if (needUnit.length) {
      writeFileSync(join(unit, "cgroup.subtree_control"), needUnit.map((c) => `+${c}`).join(" "));
      changed.push(`enabled ${needUnit.join(", ")} in ${unit}/cgroup.subtree_control`);
    }
    if (!existsSync(cgroupParent)) {
      mkdirSync(cgroupParent);
      changed.push(`created ${cgroupParent}`);
    }
    const sub = enabled(join(cgroupParent, "cgroup.subtree_control")) ?? [];
    const need = CGROUP_CONTROLLERS.filter((c) => !sub.includes(c));
    if (need.length) {
      writeFileSync(join(cgroupParent, "cgroup.subtree_control"), need.map((c) => `+${c}`).join(" "));
      changed.push(`enabled ${need.join(", ")} in ${cgroupParent}/cgroup.subtree_control`);
    }
    return { ok: true, changed, detail: changed.length ? changed.join("; ") : "already in place" };
  } catch (e) {
    return { ok: false, changed, detail: `could not prepare the run-parent cgroup (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
}
