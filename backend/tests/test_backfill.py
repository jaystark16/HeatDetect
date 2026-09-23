"""Keyed backfill: window-relative persistence, and key hygiene.

Two things are tested here that nothing else covers:

1. The persistence threshold must scale with how much history exists. A fixed
   "4 distinct days" means 57% of a 7-day archive window but 6.5% of a 61-day
   backfilled one — the same label would quietly change meaning with the amount
   of data ingested.
2. The MAP_KEY must never reach the audit table, the logs or /api/runs. The
   keyed endpoint puts the key in the URL path, so the recorded URL has to be
   scrubbed rather than stored verbatim.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from conftest import make_context, make_stats

from app.ingest import firms
from app.labels import (
    PERSISTENT_MIN_DAY_FRACTION,
    PERSISTENT_MIN_DISTINCT_DAYS,
    assign_label,
    persistent_day_threshold,
)

BBOX = (68.0, 6.0, 97.0, 36.0)
FAKE_KEY = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"  # pragma: fake-credential


# ------------------------------------------- window-relative persistence --


@pytest.mark.parametrize(
    ("window", "expected"),
    [
        (1, PERSISTENT_MIN_DISTINCT_DAYS),   # floor dominates
        (7, PERSISTENT_MIN_DISTINCT_DAYS),   # 25% of 7 = 2, floor of 4 wins
        (16, 4),                             # 25% of 16 = 4, they meet
        (40, 10),
        (61, 16),
        (90, 23),
    ],
)
def test_threshold_scales_with_available_history(window, expected):
    assert persistent_day_threshold(window) == expected


def test_threshold_never_drops_below_the_floor():
    for window in range(0, 20):
        assert persistent_day_threshold(window) >= PERSISTENT_MIN_DISTINCT_DAYS


def test_threshold_tracks_the_declared_fraction():
    assert persistent_day_threshold(100) == int(PERSISTENT_MIN_DAY_FRACTION * 100)


def test_same_cell_changes_class_as_the_window_grows():
    """The point of the whole change: six days of recurrence is strong evidence
    over a week and weak evidence over two months, and the label must say so."""
    stats = make_stats(distinct_days=6, observations=30)
    context = make_context(distance_m=500.0)

    assert assign_label(stats, context, 7).label == "persistent_industrial"
    assert assign_label(stats, context, 61).label == "unknown"


def test_a_genuinely_persistent_cell_survives_a_long_window():
    stats = make_stats(distinct_days=40, observations=200)
    assert (
        assign_label(stats, make_context(distance_m=500.0), 61).label
        == "persistent_industrial"
    )


def test_rationale_records_the_threshold_actually_applied():
    decision = assign_label(make_stats(distinct_days=6), make_context(), 61)
    recurrence = next(
        c for c in decision.rationale if c["criterion"] == "recurrence"
    )
    assert recurrence["threshold_days"] == 16
    assert recurrence["global_window_days"] == 61


def test_default_window_preserves_the_original_behaviour():
    """Callers that predate the change must be unaffected."""
    stats = make_stats(distinct_days=4, observations=20)
    assert assign_label(stats, make_context(distance_m=500.0)).label == (
        "persistent_industrial"
    )


# --------------------------------------------------------- key handling --


class _Response:
    def __init__(self, text: str) -> None:
        self.text = text
        self.content = text.encode()

    def raise_for_status(self) -> None:
        return None


class _Client:
    def __init__(self, text: str) -> None:
        self._text = text
        self.requested: list[str] = []

    def get(self, url: str) -> _Response:
        self.requested.append(url)
        return _Response(self._text)

    def close(self) -> None:
        return None


HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "instrument,confidence,version,bright_ti5,frp,daynight"
)
ROW = "23.75,86.40,330.1,0.4,0.4,2026-09-01,2010,N,VIIRS,n,2.0NRT,302.8,2.4,N"


def test_map_key_is_sent_but_never_recorded():
    client = _Client(f"{HEADER}\n{ROW}\n")
    result = firms.fetch_area(
        firms.PRODUCTS[0],
        map_key=FAKE_KEY,
        days=5,
        start_date="2026-09-01",
        bbox=BBOX,
        client=client,  # type: ignore[arg-type]
    )
    # The key must reach FIRMS...
    assert FAKE_KEY in client.requested[0]
    # ...and must not reach anything we persist or display.
    assert FAKE_KEY not in result.url
    assert "<MAP_KEY>" in result.url


def test_missing_key_raises_and_points_at_the_keyless_path():
    with pytest.raises(firms.FirmsUnavailable, match="open archives need none"):
        firms.fetch_area(
            firms.PRODUCTS[0], map_key="", days=5, bbox=BBOX, client=_Client("")  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("days", [0, 6, 7, 10, -1])
def test_day_range_outside_the_endpoint_limit_is_refused_locally(days):
    """Better to fail here than to send it and have FIRMS answer HTTP 200 with
    an error string in the body."""
    with pytest.raises(ValueError, match="1..5"):
        firms.fetch_area(
            firms.PRODUCTS[0],
            map_key=FAKE_KEY,
            days=days,
            bbox=BBOX,
            client=_Client(""),  # type: ignore[arg-type]
        )


def test_plain_text_error_body_raises_rather_than_looking_empty():
    """The measured failure mode: HTTP 200 with the body
    'Invalid day range. Expects [1..5].' A status-code-only check reads that as
    a successful empty region."""
    client = _Client("Invalid day range. Expects [1..5].")
    with pytest.raises(firms.FirmsUnavailable, match="did not return a FIRMS CSV"):
        firms.fetch_area(
            firms.PRODUCTS[0],
            map_key=FAKE_KEY,
            days=5,
            bbox=BBOX,
            client=client,  # type: ignore[arg-type]
        )


def test_keyed_rows_parse_despite_the_extra_instrument_column():
    """The keyed endpoint returns an `instrument` column the archives omit.
    Parsing is by column name, so it must simply be ignored."""
    client = _Client(f"{HEADER}\n{ROW}\n")
    result = firms.fetch_area(
        firms.PRODUCTS[0],
        map_key=FAKE_KEY,
        days=5,
        bbox=BBOX,
        client=client,  # type: ignore[arg-type]
    )
    detections, report = firms.parse(result)
    assert report.accepted == 1
    assert detections[0].acquired_at == datetime(2026, 9, 1, 20, 10, tzinfo=timezone.utc)
    assert detections[0].frp_mw == pytest.approx(2.4)


def test_every_product_has_a_keyed_name():
    assert set(firms.API_PRODUCT_NAMES) == {p.id for p in firms.PRODUCTS}
