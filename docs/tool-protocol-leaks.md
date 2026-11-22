# Tool-call markup in replies

Rai saw replies made of literal markup such as `<｜DSML｜tool_calls><｜DSML｜invoke name="memory_search">…`, sometimes after the reply had used up its tool rounds, instead of a tool running or a normal answer. This page records what was shown to cause it, what is only a hypothesis, what ORBIT now does, and what is still not covered. The investigation used synthetic reproductions only: no production conversation, log or credential was read.

## What the markup is

`<｜DSML｜…>` (with U+FF5C fullwidth bars) is DeepSeek's own wire format for tool calls. A provider that serves a DeepSeek model normally parses it into structured tool calls (Chat Completions `tool_calls`); when it does not, the markup arrives as ordinary answer text. Other model families have equivalent formats (Hermes/Qwen `<tool_call>{…}`, Kimi `<|tool_calls_section_begin|>`, Mistral `[TOOL_CALLS]`, Llama `<|python_tag|>`).

## Demonstrated root cause (in ORBIT's code)

Reproduced on `main` at `b2a6f01` with a scripted model (no provider involved):

1. **Unvalidated text became the final answer.** `runChat` (`src/agent.ts`) ended a reply at the first step with no structured tool calls and returned `step.text` as the answer, whatever it contained. No adapter (ChatGPT streaming, OpenAI API, OpenRouter fallback) checks text for tool-call markup either. So markup text was stored as the reply (`src/thread-service.ts`), shown on the page (rendered as text, correctly, by the Markdown renderer), and listed in the transcript. The UI only displayed what it was given; it is not the cause.
2. **The forced final step after the tool-round budget is a natural place for it.** After `MAX_ROUNDS` (20) tool rounds, runChat sends one more step with **no tools** but with the whole tool history. A model that still wants a tool can only write the call as text, and that text became the answer. Reproduced: 20 rounds of `memory_search` calls followed by a DSML "answer" was returned as the reply with `capped: true`. This matches "replies consumed tool rounds and ended with literal markup".
3. **Stored leaks were replayed.** `buildItems`/`buildMessages` (`src/thread-context.ts`) sent every stored assistant reply back to the model verbatim, so an earlier leaked reply became an in-context example of writing tool calls as text.
4. **Streamed text is assembled before anything checks it.** `stepFromStream` (`src/chatgpt.ts`) joins `output_text` deltas, so markup split across deltas (even inside the `｜DSML｜` sentinel) arrives whole; this was correct, and it means the check belongs after assembly, not per delta.

Not a cause: structured tool calls were never dispatched from text, and (before DSML recovery) no path parsed markup into a call. Valid structured calls in the same response were already the only thing that ran.

## Hypotheses (not proven)

- **Which model wrote it.** DSML is DeepSeek's format, and `docs/openrouter-activation-runbook.md` recommends `deepseek/deepseek-v4-flash` as the OpenRouter fallback, so the leaked replies most likely came from the fallback. Nothing in this investigation shows which model answered the affected replies (each stored reply's `source`/`fallback` field would say; it was not read).
- **Why the provider did not parse it.** Possible reasons: the final step sends tool history but no `tools` parameter, so the provider's tool parser may be inactive; a provider endpoint without a DSML parser; or a reply cut off mid-call (`finish: length`). Sending `tools` with `tool_choice: "none"` on the final step might let the provider parse such output, but that is untested against a real provider and is not done here.
- **The primary copying a leak.** A ChatGPT model shown an earlier DSML reply in its history could imitate it. Plausible, not reproduced.

## What ORBIT does now

The boundary is where model text becomes an answer: `runChat` for tool-using replies, `screenReply` for plain replies (thread turns without tools and the legacy `/chat` route).

- **Recognition** (`src/tool-protocol.ts`, `detectProtocolText`): vendor-specific tool-call envelopes in a model's own text, outside Markdown code (fenced blocks, including an unclosed fence, and inline code spans are skipped). Generic XML such as `<invoke>` or `<function_calls>` is not matched, so XML and code answers are untouched.
- **Never executed, with one exception.** Markup is never parsed into a call, wherever it appears (user messages, tool outputs, stored history, quotations, other vendors' formats), except DSML recovery below. Structured provider tool events run through the existing owner, policy, deadline, budget and confirmation checks.
- **DSML recovery** (Rai's decision of 2026-11-21, after the OpenRouter fallback `deepseek/deepseek-v4-flash` kept answering with DSML even after the retry). `recoverDsmlCalls` (`src/tool-protocol.ts`) turns a model step's DSML text into tool calls only when all of this holds: the step was offered tools; it has no structured calls; it ended normally (no completeness note, so nothing cut off at the output limit or with an unknown finish); the text holds exactly one complete `tool_calls`/`function_calls` block that starts outside Markdown code, with no other DSML anywhere; every tag parses exactly (only whitespace between tags, every parameter has `string="true"` or `string="false"`, `false` values are valid JSON, no duplicate parameters, no DSML inside a value); every call names a tool offered on that step; no parameter the tool's schema forbids (`additionalProperties: false`) and none it requires missing; between 1 and 8 calls (the OpenRouter adapter's structured limit). Anything else is left to the retry-then-refuse path above, unchanged. Recovered calls get ORBIT's own ids (`call_dsml_<round>_<attempt>_<n>`), run through the same `allowAgent` owner and policy check, deadlines, tool-result budget, no-progress guard and confirmation cards as structured calls, and go back to the model as structured items; the markup text is never shown or sent on. The reply carries an owner-visible note ("ORBIT recovered N tool call(s) ...") in `incomplete`, and the diagnostic line has `action: "recovered"` and `recoveredCalls`. Because the fallback has tool parity (`docs/openrouter-fallback.md`), a recovered call can do anything a structured one can, including the section-3 vault writes, `notify` and `ops_sys_cancel_reboot` that act without a card.
- **Bounded recovery.** A step whose answer text is markup (no structured calls, or the no-tools final step) is not shown. ORBIT asks the model **once** more per reply (`PROTOCOL_RETRIES_MAX = 1`) with the same input (nothing from the rejected response is added) plus an instruction that the response was rejected and how to call tools or answer. The retry does not count as a tool round, re-runs no call, and repeats no side effect, because the rejected response ran nothing. A recovered reply carries an owner-visible note (in `incomplete`, never in the text).
- **Honest failure.** If the retry is markup too, the reply ends with `ModelProtocolError`: the thread message is marked as an error saying the model answered with raw tool-call markup, that nothing in it ran, that only the listed calls ran, and (for the fallback) which model it came from. Calls that ran in earlier rounds stay on record.
- **Mixed responses.** When a response has valid structured calls and markup text, the structured calls run exactly once and the text is dropped (it was never shown or sent on before either); this is logged.
- **Replay.** A stored assistant reply that is markup is replaced, only in what is sent to a model, by a short placeholder. The stored message is not rewritten. User messages are always sent exactly as typed, including quoted markup.
- **Instructions.** The tool list tells the model never to write tool calls as text and to put deliberate markup in a code block; the no-tools final step says the same.
- **Diagnostics.** Each rejected or dropped response is logged as one `model_protocol_text` JSON line: family, step, attempt, model (`primary` or the fallback id), whether tools were offered, character count, a 16-hex SHA-256 prefix, the number of structured calls and the action. Never the text.

Tests: `test/tool-protocol.test.ts` (DSML recovery: what is read and every refusal, the tool loop, the policy gate, the retry, the final step and the OpenRouter fallback; literal DSML for a tool not offered, split stream deltas, truncated calls, the tool-round cap, mixed responses, quotations, tool outputs and user text containing markup, the OpenRouter fallback, persisted and reloaded threads, replay of old leaks, duplicate prevention, unchanged normal answers and tool calls).

## Remaining limits

- Only DSML is recovered. Other formats (Hermes, Kimi, Mistral, Llama, DeepSeek V3 special tokens) are still only recognised, retried once and refused.
- Recognition is a list of known envelopes. A model with an unknown format, or markup wrapped in a code block by the model itself, is shown as text (still never executed).
- A model answer that quotes markup outside a code block is treated as a leak and retried; the instructions ask for code blocks to avoid this.
- Old leaked replies still show as they were stored on the page; only what is replayed to a model changes.
- Compaction and the rolling summary read stored text as before; a summary of a thread with an old leak may mention it (as data).
- The provider-side cause is not fixed or verified; see the hypotheses above.
