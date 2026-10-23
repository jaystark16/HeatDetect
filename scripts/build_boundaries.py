"""Build the committed state/province boundary files from their two sources.

Run once by hand when a source changes; the outputs under
`backend/data/boundaries/` are committed so no build has to download them.

    python -I scripts/build_boundaries.py INDIA_STATES.geojson ne_10m_admin_1_states_provinces.geojson

Sources (provenance in `backend/app/datasets.py`, details in the output README):

- India: INDIA_STATES.geojson from github.com/datta07/INDIAN-SHAPEFILES (MIT).
  Chosen because it draws India as India's official map does: Gilgit-Baltistan
  and Aksai Chin in Ladakh, Pakistan-administered Kashmir in Jammu and Kashmir.
  Natural Earth's India, checked on 2026-10-23, follows the line of control and
  also put Puducherry town inside Tamil Nadu.
- Neighbours: Natural Earth 10m Admin 1 (public domain), every non-India unit
  that reaches the analysis area, kept for its **country only**. Its provinces
  are out of date here: Nepal's 14 zones (replaced by 7 provinces in 2015),
  Pakistan's F.A.T.A. (merged in 2018) and "Northern Areas", and 7 Bangladesh
  divisions (8 since 2015). A country line is stable; those names are not.
  Used only outside India's boundary.

Processing, all of it here so it can be audited:
- Dadra and Nagar Haveli and Daman and Diu merged into one union territory, as
  it has been since 26 January 2020; the India file predates the merger.
- A few names spelt out ("&" to "and", "Andaman and Nicobar Islands").
- Coordinates rounded to 6 decimals (about 0.1 m), far below the India file's
  300 m simplification tolerance.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "backend" / "data" / "boundaries"

# The analysis area (app.config.area_bbox) plus a degree, so a unit that only
# touches the edge is still included.
WEST, SOUTH, EAST, NORTH = 67.0, 5.0, 99.0, 38.5

INDIA_NAMES = {
    "Andaman & Nicobar": "Andaman and Nicobar Islands",
    "Jammu & Kashmir": "Jammu and Kashmir",
    "Dadra & Nagar Haveli": "Dadra and Nagar Haveli and Daman and Diu",
    "Daman & Diu": "Dadra and Nagar Haveli and Daman and Diu",
}
MERGED_LGD = 38  # Local Government Directory code of the merged union territory


def rounded(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 6), round(coords[1], 6)]
    return [rounded(c) for c in coords]


def polygons(geometry: dict) -> list:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError(f"unexpected geometry {geometry['type']}")


def bbox(polys: list) -> tuple[float, float, float, float]:
    xs = [p[0] for poly in polys for ring in poly for p in ring]
    ys = [p[1] for poly in polys for ring in poly for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def feature(name: str | None, country: str, code: str | None, polys: list) -> dict:
    geometry = (
        {"type": "Polygon", "coordinates": rounded(polys[0])}
        if len(polys) == 1
        else {"type": "MultiPolygon", "coordinates": rounded(polys)}
    )
    return {
        "type": "Feature",
        "properties": {"name": name, "country": country, "code": code},
        "geometry": geometry,
    }


def build_india(path: Path) -> dict:
    src = json.loads(path.read_text(encoding="utf-8"))
    merged: dict[str, dict] = {}
    for f in src["features"]:
        p = f["properties"]
        name = str(INDIA_NAMES.get(p["STNAME_SH"], p["STNAME_SH"]))
        lgd = MERGED_LGD if name == INDIA_NAMES["Daman & Diu"] else p["State_LGD"]
        entry = merged.setdefault(name, {"lgd": lgd, "polys": []})
        entry["polys"].extend(polygons(f["geometry"]))
    features = [
        feature(name, "India", f"LGD-{e['lgd']}", e["polys"])
        for name, e in sorted(merged.items())
    ]
    if len(features) != 36:
        raise SystemExit(f"expected 28 states and 8 union territories, got {len(features)}")
    return {"type": "FeatureCollection", "features": features}


def build_neighbours(path: Path) -> dict:
    src = json.loads(path.read_text(encoding="utf-8"))
    features = []
    for f in src["features"]:
        p = f["properties"]
        # Natural Earth lists the Siachen Glacier as its own unit; it is not a
        # country, and India's file already covers it as part of Ladakh.
        if p["admin"] in ("India", "Siachen Glacier") or not f.get("geometry"):
            continue
        polys = polygons(f["geometry"])
        x0, y0, x1, y1 = bbox(polys)
        if x1 < WEST or x0 > EAST or y1 < SOUTH or y0 > NORTH:
            continue
        features.append(feature(None, p["admin"], None, polys))
    features.sort(key=lambda f: f["properties"]["country"])
    return {"type": "FeatureCollection", "features": features}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(india_src: str, ne_src: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, collection in (
        ("india_states.geojson", build_india(Path(india_src))),
        ("neighbour_countries.geojson", build_neighbours(Path(ne_src))),
    ):
        target = OUT / name
        target.write_text(json.dumps(collection, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {len(collection['features'])} features, {target.stat().st_size:,} bytes")
    print(f"source sha256 india={sha256(Path(india_src))}")
    print(f"source sha256 natural_earth={sha256(Path(ne_src))}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
