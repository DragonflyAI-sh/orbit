// Owner-run, bounded, SYNTHETIC live evaluation of opt-in semantic photo search (docs/photo-semantic-search.md, "Live evaluation").
// PAID unless the OpenAI project is covered by a grant: run it only after the checks in that section, with Rai's explicit go-ahead.
//
//   node tools/photo-semantic-eval/eval.ts --confirm-synthetic-live-eval --key-file <path to a file holding the dedicated key>
//
// Sends only the invented fixture text of test/photo-semantic-fixture.ts (no private data, no ORBIT state is read or written):
// one synthetic probe, then the 20 fixture queries and the 16 eligible fixture evidence records (20 records, 4 excluded by the
// lifecycle rules before anything is sent). Hard bounds, enforced by the adapter's own ledger before every HTTP attempt: at most
// 25 attempts and 10,000 input tokens in total; anything over is refused, not sent. No retry on auth or quota errors.
// Prints a JSON report (counts, rankings, latency; never the key). Exit 0 completed, 1 a request failed, 2 refused (nothing sent).
import { readFileSync } from "node:fs";
import { embeddingBudget, EMBEDDINGS_DEFAULT_MODEL, NATIVE_DIMENSIONS, openaiEmbedder } from "../../src/embeddings.ts";
import { vectorCache } from "../../src/photo-semantic.ts";
import { runEvaluation } from "../../test/photo-semantic-fixture.ts";

const ATTEMPTS_MAX = 25;
const TOKENS_MAX = 10_000;
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const refuse = (why: string) => {
  process.stdout.write(`${JSON.stringify({ refused: true, why, sent: 0 }, null, 2)}\n`);
  process.exit(2);
};
if (!args.includes("--confirm-synthetic-live-eval")) refuse("pass --confirm-synthetic-live-eval after completing the pre-checks in docs/photo-semantic-search.md");
const keyFile = arg("--key-file");
if (!keyFile) refuse("pass --key-file <path>; the key is never taken from the command line or printed");
let key = "";
try {
  key = readFileSync(keyFile!, "utf8").trim();
} catch {
  refuse("the key file could not be read");
}
if (!key || /\s/.test(key)) refuse("the key file must hold one single-line key");
const model = arg("--model") ?? EMBEDDINGS_DEFAULT_MODEL;
const dims = Number(arg("--dimensions") ?? NATIVE_DIMENSIONS[model]);
if (!Number.isInteger(dims) || dims < 1) refuse("unknown model size: pass --dimensions");
const settings = { model, dims, sendDimensions: NATIVE_DIMENSIONS[model] !== undefined && dims !== NATIVE_DIMENSIONS[model], dailyRequests: ATTEMPTS_MAX, dailyTokens: TOKENS_MAX };
const budget = embeddingBudget(undefined, settings);
const embedder = openaiEmbedder({ key, settings, budget });
const report: Record<string, unknown> = { synthetic: true, model, dims, bounds: { attempts: ATTEMPTS_MAX, inputTokens: TOKENS_MAX } };
const t0 = performance.now();
try {
  const [v] = await embedder.embed(["synthetic probe text"]);
  report.probe = { ok: true, dims: v!.length, ms: Number((performance.now() - t0).toFixed(0)) };
} catch (err) {
  report.probe = { ok: false, error: err instanceof Error ? err.message : "unknown" };
  report.ledger = budget.used();
  report.adapter = embedder.stats;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}
const run = await runEvaluation({ embedder, cache: vectorCache(undefined, embedder.id), maxRequests: ATTEMPTS_MAX - 1 });
report.summary = run.summary;
report.rows = run.rows;
report.ledger = budget.used();
report.adapter = embedder.stats;
report.note = "Synthetic fixture only (10 photos). Indicative, not a general quality measurement. The floor (0.35) and ambiguity ratio (0.9) are not calibrated for this model.";
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const failed = run.results.some((r) => r.degraded);
process.exit(failed ? 1 : 0);
