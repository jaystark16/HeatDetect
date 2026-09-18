"""Deterministic feature computation.

Everything here is a pure function of ingested data. No model, no randomness, no
network. Given the same `detections` and `facilities` tables, these functions
produce byte-identical output — which is what makes the derived tables safe to
regenerate and safe to trust.

Two statistical choices are load-bearing:

**Median and MAD, not mean and standard deviation.** The event this system
exists to find is a single large excursion at a location that is otherwise
steady. A mean and standard deviation computed over a window *containing* that
excursion are both inflated by it, which shrinks the apparent deviation and
hides the anomaly. Median and median-absolute-deviation are unmoved by a small
number of extreme values, so the excursion stands out instead of masking itself.

**Distinct days, not observation count.** Three satellites overpass the same
point within minutes, so one event can produce several observations. Counting
distinct calendar days measures recurrence; counting rows measures how many
sensors happened to be looking.
"""

from __future__ import annotations

import logging
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Literal, Sequence

from sqlalchemy import select
from sqlalchemy.engine import Engine

from .config import CODE_VERSION, settings
from .db import cell_context, cell_stats, detections, facilities, land_parcels
from .geo import cell_centre, haversine_m
from .ingest.osm import cached_tile_keys, tile_for_point

logger = logging.getLogger(__name__)

# A land parcel centroid further than this tells us nothing useful about the
# ground under a detection, so land cover is reported as unknown instead.
LAND_COVER_MAX_DISTANCE_M = 2_000.0

# Facilities beyond this are not treated as context. 10 km is generous for a
# 375 m pixel and is used only to count "how industrial is this neighbourhood",
# never to claim attribution.
FACILITY_SEARCH_RADIUS_M = 10_000.0

FACILITY_NEIGHBOURHOOD_M = 5_000.0

ContextCoverage = Literal["surveyed", "not_surveyed"]


@dataclass(frozen=True)
class CellStats:
    cell_id: str
    observation_count: int
    distinct_days: int
    median_frp_mw: float
    p90_frp_mw: float
    mad_frp_mw: float
    median_dual_band_k: float
    night_fraction: float
    first_seen: datetime
    last_seen: datetime
    window_days: int

    @property
    def has_usable_baseline(self) -> bool:
        """Whether a deviation ratio against this baseline is meaningful.

        Below the threshold the "baseline" is a couple of points and a ratio
        against it would be noise presented as insight.
        """
        return self.observation_count >= settings.min_observations_for_baseline


@dataclass(frozen=True)
class CellContextRow:
    cell_id: str
    nearest_facility_id: str | None
    nearest_facility_name: str | None
    nearest_facility_category: str | None
    distance_to_facility_m: float | None
    facilities_within_5km: int
    land_cover: str
    context_coverage: ContextCoverage


def median_absolute_deviation(values: Sequence[float]) -> float:
    """MAD, unscaled.

    Returned raw rather than scaled by 1.4826 to approximate a standard
    deviation: the consumers here compare MAD to itself across locations, and an
    implied Gaussian would be a fiction for FRP, which is heavily right-skewed.
    """
    if len(values) < 2:
        return 0.0
    med = statistics.median(values)
    return statistics.median([abs(v - med) for v in values])


def percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolated percentile. `q` in [0, 1].

    Hand-rolled rather than using `statistics.quantiles`, which requires at least
    two data points and would raise on the many single-observation cells here.
    """
    if not values:
        raise ValueError("percentile of empty sequence")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = q * (len(ordered) - 1)
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return ordered[low] * (1 - frac) + ordered[high] * frac


# ------------------------------------------------------- spatial indexing --

# Bucket size for the facility index. 0.1 degrees is ~11 km, so a 10 km search
# radius is covered by the bucket plus its immediate neighbours.
INDEX_DEGREES = 0.1


def _bucket(latitude: float, longitude: float) -> tuple[int, int]:
    import math

    return (
        math.floor(latitude / INDEX_DEGREES),
        math.floor(longitude / INDEX_DEGREES),
    )


class PointIndex:
    """Uniform grid index over point features.

    A naive nearest-neighbour scan is O(cells x features) — roughly 13 million
    haversine calls at current data volumes. Bucketing reduces each query to the
    nine buckets that can possibly contain a match within the search radius.
    """

    def __init__(self, points: Iterable[tuple[float, float, dict]]) -> None:
        self._buckets: dict[tuple[int, int], list[tuple[float, float, dict]]] = (
            defaultdict(list)
        )
        self._count = 0
        for lat, lon, payload in points:
            self._buckets[_bucket(lat, lon)].append((lat, lon, payload))
            self._count += 1

    def __len__(self) -> int:
        return self._count

    def _candidates(
        self, latitude: float, longitude: float, radius_m: float
    ) -> list[tuple[float, float, dict]]:
        import math

        # How many buckets out we must look for the radius to be fully covered.
        span = max(1, math.ceil(radius_m / (INDEX_DEGREES * 111_320)))
        by, bx = _bucket(latitude, longitude)
        out: list[tuple[float, float, dict]] = []
        for dy in range(-span, span + 1):
            for dx in range(-span, span + 1):
                out.extend(self._buckets.get((by + dy, bx + dx), ()))
        return out

    def nearest(
        self, latitude: float, longitude: float, radius_m: float
    ) -> tuple[float, dict] | None:
        best: tuple[float, dict] | None = None
        for lat, lon, payload in self._candidates(latitude, longitude, radius_m):
            distance = haversine_m(latitude, longitude, lat, lon)
            if distance <= radius_m and (best is None or distance < best[0]):
                best = (distance, payload)
        return best

    def count_within(self, latitude: float, longitude: float, radius_m: float) -> int:
        return sum(
            1
            for lat, lon, _ in self._candidates(latitude, longitude, radius_m)
            if haversine_m(latitude, longitude, lat, lon) <= radius_m
        )


# ------------------------------------------------------------ computation --


def compute_cell_stats(engine: Engine) -> list[CellStats]:
    """Aggregate every ingested detection into per-cell persistence statistics."""
    grouped: dict[str, list[tuple[datetime, float, float, str]]] = defaultdict(list)

    with engine.connect() as conn:
        rows = conn.execute(
            select(
                detections.c.cell_id,
                detections.c.acquired_at,
                detections.c.frp_mw,
                detections.c.brightness_k,
                detections.c.brightness_long_k,
                detections.c.day_night,
            )
        )
        for cell, acquired_at, frp, bright, bright_long, day_night in rows:
            # SQLite returns naive datetimes; normalise so date arithmetic and
            # comparisons behave identically on both backends.
            if acquired_at.tzinfo is None:
                acquired_at = acquired_at.replace(tzinfo=timezone.utc)
            grouped[cell].append((acquired_at, frp, bright - bright_long, day_night))

    out: list[CellStats] = []
    for cell, observations in grouped.items():
        times = [o[0] for o in observations]
        frps = [o[1] for o in observations]
        deltas = [o[2] for o in observations]
        nights = sum(1 for o in observations if o[3] == "N")

        first_seen, last_seen = min(times), max(times)
        out.append(
            CellStats(
                cell_id=cell,
                observation_count=len(observations),
                distinct_days=len({t.date() for t in times}),
                median_frp_mw=statistics.median(frps),
                p90_frp_mw=percentile(frps, 0.9),
                mad_frp_mw=median_absolute_deviation(frps),
                median_dual_band_k=statistics.median(deltas),
                night_fraction=nights / len(observations),
                first_seen=first_seen,
                last_seen=last_seen,
                window_days=max(1, (last_seen.date() - first_seen.date()).days + 1),
            )
        )

    logger.info("features.cell_stats computed cells=%d", len(out))
    return out


def _load_facility_index(engine: Engine) -> PointIndex:
    with engine.connect() as conn:
        rows = conn.execute(
            select(
                facilities.c.facility_id,
                facilities.c.name,
                facilities.c.category,
                facilities.c.latitude,
                facilities.c.longitude,
            )
        ).all()
    return PointIndex(
        (
            r.latitude,
            r.longitude,
            {"id": r.facility_id, "name": r.name, "category": r.category},
        )
        for r in rows
    )


def _load_parcel_index(engine: Engine) -> PointIndex:
    with engine.connect() as conn:
        rows = conn.execute(
            select(
                land_parcels.c.land_cover,
                land_parcels.c.latitude,
                land_parcels.c.longitude,
            )
        ).all()
    return PointIndex(
        (r.latitude, r.longitude, {"land_cover": r.land_cover}) for r in rows
    )


def compute_cell_context(engine: Engine, cells: Iterable[str]) -> list[CellContextRow]:
    """Attach industrial proximity and land context to each cell.

    Coverage is reported per cell. A cell whose Overpass tile was never fetched
    reports `not_surveyed`, which downstream logic must treat as "unknown", never
    as "no industry here". Conflating those would let a gap in our own coverage
    masquerade as evidence.
    """
    facility_index = _load_facility_index(engine)
    parcel_index = _load_parcel_index(engine)
    surveyed = cached_tile_keys()

    logger.info(
        "features.context facilities=%d parcels=%d surveyed_tiles=%d",
        len(facility_index),
        len(parcel_index),
        len(surveyed),
    )

    out: list[CellContextRow] = []
    for cell in cells:
        lat, lon = cell_centre(cell)
        tile = tile_for_point(lat, lon, settings.overpass_tile_degrees)
        coverage: ContextCoverage = (
            "surveyed" if tile.key in surveyed else "not_surveyed"
        )

        nearest = facility_index.nearest(lat, lon, FACILITY_SEARCH_RADIUS_M)
        parcel = parcel_index.nearest(lat, lon, LAND_COVER_MAX_DISTANCE_M)

        out.append(
            CellContextRow(
                cell_id=cell,
                nearest_facility_id=nearest[1]["id"] if nearest else None,
                nearest_facility_name=nearest[1]["name"] if nearest else None,
                nearest_facility_category=nearest[1]["category"] if nearest else None,
                distance_to_facility_m=nearest[0] if nearest else None,
                facilities_within_5km=facility_index.count_within(
                    lat, lon, FACILITY_NEIGHBOURHOOD_M
                ),
                land_cover=parcel[1]["land_cover"] if parcel else "unknown",
                context_coverage=coverage,
            )
        )
    return out


# ------------------------------------------------------------- persistence --


def store_cell_stats(engine: Engine, rows: Sequence[CellStats]) -> int:
    now = datetime.now(timezone.utc)
    payload = [
        {
            "cell_id": r.cell_id,
            "observation_count": r.observation_count,
            "distinct_days": r.distinct_days,
            "median_frp_mw": r.median_frp_mw,
            "p90_frp_mw": r.p90_frp_mw,
            "mad_frp_mw": r.mad_frp_mw,
            "median_dual_band_k": r.median_dual_band_k,
            "night_fraction": r.night_fraction,
            "first_seen": r.first_seen,
            "last_seen": r.last_seen,
            "window_days": r.window_days,
            "computed_at": now,
            "code_version": CODE_VERSION,
        }
        for r in rows
    ]
    with engine.begin() as conn:
        conn.execute(cell_stats.delete())
        if payload:
            conn.execute(cell_stats.insert(), payload)
    return len(payload)


def store_cell_context(engine: Engine, rows: Sequence[CellContextRow]) -> int:
    now = datetime.now(timezone.utc)
    payload = [
        {
            "cell_id": r.cell_id,
            "nearest_facility_id": r.nearest_facility_id,
            "nearest_facility_name": r.nearest_facility_name,
            "nearest_facility_category": r.nearest_facility_category,
            "distance_to_facility_m": r.distance_to_facility_m,
            "facilities_within_5km": r.facilities_within_5km,
            "land_cover": r.land_cover,
            "context_coverage": r.context_coverage,
            "computed_at": now,
            "code_version": CODE_VERSION,
        }
        for r in rows
    ]
    with engine.begin() as conn:
        conn.execute(cell_context.delete())
        if payload:
            conn.execute(cell_context.insert(), payload)
    return len(payload)
