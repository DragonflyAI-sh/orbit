# Research bootstrap audit (static, read-only)

ORBIT job `orbit-202611190517-zfhe`, 2026-11-19. This is a documentation-only audit. It changes no runtime code, routine prompt, permission, environment or configuration, and it does not resolve the refusal described below.

**Audited source:** `DragonflyAI-sh/orbit` at `dd13462f1fb29f54d6107bb88436e37f62b6596f` (main at the time of the audit). Line numbers below are at that commit unless another commit is named. Permalink form: `https://github.com/DragonflyAI-sh/orbit/blob/dd13462f1fb29f54d6107bb88436e37f62b6596f/<path>#L<n>`.

**Method:** reading source and git history only. Nothing was executed against ORBIT's production job API, no artifact was downloaded with job credentials, the refused command was not run, and no research job was launched. The runner tool was not executed, not even locally: the tests that run it were left out of the validation run (see [Validation](#validation)).

**Incident under review (relayed by Rai; not independently verified):** in the session for research job `research-202611190345-crtv`, the routine's step 2 downloaded `~/.local/bin/orbit-research` from `GET /v1/jobs/<job-id>/tool`, the sha256 matched, and the session's auto-mode permission check then refused step 3 (`orbit-research start`) with the reason "Undermining Oversight". The runner did not inspect or execute the file. The exact redacted command and the full served digest are not available to this audit, and neither is reconstructed here as evidence. PR #138 (observability) is related, does not resolve the refusal, and is not duplicated here.

**Bottom line.** Reading the source, `orbit-research start` does what the routine says it does, plus two things the prompt itself does not mention: it writes the token to disk, and it records a `started` event. It never runs shell code taken from the network, contacts only the API host it is given, never follows redirects, never turns off TLS verification, and keeps the token out of process arguments. This audit found no code defect that explains the refusal. **The external classifier's cause remains unknown.** Which exact bytes were served to that job is **inferred with medium confidence, not verified** (see [Artifact provenance](#1-artifact-provenance)).

## 1. Artifact provenance

### Where things are

| Item | Location (at `dd13462`) | What it does |
| --- | --- | --- |
| Routine definition (reference copy) | `deploy/routines/orbit-research.md:38-91` (Prompt), steps at `:47`, `:48-86`, `:87`, `:88` | Step 1 validates the fire text. Step 2 downloads and checks the digest. Step 3 runs `start`. Step 4 runs `guide`. The live prompt is stored on claude.ai, and the file says a merged change does not update it (`:125`). |
| Tool source | `tools/orbit-research/orbit-research` (bash, 318 lines, mode 100755) | There is no build or packaging step: the file is served as it is in the release. |
| Tool load and digest | `src/research.ts:333-342` (`RESEARCH_TOOL_PATH`, `loadResearchTool`) | Reads the file **once at process start** from the release directory (`new URL("..", import.meta.url)`), decodes it as UTF-8 and computes `sha256` over that text. |
| Load site | `src/main.ts:139`, passed to the listener at `src/main.ts:150` | Loaded once at startup. A file changed on disk afterwards is not picked up until a restart. |
| Serving endpoint | `src/ingress.ts:51-77` | `GET /v1/jobs/<id>/tool`: one-job bearer token (`:54-56`), rate limit (`:57`), research jobs only (`:65`), 503 if no tool (`:72`). It records `toolServed` (`:74`) and answers `200 text/plain` with an `x-orbit-sha256` header (`:75-76`). |
| Fire text (digest and commit pinning) | `src/job-launch.ts:146-151` | The fire text is `Lane: research / Job id / API / Token / Tool commit: <ORBIT_COMMIT> / Tool sha256: <sha256 of the loaded text>`. `toolCommitSent` is recorded on the job (`:151`). |
| Commit source | `src/main.ts:50` (`ORBIT_COMMIT`), normalised by `src/job-launch.ts:21-25` | `ORBIT_COMMIT` comes from the release's `release.env`. |
| Release build | `deploy/pull-deploy.sh:300-325`, `deploy/systemd/orbit.service:7-12` | The deploy takes the tip of origin/main once its `checks` run has passed, unpacks it with `git archive <sha> \| tar -x` into `/opt/orbit/releases/<sha>`, writes `COMMIT` and `ORBIT_COMMIT=<sha>` into `release.env`, then switches the `current` symlink and restarts. The service runs `node src/main.ts` in `/opt/orbit/current`. |
| Served-tool evidence | `src/jobs.ts:316-320` (`toolServed`: first and last time, count, sha256), shown in `src/job-detail.ts:333` (the first 12 hex digits) | Proves that ORBIT answered a download. It does not prove the runner received the file intact or ran it. |
| Dispatch snapshot | `src/job-inputs.ts:15-70` (from #129, `4a2485f`) | Keeps the fire text with the token replaced by a label, so the `Tool commit` and `Tool sha256` lines are kept. |

**How a job is pinned.** A job is pinned **only by the digest**, not by the commit. The digest the runner checks is computed from the file the running process loaded. The commit line is ORBIT's `ORBIT_COMMIT`. The runner has no checkout, so it cannot check that the bytes belong to that commit. `start` only forwards the commit back to ORBIT in its `started` event (`tools/orbit-research/orbit-research:157,163,171,189`; ORBIT records it as "runner reported", `src/job-detail.ts:243`).

### Historical candidates

Only two versions of the tool file exist in history:

| Introduced by | Blob | sha256 prefix (first 12) | In effect on main |
| --- | --- | --- | --- |
| `a7929d2cfda4f7541497c41132e3466b8492457d` (#104, 2026-11-16T22:20Z) | `b681526d5a33ba80751934c7f2bd4730a6723f31` | `878ecc9e9ba2` | until `7d24ba5` |
| `7d24ba57e0b77ce344d2f2eff0da10c8ca4924ea` (#136, 2026-11-19T03:04:56Z) | `25494b19c78a8dd27fc11346be46cd6a27b6b04b` | `22f485f9ca83` | from `7d24ba5` through `dd13462` (unchanged by #137 to #140) |

To get the full digest of each version (it has no secret in it), run `git show <commit>:tools/orbit-research/orbit-research | sha256sum`. ORBIT hashes the UTF-8-decoded text, not the raw bytes. For both versions the file is valid UTF-8, so the digest equals the sha256 of the git blob's bytes. This was checked statically for the current file with Node's `createHash` over `readFileSync(..., "utf8")`: 14,224 bytes either way, and the same digest. No `.gitattributes` exists, so `git archive` changes neither file. The only difference between the versions is in `call()` (bounded GET retries, `--connect-timeout`, a `last-error` record) and in the messages that use it (`git diff a7929d2 7d24ba5 -- tools/orbit-research/orbit-research`). Neither version runs anything new. Both have `TOOL_VERSION=1`, so `--version` cannot tell them apart.

### Which bytes were served to `research-202611190345-crtv` (inference)

- The job id's stamp comes from `new Date().toISOString()` (`src/job-launch.ts:133-134`), so `202611190345` means **2026-11-19 03:45 UTC**.
- Commits on main by then: `7d24ba5` (#136, 03:04:56Z) and `45373c7` (#137, 03:08:31Z). The next commit, `36f2013` (#138), came later (04:50:50Z).
- The relayed record says "tool served once". The `toolServed` record and the "Runner tool sent" stage first appear in `7d24ba5` (`git log -S"toolServed(" -- src/jobs.ts src/ingress.ts`). If that relayed fact came from ORBIT's record, the running release was `7d24ba5` or later. Since the job was launched before `36f2013` existed, the release was `7d24ba5` or `45373c7`.
- Both commits have the same tool blob (`25494b1…`), whose sha256 starts `22f485f9ca83`.

**Confidence: medium.** This depends on several things this audit did not check: (a) the relayed "tool served once" came from the `toolServed` record; (b) the running release was built by `pull-deploy.sh` from an unmodified commit and not edited by hand. The drill mode at `deploy/pull-deploy.sh:193-197` copies a release under another `COMMIT` while `release.env` keeps the known-good commit; (c) the process had been restarted onto that release. **This is not an exact audit of the bytes served.** The nonsecret evidence that would settle it is in production, which was not read (owner only):

1. the job record's `research.toolServed.sha256` (full value) and its `launch.toolCommitSent`;
2. the job's dispatch snapshot fire text: the `Tool commit` and `Tool sha256` lines (the token is already redacted);
3. which release was live at 03:45Z: `/opt/orbit/state` deploy record and history, or `/status` logs;
4. the step 2 `ok:` line from the session transcript. If the saved prompt was the pre-#136 one, the output looks different, and whether the saved prompt was updated is itself unknown (`deploy/routines/orbit-research.md:125`).

If (1) or (2) shows a digest starting `22f485f9ca83`, the served bytes are the `25494b1` blob, and the static trace below applies to them exactly. If it shows `878ecc9e9ba2`, they are the older blob, and the trace still holds apart from the retry and timeout details of `call()`.

## 2. Static trace of `start` and what it calls

The file is `tools/orbit-research/orbit-research` at blob `25494b1` (unchanged from `7d24ba5` to `dd13462`). Step 3 runs it as `ORBIT_RESEARCH_TOKEN='<token>' ~/.local/bin/orbit-research start --job <id> --api <API> --tool-commit <commit>` (`deploy/routines/orbit-research.md:87`).

### Behaviour and data flow

| # | Step (lines) | Reads | Writes / sends | Notes |
| --- | --- | --- | --- | --- |
| 0 | Shell setup (`:16-24`) | env `ORBIT_RESEARCH_HOME` (state root, default `~/.orbit-research`) | none | `set -uo pipefail` (no `-e`). It checks that `python3` and `curl` exist (`command -v`). It runs nothing else at load time. |
| 1 | Options (`:157-166`) | env `ORBIT_RESEARCH_TOKEN`, `ORBIT_JOB_TOOL_COMMIT`, argv | none | `--api` loses a trailing `/`. An unknown option stops the tool. |
| 2 | Validation (`:167-171`) | none | none | The job id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. The API must match the glob `https://*`, or be exactly `http://127.0.0.1[:port]` for tests. The token must be non-empty, and its format is not checked. A commit that is not 40 hex becomes `unknown`. |
| 3 | State and credential persistence (`:172-174`) | none | `mkdir -p $STATE_ROOT/<job>/{steer,replies}`, then `chmod 700` on the root and the job directory. **The token is written to `<job>/token` (0600)**, the API to `<job>/api` (0600), and the id to `$STATE_ROOT/current` (default umask). | The token stays on disk after the job. Nothing deletes it. It stops being valid after 3 h, or once the job is done, blocked or failed (`src/jobs.ts:143,193-199`). |
| 4 | `load` (`:28-35`) | `current`, `api`, `token` | none | The id from `current` is validated again. |
| 5 | `call GET /v1/jobs/<id>/brief` (`:44-75`) | `TOKEN`, `API` | Temp body `mktemp` (in `$TMPDIR`, 0600, deleted). Auth header file `<job>/auth.XXXXXX` (umask 077), written by the `printf` builtin and deleted after the loop. curl's stderr goes to `<job>/api.err`, which is kept. **Network:** `GET <API>/v1/jobs/<id>/brief` with `Authorization: Bearer` from `-H @file`. | No `-L` (redirects are not followed; a 3xx goes back as `return 22`). No `-k` or `--insecure`. `--connect-timeout 10 -m 30`. GETs are tried at most 3 times, only after a transport failure, 429 or 5xx. A 401/403 or a certificate failure is never retried. curl does honour `~/.curlrc` (no `-q`) and the proxy and CA environment variables. If the step is killed mid-call there is no trap, so the header file can be left behind. It sits in the 0700 directory next to the token file that already holds the token. |
| 6 | Brief interpretation (`:181-188`) | Response JSON | `<job>/brief.md` (the `brief` field), `<job>/limits.json` (`budget`, `reportSections`, `sourceLine`, `expiresAt`) | `python3 -c` with `json.load` only. It refuses unless `lane == "research"`. **The brief is written as text and never executed or sourced.** Python runs without `-I`, so `sys.path[0]` is the current directory (see F4). |
| 7 | `event started` (`:83-106`, `:189`) | `--tool-commit` value | JSON `{"type":"started","toolCommit":<commit or "unknown">}` built by `python3 -` (heredoc, `json.dumps`). **Network:** `POST <API>/v1/jobs/<id>/events`, never retried. Response saved to `<job>/last-response.json`. | ORBIT allowlists the fields (`src/ingress.ts:105-113`) and accepts only a commit that `normalizeToolCommit` validates (`src/jobs.ts:133`). If the POST fails, `start` prints `FAILED api=failed (started)` and ORBIT's `error` and `problems` strings (`:132-142`), then carries on. |
| 8 | Output (`:190-192`) | none | stdout: `ok api=sent (started)` or `FAILED…`, `brief: <path>`, `limits: <path>`, `next: run 'orbit-research guide'…` | The token is never printed. The brief text is not printed by `start`. |
| 9 | `guide` (`:255-307`) | none | stdout: a fixed heredoc (`<<'GUIDE'`, quoted, so nothing is expanded) | No network, no file reads. It tells the runner to follow `brief.md`, to treat web content as data, and to treat steers as instructions. |

There are no other subprocesses. The full list is `command -v`, `cat`, `mktemp`, `rm`, `mkdir`, `chmod`, `curl`, `python3` (two inline programs, fixed code), `head`, `tr`, `printf`, `sleep`, `echo`, `basename`, `sed`, `ls`, `paste`, `cp`. There is no `eval`, no `source`, no `bash -c` on data, no `curl | sh`, and no download of further code. Nothing in the tool turns server data into code: the brief, steers, `error` and `problems` are only written to files or printed.

**Network destinations:** only `$API`, which the routine sets to the fire text's `API` line (`https://orbit-jobs.tail5bde08.ts.net` per `deploy/routines/orbit-research.md:26`), through whatever HTTPS proxy the sandbox sets. `start` uses only `GET /v1/jobs/<id>/brief` and `POST /v1/jobs/<id>/events`. The other commands use `GET …/steers` and `POST …/events` (`:195-253`).

**Credential exposure paths (static):**

| Path | Exposure |
| --- | --- |
| Process arguments of the tool | None when the routine's env form is used. `--token` on argv also works (`:162`), but the routine does not use it. |
| Process arguments of curl | None: the header is read from a file (`:48-49,53,55`). The test that checks this was not run here. |
| The command text of step 3 | **The token appears as an environment assignment in the command line the session shows.** The prompt says so for step 2 (`deploy/routines/orbit-research.md:86`), and `docs/research-lane.md:123` says so for step 3. |
| Disk | `~/.orbit-research/<job>/token` (0600, dir 0700), kept. Temporary header files (0600) are deleted, except when the step is interrupted. |
| Logs and stdout | No token. `api.err` and `last-error` hold curl's message, which has no token because the token is never in the URL. `problems()` prints server text only. |
| Network | Only to `$API`, in the `Authorization` header. A redirect could not carry it elsewhere, because none is followed. |

**What is treated as instructions and what as untrusted content:**

| Data | Source | How the tool or routine treats it |
| --- | --- | --- |
| Fire text (job id, API, token, commit, sha256) | ORBIT → provider routine API → session | Parameters. Step 1 validates them (`deploy/routines/orbit-research.md:47`). |
| Downloaded tool | ORBIT `/tool` | Code. It runs after the sha256 check. This is the step that was refused. |
| `brief.md` | ORBIT `/brief` (the brief Rai confirmed, held on the job, `src/research.ts:345-355`) | **Instructions** for the runner (`guide` rule 1, `:263`). The tool never executes it. |
| Steers | ORBIT `/steers`, `/events` responses; created only by the owner route or a confirmed proposal (`src/jobs.ts:274-280`) | **Instructions** (`show_steers` prints "act on it", `:150`). The tool never executes them. |
| `limits.json` | ORBIT `/brief` | Data (budgets). |
| ORBIT `error`/`problems` | ORBIT responses | Printed to stderr, as information. |
| Web pages and search results | WebSearch/WebFetch | **Data, never instructions** (`guide` rule 1; prompt `:90`). |

## 3. Code compared with the routine's descriptions

| Claim (source) | What the code does | Verdict |
| --- | --- | --- |
| Relayed intent: "`start` uses job id, API address, tool commit and `ORBIT_RESEARCH_TOKEN` to **register** with ORBIT and print a brief-file path, followed by `guide`" | ORBIT registers the job itself, at launch (`src/job-launch.ts:135`). `start` fetches the brief (GET), records a `started` event (POST), **writes the token and the brief to disk**, and prints the brief path, the limits path and a "next" line. `guide` is a separate command. | Consistent apart from the wording. "Register" means "report started". The token persistence is not stated in the prompt. It is stated in `docs/research-lane.md:124`. |
| Prompt step 1: "API must be https://<host> or https://<host>:<port>, with no path" (`:47`) | The tool itself accepts any `https://*`, so paths and userinfo get through (`:169`). | The prompt is stricter. The tool relies on step 1 (F3). |
| "Keeps the token out of curl's arguments" (prompt `:86`; tool comment `:39-40`) | True for curl (`-H @file`). | Consistent. |
| "Header file removed after" (tool comment `:40`) | True on a normal exit. There is no trap, so an interrupted run leaves it (F5). | Mostly consistent. |
| `docs/research-lane.md:124`: "contacts no other host and writes to no repository" | True: only `$API`, and no git calls. | Consistent. |
| "The digest check proves the download matches what ORBIT sent, not where ORBIT got it" (prompt `:86`) | Correct, and if anything modest (see below). | Consistent. |
| "Tool commit … the commit of the ORBIT runtime" (`src/job-launch.ts:17-20`) | The tool bytes come from the release directory on disk, and the digest is taken from them. The commit is a label that the runner can neither check nor bind to those bytes. | Consistent with the code, but the commit is no proof of what the runner ran (F2). |

### What the checksum check proves and does not prove

**It proves:** the bytes installed in `~/.local/bin/orbit-research` are the same bytes whose sha256 ORBIT put in the fire text (with the usual sha256 collision assumptions). That rules out truncation, corruption, and any change on the `/tool` download path by a party that cannot also change the fire text.

**It does not prove:**
- that the bytes are the reviewed git blob at the `Tool commit` named in the fire text. ORBIT hashes whatever file it loaded from its release directory, and the runner has no checkout to compare against;
- that the bytes are safe or behave as the routine describes. That question can only be answered by reviewing the file, for example with section 2 above for blob `25494b1`;
- anything independent of ORBIT. The digest and the file both come from ORBIT, and both reach the session through the provider: the fire text through the routine API, the file over HTTPS through the sandbox's proxy. Anyone who controls the ORBIT host, its release directory, or both channels controls both values;
- that the file was unchanged when step 3 ran, since another step in the same session could have changed it;
- anything about why the session's permission check refused step 3.

## 4. Findings

Severity is about the code and the documentation, not the refusal. No finding is established as the cause of the refusal.

| ID | Severity | Finding | Evidence | Kind | Recommended follow-up |
| --- | --- | --- | --- | --- | --- |
| F1 | Medium (provenance) | The exact served artifact for `research-202611190345-crtv` cannot be identified from the repository. It is inferred as blob `25494b1` (sha256 `22f485f9ca83…`), with medium confidence. | §1: timeline, two candidate blobs, `toolServed` introduced in `7d24ba5`. | Inference | The owner reads the job's `research.toolServed.sha256`, its dispatch snapshot's `Tool commit`/`Tool sha256` lines and the deploy record for 03:45Z (all nonsecret), and compares them with `git show <commit>:tools/orbit-research/orbit-research \| sha256sum`. |
| F2 | Low (design/doc) | The runner cannot check the `Tool commit` line, and it is not bound to the bytes. The digest is computed from the loaded file, not from a git object, and `TOOL_VERSION` is `1` in both versions. | `src/research.ts:335-338`; `src/job-launch.ts:148`; tool `:18`. | Verified | A design decision for Rai (no fix authorised here). Options to review: have ORBIT check at startup that the loaded file's sha256 equals `git show $ORBIT_COMMIT:<path>` (needs the release to carry the blob id), or bump `TOOL_VERSION` on every change. |
| F3 | Low | The tool checks `--api` more loosely (`https://*`, any path, userinfo) than prompt step 1 does. Plain `http://127.0.0.1` is allowed for tests. | tool `:169` against prompt `:47`. | Verified | Optionally match the tool's check to the prompt's (`^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$`). Today step 1 makes up for it. |
| F4 | Low | The inline Python runs without `-I`. `python3 -c` and `python3 -` put the current directory first on `sys.path`, so a `json.py` in the shell's working directory would be imported and run. | tool `:86`, `:110`, `:133`, `:181`. | Inference (needs an attacker-written file in the working directory) | Use `python3 -I` in a later reviewed change. |
| F5 | Low/Info | The token is kept on disk with no cleanup, and an interrupted `call` can leave a 0600 header file behind. `chmod 700` comes after `mkdir -p`, which leaves a short window with umask permissions. | tool `:172-174`, `:48-65`. | Verified | Document it in the prompt, or add a trap and a removal at `report`. This matters little in an ephemeral, single-tenant sandbox, because the token stops working after 3 h or once the job finishes. |
| F6 | Info | The step 3 command text has the token in it as an environment assignment, as the routine intends. The prompt mentions this for step 2 only. | prompt `:86-87`; `docs/research-lane.md:123`. | Verified | None required. Record it as a fact for human review, not as a cause. |
| F7 | Info | curl reads `~/.curlrc` (no `-q`) and the proxy and CA environment variables, in both the step 2 script and the tool. A `.curlrc` with `-k` or `-L` would weaken the TLS and redirect guarantees. In this build sandbox HTTPS goes through a provider proxy with its own CA. Whether the research environment works the same way is not verified. | prompt `:59`; tool `:53,55`. | Inference | Consider `curl -q` in a later reviewed change. Record the research environment's proxy and CA setup in the smoke test. |
| F8 | Info | `start` describes itself as "register" in relayed intent, but it reports `started` and persists state. There is no hidden behaviour beyond what §2 lists. | §3 table. | Verified | Optionally make the prompt's step 3 say what `start` writes and sends. |

**No finding** of: shell execution of network data, a download of further code, any destination other than `$API`, redirect following, a TLS bypass, reading credentials other than the job token, writes outside `$STATE_ROOT`, `$TMPDIR` and `~/.local/bin` (step 2), or the token reaching logs or stdout.

### Verified, inferred, unknown

- **Verified by reading source:** everything in the §2 tables; the two historical blobs and their digests; that ORBIT's UTF-8 digest of the current file equals the raw sha256 of the blob; that `toolServed` and the "Tool sha256" fire-text line were introduced in `7d24ba5` and `a7929d2`.
- **Inferred:** the served bytes for `research-202611190345-crtv` (F1); the Python import path risk (F4); proxy behaviour in the research environment (F7).
- **Unknown:** why the session's permission check refused step 3; the saved routine prompt's exact text; the session's permission mode; the exact refused command; which release was live at 03:45Z; whether the not-started alert was delivered. **The refusal is not resolved by this audit**, and nothing here shows that any code change would change the classifier's decision.

## 5. Owner review checklist (before any later execution)

This is a checklist for a human reviewer. It authorises nothing. This audit found no documented provider mechanism for approving a specific command, so none is assumed.

1. Get the job's nonsecret record: `research.toolServed` (full sha256, count), `launch.toolCommitSent`, and the dispatch snapshot fire text (token redacted). Confirm that `Tool sha256` equals `toolServed.sha256`.
2. Recompute `git show <Tool commit>:tools/orbit-research/orbit-research | sha256sum` and compare. If they differ, stop and find out why the release directory differs from git.
3. Review that blob, or confirm it is `25494b1` and use §2. Look for `eval`, `source`, `bash -c`, `curl | sh`, `-k`, `-L`, any host other than `$API`, and changes to what is written to disk.
4. Compare the saved claude.ai routine prompt, word for word, with `deploy/routines/orbit-research.md` at the commit you expect.
5. Confirm the `ORBIT research` environment's network policy and that it has no secrets or repositories (`deploy/routines/orbit-research.md:5-27`).
6. Decide, on its merits, whether a runner should start from a downloaded, digest-checked script. Any change to how it starts is a design decision. Never reword a command or take another route to get past the check (`docs/research-lane.md:132`).
7. Any later run is a fresh, separately approved job with a fresh id and token. Nothing from `research-202611190345-crtv` is reused.

### Nonsecret details for provider support or human review

- Job: `research-202611190345-crtv`, launched about 2026-11-19 03:45 UTC, research routine `ORBIT research (no repositories)`.
- Refused step: step 3 of the saved prompt. Its reference text is at `deploy/routines/orbit-research.md:87`: `ORBIT_RESEARCH_TOKEN='<token>' ~/.local/bin/orbit-research start --job <id> --api <API> --tool-commit <commit>`. The relayed refusal reason is "Undermining Oversight". The exact command as the session showed it is **not available**.
- The executed file would have been the file installed by step 2 from `GET <API>/v1/jobs/<id>/tool` after its sha256 matched. Probably blob `25494b19c78a8dd27fc11346be46cd6a27b6b04b` of `DragonflyAI-sh/orbit`, sha256 prefix `22f485f9ca83`. This is inferred, not verified.
- What that file does when run, from static reading: it writes state under `~/.orbit-research/<job>/` (including the token, 0600), sends `GET /brief` and `POST /events` to the given ORBIT host only, prints a file path, and does nothing else.
- Still missing, for a human with session access: the exact redacted command and full refusal text, the session's permission mode, and the saved prompt (the same list as `docs/research-lane.md:130`).

## Validation

Before running anything, the entry points were inspected. `package.json` has `typecheck: tsc` and `test: node --test test/*.test.ts`. A grep of `test/` for production hosts found that `orbit-jobs.tail5bde08.ts.net` appears only as a string constant or a validation input (`test/ops-sys*.test.ts`, `test/ops-admin-helper.test.ts`, `test/research-lane.test.ts:166`), never as a connection target. Test servers bind `127.0.0.1`.

**Left out**, because they run the research bootstrap or the runner tool (a local version of the refused workflow, though with synthetic tokens and loopback servers):
- `test/research-bootstrap.test.ts` (whole file, 16 tests). It runs the prompt's step 2 script and `orbit-research start`, `checkin` and `report`.
- `test/research-lane.test.ts`: "end to end (mocked runner side): launch, real orbit-research tool over the real listener, …" downloads, checks the digest of, and runs `start`.
- `test/research-followup.test.ts`: "orbit-research never passes the job token in a process's arguments and leaves no header file behind" runs `start`.

Commands and results:
- `pnpm install --frozen-lockfile` (dev dependencies only): ok.
- `pnpm -s typecheck`: exit 0.
- `node --test --test-skip-pattern="^end to end \(mocked runner side\)|^orbit-research never passes the job token" <all test/*.test.ts except research-bootstrap.test.ts>`: **1852 pass, 0 fail**, exit 0. The two named tests did not run.

**Limitations:** the audit is static. The claims those excluded tests would cover (curl argv, header file cleanup, end-to-end flow) are verified here by reading the code only. Production state, the saved routine, the session transcript and the provider's classifier were not read and could not be.
