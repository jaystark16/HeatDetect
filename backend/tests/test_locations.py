"""The /api/locations endpoint.

This endpoint exists because the map draws locations, not detections, and
fetching detections to obtain locations was both wasteful and biased: a
recurring source emits one row per satellite pass, so 3,000 detection rows
yielded only 23 distinct persistent-industrial cells while vegetation fires —
episodic by definition — were squeezed out of the result entirely.

The property that matters most is therefore **completeness**: every matching
cell is returned, so no class can be crowded out of the map.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from conftest import insert_detection
from fastapi.testclient import TestClient

from app import main as api_main
from app import model as ml
from app.db import build_engine, cell_labels, cell_stats, init_schema
from app.geo import cell_id


def add_cell(engine, *, lat, lon, label, distinct_days, observations, median_frp):
    key = cell_id(lat, lon)
    now = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
    with engine.begin() as conn:
        conn.execute(
            cell_stats.insert().values(
                cell_id=key,
                observation_count=observations,
                distinct_days=distinct_days,
                median_frp_mw=median_frp,
                p90_frp_mw=median_frp * 2,
                mad_frp_mw=0.3,
                median_dual_band_k=25.0,
                night_fraction=0.5,
                first_seen=now - timedelta(days=distinct_days),
                last_seen=now,
                window_days=distinct_days,
                computed_at=now,
                code_version="test",
            )
        )
        conn.execute(
            cell_labels.insert().values(
                cell_id=key,
                label=label,
                label_rule_version="rule-v1",
                rationale=[],
                computed_at=now,
            )
        )
    return key


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite+pysqlite:///{tmp_path / 'loc.db'}")
    init_schema(engine)
    monkeypatch.setattr(ml, "load", lambda: None)
    with TestClient(api_main.app) as test_client:
        api_main.state.engine = engine
        api_main.state.model = None
        yield test_client, engine


# ---------------------------------------------------------- aggregation --


def test_many_detections_in_one_cell_yield_one_location(client):
    """The defect this endpoint fixes.

    A 46-day source produces roughly a hundred rows on the same pixel; the map
    needs one mark, not a hundred stacked outlines.
    """
    test_client, engine = client
    base = datetime(2026, 9, 1, 6, 0, tzinfo=timezone.utc)
    for i in range(40):
        insert_detection(
            engine,
            latitude=23.7551,
            longitude=86.4051,
            acquired_at=base + timedelta(hours=i * 7),
            frp_mw=2.0 + i * 0.1,
            satellite_code=f"S{i % 3}",
        )
    add_cell(
        engine,
        lat=23.755,
        lon=86.405,
        label="persistent_industrial",
        distinct_days=12,
        observations=40,
        median_frp=2.5,
    )

    body = test_client.get("/api/locations").json()
    assert body["count"] == 1
    assert body["total_matching"] == 1
    assert body["locations"][0]["observation_count"] == 40


def test_representative_is_the_strongest_detection(client):
    """Mark size should reflect the most energetic observation there, and the
    detail panel should open a real detection rather than an average."""
    test_client, engine = client
    base = datetime(2026, 9, 1, 6, 0, tzinfo=timezone.utc)
    weak = insert_detection(
        engine, latitude=23.7551, longitude=86.4051, acquired_at=base, frp_mw=1.0
    )
    strong = insert_detection(
        engine,
        latitude=23.7552,
        longitude=86.4052,
        acquired_at=base + timedelta(hours=5),
        frp_mw=44.5,
        satellite_code="N20",
    )
    add_cell(
        engine,
        lat=23.755,
        lon=86.405,
        label="persistent_industrial",
        distinct_days=5,
        observations=2,
        median_frp=22.0,
    )

    location = test_client.get("/api/locations").json()["locations"][0]
    assert location["max_frp_mw"] == pytest.approx(44.5)
    assert location["representative_detection_id"] == strong
    assert location["representative_detection_id"] != weak


def test_location_carries_both_peak_and_median(client):
    """Peak drives the mark; median is the baseline. Conflating them would
    misrepresent a spiky location as a steady one."""
    test_client, engine = client
    insert_detection(engine, latitude=20.5, longitude=85.5, frp_mw=30.0)
    add_cell(
        engine,
        lat=20.5,
        lon=85.5,
        label="industrial_fire",
        distinct_days=8,
        observations=20,
        median_frp=3.0,
    )

    location = test_client.get("/api/locations").json()["locations"][0]
    assert location["max_frp_mw"] == pytest.approx(30.0)
    assert location["median_frp_mw"] == pytest.approx(3.0)


# -------------------------------------------------------- completeness --


def test_every_class_is_returned_not_just_the_persistent_ones(client):
    """The bug that motivated this endpoint: persistence-ranked truncation hid
    every vegetation fire, so the map implied all thermal anomalies were
    industrial."""
    test_client, engine = client
    spec = [
        (23.75, 86.40, "persistent_industrial", 40),
        (20.50, 85.50, "industrial_fire", 12),
        (15.20, 76.60, "natural_fire", 1),
        (11.00, 77.00, "natural_fire", 2),
        (28.30, 77.10, "unknown", 1),
    ]
    for i, (lat, lon, label, days) in enumerate(spec):
        insert_detection(
            engine, latitude=lat, longitude=lon, frp_mw=1.0 + i, satellite_code=f"S{i}"
        )
        add_cell(
            engine,
            lat=lat,
            lon=lon,
            label=label,
            distinct_days=days,
            observations=days,
            median_frp=1.0 + i,
        )

    body = test_client.get("/api/locations").json()
    labels = [loc["label"] for loc in body["locations"]]
    assert body["count"] == 5
    assert set(labels) == {
        "persistent_industrial",
        "industrial_fire",
        "natural_fire",
        "unknown",
    }
    assert labels.count("natural_fire") == 2


def test_results_are_ordered_most_persistent_first(client):
    test_client, engine = client
    for i, (lat, days) in enumerate([(20.1, 3), (20.3, 30), (20.5, 11)]):
        insert_detection(engine, latitude=lat, longitude=85.0, satellite_code=f"S{i}")
        add_cell(
            engine,
            lat=lat,
            lon=85.0,
            label="natural_fire",
            distinct_days=days,
            observations=days,
            median_frp=2.0,
        )

    days = [
        loc["distinct_days"]
        for loc in test_client.get("/api/locations").json()["locations"]
    ]
    assert days == sorted(days, reverse=True)


# -------------------------------------------------------------- filters --


@pytest.fixture
def populated(client):
    test_client, engine = client
    spec = [
        (23.75, 86.40, "persistent_industrial", 40, 9.0),
        (20.50, 85.50, "industrial_fire", 12, 25.0),
        (15.20, 76.60, "natural_fire", 1, 2.0),
    ]
    for i, (lat, lon, label, days, frp) in enumerate(spec):
        insert_detection(
            engine, latitude=lat, longitude=lon, frp_mw=frp, satellite_code=f"S{i}"
        )
        add_cell(
            engine,
            lat=lat,
            lon=lon,
            label=label,
            distinct_days=days,
            observations=days,
            median_frp=frp / 2,
        )
    return test_client


def test_label_filter(populated):
    body = populated.get("/api/locations", params={"label": "natural_fire"}).json()
    assert body["count"] == 1
    assert body["locations"][0]["label"] == "natural_fire"


def test_min_distinct_days_filter(populated):
    assert (
        populated.get("/api/locations", params={"min_distinct_days": 12}).json()["count"]
        == 2
    )
    assert (
        populated.get("/api/locations", params={"min_distinct_days": 39}).json()["count"]
        == 1
    )


def test_min_frp_filter_uses_the_peak_not_the_median(populated):
    """A location whose peak clears the threshold must survive it even if its
    median does not — the filter is about what was seen, not the average."""
    body = populated.get("/api/locations", params={"min_frp_mw": 20}).json()
    assert body["count"] == 1
    assert body["locations"][0]["max_frp_mw"] == pytest.approx(25.0)


def test_bbox_filter(populated):
    inside = populated.get("/api/locations", params={"bbox": "86,23,87,24"}).json()
    outside = populated.get("/api/locations", params={"bbox": "1,1,2,2"}).json()
    assert inside["count"] == 1
    assert outside["count"] == 0


def test_limit_caps_results_but_total_reports_the_truth(populated):
    body = populated.get("/api/locations", params={"limit": 1}).json()
    assert body["count"] == 1
    assert body["total_matching"] == 3


# ----------------------------------------------------------- validation --


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"label": "volcano"}, 422),
        ({"min_frp_mw": -1}, 422),
        ({"min_distinct_days": 0}, 422),
        ({"limit": 0}, 422),
        ({"limit": 20001}, 422),
        ({"bbox": "1,2,3"}, 422),
        ({"bbox": "98,6,68,37"}, 422),
        ({"within_hours": 0}, 422),
    ],
)
def test_parameter_validation(client, params, expected):
    test_client, _ = client
    assert test_client.get("/api/locations", params=params).status_code == expected


def test_empty_database_returns_an_empty_collection(client):
    test_client, _ = client
    body = test_client.get("/api/locations").json()
    assert body["count"] == 0
    assert body["locations"] == []
    assert body["provenance"]["data_source"] == "none"
    assert body["provenance"]["is_live"] is False


def test_response_carries_provenance(populated):
    provenance = populated.get("/api/locations").json()["provenance"]
    assert "coverage_note" in provenance
    assert provenance["data_source"] == "firms_open_archive"
