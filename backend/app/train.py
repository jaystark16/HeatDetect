"""Train and evaluate the single-observation classifier.

    python -m app.train                      # train the shipped model
    python -m app.train --ablation            # compare feature sets, train nothing
    python -m app.train --feature-set full

Reports per-class precision, recall and F1 plus a confusion matrix. Overall
accuracy is deliberately **not** headlined: the classes are heavily imbalanced,
so accuracy is dominated by the majority class and would flatter the model
without saying anything useful.

Training is restricted to detections in **surveyed** cells. Cells whose
industrial context was never queried are labelled `unknown` purely because of
that gap, and training on them would teach the model to predict our own missing
coverage rather than anything about the world.

The `--ablation` mode exists because the first trained model placed 72% of its
importance on location and proximity and only ~12% on thermal channels. That
raised a question worth answering with a measurement rather than an opinion:
how much of the skill is geography memorisation?
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
from sqlalchemy import select

from .config import LABEL_RULE_VERSION
from .db import build_engine, cell_context, cell_labels, detections
from .model import (
    CLASSES,
    DEFAULT_FEATURE_SET,
    FEATURE_SETS,
    ObservationFeatures,
    TrainedModel,
    feature_mask,
    save,
    spatial_block,
    split_by_block,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
logger = logging.getLogger("train")


def load_training_rows() -> tuple[np.ndarray, np.ndarray, list[str], int]:
    """Build the full design matrix from surveyed cells only."""
    engine = build_engine()

    query = (
        select(
            detections.c.frp_mw,
            detections.c.brightness_k,
            detections.c.brightness_long_k,
            detections.c.scan,
            detections.c.track,
            detections.c.day_night,
            detections.c.confidence_tier,
            detections.c.instrument,
            detections.c.latitude,
            detections.c.longitude,
            cell_context.c.distance_to_facility_m,
            cell_context.c.facilities_within_5km,
            cell_context.c.land_cover,
            cell_labels.c.label,
        )
        .select_from(
            detections.join(
                cell_context, detections.c.cell_id == cell_context.c.cell_id
            ).join(cell_labels, detections.c.cell_id == cell_labels.c.cell_id)
        )
        .where(cell_context.c.context_coverage == "surveyed")
    )

    with engine.connect() as conn:
        rows = conn.execute(query).all()
        unsurveyed = conn.execute(
            select(cell_context.c.cell_id).where(
                cell_context.c.context_coverage != "surveyed"
            )
        ).all()

    vectors: list[list[float]] = []
    targets: list[str] = []
    blocks: list[str] = []

    for r in rows:
        features = ObservationFeatures(
            frp_mw=r.frp_mw,
            brightness_k=r.brightness_k,
            brightness_long_k=r.brightness_long_k,
            scan=r.scan,
            track=r.track,
            day_night=r.day_night,
            confidence_tier=r.confidence_tier,
            instrument=r.instrument,
            latitude=r.latitude,
            longitude=r.longitude,
            distance_to_facility_m=r.distance_to_facility_m,
            facilities_within_5km=r.facilities_within_5km,
            land_cover=r.land_cover,
        )
        vectors.append(features.to_vector())
        targets.append(r.label)
        blocks.append(spatial_block(r.latitude, r.longitude))

    return (
        np.asarray(vectors, dtype=float),
        np.asarray(targets, dtype=object),
        blocks,
        len(unsurveyed),
    )


def _build_estimator() -> RandomForestClassifier:
    return RandomForestClassifier(
        # 200 rather than 400: held-out macro F1 is indistinguishable between the
        # two on this data, and the artifact is committed so its size matters.
        n_estimators=200,
        # Depth-limited: with a few thousand rows an unbounded forest memorises
        # individual locations, which a spatial hold-out then punishes.
        max_depth=12,
        min_samples_leaf=5,
        # The interesting classes are the rare ones, so errors on them must cost
        # proportionally more than errors on the abundant vegetation-fire class.
        class_weight="balanced_subsample",
        random_state=20260918,
        n_jobs=-1,
    )


def fit_and_evaluate(
    X_full: np.ndarray,
    y: np.ndarray,
    blocks: list[str],
    feature_set: str,
    test_fraction: float,
) -> tuple[RandomForestClassifier, dict]:
    mask = feature_mask(feature_set)
    names = FEATURE_SETS[feature_set]
    X = X_full[:, mask]

    train_mask, test_mask = split_by_block(blocks, test_fraction)
    estimator = _build_estimator()
    estimator.fit(X[train_mask], y[train_mask])

    y_true = y[test_mask]
    y_pred = estimator.predict(X[test_mask])

    present = [
        c for c in CLASSES if c in set(y_true.tolist()) | set(y_pred.tolist())
    ]
    report = classification_report(
        y_true, y_pred, labels=present, output_dict=True, zero_division=0
    )
    matrix = confusion_matrix(y_true, y_pred, labels=present).tolist()
    importances = sorted(
        zip(names, estimator.feature_importances_.tolist()),
        key=lambda kv: kv[1],
        reverse=True,
    )

    metrics = {
        "feature_set": feature_set,
        "feature_count": len(names),
        "per_class": {
            label: {
                "precision": report[label]["precision"],
                "recall": report[label]["recall"],
                "f1": report[label]["f1-score"],
                "support": int(report[label]["support"]),
            }
            for label in present
        },
        "macro_f1": report["macro avg"]["f1-score"],
        "confusion_matrix": {"labels": present, "matrix": matrix},
        "feature_importance": dict(importances),
        "training_rows": int(train_mask.sum()),
        "test_rows": int(test_mask.sum()),
        "train_blocks": len({b for b, m in zip(blocks, train_mask) if m}),
        "test_blocks": len({b for b, m in zip(blocks, test_mask) if m}),
        "label_rule_version": LABEL_RULE_VERSION,
        "split": "spatial block hold-out, 1 degree blocks",
    }
    return estimator, metrics


def print_report(metrics: dict) -> None:
    print(
        f"\n=== {metrics['feature_set']} "
        f"({metrics['feature_count']} features, "
        f"{metrics['training_rows']} train / {metrics['test_rows']} test rows, "
        f"{metrics['train_blocks']}/{metrics['test_blocks']} blocks) ==="
    )
    print(f"{'class':<26}{'precision':>10}{'recall':>9}{'f1':>7}{'support':>9}")
    for label, row in metrics["per_class"].items():
        print(
            f"{label:<26}{row['precision']:>10.3f}{row['recall']:>9.3f}"
            f"{row['f1']:>7.3f}{row['support']:>9}"
        )
    print(f"macro F1: {metrics['macro_f1']:.3f}")

    cm = metrics["confusion_matrix"]
    print("\nconfusion (rows = true, cols = predicted)")
    print("            " + "".join(f"{c[:11]:>13}" for c in cm["labels"]))
    for label, row in zip(cm["labels"], cm["matrix"]):
        print(f"{label[:11]:<12}" + "".join(f"{v:>13}" for v in row))

    print("\ntop features")
    for name, value in list(metrics["feature_importance"].items())[:8]:
        print(f"  {name:<28}{value:.4f}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.train")
    parser.add_argument("--test-fraction", type=float, default=0.3)
    parser.add_argument(
        "--feature-set", choices=sorted(FEATURE_SETS), default=DEFAULT_FEATURE_SET
    )
    parser.add_argument(
        "--ablation",
        action="store_true",
        help="Evaluate every feature set and exit without saving a model",
    )
    args = parser.parse_args(argv)

    X, y, blocks, unsurveyed = load_training_rows()

    if len(X) == 0:
        logger.error(
            "No training rows. Either no detections are ingested, or no cells have "
            "surveyed industrial context (%d cells unsurveyed). Run "
            "`python -m app.pipeline facilities` then `features`.",
            unsurveyed,
        )
        return 1

    distribution = Counter(y.tolist())
    logger.info("training rows: %d (surveyed cells only)", len(X))
    logger.info("unsurveyed cells excluded: %d", unsurveyed)
    logger.info("label distribution: %s", dict(distribution))

    if len(distribution) < 2:
        logger.error(
            "Only %d class present (%s); a classifier needs at least two. OSM "
            "coverage has probably not reached the industrial regions yet.",
            len(distribution),
            list(distribution),
        )
        return 1

    if args.ablation:
        print(
            "\nAblation: identical data, spatial split and hyperparameters; only "
            "the feature set differs."
        )
        summary: dict[str, dict] = {}
        for name in ("full", "no_coords", "thermal_only"):
            _, metrics = fit_and_evaluate(X, y, blocks, name, args.test_fraction)
            print_report(metrics)
            summary[name] = metrics

        print("\n=== Ablation summary (macro F1) ===")
        for name, metrics in summary.items():
            per_class = metrics["per_class"]
            fire = per_class.get("industrial_fire", {}).get("f1", 0.0)
            print(
                f"  {name:<14} macro F1 {metrics['macro_f1']:.3f}   "
                f"industrial_fire F1 {fire:.3f}"
            )
        print("\nNo model saved (--ablation).")
        return 0

    estimator, metrics = fit_and_evaluate(
        X, y, blocks, args.feature_set, args.test_fraction
    )
    metrics["label_distribution"] = dict(distribution)
    metrics["unsurveyed_cells_excluded"] = unsurveyed
    print_report(metrics)
    print("\n(accuracy intentionally omitted: classes are heavily imbalanced)")

    model = TrainedModel(
        estimator=estimator,
        feature_names=FEATURE_SETS[args.feature_set],
        classes=list(estimator.classes_),
        model_version=f"rf-{datetime.now(timezone.utc):%Y%m%d}-{args.feature_set}-{LABEL_RULE_VERSION}",
        trained_at=datetime.now(timezone.utc),
        metrics=metrics,
        feature_set=args.feature_set,
    )
    save(model)
    print(f"\nsaved model version {model.model_version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
