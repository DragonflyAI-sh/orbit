import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { ZONE } from "../time.ts";
import { applyEdit, classify, isOrbitLog, MAX_EDITS, MAX_NOTE, secretFindings, secretFindingsDetail, sha, summarize, VaultError } from "./edit.ts";
import type { Applied, VaultEdit } from "./edit.ts";
import { gitRunner } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { checkPolicy } from "./policy-check.ts";
import type { PolicyCheck, PolicyObservation } from "./policy-check.ts";
import { scrubUserinfo } from "./remote.ts";

// ORBIT's writable clone of the vault repository (the repo named in `remote`), kept under ORBIT's state
// directory. It is a mirror of the remote branch between writes. docs/vault-writes.md has the full behaviour; in short, every
// write is: fetch, reset to the remote head, apply the edits, check secrets and policy, append the log line, one commit, a plain
// (never forced) push, and a check that our commit is in the remote branch's history (the remote may have moved on since).
//
// Reads (memory search/read) never touch the network and never wait on it: they read the last good clone. While the working tree
// is being changed (reset/clean, applying a write, until the clone is back to the remote head) readers keep the snapshot they
// already took (see `stable`), so they never see a half-updated tree. A failing fetch backs off (1, 2, 5, 10 minutes).

export const CREDENTIAL_NAME = "orbit.github-vault";
export const DEFAULT_REMOTE = "https://github.com/phairow/orbit-vault.git";
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

// The credential systemd gave this process ($CREDENTIALS_DIRECTORY/orbit.github-vault), read on each use. Undefined when absent.
export function credentialFile(env: NodeJS.ProcessEnv): () => string | undefined {
  return () => {
    const dir = env.CREDENTIALS_DIRECTORY;
    if (!dir) return undefined;
    try {
      return readFileSync(join(dir, CREDENTIAL_NAME), "utf8");
    } catch {
      return undefined;
    }
  };
}

export type WriteMode = { kind: "direct" } | { kind: "confirmed"; reasons: string[] };
// `summary` replaces the per-edit description in the log line and the commit subject (the rolling note uses it).
export type WriteMeta = { actor: string; summary?: string };

export type WriteResult = {
  status: "committed";
  commit: string;
  branch: string;
  files: string[];
  logFile: string;
  // After the push, our commit was verified to be in the remote branch's history (equal to its head, or an ancestor of it).
  verifiedOnRemote: true;
  // The remote branch's head when that was verified (later than `commit` when someone else pushed in between).
  remoteHead: string;
  attempts: number;
  agentsMdSha: string;
};


export type PolicyDocs = { agents: string; agentsSha: string; conventions?: string; memory?: string };

export type CloneState = {
  credential: "present" | "missing";
  clone: "ready" | "absent";
  branch?: string;
  head?: string;
  fetchedAt?: string;
  // Consecutive failed fetches (0 after a good one) and when the next fetch is allowed.
  syncFailures: number;
  nextSyncAt?: string;
  // AGENTS.md as the last sync saw it, for the policy drift check.
  policy?: PolicyObservation;
  lastError?: { at: string; code: string; message: string };
  // The last fetch/clone failed (cleared by the next one that works). Reads from the clone are then from the last good fetch.
  syncError?: { at: string; message: string };
  lastWrite?: { at: string; commit: string; files: string[] };
};

export type VaultCloneDeps = {
  dir: string;
  remote?: string;
  branch?: string;
  // Reads the credential fresh each time (never cached, never logged). Undefined when it is not installed.
  credential: () => string | undefined;
  allowProtocols?: string;
  now?: () => Date;
  // Called after the clone's contents changed, so readers drop their caches.
  onChange?: () => void;
  // Test seam: runs just before a push attempt (used to simulate a competing remote change).
  beforePush?: (attempt: number) => Promise<void> | void;
  // Test seam: runs while the working tree is being updated by a sync (after the reset, before the clean).
  duringUpdate?: () => Promise<void> | void;
  // Test seam: how long a chat read may wait for a refresh that is in progress (default 3000 ms; never when fetches are failing).
  readWaitMs?: number;
};

// After a failed fetch the next one is allowed after these delays (the last repeats).
export const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];

const stamp = (now: Date) => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return { date, time, year: date.slice(0, 4) };
};

// `git push --porcelain` prints one line per ref. Only a rejection because the remote branch moved (the push was not a fast-forward
// of it) is a competing change worth one retry. "[remote rejected]" is the remote refusing for its own reasons (permission, branch
// protection, a hook) and any other "[rejected]" reason is not a race either.
export const isNonFastForward = (porcelain: string): boolean => {
  const lines = porcelain.split("\n").filter((l) => l.startsWith("!"));
  return lines.length > 0 && lines.every((l) => /\[rejected\] \((non-fast-forward|fetch first|stale info)\)/.test(l));
};

export type VaultClone = ReturnType<typeof vaultClone>;

export function vaultClone(deps: VaultCloneDeps) {
  const { dir } = deps;
  const remote = deps.remote ?? DEFAULT_REMOTE;
  const now = deps.now ?? (() => new Date());
  const allowProtocols = deps.allowProtocols ?? "https";
  let branch: string | undefined = deps.branch;
  let head: string | undefined;
  let fetchedAt: string | undefined;
  let lastError: CloneState["lastError"];
  let syncError: CloneState["syncError"];
  let lastWrite: CloneState["lastWrite"];
  let tail: Promise<unknown> = Promise.resolve();
  let inflight: Promise<void> | undefined;
  let failures = 0;
  let retryAt: number | undefined;
  let mutating = 0;
  let policy: PolicyObservation | undefined;
  const readWaitMs = deps.readWaitMs ?? 3000;

  if (remote.startsWith("-") || /\s/.test(remote)) throw new Error("The vault remote is not a plain URL or path.");
  if (branch && !BRANCH.test(branch)) throw new Error("The vault branch name is not valid.");

  // Serializes every local mutation (fetch/reset and writes): one at a time, in order.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };

  const token = (): string | undefined => {
    try {
      const t = deps.credential()?.trim();
      return t && t.length >= 8 && t.length <= 1000 && !/\s/.test(t) ? t : undefined;
    } catch {
      return undefined;
    }
  };

  const fail = (code: ConstructorParameters<typeof VaultError>[0], message: string, details: string[] = []): never => {
    const safe = scrubUserinfo(message);
    lastError = { at: now().toISOString(), code, message: safe.slice(0, 300) };
    throw new VaultError(code, safe, details);
  };

  // While anything changes the working tree, readers keep what they already read. Held for the whole of a tree update or write.
  const mutate = async <T>(fn: () => Promise<T>): Promise<T> => {
    mutating++;
    try {
      return await fn();
    } finally {
      mutating--;
    }
  };

  const noteFailure = () => {
    failures++;
    retryAt = now().getTime() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!;
  };
  const backingOff = () => retryAt !== undefined && now().getTime() < retryAt;

  const runner = (): GitRunner => {
    const t = token();
    if (!t) return fail("auth_unavailable", `The vault write credential (${CREDENTIAL_NAME}) is not available to ORBIT, so the writable vault clone cannot be used. The read-only vault copy is still used for search.`);
    const g = gitRunner({ token: t, allowProtocols });
    return { run: g.run, scrub: (text) => scrubUserinfo(g.scrub(text)) };
  };

  const hasClone = () => existsSync(join(dir, ".git"));
  const ref = () => `refs/remotes/origin/${branch}`;

  async function ensureClone(git: GitRunner): Promise<void> {
    if (!hasClone()) {
      mkdirSync(dirname(dir), { recursive: true });
      await git.run(["clone", "--quiet", "--no-tags", "--", remote, dir], { cwd: dirname(dir), timeoutMs: 180_000 });
    } else {
      const url = (await git.run(["config", "--get", "remote.origin.url"], { cwd: dir, allowFail: true })).stdout.trim();
      if (url !== remote) fail("sync_failed", "The clone in ORBIT's state directory is not a clone of the configured vault remote; refusing to use it.");
    }
    if (!branch) {
      const r = await git.run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir, allowFail: true });
      const b = r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "";
      if (!BRANCH.test(b)) fail("sync_failed", "Could not tell which branch the vault remote uses (set ORBIT_VAULT_BRANCH).");
      branch = b;
    }
  }

  // The network half of a sync. It changes refs and objects only, never the working tree, so readers are not held up by it.
  const fetchRemote = (git: GitRunner): Promise<void> => git.run(["fetch", "--quiet", "--prune", "--no-tags", "origin"], { cwd: dir, timeoutMs: 120_000 }).then(() => {});

  // The local half: makes the working tree equal to the remote branch. The clone holds no work of its own, so nothing of anyone's
  // is dropped. Readers keep their snapshot until this has finished.
  async function updateTree(git: GitRunner): Promise<void> {
    await mutate(async () => {
      await git.run(["reset", "--hard", "--quiet", ref(), "--"], { cwd: dir });
      await deps.duringUpdate?.();
      await git.run(["clean", "-fdq"], { cwd: dir });
      head = (await git.run(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
      observePolicy();
    });
    fetchedAt = now().toISOString();
    syncError = undefined;
    failures = 0;
    retryAt = undefined;
  }

  async function refresh(git: GitRunner): Promise<void> {
    await fetchRemote(git);
    await updateTree(git);
  }

  function observePolicy(): void {
    try {
      const agents = diskRead("AGENTS.md");
      policy = agents === undefined ? { at: now().toISOString(), problem: "AGENTS.md is not in the clone" } : { at: now().toISOString(), sha: sha(agents) };
    } catch (err) {
      policy = { at: now().toISOString(), problem: err instanceof Error ? err.message.slice(0, 120) : "unreadable" };
    }
  }

  // Runs a clone/fetch step; anything git says goes out scrubbed, as a sync_failed error.
  async function syncStep(git: GitRunner, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (err) {
      const message = err instanceof VaultError ? err.message : git.scrub(err instanceof Error ? err.message : String(err));
      syncError = { at: now().toISOString(), message: message.slice(0, 200) };
      noteFailure();
      if (err instanceof VaultError) throw err;
      fail("sync_failed", message);
    }
  }

  async function syncLocked(): Promise<void> {
    const git = runner();
    const before = head;
    await syncStep(git, async () => {
      await ensureClone(git);
      await refresh(git);
    });
    lastError = undefined;
    if (head !== before) deps.onChange?.();
  }

  // ---- reading the working tree safely ------------------------------------------------------------------------------------------

  // Walks the path from the clone root. A symlink anywhere on it (or a non-file at the end) is refused; a missing part is fine.
  function inspect(path: string): "missing" | "file" {
    let cur = dir;
    const segs = path.split("/");
    for (let i = 0; i < segs.length; i++) {
      cur = join(cur, segs[i]!);
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (!st) return "missing";
      if (st.isSymbolicLink()) throw new VaultError("policy_refused", `${path} goes through a symbolic link; refused.`);
      const last = i === segs.length - 1;
      if (last ? !st.isFile() : !st.isDirectory()) throw new VaultError("policy_refused", `${path} is not a plain file path; refused.`);
      if (last && st.size > MAX_NOTE) throw new VaultError("precondition_failed", `${path} is larger than ${MAX_NOTE} bytes; ORBIT does not edit it.`);
    }
    return "file";
  }
  const diskRead = (path: string): string | undefined => (inspect(path) === "file" ? readFileSync(join(dir, path), "utf8") : undefined);

  function policyDocs(): PolicyDocs {
    const agents = diskRead("AGENTS.md");
    if (agents === undefined) throw new VaultError("policy_unavailable", "AGENTS.md is missing from the vault clone, so ORBIT cannot tell what it may write. Nothing was written.");
    const opt = (p: string) => {
      try {
        return diskRead(p);
      } catch {
        return undefined;
      }
    };
    return { agents, agentsSha: sha(agents), conventions: opt("System/conventions.md"), memory: opt("System/memory.md") };
  }

  function placeFile(path: string, content: string | null): void {
    const abs = join(dir, path);
    inspect(path);
    if (content === null) {
      unlinkSync(abs);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.orbit-${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmp, content, { mode: 0o644, flag: "wx" });
    renameSync(tmp, abs);
  }

  // ---- the write pipeline -------------------------------------------------------------------------------------------------------------

  type Plan = { writes: Map<string, string | null>; files: string[]; describe: string[]; agentsSha: string; logFile: string };

  // Applies the edits to what the working tree holds right now. No file is touched here.
  function plan(edits: VaultEdit[], mode: WriteMode, actor: string, summary?: string): Plan {
    const docs = policyDocs();
    const overlay = new Map<string, string | null>();
    const read = (p: string): string | undefined => (overlay.has(p) ? (overlay.get(p) ?? undefined) : diskRead(p));
    const reasons = new Set<string>();
    const describe: string[] = [];
    const explicit = new Set<string>();
    for (const edit of edits) {
      const applied: Applied = applyEdit(edit, read);
      if (secretFindings(applied.inserted)) {
        fail("secret_refused", `The text for ${edit.path} contains something shaped like a secret, token, key or credential (${secretFindingsDetail(applied.inserted)}; the text itself is not shown). Nothing was written, and nothing was redacted in its place: remove the matched value or replace it with a placeholder such as <token>, and try again. Only the matched value needs to change; headings, note names and paths are not the cause.`);
      }
      const verdict = classify(applied);
      if (verdict.kind === "refused") fail("policy_refused", verdict.reason);
      if (verdict.kind === "protected") for (const r of verdict.reasons) reasons.add(r);
      for (const [p, content] of applied.writes) {
        overlay.set(p, content);
        explicit.add(p);
      }
      describe.push(applied.describe);
    }
    if (reasons.size) {
      const list = [...reasons];
      if (mode.kind === "direct") throw new VaultError("needs_confirmation", `This change needs Rai's confirmation: ${list.join("; ")}.`, list);
      const extra = list.filter((r) => !mode.reasons.includes(r));
      if (extra.length) fail("policy_refused", `The change now needs confirmation for a reason that was not shown on the card (${extra.join("; ")}). Nothing was written; propose it again.`);
    }
    const t = stamp(now());
    const logFile = `Log/${t.year}/${t.date}-orbit.md`;
    const line = `- ${t.time} orbit: ${summary ?? describe.join("; ")} (${actor})`;
    if (secretFindings([line])) fail("secret_refused", `The log line for this change looks like it holds a secret (${secretFindingsDetail([line])}). Nothing was written.`);
    const existing = read(logFile);
    // The audit line is an append to the text as it will be after the explicit edits; it can never replace what is there.
    overlay.set(logFile, existing === undefined ? `# ${t.date} orbit\n\n${line}\n` : `${existing.endsWith("\n") ? existing : `${existing}\n`}${line}\n`);
    const writes = new Map([...overlay].filter(([p, c]) => c === null || c !== diskRead(p)));
    // The automatic audit line alone is not a change; an explicit edit of the log file itself (an append) is, and the file then
    // holds the original text, the requested append and the audit line, in that order.
    const contentChanged = [...writes.keys()].some((p) => p !== logFile || explicit.has(p));
    if (!contentChanged) fail("no_change", "Nothing would change.");
    return { writes, files: [...writes.keys()], describe, agentsSha: docs.agentsSha, logFile };
  }

  async function writeLocked(edits: VaultEdit[], mode: WriteMode, meta: WriteMeta): Promise<WriteResult> {
    if (!edits.length || edits.length > MAX_EDITS) throw new VaultError("invalid_input", `A write holds 1 to ${MAX_EDITS} edits.`);
    const git = runner();
    let held = false;
    // From the first change to the working tree until it is back at the remote head, readers keep their snapshot.
    const hold = () => {
      if (!held) {
        held = true;
        mutating++;
      }
    };
    try {
      await syncStep(git, () => ensureClone(git));
      let firstBase: string | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        await syncStep(git, () => fetchRemote(git));
        hold();
        await syncStep(git, () => updateTree(git));
        const base = head!;
        firstBase ??= base;
        let p: Plan;
        try {
          p = plan(edits, mode, meta.actor, meta.summary);
        } catch (err) {
          // After a competing remote change, an edit that no longer applies is a conflict, reported with its files.
          if (attempt === 2 && err instanceof VaultError && err.code === "precondition_failed") {
            throw new VaultError("conflict", `The vault changed on the remote while writing, and the change no longer applies: ${err.message} Nothing was pushed.`, edits.map((e) => e.path));
          }
          throw err;
        }
        for (const [path, content] of p.writes) placeFile(path, content);
        await git.run(["add", "-A", "--", ...p.files], { cwd: dir });
        const message = `orbit: ${(meta.summary ?? summarize(edits[0]!)).slice(0, 70)}${edits.length > 1 && !meta.summary ? ` (+${edits.length - 1})` : ""}\n\n${p.describe.map((d) => `- ${d}`).join("\n")}\n\nWritten by ORBIT (${meta.actor}) under vault AGENTS.md ${p.agentsSha.slice(0, 12)}.\n`;
        await git.run(["commit", "--quiet", "--no-verify", "-F", "-"], { cwd: dir, input: message });
        const commit = (await git.run(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
        await deps.beforePush?.(attempt);
        // A plain push of this commit to the branch: no force, no plus in the refspec.
        const push = await git.run(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, allowFail: true, timeoutMs: 120_000 });
        if (push.code === 0) {
          // Saved means published: our commit is in the remote branch's history. The remote may have moved on since the push, so
          // equal to the head is not required; an ancestor of it is enough. Failing to check is not a success.
          let remoteHead: string;
          try {
            await git.run(["fetch", "--quiet", "--no-tags", "origin"], { cwd: dir, timeoutMs: 120_000 });
            remoteHead = (await git.run(["rev-parse", ref()], { cwd: dir })).stdout.trim();
            const inHistory = await git.run(["merge-base", "--is-ancestor", commit, remoteHead], { cwd: dir, allowFail: true });
            if (inHistory.code !== 0) fail("unverified", "The push reported success but ORBIT's commit is not in the remote branch's history; treat the change as NOT saved.");
          } catch (err) {
            if (err instanceof VaultError) throw err;
            return fail("unverified", `The push reported success but ORBIT could not verify that the commit is on the remote (${git.scrub(err instanceof Error ? err.message : String(err)).slice(0, 160)}); treat the change as NOT saved.`);
          }
          head = remoteHead;
          lastError = undefined;
          lastWrite = { at: now().toISOString(), commit, files: p.files };
          return { status: "committed", commit, branch: branch!, files: p.files, logFile: p.logFile, verifiedOnRemote: true, remoteHead, attempts: attempt, agentsMdSha: p.agentsSha };
        }
        const text = `${push.stdout}\n${push.stderr}`;
        if (!isNonFastForward(push.stdout)) {
          // Permission, branch protection, a hook, a missing branch, and anything else the remote refuses: permanent, not a race.
          fail("push_failed", `The push failed: ${git.scrub(text).trim().split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 240)}`);
        }
        // Someone else moved the branch. Attempt 2 starts again from their state and reapplies the intent once.
        if (attempt === 2) {
          await git.run(["fetch", "--quiet", "--prune", "--no-tags", "origin"], { cwd: dir });
          const changed = (await git.run(["diff", "--name-only", `${firstBase}..${ref()}`, "--"], { cwd: dir, allowFail: true })).stdout.split("\n").filter(Boolean);
          const ours = new Set(p.files);
          const overlap = changed.filter((f) => ours.has(f));
          fail("conflict", `The remote branch changed again while writing, so ORBIT stopped after one retry. Nothing was pushed and nothing was overwritten.${overlap.length ? ` Files changed on both sides: ${overlap.join(", ")}.` : " No file changed on both sides; try again."}`, overlap.length ? overlap : p.files);
        }
      }
      return fail("push_failed", "The push did not complete.");
    } catch (err) {
      if (err instanceof VaultError) throw err;
      return fail("push_failed", git.scrub(err instanceof Error ? err.message : String(err)));
    } finally {
      // Whatever happened, leave the clone equal to the remote: an unpushed commit of ours must not linger or be pushed later.
      if (branch && hasClone()) {
        await git.run(["reset", "--hard", "--quiet", ref(), "--"], { cwd: dir, allowFail: true }).catch(() => {});
        await git.run(["clean", "-fdq"], { cwd: dir, allowFail: true }).catch(() => {});
      }
      if (held) mutating--;
      deps.onChange?.();
    }
  }

  const withTimeout = (p: Promise<unknown>, ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      p.then(
        () => (clearTimeout(timer), resolve()),
        () => (clearTimeout(timer), resolve()),
      );
    });

  // Fetch (or clone) and make the working tree equal the remote branch. Concurrent callers share one run, and while a failure's
  // backoff is open this does not touch the network: it fails at once with the time of the next try.
  function sync(): Promise<void> {
    if (inflight) return inflight;
    if (backingOff()) {
      return Promise.reject(new VaultError("sync_failed", `The vault fetch failed ${failures} time(s) in a row and is backing off until ${new Date(retryAt!).toISOString()}; the last good clone is still used for reads.${syncError ? ` Last error: ${syncError.message}` : ""}`));
    }
    const p = serial(syncLocked).finally(() => {
      if (inflight === p) inflight = undefined;
    });
    inflight = p;
    return p;
  }

  return {
    dir,
    remote,
    credentialPresent: () => token() !== undefined,
    sync,
    // For chat reads: start a fetch when the clone is older than maxAgeMs, without making the reader wait on a failing network.
    // At most one fetch runs at a time and a failure backs off; the reader waits a short bounded time only while fetches are
    // healthy, and not at all after a failure. It never throws: the freshness of what is read is in state() and the answer's source.
    async refreshForRead(maxAgeMs: number): Promise<void> {
      if (!token()) return;
      if (fetchedAt && now().getTime() - new Date(fetchedAt).getTime() < maxAgeMs) return;
      if (inflight === undefined && backingOff()) return;
      const run = sync();
      run.catch(() => {});
      if (failures > 0) return;
      await withTimeout(run, readWaitMs);
    },
    // True when no write or tree update is changing the working tree. Readers that cannot wait use their last snapshot while it is false.
    stable: (): boolean => mutating === 0,
    // Applies edits and pushes them; resolves only when our commit was verified to be in the remote branch's history.
    write: (edits: VaultEdit[], mode: WriteMode, meta: WriteMeta): Promise<WriteResult> => serial(() => writeLocked(edits, mode, meta)),
    // AGENTS.md, System/conventions.md and System/memory.md as they are in the clone now.
    policyDocs: (): PolicyDocs => policyDocs(),
    // How the vault's AGENTS.md compares with the one the coded rules were written against (see policy-check.ts).
    policyCheck: (baseline?: string): PolicyCheck => checkPolicy(policy, baseline ?? undefined),
    // Reads a note from the clone with the same symlink refusal the writer uses. Refused while the tree is being changed.
    readNote: (path: string): string | undefined => {
      if (mutating) throw new VaultError("precondition_failed", "The vault clone is being updated; try again in a moment.");
      return diskRead(path);
    },
    // Reads a note once nothing is changing the tree (queued behind running writes and syncs).
    readNoteQueued: (path: string): Promise<string | undefined> => serial(async () => diskRead(path)),
    state(): CloneState {
      return {
        credential: token() ? "present" : "missing",
        clone: hasClone() && head ? "ready" : "absent",
        branch,
        head,
        fetchedAt,
        syncFailures: failures,
        ...(retryAt !== undefined && backingOff() ? { nextSyncAt: new Date(retryAt).toISOString() } : {}),
        ...(policy ? { policy } : {}),
        ...(lastError ? { lastError } : {}),
        ...(syncError ? { syncError } : {}),
        ...(lastWrite ? { lastWrite } : {}),
      };
    },
  };
}
