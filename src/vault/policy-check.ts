// Honest reporting about where ORBIT's vault write rules come from. The rules are CODED (classify() in src/vault/edit.ts), written
// from the vault's AGENTS.md sections 3 and 4 as they were summarised when the code was written. They are NOT parsed from
// AGENTS.md at run time, and ORBIT does not rewrite the vault's AGENTS.md or widen what it may write when that file changes.
// What ORBIT does at run time is notice: it hashes the AGENTS.md in its clone and compares it with the hash recorded here as
// the baseline the rules were written against, and says so (config view, vault_policy) when they differ or cannot be compared.

// SHA-256 (hex) of the vault AGENTS.md the coded rules were written from. NOT RECORDED: the repository never captured the hash
// of the real file (the rules came from a written summary), and nothing here invents one. Until a reviewed change records it,
// the check reports "baseline_not_recorded" together with the hash currently seen, so Rai can compare it to the file and record it.
export const AGENTS_MD_BASELINE_SHA: string | undefined = undefined;

export type PolicyObservation = { at: string; sha?: string; problem?: string };

export type PolicyCheck = {
  state: "match" | "drifted" | "baseline_not_recorded" | "unavailable";
  rules: string;
  baselineSha?: string;
  currentSha?: string;
  checkedAt?: string;
  detail: string;
};

const RULES = "coded in src/vault/edit.ts from AGENTS.md sections 3 and 4; NOT parsed from the vault's AGENTS.md at run time";

export function checkPolicy(observed: PolicyObservation | undefined, baseline: string | undefined = AGENTS_MD_BASELINE_SHA): PolicyCheck {
  // Hashes are shown as their first 24 hex characters (as the config view does for the routine file): enough to compare by eye, and
  // short enough that the output redaction does not take a full SHA-256 for an opaque secret.
  const base = { rules: RULES, ...(baseline ? { baselineSha: baseline.slice(0, 24) } : {}) };
  if (!observed) return { ...base, state: "unavailable", detail: "The vault clone has not synced in this process yet, so the vault's AGENTS.md has not been checked. Vault writes fail closed until it has." };
  if (!observed.sha) return { ...base, state: "unavailable", checkedAt: observed.at, detail: `AGENTS.md is unavailable in the vault clone (${observed.problem ?? "missing"}). Vault writes fail closed (policy_unavailable).` };
  const seen = { ...base, currentSha: observed.sha.slice(0, 24), checkedAt: observed.at };
  if (!baseline) return { ...seen, state: "baseline_not_recorded", detail: "No baseline hash is recorded for the AGENTS.md these rules were written from, so drift cannot be judged. The hash seen now is given; record it in src/vault/policy-check.ts after comparing it with the file." };
  if (observed.sha === baseline) return { ...seen, state: "match", detail: "The vault AGENTS.md is the one the coded rules were written against." };
  return { ...seen, state: "drifted", detail: "The vault AGENTS.md has CHANGED since the coded rules were written. ORBIT still enforces the coded rules (it does not follow the new text and does not widen what it may write); review src/vault/edit.ts classify() against the new AGENTS.md." };
}
