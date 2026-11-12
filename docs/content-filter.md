# Vault content filter

`src/vault/filter.ts` decides whether *vault content* looks like it holds a secret. It is used for vault writes (`secretFindings` in `src/vault/edit.ts`), job context export (`src/job-context.ts`), vault confirmation cards (`cardDisplay`, and the card's display in `thread-service.ts`) and the display of context paths. It replaces `maskText(t) !== t` for those paths only.

## What did not change

- `src/ops/protocol.ts` (tier 1, pinned, installed as root) is untouched. `redact()` and `maskText()` still mask logs, chat history, ops output and every other surface exactly as before. Nothing here weakens global logging protection.
- Private keys, `Bearer` values, URL credentials, provider key prefixes (`sk-`, `ghp_`, `github_pat_`, `tskey-`, `xox*-`, `AKIA`, `AIza`), JWTs and Routine trigger ids use the same patterns as before and are flagged as before. (`Basic <lowercase word>` and `Bearer <a short list of prose words>` such as `tokens` or `authentication` are treated as prose.)
- Uncertain cases still refuse. The owner-only confirmation, digest binding, `#rai` exclusion, size limits and "never clip, never silently omit" rules are untouched.

## Root causes (checked against the code)

1. The credential-assignment rule (`<name containing password|secret|token|credential|...> [=:] <value>`) accepted any value, including the `**` of a markdown heading such as `**Credential:** ...`, a test verdict (`PASS: ...`, `passed: 12`), a timestamp, or a file name that contains a keyword (`some-token-note.md: ...`).
2. The long-opaque rule (`[A-Za-z0-9_-]{32,}`) matched any 32+-character run, so long kebab-case note names, `[[wikilinks]]`, paths, camelCase identifiers and slugs were flagged.
3. Display masking (`maskText` on cards and refusal text) then turned the same names into `[redacted]`.
4. The health screen matched everyday technical words (`diagnostics`, `diagnosis`, `diagnose`, `symptom`, `prescribed`, `chronic`, `disorder`).

## Rules

Findings are a stable rule identifier plus a line number; the matched value is never returned, logged or put in an error.

| Rule | Flags |
| --- | --- |
| `secret.private-key`, `secret.url-credentials`, `secret.provider-token`, `secret.jwt` | as before |
| `secret.bearer-token` | `Bearer`/`Basic` + 6 or more token characters, except the prose exceptions above |
| `secret.routine-trigger` | `trig_<id>` |
| `secret.credential-assignment` | a keyword name (also `API key`, `private key` with a space) followed by `=` or `:` and a value that looks secret: 8+ characters; 4+ for password-like names; shorter only with three kinds of character. Wrapper characters (`*`, `_`, `` ` ``, `[`, `(`, quotes) are stripped and the value inside is judged; a bare wrapper (`**`) means the next word is judged. A name with only `pass` in it (`PASS:`, `passed:`) needs a generated-looking value (10+ characters mixing upper case, lower case and digits). Dates, times, version numbers and numbers under 10 digits are not secrets (unless the name is password-like). Names ending in a file extension are file names |
| `secret.long-opaque` | a 32+ run that does not read as words (below). 40-hex commit ids pass as before |

A long run is exempt only if it reads as words: lowercase kebab-case with three or more short words (date parts, `v2`/`pr275` style pieces and short abbreviations allowed in limits), camelCase of four or more words of three or more letters, or letters run together that read as English (a third or more vowels, no consonant stretch over four, few capitals, at most three stray digits). A path or wikilink around a run never exempts it: `Tasks/<random>.md` and `[[<random>]]` are flagged because the run inside is judged on its own. Mixed case, digits mixed into letters, UUIDs, hex and base64-like runs stay flagged.

## Health screen

Condition and treatment words (`psychiatr*`, `depression`, `anxiety`, `cancer`, `medication`, `therapy`, `surgery`, `prescription`, `mental health`, ...) always count. Everyday technical words count only in a personal or medical construction (`diagnosed with`, `my symptoms`, `chronic pain`, `anxiety disorder`, `prescribed antibiotics`). The screen still errs toward asking: non-personal uses of the strong words (a note about animal medication, say) still ask.

## Residual limitations (stated, not hidden)

- Chat history, ops output and logs still use `maskText`, so a long note name that appears in a conversation can still be stored as `[redacted]`. Changing that would touch global masking and needs its own decision and review.
- UUIDs, long hex ids, session ids, `trig_` ids and other opaque identifiers are still flagged. A note that contains them cannot be exported or written by ORBIT until they are removed, or the job reads the note from its own vault checkout in a separately confirmed launch.
- A lowercase value after a password-like name is flagged only from 4 characters; a bare `pass:`/`PASS:` value that is not a generated-looking mixed string is not flagged. A lowercase-letters-only secret of 33+ characters with English-like vowel balance would be treated as run-together words; a secret written as a 3+ word kebab phrase under a non-keyword name is treated as a note name. Credential assignments under a keyword name (`secret: correct-horse-battery-staple`) are still flagged.
- Coverage of real data is only what an authorized read could reach. See the PR text for the vault scan results; nothing about logs or PR text outside the vault was checked.
- Findings are for the text checked (an inserted text, a note, a card field); lines count from 1 in that text.

## Tests

`test/vault-filter.test.ts` (benign precision, security regressions with run-time-built fakes, path/wikilink/wrapper embedding, rule-id-only findings, display masking, health, cards), plus the write path in `test/vault-write.test.ts` and context export in `test/job-context.test.ts`.
