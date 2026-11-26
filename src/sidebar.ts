import { maskVaultText } from "./vault/filter.ts";
import { untrustedText } from "./sessions.ts";

// The left sidebar's data (docs/sidebar.md): Rai's active projects from the vault, the plan and the related files of the selected
// project (or of everything when none is selected), and the photos Rai sent whose context names that project. Read-only: nothing
// here writes the vault or a conversation, and the page gets text only (masked for secret-shaped values, flattened, cut to a
// bound), never a note's path outside the snapshot or a photo's stored file name. The photo images are fetched through the
// Assistant's own display route (/assistant/photos/<ref>), which re-authorizes every request.

export const SIDEBAR_PROJECTS_MAX = 60;
export const SIDEBAR_PLAN_MAX = 12;
export const SIDEBAR_TASKS_MAX = 10;
export const SIDEBAR_FILES_MAX = 30;
export const SIDEBAR_LOCATIONS_MAX = 10;
// Photos per page of the Images section (docs/sidebar.md): the page asks for one page at a time (`images=<page>`, from 1).
export const SIDEBAR_IMAGES_PAGE = 10;
export const SIDEBAR_IMAGES_PAGES_MAX = 1000;
export const SIDEBAR_NOTE_MAX = 20_000;
const TEXT_MAX = 240;
const TITLE_MAX = 100;

// Statuses that mean a project or task is no longer active (AGENTS.md: done and dropped stay in place, finished work is archived).
const CLOSED = new Set(["done", "dropped", "archived", "cancelled", "canceled", "completed", "complete", "abandoned", "closed"]);
// Headings in a project note (or now.md) whose list items are the plan, in the order they are read.
const PLAN_HEADING = /^(next actions?|next steps?|next up|next|plan|the plan|resume here|resume point|now|focus|today|today'?s plan|top priorities|priorities|to ?do|todo|open tasks?|tasks|actions?)$/i;
const LOCATION_HEADING = /^(locations?|where( it lives)?|repos?|repositories|links)$/i;

export type Frontmatter = Record<string, string | string[]>;

// A small, strict reader for the front matter vault notes use (`key: value`, `key: [a, b]`, and `key:` followed by `- item` lines).
// Anything it does not understand is skipped, never guessed.
export function frontmatter(text: string): { data: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  let list: string | undefined;
  for (const raw of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(raw) ?? (list ? /^-\s+(.*)$/.exec(raw) : null);
    if (item && list) {
      const v = scalar(item[1]!);
      if (v) (data[list] as string[]).push(v);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) { list = undefined; continue; }
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (!value) { data[key] = []; list = key; continue; }
    list = undefined;
    // Unquoted wiki links (`project: [[orbit]]`, `projects: [[a]], [[b]]`), as Obsidian writes them, are links, not an
    // inline list: YAML would read `[[orbit]]` as a list holding a list, which names nothing.
    const links = /^\[\[[^[\]]+\]\](?:\s*,\s*\[\[[^[\]]+\]\])*$/.test(value) ? splitInline(value) : null;
    if (links) data[key] = links.length === 1 ? links[0]! : links;
    else if (value.startsWith("[") && value.endsWith("]")) data[key] = splitInline(value.slice(1, -1)).map(scalar).filter(Boolean);
    else data[key] = scalar(value);
  }
  return { data, body: text.slice(m[0].length) };
}
const scalar = (v: string): string => {
  const t = v.replace(/\s+#.*$/, "").trim();
  return (/^"(.*)"$/.exec(t) ?? /^'(.*)'$/.exec(t))?.[1] ?? t;
};
// Splits `a, "b, c", [[d]]` at the top-level commas.
function splitInline(s: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0, quote = "";
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = ""; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
const all = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

// Text for the page: secret-shaped values masked (src/vault/filter.ts), control and bidi characters removed, one line, bounded.
const clean = (text: string, max = TEXT_MAX): string => untrustedText(maskVaultText(text), max).text;
// Wiki links and Markdown links read as their visible text; emphasis and code marks are dropped.
const plain = (text: string): string =>
  text
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, (_, t: string) => t.split("/").pop()!)
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .trim();

export type SidebarProject = { id: string; path: string; title: string; status: string };
export type PlanItem = { text: string; section: string };
export type TaskItem = { path: string; title: string; status: string; due?: string };
export type FileItem = { path: string; title: string; kind: "project" | "task" | "note" };
// `ai`: how many saved model observations and corrections the Assistant may read about this photo (photos_recall's read), when the
// server could count them; the page shows an "AI" badge for observations.
export type SidebarImage = { ref: string; src: string; sentAt: string; sentLocal: string; caption: string; conversation: string; link: string; ai?: { observations: number; corrections: number } };
export type SidebarView = {
  projects: SidebarProject[];
  project: SidebarProject | null;
  // The requested project id when it is not an active project in the vault (the page then says so and shows everything).
  unknownProject?: string;
  plan: { source: string | null; items: PlanItem[]; tasks: TaskItem[] };
  files: { items: FileItem[]; locations: string[]; more: number };
  // One page of the matching photos: `page` from 1 of `pages`, `total` matching in all, `more` after this page.
  images: { items: SidebarImage[]; more: number; matched: "all" | "project"; page: number; pages: number; total: number; perPage: number };
};
export type SidebarOptions = { imagesPage?: number; aiOf?: (ref: string) => { observations: number; corrections: number } | undefined };

// A located photo as src/photo-access.ts reachablePhotos gives it, reduced to what the sidebar reads.
export type SidebarPhoto = { ref: string; sentAt: string; sentLocal: string; caption: string; conversation: { title: string; kind: "assistant" | "chat"; id: string }; present: boolean };

const titleOf = (path: string, text: string, data: Frontmatter): string => {
  const alias = first(data.aliases) || first(data.alias) || first(data.title);
  if (alias) return clean(plain(alias), TITLE_MAX);
  const h = /^#\s+(.+)$/m.exec(text);
  if (h) return clean(plain(h[1]!), TITLE_MAX);
  return clean(path.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " "), TITLE_MAX);
};
const statusOf = (data: Frontmatter): string => clean(first(data.status).toLowerCase(), 40);
const projectNote = (path: string) => /^Projects\/[^/]+\.md$/.test(path);
const taskNote = (path: string) => /^Tasks\/[^/]+\.md$/.test(path);
const idOf = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
const STATUS_ORDER = ["active", "in-progress", "doing", "", "waiting", "blocked", "paused", "someday"];
const rank = (s: string) => {
  const i = STATUS_ORDER.indexOf(s);
  return i < 0 ? STATUS_ORDER.length : i;
};

// Every active project hub note (Projects/<name>.md; AGENTS.md section 7), active first, then by title.
export function projectsOf(notes: ReadonlyMap<string, string>): SidebarProject[] {
  const out: SidebarProject[] = [];
  for (const [path, text] of notes) {
    if (!projectNote(path)) continue;
    const { data } = frontmatter(text);
    const status = statusOf(data);
    if (CLOSED.has(status)) continue;
    out.push({ id: idOf(path), path, title: titleOf(path, text, data), status });
  }
  return out.sort((a, b) => rank(a.status) - rank(b.status) || a.title.localeCompare(b.title)).slice(0, SIDEBAR_PROJECTS_MAX);
}

// The note's sections as (heading, lines), headings of any level.
function sections(body: string): { heading: string; lines: string[] }[] {
  const out: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    // Code blocks are neither headings nor items: their lines are left out.
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ heading: h[1]!, lines: [] });
    else out.at(-1)!.lines.push(line);
  }
  return out;
}
const headingKey = (h: string) => plain(h).replace(/[^\p{L}\p{N}' -]+/gu, " ").replace(/\s+/g, " ").trim();

// The open list items (bullets, numbered items and unchecked boxes; checked boxes are done) under the plan headings, and a
// paragraph under "Resume here", which is often prose.
export function planOf(text: string): PlanItem[] {
  const items: PlanItem[] = [];
  for (const s of sections(frontmatter(text).body)) {
    const key = headingKey(s.heading);
    if (!PLAN_HEADING.test(key)) continue;
    let prose = "";
    for (const line of s.lines) {
      const li = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X|-|\/|>)\]\s+)?(.*)$/.exec(line);
      if (li) {
        if (li[1] && li[1] !== " " && li[1] !== "/" && li[1] !== ">") continue; // done, dropped
        const t = clean(plain(li[2]!));
        if (t) items.push({ text: t, section: clean(key, 60) });
      } else if (line.trim() && !/^\s*[|>]/.test(line)) prose ||= line.trim();
    }
    if (prose && /resume/i.test(key) && !items.some((i) => i.section === clean(key, 60))) items.push({ text: clean(plain(prose)), section: clean(key, 60) });
    if (items.length >= SIDEBAR_PLAN_MAX) break;
  }
  return items.slice(0, SIDEBAR_PLAN_MAX);
}

// Does this front-matter value or note text link to the project (by [[id]], [[Projects/id]], [[id|label]] or the bare id)?
const linkTo = (id: string) => new RegExp(`\\[\\[(?:Projects/)?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.md)?(?:[|#][^\\]]*)?\\]\\]`, "i");
const valueNames = (v: string, id: string) => linkTo(id).test(v) || v.trim().toLowerCase() === id.toLowerCase() || v.trim().toLowerCase() === `projects/${id.toLowerCase()}`;

function tasksOf(notes: ReadonlyMap<string, string>, id: string | undefined): TaskItem[] {
  const out: TaskItem[] = [];
  for (const [path, text] of notes) {
    if (!taskNote(path)) continue;
    const { data } = frontmatter(text);
    const status = statusOf(data);
    if (CLOSED.has(status)) continue;
    if (id && !all(data.project).concat(all(data.projects)).some((v) => valueNames(v, id))) continue;
    const due = clean(first(data.due) || first(data.scheduled), 30);
    out.push({ path, title: titleOf(path, text, data), status, ...(due ? { due } : {}) });
  }
  // Due first (soonest), then by title.
  return out.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0) || a.title.localeCompare(b.title)).slice(0, SIDEBAR_TASKS_MAX);
}

function locationsOf(text: string): string[] {
  const out: string[] = [];
  for (const s of sections(frontmatter(text).body)) {
    if (!LOCATION_HEADING.test(headingKey(s.heading))) continue;
    for (const line of s.lines) {
      const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        const t = clean(plain(li[1]!));
        if (t) out.push(t);
      }
    }
  }
  return out.slice(0, SIDEBAR_LOCATIONS_MAX);
}

// The words a photo's caption or conversation title must contain to count as about the project: its id read as words, its
// title and its aliases (each as a whole phrase, case and accents ignored).
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
export function projectPhrases(p: SidebarProject, text: string | undefined): string[] {
  const { data } = text ? frontmatter(text) : { data: {} as Frontmatter };
  const raw = [p.id.replace(/[-_]+/g, " "), p.id, p.title, ...all(data.aliases), ...all(data.alias)];
  return [...new Set(raw.map((x) => fold(plain(x)).trim()).filter((x) => x.length >= 3))];
}
const mentions = (phrases: string[], text: string) => {
  const t = fold(text);
  return phrases.some((ph) => new RegExp(`(^|[^\\p{L}\\p{N}])${ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(t));
};

export function sidebarView(notes: ReadonlyMap<string, string> | undefined, photos: readonly SidebarPhoto[], requested: string | undefined, opts: SidebarOptions = {}): SidebarView {
  const map = notes ?? new Map<string, string>();
  const projects = projectsOf(map);
  const project = requested ? (projects.find((p) => p.id === requested) ?? null) : null;
  // A project is unknown only when the vault was read and has no such active project: an unreadable vault (no notes) says
  // nothing about it, so the page keeps the remembered choice for the next read.
  const unknownProject = notes && requested && !project ? clean(requested, 80) : undefined;
  const text = project ? map.get(project.path) : undefined;

  // Plan: the project note's plan sections and its open tasks; without a project, now.md and the open tasks due soonest.
  const planSource = project ? project.path : map.has("now.md") ? "now.md" : null;
  const plan = { source: planSource, items: planSource ? planOf(map.get(planSource) ?? "") : [], tasks: tasksOf(map, project?.id) };

  // Files: the project note, its tasks (open or not), then every other note that links to it (the activity log aside). Without
  // a project: now.md and every active project's hub note.
  let files: FileItem[] = [];
  let locations: string[] = [];
  if (project) {
    const re = linkTo(project.id);
    files.push({ path: project.path, title: project.title, kind: "project" });
    const linked: FileItem[] = [];
    for (const [path, t] of map) {
      if (path === project.path || /^Log\//.test(path)) continue;
      const { data } = frontmatter(t);
      const isTask = taskNote(path) && all(data.project).concat(all(data.projects)).some((v) => valueNames(v, project.id));
      if (isTask) files.push({ path, title: titleOf(path, t, data), kind: "task" });
      else if (re.test(t)) linked.push({ path, title: titleOf(path, t, data), kind: "note" });
    }
    files = [files[0]!, ...files.slice(1).sort((a, b) => a.title.localeCompare(b.title)), ...linked.sort((a, b) => a.path.localeCompare(b.path))];
    locations = locationsOf(text ?? "");
  } else {
    if (map.has("now.md")) files.push({ path: "now.md", title: titleOf("now.md", map.get("now.md")!, frontmatter(map.get("now.md")!).data), kind: "note" });
    for (const p of projects) files.push({ path: p.path, title: p.title, kind: "project" });
  }
  const more = Math.max(0, files.length - SIDEBAR_FILES_MAX);

  // Images: newest first; with a project, only photos whose caption or conversation title names it.
  const phrases = project ? projectPhrases(project, text) : [];
  const matching = photos.filter((ph) => ph.present && (!project || mentions(phrases, `${ph.caption}\n${ph.conversation.title}`))).sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
  // Paged: a page past the last shows the last one, so a list that shrank between reads still shows photos.
  const pages = Math.max(1, Math.ceil(matching.length / SIDEBAR_IMAGES_PAGE));
  const asked = Number.isInteger(opts.imagesPage) && opts.imagesPage! >= 1 ? Math.min(opts.imagesPage!, SIDEBAR_IMAGES_PAGES_MAX) : 1;
  const page = Math.min(asked, pages);
  const start = (page - 1) * SIDEBAR_IMAGES_PAGE;
  const images = matching.slice(start, start + SIDEBAR_IMAGES_PAGE).map((ph): SidebarImage => ({
    ref: ph.ref,
    src: `/assistant/photos/${ph.ref}`,
    sentAt: ph.sentAt,
    sentLocal: ph.sentLocal,
    caption: untrustedText(ph.caption, 140).text,
    conversation: untrustedText(ph.conversation.title, TITLE_MAX).text,
    link: ph.conversation.kind === "assistant" ? "#assistant" : `#chat/${ph.conversation.id.slice("chat:".length)}`,
    ...(() => {
      const ai = opts.aiOf?.(ph.ref);
      return ai ? { ai: { observations: ai.observations, corrections: ai.corrections } } : {};
    })(),
  }));

  return {
    projects,
    project,
    ...(unknownProject ? { unknownProject } : {}),
    plan,
    files: { items: files.slice(0, SIDEBAR_FILES_MAX), locations, more },
    images: { items: images, more: Math.max(0, matching.length - start - images.length), matched: project ? "project" : "all", page, pages, total: matching.length, perPage: SIDEBAR_IMAGES_PAGE },
  };
}

// One note for the sidebar's file preview: only a note in the snapshot, masked, and cut to a bound (saying so).
export function sidebarNote(notes: ReadonlyMap<string, string>, path: string): { path: string; text: string; truncated: boolean } | undefined {
  if (typeof path !== "string" || !path.endsWith(".md") || path.includes("\0")) return undefined;
  const text = notes.get(path);
  if (text === undefined) return undefined;
  const masked = maskVaultText(text).replace(/[‪-‮⁦-⁩]/g, "");
  return masked.length > SIDEBAR_NOTE_MAX ? { path, text: masked.slice(0, SIDEBAR_NOTE_MAX), truncated: true } : { path, text: masked, truncated: false };
}
