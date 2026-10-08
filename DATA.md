# HeatDetect — data and model

Thresholds and metrics live in code and generated files. This page says where to look
and why things are shaped this way. It doesn't copy values, because copied values go stale.

## Sources

All declared in `backend/app/datasets.py` with licence and limitations, served at
`GET /api/datasets`, and rendered in the UI.

| Source | Resolution / notes | Access |
|---|---|---|
| NASA FIRMS VIIRS (Suomi NPP, NOAA-20, NOAA-21) | 375 m, near real time | Open regional archives, no key |
| NASA FIRMS MODIS C6.1 | 1 km | Open regional archives, no key |
| FIRMS `/api/area` | Same products, 60-day backfill only | Needs `FIRMS_MAP_KEY` |
| OSM industrial features (Overpass) | ODbL | Committed tile cache, `backend/data/osm_cache/` |
| OSM land-use polygons (Overpass) | ODbL; nearest-centroid, labelled approximate | Same cache |
| Derived persistence statistics | Computed here | — |

**Analysis area:** bbox `68,6,98,37.5`. That covers India plus parts of Pakistan, Nepal,
Bangladesh and Sri Lanka, so the UI calls it "analysis area", never "India".

**Deliberately not used:** VIIRS Nightfire (needs a licence application), full land-cover
geometry (6.1 MiB for a single 1° tile, ~1.8 GiB for India), and image patches (no reliable
labelled image dataset). See ADR 0002.

## Measured feed characteristics

From `docs/findings/2026-09-18-feed-characterisation.md`. Don't re-litigate these from
intuition.

- FRP is small: median ~1.6 MW, p95 ~9.6 MW, p99 ~18 MW.
- Refinery gas flares are largely absent. The detectable persistent sources are
  coal-seam fires (Jharia), coal and industrial belts, and power stations.
- Overpass rate-limits hard. Prefetch tiles in bulk and never query per hotspot.

## Tables

| Kind | Tables |
|---|---|
| observed | `detections`, `facilities`, `land_parcels` |
| derived | `cell_stats`, `cell_context`, `cell_labels` |
| audit | `ingest_runs` |

- A **location** is a grid cell of `GRID_DEGREES` (0.01°, ~1 km) in `app/geo.py`.
- Every record carries `kind` (`observed` / `derived` / `synthetic`) and a `dataset_id`.
- `backend/data/heatdetect.db` is untracked and regenerable with `python -m app.pipeline …`.

## Labels

- Four classes: `industrial_fire`, `persistent_industrial`, `natural_fire`, `unknown`.
- **Programmatic heuristics, not ground truth.** Every metric measures agreement with
  this rule set, not correctness.
- **Information asymmetry (ADR 0004).** The labels use a cell's full multi-day history.
  The model sees one detection, so it can't just re-derive the thresholds.
- Rules live in `backend/app/labels.py` as named constants (rule version in
  `config.LABEL_RULE_VERSION`) and are served at `GET /api/rules`.
- Persistence is **window-relative**. A cell needs both an absolute floor of distinct
  days and a minimum fraction of the global ingestion window. See MEMORY.md, 2026-09-23.
- `natural_fire` requires the cell to be far from mapped industry. That is the source of
  the proximity leakage below.

## Model

- scikit-learn RandomForest (ADR 0003), file `backend/models/single_observation_rf.joblib`
  (7.45 MiB), metrics in `backend/models/metrics.json`.
- **Feature sets** are in `app/model.py` `FEATURE_SETS`. `full` (adds coordinates) is kept
  for comparison only. **`no_coords`** (thermal + proximity) ships, because it can't
  memorise places and, unlike `full`, it had non-zero `industrial_fire` recall in the
  7-day runs. (In the current ablation table, `no_coords` is at 0.000 and `thermal_only`
  at 0.091.)
- **Split:** spatial hold-out by 1° block, so one facility never lands in both train
  and test.
- **Metrics:** precision, recall and F1 per class plus macro F1. Accuracy is never
  reported, because the imbalance would flatter it. Current figures are in the README's
  generated block.
- **Model behaviour at serve time** (`app/model.py`): it is consulted only where the rules
  abstain. It abstains below `ABSTAIN_BELOW`. Any class whose recorded held-out precision
  is below `MIN_PRECISION_TO_REPORT` is suppressed to `unknown`. A model with no
  metrics is trusted for nothing.
- **Coverage gating:** a location without surveyed industrial context is
  `not_surveyed` and is never classified.

## Caveats that travel with any metric

1. Labels are heuristics, not verified truth.
2. `natural_fire` scores are largely leakage. With proximity features removed, its
   precision roughly halves.
3. `industrial_fire` is barely detectable from one observation by definition, because the
   class is an excursion from a baseline a snapshot can't see.
4. The `full` vs `no_coords` gap flipped sign across coverage levels. Treat it as noise.
5. Ablation (`docs/findings/2026-09-18-model-ablation.md`): thermal + geometry features
   alone still beat four-class chance clearly, so the model is not purely a geography
   lookup.

## Retraining

```bash
cd backend
python -m app.train --ablation             # compare feature sets, saves nothing
python -m app.train --feature-set no_coords
cd .. && backend/.venv/Scripts/python scripts/sync_docs.py   # regenerate README block
```
