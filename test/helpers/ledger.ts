import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_FILE, MARKER_FILE, PROVISION_FILE, spendLedger } from "../../src/spend-ledger.ts";
import type { SpendCaps, SpendLedger, SpendOptions } from "../../src/spend-ledger.ts";

// What the owner does by hand once: create the provision file, then ORBIT starts (open()). Used by tests that need a working,
// file-backed ledger in a temporary directory. A directory that already holds a ledger or a marker is opened as it is, never provisioned.
export function provisioned(dir: string, caps: SpendCaps, now?: () => Date, opts?: SpendOptions): SpendLedger {
  if (!existsSync(join(dir, LEDGER_FILE)) && !existsSync(join(dir, MARKER_FILE))) writeFileSync(join(dir, PROVISION_FILE), JSON.stringify({ openingLifetimeUsd: 0, openingTodayUsd: 0, note: "test" }));
  const ledger = spendLedger(dir, caps, now, opts);
  ledger.open();
  return ledger;
}
