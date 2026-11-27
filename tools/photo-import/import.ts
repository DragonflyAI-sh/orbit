// Operator-run legacy photo importer (docs/photo-import-backfill.md). Host-local only: run it on the ORBIT host, as ORBIT's service
// user, against a local export bundle (a directory with orbit-photo-export.json and the photo files it names). Never fetches a URL, never reads
// outside the export directory, never modifies the export.
//
//   Dry run (the default; changes nothing, ORBIT may keep running):
//     node tools/photo-import/import.ts --export <dir> --state <ORBIT state dir> [--projects-dir <vault>/Projects] [--approvals <file>]
//   Apply a reviewed dry run (ORBIT stopped):
//     node tools/photo-import/import.ts ... --apply --reviewed-plan-sha256 <planSha256 from the dry run> --orbit-stopped
//   Apply rebuilds the plan from the files, approvals and stores as they are then, and refuses unless its digest is the reviewed one.
//   Reverse one applied batch (ORBIT stopped):
//     node tools/photo-import/import.ts --state <dir> --revert <ib_…> --orbit-stopped
//
// Prints one JSON report on stdout: counts, item ids, statuses, reasons, refs and project paths. Never captions, pointers, file
// names, paths or image data. Exit 0 done, 1 some items failed (or an error after writing began: the report says so), 2 refused
// (nothing was changed).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { attachmentStore } from "../../src/attachments.ts";
import { lock } from "../../src/photo-backfill.ts";
import { applyImport, exportRoot, ImportError, knownProjects, planDigest, planImport, readOnlyIndex, reportOf, revertImport, storeIndex } from "../../src/photo-import.ts";
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
const known = ["--export", "--state", "--projects-dir", "--approvals", "--apply", "--reviewed-plan-sha256", "--reviewed-manifest-sha256", "--orbit-stopped", "--revert"];
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
// Set once the ledger or the attachment store may have been written: an error after that is not "nothing was changed".
let changing = false;

try {
  if (flag("--revert")) {
    const batch = arg("--revert") ?? "";
    const release = lock(importsDir, ".import.lock");
    try {
      const attachments = attachmentStore(attachmentsDir), ledger = importLedger(importsDir);
      changing = true;
      const r = revertImport(batch, { attachments, ledger });
      out({ reverted: r });
      process.exitCode = r.removeFailed ? 1 : 0;
    } finally {
      release();
    }
    process.exit();
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
    out({ dryRun: true, ...(projects ? {} : { warning: "no --projects-dir: no project can be checked, so no link would be made" }), next: "Review this report with the owner. To apply exactly this plan: --apply --reviewed-plan-sha256 <planSha256> --orbit-stopped (ORBIT stopped). Apply refuses if anything it covers has changed since.", plan: reportOf(plan) });
    process.exit(0);
  }
  const reviewed = arg("--reviewed-plan-sha256");
  if (!reviewed || !/^[0-9a-f]{64}$/.test(reviewed)) refuse("pass --reviewed-plan-sha256 <the planSha256 of the dry run the owner reviewed>");
  const reviewedManifest = arg("--reviewed-manifest-sha256"); // optional, still checked when given
  if (reviewedManifest !== undefined && !/^[0-9a-f]{64}$/.test(reviewedManifest)) refuse("--reviewed-manifest-sha256 must be the 64-character manifestSha256 of the reviewed dry run");
  const release = lock(importsDir, ".import.lock");
  try {
    const attachments = attachmentStore(attachmentsDir);
    const ledger = importLedger(importsDir);
    const plan = planImport({ root, approvalsText, projects, existing: storeIndex(attachments), ledger });
    if (reviewedManifest !== undefined && plan.manifestSha256 !== reviewedManifest) throw new ImportError("the manifest changed since the reviewed dry run (its SHA-256 differs); run the dry run again and review it");
    if (planDigest(plan) !== reviewed) throw new ImportError("the plan changed since the reviewed dry run (a photo file, the approvals, the manifest or what ORBIT already stores differs from what was reviewed); nothing was imported. Run the dry run again and review it");
    changing = true;
    const result = applyImport(plan, { root, attachments, ledger });
    out({ applied: true, batch: result.batch, result, plan: reportOf(plan), next: `Start ORBIT, then verify in the gallery (docs/photo-import-backfill.md). To reverse: --revert ${result.batch} --orbit-stopped` });
    process.exitCode = result.failed.length ? 1 : 0;
  } finally {
    release();
  }
} catch (err) {
  const why = err instanceof ImportError ? err.message : `unexpected error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`;
  // The import and revert refuse their own errors before writing (ImportError); anything else after writing began may have left part
  // of the work done, so the report never claims nothing changed.
  if (changing && !(err instanceof ImportError)) {
    out({ failed: true, why, changed: "unknown", next: "Some of the work may have been done. Look at the ledger and the gallery (docs/photo-import-backfill.md, Verify); rerunning the dry run shows what is stored now." });
    process.exit(1);
  }
  refuse(why);
}
