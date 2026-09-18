"""Export a real data snapshot for the static frontend deployment.

    backend/.venv/Scripts/python scripts/export_snapshot.py

Why this exists: the dashboard is deployed as a static site on GitHub Pages,
where no API is reachable. Rather than showing an error, it loads this snapshot.

This replaced an earlier hand-written "sample data" module whose FRP values,
baselines and confidence scores were all invented. Nothing here is invented —
every value is read from the database that the pipeline populated from NASA
FIRMS and OpenStreetMap.

The snapshot is labelled `cached_snapshot`, never `live`. It records the exact
window it covers and when it was generated, so a viewer can tell how old it is.
Detections are stored with an age offset so the relative time filters remain
meaningful as the file ages, but `captured_at` always states the truth about
when the data was actually collected.
"""

from __future__ import annotations

import json
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

# Summaries are tiny (~150 bytes each) so the map stays complete. Full detail
# with evidence is ~1.5 KB each, so it is limited to the most significant
# locations — ordering already puts recurring, high-FRP cells first.
MAX_SUMMARIES = 4000
MAX_DETAILS = 300


def main() -> int:
    engine = build_engine()
    trained = ml.load()

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

    summaries = []
    for h in collection.hotspots:
        payload = json.loads(h.model_dump_json())
        payload["hours_ago"] = round(
            (now - h.acquired_at).total_seconds() / 3600, 2
        )
        del payload["acquired_at"]
        summaries.append(payload)

    details = {}
    for h in collection.hotspots[:MAX_DETAILS]:
        detail = get_hotspot_detail(engine, h.id, trained)
        if detail is None:
            continue
        payload = json.loads(detail.model_dump_json())
        payload["hours_ago"] = round(
            (now - detail.acquired_at).total_seconds() / 3600, 2
        )
        del payload["acquired_at"]
        details[h.id] = payload

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
            "Real NASA FIRMS detections enriched with OpenStreetMap context, "
            "captured at the time above. This is a cached snapshot, not live data."
        ),
        "total_matching": collection.total_matching,
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
