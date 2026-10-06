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

Environment:
  SNAPSHOT_REFRESH_HOURS  set by the scheduled Pages workflow to its cadence.
                          Unset means a manual, one-off build.
  SNAPSHOT_BUILT_BY       free-text provenance, e.g. "github-actions".
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import model as ml  # noqa: E402
from app.db import build_engine  # noqa: E402
from app.service import (  # noqa: E402
    HotspotFilters,
    get_analytics,
    get_datasets,
    get_hotspot_detail,
    get_model_info,
    list_hotspots,
)

# `public/`, not `src/`: importing this from source would inline ~1.8 MiB into
# the JS bundle for every visitor. As a public asset it is a separate file,
# served gzipped by the CDN and fetched only when the API cannot be reached.
OUT = ROOT / "frontend" / "public" / "snapshot.json"

# Summaries are tiny (~150 bytes each). Full detail with evidence is ~1.5 KB
# each, so it is limited to the most significant locations.
MAX_SUMMARIES = 4000
MAX_DETAILS = 300

# Summaries are drawn PER CLASS, not from one ranked list.
#
# The API orders by persistence descending, which is right for an operator but
# wrong for an export: vegetation fires are short-lived by definition, so a
# straight top-4000 contained 2,712 persistent-industrial rows, 445 industrial
# fires, 843 unclassified and **zero** vegetation fires — the offline map
# implied every thermal anomaly in India was industrial. Quotas keep the
# snapshot representative of what the database actually holds.
CLASS_QUOTAS = {
    # Rare and operationally important: take everything.
    "industrial_fire": 600,
    "persistent_industrial": 1400,
    "natural_fire": 1400,
    "unknown": 600,
}


def main() -> int:
    engine = build_engine()
    trained = ml.load()

    # One query per class, so each is represented up to its quota.
    per_class = {
        label: list_hotspots(engine, HotspotFilters(label=label, limit=quota))
        for label, quota in CLASS_QUOTAS.items()
    }

    collection = list_hotspots(engine, HotspotFilters(limit=MAX_SUMMARIES))
    if collection.count == 0:
        print(
            "Refusing to write an empty snapshot. Run the pipeline first:\n"
            "  python -m app.pipeline ingest && python -m app.pipeline features",
            file=sys.stderr,
        )
        return 1

    analytics = get_analytics(engine)
    now = datetime.now(timezone.utc)

    selected: list = []
    for label in CLASS_QUOTAS:
        selected.extend(per_class[label].hotspots)

    # Deterministic order so repeated exports of the same database are identical.
    selected.sort(key=lambda h: (-h.distinct_days, -h.frp_mw, h.id))

    # True acquisition times, exactly as the database holds them.
    summaries = [json.loads(h.model_dump_json()) for h in selected]

    # Detail is spread across classes too, so an offline user can inspect a
    # vegetation fire and an industrial source, not only the persistent ones.
    detail_targets: list = []
    per_class_detail = max(1, MAX_DETAILS // len(CLASS_QUOTAS))
    for label in CLASS_QUOTAS:
        detail_targets.extend(per_class[label].hotspots[:per_class_detail])

    details = {}
    for h in detail_targets:
        detail = get_hotspot_detail(engine, h.id, trained)
        if detail is None:
            continue
        details[h.id] = json.loads(detail.model_dump_json())

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
        "total_matching": collection.total_matching,
        "summary_selection": "per-class quotas; see CLASS_QUOTAS in scripts/export_snapshot.py",
        "coverage_note": collection.provenance.coverage_note,
        "surveyed_cells": collection.provenance.surveyed_cells,
        "unsurveyed_cells": collection.provenance.unsurveyed_cells,
        "analytics": json.loads(analytics.model_dump_json()),
        "model": json.loads(get_model_info(trained).model_dump_json()),
        "datasets": [json.loads(d.model_dump_json()) for d in get_datasets()],
        "summaries": summaries,
        "details": details,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    size_kb = OUT.stat().st_size / 1024
    print(
        f"Wrote {len(summaries)} summaries and {len(details)} details "
        f"to {OUT.relative_to(ROOT)} ({size_kb:.0f} KiB)"
    )
    print(f"  window: {snapshot['captured_window']}")
    print(f"  coverage: {collection.provenance.coverage_note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
