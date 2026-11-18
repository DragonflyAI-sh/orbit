import { rig } from "./threads-fixture.ts";

// A Jobs page with the shapes the page has to handle: a launch made through the real launcher (with its dispatch snapshot), a legacy
// launch without one, a job with a long timeline, steers in each state, a pull request, its review job, a research job, and many
// filler jobs for paging. Secret-shaped values are built at runtime, never written as literals.
export const SHA_A = "a".repeat(39) + "1";
export const SHA_B = "b".repeat(39) + "2";
export const SHA_C = "c".repeat(39) + "3";
export const fakeSecret = () => ["hunter", "2", "x".repeat(10)].join("");

export async function seededJobs(opts: { filler?: number; events?: number; dir?: string } = {}) {
  const r = rig({ dir: opts.dir });
  const jobs = r.jobs;
  const longBrief = [
    "Improve the jobs page so Rai can find any job quickly.",
    "",
    "## Steps",
    ...Array.from({ length: 60 }, (_, i) => `${i + 1}. Step ${i + 1}: do a careful thing <script>alert(${i})</script> and check https://github.com/DragonflyAI-sh/orbit/pull/${i + 1}.`),
    "",
    `A pasted credential that must never be shown: password=${fakeSecret()}`,
  ].join("\n");
  const launched = (await r.api("/jobs/launch", "POST", { routine: "orbit", brief: longBrief })).data as { id: string };
  const id = launched.id;
  jobs.record(id, { type: "started", sha: SHA_A, toolCommit: "9991f4adb81fc41b8fe2f55ff923484303f2bf6b" });
  for (let i = 1; i <= (opts.events ?? 230); i++) jobs.record(id, { type: "checkin", sha: SHA_B, text: i % 50 === 0 ? `Long check-in ${i}\n${"line of detail ".repeat(200)}` : `Check-in ${i}: working <b>bold</b> javascript:alert(1)` });
  jobs.steer(id, "Please also add tests.", { source: "owner" });
  jobs.steer(id, "And keep the layout responsive.", { source: "proposal", proposal: "11111111-2222-3333-4444-555555555555" });
  jobs.steer(id, "x".repeat(4500), { source: "owner" });
  jobs.acknowledge(id, [1, 2]);
  jobs.record(id, { type: "reply", n: 1, text: "Added tests." });

  // A finished job with a PR and a review job.
  const done = "orbit-202611100900-done";
  jobs.register(done);
  jobs.setLaunch(done, { routine: "orbit", at: "2026-11-10T09:00:00.000Z", branch: `orbit/${done}`, briefCommit: SHA_C, sessionId: "cse_done", sessionUrl: "https://claude.ai/code/cse_done", fireStartedAt: "2026-11-10T09:00:01.000Z", firedAt: "2026-11-10T09:00:02.000Z", toolCommitSent: SHA_A });
  jobs.record(done, { type: "started", toolCommit: SHA_A });
  jobs.record(done, { type: "summary", status: "done", sha: SHA_B, text: "## PR title\nJobs page: list and detail\n\n## PR body\nWhat changed and why, and how it was tested." });
  jobs.setPr(done, { at: "2026-11-10T10:00:00.000Z", url: "https://github.com/DragonflyAI-sh/orbit/pull/127", title: "Jobs page: list and detail", titleSource: "pr-title-section", total: 1, posted: 1 });
  const review = "orbit-202611101000-rvw1";
  jobs.register(review);
  jobs.setReview(review, { of: done, prUrl: "https://github.com/DragonflyAI-sh/orbit/pull/127", repo: "DragonflyAI-sh/orbit", reviewedSha: SHA_C, comment: { at: "2026-11-10T11:00:00.000Z", url: "https://github.com/DragonflyAI-sh/orbit/pull/127#issuecomment-99" }, verdict: "no blocking issues" });
  jobs.setReviewJob(done, { id: review, at: "2026-11-10T10:00:00.000Z", verdict: "no blocking issues", commentUrl: "https://github.com/DragonflyAI-sh/orbit/pull/127#issuecomment-99" });

  // A legacy launch: no dispatch snapshot, steers with no source, an unsafe recorded URL.
  const legacy = "orbit-202611010800-lgcy";
  jobs.register(legacy);
  jobs.setLaunch(legacy, { routine: "orbit", at: "2026-11-01T08:00:00.000Z", branch: `orbit/${legacy}`, briefCommit: SHA_A, sessionId: "cse_old", sessionUrl: "javascript:alert(1)" });
  jobs.setPr(legacy, { at: "2026-11-01T09:00:00.000Z", url: "https://evil.example/pull/1" });
  jobs.steer(legacy, "Legacy steer.");

  for (let i = 0; i < (opts.filler ?? 0); i++) {
    const fid = `filler-${String(i).padStart(3, "0")}`;
    jobs.register(fid);
    jobs.setLaunch(fid, { routine: i % 3 ? "orbit" : "money-noodle", at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
    if (i % 4 === 0) jobs.record(fid, { type: "summary", status: i % 8 ? "done" : "failed", text: `Filler ${i} finished.` });
  }
  return { r, id, done, review, legacy };
}
