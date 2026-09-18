"""API contract tests.

These guard the response shapes the frontend depends on, so later phases can
swap sample data for FIRMS ingestion without silently breaking the dashboard.
"""

from fastapi.testclient import TestClient

from app.main import app
from app.schemas import ThermalClass

client = TestClient(app)


def test_health_reports_phase_0_state() -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    # Without a FIRMS key the API must say so rather than implying live data.
    assert body["data_source"] == "sample"


def test_hotspots_returns_a_labelled_collection() -> None:
    body = client.get("/api/hotspots").json()
    assert body["count"] == len(body["hotspots"])
    assert body["count"] > 0
    assert body["data_source"] == "sample"


def test_every_hotspot_carries_a_classification_and_evidence() -> None:
    for hotspot in client.get("/api/hotspots").json()["hotspots"]:
        cls = hotspot["classification"]
        assert cls is not None, f"{hotspot['id']} has no classification"
        assert 0.0 <= cls["confidence"] <= 1.0
        assert cls["evidence"], f"{hotspot['id']} has no evidence lines"


def test_class_filter_only_returns_that_class() -> None:
    body = client.get(
        "/api/hotspots", params={"predicted_class": "natural_fire"}
    ).json()
    assert body["count"] > 0
    assert all(
        h["classification"]["predicted_class"] == "natural_fire"
        for h in body["hotspots"]
    )


def test_confidence_filter_excludes_low_confidence() -> None:
    body = client.get("/api/hotspots", params={"min_confidence": 0.9}).json()
    assert all(h["classification"]["confidence"] >= 0.9 for h in body["hotspots"])


def test_results_are_newest_first() -> None:
    times = [h["acquired_at"] for h in client.get("/api/hotspots").json()["hotspots"]]
    assert times == sorted(times, reverse=True)


def test_unknown_hotspot_id_is_404() -> None:
    assert client.get("/api/hotspots/no-such-id").status_code == 404


def test_analytics_counts_match_the_collection() -> None:
    hotspots = client.get("/api/hotspots").json()["hotspots"]
    stats = client.get("/api/analytics").json()

    assert stats["total_hotspots"] == len(hotspots)
    assert set(stats["by_class"]) == {c.value for c in ThermalClass}
    assert sum(stats["by_class"].values()) == len(hotspots)


def test_persistence_separates_flares_from_the_anomaly() -> None:
    """The project's core claim, asserted rather than assumed.

    A routine flare sits near its own baseline; the anomaly departs from it.
    If this ever stops holding, the classification story is broken.
    """
    by_class: dict[str, list[dict]] = {}
    for hotspot in client.get("/api/hotspots").json()["hotspots"]:
        by_class.setdefault(hotspot["classification"]["predicted_class"], []).append(
            hotspot
        )

    for flare in by_class["persistent_industrial"]:
        assert flare["context"]["frp_ratio"] < 2.0
        assert flare["context"]["detections_30d"] >= 10

    for fire in by_class["industrial_fire"]:
        assert fire["context"]["frp_ratio"] > 3.0

    for natural in by_class["natural_fire"]:
        assert natural["context"]["baseline_frp_mw"] is None
        assert natural["context"]["detections_30d"] < 10


def test_model_info_does_not_claim_a_trained_model() -> None:
    body = client.get("/api/model-info").json()
    assert body["trained"] is False
