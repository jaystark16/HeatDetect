"""FIRMS parsing.

The contract under test is not "does it parse valid rows" — it is **does it
refuse to invent data**. Every malformed row must be rejected and counted, never
coerced into a plausible-looking detection.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.ingest.firms import (
    PRODUCTS,
    FetchResult,
    FirmsUnavailable,
    Product,
    parse,
)

VIIRS_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "confidence,version,bright_ti5,frp,daynight"
)
MODIS_HEADER = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,"
    "confidence,version,bright_t31,frp,daynight"
)

VIIRS_PRODUCT = PRODUCTS[0]
MODIS_PRODUCT = next(p for p in PRODUCTS if p.instrument == "MODIS")


def wrap(body: str, product: Product = VIIRS_PRODUCT) -> FetchResult:
    return FetchResult(
        product=product,
        window="24h",
        url="https://example.invalid/test.csv",
        fetched_at=datetime(2026, 9, 18, 8, 0, tzinfo=timezone.utc),
        body=body,
        byte_count=len(body),
    )


def viirs_row(**overrides: str) -> str:
    fields = {
        "latitude": "23.75512",
        "longitude": "86.40531",
        "bright_ti4": "330.15",
        "scan": "0.39",
        "track": "0.45",
        "acq_date": "2026-09-17",
        "acq_time": "2010",
        "satellite": "N21",
        "confidence": "nominal",
        "version": "2.0NRT",
        "bright_ti5": "302.80",
        "frp": "2.41",
        "daynight": "N",
    }
    fields.update(overrides)
    return ",".join(fields[k] for k in VIIRS_HEADER.split(","))


def test_parses_a_valid_viirs_row():
    detections, report = parse(wrap(f"{VIIRS_HEADER}\n{viirs_row()}\n"))

    assert report.rows_seen == 1
    assert report.accepted == 1
    assert report.rejected == 0

    d = detections[0]
    assert d.latitude == pytest.approx(23.75512)
    assert d.frp_mw == pytest.approx(2.41)
    assert d.instrument == "VIIRS"
    assert d.satellite_name == "NOAA-21"
    assert d.day_night == "N"
    # Timestamp is UTC, built from the date plus an HHMM string.
    assert d.acquired_at == datetime(2026, 9, 17, 20, 10, tzinfo=timezone.utc)


def test_dual_band_delta_is_the_channel_difference():
    detections, _ = parse(wrap(f"{VIIRS_HEADER}\n{viirs_row()}\n"))
    assert detections[0].dual_band_delta_k == pytest.approx(330.15 - 302.80)


def test_acq_time_is_zero_padded():
    """FIRMS writes 0610 as '610' in some rows; naive slicing would misread it."""
    detections, _ = parse(
        wrap(f"{VIIRS_HEADER}\n{viirs_row(acq_time='610')}\n")
    )
    assert detections[0].acquired_at.hour == 6
    assert detections[0].acquired_at.minute == 10


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"latitude": "not-a-number"}, "unparseable_coordinates"),
        ({"latitude": ""}, "unparseable_coordinates"),
        ({"latitude": "91.5"}, "coordinates_out_of_range"),
        ({"longitude": "-181.0"}, "coordinates_out_of_range"),
        ({"acq_date": "17/09/2026"}, "unparseable_timestamp"),
        ({"acq_time": "abcd"}, "unparseable_timestamp"),
        ({"frp": "-3.2"}, "negative_frp"),
        ({"frp": "nan-ish"}, "unparseable_thermal_values"),
        ({"bright_ti4": ""}, "unparseable_thermal_values"),
        ({"bright_ti4": "120.0"}, "implausible_brightness"),
        ({"bright_ti5": "3.0"}, "implausible_brightness"),
        ({"daynight": "X"}, "unknown_daynight"),
        ({"daynight": ""}, "unknown_daynight"),
    ],
)
def test_malformed_rows_are_rejected_with_a_reason(overrides, reason):
    detections, report = parse(
        wrap(f"{VIIRS_HEADER}\n{viirs_row(**overrides)}\n")
    )

    assert detections == []
    assert report.rejected == 1
    assert report.reject_reasons[reason] == 1
    assert report.accepted == 0


def test_future_timestamps_are_rejected():
    """A future acquisition means a broken feed; accepting it would corrupt
    every 'most recent detection' claim in the system."""
    tomorrow = datetime.now(timezone.utc) + timedelta(days=1)
    detections, report = parse(
        wrap(
            f"{VIIRS_HEADER}\n"
            f"{viirs_row(acq_date=tomorrow.strftime('%Y-%m-%d'), acq_time='1200')}\n"
        )
    )
    assert detections == []
    assert report.reject_reasons["timestamp_in_future"] == 1


def test_zero_frp_is_accepted():
    """0 MW is a legitimate reading; only negatives are physically impossible."""
    detections, report = parse(wrap(f"{VIIRS_HEADER}\n{viirs_row(frp='0.0')}\n"))
    assert report.accepted == 1
    assert detections[0].frp_mw == 0.0


def test_mixed_valid_and_invalid_rows_are_counted_separately():
    body = "\n".join(
        [
            VIIRS_HEADER,
            viirs_row(),
            viirs_row(frp="-1"),
            viirs_row(latitude="23.9"),
            viirs_row(daynight="Q"),
            "",
        ]
    )
    detections, report = parse(wrap(body))

    assert report.rows_seen == 4
    assert report.accepted == 2
    assert report.rejected == 2
    assert report.acceptance_rate == pytest.approx(0.5)
    assert len(detections) == 2


def test_report_summary_names_the_worst_reasons():
    body = "\n".join([VIIRS_HEADER, viirs_row(frp="-1"), viirs_row(frp="-2")])
    _, report = parse(wrap(body))
    summary = report.summary()
    assert "negative_frp=2" in summary
    assert "0/2 rows accepted" in summary


def test_empty_file_yields_no_detections_and_no_rejects():
    detections, report = parse(wrap(f"{VIIRS_HEADER}\n"))
    assert detections == []
    assert report.rows_seen == 0
    assert report.accepted == 0
    # An empty region is a legitimate fact; it must not look like a failure.
    assert report.rejected == 0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("low", "low"), ("l", "low"), ("nominal", "nominal"), ("high", "high"), ("h", "high")],
)
def test_viirs_confidence_tiers(raw, expected):
    detections, _ = parse(wrap(f"{VIIRS_HEADER}\n{viirs_row(confidence=raw)}\n"))
    assert detections[0].confidence_tier == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("0", "low"), ("29", "low"), ("30", "nominal"), ("79", "nominal"), ("80", "high"), ("100", "high")],
)
def test_modis_numeric_confidence_is_binned(raw, expected):
    """MODIS publishes 0-100 where VIIRS publishes a category. The binning is
    our convention, and the raw value is preserved alongside it."""
    row = ",".join(
        [
            "22.36141",
            "91.36697",
            "312.89",
            "3.55",
            "1.77",
            "2026-09-17",
            "0325",
            "T",
            raw,
            "6.1NRT",
            "291.08",
            "40.97",
            "D",
        ]
    )
    # parse() takes the instrument from the product, so the MODIS product is
    # required for the MODIS column names to be read.
    detections, report = parse(wrap(f"{MODIS_HEADER}\n{row}\n", MODIS_PRODUCT))
    assert report.accepted == 1
    assert detections[0].confidence_tier == expected
    assert detections[0].confidence_raw == raw
    assert detections[0].instrument == "MODIS"


def test_unrecognised_payload_is_refused_not_parsed():
    """An HTML error page must raise, not silently yield zero detections."""
    from app.ingest.firms import fetch  # noqa: PLC0415

    class FakeResponse:
        text = "<!DOCTYPE html><html><body>Service unavailable</body></html>"
        content = text.encode()

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def get(self, _url: str) -> FakeResponse:
            return FakeResponse()

        def close(self) -> None:
            return None

    with pytest.raises(FirmsUnavailable, match="did not return a FIRMS CSV header"):
        fetch(VIIRS_PRODUCT, "24h", client=FakeClient())  # type: ignore[arg-type]


def test_product_urls_use_the_requested_window():
    assert "South_Asia_7d.csv" in VIIRS_PRODUCT.url("7d")
    assert "South_Asia_24h.csv" in VIIRS_PRODUCT.url("24h")
