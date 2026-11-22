import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_ROUNDS, ModelProtocolError, PROTOCOL_RETRIES_MAX, proposals as newProposals, runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { chatgptModel, ProviderError, stepFromStream, tokenFile } from "../src/chatgpt.ts";
import { fallbackModel } from "../src/fallback.ts";
import { instructions } from "../src/model.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { openrouterConfig } from "../src/openrouter.ts";
import type { OpenRouterConfig } from "../src/openrouter.ts";
import { spendLedger, toMicro } from "../src/spend-ledger.ts";
import { buildItems, buildMessages } from "../src/thread-context.ts";
import { threadService } from "../src/thread-service.ts";
import type { TurnPrep } from "../src/thread-service.ts";
import { threadStore } from "../src/threads.ts";
import { detectProtocolText, RECOVERED_CALLS_MAX, recoverDsmlCalls, REPLAY_PLACEHOLDER, withoutCode } from "../src/tool-protocol.ts";
import type { ProtocolDiagnostic } from "../src/tool-protocol.ts";
import { call, say, scripted } from "./threads-fixture.ts";

// Tool-call protocol markup written as answer text (docs/tool-protocol-leaks.md). Every "model" here is scripted or a fake fetch: nothing
// reaches a provider, and no markup in this file is ever executed. Markup strings are built at runtime from parts.

const BAR = "｜"; // the fullwidth vertical bar DeepSeek's DSML uses
const tag = (name: string, attrs = "", close = false) => `<${close ? "/" : ""}${BAR}DSML${BAR}${name}${attrs}>`;
// The reproduction sample from the report, rebuilt: a memory_search call in DSML.
const DSML =
  tag("tool_calls") +
  tag("invoke", ' name="memory_search"') +
  tag("parameter", ' name="query" string="true"') +
  "inbox acknowledge seen server side orbit web dismiss notification" +
  tag("parameter", "", true) +
  tag("invoke", "", true) +
  tag("tool_calls", "", true);

// The same leak naming a tool that is not offered: never recoverable (src/tool-protocol.ts recoverDsmlCalls), so it exercises the
// retry-then-refuse path.
const LEAK = DSML.replace('name="memory_search"', 'name="inbox_dismiss"');

// A tool that counts its runs, so any execution of markup would show.
function counter(name = "memory_search") {
  const runs: Record<string, unknown>[] = [];
  const tool: ChatTool = { name, description: "d", parameters: { type: "object", properties: {} }, run: async (args) => (runs.push(args), { value: { hits: [] }, provenance: "live", source: `test/${name}` }) };
  return { tool, runs };
}
const user: Item[] = [{ role: "user", content: "go" }];

// A scripted model that also records the instructions each step would have been sent (the rounds the step was given).
function recorded(script: (n: number, tools: string[]) => Step) {
  const seen: { input: Item[]; tools: string[]; text: string }[] = [];
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake/scripted", detail: "t", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (input, limits, notes, tools, opts) => {
      seen.push({ input: [...input], tools: tools.map((t) => t.name), text: instructions(limits, notes, tools.map((t) => t.name), opts?.rounds) });
      return script(seen.length - 1, tools.map((t) => t.name));
    },
  };
  return { model, seen };
}

// ---- detection ------------------------------------------------------------------------------------------------------

test("detection: the reported DSML sample, its ASCII-bar form, a truncated call and other vendor envelopes are recognised", () => {
  assert.equal(detectProtocolText(DSML)?.family, "dsml");
  assert.equal(detectProtocolText(DSML.replaceAll(BAR, "|"))?.family, "dsml");
  assert.equal(detectProtocolText(`I'll search.\n${DSML}`)?.family, "dsml", "prose before the markup does not hide it");
  assert.equal(detectProtocolText(DSML.slice(0, 40))?.family, "dsml", "a call cut off mid-way is still markup");
  assert.equal(detectProtocolText(`<${BAR}tool▁calls▁begin${BAR}><${BAR}tool▁call▁begin${BAR}>function<${BAR}tool▁sep${BAR}>x`)?.family, "deepseek-tokens");
  assert.equal(detectProtocolText('<tool_call>\n{"name": "memory_search", "arguments": {}}\n</tool_call>')?.family, "hermes");
  assert.equal(detectProtocolText("<|tool_calls_section_begin|><|tool_call_begin|>functions.x:0")?.family, "kimi");
  assert.equal(detectProtocolText('[TOOL_CALLS][{"name": "x", "arguments": {}}]')?.family, "mistral");
  assert.equal(detectProtocolText('<|python_tag|>{"name": "x"}')?.family, "llama");
});

test("detection: quotations in Markdown code, valid XML answers and ordinary prose are left alone", () => {
  const keep = [
    "```\n" + DSML + "\n```",
    "~~~xml\n" + DSML + "\n~~~",
    "You quoted `" + DSML + "`; that is DeepSeek's tool-call format.",
    "Here it is:\n````\n```\n" + DSML + "\n```\n````",
    // Unclosed fence: CommonMark runs it to the end, so it is code.
    "```\n" + DSML,
    // Generic XML that merely resembles a call envelope.
    '<function_calls><invoke name="search"><parameter name="q">x</parameter></invoke></function_calls>',
    '<?xml version="1.0"?><config><tool_call name="x"/></config>',
    "<div>Hello</div> and a <b>bold</b> word",
    "DSML is the markup DeepSeek uses for tool calls; ORBIT never runs it.",
    "Mistral emits [TOOL_CALLS] as a control token.",
    "",
  ];
  for (const k of keep) assert.equal(detectProtocolText(k), undefined, k);
  assert.equal(withoutCode("a `x` b").includes("x"), false);
  // Markup after a closed fence is prose again.
  assert.equal(detectProtocolText("```\ncode\n```\n" + DSML)?.family, "dsml");
});

// ---- the tool loop --------------------------------------------------------------------------------------------------

test("literal DSML leak naming a tool not offered: never run, never shown; ORBIT asks once more and the real answer is returned with a note", async () => {
  const { tool, runs } = counter();
  const { model, seen } = recorded((n) => (n === 0 ? say(LEAK) : say("Nothing in the inbox needs acknowledging.")));
  const diags: ProtocolDiagnostic[] = [];
  const out = await runChat({ model, messages: user, limits: [], tools: [tool], onProtocol: (d) => diags.push(d) });
  assert.equal(out.text, "Nothing in the inbox needs acknowledging.");
  assert.equal(runs.length, 0, "the markup named a tool that was not offered; nothing may run");
  assert.equal(out.calls.length, 0);
  assert.equal(seen.length, 2);
  // The retry is the same request: nothing from the rejected response was added to the input, and the tools are still offered.
  assert.deepEqual(seen[1].input, seen[0].input);
  assert.deepEqual(seen[1].tools, ["memory_search"]);
  assert.match(seen[1].text, /ORBIT REJECTED YOUR PREVIOUS RESPONSE/);
  assert.doesNotMatch(seen[0].text, /ORBIT REJECTED/);
  assert.match(out.incomplete!.join(" "), /discarded one model response that was raw tool-call markup \(dsml\)/);
  assert.equal(out.protocol?.length, 1);
  assert.equal(diags[0].action, "retried");
  // Privacy-safe evidence: no model text, only family, sizes and a digest.
  const logged = JSON.stringify(diags);
  assert.equal(logged.includes(BAR), false);
  assert.equal(logged.includes("inbox"), false);
  assert.equal(diags[0].chars, LEAK.length);
  assert.match(diags[0].sha256, /^[0-9a-f]{16}$/);
});

test("repeated leak: bounded to one retry, then an honest error; no markup in the message and no tool run", async () => {
  const { tool, runs } = counter();
  const model = scripted([say(LEAK)]);
  await assert.rejects(
    runChat({ model, messages: user, limits: [], tools: [tool] }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProtocolError);
      assert.match(err.message, /raw tool-call markup \(dsml\) instead of a reply or a valid tool call, again after ORBIT asked once more/);
      assert.match(err.message, /ran nothing from it/);
      assert.equal(err.message.includes(BAR), false);
      assert.deepEqual(err.diagnostics.map((d) => d.action), ["retried", "refused"]);
      return true;
    },
  );
  assert.equal(model.seen.length, 1 + PROTOCOL_RETRIES_MAX);
  assert.equal(runs.length, 0);
});

test("mixed prose and structured calls: the structured call runs exactly once, the markup text is dropped and never run", async () => {
  const { tool, runs } = counter();
  const model = scripted([{ text: `Searching.\n${DSML}`, calls: [call("memory_search", { query: "inbox" })] }, say("Found nothing.")]);
  const diags: ProtocolDiagnostic[] = [];
  const out = await runChat({ model, messages: user, limits: [], tools: [tool], onProtocol: (d) => diags.push(d) });
  assert.equal(out.text, "Found nothing.");
  assert.deepEqual(runs, [{ query: "inbox" }]);
  assert.equal(model.seen.length, 2, "no retry: the step had a valid call");
  assert.deepEqual(diags.map((d) => [d.action, d.structuredCalls]), [["dropped", 1]]);
  assert.equal(out.incomplete, undefined);
  // The markup did not reach the next request.
  assert.equal(JSON.stringify(model.seen[1].input).includes(BAR), false);
});

test("duplicate prevention: a leak after a real call retries without re-running or re-sending that call", async () => {
  const { tool, runs } = counter();
  const { model, seen } = recorded((n) => (n === 0 ? { text: "", calls: [call("memory_search", { query: "a" }, "c1")] } : n === 1 ? say(LEAK) : say("Done.")));
  const out = await runChat({ model, messages: user, limits: [], tools: [tool] });
  assert.equal(out.text, "Done.");
  assert.equal(runs.length, 1);
  assert.equal(out.calls.length, 1);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2].input, seen[1].input, "the retry repeats the same input: one call item, one output item");
  assert.equal(seen[2].input.filter((i) => "type" in i && i.type === "function_call").length, 1);
});

test("tool-loop limit: the forced final step's markup is retried once without tools, and the round budget is unchanged", async () => {
  const { tool, runs } = counter();
  let k = 0;
  const { model, seen } = recorded((_n, tools) => (tools.length ? { text: "", calls: [call("memory_search", { query: `q${k++}` }, `c${k}`)] } : seen.filter((s) => !s.tools.length).length === 1 ? say(DSML) : say("The tool-round budget ran out; here is what I found.")));
  const out = await runChat({ model, messages: user, limits: [], tools: [tool] });
  assert.equal(out.capped, true);
  assert.equal(out.rounds, MAX_ROUNDS);
  assert.equal(runs.length, MAX_ROUNDS);
  assert.equal(seen.length, MAX_ROUNDS + 2, "MAX_ROUNDS tool steps, the final step, and one retry of it");
  assert.deepEqual(seen.at(-1)!.tools, []);
  assert.match(seen.at(-1)!.text, /ORBIT REJECTED YOUR PREVIOUS RESPONSE[\s\S]*No tools are offered in this step/);
  assert.match(seen.at(-1)!.text, /TOOL-ROUND BUDGET EXHAUSTED/);
  assert.equal(out.text, "The tool-round budget ran out; here is what I found.");
});

test("tool-loop limit: markup again on the final step ends the reply with an error, and no further tool runs", async () => {
  const { tool, runs } = counter();
  let k = 0;
  const model = scripted((s) => (s.tools.length ? { text: "", calls: [call("memory_search", { query: `q${k++}` }, `c${k}`)] } : say(DSML)));
  await assert.rejects(runChat({ model, messages: user, limits: [], tools: [tool] }), ModelProtocolError);
  assert.equal(runs.length, MAX_ROUNDS);
  assert.equal(model.seen.length, MAX_ROUNDS + 2);
});

test("a structured call on the final (no-tools) step is never run, and markup there is still rejected", async () => {
  const { tool, runs } = counter();
  const model = scripted((s) => (s.tools.length ? { text: "", calls: [call("memory_search", { query: String(Math.random()) })] } : { text: DSML, calls: [call("memory_search", {})] }));
  await assert.rejects(runChat({ model, messages: user, limits: [], tools: [tool], maxRounds: 1 }), ModelProtocolError);
  assert.equal(runs.length, 1);
});

test("tool output and user messages that contain markup are data: nothing runs from them and they are not rejected", async () => {
  const { tool, runs } = counter();
  const quoting: ChatTool = { ...tool, name: "memory_read", run: async () => ({ value: { note: `A note that quotes ${DSML}` }, provenance: "live", source: "test/read" }) };
  const ask: Item[] = [{ role: "user", content: `Why did you send me this? ${DSML}` }];
  const model = scripted([{ text: "", calls: [call("memory_read", {})] }, say("That was raw DeepSeek tool-call markup:\n\n```\n" + DSML + "\n```\n\nIt was never run.")]);
  const out = await runChat({ model, messages: ask, limits: [], tools: [tool, quoting] });
  assert.equal(runs.length, 0);
  assert.equal(model.seen.length, 2, "no retry for a quotation in a code block");
  assert.ok(out.text.includes(DSML), "the quoted example is preserved in the answer");
  assert.equal((model.seen[0].input[0] as { content: string }).content, `Why did you send me this? ${DSML}`, "the user's quote is sent unchanged");
});

// ---- adapters -------------------------------------------------------------------------------------------------------

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("streaming: DSML split across deltas (inside its delimiter) is assembled and rejected; a streamed function call still runs once", async () => {
  // Split inside the fullwidth sentinel, as a provider's token boundaries may.
  const cut = LEAK.indexOf("DSML") + 2;
  const leak = ev({ type: "response.output_text.delta", delta: LEAK.slice(0, cut) }) + ev({ type: "response.output_text.delta", delta: LEAK.slice(cut) });
  assert.equal(stepFromStream(leak).text, LEAK);
  const fnCall = ev({ type: "response.output_item.done", item: { type: "function_call", call_id: "fc1", name: "memory_search", arguments: '{"query":"x"}' } }) + ev({ type: "response.completed", response: { output: [{ type: "function_call", call_id: "fc1", name: "memory_search", arguments: '{"query":"x"}' }] } });
  const answer = ev({ type: "response.output_text.delta", delta: "All " }) + ev({ type: "response.output_text.delta", delta: "clear." });
  const bodies = [leak, fnCall, answer];
  const sent: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/v1/responses")) return new Response("", { status: 404 });
    sent.push(String(init?.body));
    return new Response(bodies[sent.length - 1] ?? answer);
  }) as unknown as typeof fetch;
  const file = tokenFile(undefined);
  file.write({ access: "access-0", refresh: "refresh-0", expires: Date.now() + 3_600_000, idToken: "x.y.z", clientId: "oaiapp_x", subject: "user-1", scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access" });
  const model = chatgptModel("gpt-x", file, { fetcher });
  const { tool, runs } = counter();
  const out = await runChat({ model, messages: user, limits: [], tools: [tool] });
  assert.equal(out.text, "All clear.");
  assert.deepEqual(runs, [{ query: "x" }]);
  assert.equal(sent.length, 3);
  assert.match(JSON.parse(sent[1]).instructions, /ORBIT REJECTED YOUR PREVIOUS RESPONSE/);
  assert.doesNotMatch(JSON.parse(sent[2]).instructions, /ORBIT REJECTED/);
});

const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
const orConfig = () => {
  const c = openrouterConfig(
    { ORBIT_OPENROUTER_ENABLED: "1", ORBIT_OPENROUTER_MODEL: "vendor/dsml-model", ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.2", ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.4", ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "2048", CREDENTIALS_DIRECTORY: "/creds" },
    () => KEY,
  );
  assert.equal(c.state, "ready");
  return c as Extract<OpenRouterConfig, { state: "ready" }>;
};
function fallbackWorld(contents: { content: string; finish?: string }[]) {
  const requests: any[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const r = contents[Math.min(requests.length - 1, contents.length - 1)];
    return new Response(JSON.stringify({ choices: [{ finish_reason: r.finish ?? "stop", message: { content: r.content } }], usage: { cost: 0.0001 } }));
  }) as unknown as typeof fetch;
  const primary: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "chatgpt-token-sharing/gpt-x", detail: "", verifiedAt: new Date().toISOString() }),
    reply: async () => {
      throw new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", new Date(Date.now() + 3_600_000).toISOString());
    },
    step: async () => {
      throw new ProviderError("usage_limit", "ChatGPT usage limit reached for this plan.", new Date(Date.now() + 3_600_000).toISOString());
    },
  };
  const ledger = spendLedger(undefined, { dailyMicro: toMicro(5), totalMicro: toMicro(150) });
  return { model: fallbackModel({ primary, config: orConfig(), ledger, fetcher }), requests };
}

test("fallback path: OpenRouter DSML content for a tool not offered (finish stop, no tool_calls) is retried once and never run", async () => {
  const { model, requests } = fallbackWorld([{ content: LEAK }, { content: "Answer from the fallback." }]);
  const { tool, runs } = counter();
  const diags: ProtocolDiagnostic[] = [];
  const out = await runChat({ model, messages: user, limits: [], tools: [tool], fallback: true, onProtocol: (d) => diags.push(d) });
  assert.equal(out.text, "Answer from the fallback.");
  assert.equal(out.fallback?.model, "vendor/dsml-model");
  assert.equal(runs.length, 0);
  assert.equal(requests.length, 2, "one paid retry, no more");
  assert.match(requests[1].messages[0].content, /ORBIT REJECTED YOUR PREVIOUS RESPONSE/);
  assert.equal(JSON.stringify(requests[1].messages).includes(BAR), false, "the rejected markup is not sent back");
  assert.equal(diags[0].model, "vendor/dsml-model");
});

test("fallback path: truncated DSML (finish length) twice ends in an error that names the fallback model, after two paid requests", async () => {
  const { model, requests } = fallbackWorld([{ content: DSML.slice(0, 60), finish: "length" }]);
  const { tool, runs } = counter();
  await assert.rejects(runChat({ model, messages: user, limits: [], tools: [tool], fallback: true }), (err: unknown) => {
    assert.ok(err instanceof ModelProtocolError);
    assert.match(err.message, /OpenRouter fallback \(vendor\/dsml-model\)/);
    assert.match(err.incomplete.join(" "), /cut off at the output limit/);
    return true;
  });
  assert.equal(requests.length, 2);
  assert.equal(runs.length, 0);
});

// ---- persistence, reload and replay ---------------------------------------------------------------------------------

const prep = (tools: ChatTool[]): TurnPrep => ({ memory: [], limits: [], tools, isOwner: true });

test("persisted thread: a refused reply is stored as an error without markup, survives reload, and the user's quote is kept verbatim", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "orbit-protocol-")), "threads");
  const threads = threadStore(dir);
  const logs: unknown[] = [];
  const { tool, runs } = counter();
  const model = scripted((_s, n) => (n < 2 ? say(LEAK) : say("Second try worked.")));
  const svc = threadService({ threads, model, proposals: newProposals(), onProtocol: (p) => logs.push(p) });
  const t = threads.create("Leak");
  const quote = `What is this? ${LEAK}`;
  const first = await svc.turn(t.id, quote, prep([tool]));
  assert.match(first.error!, /raw tool-call markup \(dsml\)/);
  const stored = threads.get(t.id)!;
  const [u, a] = stored.messages;
  assert.equal(u.text, quote, "the user's quotation is stored exactly");
  assert.equal(a.status, "error");
  assert.equal(a.text.includes(BAR) || a.error!.includes(BAR), false);
  assert.equal(JSON.stringify(svc.view(t.id)).split(BAR).length - 1, quote.split(BAR).length - 1, "the only markup on the page is the user's own quote");
  // Reloaded from disk by a fresh store, as after a restart.
  const reloaded = threadStore(dir).get(t.id)!;
  assert.equal(reloaded.messages[0].text, quote);
  assert.equal(reloaded.messages[1].status, "error");
  assert.equal(JSON.stringify(reloaded.messages[1]).includes(BAR), false);
  assert.equal(runs.length, 0);
  assert.equal(logs.length, 2);
  assert.equal(JSON.stringify(logs).includes(BAR), false);
  // Next turn: the error reply is not replayed, the user's quote is.
  const second = await svc.turn(t.id, "try again", prep([tool]));
  assert.equal(second.error, undefined);
  const input = model.seen.at(-1)!.input;
  assert.deepEqual(input.filter((i) => "role" in i && i.role === "assistant"), []);
  assert.equal((input[0] as { content: string }).content, quote);
});

test("replay: a leaked reply stored before this check is replaced by a placeholder for the model; user text and code answers are kept", () => {
  const threads = threadStore(undefined);
  const t = threads.create("Old");
  const add = (userText: string, answer: string) => {
    threads.appendUser(t.id, userText);
    const mid = threads.beginAssistant(t.id);
    threads.patchMessage(t.id, mid, { text: answer, status: "done" });
  };
  add("search my inbox", DSML);
  add(`quote: ${DSML}`, "```\n" + DSML + "\n```");
  add("an XML example please", '<invoke name="x"><parameter name="y">1</parameter></invoke>');
  const stored = threads.get(t.id)!;
  assert.equal(stored.messages[1].text, DSML, "the stored message itself is not rewritten");
  for (const items of [buildItems(stored), buildMessages(stored)]) {
    const contents = items.map((i) => ("role" in i ? i.content : ""));
    assert.equal(contents[1], REPLAY_PLACEHOLDER);
    assert.equal(contents[2], `quote: ${DSML}`);
    assert.equal(contents[3], "```\n" + DSML + "\n```");
    assert.equal(contents[5], '<invoke name="x"><parameter name="y">1</parameter></invoke>');
  }
});

test("plain reply path (no tools): a markup reply is refused, not stored as the answer", async () => {
  const threads = threadStore(undefined);
  const model: ModelPort = { status: () => ({ port: "model", state: "live", impl: "fake/plain", detail: "", verifiedAt: new Date().toISOString() }), reply: async () => ({ value: DSML, provenance: "live", source: "model/fake" }) };
  const svc = threadService({ threads, model, proposals: newProposals(), onProtocol: () => {} });
  const t = threads.create("Plain");
  const res = await svc.turn(t.id, "hi", prep([]));
  assert.match(res.error!, /raw tool-call markup/);
  assert.equal(threads.get(t.id)!.messages[1].text.includes(BAR), false);
});

test("normal answers and genuine tool calls are unchanged: one run per call, no retry, no notes", async () => {
  const { tool, runs } = counter();
  const model = scripted([{ text: "", calls: [call("memory_search", { query: "a" })] }, say("Result: `<tool_call>` tags are Hermes format; <b>bold</b> stays.")]);
  const out = await runChat({ model, messages: user, limits: [], tools: [tool] });
  assert.equal(runs.length, 1);
  assert.equal(model.seen.length, 2);
  assert.equal(out.protocol, undefined);
  assert.equal(out.incomplete, undefined);
  assert.match(out.text, /<b>bold<\/b> stays/);
});

test("a recovered reply does not inherit the rejected response's completeness notes", async () => {
  const { model } = fallbackWorld([{ content: DSML.slice(0, 60), finish: "length" }, { content: "Complete answer." }]);
  const { tool } = counter();
  const out = await runChat({ model, messages: user, limits: [], tools: [tool], fallback: true });
  assert.equal(out.text, "Complete answer.");
  assert.doesNotMatch(out.incomplete!.join(" "), /cut off at the output limit/);
  assert.match(out.incomplete!.join(" "), /asked the model once more/);
});

// ---- DSML recovery (src/tool-protocol.ts recoverDsmlCalls; Rai's decision of 2026-11-21) --------------------------------------------

const invoke = (name: string, params: [string, string, boolean?][]) =>
  tag("invoke", ` name="${name}"`) + params.map(([k, v, json]) => tag("parameter", ` name="${k}" string="${json ? "false" : "true"}"`) + v + tag("parameter", "", true)).join("\n") + tag("invoke", "", true);
const wrap = (body: string, w = "tool_calls") => tag(w) + "\n" + body + "\n" + tag(w, "", true);
const offered = [
  { name: "memory_search", parameters: { type: "object", properties: {} } },
  { name: "vault_append_section", parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" }, n: { type: "integer" } }, required: ["path", "text"], additionalProperties: false } },
];

test("recovery: well-formed DSML (V4 tool_calls, V3.2 function_calls, ASCII bars, JSON values, several calls, prose before) is read exactly", () => {
  assert.deepEqual(recoverDsmlCalls(DSML, offered), [{ name: "memory_search", arguments: JSON.stringify({ query: "inbox acknowledge seen server side orbit web dismiss notification" }) }]);
  assert.deepEqual(recoverDsmlCalls(DSML.replaceAll(BAR, "|"), offered)?.length, 1);
  const two = wrap(invoke("memory_search", [["query", "a"]]) + "\n" + invoke("vault_append_section", [["path", "Inbox/x.md"], ["text", "line with `code` and <b>tags</b>\n- item"], ["n", "3", true]]), "function_calls");
  const got = recoverDsmlCalls(`I'll search and then note it.\n\n${two}\n`, offered)!;
  assert.deepEqual(got.map((c) => [c.name, JSON.parse(c.arguments)]), [
    ["memory_search", { query: "a" }],
    ["vault_append_section", { path: "Inbox/x.md", text: "line with `code` and <b>tags</b>\n- item", n: 3 }],
  ]);
});

test("recovery: anything not exactly well-formed and offered is refused (left to the retry path)", () => {
  const ok = invoke("memory_search", [["query", "a"]]);
  const refuse: [string, string][] = [
    ["a tool not offered", LEAK],
    ["truncated", DSML.slice(0, DSML.length - 10)],
    ["inside a fenced code block", "```\n" + DSML + "\n```"],
    ["inside an unclosed fence", "```\n" + DSML],
    ["two wrapper blocks", DSML + "\n" + DSML],
    ["stray DSML outside the wrapper", DSML + tag("invoke", ' name="memory_search"')],
    ["mismatched wrapper tags", tag("tool_calls") + ok + tag("function_calls", "", true)],
    ["text between tags", wrap("first: " + ok)],
    ["no string attribute", wrap(tag("invoke", ' name="memory_search"') + tag("parameter", ' name="q"') + "a" + tag("parameter", "", true) + tag("invoke", "", true))],
    ["invalid JSON", wrap(invoke("memory_search", [["q", "{nope", true]]))],
    ["duplicate parameter", wrap(invoke("memory_search", [["q", "a"], ["q", "b"]]))],
    ["DSML inside a value", wrap(invoke("memory_search", [["q", tag("invoke", ' name="x"')]]))],
    ["a parameter the schema forbids", wrap(invoke("vault_append_section", [["path", "p"], ["text", "t"], ["extra", "x"]]))],
    ["a required parameter missing", wrap(invoke("vault_append_section", [["path", "p"]]))],
    ["an empty wrapper", wrap("")],
    ["too many calls", wrap(Array.from({ length: RECOVERED_CALLS_MAX + 1 }, () => ok).join("\n"))],
    ["not DSML at all", '<function_calls><invoke name="memory_search"><parameter name="q">a</parameter></invoke></function_calls>'],
  ];
  for (const [why, text] of refuse) assert.equal(recoverDsmlCalls(text, offered), undefined, why);
  assert.equal(recoverDsmlCalls(DSML, []), undefined, "nothing offered, nothing recovered");
});

test("recovery in the tool loop: a DSML call runs once like a structured call, with a note, no retry, and is sent back structured", async () => {
  const { tool, runs } = counter();
  const { model, seen } = recorded((n) => (n === 0 ? say(`Let me look.\n${DSML}`) : say("Nothing needs acknowledging.")));
  const diags: ProtocolDiagnostic[] = [];
  const done: string[] = [];
  const out = await runChat({ model, messages: user, limits: [], tools: [tool], onProtocol: (d) => diags.push(d), onCall: (c) => void done.push(c.call_id) });
  assert.equal(out.text, "Nothing needs acknowledging.");
  assert.deepEqual(runs, [{ query: "inbox acknowledge seen server side orbit web dismiss notification" }]);
  assert.equal(out.calls.length, 1);
  assert.equal(seen.length, 2, "no retry: the recovered call is the step's result");
  assert.doesNotMatch(seen[1].text, /ORBIT REJECTED/);
  assert.deepEqual(diags.map((d) => [d.action, d.recoveredCalls]), [["recovered", 1]]);
  assert.match(out.incomplete!.join(" "), /recovered 1 tool call that the model wrote as DeepSeek DSML text/);
  assert.deepEqual(done, ["call_dsml_0_0_0"]);
  const next = JSON.stringify(seen[1].input);
  assert.equal(next.includes(BAR), false, "the markup itself is not sent on; the call goes back as a structured item");
  assert.equal(seen[1].input.filter((i) => "type" in i && i.type === "function_call").length, 1);
});

test("recovery keeps the policy gate: a recovered call the policy refuses does not run", async () => {
  const { tool, runs } = counter();
  const model = scripted([say(DSML), say("I was not allowed to search.")]);
  const out = await runChat({ model, messages: user, limits: [], tools: [tool], allow: () => "refused by policy" });
  assert.equal(runs.length, 0);
  assert.equal(out.calls[0]?.ok, false);
  assert.equal(out.text, "I was not allowed to search.");
});

test("recovery: after a retry a well-formed DSML response is recovered; a leak on the no-tools final step never is", async () => {
  const { tool, runs } = counter();
  const model = scripted([say(LEAK), say(DSML), say("Done.")]);
  const out = await runChat({ model, messages: user, limits: [], tools: [tool] });
  assert.equal(out.text, "Done.");
  assert.equal(runs.length, 1);
  assert.equal(out.protocol?.map((d) => d.action).join(), "retried,recovered");
  const { tool: t2, runs: r2 } = counter();
  const capped = scripted((s) => (s.tools.length ? { text: "", calls: [call("memory_search", { query: String(Math.random()) })] } : say(DSML)));
  await assert.rejects(runChat({ model: capped, messages: user, limits: [], tools: [t2], maxRounds: 1 }), ModelProtocolError);
  assert.equal(r2.length, 1, "only the structured call of round 0 ran");
});

test("fallback path: OpenRouter DSML content (finish stop) is recovered and run once; a complete block cut at the limit is not", async () => {
  const { model, requests } = fallbackWorld([{ content: DSML }, { content: "Answer from the fallback." }]);
  const { tool, runs } = counter();
  const diags: ProtocolDiagnostic[] = [];
  const out = await runChat({ model, messages: user, limits: [], tools: [tool], fallback: true, onProtocol: (d) => diags.push(d) });
  assert.equal(out.text, "Answer from the fallback.");
  assert.equal(runs.length, 1);
  assert.equal(requests.length, 2, "the call's result went back in the second request; no retry");
  const sentBack = requests[1].messages.find((m: any) => m.role === "assistant" && m.tool_calls);
  assert.equal(sentBack.tool_calls[0].function.name, "memory_search");
  assert.equal(JSON.stringify(requests[1].messages).includes(BAR), false);
  assert.equal(diags[0].model, "vendor/dsml-model");
  const cut = fallbackWorld([{ content: DSML, finish: "length" }, { content: "Complete answer." }]);
  const { tool: t2, runs: r2 } = counter();
  const out2 = await runChat({ model: cut.model, messages: user, limits: [], tools: [t2], fallback: true });
  assert.equal(r2.length, 0, "a reply cut off at the output limit is never run, however complete it looks");
  assert.equal(out2.text, "Complete answer.");
});
