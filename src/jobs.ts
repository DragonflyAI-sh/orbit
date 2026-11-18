import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Notifier } from "./notify.ts";
import type { PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";
import type { JobWorkLink } from "./work-sessions.ts";

// Jobs run by Claude cloud runners. ORBIT registers a job, hands the runner a token that works for that job only,
// queues steers for it, and receives its events. The git record in orbit-work stays the source of truth.

// `text` on an event is for display and is clipped at MAX_TEXT; `textChars` is the length received and `textClipped` says it was
// clipped. The full final summary is kept on the job (Job.summary), not here.
export type JobEvent = { at: string; type: "started" | "checkin" | "reply" | "summary" | "bootstrap"; sha?: string; toolCommit?: string; n?: number; status?: string; text?: string; textChars?: number; textClipped?: boolean; via?: "api" | "git";
  // False when the sender says `text` is only the start of the real text (the runner's tool sends this when its summary is over the API size limit).
  textComplete?: boolean;
  // Only on a `bootstrap` event: the research runner's own report that it stopped before its tool ran (src/research-bootstrap.ts). Every
  // field is checked by the listener; `text` is written by ORBIT from them, never taken from the runner.
  bootstrap?: BootstrapFailure };
// A research runner's report that its bootstrap (download and digest check of the runner tool) failed and it stopped. Runner-reported and
// unverified, like every runner event; `category` is one of a fixed set (src/research-bootstrap.ts BOOTSTRAP_CATEGORIES).
export type BootstrapFailure = { category: string; attempts: number; curlExit: number; http: number };
// The final summary as ORBIT holds it. complete: the whole text. partial: only the start arrived (API size limit); the full text is read from git and
// the PR and review wait for it. oversize: longer than MAX_SUMMARY_CHARS; only the first MAX_TEXT characters are kept here, the full text is in git.
export type SummaryRecord = { text: string; chars: number; state: "complete" | "partial" | "oversize"; via: "api" | "git"; at: string; sha?: string };
// A steer as ORBIT queued it. deliveredAt: the runner acknowledged it (the orbit-job tool acks a steer once it has written it into git).
// source: "owner" (Rai's own POST /jobs/<id>/steer) or "proposal" (a confirmed chat proposal, whose id is `proposal`); absent on steers
// queued before this field existed (legacy: source not recorded). textChars: set only when the text was longer than MAX_TEXT and clipped.
export type Steer = { n: number; text: string; at: string; deliveredAt?: string; source?: "owner" | "proposal"; proposal?: string; textChars?: number };
// What ORBIT actually sent a runner at dispatch, recorded in the same write as fireStartedAt (src/job-launch.ts), so the Jobs page shows
// what was truly sent and never a reconstruction from today's templates. Versioned (`v`); absent on every launch before it existed.
// Redacted before it is stored: the one-job token in the fire text is replaced by its label, and secret-shaped values in the brief are
// masked (src/job-inputs.ts). Transport headers (the Routine credential, API version headers) are never part of it.
export type DispatchSnapshot = {
  v: 1;
  at: string;
  lane: "build" | "research";
  // Which path launched it: Rai's /jobs/launch route, a confirmed chat proposal, or ORBIT's own review launch.
  origin: "owner-route" | "chat-proposal" | "orbit-review";
  proposal?: string;
  // The `text` of the Routine fire request body, exactly as sent, except the token value.
  fireText: string;
  // The brief: for build jobs what ORBIT wrote to orbit-work .orbit/brief.md at the brief commit; for research jobs what the job API
  // serves. sha256 and chars are of the text as sent (before redaction); text is the redacted copy, at most retainedChars characters
  // (retainedChars < chars only for a brief longer than DISPATCH_BRIEF_CHARS, which is then labelled, and git holds the whole of it).
  brief: { text: string; chars: number; retainedChars: number; sha256: string; delivery: "orbit-work" | "job-api" };
  // What was redacted, by field, with a count. Values are never kept.
  redactions: { field: "fireText" | "brief"; what: string; count: number }[];
};
export type Launch = { routine: string; at: string; branch?: string; briefCommit?: string; sessionId?: string; sessionUrl?: string; failedAt?: string; error?: string;
  // Dispatch evidence (docs/reviews/launch-reconciliation.md), written by src/job-launch.ts on launches since this field was added; absent
  // on older records, which are read conservatively (src/launch-evidence.ts). fireStartedAt: persisted immediately before the Routine fire
  // request is sent. firedAt: when the provider answered with a session. toolCommitSent: the `Tool commit:` line of the fire text (a commit
  // id or "unknown", never the token). fireFailure: what a failed fire says about whether the provider received it (src/launcher.ts).
  fireStartedAt?: string; firedAt?: string; toolCommitSent?: string; fireFailure?: "rejected" | "server-error" | "no-session" | "transport";
  // The redacted record of what was sent (above). Absent on older launches: their brief is only in orbit-work at briefCommit.
  dispatch?: DispatchSnapshot;
  // Distinct words of the brief, for the duplicate-launch warning (src/duplicates.ts). Not the brief itself.
  briefWords?: string;
  // Legacy, read only: job records from before launch-time vault context export was removed may still hold the paths that were copied,
  // the commit that held the copies, the vault commit and the fetch freshness. Nothing writes this any more.
  context?: { paths: string[]; commit?: string; vaultHead?: string; fresh: boolean } };
// Where the PR's title came from, so a fallback is never mistaken for the runner's own.
export type TitleSource = "pr-title-section" | "summary-first-line" | "job-routine";
// Delivery of text too long for one GitHub body: part 1 is the PR description, parts 2..total are ordered comments. posted counts parts delivered (the description is 1).
export type PullRequest = { at: string; url?: string; error?: string; title?: string; titleSource?: TitleSource; total?: number; posted?: number; attempts?: number; lastAttemptAt?: string };
// Set on a `work` job once ORBIT starts its one review job, and updated as the review finishes.
export type ReviewOutcome = { id?: string; at: string; verdict?: Verdict; verdictReason?: string; commentUrl?: string; error?: string };
// "no verdict" (no Verdict line) and "ambiguous" (conflicting or unrecognised) are never approval.
export type Verdict = "no blocking issues" | "blocking issues" | "no verdict" | "ambiguous";
// Set on a `review` job: what it reviews, and what became of its findings.
// reviewedSha: the PR head commit when ORBIT launched the review (set from GitHub's own answer when ORBIT opened or found the PR; absent on
// older jobs, which means unknown). It is where the review started, not a confirmation from the reviewer of the commit it read.
export type ReviewOf = { of: string; prUrl: string; repo: string; reviewedSha?: string; comment?: { at: string; url?: string; error?: string; urls?: string[]; total?: number; posted?: number; attempts?: number; lastAttemptAt?: string }; verdict?: Verdict; verdictReason?: string };
// A research job (src/research.ts): its brief is held here (it has no orbit-work branch), and what ORBIT checked and did with its report.
// Set by ORBIT at registration from the routine's configured lane, never from anything the runner sends.
export type ResearchRecord = {
  brief: string;
  report?: { status: string; valid: boolean; problems: string[]; chars: number; sha256?: string; storedAt?: string; sources?: number; title?: string; storeError?: string };
  // Read-only evidence collected at completion: whether orbit-work holds a branch for this job (it never should) and whether a PR record exists.
  isolation?: { orbitWorkBranch: "absent" | "present" | "unknown"; pr: "absent" | "present"; checkedAt: string };
  // What became of an owner-initiated vault save (the existing policy-checked pipeline). Absent: never saved.
  // A pending record is reconciled with the card's live outcome (src/research-tools.ts): committed, failed, cancelled, or expired when
  // the card lapsed (timed out, or dropped by a restart) without being confirmed. Earlier attempts are kept, newest last, as provenance.
  vault?: ResearchVaultAttempt & { previous?: ResearchVaultAttempt[] };
  // Evidence that the runner fetched its brief from the job API (GET /v1/jobs/<id>/brief): when it was first and last served, how many
  // times, and the sha256 of the first payload served. Absent: never served, or served before this field existed.
  briefServed?: { firstAt: string; lastAt: string; count: number; sha256: string };
  // Evidence that the job API sent the runner tool (GET /v1/jobs/<id>/tool answered 200 with the whole file): when, how often, and the
  // digest it served. It proves ORBIT sent it, not that the runner received it intact or ran it. Absent: never served (or served before
  // this field existed), which includes a request that never reached ORBIT (a reset or TLS failure on the way).
  toolServed?: { firstAt: string; lastAt: string; count: number; sha256: string };
};
export type ResearchVaultAttempt = { at: string; path: string; state: "committed" | "pending-confirmation" | "failed" | "cancelled" | "expired"; commit?: string; proposalId?: string; expiresAt?: string; settledAt?: string; error?: string };
export type Job = {
  id: string;
  // Absent means `work`. A review job never opens a PR and never starts a review. A research job never opens a PR, never starts a
  // review and has no orbit-work branch or code branch (src/research.ts).
  kind?: "work" | "review" | "research";
  research?: ResearchRecord;
  review?: ReviewOf;
  reviewJob?: ReviewOutcome;
  launch?: Launch;
  // Set at registration, in the same write, when the job comes from a confirmed proposal (src/work-sessions.ts): the proposal, the work
  // session and the origin conversation. Ids only. Absent on jobs from other paths and on every job registered before this field
  // (legacy: unlinked, never backfilled).
  work?: JobWorkLink;
  // The commit the runner reports it copied orbit-job from, taken from its start. Absent on older jobs: unknown, not a mismatch.
  toolCommit?: string;
  // Set when ORBIT starts opening the project PR; once set, ORBIT never opens another.
  pr?: PullRequest;
  summary?: SummaryRecord;
  createdAt: string;
  expiresAt: string;
  state: "registered" | "running" | "done" | "blocked" | "failed";
  lastEventAt?: string;
  events: JobEvent[];
  // How many of the oldest events were dropped to keep the last KEEP_EVENTS. Absent on records from before it was counted (unknown).
  eventsDropped?: number;
  steers: Steer[];
};

// A reported tool commit is a full lowercase hex commit id; "unknown", missing and anything else are not recorded.
export function normalizeToolCommit(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// A research job's token lives at most this long, however it is (re-)registered (src/research.ts RESEARCH_LIMITS.tokenTtlMs).
export const RESEARCH_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_TEXT = 4000;
// The most of a final summary ORBIT keeps whole (about 3 GitHub comments). Longer is reported as oversize, never silently cut.
export const MAX_SUMMARY_CHARS = 200_000;
export const KEEP_EVENTS = 200;
export const KEEP_JOBS = 200;
export const MAX_STEER_CHARS = MAX_TEXT;
// The documented callback deadlines (docs/research-lane.md, "Bootstrap and the callback deadline"). A launched job with no runner event
// after NOT_STARTED_AFTER_MS reads `not-started`: not checked in, which is never proof that it failed or never launched. It is computed
// from stored times on every read, so it survives a restart, and the first runner event (however late) clears it.
export const NOT_STARTED_AFTER_MS = 10 * 60_000;
export const QUIET_AFTER_MS = 15 * 60_000;

export function jobSecret(dir: string | undefined): Buffer {
  if (!dir) return randomBytes(32);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "job-secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

export type Jobs = ReturnType<typeof jobs>;

export function jobs(store: Store<Job[]>, secret: Buffer, notify: Notifier, now: () => Date = () => new Date()) {
  const list = () => store.read();
  const save = (items: Job[]) => store.write(items.slice(-KEEP_JOBS));
  const sign = (id: string, expiresAt: string) => createHmac("sha256", secret).update(`${id}\n${expiresAt}`).digest("base64url");
  const find = (id: string) => list().find((j) => j.id === id);
  const update = (id: string, change: (j: Job) => Job) => save(list().map((j) => (j.id === id ? change(j) : j)));
  let lastEventAt: string | undefined;
  // `complete` false means fullText is only the start of the summary (state partial) or absent: listeners must not act on it.
  type SummaryListener = (job: Job, fullText: string | undefined, complete: boolean) => void;
  const listeners: SummaryListener[] = [];

  return {
    // Registers a job and returns its token. Registering an existing id again returns a fresh token for it.
    // `work` is recorded only on a new job (an existing id keeps what it has).
    // `research` registers a research job (kind and brief in the same write); an existing id never changes kind.
    register(id: string, ttlMs = DEFAULT_TTL_MS, extra: { work?: JobWorkLink; research?: { brief: string } } = {}): { job: Job; token: string } | { error: string } {
      if (!JOB_ID.test(id)) return { error: "Job ids are letters, digits, dot, underscore and dash, up to 64 characters." };
      const at = now();
      const existing = find(id);
      if (existing?.kind === "research" || extra.research) ttlMs = Math.min(ttlMs, RESEARCH_TTL_MS);
      const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
      const job: Job = existing ? { ...existing, expiresAt } : { id, createdAt: at.toISOString(), expiresAt, state: "registered", events: [], steers: [], ...(extra.work ? { work: extra.work } : {}), ...(extra.research ? { kind: "research" as const, research: { brief: extra.research.brief } } : {}) };
      save(existing ? list().map((j) => (j.id === id ? job : j)) : [...list(), job]);
      return { job, token: `${id}.${sign(id, expiresAt)}` };
    },

    // A token is valid only for its own job, until that job finishes or expires, whichever comes first.
    verify(id: string, token: string | undefined): boolean {
      const job = find(id);
      if (!job || !token || new Date(job.expiresAt) <= now()) return false;
      if (job.state === "done" || job.state === "blocked" || job.state === "failed") return false;
      const expected = Buffer.from(`${id}.${sign(id, job.expiresAt)}`);
      const given = Buffer.from(token);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    record(id: string, event: Omit<JobEvent, "at">): Job | undefined {
      const job = find(id);
      if (!job) return undefined;
      const at = now().toISOString();
      const clean: JobEvent = { ...event, at, via: event.via ?? "api", text: event.text?.slice(0, MAX_TEXT), status: event.status?.slice(0, 200) };
      if (event.text !== undefined && (event.text.length > MAX_TEXT || event.textComplete === false)) {
        clean.textChars = event.text.length;
        clean.textClipped = true;
      }
      let summary: SummaryRecord | undefined;
      if (event.type === "summary" && event.text !== undefined) {
        const chars = event.text.length;
        const state: SummaryRecord["state"] = chars > MAX_SUMMARY_CHARS ? "oversize" : event.textComplete === false ? "partial" : "complete";
        summary = { text: state === "oversize" ? event.text.slice(0, MAX_TEXT) : event.text, chars, state, via: clean.via!, at, ...(event.sha ? { sha: event.sha.slice(0, 64) } : {}) };
      }
      // A bootstrap failure is the runner saying it stopped before its tool ran: the job is over (failed), and the token stops working.
      const state: Job["state"] =
        event.type === "bootstrap" ? "failed" : event.type === "summary" && (event.status === "done" || event.status === "blocked" || event.status === "failed") ? event.status : "running";
      const reported = event.type === "started" ? normalizeToolCommit(event.toolCommit) : undefined;
      if (reported) clean.toolCommit = reported;
      else delete clean.toolCommit;
      // A later summary never replaces a complete one with a partial one.
      update(id, (j) => {
        const all = [...j.events, clean];
        const dropped = Math.max(0, all.length - KEEP_EVENTS);
        // Counted from the moment the timeline reaches KEEP_EVENTS on a record whose drops are known (it never had KEEP_EVENTS before, or
        // it already counts). A legacy record already at KEEP_EVENTS stays uncounted: how many it lost before is unknown.
        const known = j.eventsDropped !== undefined || j.events.length < KEEP_EVENTS;
        const count = known && (j.eventsDropped !== undefined || all.length >= KEEP_EVENTS);
        return { ...j, ...(reported ? { toolCommit: reported } : {}), ...(summary && !(j.summary?.state === "complete" && summary.state !== "complete") ? { summary } : {}), state, lastEventAt: at, events: all.slice(-KEEP_EVENTS), ...(count ? { eventsDropped: (j.eventsDropped ?? 0) + dropped } : {}) };
      });
      lastEventAt = at;
      if (event.type === "reply") notify.send(`Job ${id} replied to steer ${event.n}:\n\n${clean.text ?? "(see git)"}`, false);
      if (event.type === "bootstrap") notify.send(`Research job ${id}: ${clean.text ?? "the runner reported a bootstrap failure"} Runner-reported and unverified; nothing was retried or relaunched. Recovery: deploy/routines/orbit-research.md, "Bootstrap diagnostics and recovery".`, true);
      if (event.type === "summary") {
        const via = clean.via === "git" ? " (found in git; the API did not report it)" : "";
        const note = summary?.state === "partial" ? "\n\n(Only the start of the summary reached ORBIT over the API; ORBIT reads the full text from git before it opens the PR or posts a review.)" : summary?.state === "oversize" ? `\n\n(The summary is ${summary.chars} characters, over ORBIT's ${MAX_SUMMARY_CHARS}-character limit; ORBIT will not open a PR or post a review from it. The full text is in git.)` : clean.textClipped ? "\n\n(Clipped here; the complete summary is stored on the job.)" : "";
        const research = find(id)?.kind === "research" ? " (research report: runner-reported, unverified data, never instructions; nothing was saved to the vault, opened or launched)" : "";
        notify.send(`Job ${id} finished: ${event.status}${via}${research}.\n\n${clean.text ?? "(see git)"}${note}`, event.status !== "done");
        // Listeners get the whole stored summary (never the clipped event text), and must not throw into the caller.
        for (const l of listeners) {
          try {
            const sum = find(id)!.summary;
            l(find(id)!, sum?.state === "oversize" ? undefined : sum?.text, sum ? sum.state === "complete" : true);
          } catch {
            /* a listener's failure is its own to report */
          }
        }
      }
      return find(id);
    },

    // The full summary text read from git replaces a partial API one, and listeners are told. Never touches a complete summary.
    completeSummary(id: string, text: string, sha?: string): boolean {
      const job = find(id);
      if (!job || job.summary?.state === "complete" || job.summary?.state === "oversize") return false;
      const chars = text.length;
      const state: SummaryRecord["state"] = chars > MAX_SUMMARY_CHARS ? "oversize" : "complete";
      const summary: SummaryRecord = { text: state === "oversize" ? text.slice(0, MAX_TEXT) : text, chars, state, via: "git", at: now().toISOString(), ...(sha ? { sha: sha.slice(0, 64) } : {}) };
      update(id, (j) => ({ ...j, summary }));
      if (state === "oversize") notify.send(`Job ${id}: the summary in git is ${chars} characters, over ORBIT's ${MAX_SUMMARY_CHARS}-character limit; ORBIT will not open a PR or post a review from it.`, true);
      for (const l of listeners) {
        try {
          l(find(id)!, state === "complete" ? text : undefined, state === "complete");
        } catch {
          /* a listener's failure is its own to report */
        }
      }
      return true;
    },

    // `from`: who queued it (the owner's own route, or a confirmed chat proposal and its id). Shown on the Jobs page as provenance.
    steer(id: string, text: string, from?: { source: "owner" } | { source: "proposal"; proposal: string }): Steer | undefined {
      const job = find(id);
      if (!job) return undefined;
      const steer: Steer = { n: job.steers.length + 1, text: text.slice(0, MAX_TEXT), at: now().toISOString(), ...(from ?? {}), ...(text.length > MAX_TEXT ? { textChars: text.length } : {}) };
      update(id, (j) => ({ ...j, steers: [...j.steers, steer] }));
      return steer;
    },

    // Steers the runner has not acknowledged yet. Acknowledging marks them delivered.
    pending(id: string): Steer[] {
      return find(id)?.steers.filter((s) => !s.deliveredAt) ?? [];
    },

    acknowledge(id: string, numbers: number[]): void {
      const at = now().toISOString();
      update(id, (j) => ({ ...j, steers: j.steers.map((s) => (numbers.includes(s.n) && !s.deliveredAt ? { ...s, deliveredAt: at } : s)) }));
    },

    // Called after a summary is recorded, whether it came over the API or from git.
    onSummary(listener: SummaryListener): void {
      listeners.push(listener);
    },

    setPr(id: string, pr: PullRequest | undefined): void {
      update(id, (j) => ({ ...j, pr }));
    },

    // Marks a job as a review job, with what it reviews.
    setReview(id: string, review: ReviewOf): void {
      update(id, (j) => ({ ...j, kind: "review", review }));
    },

    // The review of a work job; once set, ORBIT never starts another.
    setReviewJob(id: string, reviewJob: ReviewOutcome | undefined): void {
      update(id, (j) => ({ ...j, reviewJob }));
    },

    setResearch(id: string, research: ResearchRecord): void {
      update(id, (j) => (j.kind === "research" ? { ...j, research } : j));
    },

    // The job API sent the runner tool to this research job (evidence that the runner's request reached ORBIT; not that it ran it).
    toolServed(id: string, sha256: string): void {
      const at = now().toISOString();
      update(id, (j) => (j.kind === "research" && j.research ? { ...j, research: { ...j.research, toolServed: j.research.toolServed ? { ...j.research.toolServed, lastAt: at, count: j.research.toolServed.count + 1 } : { firstAt: at, lastAt: at, count: 1, sha256 } } } : j));
    },

    // The runner fetched its research brief from the job API: evidence that it received it.
    briefServed(id: string, sha256: string): void {
      const at = now().toISOString();
      update(id, (j) => (j.kind === "research" && j.research ? { ...j, research: { ...j.research, briefServed: j.research.briefServed ? { ...j.research.briefServed, lastAt: at, count: j.research.briefServed.count + 1 } : { firstAt: at, lastAt: at, count: 1, sha256 } } } : j));
    },

    setToolCommit(id: string, toolCommit: string): void {
      const valid = normalizeToolCommit(toolCommit);
      if (valid) update(id, (j) => ({ ...j, toolCommit: valid }));
    },

    setLaunch(id: string, launch: Launch): void {
      update(id, (j) => ({ ...j, launch }));
    },

    // Flags a job that has not started within 10 minutes of launch, or has gone quiet for 15 minutes.
    // A recorded launch failure is shown only while the runner has said nothing: a fire whose answer was lost (a transport error after the
    // provider accepted it) can still start a runner, and once it reports, its own events are the evidence, not the lost answer.
    // "not-started" means no runner event yet. It never says whether a cloud session exists: see src/launch-evidence.ts for that.
    health(job: Job): "ok" | "not-started" | "quiet" | "finished" | "launch-failed" {
      if (job.launch?.failedAt && !job.events.length) return "launch-failed";
      if (job.state === "done" || job.state === "blocked" || job.state === "failed") return "finished";
      const t = now().getTime();
      if (!job.events.length) return job.launch && t - new Date(job.launch.at).getTime() > NOT_STARTED_AFTER_MS ? "not-started" : "ok";
      return job.lastEventAt && t - new Date(job.lastEventAt).getTime() > QUIET_AFTER_MS ? "quiet" : "ok";
    },

    get: find,
    list: (): Job[] => list().slice(-50).reverse(),
    // Every stored job, oldest first.
    all: (): Job[] => list(),

    status(): PortStatus {
      const active = list().filter((j) => (j.state === "registered" || j.state === "running") && !(j.launch?.failedAt && !j.events.length)).length;
      return {
        port: "jobs",
        state: store.persisted ? "live" : "degraded",
        impl: "job-api",
        detail: `${active} active cloud jobs.${store.persisted ? "" : " Not persisted: jobs are lost on restart."}${lastEventAt ? ` Last runner event ${lastEventAt}.` : ""}`,
        verifiedAt: now().toISOString(),
      };
    },
  };
}
