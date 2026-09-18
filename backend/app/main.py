"""HeatDetect API — SIH26162.

Phase 0 serves seeded sample hotspots so the dashboard and the deployment
pipeline can be proven end to end before FIRMS ingestion exists. Endpoint shapes
follow section 10 of the team planning document, so later phases replace the data
source without the frontend changing.
"""

from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import settings
from .sample_data import sample_hotspots
from .schemas import (
    HealthResponse,
    Hotspot,
    HotspotCollection,
    ThermalClass,
)

app = FastAPI(
    title="HeatDetect API",
    description=(
        "AI-based detection and classification of industrial fires and "
        "persistent thermal sources (SIH26162)."
    ),
    version=__version__,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _data_source() -> str:
    return "sample" if settings.using_sample_data else "firms"


def _load_hotspots() -> list[Hotspot]:
    """Single place where the data source is chosen.

    Phase 1 swaps the sample branch for a database query; nothing else moves.
    """
    return sample_hotspots()


@app.get("/api/health", response_model=HealthResponse, tags=["meta"])
def health() -> HealthResponse:
    """Liveness probe. Also used by the keep-warm cron to defeat cold starts."""
    return HealthResponse(
        status="ok",
        version=__version__,
        data_source=_data_source(),
        database_connected=bool(settings.database_url),
        firms_key_configured=bool(settings.firms_map_key),
    )


@app.get("/api/hotspots", response_model=HotspotCollection, tags=["hotspots"])
def list_hotspots(
    predicted_class: ThermalClass | None = Query(
        default=None, description="Filter to a single predicted class"
    ),
    min_confidence: float = Query(
        default=0.0, ge=0.0, le=1.0, description="Drop predictions below this"
    ),
    within_hours: int | None = Query(
        default=None, gt=0, description="Only detections acquired in this window"
    ),
) -> HotspotCollection:
    """Recent detections with the filters the dashboard's left panel needs."""
    results = _load_hotspots()

    if predicted_class is not None:
        results = [
            h
            for h in results
            if h.classification and h.classification.predicted_class == predicted_class
        ]

    if min_confidence > 0.0:
        results = [
            h
            for h in results
            if h.classification and h.classification.confidence >= min_confidence
        ]

    if within_hours is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=within_hours)
        results = [h for h in results if h.acquired_at >= cutoff]

    results.sort(key=lambda h: h.acquired_at, reverse=True)
    return HotspotCollection(
        count=len(results), hotspots=results, data_source=_data_source()
    )


@app.get("/api/hotspots/{hotspot_id}", response_model=Hotspot, tags=["hotspots"])
def get_hotspot(hotspot_id: str) -> Hotspot:
    """Full detail for the right-hand evidence panel."""
    for hotspot in _load_hotspots():
        if hotspot.id == hotspot_id:
            return hotspot
    raise HTTPException(status_code=404, detail=f"No hotspot with id {hotspot_id!r}")


@app.get("/api/analytics", tags=["analytics"])
def analytics() -> dict:
    """Counts for the bottom status strip (planning doc, section 11)."""
    hotspots = _load_hotspots()

    by_class: dict[str, int] = {c.value: 0 for c in ThermalClass}
    for hotspot in hotspots:
        if hotspot.classification:
            by_class[hotspot.classification.predicted_class.value] += 1

    # An "alert" is an anomaly against an established baseline, not merely a
    # bright pixel. This is the project's central idea, so it drives the count.
    alerts = [
        h
        for h in hotspots
        if h.classification
        and h.classification.predicted_class == ThermalClass.INDUSTRIAL_FIRE
        and h.classification.confidence >= 0.7
    ]

    return {
        "total_hotspots": len(hotspots),
        "by_class": by_class,
        "alerts": len(alerts),
        "data_source": _data_source(),
    }


@app.get("/api/model-info", tags=["meta"])
def model_info() -> dict:
    """Model provenance. Honest about there being no trained model yet."""
    return {
        "model_version": "sample-0.0.0",
        "model_type": None,
        "trained": False,
        "note": (
            "Phase 0: classifications shown are seeded examples, not model "
            "output. A Random Forest / XGBoost classifier lands in Phase 5."
        ),
        "planned_classes": [c.value for c in ThermalClass],
    }
