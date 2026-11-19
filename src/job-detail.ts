import { alertRecordView, jobProgress } from "./job-progress.ts";
import type { AlertDelivery } from "./job-progress.ts";
import { jobRow } from "./job-view.ts";
import { DISPATCH_BRIEF_CHARS, redactText } from "./job-inputs.ts";
import { JOB_ID, KEEP_EVENTS, KEEP_JOBS, MAX_STEER_CHARS } from "./jobs.ts";
import type { Job, JobEvent, Steer } from "./jobs.ts";
import { dispatchEvidence } from "./launch-evidence.ts";
import { CONTROL_REPO } from "./launcher.ts";
import { prSections } from "./pull-requests.ts";

// The Jobs page's list and detail (owner only, docs/jobs-page.md). Everything here reads ORBIT's own job record; nothing calls GitHub
// or the provider, and nothing launches, retries or posts. Three rules run through it:
//  - Links say where they came from. `recorded`: the URL itself is on the job (GitHub's or the provider's own answer). `derived`: ORBIT
//    built it from recorded values (a repository and a commit or branch); whether the target still exists is not checked unless said.
//    `unavailable`: the record does not hold it, with why. A link is never invented, and every URL is checked against a strict shape.
//  - Inputs say how far they got, from evidence: proposed, confirmed, written, dispatched, accepted, received. A queued steer is never
//    called received.
//  - Text is whole and redacted. Lists and histories page with a cursor instead of being cut; anything ORBIT did not retain says so.

export const ORBIT_REPO = "DragonflyAI-sh/orbit";
export const ROWS_DEFAULT = 50;
export const ROWS_MAX = 200;
export const EVENTS_DEFAULT = 50;
export const EVENTS_MAX = 200;

const SHA = /^[0-9a-f]{7,64}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,10})$/;
const COMMENT_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(?:pull|issues)\/\d{1,10}#issuecomment-\d{1,20}$/;
const SESSION_URL = /^https:\/\/claude\.ai\/[A-Za-z0-9_./-]{1,200}(?:\?[A-Za-z0-9_=&.-]{0,200})?$/;

// A URL from a record is linked only when it has exactly the expected shape on the expected host.
export function safeUrl(url: unknown, shape: RegExp): string | undefined {
  if (typeof url !== "string" || !shape.test(url)) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "github.com" || u.hostname === "claude.ai") && !u.username && !u.password ? url : undefined;
  } catch {
    return undefined;
  }
}
const gh = (repo: string, ...path: string[]) => (REPO.test(repo) ? `https://github.com/${repo}/${path.map((p) => p.split("/").map(encodeURIComponent).join("/")).join("/")}` : undefined);
const isSha = (s: unknown): s is string => typeof s === "string" && SHA.test(s);
const branchOk = (b: unknown, id: string): b is string => b === `orbit/${id}`;

export type LinkBasis = "recorded" | "derived" | "unavailable";
export type JobLink = { group: "claude" | "control" | "tool" | "code" | "review" | "related"; label: string; basis: LinkBasis; value?: string; url?: string; job?: string; session?: string; note?: string };

// ---- titles ----

function firstLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, "").replace(/[*_`]/g, "").trim();
    if (!line || /^(goal|steps|summary|constraints|context|brief)\s*:?$/i.test(line)) continue;
    return line;
  }
  return undefined;
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export type TitleSource = "pr-title" | "summary-pr-title" | "review" | "research-report" | "brief" | "none";
// A short descriptive title for the list. The id stays next to it; the source says where the words came from.
export function jobTitle(job: Job): { text: string; source: TitleSource } {
  const t = (s: string, source: TitleSource) => ({ text: clip(redactText(s).text, 140), source });
  if (job.pr?.title) return t(job.pr.title, "pr-title");
  if (job.kind === "review" && job.review) {
    const m = job.review.prUrl.match(PR_URL);
    return t(`Review of ${job.review.of}${m ? ` (${m[1]}#${m[2]})` : ""}`, "review");
  }
  if (job.summary?.text && job.summary.state === "complete" && job.kind !== "research") {
    const title = prSections(job.summary.text).title;
    if (title) return t(title, "summary-pr-title");
  }
  if (job.kind === "research" && job.research?.report?.title) return t(job.research.report.title, "research-report");
  const brief = job.launch?.dispatch?.brief.text ?? (job.kind === "research" ? job.research?.brief : undefined);
  const line = brief ? firstLine(brief) : undefined;
  if (line) return t(line, "brief");
  return { text: `${job.launch?.routine ?? "unknown routine"} ${job.kind ?? "work"} job`, source: "none" };
}

export const laneOf = (job: Job): "build" | "research" => (job.kind === "research" ? "research" : "build");
// The latest time anything happened to the job, runner or ORBIT (kept for older pages and links). It falls back to dispatch times, so it is
// NOT runner activity: activityBasis says which it is, and runnerActivityAt is set only from a runner event.
export const activityAt = (job: Job): string => job.lastEventAt ?? job.launch?.firedAt ?? job.launch?.fireStartedAt ?? job.launch?.at ?? job.createdAt;
export const activityBasis = (job: Job): "runner" | "provider" | "dispatch" | "registered" => (job.lastEventAt ? "runner" : job.launch?.firedAt ? "provider" : job.launch ? "dispatch" : "registered");
const sortKey = (job: Job) => job.launch?.at ?? job.createdAt;

// ---- the list ----

export type RowQuery = { q?: string; state?: string; health?: string; kind?: string; lane?: string; routine?: string; attention?: boolean; limit?: number; cursor?: string };
const ATTENTION = new Set(["not-started", "quiet", "launch-failed"]);

export function parseRowQuery(params: URLSearchParams): RowQuery {
  const s = (k: string) => (params.get(k) ?? "").trim().slice(0, 200) || undefined;
  const limit = Number(params.get("limit") ?? ROWS_DEFAULT);
  return { q: s("q"), state: s("state"), health: s("health"), kind: s("kind"), lane: s("lane"), routine: s("routine"), attention: params.get("attention") === "1", limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), ROWS_MAX) : ROWS_DEFAULT, cursor: s("cursor") };
}

// Keyset cursor (launch time, id) so a page boundary does not shift when new jobs arrive at the top.
const encodeCursor = (job: Job) => Buffer.from(JSON.stringify([sortKey(job), job.id])).toString("base64url");
function decodeCursor(c: string | undefined): [string, string] | undefined {
  if (!c) return undefined;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    return Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string" ? [v[0], v[1]] : undefined;
  } catch {
    return undefined;
  }
}
const newerFirst = (a: Job, b: Job) => sortKey(b).localeCompare(sortKey(a)) || b.id.localeCompare(a.id);

// The searchable words of a job: id, title, routine, kind, lane, PR and session addresses, related job ids and the latest line.
function haystack(job: Job, title: string): string {
  const latest = [...job.events].reverse().find((e) => e.text)?.text?.slice(0, 500) ?? "";
  return [job.id, title, job.launch?.routine, job.kind ?? "work", laneOf(job), job.state, job.pr?.url, job.launch?.sessionUrl, job.launch?.sessionId, job.review?.of, job.review?.prUrl, job.reviewJob?.id, latest].filter(Boolean).join("\n").toLowerCase();
}

// Runner and error text in a row goes through the same redaction as the detail view.
function redactRow(r: ReturnType<typeof jobRow>) {
  const red = (t: string | undefined) => (t === undefined ? undefined : redactText(t).text);
  return { ...r, latest: r.latest ? { ...r.latest, text: red(r.latest.text) } : null, launchError: red(r.launchError), prError: red(r.prError), reviewError: red(r.reviewError) };
}

export function listRows(all: Job[], health: (j: Job) => string, running: string | undefined, query: RowQuery) {
  const limit = query.limit ?? ROWS_DEFAULT;
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const rows = [...all].sort(newerFirst).map((job) => ({ job, health: health(job), title: jobTitle(job) }));
  const matched = rows.filter(({ job, health: h, title }) => {
    if (query.state && job.state !== query.state) return false;
    if (query.health && h !== query.health) return false;
    if (query.kind && (job.kind ?? "work") !== query.kind) return false;
    if (query.lane && laneOf(job) !== query.lane) return false;
    if (query.routine && job.launch?.routine !== query.routine) return false;
    if (query.attention && !ATTENTION.has(h)) return false;
    if (words.length) {
      const hay = haystack(job, title.text);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const after = decodeCursor(query.cursor);
  const start = after ? matched.findIndex(({ job }) => sortKey(job).localeCompare(after[0]) < 0 || (sortKey(job) === after[0] && job.id.localeCompare(after[1]) < 0)) : 0;
  const from = start < 0 ? matched.length : start;
  const page = matched.slice(from, from + limit);
  const more = from + limit < matched.length;
  const counts = (pick: (r: (typeof rows)[number]) => string | undefined) => rows.reduce<Record<string, number>>((acc, r) => {
    const k = pick(r);
    if (k) acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  return {
    jobs: page.map(({ job, health: h, title }) => ({
      ...redactRow(jobRow(job, h, running)),
      title,
      lane: laneOf(job),
      createdAt: job.createdAt,
      activityAt: activityAt(job),
      activityBasis: activityBasis(job),
      runnerActivityAt: job.lastEventAt ?? null,
      summaryStatus: job.state === "done" || job.state === "blocked" || job.state === "failed" ? job.state : undefined,
    })),
    total: all.length,
    matched: matched.length,
    offset: from,
    limit,
    next: more && page.length ? encodeCursor(page[page.length - 1].job) : null,
    facets: { routines: Object.keys(counts((r) => r.job.launch?.routine)).sort(), state: counts((r) => r.job.state), health: counts((r) => r.health), kind: counts((r) => r.job.kind ?? "work"), lane: counts((r) => laneOf(r.job)) },
    retention: { maxJobs: KEEP_JOBS, note: `ORBIT keeps the most recent ${KEEP_JOBS} job records; older ones are removed from its store.` },
  };
}

// ---- events, paged ----

// seq numbers each event from the first one the job ever recorded (dropped ones included, when that count is known), so a cursor stays
// valid while new events arrive and old ones are trimmed.
export function droppedEvents(job: Job): number | null {
  if (job.eventsDropped !== undefined) return job.eventsDropped;
  return job.events.length < KEEP_EVENTS ? 0 : null;
}
function eventView(e: JobEvent, seq: number) {
  const red = e.text === undefined ? undefined : redactText(e.text);
  return {
    seq,
    at: e.at,
    type: e.type,
    via: e.via ?? "api",
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.n !== undefined ? { n: e.n } : {}),
    ...(isSha(e.sha) ? { sha: e.sha, shaUrl: gh(CONTROL_REPO, "commit", e.sha) } : {}),
    ...(e.toolCommit ? { toolCommit: e.toolCommit } : {}),
    ...(red ? { text: red.text, textChars: e.textChars ?? e.text!.length, textClipped: Boolean(e.textClipped), ...(e.textComplete === false ? { textComplete: false } : {}), ...(red.count ? { redacted: red.count } : {}) } : {}),
  };
}
export function eventsPage(job: Job, before?: number, limit = EVENTS_DEFAULT) {
  const base = droppedEvents(job) ?? 0;
  const all = job.events.map((e, i) => eventView(e, base + i + 1));
  const upto = before === undefined ? all.length : all.findIndex((e) => e.seq >= before);
  const end = upto < 0 ? all.length : upto;
  const n = Math.min(Math.max(limit, 1), EVENTS_MAX);
  const page = all.slice(Math.max(0, end - n), end).reverse();
  const older = Math.max(0, end - n);
  return {
    events: page,
    retained: all.length,
    dropped: droppedEvents(job),
    next: older > 0 ? all[older].seq : null,
    olderRetained: older,
    note: droppedEvents(job) === null ? `ORBIT keeps the last ${KEEP_EVENTS} events of a job; this record is older than the drop counter, so whether earlier events were dropped is unknown.` : droppedEvents(job)! > 0 ? `${droppedEvents(job)} earlier event(s) were dropped by ORBIT's ${KEEP_EVENTS}-event limit and are not retained; the orbit-work branch keeps the runner's own check-in log.` : undefined,
  };
}

// ---- links ----

// alertDelivery: the live delivery outcome of the job's first-callback alert, read from the notification store by the server.
export type DetailContext = { all: Job[]; routineRepo?: string; running?: string; alertDelivery?: (job: Job) => AlertDelivery | undefined };

export function jobLinks(job: Job, ctx: DetailContext): JobLink[] {
  const out: JobLink[] = [];
  const l = job.launch;
  const add = (link: JobLink) => out.push(link);
  const research = job.kind === "research";

  // Claude
  const session = safeUrl(l?.sessionUrl, SESSION_URL);
  if (session) add({ group: "claude", label: "Claude session", basis: "recorded", url: session, value: l?.sessionId, note: "Returned by the provider when the Routine fired." });
  else if (l?.sessionUrl) add({ group: "claude", label: "Claude session", basis: "unavailable", value: l.sessionId, note: "A session URL was recorded but does not have the expected claude.ai shape, so it is not linked." });
  else add({ group: "claude", label: "Claude session", basis: "unavailable", ...(l?.sessionId ? { value: l.sessionId } : {}), note: !l ? "No launch record: this job was registered by another path." : l.failedAt ? "The fire did not return a session." : l.firedAt ? "No session URL was recorded." : "No provider answer is recorded yet." });

  // orbit-work control record
  if (!research) {
    if (branchOk(l?.branch, job.id)) add({ group: "control", label: "Control branch (orbit-work)", basis: "derived", value: l!.branch, url: gh(CONTROL_REPO, "tree", l!.branch!), note: "The branch ORBIT created for the brief; the runner's check-ins, replies and summary are committed there." });
    else add({ group: "control", label: "Control branch (orbit-work)", basis: "unavailable", note: l ? "No control branch was recorded (the brief was not written)." : "No launch record." });
    if (isSha(l?.briefCommit)) {
      add({ group: "control", label: "Brief commit", basis: "derived", value: l!.briefCommit, url: gh(CONTROL_REPO, "commit", l!.briefCommit!) });
      add({ group: "control", label: "Brief file at that commit", basis: "derived", value: ".orbit/brief.md", url: gh(CONTROL_REPO, "blob", l!.briefCommit!, ".orbit/brief.md") });
    } else add({ group: "control", label: "Brief commit", basis: "unavailable", ...(l?.briefCommit ? { value: String(l.briefCommit).slice(0, 64) } : {}), note: l?.briefCommit ? "The recorded value is not a commit id, so it is not linked." : l?.failedAt ? "The brief write failed or did not finish." : "No brief commit was recorded." });
    if (isSha(job.summary?.sha)) add({ group: "control", label: "Summary commit", basis: "derived", value: job.summary!.sha, url: gh(CONTROL_REPO, "commit", job.summary!.sha!), note: "The orbit-work commit the summary was reported with." });
  }

  // Tool commits (DragonflyAI-sh/orbit)
  if (l?.toolCommitSent && isSha(l.toolCommitSent)) add({ group: "tool", label: "Tool commit sent in the fire text", basis: "derived", value: l.toolCommitSent, url: gh(ORBIT_REPO, "commit", l.toolCommitSent) });
  else add({ group: "tool", label: "Tool commit sent in the fire text", basis: "unavailable", value: l?.toolCommitSent, note: l?.toolCommitSent ? "ORBIT did not know its own commit, so the fire text said unknown." : "Not recorded on this launch (it predates the field, or the fire was never sent)." });
  if (job.toolCommit && isSha(job.toolCommit)) add({ group: "tool", label: "Tool commit the runner reported", basis: "derived", value: job.toolCommit, url: gh(ORBIT_REPO, "commit", job.toolCommit), note: "The runner's own claim at start; ORBIT cannot prove the runner verified it." });
  else add({ group: "tool", label: "Tool commit the runner reported", basis: "unavailable", note: job.events.length ? "The runner did not report one (older tool, or a malformed value)." : "The runner has not started." });
  const promptFile = research ? "deploy/routines/orbit-research.md" : "deploy/routines/orbit-jobs.md";
  if (l?.toolCommitSent && isSha(l.toolCommitSent)) add({ group: "tool", label: "Routine prompt (reference copy)", basis: "derived", value: promptFile, url: gh(ORBIT_REPO, "blob", l.toolCommitSent, promptFile), note: "The Routine's live prompt is stored in Claude, not sent by ORBIT; this is the repository's reference copy at the commit ORBIT ran, which may differ from the live Routine." });
  else add({ group: "tool", label: "Routine prompt (reference copy)", basis: "unavailable", value: promptFile, note: "The live prompt is stored in Claude and never recorded by ORBIT; the reference copy is in the orbit repository." });

  // Code: project repository, branch, PR
  const prUrl = safeUrl(job.pr?.url, PR_URL);
  const prRepo = prUrl?.match(PR_URL)?.[1];
  if (!research && job.kind !== "review") {
    const repo = prRepo ?? (ctx.routineRepo && REPO.test(ctx.routineRepo) ? ctx.routineRepo : undefined);
    if (repo) {
      add({ group: "code", label: "Project repository", basis: prRepo ? "recorded" : "derived", value: repo, url: gh(repo), note: prRepo ? "From the recorded pull request." : "From ORBIT's current routine-to-repository setting (ORBIT_ROUTINE_REPOS), not recorded on the job." });
      add({ group: "code", label: "Code branch", basis: "derived", value: `orbit/${job.id}`, url: gh(repo, "tree", `orbit/${job.id}`), note: prUrl ? "The pull request was opened from this branch." : "Where the runner is told to push; ORBIT has not checked that it exists." });
    } else add({ group: "code", label: "Project repository", basis: "unavailable", note: `No pull request is recorded and no repository is configured for routine ${l?.routine ?? "(none)"}.` });
  }
  if (prUrl) {
    add({ group: "code", label: "Pull request", basis: "recorded", value: prUrl.replace("https://github.com/", ""), url: prUrl, note: job.pr?.title ? `Title: ${clip(redactText(job.pr.title).text, 200)}` : undefined });
    add({ group: "code", label: "Pull request commits", basis: "derived", url: `${prUrl}/commits`, note: "ORBIT does not record implementation commits; GitHub lists them on the pull request." });
    add({ group: "code", label: "Pull request checks", basis: "derived", url: `${prUrl}/checks`, note: "ORBIT does not record check results or readiness; see GitHub." });
  } else if (job.pr?.url) add({ group: "code", label: "Pull request", basis: "unavailable", note: "A URL was recorded but does not have the expected GitHub pull-request shape, so it is not linked." });
  else if (job.pr && !job.pr.error) add({ group: "code", label: "Pull request", basis: "unavailable", note: "ORBIT is opening the pull request; no URL yet." });
  else if (job.pr?.error) add({ group: "code", label: "Pull request", basis: "unavailable", note: `Not opened: ${clip(redactText(job.pr.error).text, 400)}` });
  else if (!research && job.kind !== "review") add({ group: "code", label: "Pull request", basis: "unavailable", note: job.state === "done" ? "No pull request is recorded (no branch was found, no repository is configured, or the job predates PR records)." : "No pull request yet: ORBIT opens one when the job finishes done with a pushed branch." });

  // Review linkage
  if (job.kind === "review" && job.review) {
    const reviewed = safeUrl(job.review.prUrl, PR_URL);
    if (reviewed) add({ group: "review", label: "Pull request under review", basis: "recorded", value: reviewed.replace("https://github.com/", ""), url: reviewed });
    add({ group: "review", label: "Reviewed work job", basis: "recorded", value: job.review.of, job: JOB_ID.test(job.review.of) ? job.review.of : undefined, note: ctx.all.some((j) => j.id === job.review!.of) ? undefined : "That job's record is no longer in ORBIT's store." });
    if (isSha(job.review.reviewedSha) && REPO.test(job.review.repo)) add({ group: "review", label: "PR head when the review launched", basis: "derived", value: job.review.reviewedSha, url: gh(job.review.repo, "commit", job.review.reviewedSha!), note: "Where the review started, not a confirmation of the commit the reviewer read." });
    else add({ group: "review", label: "PR head when the review launched", basis: "unavailable", note: "Not recorded (older review job)." });
    const urls = [...new Set([...(job.review.comment?.urls ?? []), ...(job.review.comment?.url ? [job.review.comment.url] : [])])];
    urls.forEach((u, i) => {
      const ok = safeUrl(u, COMMENT_URL);
      add(ok ? { group: "review", label: urls.length > 1 ? `Review comment ${i + 1}/${urls.length}` : "Review comment", basis: "recorded", url: ok } : { group: "review", label: "Review comment", basis: "unavailable", note: "A comment URL was recorded but does not have the expected shape, so it is not linked." });
    });
    if (!urls.length) add({ group: "review", label: "Review comment", basis: "unavailable", note: job.review.comment?.error ? `Not posted: ${clip(redactText(job.review.comment.error).text, 300)}` : "Not posted yet." });
  }
  if (job.reviewJob) {
    if (job.reviewJob.id) add({ group: "review", label: "Review job", basis: "recorded", value: job.reviewJob.id, job: JOB_ID.test(job.reviewJob.id) ? job.reviewJob.id : undefined, note: ctx.all.some((j) => j.id === job.reviewJob!.id) ? undefined : "That job's record is no longer in ORBIT's store." });
    else add({ group: "review", label: "Review job", basis: "unavailable", note: job.reviewJob.error ? `Not launched: ${clip(redactText(job.reviewJob.error).text, 300)}` : "Being launched." });
    const c = safeUrl(job.reviewJob.commentUrl, COMMENT_URL);
    if (c) add({ group: "review", label: "Review comment", basis: "recorded", url: c });
  }

  // Related: work session, origin conversation, jobs that point here
  if (job.work) {
    add({ group: "related", label: "Launch proposal", basis: "recorded", value: job.work.proposal });
    add({ group: "related", label: "Work session", basis: "recorded", value: job.work.workSession });
    const o = job.work.origin;
    const chat = o?.match(/^chat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
    if (chat) add({ group: "related", label: "Proposed in session", basis: "derived", value: o!, session: `/sessions/${chat[1]}` });
    else if (o === "assistant:assistant") add({ group: "related", label: "Proposed in the Assistant", basis: "derived", value: o, session: "/#assistant" });
    else add({ group: "related", label: "Proposed in", basis: "unavailable", value: o ?? undefined, note: "The origin conversation was not known when it was confirmed." });
  }
  for (const other of ctx.all) {
    if (other.id === job.id) continue;
    if (other.review?.of === job.id && other.id !== job.reviewJob?.id) add({ group: "related", label: "Review job of this job", basis: "recorded", value: other.id, job: other.id });
  }
  return out;
}

// ---- inputs ----

export type Stage = { key: string; label: string; status: "done" | "failed" | "pending" | "unknown" | "n/a"; at?: string; evidence: string };

function launchStages(job: Job): Stage[] {
  const l = job.launch;
  const d = dispatchEvidence(job);
  const research = job.kind === "research";
  const origin = l?.dispatch?.origin ?? (job.kind === "review" ? "orbit-review" : job.work ? "chat-proposal" : undefined);
  const stages: Stage[] = [];
  if (origin === "chat-proposal" || job.work) {
    stages.push({ key: "proposed", label: "Proposed", status: "done", evidence: `Chat proposal ${job.work?.proposal ?? l?.dispatch?.proposal ?? "(id not recorded)"}.` });
    stages.push({ key: "confirmed", label: "Confirmed by Rai", status: "done", at: job.createdAt, evidence: "A job is registered only after the confirmation click." });
  } else if (origin === "orbit-review") stages.push({ key: "confirmed", label: "Started by ORBIT", status: "done", at: job.createdAt, evidence: "ORBIT launches one review per pull request it opens; no confirmation click." });
  else if (origin === "owner-route") stages.push({ key: "confirmed", label: "Launched by Rai", status: "done", at: job.createdAt, evidence: "Rai's own /jobs/launch request." });
  else stages.push({ key: "confirmed", label: "Origin", status: "unknown", at: job.createdAt, evidence: l ? "Launched before ORBIT recorded how a launch started (no work-session link and no dispatch snapshot)." : "Registered without a launch (POST /jobs)." });
  if (!l) return stages;
  if (research) stages.push({ key: "brief", label: "Brief held by ORBIT", status: "done", at: job.createdAt, evidence: "A research brief is kept on the job and served by the job API." });
  else if (l.briefCommit) stages.push({ key: "brief", label: "Brief written to orbit-work", status: "done", evidence: `Commit ${l.briefCommit}.` });
  else stages.push({ key: "brief", label: "Brief written to orbit-work", status: l.failedAt ? "failed" : d.state === "in-flight" ? "pending" : "failed", ...(l.failedAt ? { at: l.failedAt } : {}), evidence: l.failedAt ? clip(redactText(l.error ?? "failed").text, 300) : "No brief commit was recorded." });
  if (l.fireStartedAt) stages.push({ key: "dispatched", label: "Routine fired", status: "done", at: l.fireStartedAt, evidence: "ORBIT recorded the fire just before sending it." });
  else if (l.firedAt || l.sessionId) stages.push({ key: "dispatched", label: "Routine fired", status: "done", evidence: "Older record: no fire-start time, but the provider answered." });
  else stages.push({ key: "dispatched", label: "Routine fired", status: d.state === "never-dispatched" ? "n/a" : d.state === "in-flight" ? "pending" : "unknown", evidence: d.basis });
  const accepted = d.state === "provider-accepted" || d.state === "runner-reported" ? (l.sessionId ? "done" : d.state === "runner-reported" ? "unknown" : "done") : d.state === "provider-rejected" ? "failed" : d.state === "in-flight" ? "pending" : d.state === "never-dispatched" ? "n/a" : "unknown";
  stages.push({ key: "accepted", label: "Accepted by the provider", status: accepted, ...(l.firedAt ? { at: l.firedAt } : l.failedAt && l.fireFailure ? { at: l.failedAt } : {}), evidence: l.sessionId ? `Session ${l.sessionId}.` : d.basis });
  if (research) {
    const t = job.research?.toolServed;
    stages.push({ key: "tool", label: "Runner tool sent by the job API", status: t ? "done" : job.events.length ? "unknown" : "pending", ...(t ? { at: t.firstAt } : {}), evidence: t ? `Sent ${t.count} time(s) (sha256 ${t.sha256.slice(0, 12)}…). This proves ORBIT answered the download, not that the runner received it intact or ran it.` : job.events.length ? "The runner reported, but this record has no tool-download evidence (it predates it, or the download was not needed)." : "ORBIT has not sent the runner tool. A download that failed on the way (a reset, a timeout, a TLS failure) never reaches ORBIT and leaves no record here." });
  }
  if (research) {
    const s = job.research?.briefServed;
    stages.push({ key: "received", label: "Brief fetched by the runner", status: s ? "done" : job.events.length ? "unknown" : "pending", ...(s ? { at: s.firstAt } : {}), evidence: s ? `Served ${s.count} time(s) by the job API (payload sha256 ${s.sha256.slice(0, 12)}…). The runner tool asks for it at start, before its first check-in; it is not a check-in.` : job.events.length ? "The runner reported, but this record predates brief-fetch tracking." : "The job API has not served the brief." });
  }
  const first = job.events[0];
  const boot = research ? job.events.find((e) => e.type === "bootstrap") : undefined;
  if (boot && !job.events.some((e) => e.type === "started")) {
    stages.push({ key: "started", label: "Runner started", status: "failed", at: boot.at, evidence: `The runner reported a bootstrap failure before its tool ran (${boot.bootstrap?.category ?? boot.status ?? "unknown"}, ${boot.bootstrap?.attempts ?? "?"} attempt(s)). Runner-reported, unverified.` });
    return stages;
  }
  stages.push({ key: "started", label: "Runner started", status: first ? "done" : "pending", ...(first ? { at: first.at } : {}), evidence: first ? `First runner check-in (its first authenticated callback): ${first.type} via ${first.via === "git" ? "git" : "the API"}. Runner-reported.${research ? "" : " A started runner has checked out the control branch holding the brief."}` : `No runner check-in yet: execution unverified${research && job.research?.toolServed ? " (a tool download does not prove the tool ran)" : ""}. That is not evidence that no session exists.` });
  if (research && first) {
    const r = job.research?.report;
    const sum = job.summary;
    stages.push({ key: "report", label: "Report received", status: r || sum ? "done" : job.state === "running" || job.state === "registered" ? "pending" : "unknown", ...(r?.storedAt ? { at: r.storedAt } : sum ? { at: sum.at } : {}), evidence: r ? `${r.chars} characters, status ${r.status}.` : sum ? "A summary arrived, but ORBIT recorded no report check for it." : "No report yet." });
    if (r) stages.push({ key: "validated", label: "Report checked by ORBIT", status: r.valid ? "done" : "failed", ...(r.storedAt ? { at: r.storedAt } : {}), evidence: r.valid ? "Passed ORBIT's shape and bounds checks. That is not a check of its claims." : `Did not pass ORBIT's checks${r.problems.length ? `: ${clip(r.problems.join("; "), 300)}` : ""}.` });
  }
  return stages;
}

function steerView(s: Steer, job: Job) {
  const reply = job.events.find((e) => e.type === "reply" && e.n === s.n);
  const red = redactText(s.text);
  return {
    n: s.n,
    at: s.at,
    text: red.text,
    ...(red.count ? { redacted: red.count } : {}),
    chars: s.textChars ?? s.text.length,
    clipped: s.textChars !== undefined && s.textChars > s.text.length,
    source: s.source ?? "unrecorded",
    ...(s.proposal ? { proposal: s.proposal } : {}),
    // queued: stored by ORBIT and offered to the runner; delivered: the runner acknowledged it (written into its git record); replied:
    // the runner answered it. A queued steer is never called received.
    state: reply ? "replied" : s.deliveredAt ? "delivered" : "queued",
    ...(s.deliveredAt ? { deliveredAt: s.deliveredAt } : {}),
    ...(reply ? { reply: { at: reply.at, via: reply.via ?? "api", text: redactText(reply.text ?? "").text, textClipped: Boolean(reply.textClipped), textChars: reply.textChars ?? reply.text?.length ?? 0 } } : {}),
  };
}

export type OpenSteerProposal = { id: string; job: string; text: string; createdAt: string; expiresAt: string };

export function jobInputs(job: Job, openSteers: OpenSteerProposal[] = []) {
  const l = job.launch;
  const snap = l?.dispatch;
  const research = job.kind === "research";
  let brief;
  if (snap) {
    brief = {
      state: "recorded" as const,
      text: snap.brief.text,
      chars: snap.brief.chars,
      retainedChars: snap.brief.retainedChars,
      sha256: snap.brief.sha256,
      delivery: snap.brief.delivery,
      redactions: snap.redactions.filter((r) => r.field === "brief"),
      note: snap.brief.retainedChars < snap.brief.chars ? `ORBIT kept the first ${snap.brief.retainedChars} of ${snap.brief.chars} characters (its ${DISPATCH_BRIEF_CHARS}-character snapshot limit). The whole brief is in orbit-work at the brief commit.` : undefined,
    };
  } else if (research && job.research?.brief !== undefined) {
    const red = redactText(job.research.brief);
    brief = { state: "recorded" as const, text: red.text, chars: job.research.brief.length, retainedChars: job.research.brief.length, delivery: "job-api" as const, redactions: red.count ? [{ field: "brief" as const, what: "secret-shaped values in the brief", count: red.count }] : [], note: "Held on the research job since registration (it predates dispatch snapshots, so the fire text was not kept)." };
  } else {
    brief = {
      state: "unavailable" as const,
      note: !l ? "No launch record: this job was registered without a brief." : isSha(l.briefCommit) ? "Not retained on this job: it was launched before ORBIT kept a dispatch snapshot. The brief ORBIT wrote is in orbit-work at the brief commit (see Links)." : "Not retained, and no brief commit was recorded.",
      ...(isSha(l?.briefCommit) ? { url: gh(CONTROL_REPO, "blob", l!.briefCommit!, ".orbit/brief.md") } : {}),
    };
  }
  const fire = snap
    ? { state: "recorded" as const, text: snap.fireText, at: snap.at, redactions: snap.redactions.filter((r) => r.field === "fireText"), note: "The text of the Routine fire request, exactly as sent, with the one-job token replaced by its label. The request's headers (Routine credential, API version) are transport and are not shown." }
    : { state: "unavailable" as const, note: l?.fireStartedAt || l?.firedAt ? "Not retained: this launch predates dispatch snapshots. Recorded fields only: the tool commit line below." : "No fire was recorded.", ...(l?.toolCommitSent ? { toolCommitSent: l.toolCommitSent } : {}) };
  return {
    snapshot: snap ? { v: snap.v, at: snap.at, lane: snap.lane, origin: snap.origin, ...(snap.proposal ? { proposal: snap.proposal } : {}) } : null,
    stages: launchStages(job),
    brief,
    fireText: fire,
    routinePrompt: { state: "not-sent" as const, note: "The Routine's own prompt is stored in Claude and is the same for every job on that Routine; ORBIT does not send or record it. See the reference copy in Links." },
    ...(research ? { research: { briefServed: job.research?.briefServed ?? null, note: "The job API serves the brief with fixed budget and report fields (src/research.ts)." } } : {}),
    ...(job.kind === "review" && job.review ? { review: { of: job.review.of, prUrl: safeUrl(job.review.prUrl, PR_URL) ?? null, repo: job.review.repo, reviewedSha: job.review.reviewedSha ?? null, note: "ORBIT wrote this review brief itself (src/review.ts); it is the brief above when a snapshot exists." } } : {}),
    steers: [...job.steers].reverse().map((s) => steerView(s, job)),
    proposedSteers: openSteers.filter((p) => p.job === job.id).map((p) => ({ id: p.id, text: redactText(p.text).text, createdAt: p.createdAt, expiresAt: p.expiresAt, state: "proposed" as const, note: "Proposed in a chat; nothing is queued until Rai confirms it." })),
    maxSteerChars: MAX_STEER_CHARS,
    work: job.work ?? null,
  };
}

// ---- timeline and results ----

function keyTimes(job: Job) {
  const l = job.launch;
  const t: { at: string; what: string }[] = [{ at: job.createdAt, what: "Registered" }];
  if (l) {
    t.push({ at: l.at, what: `Launch recorded on routine ${l.routine}` });
    if (l.fireStartedAt) t.push({ at: l.fireStartedAt, what: "Routine fire sent" });
    if (l.firedAt) t.push({ at: l.firedAt, what: "Provider accepted the fire" });
    if (l.failedAt) t.push({ at: l.failedAt, what: `Launch failed: ${clip(redactText(l.error ?? "").text, 200)}` });
  }
  const toolServed = job.kind === "research" ? job.research?.toolServed : undefined;
  if (toolServed) t.push({ at: toolServed.firstAt, what: "Runner tool sent by the job API (not proof that it ran)" });
  const briefServed = job.kind === "research" ? job.research?.briefServed : undefined;
  if (briefServed) t.push({ at: briefServed.firstAt, what: "Brief served by the job API" });
  if (job.events[0]) t.push({ at: job.events[0].at, what: "First runner event retained" });
  const a = job.callbackAlert;
  if (a) {
    t.push({ at: a.firstAt, what: a.notificationId || a.count ? "Not-started alert queued (first check-in overdue)" : "Not-started alert could not be queued" });
    if (a.resolvedAt) t.push({ at: a.resolvedAt, what: a.resolution === "finished" ? "Not-started alert superseded: the job finished" : "Not-started alert superseded: the runner checked in" });
  }
  for (const s of job.steers) {
    t.push({ at: s.at, what: `Steer ${s.n} queued` });
    if (s.deliveredAt) t.push({ at: s.deliveredAt, what: `Steer ${s.n} acknowledged by the runner` });
  }
  if (job.summary) t.push({ at: job.summary.at, what: `Summary recorded (${job.summary.state}, via ${job.summary.via})` });
  if (job.pr) t.push({ at: job.pr.at, what: job.pr.url ? "Pull request opened or found" : job.pr.error ? "Pull request not opened" : "Pull request being opened" });
  if (job.reviewJob) t.push({ at: job.reviewJob.at, what: job.reviewJob.id ? `Review job ${job.reviewJob.id} started` : "Review launch attempted" });
  if (job.review?.comment) t.push({ at: job.review.comment.at, what: job.review.comment.url ? "Review posted as a comment" : "Review comment not posted" });
  return t.sort((a, b) => a.at.localeCompare(b.at));
}

function results(job: Job) {
  const s = job.summary;
  const red = s ? redactText(s.text) : undefined;
  return {
    state: job.state,
    summary: s
      ? { text: red!.text, chars: s.chars, retainedChars: s.text.length, state: s.state, via: s.via, at: s.at, ...(s.sha ? { sha: s.sha } : {}), ...(red!.count ? { redacted: red!.count } : {}), note: s.state === "partial" ? "Only the start reached ORBIT over the API; ORBIT is reading the full text from git." : s.state === "oversize" ? `Over ORBIT's limit: only the first ${s.text.length} characters are kept here; the whole summary is in orbit-work.` : undefined }
      : null,
    pr: job.pr ? { url: safeUrl(job.pr.url, PR_URL) ?? null, at: job.pr.at, ...(job.pr.title ? { title: redactText(job.pr.title).text } : {}), ...(job.pr.titleSource ? { titleSource: job.pr.titleSource } : {}), ...(job.pr.total ? { parts: { total: job.pr.total, posted: job.pr.posted ?? 1 } } : {}), ...(job.pr.attempts ? { attempts: job.pr.attempts } : {}), ...(job.pr.error ? { error: redactText(job.pr.error).text } : {}) } : null,
    reviewOutcome: job.reviewJob ? { id: job.reviewJob.id ?? null, at: job.reviewJob.at, verdict: job.reviewJob.verdict ?? null, verdictReason: job.reviewJob.verdictReason ?? null, commentUrl: safeUrl(job.reviewJob.commentUrl, COMMENT_URL) ?? null, ...(job.reviewJob.error ? { error: redactText(job.reviewJob.error).text } : {}) } : null,
    review: job.review ? { of: job.review.of, verdict: job.review.verdict ?? null, verdictReason: job.review.verdictReason ?? null, comment: job.review.comment ? { at: job.review.comment.at, ...(job.review.comment.total ? { parts: { total: job.review.comment.total, posted: job.review.comment.posted ?? 0 } } : {}), ...(job.review.comment.error ? { error: redactText(job.review.comment.error).text } : {}) } : null } : null,
    research: job.kind === "research" ? { report: job.research?.report ?? null, isolation: job.research?.isolation ?? null, vault: job.research?.vault ?? null } : null,
    readiness: "ORBIT does not decide readiness or approve merges; a review verdict is the review job's own claim as ORBIT recorded it.",
  };
}

// The whole owner view of one job: sections for the page, plus the newest page of events.
export function jobDetail(job: Job, health: string, ctx: DetailContext, openSteers: OpenSteerProposal[] = []) {
  const row = jobRow(job, health, ctx.running);
  const l = job.launch;
  return {
    id: job.id,
    overview: {
      ...row,
      title: jobTitle(job),
      lane: laneOf(job),
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      activityAt: activityAt(job),
      activityBasis: activityBasis(job),
      runnerActivityAt: job.lastEventAt ?? null,
      progress: jobProgress(job, health),
      firstCallbackAlert: job.callbackAlert ? { record: alertRecordView(job.callbackAlert), delivery: ctx.alertDelivery?.(job) ?? null } : null,
      launch: l ? { routine: l.routine, at: l.at, ...(l.fireStartedAt ? { fireStartedAt: l.fireStartedAt } : {}), ...(l.firedAt ? { firedAt: l.firedAt } : {}), ...(l.failedAt ? { failedAt: l.failedAt, error: redactText(l.error ?? "").text } : {}), ...(l.fireFailure ? { fireFailure: l.fireFailure } : {}) } : null,
      dispatch: dispatchEvidence(job),
      legacyContext: l?.context ? { paths: l.context.paths, note: "Legacy: this job was launched when ORBIT still copied vault notes into the job; that export has since been removed." } : undefined,
    },
    links: jobLinks(job, ctx),
    inputs: jobInputs(job, openSteers),
    timeline: { keyTimes: keyTimes(job), events: eventsPage(job) },
    results: results(job),
  };
}
