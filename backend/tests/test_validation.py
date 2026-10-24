"""The blind hand-check: sampling on the real snapshot, scoring arithmetic, links."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from app.validation import (
    DEFAULT_TARGETS,
    FIRE_LAYERS,
    LABELS,
    draw_sample,
    google_pin,
    google_satellite,
    report,
    score,
    sheet_rows,
    wilson,
    worldview,
)

SNAPSHOT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "snapshot.json"


@pytest.fixture(scope="module")
def locations():
    if not SNAPSHOT.exists():
        pytest.skip("snapshot.json not built; run scripts/export_snapshot.py")
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))["locations"]


def test_the_draw_takes_each_class_up_to_its_target(locations):
    chosen = draw_sample(locations, DEFAULT_TARGETS, seed=7)
    available = Counter(loc["label"] for loc in locations)
    drawn = Counter(loc["label"] for loc in chosen)
    for label, target in DEFAULT_TARGETS.items():
        assert drawn[label] == min(target, available[label])
    assert len({loc["representative_detection_id"] for loc in chosen}) == len(chosen)


def test_the_same_seed_draws_the_same_places(locations):
    a = [loc["representative_detection_id"] for loc in draw_sample(locations, DEFAULT_TARGETS, seed=7)]
    b = [loc["representative_detection_id"] for loc in draw_sample(locations, DEFAULT_TARGETS, seed=7)]
    c = [loc["representative_detection_id"] for loc in draw_sample(locations, DEFAULT_TARGETS, seed=8)]
    assert a == b and a != c


def test_the_sheet_order_reveals_no_class(locations):
    chosen = draw_sample(locations, DEFAULT_TARGETS, seed=7)
    labels = [loc["label"] for loc in chosen]
    # Grouped by class, the first quarter would be one class; shuffled, it is not.
    assert len(set(labels[: len(labels) // 4])) > 1


def test_the_blind_sheet_carries_no_system_answer(locations):
    sample, key = sheet_rows(draw_sample(locations, DEFAULT_TARGETS, seed=7))
    blind_text = json.dumps(sample)
    for cls in ("industrial_fire", "persistent_industrial", "natural_fire", "unknown"):
        assert cls not in blind_text
    assert [r["sample_id"] for r in sample] == [r["sample_id"] for r in key]
    assert all(not r["human_label"] for r in sample)


def test_google_pin_link_is_the_documented_search_form():
    url = urlparse(google_pin(17.60913, 83.20387))
    assert (url.netloc, url.path) == ("www.google.com", "/maps/search/")
    assert parse_qs(url.query) == {"api": ["1"], "query": ["17.60913,83.20387"]}


def test_google_link_is_the_documented_satellite_form():
    url = urlparse(google_satellite(17.60913, 83.20387))
    q = parse_qs(url.query)
    assert url.netloc == "www.google.com" and url.path == "/maps/@"
    assert q == {
        "api": ["1"],
        "map_action": ["map"],
        "center": ["17.60913,83.20387"],
        "zoom": ["16"],
        "basemap": ["satellite"],
    }


def test_worldview_link_frames_the_point_on_its_day():
    q = parse_qs(urlparse(worldview(17.6, 83.2, "2026-10-23", FIRE_LAYERS)).query)
    west, south, east, north = map(float, q["v"][0].split(","))
    assert west < 83.2 < east and south < 17.6 < north
    assert q["t"] == ["2026-10-23-T00:00:00Z"]
    assert q["l"][0].split(",") == list(FIRE_LAYERS)


@pytest.mark.parametrize(
    "agreed,checked,expected",
    [(8, 10, (0.4902, 0.9433)), (0, 10, (0.0, 0.2775)), (50, 50, (0.9287, 1.0))],
)
def test_wilson_interval_matches_known_values(agreed, checked, expected):
    interval = wilson(agreed, checked)
    assert interval is not None
    low, high = interval
    assert low == pytest.approx(expected[0], abs=1e-3)
    assert high == pytest.approx(expected[1], abs=1e-3)


def test_wilson_with_nothing_checked_is_none():
    assert wilson(0, 0) is None


def _rows(pairs):
    sample = [{"sample_id": f"V{i:03d}", "human_label": label} for i, (_, label) in enumerate(pairs)]
    key = [{"sample_id": f"V{i:03d}", "system_class": cls} for i, (cls, _) in enumerate(pairs)]
    return sample, key


def test_precision_counts_only_decisive_checks():
    sample, key = _rows(
        [
            ("persistent_industrial", "industrial"),
            ("persistent_industrial", "industrial"),
            ("persistent_industrial", "vegetation"),
            ("persistent_industrial", "cannot_tell"),
            ("persistent_industrial", ""),
            ("industrial_fire", "Industrial "),
            ("natural_fire", "vegetation"),
            ("natural_fire", "industrial"),
        ]
    )
    s = score(sample, key)
    p = s["persistent_industrial"]
    assert (p.drawn, p.checked, p.agreed, p.cannot_tell, p.pending) == (5, 3, 2, 1, 1)
    assert (s["industrial_fire"].checked, s["industrial_fire"].agreed) == (1, 1)
    assert (s["natural_fire"].checked, s["natural_fire"].agreed) == (2, 1)
    assert "67%" in report(s)


def test_unclassified_places_report_what_they_turned_out_to_be():
    sample, key = _rows([("unknown", "industrial"), ("unknown", "vegetation"), ("unknown", "industrial")])
    text = report(score(sample, key))
    assert "Unclassified locations, as checked: industrial 2, vegetation 1." in text


def test_a_mistyped_label_fails_loudly():
    sample, key = _rows([("natural_fire", "vegitation")])
    with pytest.raises(ValueError, match="vegitation"):
        score(sample, key)


def test_a_sample_row_without_a_key_fails_loudly():
    sample, _ = _rows([("natural_fire", "vegetation")])
    with pytest.raises(ValueError, match="no key entry"):
        score(sample, [])


def test_labels_are_the_documented_four():
    assert LABELS == ("industrial", "vegetation", "other", "cannot_tell")
