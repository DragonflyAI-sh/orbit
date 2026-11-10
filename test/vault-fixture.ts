import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vaultClone } from "../src/vault/clone.ts";
import type { VaultCloneDeps } from "../src/vault/clone.ts";

// A throwaway bare git repository standing in for the vault on GitHub, plus a work clone for playing "someone else". The token
// is synthetic: nothing here touches the real vault, the network or a real credential.

export const TOKEN = "synthetic-vault-" + "tok" + "en-" + "0123456789abcdef";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Rai",
  GIT_AUTHOR_EMAIL: "rai@example.invalid",
  GIT_COMMITTER_NAME: "Rai",
  GIT_COMMITTER_EMAIL: "rai@example.invalid",
};
export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" });

export const SEED: Record<string, string> = {
  "AGENTS.md": "# Vault rules\nSection 3 direct writes. Section 4 needs Rai.\n",
  "System/conventions.md": "# Conventions\nMachine id: orbit.\n",
  "System/memory.md": "# Memory rules\n",
  "Projects/alpha.md": "---\nstatus: active\ntags: [project]\n---\n# Alpha\n\n## Notes\n- first\n\n## Plan\n- step one\n",
  "Projects/secret-rai.md": "# Private\n#rai do not touch\n",
  "Journal/2026/2026-11-09.md": "# Monday\n\n## Plan\n- ship it\n\n## Reflections\nquiet day\n",
  "Memory/recent-context.md": "---\nupdatedAt: 2026-11-01T00:00:00.000Z\nsources: [old]\n---\nOld note about work.\n",
  "Tasks/todo.md": "# Todo\n- [ ] one\n",
  "now.md": "# Now\n",
};

export type Fixture = ReturnType<typeof makeFixture>;

export function makeFixture(seed: Record<string, string> = SEED) {
  const root = mkdtempSync(join(tmpdir(), "orbit-vaultfx-"));
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "-q", "-b", "main", remote);
  const work = join(root, "work");
  git(root, "clone", "-q", remote, work);
  git(work, "checkout", "-q", "-b", "main");
  for (const [p, c] of Object.entries(seed)) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), c);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "seed");
  git(work, "push", "-q", "origin", "main");

  const make = (over: Partial<VaultCloneDeps> = {}) =>
    vaultClone({ dir: join(root, "state", "vault-clone"), remote, credential: () => TOKEN, allowProtocols: "file", ...over });

  return {
    root,
    remote,
    work,
    make,
    cloneDir: join(root, "state", "vault-clone"),
    // Someone else changes the vault: edit files in the work clone and push.
    elsewhere(files: Record<string, string>, message = "elsewhere") {
      git(work, "pull", "-q", "--rebase", "origin", "main");
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(work, p)), { recursive: true });
        writeFileSync(join(work, p), c);
      }
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", message);
      git(work, "push", "-q", "origin", "main");
      return git(work, "rev-parse", "HEAD").trim();
    },
    remoteHead: () => git(remote, "rev-parse", "refs/heads/main").trim(),
    remoteFile: (p: string): string => git(remote, "show", `main:${p}`),
    remoteLog: () => git(remote, "log", "--format=%H%x09%an <%ae>%x09%s", "main"),
    readClone: (p: string) => readFileSync(join(root, "state", "vault-clone", p), "utf8"),
  };
}
