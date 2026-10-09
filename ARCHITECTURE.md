# HeatDetect — architecture

Module-by-module responsibilities are in `AGENTS.md`. This page holds the data flow and
the decisions behind it.

## Data flow

```
NASA FIRMS regional archives (open, no key)  ─┐
NASA FIRMS /api/area (keyed, backfill only)   │
OpenStreetMap via Overpass (cached, committed)┴─► SQLite / Postgres
                                                      │
          observed  detections, facilities, land_parcels
          derived   cell_stats, cell_context, cell_labels
          audit     ingest_runs
                                                      ▼
                            deterministic features (persistence, context)
                                                      │
                     ┌────────────────────────────────┴───────────┐
                     ▼                                            ▼
          rule engine (authoritative)            RandomForest (single-observation only)
                     └────────────────────────────────┬───────────┘
                                                      ▼
                                      FastAPI ──► React + MapLibre dashboard
                                                      │
                                                      └──► Ask tab (Gemini via proxy)
```

**Observed, derived and inferred data are physically separate:** different tables,
different API objects, different visual treatment. A measurement can't be rendered as
an inference by accident.

## Two ways the dashboard gets data

- **With an API** (`VITE_API_BASE` set at build from the `API_BASE_URL` variable): it
  calls FastAPI.
- **Without one** (the current live site): it loads `frontend/public/snapshot.json` plus
  per-location detail files that `scripts/export_snapshot.py` writes during each Pages
  build. With no API configured, the static build makes no `/api/*` requests.

## Classification authority

1. No surveyed industrial context → `not_surveyed`, never classified.
2. Enough history → **rules decide**, with no probability attached.
3. Otherwise → the single-observation model, which may abstain. Classes below the
   precision floor are suppressed to `unknown`.

The model never overrides a rule verdict. Evidence sentences come from templates
(`app/evidence.py`) filled with computed values.

## Ask tab (assistant)

```
question + conversation so far + briefing.ts (~75 numbered computed facts)
   │
   ▼  1. research (gemini.ts askAgent): Gemini calls tools (tools.ts) as needed
      search_locations  — every location, by class, days seen, peak FRP, recency,
                          an area box (a named place = Gemini's approximate box,
                          labelled as such) or a point and radius
      location_detail   — the full evidence for the location nearest a point
      code runs each over all loaded locations → more numbered facts
   ▼  2. answer: Gemini writes a natural reply from all the facts, citing them
   ▼
verify.ts (verifyCited): every sentence must cite facts that support its numbers,
names, source types, comparisons and causes; certainty words are refused; failing
sentences are withheld with the reason shown

transport: direct.ts (browser, key from the GEMINI_API_KEY secret at build) or
proxy/worker.mjs (when ASSISTANT_URL is set). Fallbacks if Gemini cannot answer:
on-device Qwen3-1.7B (opt-in, ~940 MB), then the computed answer alone.
```

Questions are open-ended: the briefing is a summary, not a limit. Each fallback says why it
happened. CI fails if a Google key pattern is committed.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + TypeScript + MapLibre GL (globe, optional 3D terrain, Esri imagery) |
| Backend | Python 3.13 + FastAPI + SQLAlchemy Core |
| ML | scikit-learn RandomForest |
| Database | SQLite by default; Postgres via `DATABASE_URL` (psycopg 3), dialect-tested but never run live |
| Assistant | Gemini via Cloudflare Worker; Qwen3-1.7B on-device fallback |

## Decisions (`docs/adr/`)

ADRs 0005 and 0006 were never written.

| ADR | Decision | Why it matters |
|---|---|---|
| 0001 | Open FIRMS regional archives, not the keyed API | Runs with no credentials; the key is only for backfill |
| 0002 | Data sources, and what we deliberately skip | No Nightfire (licence); land cover is approximate |
| 0003 | RandomForest, not XGBoost or HistGradientBoosting | Not XGBoost: one fewer compiled dependency. Not HistGradientBoosting: RF exposes the feature importances the ablation needed |
| 0004 | Labelling by information asymmetry | Labels use history, the model sees one observation, so there is no circularity |
| 0007 | No LLM in the pipeline | Every candidate LLM feature lost to a deterministic function |
| 0008 | On-device assistant that words answers but never supplies facts | Narrows 0007 for one genuine language task |
| 0009 | Gemini through a key-holding proxy, citing every fact | Measured: the 1.7B model built untrue claims from true numbers |

ADR 0007 still stands. The pipeline has no LLM, and 0008/0009 only cover the wording layer.
