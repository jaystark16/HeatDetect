# HeatDetect — API

FastAPI app in `backend/app/main.py` (routing and validation only). Every route is
**GET**: the API is public, read-only and unauthenticated. Interactive docs are at
`/docs` when the server runs (`python -m uvicorn app.main:app --reload --port 8000`
from `backend/`). Response models are in `app/schemas.py`, mirrored by
`frontend/src/types.ts`. Change both together.

## Endpoints

| Route | Purpose | Notable parameters |
|---|---|---|
| `GET /api/health` | Status. Returns 200 even when degraded; details are in `status` / `notes` | — |
| `GET /api/datasets` | Provenance catalogue (licence, limitations) | — |
| `GET /api/model-info` | Model version and recorded metrics | — |
| `GET /api/runs` | Ingest-run audit log | `limit` 1–200 |
| `GET /api/hotspots` | Detections with filters | `min_frp_mw`, `within_hours` (≤30 d), `min_distinct_days`, `confidence_tier`, `bbox`, `limit` ≤5000, `offset` |
| `GET /api/hotspots/{detection_id}` | Full detail: observation, history stats, context, classification, evidence | 404 if unknown |
| `GET /api/locations` | One row per ~1 km cell (what the map draws) | `min_frp_mw`, `min_distinct_days`, `within_hours`, `bbox`, `limit` ≤20000 |
| `GET /api/search` | Coordinates or a facility name | `q` (1–120 chars), `limit` ≤25 |
| `GET /api/analytics` | Dashboard totals | — |
| `GET /api/rules` | The label thresholds in force | — |

`bbox` is `min_lon,min_lat,max_lon,max_lat`. Result sizes and time ranges are bounded,
which caps the cost of each request. There is no rate limiting yet.

## Against the team plan (PDF §10)

| Planned route | Status |
|---|---|
| `GET /api/hotspots`, `/api/hotspots/{id}`, `/api/analytics`, `/api/model-info` | Implemented |
| `GET /api/history/{location}` | No route. Per-location history stats come back inside `/api/hotspots/{id}` |
| `GET /api/facilities/nearby` | No route. The nearest facility and the count of facilities within 5 km come back inside `/api/hotspots/{id}` (`context`), but not a list |
| `POST /api/classify` | Not built. A write-style endpoint needs authentication first |
| `POST /api/refresh-firms` | Not built. Refresh runs in CI (`pages.yml`, every 3 h) instead |

Added beyond the plan: `/api/locations`, `/api/search`, `/api/datasets`, `/api/rules`,
`/api/runs`, `/api/health`.

## Assistant proxy

`proxy/worker.mjs` (Cloudflare Worker) takes a briefing plus a question, calls Gemini
with the key held in Worker secrets, and returns a structured answer. Run it locally with
`node proxy/dev.mjs`; setup is in `proxy/README.md`.
