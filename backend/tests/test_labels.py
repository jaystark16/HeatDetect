"""Label rules.

The most important test in this file is the coverage gate. Treating "we have not
surveyed here" as "there is no industry here" would turn a gap in our own data
collection into apparent evidence — the single easiest way for this system to
start making false claims.
"""

from __future__ import annotations

from conftest import make_context, make_stats

from app.labels import (
    EXCURSION_ABSOLUTE_FLOOR_MW,
    assign_label,
    assign_labels,
    label_distribution,
)


def criterion(decision, name):
    return next(c for c in decision.rationale if c["criterion"] == name)


# ------------------------------------------------------- the coverage gate --


def test_unsurveyed_area_is_never_classified():
    """Even a textbook persistent industrial signature must abstain without a survey."""
    decision = assign_label(
        make_stats(distinct_days=7, observations=40),
        make_context(coverage="not_surveyed", distance_m=200.0),
    )
    assert decision.label == "unknown"
    assert criterion(decision, "context_surveyed")["passed"] is False


def test_unsurveyed_rationale_says_it_is_a_coverage_gap():
    decision = assign_label(
        make_stats(), make_context(coverage="not_surveyed")
    )
    note = criterion(decision, "context_surveyed")["note"]
    assert "not surveyed" in note.lower()
    assert "cannot be asserted" in note.lower()


# -------------------------------------------------- persistent industrial --


def test_persistent_source_near_industry():
    decision = assign_label(
        make_stats(distinct_days=6, observations=25, median_frp=2.3, p90_frp=3.0),
        make_context(distance_m=500.0),
    )
    assert decision.label == "persistent_industrial"
    assert criterion(decision, "recurrence")["passed"] is True
    assert criterion(decision, "upper_excursion")["passed"] is False


def test_recurrence_below_threshold_is_not_persistent():
    decision = assign_label(
        make_stats(distinct_days=3, observations=8), make_context(distance_m=500.0)
    )
    assert decision.label != "persistent_industrial"


def test_distance_beyond_proximity_threshold_is_not_industrial():
    """3 km is the criterion; 4 km sits in the deliberate gap between
    'near industry' and 'far from industry', so neither branch may claim it."""
    decision = assign_label(
        make_stats(distinct_days=7), make_context(distance_m=4_000.0)
    )
    assert decision.label == "unknown"


# --------------------------------------------------------- industrial fire --


def test_excursion_at_an_established_industrial_source():
    decision = assign_label(
        make_stats(distinct_days=6, observations=20, median_frp=2.0, p90_frp=12.0),
        make_context(distance_m=400.0),
    )
    assert decision.label == "industrial_fire"
    excursion = criterion(decision, "upper_excursion")
    assert excursion["passed"] is True
    assert excursion["ratio"] == 6.0


def test_high_ratio_below_the_absolute_floor_is_not_an_excursion():
    """0.3 -> 0.9 MW is a 3x ratio and means nothing. Without an absolute floor
    the rules would flag noise at hundreds of low-power locations."""
    decision = assign_label(
        make_stats(distinct_days=6, observations=20, median_frp=0.3, p90_frp=0.9),
        make_context(distance_m=400.0),
    )
    assert decision.label == "persistent_industrial"
    assert criterion(decision, "upper_excursion")["passed"] is False


def test_excursion_requires_a_usable_baseline():
    """Four observations cannot establish the median an excursion is measured
    against, so no excursion may be claimed."""
    decision = assign_label(
        make_stats(
            distinct_days=4,
            observations=4,
            median_frp=1.0,
            p90_frp=EXCURSION_ABSOLUTE_FLOOR_MW * 3,
        ),
        make_context(distance_m=400.0),
    )
    assert decision.label == "persistent_industrial"
    assert criterion(decision, "upper_excursion")["baseline_usable"] is False


# ------------------------------------------------------------ natural fire --


def test_episodic_fire_far_from_industry_on_vegetation():
    decision = assign_label(
        make_stats(distinct_days=1, observations=2, median_frp=8.0, p90_frp=9.0),
        make_context(distance_m=42_000.0, land_cover="forest", facility_name=None),
    )
    assert decision.label == "natural_fire"


def test_no_facility_found_still_allows_natural_fire():
    """A surveyed area with nothing within 10 km reports distance None."""
    decision = assign_label(
        make_stats(distinct_days=2, observations=3),
        make_context(distance_m=None, facility_name=None, category=None, land_cover="cropland"),
    )
    assert decision.label == "natural_fire"


def test_recurring_fire_far_from_industry_is_not_called_natural():
    """Seven days of recurrence is not episodic. It may be an unmapped
    industrial source, so abstaining is the honest answer."""
    decision = assign_label(
        make_stats(distinct_days=7, observations=30),
        make_context(distance_m=40_000.0, land_cover="forest", facility_name=None),
    )
    assert decision.label == "unknown"


def test_urban_land_cover_far_from_industry_is_not_natural():
    decision = assign_label(
        make_stats(distinct_days=1, observations=1),
        make_context(distance_m=30_000.0, land_cover="urban", facility_name=None),
    )
    assert decision.label == "unknown"


# ------------------------------------------------------------- precedence --


def test_industrial_fire_takes_precedence_over_persistent():
    """Order matters: a cell meeting both criteria must not be downgraded."""
    decision = assign_label(
        make_stats(distinct_days=7, observations=30, median_frp=1.5, p90_frp=9.0),
        make_context(distance_m=300.0),
    )
    assert decision.label == "industrial_fire"


def test_every_decision_records_why():
    decision = assign_label(make_stats(), make_context())
    names = {c["criterion"] for c in decision.rationale}
    assert {"context_surveyed", "industrial_proximity", "recurrence", "upper_excursion"} <= names


def test_unmatched_cell_records_that_nothing_matched():
    decision = assign_label(
        make_stats(distinct_days=3, observations=6), make_context(distance_m=4_000.0)
    )
    assert decision.label == "unknown"
    assert criterion(decision, "no_rule_matched")["passed"] is False


# ----------------------------------------------------------------- batch --


def test_assign_labels_raises_when_context_is_missing():
    """A missing context row is a pipeline ordering bug, not a data fact. Silently
    labelling it unknown would hide the bug behind a plausible answer."""
    import pytest

    stats = [make_stats(cell="1:1")]
    with pytest.raises(KeyError, match="No context computed"):
        assign_labels(stats, [])


def test_label_distribution_counts_every_class():
    decisions = [
        assign_label(make_stats(distinct_days=6), make_context(distance_m=500.0)),
        assign_label(
            make_stats(distinct_days=1, observations=1),
            make_context(distance_m=40_000.0, land_cover="forest"),
        ),
        assign_label(make_stats(), make_context(coverage="not_surveyed")),
    ]
    counts = label_distribution(decisions)
    assert set(counts) == {
        "industrial_fire",
        "persistent_industrial",
        "natural_fire",
        "unknown",
    }
    assert sum(counts.values()) == 3
    assert counts["persistent_industrial"] == 1
    assert counts["natural_fire"] == 1
    assert counts["unknown"] == 1
