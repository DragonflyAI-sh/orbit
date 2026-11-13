// Usage (PAID; only with Rai's explicit authorisation, see docs/openrouter-activation-runbook.md "Paid smoke test"):
//   node tools/openrouter-smoke/smoke.ts --confirm-paid-smoke
// Configuration comes from the environment exactly as ORBIT reads it (ORBIT_OPENROUTER_*, CREDENTIALS_DIRECTORY with orbit.openrouter).
// Prints a JSON report (no reply text, no key). Exit 0 all checks passed, 1 a check failed, 2 refused (nothing was sent).
import { runSmoke } from "../../src/openrouter-smoke.ts";

const r = await runSmoke(process.argv.slice(2), process.env);
process.stdout.write(JSON.stringify(r, null, 2) + "\n");
process.exit(r.refused ? 2 : r.ok ? 0 : 1);
