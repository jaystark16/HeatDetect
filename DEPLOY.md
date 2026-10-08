# HeatDetect — deployment

Current status (what is live, what isn't) is in `CONTEXT.md`. This page describes how
each piece deploys and what limits rule options out.

## Ruled out

- **Vercel and Supabase.** The owner has no project space left on either (2026-09-18).
  The plan PDF's "Vercel + Python cloud service" line is void.
- **PostGIS-dependent hosting.** Not needed: SQLite with a grid index is enough at this
  volume.
- **Anything that needs an AI tool to create an account or paste a key.** The owner does
  signups and secrets.

## Pieces

| Piece | Host | Defined in | Trigger |
|---|---|---|---|
| Dashboard + data refresh | GitHub Pages | `.github/workflows/pages.yml` | cron `17 */3 * * *`, push, manual |
| Backend API | Render free tier | `render.yaml` (Blueprint) | Connect the repo in the Render dashboard |
| Keep-warm ping | GitHub Actions | `.github/workflows/keep-warm.yml` | every 10 min; no-ops until `API_BASE_URL` is set |
| Assistant proxy | Cloudflare Workers | `.github/workflows/assistant.yml`, `proxy/` | changes under `proxy/`, manual |
| CI | GitHub Actions | `.github/workflows/ci.yml` | push / PR |

### GitHub Pages build

Each run rebuilds the database from scratch on the runner: open archives plus the
committed OSM cache, and a 60-day backfill when `FIRMS_MAP_KEY` is present. It then
exports `snapshot.json` and the per-location detail files (~19,900 files, ~60 MiB,
not committed) and publishes. Nothing is committed per run. A scheduled run whose
refresh fails deploys nothing, so the previous deployment stays live. Before publishing,
the deploy checks the snapshot invariants against the exact files it is about to ship.

### Render

The free plan has 512 MiB of RAM, so it runs with `--workers 1`. The build provisions its
own database (7-day ingest + features) because the DB is untracked and Render starts with
an empty disk. Health check: `/api/health`. No secrets are required. The free tier spins
down when idle, which is why keep-warm exists.

### CI gates (`ci.yml`)

- Backend: `pytest` and `evals.run`.
- Frontend: typecheck, test, build.
- Repository integrity: no committed API keys, no database URL with credentials, README
  metrics match the model (`sync_docs.py --check`), no tracked `.env`, and no fabricated
  sample-data module.

## Secrets and variables (names only)

| Name | Kind | Used by | Set? (2026-10-08) |
|---|---|---|---|
| `FIRMS_MAP_KEY` | secret | pages.yml backfill | ✅ |
| `CLOUDFLARE_API_TOKEN` | secret | assistant.yml | ❌ |
| `CLOUDFLARE_ACCOUNT_ID` | secret | assistant.yml | ❌ |
| `GEMINI_API_KEY` | secret | assistant.yml → Worker secret | ❌ |
| `API_BASE_URL` | variable | pages.yml (`VITE_API_BASE`), keep-warm.yml | ❌ |
| `ASSISTANT_URL` | variable | pages.yml (`VITE_ASSISTANT_URL`), assistant.yml (health check) | ❌ |
| `DATABASE_URL` | env | backend; switches to Postgres | not used |

Local-only, git-ignored: `proxy/.dev.vars` (`GEMINI_API_KEY`) and `frontend/.env.local`
(`VITE_ASSISTANT_URL`).

## Enabling the assistant proxy

Owner steps (full detail in `proxy/README.md`): create a Cloudflare API token and note
the account ID, create a fresh Gemini key, add the three secrets, run **Deploy assistant
proxy**, set `ASSISTANT_URL` to the printed Worker URL, and re-run the Pages workflow.
