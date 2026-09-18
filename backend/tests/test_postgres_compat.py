"""Postgres compatibility, verified without a Postgres server.

No Postgres instance is available in this environment, so these tests do the
next best thing that is still real: compile the schema DDL and every
application query against SQLAlchemy's **postgresql dialect**. That catches the
failure mode that actually matters — a construct that works on SQLite and is
invalid on Postgres — without pretending a live connection was tested.

What this does NOT prove is stated plainly in the README: no query has been
executed against a real Postgres server.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.schema import CreateIndex, CreateTable

from app.db import (
    build_engine,
    cell_context,
    cell_labels,
    cell_stats,
    detections,
    facilities,
    ingest_runs,
    land_parcels,
    metadata,
)
from app.service import HotspotFilters, _apply_filters

PG = postgresql.dialect()
LITE = sqlite.dialect()

ALL_TABLES = [
    detections,
    facilities,
    land_parcels,
    cell_stats,
    cell_context,
    cell_labels,
    ingest_runs,
]


# ------------------------------------------------------------------ DDL --


@pytest.mark.parametrize("table", ALL_TABLES, ids=lambda t: t.name)
def test_table_ddl_compiles_for_postgres(table):
    sql = str(CreateTable(table).compile(dialect=PG))
    assert f"CREATE TABLE {table.name}" in sql
    # JSON columns are the likeliest dialect trap; Postgres must get JSON, not TEXT.
    for column in table.columns:
        assert column.name in sql


@pytest.mark.parametrize("table", ALL_TABLES, ids=lambda t: t.name)
def test_index_ddl_compiles_for_postgres(table):
    for index in table.indexes:
        assert "CREATE INDEX" in str(CreateIndex(index).compile(dialect=PG))


def test_json_columns_use_a_real_json_type_on_postgres():
    """`reject_reasons` and `rationale` hold structured data. On Postgres they
    must be JSON so they stay queryable, not opaque text."""
    sql = str(CreateTable(ingest_runs).compile(dialect=PG))
    assert "reject_reasons JSON" in sql

    sql = str(CreateTable(cell_labels).compile(dialect=PG))
    assert "rationale JSON" in sql


def test_autoincrement_primary_key_becomes_serial_on_postgres():
    """SQLite's implicit rowid has no Postgres equivalent; the column must
    compile to an actual sequence-backed type."""
    sql = str(CreateTable(ingest_runs).compile(dialect=PG))
    assert "SERIAL" in sql.upper() or "GENERATED" in sql.upper()


def test_every_table_is_registered_in_metadata():
    """init_schema uses metadata.create_all, so an unregistered table would
    silently never be created."""
    assert {t.name for t in ALL_TABLES} == set(metadata.tables)


# ---------------------------------------------------------------- queries --


def _compile(stmt, dialect):
    return str(stmt.compile(dialect=dialect, compile_kwargs={"literal_binds": True}))


@pytest.mark.parametrize(
    "filters",
    [
        HotspotFilters(),
        HotspotFilters(label="industrial_fire"),
        HotspotFilters(min_frp_mw=2.5),
        HotspotFilters(within_hours=24),
        HotspotFilters(min_distinct_days=4),
        HotspotFilters(confidence_tier="high"),
        HotspotFilters(bbox=(68.0, 6.0, 98.0, 37.5)),
        HotspotFilters(
            label="natural_fire",
            min_frp_mw=1.0,
            within_hours=72,
            min_distinct_days=2,
            confidence_tier="nominal",
            bbox=(80.0, 20.0, 90.0, 25.0),
        ),
    ],
    ids=[
        "none",
        "label",
        "frp",
        "hours",
        "days",
        "confidence",
        "bbox",
        "all-combined",
    ],
)
def test_hotspot_filters_compile_for_both_dialects(filters):
    base = detections.outerjoin(
        cell_stats, detections.c.cell_id == cell_stats.c.cell_id
    ).outerjoin(cell_labels, detections.c.cell_id == cell_labels.c.cell_id)

    stmt = _apply_filters(
        select(detections.c.detection_id).select_from(base), filters
    )
    for dialect in (PG, LITE):
        sql = _compile(stmt, dialect)
        assert "SELECT" in sql and "detections" in sql


def test_ordering_with_nullslast_compiles_for_postgres():
    """`nullslast` is the ordering clause most likely to differ by dialect."""
    stmt = (
        select(detections.c.detection_id)
        .select_from(
            detections.outerjoin(
                cell_stats, detections.c.cell_id == cell_stats.c.cell_id
            )
        )
        .order_by(
            cell_stats.c.distinct_days.desc().nullslast(),
            detections.c.frp_mw.desc(),
        )
        .limit(10)
        .offset(5)
    )
    sql = _compile(stmt, PG)
    assert "NULLS LAST" in sql.upper()
    assert "LIMIT" in sql.upper()


def test_case_aggregate_in_provenance_compiles_for_postgres():
    from sqlalchemy import case  # noqa: PLC0415

    stmt = select(
        func.sum(case((cell_context.c.context_coverage == "surveyed", 1), else_=0))
    ).select_from(cell_context)
    assert "CASE" in _compile(stmt, PG).upper()


def test_ilike_search_compiles_for_both_dialects():
    """SQLite has no native ILIKE; SQLAlchemy must emit a working equivalent."""
    stmt = (
        select(facilities.c.name)
        .where(facilities.c.name.isnot(None))
        .where(facilities.c.name.ilike("%coal%", escape=chr(92)))
        .order_by(func.length(facilities.c.name))
        .limit(10)
    )
    pg_sql = _compile(stmt, PG).upper()
    lite_sql = _compile(stmt, LITE).upper()
    assert "ILIKE" in pg_sql
    assert "LIKE" in lite_sql  # lower(...) LIKE lower(...) on SQLite


# ------------------------------------------------------------- engine URL --


@pytest.mark.parametrize(
    ("given", "expected_driver"),
    [
        # Hosting providers hand out the bare postgres:// form, which
        # SQLAlchemy 2.x rejects without an explicit driver.
        ("postgres://u:p@h:5432/db", "postgresql+psycopg"),  # pragma: fake-credential
        # A bare postgresql:// URL must be pinned to psycopg 3, or SQLAlchemy
        # reaches for psycopg2 and fails at startup.
        ("postgresql://u:p@h:5432/db", "postgresql+psycopg"),  # pragma: fake-credential
        ("postgresql+psycopg://u:p@h:5432/db", "postgresql+psycopg"),  # pragma: fake-credential
    ],
)
def test_postgres_urls_are_normalised(given, expected_driver):
    engine = build_engine(given)
    try:
        assert engine.url.render_as_string(hide_password=True).startswith(
            expected_driver
        )
    finally:
        engine.dispose()


def test_postgres_url_password_is_not_exposed_in_repr():
    """A leaked engine repr in a log must not carry the password."""
    engine = build_engine("postgresql+psycopg://user:sup3rs3cret@host/db")  # pragma: fake-credential
    try:
        assert "sup3rs3cret" not in repr(engine)
        assert "sup3rs3cret" not in str(engine.url)
    finally:
        engine.dispose()


def test_psycopg_driver_is_installed():
    """The app claims Postgres support; the driver must actually be present."""
    import psycopg  # noqa: PLC0415

    assert psycopg.__version__


def test_sqlite_is_the_default_when_no_url_is_set():
    engine = build_engine("")
    try:
        assert engine.dialect.name == "sqlite"
    finally:
        engine.dispose()
