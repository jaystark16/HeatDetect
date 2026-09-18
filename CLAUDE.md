# HeatDetect — project instructions

SIH26162: classify satellite thermal anomalies as industrial vs natural, and monitor
persistent thermal sources. `docs/SIH26162_spec.md` summarises the product spec; the
team's PDF is the source of truth for scope.

## The one rule that matters

**No evidence, no claim.** This project's failure mode is not a crash, it is a
confident sentence that isn't backed by data. Specifically:

- Never invent an observation, a statistic, a facility name, a confidence value or a
  metric. If a number is not computed from ingested data, it does not go in.
- Never let a fetch failure look like an absence of activity. Raise, don't return `[]`.
- Never label derived output as observed. Every record carries `kind`
  (`observed` / `derived` / `synthetic`) and a `dataset_id` from `app/datasets.py`.
- Never say an action succeeded because it was attempted. Report what came back:
  "returned 7,279 rows", not "successfully ingested".

A thermal anomaly is **evidence of unusual heat, not proof of a fire or accident**.
All user-facing copy stays hedged: "possible", "candidate", "consistent with".

## Architecture in one pass

```
FIRMS regional CSV (open, no key)  ─┐
OSM industrial + landuse (Overpass) ├─► SQLite/Postgres ─► features ─► classify ─► API ─► React/Leaflet
                                    ─┘                     (deterministic)  (rules + model)
```

- `app/datasets.py` — provenance catalogue. Every source declares licence and limitations.
- `app/ingest/` — one module per source. Strict parsing, counted rejects.
- `app/features/` — deterministic feature computation. No model here.
- `app/classify/rules.py` — authoritative when history exists. Transparent thresholds.
- `app/classify/model.py` — supervised model for the *single-observation* case only.
- `app/evidence.py` — evidence sentences built from real values, via templates.

**Deterministic logic owns facts.** Distances, persistence, counts, filtering and
thresholds are code, not model output. The model only estimates a class for a lone
detection with no history.

**There is no LLM in this system.** See `docs/adr/0007-no-llm.md`. Do not add one
without a concrete task an LLM does better than a deterministic function.

## Empirical facts established by measurement

Do not re-litigate these from intuition; they were measured (see
`docs/findings/2026-09-18-feed-characterisation.md`):

- The open `/data/active_fire/` archives need **no MAP_KEY**. The `/api/` endpoints do.
- India-bbox 7-day volume is ~7,300 detections; ~2,700 distinct ~1 km cells.
- **Refinery gas flares are largely absent** from active-fire products. The detectable
  persistent sources are coal-seam fires (Jharia), coal/industrial belts and power
  stations. Scope claims accordingly.
- Real FRP is small: median ~1.6 MW, p99 ~18 MW. Do not write thresholds assuming
  hundreds of MW.
- Overpass rate-limits aggressively. **Never query it per hotspot.** Bulk-prefetch
  tiles into the database, then join locally.

## Commands

```bash
# backend
cd backend && .venv/Scripts/python -m pytest -q          # tests
cd backend && .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# pipeline (writes to backend/data/heatdetect.db)
cd backend && .venv/Scripts/python -m app.pipeline ingest --window 7d
cd backend && .venv/Scripts/python -m app.pipeline facilities   # cached Overpass prefetch
cd backend && .venv/Scripts/python -m app.pipeline features
cd backend && .venv/Scripts/python -m app.classify.train

# evaluation
cd backend && .venv/Scripts/python -m evals.run

# frontend
cd frontend && npm run dev
cd frontend && npm run typecheck && npm run build
```

## Conventions

- Python 3.13, type hints everywhere, `from __future__ import annotations`.
- SQLAlchemy Core (not the ORM) — the workload is bulk insert plus aggregate reads.
- Pydantic models in `app/schemas.py` mirror `frontend/src/types.ts`. Change both.
- Tests assert behaviour on real fixtures. A test that only checks that fabricated
  data is self-consistent is worse than no test — it manufactures confidence.
- Comments explain *why*, never *what*.

## Things that are deliberately not done

- No PostGIS yet. SQLite + haversine is sufficient at this data volume and avoids a
  hosting dependency. `DATABASE_URL` switches to Postgres when it exists.
- No image/CNN model. There is no reliable labelled image dataset for this task.
- No authentication. The dashboard is public read-only. Any write endpoint must be
  protected before it ships.
