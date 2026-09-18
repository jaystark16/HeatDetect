"""API contract and failure-path tests.

Runs against a temporary database so the tests do not depend on whatever the
pipeline last ingested. Covers the paths that matter for trust: provenance
honesty, input validation, empty states and 404s.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from conftest import insert_detection
from fastapi.testclient import TestClient

from app import main as api_main
from app import model as ml
from app.db import build_engine, cell_context, cell_labels, cell_stats, init_schema
from app.geo import cell_id


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A client wired to an isolated database with no trained model."""
    engine = build_engine(f"sqlite+pysqlite:///{tmp_path / 'api.db'}")
    init_schema(engine)

    monkeypatch.setattr(api_main.state, "engine", engine, raising=False)
    monkeypatch.setattr(api_main.state, "model", None, raising=False)
    # Suppress lifespan so it cannot replace the injected engine.
    monkeypatch.setattr(ml, "load", lambda: None)

    with TestClient(api_main.app) as test_client:
        api_main.state.engine = engine
        api_main.state.model = None
        yield test_client, engine


def seed_cell(engine, *, label: str, coverage: str = "surveyed", cell: str | None = None):
    """Insert one detection plus the derived rows the API joins against."""
    latitude, longitude = 23.755, 86.405
    detection = insert_detection(engine, latitude=latitude, longitude=longitude)
    key = cell or cell_id(latitude, longitude)
    now = datetime(2026, 9, 15, 20, 10, tzinfo=timezone.utc)

    with engine.begin() as conn:
        conn.execute(
            cell_stats.insert().values(
                cell_id=key,
                observation_count=20,
                distinct_days=6,
                median_frp_mw=1.5,
                p90_frp_mw=9.0,
                mad_frp_mw=0.3,
                median_dual_band_k=27.0,
                night_fraction=0.6,
                first_seen=now - timedelta(days=6),
                last_seen=now,
                window_days=7,
                computed_at=now,
                code_version="test",
            )
        )
        conn.execute(
            cell_context.insert().values(
                cell_id=key,
                nearest_facility_id="f1",
                nearest_facility_name="Test industrial area",
                nearest_facility_category="industrial",
                distance_to_facility_m=480.0,
                facilities_within_5km=6,
                land_cover="industrial",
                context_coverage=coverage,
                computed_at=now,
                code_version="test",
            )
        )
        conn.execute(
            cell_labels.insert().values(
                cell_id=key,
                label=label,
                label_rule_version="rule-v1",
                rationale=[{"criterion": "recurrence", "passed": True}],
                computed_at=now,
            )
        )
    return detection


# ------------------------------------------------------------- empty state --


def test_health_on_empty_database_is_degraded_with_guidance(client):
    test_client, _ = client
    body = test_client.get("/api/health").json()

    assert body["status"] == "degraded"
    assert body["detections_stored"] == 0
    assert body["model_trained"] is False
    # Degraded must explain what to do, not merely assert a colour.
    assert any("pipeline ingest" in note for note in body["notes"])


def test_hotspots_on_empty_database_returns_an_empty_collection(client):
    test_client, _ = client
    body = test_client.get("/api/hotspots").json()

    assert body["count"] == 0
    assert body["total_matching"] == 0
    assert body["hotspots"] == []
    # No data must never be described as live data.
    assert body["provenance"]["data_source"] == "none"
    assert body["provenance"]["is_live"] is False


def test_analytics_on_empty_database_does_not_error(client):
    test_client, _ = client
    body = test_client.get("/api/analytics").json()
    assert body["total_detections"] == 0
    assert body["flagged_for_investigation"] == 0
    assert len(body["by_class"]) == 4


# ---------------------------------------------------------------- listing --


def test_hotspots_returns_seeded_detection(client):
    test_client, engine = client
    seed_cell(engine, label="persistent_industrial")

    body = test_client.get("/api/hotspots").json()
    assert body["count"] == 1
    assert body["hotspots"][0]["label"] == "persistent_industrial"
    assert body["hotspots"][0]["distinct_days"] == 6


def test_label_filter_excludes_other_classes(client):
    test_client, engine = client
    seed_cell(engine, label="persistent_industrial")

    assert test_client.get("/api/hotspots", params={"label": "natural_fire"}).json()["count"] == 0
    assert (
        test_client.get("/api/hotspots", params={"label": "persistent_industrial"}).json()["count"]
        == 1
    )


def test_min_frp_filter(client):
    test_client, engine = client
    seed_cell(engine, label="persistent_industrial")  # frp 2.4 MW by default

    assert test_client.get("/api/hotspots", params={"min_frp_mw": 1.0}).json()["count"] == 1
    assert test_client.get("/api/hotspots", params={"min_frp_mw": 50.0}).json()["count"] == 0


def test_pagination_reports_total_separately_from_page_size(client):
    test_client, engine = client
    seed_cell(engine, label="persistent_industrial")
    insert_detection(engine, latitude=23.7551, longitude=86.4051, satellite_code="N20")

    body = test_client.get("/api/hotspots", params={"limit": 1}).json()
    assert body["count"] == 1
    assert body["total_matching"] == 2
    assert body["limit"] == 1


def test_invalid_label_is_rejected(client):
    test_client, _ = client
    assert test_client.get("/api/hotspots", params={"label": "volcano"}).status_code == 422


def test_limit_above_cap_is_rejected(client):
    """An unbounded limit is a trivial memory-exhaustion vector."""
    test_client, _ = client
    assert test_client.get("/api/hotspots", params={"limit": 999999}).status_code == 422


@pytest.mark.parametrize(
    "bbox",
    [
        "not,a,bbox,here",
        "68,6,98",
        "98,6,68,37.5",  # min_lon above max_lon
        "68,37.5,98,6",  # min_lat above max_lat
    ],
)
def test_malformed_bbox_is_rejected(client, bbox):
    test_client, _ = client
    assert test_client.get("/api/hotspots", params={"bbox": bbox}).status_code == 422


def test_valid_bbox_filters_geographically(client):
    test_client, engine = client
    seed_cell(engine, label="persistent_industrial")

    inside = test_client.get("/api/hotspots", params={"bbox": "86,23,87,24"}).json()
    outside = test_client.get("/api/hotspots", params={"bbox": "69,22,70,23"}).json()
    assert inside["count"] == 1
    assert outside["count"] == 0


# ----------------------------------------------------------------- detail --


def test_detail_separates_measurement_from_inference(client):
    test_client, engine = client
    detection = seed_cell(engine, label="industrial_fire")

    body = test_client.get(f"/api/hotspots/{detection}").json()

    # Three distinct objects: what was measured, what we computed, what we inferred.
    assert body["observation"]["frp_mw"] == pytest.approx(2.4)
    assert body["persistence"]["distinct_days"] == 6
    assert body["classification"]["label"] == "industrial_fire"

    # A rule decision must carry no probability.
    assert body["classification"]["source"] == "rule"
    assert body["classification"]["confidence"] is None

    assert "not proof" in body["caution"]
    assert len(body["evidence"]) >= 3
    assert {e["kind"] for e in body["evidence"]} <= {"observed", "derived", "absent"}


def test_detail_marks_unsurveyed_coverage(client):
    test_client, engine = client
    detection = seed_cell(engine, label="unknown", coverage="not_surveyed")

    body = test_client.get(f"/api/hotspots/{detection}").json()
    assert body["context"]["coverage"] == "not_surveyed"
    assert any(
        "not been surveyed" in e["statement"] and e["kind"] == "absent"
        for e in body["evidence"]
    )


def test_unknown_detection_id_is_404(client):
    test_client, _ = client
    assert test_client.get("/api/hotspots/does-not-exist").status_code == 404


def test_detail_id_is_not_vulnerable_to_path_tricks(client):
    test_client, _ = client
    response = test_client.get("/api/hotspots/..%2F..%2Fetc%2Fpasswd")
    assert response.status_code in (404, 422)


# ------------------------------------------------------------------- meta --


def test_datasets_declare_licence_and_limitations(client):
    test_client, _ = client
    body = test_client.get("/api/datasets").json()

    assert len(body) >= 4
    for dataset in body:
        assert dataset["licence"]
        assert dataset["limitations"], f"{dataset['id']} declares no limitations"
        assert dataset["kind"] in ("observed", "derived", "synthetic")


def test_firms_dataset_records_that_no_key_is_needed(client):
    test_client, _ = client
    body = test_client.get("/api/datasets").json()
    firms = next(d for d in body if d["id"] == "firms_viirs_snpp")
    assert firms["requires_credentials"] is False
    assert any("not proof" in lim or "not automatic" in lim.lower() for lim in firms["limitations"])


def test_model_info_is_honest_when_untrained(client):
    test_client, _ = client
    body = test_client.get("/api/model-info").json()
    assert body["trained"] is False
    assert body["model_version"] is None
    assert "rules" in body["caveat"]


def test_rules_endpoint_exposes_thresholds_and_the_embargo(client):
    test_client, _ = client
    body = test_client.get("/api/rules").json()

    assert body["thresholds"]["persistent_min_distinct_days"] == 4
    assert body["thresholds"]["industrial_proximity_m"] == 3000.0
    assert body["thresholds"]["model_abstain_below"] == ml.ABSTAIN_BELOW
    # With no model loaded there is nothing to suppress, but the policy must
    # still be stated so a client knows suppression exists at all.
    assert body["suppressed_model_classes"] == {}
    assert "precision" in body["authority"]


def test_runs_endpoint_returns_the_audit_trail(client):
    test_client, engine = client
    seed_cell(engine, label="persistent_industrial")

    body = test_client.get("/api/runs").json()
    assert len(body) >= 1
    assert body[0]["status"] == "success"


def test_runs_limit_is_validated(client):
    test_client, _ = client
    assert test_client.get("/api/runs", params={"limit": 0}).status_code == 422
    assert test_client.get("/api/runs", params={"limit": 5000}).status_code == 422


def test_every_response_carries_a_request_id(client):
    test_client, _ = client
    response = test_client.get("/api/health")
    assert response.headers.get("X-Request-ID")


# ------------------------------------------------------------ provenance --


def test_old_data_is_reported_as_stale_not_live(client):
    """The archives span 7 days, so a week-old newest record is historical.
    Describing it as live would be the most damaging small lie available."""
    test_client, engine = client
    old = datetime.now(timezone.utc) - timedelta(days=5)
    insert_detection(engine, acquired_at=old)

    provenance = test_client.get("/api/hotspots").json()["provenance"]
    assert provenance["is_live"] is False
    assert provenance["stale"] is True
    assert provenance["age_of_newest_hours"] > 100


def test_recent_data_is_reported_as_live(client):
    test_client, engine = client
    insert_detection(engine, acquired_at=datetime.now(timezone.utc) - timedelta(hours=2))

    provenance = test_client.get("/api/hotspots").json()["provenance"]
    assert provenance["is_live"] is True
    assert provenance["stale"] is False


def test_coverage_note_quantifies_surveyed_cells(client):
    test_client, engine = client
    seed_cell(engine, label="persistent_industrial")

    provenance = test_client.get("/api/hotspots").json()["provenance"]
    assert provenance["surveyed_cells"] == 1
    assert provenance["unsurveyed_cells"] == 0
    assert "surveyed industrial context" in provenance["coverage_note"]
