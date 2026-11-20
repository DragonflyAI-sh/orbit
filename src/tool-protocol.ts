import { createHash } from "node:crypto";

// Model-native tool-call protocol written as plain text (docs/tool-protocol-leaks.md).
//
// A provider turns a model's tool calls into structured events (Responses API function_call items, Chat Completions tool_calls) by
// parsing the model's own wire format. When that parsing does not happen (a provider without a parser for that model, a request that
// carried tool history but no `tools`, a cut-off reply), the wire format arrives as ordinary answer text: for DeepSeek models that is
// "DSML" markup such as <｜DSML｜tool_calls><｜DSML｜invoke name="...">. That text is neither an answer nor a tool call.
//
// ORBIT's rule: only validated structured provider tool events dispatch (src/agent.ts runChat). Text that looks like a tool call is
// NEVER parsed or executed, wherever it appears (model text, user messages, tool outputs, stored history, quoted examples). This module
// only RECOGNISES such text in a model's own output, so the reply can be refused or retried instead of shown as an answer.
//
// What counts: the opening of a vendor-specific tool-call envelope OUTSIDE Markdown code (fenced blocks and inline code spans are
// skipped, so a quotation or an XML/code answer in code formatting is kept as it is). Each pattern is a sentinel that does not occur in
// ordinary XML or prose: generic tags such as <invoke> or <function_calls> alone are NOT matched, so valid XML answers are untouched.

export type ProtocolFamily = "dsml" | "deepseek-tokens" | "hermes" | "kimi" | "mistral" | "llama";

const PATTERNS: { family: ProtocolFamily; re: RegExp }[] = [
  // DeepSeek DSML (V3.2 and later): <｜DSML｜tool_calls>, <｜DSML｜function_calls>, <｜DSML｜invoke ...>, closing tags too. The bar is
  // U+FF5C (fullwidth) in the real format; an ASCII bar is accepted as well, and so is a sentinel cut off right after its name.
  { family: "dsml", re: /<\s*\/?\s*[｜|]\s*DSML\s*[｜|]/i },
  // Kimi K2: <|tool_calls_section_begin|>, <|tool_call_begin|>.
  { family: "kimi", re: /<\|tool_calls?_(?:section_)?begin\|>/ },
  // DeepSeek V3/R1 special tokens: <｜tool▁calls▁begin｜>, <｜tool▁call▁begin｜>, <｜tool▁sep｜> (▁ is U+2581; "_" accepted).
  { family: "deepseek-tokens", re: /<[｜|]\s*tool[▁_ ](?:calls?[▁_ ](?:begin|end)|sep|outputs?[▁_ ](?:begin|end))\s*[｜|]>/i },
  // Hermes / Qwen: <tool_call> followed by a JSON object with a name.
  { family: "hermes", re: /<tool_call>\s*\{\s*"name"\s*:/ },
  // Mistral: [TOOL_CALLS] followed by a JSON array/object or a function name and arguments.
  { family: "mistral", re: /\[TOOL_CALLS\]\s*(?:[[{]|[A-Za-z_][\w.-]*\s*\[ARGS\])/ },
  // Llama 3.x built-in tool call prefix.
  { family: "llama", re: /<\|python_tag\|>/ },
];

// Markdown code removed, so only prose remains: fenced blocks (``` or ~~~, an unclosed fence runs to the end, as in CommonMark) and
// inline code spans (a run of N backticks up to the next run of exactly N). Code is replaced by a space, never inspected.
export function withoutCode(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let fence: { ch: string; len: number } | undefined;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = undefined;
      kept.push("");
      continue;
    }
    if (m && !(m[1][0] === "`" && line.slice(line.indexOf(m[1]) + m[1].length).includes("`"))) {
      fence = { ch: m[1][0], len: m[1].length };
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ");
}

export type ProtocolMatch = { family: ProtocolFamily };

// The protocol family whose envelope appears in this model text outside code, or undefined. Never used on user text or tool output.
export function detectProtocolText(text: string): ProtocolMatch | undefined {
  if (!text) return undefined;
  // Cheap pre-check: every sentinel contains one of these characters.
  if (!/[<[]/.test(text)) return undefined;
  const prose = withoutCode(text);
  for (const p of PATTERNS) if (p.re.test(prose)) return { family: p.family };
  return undefined;
}

// Privacy-safe evidence of one rejected model response: the family, sizes, a short digest and where it happened. Never the text itself,
// so it may be logged and shown to the owner. The digest lets two log lines be matched without storing the content.
export type ProtocolDiagnostic = {
  family: ProtocolFamily;
  step: number;
  attempt: number;
  // The model that produced it: "primary" or the fallback's model id.
  model: string;
  // Whether the step was offered tools (false: the forced final step, sent with no tools).
  toolsOffered: boolean;
  chars: number;
  sha256: string;
  // Structured calls that came in the same response (they are run normally when tools were offered; the text never is).
  structuredCalls: number;
  // What ORBIT did: asked the model again, ended the reply with an error, or (the response also had structured calls, which ran)
  // dropped the text, which is never shown or sent on.
  action: "retried" | "refused" | "dropped";
};

export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

// The owner-visible note on a reply that recovered after a rejected response. Never part of the reply's text.
export const PROTOCOL_RETRY_NOTE = (family: ProtocolFamily) =>
  `ORBIT discarded one model response that was raw tool-call markup (${family}) written as text instead of an answer or a valid tool call, and asked the model once more. Nothing in that markup was run.`;

// The reply's error when the bounded recovery did not help.
export const PROTOCOL_REFUSED = (family: ProtocolFamily, retried: boolean) =>
  `The model answered with raw tool-call markup (${family}) instead of a reply or a valid tool call${retried ? ", again after ORBIT asked once more" : ""}. ORBIT did not show it and ran nothing from it; only the tool calls listed with this reply ran. Ask again to retry.`;

// The text that replaces a stored assistant reply made of protocol markup when the conversation is replayed to a model, so an old leak
// (stored before this check existed) cannot teach the model to write tool calls as text. The stored message itself is not changed.
export const REPLAY_PLACEHOLDER = "[ORBIT: this earlier reply was raw tool-call markup written as text, not an answer and not a tool call. Nothing in it was run. It is omitted here.]";

// The line the model is given on the step after a rejected response (src/model.ts roundGuidance).
export const PROTOCOL_RETRY_GUIDANCE = (toolsOffered: boolean) =>
  `ORBIT REJECTED YOUR PREVIOUS RESPONSE: it was tool-call markup written as plain text, which is neither an answer nor a tool call, so nothing in it ran and Rai did not see it. ${
    toolsOffered ? "Call tools only through the tool-calling interface of this request, or answer in plain prose." : "No tools are offered in this step: answer in plain prose with what the tool results above show, and do not write any tool call."
  } To show tool-call markup on purpose, put it in a Markdown code block.`;
