// Host-local staging for the legacy photo import (docs/photo-import-backfill.md, "Staging"). Makes a NEW export bundle from an
// original one: JPEGs already within the upload bounds are copied unchanged; other JPEGs and PNGs are converted with the host's
// ImageMagick to a JPEG of at most 1600 px on the longest edge, 2.56 MP and 1 MiB (orientation applied, metadata stripped) and checked
// with ORBIT's own upload check; the manifest is copied with only each staged item's `file` changed. The original bundle is only read.
// ImageMagick is a documented dependency the operator installs; this tool never installs anything and never reads ORBIT's state.
//
//   node tools/photo-import/stage.ts --export <original bundle> --out <new, empty directory> [--magick <path to magick or convert>]
//
// Prints one JSON report (also saved as staging-report.json in --out): counts, item ids, statuses, reasons, sizes and hashes. Never
// captions, pointers, file names or paths. Exit 0 every item staged, 1 some items could not be staged (they are left out of the
// staged manifest and listed in `omitted`), 2 refused (nothing was written).
import { ImportError } from "../../src/photo-import.ts";
import { findConverter, stageExport } from "../../src/photo-import-stage.ts";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (x: unknown) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
const refuse = (why: string): never => {
  out({ refused: true, why, written: false });
  process.exit(2);
};
const known = ["--export", "--out", "--magick"];
for (const a of args) if (a.startsWith("--") && !known.includes(a)) refuse(`unknown option ${a.slice(0, 40)}; options: ${known.join(" ")}`);
const exportDir = arg("--export");
const outDir = arg("--out");
if (!exportDir || !outDir) refuse("pass --export <the original bundle directory> and --out <a new, empty directory for the staged bundle>");
let started = false;
try {
  const converter = findConverter(arg("--magick"));
  started = true;
  const report = stageExport({ exportDir: exportDir!, out: outDir!, converter });
  out({
    ...report,
    next: "Dry run on the STAGED bundle (ORBIT may keep running): node tools/photo-import/import.ts --export <the --out directory> --state <ORBIT state dir> --projects-dir <vault>/Projects. Review and approve that dry run (approvals use the staged manifest's manifestSha256). Items in `omitted` are not in the staged manifest: fix them by hand or leave them out.",
  });
  process.exitCode = report.counts.failed ? 1 : 0;
} catch (err) {
  // Refusals (ImportError) happen before anything is written. Anything else after the converter was found may have left a partial
  // --out directory without its manifest, which the importer refuses; delete it and run again.
  if (!(err instanceof ImportError) && started) {
    out({ failed: true, why: `unexpected error: ${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? "error" : "unknown"}`, written: "partial", next: "Delete the --out directory and run again. The original bundle was not changed." });
    process.exit(1);
  }
  refuse(err instanceof Error ? err.message : "unknown error");
}
