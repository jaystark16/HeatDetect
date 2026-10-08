# HeatDetect — project instructions

Shared instructions for every AI tool working in this repo (Claude Code, Antigravity,
Cursor, Codex, Gemini). Claude Code loads this through `CLAUDE.md`; other tools read
it directly. Keep tool-specific notes out of this file.

SIH26162: classify satellite thermal anomalies as industrial vs natural, and monitor
persistent thermal sources. The team's planning PDF is the product spec and the
source of truth for scope; measured deviations from it are recorded in
`docs/findings/` and `docs/adr/`. The PDF is not in the repo; the owner keeps it
locally as `SIH26162_Team_Project_Plan.pdf`.

## Context files — read before starting, update when things change

| File | What it holds |
|---|---|
| `SOUL.md` | Why the project exists, principles, tone, what it must never become |
| `CONTEXT.md` | Current status, constraints, what's next, open questions |
| `MEMORY.md` | Dated log of decisions, mistakes and discoveries (newest first) |
| `ARCHITECTURE.md` | Data flow, data layers, the Ask tab pipeline, ADR index |
| `DATA.md` | Sources, tables, labels, split, model card |
| `API.md` | Endpoints and how they map to the planning PDF |
| `DEPLOY.md` | Hosting, workflows, secrets by name, ruled-out hosts |
| `PITCH.md` | Problem statement, demo script, what we may and may not claim |
| `ROADMAP.md` | The PDF's build phases and what is still open |
| `GLOSSARY.md` | Domain terms (FRP, VIIRS, persistence, …) |

## The one rule that matters

**No evidence, no claim.** This project's failure mode is not a crash, it is a
confident sentence that isn't backed by data. Specifically:

- Never invent an observation, a statistic, a facility name, a confidence value or a
  metric. If a number is not computed from ingested data, it does not go in.
- Never let a fetch failure look like an absence of activity. Raise, don't return `[]`.
- Never label derived output as observed. Every record carries `kind`
  (`observed` / `derived` / `synthetic`) and a `dataset_id` from `app/datasets.py`.
- Never say an action succeeded because it was attempted. Report what came back:
  "returned 7,479 rows", not "successfully ingested".

A thermal anomaly is **evidence of unusual heat, not proof of a fire or accident**.
All user-facing copy stays hedged: "possible", "candidate", "consistent with".

## Architecture in one pass

```
FIRMS regional CSV (open, no key)  ─┐
OSM industrial + landuse (Overpass) ├─► SQLite/Postgres ─► features ─► classify ─► API ─► React/MapLibre
                                    ─┘                     (deterministic)  (rules + model)
```

- `app/datasets.py` — provenance catalogue. Every source declares licence and limitations.
- `app/ingest/firms.py` — FIRMS CSV client. Strict parsing, rejects counted by reason.
- `app/ingest/osm.py` — Overpass client with a committed tile cache and backoff.
- `app/geo.py` — pure geographic helpers (haversine, grid cells). No I/O.
- `app/features.py` — deterministic persistence statistics and spatial context.
- `app/labels.py` — the rule engine. Authoritative when history exists; explicit thresholds.
- `app/model.py` — single-observation classifier, feature schema, abstention, suppression.
- `app/train.py` — reproducible training, spatial split, ablation (`--ablation`).
- `app/evidence.py` — evidence sentences built from real values, via templates.
- `app/service.py` — data access plus the classification authority rules.
- `app/main.py` — routing and request validation only.
- `frontend/src/assistant/` — the Ask tab: the briefing and computed answers
  (deterministic), the citation gate, the Gemini client, and the offline in-browser model.
- `proxy/` — Cloudflare Worker holding the Gemini key; deployed by `assistant.yml`.
- `app/pipeline.py` — the CLI that runs ingestion, enrichment and feature stages.

**Deterministic logic owns facts.** Distances, persistence, counts, filtering and
thresholds are code, not model output. The model only estimates a class for a lone
detection with no history.

**No language model supplies a fact.** The Ask tab uses Google Gemini, with an
on-device model as offline fallback (ADR 0008). Code computes every value into a numbered
briefing (`frontend/src/assistant/briefing.ts`); the model must cite those facts in every
sentence, and `verify.ts` withholds any sentence whose numbers, names, source types,
comparisons or causes its cited facts do not support. Do not widen a model's role beyond
wording and reasoning over computed facts.

**How Gemini is reached.** Through the key-holding proxy (`proxy/`, ADR 0009) when the
`ASSISTANT_URL` variable is set. Without it, the public build calls Gemini straight from
the browser with the `GEMINI_API_KEY` secret injected at build time
(`frontend/src/assistant/direct.ts`). That puts the key in public JavaScript; the owner
chose this on 2026-10-08 to run without Cloudflare and accepts the risk. **No key may ever
be committed** (CI checks); it lives only in GitHub secrets.

## Empirical facts established by measurement

Do not re-litigate these from intuition; they were measured (see
`docs/findings/2026-09-18-feed-characterisation.md`):

- The open `/data/active_fire/` archives need **no MAP_KEY**. The `/api/` endpoints do.
- India-bbox 7-day volume is ~7,300 detections across ~2,700 distinct ~1 km cells;
  ~220 cells recur on 4+ distinct days (finding: 7,279 / 2,695 / 220, 26 on all
  seven; a later README run: 225 of 2,798, 37 on all seven).
- **Refinery gas flares are largely absent** from active-fire products. The detectable
  persistent sources are coal-seam fires (Jharia), coal/industrial belts and power
  stations. Scope claims accordingly.
- Real FRP is small: median ~1.6 MW, p99 ~18 MW. Do not write thresholds assuming
  hundreds of MW.
- Overpass rate-limits aggressively. **Never query it per hotspot.** Bulk-prefetch
  tiles into the database, then join locally.

## Commands

All backend commands run from `backend/` with that venv's interpreter.

```bash
# verify
python -m pytest -q                      # unit, integration, security, evals
python -m evals.run                      # behavioural report on its own
python -m app.train --ablation           # feature-set comparison, saves nothing

# pipeline (writes backend/data/heatdetect.db, which is NOT tracked)
python -m app.pipeline ingest --window 7d
python -m app.pipeline facilities        # Overpass prefetch; slow, resumable
python -m app.pipeline facilities --cache-only   # warm the cache without touching the DB
python -m app.pipeline features          # cell stats, context, labels
python -m app.train --feature-set no_coords
python -m app.pipeline status            # what is actually in the database

# serve
python -m uvicorn app.main:app --reload --port 8000
```

```bash
# repo root: regenerate the README metrics block from models/metrics.json
backend/.venv/Scripts/python scripts/sync_docs.py
backend/.venv/Scripts/python scripts/export_snapshot.py   # static snapshot for Pages
```

```bash
# frontend
cd frontend && npm run dev
cd frontend && npm run typecheck && npm run build
cd frontend && npm test                  # assistant intents and wording gate
```

## Conventions

- Python 3.13, type hints everywhere, `from __future__ import annotations`.
- SQLAlchemy Core (not the ORM) — the workload is bulk insert plus aggregate reads.
- Pydantic models in `app/schemas.py` mirror `frontend/src/types.ts`. Change both.
- Tests assert behaviour on real fixtures. A test that only checks that fabricated
  data is self-consistent is worse than no test — it manufactures confidence.
- Comments explain *why*, never *what*.
- The colourblind-safe palette is **not** a styling choice. Class hues are slots 1–3
  of a palette checked all-pairs for colour-vision-deficiency separation; `unknown`
  has no hue by design and renders hollow. Do not adjust it for looks.
- Never hand-edit the README metrics block; run `scripts/sync_docs.py`. CI fails on drift.
- Never copy model metrics into other docs. Point to the README block or
  `backend/models/metrics.json` instead; copied numbers went stale three times.

## Things that are deliberately not done

- No PostGIS. SQLite plus haversine and a grid index is sufficient at this volume
  and avoids a hosting dependency. `DATABASE_URL` switches to Postgres (psycopg 3);
  the schema and every query are dialect-tested in `tests/test_postgres_compat.py`,
  but **no query has been run against a live Postgres server**.
- No image/CNN model. There is no reliable labelled image dataset for this task.
- No authentication. The dashboard is public read-only. Any write endpoint must be
  protected before it ships.
