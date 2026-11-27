# Plan views

The Plan is a project-management view of Rai's projects, written for a person rather than an agent: which projects matter
most, what to do next, what is stuck, and how far along each one is. It replaces the old Plan section, which listed
`now.md`'s plan headings with UTC timestamps and agent notes.

It has three parts:

| Part | Where | What it shows |
| --- | --- | --- |
| **Sidebar index** | The left sidebar's Plan section (docs/sidebar.md), while the Projects selector is on All projects | **All projects** (with the count of open projects), a "N need attention" badge, then each open project by priority: a status dot, the title and a priority badge (P1, P2, P3). Each is a link that opens a view in the main area; the open one is marked (`aria-current="page"`). |
| **Sidebar summary** | The same section, while the Projects selector names one project | That project only, in a few lines: status dot, title and priority; state and health (and progress); the goal; a blocker; up to 3 next steps; an overdue target; the next date; the open linked tasks; and **Open full plan**, which opens its detail in the main area. See "Sidebar summary" below. |
| **All projects** | `/#plan`, in the main area | Quick stats (active, overdue, with blockers, paused), then one card per open project: title, priority, status and health, a one-line summary, the next action, progress (a bar and "7/50 adventures done"), last activity and target as relative dates ("2 days ago", "in 3 weeks"), and blockers or why it needs attention. Finished projects are folded under "Finished (N)". |
| **One project** | `/#plan/<project id>`, in the main area | Status (progress, state, last activity, what done means), Next steps (up to 3), Blockers, Timeline (started, milestones, task due dates, today and target, with how much of the time to the target has passed), Recent activity (up to 6 dated updates), Linked tasks (ORBIT tasks that name the project, open and done) and Notes. |

The views open only for ORBIT's owner (they read the vault, like the Assistant); for anyone else `#plan` falls back like the
other owner-only pages. They are real addresses: a card, the sidebar, "← All projects" and the browser's Back and Forward
move between them without reloading the page. A click on a Plan link moves keyboard focus to the new view's heading, and on
a phone closes the sidebar drawer.

## Sidebar summary

When the Projects selector (docs/sidebar.md) names a project, the Plan section shows a short summary of that project instead
of the index; back on All projects the index returns, unchanged. Each part shows only when the note says something for it:

| Part | What it shows |
| --- | --- |
| Head | Status dot, title, priority badge |
| State | "Active · on track", with why it needs attention when it does (stale, no next action), and progress ("1/3 beds done") |
| Goal | The one-line summary of the Outcome |
| Blocker | The first blocker, "(+N more)" when there are others, in red |
| Next | Up to 3 next steps (as in the detail) |
| Overdue | "target was Nov 1 (4 weeks ago)", in red, when the target has passed |
| Next date | The next milestone or the target from today on, else the next task due date: label, day and how far off |
| Open tasks | How many open linked tasks there are; up to 3 that are not already next steps by name and due day, and how many more |
| Open full plan | A link to `/#plan/<id>`, the detail in the main area |

Changing the selector never opens or changes the main area; only **Open full plan** (or a Plan link) does.

The summary rides on `GET /sidebar?project=<id>`, the read the selector already makes (`planSummary`, src/plan.ts
`projectSummary`), for the id the selector resolved to (`project.id`), so there is no second request. The page draws the
section for the selector's choice only: the moment the choice changes it shows All projects' index from the last answer
(the overview is the same for every choice) or the new project's name and "Reading the project…", never the previous
project's summary. An answer is drawn only if it is the newest read (`sidebarGen`) and was read for the choice showing; a
late answer for an earlier choice, including a minute's refresh, is dropped. A failed read for a new choice says so under
that project's name.

## Data

Read-only, from the same vault snapshot as the sidebar (src/plan.ts):

- `GET /sidebar` carries `overview`: `{ today, zone, projects: ProjectCard[], stats }` for every hub note
  `Projects/<name>.md` (top level only, open and done), whatever the selector says; and `planSummary`, the selected project's
  `ProjectSummary` (the card with `nextSteps`, `blocker`, `milestone`, `openTasks`, `tasks`, `tasksMore`), or `null` without one.
- `GET /sidebar/project?id=<id>` (owner only, GET only) answers `{ project: ProjectDetail, today }`, 404 for no such hub
  note (or an id with a `/` in it), 503 when the vault cannot be read. The id is the hub note's file name, so any id a card
  has opens, spaces, commas, brackets, apostrophes and accents included; the page sends it URL-encoded.

What is read from a project note:

| Field | Source |
| --- | --- |
| Title | `aliases:` (first), else the first `#` heading, else the file name |
| Priority | `priority:` 1-3, `P1`-`P3`, or high / medium / low |
| Status | `status:`; grouped as active, paused (paused, on hold, waiting, someday, …), blocked, done (done, dropped, archived, …) |
| Dates | `started:` (or `start:`, `created:`), `target:` (or `due:`, `deadline:`), `updated:`; `area:` |
| Summary | The first sentence of the Outcome (or Goal, Summary, About, Overview) section |
| Done means | The first paragraph of a Completion requirement (or Definition of done, Success criteria) section |
| Next steps | Open items under Next actions / Next steps / Next / To do / Actions; then rows of a status table marked scheduled, booked or in progress; then the open linked tasks (soonest due first); then open boxes under Tasks |
| Blockers | Items and paragraphs under Blockers / Blocked / Waiting on / Dependencies; `blocked_by:`, `blockers:` or `waiting_on:` in the front matter; linked tasks whose status is blocked or waiting. "None" does not count. |
| Progress | `progress: 7/50` in the front matter; else the first table with a Status column (rows whose status starts with "done" are done, and the table's item column names the unit: "7/50 adventures done"); else the linked tasks; else the note's checkboxes (three or more) |
| Timeline | Started, Target, dated items under Milestones / Timeline / Key dates (checked ones are done), open linked tasks with a due date, and today |
| Recent activity | Dated entries under Log / Activity / Updates / Progress / History / Resume here / Status, newest first, none after today |
| Linked tasks | `Tasks/*.md` whose `project:` or `projects:` names it (`[[id]]`, `[[id\|label]]`, `Projects/id` or `id`) |
| Notes | Items and paragraphs under Notes / Rai's notes / My notes |

A dated entry is a line or paragraph that starts with a date, optionally a clock time and zone, and optionally a
restatement in local time, then `: ` or a dash: `2026-11-14 PST: …`, `- 2026-10-26 05:13 UTC / 2026-10-25 22:13 PDT: …`,
`**2026-10-07:** …`. A clock time without a zone is read as UTC (as the vault's agents write it); the entry's day is its
day in Rai's time zone (America/Los_Angeles).

Health, the status dot (also given as text, "on track", "needs attention", "at risk", "done"):

- **red, at risk**: status blocked, a blocker recorded, or past the target date;
- **yellow, needs attention**: paused, no dated activity for over 30 days, or no next action written down;
- **green, on track**: otherwise;
- **grey, done**.

"Need attention" in the sidebar and the stats counts the open projects that are red or yellow.

Cards are sorted open before done, then by priority (unset last), then by the most recent activity, then by title.

### Written for a person

Text in the views is made readable: message ids and source lists (`#orbit…`, "Sources …") are dropped; UTC instants
(`2026-11-12T19:05:00Z`, `2026-11-07 22:52 UTC`, a bare `05:13 UTC` in a dated entry) become Rai's local time
("Nov 12, 11:05 AM"); Markdown emphasis and wiki links read as their text; long lines are cut at a sentence or word with an
ellipsis. The page shows days relative to today in Rai's time zone (the server's `today`), with the full date on hover,
and the time of a dated update in Rai's zone on hover. Calendar dates inside text read as "Nov 30". As everywhere in the
sidebar, every string is masked for secret-shaped values (src/vault/filter.ts), flattened and bounded, and set as text.

Nothing here writes the vault. Rai's notes are shown from the project note; to add one, write it under a "Notes" heading
in `Projects/<id>.md`.

## Tests

- `test/plan.test.ts`: dated entries, the humanizing of agent text, cards (priority, status, health, summary, next action,
  progress, last activity, overdue, blockers, stale), sorting, the detail (timeline, blockers, next steps, activity, linked
  tasks, notes), the sidebar summary (next date, tasks not already next steps, a sparse note, a done project, masking),
  masking and bounds; `GET /sidebar`'s overview and `planSummary` and `GET /sidebar/project` on the real server (owner only,
  404, 503); the page's helpers (`<plan-lib>`: addresses, relative days, dates in text).
- `test/plan-browser.test.ts` (Chromium): the sidebar index, All projects (stats, cards, folded finished projects, no raw
  UTC times or message ids), a card opening the detail with every section, Back and the browser's back button, the
  sidebar's link to another project, the Assistant and the other sidebar sections still working, error states, and the
  phone drawer closing on a Plan link in the dark theme. The sidebar summary: the index unchanged on All projects, a chosen
  project's summary and its Open full plan link (the main area untouched by the selector), a sparse project, untrusted text
  shown as text, switching A→B and A→All projects with A's answer held back, a failed read, a minute's refresh answering
  after the choice moved on, and the phone drawer (fits, tap target, closes on Open full plan).
- `test/sidebar-browser.test.ts`: the Plan section's index in the docked sidebar.
- `test/assistant-page.test.ts`, `test/chat-address.test.ts`: `#plan` routing.

## Not verified

- Rai's real vault was not used in tests. The parsing was tried by hand on one real project note (the one the job named)
  and is otherwise tested on synthetic notes; notes written with other headings show fewer next steps, blockers or
  activity than they could, and say so ("No next action written down.").
- A screen reader was not tried; names, roles and states are checked in the DOM only. Real phones were not used.
