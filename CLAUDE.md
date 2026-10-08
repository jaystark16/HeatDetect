# HeatDetect — Claude Code entry point

HeatDetect is the team's Smart India Hackathon 2026 entry for problem SIH26162 (NTRO,
Disaster Management). It ingests real NASA FIRMS thermal detections, enriches them
with OpenStreetMap industrial context and multi-day persistence, classifies the likely
source (industrial fire / persistent industrial / natural fire / unknown), and shows
the evidence on a MapLibre dashboard live at https://jaystark16.github.io/HeatDetect/.

The project rules, architecture summary, commands and conventions live in `AGENTS.md`
so every AI tool reads the same instructions. Don't duplicate them here.

@AGENTS.md
@SOUL.md
@CONTEXT.md

## Claude Code specifics

- `.claude/launch.json` defines two preview servers: `frontend` (Vite dev, port 5173)
  and `pages-preview` (the built site under `/HeatDetect/`, port 4173). Start them with
  the preview tools, not raw shell.
- Read the add-on files listed in `AGENTS.md` only when the task touches them
  (`DATA.md` for model work, `DEPLOY.md` for hosting, `PITCH.md` for demo copy).
- After a change that alters status, numbers or decisions, update `CONTEXT.md` and
  add a dated entry to `MEMORY.md`, and say so in one line.
