import type { ChatTool, Proposal, Proposals } from "../agent.ts";
import type { MemoryPort } from "../memory.ts";
import type { VaultClone } from "./clone.ts";
import { cardDisplay, digestOfEdit, parseEdit, summarize, VaultError } from "./edit.ts";
import type { VaultEdit } from "./edit.ts";
import { maskVaultDeep, maskVaultText } from "./filter.ts";

// The vault write tools offered to the owner in chat, and the confirmation path for the protected ones. Direct writes (AGENTS.md
// section 3) run at once through the clone's pipeline; anything section 4 protects becomes a proposal card that Rai confirms with
// its digest, and is validated again when it runs. There is no tool that deletes, runs commands or writes an arbitrary file.

export const VAULT_PROPOSAL_TTL_MS = 30 * 60 * 1000;

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const failure = (err: unknown): Error => {
  if (err instanceof VaultError) {
    const files = err.code === "conflict" && err.details.length ? ` Conflicting files: ${maskVaultText(err.details.join(", "))}.` : "";
    const unverified = err.code === "unverified" ? " It may or may not be on GitHub: do not tell Rai it was saved." : "";
    return new Error(`NOT saved (${err.code}): ${err.message}${files}${unverified}`);
  }
  return err instanceof Error ? err : new Error(String(err));
};

export type VaultEdits = ReturnType<typeof vaultEdits>;

export function vaultEdits(deps: { clone: VaultClone; memory: MemoryPort; proposals: Proposals; now?: () => Date }) {
  const { clone, memory, proposals } = deps;
  // The exact validated edit behind each open proposal, in memory only (a restart drops it with the proposal).
  const pending = new Map<string, { edit: VaultEdit; reasons: string[] }>();

  function propose(edit: VaultEdit, reasons: string[]) {
    // The complete change, or a refusal (VaultError policy_refused) when it cannot be shown in full: nothing is ever clipped.
    const display = cardDisplay(edit, reasons);
    const digest = digestOfEdit(edit, reasons);
    const p = proposals.propose({ kind: "vault_edit", action: edit.op, summary: `${summarize(edit)} (needs your confirmation: ${reasons.join("; ")})`, display, digest, reasons }, VAULT_PROPOSAL_TTL_MS) as Proposal & { kind: "vault_edit" };
    pending.set(p.id, { edit, reasons });
    for (const id of pending.keys()) if (!proposals.peek(id)) pending.delete(id);
    return p;
  }

  async function run(op: string, args: Record<string, unknown>) {
    let edit: VaultEdit;
    try {
      edit = parseEdit(op, args);
      const r = await clone.write([edit], { kind: "direct" }, { actor: "chat" });
      memory.invalidate?.();
      return {
        value: {
          status: "committed",
          saved: true,
          verifiedOnRemote: true,
          commit: r.commit,
          branch: r.branch,
          files: r.files,
          logFile: r.logFile,
          attempts: r.attempts,
          agentsMdSha: r.agentsMdSha.slice(0, 12),
          note: "Committed by ORBIT and pushed; the remote branch was read back and points at this commit. The Log line is in the same commit.",
        },
        provenance: "live" as const,
        source: `vault/clone@${r.commit.slice(0, 7)} (pushed to GitHub, remote head verified)`,
      };
    } catch (err) {
      if (err instanceof VaultError && err.code === "needs_confirmation") {
        let p: ReturnType<typeof propose>;
        try {
          p = propose(parseEdit(op, args), err.details);
        } catch (refused) {
          throw failure(refused);
        }
        return {
          value: { status: "pending-confirmation", saved: false, executed: false, proposalId: p.id, summary: p.summary, reasons: err.details, digest: p.digest, expiresAt: p.expiresAt, note: "Nothing was written. Rai must click Confirm on the page; the change is checked again when it runs." },
          provenance: "live" as const,
          source: "chat/proposals",
        };
      }
      throw failure(err);
    }
  }

  const write = (name: string, op: string, description: string, parameters: Record<string, unknown>, required: string[]): ChatTool => ({
    name,
    description: `${description} Applies to Rai's vault clone and is committed and pushed to GitHub by ORBIT (author ORBIT), with a line in today's Log/<year>/<date>-orbit.md in the same commit. Only AGENTS.md section 3 areas are written directly (Projects/, Tasks/, Areas/, Resources/, Memory/, Inbox/, now.md, Machines/orbit.md); a Journal/ change beyond a plan section, a note tagged #rai, a new sensitive personal detail, or AGENTS.md, System/, .obsidian/ or scripts/ becomes a proposal Rai must confirm. Secret-shaped text is refused. Say it was saved ONLY if this returns status "committed"; on any error nothing was saved. Call vault_policy first when unsure.`,
    parameters: obj(parameters, required),
    run: (a) => run(op, a),
  });

  const tools: ChatTool[] = [
    {
      name: "vault_policy",
      readOnly: true,
      description: "Read the vault's own rules from the writable clone: AGENTS.md (the authority), System/conventions.md and System/memory.md, with the AGENTS.md hash. Read-only. Obey it when writing.",
      parameters: obj({}, []),
      run: async (a) => {
        if (Object.keys(a).length) throw new Error("This tool takes no arguments.");
        try {
          await clone.sync().catch(() => {});
          const d = clone.policyDocs();
          const st = clone.state();
          return {
            value: { agentsMd: clip(d.agents, 8000), agentsMdSha: d.agentsSha.slice(0, 12), conventions: d.conventions ? clip(d.conventions, 6000) : "(System/conventions.md not found)", memoryRules: d.memory ? clip(d.memory, 6000) : "(System/memory.md not found)", clone: { head: st.head?.slice(0, 7), fetchedAt: st.fetchedAt, syncError: st.syncError?.message } },
            provenance: "live" as const,
            source: `vault/clone@${(st.head ?? "unknown").slice(0, 7)} (fetched ${st.fetchedAt ?? "never"})`,
          };
        } catch (err) {
          throw failure(err);
        }
      },
    },
    write("vault_create_note", "create_note", "Create a new markdown note (never overwrites).", { path: str("Vault-relative path ending in .md, e.g. Projects/foo.md"), content: str("Full note text, optionally with front matter") }, ["path", "content"]),
    write("vault_append_section", "append_section", "Append text to the end of one section of an existing note.", { path: str("Note path"), heading: str('The exact heading line, e.g. "## Plan"; it must occur once'), text: str("Text to append") }, ["path", "heading", "text"]),
    write("vault_replace_text", "replace_text", "Replace one exact passage in an existing note. The passage must occur exactly once; otherwise nothing changes.", { path: str("Note path"), find: str("The exact existing passage"), replace: str("The new text") }, ["path", "find", "replace"]),
    write("vault_set_frontmatter", "set_frontmatter", "Set one top-level front matter field of an existing note.", { path: str("Note path"), key: str("Field name"), value: { description: "A string, number, boolean or list of strings", anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }] } }, ["path", "key", "value"]),
    write("vault_archive_note", "archive_note", "Move a note to Archive/ (keeping its folder path). Nothing is ever deleted.", { path: str("Note path") }, ["path"]),
  ];

  return {
    tools,
    // The confirmed path: re-validates the exact edit (path rules, secrets, preconditions, and that the policy still asks for
    // no more than the reasons on the card), then runs the same pipeline as a direct write.
    async confirm(proposal: Proposal & { kind: "vault_edit" }): Promise<{ code: number; body: Record<string, unknown> }> {
      const held = pending.get(proposal.id);
      pending.delete(proposal.id);
      if (!held) return { code: 410, body: { error: "The exact change for this proposal is no longer held (ORBIT restarted since it was made). Nothing was written; ask for it again." } };
      if (digestOfEdit(held.edit, held.reasons) !== proposal.digest) return { code: 409, body: { error: "The held change does not match this proposal's digest. Nothing was written." } };
      // What the card shows must be, byte for byte, the complete change that is about to run.
      let shown: Record<string, string>;
      try {
        shown = cardDisplay(held.edit, held.reasons);
      } catch (err) {
        return { code: 422, body: { error: `Not saved: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400), code: "policy_refused" } };
      }
      if (JSON.stringify(shown) !== JSON.stringify(proposal.display)) return { code: 409, body: { error: "The card does not show the complete change that would run. Nothing was written." } };
      try {
        const r = await clone.write([held.edit], { kind: "confirmed", reasons: held.reasons }, { actor: "confirmed-card" });
        memory.invalidate?.();
        return { code: 200, body: { committed: true, saved: true, verifiedOnRemote: true, commit: r.commit, files: r.files, logFile: r.logFile } };
      } catch (err) {
        const e = err instanceof VaultError ? err : undefined;
        return { code: e?.code === "conflict" ? 409 : e ? 422 : 502, body: { error: `Not saved: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400), ...(e ? { code: e.code } : {}), ...(e?.code === "conflict" ? { files: maskVaultDeep(e.details) } : {}) } };
      }
    },
  };
}
