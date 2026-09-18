# ADR 0004 — Labelling by information asymmetry

**Status:** accepted, 2026-09-18

## Context

The team plan specifies a Random Forest / XGBoost classifier. Supervised learning needs
labels, and we have no verified ground truth:

- **VIIRS Nightfire (VNF)**, the authoritative flare product, requires a licence
  application to the Earth Observation Group. Not available.
- Labelling "near industry ⇒ industrial fire" is circular and a reviewer will say so.
- Hand-labelling satellite pixels without ground reports is guesswork dressed up.

The naive fallback — write threshold rules, label the data with them, train a model on
the same features — is worse than useless. The model would re-learn the thresholds and
report high accuracy that measures nothing but self-agreement. That is exactly the
"looks AI-powered" failure this project must avoid.

## Decision

Split the information available to the labeller and to the model.

**Labels** are assigned per grid cell using the **full multi-day history**:
recurrence across distinct days, baseline stability, dual-band temperature behaviour,
and distance to mapped industry. This follows the flare/biomass separation principle in
the VIIRS Nightfire literature (discriminate by temperature *and* persistence).

**The model** predicts the class of a **single detection**, and is given **no history
features at all** — only what one observation carries: FRP, both brightness channels,
their difference, scan geometry, day/night, source confidence, distance to industry,
land cover, and location.

The model must therefore infer "does this location behave like a persistent industrial
source?" from one snapshot. That is a genuinely non-trivial inference, and it is the
real operational question: a new detection arrives with no history and a decision is
needed now.

## Why this is honest

The label encodes information (multi-day recurrence) that the model never sees, so
test performance measures generalisation rather than threshold memorisation.

Evaluation uses a **spatial split**: cells are grouped into geographic blocks and whole
blocks are held out, so the same facility cannot appear in both train and test. A
random row split would leak — the same coal fire contributes dozens of rows.

## Limitations, stated plainly

- These are **weak, programmatic labels**, not verified ground truth. Reported metrics
  measure agreement with a documented, auditable heuristic, not correctness against
  reality. Every metric is presented with that caveat attached.
- The `industrial_fire` class (an anomalous deviation at an established source) is rare.
  Per-class recall matters; overall accuracy is not reported as a headline.
- Labels are versioned (`label_rule_version`). Changing the rules invalidates prior
  metrics, and the pipeline records which version produced each label.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Train on rule labels with the same features | Circular; metrics meaningless |
| Apply for a VNF licence | Blocks all work on a third-party approval |
| Hand-label a few hundred pixels | No ground truth to label against |
| Skip supervised learning entirely | Loses the genuine single-observation use case, and departs from the team spec |
