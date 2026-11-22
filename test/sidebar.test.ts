import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentStore } from "../src/attachments.ts";
import { frontmatter, planOf, projectsOf, sidebarNote, SIDEBAR_NOTE_MAX, sidebarView } from "../src/sidebar.ts";
import type { SidebarPhoto } from "../src/sidebar.ts";
import { smallJpeg } from "./jpeg-fixture.ts";
import { OWNER, rig, say, scripted } from "./threads-fixture.ts";

// The left sidebar's data (src/sidebar.ts, docs/sidebar.md): which projects are active, what the plan and the related files of
// a project are, which photos name it, and the owner-only GET /sidebar and /sidebar/note routes over a real vault copy and the
// real attachment store. Synthetic notes only.

/* eslint-disable @typescript-eslint/no-explicit-any */
const notes = (o: Record<string, string>) => new Map(Object.entries(o));
// A secret-shaped value built at run time (never a literal in the repository): a password assignment the vault filter masks.
const fakeSecret = () => `${"pass" + "word"}: Q7${"x9K2m".repeat(6)}z9`;

const VAULT = {
  "now.md": "# Now\n\n## Top priorities\n- [ ] Finish the sidebar\n- [x] Old thing\n\n## Notes\n- not a plan item\n",
  "Projects/alpha-garden.md": "---\nstatus: active\naliases:\n  - Alpha Garden\n  - The Allotment\ntags: [project]\n---\n# Alpha\n\n## Next actions\n- [ ] Order seeds\n- [x] Measure beds\n- [-] Dropped idea\n1. Draw the plan with [[watering|the watering note]]\n\n```\n## Plan\n- not a heading inside code\n```\n\n## Resume here\nStart at the trellis.\n\n## Locations\n- ~/projects/alpha\n- [repo](https://example.com/alpha)\n",
  "Projects/beta.md": "---\nstatus: paused\n---\n# Beta Desk\n\n## Plan\n- Sand it\n",
  "Projects/zeta.md": "No front matter, no heading.\n",
  "Projects/old.md": "---\nstatus: done\n---\n# Old\n",
  "Projects/archive/inner.md": "---\nstatus: active\n---\n# Not a hub note\n",
  "Tasks/seeds.md": "---\nstatus: todo\nproject: \"[[alpha-garden]]\"\ndue: 2026-12-01\n---\n# Buy seeds\n",
  "Tasks/soil.md": "---\nstatus: waiting\nproject: Projects/alpha-garden\n---\n# Test the soil\n",
  "Tasks/label.md": "---\nstatus: todo\nproject: \"[[alpha-garden|Alpha]]\"\n---\n# Label rows\n",
  "Tasks/done.md": "---\nstatus: done\nproject: \"[[alpha-garden]]\"\n---\n# Finished task\n",
  "Tasks/other.md": "---\nstatus: todo\nproject: \"[[alpha-gardening]]\"\n---\n# Someone else's\n",
  "Resources/soil.md": "# Soil\nSee [[alpha-garden]].\n",
  "Resources/unrelated.md": "# Unrelated\nalpha-garden is mentioned without a link.\n",
  "Log/2026/2026-11-20-orbit.md": "- touched [[alpha-garden]]\n",
};

test("front matter: scalars, inline lists and block lists; anything else is skipped", () => {
  const f = frontmatter("---\nstatus: active # a comment\naliases: [\"A, B\", 'C', [[d]]]\ntags:\n  - one\n  - two\nweird line\n---\n# Body\n");
  assert.deepEqual(f.data, { status: "active", aliases: ["A, B", "C", "[[d]]"], tags: ["one", "two"] });
  assert.equal(f.body, "# Body\n");
  assert.deepEqual(frontmatter("# No front matter\n").data, {});
  // Unquoted wiki links, as Obsidian writes them, are links (one, or a comma list), not a YAML list holding a list.
  const links = frontmatter("---\nproject: [[orbit]]\nprojects: [[a]], [[b|B]]\nlabel: [[x|y]] # a comment\n---\n");
  assert.deepEqual(links.data, { project: "[[orbit]]", projects: ["[[a]]", "[[b|B]]"], label: "[[x|y]]" });
});

test("a task whose project is an unquoted wiki link is that project's task", () => {
  const vault = { ...VAULT, "Tasks/water.md": "---\nstatus: todo\nproject: [[alpha-garden]]\n---\n# Water the beds\n", "Tasks/pots.md": "---\nstatus: todo\nprojects: [[beta]], [[alpha-garden|Alpha]]\n---\n# Buy pots\n" };
  const v = sidebarView(notes(vault), [], "alpha-garden");
  const titles = v.plan.tasks.map((t) => t.title);
  assert.ok(titles.includes("Water the beds"), titles.join(", "));
  assert.ok(titles.includes("Buy pots"), titles.join(", "));
});

test("projects: the active hub notes under Projects/, active first, titled from aliases, heading or file name", () => {
  const p = projectsOf(notes(VAULT));
  assert.deepEqual(p.map((x) => [x.id, x.title, x.status]), [["alpha-garden", "Alpha Garden", "active"], ["zeta", "zeta", ""], ["beta", "Beta Desk", "paused"]]);
  assert.equal(p[0]!.path, "Projects/alpha-garden.md");
});

test("plan: open items under plan headings; done and dropped items, code blocks and other sections are left out; a resume paragraph counts", () => {
  assert.deepEqual(planOf(VAULT["Projects/alpha-garden.md"]), [
    { text: "Order seeds", section: "Next actions" },
    { text: "Draw the plan with the watering note", section: "Next actions" },
    { text: "Start at the trellis.", section: "Resume here" },
  ]);
  assert.deepEqual(planOf(VAULT["now.md"]).map((i) => i.text), ["Finish the sidebar"]);
});

test("a project's view: plan and open tasks linked to it, its related notes (the activity log aside), its locations", () => {
  const v = sidebarView(notes(VAULT), [], "alpha-garden");
  assert.equal(v.project?.id, "alpha-garden");
  assert.equal(v.plan.source, "Projects/alpha-garden.md");
  // Tasks link by [[id]], [[id|label]] or Projects/id; a closed task is not part of the plan; a similar id is not the project.
  assert.deepEqual(v.plan.tasks.map((t) => [t.title, t.status, t.due ?? ""]), [["Buy seeds", "todo", "2026-12-01"], ["Label rows", "todo", ""], ["Test the soil", "waiting", ""]]);
  assert.deepEqual(v.files.items.map((f) => [f.path, f.kind]), [
    ["Projects/alpha-garden.md", "project"],
    ["Tasks/seeds.md", "task"], ["Tasks/done.md", "task"], ["Tasks/label.md", "task"], ["Tasks/soil.md", "task"],
    ["Resources/soil.md", "note"],
  ]);
  assert.deepEqual(v.files.locations, ["~/projects/alpha", "repo"]);
  assert.equal(v.unknownProject, undefined);
});

test("without a project: the plan from now.md, every open task, and now.md with the project hub notes as files", () => {
  const v = sidebarView(notes(VAULT), [], undefined);
  assert.equal(v.project, null);
  assert.equal(v.plan.source, "now.md");
  assert.deepEqual(v.plan.tasks.map((t) => t.title), ["Buy seeds", "Label rows", "Someone else's", "Test the soil"], "every open task (due first), the closed one aside");
  assert.deepEqual(v.files.items.map((f) => f.path), ["now.md", "Projects/alpha-garden.md", "Projects/zeta.md", "Projects/beta.md"]);
  // A project that is not active (or does not exist) is reported, and everything is shown.
  const old = sidebarView(notes(VAULT), [], "old");
  assert.equal(old.project, null);
  assert.equal(old.unknownProject, "old");
  // No vault at all: empty lists, never invented ones.
  const none = sidebarView(undefined, [], "alpha-garden");
  assert.deepEqual([none.projects, none.plan.items, none.plan.tasks, none.files.items], [[], [], [], []]);
  // An unreadable vault says nothing about the requested project: it is not reported unknown, so the page keeps it.
  assert.equal(none.unknownProject, undefined);
});

test("photos: newest first; with a project, only those whose caption or conversation title names it as a whole phrase", () => {
  const ph = (n: number, caption: string, title = "Assistant"): SidebarPhoto => ({ ref: `ph_${String(n).repeat(32)}`, sentAt: `2026-11-2${n}T00:00:00Z`, sentLocal: `Nov 2${n}`, caption, conversation: { id: title === "Assistant" ? "assistant:assistant" : "chat:11111111-1111-4111-8111-111111111111", kind: title === "Assistant" ? "assistant" : "chat", title }, present: true });
  const photos = [ph(1, "Alpha garden beds"), ph(2, "the allotment at dusk"), ph(3, "", "Alpha-Garden planning"), ph(4, "alphagardens are not this"), ph(5, "unrelated"), { ...ph(6, "alpha garden, file gone"), present: false }];
  const all = sidebarView(notes(VAULT), photos, undefined);
  assert.deepEqual(all.images.items.map((i) => i.caption), ["unrelated", "alphagardens are not this", "", "the allotment at dusk", "Alpha garden beds"]);
  assert.equal(all.images.matched, "all");
  const scoped = sidebarView(notes(VAULT), photos, "alpha-garden");
  assert.deepEqual(scoped.images.items.map((i) => i.caption), ["", "the allotment at dusk", "Alpha garden beds"], "by id, alias and conversation title");
  assert.equal(scoped.images.matched, "project");
  assert.equal(scoped.images.items[0]!.src, `/assistant/photos/${"3".repeat(32).replace(/^/, "ph_")}`);
  assert.equal(scoped.images.items[0]!.link, "#chat/11111111-1111-4111-8111-111111111111");
  assert.equal(scoped.images.items[1]!.link, "#assistant");
});

test("text for the page is masked, flattened and bounded; a note preview is only a note in the snapshot", () => {
  const secret = fakeSecret();
  const v = sidebarView(notes({ "Projects/p.md": `# P\n\n## Next actions\n- rotate it: ${secret}\n- ${"long ".repeat(100)}‮\n` }), [], "p");
  assert.doesNotMatch(JSON.stringify(v), new RegExp(secret.slice(-20)), "no secret-shaped value reaches the page");
  assert.match(v.plan.items[0]!.text, /\[redacted\]/);
  assert.ok(v.plan.items[1]!.text.length <= 240 && !v.plan.items[1]!.text.includes("‮"));
  const n = notes({ "Projects/p.md": `secret ${secret}\n`, "Resources/big.md": "x".repeat(SIDEBAR_NOTE_MAX + 10) });
  assert.match(sidebarNote(n, "Projects/p.md")!.text, /\[redacted\]/);
  assert.equal(sidebarNote(n, "Resources/big.md")!.truncated, true);
  assert.equal(sidebarNote(n, "Resources/big.md")!.text.length, SIDEBAR_NOTE_MAX);
  for (const bad of ["../etc/passwd", "Projects/missing.md", "Projects/p.txt", "", "/Projects/p.md"]) assert.equal(sidebarNote(n, bad), undefined, bad);
});

// ---- the routes, on the real server --------------------------------------------------------------------------------------

const vision = () => Object.assign(scripted([say("seen"), say("seen")]), { images: () => ({ ok: true, detail: "test model takes photos" }) });

test("GET /sidebar: owner only; projects, plan and files from the vault; photos the Assistant may show, fetched through its own route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-sidebar-"));
  const r = rig({ dir, model: vision(), vault: VAULT, extra: () => ({ assistantDir: join(dir, "assistant"), attachments: attachmentStore(join(dir, "attachments")) }) });
  const base = async () => (await r.api("/status"), `http://127.0.0.1:${(r.server.address() as any).port}`);
  // Two photos sent in the Assistant, one naming the project.
  for (const [i, text] of ["The alpha garden beds", "A receipt"].entries()) {
    const up = await fetch(`${await base()}/assistant/attachments`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(smallJpeg(i, 40, 30)) });
    assert.equal(up.status, 201);
    const id = ((await up.json()) as any).attachment.id;
    assert.equal((await r.api("/assistant/messages", "POST", { text, attachments: [id] })).status, 200);
  }
  // Listing the photos is attachment and session reading: both decisions are audited, like the Assistant's photo tools.
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  let all: Awaited<ReturnType<typeof r.api>>;
  try { all = await r.api("/sidebar"); } finally { console.log = log; }
  const audits = logged.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((e) => e && e.action === "read");
  assert.ok(audits.some((e) => e.port === "attachments" && e.allow === true), JSON.stringify(audits));
  assert.ok(audits.some((e) => e.port === "sessions" && e.allow === true), JSON.stringify(audits));
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.equal(all.data.vault.ok, true);
  assert.match(all.data.vault.source, /^memory\/vault@/);
  assert.deepEqual(all.data.projects.map((p: any) => p.id), ["alpha-garden", "zeta", "beta"]);
  assert.equal(all.data.plan.source, "now.md");
  assert.equal(all.data.images.items.length, 2);
  const one = await r.api("/sidebar?project=alpha-garden");
  assert.equal(one.data.project.id, "alpha-garden");
  assert.deepEqual(one.data.plan.items.map((i: any) => i.text), ["Order seeds", "Draw the plan with the watering note", "Start at the trellis."]);
  assert.deepEqual(one.data.images.items.map((i: any) => i.caption), ["The alpha garden beds"]);
  const img = await fetch(`${await base()}${one.data.images.items[0].src}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  // The note preview.
  const note = await r.api("/sidebar/note?path=Resources/soil.md");
  assert.equal(note.status, 200);
  assert.equal(note.data.note.text, VAULT["Resources/soil.md"]);
  assert.equal((await r.api("/sidebar/note?path=../../etc/passwd")).status, 404);
  assert.equal((await r.api("/sidebar/note?path=Projects/nope.md")).status, 404);
  assert.equal((await r.api("/sidebar", "POST", {})).status, 405);
  // Nobody but the owner.
  r.caller.who = "someone@example.com";
  for (const path of ["/sidebar", "/sidebar?project=alpha-garden", "/sidebar/note?path=now.md"]) {
    const res = await r.api(path);
    assert.equal(res.status, 403, path);
    assert.doesNotMatch(JSON.stringify(res.data), /alpha|Order seeds|Top priorities/i, `${path}: nothing of the vault`);
  }
  r.caller.who = OWNER;
});

test("GET /sidebar: a vault that cannot be read is reported, with the photos still listed", async () => {
  const r = rig({ extra: () => ({ memory: { name: "memory", status: () => ({ port: "memory", state: "down", impl: "none", detail: "x", verifiedAt: "" }), search: () => { throw new Error("no"); }, read: () => { throw new Error("no"); } } }) });
  const res = await r.api("/sidebar");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.vault, { ok: false, error: "The vault could not be read: this vault copy cannot list its notes" });
  assert.deepEqual(res.data.projects, []);
  assert.deepEqual(res.data.images.items, []);
  assert.equal((await r.api("/sidebar/note?path=now.md")).status, 503);
  // A remembered project is not called unknown when the vault could not be read.
  const asked = await r.api("/sidebar?project=alpha-garden");
  assert.equal(asked.status, 200);
  assert.equal(asked.data.vault.ok, false);
  assert.equal(asked.data.unknownProject, undefined);
});

// ---- the page's remembered layout (<sidebar-lib> in src/web/index.html) -------------------------------------------------

test("the sidebar's layout: open by default, width bounded by the window, only known sections, a plain project id; storage failures are harmless", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const block = html.match(/\/\/ <sidebar-lib>([\s\S]*?)\/\/ <\/sidebar-lib>/)![1]!;
  type Prefs = { open: boolean; width: number; closed: string[]; project: string };
  const lib = new Function(`${block}; return { readSidebar, writeSidebar, clampNavWidth, SIDEBAR_KEY };`)() as {
    readSidebar(s: unknown): Prefs; writeSidebar(s: unknown, p: Prefs): void; clampNavWidth(w: unknown, vw: number): number; SIDEBAR_KEY: string;
  };
  const mem = (init: Record<string, string> = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  assert.deepEqual(lib.readSidebar(null), { open: true, width: 280, closed: [], project: "" });
  for (const v of ["", "{", "null", "[]", "1", '{"open":"no","width":"wide","closed":"plan","project":"../x"}']) {
    assert.deepEqual(lib.readSidebar(mem({ [lib.SIDEBAR_KEY]: v })), { open: true, width: 280, closed: [], project: "" }, v);
  }
  const s = mem();
  lib.writeSidebar(s, { open: false, width: 333.4, closed: ["plan", "bogus", "images"], project: "alpha-garden" });
  assert.deepEqual(lib.readSidebar(s), { open: false, width: 333, closed: ["plan", "images"], project: "alpha-garden" });
  for (const bad of ["a/b", ".hidden", " lead", "x".repeat(121)]) {
    lib.writeSidebar(s, { open: true, width: 280, closed: [], project: bad });
    assert.equal(lib.readSidebar(s).project, "", bad);
  }
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(lib.readSidebar(throwing), { open: true, width: 280, closed: [], project: "" });
  assert.doesNotThrow(() => lib.writeSidebar(throwing, { open: true, width: 280, closed: [], project: "" }));
  assert.equal(lib.clampNavWidth(100, 1280), 220);
  assert.equal(lib.clampNavWidth(900, 1280), 480);
  assert.equal(lib.clampNavWidth(460, 900), 450, "never more than half the window");
  assert.equal(lib.clampNavWidth(Number.NaN, 1280), 280);
  assert.equal(lib.clampNavWidth(300, 300), 220, "the minimum wins on a tiny window");
});
