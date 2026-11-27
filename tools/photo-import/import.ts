// Operator-run legacy photo importer (docs/photo-import-backfill.md). Host-local only: run it on the ORBIT host, as ORBIT's service
// user, against a local export bundle (a directory with orbit-photo-export.json and the photo files it names). Never fetches a URL, never reads
// outside the export directory, never modifies the export.
//
//   Dry run (the default; changes nothing, ORBIT may keep running):
//     node tools/photo-import/import.ts --export <dir> --state <ORBIT state dir> [--projects-dir <vault>/Projects] [--approvals <file>]
//   Apply a reviewed dry run (ORBIT stopped):
//     node tools/photo-import/import.ts ... --apply --reviewed-manifest-sha256 <sha from the dry run> --orbit-stopped
//   Reverse one applied batch (ORBIT stopped):
//     node tools/photo-import/import.ts --state <dir> --revert <ib_…> --orbit-stopped
//
// Prints one JSON report on stdout: counts, item ids, statuses, reasons, refs and project paths. Never captions, pointers, file
// names, paths or image data. Exit 0 done, 1 some items failed, 2 refused (nothing was changed).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { attachmentStore } from "../../src/attachments.ts";
import { lock } from "../../src/photo-backfill.ts";
import { applyImport, exportRoot, ImportError, knownProjects, planImport, readOnlyIndex, reportOf, revertImport, storeIndex } from "../../src/photo-import.ts";
import { importLedger } from "../../src/photo-import-ledger.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const arg = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (x: unknown) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
const refuse = (why: string): never => {
  out({ refused: true, why, changed: false });
  process.exit(2);
};
const known = ["--export", "--state", "--projects-dir", "--approvals", "--apply", "--reviewed-manifest-sha256", "--orbit-stopped", "--revert"];
for (const a of args) if (a.startsWith("--") && !known.includes(a)) refuse(`unknown option ${a.slice(0, 40)}; options: ${known.join(" ")}`);

const state = arg("--state");
if (!state) refuse("pass --state <ORBIT's state directory> (for the systemd unit: /var/lib/orbit)");
try {
  if (!statSync(state!).isDirectory()) throw new Error();
} catch {
  refuse("the state directory does not exist");
}
const writing = flag("--apply") || flag("--revert");
if (writing) {
  if (!flag("--orbit-stopped")) refuse("apply and revert write ORBIT's stores, which the running service also writes: stop ORBIT (systemctl stop orbit), then pass --orbit-stopped");
  if (typeof process.getuid === "function" && statSync(state!).uid !== process.getuid()) refuse("run as the owner of the state directory (ORBIT's service user), so the stored files stay readable by ORBIT");
}
const attachmentsDir = join(state!, "attachments");
const importsDir = join(state!, "photo-imports");

try {
  if (flag("--revert")) {
    const batch = arg("--revert") ?? "";
    const release = lock(importsDir, ".import.lock");
    try {
      const r = revertImport(batch, { attachments: attachmentStore(attachmentsDir), ledger: importLedger(importsDir) });
      out({ reverted: r });
    } finally {
      release();
    }
    process.exit(0);
  }
  const exportDir = arg("--export");
  if (!exportDir) refuse("pass --export <the export bundle directory>");
  const root = exportRoot(exportDir!);
  const projects = knownProjects(arg("--projects-dir"));
  const approvalsFile = arg("--approvals");
  let approvalsText: string | undefined;
  if (approvalsFile) {
    try {
      approvalsText = readFileSync(approvalsFile, "utf8");
    } catch {
      refuse("the approvals file cannot be read");
    }
  }
  if (!flag("--apply")) {
    // Read-only: neither store is opened (opening the attachment store tidies its directory).
    const plan = planImport({ root, approvalsText, projects, existing: readOnlyIndex(attachmentsDir), ledger: importLedger(importsDir) });
    out({ dryRun: true, ...(projects ? {} : { warning: "no --projects-dir: no project can be checked, so no link would be made" }), next: "Review this report with the owner. To apply exactly this manifest: --apply --reviewed-manifest-sha256 <manifestSha256> --orbit-stopped (ORBIT stopped).", plan: reportOf(plan) });
    process.exit(0);
  }
  const reviewed = arg("--reviewed-manifest-sha256");
  if (!reviewed || !/^[0-9a-f]{64}$/.test(reviewed)) refuse("pass --reviewed-manifest-sha256 <the manifestSha256 of the dry run the owner reviewed>");
  const release = lock(importsDir, ".import.lock");
  try {
    const attachments = attachmentStore(attachmentsDir);
    const ledger = importLedger(importsDir);
    const plan = planImport({ root, approvalsText, projects, existing: storeIndex(attachments), ledger });
    if (plan.manifestSha256 !== reviewed) throw new ImportError("the manifest changed since the reviewed dry run (its SHA-256 differs); run the dry run again and review it");
    const result = applyImport(plan, { root, attachments, ledger });
    out({ applied: true, batch: result.batch, result, plan: reportOf(plan), next: `Start ORBIT, then verify in the gallery (docs/photo-import-backfill.md). To reverse: --revert ${result.batch} --orbit-stopped` });
    process.exitCode = result.failed.length ? 1 : 0;
  } finally {
    release();
  }
} catch (err) {
  refuse(err instanceof ImportError ? err.message : `unexpected error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`);
}
