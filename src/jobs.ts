import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Notifier } from "./notify.ts";
import type { PortStatus } from "./ports.ts";
import type { Store } from "./store.ts";

// Jobs run by Claude cloud runners. ORBIT registers a job, hands the runner a token that works for that job only,
// queues steers for it, and receives its events. The git record in orbit-work stays the source of truth.

// `text` on an event is for display and is clipped at MAX_TEXT; `textChars` is the length received and `textClipped` says it was
// clipped. The full final summary is kept on the job (Job.summary), not here.
export type JobEvent = { at: string; type: "started" | "checkin" | "reply" | "summary"; sha?: string; toolCommit?: string; n?: number; status?: string; text?: string; textChars?: number; textClipped?: boolean; via?: "api" | "git";
  // False when the sender says `text` is only the start of the real text (the runner's tool sends this when its summary is over the API size limit).
  textComplete?: boolean };
// The final summary as ORBIT holds it. complete: the whole text. partial: only the start arrived (API size limit); the full text is read from git and
// the PR and review wait for it. oversize: longer than MAX_SUMMARY_CHARS; only the first MAX_TEXT characters are kept here, the full text is in git.
export type SummaryRecord = { text: string; chars: number; state: "complete" | "partial" | "oversize"; via: "api" | "git"; at: string; sha?: string };
export type Steer = { n: number; text: string; at: string; deliveredAt?: string };
export type Launch = { routine: string; at: string; branch?: string; briefCommit?: string; sessionId?: string; sessionUrl?: string; failedAt?: string; error?: string;
  // Distinct words of the brief, for the duplicate-launch warning (src/duplicates.ts). Not the brief itself.
  briefWords?: string;
  // Vault context copied to the control branch at launch (src/job-context.ts): the paths, the commit that holds the copies, the
  // vault commit they were read at, and whether the vault fetch was fresh. Never the notes' text.
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
export type Job = {
  id: string;
  // Absent means `work`. A review job never opens a PR and never starts a review.
  kind?: "work" | "review";
  review?: ReviewOf;
  reviewJob?: ReviewOutcome;
  launch?: Launch;
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
  steers: Steer[];
};

// A reported tool commit is a full lowercase hex commit id; "unknown", missing and anything else are not recorded.
export function normalizeToolCommit(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 4000;
// The most of a final summary ORBIT keeps whole (about 3 GitHub comments). Longer is reported as oversize, never silently cut.
export const MAX_SUMMARY_CHARS = 200_000;
const KEEP_EVENTS = 200;
const KEEP_JOBS = 200;

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
    register(id: string, ttlMs = DEFAULT_TTL_MS): { job: Job; token: string } | { error: string } {
      if (!JOB_ID.test(id)) return { error: "Job ids are letters, digits, dot, underscore and dash, up to 64 characters." };
      const at = now();
      const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
      const existing = find(id);
      const job: Job = existing ? { ...existing, expiresAt } : { id, createdAt: at.toISOString(), expiresAt, state: "registered", events: [], steers: [] };
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
      const state: Job["state"] =
        event.type === "summary" && (event.status === "done" || event.status === "blocked" || event.status === "failed") ? event.status : "running";
      const reported = event.type === "started" ? normalizeToolCommit(event.toolCommit) : undefined;
      if (reported) clean.toolCommit = reported;
      else delete clean.toolCommit;
      // A later summary never replaces a complete one with a partial one.
      update(id, (j) => ({ ...j, ...(reported ? { toolCommit: reported } : {}), ...(summary && !(j.summary?.state === "complete" && summary.state !== "complete") ? { summary } : {}), state, lastEventAt: at, events: [...j.events, clean].slice(-KEEP_EVENTS) }));
      lastEventAt = at;
      if (event.type === "reply") notify.send(`Job ${id} replied to steer ${event.n}:\n\n${clean.text ?? "(see git)"}`, false);
      if (event.type === "summary") {
        const via = clean.via === "git" ? " (found in git; the API did not report it)" : "";
        const note = summary?.state === "partial" ? "\n\n(Only the start of the summary reached ORBIT over the API; ORBIT reads the full text from git before it opens the PR or posts a review.)" : summary?.state === "oversize" ? `\n\n(The summary is ${summary.chars} characters, over ORBIT's ${MAX_SUMMARY_CHARS}-character limit; ORBIT will not open a PR or post a review from it. The full text is in git.)` : clean.textClipped ? "\n\n(Clipped here; the complete summary is stored on the job.)" : "";
        notify.send(`Job ${id} finished: ${event.status}${via}.\n\n${clean.text ?? "(see git)"}${note}`, event.status !== "done");
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

    steer(id: string, text: string): Steer | undefined {
      const job = find(id);
      if (!job) return undefined;
      const steer: Steer = { n: job.steers.length + 1, text: text.slice(0, MAX_TEXT), at: now().toISOString() };
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

    setToolCommit(id: string, toolCommit: string): void {
      const valid = normalizeToolCommit(toolCommit);
      if (valid) update(id, (j) => ({ ...j, toolCommit: valid }));
    },

    setLaunch(id: string, launch: Launch): void {
      update(id, (j) => ({ ...j, launch }));
    },

    // Flags a job that has not started within 10 minutes of launch, or has gone quiet for 15 minutes.
    health(job: Job): "ok" | "not-started" | "quiet" | "finished" | "launch-failed" {
      if (job.launch?.failedAt) return "launch-failed";
      if (job.state === "done" || job.state === "blocked" || job.state === "failed") return "finished";
      const t = now().getTime();
      if (!job.events.length) return job.launch && t - new Date(job.launch.at).getTime() > 10 * 60_000 ? "not-started" : "ok";
      return job.lastEventAt && t - new Date(job.lastEventAt).getTime() > 15 * 60_000 ? "quiet" : "ok";
    },

    get: find,
    list: (): Job[] => list().slice(-50).reverse(),
    // Every stored job, oldest first.
    all: (): Job[] => list(),

    status(): PortStatus {
      const active = list().filter((j) => (j.state === "registered" || j.state === "running") && !j.launch?.failedAt).length;
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
