import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { Ops } from "./ops-client.ts";
import { displayConfig, CONFIG_KEYS } from "./ops/admin-protocol.ts";
import type { ConfigChanges } from "./ops/admin-protocol.ts";
import type { PortStatus, Result } from "./ports.ts";
import { maskDeep, maskText } from "./threads.ts";
import { CREDENTIAL_NAME } from "./vault/clone.ts";
import type { PolicyCheck } from "./vault/policy-check.ts";
import { hasUserinfo, maskRemote } from "./vault/remote.ts";

// The read-only config view: how ORBIT is configured right now, for the owner, in one tool call. Nothing here changes anything
// (configuration changes remain ops_propose_config_change, confirmed by Rai, applied by the tier 2 helper) and nothing here
// reads a secret: environment values come from an allowlist, credentials are names and sizes only, and every section says where
// it came from or why it is unavailable.

// The orbit.env settings that are non-secret. Anything else in the environment (the owner's identity, credential paths,
// tokens) is never shown, whatever its name.
export const ENV_ALLOWLIST: readonly string[] = [...CONFIG_KEYS, "HOST", "PORT", "ORBIT_COMMIT", "ORBIT_DEPLOY_STATE", "ORBIT_VAULT", "ORBIT_VAULT_STATE", "ORBIT_VAULT_REMOTE", "ORBIT_VAULT_BRANCH"];

type Section<T> = { state: "ok"; source: string; value: T } | { state: "unavailable"; source: string; reason: string };
const unavailable = (source: string, err: unknown): Section<never> => ({ state: "unavailable", source, reason: maskText(err instanceof Error ? err.message : String(err)).slice(0, 240) });

const ROUTINE_FILE = "deploy/routines/orbit-jobs.md";
// Chat tool output is capped near 8000 characters, so the definition is cut (the Settings table comes first) and its hash and size are given.
const ROUTINE_MAX_CHARS = 3200;

export type ConfigViewDeps = {
  env: NodeJS.ProcessEnv;
  ops?: Ops;
  commit: string;
  // The repository root of the running release (where deploy/ lives).
  repoRoot?: string;
  // How the vault's AGENTS.md compares with the baseline the coded write rules were written against. Absent without a vault clone.
  vaultPolicy?: () => PolicyCheck;
  now?: () => Date;
};

export function configView(deps: ConfigViewDeps): (ports: PortStatus[]) => Promise<Result<unknown>> {
  const { env, ops, commit } = deps;
  const now = deps.now ?? (() => new Date());
  const root = deps.repoRoot ?? new URL("..", import.meta.url).pathname;

  const running = (): Section<Record<string, string>> => {
    const out: Record<string, string> = {};
    const routines: ConfigChanges = {};
    for (const key of ENV_ALLOWLIST) {
      const v = env[key];
      if (v === undefined || v === "") {
        out[key] = "(not set)";
        continue;
      }
      if (key === "ORBIT_ROUTINES") {
        // Trigger ids masked as the tier 2 cards mask them (trig_…last4).
        routines.ORBIT_ROUTINES = v;
        out[key] = displayConfig(routines).ORBIT_ROUTINES ?? "(set)";
      } else if (key === "ORBIT_VAULT_REMOTE" && hasUserinfo(v)) {
        // A remote with a user name or password in it is shown without them (host and path only), and says so.
        out[key] = `${maskRemote(v)} (userinfo in the URL is hidden)`;
      } else out[key] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    }
    return { state: "ok", source: "the running ORBIT process environment (allowlisted non-secret keys only; this is what is running, which can differ from /opt/orbit/orbit.env until the next restart)", value: maskDeep(out) };
  };

  // Names and sizes of the credentials ORBIT's own process was given by systemd. Contents are never read.
  const loadedCredentials = (): Section<unknown> => {
    const dir = env.CREDENTIALS_DIRECTORY;
    const source = "stat of $CREDENTIALS_DIRECTORY (names and sizes only; contents are never read)";
    if (!dir) return { state: "unavailable", source, reason: "ORBIT was not started with a credentials directory." };
    try {
      const entries = readdirSync(dir)
        .filter((n) => /^[A-Za-z0-9._-]{1,64}$/.test(n))
        .sort()
        .map((name) => {
          const st = lstatSync(join(dir, name));
          return { name, sizeBytes: st.isFile() ? st.size : undefined, type: st.isFile() ? "file" : "other" };
        });
      const vault = entries.find((e) => e.name === CREDENTIAL_NAME);
      return { state: "ok", source, value: { entries, vaultWriteCredential: vault ? "loaded in this process" : `not loaded in this process (${CREDENTIAL_NAME} appears after the next ORBIT restart once it is installed)` } };
    } catch (err) {
      return unavailable(source, err);
    }
  };

  const viaOps = async (action: "credentials" | "deploy_state"): Promise<Section<unknown>> => {
    const source = `tier 1 orbit-ops ${action}`;
    if (!ops) return { state: "unavailable", source, reason: "The tier 1 helper client is not configured." };
    try {
      const r = await ops.call(action);
      return { state: "ok", source: r.source, value: r.value };
    } catch (err) {
      return unavailable(source, err);
    }
  };

  const vaultPolicy = (): Section<PolicyCheck> => {
    const source = "the vault AGENTS.md hash in ORBIT's clone, compared with the baseline recorded in src/vault/policy-check.ts";
    if (!deps.vaultPolicy) return { state: "unavailable", source, reason: "There is no writable vault clone in this process, so the vault write rules are not in use and AGENTS.md is not checked." };
    try {
      return { state: "ok", source, value: deps.vaultPolicy() };
    } catch (err) {
      return unavailable(source, err);
    }
  };

  const routine = (): Section<{ file: string; totalChars: number; sha256: string; truncated: boolean; text: string }> => {
    const source = `${ROUTINE_FILE} in the running release (${commit.slice(0, 7)})`;
    try {
      const raw = readFileSync(join(root, ROUTINE_FILE), "utf8");
      const text = maskText(raw);
      return { state: "ok", source, value: { file: ROUTINE_FILE, totalChars: raw.length, sha256: createHash("sha256").update(raw).digest("hex").slice(0, 24), truncated: text.length > ROUTINE_MAX_CHARS, text: text.slice(0, ROUTINE_MAX_CHARS) } };
    } catch (err) {
      return unavailable(source, err);
    }
  };

  return async (ports) => {
    const [credentials, deployState] = await Promise.all([viaOps("credentials"), viaOps("deploy_state")]);
    const value = {
      generatedAt: now().toISOString(),
      readOnly: true,
      note: "Read-only. Configuration changes are only made with ops_propose_config_change, which Rai confirms.",
      env: running(),
      credentials: { tier1: credentials, loadedByThisProcess: loadedCredentials() },
      deployedCommit: { runningProcess: commit, tier1DeployState: deployState },
      routine: routine(),
      vaultPolicy: vaultPolicy(),
      ports: { state: "ok" as const, source: "each port's own status()", value: ports.map((p) => ({ port: p.port, state: p.state, impl: p.impl, detail: maskText(p.detail).slice(0, 300), verifiedAt: p.verifiedAt })) },
    };
    return { value: maskDeep(value), provenance: "live", source: "config-view (env: running process; credentials & deploy: tier 1 ops; routine: repo file; ports: live status)" };
  };
}
