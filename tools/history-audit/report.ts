// Prints the SYNTHETIC measurement tables of docs/reviews/assistant-history-sizing-audit.md. Offline and free: no provider, no real
// vault, no ORBIT state, no network. Everything is ORBIT's own code run on invented workloads (test/history-audit-fixture.ts) plus one
// offline capture of the fixed request part (test/history-audit-capture.ts).
//
//   node tools/history-audit/report.ts > /tmp/history-audit.md
import { buildReport } from "../../test/history-audit-fixture.ts";
import { captureAssistantRequest } from "../../test/history-audit-capture.ts";

// The server logs one JSON line per policy decision on stdout; keep them out of the report.
const log = console.log;
console.log = () => {};
const c = await captureAssistantRequest();
console.log = log;
process.stdout.write(`${await buildReport({ instructionsChars: c.instructionsChars, instructionsFinalChars: c.instructionsFinalChars, toolSchemaChars: c.toolSchemaChars, tools: c.toolNames.length })}\n`);
