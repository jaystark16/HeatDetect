"""Pure geographic helpers.

No I/O, no state — everything here is a deterministic function so it can be
tested exhaustively and reasoned about without mocks.
"""

from __future__ import annotations

import math
from typing import Final

EARTH_RADIUS_M: Final = 6_371_008.8

# Persistence aggregation grid.
#
# 0.01 degrees is ~1.11 km north-south, and ~1.03 km east-west at 22 N (central
# to India's industrial belts). VIIRS pixels are 375 m nominal and the same
# physical source jitters across neighbouring pixels between overpasses, so a
# ~1 km cell groups repeat observations of one source without merging genuinely
# separate sites. Coarser cells would merge adjacent plants; finer cells would
# split one flare across several baselines.
GRID_DEGREES: Final = 0.01


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres.

    Haversine rather than a projected CRS: at the sub-50 km ranges this system
    cares about, the error against a geodesic is well under the 375 m pixel
    footprint, and it avoids a projection dependency.
    """
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lon2 - lon1)

    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, a)))


def cell_id(latitude: float, longitude: float) -> str:
    """Stable identifier for the grid cell containing a point.

    Uses floor rather than round so that cell boundaries are unambiguous and a
    point never falls into two cells depending on floating-point noise.
    """
    lat_idx = math.floor(latitude / GRID_DEGREES)
    lon_idx = math.floor(longitude / GRID_DEGREES)
    return f"{lat_idx}:{lon_idx}"


def cell_centre(cell: str) -> tuple[float, float]:
    """Centre of a cell, for display and for distance queries."""
    lat_idx_s, lon_idx_s = cell.split(":")
    lat = (int(lat_idx_s) + 0.5) * GRID_DEGREES
    lon = (int(lon_idx_s) + 0.5) * GRID_DEGREES
    return lat, lon


def bbox_contains(
    bbox: tuple[float, float, float, float], latitude: float, longitude: float
) -> bool:
    """`bbox` is (min_lon, min_lat, max_lon, max_lat), matching GeoJSON order."""
    min_lon, min_lat, max_lon, max_lat = bbox
    return min_lat <= latitude <= max_lat and min_lon <= longitude <= max_lon
