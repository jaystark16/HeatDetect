"""API response models.

Naming follows the problem statement's caution (SIH26162, section 14): a thermal
anomaly is evidence of unusual heat, never proof of an accident. Class labels and
UI copy stay hedged — "possible", "candidate" — on purpose.
"""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class ThermalClass(str, Enum):
    """The four classes the problem statement asks us to separate."""

    INDUSTRIAL_FIRE = "industrial_fire"
    PERSISTENT_INDUSTRIAL = "persistent_industrial"
    NATURAL_FIRE = "natural_fire"
    UNKNOWN = "unknown"


CLASS_LABELS: dict[ThermalClass, str] = {
    ThermalClass.INDUSTRIAL_FIRE: "Possible industrial fire",
    ThermalClass.PERSISTENT_INDUSTRIAL: "Persistent industrial thermal source",
    ThermalClass.NATURAL_FIRE: "Probable vegetation fire",
    ThermalClass.UNKNOWN: "Unclassified anomaly",
}


class LandCover(str, Enum):
    INDUSTRIAL = "industrial"
    URBAN = "urban"
    FOREST = "forest"
    CROPLAND = "cropland"
    SHRUBLAND = "shrubland"
    BARREN = "barren"
    WATER = "water"
    UNKNOWN = "unknown"


class HotspotContext(BaseModel):
    """Geographic and temporal evidence attached to a detection.

    Populated by the enrichment pipeline (Phases 3-5). These fields are the
    model's most important inputs — particularly the persistence ones, which are
    what separate a routine gas flare from an actual incident.
    """

    nearest_facility_name: str | None = None
    nearest_facility_type: str | None = Field(
        default=None, description="oil, steel, power, mining, LNG, ..."
        )
    distance_to_facility_m: float | None = Field(
        default=None, description="Metres to the nearest mapped industrial feature"
    )
    land_cover: LandCover = LandCover.UNKNOWN

    detections_30d: int = Field(
        default=0, description="Detections within ~1km of here in the last 30 days"
    )
    baseline_frp_mw: float | None = Field(
        default=None,
        description="This location's historical median FRP. A stable baseline "
        "implies routine industrial heat rather than an incident.",
    )
    frp_ratio: float | None = Field(
        default=None,
        description="Observed FRP / baseline FRP. Large values are the signal "
        "for an anomalous event at an otherwise routine thermal source.",
    )


class Classification(BaseModel):
    predicted_class: ThermalClass
    label: str = Field(description="Human-readable, deliberately hedged")
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: list[str] = Field(
        default_factory=list,
        description="Plain-language reasons behind the prediction, for the UI panel",
    )
    model_version: str = "sample-0.0.0"


class Hotspot(BaseModel):
    """A single thermal anomaly observation, enriched and classified."""

    id: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    acquired_at: datetime

    # --- Source fields, as they arrive from FIRMS ---
    satellite: str
    instrument: str = Field(description="VIIRS or MODIS")
    frp_mw: float = Field(description="Fire Radiative Power, megawatts")
    brightness_k: float = Field(description="Brightness temperature, kelvin")
    source_confidence: str = Field(description="FIRMS confidence: low/nominal/high")
    day_night: str = Field(description="D or N")

    # --- Ours ---
    context: HotspotContext = Field(default_factory=HotspotContext)
    classification: Classification | None = None


class HotspotCollection(BaseModel):
    count: int
    hotspots: list[Hotspot]
    data_source: str = Field(
        description="'sample' or 'firms' — surfaced in the UI so a demo is never "
        "mistaken for live data"
    )


class HealthResponse(BaseModel):
    status: str
    version: str
    data_source: str
    database_connected: bool
    firms_key_configured: bool
