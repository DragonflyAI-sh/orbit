import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { attachmentStore } from "../src/attachments.ts";
import { chatgptModel, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { openaiModel, responsesTools, strictSchema } from "../src/model.ts";
import type { ModelPort, Step, ToolDef } from "../src/model.ts";
import { listArgs, PHOTO_LIST_LIMIT_DEFAULT, PHOTO_LIST_LIMIT_MAX, PHOTO_TOOL_NAMES, photoRef, photoTools } from "../src/photo-access.ts";
import type { PhotoSources } from "../src/photo-access.ts";
import { MODEL_IMAGE_BYTES_MAX } from "../src/photo-context.ts";
import { smallJpeg } from "./jpeg-fixture.ts";

// The photo tools' optional-argument contract (docs/photos.md, "Tool contracts per provider"), through the schemas each transport
// actually sends and the agent's real dispatch. The bug this guards: "show the photos I uploaded today" failed because a model filled
// photos_list's timezone with "" (the Responses API's strict function schemas, its documented default, require every property, so
// models fill every field), and the tool took "" as an invalid zone name. Synthetic photos only; every provider answer is scripted at
// the adapter's HTTP boundary; no model is called. These prove what ORBIT serializes and runs, not what a live model sends.

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZONE = "America/Los_Angeles";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
// `query` was added by the photo-recall search (docs/photo-recall.md); it is optional like every other field.
const LIST_KEYS = ["conversation", "day", "from", "to", "timezone", "includeArchived", "limit", "cursor", "query"];
const ALL_NULL = Object.fromEntries(LIST_KEYS.map((k) => [k, null]));

// A small JSON Schema checker for the subset ORBIT's tool schemas use (type incl. "null" unions, enum, required, additionalProperties,
// minimum/maximum, minItems/maxItems, items). Enough to say whether a model's arguments conform to the schema a transport sent.
function conforms(schema: any, v: unknown, path = "$"): string[] {
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (types.length && !types.includes(kind) && !(kind === "integer" && types.includes("number"))) return [`${path}: ${kind} is not ${types.join("|")}`];
  if (schema.enum && !schema.enum.includes(v)) return [`${path}: not in enum`];
  const out: string[] = [];
  if (kind === "object") {
    const o = v as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) out.push(`${path}.${r}: required`);
    for (const [k, x] of Object.entries(o)) {
      if (schema.properties?.[k]) out.push(...conforms(schema.properties[k], x, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
    }
  }
  if (kind === "integer" || kind === "number") {
    if (schema.minimum !== undefined && (v as number) < schema.minimum) out.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && (v as number) > schema.maximum) out.push(`${path}: above maximum`);
  }
  if (kind === "array") {
    const a = v as unknown[];
    if (schema.minItems !== undefined && a.length < schema.minItems) out.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && a.length > schema.maxItems) out.push(`${path}: too many items`);
    if (schema.items) a.forEach((x, i) => out.push(...conforms(schema.items, x, `${path}[${i}]`)));
  }
  return out;
}

function fixture(start = "2026-11-15T18:00:00Z", configured: string | null = ZONE) {
  const zone = configured ?? undefined;
  const clock = { t: Date.parse(start) };
  const now = () => new Date(clock.t);
  const att = attachmentStore(join(mkdtempSync(join(tmpdir(), "orbit-photo-contract-")), "attachments"), { now });
  const chats = new Map<string, { title: string; archived: boolean; messages: { id: string; at: string; text: string; ids: string[] }[] }>();
  const assistantMsgs: { id: string; at: string; text: string; ids: string[] }[] = [];
  const sources: PhotoSources = { assistant: () => ({ messages: assistantMsgs, archivedChunks: 0 }), chat: (tid) => chats.get(tid) };
  let n = 0;
  const send = (scope: string, at: string, count = 1, text = "") => {
    const keep = clock.t;
    clock.t = Date.parse(at);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(att.put(scope, smallJpeg(++n, 32, 24), { width: 32, height: 24 }).meta.id);
    att.bind(ids, scope);
    const msg = { id: `m${n}`, at, text, ids };
    if (scope === "assistant") assistantMsgs.push(msg);
    else {
      const tid = scope.slice(5);
      if (!chats.has(tid)) chats.set(tid, { title: `Thread ${tid.slice(0, 4)}`, archived: false, messages: [] });
      chats.get(tid)!.messages.push(msg);
    }
    clock.t = keep;
    return ids.map(photoRef);
  };
  const tools = (caller = "assistant:assistant", isOwner = true) => photoTools({ attachments: att, sources, caller, isOwner, now, zone });
  const list = async (a: Record<string, unknown>, caller?: string) => ((await tools(caller).find((t) => t.name === "photos_list")!.run(a)) as any).value;
  return { clock, chats, send, tools, list };
}

const defsOf = (tools: ChatTool[]): ToolDef[] => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, ...(t.strict ? { strict: true } : {}) }));

// ---- the exported schemas, per transport -----------------------------------------------------------------------------------------

test("canonical schema (non-strict transports): every photos_list argument is optional; photos_inspect requires a bounded refs list", () => {
  const [list, inspect] = fixture().tools();
  const p = list!.parameters as any;
  assert.deepEqual(p.required, []);
  assert.equal(p.additionalProperties, false);
  assert.deepEqual(Object.keys(p.properties), LIST_KEYS);
  assert.equal(p.properties.timezone.type, "string");
  assert.equal(p.properties.includeArchived.type, "boolean");
  assert.deepEqual([p.properties.limit.type, p.properties.limit.minimum, p.properties.limit.maximum], ["integer", 1, PHOTO_LIST_LIMIT_MAX]);
  // Guidance agrees with the runtime: leave out or null, never guess a zone.
  assert.match(list!.description, /Every argument is optional: leave it out or pass null/);
  assert.match(list!.description, /otherwise leave it out or null \(never guess one\)/);
  assert.match(p.properties.timezone.description, /Leave out or null to use his configured zone/);
  assert.match(p.properties.conversation.description, /an empty string is refused/);
  const q = inspect!.parameters as any;
  assert.deepEqual(q.required, ["refs"]);
  assert.deepEqual([q.properties.refs.minItems, q.properties.refs.maxItems], [1, 10]);
  // With the canonical schema {} is a valid call.
  assert.deepEqual(conforms(p, {}), []);
  assert.notDeepEqual(conforms(q, {}), []);
});

test("Responses API schema (strict): every property required, each optional one nullable; refs stays required and non-null", () => {
  const tools = fixture().tools();
  const sent = responsesTools(defsOf(tools)) as any[];
  const list = sent.find((t) => t.name === "photos_list");
  const inspect = sent.find((t) => t.name === "photos_inspect");
  for (const t of [list, inspect]) assert.equal(t.strict, true);
  assert.deepEqual(list.parameters.required, LIST_KEYS);
  assert.equal(list.parameters.additionalProperties, false);
  for (const k of LIST_KEYS) assert.ok(list.parameters.properties[k].type.includes("null"), k);
  assert.deepEqual(list.parameters.properties.timezone.type, ["string", "null"]);
  assert.deepEqual(list.parameters.properties.limit.type, ["integer", "null"]);
  assert.deepEqual(list.parameters.properties.includeArchived.type, ["boolean", "null"]);
  assert.equal(list.parameters.properties.limit.maximum, PHOTO_LIST_LIMIT_MAX);
  assert.deepEqual(inspect.parameters, tools[1]!.parameters, "refs was already required: unchanged");
  // The canonical definition is not mutated by serialization.
  assert.deepEqual((tools[0]!.parameters as any).required, []);
  // What a model may send under each schema: under strict, {} does not conform (that is why models fill every field) and the
  // absence representation is null; "" for timezone conforms too, so the tool must take it.
  assert.notDeepEqual(conforms(list.parameters, {}), []);
  assert.deepEqual(conforms(list.parameters, ALL_NULL), []);
  assert.deepEqual(conforms(list.parameters, { ...ALL_NULL, timezone: "" }), []);
  assert.notDeepEqual(conforms(list.parameters, { ...ALL_NULL, limit: "5" }), []);
  assert.notDeepEqual(conforms(inspect.parameters, { refs: null }), []);
  // Other tools are sent exactly as before: no strict flag, no rewrite.
  const plain: ToolDef = { name: "plain", description: "d", parameters: { type: "object", properties: { x: { type: "string" } }, required: [], additionalProperties: false } };
  assert.deepEqual(responsesTools([plain]), [{ type: "function", ...plain }]);
  // A schema that cannot be made strict is a programming error, not a silently half-converted request.
  assert.throws(() => strictSchema("bad", { type: "object", properties: { x: {} }, additionalProperties: false }), /has no type/);
  assert.throws(() => strictSchema("bad", { type: "object", properties: {} }), /additionalProperties false/);
});

// The OpenRouter fallback is offered the photo tools too, in the canonical form: test/fallback-parity.test.ts drives the real client.

// ---- through the real adapters and runChat: model-generated arguments under each schema mode -----------------------------------

const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
function adapter(kind: "chatgpt" | "openai", calls: unknown[]) {
  const bodies: any[] = [];
  let i = 0;
  const answer = () => {
    const args = calls[i++];
    const output = args === undefined ? [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] : [{ type: "function_call", call_id: `call_${i}`, name: "photos_list", arguments: JSON.stringify(args) }];
    return output;
  };
  if (kind === "openai") {
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ output: answer() }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { model: openaiModel("gpt-6-astra", ["test", "key", "x".repeat(8)].join("-"), fetcher), bodies };
  }
  const file = tokenFile(undefined);
  const tokens: Tokens = { access: "access-0", refresh: "refresh-0", expires: Date.now() + 36_000_000, idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`, clientId: "oaiapp_x", subject: "user-1", scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access" };
  file.write(tokens);
  const fetcher = (async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/responses")) return new Response("", { status: 404 });
    bodies.push(JSON.parse(String(init.body)));
    return new Response(event({ type: "response.completed", response: { output: answer() } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { model: chatgptModel("gpt-6-astra", file, { fetcher }) as ModelPort, bodies };
}
const outputsOf = (body: any) => body.input.filter((x: any) => x.type === "function_call_output").map((x: any) => JSON.parse(x.output));

for (const kind of ["chatgpt", "openai"] as const) {
  test(`tool loop (${kind}, strict Responses schema): "photos uploaded today" with every field null, "" or blank lists today's photos in the owner zone`, async () => {
    // 2026-11-15 17:30 PST is already 2026-11-16 01:30 UTC: the server's UTC day differs from Rai's.
    const f = fixture("2026-11-16T01:30:00Z");
    const today = f.send(`chat:${T1}`, "2026-11-15T20:00:00Z", 2, "market");
    f.send(`chat:${T1}`, "2026-11-15T07:30:00Z", 1, "late on the 14th PST");
    const variants = [ALL_NULL, { ...ALL_NULL, timezone: "" }, { ...ALL_NULL, timezone: "   ", day: "", from: "", to: "", cursor: "" }, { ...ALL_NULL, day: "today", includeArchived: false, limit: 10 }];
    const a = adapter(kind, variants);
    const out = await runChat({ model: a.model, messages: [{ role: "user", content: "show the photos I uploaded today" }], limits: [], tools: f.tools(), media: { support: () => ({ ok: true, detail: "test" }) as any, images: 0, bytes: 0, maxImages: 10, maxBytes: MODEL_IMAGE_BYTES_MAX } });
    assert.equal(out.text, "Done.");
    // The wire carried the strict schema the arguments were generated against.
    const wire = a.bodies[0].tools.find((t: any) => t.name === "photos_list");
    assert.equal(wire.strict, true);
    for (const v of variants) assert.deepEqual(conforms(wire.parameters, v), [], JSON.stringify(v));
    const outs = outputsOf(a.bodies.at(-1));
    assert.equal(outs.length, variants.length);
    for (const o of outs) {
      assert.equal(o.ok, true, o.error);
      assert.equal(o.result.timezone.zone, ZONE);
      assert.match(o.result.timezone.source, /configured owner time zone/);
      assert.equal(o.result.window.firstDay, "2026-11-15");
      assert.deepEqual(o.result.photos.map((p: any) => p.ref).sort(), [...today].sort());
      assert.equal(o.result.matches, 2);
    }
    assert.ok(out.calls.every((c) => c.ok));
  });
}

test("tool loop (canonical schema mode): a model that leaves every optional field out gets the same answer", async () => {
  const f = fixture("2026-11-16T01:30:00Z");
  f.send(`chat:${T1}`, "2026-11-15T20:00:00Z", 2);
  let n = 0;
  const seen: ToolDef[][] = [];
  const outs: any[] = [];
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "fake" }),
    step: async (input, _l, _n, tools): Promise<Step> => {
      seen.push(tools);
      const last = input.at(-1) as any;
      if (last?.type === "function_call_output") outs.push(JSON.parse(last.output));
      return n++ === 0 ? { text: "", calls: [{ call_id: "c1", name: "photos_list", arguments: "{}" }] } : { text: "ok", calls: [] };
    },
  };
  await runChat({ model, messages: [{ role: "user", content: "photos today?" }], limits: [], tools: f.tools() });
  // runChat hands the transport the canonical schema plus the strict opt-in; a non-strict transport sends `parameters` as is.
  const def = seen[0]!.find((t) => t.name === "photos_list")!;
  assert.deepEqual((def.parameters as any).required, []);
  assert.equal(def.strict, true);
  assert.equal(outs[0].ok, true, outs[0].error);
  assert.equal(outs[0].result.matches, 2);
  assert.equal(outs[0].result.timezone.zone, ZONE);
});

// ---- timezone at the tool boundary ----------------------------------------------------------------------------------------------

test("timezone: omitted, null, empty and whitespace use the owner zone; a valid zone wins (trimmed); invalid names and wrong types are refused", async () => {
  const f = fixture("2026-11-16T01:30:00Z");
  f.send(`chat:${T1}`, "2026-11-15T20:00:00Z");
  for (const tz of [undefined, null, "", "   ", "\t\n"]) {
    const r = await f.list(tz === undefined ? {} : { timezone: tz });
    assert.equal(r.timezone.zone, ZONE, JSON.stringify(tz));
    assert.equal(r.window.firstDay, "2026-11-15");
    assert.equal(r.window.startsAt, "2026-11-15T08:00:00.000Z");
  }
  const named = await f.list({ timezone: "Europe/Paris" });
  assert.deepEqual([named.timezone.zone, named.timezone.source, named.window.firstDay], ["Europe/Paris", "named in this call", "2026-11-16"]);
  assert.equal((await f.list({ timezone: "  UTC " })).timezone.zone, "UTC");
  for (const bad of ["Mars/Olympus", "America/Nowhere", "PST8PDTX"]) await assert.rejects(f.list({ timezone: bad }), /timezone must be an IANA time zone name/);
  for (const bad of [5, true, ["UTC"], { zone: "UTC" }]) await assert.rejects(f.list({ timezone: bad }), /timezone must be a string/);
  // No silent fallback: without a configured zone, or with an unusable one, blank still means "ask", never the server's UTC.
  for (const zone of [null, "Not/AZone"]) {
    const g = fixture("2026-11-16T01:30:00Z", zone);
    for (const tz of [undefined, null, "", "  "]) await assert.rejects(g.list(tz === undefined ? {} : { timezone: tz }), /will not guess what today means/);
    assert.equal((await g.list({ timezone: "UTC" })).timezone.zone, "UTC", "an explicit zone still works");
  }
});

test("timezone default is the owner's zone, not the server's: UTC/local midnight and DST days, under a different process TZ", async () => {
  const keep = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const f = fixture();
    const before = f.send(`chat:${T1}`, "2026-11-15T07:59:00Z"); // 23:59 PST on the 14th
    const after = f.send(`chat:${T1}`, "2026-11-15T08:01:00Z"); // 00:01 PST on the 15th
    f.clock.t = Date.parse("2026-11-15T07:30:00Z"); // UTC (and Tokyo) already the 15th; still the 14th in Los Angeles
    for (const tz of [undefined, ""]) {
      const r = await f.list(tz === undefined ? {} : { timezone: tz });
      assert.equal(r.window.firstDay, "2026-11-14");
      assert.deepEqual(r.photos.map((p: any) => p.ref), before);
    }
    f.clock.t = Date.parse("2026-11-15T08:30:00Z"); // 00:30 PST on the 15th
    assert.deepEqual((await f.list({ timezone: "" })).photos.map((p: any) => p.ref), after);
    // DST: the owner's fall-back day is 25 hours and spring-forward 23, with timezone blank.
    const fall = f.send(`chat:${T2}`, "2026-11-02T07:30:00Z"); // 2026-11-01 23:30 PST
    const r1 = await f.list({ day: "2026-11-01", timezone: " " });
    assert.deepEqual([r1.window.hours, r1.window.startsAt, r1.window.endsBefore], [25, "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"]);
    assert.deepEqual(r1.photos.map((p: any) => p.ref), fall);
    assert.equal((await f.list({ day: "2026-03-08", timezone: null })).window.hours, 23);
  } finally {
    if (keep === undefined) delete process.env.TZ;
    else process.env.TZ = keep;
  }
});

// ---- the other optional photos_list fields ---------------------------------------------------------------------------------------

test("photos_list fields: defaults, explicit false, numeric limits, date versus range, conversation selector", async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.send(`chat:${T1}`, `2026-11-15T17:${String(i).padStart(2, "0")}:00Z`);
  f.send(`chat:${T2}`, "2026-11-14T18:00:00Z");
  f.chats.get(T2)!.archived = true;
  // Defaults: today, limit 10, archived hidden.
  const d = await f.list({});
  assert.deepEqual([d.returned, d.matches, d.window.firstDay], [PHOTO_LIST_LIMIT_DEFAULT, 12, "2026-11-15"]);
  assert.deepEqual(await f.list(ALL_NULL), d);
  // includeArchived: false is the default; true reveals; a string is refused.
  const range = { from: "2026-11-14", to: "2026-11-15", limit: 25 };
  assert.equal((await f.list({ ...range, includeArchived: false })).matches, 12);
  assert.equal((await f.list({ ...range, includeArchived: false })).archivedThreadPhotosHidden, 1);
  assert.equal((await f.list({ ...range, includeArchived: true })).matches, 13);
  for (const bad of ["false", "", 0]) await assert.rejects(f.list({ includeArchived: bad }), /includeArchived must be true or false/);
  // limit: integers within bounds only.
  assert.equal((await f.list({ limit: 1 })).returned, 1);
  assert.equal((await f.list({ limit: PHOTO_LIST_LIMIT_MAX })).returned, 12);
  for (const bad of [0, 26, 2.5, "5", "", true]) await assert.rejects(f.list({ limit: bad }), /limit must be an integer from 1 to 25/);
  // Dates: a blank day is today; day and a range are exclusive; invalid dates and ranges are refused.
  assert.equal((await f.list({ day: "" })).window.firstDay, "2026-11-15");
  assert.equal((await f.list({ day: "", from: "2026-11-14" })).window.lastDay, "2026-11-15", "from alone runs to today");
  assert.equal((await f.list({ from: "", to: "2026-11-14" })).window.firstDay, "2026-11-14");
  await assert.rejects(f.list({ day: "today", from: "2026-11-14" }), /either day or from\/to/);
  await assert.rejects(f.list({ from: "2026-11-15", to: "2026-11-14" }), /ends before it starts/);
  await assert.rejects(f.list({ from: "2026-10-01", to: "2026-11-15" }), /at most 31/);
  await assert.rejects(f.list({ day: "15/11/2026" }), /day must be/);
  await assert.rejects(f.list({ day: 20261115 }), /day must be/);
  await assert.rejects(f.list({ from: "2026-02-30" }), /from and to must be dates/);
  await assert.rejects(f.list({ to: 5 }), /from and to must be dates/);
  // conversation: an access selector. Null is "all I may read"; blank is refused, not widened; another thread from a chat is refused.
  assert.equal((await f.list({ conversation: null })).matches, 12);
  for (const bad of ["", "  "]) await assert.rejects(f.list({ conversation: bad }), /An empty value is not accepted/);
  await assert.rejects(f.list({ conversation: "chat:nope" }), /conversation must be a session id/);
  await assert.rejects(f.list({ conversation: `chat:${T1}` }, `chat:${T2}`), /Refused: Chat thread: only this thread/);
  assert.equal((await f.list({ conversation: null }, `chat:${T2}`)).matches, 0, "a thread with nulls sees only itself");
  await assert.rejects(f.list({ unknown: 1 }), /Unknown argument/);
  // Non-owner refused before anything else.
  await assert.rejects(f.tools("assistant:assistant", false)[0]!.run({}), /only the owner/);
});

test("cursor: continuation with nulls and blanks in the other fields; \"\" is the first page; blank-but-nonempty and foreign cursors are refused", async () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) f.send(`chat:${T1}`, `2026-11-15T1${i}:00:00Z`);
  const first = await f.list({ ...ALL_NULL, limit: 3, cursor: "" });
  assert.equal(first.returned, 3);
  const seen = first.photos.map((p: any) => p.ref);
  let cursor = first.nextCursor;
  while (cursor) {
    // The model echoes the same query, mixing null and "" for absence: the cursor still binds (the query is the same).
    const page = await f.list({ ...ALL_NULL, timezone: "", day: "", limit: 3, cursor });
    seen.push(...page.photos.map((p: any) => p.ref));
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  for (const bad of [" ", "\t", "garbage", "x".repeat(401), 5]) await assert.rejects(f.list({ limit: 3, cursor: bad }), /invalid-cursor/);
  // Bound to its query: another day, another zone (a different window) or another conversation refuses it.
  await assert.rejects(f.list({ limit: 3, day: "2026-11-14", cursor: first.nextCursor }), /invalid-cursor/);
  await assert.rejects(f.list({ limit: 3, timezone: "UTC", cursor: first.nextCursor }), /invalid-cursor/);
  await assert.rejects(f.list({ limit: 3, conversation: "assistant:assistant", cursor: first.nextCursor }), /invalid-cursor/);
  await assert.rejects(f.list({ limit: 3, cursor: first.nextCursor }, `chat:${T1}`), /invalid-cursor/, "another caller cannot reuse it");
});

test("photos_inspect: refs is required, a non-empty bounded list of strings; null, blank and missing are refused", async () => {
  const f = fixture();
  const refs = f.send(`chat:${T1}`, "2026-11-15T17:00:00Z", 1);
  const inspect = f.tools()[1]!;
  const ctx = { signal: new AbortController().signal, media: { support: () => ({ ok: true, detail: "t" }) as any, remaining: () => ({ images: 10, bytes: MODEL_IMAGE_BYTES_MAX, calls: 3 }), supplied: () => false } };
  for (const bad of [{}, { refs: null }, { refs: [] }, { refs: "" }, { refs: refs[0] }, { refs: [5] }, { refs: Array(11).fill(refs[0]) }]) await assert.rejects(inspect.run(bad, ctx), /refs must be a list of 1 to 10/, JSON.stringify(bad).slice(0, 40));
  await assert.rejects(inspect.run({ refs, extra: null }, ctx), /Unknown argument/);
  const ok = (await inspect.run({ refs: ["", ...refs] }, ctx)) as any;
  assert.equal(ok.value.supplied.length, 1);
  assert.equal(ok.value.notSupplied[0].status, "not-found", "a blank ref is just not found");
});

test("listArgs: null is absence everywhere; blank is absence only for timezone/day/from/to; cursor \"\" is kept as the first page", () => {
  assert.deepEqual(listArgs(ALL_NULL), {});
  assert.deepEqual(listArgs({ timezone: " ", day: "", from: "\t", to: "", cursor: "" }), { cursor: "" });
  assert.deepEqual(listArgs({ timezone: " Europe/Paris ", includeArchived: false, limit: 3 }), { timezone: "Europe/Paris", includeArchived: false, limit: 3 });
  assert.throws(() => listArgs({ conversation: "" }), /An empty value is not accepted/);
});
