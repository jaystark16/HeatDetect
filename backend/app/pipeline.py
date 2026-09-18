"""Pipeline CLI.

    python -m app.pipeline ingest [--window 24h|7d]
    python -m app.pipeline facilities [--max-tiles N]
    python -m app.pipeline features
    python -m app.pipeline all
    python -m app.pipeline status

Every stage writes an `ingest_runs` audit row with real counts and an explicit
status. A stage that fails is recorded as `failed` with the error text — it never
reports success because it ran.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone

import httpx
from sqlalchemy import func, insert, select, update
from sqlalchemy.engine import Engine

from . import features as feat
from . import labels as lbl
from .config import settings
from .db import (
    build_engine,
    cell_labels,
    cell_stats,
    detection_id,
    detections,
    facilities,
    ingest_runs,
    init_schema,
    land_parcels,
    osm_element_id,
)
from .geo import bbox_contains, cell_centre, cell_id
from .ingest import firms, osm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pipeline")


def _start_run(engine: Engine, source: str, detail: str | None, url: str | None) -> int:
    with engine.begin() as conn:
        result = conn.execute(
            insert(ingest_runs).values(
                source=source,
                detail=detail,
                url=url,
                started_at=datetime.now(timezone.utc),
                status="running",
                rows_seen=0,
                rows_accepted=0,
                rows_rejected=0,
                rows_inserted=0,
            )
        )
        return int(result.inserted_primary_key[0])


def _finish_run(engine: Engine, run_id: int, **values: object) -> None:
    with engine.begin() as conn:
        conn.execute(
            update(ingest_runs)
            .where(ingest_runs.c.run_id == run_id)
            .values(finished_at=datetime.now(timezone.utc), **values)
        )


# ------------------------------------------------------------------ FIRMS --


def cmd_ingest(engine: Engine, window: str) -> int:
    """Fetch every FIRMS product and store detections inside the analysis bbox."""
    bbox = settings.bbox
    total_inserted = 0
    failures = 0

    client = httpx.Client(
        headers={"User-Agent": firms.USER_AGENT},
        timeout=httpx.Timeout(180.0),
        follow_redirects=True,
    )
    try:
        for product in firms.PRODUCTS:
            url = product.url(window)  # type: ignore[arg-type]
            run_id = _start_run(engine, "firms", f"{product.id}/{window}", url)
            try:
                result = firms.fetch(product, window, client=client)  # type: ignore[arg-type]
                parsed, report = firms.parse(result)
            except firms.FirmsUnavailable as exc:
                failures += 1
                logger.error("ingest %s FAILED: %s", product.id, exc)
                _finish_run(engine, run_id, status="failed", error=str(exc)[:1000])
                continue

            in_area = [
                d for d in parsed if bbox_contains(bbox, d.latitude, d.longitude)
            ]
            inserted = _store_detections(engine, in_area, run_id)
            total_inserted += inserted

            logger.info(
                "ingest %-7s %s | in-bbox %d | newly stored %d",
                product.id,
                report.summary(),
                len(in_area),
                inserted,
            )
            _finish_run(
                engine,
                run_id,
                status="success",
                rows_seen=report.rows_seen,
                rows_accepted=report.accepted,
                rows_rejected=report.rejected,
                rows_inserted=inserted,
                reject_reasons=dict(report.reject_reasons) or None,
            )
    finally:
        client.close()

    with engine.connect() as conn:
        stored = conn.execute(select(func.count()).select_from(detections)).scalar_one()
    logger.info(
        "ingest complete: %d new rows this run, %d detections stored in total, %d product failures",
        total_inserted,
        stored,
        failures,
    )
    return 1 if failures == len(firms.PRODUCTS) else 0


def _store_detections(
    engine: Engine, records: list[firms.Detection], run_id: int
) -> int:
    """Insert detections, skipping ones already stored.

    FIRMS windows overlap between runs, so this must be idempotent. Existing ids
    are read first and filtered in Python: portable across SQLite and Postgres,
    and at these volumes (thousands) cheaper than per-row conflict handling.
    """
    if not records:
        return 0

    rows = []
    for d in records:
        rows.append(
            {
                "detection_id": detection_id(
                    d.latitude, d.longitude, d.acquired_at, d.satellite_code, d.instrument
                ),
                "latitude": d.latitude,
                "longitude": d.longitude,
                "cell_id": cell_id(d.latitude, d.longitude),
                "acquired_at": d.acquired_at,
                "instrument": d.instrument,
                "satellite_code": d.satellite_code,
                "satellite_name": d.satellite_name,
                "brightness_k": d.brightness_k,
                "brightness_long_k": d.brightness_long_k,
                "frp_mw": d.frp_mw,
                "confidence_raw": d.confidence_raw,
                "confidence_tier": d.confidence_tier,
                "day_night": d.day_night,
                "version": d.version,
                "scan": d.scan,
                "track": d.track,
                "product_id": d.product_id,
                "dataset_id": d.dataset_id,
                "ingest_run_id": run_id,
            }
        )

    # Deduplicate within the batch too: the same pixel can appear twice in one
    # file when scan lines overlap.
    unique = {r["detection_id"]: r for r in rows}

    with engine.connect() as conn:
        existing = {
            row[0]
            for row in conn.execute(
                select(detections.c.detection_id).where(
                    detections.c.detection_id.in_(list(unique))
                )
            )
        }

    fresh = [r for r in unique.values() if r["detection_id"] not in existing]
    if fresh:
        with engine.begin() as conn:
            conn.execute(detections.insert(), fresh)
    return len(fresh)


# -------------------------------------------------------------- OSM tiles --


def cmd_facilities(
    engine: Engine, max_tiles: int | None, cache_only: bool = False
) -> int:
    """Prefetch industrial and land context for tiles that contain detections.

    Resumable by design. Overpass throttling is expected, not exceptional: the
    stage records what it obtained, leaves the rest for a later run, and never
    pretends an unfetched tile is an empty one.
    """
    with engine.connect() as conn:
        points = conn.execute(
            select(detections.c.latitude, detections.c.longitude).distinct()
        ).all()

    if not points:
        logger.error("No detections stored. Run `ingest` first.")
        return 1

    tiles = osm.tiles_for_points([(p.latitude, p.longitude) for p in points])
    already = osm.cached_tile_keys()
    pending = _prioritise_tiles(engine, [t for t in tiles if t.key not in already])

    logger.info(
        "facilities: %d tiles contain detections, %d already cached, %d pending "
        "(highest-value first)",
        len(tiles),
        len(tiles) - len(pending),
        len(pending),
    )
    if max_tiles is not None:
        pending = pending[:max_tiles]
        logger.info("facilities: limiting this run to %d tiles", len(pending))

    client = httpx.Client(
        headers={"User-Agent": osm.USER_AGENT},
        timeout=httpx.Timeout(settings.overpass_timeout_seconds + 60),
    )
    fetched = 0
    throttled = 0
    try:
        for index, tile in enumerate(pending, start=1):
            # In cache-only mode no audit row is written, so this long-running
            # fetch never contends with the rest of the pipeline for the SQLite
            # file. The tile cache on disk is the only thing it mutates.
            run_id = (
                None
                if cache_only
                else _start_run(engine, "overpass", tile.key, settings.overpass_url)
            )
            try:
                result = osm.fetch_tile(tile, client=client)
            except osm.OverpassThrottled as exc:
                throttled += 1
                logger.warning("facilities tile %s throttled", tile.key)
                if run_id is not None:
                    _finish_run(engine, run_id, status="failed", error=str(exc)[:1000])
                # Back off harder as refusals accumulate — continuing to hammer a
                # service that is already refusing is both futile and rude.
                time.sleep(settings.overpass_delay_seconds * (2 + throttled))
                if throttled >= 5:
                    logger.error(
                        "facilities: 5 consecutive refusals; stopping. "
                        "%d tiles cached so far, rerun later to continue.",
                        len(osm.cached_tile_keys()),
                    )
                    break
                continue

            throttled = 0
            fetched += 1
            logger.info(
                "facilities tile %s (%d/%d) -> %d facilities, %d parcels%s",
                tile.key,
                index,
                len(pending),
                len(result.facilities),
                len(result.parcels),
                " [cache]" if result.from_cache else "",
            )
            if run_id is not None:
                _finish_run(
                    engine,
                    run_id,
                    status="success",
                    rows_seen=len(result.facilities) + len(result.parcels),
                    rows_accepted=len(result.facilities) + len(result.parcels),
                )
            if not result.from_cache:
                time.sleep(settings.overpass_delay_seconds)
    finally:
        client.close()

    if cache_only:
        logger.info(
            "facilities (cache-only) complete: %d tiles fetched this run, "
            "%d of %d tiles now cached. Run `features` to load them.",
            fetched,
            len(osm.cached_tile_keys()),
            len(tiles),
        )
        return 0

    stored_f, stored_p = _store_osm_from_cache(engine, tiles)
    logger.info(
        "facilities complete: %d tiles fetched this run; database now holds "
        "%d facilities and %d land parcels from %d cached tiles",
        fetched,
        stored_f,
        stored_p,
        len(osm.cached_tile_keys()),
    )
    return 0


def _prioritise_tiles(engine: Engine, pending: list[osm.Tile]) -> list[osm.Tile]:
    """Order tiles so the most informative coverage arrives first.

    Overpass throttling means partial coverage is the normal state, not a failure
    mode. Sweeping the bounding box in latitude order spends the quota on
    whichever region happens to sort first — which during development meant
    agricultural South India, while the persistent industrial sources at Jharia
    and Singrauli stayed unsurveyed and therefore unclassifiable.

    Ranking by persistent-cell count puts the industrially interesting tiles
    first, so a run that only manages twenty tiles still yields a usable system.
    """
    if not pending:
        return pending

    with engine.connect() as conn:
        rows = conn.execute(
            select(cell_stats.c.cell_id, cell_stats.c.distinct_days)
        ).all()
        detection_rows = conn.execute(
            select(detections.c.cell_id, func.count())
            .group_by(detections.c.cell_id)
        ).all()

    persistent_by_tile: dict[str, int] = {}
    detections_by_tile: dict[str, int] = {}

    for cell, distinct_days in rows:
        lat, lon = cell_centre(cell)
        key = osm.tile_for_point(lat, lon, settings.overpass_tile_degrees).key
        if distinct_days >= 4:
            persistent_by_tile[key] = persistent_by_tile.get(key, 0) + 1

    for cell, count in detection_rows:
        lat, lon = cell_centre(cell)
        key = osm.tile_for_point(lat, lon, settings.overpass_tile_degrees).key
        detections_by_tile[key] = detections_by_tile.get(key, 0) + count

    return sorted(
        pending,
        key=lambda t: (
            -persistent_by_tile.get(t.key, 0),
            -detections_by_tile.get(t.key, 0),
        ),
    )


def _store_osm_from_cache(engine: Engine, tiles: list[osm.Tile]) -> tuple[int, int]:
    """Rebuild the OSM tables from whatever tiles are cached.

    A full rebuild rather than an incremental merge: the cache is the source of
    truth, it is small, and rebuilding removes any chance of the tables drifting
    from it.
    """
    facility_rows: dict[str, dict] = {}
    parcel_rows: dict[str, dict] = {}

    for tile in tiles:
        result = osm.load_cached(tile)
        if result is None:
            continue
        for f in result.facilities:
            fid = osm_element_id(f.osm_type, f.osm_id)
            facility_rows[fid] = {
                "facility_id": fid,
                "osm_type": f.osm_type,
                "osm_id": f.osm_id,
                "name": f.name,
                "category": f.category,
                "source_tag": f.source_tag,
                "latitude": f.latitude,
                "longitude": f.longitude,
                "cell_id": cell_id(f.latitude, f.longitude),
                "dataset_id": "osm_industrial",
                "fetched_at": f.fetched_at,
            }
        for p in result.parcels:
            pid = osm_element_id(p.osm_type, p.osm_id)
            parcel_rows[pid] = {
                "parcel_id": pid,
                "osm_type": p.osm_type,
                "osm_id": p.osm_id,
                "land_cover": p.land_cover,
                "source_tag": p.source_tag,
                "latitude": p.latitude,
                "longitude": p.longitude,
                "cell_id": cell_id(p.latitude, p.longitude),
                "dataset_id": "osm_landcover",
                "fetched_at": p.fetched_at,
            }

    with engine.begin() as conn:
        conn.execute(facilities.delete())
        conn.execute(land_parcels.delete())
        if facility_rows:
            conn.execute(facilities.insert(), list(facility_rows.values()))
        if parcel_rows:
            conn.execute(land_parcels.insert(), list(parcel_rows.values()))

    return len(facility_rows), len(parcel_rows)


# ------------------------------------------------------------- features --


def cmd_features(engine: Engine) -> int:
    run_id = _start_run(engine, "features", "cell_stats+context+labels", None)
    try:
        # Load whatever tiles the cache holds, so this stage reflects current
        # coverage even if a cache-warming run is still in progress.
        with engine.connect() as conn:
            points = conn.execute(
                select(detections.c.latitude, detections.c.longitude).distinct()
            ).all()
        if points:
            tiles = osm.tiles_for_points([(p.latitude, p.longitude) for p in points])
            loaded_f, loaded_p = _store_osm_from_cache(engine, tiles)
            logger.info(
                "features: loaded %d facilities and %d parcels from %d cached tiles "
                "(%d tiles contain detections)",
                loaded_f,
                loaded_p,
                len(osm.cached_tile_keys()),
                len(tiles),
            )

        stats = feat.compute_cell_stats(engine)
        if not stats:
            _finish_run(
                engine, run_id, status="failed", error="No detections to aggregate"
            )
            logger.error("No detections stored. Run `ingest` first.")
            return 1

        stored_stats = feat.store_cell_stats(engine, stats)
        contexts = feat.compute_cell_context(engine, [s.cell_id for s in stats])
        stored_ctx = feat.store_cell_context(engine, contexts)
        decisions = lbl.assign_labels(stats, contexts)
        stored_labels = lbl.store_labels(engine, decisions)
    except Exception as exc:  # noqa: BLE001
        _finish_run(engine, run_id, status="failed", error=str(exc)[:1000])
        raise

    distribution = lbl.label_distribution(decisions)
    surveyed = sum(1 for c in contexts if c.context_coverage == "surveyed")

    logger.info(
        "features complete: %d cell_stats, %d contexts (%d surveyed, %d not surveyed), %d labels",
        stored_stats,
        stored_ctx,
        surveyed,
        stored_ctx - surveyed,
        stored_labels,
    )
    logger.info("label distribution: %s", distribution)
    _finish_run(
        engine,
        run_id,
        status="success",
        rows_seen=len(stats),
        rows_accepted=stored_labels,
        rows_inserted=stored_labels,
        reject_reasons=distribution,
    )
    return 0


# --------------------------------------------------------------- status --


def cmd_status(engine: Engine) -> int:
    with engine.connect() as conn:
        counts = {
            "detections": conn.execute(
                select(func.count()).select_from(detections)
            ).scalar_one(),
            "facilities": conn.execute(
                select(func.count()).select_from(facilities)
            ).scalar_one(),
            "land_parcels": conn.execute(
                select(func.count()).select_from(land_parcels)
            ).scalar_one(),
            "cell_stats": conn.execute(
                select(func.count()).select_from(cell_stats)
            ).scalar_one(),
            "cell_labels": conn.execute(
                select(func.count()).select_from(cell_labels)
            ).scalar_one(),
        }
        window = conn.execute(
            select(func.min(detections.c.acquired_at), func.max(detections.c.acquired_at))
        ).one()
        recent_runs = conn.execute(
            select(
                ingest_runs.c.source,
                ingest_runs.c.detail,
                ingest_runs.c.status,
                ingest_runs.c.rows_inserted,
                ingest_runs.c.started_at,
            )
            .order_by(ingest_runs.c.run_id.desc())
            .limit(8)
        ).all()
        label_counts = conn.execute(
            select(cell_labels.c.label, func.count())
            .group_by(cell_labels.c.label)
            .order_by(func.count().desc())
        ).all()

    print("\n--- table counts ---")
    for name, value in counts.items():
        print(f"  {name:<14} {value:>8,}")

    print(f"\n--- detection window ---\n  {window[0]}  ->  {window[1]}")
    print(f"\n--- osm tile cache ---\n  {len(osm.cached_tile_keys())} tiles")

    if label_counts:
        print("\n--- labels ---")
        for label, count in label_counts:
            print(f"  {label:<24} {count:>6,}")

    print("\n--- recent runs ---")
    for r in recent_runs:
        print(
            f"  {r.started_at:%m-%d %H:%M}  {r.source:<9} {str(r.detail or ''):<22} "
            f"{r.status:<8} +{r.rows_inserted}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    p_ingest = sub.add_parser("ingest", help="Fetch FIRMS detections")
    p_ingest.add_argument("--window", choices=["24h", "7d"], default="7d")

    p_fac = sub.add_parser("facilities", help="Prefetch OSM context for active tiles")
    p_fac.add_argument("--max-tiles", type=int, default=None)
    p_fac.add_argument(
        "--cache-only",
        action="store_true",
        help="Warm the tile cache without touching the database (safe to run long)",
    )

    sub.add_parser("features", help="Compute cell stats, context and labels")
    sub.add_parser("all", help="ingest -> facilities -> features")
    sub.add_parser("status", help="Show what is actually in the database")

    args = parser.parse_args(argv)
    engine = build_engine()
    init_schema(engine)

    if args.command == "ingest":
        return cmd_ingest(engine, args.window)
    if args.command == "facilities":
        return cmd_facilities(engine, args.max_tiles, args.cache_only)
    if args.command == "features":
        return cmd_features(engine)
    if args.command == "status":
        return cmd_status(engine)
    if args.command == "all":
        for step in (
            lambda: cmd_ingest(engine, "7d"),
            lambda: cmd_facilities(engine, None),
            lambda: cmd_features(engine),
        ):
            code = step()
            if code != 0:
                return code
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
