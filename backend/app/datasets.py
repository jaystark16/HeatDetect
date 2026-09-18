"""Dataset catalogue: provenance metadata for every external source.

This is deliberately code rather than documentation. The API exposes it at
`/api/datasets`, the dashboard renders it, and ingestion records reference these
identifiers — so a hotspot on the map can always be traced back to a named
source with a stated licence and stated limitations.

Rules this file enforces by existing:
  - No dataset is used without declared provenance.
  - Limitations are recorded next to the data, not buried in a report.
  - Nothing here describes data we do not actually fetch.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class DataKind(str, Enum):
    """Whether values are measured, derived by us, or invented for testing."""

    OBSERVED = "observed"
    """Measured by an instrument and published by the provider, unmodified."""

    DERIVED = "derived"
    """Computed by this system from observed data via documented logic."""

    SYNTHETIC = "synthetic"
    """Fabricated for tests or fixtures. Never served as if real."""


@dataclass(frozen=True)
class Dataset:
    id: str
    name: str
    provider: str
    kind: DataKind
    source_url: str
    licence: str
    update_frequency: str
    spatial_resolution: str | None
    fields: tuple[str, ...]
    limitations: tuple[str, ...]
    requires_credentials: bool = False
    notes: str | None = None
    citation: str | None = None


FIRMS_VIIRS = Dataset(
    id="firms_viirs_snpp",
    name="VIIRS 375 m Active Fire (Suomi NPP, NOAA-20, NOAA-21)",
    provider="NASA FIRMS / LANCE",
    kind=DataKind.OBSERVED,
    source_url="https://firms.modaps.eosdis.nasa.gov/active_fire/",
    licence=(
        "NASA open data. Free to use with attribution; see "
        "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies"
    ),
    update_frequency="Near real time, roughly every 3 hours; regional files cover 24h/7d",
    spatial_resolution="375 m nominal at nadir",
    fields=(
        "latitude",
        "longitude",
        "bright_ti4",
        "bright_ti5",
        "scan",
        "track",
        "acq_date",
        "acq_time",
        "satellite",
        "confidence",
        "version",
        "frp",
        "daynight",
    ),
    limitations=(
        "A thermal anomaly is evidence of unusual heat, not proof of a fire, "
        "accident or explosion.",
        "At 375 m resolution a detection cannot be attributed to a specific "
        "facility with certainty.",
        "Satellites do not observe continuously; absence of a detection does not "
        "mean absence of heat.",
        "Cloud cover suppresses detections, so gaps are not evidence of quiet.",
        "NRT (near real time) records are not the final science-quality product "
        "and may be revised.",
        "Regional archive files cover a rolling window only — they are not a "
        "long-term historical record.",
    ),
    requires_credentials=False,
    notes=(
        "The /data/active_fire/ regional archives are openly downloadable. The "
        "/api/ endpoints additionally require a free MAP_KEY, which this system "
        "does not need for the South Asia regional files it uses."
    ),
    citation=(
        "NASA FIRMS. VIIRS 375m Active Fire product VNP14IMGT, distributed by "
        "NASA LANCE/FIRMS."
    ),
)

FIRMS_MODIS = Dataset(
    id="firms_modis_c61",
    name="MODIS Collection 6.1 Active Fire (Terra, Aqua)",
    provider="NASA FIRMS / LANCE",
    kind=DataKind.OBSERVED,
    source_url="https://firms.modaps.eosdis.nasa.gov/active_fire/",
    licence="NASA open data. Free to use with attribution.",
    update_frequency="Near real time; regional files cover 24h/7d",
    spatial_resolution="1 km nominal at nadir",
    fields=(
        "latitude",
        "longitude",
        "brightness",
        "bright_t31",
        "scan",
        "track",
        "acq_date",
        "acq_time",
        "satellite",
        "confidence",
        "version",
        "frp",
        "daynight",
    ),
    limitations=(
        "1 km resolution is coarser than VIIRS; facility-level attribution is "
        "correspondingly weaker.",
        "Confidence is reported 0-100 here, unlike VIIRS which uses "
        "low/nominal/high. The two are not interchangeable.",
        "Same observation-timing and cloud caveats as VIIRS.",
    ),
    requires_credentials=False,
    citation="NASA FIRMS. MODIS Collection 6.1 Active Fire product MCD14DL.",
)

OSM_INDUSTRIAL = Dataset(
    id="osm_industrial",
    name="OpenStreetMap industrial features",
    provider="OpenStreetMap contributors (via Overpass API)",
    kind=DataKind.OBSERVED,
    source_url="https://www.openstreetmap.org/",
    licence="Open Database License (ODbL) 1.0 — attribution and share-alike required",
    update_frequency="Continuous community editing; this system caches query results",
    spatial_resolution="Vector geometry; accuracy varies by contributor",
    fields=(
        "osm_id",
        "osm_type",
        "name",
        "landuse",
        "man_made",
        "industrial",
        "power",
        "latitude",
        "longitude",
    ),
    limitations=(
        "Coverage is uneven. An unmapped facility looks identical to no facility, "
        "so absence of a nearby feature is weak evidence.",
        "Tagging is inconsistent between regions and contributors.",
        "Centroids are used for distance calculations, so distance to a large "
        "site is measured to its centre rather than its perimeter.",
        "Names are user-contributed and may be outdated, informal or wrong.",
    ),
    requires_credentials=False,
    notes=(
        "Overpass is a donated community service. Queries are cached on disk and "
        "rate-limited; the pipeline must never hammer it."
    ),
    citation="© OpenStreetMap contributors, ODbL.",
)

OSM_LANDCOVER = Dataset(
    id="osm_landcover",
    name="OpenStreetMap land-use / land-cover polygons",
    provider="OpenStreetMap contributors (via Overpass API)",
    kind=DataKind.OBSERVED,
    source_url="https://wiki.openstreetmap.org/wiki/Key:landuse",
    licence="Open Database License (ODbL) 1.0",
    update_frequency="Continuous community editing; cached locally",
    spatial_resolution="Vector polygons; highly variable completeness",
    fields=("osm_id", "landuse", "natural", "latitude", "longitude"),
    limitations=(
        "This is a substitute for a true raster land-cover product, not an "
        "equivalent. It is sparser and less systematic.",
        "Large areas of India have no land-use polygons at all, which yields an "
        "honest 'unknown' rather than a guess.",
        "A proper product such as ESA WorldCover 10 m would be materially "
        "better, but requires registered access. See "
        "docs/adr/0002-data-sources.md.",
    ),
    requires_credentials=False,
)

PERSISTENCE_DERIVED = Dataset(
    id="derived_persistence",
    name="Per-location thermal persistence statistics",
    provider="HeatDetect (this system)",
    kind=DataKind.DERIVED,
    source_url="https://github.com/jaystark16/HeatDetect",
    licence="Same as this repository",
    update_frequency="Recomputed on each ingestion run",
    spatial_resolution="Aggregated to a fixed geographic grid cell",
    fields=(
        "cell_id",
        "observation_count",
        "distinct_days",
        "median_frp",
        "p90_frp",
        "frp_mad",
        "first_seen",
        "last_seen",
    ),
    limitations=(
        "Computed only over the ingested window. With 7 days of archive data a "
        "'baseline' is a short-term baseline, not a long-term normal.",
        "A location with few observations has a statistically weak baseline; the "
        "system reports this rather than implying confidence.",
        "Grid aggregation means two nearby distinct sources can share a cell.",
    ),
    citation=(
        "Method follows the flare/biomass separation principle described by "
        "Elvidge et al. for VIIRS Nightfire — discriminating by temperature and "
        "persistence rather than by brightness alone."
    ),
)

CATALOGUE: dict[str, Dataset] = {
    d.id: d
    for d in (
        FIRMS_VIIRS,
        FIRMS_MODIS,
        OSM_INDUSTRIAL,
        OSM_LANDCOVER,
        PERSISTENCE_DERIVED,
    )
}


def get(dataset_id: str) -> Dataset:
    try:
        return CATALOGUE[dataset_id]
    except KeyError as exc:
        raise KeyError(
            f"Unknown dataset {dataset_id!r}. Every data path must declare "
            f"provenance; add it to the catalogue rather than bypassing this."
        ) from exc
