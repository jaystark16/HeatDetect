# Single-observation model: ablation results

Reproduce with `backend/.venv/Scripts/python -m app.train --ablation`.

Identical data, identical spatial split, identical hyperparameters. Only the
feature set differs.

**Run conditions (final, frozen):** 6,775 detections from surveyed cells, 53 of
117 OSM tiles cached (2,432 of 2,798 cells surveyed). Spatial hold-out by 1°
block: 4,791 train / 1,984 test rows across 116 train / 50 test blocks. Label
distribution, as test-fold rows (and as distinct cells): `persistent_industrial` 1,196 (174 cells), `unknown` 429 (1,325), `natural_fire` 282 (1,280), `industrial_fire` 77 (19).

## Summary

| Feature set | Features | macro F1 | `industrial_fire` F1 |
|---|---|---|---|
| `full` | 23 | 0.570 | 0.000 |
| **`no_coords`** *(shipped)* | 21 | 0.545 | **0.127** |
| `thermal_only` | 10 | 0.416 | 0.059 |

### `no_coords` per class (the shipped model)

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| `industrial_fire` | 0.087 | 0.234 | 0.127 | 77 |
| `persistent_industrial` | 0.803 | 0.555 | 0.656 | 1,196 |
| `natural_fire` | 0.904 | 0.972 | 0.937 | 282 |
| `unknown` | 0.382 | 0.576 | 0.459 | 429 |

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

| Coverage | Train rows | `full` | `no_coords` | Better |
|---|---|---|---|---|
| 10 tiles | 3,804 | 0.620 | 0.580 | `full` |
| 19 tiles | 5,248 | 0.571 | 0.629 | `no_coords` |
| 53 tiles | 6,775 | 0.570 | 0.545 | `full` |

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

`natural_fire` precision is 0.904 with proximity features and **0.451 without**
them. That halving is the leakage, measured directly: the label requires a
location to be more than 5 km from mapped industry, and the model is handed
`distance_to_facility_m` as an input. It is largely reading the labeller's own
criterion.

This was worse earlier — precision was 1.000 at 19 tiles — and improved as
coverage grew, because better coverage makes the proximity feature less
perfectly correlated with the label. It has not gone away.

`natural_fire` metrics must therefore **not** be quoted as evidence of thermal
discrimination. The `thermal_only` column is the honest number for that claim.

## Finding 4 — a single observation barely identifies an excursion

`industrial_fire` F1 is 0.127 under `no_coords` (precision 0.087, recall 0.234),
0.000 under `full`, and 0.059 under `thermal_only`.

The class is defined by an **excursion ratio over multi-day history** (p90 FRP at
least 3× the location's median). A single observation carries no information
about the median it should be compared against: a snapshot of a site behaving
normally and a snapshot of the same site during an excursion differ only in
absolute magnitude, and absolute magnitude does not separate them, because a
large routine source out-radiates a small anomalous one.

An earlier version of this document claimed a single observation could *never*
identify an excursion, on the basis of a 0.000 score. That was too strong — the
model recovers 18 of 77 held-out cases at 53 tiles. The weaker, surviving claim
is what matters operationally: **roughly three in four are missed, and precision
0.087 means eleven of twelve positives are false.**

### Consequences enforced in code

1. **The model may not report this class.** Suppression is measured, not
   hardcoded: `TrainedModel.unreliable_classes()` reads the model's own recorded
   per-class precision and suppresses anything below
   `MIN_PRECISION_TO_REPORT` (0.5). At present that catches both
   `industrial_fire` (0.087) and `unknown` (0.382), so the model can only ever
   surface `persistent_industrial` or `natural_fire`. A model carrying no
   metrics at all is trusted for nothing.
2. **Persistence is not optional.** The deterministic, history-based rules are
   the only component that identifies `industrial_fire` with any reliability.
3. **The model's honest role** is a provisional first pass for a location with
   no recorded history, separating "probably vegetation" from "probably a
   persistent industrial source". It is not an anomaly detector.

## Caveat applying to every number above

Labels are programmatic heuristics derived from persistence, not verified ground
truth. These metrics measure agreement with a documented rule set under a
spatial hold-out — a consistency check, not validation against reality.

Coverage is 53 of 117 tiles. Numbers will move as it grows, as they already have
twice. That is why the README's metrics block is generated from
`backend/models/metrics.json` by `scripts/sync_docs.py` rather than written by
hand.
