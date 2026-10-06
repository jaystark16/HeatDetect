"""Export a real data snapshot for the static frontend deployment.

    backend/.venv/Scripts/python scripts/export_snapshot.py

Why this exists: the dashboard is deployed as a static site on GitHub Pages,
where no API is reachable. Rather than showing an error, it loads this snapshot.

This replaced an earlier hand-written "sample data" module whose FRP values,
baselines and confidence scores were all invented. Nothing here is invented —
every value is read from the database that the pipeline populated from NASA
FIRMS and OpenStreetMap.

The snapshot is labelled `cached_snapshot`, never `live`: it is a file, not a
query. It records the window it covers, when it was built, and whether anything
rebuilds it on a schedule, so the page can say exactly how current it is.

Timestamps are the **true acquisition times**. An earlier version stored each
detection's age at export time and the page rebuilt it as "now minus age", so
that a frozen demo would not look stale. That shifted every timestamp forward by
the age of the file: on a 13-day-old snapshot a detection from 19 September was
displayed as 2 October, after the data window had ended, and "Last 24 hours"
returned 57 detections that were two weeks old. Never again.

Full detail for **every** location is written as one small file each under
`frontend/public/details/<first two hex>/<detection id>.json`, fetched only
when that location is clicked. The snapshot also inlines detail for a few
hundred locations, so a checkout without the (untracked) files still works.

    --no-detail-files   skip the per-location files (~8 min, ~60 MiB) for a
                        quick local export

Environment:
  SNAPSHOT_REFRESH_HOURS  set by the scheduled Pages workflow to its cadence.
                          Unset means a manual, one-off build.
  SNAPSHOT_BUILT_BY       free-text provenance, e.g. "github-actions".
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import model as ml  # noqa: E402
from app.db import build_engine  # noqa: E402
from app.service import (  # noqa: E402
    LocationFilters,
    get_analytics,
    get_datasets,
    get_hotspot_detail,
    get_model_info,
    list_locations,
)

# `public/`, not `src/`: importing this from source would inline ~5 MiB into
# the JS bundle for every visitor. As a public asset it is a separate file,
# served gzipped by the CDN and fetched only when the API cannot be reached.
OUT = ROOT / "frontend" / "public" / "snapshot.json"

# Generated per build and never committed: ~18,000 files of ~3 KiB.
DETAIL_DIR = ROOT / "frontend" / "public" / "details"
# Mirrored in frontend/src/fallback/index.ts.
DETAIL_PATH = "details/{prefix}/{id}.json"

# Every location is exported: one row per ~1 km cell, exactly what
# `/api/locations` serves, so the offline map is the whole picture rather than
# a sample. ~5 MiB raw, ~1 MiB as served gzipped.
#
# This replaced detection rows under per-class quotas. Quotas counted
# *detections*, and a persistent source has one per satellite pass: 1,400
# persistent-industrial rows covered 7 of 206 such locations and 600
# industrial-fire rows covered 3 of 15. The offline map understated exactly the
# classes the project exists to find.
#
# Full detail with evidence is ~1.5 KB each, so only some locations carry it.
MAX_DETAILS = 300

CLASSES = ("industrial_fire", "persistent_industrial", "natural_fire", "unknown")

# Far above any realistic cell count; the export must never silently truncate.
NO_LIMIT = 10_000_000


def detail_file(detection_id: str) -> Path:
    return DETAIL_DIR / detection_id[:2] / f"{detection_id}.json"


def write_detail_files(engine, trained, marks) -> int:
    """One file per location, so every mark on the map opens real evidence.

    The same `get_hotspot_detail` the API serves, so a file and an API
    response for the same location are identical.
    """
    # Generated output: rebuilt whole, so a location that has dropped out of
    # the window cannot leave a stale file behind.
    if DETAIL_DIR.exists():
        shutil.rmtree(DETAIL_DIR)

    written = 0
    for i, mark in enumerate(marks, start=1):
        detection_id = mark.representative_detection_id
        detail = get_hotspot_detail(engine, detection_id, trained)
        if detail is None:
            continue
        path = detail_file(detection_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(detail.model_dump_json(), encoding="utf-8")
        written += 1
        if i % 2000 == 0:
            print(f"  detail files: {i} of {len(marks)}", flush=True)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export the static snapshot the dashboard serves."
    )
    parser.add_argument(
        "--no-detail-files",
        action="store_true",
        help="skip per-location detail files for a quick local export",
    )
    args = parser.parse_args()

    engine = build_engine()
    trained = ml.load()

    collection = list_locations(engine, LocationFilters(limit=NO_LIMIT))
    if collection.count == 0:
        print(
            "Refusing to write an empty snapshot. Run the pipeline first:\n"
            "  python -m app.pipeline ingest && python -m app.pipeline features",
            file=sys.stderr,
        )
        return 1
    if collection.count != collection.total_matching:
        print(
            f"Refusing to write a partial snapshot: {collection.count} of "
            f"{collection.total_matching} locations returned.",
            file=sys.stderr,
        )
        return 1

    analytics = get_analytics(engine)
    now = datetime.now(timezone.utc)

    # Already ordered as the API orders them (days seen, then peak FRP), which
    # is also the feed's order.
    marks = collection.locations
    locations = [json.loads(m.model_dump_json()) for m in marks]

    # Detail is spread across classes, so an offline user can inspect a
    # vegetation fire and an industrial source, not only the persistent ones;
    # within each class it goes to the most persistent locations, which head
    # the feed. Keyed by the detection the map opens for that location.
    detail_targets: list[str] = []
    per_class_detail = max(1, MAX_DETAILS // len(CLASSES))
    for label in CLASSES:
        detail_targets.extend(
            [m.representative_detection_id for m in marks if m.label.value == label][
                :per_class_detail
            ]
        )
    # A class with fewer locations than its share leaves budget unused; give it
    # to the next most persistent locations of any class.
    chosen = set(detail_targets)
    for m in marks:
        if len(detail_targets) >= MAX_DETAILS:
            break
        if m.representative_detection_id not in chosen:
            detail_targets.append(m.representative_detection_id)
            chosen.add(m.representative_detection_id)

    details = {}
    for detection_id in detail_targets:
        detail = get_hotspot_detail(engine, detection_id, trained)
        if detail is None:
            continue
        details[detection_id] = json.loads(detail.model_dump_json())

    detail_files = 0
    if not args.no_detail_files:
        detail_files = write_detail_files(engine, trained, marks)
        if detail_files != len(marks):
            print(
                f"Refusing to publish: detail written for {detail_files} of "
                f"{len(marks)} locations.",
                file=sys.stderr,
            )
            return 1
    elif DETAIL_DIR.exists():
        # Files from an earlier build would not match this snapshot.
        shutil.rmtree(DETAIL_DIR)

    # Whether anything rebuilds this file. The page uses this, together with
    # `generated_at`, to decide between "near real time" and "cached snapshot",
    # so a scheduled build that silently stops degrades to the honest label on
    # its own instead of advertising freshness it no longer has.
    cadence = os.environ.get("SNAPSHOT_REFRESH_HOURS", "").strip()
    refresh = (
        {
            "scheduled": True,
            "cadence_hours": float(cadence),
            "built_by": os.environ.get("SNAPSHOT_BUILT_BY", "scheduled build"),
        }
        if cadence
        else {"scheduled": False, "cadence_hours": None, "built_by": "manual build"}
    )

    snapshot = {
        "kind": "cached_snapshot",
        "generated_at": now.isoformat(),
        "captured_window": {
            "oldest_detection_at": (
                collection.provenance.oldest_detection_at.isoformat()
                if collection.provenance.oldest_detection_at
                else None
            ),
            "newest_detection_at": (
                collection.provenance.newest_detection_at.isoformat()
                if collection.provenance.newest_detection_at
                else None
            ),
        },
        "note": (
            "Real NASA FIRMS detections enriched with OpenStreetMap context. "
            "This file is a snapshot built by the pipeline, not a live query; "
            "every timestamp is the true satellite acquisition time."
        ),
        "refresh": refresh,
        "total_locations": collection.total_matching,
        "coverage_note": collection.provenance.coverage_note,
        "surveyed_cells": collection.provenance.surveyed_cells,
        "unsurveyed_cells": collection.provenance.unsurveyed_cells,
        "analytics": json.loads(analytics.model_dump_json()),
        "model": json.loads(get_model_info(trained).model_dump_json()),
        "datasets": [json.loads(d.model_dump_json()) for d in get_datasets()],
        "locations": locations,
        "details": details,
        # Null when the per-location files were not built; the page then
        # offers detail only for the inlined subset, and says so.
        "detail_files": (
            {"count": detail_files, "path": DETAIL_PATH} if detail_files else None
        ),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    size_kb = OUT.stat().st_size / 1024
    print(
        f"Wrote {len(locations)} locations and {len(details)} details "
        f"to {OUT.relative_to(ROOT)} ({size_kb:.0f} KiB)"
    )
    if detail_files:
        print(f"  detail files: {detail_files} under {DETAIL_DIR.relative_to(ROOT)}")
    print(f"  window: {snapshot['captured_window']}")
    print(f"  coverage: {collection.provenance.coverage_note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
