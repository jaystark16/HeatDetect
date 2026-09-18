"""Seeded sample hotspots for Phase 0 and for offline demo fallback.

These are real industrial and forest locations in India with plausible — but
*synthetic* — thermal readings. They exist so the dashboard has something
meaningful to render before FIRMS ingestion lands, and so a live demo survives a
dead venue network.

Every response built from this module reports `data_source="sample"` so sample
data can never be passed off as live satellite observations.
"""

from datetime import datetime, timedelta, timezone

from .schemas import (
    CLASS_LABELS,
    Classification,
    Hotspot,
    HotspotContext,
    LandCover,
    ThermalClass,
)


def _ago(hours: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=hours)


def _classify(
    predicted: ThermalClass, confidence: float, evidence: list[str]
) -> Classification:
    return Classification(
        predicted_class=predicted,
        label=CLASS_LABELS[predicted],
        confidence=confidence,
        evidence=evidence,
    )


def sample_hotspots() -> list[Hotspot]:
    """A deliberately contrastive set: routine flares, one anomaly, two wildfires.

    The contrast is the point. It lets a demo show the classifier separating
    "this refinery is behaving normally" from "this refinery is not", which is
    the actual deliverable of SIH26162.
    """
    return [
        # --- Persistent industrial sources: routine flaring, stable baseline ---
        Hotspot(
            id="smp-jamnagar-001",
            latitude=22.3450,
            longitude=69.8597,
            acquired_at=_ago(3.5),
            satellite="N21",
            instrument="VIIRS",
            frp_mw=18.4,
            brightness_k=331.2,
            source_confidence="nominal",
            day_night="N",
            context=HotspotContext(
                nearest_facility_name="Jamnagar Refinery Complex",
                nearest_facility_type="oil",
                distance_to_facility_m=290.0,
                land_cover=LandCover.INDUSTRIAL,
                detections_30d=27,
                baseline_frp_mw=17.9,
                frp_ratio=1.03,
            ),
            classification=_classify(
                ThermalClass.PERSISTENT_INDUSTRIAL,
                0.94,
                [
                    "27 detections in the last 30 days — continuous, not episodic",
                    "Observed FRP is 1.03x this location's historical median",
                    "290 m from a mapped oil refinery; land cover is industrial",
                    "Behaviour consistent with routine flaring, not an incident",
                ],
            ),
        ),
        Hotspot(
            id="smp-vadinar-002",
            latitude=22.4201,
            longitude=69.7003,
            acquired_at=_ago(3.5),
            satellite="N21",
            instrument="VIIRS",
            frp_mw=11.7,
            brightness_k=325.8,
            source_confidence="nominal",
            day_night="N",
            context=HotspotContext(
                nearest_facility_name="Vadinar Refinery",
                nearest_facility_type="oil",
                distance_to_facility_m=410.0,
                land_cover=LandCover.INDUSTRIAL,
                detections_30d=24,
                baseline_frp_mw=12.1,
                frp_ratio=0.97,
            ),
            classification=_classify(
                ThermalClass.PERSISTENT_INDUSTRIAL,
                0.92,
                [
                    "24 detections in the last 30 days at a stable intensity",
                    "Observed FRP is 0.97x baseline — no deviation",
                    "410 m from a mapped oil refinery",
                ],
            ),
        ),
        Hotspot(
            id="smp-talcher-003",
            latitude=20.9410,
            longitude=85.1520,
            acquired_at=_ago(14.0),
            satellite="Terra",
            instrument="MODIS",
            frp_mw=26.3,
            brightness_k=338.5,
            source_confidence="high",
            day_night="D",
            context=HotspotContext(
                nearest_facility_name="Talcher Thermal Power Station area",
                nearest_facility_type="power",
                distance_to_facility_m=760.0,
                land_cover=LandCover.INDUSTRIAL,
                detections_30d=19,
                baseline_frp_mw=24.8,
                frp_ratio=1.06,
            ),
            classification=_classify(
                ThermalClass.PERSISTENT_INDUSTRIAL,
                0.88,
                [
                    "19 detections in 30 days — recurring thermal source",
                    "Within 1 km of a thermal power and coal-handling area",
                    "Intensity within 6% of baseline",
                ],
            ),
        ),
        Hotspot(
            id="smp-bhilai-004",
            latitude=21.2003,
            longitude=81.3799,
            acquired_at=_ago(27.0),
            satellite="N20",
            instrument="VIIRS",
            frp_mw=31.9,
            brightness_k=344.1,
            source_confidence="nominal",
            day_night="N",
            context=HotspotContext(
                nearest_facility_name="Bhilai Steel Plant",
                nearest_facility_type="steel",
                distance_to_facility_m=180.0,
                land_cover=LandCover.INDUSTRIAL,
                detections_30d=22,
                baseline_frp_mw=29.4,
                frp_ratio=1.09,
            ),
            classification=_classify(
                ThermalClass.PERSISTENT_INDUSTRIAL,
                0.90,
                [
                    "22 detections in 30 days at a steel plant",
                    "Blast-furnace process heat produces a stable signature",
                    "180 m from mapped industrial infrastructure",
                ],
            ),
        ),
        # --- The interesting one: an anomaly against a known baseline ---
        Hotspot(
            id="smp-paradip-005",
            latitude=20.2702,
            longitude=86.6104,
            acquired_at=_ago(1.2),
            satellite="N21",
            instrument="VIIRS",
            frp_mw=142.6,
            brightness_k=367.4,
            source_confidence="high",
            day_night="D",
            context=HotspotContext(
                nearest_facility_name="Paradip Refinery",
                nearest_facility_type="oil",
                distance_to_facility_m=320.0,
                land_cover=LandCover.INDUSTRIAL,
                detections_30d=21,
                baseline_frp_mw=15.8,
                frp_ratio=9.03,
            ),
            classification=_classify(
                ThermalClass.INDUSTRIAL_FIRE,
                0.87,
                [
                    "Observed FRP is 9.0x this location's historical median — "
                    "a sharp deviation from routine behaviour",
                    "Brightness temperature 367 K, well above the site's flaring range",
                    "320 m from a mapped oil refinery; land cover is industrial",
                    "Site has an established baseline, so this is anomalous "
                    "rather than newly appearing",
                    "Recommend investigation — satellite evidence alone does not "
                    "confirm an incident",
                ],
            ),
        ),
        # --- Natural / vegetation fires: no industrial context, short-lived ---
        Hotspot(
            id="smp-similipal-006",
            latitude=21.9012,
            longitude=86.3504,
            acquired_at=_ago(8.0),
            satellite="N20",
            instrument="VIIRS",
            frp_mw=47.2,
            brightness_k=352.0,
            source_confidence="high",
            day_night="D",
            context=HotspotContext(
                nearest_facility_name=None,
                nearest_facility_type=None,
                distance_to_facility_m=38400.0,
                land_cover=LandCover.FOREST,
                detections_30d=2,
                baseline_frp_mw=None,
                frp_ratio=None,
            ),
            classification=_classify(
                ThermalClass.NATURAL_FIRE,
                0.91,
                [
                    "Land cover is forest; no industrial baseline at this location",
                    "Nearest mapped industrial feature is 38 km away",
                    "Only 2 detections in 30 days — episodic, not persistent",
                    "Daytime detection during the regional dry season",
                ],
            ),
        ),
        Hotspot(
            id="smp-bandipur-007",
            latitude=11.7004,
            longitude=76.6011,
            acquired_at=_ago(20.0),
            satellite="Aqua",
            instrument="MODIS",
            frp_mw=63.8,
            brightness_k=358.6,
            source_confidence="nominal",
            day_night="D",
            context=HotspotContext(
                nearest_facility_name=None,
                nearest_facility_type=None,
                distance_to_facility_m=51200.0,
                land_cover=LandCover.FOREST,
                detections_30d=1,
                baseline_frp_mw=None,
                frp_ratio=None,
            ),
            classification=_classify(
                ThermalClass.NATURAL_FIRE,
                0.89,
                [
                    "Single detection in 30 days — no recurrence",
                    "Forest land cover, 51 km from any industrial feature",
                    "No historical thermal baseline at this location",
                ],
            ),
        ),
        # --- Genuinely ambiguous: the honest 'unknown' case ---
        Hotspot(
            id="smp-vizag-008",
            latitude=17.6512,
            longitude=83.2019,
            acquired_at=_ago(5.0),
            satellite="N21",
            instrument="VIIRS",
            frp_mw=9.1,
            brightness_k=322.4,
            source_confidence="low",
            day_night="N",
            context=HotspotContext(
                nearest_facility_name="Visakhapatnam industrial belt",
                nearest_facility_type="steel",
                distance_to_facility_m=2140.0,
                land_cover=LandCover.URBAN,
                detections_30d=4,
                baseline_frp_mw=8.4,
                frp_ratio=1.08,
            ),
            classification=_classify(
                ThermalClass.UNKNOWN,
                0.41,
                [
                    "Low source confidence from FIRMS",
                    "2.1 km from industrial infrastructure — too far for confident "
                    "facility-level attribution at 375 m resolution",
                    "Only 4 detections in 30 days: neither clearly persistent "
                    "nor clearly episodic",
                    "Insufficient evidence to classify; flagged for review",
                ],
            ),
        ),
    ]
