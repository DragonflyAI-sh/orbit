import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A scripted fake of the routes the web page reads, with synthetic conversations of any length, for the app-shell layout
// checks (test/app-shell-browser.test.ts) and the screenshot script (test/helpers/shell-screens.ts). Nothing here is real
// data: every message, title and notification is made up. The page itself is served from src/web/index.html (or the
// `html` override, for before/after comparisons).

const avatar = readFileSync(new URL("../../src/web/avatar.png", import.meta.url));
export const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const CODE = "```ts\n" + Array.from({ length: 14 }, (_, i) => `const value${i} = computeSomethingLong(${i}, "a fairly long argument string that runs past the edge of a phone screen");`).join("\n") + "\n```";
const TABLE = "| column one | column two | column three | column four |\n|---|---|---|---|\n| alpha | beta | gamma | delta |\n| 1 | 2 | 3 | 4 |";
const URL_LINE = "See https://github.com/example/very-long-repository-name/pull/12345/files#diff-0123456789abcdef0123456789abcdef0123456789abcdef for details.";

// One synthetic exchange. `i` varies the text so rows differ.
function exchange(i: number, at: (n: number) => string) {
  const user = { id: `u${i}`, role: "user", at: at(2 * i), text: i % 3 === 0 ? `Question ${i}: can you summarise the build status and what is left before the release?` : `Short question ${i}` };
  const kinds = [
    `Answer ${i}. Everything is green except one flaky test that retries.`,
    `Answer ${i} with a code sample:\n\n${CODE}`,
    `Answer ${i} with a table:\n\n${TABLE}\n\n${URL_LINE}`,
    `Answer ${i}, a longer paragraph. ${"This sentence repeats to make a long, wrapping message body. ".repeat(6)}`,
  ];
  const reply = { id: `a${i}`, role: "assistant", at: at(2 * i + 1), text: kinds[i % kinds.length], status: "done", provenance: "live", source: "model/fake" };
  return [user, reply];
}

export type ShellOpts = { exchanges?: number; pending?: boolean; notes?: number; card?: boolean; html?: string };

export function shellServer(opts: ShellOpts = {}) {
  let o: ShellOpts = { exchanges: 2, pending: false, notes: 3, card: false, ...opts };
  const base = Date.parse("2026-11-18T05:00:00Z");
  const at = (n: number) => new Date(base + n * 60_000).toISOString();
  const page = () => o.html ?? readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
  const messages = () => {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < (o.exchanges ?? 0); i++) out.push(...exchange(i, at));
    if (o.card && out.length) (out.at(-1) as Record<string, unknown>).cards = ["k1"];
    if (o.pending) out.push({ id: "pending", role: "assistant", at: at(999), text: "Working on it — streaming a partial answer so far…", status: "pending", calls: [] });
    return out;
  };
  const card = { id: "k1", kind: "job_launch", routine: "orbit", brief: "Synthetic job brief: tidy the test fixtures.\nSecond line of the brief.", state: "open", digest: "d".repeat(64), duplicates: [] };
  const assistant = () => ({
    session: { schema: 1, id: "assistant", createdAt: at(0) }, title: "Assistant", persisted: true, problems: [], busy: Boolean(o.pending), rev: 1, archivedChunks: 0,
    chunks: [{ seq: 1, id: "c1", createdAt: at(0), state: "open", cards: o.card ? [card] : [], messages: messages() }],
    next: { included: [{ seq: 1, form: "full", chars: 10 }], omitted: [], historyChars: 10 },
    budgets: { unit: "characters", activeChars: 32000, chunkMaxChars: 12000, contextChars: 52000, notesMaxChars: 12000 },
  });
  const thread = () => ({ id: T1, title: "A synthetic session with a deliberately long title that will not fit", rev: 1, busy: Boolean(o.pending), archived: false, cards: o.card ? [card] : [], messages: messages() });
  const notes = () => Array.from({ length: o.notes ?? 0 }, (_, i) => ({ id: `n${i}`, at: at(i), text: `Synthetic notification ${i + 1}: job orbit-2026111800${i}0-abcd finished.\nIt pushed a branch and wrote a summary.` }));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const drain = () => new Promise<void>((r) => { req.on("data", () => {}); req.on("end", () => r()); });
    const p = url.pathname;
    if (p === "/" || p === "/sessions" || p.startsWith("/sessions/") || p === "/chat") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page()); }
    if (p === "/avatar.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(avatar); }
    if (p === "/photos.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(readFileSync(new URL("../../src/web/photos.js", import.meta.url))); }
    if (p === "/status") return json(200, { ports: [{ port: "model", state: "live" }, { port: "vault", state: "live" }, { port: "jobs", state: "degraded" }], deploy: { at: at(0), commit: "0123456789abcdef0123456789abcdef01234567" } });
    if (p === "/notifications") return json(200, { inbox: notes() });
    if (p.startsWith("/notifications/")) { await drain(); return json(200, { ok: true }); }
    if (p === "/model/login") return json(403, { error: "no" });
    if (p === "/chat/proposals") return json(200, { proposals: [] });
    if (p === "/jobs") return json(200, { jobs: [] });
    if (p === "/threads") return json(200, { threads: [
      { id: T1, title: thread().title, archived: false, rev: 1, busy: false, openCards: 0, messageCount: 4 },
      { id: T2, title: "Second synthetic session", archived: false, rev: 1, busy: false, openCards: 0, messageCount: 2 },
    ], notice: null });
    if (p === `/threads/${T1}`) return json(200, { thread: thread() });
    if (p === `/threads/${T2}`) return json(200, { thread: { id: T2, title: "Second synthetic session", rev: 1, busy: false, archived: false, cards: [], messages: [] } });
    if (p === "/assistant") return json(200, { assistant: assistant() });
    if (p === "/assistant/messages" && req.method === "POST") { await drain(); return json(200, { assistant: assistant() }); }
    json(404, { error: "not found" });
  });
  return {
    server,
    set(next: ShellOpts) { o = { ...o, ...next }; },
    async start() { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; },
    close() { server.close(); },
  };
}
