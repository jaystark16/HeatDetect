# HeatDetect — current context

Verified against the repository and the running system on **2026-10-08**, not recalled
from memory. The pipeline appends continuously, so counts grow. Permanent rules are in
`AGENTS.md` and `SOUL.md`; history is in `MEMORY.md`.

**Repository:** https://github.com/jaystark16/HeatDetect
**Live dashboard:** https://jaystark16.github.io/HeatDetect/ (static, rebuilt every 3 hours)

## Competition

- **Smart India Hackathon 2026, problem SIH26162**: "AI-Based Detection and
  Classification of Industrial Fires and Persistent Thermal Sources". Organisation NTRO,
  category Software, theme Disaster Management. The title, category, deliverables and
  roles come from the team plan PDF, which isn't in the repo.
- Preparing for **round 2**. Dates not announced.
- Expected deliverables (from the problem statement, via the team plan): (1) segregate
  industrial fires from forest and other natural fires; (2) a GIS solution that stores
  results and shows them as map overlays.
- Team roles in the plan: AI/ML, GIS/Data, Backend, Frontend, Integration/Testing,
  Presentation/Research.

## Constraints

- **Hosting:** Vercel and Supabase are out. The owner has no project space left on
  either (as of 2026-09-18), so the plan PDF's "Vercel + Python cloud service" line is
  void. Free tiers only: GitHub Pages (live), Render (blueprint ready), Cloudflare
  Workers (proxy). See `DEPLOY.md`.
- **Accounts and secrets are the owner's to create.** No AI tool signs up for services
  or handles keys. List the needed secret by name and ask.
- **No credentials needed to run.** The FIRMS regional archives are open, and the OSM
  tile cache is committed. `FIRMS_MAP_KEY` is only for the 60-day backfill.
- **No ground truth exists.** VIIRS Nightfire needs a licence application, so all metrics
  measure agreement with a documented heuristic.

## Current state at a glance

| | |
|---|---|
| Detections ingested | **61,397** |
| Locations (~1 km cells) | **19,889** |
| Detection window | 2026-07-25 → 2026-10-06 (~73 days) |
| OSM facilities / land parcels | 39,493 / 74,955 (54 cached tiles, 1.7 MB) |
| Locations with surveyed industrial context | **16,715 of 19,889** (84%) |
| Backend tests / frontend tests / eval scenarios | **291** / **90** / **18** |
| Live site | HTTP 200, auto-rebuilt every 3 h |

**Label distribution (locations):** `natural_fire` 10,140 · `unknown` 9,528 ·
`persistent_industrial` 206 · `industrial_fire` 15.

**Shipped model:** `rf-20261008-pass_context-rule-v1-0a2fe936` (feature set
`pass_context`, retrained 2026-10-08). Its per-class metrics
are in the README's generated block; don't copy them here. Current headline:
`industrial_fire` has zero precision from the model, so it is suppressed and findings for
that class come only from the rules.

## What is deployed, and what is not

Check this before claiming anything works.

| Component | Status |
|---|---|
| Dashboard (GitHub Pages) | ✅ Live, rebuilt from FIRMS every 3 hours |
| Data refresh in CI | ✅ `FIRMS_MAP_KEY` secret is set, so each run backfills 60 days |
| Backend API (Render) | ❌ Not deployed. No `API_BASE_URL` variable, so the site serves the committed snapshot |
| Assistant proxy (Cloudflare) | ✅ Deployed 2026-10-23 at `https://heatdetect-assistant.jay16marvel-708.workers.dev`. `/health` returned `ollama: true, gemini: false`; a live `/ollama/chat` call answered with gpt-oss:120b. The public site uses it since 2026-10-23 (`ASSISTANT_URL` set) |
| Gemini on the public site | Needs the `GEMINI_API_KEY` secret, which the owner sets. Without it the Ask tab answers from keywords only. With it, Gemini researches any question over all locations (tools, conversation memory) — verified locally 2026-10-09 |

Configured: secrets `FIRMS_MAP_KEY`, `OLLAMA_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; variable `ASSISTANT_URL` (all 2026-10-23).

## In progress / next

See `ROADMAP.md` for the full list. Most pressing:

1. Tighten the Ask tab's analysis sentences. Live test 2026-10-23: every number matched a
   recount, but two deep-mode sentences passed the gate while overreaching: the rules'
   classification "aligns with the classifier's precision" (those metrics measure agreement
   with the rules), and "seasonal fire activity" (a cause no fact states). The brief and
   deep answers also used slightly different Gujarat boxes (70 vs 91 vegetation fires).
2. Decide whether to host the backend on Render (`render.yaml` is ready) or keep the
   static snapshot for the demo.
3. Fill the plan PDF's Phase 8 gaps: alert panel and CSV/GeoJSON/report export.
4. Fix docs that went stale (2026-10-08):
   - README still says "There is no LLM in this system", but the Ask tab uses Gemini.
   - `.gitignore` and `render.yaml` describe the model as 2.4 MiB; it is 7.45 MiB.

## Open questions

- When are the round 2 dates, and what are the judging criteria? Neither is recorded yet.
- Who on the team owns each role from the plan?
- Is the 7.45 MiB model artifact worth trimming (`n_estimators`, compression)?
- Does the 512 MiB Render free tier hold the API with this model loaded? Not measured.
