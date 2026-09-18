"""Classification authority.

These tests encode the guarantees that stop inference masquerading as fact:

  1. A rule verdict is authoritative and carries **no** probability.
  2. The model is consulted only where the rules abstained.
  3. A class the model is measurably bad at is suppressed, driven by its own
     recorded precision rather than a hardcoded list.
  4. Nothing is classified in an unsurveyed area.
  5. A model with no recorded metrics is trusted for nothing.

If any of these break, the system can present a confident finding it has no
evidence for. That is the failure mode this project exists to avoid.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pytest
from conftest import make_context, make_stats

from app import model as ml
from app.service import classify


@dataclass
class StubEstimator:
    """Returns a fixed probability vector, so authority logic is tested in
    isolation from whatever a real forest happens to predict."""

    probabilities: list[float]
    classes_: list[str]

    def predict_proba(self, _X):  # noqa: N803
        return [self.probabilities]


def stub_model(
    mapping: dict[str, float], precisions: dict[str, float] | None = None
) -> ml.TrainedModel:
    """A model with fixed probabilities and, by default, trustworthy precision.

    `precisions` defaults to well above the reporting minimum so that tests of
    other behaviour are not silently short-circuited by suppression.
    """
    classes = sorted(mapping)
    if precisions is None:
        precisions = {c: 0.9 for c in classes}

    return ml.TrainedModel(
        estimator=StubEstimator([mapping[c] for c in classes], classes),
        feature_names=ml.FEATURE_SETS[ml.DEFAULT_FEATURE_SET],
        classes=classes,
        model_version="stub-1",
        trained_at=datetime(2026, 9, 18, tzinfo=timezone.utc),
        metrics={
            "per_class": {
                c: {"precision": p, "recall": 0.8, "f1": 0.8, "support": 100}
                for c, p in precisions.items()
            }
        },
        feature_set=ml.DEFAULT_FEATURE_SET,
    )


def features() -> ml.ObservationFeatures:
    return ml.ObservationFeatures(
        frp_mw=2.4,
        brightness_k=330.0,
        brightness_long_k=303.0,
        scan=0.4,
        track=0.45,
        day_night="N",
        confidence_tier="nominal",
        instrument="VIIRS",
        latitude=23.755,
        longitude=86.405,
        distance_to_facility_m=800.0,
        facilities_within_5km=4,
        land_cover="industrial",
    )


# ---------------------------------------------------------- rules are king --


def test_rule_verdict_wins_and_has_no_probability():
    result = classify(
        make_stats(),
        make_context(),
        "persistent_industrial",
        [{"criterion": "recurrence", "passed": True}],
        stub_model({"natural_fire": 0.99}),
        features(),
    )
    assert result.label.value == "persistent_industrial"
    assert result.source == "rule"
    # A threshold comparison has no probability. Inventing one would be fabricating
    # a statistic, which is exactly what this project forbids.
    assert result.confidence is None
    assert result.abstained is False


def test_rule_verdict_is_not_overridden_by_a_confident_model():
    """Even a 0.99 model prediction must not displace a rule decision."""
    result = classify(
        make_stats(),
        make_context(),
        "natural_fire",
        [],
        stub_model({"industrial_fire": 0.99}),
        features(),
    )
    assert result.label.value == "natural_fire"
    assert result.source == "rule"


# ------------------------------------------------------- model fills gaps --


def test_model_is_consulted_only_when_rules_abstain():
    result = classify(
        make_stats(observations=2, distinct_days=1),
        make_context(),
        "unknown",
        [],
        stub_model({"natural_fire": 0.91, "persistent_industrial": 0.09}),
        features(),
    )
    assert result.source == "model"
    assert result.label.value == "natural_fire"
    assert result.confidence == 0.91
    assert result.model_version == "stub-1"


def test_model_abstains_below_the_threshold():
    """A near-tie must be reported as uncertainty, not resolved into a pick."""
    below = ml.ABSTAIN_BELOW - 0.05
    result = classify(
        make_stats(observations=2),
        make_context(),
        "unknown",
        [],
        stub_model({"natural_fire": below, "persistent_industrial": 1 - below}),
        features(),
    )
    assert result.abstained is True
    assert result.label.value == "unknown"
    assert result.confidence is None


# ------------------------------------------ metric-driven class suppression --


def test_low_precision_class_is_suppressed():
    """The shipped model's industrial_fire precision is 0.257 — three of four
    such predictions would be wrong, so it must not reach a user as a finding."""
    result = classify(
        make_stats(observations=2),
        make_context(),
        "unknown",
        [],
        stub_model(
            {"industrial_fire": 0.97, "natural_fire": 0.03},
            precisions={"industrial_fire": 0.257, "natural_fire": 0.99},
        ),
        features(),
    )
    assert result.label.value == "unknown"
    assert result.abstained is True
    assert result.confidence is None

    suppression = next(
        c for c in result.criteria if c["criterion"] == "model_class_suppressed"
    )
    assert suppression["suppressed_label"] == "industrial_fire"
    assert suppression["measured_precision"] == 0.257
    assert suppression["minimum_precision"] == ml.MIN_PRECISION_TO_REPORT


def test_high_precision_class_is_reported():
    """Suppression must be driven by the measurement, not by the class name.
    The same class is reportable when the model is demonstrably good at it."""
    result = classify(
        make_stats(observations=2),
        make_context(),
        "unknown",
        [],
        stub_model(
            {"industrial_fire": 0.97, "natural_fire": 0.03},
            precisions={"industrial_fire": 0.88, "natural_fire": 0.99},
        ),
        features(),
    )
    assert result.label.value == "industrial_fire"
    assert result.source == "model"
    assert result.confidence == 0.97


def test_model_without_metrics_is_trusted_for_nothing():
    """No recorded measurement means no evidence the model is right about
    anything. Reporting it anyway is how an unvalidated model drives alerts."""
    model = stub_model({"natural_fire": 0.99})
    model.metrics = {}

    result = classify(
        make_stats(observations=2), make_context(), "unknown", [], model, features()
    )
    assert result.label.value == "unknown"
    assert result.abstained is True


def test_unreliable_classes_reads_recorded_precision():
    model = stub_model(
        {"industrial_fire": 0.5, "natural_fire": 0.5},
        precisions={"industrial_fire": 0.257, "natural_fire": 0.996},
    )
    unreliable = model.unreliable_classes()
    assert "industrial_fire" in unreliable
    assert "natural_fire" not in unreliable
    assert unreliable["industrial_fire"] == pytest.approx(0.257)


def test_rule_derived_industrial_fire_is_never_suppressed():
    """Suppression applies to the model, not to the class. Rules use multi-day
    history and are the only component able to identify an excursion directly."""
    result = classify(
        make_stats(distinct_days=6, median_frp=1.5, p90_frp=9.0),
        make_context(distance_m=300.0),
        "industrial_fire",
        [{"criterion": "upper_excursion", "passed": True, "ratio": 6.0}],
        None,
        None,
    )
    assert result.label.value == "industrial_fire"
    assert result.source == "rule"


# -------------------------------------------------------- coverage gating --


def test_model_is_not_consulted_in_an_unsurveyed_area():
    """Proximity features would be meaningless, so the model must not be asked."""
    result = classify(
        make_stats(observations=2),
        make_context(coverage="not_surveyed"),
        "unknown",
        [],
        stub_model({"natural_fire": 0.99}),
        features(),
    )
    assert result.label.value == "unknown"
    assert result.source == "rule"
    assert result.abstained is True


def test_abstains_when_no_model_is_loaded():
    """An untrained system is a legitimate state, not an error."""
    result = classify(
        make_stats(observations=2), make_context(), "unknown", [], None, None
    )
    assert result.label.value == "unknown"
    assert result.abstained is True
    assert result.confidence is None


def test_criteria_are_preserved_through_classification():
    rationale = [
        {"criterion": "context_surveyed", "passed": True},
        {"criterion": "recurrence", "passed": False, "distinct_days": 2},
    ]
    result = classify(
        make_stats(), make_context(), "unknown", rationale, None, None
    )
    names = {c["criterion"] for c in result.criteria}
    assert {"context_surveyed", "recurrence"} <= names
