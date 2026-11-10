# Vault writes and the config view (general tools, part 1)

Status: implemented and tested in this repository; **not active on the host**. Nothing here has been installed, restarted or written to the real vault. Activation steps are at the end.

Code: `src/vault/edit.ts` (edit operations, path validation, policy), `src/vault/git.ts` (git runner and authentication), `src/vault/clone.ts` (the writable clone and the write pipeline), `src/vault/tools.ts` (chat tools and the confirmation path), `src/memory.ts` (`cloneMemory`), `src/recent-context.ts` (`vaultRecentContext`), `src/config-view.ts` (the config view). Tests: `test/vault-*.test.ts`.

## Architecture

```text
chat tool call ──► policy port (agent.<tool>, vault.<tool>: owner only)
                      │
                      ▼
          parseEdit (strict args, validatePath)
                      │
                      ▼  serialized, one at a time
   fetch ─► reset to origin/<branch> ─► applyEdit ─► secret check ─► classify (policy)
                                                                  │
          direct ───────────────────────────────────────────────┐ │ protected ─► proposal card ─► Confirm (digest)
                                                                ▼ ▼                              │ revalidated here
              write files + Log/<year>/<date>-orbit.md ─► ONE commit ─► push (never forced) ─► ls-remote == commit?
```

* **The clone** lives in `$STATE_DIRECTORY/vault-clone` (non-bare, ORBIT's own). Between writes it is an exact mirror of the remote branch: every sync and every write starts with `fetch` and `reset --hard origin/<branch>`, and a failed write resets it again, so an unpushed commit of ORBIT's never lingers and nothing of anyone else's is ever dropped. The remote is `https://github.com/phairow/orbit-vault.git` (`ORBIT_VAULT_REMOTE` overrides, https only) and the branch is the remote's default (`ORBIT_VAULT_BRANCH` overrides).
* **Reads.** `memory_search`/`memory_read` (and the page's per-reply excerpts) use the clone when the credential is present and the clone has synced; the read-only `/opt/orbit/vault` copy otherwise. A write invalidates the index, so a search after a write sees it at once. Other people's commits arrive at the next fetch (the tick refreshes at most once a minute, and the chat memory tools refresh if older than 30 seconds). Symlinked notes are never indexed or read (this also hardens the old copy).
* **Provenance.** Every answer's `source` is one of
  * `memory/vault-clone@<sha7> (fetched <time>)`;
  * `memory/vault-clone@<sha7> (fetched <time>; STALE: the last fetch failed at <time>: <error>)`: the last good clone, with the failure;
  * `memory/vault@<sha7> (FALLBACK: <why>; this is the read-only server copy and may lag GitHub)`.

  `/status` for the memory port says the same and is `degraded` on a fallback or a failed fetch. Write results carry `vault/clone@<sha7> (pushed to GitHub, remote head verified)`.

## The tools

| Tool | What it does |
| --- | --- |
| `vault_policy` | Reads `AGENTS.md`, `System/conventions.md` and `System/memory.md` from the clone (with the `AGENTS.md` hash). Read-only. |
| `vault_create_note {path, content}` | New `.md` note; never overwrites. |
| `vault_append_section {path, heading, text}` | Appends to the end of the section whose heading line is exactly `heading` (e.g. `## Plan`). The heading must occur once (fenced code is ignored). |
| `vault_replace_text {path, find, replace}` | Exact passage replacement. `find` must occur exactly once. |
| `vault_set_frontmatter {path, key, value}` | One top-level field (string, number, boolean or list of strings; quoted when YAML would misread it). |
| `vault_archive_note {path}` | Moves the note to `Archive/<same path>`; never overwrites; nothing is ever deleted. Links are not rewritten. |
| `orbit_config_view {}` | Read-only config view (below). |

There is no delete, no shell, no arbitrary file write, and no tool takes a branch, remote, commit message or author. A rolling-note rewrite uses an internal `rewrite_body` edit (expected body hash, so it fails if the note changed) that is not exposed as a tool; it goes through the identical pipeline.

## Policy

`AGENTS.md` in the vault is the authority. ORBIT reads it from the clone at run time on every write and **fails closed** (`policy_unavailable`) if it is missing; `vault_policy` shows it to the model, which must obey it, and the hash of the `AGENTS.md` that was in force is in the result and the commit message. The code enforces the rules it was given (AGENTS.md sections 3 and 4 as summarised in the job brief); it does not parse prose, so if `AGENTS.md` changes the rules, this table and `classify()` in `src/vault/edit.ts` must change with it. Unknown paths, operations and states are refused, never guessed.

| Where / what | Result |
| --- | --- |
| `Projects/`, `Tasks/`, `Areas/`, `Resources/`, `Memory/`, `Inbox/` (exact spelling), `now.md`, `Machines/orbit.md`, `Log/<year>/<date>-orbit.md` | **Direct** write (subject to the checks below). `System/memory.md` and `System/conventions.md` are read at run time and shown by `vault_policy`; `Memory/` writes are additionally screened for sensitive categories. |
| `Journal/` | Direct only for appending to a `Plan` section of an existing note. Anything else: **proposal**. |
| Note tagged `#rai` (body tag, `tags:` front matter, nested `#rai/…`; checked before and after the edit) | **Proposal**. |
| New category of sensitive personal detail (keyword screen: health, finances, identity documents, sexual/relationship, religion/politics, legal/immigration, family members' private details; "new" means the note did not already match that category) | **Proposal**. The screen over-matches on purpose. |
| `AGENTS.md`, `System/`, `.obsidian/`, `scripts/` (case-insensitive) | **Proposal**. These accept `.md`, `.json`, `.txt`, `.css`, `.yml`, `.yaml`, `.sh`, `.py`; everything else only `.md`. |
| Archiving | Only notes under `Projects/ Tasks/ Areas/ Resources/ Memory/ Inbox/` (direct) or `Journal/` and `#rai` notes (proposal). Never `now.md`, `Machines/`, `Log/`, `AGENTS.md`, `System/`, `.obsidian/`, `scripts/` (refused). |
| Anything else (other top-level paths, other machines' `Machines/` and `Log/` files, `Archive/` as a target, wrong extensions) | **Refused**, not confirmable. |

Always checked, in every mode including confirmed ones: the path (relative, NFC, ≤ 8 segments, characters limited to letters, digits, space and `. _ - ( ) & , ' +`; no `..`, no empty or hidden segments except `.obsidian`, nothing starting with `.git`, nothing starting with `-`); no symbolic link anywhere on the path, and the target must be a plain file (checked on the clone before every read and write); size caps (20,000 characters per argument, 256 KB per note, at most 3 edits per commit); the secret check; and every precondition (note exists / does not exist, passage exactly once, heading exactly once, archive target free). Git is only ever run with an argument array (no shell), with data after `--` or on stdin.

**Secret refusal.** The text an edit adds (and the Log line) goes through ORBIT's existing redaction (`maskText`: key shapes, bearer tokens, URL credentials, `password=`-style assignments, long opaque strings, Routine trigger ids). If redaction would change it, the write is refused with `secret_refused`; nothing is redacted into a commit. Plain 40-hex commit ids pass, as elsewhere. Existing note text is not scanned.

## Protected edits and confirmation

A protected change returns `status: "pending-confirmation"` and creates a `vault_edit` proposal card showing the path, operation, why Rai is being asked, and a masked preview. The exact validated edit stays in ORBIT's memory (it does not survive a restart, like the proposal). The card's digest is SHA-256 over the canonical edit and the reasons. `POST /chat/proposals/<id>/confirm {digest}` is owner-only (policy port `vault.confirm`), refuses a wrong or missing digest without consuming the proposal, then runs the **same pipeline** in `confirmed` mode, which re-fetches and **re-validates everything**: path rules, symlinks, secret check, preconditions, and that the policy still asks for no more than the reasons on the card (a note that has since been tagged `#rai`, say, makes it refuse). A confirmation authorizes one exact change; it cannot widen a path, turn a refused path into an allowed one or skip a check. The card ends `confirmed` with the verified commit, or `refused` with the reason. Single use, expiry (30 minutes) and the card lifecycle are the existing proposal mechanics (`docs/threads.md`).

## Writing, conflicts and verification

Each write: sync, apply, one commit with author and committer `ORBIT <orbit@users.noreply.github.com>`, subject `orbit: <what>`, a body listing each edit and the `AGENTS.md` hash, and **a line in `Log/<year>/<date>-orbit.md` (Pacific date, machine id `orbit`) in the same commit** (`- HH:MM orbit: <what> (<actor>)`; the file gets a `# <date> orbit` heading when created). The log format is an assumption: confirm it against `System/conventions.md` before activation (it is one line in `src/vault/clone.ts`).

Push is `git push origin HEAD:refs/heads/<branch>`: never `--force`, never a `+` refspec (a test greps the source). If the remote rejected it because someone else pushed, ORBIT fetches, resets to the new remote head and **reapplies the intent once**: the replacement/append is evaluated against the new text, so if the passage or heading has since changed it fails as a `conflict` naming the file. If the push is rejected a second time it stops: nothing is pushed, nothing is overwritten, and the error lists the files changed on both sides (or the files ORBIT touched). Success is reported only after `git ls-remote` shows the remote branch at ORBIT's commit; otherwise `unverified` and the change is reported as NOT saved. Local mutations are serialized by an in-process queue (ORBIT is one process).

## Authentication

The credential is the systemd credential `orbit.github-vault` (a fine-grained token with Contents read/write on the vault repository only), found at `$CREDENTIALS_DIRECTORY/orbit.github-vault` through the existing `ImportCredential=orbit.*`. It is read from disk each time it is needed and never cached, logged, returned, stored or written to a file. It reaches git only as one HTTP header in the child process's environment (`GIT_CONFIG_COUNT/KEY/VALUE`: `http.https://github.com/.extraHeader`, scoped to github.com), so it is not in a URL, a command line, the clone's `.git/config` or any file. Git runs with no global or system config, no credential helper, no hooks, no prompts, `GIT_ALLOW_PROTOCOL=https` and a minimal environment. Everything git prints is scrubbed of the token and its base64 form before it is used or returned. Tests assert all of this with a synthetic token, including a fake `git` that records its arguments and environment.

## Failure behaviour

| Situation | What ORBIT does |
| --- | --- |
| No credential (not installed, or installed but ORBIT not restarted) | Memory uses the read-only copy and says `FALLBACK: …`; write tools fail with `auth_unavailable`, nothing saved; the rolling note is not updated and `describe()` says so. |
| Clone or fetch fails | Reads continue from the last good clone with `STALE: …`; writes fail with `sync_failed`. The token is scrubbed from the message. |
| `AGENTS.md` missing | Writes fail closed (`policy_unavailable`). |
| Competing remote change | Reread and reapply once; then `conflict` with file names (above). |
| Push rejected for another reason / remote does not match after push | `push_failed` / `unverified`: reported as NOT saved; the clone is reset to the remote. |
| Tool result is an error | The model is told "NOT saved" and to say so; only `status: "committed"` means saved. |
| Rolling note cannot be saved (any of the above, a secret-shaped value, or a new sensitive category that needs Rai) | The old note stays, `lastError` records why, `describe()` reports it. There is no automatic approval of sensitive categories and no state-directory write standing in for the vault. |

## Config view

`orbit_config_view` (owner only, policy port `config`, no arguments) returns, each section with its own `source` and an `unavailable` state with the reason when it cannot be read:

* `env`: the allowlisted non-secret keys **as the running process has them** (`ORBIT_MODEL`, `ORBIT_ROUTINES` with trigger ids masked as `trig_…last4`, `ORBIT_ROUTINE_REPOS`, `ORBIT_PUBLIC_JOB_URL`, `ORBIT_INGRESS_PORT`, `HOST`, `PORT`, `ORBIT_COMMIT`, `ORBIT_DEPLOY_STATE`, `ORBIT_VAULT`, `ORBIT_VAULT_STATE`, `ORBIT_VAULT_REMOTE`, `ORBIT_VAULT_BRANCH`; unset keys say so). Everything else, including `ORBIT_OWNER`, is never shown.
* `credentials`: names, sizes and dates from the tier 1 helper (`credentials`), contents never read; plus names and sizes of what this process was actually given in `$CREDENTIALS_DIRECTORY`, with whether `orbit.github-vault` is loaded yet.
* `deployedCommit`: the commit the running process reports and the tier 1 `deploy_state`.
* `routine`: `deploy/routines/orbit-jobs.md` from the running release (masked, cut to 3,200 characters, with its size and hash).
* `ports`: each port's `status()`.

It changes nothing and offers no mutation path: configuration changes remain `ops_propose_config_change` (tier 2 `apply_config`, five keys, Rai confirms).

## Tests

`node --test test/*.test.ts`. The vault tests use temporary bare git repositories as the remote and a synthetic token; they never touch the network, the real vault or a real credential: `vault-write` (allowed writes and pushes, same-commit log, protected refusal and confirmed boundaries, secret refusal, exact replacement, competing change reapplied once, persistent race stops with a file report, no force, token absence, no credential, missing `AGENTS.md`, symlinks, serialization, archive), `vault-edit` (paths, areas, front matter, sections, tags, sensitive screen, classification), `vault-integration` (memory source/fallback/stale/fresh-read-your-writes, rolling note, chat tools, server confirmation with owner enforcement and digest, git runner environment, config view and its allowlist and masking). `test/tier12-pin.test.ts` was re-pinned for `chat-tools.ts` (see the comment there).

## Activation (later; nothing below has been done)

1. Confirm the vault repo has `AGENTS.md`, `System/conventions.md`, `System/memory.md`, and that the Log line format and the `Memory/recent-context.md` front matter (`updatedAt`, `sources`) match `System/conventions.md`; adjust `src/vault/clone.ts` / `src/recent-context.ts` if not.
2. Confirm the host has `git` on `PATH` for the `orbit` service user, outbound HTTPS to `github.com`, and the credential file `/etc/credstore/orbit.github-vault` (root, 0600). `orbit.service` needs no change: `ImportCredential=orbit.*` and `StateDirectory=orbit` already cover it. Optional: `ORBIT_VAULT_REMOTE`, `ORBIT_VAULT_BRANCH` in `orbit.env`.
3. Deploy this code (normal deploy), then restart ORBIT with the existing tier 2 `restart_orbit` proposal; the credential is loaded only at start.
4. Check, read-only: `orbit_config_view` shows `vaultWriteCredential: loaded in this process`; `/status` memory says `…writable vault clone…` (first sync clones the repo); a `memory_search` answer's `source` starts `memory/vault-clone@`.
5. First write: a harmless `vault_create_note` in `Inbox/`; verify the commit, author and Log line on GitHub.
6. Roll back by removing the credential and restarting: memory falls back to the read-only copy and write tools report `auth_unavailable`. Delete `$STATE_DIRECTORY/vault-clone` at will; it is re-cloned.

Known limits: the sensitive-category screen is keyword-based; wikilinks are not rewritten on archive; the unsaved exact edit behind a card is lost on restart (the card then says so); the rolling note is not retried until its thread changes again.
