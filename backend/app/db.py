"""Database schema and engine.

SQLAlchemy Core rather than the ORM: the workload is bulk inserts and aggregate
reads, which SQL expresses directly and which the ORM's identity map only slows
down.

SQLite is the default so the pipeline runs with no hosting account. Setting
`DATABASE_URL` switches to Postgres without any code change — the schema uses no
SQLite-specific types.

Tables fall into three groups, and the split is deliberate:

  observed   `detections`, `facilities`, `land_parcels` — external data, stored as
             received, never mutated by analysis.
  derived    `cell_stats`, `cell_context`, `cell_labels` — computed by us, always
             regenerable from observed data, always stamped with the code version
             that produced them.
  audit      `ingest_runs` — what was fetched, when, from where, and what happened.

Keeping observed and derived physically separate is what makes it possible to
answer "is this a measurement or our inference?" for any value on screen.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    create_engine,
)
from sqlalchemy.engine import Engine

from .config import settings

metadata = MetaData()

# --------------------------------------------------------------- observed --

detections = Table(
    "detections",
    metadata,
    # Deterministic hash of the natural key. FIRMS windows overlap between runs
    # (a 7d fetch re-delivers yesterday's rows), so ingestion must be idempotent.
    # A content-derived id makes "insert if absent" work on both SQLite and
    # Postgres without dialect-specific upsert syntax.
    Column("detection_id", String(40), primary_key=True),
    Column("latitude", Float, nullable=False),
    Column("longitude", Float, nullable=False),
    Column("cell_id", String(24), nullable=False),
    Column("acquired_at", DateTime(timezone=True), nullable=False),
    Column("instrument", String(8), nullable=False),
    Column("satellite_code", String(8), nullable=False),
    Column("satellite_name", String(32), nullable=False),
    Column("brightness_k", Float, nullable=False),
    Column("brightness_long_k", Float, nullable=False),
    Column("frp_mw", Float, nullable=False),
    Column("confidence_raw", String(16), nullable=False),
    Column("confidence_tier", String(8), nullable=False),
    Column("day_night", String(1), nullable=False),
    Column("version", String(16), nullable=False),
    Column("scan", Float, nullable=False),
    Column("track", Float, nullable=False),
    Column("product_id", String(16), nullable=False),
    Column("dataset_id", String(32), nullable=False),
    Column("ingest_run_id", Integer, nullable=False),
    Index("ix_detections_cell", "cell_id"),
    Index("ix_detections_acquired", "acquired_at"),
    # Supports the map's primary query: recent detections in a bounding box.
    Index("ix_detections_bbox", "latitude", "longitude"),
)

facilities = Table(
    "facilities",
    metadata,
    Column("facility_id", String(40), primary_key=True),
    Column("osm_type", String(12), nullable=False),
    Column("osm_id", String(24), nullable=False),
    Column("name", String(200), nullable=True),
    # Our normalised category (oil / steel / power / mining / chemical / generic).
    Column("category", String(24), nullable=False),
    # The raw OSM tag that produced the category, kept so classification is auditable.
    Column("source_tag", String(64), nullable=False),
    Column("latitude", Float, nullable=False),
    Column("longitude", Float, nullable=False),
    Column("cell_id", String(24), nullable=False),
    Column("dataset_id", String(32), nullable=False),
    Column("fetched_at", DateTime(timezone=True), nullable=False),
    Index("ix_facilities_cell", "cell_id"),
    Index("ix_facilities_bbox", "latitude", "longitude"),
)

land_parcels = Table(
    "land_parcels",
    metadata,
    Column("parcel_id", String(40), primary_key=True),
    Column("osm_type", String(12), nullable=False),
    Column("osm_id", String(24), nullable=False),
    # Normalised onto our LandCover vocabulary.
    Column("land_cover", String(16), nullable=False),
    Column("source_tag", String(64), nullable=False),
    Column("latitude", Float, nullable=False),
    Column("longitude", Float, nullable=False),
    Column("cell_id", String(24), nullable=False),
    Column("dataset_id", String(32), nullable=False),
    Column("fetched_at", DateTime(timezone=True), nullable=False),
    Index("ix_parcels_cell", "cell_id"),
)

# ---------------------------------------------------------------- derived --

cell_stats = Table(
    "cell_stats",
    metadata,
    Column("cell_id", String(24), primary_key=True),
    Column("observation_count", Integer, nullable=False),
    Column("distinct_days", Integer, nullable=False),
    Column("median_frp_mw", Float, nullable=False),
    Column("p90_frp_mw", Float, nullable=False),
    # Median absolute deviation: robust to the single large excursion we are
    # specifically trying to detect, which would inflate a standard deviation and
    # mask the very anomaly it is meant to reveal.
    Column("mad_frp_mw", Float, nullable=False),
    Column("median_dual_band_k", Float, nullable=False),
    Column("night_fraction", Float, nullable=False),
    Column("first_seen", DateTime(timezone=True), nullable=False),
    Column("last_seen", DateTime(timezone=True), nullable=False),
    Column("window_days", Integer, nullable=False),
    Column("computed_at", DateTime(timezone=True), nullable=False),
    Column("code_version", String(16), nullable=False),
    Index("ix_cell_stats_days", "distinct_days"),
)

cell_context = Table(
    "cell_context",
    metadata,
    Column("cell_id", String(24), primary_key=True),
    Column("nearest_facility_id", String(40), nullable=True),
    Column("nearest_facility_name", String(200), nullable=True),
    Column("nearest_facility_category", String(24), nullable=True),
    Column("distance_to_facility_m", Float, nullable=True),
    Column("facilities_within_5km", Integer, nullable=False),
    Column("land_cover", String(16), nullable=False),
    # Distinguishes "we looked and found nothing nearby" from "we have not looked
    # here yet". Conflating those two would turn missing coverage into evidence.
    Column("context_coverage", String(16), nullable=False),
    Column("computed_at", DateTime(timezone=True), nullable=False),
    Column("code_version", String(16), nullable=False),
)

cell_labels = Table(
    "cell_labels",
    metadata,
    Column("cell_id", String(24), primary_key=True),
    Column("label", String(32), nullable=False),
    Column("label_rule_version", String(16), nullable=False),
    # Which criteria fired, so a label can always be explained and audited.
    Column("rationale", JSON, nullable=False),
    Column("computed_at", DateTime(timezone=True), nullable=False),
    Index("ix_cell_labels_label", "label"),
)

# ------------------------------------------------------------------ audit --

ingest_runs = Table(
    "ingest_runs",
    metadata,
    Column("run_id", Integer, primary_key=True, autoincrement=True),
    Column("source", String(32), nullable=False),
    Column("detail", String(64), nullable=True),
    Column("url", String(400), nullable=True),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("finished_at", DateTime(timezone=True), nullable=True),
    # "success" | "failed" | "partial" — never inferred, always written explicitly.
    Column("status", String(16), nullable=False),
    Column("rows_seen", Integer, nullable=False, default=0),
    Column("rows_accepted", Integer, nullable=False, default=0),
    Column("rows_rejected", Integer, nullable=False, default=0),
    Column("rows_inserted", Integer, nullable=False, default=0),
    Column("reject_reasons", JSON, nullable=True),
    Column("error", String(1000), nullable=True),
    Index("ix_runs_started", "started_at"),
)


def detection_id(
    latitude: float,
    longitude: float,
    acquired_at: datetime,
    satellite_code: str,
    instrument: str,
) -> str:
    """Stable id for a detection, so re-ingesting the same row is a no-op.

    Coordinates are rounded to 5 decimal places (~1 m) because FIRMS publishes
    them at 5 dp; rounding guards against float formatting differences between
    runs producing two ids for one observation.
    """
    key = (
        f"{latitude:.5f}|{longitude:.5f}|"
        f"{acquired_at.isoformat()}|{satellite_code}|{instrument}"
    )
    return hashlib.sha1(key.encode()).hexdigest()


def osm_element_id(osm_type: str, osm_id: str | int) -> str:
    return hashlib.sha1(f"{osm_type}/{osm_id}".encode()).hexdigest()


def database_path() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "heatdetect.db"


def build_engine(url: str | None = None) -> Engine:
    """Create the engine. Postgres when configured, SQLite otherwise."""
    if url is None:
        url = settings.database_url or ""

    if url:
        # Pin the driver explicitly for every Postgres URL form.
        #
        # Both rewrites are necessary, and the second is easy to miss: a bare
        # `postgresql://` URL makes SQLAlchemy default to **psycopg2**, which is
        # not installed here (this project uses psycopg 3), so the most common
        # DATABASE_URL form would fail at startup with ModuleNotFoundError.
        # Hosting providers also hand out the older `postgres://` form, which
        # SQLAlchemy 2.x rejects outright.
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)

        # pool_pre_ping: managed Postgres (Neon, Render) closes idle
        # connections, and a stale pooled connection otherwise surfaces as a
        # random 500 on the first request after a quiet period.
        return create_engine(url, pool_pre_ping=True, future=True)

    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(f"sqlite+pysqlite:///{path}", future=True)


def init_schema(engine: Engine) -> None:
    metadata.create_all(engine)
