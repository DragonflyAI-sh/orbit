import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { brief, datedEntry, dayIn, humanize, planOverview, projectDetail, sortCards, STALE_DAYS } from "../src/plan.ts";
import type { ProjectCard } from "../src/plan.ts";
import { OWNER, rig } from "./threads-fixture.ts";

// The Plan views' data (src/plan.ts, docs/plan.md): every project hub note read as a card (priority, status, health, one-line
// summary, next action, relative dates) and one project's detail (timeline, progress, blockers, next steps, recent activity,
// linked tasks, notes); GET /sidebar's overview and GET /sidebar/project on the real server; and the page's pure helpers
// (<plan-lib> in src/web/index.html). Synthetic notes only.

/* eslint-disable @typescript-eslint/no-explicit-any */
const notes = (o: Record<string, string>) => new Map(Object.entries(o));
// Thu 2026-11-26, 12:00 in Los Angeles.
const NOW = new Date("2026-11-26T20:00:00Z");
// A message id as the vault's agents cite them, built at run time.
const MSG = `#orbit${"1".repeat(4)}${"0".repeat(14)}7`;
const fakeSecret = () => `${"pass" + "word"}: Q7${"x9K2m".repeat(6)}z9`;

const VAULT = {
  "Projects/fifty.md": [
    "---", "type: project", "aliases:", '  - "Fifty Outings"', "status: active", "priority: 2", 'area: "personal"', "target: 2027-10-07", "started: 2026-10-07", "updated: 2026-11-14", "---",
    "## Outcome", "A year of fifty small outings with the family. Each one is planned, lived and recorded here.", "",
    "## Completion requirement", "Every outing needs a photo.", "",
    "## Resume here",
    `2026-11-14 PST: **#45 Thrift dig DONE**, chosen by Rai with six photos (${MSG}).`, "",
    `2026-11-07 22:52 UTC: Rai asks to mark #46 complete. Sources ${MSG.slice(1)}, ${MSG.slice(1)}.`, "",
    "2026-10-26 05:13 UTC / 2026-10-25 22:13 PDT: Rai picks #39 for the street fair (received 2026-10-26T05:13:00Z).", "",
    "2030-01-01: A future line is never activity.", "",
    "## Tracker", "| # | Outing | Status | Date |", "| --- | --- | --- | --- |",
    "| 1 | River ride | done (confirmed) | 2026-10-18 |", "| 2 | Star watch | idea | — |", "| 3 | Brewery hunt | scheduled | 2026-12-05 |", "| 4 | Ferry trip | done | 2026-10-25 |", "",
    "## Notes", "- Keep the cards in the kitchen drawer.", "",
  ].join("\n"),
  "Projects/roof.md": "---\nstatus: active\npriority: P1\ntarget: 2026-11-01\nupdated: 2026-11-25\n---\n# Roof\n\n## Outcome\nA dry roof.\n\n## Blockers\n- Waiting on the roofer's quote\n- none\n\n## Next steps\n- [ ] Call the roofer\n- [x] Get three names\n\n## Milestones\n- [x] 2026-10-01: Survey done\n- [ ] 2026-12-10 — Shingles delivered\n",
  "Projects/desk.md": "---\nstatus: paused\npriority: low\nupdated: 2026-09-02\n---\n# Desk\n\n## Plan\n- Sand the top\n",
  "Projects/quiet.md": "---\nstatus: active\nupdated: 2026-09-01\n---\n# Quiet\n\n## Next actions\n- Something\n",
  "Projects/shed.md": "---\nstatus: done\npriority: 1\nupdated: 2026-08-01\n---\n# Shed\n",
  "Projects/inner/nested.md": "---\nstatus: active\n---\n# Not a hub note\n",
  "Tasks/quote.md": "---\nstatus: waiting\nproject: \"[[roof]]\"\ndue: 2026-11-28\n---\n# Chase the quote\n",
  "Tasks/gutter.md": "---\nstatus: done\nproject: [[roof]]\n---\n# Clear the gutter\n",
  "Tasks/other.md": "---\nstatus: todo\nproject: \"[[roofing]]\"\n---\n# Someone else's\n",
};

test("dated entries: date, optional clock time and zone, an optional local restatement; prose that merely starts with a date is not one", () => {
  assert.deepEqual(datedEntry("2026-11-14 PST: Did it."), { date: "2026-11-14", at: null, text: "Did it." });
  // A UTC clock time is turned into Rai's day: 05:13 UTC on the 26th is the evening of the 25th in Los Angeles.
  assert.deepEqual(datedEntry("- 2026-10-26 05:13 UTC / 2026-10-25 22:13 PDT: Picked #39."), { date: "2026-10-25", at: "2026-10-26T05:13:00.000Z", text: "Picked #39." });
  assert.deepEqual(datedEntry("**2026-10-07:** Started."), { date: "2026-10-07", at: null, text: "Started." });
  assert.equal(datedEntry("2026-10-24 23:21UTC — Rai confirms.")?.text, "Rai confirms.");
  assert.equal(datedEntry("2026-11-07 21:33 UTC / November 6 PST: Photos.")?.date, "2026-11-07");
  assert.equal(datedEntry("2026-10-02 the beds were measured and found to be: fine"), null, "a long header is prose");
  assert.equal(datedEntry("2026-13-40: not a date"), null);
  assert.equal(datedEntry("No date: here"), null);
});

test("agent text reads for a person: message ids and source lists dropped, UTC times in Rai's zone, bounded at a word", () => {
  assert.equal(humanize(`Done with photos (${MSG}).`), "Done with photos.");
  assert.equal(humanize(`Marked done. Sources ${MSG.slice(1)}, ${MSG.slice(1)}.`), "Marked done.");
  assert.equal(humanize("Seen (received 2026-11-12T19:05:00Z / 11:05 PST)."), "Seen (received Nov 12, 11:05 AM).");
  assert.equal(humanize("Logged at 05:13 UTC.", "2026-10-26"), "Logged at 10:13 PM.");
  assert.equal(humanize("**Bold** and [[link|a link]]"), "Bold and a link");
  assert.equal(brief("One two three four five six", 15), "One two three…");
  assert.equal(brief("First sentence here. Second one is long", 30), "First sentence here.");
  assert.equal(brief("short", 30), "short");
  assert.equal(dayIn(new Date("2026-11-27T07:30:00Z")), "2026-11-26", "11:30 PM in Los Angeles is still the 26th");
});

test("overview: every hub note as a card, open before done, by priority then latest activity; stats count what needs attention", () => {
  const o = planOverview(notes(VAULT), NOW);
  assert.equal(o.today, "2026-11-26");
  assert.equal(o.zone, "America/Los_Angeles");
  assert.deepEqual(o.projects.map((c) => [c.id, c.priority, c.state, c.health]), [
    ["roof", 1, "active", "red"], ["fifty", 2, "active", "green"], ["desk", 3, "paused", "yellow"], ["quiet", null, "active", "yellow"], ["shed", 1, "done", "grey"],
  ]);
  assert.deepEqual(o.stats, { total: 5, active: 3, paused: 1, done: 1, overdue: 1, blocked: 1, attention: 3 });
  const fifty = o.projects.find((c) => c.id === "fifty")!;
  assert.equal(fifty.title, "Fifty Outings");
  assert.equal(fifty.summary, "A year of fifty small outings with the family.");
  assert.equal(fifty.next, "Brewery hunt (scheduled, 2026-12-05)", "a booked tracker row is the next step");
  assert.deepEqual(fifty.progress, { done: 2, total: 4, label: "outings done" });
  assert.equal(fifty.lastActivity, "2026-11-14", "the newest dated entry or updated:, never a future line");
  assert.deepEqual([fifty.started, fifty.target, fifty.area, fifty.overdue], ["2026-10-07", "2027-10-07", "personal", false]);
  const roof = o.projects[0]!;
  assert.deepEqual([roof.overdue, roof.blockers, roof.next, roof.why], [true, 2, "Call the roofer", "Past its target date (2026-11-01)"]);
  assert.deepEqual(roof.progress, { done: 1, total: 2, label: "tasks done" }, "from the linked tasks when the note has no tracker");
  const quiet = o.projects.find((c) => c.id === "quiet")!;
  assert.equal(quiet.stale, true);
  assert.equal(quiet.why, `No recorded activity for over ${STALE_DAYS} days`);
  assert.equal(o.projects.find((c) => c.id === "desk")!.priority, 3, "low is P3");
  // Nothing an agent wrote for itself reaches a card.
  assert.doesNotMatch(JSON.stringify(o), new RegExp(`#orbit|${MSG.slice(6)}|UTC`));
  // No vault: nothing invented.
  assert.deepEqual(planOverview(undefined, NOW).projects, []);
});

test("sorting: open before done, priority (unset last), newest activity, then title", () => {
  const c = (id: string, priority: number | null, lastActivity: string | null, state: ProjectCard["state"] = "active") => ({ id, title: id, priority, lastActivity, state }) as ProjectCard;
  assert.deepEqual(sortCards([c("z", null, "2026-11-25"), c("d", 1, "2026-11-25", "done"), c("b", 2, "2026-10-01"), c("a", 2, "2026-11-01"), c("p", 1, null)]).map((x) => x.id), ["p", "a", "b", "z", "d"]);
});

test("detail: timeline, blockers, next steps, recent activity in Rai's time, linked tasks and notes", () => {
  const roof = projectDetail(notes(VAULT), "roof", NOW)!;
  assert.deepEqual(roof.timeline.map((t) => [t.date, t.label, t.kind, t.done]), [
    ["2026-10-01", "Survey done", "milestone", true],
    ["2026-11-01", "Target", "target", false],
    ["2026-11-26", "Today", "today", false],
    ["2026-11-28", "Chase the quote", "due", false],
    ["2026-12-10", "Shingles delivered", "milestone", false],
  ]);
  assert.deepEqual(roof.blockerList, ["Waiting on the roofer's quote", "Waiting: Chase the quote"], "'none' is not a blocker; a waiting task is");
  assert.deepEqual(roof.nextSteps, ["Call the roofer", "Chase the quote (due 2026-11-28)"], "the checked step is done");
  assert.deepEqual(roof.tasks.map((t) => [t.title, t.status, t.done, t.due]), [["Chase the quote", "waiting", false, "2026-11-28"], ["Clear the gutter", "done", true, null]], "a similar id is not this project");

  const fifty = projectDetail(notes(VAULT), "fifty", NOW)!;
  assert.equal(fifty.completion, "Every outing needs a photo.");
  assert.deepEqual(fifty.activity.map((a) => [a.date, a.at, a.text]), [
    ["2026-11-14", null, "#45 Thrift dig DONE, chosen by Rai with six photos."],
    ["2026-11-07", "2026-11-07T22:52:00.000Z", "Rai asks to mark #46 complete."],
    ["2026-10-25", "2026-10-26T05:13:00.000Z", "Rai picks #39 for the street fair (received Oct 25, 10:13 PM)."],
  ]);
  assert.deepEqual(fifty.notes, ["Keep the cards in the kitchen drawer."]);
  assert.deepEqual(fifty.timeline.map((t) => t.kind), ["start", "today", "target"]);
  assert.equal(projectDetail(notes(VAULT), "nope", NOW), undefined);
  for (const bad of ["../now", "inner/nested", "", ".hidden"]) assert.equal(projectDetail(notes(VAULT), bad, NOW), undefined, bad);
});

// Names people give projects: every card the overview draws opens (a regression from the first Plan views, which turned
// these away as "No such project").
const ODD_NAMES = ["Café Rebuild, Q4 (plan)", "Mom's 70th", "  spaced  out ", "50% & more + [draft] #2", "Ünïcødé 漢字 ✓", ".dotted", "a".repeat(200)];

test("detail: any id the overview gives a card opens it (spaces, commas, brackets, apostrophes, accents); a '/' never does", () => {
  const v = notes(Object.fromEntries(ODD_NAMES.map((n) => [`Projects/${n}.md`, `---\nstatus: active\n---\n# ${n.trim() || "x"}\n\n## Next actions\n- Step one\n`])));
  const ids = planOverview(v, NOW).projects.map((c) => c.id);
  assert.deepEqual([...ids].sort(), [...ODD_NAMES].sort());
  for (const id of ids) {
    const d = projectDetail(v, id, NOW);
    assert.ok(d, `${JSON.stringify(id)} opens`);
    assert.equal(d.path, `Projects/${id}.md`);
    assert.deepEqual(d.nextSteps, ["Step one"]);
  }
  for (const bad of ["Café Rebuild, Q4 (plan)/x", "../Mom's 70th", "/", ""]) assert.equal(projectDetail(v, bad, NOW), undefined, bad);
  assert.equal(projectDetail(v, 42 as unknown as string, NOW), undefined);
});

test("plan text is masked, flattened and bounded", () => {
  const secret = fakeSecret();
  const v = notes({ "Projects/p.md": `---\nstatus: active\n---\n# P\n\n## Outcome\nKeep ${secret} safe.\n\n## Next actions\n- rotate it: ${secret}\n- ${"long ".repeat(100)}‮\n\n## Log\n- 2026-11-20: ${"word ".repeat(80)}\n` });
  const d = projectDetail(v, "p", NOW)!;
  assert.doesNotMatch(JSON.stringify(d), new RegExp(secret.slice(-20)), "no secret-shaped value reaches the page");
  assert.match(d.nextSteps[0]!, /\[redacted\]/);
  assert.ok(d.nextSteps[1]!.length <= 221 && !d.nextSteps[1]!.includes("‮"));
  assert.ok(d.activity[0]!.text.endsWith("…") && d.activity[0]!.text.length <= 221);
  assert.doesNotMatch(JSON.stringify(planOverview(v, NOW)), new RegExp(secret.slice(-20)));
});

// ---- the routes, on the real server --------------------------------------------------------------------------------------

test("GET /sidebar carries the plan overview; GET /sidebar/project gives one project's detail; owner only; nothing for anyone else", async () => {
  const r = rig({ vault: VAULT });
  const all = await r.api("/sidebar");
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.deepEqual(all.data.overview.projects.map((c: any) => c.id), ["roof", "fifty", "desk", "quiet", "shed"]);
  assert.equal(all.data.overview.zone, "America/Los_Angeles");
  assert.match(all.data.overview.today, /^\d{4}-\d{2}-\d{2}$/);
  const one = await r.api("/sidebar/project?id=roof");
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(one.data.project.title, "Roof");
  assert.deepEqual(one.data.project.blockerList, ["Waiting on the roofer's quote", "Waiting: Chase the quote"]);
  assert.match(one.data.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await r.api("/sidebar/project?id=nope")).status, 404);
  assert.equal((await r.api("/sidebar/project?id=..%2Fnow")).status, 404);
  // An id with spaces, a comma, brackets, an apostrophe and an accent, sent URL-encoded as the page sends it.
  const odd = rig({ vault: { ...VAULT, "Projects/Café Rebuild, Q4 (plan).md": "---\nstatus: active\n---\n# Café Rebuild\n", "Projects/Mom's 70th.md": "---\nstatus: active\n---\n# Mom's 70th\n" } });
  const oddIds = (await odd.api("/sidebar")).data.overview.projects.map((c: any) => c.id);
  for (const id of ["Café Rebuild, Q4 (plan)", "Mom's 70th"]) {
    assert.ok(oddIds.includes(id), id);
    const res = await odd.api(`/sidebar/project?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 200, `${id}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.project.path, `Projects/${id}.md`);
  }
  assert.equal((await r.api("/sidebar/project?id=roof", "POST", {})).status, 405);
  r.caller.who = "someone@example.com";
  for (const path of ["/sidebar/project?id=roof", "/sidebar"]) {
    const res = await r.api(path);
    assert.equal(res.status, 403, path);
    assert.doesNotMatch(JSON.stringify(res.data), /roof|Fifty/i, `${path}: nothing of the vault`);
  }
  r.caller.who = OWNER;
});

test("GET /sidebar/project: a vault that cannot be read is reported, never made up", async () => {
  const r = rig({ extra: () => ({ memory: { name: "memory", status: () => ({ port: "memory", state: "down", impl: "none", detail: "x", verifiedAt: "" }), search: () => { throw new Error("no"); }, read: () => { throw new Error("no"); } } }) });
  const res = await r.api("/sidebar/project?id=roof");
  assert.equal(res.status, 503);
  assert.match(res.data.error, /The vault could not be read/);
  const side = await r.api("/sidebar");
  assert.deepEqual(side.data.overview.projects, []);
});

// ---- the page's helpers (<plan-lib> in src/web/index.html) ----------------------------------------------------------------

test("the page's Plan helpers: addresses, relative days, dates in text", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const block = html.match(/\/\/ <plan-lib>([\s\S]*?)\/\/ <\/plan-lib>/)![1]!;
  const lib = new Function("el", `${block}; return { planTarget, planHref, relDay, longDay, shortDay, humanDates, zonedTime };`)(() => null) as any;
  assert.deepEqual(lib.planTarget("#plan"), { id: "" });
  assert.deepEqual(lib.planTarget("#plan/alpha-garden"), { id: "alpha-garden" });
  assert.deepEqual(lib.planTarget("#plan/50%20adventures"), { id: "50 adventures" });
  // Every id the overview can give a card survives the page's address and back, as the card link writes it.
  for (const id of ODD_NAMES) assert.deepEqual(lib.planTarget(lib.planHref(id).slice(1)), { id }, id);
  assert.deepEqual(lib.planTarget("#plan/Mom's%2070th"), { id: "Mom's 70th" });
  assert.deepEqual(lib.planTarget("#plan/Caf%C3%A9%20Rebuild%2C%20Q4%20(plan)"), { id: "Café Rebuild, Q4 (plan)" });
  for (const bad of ["#plan/", "#plan/..%2Fx", "#plan/%E0%A4%A", "#plan/a/b"]) assert.deepEqual(lib.planTarget(bad), { invalid: true }, bad);
  assert.equal(lib.planTarget("#jobs"), null);
  assert.equal(lib.planHref(""), "/#plan");
  assert.equal(lib.planHref("a b"), "/#plan/a%20b");
  const today = "2026-11-26";
  assert.deepEqual(["2026-11-26", "2026-11-25", "2026-11-27", "2026-11-23", "2026-12-06", "2026-11-12", "2026-10-29", "2026-09-26", "2027-10-07", "2025-01-01"].map((d) => lib.relDay(d, today)),
    ["today", "yesterday", "tomorrow", "3 days ago", "in 10 days", "2 weeks ago", "4 weeks ago", "2 months ago", "in 10 months", "2 years ago"]);
  assert.equal(lib.relDay("not a date", today), "");
  assert.equal(lib.longDay("2026-11-26"), "Thu, Nov 26, 2026");
  assert.equal(lib.shortDay("2026-12-05", today), "Dec 5");
  assert.equal(lib.shortDay("2027-01-05", today), "Jan 5, 2027");
  assert.equal(lib.humanDates("Brewery hunt (scheduled, 2026-12-05)", today), "Brewery hunt (scheduled, Dec 5)");
  assert.match(lib.zonedTime("2026-11-07T22:52:00.000Z", "America/Los_Angeles"), /^Nov 7, 2026, 2:52\s?PM PST$/);
});
