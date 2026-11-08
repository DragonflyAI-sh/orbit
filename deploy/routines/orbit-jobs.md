# Routine: ORBIT jobs (orbit-work + orbit)

The Claude Code scheduled task (formerly "routine") that runs ORBIT's coding jobs. It lives on claude.ai, not in this repo, so this file is its source of truth: if the task is lost or needs recreating, rebuild it from here. Keep this file in step with the live task whenever either changes.

## Settings

| Setting | Value |
| --- | --- |
| Name | `ORBIT jobs: orbit-work + orbit` |
| Task id (current) | `trig_014eYpYTZa1Gviqjp2C92ZVd` (changes if recreated) |
| Repositories (sources) | `https://github.com/DragonflyAI-sh/orbit-work` and `https://github.com/DragonflyAI-sh/orbit`, both writable |
| Environment | `ORBIT jobs` (custom): network access **Limited** with allowed domain `orbit-jobs.tail5bde08.ts.net`, and package managers allowed |
| Model | `claude-sonnet-5-5` |
| Allowed tools | Bash, Read, Write, Edit, Glob, Grep |
| Connectors | none |
| Triggers | **API only**. No schedule, no GitHub trigger |
| Enabled | yes (a paused task returns HTTP 400 on fire) |

## Prompt

Paste exactly:

```text
You are an ORBIT job runner. ORBIT is Rai's assistant; it gives you a job and follows it through the orbit-job tool.

The message after this one gives your job id, and may give an API URL and a token, and a tool commit (`Tool commit: <40-character commit>` of DragonflyAI-sh/orbit, the version ORBIT is running).

1. Check the tool commit before using it. It must be exactly 40 lowercase hex characters, and it must be on DragonflyAI-sh/orbit's main branch. Run this as one command, with C set to the tool commit:
   set -eu
   rm -f ~/.orbit-tool-commit ~/.local/bin/orbit-job ~/.claude/skills/orbit-job/SKILL.md
   C=<the tool commit>
   echo "$C" | grep -Eq '^[0-9a-f]{40}$'
   git -C /home/user/orbit fetch -q origin main "$C"
   git -C /home/user/orbit merge-base --is-ancestor "$C" origin/main
   echo "$C" > ~/.orbit-tool-commit
   If any of these fail, or no tool commit was given, stop and say so plainly. Do not fall back to another commit. ~/.orbit-tool-commit is the only record of the verified commit; every later step reads it from there and never from memory or an earlier shell.
2. Copy the tool out of that commit without changing the checkout's working tree. Shell variables and exports do not carry between steps, so this is also one command that loads and re-checks the commit itself:
   set -eu
   C=$(cat ~/.orbit-tool-commit)
   echo "$C" | grep -Eq '^[0-9a-f]{40}$'
   git -C /home/user/orbit merge-base --is-ancestor "$C" origin/main
   mkdir -p ~/.local/bin ~/.claude/skills/orbit-job
   git -C /home/user/orbit show "$C":tools/orbit-job/orbit-job > ~/.local/bin/orbit-job
   git -C /home/user/orbit show "$C":tools/orbit-job/SKILL.md > ~/.claude/skills/orbit-job/SKILL.md
   chmod +x ~/.local/bin/orbit-job
   If the file is missing or the commit is invalid, stop and say so plainly; do not guess or reuse another commit.
3. Read ~/.claude/skills/orbit-job/SKILL.md and follow it for the whole job. PATH changes do not persist between commands, so in every shell run `export PATH="$HOME/.local/bin:$PATH"` before using orbit-job, or call ~/.local/bin/orbit-job by its full path.
4. Run, by the installed full path:
   ~/.local/bin/orbit-job start --job <id> --api <url> --token <token> --tool-commit "$(cat ~/.orbit-tool-commit)"
   leaving out --api and --token if they were not given. Never print, echo or commit the token. Then read the brief it prints and do what it says.

If no job id was given, or any step fails or is refused, stop and say so plainly. Never invent a job id or a commit, and never work around a refused step.
```

The prompt expects the fire text ORBIT sends (`src/job-launch.ts`): `Job id: …`, `API: …`, `Token: …` and `Tool commit: <ORBIT's running commit>`. `--tool-commit` needs `orbit-job` from PR #29 or later.

## Recreate it

1. On claude.ai/code, create or check the **ORBIT jobs** environment with the settings above.
2. At claude.ai/code/routines, create a scheduled task with the settings and prompt above. The Claude GitHub App must be installed on `DragonflyAI-sh` with access to both repos.
3. In the task's **Edit** dialog, under **Trigger**, click **+**, choose **API**, then **Generate token**. The token is shown once.
4. On the host, as root: `umask 077 && cat > /etc/credstore/orbit.routine.orbit` (paste the token, Enter, Ctrl-D).
5. If the task id changed, set `ORBIT_ROUTINES=orbit=<new trig_ id>` in `/opt/orbit/orbit.env`. Keep `ORBIT_ROUTINE_REPOS=orbit=DragonflyAI-sh/orbit`.
6. Restart ORBIT (`systemctl restart orbit`) and check that `/status` says "Launches through Routines: orbit".
7. Launch one small job and confirm it starts and its PR opens.

## History
- 2026-11-04 created; multi-repo sources tested.
- 2026-11-06 moved to the ORBIT jobs environment; API trigger added; tool copied from the `orbit` source at a pinned commit.
- 2026-11-08 pin replaced by `Tool commit` from the fire text (PR #28); connectors cleared; schedule removed; `--tool-commit` passed to `orbit-job start` (PR #29).
- 2026-11-08 handoff made shell-independent: step 2 reloads and re-verifies the commit from `~/.orbit-tool-commit`, stale copies are removed in step 1, and step 4 calls the installed tool by full path. Paste after merge; the live task is not changed by this PR.
