"""Feature computation: robust statistics and the spatial index."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from conftest import insert_detection

from app.features import (
    PointIndex,
    compute_cell_stats,
    median_absolute_deviation,
    percentile,
)
from app.geo import cell_id


# ------------------------------------------------------------- statistics --


def test_mad_is_zero_for_constant_values():
    assert median_absolute_deviation([2.0, 2.0, 2.0, 2.0]) == 0.0


def test_mad_ignores_a_single_extreme_value():
    """The whole reason MAD is used instead of standard deviation: the excursion
    we are hunting must not inflate the baseline it is measured against."""
    steady = [2.0, 2.1, 1.9, 2.0, 2.05]
    with_spike = [*steady, 140.0]

    assert median_absolute_deviation(with_spike) == pytest.approx(
        median_absolute_deviation(steady), abs=0.06
    )

    import statistics

    # By contrast, the standard deviation is destroyed by the same spike.
    assert statistics.pstdev(with_spike) > 20 * statistics.pstdev(steady)


def test_mad_of_single_value_is_zero_not_an_error():
    assert median_absolute_deviation([5.0]) == 0.0


def test_percentile_endpoints_and_interpolation():
    values = [1.0, 2.0, 3.0, 4.0]
    assert percentile(values, 0.0) == 1.0
    assert percentile(values, 1.0) == 4.0
    assert percentile(values, 0.5) == pytest.approx(2.5)


def test_percentile_of_single_value():
    """statistics.quantiles raises on one point; many cells have exactly one."""
    assert percentile([7.5], 0.9) == 7.5


def test_percentile_rejects_empty_input():
    with pytest.raises(ValueError, match="empty"):
        percentile([], 0.5)


# ----------------------------------------------------------- point index --


def test_point_index_finds_the_nearest_point():
    index = PointIndex(
        [
            (23.755, 86.405, {"id": "near"}),
            (23.900, 86.600, {"id": "far"}),
        ]
    )
    result = index.nearest(23.756, 86.406, 10_000)
    assert result is not None
    assert result[1]["id"] == "near"
    assert result[0] < 200


def test_point_index_respects_the_radius():
    index = PointIndex([(23.900, 86.600, {"id": "far"})])
    assert index.nearest(23.755, 86.405, 1_000) is None


def test_point_index_searches_across_bucket_boundaries():
    """A point just over a bucket edge must still be found; a single-bucket
    lookup would miss it and report a spurious 'nothing nearby'."""
    # Buckets are 0.1 degrees, so these two straddle a boundary.
    index = PointIndex([(23.7999, 86.405, {"id": "other-bucket"})])
    result = index.nearest(23.8001, 86.405, 1_000)
    assert result is not None
    assert result[1]["id"] == "other-bucket"


def test_point_index_count_within():
    index = PointIndex(
        [
            (23.755, 86.405, {}),
            (23.758, 86.408, {}),
            (24.500, 87.500, {}),
        ]
    )
    assert index.count_within(23.755, 86.405, 5_000) == 2


def test_empty_index_returns_none_not_an_error():
    index = PointIndex([])
    assert len(index) == 0
    assert index.nearest(0, 0, 1000) is None
    assert index.count_within(0, 0, 1000) == 0


# --------------------------------------------------------- aggregation --


def test_cell_stats_counts_distinct_days_not_observations(engine):
    """Three satellites overpass within minutes, so counting rows would
    overstate recurrence. Distinct days is what measures persistence."""
    day = datetime(2026, 9, 15, 6, 0, tzinfo=timezone.utc)
    for minutes, sat in ((0, "N"), (7, "N20"), (14, "N21")):
        insert_detection(
            engine, acquired_at=day + timedelta(minutes=minutes), satellite_code=sat
        )
    insert_detection(engine, acquired_at=day + timedelta(days=1), satellite_code="N")

    stats = compute_cell_stats(engine)
    assert len(stats) == 1
    assert stats[0].observation_count == 4
    assert stats[0].distinct_days == 2


def test_cell_stats_groups_by_cell(engine):
    insert_detection(engine, latitude=23.755, longitude=86.405)
    insert_detection(engine, latitude=22.345, longitude=69.866, satellite_code="N20")

    stats = {s.cell_id: s for s in compute_cell_stats(engine)}
    assert set(stats) == {cell_id(23.755, 86.405), cell_id(22.345, 69.866)}


def test_cell_stats_baseline_usability_threshold(engine):
    """Below the observation threshold a baseline must be marked unusable, so no
    deviation ratio is reported from two data points."""
    day = datetime(2026, 9, 15, 6, 0, tzinfo=timezone.utc)
    for i in range(3):
        insert_detection(
            engine, acquired_at=day + timedelta(days=i), satellite_code=f"N{i}"
        )

    stats = compute_cell_stats(engine)[0]
    assert stats.observation_count == 3
    assert stats.has_usable_baseline is False


def test_cell_stats_night_fraction(engine):
    day = datetime(2026, 9, 15, 6, 0, tzinfo=timezone.utc)
    insert_detection(engine, acquired_at=day, day_night="N", satellite_code="N")
    insert_detection(
        engine, acquired_at=day + timedelta(hours=8), day_night="D", satellite_code="N20"
    )

    stats = compute_cell_stats(engine)[0]
    assert stats.night_fraction == pytest.approx(0.5)


def test_cell_stats_on_empty_database(engine):
    """No detections is a legitimate state, not an error."""
    assert compute_cell_stats(engine) == []
