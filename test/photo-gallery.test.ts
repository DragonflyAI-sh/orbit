import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { photoGallery, snippetAround, termsIn } from "../src/photo-gallery.ts";
import { SIDEBAR_IMAGES_PAGE, sidebarView } from "../src/sidebar.ts";
import type { SidebarPhoto } from "../src/sidebar.ts";
import { galleryRig, galleryScene } from "./helpers/gallery-fixture.ts";
import { OWNER } from "./threads-fixture.ts";

// The photo gallery's data (src/photo-gallery.ts, docs/photo-gallery.md) through the REAL server, stores and photo tools: photos sent
// in the Assistant and in chat threads, observations saved by photos_observe and a correction relayed by photos_correct, both called
// by a scripted model through the real tool dispatch. Plus the sidebar's paged Images list and the page's pure helpers
// (src/web/gallery.js). Synthetic photos and text only.

/* eslint-disable @typescript-eslint/no-explicit-any */
const refsOf = (photos: any[]) => photos.map((p) => p.ref);

test("GET /gallery/photos: newest first, every photo exactly once across cursor pages, with day groups, sources and AI counts", async () => {
  const { g, refs, threads } = await galleryScene();
  const first = await g.api("/gallery/photos?limit=2");
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.total, 5);
  assert.equal(first.data.photos.length, 2);
  assert.equal(typeof first.data.nextCursor, "string");
  const seen = [...refsOf(first.data.photos)];
  let cursor = first.data.nextCursor;
  while (cursor) {
    const next = await g.api(`/gallery/photos?limit=2&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(next.status, 200);
    seen.push(...refsOf(next.data.photos));
    cursor = next.data.nextCursor;
  }
  // Newest first; the two garden photos of one message in the order they were sent.
  assert.deepEqual(seen, [refs.sky, refs.receipt, refs.desk, refs.garden[0], refs.garden[1]]);
  const all = (await g.api("/gallery/photos")).data.photos as any[];
  const desk = all.find((p) => p.ref === refs.desk);
  assert.deepEqual(desk.ai, { observations: 1, corrections: 1 });
  assert.equal(desk.src, `/assistant/photos/${refs.desk}`);
  assert.equal(desk.link, "#assistant");
  assert.equal(desk.caption, "My desk this morning");
  assert.match(desk.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(desk.month, desk.day.slice(0, 7));
  const garden = all.find((p) => p.ref === refs.garden[0]);
  assert.deepEqual(garden.ai, { observations: 1, corrections: 0 });
  assert.deepEqual(garden.conversation, { id: `chat:${threads.garden.id}`, kind: "chat", title: "Garden plans" });
  assert.deepEqual(garden.message.photo, 1);
  assert.equal(garden.link, `#chat/${threads.garden.id}`);
  assert.deepEqual(all.find((p) => p.ref === refs.garden[1]).ai, { observations: 0, corrections: 0 }, "only the photo that was observed");
  assert.deepEqual(new Set(all.map((p) => p.day)).size, 4, "four days");
  // Every image loads through the Assistant's display route.
  const img = await fetch(`${g.base}${desk.src}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  // Bad paging is refused, saying so.
  assert.equal((await g.api("/gallery/photos?cursor=nonsense")).status, 400);
  assert.equal((await g.api("/gallery/photos?limit=0")).status, 400);
  assert.equal((await g.api("/gallery/photos?limit=61")).status, 400);
});

test("GET /gallery/search: photos_search's corpus and rule; every result says which words matched which stored text", async () => {
  const { g, refs, threads } = await galleryScene();
  const ask = async (q: string) => {
    const res = await g.api(`/gallery/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data;
  };
  // A saved AI observation.
  const water = await ask("watering");
  assert.deepEqual(water.matches.map((m: any) => m.photo.ref), [refs.garden[0]]);
  assert.deepEqual(water.matches[0].hits.map((h: any) => [h.kind, h.terms]), [["visual-observation", ["watering"]]]);
  assert.match(water.matches[0].hits[0].snippet, /blue watering can/);
  assert.equal(water.mode, "keyword");
  assert.match(water.caveat, /not that the photo shows them/);
  // Words from different stored texts of one photo: the conversation title and an observation.
  const both = await ask("garden lettuce");
  assert.deepEqual(both.matches.map((m: any) => m.photo.ref), [refs.garden[0]], "the second garden photo has no lettuce");
  assert.deepEqual(both.matches[0].hits.map((h: any) => [h.kind, h.terms]).sort(), [["conversation-title", ["garden"]], ["visual-observation", ["lettuce"]]]);
  // A caption, and the conversation title alone.
  assert.deepEqual((await ask("hardware")).matches.map((m: any) => [m.photo.ref, m.hits[0].kind]), [[refs.receipt, "caption"]]);
  assert.deepEqual((await ask("garden")).matches.map((m: any) => m.photo.ref), [refs.garden[0], refs.garden[1]]);
  // Rai's correction matches; the observation it superseded does not (photos_search reads only active records).
  const green = await ask("green mug");
  assert.deepEqual(green.matches.map((m: any) => m.photo.ref), [refs.desk]);
  assert.ok(green.matches[0].hits.some((h: any) => h.kind === "user-correction" && h.terms.includes("green")));
  assert.equal((await ask("laptop")).total, 0, "a superseded observation is not searched");
  assert.equal((await ask("bookshelves")).total, 0);
  // A word only in Rai's next message after the photo matches, marked as context only.
  assert.equal((await g.api(`/threads/${threads.receipt.id}/messages`, "POST", { text: "That was for the shelf brackets" })).status, 200);
  const ctx = await ask("brackets");
  assert.deepEqual(ctx.matches.map((m: any) => [m.photo.ref, m.contextOnly, m.hits[0].kind]), [[refs.receipt, true, "discussion-context"]]);
  // Nothing matched is said plainly; bad queries are refused.
  const none = await ask("zebra");
  assert.deepEqual([none.total, none.matches.length], [0, 0]);
  for (const q of ["", "a", "x".repeat(201), "one two three four five six seven eight nine"]) assert.equal((await g.api(`/gallery/search?q=${encodeURIComponent(q)}`)).status, 400, q);
});

test("GET /gallery/photos/<ref>: the observations with what was observed, limitations, time and context; Rai's correction with the original it replaced", async () => {
  const { g, refs, threads } = await galleryScene();
  const garden = await g.api(`/gallery/photos/${refs.garden[0]}`);
  assert.equal(garden.status, 200);
  assert.equal(garden.data.photo.ref, refs.garden[0]);
  assert.equal(garden.data.observations.length, 1);
  const o = garden.data.observations[0];
  assert.deepEqual(o.observations, ["Two wooden raised beds with young lettuce", "A blue watering can on the path"]);
  assert.deepEqual(o.limitations, ["The far corner is out of focus"]);
  assert.equal(o.scope, "what is growing in the beds");
  assert.equal(o.state, "active");
  assert.equal(o.inspection.via, "message");
  assert.match(o.atLocal, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /);
  assert.deepEqual(o.source.conversation, { id: `chat:${threads.garden.id}`, kind: "chat", title: "Garden plans" });
  assert.equal(o.source.link, `#chat/${threads.garden.id}`);
  assert.match(o.label, /not a verified fact/);
  assert.deepEqual(garden.data.corrections, []);

  const desk = await g.api(`/gallery/photos/${refs.desk}`);
  const [fix] = desk.data.corrections;
  const [orig] = desk.data.observations;
  assert.equal(fix.correction, "The mug is green, not white");
  assert.match(fix.label, /Rai's statement/);
  assert.deepEqual(fix.supersedes, [orig.id]);
  assert.equal(orig.state, "superseded");
  assert.equal(orig.supersededBy, fix.id);
  assert.deepEqual(orig.observations, ["A white mug beside a laptop", "Bookshelves behind the desk"]);
  // No records: an empty list, not an invented one.
  const sky = await g.api(`/gallery/photos/${refs.sky}`);
  assert.deepEqual([sky.data.observations, sky.data.corrections, sky.data.photo.caption], [[], [], ""]);
  // Unknown, malformed or forged refs are simply not found.
  for (const bad of ["ph_" + "0".repeat(32), "nope", "a" + refs.sky.slice(1)]) assert.equal((await g.api(`/gallery/photos/${bad}`)).status, 404, bad);
});

test("the gallery routes are owner only, GET only, audited, and read nothing for anyone else", async () => {
  const { g, refs } = await galleryScene();
  for (const path of ["/gallery/photos", "/gallery/search?q=garden", `/gallery/photos/${refs.desk}`]) assert.equal((await g.api(path, "POST", {})).status, 405, path);
  g.caller.who = "someone@example.com";
  for (const path of ["/gallery/photos", "/gallery/search?q=garden", `/gallery/photos/${refs.desk}`]) {
    const res = await g.api(path);
    assert.equal(res.status, 403, path);
    assert.doesNotMatch(JSON.stringify(res.data), /garden|desk|mug|ph_/i, path);
  }
  g.caller.who = OWNER;
  assert.equal((await g.api("/gallery/photos")).status, 200);
});

test("the gallery routes, search included, refuse cross-site reads as the other photo routes do", async () => {
  const { g, refs } = await galleryScene();
  for (const path of ["/gallery/photos", "/gallery/search?q=garden", `/gallery/photos/${refs.desk}`]) {
    for (const site of ["cross-site", "same-site"]) {
      const res = await g.api(path, "GET", undefined, { "sec-fetch-site": site });
      assert.equal(res.status, 403, `${path} from ${site}`);
      assert.match(res.data.error, /Cross-site requests are refused/);
      assert.doesNotMatch(JSON.stringify(res.data), /garden|desk|mug|ph_/i, path);
    }
    for (const site of ["same-origin", "none"]) assert.equal((await g.api(path, "GET", undefined, { "sec-fetch-site": site })).status, 200, `${path} from ${site}`);
  }
  assert.equal((await g.api("/gallery/search?q=garden")).status, 200, "a request without the header (not a browser) is unaffected");
});

test("GET /sidebar: the Images section is paged and each photo says how many AI observations are saved", async () => {
  const g = await galleryRig();
  // 12 photos: one observed, sent in two messages.
  const a = await g.send({ caption: "Batch one", count: 10, observe: { observations: ["A red bicycle by a fence"] } });
  g.advance(2);
  const b = await g.send({ caption: "Batch two", count: 2 });
  const p1 = await g.api("/sidebar");
  assert.equal(p1.status, 200);
  assert.deepEqual([p1.data.images.page, p1.data.images.pages, p1.data.images.total, p1.data.images.perPage, p1.data.images.items.length, p1.data.images.more], [1, 2, 12, SIDEBAR_IMAGES_PAGE, 10, 2]);
  assert.deepEqual(p1.data.images.items.slice(0, 2).map((i: any) => i.ref), b.refs, "newest first");
  const p2 = await g.api("/sidebar?images=2");
  assert.deepEqual([p2.data.images.page, p2.data.images.items.length, p2.data.images.more], [2, 2, 0]);
  const observed = [...p1.data.images.items, ...p2.data.images.items].find((i: any) => i.ref === a.refs[0]);
  assert.deepEqual(observed.ai, { observations: 1, corrections: 0 });
  assert.deepEqual(p1.data.images.items[0].ai, { observations: 0, corrections: 0 });
  // A page past the end shows the last page; a nonsense page the first.
  assert.equal((await g.api("/sidebar?images=99")).data.images.page, 2);
  assert.equal((await g.api("/sidebar?images=x")).data.images.page, 1);
});

test("sidebarView pages the matching photos and counts AI observations only for the page shown", () => {
  const ph = (n: number): SidebarPhoto => ({ ref: `ph_${n.toString(16).padStart(32, "0")}`, sentAt: new Date(Date.UTC(2026, 10, 1) + n * 3_600_000).toISOString(), sentLocal: "x", caption: `photo ${n}`, conversation: { id: "assistant:assistant", kind: "assistant", title: "Assistant" }, present: true });
  const photos = Array.from({ length: 23 }, (_, i) => ph(i + 1));
  const asked: string[] = [];
  const v = sidebarView(undefined, photos, undefined, { imagesPage: 3, aiOf: (ref) => (asked.push(ref), { observations: 2, corrections: 0 }) });
  assert.deepEqual([v.images.page, v.images.pages, v.images.total, v.images.items.length, v.images.more], [3, 3, 23, 3, 0]);
  assert.deepEqual(v.images.items.map((i) => i.caption), ["photo 3", "photo 2", "photo 1"]);
  assert.equal(asked.length, 3, "counted for the page only");
  assert.deepEqual(v.images.items[0]!.ai, { observations: 2, corrections: 0 });
  const plain = sidebarView(undefined, photos, undefined);
  assert.equal(plain.images.page, 1);
  assert.equal(plain.images.items[0]!.ai, undefined, "no count without a counter");
  assert.equal(plain.images.more, 13);
});

test("match snippets: the words found, case and accents ignored, and a window around the first one", () => {
  assert.deepEqual(termsIn("A Café by the GARDEN wall", ["cafe", "garden", "roof"]), ["cafe", "garden"]);
  const long = `${"filler words ".repeat(30)}the bookshelves are tall ${"more words ".repeat(30)}`;
  const s = snippetAround(long, ["bookshelves"]);
  assert.ok(s.length <= 160, String(s.length));
  assert.match(s, /bookshelves/);
  assert.match(s, /^…/);
  assert.equal(snippetAround("short text", ["short"]), "short text");
  assert.equal(typeof photoGallery, "function");
});

// ---- the page's pure helpers (src/web/gallery.js) ------------------------------------------------------------------------
const lib = (() => {
  const sandbox: any = { localStorage: undefined };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(new URL("../src/web/gallery.js", import.meta.url), "utf8"), sandbox);
  // Values from the sandbox's realm, compared as plain data.
  const plain = (f: (...a: any[]) => any) => (...a: any[]) => JSON.parse(JSON.stringify(f(...a)) ?? "null");
  const g = sandbox.OrbitGallery;
  return { matchNotes: plain(g.matchNotes), groupPhotos: plain(g.groupPhotos), groupLabel: g.groupLabel, safePhoto: plain(g.safePhoto) };
})();

test("page: match notes say what matched and how; grouping by day or month keeps the order; unsafe values are dropped", () => {
  const notes = lib.matchNotes({ hits: [
    { kind: "caption", terms: ["garden"] },
    { kind: "visual-observation", terms: ["bookshelves", "tall"] },
    { kind: "user-correction", terms: ["green"] },
    { kind: "discussion-context", terms: ["brackets"] },
    { kind: "conversation-title", terms: [], similarity: 0.6234 },
    { kind: "caption", terms: ["garden"] },
  ] });
  assert.deepEqual(notes, [
    "matched caption: 'garden'",
    "matched AI observation: 'bookshelves', 'tall'",
    "matched Rai's correction: 'green'",
    "matched Rai's next message: 'brackets'",
    "similar in meaning to conversation title (0.62)",
  ]);
  assert.deepEqual(lib.matchNotes(null), []);
  const p = (ref: string, day: string) => ({ ref, day, month: day.slice(0, 7) });
  const items = [p("a", "2026-11-26"), p("b", "2026-11-26"), p("c", "2026-11-02"), p("d", "2026-10-30")];
  assert.deepEqual(lib.groupPhotos(items, "day").map((g: any) => [g.key, g.items.map((i: any) => i.ref).join("")]), [["2026-11-26", "ab"], ["2026-11-02", "c"], ["2026-10-30", "d"]]);
  assert.deepEqual(lib.groupPhotos(items, "month").map((g: any) => [g.key, g.items.length]), [["2026-11", 3], ["2026-10", 1]]);
  assert.match(lib.groupLabel("2026-11-26"), /2026/);
  assert.equal(lib.groupLabel("garbage"), "Unknown date");
  // A forged ref, a link that is not a conversation, or odd types never reach the page.
  assert.equal(lib.safePhoto({ ref: "../../etc/passwd" }), null);
  const safe = lib.safePhoto({ ref: "ph_" + "a".repeat(32), status: "ok", link: "javascript:alert(1)", caption: 7, day: "x", ai: { observations: "9" }, conversation: { kind: "evil", title: "T" } });
  assert.deepEqual([safe.link, safe.caption, safe.day, safe.ai.observations, safe.conversation.kind], ["", "", "", 0, "assistant"]);
  assert.equal(lib.safePhoto({ ref: "ph_" + "a".repeat(32), link: "#chat/11111111-1111-4111-8111-111111111111" }).link, "#chat/11111111-1111-4111-8111-111111111111");
});
