# HeatDetect — roadmap

The team plan's MVP build order (PDF §12) and what is built against it, as of 2026-10-08.

## Plan phases

| # | Phase (plan) | Status | Notes |
|---|---|---|---|
| 1 | React/Leaflet map + sample data | ✅ 2026-09-18 | Sample data later deleted as fabricated; Leaflet replaced by MapLibre 2026-10-07 |
| 2 | FastAPI + PostgreSQL/PostGIS | ✅ changed | SQLite by default; Postgres path dialect-tested, never run live; no PostGIS by decision |
| 3 | Real FIRMS ingestion | ✅ 2026-09-18 | 60-day keyed backfill 2026-09-23; 3-hourly rebuild 2026-10-06 |
| 4 | OSM / industrial context | ✅ | 54 cached tiles; 84% of locations surveyed |
| 5 | Persistence calculation | ✅ | Window-relative thresholds since 2026-09-23 |
| 6 | ML classifier | ✅ | RandomForest `no_coords`; `industrial_fire` suppressed |
| 7 | AI explanation + confidence | ✅ | Template evidence; rule verdicts carry no probability by design; Ask tab 2026-10-07 |
| 8 | Polish, alerts, export, deployment | 🟡 partial | Pages live; see open items |

## Plan features (PDF §5) not yet built

As far as `frontend/src` shows on 2026-10-08:

- **Alert panel.** Flag high-priority events for investigation (also demo step 8).
- **Export.** CSV / GeoJSON / short report.
- **Filters by class and industrial type.** The map legend can isolate one
  class at a time (single-select), which is not a multi-class filter. The filter panel has time window, persistence (days) and FRP, but no
  industrial-type filter.

## Open engineering items

- [ ] Gemini on the public site. The owner adds the `GEMINI_API_KEY` secret; the build
      calls Gemini directly (the Cloudflare proxy was dropped on 2026-10-08).
- [ ] Decide on hosting the backend on Render. If hosting it, connect the Blueprint, set
      `API_BASE_URL`, and check that the API fits in 512 MiB with the 7.45 MiB model.
- [ ] Fix stale docs: the README "no LLM in this system" line, and the 2.4 MiB model-size
      comments in `.gitignore` / `render.yaml`.
- [ ] Consider trimming the model artifact (`n_estimators`, compression).
- [ ] Add rate limiting before any public API deployment.
- [ ] Authenticate any write endpoint (e.g. the plan's `POST /api/classify`) before it ships.

## Phase 2 ideas from the plan, deliberately parked

- An image/CNN model on patches around hotspots. Blocked: no reliable labelled image dataset.
- Weather context for ambiguous cases. The plan marks it optional, and nothing is ingested.
