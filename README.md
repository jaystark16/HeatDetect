# HeatDetect

**AI-based detection and classification of industrial fires and persistent thermal sources**

Smart India Hackathon 2026 · Problem **SIH26162** · National Technical Research Organisation (NTRO) · Theme: Disaster Management

---

## The problem

Satellite fire-monitoring systems can tell you *where* unusual heat is. They cannot tell you *what caused it*.

A thermal anomaly over a petrochemical complex might be a routine gas flare, a steel plant's process heat, or an accident in progress. NASA FIRMS reports the hotspot either way. The gap — deciding which — is what this project addresses.

HeatDetect enriches each satellite thermal detection with industrial infrastructure context, land cover, and **historical persistence**, then classifies the likely source and shows the reasoning on an interactive GIS dashboard.

### The core idea

A refinery flare and a refinery accident look nearly identical in a single satellite observation. What separates them is **time**:

- A **flare** is persistent, with a stable intensity baseline.
- An **accident** is a *deviation* from that baseline.

So the system builds a per-location thermal baseline from historical detections and scores each new observation against it. That ratio is the most important feature the classifier sees, and it is what the evidence panel leads with.

### Classes

| Class | Meaning |
|---|---|
| `industrial_fire` | Possible industrial fire — anomalous against an established baseline |
| `persistent_industrial` | Routine industrial thermal source (flaring, process heat) |
| `natural_fire` | Probable vegetation fire |
| `unknown` | Insufficient evidence to classify |

### On careful language

A thermal anomaly is **evidence of unusual heat, not proof of an accident or explosion**. The UI, the API and this README say "possible", "probable" and "candidate" deliberately. Satellite data at 375 m resolution cannot support facility-level attribution with certainty, and presenting it otherwise would be wrong.

---

## Architecture

```
NASA FIRMS (VIIRS/MODIS)
        │
        ▼
FastAPI ingestion ──► PostgreSQL + PostGIS ──► feature engineering
                                                      │
                                                      ▼
                                          Random Forest / XGBoost
                                                      │
                                                      ▼
                                              REST API (FastAPI)
                                                      │
                                                      ▼
                                      React + Leaflet dashboard
```

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + TypeScript + Leaflet |
| Backend | Python 3.13 + FastAPI |
| ML | scikit-learn / XGBoost (Phase 5) |
| Database | PostgreSQL + PostGIS on Neon (Phase 2) |
| Data | NASA FIRMS, OpenStreetMap, land cover |

### Hosting

| Part | Host | Notes |
|---|---|---|
| Dashboard | Cloudflare Pages | Static SPA |
| API | Render (free) | Blueprint in [`render.yaml`](render.yaml) |
| Database | Neon | Postgres with the PostGIS extension |
| Scheduling | GitHub Actions | Render's free tier has no cron |

---

## Running locally

Requires Python 3.13+ and Node 24+. No Docker needed.

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate      # Windows; use source .venv/bin/activate on macOS/Linux
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

API docs are then at http://127.0.0.1:8000/docs.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The dev server proxies `/api` to port 8000, so there is no CORS setup in development.

### Tests

```bash
cd backend && python -m pytest -q
cd frontend && npm run typecheck
```

---

## Sample data and the offline demo

With no `FIRMS_MAP_KEY` configured, the API serves a seeded set of eight realistic hotspots — Jamnagar, Vadinar, Talcher, Bhilai, Paradip, plus vegetation fires at Similipal and Bandipur and one deliberately ambiguous case near Visakhapatnam.

Two reasons this exists:

1. The dashboard and the deployment pipeline can be built and proven before ingestion lands.
2. **It is the demo's safety net.** If venue networking fails, the dashboard still has data.

Sample responses always report `data_source: "sample"`, and the UI shows a **◆ Sample data** chip. Seeded data can never be mistaken for live satellite observations.

---

## Secrets

The FIRMS key and the database URL live in `backend/.env` locally (gitignored) and in Render's environment settings in production. Neither is ever committed, and neither goes near frontend JavaScript — the FIRMS key is used only server-side.

CI enforces this: a job fails the build if a key-shaped string or a tracked `.env` appears in the repo.

---

## Build status

| Phase | Work | Status |
|---|---|---|
| 0 | Scaffold, sample API, dashboard, CI, deploy config | ✅ Done |
| 1 | FIRMS ingestion → database | Next |
| 2 | Neon Postgres + PostGIS schema | |
| 3 | OpenStreetMap industrial proximity enrichment | |
| 4 | Persistence engine (baseline + deviation) | |
| 5 | Train and serve the classifier | |
| 6 | Evidence and confidence surfacing | |
| 7 | Filters, timeline, analytics, export | |
| 8 | Alerts, polish, offline snapshot | |

---

## Design notes

**Class colours are validated, not chosen by eye.** The three hues are categorical slots from a palette checked for colourblind separation across all pairs (worst CVD ΔE 9.4 dark / 9.2 light; normal-vision ΔE 20.9 / 24.0). Mapping is semantic: blue reads as routine and stable, orange as hot and urgent, aqua as vegetation.

`unknown` has **no hue** — it renders as a hollow marker, because "unclassified" is the absence of a value rather than a fourth category. A grey fourth slot was tested and rejected: it measured ΔE 2.0 from the aqua under deuteranopia, meaning red-green colourblind viewers could not have told them apart.

Colour is never the only channel. Markers differ in fill treatment, the anomaly class carries a halo, the legend names every class in text, and the detail panel states the classification in words.

---

## References

- NASA FIRMS — https://firms.modaps.eosdis.nasa.gov/
- FIRMS API — https://firms.modaps.eosdis.nasa.gov/api/
- OpenStreetMap — https://www.openstreetmap.org/

Basemaps: Esri World Imagery and OpenStreetMap, both key-free.
