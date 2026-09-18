"""HeatDetect API — SIH26162.

Routing and request validation only; data access and the classification
authority rules live in `service.py`.

Observability: every request gets an id, and the log line records path, status
and duration. `/api/runs` exposes the ingestion audit trail, so "where did this
number come from" is answerable without shell access to the server.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from . import model as ml
from . import service
from .config import LABEL_RULE_VERSION, settings
from .db import build_engine, init_schema
from .ingest.osm import cached_tile_keys
from .schemas import (
    Analytics,
    DatasetInfo,
    HealthResponse,
    HotspotCollection,
    HotspotDetail,
    IngestRunInfo,
    ModelInfo,
    SearchResponse,
    ThermalClass,
)
from .service import HotspotFilters

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("api")


class State:
    """Process-wide handles, built once at startup."""

    engine = None
    model: ml.TrainedModel | None = None


state = State()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    state.engine = build_engine()
    init_schema(state.engine)
    state.model = ml.load()

    if state.model is None:
        # Not an error. An untrained system is a legitimate state and the API
        # reports it rather than implying a model exists.
        logger.warning(
            "no trained model found; classification will rely on rules only"
        )
    else:
        logger.info(
            "loaded model %s (feature set %s)",
            state.model.model_version,
            state.model.feature_set,
        )
    logger.info(
        "detections=%d labelled_cells=%d osm_tiles=%d",
        service.count_detections(state.engine),
        service.count_labels(state.engine),
        len(cached_tile_keys()),
    )
    yield


app = FastAPI(
    title="HeatDetect API",
    version=__version__,
    lifespan=lifespan,
    description=(
        "Classification and monitoring of industrial fires and persistent thermal "
        "sources from NASA FIRMS active-fire detections (SIH26162).\n\n"
        "Every collection response carries a `provenance` block. Observed "
        "measurements, derived statistics and classifications are separate "
        "objects and must not be conflated."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.middleware("http")
async def observability(request: Request, call_next):
    """Request id and timing, so a user-visible number can be traced to a call."""
    request_id = uuid.uuid4().hex[:12]
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        duration_ms = (time.perf_counter() - started) * 1000
        logger.exception(
            "request id=%s %s %s -> unhandled error in %.0fms",
            request_id,
            request.method,
            request.url.path,
            duration_ms,
        )
        # Deliberately generic: internal exception text can leak schema and
        # filesystem details. The request id ties this to the server log.
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Internal error. Quote this request id when reporting it.",
                "request_id": request_id,
            },
            headers={"X-Request-ID": request_id},
        )

    duration_ms = (time.perf_counter() - started) * 1000
    logger.info(
        "request id=%s %s %s -> %d in %.0fms",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    response.headers["X-Request-ID"] = request_id
    return response


def _engine():
    if state.engine is None:  # pragma: no cover - lifespan always runs first
        raise HTTPException(status_code=503, detail="Database not initialised")
    return state.engine


# ------------------------------------------------------------------ meta --


@app.get("/api/health", response_model=HealthResponse, tags=["meta"])
def health() -> HealthResponse:
    """Liveness and readiness, reported from actual database state."""
    engine = _engine()
    detections_stored = service.count_detections(engine)
    labelled = service.count_labels(engine)
    tiles = len(cached_tile_keys())

    notes: list[str] = []
    if detections_stored == 0:
        notes.append("No detections ingested. Run `python -m app.pipeline ingest`.")
    if labelled == 0 and detections_stored:
        notes.append("Detections present but no labels. Run `app.pipeline features`.")
    if state.model is None:
        notes.append("No trained model; classification uses deterministic rules only.")
    if tiles == 0:
        notes.append(
            "No OSM tiles cached, so no cell has surveyed industrial context."
        )

    with engine.connect() as conn:
        provenance = service.get_provenance(conn)

    if provenance.stale and detections_stored:
        notes.append(
            f"Newest detection is {provenance.age_of_newest_hours} hours old; "
            f"data is historical, not live."
        )

    return HealthResponse(
        status="ok" if detections_stored and labelled else "degraded",
        version=__version__,
        database_connected=True,
        detections_stored=detections_stored,
        cells_with_labels=labelled,
        osm_tiles_cached=tiles,
        model_trained=state.model is not None,
        newest_detection_at=provenance.newest_detection_at,
        notes=notes,
    )


@app.get("/api/datasets", response_model=list[DatasetInfo], tags=["meta"])
def datasets() -> list[DatasetInfo]:
    """Provenance catalogue: source, licence and stated limitations per dataset."""
    return service.get_datasets()


@app.get("/api/model-info", response_model=ModelInfo, tags=["meta"])
def model_info() -> ModelInfo:
    return service.get_model_info(state.model)


@app.get("/api/runs", response_model=list[IngestRunInfo], tags=["meta"])
def runs(
    limit: Annotated[int, Query(ge=1, le=200)] = 25,
) -> list[IngestRunInfo]:
    """Ingestion audit trail: what was fetched, when, and what was rejected."""
    return service.get_recent_runs(_engine(), limit)


# -------------------------------------------------------------- hotspots --


@app.get("/api/hotspots", response_model=HotspotCollection, tags=["hotspots"])
def list_hotspots(
    label: ThermalClass | None = None,
    min_frp_mw: Annotated[float | None, Query(ge=0)] = None,
    within_hours: Annotated[int | None, Query(ge=1, le=24 * 30)] = None,
    min_distinct_days: Annotated[int | None, Query(ge=1, le=31)] = None,
    confidence_tier: Annotated[str | None, Query(pattern="^(low|nominal|high)$")] = None,
    bbox: Annotated[
        str | None,
        Query(description="min_lon,min_lat,max_lon,max_lat"),
    ] = None,
    # Capped at 5000: the map degrades badly past a few thousand marks, and an
    # unbounded limit is a trivial way to exhaust server memory.
    limit: Annotated[int, Query(ge=1, le=5000)] = 1000,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> HotspotCollection:
    parsed_bbox = None
    if bbox:
        try:
            parts = [float(p) for p in bbox.split(",")]
        except ValueError:
            raise HTTPException(
                status_code=422, detail="bbox values must be numbers"
            ) from None
        if len(parts) != 4:
            raise HTTPException(
                status_code=422,
                detail="bbox must have four values: min_lon,min_lat,max_lon,max_lat",
            )
        min_lon, min_lat, max_lon, max_lat = parts
        if min_lon >= max_lon or min_lat >= max_lat:
            raise HTTPException(
                status_code=422, detail="bbox minimums must be below maximums"
            )
        parsed_bbox = (min_lon, min_lat, max_lon, max_lat)

    return service.list_hotspots(
        _engine(),
        HotspotFilters(
            label=label.value if label else None,
            min_frp_mw=min_frp_mw,
            within_hours=within_hours,
            min_distinct_days=min_distinct_days,
            confidence_tier=confidence_tier,
            bbox=parsed_bbox,
            limit=limit,
            offset=offset,
        ),
    )


@app.get(
    "/api/hotspots/{detection_id}", response_model=HotspotDetail, tags=["hotspots"]
)
def hotspot_detail(detection_id: str) -> HotspotDetail:
    detail = service.get_hotspot_detail(_engine(), detection_id, state.model)
    if detail is None:
        raise HTTPException(
            status_code=404, detail=f"No detection with id {detection_id!r}"
        )
    return detail


@app.get("/api/search", response_model=SearchResponse, tags=["hotspots"])
def search(
    q: Annotated[str, Query(min_length=1, max_length=120, description="Coordinates or a facility name")],
    limit: Annotated[int, Query(ge=1, le=25)] = 10,
) -> SearchResponse:
    """Resolve free text to map locations.

    Returns an empty result with an explanatory `note` rather than a guess when
    nothing matches — a near-miss presented confidently is worse than nothing.
    """
    return service.search(_engine(), q, limit)


@app.get("/api/analytics", response_model=Analytics, tags=["analytics"])
def analytics() -> Analytics:
    return service.get_analytics(_engine())


@app.get("/api/rules", tags=["meta"])
def rules() -> dict:
    """The classification thresholds, exposed so the logic is inspectable."""
    from . import labels as lbl

    return {
        "rule_version": LABEL_RULE_VERSION,
        "thresholds": {
            "persistent_min_distinct_days": lbl.PERSISTENT_MIN_DISTINCT_DAYS,
            "industrial_proximity_m": lbl.INDUSTRIAL_PROXIMITY_M,
            "non_industrial_distance_m": lbl.NON_INDUSTRIAL_DISTANCE_M,
            "episodic_max_distinct_days": lbl.EPISODIC_MAX_DISTINCT_DAYS,
            "excursion_ratio": lbl.EXCURSION_RATIO,
            "excursion_absolute_floor_mw": lbl.EXCURSION_ABSOLUTE_FLOOR_MW,
            "min_observations_for_baseline": settings.min_observations_for_baseline,
            "model_abstain_below": ml.ABSTAIN_BELOW,
        },
        "authority": (
            "Deterministic rules decide any location with sufficient history and "
            "carry no probability. The model is consulted only where the rules "
            "abstain. Any class whose measured held-out precision falls below "
            f"{ml.MIN_PRECISION_TO_REPORT} is suppressed rather than reported."
        ),
        "suppressed_model_classes": (
            state.model.unreliable_classes() if state.model else {}
        ),
    }
