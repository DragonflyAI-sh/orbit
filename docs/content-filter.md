# Vault content filter

`src/vault/filter.ts` decides whether *vault content* looks like it holds a secret. It is used for vault writes (`secretFindings` in `src/vault/edit.ts`), job context export (`src/job-context.ts`), vault confirmation cards (`cardDisplay`, and the card's display in `thread-service.ts`) and the display of context paths. It replaces `maskText(t) !== t` for those paths only.

## What did not change

- `src/ops/protocol.ts` (tier 1, pinned, installed as root) is untouched. `redact()` and `maskText()` still mask logs, chat history, ops output and every other surface exactly as before. Nothing here weakens global logging protection.
- Private keys, `Bearer` values, URL credentials, provider key prefixes (`sk-`, `ghp_`, `github_pat_`, `tskey-`, `xox*-`, `AKIA`, `AIza`), JWTs and Routine trigger ids use the same patterns as before and are flagged as before. (`Basic <lowercase word>` and `Bearer <a short list of prose words>` such as `tokens` or `authentication` are treated as prose.)
- Uncertain cases still refuse (the credential screen is now stricter: see Rules). The owner-only confirmation, digest binding, `#rai` exclusion, size limits and "never clip, never silently omit" rules are untouched.

## Root causes (checked against the code)

1. The credential-assignment rule (`<name containing password|secret|token|credential|...> [=:] <value>`) accepted any value, including the `**` of a markdown heading such as `**Credential:** ...`, a test verdict (`PASS: ...`, `passed: 12`), a timestamp, or a file name that contains a keyword (`some-token-note.md: ...`).
2. The long-opaque rule (`[A-Za-z0-9_-]{32,}`) matched any 32+-character run, so long kebab-case note names, `[[wikilinks]]`, paths, camelCase identifiers and slugs were flagged.
3. Display masking (`maskText` on cards and refusal text) then turned the same names into `[redacted]`.
4. The health screen matched everyday technical words (`diagnostics`, `diagnosis`, `diagnose`, `symptom`, `prescribed`, `chronic`, `disorder`). PR #60 narrowed it to pronoun constructions and fixed phrases, which missed named third-party disclosures; this follow-up replaces that with the two tiers below.

## Rules

Findings are a stable rule identifier plus a line number; the matched value is never returned, logged or put in an error.

| Rule | Flags |
| --- | --- |
| `secret.private-key`, `secret.url-credentials`, `secret.provider-token`, `secret.jwt` | as before |
| `secret.bearer-token` | `Bearer`/`Basic` + 6 or more token characters, except the prose exceptions above |
| `secret.routine-trigger` | `trig_<id>` |
| `secret.credential-assignment` | a keyword name (also `API key`, `private key` with a space) followed by `=` or `:` and a value that looks secret. The **whole value** is judged: a quoted value is judged to its closing quote (`\"` escapes honoured; an unclosed quote runs to the end of the line), an unquoted value to the end of the line, a `;` or a `\|`. Under a strong name (password, passphrase, secret, token, api key, credential, private key, cookie, session id, authorization) any value of 4+ characters counts (3+ under a password-like name), one word or many. Exempt: an empty value (a bare markdown heading), the stop words (`none`, `n/a`, `tbd`, ... only as the whole value), a date, time or version number, a number under 10 digits (4+ digits under a password-like name), a plain placeholder (`<your-token>`, `${VAR}`, `{{var}}`, `xxxx`, `****`), and an *unquoted* multi-word value that is a sentence about credentials (2+ function words and a credential/technical word, such as "an API key lives in the host's secret store"). A quoted value never gets the sentence exemption. A value on an indented line after a bare name (YAML style) is judged; a bare heading is not. A name with only `pass` in it (`PASS:`, `passed:`) needs a generated-looking value (10+ characters mixing upper case, lower case and digits). Names ending in a file extension are file names |
| `secret.long-opaque` | a 32+ run that does not read as words (below). 40-hex commit ids pass as before |

A long run is exempt only if it reads as words: lowercase kebab-case with three or more short words (date parts, `v2`/`pr275` style pieces and short abbreviations allowed in limits), camelCase of four or more words of three or more letters, or letters run together that read as English (a third or more vowels, no consonant stretch over four, few capitals, at most three stray digits). A path or wikilink around a run never exempts it: `Tasks/<random>.md` and `[[<random>]]` are flagged because the run inside is judged on its own. Mixed case, digits mixed into letters, UUIDs, hex and base64-like runs stay flagged.

## Health screen

Two tiers, applied to the text an edit adds (a category already in the note is not "new").

- **Always:** condition, treatment and drug words (`psychiatr*`, `depression`, `anxiety`, `cancer`, `medication`, `therapy`, `surgery`, `prescription*`, `mental health`, `adhd`, `bipolar`, `diabet*`, `asthma`, `epilep*`, `heart condition`, named drugs such as `sertraline`, `insulin`, `antibiotics`, ...), plus `diagnosed with`, `was/is prescribed`, `chronic pain` and `<kind> disorder` phrases. No technical exemption applies.
- **Ambiguous:** `diagnos*`, `prescri*`, `symptom*`, `chronic`, `disorder*` and `has a ... condition/disease/syndrome` count as before (any occurrence) unless the sentence is demonstrably technical: it contains a technical cue (service, build, queue, log, failure, ...) and **no** personal cue. Personal cues are pronouns, possessives (`Sam's`), `was/is diagnosed/prescribed`, medical-setting words (doctor, clinic, patient, ...) and a capitalised name that does not start the sentence. A pronoun is not required: `Sam's diagnosis: diabetes` and `Jo was prescribed sertraline` are flagged.

Limitations: the screen is conservative, not complete. The condition and drug lists are finite, so a disclosure naming something unlisted (or using slang, a misspelling or another language) and none of the ambiguous words is not caught. A technical sentence that also contains a personal cue (including a possessive like `the service's diagnostics`) is asked about. The screen never reads meaning; it cannot tell a real disclosure from a quotation or a fictional example.

## Residual limitations (stated, not hidden)

- Chat history, ops output and logs still use `maskText`, so a long note name that appears in a conversation can still be stored as `[redacted]`. Changing that would touch global masking and needs its own decision and review.
- UUIDs, long hex ids, session ids, `trig_` ids and other opaque identifiers are still flagged. A note that contains them cannot be exported or written by ORBIT until they are removed, or the job reads the note from its own vault checkout in a separately confirmed launch.
- Long-opaque exemption (known limitation, pinned by tests): outside a credential assignment, a run of 32+ characters that reads as words is not flagged. That includes a 33-character repeated-letter run (`aaaa...`) and a dash-separated diceware-style passphrase of three or more short words. A real secret of that shape written in plain text is therefore **not** blocked by `secret.long-opaque`; this filter does not block all real secrets. Inside a credential assignment (`secret: <that run>`, `password: <passphrase>`) the value is screened by `secret.credential-assignment`, whatever shape it has.
- A lowercase-letters-only secret of 33+ characters with English-like vowel balance is treated as run-together words outside an assignment; a secret written as a 3+ word kebab phrase under a non-keyword name is treated as a note name.
- A `pass:`/`PASS:` (not password) value that is not a generated-looking mixed string is not flagged.
- An unquoted multi-word value that mentions credential vocabulary and 2+ function words (a natural-language sentence passphrase such as one containing "the secret is in the vault") is treated as prose; quote it and it is screened.
- Over-matching, measured: on this repository's 12 Markdown docs the vault filter reports 10 findings (PR #60's filter reported 8), all on lines that talk about credentials (rule descriptions, `ImportCredential=`, a credential file path). Short unquoted words after a credential name now ask (`token: refresh`). An unquoted value runs to the end of its line, a `;` or a `|`, so masking hides the rest of that line.
- Coverage of real data is only what an authorized read could reach. See the PR text for the vault scan results; nothing about logs or PR text outside the vault was checked.
- Findings are for the text checked (an inserted text, a note, a card field); lines count from 1 in that text.

## Tests

`test/vault-filter-regressions.test.ts` (health tiers and approval routing, whole-value credential judgement, limitations), `test/vault-filter.test.ts` (benign precision, security regressions with run-time-built fakes, path/wikilink/wrapper embedding, rule-id-only findings, display masking, health, cards), plus the write path in `test/vault-write.test.ts` and context export in `test/job-context.test.ts`.
