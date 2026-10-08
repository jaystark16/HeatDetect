# Single-observation model: pass-context features

**Question:** can the single-observation classifier do better using only what one
satellite overpass shows, with still no coordinates and no history?

**Answer:** yes, modestly and consistently. Macro F1 rose from **0.570 to 0.606** under
5-fold spatial cross-validation, and the new feature set won in all five folds. Almost
all of the gain comes from the same-pass neighbourhood. `industrial_fire` remains
unreportable.

## Run conditions (2026-10-08)

- 54,111 detections from surveyed cells, 207 one-degree blocks, window 25 Jul – 6 Oct.
- Labels: `industrial_fire` 2,389 · `persistent_industrial` 17,973 · `natural_fire`
  15,490 · `unknown` 18,259 (rule version `rule-v1`).
- **Evaluation:** 5-fold `GroupKFold` over 1° blocks, so every block is held out exactly
  once. This averages over the whole map instead of trusting one 70/30 block split,
  whose macro F1 moves by ±0.01–0.05 depending on which blocks land in test.
- Same RandomForest hyperparameters as the shipped model (`app/train.py`).

## Features added (`pass_context` in `app/model.py`)

| Feature | Why it could help | Available at serve time? |
|---|---|---|
| Pixel footprint (scan × track) and FRP per km² | A small very hot source and a broad cooler front can share an FRP value but not a density | Yes, in the detection |
| Brightness ratio (I4 / I5) | Same physics as the dual-band delta, scale-free | Yes |
| Local solar hour (sin, cos) | Persistent industrial sources skew to night passes | Yes |
| Nearest facility category (industrial, power, mining, works, other, none) | Mining and power sites behave differently from generic industry | Yes, from `cell_context` |
| Same-pass neighbours: count, log count, log FRP sum, max FRP within 5 km, same satellite, ±15 min | Vegetation fires burn as pixel clusters; isolated hot pixels near facilities are a different pattern | Yes: the whole pass is ingested together |

None of these reads a location's history, so ADR 0004's information asymmetry holds.
Neighbours are other *detections*, never other cells' *labels*.

## Results (mean over 5 folds)

| Configuration | Features | macro F1 | per-fold macro F1 |
|---|---|---|---|
| Shipped `no_coords` | 21 | 0.570 ± 0.009 | 0.558 0.573 0.568 0.586 0.566 |
| + same-pass neighbours only | 25 | 0.586 ± 0.017 | 0.565 0.616 0.575 0.593 0.580 |
| **+ physics, time, category, neighbours (`pass_context`)** | 37 | **0.606 ± 0.048** | 0.571 0.701 0.587 0.593 0.577 |
| Gradient boosting (balanced), same 37 features | 37 | 0.482 ± 0.025 | — |
| + physics, time, category, *without* neighbours | 33 | 0.575 ± 0.016 | — |

Per class, `no_coords` → `pass_context`:

| class | precision | recall | F1 |
|---|---|---|---|
| `industrial_fire` | 0.000 → 0.086 | 0.000 → 0.104 | 0.000 → 0.094 |
| `persistent_industrial` | 0.672 → 0.698 | 0.788 → 0.799 | 0.719 → 0.741 |
| `natural_fire` | 0.853 → 0.850 | 0.988 → 0.986 | 0.915 → 0.912 |
| `unknown` | 0.769 → 0.777 | 0.563 → 0.602 | 0.646 → 0.675 |

## What this does and doesn't show

- The gain is consistent (5 of 5 folds) but small in four folds (+0.007 to +0.019) and
  large in one (+0.128). Report it as a modest improvement, not a breakthrough.
- `industrial_fire` precision is still far below `MIN_PRECISION_TO_REPORT` (0.5), so the
  API keeps suppressing it and that class still comes only from the rules. This is
  expected: the class is an excursion from a baseline that one pass cannot see.
- Gradient boosting with balanced sample weights did worse, mostly by collapsing
  `persistent_industrial` recall (0.32). Not pursued.
- All figures measure agreement with the rule-based labels under a spatial hold-out, not
  correctness against reality (see the model caveat).

## Reproduce

The shipped metrics in `backend/models/metrics.json` use `app/train.py`'s single block
split, as before. The cross-validated comparison above came from a one-off script run on
the same database; `python -m app.train --ablation` now includes `pass_context`.
