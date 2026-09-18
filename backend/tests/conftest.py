"""Shared fixtures.

All fixture data here is **synthetic and clearly scoped to tests**. It never
reaches a served response: the production code paths read from the database that
the pipeline fills from NASA FIRMS and OpenStreetMap.

Values are nonetheless chosen to match the real measured distribution (FRP
median ~1.6 MW, p99 ~18 MW, dual-band delta 10-77 K), because fixtures built
around implausible magnitudes would let threshold bugs pass unnoticed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.engine import Engine

from app.db import build_engine, detection_id, detections, init_schema, ingest_runs
from app.features import CellContextRow, CellStats
from app.geo import cell_id


@pytest.fixture
def engine(tmp_path) -> Engine:
    """An isolated on-disk SQLite database per test."""
    engine = build_engine(f"sqlite+pysqlite:///{tmp_path / 'test.db'}")
    init_schema(engine)
    return engine


@pytest.fixture
def base_time() -> datetime:
    return datetime(2026, 9, 15, 6, 30, tzinfo=timezone.utc)


def make_stats(
    *,
    cell: str = "2375:8640",
    observations: int = 20,
    distinct_days: int = 6,
    median_frp: float = 2.2,
    p90_frp: float = 3.1,
    mad_frp: float = 0.4,
    dual_band: float = 26.0,
    night_fraction: float = 0.5,
    window_days: int = 7,
    first_seen: datetime | None = None,
    last_seen: datetime | None = None,
) -> CellStats:
    anchor = datetime(2026, 9, 12, 0, 0, tzinfo=timezone.utc)
    return CellStats(
        cell_id=cell,
        observation_count=observations,
        distinct_days=distinct_days,
        median_frp_mw=median_frp,
        p90_frp_mw=p90_frp,
        mad_frp_mw=mad_frp,
        median_dual_band_k=dual_band,
        night_fraction=night_fraction,
        first_seen=first_seen or anchor,
        last_seen=last_seen or anchor + timedelta(days=window_days - 1),
        window_days=window_days,
    )


def make_context(
    *,
    cell: str = "2375:8640",
    distance_m: float | None = 800.0,
    facility_name: str | None = "Unnamed industrial area",
    category: str | None = "industrial",
    within_5km: int = 4,
    land_cover: str = "industrial",
    coverage: str = "surveyed",
) -> CellContextRow:
    return CellContextRow(
        cell_id=cell,
        nearest_facility_id="f1" if distance_m is not None else None,
        nearest_facility_name=facility_name,
        nearest_facility_category=category,
        distance_to_facility_m=distance_m,
        facilities_within_5km=within_5km,
        land_cover=land_cover,
        context_coverage=coverage,  # type: ignore[arg-type]
    )


def insert_detection(
    engine: Engine,
    *,
    latitude: float = 23.755,
    longitude: float = 86.405,
    acquired_at: datetime | None = None,
    frp_mw: float = 2.4,
    brightness_k: float = 330.0,
    brightness_long_k: float = 303.0,
    instrument: str = "VIIRS",
    satellite_code: str = "N21",
    confidence_tier: str = "nominal",
    day_night: str = "N",
    run_id: int = 1,
) -> str:
    """Insert one detection and return its id."""
    acquired_at = acquired_at or datetime(2026, 9, 15, 20, 10, tzinfo=timezone.utc)
    did = detection_id(latitude, longitude, acquired_at, satellite_code, instrument)

    with engine.begin() as conn:
        existing = conn.execute(
            ingest_runs.select().where(ingest_runs.c.run_id == run_id)
        ).one_or_none()
        if existing is None:
            conn.execute(
                ingest_runs.insert().values(
                    run_id=run_id,
                    source="test",
                    detail="fixture",
                    started_at=acquired_at,
                    status="success",
                    rows_seen=1,
                    rows_accepted=1,
                    rows_rejected=0,
                    rows_inserted=1,
                )
            )
        conn.execute(
            detections.insert().values(
                detection_id=did,
                latitude=latitude,
                longitude=longitude,
                cell_id=cell_id(latitude, longitude),
                acquired_at=acquired_at,
                instrument=instrument,
                satellite_code=satellite_code,
                satellite_name="NOAA-21",
                brightness_k=brightness_k,
                brightness_long_k=brightness_long_k,
                frp_mw=frp_mw,
                confidence_raw=confidence_tier,
                confidence_tier=confidence_tier,
                day_night=day_night,
                version="2.0NRT",
                scan=0.4,
                track=0.45,
                product_id="noaa21",
                dataset_id="firms_viirs_snpp",
                ingest_run_id=run_id,
            )
        )
    return did
