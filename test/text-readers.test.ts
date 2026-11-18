// Complete, bounded reading of long texts in chat (docs/text-readers.md): memory_read_page, job_summary_read and research_report_read.
// Synthetic fixtures only: generated notes, summaries and reports, no real job or vault content.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_OUTPUT_CHARS, proposals as newProposals, runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { pageCursor, pageState, pageStreams } from "../src/assistant-context.ts";
import { chatTools } from "../src/chat-tools.ts";
import { detailJob } from "../src/job-view.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { memoryUnavailable, vaultMemory } from "../src/memory.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { decide } from "../src/policy.ts";
import { researchStore } from "../src/research.ts";
import type { ResearchStore } from "../src/research.ts";
import { researchTools, UNTRUSTED_NOTE } from "../src/research-tools.ts";
import { jsonStore } from "../src/store.ts";
import { encodeCursor, PAGE_CURSOR_MAX, PAGE_OUTPUT_MAX, PAGE_TEXT_BYTES_MAX, TEXT_PAGE_TOOLS, TOOL_OUTPUT_LIMIT, textPage } from "../src/text-pages.ts";
import { textReaderTools } from "../src/text-readers.ts";
import { fitOutput, keptFacts, outputItemBytes } from "../src/tool-result-budget.ts";

// ---- synthetic fixtures ----------------------------------------------------------------------------------------------------

// Deterministic text that is hard to serialize: quotes, backslashes, line breaks, tabs, control characters, emoji (surrogate pairs),
// CJK, combining marks, RTL text and JSON/Markdown look-alikes. `lone` adds unpaired surrogates (possible in a summary sent as JSON,
// never in a file read as UTF-8).
const PIECES = [
  'He said "quote" and \\backslash\\ ',
  "line\nbreak\r\nand\ttab ",
  "ctrl\u0001\u0007\u001f ",
  "emoji 😀🧪🏳️‍🌈 ",
  "漢字かなカナ한국어 ",
  "é combining ",
  "עברית العربية ",
  '{"result":{"nextCursor":"not-a-cursor"}} ',
  "## Heading\n- item `code` ",
  "plain words to fill the line ",
];
function tricky(chars: number, opts: { lone?: boolean; seed?: number } = {}): string {
  let s = "";
  let i = opts.seed ?? 0;
  while (s.length < chars) {
    s += PIECES[i % PIECES.length]!;
    if (opts.lone && i % 7 === 3) s += "\ud800x\udfff";
    s += `#${i} `;
    i++;
  }
  // Never end on half a pair: the generator adds whole pieces, but cut to length.
  let out = s.slice(0, chars);
  if (/[\ud800-\udbff]$/.test(out) && !opts.lone) out = out.slice(0, -1);
  return out;
}
const ascii = (chars: number) => tricky(chars).replace(/[^\x20-\x7e\n]/g, "a");

function vault(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "orbit-text-pages-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const memory = vaultMemory(root, undefined, () => new Date(), { source: () => "memory/vault@test123" });
  return { root, memory, write: (p: string, text: string) => (writeFileSync(join(root, p), text), memory.invalidate?.()) };
}

function jobWorld() {
  const notify = notifier(jsonStore<Notification[]>(undefined, `n${Math.random()}`, []));
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, `j${Math.random()}`, []), Buffer.alloc(32, 7), notify, () => new Date());
  return { jobs, notify };
}

type Page = { offset: number; end: number; text: string; last: boolean; nextCursor: string | null; version: { sha256: string; chars: number }; textComplete?: boolean; [k: string]: unknown };
const byName = (tools: ChatTool[], n: string) => tools.find((t) => t.name === n)!;
// The envelope exactly as src/agent.ts builds it for a successful call.
const envelope = (r: { value: unknown; provenance: string; source: string }) => JSON.stringify({ ok: true, provenance: r.provenance, source: r.source, result: r.value });

// Reads every page by calling the tool directly; checks each page's size against the transport limit as the agent serializes it.
async function readAll(tool: ChatTool, args: Record<string, unknown>): Promise<{ pages: (Page & { page: { offset: number; end: number; chars: number } })[]; text: string }> {
  const pages: (Page & { page: { offset: number; end: number; chars: number } })[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 500; i++) {
    const r = await tool.run({ ...args, ...(cursor ? { cursor } : {}) });
    const out = envelope(r);
    assert.ok(out.length <= PAGE_OUTPUT_MAX, `page ${i} output is ${out.length} characters`);
    // Parsing the serialized output, not the in-memory value: what the model gets.
    const p = (JSON.parse(out) as { result: Page & { page: { offset: number; end: number; chars: number } } }).result;
    pages.push(p);
    if (p.last) {
      assert.equal(p.nextCursor, null);
      break;
    }
    assert.equal(typeof p.nextCursor, "string");
    cursor = p.nextCursor;
  }
  return { pages, text: pages.map((p) => p.text).join("") };
}
function contiguous(pages: { page: { offset: number; end: number; chars: number }; text: string }[], total: number) {
  let at = 0;
  for (const p of pages) {
    assert.equal(p.page.offset, at, "no gap and no overlap");
    assert.equal(p.page.end - p.page.offset, p.text.length);
    assert.equal(p.page.chars, p.text.length);
    at = p.page.end;
  }
  assert.equal(at, total, "the pages reach the end");
}

test("the page bound is derived from the agent's real tool-output limit", () => {
  assert.equal(TOOL_OUTPUT_LIMIT, MAX_OUTPUT_CHARS);
  assert.ok(PAGE_OUTPUT_MAX < MAX_OUTPUT_CHARS);
});

// ---- the paging core -------------------------------------------------------------------------------------------------------

test("textPage: multi-page round trips rebuild the exact text (Unicode, escapes, lone surrogates); every page fits and the last says so", () => {
  const env = { provenance: "live" as const, source: "test/source" };
  for (const [name, text] of [
    ["ascii", ascii(50_000)],
    ["tricky", tricky(60_000)],
    ["lone surrogates", tricky(30_000, { lone: true })],
    ["all escapes", "\u0001\"\\\n".repeat(9_000)],
    ["all astral", "😀".repeat(20_000)],
    ["one char", "x"],
  ] as const) {
    const pages: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (;;) {
      const v = textPage({ tool: "memory_read_page", identity: { path: "n.md" }, text, fields: { kind: "vault-note" } }, cursor, env);
      const out = JSON.stringify({ ok: true, ...env, result: v });
      assert.ok(out.length <= PAGE_OUTPUT_MAX, `${name}: ${out.length}`);
      assert.ok(Buffer.byteLength(JSON.stringify(v.text), "utf8") - 2 <= PAGE_TEXT_BYTES_MAX, `${name}: page bytes`);
      pages.push(JSON.parse(out).result);
      if (v.nextCursor === null) break;
      cursor = v.nextCursor as string;
      assert.ok(cursor.length <= PAGE_CURSOR_MAX);
    }
    const last = pages.at(-1)!;
    assert.equal(last.last, true, name);
    assert.match(String(last.continue), /last page/);
    assert.ok(pages.slice(0, -1).every((p) => p.last === false), `${name}: only the last page is terminal`);
    contiguous(pages as never, text.length);
    assert.equal(pages.map((p) => p.text).join(""), text, `${name}: exact text`);
    // Pages never end between the halves of a surrogate pair (lone surrogates in the source are kept as they are).
    if (name === "all astral") assert.ok(pages.every((p) => (p.text as string).length % 2 === 0));
  }
});

test("textPage: an empty text is one explicit, empty, terminal page", () => {
  const v = textPage({ tool: "memory_read_page", identity: { path: "e.md" }, text: "" }, undefined, { provenance: "live", source: "s" });
  assert.deepEqual([v.text, v.last, v.nextCursor, v.empty, (v.version as { chars: number }).chars], ["", true, null, true, 0]);
});

// ---- memory_read_page ------------------------------------------------------------------------------------------------------

test("memory_read_page: a long note reads completely; first call needs no cursor or pin; null and \"\" also mean the first page", async () => {
  const note = tricky(45_000);
  const v = vault({ "Projects/long-plan.md": note, "short.md": "short" });
  const tool = byName(textReaderTools({ memory: v.memory }), "memory_read_page");
  const { pages, text } = await readAll(tool, { path: "Projects/long-plan.md" });
  assert.ok(pages.length >= 6, `${pages.length} pages`);
  assert.equal(text, note);
  contiguous(pages, note.length);
  assert.equal(pages[0]!.version.chars, note.length);
  assert.equal(pages[0]!.kind, "vault-note");
  assert.equal(pages[0]!.path, "Projects/long-plan.md");
  for (const first of [null, ""]) assert.equal(((await tool.run({ path: "Projects/long-plan.md", cursor: first })).value as Page).text, pages[0]!.text);
  const r = await tool.run({ path: "Projects/long-plan.md" });
  assert.equal(r.source, "memory/vault@test123", "the vault source is kept");
  // A short note is one terminal page; memory_read is unchanged and still returns the bare note text.
  const s = (await tool.run({ path: "short.md" })).value as Page;
  assert.deepEqual([s.text, s.last, s.nextCursor], ["short", true, null]);
  const legacy = byName(chatTools({ memory: v.memory, toolbox: {} as never, notify: {} as never, proposals: newProposals(), launchable: () => ({ routines: [] }) }), "memory_read");
  assert.equal((await legacy.run({ path: "short.md" })).value, "short");
});

test("memory_read_page: a note that changes between pages refuses the old cursor with a restart, never splicing versions", async () => {
  const v = vault({ "a.md": ascii(20_000) });
  const tool = byName(textReaderTools({ memory: v.memory }), "memory_read_page");
  const p1 = (await tool.run({ path: "a.md" })).value as Page;
  v.write("a.md", `${ascii(20_000)} edited`);
  await assert.rejects(tool.run({ path: "a.md", cursor: p1.nextCursor }), (e: Error) => {
    assert.match(e.message, /^stale-cursor: /);
    assert.match(e.message, /Nothing was returned/);
    assert.match(e.message, /call memory_read_page with \{"path":"a\.md"\} and no cursor/);
    return true;
  });
  // The restart works and binds to the new version.
  const fresh = await readAll(tool, { path: "a.md" });
  assert.equal(fresh.text, `${ascii(20_000)} edited`);
  assert.notEqual(fresh.pages[0]!.version.sha256, p1.version.sha256);
});

test("memory_read_page: missing, denied, unavailable and empty are distinct; path rules and argument bounds hold", async () => {
  const v = vault({ "empty.md": "", "x.md": "x" });
  const tool = byName(textReaderTools({ memory: v.memory }), "memory_read_page");
  await assert.rejects(tool.run({ path: "nope.md" }), /not-found: there is no note at that path/);
  await assert.rejects(tool.run({ path: "../outside.md" }), /denied: the path is outside the vault/);
  await assert.rejects(tool.run({ path: "x.txt" }), /denied: /);
  await assert.rejects(byName(textReaderTools({ memory: memoryUnavailable("No vault is configured (ORBIT_VAULT unset).") }), "memory_read_page").run({ path: "x.md" }), /unavailable: the vault could not be read now \(No vault is configured/);
  const e = (await tool.run({ path: "empty.md" })).value as Page;
  assert.deepEqual([e.text, e.empty, e.last, e.nextCursor], ["", true, true, null]);
  await assert.rejects(tool.run({ path: "x".repeat(600) + ".md" }), /invalid-argument: path is 603 characters; at most 512/);
  await assert.rejects(tool.run({ path: "x.md", offset: 5 }), /invalid-argument: unknown argument\(s\) "offset"/);
  await assert.rejects(tool.run({}), /invalid-argument: memory_read_page needs \{path: string\}/);
  await assert.rejects(tool.run({ path: 5 }), /invalid-argument/);
});

test("memory_read_page: malformed, oversized, tampered, out-of-range and cross-resource cursors are refused before anything is read", async () => {
  const v = vault({ "a.md": ascii(20_000), "b.md": ascii(20_000), "pair.md": "😀".repeat(8_000) });
  const tool = byName(textReaderTools({ memory: v.memory }), "memory_read_page");
  const a1 = (await tool.run({ path: "a.md" })).value as Page;
  const good = a1.nextCursor!;
  const bad = /invalid-cursor: /;
  for (const c of ["not a cursor!", "x".repeat(PAGE_CURSOR_MAX + 1), good.slice(0, -3), `${good.slice(0, 20)}A${good.slice(21)}`, Buffer.from('{"b":"{}","h":"x"}').toString("base64url")]) await assert.rejects(tool.run({ path: "a.md", cursor: c }), bad, c.slice(0, 30));
  for (const c of [5, {}, ["x"], true]) await assert.rejects(tool.run({ path: "a.md", cursor: c }), bad);
  // Same bytes of the same note, other path spelling or another note: a cursor belongs to one read only.
  await assert.rejects(tool.run({ path: "b.md", cursor: good }), /invalid-cursor: this cursor belongs to a different read/);
  // A job summary's cursor is not a note's.
  const w = jobWorld();
  w.jobs.register("job-1");
  w.jobs.record("job-1", { type: "summary", status: "done", text: ascii(20_000) });
  const js = byName(textReaderTools({ memory: v.memory, jobs: w.jobs }), "job_summary_read");
  const jc = ((await js.run({ id: "job-1" })).value as Page).nextCursor!;
  await assert.rejects(tool.run({ path: "a.md", cursor: jc }), /invalid-cursor: this cursor belongs to a different read/);
  // Forged with a valid checksum: offset 0, offset at or past the end, and one that splits a surrogate pair.
  const decode = (c: string) => JSON.parse(JSON.parse(Buffer.from(c, "base64url").toString("utf8")).b) as { t: string; r: string; o: number; x: string; n: number };
  const g = decode(good);
  for (const o of [0, g.n, g.n + 10]) await assert.rejects(tool.run({ path: "a.md", cursor: encodeCursor({ ...g, o }) }), bad, `offset ${o}`);
  const p1 = (await tool.run({ path: "pair.md" })).value as Page;
  const pc = decode(p1.nextCursor!);
  assert.equal(pc.o % 2, 0, "issued cursors never split a pair");
  await assert.rejects(tool.run({ path: "pair.md", cursor: encodeCursor({ ...pc, o: pc.o + 1 }) }), bad);
});

// ---- the real tool loop: what the model receives ---------------------------------------------------------------------------

// A model that keeps paging: each step reads the previous output it was sent and asks for the next page until nextCursor is null.
function pagingModel(tool: string, args: Record<string, unknown>): ModelPort & { outputs: string[] } {
  const outputs: string[] = [];
  let n = 0;
  return {
    outputs,
    status: () => ({ port: "model", state: "live", impl: "fake/paging", detail: "test", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "plain", provenance: "live", source: "model/fake" }),
    step: async (input: Item[]): Promise<Step> => {
      const last = [...input].reverse().find((i) => (i as { type?: string }).type === "function_call_output") as { output: string } | undefined;
      if (last && outputs.at(-1) !== last.output) outputs.push(last.output);
      if (!last) return { text: "", calls: [{ call_id: `c${n++}`, name: tool, arguments: JSON.stringify(args) }] };
      const r = JSON.parse(last.output) as { ok: boolean; result?: Page };
      if (!r.ok || !r.result || r.result.nextCursor === null) return { text: "done", calls: [] };
      return { text: "", calls: [{ call_id: `c${n++}`, name: tool, arguments: JSON.stringify({ ...args, cursor: r.result.nextCursor }) }] };
    },
  };
}

test("through runChat: a long vault note and a long job summary reach the model whole, page by page, with no ORBIT cut", async () => {
  const note = tricky(24_000);
  const summary = ascii(40_000);
  const v = vault({ "Resources/long.md": note });
  const w = jobWorld();
  w.jobs.register("job-long");
  w.jobs.record("job-long", { type: "summary", status: "done", text: summary });
  const tools = textReaderTools({ memory: v.memory, jobs: w.jobs });
  for (const [tool, args, want] of [["memory_read_page", { path: "Resources/long.md" }, note], ["job_summary_read", { id: "job-long" }, summary]] as const) {
    const model = pagingModel(tool, args);
    const out = await runChat({ model, messages: [{ role: "user", content: "read it" }], limits: [], tools, allow: (t) => (decide("agent", t, true).allow ? undefined : "refused") });
    assert.equal(out.text, "done");
    assert.ok(model.outputs.length >= 4, `${tool}: ${model.outputs.length} pages`);
    for (const o of model.outputs) {
      assert.ok(o.length <= MAX_OUTPUT_CHARS, `${tool}: ${o.length}`);
      assert.doesNotMatch(o, /\[ORBIT: (this output was cut|the output of)/, "neither the tool clip nor the reply budget acted");
    }
    const pages = model.outputs.map((o) => (JSON.parse(o) as { result: Page }).result);
    assert.equal(pages.map((p) => p.text).join(""), want, `${tool}: exact text`);
    assert.equal(pages.at(-1)!.last, true);
    assert.ok(out.calls.every((c) => c.ok && !c.budgetCut));
  }
});

test("a page cut by the reply's tool-result budget keeps its cursor whole, and history paging recognizes the readers", async () => {
  const v = vault({ "a.md": tricky(30_000) });
  const tool = byName(textReaderTools({ memory: v.memory }), "memory_read_page");
  const r = await tool.run({ path: "a.md" });
  const out = envelope(r);
  const next = (r.value as Page).nextCursor!;
  // Room for only part of the page: the cut keeps the cursor (and the note to re-read this page with the cursor this call used).
  const cut = fitOutput("memory_read_page", "call1", out, 3_000);
  assert.ok(outputItemBytes("call1", cut) <= 3_000);
  assert.ok(cut.includes(`nextCursor "${next}"`));
  assert.match(keptFacts("memory_read_page", out), /read it again with the cursor this call used/);
  for (const name of TEXT_PAGE_TOOLS) assert.equal(pageCursor(name, JSON.stringify({ ok: true, result: { nextCursor: next } })), next);
  const lastPage = JSON.stringify({ ok: true, result: { nextCursor: null, last: true } });
  assert.deepEqual(pageState("job_summary_read", lastPage), { done: true });
  const streams = pageStreams([
    { name: "memory_read_page", arguments: JSON.stringify({ path: "a.md" }), output: out },
    { name: "memory_read_page", arguments: JSON.stringify({ path: "a.md", cursor: next }), output: lastPage },
  ]);
  assert.equal(streams.length, 1, "a continuation joins its read");
  assert.deepEqual(streams[0]!.state, { done: true });
});

// ---- job_summary_read ------------------------------------------------------------------------------------------------------

test("job_summary_read: a full long summary, runner-reported label, job_status compatibility and its pointer", async () => {
  const w = jobWorld();
  const text = tricky(70_000, { lone: true });
  w.jobs.register("job-a");
  w.jobs.record("job-a", { type: "summary", status: "done", text });
  const tool = byName(textReaderTools({ memory: memoryUnavailable("none"), jobs: w.jobs }), "job_summary_read");
  const { pages, text: got } = await readAll(tool, { id: "job-a" });
  assert.equal(got, text, "exact, lone surrogates included");
  contiguous(pages, text.length);
  const p = pages[0]!;
  assert.equal(p.textComplete, true);
  assert.deepEqual(p.summary, { state: "complete", via: "api", at: (p.summary as { at: string }).at, chars: text.length });
  assert.match(String(p.trust), /^Runner-reported/);
  assert.equal(p.jobState, "done");
  // job_status keeps its compact view: the summary's size and state, not its text, now first and with the reader named.
  const d = detailJob(w.jobs.get("job-a")!, "ok");
  assert.deepEqual(Object.keys(d).slice(0, 2), ["id", "summary"]);
  assert.deepEqual(d.summary, { chars: text.length, state: "complete", via: "api", at: (p.summary as { at: string }).at, readWith: { tool: "job_summary_read", arguments: { id: "job-a" } } });
  assert.ok(!JSON.stringify(d.summary).includes(text.slice(0, 50)));
});

test("job_summary_read: a partial or oversize summary is never shown as complete; missing job, no summary and empty summary are distinct", async () => {
  const w = jobWorld();
  const tool = byName(textReaderTools({ memory: memoryUnavailable("none"), jobs: w.jobs }), "job_summary_read");
  w.jobs.register("job-p");
  w.jobs.record("job-p", { type: "summary", status: "done", text: ascii(9_000), textComplete: false });
  const partial = await readAll(tool, { id: "job-p" });
  assert.equal(partial.text, ascii(9_000));
  for (const pg of partial.pages) assert.equal(pg.textComplete, false);
  assert.equal(partial.pages.at(-1)!.last, true, "the last page of what ORBIT holds");
  assert.match(String(partial.pages.at(-1)!.held), /holds only the first 9000 of 9000 characters.*not the end of the summary/);

  w.jobs.register("job-o");
  w.jobs.record("job-o", { type: "summary", status: "done", text: ascii(200_001) });
  const over = (await tool.run({ id: "job-o" })).value as Page;
  assert.deepEqual([over.textComplete, (over.summary as { state: string }).state, over.version.chars], [false, "oversize", 4000]);
  assert.match(String(over.held), /first 4000 of 200001 characters/);

  await assert.rejects(tool.run({ id: "no-such-job" }), /not-found: there is no job with that id/);
  w.jobs.register("job-n");
  await assert.rejects(tool.run({ id: "job-n" }), /no-content: job job-n has no final summary yet \(state registered\).*not an empty summary/);
  w.jobs.register("job-e");
  w.jobs.record("job-e", { type: "summary", status: "failed", text: "" });
  const e = (await tool.run({ id: "job-e" })).value as Page;
  assert.deepEqual([e.text, e.empty, e.last, e.textComplete], ["", true, true, true]);
  await assert.rejects(tool.run({ id: "../x" }), /invalid-argument: id is not a job id/);
  await assert.rejects(tool.run({ id: "a".repeat(65) }), /invalid-argument/);
  await assert.rejects(tool.run({ id: "job-e", path: "x" }), /invalid-argument: unknown argument/);
});

test("job_summary_read: a summary replaced between pages (the full text from git) makes the old cursor stale", async () => {
  const w = jobWorld();
  const tool = byName(textReaderTools({ memory: memoryUnavailable("none"), jobs: w.jobs }), "job_summary_read");
  w.jobs.register("job-g");
  w.jobs.record("job-g", { type: "summary", status: "done", text: ascii(12_000), textComplete: false });
  const p1 = (await tool.run({ id: "job-g" })).value as Page;
  assert.equal(w.jobs.completeSummary("job-g", ascii(30_000)), true);
  await assert.rejects(tool.run({ id: "job-g", cursor: p1.nextCursor }), /stale-cursor: .*call job_summary_read with \{"id":"job-g"\} and no cursor/);
  const fresh = await readAll(tool, { id: "job-g" });
  assert.deepEqual([fresh.text, fresh.pages[0]!.textComplete], [ascii(30_000), true]);
});

// ---- research_report_read --------------------------------------------------------------------------------------------------

function researchWorld(store: ResearchStore = researchStore(undefined)) {
  const w = jobWorld();
  const tools = researchTools({ jobs: w.jobs, proposals: newProposals(), lane: () => ({ state: "configured", names: ["research"], routines: new Map() }) as never, build: () => ({ routines: ["orbit"] }), routineRepos: new Map(), store });
  return { ...w, store, tools };
}

test("research_report_read: a full long report with its untrusted label and stored digest; research_result stays clipped and names the reader", async () => {
  const x = researchWorld();
  const report = tricky(52_000, { seed: 3 });
  x.jobs.register("research-1", undefined, { research: { brief: "synthetic question" } });
  x.store.save("research-1", "done", report, undefined);
  const tool = byName(x.tools, "research_report_read");
  const { pages, text } = await readAll(tool, { id: "research-1" });
  assert.equal(text, report);
  contiguous(pages, report.length);
  const p = pages[0]!;
  assert.deepEqual([p.kind, p.origin, p.trust, p.textComplete], ["research-report", "stored-report", UNTRUSTED_NOTE, true]);
  assert.equal((p.stored as { matchesText: boolean }).matchesText, true);
  assert.equal((p.stored as { sha256: string }).sha256, p.version.sha256);
  const r = await tool.run({ id: "research-1" });
  assert.match(r.source, /runner-reported/);
  const old = (await byName(x.tools, "research_result").run({ id: "research-1" })).value as { text: string; textTruncated: boolean; readFullWith: unknown };
  assert.deepEqual([old.text, old.textTruncated, old.readFullWith], [report.slice(0, 6000), true, { tool: "research_report_read", arguments: { id: "research-1" } }]);
});

test("research_report_read: missing, wrong kind, no report and an unreadable store are distinct; a short report is one page", async () => {
  const x = researchWorld();
  const tool = byName(x.tools, "research_report_read");
  await assert.rejects(tool.run({ id: "nope" }), /not-found: /);
  x.jobs.register("build-1");
  await assert.rejects(tool.run({ id: "build-1" }), /invalid-argument: job build-1 is a work job, not a research job/);
  x.jobs.register("research-2", undefined, { research: { brief: "q" } });
  await assert.rejects(tool.run({ id: "research-2" }), /no-content: research job research-2 has no stored report/);
  // Without a stored report, a complete summary is what research_result shows too.
  x.jobs.record("research-2", { type: "summary", status: "done", text: "short report" });
  const s = (await tool.run({ id: "research-2" })).value as Page;
  assert.deepEqual([s.text, s.origin, s.last, s.nextCursor], ["short report", "job-summary", true, null]);
  const broken = researchWorld({ persisted: true, save: () => { throw new Error("x"); }, read: () => { throw new Error("EACCES: permission denied"); } });
  broken.jobs.register("research-3", undefined, { research: { brief: "q" } });
  await assert.rejects(byName(broken.tools, "research_report_read").run({ id: "research-3" }), /unavailable: ORBIT's stored report could not be read now \(EACCES/);
});

// ---- authorization and schemas ---------------------------------------------------------------------------------------------

test("the readers are owner-only through the agent policy, read-only, strict about arguments, and need no pins on the first call", () => {
  const w = jobWorld();
  const all = [...textReaderTools({ memory: memoryUnavailable("none"), jobs: w.jobs }), byName(researchWorld().tools, "research_report_read")];
  assert.deepEqual(all.map((t) => t.name).sort(), [...TEXT_PAGE_TOOLS].sort());
  for (const t of all) {
    assert.equal(decide("agent", t.name, false).allow, false, `${t.name} refused for a non-owner`);
    assert.equal(decide("agent", t.name, true).allow, true);
    assert.equal(t.readOnly, true);
    const p = t.parameters as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    assert.equal(p.additionalProperties, false);
    assert.equal(p.required.length, 1, "only the resource is required: no cursor, digest or offset on the first call");
    assert.ok("cursor" in p.properties);
    assert.match(t.description, /last is true \(nextCursor null\)/);
  }
  // Without the job store, only the note reader is offered.
  assert.deepEqual(textReaderTools({ memory: memoryUnavailable("none") }).map((t) => t.name), ["memory_read_page"]);
});

test("through runChat: a refusal reaches the model as ok false with its kind, and nothing else is sent", async () => {
  const v = vault({ "a.md": "a" });
  const tools = textReaderTools({ memory: v.memory });
  const seen: string[] = [];
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "t", verifiedAt: new Date().toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "m" }),
    step: async (input: Item[]) => {
      const outs = input.filter((i) => (i as { type?: string }).type === "function_call_output") as { output: string }[];
      if (outs.length) {
        seen.push(...outs.map((o) => o.output));
        return { text: "done", calls: [] };
      }
      return { text: "", calls: [{ call_id: "a", name: "memory_read_page", arguments: JSON.stringify({ path: "missing.md" }) }, { call_id: "b", name: "memory_read_page", arguments: JSON.stringify({ path: "a.md", cursor: "garbage" }) }] };
    },
  };
  const out = await runChat({ model, messages: [{ role: "user", content: "x" }], limits: [], tools });
  assert.equal(out.text, "done");
  const errs = seen.map((s) => JSON.parse(s) as { ok: boolean; error: string; result?: unknown });
  assert.deepEqual(errs.map((e) => [e.ok, e.error.split(":")[0], e.result]), [[false, "not-found", undefined], [false, "invalid-cursor", undefined]]);
  // A non-owner is refused by the policy hook before the tool runs.
  const refused = await runChat({ model: pagingModel("memory_read_page", { path: "a.md" }), messages: [{ role: "user", content: "x" }], limits: [], tools, allow: (t) => { const d = decide("agent", t, false); return d.allow ? undefined : d.reason; } });
  assert.equal(refused.calls[0]!.ok, false);
  assert.match(refused.calls[0]!.summary, /only the owner can use agent/);
});
