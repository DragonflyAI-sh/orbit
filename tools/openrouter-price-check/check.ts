// Usage: node tools/openrouter-price-check/check.ts <saved-endpoints.json> --in <USD/M> --out <USD/M> [--max-output <tokens>] [--json]
// Reads a saved copy of https://openrouter.ai/api/v1/models/<id>/endpoints (fetched by a person; this tool never uses the network,
// a key or the ledger) and says whether ORBIT's configured prices bound every endpoint max_price admits. Exit 0 ok, 1 blocked, 2 usage.
// See docs/openrouter-preactivation-evidence.md, "Price check".
import { readFileSync } from "node:fs";
import { checkPrices } from "../../src/openrouter-price-check.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/openrouter.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args[0];
const priceIn = Number(flag("--in"));
const priceOut = Number(flag("--out"));
const maxOutputTokens = Number(flag("--max-output") ?? DEFAULT_MAX_OUTPUT_TOKENS);
if (!file || file.startsWith("--") || !(priceIn > 0) || !(priceOut > 0) || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
  process.stderr.write("usage: check.ts <saved-endpoints.json> --in <USD per M> --out <USD per M> [--max-output <tokens>] [--json]\n");
  process.exit(2);
}
let json: unknown;
try {
  json = JSON.parse(readFileSync(file, "utf8"));
} catch {
  process.stderr.write("the file could not be read as JSON\n");
  process.exit(2);
}
const r = checkPrices(json, { priceIn, priceOut, maxOutputTokens });
if (args.includes("--json")) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
else {
  const lines = [
    `model ${r.model}: ${r.ok ? "OK" : "BLOCKED"} at in ${priceIn} / out ${priceOut} USD per M, max_tokens ${maxOutputTokens}`,
    `admitted endpoints (every price window within the configured prices): ${r.admitted.length}; excluded: ${r.excluded.length}`,
    ...r.admitted.map((v) => `  + ${v.tag}: in <= ${v.maxPromptPerMtok}, out <= ${v.maxCompletionPerMtok}, output limit ${v.maxCompletionTokens ?? "?"}${v.tools ? "" : ", NO tools"}`),
    ...r.excluded.map((v) => `  - ${v.tag}: in up to ${v.maxPromptPerMtok}, out up to ${v.maxCompletionPerMtok}`),
    `reservation for the largest request: ${r.boundPerCallUsd} USD`,
    `one call if a provider did not count reasoning against max_tokens: up to ${r.worstIfReasoningUncappedUsd} USD`,
    ...r.blockers.map((b) => `BLOCKER: ${b}`),
    ...r.warnings.map((w) => `warning: ${w}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
process.exit(r.ok ? 0 : 1);
