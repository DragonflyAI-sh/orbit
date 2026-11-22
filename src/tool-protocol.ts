import { createHash } from "node:crypto";

// Model-native tool-call protocol written as plain text (docs/tool-protocol-leaks.md).
//
// A provider turns a model's tool calls into structured events (Responses API function_call items, Chat Completions tool_calls) by
// parsing the model's own wire format. When that parsing does not happen (a provider without a parser for that model, a request that
// carried tool history but no `tools`, a cut-off reply), the wire format arrives as ordinary answer text: for DeepSeek models that is
// "DSML" markup such as <｜DSML｜tool_calls><｜DSML｜invoke name="...">. That text is neither an answer nor a tool call.
//
// ORBIT's rule: structured provider tool events dispatch (src/agent.ts runChat), and so does ONE narrow exception: a model step that
// was offered tools, has no structured calls, ended normally, and whose own text is a complete, well-formed DeepSeek DSML block naming
// only offered tools (recoverDsmlCalls below, Rai's decision of 2026-11-21). Those calls then run through exactly the same owner,
// policy, deadline, budget and confirmation checks as structured calls. Nothing else that looks like a tool call is ever parsed or
// executed: not other vendor formats, not markup in user messages, tool outputs, stored history or quoted examples (code blocks), not
// markup on a step offered no tools, and not a cut-off or malformed DSML block. Those are only RECOGNISED, so the reply can be refused
// or retried instead of shown as an answer.
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
  // What ORBIT did: asked the model again, ended the reply with an error, (the response also had structured calls, which ran) dropped
  // the text, which is never shown or sent on, or recovered the DSML calls in the text (recoverDsmlCalls), which then ran like
  // structured calls while the text itself was not shown or sent on.
  action: "retried" | "refused" | "dropped" | "recovered";
  // For "recovered": how many calls were recovered.
  recoveredCalls?: number;
};

export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

// The owner-visible note on a reply that recovered after a rejected response. Never part of the reply's text.
export const PROTOCOL_RETRY_NOTE = (family: ProtocolFamily) =>
  `ORBIT discarded one model response that was raw tool-call markup (${family}) written as text instead of an answer or a valid tool call, and asked the model once more. Nothing in that markup was run.`;

// The owner-visible note on a reply in which tool calls were recovered from DSML text. Never part of the reply's text.
export const PROTOCOL_RECOVERED_NOTE = (n: number) =>
  `ORBIT recovered ${n} tool call${n === 1 ? "" : "s"} that the model wrote as DeepSeek DSML text instead of through the tool-calling interface (the provider did not parse ${n === 1 ? "it" : "them"}). ${n === 1 ? "It ran" : "They ran"} through the same checks as any tool call and ${n === 1 ? "is" : "are"} listed with this reply.`;

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

// ---- DSML recovery (the one exception to "markup never runs") -------------------------------------------------------------------
//
// DeepSeek's DSML tool-call format (V3.2 wraps calls in function_calls, V4 in tool_calls):
//   <｜DSML｜tool_calls>
//   <｜DSML｜invoke name="memory_search">
//   <｜DSML｜parameter name="query" string="true">inbox</｜DSML｜parameter>
//   <｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
// string="true": the value is the literal string; string="false": the value is JSON. The bar is U+FF5C; an ASCII bar is accepted.
//
// recoverDsmlCalls is strict: anything it cannot read exactly returns undefined, and runChat then treats the text as an unparsed leak
// (retry once, then an honest error), as before. It refuses: more than one wrapper block, a wrapper that starts inside Markdown code,
// any DSML outside the wrapper, anything but whitespace between tags, a missing or unknown string attribute, invalid JSON, duplicate
// parameters, a DSML sentinel inside a value, a tool that was not offered on this step, a parameter the tool's schema does not allow
// (when it sets additionalProperties: false), a missing required parameter, no calls, or more than RECOVERED_CALLS_MAX calls.

export type RecoverableTool = { name: string; parameters: Record<string, unknown> };
export type RecoveredCall = { name: string; arguments: string };

// The same per-response limit the OpenRouter adapter applies to structured calls (src/openrouter.ts MAX_TOOL_CALLS).
export const RECOVERED_CALLS_MAX = 8;

const BAR_RE = "[｜|]";
const OPEN = (name: string) => `<\\s*${BAR_RE}\\s*DSML\\s*${BAR_RE}\\s*${name}`;
const CLOSE = (name: string) => `<\\s*\\/\\s*${BAR_RE}\\s*DSML\\s*${BAR_RE}\\s*${name}\\s*>`;
const SENTINEL = new RegExp(`<\\s*\\/?\\s*${BAR_RE}\\s*DSML\\s*${BAR_RE}`, "i");
const WRAPPER = new RegExp(`${OPEN("(tool_calls|function_calls)")}\\s*>([\\s\\S]*?)${CLOSE("(tool_calls|function_calls)")}`, "g");
const INVOKE = new RegExp(`^\\s*${OPEN("invoke")}\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)${CLOSE("invoke")}`);
const PARAM = new RegExp(`^\\s*${OPEN("parameter")}\\s+name\\s*=\\s*"([^"]+)"\\s+string\\s*=\\s*"(true|false)"\\s*>([\\s\\S]*?)${CLOSE("parameter")}`);
const NAME = /^[A-Za-z_][\w.-]{0,63}$/;
// A line that cannot occur in model text, used to ask withoutCode whether a position is in prose.
const PROBE = "\u0000orbit-dsml-probe\u0000";

export function recoverDsmlCalls(text: string, offered: readonly RecoverableTool[]): RecoveredCall[] | undefined {
  if (!text || !SENTINEL.test(text)) return undefined;
  const blocks = [...text.matchAll(WRAPPER)];
  if (blocks.length !== 1) return undefined;
  const block = blocks[0];
  if (block[1].toLowerCase() !== block[3].toLowerCase()) return undefined;
  const start = block.index!;
  // The wrapper must start in prose, not inside a fenced block (a quotation or example is never run).
  if (!withoutCode(text.slice(0, start) + PROBE).includes(PROBE)) return undefined;
  // No DSML outside the wrapper (a second, unclosed or stray call is not guessed at).
  const outside = text.slice(0, start) + text.slice(start + block[0].length);
  if (SENTINEL.test(outside)) return undefined;
  const byName = new Map(offered.map((t) => [t.name, t]));
  const calls: RecoveredCall[] = [];
  let rest = block[2];
  while (rest.trim()) {
    const inv = INVOKE.exec(rest);
    if (!inv) return undefined;
    rest = rest.slice(inv[0].length);
    const tool = byName.get(inv[1]);
    if (!tool) return undefined;
    const args: Record<string, unknown> = {};
    let body = inv[2];
    while (body.trim()) {
      const p = PARAM.exec(body);
      if (!p) return undefined;
      body = body.slice(p[0].length);
      const [, pname, isString, raw] = p;
      if (!NAME.test(pname) || Object.hasOwn(args, pname) || SENTINEL.test(raw)) return undefined;
      if (isString === "true") args[pname] = raw;
      else {
        try {
          args[pname] = JSON.parse(raw);
        } catch {
          return undefined;
        }
      }
    }
    if (!fitsSchema(args, tool.parameters)) return undefined;
    calls.push({ name: tool.name, arguments: JSON.stringify(args) });
    if (calls.length > RECOVERED_CALLS_MAX) return undefined;
  }
  return calls.length ? calls : undefined;
}

// Only what the schema states outright: no parameter it forbids, every parameter it requires. Each tool still checks its own arguments.
function fitsSchema(args: Record<string, unknown>, schema: Record<string, unknown>): boolean {
  const props = schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : undefined;
  if (schema.additionalProperties === false) for (const k of Object.keys(args)) if (!props || !Object.hasOwn(props, k)) return false;
  if (Array.isArray(schema.required)) for (const k of schema.required) if (typeof k !== "string" || !Object.hasOwn(args, k)) return false;
  return true;
}
