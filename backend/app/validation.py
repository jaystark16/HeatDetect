"""A blind hand-check of the classifications: draw a sample, then score it.

There is no public ground truth for what each hotspot was (CONTEXT.md), so every
metric the model reports is agreement with our own rules. This is the honest
alternative: people look at independent imagery for a stratified sample of
locations and say what is there, without seeing what HeatDetect decided.

    python -m app.validation sample --snapshot https://jaystark16.github.io/HeatDetect/snapshot.json
    python -m app.validation score --sample docs/validation/<name>-sample.csv

`sample` writes two files: a blind sheet for the checkers (place, date, imagery
links, empty label columns) and a key holding the system's answers. `score`
joins them and reports precision per class with a 95% Wilson interval.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.request import urlopen

# What a checker may answer. Anything else in the sheet is a typo and fails
# loudly rather than being counted as a disagreement.
LABELS = ("industrial", "vegetation", "other", "cannot_tell")

# The label a correct system answer should get. `unknown` has none: for it the
# check reports what the unclassified places turned out to be.
EXPECTED: dict[str, str] = {
    "industrial_fire": "industrial",
    "persistent_industrial": "industrial",
    "natural_fire": "vegetation",
}

# Locations drawn per system class; a class with fewer is taken whole.
DEFAULT_TARGETS: dict[str, int] = {
    "industrial_fire": 50,
    "persistent_industrial": 100,
    "natural_fire": 100,
    "unknown": 50,
}

# NASA Worldview layer ids, checked against its live configuration on
# 2026-10-24. Listed top first, base imagery last.
FIRE_LAYERS = (
    "VIIRS_NOAA21_Thermal_Anomalies_375m_All",
    "VIIRS_NOAA20_Thermal_Anomalies_375m_All",
    "VIIRS_SNPP_Thermal_Anomalies_375m_All",
    "MODIS_Terra_Thermal_Anomalies_All",
    "MODIS_Aqua_Thermal_Anomalies_All",
    "Reference_Labels_15m",
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
)
THERMAL_LAYERS = (
    "VIIRS_NOAA20_Thermal_Anomalies_375m_All",
    "Reference_Labels_15m",
    "VIIRS_NOAA20_Brightness_Temp_BandI5_Night",
)

SAMPLE_COLUMNS = (
    "sample_id",
    "latitude",
    "longitude",
    "date_utc",
    "google_pin",
    "google_satellite",
    "worldview_fires",
    "worldview_thermal_night",
    "human_label",
    "sure",
    "checked_by",
    "notes",
)
KEY_COLUMNS = (
    "sample_id",
    "location_id",
    "cell_id",
    "system_class",
    "region",
    "country",
    "distinct_days",
    "peak_frp_mw",
    "observation_count",
    "last_seen",
)


# ----------------------------------------------------------------- links --


def google_pin(latitude: float, longitude: float) -> str:
    """Google's documented search form: drops a pin on the exact point."""
    return f"https://www.google.com/maps/search/?api=1&query={latitude:.5f}%2C{longitude:.5f}"


def google_satellite(latitude: float, longitude: float) -> str:
    """Google's documented Maps URLs form for a satellite view of a point."""
    return (
        "https://www.google.com/maps/@?api=1&map_action=map"
        f"&center={latitude:.5f}%2C{longitude:.5f}&zoom=16&basemap=satellite"
    )


def worldview(latitude: float, longitude: float, day: str, layers: Sequence[str]) -> str:
    """NASA Worldview on that day, framed about 25 km around the point.

    Tested 2026-10-24: a 0.1° frame is too small for Worldview, which then
    opens on the whole globe; 0.5° frames the point correctly.
    """
    half = 0.25
    view = f"{longitude - half:.4f},{latitude - half:.4f},{longitude + half:.4f},{latitude + half:.4f}"
    return (
        f"https://worldview.earthdata.nasa.gov/?v={view}"
        f"&l={','.join(layers)}&t={day}-T00%3A00%3A00Z"
    )


# ---------------------------------------------------------------- sample --


def load_snapshot(source: str) -> dict[str, Any]:
    """A snapshot file path, or the URL of a published one."""
    if source.startswith(("http://", "https://")):
        with urlopen(source, timeout=120) as response:
            return json.load(response)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def draw_sample(
    locations: Sequence[dict[str, Any]],
    targets: dict[str, int],
    seed: int,
) -> list[dict[str, Any]]:
    """A seeded, stratified draw, shuffled so the sheet's order reveals no class."""
    rng = random.Random(seed)
    chosen: list[dict[str, Any]] = []
    for label, wanted in targets.items():
        # Sorted first, so the same seed draws the same places from the same data.
        pool = sorted(
            (loc for loc in locations if loc["label"] == label),
            key=lambda loc: loc["representative_detection_id"],
        )
        chosen.extend(rng.sample(pool, min(wanted, len(pool))))
    rng.shuffle(chosen)
    return chosen


def sheet_rows(chosen: Sequence[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The blind sheet and its key, row for row."""
    sample, key = [], []
    for i, loc in enumerate(chosen, start=1):
        sid = f"V{i:03d}"
        lat, lon = float(loc["latitude"]), float(loc["longitude"])
        day = str(loc["last_seen"])[:10]
        sample.append(
            {
                "sample_id": sid,
                "latitude": f"{lat:.5f}",
                "longitude": f"{lon:.5f}",
                "date_utc": day,
                "google_pin": google_pin(lat, lon),
                "google_satellite": google_satellite(lat, lon),
                "worldview_fires": worldview(lat, lon, day, FIRE_LAYERS),
                "worldview_thermal_night": worldview(lat, lon, day, THERMAL_LAYERS),
                "human_label": "",
                "sure": "",
                "checked_by": "",
                "notes": "",
            }
        )
        key.append(
            {
                "sample_id": sid,
                "location_id": loc["representative_detection_id"],
                "cell_id": loc["cell_id"],
                "system_class": loc["label"],
                "region": loc.get("region") or "",
                "country": loc.get("country") or "",
                "distinct_days": loc["distinct_days"],
                "peak_frp_mw": loc["max_frp_mw"],
                "observation_count": loc["observation_count"],
                "last_seen": loc["last_seen"],
            }
        )
    return sample, key


def write_csv(path: Path, columns: Sequence[str], rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(columns))
        writer.writeheader()
        writer.writerows(rows)


# ----------------------------------------------------------------- score --


def wilson(agreed: int, checked: int, z: float = 1.96) -> tuple[float, float] | None:
    """95% Wilson score interval; None when nothing was checked."""
    if checked == 0:
        return None
    p = agreed / checked
    centre = (p + z * z / (2 * checked)) / (1 + z * z / checked)
    half = z * math.sqrt(p * (1 - p) / checked + z * z / (4 * checked * checked)) / (1 + z * z / checked)
    return max(0.0, centre - half), min(1.0, centre + half)


@dataclass
class ClassScore:
    system_class: str
    drawn: int = 0
    pending: int = 0
    cannot_tell: int = 0
    labels: Counter = field(default_factory=Counter)

    @property
    def checked(self) -> int:
        """Locations with a decisive label: industrial, vegetation or other."""
        return sum(n for label, n in self.labels.items() if label != "cannot_tell")

    @property
    def agreed(self) -> int:
        expected = EXPECTED.get(self.system_class)
        return self.labels.get(expected, 0) if expected else 0


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def score(sample: Sequence[dict[str, str]], key: Sequence[dict[str, str]]) -> dict[str, ClassScore]:
    by_id = {row["sample_id"]: row for row in key}
    missing = [row["sample_id"] for row in sample if row["sample_id"] not in by_id]
    if missing:
        raise ValueError(f"Sample rows with no key entry: {', '.join(missing[:10])}")
    bad = [
        f"{row['sample_id']}={row['human_label']!r}"
        for row in sample
        if row.get("human_label", "").strip() and row["human_label"].strip().lower() not in LABELS
    ]
    if bad:
        raise ValueError(f"Labels must be one of {', '.join(LABELS)}; got {', '.join(bad[:10])}")

    scores: dict[str, ClassScore] = {}
    for row in sample:
        system_class = by_id[row["sample_id"]]["system_class"]
        s = scores.setdefault(system_class, ClassScore(system_class))
        s.drawn += 1
        label = row.get("human_label", "").strip().lower()
        if not label:
            s.pending += 1
        elif label == "cannot_tell":
            s.cannot_tell += 1
            s.labels[label] += 1
        else:
            s.labels[label] += 1
    return scores


def report(scores: dict[str, ClassScore]) -> str:
    order = [c for c in (*EXPECTED, "unknown") if c in scores] + sorted(set(scores) - {*EXPECTED, "unknown"})
    lines = [
        "| System class | Drawn | Checked | Agreed | Precision | 95% interval | Can't tell | Not yet checked |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for c in order:
        s = scores[c]
        if c in EXPECTED and s.checked:
            low, high = wilson(s.agreed, s.checked)  # type: ignore[misc]
            precision = f"{s.agreed / s.checked:.0%}"
            interval = f"{low:.0%}–{high:.0%}"
        else:
            precision = interval = "—"
        lines.append(
            f"| {c} | {s.drawn} | {s.checked} | {s.agreed if c in EXPECTED else '—'} | {precision} | "
            f"{interval} | {s.cannot_tell} | {s.pending} |"
        )
    if "unknown" in scores:
        u = scores["unknown"]
        found = ", ".join(f"{label} {n}" for label, n in u.labels.most_common()) or "none checked yet"
        lines.append("")
        lines.append(f"Unclassified locations, as checked: {found}.")
    lines.append("")
    lines.append(
        "Precision is the share of decisive checks (industrial, vegetation or other) that match the "
        "system's class; 'can't tell' is left out of it and reported separately."
    )
    return "\n".join(lines)


# ------------------------------------------------------------------- cli --


def _cmd_sample(args: argparse.Namespace) -> int:
    snapshot = load_snapshot(args.snapshot)
    chosen = draw_sample(snapshot["locations"], DEFAULT_TARGETS, args.seed)
    sample, key = sheet_rows(chosen)
    stem = Path(args.out) / args.name
    write_csv(stem.with_name(f"{args.name}-sample.csv"), SAMPLE_COLUMNS, sample)
    write_csv(stem.with_name(f"{args.name}-key.csv"), KEY_COLUMNS, key)
    drawn = Counter(row["system_class"] for row in key)
    print(
        f"Drew {len(sample)} locations from {len(snapshot['locations']):,} "
        f"(snapshot generated {snapshot.get('generated_at')}, seed {args.seed}): "
        + ", ".join(f"{c} {n}" for c, n in sorted(drawn.items()))
    )
    return 0


def _cmd_score(args: argparse.Namespace) -> int:
    sample_path = Path(args.sample)
    key_path = Path(args.key) if args.key else sample_path.with_name(sample_path.name.replace("-sample", "-key"))
    print(report(score(read_csv(sample_path), read_csv(key_path))))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    # The report has dashes and percent signs; a Windows console defaults to a
    # code page that turns them into "?" (observed 2026-10-24).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    parser = argparse.ArgumentParser(prog="python -m app.validation", description=(__doc__ or "").split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sample", help="draw a blind, stratified sample to check by hand")
    s.add_argument("--snapshot", required=True, help="snapshot.json path or URL")
    s.add_argument("--out", default="../docs/validation", help="directory for the two CSV files")
    s.add_argument("--name", required=True, help="file name stem, e.g. 2026-10-24")
    s.add_argument("--seed", type=int, default=20261024)
    s.set_defaults(func=_cmd_sample)
    c = sub.add_parser("score", help="score a labelled sample against its key")
    c.add_argument("--sample", required=True)
    c.add_argument("--key", help="defaults to the sample's name with -key in place of -sample")
    c.set_defaults(func=_cmd_score)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
