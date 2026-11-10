import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { VaultClone } from "./vault/clone.ts";
import type { PortState, PortStatus, Result } from "./ports.ts";

export type Hit = { path: string; snippet: string; score: number };

export type MemoryPort = {
  name: "memory";
  status(): PortStatus;
  search(query: string, limit?: number): Result<Hit[]>;
  read(path: string): Result<string>;
  // Brings the notes up to date from their source if they are older than maxAgeMs (the writable clone fetches; the read-only
  // copy has nothing to fetch). Never throws: a failure shows up in status() and in the `source` of the next answer.
  refresh?(maxAgeMs?: number): Promise<void>;
  // Drops cached notes so the next search sees what was just written.
  invalidate?(): void;
  // Where the next answer would come from: the writable clone or the read-only fallback copy, and why.
  sourceInfo?(): { via: "clone" | "fallback"; reason?: string };
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
    // A symlink could point outside the vault (the clone holds whatever the remote does): never followed.
    if (entry.isSymbolicLink()) continue;
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
export type VaultMemoryOptions = {
  // The `source` of every answer. Defaults to memory/vault@<commit> from the sync record.
  source?: () => string;
  // Replaces the status text and state (the clone reports its own freshness).
  describe?: (noteCount: number) => { state: PortState; detail: string };
};

export function vaultMemory(root: string, syncFile?: string, now: () => Date = () => new Date(), options: VaultMemoryOptions = {}): MemoryPort {
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

  const source = options.source ?? (() => `memory/vault@${(sync().commit ?? "unknown").slice(0, 7)}`);

  return {
    name: "memory",
    status: () => {
      load();
      const at = now().toISOString();
      if (error || !loadedAt) {
        return { port: "memory", state: "down", impl: "vault-keyword", detail: `Cannot read the vault copy: ${error}`, verifiedAt: at };
      }
      if (options.describe) return { port: "memory", impl: "vault-keyword", verifiedAt: loadedAt.toISOString(), ...options.describe(notes.size) };
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
    invalidate: () => {
      loadedAt = undefined;
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

export function selectMemory(env: NodeJS.ProcessEnv, clone?: VaultClone): MemoryPort {
  const copy = selectCopy(env);
  if (!clone) return copy;
  return cloneMemory(clone, copy.status().state === "down" && copy.status().impl === "none" ? undefined : copy);
}

function selectCopy(env: NodeJS.ProcessEnv): MemoryPort {
  const root = env.ORBIT_VAULT;
  if (!root) return memoryUnavailable("No vault is configured (ORBIT_VAULT unset).");
  try {
    statSync(root);
  } catch {
    return memoryUnavailable(`The vault copy at ${root} is not readable.`);
  }
  return vaultMemory(root, env.ORBIT_VAULT_STATE);
}

const CLONE_STALE_MS = 10 * 60 * 1000;

// Memory over ORBIT's writable clone of the vault when the write credential is installed and the clone has synced; the
// read-only /opt/orbit/vault copy otherwise. Every answer's `source` says which one answered and how fresh it is, and why the
// fallback was used when it was. The clone is the same working tree the write tools change, so a search sees ORBIT's own
// writes at once and other people's changes at the next fetch (at most a minute old while ORBIT runs).
export function cloneMemory(clone: VaultClone, fallback: MemoryPort | undefined, now: () => Date = () => new Date()): MemoryPort {
  const fetchError = () => clone.state().syncError;
  const cloneLabel = (): string => {
    const st = clone.state();
    const err = st.syncError;
    return `memory/vault-clone@${(st.head ?? "unknown").slice(0, 7)} (fetched ${st.fetchedAt ?? "never"}${err ? `; STALE: the last fetch failed at ${err.at}: ${err.message}` : ""})`;
  };
  const inClone = vaultMemory(clone.dir, undefined, now, {
    source: cloneLabel,
    describe: (n) => {
      const st = clone.state();
      const old = !st.fetchedAt || now().getTime() - new Date(st.fetchedAt).getTime() > CLONE_STALE_MS;
      return {
        state: st.syncError || old ? "degraded" : "live",
        detail: `Keyword search over ${n} notes in ORBIT's writable vault clone, commit ${(st.head ?? "unknown").slice(0, 7)}, fetched ${st.fetchedAt ?? "never"}${st.syncError ? `; the last fetch failed (${st.syncError.message})` : ""}. Writes go to this clone and are pushed to GitHub. Owner only.`,
      };
    },
  });
  const info = (): { via: "clone" | "fallback"; reason?: string } => {
    const st = clone.state();
    if (st.credential === "missing") return { via: "fallback", reason: "the vault write credential (orbit.github-vault) is not installed in this ORBIT process" };
    if (st.clone !== "ready") return { via: "fallback", reason: `the writable clone is not available yet${st.syncError ? `: ${st.syncError.message}` : st.lastError ? `: ${st.lastError.message}` : ""}` };
    return { via: "clone" };
  };
  const label = (src: string, why: string | undefined) => (why === undefined ? src : `${src} (FALLBACK: ${why}; this is the read-only server copy and may lag GitHub)`);
  const answer = <T>(use: (m: MemoryPort) => Result<T>): Result<T> => {
    const i = info();
    if (i.via === "clone") return use(inClone);
    if (!fallback) throw new Error(`No vault is available: ${i.reason}, and no read-only copy is configured.`);
    const r = use(fallback);
    return { ...r, source: label(r.source, i.reason) };
  };
  return {
    name: "memory",
    sourceInfo: info,
    invalidate: () => {
      inClone.invalidate?.();
      fallback?.invalidate?.();
    },
    refresh: async (maxAgeMs = 60_000) => {
      if (!clone.credentialPresent()) return;
      const at = clone.state().fetchedAt;
      if (at && now().getTime() - new Date(at).getTime() < maxAgeMs) return;
      await clone.sync().catch(() => {});
      inClone.invalidate?.();
    },
    status: () => {
      const i = info();
      if (i.via === "clone") return inClone.status();
      const base = fallback ? fallback.status() : ({ port: "memory", state: "down", impl: "none", detail: "No read-only copy is configured.", verifiedAt: now().toISOString() } as PortStatus);
      return { ...base, state: base.state === "down" ? "down" : "degraded", detail: `FALLBACK: ${i.reason}. ${base.detail} Vault write tools are unavailable.` };
    },
    search: (query, limit) => answer((m) => m.search(query, limit)),
    read: (path) => answer((m) => m.read(path)),
  };
}
