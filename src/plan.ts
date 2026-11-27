import { ZONE } from "./time.ts";
import { all, clean, CLOSED, first, frontmatter, headingKey, idOf, plain, projectNote, sections, statusOf, taskNote, titleOf, valueNames } from "./sidebar.ts";
import type { Frontmatter } from "./sidebar.ts";

// The Plan view's data (docs/plan.md): every project hub note in the vault (Projects/<name>.md) read as a project card for
// the All projects overview and the sidebar's compact list, and, for one project, a detail view (timeline, progress,
// blockers, next steps, recent activity, linked tasks, Rai's notes). Read-only, like the rest of the sidebar: nothing here
// writes the vault. Everything is written for a person, not an agent: the agent's own bookkeeping (message ids, source
// references, UTC clock times) is dropped or turned into Rai's time zone, and dates are given as YYYY-MM-DD for the page
// to show relative to today ("2 days ago"). Every string is masked for secret-shaped values, flattened and bounded.

export const PLAN_CARDS_MAX = 60;
export const PLAN_NEXT_MAX = 3;
export const PLAN_BLOCKERS_MAX = 8;
export const PLAN_ACTIVITY_MAX = 6;
export const PLAN_TASKS_MAX = 20;
export const PLAN_NOTES_MAX = 8;
export const PLAN_MILESTONES_MAX = 12;
// The sidebar's summary of the selected project (docs/plan.md, "Sidebar summary"): this many open linked tasks at most.
export const PLAN_SUMMARY_TASKS = 3;
// An active project with nothing dated for this long is shown as needing attention.
export const STALE_DAYS = 30;
const SUMMARY_MAX = 160;
const LINE_MAX = 220;
const NOTE_MAX = 500;

const NEXT_HEADING = /^(next actions?|next steps?|next up|next|to ?do|todo|actions?|action items)$/i;
const TASKS_HEADING = /^(open tasks?|tasks)$/i;
const BLOCKER_HEADING = /^(blockers?|blocked|blocked (on|by)|waiting( on| for)?|dependencies|depends on)$/i;
const ACTIVITY_HEADING = /^(log|activity|recent activity|updates?|progress|history|changelog|resume here|resume point|status)$/i;
const MILESTONE_HEADING = /^(milestones?|timeline|key dates|dates|schedule)$/i;
const NOTES_HEADING = /^(notes|rai'?s notes|my notes|personal notes|thoughts)$/i;
const OUTCOME_HEADING = /^(outcome|goal|goals|summary|about|overview|purpose|why)$/i;
const COMPLETION_HEADING = /^(completion requirements?|definition of done|done means|done when|success criteria)$/i;

export type PlanState = "active" | "paused" | "blocked" | "done";
export type Health = "green" | "yellow" | "red" | "grey";
export type Progress = { done: number; total: number; label: string };
export type ProjectCard = {
  id: string;
  path: string;
  title: string;
  status: string;      // the note's own status word, lowercased ("active", "paused", …; "" when it has none)
  state: PlanState;    // the status grouped for display
  priority: number | null; // 1 (highest) to 3, from `priority:` (1-3, P1-P3, high/medium/low)
  area: string;
  summary: string;     // one line from the Outcome section
  next: string;        // the next action, "" when none is written down
  started: string | null;
  target: string | null;
  lastActivity: string | null; // the newest date the note records (its `updated:` or a dated entry), never after today
  overdue: boolean;
  blockers: number;
  stale: boolean;
  health: Health;
  why: string;         // why the dot has its colour, in a few words
  progress: Progress | null;
};
export type PlanStats = { total: number; active: number; paused: number; done: number; overdue: number; blocked: number; attention: number };
export type PlanOverview = { today: string; zone: string; projects: ProjectCard[]; stats: PlanStats };
export type TimelineItem = { date: string; label: string; kind: "start" | "target" | "milestone" | "due" | "today"; done: boolean };
export type ActivityItem = { date: string; at: string | null; text: string };
export type LinkedTask = { path: string; title: string; status: string; done: boolean; due: string | null };
export type ProjectDetail = ProjectCard & {
  outcome: string;
  completion: string;
  timeline: TimelineItem[];
  blockerList: string[];
  nextSteps: string[];
  activity: ActivityItem[];
  tasks: LinkedTask[];
  tasksMore: number;
  notes: string[];
};
// The compact summary the sidebar's Plan section shows for the project chosen in the Projects selector: the card, its next
// steps, the first blocker, the next dated milestone (or task due date, or target) from today on, and the open linked tasks
// that are not already a next step. Nothing is filled in that the note does not say.
export type ProjectSummary = ProjectCard & {
  nextSteps: string[];
  blocker: string;                 // the first blocker recorded, "" when none
  milestone: TimelineItem | null;  // the next milestone or target not done, today or later (else the next task due date)
  openTasks: number;               // every open linked task
  tasks: LinkedTask[];             // up to PLAN_SUMMARY_TASKS of them, those not already listed in nextSteps
  tasksMore: number;               // the open linked tasks neither in nextSteps nor in tasks
};

// ---- dates and times --------------------------------------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Today's date in Rai's time zone.
export function dayIn(at: Date, zone = ZONE): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const validDay = (s: string): boolean => {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
// A front-matter date (`2026-10-07`, `2026-10-07T…`), or null.
const dateOf = (v: string | string[] | undefined): string | null => {
  const s = first(v).trim().slice(0, 10);
  return validDay(s) ? s : null;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// The offset of a zone at an instant, in minutes (so a wall-clock time there can be turned into an instant).
function zoneOffset(at: number, zone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - Math.floor(at / 60_000) * 60_000) / 60_000;
}
const instant = (day: string, hh: number, mm: number, utc: boolean, zone: string): Date | null => {
  if (hh > 23 || mm > 59) return null;
  const guess = Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  if (Number.isNaN(guess)) return null;
  return new Date(utc ? guess : guess - zoneOffset(guess, zone) * 60_000);
};
// "Nov 14, 2:53 PM" in Rai's zone.
const clock = (d: Date, zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);

// A dated entry, as the vault's agents write them: "2026-11-14 PST: …", "- 2026-10-26 05:13 UTC / 2026-10-25 22:13 PDT: …",
// "**2026-10-07:** …", "2026-10-24 23:21UTC — …". The header (date, optional clock time and zone, an optional "/ local time"
// restatement) ends at the first ": " or dash; a header longer than that is prose that happens to start with a date.
const ENTRY = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX/>-]\]\s+)?(?:\*\*|__)?(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(UTC|Z|GMT|PST|PDT|PT)?\b/;
export function datedEntry(line: string, zone = ZONE): { date: string; at: string | null; text: string } | null {
  const m = ENTRY.exec(line);
  if (!m || !validDay(m[1]!)) return null;
  let rest = line.slice(m[0].length);
  const sep = /^(.{0,48}?)(?:\*\*|__)?\s*(?::(?=[\s*_]|$)|—|–|\s-\s)\s*(?:\*\*|__)?\s*/.exec(rest);
  if (!sep) return null;
  // Whatever sits between the time and the separator must be a restatement of the time ("/ 2026-10-25 22:13 PDT"), a zone or
  // emphasis, not words.
  if (sep[1]!.trim() && !/^[\s/,()*_]*(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\.? \d{1,2})?[\s,]*(?:\d{1,2}:\d{2}(?::\d{2})?)?\s*(?:[AaPp]\.?[Mm]\.?)?\s*(?:UTC|Z|GMT|PST|PDT|PT|local|Pacific)?[\s)*_]*$/.test(sep[1]!)) return null;
  rest = rest.slice(sep[0].length);
  const utc = m[4] === "UTC" || m[4] === "Z" || m[4] === "GMT" || (!m[4] && m[2] !== undefined);
  const at = m[2] !== undefined ? instant(m[1]!, Number(m[2]), Number(m[3]), utc, zone) : null;
  const date = at ? dayIn(at, zone) : m[1]!;
  return { date, at: at ? at.toISOString() : null, text: rest };
}

// Text written for an agent, made readable: message ids and source lists dropped, UTC times turned into Rai's time.
export function humanize(text: string, entryDay: string | null = null, zone = ZONE): string {
  let t = plain(text);
  // Message and source references: "(#orbit<id>)", "Sources #orbit…, …", "source <long number>".
  t = t.replace(/\s*\((?:[^()]*?#orbit\d{6,}[^()]*?)\)/g, "");
  t = t.replace(/\s*\b(?:sources?|refs?|evidence)\s*:?\s*(?:#?orbit)?\d{12,}(?:\s*[,/;]\s*(?:#?orbit)?\d{12,})*\.?/gi, "");
  t = t.replace(/\s*#orbit\d{6,}/g, "");
  t = t.replace(/\b\d{15,}\b/g, "");
  // ISO instants and "YYYY-MM-DD HH:MM UTC" read as Rai's local time.
  t = t.replace(/\b(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(?:Z|UTC)\b/g, (s, d: string, h: string, m: string) => {
    const at = validDay(d) ? instant(d, Number(h), Number(m), true, zone) : null;
    return at ? clock(at, zone) : s;
  });
  // A bare "05:13 UTC" inside an entry: the entry's own (UTC) date gives the day.
  if (entryDay) t = t.replace(/\b(\d{1,2}):(\d{2})\s?UTC\b/g, (s, h: string, m: string) => {
    const at = instant(entryDay, Number(h), Number(m), true, zone);
    return at ? clock(at, zone).replace(/^.*?, /, "") : s;
  });
  // A converted time followed by its own local restatement ("2:53 PM / 14:53 PST") keeps the converted one.
  t = t.replace(/(\d{1,2}:\d{2}\s[AP]M)\s*\/\s*\d{1,2}:\d{2}\s*(?:PST|PDT|PT)\b/g, "$1");
  // Leftovers of the removals: empty brackets, doubled punctuation and spaces.
  t = t.replace(/\(\s*[,;/]?\s*\)/g, "").replace(/\s+([,.;:])/g, "$1").replace(/([,;.])\s*([,.;])/g, "$1").replace(/\.,/g, ".").replace(/\s{2,}/g, " ").trim();
  return t;
}

// Cut to a bound at a sentence or word, with an ellipsis, never mid-word.
export function brief(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sentence = cut.search(/[.!?](?=\s)[^.!?]*$/);
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}
const line = (text: string, max = LINE_MAX, day: string | null = null) => clean(brief(humanize(text, day), max), max + 1);
const firstSentence = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(?=\s+[A-Z"“(\d])/.exec(t);
  return m ? m[1]! : t;
};

// ---- the note's parts ---------------------------------------------------------------------------------------------------------

type Section = { heading: string; key: string; lines: string[] };
const sectionsOf = (body: string): Section[] => sections(body).map((s) => ({ ...s, key: headingKey(s.heading) }));
const LIST = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X|-|\/|>)\]\s+)?(.*)$/;
// The open items of a section (checked and dropped boxes are done).
function openItems(s: Section): string[] {
  const out: string[] = [];
  for (const l of s.lines) {
    const li = LIST.exec(l);
    if (!li) continue;
    if (li[1] && li[1] !== " " && li[1] !== "/" && li[1] !== ">") continue;
    if (li[2]!.trim()) out.push(li[2]!);
  }
  return out;
}
// A section's prose paragraphs (tables, quotes and list items aside), each joined to one line.
function paragraphs(s: Section): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) out.push(cur.join(" ")); cur = []; };
  for (const l of s.lines) {
    if (!l.trim() || /^\s*[|>]/.test(l) || LIST.test(l)) { flush(); continue; }
    cur.push(l.trim());
  }
  flush();
  return out;
}
// Every item and paragraph of a section, in order.
function entries(s: Section): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) out.push(cur.join(" ")); cur = []; };
  for (const l of s.lines) {
    const li = LIST.exec(l);
    if (li && !/^\s{2,}/.test(l)) { flush(); if (li[1] && li[1] !== " " && li[1] !== "/" && li[1] !== ">") continue; cur.push(li[2]!); continue; }
    if (!l.trim() || /^\s*[|>]/.test(l)) { flush(); continue; }
    if (li) { flush(); continue; } // nested items belong to the entry above; they are detail, not entries
    cur.push(l.trim());
  }
  flush();
  return out;
}

// The note's tables that have a Status (or State) column, as rows of plain cells.
type Table = { head: string[]; col: number; rows: string[][] };
function tablesOf(all: Section[]): Table[] {
  const out: Table[] = [];
  for (const s of all) {
    const rows = s.lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).map((l) => l.trim().slice(1, -1).split("|").map((c) => plain(c).trim()));
    if (rows.length < 3 || !rows[1]!.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const head = rows[0]!;
    const col = head.findIndex((c) => /^(status|state)$/i.test(c));
    if (col < 0) continue;
    const body = rows.slice(2).filter((r) => r.some((c) => c));
    if (body.length) out.push({ head, col, rows: body });
  }
  return out;
}
const itemCol = (t: Table) => t.head.findIndex((c, i) => i !== t.col && c && !/^(#|no\.?|id|date|when|task|link|notes?)$/i.test(c));
const dateCol = (t: Table) => t.head.findIndex((c, i) => i !== t.col && /^(date|when|scheduled|due)$/i.test(c));

// Progress: `progress: 7/50` in the front matter; else a table with a Status column (rows whose status starts "done" are
// done, labelled by its item column: "7/50 adventures done"); else the linked tasks; else the note's checkboxes.
function progressOf(data: Frontmatter, all: Section[], tasks: LinkedTask[]): Progress | null {
  const fm = /^(\d{1,5})\s*(?:\/|of)\s*(\d{1,5})(?:\s+(.{1,40}))?$/.exec(first(data.progress).trim());
  if (fm && Number(fm[2]) > 0) return { done: Math.min(Number(fm[1]), Number(fm[2])), total: Number(fm[2]), label: clean(fm[3] ?? "done", 40) || "done" };
  const table = tablesOf(all)[0];
  if (table) {
    const done = table.rows.filter((r) => /^(done|complete|completed|finished|✅|✔|\[x\])/i.test(r[table.col] ?? "")).length;
    const i = itemCol(table);
    const noun = i >= 0 ? table.head[i]!.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").trim() : "";
    const label = noun ? `${noun.endsWith("s") ? noun : `${noun}s`} done` : "done";
    return { done, total: table.rows.length, label: clean(label, 40) };
  }
  if (tasks.length) return { done: tasks.filter((t) => t.done).length, total: tasks.length, label: "tasks done" };
  let boxes = 0, ticked = 0;
  for (const s of all) for (const l of s.lines) {
    const li = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+/.exec(l);
    if (li) { boxes++; if (li[1] !== " ") ticked++; }
  }
  if (boxes >= 3) return { done: ticked, total: boxes, label: "items done" };
  return null;
}
// Rows of a status table that are under way or booked ("scheduled", "in-progress", "next"), as next steps.
function scheduledRows(all: Section[]): string[] {
  const out: string[] = [];
  for (const t of tablesOf(all)) {
    const i = itemCol(t), d = dateCol(t);
    if (i < 0) continue;
    for (const r of t.rows) {
      const st = (r[t.col] ?? "").toLowerCase();
      if (!/^(scheduled|booked|planned|in[- ]progress|next|doing|started)/.test(st)) continue;
      const when = d >= 0 && r[d] && r[d] !== "—" && r[d] !== "-" ? `, ${r[d]}` : "";
      out.push(`${r[i]} (${st.split(/[\s(;,]/)[0]}${when})`);
    }
  }
  return out;
}

const STATE: Record<string, PlanState> = { blocked: "blocked", paused: "paused", "on-hold": "paused", "on hold": "paused", hold: "paused", waiting: "paused", someday: "paused", later: "paused", backlog: "paused", parked: "paused" };
const stateOf = (status: string): PlanState => (CLOSED.has(status) ? "done" : STATE[status] ?? "active");
const priorityOf = (data: Frontmatter): number | null => {
  const v = first(data.priority).trim().toLowerCase();
  const n = /^p?([1-3])$/.exec(v)?.[1] ?? ({ high: "1", urgent: "1", top: "1", medium: "2", normal: "2", mid: "2", low: "3" } as Record<string, string>)[v];
  return n ? Number(n) : null;
};

function linkedTasks(notes: ReadonlyMap<string, string>, id: string): LinkedTask[] {
  const out: LinkedTask[] = [];
  for (const [path, text] of notes) {
    if (!taskNote(path)) continue;
    const { data } = frontmatter(text);
    if (!all(data.project).concat(all(data.projects)).some((v) => valueNames(v, id))) continue;
    const status = statusOf(data);
    out.push({ path, title: titleOf(path, text, data), status, done: CLOSED.has(status), due: dateOf(data.due) ?? dateOf(data.scheduled) });
  }
  // Open first (soonest due first), then done; then by title.
  return out.sort((a, b) => Number(a.done) - Number(b.done) || (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0) || a.title.localeCompare(b.title));
}

type Read = { card: ProjectCard; detail: () => ProjectDetail; summary: () => ProjectSummary };
function readProject(notes: ReadonlyMap<string, string>, path: string, text: string, today: string, zone: string): Read {
  const { data, body } = frontmatter(text);
  const id = idOf(path);
  const status = statusOf(data);
  const state = stateOf(status);
  const secs = sectionsOf(body);
  const tasks = linkedTasks(notes, id);
  const openTasks = tasks.filter((t) => !t.done);
  const started = dateOf(data.started) ?? dateOf(data.start) ?? dateOf(data.created);
  const target = dateOf(data.target) ?? dateOf(data.due) ?? dateOf(data.deadline);

  const outcomeSec = secs.find((s) => OUTCOME_HEADING.test(s.key));
  const outcomeText = outcomeSec ? paragraphs(outcomeSec)[0] ?? openItems(outcomeSec)[0] ?? "" : first(data.description) || first(data.summary);
  const summary = outcomeText ? line(firstSentence(outcomeText), SUMMARY_MAX) : "";

  // Next steps: the note's next-action headings, then the booked rows of a status table, then the open linked tasks, then the open boxes under a Tasks heading.
  const nextRaw: string[] = [];
  for (const s of secs) if (NEXT_HEADING.test(s.key)) nextRaw.push(...openItems(s));
  nextRaw.push(...scheduledRows(secs));
  for (const t of openTasks) nextRaw.push(t.due ? `${t.title} (due ${t.due})` : t.title);
  for (const s of secs) if (TASKS_HEADING.test(s.key)) for (const l of s.lines) { const li = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.*)$/.exec(l); if (li) nextRaw.push(li[1]!); }
  const nextSteps = [...new Set(nextRaw.map((x) => line(x)).filter(Boolean))].slice(0, PLAN_NEXT_MAX);

  // Blockers: the blocker headings, front-matter `blocked_by:`/`blockers:`/`waiting_on:`, and the linked tasks that wait.
  const blockRaw: string[] = [];
  for (const s of secs) if (BLOCKER_HEADING.test(s.key)) blockRaw.push(...openItems(s), ...paragraphs(s));
  for (const k of ["blocked_by", "blocked-by", "blockers", "blocker", "waiting_on", "waiting-on", "depends_on"]) blockRaw.push(...all(data[k]));
  for (const t of openTasks) if (t.status === "blocked" || t.status === "waiting") blockRaw.push(`${t.status === "blocked" ? "Blocked" : "Waiting"}: ${t.title}`);
  const blockerList = state === "done" ? [] : [...new Set(blockRaw.map((x) => line(x)).filter((x) => x && !/^(none|n\/a|nothing|-)\.?$/i.test(x)))].slice(0, PLAN_BLOCKERS_MAX);

  // Activity: dated entries under the log/progress headings, newest first, never in the future.
  const acts: ActivityItem[] = [];
  for (const s of secs) {
    if (!ACTIVITY_HEADING.test(s.key)) continue;
    for (const e of entries(s)) {
      const d = datedEntry(e, zone);
      if (!d || d.date > today) continue;
      const t = line(d.text, LINE_MAX, ENTRY.exec(e)?.[1] ?? d.date);
      if (t) acts.push({ date: d.date, at: d.at, text: t });
    }
  }
  acts.sort((a, b) => (b.at ?? `${b.date}T23:59:59Z`).localeCompare(a.at ?? `${a.date}T23:59:59Z`));
  const seen = new Set<string>();
  const activity = acts.filter((a) => (seen.has(a.text) ? false : (seen.add(a.text), true)));

  const updated = dateOf(data.updated) ?? dateOf(data.modified);
  const lastActivity = [updated, activity[0]?.date ?? null].filter((d): d is string => Boolean(d) && d! <= today).sort().at(-1) ?? null;
  const overdue = state !== "done" && Boolean(target && target < today);
  const stale = state === "active" && (lastActivity ? daysBetween(lastActivity, today) > STALE_DAYS : true);
  const blockers = blockerList.length + (state === "blocked" && !blockerList.length ? 1 : 0);
  const [health, why]: [Health, string] =
    state === "done" ? ["grey", status ? `Status: ${status}` : "Done"] :
    state === "blocked" ? ["red", "Blocked"] :
    overdue ? ["red", `Past its target date (${target})`] :
    blockers ? ["red", `${blockers} blocker${blockers === 1 ? "" : "s"}`] :
    state === "paused" ? ["yellow", `Status: ${status}`] :
    stale ? ["yellow", lastActivity ? `No recorded activity for over ${STALE_DAYS} days` : "No recorded activity"] :
    !nextSteps.length ? ["yellow", "No next action written down"] :
    ["green", "On track"];
  const progress = progressOf(data, secs, tasks);

  const card: ProjectCard = {
    id, path, title: titleOf(path, text, data), status, state, priority: priorityOf(data), area: clean(plain(first(data.area)), 40),
    summary, next: nextSteps[0] ?? "", started, target, lastActivity, overdue, blockers, stale, health, why: clean(why, 80), progress,
  };
  // Every dated item, oldest first: started, the milestones, the open linked tasks' due dates, the target and today.
  const timelineOf = (): TimelineItem[] => {
    const timeline: TimelineItem[] = [];
    if (started) timeline.push({ date: started, label: "Started", kind: "start", done: started <= today });
    for (const s of secs) {
      if (!MILESTONE_HEADING.test(s.key)) continue;
      for (const l of s.lines) {
        const li = LIST.exec(l);
        if (!li) continue;
        const raw = li[2]!;
        const d = datedEntry(raw, zone)?.date ?? (/\b(\d{4}-\d{2}-\d{2})\b/.exec(raw)?.[1] ?? null);
        if (!d || !validDay(d)) continue;
        const label = line((datedEntry(raw, zone)?.text ?? raw.replace(d, "")).replace(/^[\s:—–-]+/, ""), 120);
        timeline.push({ date: d, label: label || "Milestone", kind: "milestone", done: Boolean(li[1] && li[1] !== " ") });
      }
    }
    for (const t of openTasks) if (t.due) timeline.push({ date: t.due, label: t.title, kind: "due", done: false });
    if (target) timeline.push({ date: target, label: "Target", kind: "target", done: state === "done" });
    timeline.push({ date: today, label: "Today", kind: "today", done: false });
    timeline.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "today" ? 1 : b.kind === "today" ? -1 : 0));
    return timeline;
  };
  const detail = (): ProjectDetail => {
    const completionSec = secs.find((s) => COMPLETION_HEADING.test(s.key));
    const timeline = timelineOf();
    const notesSec = secs.filter((s) => NOTES_HEADING.test(s.key));
    return {
      ...card,
      outcome: outcomeText ? line(outcomeText, NOTE_MAX) : "",
      completion: completionSec ? line(paragraphs(completionSec)[0] ?? openItems(completionSec)[0] ?? "", NOTE_MAX) : "",
      timeline: timeline.slice(0, PLAN_MILESTONES_MAX + 3),
      blockerList,
      nextSteps,
      activity: activity.slice(0, PLAN_ACTIVITY_MAX),
      tasks: tasks.slice(0, PLAN_TASKS_MAX).map((t) => ({ ...t, title: clean(t.title, 100) })),
      tasksMore: Math.max(0, tasks.length - PLAN_TASKS_MAX),
      notes: notesSec.flatMap((s) => entries(s)).map((x) => line(x, NOTE_MAX)).filter(Boolean).slice(0, PLAN_NOTES_MAX),
    };
  };
  const sidebarSummary = (): ProjectSummary => {
    const listed = new Set(nextSteps);
    const unlisted = openTasks.filter((t) => !listed.has(line(t.due ? `${t.title} (due ${t.due})` : t.title)));
    // The next milestone or the target, today or later; else the next task due date (already a next step, most often).
    const ahead = state === "done" ? [] : timelineOf().filter((t) => !t.done && t.date >= today);
    const milestone = ahead.find((t) => t.kind === "milestone" || t.kind === "target") ?? ahead.find((t) => t.kind === "due") ?? null;
    return {
      ...card,
      nextSteps,
      blocker: blockerList[0] ?? "",
      milestone,
      openTasks: openTasks.length,
      tasks: unlisted.slice(0, PLAN_SUMMARY_TASKS).map((t) => ({ ...t, title: clean(t.title, 100) })),
      tasksMore: Math.max(0, unlisted.length - PLAN_SUMMARY_TASKS),
    };
  };
  return { card, detail, summary: sidebarSummary };
}

const STATE_ORDER: PlanState[] = ["active", "blocked", "paused", "done"];
// Cards in the order Rai works through them: open projects before done ones, then priority (unset last), then the most
// recent activity, then the title.
export function sortCards(cards: ProjectCard[]): ProjectCard[] {
  const open = (c: ProjectCard) => (c.state === "done" ? 1 : 0);
  return [...cards].sort((a, b) =>
    open(a) - open(b) ||
    (a.priority ?? 9) - (b.priority ?? 9) ||
    (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") ||
    STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
    a.title.localeCompare(b.title));
}

export function planOverview(notes: ReadonlyMap<string, string> | undefined, now = new Date(), zone = ZONE): PlanOverview {
  const today = dayIn(now, zone);
  const cards: ProjectCard[] = [];
  for (const [path, text] of notes ?? []) if (projectNote(path)) cards.push(readProject(notes!, path, text, today, zone).card);
  const projects = sortCards(cards).slice(0, PLAN_CARDS_MAX);
  const open = cards.filter((c) => c.state !== "done");
  const stats: PlanStats = {
    total: cards.length,
    active: cards.filter((c) => c.state === "active" || c.state === "blocked").length,
    paused: cards.filter((c) => c.state === "paused").length,
    done: cards.filter((c) => c.state === "done").length,
    overdue: open.filter((c) => c.overdue).length,
    blocked: open.filter((c) => c.blockers > 0).length,
    attention: open.filter((c) => c.health === "red" || c.health === "yellow").length,
  };
  return { today, zone, projects, stats };
}

// Any id the overview can give a card: the file name of a hub note Projects/<id>.md, so anything without a "/" (spaces,
// commas, brackets, apostrophes and accented letters included). It is only a key into the snapshot, never a disk path.
function readById(notes: ReadonlyMap<string, string>, id: string, now: Date, zone: string): Read | undefined {
  if (typeof id !== "string" || !projectNote(`Projects/${id}.md`)) return undefined;
  const path = `Projects/${id}.md`;
  const text = notes.get(path);
  if (text === undefined) return undefined;
  return readProject(notes, path, text, dayIn(now, zone), zone);
}

// One project's detail, or undefined when the vault has no such hub note.
export function projectDetail(notes: ReadonlyMap<string, string>, id: string, now = new Date(), zone = ZONE): ProjectDetail | undefined {
  return readById(notes, id, now, zone)?.detail();
}

// One project's sidebar summary, or undefined when the vault has no such hub note.
export function projectSummary(notes: ReadonlyMap<string, string>, id: string, now = new Date(), zone = ZONE): ProjectSummary | undefined {
  return readById(notes, id, now, zone)?.summary();
}
