"""Generate the frontend's offline fallback snapshot from the backend's samples.

Run from the repository root:

    backend/.venv/Scripts/python scripts/generate_fallback.py

Timestamps are stored as `hours_ago` offsets rather than absolute times, so the
bundled demo always looks recent instead of decaying into "3 months ago" and
falling out of the dashboard's time-window filters.

Keeping this as a script rather than a hand-maintained copy means the fallback
cannot silently drift from the API's own sample data.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.sample_data import sample_hotspots  # noqa: E402

OUT = ROOT / "frontend" / "src" / "fallback" / "snapshot.json"


def main() -> None:
    now = datetime.now(timezone.utc)
    records = []

    for hotspot in sample_hotspots():
        record = json.loads(hotspot.model_dump_json())
        hours = (now - hotspot.acquired_at).total_seconds() / 3600
        record["hours_ago"] = round(hours, 2)
        del record["acquired_at"]
        records.append(record)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(records)} hotspots to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
