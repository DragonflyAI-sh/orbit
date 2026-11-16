# Research lane

ORBIT has two job lanes:

| | Build lane (unchanged) | Research lane (new) |
| --- | --- | --- |
| Routine | `orbit` (`deploy/routines/orbit-jobs.md`) | `research` (`deploy/routines/orbit-research.md`), **not provisioned** |
| Configuration | `ORBIT_ROUTINES`, credential `orbit.routine.<name>`, `ORBIT_ROUTINE_REPOS` | `ORBIT_RESEARCH_ROUTINES`, credential `orbit.research-routine.<name>`, never a project repo |
| Environment | `ORBIT jobs`, network Limited (ORBIT's job host only) | `ORBIT research`, separate; Limited to ORBIT's job host, public web through WebSearch/WebFetch (Full only as a documented fallback) |
| Repositories | `orbit-work` + `orbit` (writable), vault (read-only context) | **none** |
| Chat tools | `job_launch` (proposal) | `research_launch` (proposal) |
| Discover / status / steer | `routines_list`, `jobs_list`, `job_status`, `job_steer` (shared) | same |
| Result | summary, pull request ORBIT opens, review job | one bounded, source-linked report, stored by ORBIT; `research_result` |
| Persistent repository writes | the project repo branch `orbit/<job>`, `orbit-work` control branch | **only** the vault, only by ORBIT, only through `research_save_to_vault` and the existing policy-checked pipeline |

The research lane is **unconfigured** on every ORBIT until an operator creates the routine, environment and credential and the smoke test passes. ORBIT never sends research to the build routine: with the research lane unconfigured or misconfigured, `research_launch` refuses and the launcher refuses a research proposal (409), whatever routine it names.

## Why a separate lane

Briefs that need outside evidence (model ids and prices, vendor docs, comparisons) failed in the build lane because its environment cannot reach the web, and widening that environment would give an internet-facing session write access to ORBIT's code and control repositories. The research lane keeps the two apart: the session that reads the web holds no repository credential, and the sessions that hold repository credentials keep their limited network.

## Lifecycle

1. **Discover.** The owner's model calls `routines_list`: both lanes, configured or not (with the reason), what each can and cannot do, budgets, and how many valid research reports this ORBIT has received (`liveEvidence`; zero means not proven live).
2. **Propose.** `research_launch {question, brief, routine?}` creates a `job_launch` proposal with `lane: "research"`. The card says "Proposed RESEARCH job". Nothing happens until Rai confirms it (`POST /chat/proposals/<id>/confirm`, owner only, single use, work-session link as for builds).
3. **Launch** (`src/job-launch.ts`, `launchResearch`). The launcher decides the lane from configuration, never from the runner: a research routine name goes to the research path, and the proposal's lane must agree (a build card naming a research routine, or a research card naming a build routine, is refused with nothing registered or fired). The research path writes **nothing** to any repository: the brief is held on the job record (`job.research.brief`, at most 20,000 characters), the job is registered with `kind: "research"` in the same write and a token that lives at most 3 hours (build: 24), and the routine is fired with:

   ```text
   Lane: research
   Job id: <id>
   API: <ORBIT_PUBLIC_JOB_URL>
   Token: <one-job token>
   Tool commit: <ORBIT_COMMIT>
   Tool sha256: <sha256 of tools/orbit-research/orbit-research in the running release>
   ```

   It refuses (503, nothing registered) without the job API (`ORBIT_PUBLIC_JOB_URL`: a research job has no git record) or without the runner tool in the release. Build fire text is unchanged and never has a `Lane:` line.
4. **Run.** The runner downloads its tool from ORBIT's job listener (`GET /v1/jobs/<id>/tool`, research jobs only), checks the digest from the fire text, and uses `orbit-research` (`start`, `guide`, `checkin`, `steers`, `reply`, `report`). It reads the brief from `GET /v1/jobs/<id>/brief` (research only; a build job's brief stays in git and this route answers 404 for it). Check-ins, steers and replies use the existing event and steer routes.
5. **Report.** The final `summary` event is the report. The listener refuses (422, nothing recorded) a research summary that is not whole, is longer than 60,000 characters, has a status other than `done`, `blocked` or `failed`, contains secret-shaped text, or, for `done`, is not a valid report (below). The runner fixes it and sends it again.
6. **Store.** `researchCompletion` (`src/research.ts`) runs on the summary: it writes the exact text to `<state>/research/<job>.md` and what it checked to `<job>.json` (mode 0600), records `job.research.report` (valid, problems, sources, digest), and collects isolation evidence: a read-only check that `orbit-work` has no `orbit/<job>` branch and that the job has no PR record. Rai is notified: "report received … runner-reported and unverified; nothing was saved to the vault or launched." A branch found in `orbit-work` is notified as urgent.
7. **Read.** `research_result {id}`: state, report (first 6,000 characters), sources with access dates, checks, isolation, vault state, and a fixed note that the content is untrusted runner-reported data.
8. **Persist (optional, owner-initiated).** `research_save_to_vault {id}` writes the report as a new note at `Resources/orbit-research-<job>.md`. The path is chosen by ORBIT from the job id; the model cannot pass one (an extra argument is refused) and the runner never sees the vault. The note carries front matter (`source: orbit-research`, `verification: runner-reported`, `report_sha256`) and a provenance block, then the report as received, with its sources, access dates, evidence, inference, uncertainties, build handoff and validation. It goes through `vaultEdits.apply("create_note", …)`, the same pipeline as `vault_create_note`: AGENTS.md section 3/4 policy, secret refusal, sensitive-detail confirmation, a Log line in the same commit, push without force, remote head verified; a protected case becomes a proposal card. The result is recorded on the job as `committed` (with the commit), `pending-confirmation` (with the proposal id) or `failed` (with the error), and the tool says "saved" only for `committed`. It refuses a job that is not `done`, a report that was not valid, a stored file whose digest differs from the one ORBIT checked, and a second save.

## Report format

Every section once, in any order; the runner gets the same text from `orbit-research guide`.

```markdown
# <title>
## Question
## Answer
## Evidence        - <claim> [1]   (every claim cites a numbered source)
## Inference       (beyond the sources, marked as inference)
## Uncertainties
## Sources         [1] https://… — accessed YYYY-MM-DD — <title or note>
## Build handoff   (what a build job would change and how to test it, or "None")
## Validation      (exercised versus only read; search and fetch counts)
```

ORBIT checks: the title and all eight sections; at least one and at most 50 sources; each source an http(s) URL without credentials, at most 2,000 characters, not a private, loopback, link-local (metadata), CGNAT/Tailscale, unique-local or internal-name host; a real access date not in the future; unique source numbers; Evidence cites at least one source and only sources that exist; no secret-shaped text; at most 60,000 characters. **Passing means well formed, not true.** ORBIT does not fetch the sources or check that they say what the report claims; everything stays labelled runner-reported. "Validation" separates what the runner exercised from what it read, and ORBIT does not upgrade either to verified.

## Budgets

| Bound | Value | Enforced by |
| --- | --- | --- |
| Report size | 60,000 characters | ORBIT (listener refuses) |
| Sources | 50 | ORBIT (listener refuses) |
| Brief | 20,000 characters | ORBIT (launch refuses) |
| Token lifetime | 3 hours, also when the job id is re-registered | ORBIT |
| Requests | 60 per minute per job | ORBIT (existing listener rate limit) |
| Check-ins and replies | 20,000 characters each | ORBIT (listener refuses) |
| Wall clock | about 90 minutes | runner (asked in the guide); ORBIT's existing `quiet` alert after 15 minutes of silence |
| Searches / fetches | 30 / 60 | runner-reported under Validation; ORBIT cannot count them |

## Security boundary

What makes the research lane least-privilege is structure, not instructions:

| Capability | How it is denied | Evidence |
| --- | --- | --- |
| Push to `orbit`, `orbit-work` or the vault | The research routine has **no repository sources** and **no connectors**, so the session has no checkout and no GitHub credential for them (provider configuration, see the routine file) | Smoke test B1–B5, B8 (operator-run); not verifiable from this repository |
| Use a build token or route | The job token is an HMAC of one job id and its expiry; the job listener serves only `events`, `steers`, and for research jobs `brief` and `tool`; it has no launch, steer, register, PR, admin, vault or status route | `test/research-lane.test.ts` ("listener: …") |
| Change its own kind, routine, repo or PR | `kind` and `research` are set by ORBIT at registration from configuration; event fields are an allowlist (`type`, `sha`, `toolCommit`, `n`, `status`, `text`, `textComplete`, `ack`) | test "research events cannot spoof …" |
| Trigger a PR, review, orbit-work write or build | The PR opener, the reviewer and the git reconciler skip `kind: "research"`; the completion listener only stores and notifies; nothing reads a report's Build handoff | tests "a finished research job opens no PR …", "end to end …" |
| Be used for build work by mistake | Separate env setting and credential name; any name, trigger or repo shared with the build lane makes the whole research lane `misconfigured`; the launcher refuses cross-lane launches | tests "research lane config: …", "lanes never cross …" |
| Choose a vault path or bypass vault policy | ORBIT fixes the path; the write goes through the existing pipeline; the runner never holds a vault credential | tests "research_save_to_vault: …" |
| Smuggle secrets or private endpoints into storage | Secret-shaped text refused at the listener and again by the vault pipeline; private and metadata hosts refused as sources | report tests |
| Reach private, internal or metadata endpoints from the sandbox | Environment network Limited to ORBIT's job host. **Provider-enforced and unverified here**; WebFetch's own protections are the provider's | smoke test B6, B7 |
| Instruction injection from web pages | The guide and prompt say web content is data; ORBIT treats the report as data (model guidance, `research_result` trust note, vault provenance block); no automatic action follows a report | model instruction test; by design. An instruction-level defence only, which is why nothing downstream acts on the report automatically |

The runner's one secret is its job token (3-hour, one-job, ingress-only). It is passed in the fire text, kept in `~/.orbit-research/<job>/token` (0600) and never printed by the tool.

## Configuration and operations audit

- `deploy/systemd/orbit.service` has `ImportCredential=orbit.*`, so `orbit.research-routine.<name>` is imported without a unit change.
- The tier 1 `ops_credentials` listing shows any `/etc/credstore` file by name and size, so the new credential appears there.
- The tier 2 config allowlist (`src/ops/admin-protocol.ts`, five keys) does **not** include `ORBIT_RESEARCH_ROUTINES`, and this change does not add it: tier 1/2 files are hash-pinned (`test/tier12-pin.test.ts`) and a change there needs its own review. So `ops_propose_config_change` cannot set the research routines (the helper refuses the key, changing nothing); an operator sets it by hand in `/opt/orbit/orbit.env`. Adding it to the allowlist later is a separate tier 2 change (validate as `name=trig_<id>` pairs, mask like `ORBIT_ROUTINES`, reinstall the helper with `deploy/install-admin.sh`).
- Cross-lane separation (a research name or trigger also in `ORBIT_ROUTINES`, or a research name in `ORBIT_ROUTINE_REPOS`) is checked by ORBIT at startup, which then marks the research lane `misconfigured` and logs why; the build lane keeps working, and `job_launch` keeps a colliding build routine usable.
- `orbit_config_view` shows `ORBIT_RESEARCH_ROUTINES` (trigger ids masked as `trig_…last4`) and the start of `deploy/routines/orbit-research.md`.
- `/status` (jobs port) says `Research lane unconfigured.`, `Research lane misconfigured.`, or `Research lane configured (<names>); no research report received yet: not proven live.` / `…; N valid research report(s) received.` Configuration alone is never reported as live.
- No live configuration, credential, environment or routine was changed by this work. Operator steps: `deploy/routines/orbit-research.md`, "Operator steps".

## Tested here versus outstanding

**Tested in this repository** (synthetic doubles, ORBIT's real listener on loopback, the real `orbit-research` script): configuration and fail-closed separation; report validation; research launch (no repository writes, fire text, token lifetime); build launch unchanged; cross-lane refusals and no fallback; listener routes, per-job tokens, spoofing, refusals that record nothing; completion isolation (no PR, no review, no orbit-work write, no launch) and build completion still opening its PR and review; chat tools (discovery, proposal only, result as untrusted data, fixed-path vault save with committed / pending / failed outcomes, tamper refusal); owner-only confirmation through the HTTP server and `/status` honesty; a mocked end-to-end lifecycle with tool download and digest check, steer, refused then accepted report, storage and save.

**Outstanding, operator-dependent** (none of it is claimed): the routine, environment and credential do not exist; whether claude.ai saves a routine with no repository; whether WebSearch/WebFetch work under a Limited environment; whether private and metadata addresses are blocked; whether the session classifier accepts running the downloaded, digest-checked tool; whether a no-source session really has no GitHub write path; real vault persistence of a research note. The post-setup smoke test in `deploy/routines/orbit-research.md` settles each of these with evidence. Until it passes, the research lane is not live.

## Integration notes

- Shared registration points touched: `src/server.ts` (lane tools appended to the owner's chat tools, `job_launch` wrapped by `withLaneGuard` so `src/chat-tools.ts` stays byte-identical as its pin test requires, launcher deps, `/status` detail, lane passed on confirmation), `src/model.ts` (one guidance line, `RECORD_TOOLS`), `src/fallback.ts` (three read/propose tools), `src/agent.ts` (`lane` on `job_launch`), `src/jobs.ts` (`kind: "research"`, `research` record). The research tools live in their own module (`src/research-tools.ts`) to keep shared edits small. Concurrent work on photo tool registration (embeddings / semantic photo retrieval) also edits the owner tool list in `src/server.ts` and the guidance in `src/model.ts`; the edits are in different expressions and should merge cleanly, but a rebase should re-run `test/research-*.test.ts` and the photo tests.
- `routines_list` and the lane tools are offered wherever `job_launch` is (owner only, Assistant and Chat).
