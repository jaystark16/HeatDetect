"""Which Indian state or union territory, or which neighbouring country, each
location lies in.

Boundaries come from `data/boundaries/` (built by `scripts/build_boundaries.py`;
provenance in `datasets.py`). India's file follows India's official map, and
India is tested first, so a location in Pakistan- or China-administered parts
of Jammu and Kashmir or Ladakh is assigned to Jammu and Kashmir or Ladakh.
Outside India only the country is assigned: the neighbours' province data is
out of date (see the build script).

A boundary is not known exactly. India's file is simplified with a 300 m
tolerance, and a location is a ~1.1 km grid cell taken at its centre, which can
be up to ~0.8 km from a detection in it. So a location within `NEAR_BOUNDARY_M`
of another region is reported with that region as an alternative rather than
silently given one side. Nearness is tested by sampling points around the
location, not by distance to the nearest edge, so a coastline does not count as
a boundary (the sea is no region) and neither does a line that India's map does
not draw.

Pure computation over committed files: no network, no database.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Sequence

import numpy as np

BOUNDARY_DIR = Path(__file__).resolve().parent.parent / "data" / "boundaries"

NEAR_BOUNDARY_M = 1_500.0
"""300 m simplification plus up to ~0.8 km from cell centre to a detection,
with margin."""

SAMPLE_DIRECTIONS = 16

_M_PER_DEG_LAT = 111_132.0

# Bound on edges x points held at once (~32 MB per float64 temporary).
_CHUNK_ELEMENTS = 4_000_000

# Grid for the "is any boundary nearby?" prefilter. 0.03 degrees is at least
# 2.6 km in both directions across the analysis area (cos 37.5 deg x 3.3 km),
# so a boundary within NEAR_BOUNDARY_M of a point always lies in the point's
# bin or one of its eight neighbours, even allowing for the spacing at which
# edges are sampled into bins.
_BIN_DEG = 0.03
_EDGE_SAMPLE_DEG = 0.005


@dataclass(frozen=True)
class Region:
    name: str | None
    """Indian state or union territory; None outside India."""
    country: str
    edges: np.ndarray
    """(E, 4): lon0, lat0, lon1, lat1 of every ring edge."""
    bbox: tuple[float, float, float, float]

    @property
    def label(self) -> str:
        return self.name or self.country


@dataclass(frozen=True)
class RegionAssignment:
    region: str | None
    """State or union territory, for a location in India."""
    country: str | None
    """None when the location lies outside every boundary in the data (the sea,
    or a sliver between two sources' borders)."""
    alternatives: tuple[str, ...] = ()
    """Other regions within NEAR_BOUNDARY_M; the location may lie in one of them."""


def _polygons(geometry: dict) -> list:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError(f"Unsupported boundary geometry {geometry['type']!r}")


def _edges(geometry: dict) -> np.ndarray:
    parts = []
    for polygon in _polygons(geometry):
        for ring in polygon:
            pts = np.asarray(ring, dtype=float)
            if len(pts) < 3:
                continue
            if not np.array_equal(pts[0], pts[-1]):
                pts = np.vstack([pts, pts[:1]])
            parts.append(np.hstack([pts[:-1], pts[1:]]))
    return np.vstack(parts)


def _read(name: str) -> list[Region]:
    path = BOUNDARY_DIR / name
    collection = json.loads(path.read_text(encoding="utf-8"))
    regions = []
    for f in collection["features"]:
        edges = _edges(f["geometry"])
        xs = np.concatenate([edges[:, 0], edges[:, 2]])
        ys = np.concatenate([edges[:, 1], edges[:, 3]])
        regions.append(
            Region(
                name=f["properties"]["name"],
                country=f["properties"]["country"],
                edges=edges,
                bbox=(float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())),
            )
        )
    return regions


@lru_cache(maxsize=1)
def load_regions() -> tuple[Region, ...]:
    """India's states first: the order is the precedence where sources overlap."""
    return tuple(_read("india_states.geojson") + _read("neighbour_countries.geojson"))


def _inside(edges: np.ndarray, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Even-odd ray casting, vectorised over points. Holes and multiple parts
    are handled by the even-odd rule over every ring at once."""
    crossings = np.zeros(lon.shape[0], dtype=np.int64)
    x, y = lon[None, :], lat[None, :]
    step = max(1, _CHUNK_ELEMENTS // max(1, lon.shape[0]))
    for start in range(0, len(edges), step):
        e = edges[start : start + step]
        x0, y0, x1, y1 = (e[:, i : i + 1] for i in range(4))
        straddles = (y0 > y) != (y1 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            x_cross = (x1 - x0) * (y - y0) / (y1 - y0) + x0
        crossings += (straddles & (x < x_cross)).sum(axis=0)
    return crossings % 2 == 1


def _locate(regions: Sequence[Region], lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Index into `regions` of the first region containing each point, or -1."""
    found = np.full(lon.shape[0], -1, dtype=np.int64)
    for i, r in enumerate(regions):
        x0, y0, x1, y1 = r.bbox
        candidates = np.nonzero((found == -1) & (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1))[0]
        if candidates.size:
            hit = _inside(r.edges, lon[candidates], lat[candidates])
            found[candidates[hit]] = i
    return found


@lru_cache(maxsize=1)
def _edge_bins() -> frozenset[tuple[int, int]]:
    """Every grid bin some boundary edge passes through."""
    bins: set[tuple[int, int]] = set()
    for r in load_regions():
        e = r.edges
        steps = np.maximum(1, np.ceil(np.hypot(e[:, 2] - e[:, 0], e[:, 3] - e[:, 1]) / _EDGE_SAMPLE_DEG)).astype(int)
        for (x0, y0, x1, y1), n in zip(e, steps):
            t = np.linspace(0.0, 1.0, n + 1)
            xs = np.floor((x0 + (x1 - x0) * t) / _BIN_DEG).astype(int)
            ys = np.floor((y0 + (y1 - y0) * t) / _BIN_DEG).astype(int)
            bins.update(zip(xs.tolist(), ys.tolist()))
    return frozenset(bins)


def _near_some_edge(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    bins = _edge_bins()
    bx = np.floor(lon / _BIN_DEG).astype(int)
    by = np.floor(lat / _BIN_DEG).astype(int)
    return np.array(
        [any((x + dx, y + dy) in bins for dx in (-1, 0, 1) for dy in (-1, 0, 1)) for x, y in zip(bx.tolist(), by.tolist())],
        dtype=bool,
    )


def assign_regions(points: Sequence[tuple[float, float]]) -> list[RegionAssignment]:
    """Region for each (latitude, longitude)."""
    if not points:
        return []
    regions = load_regions()
    lat = np.array([p[0] for p in points], dtype=float)
    lon = np.array([p[1] for p in points], dtype=float)
    home = _locate(regions, lon, lat)

    # Only a location with an edge nearby can have another region within
    # NEAR_BOUNDARY_M; sample a circle of that radius around those.
    near = np.nonzero(_near_some_edge(lon, lat))[0]
    angles = np.linspace(0.0, 2 * math.pi, SAMPLE_DIRECTIONS, endpoint=False)
    dlat = (NEAR_BOUNDARY_M / _M_PER_DEG_LAT) * np.sin(angles)
    dlon = (NEAR_BOUNDARY_M / (_M_PER_DEG_LAT * np.cos(np.radians(lat[near]))))[:, None] * np.cos(angles)[None, :]
    around = _locate(
        regions,
        (lon[near][:, None] + dlon).ravel(),
        (lat[near][:, None] + dlat[None, :]).ravel(),
    ).reshape(len(near), SAMPLE_DIRECTIONS)
    around_by_point = dict(zip(near.tolist(), around))

    out = []
    for i in range(len(points)):
        h = int(home[i])
        here = regions[h] if h != -1 else None
        sampled = around_by_point.get(i, ())
        others = sorted({regions[j].label for j in sampled if j != -1} - {here.label if here else None})
        out.append(
            RegionAssignment(
                region=here.name if here else None,
                country=here.country if here else None,
                alternatives=tuple(others),
            )
        )
    return out
