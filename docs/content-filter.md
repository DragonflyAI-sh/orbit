# Vault content filter

`src/vault/filter.ts` recognises and masks **known credential shapes** in text that is vault content or travels with it. It is a convenience and preflight layer: it keeps well-known secret formats out of notes, job-context exports and stored conversation history, so that ordinary work is not tripped up by downstream protections. It is **not** a security boundary and does not try to be one.

## Policy: unknown content passes

Rai's priority for this heuristic is usability. So:

- A shape the filter does not recognise **passes**. Unknown, weakly suspicious, long, random-looking, hex, base64 or "passphrase-looking" text is not blocked for being any of those things.
- Known credential shapes stay blocked (writes, context export, cards) and masked (stored history, cards, display).
- Passing is not permission. Whether an action is allowed is decided elsewhere and is unchanged: owner-only confirmation, digest-bound cards, the `#rai` and protected-area rules, path rules, size limits, the sensitive-personal-detail confirmation, the job-context privacy checks, and every downstream scanner (CI gitleaks, the tier-1 redaction of ops output). This filter never loosens those, and no switch turns the filter off.

## Four separate concerns

| Concern | Where | What it decides |
| --- | --- | --- |
| Credential **recognition** | `src/vault/filter.ts` (`vaultFindings`, `hasVaultFindings`) | Which spans of a text are a known credential shape, as a rule id and line. |
| **Masking** | `src/vault/filter.ts` (`maskVaultText`, `maskVaultDeep`, `maskJsonStrings`), `src/threads.ts` (`maskContent`, `maskCall`) | Replaces the matched value only. Names, paths, prose, layout and line endings are kept. |
| Sensitive **personal detail** policy | `src/vault/sensitive.ts` (`sensitiveCategories`) | Whether inserted text looks like a new category of personal detail that Rai must approve (health, money, ...). Routes a write to a confirmation card; never blocks or masks. |
| Action **authorization** | `src/vault/edit.ts` (`classify`, `cardDisplay`, `digestOfEdit`), `src/vault/tools.ts`, `src/vault/clone.ts`, `src/job-context.ts` | Whether a write, proposal or launch may run: direct vs protected, owner-only confirmation, digest, re-validation at run time. |

## Root cause

1. **Detection was length- and keyword-based.** `secret.long-opaque` flagged any 32+ run of letters, digits, `_` and `-`: note names with dates, paths, wikilinks, hex ids and identifiers. `secret.credential-assignment` flagged any 4+ character value after a name containing `password`, `token`, `credential`, ... (a heading, a sentence, a test verdict). PRs #60-#62 refined these by adding exemptions (word-like runs, placeholder lists, function-word lists), which narrowed some false positives and left a rule whose default was still "refuse unless proven benign".
2. **Masking used the tier-1 masker for conversation content.** `maskText` (the ops redactor) is applied to thread messages, titles, summaries and stored tool results. It replaces every 32+ run with `[redacted]` and every `name: value` to the end of the token, so a long note name in a user message, in a `memory_read` result or on a job-brief card was stored and shown as `[redacted]`, and the model was later sent the masked history: silent loss of context.
3. **Tool output was masked as JSON text.** Stored tool results are JSON strings, where a note's line breaks are `\n` escapes, so a layout-aware rule (continuation lines, CRLF) never saw the note's real lines.
4. **Sensitive-detail policy over-matched technical prose.** `diagnos*`, `prescri*`, `symptom*`, `chronic`, `disorder*` counted on any occurrence unless the sentence passed a technical-vs-personal test; ordinary ORBIT notes about diagnostics and service health asked for confirmation.

Reproduced before fixing: on the vault corpus the previous filter flagged 70 of 188 notes (1,643 `secret.long-opaque` findings); the new regression matrix fails 5 of its 6 tests against the previous commit (names masked in stored tool output, history, brief cards; benign notes refused on write and on context export).

## What changed

- `filter.ts` is now span-based: one scan yields rule, span and replacement, and findings, masking and `hasVaultFindings` all derive from it (the old design rescanned the text once per rule and masked in passes).
- `secret.long-opaque` is **removed**. No rule is entropy-only, length-only or keyword-only.
- `secret.credential-assignment` judges **one token**: a quoted value without spaces, or the first word of an unquoted value. Several unquoted words are prose and pass (the first word is still judged when it is a strong generated shape such as `Hunter2hunter2 (rotated)`).
- Provider prefixes grew (Stripe, GitLab, npm, Hugging Face, SendGrid, Docker, AWS `ASIA`) and each needs a body long enough that ordinary words cannot match.
- `secret.url-credentials` needs `user:password@` with a real password (or a long token as the user of an http(s) URL); `ssh://git@host` passes. `secret.bearer-token` needs a credential-shaped value, not a word.
- Masking replaces **the value only**, in place; a private key without an END marker hides the header and its base64 body, not the rest of the note; CRLF is preserved everywhere.
- Conversation content (messages, titles, summaries, brief and steer cards, recent-context notes) and the results of vault, memory, job and PR tools are masked with `maskContent` / `maskCall`. Tool arguments and outputs are masked per JSON string (decoded, masked as the real text, re-encoded only if changed), so multiline and CRLF rules apply and a clipped final string is handled. `ops_*` and `orbit_*` tool results keep the tier-1 masker.
- The sensitive-detail policy moved to `sensitive.ts` and its ambiguous tier now needs a person frame (see below).
- Refusals say the rule and where, and what to change: write refusals and card refusals say to remove or replace the matched value (`<token>` is fine) and that headings, names and paths are not the cause; a context-export refusal still offers the separately confirmed launch that leaves the note out and tells the runner to read it from its own vault checkout. Nothing is ever silently omitted.

## Rules

Findings are a stable rule identifier plus a line number (CRLF and LF text count the same). The matched value is never returned, logged or put in an error.

| Rule | Recognises | Replacement |
| --- | --- | --- |
| `secret.private-key` | `-----BEGIN ... PRIVATE KEY-----` to the END marker, or header plus base64 body | `[redacted key]` |
| `secret.provider-token` | `sk-`, `sk-ant-`, `sk_live_`/`rk_live_`/`sk_test_`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_`, `glpat-`, `tskey-`, `xox[baprs]-`, `AKIA`/`ASIA`, `AIza`, `npm_`, `hf_`, `SG.x.y`, `dckr_pat_`, each with a minimum body length, not inside a longer alphanumeric word | `[redacted token]` |
| `secret.jwt` | `eyJ...` with two or three dot-separated parts | `[redacted jwt]` |
| `secret.bearer-token` | `Bearer`/`Basic` + 12+ characters mixing classes, not word-like, not a prose word | `[redacted]` |
| `secret.url-credentials` | `scheme://user:password@` (non-placeholder password), or `https://<20+ char token>@` | `[redacted]` |
| `secret.routine-trigger` | `trig_<id>` | `trig_…last4` |
| `secret.credential-assignment` | `<name containing password, passphrase, secret, token, api key, access key, private key, credential, cookie, session id, authorization> = / : <value>` where the value, as one token, has a credential shape (below). Also a value on an indented line after a bare name (YAML style), after at most two blank lines | `[redacted]` |

Credential-shaped value: under a password name, 6+ characters mixing two classes (lower, upper, digit, symbol) or 12+ characters that are not word-like (a digit inside the token means it is not treated as words: `Hunter2hunter2`); under any other credential name, 16+ characters mixing letters with digits or symbols, or 24+ characters that are not word-like. Always exempt: placeholders (`<your-token>`, `${VAR}`, `{{var}}`, `[x]`, `****`), stop words (`none`, `n/a`, `tbd`), dates, times, versions, numbers under 12 digits, URLs without credentials, paths, file names, word-like names (kebab, camelCase, run-together English), and any unquoted value of several words.

Not a name: a name that ends in a file extension (`some-token-note.md:`), a bare `pass`/`PASS`, `pwd`, `key`, `id`. A markdown wrapper (`**`, `_`, backticks, `> `, `- `, `#`) never decides the outcome.

## Sensitive-personal-detail policy (`sensitive.ts`)

Unchanged in what it does (a new category in inserted text routes the write to a confirmation card), narrower in what it guesses for health:

- **Always:** condition, treatment and drug words (`cancer`, `therapy`, `insulin`, `sertraline`, `prescription`, `diagnosed with`, `chronic pain`, `anxiety disorder`, ...), wherever they appear.
- **Ambiguous** (`diagnosis`, `symptom(s)`, `prescribe`, `chronic`, `disorder`, `has a ... condition`): ask only with a **person frame** in the same clause: a medical-setting word (doctor, clinic, patient, ...) always; otherwise a pronoun, a capitalised name's possessive or a named person mid-sentence **and** no technical cue (service, build, queue, log, vault, ...). Clauses are split at sentence ends, line breaks, `;` and dashes, so a technical clause does not launder a personal one next to it. `diagnostics`, `diagnose the failing job`, `symptoms: timeouts`, `chronic CI failures`, `a race condition` pass.
- Limits: the lists are finite; a bare `diagnosis: pending` with no frame passes; slang, misspellings and other languages are not caught. This is a routing convenience, never a privacy control.

## Surfaces

| Surface | Behaviour |
| --- | --- |
| Vault write admission (`clone.write`, `secretFindings`) | Refuses when a known shape is in what the edit adds (or the Log line), with rule and line; nothing written or redacted. Ordinary text is written byte for byte. |
| Job-context export (`prepareContext`) | Refuses the whole launch on a known shape, with rule, line and the recovery; otherwise exports whole and unmasked (CRLF included). Never clips, never omits. |
| Confirmation cards (`cardDisplay`, `thread-service`) | A protected change that contains a known shape is refused at proposal time (with rule and card line); otherwise the card shows the exact change and the digest covers it. Brief and steer cards are masked by value, and a masked brief says so (`briefMasked`). |
| Stored history, titles, summaries, tool results | Masked by value with `maskContent` / `maskCall`; ops tools keep tier-1 masking. |
| Reads (`memory_read` etc.) | The model receives the note as read; what is stored and shown is masked by value. |

## Corpus validation

`tools/vault-filter-corpus/corpus.ts` runs the filter over an authorized local vault checkout (and optional extra text files such as saved job logs or PR text) and prints only aggregates: corpus revision and size, per-rule counts of texts and findings, a shape histogram of what would be masked (length bucket, character classes, kind of line, word count), and fabricated-case recall per rule. It never prints a matched value, a note name, a path or a line of text, writes nothing, and opens the vault read-only. `--json` gives the same as JSON; `test/vault-filter-corpus-tool.test.ts` checks the no-leak property.

```
git show <old-commit>:src/vault/filter.ts > "$TMPDIR/old-filter.ts"        # the baseline
node tools/vault-filter-corpus/corpus.ts /path/to/vault-checkout --baseline "$TMPDIR/old-filter.ts" [--extra saved-text.txt]...
```

Fabricated blocked cases (`tools/vault-filter-corpus/fabricated.ts`) are generated at run time from split literals and a seeded generator, so no usable or secret-shaped literal is committed. Every retained or new rule is evaluated both on the corpus and on those cases. Classifying the corpus matches is done privately, by shape (never by reading values into a report): benign, known sensitive, or unresolved.

### Report for this change (run 2026-11-12 in the authorized environment)

Corpus: the authorized vault checkout, revision `367d7ecfb95b`, 188 Markdown notes, 2,807,605 bytes, 0 with CRLF. It is the sparse checkout the job runner has (root files, `System/`, top-level files of `Projects/`, `Resources/`, `Tasks/`; no `Journal/`, `Memory/`, `Log/`, `Inbox/`, `Machines/` and no subfolders), so coverage of the full vault is partial.

| Rule | Baseline (f2018ee): texts / findings | New: texts / findings |
| --- | --- | --- |
| `secret.long-opaque` | 58 / 1,643 | removed |
| `secret.credential-assignment` | 16 / 26 | 2 / 3 |
| `secret.jwt` | 1 / 1 | 1 / 1 |
| `secret.routine-trigger` | 4 / 6 | 4 / 6 |
| all | 70 / 1,676 (714,617 characters masked) | 7 / 10 (6,794 characters masked) |

Old vs new: 63 notes flagged by the baseline are clean now; 0 notes are newly flagged.

Private classification of the matches (by shape):

- `secret.long-opaque` (1,643, all removed): by shape, kebab-case names and paths (including dates), wikilinks, 40/64-hex ids and long identifiers; none matched a known vendor shape. 164 unseparated mixed-case 32+ character runs remain in the corpus that are not hex, paths or word-like; they now pass by policy (**unresolved**: this is the stated cost of dropping length/entropy blocking).
- `secret.credential-assignment` baseline-only matches (23 findings in 14 notes): multi-word prose values (about 20), one short single word: **benign**, fixed by judging one token.
- `secret.credential-assignment` remaining (3 findings, 2 notes): values of 23-54 characters; two are digit-heavy and colon- or dot-separated (identifier or timestamp-like), one has symbols and capitals. **Unresolved**: kept flagged; no general rule can exempt them safely, and no exception tailored to a note was added. The vault owner can review them locally with the command above.
- `secret.jwt` (1): a structurally valid token (decodable header with `alg`/`typ`, decodable payload): **known sensitive shape**, kept.
- `secret.routine-trigger` (6 in 4 notes): trigger ids, masked `trig_…last4` by project policy: **known sensitive**, kept.

Fabricated blocked cases (current / baseline): `secret.provider-token` 33/33 (24/33), `secret.credential-assignment` 21/21 (21/21), `secret.jwt` 3/3 (3/3), `secret.private-key` 6/6 (6/6), `secret.bearer-token` 6/6 (6/6), `secret.url-credentials` 3/3 (3/3), `secret.routine-trigger` 3/3 (3/3). Ordinary-text precision cases wrongly flagged: 0/5 (baseline 1/5). Sensitive-detail policy on the corpus: sentences asked about as health 137 in 41 notes before, 15 in 12 notes now (the remainder are condition, treatment or drug words, which still ask).

Real PR text: the text (body, comments, reviews) of this repository's PRs #46, #58 and #60-#65 (8 texts, 49,257 bytes), read through the authorized GitHub tools and scanned locally: baseline flagged 3 texts (11 `secret.credential-assignment` findings, prose values), the new filter flags 0. ORBIT service logs were not available to the job runner, so **service logs were not scanned**; run the tool with `--extra` on a saved log in the environment that has them.

## Known limitations (stated, not hidden)

- **Unknown passes.** A random 40-character token, a 64-hex digest, a UUID, a base64 blob, a word-list passphrase (`password: correct-horse-battery-staple`), a quoted multi-word password, a short password (`password: abc12`), a credential with no separator (`the password is ...`), aliases (`pwd:`), and secrets of vendors not in the provider list are **not** recognised. A real secret of such a shape written in a note is not blocked by this filter; downstream scanners (CI gitleaks, the vault's own policy of never storing secrets) are the layers for that.
- A provider token truncated by a clip (fewer than the minimum body characters) is not recognised.
- An unquoted multi-word value is treated as prose; only its first word is judged, and only when it is a strong generated shape.
- A value inside a table cell or code block is judged like any other text; a continuation across three or more blank lines is not seen.
- Over-matching that remains: any `trig_` id is refused on write (project policy), and a digit-heavy single token under a credential name (an id after `token:`) asks.
- The brief on a `job_launch` card is masked for display, but the brief itself is launched as written; the launch is owner-confirmed and the brief goes to the private control repository. (Unchanged.)
- The sensitive-detail policy is finite and can miss disclosures; it is a routing convenience.
- Findings are for the text checked: lines count from 1 in that text.

## Closeout checklist (what this job did, and what is left)

Done by this job:

- [x] Root cause explained (above), existing failures reproduced before the fix (corpus run; the matrix fails 5 of 6 on the previous commit).
- [x] Implementation: known-pattern filter, value-only layout-preserving masking, content masking of history and tool output, sensitive-detail policy separated and narrowed, refusals with rule, location and recovery.
- [x] Regression suite across reads/tool output, conversation history, writes, cards/proposals and job context (`test/vault-filter-matrix.test.ts`), plus unit tests (`test/vault-filter.test.ts`), the policy tests and the corpus-tool privacy test.
- [x] Privacy-preserving corpus procedure and report with old/new comparison (above).
- [x] Typecheck, full test suite and (where available) the CI secret scan run before finishing; see the job summary for the exact commands and results.

Not done, and not authorized by this job (remaining gates for closing the issue):

- [ ] Two independent security/usability reviews of the final exact commit (not the implementation author), with resolution and re-review of material findings.
- [ ] Rai's merge and deployment decision.
- [ ] A benign live end-to-end acceptance check after deployment (for example: write a note with a `Credential:` heading and a long note name, read it back with `memory_read`, and launch a job with that note as context).
- [ ] Real-log validation in an environment that has ORBIT service logs; validation against the full vault (the checkout used here is sparse).
- [ ] Marking the task closed.

## Tests

`test/vault-filter-matrix.test.ts` (the matrix across surfaces), `test/vault-filter.test.ts` (recognition, permissive-unknown, masking, CRLF, continuation, JSON strings, refusals, cards), `test/vault-filter-regressions.test.ts` and `test/vault-pr61-followup.test.ts` (sensitive-detail policy and approval routing), `test/vault-filter-corpus-tool.test.ts` (the tool leaks nothing), plus the write path in `test/vault-write.test.ts` and `test/vault-edit.test.ts` and context export in `test/job-context.test.ts`.
