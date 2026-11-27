// Operator-run missing-observations backfill (docs/photo-import-backfill.md, "Backfill"). Host-local only: run it on the ORBIT host,
// as ORBIT's service user, with ORBIT's own environment (orbit.env, credentials) and ORBIT STOPPED, because it opens ORBIT's stores.
//
//   Dry run (the default): which photos would be described, and whether the configured model may be sent photos. No image is read.
//     node tools/photo-backfill/backfill.ts --state <ORBIT state dir> --orbit-stopped [--limit 10] [--include-archived]
//   Describe (sends each selected stored photo to the configured PRIMARY model; may cost model usage):
//     ... --apply [--limit 10] [--interval-ms 5000] [--index]
//   Retry only the search indexing of observations this backfill saved (no model call, no image read):
//     ... --index-only
//
// Never builds or uses the paid fallback, never changes configuration, never describes a photo from its caption. Prints one JSON
// report (refs, statuses, reasons, counts; never observation text or image data). Exit 0 done, 1 stopped, some items failed, or an
// error after photos were read (the report then says how many were read, sent and saved), 2 refused (nothing was read or sent).
import { statSync } from "node:fs";
import { join } from "node:path";
import { assistantStore } from "../../src/assistant-store.ts";
import { attachmentStore } from "../../src/attachments.ts";
import { chatgptModel, tokenFile } from "../../src/chatgpt.ts";
import { embeddingBudget, embeddingsConfig, openaiEmbedder } from "../../src/embeddings.ts";
import { selectModel } from "../../src/model.ts";
import { BACKFILL_LIMIT_DEFAULT, checkpoint, lock, runBackfill } from "../../src/photo-backfill.ts";
import { importLedger } from "../../src/photo-import-ledger.ts";
import { observationStore } from "../../src/photo-observations.ts";
import type { SemanticSources } from "../../src/photo-semantic.ts";
import { vectorCache } from "../../src/photo-semantic.ts";
import { threadStore } from "../../src/threads.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const arg = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (x: unknown) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
const refuse = (why: string): never => {
  out({ refused: true, why, read: 0, sent: 0, saved: 0 });
  process.exit(2);
};
const known = ["--state", "--orbit-stopped", "--apply", "--limit", "--interval-ms", "--include-archived", "--index", "--index-only", "--attempts"];
for (const a of args) if (a.startsWith("--") && !known.includes(a)) refuse(`unknown option ${a.slice(0, 40)}; options: ${known.join(" ")}`);
const state = arg("--state");
if (!state) refuse("pass --state <ORBIT's state directory> (for the systemd unit: /var/lib/orbit)");
try {
  if (!statSync(state!).isDirectory()) throw new Error();
} catch {
  refuse("the state directory does not exist");
}
if (!flag("--orbit-stopped")) refuse("the backfill opens ORBIT's stores, which the running service also writes: stop ORBIT (systemctl stop orbit), then pass --orbit-stopped");
if (typeof process.getuid === "function" && statSync(state!).uid !== process.getuid()) refuse("run as the owner of the state directory (ORBIT's service user), so the stored files stay readable by ORBIT");
const num = (n: string, d: number) => {
  const v = arg(n);
  if (v === undefined) return d;
  const x = Number(v);
  return Number.isInteger(x) ? x : refuse(`${n} must be an integer`);
};
// Every option is checked before the lock is taken, so a refusal never leaves the lock behind.
const limit = num("--limit", BACKFILL_LIMIT_DEFAULT), intervalMs = num("--interval-ms", 5000), attempts = num("--attempts", 3);

const env = process.env;
const modelName = env.ORBIT_MODEL ?? "";
let release: () => void = () => {};
try {
  release = lock(join(state!, "photo-backfill"), ".backfill.lock");
} catch (err) {
  refuse(err instanceof Error ? err.message.slice(0, 300) : "the backfill lock could not be taken");
}
const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());
const progress = { read: 0, sent: 0, saved: 0 };
// The primary model exactly as ORBIT builds it (src/main.ts), WITHOUT the OpenRouter fallback wrapper; stopped however the run ends.
const chatgpt: { current?: ReturnType<typeof chatgptModel> } = {};
let failure: string | undefined;
try {
  const threads = threadStore(join(state!, "threads"));
  const assistant = assistantStore(join(state!, "assistant"));
  const ledger = importLedger(join(state!, "photo-imports"));
  const sources: SemanticSources = {
    assistant: () => assistant.photoSource(),
    chat: (tid) => threads.photoSource(tid),
    imported: (aid) => ledger.photo(aid),
    message: (c, m) => (c === "assistant:assistant" ? assistant.messageState(m) : /^chat:/.test(c) ? threads.messageState(c.slice(5), m) : "gone"),
    discussion: (c, m) => (c === "assistant:assistant" ? assistant.photoDiscussion(m) : /^chat:/.test(c) ? threads.photoDiscussion(c.slice(5), m) : undefined),
  };
  const model = selectModel(env, (name) => (chatgpt.current = chatgptModel(name, tokenFile(state), { capabilities: { operatorFile: env.ORBIT_MODEL_CAPABILITIES || undefined } })));
  // Upkeep the service also does before replies (login renewal, capability metadata); never with a photo.
  await model.maintain?.();
  let index: Parameters<typeof runBackfill>[0]["index"];
  const wantIndex = flag("--index") || flag("--index-only");
  if (wantIndex) {
    const cfg = embeddingsConfig(env);
    // Thrown, not refused here, so the lock is released on the way out.
    if (cfg.state !== "ready") throw new Error(`--index needs semantic photo search configured as ORBIT runs it (ORBIT_PHOTO_SEMANTIC=on and the orbit.openai-embeddings credential): ${cfg.state}`);
    {
      const budget = embeddingBudget(join(state!, "embeddings-budget.json"), cfg.settings);
      const embedder = openaiEmbedder({ key: cfg.key, settings: cfg.settings, budget });
      index = { embedder, cache: vectorCache(join(state!, "photo-vectors"), embedder.id) };
    }
  }
  const report = await runBackfill(
    { attachments: attachmentStore(join(state!, "attachments")), sources, store: observationStore(join(state!, "photo-observations")), model, modelName, checkpoint: checkpoint(join(state!, "photo-backfill")), index, signal: ac.signal, progress, log: (l) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...l })}\n`) },
    { dryRun: !flag("--apply") && !flag("--index-only"), indexOnly: flag("--index-only"), limit, intervalMs, attempts, includeArchived: flag("--include-archived") },
  );
  out(report);
  process.exitCode = report.stopped || report.counts.failed ? 1 : 0;
} catch (err) {
  failure = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
} finally {
  try {
    await chatgpt.current?.stop?.();
  } catch {
    // stopping is best effort; the run's own outcome is what is reported
  }
  release();
}
if (failure !== undefined) {
  // Nothing read or sent: a refusal. After that, never "nothing was sent": say what was done, so the operator knows.
  if (!progress.read && !progress.sent && !progress.saved) refuse(failure);
  out({ failed: true, why: failure, ...progress, next: "The run stopped on an error after it began. The checkpoint keeps every photo finished before it, so a rerun resumes; --index-only retries indexing." });
  process.exitCode = 1;
}
