"""OpenStreetMap industrial and land-context ingestion via Overpass.

Overpass is a **donated community service** and it throttles by client. Measured
during development: an identical query shape returned 89 KiB in 24 s for one
tile, then 504'd for a strictly smaller tile minutes later — i.e. the failures
were quota, not payload. A naive per-hotspot loop would both fail and be abusive.

The design that follows from that:

  1. **Disk cache, checked first.** A tile is fetched at most once per query
     version. The cache is committed to the repository, so a fresh clone, a CI
     run and a live demo need no Overpass access at all.
  2. **Only tiles containing detections** are ever requested. Empty ocean and
     empty desert are never queried.
  3. **Backoff and a fallback mirror**, and the run is **resumable** — a
     throttled run persists what it got and continues later.
  4. **Partial coverage is recorded, not hidden.** A cell in an unfetched tile
     reports `not_surveyed`, which is different from "no industry nearby". That
     distinction matters: treating unsurveyed as empty would turn a gap in our
     coverage into apparent evidence of absence.

Bulk land-cover polygons are deliberately NOT fetched. Full geometry measured at
6.1 MiB for a single 1-degree tile (~116k nodes), which extrapolates to roughly
1.8 GiB for India. Land context here is therefore centroid-proximity based and
labelled approximate. See docs/adr/0002-data-sources.md.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal

import httpx

from ..config import settings
from ..geo import cell_id

logger = logging.getLogger(__name__)

USER_AGENT = (
    "HeatDetect/0.1 (SIH26162 prototype; +https://github.com/jaystark16/HeatDetect)"
)

CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "osm_cache"

# Bumped when the query text changes, which invalidates cached tiles by filename
# rather than by silently mixing results from two different questions.
QUERY_VERSION = "v1"


# --------------------------------------------------------------- taxonomy --

FacilityCategory = Literal[
    "oil", "steel", "power", "mining", "chemical", "works", "industrial"
]

LandCover = Literal[
    "industrial", "urban", "forest", "cropland", "shrubland", "barren", "water", "unknown"
]

# Ordered most-specific first: a way tagged both `landuse=industrial` and
# `industrial=oil` should classify as oil, not as generic industrial.
FACILITY_RULES: tuple[tuple[str, str, FacilityCategory], ...] = (
    ("industrial", "oil", "oil"),
    ("industrial", "refinery", "oil"),
    ("industrial", "petroleum", "oil"),
    ("man_made", "petroleum_well", "oil"),
    ("industrial", "steel", "steel"),
    ("industrial", "foundry", "steel"),
    ("industrial", "smelting", "steel"),
    ("industrial", "chemical", "chemical"),
    ("industrial", "mine", "mining"),
    ("landuse", "quarry", "mining"),
    ("man_made", "mineshaft", "mining"),
    ("power", "plant", "power"),
    ("man_made", "works", "works"),
    ("landuse", "industrial", "industrial"),
)

LANDCOVER_RULES: tuple[tuple[str, str, LandCover], ...] = (
    ("landuse", "industrial", "industrial"),
    ("landuse", "quarry", "barren"),
    ("landuse", "forest", "forest"),
    ("natural", "wood", "forest"),
    ("natural", "scrub", "shrubland"),
    ("natural", "heath", "shrubland"),
    ("landuse", "farmland", "cropland"),
    ("landuse", "orchard", "cropland"),
    ("landuse", "residential", "urban"),
    ("landuse", "commercial", "urban"),
    ("landuse", "retail", "urban"),
    ("natural", "water", "water"),
    ("landuse", "reservoir", "water"),
    ("natural", "bare_rock", "barren"),
    ("natural", "sand", "barren"),
)


def classify_facility(tags: dict[str, str]) -> tuple[FacilityCategory, str] | None:
    for key, value, category in FACILITY_RULES:
        if tags.get(key) == value:
            return category, f"{key}={value}"
    return None


def classify_land_cover(tags: dict[str, str]) -> tuple[LandCover, str] | None:
    for key, value, cover in LANDCOVER_RULES:
        if tags.get(key) == value:
            return cover, f"{key}={value}"
    return None


# ------------------------------------------------------------------ types --


@dataclass(frozen=True)
class Facility:
    osm_type: str
    osm_id: str
    name: str | None
    category: FacilityCategory
    source_tag: str
    latitude: float
    longitude: float
    fetched_at: datetime


@dataclass(frozen=True)
class LandParcel:
    osm_type: str
    osm_id: str
    land_cover: LandCover
    source_tag: str
    latitude: float
    longitude: float
    fetched_at: datetime


@dataclass(frozen=True)
class Tile:
    """Half-open tile [min_lat, max_lat) x [min_lon, max_lon)."""

    min_lat: float
    min_lon: float
    size: float

    @property
    def max_lat(self) -> float:
        return self.min_lat + self.size

    @property
    def max_lon(self) -> float:
        return self.min_lon + self.size

    @property
    def key(self) -> str:
        return f"{self.min_lat:.2f}_{self.min_lon:.2f}_{self.size:.2f}"

    def overpass_bbox(self) -> str:
        return f"{self.min_lat},{self.min_lon},{self.max_lat},{self.max_lon}"

    def cache_path(self) -> Path:
        """Gzipped, because the cache is committed to the repository.

        Raw payloads measured ~330 KiB per tile, which extrapolates to ~37 MiB
        across the 117 tiles containing detections — too much to put in git.
        Gzip gets that to a few MiB while keeping the *full* Overpass response,
        so classification rules can be changed and re-derived without going back
        to a rate-limited service.
        """
        return CACHE_DIR / f"{QUERY_VERSION}_{self.key}.json.gz"

    def legacy_cache_path(self) -> Path:
        """Uncompressed path, still read so early caches are not wasted."""
        return CACHE_DIR / f"{QUERY_VERSION}_{self.key}.json"


def tile_for_point(latitude: float, longitude: float, size: float) -> Tile:
    return Tile(
        min_lat=math.floor(latitude / size) * size,
        min_lon=math.floor(longitude / size) * size,
        size=size,
    )


def tiles_for_points(
    points: Iterable[tuple[float, float]], size: float | None = None
) -> list[Tile]:
    """Distinct tiles containing at least one point.

    This is the whole reason the Overpass budget is affordable: only places with
    an actual detection are ever queried.
    """
    size = size or settings.overpass_tile_degrees
    seen: dict[str, Tile] = {}
    for lat, lon in points:
        tile = tile_for_point(lat, lon, size)
        seen.setdefault(tile.key, tile)
    return sorted(seen.values(), key=lambda t: (t.min_lat, t.min_lon))


# ----------------------------------------------------------------- query --


def build_query(tile: Tile) -> str:
    """One tile, one request, centroids only.

    The tag set is deliberately narrow. A broader landuse regex
    (residential|commercial|retail|meadow|orchard) was measured to time out:
    those classes are numerically dominant and add little discriminating power
    over "distance to nearest industrial feature".
    """
    box = tile.overpass_bbox()
    return f"""
[out:json][timeout:{settings.overpass_timeout_seconds}];
(
  way["landuse"="industrial"]({box});
  way["man_made"="works"]({box});
  way["power"="plant"]({box});
  way["landuse"="quarry"]({box});
  way["landuse"="forest"]({box});
  way["natural"="wood"]({box});
  relation["landuse"="industrial"]({box});
);
out center tags;
""".strip()


class OverpassThrottled(RuntimeError):
    """Overpass declined the request. Distinct from "no features here"."""


@dataclass
class TileResult:
    tile: Tile
    facilities: list[Facility]
    parcels: list[LandParcel]
    fetched_at: datetime
    from_cache: bool


def _parse_payload(payload: dict, tile: Tile, fetched_at: datetime) -> TileResult:
    facilities: list[Facility] = []
    parcels: list[LandParcel] = []

    for element in payload.get("elements", []):
        centre = element.get("center") or {}
        lat, lon = centre.get("lat"), centre.get("lon")
        if lat is None or lon is None:
            # `out center` omits the centre for degenerate geometry. Skipping is
            # correct: a feature with no location cannot inform a distance.
            continue

        tags = element.get("tags") or {}
        osm_type = str(element.get("type", "way"))
        osm_id = str(element.get("id", ""))

        facility = classify_facility(tags)
        if facility is not None:
            category, source_tag = facility
            facilities.append(
                Facility(
                    osm_type=osm_type,
                    osm_id=osm_id,
                    name=(tags.get("name") or None),
                    category=category,
                    source_tag=source_tag,
                    latitude=float(lat),
                    longitude=float(lon),
                    fetched_at=fetched_at,
                )
            )

        cover = classify_land_cover(tags)
        if cover is not None:
            land_cover, source_tag = cover
            parcels.append(
                LandParcel(
                    osm_type=osm_type,
                    osm_id=osm_id,
                    land_cover=land_cover,
                    source_tag=source_tag,
                    latitude=float(lat),
                    longitude=float(lon),
                    fetched_at=fetched_at,
                )
            )

    return TileResult(
        tile=tile,
        facilities=facilities,
        parcels=parcels,
        fetched_at=fetched_at,
        from_cache=False,
    )


def _read_cache_file(path: Path) -> dict | None:
    try:
        if path.suffix == ".gz":
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                return json.load(handle)
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, EOFError):
        logger.warning("osm.cache unreadable, ignoring: %s", path.name)
        return None


def load_cached(tile: Tile) -> TileResult | None:
    path = next(
        (p for p in (tile.cache_path(), tile.legacy_cache_path()) if p.exists()),
        None,
    )
    if path is None:
        return None

    raw = _read_cache_file(path)
    if raw is None:
        return None

    fetched_at = datetime.fromisoformat(raw["fetched_at"])
    result = _parse_payload(raw["payload"], tile, fetched_at)
    return TileResult(
        tile=tile,
        facilities=result.facilities,
        parcels=result.parcels,
        fetched_at=fetched_at,
        from_cache=True,
    )


def fetch_tile(
    tile: Tile,
    *,
    client: httpx.Client | None = None,
    max_attempts: int = 3,
) -> TileResult:
    """Fetch one tile, honouring the cache. Raises `OverpassThrottled` on refusal.

    Never returns an empty result to signal failure — an empty tile and a refused
    request are different facts and must stay different.
    """
    cached = load_cached(tile)
    if cached is not None:
        return cached

    owned = client is None
    client = client or httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=httpx.Timeout(settings.overpass_timeout_seconds + 60),
    )

    query = build_query(tile)
    urls = [settings.overpass_url, settings.overpass_fallback_url]
    last_error = "no attempt made"

    try:
        for attempt in range(max_attempts):
            url = urls[min(attempt, len(urls) - 1)]
            try:
                response = client.post(url, data={"data": query})
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            else:
                if response.status_code == 200:
                    fetched_at = datetime.now(timezone.utc)
                    payload = response.json()
                    CACHE_DIR.mkdir(parents=True, exist_ok=True)
                    envelope = {
                        "tile": tile.key,
                        "query_version": QUERY_VERSION,
                        "source_url": url,
                        "fetched_at": fetched_at.isoformat(),
                        "payload": payload,
                    }
                    with gzip.open(
                        tile.cache_path(), "wt", encoding="utf-8", compresslevel=9
                    ) as handle:
                        json.dump(envelope, handle, separators=(",", ":"))
                    return _parse_payload(payload, tile, fetched_at)

                # 429 and 504 are Overpass's throttling responses.
                last_error = f"HTTP {response.status_code}"

            if attempt < max_attempts - 1:
                backoff = settings.overpass_delay_seconds * (2**attempt)
                logger.info(
                    "osm.retry tile=%s attempt=%d/%d after %s, sleeping %.1fs",
                    tile.key,
                    attempt + 1,
                    max_attempts,
                    last_error,
                    backoff,
                )
                time.sleep(backoff)
    finally:
        if owned:
            client.close()

    raise OverpassThrottled(
        f"Overpass refused tile {tile.key} after {max_attempts} attempts "
        f"(last: {last_error}). Cached tiles remain usable; rerun later to fill gaps."
    )


def cached_tile_keys() -> set[str]:
    """Which tiles we already hold, for honest coverage reporting."""
    if not CACHE_DIR.exists():
        return set()
    prefix = f"{QUERY_VERSION}_"
    keys: set[str] = set()
    for pattern in (f"{prefix}*.json.gz", f"{prefix}*.json"):
        for path in CACHE_DIR.glob(pattern):
            name = path.name[len(prefix) :]
            name = name.removesuffix(".gz").removesuffix(".json")
            keys.add(name)
    return keys


def facility_cell(facility: Facility) -> str:
    return cell_id(facility.latitude, facility.longitude)


def parcel_cell(parcel: LandParcel) -> str:
    return cell_id(parcel.latitude, parcel.longitude)
