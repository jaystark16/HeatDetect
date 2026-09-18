# ADR 0003 — RandomForest via scikit-learn, not XGBoost

**Status:** accepted, 2026-09-18

## Context

The team plan specifies "Random Forest or XGBoost" for the tabular classifier.
The model is loaded and called inside the API process, so its dependencies are
runtime dependencies, and the trained artifact is committed because the database
it was trained from is not.

## Decision

`sklearn.ensemble.RandomForestClassifier`, 200 trees, `max_depth=12`,
`min_samples_leaf=5`, `class_weight="balanced_subsample"`.

## Reasoning

**Against XGBoost:** it adds a compiled dependency and a slower cold build on
Render's free tier, for no measured benefit on a feature set of 21 columns and a
few thousand rows. Gradient boosting wins on large, dense tabular problems; this
is neither.

**For RandomForest specifically over sklearn's `HistGradientBoostingClassifier`
(the earlier choice recorded in `requirements.txt`):** RandomForest exposes
`feature_importances_` directly. That mattered more than a marginal accuracy
difference, because the ablation needed to answer "how much of this model's
skill is geography memorisation?" — and the answer changed the shipped feature
set. A model whose reliance on each input is inspectable was worth more here
than one that scores slightly better.

**Hyperparameters are chosen against measurements, not defaults:**

- `max_depth=12` — unbounded trees memorise individual locations, which the
  spatial hold-out then punishes.
- `class_weight="balanced_subsample"` — `industrial_fire` is ~6% of rows and is
  the operationally interesting class, so errors on it must cost more.
- `n_estimators=200` — held-out macro F1 was indistinguishable from 400 (0.625
  vs 0.629), and the committed artifact halves in size.

## Consequences

- No compiled dependency beyond numpy/scipy.
- Compressed artifact is 2.4 MiB, small enough to commit.
- `feature_importances_` is recorded with every trained model, so reliance on
  proximity versus thermal features is visible rather than assumed.
- If the feature count or row count grows by an order of magnitude, revisit —
  gradient boosting would likely win at that scale.
