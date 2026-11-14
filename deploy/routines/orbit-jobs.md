# Routine: ORBIT jobs (orbit-work + orbit)

The Claude Code scheduled task (formerly "routine") that runs ORBIT's coding jobs. It lives on claude.ai, not in this repo, so this file is its source of truth: if the task is lost or needs recreating, rebuild it from here. Keep this file in step with the live task whenever either changes.

## Settings

| Setting | Value |
| --- | --- |
| Name | `ORBIT jobs: orbit-work + orbit` |
| Task id (current) | `trig_014eYpYTZa1Gviqjp2C92ZVd` (changes if recreated) |
| Repositories (sources) | `https://github.com/DragonflyAI-sh/orbit-work` and `https://github.com/DragonflyAI-sh/orbit`, both writable; plus `https://github.com/phairow/orbit-vault` as a third source, read-only context only (see [Vault source](#vault-source-read-only-context)) |
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

1. Check the tool commit before using it. It must be exactly 40 lowercase hex characters, and it must be on DragonflyAI-sh/orbit's main branch:
   C=<the tool commit>
   rm -f ~/.orbit-tool-commit &&
   echo "$C" | grep -Eq '^[0-9a-f]{40}$' &&
   git -C /home/user/orbit fetch -q origin main "$C" &&
   git -C /home/user/orbit merge-base --is-ancestor "$C" origin/main &&
   echo "$C" > ~/.orbit-tool-commit
   If any of these fail, or no tool commit was given, stop and say so plainly. Do not fall back to another commit.
2. Each step runs in a fresh shell: variables and PATH from earlier steps are gone. Copy the tool out of the commit saved by step 1, without changing the checkout's working tree:
   C="$(cat ~/.orbit-tool-commit)" && echo "$C" | grep -Eq '^[0-9a-f]{40}$' &&
   mkdir -p ~/.local/bin ~/.claude/skills/orbit-job &&
   git -C /home/user/orbit show "$C":tools/orbit-job/orbit-job > ~/.local/bin/orbit-job &&
   git -C /home/user/orbit show "$C":tools/orbit-job/SKILL.md > ~/.claude/skills/orbit-job/SKILL.md &&
   chmod +x ~/.local/bin/orbit-job
   If any of these fail, stop and say so plainly.
3. Read ~/.claude/skills/orbit-job/SKILL.md and follow it for the whole job.
4. Run:
   ~/.local/bin/orbit-job start --job <id> --api <url> --token <token> --tool-commit "$(cat ~/.orbit-tool-commit)"
   leaving out --api and --token if they were not given. Never print, echo or commit the token. Then read the brief it prints and do what it says. Run every later orbit-job command as ~/.local/bin/orbit-job, since PATH is not carried between shells.

If no job id was given, or any step fails or is refused, stop and say so plainly. Never invent a job id or a commit, and never work around a refused step.
```

The prompt expects the fire text ORBIT sends (`src/job-launch.ts`): `Job id: …`, `API: …`, `Token: …` and `Tool commit: <ORBIT's running commit>`. `--tool-commit` needs `orbit-job` from PR #29 or later.

## Vault source (read-only context)

Added to the live task on 2026-11-12 (Rai approved the third source and chose the folder-style checkout below). This section is the source of truth for it; the live task was configured separately, and nothing in this file changes it.

| Setting | Value |
| --- | --- |
| Source | `https://github.com/phairow/orbit-vault` |
| Checkout location | `/home/user/orbit-vault` |
| Sparse checkout paths | `["AGENTS.md","System/","Projects/orbit-next.md","Resources/orbit-next-*","Tasks/orbit-next-*"]`, exactly as written: no leading `/` (a leading `/` is rejected as invalid and fails every run), and the odd-looking file and wildcard entries are intentional, see below |
| Role | **Read-only context.** The job's outcomes stay `orbit-work` and `orbit` only. A job never commits to or pushes the vault; ORBIT alone writes the vault (`docs/vault-writes.md`). The skill forbids it. Whether the source's token could push is not verified here, so the rule, not the permission, is what protects the vault |
| Prompt | Unchanged. The vault rules reach the runner through the `orbit-job` skill it copies from the tool commit (`tools/orbit-job/SKILL.md`, "Vault context") |

### What the sparse paths actually check out

Checkout is git **cone mode**, whose patterns are directory names, not file patterns. Observed on the live task (2026-11-12) and reproduced with a synthetic repository in `test/sparse-checkout.test.ts` (git 2.43, `git sparse-checkout set --skip-checks <paths>`; plain `set` with these paths refuses them as "patterns"):

- **Checked out:** every file in the repository root (`AGENTS.md`, `README.md`, `CLAUDE.md`, `home.md`, `now.md`, and so on); `System/` and everything below it; and the **top-level files only** of `Projects/`, `Resources/` and `Tasks/`.
- **Not checked out:** any subfolder of `Projects/`, `Resources/` or `Tasks/`, and every other folder: `Journal/`, `Memory/`, `Log/`, `Inbox/`, `Machines/`, `Areas/`, `Archive/`, `Attachments/`, `Reviews/`, `scripts/`.
- `Projects/orbit-next.md`, `Resources/orbit-next-*` and `Tasks/orbit-next-*` are taken as directory names that do not exist, so they select nothing by themselves; their effect is only that their parent folders appear at top level. The narrower reading the names suggest (only `orbit-next` notes) is **not** what is checked out: all top-level notes in those three folders are.
- Why not a plain folder list: `["System/","Projects/","Resources/","Tasks/"]` is also valid, but in cone mode it checks out those folders **recursively**, including every `Resources/` subfolder (531 files in the vault when measured), so the odd list was kept to leave subfolders out.
- Not what the paths read as: a non-cone checkout (`git sparse-checkout set --no-cone`) with the same paths would check out exactly the six `orbit-next`-style paths. That would be narrower than the configuration Rai chose; it is reported here as a discrepancy with the wording, not applied. Changing the live configuration is Rai's decision.

This checkout is the **only** way a runner sees the vault. ORBIT does not read or copy vault notes at launch (launch-time export was removed; `docs/job-context.md`). A brief that relies on a note names its exact path, and the runner reads it from `/home/user/orbit-vault` under the skill's rules. Because the checkout lags the vault and leaves out most of it, a named note can be absent: the runner then reports it as missing and never guesses its content. A brief should therefore only rely on notes inside the checked-out set above; widening the sparse paths is a live configuration change for Rai to make, not something a job or ORBIT does.

## Recreate it

1. On claude.ai/code, create or check the **ORBIT jobs** environment with the settings above.
2. At claude.ai/code/routines, create a scheduled task with the settings and prompt above. The Claude GitHub App must be installed on `DragonflyAI-sh` with access to both repos.
3. In the task's **Edit** dialog, under **Trigger**, click **+**, choose **API**, then **Generate token**. The token is shown once.
4. On the host, as root: `umask 077 && cat > /etc/credstore/orbit.routine.orbit` (paste the token, Enter, Ctrl-D).
5. Add the third source from [Vault source](#vault-source-read-only-context) with its sparse paths (no leading `/`).
6. If the task id changed, set `ORBIT_ROUTINES=orbit=<new trig_ id>` in `/opt/orbit/orbit.env`. Keep `ORBIT_ROUTINE_REPOS=orbit=DragonflyAI-sh/orbit`.
7. Restart ORBIT (`systemctl restart orbit`) and check that `/status` says "Launches through Routines: orbit".
8. Launch one small job and confirm it starts, that `/home/user/orbit-vault` exists with only the checked-out set above, and that its PR opens.

## History
- 2026-11-04 created; multi-repo sources tested.
- 2026-11-06 moved to the ORBIT jobs environment; API trigger added; tool copied from the `orbit` source at a pinned commit.
- 2026-11-08 pin replaced by `Tool commit` from the fire text (PR #28); connectors cleared; schedule removed; `--tool-commit` passed to `orbit-job start` (PR #29).
- 2026-11-08 every step made self-contained for separate shells (commit re-read from `~/.orbit-tool-commit`, tool run by its home path).
- 2026-11-12 `phairow/orbit-vault` added as a third, read-only source with sparse paths (cone-mode semantics observed and recorded above); launch-time vault context copies (`docs/job-context.md`).
- 2026-11-14 launch-time vault context copies removed; the read-only checkout is the only runner-side vault access (`docs/job-context.md`). No change to the live configuration was needed for this.
