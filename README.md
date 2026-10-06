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

**It can** detect and monitor coal-seam fires, coal-handling and mining areas, power stations and industrial belts. Measured on 18 September over the 7-day archive window: **225 of 2,798 active locations recurred on 4 or more distinct days**, 37 on all seven, and every persistent location checked had mapped industry within 5 km. Over the 61-day backfilled window the most persistent sources are all named heavy industry — ArcelorMittal Nippon Steel at Hazira, the Jharia BCCL coal clusters, JSW Vijayanagar.

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
   FastAPI  ──►  React + MapLibre dashboard
```

**Observed, derived and inferred data are physically separate** — different tables, different API objects, different visual treatment. A measurement can never be rendered as an inference by accident.

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + TypeScript + MapLibre GL (globe, WebGL) |
| Backend | Python 3.13 + FastAPI + SQLAlchemy Core |
| ML | scikit-learn RandomForest |
| Database | SQLite by default; Postgres when `DATABASE_URL` is set |
| Data | NASA FIRMS, OpenStreetMap |

As of 6 October 2026 a local build holds **61,397 detections** across **19,889 locations** (25 July – 6 October), enriched with **39,493 industrial features** and **74,955 land parcels** from 54 cached OSM tiles. **16,715 of those locations (84%) have surveyed industrial context**; the rest report *not classified* rather than being assumed empty. The deployed dashboard rebuilds every 3 hours, so its own counts move with the data — the stats bar shows the current ones.

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

Model `rf-20260923-no_coords-rule-v1-b9e6ab4c` · feature set `no_coords` · 22360 train / 13572 test rows across 139/60 geographic blocks.

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| `industrial_fire` ⚠ | 0.000 | 0.000 | 0.000 | 214 |
| `persistent_industrial` | 0.744 | 0.747 | 0.745 | 3760 |
| `natural_fire` | 0.813 | 0.999 | 0.897 | 4977 |
| `unknown` | 0.730 | 0.578 | 0.645 | 4621 |

macro F1 **0.572**. Overall accuracy is deliberately not reported: the classes are heavily imbalanced, so a single figure would flatter the model while hiding that the rarest class performs worst.

⚠ marks classes below the 0.5 precision floor, which the API **suppresses** rather than reports: `industrial_fire` (precision 0.000). Most such predictions would be wrong, so they are returned as *not classified* and findings for those classes come only from the deterministic rules.

Most influential features: `distance_to_facility_m` 0.371, `facilities_within_5km` 0.245, `land_cover_unknown` 0.067, `brightness_k` 0.043, `brightness_long_k` 0.041.

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

## The Ask tab

Plain-language questions beside the map — "what was detected in the last 24 hours?",
"most persistent industrial sources", "anything near 23.75, 86.42?" — answered from the
loaded data. Every answer is **computed** by code over fixed question types
([`frontend/src/assistant/intents.ts`](frontend/src/assistant/intents.ts)) and lists the
locations and facts it rests on, each linked to the map.

An optional open-weight model (Qwen3-1.7B, Apache-2.0) can be loaded to word answers
and understand unusual phrasing. It runs **in the browser** on the visitor's GPU via
WebGPU: no server, no key, nothing typed leaves the device. It never supplies a value —
a gate ([`verify.ts`](frontend/src/assistant/verify.ts)) withholds any wording with a
number, a source type or a name the computed facts do not contain, and shows the
computed answer instead, saying why. Measured honestly, the gate withholds nearly all of
this small model's wording — every one of five answers in testing, four of them for
untrue comparisons, reasons or labels built from true numbers — so its practical value
is understanding unusual phrasing, not writing the answer.
The first load downloads ~940 MB and took 6-8 minutes on the development laptop, so it
is opt-in and the page says so first.
Decision and measurements: [ADR 0008](docs/adr/0008-on-device-assistant.md).

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

Every collection response carries a `provenance` block, and the UI distinguishes four states that are easy to conflate and damaging to confuse:

| State | Meaning |
|---|---|
| **● Live** | Served by the API, and the newest detection is under 12 hours old |
| **● Near real time** | A snapshot that a scheduled build is demonstrably keeping current — rebuilt within the last two refresh intervals. The line beside the chip states when it was rebuilt and when a satellite last saw something |
| **◆ Historical** | Served by the API, but the newest record is older |
| **◆ Cached snapshot** | A snapshot that is not being refreshed, or whose scheduled refresh has fallen behind. It states its age |

A file is never described as live. "Near real time" is judged from when the file was built, so if the scheduled refresh stops, the page drops back to "Cached snapshot" on its own rather than advertising freshness it no longer has.

Every timestamp shown is the real satellite acquisition time. An earlier version re-dated snapshot detections relative to the current clock so that a frozen demo would not look stale; on a 13-day-old file that showed a 19 September detection as 2 October, after the data window had ended. A regression test now fails if any timestamp falls outside the window the snapshot declares.

**Coverage is reported, not assumed.** A location whose industrial context has not been surveyed reports `not_surveyed` and is left unclassified. That is deliberately different from "no industry nearby" — treating a gap in our own collection as evidence of absence is the easiest way for a system like this to start lying.

---

## Deployment

| Part | Host | Status |
|---|---|---|
| Dashboard | GitHub Pages | Deployed; **data rebuilt from NASA FIRMS every 3 hours** |
| API | Render (blueprint in [`render.yaml`](render.yaml)) | Not provisioned |
| Database | Neon Postgres via `DATABASE_URL` | Optional; SQLite works |

**How the deployed data stays current without a server.** [`pages.yml`](.github/workflows/pages.yml) runs every 3 hours. Each run rebuilds the database from scratch on the GitHub runner — ingesting the open FIRMS archives, which need no credentials, and joining against the committed OpenStreetMap tile cache — recomputes persistence and labels, exports the snapshot, and publishes it to Pages. Nothing is committed per run, so the repository does not grow.

Three hours matches the source: FIRMS publishes near-real-time detections roughly three hours after a satellite overpass, so refreshing faster would mostly re-download the same files. Satellites also do not observe continuously, so the newest detection can be several hours older than the last rebuild during an overpass gap; the dashboard reports both ages.

If the repository secret `FIRMS_MAP_KEY` is set, each run also backfills 60 days through the keyed endpoint, so persistence baselines are long-term. Without it the site still refreshes, over the 7-day open-archive window, and the persistence threshold scales to that window automatically.

A scheduled run whose refresh fails deploys nothing, leaving the previous — fresher — deployment live. GitHub suspends scheduled workflows after 60 days without repository activity; a push, or re-enabling the workflow in the Actions tab, resumes it.

With a hosted API, set the repository variable `API_BASE_URL` and the dashboard queries it instead. Without one it makes no API requests at all.

### Secrets

No credentials are required to run this project. `FIRMS_MAP_KEY` is optional: ingestion uses the open regional archives, and the key is used only by `app.pipeline backfill` to extend history beyond seven days. Locally it lives in `backend/.env`; in CI, in the `FIRMS_MAP_KEY` Actions secret. It is never written to the audit table, logs or `/api/runs` — the recorded URL substitutes `<MAP_KEY>`. If a `DATABASE_URL` is used it lives in `backend/.env` (gitignored) or Render's environment. CI fails the build on a committed key, a credential-bearing URL, or a tracked `.env`.

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
