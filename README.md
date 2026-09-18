# HeatDetect

**AI-based detection and classification of industrial fires and persistent thermal sources**

Smart India Hackathon 2026 · Problem **SIH26162** · National Technical Research Organisation (NTRO) · Theme: Disaster Management

**Live dashboard: https://jaystark16.github.io/HeatDetect/**

---

## The problem

Satellite fire-monitoring tells you *where* unusual heat is. It does not tell you *what caused it*.

A thermal anomaly over an industrial area might be routine process heat, a long-burning coal seam, or an incident in progress. NASA FIRMS reports the hotspot either way. Closing that gap is what this project does.

HeatDetect ingests real NASA FIRMS active-fire detections, enriches each one with OpenStreetMap industrial context and **multi-day persistence statistics**, classifies the likely source, and shows the evidence behind every verdict.

## The core idea

A routine industrial thermal source and an incident at the same site look nearly identical in a single satellite observation. What separates them is **time**:

- A **persistent source** recurs across many days with a stable intensity baseline.
- An **incident** is a *deviation* from that baseline.

So the system computes a per-location baseline from its detection history and scores each observation against it. This follows the principle behind VIIRS Nightfire's flare/biomass separation — discriminate by temperature *and* persistence, not by brightness alone.

## What it can and cannot claim

This matters more than any feature, so it is stated up front.

**It can** detect and monitor coal-seam fires, coal-handling and mining areas, power stations and industrial belts. Measured over a 7-day window: **225 of 2,798 active locations recur on 4 or more distinct days**, 37 on all seven, and every persistent location checked had mapped industry within 5 km.

**It cannot** monitor refinery gas flaring. Zero detections landed within 5 km of the Jamnagar or Vadinar refineries in a 24-hour window, despite both being mapped in OSM. Active-fire products are tuned for biomass burning; flares are largely why VIIRS **Nightfire** exists as a separate product, and its full data requires a licence application.

**A thermal anomaly is evidence of unusual heat — not proof of a fire, an accident or an explosion.** All UI copy is hedged accordingly.

Full measurements: [`docs/findings/2026-09-18-feed-characterisation.md`](docs/findings/2026-09-18-feed-characterisation.md).

---

## Architecture

```
NASA FIRMS regional archives (open, no API key)
OpenStreetMap via Overpass (cached, committed)
          │
          ▼
   SQLite / Postgres          observed   detections, facilities, land_parcels
          │                   derived    cell_stats, cell_context, cell_labels
          ▼                   audit      ingest_runs
   deterministic features  ──► persistence baselines, spatial context
          │
          ├──► rule engine (authoritative when history exists)
          └──► RandomForest (single-observation fallback only)
          │
          ▼
   FastAPI  ──►  React + Leaflet dashboard
```

**Observed, derived and inferred data are physically separate** — different tables, different API objects, different visual treatment. A measurement can never be rendered as an inference by accident.

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + TypeScript + Leaflet |
| Backend | Python 3.13 + FastAPI + SQLAlchemy Core |
| ML | scikit-learn RandomForest |
| Database | SQLite by default; Postgres when `DATABASE_URL` is set |
| Data | NASA FIRMS, OpenStreetMap |

Current database: **7,479 detections** across **2,798 locations**, enriched with **39,204 industrial features** and **74,530 land parcels** from 53 cached OSM tiles. **2,432 of 2,798 locations (87%) have surveyed industrial context**; the remaining 366 report *not classified* rather than being assumed empty.

There is **no LLM in this system**, deliberately — see [ADR 0007](docs/adr/0007-no-llm.md). Evidence sentences are templates filled from computed values, so they cannot fabricate.

---

## How the classification works

Four classes: `industrial_fire`, `persistent_industrial`, `natural_fire`, `unknown`.

**Deterministic rules decide** any location with enough history, using published thresholds (`GET /api/rules`). A rule verdict carries **no probability** — a threshold comparison does not have one, and attaching a number to it would be inventing a statistic.

**The model only fills gaps.** It predicts from a single observation with no history features, and is consulted only where the rules abstain. It never overrides them.

**A class the model is measurably bad at is not reported.** Suppression reads the model's own recorded held-out precision; anything below 0.5 is downgraded to `unknown` with the measured figure recorded. A model carrying no metrics is trusted for nothing.

### Honest model performance

Spatial hold-out by 1° geographic block, so the same facility cannot appear in
both train and test. A random row split would leak badly — one coal-seam fire
contributes dozens of rows.

<!-- METRICS:START -->

Model `rf-20260918-no_coords-rule-v1-488beffa` · feature set `no_coords` · 4791 train / 1984 test rows across 116/50 geographic blocks.

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| `industrial_fire` ⚠ | 0.087 | 0.234 | 0.127 | 77 |
| `persistent_industrial` | 0.803 | 0.555 | 0.656 | 1196 |
| `natural_fire` | 0.904 | 0.972 | 0.937 | 282 |
| `unknown` ⚠ | 0.382 | 0.576 | 0.459 | 429 |

macro F1 **0.545**. Overall accuracy is deliberately not reported: the classes are heavily imbalanced, so a single figure would flatter the model while hiding that the rarest class performs worst.

⚠ marks classes below the 0.5 precision floor, which the API **suppresses** rather than reports: `industrial_fire` (precision 0.087), `unknown` (precision 0.382). Most such predictions would be wrong, so they are returned as *not classified* and findings for those classes come only from the deterministic rules.

Most influential features: `distance_to_facility_m` 0.270, `facilities_within_5km` 0.219, `land_cover_barren` 0.115, `land_cover_industrial` 0.058, `land_cover_unknown` 0.055.

*Labels are programmatic heuristics derived from multi-day persistence, not verified ground truth. These figures measure agreement with a documented rule set under a spatial hold-out — a consistency check, not validation against reality.*

<sub>Generated from `backend/models/metrics.json` by `scripts/sync_docs.py`. Do not edit by hand.</sub>

<!-- METRICS:END -->

Two caveats that belong beside those numbers:

1. **`natural_fire` scores are partly leakage, not skill.** The label requires a
   location to be more than 5 km from mapped industry, and the model is handed
   `distance_to_facility_m` directly. With proximity features removed its
   precision falls from 0.904 to 0.451 — that gap *is* the leakage.
2. **The `full` vs `no_coords` ordering is not stable.** Across three coverage
   levels the macro-F1 gap flipped sign twice (0.571→0.629, then 0.570→0.545).
   The difference is within noise and is not evidence for either. `no_coords`
   ships because it is the only configuration with non-zero `industrial_fire`
   recall and because it cannot memorise specific locations.

An ablation isolating how much is genuine thermal signal versus geography: [`docs/findings/2026-09-18-model-ablation.md`](docs/findings/2026-09-18-model-ablation.md). Headline: with **only** the ten thermal and geometry features — no proximity, no land cover, no coordinates — the model still reaches macro F1 0.416 against a four-class chance of about 0.25, and `persistent_industrial` F1 0.703. So the classifier is not purely a geography lookup, though context features roughly double its skill on the other classes.

---

## Running it

Requires Python 3.13+ and Node 24+. No Docker, no API keys, no hosting accounts.

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
```

Build the database from live sources:

```bash
python -m app.pipeline ingest --window 7d
python -m app.pipeline facilities
python -m app.pipeline features
python -m app.train --feature-set no_coords
python -m app.pipeline status
```

`ingest` takes seconds. `facilities` is slow and resumable — Overpass rate-limits hard, so it fetches the highest-value tiles first and can be re-run to extend coverage. The committed tile cache means it can be skipped entirely.

Serve:

```bash
python -m uvicorn app.main:app --reload --port 8000
```

Interactive API docs at http://127.0.0.1:8000/docs.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

http://localhost:5173. `/api` is proxied to port 8000, so there is no CORS setup in development.

### Tests and evaluation

```bash
cd backend
python -m pytest -q          # 174 tests
python -m evals.run          # 18 behavioural scenarios
```

The evaluation suite asserts properties under adverse conditions — malformed feeds, unreachable sources, stale data, hostile field values, injection attempts, ambiguous evidence, and false-success paths. `python -m app.train --ablation` reproduces the feature-set comparison.

---

## Provenance

`GET /api/datasets` returns every source with its licence, update frequency and **stated limitations**. The dashboard renders it under "Sources & model".

Every collection response carries a `provenance` block, and the UI distinguishes three states that are easy to conflate and damaging to confuse:

| State | Meaning |
|---|---|
| **● Live** | Newest detection is under 12 hours old |
| **◆ Historical** | Real data, but the newest record is older |
| **◆ Cached snapshot** | The API was unreachable; a committed snapshot is being shown |

Cached data is never described as live.

**Coverage is reported, not assumed.** A location whose industrial context has not been surveyed reports `not_surveyed` and is left unclassified. That is deliberately different from "no industry nearby" — treating a gap in our own collection as evidence of absence is the easiest way for a system like this to start lying.

---

## Deployment

| Part | Host | Status |
|---|---|---|
| Dashboard | GitHub Pages | Live, auto-deploys on push |
| API | Render (blueprint in [`render.yaml`](render.yaml)) | Not yet provisioned |
| Database | Neon Postgres via `DATABASE_URL` | Optional; SQLite works |

The deployed dashboard runs on the committed snapshot of real pipeline output, labelled as cached. It becomes live automatically once `VITE_API_BASE` points at a running API.

### Secrets

No credentials are required to run this project. `FIRMS_MAP_KEY` is supported but unnecessary — the regional archives are open. If a `DATABASE_URL` is used it lives in `backend/.env` (gitignored) or Render's environment. CI fails the build on a committed key, a credential-bearing URL, or a tracked `.env`.

Ingestion errors are stored verbatim for operators but **redacted at the API boundary**, so a failed database connection cannot leak a password through the public audit endpoint.

---

## What is deliberately not done

- **No PostGIS.** SQLite plus haversine and a grid index is sufficient at this volume and avoids a hosting dependency. `DATABASE_URL` switches to Postgres unchanged.
- **No image/CNN model.** There is no reliable labelled image dataset for this task, and inventing one would be worse than not having it.
- **No authentication.** The dashboard is public and read-only, and the API is GET-only. Any write endpoint must be authenticated before it ships.
- **No rate limiting.** Result sizes and time ranges are bounded, which caps per-request cost, but a public deployment should sit behind a rate limiter.
- **Land cover is approximate.** Nearest OSM parcel centroid within 2 km, not a containment test. A raster product such as ESA WorldCover would be materially better but requires registered access. Full geometry from Overpass measured 6.1 MiB for one 1° tile — roughly 1.8 GiB for India.

---

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — project conventions and the facts established by measurement
- [`docs/findings/`](docs/findings/) — measurements taken against live sources
- [`docs/adr/`](docs/adr/) — architecture decisions and their reasoning

## References

- NASA FIRMS — https://firms.modaps.eosdis.nasa.gov/
- OpenStreetMap — https://www.openstreetmap.org/ (© OpenStreetMap contributors, ODbL)
- Basemaps: Esri World Imagery and OpenStreetMap, both key-free
