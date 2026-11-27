# ORBIT's persona

Everything that makes this instance ORBIT rather than the bare platform (`DragonflyAI-sh/agent-platform`):

| File | What it sets |
| --- | --- |
| `persona.json` | Name, expansion, owner, time zone, default port (8790) and job-listener port (8791), browser theme colors |
| `personality.md` | The first lines of every system prompt: identity and voice |
| `avatar.png` | Logo, favicon and reply icon |
| `theme.css` | Optional CSS custom properties layered over the base palette (ORBIT uses the base palette as is) |

The platform loads this directory at startup (`src/persona.ts`); `PERSONA_DIR` points elsewhere. Everything outside `persona/`
and the instance files listed in `INSTANCE_FILES` comes from the platform at the commit in `PLATFORM_COMMIT` and is replaced by
`tools/sync-platform.sh`, so change platform code in the platform repo, not here.
