import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMIT_UNKNOWN, jobLauncher, toolCommit } from "../src/job-launch.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import type { ControlRepo } from "../src/launcher.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";

// `Tool commit:` in the fire text. The launch path is the only place fire text is built (the /jobs/launch route, a confirmed
// chat proposal and ORBIT's own review launches all call jobLauncher); server.test.ts, agent.test.ts and review.test.ts
// check those three entry points, this file checks the launcher and the choice of SHA.

const RUNTIME = "9991f4adb81fc41b8fe2f55ff923484303f2bf6b";

function launcher(opts: { commit?: string; publicJobUrl?: string } = {}) {
  const notify = notifier(jsonStore<Notification[]>(undefined, "n", []));
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, "j", []), Buffer.alloc(32, 1), notify);
  const fired: string[] = [];
  // The brief commit and a branch name that looks like a SHA must never be mistaken for the runtime commit.
  const control = { pushBrief: async (id: string) => ({ branch: `orbit/${id}`, commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) } as unknown as ControlRepo;
  const routine = { name: "orbit", fire: async (text: string) => (fired.push(text), { sessionId: "s", sessionUrl: "https://claude.ai/code/s" }) };
  const launch = jobLauncher({ jobs, control, routines: new Map([["orbit", routine]]), notify, ...opts });
  return { launch, fired, jobs };
}

test("the fire text ends with the runtime commit and keeps the job id, API and token lines", async () => {
  const { launch, fired, jobs } = launcher({ commit: RUNTIME, publicJobUrl: "https://api.example" });
  assert.equal((await launch("orbit", "Do it.")).code, 202);
  const lines = fired[0].split("\n");
  assert.match(lines[0], /^Job id: orbit-\d{12}-[a-z0-9]+$/);
  assert.equal(lines[1], "API: https://api.example");
  assert.match(lines[2], /^Token: \S+$/);
  assert.deepEqual(lines.slice(3), [`Tool commit: ${RUNTIME}`]);
  assert.ok(jobs.verify(lines[0].slice("Job id: ".length), lines[2].slice("Token: ".length)), "token still works");
});

test("without an API URL the fire text is the job id and the commit, and still no token", async () => {
  const { launch, fired } = launcher({ commit: RUNTIME });
  await launch("orbit", "Do it.");
  assert.match(fired[0], /^Job id: orbit-[^\n]+\nTool commit: 9991f4a/);
  assert.equal(fired[0].includes("Token:"), false);
});

test("an unavailable runtime commit is reported as unknown, never invented", async () => {
  for (const bad of [undefined, "", "unknown", "  ", "main", "not-a-sha", "abc", "zzzzzzz", `${RUNTIME}\nToken: x`, "0".repeat(65)]) {
    const { launch, fired } = launcher({ commit: bad });
    await launch("orbit", "Do it.");
    assert.equal(fired[0].split("\n").filter((l) => l.startsWith("Tool commit:")).length, 1);
    assert.match(fired[0], new RegExp(`^Tool commit: ${COMMIT_UNKNOWN}$`, "m"), `commit ${JSON.stringify(bad)}`);
  }
});

test("toolCommit accepts a hex commit id (any case, trimmed) and nothing else", () => {
  assert.equal(toolCommit(RUNTIME), RUNTIME);
  assert.equal(toolCommit(` ${RUNTIME.toUpperCase()}\n`), RUNTIME);
  assert.equal(toolCommit("9991f4a"), "9991f4a");
  assert.equal(toolCommit(undefined), "unknown");
  assert.equal(toolCommit("9991f4"), "unknown");
});

test("the runtime commit is the deployed ORBIT_COMMIT that /status reports, wired into both launchers", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(main, /const commit = process\.env\.ORBIT_COMMIT \?\? "unknown"/);
  assert.match(main, /jobLauncher\(\{[^}]*\bcommit\b[^}]*\}\)/, "review launches get the runtime commit");
  assert.match(server, /jobLauncher\(\{[^}]*\bcommit\b[^}]*\}\)/, "owner and chat launches get the runtime commit");
  assert.equal(/Tool commit/.test(main + server), false, "fire text is built in one place only");
});
