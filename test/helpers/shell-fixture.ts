import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sidebarNote, sidebarView } from "../../src/sidebar.ts";
import { dayIn, planOverview, projectDetail } from "../../src/plan.ts";
import type { SidebarPhoto } from "../../src/sidebar.ts";
import { serveWebAsset } from "./web-assets.ts";

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

// Synthetic vault notes and photos for the left sidebar (docs/sidebar.md), read through the real sidebarView, and for the
// Plan views (docs/plan.md), read through the real planOverview and projectDetail on a fixed day, so relative dates are stable.
export const PLAN_NOW = new Date("2026-11-26T20:00:00Z");
export const SIDEBAR_NOTES = new Map<string, string>([
  ["now.md", "# Now\n\n## Top priorities\n- Ship the synthetic release\n- Review the fixture plan\n"],
  ["Projects/alpha-garden.md", "---\nstatus: active\npriority: 1\narea: home\nstarted: 2026-09-01\ntarget: 2026-12-15\nupdated: 2026-11-20\naliases: [Alpha Garden]\ntags: [project]\n---\n# Alpha Garden\n\n## Outcome\nA synthetic vegetable garden that feeds the household through winter. Beds, watering and a trellis.\n\n## Next actions\n- [ ] Order the synthetic seeds\n- [x] Measure the beds\n- Draw the watering plan\n\n## Milestones\n- [x] 2026-10-01: Beds built\n- [ ] 2026-12-01: First planting\n\n## Beds\n| # | Bed | Status |\n| --- | --- | --- |\n| 1 | North bed | done |\n| 2 | South bed | idea |\n| 3 | Herb box | idea |\n\n## Resume here\nPick up at the trellis sketch.\n\n## Log\n- 2026-11-24 18:30 UTC: Trellis sketch drafted (#orbit1234567890123456789).\n- 2026-11-10: Soil delivered.\n\n## Notes\n- Ask about the community seed swap.\n\n## Locations\n- ~/projects/alpha-garden\n"],
  ["Projects/beta-desk.md", "---\nstatus: paused\npriority: 3\nupdated: 2026-10-02\n---\n# Beta Desk\n\n## Plan\n- Sand the top\n"],
  ["Projects/gamma-roof.md", "---\nstatus: active\npriority: 2\ntarget: 2026-11-01\nupdated: 2026-11-25\n---\n# Gamma Roof\n\n## Outcome\nA dry synthetic shed roof.\n\n## Blockers\n- Waiting on the roofer's quote\n\n## Next steps\n- Call the roofer\n"],
  ["Projects/old-shed.md", "---\nstatus: done\n---\n# Old Shed\n"],
  ["Tasks/buy-seeds.md", "---\nstatus: todo\nproject: \"[[alpha-garden]]\"\ndue: 2026-11-30\n---\n# Buy seeds\n"],
  ["Tasks/fix-drawer.md", "---\nstatus: todo\nproject: \"[[beta-desk]]\"\n---\n# Fix the drawer\n"],
  ["Resources/soil-notes.md", "# Soil notes\n\nFor [[alpha-garden]]: loam, not clay.\n"],
]);
export const SIDEBAR_REFS = ["ph_" + "a".repeat(32), "ph_" + "b".repeat(32), "ph_" + "c".repeat(32)];
const sidebarPhotos = (at: (n: number) => string): SidebarPhoto[] => [
  { ref: SIDEBAR_REFS[0]!, sentAt: at(30), sentLocal: "Nov 17, 9:30 PM", caption: "The alpha garden beds after rain", conversation: { id: "assistant:assistant", kind: "assistant", title: "Assistant" }, present: true },
  { ref: SIDEBAR_REFS[1]!, sentAt: at(20), sentLocal: "Nov 17, 9:20 PM", caption: "Desk drawer runner", conversation: { id: `chat:${T1}`, kind: "chat", title: "Beta desk repairs" }, present: true },
  { ref: SIDEBAR_REFS[2]!, sentAt: at(10), sentLocal: "Nov 17, 9:10 PM", caption: "", conversation: { id: "assistant:assistant", kind: "assistant", title: "Assistant" }, present: true },
];

// The same photos as the gallery page reads them (GET /gallery/photos, docs/photo-gallery.md): no saved observations.
const galleryPhoto = (ph: SidebarPhoto) => ({
  ref: ph.ref, src: `/assistant/photos/${ph.ref}`, status: "ok", sentAt: ph.sentAt, sentLocal: ph.sentLocal, day: ph.sentAt.slice(0, 10), month: ph.sentAt.slice(0, 7), caption: ph.caption,
  conversation: ph.conversation, message: { id: "m1", photo: 1, of: 1 }, link: ph.conversation.kind === "assistant" ? "#assistant" : `#chat/${ph.conversation.id.slice(5)}`,
  image: { type: "image/jpeg", width: 64, height: 48, bytes: 2048 }, ai: { observations: 0, corrections: 0 },
});

export type ShellOpts = { exchanges?: number; pending?: boolean; notes?: number; card?: boolean; html?: string; longNotes?: boolean; sidebar?: "ok" | "vault-down" | 500; planNotes?: ReadonlyMap<string, string> };

export function shellServer(opts: ShellOpts = {}) {
  let o: ShellOpts = { exchanges: 2, pending: false, notes: 3, card: false, sidebar: "ok", ...opts };
  const sidebarReads: string[] = [];
  const base = Date.parse("2026-11-18T05:00:00Z");
  const at = (n: number) => new Date(base + n * 60_000).toISOString();
  // The synthetic vault, with any extra Plan notes a test adds.
  const vaultNotes = () => (o.planNotes ? new Map([...SIDEBAR_NOTES, ...o.planNotes]) : SIDEBAR_NOTES);
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
  // longNotes: every third note has a long first line and a long body with an unbroken URL, for wrapping checks.
  const LONG = " The summary says what changed, why, and how it was tested; it also lists what could not be checked here. ".repeat(3);
  const notes = () => Array.from({ length: o.notes ?? 0 }, (_, i) => ({ id: `n${i}`, at: at(i), text: o.longNotes && i % 3 === 0
    ? `Synthetic notification ${i + 1}: job orbit-2026111800${i}0-abcd finished after a long run with several check-ins and one steer answered.\n${LONG}\nhttps://github.com/example/very-long-repository-name/pull/12345/files#diff-0123456789abcdef0123456789abcdef`
    : `Synthetic notification ${i + 1}: job orbit-2026111800${i}0-abcd finished.\nIt pushed a branch and wrote a summary.` }));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const drain = () => new Promise<void>((r) => { req.on("data", () => {}); req.on("end", () => r()); });
    const p = url.pathname;
    if (p === "/" || p === "/sessions" || p.startsWith("/sessions/") || p === "/chat") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page()); }
    if (p === "/avatar.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(avatar); }
    if (p === "/gallery.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(readFileSync(new URL("../../src/web/gallery.js", import.meta.url))); }
    if (serveWebAsset(p, res)) return;
    if (p === "/photos.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(readFileSync(new URL("../../src/web/photos.js", import.meta.url))); }
    if (p === "/files.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(readFileSync(new URL("../../src/web/files.js", import.meta.url))); }
    if (p === "/status") return json(200, { ports: [{ port: "model", state: "live" }, { port: "vault", state: "live" }, { port: "jobs", state: "degraded" }], deploy: { at: at(0), commit: "0123456789abcdef0123456789abcdef01234567" } });
    if (p === "/notifications") return json(200, { inbox: notes() });
    if (p.startsWith("/notifications/")) { await drain(); return json(200, { ok: true }); }
    if (p === "/sidebar") {
      sidebarReads.push(url.search);
      if (typeof o.sidebar === "number") return json(o.sidebar, { error: "synthetic failure" });
      const down = o.sidebar === "vault-down";
      const vault = vaultNotes();
      return json(200, { ...sidebarView(down ? undefined : vault, sidebarPhotos(at), url.searchParams.get("project") || undefined), overview: planOverview(down ? undefined : vault, PLAN_NOW), vault: down ? { ok: false, error: "The vault could not be read: synthetic outage" } : { ok: true, source: "memory/vault@fixture" } });
    }
    if (p === "/sidebar/project") {
      if (o.sidebar === "vault-down") return json(503, { error: "The vault could not be read: synthetic outage" });
      const d = projectDetail(vaultNotes(), url.searchParams.get("id") ?? "", PLAN_NOW);
      return d ? json(200, { project: d, today: dayIn(PLAN_NOW) }) : json(404, { error: "No such project in the vault (Projects/)." });
    }
    if (p === "/gallery/photos") { const ps = sidebarPhotos(at).map(galleryPhoto); return json(200, { total: ps.length, returned: ps.length, nextCursor: null, zone: "UTC", photos: ps }); }
    if (p.startsWith("/gallery/photos/")) { const ph = sidebarPhotos(at).find((x) => x.ref === p.slice(16)); return ph ? json(200, { photo: galleryPhoto(ph), observations: [], corrections: [], labels: {} }) : json(404, { error: "No such photo is visible to the Assistant." }); }
    if (p === "/sidebar/note") { const n = sidebarNote(SIDEBAR_NOTES, url.searchParams.get("path") ?? ""); return n ? json(200, { note: n }) : json(404, { error: "No such note in the vault." }); }
    if (/^\/assistant\/photos\/ph_[0-9a-f]{32}$/.test(p)) { res.writeHead(200, { "content-type": "image/png" }); return res.end(avatar); }
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
    sidebarReads,
    async start() { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; },
    close() { server.close(); },
  };
}
