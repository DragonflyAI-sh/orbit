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
const K1 = 1.2;
const B = 0.75;
const NAME_BOOST = 3;
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

const STOPWORDS = new Set(
  ("the and for are was were what whats when where which who whom why how with from this that these those there their " +
    "about into onto over under than then them they you your yours our ours his her hers its it's not but can could " +
    "should would will shall have has had does did doing done any all some more most much many very just also only " +
    "status update tell show give please know need want get got make made being been is am be do me my mine").split(" "),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2);
}

export function terms(query: string): string[] {
  return [...new Set(tokens(query).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}

function snippet(text: string, words: string[]): string {
  const line = text.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w))) ?? "";
  return line.trim().slice(0, 240);
}

// Read-only keyword search over a vault copy. Semantic search comes later.
export function vaultMemory(root: string, syncFile?: string, now: () => Date = () => new Date()): MemoryPort {
  let notes = new Map<string, string>();
  let index = new Map<string, { tf: Map<string, number>; length: number; name: Set<string> }>();
  let df = new Map<string, number>();
  let avgLength = 1;
  let loadedAt: Date | undefined;
  let error: string | undefined;

  const load = () => {
    if (loadedAt && now().getTime() - loadedAt.getTime() < REFRESH_MS) return;
    try {
      notes = collect(root);
      index = new Map();
      df = new Map();
      for (const [path, text] of notes) {
        const tf = new Map<string, number>();
        const words = tokens(text);
        for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
        for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
        index.set(path, { tf, length: words.length, name: new Set(tokens(path.replace(/\.md$/, ""))) });
      }
      avgLength = Math.max(1, [...index.values()].reduce((n, d) => n + d.length, 0) / Math.max(1, index.size));
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
      for (const [path, doc] of index) {
        let score = 0;
        let named = 0;
        for (const w of words) {
          const idf = Math.log(1 + (index.size - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
          const tf = doc.tf.get(w) ?? 0;
          // BM25 term weight: repeats saturate, long notes are discounted.
          score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength));
          if (doc.name.has(w)) named += 1;
        }
        // A note named for the query is the best answer; every query word in the name counts.
        if (named) score *= 1 + NAME_BOOST * (named / words.length);
        if (score > 0) hits.push({ path, snippet: snippet(notes.get(path) ?? "", words), score: Math.round(score * 100) / 100 });
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
