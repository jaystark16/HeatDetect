"""Search endpoint.

Search is the one place free user text reaches a SQL pattern, so the tests focus
on that: wildcards must be escaped, injection must be inert, and a near-miss
must produce an explanation rather than a confident guess.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import main as api_main
from app import model as ml
from app.db import build_engine, facilities, init_schema
from app.geo import cell_id
from app.service import _escape_like


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite+pysqlite:///{tmp_path / 'search.db'}")
    init_schema(engine)
    monkeypatch.setattr(ml, "load", lambda: None)

    named = [
        ("Belpahar Coal Mine", "mining", 21.76, 83.83),
        ("Jamnagar Refinery", "oil", 22.34, 69.87),
        ("Bhilai Steel Plant", "steel", 21.20, 81.38),
        # 100% literal wildcards in a name, to prove escaping works both ways.
        ("100% Pure Works", "works", 20.00, 80.00),
    ]
    with engine.begin() as conn:
        for i, (name, category, lat, lon) in enumerate(named):
            conn.execute(
                facilities.insert().values(
                    facility_id=f"f{i}",
                    osm_type="way",
                    osm_id=str(i),
                    name=name,
                    category=category,
                    source_tag="landuse=industrial",
                    latitude=lat,
                    longitude=lon,
                    cell_id=cell_id(lat, lon),
                    dataset_id="osm_industrial",
                    fetched_at=datetime.now(timezone.utc),
                )
            )
        # An unnamed polygon must never appear in results.
        conn.execute(
            facilities.insert().values(
                facility_id="unnamed",
                osm_type="way",
                osm_id="999",
                name=None,
                category="industrial",
                source_tag="landuse=industrial",
                latitude=23.0,
                longitude=86.0,
                cell_id=cell_id(23.0, 86.0),
                dataset_id="osm_industrial",
                fetched_at=datetime.now(timezone.utc),
            )
        )

    with TestClient(api_main.app) as test_client:
        api_main.state.engine = engine
        api_main.state.model = None
        yield test_client


# --------------------------------------------------------- coordinates --


@pytest.mark.parametrize("q", ["23.755, 86.405", "23.755 86.405", "  23.755,86.405  "])
def test_coordinate_forms_parse(client, q):
    body = client.get("/api/search", params={"q": q}).json()
    assert body["count"] == 1
    match = body["matches"][0]
    assert match["kind"] == "coordinates"
    assert match["latitude"] == pytest.approx(23.755)
    assert match["longitude"] == pytest.approx(86.405)


def test_negative_coordinates_parse(client):
    body = client.get("/api/search", params={"q": "-33.9, 18.4"}).json()
    assert body["matches"][0]["latitude"] == pytest.approx(-33.9)


def test_out_of_range_coordinates_are_refused_with_an_explanation(client):
    body = client.get("/api/search", params={"q": "91.5, 10.0"}).json()
    assert body["count"] == 0
    assert "out of range" in body["note"]


# ------------------------------------------------------------ facility --


def test_facility_name_substring_match(client):
    body = client.get("/api/search", params={"q": "belpahar"}).json()
    assert body["count"] == 1
    assert body["matches"][0]["kind"] == "facility"
    assert body["matches"][0]["label"] == "Belpahar Coal Mine"
    assert "mining" in body["matches"][0]["detail"]


def test_match_is_case_insensitive(client):
    for q in ("REFINERY", "refinery", "Refinery"):
        assert client.get("/api/search", params={"q": q}).json()["count"] == 1


def test_unnamed_facilities_are_never_returned(client):
    """An unnamed polygon has nothing to match, and returning it would show the
    user a result with no label."""
    body = client.get("/api/search", params={"q": "industrial"}).json()
    assert all(m["label"] for m in body["matches"])


def test_no_match_explains_what_is_searchable(client):
    body = client.get("/api/search", params={"q": "Atlantis"}).json()
    assert body["count"] == 0
    assert "coordinate" in body["note"].lower()
    assert "facility" in body["note"].lower()


# ------------------------------------------------- wildcards and safety --


def test_percent_is_escaped_not_treated_as_a_wildcard(client):
    """Unescaped, '%' matched every named facility — user text must not become
    pattern syntax."""
    body = client.get("/api/search", params={"q": "%"}).json()
    # Only the facility whose name literally contains '%'.
    assert body["count"] == 1
    assert body["matches"][0]["label"] == "100% Pure Works"


def test_underscore_is_escaped(client):
    """'_' matches any single character in LIKE; escaped it matches nothing here."""
    body = client.get("/api/search", params={"q": "_"}).json()
    assert body["count"] == 0


@pytest.mark.parametrize(
    "payload",
    [
        "'; DROP TABLE facilities; --",
        "' OR 1=1 --",
        "' UNION SELECT name FROM facilities --",
        "<script>alert(1)</script>",
        "../../etc/passwd",
    ],
)
def test_injection_payloads_are_inert(client, payload):
    response = client.get("/api/search", params={"q": payload})
    assert response.status_code == 200
    assert response.json()["count"] == 0
    # And the table survives.
    assert client.get("/api/search", params={"q": "belpahar"}).json()["count"] == 1


def test_escape_like_helper():
    # Built from chr(92) rather than written as literals: the expected values
    # are unambiguous, and nothing here depends on how a tool escaped the file.
    bs = chr(92)
    assert _escape_like("100%") == "100" + bs + "%"
    assert _escape_like("a_b") == "a" + bs + "_b"
    assert _escape_like("back" + bs + "slash") == "back" + bs * 2 + "slash"
    assert _escape_like("plain") == "plain"


# ---------------------------------------------------------- validation --


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"q": ""}, 422),
        ({"q": "x" * 121}, 422),
        ({"q": "belpahar", "limit": 0}, 422),
        ({"q": "belpahar", "limit": 26}, 422),
        ({"q": "belpahar", "limit": 5}, 200),
    ],
)
def test_parameter_validation(client, params, expected):
    assert client.get("/api/search", params=params).status_code == expected


def test_limit_caps_results(client):
    body = client.get("/api/search", params={"q": "a", "limit": 2}).json()
    assert len(body["matches"]) <= 2


def test_results_include_navigable_coordinates(client):
    for m in client.get("/api/search", params={"q": "plant"}).json()["matches"]:
        assert -90 <= m["latitude"] <= 90
        assert -180 <= m["longitude"] <= 180
