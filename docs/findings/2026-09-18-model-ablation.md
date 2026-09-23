# Single-observation model: ablation results

Reproduce with `backend/.venv/Scripts/python -m app.train --ablation`.

Identical data, identical spatial split, identical hyperparameters. Only the
feature set differs.

**Run conditions (2026-09-23, after a 60-day keyed backfill):** 35,932 detections
from surveyed cells over a **61-day window** (25 Jul – 23 Sep), 12,138 of 13,925
cells surveyed. Spatial hold-out by 1° block: 22,360 train / 13,572 test rows
across 139 train / 60 test blocks.

Superseded runs against the 7-day archive window are kept in the tables below,
because the way the numbers moved is itself the finding.

## Summary

| Feature set | Features | macro F1 | `industrial_fire` F1 |
|---|---|---|---|
| `full` | 23 | 0.553 | 0.000 |
| **`no_coords`** *(shipped)* | 21 | **0.572** | 0.000 |
| `thermal_only` | 10 | 0.416 | 0.054 |

### `no_coords` per class (the shipped model)

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| `industrial_fire` | 0.000 | 0.000 | 0.000 | 214 |
| `persistent_industrial` | 0.744 | 0.747 | 0.745 | 3,760 |
| `natural_fire` | 0.813 | 0.999 | 0.897 | 4,977 |
| `unknown` | 0.730 | 0.578 | 0.645 | 4,621 |

Every class except `industrial_fire` improved substantially against the 7-day
run, which is what a 5x larger training set should do.

### `thermal_only` per class

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| `industrial_fire` | 0.043 | 0.091 | 0.059 | 77 |
| `persistent_industrial` | 0.766 | 0.649 | 0.703 | 1,196 |
| `natural_fire` | 0.451 | 0.759 | 0.566 | 282 |
| `unknown` | 0.381 | 0.298 | 0.335 | 429 |

## Finding 1 — the `full` vs `no_coords` gap is noise, and we were briefly fooled by it

This is the most important methodological lesson in the project, so it is
recorded in full rather than tidied away.

The ablation was run at three coverage levels as the OSM tile cache grew. The
sign of the macro-F1 difference between `full` and `no_coords` **flipped twice**:

| Run | Train rows | `full` | `no_coords` | Better |
|---|---|---|---|---|
| 10 tiles, 7-day | 3,804 | 0.620 | 0.580 | `full` |
| 19 tiles, 7-day | 5,248 | 0.571 | 0.629 | `no_coords` |
| 53 tiles, 7-day | 6,775 | 0.570 | 0.545 | `full` |
| 54 tiles, **61-day** | 35,932 | 0.553 | **0.572** | `no_coords` |

At the 19-tile run this repository recorded a confident conclusion — "dropping
coordinates *improves* generalisation" — with the 0.058 gap as evidence. The
next run reversed it. A difference that changes sign when the dataset grows is
**not a result**; it is variance being read as signal.

**Corrected conclusion:** coordinates make no reliable difference to macro F1 on
this data. `no_coords` still ships, on two grounds that do not depend on that
unstable number:

1. It is the only configuration with **non-zero `industrial_fire` recall** in
   every run. `full` scores exactly 0.000 for that class at both 10 and 53
   tiles.
2. Latitude and longitude can only be used to memorise specific places, which
   cannot transfer to an unsurveyed region. That is an argument from what the
   feature *can* represent, not from a metric.

## Finding 2 — there is genuine thermal signal

With **only** the ten thermal and geometry features — no proximity, no land
cover, no coordinates — the model reaches macro F1 0.416 and
`persistent_industrial` F1 0.703. Four-class chance is around 0.25.

Importance within `thermal_only`: `brightness_k` 0.180, `brightness_long_k`
0.167, `dual_band_delta_k` 0.129, `is_night` 0.124, FRP (raw + log) 0.222.

The dual-band separation ranking third is consistent with the physics it was
chosen for: small very hot sources versus larger cooler ones. So the classifier
is not purely a geography lookup, though context features roughly double its
skill on the remaining classes.

## Finding 3 — `natural_fire` performance is substantially leakage

`natural_fire` precision is 0.813 with proximity features and **0.451 without**
them (0.904 / 0.451 at the 7-day window). That halving is the leakage, measured directly: the label requires a
location to be more than 5 km from mapped industry, and the model is handed
`distance_to_facility_m` as an input. It is largely reading the labeller's own
criterion.

This was worse earlier — precision was 1.000 at 19 tiles — and improved as
coverage grew, because better coverage makes the proximity feature less
perfectly correlated with the label. It has not gone away.

`natural_fire` metrics must therefore **not** be quoted as evidence of thermal
discrimination. The `thermal_only` column is the honest number for that claim.

## Finding 4 — a single observation cannot identify an excursion

`industrial_fire` F1 is **0.000** under both `full` and `no_coords`, and 0.054
under `thermal_only`. Of **214** held-out industrial-fire detections, the shipped
model recovered **none**: 180 were predicted `persistent_industrial` and 34
`unknown`.

This supersedes an earlier, weaker reading. At the 7-day window the model scored
0.127 on just 25 test examples, and this document recorded that as evidence the
class was "weakly detectable". With 5x the training data and 8.5x the test
examples the score went to zero — so that 0.127 was noise, and the original
stronger claim was right after all.

The mechanism is unchanged and is the reason the result is stable: the class is
defined by an **excursion ratio over multi-day history** (p90 FRP at least 3x the
location's median). A single observation carries no information about the median
it should be compared against. A snapshot of a site behaving normally and a
snapshot of the same site during an excursion differ only in absolute magnitude,
and magnitude does not separate them, because a large routine source
out-radiates a small anomalous one.

### Consequences enforced in code

1. **The model may not report this class.** Suppression is measured, not
   hardcoded: `TrainedModel.unreliable_classes()` reads the model's own recorded
   per-class precision and suppresses anything below
   `MIN_PRECISION_TO_REPORT` (0.5). On the 61-day model that catches
   `industrial_fire` alone (precision 0.000); `unknown` rose to 0.730 and is no
   longer suppressed, which is the rule adapting to evidence exactly as
   intended. A model carrying no metrics at all is trusted for nothing.
2. **Persistence is not optional.** The deterministic, history-based rules are
   the only component that identifies `industrial_fire` with any reliability.
3. **The model's honest role** is a provisional first pass for a location with
   no recorded history, separating "probably vegetation" from "probably a
   persistent industrial source". It is not an anomaly detector.

## Caveat applying to every number above

Labels are programmatic heuristics derived from persistence, not verified ground
truth. These metrics measure agreement with a documented rule set under a
spatial hold-out — a consistency check, not validation against reality.

Coverage is 54 of 168 tiles that now contain detections, over a 61-day window.
Numbers will move as both grow, as they already have three times. That is why the README's metrics block is generated from
`backend/models/metrics.json` by `scripts/sync_docs.py` rather than written by
hand.
