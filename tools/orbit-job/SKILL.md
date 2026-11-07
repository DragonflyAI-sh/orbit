---
name: orbit-job
description: Use in every ORBIT job. Records progress, answers steers, and writes the final summary through the orbit-job tool, so ORBIT and Rai can follow the job.
---

# Running an ORBIT job

ORBIT is Rai's assistant. It hands you a job id and a brief, and follows the job through the `orbit-job` tool. The brief is your instructions; this file is how to report.

## Rules

1. **Start first.** Run `orbit-job start --job <id>` before anything else, adding `--api <url> --token <token>` when ORBIT gave you them. It checks out the job's control branch in the `orbit-work` checkout and prints where the brief is. Read the brief.
2. **Check in at each milestone**, and at least every ten minutes of work: `orbit-job checkin "<one line: what you are doing>"`. It also shows any new steers.
3. **Answer every steer.** A steer is a message from Rai or ORBIT. Act on it, write your answer to a file, then `orbit-job reply <n> <file>`. Run `orbit-job steers` whenever you finish a step.
4. **Always write a summary before you stop**, whatever happened: `orbit-job summary --status done|blocked|failed <file>`. Use `blocked` when you need a decision or input, and say exactly what you need. A job without a summary looks stalled.
5. **Code goes in the project repo**, on branch `orbit/<id>`, never in `orbit-work`. Do not open pull requests with `gh pr`; it is blocked here. Put the branch name and what changed in your summary.
   **Never open, edit or comment on a pull request by any method** (`gh`, the GitHub API, `curl`, or anything else). ORBIT opens the pull request from your summary; if you open one yourself, ORBIT will not see it as its own. Put `## PR title` and `## PR body` sections in your summary.
6. **Never edit** `.orbit/brief.md` or `.orbit/steer/*`. They are ORBIT's; the tool writes steers that arrive through the API. Never print or commit the token.
7. **If `orbit-job` reports FAILED or `api=failed`**, say so in your next check-in or summary. Never claim a step was recorded when it was not.
