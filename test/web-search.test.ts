import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptModel, tokenFile, withSources } from "../src/chatgpt.ts";
import { instructions } from "../src/model.ts";
import { nowNote } from "../src/time.ts";

// Research before answering (docs/discord.md is not the place; see the instructions in src/model.ts): the model gets the current
// date on the owner's clock in every turn, and the provider's web search tool with guidance to use it for anything current or local.

const saved = () => ({ access: "a", refresh: "r", expires: Date.now() + 3_600_000, idToken: "x.y.z", clientId: "c", subject: "s", scope: "openid" });
const sse = (text: string, annotations: object[] = []) =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
  `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "web_search_call", id: "ws1", status: "completed" }, { type: "message", content: [{ type: "output_text", text, annotations }] }] } })}\n\n`;
const tool = { name: "memory_search", description: "search", parameters: { type: "object", properties: {}, additionalProperties: false } };

test("the Now note gives weekday, date, time and zone on the owner's clock, and the home area when set", () => {
  const note = nowNote(new Date("2026-11-28T08:30:00Z"), "America/Los_Angeles", "San Diego, CA");
  assert.match(note, /^### Now\nSaturday, November 28, 2026 at 12:30 AM PST \(America\/Los_Angeles; 2026-11-28T08:30:00.000Z\)\. Home area: San Diego, CA\.$/);
  assert.doesNotMatch(nowNote(new Date(), "America/Los_Angeles", undefined), /Home area/);
});

test("every step offers web search with research guidance; cited pages are listed under the answer", async () => {
  const file = tokenFile(undefined);
  file.write(saved());
  const bodies: any[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse("The market runs Saturday 9-1.", [{ type: "url_citation", url: "https://city.example.gov/market?utm_source=openai", title: "City farmers market" }]));
  }) as unknown as typeof fetch;
  const model = chatgptModel("gpt-x", file, { fetcher });
  const step = await model.step!([{ role: "user", content: "when is the market?" }], [], "### Now\nSaturday", [tool]);
  assert.deepEqual(bodies[0].tools.map((t: any) => t.type === "web_search" ? "web_search" : t.name), ["memory_search", "web_search"]);
  assert.match(bodies[0].instructions, /Research before answering when the answer depends on the present or a place/);
  assert.match(bodies[0].instructions, /resolve "today", "tomorrow", "this weekend"/);
  assert.equal(step.text, "The market runs Saturday 9-1.\n\nSources:\n- [City farmers market](https://city.example.gov/market)");
  assert.match(model.status().detail, /Live web search is offered/);
});

test("a backend that refuses web search: asked again without it, switched off for the process, and the status says why", async () => {
  const file = tokenFile(undefined);
  file.write(saved());
  const bodies: any[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.tools?.some((t: any) => t.type === "web_search")) return new Response(JSON.stringify({ error: { message: "Tool 'web_search' is not supported with this model.", type: "invalid_request_error" } }), { status: 400 });
    return new Response(sse("ok"));
  }) as unknown as typeof fetch;
  const model = chatgptModel("gpt-x", file, { fetcher });
  assert.equal((await model.step!([{ role: "user", content: "hi" }], [], undefined, [tool])).text, "ok");
  assert.equal((await model.step!([{ role: "user", content: "again" }], [], undefined, [tool])).text, "ok");
  assert.deepEqual(bodies.map((b) => b.tools.some((t: any) => t.type === "web_search")), [true, false, false], "refused once, then never offered again");
  assert.match(bodies[1].instructions, /no live web search in this step/);
  assert.match(model.status().detail, /Live web search is off: the provider refused/);
});

test("ORBIT_WEB_SEARCH=off: no tool, and the model is told it cannot check current facts", async () => {
  const file = tokenFile(undefined);
  file.write(saved());
  const bodies: any[] = [];
  const fetcher = (async (_u: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), new Response(sse("ok")))) as unknown as typeof fetch;
  await chatgptModel("gpt-x", file, { fetcher, webSearch: false }).step!([{ role: "user", content: "hi" }], [], undefined, [tool]);
  assert.ok(!bodies[0].tools.some((t: any) => t.type === "web_search"));
  assert.match(instructions([], undefined, ["memory_search"]), /no live web search in this step/);
});

test("withSources leaves text alone when there are no citations or the link is already in the text", () => {
  assert.equal(withSources("plain", []), "plain");
  const out = [{ type: "message", content: [{ type: "output_text", text: "", annotations: [{ type: "url_citation", url: "https://a.example/x", title: "A" }] }] }] as any;
  assert.equal(withSources("see https://a.example/x", out), "see https://a.example/x");
});
