import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chatTools } from "../src/chat-tools.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import { notifier } from "../src/notify.ts";
import { jsonStore } from "../src/store.ts";

test("job_launch tells the model which standing constraints every brief carries", () => {
  const notify = notifier(jsonStore(undefined, "n", []));
  const tools = chatTools({
    memory: {} as never,
    toolbox: {} as never,
    jobs: jobRegistry(jsonStore(undefined, "j", []), Buffer.alloc(32, 1), notify),
    notify,
    proposals: {} as never,
    launchable: () => ({ routines: [] }),
  });
  const text = tools.find((t) => t.name === "job_launch")!.description;
  for (const needle of ["orbit/<job-id>", "never open, edit or comment on a pull request", "## PR title", "## PR body", "typecheck", "tests", "no secrets"]) {
    assert.ok(text.toLowerCase().includes(needle.toLowerCase()), `description mentions ${needle}`);
  }
});

test("the runner skill forbids opening, editing or commenting on a pull request by any method", () => {
  const skill = readFileSync(new URL("../tools/orbit-job/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /Never open, edit or comment on a pull request by any method/);
  for (const m of ["gh", "GitHub API", "curl"]) assert.ok(skill.includes(m));
  assert.match(skill, /ORBIT opens the pull request from your summary/);
});

test("the runner skill carries the secret-literal and gitleaks pre-push rules", () => {
  const skill = readFileSync(new URL("../tools/orbit-job/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /Never write secret-shaped literals in any file, tests included/);
  assert.match(skill, /every commit in a PR/);
  assert.match(skill, /ghcr\.io\/gitleaks\/gitleaks:v8\.30\.1 git \/repo --redact -v --log-opts=HEAD \./);
  assert.match(skill, /report the actual failure/);
  assert.match(skill, /Do not weaken scanning or add exemptions/);
});
