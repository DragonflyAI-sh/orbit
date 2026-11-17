// Owner-run, bounded, SYNTHETIC live evaluation of tool-capability claims (docs/assistant.md, "Tool rounds and capability claims").
// It may be PAID (OpenAI API key): run it only with Rai's explicit go-ahead.
//
//   node tools/capability-eval/eval.ts --confirm-synthetic-live-eval --key-file <path to a file holding the key> --model <model id>
//
// Sends only the invented scenarios of test/capability-fixture.ts through ORBIT's real tool loop and OpenAI adapter. The tools are
// test doubles: nothing is written to the vault, no job is launched, no ORBIT state is read or written. Hard bound: at most
// MAX_REQUESTS model requests in total (each scenario is capped by its own round budget). Prints a JSON report (per scenario: pass,
// failures, tools called, whether the budget was hit, the reply text); never the key. Exit 0 all passed, 1 a scenario failed or a
// request failed, 2 refused (nothing sent). The pass/fail checks are evaluation scoring only; ORBIT never applies them to live replies.
import { readFileSync } from "node:fs";
import { MAX_ROUNDS } from "../../src/agent.ts";
import { openaiModel } from "../../src/model.ts";
import { runScenario, SCENARIOS } from "../../test/capability-fixture.ts";

const MAX_REQUESTS = SCENARIOS.reduce((n, s) => n + (s.maxRounds ?? MAX_ROUNDS) + 1, 0);
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const refuse = (why: string) => {
  process.stdout.write(`${JSON.stringify({ refused: true, why, sent: 0 }, null, 2)}\n`);
  process.exit(2);
};
if (!args.includes("--confirm-synthetic-live-eval")) refuse("pass --confirm-synthetic-live-eval once Rai has approved a live (possibly paid) run");
const keyFile = arg("--key-file");
const model = arg("--model");
if (!keyFile) refuse("pass --key-file <path>; the key is never taken from the command line or printed");
if (!model) refuse("pass --model <the model id ORBIT_MODEL names>");
let key = "";
try {
  key = readFileSync(keyFile!, "utf8").trim();
} catch {
  refuse("the key file could not be read");
}
if (!key || /\s/.test(key)) refuse("the key file must hold one single-line key");

let requests = 0;
const counted = ((url: string | URL | Request, init?: RequestInit) => {
  if (++requests > MAX_REQUESTS) return Promise.reject(new Error(`request bound of ${MAX_REQUESTS} reached; not sent`));
  return fetch(url, init);
}) as typeof fetch;
const m = openaiModel(model!, key, counted);
const results = [];
for (const s of SCENARIOS) results.push(await runScenario(m, s));
const passed = results.filter((r) => r.pass).length;
process.stdout.write(`${JSON.stringify({ model, requests, passed, total: results.length, results }, null, 2)}\n`);
process.exit(passed === results.length ? 0 : 1);
