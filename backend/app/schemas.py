"""API response models.

The structure enforces the project's central discipline: **observed measurement,
our derived statistics, and our classification are separate objects**. A client
cannot accidentally render an inference as a measurement, because they do not
share a namespace.

Naming stays hedged throughout ("possible", "consistent with"). A thermal
anomaly is evidence of unusual heat, never proof of an accident.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class ThermalClass(str, Enum):
    INDUSTRIAL_FIRE = "industrial_fire"
    PERSISTENT_INDUSTRIAL = "persistent_industrial"
    NATURAL_FIRE = "natural_fire"
    UNKNOWN = "unknown"


DISPLAY_LABELS: dict[str, str] = {
    "industrial_fire": "Possible industrial fire",
    "persistent_industrial": "Persistent industrial thermal source",
    "natural_fire": "Probable vegetation fire",
    "unknown": "Not classified",
}


# ------------------------------------------------------------- observation --


class Observation(BaseModel):
    """Exactly what the satellite product reported. Never modified by analysis."""

    instrument: str
    satellite: str
    brightness_k: float = Field(description="~4 um channel brightness temperature")
    brightness_long_k: float = Field(description="~11 um channel brightness temperature")
    dual_band_delta_k: float = Field(
        description="brightness_k - brightness_long_k; larger implies a smaller, hotter source"
    )
    frp_mw: float = Field(description="Fire radiative power, megawatts")
    confidence_raw: str = Field(
        description="As published: low/nominal/high for VIIRS, 0-100 for MODIS"
    )
    confidence_tier: str = Field(
        description="Normalised to low/nominal/high. MODIS binning is our convention."
    )
    day_night: Literal["D", "N"]
    scan: float
    track: float
    dataset_id: str


# --------------------------------------------------------------- derived --


class Persistence(BaseModel):
    """Statistics computed by this system over the ingested window."""

    observation_count: int
    distinct_days: int
    window_days: int
    median_frp_mw: float
    p90_frp_mw: float
    mad_frp_mw: float
    median_dual_band_k: float
    night_fraction: float
    first_seen: datetime
    last_seen: datetime

    baseline_usable: bool = Field(
        description="False when there are too few observations for a meaningful baseline"
    )
    deviation_ratio: float | None = Field(
        default=None,
        description=(
            "p90 FRP divided by median FRP. Null when the baseline is unusable — "
            "a ratio over two points would be noise presented as insight."
        ),
    )


class SpatialContext(BaseModel):
    nearest_facility_name: str | None = None
    nearest_facility_category: str | None = None
    distance_to_facility_m: float | None = None
    facilities_within_5km: int = 0
    land_cover: str = "unknown"
    coverage: Literal["surveyed", "not_surveyed"] = Field(
        description=(
            "'not_surveyed' means we have not queried industrial data here. It is "
            "a gap in coverage, NOT evidence that no industry is nearby."
        )
    )


# -------------------------------------------------------- classification --


class EvidenceItem(BaseModel):
    statement: str
    kind: Literal["observed", "derived", "absent"] = Field(
        description="'absent' records something we could not establish"
    )
    values: dict = Field(default_factory=dict)
    dataset_id: str | None = None


class Classification(BaseModel):
    label: ThermalClass
    display_label: str
    source: Literal["rule", "model"] = Field(
        description=(
            "'rule' when multi-day history was available and deterministic criteria "
            "decided it; 'model' when only a single observation was available."
        )
    )
    rule_version: str | None = None
    model_version: str | None = None
    confidence: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Model probability. Null for rule-based decisions — a deterministic "
            "threshold has no probability, and inventing one would be dishonest."
        ),
    )
    abstained: bool = Field(
        description="True when the system declined to classify on insufficient evidence"
    )
    criteria: list[dict] = Field(
        default_factory=list, description="Which criteria were evaluated, and their outcome"
    )


# ------------------------------------------------------------- responses --


class HotspotSummary(BaseModel):
    """Lean shape for map rendering. Detail is fetched per selection."""

    id: str
    latitude: float
    longitude: float
    cell_id: str
    acquired_at: datetime
    frp_mw: float
    confidence_tier: str
    label: ThermalClass
    distinct_days: int


class HotspotDetail(BaseModel):
    id: str
    latitude: float
    longitude: float
    cell_id: str
    acquired_at: datetime
    observation: Observation
    persistence: Persistence | None
    context: SpatialContext
    classification: Classification
    evidence: list[EvidenceItem]
    caution: str


class Provenance(BaseModel):
    """Attached to every collection response.

    `is_live` is deliberately conservative: it is only true when the newest
    detection is recent. Cached or historical data is never described as live.
    """

    data_source: Literal["firms_open_archive", "none"]
    generated_at: datetime
    newest_detection_at: datetime | None
    oldest_detection_at: datetime | None
    age_of_newest_hours: float | None
    is_live: bool
    stale: bool
    surveyed_cells: int
    unsurveyed_cells: int
    coverage_note: str


class HotspotCollection(BaseModel):
    count: int = Field(description="Rows returned in this page")
    total_matching: int = Field(description="Rows matching the filters, before paging")
    limit: int
    offset: int
    hotspots: list[HotspotSummary]
    provenance: Provenance


class ClassCount(BaseModel):
    label: ThermalClass
    display_label: str
    cells: int
    detections: int


class Analytics(BaseModel):
    total_detections: int
    total_cells: int
    by_class: list[ClassCount]
    flagged_for_investigation: int
    persistent_cells: int
    provenance: Provenance


class SearchMatch(BaseModel):
    """One place the user can navigate to.

    `kind` says what was matched so the UI can label it rather than presenting
    a coordinate parse and a facility-name match as the same kind of answer.
    """

    kind: Literal["coordinates", "facility", "detection"]
    label: str
    detail: str | None = None
    latitude: float
    longitude: float


class SearchResponse(BaseModel):
    query: str
    count: int
    matches: list[SearchMatch]
    note: str | None = Field(
        default=None,
        description="Set when nothing matched, explaining what is searchable",
    )


class DatasetInfo(BaseModel):
    id: str
    name: str
    provider: str
    kind: Literal["observed", "derived", "synthetic"]
    source_url: str
    licence: str
    update_frequency: str
    spatial_resolution: str | None
    fields: list[str]
    limitations: list[str]
    requires_credentials: bool
    notes: str | None
    citation: str | None


class ModelInfo(BaseModel):
    trained: bool
    model_version: str | None
    model_type: str | None
    label_rule_version: str
    trained_at: datetime | None
    feature_names: list[str]
    metrics: dict | None
    caveat: str


class IngestRunInfo(BaseModel):
    run_id: int
    source: str
    detail: str | None
    status: str
    started_at: datetime
    finished_at: datetime | None
    rows_seen: int
    rows_accepted: int
    rows_rejected: int
    rows_inserted: int
    reject_reasons: dict | None
    error: str | None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    database_connected: bool
    detections_stored: int
    cells_with_labels: int
    osm_tiles_cached: int
    model_trained: bool
    newest_detection_at: datetime | None
    notes: list[str]
