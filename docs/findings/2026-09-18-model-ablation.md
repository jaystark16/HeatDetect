# Single-observation model: ablation results, 2026-09-18

Reproduce with `backend/.venv/Scripts/python -m app.train --ablation`.

Identical data, identical spatial split, identical hyperparameters. Only the
feature set differs.

**Run conditions:** 5,248 detections from surveyed cells (19 of 117 OSM tiles
cached). Spatial hold-out by 1° block: 3,594 train rows / 1,654 test rows across
43 train / 18 test blocks. Label distribution `persistent_industrial` 2,534,
`unknown` 1,227, `natural_fire` 1,159, `industrial_fire` 328.

## Summary

| Feature set | Features | macro F1 | `industrial_fire` F1 |
|---|---|---|---|
| `full` | 23 | 0.571 | 0.000 |
| **`no_coords`** *(shipped)* | 21 | **0.629** | **0.300** |
| `thermal_only` | 10 | 0.452 | 0.000 |

### `no_coords` per class

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| `industrial_fire` | 0.257 | 0.360 | 0.300 | 25 |
| `persistent_industrial` | 0.674 | 0.527 | 0.592 | 514 |
| `natural_fire` | 1.000 | 0.991 | 0.996 | 681 |
| `unknown` | 0.566 | 0.707 | 0.629 | 434 |

### `thermal_only` per class

| class | precision | recall | F1 | support |
|---|---|---|---|---|
| `industrial_fire` | 0.000 | 0.000 | 0.000 | 25 |
| `persistent_industrial` | 0.682 | 0.654 | 0.667 | 514 |
| `natural_fire` | 0.747 | 0.893 | 0.813 | 681 |
| `unknown` | 0.403 | 0.274 | 0.326 | 434 |

## Finding 1 — dropping coordinates *improves* generalisation

Removing latitude and longitude raised held-out macro F1 from **0.571 to 0.629**.

This is the cleanest result in the set. Coordinates let a tree memorise "this
exact place is industrial", which cannot transfer to an unseen region — and
because the hold-out is by geographic block, the test set *is* unseen regions, so
the memorisation is punished rather than rewarded. In the `full` model those two
features carried roughly a third of total importance, spent on something that
actively hurt.

**Decision:** `no_coords` ships. It is both more honest and measurably better.

## Finding 2 — there is genuine thermal signal

With **only** ten thermal and geometry features — no proximity, no land cover, no
coordinates — the model reaches macro F1 0.452 and `natural_fire` F1 0.813.
Four-class chance is around 0.25.

Importance within `thermal_only`: `brightness_k` 0.176, `brightness_long_k`
0.161, `dual_band_delta_k` 0.138, FRP (raw + log) 0.241, `is_night` 0.119.

The dual-band separation ranking third is consistent with the physics it was
chosen for: small very hot sources versus larger cooler ones. So the classifier
is not merely a geography lookup — though context features roughly double its
skill.

## Finding 3 — `industrial_fire` is weakly detectable, and only with context

`industrial_fire` F1 is 0.300 under `no_coords` (precision 0.257, recall 0.360)
and **0.000** under both `full` and `thermal_only`.

This corrects an earlier run in this repository's history. With 10 tiles cached
and 3,804 training rows, `industrial_fire` scored **0.000 in every
configuration**, and the conclusion recorded then was that a single observation
can never identify an excursion. With 19 tiles and 5,248 rows the model recovers
9 of 25 held-out cases. **The original claim was too strong** — it was partly a
data-sparsity artefact, and it is corrected here rather than left standing.

The weaker form of the finding survives and still matters: the class is defined
by an **excursion ratio over multi-day history** (p90 FRP at least 3x the
location's median), and a single observation carries no information about the
median it should be compared against. Recall 0.360 means roughly two in three
industrial fires are missed from a snapshot. Persistence remains the only
reliable route to this class.

### Why the class is still suppressed for model output

Precision 0.257 means **three of four** model-raised industrial-fire predictions
would be wrong. For a disaster-management alert that consumes an operator's
attention, that is not a finding.

Suppression is implemented as a **measured** rule, not a hardcoded class name:
`TrainedModel.unreliable_classes()` reads the model's own recorded per-class
precision and suppresses anything below `MIN_PRECISION_TO_REPORT` (0.5). If
coverage improves and precision crosses that line, the class becomes reportable
with no code change. A model carrying no metrics at all is trusted for nothing.

That design exists *because* the earlier justification ("recall is 0.000") went
stale while the conclusion stayed correct. Reading the measurement keeps the rule
from outliving its evidence.

## Finding 4 — `natural_fire` precision of 1.000 is leakage, not skill

Perfect precision is a warning sign, and here the cause is known: the
`natural_fire` label requires a location to be **more than 5 km from mapped
industry**, and the model is handed `distance_to_facility_m` directly. It is
largely reading the same feature the labeller used.

Supporting evidence: under `thermal_only`, with proximity removed, precision
falls from 1.000 to 0.747. That gap is the leakage.

This is the shared-feature circularity flagged as a risk in
`docs/adr/0004-labelling-by-information-asymmetry.md`, now measured. It does not
invalidate the model — the thermal-only run shows real independent signal — but
`natural_fire` metrics must not be quoted as evidence of thermal discrimination.

## Caveat applying to every number above

Labels are programmatic heuristics derived from persistence, not verified ground
truth. These metrics measure agreement with a documented rule set under a spatial
hold-out. They are a consistency check, not validation against reality.

Coverage is also partial: 19 of 117 tiles. Numbers will move as it grows, as they
already have once.
