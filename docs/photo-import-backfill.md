# Legacy photo import and observation backfill

Two operator tools, plus a staging helper for the importer. They run on the ORBIT host only.

- **Importer** (`tools/photo-import/import.ts`, `src/photo-import.ts`, `src/photo-import-ledger.ts`). It brings photos Rai sent to the legacy assistant (OpenClaw) into ORBIT's photo gallery. It works from a local export bundle, records where each photo came from, and adds a project link only when there is explicit or operator-approved evidence.
- **Staging helper** (`tools/photo-import/stage.ts`, `src/photo-import-stage.ts`). It makes a new, compliant copy of an export bundle: PNGs and JPEGs that are too large become JPEGs within the upload bounds, converted with the host's ImageMagick. The original bundle is only read, and provenance is never changed (see [Staging](#staging-host-local-jpegpng-to-compliant-jpeg)).
- **Backfill** (`tools/photo-backfill/backfill.ts`, `src/photo-backfill.ts`). It describes photos that have no usable observation (imported ones included) by sending each one to the configured vision-capable primary model. It saves the answer through the observation contract, so the photo becomes searchable by what it shows.

**Status.** The tools are built and tested with synthetic fixtures only. No production host, legacy session, photo, vault note, credential or private export was read. Nothing was migrated, indexed or deployed. Every statement below about Rai's actual legacy data is marked **unverified**.

## What the code relies on

| Interface | Where | How the tools use it |
|---|---|---|
| Attachment store | `src/attachments.ts` | New scope `IMPORT_SCOPE` (`"import"`). `putImported()` stores normalized bytes directly as `bound`, so the 24 h pending cleanup never deletes them. It refuses bytes that are already stored (a native photo, or an earlier import) and reuses the existing copy. `removeImported()` deletes only `import`-scope attachments. It reports `removed`, `not-stored`, `not-imported` or `damaged`, and throws on any unlink error other than "not found", leaving the attachment as it was. `withSha256()` is the duplicate check. `scanAttachmentRecords()` reads and checks every record without changing anything. The store's own start and the importer's dry run both use it, so they agree on which records are damaged (`damaged()`). Upload routes cannot use the import scope (`put()` refuses it). |
| JPEG check and normalization | `src/jpeg.ts` | Every source file goes through `normalizeJpeg`, the same function uploads use. That covers the signature, structure, the 1 MiB / 1600 px / 2.56 MP bounds and full decodability, and it drops every APPn segment (EXIF, GPS, XMP, ICC), comments and trailing bytes. |
| Photo reach | `src/photo-access.ts` | `photoPolicy("assistant:assistant")` also allows `import`. Chat threads never see imports. The resolver builds an imported photo's `Located` from the import ledger only: `conversation.kind: "import"`, `message: null`, a note saying it is not an ORBIT message, `sentAt` set to the legacy send time, and `imported` carrying the provenance. Without a ledger entry (never imported, or reverted), the photo is not found. |
| Import ledger | `src/photo-import-ledger.ts` | `<state>/photo-imports/ledger.json` (0600, atomic writes). It holds per-photo provenance, batches and project links. The server only reads it, and re-reads it when the file changes. |
| Observation store | `src/photo-observations.ts` | New record source `operator:photo-backfill` with `inspection.via: "backfill"`. Each requires the other, and the source is never allowed on a correction. `saveBackfillObservation()` applies photos_observe's text rules (bounded, flattened, masked, no opaque strings). It assigns provenance itself and refuses, writing nothing, if the image version changed, any record was forgotten, an active correction exists, or a usable observation already exists. The record id comes from the run and the item, so a retried save is a no-op. Operator records are read and forgotten only through the Assistant's reach (and so the gallery). Chat threads do not read them. |
| Gallery | `src/photo-gallery.ts`, `src/web/gallery.js` | Imported photos are listed under their legacy date. The page shows "Sent (legacy)", "Imported", "Legacy item" and "Legacy caption", plus the not-a-message note, and no conversation link. The detail view has a read-only **Projects** section. Backfill observations show "described by the operator backfill" with the context "operator backfill (not a conversation)". |
| Search | `src/photo-semantic.ts` | **Not changed.** Imported photos enter the existing corpus through `reachablePhotos`, contributing their conversation title ("Imported from OpenClaw …") and their observations. Backfill observations are `visual-observation` evidence like any other. Ranking code, weights and thresholds are untouched (coordination with the ranking work). Legacy captions are shown, but `collectEvidence` reads captions only from ORBIT messages, so **imported captions are not search evidence** in this change (see Gaps). |
| Embeddings | `src/embeddings.ts`, `vectorCache` | The backfill's optional `--index` step embeds only its new observation evidence, with the configured embedder and vector cache (the same ones `photos_search` uses). Otherwise vectors are made lazily at the next search, as before. |
| Projects | `src/plan.ts`, `src/sidebar.ts` | Projects are vault hub notes `Projects/<name>.md`. ORBIT has no photo-project machinery, so links are a narrow association in the import ledger: photo ref → project path, evidence, batch, item, time. No project file is read for content or changed. The importer lists the names of `Projects/*.md` only to check that a project exists. |

## Legacy format: what is and is not established

- **Read:** OpenClaw's public source (`github.com/openclaw/openclaw`, commit `0a8e37b`, 2026-11-27). Its current docs put state in a SQLite database at `$OPENCLAW_STATE_DIR/state/openclaw.sqlite` (default `~/.openclaw`). They document JSONL exports for *meeting transcripts* (`openclaw transcripts`). No private data was read.
- **Not established (unverified):** which OpenClaw version Rai's install ran, how that version stored chat photos (inline in transcripts, as media files, or by reference), whether those media files still exist or expired, and how a message was linked to a project. The storage format has changed across versions (JSONL transcripts earlier, a SQLite transcript schema now), so a parser written from today's source could silently misread an older install.
- **Therefore there is no native OpenClaw parser.** The operator builds the documented manifest below from the legacy data on the host, by whatever means fits that install, and the importer reads only that manifest and the files it names. Whole transcripts are never imported: the manifest takes a short caption and opaque pointers, nothing else.

## The export bundle (`orbit-legacy-photo-export/1`)

A directory holding `orbit-photo-export.json` (a regular file, at most 4 MiB, at most 5000 items) and the photo files it names. Everything here is synthetic:

```json
{
  "format": "orbit-legacy-photo-export/1",
  "source": "openclaw",
  "exportedAt": "2026-11-01T00:00:00Z",
  "items": [
    {
      "id": "msg-0001-1",
      "file": "media/0001.jpg",
      "sentAt": "2026-03-04T18:22:10Z",
      "sender": "owner",
      "caption": "Short message text sent with the photo",
      "session": "opaque-session-id",
      "message": "opaque-message-id",
      "projects": [{ "project": "Projects/Garden.md", "evidence": "explicit", "basis": "the message was tagged #garden" }],
      "projectCandidates": ["Projects/Shed.md"]
    }
  ]
}
```

Rules (`src/photo-import.ts`):

- **Item fields** are exactly the ones above. An unknown field (a `transcript`, a `url`, anything else) rejects the item.
- **`id`**: 1–64 characters `[A-Za-z0-9_.:-]`, unique in the bundle. The same id imported earlier with different bytes is refused, never replaced.
- **`sender`** must be `"owner"`. Only photos Rai sent are imported.
- **`sentAt`**: ISO UTC, not in the future. The gallery shows it as the legacy send time.
- **`caption`**: optional, at most 4000 characters in the manifest. It is stored flattened, masked for secret-shaped values and cut to 280 characters.
- **`session` / `message`**: optional opaque pointers (1–128 characters `[A-Za-z0-9_.:-]`), kept as provenance. Never paths or URLs.
- **`file`**: a plain relative path inside the bundle, ending in `.jpg` or `.jpeg`. It is refused if absolute, if it contains `..`, `.`, an empty part, a backslash or control characters, if it is a URL, if it resolves outside the bundle (symlinks followed), if it is not a regular file, or if it is over 16 MiB (refused before it is read). The bytes must then be a JPEG that passes the upload check *after* normalization. ORBIT has no image decoder, so the importer rejects PNG, HEIC, WebP and JPEGs over 1 MiB or 1600 px, giving the reason. Convert JPEG and PNG originals with the [staging helper](#staging-host-local-jpegpng-to-compliant-jpeg). Convert other formats by hand.
- **`projects`**: at most 8 entries, each `{project: "Projects/<name>.md", evidence: "explicit", basis: "<≤200 chars>"}`. Use `"explicit"` only when the legacy message itself named or tagged the project. Any other evidence value rejects the item.
- **`projectCandidates`**: possible projects without explicit evidence. They are **never** linked unless the operator approves one.

### Approvals (`orbit-legacy-photo-approvals/1`, optional)

The owner's review decisions, bound to the exact manifest that was reviewed:

```json
{ "format": "orbit-legacy-photo-approvals/1", "manifestSha256": "<from the dry run>", "links": { "msg-0001-1": "Projects/Shed.md", "msg-0002-1": null }, "skip": ["msg-0003-1"] }
```

- `links[item] = "Projects/<name>.md"` approves a link (evidence `operator-approved`). It wins over the export's own evidence.
- `null` declines any link.
- `skip` leaves an item out entirely.
- A `manifestSha256` that does not match the current manifest refuses the whole run.

### Dry-run inventory

The default mode. It changes nothing (it does not even open the attachment store, which would tidy its directory), and ORBIT may keep running. Each item gets one status:

| Status | Meaning |
|---|---|
| `importable` | Would be stored. Also used for a copy an interrupted earlier apply stored without its ledger entry; applying finishes it. |
| `already-imported` | The same bytes are already in the import ledger. |
| `already-present` | The same bytes were already sent in an ORBIT conversation, so they are not imported again. An explicit or approved link is added to that existing photo. |
| `duplicate-in-export` | The same photo as an earlier item in this bundle. |
| `missing` | The named file is not there, or is a broken link (missing or expired legacy media). |
| `rejected` | The entry or file broke a rule; the reason says which. |

Each item also gets a project-link status:

| Link status | Meaning |
|---|---|
| `linked` | Explicit or approved evidence, and the project's hub note exists. |
| `none` | No project evidence. |
| `ambiguous` | Several explicit projects, or only unconfirmed candidates. Nothing is linked. |
| `unmatched` | The named project has no hub note. |
| `unverified` | No `--projects-dir` was given, so nothing can be checked. Nothing is linked. |
| `declined` | The operator approved no link. |

The report holds item ids, statuses, reasons, refs, hashes and project paths. It never holds captions, pointers, file names, paths or image data.

### Blocked plans (damaged records fail closed)

The dry run reads the attachment records exactly as the store does when it opens (`scanAttachmentRecords`), without changing anything. A record is **damaged** when:

- its file cannot be read (`unreadable`);
- it is not JSON (`not-json`);
- it lacks the fields of a record (`not-an-attachment-record`);
- its photo file is missing (`photo-file-missing`), cannot be checked (`photo-file-unreadable`) or has the wrong size (`photo-file-wrong-size`).

ORBIT skips a damaged record and never deletes it. The importer cannot know what bytes a damaged record holds: it may be the very photo an item would store a second time. So a damaged record **blocks the plan**. The same happens when the attachment directory cannot be listed, or when the import ledger is unreadable or has entries that break its contract.

- **Dry run:** exits 2 with `refused: true, changed: false` and a `blocked` section. The plan is still listed for orientation, but its `planSha256` is `null`, so there is no digest anyone could approve.
- **Apply:** refuses the same way, whatever digest it is given, and imports nothing.
- **Diagnostics:** `blocked.attachmentRecords` lists each damaged record's file name (an opaque `a<32 hex>.json` id) with a fixed reason code. The ledger and directory problems use fixed text too. Nothing read from a damaged file is ever quoted: no caption, path or parser message.
- **What to do (ORBIT stopped):** look at each named record and its photo file (`<state>/attachments/<id>.json` and `<id>.jpg`). Restore both from a backup, or move both out of the state directory to keep them. Then run the dry run again and review the new plan.

### Apply, retry and reversal

- **Apply** needs `--apply --reviewed-plan-sha256 <planSha256> --orbit-stopped`, and the process must own the state directory. The dry run prints `planSha256`, a digest of exactly what apply would do: the manifest's and the approvals file's SHA-256 and, for every item, its status, the SHA-256 of the normalized bytes it would store, the photo ref it is (or is already stored as) and its project link. Apply builds the plan again from the files, the approvals and the stores as they are then, and refuses the whole run, changing nothing, unless that digest is the reviewed one. So a photo swapped in the bundle, a different approvals file or a store that changed since the review never goes through unreviewed: run the dry run again and review it. (`--reviewed-manifest-sha256 <manifestSha256>` is still accepted as an extra check; on its own it no longer applies anything.) Each file is then read and normalized once more, and must still match the reviewed hash; a file changed during the run fails that item. The attachment (bound, 0600) is written first, then the ledger entry. A crash between the two leaves an invisible copy, which the next dry run reports as importable ("interrupted import") and the next apply finishes, without a second copy. Every batch has an id `ib_…` in the ledger.
- **Retry:** apply again (after a new dry run and review: the stored photos are part of the plan, so the earlier digest no longer matches). Already-imported items are skipped. One run at a time per state directory, enforced by the lock file `<state>/photo-imports/.import.lock`. A stale lock is reported, never broken automatically.
- **Duplicates already stored twice.** If an imported photo is later sent again in a conversation, the same bytes are stored twice (an `import` copy and a conversation copy). The importer always counts the imported copy first, then the lowest id, whatever order the store lists them in, so the dry run and apply agree and a rerun reports the item as `already-imported`.
- **The ledger is never rewritten while damaged.** If the ledger file is unreadable, or some of its entries break the contract (they are not served, and `problem` says how many), every change is refused and the file is left for the operator to look at, so no entry is lost by a rewrite.
- **Reports never claim less than happened.** A refusal (exit 2, `"changed": false`) means nothing was written. An unexpected error after apply or revert started writing is reported as `"failed": true, "changed": "unknown"` (exit 1). A revert that hides the batch but cannot remove some stored files reports them in `removeFailed` (exit 1), with the file system's error code (never a path). The photos are already hidden.
- **Reverse:** `--revert <ib_…> --orbit-stopped`. One ledger write hides the batch: its photo entries and links are removed, including links it added to native photos. The same write records the stored copies to delete on the batch as `unremoved` (only `import`-scope copies that no other entry uses). Each copy is then removed through the store. Only removed files count in `filesRemoved`; copies that were already gone count in `filesAlreadyGone`. An unlink error other than "not found" is never counted as removed. If the photo file cannot be removed after its record was, the record is written back. The batch then keeps exactly the copies that failed in `unremoved`. **Run the same `--revert` again** once the cause is fixed: it retries only those, in this run or in a later process. A copy whose record is damaged is left for the operator and reported. The batch is marked `reverted` by the first ledger write, at once. While its `unremoved` list is not empty, reverting it again retries exactly those copies; once the list is empty, a further revert is a no-op. Observations saved about reverted photos stay in the observation store but are never served, because their photo is gone. Their vectors are pruned by the semantic index's own maintenance. The export bundle is never modified at any point.

## Staging (host-local): JPEG/PNG to compliant JPEG

`tools/photo-import/stage.ts` makes a **new** export bundle that the importer can take. The original bundle is only read.

**Dependency.** ImageMagick: `magick` (version 7) or `convert` (version 6), found on the PATH or given with `--magick <path>`. It is the operator's to install, for example `sudo apt-get install imagemagick` on Debian or Ubuntu. The tool never installs anything. Without ImageMagick it refuses (exit 2) and writes nothing. The tests ran with ImageMagick 6.9.12 on a development machine, not on the ORBIT host.

**What it does, per item (manifest order):**

- **Copied unchanged:** a JPEG that already passes ORBIT's upload check and has no EXIF rotation. The importer then stores exactly what it would have stored from the original, so duplicate detection is unchanged.
- **Converted:** any other JPEG or PNG. The coder is named explicitly from the file's own signature, and only the first frame is read. The image is rotated upright from EXIF, transparency is flattened onto white, and it is shrunk (never enlarged) to at most **1600 px on the longest edge** and **2.56 MP**. All metadata is stripped, and it is written as an 8-bit sRGB baseline JPEG at quality 85, then 80, 72, 64, 56 and 48 until it is at most **1 MiB**.
- **Validated:** each staged file must pass `normalizeJpeg` from `src/jpeg.ts`, the same check uploads get, within the same bounds. The report gives `importSha256`, the hash the importer's dry run will show for that item.
- **Failed:** reported with the reason, and **left out** of the staged manifest (listed in `omitted`). Causes are a bad id or path, a missing file, a type other than JPEG/PNG (HEIC, WebP and others are converted by hand), the converter failing (only its exit status is reported, because its messages can contain paths), or a file still over 1 MiB at quality 48.
- **Bounded:** originals over 64 MiB are refused before they are read. The converter refuses images over 20,000 px on a side, has memory, disk and time limits, and is stopped after 120 s.

**What it never changes.** The staged manifest is the original with only each staged item's `file` changed, to `photos/<n>.jpg`. Ids, send times, sender, captions, session and message pointers, `projects` and `projectCandidates` are copied exactly, fields in the same order. So provenance is unchanged and no project link is added or guessed. The importer still judges every item: a non-owner item is staged but then rejected by the importer's dry run. `--out` must be a new or empty directory outside the original bundle. Files are written atomically with mode 0600 (directories 0700, including an existing empty `--out`, which is set to 0700), the manifest last. The report (stdout and `staging-report.json`) holds item ids, statuses, reasons, sizes and hashes, never captions, pointers, file names or paths. Exit codes: 0 every item staged, 1 some omitted, 2 refused.

Approvals are bound to the manifest that was reviewed. Make them from the **staged** bundle's dry run, whose `manifestSha256` is the staged manifest's.

### Operator commands: stage and dry run (ORBIT may keep running)

```sh
# 1. Stage (as root or the bundle's owner; reads only the original bundle, writes only the new directory).
node /opt/orbit/current/tools/photo-import/stage.ts --export /srv/orbit-import/<name> --out /srv/orbit-import/<name>-staged > stage-report.json
# 2. Dry run the STAGED bundle (as ORBIT's service user, see orbit_tool below; changes nothing).
orbit_tool tools/photo-import/import.ts --export /srv/orbit-import/<name>-staged --state /var/lib/orbit --projects-dir <the vault copy>/Projects > import-dry-run.json
```

These are templates: they have not been run on the ORBIT host. The staged bundle is created private (0700/0600). Make it readable to the importer the same way as the original bundle (see the runbook below). Then check `stage-report.json` (`counts`, `omitted`) and the dry run (`counts`, and every `missing`, `rejected`, `ambiguous`, `unmatched` and `unverified` item), as in runbook step 2. If the dry run exits 2 with `blocked`, see [Blocked plans](#blocked-plans-damaged-records-fail-closed). Apply and verification are the separate reviewed steps 3–5 below. Never apply straight from staging.

## Backfill

**Selection.** It looks at every photo the Assistant can reach (imports included; archived threads only with `--include-archived`), newest first, and skips:

- photos with any **forgotten** record (Rai asked ORBIT to forget what it knew);
- photos with an active **correction** for the current version (Rai's statement stands);
- photos that already have a usable active model observation for the current version;
- photos whose stored file is missing;
- photo versions whose bounded attempts are used up (`gave-up`).

Existing records are never changed or superseded.

**Capability gate.** Before any image is read, the run asks the model's own capability resolver (`ModelPort.images()`, the check every photo turn uses, including the operator declaration file `ORBIT_MODEL_CAPABILITIES` and the bundled registry). If the answer is not supported, the run stops, saying why: no photo read or sent, nothing saved, no configuration changed. It asks again before every photo. The tool builds the primary model as `src/main.ts` does, **without** the OpenRouter fallback wrapper, and refuses any answer marked as from a fallback. When the current assistant route's image support is unverified (the resolver says `unknown`), the backfill is blocked until the operator verifies the route and declares it in the operator file (`docs/photos.md`, "Model capability"). The tool never does that itself.

**What is sent.** For each photo: one user message with a fixed prompt (`BACKFILL_PROMPT`) and the stored, integrity-checked JPEG as image input. No caption, title, conversation text or earlier observation is sent, so a description can never come from a caption. The answer must be the JSON `{observations, limitations}`, or `{cannotSee}`. Anything else saves nothing.

**Bounds.**

| Bound | Default | Limits |
|---|---|---|
| Photos per run (`--limit`) | 10 | at most 200 |
| Gap between model calls (`--interval-ms`) | 5000 ms | at least 1000 ms |
| Attempts per photo version (`--attempts`) | 3 | at most 3 |

The run also stops after 3 consecutive provider failures. One run at a time: `<state>/photo-backfill/.backfill.lock`. Options are checked before the lock is taken, so a bad value never leaves it behind, and a lock held by another run is a JSON refusal (exit 2).

**Exit codes and reports.** Exit 0 done; 1 stopped, some photos failed, or an unexpected error after the run began; 2 refused. A refusal says `read: 0, sent: 0, saved: 0`, and only happens before any photo is read. An unexpected error later (for example a checkpoint write failing) is reported as `"failed": true` with the counts of photos read, sent to the model and saved before it, so the operator knows what was sent. The model is stopped however the run ends.

**Checkpoint.** `<state>/photo-backfill/checkpoint.json` is written atomically after every photo, with its status, attempts, reason (provider text redacted), observation id and index status. Ctrl-C or SIGTERM stops after the current photo, and a rerun resumes.

**Two statuses per photo:**

- **Observation:** `saved`, `skipped` (forgotten, corrected, already-observed or version-changed at save time), `model-refused`, `failed` or `unavailable`. A saved observation is keyword-searchable in the gallery at once.
- **Index** (semantic vector): `indexed`, `pending` (embedded at the next search when semantic search is on), `not-configured`, `error` with the reason, or `outside-search-window` (older than the newest 500 photos search covers). An indexing error never undoes an observation. `--index-only` retries indexing without any model call or image read.

The report lists refs, statuses, reasons and counts. It never carries observation text or image data.

## Runbook (host-local): dry run → owner review → apply → verify

The commands below are **templates; none has been run on the ORBIT host.** ORBIT's unit uses `DynamicUser=yes` and `StateDirectory=orbit`, so the tools must run as that unit's user with its environment and credentials. A transient unit with the same settings is the expected way. Check the uid, state ownership and environment it really gets before step 4; the tools refuse to write when the state directory is not owned by their own uid.

```sh
# Run a tool the way orbit.service runs ORBIT (UNVERIFIED template; adjust to the host).
orbit_tool() {
  sudo systemd-run --pipe --wait --quiet \
    -p DynamicUser=yes -p StateDirectory=orbit \
    -p EnvironmentFile=/opt/orbit/orbit.env -p 'ImportCredential=orbit.*' \
    -p WorkingDirectory=/opt/orbit/current -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes \
    -p BindReadOnlyPaths=/srv/orbit-import \
    /usr/local/bin/node "$@"
}
```

1. **Build the bundle (operator, on the host).**
   - Locate the legacy data. The candidates are `~/.openclaw` or `$OPENCLAW_STATE_DIR` (unverified for Rai's install).
   - Extract only photos Rai sent, with their send time, a short caption and opaque session/message ids.
   - Make sure every photo file is a JPEG or PNG on the host. Anything else (HEIC, WebP) is converted to JPEG by hand.
   - Add `projects` only where the legacy message explicitly named the project; put anything weaker in `projectCandidates`.
   - Put the bundle in a root-owned directory such as `/srv/orbit-import/<name>`, readable by the tool. Never in the repository, the vault or a web directory.
   - **Stage it:** `node tools/photo-import/stage.ts --export /srv/orbit-import/<name> --out /srv/orbit-import/<name>-staged` (see [Staging](#staging-host-local-jpegpng-to-compliant-jpeg)). Check `counts` and `omitted`. Keep the original bundle unchanged as the record of what was exported. From here on, `--export` is the **staged** bundle.
2. **Dry run (ORBIT may keep running).** `orbit_tool tools/photo-import/import.ts --export /srv/orbit-import/<name>-staged --state /var/lib/orbit --projects-dir <the vault copy>/Projects > import-dry-run.json`. Check the counts, then every `missing`, `rejected`, `ambiguous`, `unmatched` and `unverified` item. Exit 2 with `blocked` means a damaged record or ledger. Deal with it first ([Blocked plans](#blocked-plans-damaged-records-fail-closed)); there is no `planSha256` to approve until then.
3. **Owner review.** Rai reviews the dry run: what will be imported, which links will be made and which ambiguous ones need a decision. Record the decisions in an approvals file with the dry run's `manifestSha256`. Run the dry run again with `--approvals <file>` until it shows exactly what Rai approved, and keep that dry run's `planSha256`: it is what Rai approved. If anything changes afterwards (a photo, the approvals, or a photo sent to ORBIT in the meantime), apply refuses; run the dry run again (with ORBIT stopped, if photos may still be arriving) and review it.
4. **Apply (ORBIT stopped).**
   - `sudo systemctl stop orbit`
   - `orbit_tool tools/photo-import/import.ts --export … --state /var/lib/orbit --projects-dir … --approvals … --apply --reviewed-plan-sha256 <planSha256 of the reviewed dry run> --orbit-stopped > import-apply.json`
   - Keep the batch id from the report.
   - `sudo systemctl start orbit`
5. **Verify the import** (see the checklist below). If anything is wrong: stop ORBIT, run `--revert <batch> --orbit-stopped`, then start ORBIT. If the revert exits 1 with `removeFailed`, the photos are already hidden. Fix the cause the error code names, then run the same revert again before starting ORBIT.
6. **Backfill dry run (ORBIT stopped):** `orbit_tool tools/photo-backfill/backfill.ts --state /var/lib/orbit --orbit-stopped`. Confirm `capability.ok` is true. If it is false, stop here: verify the route and declare it in the operator capability file first (`docs/photos.md`). Never switch models or enable the paid fallback for this.
7. **Backfill in small batches (ORBIT stopped).** `… --orbit-stopped --apply --limit 10 [--index]`, then start ORBIT and spot-check before the next batch. Each photo is one model call on the primary route, which may count against its usage limits. `--index` uses the embeddings credential and its daily budget (`docs/photo-semantic-search.md`). Stopping ORBIT for each batch costs downtime: about `limit × interval` plus model time (around a minute for 10 photos).
8. **Verify the backfill** (checklist below).

### Manual verification checklist (after each step, in ORBIT's page)

- **Gallery visibility.** Open Images → gallery. Imported photos appear under their legacy dates. The detail says "Imported from OpenClaw (legacy assistant)", "Sent (legacy)", "Imported", "Legacy item", and that the photo is not a message sent in ORBIT. There is no "Open conversation" link. The image loads.
- **Isolation.** In a chat session, ask "show me photos I uploaded" for the legacy dates. No imported photo is listed; they are reachable only from the Assistant and the gallery.
- **Project links.** A photo imported with explicit or approved evidence shows a read-only **Projects** section with the project name and why it is linked. Ambiguous ones show none. The project's note in the vault is unchanged (check `git status` of the vault copy).
- **Search by new description.** Pick a backfilled photo and read its saved observation in the detail ("described by the operator backfill · model …"). Search the gallery for two words from that observation that are not in its caption or title. The photo is found, and the match note says "matched AI observation".
- **Forgotten and corrected photos** have no new backfill observation.
- **Index status.** With semantic search on, a backfilled photo is also found by a paraphrase of its description once its index status is `indexed`, or after the first search embeds a `pending` one.
- **Reversal (test install only, never with production data).** Revert a test batch. Its photos and links disappear from the gallery, and native photos are unchanged.

## Gaps and assumptions

- **Unverified:** OpenClaw's on-disk format for Rai's install, whether legacy media still exist, how projects were referenced, and the systemd-run invocation and permissions on the host.
- **Conversion is a separate, host-local step.** ORBIT itself has no image decoder (pure TypeScript, no native libraries), so the importer still rejects non-JPEG or oversize files. The staging helper converts JPEG and PNG with ImageMagick, which the operator installs. HEIC, WebP and other formats are converted by hand. A converted photo is a re-encoding: it is not byte-identical to any copy of the same photo sent natively in ORBIT, so it is not detected as a duplicate of one (duplicates are exact-byte only, as below).
- **Imported captions are not search evidence yet.** They are displayed and kept, but adding them to `collectEvidence` changes the search corpus, so that was left for coordination with the photo-search ranking work. Imported photos are searchable through their import title and through backfilled observations.
- **ORBIT must be stopped** for apply, revert and the backfill, because the attachment, thread and Assistant stores have no cross-process lock and the server reads the attachment store only at start.
- **Rate limits are ORBIT-side only.** The provider's own limits still apply, and the backfill stops after three consecutive failures.
- **Ledger size.** Every imported item and every link rewrites the whole ledger file, which is capped at 8 MiB (`LEDGER_BYTES_MAX`). An entry is roughly 0.3 to 0.9 KiB, so the ledger holds very roughly 9,000 to 25,000 imported photos in total; past that, each item fails with "would exceed its size bound" and nothing is lost. Large batches also rewrite a file of several MiB many times. Import in batches of hundreds, not tens of thousands, until the writes are batched.
- **Reverting one batch removes its links even if a later batch asked for the same link.** Links are recorded once, by the batch that first made them. If batch B asked for a link batch A already made, reverting A removes it; re-run B's dry run and apply to restore it.
- **`--orbit-stopped` is the operator's statement.** The tools do not check that the service is down (they cannot tell a stopped ORBIT from one on another port or host). Stop it first, as the runbook says.
- **Duplicates are exact-byte only** (after normalization). The same photo re-encoded differently is not recognized as a duplicate. Visual similarity is never used, for duplicates or for projects.

## Tests

- `test/photo-import.test.ts`:
  - dry-run classification of every status and link case;
  - path traversal, symlink escape, URL, type, oversize and corrupt refusals;
  - nothing changed, no private text in the report;
  - apply through the real server's gallery: provenance, legacy time and caption, the read-only project link, metadata stripped, 0600 files, chat isolation, image route;
  - retries and an interrupted import; approvals bound to the manifest; reversal;
  - malformed manifests; the CLI's refusals; the page helpers;
  - apply refusing a swapped photo or a different approvals file after the reviewed dry run (the plan digest), and applying exactly the reviewed plan;
  - the imported copy chosen among duplicates whatever the store's order; a ledger with broken entries refusing to be rewritten;
  - revert on the **real store** (real unlink errors from the file system): failures reported with the error code and never counted as removed, the record written back when the photo file cannot be removed, the failed copies kept on the batch, and retries that finish them, in the same process and in a new CLI process;
  - damaged attachment records of every kind and a damaged ledger: the dry run and apply both refuse (exit 2, no `planSha256`) with the same safe diagnostics, without quoting the files; the read-only scan and the store agree; once the records are moved aside, the reviewed plan applies.
- `test/photo-import-stage.test.ts` (runs the real ImageMagick; skipped, saying so, where it is not installed):
  - JPEG and PNG originals (oversize, EXIF-rotated, transparent, small) staged to compliant copies, with exact copies for compliant JPEGs;
  - failures (HEIC, missing, path escape, bad id) reported and omitted;
  - provenance and project fields unchanged and the original bundle untouched;
  - no private text in the report;
  - the importer's real dry run on the staged bundle: every staged item importable with the predicted hash, the explicit link made and the candidate not linked;
  - the size ladder and its failure; refusals that write nothing.
- `test/photo-backfill.test.ts`:
  - a blocked vision route reads and sends nothing;
  - selection skips forgotten, corrected and observed photos and includes imported ones;
  - the prompt carries no caption;
  - provenance, gallery display and keyword search by the new description;
  - chat isolation of operator records;
  - interrupted reruns and idempotent saves;
  - provider failures with bounded attempts; malformed, refused and fallback answers;
  - an embedding failure keeps the observation, then `--index-only` succeeds;
  - the CLI refuses without `--orbit-stopped` and sends nothing without a model;
  - a bad option leaves no lock behind, and a held lock is a JSON refusal;
  - an error mid-run still counts what was read, sent and saved.
