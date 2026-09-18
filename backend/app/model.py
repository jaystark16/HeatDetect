"""Single-observation classifier.

Task: given **one** detection and its spatial context — and no history at all —
predict the class that the multi-day rules would eventually assign to its
location. See docs/adr/0004-labelling-by-information-asymmetry.md for why the
task is framed this way.

This is the real operational question. A detection arrives, its location has no
recorded history, and an analyst needs a first call now. The rules cannot answer
that; they need days of data.

Honest disclosure about feature overlap: the labeller and the model both see
distance-to-industry. The model does **not** see recurrence, baseline stability
or the excursion ratio, which are what actually decide the label. So the model's
real work is inferring recurrence-like behaviour from a thermal snapshot. Feature
importances are reported with every trained model so that reliance on proximity
is measurable rather than assumed.

Abstention is built in: when the top class probability is below
`ABSTAIN_BELOW`, the prediction is reported as `unknown` rather than forced.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import joblib
import numpy as np

logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = MODEL_DIR / "single_observation_rf.joblib"
METRICS_PATH = MODEL_DIR / "metrics.json"

# Below this top-class probability the model declines to answer. Chosen so that
# a near-tie between two classes is reported as uncertainty rather than as a
# confident pick.
ABSTAIN_BELOW = 0.55

# A class whose measured held-out precision is below this is not reported to
# users at all. At 0.5, more than half of such predictions would be wrong, which
# is not a finding — it is a coin toss wearing a label.
#
# This is deliberately derived from the model's own recorded metrics rather than
# hardcoded per class. An earlier version embargoed `industrial_fire` on the
# grounds that its recall was 0.000; when coverage improved, recall rose to
# 0.360 and that justification became false while the conclusion stayed right
# (precision 0.257). Reading the metrics keeps the rule honest as the data
# changes. See docs/findings/2026-09-18-model-ablation.md.
MIN_PRECISION_TO_REPORT = 0.5

# Distance is capped before entering the model: beyond this, "far" is "far", and
# the exact value carries no additional signal while adding a long tail that
# trees would waste splits on.
DISTANCE_CAP_M = 20_000.0

CONFIDENCE_TIERS = {"low": 0, "nominal": 1, "high": 2}

LAND_COVERS = (
    "industrial",
    "urban",
    "forest",
    "cropland",
    "shrubland",
    "barren",
    "water",
    "unknown",
)

FEATURE_NAMES: tuple[str, ...] = (
    "frp_mw",
    "log_frp",
    "brightness_k",
    "brightness_long_k",
    "dual_band_delta_k",
    "scan",
    "track",
    "is_night",
    "confidence_ordinal",
    "is_viirs",
    "latitude",
    "longitude",
    "distance_to_facility_m",
    "facility_distance_missing",
    "facilities_within_5km",
    *(f"land_cover_{c}" for c in LAND_COVERS),
)

CLASSES: tuple[str, ...] = (
    "industrial_fire",
    "persistent_industrial",
    "natural_fire",
    "unknown",
)

# --- Feature sets, for ablation -------------------------------------------
#
# The first trained model put 72% of its importance on location and industrial
# proximity and only ~12% on thermal physics, which raised two questions that
# only an ablation can answer: how much of the apparent skill is geography
# memorisation, and how much genuine signal is in the thermal channels?
#
# `full` is kept for comparison only. `no_coords` is the shipped default:
# latitude and longitude let a tree memorise "this exact place is industrial",
# which cannot generalise to an unseen region and inflates held-out scores
# wherever a block happens to resemble a training block.
_THERMAL = (
    "frp_mw",
    "log_frp",
    "brightness_k",
    "brightness_long_k",
    "dual_band_delta_k",
    "scan",
    "track",
    "is_night",
    "confidence_ordinal",
    "is_viirs",
)

_PROXIMITY = (
    "distance_to_facility_m",
    "facility_distance_missing",
    "facilities_within_5km",
    *(f"land_cover_{c}" for c in LAND_COVERS),
)

FEATURE_SETS: dict[str, tuple[str, ...]] = {
    "full": FEATURE_NAMES,
    "no_coords": _THERMAL + _PROXIMITY,
    # Measures the thermal signal in isolation. If this performs near chance,
    # the honest conclusion is that a single thermal observation does not
    # discriminate these classes and the system must rely on persistence.
    "thermal_only": _THERMAL,
}

DEFAULT_FEATURE_SET = "no_coords"


def feature_mask(feature_set: str) -> list[int]:
    """Column indices of `feature_set` within the full vector."""
    try:
        wanted = FEATURE_SETS[feature_set]
    except KeyError as exc:
        raise KeyError(
            f"Unknown feature set {feature_set!r}; options: {sorted(FEATURE_SETS)}"
        ) from exc
    lookup = {name: i for i, name in enumerate(FEATURE_NAMES)}
    return [lookup[name] for name in wanted]


@dataclass(frozen=True)
class ObservationFeatures:
    """Everything the model is allowed to see about one detection."""

    frp_mw: float
    brightness_k: float
    brightness_long_k: float
    scan: float
    track: float
    day_night: str
    confidence_tier: str
    instrument: str
    latitude: float
    longitude: float
    distance_to_facility_m: float | None
    facilities_within_5km: int
    land_cover: str

    def to_vector(self) -> list[float]:
        distance_missing = self.distance_to_facility_m is None
        distance = (
            DISTANCE_CAP_M
            if distance_missing
            else min(float(self.distance_to_facility_m), DISTANCE_CAP_M)
        )
        row = [
            self.frp_mw,
            # FRP is heavily right-skewed (median 1.6 MW, max ~58 MW), so a log
            # transform gives the trees a more even split space in the dense
            # low-power region where most detections live.
            math.log1p(max(self.frp_mw, 0.0)),
            self.brightness_k,
            self.brightness_long_k,
            self.brightness_k - self.brightness_long_k,
            self.scan,
            self.track,
            1.0 if self.day_night == "N" else 0.0,
            float(CONFIDENCE_TIERS.get(self.confidence_tier, 1)),
            1.0 if self.instrument == "VIIRS" else 0.0,
            self.latitude,
            self.longitude,
            distance,
            1.0 if distance_missing else 0.0,
            float(self.facilities_within_5km),
        ]
        row.extend(1.0 if self.land_cover == c else 0.0 for c in LAND_COVERS)
        return row


@dataclass
class Prediction:
    label: str
    confidence: float
    abstained: bool
    probabilities: dict[str, float] = field(default_factory=dict)


@dataclass
class TrainedModel:
    estimator: Any
    feature_names: tuple[str, ...]
    classes: list[str]
    model_version: str
    trained_at: datetime
    metrics: dict
    feature_set: str = DEFAULT_FEATURE_SET

    def unreliable_classes(self) -> dict[str, float]:
        """Classes this model has not earned the right to report, with their precision.

        Returns every class whose recorded held-out precision is below
        `MIN_PRECISION_TO_REPORT`.

        If the model carries **no** per-class metrics, every class is treated as
        unreliable. That is the conservative reading: without a measurement there
        is no evidence the model is right about anything, and defaulting to
        "report it anyway" is how an unvalidated model ends up driving alerts.
        """
        per_class = (self.metrics or {}).get("per_class")
        if not per_class:
            return {c: 0.0 for c in self.classes}

        return {
            label: float(row.get("precision", 0.0))
            for label, row in per_class.items()
            if float(row.get("precision", 0.0)) < MIN_PRECISION_TO_REPORT
        }

    def predict(self, features: ObservationFeatures) -> Prediction:
        mask = feature_mask(self.feature_set)
        full = features.to_vector()
        vector = np.asarray([[full[i] for i in mask]], dtype=float)
        probabilities = self.estimator.predict_proba(vector)[0]
        ranked = sorted(
            zip(self.classes, probabilities), key=lambda kv: kv[1], reverse=True
        )
        top_label, top_probability = ranked[0]

        if top_probability < ABSTAIN_BELOW:
            return Prediction(
                label="unknown",
                confidence=float(top_probability),
                abstained=True,
                probabilities={c: float(p) for c, p in ranked},
            )
        return Prediction(
            label=str(top_label),
            confidence=float(top_probability),
            abstained=False,
            probabilities={c: float(p) for c, p in ranked},
        )


# ------------------------------------------------------------- spatial CV --


def spatial_block(latitude: float, longitude: float, size: float = 1.0) -> str:
    """Group key for held-out evaluation.

    A random row split would leak badly: one coal-seam fire contributes dozens of
    detections, so the same source would appear in train and test and the model
    would look far better than it is. Holding out whole ~110 km blocks means the
    test set contains locations the model has never seen.
    """
    return f"{math.floor(latitude / size)}:{math.floor(longitude / size)}"


def split_by_block(
    blocks: Sequence[str], test_fraction: float = 0.3, seed: int = 20260918
) -> tuple[np.ndarray, np.ndarray]:
    """Assign whole blocks to train or test, deterministically."""
    unique = sorted(set(blocks))
    rng = np.random.default_rng(seed)
    shuffled = list(unique)
    rng.shuffle(shuffled)
    n_test = max(1, int(round(len(shuffled) * test_fraction)))
    test_blocks = set(shuffled[:n_test])

    block_array = np.asarray(blocks)
    is_test = np.isin(block_array, list(test_blocks))
    return ~is_test, is_test


# ----------------------------------------------------------- persistence --


def save(model: TrainedModel) -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "estimator": model.estimator,
            "feature_names": model.feature_names,
            "classes": model.classes,
            "model_version": model.model_version,
            "trained_at": model.trained_at.isoformat(),
            "metrics": model.metrics,
            "feature_set": model.feature_set,
        },
        MODEL_PATH,
        # Compressed because the artifact is committed: the deployed API needs a
        # model, and the database it was trained from is not in the repository.
        # Uncompressed, a 400-tree forest was 12.3 MiB.
        compress=3,
    )
    METRICS_PATH.write_text(
        json.dumps(
            {
                "model_version": model.model_version,
                "trained_at": model.trained_at.isoformat(),
                **model.metrics,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info("model.save wrote %s", MODEL_PATH.name)


def load() -> TrainedModel | None:
    """Load the trained model, or None if there isn't one.

    Returns None rather than raising: an untrained system is a legitimate state
    and the API reports it as such instead of pretending a model exists.
    """
    if not MODEL_PATH.exists():
        return None
    try:
        blob = joblib.load(MODEL_PATH)
    except Exception as exc:  # noqa: BLE001
        logger.error("model.load failed: %s", exc)
        return None

    return TrainedModel(
        estimator=blob["estimator"],
        feature_names=tuple(blob["feature_names"]),
        classes=list(blob["classes"]),
        model_version=blob["model_version"],
        trained_at=datetime.fromisoformat(blob["trained_at"]),
        metrics=blob["metrics"],
        feature_set=blob.get("feature_set", DEFAULT_FEATURE_SET),
    )


def load_metrics() -> dict | None:
    if not METRICS_PATH.exists():
        return None
    try:
        return json.loads(METRICS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


CAVEAT = (
    "Labels are programmatic heuristics derived from multi-day persistence, not "
    "verified ground truth. Metrics therefore measure agreement with a documented "
    "rule set under a spatial hold-out, not correctness against reality. "
    "Treat them as a consistency check, not as validation."
)
