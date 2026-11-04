import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { PortStatus, Result } from "./ports.ts";

export type Hit = { path: string; snippet: string; score: number };

export type MemoryPort = {
  name: "memory";
  status(): PortStatus;
  search(query: string, limit?: number): Result<Hit[]>;
  read(path: string): Result<string>;
};

const REFRESH_MS = 60 * 1000;
const SYNC_STALE_MS = 10 * 60 * 1000;
const SKIP = new Set([".git", ".obsidian", "Attachments", "node_modules"]);

function collect(root: string, dir = root, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(root, full, out);
    else if (entry.name.endsWith(".md")) out.set(relative(root, full), readFileSync(full, "utf8"));
  }
  return out;
}

export function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
}

function snippet(text: string, words: string[]): string {
  const line = text.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w))) ?? "";
  return line.trim().slice(0, 240);
}

// Read-only keyword search over a vault copy. Semantic search comes later.
export function vaultMemory(root: string, syncFile?: string, now: () => Date = () => new Date()): MemoryPort {
  let notes = new Map<string, string>();
  let loadedAt: Date | undefined;
  let error: string | undefined;

  const load = () => {
    if (loadedAt && now().getTime() - loadedAt.getTime() < REFRESH_MS) return;
    try {
      notes = collect(root);
      loadedAt = now();
      error = undefined;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  };

  const sync = (): { commit?: string; at?: string } => {
    try {
      return syncFile ? JSON.parse(readFileSync(syncFile, "utf8")) : {};
    } catch {
      return {};
    }
  };

  const source = () => `memory/vault@${(sync().commit ?? "unknown").slice(0, 7)}`;

  return {
    name: "memory",
    status: () => {
      load();
      const at = now().toISOString();
      if (error || !loadedAt) {
        return { port: "memory", state: "down", impl: "vault-keyword", detail: `Cannot read the vault copy: ${error}`, verifiedAt: at };
      }
      const s = sync();
      const synced = s.at ? `synced ${s.at}` : "sync time unknown";
      const stale = !s.at || now().getTime() - new Date(s.at).getTime() > SYNC_STALE_MS;
      return {
        port: "memory",
        state: stale ? "degraded" : "live",
        impl: "vault-keyword",
        detail: `Read-only keyword search over ${notes.size} notes, vault ${(s.commit ?? "unknown").slice(0, 7)}, ${synced}. Owner only.`,
        verifiedAt: loadedAt.toISOString(),
      };
    },
    search: (query, limit = 5) => {
      load();
      const words = terms(query);
      const hits: Hit[] = [];
      for (const [path, text] of notes) {
        const lower = text.toLowerCase();
        const name = path.toLowerCase();
        let score = 0;
        for (const w of words) score += lower.split(w).length - 1 + (name.includes(w) ? 5 : 0);
        if (score > 0) hits.push({ path, snippet: snippet(text, words), score });
      }
      hits.sort((a, b) => b.score - a.score);
      return { value: hits.slice(0, limit), provenance: "live", source: source() };
    },
    read: (path) => {
      load();
      const full = resolve(root, path);
      if (!full.startsWith(resolve(root) + sep) || !full.endsWith(".md")) throw new Error("path is outside the vault");
      const text = notes.get(relative(root, full));
      if (text === undefined) throw new Error("no such note");
      return { value: text, provenance: "live", source: source() };
    },
  };
}

export function memoryUnavailable(detail: string): MemoryPort {
  const fail = () => {
    throw new Error(detail);
  };
  return {
    name: "memory",
    status: () => ({ port: "memory", state: "down", impl: "none", detail, verifiedAt: new Date().toISOString() }),
    search: fail,
    read: fail,
  };
}

export function selectMemory(env: NodeJS.ProcessEnv): MemoryPort {
  const root = env.ORBIT_VAULT;
  if (!root) return memoryUnavailable("No vault is configured (ORBIT_VAULT unset).");
  try {
    statSync(root);
  } catch {
    return memoryUnavailable(`The vault copy at ${root} is not readable.`);
  }
  return vaultMemory(root, env.ORBIT_VAULT_STATE);
}
