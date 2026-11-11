import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { MAX_OUTPUT_CHARS, runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import { vaultMemory } from "../src/memory.ts";
import type { Item, ModelPort, Step } from "../src/model.ts";
import { notifier } from "../src/notify.ts";
import { decide } from "../src/policy.ts";
import { MOCK_PORT_NAMES, mockPort } from "../src/ports.ts";
import { patchLooksTruncated, prInspectTools, PR_INSPECT_TOOL_NAMES, RESULT_BUDGET } from "../src/pr-inspect.ts";
import { memoryReport, runner } from "../src/runs.ts";
import { scheduler } from "../src/schedule.ts";
import { buildServer } from "../src/server.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";
import { nodes as devicePresence } from "../src/nodes.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic values only, built at run time (no secret-shaped literals).
const TOKEN = `${"gh"}${"p_"}${"Q".repeat(36)}`;
const REPO = "DragonflyAI-sh/orbit";
const HEAD = "a1".repeat(20);
const OLD = "b2".repeat(20);
const BASE = "c3".repeat(20);
const NOW = new Date("2026-11-11T12:00:00.000Z");

type Call = { method: string; url: string; auth: string | null };
type Fake = { fetcher: typeof fetch; calls: Call[]; state: State; onRequest?: (call: Call, n: number) => void };
type State = {
  head: string;
  files: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  inline: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
  runById: Record<string, Record<string, unknown>>;
  log?: { status: number; body?: string; location?: string };
  blob?: { status: number; body: string };
  failWith?: { status: number; body?: unknown; headers?: Record<string, string> };
  throwWith?: unknown;
};

const j = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const pageOf = (url: URL, all: unknown[]) => {
  const page = Number(url.searchParams.get("page") ?? "1");
  const per = Number(url.searchParams.get("per_page") ?? "30");
  const items = all.slice((page - 1) * per, page * per);
  return j(items, 200, page * per < all.length ? { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` } : {});
};

function pull(s: State) {
  return { number: 7, title: "Add PR inspection", state: "open", draft: false, merged: false, merged_at: null, closed_at: null, user: { login: "orbit-bot" }, created_at: "2026-11-11T10:00:00Z", updated_at: "2026-11-11T11:00:00Z", base: { ref: "main", sha: BASE }, head: { ref: "orbit/job-1", sha: s.head, repo: { full_name: REPO } }, mergeable: true, mergeable_state: "clean", changed_files: s.files.length, additions: 10, deletions: 2, commits: 3, comments: s.comments.length, review_comments: s.inline.length, body: "Description." };
}

function fake(over: Partial<State> = {}): Fake {
  const state: State = { head: HEAD, files: [], reviews: [], comments: [], inline: [], runs: [], statuses: [], runById: {}, ...over };
  const f: Fake = { calls: [], state, fetcher: undefined as never };
  f.fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? "GET", url: url.href, auth: headers.get("authorization") };
    f.calls.push(call);
    f.onRequest?.(call, f.calls.length);
    if (state.throwWith) throw state.throwWith;
    if (url.hostname !== "api.github.com") return state.blob ? new Response(state.blob.body, { status: state.blob.status }) : j({}, 404);
    if (state.failWith) return j(state.failWith.body ?? {}, state.failWith.status, state.failWith.headers);
    const p = url.pathname;
    const m = (re: RegExp) => re.exec(p);
    if (m(/^\/repos\/[^/]+\/[^/]+\/pulls\/7$/)) return j(pull(state));
    if (m(/\/pulls\/7\/files$/)) return pageOf(url, state.files);
    if (m(/\/pulls\/7\/reviews$/)) return pageOf(url, state.reviews);
    if (m(/\/issues\/7\/comments$/)) return pageOf(url, state.comments);
    if (m(/\/pulls\/7\/comments$/)) return pageOf(url, state.inline);
    const rv = m(/\/pulls\/7\/reviews\/(\d+)$/);
    if (rv) return j(state.reviews.find((r) => String(r.id) === rv[1]) ?? { message: "Not Found" }, state.reviews.some((r) => String(r.id) === rv[1]) ? 200 : 404);
    const ic = m(/\/issues\/comments\/(\d+)$/);
    if (ic) return j(state.comments.find((r) => String(r.id) === ic[1]) ?? { message: "Not Found" }, state.comments.some((r) => String(r.id) === ic[1]) ? 200 : 404);
    const pc = m(/\/pulls\/comments\/(\d+)$/);
    if (pc) return j(state.inline.find((r) => String(r.id) === pc[1]) ?? { message: "Not Found" }, state.inline.some((r) => String(r.id) === pc[1]) ? 200 : 404);
    if (m(/\/check-runs$/)) return pageOf(url, state.runs).status === 200 ? (() => { const page = Number(url.searchParams.get("page") ?? "1"); const items = state.runs.slice((page - 1) * 100, page * 100); return j({ total_count: state.runs.length, check_runs: items }, 200, page * 100 < state.runs.length ? { link: '<https://api.github.com/x>; rel="next"' } : {}); })() : j({});
    if (m(/\/status$/)) return j({ state: "pending", statuses: state.statuses, total_count: state.statuses.length });
    const cr = m(/\/check-runs\/(\d+)$/);
    if (cr) return state.runById[cr[1]!] ? j(state.runById[cr[1]!]) : j({ message: "Not Found" }, 404);
    if (m(/\/actions\/jobs\/\d+\/logs$/)) {
      const l = state.log ?? { status: 404 };
      return new Response(l.body ?? "", { status: l.status, headers: l.location ? { location: l.location } : {} });
    }
    return j({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return f;
}

const tools = (f: Fake, repos = [REPO], token: string | null = TOKEN) => prInspectTools({ token: () => token ?? undefined, repos: () => repos, fetcher: f.fetcher, now: () => NOW });
async function use(f: Fake, name: string, args: Record<string, unknown>, repos?: string[]) {
  const tool = tools(f, repos).find((t) => t.name === name)!;
  const r = await tool.run(args);
  const env = JSON.stringify({ ok: true, provenance: r.provenance, source: r.source, result: r.value });
  assert.ok(env.length <= MAX_OUTPUT_CHARS - 500, `result ${env.length} chars is within the chat transport (${MAX_OUTPUT_CHARS})`);
  assert.ok(env.length <= RESULT_BUDGET + 100);
  assert.ok(!env.includes(TOKEN), "the token is never in a result");
  return r.value as Record<string, any>;
}
const rejects = async (f: Fake, name: string, args: Record<string, unknown>, re: RegExp, repos?: string[]) => {
  const tool = tools(f, repos).find((t) => t.name === name)!;
  await assert.rejects(() => tool.run(args), (e: Error) => (assert.match(e.message, re), assert.ok(!e.message.includes(TOKEN)), true));
};
const A = { repo: REPO, pull: 7 };
const file = (i: number, extra: Record<string, unknown> = {}) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 2, deletions: 1, changes: 3, sha: "d4".repeat(20), patch: `@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d`, ...extra });
const review = (id: number, user: string, state: string, commit: string | null, body: string) => ({ id, user: { login: user }, state, submitted_at: `2026-11-11T11:0${id % 10}:00Z`, commit_id: commit, body, pull_request_url: `https://api.github.com/repos/${REPO}/pulls/7` });

// ---- policy and inputs, before any network ----

test("only the owner may use pull-request inspection, and the policy says so", () => {
  for (const name of PR_INSPECT_TOOL_NAMES) {
    assert.equal(decide("pulls", name, true).allow, true);
    assert.equal(decide("pulls", name, false).allow, false);
    assert.match(decide("pulls", name, false).reason, /only the owner/);
  }
});

test("invalid repo, pull, page, id and head inputs are rejected before any request", async () => {
  const f = fake();
  await rejects(f, "pr_inspect", { repo: "not a repo", pull: 7 }, /owner\/name/);
  await rejects(f, "pr_inspect", { repo: "evil/other", pull: 7 }, /not a repository ORBIT works with/);
  await rejects(f, "pr_inspect", { repo: "../../x/y", pull: 7 }, /owner\/name/);
  await rejects(f, "pr_inspect", { repo: REPO, pull: 0 }, /pull/);
  await rejects(f, "pr_inspect", { repo: REPO, pull: "7; DELETE" }, /pull/);
  await rejects(f, "pr_inspect", { repo: REPO, pull: 1.5 }, /pull/);
  await rejects(f, "pr_inspect", { ...A, extra: 1 }, /Unknown argument/);
  await rejects(f, "pr_inspect", { ...A, expectedHead: "abc" }, /40-character/);
  await rejects(f, "pr_files", { ...A, start: -1 }, /start/);
  await rejects(f, "pr_files", { ...A, start: 3000 }, /start/);
  await rejects(f, "pr_files", { ...A, start: 1.5 }, /start/);
  await rejects(f, "pr_diff", { ...A, path: "" }, /path/);
  await rejects(f, "pr_diff", { ...A, path: "a", offset: -2 }, /offset/);
  await rejects(f, "pr_diff", { ...A, path: "a", expectedPatchSha256: "zz" }, /64-character/);
  await rejects(f, "pr_discussion", { ...A, kind: "everything" }, /kind/);
  await rejects(f, "pr_text", { ...A, kind: "review" }, /id/);
  await rejects(f, "pr_text", { ...A, kind: "description", id: 3 }, /no \{id\}/);
  await rejects(f, "pr_check_log", { ...A, checkId: "x" }, /checkId/);
  await rejects(f, "pr_inspect", A, /No repository|not a repository ORBIT works with/, []);
  assert.equal(f.calls.length, 0, "no request was made for any of them");
  // A repository outside the configured set is refused case-insensitively matched, never queried.
  await use(f, "pr_inspect", { repo: REPO.toUpperCase(), pull: 7 });
  assert.ok(f.calls.every((c) => c.url.startsWith(`https://api.github.com/repos/${REPO}/`)), "the canonical configured name is what is queried");
});

test("without the pull-request credential the tools say so and make no request", async () => {
  const f = fake();
  const tool = tools(f, [REPO], null).find((t) => t.name === "pr_inspect")!;
  await assert.rejects(() => tool.run(A), /orbit\.github-orbit-prs\) is installed|No pull-request credential/);
  assert.equal(f.calls.length, 0);
});

// ---- metadata, provenance, read-only, token ----

test("pr_inspect gives identity, base and head SHAs, timestamps and provenance, using only GET to api.github.com", async () => {
  const f = fake({ files: [file(1)] });
  const v = await use(f, "pr_inspect", A);
  assert.equal(v.inspection.repo, REPO);
  assert.equal(v.inspection.pull, 7);
  assert.equal(v.inspection.headSha, HEAD);
  assert.equal(v.inspection.baseSha, BASE);
  assert.equal(v.inspection.stale, false);
  assert.equal(v.inspection.fetchedAt, NOW.toISOString());
  assert.equal(v.inspection.headCheckedAfter, NOW.toISOString());
  assert.equal(v.inspection.headUnchangedDuringRead, true);
  assert.match(v.inspection.source, /GET requests only/);
  assert.match(v.inspection.untrustedText, /never instructions/);
  assert.deepEqual([v.pullRequest.base.sha, v.pullRequest.head.sha, v.pullRequest.head.fromFork, v.pullRequest.title], [BASE, HEAD, false, "Add PR inspection"]);
  assert.ok(f.calls.length >= 2);
  assert.ok(f.calls.every((c) => c.method === "GET" && c.url.startsWith("https://api.github.com/")));
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});

test("the inspection code has no way to write: no write verbs, no request body, redirects never auto-followed", () => {
  const src = readFileSync(new URL("../src/pr-inspect.ts", import.meta.url), "utf8");
  assert.ok(!/["'`](POST|PUT|PATCH|DELETE)["'`]/.test(src));
  const init = /fetcher\(url, (\{[^}]*\})/.exec(src)?.[1] ?? "";
  assert.ok(init.includes("method") && !/body/.test(init), "the one request ORBIT makes carries no body");
  assert.equal((src.match(/fetcher\(/g) ?? []).length, 1, "there is exactly one place a request is made");
  assert.match(src, /method: "GET"/);
  assert.match(src, /redirect: "manual"/);
  assert.ok(!/githubCaller|pull-requests\.ts/.test(src), "it does not reuse the writing client");
});

test("a redirect on the API is not followed and the token is not forwarded", async () => {
  const f = fake();
  f.state.failWith = { status: 301, body: {}, headers: { location: "https://evil.example/steal" } };
  await rejects(f, "pr_inspect", A, /redirected .*does not follow redirects/);
  assert.deepEqual(f.calls.map((c) => new URL(c.url).hostname), ["api.github.com"]);
});

// ---- files and diffs ----

test("pr_files pages through every file with explicit metadata and never exceeds the transport", async () => {
  const files = Array.from({ length: 250 }, (_, i) => file(i, { filename: `src/dir/${"x".repeat(80)}${i}.ts` }));
  const f = fake({ files });
  const seen: string[] = [];
  let start = 0;
  let pages = 0;
  for (;;) {
    const v = await use(f, "pr_files", { ...A, start, expectedHead: HEAD });
    pages++;
    assert.equal(v.inspection.stale, false);
    assert.equal(v.start, start);
    assert.equal(v.totalItems, 250);
    seen.push(...v.files.map((x: any) => x.path));
    if (v.nextStart === null) {
      assert.equal(v.listComplete, true);
      break;
    }
    assert.equal(v.listComplete, false);
    assert.equal(v.nextStart, start + v.returned);
    start = v.nextStart;
  }
  assert.equal(new Set(seen).size, 250);
  assert.ok(pages > 3, "a long list takes several pages");
});

test("a patch longer than one result is read in chunks that join back to the exact original", async () => {
  const patch = `@@ -1,400 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => ` line ${i} "quoted" \\ ${"y".repeat(60)}`).join("\n")}`;
  const f = fake({ files: [file(1, { filename: "src/big.ts", patch, additions: 0, deletions: 0, changes: 400 })] });
  let offset = 0;
  let text = "";
  let digest: string | undefined;
  let chunks = 0;
  for (;;) {
    const v = await use(f, "pr_diff", { ...A, path: "src/big.ts", offset, expectedHead: HEAD, ...(digest ? { expectedPatchSha256: digest } : {}) });
    chunks++;
    digest = v.patch.patchSha256;
    assert.equal(v.patch.totalChars, patch.length);
    assert.equal(v.patch.offset, offset);
    text += v.text;
    if (v.patch.nextOffset === null) break;
    assert.equal(v.patch.complete, false);
    offset = v.patch.nextOffset;
  }
  assert.equal(text, patch);
  assert.ok(chunks > 2);
  await rejects(f, "pr_diff", { ...A, path: "src/big.ts", expectedPatchSha256: "0".repeat(64) }, /patch is different/);
  await rejects(f, "pr_diff", { ...A, path: "src/big.ts", offset: patch.length + 5 }, /past the end/);
  await rejects(f, "pr_diff", { ...A, path: "src/missing.ts" }, /No changed file named/);
});

test("binary, unavailable, rename-only and GitHub-truncated patches are reported, never shown as empty", async () => {
  const cut = "@@ -1,10 +1,10 @@\n a\n b\n c";
  assert.equal(patchLooksTruncated(cut), true);
  assert.equal(patchLooksTruncated("@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d"), false);
  assert.equal(patchLooksTruncated("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file"), false);
  const f = fake({
    files: [
      file(1, { filename: "img.png", patch: undefined, changes: 0 }),
      file(2, { filename: "huge.ts", patch: undefined, changes: 9000 }),
      file(3, { filename: "renamed.ts", patch: undefined, changes: 0, status: "renamed", previous_filename: "old.ts" }),
      file(4, { filename: "cut.ts", patch: cut }),
    ],
  });
  const v = await use(f, "pr_files", A);
  const by = Object.fromEntries(v.files.map((x: any) => [x.path, x]));
  assert.equal(by["huge.ts"].patch.state, "absent");
  assert.match(by["huge.ts"].patch.reason, /binary, too large|NOT shown to be empty/);
  assert.match(by["renamed.ts"].patch.reason, /no content changes/);
  assert.equal(by["renamed.ts"].renamedFrom, "old.ts");
  assert.equal(by["cut.ts"].patch.truncatedByGitHub, true);
  const d = await use(f, "pr_diff", { ...A, path: "huge.ts" });
  assert.equal(d.text, null);
  assert.equal(d.patch.state, "absent");
  const c = await use(f, "pr_diff", { ...A, path: "cut.ts" });
  assert.equal(c.patch.truncatedByGitHub, true);
  assert.match(c.patch.note, /cut it/);
  assert.equal(c.text, cut);
});

test("GitHub's 3,000-file listing limit is stated, and a short list is called incomplete", async () => {
  const f = fake({ files: [file(1)] });
  const p = (await use(f, "pr_files", A)) as any;
  assert.equal(p.listComplete, true);
  const big = fake({ files: Array.from({ length: 3 }, (_, i) => file(i)) });
  const origin = big.fetcher;
  big.fetcher = (async (i: any, init: any) => {
    const r = await origin(i, init);
    if (String(i).includes("/pulls/7") && !String(i).includes("/files") && !String(i).includes("reviews")) {
      const body = await r.json();
      return j({ ...body, changed_files: 3500 });
    }
    return r;
  }) as typeof fetch;
  const v = await use(big, "pr_files", A);
  assert.match(v.limitNote, /at most 3,000 files/);
});

// ---- staleness ----

test("a call pinned to an older head returns a stale marker and no data, after one request", async () => {
  const f = fake({ files: [file(1)] });
  const v = await use(f, "pr_files", { ...A, expectedHead: OLD });
  assert.equal(v.inspection.stale, true);
  assert.equal(v.inspection.currentHead, HEAD);
  assert.equal(v.inspection.expectedHead, OLD);
  assert.equal(v.data, null);
  assert.ok(!("files" in v));
  assert.match(v.inspection.staleReason, /older head/);
  assert.equal(f.calls.length, 1);
});

test("a head that moves while a call is reading marks the result stale and withholds the data", async () => {
  const f = fake({ files: Array.from({ length: 150 }, (_, i) => file(i)) });
  // The head moves after the file page has been fetched.
  f.onRequest = (c) => {
    if (c.url.includes("/files")) setTimeout(() => {}, 0);
  };
  const orig = f.fetcher;
  f.fetcher = (async (i: any, init: any) => {
    const r = await orig(i, init);
    if (String(i).includes("/files")) f.state.head = OLD;
    return r;
  }) as typeof fetch;
  const v = await use(f, "pr_diff", { ...A, path: "src/f120.ts", expectedHead: HEAD });
  assert.equal(v.inspection.stale, true);
  assert.equal(v.inspection.currentHead, OLD);
  assert.equal(v.data, null);
  assert.match(v.inspection.staleReason, /moved from .* to .* while this call was reading/);
  assert.ok(!("text" in v));
});

// ---- reviews, comments ----

test("reviews keep their commit ids and staleness; superseded reviews and unassociated comments are represented honestly", async () => {
  const long = `${"Finding detail. ".repeat(500)}\n\nVerdict: blocking issues`;
  const f = fake({
    reviews: [review(1, "rev", "CHANGES_REQUESTED", OLD, long), review(2, "rev", "APPROVED", HEAD, "Looks fine now."), review(3, "other", "COMMENTED", null, "")],
    comments: [{ id: 50, user: { login: "rai" }, created_at: "2026-11-11T11:30:00Z", updated_at: "2026-11-11T11:30:00Z", author_association: "OWNER", body: "Verdict: no blocking issues" }],
    inline: [{ id: 60, user: { login: "rev" }, pull_request_review_id: 1, path: "src/a.ts", line: null, original_line: 3, commit_id: OLD, original_commit_id: OLD, created_at: "2026-11-11T11:01:00Z", body: "off by one" }],
  });
  const r = await use(f, "pr_discussion", { ...A, kind: "reviews", expectedHead: HEAD });
  const [r1, r2, r3] = r.items;
  assert.deepEqual([r1.commitId, r1.commitRelation, r1.stale, r1.supersededByLaterReviewFromSameUser, r1.state], [OLD, "older-commit", true, true, "CHANGES_REQUESTED"]);
  assert.deepEqual([r2.commitId, r2.commitRelation, r2.stale, r2.supersededByLaterReviewFromSameUser, r2.state], [HEAD, "head", false, false, "APPROVED"]);
  assert.deepEqual([r3.commitId, r3.commitRelation, r3.stale], [null, "none", false]);
  assert.deepEqual(r1.verdictLines, ["Verdict: blocking issues"], "the final verdict line is surfaced verbatim, from beyond the preview");
  assert.equal(r1.bodyChars, long.length);
  assert.equal(r1.bodyPreviewClipped, true);
  assert.deepEqual(r3.verdictLines, [], "no verdict line means none is claimed");
  const c = await use(f, "pr_discussion", { ...A, kind: "comments" });
  assert.equal(c.items[0].commitId, null);
  assert.equal(c.items[0].commitRelation, "none");
  assert.match(c.items[0].commitNote, /not tied to any commit/);
  assert.equal(c.items[0].stale, undefined, "an unassociated comment is never called stale or current");
  const i = await use(f, "pr_discussion", { ...A, kind: "inline" });
  assert.deepEqual([i.items[0].outdated, i.items[0].commitRelation, i.items[0].stale, i.items[0].originalCommitId], [true, "older-commit", true, OLD]);
});

test("a long review with a final blocking verdict past 4,000 characters is fully recoverable through the real chat loop", async () => {
  const body = `${"Detailed finding with some text. ".repeat(400)}\n\n## Findings\n1. src/a.ts:3 off by one\n\nVerdict: blocking issues`;
  assert.ok(body.length > 12_000 && body.indexOf("Verdict: blocking issues") > 4000);
  const f = fake({ reviews: [review(9, "rev", "COMMENTED", HEAD, body)] });
  const toolsList = tools(f);
  const outputs: string[] = [];
  let nextOffset: number | null = 0;
  let digest: string | undefined;
  let step = 0;
  const model: ModelPort = {
    status: () => ({ port: "model", state: "live", impl: "fake", detail: "t", verifiedAt: NOW.toISOString() }),
    reply: async () => ({ value: "x", provenance: "live", source: "t" }),
    step: async (input: Item[]): Promise<Step> => {
      const last = input.at(-1) as { type?: string; output?: string } | undefined;
      if (last?.type === "function_call_output") {
        outputs.push(last.output!);
        const out = JSON.parse(last.output!);
        nextOffset = out.result?.text?.nextOffset ?? null;
        digest = out.result?.text?.textSha256;
      }
      if (step++ > 0 && nextOffset === null) return { text: "done", calls: [] };
      return { text: "", calls: [{ call_id: `c${step}`, name: "pr_text", arguments: JSON.stringify({ ...A, kind: "review", id: 9, offset: nextOffset, expectedHead: HEAD, ...(digest ? { expectedTextSha256: digest } : {}) }) }] };
    },
  };
  const out = await runChat({ model, messages: [{ role: "user", content: "read it" }], limits: [], tools: toolsList, maxRounds: 20 });
  assert.equal(out.text, "done");
  assert.ok(outputs.length >= 2, "the text took several calls");
  assert.ok(outputs.every((o) => o.length <= MAX_OUTPUT_CHARS && !o.includes("(truncated)")), "the transport clipped nothing");
  const joined = outputs.map((o) => JSON.parse(o).result.body as string).join("");
  assert.equal(joined, body, "the chunks are exactly the original text");
  const first = JSON.parse(outputs[0]!).result;
  assert.deepEqual(first.text.verdictLinesInWholeText, ["Verdict: blocking issues"]);
  assert.equal(first.item.commitRelation, "head");
  assert.equal(first.text.complete, false);
  const lastOut = JSON.parse(outputs.at(-1)!).result;
  assert.equal(lastOut.text.complete, true);
  assert.equal(lastOut.text.nextOffset, null);
  assert.match(lastOut.body, /Verdict: blocking issues$/);
});

test("pr_text refuses an id from another PR and detects a changed text between chunks", async () => {
  const f = fake({ comments: [{ id: 50, user: { login: "rai" }, created_at: "x", updated_at: "x", body: "hello", issue_url: `https://api.github.com/repos/${REPO}/issues/7` }] });
  const v = await use(f, "pr_text", { ...A, kind: "issue_comment", id: 50 });
  assert.equal(v.body, "hello");
  assert.equal(v.item.commitRelation, "none");
  const other = fake({ comments: [{ id: 50, user: { login: "rai" }, body: "hi", issue_url: `https://api.github.com/repos/${REPO}/issues/99` }] });
  await rejects(other, "pr_text", { ...A, kind: "issue_comment", id: 50 }, /does not belong to PR #7/);
  await rejects(f, "pr_text", { ...A, kind: "issue_comment", id: 50, expectedTextSha256: "1".repeat(64) }, /changed since/);
  await rejects(f, "pr_text", { ...A, kind: "issue_comment", id: 51 }, /not found/);
  const d = await use(f, "pr_text", { ...A, kind: "description" });
  assert.equal(d.body, "Description.");
});

// ---- checks ----

const run = (id: number, name: string, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({ id, name, status, conclusion, app: { slug: "github-actions" }, started_at: `2026-11-11T11:0${id % 10}:00Z`, completed_at: status === "completed" ? "2026-11-11T11:09:00Z" : null, html_url: `https://github.com/${REPO}/runs/${id}`, output: { title: "t", summary: "s" }, head_sha: HEAD, ...extra });

test("every check state stays distinct, reruns are marked superseded, and nothing is declared ready", async () => {
  const f = fake({
    runs: [run(1, "typecheck", "completed", "failure"), run(2, "typecheck", "completed", "success"), run(3, "test", "completed", "failure"), run(4, "lint", "in_progress", null), run(5, "queued-job", "queued", null), run(6, "opt", "completed", "skipped"), run(7, "info", "completed", "neutral"), run(8, "slow", "completed", "timed_out"), run(9, "gone", "completed", "cancelled"), run(10, "gate", "completed", "action_required")],
    statuses: [{ id: 100, context: "ci/legacy", state: "error", description: "boom", target_url: "https://ci.example/1", created_at: "x", updated_at: "y" }, { id: 101, context: "ci/other", state: "pending", description: "", target_url: null, created_at: "x", updated_at: "y" }],
  });
  const v = await use(f, "pr_checks", { ...A, expectedHead: HEAD });
  const by = Object.fromEntries(v.checks.map((c: any) => [`${c.kind}:${c.id}`, c]));
  assert.deepEqual([by["check_run:1"].outcome, by["check_run:1"].superseded], ["failed", true]);
  assert.deepEqual([by["check_run:2"].outcome, by["check_run:2"].superseded], ["passed", false]);
  assert.equal(by["check_run:3"].outcome, "failed");
  assert.equal(by["check_run:4"].outcome, "running");
  assert.equal(by["check_run:5"].outcome, "queued");
  assert.equal(by["check_run:6"].outcome, "skipped");
  assert.equal(by["check_run:7"].outcome, "neutral");
  assert.equal(by["check_run:8"].outcome, "timed_out");
  assert.equal(by["check_run:9"].outcome, "cancelled");
  assert.equal(by["check_run:10"].outcome, "action_required");
  assert.equal(by["status:100"].outcome, "error");
  assert.equal(by["status:101"].outcome, "pending");
  assert.match(by["check_run:3"].log, /pr_check_log/);
  assert.equal(v.summary.supersededEntries, 1);
  assert.equal(v.summary.listingComplete, true);
  assert.equal(v.summary.latestEntriesByOutcome.failed, 1);
  assert.match(v.summary.note, /no readiness or merge conclusion/);
  assert.ok(!/ready|mergeable/i.test(JSON.stringify(v.summary).replace(/no readiness or merge conclusion/, "")));
});

test("no checks at all is reported as unknown, not as a pass; many checks are paged", async () => {
  const none = await use(fake(), "pr_checks", A);
  assert.match(none.summary.emptyNote, /not a pass/);
  const f = fake({ runs: Array.from({ length: 130 }, (_, i) => run(i + 1, `job-${i}`, "completed", i % 2 ? "success" : "failure")) });
  const names: string[] = [];
  let start = 0;
  for (;;) {
    const v = await use(f, "pr_checks", { ...A, start });
    names.push(...v.checks.map((c: any) => c.name));
    if (v.nextStart === null) break;
    start = v.nextStart;
  }
  assert.equal(new Set(names).size, 130);
});

test("a failure log excerpt is bounded, redacted, starts at the error, and is fetched without the token", async () => {
  const secret = `${"gh"}${"p_"}${"Z".repeat(36)}`;
  const log = `${Array.from({ length: 300 }, (_, i) => `2026-11-11T11:00:0${i % 10}Z step line ${i}`).join("\n")}\n##[error]Process completed with exit code 1.\nusing token ${secret}\nAuthorization: Bearer ${"k".repeat(30)}\n`;
  const f = fake({ runById: { 3: run(3, "test", "completed", "failure") }, log: { status: 302, location: "https://pipelines.actions.githubusercontent.com/log/abc" }, blob: { status: 200, body: log } });
  const v = await use(f, "pr_check_log", { ...A, checkId: 3, expectedHead: HEAD });
  assert.equal(v.check.outcome, "failed");
  assert.match(v.text, /##\[error\]Process completed/);
  assert.ok(!v.text.includes(secret));
  assert.ok(!v.text.includes("k".repeat(30)));
  assert.match(v.text, /redacted/);
  assert.match(v.excerpt.basis, /first ##\[error\] line/);
  assert.equal(v.excerpt.logReadInFull, true);
  const blob = f.calls.find((c) => new URL(c.url).hostname === "pipelines.actions.githubusercontent.com")!;
  assert.equal(blob.auth, null, "the token is never sent to the blob host");
  assert.ok(f.calls.filter((c) => new URL(c.url).hostname === "api.github.com").every((c) => c.auth === `Bearer ${TOKEN}`));
  // A large excerpt is paged and joins back together.
  const big = `##[error]start\n${"e".repeat(7) + " word ".repeat(9000)}`;
  const g = fake({ runById: { 3: run(3, "test", "completed", "failure") }, log: { status: 200, body: big } });
  let off = 0;
  let joined = "";
  for (let n = 0; n < 20; n++) {
    const r = await use(g, "pr_check_log", { ...A, checkId: 3, offset: off });
    joined += r.text;
    if (r.excerpt.nextOffset === null) {
      assert.equal(r.excerpt.cappedAtChars, 20_000);
      break;
    }
    off = r.excerpt.nextOffset;
  }
  assert.equal(joined.length, 20_000);
});

test("a log redirect to an untrusted host is refused and nothing is fetched there", async () => {
  const f = fake({ runById: { 3: run(3, "test", "completed", "failure") }, log: { status: 302, location: "https://evil.example/x" } });
  const v = await use(f, "pr_check_log", { ...A, checkId: 3 });
  assert.equal(v.excerpt, null);
  assert.match(v.unavailable, /does not trust/);
  assert.ok(!f.calls.some((c) => c.url.includes("evil.example")));
});

test("an unavailable log (no permission, expired, unfinished, other app, other commit) is stated honestly", async () => {
  const denied = fake({ runById: { 3: run(3, "test", "completed", "failure") }, log: { status: 403 } });
  const v = await use(denied, "pr_check_log", { ...A, checkId: 3 });
  assert.equal(v.excerpt, null);
  assert.match(v.unavailable, /lacks the read permission/);
  const running = fake({ runById: { 4: run(4, "t", "in_progress", null) } });
  assert.match((await use(running, "pr_check_log", { ...A, checkId: 4 })).unavailable, /not finished/);
  const app = fake({ runById: { 5: run(5, "ext", "completed", "failure", { app: { slug: "other-ci" }, output: { title: "Build failed", summary: `see token=${"s".repeat(20)}`, text: "details" } }) } });
  const o = await use(app, "pr_check_log", { ...A, checkId: 5 });
  assert.match(o.excerpt.source, /check-run output/);
  assert.ok(!o.text.includes("s".repeat(20)));
  assert.equal(app.calls.some((c) => c.url.includes("/actions/")), false);
  const old = fake({ runById: { 6: run(6, "t", "completed", "failure", { head_sha: OLD }) } });
  await rejects(old, "pr_check_log", { ...A, checkId: 6 }, /not the PR's head/);
});

// ---- failures ----

test("permission, rate limit, auth, not-found, server and timeout failures are actionable and never leak the token", async () => {
  const cases: [Partial<State>, RegExp][] = [
    [{ failWith: { status: 403, body: { message: "Resource not accessible by integration" } } }, /lacks the read permission.*not widen/],
    [{ failWith: { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793000000" } } }, /rate limit was reached.*resets at 20\d\d-/],
    [{ failWith: { status: 429, headers: { "retry-after": "30" } } }, /rate limit.*Retry after 30s/],
    [{ failWith: { status: 401, body: { message: `Bad credentials ${TOKEN}` } } }, /rejected ORBIT's pull-request token/],
    [{ failWith: { status: 404 } }, /not found/],
    [{ failWith: { status: 502 } }, /HTTP 502.*Try again/],
    [{ throwWith: Object.assign(new Error("t"), { name: "TimeoutError" }) }, /did not answer within 15s/],
    [{ throwWith: new Error(`socket closed ${TOKEN}`) }, /Could not reach GitHub/],
  ];
  for (const [over, re] of cases) await rejects(fake(over), "pr_inspect", A, re);
});

test("a malformed GitHub answer is an error, not an empty result", async () => {
  const f = fake();
  const o = f.fetcher;
  f.fetcher = (async (i: any, init: any) => (String(i).endsWith("/pulls/7") ? j({ head: {}, base: {} }) : o(i, init))) as typeof fetch;
  await rejects(f, "pr_inspect", A, /no usable head and base/);
});

// ---- the real server: owner gate, offered tools, no network for others ----

const sc = (steps: Step[]): ModelPort => {
  let i = 0;
  return { status: () => ({ port: "model", state: "live", impl: "fake", detail: "t", verifiedAt: NOW.toISOString() }), reply: async () => ({ value: "plain", provenance: "live", source: "t" }), step: async () => steps[Math.min(i++, steps.length - 1)]! };
};
let caller: string | undefined = "rai@example.com";
let model: ModelPort = sc([]);
const gh = fake({ files: [file(1)] });
const notify = notifier(jsonStore(undefined, "n", []));
const memoryPort = vaultMemory(mkdtempSync(join(tmpdir(), "orbit-prinspect-")));
const server = buildServer({
  ports: MOCK_PORT_NAMES.map((n) => mockPort(n)),
  model: { status: () => model.status(), reply: (...a) => model.reply(...a), step: (...a) => model.step!(...a) },
  memory: memoryPort,
  notify,
  schedule: scheduler(jsonStore(undefined, "s", []), notify),
  runs: runner(jsonStore(undefined, "r", []), [memoryReport(memoryPort)], notify),
  tools: toolbox([]),
  nodes: devicePresence(async () => ({ Self: { HostName: "h", OS: "linux" }, User: {}, Peer: {} }), "rai@example.com"),
  jobs: jobRegistry(jsonStore(undefined, "j", []), Buffer.alloc(32, 1), notify),
  commit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b",
  owner: "rai@example.com",
  identify: async () => caller,
  prInspect: tools(gh),
});
let base = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
const chat = () => fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "look at PR 7" }] }) });

test("through the server: the owner gets the tools and they run; anyone else gets no tools and no request is made", async () => {
  caller = "rai@example.com";
  const offered: string[][] = [];
  const ownerModel = sc([{ text: "", calls: [{ call_id: "a", name: "pr_inspect", arguments: JSON.stringify(A) }] }, { text: "inspected", calls: [] }]);
  const inner = ownerModel.step!;
  ownerModel.step = async (i, l, n, t) => (offered.push(t.map((x) => x.name)), inner(i, l, n, t));
  model = ownerModel;
  const body = await (await chat()).json();
  assert.equal(body.calls[0].name, "pr_inspect");
  assert.equal(body.calls[0].ok, true);
  assert.ok(PR_INSPECT_TOOL_NAMES.every((n) => offered[0]!.includes(n)));
  assert.ok(gh.calls.length >= 2);
  const before = gh.calls.length;

  caller = "someone@example.com";
  const otherOffered: string[][] = [];
  const other = sc([{ text: "", calls: [{ call_id: "b", name: "pr_inspect", arguments: JSON.stringify(A) }] }, { text: "hi", calls: [] }]);
  const innerOther = other.step!;
  other.step = async (i, l, n, t) => (otherOffered.push(t.map((x) => x.name)), innerOther(i, l, n, t));
  model = other;
  const res = await (await chat()).json();
  assert.deepEqual(res.calls, []);
  assert.ok(res.limits.some((l: string) => l.startsWith("chat tools are refused")));
  assert.equal(gh.calls.length, before, "a non-owner caused no GitHub request");
  caller = "rai@example.com";
});

test("a tool the policy refuses never reaches the network even if the model names it", async () => {
  const f = fake();
  const refuse = (tool: string) => decide("agent", tool, false).reason;
  const out = await runChat({ model: sc([{ text: "", calls: [{ call_id: "z", name: "pr_files", arguments: JSON.stringify(A) }] }, { text: "ok", calls: [] }]), messages: [{ role: "user", content: "x" }], limits: [], tools: tools(f), allow: (t) => (decide("agent", t, false).allow ? undefined : refuse(t)) });
  assert.equal(out.calls[0]!.ok, false);
  assert.match(out.calls[0]!.summary, /only the owner/);
  assert.equal(f.calls.length, 0);
});

test("no tool here is a ChatTool that proposes or writes", () => {
  const list: ChatTool[] = tools(fake());
  assert.deepEqual(list.map((t) => t.name), [...PR_INSPECT_TOOL_NAMES]);
  for (const t of list) assert.match(t.description, /Read-only/);
});
